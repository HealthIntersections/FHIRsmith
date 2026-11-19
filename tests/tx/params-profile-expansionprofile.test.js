// A 'profile' parameter can carry a Parameters resource, which is read in place. One carrying
// an ExpansionProfile (R3) was handed to the same reader, which failed with "params must be a
// Resource of type Parameters not ExpansionProfile" - an HTTP 500 from $expand and
// $validate-code. An ExpansionProfile has no parameter list, so it can't be read: the request
// is refused as not supported (400).

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

describe("'profile' parameter", () => {
  test('an ExpansionProfile is refused as not supported, with status 400', () => {
    let error = null;
    try {
      read([{ name: 'profile', resource: { resourceType: 'ExpansionProfile', includeDesignations: true } }]);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Issue);
    expect(error.statusCode).toBe(400);
    expect(error.cause).toBe('not-supported');
    expect(error.message).toContain('ExpansionProfile');
  });

  test('a Parameters resource is still read in place', () => {
    const p = read([{ name: 'profile', resource: { resourceType: 'Parameters', parameter: [{ name: 'activeOnly', valueBoolean: true }] } }]);
    expect(p.activeOnly).toBe(true);
  });

  test('any other resource, or a value that is not a resource, is still ignored', () => {
    expect(read([{ name: 'profile', resource: { resourceType: 'ValueSet', status: 'active' } }]).activeOnly).toBe(false);
    expect(read([{ name: 'profile', valueUri: 'http://example.org/profile' }]).activeOnly).toBe(false);
  });
});
