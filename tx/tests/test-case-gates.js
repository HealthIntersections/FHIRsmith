// Which of the tx-ecosystem test cases the generator emits, and at which FHIR versions. Kept
// apart from the generator so that it can be tested without loading the test runner.

/**
 * Does a suite's or test's "version" gate let it run against this FHIR version? The same rule as
 * the Java runner (TxTester.versionGateMatches): the gate is a major.minor prefix - "4.0" runs
 * only on R4 - optionally negated with a leading "!", so "!4.0" runs on everything except R4.
 */
function versionGateMatches(gate, ver) {
    if (!gate) {
        return true;
    }
    if (gate.startsWith('!')) {
        return !versionGateMatches(gate.substring(1), ver);
    }
    return ver === gate || ver.startsWith(gate + '.');
}

/** Does a suite or test run in these modes? A "modes" list needs any one of them, a "mode" that one. */
function passesModes(item, modes) {
    if (Array.isArray(item.modes)) {
        return item.modes.some(m => modes.has(m));
    }
    return !item.mode || modes.has(item.mode);
}

/**
 * The FHIR versions a test runs at: none if it, or its suite, is disabled (the runner reports a
 * disabled test as one that did not run, which counts as a failure here), and otherwise those its
 * suite's and its own version gates let through.
 */
function testVersions(suite, test) {
    if (suite.disabled || test.disabled) {
        return { hasR5: false, hasR4: false };
    }
    const runsAt = (v) => versionGateMatches(suite.version, v) && versionGateMatches(test.version, v);
    return { hasR5: runsAt('5.0'), hasR4: runsAt('4.0') };
}

module.exports = { versionGateMatches, passesModes, testVersions };
