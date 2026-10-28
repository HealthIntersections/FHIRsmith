//
// How a CodeSystem's notSelectable property is recognised (tx-ecosystem requirements,
// Concept Properties): by the canonical uri whatever local code it has, by the standard
// code where the code system declares nothing, and never where the code system declares
// the code with a different uri - that is a different property
//

const { CodeSystem } = require('../../tx/library/codesystem');
const { FhirCodeSystemProvider } = require('../../tx/cs/cs-cs');
const { FilterExecutionContext } = require('../../tx/cs/cs-api');
const { OperationContext } = require('../../tx/operation-context');
const { TestUtilities } = require('../test-utilities');

const NS_URI = 'http://hl7.org/fhir/concept-properties#notSelectable';

function codeSystem(code, uri) {
  const prop = (value) => ({ code, valueBoolean: value });
  const cs = {
    resourceType: 'CodeSystem',
    url: 'http://example.org/fhir/CodeSystem/ns-' + code + '-' + (uri ? uri.split('#')[1] : 'none'),
    version: '0.1.0',
    status: 'active',
    content: 'complete',
    concept: [
      { code: 'codeU', display: 'Unknown Selectable State' },
      { code: 'codeS', display: 'Selectable Code', property: [prop(false)] },
      { code: 'codeNS', display: 'Not Selectable Code', property: [prop(true)] }
    ]
  };
  if (uri !== undefined) {
    cs.property = [{ code, type: 'boolean' }];
    if (uri) {
      cs.property[0].uri = uri;
    }
  }
  return cs;
}

describe('recognising the notSelectable property', () => {
  let opContext;

  beforeEach(async () => {
    opContext = new OperationContext('en-US',
      await TestUtilities.loadTranslations(await TestUtilities.loadLanguageDefinitions()));
  });

  const providerFor = (json) => new FhirCodeSystemProvider(opContext, new CodeSystem(json), []);

  async function abstractCodes(provider) {
    const result = [];
    for (const c of ['codeU', 'codeS', 'codeNS']) {
      if (await provider.isAbstract(c)) {
        result.push(c);
      }
    }
    return result;
  }

  async function filterCodes(provider, value) {
    const set = await provider.filter(new FilterExecutionContext(), true, 'notSelectable', '=', value);
    return set.concepts.map(c => c.concept.code).sort();
  }

  test('declared with the standard code and uri', async () => {
    const provider = providerFor(codeSystem('notSelectable', NS_URI));
    expect(await abstractCodes(provider)).toEqual(['codeNS']);
    expect(await filterCodes(provider, 'true')).toEqual(['codeNS']);
    expect(await filterCodes(provider, 'false')).toEqual(['codeS']);
  });

  test('not declared at all: recognised by the standard code', async () => {
    const provider = providerFor(codeSystem('notSelectable', undefined));
    expect(await abstractCodes(provider)).toEqual(['codeNS']);
    expect(await filterCodes(provider, 'true')).toEqual(['codeNS']);
  });

  test('declared with the standard uri and a local code: recognised by the uri', async () => {
    const provider = providerFor(codeSystem('selectable-not', NS_URI));
    expect(await abstractCodes(provider)).toEqual(['codeNS']);
    expect(await filterCodes(provider, 'true')).toEqual(['codeNS']);
    expect(await filterCodes(provider, 'false')).toEqual(['codeS']);
  });

  test('declared with the standard code and a different uri: a different property', async () => {
    const provider = providerFor(codeSystem('notSelectable', NS_URI + 'X'));
    // nothing is abstract
    expect(await abstractCodes(provider)).toEqual([]);
    // but a filter on the code is still a filter on the code system's own property
    expect(await filterCodes(provider, 'true')).toEqual(['codeNS']);
    expect(await filterCodes(provider, 'false')).toEqual(['codeS']);
  });
});
