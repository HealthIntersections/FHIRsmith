// library/changelog.js
// Release dates from CHANGELOG.md. A release is dated in its heading when it is made -
// "## [0.14.2] - 2026-10-06" (or "## [v0.13.4] - ...") - so the changelog that ships with
// the code is where a server finds out when its own version was released. A snapshot's
// heading has no date yet, so it has no release date.

const fs = require('fs');
const path = require('path');

const DEFAULT_PATH = path.join(__dirname, '..', 'CHANGELOG.md');
const HEADING = /^##\s*\[v?(\d+\.\d+\.\d+)\]\s*-\s*(\d{4}-\d{2}-\d{2})\s*$/gm;

/**
 * @param {string} [changelogPath]
 * @returns {Map<string, string>} version (no leading v) -> release date (YYYY-MM-DD).
 *   Throws if the file can't be read.
 */
function readReleaseDates(changelogPath = DEFAULT_PATH) {
  const text = fs.readFileSync(changelogPath, 'utf8');
  const dates = new Map();
  let m;
  HEADING.lastIndex = 0;
  while ((m = HEADING.exec(text)) !== null) {
    if (!dates.has(m[1])) {
      dates.set(m[1], m[2]);
    }
  }
  return dates;
}

/**
 * The release date of a version, or null if it isn't a dated release (a snapshot, or no
 * changelog to read)
 */
function releaseDateOf(version, changelogPath = DEFAULT_PATH) {
  try {
    return readReleaseDates(changelogPath).get(String(version || '').replace(/^v/, '')) || null;
  } catch (e) {
    return null;
  }
}

module.exports = { readReleaseDates, releaseDateOf };
