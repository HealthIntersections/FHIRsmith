/**
 * ECL wild: terms
 *
 * A wild: term is matched by turning its '*'s into ".*". In a native RegExp a
 * pattern with many of them backtracks for a time that grows as the term
 * length to the power of the number of '*'s; the match runs synchronously, so
 * the whole server stalled. Now it is matched without a regex (see
 * wildTermMatcher in tx/sct/ecl.js), in linear time, and a run of '*'s is treated as one.
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
  });

  test('wild: edge cases', () => {
    // no '*': the whole term, ignoring case
    expect(matches('liver structure', 'Liver structure')).toBe(true);
    expect(matches('liver', 'Liver structure')).toBe(false);
    // only '*'s: anything, including nothing
    expect(matches('***', '')).toBe(true);
    expect(matches('*', 'x')).toBe(true);
    // a '*' at either end, or both
    expect(matches('*structure', 'Liver structure')).toBe(true);
    expect(matches('liver*', 'Liver structure')).toBe(true);
    expect(matches('*ver str*', 'Liver structure')).toBe(true);
    expect(matches('*ver str*', 'Liver')).toBe(false);
    // the first and last pieces can't overlap
    expect(matches('ab*ba', 'aba')).toBe(false);
    expect(matches('ab*ba', 'abba')).toBe(true);
    // a middle piece can't overlap the last one
    expect(matches('*ab*ab', 'xab')).toBe(false);
    expect(matches('*ab*ab', 'xabab')).toBe(true);
    // the leftmost middle match is the right one
    expect(matches('a*b*c', 'abxbc')).toBe(true);
    expect(matches('a*b*b*c', 'abc')).toBe(false);
    // an empty term
    expect(matches('a*', '')).toBe(false);

    expect(codes('<< 10200004 {{ D term = wild:"Liver structure" }}')).toHaveLength(1);
    expect(codes('<< 10200004 {{ D term = wild:"**lobe***" }}')).toEqual(codes('<< 10200004 {{ D term = wild:"*lobe*" }}'));
    expect(codes('<< 10200004 {{ D term = wild:"*lobe*" }}').length).toBeGreaterThan(0);
  });
});

describe('wildTermMatcher, in the ECL module', () => {
  const { wildTermMatcher } = require('../../tx/sct/ecl');

  test('the matcher the provider uses: anchored, case-insensitive, runs of * as one', () => {
    expect(wildTermMatcher('*hema*oma')('Subdural HEMATOMA')).toBe(true);
    expect(wildTermMatcher('hema*')('subdural hematoma')).toBe(false);
    expect(wildTermMatcher('a***b')('aXb')).toBe(true);
    expect(wildTermMatcher('exact')('Exact')).toBe(true);
  });
});
