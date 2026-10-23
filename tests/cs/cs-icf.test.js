const fs = require('fs');
const path = require('path');

const {CodeSystem} = require('../../tx/library/codesystem');
const {FhirCodeSystemProvider, FhirCodeSystemFactory} = require('../../tx/cs/cs-cs');
const {IcfCodeSystemProvider, IcfQualifiedContext} = require('../../tx/cs/cs-icf');
const {OperationContext} = require('../../tx/operation-context');
const {Designations} = require('../../tx/library/designations');
const {FilterExecutionContext} = require('../../tx/cs/cs-api');
const {TestUtilities} = require('../test-utilities');

// a subset of ICF 2017a from fhir.tx.support, with the q1/q2/q3 qualifier scales
describe('ICF CodeSystem Provider', () => {
  let opContext, icfCS, provider;

  beforeAll(async () => {
    const i18n = await TestUtilities.loadTranslations(await TestUtilities.loadLanguageDefinitions());
    opContext = new OperationContext('en-US', i18n);
    icfCS = new CodeSystem(JSON.parse(fs.readFileSync(path.join(__dirname, '../data/cs-icf-test.json'), 'utf8')));
    provider = FhirCodeSystemProvider.create(opContext, icfCS, []);
  });

  describe('selection by url', () => {
    test('create() and the factory pick the ICF provider for ICF', async () => {
      expect(provider).toBeInstanceOf(IcfCodeSystemProvider);
      const factory = new FhirCodeSystemFactory(opContext.i18n);
      expect(factory.build(opContext, [], icfCS)).toBeInstanceOf(IcfCodeSystemProvider);
    });

    test('create() gives a plain provider for anything else', async () => {
      const other = new CodeSystem({resourceType: 'CodeSystem', url: 'http://example.org/cs', status: 'active', content: 'complete', concept: [{code: 'a'}]});
      const p = FhirCodeSystemProvider.create(opContext, other, []);
      expect(p).toBeInstanceOf(FhirCodeSystemProvider);
      expect(p).not.toBeInstanceOf(IcfCodeSystemProvider);
    });

    test('ICF has a grammar, so is not closed', () => {
      expect(provider.isNotClosed()).toBe(true);
    });
  });

  describe('locate()', () => {
    test('plain codes are found as before', async () => {
      const r = await provider.locate('b1100');
      expect(r.context).toBeTruthy();
      expect(r.context).not.toBeInstanceOf(IcfQualifiedContext);
    });

    test.each(['b1100.2', 'b110.0', 'b1100.9', 's7300.183', 's7300.8', 'd450.4', 'd450.48', 'd450.1234'])('%s is a valid qualified code', async (code) => {
      const r = await provider.locate(code);
      expect(r.message).toBeNull();
      expect(r.context).toBeInstanceOf(IcfQualifiedContext);
      expect(await provider.code(r.context)).toBe(code);
    });

    test('an unknown category is a plain miss', async () => {
      const r = await provider.locate('b9999.2');
      expect(r.context).toBeNull();
      expect(r.message).toBeUndefined();
    });

    test.each([
      ['b1100.5', "'5' is not a valid value for qualifier 1"],
      ['s7300.1a', 'takes 1 to 3 qualifier digits'],
      ['s7300.1834', 'takes 1 to 3 qualifier digits'],
      ['b1100.', 'takes one qualifier digit'],
      ['b1100.29', "takes one qualifier digit after the '.' (extent)"],
      ['d450.12345', 'takes 1 to 4 qualifier digits'],
      ['d450.5', "'5' is not a valid value for qualifier 1 (performance)"],
      ['d450.15', "'5' is not a valid value for qualifier 2 (capacity)"],
      ['e310.2', 'qualifiers on environmental factors codes are not supported'],
      ['e310+2', 'zzz-unknown'],
      ['b1.2', "'b1' is not one"],
      ['b110-b139.2', 'is not one'],
      ['q1-2.2', 'is not one']
    ])('%s is not valid', async (code, msg) => {
      const r = await provider.locate(code);
      expect(r.context).toBeNull();
      if (msg === 'zzz-unknown') {
        expect(r.message).toBeUndefined();
      } else {
        expect(r.message).toContain(msg);
      }
    });
  });

  describe('display', () => {
    test('is the category display, then the qualifiers', async () => {
      expect(await provider.display('s7300.183')).toBe('Structure of upper arm: MILD impairment, both sides');
      expect(await provider.display('b1100.2')).toBe('State of consciousness: MODERATE impairment');
      expect(await provider.display('b1100.9')).toBe('State of consciousness: Not applicable');
      expect(await provider.display('d450.12')).toBe('Walking: performance MILD problem, capacity MODERATE problem');
      expect(await provider.display('d450.8834')).toBe('Walking: capacity with assistance SEVERE problem, performance without assistance COMPLETE problem');
      expect(await provider.display('d450.9')).toBe('Walking: performance not applicable');
    });

    test('8 (not specified) is silent', async () => {
      expect(await provider.display('s7300.888')).toBe('Structure of upper arm');
      expect(await provider.display('s7300.81')).toBe('Structure of upper arm: total absence');
    });

    test('the only designation is the display', async () => {
      const designations = new Designations(await TestUtilities.loadLanguageDefinitions());
      await provider.designations('s7300.183', designations);
      expect(designations.designations.map(d => d.value)).toEqual(['Structure of upper arm: MILD impairment, both sides']);
    });
  });

  describe('properties and lookup', () => {
    test('a qualified code reports its qualifiers, and its category as parent', async () => {
      const props = await provider.properties('s7300.183');
      const value = (code) => props.filter(p => p.code === code).map(p => p.valueCode);
      expect(value('extent')).toEqual(['q1-1']);
      expect(value('nature')).toEqual(['q2-8']);
      expect(value('localization')).toEqual(['q3-3']);
      expect(value('parent')).toEqual([]);
      expect(props.find(p => p.code === 'extent').definition?.code).toBe('extent');
      expect(await provider.parent('s7300.183')).toBe('s7300');
    });

    test('a d code reports performance and capacity', async () => {
      const props = await provider.properties('d450.1234');
      const value = (code) => props.filter(p => p.code === code).map(p => p.valueCode);
      expect(value('performance')).toEqual(['q4-1']);
      expect(value('capacity')).toEqual(['q4-2']);
      expect(value('capacity-with-assistance')).toEqual(['q4-3']);
      expect(value('performance-without-assistance')).toEqual(['q4-4']);
      expect(value('extent')).toEqual([]);
    });

    test('extendLookup has the qualifiers and parent, but no children', async () => {
      const ctxt = (await provider.locate('b110.2')).context;
      const params = [];
      await provider.extendLookup(ctxt, [], params);
      const props = params.filter(p => p.name === 'property').map(p => p.part[0].valueCode + '=' + (p.part[1].valueCode ?? p.part[1].valueBoolean));
      expect(props).toContain('extent=q1-2');
      expect(props).toContain('parent=b110');
      expect(props.some(p => p.startsWith('child='))).toBe(false);
    });

    test('a plain category still reports its children', async () => {
      const ctxt = (await provider.locate('b110')).context;
      const params = [];
      await provider.extendLookup(ctxt, [], params);
      expect(params.some(p => p.part[0].valueCode === 'child')).toBe(true);
    });
  });

  describe('subsumption', () => {
    test.each([
      ['b1100', 'b1100.2', 'subsumes'],
      ['b1100.2', 'b1100', 'subsumed-by'],
      ['b1', 'b1100.2', 'subsumes'],
      ['b1100.2', 'b1100.2', 'equivalent'],
      ['b1100.2', 'b1100.3', 'not-subsumed'],
      ['b1101', 'b1100.2', 'not-subsumed'],
      ['b110', 'b1100', 'subsumes']
    ])('%s vs %s: %s', async (a, b, outcome) => {
      expect(await provider.subsumesTest(a, b)).toBe(outcome);
    });

    test('locateIsA', async () => {
      expect((await provider.locateIsA('b1100.2', 'b110')).context).toBeInstanceOf(IcfQualifiedContext);
      expect((await provider.locateIsA('b1100.2', 'b1100')).context).toBeInstanceOf(IcfQualifiedContext);
      expect((await provider.locateIsA('b1100.2', 'b1101')).context).toBeNull();
      expect((await provider.locateIsA('b1100', 'b1100.2')).context).toBeNull();
      expect((await provider.locateIsA('b1100.2', 'b1100.2', true)).context).toBeNull();
    });

    test('sameConcept compares the whole code', async () => {
      expect(await provider.sameConcept('b1100.2', 'b1100.2')).toBe(true);
      expect(await provider.sameConcept('b1100.2', 'b1100')).toBe(false);
    });
  });

  describe('filters', () => {
    test('a qualified code is in a filter when its category is', async () => {
      const filterContext = new FilterExecutionContext(true);
      const set = await provider.filter(filterContext, false, 'concept', 'is-a', 'b1');
      expect(await provider.filterLocate(filterContext, set, 'b1100.2')).toBeInstanceOf(IcfQualifiedContext);
      expect(await provider.filterLocate(filterContext, set, 's7300.1')).toBeNull();
      expect(await provider.filterLocate(filterContext, set, 'b1100.5')).toBeNull();
    });

    test('a qualified code has no children to iterate', async () => {
      const it = await provider.iterator('b110.2');
      expect(await provider.nextContext(it)).toBeNull();
    });
  });
  describe('qualifier filters', () => {
    // what a value set does with an include: locate in the first filter, check the rest
    async function member(filters, code) {
      const ctx = new FilterExecutionContext(false);
      for (const [prop, op, value] of filters) {
        await provider.filter(ctx, false, prop, op, value);
      }
      const sets = await provider.executeFilters(ctx);
      let loc = await provider.filterLocate(ctx, sets[0], code);
      for (let i = 1; loc && i < sets.length; i++) {
        if ((await provider.filterCheck(ctx, sets[i], loc)) !== true) loc = null;
      }
      return !!loc;
    }

    test('the filters are understood', async () => {
      expect(await provider.doesFilter('extent', 'exists', 'true')).toBe(true);
      expect(await provider.doesFilter('localization', 'exists', 'false')).toBe(true);
      expect(await provider.doesFilter('qualified', '=', 'false')).toBe(true);
      expect(await provider.doesFilter('performance-without-assistance', 'exists', 'true')).toBe(true);
      expect(await provider.doesFilter('extent', 'exists', 'maybe')).toBe(false);
    });

    test.each([
      ['b1100', false], ['b1100.2', true], ['b1100.8', false], ['s7300.183', true], ['s7300.813', false]
    ])('extent exists true: %s -> %s', async (code, inVs) => {
      expect(await member([['concept', 'is-a', 'b'], ['extent', 'exists', 'true']], code) ||
        await member([['concept', 'is-a', 's'], ['extent', 'exists', 'true']], code)).toBe(inVs);
    });

    test.each([
      ['s7300', true], ['s7300.1', true], ['s7300.18', true], ['s7300.183', false], ['s7300.188', true]
    ])('localization exists false: %s -> %s', async (code, inVs) => {
      expect(await member([['concept', 'is-a', 's'], ['localization', 'exists', 'false']], code)).toBe(inVs);
    });

    test.each([
      ['d450', false], ['d450.1', false], ['d450.12', true], ['d450.18', false], ['d450.8823', false]
    ])('capacity exists true: %s -> %s', async (code, inVs) => {
      expect(await member([['concept', 'is-a', 'd'], ['capacity', 'exists', 'true']], code)).toBe(inVs);
    });

    test('extent does not apply to d codes', async () => {
      expect(await member([['concept', 'is-a', 'd'], ['extent', 'exists', 'true']], 'd450.12')).toBe(false);
      expect(await member([['concept', 'is-a', 'd'], ['extent', 'exists', 'false']], 'd450.12')).toBe(true);
    });

    test.each([
      ['b1100', true], ['b1100.2', false], ['b1100.888', false]
    ])('qualified = false: %s -> %s', async (code, inVs) => {
      expect(await member([['qualified', '=', 'false']], code)).toBe(inVs);
    });

    test('a qualifier filter first, then is-a', async () => {
      expect(await member([['extent', 'exists', 'true'], ['concept', 'is-a', 'b1']], 'b1100.3')).toBe(true);
      expect(await member([['extent', 'exists', 'true'], ['concept', 'is-a', 'b1']], 's7300.3')).toBe(false);
    });

    test('closed only with qualified = false', async () => {
      const a = new FilterExecutionContext(true);
      await provider.filter(a, true, 'concept', 'is-a', 'b1');
      expect(await provider.filtersNotClosed(a)).toBe(true);
      const b = new FilterExecutionContext(true);
      await provider.filter(b, true, 'concept', 'is-a', 'b1');
      await provider.filter(b, true, 'qualified', '=', 'false');
      expect(await provider.filtersNotClosed(b)).toBe(false);
    });

    test('bad filter values are refused', async () => {
      await expect(provider.filter(new FilterExecutionContext(false), false, 'extent', 'exists', 'maybe')).rejects.toBeTruthy();
    });
  });
});
