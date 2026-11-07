/**
 * ECL wild: terms
 *
 * A wild: term is matched by turning its '*'s into ".*". In a native RegExp a
 * pattern with many of them backtracks for a time that grows as the term
 * length to the power of the number of '*'s; the match runs synchronously, so
 * the whole server stalled. Now it runs on re2js (linear time) and a run of
 * '*'s is treated as one.
 */

const { SnomedServicesFactory } = require('../../tx/cs/cs-snomed');
const {join} = require("node:path");
const {OperationContext} = require("../../tx/operation-context");
const {TestUtilities} = require("../test-utilities");

describe('ECL wild: terms', () => {
  let snomedServices;
  let opContext;

  beforeAll(async () => {
    opContext = new OperationContext('en', await TestUtilities.loadTranslations());
    const factory = new SnomedServicesFactory(opContext.i18n, join(__dirname, '../../tx/data/snomed-testing.cache'));
    await factory.load();
    snomedServices = factory.snomedServices;
  });

  const codes = (ecl) => (snomedServices.filterECL(ecl, true, opContext).descendants || [])
    .map(i => snomedServices.concepts.getConceptId(i).toString()).sort();
  const matches = (value, term) => snomedServices._eclTermMatcher({ kind: 'wild', value })(term);

  test('a wild: term with many *s is quick', () => {
    const term = 'Structure of left lower lobe of lung and something else here';
    let start = Date.now();
    expect(matches('*'.repeat(30) + 'x', term)).toBe(false);
    expect(matches('* * * * * * * * * * * * x', term)).toBe(false);
    expect(matches('*e*e*e*e*e*e*e*e*e*e*e*e*e*x', term)).toBe(false);
    expect(Date.now() - start).toBeLessThan(100);

    const endsInX = codes('* {{ D term = wild:"*x" }}');
    start = Date.now();
    expect(codes('* {{ D term = wild:"' + '*'.repeat(30) + 'x" }}')).toEqual(endsInX);
    expect(Date.now() - start).toBeLessThan(100);
  });

  test('wild: terms match as before', () => {
    const term = 'Structure of left lower lobe of lung (body structure)';
    expect(matches('*lobe*', term)).toBe(true);
    expect(matches('STRUCTURE OF*', term)).toBe(true);
    expect(matches('structure of', term)).toBe(false);
    expect(matches('*(body structure)', term)).toBe(true);
    expect(matches('*lobe', term)).toBe(false);
    expect(matches('*', term)).toBe(true);
    expect(matches('S*e*e*)', term)).toBe(true);
    expect(matches('Structure.of*', term)).toBe(false); // '.' is literal
    expect(matches('a+b [c]', 'A+B [C]')).toBe(true); // regex characters are literal
    expect(matches('café*', 'Café au lait spots')).toBe(true);

    expect(codes('<< 10200004 {{ D term = wild:"Liver structure" }}')).toHaveLength(1);
    expect(codes('<< 10200004 {{ D term = wild:"**lobe***" }}')).toEqual(codes('<< 10200004 {{ D term = wild:"*lobe*" }}'));
    expect(codes('<< 10200004 {{ D term = wild:"*lobe*" }}').length).toBeGreaterThan(0);
  });
});
