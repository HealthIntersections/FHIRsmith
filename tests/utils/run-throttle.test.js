/**
 * The throttle on tests that use an outside service (tests/utils/run-throttle.js): the VSAC
 * tests used fs.readFile/writeFile from the callback API without a callback, so the "last run"
 * was never read or written and the limit never applied
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkThrottle, recordRun, lastRun } = require('./run-throttle');

const HOUR = 60 * 60 * 1000;

describe('run throttle', () => {
  let dir;
  let file;
  const forced = process.env.FHIRSMITH_FORCE_SLOW_TESTS;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'throttle-'));
    file = path.join(dir, '.last-run');
    delete process.env.FHIRSMITH_FORCE_SLOW_TESTS;
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (forced === undefined) {
      delete process.env.FHIRSMITH_FORCE_SLOW_TESTS;
    } else {
      process.env.FHIRSMITH_FORCE_SLOW_TESTS = forced;
    }
  });

  test('never run: run', () => {
    expect(checkThrottle(file, 2)).toEqual({ skip: false, reason: null });
  });

  test('a recorded run is read back, and skips the tests until the interval has passed', () => {
    const t = Date.parse('2026-11-10T00:00:00Z');
    recordRun(file, t);
    expect(fs.readFileSync(file, 'utf8')).toBe('2026-11-10T00:00:00.000Z');
    expect(lastRun(file)).toBe(t);

    const soon = checkThrottle(file, 2, t + 1.5 * HOUR);
    expect(soon.skip).toBe(true);
    expect(soon.reason).toContain('last run 1.5 hours ago');
    expect(soon.reason).toContain(file);
    expect(checkThrottle(file, 2, t + 2 * HOUR).skip).toBe(false);
  });

  test('FHIRSMITH_FORCE_SLOW_TESTS runs them anyway', () => {
    recordRun(file);
    process.env.FHIRSMITH_FORCE_SLOW_TESTS = '1';
    expect(checkThrottle(file, 2).skip).toBe(false);
  });

  test('a file that is not a date counts from its modification time; a run in the future does not block', () => {
    fs.writeFileSync(file, 'garbled');
    expect(checkThrottle(file, 2).skip).toBe(true);
    fs.utimesSync(file, new Date(Date.now() - 3 * HOUR), new Date(Date.now() - 3 * HOUR));
    expect(checkThrottle(file, 2).skip).toBe(false);

    recordRun(file, Date.now() + HOUR);
    expect(checkThrottle(file, 2).skip).toBe(false);
  });
});
