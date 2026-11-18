// When the event loop is held, a worker thread reads the main thread's stack and writes it to
// a file in the log folder, and the stall is logged once the loop runs again
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startStallWatchdog, readProcState, describeProcState } = require('../../library/stall-watchdog');

// holds the event loop until the watchdog has written a stack sample (or 20 s): a sample that
// lands after the loop is free again doesn't show this function
function heldHere(dir) {
  const end = Date.now() + 20000;
  let n = 0;
  while (Date.now() < end) {
    n += [1, 2, 3].map(x => x * 2).length;
    if (n % 200000 === 0) {
      const files = fs.readdirSync(dir);
      if (files.length > 0 && / blocked \d+s/.test(fs.readFileSync(path.join(dir, files[0]), 'utf8'))) {
        break;
      }
    }
  }
  return n;
}

describe('stall watchdog', () => {
  test('a held event loop: its stack is in a file, and in the log once it runs again', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-'));
    const warnings = [];
    const log = { warn: (m) => warnings.push(m), error: (m) => warnings.push('ERROR ' + m) };
    const wd = startStallWatchdog({ thresholdSeconds: 1, dir, label: 'tx9', log });
    try {
      await new Promise(r => setTimeout(r, 1200)); // the worker starts
      heldHere(dir);
      await new Promise(r => setTimeout(r, 2500)); // it notices the loop is running again
      const files = fs.readdirSync(dir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^stall-tx9-.*\.txt$/);
      const text = fs.readFileSync(path.join(dir, files[0]), 'utf8');
      expect(text).toContain('has not run since');
      expect(text).toContain('at heldHere (');
      expect(text).toContain('stall-watchdog.test.js');
      expect(text).toContain('the event loop is running again');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/The event loop was blocked for about \d+s/);
      expect(warnings[0]).toContain('heldHere (');
      if (fs.existsSync('/proc/self/stat')) {
        // on Linux, what the kernel says over the stall: the thread was running, on the CPU
        expect(text).toMatch(/over the stall: main thread R; cpu \d+\.\d\ds in \d+\.\d\ds; major faults \+\d+/);
        expect(warnings[0]).toContain('over the stall: main thread R');
      }
    } finally {
      await wd.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 40000);

  test('what /proc says, and what changed (Linux only)', () => {
    const before = readProcState(process.pid);
    if (!before) {
      expect(fs.existsSync('/proc/self/stat')).toBe(false);
      return;
    }
    expect(before.state).toMatch(/^[A-Za-z]$/);
    expect(Number.isFinite(before.cpuMs)).toBe(true);
    expect(Number.isFinite(before.majflt)).toBe(true);
    const after = { ...before, at: before.at + 2000, cpuMs: before.cpuMs + 1500, majflt: before.majflt + 12, state: 'D', wchan: 'folio_wait_bit',
      pressure: { io: { some: { avg10: 40.5, total: 1000000 }, full: { avg10: 30, total: 900000 } } } };
    const before2 = { ...before, pressure: { io: { some: { avg10: 0, total: 0 }, full: { avg10: 0, total: 0 } } } };
    const line = describeProcState(before2, after);
    expect(line).toMatch(/^main thread D in folio_wait_bit; cpu 1\.50s in 2\.00s; major faults \+12; rss \d+ MB, swap /);
    expect(line).toContain('pressure some/full avg10: io 40.5%/30% (+1.00s)');
  });

  test('0: not started', () => {
    expect(startStallWatchdog({ thresholdSeconds: 0, dir: os.tmpdir(), label: 'x', log: {} })).toBeNull();
  });
});
