const { Provider } = require('../../tx/provider');

/**
 * addCodeSystem/deleteCodeSystem maintain a Map keyed by both the unversioned
 * url ([url] -> most-recent version) and the versioned url ([url|version] -> that
 * version). deleteCodeSystem previously re-inserted the *deleted* CodeSystem
 * under its url (and scanned all urls, not just the same one), so a delete
 * reverted itself for the unversioned lookup whenever any other system existed.
 */

function cs(url, version) {
  return {
    url,
    version,
    vurl: version ? `${url}|${version}` : url,
    // integer-style "more recent"
    isMoreRecent(other) { return Number(this.version) > Number(other.version); }
  };
}

function newProvider(...systems) {
  const p = Object.create(Provider.prototype);
  p.codeSystems = new Map();
  for (const s of systems) p.addCodeSystem(s);
  return p;
}

describe('Provider.deleteCodeSystem', () => {
  test('deleting the only version removes both the url and vurl entries', () => {
    const p = newProvider(cs('http://a', '1'));
    p.deleteCodeSystem(cs('http://a', '1'));
    expect(p.codeSystems.has('http://a')).toBe(false);
    expect(p.codeSystems.has('http://a|1')).toBe(false);
    expect(p.codeSystems.size).toBe(0);
  });

  test('deleting does not revert itself when another (different) code system exists', () => {
    const p = newProvider(cs('http://a', '1'), cs('http://b', '1'));
    p.deleteCodeSystem(cs('http://a', '1'));
    // a must be gone; b untouched
    expect(p.codeSystems.has('http://a')).toBe(false);
    expect(p.codeSystems.has('http://a|1')).toBe(false);
    expect(p.codeSystems.get('http://b')).toMatchObject({ url: 'http://b' });
  });

  test('deleting the current default promotes the most-recent surviving same-url version', () => {
    const p = newProvider(cs('http://a', '1'), cs('http://a', '2'), cs('http://a', '3'));
    // default [a] currently points at v3
    expect(p.codeSystems.get('http://a').version).toBe('3');

    p.deleteCodeSystem(cs('http://a', '3'));

    expect(p.codeSystems.has('http://a|3')).toBe(false);
    // [a] promoted to the most recent survivor (v2)
    expect(p.codeSystems.get('http://a').version).toBe('2');
    // older version still individually addressable
    expect(p.codeSystems.get('http://a|1').version).toBe('1');
  });

  test('deleting a non-default version leaves the default in place and removes that version', () => {
    const p = newProvider(cs('http://a', '1'), cs('http://a', '2'));
    p.deleteCodeSystem(cs('http://a', '1'));
    expect(p.codeSystems.has('http://a|1')).toBe(false);
    expect(p.codeSystems.get('http://a').version).toBe('2');
    expect(p.codeSystems.get('http://a|2').version).toBe('2');
  });

  test('the unversioned default is never re-pointed at a different-url system', () => {
    const p = newProvider(cs('http://a', '1'), cs('http://b', '5'));
    p.deleteCodeSystem(cs('http://a', '1'));
    // [a] must not exist, and certainly must not resolve to b
    expect(p.codeSystems.get('http://a')).toBeUndefined();
  });
});
