'use strict';

// A partial version (a SNOMED CT edition URI without its date, or a semver major.minor) resolves
// to the latest version loaded for it, whatever the library's load order.

const { Library } = require('../../tx/library');

const SCT = 'http://snomed.info/sct';
const US = 'http://snomed.info/sct/731000124108';

function factory(system, version, partial) {
  return { system: () => system, version: () => version, getPartialVersion: () => partial };
}

function load(order) {
  const lib = new Library(null, null, { info() {}, debug() {}, warn() {}, error() {} });
  order.forEach((f, i) => lib.registerProvider('test', f, i === 0));
  return lib;
}

describe('library: partial-version keys', () => {
  const older = factory(SCT, US + '/version/20240301', US);
  const newer = factory(SCT, US + '/version/20250901', US);

  test.each([['newest first', [newer, older]], ['oldest first', [older, newer]]])('SNOMED edition-only pin, %s', (_, order) => {
    const lib = load(order);
    expect(lib.codeSystemFactories.get(SCT + '|' + US)).toBe(newer);
    // exact versions are untouched
    expect(lib.codeSystemFactories.get(SCT + '|' + US + '/version/20240301')).toBe(older);
    expect(lib.codeSystemFactories.get(SCT + '|' + US + '/version/20250901')).toBe(newer);
  });

  test.each([['newest first', ['1.2.10', '1.2.3']], ['oldest first', ['1.2.3', '1.2.10']]])('semver major.minor, %s', (_, vs) => {
    const fs = vs.map((v) => factory('http://example.org/cs', v, '1.2'));
    const lib = load(fs);
    expect(lib.codeSystemFactories.get('http://example.org/cs|1.2').version()).toBe('1.2.10');
  });
});
