/**
 * Tests that use an outside service (VSAC, the package servers) run at most once every few
 * hours, to keep the load off it: a timestamp file records when they last ran.
 *
 * To run them anyway, set FHIRSMITH_FORCE_SLOW_TESTS=1, or delete the timestamp file.
 */
const fs = require('fs');

const HOUR = 60 * 60 * 1000;

/**
 * When the tests last ran: the time in the file (an ISO date), or else the file's modification
 * time (an older or garbled file); null if there is no file
 * @param {string} file
 * @returns {number|null} ms since the epoch
 */
function lastRun(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return null;
  }
  const t = Date.parse(text.trim());
  return Number.isNaN(t) ? fs.statSync(file).mtimeMs : t;
}

/**
 * Whether to skip the tests: they ran less than `hours` ago (and a run isn't forced)
 * @param {string} file - the timestamp file
 * @param {number} hours - the least time between runs
 * @param {number} [now]
 * @returns {{skip: boolean, reason: string|null}} reason: why they're skipped, to report
 */
function checkThrottle(file, hours, now = Date.now()) {
  if (process.env.FHIRSMITH_FORCE_SLOW_TESTS) {
    return { skip: false, reason: null };
  }
  const last = lastRun(file);
  // (a last run more than a minute in the future - the clock was changed - doesn't count; a
  // file's modification time can be a little ahead of Date.now())
  if (last == null || now - last >= hours * HOUR || last > now + 60 * 1000) {
    return { skip: false, reason: null };
  }
  const ago = ((now - last) / HOUR).toFixed(1);
  return {
    skip: true,
    reason: `last run ${ago} hours ago - they run at most once every ${hours} hours (to run them now: FHIRSMITH_FORCE_SLOW_TESTS=1, or delete ${file})`
  };
}

/**
 * Record that the tests are running now
 * @param {string} file
 * @param {number} [now]
 */
function recordRun(file, now = Date.now()) {
  fs.writeFileSync(file, new Date(now).toISOString());
}

module.exports = { checkThrottle, recordRun, lastRun };
