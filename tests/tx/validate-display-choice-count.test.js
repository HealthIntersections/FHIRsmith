/**
 * The wrong-display message "Valid display is one of N choices: ..." says how many
 * choices it lists. The count used to come from Designations.displayCount(), which counts
 * only the best kind of language match, while the list comes from present(), which matches
 * by language alone: for 'en', a concept with displays in 'en' and 'en-GB' was reported as
 * "one of 2 choices" followed by three, and for 'en-GB' the single-choice wording was used
 * in front of a list of three.
 */

const { ValidateWorker } = require('../../tx/workers/validate');
const { CodeSystem } = require('../../tx/library/codesystem');
const { FhirCodeSystemProvider } = require('../../tx/cs/cs-cs');
const ValueSet = require('../../tx/library/valueset');
const { Languages } = require('../../library/languages');
const { OperationContext } = require('../../tx/operation-context');
const { TestUtilities } = require('../test-utilities');
const { TxParameters } = require('../../tx/params');

const mockLog = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const URL = 'http://example.org/devices';

function devicesCS() {
  return new CodeSystem({
    resourceType: 'CodeSystem', url: URL, version: '1.0.0', name: 'Devices', status: 'active',
    language: 'en', caseSensitive: true, content: 'complete',
    concept: [
      {
        code: 'analyzer', display: 'Oxygen analyzer',
        designation: [
          { language: 'en', value: 'O2 analyzer' },
          { language: 'en-GB', value: 'Oxygen analyser' }
        ]
      },
      {
        code: 'monitor', display: 'Monitor',
        designation: [{ language: 'en-GB', value: 'Display unit' }]
      },
      { code: 'pump', display: 'Pump' }
    ]
  });
}

function provider() {
  return {
    getCodeSystem: (c, url) => url === URL ? devicesCS().jsonObj : null,
    getCodeSystemProvider: (c, url, version, supps) =>
      url === URL ? new FhirCodeSystemProvider(c, devicesCS(), supps || []) : null,
    getCodeSystemById: () => null,
    findValueSet: () => null,
    getValueSetById: () => null,
    loadSupplements: () => []
  };
}

function message(result) {
  return (result.parameter.find(p => p.name === 'message') || {}).valueString;
}

describe('wrong-display message counts the choices it lists', () => {
  let worker, opContext, txp;

  beforeEach(async () => {
    jest.clearAllMocks();
    const langDefs = await TestUtilities.loadLanguageDefinitions();
    const i18n = await TestUtilities.loadTranslations(langDefs);
    opContext = new OperationContext(new Languages(), i18n);
    worker = new ValidateWorker(opContext, mockLog, provider(), langDefs, i18n);
    // validating = true, as $validate-code sets it: without it an implicit "*" is added to
    // the working languages, every designation matches fully, and the bug does not show
    txp = new TxParameters(opContext.i18n.languageDefinitions, opContext.i18n, true);
  });

  function language(lang) {
    txp.readParams({
      resourceType: 'Parameters',
      parameter: [{ name: '__Accept-Language', valueCode: lang }]
    });
  }

  async function validateCS(code) {
    const coded = { coding: [{ system: URL, code, display: 'Wrong' }] };
    const csp = new FhirCodeSystemProvider(opContext, devicesCS(), []);
    return message(await worker.doValidationCS(coded, csp, txp, { issuePath: 'Coding', mode: 'coding' }));
  }

  async function validateVS(code) {
    const coded = { coding: [{ system: URL, code, display: 'Wrong' }] };
    const valueSet = new ValueSet({
      resourceType: 'ValueSet', url: 'http://example.org/ValueSet/devices',
      compose: { include: [{ system: URL }] }
    });
    return message(await worker.doValidationVS(coded, valueSet, txp, 'coded', 'Coding'));
  }

  for (const [name, validate] of [['CodeSystem', validateCS], ['ValueSet', validateVS]]) {
    test(`${name}: two 'en' displays and one 'en-GB' are three choices`, async () => {
      language('en');
      const m = await validate('analyzer');
      expect(m).toContain("one of 3 choices: 'Oxygen analyzer' (en), 'O2 analyzer' (en) or 'Oxygen analyser' (en-GB)");
    });

    test(`${name}: one 'en' display and one 'en-GB' are two choices`, async () => {
      language('en');
      const m = await validate('monitor');
      expect(m).toContain("one of 2 choices: 'Monitor' (en) or 'Display unit' (en-GB)");
    });

    test(`${name}: for 'en-GB', three listed choices are not worded as one`, async () => {
      language('en-GB');
      const m = await validate('analyzer');
      expect(m).toContain("one of 3 choices: 'Oxygen analyzer' (en), 'O2 analyzer' (en) or 'Oxygen analyser' (en-GB)");
    });

    test(`${name}: a single display is not counted`, async () => {
      language('en');
      const m = await validate('pump');
      expect(m).toContain("Valid display is 'Pump' (en) (for the language(s) 'en')");
    });
  }
});
