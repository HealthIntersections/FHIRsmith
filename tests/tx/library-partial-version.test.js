'use strict';

// A partial version (a SNOMED CT edition URI without its release, or a semver major.minor) means
// the release loaded last: the library's order decides (registerProvider). When that is older
// than one loaded before it, the library says so - but the order still decides.

const { Library } = require('../../tx/library');

const SCT = 'http://snomed.info/sct';
const US = 'http://snomed.info/sct/731000124108';

function factory(system, version, partial) {
  return { system: () => system, version: () => version, getPartialVersion: () => partial };
}

function load(order) {
  const warnings = [];
  const lib = new Library(null, null, { info() {}, debug() {}, warn: (m) => warnings.push(m), error() {} });
  order.forEach((f, i) => lib.registerProvider('test', f, i === 0));
  return { lib, warnings: warnings.filter(w => w.startsWith('Library order')) };
}

describe('library: partial-version keys follow the load order', () => {
  const older = factory(SCT, US + '/version/20240301', US);
  const newer = factory(SCT, US + '/version/20250901', US);

  test('SNOMED CT, oldest first: the edition means the newest release, and nothing is said', () => {
    const { lib, warnings } = load([older, newer]);
    expect(lib.codeSystemFactories.get(SCT + '|' + US)).toBe(newer);
    expect(warnings).toEqual([]);
  });

  test('SNOMED CT, newest first: the edition means the older release, as listed, and the library says so', () => {
    const { lib, warnings } = load([newer, older]);
    expect(lib.codeSystemFactories.get(SCT + '|' + US)).toBe(older);
    // exact versions are untouched
    expect(lib.codeSystemFactories.get(SCT + '|' + US + '/version/20240301')).toBe(older);
    expect(lib.codeSystemFactories.get(SCT + '|' + US + '/version/20250901')).toBe(newer);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`${SCT}|${US} now means ${US}/version/20240301, though ${US}/version/20250901, which is newer, was loaded before it`);
  });

  test('semver major.minor: the order decides, and a newer one listed first is reported', () => {
    const cs = 'http://example.org/cs';
    const oldestFirst = load(['1.2.3', '1.2.10'].map(v => factory(cs, v, '1.2')));
    expect(oldestFirst.lib.codeSystemFactories.get(cs + '|1.2').version()).toBe('1.2.10');
    expect(oldestFirst.warnings).toEqual([]);
    const newestFirst = load(['1.2.10', '1.2.3'].map(v => factory(cs, v, '1.2')));
    expect(newestFirst.lib.codeSystemFactories.get(cs + '|1.2').version()).toBe('1.2.3');
    expect(newestFirst.warnings).toHaveLength(1);
  });

  test('the same release loaded twice is not reported', () => {
    const again = factory(SCT, US + '/version/20250901', US);
    expect(load([newer, again]).warnings).toEqual([]);
  });
});
