/**
 * FhirCodeSystemProvider.create: a CodeSystem object may choose its provider (providerFactory)
 * before the url registry does. Without one - every CodeSystem main loads - the registry decides
 * as before, ICF included.
 */
const fs = require('fs');
const path = require('path');
const {CodeSystem} = require('../../tx/library/codesystem');
const {FhirCodeSystemProvider, providerClassFor} = require('../../tx/cs/cs-cs');
const {IcfCodeSystemProvider} = require('../../tx/cs/cs-icf');
const {OperationContext} = require('../../tx/operation-context');
const {TestUtilities} = require('../test-utilities');

const ICF_JSON = path.join(__dirname, '../data/cs-icf-test.json');
const plainJson = () => ({resourceType: 'CodeSystem', url: 'http://example.org/cs', status: 'active', content: 'complete', concept: [{code: 'a'}]});

/** a stored CodeSystem that builds its own provider for plain CodeSystems, and leaves registered subclasses alone */
class StoredCodeSystem extends CodeSystem {
  providerFactory(opContext, supplements, cls) {
    this.asked = (this.asked || 0) + 1;
    if (cls !== FhirCodeSystemProvider) {
      return null;
    }
    return new StoredProvider(opContext, this, supplements);
  }
}
class StoredProvider extends FhirCodeSystemProvider { }

describe('FhirCodeSystemProvider.create and CodeSystem.providerFactory', () => {
  let opContext;

  beforeAll(async () => {
    const i18n = await TestUtilities.loadTranslations(await TestUtilities.loadLanguageDefinitions());
    opContext = new OperationContext('en-US', i18n);
  });

  test('providerClassFor is exported: ICF has its own class, other urls the plain one', () => {
    expect(providerClassFor('http://hl7.org/fhir/sid/icf')).toBe(IcfCodeSystemProvider);
    expect(providerClassFor('http://example.org/cs')).toBe(FhirCodeSystemProvider);
  });

  test('no providerFactory: the url registry decides, as before', () => {
    expect(FhirCodeSystemProvider.create(opContext, new CodeSystem(plainJson()), []).constructor).toBe(FhirCodeSystemProvider);
    const icf = new CodeSystem(JSON.parse(fs.readFileSync(ICF_JSON, 'utf8')));
    expect(FhirCodeSystemProvider.create(opContext, icf, [])).toBeInstanceOf(IcfCodeSystemProvider);
  });

  test('a providerFactory supplies the provider, and is told the registry\'s choice', () => {
    const cs = new StoredCodeSystem(plainJson());
    const supplements = [];
    const spy = jest.spyOn(cs, 'providerFactory');
    const p = FhirCodeSystemProvider.create(opContext, cs, supplements);
    expect(p).toBeInstanceOf(StoredProvider);
    expect(spy).toHaveBeenCalledWith(opContext, supplements, FhirCodeSystemProvider);
    expect(p.codeSystem).toBe(cs);
  });

  test('a providerFactory that returns null leaves it to the registry (ICF stays ICF)', () => {
    const icf = new StoredCodeSystem(JSON.parse(fs.readFileSync(ICF_JSON, 'utf8')));
    const p = FhirCodeSystemProvider.create(opContext, icf, []);
    expect(icf.asked).toBe(1);
    expect(p).toBeInstanceOf(IcfCodeSystemProvider);
    expect(p).not.toBeInstanceOf(StoredProvider);
  });
});
