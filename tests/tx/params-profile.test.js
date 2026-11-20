// A 'profile' parameter is read only when it is an inline Parameters resource. Anything else -
// an (R3) ExpansionProfile, another resource, a uri/canonical/string naming a profile, or any other value - is
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
    ['an ExpansionProfile', { resource: { resourceType: 'ExpansionProfile', includeDesignations: true } }, 'PARAMETER_PROFILE_NOT_SUPPORTED_RESOURCE', 'a resource of type ExpansionProfile'],
    ['another resource', { resource: { resourceType: 'ValueSet', status: 'active' } }, 'PARAMETER_PROFILE_NOT_SUPPORTED_RESOURCE', 'a resource of type ValueSet'],
    ['a valueUri', { valueUri: 'http://example.org/profile' }, 'PARAMETER_PROFILE_NOT_SUPPORTED_VALUE', "the value 'http://example.org/profile'"],
    ['a valueCanonical', { valueCanonical: 'http://example.org/profile' }, 'PARAMETER_PROFILE_NOT_SUPPORTED_VALUE', "the value 'http://example.org/profile'"],
    ['a valueString (as from a GET)', { valueString: 'http://example.org/profile' }, 'PARAMETER_PROFILE_NOT_SUPPORTED_VALUE', "the value 'http://example.org/profile'"],
    ['a valueCoding', { valueCoding: { system: 'http://example.org/cs', code: 'p' } }, 'PARAMETER_PROFILE_NOT_SUPPORTED_TYPE', 'a value of type Coding'],
  ])('%s is refused as not supported, with status 400', (_, profile, msgId, found) => {
    const error = refusal(profile);
    expect(error).toBeInstanceOf(Issue);
    expect(error).toMatchObject({ statusCode: 400, cause: 'not-supported', msgId, issueCode: 'not-supported' });
    expect(error.message).toBe("The parameter 'profile' is only supported as an inline Parameters resource, not " + found);
    expect(error.asIssue()).toMatchObject({
      severity: 'error', code: 'not-supported',
      details: { coding: [{ system: 'http://hl7.org/fhir/tools/CodeSystem/tx-issue-type', code: 'not-supported' }] },
      extension: [{ url: 'http://hl7.org/fhir/StructureDefinition/operationoutcome-message-id', valueString: msgId }]
    });
  });

  test("a 'profile' in a ValueSet's embedded expansion parameters is ignored, not refused", () => {
    const p = new TxParameters(langDefs, i18n);
    expect(() => p.seeParameter('profile', { valueUri: 'http://example.org/fhir/ExpansionProfile/x' }, false)).not.toThrow();
  });
});

describe("'exclude-system' parameter", () => {
  test('is refused as not supported, with status 400, a message id and a tx-issue-type', () => {
    let error = null;
    try {
      read([{ name: 'exclude-system', valueString: 'http://loinc.org' }]);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Issue);
    expect(error).toMatchObject({ statusCode: 400, cause: 'not-supported', msgId: 'PARAMETER_NOT_SUPPORTED', issueCode: 'not-supported' });
    expect(error.message).toBe("The parameter 'exclude-system' is not supported by this system");
    expect(error.asIssue()).toMatchObject({
      details: { coding: [{ system: 'http://hl7.org/fhir/tools/CodeSystem/tx-issue-type', code: 'not-supported' }] },
      extension: [{ url: 'http://hl7.org/fhir/StructureDefinition/operationoutcome-message-id', valueString: 'PARAMETER_NOT_SUPPORTED' }]
    });
  });
});
