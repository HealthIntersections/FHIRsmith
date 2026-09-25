#!/usr/bin/env node
//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * Submit the tx test report (test-cases-report.json, written by the tx test run) to a
 * FHIRsmith /testing server.
 *
 *   node utilities/submit-test-report.js [-server url] [-file path] [-token token] [-header name]
 *
 *   -server  the /testing base; default https://testing.fhir.org/testing
 *   -file    default test-cases-report.json in the FHIRsmith root
 *   -token   if the server requires one; or set FHIRSMITH_TESTING_TOKEN
 *   -header  the header the token goes in; default Authorization (sent as "Bearer <token>")
 *
 * Exits 0 when the server accepted the report, 1 otherwise.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_SERVER = 'https://testing.fhir.org/testing';
const DEFAULT_FILE = path.join(__dirname, '..', 'test-cases-report.json');

function usage(msg) {
  if (msg) {
    console.error(msg);
  }
  console.error('Usage: node utilities/submit-test-report.js [-server url] [-file path] [-token token] [-header name]');
  process.exit(1);
}

function parseArgs(argv) {
  const opts = {
    server: DEFAULT_SERVER,
    file: DEFAULT_FILE,
    token: process.env.FHIRSMITH_TESTING_TOKEN || null,
    header: 'Authorization'
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i].replace(/^--?/, '');
    if (a === 'help' || a === 'h') {
      usage();
    }
    if (!['server', 'file', 'token', 'header'].includes(a)) {
      usage(`Unknown parameter: ${argv[i]}`);
    }
    if (i + 1 >= argv.length) {
      usage(`Missing value for ${argv[i]}`);
    }
    opts[a] = argv[++i];
  }
  return opts;
}

/** The TestReport endpoint for a server base, whether or not it was given with /TestReport. */
function endpoint(server) {
  const base = server.replace(/\/+$/, '');
  return /\/TestReport$/.test(base) ? base : base + '/TestReport';
}

/** Warn if the report doesn't describe the version being released. */
function checkVersion(report) {
  const pkg = require('../package.json');
  const display = (report.participant || []).map(p => p && p.display).find(d => typeof d === 'string' && d.startsWith('FHIRsmith v'));
  const reported = display ? display.substring('FHIRsmith v'.length) : null;
  if (reported && reported !== pkg.version) {
    console.warn(`Warning: the report is from FHIRsmith v${reported}, but package.json is v${pkg.version}`);
  } else if (reported && /snapshot/i.test(reported)) {
    console.warn(`Warning: the report is from a snapshot (v${reported}), not a release`);
  }
}

function describeOutcome(text) {
  try {
    const oo = JSON.parse(text);
    if (oo.resourceType === 'OperationOutcome' && Array.isArray(oo.issue)) {
      return oo.issue.map(i => `  ${i.severity}: ${(i.details && i.details.text) || i.diagnostics || i.code}`).join('\n');
    }
  } catch {
    // not JSON - fall through to the raw text
  }
  return '  ' + text.substring(0, 1000);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(opts.file)) {
    console.error(`No report at ${opts.file} - run the tx tests first (npx jest tests/tx/test-cases.test.js)`);
    process.exit(1);
  }
  const body = fs.readFileSync(opts.file, 'utf8');
  let report;
  try {
    report = JSON.parse(body);
  } catch (e) {
    console.error(`${opts.file} is not valid JSON: ${e.message}`);
    process.exit(1);
  }
  if (report.resourceType !== 'TestReport') {
    console.error(`${opts.file} is not a TestReport`);
    process.exit(1);
  }
  checkVersion(report);

  const url = endpoint(opts.server);
  const headers = {
    'Content-Type': 'application/fhir+json',
    'Accept': 'application/fhir+json',
    'Prefer': 'return=minimal'
  };
  if (opts.token) {
    headers[opts.header] = opts.header.toLowerCase() === 'authorization' ? `Bearer ${opts.token}` : opts.token;
  }

  console.log(`Submitting ${path.basename(opts.file)} (${report.result}, ${Array.isArray(report.test) ? report.test.length : 0} tests) to ${url}`);
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body });
  } catch (e) {
    console.error(`Could not reach ${url}: ${e.cause ? e.cause.message : e.message}`);
    process.exit(1);
  }
  const text = await res.text();
  if (res.status !== 201) {
    console.error(`The server refused the report: HTTP ${res.status}`);
    if (text) {
      console.error(describeOutcome(text));
    }
    if (res.status === 401 && !opts.token) {
      console.error('The server requires a token: use -token, or set FHIRSMITH_TESTING_TOKEN');
    }
    process.exit(1);
  }
  const location = res.headers.get('location');
  console.log(`Accepted: ${location || '(no Location returned)'}`);
}

if (require.main === module) {
  main().catch(e => {
    console.error(e.stack || e.message);
    process.exit(1);
  });
}

module.exports = { parseArgs, endpoint };
