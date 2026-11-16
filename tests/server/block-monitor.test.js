// The event loop held for 2 seconds or more: logged with the requests in flight when it began,
// counted by length (2-5s, 5-10s, 10s+), and reported in the daily report's stability paragraph.

const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const BlockMonitor = require('../../library/block-monitor');
const { TICK_MS, blockSummary } = require('../../library/block-monitor');
const ServerStats = require('../../stats');
const DailyReport = require('../../library/daily-report');

describe('block monitor', () => {
  let clock;
  let log;
  let stats;
  let monitor;

  beforeEach(() => {
    clock = 1000000;
    log = { warn: jest.fn(), info: jest.fn(), error: jest.fn() };
    stats = { countEvent: jest.fn() };
    monitor = new BlockMonitor({ log, stats, now: () => clock });
    monitor.lastTick = clock;
  });

  // a request through the middleware; returns its response, to finish it
  function arrive(url) {
    const res = new EventEmitter();
    res.once = res.once.bind(res);
    monitor.middleware()({ method: 'GET', originalUrl: url }, res, () => {});
    return res;
  }

  test('an on-time tick is not a block', () => {
    clock += TICK_MS + 50;
    monitor.tick();
    expect(log.warn).not.toHaveBeenCalled();
    expect(stats.countEvent).not.toHaveBeenCalled();
  });

  test('a block is logged with the requests in flight when it began, oldest first', () => {
    clock += 50;
    const done = arrive('/packages/hl7.terminology');
    arrive('/xig?_fmt=csv');
    clock += 30;
    arrive('/xig?offset=60800&ver=R4');
    done.emit('finish'); // finished before the block: not a suspect
    clock = monitor.lastTick + TICK_MS + 3000;
    monitor.tick();
    expect(log.warn).toHaveBeenCalledTimes(1);
    const line = log.warn.mock.calls[0][0];
    expect(line).toMatch(/^Event loop blocked for 3\.0s; in flight when it began: GET \/xig\?_fmt=csv \(for 0\.\ds\), GET \/xig\?offset=60800&ver=R4/);
    expect(line).not.toContain('hl7.terminology');
    expect(stats.countEvent).toHaveBeenCalledWith('event loop blocked 2-5s', 3000);
  });

  test('a request that arrived during the block is not named', () => {
    clock = monitor.lastTick + TICK_MS + 6000;
    arrive('/late'); // accepted after the loop came back
    monitor.tick();
    expect(log.warn.mock.calls[0][0]).toBe('Event loop blocked for 6.0s; no request was in flight when it began');
    expect(stats.countEvent).toHaveBeenCalledWith('event loop blocked 5-10s', 6000);
  });

  test('the request that finished as the block ended is named first', () => {
    arrive('/packages/hl7.terminology');
    clock += 20;
    const culprit = arrive('/xig/resource/fhir.tx.support%7C1.0.4/CodeSystem/CodeSystem-icd-10-cm.json');
    clock = monitor.lastTick + TICK_MS + 4000;
    culprit.emit('finish'); // its response went out at the end of the work, before the tick
    monitor.tick();
    expect(log.warn.mock.calls[0][0]).toBe('Event loop blocked for 4.0s; in flight when it began: ' +
      'GET /xig/resource/fhir.tx.support%7C1.0.4/CodeSystem/CodeSystem-icd-10-cm.json (finished as it ended), ' +
      'GET /packages/hl7.terminology (for 0.1s)');
  });

  test('long blocks are counted as 10s+, and finished requests are forgotten at the next tick', () => {
    const res = arrive('/gone');
    res.emit('close');
    expect(monitor.inFlight.size).toBe(1);
    clock = monitor.lastTick + TICK_MS + 25000;
    monitor.tick();
    expect(stats.countEvent).toHaveBeenCalledWith('event loop blocked 10s+', 25000);
    expect(monitor.inFlight.size).toBe(0);
  });

  test('blockSummary counts each band with the longer ones', () => {
    expect(blockSummary({ operations: {
      'event loop blocked 2-5s': 7, 'event loop blocked 5-10s': 3, 'event loop blocked 10s+': 2, '/': 99 } }))
      .toEqual({ over2: 12, over5: 5, over10: 2 });
    expect(blockSummary({ operations: {} })).toEqual({ over2: 0, over5: 0, over10: 0 });
  });
});

describe('block counts in the statistics and the daily report', () => {
  let stats;
  let dir;
  const log = { warn: jest.fn(), info: jest.fn(), error: jest.fn() };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fhirsmith-blocks-'));
    stats = new ServerStats({ database: path.join(dir, 'stats.db') }, log);
  });

  afterEach(() => {
    stats.finishStats();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function report() {
    return new DailyReport({ to: ['ops@example.org'] }, { log, stats, version: '1.0.3', serverId: 'npm.test.org',
      stateFile: path.join(dir, 'daily-report.json'), modules: {} });
  }

  test('a block is counted under (server), not as a request', () => {
    stats.countEvent('event loop blocked 5-10s', 7000);
    expect(stats.requestCount).toBe(0);
    expect(stats.countsSince(0, Date.now(), '(server)').operations).toEqual({ 'event loop blocked 5-10s': 1 });
  });

  test('the stability paragraph says how many blocks there were', () => {
    const now = Date.now();
    expect(report().blocksSentence(now - 1000, now)).toBe('The event loop was never blocked for 2 seconds or more.');
    for (let i = 0; i < 4; i++) {
      stats.countEvent('event loop blocked 2-5s', 2500);
    }
    stats.countEvent('event loop blocked 5-10s', 6000);
    stats.countEvent('event loop blocked 10s+', 20000);
    stats.flushNow(Date.now());
    const later = Date.now() + 1;
    expect(report().blocksSentence(now - 1000, later)).toBe('The event loop was blocked for 2 seconds or more 6 times ' +
      '(2 of them for 5 seconds or more, 1 for 10 seconds or more); each is in the log ("Event loop blocked"), with the requests that were in flight.');
  });
});
