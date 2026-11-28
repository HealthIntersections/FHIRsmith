//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * A run of the HL7 terminology service tests (the tx-ecosystem IG's test cases,
 * hl7.fhir.uv.tx-ecosystem) against a terminology server, as the tester module's queue runs it:
 * the same shape of run as tester/engine.js's TestRun.
 *
 * The FHIR validator runs the tests (its terminology test sessions: fhir-validator-wrapper
 * txTestSetup, runTxTest, txTestTeardown), as tx/tests/test-runner.js runs them against this
 * server: it makes the requests, and compares the answers with the expected ones. This decides
 * which tests are run: those of the modes chosen, at the server's FHIR version (the session's,
 * as the validator found it from the server's metadata), as tx/tests/test-case-gates.js decides
 * for the jest run. A test that fails has the validator's expected and actual responses (from
 * the session's output folder) kept with its result; every test has the request it sent, from
 * the test package.
 *
 * @module tester/tx/run
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { passesModes, versionGateMatches } = require('../../tx/tests/test-case-gates');

// the most a run takes
const TX_RUN_LIMIT_MS = 30 * 60 * 1000;
// what is kept of a file's content, for the test's page
const KEEP_CHARS = 64 * 1024;
// the label the session's output goes under (a subfolder of its output folder)
const LABEL = 'run';

/** The modes the tests have, and what each is (the form shows these) */
const TX_MODES = [
  { code: 'general', title: 'General', description: 'what every terminology server is expected to do, with the code systems and value sets the tests load' },
  { code: 'snomed', title: 'SNOMED CT', description: 'the server has SNOMED CT (the International Edition)' },
  { code: 'loinc', title: 'LOINC', description: 'the server has LOINC' },
  { code: 'icd-11', title: 'ICD-11', description: 'the server has ICD-11' },
  { code: 'icf', title: 'ICF', description: 'the server has the ICF' },
  { code: 'omop', title: 'OMOP', description: 'the server has the OMOP vocabularies' },
  { code: 'mimetypes', title: 'Mime types', description: 'the server has BCP 13 (mime types)' },
  { code: 'closure', title: '$closure', description: 'the server does $closure' },
  { code: 'tx.fhir.org', title: 'tx.fhir.org', description: 'the server behaves as tx.fhir.org does where the specification leaves it open (its messages, its extensions)' }
];

/** A test case's file, as text (cut at 64 KB), or null */
function fileText(file) {
  try {
    const s = fs.readFileSync(file, 'utf8');
    return s.length > KEEP_CHARS ? s.substring(0, KEEP_CHARS) + `\n... (${s.length} characters in all)` : s;
  } catch (e) {
    return null;
  }
}

/**
 * The tests to run: those of the modes, at the FHIR version (major.minor), in order
 * @param {Object} testCases - test-cases.json
 * @param {Set<string>} modes
 * @param {string} version - major.minor, such as 4.0 or 5.0
 * @returns {Array<{suite: Object, test: Object}>}
 */
function selectTests(testCases, modes, version) {
  const out = [];
  for (const suite of testCases.suites || []) {
    if (suite.disabled || !passesModes(suite, modes) || !versionGateMatches(suite.version, version)) {
      continue;
    }
    for (const test of suite.tests || []) {
      if (!test.disabled && !test['full-set'] && passesModes(test, modes) && versionGateMatches(test.version, version)) {
        out.push({ suite, test });
      }
    }
  }
  return out;
}

/** major.minor of a FHIR version */
function majorMinor(v) {
  const m = /^(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? `${m[1]}.${m[2]}` : null;
}

class TxRun {
  /**
   * @param {Object} options
   * @param {string} options.base - the terminology server's address
   * @param {string[]} options.modes
   * @param {function(): Promise<Object>} options.validator - the running validator (fhir-validator-wrapper)
   * @param {function(): Promise<{folder: string, testCases: Object, externals: Object, version: string}>} options.tests -
   *   the test package: its tests folder, test-cases.json, the externals (messages-tx.fhir.org.json), and its version
   * @param {string} [options.testsVersion] - the build of the tests the validator runs (current)
   * @param {string} [options.id]
   * @param {function(Object): void} [options.onResult]
   * @param {function(string): void} [options.onStatus]
   * @param {string} [options.tester] - for the validator's own report
   * @param {number} [options.limitMs]
   */
  constructor(options) {
    this.options = options;
    this.id = options.id || crypto.randomUUID();
    this.results = [];
    this.stopped = null;
  }

  cancel(reason = 'The run was cancelled') {
    if (!this.stopped) {
      this.stopped = reason;
    }
  }

  status(text) {
    if (this.options.onStatus) {
      this.options.onStatus(text);
    }
  }

  add(result) {
    this.results.push(result);
    if (this.options.onResult) {
      this.options.onResult(result);
    }
  }

  /**
   * @returns {Promise<{outcome: string, message: string|null, cap: null, server: Object, results: Object[], cleanup: null}>}
   */
  async run() {
    const o = this.options;
    const limitMs = o.limitMs || TX_RUN_LIMIT_MS;
    const timer = setTimeout(() => this.cancel(`The run took more than ${Math.round(limitMs / 60000)} minutes`), limitMs);
    timer.unref();
    const modes = new Set(o.modes);
    let validator = null;
    let session = null;
    let outputRoot = null;
    const server = {};
    try {
      this.status('Loading the test cases');
      const tests = await o.tests();
      this.status('Starting the validator');
      validator = await o.validator();
      this.status('Connecting to the server');
      let setup;
      try {
        setup = await validator.txTestSetup({ server: o.base, testVersion: o.testsVersion || 'current', externals: tests.externals,
          folder: 'tester-' + this.id, tester: o.tester || 'FHIRsmith tester' });
      } catch (e) {
        return { outcome: 'error', message: `The validator couldn't start a test run against ${o.base}: ${e.message}`, cap: null, server, results: this.results, cleanup: null };
      }
      session = setup.session;
      outputRoot = setup.output || null;
      Object.assign(server, { fhirVersion: setup.fhirVersion || null, software: setup.software || null, testsVersion: tests.version || setup['test-version'] });
      const version = majorMinor(setup.fhirVersion);
      if (!version) {
        return { outcome: 'error', message: `The server's FHIR version isn't known (${setup.fhirVersion || 'none'})`, cap: null, server, results: this.results, cleanup: null };
      }
      const list = selectTests(tests.testCases, modes, version);
      const output = setup.output ? path.join(setup.output, LABEL) : null;
      for (let i = 0; i < list.length; i++) {
        const { suite, test } = list[i];
        if (this.stopped) {
          break;
        }
        this.status(`Test ${i + 1} of ${list.length}: ${suite.name} / ${test.name}`);
        const start = new Date();
        let r;
        try {
          r = await validator.runTxTest({ session, suiteName: suite.name, testName: test.name, modes: [...modes].join(','), label: LABEL });
        } catch (e) {
          r = { result: false, message: `The validator failed: ${e.message}` };
        }
        const end = new Date();
        this.add({
          group: suite.name,
          name: test.name,
          outcome: r.result ? 'pass' : 'fail',
          message: r.result ? null : r.message || 'failed',
          ms: end - start,
          start: start.toISOString(),
          end: end.toISOString(),
          exchanges: [this.detail(tests.folder, output, test, !r.result)],
          resources: []
        });
      }
      const stopped = this.stopped;
      return { outcome: stopped ? 'cancelled' : 'completed', message: stopped || (list.length ? null : `No tests are run at FHIR ${version} in the modes ${[...modes].join(', ')}`),
        cap: null, server, results: this.results, cleanup: null };
    } finally {
      clearTimeout(timer);
      if (validator && session) {
        try {
          await validator.txTestTeardown(session);
        } catch (e) {
          // the session goes when the validator does
        }
      }
      // what the validator wrote for the run (its diffs and reports): what's wanted of it is in
      // the results now. Only the run's own folder (the folder name it was given)
      if (outputRoot && path.basename(outputRoot) === 'tester-' + this.id) {
        fs.rmSync(outputRoot, { recursive: true, force: true });
      }
    }
  }

  /**
   * A test's detail, for its page: what it does, its request (from the package), and if it
   * failed, the expected and actual responses the validator wrote
   */
  detail(folder, output, test, failed) {
    const files = [test.response, test.response2, ...Object.keys(test).filter(k => k.startsWith('response:')).map(k => test[k])].filter(f => typeof f === 'string');
    const tx = {
      operation: test.operation || null,
      description: test.description || null,
      request: test.request ? fileText(path.join(folder, test.request)) : null,
      expected: files.length ? fileText(path.join(folder, files[0])) : null,
      httpCode: test['http-code'] || null
    };
    if (failed && output) {
      for (const f of files) {
        const actual = fileText(path.join(output, 'actual', f));
        if (actual !== null) {
          tx.actual = actual;
          tx.expected = fileText(path.join(output, 'expected', f)) || tx.expected;
          break;
        }
      }
    }
    return { phase: 'test', tx };
  }
}

module.exports = { TxRun, TX_MODES, TX_RUN_LIMIT_MS, selectTests, majorMinor };
