/**
 * A source that a request needs is loaded ahead of the proactive warm-up, and a source's size is
 * found despite the warm-up's burst:
 *
 * - in cluster mode the master's proactive warm-up queues every source by size; a request (a
 *   lookup, page or concept miss) for a source already in that queue used to leave it where it
 *   was - on tx.mangaradigital.org's test task (2026-11-26), BRAldeia's $expand failed with
 *   CODESYSTEM_TOO_COSTLY_TIME for over half an hour, its code system waiting behind hundreds of
 *   larger sources. It now goes to the front of the queue.
 * - a source's size is read from OCL (num_found of GET <concepts>?limit=1) as it is queued; in
 *   the warm-up's burst of ~1,800 such requests some failed, and those sources were queued last,
 *   as if they were the largest (UNKNOWN_JOB_SIZE). The requests are now limited and retried.
 */
const fs = require('fs/promises');
const path = require('path');
const { LanguageDefinitions } = require('../../library/languages');
const { I18nSupport } = require('../../library/i18nsupport');
const { OCLSourceCodeSystemFactory } = require('../../tx/ocl/cs-ocl');
const { OCLBackgroundJobQueue } = require('../../tx/ocl/jobs/background-queue');
const { sizeProbe, withSizeProbeSlot } = require('../../tx/ocl/shared/size-probe');
const { CACHE_CS_DIR, getCacheFilePath } = require('../../tx/ocl/cache/cache-paths');
const { ensureCacheDirectories } = require('../../tx/ocl/cache/cache-utils');

const flush = () => new Promise(resolve => setImmediate(resolve));
const keys = () => OCLBackgroundJobQueue.pendingJobs.map(job => job.jobKey);

function resetQueue() {
  OCLBackgroundJobQueue.pendingJobs = [];
  OCLBackgroundJobQueue.activeCount = 0;
  OCLBackgroundJobQueue.queuedOrRunningKeys = new Set();
  OCLBackgroundJobQueue.activeJobs = new Map();
  OCLBackgroundJobQueue.prioritizedKeys = new Set();
  OCLBackgroundJobQueue.enqueueSequence = 0;
  if (OCLBackgroundJobQueue.heartbeatTimer) {
    clearInterval(OCLBackgroundJobQueue.heartbeatTimer);
    OCLBackgroundJobQueue.heartbeatTimer = null;
  }
}

// keeps every job waiting: both slots taken
function blockQueue() {
  OCLBackgroundJobQueue.activeCount = OCLBackgroundJobQueue.MAX_CONCURRENT;
}

describe('OCLBackgroundJobQueue.prioritize', () => {
  beforeEach(() => {
    resetQueue();
    blockQueue();
  });
  afterEach(resetQueue);

  it('moves a waiting job to the front, as user requested', async () => {
    OCLBackgroundJobQueue.enqueue('small', 'CodeSystem load', jest.fn(), { jobSize: 10 });
    OCLBackgroundJobQueue.enqueue('medium', 'CodeSystem load', jest.fn(), { jobSize: 5000 });
    OCLBackgroundJobQueue.enqueue('unknown', 'CodeSystem load', jest.fn(), { jobSize: null });
    await flush();
    expect(keys()).toEqual(['small', 'medium', 'unknown']);

    expect(OCLBackgroundJobQueue.prioritize('unknown')).toBe(true);
    expect(keys()).toEqual(['unknown', 'small', 'medium']);
    expect(OCLBackgroundJobQueue.pendingJobs[0].userRequested).toBe(true);
  });

  it('flags a job still resolving its size, which is queued at the front once resolved', async () => {
    OCLBackgroundJobQueue.enqueue('small', 'CodeSystem load', jest.fn(), { jobSize: 10 });
    await flush();
    let resolveSize;
    OCLBackgroundJobQueue.enqueue('late', 'CodeSystem load', jest.fn(), {
      resolveJobSize: () => new Promise(resolve => { resolveSize = resolve; })
    });
    await flush();
    expect(keys()).toEqual(['small']);

    expect(OCLBackgroundJobQueue.prioritize('late')).toBe(true);
    resolveSize(999999);
    await flush();
    await flush();

    expect(keys()).toEqual(['late', 'small']);
    expect(OCLBackgroundJobQueue.prioritizedKeys.size).toBe(0);
  });

  it('does nothing for a job that is running or unknown', () => {
    OCLBackgroundJobQueue.activeJobs.set('running', { jobKey: 'running' });
    OCLBackgroundJobQueue.queuedOrRunningKeys.add('running');
    expect(OCLBackgroundJobQueue.prioritize('running')).toBe(false);
    expect(OCLBackgroundJobQueue.prioritize('nobody')).toBe(false);
    expect(OCLBackgroundJobQueue.prioritizedKeys.size).toBe(0);
  });
});

describe('size probes to OCL', () => {
  const saved = { ...sizeProbe };
  afterEach(() => {
    Object.assign(sizeProbe, saved, { active: 0, waiting: [] });
  });

  it('runs at most maxConcurrent at once', async () => {
    sizeProbe.maxConcurrent = 2;
    let running = 0;
    let peak = 0;
    const probe = () => withSizeProbeSlot(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise(resolve => setTimeout(resolve, 5));
      running -= 1;
    });
    await Promise.all(Array.from({ length: 7 }, probe));
    expect(peak).toBe(2);
    expect(sizeProbe.active).toBe(0);
    expect(sizeProbe.waiting.length).toBe(0);
  });
});

describe('OCL code system queued by a request: priority and size', () => {
  const CANONICAL = 'http://example.org/ocl/CodeSystem/queue-priority';
  const VERSION = '1.0';
  const file = getCacheFilePath(CACHE_CS_DIR, CANONICAL, VERSION);
  const saved = { ...sizeProbe };
  let i18n;

  beforeAll(async () => {
    const languages = await LanguageDefinitions.fromFiles(path.join(__dirname, '../../tx/data'));
    i18n = new I18nSupport(path.join(__dirname, '../../translations'), languages);
    await i18n.load();
  });

  beforeEach(async () => {
    OCLSourceCodeSystemFactory.factoriesByKey.clear();
    await ensureCacheDirectories(CACHE_CS_DIR);
    try { await fs.unlink(file); } catch (e) { /* none */ }
    resetQueue();
    blockQueue();
    sizeProbe.retryDelaysMs = [1, 1];
  });

  afterEach(() => {
    resetQueue();
    Object.assign(sizeProbe, saved, { active: 0, waiting: [] });
  });

  async function factoryWith(get) {
    const meta = { id: 'queue-priority', canonicalUrl: CANONICAL, version: VERSION, checksum: 'abc',
      conceptsUrl: '/orgs/TestOrg/sources/queue-priority/concepts/' };
    const factory = new OCLSourceCodeSystemFactory(i18n, null, meta, 'leader');
    factory.httpClient = { get };
    for (let i = 0; i < 100 && factory._coldCacheLoad; i++) {
      await new Promise(r => setTimeout(r, 5));
    }
    return factory;
  }

  async function until(condition) {
    for (let i = 0; i < 200 && !condition(); i++) {
      await new Promise(r => setTimeout(r, 5));
    }
  }

  it('retries the size when OCL fails in the burst, instead of queueing the source last', async () => {
    const get = jest.fn()
      .mockRejectedValueOnce(new Error('timeout of 30000ms exceeded'))
      .mockResolvedValue({ headers: { num_found: '8519' } });
    const factory = await factoryWith(get);

    factory.scheduleBackgroundLoad('proactive-warm');
    await until(() => OCLBackgroundJobQueue.pendingJobs.length === 1);

    expect(get).toHaveBeenCalledTimes(2);
    expect(OCLBackgroundJobQueue.pendingJobs[0].jobSize).toBe(8519);
    expect(OCLBackgroundJobQueue.pendingJobs[0].userRequested).toBe(false);
  });

  it('gives up after the retries: size unknown, as before', async () => {
    const get = jest.fn().mockRejectedValue(new Error('timeout of 30000ms exceeded'));
    const factory = await factoryWith(get);

    factory.scheduleBackgroundLoad('proactive-warm');
    await until(() => OCLBackgroundJobQueue.pendingJobs.length === 1);

    expect(get).toHaveBeenCalledTimes(3);
    expect(OCLBackgroundJobQueue.pendingJobs[0].jobSize).toBe(OCLBackgroundJobQueue.UNKNOWN_JOB_SIZE);
  });

  it('does not ask again when OCL answers without num_found', async () => {
    const get = jest.fn().mockResolvedValue({ headers: {} });
    const factory = await factoryWith(get);

    factory.scheduleBackgroundLoad('proactive-warm');
    await until(() => OCLBackgroundJobQueue.pendingJobs.length === 1);

    expect(get).toHaveBeenCalledTimes(1);
  });

  it('moves the source queued by the warm-up to the front when a request needs it', async () => {
    OCLBackgroundJobQueue.enqueue('cs:other-small|1', 'CodeSystem load', jest.fn(), { jobSize: 10 });
    OCLBackgroundJobQueue.enqueue('cs:other-large|1', 'CodeSystem load', jest.fn(), { jobSize: 1347126 });
    const get = jest.fn().mockResolvedValue({ headers: {} }); // size unknown: queued last
    const factory = await factoryWith(get);

    factory.scheduleBackgroundLoad('proactive-warm');
    await until(() => OCLBackgroundJobQueue.pendingJobs.length === 3);
    const jobKey = keys()[2];
    expect(keys()).toEqual(['cs:other-small|1', 'cs:other-large|1', jobKey]);

    factory.scheduleBackgroundLoad('concept-miss');
    await until(() => keys()[0] === jobKey);

    expect(keys()).toEqual([jobKey, 'cs:other-small|1', 'cs:other-large|1']);
    expect(OCLBackgroundJobQueue.pendingJobs[0].userRequested).toBe(true);
  });

  it('queues a source first requested by a request as user requested', async () => {
    OCLBackgroundJobQueue.enqueue('cs:other-small|1', 'CodeSystem load', jest.fn(), { jobSize: 10 });
    const get = jest.fn().mockResolvedValue({ headers: { num_found: '8519' } });
    const factory = await factoryWith(get);

    factory.scheduleBackgroundLoad('lookup-miss');
    await until(() => OCLBackgroundJobQueue.pendingJobs.length === 2);

    expect(OCLBackgroundJobQueue.pendingJobs[0].userRequested).toBe(true);
    expect(keys()[1]).toBe('cs:other-small|1');
  });
});
