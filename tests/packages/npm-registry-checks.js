// Runs the npm registry protocol checks (packages/npm-check.js) as Jest tests, one test
// per check, for the suites that use them:
//
//   npm-registry.test.js        live registries: registry.npmjs.org (the control) and others
//   npm-registry-local.test.js  the packages module, started locally with known content
//
// /packages/npm-check runs the same checks and reports on them as a web page.

const zlib = require('zlib');
const { runNpmCheck, makeGetter, STEPS, CHECKS, untar } = require('../../packages/npm-check');

// Defines the checks for one registry. target is { name, base, pkg, version }; base may be
// filled in later (by a beforeAll in the enclosing describe), as long as it is set before
// these checks' own beforeAll runs.
function defineNpmRegistryChecks(target) {
  describe(`npm registry protocol: ${target.name}`, () => {
    let report;

    beforeAll(async () => {
      report = await runNpmCheck({ registry: target.base, pkg: target.pkg, version: target.version }, makeGetter());
    }, 120000);

    for (const step of STEPS) {
      describe(`${step.title}: ${step.request}`, () => {
        for (const check of CHECKS.filter(c => c.step === step.id)) {
          test(check.title, () => {
            const result = report.steps.find(s => s.id === step.id).checks.find(c => c.title === check.title);
            if (result.status !== 'pass') {
              const urls = result.uses.map(u => report.requests[u]?.url).filter(Boolean);
              throw new Error(`${result.message}\n  (${urls.join(', ')})`);
            }
          });
        }
      });
    }
  });
}

// Minimal ustar writer: files is { path: string | Buffer }, returns a .tgz Buffer
function tgz(files) {
  const blocks = [];
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write('0000644\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
    header.write('00000000000\0', 136, 12, 'ascii');
    header.write('0', 156, 1, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    header.fill(' ', 148, 156);
    let sum = 0;
    for (const b of header) {
      sum += b;
    }
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

module.exports = { defineNpmRegistryChecks, tgz, untar };
