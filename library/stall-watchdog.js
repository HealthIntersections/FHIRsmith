'use strict';

/**
 * Notices when this process's event loop has been blocked for a long time, and records
 * what it is running.
 *
 * A request that runs synchronous code for minutes (2026-11-11 on tx.fhir.org: one
 * $validate-code held worker tx2 for 321 seconds and 17 GB) can't be seen from the
 * main thread - nothing there runs until it ends, not the memory guard, the operation
 * time limit or the logger. So a worker thread watches a heartbeat the main thread
 * writes every second. When the heartbeat is older than the threshold, the worker
 * attaches to the main thread through the inspector and pauses it just long enough to
 * read its stack (inspector messages are V8 interrupts, so they get through a busy
 * loop; a long garbage collection holds them until it ends). It does that again each
 * threshold while the stall lasts, up to MAX_SAMPLES, so the stacks show whether it is
 * stuck in one place or moving through a long loop.
 *
 * What it finds goes to a file in the log folder straight away (the main thread may
 * never recover: the process can run out of memory), and into the log as a warning once
 * the main thread is running again.
 */

const { Worker } = require('worker_threads');

const MAX_SAMPLES = 5;
const MAX_FRAMES = 40;
// How long a sample may take before it is given up: attaching reports every script loaded first,
// which on a busy machine takes seconds (a CI run gave up at 1 s, when this was the threshold)
const SAMPLE_TIMEOUT_MS = 15000;

// the watcher, run as a worker thread (eval: it has to be a string)
const WATCHER = `
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const inspector = require('inspector');

const beat = new BigInt64Array(workerData.buffer);
const { thresholdMs, dir, label, maxSamples, maxFrames, sampleTimeoutMs } = workerData;

let stall = null; // { since, samples, file }
let busy = false;

function sample(done) {
  const session = new inspector.Session();
  let finished = false;
  const finish = (frames, error) => {
    if (finished) return;
    finished = true;
    session.post('Debugger.disable', () => {
      try { session.disconnect(); } catch (e) { /* already gone */ }
      done(frames, error);
    });
  };
  try {
    session.connectToMainThread();
  } catch (e) {
    done(null, e.message);
    return;
  }
  // the call frames name their script by id: the scripts are listed as the debugger is enabled
  const scripts = new Map();
  session.on('Debugger.scriptParsed', (m) => scripts.set(m.params.scriptId, m.params.url));
  session.on('Debugger.paused', (m) => {
    const frames = m.params.callFrames.slice(0, maxFrames).map(f =>
      (f.functionName || '(anonymous)') + ' (' + (scripts.get(f.location.scriptId) || f.url || '?').replace(/^file:\\/\\//, '') +
      ':' + (f.location.lineNumber + 1) + ':' + (f.location.columnNumber + 1) + ')');
    session.post('Debugger.resume', () => finish(frames, null));
  });
  session.post('Debugger.enable', (err) => {
    if (err) { finish(null, err.message); return; }
    session.post('Debugger.pause', (err2) => { if (err2) finish(null, err2.message); });
  });
  // a pause that never lands (a garbage collection that doesn't end): give up on this one
  setTimeout(() => finish(null, 'no answer from the main thread'), sampleTimeoutMs);
}

function write(text) {
  try {
    fs.appendFileSync(stall.file, text);
  } catch (e) {
    fs.writeSync(2, 'stall watchdog: unable to write ' + stall.file + ': ' + e.message + '\\n');
  }
}

setInterval(() => {
  if (busy) return;
  const now = Date.now();
  const last = Number(Atomics.load(beat, 0));
  const blocked = now - last;
  if (blocked < thresholdMs) {
    if (stall) {
      write('\\n' + new Date(now).toISOString() + ' the event loop is running again, ' + Math.round(blocked / 1000) + 's after the heartbeat\\n');
      parentPort.postMessage({ since: stall.since, until: now, samples: stall.samples, file: stall.file });
      stall = null;
    }
    return;
  }
  if (!stall) {
    const stamp = new Date(last).toISOString().replace(/[:.]/g, '-');
    stall = { since: last, samples: [], file: path.join(dir, 'stall-' + label + '-' + stamp + '.txt'), next: now };
    write('The event loop of process ' + process.pid + ' (' + label + ') has not run since ' + new Date(last).toISOString() + '\\n');
  }
  if (stall.samples.length >= maxSamples || now < stall.next) return;
  busy = true;
  sample((frames, error) => {
    busy = false;
    const at = Date.now();
    stall.next = at + thresholdMs;
    const s = { at, blockedMs: at - Number(Atomics.load(beat, 0)), frames, error };
    stall.samples.push(s);
    write('\\n' + new Date(at).toISOString() + ' blocked ' + Math.round(s.blockedMs / 1000) + 's' +
      (frames ? ':\\n  at ' + frames.join('\\n  at ') : ': no stack (' + error + ')') + '\\n');
  });
}, 1000);
`;

/**
 * Start watching this process's event loop.
 *
 * @param {Object} options
 * @param {number} options.thresholdSeconds - how long the loop may go without running before it is reported; 0: don't watch
 * @param {string} options.dir - where the stall files go (the log folder)
 * @param {string} options.label - names this process in the file name (the instance code, or the pid)
 * @param {Object} options.log - where the stall is reported once the loop runs again
 * @returns {{stop: function}|null}
 */
function startStallWatchdog({ thresholdSeconds, dir, label, log }) {
  if (!(thresholdSeconds > 0)) {
    return null;
  }
  const thresholdMs = Math.round(thresholdSeconds * 1000);
  const buffer = new SharedArrayBuffer(8);
  const beat = new BigInt64Array(buffer);
  const tick = () => Atomics.store(beat, 0, BigInt(Date.now()));
  tick();
  const timer = setInterval(tick, 1000);
  timer.unref();

  const worker = new Worker(WATCHER, {
    eval: true,
    workerData: { buffer, thresholdMs, dir, label: String(label).replace(/[^A-Za-z0-9_-]/g, '_'), maxSamples: MAX_SAMPLES, maxFrames: MAX_FRAMES, sampleTimeoutMs: SAMPLE_TIMEOUT_MS }
  });
  worker.unref();
  worker.on('message', (m) => {
    const secs = Math.round((m.until - m.since) / 1000);
    const top = m.samples.filter(s => s.frames).map(s => '  ' + Math.round(s.blockedMs / 1000) + 's: ' + s.frames.slice(0, 6).join(' < '));
    log.warn(`The event loop was blocked for about ${secs}s (from ${new Date(m.since).toISOString()}). ` +
      `${m.samples.length} stack sample(s) in ${m.file}` + (top.length ? '\n' + top.join('\n') : ''));
  });
  worker.on('error', (e) => log.error(`The event loop watchdog failed: ${e.message}`));

  return {
    stop() {
      clearInterval(timer);
      return worker.terminate();
    }
  };
}

module.exports = { startStallWatchdog };
