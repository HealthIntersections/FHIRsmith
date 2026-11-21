
const FhirValidator = require('fhir-validator-wrapper');
const express = require('express');
const path = require('path');
const fs = require('fs');
const TXModule = require('../tx.js');
const ServerStats = require("../../stats");
const Logger = require("../../library/logger");
const {txTestVersion} = require("./test-cases-version");
const { PACKAGE_ID, txTestsPackageVersion, txTestsBranch, txTestsSource } = require('./tx-tests-package');
const folders = require('../../library/folder-setup');
const { PackageManager } = require('../../library/package-manager');
const {VersionUtilities} = require("../../library/version-utilities");
const packageJson = require('../../package.json');
const axios = require('axios');
const { pipeline } = require('stream/promises');

let count = 0;
let error = 0;
// which pass we are in, so the output of the three passes can be told apart on disk
let forcedCaching = false;
// errorsForInvalidCodes as the test configuration has it: the third pass runs the other way
let configuredErrorsForInvalidCodes = undefined;
// one entry per test run, for the TestReport written next to the summary
let testResults = [];
// why the server or the validator could not be started, if they couldn't (see startTxTests)
let startupError = null;
let startupErrorReported = false;
// the validator's test sessions, one for each endpoint (r5, r4), made by startTxTests: a session
// fixes the run - the server, the version of the test cases, the externals and the output folder.
// The cached pass runs in the same sessions, with its own label
let sessions = {};

function txTestModeSet() {
   return new Set(['tx.fhir.org', 'omop', 'general', 'snomed', 'mimetypes', 'icd-11', 'icf', 'closure', 'loinc']);
}

// If the server or the validator can't be started (a package server that doesn't answer, say), the
// error is kept rather than thrown. Thrown from beforeAll, jest reports it - message, code frame and
// stack - against every one of the 5000+ tests, twice over (once as they run and again in the
// summary): a quarter of a million lines that GitHub truncates, so the cause can't be seen. Kept, it
// is reported in full once, by the first test, and the rest fail with a one-line pointer to it
async function startTxTests() {
    try {
        await startServer();
        await loadValidator();
        await setUpSessions();
    } catch (e) {
        startupError = e;
    }
}

/**
 * Force (or stop forcing) the expansion cache to cache every expansion
 * regardless of duration, across all endpoints. Clears the caches so the run
 * starts clean. Used to run the whole test suite a third time with caching
 * fully active, which exercises cache correctness (e.g. that language is part
 * of the cache key) that the fast, normally-uncached runs cannot.
 *
 * The third pass also runs with errorsForInvalidCodes switched the other way from
 * the first two (whatever the test configuration says), so that tests that let the
 * server choose between behaviours (http-code "200|4xx", e.g. simple-expand-enum-invalid)
 * are run both ways. The handlers read the setting per request, so it takes effect
 * at once; the expansion caches are cleared here, so no expansion made under one
 * setting is served under the other.
 */
function setForcedCaching(enabled) {
    forcedCaching = enabled;
    if (!txModule || !Array.isArray(txModule.endpoints)) {
        return;
    }
    if (configuredErrorsForInvalidCodes === undefined) {
        configuredErrorsForInvalidCodes = txModule.config.errorsForInvalidCodes === true;
    }
    txModule.config.errorsForInvalidCodes = enabled ? !configuredErrorsForInvalidCodes : configuredErrorsForInvalidCodes;
    for (const ep of txModule.endpoints) {
        if (ep.expansionCache) {
            ep.expansionCache.clearAll();
            ep.expansionCache.forceCaching = enabled;
        }
    }
}

// Whatever happens writing the summary, the validator and the server are stopped: anything left
// running keeps jest from exiting, and the CI job then hangs until its timeout
async function  finishTxTests() {
    try {
        console.log(txTestSummary());
        let textfilename = path.join(__dirname, '../../test-cases-summary.txt');
        fs.writeFileSync(textfilename, txTestSummary());
        let reportfilename = path.join(__dirname, '../../test-cases-report.json');
        fs.writeFileSync(reportfilename, JSON.stringify(txTestReport(), null, 2));
    } finally {
        await tearDownSessions();
        await unloadValidator();
        await stopServer();
    }
}

// ", from the tx-ecosystem branch <branch>" when the tests didn't come from main's build: a run
// that passed against a branch mustn't look like one that passed against main
function testsFrom() {
    try {
        const branch = txTestsBranch(txTestsPackageVersion());
        return branch ? `, from the tx-ecosystem branch ${branch}` : '';
    } catch (e) {
        return ''; // a bad FHIRSMITH_TX_TESTS_VERSION: the tests never started, and said why
    }
}

// (null when the validator never started)
function runnerVersion() {
    return validator ? validator.jarVersion() : 'n/a';
}

function txTestSummary() {
    let set = Array.from(txTestModeSet()).join('+');
    if (error == 0) {
      return `FHIRsmith v${packageJson.version} passed all ${count} HL7 terminology service tests (modes ${set}, tests v${txTestVersion()}${testsFrom()}, runner v${runnerVersion()})`;
    } else {
      return `FHIRsmith v${packageJson.version} failed ${error} of ${count} HL7 terminology service tests (modes ${set}, tests v${txTestVersion()}${testsFrom()}, runner v${runnerVersion()})`;
    }
}

/**
 * The run as a TestReport, for the /testing module (and anything else that reads them).
 *
 * The validator's TxTester builds a TestReport of its own, but only its command line entry
 * point writes it out: the /txTest HTTP endpoint these tests go through runs one test at a
 * time and never returns it, and on that path the report's name, test script, result and
 * score are never filled in. So this one is built here, from the results this runner
 * already has. Each test carries its own result and period.
 *
 * testScript is the test-cases.json in the tx ecosystem IG, at the version of the tests. The
 * participants are the software tested - FHIRsmith itself rather than the localhost endpoints
 * the tests ran against, so that runs from different machines line up in a summary - and the
 * test engine, each with its version. Each test appears once per pass (r5, r4, and the cached
 * passes), named suite/test (pass).
 */
function txTestReport() {
    const modes = Array.from(txTestModeSet()).join('+');
    return {
        resourceType: 'TestReport',
        name: 'TxEcosystemTests',
        status: 'completed',
        testScript: txTestsSource(txTestsPackageVersion()) + '|' + txTestVersion(),
        result: error == 0 ? 'pass' : 'fail',
        score: count == 0 ? 0 : Math.round(((count - error) / count) * 10000) / 100,
        tester: 'FHIRsmith build (modes ' + Array.from(txTestModeSet()).join(', ') + ')',
        issued: new Date().toISOString(),
        participant: [{
            type: 'server',
            uri: 'https://github.com/HealthIntersections/FHIRsmith',
            version: packageJson.version,
            display: 'FHIRsmith'
        }, {
            type: 'test-engine',
            uri: 'https://github.com/hapifhir/org.hl7.fhir.core',
            version: runnerVersion(),
            display: 'HL7 Ecosystem Test Runner (modes ' + modes + ')'
        }],
        test: testResults.map(t => ({
            name: t.name,
            result: t.result,
            period: { start: t.start, end: t.end },
            action: [{
                operation: t.message ? { result: t.result, message: t.message } : { result: t.result }
            }]
        }))
    };
}

async function runTest(test, version = true) {
    version = version || "5.0";
    const endpoint = VersionUtilities.isR5Plus(version) ? 'r5' : 'r4';
    const params = {
        session: sessions[endpoint],
        suiteName: test.suite,
        testName: test.test,
        // the modes have to travel with the request. Without them the validator falls back to
        // its own default set, which is not this one, and every test in a mode it does not
        // have comes back "n/a" - which the runner counts as a failure, not a skip
        modes: Array.from(txTestModeSet()).join(','),
        // each pass gets its own subfolder of the session's output folder: the cached pass runs
        // in the same session as the uncached one, and would otherwise write over its diffs
        label: endpoint + (forcedCaching ? '-cached' : '')
    };
    count++;
    if (startupError) {
        error++;
        if (!startupErrorReported) {
            startupErrorReported = true;
            throw startupError;
        }
        // no stack, so jest prints just the message
        const e = new Error('The tx test server did not start: see the first failing test for why');
        e.stack = e.message;
        throw e;
    }
    const start = new Date().toISOString();
    const result = await validator.runTxTest(params);
    if (!result.result) { 
        error++;
    }
    testResults.push({
        name: `${test.suite}/${test.test} (${params.label})`,
        result: result.result ? 'pass' : 'fail',
        message: result.result ? null : result.message,
        start,
        end: new Date().toISOString()
    });
    
    expect(result).toEqual({ result: true });
}


const TEST_PORT = 9095;
const VALIDATOR_PORT = 9096;
const TEST_CONFIG_FILE = path.join(__dirname, '..', 'fixtures', 'test-cases-setup.json');

let server = null;
let validator = null;
let txModule = null;
let log = null;
let stats = null;

async function startServer() {
    const app = express();

    // Load test configuration
    let config;
    try {
        config = require('../../library/config-reader').readConfig(TEST_CONFIG_FILE);
    } catch (error) {
        throw new Error(`Failed to load test config: ${error.message}`);
    }

    // Middleware
    app.use(express.raw({ type: 'application/fhir+json', limit: '50mb' }));
    app.use(express.raw({ type: 'application/fhir+xml', limit: '50mb' }));
    app.use(express.json({ limit: '50mb' }));

    // Initialize TX module only. Statistics are kept in memory here - a test
    // run shouldn't be writing into the real statistics database.
    stats = new ServerStats({ enabled: false });
    txModule = new TXModule(stats.forModule('tx'));
    await txModule.initialize(config, app);

    return new Promise((resolve, reject) => {
        server = app.listen(TEST_PORT, (err) => {
            if (err) {
                reject(err);
            } else {
                console.log(`Test server started on port ${TEST_PORT}`);
                resolve();
            }
        });
    });
}

async function stopServer() {
    if (stats) {
        stats.finishStats();
    }

    if (txModule && typeof txModule.shutdown === 'function') {
        await txModule.shutdown();
        txModule = null;
    }

    if (server) {
        return new Promise((resolve) => {
            server.closeAllConnections();
            server.close(() => {
                console.log('Test server stopped');
                server = null;
                resolve();
            });
        });
    }
}

// fhir-validator-wrapper checks for a newer validator_cli.jar by asking the GitHub REST API,
// unauthenticated. On a CI runner that shares a limit of 60 requests an hour with every other
// job on the same IP address; once it is used up, the validator never starts and every tx test
// fails. The release download URL is a plain redirect, not the API, so in CI the jar is fetched
// from there (if it isn't already present) and the wrapper is told not to check. A CI runner
// starts empty, so this always gets the current release anyway. Locally nothing changes.
const LATEST_VALIDATOR_URL = 'https://github.com/hapifhir/org.hl7.fhir.core/releases/latest/download/validator_cli.jar';

// GitHub's release downloads sometimes fail for a moment (a 502, 503 or 504 from its CDN, or a
// dropped connection): try again a few times, waiting longer each time, before failing the run
const VALIDATOR_DOWNLOAD_ATTEMPTS = 4;

async function ensureValidatorJar(jarPath, { url = LATEST_VALIDATOR_URL, attempts = VALIDATOR_DOWNLOAD_ATTEMPTS, delayMs = 5000 } = {}) {
    if (fs.existsSync(jarPath)) {
        return;
    }
    const tmp = jarPath + '.download';
    for (let attempt = 1; ; attempt++) {
        try {
            const res = await axios.get(url, { responseType: 'stream', maxRedirects: 10, timeout: 300000 });
            await pipeline(res.data, fs.createWriteStream(tmp));
            fs.renameSync(tmp, jarPath);
            return;
        } catch (e) {
            fs.rmSync(tmp, { force: true });
            const status = e.response && e.response.status;
            // after redirects: which host failed (github.com, or the release-asset CDN)
            const at = (e.request && e.request.res && e.request.res.responseUrl) || (e.request && e.request._currentUrl) || url;
            // a 4xx other than 429 won't change by asking again
            const retry = attempt < attempts && !(status >= 400 && status < 500 && status !== 429);
            console.log(`Downloading the validator (${url}) failed (attempt ${attempt} of ${attempts}): ${status ? 'HTTP ' + status : e.message} from ${String(at).split('?')[0]}` +
              (retry ? `; trying again in ${delayMs * attempt / 1000} s` : ''));
            if (!retry) {
                throw e;
            }
            await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
        }
    }
}

async function loadValidator() {
    // FHIRSMITH_VALIDATOR_JAR runs the tests with a validator built locally from org.hl7.fhir.core
    // (the fat jar, org.hl7.fhir.validation.cli/target/org.hl7.fhir.validation.cli-<version>.jar)
    // instead of the released one - so that a change to TxTester (its sorters, its comparison)
    // can be tested here before it is released. It is used as is: never updated or downloaded
    const localJar = process.env.FHIRSMITH_VALIDATOR_JAR;
    if (localJar && !fs.existsSync(localJar)) {
        throw new Error(`FHIRSMITH_VALIDATOR_JAR is set, but ${localJar} does not exist`);
    }
    const validatorJarPath = localJar ? path.resolve(localJar) : folders.ensureFilePath('bin/validator_cli.jar');
    const inCI = !!process.env.CI;
    if (inCI && !localJar) {
        await ensureValidatorJar(validatorJarPath);
    }
    log =  Logger.getInstance().child({ module: 'test-runner' });
    validator = new FhirValidator(validatorJarPath, log);
    const validatorConfig = {
        version : '4.0',
        txServer : 'http://localhost:'+TEST_PORT+'/r5',
        txLog : path.join(folders.logsDir(), 'tx-test-cases.log'),
        port: VALIDATOR_PORT,
        timeout: 60000,
        // The validator enables SSRF protection by default from 6.10.0, which blocks http:// and any
        // connection to localhost. Everything under test here - both the -tx server above and the
        // 'server' parameter passed to runTxTest() - is our own express server on localhost, and all
        // content is our own fixtures, so there is nothing untrusted that could redirect the validator
        // anywhere. Protection has to be off for these tests to connect at all.
        ssrfProtection: false,
        // runTxTest() needs the validator's terminology test endpoints, which are off unless asked
        // for from validator 7.0.4 (fhir-validator-wrapper passes -txTests; older wrappers ignore this)
        txTests: true,
        // see ensureValidatorJar: no GitHub API call in CI; and a local jar is never replaced
        autoDownload: !localJar,
        skipUpdateCheck: inCI || !!localJar
    }
    await validator.start(validatorConfig);
}

/**
 * The externals the tests are compared with: the tx.fhir.org messages file in the test package.
 * A session takes the content, not a file name, and with none the expected responses that use
 * $external$ can't match. Taken from the same build of the tests the validator runs.
 */
async function txTestExternals(testsVersion) {
    const cacheFolder = folders.ensureFolder('terminology-cache');
    const packageManager = new PackageManager(['https://packages2.fhir.org/packages'], cacheFolder);
    const packagePath = await packageManager.fetch(PACKAGE_ID, testsVersion);
    return JSON.parse(fs.readFileSync(path.join(cacheFolder, packagePath, 'package', 'tests', 'messages-tx.fhir.org.json'), 'utf8'));
}

/**
 * A test session for each endpoint. The session fixes the version of the test cases the validator
 * runs - FHIRSMITH_TX_TESTS_VERSION (tx-tests-package.js): current, or a branch's CI build in a PR.
 * (The older way of running a test, with a server and no session, always runs the tests in
 * #current, whatever IG the validator has loaded.) The validator loads that build of the tests
 * itself, and the FHIR version of each session is the endpoint's.
 */
async function setUpSessions() {
    const testsVersion = txTestsPackageVersion();
    log.info(`Loading the terminology tests: ${PACKAGE_ID}#${testsVersion}`);
    const externals = await txTestExternals(testsVersion);
    for (const endpoint of ['r5', 'r4']) {
        const res = await validator.txTestSetup({
            server: 'http://localhost:' + TEST_PORT + '/' + endpoint,
            testVersion: testsVersion,
            externals,
            // name the output folder ourselves rather than letting the validator name it after
            // the server: both sessions are the same host. Each pass is a subfolder (its label)
            folder: 'fhirsmith-' + endpoint,
            tester: 'FHIRsmith build'
        });
        sessions[endpoint] = res.session;
        log.info(`Terminology test session for /${endpoint}: tests ${res['test-version']}, FHIR ${res.fhirVersion}, output in ${res.output}`);
    }
}

// Ends the sessions, which has the validator write its own reports for each (test-results.json and
// report.json, in the session's output folder). A session left open would never write them
async function tearDownSessions() {
    for (const endpoint of Object.keys(sessions)) {
        try {
            const res = await validator.txTestTeardown(sessions[endpoint]);
            log.info(`Terminology test session for /${endpoint} ended: reports in ${res.output}`);
        } catch (e) {
            log.warn(`Ending the terminology test session for /${endpoint} failed: ${e.message}`);
        }
    }
    sessions = {};
}


async function unloadValidator() {

    // Stop FHIR validator
    if (validator) {
        try {
            log.info('Stopping FHIR validator...');
            await validator.stop();
            log.info('FHIR validator stopped');
        } catch (error) {
            log.error('Error stopping FHIR validator:', error);
        }
        validator = null;
    }

}
module.exports = { startTxTests, finishTxTests, runTest, txTestModeSet, setForcedCaching };