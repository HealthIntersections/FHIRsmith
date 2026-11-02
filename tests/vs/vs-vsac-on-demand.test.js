// The VSAC provider doesn't hold its value sets in memory: it reads each one from its database
// when it is asked for. These check that what it serves is what it served when it loaded them
// all into a map at startup - the same version picked for a url, the same changes made to the
// stored value set (no code system versions in the compose, an id in the provider's id space),
// the same value sets rejected - and that a refresh compares against the database.

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
    // each request reads its own copy: changing one doesn't change what the next one gets,
    // and the stored content (which a refresh hashes) is untouched
    v.jsonObj.title = 'changed';
    expect((await provider.fetchValueSet(URL1)).jsonObj.title).toBe('Test 2.16.840.1.113883.3.1 20250601');
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
    const found = await provider.searchValueSets([{ name: 'url', value: URL1 }]);
    expect(found.map(v => v.version)).toEqual(['20240101']);
  });

  test('search reads the matching value sets, prepared as fetchValueSet prepares them', async () => {
    provider = await makeProvider([vs(URL1, '20240101'), vs(URL1, '20250601'), vs(URL2, '20200101')]);
    const byUrl = await provider.searchValueSets([{ name: 'url', value: URL1 }]);
    expect(byUrl.map(v => v.id).sort()).toEqual(['vsac-2.16.840.1.113883.3.1-20240101', 'vsac-2.16.840.1.113883.3.1-20250601']);
    for (const v of byUrl) {
      expect(v.jsonObj.compose.include[0].version).toBeUndefined();
      expect(v.sourcePackage).toBe('vsac');
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
