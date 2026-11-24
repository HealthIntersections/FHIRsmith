/**
 * ValueSet's code map (system|code -> expansion contains item) is built the first time it is
 * used, not when the ValueSet is made: a value set a client sends with a large expansion
 * (tx-resource) is made on every request, and building the map held tx.fhir.org's event loop
 * for 3 s and more (2026-11-24), though validation doesn't use it (findContains)
 */
const ValueSet = require('../../tx/library/valueset');

const LOINC = 'http://loinc.org';
const SCT = 'http://snomed.info/sct';

function expanded() {
  return {
    resourceType: 'ValueSet',
    url: 'http://example.org/fhir/ValueSet/lazy-map',
    name: 'LazyMap',
    status: 'active',
    expansion: {
      timestamp: '2026-11-24T00:00:00Z',
      contains: [
        { system: LOINC, version: '2.73', code: 'LA6113-0', display: 'Positive' },
        { system: LOINC, code: 'LA6114-8', display: 'Negative',
          contains: [{ system: SCT, code: '260385009', display: 'Negative' }] }
      ]
    }
  };
}

describe('ValueSet code map', () => {
  test('is not built when the value set is made, nor by findContains', () => {
    const vs = new ValueSet(expanded());
    expect(vs._codeMap).toBeNull();
    expect(vs.findContains(LOINC, '', 'LA6113-0')).not.toBeNull();
    expect(vs._codeMap).toBeNull();
  });

  test('is built on first use, nested contains included, and then kept', () => {
    const vs = new ValueSet(expanded());
    expect(vs.hasCode(LOINC, 'LA6113-0', '2.73')).toBe(true);
    expect(vs.hasCode(LOINC, 'LA6114-8')).toBe(true);
    expect(vs.getCode(SCT, '260385009').display).toBe('Negative');
    expect(vs.hasCode(LOINC, 'nothing')).toBe(false);
    const map = vs._codeMap;
    expect(map.size).toBe(3);
    expect(vs.getAllCodes()).toHaveLength(3);
    expect(vs._codeMap).toBe(map);
  });

  test('buildMaps starts it again, after the expansion changes', () => {
    const vs = new ValueSet(expanded());
    expect(vs.hasCode(LOINC, 'LA6113-0', '2.73')).toBe(true);
    vs.jsonObj.expansion.contains = [{ system: SCT, code: '1234', display: 'Other' }];
    vs.buildMaps();
    expect(vs._codeMap).toBeNull();
    expect(vs.hasCode(LOINC, 'LA6113-0', '2.73')).toBe(false);
    expect(vs.hasCode(SCT, '1234')).toBe(true);
  });

  test('a value set with no expansion has an empty map', () => {
    const vs = new ValueSet({ resourceType: 'ValueSet', url: 'http://example.org/fhir/ValueSet/none', name: 'None', status: 'active' });
    expect(vs.getAllCodes()).toEqual([]);
    expect(vs.getInfo().codeCount).toBe(0);
  });
});
