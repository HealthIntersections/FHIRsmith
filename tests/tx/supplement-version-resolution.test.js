/**
 * CodeSystem/$validate-code with useSupplement and no version (#387): which supplements apply
 * depends on the version the code system turns out to be, not just on the version asked for.
 *
 * - a supplement the server holds, pinned to the version it has (supplements = url|version),
 *   applies - it used to be reported as missing (VALUESET_SUPPLEMENT_MISSING), because the
 *   server's supplements were looked up against the empty version
 * - a supplement passed in tx-resource, pinned to another version, doesn't apply - so requiring
 *   it fails (it used to be applied, because with no version every pinned one matched)
 */

const { ValidateWorker } = require('../../tx/workers/validate');
const { CodeSystem } = require('../../tx/library/codesystem');
const { FhirCodeSystemProvider } = require('../../tx/cs/cs-cs');
const { Languages } = require('../../library/languages');
const { OperationContext } = require('../../tx/operation-context');
const { TestUtilities } = require('../test-utilities');

const BASE = 'http://example.org/fhir/CodeSystem/svr-base';
const VERSION = '2019-covid-expanded';
const SUPP_HERE = 'http://example.org/fhir/CodeSystem/svr-base-da';
const SUPP_OTHER = 'http://example.org/fhir/CodeSystem/svr-base-fr-old';

const baseCS = () => new CodeSystem({
  resourceType: 'CodeSystem', url: BASE, version: VERSION, status: 'active', content: 'complete',
  concept: [{ code: 'c1', display: 'Code One' }, { code: 'c2', display: 'Code Two' }]
});

const supplement = (url, pinnedTo, lang, display) => ({
  resourceType: 'CodeSystem', url, version: '1.0.0', status: 'active', content: 'supplement',
  supplements: BASE + '|' + pinnedTo, language: lang,
  concept: [{ code: 'c1', designation: [{ language: lang, value: display }] }]
});

// the server holds the Danish supplement, pinned to the version it has
const serverSupplement = new CodeSystem(supplement(SUPP_HERE, VERSION, 'da', 'Kode En'));

const mockProvider = {
  getCodeSystemProvider: jest.fn((opContext, url, version, supplements) => {
    if (url === BASE && (!version || version === VERSION)) {
      return new FhirCodeSystemProvider(opContext, baseCS(), supplements);
    }
    return null;
  }),
  // as the library does it: a server supplement matches only a version it's pinned to
  loadSupplements: jest.fn((url, version) => (serverSupplement.isSupplementFor(url, version) ? [serverSupplement] : [])),
  listCodeSystemVersions: jest.fn(async (url) => (url === BASE ? [VERSION] : [])),
  findValueSet: jest.fn(() => null),
  getCodeSystem: jest.fn(() => null),
  getFhirVersion: () => '5.0.0'
};

const log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

describe('CodeSystem/$validate-code: supplements fit the version found (#387)', () => {
  let worker;

  beforeEach(async () => {
    const langDefs = await TestUtilities.loadLanguageDefinitions();
    const i18n = await TestUtilities.loadTranslations(langDefs);
    const opContext = new OperationContext(new Languages(), i18n);
    worker = new ValidateWorker(opContext, log, mockProvider, langDefs, i18n);
  });

  const validate = async (parameter) => {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    await worker.handleCodeSystem({ method: 'POST', query: {}, params: {}, body: { resourceType: 'Parameters', parameter } }, res);
    return { status: res.status.mock.calls[0][0], body: res.json.mock.calls[0][0] };
  };
  const param = (body, name) => body.parameter && body.parameter.find(p => p.name === name);

  test('a server supplement pinned to the version the server has applies, with no version asked for', async () => {
    const { status, body } = await validate([
      { name: 'url', valueUri: BASE },
      { name: 'code', valueCode: 'c1' },
      { name: 'useSupplement', valueCanonical: SUPP_HERE }
    ]);
    expect(status).toBe(200);
    expect(param(body, 'result').valueBoolean).toBe(true);
    expect(param(body, 'version').valueString).toBe(VERSION);
  });

  test('and with the version asked for', async () => {
    const { status, body } = await validate([
      { name: 'url', valueUri: BASE },
      { name: 'version', valueString: VERSION },
      { name: 'code', valueCode: 'c1' },
      { name: 'useSupplement', valueCanonical: SUPP_HERE }
    ]);
    expect(status).toBe(200);
    expect(param(body, 'result').valueBoolean).toBe(true);
  });

  test('a tx-resource supplement pinned to another version doesn\'t apply, so requiring it fails', async () => {
    const { status, body } = await validate([
      { name: 'url', valueUri: BASE },
      { name: 'code', valueCode: 'c1' },
      { name: 'useSupplement', valueCanonical: SUPP_OTHER },
      { name: 'tx-resource', resource: supplement(SUPP_OTHER, '2016', 'fr', 'Code Un') }
    ]);
    expect(status).toBe(422);
    expect(JSON.stringify(body)).toContain('VALUESET_SUPPLEMENT_MISSING');
  });
});
