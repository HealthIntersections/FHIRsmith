// The VSAC provider doesn't hold its value sets in memory: it reads each one from its database
// when it is asked for. These check that what it serves is what it served when it loaded them
// all into a map at startup - the same version picked for a url, the same changes made to the
// stored value set (no code system versions in the compose, an id in the provider's id space),
// the same value sets rejected - and that a refresh compares against the database. The value
// sets most recently used are kept parsed: these check that they are dropped when the sync
// changes them, and that what is kept is not changed by what reads it.

const fs = require('fs');
const path = require('path');
const { VSACValueSetProvider } = require('../../tx/vs/vs-vsac');
const { ValueSetDatabase } = require('../../tx/vs/vs-database');
const folders = require('../../library/folder-setup');

const URL1 = 'http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1.113883.3.1';
const URL2 = 'http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1.113883.3.2';

function vs(url, version, extra = {}) {
  const oid = url.substring(url.lastIndexOf('/') + 1);
  return {
    resourceType: 'ValueSet', id: `${oid}-${version}`, url, version, status: 'active',
    name: 'Test' + oid.replace(/\./g, ''), title: `Test ${oid} ${version}`, publisher: 'Test Publisher',
    compose: {
      include: [{ system: 'http://snomed.info/sct', version: 'http://snomed.info/sct/731000124108/version/20250901',
        concept: [{ code: '73211009', display: 'Diabetes mellitus' }] }],
      exclude: [{ system: 'http://loinc.org', version: '2.77', concept: [{ code: '1234-5' }] }]
    },
    ...extra
  };
}

describe('VSAC value sets read on demand', () => {
  let dbPath;
  let provider;
  let events;

  async function makeProvider(valueSets) {
    dbPath = path.join(folders.ensureFolder('vsac-on-demand-test'), `vsac-${process.pid}-${Date.now()}.db`);
    const database = new ValueSetDatabase(dbPath);
    await database.create();
    for (const v of valueSets) {
      await database.upsertValueSet(v, require('crypto').createHash('sha256').update(JSON.stringify(v)).digest('hex'));
    }
    const p = Object.create(VSACValueSetProvider.prototype);
    p.database = database;
    p.stats = { addTask() {}, task() {}, taskDone() {}, taskError() {} };
    p.initialized = true;
    await p._recount();
    p.assignIds('vsac');
    events = [];
    const recordEvent = database.recordEvent.bind(database);
    database.recordEvent = async (type, url, version) => { events.push(`${type} ${url}|${version}`); return recordEvent(type, url, version); };
    return p;
  }

  afterEach(async () => {
    if (provider) {
      await provider.close();
      provider = null;
    }
    for (const f of [dbPath, dbPath + '-journal']) {
      if (f && fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  test('a url gets its latest version, whatever order the rows were stored in; url|version gets that version', async () => {
    provider = await makeProvider([vs(URL1, '20240101'), vs(URL1, '20250601'), vs(URL1, '20230101'), vs(URL2, '20200101')]);
    expect((await provider.fetchValueSet(URL1)).version).toBe('20250601');
    expect((await provider.fetchValueSet(URL1, '20240101')).version).toBe('20240101');
    // a version there isn't falls back to the latest, as the map's bare-url key did
    expect((await provider.fetchValueSet(URL1, '20990101')).version).toBe('20250601');
    expect((await provider.fetchValueSet(URL2)).version).toBe('20200101');
    expect(await provider.fetchValueSet('http://cts.nlm.nih.gov/fhir/ValueSet/none')).toBeNull();
  });

  test('what is served has no code system versions in the compose, an id in the provider id space, and the stored hash', async () => {
    provider = await makeProvider([vs(URL1, '20250601')]);
    const v = await provider.fetchValueSet(URL1);
    expect(v.jsonObj.compose.include[0].version).toBeUndefined();
    expect(v.jsonObj.compose.exclude[0].version).toBeUndefined();
    expect(v.jsonObj.compose.include[0].concept[0].code).toBe('73211009');
    expect(v.id).toBe('vsac-2.16.840.1.113883.3.1-20250601');
    expect(v.jsonObj.id).toBe('vsac-2.16.840.1.113883.3.1-20250601');
    expect(v.sourcePackage).toBe('vsac');
    expect(v.contentHash).toMatch(/^[0-9a-f]{64}$/);
    // the stored content (which a refresh hashes) is untouched
    const db = await provider.database._getReadConnection();
    const stored = await new Promise((res, rej) => db.get('SELECT content FROM valuesets', [], (e, r) => e ? rej(e) : res(r.content)));
    expect(JSON.parse(stored).compose.include[0].version).toBe('http://snomed.info/sct/731000124108/version/20250901');
  });

  test('by id: only the id in the provider id space finds it', async () => {
    provider = await makeProvider([vs(URL1, '20250601')]);
    expect((await provider.fetchValueSetById('vsac-2.16.840.1.113883.3.1-20250601')).version).toBe('20250601');
    expect(await provider.fetchValueSetById('2.16.840.1.113883.3.1-20250601')).toBeNull();
    expect(await provider.fetchValueSetById('other-2.16.840.1.113883.3.1-20250601')).toBeNull();
    expect(await provider.fetchValueSetById('vsac-nothing')).toBeNull();
  });

  test('a stored value set that is not acceptable is skipped, as it was when loading the map', async () => {
    provider = await makeProvider([vs(URL1, '20240101'), vs(URL1, '20250601', { status: 'bogus' })]);
    // the latest is rejected, so the url gets the version before it
    expect((await provider.fetchValueSet(URL1)).version).toBe('20240101');
    expect((await provider.fetchValueSet(URL1, '20250601')).version).toBe('20240101');
    expect(await provider.fetchValueSetById('vsac-2.16.840.1.113883.3.1-20250601')).toBeNull();
    // search finds both rows; the rejected one reads as null, so the search worker drops it
    const found = await provider.searchValueSets([{ name: 'url', value: URL1 }]);
    const loaded = await Promise.all(found.map(m => m.load()));
    expect(loaded.filter(v => v).map(v => v.version)).toEqual(['20240101']);
  });

  test('search returns matches with the sort fields, and a load() that reads the value set as fetchValueSet prepares it', async () => {
    provider = await makeProvider([vs(URL1, '20240101'), vs(URL1, '20250601'), vs(URL2, '20200101')]);
    const byUrl = await provider.searchValueSets([{ name: 'url', value: URL1 }]);
    expect(byUrl.map(v => v.id).sort()).toEqual(['vsac-2.16.840.1.113883.3.1-20240101', 'vsac-2.16.840.1.113883.3.1-20250601']);
    for (const m of byUrl) {
      expect(Object.keys(m).sort()).toEqual(['date', 'id', 'name', 'resourceType', 'url', 'version'].filter(k => k !== 'date'));
      expect(JSON.stringify(m)).not.toContain('compose'); // nothing read yet, and load() isn't serialised
      const json = await m.load();
      expect(json.id).toBe(m.id);
      expect(json.version).toBe(m.version);
      expect(json.compose.include[0].version).toBeUndefined();
    }
    const byVersion = await provider.searchValueSets([{ name: 'url', value: URL1 }, { name: 'version', value: '20240101' }]);
    expect(byVersion.map(v => v.id)).toEqual(['vsac-2.16.840.1.113883.3.1-20240101']);
    expect((await provider.searchValueSets([{ name: 'title', value: '113883.3.2' }])).map(v => v.version)).toEqual(['20200101']);
    expect(await provider.searchValueSets([{ name: 'url', value: 'http://nothing' }])).toEqual([]);
    // _elements of indexed columns only: built from the columns, no content read
    const columns = await provider.searchValueSets([{ name: 'url', value: URL2 }], ['url', 'version']);
    expect(columns).toEqual([{ resourceType: 'ValueSet', id: 'vsac-2.16.840.1.113883.3.2-20200101', url: URL2, version: '20200101' }]);
  });

  test('counts come from the database', async () => {
    provider = await makeProvider([vs(URL1, '20240101'), vs(URL1, '20250601'), vs(URL2, '20200101')]);
    expect(provider.count()).toBe(3);
    expect(provider.getMapSize()).toBe(2);
    expect(await provider.listAllValueSets()).toEqual([URL1, URL1, URL2]);
  });

  test('a scan of all value sets visits the latest version of each url once per stored version, as listAllValueSets + fetchValueSet did', async () => {
    provider = await makeProvider([vs(URL1, '20240101'), vs(URL1, '20250601'), vs(URL1, '20230101', { status: 'bogus' }), vs(URL2, '20200101')]);
    const viaFetch = [];
    for (const url of await provider.listAllValueSets()) {
      const v = await provider.fetchValueSet(url);
      viaFetch.push(v.id);
    }
    const viaScan = [];
    await provider.scanAllValueSets(async (v) => {
      expect(v.jsonObj.compose.include[0].version).toBeUndefined();
      viaScan.push(v.id);
    });
    expect(viaScan.sort()).toEqual(viaFetch.sort());
    expect(viaScan).toEqual(['vsac-2.16.840.1.113883.3.1-20250601', 'vsac-2.16.840.1.113883.3.1-20250601', 'vsac-2.16.840.1.113883.3.1-20250601', 'vsac-2.16.840.1.113883.3.2-20200101']);
  });

  test('a scan falls back to the version before a rejected latest one', async () => {
    provider = await makeProvider([vs(URL1, '20240101'), vs(URL1, '20250601', { status: 'bogus' })]);
    const seen = [];
    await provider.scanAllValueSets(async (v) => { seen.push(v.version); });
    expect(seen).toEqual(['20240101', '20240101']);
  });

  test('a sync compares against the stored hashes: unchanged is only touched, changed is updated, unknown is new', async () => {
    const v1 = vs(URL1, '20240101');
    provider = await makeProvider([v1]);
    const changed = { ...v1, title: 'New title' };
    const result = await provider.batchUpsertValueSets([v1, changed, vs(URL2, '20200101')]);
    // v1 is unchanged, then the same url|version comes again with new content
    expect(result).toEqual({ newCount: 1, updatedCount: 1 });
    expect(events).toEqual([`updated ${URL1}|20240101`, `new ${URL2}|20200101`]);
    expect((await provider.fetchValueSet(URL1)).jsonObj.title).toBe('New title');
    await provider._recount();
    expect(provider.count()).toBe(2);
  });

  test('a refresh only fetches the history of value sets whose url|version is not in the database', async () => {
    provider = await makeProvider([vs(URL1, '20240101')]);
    provider.database.getSetting = async () => '2026-01-01T00:00:00Z';
    provider.database.setSetting = async () => {};
    const fetched = [];
    provider._fetchBundle = async (url) => {
      fetched.push(url);
      if (url.startsWith('/ValueSet?_offset')) {
        return { resourceType: 'Bundle', total: 2, entry: [{ resource: { url: URL1, version: '20240101' } }, { resource: { url: URL2, version: '20200101' } }] };
      }
      if (url.startsWith('/res/ValueSet')) {
        return { resourceType: 'Bundle', entry: [] };
      }
      return { resourceType: 'Bundle', entry: [{ resource: vs(URL2, '20200101') }] };
    };
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await provider.refreshValueSets();
    } finally {
      log.mockRestore();
    }
    expect(fetched.filter(u => u.startsWith('/ValueSet?url='))).toEqual([`/ValueSet?url=${URL2}`]);
    expect(provider.count()).toBe(2);
    expect((await provider.fetchValueSet(URL2)).version).toBe('20200101');
  });
});

describe('VSAC recently used value sets', () => {
  let dbPath;
  let provider;
  let loads;

  async function makeProvider(valueSets, cacheBytes) {
    dbPath = path.join(folders.ensureFolder('vsac-on-demand-test'), `vsac-mru-${process.pid}-${Date.now()}.db`);
    const database = new ValueSetDatabase(dbPath);
    await database.create();
    for (const v of valueSets) {
      await database.upsertValueSet(v, require('crypto').createHash('sha256').update(JSON.stringify(v)).digest('hex'));
    }
    const p = Object.create(VSACValueSetProvider.prototype);
    p.database = database;
    p.stats = { addTask() {}, task() {}, taskDone() {}, taskError() {} };
    p.initialized = true;
    if (cacheBytes !== undefined) {
      p.valueSetCacheMB = cacheBytes / (1024 * 1024);
    }
    await p._recount();
    p.assignIds('vsac');
    // count the reads (each one parses the stored JSON)
    loads = [];
    const loadValueSet = database.loadValueSet.bind(database);
    database.loadValueSet = async (id, source) => { loads.push(id); return loadValueSet(id, source); };
    return p;
  }

  // anything that writes to a frozen object in strict code (class bodies are) throws
  function deepFreeze(o) {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      Object.freeze(o);
      for (const v of Object.values(o)) deepFreeze(v);
    }
    return o;
  }

  function storedLength(v) {
    return JSON.stringify(v).length;
  }

  afterEach(async () => {
    if (provider) {
      await provider.close();
      provider = null;
    }
    for (const f of [dbPath, dbPath + '-journal']) {
      if (f && fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  test('repeated fetches, by url or by id, read and parse the value set once', async () => {
    provider = await makeProvider([vs(URL1, '20240101'), vs(URL1, '20250601')]);
    const first = await provider.fetchValueSet(URL1);
    expect(await provider.fetchValueSet(URL1)).toBe(first);
    expect(await provider.fetchValueSet(URL1, '20250601')).toBe(first);
    expect(await provider.fetchValueSetById('vsac-2.16.840.1.113883.3.1-20250601')).toBe(first);
    expect(loads).toEqual(['2.16.840.1.113883.3.1-20250601']);
    // another version is another row
    expect((await provider.fetchValueSet(URL1, '20240101')).version).toBe('20240101');
    expect(loads.length).toBe(2);
  });

  test('what is kept is shared between requests, and nothing the provider does writes to it', async () => {
    provider = await makeProvider([vs(URL1, '20240101'), vs(URL1, '20250601'), vs(URL2, '20200101')]);
    const kept = deepFreeze(await provider.fetchValueSet(URL1));
    expect(await provider.fetchValueSet(URL1)).toBe(kept);
    expect(await provider.fetchValueSetById(kept.id)).toBe(kept);
    const found = await provider.searchValueSets([{ name: 'url', value: URL1 }]);
    const loaded = await Promise.all(found.map(m => m.load()));
    expect(loaded).toContain(kept.jsonObj);
    await provider.scanAllValueSets(async () => {});
    expect(() => { 'use strict'; kept.jsonObj.title = 'changed'; }).toThrow(TypeError); // it is frozen
  });

  test('a row the sync updates is dropped, and the next fetch reads the new content', async () => {
    const v1 = vs(URL1, '20240101');
    provider = await makeProvider([v1, vs(URL2, '20200101')]);
    expect((await provider.fetchValueSet(URL1)).jsonObj.title).toBe('Test 2.16.840.1.113883.3.1 20240101');
    const other = await provider.fetchValueSet(URL2);
    // unchanged: still kept
    await provider.batchUpsertValueSets([v1]);
    expect((await provider.fetchValueSet(URL1)).jsonObj.title).toBe('Test 2.16.840.1.113883.3.1 20240101');
    expect(loads.length).toBe(2);
    await provider.batchUpsertValueSets([{ ...v1, title: 'New title' }]);
    const after = await provider.fetchValueSet(URL1);
    expect(after.jsonObj.title).toBe('New title');
    expect(after.contentHash).toBe((await provider.database.getVersion(URL1, '20240101')).content_hash);
    expect(loads.length).toBe(3);
    // the other one is still kept
    expect(await provider.fetchValueSet(URL2)).toBe(other);
    expect(loads.length).toBe(3);
  });

  test('a read that was under way when the sync dropped a row is not kept', async () => {
    provider = await makeProvider([vs(URL1, '20240101')]);
    const loadValueSet = provider.database.loadValueSet;
    provider.database.loadValueSet = async (id, source) => {
      const vs = await loadValueSet(id, source);
      provider._recentValueSets().delete(id); // as if the sync wrote the row meanwhile
      return vs;
    };
    await provider.fetchValueSet(URL1);
    provider.database.loadValueSet = loadValueSet;
    await provider.fetchValueSet(URL1);
    await provider.fetchValueSet(URL1);
    expect(loads.length).toBe(2);
  });

  test('once the stored JSON kept is over the limit, the least recently used is dropped', async () => {
    const urls = [URL1, URL2, 'http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1.113883.3.3'];
    const sets = urls.map(u => vs(u, '20240101'));
    // room for two
    provider = await makeProvider(sets, storedLength(sets[0]) * 2 + 10);
    const a = await provider.fetchValueSet(urls[0]);
    await provider.fetchValueSet(urls[1]);
    expect(await provider.fetchValueSet(urls[0])).toBe(a); // urls[0] is now the most recently used
    await provider.fetchValueSet(urls[2]); // so urls[1] is dropped
    expect(provider._recentValueSets().size).toBe(2);
    expect(await provider.fetchValueSet(urls[0])).toBe(a);
    expect(loads.length).toBe(3);
    await provider.fetchValueSet(urls[1]);
    expect(loads.length).toBe(4);
  });

  test('a value set bigger than the limit is not kept; a limit of 0 keeps none', async () => {
    const v = vs(URL1, '20240101');
    provider = await makeProvider([v], storedLength(v) - 1);
    await provider.fetchValueSet(URL1);
    await provider.fetchValueSet(URL1);
    expect(loads.length).toBe(2);
    await provider.close();
    provider = await makeProvider([v], 0);
    await provider.fetchValueSet(URL1);
    await provider.fetchValueSet(URL1);
    expect(loads.length).toBe(2);
  });

  test('a search reads the matches on its page without keeping them, or pushing out what is kept', async () => {
    const urls = [URL1, URL2, 'http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1.113883.3.3'];
    const sets = urls.map(u => vs(u, '20240101'));
    provider = await makeProvider(sets, storedLength(sets[0]) + 10);
    const hot = await provider.fetchValueSet(URL1);
    const found = await provider.searchValueSets([{ name: 'publisher', value: 'Test Publisher' }]);
    expect(found.length).toBe(3);
    const loaded = await Promise.all(found.map(m => m.load()));
    expect(loaded).toContain(hot.jsonObj); // the kept one is used
    expect(loads.length).toBe(3); // the other two are read
    expect(provider._recentValueSets().size).toBe(1);
    expect(await provider.fetchValueSet(URL1)).toBe(hot);
  });

  test('a full sync, an operator resync, a new database and close() each start again', async () => {
    provider = await makeProvider([vs(URL1, '20240101'), vs(URL2, '20200101')]);
    await provider.fetchValueSet(URL1);
    await provider.fetchValueSet(URL2);
    expect(provider._recentValueSets().size).toBe(2);

    // operator resync of one url: only that url's rows are dropped
    provider._fetchBundle = async () => ({ resourceType: 'Bundle', entry: [{ resource: vs(URL1, '20240101') }] });
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await provider.resyncValueSet(URL1);
      expect(provider._recentValueSets().size).toBe(1);
      expect(provider._recentValueSets().peek('2.16.840.1.113883.3.2-20200101')).toBeDefined();

      // full sync with nothing new
      await provider.fetchValueSet(URL1);
      provider.database.getSetting = async () => '2026-01-01T00:00:00Z';
      provider.database.setSetting = async () => {};
      provider._fetchBundle = async (url) => url.startsWith('/ValueSet?_offset')
        ? { resourceType: 'Bundle', total: 2, entry: [{ resource: { url: URL1, version: '20240101' } }, { resource: { url: URL2, version: '20200101' } }] }
        : { resourceType: 'Bundle', entry: [] };
      await provider.refreshValueSets();
      expect(provider._recentValueSets().size).toBe(0);
    } finally {
      log.mockRestore();
    }

    await provider.fetchValueSet(URL1);
    const database = provider.database;
    provider.database = new ValueSetDatabase(dbPath);
    expect(provider._recentValueSets().size).toBe(0);
    await database.close();

    await provider.fetchValueSet(URL1);
    expect(provider._recentValueSets().size).toBe(1);
    await provider.close();
    expect(provider._recentValueSets().size).toBe(0);
    provider = null;
  });

  test('which version a url (and version) gets is as it was: exact, then major.minor, then the latest - kept or not', async () => {
    const SV = 'http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1.113883.3.9';
    provider = await makeProvider([vs(SV, '1.1.0'), vs(SV, '2.0.0'), vs(SV, '1.1.2'), vs(SV, '1.0.0')]);
    const asked = [['1.1.0', '1.1.0'], ['1.1.5', '1.1.2'], ['1.0.7', '1.0.0'], ['3.0.0', '2.0.0'], [undefined, '2.0.0'], ['1.1.2', '1.1.2']];
    for (let pass = 0; pass < 2; pass++) {
      for (const [version, expected] of asked) {
        expect((await provider.fetchValueSet(SV, version)).version).toBe(expected);
      }
    }
    // the second pass was all kept
    expect(loads.length).toBe(4);
  });
});

describe('VSAC startup sync', () => {
  const dir = folders.ensureFolder('vsac-on-demand-test');

  async function initialized(dbPath) {
    const p = Object.create(VSACValueSetProvider.prototype);
    p.database = new ValueSetDatabase(dbPath);
    p.stats = { addTask() {}, task() {}, taskDone() {}, taskError() {} };
    p.refreshIntervalHours = 24;
    p.initialized = false;
    p.SYNC_AT_START_UP = false;
    p.syncs = 0;
    p.refreshValueSets = async () => { p.syncs++; };
    p._startRefreshTimer = () => {};
    await p.initialize();
    return p;
  }

  test('a new database is synced at startup, not at the first timer', async () => {
    const dbPath = path.join(dir, `vsac-new-${process.pid}-${Date.now()}.db`);
    const p = await initialized(dbPath);
    try {
      expect(p.syncs).toBe(1);
    } finally {
      await p.close();
      for (const f of [dbPath, dbPath + '-journal']) if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  test('a database that has value sets is not synced at startup', async () => {
    const dbPath = path.join(dir, `vsac-full-${process.pid}-${Date.now()}.db`);
    const database = new ValueSetDatabase(dbPath);
    await database.create();
    const v = vs(URL1, '20240101');
    await database.upsertValueSet(v, require('crypto').createHash('sha256').update(JSON.stringify(v)).digest('hex'));
    await database.close();
    const p = await initialized(dbPath);
    try {
      expect(p.syncs).toBe(0);
    } finally {
      await p.close();
      for (const f of [dbPath, dbPath + '-journal']) if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });
});
