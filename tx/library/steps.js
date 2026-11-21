'use strict';

/**
 * Work written once as a generator, run either straight through or letting other work run.
 *
 * A generator marks with `yield` the points where it may be paused. runSteps runs it to the end
 * at once (what a code system loaded at start-up wants); runStepsAsync calls pause() every
 * PAUSE_EVERY steps, which lets other requests run when the time is up (OperationContext
 * checkAndYield). That is how a large CodeSystem a client sends (tx-resource) is checked and
 * indexed, and hashed for the expansion cache key, without holding the event loop: the full
 * ICD-10-CM sent that way held tx.fhir.org's for 2 seconds (2026-11-20).
 */

// how many steps between calls to pause(): pause() is async, and only looks at the clock, so
// calling it every step would cost more than the steps
const PAUSE_EVERY = 256;

/**
 * Run a generator to the end
 * @param {Generator} steps
 * @returns {*} what the generator returns
 */
function runSteps(steps) {
  for (;;) {
    const r = steps.next();
    if (r.done) {
      return r.value;
    }
  }
}

/**
 * Run a generator to the end, calling pause() between steps
 * @param {Generator} steps
 * @param {Function} [pause] - async; lets other work run (when it's time to); may throw (the
 *   request has run out of time, or its client has gone), which ends the run
 * @param {Function} [onError] - turns an error the steps throw (not pause's) into the one thrown
 * @returns {Promise<*>} what the generator returns
 */
async function runStepsAsync(steps, pause = null, onError = null) {
  let n = 0;
  for (;;) {
    let r;
    try {
      r = steps.next();
    } catch (e) {
      throw onError ? onError(e) : e;
    }
    if (r.done) {
      return r.value;
    }
    if (pause && ++n % PAUSE_EVERY === 0) {
      await pause();
    }
  }
}

// --- JSON in pieces -------------------------------------------------------------------------

// an array this long is written an element at a time
const SPLIT_LENGTH = 16;
// elements written together, in an array that's split
const RUN_LENGTH = 64;
// properties that hold concepts, and so can be large however few elements they have: a tree
// of concepts (CodeSystem.concept, ValueSet.expansion.contains), or a compose's includes
const NESTING = new Set(['concept', 'contains', 'include', 'exclude']);

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && typeof v.toJSON !== 'function';
}

// what JSON.stringify leaves out of an object (and writes as null in an array)
function isOmitted(v) {
  return v === undefined || typeof v === 'function' || typeof v === 'symbol';
}

function arrayWorthSplitting(a, key) {
  return a.length >= SPLIT_LENGTH || (a.length > 0 && NESTING.has(key));
}

// looks at the object's own properties, and into the objects among them, but not into arrays:
// the elements of an array it splits are looked at as they're written
function objectWorthSplitting(o) {
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (Array.isArray(v) ? arrayWorthSplitting(v, k) : (isPlainObject(v) && objectWorthSplitting(v))) {
      return true;
    }
  }
  return false;
}

/**
 * JSON.stringify(value), in pieces: joined, they are exactly what it returns. A long array, or
 * concepts (a tree of them, or a compose's), are written a piece at a time; anything else in one
 * piece (by JSON.stringify), so a large resource is a piece or so a concept.
 * @param {*} value
 * @param {string} [key] - the property value is the value of
 * @param {boolean} [split] - value is known to be worth splitting
 * @returns {Generator<string>}
 */
function* jsonPieces(value, key = null, split = false) {
  if (Array.isArray(value)) {
    if (!split && !arrayWorthSplitting(value, key)) {
      yield JSON.stringify(value);
      return;
    }
    // elements that needn't be split are written RUN_LENGTH at a time: JSON.stringify of a slice
    // of the array is what it writes for those elements, in brackets (an omitted one is null in
    // both)
    let sep = '[';
    let run = 0; // where the elements not yet written start
    for (let i = 0; i <= value.length; i++) {
      const e = value[i];
      const split = i < value.length && (Array.isArray(e) || (isPlainObject(e) && objectWorthSplitting(e)));
      if (i > run && (split || i === value.length || i - run === RUN_LENGTH)) {
        yield sep + JSON.stringify(value.slice(run, i)).slice(1, -1);
        sep = ',';
        run = i;
      }
      if (split) {
        yield sep;
        yield* jsonPieces(e, null, true);
        sep = ',';
        run = i + 1;
      }
    }
    yield ']';
  } else if (isPlainObject(value)) {
    if (!split && !objectWorthSplitting(value)) {
      yield JSON.stringify(value);
      return;
    }
    let sep = '{';
    for (const k of Object.keys(value)) {
      const v = value[k];
      if (isOmitted(v)) {
        continue;
      }
      if (Array.isArray(v) ? arrayWorthSplitting(v, k) : (isPlainObject(v) && objectWorthSplitting(v))) {
        yield sep + JSON.stringify(k) + ':';
        yield* jsonPieces(v, k, true);
      } else {
        yield sep + JSON.stringify(k) + ':' + JSON.stringify(v);
      }
      sep = ',';
    }
    yield sep === '{' ? '{}' : '}';
  } else {
    yield JSON.stringify(value);
  }
}

module.exports = { runSteps, runStepsAsync, jsonPieces, PAUSE_EVERY };
