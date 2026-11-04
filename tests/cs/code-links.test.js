/**
 * codeLink(context): the link a page gives a code from a factory-backed code system (a
 * ValueSet's include lists them). The links follow org.hl7.fhir.core's renderers
 * (SnomedUtilities.getSctLink, LoincLinker, DataRenderer.getLinkForCode); ICD-11 uses the
 * browser url the ICD-API gives each entity.
 */
const { CodeSystemFactoryProvider } = require('../../tx/cs/cs-api');
const { SnomedServicesFactory, SnomedExpressionContext } = require('../../tx/cs/cs-snomed');
const { SnomedExpressionParser } = require('../../tx/sct/expressions');
const { LoincServicesFactory, LoincProviderContext } = require('../../tx/cs/cs-loinc');
const { RxNormServicesFactory, NCIServicesFactory, RxNormConcept } = require('../../tx/cs/cs-rxnorm');
const { ICD11ServicesFactory, ICD11Concept } = require('../../tx/cs/cs-icd11');

// codeLink needs nothing a factory gets from loading, so these are built without a database
function factory(cls, fields) {
  return Object.assign(Object.create(cls.prototype), fields);
}

function snomed(versionUri) {
  const f = Object.create(SnomedServicesFactory.prototype);
  f._sharedData = { versionUri };
  return f;
}

describe('codeLink', () => {
  test('the default gives no link', () => {
    expect(CodeSystemFactoryProvider.prototype.codeLink({ code: 'x' })).toBeUndefined();
  });

  describe('SNOMED CT', () => {
    const concept = SnomedExpressionContext.fromCode('22298006', 0);

    test('a concept in an edition snomed.info knows links in that edition', () => {
      expect(snomed('http://snomed.info/sct/731000124108/version/20250901').codeLink(concept))
        .toBe('http://snomed.info/sct/731000124108/id/22298006');
      expect(snomed('http://snomed.info/sct/900000000000207008/version/20250201').codeLink(concept))
        .toBe('http://snomed.info/sct/900000000000207008/id/22298006');
    });

    test('a concept in any other edition links without one', () => {
      expect(snomed('http://snomed.info/sct/11000203105/version/20250909').codeLink(concept))
        .toBe('http://snomed.info/id/22298006');
      expect(snomed('http://snomed.info/xsct/900000000000207008/version/20250814').codeLink(concept))
        .toBe('http://snomed.info/id/22298006');
    });

    test('an expression links to the browser', () => {
      const source = '22298006:363698007=76752008';
      const expression = SnomedExpressionContext.fromExpression(source, new SnomedExpressionParser().parse(source));
      expect(snomed('http://snomed.info/sct/731000124108/version/20250901').codeLink(expression))
        .toBe('https://browser.ihtsdotools.org/');
    });

    test('no context, no link', () => {
      expect(snomed('http://snomed.info/sct/731000124108/version/20250901').codeLink(null)).toBeUndefined();
    });
  });

  test('LOINC: codes, parts and answers link to loinc.org', () => {
    const f = Object.create(LoincServicesFactory.prototype);
    expect(f.codeLink(new LoincProviderContext(1, 0, '2345-7', 'Glucose', 'ACTIVE'))).toBe('https://loinc.org/2345-7/');
    expect(f.codeLink(new LoincProviderContext(2, 0, 'LP14355-9', 'Glucose', 'ACTIVE'))).toBe('https://loinc.org/LP14355-9/');
    expect(f.codeLink(new LoincProviderContext(3, 0, 'LA6576-8', 'Positive', 'ACTIVE'))).toBe('https://loinc.org/LA6576-8/');
    expect(f.codeLink(null)).toBeUndefined();
  });

  test('RxNorm links to RxNav, the NCI Thesaurus to EVS Explore', () => {
    const rx = factory(RxNormServicesFactory, { isNCI: false });
    expect(rx.codeLink(new RxNormConcept('161', 'acetaminophen')))
      .toBe('https://mor.nlm.nih.gov/RxNav/search?searchBy=RXCUI&searchTerm=161');
    const nci = factory(NCIServicesFactory, { isNCI: true });
    expect(nci.codeLink(new RxNormConcept('C3262', 'Neoplasm')))
      .toBe('https://evsexplore.semantics.cancer.gov/evsexplore/concept/ncit/C3262');
    expect(rx.codeLink(null)).toBeUndefined();
  });

  describe('ICD-11', () => {
    const f = factory(ICD11ServicesFactory, { systemCode: 'mms' });
    const row = { id: 1, entity_id: '257068234', uri: 'http://id.who.int/icd/entity/257068234', code: '1A00',
      browser_url: 'https://icd.who.int/browse/2026-01/mms/en#257068234' };

    test('a concept links to its page in the WHO browser', () => {
      expect(f.codeLink(new ICD11Concept(row, true))).toBe('https://icd.who.int/browse/2026-01/mms/en#257068234');
    });

    test('a postcoordinated expression links to its stem', () => {
      const expression = { tokens: [{ concept: new ICD11Concept(row, true) }, { concept: new ICD11Concept({ ...row, browser_url: 'other' }, true) }] };
      expect(f.codeLink(expression)).toBe('https://icd.who.int/browse/2026-01/mms/en#257068234');
    });

    test('no browser url, no link', () => {
      expect(f.codeLink(new ICD11Concept({ ...row, browser_url: null }, true))).toBeUndefined();
      expect(f.codeLink(null)).toBeUndefined();
    });
  });
});
