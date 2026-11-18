/**
 * Extension-codes supplements and reserved code spaces (codesystem-reservedCodeSpace) in the FHIR CodeSystem
 * provider. The tx-ecosystem extension-codes suites cover the operations end to end; these check the
 * provider: which codes it locates, and the displays and designations it gives them.
 */

const {CodeSystem} = require('../../tx/library/codesystem');
const {FhirCodeSystemFactory} = require('../../tx/cs/cs-cs');
const {OperationContext} = require('../../tx/operation-context');
const {Designations} = require('../../tx/library/designations');
const {Languages} = require('../../library/languages');
const {TestUtilities} = require('../test-utilities');

const BASE = 'http://example.org/fhir/CodeSystem/ec-base';

function baseCS(pattern = 'X.+') {
  return new CodeSystem({
    resourceType: 'CodeSystem', url: BASE, version: '1.0.0', status: 'active', content: 'complete', language: 'en',
    extension: [{url: 'http://hl7.org/fhir/StructureDefinition/codesystem-reservedCodeSpace', extension: [
      {url: 'reservedCodeSpace', valueString: pattern},
      {url: 'description', valueMarkdown: 'Codes starting with X'}]},
    {url: 'http://hl7.org/fhir/StructureDefinition/codesystem-reservedCodeSpace', extension: [
      {url: 'reservedCodeSpace', valueString: 'Z.+'},
      {url: 'default-display', valueString: 'Local Code'}]}],
    concept: [{code: 'A1', display: 'Code A1'}]
  });
}

function supplement(url, global, concepts) {
  const extension = [{url: 'http://hl7.org/fhir/StructureDefinition/codesystem-supplement-type', valueCode: 'extension-codes'}];
  if (global) {
    extension.push({url: 'http://hl7.org/fhir/StructureDefinition/codesystem-supplement-global', valueBoolean: true});
  }
  return new CodeSystem({resourceType: 'CodeSystem', url, version: '1.0.0', status: 'active', content: 'supplement',
    language: 'en', supplements: BASE + '|1.0.0', extension, concept: concepts});
}

describe('Extension-codes supplements', () => {
  let factory, opContext, languages;

  beforeEach(async () => {
    languages = await TestUtilities.loadLanguageDefinitions();
    const i18n = await TestUtilities.loadTranslations(languages);
    factory = new FhirCodeSystemFactory(i18n);
    opContext = new OperationContext(Languages.fromAcceptLanguage('en-US', languages), i18n);
  });

  describe('reserved code space', () => {
    test('a code must match the expression in full', () => {
      const cs = baseCS();
      expect(cs.isInReservedCodeSpace('X1')).toBe(true);
      expect(cs.isInReservedCodeSpace('AX1')).toBe(false);
      expect(cs.isInReservedCodeSpace('X')).toBe(false);
      expect(cs.isInReservedCodeSpace('')).toBe(false);
    });

    test('a code system with no reserved code space reserves nothing', () => {
      const cs = new CodeSystem({resourceType: 'CodeSystem', url: BASE, status: 'active', content: 'complete'});
      expect(cs.isInReservedCodeSpace('X1')).toBe(false);
    });

    test('an expression that does not compile reserves nothing', () => {
      expect(baseCS('X(').isInReservedCodeSpace('X1')).toBe(false);
    });

    test('isExtensionCodes reads codesystem-supplement-type', () => {
      expect(supplement('http://example.org/s', false, []).isExtensionCodes()).toBe(true);
      expect(baseCS().isExtensionCodes()).toBe(false);
    });
  });

  describe('provider', () => {
    test('locates a code in the reserved code space that nothing defines, with the default display', async () => {
      const provider = factory.build(opContext, [], baseCS());
      const res = await provider.locate('X99');
      expect(res.context).toBeTruthy();
      expect(res.context.reserved).toBe(true);
      expect(await provider.display(res.context)).toBe('User-assigned');
      const designations = new Designations(languages);
      await provider.designations(res.context, designations);
      expect(designations.designations.map(d => d.value)).toEqual(['User-assigned']);
      // a placeholder: another display is not wrong
      expect(designations.userDefined).toBe(true);
    });

    test('a code space can name its own default display (default-display)', async () => {
      const provider = factory.build(opContext, [], baseCS());
      const res = await provider.locate('Z1');
      expect(await provider.display(res.context)).toBe('Local Code');
    });

    test('does not locate a code outside the reserved code space', async () => {
      const provider = factory.build(opContext, [], baseCS());
      expect((await provider.locate('Y1')).context).toBeNull();
    });

    test('a supplement in scope gives a reserved code its display', async () => {
      const supp = supplement('http://example.org/global', true, [{code: 'XG1', display: 'Global Code One'}]);
      const provider = factory.build(opContext, [supp], baseCS());
      const ctxt = (await provider.locate('XG1')).context;
      expect(await provider.display(ctxt)).toBe('Global Code One');
      const designations = new Designations(languages);
      await provider.designations(ctxt, designations);
      expect(designations.extensionCodeDisplay).toBe('global');
      // the default display is not one of its displays
      expect(designations.designations.map(d => d.value)).toEqual(['Global Code One']);
      expect(designations.userDefined).toBeFalsy();
    });

    test('a display from a supplement that is not global is marked as such', async () => {
      const supp = supplement('http://example.org/local', false, [{code: 'XL1', display: 'Local Code One'}]);
      const provider = factory.build(opContext, [supp], baseCS());
      const ctxt = (await provider.locate('XL1')).context;
      const designations = new Designations(languages);
      await provider.designations(ctxt, designations);
      expect(designations.extensionCodeDisplay).toBe('referenced');
    });

    test('a supplement display for a code the code system defines is not an extension-code display', async () => {
      const supp = supplement('http://example.org/global', true, [{code: 'A1', display: 'Another A1'}]);
      const provider = factory.build(opContext, [supp], baseCS());
      const ctxt = (await provider.locate('A1')).context;
      const designations = new Designations(languages);
      await provider.designations(ctxt, designations);
      expect(designations.extensionCodeDisplay).toBeUndefined();
      expect(designations.designations.map(d => d.value).sort()).toEqual(['Another A1', 'Code A1']);
    });

    test('a code system with reserved code spaces is not closed: an expansion of all of it can not list their codes', () => {
      expect(factory.build(opContext, [], baseCS()).openCodeSpaceReason()).toMatch(/reserves code spaces/);
      const plain = new CodeSystem({resourceType: 'CodeSystem', url: BASE, status: 'active', content: 'complete', concept: [{code: 'A1'}]});
      expect(factory.build(opContext, [], plain).openCodeSpaceReason()).toBeNull();
    });

    test('codes from supplements are not iterated with the code system', async () => {
      const supp = supplement('http://example.org/global', true, [{code: 'XG1', display: 'Global Code One'}]);
      const provider = factory.build(opContext, [supp], baseCS());
      const iter = await provider.iteratorAll();
      const codes = [];
      let c;
      while ((c = await provider.nextContext(iter))) {
        codes.push(await provider.code(c));
      }
      expect(codes).toEqual(['A1']);
    });
  });
});
