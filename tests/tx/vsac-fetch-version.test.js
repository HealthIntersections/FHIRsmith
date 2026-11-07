const { VSACValueSetProvider } = require('../../tx/vs/vs-vsac');
const { ValueSetDatabase } = require('../../tx/vs/vs-database');

/**
 * A VSAC value set asked for at a version VSAC doesn't have is not found - the same rule as for
 * value sets from packages - unless VERSION_FALLBACK_TO_LATEST is set (the old behaviour).
 */

const URL = 'http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1.113883.3.464.1003.103.12.1001';

function provider() {
  const p = Object.create(VSACValueSetProvider.prototype);
  p.initialized = true;
  const v1 = { url: URL, version: '20230101' };
  const v2 = { url: URL, version: '20240101' };
  // the rows in the database, which the provider reads a value set from when asked for it
  const rows = { 'r1': v1, 'r2': v2 };
  const database = Object.create(ValueSetDatabase.prototype);
  database.listVersions = async url => Object.entries(rows).filter(([, v]) => v.url === url)
    .map(([id, v]) => ({ id, url: v.url, version: v.version }));
  p.database = database;
  p._readValueSet = async id => rows[id] || null;
  return { p, v1, v2 };
}

describe('VSAC fetchValueSet and versions', () => {
  afterEach(() => {
    VSACValueSetProvider.VERSION_FALLBACK_TO_LATEST = false;
  });

  test('a version it has', async () => {
    const { p, v1 } = provider();
    expect(await p.fetchValueSet(URL, '20230101')).toBe(v1);
  });

  test('no version: the latest', async () => {
    const { p, v2 } = provider();
    expect(await p.fetchValueSet(URL, '')).toBe(v2);
    expect(await p.fetchValueSet(URL, null)).toBe(v2);
  });

  test('a version it does not have: not found', async () => {
    const { p } = provider();
    expect(await p.fetchValueSet(URL, '19990101')).toBeNull();
  });

  test('VERSION_FALLBACK_TO_LATEST restores the old answer: the latest', async () => {
    VSACValueSetProvider.VERSION_FALLBACK_TO_LATEST = true;
    const { p, v2 } = provider();
    expect(await p.fetchValueSet(URL, '19990101')).toBe(v2);
  });

  test('an unknown url is not found either way', async () => {
    const { p } = provider();
    expect(await p.fetchValueSet('http://cts.nlm.nih.gov/fhir/ValueSet/1.2.3', '19990101')).toBeNull();
    expect(await p.fetchValueSet('http://cts.nlm.nih.gov/fhir/ValueSet/1.2.3', '')).toBeNull();
  });
});
