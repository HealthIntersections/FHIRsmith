/**
 * An operation stops when its client disconnects, or memory is short (the guard's abort
 * threshold): at its next check, and the whole operation - a $batch-validate-code doesn't go
 * on to its next entry, and a $validate-code doesn't report the abort as its result.
 * Ordinary errors, and the time limit, still belong to the one entry.
 */
const { OperationContext } = require('../../tx/operation-context');
const { Languages, LanguageDefinitions } = require('../../library/languages');
const { I18nSupport } = require('../../library/i18nsupport');
const { BatchValidateWorker } = require('../../tx/workers/batch-validate');
const BatchWorker = require('../../tx/workers/batch');
const { ValidateWorker, ValueSetChecker } = require('../../tx/workers/validate');
const { TxParameters } = require('../../tx/params');
const ValueSet = require('../../tx/library/valueset');
const { Issue } = require('../../tx/library/operation-outcome');
const memoryGuard = require('../../library/memory-guard');

const languages = new LanguageDefinitions();
const i18n = new I18nSupport('.', languages);

function context() {
  const ctx = new OperationContext(new Languages(languages), i18n, 'cancellation', 30);
  ctx.debugging = false; // a debugger attached to jest would otherwise disable the checks
  return ctx;
}

function fakeRes() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json: jest.fn() };
}

function batch(ctx, count = 3) {
  const worker = new BatchValidateWorker(ctx, { error: jest.fn(), debug: jest.fn() }, {}, languages, i18n);
  const req = { headers: {}, body: { resourceType: 'Parameters', parameter: Array.from({ length: count }, () => ({
    name: 'validation', resource: { resourceType: 'Parameters', parameter: [{ name: 'code', valueCode: 'a' }] }
  })) } };
  const res = fakeRes();
  return { run: () => worker.handleCodeSystem(req, res), res };
}

const answer = () => ({ resourceType: 'Parameters', parameter: [{ name: 'result', valueBoolean: true }] });

/** the error a real check throws: the client gone, or memory over the abort threshold */
function abortFrom(ctx, kind) {
  if (kind === 'abandoned') {
    ctx.markClientGone();
  } else {
    jest.spyOn(memoryGuard, 'overAbortThreshold').mockReturnValue(10 * 1024 ** 3);
    OperationContext._checkCounter = 1000; // the memory check is sampled: make this one count
  }
  try {
    ctx.deadCheck('test');
  } catch (e) {
    return e;
  }
  throw new Error('no abort');
}

afterEach(() => jest.restoreAllMocks());

describe('the checks', () => {
  test('once the client has gone, the next deadCheck stops the operation, not only the next yield', async () => {
    const ctx = context();
    expect(ctx.deadCheck('before')).toBe(false);
    ctx.markClientGone();
    expect(() => ctx.deadCheck('after')).toThrow(/client disconnected/);
    await expect(ctx.checkAndYield('after')).rejects.toMatchObject({ abandoned: true });
  });

  test.each(['abandoned', 'memoryAbort'])('%s: handled as an OperationOutcome, 422', (kind) => {
    const error = abortFrom(context(), kind);
    expect(error[kind]).toBe(true);
    expect(error.isHandleAsOO()).toBe(true);
    expect(error.statusCode).toBe(422);
  });
});

describe('$batch-validate-code', () => {
  test.each(['abandoned', 'memoryAbort'])('%s in an entry stops the whole batch, with an OperationOutcome', async (kind) => {
    const ctx = context();
    const validate = jest.spyOn(ValidateWorker.prototype, 'handleCodeSystemInner')
      .mockResolvedValueOnce(answer())
      .mockImplementation(async () => { throw abortFrom(ctx, kind); });
    const b = batch(ctx);
    await b.run();
    expect(validate).toHaveBeenCalledTimes(2);
    expect(b.res.statusCode).toBe(422);
    expect(b.res.json.mock.calls[0][0].resourceType).toBe('OperationOutcome');
  });

  test('a disconnect is seen between entries that never yield themselves', async () => {
    const ctx = context();
    const validate = jest.spyOn(ValidateWorker.prototype, 'handleCodeSystemInner').mockImplementation(async () => {
      const until = performance.now() + 1;
      while (performance.now() < until) { /* a small synchronous validation */ }
      return answer();
    });
    // the client goes the first time the event loop gets a turn
    setImmediate(() => ctx.markClientGone());
    const b = batch(ctx, 500);
    await b.run();
    expect(validate.mock.calls.length).toBeLessThan(500);
    expect(b.res.statusCode).toBe(422);
  });

  test('an ordinary error belongs only to its entry', async () => {
    const error = new Issue('error', 'not-found', null, null, 'Unknown code system', 'not-found', 404);
    const validate = jest.spyOn(ValidateWorker.prototype, 'handleCodeSystemInner')
      .mockResolvedValueOnce(answer()).mockRejectedValueOnce(error).mockResolvedValueOnce(answer());
    const b = batch(context());
    await b.run();
    expect(validate).toHaveBeenCalledTimes(3);
    expect(b.res.statusCode).toBe(200);
    expect(b.res.json.mock.calls[0][0].parameter.map(e => e.resource.resourceType))
      .toEqual(['Parameters', 'OperationOutcome', 'Parameters']);
  });

  test('the time limit at the check between entries keeps the answers already made', async () => {
    const ctx = context();
    const timeout = new Issue('error', 'too-costly', null, null, 'Time limit exceeded', 'too-costly', 422);
    jest.spyOn(ctx, 'checkAndYield').mockResolvedValueOnce().mockRejectedValue(timeout);
    jest.spyOn(ValidateWorker.prototype, 'handleCodeSystemInner').mockResolvedValue(answer());
    const b = batch(ctx);
    await b.run();
    expect(b.res.statusCode).toBe(200);
    const entries = b.res.json.mock.calls[0][0].parameter;
    expect(entries.map(e => e.resource.resourceType)).toEqual(['Parameters', 'OperationOutcome', 'OperationOutcome']);
  });
});

describe('$batch', () => {
  function bundleBatch(ctx, handle, count = 3) {
    const worker = new BatchWorker(ctx, { error: jest.fn(), debug: jest.fn() }, {}, languages, i18n, { lookup: { handle } });
    const entry = { request: { method: 'GET', url: 'CodeSystem/$lookup?code=a' } };
    const res = fakeRes();
    return { run: () => worker.handle({ body: { resourceType: 'Bundle', type: 'batch', entry: Array(count).fill(entry) } }, res), res };
  }
  const ok = async (req, res) => res.status(200).json(answer());

  test.each(['abandoned', 'memoryAbort'])('%s in an entry stops the whole batch', async (kind) => {
    const ctx = context();
    const handle = jest.fn(ok).mockImplementationOnce(ok).mockImplementationOnce(async () => { throw abortFrom(ctx, kind); });
    const b = bundleBatch(ctx, handle);
    await b.run();
    expect(handle).toHaveBeenCalledTimes(2);
    expect(b.res.statusCode).toBe(422);
    expect(b.res.json.mock.calls[0][0].resourceType).toBe('OperationOutcome');
  });

  test('a disconnect is seen between entries that never yield themselves', async () => {
    const ctx = context();
    const handle = jest.fn(async (req, res) => {
      const until = performance.now() + 1;
      while (performance.now() < until) { /* a small synchronous lookup */ }
      return ok(req, res);
    });
    setImmediate(() => ctx.markClientGone());
    const b = bundleBatch(ctx, handle, 500);
    await b.run();
    expect(handle.mock.calls.length).toBeLessThan(500);
    expect(b.res.statusCode).toBe(422);
  });

  test('an ordinary error belongs only to its entry', async () => {
    const handle = jest.fn(ok).mockImplementationOnce(async () => { throw new Error('boom'); });
    const b = bundleBatch(context(), handle);
    await b.run();
    expect(b.res.statusCode).toBe(200);
    expect(b.res.json.mock.calls[0][0].entry.map(e => e.response.status)).toEqual(['500', '200', '200']);
  });
});

describe('$validate-code', () => {
  const params = { resourceType: 'Parameters', parameter: [{ name: 'coding', valueCoding: { system: 'http://example.org/cs', code: 'a' } }] };

  test.each(['abandoned', 'memoryAbort'])('%s in ValueSet preparation is not turned into result=false', async (kind) => {
    const ctx = context();
    const error = abortFrom(context(), kind); // thrown inside the preparation
    jest.spyOn(ValueSetChecker.prototype, 'prepare').mockRejectedValue(error);
    const worker = new ValidateWorker(ctx, { error: jest.fn(), debug: jest.fn() }, {}, languages, i18n);
    const vs = new ValueSet({ resourceType: 'ValueSet', url: 'http://example.org/vs', compose: { include: [] } });
    await expect(worker.doValidationVS({ coding: [{ code: 'a' }] }, vs, new TxParameters(languages, i18n, true), 'code', null)).rejects.toBe(error);
  });

  test.each(['abandoned', 'memoryAbort'])('%s: CodeSystem/$validate-code answers 422 with an OperationOutcome', async (kind) => {
    const ctx = context();
    const error = abortFrom(ctx, kind);
    jest.spyOn(ValidateWorker.prototype, 'resolveCodeSystem').mockRejectedValue(error);
    const worker = new ValidateWorker(ctx, { error: jest.fn(), debug: jest.fn() }, {}, languages, i18n);
    jest.spyOn(worker, 'buildParameters').mockReturnValue(params);
    const res = fakeRes();
    await worker.handleCodeSystem({ headers: {} }, res);
    expect(res.statusCode).toBe(422);
    expect(res.json.mock.calls[0][0].resourceType).toBe('OperationOutcome');
  });
});
