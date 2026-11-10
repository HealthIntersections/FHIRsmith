/**
 * THO precedence asks THO's providers the way a reference asks them (fetchValueSet /
 * fetchConceptMap), instead of reading PackageValueSetProvider's valueSetMap. For the package
 * providers the core package keeps exactly the keys it kept when the THO maps were read; a THO
 * provider that keeps no map takes part with no further method.
 */
const { Provider } = require('../../tx/provider');
const { PackageValueSetProvider } = require('../../tx/vs/vs-package');
const { AbstractValueSetProvider } = require('../../tx/vs/vs-api');
const { PackageConceptMapProvider } = require('../../tx/cm/cm-package');
const { AbstractConceptMapProvider } = require('../../tx/cm/cm-api');
const { keepForPinnedReference, thoVersionsOf } = require('../../tx/library/tho-precedence');
const { VersionUtilities } = require('../../library/version-utilities');

const URL_A = 'http://terminology.hl7.org/ValueSet/a';
const URL_B = 'http://terminology.hl7.org/ValueSet/b';
const URL_C = 'http://terminology.hl7.org/ValueSet/c';

/** the keys PackageValueSetProvider's map has for these resources: id, url, url|version, url|major.minor */
function mapOf(resources) {
  const m = new Map();
  for (const r of resources) {
    m.set(r.id, r);
    m.set(r.url, r);
    if (r.version) {
      m.set(r.url + '|' + r.version, r);
      if (VersionUtilities.isSemVer(r.version)) {
        m.set(r.url + '|' + VersionUtilities.getMajMin(r.version), r);
      }
    }
  }
  return m;
}

function vsProvider(pid, valueSets) {
  const p = Object.create(PackageValueSetProvider.prototype);
  p.sourcePackageCode = pid;
  p.initialized = true;
  p.valueSetMap = mapOf(valueSets);
  p.keepPinnedOnly = jest.fn();
  return p;
}

function cmProvider(pid, conceptMaps) {
  const p = Object.create(PackageConceptMapProvider.prototype);
  p.packageLoader = { id: () => pid };
  p.initialized = true;
  p.conceptMapMap = mapOf(conceptMaps);
  p.keepPinnedOnly = jest.fn();
  return p;
}

/** what provider.js read before: every version of every resource in the THO packages' maps */
function oldThoVersions(providers, field) {
  const map = new Map();
  for (const p of providers) {
    if (p.sourcePackage().startsWith('hl7.terminology')) {
      for (const r of p[field].values()) {
        if (!map.has(r.url)) {
          map.set(r.url, new Set());
        }
        if (r.version) {
          map.get(r.url).add(r.version);
        }
      }
    }
  }
  return map;
}

/** the core map keys kept for pinned references, as keepPinnedOnly decides them */
function keptKeys(coreProvider, field, thoVersions) {
  const kept = [];
  for (const [key, r] of coreProvider[field]) {
    if (!thoVersions.has(r.url) || keepForPinnedReference(key, r, thoVersions.get(r.url))) {
      kept.push(key);
    }
  }
  return kept.sort();
}

function endpoint(valueSetProviders, conceptMapProviders = []) {
  const p = Object.create(Provider.prototype);
  p.valueSetProviders = valueSetProviders;
  p.conceptMapProviders = conceptMapProviders;
  return p;
}

const thoValueSets = [
  { id: 'a', url: URL_A, version: '1.0.0' }, { id: 'a4', url: URL_A, version: '4.0.9' },
  { id: 'b', url: URL_B }, { id: 'c', url: URL_C, version: '4.0.1' }
];
const coreValueSets = [
  { id: 'a', url: URL_A, version: '4.0.1' }, { id: 'b', url: URL_B, version: '4.0.1' },
  { id: 'c', url: URL_C, version: '4.0.1' }, { id: 'x', url: 'http://hl7.org/fhir/ValueSet/x', version: '4.0.1' }
];

describe('THO precedence asks THO providers with fetchValueSet', () => {
  test('the core package keeps the same map keys as when THO\'s maps were read', async () => {
    const tho = vsProvider('hl7.terminology.r4#6.0.2', thoValueSets);
    const core = vsProvider('hl7.fhir.r4.core#4.0.1', coreValueSets);
    const other = vsProvider('hl7.fhir.us.core#6.1.0', [{ id: 'a', url: URL_A, version: '9.9.9' }]);
    await endpoint([core, tho, other]).applyTHOPrecedence();
    expect(core.keepPinnedOnly).toHaveBeenCalledTimes(1);
    expect(tho.keepPinnedOnly).not.toHaveBeenCalled();
    expect(other.keepPinnedOnly).not.toHaveBeenCalled();
    const asked = core.keepPinnedOnly.mock.calls[0][0];
    const old = oldThoVersions([core, tho, other], 'valueSetMap');
    // only the core urls THO has, and enough of THO's versions to decide each key as before
    expect([...asked.keys()].sort()).toEqual([URL_A, URL_B, URL_C]);
    expect(keptKeys(core, 'valueSetMap', asked)).toEqual(keptKeys(core, 'valueSetMap', old));
    // URL_A|4.0 stays out (THO has 4.0.9), URL_A|4.0.1 stays in; URL_C|4.0.1 is THO's own version
    expect(keptKeys(core, 'valueSetMap', asked)).toEqual(['URL_A|4.0.1', 'URL_B|4.0', 'URL_B|4.0.1', 'http://hl7.org/fhir/ValueSet/x', 'http://hl7.org/fhir/ValueSet/x|4.0', 'http://hl7.org/fhir/ValueSet/x|4.0.1', 'x'].map(k => k.replace('URL_A', URL_A).replace('URL_B', URL_B)).sort());
  });

  test('a THO provider that keeps no map takes part through fetchValueSet alone', async () => {
    class RowsProvider extends AbstractValueSetProvider {
      sourcePackage() { return 'hl7.terminology.r4#6.0.2'; }
      async fetchValueSet(url, version) {
        // stands in for a database: the rows, chosen as PackageValueSetProvider would
        const m = mapOf(thoValueSets);
        return m.get(version ? url + '|' + version : url)
          || (version && VersionUtilities.isSemVer(version) ? m.get(url + '|' + VersionUtilities.getMajMin(version)) : null) || null;
      }
    }
    const core = vsProvider('hl7.fhir.r4.core#4.0.1', coreValueSets);
    const reference = vsProvider('hl7.fhir.r4.core#4.0.1', coreValueSets);
    await endpoint([core, new RowsProvider()]).applyTHOPrecedence();
    await endpoint([reference, vsProvider('hl7.terminology.r4#6.0.2', thoValueSets)]).applyTHOPrecedence();
    expect(keptKeys(core, 'valueSetMap', core.keepPinnedOnly.mock.calls[0][0]))
      .toEqual(keptKeys(reference, 'valueSetMap', reference.keepPinnedOnly.mock.calls[0][0]));
  });

  test('with no THO package, the core package keeps everything', async () => {
    const core = vsProvider('hl7.fhir.r4.core#4.0.1', coreValueSets);
    await endpoint([core, new AbstractValueSetProvider()]).applyTHOPrecedence();
    expect(core.keepPinnedOnly.mock.calls[0][0].size).toBe(0);
  });

  test('thoVersionsOf asks each url once with no version, and with the core version only where THO has the url', async () => {
    const fetch = jest.fn(async (p, url, version) => (url === URL_A ? { url, version: version || '1.0.0' } : null));
    const map = await thoVersionsOf([{ url: URL_A, version: '4.0.1' }, { url: URL_A, version: '4.0.1' }, { url: URL_B, version: '4.0.1' }], [{}], fetch);
    expect(fetch.mock.calls.map(c => c.slice(1))).toEqual([[URL_A], [URL_A, '4.0.1'], [URL_B]]);
    expect(map).toEqual(new Map([[URL_A, new Set(['1.0.0', '4.0.1'])]]));
  });
});

describe('THO precedence for concept maps, the same way (fetchConceptMap)', () => {
  const CM_A = 'http://terminology.hl7.org/ConceptMap/a';
  test('the core package keeps the same map keys as when THO\'s maps were read', async () => {
    const tho = cmProvider('hl7.terminology.r4#6.0.2', [{ id: 'a', url: CM_A, version: '1.0.0' }]);
    const core = cmProvider('hl7.fhir.r4.core#4.0.1', [{ id: 'a', url: CM_A, version: '4.0.1' }]);
    const vsCore = vsProvider('hl7.fhir.r4.core#4.0.1', coreValueSets);
    await endpoint([vsCore], [core, tho]).applyTHOPrecedence();
    const asked = core.keepPinnedOnly.mock.calls[0][0];
    expect(keptKeys(core, 'conceptMapMap', asked)).toEqual(keptKeys(core, 'conceptMapMap', oldThoVersions([tho], 'conceptMapMap')));
    expect(vsCore.keepPinnedOnly.mock.calls[0][0].has(CM_A)).toBe(false);
  });

  test('a concept map provider that doesn\'t say where its maps come from is not THO', async () => {
    class Plain extends AbstractConceptMapProvider { }
    expect(new Plain().sourcePackage()).toBeNull();
    const core = cmProvider('hl7.fhir.r4.core#4.0.1', [{ id: 'a', url: CM_A, version: '4.0.1' }]);
    await endpoint([], [core, new Plain()]).applyTHOPrecedence();
    expect(core.keepPinnedOnly.mock.calls[0][0].size).toBe(0);
  });
});
