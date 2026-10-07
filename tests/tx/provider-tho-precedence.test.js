const { Provider } = require('../../tx/provider');

/**
 * Mirrors the special-case logic in CanonicalResourceManager.see() in the Java
 * core: when content was moved from the FHIR core packages to
 * terminology.hl7.org (THO/UTG), the resource versions went backwards (e.g.
 * http://terminology.hl7.org/CodeSystem/coverage-selfpay is 4.0.1 in
 * hl7.fhir.r4.core (2019) but 1.0.1 in hl7.terminology (2024)), and THO's copy
 * has had a lot of QA work since. So a THO resource replaces every same-URL
 * resource from a core package, whatever its version - except the R4 v2 tables
 * 0006/0360/0391, which R4 core has in two versions each with the version in the
 * url (urlHadVersion). THO doesn't publish those versions, so they stay
 * addressable by url|version, and THO's copy is the default.
 */

const SELFPAY = 'http://terminology.hl7.org/CodeSystem/coverage-selfpay';

function cs(url, version, sourcePackage, urlHadVersion) {
  return {
    url,
    version,
    sourcePackage,
    urlHadVersion,
    vurl: version ? `${url}|${version}` : url,
    // string-compare "more recent" — fine for the versions used here
    isMoreRecent(other) { return String(this.version) > String(other.version); }
  };
}

function newProvider(...systems) {
  const p = Object.create(Provider.prototype);
  p.codeSystems = new Map();
  for (const s of systems) p.addCodeSystem(s);
  return p;
}

describe('Provider.addCodeSystem — THO vs core package precedence', () => {
  test('THO resource replaces an older-versioned core resource with the same url (coverage-selfpay case)', () => {
    const p = newProvider(
      cs(SELFPAY, '4.0.1', 'hl7.fhir.r4.core#4.0.1'),
      cs(SELFPAY, '1.0.1', 'hl7.terminology.r4#6.0.2')
    );
    // the unversioned default must be the THO copy despite its lower version
    expect(p.codeSystems.get(SELFPAY).sourcePackage).toBe('hl7.terminology.r4#6.0.2');
    expect(p.codeSystems.get(SELFPAY).version).toBe('1.0.1');
    // and the core copy is gone - it isn't available by version either
    expect(p.codeSystems.has(SELFPAY + '|4.0.1')).toBe(false);
    expect(p.codeSystems.get(SELFPAY + '|1.0.1').sourcePackage).toBe('hl7.terminology.r4#6.0.2');
  });

  test('a core resource is not added when THO already has the url (reverse load order)', () => {
    const p = newProvider(
      cs(SELFPAY, '1.0.1', 'hl7.terminology.r4#6.0.2'),
      cs(SELFPAY, '4.0.1', 'hl7.fhir.r4.core#4.0.1')
    );
    expect(p.codeSystems.get(SELFPAY).sourcePackage).toBe('hl7.terminology.r4#6.0.2');
    expect(p.codeSystems.has(SELFPAY + '|4.0.1')).toBe(false);
  });

  test('a core resource that had its version in its url stays available by version, in either load order', () => {
    const V2 = 'http://terminology.hl7.org/CodeSystem/v2-0006';
    for (const order of ['core first', 'THO first']) {
      const core21 = cs(V2, '2.1', 'hl7.fhir.r4.core#4.0.1', true);
      const core24 = cs(V2, '2.4', 'hl7.fhir.r4.core#4.0.1', true);
      const tho = cs(V2, '3.0.0', 'hl7.terminology.r4#6.0.2');
      const p = order === 'core first' ? newProvider(core21, core24, tho) : newProvider(tho, core21, core24);
      expect(p.codeSystems.get(V2)).toBe(tho);
      expect(p.codeSystems.get(V2 + '|2.1')).toBe(core21);
      expect(p.codeSystems.get(V2 + '|2.4')).toBe(core24);
      expect(p.codeSystems.get(V2 + '|3.0.0')).toBe(tho);
    }
  });

  test('THO does not displace same-url resources from non-core packages', () => {
    const p = newProvider(
      cs('http://a', '2.0.0', 'some.other.package#1.0.0'),
      cs('http://a', '1.0.0', 'hl7.terminology.r4#6.0.2')
    );
    // normal version precedence applies: 2.0.0 stays the default
    expect(p.codeSystems.get('http://a').version).toBe('2.0.0');
    expect(p.codeSystems.has('http://a|2.0.0')).toBe(true);
    expect(p.codeSystems.has('http://a|1.0.0')).toBe(true);
  });

  test('normal version precedence is unaffected when THO is not involved', () => {
    const p = newProvider(
      cs('http://b', '2', 'pkg.one#1.0.0'),
      cs('http://b', '1', 'pkg.two#1.0.0')
    );
    expect(p.codeSystems.get('http://b').version).toBe('2');
  });

  test('THO only displaces core resources with the same url', () => {
    const p = newProvider(
      cs('http://other', '4.0.1', 'hl7.fhir.r4.core#4.0.1'),
      cs(SELFPAY, '1.0.1', 'hl7.terminology.r4#6.0.2')
    );
    expect(p.codeSystems.get('http://other').version).toBe('4.0.1');
    expect(p.codeSystems.has('http://other|4.0.1')).toBe(true);
  });

  test('resources with no sourcePackage fall back to plain version precedence', () => {
    const p = newProvider(
      cs('http://c', '1', undefined),
      cs('http://c', '2', undefined)
    );
    expect(p.codeSystems.get('http://c').version).toBe('2');
  });
});
