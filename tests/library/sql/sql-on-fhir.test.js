//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * The shared SQL on FHIR test suite (fhir-test-cases/sql-on-fhir), run against library/sql the
 * way org.hl7.fhir.core's SqlOnFhirRunnerTests runs it against the Java runner: rows compared as
 * a multiset (order does not matter, duplicates do), numbers by value, column order checked when
 * the test gives it, and an error expected where the test says so.
 */

const r5 = require('fhirpath/fhir-context/r5');
const { Runner, MemoryProvider, JsonStorage } = require('../../../library/sql');
const { loadTestCases } = require('./sof-test-cases');

const { files } = loadTestCases();

// Cases that fail for reasons outside the runner. They run as it.failing, so they are reported if
// they start to pass, and the entry can come out.
const KNOWN_GAPS = {
  // JSON.parse turns 1.0 into 1, so the precision lowBoundary()/highBoundary() work from is gone
  // before fhirpath.js sees the value (it gives 0.5 and 1.5 where the test wants 0.95 and 1.05).
  // fhirpath.js does not take a decimal as its source text either.
  'fn_boundary.json/decimal lowBoundary': 'decimal precision is lost by JSON.parse',
  'fn_boundary.json/decimal highBoundary': 'decimal precision is lost by JSON.parse'
};

async function run(file, test) {
  const provider = new MemoryProvider();
  for (const resource of file.resources || []) {
    provider.add(resource);
  }
  const storage = new JsonStorage();
  const runner = new Runner({ model: r5, provider, storage });
  await runner.execute(test.view);
  return storage.rows;
}

function sameValue(expected, actual) {
  if (expected === null || actual === null) {
    return expected === actual;
  }
  if (typeof expected !== typeof actual) {
    return false;
  }
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.length === actual.length && expected.every((e, i) => sameValue(e, actual[i]));
  }
  if (typeof expected === 'object') {
    if (Array.isArray(actual)) {
      return false;
    }
    const keys = Object.keys(expected);
    return keys.length === Object.keys(actual).length && keys.every(k => k in actual && sameValue(expected[k], actual[k]));
  }
  return expected === actual;
}

function checkRows(expected, actual) {
  if (expected.length !== actual.length) {
    return `Result count mismatch: expected ${expected.length}, got ${actual.length}: ${JSON.stringify(actual)}`;
  }
  const consumed = new Array(actual.length).fill(false);
  for (let i = 0; i < expected.length; i++) {
    const j = actual.findIndex((row, k) => !consumed[k] && sameValue(expected[i], row));
    if (j < 0) {
      return `No matching actual row for expected row ${i}: ${JSON.stringify(expected[i])} in ${JSON.stringify(actual)}`;
    }
    consumed[j] = true;
  }
  return null;
}

describe('SQL on FHIR shared tests', () => {
  for (const { name, content } of files) {
    describe(name, () => {
      for (const test of content.tests || []) {
        const gap = KNOWN_GAPS[`${name}/${test.title}`];
        const testFn = gap ? it.failing : it;
        testFn(gap ? `${test.title} (known gap: ${gap})` : test.title, async () => {
          if (test.expectError || test.expectErrorPattern) {
            let error = null;
            try {
              await run(content, test);
            } catch (e) {
              error = e;
            }
            expect(error).not.toBeNull();
            if (test.expectErrorPattern) {
              expect(error.message).toContain(test.expectErrorPattern);
            }
            return;
          }
          const rows = await run(content, test);
          if (test.expect) {
            const problem = checkRows(test.expect, rows);
            expect(problem).toBeNull();
          }
          if (test.expectColumns && rows.length > 0) {
            expect(Object.keys(rows[0])).toEqual(test.expectColumns);
          }
        });
      }
    });
  }
});
