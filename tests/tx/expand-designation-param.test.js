/**
 * The $expand designation parameter (L3): a token, system|code, or a bare code that matches a
 * designation's language or its use code from any system. A bare language code used to match
 * nothing, so designation=nl-NL dropped every designation
 */

const { ValueSetExpander } = require('../../tx/workers/expand');

function expander(designations) {
  const worker = { internalLimit: 1000, externalLimit: 1000 };
  return new ValueSetExpander(worker, { hasDesignations: designations.length > 0, designations });
}

const nl = { language: { code: 'nl-NL' }, value: 'Glucose [massa/volume] in serum of plasma' };
const fr = { language: { code: 'fr-FR' }, value: 'Glucose [Masse/Volume] Sérum/Plasma ; Numérique' };
const de = { language: { code: 'de-DE' }, value: 'Glucose [Masse/Vol] in Serum oder Plasma' };
const shortName = { use: { system: 'http://loinc.org', code: 'SHORTNAME' }, value: 'Glucose SerPl-mCnc' };

describe('$expand designation parameter', () => {
  test('bare language codes keep those languages only', () => {
    const exp = expander(['nl-NL', 'fr-FR']);
    expect([nl, fr, de, shortName].filter(d => exp.useDesignation(d))).toEqual([nl, fr]);
  });

  test('a bare code also matches a use code, from any system', () => {
    const exp = expander(['SHORTNAME']);
    expect([nl, fr, de, shortName].filter(d => exp.useDesignation(d))).toEqual([shortName]);
  });

  test('|code is the same as a bare code', () => {
    const exp = expander(['|de-DE']);
    expect([nl, fr, de, shortName].filter(d => exp.useDesignation(d))).toEqual([de]);
  });

  test('system|code still works, for languages and uses', () => {
    const exp = expander(['urn:ietf:bcp:47|fr-FR', 'http://loinc.org|SHORTNAME']);
    expect([nl, fr, de, shortName].filter(d => exp.useDesignation(d))).toEqual([fr, shortName]);
    expect(expander(['http://other.org|SHORTNAME']).useDesignation(shortName)).toBe(false);
  });

  test('no designation parameter keeps them all', () => {
    const exp = expander([]);
    expect([nl, fr, de, shortName].every(d => exp.useDesignation(d))).toBe(true);
  });
});
