/**
 * Bounds on how deeply a resource may nest itself.
 *
 * FHIR lets both CodeSystem.concept and ValueSet.expansion.contains nest without
 * limit, and both are walked recursively all over this codebase (the expansion map,
 * the concept count, the renderer, the expander's index, the R5->R4 converter, ...).
 * A hostile resource of a few hundred KB can therefore blow the JS stack, and even
 * if every one of those walkers were made iterative, `JSON.stringify` -- which we do
 * not control -- overflows at a nesting depth of roughly 1800 on node 22.
 *
 * Rather than harden each walker in turn and hope the next one added remembers, we
 * bound the nesting once, when the resource is constructed. Everything downstream is
 * then safe by construction, including code that does not exist yet.
 *
 * The limit is deliberately far below where anything actually breaks. Real nesting
 * mirrors the hierarchy of a code system -- SNOMED CT is about 30 deep, LOINC parts
 * about 10, ICD-10 about 5 -- so 100 is well past any legitimate resource while
 * leaving more than an order of magnitude of headroom against the stack.
 *
 * @module tx/library/nesting-limit
 */

/**
 * Maximum nesting depth allowed in a resource's self-recursive structure.
 * @type {number}
 */
const MAX_NESTING_DEPTH = 100;

/**
 * Walks a self-nesting FHIR structure iteratively, counting its entries and
 * enforcing {@link MAX_NESTING_DEPTH}.
 *
 * The walk uses an explicit stack, so it costs no JS stack depth of its own and can
 * safely be pointed at a tree deep enough to overflow a recursive walker. It is the
 * one traversal that has to survive hostile input; every other walker in the codebase
 * runs after this one has passed.
 *
 * Non-array input counts as zero, matching the tolerant behaviour of the recursive
 * counters this replaces - structural type checking is the caller's business.
 *
 * @param {Array} items - Top-level array of the nesting structure
 * @param {string} childProperty - Name of the property holding nested children ('concept', 'contains')
 * @param {string} path - Path used in the error message ('CodeSystem.concept')
 * @returns {number} Total number of entries, nested ones included
 * @throws {Error} If nesting exceeds MAX_NESTING_DEPTH, tagged statusCode 400 / issueCode 'structure'
 */
function countNested(items, childProperty, path) {
  if (!Array.isArray(items)) {
    return 0;
  }

  let count = 0;
  // Each frame is a list to walk plus the depth at which its entries sit.
  const stack = [{ list: items, depth: 1 }];

  while (stack.length > 0) {
    const { list, depth } = stack.pop();
    if (depth > MAX_NESTING_DEPTH) {
      // The worker error handlers honour statusCode/issueCode when they are present on
      // a plain Error, so tag it: this is a bad resource from the client, not a server
      // fault, and it should come back as a 400 rather than the default 500/exception.
      const e = new Error(
        `${path} is nested more than ${MAX_NESTING_DEPTH} levels deep, which is not supported`);
      e.statusCode = 400;
      e.issueCode = 'structure';
      throw e;
    }
    for (const item of list) {
      count++;
      if (item && Array.isArray(item[childProperty]) && item[childProperty].length > 0) {
        stack.push({ list: item[childProperty], depth: depth + 1 });
      }
    }
  }

  return count;
}

module.exports = { MAX_NESTING_DEPTH, countNested };
