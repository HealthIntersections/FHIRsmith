'use strict';
/**
 * Parse XML with fast-xml-parser in a worker thread, so a big document doesn't hold the event
 * loop: fast-xml-parser is synchronous, and the hl7.org package feed held npm.fhir.org's loop
 * for 2-3 seconds every time the crawler read it (stall 2026-11-17T22:02, in fetchXml).
 *
 * A document under INLINE_BYTES is parsed here, as before: starting a worker costs more than
 * that takes. What comes back from the worker is copied into this thread (structured clone),
 * which is much cheaper than the parse.
 */
const { Worker } = require('worker_threads');
const { XMLParser } = require('fast-xml-parser');

// smaller documents are parsed on the calling thread
const INLINE_BYTES = 256 * 1024;

// the worker: parse workerData.text with workerData.options, post the result (or the error)
const WORKER = `
const { parentPort, workerData } = require('worker_threads');
const { XMLParser } = require(workerData.parserPath);
try {
  parentPort.postMessage({ result: new XMLParser(workerData.options).parse(workerData.text) });
} catch (e) {
  parentPort.postMessage({ error: e.message });
}
`;

/**
 * @param {string|Buffer} text - the XML
 * @param {Object} options - XMLParser options (plain data: they are copied to the worker)
 * @param {Object} [settings]
 * @param {number} [settings.inlineBytes] - parse on this thread below this size
 * @returns {Promise<Object>} what XMLParser.parse returns
 */
function parseXmlOffThread(text, options, { inlineBytes = INLINE_BYTES } = {}) {
  const s = Buffer.isBuffer(text) ? text.toString('utf8') : String(text ?? '');
  if (s.length < inlineBytes) {
    return Promise.resolve().then(() => new XMLParser(options).parse(s));
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER, {
      eval: true,
      workerData: { text: s, options, parserPath: require.resolve('fast-xml-parser') }
    });
    let settled = false;
    const settle = (fn, value) => {
      if (!settled) {
        settled = true;
        fn(value);
      }
    };
    worker.once('message', m => {
      if (m && m.error !== undefined) {
        settle(reject, new Error(m.error));
      } else {
        settle(resolve, m ? m.result : undefined);
      }
    });
    worker.once('error', e => settle(reject, e));
    worker.once('exit', code => settle(reject, new Error(`the XML parser worker stopped (${code}) without an answer`)));
  });
}

module.exports = { parseXmlOffThread, INLINE_BYTES };
