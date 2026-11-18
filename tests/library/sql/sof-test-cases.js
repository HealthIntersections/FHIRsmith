//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * Finds the shared SQL on FHIR test cases: the sql-on-fhir folder of fhir-test-cases
 * (https://github.com/FHIR/fhir-test-cases), the same cases org.hl7.fhir.core runs, listed by
 * its manifest.json. Looked for, in order:
 *
 *   1. $FHIR_TEST_CASES/sql-on-fhir (FHIR_TEST_CASES is a fhir-test-cases clone)
 *   2. a test-cases clone beside FHIRsmith (../test-cases/sql-on-fhir)
 *   3. test-cache/sql-on-fhir, downloaded from GitHub (master) when not there yet
 *
 * Loading is synchronous so the cases can be listed when jest collects the tests.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../../..');
const RAW = 'https://raw.githubusercontent.com/FHIR/fhir-test-cases/master/sql-on-fhir/';

function candidates() {
  const list = [];
  if (process.env.FHIR_TEST_CASES) {
    list.push(path.join(process.env.FHIR_TEST_CASES, 'sql-on-fhir'));
  }
  list.push(path.resolve(ROOT, '..', 'test-cases', 'sql-on-fhir'));
  return list;
}

function download(folder) {
  fs.mkdirSync(folder, { recursive: true });
  // fetch is asynchronous, and jest needs the cases now: do it in a child process
  const script = `
    const fs = require('fs'), path = require('path');
    (async () => {
      const get = async (name) => {
        const r = await fetch(${JSON.stringify(RAW)} + name);
        if (!r.ok) throw new Error('HTTP ' + r.status + ' fetching ' + name);
        return r.text();
      };
      const manifest = await get('manifest.json');
      for (const name of JSON.parse(manifest)) {
        fs.writeFileSync(path.join(process.argv[1], name), await get(name));
      }
      fs.writeFileSync(path.join(process.argv[1], 'manifest.json'), manifest);
    })().catch(e => { process.stderr.write(e.message); process.exit(1); });`;
  execFileSync(process.execPath, ['-e', script, folder], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 120000 });
}

function findFolder() {
  for (const c of candidates()) {
    if (fs.existsSync(path.join(c, 'manifest.json'))) {
      return c;
    }
  }
  const cache = path.join(ROOT, 'test-cache', 'sql-on-fhir');
  if (!fs.existsSync(path.join(cache, 'manifest.json'))) {
    try {
      download(cache);
    } catch (e) {
      const detail = e.stderr ? e.stderr.toString() : e.message;
      throw new Error('Unable to find the SQL on FHIR test cases. Set FHIR_TEST_CASES to a fhir-test-cases clone, ' +
        `put one beside FHIRsmith, or allow the download from GitHub (${detail})`);
    }
  }
  return cache;
}

/**
 * @returns {{folder: string, files: Array<{name: string, content: Object}>}}
 */
function loadTestCases() {
  const folder = findFolder();
  const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
  const files = manifest.map(name => ({
    name,
    content: JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8'))
  }));
  return { folder, files };
}

module.exports = { loadTestCases };
