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

const { Worker } = require('worker_threads');

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
 * What /proc says about a thread (the main thread: its id is the process's) and the machine,
 * or null where there is no /proc (not Linux). Read from the watcher thread, so it uses only
 * what is given to it (it is put into the watcher's source)
 * @param {number} pid
 * @returns {Object|null}
 */
function readProcState(pid) {
  const fs = require('fs');
  const read = (p) => {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch (e) {
      return null;
    }
  };
  const stat = read('/proc/' + pid + '/task/' + pid + '/stat');
  if (!stat) {
    return null;
  }
  // after "pid (comm) ": state, ppid, pgrp, session, tty, tpgid, flags, minflt, cminflt, majflt,
  // cmajflt, utime, stime (in clock ticks)
  const f = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/ +/);
  const kb = (text, name) => {
    const m = new RegExp('^' + name + ':\\s+(\\d+)', 'm').exec(text || '');
    return m ? Number(m[1]) * 1024 : null;
  };
  const status = read('/proc/' + pid + '/status');
  const meminfo = read('/proc/meminfo');
  const pressure = {};
  for (const what of ['cpu', 'io', 'memory']) {
    const text = read('/proc/pressure/' + what);
    if (text) {
      const p = {};
      for (const line of text.split('\n')) {
        const m = /^(some|full) avg10=([0-9.]+) .*total=([0-9]+)/.exec(line);
        if (m) {
          p[m[1]] = { avg10: Number(m[2]), total: Number(m[3]) };
        }
      }
      pressure[what] = p;
    }
  }
  const wchan = (read('/proc/' + pid + '/task/' + pid + '/wchan') || '').trim();
  return {
    at: Date.now(),
    state: f[0],
    wchan: wchan && wchan !== '0' ? wchan : null,
    majflt: Number(f[9]),
    cpuMs: (Number(f[11]) + Number(f[12])) * 10, // clock ticks: 100 a second on Linux
    rss: kb(status, 'VmRSS'),
    swap: kb(status, 'VmSwap'),
    memAvailable: kb(meminfo, 'MemAvailable'),
    dirty: kb(meminfo, 'Dirty'),
    writeback: kb(meminfo, 'Writeback'),
    pressure
  };
}

/**
 * One line on what changed between two readProcState readings
 * @param {Object} before
 * @param {Object} now
 * @returns {string}
 */
function describeProcState(before, now) {
  const mb = (b) => (b == null ? '?' : Math.round(b / 1048576) + ' MB');
  const secs = (ms) => (ms / 1000).toFixed(2) + 's';
  const parts = ['main thread ' + now.state + (now.wchan ? ' in ' + now.wchan : ''),
    'cpu ' + secs(now.cpuMs - before.cpuMs) + ' in ' + secs(now.at - before.at),
    'major faults +' + (now.majflt - before.majflt),
    'rss ' + mb(now.rss) + ', swap ' + mb(now.swap)];
  const psi = [];
  for (const what of ['cpu', 'io', 'memory']) {
    const p = now.pressure[what];
    const b = before.pressure[what];
    if (p && p.some) {
      const stalled = b && b.some ? ' (+' + secs((p.some.total - b.some.total) / 1000) + ')' : '';
      psi.push(what + ' ' + p.some.avg10 + '%' + (p.full ? '/' + p.full.avg10 + '%' : '') + stalled);
    }
  }
  if (psi.length) {
    parts.push('pressure some/full avg10: ' + psi.join(', '));
  }
  parts.push('machine: available ' + mb(now.memAvailable) + ', dirty ' + mb(now.dirty) + ', writeback ' + mb(now.writeback));
  return parts.join('; ');
}

// the watcher, run as a worker thread (eval: it has to be a string)
const WATCHER = `
${readProcState.toString()}
${describeProcState.toString()}
const MAX_PROC_LINES = 60;
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const inspector = require('inspector');

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
      let proc = null;
      const end = readProcState(process.pid);
      if (stall.procBase && end) {
        // the thread's state as last seen during the stall (it is running again now)
        const seen = stall.procPrev || stall.procBase;
        proc = describeProcState(stall.procBase, Object.assign({}, end, { state: seen.state, wchan: seen.wchan }));
        write('over the stall: ' + proc + '\\n');
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
    write('The event loop of process ' + process.pid + ' (' + label + ') has not run since ' + new Date(last).toISOString() + '\\n');
  } else if (stall.procPrev && stall.procLines < MAX_PROC_LINES) {
    // what the kernel says, each second of the stall
    const cur = readProcState(process.pid);
    if (cur) {
      write(new Date(now).toISOString() + ' ' + describeProcState(stall.procPrev, cur) + '\\n');
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
