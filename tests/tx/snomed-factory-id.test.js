// The id of a SNOMED CT edition (shown as CodeSystem/x-<id>) is made from the edition and the
// date in its version URI. For an edition published under http://snomed.info/xsct (the
// tx-ecosystem test edition) it was "SCT-h-t" whatever the edition and date: the letters came
// from "http". Two xsct editions then had the same id, and search listed only one of them.

const { SnomedServicesFactory } = require('../../tx/cs/cs-snomed');

function idOf(versionUri) {
  const factory = Object.create(SnomedServicesFactory.prototype);
  factory._sharedData = { versionUri };
  return factory.id();
}

describe('SnomedServicesFactory.id()', () => {
  test('an sct edition: SCT-<edition>-<date>', () => {
    expect(idOf('http://snomed.info/sct/900000000000207008/version/20260701')).toBe('SCT-900000000000207008-20260701');
  });

  test('an xsct edition: xSCT-<edition>-<date>', () => {
    expect(idOf('http://snomed.info/xsct/31000003106/version/20250909')).toBe('xSCT-31000003106-20250909');
  });

  test('two xsct editions have different ids', () => {
    expect(idOf('http://snomed.info/xsct/31000003106/version/20250909')).not.toBe(idOf('http://snomed.info/xsct/31000003106/version/20240909'));
  });

  test('no id without a date, or for another form of version', () => {
    expect(idOf('http://snomed.info/sct/900000000000207008')).toBeNull();
    expect(idOf('http://snomed.info/xsct/31000003106')).toBeNull();
    expect(idOf('something else')).toBeNull();
  });
});
