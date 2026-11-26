//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * Finds files in fhir-test-cases (https://github.com/FHIR/fhir-test-cases), the shared test
 * cases org.hl7.fhir.core (and the old Pascal server) run. Looked for, in order:
 *
 *   1. $FHIR_TEST_CASES/{path} (FHIR_TEST_CASES is a fhir-test-cases clone)
 *   2. a test-cases clone beside FHIRsmith (../test-cases/{path})
 *   3. test-cache/fhir-test-cases/{path}, downloaded from GitHub (master) when not there yet
 *
 * A downloaded file isn't fetched again: delete test-cache/fhir-test-cases for the latest.
 * Everything is synchronous, so the cases can be listed when jest collects the tests.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const RAW = 'https://raw.githubusercontent.com/FHIR/fhir-test-cases/master/';
const CACHE = path.join(ROOT, 'test-cache', 'fhir-test-cases');

function clones() {
  const list = [];
  if (process.env.FHIR_TEST_CASES) {
    list.push(process.env.FHIR_TEST_CASES);
  }
  list.push(path.resolve(ROOT, '..', 'test-cases'));
  return list;
}

/** Downloads files (paths in fhir-test-cases) into the cache */
function download(files) {
  // fetch is asynchronous, and jest needs the cases now: do it in a child process. Each file is
  // written to a temporary name and renamed, so a test running alongside never sees half of one
  const script = `
    const fs = require('fs'), path = require('path');
    const [raw, cache, ...files] = process.argv.slice(1);
    (async () => {
      for (const name of files) {
        const r = await fetch(raw + name);
        if (!r.ok) throw new Error('HTTP ' + r.status + ' fetching ' + name);
        const dest = path.join(cache, name);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const tmp = dest + '.' + process.pid + '.tmp';
        fs.writeFileSync(tmp, Buffer.from(await r.arrayBuffer()));
        fs.renameSync(tmp, dest);
      }
    })().catch(e => { process.stderr.write(e.message); process.exit(1); });`;
  try {
    execFileSync(process.execPath, ['-e', script, RAW, CACHE, ...files], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 120000 });
  } catch (e) {
    const detail = e.stderr && e.stderr.length ? e.stderr.toString() : e.message;
    throw new Error(`Unable to find ${files.join(', ')} in fhir-test-cases. Set FHIR_TEST_CASES to a fhir-test-cases clone, ` +
      `put one beside FHIRsmith (../test-cases), or allow the download from GitHub (${detail})`);
  }
}

/**
 * The full path of a file in fhir-test-cases, downloading it if need be.
 * @param {string} name - its path in fhir-test-cases, e.g. 'r5/patch/fhir-patch-tests.xml'
 * @returns {string}
 */
function testCaseFile(name) {
  for (const c of clones()) {
    const f = path.join(c, name);
    if (fs.existsSync(f)) {
      return f;
    }
  }
  const f = path.join(CACHE, name);
  if (!fs.existsSync(f)) {
    download([name]);
  }
  return f;
}

/**
 * The full path of a folder in fhir-test-cases that lists its files in a manifest (a JSON list
 * of names), downloading the manifest and its files if need be.
 * @param {string} folder - e.g. 'sql-on-fhir'
 * @param {string} [manifest] - the manifest's name in the folder
 * @returns {string}
 */
function testCaseFolder(folder, manifest = 'manifest.json') {
  for (const c of clones()) {
    const f = path.join(c, folder);
    if (fs.existsSync(path.join(f, manifest))) {
      return f;
    }
  }
  const f = path.join(CACHE, folder);
  if (!fs.existsSync(path.join(f, manifest))) {
    // the files first, and the manifest last: the manifest being there says they all are
    download([path.posix.join(folder, manifest)]);
    const names = JSON.parse(fs.readFileSync(path.join(f, manifest), 'utf8'));
    const m = path.join(f, manifest);
    fs.renameSync(m, m + '.pending');
    try {
      download(names.map(n => path.posix.join(folder, n)));
    } catch (e) {
      fs.rmSync(m + '.pending', { force: true });
      throw e;
    }
    fs.renameSync(m + '.pending', m);
  }
  return f;
}

/** The text of a file in fhir-test-cases */
function readTestCase(name) {
  return fs.readFileSync(testCaseFile(name), 'utf8');
}

module.exports = { testCaseFile, testCaseFolder, readTestCase, CACHE };
