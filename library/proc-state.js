'use strict';

// What /proc says about the main thread and the machine, for the stall watchdog
// (library/stall-watchdog.js): read from its watcher thread, while the main thread is stalled.

const fs = require('fs');

/**
 * What /proc says about a thread (the main thread: its id is the process's) and the machine,
 * or null where there is no /proc (not Linux). Read from the watcher thread (stall-watchdog-worker.js)
 * @param {number} pid
 * @returns {Object|null}
 */
function readProcState(pid) {
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

module.exports = { readProcState, describeProcState };
