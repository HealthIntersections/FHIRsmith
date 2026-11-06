/**
 * THO precedence asks each value-set provider (thoVersions, yieldToTHO) instead of reaching into
 * PackageValueSetProvider's valueSetMap. The defaults give what the old loops gave: a THO
 * package's value sets' url -> versions, and keepPinnedOnly for a core package only. A provider
 * that keeps no map can take part by answering the same questions.
 */
const { Provider } = require('../../tx/provider');
const { PackageValueSetProvider } = require('../../tx/vs/vs-package');
const { AbstractValueSetProvider } = require('../../tx/vs/vs-api');
const { isTHOPackage } = require('../../tx/library/tho-precedence');

const URL_A = 'http://terminology.hl7.org/ValueSet/a';
const URL_B = 'http://terminology.hl7.org/ValueSet/b';

/** a PackageValueSetProvider with this map, as initialize() leaves it (keys: id, url, url|version) */
function packageProvider(pid, valueSets) {
  const p = Object.create(PackageValueSetProvider.prototype);
  p.sourcePackageCode = pid;
  p.valueSetMap = new Map();
  for (const vs of valueSets) {
    p.valueSetMap.set(vs.id, vs);
    p.valueSetMap.set(vs.url, vs);
    if (vs.version) {
      p.valueSetMap.set(vs.url + '|' + vs.version, vs);
    }
  }
  p.keepPinnedOnly = jest.fn();
  return p;
}

/** the loop provider.js ran before (instanceof PackageValueSetProvider + valueSetMap) */
function oldThoVersions(providers) {
  const map = new Map();
  for (const vp of providers) {
    if (vp instanceof PackageValueSetProvider && isTHOPackage(vp.sourcePackage())) {
      for (const vs of vp.valueSetMap.values()) {
        if (!vs || !vs.url) {
          continue;
        }
        if (!map.has(vs.url)) {
          map.set(vs.url, new Set());
        }
        if (vs.version) {
          map.get(vs.url).add(vs.version);
        }
      }
    }
  }
  return map;
}

function newProvider(valueSetProviders) {
  const p = Object.create(Provider.prototype);
  p.valueSetProviders = valueSetProviders;
  p.conceptMapProviders = [];
  return p;
}

const tho = () => packageProvider('hl7.terminology.r4#6.0.2', [
  { id: 'a', url: URL_A, version: '1.0.0' }, { id: 'a2', url: URL_A, version: '2.0.0' }, { id: 'b', url: URL_B }
]);
const core = () => packageProvider('hl7.fhir.r4.core#4.0.1', [{ id: 'a', url: URL_A, version: '4.0.1' }]);
const other = () => packageProvider('hl7.fhir.us.core#6.1.0', [{ id: 'x', url: 'http://example.org/x', version: '1' }]);

describe('value-set providers answer the THO precedence questions', () => {
  test('thoVersions gives what the old valueSetMap loop gave', () => {
    const providers = [tho(), core(), other()];
    const map = new Map();
    for (const vp of providers) {
      vp.thoVersions(map);
    }
    expect(map).toEqual(oldThoVersions(providers));
    expect(map).toEqual(new Map([[URL_A, new Set(['1.0.0', '2.0.0'])], [URL_B, new Set()]]));
  });

  test('a package that is not THO adds nothing', () => {
    const map = new Map();
    core().thoVersions(map);
    other().thoVersions(map);
    expect(map.size).toBe(0);
  });

  test('yieldToTHO calls keepPinnedOnly for a core package only', () => {
    const map = new Map([[URL_A, new Set(['1.0.0'])]]);
    const c = core();
    const t = tho();
    const o = other();
    for (const vp of [c, t, o]) {
      vp.yieldToTHO(map);
    }
    expect(c.keepPinnedOnly).toHaveBeenCalledWith(map);
    expect(t.keepPinnedOnly).not.toHaveBeenCalled();
    expect(o.keepPinnedOnly).not.toHaveBeenCalled();
  });

  test('the base class defaults do nothing', () => {
    const vp = new AbstractValueSetProvider();
    const map = new Map();
    vp.thoVersions(map);
    vp.yieldToTHO(map);
    expect(map.size).toBe(0);
  });

  test('Provider.applyTHOPrecedence: core yields to THO, as before', () => {
    const t = tho();
    const c = core();
    newProvider([c, t, other()]).applyTHOPrecedence();
    expect(c.keepPinnedOnly).toHaveBeenCalledTimes(1);
    expect(c.keepPinnedOnly.mock.calls[0][0]).toEqual(new Map([[URL_A, new Set(['1.0.0', '2.0.0'])], [URL_B, new Set()]]));
  });

  test('Provider.applyTHOPrecedence: a provider with no map takes part through the methods', () => {
    class RowsProvider extends AbstractValueSetProvider {
      thoVersions(map) {
        map.set(URL_A, new Set(['9.9.9']));
      }
    }
    const c = core();
    newProvider([c, new RowsProvider()]).applyTHOPrecedence();
    expect(c.keepPinnedOnly.mock.calls[0][0]).toEqual(new Map([[URL_A, new Set(['9.9.9'])]]));
  });

  test('vsCount, which the startup log now reports, counts value sets rather than map keys', () => {
    const p = Object.create(PackageValueSetProvider.prototype);
    p.database = { vsCount: 3 };
    expect(p.vsCount()).toBe(3);
  });
});
