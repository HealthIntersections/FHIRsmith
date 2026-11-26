// Which client a request comes from (library/client-identity.js): the User-Agents the FHIR tools
// send, as seen on tx.fhir.org (2026-11), and whether they are old versions (auth.loginForOldTools)

const { identifyClient, isOldTool, compareVersions } = require('../../library/client-identity');

describe('identifyClient', () => {
  test.each([
    ['fhir/publisher', true, 'publisher', null],
    ['fhir/publisher fhir-core/7.0.7', true, 'publisher', '7.0.7'],
    ['fhir/publisher fhir-core/7.0.7-SNAPSHOT', true, 'publisher', '7.0.7-SNAPSHOT'],
    ['fhir/publisher fhir-core/(unknown)', true, 'publisher', null],
    ['fhir/publisher/2.1.4 fhir-core/7.0.8', true, 'publisher', '7.0.8'],
    ['fhir/publisher/2.1.4', true, 'publisher', null],
    ['fhir/validator/6.5.27', true, 'validator', '6.5.27'],
    ['fhir/validator/7.0.7 fhir-core/7.0.7', true, 'validator', '7.0.7'],
    ['fhir/main-build', true, 'main-build', null],
    ['hapi-fhir-tooling-client', true, 'fhir-core', null],
    ['fhir-core/7.0.7', true, 'fhir-core', '7.0.7'],
    ['okhttp/5.3.2', false, null, null],
    ['HAPI-FHIR/8.12.1 (FHIR Client; FHIR 4.0.1/R4; apache)', false, null, null],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36', false, null, null],
    ['fhirsmith/1.0', false, null, null],
    ['ecosystem.hl7.org/1.0', false, null, null],
    ['', false, null, null],
    [undefined, false, null, null]
  ])('%s', (agent, fhirTool, tool, version) => {
    expect(identifyClient(agent)).toEqual({ fhirTool, tool, version });
  });
});

describe('isOldTool', () => {
  test('true: a FHIR tool that does not say its version', () => {
    expect(isOldTool(identifyClient('fhir/publisher'), true)).toBe(true);
    expect(isOldTool(identifyClient('hapi-fhir-tooling-client'), true)).toBe(true);
    expect(isOldTool(identifyClient('fhir/publisher fhir-core/(unknown)'), true)).toBe(true);
    expect(isOldTool(identifyClient('fhir/publisher fhir-core/7.0.7'), true)).toBe(false);
    expect(isOldTool(identifyClient('fhir/validator/6.5.27'), true)).toBe(false);
    expect(isOldTool(identifyClient('okhttp/5.3.2'), true)).toBe(false); // not a FHIR tool at all
  });

  test('a version: that, or older', () => {
    expect(isOldTool(identifyClient('fhir/validator/6.5.27'), '7.0.7')).toBe(true);
    expect(isOldTool(identifyClient('fhir/publisher fhir-core/7.0.7-SNAPSHOT'), '7.0.7')).toBe(false);
    expect(isOldTool(identifyClient('fhir/publisher fhir-core/7.1.0'), '7.0.7')).toBe(false);
    expect(isOldTool(identifyClient('fhir/publisher'), '7.0.7')).toBe(true);
    expect(isOldTool(identifyClient('fhir/publisher'), false)).toBe(false);
  });

  test('versions compare by their numbers', () => {
    expect(compareVersions('7.0.7', '7.0.10')).toBe(-1);
    expect(compareVersions('7.1', '7.0.9')).toBe(1);
    expect(compareVersions('7.0.7-SNAPSHOT', '7.0.7')).toBe(0);
  });
});
