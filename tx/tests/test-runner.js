
const FhirValidator = require('fhir-validator-wrapper');
const express = require('express');
const path = require('path');
const fs = require('fs');
const TXModule = require('../tx.js');
const ServerStats = require("../../stats");
const Logger = require("../../library/logger");
const {txTestVersion} = require("./test-cases-version");
const folders = require('../../library/folder-setup');
const {VersionUtilities} = require("../../library/version-utilities");

let count = 0;
let error = 0;
// which pass we are in, so the output of the three passes can be told apart on disk
let forcedCaching = false;

function txTestModeSet() {
   return new Set(['tx.fhir.org', 'omop', 'general', 'snomed', 'mimetypes', 'icd-11', 'closure']);
}

async function startTxTests() {
    await startServer();
    await loadValidator();
}

/**
 * Force (or stop forcing) the expansion cache to cache every expansion
 * regardless of duration, across all endpoints. Clears the caches so the run
 * starts clean. Used to run the whole test suite a third time with caching
 * fully active, which exercises cache correctness (e.g. that language is part
 * of the cache key) that the fast, normally-uncached runs cannot.
 */
function setForcedCaching(enabled) {
    forcedCaching = enabled;
    if (!txModule || !Array.isArray(txModule.endpoints)) {
        return;
    }
    for (const ep of txModule.endpoints) {
        if (ep.expansionCache) {
            ep.expansionCache.clearAll();
            ep.expansionCache.forceCaching = enabled;
        }
    }
}

async function  finishTxTests() {
    console.log(txTestSummary());
    let textfilename = path.join(__dirname, '../../test-cases-summary.txt');
    fs.writeFileSync(textfilename, txTestSummary());

    await unloadValidator();
    await stopServer();
}

function txTestSummary() {
    let set = Array.from(txTestModeSet()).join('+');
    if (error == 0) {
      return `FHIRsmith passed all ${count} HL7 terminology service tests (modes ${set}, tests v${txTestVersion()}, runner v${validator.jarVersion()})`;
    } else {
      return `FHIRsmith failed ${error} of ${count} HL7 terminology service tests (modes ${set}, tests v${txTestVersion()}, runner v${validator.jarVersion()})`;
    }
}

async function runTest(test, version = true) {
    version = version || "5.0";
    const params = {
        server: 'http://localhost:'+TEST_PORT+(VersionUtilities.isR5Plus(version) ? "/r5" : "/r4"),
        suiteName: test.suite,
        testName: test.test,
        version: version,
        // the modes have to travel with the request. Without them the validator falls back to
        // its own default set, which is not this one, and every test in a mode it does not
        // have comes back "n/a" - which the runner counts as a failure, not a skip
        modes: Array.from(txTestModeSet()).join(','),
        // name the output folder ourselves rather than letting the validator name it after the
        // server, and give each pass its own subfolder. All three passes are the same server
        // and produce the same two filenames, so without this the R4, R5 and cached runs write
        // over each other and the diff left on disk is from whichever finished last
        folder: 'fhirsmith',
        label: (VersionUtilities.isR5Plus(version) ? 'r5' : 'r4') + (forcedCaching ? '-cached' : '')
    };
    count++;
    const result = await validator.runTxTest(params);
    if (!result.result) { 
        error++;
    }
    
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
        const configData = fs.readFileSync(TEST_CONFIG_FILE, 'utf8');
        config = JSON.parse(configData);
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
    stats.finishStats();

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

async function loadValidator() {
    const validatorJarPath = folders.ensureFilePath('bin/validator_cli.jar');
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
        ssrfProtection: false
    }
    await validator.start(validatorConfig);
    await validator.loadIG("hl7.fhir.uv.tx-ecosystem", "current");
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