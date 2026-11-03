/**
 * $batch-validate-code memory: an entry's providers, context and log must be
 * released when the entry is answered, not held until the whole batch ends; and
 * the log note for a large include must not list every code.
 *
 * Before this, a 1,000-entry batch against a 33,341-code value set (VSAC Medication
 * Brand Name) ran out of heap: each entry's two log notes listed every code
 * (~250 KB each), and the batch's shared provider list kept every entry's provider,
 * and through it the entry's context and log, reachable until the batch ended.
 */

const { Languages } = require('../../library/languages');
const { OperationContext } = require('../../tx/operation-context');
const { Renderer, MAX_INCLUDE_CODES_SHOWN } = require('../../tx/library/renderer');

// A fake ValidateWorker: each entry opens a provider on its context (as the real one
// does through findCodeSystem -> registerProvider) and writes a large note to the log.
const opened = [];
jest.mock('../../tx/workers/validate', () => {
  class FakeValidateWorker {
    constructor(opContext) {
      this.opContext = opContext;
    }
    async handleValueSetInner() {
      const provider = {
        closed: false,
        closeCount: 0,
        opContext: this.opContext,
        close() { this.closed = true; this.closeCount++; }
      };
      opened.push(provider);
      this.opContext.registerProvider(provider);
      this.opContext.addNote(null, 'x'.repeat(100000));
      // what the batch holds open while this entry is being answered
      const live = opened.filter(p => !p.closed).length;
      return { resourceType: 'Parameters', parameter: [{ name: 'live', valueInteger: live }] };
    }
  }
  return { ValidateWorker: FakeValidateWorker };
});

const { BatchValidateWorker } = require('../../tx/workers/batch-validate');

function fakeRes() {
  return { statusCode: 200, body: null, status(s) { this.statusCode = s; return this; }, json(b) { this.body = b; return this; } };
}

describe('$batch-validate-code releases each entry when it is answered', () => {
  beforeEach(() => { opened.length = 0; });

  test('an entry\'s providers are closed before the next entry runs, and none are left on the batch', async () => {
    const opContext = new OperationContext(Languages.fromAcceptLanguage('en'));
    const log = { error: jest.fn(), info: jest.fn(), warn: jest.fn() };
    const worker = new BatchValidateWorker(opContext, log, null, null, null);
    worker.addHttpParams = () => {};

    const N = 50;
    const parameter = [{ name: 'url', valueUri: 'http://example.org/vs' }];
    for (let i = 0; i < N; i++) {
      parameter.push({ name: 'validation', resource: { resourceType: 'Parameters', parameter: [{ name: 'code', valueCode: 'c' + i }] } });
    }
    const res = fakeRes();
    await worker.processBatch({ body: { resourceType: 'Parameters', parameter } }, res, worker.valueSetGlobalNames, false);

    expect(res.body.parameter).toHaveLength(N);
    // while each entry ran, only its own provider was open: no per-entry accumulation
    expect(res.body.parameter.map(p => p.resource.parameter[0].valueInteger)).toEqual(new Array(N).fill(1));
    expect(opened).toHaveLength(N);
    expect(opened.every(p => p.closed)).toBe(true);
    // nothing from the entries is left on the batch's own context: closing its
    // providers closes none of theirs a second time
    await opContext.closeProviders();
    expect(opened.every(p => p.closeCount === 1)).toBe(true);
    expect(opContext.logEntries).toHaveLength(0);
  });

  test('an entry that fails still has its providers closed', async () => {
    const { ValidateWorker } = require('../../tx/workers/validate');
    const spy = jest.spyOn(ValidateWorker.prototype, 'handleValueSetInner').mockImplementation(async function () {
      const provider = { closed: false, close() { this.closed = true; } };
      opened.push(provider);
      this.opContext.registerProvider(provider);
      throw new Error('boom');
    });
    try {
      const opContext = new OperationContext(Languages.fromAcceptLanguage('en'));
      const worker = new BatchValidateWorker(opContext, { error: jest.fn() }, null, null, null);
      worker.addHttpParams = () => {};
      const res = fakeRes();
      await worker.processBatch({ body: { resourceType: 'Parameters', parameter: [
        { name: 'url', valueUri: 'http://example.org/vs' },
        { name: 'validation', resource: { resourceType: 'Parameters', parameter: [{ name: 'code', valueCode: 'a' }] } },
        { name: 'validation', resource: { resourceType: 'Parameters', parameter: [{ name: 'code', valueCode: 'b' }] } }
      ] } }, res, worker.valueSetGlobalNames, false);
      expect(res.body.parameter.map(p => p.resource.resourceType)).toEqual(['OperationOutcome', 'OperationOutcome']);
      expect(opened).toHaveLength(2);
      expect(opened.every(p => p.closed)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('OperationContext.copy and the provider list', () => {
  test('a copy shares the parent\'s provider list by default', async () => {
    const parent = new OperationContext(Languages.fromAcceptLanguage('en'));
    const child = parent.copy();
    const p = { closed: false, close() { this.closed = true; } };
    child.registerProvider(p);
    await parent.closeProviders();
    expect(p.closed).toBe(true);
  });

  test('a copy with ownProviders keeps its providers to itself', async () => {
    const parent = new OperationContext(Languages.fromAcceptLanguage('en'));
    const child = parent.copy({ ownProviders: true });
    const p = { closed: false, close() { this.closed = true; } };
    child.registerProvider(p);
    await parent.closeProviders();
    expect(p.closed).toBe(false);
    await child.closeProviders();
    expect(p.closed).toBe(true);
  });
});

describe('Renderer.displayValueSetInclude summarises a large include', () => {
  const renderer = new Renderer(null, null, null);
  const SYS = 'http://www.nlm.nih.gov/research/umls/rxnorm';

  test('a short include is written in full, as before', () => {
    expect(renderer.displayValueSetInclude({ system: SYS, concept: [{ code: 'a' }, { code: 'b' }, { code: 'c' }] }))
      .toBe('(' + SYS + ')(a,b,c)');
    expect(renderer.displayValueSetInclude({ system: SYS, filter: [{ property: 'concept', op: 'is-a', value: 'x' }] }))
      .toBe('(' + SYS + ')(conceptis-ax)');
  });

  test('an include of exactly the limit is written in full', () => {
    const concept = Array.from({ length: MAX_INCLUDE_CODES_SHOWN }, (_, i) => ({ code: String(i) }));
    expect(renderer.displayValueSetInclude({ system: SYS, concept }))
      .toBe('(' + SYS + ')(' + concept.map(c => c.code).join(',') + ')');
  });

  test('a 33,341-code include gives a short note with the first codes and the count', () => {
    const concept = Array.from({ length: 33341 }, (_, i) => ({ code: String(1000000 + i) }));
    const s = renderer.displayValueSetInclude({ system: SYS, concept });
    expect(s.length).toBeLessThan(500);
    expect(s.startsWith('(' + SYS + ')(1000000,1000001,')).toBe(true);
    expect(s).toContain('+' + (33341 - MAX_INCLUDE_CODES_SHOWN) + ' more (33341 codes)');
    expect(s).not.toContain(String(1000000 + MAX_INCLUDE_CODES_SHOWN));
  });
});
