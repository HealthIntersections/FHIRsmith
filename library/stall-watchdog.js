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
 * attaches to the main thread through the inspector and has it take its own stack: a
 * Runtime.evaluate of new Error().stack (inspector messages are V8 interrupts, so they get
 * through a busy loop, and the expression runs on top of the frames it interrupted; a long
 * garbage collection, or a long call into native code, holds them until it ends). It does
 * that again each threshold while the stall lasts, up to MAX_SAMPLES, so the stacks show
 * whether it is stuck in one place or moving through a long loop.
 *
 * Not Debugger.pause: enabling the debugger first reports every script the process has
 * loaded, one message each, which grows with the process (the CI run, every test suite in
 * one process, got no stack within 15 s). An evaluation needs nothing enabled, and takes a
 * millisecond.
 *
 * What it finds goes to a file in the log folder straight away (the main thread may
 * never recover: the process can run out of memory), and into the log as a warning once
 * the main thread is running again.
 *
 * A stack can't say why the main thread isn't running JavaScript at all: a sample that only
 * lands when the loop runs again, on an empty stack, with no garbage collection going on
 * (npm.fhir.org, Nov 2026), is native code, or the kernel holding the process. So on Linux,
 * every second of a stall, it also writes what /proc says (readProcState): the main thread's
 * state (R running, D waiting on the disk, S sleeping) and what it waits in, the CPU time it
 * used and the major page faults it took meanwhile, the process's RSS and swap, and the
 * machine's pressure (PSI: cpu, io, memory) and free memory. CPU time going up is native work;
 * D with page faults is the disk or memory; R with little CPU time is a starved machine.
 */

const path = require('path');
const { Worker } = require('worker_threads');
const { readProcState, describeProcState } = require('./proc-state');

const MAX_SAMPLES = 5;
const MAX_FRAMES = 40;
// How long a sample may take before it is given up: it is answered at the main thread's next
// interrupt check, so only something that holds those (a long garbage collection, a long call
// into native code) takes more than a few milliseconds
const SAMPLE_TIMEOUT_MS = 15000;

// Run on the main thread, on top of the frames it interrupted: its stack, as text, without the
// expression's own frames (which have no file). The stack is formatted here, not by
// Error.prepareStackTrace, which a library (or jest) may have replaced
const STACK_EXPRESSION = '(() => {' +
  ' const prepare = Error.prepareStackTrace, limit = Error.stackTraceLimit;' +
  ' try {' +
  '  Error.stackTraceLimit = MAX_FRAMES + 5;' +
  '  Error.prepareStackTrace = (e, sites) => sites;' +
  '  const sites = new Error().stack;' +
  '  let i = 0;' +
  '  while (i < sites.length && !sites[i].getFileName()) i++;' +
  '  return sites.slice(i, i + MAX_FRAMES).map(s => (s.getFunctionName() || s.getMethodName() || "(anonymous)") +' +
  '   " (" + String(s.getFileName()).replace(/^file:\\/\\//, "") + ":" + s.getLineNumber() + ":" + s.getColumnNumber() + ")");' +
  ' } finally {' +
  '  Error.prepareStackTrace = prepare;' +
  '  Error.stackTraceLimit = limit;' +
  ' }' +
  '})()';


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

  const worker = new Worker(path.join(__dirname, 'stall-watchdog-worker.js'), {
    workerData: { buffer, thresholdMs, dir, label: String(label).replace(/[^A-Za-z0-9_-]/g, '_'), maxSamples: MAX_SAMPLES, sampleTimeoutMs: SAMPLE_TIMEOUT_MS,
      stackExpression: STACK_EXPRESSION.replaceAll('MAX_FRAMES', String(MAX_FRAMES)) }
  });
  worker.unref();
  worker.on('message', (m) => {
    const secs = Math.round((m.until - m.since) / 1000);
    const top = m.samples.filter(s => s.frames).map(s => '  ' + Math.round(s.blockedMs / 1000) + 's: ' + s.frames.slice(0, 6).join(' < '));
    log.warn(`The event loop was blocked for about ${secs}s (from ${new Date(m.since).toISOString()}). ` +
      `${m.samples.length} stack sample(s) in ${m.file}` + (m.proc ? '\n  over the stall: ' + m.proc : '') + (top.length ? '\n' + top.join('\n') : ''));
  });
  worker.on('error', (e) => log.error(`The event loop watchdog failed: ${e.message}`));

  return {
    stop() {
      clearInterval(timer);
      return worker.terminate();
    }
  };
}

module.exports = { startStallWatchdog, readProcState, describeProcState };
