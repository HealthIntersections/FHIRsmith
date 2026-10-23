const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const DailyReport = require('../../library/daily-report');
const { nextMidnight, localDate, formatSpan } = require('../../library/daily-report');
const Mailer = require('../../library/mailer');
const ServerStats = require('../../stats');

const HOUR = 60 * 60 * 1000;

describe('daily report', () => {
  let dir;
  let log;
  let mailer;
  let sent;
  let running;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fhirsmith-report-'));
    log = { error: jest.fn(), warn: jest.fn(), info: jest.fn() };
    sent = [];
    mailer = {
      configured: () => true,
      send: jest.fn(async (msg) => { sent.push(msg); return {}; })
    };
    running = [];
  });

  afterEach(() => {
    for (const r of running) {
      r.stop();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // a stats object with a run history, as ServerStats.runHistory() would give it
  function statsWith(runs, startTime) {
    return {
      startTime: startTime,
      runHistory: () => runs,
      overallUptime: () => ({ percent: 99.5, since: 1000 }),
      addTask: jest.fn(), task: jest.fn(), taskDone: jest.fn(), taskError: jest.fn()
    };
  }

  function newReport(config, deps = {}) {
    const report = new DailyReport({ to: ['ops@example.org'], ...config }, {
      log, mailer, version: '0.17.1', serverId: 'tx.test.org',
      stateFile: path.join(dir, 'daily-report.json'),
      modules: {},
      ...deps
    });
    running.push(report);
    return report;
  }

  test('the subject is the server id', () => {
    expect(newReport().subject()).toBe('tx.test.org daily report');
  });

  test('stability: uptime over the period, restarts, outages and upgrades', async () => {
    const since = Date.UTC(2026, 9, 21, 14, 0, 0);
    const now = since + 24 * HOUR;
    // the run before the period ended 2 hours in; a new version started after a 30 minute gap and is still running
    const runs = [
      { started: since - 10 * HOUR, lastSeen: since + 2 * HOUR, version: '0.17.0', current: false },
      { started: since + 2.5 * HOUR, lastSeen: now, version: '0.17.1', current: true }
    ];
    const report = newReport({}, { stats: statsWith(runs, since + 2.5 * HOUR) });
    const text = report.stabilityParagraph(since, now);
    expect(text).toContain('was up for 23h 30m of the 1d since the last report (97.9%)');
    expect(text).toContain('It started during the period');
    expect(text).toContain('The longest outage was 30m');
    expect(text).toContain('upgraded from v0.17.0 to v0.17.1');
  });

  test('stability: a quiet day', () => {
    const since = 1000;
    const now = since + 24 * HOUR;
    const runs = [{ started: since - HOUR, lastSeen: now, version: '0.17.1', current: true }];
    const text = newReport({}, { stats: statsWith(runs, since - HOUR) }).stabilityParagraph(since, now);
    expect(text).toContain('(100%)');
    expect(text).toContain('It ran without interruption.');
    expect(text).toContain('It was not upgraded (v0.17.1).');
    expect(text).not.toContain('outage');
  });

  test('stability: without the statistics database the uptime is unknown', () => {
    const text = newReport({}, { stats: { runHistory: () => null } }).stabilityParagraph(0, HOUR);
    expect(text).toContain('No run history is available');
  });

  test('modules contribute a paragraph only when they have something to say', async () => {
    const modules = {
      tx: { dailyReport: () => '12 value sets were expanded for the first time.' },
      quiet: { dailyReport: () => '' },
      silent: {},
      promised: { dailyReport: async () => 'Crawled 3 feeds.' },
      broken: { dailyReport: () => { throw new Error('no database'); } }
    };
    const report = newReport({}, { modules, stats: statsWith([], 0) });
    const text = await report.build(0, HOUR);
    expect(text).toContain('# tx.test.org daily report');
    expect(text).toContain('## Stability');
    expect(text).toContain('## Terminology server\n\n12 value sets were expanded for the first time.');
    expect(text).toContain('## promised\n\nCrawled 3 feeds.');
    expect(text).not.toContain('## quiet');
    expect(text).not.toContain('## silent');
    expect(text).toContain("## broken\n\nThe broken module's report failed: no database");
    expect(text).toContain('## System');
    expect(text).toContain('FHIRsmith v0.17.1 on Node.js');
    expect(text).toContain('log file');
    expect(text).toContain('99.5% of the time');
  });

  test('run sends the report and records when, and the next covers the time since', async () => {
    const stats = statsWith([], 0);
    const report = newReport({}, { stats });
    const first = 5 * HOUR;
    expect(await report.run(first)).toBe(true);
    expect(sent.length).toBe(1);
    expect(sent[0].to).toEqual(['ops@example.org']);
    expect(sent[0].subject).toBe('tx.test.org daily report');
    expect(sent[0].text).toContain('# tx.test.org daily report');
    expect(report.readState().sentAt).toBe(first);
    expect(stats.taskDone).toHaveBeenCalled();

    const runHistory = jest.spyOn(stats, 'runHistory');
    await report.run(first + 20 * HOUR);
    expect(runHistory).toHaveBeenCalledWith(first, first + 20 * HOUR);
  });

  test('a failed send is logged, not thrown, and is tried again next time', async () => {
    mailer.send = jest.fn(async () => { throw new Error('connection refused'); });
    const report = newReport({}, { stats: statsWith([], 0) });
    expect(await report.run(HOUR)).toBe(false);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('connection refused'));
    expect(report.readState().sentAt).toBeUndefined();
  });

  test('not sent without email configuration or recipients', () => {
    const noMail = newReport({}, { mailer: { configured: () => false } });
    expect(noMail.enabled).toBe(false);
    noMail.start();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('no "email" block'));
    expect(noMail.timer).toBeNull();

    const noOne = newReport({ to: [] });
    expect(noOne.enabled).toBe(false);
    noOne.start();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('no "dailyReport.to"'));

    expect(newReport({ enabled: false }).enabled).toBe(false);
    expect(newReport({}).enabled).toBe(true);
    expect(newReport({ to: 'one@example.org' }).enabled).toBe(true);
  });

  test('a report owed from last midnight is sent at startup; otherwise the first waits for midnight', () => {
    const stats = statsWith([], 0);
    const report = newReport({}, { stats });
    const run = jest.spyOn(report, 'run').mockResolvedValue(true);

    // never reported: wait for midnight
    const now = new Date(2026, 9, 22, 9, 30).getTime();
    report.start(now);
    expect(run).not.toHaveBeenCalled();
    expect(report.timer).not.toBeNull();
    expect(stats.addTask).toHaveBeenCalledWith('daily report', 'daily');
    report.stop();

    // reported yesterday, and a midnight has passed since: owed
    report.writeState({ sentAt: now - 24 * HOUR });
    report.start(now);
    expect(run).toHaveBeenCalledTimes(1);
    report.stop();

    // reported earlier today: not owed
    report.writeState({ sentAt: now - HOUR });
    report.start(now);
    expect(run).toHaveBeenCalledTimes(1);
  });

  test('the next report is at local midnight', () => {
    const now = new Date(2026, 9, 22, 9, 30, 15).getTime();
    const midnight = nextMidnight(now);
    expect(new Date(midnight).getHours()).toBe(0);
    expect(new Date(midnight).getMinutes()).toBe(0);
    expect(localDate(midnight)).toBe('2026-10-23');
    expect(localDate(midnight - 1)).toBe('2026-10-22');
  });

  test('spans are to the minute', () => {
    expect(formatSpan(0)).toBe('less than a minute');
    expect(formatSpan(90 * 1000)).toBe('2m');
    expect(formatSpan(HOUR)).toBe('1h');
    expect(formatSpan(26 * HOUR + 5 * 60000)).toBe('1d 2h 5m');
  });

  test('the run history from the statistics database feeds the report', async () => {
    const dbPath = path.join(dir, 'stats.db');
    const now = Date.now();
    const since = now - 11 * HOUR;
    const stats = new ServerStats({ database: dbPath }, log);
    stats.markStarted('0.17.0');
    try {
      // an earlier run, as a previous process would have left it: up for the first 2 hours of the period
      const db = new Database(dbPath);
      db.prepare('INSERT INTO server_runs (started, last_seen, version) VALUES (?, ?, ?)').run(since - HOUR, since + 2 * HOUR, '0.16.0');
      db.close();

      const report = newReport({}, { stats });
      const text = await report.build(since, now);
      expect(text).toContain('was up for 2h of the 11h since the last report (18.1%)');
      expect(text).toContain('It started during the period');
      expect(text).toContain('The longest outage was 9h');
      expect(text).toContain('upgraded from v0.16.0 to v0.17.0');
    } finally {
      stats.finishStats();
    }
  });

  test('npm audit findings and a newer release go in the system paragraph', async () => {
    const audit = { reportText: () => 'npm audit found 1 known vulnerability (1 high) in the packages this server uses: axios 1.0.0 (high: <1.2.0). The server administrator should upgrade to FHIRsmith 0.18.0 (this server is running 0.17.1).' };
    const report = newReport({}, { stats: statsWith([], 1), npmAudit: audit });
    const text = await report.build(0, HOUR);
    expect(text).toContain('## System');
    expect(text).toContain('npm audit found 1 known vulnerability (1 high)');
    expect(text).not.toContain('## Background tasks');

    const quiet = newReport({}, { stats: statsWith([], 1), npmAudit: { reportText: () => '' } });
    expect(await quiet.build(0, HOUR)).not.toContain('npm audit');
  });

  test('background tasks whose last run failed are listed; the npm audit is not repeated', async () => {
    const stats = statsWith([], 1);
    stats.failedTasks = () => [
      { name: 'XIG Download', state: 'Download failed: 503', frequency: 'daily', date: HOUR - 30 * 60000 },
      { name: 'npm audit', state: '2 known vulnerabilities', frequency: '24 hr', date: HOUR },
      { name: 'daily report', state: 'Not sent', frequency: 'daily', date: HOUR }
    ];
    const text = await newReport({}, { stats }).build(0, HOUR);
    expect(text).toContain('## Background tasks\n\n1 background task is in a failed state:\n\n- XIG Download: the last run failed (30m ago): Download failed: 503');
    expect(text).not.toContain('- npm audit');
    expect(text).not.toContain('- daily report');

    stats.failedTasks = () => [];
    expect(await newReport({}, { stats }).build(0, HOUR)).not.toContain('## Background tasks');
  });

  test('the mailer needs a host and a from address', async () => {
    expect(new Mailer({}, log).configured()).toBe(false);
    expect(new Mailer({ host: 'smtp.example.org' }, log).configured()).toBe(false);
    const mailer = new Mailer({ host: 'smtp.example.org', from: 'a@example.org' }, log);
    expect(mailer.configured()).toBe(true);
    await expect(new Mailer({}, log).send({ to: 'x', subject: 's', text: 't' })).rejects.toThrow('not configured');
    await expect(mailer.send({ to: [], subject: 's', text: 't' })).rejects.toThrow('No recipient');

    // the transport is only made when something is sent
    const sendMail = jest.fn(async () => ({ messageId: '1' }));
    mailer.transport = { sendMail };
    await mailer.send({ to: ['a@example.org', 'b@example.org'], subject: 's', text: 't' });
    expect(sendMail).toHaveBeenCalledWith({ from: 'a@example.org', to: 'a@example.org, b@example.org', subject: 's', text: 't' });
  });

  test('the transport takes its settings from the email block', () => {
    const mailer = new Mailer({ host: 'smtp.example.org', port: 465, user: 'u', password: 'p', from: 'a@example.org' }, log);
    const transport = mailer._transport();
    expect(transport.options.host).toBe('smtp.example.org');
    expect(transport.options.secure).toBe(true);
    expect(transport.options.auth).toEqual({ user: 'u', pass: 'p' });
    const plain = new Mailer({ host: 'smtp.example.org', from: 'a@example.org' }, log)._transport();
    expect(plain.options.port).toBe(587);
    expect(plain.options.secure).toBe(false);
    expect(plain.options.auth).toBeUndefined();
  });
});
