const { versionGateMatches, passesModes, testVersions } = require('../../tx/tests/test-case-gates');

describe('tx test case gates', () => {
  test('version gates are major.minor prefixes, optionally negated', () => {
    expect(versionGateMatches(undefined, '5.0')).toBe(true);
    expect(versionGateMatches('4.0', '4.0')).toBe(true);
    expect(versionGateMatches('4.0', '4.0.1')).toBe(true);
    expect(versionGateMatches('4.0', '5.0')).toBe(false);
    expect(versionGateMatches('4.0', '4.01')).toBe(false);
    expect(versionGateMatches('!4.0', '5.0')).toBe(true);
    expect(versionGateMatches('!4.0', '4.0')).toBe(false);
  });

  test('a test gated "!4.0" runs at R5 only', () => {
    expect(testVersions({}, { version: '!4.0' })).toEqual({ hasR5: true, hasR4: false });
    expect(testVersions({}, { version: '4.0' })).toEqual({ hasR5: false, hasR4: true });
    expect(testVersions({}, {})).toEqual({ hasR5: true, hasR4: true });
  });

  test('a suite version gate applies to its tests', () => {
    expect(testVersions({ version: '5.0' }, {})).toEqual({ hasR5: true, hasR4: false });
    expect(testVersions({ version: '5.0' }, { version: '4.0' })).toEqual({ hasR5: false, hasR4: false });
  });

  test('disabled tests and suites are not generated', () => {
    expect(testVersions({}, { disabled: true })).toEqual({ hasR5: false, hasR4: false });
    expect(testVersions({ disabled: true }, {})).toEqual({ hasR5: false, hasR4: false });
  });

  test('modes', () => {
    const modes = new Set(['general', 'snomed']);
    expect(passesModes({}, modes)).toBe(true);
    expect(passesModes({ mode: 'snomed' }, modes)).toBe(true);
    expect(passesModes({ mode: 'omop' }, modes)).toBe(false);
    expect(passesModes({ modes: ['omop', 'snomed'] }, modes)).toBe(true);
    expect(passesModes({ modes: ['omop'] }, modes)).toBe(false);
  });
});
