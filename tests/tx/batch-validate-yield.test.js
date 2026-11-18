/**
 * $batch-validate-code gives the event loop a turn between entries.
 *
 * Validating one entry never yields by itself, so a 1,000-entry batch from an IG build used to
 * hold the event loop for its whole duration (~1 s on production hardware), and every other
 * request arriving meanwhile waited for it (a single lookup typically waited 0.4-0.9 s).
 * processBatch now calls checkAndYield before each entry; checkAndYield only actually yields
 * after YIELD_INTERVAL ms of compute, so small batches are unaffected.
 */
const request = require('supertest');
const { getTestApp, shutdownTestApp } = require('./setup');
const { OperationContext } = require('../../tx/operation-context');

const CS_URL = 'http://example.org/fhir/CodeSystem/batch-yield-cs';
const CS = {
  resourceType: 'CodeSystem', url: CS_URL, version: '1.0.0', status: 'active', content: 'complete',
  concept: [{ code: 'a', display: 'Alpha' }, { code: 'b', display: 'Beta' }]
};
const entry = (code) => ({ name: 'validation', resource: { resourceType: 'Parameters', parameter: [{ name: 'code', valueCode: code }] } });

describe('$batch-validate-code yields between entries', () => {
  let app;
  beforeAll(async () => { app = await getTestApp(); }, 60000);
  afterAll(async () => { await shutdownTestApp(); });

  test('checkAndYield is called once per entry and the results are unchanged', async () => {
    const spy = jest.spyOn(OperationContext.prototype, 'checkAndYield');
    try {
      const codes = ['a', 'zz', 'b', 'a', 'b'];
      const res = await request(app).post('/tx/r5/CodeSystem/$batch-validate-code')
        .set('Content-Type', 'application/json')
        .send({ resourceType: 'Parameters', parameter: [{ name: 'tx-resource', resource: CS }, { name: 'url', valueUri: CS_URL }, ...codes.map(entry)] });
      expect(res.status).toBe(200);
      const calls = spy.mock.calls.filter((c) => c[0] === 'batch-validate').length;
      expect(calls).toBe(codes.length);
      const results = res.body.parameter.map((r) => r.resource.parameter.find((p) => p.name === 'result').valueBoolean);
      expect(results).toEqual([true, false, true, true, true]);
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * The check between entries is inside each entry's try: the time limit tripping there is that
 * entry's too-costly and the entries already answered keep their answers, while a memory abort
 * there stops the whole batch (answering the rest would only allocate more). These use the real
 * checks, reached through checkAndYield; only the validations are stand-ins.
 */
describe('$batch-validate-code: what the check between entries stops', () => {
  const { Languages, LanguageDefinitions } = require('../../library/languages');
  const { I18nSupport } = require('../../library/i18nsupport');
  const { BatchValidateWorker } = require('../../tx/workers/batch-validate');
  const { ValidateWorker } = require('../../tx/workers/validate');
  const memoryGuard = require('../../library/memory-guard');

  const languages = new LanguageDefinitions();
  const i18n = new I18nSupport('.', languages);
  const answer = () => ({ resourceType: 'Parameters', parameter: [{ name: 'result', valueBoolean: true }] });

  function run(ctx, count) {
    const worker = new BatchValidateWorker(ctx, { error: jest.fn(), debug: jest.fn() }, {}, languages, i18n);
    const req = { headers: {}, body: { resourceType: 'Parameters', parameter: Array.from({ length: count }, () => entry('a')) } };
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json: jest.fn() };
    return worker.handleCodeSystem(req, res).then(() => res);
  }

  function context() {
    const ctx = new OperationContext(new Languages(languages), i18n, 'batch-yield', 30);
    ctx.debugging = false; // a debugger attached to jest would otherwise disable the checks
    return ctx;
  }

  // the checks are sampled (one deadCheck in CHECK_FREQUENCY looks at the clock and memory): make the next one look
  const sampleNextCheck = () => { OperationContext._checkCounter = 1000; };

  afterEach(() => jest.restoreAllMocks());

  test('the time limit at the check is that entry\'s too-costly; the entries before keep their answers', async () => {
    const ctx = context();
    let n = 0;
    const validate = jest.spyOn(ValidateWorker.prototype, 'handleCodeSystemInner').mockImplementation(async () => {
      if (++n === 2) {
        ctx._clock.compute += 60 * 1000; // this entry used up the 30 s
        sampleNextCheck();
      }
      return answer();
    });
    const res = await run(ctx, 3);
    expect(validate).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(200);
    const entries = res.json.mock.calls[0][0].parameter;
    expect(entries.map(e => e.resource.resourceType)).toEqual(['Parameters', 'Parameters', 'OperationOutcome']);
    expect(entries[2].resource.issue[0].code).toBe('too-costly');
  });

  test('a memory abort at the check stops the whole batch, with an OperationOutcome', async () => {
    const ctx = context();
    const validate = jest.spyOn(ValidateWorker.prototype, 'handleCodeSystemInner').mockImplementation(async () => {
      jest.spyOn(memoryGuard, 'overAbortThreshold').mockReturnValue(10 * 1024 ** 3);
      sampleNextCheck();
      return answer();
    });
    const res = await run(ctx, 3);
    expect(validate).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(422);
    const body = res.json.mock.calls[0][0];
    expect(body.resourceType).toBe('OperationOutcome');
    expect(body.issue[0].code).toBe('too-costly');
  });
});
