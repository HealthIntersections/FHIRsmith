const fs = require('fs');
const path = require('path');
const { PackageManager} = require("../../library/package-manager");
const {txTestModeSet} = require("./test-runner");
const folders = require('../../library/folder-setup');

const OUTPUT_FILE1 = path.join(__dirname, '../..', 'tests/tx/test-cases.test.js');
const OUTPUT_FILE2 = path.join(__dirname, 'test-cases-version.js');

// we generate the skeleton of the tests so that we have a stable set of tests
// for useability in jest etc. We haven't ported all the test code - that can
// stay in the java validator. We actually execute the test cases by loading
// the java validator in server mode, and then using it to actually execute
// the tests
let npm;
let testCases;

async function load() {
    const packageServers = ['https://packages2.fhir.org/packages'];
    const cacheFolder = folders.ensureFolder('terminology-cache');
    const packageManager = new PackageManager(packageServers, cacheFolder);
    const packagePath = await packageManager.fetch("hl7.fhir.uv.tx-ecosystem", "current");
    const fullPackagePath = path.join(cacheFolder, packagePath);
    npm = JSON.parse(fs.readFileSync(path.join(fullPackagePath, "package", "package.json"), 'utf8'));
    testCases = JSON.parse(fs.readFileSync(path.join(fullPackagePath, "package", "tests", "test-cases.json"), 'utf8'));
}

function generate() {
    const modes = txTestModeSet();

    let output2 = `// AUTO-GENERATED FILE - DO NOT EDIT
// Generated from test-cases.json
// Regenerate with: node generate-tests.js

function txTestVersion() {
  return '${npm.version}';
}
module.exports = { txTestVersion };
`;

    // Emit the per-suite describe blocks. `suffix` is appended to each it()
    // name so the same tests can be emitted more than once (e.g. a cached pass)
    // with distinct, reportable names.
    // When oneVersion is true, each test is emitted at a single version
    // (caching behaviour is version-independent, so the forced-caching pass
    // doesn't need both R4 and R5): prefer R5, fall back to R4 for R4-only tests.
    const emitSuites = (suffix, oneVersion = false) => {
        let s = '';
        for (const suite of testCases.suites) {
            if (!suite.mode || modes.has(suite.mode)) {
                s += `describe('${suite.name}', () => {\n`;

                if (suite.description) {
                    s += `  // ${suite.description}\n\n`;
                }

                // A "sequential" suite's tests depend on each other (closure: each builds on the
                // table the last one left, and the table is shared across FHIR versions). So its
                // R5 run goes through the whole suite before its R4 run starts, rather than the
                // two being interleaved test by test.
                const passes = (suite.sequential && !oneVersion) ? ['R5', 'R4'] : [null];
                for (const pass of passes)
                for (const test of suite.tests) {
                    if ((!test.mode || modes.has(test.mode)) && (!test["full-set"])) {
                        let testDetails = {
                            suite: suite.name,
                            test: test.name
                        }

                        const escapedNameLiteral = JSON.stringify(test.name);
                        const hasR5 = (!test.version || test.version.startsWith("5.0"));
                        const hasR4 = (!test.version || test.version.startsWith("4.0"));
                        const emitR5 = () => {
                            s += `  it(${escapedNameLiteral} + 'R5${suffix}', async () => {\n`;
                            s += `    await runTest(${JSON.stringify(testDetails)}, "5.0");\n`;
                            s += `  });\n\n`;
                        };
                        const emitR4 = () => {
                            s += `  it(${escapedNameLiteral} + 'R4${suffix}', async () => {\n`;
                            s += `    await runTest(${JSON.stringify(testDetails)}, "4.0");\n`;
                            s += `  });\n\n`;
                        };
                        if (pass === 'R5') {
                            if (hasR5) emitR5();
                        } else if (pass === 'R4') {
                            if (hasR4) emitR4();
                        } else if (oneVersion) {
                            if (hasR5) emitR5(); else if (hasR4) emitR4();
                        } else {
                            if (hasR5) emitR5();
                            if (hasR4) emitR4();
                        }
                    }
                }
                s += `});\n\n`;
            }
        }
        return s;
    };

    let output = `// AUTO-GENERATED FILE - DO NOT EDIT
// Generated from test-cases.json
// Regenerate with: node generate-tests.js

const { runTest, startTxTests, finishTxTests, setForcedCaching } = require('../../tx/tests/test-runner');

describe('Tx Tests', () => {

  beforeAll(async () => {
    await startTxTests();
  }, 600000);
  afterAll(async () => {
    await finishTxTests();
  });
`;

    // First two passes: every test at R5 and R4, with no effective caching
    // (expansions complete well under the cache threshold).
    output += emitSuites('');

    // Third pass: run everything again with the expansion cache forced on,
    // regardless of how long each expansion takes. This exercises cache
    // correctness (e.g. that language settings are part of the cache key) that
    // the fast, normally-uncached runs above cannot.
    output += `describe('cached (forced caching)', () => {\n`;
    output += `  beforeAll(() => { setForcedCaching(true); });\n`;
    output += `  afterAll(() => { setForcedCaching(false); });\n\n`;
    output += emitSuites('-cached', true);
    output += `});\n\n`;

    output += `});\n\n`;
  fs.writeFileSync(OUTPUT_FILE1, output);
  console.log(`Generated ${OUTPUT_FILE1}`);
  fs.writeFileSync(OUTPUT_FILE2, output2);
  console.log(`Generated ${OUTPUT_FILE2}`);
}

async function generateTestCases() {
  await load();
  generate();
}

// Run if executed directly (not required/imported)
if (require.main === module) {
    generateTestCases().catch(console.error);
}

module.exports = { generateTestCases };
