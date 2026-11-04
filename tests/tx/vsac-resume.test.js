const fs = require('fs');
const os = require('os');
const path = require('path');
const { VSACValueSetProvider } = require('../../tx/vs/vs-vsac');
const { ValueSetDatabase } = require('../../tx/vs/vs-database');

/**
 * A VSAC sync that is cut short (the server stops part way through) or fails is
 * picked up again when the server starts, rather than leaving a partly filled
 * cache until the refresh timer fires. The VSAC server is faked by stubbing
 * _fetchBundle; the cache is a real sqlite database in a temp folder.
 */

const BASE = 'http://cts.nlm.nih.gov/fhir/ValueSet/';

// the fake VSAC content: url -> versions (the last one is current)
const SERVER = {
  [BASE + 'a']: ['1', '2'],
  [BASE + 'b']: ['1', '2'],
  [BASE + 'c']: ['1']
};

function vs(url, version) {
  const id = url.substring(BASE.length) + '-' + version;
  return {
    resourceType: 'ValueSet', id, url, version, status: 'active', name: 'VS' + id,
    compose: { include: [{ system: 'http://loinc.org', concept: [{ code: '1234-5' }] }] }
  };
}

function bundle(resources) {
  return { resourceType: 'Bundle', total: resources.length, entry: resources.map(resource => ({ resource })) };
}

function fakeFetch(log, hang = () => false) {
  return async (url) => {
    log.push(url);
    if (url.startsWith('/ValueSet?_offset')) {
      return bundle(Object.entries(SERVER).map(([u, versions]) => vs(u, versions[versions.length - 1])));
    }
    if (url.startsWith('/res/ValueSet/?_lastUpdated')) {
      return { ...bundle([]), meta: { lastUpdated: '2026-11-01T00:00:00Z' } };
    }
    const q = url.substring('/ValueSet?url='.length);
    if (hang(q)) {
      return new Promise(() => {}); // the server stops while this request is in flight
    }
    return bundle((SERVER[q] || []).map(v => vs(q, v)));
  };
}

function provider(dbPath, fetchBundle) {
  const p = Object.create(VSACValueSetProvider.prototype);
  p.database = new ValueSetDatabase(dbPath);
  p.valueSetMap = new Map();
  p.initialized = false;
  p.isRefreshing = false;
  p.refreshIntervalHours = 24;
  p.stats = { addTask() {}, task() {}, taskDone() {}, taskError() {} };
  p.log = { error() {} };
  p._startRefreshTimer = () => {};
  p._fetchBundle = fetchBundle;
  return p;
}

const loaded = p => [...p.valueSetMap.keys()].filter(k => k.includes('|')).sort();
const ALL = [BASE + 'a|1', BASE + 'a|2', BASE + 'b|1', BASE + 'b|2', BASE + 'c|1'];

async function waitFor(cond) {
  for (let i = 0; i < 200 && !(await cond()); i++) {
    await new Promise(r => setTimeout(r, 10));
  }
}

describe('VSAC sync resumes at startup', () => {
  let dir;
  let dbPath;
  const open = [];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsac-resume-'));
    dbPath = path.join(dir, 'vsac.db');
  });

  afterEach(async () => {
    for (const p of open.splice(0)) {
      await p.database.close();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a sync interrupted part way through a URL is finished at the next startup', async () => {
    // first start: the server stops while fetching b, after its current version was written
    const log1 = [];
    const first = provider(dbPath, fakeFetch(log1, q => q === BASE + 'b'));
    open.push(first);
    const realProcess = first.processContentAndHistory.bind(first);
    first.processContentAndHistory = async (q, tracking, length) => {
      if (q === BASE + 'b') {
        await first.database.upsertValueSet(vs(q, '2'));
      }
      return realProcess(q, tracking, length);
    };
    first.initialize();
    await waitFor(() => log1.includes('/ValueSet?url=' + BASE + 'b'));
    expect(log1).toContain('/ValueSet?url=' + BASE + 'a');

    // restart: the cache isn't empty, but the last sync didn't finish
    const log2 = [];
    const second = provider(dbPath, fakeFetch(log2));
    open.push(second);
    await second.initialize();

    expect(loaded(second)).toEqual(ALL);
    // b - in flight when the server stopped - is fetched again, first; a isn't
    const fetched = log2.filter(u => u.startsWith('/ValueSet?url='));
    expect(fetched).toEqual(['/ValueSet?url=' + BASE + 'b', '/ValueSet?url=' + BASE + 'c']);
    // the interrupted run is closed off, and the resumed one completed
    const last = await second.database.getLastRun();
    expect(last.status).toBe('ok');
    expect(await second.database.markInterruptedRuns()).toBe(0);
    expect(await second.database.getSetting('vsac_pending_queue')).toBeNull();
    expect(await second.database.getSetting('vsac_pending_progress')).toBeNull();
    expect(await second.database.getSetting('vsac_last_updated_date')).toBe('2026-11-01T00:00:00Z');
  });

  test('no sync at startup when the last sync completed', async () => {
    const first = provider(dbPath, fakeFetch([]));
    open.push(first);
    await first.initialize();
    expect(loaded(first)).toEqual(ALL);
    await first.database.close();
    open.pop();

    const log = [];
    const second = provider(dbPath, fakeFetch(log));
    open.push(second);
    await second.initialize();
    expect(log).toEqual([]);
    expect(loaded(second)).toEqual(ALL);
  });

  test('a sync that failed is run again at startup', async () => {
    // a full first sync, then a later run that fails while listing
    const first = provider(dbPath, fakeFetch([]));
    open.push(first);
    await first.initialize();
    first._fetchBundle = async () => { throw new Error('HTTP 503: Service Unavailable'); };
    await expect(first.refreshValueSets()).rejects.toThrow('503');
    expect((await first.database.getLastRun()).status).toBe('error');
    await first.database.close();
    open.pop();

    const log = [];
    const second = provider(dbPath, fakeFetch(log));
    open.push(second);
    await second.initialize();
    expect(log[0]).toMatch(/^\/ValueSet\?_offset/);
    expect((await second.database.getLastRun()).status).toBe('ok');
  });

  test('a failed startup sync is logged and does not stop initialisation', async () => {
    const p = provider(dbPath, async () => { throw new Error('Network error: No response received'); });
    open.push(p);
    let timer = false;
    p._startRefreshTimer = () => { timer = true; };
    const errors = [];
    p.log = { error: (e) => errors.push(e) };
    await p.initialize();
    expect(timer).toBe(true);
    expect(p.initialized).toBe(true);
    expect(errors.length).toBe(1);
  });
});
