'use strict';

// The stall watchdog's watcher (library/stall-watchdog.js), run as a worker thread: it watches
// the heartbeat the main thread writes, and when that stops, samples the main thread's stack
// through the inspector and records what /proc says.
//
// A file of its own, not source put together from functions' toString(): under jest --coverage
// those carry the coverage counters, which don't exist in the worker, so it failed on its
// first readProcState and recorded nothing (the CI run).

const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const inspector = require('inspector');
const { readProcState, describeProcState } = require('./proc-state');

const MAX_PROC_LINES = 60;

const beat = new BigInt64Array(workerData.buffer);
const { thresholdMs, dir, label, maxSamples, sampleTimeoutMs, stackExpression } = workerData;

let stall = null; // { since, samples, file }
let busy = false;

function sample(done) {
  const session = new inspector.Session();
  let finished = false;
  const finish = (frames, error) => {
    if (finished) return;
    finished = true;
    try { session.disconnect(); } catch (e) { /* already gone */ }
    done(frames, error);
  };
  try {
    session.connectToMainThread();
  } catch (e) {
    done(null, e.message);
    return;
  }
  session.post('Runtime.evaluate', { expression: stackExpression, returnByValue: true, silent: true }, (err, res) => {
    if (err) {
      finish(null, err.message);
    } else if (res.exceptionDetails || !res.result || !Array.isArray(res.result.value)) {
      finish(null, 'the stack could not be read: ' + ((res.exceptionDetails && res.exceptionDetails.text) || 'no value'));
    } else {
      finish(res.result.value, null);
    }
  });
  // a sample that never lands (a garbage collection that doesn't end): give up on this one
  setTimeout(() => finish(null, 'no answer from the main thread'), sampleTimeoutMs);
}

function write(text) {
  try {
    fs.appendFileSync(stall.file, text);
  } catch (e) {
    fs.writeSync(2, 'stall watchdog: unable to write ' + stall.file + ': ' + e.message + '\n');
  }
}

setInterval(() => {
  if (busy) return;
  const now = Date.now();
  const last = Number(Atomics.load(beat, 0));
  const blocked = now - last;
  if (blocked < thresholdMs) {
    if (stall) {
      write('\n' + new Date(now).toISOString() + ' the event loop is running again, ' + Math.round(blocked / 1000) + 's after the heartbeat\n');
      let proc = null;
      const end = readProcState(process.pid);
      if (stall.procBase && end) {
        // the thread's state as last seen during the stall (it is running again now)
        const seen = stall.procPrev || stall.procBase;
        proc = describeProcState(stall.procBase, Object.assign({}, end, { state: seen.state, wchan: seen.wchan }));
        write('over the stall: ' + proc + '\n');
      }
      parentPort.postMessage({ since: stall.since, until: now, samples: stall.samples, file: stall.file, proc });
      stall = null;
    }
    return;
  }
  if (!stall) {
    const stamp = new Date(last).toISOString().replace(/[:.]/g, '-');
    const procBase = readProcState(process.pid);
    stall = { since: last, samples: [], file: path.join(dir, 'stall-' + label + '-' + stamp + '.txt'), next: now, procBase, procPrev: procBase, procLines: 0 };
    write('The event loop of process ' + process.pid + ' (' + label + ') has not run since ' + new Date(last).toISOString() + '\n');
  } else if (stall.procPrev && stall.procLines < MAX_PROC_LINES) {
    // what the kernel says, each second of the stall
    const cur = readProcState(process.pid);
    if (cur) {
      write(new Date(now).toISOString() + ' ' + describeProcState(stall.procPrev, cur) + '\n');
      stall.procPrev = cur;
      stall.procLines++;
    }
  }
  if (stall.samples.length >= maxSamples || now < stall.next) return;
  busy = true;
  sample((frames, error) => {
    busy = false;
    const at = Date.now();
    stall.next = at + thresholdMs;
    const s = { at, blockedMs: at - Number(Atomics.load(beat, 0)), frames, error };
    stall.samples.push(s);
    write('\n' + new Date(at).toISOString() + ' blocked ' + Math.round(s.blockedMs / 1000) + 's' +
      (frames ? ':\n  at ' + frames.join('\n  at ') : ': no stack (' + error + ')') + '\n');
  });
}, 1000);
