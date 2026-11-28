//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * A run as a FHIR TestReport, and sending it to a repository of test reports (a FHIRsmith
 * /testing module, or anything else that takes TestReports by POST [base]/TestReport), as
 * utilities/submit-test-report.js sends the tx tests' report.
 *
 * @module tester/report
 */

const axios = require('axios');
const packageJson = require('../package.json');

const ENGINE = 'https://github.com/HealthIntersections/FHIRsmith';
const TEST_SCRIPT = 'https://github.com/HealthIntersections/FHIRsmith/tester';
const NAME = 'FHIRsmith RESTful API tests';
const NPM_TEST_SCRIPT = TEST_SCRIPT + '/npm';
const NPM_NAME = 'FHIRsmith npm registry tests';
// as tx/tests/test-runner.js names its report
const TX_NAME = 'TxEcosystemTests';
const TX_ENGINE = 'https://github.com/hapifhir/org.hl7.fhir.core';

/**
 * The outcomes counted: { pass, fail, warning, skip, error }
 * @param {Object[]} results
 */
function counts(results) {
  const c = { pass: 0, fail: 0, warning: 0, skip: 0, error: 0 };
  for (const r of results) {
    c[r.outcome] = (c[r.outcome] || 0) + 1;
  }
  return c;
}

/**
 * The run as a TestReport (R4 and R5 alike: testScript as a canonical)
 * @param {Object} run - { id, server, status (completed, cancelled, error...), message, software,
 *   fhirVersion, started, finished, results, tester, kind ('fhir', or 'npm': the npm registry
 *   checks), pkg and version (npm) }
 */
function testReport(run) {
  if (run.kind === 'tx') {
    return txReport(run);
  }
  const npm = run.kind === 'npm';
  const name = npm ? NPM_NAME : NAME;
  const c = counts(run.results || []);
  const counted = c.pass + c.warning + c.fail + c.error;
  const report = {
    resourceType: 'TestReport',
    identifier: { system: 'urn:ietf:rfc:3986', value: `urn:uuid:${run.id}` },
    name,
    status: run.status === 'completed' ? 'completed' : 'stopped',
    testScript: `${npm ? NPM_TEST_SCRIPT : TEST_SCRIPT}|${packageJson.version}`,
    result: run.status !== 'completed' ? 'pending' : (c.fail || c.error ? 'fail' : 'pass'),
    score: counted ? Math.round(((c.pass + c.warning) / counted) * 10000) / 100 : 0,
    tester: run.tester || 'FHIRsmith tester',
    issued: new Date(run.finished || Date.now()).toISOString(),
    participant: [{
      type: 'test-engine',
      uri: ENGINE,
      version: packageJson.version,
      display: name
    }, {
      type: 'server',
      uri: run.server,
      ...(run.software ? { display: run.software } : npm && run.pkg ? { display: `npm registry, tested with ${run.pkg}#${run.version}` } : {})
    }],
    test: (run.results || []).map(r => ({
      name: `${r.group}: ${r.name}`,
      ...(r.start ? { period: { start: r.start, end: r.end || r.start } } : {}),
      action: [{ operation: { result: r.outcome, ...(r.message ? { message: r.message } : {}) } }]
    }))
  };
  if (run.fhirVersion) {
    report.participant[1].version = run.fhirVersion;
  }
  if (run.status !== 'completed' && run.message) {
    // why the run didn't finish
    report.test.unshift({ name: 'The run', action: [{ operation: { result: 'error', message: run.message } }] });
  }
  return report;
}

/**
 * A terminology test run as a TestReport, as tx/tests/test-runner.js makes one for this server's
 * own tests (TxEcosystemTests, the test-cases.json as the test script), so the repository puts
 * them side by side
 * @param {Object} run - as testReport, and modes, testsVersion (the package's version, for the
 *   test script), testsSource (test-cases.json's address), engineVersion (the validator's)
 */
function txReport(run) {
  const c = counts(run.results || []);
  const counted = c.pass + c.warning + c.fail + c.error;
  const modes = (run.modes || []).join(', ');
  const report = {
    resourceType: 'TestReport',
    identifier: { system: 'urn:ietf:rfc:3986', value: `urn:uuid:${run.id}` },
    name: TX_NAME,
    status: run.status === 'completed' ? 'completed' : 'stopped',
    testScript: `${run.testsSource}|${run.testsVersion}`,
    result: run.status !== 'completed' ? 'pending' : (c.fail || c.error ? 'fail' : 'pass'),
    score: counted ? Math.round(((c.pass + c.warning) / counted) * 10000) / 100 : 0,
    tester: `${run.tester || 'FHIRsmith tester'} (modes ${modes})`,
    issued: new Date(run.finished || Date.now()).toISOString(),
    participant: [{
      type: 'server',
      uri: run.server,
      ...(run.fhirVersion ? { version: run.fhirVersion } : {}),
      ...(run.software ? { display: run.software } : {})
    }, {
      type: 'test-engine',
      uri: TX_ENGINE,
      ...(run.engineVersion ? { version: run.engineVersion } : {}),
      display: `HL7 Ecosystem Test Runner (modes ${(run.modes || []).join('+')})`
    }],
    test: (run.results || []).map(r => ({
      name: `${r.group}/${r.name}`,
      ...(r.start ? { period: { start: r.start, end: r.end || r.start } } : {}),
      action: [{ operation: { result: r.outcome, ...(r.message ? { message: r.message } : {}) } }]
    }))
  };
  if (run.status !== 'completed' && run.message) {
    report.test.unshift({ name: 'The run', action: [{ operation: { result: 'error', message: run.message } }] });
  }
  return report;
}

/**
 * Send a report to a repository
 * @param {Object} report - a TestReport
 * @param {Object} repo - { server, token, header }
 * @returns {Promise<string>} where the repository put it (its Location), or 'sent'
 * @throws {Error} the repository refused it, or didn't answer
 */
async function upload(report, repo) {
  const base = String(repo.server).replace(/\/+$/, '');
  const url = /\/TestReport$/.test(base) ? base : base + '/TestReport';
  const headers = { 'Content-Type': 'application/fhir+json', Accept: 'application/fhir+json', Prefer: 'return=minimal' };
  if (repo.token) {
    const header = repo.header || 'Authorization';
    headers[header] = header.toLowerCase() === 'authorization' ? `Bearer ${repo.token}` : repo.token;
  }
  let res;
  try {
    res = await axios.post(url, JSON.stringify(report), { headers, timeout: 60000, validateStatus: () => true, transformResponse: [(d) => d], maxRedirects: 0 });
  } catch (e) {
    throw new Error(`${url} didn't answer: ${e.message}`);
  }
  if (res.status !== 201 && res.status !== 200) {
    let why = '';
    try {
      const oo = JSON.parse(res.data);
      why = (oo.issue || []).map(i => (i.details && i.details.text) || i.diagnostics || i.code).join('; ');
    } catch (e) {
      // not an OperationOutcome: the text, without any HTML
      why = String(res.data || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 300);
    }
    const hint = [404, 405].includes(res.status) ? ' (is reportServer the address of a repository of TestReports, such as a /testing module?)' : '';
    throw new Error(`${url} refused the report (${res.status})${hint}${why ? ': ' + why : ''}`);
  }
  return res.headers.location || 'sent';
}

module.exports = { testReport, upload, counts, NAME, TEST_SCRIPT, NPM_NAME, NPM_TEST_SCRIPT, TX_NAME };
