/**
 * checkConceptSet honours the operation's time limit while it looks for a listed code
 * written in another form.
 *
 * When the code being validated is not one of an include's listed codes and the code system
 * says the code has another form (ICD-11 short code vs uri), checkConceptSet asks, for every
 * listed code, whether the two are the same concept (sameConceptDifferentForm): locate() calls
 * per listed code. The loop had no deadline check, so with a slow code system it ran to the
 * end, however long that took, before the next loop noticed the time limit had passed.
 */

const { Languages } = require('../../library/languages');
const { OperationContext } = require('../../tx/operation-context');
const { Renderer } = require('../../tx/library/renderer');
const { ValueSetChecker } = require('../../tx/workers/validate');

/** Burn CPU synchronously for ms milliseconds (the deadline is charged in compute time). */
function spin(ms) {
  const end = performance.now() + ms;
  while (performance.now() < end) { /* burn */ }
}

/** A code system whose codes have another form (as ICD-11's do), where every lookup costs 1 ms of compute. */
function slowCodeSystem() {
  const cs = {
    locates: 0,
    async locate(code) {
      cs.locates++;
      spin(1);
      return { context: { code }, message: undefined };
    },
    async classificationCode() { return 'other-form'; },
    async prefetchCodes() { return null; }, // (CodeSystemProvider's default: no prefetching)
    async code(context) { return context.code; },
    system: () => 'http://example.org/slow',
    version: () => null
  };
  return cs;
}

function checkerFor(opContext) {
  // only the parts of a ValueSetChecker that checkConceptSet uses on this path
  const checker = Object.create(ValueSetChecker.prototype);
  checker.worker = {
    opContext,
    renderer: new Renderer(null, null, null),
    deadCheck: (place) => opContext.deadCheck(place)
  };
  checker.valueSet = { vurl: 'http://example.org/vs' };
  checker.params = {};
  checker.indentCount = 0;
  return checker;
}

describe('checkConceptSet deadline', () => {
  test('stops looking for another form of the code once the time limit has passed', async () => {
    const LISTED = 3000; // ~3 s of lookups at 1 ms each
    const opContext = new OperationContext(Languages.fromAcceptLanguage('en'), null, null, 0.2); // 200 ms
    opContext.debugging = false; // a debugger attached to jest would otherwise disable the check
    const cs = slowCodeSystem();
    const cset = { system: 'http://example.org/slow', concept: Array.from({ length: LISTED }, (_, i) => ({ code: 'c' + i })) };

    const start = performance.now();
    let error = null;
    try {
      await checkerFor(opContext).checkConceptSet('Coding', 'in', cs, cset, 'not-listed', null,
        { vurl: 'http://example.org/vs' }, null, {}, {}, {}, null, null, []);
    } catch (e) {
      error = e;
    }
    const took = performance.now() - start;

    expect(error).not.toBeNull();
    expect(error.message).toContain('Operation exceeded time limit');
    expect(error.message).toContain('checkConceptSet#3');
    // the check is sampled (every CHECK_FREQUENCY calls), so a few hundred lookups past
    // the limit, not all 3,000 of them
    expect(cs.locates).toBeLessThan(LISTED / 2);
    expect(took).toBeLessThan(1500);
  });
});
