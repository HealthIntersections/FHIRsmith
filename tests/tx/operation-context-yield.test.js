/**
 * OperationContext checkAndYield tests
 *
 * checkAndYield is the cooperative-multitasking primitive added after the
 * 2026-07-30 tx.fhir.org incident: long terminology operations run on the one
 * Node event loop, and without yielding, a single heavy $expand blocks every
 * other request (including /metadata) for its full duration. These tests pin:
 *  - compute is sliced: the event loop gets turns during a long computation
 *  - the operation deadline is charged against compute time, not wall-clock,
 *    so concurrent operations time-sharing the loop don't abort each other
 *  - a compute overrun still aborts with too-costly
 *  - an operation whose client has disconnected aborts at its next yield
 */

const path = require('path');
const { OperationContext } = require('../../tx/operation-context');
const { LanguageDefinitions } = require('../../library/languages');
const { I18nSupport } = require('../../library/i18nsupport');

jest.setTimeout(30000);

let i18n;

beforeAll(async () => {
  const langDefs = await LanguageDefinitions.fromFiles(path.resolve(__dirname, '../../tx/data'));
  i18n = new I18nSupport(path.resolve(__dirname, '../../translations'), langDefs);
  await i18n.load();
});

function makeContext(timeLimitSeconds) {
  return new OperationContext('en', i18n, null, timeLimitSeconds);
}

/** Burn CPU synchronously for ms milliseconds. */
function spin(ms) {
  const end = performance.now() + ms;
  while (performance.now() < end) { /* burn */ }
}

describe('OperationContext.checkAndYield', () => {

  test('lets the event loop run during a long computation', async () => {
    const ctx = makeContext(30);
    let ticks = 0;
    const interval = setInterval(() => ticks++, 5);
    try {
      // Control: synchronous compute starves the timer - no callback can run
      // between here and the assertion because nothing yields.
      const before = ticks;
      spin(120);
      expect(ticks).toBe(before);

      // The same amount of compute interleaved with checkAndYield gives the
      // event loop turns, so the timer fires while we "work".
      const start = performance.now();
      while (performance.now() - start < 120) {
        spin(5);
        await ctx.checkAndYield('test-loop');
      }
      expect(ticks).toBeGreaterThan(before);
    } finally {
      clearInterval(interval);
    }
  });

  test('deadline is charged against compute time, not wall-clock', async () => {
    // Two operations time-sharing the loop: each does ~250ms of compute, so
    // together they take >=500ms of wall time - but each op's own budget is
    // only charged for its slices. Under the old wall-clock deadline, ops
    // running concurrently would move each other toward abort; under the
    // compute deadline they don't.
    const budgetSeconds = 10;
    const ctxA = makeContext(budgetSeconds);
    const ctxB = makeContext(budgetSeconds);

    async function work(ctx, computeMs) {
      const sliceMs = 5;
      for (let done = 0; done < computeMs; done += sliceMs) {
        spin(sliceMs);
        await ctx.checkAndYield('shared-loop');
      }
      // Snapshot at completion: computeElapsed includes the currently-open
      // slice, so reading it later (while the other op still runs) would
      // overstate this op's charge.
      return ctx.computeElapsed();
    }

    const wallStart = performance.now();
    const [computeA, computeB] = await Promise.all([work(ctxA, 250), work(ctxB, 250)]);
    const wall = performance.now() - wallStart;

    // Both ran to completion; total wall time covers both ops' compute...
    expect(wall).toBeGreaterThanOrEqual(450);
    // ...but each op was only charged (roughly) its own compute, not the time
    // it spent suspended while the other op held the loop.
    expect(computeA).toBeLessThan(wall - 100);
    expect(computeB).toBeLessThan(wall - 100);
    expect(computeA).toBeGreaterThanOrEqual(200);
    expect(computeB).toBeGreaterThanOrEqual(200);
  });

  test('a compute overrun still aborts with too-costly', async () => {
    const ctx = makeContext(0.15); // 150ms compute budget
    let error = null;
    try {
      const guard = performance.now() + 10000; // never loop forever on failure
      while (performance.now() < guard) {
        spin(5);
        await ctx.checkAndYield('overrun-loop');
      }
    } catch (e) {
      error = e;
    }
    expect(error).not.toBeNull();
    expect(error.cause).toBe('too-costly');
    // The sentence is the message, not the message id: Issue's fourth argument is msgId
    // and its fifth is the message, and these sites used to pass the text as the fourth.
    // That left details.text empty, so the HTML rendering fell back to the timing trace
    // and the user was told "[too-costly] 0ms tx-op 1ms start working".
    expect(error.message).toMatch(/exceeded time limit/);
    expect(error.msgId).toBeFalsy();
    expect(error.asIssue().details.text).toMatch(/exceeded time limit/);
    expect(error.abandoned).toBeUndefined();
  });

  test('aborts at the next yield when the client has disconnected', async () => {
    const ctx = makeContext(30);
    ctx.markClientGone();
    let error = null;
    try {
      const guard = performance.now() + 10000;
      while (performance.now() < guard) {
        spin(5);
        await ctx.checkAndYield('abandoned-loop');
      }
    } catch (e) {
      error = e;
    }
    expect(error).not.toBeNull();
    expect(error.abandoned).toBe(true);
    expect(error.message).toMatch(/client disconnected/);
    expect(error.msgId).toBeFalsy();
    expect(error.asIssue().details.text).toMatch(/client disconnected/);
  });

  test('copy() shares the compute budget with sub-operations', async () => {
    const ctx = makeContext(0.15); // 150ms shared budget
    let error = null;
    try {
      const guard = performance.now() + 10000;
      while (performance.now() < guard) {
        // Alternate compute between the parent and a copy (as batch processing
        // does per entry): the budget must be drawn down jointly, so the batch
        // as a whole is bounded, not each entry separately.
        const sub = ctx.copy();
        spin(5);
        await ctx.checkAndYield('parent-loop');
        spin(5);
        await sub.checkAndYield('sub-loop');
      }
    } catch (e) {
      error = e;
    }
    expect(error).not.toBeNull();
    expect(error.cause).toBe('too-costly');
  });
});

describe('OperationContext.waitFor', () => {

  test('does not charge waiting to the compute deadline', async () => {
    const ctx = makeContext(1); // 1 second of compute
    spin(200);
    const before = ctx.computeElapsed();
    await ctx.waitFor(new Promise(resolve => setTimeout(resolve, 400)), 'test');
    const after = ctx.computeElapsed();
    // the 400ms wait is not compute: what accrued is the spin, not the wait
    expect(after).toBeLessThan(before + 100);
    expect(after).toBeGreaterThanOrEqual(190);
    ctx.deadCheck('after-wait'); // still inside its budget
  });

  test('returns what the promise resolved to', async () => {
    const ctx = makeContext(5);
    await expect(ctx.waitFor(Promise.resolve('value'), 'test')).resolves.toBe('value');
  });

  test('aborts if the client disconnected while waiting', async () => {
    const ctx = makeContext(5);
    const waiting = ctx.waitFor(new Promise(resolve => setTimeout(resolve, 50)), 'test');
    ctx.markClientGone();
    await expect(waiting).rejects.toMatchObject({ abandoned: true });
  });

  test('restores the compute slice when the promise rejects', async () => {
    const ctx = makeContext(5);
    await expect(ctx.waitFor(Promise.reject(new Error('nope')), 'test')).rejects.toThrow('nope');
    spin(50);
    expect(ctx.computeElapsed()).toBeLessThan(200);
  });
});
