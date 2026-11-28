// The content the npm registry checks are run against when they're run against this server's
// packages module, started locally (npm-registry-local.test.js, tests/tester/npm.test.js):
//
//   example.fhir.npmtest         1.0.0 (2024), 1.1.0 (2025, latest)   <- the package tested
//   example.fhir.npmtest.extras  1.0.0 (2025, newer)                   <- near-matches, so
//   example.fhir.npmtest.legacy  1.0.0 (2023, older)                      search has something
//                                                                         to rank the exact
//                                name above, published both before and after it

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { tgz } = require('./npm-registry-checks');

const PKG = 'example.fhir.npmtest';

const FIXTURES = [
  { id: PKG, version: '1.0.0', date: '2024-03-01T00:00:00Z', deps: { 'hl7.fhir.r4.core': '4.0.1' } },
  { id: PKG, version: '1.1.0', date: '2025-03-01T00:00:00Z', deps: { 'hl7.fhir.r4.core': '4.0.1' } },
  { id: `${PKG}.extras`, version: '1.0.0', date: '2025-06-01T00:00:00Z', deps: { [PKG]: '1.1.0' } },
  { id: `${PKG}.legacy`, version: '1.0.0', date: '2023-06-01T00:00:00Z', deps: { 'hl7.fhir.r4.core': '4.0.1' } }
];

function fixtureTarball({ id, version, deps }) {
  return tgz({
    'package/package.json': JSON.stringify({
      name: id,
      version,
      type: 'fhir.ig',
      canonical: `http://example.org/fhir/${id}`,
      url: `http://example.org/fhir/${id}/${version}`,
      fhirVersions: ['4.0.1'],
      dependencies: deps,
      description: `Test package ${id}`,
      author: 'FHIRsmith tests',
      license: 'CC0-1.0'
    }, null, 2),
    'package/.index.json': JSON.stringify({ 'index-version': 2, files: [] })
  });
}

/**
 * The packages module, with the fixtures, listening on 127.0.0.1
 * @returns {Promise<{base: string, module: Object, close: function(): Promise<void>}>} base: the registry's address
 */
async function startLocalRegistry() {
  const PackagesModule = require('../../packages/packages');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-registry-'));
  const module = new PackagesModule({ countRequest() {} });
  await module.initialize({
    database: path.join(tmp, 'packages.db'),
    mirrorPath: path.join(tmp, 'mirror'),
    masterUrl: 'http://127.0.0.1:1/unused',
    crawler: { enabled: false }
  });
  module.crawler.log = { info() {}, warn() {}, error() {} };
  for (const f of FIXTURES) {
    const link = `http://example.org/feed/${f.id}-${f.version}.tgz`;
    await module.crawler.store('test-feed', link, link, new Date(f.date), fixtureTarball(f), `${f.id}#${f.version}`, {});
  }
  const app = express();
  app.use('/packages', module.router);
  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return {
    base: `http://127.0.0.1:${server.address().port}/packages`,
    module,
    close: async () => {
      await new Promise(resolve => server.close(resolve));
      await module.shutdown();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };
}

module.exports = { PKG, FIXTURES, fixtureTarball, startLocalRegistry };
