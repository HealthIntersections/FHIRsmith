const { ListCodeSystemProvider } = require('../../tx/cs/cs-provider-list');

/**
 * ListCodeSystemProvider.codeSystems is an ARRAY (despite the field's
 * "Map<String, CodeSystem>" doc comment). Loaders must append with .push().
 * library.js#loadUrl previously called .set() on it (copied from loadNpm but
 * rewritten Map-style), which threw because arrays have no .set — so any
 * `url:`/`url/cs:` package source failed to load. These tests lock the contract.
 */

describe('ListCodeSystemProvider.codeSystems contract', () => {
  test('is an array, initially empty', () => {
    const cp = new ListCodeSystemProvider();
    expect(Array.isArray(cp.codeSystems)).toBe(true);
    expect(cp.codeSystems).toHaveLength(0);
  });

  test('has no .set method (loaders must use .push)', () => {
    const cp = new ListCodeSystemProvider();
    expect(cp.codeSystems.set).toBeUndefined();
    expect(typeof cp.codeSystems.push).toBe('function');
  });

  test('pushed code systems are returned by listCodeSystems', async () => {
    const cp = new ListCodeSystemProvider();
    cp.codeSystems.push({ url: 'http://a', vurl: 'http://a|1', id: 'a' });
    cp.codeSystems.push({ url: 'http://b', vurl: 'http://b|1', id: 'b' });
    const list = await cp.listCodeSystems('R5', null);
    expect(list).toHaveLength(2);
    expect(list.map(c => c.url)).toEqual(['http://a', 'http://b']);
  });

  test('assignIds prefixes every id with the spaceId', () => {
    const cp = new ListCodeSystemProvider();
    cp.codeSystems.push({ url: 'http://a', jsonObj: { id: 'a' } });
    cp.codeSystems.push({ url: 'http://b', jsonObj: {} });   // no id: gets its position
    cp.assignIds('tho');
    expect(cp.spaceId).toBe('tho');
    expect(cp.codeSystems.map(c => c.jsonObj.id)).toEqual(['tho-a', 'tho-2']);
    // the same space again does nothing
    cp.assignIds('tho');
    expect(cp.codeSystems.map(c => c.jsonObj.id)).toEqual(['tho-a', 'tho-2']);
    // a different one is an error
    expect(() => cp.assignIds('us')).toThrow(/already in the id space 'tho'/);
  });
});
