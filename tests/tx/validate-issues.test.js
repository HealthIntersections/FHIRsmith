/**
 * Regression tests for the validate.js issues that were previously emitted via a
 * non-existent `op.addIssueNoId(...)` helper (now `op.addIssue(new Issue(...))`
 * with a null msgId). Those calls would have thrown `op.addIssueNoId is not a
 * function` whenever their branch fired.
 *
 * There are two layers here:
 *  1. API-contract tests on Issue / OperationOutcome that lock in the shape the
 *     fix relies on (and would catch reintroduction of the bug).
 *  2. Integration tests that drive the worker into two of the fixed branches
 *     that are reachable through the public validation paths:
 *       - example-content code system  -> "vs-invalid" warning (validate.js ~1125)
 *       - incomplete-validation message -> "process-note"      (validate.js ~566)
 *     The other three fixed branches (~827, ~1525, ~1532) are fallback paths that
 *     are preempted by more specific translated messages in normal flows; the
 *     "does not crash" tests below exercise those surrounding paths so a fallback,
 *     if it ever fires, won't crash.
 *
 * All providers are in-memory FhirCodeSystemProvider instances, so no native
 * database is required.
 */

const { ValidateWorker } = require('../../tx/workers/validate');
const { CodeSystem } = require('../../tx/library/codesystem');
const { FhirCodeSystemProvider } = require('../../tx/cs/cs-cs');
const { OperationOutcome, Issue } = require('../../tx/library/operation-outcome');
const ValueSet = require('../../tx/library/valueset');
const { Languages } = require('../../library/languages');
const { OperationContext } = require('../../tx/operation-context');
const { TestUtilities } = require('../test-utilities');
const { TxParameters } = require('../../tx/params');

const mockLog = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const MESSAGE_ID_EXT = 'http://hl7.org/fhir/StructureDefinition/operationoutcome-message-id';

function adminGenderCS() {
  return new CodeSystem({
    resourceType: 'CodeSystem', url: 'http://hl7.org/fhir/administrative-gender',
    version: '5.0.0', name: 'AdministrativeGender', status: 'active',
    caseSensitive: true, content: 'complete',
    concept: [{ code: 'male', display: 'Male' }, { code: 'female', display: 'Female' }, { code: 'unknown', display: 'Unknown' }]
  });
}

// content: 'example' drives contentMode to 'example' during VS validation.
function exampleCS() {
  return new CodeSystem({
    resourceType: 'CodeSystem', url: 'http://example.org/example-cs',
    version: '1.0.0', name: 'ExampleCS', status: 'active',
    caseSensitive: true, content: 'example',
    concept: [{ code: 'a', display: 'A' }, { code: 'b', display: 'B' }]
  });
}

// Provider whose incompleteValidationMessage returns a message, so CS validation
// of a valid code emits a process-note.
class IncompleteProvider extends FhirCodeSystemProvider {
  async incompleteValidationMessage() {
    return 'Validation is incomplete: the concept model has not been checked';
  }
}

function provider(ctx, { incomplete = false } = {}) {
  const makeAdmin = (c, supps) => incomplete
    ? new IncompleteProvider(c, adminGenderCS(), supps || [])
    : new FhirCodeSystemProvider(c, adminGenderCS(), supps || []);
  return {
    getCodeSystem: (c, url) =>
      url === 'http://hl7.org/fhir/administrative-gender' ? adminGenderCS().jsonObj
        : url === 'http://example.org/example-cs' ? exampleCS().jsonObj : null,
    getCodeSystemProvider: (c, url, version, supps) =>
      url === 'http://hl7.org/fhir/administrative-gender' ? makeAdmin(c, supps)
        : url === 'http://example.org/example-cs' ? new FhirCodeSystemProvider(c, exampleCS(), supps || []) : null,
    getCodeSystemById: () => null,
    findValueSet: () => null,
    getValueSetById: () => null,
    loadSupplements: () => []
  };
}

function getIssues(result) {
  const p = (result.parameter || []).find(x => x.name === 'issues');
  return p && p.resource && p.resource.issue ? p.resource.issue : [];
}
const hasMsgIdExt = issue => (issue.extension || []).some(e => e.url === MESSAGE_ID_EXT);

describe('Issue / OperationOutcome API contract (locks in the addIssueNoId fix)', () => {
  test('OperationOutcome has addIssue but NOT addIssueNoId', () => {
    const op = new OperationOutcome();
    expect(typeof op.addIssue).toBe('function');
    expect(op.addIssueNoId).toBeUndefined();
  });

  test('an Issue with a null msgId serialises WITHOUT a message-id extension', () => {
    const op = new OperationOutcome();
    op.addIssue(new Issue('warning', 'not-found', 'code', null, 'a plain message', 'vs-invalid'));
    const issue = op.jsonObj.issue[0];
    expect(issue.severity).toBe('warning');
    expect(issue.details.text).toBe('a plain message');
    expect(issue.details.coding[0].code).toBe('vs-invalid');
    expect(hasMsgIdExt(issue)).toBe(false);
  });

  test('an Issue WITH a msgId serialises a message-id extension (contrast)', () => {
    const op = new OperationOutcome();
    op.addIssue(new Issue('error', 'invalid', 'code', 'SOME_MSG_ID', 'translated message', 'vs-invalid'));
    expect(hasMsgIdExt(op.jsonObj.issue[0])).toBe(true);
  });
});

describe('validate.js — reachable fixed branches', () => {
  let worker, opContext, txp;

  beforeEach(async () => {
    jest.clearAllMocks();
    const langDefs = await TestUtilities.loadLanguageDefinitions();
    const i18n = await TestUtilities.loadTranslations(langDefs);
    opContext = new OperationContext(new Languages(), i18n);
    worker = new ValidateWorker(opContext, mockLog, provider(opContext), langDefs, i18n);
    txp = new TxParameters(opContext.i18n.languageDefinitions, opContext.i18n);
    txp.readParams({ resourceType: 'Parameters', parameter: [{ name: '__Accept-Language', valueCode: 'en' }] });
  });

  test('example-content code system → "vs-invalid" warning with no message-id extension', async () => {
    const coded = { coding: [{ system: 'http://example.org/example-cs', code: 'a' }] };
    const valueSet = new ValueSet({
      resourceType: 'ValueSet', url: 'http://example.org/ValueSet/example',
      compose: { include: [{ system: 'http://example.org/example-cs' }] }
    });

    const result = await worker.doValidationVS(coded, valueSet, txp, 'coded', 'Coding');

    const issue = getIssues(result).find(i => i.details && i.details.text &&
      i.details.text.includes('did not contain enough information'));
    expect(issue).toBeDefined();
    expect(issue.severity).toBe('warning');
    expect(issue.details.coding.some(c => c.code === 'vs-invalid')).toBe(true);
    expect(hasMsgIdExt(issue)).toBe(false);
  });

  test('incomplete-validation message → "process-note" info with no message-id extension', async () => {
    const langDefs = await TestUtilities.loadLanguageDefinitions();
    const i18n = await TestUtilities.loadTranslations(langDefs);
    // worker whose provider resolves the code system to the incomplete provider
    const w = new ValidateWorker(opContext, mockLog, provider(opContext, { incomplete: true }), langDefs, i18n);

    const coded = { coding: [{ system: 'http://hl7.org/fhir/administrative-gender', code: 'male' }] };
    const csp = new IncompleteProvider(opContext, adminGenderCS(), []);
    const result = await w.doValidationCS(coded, csp, txp, { issuePath: 'Coding', mode: 'coding' });

    expect(result.parameter.find(p => p.name === 'result').valueBoolean).toBe(true);
    const issue = getIssues(result).find(i => i.details && i.details.coding &&
      i.details.coding.some(c => c.code === 'process-note'));
    expect(issue).toBeDefined();
    expect(issue.severity).toBe('information');
    expect(issue.details.text).toContain('Validation is incomplete');
    expect(hasMsgIdExt(issue)).toBe(false);
  });
});

describe('validate.js — invalid input does not crash (covers the fallback branches)', () => {
  let worker, opContext, txp;

  beforeEach(async () => {
    jest.clearAllMocks();
    const langDefs = await TestUtilities.loadLanguageDefinitions();
    const i18n = await TestUtilities.loadTranslations(langDefs);
    opContext = new OperationContext(new Languages(), i18n);
    worker = new ValidateWorker(opContext, mockLog, provider(opContext), langDefs, i18n);
    txp = new TxParameters(opContext.i18n.languageDefinitions, opContext.i18n);
    txp.readParams({ resourceType: 'Parameters', parameter: [{ name: '__Accept-Language', valueCode: 'en' }] });
  });

  test('unknown system validates to false with an error issue and does not throw', async () => {
    const coded = { coding: [{ system: 'http://unknown.example.org', code: 'x' }] };
    const valueSet = new ValueSet({
      resourceType: 'ValueSet', url: 'http://hl7.org/fhir/ValueSet/administrative-gender',
      compose: { include: [{ system: 'http://hl7.org/fhir/administrative-gender' }] }
    });

    let result;
    await expect((async () => { result = await worker.doValidationVS(coded, valueSet, txp, 'coded', 'Coding'); })()).resolves.toBeUndefined();
    expect(result.parameter.find(p => p.name === 'result').valueBoolean).toBe(false);
    expect(getIssues(result).some(i => i.severity === 'error')).toBe(true);
  });

  test('known code absent from the value set validates to false with an error issue', async () => {
    const coded = { coding: [{ system: 'http://hl7.org/fhir/administrative-gender', code: 'female' }] };
    const valueSet = new ValueSet({
      resourceType: 'ValueSet', url: 'http://example.org/ValueSet/just-male',
      compose: { include: [{ system: 'http://hl7.org/fhir/administrative-gender', concept: [{ code: 'male' }] }] }
    });

    const result = await worker.doValidationVS(coded, valueSet, txp, 'coded', 'Coding');
    expect(result.parameter.find(p => p.name === 'result').valueBoolean).toBe(false);
    const issue = getIssues(result).find(i => i.details && i.details.coding &&
      i.details.coding.some(c => c.code === 'not-in-vs'));
    expect(issue).toBeDefined();
  });
});
