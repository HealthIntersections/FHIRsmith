// A 'profile' parameter is read only when it is an inline Parameters resource. Anything else -
// an (R3) ExpansionProfile, another resource, or a uri/canonical/string naming a profile - is
// refused as not supported (400). An ExpansionProfile used to fail with "params must be a
// Resource of type Parameters not ExpansionProfile" (a 500), and the other forms were silently
// ignored, so the client got an answer without what it asked for.

const { TxParameters } = require('../../tx/params');
const { Issue } = require('../../tx/library/operation-outcome');
const { TestUtilities } = require('../test-utilities');

let langDefs, i18n;
beforeAll(async () => {
  langDefs = await TestUtilities.loadLanguageDefinitions();
  i18n = await TestUtilities.loadTranslations(langDefs);
});

function read(parameter) {
  const p = new TxParameters(langDefs, i18n);
  p.readParams({ resourceType: 'Parameters', parameter });
  return p;
}

function refusal(profile) {
  try {
    read([{ name: 'profile', ...profile }]);
  } catch (e) {
    return e;
  }
  return null;
}

describe("'profile' parameter", () => {
  test('an inline Parameters resource is read in place', () => {
    const p = read([{ name: 'profile', resource: { resourceType: 'Parameters', parameter: [{ name: 'activeOnly', valueBoolean: true }] } }]);
    expect(p.activeOnly).toBe(true);
  });

  test.each([
    ['an ExpansionProfile', { resource: { resourceType: 'ExpansionProfile', includeDesignations: true } }, 'resource of type ExpansionProfile'],
    ['another resource', { resource: { resourceType: 'ValueSet', status: 'active' } }, 'resource of type ValueSet'],
    ['a valueUri', { valueUri: 'http://example.org/profile' }, "the value 'http://example.org/profile'"],
    ['a valueCanonical', { valueCanonical: 'http://example.org/profile' }, "the value 'http://example.org/profile'"],
    ['a valueString (as from a GET)', { valueString: 'http://example.org/profile' }, "the value 'http://example.org/profile'"],
  ])('%s is refused as not supported, with status 400', (_, profile, found) => {
    const error = refusal(profile);
    expect(error).toBeInstanceOf(Issue);
    expect(error.statusCode).toBe(400);
    expect(error.cause).toBe('not-supported');
    expect(error.message).toContain('only supported as an inline Parameters resource');
    expect(error.message).toContain(found);
  });
});
