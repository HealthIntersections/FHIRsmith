// The xig paragraph of the daily report must say whether the database was updated on schedule (02:00 local)

const xig = require('../../xig/xig');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
// local midnight, so the times are the same wherever the tests run
const NOW = new Date(2026, 10, 6, 0, 0, 0).getTime();
const SINCE = NOW - 24 * HOUR;
const TWO_AM = new Date(2026, 10, 5, 2, 0, 0).getTime();

function attempt(time, status, extra = {}) {
  return { timestamp: new Date(time), trigger: 'cron', status, error: null, downloadMeta: null, durationMs: null, ...extra };
}

describe('xig daily report: database updates', () => {
  test('the scheduled update times in a period', () => {
    expect(xig.scheduledUpdatesBetween(SINCE, NOW)).toEqual([TWO_AM]);
    expect(xig.scheduledUpdatesBetween(SINCE, TWO_AM - MIN)).toEqual([]);
    expect(xig.scheduledUpdatesBetween(NOW - 72 * HOUR, NOW)).toHaveLength(3);
  });

  test('affirms an update made on schedule', () => {
    const history = [attempt(TWO_AM + 2 * MIN, 'success', { downloadMeta: { downloadedBytes: 300 * 1024 * 1024 }, durationMs: 4 * MIN })];
    const text = xig.describeUpdates(history, { since: SINCE, now: NOW, dbModified: TWO_AM + 6 * MIN }).join(' ');
    expect(text).toBe('The database was updated on schedule at 02:02 (300.0 MB, took 4m).');
  });

  test('a failed scheduled update, and the age of the database still in use', () => {
    const history = [attempt(TWO_AM, 'failed', { error: 'Download failed: 503' })];
    const text = xig.describeUpdates(history, { since: SINCE, now: NOW, dbModified: NOW - 48 * HOUR }).join(' ');
    expect(text).toContain('The scheduled database update at 02:00 failed: Download failed: 503.');
    expect(text).toMatch(/The database in use was downloaded \d{4}-\d\d-\d\d 00:00 \(2d ago\)\./);
  });

  test('no update ran at the scheduled time', () => {
    const text = xig.describeUpdates([], { since: SINCE, now: NOW, dbModified: NOW - 30 * HOUR }).join(' ');
    expect(text).toContain('The database was not updated on schedule: no update ran at 02:00');
    expect(text).toContain('The database in use was downloaded');
  });

  test('the record was lost in a restart, but the file shows the update happened', () => {
    const text = xig.describeUpdates([], { since: SINCE, now: NOW, dbModified: TWO_AM + 5 * MIN }).join(' ');
    expect(text).toBe('The database was updated at 02:05.');
  });

  test('a manual update after a failed scheduled one', () => {
    const history = [
      attempt(TWO_AM + 8 * HOUR, 'success', { trigger: 'manual' }),
      attempt(TWO_AM, 'failed', { error: 'Download Timeout' })
    ];
    const text = xig.describeUpdates(history, { since: SINCE, now: NOW, dbModified: TWO_AM + 8 * HOUR }).join(' ');
    expect(text).toBe('The scheduled database update at 02:00 failed: Download Timeout. A manual update at 10:00 succeeded.');
  });

  test('attempts outside the period are ignored', () => {
    const history = [attempt(TWO_AM - 24 * HOUR, 'success')];
    const text = xig.describeUpdates(history, { since: SINCE, now: NOW, dbModified: TWO_AM - 24 * HOUR }).join(' ');
    expect(text).toContain('was not updated on schedule');
  });

  test('scheduled updates turned off', () => {
    const text = xig.describeUpdates([], { since: SINCE, now: NOW, autoUpdate: false, dbModified: NOW - 5 * 24 * HOUR }).join(' ');
    expect(text).toContain('Scheduled database updates are turned off.');
    expect(text).toContain('(5d ago)');
  });

  test('no update due in a short period', () => {
    const text = xig.describeUpdates([], { since: NOW - 3 * HOUR, now: NOW, dbModified: TWO_AM }).join(' ');
    expect(text).toContain('No database update was due in this period.');
  });
});
