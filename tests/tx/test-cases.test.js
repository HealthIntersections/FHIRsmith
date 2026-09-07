// AUTO-GENERATED FILE - DO NOT EDIT
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
describe('metadata', () => {
  // tests for minimal requirements for metadata statements

  it("metadata" + 'R5', async () => {
    await runTest({"suite":"metadata","test":"metadata"}, "5.0");
  });

  it("metadata" + 'R4', async () => {
    await runTest({"suite":"metadata","test":"metadata"}, "4.0");
  });

  it("term-caps" + 'R5', async () => {
    await runTest({"suite":"metadata","test":"term-caps"}, "5.0");
  });

  it("term-caps" + 'R4', async () => {
    await runTest({"suite":"metadata","test":"term-caps"}, "4.0");
  });

});

describe('properties', () => {
  // Testing the ValueSet.compose.property element

  it("expand-with-valueset.compose.property-all-properties-wildcard" + 'R5', async () => {
    await runTest({"suite":"properties","test":"expand-with-valueset.compose.property-all-properties-wildcard"}, "5.0");
  });

  it("expand-with-valueset.compose.property-all-properties-enums" + 'R5', async () => {
    await runTest({"suite":"properties","test":"expand-with-valueset.compose.property-all-properties-enums"}, "5.0");
  });

});

describe('simple-cases', () => {
  // basic tests, setting up for the API tests to come

  it("simple-expand-all" + 'R5', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-all"}, "5.0");
  });

  it("simple-expand-all" + 'R4', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-all"}, "4.0");
  });

  it("simple-expand-active" + 'R5', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-active"}, "5.0");
  });

  it("simple-expand-active" + 'R4', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-active"}, "4.0");
  });

  it("simple-expand-inactive" + 'R5', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-inactive"}, "5.0");
  });

  it("simple-expand-inactive" + 'R4', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-inactive"}, "4.0");
  });

  it("simple-expand-enum" + 'R5', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-enum"}, "5.0");
  });

  it("simple-expand-enum" + 'R4', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-enum"}, "4.0");
  });

  it("simple-expand-enum-bad" + 'R5', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-enum-bad"}, "5.0");
  });

  it("simple-expand-enum-bad" + 'R4', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-enum-bad"}, "4.0");
  });

  it("simple-expand-isa" + 'R5', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-isa"}, "5.0");
  });

  it("simple-expand-isa" + 'R4', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-isa"}, "4.0");
  });

  it("simple-expand-child-of" + 'R5', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-child-of"}, "5.0");
  });

  it("simple-expand-child-of" + 'R4', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-child-of"}, "4.0");
  });

  it("simple-expand-isa-o2" + 'R5', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-isa-o2"}, "5.0");
  });

  it("simple-expand-isa-o2" + 'R4', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-isa-o2"}, "4.0");
  });

  it("simple-expand-isa-c2" + 'R5', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-isa-c2"}, "5.0");
  });

  it("simple-expand-isa-c2" + 'R4', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-isa-c2"}, "4.0");
  });

  it("simple-expand-isa-o2c2" + 'R5', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-isa-o2c2"}, "5.0");
  });

  it("simple-expand-isa-o2c2" + 'R4', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-isa-o2c2"}, "4.0");
  });

  it("simple-expand-prop" + 'R5', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-prop"}, "5.0");
  });

  it("simple-expand-prop" + 'R4', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-prop"}, "4.0");
  });

  it("simple-expand-repeating-prop" + 'R5', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-repeating-prop"}, "5.0");
  });

  it("simple-expand-repeating-prop" + 'R4', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-repeating-prop"}, "4.0");
  });

  it("simple-expand-repeating-prop-values" + 'R5', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-repeating-prop-values"}, "5.0");
  });

  it("simple-expand-repeating-prop-values" + 'R4', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-repeating-prop-values"}, "4.0");
  });

  it("simple-expand-regex" + 'R5', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-regex"}, "5.0");
  });

  it("simple-expand-regex" + 'R4', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-regex"}, "4.0");
  });

  it("simple-expand-regex2" + 'R5', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-regex2"}, "5.0");
  });

  it("simple-expand-regex2" + 'R4', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-regex2"}, "4.0");
  });

  it("simple-expand-regexp-prop" + 'R5', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-regexp-prop"}, "5.0");
  });

  it("simple-expand-regexp-prop" + 'R4', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-regexp-prop"}, "4.0");
  });

  it("simple-expand-regex-none" + 'R5', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-regex-none"}, "5.0");
  });

  it("simple-expand-regex-none" + 'R4', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-regex-none"}, "4.0");
  });

  it("simple-lookup-1" + 'R5', async () => {
    await runTest({"suite":"simple-cases","test":"simple-lookup-1"}, "5.0");
  });

  it("simple-lookup-1" + 'R4', async () => {
    await runTest({"suite":"simple-cases","test":"simple-lookup-1"}, "4.0");
  });

  it("simple-lookup-2" + 'R5', async () => {
    await runTest({"suite":"simple-cases","test":"simple-lookup-2"}, "5.0");
  });

  it("simple-lookup-2" + 'R4', async () => {
    await runTest({"suite":"simple-cases","test":"simple-lookup-2"}, "4.0");
  });

  it("simple-expand-all-count" + 'R5', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-all-count"}, "5.0");
  });

  it("simple-expand-all-count" + 'R4', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-all-count"}, "4.0");
  });

  it("simple-expand-contained" + 'R5', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-contained"}, "5.0");
  });

  it("simple-expand-contained" + 'R4', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-contained"}, "4.0");
  });

  it("simple-subsumes-parent" + 'R5', async () => {
    await runTest({"suite":"simple-cases","test":"simple-subsumes-parent"}, "5.0");
  });

  it("simple-subsumes-parent" + 'R4', async () => {
    await runTest({"suite":"simple-cases","test":"simple-subsumes-parent"}, "4.0");
  });

  it("simple-subsumes-child" + 'R5', async () => {
    await runTest({"suite":"simple-cases","test":"simple-subsumes-child"}, "5.0");
  });

  it("simple-subsumes-child" + 'R4', async () => {
    await runTest({"suite":"simple-cases","test":"simple-subsumes-child"}, "4.0");
  });

  it("simple-subsumes-equivalent" + 'R5', async () => {
    await runTest({"suite":"simple-cases","test":"simple-subsumes-equivalent"}, "5.0");
  });

  it("simple-subsumes-equivalent" + 'R4', async () => {
    await runTest({"suite":"simple-cases","test":"simple-subsumes-equivalent"}, "4.0");
  });

  it("simple-subsumes-transitive" + 'R5', async () => {
    await runTest({"suite":"simple-cases","test":"simple-subsumes-transitive"}, "5.0");
  });

  it("simple-subsumes-transitive" + 'R4', async () => {
    await runTest({"suite":"simple-cases","test":"simple-subsumes-transitive"}, "4.0");
  });

  it("simple-subsumes-siblings" + 'R5', async () => {
    await runTest({"suite":"simple-cases","test":"simple-subsumes-siblings"}, "5.0");
  });

  it("simple-subsumes-siblings" + 'R4', async () => {
    await runTest({"suite":"simple-cases","test":"simple-subsumes-siblings"}, "4.0");
  });

  it("simple-subsumes-unrelated" + 'R5', async () => {
    await runTest({"suite":"simple-cases","test":"simple-subsumes-unrelated"}, "5.0");
  });

  it("simple-subsumes-unrelated" + 'R4', async () => {
    await runTest({"suite":"simple-cases","test":"simple-subsumes-unrelated"}, "4.0");
  });

  it("simple-subsumes-root" + 'R5', async () => {
    await runTest({"suite":"simple-cases","test":"simple-subsumes-root"}, "5.0");
  });

  it("simple-subsumes-root" + 'R4', async () => {
    await runTest({"suite":"simple-cases","test":"simple-subsumes-root"}, "4.0");
  });

  it("simple-subsumes-unknown-code" + 'R5', async () => {
    await runTest({"suite":"simple-cases","test":"simple-subsumes-unknown-code"}, "5.0");
  });

  it("simple-subsumes-unknown-code" + 'R4', async () => {
    await runTest({"suite":"simple-cases","test":"simple-subsumes-unknown-code"}, "4.0");
  });

  it("simple-subsumes-parent-coding" + 'R5', async () => {
    await runTest({"suite":"simple-cases","test":"simple-subsumes-parent-coding"}, "5.0");
  });

  it("simple-subsumes-parent-coding" + 'R4', async () => {
    await runTest({"suite":"simple-cases","test":"simple-subsumes-parent-coding"}, "4.0");
  });

  it("simple-subsumes-child-coding" + 'R5', async () => {
    await runTest({"suite":"simple-cases","test":"simple-subsumes-child-coding"}, "5.0");
  });

  it("simple-subsumes-child-coding" + 'R4', async () => {
    await runTest({"suite":"simple-cases","test":"simple-subsumes-child-coding"}, "4.0");
  });

  it("simple-subsumes-equivalent-coding" + 'R5', async () => {
    await runTest({"suite":"simple-cases","test":"simple-subsumes-equivalent-coding"}, "5.0");
  });

  it("simple-subsumes-equivalent-coding" + 'R4', async () => {
    await runTest({"suite":"simple-cases","test":"simple-subsumes-equivalent-coding"}, "4.0");
  });

  it("simple-subsumes-transitive-coding" + 'R5', async () => {
    await runTest({"suite":"simple-cases","test":"simple-subsumes-transitive-coding"}, "5.0");
  });

  it("simple-subsumes-transitive-coding" + 'R4', async () => {
    await runTest({"suite":"simple-cases","test":"simple-subsumes-transitive-coding"}, "4.0");
  });

  it("simple-subsumes-siblings-coding" + 'R5', async () => {
    await runTest({"suite":"simple-cases","test":"simple-subsumes-siblings-coding"}, "5.0");
  });

  it("simple-subsumes-siblings-coding" + 'R4', async () => {
    await runTest({"suite":"simple-cases","test":"simple-subsumes-siblings-coding"}, "4.0");
  });

  it("simple-subsumes-unrelated-coding" + 'R5', async () => {
    await runTest({"suite":"simple-cases","test":"simple-subsumes-unrelated-coding"}, "5.0");
  });

  it("simple-subsumes-unrelated-coding" + 'R4', async () => {
    await runTest({"suite":"simple-cases","test":"simple-subsumes-unrelated-coding"}, "4.0");
  });

  it("simple-subsumes-root-coding" + 'R5', async () => {
    await runTest({"suite":"simple-cases","test":"simple-subsumes-root-coding"}, "5.0");
  });

  it("simple-subsumes-root-coding" + 'R4', async () => {
    await runTest({"suite":"simple-cases","test":"simple-subsumes-root-coding"}, "4.0");
  });

  it("simple-subsumes-unknown-code-coding" + 'R5', async () => {
    await runTest({"suite":"simple-cases","test":"simple-subsumes-unknown-code-coding"}, "5.0");
  });

  it("simple-subsumes-unknown-code-coding" + 'R4', async () => {
    await runTest({"suite":"simple-cases","test":"simple-subsumes-unknown-code-coding"}, "4.0");
  });

});

describe('parameters', () => {
  // Testing out the various expansion parameters that the IG publisher makes use of

  it("parameters-expand-all-hierarchy" + 'R5', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-all-hierarchy"}, "5.0");
  });

  it("parameters-expand-all-hierarchy" + 'R4', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-all-hierarchy"}, "4.0");
  });

  it("parameters-expand-enum-hierarchy" + 'R5', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-enum-hierarchy"}, "5.0");
  });

  it("parameters-expand-enum-hierarchy" + 'R4', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-enum-hierarchy"}, "4.0");
  });

  it("parameters-expand-isa-hierarchy" + 'R5', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-isa-hierarchy"}, "5.0");
  });

  it("parameters-expand-isa-hierarchy" + 'R4', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-isa-hierarchy"}, "4.0");
  });

  it("parameters-expand-all-active" + 'R5', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-all-active"}, "5.0");
  });

  it("parameters-expand-all-active" + 'R4', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-all-active"}, "4.0");
  });

  it("parameters-expand-active-active" + 'R5', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-active-active"}, "5.0");
  });

  it("parameters-expand-active-active" + 'R4', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-active-active"}, "4.0");
  });

  it("parameters-expand-inactive-active" + 'R5', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-inactive-active"}, "5.0");
  });

  it("parameters-expand-inactive-active" + 'R4', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-inactive-active"}, "4.0");
  });

  it("parameters-expand-enum-active" + 'R5', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-enum-active"}, "5.0");
  });

  it("parameters-expand-enum-active" + 'R4', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-enum-active"}, "4.0");
  });

  it("parameters-expand-isa-active" + 'R5', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-isa-active"}, "5.0");
  });

  it("parameters-expand-isa-active" + 'R4', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-isa-active"}, "4.0");
  });

  it("parameters-expand-all-inactive" + 'R5', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-all-inactive"}, "5.0");
  });

  it("parameters-expand-all-inactive" + 'R4', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-all-inactive"}, "4.0");
  });

  it("parameters-expand-active-inactive" + 'R5', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-active-inactive"}, "5.0");
  });

  it("parameters-expand-active-inactive" + 'R4', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-active-inactive"}, "4.0");
  });

  it("parameters-expand-inactive-inactive" + 'R5', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-inactive-inactive"}, "5.0");
  });

  it("parameters-expand-inactive-inactive" + 'R4', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-inactive-inactive"}, "4.0");
  });

  it("parameters-expand-enum-inactive" + 'R5', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-enum-inactive"}, "5.0");
  });

  it("parameters-expand-enum-inactive" + 'R4', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-enum-inactive"}, "4.0");
  });

  it("parameters-expand-isa-inactive" + 'R5', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-isa-inactive"}, "5.0");
  });

  it("parameters-expand-isa-inactive" + 'R4', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-isa-inactive"}, "4.0");
  });

  it("parameters-expand-all-designations" + 'R5', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-all-designations"}, "5.0");
  });

  it("parameters-expand-all-designations" + 'R4', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-all-designations"}, "4.0");
  });

  it("parameters-expand-enum-designations" + 'R5', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-enum-designations"}, "5.0");
  });

  it("parameters-expand-enum-designations" + 'R4', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-enum-designations"}, "4.0");
  });

  it("parameters-expand-isa-designations" + 'R5', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-isa-designations"}, "5.0");
  });

  it("parameters-expand-isa-designations" + 'R4', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-isa-designations"}, "4.0");
  });

  it("parameters-expand-all-definitions" + 'R5', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-all-definitions"}, "5.0");
  });

  it("parameters-expand-all-definitions" + 'R4', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-all-definitions"}, "4.0");
  });

  it("parameters-expand-enum-definitions" + 'R5', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-enum-definitions"}, "5.0");
  });

  it("parameters-expand-enum-definitions" + 'R4', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-enum-definitions"}, "4.0");
  });

  it("parameters-expand-isa-definitions" + 'R5', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-isa-definitions"}, "5.0");
  });

  it("parameters-expand-isa-definitions" + 'R4', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-isa-definitions"}, "4.0");
  });

  it("parameters-expand-all-definitions2" + 'R5', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-all-definitions2"}, "5.0");
  });

  it("parameters-expand-all-definitions2" + 'R4', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-all-definitions2"}, "4.0");
  });

  it("parameters-expand-enum-definitions2" + 'R5', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-enum-definitions2"}, "5.0");
  });

  it("parameters-expand-enum-definitions2" + 'R4', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-enum-definitions2"}, "4.0");
  });

  it("parameters-expand-enum-definitions3" + 'R5', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-enum-definitions3"}, "5.0");
  });

  it("parameters-expand-enum-definitions3" + 'R4', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-enum-definitions3"}, "4.0");
  });

  it("parameters-expand-isa-definitions2" + 'R5', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-isa-definitions2"}, "5.0");
  });

  it("parameters-expand-isa-definitions2" + 'R4', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-isa-definitions2"}, "4.0");
  });

  it("parameters-expand-all-property" + 'R5', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-all-property"}, "5.0");
  });

  it("parameters-expand-all-property" + 'R4', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-all-property"}, "4.0");
  });

  it("parameters-expand-enum-property" + 'R5', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-enum-property"}, "5.0");
  });

  it("parameters-expand-enum-property" + 'R4', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-enum-property"}, "4.0");
  });

  it("parameters-expand-isa-property" + 'R5', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-isa-property"}, "5.0");
  });

  it("parameters-expand-isa-property" + 'R4', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-isa-property"}, "4.0");
  });

  it("parameters-expand-supplement-none" + 'R5', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-supplement-none"}, "5.0");
  });

  it("parameters-expand-supplement-none" + 'R4', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-supplement-none"}, "4.0");
  });

  it("parameters-expand-supplement-good" + 'R5', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-supplement-good"}, "5.0");
  });

  it("parameters-expand-supplement-good" + 'R4', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-supplement-good"}, "4.0");
  });

  it("parameters-expand-supplement-bad" + 'R5', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-supplement-bad"}, "5.0");
  });

  it("parameters-expand-supplement-bad" + 'R4', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-supplement-bad"}, "4.0");
  });

  it("parameters-validate-supplement-none" + 'R5', async () => {
    await runTest({"suite":"parameters","test":"parameters-validate-supplement-none"}, "5.0");
  });

  it("parameters-validate-supplement-none" + 'R4', async () => {
    await runTest({"suite":"parameters","test":"parameters-validate-supplement-none"}, "4.0");
  });

  it("parameters-validate-supplement-good" + 'R5', async () => {
    await runTest({"suite":"parameters","test":"parameters-validate-supplement-good"}, "5.0");
  });

  it("parameters-validate-supplement-good" + 'R4', async () => {
    await runTest({"suite":"parameters","test":"parameters-validate-supplement-good"}, "4.0");
  });

  it("parameters-validate-supplement-bad" + 'R5', async () => {
    await runTest({"suite":"parameters","test":"parameters-validate-supplement-bad"}, "5.0");
  });

  it("parameters-validate-supplement-bad" + 'R4', async () => {
    await runTest({"suite":"parameters","test":"parameters-validate-supplement-bad"}, "4.0");
  });

  it("parameters-lookup-supplement-none" + 'R5', async () => {
    await runTest({"suite":"parameters","test":"parameters-lookup-supplement-none"}, "5.0");
  });

  it("parameters-lookup-supplement-none" + 'R4', async () => {
    await runTest({"suite":"parameters","test":"parameters-lookup-supplement-none"}, "4.0");
  });

  it("parameters-lookup-supplement-good" + 'R5', async () => {
    await runTest({"suite":"parameters","test":"parameters-lookup-supplement-good"}, "5.0");
  });

  it("parameters-lookup-supplement-good" + 'R4', async () => {
    await runTest({"suite":"parameters","test":"parameters-lookup-supplement-good"}, "4.0");
  });

  it("parameters-lookup-supplement-bad" + 'R5', async () => {
    await runTest({"suite":"parameters","test":"parameters-lookup-supplement-bad"}, "5.0");
  });

  it("parameters-lookup-supplement-bad" + 'R4', async () => {
    await runTest({"suite":"parameters","test":"parameters-lookup-supplement-bad"}, "4.0");
  });

});

describe('language', () => {
  // Testing returning language by request, getting the right designation

  it("language-echo-en-none" + 'R5', async () => {
    await runTest({"suite":"language","test":"language-echo-en-none"}, "5.0");
  });

  it("language-echo-en-none" + 'R4', async () => {
    await runTest({"suite":"language","test":"language-echo-en-none"}, "4.0");
  });

  it("language-echo-de-none" + 'R5', async () => {
    await runTest({"suite":"language","test":"language-echo-de-none"}, "5.0");
  });

  it("language-echo-de-none" + 'R4', async () => {
    await runTest({"suite":"language","test":"language-echo-de-none"}, "4.0");
  });

  it("language-echo-en-multi-none" + 'R5', async () => {
    await runTest({"suite":"language","test":"language-echo-en-multi-none"}, "5.0");
  });

  it("language-echo-en-multi-none" + 'R4', async () => {
    await runTest({"suite":"language","test":"language-echo-en-multi-none"}, "4.0");
  });

  it("language-echo-de-multi-none" + 'R5', async () => {
    await runTest({"suite":"language","test":"language-echo-de-multi-none"}, "5.0");
  });

  it("language-echo-de-multi-none" + 'R4', async () => {
    await runTest({"suite":"language","test":"language-echo-de-multi-none"}, "4.0");
  });

  it("language-echo-en-en-param" + 'R5', async () => {
    await runTest({"suite":"language","test":"language-echo-en-en-param"}, "5.0");
  });

  it("language-echo-en-en-param" + 'R4', async () => {
    await runTest({"suite":"language","test":"language-echo-en-en-param"}, "4.0");
  });

  it("language-echo-en-en-vs" + 'R5', async () => {
    await runTest({"suite":"language","test":"language-echo-en-en-vs"}, "5.0");
  });

  it("language-echo-en-en-vs" + 'R4', async () => {
    await runTest({"suite":"language","test":"language-echo-en-en-vs"}, "4.0");
  });

  it("language-echo-en-en-header" + 'R5', async () => {
    await runTest({"suite":"language","test":"language-echo-en-en-header"}, "5.0");
  });

  it("language-echo-en-en-header" + 'R4', async () => {
    await runTest({"suite":"language","test":"language-echo-en-en-header"}, "4.0");
  });

  it("language-echo-en-en-vslang" + 'R5', async () => {
    await runTest({"suite":"language","test":"language-echo-en-en-vslang"}, "5.0");
  });

  it("language-echo-en-en-vslang" + 'R4', async () => {
    await runTest({"suite":"language","test":"language-echo-en-en-vslang"}, "4.0");
  });

  it("language-echo-en-en-mixed" + 'R5', async () => {
    await runTest({"suite":"language","test":"language-echo-en-en-mixed"}, "5.0");
  });

  it("language-echo-en-en-mixed" + 'R4', async () => {
    await runTest({"suite":"language","test":"language-echo-en-en-mixed"}, "4.0");
  });

  it("language-echo-de-de-param" + 'R5', async () => {
    await runTest({"suite":"language","test":"language-echo-de-de-param"}, "5.0");
  });

  it("language-echo-de-de-param" + 'R4', async () => {
    await runTest({"suite":"language","test":"language-echo-de-de-param"}, "4.0");
  });

  it("language-echo-de-de-vs" + 'R5', async () => {
    await runTest({"suite":"language","test":"language-echo-de-de-vs"}, "5.0");
  });

  it("language-echo-de-de-vs" + 'R4', async () => {
    await runTest({"suite":"language","test":"language-echo-de-de-vs"}, "4.0");
  });

  it("language-echo-de-de-header" + 'R5', async () => {
    await runTest({"suite":"language","test":"language-echo-de-de-header"}, "5.0");
  });

  it("language-echo-de-de-header" + 'R4', async () => {
    await runTest({"suite":"language","test":"language-echo-de-de-header"}, "4.0");
  });

  it("language-echo-en-multi-en-param" + 'R5', async () => {
    await runTest({"suite":"language","test":"language-echo-en-multi-en-param"}, "5.0");
  });

  it("language-echo-en-multi-en-param" + 'R4', async () => {
    await runTest({"suite":"language","test":"language-echo-en-multi-en-param"}, "4.0");
  });

  it("language-echo-en-multi-en-vs" + 'R5', async () => {
    await runTest({"suite":"language","test":"language-echo-en-multi-en-vs"}, "5.0");
  });

  it("language-echo-en-multi-en-vs" + 'R4', async () => {
    await runTest({"suite":"language","test":"language-echo-en-multi-en-vs"}, "4.0");
  });

  it("language-echo-en-multi-en-header" + 'R5', async () => {
    await runTest({"suite":"language","test":"language-echo-en-multi-en-header"}, "5.0");
  });

  it("language-echo-en-multi-en-header" + 'R4', async () => {
    await runTest({"suite":"language","test":"language-echo-en-multi-en-header"}, "4.0");
  });

  it("language-echo-de-multi-de-param" + 'R5', async () => {
    await runTest({"suite":"language","test":"language-echo-de-multi-de-param"}, "5.0");
  });

  it("language-echo-de-multi-de-param" + 'R4', async () => {
    await runTest({"suite":"language","test":"language-echo-de-multi-de-param"}, "4.0");
  });

  it("language-echo-de-multi-de-vs" + 'R5', async () => {
    await runTest({"suite":"language","test":"language-echo-de-multi-de-vs"}, "5.0");
  });

  it("language-echo-de-multi-de-vs" + 'R4', async () => {
    await runTest({"suite":"language","test":"language-echo-de-multi-de-vs"}, "4.0");
  });

  it("language-echo-de-multi-de-header" + 'R5', async () => {
    await runTest({"suite":"language","test":"language-echo-de-multi-de-header"}, "5.0");
  });

  it("language-echo-de-multi-de-header" + 'R4', async () => {
    await runTest({"suite":"language","test":"language-echo-de-multi-de-header"}, "4.0");
  });

  it("language-xform-en-multi-de-soft" + 'R5', async () => {
    await runTest({"suite":"language","test":"language-xform-en-multi-de-soft"}, "5.0");
  });

  it("language-xform-en-multi-de-soft" + 'R4', async () => {
    await runTest({"suite":"language","test":"language-xform-en-multi-de-soft"}, "4.0");
  });

  it("language-xform-en-multi-de-hard" + 'R5', async () => {
    await runTest({"suite":"language","test":"language-xform-en-multi-de-hard"}, "5.0");
  });

  it("language-xform-en-multi-de-hard" + 'R4', async () => {
    await runTest({"suite":"language","test":"language-xform-en-multi-de-hard"}, "4.0");
  });

  it("language-xform-en-multi-de-default" + 'R5', async () => {
    await runTest({"suite":"language","test":"language-xform-en-multi-de-default"}, "5.0");
  });

  it("language-xform-en-multi-de-default" + 'R4', async () => {
    await runTest({"suite":"language","test":"language-xform-en-multi-de-default"}, "4.0");
  });

  it("language-xform-de-multi-en-soft" + 'R5', async () => {
    await runTest({"suite":"language","test":"language-xform-de-multi-en-soft"}, "5.0");
  });

  it("language-xform-de-multi-en-soft" + 'R4', async () => {
    await runTest({"suite":"language","test":"language-xform-de-multi-en-soft"}, "4.0");
  });

  it("language-xform-de-multi-en-hard" + 'R5', async () => {
    await runTest({"suite":"language","test":"language-xform-de-multi-en-hard"}, "5.0");
  });

  it("language-xform-de-multi-en-hard" + 'R4', async () => {
    await runTest({"suite":"language","test":"language-xform-de-multi-en-hard"}, "4.0");
  });

  it("language-xform-de-multi-en-default" + 'R5', async () => {
    await runTest({"suite":"language","test":"language-xform-de-multi-en-default"}, "5.0");
  });

  it("language-xform-de-multi-en-default" + 'R4', async () => {
    await runTest({"suite":"language","test":"language-xform-de-multi-en-default"}, "4.0");
  });

  it("language-echo-en-designation" + 'R5', async () => {
    await runTest({"suite":"language","test":"language-echo-en-designation"}, "5.0");
  });

  it("language-echo-en-designation" + 'R4', async () => {
    await runTest({"suite":"language","test":"language-echo-en-designation"}, "4.0");
  });

  it("language-echo-en-designations" + 'R5', async () => {
    await runTest({"suite":"language","test":"language-echo-en-designations"}, "5.0");
  });

  it("language-echo-en-designations" + 'R4', async () => {
    await runTest({"suite":"language","test":"language-echo-en-designations"}, "4.0");
  });

});

describe('language2', () => {
  // A series of tests that test display name validation for various permutations of languages

  it("validation-right-de-en" + 'R5', async () => {
    await runTest({"suite":"language2","test":"validation-right-de-en"}, "5.0");
  });

  it("validation-right-de-en" + 'R4', async () => {
    await runTest({"suite":"language2","test":"validation-right-de-en"}, "4.0");
  });

  it("validation-right-de-ende-N" + 'R5', async () => {
    await runTest({"suite":"language2","test":"validation-right-de-ende-N"}, "5.0");
  });

  it("validation-right-de-ende-N" + 'R4', async () => {
    await runTest({"suite":"language2","test":"validation-right-de-ende-N"}, "4.0");
  });

  it("validation-right-de-ende" + 'R5', async () => {
    await runTest({"suite":"language2","test":"validation-right-de-ende"}, "5.0");
  });

  it("validation-right-de-ende" + 'R4', async () => {
    await runTest({"suite":"language2","test":"validation-right-de-ende"}, "4.0");
  });

  it("validation-right-de-none" + 'R5', async () => {
    await runTest({"suite":"language2","test":"validation-right-de-none"}, "5.0");
  });

  it("validation-right-de-none" + 'R4', async () => {
    await runTest({"suite":"language2","test":"validation-right-de-none"}, "4.0");
  });

  it("validation-right-en-en" + 'R5', async () => {
    await runTest({"suite":"language2","test":"validation-right-en-en"}, "5.0");
  });

  it("validation-right-en-en" + 'R4', async () => {
    await runTest({"suite":"language2","test":"validation-right-en-en"}, "4.0");
  });

  it("validation-right-en-ende-N" + 'R5', async () => {
    await runTest({"suite":"language2","test":"validation-right-en-ende-N"}, "5.0");
  });

  it("validation-right-en-ende-N" + 'R4', async () => {
    await runTest({"suite":"language2","test":"validation-right-en-ende-N"}, "4.0");
  });

  it("validation-right-en-ende" + 'R5', async () => {
    await runTest({"suite":"language2","test":"validation-right-en-ende"}, "5.0");
  });

  it("validation-right-en-ende" + 'R4', async () => {
    await runTest({"suite":"language2","test":"validation-right-en-ende"}, "4.0");
  });

  it("validation-right-en-none" + 'R5', async () => {
    await runTest({"suite":"language2","test":"validation-right-en-none"}, "5.0");
  });

  it("validation-right-en-none" + 'R4', async () => {
    await runTest({"suite":"language2","test":"validation-right-en-none"}, "4.0");
  });

  it("validation-right-none-en" + 'R5', async () => {
    await runTest({"suite":"language2","test":"validation-right-none-en"}, "5.0");
  });

  it("validation-right-none-en" + 'R4', async () => {
    await runTest({"suite":"language2","test":"validation-right-none-en"}, "4.0");
  });

  it("validation-right-none-ende-N" + 'R5', async () => {
    await runTest({"suite":"language2","test":"validation-right-none-ende-N"}, "5.0");
  });

  it("validation-right-none-ende-N" + 'R4', async () => {
    await runTest({"suite":"language2","test":"validation-right-none-ende-N"}, "4.0");
  });

  it("validation-right-none-ende" + 'R5', async () => {
    await runTest({"suite":"language2","test":"validation-right-none-ende"}, "5.0");
  });

  it("validation-right-none-ende" + 'R4', async () => {
    await runTest({"suite":"language2","test":"validation-right-none-ende"}, "4.0");
  });

  it("validation-right-none-none" + 'R5', async () => {
    await runTest({"suite":"language2","test":"validation-right-none-none"}, "5.0");
  });

  it("validation-right-none-none" + 'R4', async () => {
    await runTest({"suite":"language2","test":"validation-right-none-none"}, "4.0");
  });

  it("validation-wrong-de-en" + 'R5', async () => {
    await runTest({"suite":"language2","test":"validation-wrong-de-en"}, "5.0");
  });

  it("validation-wrong-de-en" + 'R4', async () => {
    await runTest({"suite":"language2","test":"validation-wrong-de-en"}, "4.0");
  });

  it("validation-wrong-de-en-bad" + 'R5', async () => {
    await runTest({"suite":"language2","test":"validation-wrong-de-en-bad"}, "5.0");
  });

  it("validation-wrong-de-en-bad" + 'R4', async () => {
    await runTest({"suite":"language2","test":"validation-wrong-de-en-bad"}, "4.0");
  });

  it("validation-wrong-de-ende-N" + 'R5', async () => {
    await runTest({"suite":"language2","test":"validation-wrong-de-ende-N"}, "5.0");
  });

  it("validation-wrong-de-ende-N" + 'R4', async () => {
    await runTest({"suite":"language2","test":"validation-wrong-de-ende-N"}, "4.0");
  });

  it("validation-wrong-de-ende" + 'R5', async () => {
    await runTest({"suite":"language2","test":"validation-wrong-de-ende"}, "5.0");
  });

  it("validation-wrong-de-ende" + 'R4', async () => {
    await runTest({"suite":"language2","test":"validation-wrong-de-ende"}, "4.0");
  });

  it("validation-wrong-de-none" + 'R5', async () => {
    await runTest({"suite":"language2","test":"validation-wrong-de-none"}, "5.0");
  });

  it("validation-wrong-de-none" + 'R4', async () => {
    await runTest({"suite":"language2","test":"validation-wrong-de-none"}, "4.0");
  });

  it("validation-wrong-en-en" + 'R5', async () => {
    await runTest({"suite":"language2","test":"validation-wrong-en-en"}, "5.0");
  });

  it("validation-wrong-en-en" + 'R4', async () => {
    await runTest({"suite":"language2","test":"validation-wrong-en-en"}, "4.0");
  });

  it("validation-wrong-en-ende-N" + 'R5', async () => {
    await runTest({"suite":"language2","test":"validation-wrong-en-ende-N"}, "5.0");
  });

  it("validation-wrong-en-ende-N" + 'R4', async () => {
    await runTest({"suite":"language2","test":"validation-wrong-en-ende-N"}, "4.0");
  });

  it("validation-wrong-en-ende" + 'R5', async () => {
    await runTest({"suite":"language2","test":"validation-wrong-en-ende"}, "5.0");
  });

  it("validation-wrong-en-ende" + 'R4', async () => {
    await runTest({"suite":"language2","test":"validation-wrong-en-ende"}, "4.0");
  });

  it("validation-wrong-en-none" + 'R5', async () => {
    await runTest({"suite":"language2","test":"validation-wrong-en-none"}, "5.0");
  });

  it("validation-wrong-en-none" + 'R4', async () => {
    await runTest({"suite":"language2","test":"validation-wrong-en-none"}, "4.0");
  });

  it("validation-wrong-none-en" + 'R5', async () => {
    await runTest({"suite":"language2","test":"validation-wrong-none-en"}, "5.0");
  });

  it("validation-wrong-none-en" + 'R4', async () => {
    await runTest({"suite":"language2","test":"validation-wrong-none-en"}, "4.0");
  });

  it("validation-wrong-none-ende-N" + 'R5', async () => {
    await runTest({"suite":"language2","test":"validation-wrong-none-ende-N"}, "5.0");
  });

  it("validation-wrong-none-ende-N" + 'R4', async () => {
    await runTest({"suite":"language2","test":"validation-wrong-none-ende-N"}, "4.0");
  });

  it("validation-wrong-none-ende" + 'R5', async () => {
    await runTest({"suite":"language2","test":"validation-wrong-none-ende"}, "5.0");
  });

  it("validation-wrong-none-ende" + 'R4', async () => {
    await runTest({"suite":"language2","test":"validation-wrong-none-ende"}, "4.0");
  });

  it("validation-wrong-none-none" + 'R5', async () => {
    await runTest({"suite":"language2","test":"validation-wrong-none-none"}, "5.0");
  });

  it("validation-wrong-none-none" + 'R4', async () => {
    await runTest({"suite":"language2","test":"validation-wrong-none-none"}, "4.0");
  });

});

describe('extensions', () => {
  // Testing proper handling of extensions, which depends on the extension

  it("extensions-echo-all" + 'R5', async () => {
    await runTest({"suite":"extensions","test":"extensions-echo-all"}, "5.0");
  });

  it("extensions-echo-all" + 'R4', async () => {
    await runTest({"suite":"extensions","test":"extensions-echo-all"}, "4.0");
  });

  it("extensions-echo-enumerated" + 'R5', async () => {
    await runTest({"suite":"extensions","test":"extensions-echo-enumerated"}, "5.0");
  });

  it("extensions-echo-enumerated" + 'R4', async () => {
    await runTest({"suite":"extensions","test":"extensions-echo-enumerated"}, "4.0");
  });

  it("extensions-echo-bad-supplement" + 'R5', async () => {
    await runTest({"suite":"extensions","test":"extensions-echo-bad-supplement"}, "5.0");
  });

  it("extensions-echo-bad-supplement" + 'R4', async () => {
    await runTest({"suite":"extensions","test":"extensions-echo-bad-supplement"}, "4.0");
  });

  it("validate-code-bad-supplement" + 'R5', async () => {
    await runTest({"suite":"extensions","test":"validate-code-bad-supplement"}, "5.0");
  });

  it("validate-code-bad-supplement" + 'R4', async () => {
    await runTest({"suite":"extensions","test":"validate-code-bad-supplement"}, "4.0");
  });

  it("validate-coding-bad-supplement" + 'R5', async () => {
    await runTest({"suite":"extensions","test":"validate-coding-bad-supplement"}, "5.0");
  });

  it("validate-coding-bad-supplement" + 'R4', async () => {
    await runTest({"suite":"extensions","test":"validate-coding-bad-supplement"}, "4.0");
  });

  it("validate-coding-bad-supplement-url" + 'R5', async () => {
    await runTest({"suite":"extensions","test":"validate-coding-bad-supplement-url"}, "5.0");
  });

  it("validate-coding-bad-supplement-url" + 'R4', async () => {
    await runTest({"suite":"extensions","test":"validate-coding-bad-supplement-url"}, "4.0");
  });

  it("validate-codeableconcept-bad-supplement" + 'R5', async () => {
    await runTest({"suite":"extensions","test":"validate-codeableconcept-bad-supplement"}, "5.0");
  });

  it("validate-codeableconcept-bad-supplement" + 'R4', async () => {
    await runTest({"suite":"extensions","test":"validate-codeableconcept-bad-supplement"}, "4.0");
  });

  it("validate-coding-good-supplement" + 'R5', async () => {
    await runTest({"suite":"extensions","test":"validate-coding-good-supplement"}, "5.0");
  });

  it("validate-coding-good-supplement" + 'R4', async () => {
    await runTest({"suite":"extensions","test":"validate-coding-good-supplement"}, "4.0");
  });

  it("validate-coding-good2-supplement" + 'R5', async () => {
    await runTest({"suite":"extensions","test":"validate-coding-good2-supplement"}, "5.0");
  });

  it("validate-coding-good2-supplement" + 'R4', async () => {
    await runTest({"suite":"extensions","test":"validate-coding-good2-supplement"}, "4.0");
  });

  it("validate-code-inactive-display-lenient" + 'R5', async () => {
    await runTest({"suite":"extensions","test":"validate-code-inactive-display-lenient"}, "5.0");
  });

  it("validate-code-inactive-display-lenient" + 'R4', async () => {
    await runTest({"suite":"extensions","test":"validate-code-inactive-display-lenient"}, "4.0");
  });

  it("validate-code-inactive-display-notlenient" + 'R5', async () => {
    await runTest({"suite":"extensions","test":"validate-code-inactive-display-notlenient"}, "5.0");
  });

  it("validate-code-inactive-display-notlenient" + 'R4', async () => {
    await runTest({"suite":"extensions","test":"validate-code-inactive-display-notlenient"}, "4.0");
  });

  it("validate-code-inactive" + 'R5', async () => {
    await runTest({"suite":"extensions","test":"validate-code-inactive"}, "5.0");
  });

  it("validate-code-inactive" + 'R4', async () => {
    await runTest({"suite":"extensions","test":"validate-code-inactive"}, "4.0");
  });

});

describe('validation', () => {
  // Testing various validation parameter combinations

  it("validation-simple-code-good" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-good"}, "5.0");
  });

  it("validation-simple-code-good" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-good"}, "4.0");
  });

  it("validation-simple-child-of-child" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-child-of-child"}, "5.0");
  });

  it("validation-simple-child-of-child" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-child-of-child"}, "4.0");
  });

  it("validation-simple-child-of-grandchild" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-child-of-grandchild"}, "5.0");
  });

  it("validation-simple-child-of-grandchild" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-child-of-grandchild"}, "4.0");
  });

  it("validation-simple-code-implied-good" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-implied-good"}, "5.0");
  });

  it("validation-simple-code-implied-good" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-implied-good"}, "4.0");
  });

  it("validation-simple-coding-good" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-good"}, "5.0");
  });

  it("validation-simple-coding-good" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-good"}, "4.0");
  });

  it("validation-simple-codeableconcept-good" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-codeableconcept-good"}, "5.0");
  });

  it("validation-simple-codeableconcept-good" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-codeableconcept-good"}, "4.0");
  });

  it("validation-simple-code-bad-code" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-bad-code"}, "5.0");
  });

  it("validation-simple-code-bad-code" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-bad-code"}, "4.0");
  });

  it("validation-simple-code-implied-bad-code" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-implied-bad-code"}, "5.0");
  });

  it("validation-simple-code-implied-bad-code" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-implied-bad-code"}, "4.0");
  });

  it("validation-simple-coding-bad-code" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-bad-code"}, "5.0");
  });

  it("validation-simple-coding-bad-code" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-bad-code"}, "4.0");
  });

  it("validation-simple-coding-bad-code-inactive" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-bad-code-inactive"}, "5.0");
  });

  it("validation-simple-coding-bad-code-inactive" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-bad-code-inactive"}, "4.0");
  });

  it("validation-simple-codeableconcept-bad-code" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-codeableconcept-bad-code"}, "5.0");
  });

  it("validation-simple-codeableconcept-bad-code" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-codeableconcept-bad-code"}, "4.0");
  });

  it("validation-simple-code-bad-valueSet" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-bad-valueSet"}, "5.0");
  });

  it("validation-simple-code-bad-valueSet" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-bad-valueSet"}, "4.0");
  });

  it("validation-simple-coding-bad-valueSet" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-bad-valueSet"}, "5.0");
  });

  it("validation-simple-coding-bad-valueSet" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-bad-valueSet"}, "4.0");
  });

  it("validation-simple-codeableconcept-bad-valueSet" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-codeableconcept-bad-valueSet"}, "5.0");
  });

  it("validation-simple-codeableconcept-bad-valueSet" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-codeableconcept-bad-valueSet"}, "4.0");
  });

  it("validation-simple-code-bad-import" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-bad-import"}, "5.0");
  });

  it("validation-simple-code-bad-import" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-bad-import"}, "4.0");
  });

  it("validation-simple-coding-bad-import" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-bad-import"}, "5.0");
  });

  it("validation-simple-coding-bad-import" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-bad-import"}, "4.0");
  });

  it("validation-simple-codeableconcept-bad-import" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-codeableconcept-bad-import"}, "5.0");
  });

  it("validation-simple-codeableconcept-bad-import" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-codeableconcept-bad-import"}, "4.0");
  });

  it("validation-simple-code-bad-system" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-bad-system"}, "5.0");
  });

  it("validation-simple-code-bad-system" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-bad-system"}, "4.0");
  });

  it("validation-simple-coding-bad-system" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-bad-system"}, "5.0");
  });

  it("validation-simple-coding-bad-system" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-bad-system"}, "4.0");
  });

  it("validation-simple-codeableconcept-unknown-system" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-codeableconcept-unknown-system"}, "5.0");
  });

  it("validation-simple-codeableconcept-unknown-system" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-codeableconcept-unknown-system"}, "4.0");
  });

  it("validation-simple-coding-bad-system2" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-bad-system2"}, "5.0");
  });

  it("validation-simple-coding-bad-system2" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-bad-system2"}, "4.0");
  });

  it("validation-simple-coding-bad-system-local" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-bad-system-local"}, "5.0");
  });

  it("validation-simple-coding-bad-system-local" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-bad-system-local"}, "4.0");
  });

  it("validation-simple-coding-no-system" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-no-system"}, "5.0");
  });

  it("validation-simple-coding-no-system" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-no-system"}, "4.0");
  });

  it("validation-simple-codeableconcept-bad-system" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-codeableconcept-bad-system"}, "5.0");
  });

  it("validation-simple-codeableconcept-bad-system" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-codeableconcept-bad-system"}, "4.0");
  });

  it("validation-simple-code-good-display" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-good-display"}, "5.0");
  });

  it("validation-simple-code-good-display" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-good-display"}, "4.0");
  });

  it("validation-simple-coding-good-display" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-good-display"}, "5.0");
  });

  it("validation-simple-coding-good-display" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-good-display"}, "4.0");
  });

  it("validation-simple-codeableconcept-good-display" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-codeableconcept-good-display"}, "5.0");
  });

  it("validation-simple-codeableconcept-good-display" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-codeableconcept-good-display"}, "4.0");
  });

  it("validation-simple-code-bad-display-lenient" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-bad-display-lenient"}, "5.0");
  });

  it("validation-simple-code-bad-display-lenient" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-bad-display-lenient"}, "4.0");
  });

  it("validation-simple-code-bad-display-notlenient" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-bad-display-notlenient"}, "5.0");
  });

  it("validation-simple-code-bad-display-notlenient" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-bad-display-notlenient"}, "4.0");
  });

  it("validation-simple-code-bad-display-ws" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-bad-display-ws"}, "5.0");
  });

  it("validation-simple-code-bad-display-ws" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-bad-display-ws"}, "4.0");
  });

  it("validation-simple-coding-bad-display" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-bad-display"}, "5.0");
  });

  it("validation-simple-coding-bad-display" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-bad-display"}, "4.0");
  });

  it("validation-simple-codeableconcept-bad-display" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-codeableconcept-bad-display"}, "5.0");
  });

  it("validation-simple-codeableconcept-bad-display" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-codeableconcept-bad-display"}, "4.0");
  });

  it("validation-simple-code-bad-display-warning" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-bad-display-warning"}, "5.0");
  });

  it("validation-simple-code-bad-display-warning" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-bad-display-warning"}, "4.0");
  });

  it("validation-simple-coding-bad-display-warning" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-bad-display-warning"}, "5.0");
  });

  it("validation-simple-coding-bad-display-warning" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-bad-display-warning"}, "4.0");
  });

  it("validation-simple-codeableconcept-bad-display-warning" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-codeableconcept-bad-display-warning"}, "5.0");
  });

  it("validation-simple-codeableconcept-bad-display-warning" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-codeableconcept-bad-display-warning"}, "4.0");
  });

  it("validation-simple-code-good-language" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-good-language"}, "5.0");
  });

  it("validation-simple-code-good-language" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-good-language"}, "4.0");
  });

  it("validation-simple-coding-good-language" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-good-language"}, "5.0");
  });

  it("validation-simple-coding-good-language" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-good-language"}, "4.0");
  });

  it("validation-simple-codeableconcept-good-language" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-codeableconcept-good-language"}, "5.0");
  });

  it("validation-simple-codeableconcept-good-language" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-codeableconcept-good-language"}, "4.0");
  });

  it("validation-simple-code-bad-language" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-bad-language"}, "5.0");
  });

  it("validation-simple-code-bad-language" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-bad-language"}, "4.0");
  });

  it("validation-simple-code-good-regex" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-good-regex"}, "5.0");
  });

  it("validation-simple-code-good-regex" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-good-regex"}, "4.0");
  });

  it("validation-simple-code-bad-regex" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-bad-regex"}, "5.0");
  });

  it("validation-simple-code-bad-regex" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-bad-regex"}, "4.0");
  });

  it("validation-simple-code-regex-none" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-regex-none"}, "5.0");
  });

  it("validation-simple-code-regex-none" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-regex-none"}, "4.0");
  });

  it("validation-simple-coding-bad-language" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-bad-language"}, "5.0");
  });

  it("validation-simple-coding-bad-language" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-bad-language"}, "4.0");
  });

  it("validation-simple-coding-bad-language-header" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-bad-language-header"}, "5.0");
  });

  it("validation-simple-coding-bad-language-header" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-bad-language-header"}, "4.0");
  });

  it("validation-simple-coding-bad-language-vs" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-bad-language-vs"}, "5.0");
  });

  it("validation-simple-coding-bad-language-vs" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-bad-language-vs"}, "4.0");
  });

  it("validation-simple-coding-bad-language-vslang" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-bad-language-vslang"}, "5.0");
  });

  it("validation-simple-coding-bad-language-vslang" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-bad-language-vslang"}, "4.0");
  });

  it("validation-simple-codeableconcept-bad-language" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-codeableconcept-bad-language"}, "5.0");
  });

  it("validation-simple-codeableconcept-bad-language" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-codeableconcept-bad-language"}, "4.0");
  });

  it("validation-simple-code-good-language-none" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-good-language-none"}, "5.0");
  });

  it("validation-simple-code-good-language-none" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-good-language-none"}, "4.0");
  });

  it("validation-simple-code-bad-language-none" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-bad-language-none"}, "5.0");
  });

  it("validation-simple-code-bad-language-none" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-bad-language-none"}, "4.0");
  });

  it("validation-simple-coding-good-language-none" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-good-language-none"}, "5.0");
  });

  it("validation-simple-coding-good-language-none" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-good-language-none"}, "4.0");
  });

  it("validation-simple-coding-bad-language-none" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-bad-language-none"}, "5.0");
  });

  it("validation-simple-coding-bad-language-none" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-bad-language-none"}, "4.0");
  });

  it("validation-simple-codeableconcept-good-language-none" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-codeableconcept-good-language-none"}, "5.0");
  });

  it("validation-simple-codeableconcept-good-language-none" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-codeableconcept-good-language-none"}, "4.0");
  });

  it("validation-simple-codeableconcept-bad-language-none" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-simple-codeableconcept-bad-language-none"}, "5.0");
  });

  it("validation-simple-codeableconcept-bad-language-none" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-simple-codeableconcept-bad-language-none"}, "4.0");
  });

  it("validation-complex-codeableconcept-full" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-complex-codeableconcept-full"}, "5.0");
  });

  it("validation-complex-codeableconcept-full" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-complex-codeableconcept-full"}, "4.0");
  });

  it("validation-complex-codeableconcept-vsonly" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-complex-codeableconcept-vsonly"}, "5.0");
  });

  it("validation-complex-codeableconcept-vsonly" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-complex-codeableconcept-vsonly"}, "4.0");
  });

  it("validation-cs-code-good" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-cs-code-good"}, "5.0");
  });

  it("validation-cs-code-good" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-cs-code-good"}, "4.0");
  });

  it("validation-cs-code-bad-code" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-cs-code-bad-code"}, "5.0");
  });

  it("validation-cs-code-bad-code" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-cs-code-bad-code"}, "4.0");
  });

  it("validation-contained-good" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-contained-good"}, "5.0");
  });

  it("validation-contained-good" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-contained-good"}, "4.0");
  });

  it("validation-contained-bad" + 'R5', async () => {
    await runTest({"suite":"validation","test":"validation-contained-bad"}, "5.0");
  });

  it("validation-contained-bad" + 'R4', async () => {
    await runTest({"suite":"validation","test":"validation-contained-bad"}, "4.0");
  });

});

describe('version', () => {
  // Testing various version issues. There's two versions of a code system, and three value sets that select different versions

  it("version-simple-code-bad-version1" + 'R5', async () => {
    await runTest({"suite":"version","test":"version-simple-code-bad-version1"}, "5.0");
  });

  it("version-simple-code-bad-version1" + 'R4', async () => {
    await runTest({"suite":"version","test":"version-simple-code-bad-version1"}, "4.0");
  });

  it("version-simple-coding-bad-version1" + 'R5', async () => {
    await runTest({"suite":"version","test":"version-simple-coding-bad-version1"}, "5.0");
  });

  it("version-simple-coding-bad-version1" + 'R4', async () => {
    await runTest({"suite":"version","test":"version-simple-coding-bad-version1"}, "4.0");
  });

  it("version-simple-codeableconcept-bad-version1" + 'R5', async () => {
    await runTest({"suite":"version","test":"version-simple-codeableconcept-bad-version1"}, "5.0");
  });

  it("version-simple-codeableconcept-bad-version1" + 'R4', async () => {
    await runTest({"suite":"version","test":"version-simple-codeableconcept-bad-version1"}, "4.0");
  });

  it("version-simple-codeableconcept-bad-version2" + 'R5', async () => {
    await runTest({"suite":"version","test":"version-simple-codeableconcept-bad-version2"}, "5.0");
  });

  it("version-simple-codeableconcept-bad-version2" + 'R4', async () => {
    await runTest({"suite":"version","test":"version-simple-codeableconcept-bad-version2"}, "4.0");
  });

  it("version-simple-code-good-version" + 'R5', async () => {
    await runTest({"suite":"version","test":"version-simple-code-good-version"}, "5.0");
  });

  it("version-simple-code-good-version" + 'R4', async () => {
    await runTest({"suite":"version","test":"version-simple-code-good-version"}, "4.0");
  });

  it("version-simple-coding-good-version" + 'R5', async () => {
    await runTest({"suite":"version","test":"version-simple-coding-good-version"}, "5.0");
  });

  it("version-simple-coding-good-version" + 'R4', async () => {
    await runTest({"suite":"version","test":"version-simple-coding-good-version"}, "4.0");
  });

  it("version-simple-codeableconcept-good-version" + 'R5', async () => {
    await runTest({"suite":"version","test":"version-simple-codeableconcept-good-version"}, "5.0");
  });

  it("version-simple-codeableconcept-good-version" + 'R4', async () => {
    await runTest({"suite":"version","test":"version-simple-codeableconcept-good-version"}, "4.0");
  });

  it("version-version-profile-none" + 'R5', async () => {
    await runTest({"suite":"version","test":"version-version-profile-none"}, "5.0");
  });

  it("version-version-profile-none" + 'R4', async () => {
    await runTest({"suite":"version","test":"version-version-profile-none"}, "4.0");
  });

  it("version-version-profile-default" + 'R5', async () => {
    await runTest({"suite":"version","test":"version-version-profile-default"}, "5.0");
  });

  it("version-version-profile-default" + 'R4', async () => {
    await runTest({"suite":"version","test":"version-version-profile-default"}, "4.0");
  });

  it("validation-version-profile-coding" + 'R5', async () => {
    await runTest({"suite":"version","test":"validation-version-profile-coding"}, "5.0");
  });

  it("validation-version-profile-coding" + 'R4', async () => {
    await runTest({"suite":"version","test":"validation-version-profile-coding"}, "4.0");
  });

  it("coding-vnn-vsnn" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vsnn"}, "5.0");
  });

  it("coding-vnn-vsnn" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vsnn"}, "4.0");
  });

  it("coding-v10-vs1w" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-v10-vs1w"}, "5.0");
  });

  it("coding-v10-vs1w" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-v10-vs1w"}, "4.0");
  });

  it("coding-v10-vs1wb" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-v10-vs1wb"}, "5.0");
  });

  it("coding-v10-vs1wb" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-v10-vs1wb"}, "4.0");
  });

  it("coding-v10-vs10" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-v10-vs10"}, "5.0");
  });

  it("coding-v10-vs10" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-v10-vs10"}, "4.0");
  });

  it("coding-v10-vs20" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-v10-vs20"}, "5.0");
  });

  it("coding-v10-vs20" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-v10-vs20"}, "4.0");
  });

  it("coding-v10-vsbb" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-v10-vsbb"}, "5.0");
  });

  it("coding-v10-vsbb" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-v10-vsbb"}, "4.0");
  });

  it("coding-v10-vsbb" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-v10-vsbb"}, "5.0");
  });

  it("coding-v10-vsbb" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-v10-vsbb"}, "4.0");
  });

  it("coding-v10-vsnn" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-v10-vsnn"}, "5.0");
  });

  it("coding-v10-vsnn" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-v10-vsnn"}, "4.0");
  });

  it("coding-vbb-vs10" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-vbb-vs10"}, "5.0");
  });

  it("coding-vbb-vs10" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-vbb-vs10"}, "4.0");
  });

  it("coding-vbb-vsnn" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-vbb-vsnn"}, "5.0");
  });

  it("coding-vbb-vsnn" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-vbb-vsnn"}, "4.0");
  });

  it("coding-vnn-vs1w" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vs1w"}, "5.0");
  });

  it("coding-vnn-vs1w" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vs1w"}, "4.0");
  });

  it("coding-vnn-vs1wb" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vs1wb"}, "5.0");
  });

  it("coding-vnn-vs1wb" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vs1wb"}, "4.0");
  });

  it("coding-vnn-vs10" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vs10"}, "5.0");
  });

  it("coding-vnn-vs10" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vs10"}, "4.0");
  });

  it("coding-vnn-vsbb" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vsbb"}, "5.0");
  });

  it("coding-vnn-vsbb" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vsbb"}, "4.0");
  });

  it("coding-vnn-vsnn-default" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vsnn-default"}, "5.0");
  });

  it("coding-vnn-vsnn-default" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vsnn-default"}, "4.0");
  });

  it("coding-v10-vs1w-default" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-v10-vs1w-default"}, "5.0");
  });

  it("coding-v10-vs1w-default" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-v10-vs1w-default"}, "4.0");
  });

  it("coding-v10-vs1wb-default" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-v10-vs1wb-default"}, "5.0");
  });

  it("coding-v10-vs1wb-default" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-v10-vs1wb-default"}, "4.0");
  });

  it("coding-v10-vs10-default" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-v10-vs10-default"}, "5.0");
  });

  it("coding-v10-vs10-default" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-v10-vs10-default"}, "4.0");
  });

  it("coding-v10-vs20-default" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-v10-vs20-default"}, "5.0");
  });

  it("coding-v10-vs20-default" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-v10-vs20-default"}, "4.0");
  });

  it("coding-v10-vsbb-default" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-v10-vsbb-default"}, "5.0");
  });

  it("coding-v10-vsbb-default" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-v10-vsbb-default"}, "4.0");
  });

  it("coding-v10-vsnn-default" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-v10-vsnn-default"}, "5.0");
  });

  it("coding-v10-vsnn-default" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-v10-vsnn-default"}, "4.0");
  });

  it("coding-vbb-vs10-default" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-vbb-vs10-default"}, "5.0");
  });

  it("coding-vbb-vs10-default" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-vbb-vs10-default"}, "4.0");
  });

  it("coding-vbb-vsnn-default" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-vbb-vsnn-default"}, "5.0");
  });

  it("coding-vbb-vsnn-default" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-vbb-vsnn-default"}, "4.0");
  });

  it("coding-vnn-vs1w-default" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vs1w-default"}, "5.0");
  });

  it("coding-vnn-vs1w-default" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vs1w-default"}, "4.0");
  });

  it("coding-vnn-vs1wb-default" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vs1wb-default"}, "5.0");
  });

  it("coding-vnn-vs1wb-default" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vs1wb-default"}, "4.0");
  });

  it("coding-vnn-vs10-default" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vs10-default"}, "5.0");
  });

  it("coding-vnn-vs10-default" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vs10-default"}, "4.0");
  });

  it("coding-vnn-vsbb-default" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vsbb-default"}, "5.0");
  });

  it("coding-vnn-vsbb-default" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vsbb-default"}, "4.0");
  });

  it("coding-vnn-vsnn-check" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vsnn-check"}, "5.0");
  });

  it("coding-vnn-vsnn-check" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vsnn-check"}, "4.0");
  });

  it("coding-v10-vs1w-check" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-v10-vs1w-check"}, "5.0");
  });

  it("coding-v10-vs1w-check" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-v10-vs1w-check"}, "4.0");
  });

  it("coding-v10-vs1wb-check" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-v10-vs1wb-check"}, "5.0");
  });

  it("coding-v10-vs1wb-check" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-v10-vs1wb-check"}, "4.0");
  });

  it("coding-v10-vs10-check" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-v10-vs10-check"}, "5.0");
  });

  it("coding-v10-vs10-check" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-v10-vs10-check"}, "4.0");
  });

  it("coding-v10-vs20-check" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-v10-vs20-check"}, "5.0");
  });

  it("coding-v10-vs20-check" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-v10-vs20-check"}, "4.0");
  });

  it("coding-v10-vsbb-check" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-v10-vsbb-check"}, "5.0");
  });

  it("coding-v10-vsbb-check" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-v10-vsbb-check"}, "4.0");
  });

  it("coding-v10-vsnn-check" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-v10-vsnn-check"}, "5.0");
  });

  it("coding-v10-vsnn-check" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-v10-vsnn-check"}, "4.0");
  });

  it("coding-vbb-vs10-check" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-vbb-vs10-check"}, "5.0");
  });

  it("coding-vbb-vs10-check" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-vbb-vs10-check"}, "4.0");
  });

  it("coding-vbb-vsnn-check" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-vbb-vsnn-check"}, "5.0");
  });

  it("coding-vbb-vsnn-check" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-vbb-vsnn-check"}, "4.0");
  });

  it("coding-vnn-vs1w-check" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vs1w-check"}, "5.0");
  });

  it("coding-vnn-vs1w-check" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vs1w-check"}, "4.0");
  });

  it("coding-vnn-vs1wb-check" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vs1wb-check"}, "5.0");
  });

  it("coding-vnn-vs1wb-check" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vs1wb-check"}, "4.0");
  });

  it("coding-vnn-vs10-check" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vs10-check"}, "5.0");
  });

  it("coding-vnn-vs10-check" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vs10-check"}, "4.0");
  });

  it("coding-vnn-vsbb-check" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vsbb-check"}, "5.0");
  });

  it("coding-vnn-vsbb-check" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vsbb-check"}, "4.0");
  });

  it("coding-vnn-vsnn-force" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vsnn-force"}, "5.0");
  });

  it("coding-vnn-vsnn-force" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vsnn-force"}, "4.0");
  });

  it("coding-v10-vs1w-force" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-v10-vs1w-force"}, "5.0");
  });

  it("coding-v10-vs1w-force" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-v10-vs1w-force"}, "4.0");
  });

  it("coding-v10-vs1wb-force" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-v10-vs1wb-force"}, "5.0");
  });

  it("coding-v10-vs1wb-force" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-v10-vs1wb-force"}, "4.0");
  });

  it("coding-v10-vs10-force" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-v10-vs10-force"}, "5.0");
  });

  it("coding-v10-vs10-force" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-v10-vs10-force"}, "4.0");
  });

  it("coding-v10-vs20-force" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-v10-vs20-force"}, "5.0");
  });

  it("coding-v10-vs20-force" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-v10-vs20-force"}, "4.0");
  });

  it("coding-v10-vsbb-force" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-v10-vsbb-force"}, "5.0");
  });

  it("coding-v10-vsbb-force" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-v10-vsbb-force"}, "4.0");
  });

  it("coding-v10-vsnn-force" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-v10-vsnn-force"}, "5.0");
  });

  it("coding-v10-vsnn-force" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-v10-vsnn-force"}, "4.0");
  });

  it("coding-vbb-vs10-force" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-vbb-vs10-force"}, "5.0");
  });

  it("coding-vbb-vs10-force" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-vbb-vs10-force"}, "4.0");
  });

  it("coding-vbb-vsnn-force" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-vbb-vsnn-force"}, "5.0");
  });

  it("coding-vbb-vsnn-force" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-vbb-vsnn-force"}, "4.0");
  });

  it("coding-vnn-vs1w-force" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vs1w-force"}, "5.0");
  });

  it("coding-vnn-vs1w-force" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vs1w-force"}, "4.0");
  });

  it("coding-vnn-vs1wb-force" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vs1wb-force"}, "5.0");
  });

  it("coding-vnn-vs1wb-force" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vs1wb-force"}, "4.0");
  });

  it("coding-vnn-vs10-force" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vs10-force"}, "5.0");
  });

  it("coding-vnn-vs10-force" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vs10-force"}, "4.0");
  });

  it("coding-vnn-vsbb-force" + 'R5', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vsbb-force"}, "5.0");
  });

  it("coding-vnn-vsbb-force" + 'R4', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vsbb-force"}, "4.0");
  });

  it("codeableconcept-vnn-vsnn" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vsnn"}, "5.0");
  });

  it("codeableconcept-vnn-vsnn" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vsnn"}, "4.0");
  });

  it("codeableconcept-v10-vs1w" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vs1w"}, "5.0");
  });

  it("codeableconcept-v10-vs1w" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vs1w"}, "4.0");
  });

  it("codeableconcept-v10-vs1wb" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vs1wb"}, "5.0");
  });

  it("codeableconcept-v10-vs1wb" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vs1wb"}, "4.0");
  });

  it("codeableconcept-v10-vs10" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vs10"}, "5.0");
  });

  it("codeableconcept-v10-vs10" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vs10"}, "4.0");
  });

  it("codeableconcept-v10-vs20" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vs20"}, "5.0");
  });

  it("codeableconcept-v10-vs20" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vs20"}, "4.0");
  });

  it("codeableconcept-v10-vsbb" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vsbb"}, "5.0");
  });

  it("codeableconcept-v10-vsbb" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vsbb"}, "4.0");
  });

  it("codeableconcept-v10-vsbb" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vsbb"}, "5.0");
  });

  it("codeableconcept-v10-vsbb" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vsbb"}, "4.0");
  });

  it("codeableconcept-v10-vsnn" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vsnn"}, "5.0");
  });

  it("codeableconcept-v10-vsnn" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vsnn"}, "4.0");
  });

  it("codeableconcept-vbb-vs10" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vbb-vs10"}, "5.0");
  });

  it("codeableconcept-vbb-vs10" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vbb-vs10"}, "4.0");
  });

  it("codeableconcept-vbb-vsnn" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vbb-vsnn"}, "5.0");
  });

  it("codeableconcept-vbb-vsnn" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vbb-vsnn"}, "4.0");
  });

  it("codeableconcept-vnn-vs1w" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vs1w"}, "5.0");
  });

  it("codeableconcept-vnn-vs1w" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vs1w"}, "4.0");
  });

  it("codeableconcept-vnn-vs1wb" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vs1wb"}, "5.0");
  });

  it("codeableconcept-vnn-vs1wb" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vs1wb"}, "4.0");
  });

  it("codeableconcept-vnn-vs10" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vs10"}, "5.0");
  });

  it("codeableconcept-vnn-vs10" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vs10"}, "4.0");
  });

  it("codeableconcept-vnn-vsbb" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vsbb"}, "5.0");
  });

  it("codeableconcept-vnn-vsbb" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vsbb"}, "4.0");
  });

  it("codeableconcept-vnn-vsnn-default" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vsnn-default"}, "5.0");
  });

  it("codeableconcept-vnn-vsnn-default" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vsnn-default"}, "4.0");
  });

  it("codeableconcept-v10-vs1w-default" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vs1w-default"}, "5.0");
  });

  it("codeableconcept-v10-vs1w-default" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vs1w-default"}, "4.0");
  });

  it("codeableconcept-v10-vs1wb-default" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vs1wb-default"}, "5.0");
  });

  it("codeableconcept-v10-vs1wb-default" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vs1wb-default"}, "4.0");
  });

  it("codeableconcept-v10-vs10-default" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vs10-default"}, "5.0");
  });

  it("codeableconcept-v10-vs10-default" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vs10-default"}, "4.0");
  });

  it("codeableconcept-v10-vs20-default" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vs20-default"}, "5.0");
  });

  it("codeableconcept-v10-vs20-default" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vs20-default"}, "4.0");
  });

  it("codeableconcept-v10-vsbb-default" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vsbb-default"}, "5.0");
  });

  it("codeableconcept-v10-vsbb-default" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vsbb-default"}, "4.0");
  });

  it("codeableconcept-v10-vsnn-default" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vsnn-default"}, "5.0");
  });

  it("codeableconcept-v10-vsnn-default" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vsnn-default"}, "4.0");
  });

  it("codeableconcept-vbb-vs10-default" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vbb-vs10-default"}, "5.0");
  });

  it("codeableconcept-vbb-vs10-default" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vbb-vs10-default"}, "4.0");
  });

  it("codeableconcept-vbb-vsnn-default" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vbb-vsnn-default"}, "5.0");
  });

  it("codeableconcept-vbb-vsnn-default" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vbb-vsnn-default"}, "4.0");
  });

  it("codeableconcept-vnn-vs1w-default" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vs1w-default"}, "5.0");
  });

  it("codeableconcept-vnn-vs1w-default" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vs1w-default"}, "4.0");
  });

  it("codeableconcept-vnn-vs1wb-default" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vs1wb-default"}, "5.0");
  });

  it("codeableconcept-vnn-vs1wb-default" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vs1wb-default"}, "4.0");
  });

  it("codeableconcept-vnn-vs10-default" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vs10-default"}, "5.0");
  });

  it("codeableconcept-vnn-vs10-default" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vs10-default"}, "4.0");
  });

  it("codeableconcept-vnn-vsbb-default" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vsbb-default"}, "5.0");
  });

  it("codeableconcept-vnn-vsbb-default" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vsbb-default"}, "4.0");
  });

  it("codeableconcept-vnn-vsnn-check" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vsnn-check"}, "5.0");
  });

  it("codeableconcept-vnn-vsnn-check" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vsnn-check"}, "4.0");
  });

  it("codeableconcept-v10-vs1w-check" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vs1w-check"}, "5.0");
  });

  it("codeableconcept-v10-vs1w-check" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vs1w-check"}, "4.0");
  });

  it("codeableconcept-v10-vs1wb-check" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vs1wb-check"}, "5.0");
  });

  it("codeableconcept-v10-vs1wb-check" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vs1wb-check"}, "4.0");
  });

  it("codeableconcept-v10-vs10-check" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vs10-check"}, "5.0");
  });

  it("codeableconcept-v10-vs10-check" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vs10-check"}, "4.0");
  });

  it("codeableconcept-v10-vs20-check" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vs20-check"}, "5.0");
  });

  it("codeableconcept-v10-vs20-check" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vs20-check"}, "4.0");
  });

  it("codeableconcept-v10-vsbb-check" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vsbb-check"}, "5.0");
  });

  it("codeableconcept-v10-vsbb-check" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vsbb-check"}, "4.0");
  });

  it("codeableconcept-v10-vsnn-check" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vsnn-check"}, "5.0");
  });

  it("codeableconcept-v10-vsnn-check" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vsnn-check"}, "4.0");
  });

  it("codeableconcept-vbb-vs10-check" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vbb-vs10-check"}, "5.0");
  });

  it("codeableconcept-vbb-vs10-check" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vbb-vs10-check"}, "4.0");
  });

  it("codeableconcept-vbb-vsnn-check" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vbb-vsnn-check"}, "5.0");
  });

  it("codeableconcept-vbb-vsnn-check" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vbb-vsnn-check"}, "4.0");
  });

  it("codeableconcept-vnn-vs1w-check" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vs1w-check"}, "5.0");
  });

  it("codeableconcept-vnn-vs1w-check" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vs1w-check"}, "4.0");
  });

  it("codeableconcept-vnn-vs1wb-check" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vs1wb-check"}, "5.0");
  });

  it("codeableconcept-vnn-vs1wb-check" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vs1wb-check"}, "4.0");
  });

  it("codeableconcept-vnn-vs10-check" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vs10-check"}, "5.0");
  });

  it("codeableconcept-vnn-vs10-check" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vs10-check"}, "4.0");
  });

  it("codeableconcept-vnn-vsbb-check" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vsbb-check"}, "5.0");
  });

  it("codeableconcept-vnn-vsbb-check" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vsbb-check"}, "4.0");
  });

  it("codeableconcept-vnn-vsnn-force" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vsnn-force"}, "5.0");
  });

  it("codeableconcept-vnn-vsnn-force" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vsnn-force"}, "4.0");
  });

  it("codeableconcept-v10-vs1w-force" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vs1w-force"}, "5.0");
  });

  it("codeableconcept-v10-vs1w-force" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vs1w-force"}, "4.0");
  });

  it("codeableconcept-v10-vs1wb-force" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vs1wb-force"}, "5.0");
  });

  it("codeableconcept-v10-vs1wb-force" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vs1wb-force"}, "4.0");
  });

  it("codeableconcept-v10-vs10-force" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vs10-force"}, "5.0");
  });

  it("codeableconcept-v10-vs10-force" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vs10-force"}, "4.0");
  });

  it("codeableconcept-v10-vs20-force" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vs20-force"}, "5.0");
  });

  it("codeableconcept-v10-vs20-force" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vs20-force"}, "4.0");
  });

  it("codeableconcept-v10-vsbb-force" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vsbb-force"}, "5.0");
  });

  it("codeableconcept-v10-vsbb-force" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vsbb-force"}, "4.0");
  });

  it("codeableconcept-v10-vsnn-force" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vsnn-force"}, "5.0");
  });

  it("codeableconcept-v10-vsnn-force" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vsnn-force"}, "4.0");
  });

  it("codeableconcept-vbb-vs10-force" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vbb-vs10-force"}, "5.0");
  });

  it("codeableconcept-vbb-vs10-force" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vbb-vs10-force"}, "4.0");
  });

  it("codeableconcept-vbb-vsnn-force" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vbb-vsnn-force"}, "5.0");
  });

  it("codeableconcept-vbb-vsnn-force" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vbb-vsnn-force"}, "4.0");
  });

  it("codeableconcept-vnn-vs1w-force" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vs1w-force"}, "5.0");
  });

  it("codeableconcept-vnn-vs1w-force" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vs1w-force"}, "4.0");
  });

  it("codeableconcept-vnn-vs1wb-force" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vs1wb-force"}, "5.0");
  });

  it("codeableconcept-vnn-vs1wb-force" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vs1wb-force"}, "4.0");
  });

  it("codeableconcept-vnn-vs10-force" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vs10-force"}, "5.0");
  });

  it("codeableconcept-vnn-vs10-force" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vs10-force"}, "4.0");
  });

  it("codeableconcept-vnn-vsbb-force" + 'R5', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vsbb-force"}, "5.0");
  });

  it("codeableconcept-vnn-vsbb-force" + 'R4', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vsbb-force"}, "4.0");
  });

  it("code-vnn-vsnn" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-vnn-vsnn"}, "5.0");
  });

  it("code-vnn-vsnn" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-vnn-vsnn"}, "4.0");
  });

  it("code-v10-vs1w" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-v10-vs1w"}, "5.0");
  });

  it("code-v10-vs1w" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-v10-vs1w"}, "4.0");
  });

  it("code-v10-vs1wb" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-v10-vs1wb"}, "5.0");
  });

  it("code-v10-vs1wb" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-v10-vs1wb"}, "4.0");
  });

  it("code-v10-vs10" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-v10-vs10"}, "5.0");
  });

  it("code-v10-vs10" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-v10-vs10"}, "4.0");
  });

  it("code-v10-vs20" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-v10-vs20"}, "5.0");
  });

  it("code-v10-vs20" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-v10-vs20"}, "4.0");
  });

  it("code-v10-vsbb" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-v10-vsbb"}, "5.0");
  });

  it("code-v10-vsbb" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-v10-vsbb"}, "4.0");
  });

  it("code-v10-vsnn" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-v10-vsnn"}, "5.0");
  });

  it("code-v10-vsnn" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-v10-vsnn"}, "4.0");
  });

  it("code-vbb-vs10" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-vbb-vs10"}, "5.0");
  });

  it("code-vbb-vs10" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-vbb-vs10"}, "4.0");
  });

  it("code-vbb-vsnn" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-vbb-vsnn"}, "5.0");
  });

  it("code-vbb-vsnn" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-vbb-vsnn"}, "4.0");
  });

  it("code-vnn-vs1w" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-vnn-vs1w"}, "5.0");
  });

  it("code-vnn-vs1w" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-vnn-vs1w"}, "4.0");
  });

  it("code-vnn-vs1wb" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-vnn-vs1wb"}, "5.0");
  });

  it("code-vnn-vs1wb" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-vnn-vs1wb"}, "4.0");
  });

  it("code-vnn-vs10" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-vnn-vs10"}, "5.0");
  });

  it("code-vnn-vs10" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-vnn-vs10"}, "4.0");
  });

  it("code-vnn-vsbb" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-vnn-vsbb"}, "5.0");
  });

  it("code-vnn-vsbb" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-vnn-vsbb"}, "4.0");
  });

  it("code-vnn-vsnn-default" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-vnn-vsnn-default"}, "5.0");
  });

  it("code-vnn-vsnn-default" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-vnn-vsnn-default"}, "4.0");
  });

  it("code-v10-vs1w-default" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-v10-vs1w-default"}, "5.0");
  });

  it("code-v10-vs1w-default" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-v10-vs1w-default"}, "4.0");
  });

  it("code-v10-vs1wb-default" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-v10-vs1wb-default"}, "5.0");
  });

  it("code-v10-vs1wb-default" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-v10-vs1wb-default"}, "4.0");
  });

  it("code-v10-vs10-default" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-v10-vs10-default"}, "5.0");
  });

  it("code-v10-vs10-default" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-v10-vs10-default"}, "4.0");
  });

  it("code-v10-vs20-default" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-v10-vs20-default"}, "5.0");
  });

  it("code-v10-vs20-default" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-v10-vs20-default"}, "4.0");
  });

  it("code-v10-vsbb-default" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-v10-vsbb-default"}, "5.0");
  });

  it("code-v10-vsbb-default" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-v10-vsbb-default"}, "4.0");
  });

  it("code-v10-vsnn-default" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-v10-vsnn-default"}, "5.0");
  });

  it("code-v10-vsnn-default" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-v10-vsnn-default"}, "4.0");
  });

  it("code-vbb-vs10-default" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-vbb-vs10-default"}, "5.0");
  });

  it("code-vbb-vs10-default" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-vbb-vs10-default"}, "4.0");
  });

  it("code-vbb-vsnn-default" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-vbb-vsnn-default"}, "5.0");
  });

  it("code-vbb-vsnn-default" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-vbb-vsnn-default"}, "4.0");
  });

  it("code-vnn-vs1wb-default" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-vnn-vs1wb-default"}, "5.0");
  });

  it("code-vnn-vs1wb-default" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-vnn-vs1wb-default"}, "4.0");
  });

  it("code-vnn-vs10-default" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-vnn-vs10-default"}, "5.0");
  });

  it("code-vnn-vs10-default" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-vnn-vs10-default"}, "4.0");
  });

  it("code-vnn-vsbb-default" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-vnn-vsbb-default"}, "5.0");
  });

  it("code-vnn-vsbb-default" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-vnn-vsbb-default"}, "4.0");
  });

  it("code-vnn-vsnn-check" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-vnn-vsnn-check"}, "5.0");
  });

  it("code-vnn-vsnn-check" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-vnn-vsnn-check"}, "4.0");
  });

  it("code-v10-vs1w-check" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-v10-vs1w-check"}, "5.0");
  });

  it("code-v10-vs1w-check" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-v10-vs1w-check"}, "4.0");
  });

  it("code-v10-vs1wb-check" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-v10-vs1wb-check"}, "5.0");
  });

  it("code-v10-vs1wb-check" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-v10-vs1wb-check"}, "4.0");
  });

  it("code-v10-vs10-check" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-v10-vs10-check"}, "5.0");
  });

  it("code-v10-vs10-check" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-v10-vs10-check"}, "4.0");
  });

  it("code-v10-vs20-check" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-v10-vs20-check"}, "5.0");
  });

  it("code-v10-vs20-check" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-v10-vs20-check"}, "4.0");
  });

  it("code-v10-vsbb-check" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-v10-vsbb-check"}, "5.0");
  });

  it("code-v10-vsbb-check" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-v10-vsbb-check"}, "4.0");
  });

  it("code-v10-vsnn-check" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-v10-vsnn-check"}, "5.0");
  });

  it("code-v10-vsnn-check" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-v10-vsnn-check"}, "4.0");
  });

  it("code-vbb-vs10-check" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-vbb-vs10-check"}, "5.0");
  });

  it("code-vbb-vs10-check" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-vbb-vs10-check"}, "4.0");
  });

  it("code-vbb-vsnn-check" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-vbb-vsnn-check"}, "5.0");
  });

  it("code-vbb-vsnn-check" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-vbb-vsnn-check"}, "4.0");
  });

  it("code-vnn-vs1w-check" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-vnn-vs1w-check"}, "5.0");
  });

  it("code-vnn-vs1w-check" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-vnn-vs1w-check"}, "4.0");
  });

  it("code-vnn-vs1wb-check" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-vnn-vs1wb-check"}, "5.0");
  });

  it("code-vnn-vs1wb-check" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-vnn-vs1wb-check"}, "4.0");
  });

  it("code-vnn-vs10-check" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-vnn-vs10-check"}, "5.0");
  });

  it("code-vnn-vs10-check" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-vnn-vs10-check"}, "4.0");
  });

  it("code-vnn-vsbb-check" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-vnn-vsbb-check"}, "5.0");
  });

  it("code-vnn-vsbb-check" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-vnn-vsbb-check"}, "4.0");
  });

  it("code-vnn-vsnn-force" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-vnn-vsnn-force"}, "5.0");
  });

  it("code-vnn-vsnn-force" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-vnn-vsnn-force"}, "4.0");
  });

  it("code-v10-vs1w-force" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-v10-vs1w-force"}, "5.0");
  });

  it("code-v10-vs1w-force" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-v10-vs1w-force"}, "4.0");
  });

  it("code-v10-vs1wb-force" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-v10-vs1wb-force"}, "5.0");
  });

  it("code-v10-vs1wb-force" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-v10-vs1wb-force"}, "4.0");
  });

  it("code-v10-vs10-force" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-v10-vs10-force"}, "5.0");
  });

  it("code-v10-vs10-force" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-v10-vs10-force"}, "4.0");
  });

  it("code-v10-vs20-force" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-v10-vs20-force"}, "5.0");
  });

  it("code-v10-vs20-force" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-v10-vs20-force"}, "4.0");
  });

  it("code-v10-vsbb-force" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-v10-vsbb-force"}, "5.0");
  });

  it("code-v10-vsbb-force" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-v10-vsbb-force"}, "4.0");
  });

  it("code-v10-vsnn-force" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-v10-vsnn-force"}, "5.0");
  });

  it("code-v10-vsnn-force" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-v10-vsnn-force"}, "4.0");
  });

  it("code-vbb-vs10-force" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-vbb-vs10-force"}, "5.0");
  });

  it("code-vbb-vs10-force" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-vbb-vs10-force"}, "4.0");
  });

  it("code-vbb-vsnn-force" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-vbb-vsnn-force"}, "5.0");
  });

  it("code-vbb-vsnn-force" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-vbb-vsnn-force"}, "4.0");
  });

  it("code-vnn-vs1w-force" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-vnn-vs1w-force"}, "5.0");
  });

  it("code-vnn-vs1w-force" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-vnn-vs1w-force"}, "4.0");
  });

  it("code-vnn-vs1wb-force" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-vnn-vs1wb-force"}, "5.0");
  });

  it("code-vnn-vs1wb-force" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-vnn-vs1wb-force"}, "4.0");
  });

  it("code-vnn-vs10-force" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-vnn-vs10-force"}, "5.0");
  });

  it("code-vnn-vs10-force" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-vnn-vs10-force"}, "4.0");
  });

  it("code-vnn-vsbb-force" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-vnn-vsbb-force"}, "5.0");
  });

  it("code-vnn-vsbb-force" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-vnn-vsbb-force"}, "4.0");
  });

  it("code-vnn-vsmix-1" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-vnn-vsmix-1"}, "5.0");
  });

  it("code-vnn-vsmix-1" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-vnn-vsmix-1"}, "4.0");
  });

  it("code-vnn-vsmix-2" + 'R5', async () => {
    await runTest({"suite":"version","test":"code-vnn-vsmix-2"}, "5.0");
  });

  it("code-vnn-vsmix-2" + 'R4', async () => {
    await runTest({"suite":"version","test":"code-vnn-vsmix-2"}, "4.0");
  });

  it("vs-expand-all-v" + 'R5', async () => {
    await runTest({"suite":"version","test":"vs-expand-all-v"}, "5.0");
  });

  it("vs-expand-all-v" + 'R4', async () => {
    await runTest({"suite":"version","test":"vs-expand-all-v"}, "4.0");
  });

  it("vs-expand-all-v1" + 'R5', async () => {
    await runTest({"suite":"version","test":"vs-expand-all-v1"}, "5.0");
  });

  it("vs-expand-all-v1" + 'R4', async () => {
    await runTest({"suite":"version","test":"vs-expand-all-v1"}, "4.0");
  });

  it("vs-expand-all-v2" + 'R5', async () => {
    await runTest({"suite":"version","test":"vs-expand-all-v2"}, "5.0");
  });

  it("vs-expand-all-v2" + 'R4', async () => {
    await runTest({"suite":"version","test":"vs-expand-all-v2"}, "4.0");
  });

  it("vs-expand-v-mixed" + 'R5', async () => {
    await runTest({"suite":"version","test":"vs-expand-v-mixed"}, "5.0");
  });

  it("vs-expand-v-mixed" + 'R4', async () => {
    await runTest({"suite":"version","test":"vs-expand-v-mixed"}, "4.0");
  });

  it("vs-expand-v-n-request" + 'R5', async () => {
    await runTest({"suite":"version","test":"vs-expand-v-n-request"}, "5.0");
  });

  it("vs-expand-v-n-request" + 'R4', async () => {
    await runTest({"suite":"version","test":"vs-expand-v-n-request"}, "4.0");
  });

  it("vs-expand-v-w" + 'R5', async () => {
    await runTest({"suite":"version","test":"vs-expand-v-w"}, "5.0");
  });

  it("vs-expand-v-w" + 'R4', async () => {
    await runTest({"suite":"version","test":"vs-expand-v-w"}, "4.0");
  });

  it("vs-expand-v-wb" + 'R5', async () => {
    await runTest({"suite":"version","test":"vs-expand-v-wb"}, "5.0");
  });

  it("vs-expand-v-wb" + 'R4', async () => {
    await runTest({"suite":"version","test":"vs-expand-v-wb"}, "4.0");
  });

  it("vs-expand-v1" + 'R5', async () => {
    await runTest({"suite":"version","test":"vs-expand-v1"}, "5.0");
  });

  it("vs-expand-v1" + 'R4', async () => {
    await runTest({"suite":"version","test":"vs-expand-v1"}, "4.0");
  });

  it("vs-expand-v2" + 'R5', async () => {
    await runTest({"suite":"version","test":"vs-expand-v2"}, "5.0");
  });

  it("vs-expand-v2" + 'R4', async () => {
    await runTest({"suite":"version","test":"vs-expand-v2"}, "4.0");
  });

  it("vs-expand-all-v-force" + 'R5', async () => {
    await runTest({"suite":"version","test":"vs-expand-all-v-force"}, "5.0");
  });

  it("vs-expand-all-v-force" + 'R4', async () => {
    await runTest({"suite":"version","test":"vs-expand-all-v-force"}, "4.0");
  });

  it("vs-expand-all-v1-force" + 'R5', async () => {
    await runTest({"suite":"version","test":"vs-expand-all-v1-force"}, "5.0");
  });

  it("vs-expand-all-v1-force" + 'R4', async () => {
    await runTest({"suite":"version","test":"vs-expand-all-v1-force"}, "4.0");
  });

  it("vs-expand-all-v2-force" + 'R5', async () => {
    await runTest({"suite":"version","test":"vs-expand-all-v2-force"}, "5.0");
  });

  it("vs-expand-all-v2-force" + 'R4', async () => {
    await runTest({"suite":"version","test":"vs-expand-all-v2-force"}, "4.0");
  });

  it("vs-expand-v-mixed-force" + 'R5', async () => {
    await runTest({"suite":"version","test":"vs-expand-v-mixed-force"}, "5.0");
  });

  it("vs-expand-v-mixed-force" + 'R4', async () => {
    await runTest({"suite":"version","test":"vs-expand-v-mixed-force"}, "4.0");
  });

  it("vs-expand-v-n-force-request" + 'R5', async () => {
    await runTest({"suite":"version","test":"vs-expand-v-n-force-request"}, "5.0");
  });

  it("vs-expand-v-n-force-request" + 'R4', async () => {
    await runTest({"suite":"version","test":"vs-expand-v-n-force-request"}, "4.0");
  });

  it("vs-expand-v-w-force" + 'R5', async () => {
    await runTest({"suite":"version","test":"vs-expand-v-w-force"}, "5.0");
  });

  it("vs-expand-v-w-force" + 'R4', async () => {
    await runTest({"suite":"version","test":"vs-expand-v-w-force"}, "4.0");
  });

  it("vs-expand-v-wb-force" + 'R5', async () => {
    await runTest({"suite":"version","test":"vs-expand-v-wb-force"}, "5.0");
  });

  it("vs-expand-v-wb-force" + 'R4', async () => {
    await runTest({"suite":"version","test":"vs-expand-v-wb-force"}, "4.0");
  });

  it("vs-expand-v1-force" + 'R5', async () => {
    await runTest({"suite":"version","test":"vs-expand-v1-force"}, "5.0");
  });

  it("vs-expand-v1-force" + 'R4', async () => {
    await runTest({"suite":"version","test":"vs-expand-v1-force"}, "4.0");
  });

  it("vs-expand-v2-force" + 'R5', async () => {
    await runTest({"suite":"version","test":"vs-expand-v2-force"}, "5.0");
  });

  it("vs-expand-v2-force" + 'R4', async () => {
    await runTest({"suite":"version","test":"vs-expand-v2-force"}, "4.0");
  });

  it("vs-expand-all-v-default" + 'R5', async () => {
    await runTest({"suite":"version","test":"vs-expand-all-v-default"}, "5.0");
  });

  it("vs-expand-all-v-default" + 'R4', async () => {
    await runTest({"suite":"version","test":"vs-expand-all-v-default"}, "4.0");
  });

  it("vs-expand-all-v1-default" + 'R5', async () => {
    await runTest({"suite":"version","test":"vs-expand-all-v1-default"}, "5.0");
  });

  it("vs-expand-all-v1-default" + 'R4', async () => {
    await runTest({"suite":"version","test":"vs-expand-all-v1-default"}, "4.0");
  });

  it("vs-expand-all-v2-default" + 'R5', async () => {
    await runTest({"suite":"version","test":"vs-expand-all-v2-default"}, "5.0");
  });

  it("vs-expand-all-v2-default" + 'R4', async () => {
    await runTest({"suite":"version","test":"vs-expand-all-v2-default"}, "4.0");
  });

  it("vs-expand-v-mixed-default" + 'R5', async () => {
    await runTest({"suite":"version","test":"vs-expand-v-mixed-default"}, "5.0");
  });

  it("vs-expand-v-mixed-default" + 'R4', async () => {
    await runTest({"suite":"version","test":"vs-expand-v-mixed-default"}, "4.0");
  });

  it("vs-expand-v-n-default-request" + 'R5', async () => {
    await runTest({"suite":"version","test":"vs-expand-v-n-default-request"}, "5.0");
  });

  it("vs-expand-v-n-default-request" + 'R4', async () => {
    await runTest({"suite":"version","test":"vs-expand-v-n-default-request"}, "4.0");
  });

  it("vs-expand-v-w-default" + 'R5', async () => {
    await runTest({"suite":"version","test":"vs-expand-v-w-default"}, "5.0");
  });

  it("vs-expand-v-w-default" + 'R4', async () => {
    await runTest({"suite":"version","test":"vs-expand-v-w-default"}, "4.0");
  });

  it("vs-expand-v-wb-default" + 'R5', async () => {
    await runTest({"suite":"version","test":"vs-expand-v-wb-default"}, "5.0");
  });

  it("vs-expand-v-wb-default" + 'R4', async () => {
    await runTest({"suite":"version","test":"vs-expand-v-wb-default"}, "4.0");
  });

  it("vs-expand-v1-default" + 'R5', async () => {
    await runTest({"suite":"version","test":"vs-expand-v1-default"}, "5.0");
  });

  it("vs-expand-v1-default" + 'R4', async () => {
    await runTest({"suite":"version","test":"vs-expand-v1-default"}, "4.0");
  });

  it("vs-expand-v2-default" + 'R5', async () => {
    await runTest({"suite":"version","test":"vs-expand-v2-default"}, "5.0");
  });

  it("vs-expand-v2-default" + 'R4', async () => {
    await runTest({"suite":"version","test":"vs-expand-v2-default"}, "4.0");
  });

  it("vs-expand-all-v-check" + 'R5', async () => {
    await runTest({"suite":"version","test":"vs-expand-all-v-check"}, "5.0");
  });

  it("vs-expand-all-v-check" + 'R4', async () => {
    await runTest({"suite":"version","test":"vs-expand-all-v-check"}, "4.0");
  });

  it("vs-expand-all-v1-check" + 'R5', async () => {
    await runTest({"suite":"version","test":"vs-expand-all-v1-check"}, "5.0");
  });

  it("vs-expand-all-v1-check" + 'R4', async () => {
    await runTest({"suite":"version","test":"vs-expand-all-v1-check"}, "4.0");
  });

  it("vs-expand-all-v2-check" + 'R5', async () => {
    await runTest({"suite":"version","test":"vs-expand-all-v2-check"}, "5.0");
  });

  it("vs-expand-all-v2-check" + 'R4', async () => {
    await runTest({"suite":"version","test":"vs-expand-all-v2-check"}, "4.0");
  });

  it("vs-expand-v-mixed-check" + 'R5', async () => {
    await runTest({"suite":"version","test":"vs-expand-v-mixed-check"}, "5.0");
  });

  it("vs-expand-v-mixed-check" + 'R4', async () => {
    await runTest({"suite":"version","test":"vs-expand-v-mixed-check"}, "4.0");
  });

  it("vs-expand-v-n-check-request" + 'R5', async () => {
    await runTest({"suite":"version","test":"vs-expand-v-n-check-request"}, "5.0");
  });

  it("vs-expand-v-n-check-request" + 'R4', async () => {
    await runTest({"suite":"version","test":"vs-expand-v-n-check-request"}, "4.0");
  });

  it("vs-expand-v-w-check" + 'R5', async () => {
    await runTest({"suite":"version","test":"vs-expand-v-w-check"}, "5.0");
  });

  it("vs-expand-v-w-check" + 'R4', async () => {
    await runTest({"suite":"version","test":"vs-expand-v-w-check"}, "4.0");
  });

  it("vs-expand-v-wb-check" + 'R5', async () => {
    await runTest({"suite":"version","test":"vs-expand-v-wb-check"}, "5.0");
  });

  it("vs-expand-v-wb-check" + 'R4', async () => {
    await runTest({"suite":"version","test":"vs-expand-v-wb-check"}, "4.0");
  });

  it("vs-expand-v1-check" + 'R5', async () => {
    await runTest({"suite":"version","test":"vs-expand-v1-check"}, "5.0");
  });

  it("vs-expand-v1-check" + 'R4', async () => {
    await runTest({"suite":"version","test":"vs-expand-v1-check"}, "4.0");
  });

  it("vs-expand-v2-check" + 'R5', async () => {
    await runTest({"suite":"version","test":"vs-expand-v2-check"}, "5.0");
  });

  it("vs-expand-v2-check" + 'R4', async () => {
    await runTest({"suite":"version","test":"vs-expand-v2-check"}, "4.0");
  });

  it("vs-expand-versionless" + 'R5', async () => {
    await runTest({"suite":"version","test":"vs-expand-versionless"}, "5.0");
  });

  it("vs-expand-versionless" + 'R4', async () => {
    await runTest({"suite":"version","test":"vs-expand-versionless"}, "4.0");
  });

});

describe('overload', () => {
  // A set of tests that test out handling of value sets that cross versions of the same code system

  it("expand-all" + 'R5', async () => {
    await runTest({"suite":"overload","test":"expand-all"}, "5.0");
  });

  it("expand-all" + 'R4', async () => {
    await runTest({"suite":"overload","test":"expand-all"}, "4.0");
  });

  it("expand-all-versioned" + 'R5', async () => {
    await runTest({"suite":"overload","test":"expand-all-versioned"}, "5.0");
  });

  it("expand-all-versioned" + 'R4', async () => {
    await runTest({"suite":"overload","test":"expand-all-versioned"}, "4.0");
  });

  it("expand-all-merged" + 'R5', async () => {
    await runTest({"suite":"overload","test":"expand-all-merged"}, "5.0");
  });

  it("expand-all-merged" + 'R4', async () => {
    await runTest({"suite":"overload","test":"expand-all-merged"}, "4.0");
  });

  it("expand-enum-good" + 'R5', async () => {
    await runTest({"suite":"overload","test":"expand-enum-good"}, "5.0");
  });

  it("expand-enum-good" + 'R4', async () => {
    await runTest({"suite":"overload","test":"expand-enum-good"}, "4.0");
  });

  it("expand-enum-bad" + 'R5', async () => {
    await runTest({"suite":"overload","test":"expand-enum-bad"}, "5.0");
  });

  it("expand-enum-bad" + 'R4', async () => {
    await runTest({"suite":"overload","test":"expand-enum-bad"}, "4.0");
  });

  it("expand-exclude" + 'R5', async () => {
    await runTest({"suite":"overload","test":"expand-exclude"}, "5.0");
  });

  it("expand-exclude" + 'R4', async () => {
    await runTest({"suite":"overload","test":"expand-exclude"}, "4.0");
  });

  it("expand-exclude-versioned" + 'R5', async () => {
    await runTest({"suite":"overload","test":"expand-exclude-versioned"}, "5.0");
  });

  it("expand-exclude-versioned" + 'R4', async () => {
    await runTest({"suite":"overload","test":"expand-exclude-versioned"}, "4.0");
  });

  it("expand-exclude-merged" + 'R5', async () => {
    await runTest({"suite":"overload","test":"expand-exclude-merged"}, "5.0");
  });

  it("expand-exclude-merged" + 'R4', async () => {
    await runTest({"suite":"overload","test":"expand-exclude-merged"}, "4.0");
  });

  it("validate-all-good" + 'R5', async () => {
    await runTest({"suite":"overload","test":"validate-all-good"}, "5.0");
  });

  it("validate-all-good" + 'R4', async () => {
    await runTest({"suite":"overload","test":"validate-all-good"}, "4.0");
  });

  it("validate-all-good2" + 'R5', async () => {
    await runTest({"suite":"overload","test":"validate-all-good2"}, "5.0");
  });

  it("validate-all-good2" + 'R4', async () => {
    await runTest({"suite":"overload","test":"validate-all-good2"}, "4.0");
  });

  it("validate-all-good3" + 'R5', async () => {
    await runTest({"suite":"overload","test":"validate-all-good3"}, "5.0");
  });

  it("validate-all-good3" + 'R4', async () => {
    await runTest({"suite":"overload","test":"validate-all-good3"}, "4.0");
  });

  it("validate-all-good4" + 'R5', async () => {
    await runTest({"suite":"overload","test":"validate-all-good4"}, "5.0");
  });

  it("validate-all-good4" + 'R4', async () => {
    await runTest({"suite":"overload","test":"validate-all-good4"}, "4.0");
  });

  it("validate-all-bad2" + 'R5', async () => {
    await runTest({"suite":"overload","test":"validate-all-bad2"}, "5.0");
  });

  it("validate-all-bad2" + 'R4', async () => {
    await runTest({"suite":"overload","test":"validate-all-bad2"}, "4.0");
  });

  it("validate-all-bad2v" + 'R5', async () => {
    await runTest({"suite":"overload","test":"validate-all-bad2v"}, "5.0");
  });

  it("validate-all-bad2v" + 'R4', async () => {
    await runTest({"suite":"overload","test":"validate-all-bad2v"}, "4.0");
  });

  it("expand-all-sysver" + 'R5', async () => {
    await runTest({"suite":"overload","test":"expand-all-sysver"}, "5.0");
  });

  it("expand-all-sysver" + 'R4', async () => {
    await runTest({"suite":"overload","test":"expand-all-sysver"}, "4.0");
  });

  it("expand-exclude-enum" + 'R5', async () => {
    await runTest({"suite":"overload","test":"expand-exclude-enum"}, "5.0");
  });

  it("expand-exclude-enum" + 'R4', async () => {
    await runTest({"suite":"overload","test":"expand-exclude-enum"}, "4.0");
  });

  it("expand-mixed" + 'R5', async () => {
    await runTest({"suite":"overload","test":"expand-mixed"}, "5.0");
  });

  it("expand-mixed" + 'R4', async () => {
    await runTest({"suite":"overload","test":"expand-mixed"}, "4.0");
  });

  it("validate-bad-enum-code1" + 'R5', async () => {
    await runTest({"suite":"overload","test":"validate-bad-enum-code1"}, "5.0");
  });

  it("validate-bad-enum-code1" + 'R4', async () => {
    await runTest({"suite":"overload","test":"validate-bad-enum-code1"}, "4.0");
  });

  it("validate-bad-exclude-code1" + 'R5', async () => {
    await runTest({"suite":"overload","test":"validate-bad-exclude-code1"}, "5.0");
  });

  it("validate-bad-exclude-code1" + 'R4', async () => {
    await runTest({"suite":"overload","test":"validate-bad-exclude-code1"}, "4.0");
  });

  it("validate-bad-unknown" + 'R5', async () => {
    await runTest({"suite":"overload","test":"validate-bad-unknown"}, "5.0");
  });

  it("validate-bad-unknown" + 'R4', async () => {
    await runTest({"suite":"overload","test":"validate-bad-unknown"}, "4.0");
  });

  it("validate-v1code2-wrongdisplay" + 'R5', async () => {
    await runTest({"suite":"overload","test":"validate-v1code2-wrongdisplay"}, "5.0");
  });

  it("validate-v1code2-wrongdisplay" + 'R4', async () => {
    await runTest({"suite":"overload","test":"validate-v1code2-wrongdisplay"}, "4.0");
  });

  it("validate-bad-v1code4" + 'R5', async () => {
    await runTest({"suite":"overload","test":"validate-bad-v1code4"}, "5.0");
  });

  it("validate-bad-v1code4" + 'R4', async () => {
    await runTest({"suite":"overload","test":"validate-bad-v1code4"}, "4.0");
  });

  it("validate-bad-v2code3" + 'R5', async () => {
    await runTest({"suite":"overload","test":"validate-bad-v2code3"}, "5.0");
  });

  it("validate-bad-v2code3" + 'R4', async () => {
    await runTest({"suite":"overload","test":"validate-bad-v2code3"}, "4.0");
  });

  it("validate-good-code2-v1display" + 'R5', async () => {
    await runTest({"suite":"overload","test":"validate-good-code2-v1display"}, "5.0");
  });

  it("validate-good-code2-v1display" + 'R4', async () => {
    await runTest({"suite":"overload","test":"validate-good-code2-v1display"}, "4.0");
  });

  it("validate-good-enum-code3" + 'R5', async () => {
    await runTest({"suite":"overload","test":"validate-good-enum-code3"}, "5.0");
  });

  it("validate-good-enum-code3" + 'R4', async () => {
    await runTest({"suite":"overload","test":"validate-good-enum-code3"}, "4.0");
  });

  it("validate-good-exclude-code4" + 'R5', async () => {
    await runTest({"suite":"overload","test":"validate-good-exclude-code4"}, "5.0");
  });

  it("validate-good-exclude-code4" + 'R4', async () => {
    await runTest({"suite":"overload","test":"validate-good-exclude-code4"}, "4.0");
  });

  it("validate-good-v1code1" + 'R5', async () => {
    await runTest({"suite":"overload","test":"validate-good-v1code1"}, "5.0");
  });

  it("validate-good-v1code1" + 'R4', async () => {
    await runTest({"suite":"overload","test":"validate-good-v1code1"}, "4.0");
  });

  it("validate-good-v1code2-display" + 'R5', async () => {
    await runTest({"suite":"overload","test":"validate-good-v1code2-display"}, "5.0");
  });

  it("validate-good-v1code2-display" + 'R4', async () => {
    await runTest({"suite":"overload","test":"validate-good-v1code2-display"}, "4.0");
  });

  it("validate-good2a" + 'R5', async () => {
    await runTest({"suite":"overload","test":"validate-good2a"}, "5.0");
  });

  it("validate-good2a" + 'R4', async () => {
    await runTest({"suite":"overload","test":"validate-good2a"}, "4.0");
  });

});

describe('fragment', () => {
  // Testing handling a code system fragment

  it("fragment-expansion" + 'R5', async () => {
    await runTest({"suite":"fragment","test":"fragment-expansion"}, "5.0");
  });

  it("fragment-expansion" + 'R4', async () => {
    await runTest({"suite":"fragment","test":"fragment-expansion"}, "4.0");
  });

  it("validation-fragment-code-good" + 'R5', async () => {
    await runTest({"suite":"fragment","test":"validation-fragment-code-good"}, "5.0");
  });

  it("validation-fragment-code-good" + 'R4', async () => {
    await runTest({"suite":"fragment","test":"validation-fragment-code-good"}, "4.0");
  });

  it("validation-fragment-coding-good" + 'R5', async () => {
    await runTest({"suite":"fragment","test":"validation-fragment-coding-good"}, "5.0");
  });

  it("validation-fragment-coding-good" + 'R4', async () => {
    await runTest({"suite":"fragment","test":"validation-fragment-coding-good"}, "4.0");
  });

  it("validation-fragment-codeableconcept-good" + 'R5', async () => {
    await runTest({"suite":"fragment","test":"validation-fragment-codeableconcept-good"}, "5.0");
  });

  it("validation-fragment-codeableconcept-good" + 'R4', async () => {
    await runTest({"suite":"fragment","test":"validation-fragment-codeableconcept-good"}, "4.0");
  });

  it("validation-fragment-code-bad-code" + 'R5', async () => {
    await runTest({"suite":"fragment","test":"validation-fragment-code-bad-code"}, "5.0");
  });

  it("validation-fragment-code-bad-code" + 'R4', async () => {
    await runTest({"suite":"fragment","test":"validation-fragment-code-bad-code"}, "4.0");
  });

  it("validation-fragment-coding-bad-code" + 'R5', async () => {
    await runTest({"suite":"fragment","test":"validation-fragment-coding-bad-code"}, "5.0");
  });

  it("validation-fragment-coding-bad-code" + 'R4', async () => {
    await runTest({"suite":"fragment","test":"validation-fragment-coding-bad-code"}, "4.0");
  });

  it("validation-fragment-codeableconcept-bad-code" + 'R5', async () => {
    await runTest({"suite":"fragment","test":"validation-fragment-codeableconcept-bad-code"}, "5.0");
  });

  it("validation-fragment-codeableconcept-bad-code" + 'R4', async () => {
    await runTest({"suite":"fragment","test":"validation-fragment-codeableconcept-bad-code"}, "4.0");
  });

});

describe('big', () => {
  // Testing handling a big code system

  it("big-echo-no-limit" + 'R5', async () => {
    await runTest({"suite":"big","test":"big-echo-no-limit"}, "5.0");
  });

  it("big-echo-no-limit" + 'R4', async () => {
    await runTest({"suite":"big","test":"big-echo-no-limit"}, "4.0");
  });

  it("big-echo-zero-fifty-limit" + 'R5', async () => {
    await runTest({"suite":"big","test":"big-echo-zero-fifty-limit"}, "5.0");
  });

  it("big-echo-zero-fifty-limit" + 'R4', async () => {
    await runTest({"suite":"big","test":"big-echo-zero-fifty-limit"}, "4.0");
  });

  it("big-echo-fifty-fifty-limit" + 'R5', async () => {
    await runTest({"suite":"big","test":"big-echo-fifty-fifty-limit"}, "5.0");
  });

  it("big-echo-fifty-fifty-limit" + 'R4', async () => {
    await runTest({"suite":"big","test":"big-echo-fifty-fifty-limit"}, "4.0");
  });

  it("big-circle-bang" + 'R5', async () => {
    await runTest({"suite":"big","test":"big-circle-bang"}, "5.0");
  });

  it("big-circle-bang" + 'R4', async () => {
    await runTest({"suite":"big","test":"big-circle-bang"}, "4.0");
  });

  it("big-circle-validate" + 'R5', async () => {
    await runTest({"suite":"big","test":"big-circle-validate"}, "5.0");
  });

  it("big-circle-validate" + 'R4', async () => {
    await runTest({"suite":"big","test":"big-circle-validate"}, "4.0");
  });

});

describe('other', () => {
  // Misc tests based on issues submitted by users

  it("dual-filter" + 'R5', async () => {
    await runTest({"suite":"other","test":"dual-filter"}, "5.0");
  });

  it("dual-filter" + 'R4', async () => {
    await runTest({"suite":"other","test":"dual-filter"}, "4.0");
  });

  it("validation-dual-filter-in" + 'R5', async () => {
    await runTest({"suite":"other","test":"validation-dual-filter-in"}, "5.0");
  });

  it("validation-dual-filter-in" + 'R4', async () => {
    await runTest({"suite":"other","test":"validation-dual-filter-in"}, "4.0");
  });

  it("validation-dual-filter-out" + 'R5', async () => {
    await runTest({"suite":"other","test":"validation-dual-filter-out"}, "5.0");
  });

  it("validation-dual-filter-out" + 'R4', async () => {
    await runTest({"suite":"other","test":"validation-dual-filter-out"}, "4.0");
  });

});

describe('errors', () => {
  // Testing Various Error Conditions

  it("unknown-system1" + 'R5', async () => {
    await runTest({"suite":"errors","test":"unknown-system1"}, "5.0");
  });

  it("unknown-system1" + 'R4', async () => {
    await runTest({"suite":"errors","test":"unknown-system1"}, "4.0");
  });

  it("unknown-system2" + 'R5', async () => {
    await runTest({"suite":"errors","test":"unknown-system2"}, "5.0");
  });

  it("unknown-system2" + 'R4', async () => {
    await runTest({"suite":"errors","test":"unknown-system2"}, "4.0");
  });

  it("broken-filter-validate" + 'R5', async () => {
    await runTest({"suite":"errors","test":"broken-filter-validate"}, "5.0");
  });

  it("broken-filter-validate" + 'R4', async () => {
    await runTest({"suite":"errors","test":"broken-filter-validate"}, "4.0");
  });

  it("broken-filter2-validate" + 'R5', async () => {
    await runTest({"suite":"errors","test":"broken-filter2-validate"}, "5.0");
  });

  it("broken-filter2-validate" + 'R4', async () => {
    await runTest({"suite":"errors","test":"broken-filter2-validate"}, "4.0");
  });

  it("broken-filter-expand" + 'R5', async () => {
    await runTest({"suite":"errors","test":"broken-filter-expand"}, "5.0");
  });

  it("broken-filter-expand" + 'R4', async () => {
    await runTest({"suite":"errors","test":"broken-filter-expand"}, "4.0");
  });

  it("combination-ok" + 'R5', async () => {
    await runTest({"suite":"errors","test":"combination-ok"}, "5.0");
  });

  it("combination-ok" + 'R4', async () => {
    await runTest({"suite":"errors","test":"combination-ok"}, "4.0");
  });

  it("combination-bad" + 'R5', async () => {
    await runTest({"suite":"errors","test":"combination-bad"}, "5.0");
  });

  it("combination-bad" + 'R4', async () => {
    await runTest({"suite":"errors","test":"combination-bad"}, "4.0");
  });

});

describe('deprecated', () => {
  // Testing Deprecated+Withdrawn warnings

  it("withdrawn" + 'R5', async () => {
    await runTest({"suite":"deprecated","test":"withdrawn"}, "5.0");
  });

  it("withdrawn" + 'R4', async () => {
    await runTest({"suite":"deprecated","test":"withdrawn"}, "4.0");
  });

  it("not-withdrawn" + 'R5', async () => {
    await runTest({"suite":"deprecated","test":"not-withdrawn"}, "5.0");
  });

  it("not-withdrawn" + 'R4', async () => {
    await runTest({"suite":"deprecated","test":"not-withdrawn"}, "4.0");
  });

  it("withdrawn-validate" + 'R5', async () => {
    await runTest({"suite":"deprecated","test":"withdrawn-validate"}, "5.0");
  });

  it("withdrawn-validate" + 'R4', async () => {
    await runTest({"suite":"deprecated","test":"withdrawn-validate"}, "4.0");
  });

  it("not-withdrawn-validate" + 'R5', async () => {
    await runTest({"suite":"deprecated","test":"not-withdrawn-validate"}, "5.0");
  });

  it("not-withdrawn-validate" + 'R4', async () => {
    await runTest({"suite":"deprecated","test":"not-withdrawn-validate"}, "4.0");
  });

  it("experimental" + 'R5', async () => {
    await runTest({"suite":"deprecated","test":"experimental"}, "5.0");
  });

  it("experimental" + 'R4', async () => {
    await runTest({"suite":"deprecated","test":"experimental"}, "4.0");
  });

  it("experimental-validate" + 'R5', async () => {
    await runTest({"suite":"deprecated","test":"experimental-validate"}, "5.0");
  });

  it("experimental-validate" + 'R4', async () => {
    await runTest({"suite":"deprecated","test":"experimental-validate"}, "4.0");
  });

  it("draft" + 'R5', async () => {
    await runTest({"suite":"deprecated","test":"draft"}, "5.0");
  });

  it("draft" + 'R4', async () => {
    await runTest({"suite":"deprecated","test":"draft"}, "4.0");
  });

  it("draft-validate" + 'R5', async () => {
    await runTest({"suite":"deprecated","test":"draft-validate"}, "5.0");
  });

  it("draft-validate" + 'R4', async () => {
    await runTest({"suite":"deprecated","test":"draft-validate"}, "4.0");
  });

  it("vs-deprecation" + 'R5', async () => {
    await runTest({"suite":"deprecated","test":"vs-deprecation"}, "5.0");
  });

  it("vs-deprecation" + 'R4', async () => {
    await runTest({"suite":"deprecated","test":"vs-deprecation"}, "4.0");
  });

  it("deprecating-validate" + 'R5', async () => {
    await runTest({"suite":"deprecated","test":"deprecating-validate"}, "5.0");
  });

  it("deprecating-validate" + 'R4', async () => {
    await runTest({"suite":"deprecated","test":"deprecating-validate"}, "4.0");
  });

  it("deprecating-validate-2" + 'R5', async () => {
    await runTest({"suite":"deprecated","test":"deprecating-validate-2"}, "5.0");
  });

  it("deprecating-validate-2" + 'R4', async () => {
    await runTest({"suite":"deprecated","test":"deprecating-validate-2"}, "4.0");
  });

});

describe('notSelectable', () => {
  // Testing notSelectable

  it("notSelectable-prop-all" + 'R5', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-all"}, "5.0");
  });

  it("notSelectable-prop-all" + 'R4', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-all"}, "4.0");
  });

  it("notSelectable-noprop-all" + 'R5', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-noprop-all"}, "5.0");
  });

  it("notSelectable-noprop-all" + 'R4', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-noprop-all"}, "4.0");
  });

  it("notSelectable-reprop-all" + 'R5', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-reprop-all"}, "5.0");
  });

  it("notSelectable-reprop-all" + 'R4', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-reprop-all"}, "4.0");
  });

  it("notSelectable-unprop-all" + 'R5', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-unprop-all"}, "5.0");
  });

  it("notSelectable-unprop-all" + 'R4', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-unprop-all"}, "4.0");
  });

  it("notSelectable-prop-true" + 'R5', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-true"}, "5.0");
  });

  it("notSelectable-prop-true" + 'R4', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-true"}, "4.0");
  });

  it("notSelectable-prop-trueUC" + 'R5', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-trueUC"}, "5.0");
  });

  it("notSelectable-prop-trueUC" + 'R4', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-trueUC"}, "4.0");
  });

  it("notSelectable-noprop-true" + 'R5', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-noprop-true"}, "5.0");
  });

  it("notSelectable-noprop-true" + 'R4', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-noprop-true"}, "4.0");
  });

  it("notSelectable-reprop-true" + 'R5', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-reprop-true"}, "5.0");
  });

  it("notSelectable-reprop-true" + 'R4', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-reprop-true"}, "4.0");
  });

  it("notSelectable-unprop-true" + 'R5', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-unprop-true"}, "5.0");
  });

  it("notSelectable-unprop-true" + 'R4', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-unprop-true"}, "4.0");
  });

  it("notSelectable-prop-false" + 'R5', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-false"}, "5.0");
  });

  it("notSelectable-prop-false" + 'R4', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-false"}, "4.0");
  });

  it("notSelectable-noprop-false" + 'R5', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-noprop-false"}, "5.0");
  });

  it("notSelectable-noprop-false" + 'R4', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-noprop-false"}, "4.0");
  });

  it("notSelectable-reprop-false" + 'R5', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-reprop-false"}, "5.0");
  });

  it("notSelectable-reprop-false" + 'R4', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-reprop-false"}, "4.0");
  });

  it("notSelectable-unprop-false" + 'R5', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-unprop-false"}, "5.0");
  });

  it("notSelectable-unprop-false" + 'R4', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-unprop-false"}, "4.0");
  });

  it("notSelectable-prop-in" + 'R5', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-in"}, "5.0");
  });

  it("notSelectable-prop-in" + 'R4', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-in"}, "4.0");
  });

  it("notSelectable-prop-out" + 'R5', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-out"}, "5.0");
  });

  it("notSelectable-prop-out" + 'R4', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-out"}, "4.0");
  });

  it("notSelectable-prop-true-true" + 'R5', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-true-true"}, "5.0");
  });

  it("notSelectable-prop-true-true" + 'R4', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-true-true"}, "4.0");
  });

  it("notSelectable-prop-trueUC-true" + 'R5', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-trueUC-true"}, "5.0");
  });

  it("notSelectable-prop-trueUC-true" + 'R4', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-trueUC-true"}, "4.0");
  });

  it("notSelectable-prop-in-true" + 'R5', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-in-true"}, "5.0");
  });

  it("notSelectable-prop-in-true" + 'R4', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-in-true"}, "4.0");
  });

  it("notSelectable-prop-out-true" + 'R5', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-out-true"}, "5.0");
  });

  it("notSelectable-prop-out-true" + 'R4', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-out-true"}, "4.0");
  });

  it("notSelectable-noprop-true-true" + 'R5', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-noprop-true-true"}, "5.0");
  });

  it("notSelectable-noprop-true-true" + 'R4', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-noprop-true-true"}, "4.0");
  });

  it("notSelectable-reprop-true-true" + 'R5', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-reprop-true-true"}, "5.0");
  });

  it("notSelectable-reprop-true-true" + 'R4', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-reprop-true-true"}, "4.0");
  });

  it("notSelectable-unprop-true-true" + 'R5', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-unprop-true-true"}, "5.0");
  });

  it("notSelectable-unprop-true-true" + 'R4', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-unprop-true-true"}, "4.0");
  });

  it("notSelectable-prop-true-false" + 'R5', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-true-false"}, "5.0");
  });

  it("notSelectable-prop-true-false" + 'R4', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-true-false"}, "4.0");
  });

  it("notSelectable-prop-in-false" + 'R5', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-in-false"}, "5.0");
  });

  it("notSelectable-prop-in-false" + 'R4', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-in-false"}, "4.0");
  });

  it("notSelectable-prop-in-unknown" + 'R5', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-in-unknown"}, "5.0");
  });

  it("notSelectable-prop-in-unknown" + 'R4', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-in-unknown"}, "4.0");
  });

  it("notSelectable-prop-out-unknown" + 'R5', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-out-unknown"}, "5.0");
  });

  it("notSelectable-prop-out-unknown" + 'R4', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-out-unknown"}, "4.0");
  });

  it("notSelectable-prop-out-false" + 'R5', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-out-false"}, "5.0");
  });

  it("notSelectable-prop-out-false" + 'R4', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-out-false"}, "4.0");
  });

  it("notSelectable-noprop-true-false" + 'R5', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-noprop-true-false"}, "5.0");
  });

  it("notSelectable-noprop-true-false" + 'R4', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-noprop-true-false"}, "4.0");
  });

  it("notSelectable-reprop-true-false" + 'R5', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-reprop-true-false"}, "5.0");
  });

  it("notSelectable-reprop-true-false" + 'R4', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-reprop-true-false"}, "4.0");
  });

  it("notSelectable-unprop-true-false" + 'R5', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-unprop-true-false"}, "5.0");
  });

  it("notSelectable-unprop-true-false" + 'R4', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-unprop-true-false"}, "4.0");
  });

  it("notSelectable-prop-false-true" + 'R5', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-false-true"}, "5.0");
  });

  it("notSelectable-prop-false-true" + 'R4', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-false-true"}, "4.0");
  });

  it("notSelectable-noprop-false-true" + 'R5', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-noprop-false-true"}, "5.0");
  });

  it("notSelectable-noprop-false-true" + 'R4', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-noprop-false-true"}, "4.0");
  });

  it("notSelectable-reprop-false-true" + 'R5', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-reprop-false-true"}, "5.0");
  });

  it("notSelectable-reprop-false-true" + 'R4', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-reprop-false-true"}, "4.0");
  });

  it("notSelectable-unprop-false-true" + 'R5', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-unprop-false-true"}, "5.0");
  });

  it("notSelectable-unprop-false-true" + 'R4', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-unprop-false-true"}, "4.0");
  });

  it("notSelectable-prop-false-false" + 'R5', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-false-false"}, "5.0");
  });

  it("notSelectable-prop-false-false" + 'R4', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-false-false"}, "4.0");
  });

  it("notSelectable-noprop-false-false" + 'R5', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-noprop-false-false"}, "5.0");
  });

  it("notSelectable-noprop-false-false" + 'R4', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-noprop-false-false"}, "4.0");
  });

  it("notSelectable-reprop-false-false" + 'R5', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-reprop-false-false"}, "5.0");
  });

  it("notSelectable-reprop-false-false" + 'R4', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-reprop-false-false"}, "4.0");
  });

  it("notSelectable-unprop-false-false" + 'R5', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-unprop-false-false"}, "5.0");
  });

  it("notSelectable-unprop-false-false" + 'R4', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-unprop-false-false"}, "4.0");
  });

  it("notSelectable-noprop-true-unknown" + 'R5', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-noprop-true-unknown"}, "5.0");
  });

  it("notSelectable-noprop-true-unknown" + 'R4', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-noprop-true-unknown"}, "4.0");
  });

  it("notSelectable-reprop-true-unknown" + 'R5', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-reprop-true-unknown"}, "5.0");
  });

  it("notSelectable-reprop-true-unknown" + 'R4', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-reprop-true-unknown"}, "4.0");
  });

  it("notSelectable-unprop-true-unknown" + 'R5', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-unprop-true-unknown"}, "5.0");
  });

  it("notSelectable-unprop-true-unknown" + 'R4', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-unprop-true-unknown"}, "4.0");
  });

  it("notSelectable-prop-true-unknown" + 'R5', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-true-unknown"}, "5.0");
  });

  it("notSelectable-prop-true-unknown" + 'R4', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-true-unknown"}, "4.0");
  });

  it("notSelectable-prop-false-unknown" + 'R5', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-false-unknown"}, "5.0");
  });

  it("notSelectable-prop-false-unknown" + 'R4', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-false-unknown"}, "4.0");
  });

  it("notSelectable-noprop-false-unknown" + 'R5', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-noprop-false-unknown"}, "5.0");
  });

  it("notSelectable-noprop-false-unknown" + 'R4', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-noprop-false-unknown"}, "4.0");
  });

  it("notSelectable-reprop-false-unknown" + 'R5', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-reprop-false-unknown"}, "5.0");
  });

  it("notSelectable-reprop-false-unknown" + 'R4', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-reprop-false-unknown"}, "4.0");
  });

  it("notSelectable-unprop-false-unknown" + 'R5', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-unprop-false-unknown"}, "5.0");
  });

  it("notSelectable-unprop-false-unknown" + 'R4', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-unprop-false-unknown"}, "4.0");
  });

  it("notSelectable-prop-true-true-param-true" + 'R5', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-true-true-param-true"}, "5.0");
  });

  it("notSelectable-prop-true-true-param-true" + 'R4', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-true-true-param-true"}, "4.0");
  });

  it("notSelectable-prop-true-true-param-false" + 'R5', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-true-true-param-false"}, "5.0");
  });

  it("notSelectable-prop-true-true-param-false" + 'R4', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-true-true-param-false"}, "4.0");
  });

  it("notSelectable-prop-false-false-param-true" + 'R5', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-false-false-param-true"}, "5.0");
  });

  it("notSelectable-prop-false-false-param-true" + 'R4', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-false-false-param-true"}, "4.0");
  });

  it("notSelectable-prop-false-false-param-false" + 'R5', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-false-false-param-false"}, "5.0");
  });

  it("notSelectable-prop-false-false-param-false" + 'R4', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-false-false-param-false"}, "4.0");
  });

});

describe('inactive', () => {
  // Testing Inactive codes

  it("inactive-expand" + 'R5', async () => {
    await runTest({"suite":"inactive","test":"inactive-expand"}, "5.0");
  });

  it("inactive-expand" + 'R4', async () => {
    await runTest({"suite":"inactive","test":"inactive-expand"}, "4.0");
  });

  it("inactive-inactive-expand" + 'R5', async () => {
    await runTest({"suite":"inactive","test":"inactive-inactive-expand"}, "5.0");
  });

  it("inactive-inactive-expand" + 'R4', async () => {
    await runTest({"suite":"inactive","test":"inactive-inactive-expand"}, "4.0");
  });

  it("inactive-active-expand" + 'R5', async () => {
    await runTest({"suite":"inactive","test":"inactive-active-expand"}, "5.0");
  });

  it("inactive-active-expand" + 'R4', async () => {
    await runTest({"suite":"inactive","test":"inactive-active-expand"}, "4.0");
  });

  it("inactive-1-validate" + 'R5', async () => {
    await runTest({"suite":"inactive","test":"inactive-1-validate"}, "5.0");
  });

  it("inactive-1-validate" + 'R4', async () => {
    await runTest({"suite":"inactive","test":"inactive-1-validate"}, "4.0");
  });

  it("inactive-2-validate" + 'R5', async () => {
    await runTest({"suite":"inactive","test":"inactive-2-validate"}, "5.0");
  });

  it("inactive-2-validate" + 'R4', async () => {
    await runTest({"suite":"inactive","test":"inactive-2-validate"}, "4.0");
  });

  it("inactive-3-validate" + 'R5', async () => {
    await runTest({"suite":"inactive","test":"inactive-3-validate"}, "5.0");
  });

  it("inactive-3-validate" + 'R4', async () => {
    await runTest({"suite":"inactive","test":"inactive-3-validate"}, "4.0");
  });

  it("inactive-1a-validate" + 'R5', async () => {
    await runTest({"suite":"inactive","test":"inactive-1a-validate"}, "5.0");
  });

  it("inactive-1a-validate" + 'R4', async () => {
    await runTest({"suite":"inactive","test":"inactive-1a-validate"}, "4.0");
  });

  it("inactive-2a-validate" + 'R5', async () => {
    await runTest({"suite":"inactive","test":"inactive-2a-validate"}, "5.0");
  });

  it("inactive-2a-validate" + 'R4', async () => {
    await runTest({"suite":"inactive","test":"inactive-2a-validate"}, "4.0");
  });

  it("inactive-3a-validate" + 'R5', async () => {
    await runTest({"suite":"inactive","test":"inactive-3a-validate"}, "5.0");
  });

  it("inactive-3a-validate" + 'R4', async () => {
    await runTest({"suite":"inactive","test":"inactive-3a-validate"}, "4.0");
  });

  it("inactive-1b-validate" + 'R5', async () => {
    await runTest({"suite":"inactive","test":"inactive-1b-validate"}, "5.0");
  });

  it("inactive-1b-validate" + 'R4', async () => {
    await runTest({"suite":"inactive","test":"inactive-1b-validate"}, "4.0");
  });

  it("inactive-2b-validate" + 'R5', async () => {
    await runTest({"suite":"inactive","test":"inactive-2b-validate"}, "5.0");
  });

  it("inactive-2b-validate" + 'R4', async () => {
    await runTest({"suite":"inactive","test":"inactive-2b-validate"}, "4.0");
  });

  it("inactive-3b-validate" + 'R5', async () => {
    await runTest({"suite":"inactive","test":"inactive-3b-validate"}, "5.0");
  });

  it("inactive-3b-validate" + 'R4', async () => {
    await runTest({"suite":"inactive","test":"inactive-3b-validate"}, "4.0");
  });

});

describe('case', () => {
  // Test Case Sensitivity handling

  it("case-insensitive-code1-1" + 'R5', async () => {
    await runTest({"suite":"case","test":"case-insensitive-code1-1"}, "5.0");
  });

  it("case-insensitive-code1-1" + 'R4', async () => {
    await runTest({"suite":"case","test":"case-insensitive-code1-1"}, "4.0");
  });

  it("case-insensitive-code1-2" + 'R5', async () => {
    await runTest({"suite":"case","test":"case-insensitive-code1-2"}, "5.0");
  });

  it("case-insensitive-code1-2" + 'R4', async () => {
    await runTest({"suite":"case","test":"case-insensitive-code1-2"}, "4.0");
  });

  it("case-insensitive-code1-3" + 'R5', async () => {
    await runTest({"suite":"case","test":"case-insensitive-code1-3"}, "5.0");
  });

  it("case-insensitive-code1-3" + 'R4', async () => {
    await runTest({"suite":"case","test":"case-insensitive-code1-3"}, "4.0");
  });

  it("case-sensitive-code1-1" + 'R5', async () => {
    await runTest({"suite":"case","test":"case-sensitive-code1-1"}, "5.0");
  });

  it("case-sensitive-code1-1" + 'R4', async () => {
    await runTest({"suite":"case","test":"case-sensitive-code1-1"}, "4.0");
  });

  it("case-sensitive-code1-2" + 'R5', async () => {
    await runTest({"suite":"case","test":"case-sensitive-code1-2"}, "5.0");
  });

  it("case-sensitive-code1-2" + 'R4', async () => {
    await runTest({"suite":"case","test":"case-sensitive-code1-2"}, "4.0");
  });

  it("case-sensitive-code1-3" + 'R5', async () => {
    await runTest({"suite":"case","test":"case-sensitive-code1-3"}, "5.0");
  });

  it("case-sensitive-code1-3" + 'R4', async () => {
    await runTest({"suite":"case","test":"case-sensitive-code1-3"}, "4.0");
  });

});

describe('translate', () => {
  // Tests for ConceptMap.$translate

  it("translate-1" + 'R5', async () => {
    await runTest({"suite":"translate","test":"translate-1"}, "5.0");
  });

  it("translate-1" + 'R4', async () => {
    await runTest({"suite":"translate","test":"translate-1"}, "4.0");
  });

  it("translate-1-coding" + 'R5', async () => {
    await runTest({"suite":"translate","test":"translate-1-coding"}, "5.0");
  });

  it("translate-1-coding" + 'R4', async () => {
    await runTest({"suite":"translate","test":"translate-1-coding"}, "4.0");
  });

  it("translate-1-codeableconcept" + 'R5', async () => {
    await runTest({"suite":"translate","test":"translate-1-codeableconcept"}, "5.0");
  });

  it("translate-1-codeableconcept" + 'R4', async () => {
    await runTest({"suite":"translate","test":"translate-1-codeableconcept"}, "4.0");
  });

  it("translate-1-r4-code" + 'R4', async () => {
    await runTest({"suite":"translate","test":"translate-1-r4-code"}, "4.0");
  });

  it("translate-1-r4-coding" + 'R4', async () => {
    await runTest({"suite":"translate","test":"translate-1-r4-coding"}, "4.0");
  });

  it("translate-1-r4-codeableconcept" + 'R4', async () => {
    await runTest({"suite":"translate","test":"translate-1-r4-codeableconcept"}, "4.0");
  });

  it("translate-2" + 'R5', async () => {
    await runTest({"suite":"translate","test":"translate-2"}, "5.0");
  });

  it("translate-2" + 'R4', async () => {
    await runTest({"suite":"translate","test":"translate-2"}, "4.0");
  });

  it("translate-2b" + 'R5', async () => {
    await runTest({"suite":"translate","test":"translate-2b"}, "5.0");
  });

  it("translate-2b" + 'R4', async () => {
    await runTest({"suite":"translate","test":"translate-2b"}, "4.0");
  });

  it("translate-3" + 'R5', async () => {
    await runTest({"suite":"translate","test":"translate-3"}, "5.0");
  });

  it("translate-3" + 'R4', async () => {
    await runTest({"suite":"translate","test":"translate-3"}, "4.0");
  });

  it("translate-4" + 'R5', async () => {
    await runTest({"suite":"translate","test":"translate-4"}, "5.0");
  });

  it("translate-4" + 'R4', async () => {
    await runTest({"suite":"translate","test":"translate-4"}, "4.0");
  });

});

describe('translate2', () => {
  // Tests for ConceptMap.$translate

  it("translate-5" + 'R5', async () => {
    await runTest({"suite":"translate2","test":"translate-5"}, "5.0");
  });

  it("translate-5" + 'R4', async () => {
    await runTest({"suite":"translate2","test":"translate-5"}, "4.0");
  });

  it("translate-5a" + 'R5', async () => {
    await runTest({"suite":"translate2","test":"translate-5a"}, "5.0");
  });

  it("translate-5a" + 'R4', async () => {
    await runTest({"suite":"translate2","test":"translate-5a"}, "4.0");
  });

  it("translate-5b" + 'R5', async () => {
    await runTest({"suite":"translate2","test":"translate-5b"}, "5.0");
  });

  it("translate-5b" + 'R4', async () => {
    await runTest({"suite":"translate2","test":"translate-5b"}, "4.0");
  });

  it("translate-6a" + 'R5', async () => {
    await runTest({"suite":"translate2","test":"translate-6a"}, "5.0");
  });

  it("translate-6a" + 'R4', async () => {
    await runTest({"suite":"translate2","test":"translate-6a"}, "4.0");
  });

  it("translate-reverse-r4" + 'R4', async () => {
    await runTest({"suite":"translate2","test":"translate-reverse-r4"}, "4.0");
  });

  it("translate-reverse-r4-a" + 'R4', async () => {
    await runTest({"suite":"translate2","test":"translate-reverse-r4-a"}, "4.0");
  });

  it("translate-reverse-r4-b" + 'R4', async () => {
    await runTest({"suite":"translate2","test":"translate-reverse-r4-b"}, "4.0");
  });

});

describe('tho', () => {
  // Misc assorted test cases from tho

  it("act-class" + 'R5', async () => {
    await runTest({"suite":"tho","test":"act-class"}, "5.0");
  });

  it("act-class" + 'R4', async () => {
    await runTest({"suite":"tho","test":"act-class"}, "4.0");
  });

  it("act-class-activeonly" + 'R5', async () => {
    await runTest({"suite":"tho","test":"act-class-activeonly"}, "5.0");
  });

  it("act-class-activeonly" + 'R4', async () => {
    await runTest({"suite":"tho","test":"act-class-activeonly"}, "4.0");
  });

  it("act-exclusion" + 'R5', async () => {
    await runTest({"suite":"tho","test":"act-exclusion"}, "5.0");
  });

  it("act-exclusion" + 'R4', async () => {
    await runTest({"suite":"tho","test":"act-exclusion"}, "4.0");
  });

  it("subsumes-act-class-property-parent" + 'R5', async () => {
    await runTest({"suite":"tho","test":"subsumes-act-class-property-parent"}, "5.0");
  });

  it("subsumes-act-class-property-parent" + 'R4', async () => {
    await runTest({"suite":"tho","test":"subsumes-act-class-property-parent"}, "4.0");
  });

  it("subsumes-act-class-property-child" + 'R5', async () => {
    await runTest({"suite":"tho","test":"subsumes-act-class-property-child"}, "5.0");
  });

  it("subsumes-act-class-property-child" + 'R4', async () => {
    await runTest({"suite":"tho","test":"subsumes-act-class-property-child"}, "4.0");
  });

  it("subsumes-act-class-transitive" + 'R5', async () => {
    await runTest({"suite":"tho","test":"subsumes-act-class-transitive"}, "5.0");
  });

  it("subsumes-act-class-transitive" + 'R4', async () => {
    await runTest({"suite":"tho","test":"subsumes-act-class-transitive"}, "4.0");
  });

  it("subsumes-act-class-transitive-reverse" + 'R5', async () => {
    await runTest({"suite":"tho","test":"subsumes-act-class-transitive-reverse"}, "5.0");
  });

  it("subsumes-act-class-transitive-reverse" + 'R4', async () => {
    await runTest({"suite":"tho","test":"subsumes-act-class-transitive-reverse"}, "4.0");
  });

  it("subsumes-act-class-equivalent" + 'R5', async () => {
    await runTest({"suite":"tho","test":"subsumes-act-class-equivalent"}, "5.0");
  });

  it("subsumes-act-class-equivalent" + 'R4', async () => {
    await runTest({"suite":"tho","test":"subsumes-act-class-equivalent"}, "4.0");
  });

  it("subsumes-act-class-siblings" + 'R5', async () => {
    await runTest({"suite":"tho","test":"subsumes-act-class-siblings"}, "5.0");
  });

  it("subsumes-act-class-siblings" + 'R4', async () => {
    await runTest({"suite":"tho","test":"subsumes-act-class-siblings"}, "4.0");
  });

  it("subsumes-act-class-cross-branch" + 'R5', async () => {
    await runTest({"suite":"tho","test":"subsumes-act-class-cross-branch"}, "5.0");
  });

  it("subsumes-act-class-cross-branch" + 'R4', async () => {
    await runTest({"suite":"tho","test":"subsumes-act-class-cross-branch"}, "4.0");
  });

  it("subsumes-act-class-multiple-parents-first" + 'R5', async () => {
    await runTest({"suite":"tho","test":"subsumes-act-class-multiple-parents-first"}, "5.0");
  });

  it("subsumes-act-class-multiple-parents-first" + 'R4', async () => {
    await runTest({"suite":"tho","test":"subsumes-act-class-multiple-parents-first"}, "4.0");
  });

  it("subsumes-act-class-multiple-parents-second" + 'R5', async () => {
    await runTest({"suite":"tho","test":"subsumes-act-class-multiple-parents-second"}, "5.0");
  });

  it("subsumes-act-class-multiple-parents-second" + 'R4', async () => {
    await runTest({"suite":"tho","test":"subsumes-act-class-multiple-parents-second"}, "4.0");
  });

  it("subsumes-act-class-multiple-parents-crossed" + 'R5', async () => {
    await runTest({"suite":"tho","test":"subsumes-act-class-multiple-parents-crossed"}, "5.0");
  });

  it("subsumes-act-class-multiple-parents-crossed" + 'R4', async () => {
    await runTest({"suite":"tho","test":"subsumes-act-class-multiple-parents-crossed"}, "4.0");
  });

  it("subsumes-act-class-unknown-code" + 'R5', async () => {
    await runTest({"suite":"tho","test":"subsumes-act-class-unknown-code"}, "5.0");
  });

  it("subsumes-act-class-unknown-code" + 'R4', async () => {
    await runTest({"suite":"tho","test":"subsumes-act-class-unknown-code"}, "4.0");
  });

  it("validate-isa-self" + 'R5', async () => {
    await runTest({"suite":"tho","test":"validate-isa-self"}, "5.0");
  });

  it("validate-isa-self" + 'R4', async () => {
    await runTest({"suite":"tho","test":"validate-isa-self"}, "4.0");
  });

  it("validate-isa-child" + 'R5', async () => {
    await runTest({"suite":"tho","test":"validate-isa-child"}, "5.0");
  });

  it("validate-isa-child" + 'R4', async () => {
    await runTest({"suite":"tho","test":"validate-isa-child"}, "4.0");
  });

  it("validate-isa-deep" + 'R5', async () => {
    await runTest({"suite":"tho","test":"validate-isa-deep"}, "5.0");
  });

  it("validate-isa-deep" + 'R4', async () => {
    await runTest({"suite":"tho","test":"validate-isa-deep"}, "4.0");
  });

  it("validate-isa-parent" + 'R5', async () => {
    await runTest({"suite":"tho","test":"validate-isa-parent"}, "5.0");
  });

  it("validate-isa-parent" + 'R4', async () => {
    await runTest({"suite":"tho","test":"validate-isa-parent"}, "4.0");
  });

  it("validate-isa-other-branch" + 'R5', async () => {
    await runTest({"suite":"tho","test":"validate-isa-other-branch"}, "5.0");
  });

  it("validate-isa-other-branch" + 'R4', async () => {
    await runTest({"suite":"tho","test":"validate-isa-other-branch"}, "4.0");
  });

  it("validate-descendent-of-self" + 'R5', async () => {
    await runTest({"suite":"tho","test":"validate-descendent-of-self"}, "5.0");
  });

  it("validate-descendent-of-self" + 'R4', async () => {
    await runTest({"suite":"tho","test":"validate-descendent-of-self"}, "4.0");
  });

  it("validate-descendent-of-child" + 'R5', async () => {
    await runTest({"suite":"tho","test":"validate-descendent-of-child"}, "5.0");
  });

  it("validate-descendent-of-child" + 'R4', async () => {
    await runTest({"suite":"tho","test":"validate-descendent-of-child"}, "4.0");
  });

  it("validate-descendent-of-deep" + 'R5', async () => {
    await runTest({"suite":"tho","test":"validate-descendent-of-deep"}, "5.0");
  });

  it("validate-descendent-of-deep" + 'R4', async () => {
    await runTest({"suite":"tho","test":"validate-descendent-of-deep"}, "4.0");
  });

  it("validate-isnota-self" + 'R5', async () => {
    await runTest({"suite":"tho","test":"validate-isnota-self"}, "5.0");
  });

  it("validate-isnota-self" + 'R4', async () => {
    await runTest({"suite":"tho","test":"validate-isnota-self"}, "4.0");
  });

  it("validate-isnota-descendant" + 'R5', async () => {
    await runTest({"suite":"tho","test":"validate-isnota-descendant"}, "5.0");
  });

  it("validate-isnota-descendant" + 'R4', async () => {
    await runTest({"suite":"tho","test":"validate-isnota-descendant"}, "4.0");
  });

  it("validate-isnota-parent" + 'R5', async () => {
    await runTest({"suite":"tho","test":"validate-isnota-parent"}, "5.0");
  });

  it("validate-isnota-parent" + 'R4', async () => {
    await runTest({"suite":"tho","test":"validate-isnota-parent"}, "4.0");
  });

  it("validate-isnota-other-branch" + 'R5', async () => {
    await runTest({"suite":"tho","test":"validate-isnota-other-branch"}, "5.0");
  });

  it("validate-isnota-other-branch" + 'R4', async () => {
    await runTest({"suite":"tho","test":"validate-isnota-other-branch"}, "4.0");
  });

  it("validate-child-of-child" + 'R5', async () => {
    await runTest({"suite":"tho","test":"validate-child-of-child"}, "5.0");
  });

  it("validate-child-of-child" + 'R4', async () => {
    await runTest({"suite":"tho","test":"validate-child-of-child"}, "4.0");
  });

  it("validate-child-of-self" + 'R5', async () => {
    await runTest({"suite":"tho","test":"validate-child-of-self"}, "5.0");
  });

  it("validate-child-of-self" + 'R4', async () => {
    await runTest({"suite":"tho","test":"validate-child-of-self"}, "4.0");
  });

  it("validate-child-of-grandchild" + 'R5', async () => {
    await runTest({"suite":"tho","test":"validate-child-of-grandchild"}, "5.0");
  });

  it("validate-child-of-grandchild" + 'R4', async () => {
    await runTest({"suite":"tho","test":"validate-child-of-grandchild"}, "4.0");
  });

  it("validate-isa-second-parent" + 'R5', async () => {
    await runTest({"suite":"tho","test":"validate-isa-second-parent"}, "5.0");
  });

  it("validate-isa-second-parent" + 'R4', async () => {
    await runTest({"suite":"tho","test":"validate-isa-second-parent"}, "4.0");
  });

  it("validate-isa-second-parent-out" + 'R5', async () => {
    await runTest({"suite":"tho","test":"validate-isa-second-parent-out"}, "5.0");
  });

  it("validate-isa-second-parent-out" + 'R4', async () => {
    await runTest({"suite":"tho","test":"validate-isa-second-parent-out"}, "4.0");
  });

  it("validate-isa-unknown-code" + 'R5', async () => {
    await runTest({"suite":"tho","test":"validate-isa-unknown-code"}, "5.0");
  });

  it("validate-isa-unknown-code" + 'R4', async () => {
    await runTest({"suite":"tho","test":"validate-isa-unknown-code"}, "4.0");
  });

});

describe('exclude', () => {
  // Tests for proper functioning of exclude

  it("exclude-1" + 'R5', async () => {
    await runTest({"suite":"exclude","test":"exclude-1"}, "5.0");
  });

  it("exclude-1" + 'R4', async () => {
    await runTest({"suite":"exclude","test":"exclude-1"}, "4.0");
  });

  it("exclude-2" + 'R5', async () => {
    await runTest({"suite":"exclude","test":"exclude-2"}, "5.0");
  });

  it("exclude-2" + 'R4', async () => {
    await runTest({"suite":"exclude","test":"exclude-2"}, "4.0");
  });

  it("exclude-zero" + 'R5', async () => {
    await runTest({"suite":"exclude","test":"exclude-zero"}, "5.0");
  });

  it("exclude-zero" + 'R4', async () => {
    await runTest({"suite":"exclude","test":"exclude-zero"}, "4.0");
  });

  it("exclude-all" + 'R5', async () => {
    await runTest({"suite":"exclude","test":"exclude-all"}, "5.0");
  });

  it("exclude-all" + 'R4', async () => {
    await runTest({"suite":"exclude","test":"exclude-all"}, "4.0");
  });

  it("exclude-combo" + 'R5', async () => {
    await runTest({"suite":"exclude","test":"exclude-combo"}, "5.0");
  });

  it("exclude-combo" + 'R4', async () => {
    await runTest({"suite":"exclude","test":"exclude-combo"}, "4.0");
  });

  it("include-combo" + 'R5', async () => {
    await runTest({"suite":"exclude","test":"include-combo"}, "5.0");
  });

  it("include-combo" + 'R4', async () => {
    await runTest({"suite":"exclude","test":"include-combo"}, "4.0");
  });

  it("exclude-gender" + 'R5', async () => {
    await runTest({"suite":"exclude","test":"exclude-gender"}, "5.0");
  });

  it("exclude-gender" + 'R4', async () => {
    await runTest({"suite":"exclude","test":"exclude-gender"}, "4.0");
  });

  it("exclude-gender2" + 'R5', async () => {
    await runTest({"suite":"exclude","test":"exclude-gender2"}, "5.0");
  });

  it("exclude-gender2" + 'R4', async () => {
    await runTest({"suite":"exclude","test":"exclude-gender2"}, "4.0");
  });

});

describe('search', () => {
  // Tests for proper functioning of text search. Note what we're not interested in the implementation of the text search itself, so we only test very obvious results. We're just interested in testing support for the parameter

  it("search-all-yes" + 'R5', async () => {
    await runTest({"suite":"search","test":"search-all-yes"}, "5.0");
  });

  it("search-all-yes" + 'R4', async () => {
    await runTest({"suite":"search","test":"search-all-yes"}, "4.0");
  });

  it("search-all-no" + 'R5', async () => {
    await runTest({"suite":"search","test":"search-all-no"}, "5.0");
  });

  it("search-all-no" + 'R4', async () => {
    await runTest({"suite":"search","test":"search-all-no"}, "4.0");
  });

  it("search-filter-yes" + 'R5', async () => {
    await runTest({"suite":"search","test":"search-filter-yes"}, "5.0");
  });

  it("search-filter-yes" + 'R4', async () => {
    await runTest({"suite":"search","test":"search-filter-yes"}, "4.0");
  });

  it("search-filter-no" + 'R5', async () => {
    await runTest({"suite":"search","test":"search-filter-no"}, "5.0");
  });

  it("search-filter-no" + 'R4', async () => {
    await runTest({"suite":"search","test":"search-filter-no"}, "4.0");
  });

  it("search-enum-yes" + 'R5', async () => {
    await runTest({"suite":"search","test":"search-enum-yes"}, "5.0");
  });

  it("search-enum-yes" + 'R4', async () => {
    await runTest({"suite":"search","test":"search-enum-yes"}, "4.0");
  });

  it("search-enum-no" + 'R5', async () => {
    await runTest({"suite":"search","test":"search-enum-no"}, "5.0");
  });

  it("search-enum-no" + 'R4', async () => {
    await runTest({"suite":"search","test":"search-enum-no"}, "4.0");
  });

});

describe('default-valueset-version', () => {
  // Test the default-valueset-version parameter

  it("direct-expand-one" + 'R5', async () => {
    await runTest({"suite":"default-valueset-version","test":"direct-expand-one"}, "5.0");
  });

  it("direct-expand-one" + 'R4', async () => {
    await runTest({"suite":"default-valueset-version","test":"direct-expand-one"}, "4.0");
  });

  it("direct-expand-two" + 'R5', async () => {
    await runTest({"suite":"default-valueset-version","test":"direct-expand-two"}, "5.0");
  });

  it("direct-expand-two" + 'R4', async () => {
    await runTest({"suite":"default-valueset-version","test":"direct-expand-two"}, "4.0");
  });

  it("indirect-expand-one" + 'R5', async () => {
    await runTest({"suite":"default-valueset-version","test":"indirect-expand-one"}, "5.0");
  });

  it("indirect-expand-one" + 'R4', async () => {
    await runTest({"suite":"default-valueset-version","test":"indirect-expand-one"}, "4.0");
  });

  it("indirect-expand-two" + 'R5', async () => {
    await runTest({"suite":"default-valueset-version","test":"indirect-expand-two"}, "5.0");
  });

  it("indirect-expand-two" + 'R4', async () => {
    await runTest({"suite":"default-valueset-version","test":"indirect-expand-two"}, "4.0");
  });

  it("indirect-expand-zero" + 'R5', async () => {
    await runTest({"suite":"default-valueset-version","test":"indirect-expand-zero"}, "5.0");
  });

  it("indirect-expand-zero" + 'R4', async () => {
    await runTest({"suite":"default-valueset-version","test":"indirect-expand-zero"}, "4.0");
  });

  it("indirect-expand-zero-pinned" + 'R5', async () => {
    await runTest({"suite":"default-valueset-version","test":"indirect-expand-zero-pinned"}, "5.0");
  });

  it("indirect-expand-zero-pinned" + 'R4', async () => {
    await runTest({"suite":"default-valueset-version","test":"indirect-expand-zero-pinned"}, "4.0");
  });

  it("indirect-expand-zero-pinned-wrong" + 'R5', async () => {
    await runTest({"suite":"default-valueset-version","test":"indirect-expand-zero-pinned-wrong"}, "5.0");
  });

  it("indirect-expand-zero-pinned-wrong" + 'R4', async () => {
    await runTest({"suite":"default-valueset-version","test":"indirect-expand-zero-pinned-wrong"}, "4.0");
  });

  it("indirect-validation-one" + 'R5', async () => {
    await runTest({"suite":"default-valueset-version","test":"indirect-validation-one"}, "5.0");
  });

  it("indirect-validation-one" + 'R4', async () => {
    await runTest({"suite":"default-valueset-version","test":"indirect-validation-one"}, "4.0");
  });

  it("indirect-validation-two" + 'R5', async () => {
    await runTest({"suite":"default-valueset-version","test":"indirect-validation-two"}, "5.0");
  });

  it("indirect-validation-two" + 'R4', async () => {
    await runTest({"suite":"default-valueset-version","test":"indirect-validation-two"}, "4.0");
  });

  it("indirect-validation-zero" + 'R5', async () => {
    await runTest({"suite":"default-valueset-version","test":"indirect-validation-zero"}, "5.0");
  });

  it("indirect-validation-zero" + 'R4', async () => {
    await runTest({"suite":"default-valueset-version","test":"indirect-validation-zero"}, "4.0");
  });

  it("indirect-validation-zero-pinned" + 'R5', async () => {
    await runTest({"suite":"default-valueset-version","test":"indirect-validation-zero-pinned"}, "5.0");
  });

  it("indirect-validation-zero-pinned" + 'R4', async () => {
    await runTest({"suite":"default-valueset-version","test":"indirect-validation-zero-pinned"}, "4.0");
  });

  it("indirect-validation-zero-pinned-wrong" + 'R5', async () => {
    await runTest({"suite":"default-valueset-version","test":"indirect-validation-zero-pinned-wrong"}, "5.0");
  });

  it("indirect-validation-zero-pinned-wrong" + 'R4', async () => {
    await runTest({"suite":"default-valueset-version","test":"indirect-validation-zero-pinned-wrong"}, "4.0");
  });

});

describe('tx.fhir.org', () => {
  // These are tx.fhir.org specific tests. There's no expectation that other servers will pass these tests, and they are not executed by default. (other servers can, but they depend on other set up not controlled by the tests

  it("snomed-validation-1" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-validation-1"}, "5.0");
  });

  it("snomed-validation-1" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-validation-1"}, "4.0");
  });

  it("loinc-lookup-code" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-lookup-code"}, "5.0");
  });

  it("loinc-lookup-code" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-lookup-code"}, "4.0");
  });

  it("loinc-lookup-part" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-lookup-part"}, "5.0");
  });

  it("loinc-lookup-part" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-lookup-part"}, "4.0");
  });

  it("loinc-lookup-list" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-lookup-list"}, "5.0");
  });

  it("loinc-lookup-list" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-lookup-list"}, "4.0");
  });

  it("loinc-lookup-answer" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-lookup-answer"}, "5.0");
  });

  it("loinc-lookup-answer" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-lookup-answer"}, "4.0");
  });

  it("loinc-validate-code" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-code"}, "5.0");
  });

  it("loinc-validate-code" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-code"}, "4.0");
  });

  it("loinc-validate-code-uz" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-code-uz"}, "5.0");
  });

  it("loinc-validate-code-uz" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-code-uz"}, "4.0");
  });

  it("loinc-validate-discouraged-code" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-discouraged-code"}, "5.0");
  });

  it("loinc-validate-discouraged-code" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-discouraged-code"}, "4.0");
  });

  it("loinc-validate-code-supp1" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-code-supp1"}, "5.0");
  });

  it("loinc-validate-code-supp1" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-code-supp1"}, "4.0");
  });

  it("loinc-validate-code-supp2" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-code-supp2"}, "5.0");
  });

  it("loinc-validate-code-supp2" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-code-supp2"}, "4.0");
  });

  it("loinc-validate-part" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-part"}, "5.0");
  });

  it("loinc-validate-part" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-part"}, "4.0");
  });

  it("loinc-validate-list" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-list"}, "5.0");
  });

  it("loinc-validate-list" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-list"}, "4.0");
  });

  it("loinc-validate-answer" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-answer"}, "5.0");
  });

  it("loinc-validate-answer" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-answer"}, "4.0");
  });

  it("loinc-validate-invalid" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-invalid"}, "5.0");
  });

  it("loinc-validate-invalid" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-invalid"}, "4.0");
  });

  it("loinc-expand-enum" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-enum"}, "5.0");
  });

  it("loinc-expand-enum" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-enum"}, "4.0");
  });

  it("loinc-expand-all" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-all"}, "5.0");
  });

  it("loinc-expand-all" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-all"}, "4.0");
  });

  it("hgvs-expand-all" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"hgvs-expand-all"}, "5.0");
  });

  it("hgvs-expand-all" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"hgvs-expand-all"}, "4.0");
  });

  it("loinc-expand-all-limited" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-all-limited"}, "5.0");
  });

  it("loinc-expand-all-limited" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-all-limited"}, "4.0");
  });

  it("loinc-expand-enum-bad" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-enum-bad"}, "5.0");
  });

  it("loinc-expand-enum-bad" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-enum-bad"}, "4.0");
  });

  it("loinc-expand-status" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-status"}, "5.0");
  });

  it("loinc-expand-status" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-status"}, "4.0");
  });

  it("loinc-expand-parent" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-parent"}, "5.0");
  });

  it("loinc-expand-parent" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-parent"}, "4.0");
  });

  it("loinc-expand-class-regex" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-class-regex"}, "5.0");
  });

  it("loinc-expand-class-regex" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-class-regex"}, "4.0");
  });

  it("loinc-expand-prop-component" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-prop-component"}, "5.0");
  });

  it("loinc-expand-prop-component" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-prop-component"}, "4.0");
  });

  it("loinc-expand-prop-method" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-prop-method"}, "5.0");
  });

  it("loinc-expand-prop-method" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-prop-method"}, "4.0");
  });

  it("loinc-expand-prop-component-str" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-prop-component-str"}, "5.0");
  });

  it("loinc-expand-prop-component-str" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-prop-component-str"}, "4.0");
  });

  it("loinc-expand-prop-order-obs" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-prop-order-obs"}, "5.0");
  });

  it("loinc-expand-prop-order-obs" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-prop-order-obs"}, "4.0");
  });

  it("loinc-expand-concept-is-a" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-concept-is-a"}, "5.0");
  });

  it("loinc-expand-concept-is-a" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-concept-is-a"}, "4.0");
  });

  it("loinc-expand-copyright" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-copyright"}, "5.0");
  });

  it("loinc-expand-copyright" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-copyright"}, "4.0");
  });

  it("loinc-expand-scale-type" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-scale-type"}, "5.0");
  });

  it("loinc-expand-scale-type" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-scale-type"}, "4.0");
  });

  it("loinc-validate-enum-good" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-enum-good"}, "5.0");
  });

  it("loinc-validate-enum-good" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-enum-good"}, "4.0");
  });

  it("loinc-validate-enum-bad" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-enum-bad"}, "5.0");
  });

  it("loinc-validate-enum-bad" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-enum-bad"}, "4.0");
  });

  it("loinc-validate-filter-prop-component-good" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-filter-prop-component-good"}, "5.0");
  });

  it("loinc-validate-filter-prop-component-good" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-filter-prop-component-good"}, "4.0");
  });

  it("loinc-validate-filter-prop-component-bad" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-filter-prop-component-bad"}, "5.0");
  });

  it("loinc-validate-filter-prop-component-bad" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-filter-prop-component-bad"}, "4.0");
  });

  it("loinc-validate-filter-status-good" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-filter-status-good"}, "5.0");
  });

  it("loinc-validate-filter-status-good" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-filter-status-good"}, "4.0");
  });

  it("loinc-validate-filter-status-bad" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-filter-status-bad"}, "5.0");
  });

  it("loinc-validate-filter-status-bad" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-filter-status-bad"}, "4.0");
  });

  it("loinc-validate-filter-class-regex-good" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-filter-class-regex-good"}, "5.0");
  });

  it("loinc-validate-filter-class-regex-good" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-filter-class-regex-good"}, "4.0");
  });

  it("loinc-validate-filter-class-regex-bad" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-filter-class-regex-bad"}, "5.0");
  });

  it("loinc-validate-filter-class-regex-bad" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-filter-class-regex-bad"}, "4.0");
  });

  it("loinc-validate-filter-scale-type-good" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-filter-scale-type-good"}, "5.0");
  });

  it("loinc-validate-filter-scale-type-good" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-filter-scale-type-good"}, "4.0");
  });

  it("loinc-validate-filter-scale-type-bad" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-filter-scale-type-bad"}, "5.0");
  });

  it("loinc-validate-filter-scale-type-bad" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-filter-scale-type-bad"}, "4.0");
  });

  it("loinc-expand-list-request-parameters" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-list-request-parameters"}, "5.0");
  });

  it("loinc-expand-list-request-parameters" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-list-request-parameters"}, "4.0");
  });

  it("loinc-validate-list-good" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-list-good"}, "5.0");
  });

  it("loinc-validate-list-good" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-list-good"}, "4.0");
  });

  it("loinc-validate-list-bad" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-list-bad"}, "5.0");
  });

  it("loinc-validate-list-bad" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-list-bad"}, "4.0");
  });

  it("loinc-expand-filter-list-request-parameters" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-filter-list-request-parameters"}, "5.0");
  });

  it("loinc-expand-filter-list-request-parameters" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-filter-list-request-parameters"}, "4.0");
  });

  it("loinc-validate-filter-list-type-good" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-filter-list-type-good"}, "5.0");
  });

  it("loinc-validate-filter-list-type-good" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-filter-list-type-good"}, "4.0");
  });

  it("loinc-validate-filter-list-bad" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-filter-list-bad"}, "5.0");
  });

  it("loinc-validate-filter-list-bad" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-filter-list-bad"}, "4.0");
  });

  it("loinc-expand-filter-dockind-request-parameters" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-filter-dockind-request-parameters"}, "5.0");
  });

  it("loinc-expand-filter-dockind-request-parameters" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-filter-dockind-request-parameters"}, "4.0");
  });

  it("loinc-validate-filter-dockind-type-good" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-filter-dockind-type-good"}, "5.0");
  });

  it("loinc-validate-filter-dockind-type-good" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-filter-dockind-type-good"}, "4.0");
  });

  it("loinc-validate-filter-dockind-bad" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-filter-dockind-bad"}, "5.0");
  });

  it("loinc-validate-filter-dockind-bad" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-filter-dockind-bad"}, "4.0");
  });

  it("loinc-validate-filter-classtype-good" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-filter-classtype-good"}, "5.0");
  });

  it("loinc-validate-filter-classtype-good" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-filter-classtype-good"}, "4.0");
  });

  it("loinc-validate-filter-classtype-bad" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-filter-classtype-bad"}, "5.0");
  });

  it("loinc-validate-filter-classtype-bad" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-filter-classtype-bad"}, "4.0");
  });

  it("loinc-expand-filter-answers-for1" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-filter-answers-for1"}, "5.0");
  });

  it("loinc-expand-filter-answers-for1" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-filter-answers-for1"}, "4.0");
  });

  it("loinc-expand-filter-answers-for2" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-filter-answers-for2"}, "5.0");
  });

  it("loinc-expand-filter-answers-for2" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-filter-answers-for2"}, "4.0");
  });

  it("loinc-expand-filter-answer-list" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-filter-answer-list"}, "5.0");
  });

  it("loinc-expand-filter-answer-list" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-filter-answer-list"}, "4.0");
  });

  it("snomed-expand-active" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-expand-active"}, "5.0");
  });

  it("snomed-expand-active" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-expand-active"}, "4.0");
  });

  it("snomed-expand-inactive" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-expand-inactive"}, "5.0");
  });

  it("snomed-expand-inactive" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-expand-inactive"}, "4.0");
  });

  it("snomed-expand-inactive2" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-expand-inactive2"}, "5.0");
  });

  it("snomed-expand-inactive2" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-expand-inactive2"}, "4.0");
  });

  it("snomed-expand-moduleid-1" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-expand-moduleid-1"}, "5.0");
  });

  it("snomed-expand-moduleid-1" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-expand-moduleid-1"}, "4.0");
  });

  it("snomed-expand-moduleid-2" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-expand-moduleid-2"}, "5.0");
  });

  it("snomed-expand-moduleid-2" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-expand-moduleid-2"}, "4.0");
  });

  it("snomed-expand-moduleid-3" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-expand-moduleid-3"}, "5.0");
  });

  it("snomed-expand-moduleid-3" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-expand-moduleid-3"}, "4.0");
  });

  it("snomed-expand-moduleid-4" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-expand-moduleid-4"}, "5.0");
  });

  it("snomed-expand-moduleid-4" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-expand-moduleid-4"}, "4.0");
  });

  it("snomed-expand-property-1" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-expand-property-1"}, "5.0");
  });

  it("snomed-expand-property-1" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-expand-property-1"}, "4.0");
  });

  it("snomed-expand-property-2" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-expand-property-2"}, "5.0");
  });

  it("snomed-expand-property-2" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-expand-property-2"}, "4.0");
  });

  it("snomed-validate-active-bad" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-validate-active-bad"}, "5.0");
  });

  it("snomed-validate-active-bad" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-validate-active-bad"}, "4.0");
  });

  it("snomed-validate-active-good" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-validate-active-good"}, "5.0");
  });

  it("snomed-validate-active-good" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-validate-active-good"}, "4.0");
  });

  it("snomed-validate-inactive-bad" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-validate-inactive-bad"}, "5.0");
  });

  it("snomed-validate-inactive-bad" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-validate-inactive-bad"}, "4.0");
  });

  it("snomed-validate-inactive-good" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-validate-inactive-good"}, "5.0");
  });

  it("snomed-validate-inactive-good" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-validate-inactive-good"}, "4.0");
  });

  it("snomed-validate-moduleid-bad" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-validate-moduleid-bad"}, "5.0");
  });

  it("snomed-validate-moduleid-bad" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-validate-moduleid-bad"}, "4.0");
  });

  it("snomed-validate-moduleid-good" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-validate-moduleid-good"}, "5.0");
  });

  it("snomed-validate-moduleid-good" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-validate-moduleid-good"}, "4.0");
  });

  it("snomed-validate-property-bad" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-validate-property-bad"}, "5.0");
  });

  it("snomed-validate-property-bad" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-validate-property-bad"}, "4.0");
  });

  it("snomed-validate-property-good" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-validate-property-good"}, "5.0");
  });

  it("snomed-validate-property-good" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-validate-property-good"}, "4.0");
  });

  it("snomed-translate" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-translate"}, "5.0");
  });

  it("snomed-translate" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-translate"}, "4.0");
  });

  it("loinc-subsumes-equivalent" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-subsumes-equivalent"}, "5.0");
  });

  it("loinc-subsumes-equivalent" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-subsumes-equivalent"}, "4.0");
  });

  it("loinc-subsumes-parent" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-subsumes-parent"}, "5.0");
  });

  it("loinc-subsumes-parent" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-subsumes-parent"}, "4.0");
  });

  it("loinc-subsumes-child" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-subsumes-child"}, "5.0");
  });

  it("loinc-subsumes-child" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-subsumes-child"}, "4.0");
  });

  it("loinc-subsumes-unrelated" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-subsumes-unrelated"}, "5.0");
  });

  it("loinc-subsumes-unrelated" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-subsumes-unrelated"}, "4.0");
  });

  it("loinc-subsumes-unknown-code" + 'R5', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-subsumes-unknown-code"}, "5.0");
  });

  it("loinc-subsumes-unknown-code" + 'R4', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-subsumes-unknown-code"}, "4.0");
  });

});

describe('snomed', () => {
  // This snomed tests are based on the testing subset in the tx-ecosystem IG github repo (see /tx-source)

  it("snomed-inactive-display-lenient" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"snomed-inactive-display-lenient"}, "5.0");
  });

  it("snomed-inactive-display-lenient" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"snomed-inactive-display-lenient"}, "4.0");
  });

  it("snomed-inactive-display-notlenient" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"snomed-inactive-display-notlenient"}, "5.0");
  });

  it("snomed-inactive-display-notlenient" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"snomed-inactive-display-notlenient"}, "4.0");
  });

  it("snomed-isa-in" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"snomed-isa-in"}, "5.0");
  });

  it("snomed-isa-in" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"snomed-isa-in"}, "4.0");
  });

  it("snomed-isa-out" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"snomed-isa-out"}, "5.0");
  });

  it("snomed-isa-out" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"snomed-isa-out"}, "4.0");
  });

  it("snomed-expand-inactive" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"snomed-expand-inactive"}, "5.0");
  });

  it("snomed-expand-inactive" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"snomed-expand-inactive"}, "4.0");
  });

  it("snomed-expand-isa" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"snomed-expand-isa"}, "5.0");
  });

  it("snomed-expand-isa" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"snomed-expand-isa"}, "4.0");
  });

  it("snomed-expand-count-all" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"snomed-expand-count-all"}, "5.0");
  });

  it("snomed-expand-count-all" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"snomed-expand-count-all"}, "4.0");
  });

  it("snomed-expand-too-big" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"snomed-expand-too-big"}, "5.0");
  });

  it("snomed-expand-too-big" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"snomed-expand-too-big"}, "4.0");
  });

  it("lookup" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"lookup"}, "5.0");
  });

  it("lookup" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"lookup"}, "4.0");
  });

  it("lookup-pc" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"lookup-pc"}, "5.0");
  });

  it("lookup-pc" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"lookup-pc"}, "4.0");
  });

  it("validate-code-pc-good" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-good"}, "5.0");
  });

  it("validate-code-pc-good" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-good"}, "4.0");
  });

  it("validate-code-pc-bad1" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-bad1"}, "5.0");
  });

  it("validate-code-pc-bad1" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-bad1"}, "4.0");
  });

  it("validate-code-pc-bad2" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-bad2"}, "5.0");
  });

  it("validate-code-pc-bad2" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-bad2"}, "4.0");
  });

  it("validate-code-pc-nested-good" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-nested-good"}, "5.0");
  });

  it("validate-code-pc-nested-good" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-nested-good"}, "4.0");
  });

  it("validate-code-pc-mrcm-lateralizable" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-mrcm-lateralizable"}, "5.0");
  });

  it("validate-code-pc-mrcm-lateralizable" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-mrcm-lateralizable"}, "4.0");
  });

  it("validate-code-pc-mrcm-domain" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-mrcm-domain"}, "5.0");
  });

  it("validate-code-pc-mrcm-domain" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-mrcm-domain"}, "4.0");
  });

  it("validate-code-pc-mrcm-range" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-mrcm-range"}, "5.0");
  });

  it("validate-code-pc-mrcm-range" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-mrcm-range"}, "4.0");
  });

  it("validate-code-pc-mrcm-cardinality" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-mrcm-cardinality"}, "5.0");
  });

  it("validate-code-pc-mrcm-cardinality" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-mrcm-cardinality"}, "4.0");
  });

  it("validate-code-pc-mrcm-grouped" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-mrcm-grouped"}, "5.0");
  });

  it("validate-code-pc-mrcm-grouped" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-mrcm-grouped"}, "4.0");
  });

  it("validate-code-pc-concrete-good" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-concrete-good"}, "5.0");
  });

  it("validate-code-pc-concrete-good" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-concrete-good"}, "4.0");
  });

  it("validate-code-pc-scg-no-comma" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-scg-no-comma"}, "5.0");
  });

  it("validate-code-pc-scg-no-comma" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-scg-no-comma"}, "4.0");
  });

  it("validate-code-pc-scg-comma" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-scg-comma"}, "5.0");
  });

  it("validate-code-pc-scg-comma" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-scg-comma"}, "4.0");
  });

  it("validate-code-pc-mrcm-concrete-range" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-mrcm-concrete-range"}, "5.0");
  });

  it("validate-code-pc-mrcm-concrete-range" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-mrcm-concrete-range"}, "4.0");
  });

  it("validate-code-pc-mrcm-concrete-int" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-mrcm-concrete-int"}, "5.0");
  });

  it("validate-code-pc-mrcm-concrete-int" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-mrcm-concrete-int"}, "4.0");
  });

  it("validate-code-pc-mrcm-concrete-wanted" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-mrcm-concrete-wanted"}, "5.0");
  });

  it("validate-code-pc-mrcm-concrete-wanted" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-mrcm-concrete-wanted"}, "4.0");
  });

  it("validate-code-pc-mrcm-concept-wanted" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-mrcm-concept-wanted"}, "5.0");
  });

  it("validate-code-pc-mrcm-concept-wanted" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-mrcm-concept-wanted"}, "4.0");
  });

  it("validate-code-pc-none" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-none"}, "5.0");
  });

  it("validate-code-pc-none" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-none"}, "4.0");
  });

  it("validate-code-pc-list" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-list"}, "5.0");
  });

  it("validate-code-pc-list" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-list"}, "4.0");
  });

  it("validate-code-pc-list-bad" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-list-bad"}, "5.0");
  });

  it("validate-code-pc-list-bad" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-list-bad"}, "4.0");
  });

  it("validate-code-pc-filter" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-filter"}, "5.0");
  });

  it("validate-code-pc-filter" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-filter"}, "4.0");
  });

  it("expand-pc-none" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"expand-pc-none"}, "5.0");
  });

  it("expand-pc-none" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"expand-pc-none"}, "4.0");
  });

  it("expand-pc-list" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"expand-pc-list"}, "5.0");
  });

  it("expand-pc-list" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"expand-pc-list"}, "4.0");
  });

  it("expand-pc-filter" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"expand-pc-filter"}, "5.0");
  });

  it("expand-pc-filter" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"expand-pc-filter"}, "4.0");
  });

  it("validate-code-implied-1" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"validate-code-implied-1"}, "5.0");
  });

  it("validate-code-implied-1" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"validate-code-implied-1"}, "4.0");
  });

  it("validate-code-implied-1b" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"validate-code-implied-1b"}, "5.0");
  });

  it("validate-code-implied-1b" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"validate-code-implied-1b"}, "4.0");
  });

  it("validate-code-implied-2" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"validate-code-implied-2"}, "5.0");
  });

  it("validate-code-implied-2" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"validate-code-implied-2"}, "4.0");
  });

  it("validate-code-implied-2b" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"validate-code-implied-2b"}, "5.0");
  });

  it("validate-code-implied-2b" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"validate-code-implied-2b"}, "4.0");
  });

  it("subsumes-simple" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"subsumes-simple"}, "5.0");
  });

  it("subsumes-simple" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"subsumes-simple"}, "4.0");
  });

  it("subsumes-parent" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"subsumes-parent"}, "5.0");
  });

  it("subsumes-parent" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"subsumes-parent"}, "4.0");
  });

  it("subsumes-equivalent" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"subsumes-equivalent"}, "5.0");
  });

  it("subsumes-equivalent" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"subsumes-equivalent"}, "4.0");
  });

  it("subsumes-transitive" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"subsumes-transitive"}, "5.0");
  });

  it("subsumes-transitive" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"subsumes-transitive"}, "4.0");
  });

  it("subsumes-siblings" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"subsumes-siblings"}, "5.0");
  });

  it("subsumes-siblings" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"subsumes-siblings"}, "4.0");
  });

  it("subsumes-disjoint" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"subsumes-disjoint"}, "5.0");
  });

  it("subsumes-disjoint" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"subsumes-disjoint"}, "4.0");
  });

  it("subsumes-coding" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"subsumes-coding"}, "5.0");
  });

  it("subsumes-coding" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"subsumes-coding"}, "4.0");
  });

  it("subsumes-unknown-code-a" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"subsumes-unknown-code-a"}, "5.0");
  });

  it("subsumes-unknown-code-a" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"subsumes-unknown-code-a"}, "4.0");
  });

  it("subsumes-unknown-code-b" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"subsumes-unknown-code-b"}, "5.0");
  });

  it("subsumes-unknown-code-b" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"subsumes-unknown-code-b"}, "4.0");
  });

  it("subsumes-invalid-code" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"subsumes-invalid-code"}, "5.0");
  });

  it("subsumes-invalid-code" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"subsumes-invalid-code"}, "4.0");
  });

  it("subsumes-bad-version" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"subsumes-bad-version"}, "5.0");
  });

  it("subsumes-bad-version" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"subsumes-bad-version"}, "4.0");
  });

  it("subsumes-bad-system" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"subsumes-bad-system"}, "5.0");
  });

  it("subsumes-bad-system" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"subsumes-bad-system"}, "4.0");
  });

  it("subsumes-expr-refined-vs-parent" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-refined-vs-parent"}, "5.0");
  });

  it("subsumes-expr-refined-vs-parent" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-refined-vs-parent"}, "4.0");
  });

  it("subsumes-expr-parent-vs-refined" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-parent-vs-refined"}, "5.0");
  });

  it("subsumes-expr-parent-vs-refined" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-parent-vs-refined"}, "4.0");
  });

  it("subsumes-expr-vs-focus" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-vs-focus"}, "5.0");
  });

  it("subsumes-expr-vs-focus" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-vs-focus"}, "4.0");
  });

  it("subsumes-expr-attr-value" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-attr-value"}, "5.0");
  });

  it("subsumes-expr-attr-value" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-attr-value"}, "4.0");
  });

  it("subsumes-expr-attr-value-reverse" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-attr-value-reverse"}, "5.0");
  });

  it("subsumes-expr-attr-value-reverse" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-attr-value-reverse"}, "4.0");
  });

  it("subsumes-expr-attr-unrelated" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-attr-unrelated"}, "5.0");
  });

  it("subsumes-expr-attr-unrelated" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-attr-unrelated"}, "4.0");
  });

  it("subsumes-expr-extra-attribute" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-extra-attribute"}, "5.0");
  });

  it("subsumes-expr-extra-attribute" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-extra-attribute"}, "4.0");
  });

  it("subsumes-expr-different-attributes" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-different-attributes"}, "5.0");
  });

  it("subsumes-expr-different-attributes" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-different-attributes"}, "4.0");
  });

  it("subsumes-expr-primitive-focus" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-primitive-focus"}, "5.0");
  });

  it("subsumes-expr-primitive-focus" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-primitive-focus"}, "4.0");
  });

  it("subsumes-expr-normal-form" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-normal-form"}, "5.0");
  });

  it("subsumes-expr-normal-form" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-normal-form"}, "4.0");
  });

  it("subsumes-expr-redundant-refinement" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-redundant-refinement"}, "5.0");
  });

  it("subsumes-expr-redundant-refinement" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-redundant-refinement"}, "4.0");
  });

  it("subsumes-expr-grouped-ungrouped" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-grouped-ungrouped"}, "5.0");
  });

  it("subsumes-expr-grouped-ungrouped" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-grouped-ungrouped"}, "4.0");
  });

  it("subsumes-expr-ungrouped-morphology" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-ungrouped-morphology"}, "5.0");
  });

  it("subsumes-expr-ungrouped-morphology" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-ungrouped-morphology"}, "4.0");
  });

  it("subsumes-expr-ungrouped-laterality" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-ungrouped-laterality"}, "5.0");
  });

  it("subsumes-expr-ungrouped-laterality" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-ungrouped-laterality"}, "4.0");
  });

  it("subsumes-expr-with-terms" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-with-terms"}, "5.0");
  });

  it("subsumes-expr-with-terms" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-with-terms"}, "4.0");
  });

  it("subsumes-expr-conjunction" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-conjunction"}, "5.0");
  });

  it("subsumes-expr-conjunction" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-conjunction"}, "4.0");
  });

  it("subsumes-expr-precoordinated-match" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-precoordinated-match"}, "5.0");
  });

  it("subsumes-expr-precoordinated-match" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-precoordinated-match"}, "4.0");
  });

  it("subsumes-expr-subsumes-precoordinated" + 'R5', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-subsumes-precoordinated"}, "5.0");
  });

  it("subsumes-expr-subsumes-precoordinated" + 'R4', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-subsumes-precoordinated"}, "4.0");
  });

});

describe('sct-ecl', () => {
  // SNOMED CT ECL tests (expand + validate-code), split out of the snomed suite for manageability. Files live in sct/ecl/.

  it("snomed-validate-ecl-descendents-code-in" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-descendents-code-in"}, "5.0");
  });

  it("snomed-validate-ecl-descendents-code-in" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-descendents-code-in"}, "4.0");
  });

  it("snomed-validate-ecl-descendents-code-out" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-descendents-code-out"}, "5.0");
  });

  it("snomed-validate-ecl-descendents-code-out" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-descendents-code-out"}, "4.0");
  });

  it("snomed-validate-ecl-descendents-expr-in" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-descendents-expr-in"}, "5.0");
  });

  it("snomed-validate-ecl-descendents-expr-in" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-descendents-expr-in"}, "4.0");
  });

  it("snomed-validate-ecl-descendents-expr-out" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-descendents-expr-out"}, "5.0");
  });

  it("snomed-validate-ecl-descendents-expr-out" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-descendents-expr-out"}, "4.0");
  });

  it("snomed-validate-ecl-descOrSelf-code-in" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-descOrSelf-code-in"}, "5.0");
  });

  it("snomed-validate-ecl-descOrSelf-code-in" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-descOrSelf-code-in"}, "4.0");
  });

  it("snomed-validate-ecl-descOrSelf-code-out" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-descOrSelf-code-out"}, "5.0");
  });

  it("snomed-validate-ecl-descOrSelf-code-out" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-descOrSelf-code-out"}, "4.0");
  });

  it("snomed-validate-ecl-descOrSelf-expr-in" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-descOrSelf-expr-in"}, "5.0");
  });

  it("snomed-validate-ecl-descOrSelf-expr-in" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-descOrSelf-expr-in"}, "4.0");
  });

  it("snomed-validate-ecl-descOrSelf-expr-out" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-descOrSelf-expr-out"}, "5.0");
  });

  it("snomed-validate-ecl-descOrSelf-expr-out" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-descOrSelf-expr-out"}, "4.0");
  });

  it("snomed-validate-ecl-children-code-in" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-children-code-in"}, "5.0");
  });

  it("snomed-validate-ecl-children-code-in" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-children-code-in"}, "4.0");
  });

  it("snomed-validate-ecl-children-code-out" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-children-code-out"}, "5.0");
  });

  it("snomed-validate-ecl-children-code-out" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-children-code-out"}, "4.0");
  });

  it("snomed-validate-ecl-children-expr-in" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-children-expr-in"}, "5.0");
  });

  it("snomed-validate-ecl-children-expr-in" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-children-expr-in"}, "4.0");
  });

  it("snomed-validate-ecl-children-expr-out" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-children-expr-out"}, "5.0");
  });

  it("snomed-validate-ecl-children-expr-out" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-children-expr-out"}, "4.0");
  });

  it("snomed-validate-ecl-childrenOrSelf-code-in" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-childrenOrSelf-code-in"}, "5.0");
  });

  it("snomed-validate-ecl-childrenOrSelf-code-in" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-childrenOrSelf-code-in"}, "4.0");
  });

  it("snomed-validate-ecl-childrenOrSelf-code-out" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-childrenOrSelf-code-out"}, "5.0");
  });

  it("snomed-validate-ecl-childrenOrSelf-code-out" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-childrenOrSelf-code-out"}, "4.0");
  });

  it("snomed-validate-ecl-childrenOrSelf-expr-in" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-childrenOrSelf-expr-in"}, "5.0");
  });

  it("snomed-validate-ecl-childrenOrSelf-expr-in" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-childrenOrSelf-expr-in"}, "4.0");
  });

  it("snomed-validate-ecl-childrenOrSelf-expr-out" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-childrenOrSelf-expr-out"}, "5.0");
  });

  it("snomed-validate-ecl-childrenOrSelf-expr-out" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-childrenOrSelf-expr-out"}, "4.0");
  });

  it("snomed-validate-ecl-ancestors-code-in" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-ancestors-code-in"}, "5.0");
  });

  it("snomed-validate-ecl-ancestors-code-in" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-ancestors-code-in"}, "4.0");
  });

  it("snomed-validate-ecl-ancestors-code-out" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-ancestors-code-out"}, "5.0");
  });

  it("snomed-validate-ecl-ancestors-code-out" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-ancestors-code-out"}, "4.0");
  });

  it("snomed-validate-ecl-ancestors-expr-out" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-ancestors-expr-out"}, "5.0");
  });

  it("snomed-validate-ecl-ancestors-expr-out" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-ancestors-expr-out"}, "4.0");
  });

  it("snomed-validate-ecl-ancOrSelf-code-in" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-ancOrSelf-code-in"}, "5.0");
  });

  it("snomed-validate-ecl-ancOrSelf-code-in" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-ancOrSelf-code-in"}, "4.0");
  });

  it("snomed-validate-ecl-ancOrSelf-code-out" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-ancOrSelf-code-out"}, "5.0");
  });

  it("snomed-validate-ecl-ancOrSelf-code-out" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-ancOrSelf-code-out"}, "4.0");
  });

  it("snomed-validate-ecl-ancOrSelf-expr-out" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-ancOrSelf-expr-out"}, "5.0");
  });

  it("snomed-validate-ecl-ancOrSelf-expr-out" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-ancOrSelf-expr-out"}, "4.0");
  });

  it("snomed-validate-ecl-parents-code-in" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-parents-code-in"}, "5.0");
  });

  it("snomed-validate-ecl-parents-code-in" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-parents-code-in"}, "4.0");
  });

  it("snomed-validate-ecl-parents-code-out" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-parents-code-out"}, "5.0");
  });

  it("snomed-validate-ecl-parents-code-out" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-parents-code-out"}, "4.0");
  });

  it("snomed-validate-ecl-parents-expr-out" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-parents-expr-out"}, "5.0");
  });

  it("snomed-validate-ecl-parents-expr-out" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-parents-expr-out"}, "4.0");
  });

  it("snomed-validate-ecl-parentsOrSelf-code-in" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-parentsOrSelf-code-in"}, "5.0");
  });

  it("snomed-validate-ecl-parentsOrSelf-code-in" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-parentsOrSelf-code-in"}, "4.0");
  });

  it("snomed-validate-ecl-parentsOrSelf-code-out" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-parentsOrSelf-code-out"}, "5.0");
  });

  it("snomed-validate-ecl-parentsOrSelf-code-out" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-parentsOrSelf-code-out"}, "4.0");
  });

  it("snomed-validate-ecl-parentsOrSelf-expr-out" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-parentsOrSelf-expr-out"}, "5.0");
  });

  it("snomed-validate-ecl-parentsOrSelf-expr-out" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-parentsOrSelf-expr-out"}, "4.0");
  });

  it("snomed-validate-ecl-refinement-simple-code-in" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-simple-code-in"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-simple-code-in" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-simple-code-in"}, "4.0");
  });

  it("snomed-validate-ecl-refinement-simple-code-out" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-simple-code-out"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-simple-code-out" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-simple-code-out"}, "4.0");
  });

  it("snomed-validate-ecl-refinement-simple-expr-in" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-simple-expr-in"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-simple-expr-in" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-simple-expr-in"}, "4.0");
  });

  it("snomed-validate-ecl-refinement-simple-expr-out" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-simple-expr-out"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-simple-expr-out" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-simple-expr-out"}, "4.0");
  });

  it("snomed-validate-ecl-refinement-group-code-out" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-group-code-out"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-group-code-out" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-group-code-out"}, "4.0");
  });

  it("snomed-validate-ecl-refinement-group-expr-in" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-group-expr-in"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-group-expr-in" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-group-expr-in"}, "4.0");
  });

  it("snomed-validate-ecl-refinement-group-expr-out" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-group-expr-out"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-group-expr-out" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-group-expr-out"}, "4.0");
  });

  it("snomed-validate-ecl-refinement-morphology-code-in" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-morphology-code-in"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-morphology-code-in" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-morphology-code-in"}, "4.0");
  });

  it("snomed-validate-ecl-refinement-morphology-code-out" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-morphology-code-out"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-morphology-code-out" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-morphology-code-out"}, "4.0");
  });

  it("snomed-validate-ecl-refinement-morphology-expr-in" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-morphology-expr-in"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-morphology-expr-in" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-morphology-expr-in"}, "4.0");
  });

  it("snomed-validate-ecl-refinement-morphology-expr-out" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-morphology-expr-out"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-morphology-expr-out" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-morphology-expr-out"}, "4.0");
  });

  it("snomed-validate-ecl-refinement-wildcard-code-in" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-wildcard-code-in"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-wildcard-code-in" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-wildcard-code-in"}, "4.0");
  });

  it("snomed-validate-ecl-refinement-wildcard-code-out" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-wildcard-code-out"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-wildcard-code-out" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-wildcard-code-out"}, "4.0");
  });

  it("snomed-validate-ecl-refinement-wildcard-expr-in" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-wildcard-expr-in"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-wildcard-expr-in" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-wildcard-expr-in"}, "4.0");
  });

  it("snomed-validate-ecl-refinement-wildcard-expr-out" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-wildcard-expr-out"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-wildcard-expr-out" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-wildcard-expr-out"}, "4.0");
  });

  it("snomed-validate-ecl-refinement-cardinality-code-in" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-cardinality-code-in"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-cardinality-code-in" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-cardinality-code-in"}, "4.0");
  });

  it("snomed-validate-ecl-refinement-cardinality-code-out" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-cardinality-code-out"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-cardinality-code-out" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-cardinality-code-out"}, "4.0");
  });

  it("snomed-validate-ecl-refinement-cardinality-expr-in" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-cardinality-expr-in"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-cardinality-expr-in" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-cardinality-expr-in"}, "4.0");
  });

  it("snomed-validate-ecl-refinement-cardinality-expr-out" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-cardinality-expr-out"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-cardinality-expr-out" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-cardinality-expr-out"}, "4.0");
  });

  it("snomed-validate-ecl-refinement-cardinality-grouped-code-in" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-cardinality-grouped-code-in"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-cardinality-grouped-code-in" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-cardinality-grouped-code-in"}, "4.0");
  });

  it("snomed-validate-ecl-refinement-cardinality-grouped-code-out" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-cardinality-grouped-code-out"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-cardinality-grouped-code-out" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-cardinality-grouped-code-out"}, "4.0");
  });

  it("snomed-validate-ecl-refinement-cardinality-grouped-expr-in" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-cardinality-grouped-expr-in"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-cardinality-grouped-expr-in" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-cardinality-grouped-expr-in"}, "4.0");
  });

  it("snomed-validate-ecl-refinement-cardinality-grouped-expr-out" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-cardinality-grouped-expr-out"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-cardinality-grouped-expr-out" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-cardinality-grouped-expr-out"}, "4.0");
  });

  it("snomed-validate-ecl-refinement-cardinality-rolegroup-code-in" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-cardinality-rolegroup-code-in"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-cardinality-rolegroup-code-in" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-cardinality-rolegroup-code-in"}, "4.0");
  });

  it("snomed-validate-ecl-refinement-cardinality-rolegroup-code-out" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-cardinality-rolegroup-code-out"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-cardinality-rolegroup-code-out" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-cardinality-rolegroup-code-out"}, "4.0");
  });

  it("snomed-validate-ecl-refinement-cardinality-rolegroup-expr-in" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-cardinality-rolegroup-expr-in"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-cardinality-rolegroup-expr-in" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-cardinality-rolegroup-expr-in"}, "4.0");
  });

  it("snomed-validate-ecl-refinement-cardinality-rolegroup-expr-out" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-cardinality-rolegroup-expr-out"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-cardinality-rolegroup-expr-out" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-cardinality-rolegroup-expr-out"}, "4.0");
  });

  it("snomed-validate-ecl-memberOf-refset-code-in" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-memberOf-refset-code-in"}, "5.0");
  });

  it("snomed-validate-ecl-memberOf-refset-code-in" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-memberOf-refset-code-in"}, "4.0");
  });

  it("snomed-validate-ecl-memberOf-refset-code-out" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-memberOf-refset-code-out"}, "5.0");
  });

  it("snomed-validate-ecl-memberOf-refset-code-out" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-memberOf-refset-code-out"}, "4.0");
  });

  it("snomed-validate-ecl-memberOf-refset-expr-out" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-memberOf-refset-expr-out"}, "5.0");
  });

  it("snomed-validate-ecl-memberOf-refset-expr-out" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-memberOf-refset-expr-out"}, "4.0");
  });

  it("snomed-validate-ecl-minus-code-in" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-minus-code-in"}, "5.0");
  });

  it("snomed-validate-ecl-minus-code-in" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-minus-code-in"}, "4.0");
  });

  it("snomed-validate-ecl-minus-code-out" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-minus-code-out"}, "5.0");
  });

  it("snomed-validate-ecl-minus-code-out" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-minus-code-out"}, "4.0");
  });

  it("snomed-validate-ecl-minus-expr-in" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-minus-expr-in"}, "5.0");
  });

  it("snomed-validate-ecl-minus-expr-in" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-minus-expr-in"}, "4.0");
  });

  it("snomed-validate-ecl-minus-expr-out" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-minus-expr-out"}, "5.0");
  });

  it("snomed-validate-ecl-minus-expr-out" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-minus-expr-out"}, "4.0");
  });

  it("snomed-validate-ecl-wildcard-code-in" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-wildcard-code-in"}, "5.0");
  });

  it("snomed-validate-ecl-wildcard-code-in" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-wildcard-code-in"}, "4.0");
  });

  it("snomed-validate-ecl-wildcard-expr-in" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-wildcard-expr-in"}, "5.0");
  });

  it("snomed-validate-ecl-wildcard-expr-in" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-wildcard-expr-in"}, "4.0");
  });

  it("snomed-validate-ecl-wildcard-minus-code-in" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-wildcard-minus-code-in"}, "5.0");
  });

  it("snomed-validate-ecl-wildcard-minus-code-in" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-wildcard-minus-code-in"}, "4.0");
  });

  it("snomed-validate-ecl-wildcard-minus-code-out" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-wildcard-minus-code-out"}, "5.0");
  });

  it("snomed-validate-ecl-wildcard-minus-code-out" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-wildcard-minus-code-out"}, "4.0");
  });

  it("snomed-validate-ecl-wildcard-minus-expr-in" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-wildcard-minus-expr-in"}, "5.0");
  });

  it("snomed-validate-ecl-wildcard-minus-expr-in" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-wildcard-minus-expr-in"}, "4.0");
  });

  it("snomed-validate-ecl-wildcard-minus-expr-out" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-wildcard-minus-expr-out"}, "5.0");
  });

  it("snomed-validate-ecl-wildcard-minus-expr-out" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-wildcard-minus-expr-out"}, "4.0");
  });

  it("snomed-expand-ecl-descOrSelf" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-descOrSelf"}, "5.0");
  });

  it("snomed-expand-ecl-descOrSelf" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-descOrSelf"}, "4.0");
  });

  it("snomed-expand-ecl-descendents" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-descendents"}, "5.0");
  });

  it("snomed-expand-ecl-descendents" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-descendents"}, "4.0");
  });

  it("snomed-expand-ecl-ancestors" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-ancestors"}, "5.0");
  });

  it("snomed-expand-ecl-ancestors" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-ancestors"}, "4.0");
  });

  it("snomed-expand-ecl-ancOrSelf" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-ancOrSelf"}, "5.0");
  });

  it("snomed-expand-ecl-ancOrSelf" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-ancOrSelf"}, "4.0");
  });

  it("snomed-expand-ecl-childrenOrSelf" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-childrenOrSelf"}, "5.0");
  });

  it("snomed-expand-ecl-childrenOrSelf" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-childrenOrSelf"}, "4.0");
  });

  it("snomed-expand-ecl-children" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-children"}, "5.0");
  });

  it("snomed-expand-ecl-children" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-children"}, "4.0");
  });

  it("snomed-expand-ecl-parents" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-parents"}, "5.0");
  });

  it("snomed-expand-ecl-parents" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-parents"}, "4.0");
  });

  it("snomed-expand-ecl-parentsOrSelf" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-parentsOrSelf"}, "5.0");
  });

  it("snomed-expand-ecl-parentsOrSelf" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-parentsOrSelf"}, "4.0");
  });

  it("snomed-expand-ecl-wildcard" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-wildcard"}, "5.0");
  });

  it("snomed-expand-ecl-wildcard" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-wildcard"}, "4.0");
  });

  it("snomed-expand-ecl-memberOf-refset" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-memberOf-refset"}, "5.0");
  });

  it("snomed-expand-ecl-memberOf-refset" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-memberOf-refset"}, "4.0");
  });

  it("snomed-expand-ecl-memberOf-nonRefset" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-memberOf-nonRefset"}, "5.0");
  });

  it("snomed-expand-ecl-memberOf-nonRefset" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-memberOf-nonRefset"}, "4.0");
  });

  it("snomed-expand-ecl-or" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-or"}, "5.0");
  });

  it("snomed-expand-ecl-or" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-or"}, "4.0");
  });

  it("snomed-expand-ecl-and" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-and"}, "5.0");
  });

  it("snomed-expand-ecl-and" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-and"}, "4.0");
  });

  it("snomed-expand-ecl-minus" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-minus"}, "5.0");
  });

  it("snomed-expand-ecl-minus" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-minus"}, "4.0");
  });

  it("snomed-expand-ecl-minus-empty" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-minus-empty"}, "5.0");
  });

  it("snomed-expand-ecl-minus-empty" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-minus-empty"}, "4.0");
  });

  it("snomed-expand-ecl-wildcard-minus" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-wildcard-minus"}, "5.0");
  });

  it("snomed-expand-ecl-wildcard-minus" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-wildcard-minus"}, "4.0");
  });

  it("snomed-expand-ecl-grouped-or" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-grouped-or"}, "5.0");
  });

  it("snomed-expand-ecl-grouped-or" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-grouped-or"}, "4.0");
  });

  it("snomed-expand-ecl-grouped-and" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-grouped-and"}, "5.0");
  });

  it("snomed-expand-ecl-grouped-and" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-grouped-and"}, "4.0");
  });

  it("snomed-expand-ecl-ambiguous-precedence" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-ambiguous-precedence"}, "5.0");
  });

  it("snomed-expand-ecl-ambiguous-precedence" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-ambiguous-precedence"}, "4.0");
  });

  it("snomed-expand-ecl-term-match" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-term-match"}, "5.0");
  });

  it("snomed-expand-ecl-term-match" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-term-match"}, "4.0");
  });

  it("snomed-expand-ecl-term-mismatch" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-term-mismatch"}, "5.0");
  });

  it("snomed-expand-ecl-term-mismatch" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-term-mismatch"}, "4.0");
  });

  it("snomed-expand-ecl-term-with-operator" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-term-with-operator"}, "5.0");
  });

  it("snomed-expand-ecl-term-with-operator" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-term-with-operator"}, "4.0");
  });

  it("snomed-expand-ecl-unknown-concept" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-unknown-concept"}, "5.0");
  });

  it("snomed-expand-ecl-unknown-concept" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-unknown-concept"}, "4.0");
  });

  it("snomed-expand-ecl-invalid-sctid" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-invalid-sctid"}, "5.0");
  });

  it("snomed-expand-ecl-invalid-sctid" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-invalid-sctid"}, "4.0");
  });

  it("snomed-expand-ecl-missing-focus" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-missing-focus"}, "5.0");
  });

  it("snomed-expand-ecl-missing-focus" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-missing-focus"}, "4.0");
  });

  it("snomed-expand-ecl-trailing-tokens" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-trailing-tokens"}, "5.0");
  });

  it("snomed-expand-ecl-trailing-tokens" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-trailing-tokens"}, "4.0");
  });

  it("snomed-expand-ecl-nested-parens" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-nested-parens"}, "5.0");
  });

  it("snomed-expand-ecl-nested-parens" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-nested-parens"}, "4.0");
  });

  it("snomed-expand-ecl-refinement-simple" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-refinement-simple"}, "5.0");
  });

  it("snomed-expand-ecl-refinement-simple" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-refinement-simple"}, "4.0");
  });

  it("snomed-expand-ecl-refinement-morphology" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-refinement-morphology"}, "5.0");
  });

  it("snomed-expand-ecl-refinement-morphology" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-refinement-morphology"}, "4.0");
  });

  it("snomed-expand-ecl-refinement-wildcard" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-refinement-wildcard"}, "5.0");
  });

  it("snomed-expand-ecl-refinement-wildcard" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-refinement-wildcard"}, "4.0");
  });

  it("snomed-expand-ecl-refinement-group" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-refinement-group"}, "5.0");
  });

  it("snomed-expand-ecl-refinement-group" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-refinement-group"}, "4.0");
  });

  it("snomed-expand-ecl-refinement-cardinality" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-refinement-cardinality"}, "5.0");
  });

  it("snomed-expand-ecl-refinement-cardinality" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-refinement-cardinality"}, "4.0");
  });

  it("snomed-expand-ecl-refinement-cardinality-grouped" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-refinement-cardinality-grouped"}, "5.0");
  });

  it("snomed-expand-ecl-refinement-cardinality-grouped" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-refinement-cardinality-grouped"}, "4.0");
  });

  it("snomed-expand-ecl-refinement-cardinality-rolegroup" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-refinement-cardinality-rolegroup"}, "5.0");
  });

  it("snomed-expand-ecl-refinement-cardinality-rolegroup" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-refinement-cardinality-rolegroup"}, "4.0");
  });

  it("snomed-expand-ecl-dotted" + 'R5', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-dotted"}, "5.0");
  });

  it("snomed-expand-ecl-dotted" + 'R4', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-dotted"}, "4.0");
  });

});

describe('batch', () => {
  // Test Batch Validation

  it("batch-validate" + 'R5', async () => {
    await runTest({"suite":"batch","test":"batch-validate"}, "5.0");
  });

  it("batch-validate" + 'R4', async () => {
    await runTest({"suite":"batch","test":"batch-validate"}, "4.0");
  });

  it("batch-validate-bad" + 'R5', async () => {
    await runTest({"suite":"batch","test":"batch-validate-bad"}, "5.0");
  });

  it("batch-validate-bad" + 'R4', async () => {
    await runTest({"suite":"batch","test":"batch-validate-bad"}, "4.0");
  });

});

describe('omop', () => {
  // Tests for OMOP implementations. Note that some servers only do OMOP (and some don't). The tests are based on a stable subset of OMOP maintained by Davera Gabriel

  it("omop-basic-validation-code-good" + 'R5', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-code-good"}, "5.0");
  });

  it("omop-basic-validation-code-good" + 'R4', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-code-good"}, "4.0");
  });

  it("omop-basic-validation-coding-good" + 'R5', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-coding-good"}, "5.0");
  });

  it("omop-basic-validation-coding-good" + 'R4', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-coding-good"}, "4.0");
  });

  it("omop-basic-validation-codeableconcept-good" + 'R5', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-codeableconcept-good"}, "5.0");
  });

  it("omop-basic-validation-codeableconcept-good" + 'R4', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-codeableconcept-good"}, "4.0");
  });

  it("omop-basic-validation-code-bad" + 'R5', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-code-bad"}, "5.0");
  });

  it("omop-basic-validation-code-bad" + 'R4', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-code-bad"}, "4.0");
  });

  it("omop-basic-validation-coding-bad" + 'R5', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-coding-bad"}, "5.0");
  });

  it("omop-basic-validation-coding-bad" + 'R4', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-coding-bad"}, "4.0");
  });

  it("omop-basic-validation-codeableconcept-bad" + 'R5', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-codeableconcept-bad"}, "5.0");
  });

  it("omop-basic-validation-codeableconcept-bad" + 'R4', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-codeableconcept-bad"}, "4.0");
  });

  it("omop-basic-validation-code-bad-display" + 'R5', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-code-bad-display"}, "5.0");
  });

  it("omop-basic-validation-code-bad-display" + 'R4', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-code-bad-display"}, "4.0");
  });

  it("omop-basic-validation-coding-bad-display" + 'R5', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-coding-bad-display"}, "5.0");
  });

  it("omop-basic-validation-coding-bad-display" + 'R4', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-coding-bad-display"}, "4.0");
  });

  it("omop-basic-validation-codeableconcept-bad-display" + 'R5', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-codeableconcept-bad-display"}, "5.0");
  });

  it("omop-basic-validation-codeableconcept-bad-display" + 'R4', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-codeableconcept-bad-display"}, "4.0");
  });

  it("omop-basic-validation-code-bad-version" + 'R5', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-code-bad-version"}, "5.0");
  });

  it("omop-basic-validation-code-bad-version" + 'R4', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-code-bad-version"}, "4.0");
  });

  it("omop-basic-validation-coding-bad-version" + 'R5', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-coding-bad-version"}, "5.0");
  });

  it("omop-basic-validation-coding-bad-version" + 'R4', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-coding-bad-version"}, "4.0");
  });

  it("omop-basic-validation-codeableconcept-bad-version" + 'R5', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-codeableconcept-bad-version"}, "5.0");
  });

  it("omop-basic-validation-codeableconcept-bad-version" + 'R4', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-codeableconcept-bad-version"}, "4.0");
  });

  it("omop-basic-validation-code-good-vs" + 'R5', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-code-good-vs"}, "5.0");
  });

  it("omop-basic-validation-code-good-vs" + 'R4', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-code-good-vs"}, "4.0");
  });

  it("omop-basic-validation-coding-good-vs" + 'R5', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-coding-good-vs"}, "5.0");
  });

  it("omop-basic-validation-coding-good-vs" + 'R4', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-coding-good-vs"}, "4.0");
  });

  it("omop-basic-validation-codeableconcept-good-vs" + 'R5', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-codeableconcept-good-vs"}, "5.0");
  });

  it("omop-basic-validation-codeableconcept-good-vs" + 'R4', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-codeableconcept-good-vs"}, "4.0");
  });

  it("omop-basic-validation-code-bad-vs" + 'R5', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-code-bad-vs"}, "5.0");
  });

  it("omop-basic-validation-code-bad-vs" + 'R4', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-code-bad-vs"}, "4.0");
  });

  it("omop-basic-validation-coding-bad-vs" + 'R5', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-coding-bad-vs"}, "5.0");
  });

  it("omop-basic-validation-coding-bad-vs" + 'R4', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-coding-bad-vs"}, "4.0");
  });

  it("omop-basic-validation-codeableconcept-bad-vs" + 'R5', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-codeableconcept-bad-vs"}, "5.0");
  });

  it("omop-basic-validation-codeableconcept-bad-vs" + 'R4', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-codeableconcept-bad-vs"}, "4.0");
  });

  it("omop-lookup-code" + 'R5', async () => {
    await runTest({"suite":"omop","test":"omop-lookup-code"}, "5.0");
  });

  it("omop-lookup-code" + 'R4', async () => {
    await runTest({"suite":"omop","test":"omop-lookup-code"}, "4.0");
  });

  it("omop-lookup-code2" + 'R5', async () => {
    await runTest({"suite":"omop","test":"omop-lookup-code2"}, "5.0");
  });

  it("omop-lookup-code2" + 'R4', async () => {
    await runTest({"suite":"omop","test":"omop-lookup-code2"}, "4.0");
  });

  it("omop-lookup-code3" + 'R5', async () => {
    await runTest({"suite":"omop","test":"omop-lookup-code3"}, "5.0");
  });

  it("omop-lookup-code3" + 'R4', async () => {
    await runTest({"suite":"omop","test":"omop-lookup-code3"}, "4.0");
  });

  it("omop-basic-validation-code-good-vs-url" + 'R5', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-code-good-vs-url"}, "5.0");
  });

  it("omop-basic-validation-code-good-vs-url" + 'R4', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-code-good-vs-url"}, "4.0");
  });

  it("omop-basic-validation-code-bad-vs-url" + 'R5', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-code-bad-vs-url"}, "5.0");
  });

  it("omop-basic-validation-code-bad-vs-url" + 'R4', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-code-bad-vs-url"}, "4.0");
  });

  it("omop-expand-explicit" + 'R5', async () => {
    await runTest({"suite":"omop","test":"omop-expand-explicit"}, "5.0");
  });

  it("omop-expand-explicit" + 'R4', async () => {
    await runTest({"suite":"omop","test":"omop-expand-explicit"}, "4.0");
  });

  it("translate-loinc-implicit" + 'R5', async () => {
    await runTest({"suite":"omop","test":"translate-loinc-implicit"}, "5.0");
  });

  it("translate-loinc-implicit" + 'R4', async () => {
    await runTest({"suite":"omop","test":"translate-loinc-implicit"}, "4.0");
  });

  it("translate-loinc-implicit-bad" + 'R5', async () => {
    await runTest({"suite":"omop","test":"translate-loinc-implicit-bad"}, "5.0");
  });

  it("translate-loinc-implicit-bad" + 'R4', async () => {
    await runTest({"suite":"omop","test":"translate-loinc-implicit-bad"}, "4.0");
  });

});

describe('UCUM', () => {
  // UCUM Test Cases

  it("lookup" + 'R5', async () => {
    await runTest({"suite":"UCUM","test":"lookup"}, "5.0");
  });

  it("lookup" + 'R4', async () => {
    await runTest({"suite":"UCUM","test":"lookup"}, "4.0");
  });

  it("lookup-with-annotation" + 'R5', async () => {
    await runTest({"suite":"UCUM","test":"lookup-with-annotation"}, "5.0");
  });

  it("lookup-with-annotation" + 'R4', async () => {
    await runTest({"suite":"UCUM","test":"lookup-with-annotation"}, "4.0");
  });

  it("expand-ucum-all-4" + 'R4', async () => {
    await runTest({"suite":"UCUM","test":"expand-ucum-all-4"}, "4.0");
  });

  it("expand-ucum-all-5" + 'R5', async () => {
    await runTest({"suite":"UCUM","test":"expand-ucum-all-5"}, "5.0");
  });

  it("expand-ucum-canonical" + 'R5', async () => {
    await runTest({"suite":"UCUM","test":"expand-ucum-canonical"}, "5.0");
  });

  it("expand-ucum-canonical" + 'R4', async () => {
    await runTest({"suite":"UCUM","test":"expand-ucum-canonical"}, "4.0");
  });

  it("validate-ucum-canonical-good" + 'R5', async () => {
    await runTest({"suite":"UCUM","test":"validate-ucum-canonical-good"}, "5.0");
  });

  it("validate-ucum-canonical-good" + 'R4', async () => {
    await runTest({"suite":"UCUM","test":"validate-ucum-canonical-good"}, "4.0");
  });

  it("validate-ucum-canonical-bad" + 'R5', async () => {
    await runTest({"suite":"UCUM","test":"validate-ucum-canonical-bad"}, "5.0");
  });

  it("validate-ucum-canonical-bad" + 'R4', async () => {
    await runTest({"suite":"UCUM","test":"validate-ucum-canonical-bad"}, "4.0");
  });

  it("validate-all-canonical-good" + 'R5', async () => {
    await runTest({"suite":"UCUM","test":"validate-all-canonical-good"}, "5.0");
  });

  it("validate-all-canonical-good" + 'R4', async () => {
    await runTest({"suite":"UCUM","test":"validate-all-canonical-good"}, "4.0");
  });

  it("validate-ucum-all-bad" + 'R5', async () => {
    await runTest({"suite":"UCUM","test":"validate-ucum-all-bad"}, "5.0");
  });

  it("validate-ucum-all-bad" + 'R4', async () => {
    await runTest({"suite":"UCUM","test":"validate-ucum-all-bad"}, "4.0");
  });

  it("ucum-subsumes-equivalent" + 'R5', async () => {
    await runTest({"suite":"UCUM","test":"ucum-subsumes-equivalent"}, "5.0");
  });

  it("ucum-subsumes-equivalent" + 'R4', async () => {
    await runTest({"suite":"UCUM","test":"ucum-subsumes-equivalent"}, "4.0");
  });

  it("ucum-subsumes-canonical" + 'R5', async () => {
    await runTest({"suite":"UCUM","test":"ucum-subsumes-canonical"}, "5.0");
  });

  it("ucum-subsumes-canonical" + 'R4', async () => {
    await runTest({"suite":"UCUM","test":"ucum-subsumes-canonical"}, "4.0");
  });

  it("ucum-subsumes-unrelated" + 'R5', async () => {
    await runTest({"suite":"UCUM","test":"ucum-subsumes-unrelated"}, "5.0");
  });

  it("ucum-subsumes-unrelated" + 'R4', async () => {
    await runTest({"suite":"UCUM","test":"ucum-subsumes-unrelated"}, "4.0");
  });

  it("ucum-subsumes-scaled" + 'R5', async () => {
    await runTest({"suite":"UCUM","test":"ucum-subsumes-scaled"}, "5.0");
  });

  it("ucum-subsumes-scaled" + 'R4', async () => {
    await runTest({"suite":"UCUM","test":"ucum-subsumes-scaled"}, "4.0");
  });

  it("ucum-subsumes-invalid-code" + 'R5', async () => {
    await runTest({"suite":"UCUM","test":"ucum-subsumes-invalid-code"}, "5.0");
  });

  it("ucum-subsumes-invalid-code" + 'R4', async () => {
    await runTest({"suite":"UCUM","test":"ucum-subsumes-invalid-code"}, "4.0");
  });

  it("ucum-subsumes-annotation" + 'R5', async () => {
    await runTest({"suite":"UCUM","test":"ucum-subsumes-annotation"}, "5.0");
  });

  it("ucum-subsumes-annotation" + 'R4', async () => {
    await runTest({"suite":"UCUM","test":"ucum-subsumes-annotation"}, "4.0");
  });

  it("ucum-subsumes-derived" + 'R5', async () => {
    await runTest({"suite":"UCUM","test":"ucum-subsumes-derived"}, "5.0");
  });

  it("ucum-subsumes-derived" + 'R4', async () => {
    await runTest({"suite":"UCUM","test":"ucum-subsumes-derived"}, "4.0");
  });

  it("ucum-subsumes-offset" + 'R5', async () => {
    await runTest({"suite":"UCUM","test":"ucum-subsumes-offset"}, "5.0");
  });

  it("ucum-subsumes-offset" + 'R4', async () => {
    await runTest({"suite":"UCUM","test":"ucum-subsumes-offset"}, "4.0");
  });

  it("ucum-subsumes-same-canonical" + 'R5', async () => {
    await runTest({"suite":"UCUM","test":"ucum-subsumes-same-canonical"}, "5.0");
  });

  it("ucum-subsumes-same-canonical" + 'R4', async () => {
    await runTest({"suite":"UCUM","test":"ucum-subsumes-same-canonical"}, "4.0");
  });

  it("ucum-subsumes-both-scaled" + 'R5', async () => {
    await runTest({"suite":"UCUM","test":"ucum-subsumes-both-scaled"}, "5.0");
  });

  it("ucum-subsumes-both-scaled" + 'R4', async () => {
    await runTest({"suite":"UCUM","test":"ucum-subsumes-both-scaled"}, "4.0");
  });

  it("ucum-subsumes-dimensionless" + 'R5', async () => {
    await runTest({"suite":"UCUM","test":"ucum-subsumes-dimensionless"}, "5.0");
  });

  it("ucum-subsumes-dimensionless" + 'R4', async () => {
    await runTest({"suite":"UCUM","test":"ucum-subsumes-dimensionless"}, "4.0");
  });

});

describe('mimetypes', () => {
  // Tests for the mime types code system (BCP 13). Type and subtype have no hierarchy, but parameters narrow a media type, and the base filter selects by type or type/subtype

  it("mimetype-subsumes-equivalent" + 'R5', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-equivalent"}, "5.0");
  });

  it("mimetype-subsumes-equivalent" + 'R4', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-equivalent"}, "4.0");
  });

  it("mimetype-subsumes-unrelated" + 'R5', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-unrelated"}, "5.0");
  });

  it("mimetype-subsumes-unrelated" + 'R4', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-unrelated"}, "4.0");
  });

  it("mimetype-subsumes-suffix" + 'R5', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-suffix"}, "5.0");
  });

  it("mimetype-subsumes-suffix" + 'R4', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-suffix"}, "4.0");
  });

  it("mimetype-subsumes-parameter" + 'R5', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-parameter"}, "5.0");
  });

  it("mimetype-subsumes-parameter" + 'R4', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-parameter"}, "4.0");
  });

  it("mimetype-subsumes-parameter-reverse" + 'R5', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-parameter-reverse"}, "5.0");
  });

  it("mimetype-subsumes-parameter-reverse" + 'R4', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-parameter-reverse"}, "4.0");
  });

  it("mimetype-subsumes-parameter-siblings" + 'R5', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-parameter-siblings"}, "5.0");
  });

  it("mimetype-subsumes-parameter-siblings" + 'R4', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-parameter-siblings"}, "4.0");
  });

  it("mimetype-subsumes-parameter-added" + 'R5', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-parameter-added"}, "5.0");
  });

  it("mimetype-subsumes-parameter-added" + 'R4', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-parameter-added"}, "4.0");
  });

  it("mimetype-subsumes-parameter-disjoint" + 'R5', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-parameter-disjoint"}, "5.0");
  });

  it("mimetype-subsumes-parameter-disjoint" + 'R4', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-parameter-disjoint"}, "4.0");
  });

  it("mimetype-subsumes-default-explicit" + 'R5', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-default-explicit"}, "5.0");
  });

  it("mimetype-subsumes-default-explicit" + 'R4', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-default-explicit"}, "4.0");
  });

  it("mimetype-subsumes-default-contradicted" + 'R5', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-default-contradicted"}, "5.0");
  });

  it("mimetype-subsumes-default-contradicted" + 'R4', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-default-contradicted"}, "4.0");
  });

  it("mimetype-subsumes-default-format" + 'R5', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-default-format"}, "5.0");
  });

  it("mimetype-subsumes-default-format" + 'R4', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-default-format"}, "4.0");
  });

  it("mimetype-subsumes-charset-unknown-default" + 'R5', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-charset-unknown-default"}, "5.0");
  });

  it("mimetype-subsumes-charset-unknown-default" + 'R4', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-charset-unknown-default"}, "4.0");
  });

  it("mimetype-subsumes-case" + 'R5', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-case"}, "5.0");
  });

  it("mimetype-subsumes-case" + 'R4', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-case"}, "4.0");
  });

  it("mimetype-subsumes-unknown-parameter" + 'R5', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-unknown-parameter"}, "5.0");
  });

  it("mimetype-subsumes-unknown-parameter" + 'R4', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-unknown-parameter"}, "4.0");
  });

  it("mimetype-subsumes-unknown-parameter-value" + 'R5', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-unknown-parameter-value"}, "5.0");
  });

  it("mimetype-subsumes-unknown-parameter-value" + 'R4', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-unknown-parameter-value"}, "4.0");
  });

  it("mimetype-subsumes-unknown-parameter-shared" + 'R5', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-unknown-parameter-shared"}, "5.0");
  });

  it("mimetype-subsumes-unknown-parameter-shared" + 'R4', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-unknown-parameter-shared"}, "4.0");
  });

  it("mimetype-subsumes-invalid-code" + 'R5', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-invalid-code"}, "5.0");
  });

  it("mimetype-subsumes-invalid-code" + 'R4', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-invalid-code"}, "4.0");
  });

  it("mimetype-filter-base-type-in" + 'R5', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-filter-base-type-in"}, "5.0");
  });

  it("mimetype-filter-base-type-in" + 'R4', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-filter-base-type-in"}, "4.0");
  });

  it("mimetype-filter-base-type-params" + 'R5', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-filter-base-type-params"}, "5.0");
  });

  it("mimetype-filter-base-type-params" + 'R4', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-filter-base-type-params"}, "4.0");
  });

  it("mimetype-filter-base-type-other-subtype" + 'R5', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-filter-base-type-other-subtype"}, "5.0");
  });

  it("mimetype-filter-base-type-other-subtype" + 'R4', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-filter-base-type-other-subtype"}, "4.0");
  });

  it("mimetype-filter-base-type-out" + 'R5', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-filter-base-type-out"}, "5.0");
  });

  it("mimetype-filter-base-type-out" + 'R4', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-filter-base-type-out"}, "4.0");
  });

  it("mimetype-filter-base-subtype-in" + 'R5', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-filter-base-subtype-in"}, "5.0");
  });

  it("mimetype-filter-base-subtype-in" + 'R4', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-filter-base-subtype-in"}, "4.0");
  });

  it("mimetype-filter-base-subtype-params" + 'R5', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-filter-base-subtype-params"}, "5.0");
  });

  it("mimetype-filter-base-subtype-params" + 'R4', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-filter-base-subtype-params"}, "4.0");
  });

  it("mimetype-filter-base-subtype-out" + 'R5', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-filter-base-subtype-out"}, "5.0");
  });

  it("mimetype-filter-base-subtype-out" + 'R4', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-filter-base-subtype-out"}, "4.0");
  });

  it("mimetype-filter-registered-in" + 'R5', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-filter-registered-in"}, "5.0");
  });

  it("mimetype-filter-registered-in" + 'R4', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-filter-registered-in"}, "4.0");
  });

  it("mimetype-filter-registered-params" + 'R5', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-filter-registered-params"}, "5.0");
  });

  it("mimetype-filter-registered-params" + 'R4', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-filter-registered-params"}, "4.0");
  });

  it("mimetype-filter-registered-out" + 'R5', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-filter-registered-out"}, "5.0");
  });

  it("mimetype-filter-registered-out" + 'R4', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-filter-registered-out"}, "4.0");
  });

  it("mimetype-filter-unregistered-in" + 'R5', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-filter-unregistered-in"}, "5.0");
  });

  it("mimetype-filter-unregistered-in" + 'R4', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-filter-unregistered-in"}, "4.0");
  });

  it("mimetype-filter-unregistered-out" + 'R5', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-filter-unregistered-out"}, "5.0");
  });

  it("mimetype-filter-unregistered-out" + 'R4', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-filter-unregistered-out"}, "4.0");
  });

  it("mimetype-filter-registered-params-out" + 'R5', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-filter-registered-params-out"}, "5.0");
  });

  it("mimetype-filter-registered-params-out" + 'R4', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-filter-registered-params-out"}, "4.0");
  });

  it("mimetype-filter-unregistered-params-in" + 'R5', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-filter-unregistered-params-in"}, "5.0");
  });

  it("mimetype-filter-unregistered-params-in" + 'R4', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-filter-unregistered-params-in"}, "4.0");
  });

  it("mimetype-filter-unregistered-params-out" + 'R5', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-filter-unregistered-params-out"}, "5.0");
  });

  it("mimetype-filter-unregistered-params-out" + 'R4', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-filter-unregistered-params-out"}, "4.0");
  });

  it("mimetype-expand-enumerated" + 'R5', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-expand-enumerated"}, "5.0");
  });

  it("mimetype-expand-enumerated" + 'R4', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-expand-enumerated"}, "4.0");
  });

  it("mimetype-expand-all" + 'R5', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-expand-all"}, "5.0");
  });

  it("mimetype-expand-all" + 'R4', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-expand-all"}, "4.0");
  });

  it("mimetype-expand-base" + 'R5', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-expand-base"}, "5.0");
  });

  it("mimetype-expand-base" + 'R4', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-expand-base"}, "4.0");
  });

  it("mimetype-expand-unregistered" + 'R5', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-expand-unregistered"}, "5.0");
  });

  it("mimetype-expand-unregistered" + 'R4', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-expand-unregistered"}, "4.0");
  });

  it("mimetype-expand-registered-narrow" + 'R5', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-expand-registered-narrow"}, "5.0");
  });

  it("mimetype-expand-registered-narrow" + 'R4', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-expand-registered-narrow"}, "4.0");
  });

  it("mimetype-expand-registered-too-costly" + 'R5', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-expand-registered-too-costly"}, "5.0");
  });

  it("mimetype-expand-registered-too-costly" + 'R4', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-expand-registered-too-costly"}, "4.0");
  });

  it("mimetype-expand-registered-paged" + 'R5', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-expand-registered-paged"}, "5.0");
  });

  it("mimetype-expand-registered-paged" + 'R4', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-expand-registered-paged"}, "4.0");
  });

});

describe('compare', () => {
  // Tests for candidate new 'related' operation

  it("related-all" + 'R5', async () => {
    await runTest({"suite":"compare","test":"related-all"}, "5.0");
  });

  it("related-all" + 'R4', async () => {
    await runTest({"suite":"compare","test":"related-all"}, "4.0");
  });

  it("related-active" + 'R5', async () => {
    await runTest({"suite":"compare","test":"related-active"}, "5.0");
  });

  it("related-active" + 'R4', async () => {
    await runTest({"suite":"compare","test":"related-active"}, "4.0");
  });

  it("related-inactive" + 'R5', async () => {
    await runTest({"suite":"compare","test":"related-inactive"}, "5.0");
  });

  it("related-inactive" + 'R4', async () => {
    await runTest({"suite":"compare","test":"related-inactive"}, "4.0");
  });

  it("related-enumerated" + 'R5', async () => {
    await runTest({"suite":"compare","test":"related-enumerated"}, "5.0");
  });

  it("related-enumerated" + 'R4', async () => {
    await runTest({"suite":"compare","test":"related-enumerated"}, "4.0");
  });

  it("related-is-a" + 'R5', async () => {
    await runTest({"suite":"compare","test":"related-is-a"}, "5.0");
  });

  it("related-is-a" + 'R4', async () => {
    await runTest({"suite":"compare","test":"related-is-a"}, "4.0");
  });

  it("related-regex-1" + 'R5', async () => {
    await runTest({"suite":"compare","test":"related-regex-1"}, "5.0");
  });

  it("related-regex-1" + 'R4', async () => {
    await runTest({"suite":"compare","test":"related-regex-1"}, "4.0");
  });

  it("related-regex-2" + 'R5', async () => {
    await runTest({"suite":"compare","test":"related-regex-2"}, "5.0");
  });

  it("related-regex-2" + 'R4', async () => {
    await runTest({"suite":"compare","test":"related-regex-2"}, "4.0");
  });

  it("related-lists" + 'R5', async () => {
    await runTest({"suite":"compare","test":"related-lists"}, "5.0");
  });

  it("related-lists" + 'R4', async () => {
    await runTest({"suite":"compare","test":"related-lists"}, "4.0");
  });

  it("related-lists-more" + 'R5', async () => {
    await runTest({"suite":"compare","test":"related-lists-more"}, "5.0");
  });

  it("related-lists-more" + 'R4', async () => {
    await runTest({"suite":"compare","test":"related-lists-more"}, "4.0");
  });

  it("related-lists-less" + 'R5', async () => {
    await runTest({"suite":"compare","test":"related-lists-less"}, "5.0");
  });

  it("related-lists-less" + 'R4', async () => {
    await runTest({"suite":"compare","test":"related-lists-less"}, "4.0");
  });

  it("related-lists-over" + 'R5', async () => {
    await runTest({"suite":"compare","test":"related-lists-over"}, "5.0");
  });

  it("related-lists-over" + 'R4', async () => {
    await runTest({"suite":"compare","test":"related-lists-over"}, "4.0");
  });

  it("related-lists-disj" + 'R5', async () => {
    await runTest({"suite":"compare","test":"related-lists-disj"}, "5.0");
  });

  it("related-lists-disj" + 'R4', async () => {
    await runTest({"suite":"compare","test":"related-lists-disj"}, "4.0");
  });

  it("related-systems" + 'R5', async () => {
    await runTest({"suite":"compare","test":"related-systems"}, "5.0");
  });

  it("related-systems" + 'R4', async () => {
    await runTest({"suite":"compare","test":"related-systems"}, "4.0");
  });

  it("related-systems" + 'R5', async () => {
    await runTest({"suite":"compare","test":"related-systems"}, "5.0");
  });

  it("related-systems" + 'R4', async () => {
    await runTest({"suite":"compare","test":"related-systems"}, "4.0");
  });

  it("related-systems-less" + 'R5', async () => {
    await runTest({"suite":"compare","test":"related-systems-less"}, "5.0");
  });

  it("related-systems-less" + 'R4', async () => {
    await runTest({"suite":"compare","test":"related-systems-less"}, "4.0");
  });

  it("related-systems-more" + 'R5', async () => {
    await runTest({"suite":"compare","test":"related-systems-more"}, "5.0");
  });

  it("related-systems-more" + 'R4', async () => {
    await runTest({"suite":"compare","test":"related-systems-more"}, "4.0");
  });

  it("related-system-disj" + 'R5', async () => {
    await runTest({"suite":"compare","test":"related-system-disj"}, "5.0");
  });

  it("related-system-disj" + 'R4', async () => {
    await runTest({"suite":"compare","test":"related-system-disj"}, "4.0");
  });

  it("related-system-over" + 'R5', async () => {
    await runTest({"suite":"compare","test":"related-system-over"}, "5.0");
  });

  it("related-system-over" + 'R4', async () => {
    await runTest({"suite":"compare","test":"related-system-over"}, "4.0");
  });

  it("related-filters-1" + 'R5', async () => {
    await runTest({"suite":"compare","test":"related-filters-1"}, "5.0");
  });

  it("related-filters-1" + 'R4', async () => {
    await runTest({"suite":"compare","test":"related-filters-1"}, "4.0");
  });

  it("related-filters-2" + 'R5', async () => {
    await runTest({"suite":"compare","test":"related-filters-2"}, "5.0");
  });

  it("related-filters-2" + 'R4', async () => {
    await runTest({"suite":"compare","test":"related-filters-2"}, "4.0");
  });

  it("related-filters-3" + 'R5', async () => {
    await runTest({"suite":"compare","test":"related-filters-3"}, "5.0");
  });

  it("related-filters-3" + 'R4', async () => {
    await runTest({"suite":"compare","test":"related-filters-3"}, "4.0");
  });

  it("related-mixed-1" + 'R5', async () => {
    await runTest({"suite":"compare","test":"related-mixed-1"}, "5.0");
  });

  it("related-mixed-1" + 'R4', async () => {
    await runTest({"suite":"compare","test":"related-mixed-1"}, "4.0");
  });

  it("related-mixed-1-less" + 'R5', async () => {
    await runTest({"suite":"compare","test":"related-mixed-1-less"}, "5.0");
  });

  it("related-mixed-1-less" + 'R4', async () => {
    await runTest({"suite":"compare","test":"related-mixed-1-less"}, "4.0");
  });

  it("related-mixed-1-more" + 'R5', async () => {
    await runTest({"suite":"compare","test":"related-mixed-1-more"}, "5.0");
  });

  it("related-mixed-1-more" + 'R4', async () => {
    await runTest({"suite":"compare","test":"related-mixed-1-more"}, "4.0");
  });

  it("related-mixed-1-disj" + 'R5', async () => {
    await runTest({"suite":"compare","test":"related-mixed-1-disj"}, "5.0");
  });

  it("related-mixed-1-disj" + 'R4', async () => {
    await runTest({"suite":"compare","test":"related-mixed-1-disj"}, "4.0");
  });

  it("related-mixed-1-over" + 'R5', async () => {
    await runTest({"suite":"compare","test":"related-mixed-1-over"}, "5.0");
  });

  it("related-mixed-1-over" + 'R4', async () => {
    await runTest({"suite":"compare","test":"related-mixed-1-over"}, "4.0");
  });

  it("related-filters-less" + 'R5', async () => {
    await runTest({"suite":"compare","test":"related-filters-less"}, "5.0");
  });

  it("related-filters-less" + 'R4', async () => {
    await runTest({"suite":"compare","test":"related-filters-less"}, "4.0");
  });

  it("related-filters-more" + 'R5', async () => {
    await runTest({"suite":"compare","test":"related-filters-more"}, "5.0");
  });

  it("related-filters-more" + 'R4', async () => {
    await runTest({"suite":"compare","test":"related-filters-more"}, "4.0");
  });

});

describe('bugs', () => {
  // A series of tests that deal with discovered bugs in FHIRsmith. These tests are specific to FHIRsmith - internal QA

  it("country-codes" + 'R5', async () => {
    await runTest({"suite":"bugs","test":"country-codes"}, "5.0");
  });

  it("country-codes" + 'R4', async () => {
    await runTest({"suite":"bugs","test":"country-codes"}, "4.0");
  });

  it("no-system" + 'R5', async () => {
    await runTest({"suite":"bugs","test":"no-system"}, "5.0");
  });

  it("no-system" + 'R4', async () => {
    await runTest({"suite":"bugs","test":"no-system"}, "4.0");
  });

  it("sct-parse" + 'R5', async () => {
    await runTest({"suite":"bugs","test":"sct-parse"}, "5.0");
  });

  it("sct-parse" + 'R4', async () => {
    await runTest({"suite":"bugs","test":"sct-parse"}, "4.0");
  });

  it("sct-parse-pc" + 'R5', async () => {
    await runTest({"suite":"bugs","test":"sct-parse-pc"}, "5.0");
  });

  it("sct-parse-pc" + 'R4', async () => {
    await runTest({"suite":"bugs","test":"sct-parse-pc"}, "4.0");
  });

  it("lang-case" + 'R5', async () => {
    await runTest({"suite":"bugs","test":"lang-case"}, "5.0");
  });

  it("lang-case" + 'R4', async () => {
    await runTest({"suite":"bugs","test":"lang-case"}, "4.0");
  });

  it("lang-case2" + 'R5', async () => {
    await runTest({"suite":"bugs","test":"lang-case2"}, "5.0");
  });

  it("lang-case2" + 'R4', async () => {
    await runTest({"suite":"bugs","test":"lang-case2"}, "4.0");
  });

  it("provenance" + 'R5', async () => {
    await runTest({"suite":"bugs","test":"provenance"}, "5.0");
  });

  it("provenance" + 'R4', async () => {
    await runTest({"suite":"bugs","test":"provenance"}, "4.0");
  });

  it("country-code" + 'R5', async () => {
    await runTest({"suite":"bugs","test":"country-code"}, "5.0");
  });

  it("country-code" + 'R4', async () => {
    await runTest({"suite":"bugs","test":"country-code"}, "4.0");
  });

  it("sct-msg-4" + 'R4', async () => {
    await runTest({"suite":"bugs","test":"sct-msg-4"}, "4.0");
  });

  it("sct-msg-5" + 'R5', async () => {
    await runTest({"suite":"bugs","test":"sct-msg-5"}, "5.0");
  });

  it("sct-display-1" + 'R5', async () => {
    await runTest({"suite":"bugs","test":"sct-display-1"}, "5.0");
  });

  it("sct-display-1" + 'R4', async () => {
    await runTest({"suite":"bugs","test":"sct-display-1"}, "4.0");
  });

  it("sct-display-2" + 'R5', async () => {
    await runTest({"suite":"bugs","test":"sct-display-2"}, "5.0");
  });

  it("sct-display-2" + 'R4', async () => {
    await runTest({"suite":"bugs","test":"sct-display-2"}, "4.0");
  });

  it("x12-bad" + 'R5', async () => {
    await runTest({"suite":"bugs","test":"x12-bad"}, "5.0");
  });

  it("x12-bad" + 'R4', async () => {
    await runTest({"suite":"bugs","test":"x12-bad"}, "4.0");
  });

  it("3166-a" + 'R5', async () => {
    await runTest({"suite":"bugs","test":"3166-a"}, "5.0");
  });

  it("3166-a" + 'R4', async () => {
    await runTest({"suite":"bugs","test":"3166-a"}, "4.0");
  });

  it("3166-b" + 'R5', async () => {
    await runTest({"suite":"bugs","test":"3166-b"}, "5.0");
  });

  it("3166-b" + 'R4', async () => {
    await runTest({"suite":"bugs","test":"3166-b"}, "4.0");
  });

  it("3166-c" + 'R5', async () => {
    await runTest({"suite":"bugs","test":"3166-c"}, "5.0");
  });

  it("3166-c" + 'R4', async () => {
    await runTest({"suite":"bugs","test":"3166-c"}, "4.0");
  });

  it("3166-d" + 'R5', async () => {
    await runTest({"suite":"bugs","test":"3166-d"}, "5.0");
  });

  it("3166-d" + 'R4', async () => {
    await runTest({"suite":"bugs","test":"3166-d"}, "4.0");
  });

});

describe('permutations', () => {
  // A set of permutations generated by Claude with the goal of increasing test coverage.

  it("bad-cc1-all-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"bad-cc1-all-request"}, "5.0");
  });

  it("bad-cc1-all-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"bad-cc1-all-request"}, "4.0");
  });

  it("bad-cc1-enumerated-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"bad-cc1-enumerated-request"}, "5.0");
  });

  it("bad-cc1-enumerated-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"bad-cc1-enumerated-request"}, "4.0");
  });

  it("bad-cc1-exclude-filter-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"bad-cc1-exclude-filter-request"}, "5.0");
  });

  it("bad-cc1-exclude-filter-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"bad-cc1-exclude-filter-request"}, "4.0");
  });

  it("bad-cc1-exclude-import-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"bad-cc1-exclude-import-request"}, "5.0");
  });

  it("bad-cc1-exclude-import-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"bad-cc1-exclude-import-request"}, "4.0");
  });

  it("bad-cc1-exclude-list-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"bad-cc1-exclude-list-request"}, "5.0");
  });

  it("bad-cc1-exclude-list-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"bad-cc1-exclude-list-request"}, "4.0");
  });

  it("bad-cc1-import-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"bad-cc1-import-request"}, "5.0");
  });

  it("bad-cc1-import-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"bad-cc1-import-request"}, "4.0");
  });

  it("bad-cc1-isa-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"bad-cc1-isa-request"}, "5.0");
  });

  it("bad-cc1-isa-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"bad-cc1-isa-request"}, "4.0");
  });

  it("bad-cc2-all-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"bad-cc2-all-request"}, "5.0");
  });

  it("bad-cc2-all-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"bad-cc2-all-request"}, "4.0");
  });

  it("bad-cc2-enumerated-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"bad-cc2-enumerated-request"}, "5.0");
  });

  it("bad-cc2-enumerated-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"bad-cc2-enumerated-request"}, "4.0");
  });

  it("bad-cc2-exclude-filter-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"bad-cc2-exclude-filter-request"}, "5.0");
  });

  it("bad-cc2-exclude-filter-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"bad-cc2-exclude-filter-request"}, "4.0");
  });

  it("bad-cc2-exclude-import-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"bad-cc2-exclude-import-request"}, "5.0");
  });

  it("bad-cc2-exclude-import-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"bad-cc2-exclude-import-request"}, "4.0");
  });

  it("bad-cc2-exclude-list-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"bad-cc2-exclude-list-request"}, "5.0");
  });

  it("bad-cc2-exclude-list-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"bad-cc2-exclude-list-request"}, "4.0");
  });

  it("bad-cc2-import-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"bad-cc2-import-request"}, "5.0");
  });

  it("bad-cc2-import-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"bad-cc2-import-request"}, "4.0");
  });

  it("bad-cc2-isa-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"bad-cc2-isa-request"}, "5.0");
  });

  it("bad-cc2-isa-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"bad-cc2-isa-request"}, "4.0");
  });

  it("bad-coding-all-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"bad-coding-all-request"}, "5.0");
  });

  it("bad-coding-all-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"bad-coding-all-request"}, "4.0");
  });

  it("bad-coding-enumerated-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"bad-coding-enumerated-request"}, "5.0");
  });

  it("bad-coding-enumerated-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"bad-coding-enumerated-request"}, "4.0");
  });

  it("bad-coding-exclude-filter-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"bad-coding-exclude-filter-request"}, "5.0");
  });

  it("bad-coding-exclude-filter-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"bad-coding-exclude-filter-request"}, "4.0");
  });

  it("bad-coding-exclude-import-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"bad-coding-exclude-import-request"}, "5.0");
  });

  it("bad-coding-exclude-import-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"bad-coding-exclude-import-request"}, "4.0");
  });

  it("bad-coding-exclude-list-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"bad-coding-exclude-list-request"}, "5.0");
  });

  it("bad-coding-exclude-list-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"bad-coding-exclude-list-request"}, "4.0");
  });

  it("bad-coding-import-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"bad-coding-import-request"}, "5.0");
  });

  it("bad-coding-import-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"bad-coding-import-request"}, "4.0");
  });

  it("bad-coding-isa-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"bad-coding-isa-request"}, "5.0");
  });

  it("bad-coding-isa-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"bad-coding-isa-request"}, "4.0");
  });

  it("bad-scd-all-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"bad-scd-all-request"}, "5.0");
  });

  it("bad-scd-all-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"bad-scd-all-request"}, "4.0");
  });

  it("bad-scd-enumerated-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"bad-scd-enumerated-request"}, "5.0");
  });

  it("bad-scd-enumerated-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"bad-scd-enumerated-request"}, "4.0");
  });

  it("bad-scd-exclude-filter-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"bad-scd-exclude-filter-request"}, "5.0");
  });

  it("bad-scd-exclude-filter-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"bad-scd-exclude-filter-request"}, "4.0");
  });

  it("bad-scd-exclude-import-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"bad-scd-exclude-import-request"}, "5.0");
  });

  it("bad-scd-exclude-import-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"bad-scd-exclude-import-request"}, "4.0");
  });

  it("bad-scd-exclude-list-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"bad-scd-exclude-list-request"}, "5.0");
  });

  it("bad-scd-exclude-list-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"bad-scd-exclude-list-request"}, "4.0");
  });

  it("bad-scd-import-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"bad-scd-import-request"}, "5.0");
  });

  it("bad-scd-import-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"bad-scd-import-request"}, "4.0");
  });

  it("bad-scd-isa-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"bad-scd-isa-request"}, "5.0");
  });

  it("bad-scd-isa-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"bad-scd-isa-request"}, "4.0");
  });

  it("good-cc1-all-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"good-cc1-all-request"}, "5.0");
  });

  it("good-cc1-all-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"good-cc1-all-request"}, "4.0");
  });

  it("good-cc1-enumerated-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"good-cc1-enumerated-request"}, "5.0");
  });

  it("good-cc1-enumerated-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"good-cc1-enumerated-request"}, "4.0");
  });

  it("good-cc1-exclude-filter-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"good-cc1-exclude-filter-request"}, "5.0");
  });

  it("good-cc1-exclude-filter-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"good-cc1-exclude-filter-request"}, "4.0");
  });

  it("good-cc1-exclude-import-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"good-cc1-exclude-import-request"}, "5.0");
  });

  it("good-cc1-exclude-import-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"good-cc1-exclude-import-request"}, "4.0");
  });

  it("good-cc1-exclude-list-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"good-cc1-exclude-list-request"}, "5.0");
  });

  it("good-cc1-exclude-list-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"good-cc1-exclude-list-request"}, "4.0");
  });

  it("good-cc1-import-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"good-cc1-import-request"}, "5.0");
  });

  it("good-cc1-import-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"good-cc1-import-request"}, "4.0");
  });

  it("good-cc1-isa-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"good-cc1-isa-request"}, "5.0");
  });

  it("good-cc1-isa-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"good-cc1-isa-request"}, "4.0");
  });

  it("good-cc2-all-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"good-cc2-all-request"}, "5.0");
  });

  it("good-cc2-all-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"good-cc2-all-request"}, "4.0");
  });

  it("good-cc2-enumerated-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"good-cc2-enumerated-request"}, "5.0");
  });

  it("good-cc2-enumerated-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"good-cc2-enumerated-request"}, "4.0");
  });

  it("good-cc2-exclude-filter-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"good-cc2-exclude-filter-request"}, "5.0");
  });

  it("good-cc2-exclude-filter-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"good-cc2-exclude-filter-request"}, "4.0");
  });

  it("good-cc2-exclude-import-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"good-cc2-exclude-import-request"}, "5.0");
  });

  it("good-cc2-exclude-import-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"good-cc2-exclude-import-request"}, "4.0");
  });

  it("good-cc2-exclude-list-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"good-cc2-exclude-list-request"}, "5.0");
  });

  it("good-cc2-exclude-list-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"good-cc2-exclude-list-request"}, "4.0");
  });

  it("good-cc2-import-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"good-cc2-import-request"}, "5.0");
  });

  it("good-cc2-import-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"good-cc2-import-request"}, "4.0");
  });

  it("good-cc2-isa-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"good-cc2-isa-request"}, "5.0");
  });

  it("good-cc2-isa-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"good-cc2-isa-request"}, "4.0");
  });

  it("good-coding-all-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"good-coding-all-request"}, "5.0");
  });

  it("good-coding-all-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"good-coding-all-request"}, "4.0");
  });

  it("good-coding-enumerated-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"good-coding-enumerated-request"}, "5.0");
  });

  it("good-coding-enumerated-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"good-coding-enumerated-request"}, "4.0");
  });

  it("good-coding-exclude-filter-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"good-coding-exclude-filter-request"}, "5.0");
  });

  it("good-coding-exclude-filter-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"good-coding-exclude-filter-request"}, "4.0");
  });

  it("good-coding-exclude-import-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"good-coding-exclude-import-request"}, "5.0");
  });

  it("good-coding-exclude-import-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"good-coding-exclude-import-request"}, "4.0");
  });

  it("good-coding-exclude-list-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"good-coding-exclude-list-request"}, "5.0");
  });

  it("good-coding-exclude-list-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"good-coding-exclude-list-request"}, "4.0");
  });

  it("good-coding-import-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"good-coding-import-request"}, "5.0");
  });

  it("good-coding-import-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"good-coding-import-request"}, "4.0");
  });

  it("good-coding-isa-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"good-coding-isa-request"}, "5.0");
  });

  it("good-coding-isa-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"good-coding-isa-request"}, "4.0");
  });

  it("good-scd-all-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"good-scd-all-request"}, "5.0");
  });

  it("good-scd-all-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"good-scd-all-request"}, "4.0");
  });

  it("good-scd-enumerated-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"good-scd-enumerated-request"}, "5.0");
  });

  it("good-scd-enumerated-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"good-scd-enumerated-request"}, "4.0");
  });

  it("good-scd-exclude-filter-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"good-scd-exclude-filter-request"}, "5.0");
  });

  it("good-scd-exclude-filter-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"good-scd-exclude-filter-request"}, "4.0");
  });

  it("good-scd-exclude-import-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"good-scd-exclude-import-request"}, "5.0");
  });

  it("good-scd-exclude-import-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"good-scd-exclude-import-request"}, "4.0");
  });

  it("good-scd-exclude-list-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"good-scd-exclude-list-request"}, "5.0");
  });

  it("good-scd-exclude-list-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"good-scd-exclude-list-request"}, "4.0");
  });

  it("good-scd-import-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"good-scd-import-request"}, "5.0");
  });

  it("good-scd-import-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"good-scd-import-request"}, "4.0");
  });

  it("good-scd-isa-request" + 'R5', async () => {
    await runTest({"suite":"permutations","test":"good-scd-isa-request"}, "5.0");
  });

  it("good-scd-isa-request" + 'R4', async () => {
    await runTest({"suite":"permutations","test":"good-scd-isa-request"}, "4.0");
  });

});

describe('icd-11', () => {
  // ICD-11 Test Cases. See tests/icd-11/doco.txt for what these assert and why several of them are expected to fail against the current ICD-API.

  it("term-caps" + 'R5', async () => {
    await runTest({"suite":"icd-11","test":"term-caps"}, "5.0");
  });

  it("term-caps" + 'R4', async () => {
    await runTest({"suite":"icd-11","test":"term-caps"}, "4.0");
  });

  it("lookup-mms-code" + 'R5', async () => {
    await runTest({"suite":"icd-11","test":"lookup-mms-code"}, "5.0");
  });

  it("lookup-mms-code" + 'R4', async () => {
    await runTest({"suite":"icd-11","test":"lookup-mms-code"}, "4.0");
  });

  it("lookup-mms-uri" + 'R5', async () => {
    await runTest({"suite":"icd-11","test":"lookup-mms-uri"}, "5.0");
  });

  it("lookup-mms-uri" + 'R4', async () => {
    await runTest({"suite":"icd-11","test":"lookup-mms-uri"}, "4.0");
  });

  it("lookup-mms-grouper" + 'R5', async () => {
    await runTest({"suite":"icd-11","test":"lookup-mms-grouper"}, "5.0");
  });

  it("lookup-mms-grouper" + 'R4', async () => {
    await runTest({"suite":"icd-11","test":"lookup-mms-grouper"}, "4.0");
  });

  it("lookup-mms-no-code" + 'R5', async () => {
    await runTest({"suite":"icd-11","test":"lookup-mms-no-code"}, "5.0");
  });

  it("lookup-mms-no-code" + 'R4', async () => {
    await runTest({"suite":"icd-11","test":"lookup-mms-no-code"}, "4.0");
  });

  it("lookup-mms-residual" + 'R5', async () => {
    await runTest({"suite":"icd-11","test":"lookup-mms-residual"}, "5.0");
  });

  it("lookup-mms-residual" + 'R4', async () => {
    await runTest({"suite":"icd-11","test":"lookup-mms-residual"}, "4.0");
  });

  it("lookup-mms-fr" + 'R5', async () => {
    await runTest({"suite":"icd-11","test":"lookup-mms-fr"}, "5.0");
  });

  it("lookup-mms-fr" + 'R4', async () => {
    await runTest({"suite":"icd-11","test":"lookup-mms-fr"}, "4.0");
  });

  it("lookup-icf-code" + 'R5', async () => {
    await runTest({"suite":"icd-11","test":"lookup-icf-code"}, "5.0");
  });

  it("lookup-icf-code" + 'R4', async () => {
    await runTest({"suite":"icd-11","test":"lookup-icf-code"}, "4.0");
  });

  it("lookup-foundation" + 'R5', async () => {
    await runTest({"suite":"icd-11","test":"lookup-foundation"}, "5.0");
  });

  it("lookup-foundation" + 'R4', async () => {
    await runTest({"suite":"icd-11","test":"lookup-foundation"}, "4.0");
  });

  it("lookup-bad-code" + 'R5', async () => {
    await runTest({"suite":"icd-11","test":"lookup-bad-code"}, "5.0");
  });

  it("lookup-bad-code" + 'R4', async () => {
    await runTest({"suite":"icd-11","test":"lookup-bad-code"}, "4.0");
  });

  it("lookup-bad-system" + 'R5', async () => {
    await runTest({"suite":"icd-11","test":"lookup-bad-system"}, "5.0");
  });

  it("lookup-bad-system" + 'R4', async () => {
    await runTest({"suite":"icd-11","test":"lookup-bad-system"}, "4.0");
  });

  it("lookup-bad-version" + 'R5', async () => {
    await runTest({"suite":"icd-11","test":"lookup-bad-version"}, "5.0");
  });

  it("lookup-bad-version" + 'R4', async () => {
    await runTest({"suite":"icd-11","test":"lookup-bad-version"}, "4.0");
  });

  it("lookup-foundation-bare" + 'R5', async () => {
    await runTest({"suite":"icd-11","test":"lookup-foundation-bare"}, "5.0");
  });

  it("lookup-foundation-bare" + 'R4', async () => {
    await runTest({"suite":"icd-11","test":"lookup-foundation-bare"}, "4.0");
  });

  it("lookup-foundation-residual" + 'R5', async () => {
    await runTest({"suite":"icd-11","test":"lookup-foundation-residual"}, "5.0");
  });

  it("lookup-foundation-residual" + 'R4', async () => {
    await runTest({"suite":"icd-11","test":"lookup-foundation-residual"}, "4.0");
  });

  it("lookup-bad-language" + 'R5', async () => {
    await runTest({"suite":"icd-11","test":"lookup-bad-language"}, "5.0");
  });

  it("lookup-bad-language" + 'R4', async () => {
    await runTest({"suite":"icd-11","test":"lookup-bad-language"}, "4.0");
  });

  it("lookup-pc-simple" + 'R5', async () => {
    await runTest({"suite":"icd-11","test":"lookup-pc-simple"}, "5.0");
  });

  it("lookup-pc-simple" + 'R4', async () => {
    await runTest({"suite":"icd-11","test":"lookup-pc-simple"}, "4.0");
  });

  it("lookup-pc-uri-form" + 'R5', async () => {
    await runTest({"suite":"icd-11","test":"lookup-pc-uri-form"}, "5.0");
  });

  it("lookup-pc-uri-form" + 'R4', async () => {
    await runTest({"suite":"icd-11","test":"lookup-pc-uri-form"}, "4.0");
  });

  it("lookup-pc-cluster" + 'R5', async () => {
    await runTest({"suite":"icd-11","test":"lookup-pc-cluster"}, "5.0");
  });

  it("lookup-pc-cluster" + 'R4', async () => {
    await runTest({"suite":"icd-11","test":"lookup-pc-cluster"}, "4.0");
  });

  it("lookup-pc-repeated-value" + 'R5', async () => {
    await runTest({"suite":"icd-11","test":"lookup-pc-repeated-value"}, "5.0");
  });

  it("lookup-pc-repeated-value" + 'R4', async () => {
    await runTest({"suite":"icd-11","test":"lookup-pc-repeated-value"}, "4.0");
  });

  it("lookup-pc-nondisjoint" + 'R5', async () => {
    await runTest({"suite":"icd-11","test":"lookup-pc-nondisjoint"}, "5.0");
  });

  it("lookup-pc-nondisjoint" + 'R4', async () => {
    await runTest({"suite":"icd-11","test":"lookup-pc-nondisjoint"}, "4.0");
  });

  it("lookup-pc-invalid-axis" + 'R5', async () => {
    await runTest({"suite":"icd-11","test":"lookup-pc-invalid-axis"}, "5.0");
  });

  it("lookup-pc-invalid-axis" + 'R4', async () => {
    await runTest({"suite":"icd-11","test":"lookup-pc-invalid-axis"}, "4.0");
  });

  it("lookup-pc-other" + 'R5', async () => {
    await runTest({"suite":"icd-11","test":"lookup-pc-other"}, "5.0");
  });

  it("lookup-pc-other" + 'R4', async () => {
    await runTest({"suite":"icd-11","test":"lookup-pc-other"}, "4.0");
  });

  it("lookup-icf-pc" + 'R5', async () => {
    await runTest({"suite":"icd-11","test":"lookup-icf-pc"}, "5.0");
  });

  it("lookup-icf-pc" + 'R4', async () => {
    await runTest({"suite":"icd-11","test":"lookup-icf-pc"}, "4.0");
  });

  it("lookup-icf-pc-old" + 'R5', async () => {
    await runTest({"suite":"icd-11","test":"lookup-icf-pc-old"}, "5.0");
  });

  it("lookup-icf-pc-old" + 'R4', async () => {
    await runTest({"suite":"icd-11","test":"lookup-icf-pc-old"}, "4.0");
  });

  it("cs-validate-good" + 'R5', async () => {
    await runTest({"suite":"icd-11","test":"cs-validate-good"}, "5.0");
  });

  it("cs-validate-good" + 'R4', async () => {
    await runTest({"suite":"icd-11","test":"cs-validate-good"}, "4.0");
  });

  it("cs-validate-good-display" + 'R5', async () => {
    await runTest({"suite":"icd-11","test":"cs-validate-good-display"}, "5.0");
  });

  it("cs-validate-good-display" + 'R4', async () => {
    await runTest({"suite":"icd-11","test":"cs-validate-good-display"}, "4.0");
  });

  it("cs-validate-bad-display" + 'R5', async () => {
    await runTest({"suite":"icd-11","test":"cs-validate-bad-display"}, "5.0");
  });

  it("cs-validate-bad-display" + 'R4', async () => {
    await runTest({"suite":"icd-11","test":"cs-validate-bad-display"}, "4.0");
  });

  it("cs-validate-bad-code" + 'R5', async () => {
    await runTest({"suite":"icd-11","test":"cs-validate-bad-code"}, "5.0");
  });

  it("cs-validate-bad-code" + 'R4', async () => {
    await runTest({"suite":"icd-11","test":"cs-validate-bad-code"}, "4.0");
  });

  it("cs-validate-case" + 'R5', async () => {
    await runTest({"suite":"icd-11","test":"cs-validate-case"}, "5.0");
  });

  it("cs-validate-case" + 'R4', async () => {
    await runTest({"suite":"icd-11","test":"cs-validate-case"}, "4.0");
  });

  it("cs-validate-lang" + 'R5', async () => {
    await runTest({"suite":"icd-11","test":"cs-validate-lang"}, "5.0");
  });

  it("cs-validate-lang" + 'R4', async () => {
    await runTest({"suite":"icd-11","test":"cs-validate-lang"}, "4.0");
  });

  it("cs-validate-pc" + 'R5', async () => {
    await runTest({"suite":"icd-11","test":"cs-validate-pc"}, "5.0");
  });

  it("cs-validate-pc" + 'R4', async () => {
    await runTest({"suite":"icd-11","test":"cs-validate-pc"}, "4.0");
  });

  it("cs-validate-uri" + 'R5', async () => {
    await runTest({"suite":"icd-11","test":"cs-validate-uri"}, "5.0");
  });

  it("cs-validate-uri" + 'R4', async () => {
    await runTest({"suite":"icd-11","test":"cs-validate-uri"}, "4.0");
  });

  it("expand-pcs" + 'R5', async () => {
    await runTest({"suite":"icd-11","test":"expand-pcs"}, "5.0");
  });

  it("expand-pcs" + 'R4', async () => {
    await runTest({"suite":"icd-11","test":"expand-pcs"}, "4.0");
  });

  it("expand-pcs-count" + 'R5', async () => {
    await runTest({"suite":"icd-11","test":"expand-pcs-count"}, "5.0");
  });

  it("expand-pcs-count" + 'R4', async () => {
    await runTest({"suite":"icd-11","test":"expand-pcs-count"}, "4.0");
  });

  it("expand-pcs-offset" + 'R5', async () => {
    await runTest({"suite":"icd-11","test":"expand-pcs-offset"}, "5.0");
  });

  it("expand-pcs-offset" + 'R4', async () => {
    await runTest({"suite":"icd-11","test":"expand-pcs-offset"}, "4.0");
  });

  it("expand-pcs-filter" + 'R5', async () => {
    await runTest({"suite":"icd-11","test":"expand-pcs-filter"}, "5.0");
  });

  it("expand-pcs-filter" + 'R4', async () => {
    await runTest({"suite":"icd-11","test":"expand-pcs-filter"}, "4.0");
  });

  it("expand-pcs-fr" + 'R5', async () => {
    await runTest({"suite":"icd-11","test":"expand-pcs-fr"}, "5.0");
  });

  it("expand-pcs-fr" + 'R4', async () => {
    await runTest({"suite":"icd-11","test":"expand-pcs-fr"}, "4.0");
  });

  it("expand-bad-url" + 'R5', async () => {
    await runTest({"suite":"icd-11","test":"expand-bad-url"}, "5.0");
  });

  it("expand-bad-url" + 'R4', async () => {
    await runTest({"suite":"icd-11","test":"expand-bad-url"}, "4.0");
  });

  it("expand-inline-vs" + 'R5', async () => {
    await runTest({"suite":"icd-11","test":"expand-inline-vs"}, "5.0");
  });

  it("expand-inline-vs" + 'R4', async () => {
    await runTest({"suite":"icd-11","test":"expand-inline-vs"}, "4.0");
  });

  it("expand-adhoc-enum" + 'R5', async () => {
    await runTest({"suite":"icd-11","test":"expand-adhoc-enum"}, "5.0");
  });

  it("expand-adhoc-enum" + 'R4', async () => {
    await runTest({"suite":"icd-11","test":"expand-adhoc-enum"}, "4.0");
  });

  it("expand-adhoc-enum-uri" + 'R5', async () => {
    await runTest({"suite":"icd-11","test":"expand-adhoc-enum-uri"}, "5.0");
  });

  it("expand-adhoc-enum-uri" + 'R4', async () => {
    await runTest({"suite":"icd-11","test":"expand-adhoc-enum-uri"}, "4.0");
  });

  it("expand-adhoc-isa" + 'R5', async () => {
    await runTest({"suite":"icd-11","test":"expand-adhoc-isa"}, "5.0");
  });

  it("expand-adhoc-isa" + 'R4', async () => {
    await runTest({"suite":"icd-11","test":"expand-adhoc-isa"}, "4.0");
  });

  it("expand-adhoc-isa-uri" + 'R5', async () => {
    await runTest({"suite":"icd-11","test":"expand-adhoc-isa-uri"}, "5.0");
  });

  it("expand-adhoc-isa-uri" + 'R4', async () => {
    await runTest({"suite":"icd-11","test":"expand-adhoc-isa-uri"}, "4.0");
  });

  it("expand-adhoc-bad-code" + 'R5', async () => {
    await runTest({"suite":"icd-11","test":"expand-adhoc-bad-code"}, "5.0");
  });

  it("expand-adhoc-bad-code" + 'R4', async () => {
    await runTest({"suite":"icd-11","test":"expand-adhoc-bad-code"}, "4.0");
  });

  it("expand-pcs-uri-form" + 'R5', async () => {
    await runTest({"suite":"icd-11","test":"expand-pcs-uri-form"}, "5.0");
  });

  it("expand-pcs-uri-form" + 'R4', async () => {
    await runTest({"suite":"icd-11","test":"expand-pcs-uri-form"}, "4.0");
  });

  it("expand-pcs-code-form" + 'R5', async () => {
    await runTest({"suite":"icd-11","test":"expand-pcs-code-form"}, "5.0");
  });

  it("expand-pcs-code-form" + 'R4', async () => {
    await runTest({"suite":"icd-11","test":"expand-pcs-code-form"}, "4.0");
  });

  it("vs-validate-in" + 'R5', async () => {
    await runTest({"suite":"icd-11","test":"vs-validate-in"}, "5.0");
  });

  it("vs-validate-in" + 'R4', async () => {
    await runTest({"suite":"icd-11","test":"vs-validate-in"}, "4.0");
  });

  it("vs-validate-out" + 'R5', async () => {
    await runTest({"suite":"icd-11","test":"vs-validate-out"}, "5.0");
  });

  it("vs-validate-out" + 'R4', async () => {
    await runTest({"suite":"icd-11","test":"vs-validate-out"}, "4.0");
  });

  it("vs-validate-adhoc" + 'R5', async () => {
    await runTest({"suite":"icd-11","test":"vs-validate-adhoc"}, "5.0");
  });

  it("vs-validate-adhoc" + 'R4', async () => {
    await runTest({"suite":"icd-11","test":"vs-validate-adhoc"}, "4.0");
  });

  it("vs-validate-adhoc-out" + 'R5', async () => {
    await runTest({"suite":"icd-11","test":"vs-validate-adhoc-out"}, "5.0");
  });

  it("vs-validate-adhoc-out" + 'R4', async () => {
    await runTest({"suite":"icd-11","test":"vs-validate-adhoc-out"}, "4.0");
  });

});

describe('regex-bad', () => {
  // Bad Regex - checking defences against denial of service attack. These are unusual because servers have the option to succeed, or to refuse the request

  it("expand-regex-bad" + 'R5', async () => {
    await runTest({"suite":"regex-bad","test":"expand-regex-bad"}, "5.0");
  });

  it("expand-regex-bad" + 'R4', async () => {
    await runTest({"suite":"regex-bad","test":"expand-regex-bad"}, "4.0");
  });

  it("validate-regex-bad" + 'R5', async () => {
    await runTest({"suite":"regex-bad","test":"validate-regex-bad"}, "5.0");
  });

  it("validate-regex-bad" + 'R4', async () => {
    await runTest({"suite":"regex-bad","test":"validate-regex-bad"}, "4.0");
  });

  it("expand-regex-bad-2" + 'R5', async () => {
    await runTest({"suite":"regex-bad","test":"expand-regex-bad-2"}, "5.0");
  });

  it("expand-regex-bad-2" + 'R4', async () => {
    await runTest({"suite":"regex-bad","test":"expand-regex-bad-2"}, "4.0");
  });

  it("validate-regex-bad-2" + 'R5', async () => {
    await runTest({"suite":"regex-bad","test":"validate-regex-bad-2"}, "5.0");
  });

  it("validate-regex-bad-2" + 'R4', async () => {
    await runTest({"suite":"regex-bad","test":"validate-regex-bad-2"}, "4.0");
  });

});

describe('related2', () => {
  // Tests for $compare operation - comparing two value sets to determine their relationship (equivalent, subset, superset, overlap, disjoint, unknown)

  it("related-eq-identical-def" + 'R5', async () => {
    await runTest({"suite":"related2","test":"related-eq-identical-def"}, "5.0");
  });

  it("related-eq-identical-def" + 'R4', async () => {
    await runTest({"suite":"related2","test":"related-eq-identical-def"}, "4.0");
  });

  it("related-eq-enum-reorder" + 'R5', async () => {
    await runTest({"suite":"related2","test":"related-eq-enum-reorder"}, "5.0");
  });

  it("related-eq-enum-reorder" + 'R4', async () => {
    await runTest({"suite":"related2","test":"related-eq-enum-reorder"}, "4.0");
  });

  it("related-eq-multi-include-reorder" + 'R5', async () => {
    await runTest({"suite":"related2","test":"related-eq-multi-include-reorder"}, "5.0");
  });

  it("related-eq-multi-include-reorder" + 'R4', async () => {
    await runTest({"suite":"related2","test":"related-eq-multi-include-reorder"}, "4.0");
  });

  it("related-eq-filter-vs-enum" + 'R5', async () => {
    await runTest({"suite":"related2","test":"related-eq-filter-vs-enum"}, "5.0");
  });

  it("related-eq-filter-vs-enum" + 'R4', async () => {
    await runTest({"suite":"related2","test":"related-eq-filter-vs-enum"}, "4.0");
  });

  it("related-eq-import-vs-inline" + 'R5', async () => {
    await runTest({"suite":"related2","test":"related-eq-import-vs-inline"}, "5.0");
  });

  it("related-eq-import-vs-inline" + 'R4', async () => {
    await runTest({"suite":"related2","test":"related-eq-import-vs-inline"}, "4.0");
  });

  it("related-eq-import-reorder" + 'R5', async () => {
    await runTest({"suite":"related2","test":"related-eq-import-reorder"}, "5.0");
  });

  it("related-eq-import-reorder" + 'R4', async () => {
    await runTest({"suite":"related2","test":"related-eq-import-reorder"}, "4.0");
  });

  it("related-expeq-exclude-vs-enum" + 'R5', async () => {
    await runTest({"suite":"related2","test":"related-expeq-exclude-vs-enum"}, "5.0");
  });

  it("related-expeq-exclude-vs-enum" + 'R4', async () => {
    await runTest({"suite":"related2","test":"related-expeq-exclude-vs-enum"}, "4.0");
  });

  it("related-expeq-exclude-partial" + 'R5', async () => {
    await runTest({"suite":"related2","test":"related-expeq-exclude-partial"}, "5.0");
  });

  it("related-expeq-exclude-partial" + 'R4', async () => {
    await runTest({"suite":"related2","test":"related-expeq-exclude-partial"}, "4.0");
  });

  it("related-sub-branch-vs-root" + 'R5', async () => {
    await runTest({"suite":"related2","test":"related-sub-branch-vs-root"}, "5.0");
  });

  it("related-sub-branch-vs-root" + 'R4', async () => {
    await runTest({"suite":"related2","test":"related-sub-branch-vs-root"}, "4.0");
  });

  it("related-sub-enum-vs-filter" + 'R5', async () => {
    await runTest({"suite":"related2","test":"related-sub-enum-vs-filter"}, "5.0");
  });

  it("related-sub-enum-vs-filter" + 'R4', async () => {
    await runTest({"suite":"related2","test":"related-sub-enum-vs-filter"}, "4.0");
  });

  it("related-sub-base-vs-import-plus" + 'R5', async () => {
    await runTest({"suite":"related2","test":"related-sub-base-vs-import-plus"}, "5.0");
  });

  it("related-sub-base-vs-import-plus" + 'R4', async () => {
    await runTest({"suite":"related2","test":"related-sub-base-vs-import-plus"}, "4.0");
  });

  it("related-sub-leaf-vs-subtree" + 'R5', async () => {
    await runTest({"suite":"related2","test":"related-sub-leaf-vs-subtree"}, "5.0");
  });

  it("related-sub-leaf-vs-subtree" + 'R4', async () => {
    await runTest({"suite":"related2","test":"related-sub-leaf-vs-subtree"}, "4.0");
  });

  it("related-super-root-vs-branch" + 'R5', async () => {
    await runTest({"suite":"related2","test":"related-super-root-vs-branch"}, "5.0");
  });

  it("related-super-root-vs-branch" + 'R4', async () => {
    await runTest({"suite":"related2","test":"related-super-root-vs-branch"}, "4.0");
  });

  it("related-expsub-exclude-narrower" + 'R5', async () => {
    await runTest({"suite":"related2","test":"related-expsub-exclude-narrower"}, "5.0");
  });

  it("related-expsub-exclude-narrower" + 'R4', async () => {
    await runTest({"suite":"related2","test":"related-expsub-exclude-narrower"}, "4.0");
  });

  it("related-disj-diff-systems" + 'R5', async () => {
    await runTest({"suite":"related2","test":"related-disj-diff-systems"}, "5.0");
  });

  it("related-disj-diff-systems" + 'R4', async () => {
    await runTest({"suite":"related2","test":"related-disj-diff-systems"}, "4.0");
  });

  it("related-disj-diff-branches" + 'R5', async () => {
    await runTest({"suite":"related2","test":"related-disj-diff-branches"}, "5.0");
  });

  it("related-disj-diff-branches" + 'R4', async () => {
    await runTest({"suite":"related2","test":"related-disj-diff-branches"}, "4.0");
  });

  it("related-disj-enum-no-intersection" + 'R5', async () => {
    await runTest({"suite":"related2","test":"related-disj-enum-no-intersection"}, "5.0");
  });

  it("related-disj-enum-no-intersection" + 'R4', async () => {
    await runTest({"suite":"related2","test":"related-disj-enum-no-intersection"}, "4.0");
  });

  it("related-disj-multi-system" + 'R5', async () => {
    await runTest({"suite":"related2","test":"related-disj-multi-system"}, "5.0");
  });

  it("related-disj-multi-system" + 'R4', async () => {
    await runTest({"suite":"related2","test":"related-disj-multi-system"}, "4.0");
  });

  it("related-ov-enum-partial" + 'R5', async () => {
    await runTest({"suite":"related2","test":"related-ov-enum-partial"}, "5.0");
  });

  it("related-ov-enum-partial" + 'R4', async () => {
    await runTest({"suite":"related2","test":"related-ov-enum-partial"}, "4.0");
  });

  it("related-ov-filter-vs-enum" + 'R5', async () => {
    await runTest({"suite":"related2","test":"related-ov-filter-vs-enum"}, "5.0");
  });

  it("related-ov-filter-vs-enum" + 'R4', async () => {
    await runTest({"suite":"related2","test":"related-ov-filter-vs-enum"}, "4.0");
  });

  it("related-ov-multi-include-partial" + 'R5', async () => {
    await runTest({"suite":"related2","test":"related-ov-multi-include-partial"}, "5.0");
  });

  it("related-ov-multi-include-partial" + 'R4', async () => {
    await runTest({"suite":"related2","test":"related-ov-multi-include-partial"}, "4.0");
  });

  it("related-ov-import-partial" + 'R5', async () => {
    await runTest({"suite":"related2","test":"related-ov-import-partial"}, "5.0");
  });

  it("related-ov-import-partial" + 'R4', async () => {
    await runTest({"suite":"related2","test":"related-ov-import-partial"}, "4.0");
  });

  it("related-ov-cross-system" + 'R5', async () => {
    await runTest({"suite":"related2","test":"related-ov-cross-system"}, "5.0");
  });

  it("related-ov-cross-system" + 'R4', async () => {
    await runTest({"suite":"related2","test":"related-ov-cross-system"}, "4.0");
  });

  it("related-ov-exclude-partial" + 'R5', async () => {
    await runTest({"suite":"related2","test":"related-ov-exclude-partial"}, "5.0");
  });

  it("related-ov-exclude-partial" + 'R4', async () => {
    await runTest({"suite":"related2","test":"related-ov-exclude-partial"}, "4.0");
  });

  it("related-unk-snomed-both-filter" + 'R5', async () => {
    await runTest({"suite":"related2","test":"related-unk-snomed-both-filter"}, "5.0");
  });

  it("related-unk-snomed-both-filter" + 'R4', async () => {
    await runTest({"suite":"related2","test":"related-unk-snomed-both-filter"}, "4.0");
  });

  it("related-unk-snomed-filter-vs-enum" + 'R5', async () => {
    await runTest({"suite":"related2","test":"related-unk-snomed-filter-vs-enum"}, "5.0");
  });

  it("related-unk-snomed-filter-vs-enum" + 'R4', async () => {
    await runTest({"suite":"related2","test":"related-unk-snomed-filter-vs-enum"}, "4.0");
  });

  it("related-unk-unknown-system" + 'R5', async () => {
    await runTest({"suite":"related2","test":"related-unk-unknown-system"}, "5.0");
  });

  it("related-unk-unknown-system" + 'R4', async () => {
    await runTest({"suite":"related2","test":"related-unk-unknown-system"}, "4.0");
  });

  it("related-ver-same-def-diff-cs-version" + 'R5', async () => {
    await runTest({"suite":"related2","test":"related-ver-same-def-diff-cs-version"}, "5.0");
  });

  it("related-ver-same-def-diff-cs-version" + 'R4', async () => {
    await runTest({"suite":"related2","test":"related-ver-same-def-diff-cs-version"}, "4.0");
  });

  it("related-ver-all-diff-cs-version" + 'R5', async () => {
    await runTest({"suite":"related2","test":"related-ver-all-diff-cs-version"}, "5.0");
  });

  it("related-ver-all-diff-cs-version" + 'R4', async () => {
    await runTest({"suite":"related2","test":"related-ver-all-diff-cs-version"}, "4.0");
  });

  it("related-ver-branch-diff-cs-version" + 'R5', async () => {
    await runTest({"suite":"related2","test":"related-ver-branch-diff-cs-version"}, "5.0");
  });

  it("related-ver-branch-diff-cs-version" + 'R4', async () => {
    await runTest({"suite":"related2","test":"related-ver-branch-diff-cs-version"}, "4.0");
  });

  it("related-ver-unversioned-vs-pinned" + 'R5', async () => {
    await runTest({"suite":"related2","test":"related-ver-unversioned-vs-pinned"}, "5.0");
  });

  it("related-ver-unversioned-vs-pinned" + 'R4', async () => {
    await runTest({"suite":"related2","test":"related-ver-unversioned-vs-pinned"}, "4.0");
  });

  it("related-ver-same-vs-diff-version" + 'R5', async () => {
    await runTest({"suite":"related2","test":"related-ver-same-vs-diff-version"}, "5.0");
  });

  it("related-ver-same-vs-diff-version" + 'R4', async () => {
    await runTest({"suite":"related2","test":"related-ver-same-vs-diff-version"}, "4.0");
  });

  it("related-ver-import-version-cascade" + 'R5', async () => {
    await runTest({"suite":"related2","test":"related-ver-import-version-cascade"}, "5.0");
  });

  it("related-ver-import-version-cascade" + 'R4', async () => {
    await runTest({"suite":"related2","test":"related-ver-import-version-cascade"}, "4.0");
  });

});

describe('langcodes', () => {
  // IETF language code (BCP-47) test cases

  it("validate-lang-base" + 'R5', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-base"}, "5.0");
  });

  it("validate-lang-base" + 'R4', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-base"}, "4.0");
  });

  it("validate-lang-region" + 'R5', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-region"}, "5.0");
  });

  it("validate-lang-region" + 'R4', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-region"}, "4.0");
  });

  it("validate-lang-script" + 'R5', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-script"}, "5.0");
  });

  it("validate-lang-script" + 'R4', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-script"}, "4.0");
  });

  it("validate-lang-script-region" + 'R5', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-script-region"}, "5.0");
  });

  it("validate-lang-script-region" + 'R4', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-script-region"}, "4.0");
  });

  it("validate-lang-region-private" + 'R5', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-region-private"}, "5.0");
  });

  it("validate-lang-region-private" + 'R4', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-region-private"}, "4.0");
  });

  it("validate-lang-grandfathered" + 'R5', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-grandfathered"}, "5.0");
  });

  it("validate-lang-grandfathered" + 'R4', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-grandfathered"}, "4.0");
  });

  it("validate-lang-base-bad" + 'R5', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-base-bad"}, "5.0");
  });

  it("validate-lang-base-bad" + 'R4', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-base-bad"}, "4.0");
  });

  it("validate-lang-region-bad" + 'R5', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-region-bad"}, "5.0");
  });

  it("validate-lang-region-bad" + 'R4', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-region-bad"}, "4.0");
  });

  it("validate-lang-script-bad" + 'R5', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-script-bad"}, "5.0");
  });

  it("validate-lang-script-bad" + 'R4', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-script-bad"}, "4.0");
  });

  it("validate-lang-extlang-prefix-bad" + 'R5', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-extlang-prefix-bad"}, "5.0");
  });

  it("validate-lang-extlang-prefix-bad" + 'R4', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-extlang-prefix-bad"}, "4.0");
  });

  it("validate-lang-variant-prefix-bad" + 'R5', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-variant-prefix-bad"}, "5.0");
  });

  it("validate-lang-variant-prefix-bad" + 'R4', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-variant-prefix-bad"}, "4.0");
  });

  it("validate-lang-case-language" + 'R5', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-case-language"}, "5.0");
  });

  it("validate-lang-case-language" + 'R4', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-case-language"}, "4.0");
  });

  it("validate-lang-case-region" + 'R5', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-case-region"}, "5.0");
  });

  it("validate-lang-case-region" + 'R4', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-case-region"}, "4.0");
  });

  it("validate-lang-case-all" + 'R5', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-case-all"}, "5.0");
  });

  it("validate-lang-case-all" + 'R4', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-case-all"}, "4.0");
  });

  it("subsumes-lang-base-region" + 'R5', async () => {
    await runTest({"suite":"langcodes","test":"subsumes-lang-base-region"}, "5.0");
  });

  it("subsumes-lang-base-region" + 'R4', async () => {
    await runTest({"suite":"langcodes","test":"subsumes-lang-base-region"}, "4.0");
  });

  it("subsumes-lang-reverse" + 'R5', async () => {
    await runTest({"suite":"langcodes","test":"subsumes-lang-reverse"}, "5.0");
  });

  it("subsumes-lang-reverse" + 'R4', async () => {
    await runTest({"suite":"langcodes","test":"subsumes-lang-reverse"}, "4.0");
  });

  it("subsumes-lang-equivalent" + 'R5', async () => {
    await runTest({"suite":"langcodes","test":"subsumes-lang-equivalent"}, "5.0");
  });

  it("subsumes-lang-equivalent" + 'R4', async () => {
    await runTest({"suite":"langcodes","test":"subsumes-lang-equivalent"}, "4.0");
  });

  it("subsumes-lang-script" + 'R5', async () => {
    await runTest({"suite":"langcodes","test":"subsumes-lang-script"}, "5.0");
  });

  it("subsumes-lang-script" + 'R4', async () => {
    await runTest({"suite":"langcodes","test":"subsumes-lang-script"}, "4.0");
  });

  it("subsumes-lang-skipped-script" + 'R5', async () => {
    await runTest({"suite":"langcodes","test":"subsumes-lang-skipped-script"}, "5.0");
  });

  it("subsumes-lang-skipped-script" + 'R4', async () => {
    await runTest({"suite":"langcodes","test":"subsumes-lang-skipped-script"}, "4.0");
  });

  it("subsumes-lang-variant" + 'R5', async () => {
    await runTest({"suite":"langcodes","test":"subsumes-lang-variant"}, "5.0");
  });

  it("subsumes-lang-variant" + 'R4', async () => {
    await runTest({"suite":"langcodes","test":"subsumes-lang-variant"}, "4.0");
  });

  it("subsumes-lang-siblings" + 'R5', async () => {
    await runTest({"suite":"langcodes","test":"subsumes-lang-siblings"}, "5.0");
  });

  it("subsumes-lang-siblings" + 'R4', async () => {
    await runTest({"suite":"langcodes","test":"subsumes-lang-siblings"}, "4.0");
  });

  it("subsumes-lang-scripts" + 'R5', async () => {
    await runTest({"suite":"langcodes","test":"subsumes-lang-scripts"}, "5.0");
  });

  it("subsumes-lang-scripts" + 'R4', async () => {
    await runTest({"suite":"langcodes","test":"subsumes-lang-scripts"}, "4.0");
  });

  it("subsumes-lang-crossed" + 'R5', async () => {
    await runTest({"suite":"langcodes","test":"subsumes-lang-crossed"}, "5.0");
  });

  it("subsumes-lang-crossed" + 'R4', async () => {
    await runTest({"suite":"langcodes","test":"subsumes-lang-crossed"}, "4.0");
  });

  it("subsumes-lang-unrelated" + 'R5', async () => {
    await runTest({"suite":"langcodes","test":"subsumes-lang-unrelated"}, "5.0");
  });

  it("subsumes-lang-unrelated" + 'R4', async () => {
    await runTest({"suite":"langcodes","test":"subsumes-lang-unrelated"}, "4.0");
  });

  it("subsumes-lang-case" + 'R5', async () => {
    await runTest({"suite":"langcodes","test":"subsumes-lang-case"}, "5.0");
  });

  it("subsumes-lang-case" + 'R4', async () => {
    await runTest({"suite":"langcodes","test":"subsumes-lang-case"}, "4.0");
  });

  it("subsumes-lang-grandfathered" + 'R5', async () => {
    await runTest({"suite":"langcodes","test":"subsumes-lang-grandfathered"}, "5.0");
  });

  it("subsumes-lang-grandfathered" + 'R4', async () => {
    await runTest({"suite":"langcodes","test":"subsumes-lang-grandfathered"}, "4.0");
  });

  it("validate-lang-filter-language-in" + 'R5', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-filter-language-in"}, "5.0");
  });

  it("validate-lang-filter-language-in" + 'R4', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-filter-language-in"}, "4.0");
  });

  it("validate-lang-filter-language-out" + 'R5', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-filter-language-out"}, "5.0");
  });

  it("validate-lang-filter-language-out" + 'R4', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-filter-language-out"}, "4.0");
  });

  it("validate-lang-filter-region-in" + 'R5', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-filter-region-in"}, "5.0");
  });

  it("validate-lang-filter-region-in" + 'R4', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-filter-region-in"}, "4.0");
  });

  it("validate-lang-filter-region-out" + 'R5', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-filter-region-out"}, "5.0");
  });

  it("validate-lang-filter-region-out" + 'R4', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-filter-region-out"}, "4.0");
  });

  it("validate-lang-filter-both-in" + 'R5', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-filter-both-in"}, "5.0");
  });

  it("validate-lang-filter-both-in" + 'R4', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-filter-both-in"}, "4.0");
  });

  it("validate-lang-filter-both-out" + 'R5', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-filter-both-out"}, "5.0");
  });

  it("validate-lang-filter-both-out" + 'R4', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-filter-both-out"}, "4.0");
  });

  it("validate-lang-filter-script-in" + 'R5', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-filter-script-in"}, "5.0");
  });

  it("validate-lang-filter-script-in" + 'R4', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-filter-script-in"}, "4.0");
  });

  it("validate-lang-filter-script-out" + 'R5', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-filter-script-out"}, "5.0");
  });

  it("validate-lang-filter-script-out" + 'R4', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-filter-script-out"}, "4.0");
  });

  it("validate-lang-filter-language-bare" + 'R5', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-filter-language-bare"}, "5.0");
  });

  it("validate-lang-filter-language-bare" + 'R4', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-filter-language-bare"}, "4.0");
  });

  it("validate-lang-filter-region-absent" + 'R5', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-filter-region-absent"}, "5.0");
  });

  it("validate-lang-filter-region-absent" + 'R4', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-filter-region-absent"}, "4.0");
  });

  it("validate-lang-filter-script-absent" + 'R5', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-filter-script-absent"}, "5.0");
  });

  it("validate-lang-filter-script-absent" + 'R4', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-filter-script-absent"}, "4.0");
  });

  it("validate-lang-filter-both-absent" + 'R5', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-filter-both-absent"}, "5.0");
  });

  it("validate-lang-filter-both-absent" + 'R4', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-filter-both-absent"}, "4.0");
  });

  it("expand-lang-language" + 'R5', async () => {
    await runTest({"suite":"langcodes","test":"expand-lang-language"}, "5.0");
  });

  it("expand-lang-language" + 'R4', async () => {
    await runTest({"suite":"langcodes","test":"expand-lang-language"}, "4.0");
  });

  it("expand-lang-both" + 'R5', async () => {
    await runTest({"suite":"langcodes","test":"expand-lang-both"}, "5.0");
  });

  it("expand-lang-both" + 'R4', async () => {
    await runTest({"suite":"langcodes","test":"expand-lang-both"}, "4.0");
  });

  it("expand-lang-region" + 'R5', async () => {
    await runTest({"suite":"langcodes","test":"expand-lang-region"}, "5.0");
  });

  it("expand-lang-region" + 'R4', async () => {
    await runTest({"suite":"langcodes","test":"expand-lang-region"}, "4.0");
  });

  it("expand-lang-script" + 'R5', async () => {
    await runTest({"suite":"langcodes","test":"expand-lang-script"}, "5.0");
  });

  it("expand-lang-script" + 'R4', async () => {
    await runTest({"suite":"langcodes","test":"expand-lang-script"}, "4.0");
  });

  it("expand-langcodes-all" + 'R5', async () => {
    await runTest({"suite":"langcodes","test":"expand-langcodes-all"}, "5.0");
  });

  it("expand-langcodes-all" + 'R4', async () => {
    await runTest({"suite":"langcodes","test":"expand-langcodes-all"}, "4.0");
  });

});

describe('cached (forced caching)', () => {
  beforeAll(() => { setForcedCaching(true); });
  afterAll(() => { setForcedCaching(false); });

describe('metadata', () => {
  // tests for minimal requirements for metadata statements

  it("metadata" + 'R5-cached', async () => {
    await runTest({"suite":"metadata","test":"metadata"}, "5.0");
  });

  it("term-caps" + 'R5-cached', async () => {
    await runTest({"suite":"metadata","test":"term-caps"}, "5.0");
  });

});

describe('properties', () => {
  // Testing the ValueSet.compose.property element

  it("expand-with-valueset.compose.property-all-properties-wildcard" + 'R5-cached', async () => {
    await runTest({"suite":"properties","test":"expand-with-valueset.compose.property-all-properties-wildcard"}, "5.0");
  });

  it("expand-with-valueset.compose.property-all-properties-enums" + 'R5-cached', async () => {
    await runTest({"suite":"properties","test":"expand-with-valueset.compose.property-all-properties-enums"}, "5.0");
  });

});

describe('simple-cases', () => {
  // basic tests, setting up for the API tests to come

  it("simple-expand-all" + 'R5-cached', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-all"}, "5.0");
  });

  it("simple-expand-active" + 'R5-cached', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-active"}, "5.0");
  });

  it("simple-expand-inactive" + 'R5-cached', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-inactive"}, "5.0");
  });

  it("simple-expand-enum" + 'R5-cached', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-enum"}, "5.0");
  });

  it("simple-expand-enum-bad" + 'R5-cached', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-enum-bad"}, "5.0");
  });

  it("simple-expand-isa" + 'R5-cached', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-isa"}, "5.0");
  });

  it("simple-expand-child-of" + 'R5-cached', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-child-of"}, "5.0");
  });

  it("simple-expand-isa-o2" + 'R5-cached', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-isa-o2"}, "5.0");
  });

  it("simple-expand-isa-c2" + 'R5-cached', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-isa-c2"}, "5.0");
  });

  it("simple-expand-isa-o2c2" + 'R5-cached', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-isa-o2c2"}, "5.0");
  });

  it("simple-expand-prop" + 'R5-cached', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-prop"}, "5.0");
  });

  it("simple-expand-repeating-prop" + 'R5-cached', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-repeating-prop"}, "5.0");
  });

  it("simple-expand-repeating-prop-values" + 'R5-cached', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-repeating-prop-values"}, "5.0");
  });

  it("simple-expand-regex" + 'R5-cached', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-regex"}, "5.0");
  });

  it("simple-expand-regex2" + 'R5-cached', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-regex2"}, "5.0");
  });

  it("simple-expand-regexp-prop" + 'R5-cached', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-regexp-prop"}, "5.0");
  });

  it("simple-expand-regex-none" + 'R5-cached', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-regex-none"}, "5.0");
  });

  it("simple-lookup-1" + 'R5-cached', async () => {
    await runTest({"suite":"simple-cases","test":"simple-lookup-1"}, "5.0");
  });

  it("simple-lookup-2" + 'R5-cached', async () => {
    await runTest({"suite":"simple-cases","test":"simple-lookup-2"}, "5.0");
  });

  it("simple-expand-all-count" + 'R5-cached', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-all-count"}, "5.0");
  });

  it("simple-expand-contained" + 'R5-cached', async () => {
    await runTest({"suite":"simple-cases","test":"simple-expand-contained"}, "5.0");
  });

  it("simple-subsumes-parent" + 'R5-cached', async () => {
    await runTest({"suite":"simple-cases","test":"simple-subsumes-parent"}, "5.0");
  });

  it("simple-subsumes-child" + 'R5-cached', async () => {
    await runTest({"suite":"simple-cases","test":"simple-subsumes-child"}, "5.0");
  });

  it("simple-subsumes-equivalent" + 'R5-cached', async () => {
    await runTest({"suite":"simple-cases","test":"simple-subsumes-equivalent"}, "5.0");
  });

  it("simple-subsumes-transitive" + 'R5-cached', async () => {
    await runTest({"suite":"simple-cases","test":"simple-subsumes-transitive"}, "5.0");
  });

  it("simple-subsumes-siblings" + 'R5-cached', async () => {
    await runTest({"suite":"simple-cases","test":"simple-subsumes-siblings"}, "5.0");
  });

  it("simple-subsumes-unrelated" + 'R5-cached', async () => {
    await runTest({"suite":"simple-cases","test":"simple-subsumes-unrelated"}, "5.0");
  });

  it("simple-subsumes-root" + 'R5-cached', async () => {
    await runTest({"suite":"simple-cases","test":"simple-subsumes-root"}, "5.0");
  });

  it("simple-subsumes-unknown-code" + 'R5-cached', async () => {
    await runTest({"suite":"simple-cases","test":"simple-subsumes-unknown-code"}, "5.0");
  });

  it("simple-subsumes-parent-coding" + 'R5-cached', async () => {
    await runTest({"suite":"simple-cases","test":"simple-subsumes-parent-coding"}, "5.0");
  });

  it("simple-subsumes-child-coding" + 'R5-cached', async () => {
    await runTest({"suite":"simple-cases","test":"simple-subsumes-child-coding"}, "5.0");
  });

  it("simple-subsumes-equivalent-coding" + 'R5-cached', async () => {
    await runTest({"suite":"simple-cases","test":"simple-subsumes-equivalent-coding"}, "5.0");
  });

  it("simple-subsumes-transitive-coding" + 'R5-cached', async () => {
    await runTest({"suite":"simple-cases","test":"simple-subsumes-transitive-coding"}, "5.0");
  });

  it("simple-subsumes-siblings-coding" + 'R5-cached', async () => {
    await runTest({"suite":"simple-cases","test":"simple-subsumes-siblings-coding"}, "5.0");
  });

  it("simple-subsumes-unrelated-coding" + 'R5-cached', async () => {
    await runTest({"suite":"simple-cases","test":"simple-subsumes-unrelated-coding"}, "5.0");
  });

  it("simple-subsumes-root-coding" + 'R5-cached', async () => {
    await runTest({"suite":"simple-cases","test":"simple-subsumes-root-coding"}, "5.0");
  });

  it("simple-subsumes-unknown-code-coding" + 'R5-cached', async () => {
    await runTest({"suite":"simple-cases","test":"simple-subsumes-unknown-code-coding"}, "5.0");
  });

});

describe('parameters', () => {
  // Testing out the various expansion parameters that the IG publisher makes use of

  it("parameters-expand-all-hierarchy" + 'R5-cached', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-all-hierarchy"}, "5.0");
  });

  it("parameters-expand-enum-hierarchy" + 'R5-cached', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-enum-hierarchy"}, "5.0");
  });

  it("parameters-expand-isa-hierarchy" + 'R5-cached', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-isa-hierarchy"}, "5.0");
  });

  it("parameters-expand-all-active" + 'R5-cached', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-all-active"}, "5.0");
  });

  it("parameters-expand-active-active" + 'R5-cached', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-active-active"}, "5.0");
  });

  it("parameters-expand-inactive-active" + 'R5-cached', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-inactive-active"}, "5.0");
  });

  it("parameters-expand-enum-active" + 'R5-cached', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-enum-active"}, "5.0");
  });

  it("parameters-expand-isa-active" + 'R5-cached', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-isa-active"}, "5.0");
  });

  it("parameters-expand-all-inactive" + 'R5-cached', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-all-inactive"}, "5.0");
  });

  it("parameters-expand-active-inactive" + 'R5-cached', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-active-inactive"}, "5.0");
  });

  it("parameters-expand-inactive-inactive" + 'R5-cached', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-inactive-inactive"}, "5.0");
  });

  it("parameters-expand-enum-inactive" + 'R5-cached', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-enum-inactive"}, "5.0");
  });

  it("parameters-expand-isa-inactive" + 'R5-cached', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-isa-inactive"}, "5.0");
  });

  it("parameters-expand-all-designations" + 'R5-cached', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-all-designations"}, "5.0");
  });

  it("parameters-expand-enum-designations" + 'R5-cached', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-enum-designations"}, "5.0");
  });

  it("parameters-expand-isa-designations" + 'R5-cached', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-isa-designations"}, "5.0");
  });

  it("parameters-expand-all-definitions" + 'R5-cached', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-all-definitions"}, "5.0");
  });

  it("parameters-expand-enum-definitions" + 'R5-cached', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-enum-definitions"}, "5.0");
  });

  it("parameters-expand-isa-definitions" + 'R5-cached', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-isa-definitions"}, "5.0");
  });

  it("parameters-expand-all-definitions2" + 'R5-cached', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-all-definitions2"}, "5.0");
  });

  it("parameters-expand-enum-definitions2" + 'R5-cached', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-enum-definitions2"}, "5.0");
  });

  it("parameters-expand-enum-definitions3" + 'R5-cached', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-enum-definitions3"}, "5.0");
  });

  it("parameters-expand-isa-definitions2" + 'R5-cached', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-isa-definitions2"}, "5.0");
  });

  it("parameters-expand-all-property" + 'R5-cached', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-all-property"}, "5.0");
  });

  it("parameters-expand-enum-property" + 'R5-cached', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-enum-property"}, "5.0");
  });

  it("parameters-expand-isa-property" + 'R5-cached', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-isa-property"}, "5.0");
  });

  it("parameters-expand-supplement-none" + 'R5-cached', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-supplement-none"}, "5.0");
  });

  it("parameters-expand-supplement-good" + 'R5-cached', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-supplement-good"}, "5.0");
  });

  it("parameters-expand-supplement-bad" + 'R5-cached', async () => {
    await runTest({"suite":"parameters","test":"parameters-expand-supplement-bad"}, "5.0");
  });

  it("parameters-validate-supplement-none" + 'R5-cached', async () => {
    await runTest({"suite":"parameters","test":"parameters-validate-supplement-none"}, "5.0");
  });

  it("parameters-validate-supplement-good" + 'R5-cached', async () => {
    await runTest({"suite":"parameters","test":"parameters-validate-supplement-good"}, "5.0");
  });

  it("parameters-validate-supplement-bad" + 'R5-cached', async () => {
    await runTest({"suite":"parameters","test":"parameters-validate-supplement-bad"}, "5.0");
  });

  it("parameters-lookup-supplement-none" + 'R5-cached', async () => {
    await runTest({"suite":"parameters","test":"parameters-lookup-supplement-none"}, "5.0");
  });

  it("parameters-lookup-supplement-good" + 'R5-cached', async () => {
    await runTest({"suite":"parameters","test":"parameters-lookup-supplement-good"}, "5.0");
  });

  it("parameters-lookup-supplement-bad" + 'R5-cached', async () => {
    await runTest({"suite":"parameters","test":"parameters-lookup-supplement-bad"}, "5.0");
  });

});

describe('language', () => {
  // Testing returning language by request, getting the right designation

  it("language-echo-en-none" + 'R5-cached', async () => {
    await runTest({"suite":"language","test":"language-echo-en-none"}, "5.0");
  });

  it("language-echo-de-none" + 'R5-cached', async () => {
    await runTest({"suite":"language","test":"language-echo-de-none"}, "5.0");
  });

  it("language-echo-en-multi-none" + 'R5-cached', async () => {
    await runTest({"suite":"language","test":"language-echo-en-multi-none"}, "5.0");
  });

  it("language-echo-de-multi-none" + 'R5-cached', async () => {
    await runTest({"suite":"language","test":"language-echo-de-multi-none"}, "5.0");
  });

  it("language-echo-en-en-param" + 'R5-cached', async () => {
    await runTest({"suite":"language","test":"language-echo-en-en-param"}, "5.0");
  });

  it("language-echo-en-en-vs" + 'R5-cached', async () => {
    await runTest({"suite":"language","test":"language-echo-en-en-vs"}, "5.0");
  });

  it("language-echo-en-en-header" + 'R5-cached', async () => {
    await runTest({"suite":"language","test":"language-echo-en-en-header"}, "5.0");
  });

  it("language-echo-en-en-vslang" + 'R5-cached', async () => {
    await runTest({"suite":"language","test":"language-echo-en-en-vslang"}, "5.0");
  });

  it("language-echo-en-en-mixed" + 'R5-cached', async () => {
    await runTest({"suite":"language","test":"language-echo-en-en-mixed"}, "5.0");
  });

  it("language-echo-de-de-param" + 'R5-cached', async () => {
    await runTest({"suite":"language","test":"language-echo-de-de-param"}, "5.0");
  });

  it("language-echo-de-de-vs" + 'R5-cached', async () => {
    await runTest({"suite":"language","test":"language-echo-de-de-vs"}, "5.0");
  });

  it("language-echo-de-de-header" + 'R5-cached', async () => {
    await runTest({"suite":"language","test":"language-echo-de-de-header"}, "5.0");
  });

  it("language-echo-en-multi-en-param" + 'R5-cached', async () => {
    await runTest({"suite":"language","test":"language-echo-en-multi-en-param"}, "5.0");
  });

  it("language-echo-en-multi-en-vs" + 'R5-cached', async () => {
    await runTest({"suite":"language","test":"language-echo-en-multi-en-vs"}, "5.0");
  });

  it("language-echo-en-multi-en-header" + 'R5-cached', async () => {
    await runTest({"suite":"language","test":"language-echo-en-multi-en-header"}, "5.0");
  });

  it("language-echo-de-multi-de-param" + 'R5-cached', async () => {
    await runTest({"suite":"language","test":"language-echo-de-multi-de-param"}, "5.0");
  });

  it("language-echo-de-multi-de-vs" + 'R5-cached', async () => {
    await runTest({"suite":"language","test":"language-echo-de-multi-de-vs"}, "5.0");
  });

  it("language-echo-de-multi-de-header" + 'R5-cached', async () => {
    await runTest({"suite":"language","test":"language-echo-de-multi-de-header"}, "5.0");
  });

  it("language-xform-en-multi-de-soft" + 'R5-cached', async () => {
    await runTest({"suite":"language","test":"language-xform-en-multi-de-soft"}, "5.0");
  });

  it("language-xform-en-multi-de-hard" + 'R5-cached', async () => {
    await runTest({"suite":"language","test":"language-xform-en-multi-de-hard"}, "5.0");
  });

  it("language-xform-en-multi-de-default" + 'R5-cached', async () => {
    await runTest({"suite":"language","test":"language-xform-en-multi-de-default"}, "5.0");
  });

  it("language-xform-de-multi-en-soft" + 'R5-cached', async () => {
    await runTest({"suite":"language","test":"language-xform-de-multi-en-soft"}, "5.0");
  });

  it("language-xform-de-multi-en-hard" + 'R5-cached', async () => {
    await runTest({"suite":"language","test":"language-xform-de-multi-en-hard"}, "5.0");
  });

  it("language-xform-de-multi-en-default" + 'R5-cached', async () => {
    await runTest({"suite":"language","test":"language-xform-de-multi-en-default"}, "5.0");
  });

  it("language-echo-en-designation" + 'R5-cached', async () => {
    await runTest({"suite":"language","test":"language-echo-en-designation"}, "5.0");
  });

  it("language-echo-en-designations" + 'R5-cached', async () => {
    await runTest({"suite":"language","test":"language-echo-en-designations"}, "5.0");
  });

});

describe('language2', () => {
  // A series of tests that test display name validation for various permutations of languages

  it("validation-right-de-en" + 'R5-cached', async () => {
    await runTest({"suite":"language2","test":"validation-right-de-en"}, "5.0");
  });

  it("validation-right-de-ende-N" + 'R5-cached', async () => {
    await runTest({"suite":"language2","test":"validation-right-de-ende-N"}, "5.0");
  });

  it("validation-right-de-ende" + 'R5-cached', async () => {
    await runTest({"suite":"language2","test":"validation-right-de-ende"}, "5.0");
  });

  it("validation-right-de-none" + 'R5-cached', async () => {
    await runTest({"suite":"language2","test":"validation-right-de-none"}, "5.0");
  });

  it("validation-right-en-en" + 'R5-cached', async () => {
    await runTest({"suite":"language2","test":"validation-right-en-en"}, "5.0");
  });

  it("validation-right-en-ende-N" + 'R5-cached', async () => {
    await runTest({"suite":"language2","test":"validation-right-en-ende-N"}, "5.0");
  });

  it("validation-right-en-ende" + 'R5-cached', async () => {
    await runTest({"suite":"language2","test":"validation-right-en-ende"}, "5.0");
  });

  it("validation-right-en-none" + 'R5-cached', async () => {
    await runTest({"suite":"language2","test":"validation-right-en-none"}, "5.0");
  });

  it("validation-right-none-en" + 'R5-cached', async () => {
    await runTest({"suite":"language2","test":"validation-right-none-en"}, "5.0");
  });

  it("validation-right-none-ende-N" + 'R5-cached', async () => {
    await runTest({"suite":"language2","test":"validation-right-none-ende-N"}, "5.0");
  });

  it("validation-right-none-ende" + 'R5-cached', async () => {
    await runTest({"suite":"language2","test":"validation-right-none-ende"}, "5.0");
  });

  it("validation-right-none-none" + 'R5-cached', async () => {
    await runTest({"suite":"language2","test":"validation-right-none-none"}, "5.0");
  });

  it("validation-wrong-de-en" + 'R5-cached', async () => {
    await runTest({"suite":"language2","test":"validation-wrong-de-en"}, "5.0");
  });

  it("validation-wrong-de-en-bad" + 'R5-cached', async () => {
    await runTest({"suite":"language2","test":"validation-wrong-de-en-bad"}, "5.0");
  });

  it("validation-wrong-de-ende-N" + 'R5-cached', async () => {
    await runTest({"suite":"language2","test":"validation-wrong-de-ende-N"}, "5.0");
  });

  it("validation-wrong-de-ende" + 'R5-cached', async () => {
    await runTest({"suite":"language2","test":"validation-wrong-de-ende"}, "5.0");
  });

  it("validation-wrong-de-none" + 'R5-cached', async () => {
    await runTest({"suite":"language2","test":"validation-wrong-de-none"}, "5.0");
  });

  it("validation-wrong-en-en" + 'R5-cached', async () => {
    await runTest({"suite":"language2","test":"validation-wrong-en-en"}, "5.0");
  });

  it("validation-wrong-en-ende-N" + 'R5-cached', async () => {
    await runTest({"suite":"language2","test":"validation-wrong-en-ende-N"}, "5.0");
  });

  it("validation-wrong-en-ende" + 'R5-cached', async () => {
    await runTest({"suite":"language2","test":"validation-wrong-en-ende"}, "5.0");
  });

  it("validation-wrong-en-none" + 'R5-cached', async () => {
    await runTest({"suite":"language2","test":"validation-wrong-en-none"}, "5.0");
  });

  it("validation-wrong-none-en" + 'R5-cached', async () => {
    await runTest({"suite":"language2","test":"validation-wrong-none-en"}, "5.0");
  });

  it("validation-wrong-none-ende-N" + 'R5-cached', async () => {
    await runTest({"suite":"language2","test":"validation-wrong-none-ende-N"}, "5.0");
  });

  it("validation-wrong-none-ende" + 'R5-cached', async () => {
    await runTest({"suite":"language2","test":"validation-wrong-none-ende"}, "5.0");
  });

  it("validation-wrong-none-none" + 'R5-cached', async () => {
    await runTest({"suite":"language2","test":"validation-wrong-none-none"}, "5.0");
  });

});

describe('extensions', () => {
  // Testing proper handling of extensions, which depends on the extension

  it("extensions-echo-all" + 'R5-cached', async () => {
    await runTest({"suite":"extensions","test":"extensions-echo-all"}, "5.0");
  });

  it("extensions-echo-enumerated" + 'R5-cached', async () => {
    await runTest({"suite":"extensions","test":"extensions-echo-enumerated"}, "5.0");
  });

  it("extensions-echo-bad-supplement" + 'R5-cached', async () => {
    await runTest({"suite":"extensions","test":"extensions-echo-bad-supplement"}, "5.0");
  });

  it("validate-code-bad-supplement" + 'R5-cached', async () => {
    await runTest({"suite":"extensions","test":"validate-code-bad-supplement"}, "5.0");
  });

  it("validate-coding-bad-supplement" + 'R5-cached', async () => {
    await runTest({"suite":"extensions","test":"validate-coding-bad-supplement"}, "5.0");
  });

  it("validate-coding-bad-supplement-url" + 'R5-cached', async () => {
    await runTest({"suite":"extensions","test":"validate-coding-bad-supplement-url"}, "5.0");
  });

  it("validate-codeableconcept-bad-supplement" + 'R5-cached', async () => {
    await runTest({"suite":"extensions","test":"validate-codeableconcept-bad-supplement"}, "5.0");
  });

  it("validate-coding-good-supplement" + 'R5-cached', async () => {
    await runTest({"suite":"extensions","test":"validate-coding-good-supplement"}, "5.0");
  });

  it("validate-coding-good2-supplement" + 'R5-cached', async () => {
    await runTest({"suite":"extensions","test":"validate-coding-good2-supplement"}, "5.0");
  });

  it("validate-code-inactive-display-lenient" + 'R5-cached', async () => {
    await runTest({"suite":"extensions","test":"validate-code-inactive-display-lenient"}, "5.0");
  });

  it("validate-code-inactive-display-notlenient" + 'R5-cached', async () => {
    await runTest({"suite":"extensions","test":"validate-code-inactive-display-notlenient"}, "5.0");
  });

  it("validate-code-inactive" + 'R5-cached', async () => {
    await runTest({"suite":"extensions","test":"validate-code-inactive"}, "5.0");
  });

});

describe('validation', () => {
  // Testing various validation parameter combinations

  it("validation-simple-code-good" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-good"}, "5.0");
  });

  it("validation-simple-child-of-child" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-child-of-child"}, "5.0");
  });

  it("validation-simple-child-of-grandchild" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-child-of-grandchild"}, "5.0");
  });

  it("validation-simple-code-implied-good" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-implied-good"}, "5.0");
  });

  it("validation-simple-coding-good" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-good"}, "5.0");
  });

  it("validation-simple-codeableconcept-good" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-codeableconcept-good"}, "5.0");
  });

  it("validation-simple-code-bad-code" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-bad-code"}, "5.0");
  });

  it("validation-simple-code-implied-bad-code" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-implied-bad-code"}, "5.0");
  });

  it("validation-simple-coding-bad-code" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-bad-code"}, "5.0");
  });

  it("validation-simple-coding-bad-code-inactive" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-bad-code-inactive"}, "5.0");
  });

  it("validation-simple-codeableconcept-bad-code" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-codeableconcept-bad-code"}, "5.0");
  });

  it("validation-simple-code-bad-valueSet" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-bad-valueSet"}, "5.0");
  });

  it("validation-simple-coding-bad-valueSet" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-bad-valueSet"}, "5.0");
  });

  it("validation-simple-codeableconcept-bad-valueSet" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-codeableconcept-bad-valueSet"}, "5.0");
  });

  it("validation-simple-code-bad-import" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-bad-import"}, "5.0");
  });

  it("validation-simple-coding-bad-import" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-bad-import"}, "5.0");
  });

  it("validation-simple-codeableconcept-bad-import" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-codeableconcept-bad-import"}, "5.0");
  });

  it("validation-simple-code-bad-system" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-bad-system"}, "5.0");
  });

  it("validation-simple-coding-bad-system" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-bad-system"}, "5.0");
  });

  it("validation-simple-codeableconcept-unknown-system" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-codeableconcept-unknown-system"}, "5.0");
  });

  it("validation-simple-coding-bad-system2" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-bad-system2"}, "5.0");
  });

  it("validation-simple-coding-bad-system-local" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-bad-system-local"}, "5.0");
  });

  it("validation-simple-coding-no-system" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-no-system"}, "5.0");
  });

  it("validation-simple-codeableconcept-bad-system" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-codeableconcept-bad-system"}, "5.0");
  });

  it("validation-simple-code-good-display" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-good-display"}, "5.0");
  });

  it("validation-simple-coding-good-display" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-good-display"}, "5.0");
  });

  it("validation-simple-codeableconcept-good-display" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-codeableconcept-good-display"}, "5.0");
  });

  it("validation-simple-code-bad-display-lenient" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-bad-display-lenient"}, "5.0");
  });

  it("validation-simple-code-bad-display-notlenient" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-bad-display-notlenient"}, "5.0");
  });

  it("validation-simple-code-bad-display-ws" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-bad-display-ws"}, "5.0");
  });

  it("validation-simple-coding-bad-display" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-bad-display"}, "5.0");
  });

  it("validation-simple-codeableconcept-bad-display" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-codeableconcept-bad-display"}, "5.0");
  });

  it("validation-simple-code-bad-display-warning" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-bad-display-warning"}, "5.0");
  });

  it("validation-simple-coding-bad-display-warning" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-bad-display-warning"}, "5.0");
  });

  it("validation-simple-codeableconcept-bad-display-warning" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-codeableconcept-bad-display-warning"}, "5.0");
  });

  it("validation-simple-code-good-language" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-good-language"}, "5.0");
  });

  it("validation-simple-coding-good-language" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-good-language"}, "5.0");
  });

  it("validation-simple-codeableconcept-good-language" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-codeableconcept-good-language"}, "5.0");
  });

  it("validation-simple-code-bad-language" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-bad-language"}, "5.0");
  });

  it("validation-simple-code-good-regex" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-good-regex"}, "5.0");
  });

  it("validation-simple-code-bad-regex" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-bad-regex"}, "5.0");
  });

  it("validation-simple-code-regex-none" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-regex-none"}, "5.0");
  });

  it("validation-simple-coding-bad-language" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-bad-language"}, "5.0");
  });

  it("validation-simple-coding-bad-language-header" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-bad-language-header"}, "5.0");
  });

  it("validation-simple-coding-bad-language-vs" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-bad-language-vs"}, "5.0");
  });

  it("validation-simple-coding-bad-language-vslang" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-bad-language-vslang"}, "5.0");
  });

  it("validation-simple-codeableconcept-bad-language" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-codeableconcept-bad-language"}, "5.0");
  });

  it("validation-simple-code-good-language-none" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-good-language-none"}, "5.0");
  });

  it("validation-simple-code-bad-language-none" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-code-bad-language-none"}, "5.0");
  });

  it("validation-simple-coding-good-language-none" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-good-language-none"}, "5.0");
  });

  it("validation-simple-coding-bad-language-none" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-coding-bad-language-none"}, "5.0");
  });

  it("validation-simple-codeableconcept-good-language-none" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-codeableconcept-good-language-none"}, "5.0");
  });

  it("validation-simple-codeableconcept-bad-language-none" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-simple-codeableconcept-bad-language-none"}, "5.0");
  });

  it("validation-complex-codeableconcept-full" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-complex-codeableconcept-full"}, "5.0");
  });

  it("validation-complex-codeableconcept-vsonly" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-complex-codeableconcept-vsonly"}, "5.0");
  });

  it("validation-cs-code-good" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-cs-code-good"}, "5.0");
  });

  it("validation-cs-code-bad-code" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-cs-code-bad-code"}, "5.0");
  });

  it("validation-contained-good" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-contained-good"}, "5.0");
  });

  it("validation-contained-bad" + 'R5-cached', async () => {
    await runTest({"suite":"validation","test":"validation-contained-bad"}, "5.0");
  });

});

describe('version', () => {
  // Testing various version issues. There's two versions of a code system, and three value sets that select different versions

  it("version-simple-code-bad-version1" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"version-simple-code-bad-version1"}, "5.0");
  });

  it("version-simple-coding-bad-version1" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"version-simple-coding-bad-version1"}, "5.0");
  });

  it("version-simple-codeableconcept-bad-version1" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"version-simple-codeableconcept-bad-version1"}, "5.0");
  });

  it("version-simple-codeableconcept-bad-version2" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"version-simple-codeableconcept-bad-version2"}, "5.0");
  });

  it("version-simple-code-good-version" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"version-simple-code-good-version"}, "5.0");
  });

  it("version-simple-coding-good-version" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"version-simple-coding-good-version"}, "5.0");
  });

  it("version-simple-codeableconcept-good-version" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"version-simple-codeableconcept-good-version"}, "5.0");
  });

  it("version-version-profile-none" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"version-version-profile-none"}, "5.0");
  });

  it("version-version-profile-default" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"version-version-profile-default"}, "5.0");
  });

  it("validation-version-profile-coding" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"validation-version-profile-coding"}, "5.0");
  });

  it("coding-vnn-vsnn" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vsnn"}, "5.0");
  });

  it("coding-v10-vs1w" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-v10-vs1w"}, "5.0");
  });

  it("coding-v10-vs1wb" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-v10-vs1wb"}, "5.0");
  });

  it("coding-v10-vs10" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-v10-vs10"}, "5.0");
  });

  it("coding-v10-vs20" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-v10-vs20"}, "5.0");
  });

  it("coding-v10-vsbb" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-v10-vsbb"}, "5.0");
  });

  it("coding-v10-vsbb" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-v10-vsbb"}, "5.0");
  });

  it("coding-v10-vsnn" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-v10-vsnn"}, "5.0");
  });

  it("coding-vbb-vs10" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-vbb-vs10"}, "5.0");
  });

  it("coding-vbb-vsnn" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-vbb-vsnn"}, "5.0");
  });

  it("coding-vnn-vs1w" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vs1w"}, "5.0");
  });

  it("coding-vnn-vs1wb" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vs1wb"}, "5.0");
  });

  it("coding-vnn-vs10" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vs10"}, "5.0");
  });

  it("coding-vnn-vsbb" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vsbb"}, "5.0");
  });

  it("coding-vnn-vsnn-default" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vsnn-default"}, "5.0");
  });

  it("coding-v10-vs1w-default" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-v10-vs1w-default"}, "5.0");
  });

  it("coding-v10-vs1wb-default" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-v10-vs1wb-default"}, "5.0");
  });

  it("coding-v10-vs10-default" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-v10-vs10-default"}, "5.0");
  });

  it("coding-v10-vs20-default" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-v10-vs20-default"}, "5.0");
  });

  it("coding-v10-vsbb-default" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-v10-vsbb-default"}, "5.0");
  });

  it("coding-v10-vsnn-default" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-v10-vsnn-default"}, "5.0");
  });

  it("coding-vbb-vs10-default" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-vbb-vs10-default"}, "5.0");
  });

  it("coding-vbb-vsnn-default" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-vbb-vsnn-default"}, "5.0");
  });

  it("coding-vnn-vs1w-default" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vs1w-default"}, "5.0");
  });

  it("coding-vnn-vs1wb-default" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vs1wb-default"}, "5.0");
  });

  it("coding-vnn-vs10-default" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vs10-default"}, "5.0");
  });

  it("coding-vnn-vsbb-default" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vsbb-default"}, "5.0");
  });

  it("coding-vnn-vsnn-check" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vsnn-check"}, "5.0");
  });

  it("coding-v10-vs1w-check" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-v10-vs1w-check"}, "5.0");
  });

  it("coding-v10-vs1wb-check" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-v10-vs1wb-check"}, "5.0");
  });

  it("coding-v10-vs10-check" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-v10-vs10-check"}, "5.0");
  });

  it("coding-v10-vs20-check" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-v10-vs20-check"}, "5.0");
  });

  it("coding-v10-vsbb-check" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-v10-vsbb-check"}, "5.0");
  });

  it("coding-v10-vsnn-check" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-v10-vsnn-check"}, "5.0");
  });

  it("coding-vbb-vs10-check" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-vbb-vs10-check"}, "5.0");
  });

  it("coding-vbb-vsnn-check" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-vbb-vsnn-check"}, "5.0");
  });

  it("coding-vnn-vs1w-check" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vs1w-check"}, "5.0");
  });

  it("coding-vnn-vs1wb-check" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vs1wb-check"}, "5.0");
  });

  it("coding-vnn-vs10-check" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vs10-check"}, "5.0");
  });

  it("coding-vnn-vsbb-check" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vsbb-check"}, "5.0");
  });

  it("coding-vnn-vsnn-force" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vsnn-force"}, "5.0");
  });

  it("coding-v10-vs1w-force" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-v10-vs1w-force"}, "5.0");
  });

  it("coding-v10-vs1wb-force" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-v10-vs1wb-force"}, "5.0");
  });

  it("coding-v10-vs10-force" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-v10-vs10-force"}, "5.0");
  });

  it("coding-v10-vs20-force" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-v10-vs20-force"}, "5.0");
  });

  it("coding-v10-vsbb-force" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-v10-vsbb-force"}, "5.0");
  });

  it("coding-v10-vsnn-force" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-v10-vsnn-force"}, "5.0");
  });

  it("coding-vbb-vs10-force" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-vbb-vs10-force"}, "5.0");
  });

  it("coding-vbb-vsnn-force" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-vbb-vsnn-force"}, "5.0");
  });

  it("coding-vnn-vs1w-force" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vs1w-force"}, "5.0");
  });

  it("coding-vnn-vs1wb-force" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vs1wb-force"}, "5.0");
  });

  it("coding-vnn-vs10-force" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vs10-force"}, "5.0");
  });

  it("coding-vnn-vsbb-force" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"coding-vnn-vsbb-force"}, "5.0");
  });

  it("codeableconcept-vnn-vsnn" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vsnn"}, "5.0");
  });

  it("codeableconcept-v10-vs1w" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vs1w"}, "5.0");
  });

  it("codeableconcept-v10-vs1wb" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vs1wb"}, "5.0");
  });

  it("codeableconcept-v10-vs10" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vs10"}, "5.0");
  });

  it("codeableconcept-v10-vs20" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vs20"}, "5.0");
  });

  it("codeableconcept-v10-vsbb" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vsbb"}, "5.0");
  });

  it("codeableconcept-v10-vsbb" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vsbb"}, "5.0");
  });

  it("codeableconcept-v10-vsnn" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vsnn"}, "5.0");
  });

  it("codeableconcept-vbb-vs10" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vbb-vs10"}, "5.0");
  });

  it("codeableconcept-vbb-vsnn" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vbb-vsnn"}, "5.0");
  });

  it("codeableconcept-vnn-vs1w" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vs1w"}, "5.0");
  });

  it("codeableconcept-vnn-vs1wb" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vs1wb"}, "5.0");
  });

  it("codeableconcept-vnn-vs10" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vs10"}, "5.0");
  });

  it("codeableconcept-vnn-vsbb" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vsbb"}, "5.0");
  });

  it("codeableconcept-vnn-vsnn-default" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vsnn-default"}, "5.0");
  });

  it("codeableconcept-v10-vs1w-default" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vs1w-default"}, "5.0");
  });

  it("codeableconcept-v10-vs1wb-default" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vs1wb-default"}, "5.0");
  });

  it("codeableconcept-v10-vs10-default" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vs10-default"}, "5.0");
  });

  it("codeableconcept-v10-vs20-default" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vs20-default"}, "5.0");
  });

  it("codeableconcept-v10-vsbb-default" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vsbb-default"}, "5.0");
  });

  it("codeableconcept-v10-vsnn-default" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vsnn-default"}, "5.0");
  });

  it("codeableconcept-vbb-vs10-default" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vbb-vs10-default"}, "5.0");
  });

  it("codeableconcept-vbb-vsnn-default" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vbb-vsnn-default"}, "5.0");
  });

  it("codeableconcept-vnn-vs1w-default" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vs1w-default"}, "5.0");
  });

  it("codeableconcept-vnn-vs1wb-default" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vs1wb-default"}, "5.0");
  });

  it("codeableconcept-vnn-vs10-default" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vs10-default"}, "5.0");
  });

  it("codeableconcept-vnn-vsbb-default" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vsbb-default"}, "5.0");
  });

  it("codeableconcept-vnn-vsnn-check" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vsnn-check"}, "5.0");
  });

  it("codeableconcept-v10-vs1w-check" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vs1w-check"}, "5.0");
  });

  it("codeableconcept-v10-vs1wb-check" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vs1wb-check"}, "5.0");
  });

  it("codeableconcept-v10-vs10-check" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vs10-check"}, "5.0");
  });

  it("codeableconcept-v10-vs20-check" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vs20-check"}, "5.0");
  });

  it("codeableconcept-v10-vsbb-check" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vsbb-check"}, "5.0");
  });

  it("codeableconcept-v10-vsnn-check" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vsnn-check"}, "5.0");
  });

  it("codeableconcept-vbb-vs10-check" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vbb-vs10-check"}, "5.0");
  });

  it("codeableconcept-vbb-vsnn-check" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vbb-vsnn-check"}, "5.0");
  });

  it("codeableconcept-vnn-vs1w-check" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vs1w-check"}, "5.0");
  });

  it("codeableconcept-vnn-vs1wb-check" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vs1wb-check"}, "5.0");
  });

  it("codeableconcept-vnn-vs10-check" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vs10-check"}, "5.0");
  });

  it("codeableconcept-vnn-vsbb-check" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vsbb-check"}, "5.0");
  });

  it("codeableconcept-vnn-vsnn-force" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vsnn-force"}, "5.0");
  });

  it("codeableconcept-v10-vs1w-force" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vs1w-force"}, "5.0");
  });

  it("codeableconcept-v10-vs1wb-force" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vs1wb-force"}, "5.0");
  });

  it("codeableconcept-v10-vs10-force" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vs10-force"}, "5.0");
  });

  it("codeableconcept-v10-vs20-force" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vs20-force"}, "5.0");
  });

  it("codeableconcept-v10-vsbb-force" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vsbb-force"}, "5.0");
  });

  it("codeableconcept-v10-vsnn-force" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-v10-vsnn-force"}, "5.0");
  });

  it("codeableconcept-vbb-vs10-force" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vbb-vs10-force"}, "5.0");
  });

  it("codeableconcept-vbb-vsnn-force" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vbb-vsnn-force"}, "5.0");
  });

  it("codeableconcept-vnn-vs1w-force" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vs1w-force"}, "5.0");
  });

  it("codeableconcept-vnn-vs1wb-force" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vs1wb-force"}, "5.0");
  });

  it("codeableconcept-vnn-vs10-force" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vs10-force"}, "5.0");
  });

  it("codeableconcept-vnn-vsbb-force" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"codeableconcept-vnn-vsbb-force"}, "5.0");
  });

  it("code-vnn-vsnn" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-vnn-vsnn"}, "5.0");
  });

  it("code-v10-vs1w" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-v10-vs1w"}, "5.0");
  });

  it("code-v10-vs1wb" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-v10-vs1wb"}, "5.0");
  });

  it("code-v10-vs10" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-v10-vs10"}, "5.0");
  });

  it("code-v10-vs20" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-v10-vs20"}, "5.0");
  });

  it("code-v10-vsbb" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-v10-vsbb"}, "5.0");
  });

  it("code-v10-vsnn" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-v10-vsnn"}, "5.0");
  });

  it("code-vbb-vs10" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-vbb-vs10"}, "5.0");
  });

  it("code-vbb-vsnn" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-vbb-vsnn"}, "5.0");
  });

  it("code-vnn-vs1w" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-vnn-vs1w"}, "5.0");
  });

  it("code-vnn-vs1wb" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-vnn-vs1wb"}, "5.0");
  });

  it("code-vnn-vs10" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-vnn-vs10"}, "5.0");
  });

  it("code-vnn-vsbb" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-vnn-vsbb"}, "5.0");
  });

  it("code-vnn-vsnn-default" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-vnn-vsnn-default"}, "5.0");
  });

  it("code-v10-vs1w-default" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-v10-vs1w-default"}, "5.0");
  });

  it("code-v10-vs1wb-default" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-v10-vs1wb-default"}, "5.0");
  });

  it("code-v10-vs10-default" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-v10-vs10-default"}, "5.0");
  });

  it("code-v10-vs20-default" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-v10-vs20-default"}, "5.0");
  });

  it("code-v10-vsbb-default" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-v10-vsbb-default"}, "5.0");
  });

  it("code-v10-vsnn-default" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-v10-vsnn-default"}, "5.0");
  });

  it("code-vbb-vs10-default" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-vbb-vs10-default"}, "5.0");
  });

  it("code-vbb-vsnn-default" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-vbb-vsnn-default"}, "5.0");
  });

  it("code-vnn-vs1wb-default" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-vnn-vs1wb-default"}, "5.0");
  });

  it("code-vnn-vs10-default" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-vnn-vs10-default"}, "5.0");
  });

  it("code-vnn-vsbb-default" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-vnn-vsbb-default"}, "5.0");
  });

  it("code-vnn-vsnn-check" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-vnn-vsnn-check"}, "5.0");
  });

  it("code-v10-vs1w-check" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-v10-vs1w-check"}, "5.0");
  });

  it("code-v10-vs1wb-check" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-v10-vs1wb-check"}, "5.0");
  });

  it("code-v10-vs10-check" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-v10-vs10-check"}, "5.0");
  });

  it("code-v10-vs20-check" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-v10-vs20-check"}, "5.0");
  });

  it("code-v10-vsbb-check" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-v10-vsbb-check"}, "5.0");
  });

  it("code-v10-vsnn-check" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-v10-vsnn-check"}, "5.0");
  });

  it("code-vbb-vs10-check" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-vbb-vs10-check"}, "5.0");
  });

  it("code-vbb-vsnn-check" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-vbb-vsnn-check"}, "5.0");
  });

  it("code-vnn-vs1w-check" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-vnn-vs1w-check"}, "5.0");
  });

  it("code-vnn-vs1wb-check" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-vnn-vs1wb-check"}, "5.0");
  });

  it("code-vnn-vs10-check" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-vnn-vs10-check"}, "5.0");
  });

  it("code-vnn-vsbb-check" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-vnn-vsbb-check"}, "5.0");
  });

  it("code-vnn-vsnn-force" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-vnn-vsnn-force"}, "5.0");
  });

  it("code-v10-vs1w-force" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-v10-vs1w-force"}, "5.0");
  });

  it("code-v10-vs1wb-force" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-v10-vs1wb-force"}, "5.0");
  });

  it("code-v10-vs10-force" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-v10-vs10-force"}, "5.0");
  });

  it("code-v10-vs20-force" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-v10-vs20-force"}, "5.0");
  });

  it("code-v10-vsbb-force" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-v10-vsbb-force"}, "5.0");
  });

  it("code-v10-vsnn-force" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-v10-vsnn-force"}, "5.0");
  });

  it("code-vbb-vs10-force" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-vbb-vs10-force"}, "5.0");
  });

  it("code-vbb-vsnn-force" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-vbb-vsnn-force"}, "5.0");
  });

  it("code-vnn-vs1w-force" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-vnn-vs1w-force"}, "5.0");
  });

  it("code-vnn-vs1wb-force" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-vnn-vs1wb-force"}, "5.0");
  });

  it("code-vnn-vs10-force" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-vnn-vs10-force"}, "5.0");
  });

  it("code-vnn-vsbb-force" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-vnn-vsbb-force"}, "5.0");
  });

  it("code-vnn-vsmix-1" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-vnn-vsmix-1"}, "5.0");
  });

  it("code-vnn-vsmix-2" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"code-vnn-vsmix-2"}, "5.0");
  });

  it("vs-expand-all-v" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"vs-expand-all-v"}, "5.0");
  });

  it("vs-expand-all-v1" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"vs-expand-all-v1"}, "5.0");
  });

  it("vs-expand-all-v2" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"vs-expand-all-v2"}, "5.0");
  });

  it("vs-expand-v-mixed" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"vs-expand-v-mixed"}, "5.0");
  });

  it("vs-expand-v-n-request" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"vs-expand-v-n-request"}, "5.0");
  });

  it("vs-expand-v-w" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"vs-expand-v-w"}, "5.0");
  });

  it("vs-expand-v-wb" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"vs-expand-v-wb"}, "5.0");
  });

  it("vs-expand-v1" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"vs-expand-v1"}, "5.0");
  });

  it("vs-expand-v2" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"vs-expand-v2"}, "5.0");
  });

  it("vs-expand-all-v-force" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"vs-expand-all-v-force"}, "5.0");
  });

  it("vs-expand-all-v1-force" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"vs-expand-all-v1-force"}, "5.0");
  });

  it("vs-expand-all-v2-force" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"vs-expand-all-v2-force"}, "5.0");
  });

  it("vs-expand-v-mixed-force" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"vs-expand-v-mixed-force"}, "5.0");
  });

  it("vs-expand-v-n-force-request" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"vs-expand-v-n-force-request"}, "5.0");
  });

  it("vs-expand-v-w-force" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"vs-expand-v-w-force"}, "5.0");
  });

  it("vs-expand-v-wb-force" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"vs-expand-v-wb-force"}, "5.0");
  });

  it("vs-expand-v1-force" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"vs-expand-v1-force"}, "5.0");
  });

  it("vs-expand-v2-force" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"vs-expand-v2-force"}, "5.0");
  });

  it("vs-expand-all-v-default" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"vs-expand-all-v-default"}, "5.0");
  });

  it("vs-expand-all-v1-default" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"vs-expand-all-v1-default"}, "5.0");
  });

  it("vs-expand-all-v2-default" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"vs-expand-all-v2-default"}, "5.0");
  });

  it("vs-expand-v-mixed-default" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"vs-expand-v-mixed-default"}, "5.0");
  });

  it("vs-expand-v-n-default-request" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"vs-expand-v-n-default-request"}, "5.0");
  });

  it("vs-expand-v-w-default" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"vs-expand-v-w-default"}, "5.0");
  });

  it("vs-expand-v-wb-default" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"vs-expand-v-wb-default"}, "5.0");
  });

  it("vs-expand-v1-default" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"vs-expand-v1-default"}, "5.0");
  });

  it("vs-expand-v2-default" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"vs-expand-v2-default"}, "5.0");
  });

  it("vs-expand-all-v-check" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"vs-expand-all-v-check"}, "5.0");
  });

  it("vs-expand-all-v1-check" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"vs-expand-all-v1-check"}, "5.0");
  });

  it("vs-expand-all-v2-check" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"vs-expand-all-v2-check"}, "5.0");
  });

  it("vs-expand-v-mixed-check" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"vs-expand-v-mixed-check"}, "5.0");
  });

  it("vs-expand-v-n-check-request" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"vs-expand-v-n-check-request"}, "5.0");
  });

  it("vs-expand-v-w-check" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"vs-expand-v-w-check"}, "5.0");
  });

  it("vs-expand-v-wb-check" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"vs-expand-v-wb-check"}, "5.0");
  });

  it("vs-expand-v1-check" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"vs-expand-v1-check"}, "5.0");
  });

  it("vs-expand-v2-check" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"vs-expand-v2-check"}, "5.0");
  });

  it("vs-expand-versionless" + 'R5-cached', async () => {
    await runTest({"suite":"version","test":"vs-expand-versionless"}, "5.0");
  });

});

describe('overload', () => {
  // A set of tests that test out handling of value sets that cross versions of the same code system

  it("expand-all" + 'R5-cached', async () => {
    await runTest({"suite":"overload","test":"expand-all"}, "5.0");
  });

  it("expand-all-versioned" + 'R5-cached', async () => {
    await runTest({"suite":"overload","test":"expand-all-versioned"}, "5.0");
  });

  it("expand-all-merged" + 'R5-cached', async () => {
    await runTest({"suite":"overload","test":"expand-all-merged"}, "5.0");
  });

  it("expand-enum-good" + 'R5-cached', async () => {
    await runTest({"suite":"overload","test":"expand-enum-good"}, "5.0");
  });

  it("expand-enum-bad" + 'R5-cached', async () => {
    await runTest({"suite":"overload","test":"expand-enum-bad"}, "5.0");
  });

  it("expand-exclude" + 'R5-cached', async () => {
    await runTest({"suite":"overload","test":"expand-exclude"}, "5.0");
  });

  it("expand-exclude-versioned" + 'R5-cached', async () => {
    await runTest({"suite":"overload","test":"expand-exclude-versioned"}, "5.0");
  });

  it("expand-exclude-merged" + 'R5-cached', async () => {
    await runTest({"suite":"overload","test":"expand-exclude-merged"}, "5.0");
  });

  it("validate-all-good" + 'R5-cached', async () => {
    await runTest({"suite":"overload","test":"validate-all-good"}, "5.0");
  });

  it("validate-all-good2" + 'R5-cached', async () => {
    await runTest({"suite":"overload","test":"validate-all-good2"}, "5.0");
  });

  it("validate-all-good3" + 'R5-cached', async () => {
    await runTest({"suite":"overload","test":"validate-all-good3"}, "5.0");
  });

  it("validate-all-good4" + 'R5-cached', async () => {
    await runTest({"suite":"overload","test":"validate-all-good4"}, "5.0");
  });

  it("validate-all-bad2" + 'R5-cached', async () => {
    await runTest({"suite":"overload","test":"validate-all-bad2"}, "5.0");
  });

  it("validate-all-bad2v" + 'R5-cached', async () => {
    await runTest({"suite":"overload","test":"validate-all-bad2v"}, "5.0");
  });

  it("expand-all-sysver" + 'R5-cached', async () => {
    await runTest({"suite":"overload","test":"expand-all-sysver"}, "5.0");
  });

  it("expand-exclude-enum" + 'R5-cached', async () => {
    await runTest({"suite":"overload","test":"expand-exclude-enum"}, "5.0");
  });

  it("expand-mixed" + 'R5-cached', async () => {
    await runTest({"suite":"overload","test":"expand-mixed"}, "5.0");
  });

  it("validate-bad-enum-code1" + 'R5-cached', async () => {
    await runTest({"suite":"overload","test":"validate-bad-enum-code1"}, "5.0");
  });

  it("validate-bad-exclude-code1" + 'R5-cached', async () => {
    await runTest({"suite":"overload","test":"validate-bad-exclude-code1"}, "5.0");
  });

  it("validate-bad-unknown" + 'R5-cached', async () => {
    await runTest({"suite":"overload","test":"validate-bad-unknown"}, "5.0");
  });

  it("validate-v1code2-wrongdisplay" + 'R5-cached', async () => {
    await runTest({"suite":"overload","test":"validate-v1code2-wrongdisplay"}, "5.0");
  });

  it("validate-bad-v1code4" + 'R5-cached', async () => {
    await runTest({"suite":"overload","test":"validate-bad-v1code4"}, "5.0");
  });

  it("validate-bad-v2code3" + 'R5-cached', async () => {
    await runTest({"suite":"overload","test":"validate-bad-v2code3"}, "5.0");
  });

  it("validate-good-code2-v1display" + 'R5-cached', async () => {
    await runTest({"suite":"overload","test":"validate-good-code2-v1display"}, "5.0");
  });

  it("validate-good-enum-code3" + 'R5-cached', async () => {
    await runTest({"suite":"overload","test":"validate-good-enum-code3"}, "5.0");
  });

  it("validate-good-exclude-code4" + 'R5-cached', async () => {
    await runTest({"suite":"overload","test":"validate-good-exclude-code4"}, "5.0");
  });

  it("validate-good-v1code1" + 'R5-cached', async () => {
    await runTest({"suite":"overload","test":"validate-good-v1code1"}, "5.0");
  });

  it("validate-good-v1code2-display" + 'R5-cached', async () => {
    await runTest({"suite":"overload","test":"validate-good-v1code2-display"}, "5.0");
  });

  it("validate-good2a" + 'R5-cached', async () => {
    await runTest({"suite":"overload","test":"validate-good2a"}, "5.0");
  });

});

describe('fragment', () => {
  // Testing handling a code system fragment

  it("fragment-expansion" + 'R5-cached', async () => {
    await runTest({"suite":"fragment","test":"fragment-expansion"}, "5.0");
  });

  it("validation-fragment-code-good" + 'R5-cached', async () => {
    await runTest({"suite":"fragment","test":"validation-fragment-code-good"}, "5.0");
  });

  it("validation-fragment-coding-good" + 'R5-cached', async () => {
    await runTest({"suite":"fragment","test":"validation-fragment-coding-good"}, "5.0");
  });

  it("validation-fragment-codeableconcept-good" + 'R5-cached', async () => {
    await runTest({"suite":"fragment","test":"validation-fragment-codeableconcept-good"}, "5.0");
  });

  it("validation-fragment-code-bad-code" + 'R5-cached', async () => {
    await runTest({"suite":"fragment","test":"validation-fragment-code-bad-code"}, "5.0");
  });

  it("validation-fragment-coding-bad-code" + 'R5-cached', async () => {
    await runTest({"suite":"fragment","test":"validation-fragment-coding-bad-code"}, "5.0");
  });

  it("validation-fragment-codeableconcept-bad-code" + 'R5-cached', async () => {
    await runTest({"suite":"fragment","test":"validation-fragment-codeableconcept-bad-code"}, "5.0");
  });

});

describe('big', () => {
  // Testing handling a big code system

  it("big-echo-no-limit" + 'R5-cached', async () => {
    await runTest({"suite":"big","test":"big-echo-no-limit"}, "5.0");
  });

  it("big-echo-zero-fifty-limit" + 'R5-cached', async () => {
    await runTest({"suite":"big","test":"big-echo-zero-fifty-limit"}, "5.0");
  });

  it("big-echo-fifty-fifty-limit" + 'R5-cached', async () => {
    await runTest({"suite":"big","test":"big-echo-fifty-fifty-limit"}, "5.0");
  });

  it("big-circle-bang" + 'R5-cached', async () => {
    await runTest({"suite":"big","test":"big-circle-bang"}, "5.0");
  });

  it("big-circle-validate" + 'R5-cached', async () => {
    await runTest({"suite":"big","test":"big-circle-validate"}, "5.0");
  });

});

describe('other', () => {
  // Misc tests based on issues submitted by users

  it("dual-filter" + 'R5-cached', async () => {
    await runTest({"suite":"other","test":"dual-filter"}, "5.0");
  });

  it("validation-dual-filter-in" + 'R5-cached', async () => {
    await runTest({"suite":"other","test":"validation-dual-filter-in"}, "5.0");
  });

  it("validation-dual-filter-out" + 'R5-cached', async () => {
    await runTest({"suite":"other","test":"validation-dual-filter-out"}, "5.0");
  });

});

describe('errors', () => {
  // Testing Various Error Conditions

  it("unknown-system1" + 'R5-cached', async () => {
    await runTest({"suite":"errors","test":"unknown-system1"}, "5.0");
  });

  it("unknown-system2" + 'R5-cached', async () => {
    await runTest({"suite":"errors","test":"unknown-system2"}, "5.0");
  });

  it("broken-filter-validate" + 'R5-cached', async () => {
    await runTest({"suite":"errors","test":"broken-filter-validate"}, "5.0");
  });

  it("broken-filter2-validate" + 'R5-cached', async () => {
    await runTest({"suite":"errors","test":"broken-filter2-validate"}, "5.0");
  });

  it("broken-filter-expand" + 'R5-cached', async () => {
    await runTest({"suite":"errors","test":"broken-filter-expand"}, "5.0");
  });

  it("combination-ok" + 'R5-cached', async () => {
    await runTest({"suite":"errors","test":"combination-ok"}, "5.0");
  });

  it("combination-bad" + 'R5-cached', async () => {
    await runTest({"suite":"errors","test":"combination-bad"}, "5.0");
  });

});

describe('deprecated', () => {
  // Testing Deprecated+Withdrawn warnings

  it("withdrawn" + 'R5-cached', async () => {
    await runTest({"suite":"deprecated","test":"withdrawn"}, "5.0");
  });

  it("not-withdrawn" + 'R5-cached', async () => {
    await runTest({"suite":"deprecated","test":"not-withdrawn"}, "5.0");
  });

  it("withdrawn-validate" + 'R5-cached', async () => {
    await runTest({"suite":"deprecated","test":"withdrawn-validate"}, "5.0");
  });

  it("not-withdrawn-validate" + 'R5-cached', async () => {
    await runTest({"suite":"deprecated","test":"not-withdrawn-validate"}, "5.0");
  });

  it("experimental" + 'R5-cached', async () => {
    await runTest({"suite":"deprecated","test":"experimental"}, "5.0");
  });

  it("experimental-validate" + 'R5-cached', async () => {
    await runTest({"suite":"deprecated","test":"experimental-validate"}, "5.0");
  });

  it("draft" + 'R5-cached', async () => {
    await runTest({"suite":"deprecated","test":"draft"}, "5.0");
  });

  it("draft-validate" + 'R5-cached', async () => {
    await runTest({"suite":"deprecated","test":"draft-validate"}, "5.0");
  });

  it("vs-deprecation" + 'R5-cached', async () => {
    await runTest({"suite":"deprecated","test":"vs-deprecation"}, "5.0");
  });

  it("deprecating-validate" + 'R5-cached', async () => {
    await runTest({"suite":"deprecated","test":"deprecating-validate"}, "5.0");
  });

  it("deprecating-validate-2" + 'R5-cached', async () => {
    await runTest({"suite":"deprecated","test":"deprecating-validate-2"}, "5.0");
  });

});

describe('notSelectable', () => {
  // Testing notSelectable

  it("notSelectable-prop-all" + 'R5-cached', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-all"}, "5.0");
  });

  it("notSelectable-noprop-all" + 'R5-cached', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-noprop-all"}, "5.0");
  });

  it("notSelectable-reprop-all" + 'R5-cached', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-reprop-all"}, "5.0");
  });

  it("notSelectable-unprop-all" + 'R5-cached', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-unprop-all"}, "5.0");
  });

  it("notSelectable-prop-true" + 'R5-cached', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-true"}, "5.0");
  });

  it("notSelectable-prop-trueUC" + 'R5-cached', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-trueUC"}, "5.0");
  });

  it("notSelectable-noprop-true" + 'R5-cached', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-noprop-true"}, "5.0");
  });

  it("notSelectable-reprop-true" + 'R5-cached', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-reprop-true"}, "5.0");
  });

  it("notSelectable-unprop-true" + 'R5-cached', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-unprop-true"}, "5.0");
  });

  it("notSelectable-prop-false" + 'R5-cached', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-false"}, "5.0");
  });

  it("notSelectable-noprop-false" + 'R5-cached', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-noprop-false"}, "5.0");
  });

  it("notSelectable-reprop-false" + 'R5-cached', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-reprop-false"}, "5.0");
  });

  it("notSelectable-unprop-false" + 'R5-cached', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-unprop-false"}, "5.0");
  });

  it("notSelectable-prop-in" + 'R5-cached', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-in"}, "5.0");
  });

  it("notSelectable-prop-out" + 'R5-cached', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-out"}, "5.0");
  });

  it("notSelectable-prop-true-true" + 'R5-cached', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-true-true"}, "5.0");
  });

  it("notSelectable-prop-trueUC-true" + 'R5-cached', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-trueUC-true"}, "5.0");
  });

  it("notSelectable-prop-in-true" + 'R5-cached', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-in-true"}, "5.0");
  });

  it("notSelectable-prop-out-true" + 'R5-cached', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-out-true"}, "5.0");
  });

  it("notSelectable-noprop-true-true" + 'R5-cached', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-noprop-true-true"}, "5.0");
  });

  it("notSelectable-reprop-true-true" + 'R5-cached', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-reprop-true-true"}, "5.0");
  });

  it("notSelectable-unprop-true-true" + 'R5-cached', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-unprop-true-true"}, "5.0");
  });

  it("notSelectable-prop-true-false" + 'R5-cached', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-true-false"}, "5.0");
  });

  it("notSelectable-prop-in-false" + 'R5-cached', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-in-false"}, "5.0");
  });

  it("notSelectable-prop-in-unknown" + 'R5-cached', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-in-unknown"}, "5.0");
  });

  it("notSelectable-prop-out-unknown" + 'R5-cached', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-out-unknown"}, "5.0");
  });

  it("notSelectable-prop-out-false" + 'R5-cached', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-out-false"}, "5.0");
  });

  it("notSelectable-noprop-true-false" + 'R5-cached', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-noprop-true-false"}, "5.0");
  });

  it("notSelectable-reprop-true-false" + 'R5-cached', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-reprop-true-false"}, "5.0");
  });

  it("notSelectable-unprop-true-false" + 'R5-cached', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-unprop-true-false"}, "5.0");
  });

  it("notSelectable-prop-false-true" + 'R5-cached', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-false-true"}, "5.0");
  });

  it("notSelectable-noprop-false-true" + 'R5-cached', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-noprop-false-true"}, "5.0");
  });

  it("notSelectable-reprop-false-true" + 'R5-cached', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-reprop-false-true"}, "5.0");
  });

  it("notSelectable-unprop-false-true" + 'R5-cached', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-unprop-false-true"}, "5.0");
  });

  it("notSelectable-prop-false-false" + 'R5-cached', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-false-false"}, "5.0");
  });

  it("notSelectable-noprop-false-false" + 'R5-cached', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-noprop-false-false"}, "5.0");
  });

  it("notSelectable-reprop-false-false" + 'R5-cached', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-reprop-false-false"}, "5.0");
  });

  it("notSelectable-unprop-false-false" + 'R5-cached', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-unprop-false-false"}, "5.0");
  });

  it("notSelectable-noprop-true-unknown" + 'R5-cached', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-noprop-true-unknown"}, "5.0");
  });

  it("notSelectable-reprop-true-unknown" + 'R5-cached', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-reprop-true-unknown"}, "5.0");
  });

  it("notSelectable-unprop-true-unknown" + 'R5-cached', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-unprop-true-unknown"}, "5.0");
  });

  it("notSelectable-prop-true-unknown" + 'R5-cached', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-true-unknown"}, "5.0");
  });

  it("notSelectable-prop-false-unknown" + 'R5-cached', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-false-unknown"}, "5.0");
  });

  it("notSelectable-noprop-false-unknown" + 'R5-cached', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-noprop-false-unknown"}, "5.0");
  });

  it("notSelectable-reprop-false-unknown" + 'R5-cached', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-reprop-false-unknown"}, "5.0");
  });

  it("notSelectable-unprop-false-unknown" + 'R5-cached', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-unprop-false-unknown"}, "5.0");
  });

  it("notSelectable-prop-true-true-param-true" + 'R5-cached', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-true-true-param-true"}, "5.0");
  });

  it("notSelectable-prop-true-true-param-false" + 'R5-cached', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-true-true-param-false"}, "5.0");
  });

  it("notSelectable-prop-false-false-param-true" + 'R5-cached', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-false-false-param-true"}, "5.0");
  });

  it("notSelectable-prop-false-false-param-false" + 'R5-cached', async () => {
    await runTest({"suite":"notSelectable","test":"notSelectable-prop-false-false-param-false"}, "5.0");
  });

});

describe('inactive', () => {
  // Testing Inactive codes

  it("inactive-expand" + 'R5-cached', async () => {
    await runTest({"suite":"inactive","test":"inactive-expand"}, "5.0");
  });

  it("inactive-inactive-expand" + 'R5-cached', async () => {
    await runTest({"suite":"inactive","test":"inactive-inactive-expand"}, "5.0");
  });

  it("inactive-active-expand" + 'R5-cached', async () => {
    await runTest({"suite":"inactive","test":"inactive-active-expand"}, "5.0");
  });

  it("inactive-1-validate" + 'R5-cached', async () => {
    await runTest({"suite":"inactive","test":"inactive-1-validate"}, "5.0");
  });

  it("inactive-2-validate" + 'R5-cached', async () => {
    await runTest({"suite":"inactive","test":"inactive-2-validate"}, "5.0");
  });

  it("inactive-3-validate" + 'R5-cached', async () => {
    await runTest({"suite":"inactive","test":"inactive-3-validate"}, "5.0");
  });

  it("inactive-1a-validate" + 'R5-cached', async () => {
    await runTest({"suite":"inactive","test":"inactive-1a-validate"}, "5.0");
  });

  it("inactive-2a-validate" + 'R5-cached', async () => {
    await runTest({"suite":"inactive","test":"inactive-2a-validate"}, "5.0");
  });

  it("inactive-3a-validate" + 'R5-cached', async () => {
    await runTest({"suite":"inactive","test":"inactive-3a-validate"}, "5.0");
  });

  it("inactive-1b-validate" + 'R5-cached', async () => {
    await runTest({"suite":"inactive","test":"inactive-1b-validate"}, "5.0");
  });

  it("inactive-2b-validate" + 'R5-cached', async () => {
    await runTest({"suite":"inactive","test":"inactive-2b-validate"}, "5.0");
  });

  it("inactive-3b-validate" + 'R5-cached', async () => {
    await runTest({"suite":"inactive","test":"inactive-3b-validate"}, "5.0");
  });

});

describe('case', () => {
  // Test Case Sensitivity handling

  it("case-insensitive-code1-1" + 'R5-cached', async () => {
    await runTest({"suite":"case","test":"case-insensitive-code1-1"}, "5.0");
  });

  it("case-insensitive-code1-2" + 'R5-cached', async () => {
    await runTest({"suite":"case","test":"case-insensitive-code1-2"}, "5.0");
  });

  it("case-insensitive-code1-3" + 'R5-cached', async () => {
    await runTest({"suite":"case","test":"case-insensitive-code1-3"}, "5.0");
  });

  it("case-sensitive-code1-1" + 'R5-cached', async () => {
    await runTest({"suite":"case","test":"case-sensitive-code1-1"}, "5.0");
  });

  it("case-sensitive-code1-2" + 'R5-cached', async () => {
    await runTest({"suite":"case","test":"case-sensitive-code1-2"}, "5.0");
  });

  it("case-sensitive-code1-3" + 'R5-cached', async () => {
    await runTest({"suite":"case","test":"case-sensitive-code1-3"}, "5.0");
  });

});

describe('translate', () => {
  // Tests for ConceptMap.$translate

  it("translate-1" + 'R5-cached', async () => {
    await runTest({"suite":"translate","test":"translate-1"}, "5.0");
  });

  it("translate-1-coding" + 'R5-cached', async () => {
    await runTest({"suite":"translate","test":"translate-1-coding"}, "5.0");
  });

  it("translate-1-codeableconcept" + 'R5-cached', async () => {
    await runTest({"suite":"translate","test":"translate-1-codeableconcept"}, "5.0");
  });

  it("translate-1-r4-code" + 'R4-cached', async () => {
    await runTest({"suite":"translate","test":"translate-1-r4-code"}, "4.0");
  });

  it("translate-1-r4-coding" + 'R4-cached', async () => {
    await runTest({"suite":"translate","test":"translate-1-r4-coding"}, "4.0");
  });

  it("translate-1-r4-codeableconcept" + 'R4-cached', async () => {
    await runTest({"suite":"translate","test":"translate-1-r4-codeableconcept"}, "4.0");
  });

  it("translate-2" + 'R5-cached', async () => {
    await runTest({"suite":"translate","test":"translate-2"}, "5.0");
  });

  it("translate-2b" + 'R5-cached', async () => {
    await runTest({"suite":"translate","test":"translate-2b"}, "5.0");
  });

  it("translate-3" + 'R5-cached', async () => {
    await runTest({"suite":"translate","test":"translate-3"}, "5.0");
  });

  it("translate-4" + 'R5-cached', async () => {
    await runTest({"suite":"translate","test":"translate-4"}, "5.0");
  });

});

describe('translate2', () => {
  // Tests for ConceptMap.$translate

  it("translate-5" + 'R5-cached', async () => {
    await runTest({"suite":"translate2","test":"translate-5"}, "5.0");
  });

  it("translate-5a" + 'R5-cached', async () => {
    await runTest({"suite":"translate2","test":"translate-5a"}, "5.0");
  });

  it("translate-5b" + 'R5-cached', async () => {
    await runTest({"suite":"translate2","test":"translate-5b"}, "5.0");
  });

  it("translate-6a" + 'R5-cached', async () => {
    await runTest({"suite":"translate2","test":"translate-6a"}, "5.0");
  });

  it("translate-reverse-r4" + 'R4-cached', async () => {
    await runTest({"suite":"translate2","test":"translate-reverse-r4"}, "4.0");
  });

  it("translate-reverse-r4-a" + 'R4-cached', async () => {
    await runTest({"suite":"translate2","test":"translate-reverse-r4-a"}, "4.0");
  });

  it("translate-reverse-r4-b" + 'R4-cached', async () => {
    await runTest({"suite":"translate2","test":"translate-reverse-r4-b"}, "4.0");
  });

});

describe('tho', () => {
  // Misc assorted test cases from tho

  it("act-class" + 'R5-cached', async () => {
    await runTest({"suite":"tho","test":"act-class"}, "5.0");
  });

  it("act-class-activeonly" + 'R5-cached', async () => {
    await runTest({"suite":"tho","test":"act-class-activeonly"}, "5.0");
  });

  it("act-exclusion" + 'R5-cached', async () => {
    await runTest({"suite":"tho","test":"act-exclusion"}, "5.0");
  });

  it("subsumes-act-class-property-parent" + 'R5-cached', async () => {
    await runTest({"suite":"tho","test":"subsumes-act-class-property-parent"}, "5.0");
  });

  it("subsumes-act-class-property-child" + 'R5-cached', async () => {
    await runTest({"suite":"tho","test":"subsumes-act-class-property-child"}, "5.0");
  });

  it("subsumes-act-class-transitive" + 'R5-cached', async () => {
    await runTest({"suite":"tho","test":"subsumes-act-class-transitive"}, "5.0");
  });

  it("subsumes-act-class-transitive-reverse" + 'R5-cached', async () => {
    await runTest({"suite":"tho","test":"subsumes-act-class-transitive-reverse"}, "5.0");
  });

  it("subsumes-act-class-equivalent" + 'R5-cached', async () => {
    await runTest({"suite":"tho","test":"subsumes-act-class-equivalent"}, "5.0");
  });

  it("subsumes-act-class-siblings" + 'R5-cached', async () => {
    await runTest({"suite":"tho","test":"subsumes-act-class-siblings"}, "5.0");
  });

  it("subsumes-act-class-cross-branch" + 'R5-cached', async () => {
    await runTest({"suite":"tho","test":"subsumes-act-class-cross-branch"}, "5.0");
  });

  it("subsumes-act-class-multiple-parents-first" + 'R5-cached', async () => {
    await runTest({"suite":"tho","test":"subsumes-act-class-multiple-parents-first"}, "5.0");
  });

  it("subsumes-act-class-multiple-parents-second" + 'R5-cached', async () => {
    await runTest({"suite":"tho","test":"subsumes-act-class-multiple-parents-second"}, "5.0");
  });

  it("subsumes-act-class-multiple-parents-crossed" + 'R5-cached', async () => {
    await runTest({"suite":"tho","test":"subsumes-act-class-multiple-parents-crossed"}, "5.0");
  });

  it("subsumes-act-class-unknown-code" + 'R5-cached', async () => {
    await runTest({"suite":"tho","test":"subsumes-act-class-unknown-code"}, "5.0");
  });

  it("validate-isa-self" + 'R5-cached', async () => {
    await runTest({"suite":"tho","test":"validate-isa-self"}, "5.0");
  });

  it("validate-isa-child" + 'R5-cached', async () => {
    await runTest({"suite":"tho","test":"validate-isa-child"}, "5.0");
  });

  it("validate-isa-deep" + 'R5-cached', async () => {
    await runTest({"suite":"tho","test":"validate-isa-deep"}, "5.0");
  });

  it("validate-isa-parent" + 'R5-cached', async () => {
    await runTest({"suite":"tho","test":"validate-isa-parent"}, "5.0");
  });

  it("validate-isa-other-branch" + 'R5-cached', async () => {
    await runTest({"suite":"tho","test":"validate-isa-other-branch"}, "5.0");
  });

  it("validate-descendent-of-self" + 'R5-cached', async () => {
    await runTest({"suite":"tho","test":"validate-descendent-of-self"}, "5.0");
  });

  it("validate-descendent-of-child" + 'R5-cached', async () => {
    await runTest({"suite":"tho","test":"validate-descendent-of-child"}, "5.0");
  });

  it("validate-descendent-of-deep" + 'R5-cached', async () => {
    await runTest({"suite":"tho","test":"validate-descendent-of-deep"}, "5.0");
  });

  it("validate-isnota-self" + 'R5-cached', async () => {
    await runTest({"suite":"tho","test":"validate-isnota-self"}, "5.0");
  });

  it("validate-isnota-descendant" + 'R5-cached', async () => {
    await runTest({"suite":"tho","test":"validate-isnota-descendant"}, "5.0");
  });

  it("validate-isnota-parent" + 'R5-cached', async () => {
    await runTest({"suite":"tho","test":"validate-isnota-parent"}, "5.0");
  });

  it("validate-isnota-other-branch" + 'R5-cached', async () => {
    await runTest({"suite":"tho","test":"validate-isnota-other-branch"}, "5.0");
  });

  it("validate-child-of-child" + 'R5-cached', async () => {
    await runTest({"suite":"tho","test":"validate-child-of-child"}, "5.0");
  });

  it("validate-child-of-self" + 'R5-cached', async () => {
    await runTest({"suite":"tho","test":"validate-child-of-self"}, "5.0");
  });

  it("validate-child-of-grandchild" + 'R5-cached', async () => {
    await runTest({"suite":"tho","test":"validate-child-of-grandchild"}, "5.0");
  });

  it("validate-isa-second-parent" + 'R5-cached', async () => {
    await runTest({"suite":"tho","test":"validate-isa-second-parent"}, "5.0");
  });

  it("validate-isa-second-parent-out" + 'R5-cached', async () => {
    await runTest({"suite":"tho","test":"validate-isa-second-parent-out"}, "5.0");
  });

  it("validate-isa-unknown-code" + 'R5-cached', async () => {
    await runTest({"suite":"tho","test":"validate-isa-unknown-code"}, "5.0");
  });

});

describe('exclude', () => {
  // Tests for proper functioning of exclude

  it("exclude-1" + 'R5-cached', async () => {
    await runTest({"suite":"exclude","test":"exclude-1"}, "5.0");
  });

  it("exclude-2" + 'R5-cached', async () => {
    await runTest({"suite":"exclude","test":"exclude-2"}, "5.0");
  });

  it("exclude-zero" + 'R5-cached', async () => {
    await runTest({"suite":"exclude","test":"exclude-zero"}, "5.0");
  });

  it("exclude-all" + 'R5-cached', async () => {
    await runTest({"suite":"exclude","test":"exclude-all"}, "5.0");
  });

  it("exclude-combo" + 'R5-cached', async () => {
    await runTest({"suite":"exclude","test":"exclude-combo"}, "5.0");
  });

  it("include-combo" + 'R5-cached', async () => {
    await runTest({"suite":"exclude","test":"include-combo"}, "5.0");
  });

  it("exclude-gender" + 'R5-cached', async () => {
    await runTest({"suite":"exclude","test":"exclude-gender"}, "5.0");
  });

  it("exclude-gender2" + 'R5-cached', async () => {
    await runTest({"suite":"exclude","test":"exclude-gender2"}, "5.0");
  });

});

describe('search', () => {
  // Tests for proper functioning of text search. Note what we're not interested in the implementation of the text search itself, so we only test very obvious results. We're just interested in testing support for the parameter

  it("search-all-yes" + 'R5-cached', async () => {
    await runTest({"suite":"search","test":"search-all-yes"}, "5.0");
  });

  it("search-all-no" + 'R5-cached', async () => {
    await runTest({"suite":"search","test":"search-all-no"}, "5.0");
  });

  it("search-filter-yes" + 'R5-cached', async () => {
    await runTest({"suite":"search","test":"search-filter-yes"}, "5.0");
  });

  it("search-filter-no" + 'R5-cached', async () => {
    await runTest({"suite":"search","test":"search-filter-no"}, "5.0");
  });

  it("search-enum-yes" + 'R5-cached', async () => {
    await runTest({"suite":"search","test":"search-enum-yes"}, "5.0");
  });

  it("search-enum-no" + 'R5-cached', async () => {
    await runTest({"suite":"search","test":"search-enum-no"}, "5.0");
  });

});

describe('default-valueset-version', () => {
  // Test the default-valueset-version parameter

  it("direct-expand-one" + 'R5-cached', async () => {
    await runTest({"suite":"default-valueset-version","test":"direct-expand-one"}, "5.0");
  });

  it("direct-expand-two" + 'R5-cached', async () => {
    await runTest({"suite":"default-valueset-version","test":"direct-expand-two"}, "5.0");
  });

  it("indirect-expand-one" + 'R5-cached', async () => {
    await runTest({"suite":"default-valueset-version","test":"indirect-expand-one"}, "5.0");
  });

  it("indirect-expand-two" + 'R5-cached', async () => {
    await runTest({"suite":"default-valueset-version","test":"indirect-expand-two"}, "5.0");
  });

  it("indirect-expand-zero" + 'R5-cached', async () => {
    await runTest({"suite":"default-valueset-version","test":"indirect-expand-zero"}, "5.0");
  });

  it("indirect-expand-zero-pinned" + 'R5-cached', async () => {
    await runTest({"suite":"default-valueset-version","test":"indirect-expand-zero-pinned"}, "5.0");
  });

  it("indirect-expand-zero-pinned-wrong" + 'R5-cached', async () => {
    await runTest({"suite":"default-valueset-version","test":"indirect-expand-zero-pinned-wrong"}, "5.0");
  });

  it("indirect-validation-one" + 'R5-cached', async () => {
    await runTest({"suite":"default-valueset-version","test":"indirect-validation-one"}, "5.0");
  });

  it("indirect-validation-two" + 'R5-cached', async () => {
    await runTest({"suite":"default-valueset-version","test":"indirect-validation-two"}, "5.0");
  });

  it("indirect-validation-zero" + 'R5-cached', async () => {
    await runTest({"suite":"default-valueset-version","test":"indirect-validation-zero"}, "5.0");
  });

  it("indirect-validation-zero-pinned" + 'R5-cached', async () => {
    await runTest({"suite":"default-valueset-version","test":"indirect-validation-zero-pinned"}, "5.0");
  });

  it("indirect-validation-zero-pinned-wrong" + 'R5-cached', async () => {
    await runTest({"suite":"default-valueset-version","test":"indirect-validation-zero-pinned-wrong"}, "5.0");
  });

});

describe('tx.fhir.org', () => {
  // These are tx.fhir.org specific tests. There's no expectation that other servers will pass these tests, and they are not executed by default. (other servers can, but they depend on other set up not controlled by the tests

  it("snomed-validation-1" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-validation-1"}, "5.0");
  });

  it("loinc-lookup-code" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-lookup-code"}, "5.0");
  });

  it("loinc-lookup-part" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-lookup-part"}, "5.0");
  });

  it("loinc-lookup-list" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-lookup-list"}, "5.0");
  });

  it("loinc-lookup-answer" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-lookup-answer"}, "5.0");
  });

  it("loinc-validate-code" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-code"}, "5.0");
  });

  it("loinc-validate-code-uz" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-code-uz"}, "5.0");
  });

  it("loinc-validate-discouraged-code" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-discouraged-code"}, "5.0");
  });

  it("loinc-validate-code-supp1" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-code-supp1"}, "5.0");
  });

  it("loinc-validate-code-supp2" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-code-supp2"}, "5.0");
  });

  it("loinc-validate-part" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-part"}, "5.0");
  });

  it("loinc-validate-list" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-list"}, "5.0");
  });

  it("loinc-validate-answer" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-answer"}, "5.0");
  });

  it("loinc-validate-invalid" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-invalid"}, "5.0");
  });

  it("loinc-expand-enum" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-enum"}, "5.0");
  });

  it("loinc-expand-all" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-all"}, "5.0");
  });

  it("hgvs-expand-all" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"hgvs-expand-all"}, "5.0");
  });

  it("loinc-expand-all-limited" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-all-limited"}, "5.0");
  });

  it("loinc-expand-enum-bad" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-enum-bad"}, "5.0");
  });

  it("loinc-expand-status" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-status"}, "5.0");
  });

  it("loinc-expand-parent" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-parent"}, "5.0");
  });

  it("loinc-expand-class-regex" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-class-regex"}, "5.0");
  });

  it("loinc-expand-prop-component" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-prop-component"}, "5.0");
  });

  it("loinc-expand-prop-method" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-prop-method"}, "5.0");
  });

  it("loinc-expand-prop-component-str" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-prop-component-str"}, "5.0");
  });

  it("loinc-expand-prop-order-obs" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-prop-order-obs"}, "5.0");
  });

  it("loinc-expand-concept-is-a" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-concept-is-a"}, "5.0");
  });

  it("loinc-expand-copyright" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-copyright"}, "5.0");
  });

  it("loinc-expand-scale-type" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-scale-type"}, "5.0");
  });

  it("loinc-validate-enum-good" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-enum-good"}, "5.0");
  });

  it("loinc-validate-enum-bad" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-enum-bad"}, "5.0");
  });

  it("loinc-validate-filter-prop-component-good" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-filter-prop-component-good"}, "5.0");
  });

  it("loinc-validate-filter-prop-component-bad" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-filter-prop-component-bad"}, "5.0");
  });

  it("loinc-validate-filter-status-good" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-filter-status-good"}, "5.0");
  });

  it("loinc-validate-filter-status-bad" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-filter-status-bad"}, "5.0");
  });

  it("loinc-validate-filter-class-regex-good" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-filter-class-regex-good"}, "5.0");
  });

  it("loinc-validate-filter-class-regex-bad" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-filter-class-regex-bad"}, "5.0");
  });

  it("loinc-validate-filter-scale-type-good" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-filter-scale-type-good"}, "5.0");
  });

  it("loinc-validate-filter-scale-type-bad" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-filter-scale-type-bad"}, "5.0");
  });

  it("loinc-expand-list-request-parameters" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-list-request-parameters"}, "5.0");
  });

  it("loinc-validate-list-good" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-list-good"}, "5.0");
  });

  it("loinc-validate-list-bad" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-list-bad"}, "5.0");
  });

  it("loinc-expand-filter-list-request-parameters" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-filter-list-request-parameters"}, "5.0");
  });

  it("loinc-validate-filter-list-type-good" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-filter-list-type-good"}, "5.0");
  });

  it("loinc-validate-filter-list-bad" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-filter-list-bad"}, "5.0");
  });

  it("loinc-expand-filter-dockind-request-parameters" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-filter-dockind-request-parameters"}, "5.0");
  });

  it("loinc-validate-filter-dockind-type-good" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-filter-dockind-type-good"}, "5.0");
  });

  it("loinc-validate-filter-dockind-bad" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-filter-dockind-bad"}, "5.0");
  });

  it("loinc-validate-filter-classtype-good" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-filter-classtype-good"}, "5.0");
  });

  it("loinc-validate-filter-classtype-bad" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-validate-filter-classtype-bad"}, "5.0");
  });

  it("loinc-expand-filter-answers-for1" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-filter-answers-for1"}, "5.0");
  });

  it("loinc-expand-filter-answers-for2" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-filter-answers-for2"}, "5.0");
  });

  it("loinc-expand-filter-answer-list" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-expand-filter-answer-list"}, "5.0");
  });

  it("snomed-expand-active" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-expand-active"}, "5.0");
  });

  it("snomed-expand-inactive" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-expand-inactive"}, "5.0");
  });

  it("snomed-expand-inactive2" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-expand-inactive2"}, "5.0");
  });

  it("snomed-expand-moduleid-1" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-expand-moduleid-1"}, "5.0");
  });

  it("snomed-expand-moduleid-2" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-expand-moduleid-2"}, "5.0");
  });

  it("snomed-expand-moduleid-3" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-expand-moduleid-3"}, "5.0");
  });

  it("snomed-expand-moduleid-4" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-expand-moduleid-4"}, "5.0");
  });

  it("snomed-expand-property-1" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-expand-property-1"}, "5.0");
  });

  it("snomed-expand-property-2" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-expand-property-2"}, "5.0");
  });

  it("snomed-validate-active-bad" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-validate-active-bad"}, "5.0");
  });

  it("snomed-validate-active-good" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-validate-active-good"}, "5.0");
  });

  it("snomed-validate-inactive-bad" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-validate-inactive-bad"}, "5.0");
  });

  it("snomed-validate-inactive-good" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-validate-inactive-good"}, "5.0");
  });

  it("snomed-validate-moduleid-bad" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-validate-moduleid-bad"}, "5.0");
  });

  it("snomed-validate-moduleid-good" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-validate-moduleid-good"}, "5.0");
  });

  it("snomed-validate-property-bad" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-validate-property-bad"}, "5.0");
  });

  it("snomed-validate-property-good" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-validate-property-good"}, "5.0");
  });

  it("snomed-translate" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"snomed-translate"}, "5.0");
  });

  it("loinc-subsumes-equivalent" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-subsumes-equivalent"}, "5.0");
  });

  it("loinc-subsumes-parent" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-subsumes-parent"}, "5.0");
  });

  it("loinc-subsumes-child" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-subsumes-child"}, "5.0");
  });

  it("loinc-subsumes-unrelated" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-subsumes-unrelated"}, "5.0");
  });

  it("loinc-subsumes-unknown-code" + 'R5-cached', async () => {
    await runTest({"suite":"tx.fhir.org","test":"loinc-subsumes-unknown-code"}, "5.0");
  });

});

describe('snomed', () => {
  // This snomed tests are based on the testing subset in the tx-ecosystem IG github repo (see /tx-source)

  it("snomed-inactive-display-lenient" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"snomed-inactive-display-lenient"}, "5.0");
  });

  it("snomed-inactive-display-notlenient" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"snomed-inactive-display-notlenient"}, "5.0");
  });

  it("snomed-isa-in" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"snomed-isa-in"}, "5.0");
  });

  it("snomed-isa-out" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"snomed-isa-out"}, "5.0");
  });

  it("snomed-expand-inactive" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"snomed-expand-inactive"}, "5.0");
  });

  it("snomed-expand-isa" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"snomed-expand-isa"}, "5.0");
  });

  it("snomed-expand-count-all" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"snomed-expand-count-all"}, "5.0");
  });

  it("snomed-expand-too-big" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"snomed-expand-too-big"}, "5.0");
  });

  it("lookup" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"lookup"}, "5.0");
  });

  it("lookup-pc" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"lookup-pc"}, "5.0");
  });

  it("validate-code-pc-good" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-good"}, "5.0");
  });

  it("validate-code-pc-bad1" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-bad1"}, "5.0");
  });

  it("validate-code-pc-bad2" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-bad2"}, "5.0");
  });

  it("validate-code-pc-nested-good" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-nested-good"}, "5.0");
  });

  it("validate-code-pc-mrcm-lateralizable" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-mrcm-lateralizable"}, "5.0");
  });

  it("validate-code-pc-mrcm-domain" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-mrcm-domain"}, "5.0");
  });

  it("validate-code-pc-mrcm-range" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-mrcm-range"}, "5.0");
  });

  it("validate-code-pc-mrcm-cardinality" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-mrcm-cardinality"}, "5.0");
  });

  it("validate-code-pc-mrcm-grouped" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-mrcm-grouped"}, "5.0");
  });

  it("validate-code-pc-concrete-good" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-concrete-good"}, "5.0");
  });

  it("validate-code-pc-scg-no-comma" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-scg-no-comma"}, "5.0");
  });

  it("validate-code-pc-scg-comma" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-scg-comma"}, "5.0");
  });

  it("validate-code-pc-mrcm-concrete-range" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-mrcm-concrete-range"}, "5.0");
  });

  it("validate-code-pc-mrcm-concrete-int" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-mrcm-concrete-int"}, "5.0");
  });

  it("validate-code-pc-mrcm-concrete-wanted" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-mrcm-concrete-wanted"}, "5.0");
  });

  it("validate-code-pc-mrcm-concept-wanted" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-mrcm-concept-wanted"}, "5.0");
  });

  it("validate-code-pc-none" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-none"}, "5.0");
  });

  it("validate-code-pc-list" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-list"}, "5.0");
  });

  it("validate-code-pc-list-bad" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-list-bad"}, "5.0");
  });

  it("validate-code-pc-filter" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"validate-code-pc-filter"}, "5.0");
  });

  it("expand-pc-none" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"expand-pc-none"}, "5.0");
  });

  it("expand-pc-list" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"expand-pc-list"}, "5.0");
  });

  it("expand-pc-filter" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"expand-pc-filter"}, "5.0");
  });

  it("validate-code-implied-1" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"validate-code-implied-1"}, "5.0");
  });

  it("validate-code-implied-1b" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"validate-code-implied-1b"}, "5.0");
  });

  it("validate-code-implied-2" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"validate-code-implied-2"}, "5.0");
  });

  it("validate-code-implied-2b" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"validate-code-implied-2b"}, "5.0");
  });

  it("subsumes-simple" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"subsumes-simple"}, "5.0");
  });

  it("subsumes-parent" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"subsumes-parent"}, "5.0");
  });

  it("subsumes-equivalent" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"subsumes-equivalent"}, "5.0");
  });

  it("subsumes-transitive" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"subsumes-transitive"}, "5.0");
  });

  it("subsumes-siblings" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"subsumes-siblings"}, "5.0");
  });

  it("subsumes-disjoint" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"subsumes-disjoint"}, "5.0");
  });

  it("subsumes-coding" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"subsumes-coding"}, "5.0");
  });

  it("subsumes-unknown-code-a" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"subsumes-unknown-code-a"}, "5.0");
  });

  it("subsumes-unknown-code-b" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"subsumes-unknown-code-b"}, "5.0");
  });

  it("subsumes-invalid-code" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"subsumes-invalid-code"}, "5.0");
  });

  it("subsumes-bad-version" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"subsumes-bad-version"}, "5.0");
  });

  it("subsumes-bad-system" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"subsumes-bad-system"}, "5.0");
  });

  it("subsumes-expr-refined-vs-parent" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-refined-vs-parent"}, "5.0");
  });

  it("subsumes-expr-parent-vs-refined" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-parent-vs-refined"}, "5.0");
  });

  it("subsumes-expr-vs-focus" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-vs-focus"}, "5.0");
  });

  it("subsumes-expr-attr-value" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-attr-value"}, "5.0");
  });

  it("subsumes-expr-attr-value-reverse" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-attr-value-reverse"}, "5.0");
  });

  it("subsumes-expr-attr-unrelated" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-attr-unrelated"}, "5.0");
  });

  it("subsumes-expr-extra-attribute" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-extra-attribute"}, "5.0");
  });

  it("subsumes-expr-different-attributes" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-different-attributes"}, "5.0");
  });

  it("subsumes-expr-primitive-focus" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-primitive-focus"}, "5.0");
  });

  it("subsumes-expr-normal-form" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-normal-form"}, "5.0");
  });

  it("subsumes-expr-redundant-refinement" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-redundant-refinement"}, "5.0");
  });

  it("subsumes-expr-grouped-ungrouped" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-grouped-ungrouped"}, "5.0");
  });

  it("subsumes-expr-ungrouped-morphology" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-ungrouped-morphology"}, "5.0");
  });

  it("subsumes-expr-ungrouped-laterality" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-ungrouped-laterality"}, "5.0");
  });

  it("subsumes-expr-with-terms" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-with-terms"}, "5.0");
  });

  it("subsumes-expr-conjunction" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-conjunction"}, "5.0");
  });

  it("subsumes-expr-precoordinated-match" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-precoordinated-match"}, "5.0");
  });

  it("subsumes-expr-subsumes-precoordinated" + 'R5-cached', async () => {
    await runTest({"suite":"snomed","test":"subsumes-expr-subsumes-precoordinated"}, "5.0");
  });

});

describe('sct-ecl', () => {
  // SNOMED CT ECL tests (expand + validate-code), split out of the snomed suite for manageability. Files live in sct/ecl/.

  it("snomed-validate-ecl-descendents-code-in" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-descendents-code-in"}, "5.0");
  });

  it("snomed-validate-ecl-descendents-code-out" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-descendents-code-out"}, "5.0");
  });

  it("snomed-validate-ecl-descendents-expr-in" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-descendents-expr-in"}, "5.0");
  });

  it("snomed-validate-ecl-descendents-expr-out" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-descendents-expr-out"}, "5.0");
  });

  it("snomed-validate-ecl-descOrSelf-code-in" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-descOrSelf-code-in"}, "5.0");
  });

  it("snomed-validate-ecl-descOrSelf-code-out" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-descOrSelf-code-out"}, "5.0");
  });

  it("snomed-validate-ecl-descOrSelf-expr-in" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-descOrSelf-expr-in"}, "5.0");
  });

  it("snomed-validate-ecl-descOrSelf-expr-out" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-descOrSelf-expr-out"}, "5.0");
  });

  it("snomed-validate-ecl-children-code-in" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-children-code-in"}, "5.0");
  });

  it("snomed-validate-ecl-children-code-out" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-children-code-out"}, "5.0");
  });

  it("snomed-validate-ecl-children-expr-in" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-children-expr-in"}, "5.0");
  });

  it("snomed-validate-ecl-children-expr-out" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-children-expr-out"}, "5.0");
  });

  it("snomed-validate-ecl-childrenOrSelf-code-in" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-childrenOrSelf-code-in"}, "5.0");
  });

  it("snomed-validate-ecl-childrenOrSelf-code-out" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-childrenOrSelf-code-out"}, "5.0");
  });

  it("snomed-validate-ecl-childrenOrSelf-expr-in" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-childrenOrSelf-expr-in"}, "5.0");
  });

  it("snomed-validate-ecl-childrenOrSelf-expr-out" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-childrenOrSelf-expr-out"}, "5.0");
  });

  it("snomed-validate-ecl-ancestors-code-in" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-ancestors-code-in"}, "5.0");
  });

  it("snomed-validate-ecl-ancestors-code-out" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-ancestors-code-out"}, "5.0");
  });

  it("snomed-validate-ecl-ancestors-expr-out" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-ancestors-expr-out"}, "5.0");
  });

  it("snomed-validate-ecl-ancOrSelf-code-in" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-ancOrSelf-code-in"}, "5.0");
  });

  it("snomed-validate-ecl-ancOrSelf-code-out" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-ancOrSelf-code-out"}, "5.0");
  });

  it("snomed-validate-ecl-ancOrSelf-expr-out" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-ancOrSelf-expr-out"}, "5.0");
  });

  it("snomed-validate-ecl-parents-code-in" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-parents-code-in"}, "5.0");
  });

  it("snomed-validate-ecl-parents-code-out" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-parents-code-out"}, "5.0");
  });

  it("snomed-validate-ecl-parents-expr-out" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-parents-expr-out"}, "5.0");
  });

  it("snomed-validate-ecl-parentsOrSelf-code-in" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-parentsOrSelf-code-in"}, "5.0");
  });

  it("snomed-validate-ecl-parentsOrSelf-code-out" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-parentsOrSelf-code-out"}, "5.0");
  });

  it("snomed-validate-ecl-parentsOrSelf-expr-out" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-parentsOrSelf-expr-out"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-simple-code-in" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-simple-code-in"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-simple-code-out" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-simple-code-out"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-simple-expr-in" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-simple-expr-in"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-simple-expr-out" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-simple-expr-out"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-group-code-out" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-group-code-out"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-group-expr-in" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-group-expr-in"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-group-expr-out" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-group-expr-out"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-morphology-code-in" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-morphology-code-in"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-morphology-code-out" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-morphology-code-out"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-morphology-expr-in" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-morphology-expr-in"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-morphology-expr-out" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-morphology-expr-out"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-wildcard-code-in" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-wildcard-code-in"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-wildcard-code-out" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-wildcard-code-out"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-wildcard-expr-in" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-wildcard-expr-in"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-wildcard-expr-out" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-wildcard-expr-out"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-cardinality-code-in" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-cardinality-code-in"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-cardinality-code-out" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-cardinality-code-out"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-cardinality-expr-in" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-cardinality-expr-in"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-cardinality-expr-out" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-cardinality-expr-out"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-cardinality-grouped-code-in" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-cardinality-grouped-code-in"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-cardinality-grouped-code-out" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-cardinality-grouped-code-out"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-cardinality-grouped-expr-in" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-cardinality-grouped-expr-in"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-cardinality-grouped-expr-out" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-cardinality-grouped-expr-out"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-cardinality-rolegroup-code-in" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-cardinality-rolegroup-code-in"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-cardinality-rolegroup-code-out" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-cardinality-rolegroup-code-out"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-cardinality-rolegroup-expr-in" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-cardinality-rolegroup-expr-in"}, "5.0");
  });

  it("snomed-validate-ecl-refinement-cardinality-rolegroup-expr-out" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-refinement-cardinality-rolegroup-expr-out"}, "5.0");
  });

  it("snomed-validate-ecl-memberOf-refset-code-in" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-memberOf-refset-code-in"}, "5.0");
  });

  it("snomed-validate-ecl-memberOf-refset-code-out" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-memberOf-refset-code-out"}, "5.0");
  });

  it("snomed-validate-ecl-memberOf-refset-expr-out" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-memberOf-refset-expr-out"}, "5.0");
  });

  it("snomed-validate-ecl-minus-code-in" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-minus-code-in"}, "5.0");
  });

  it("snomed-validate-ecl-minus-code-out" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-minus-code-out"}, "5.0");
  });

  it("snomed-validate-ecl-minus-expr-in" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-minus-expr-in"}, "5.0");
  });

  it("snomed-validate-ecl-minus-expr-out" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-minus-expr-out"}, "5.0");
  });

  it("snomed-validate-ecl-wildcard-code-in" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-wildcard-code-in"}, "5.0");
  });

  it("snomed-validate-ecl-wildcard-expr-in" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-wildcard-expr-in"}, "5.0");
  });

  it("snomed-validate-ecl-wildcard-minus-code-in" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-wildcard-minus-code-in"}, "5.0");
  });

  it("snomed-validate-ecl-wildcard-minus-code-out" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-wildcard-minus-code-out"}, "5.0");
  });

  it("snomed-validate-ecl-wildcard-minus-expr-in" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-wildcard-minus-expr-in"}, "5.0");
  });

  it("snomed-validate-ecl-wildcard-minus-expr-out" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-validate-ecl-wildcard-minus-expr-out"}, "5.0");
  });

  it("snomed-expand-ecl-descOrSelf" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-descOrSelf"}, "5.0");
  });

  it("snomed-expand-ecl-descendents" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-descendents"}, "5.0");
  });

  it("snomed-expand-ecl-ancestors" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-ancestors"}, "5.0");
  });

  it("snomed-expand-ecl-ancOrSelf" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-ancOrSelf"}, "5.0");
  });

  it("snomed-expand-ecl-childrenOrSelf" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-childrenOrSelf"}, "5.0");
  });

  it("snomed-expand-ecl-children" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-children"}, "5.0");
  });

  it("snomed-expand-ecl-parents" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-parents"}, "5.0");
  });

  it("snomed-expand-ecl-parentsOrSelf" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-parentsOrSelf"}, "5.0");
  });

  it("snomed-expand-ecl-wildcard" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-wildcard"}, "5.0");
  });

  it("snomed-expand-ecl-memberOf-refset" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-memberOf-refset"}, "5.0");
  });

  it("snomed-expand-ecl-memberOf-nonRefset" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-memberOf-nonRefset"}, "5.0");
  });

  it("snomed-expand-ecl-or" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-or"}, "5.0");
  });

  it("snomed-expand-ecl-and" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-and"}, "5.0");
  });

  it("snomed-expand-ecl-minus" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-minus"}, "5.0");
  });

  it("snomed-expand-ecl-minus-empty" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-minus-empty"}, "5.0");
  });

  it("snomed-expand-ecl-wildcard-minus" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-wildcard-minus"}, "5.0");
  });

  it("snomed-expand-ecl-grouped-or" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-grouped-or"}, "5.0");
  });

  it("snomed-expand-ecl-grouped-and" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-grouped-and"}, "5.0");
  });

  it("snomed-expand-ecl-ambiguous-precedence" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-ambiguous-precedence"}, "5.0");
  });

  it("snomed-expand-ecl-term-match" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-term-match"}, "5.0");
  });

  it("snomed-expand-ecl-term-mismatch" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-term-mismatch"}, "5.0");
  });

  it("snomed-expand-ecl-term-with-operator" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-term-with-operator"}, "5.0");
  });

  it("snomed-expand-ecl-unknown-concept" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-unknown-concept"}, "5.0");
  });

  it("snomed-expand-ecl-invalid-sctid" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-invalid-sctid"}, "5.0");
  });

  it("snomed-expand-ecl-missing-focus" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-missing-focus"}, "5.0");
  });

  it("snomed-expand-ecl-trailing-tokens" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-trailing-tokens"}, "5.0");
  });

  it("snomed-expand-ecl-nested-parens" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-nested-parens"}, "5.0");
  });

  it("snomed-expand-ecl-refinement-simple" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-refinement-simple"}, "5.0");
  });

  it("snomed-expand-ecl-refinement-morphology" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-refinement-morphology"}, "5.0");
  });

  it("snomed-expand-ecl-refinement-wildcard" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-refinement-wildcard"}, "5.0");
  });

  it("snomed-expand-ecl-refinement-group" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-refinement-group"}, "5.0");
  });

  it("snomed-expand-ecl-refinement-cardinality" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-refinement-cardinality"}, "5.0");
  });

  it("snomed-expand-ecl-refinement-cardinality-grouped" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-refinement-cardinality-grouped"}, "5.0");
  });

  it("snomed-expand-ecl-refinement-cardinality-rolegroup" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-refinement-cardinality-rolegroup"}, "5.0");
  });

  it("snomed-expand-ecl-dotted" + 'R5-cached', async () => {
    await runTest({"suite":"sct-ecl","test":"snomed-expand-ecl-dotted"}, "5.0");
  });

});

describe('batch', () => {
  // Test Batch Validation

  it("batch-validate" + 'R5-cached', async () => {
    await runTest({"suite":"batch","test":"batch-validate"}, "5.0");
  });

  it("batch-validate-bad" + 'R5-cached', async () => {
    await runTest({"suite":"batch","test":"batch-validate-bad"}, "5.0");
  });

});

describe('omop', () => {
  // Tests for OMOP implementations. Note that some servers only do OMOP (and some don't). The tests are based on a stable subset of OMOP maintained by Davera Gabriel

  it("omop-basic-validation-code-good" + 'R5-cached', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-code-good"}, "5.0");
  });

  it("omop-basic-validation-coding-good" + 'R5-cached', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-coding-good"}, "5.0");
  });

  it("omop-basic-validation-codeableconcept-good" + 'R5-cached', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-codeableconcept-good"}, "5.0");
  });

  it("omop-basic-validation-code-bad" + 'R5-cached', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-code-bad"}, "5.0");
  });

  it("omop-basic-validation-coding-bad" + 'R5-cached', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-coding-bad"}, "5.0");
  });

  it("omop-basic-validation-codeableconcept-bad" + 'R5-cached', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-codeableconcept-bad"}, "5.0");
  });

  it("omop-basic-validation-code-bad-display" + 'R5-cached', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-code-bad-display"}, "5.0");
  });

  it("omop-basic-validation-coding-bad-display" + 'R5-cached', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-coding-bad-display"}, "5.0");
  });

  it("omop-basic-validation-codeableconcept-bad-display" + 'R5-cached', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-codeableconcept-bad-display"}, "5.0");
  });

  it("omop-basic-validation-code-bad-version" + 'R5-cached', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-code-bad-version"}, "5.0");
  });

  it("omop-basic-validation-coding-bad-version" + 'R5-cached', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-coding-bad-version"}, "5.0");
  });

  it("omop-basic-validation-codeableconcept-bad-version" + 'R5-cached', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-codeableconcept-bad-version"}, "5.0");
  });

  it("omop-basic-validation-code-good-vs" + 'R5-cached', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-code-good-vs"}, "5.0");
  });

  it("omop-basic-validation-coding-good-vs" + 'R5-cached', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-coding-good-vs"}, "5.0");
  });

  it("omop-basic-validation-codeableconcept-good-vs" + 'R5-cached', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-codeableconcept-good-vs"}, "5.0");
  });

  it("omop-basic-validation-code-bad-vs" + 'R5-cached', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-code-bad-vs"}, "5.0");
  });

  it("omop-basic-validation-coding-bad-vs" + 'R5-cached', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-coding-bad-vs"}, "5.0");
  });

  it("omop-basic-validation-codeableconcept-bad-vs" + 'R5-cached', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-codeableconcept-bad-vs"}, "5.0");
  });

  it("omop-lookup-code" + 'R5-cached', async () => {
    await runTest({"suite":"omop","test":"omop-lookup-code"}, "5.0");
  });

  it("omop-lookup-code2" + 'R5-cached', async () => {
    await runTest({"suite":"omop","test":"omop-lookup-code2"}, "5.0");
  });

  it("omop-lookup-code3" + 'R5-cached', async () => {
    await runTest({"suite":"omop","test":"omop-lookup-code3"}, "5.0");
  });

  it("omop-basic-validation-code-good-vs-url" + 'R5-cached', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-code-good-vs-url"}, "5.0");
  });

  it("omop-basic-validation-code-bad-vs-url" + 'R5-cached', async () => {
    await runTest({"suite":"omop","test":"omop-basic-validation-code-bad-vs-url"}, "5.0");
  });

  it("omop-expand-explicit" + 'R5-cached', async () => {
    await runTest({"suite":"omop","test":"omop-expand-explicit"}, "5.0");
  });

  it("translate-loinc-implicit" + 'R5-cached', async () => {
    await runTest({"suite":"omop","test":"translate-loinc-implicit"}, "5.0");
  });

  it("translate-loinc-implicit-bad" + 'R5-cached', async () => {
    await runTest({"suite":"omop","test":"translate-loinc-implicit-bad"}, "5.0");
  });

});

describe('UCUM', () => {
  // UCUM Test Cases

  it("lookup" + 'R5-cached', async () => {
    await runTest({"suite":"UCUM","test":"lookup"}, "5.0");
  });

  it("lookup-with-annotation" + 'R5-cached', async () => {
    await runTest({"suite":"UCUM","test":"lookup-with-annotation"}, "5.0");
  });

  it("expand-ucum-all-4" + 'R4-cached', async () => {
    await runTest({"suite":"UCUM","test":"expand-ucum-all-4"}, "4.0");
  });

  it("expand-ucum-all-5" + 'R5-cached', async () => {
    await runTest({"suite":"UCUM","test":"expand-ucum-all-5"}, "5.0");
  });

  it("expand-ucum-canonical" + 'R5-cached', async () => {
    await runTest({"suite":"UCUM","test":"expand-ucum-canonical"}, "5.0");
  });

  it("validate-ucum-canonical-good" + 'R5-cached', async () => {
    await runTest({"suite":"UCUM","test":"validate-ucum-canonical-good"}, "5.0");
  });

  it("validate-ucum-canonical-bad" + 'R5-cached', async () => {
    await runTest({"suite":"UCUM","test":"validate-ucum-canonical-bad"}, "5.0");
  });

  it("validate-all-canonical-good" + 'R5-cached', async () => {
    await runTest({"suite":"UCUM","test":"validate-all-canonical-good"}, "5.0");
  });

  it("validate-ucum-all-bad" + 'R5-cached', async () => {
    await runTest({"suite":"UCUM","test":"validate-ucum-all-bad"}, "5.0");
  });

  it("ucum-subsumes-equivalent" + 'R5-cached', async () => {
    await runTest({"suite":"UCUM","test":"ucum-subsumes-equivalent"}, "5.0");
  });

  it("ucum-subsumes-canonical" + 'R5-cached', async () => {
    await runTest({"suite":"UCUM","test":"ucum-subsumes-canonical"}, "5.0");
  });

  it("ucum-subsumes-unrelated" + 'R5-cached', async () => {
    await runTest({"suite":"UCUM","test":"ucum-subsumes-unrelated"}, "5.0");
  });

  it("ucum-subsumes-scaled" + 'R5-cached', async () => {
    await runTest({"suite":"UCUM","test":"ucum-subsumes-scaled"}, "5.0");
  });

  it("ucum-subsumes-invalid-code" + 'R5-cached', async () => {
    await runTest({"suite":"UCUM","test":"ucum-subsumes-invalid-code"}, "5.0");
  });

  it("ucum-subsumes-annotation" + 'R5-cached', async () => {
    await runTest({"suite":"UCUM","test":"ucum-subsumes-annotation"}, "5.0");
  });

  it("ucum-subsumes-derived" + 'R5-cached', async () => {
    await runTest({"suite":"UCUM","test":"ucum-subsumes-derived"}, "5.0");
  });

  it("ucum-subsumes-offset" + 'R5-cached', async () => {
    await runTest({"suite":"UCUM","test":"ucum-subsumes-offset"}, "5.0");
  });

  it("ucum-subsumes-same-canonical" + 'R5-cached', async () => {
    await runTest({"suite":"UCUM","test":"ucum-subsumes-same-canonical"}, "5.0");
  });

  it("ucum-subsumes-both-scaled" + 'R5-cached', async () => {
    await runTest({"suite":"UCUM","test":"ucum-subsumes-both-scaled"}, "5.0");
  });

  it("ucum-subsumes-dimensionless" + 'R5-cached', async () => {
    await runTest({"suite":"UCUM","test":"ucum-subsumes-dimensionless"}, "5.0");
  });

});

describe('mimetypes', () => {
  // Tests for the mime types code system (BCP 13). Type and subtype have no hierarchy, but parameters narrow a media type, and the base filter selects by type or type/subtype

  it("mimetype-subsumes-equivalent" + 'R5-cached', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-equivalent"}, "5.0");
  });

  it("mimetype-subsumes-unrelated" + 'R5-cached', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-unrelated"}, "5.0");
  });

  it("mimetype-subsumes-suffix" + 'R5-cached', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-suffix"}, "5.0");
  });

  it("mimetype-subsumes-parameter" + 'R5-cached', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-parameter"}, "5.0");
  });

  it("mimetype-subsumes-parameter-reverse" + 'R5-cached', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-parameter-reverse"}, "5.0");
  });

  it("mimetype-subsumes-parameter-siblings" + 'R5-cached', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-parameter-siblings"}, "5.0");
  });

  it("mimetype-subsumes-parameter-added" + 'R5-cached', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-parameter-added"}, "5.0");
  });

  it("mimetype-subsumes-parameter-disjoint" + 'R5-cached', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-parameter-disjoint"}, "5.0");
  });

  it("mimetype-subsumes-default-explicit" + 'R5-cached', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-default-explicit"}, "5.0");
  });

  it("mimetype-subsumes-default-contradicted" + 'R5-cached', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-default-contradicted"}, "5.0");
  });

  it("mimetype-subsumes-default-format" + 'R5-cached', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-default-format"}, "5.0");
  });

  it("mimetype-subsumes-charset-unknown-default" + 'R5-cached', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-charset-unknown-default"}, "5.0");
  });

  it("mimetype-subsumes-case" + 'R5-cached', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-case"}, "5.0");
  });

  it("mimetype-subsumes-unknown-parameter" + 'R5-cached', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-unknown-parameter"}, "5.0");
  });

  it("mimetype-subsumes-unknown-parameter-value" + 'R5-cached', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-unknown-parameter-value"}, "5.0");
  });

  it("mimetype-subsumes-unknown-parameter-shared" + 'R5-cached', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-unknown-parameter-shared"}, "5.0");
  });

  it("mimetype-subsumes-invalid-code" + 'R5-cached', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-subsumes-invalid-code"}, "5.0");
  });

  it("mimetype-filter-base-type-in" + 'R5-cached', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-filter-base-type-in"}, "5.0");
  });

  it("mimetype-filter-base-type-params" + 'R5-cached', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-filter-base-type-params"}, "5.0");
  });

  it("mimetype-filter-base-type-other-subtype" + 'R5-cached', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-filter-base-type-other-subtype"}, "5.0");
  });

  it("mimetype-filter-base-type-out" + 'R5-cached', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-filter-base-type-out"}, "5.0");
  });

  it("mimetype-filter-base-subtype-in" + 'R5-cached', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-filter-base-subtype-in"}, "5.0");
  });

  it("mimetype-filter-base-subtype-params" + 'R5-cached', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-filter-base-subtype-params"}, "5.0");
  });

  it("mimetype-filter-base-subtype-out" + 'R5-cached', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-filter-base-subtype-out"}, "5.0");
  });

  it("mimetype-filter-registered-in" + 'R5-cached', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-filter-registered-in"}, "5.0");
  });

  it("mimetype-filter-registered-params" + 'R5-cached', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-filter-registered-params"}, "5.0");
  });

  it("mimetype-filter-registered-out" + 'R5-cached', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-filter-registered-out"}, "5.0");
  });

  it("mimetype-filter-unregistered-in" + 'R5-cached', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-filter-unregistered-in"}, "5.0");
  });

  it("mimetype-filter-unregistered-out" + 'R5-cached', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-filter-unregistered-out"}, "5.0");
  });

  it("mimetype-filter-registered-params-out" + 'R5-cached', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-filter-registered-params-out"}, "5.0");
  });

  it("mimetype-filter-unregistered-params-in" + 'R5-cached', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-filter-unregistered-params-in"}, "5.0");
  });

  it("mimetype-filter-unregistered-params-out" + 'R5-cached', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-filter-unregistered-params-out"}, "5.0");
  });

  it("mimetype-expand-enumerated" + 'R5-cached', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-expand-enumerated"}, "5.0");
  });

  it("mimetype-expand-all" + 'R5-cached', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-expand-all"}, "5.0");
  });

  it("mimetype-expand-base" + 'R5-cached', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-expand-base"}, "5.0");
  });

  it("mimetype-expand-unregistered" + 'R5-cached', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-expand-unregistered"}, "5.0");
  });

  it("mimetype-expand-registered-narrow" + 'R5-cached', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-expand-registered-narrow"}, "5.0");
  });

  it("mimetype-expand-registered-too-costly" + 'R5-cached', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-expand-registered-too-costly"}, "5.0");
  });

  it("mimetype-expand-registered-paged" + 'R5-cached', async () => {
    await runTest({"suite":"mimetypes","test":"mimetype-expand-registered-paged"}, "5.0");
  });

});

describe('compare', () => {
  // Tests for candidate new 'related' operation

  it("related-all" + 'R5-cached', async () => {
    await runTest({"suite":"compare","test":"related-all"}, "5.0");
  });

  it("related-active" + 'R5-cached', async () => {
    await runTest({"suite":"compare","test":"related-active"}, "5.0");
  });

  it("related-inactive" + 'R5-cached', async () => {
    await runTest({"suite":"compare","test":"related-inactive"}, "5.0");
  });

  it("related-enumerated" + 'R5-cached', async () => {
    await runTest({"suite":"compare","test":"related-enumerated"}, "5.0");
  });

  it("related-is-a" + 'R5-cached', async () => {
    await runTest({"suite":"compare","test":"related-is-a"}, "5.0");
  });

  it("related-regex-1" + 'R5-cached', async () => {
    await runTest({"suite":"compare","test":"related-regex-1"}, "5.0");
  });

  it("related-regex-2" + 'R5-cached', async () => {
    await runTest({"suite":"compare","test":"related-regex-2"}, "5.0");
  });

  it("related-lists" + 'R5-cached', async () => {
    await runTest({"suite":"compare","test":"related-lists"}, "5.0");
  });

  it("related-lists-more" + 'R5-cached', async () => {
    await runTest({"suite":"compare","test":"related-lists-more"}, "5.0");
  });

  it("related-lists-less" + 'R5-cached', async () => {
    await runTest({"suite":"compare","test":"related-lists-less"}, "5.0");
  });

  it("related-lists-over" + 'R5-cached', async () => {
    await runTest({"suite":"compare","test":"related-lists-over"}, "5.0");
  });

  it("related-lists-disj" + 'R5-cached', async () => {
    await runTest({"suite":"compare","test":"related-lists-disj"}, "5.0");
  });

  it("related-systems" + 'R5-cached', async () => {
    await runTest({"suite":"compare","test":"related-systems"}, "5.0");
  });

  it("related-systems" + 'R5-cached', async () => {
    await runTest({"suite":"compare","test":"related-systems"}, "5.0");
  });

  it("related-systems-less" + 'R5-cached', async () => {
    await runTest({"suite":"compare","test":"related-systems-less"}, "5.0");
  });

  it("related-systems-more" + 'R5-cached', async () => {
    await runTest({"suite":"compare","test":"related-systems-more"}, "5.0");
  });

  it("related-system-disj" + 'R5-cached', async () => {
    await runTest({"suite":"compare","test":"related-system-disj"}, "5.0");
  });

  it("related-system-over" + 'R5-cached', async () => {
    await runTest({"suite":"compare","test":"related-system-over"}, "5.0");
  });

  it("related-filters-1" + 'R5-cached', async () => {
    await runTest({"suite":"compare","test":"related-filters-1"}, "5.0");
  });

  it("related-filters-2" + 'R5-cached', async () => {
    await runTest({"suite":"compare","test":"related-filters-2"}, "5.0");
  });

  it("related-filters-3" + 'R5-cached', async () => {
    await runTest({"suite":"compare","test":"related-filters-3"}, "5.0");
  });

  it("related-mixed-1" + 'R5-cached', async () => {
    await runTest({"suite":"compare","test":"related-mixed-1"}, "5.0");
  });

  it("related-mixed-1-less" + 'R5-cached', async () => {
    await runTest({"suite":"compare","test":"related-mixed-1-less"}, "5.0");
  });

  it("related-mixed-1-more" + 'R5-cached', async () => {
    await runTest({"suite":"compare","test":"related-mixed-1-more"}, "5.0");
  });

  it("related-mixed-1-disj" + 'R5-cached', async () => {
    await runTest({"suite":"compare","test":"related-mixed-1-disj"}, "5.0");
  });

  it("related-mixed-1-over" + 'R5-cached', async () => {
    await runTest({"suite":"compare","test":"related-mixed-1-over"}, "5.0");
  });

  it("related-filters-less" + 'R5-cached', async () => {
    await runTest({"suite":"compare","test":"related-filters-less"}, "5.0");
  });

  it("related-filters-more" + 'R5-cached', async () => {
    await runTest({"suite":"compare","test":"related-filters-more"}, "5.0");
  });

});

describe('bugs', () => {
  // A series of tests that deal with discovered bugs in FHIRsmith. These tests are specific to FHIRsmith - internal QA

  it("country-codes" + 'R5-cached', async () => {
    await runTest({"suite":"bugs","test":"country-codes"}, "5.0");
  });

  it("no-system" + 'R5-cached', async () => {
    await runTest({"suite":"bugs","test":"no-system"}, "5.0");
  });

  it("sct-parse" + 'R5-cached', async () => {
    await runTest({"suite":"bugs","test":"sct-parse"}, "5.0");
  });

  it("sct-parse-pc" + 'R5-cached', async () => {
    await runTest({"suite":"bugs","test":"sct-parse-pc"}, "5.0");
  });

  it("lang-case" + 'R5-cached', async () => {
    await runTest({"suite":"bugs","test":"lang-case"}, "5.0");
  });

  it("lang-case2" + 'R5-cached', async () => {
    await runTest({"suite":"bugs","test":"lang-case2"}, "5.0");
  });

  it("provenance" + 'R5-cached', async () => {
    await runTest({"suite":"bugs","test":"provenance"}, "5.0");
  });

  it("country-code" + 'R5-cached', async () => {
    await runTest({"suite":"bugs","test":"country-code"}, "5.0");
  });

  it("sct-msg-4" + 'R4-cached', async () => {
    await runTest({"suite":"bugs","test":"sct-msg-4"}, "4.0");
  });

  it("sct-msg-5" + 'R5-cached', async () => {
    await runTest({"suite":"bugs","test":"sct-msg-5"}, "5.0");
  });

  it("sct-display-1" + 'R5-cached', async () => {
    await runTest({"suite":"bugs","test":"sct-display-1"}, "5.0");
  });

  it("sct-display-2" + 'R5-cached', async () => {
    await runTest({"suite":"bugs","test":"sct-display-2"}, "5.0");
  });

  it("x12-bad" + 'R5-cached', async () => {
    await runTest({"suite":"bugs","test":"x12-bad"}, "5.0");
  });

  it("3166-a" + 'R5-cached', async () => {
    await runTest({"suite":"bugs","test":"3166-a"}, "5.0");
  });

  it("3166-b" + 'R5-cached', async () => {
    await runTest({"suite":"bugs","test":"3166-b"}, "5.0");
  });

  it("3166-c" + 'R5-cached', async () => {
    await runTest({"suite":"bugs","test":"3166-c"}, "5.0");
  });

  it("3166-d" + 'R5-cached', async () => {
    await runTest({"suite":"bugs","test":"3166-d"}, "5.0");
  });

});

describe('permutations', () => {
  // A set of permutations generated by Claude with the goal of increasing test coverage.

  it("bad-cc1-all-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"bad-cc1-all-request"}, "5.0");
  });

  it("bad-cc1-enumerated-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"bad-cc1-enumerated-request"}, "5.0");
  });

  it("bad-cc1-exclude-filter-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"bad-cc1-exclude-filter-request"}, "5.0");
  });

  it("bad-cc1-exclude-import-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"bad-cc1-exclude-import-request"}, "5.0");
  });

  it("bad-cc1-exclude-list-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"bad-cc1-exclude-list-request"}, "5.0");
  });

  it("bad-cc1-import-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"bad-cc1-import-request"}, "5.0");
  });

  it("bad-cc1-isa-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"bad-cc1-isa-request"}, "5.0");
  });

  it("bad-cc2-all-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"bad-cc2-all-request"}, "5.0");
  });

  it("bad-cc2-enumerated-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"bad-cc2-enumerated-request"}, "5.0");
  });

  it("bad-cc2-exclude-filter-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"bad-cc2-exclude-filter-request"}, "5.0");
  });

  it("bad-cc2-exclude-import-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"bad-cc2-exclude-import-request"}, "5.0");
  });

  it("bad-cc2-exclude-list-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"bad-cc2-exclude-list-request"}, "5.0");
  });

  it("bad-cc2-import-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"bad-cc2-import-request"}, "5.0");
  });

  it("bad-cc2-isa-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"bad-cc2-isa-request"}, "5.0");
  });

  it("bad-coding-all-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"bad-coding-all-request"}, "5.0");
  });

  it("bad-coding-enumerated-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"bad-coding-enumerated-request"}, "5.0");
  });

  it("bad-coding-exclude-filter-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"bad-coding-exclude-filter-request"}, "5.0");
  });

  it("bad-coding-exclude-import-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"bad-coding-exclude-import-request"}, "5.0");
  });

  it("bad-coding-exclude-list-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"bad-coding-exclude-list-request"}, "5.0");
  });

  it("bad-coding-import-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"bad-coding-import-request"}, "5.0");
  });

  it("bad-coding-isa-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"bad-coding-isa-request"}, "5.0");
  });

  it("bad-scd-all-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"bad-scd-all-request"}, "5.0");
  });

  it("bad-scd-enumerated-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"bad-scd-enumerated-request"}, "5.0");
  });

  it("bad-scd-exclude-filter-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"bad-scd-exclude-filter-request"}, "5.0");
  });

  it("bad-scd-exclude-import-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"bad-scd-exclude-import-request"}, "5.0");
  });

  it("bad-scd-exclude-list-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"bad-scd-exclude-list-request"}, "5.0");
  });

  it("bad-scd-import-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"bad-scd-import-request"}, "5.0");
  });

  it("bad-scd-isa-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"bad-scd-isa-request"}, "5.0");
  });

  it("good-cc1-all-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"good-cc1-all-request"}, "5.0");
  });

  it("good-cc1-enumerated-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"good-cc1-enumerated-request"}, "5.0");
  });

  it("good-cc1-exclude-filter-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"good-cc1-exclude-filter-request"}, "5.0");
  });

  it("good-cc1-exclude-import-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"good-cc1-exclude-import-request"}, "5.0");
  });

  it("good-cc1-exclude-list-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"good-cc1-exclude-list-request"}, "5.0");
  });

  it("good-cc1-import-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"good-cc1-import-request"}, "5.0");
  });

  it("good-cc1-isa-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"good-cc1-isa-request"}, "5.0");
  });

  it("good-cc2-all-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"good-cc2-all-request"}, "5.0");
  });

  it("good-cc2-enumerated-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"good-cc2-enumerated-request"}, "5.0");
  });

  it("good-cc2-exclude-filter-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"good-cc2-exclude-filter-request"}, "5.0");
  });

  it("good-cc2-exclude-import-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"good-cc2-exclude-import-request"}, "5.0");
  });

  it("good-cc2-exclude-list-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"good-cc2-exclude-list-request"}, "5.0");
  });

  it("good-cc2-import-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"good-cc2-import-request"}, "5.0");
  });

  it("good-cc2-isa-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"good-cc2-isa-request"}, "5.0");
  });

  it("good-coding-all-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"good-coding-all-request"}, "5.0");
  });

  it("good-coding-enumerated-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"good-coding-enumerated-request"}, "5.0");
  });

  it("good-coding-exclude-filter-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"good-coding-exclude-filter-request"}, "5.0");
  });

  it("good-coding-exclude-import-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"good-coding-exclude-import-request"}, "5.0");
  });

  it("good-coding-exclude-list-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"good-coding-exclude-list-request"}, "5.0");
  });

  it("good-coding-import-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"good-coding-import-request"}, "5.0");
  });

  it("good-coding-isa-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"good-coding-isa-request"}, "5.0");
  });

  it("good-scd-all-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"good-scd-all-request"}, "5.0");
  });

  it("good-scd-enumerated-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"good-scd-enumerated-request"}, "5.0");
  });

  it("good-scd-exclude-filter-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"good-scd-exclude-filter-request"}, "5.0");
  });

  it("good-scd-exclude-import-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"good-scd-exclude-import-request"}, "5.0");
  });

  it("good-scd-exclude-list-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"good-scd-exclude-list-request"}, "5.0");
  });

  it("good-scd-import-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"good-scd-import-request"}, "5.0");
  });

  it("good-scd-isa-request" + 'R5-cached', async () => {
    await runTest({"suite":"permutations","test":"good-scd-isa-request"}, "5.0");
  });

});

describe('icd-11', () => {
  // ICD-11 Test Cases. See tests/icd-11/doco.txt for what these assert and why several of them are expected to fail against the current ICD-API.

  it("term-caps" + 'R5-cached', async () => {
    await runTest({"suite":"icd-11","test":"term-caps"}, "5.0");
  });

  it("lookup-mms-code" + 'R5-cached', async () => {
    await runTest({"suite":"icd-11","test":"lookup-mms-code"}, "5.0");
  });

  it("lookup-mms-uri" + 'R5-cached', async () => {
    await runTest({"suite":"icd-11","test":"lookup-mms-uri"}, "5.0");
  });

  it("lookup-mms-grouper" + 'R5-cached', async () => {
    await runTest({"suite":"icd-11","test":"lookup-mms-grouper"}, "5.0");
  });

  it("lookup-mms-no-code" + 'R5-cached', async () => {
    await runTest({"suite":"icd-11","test":"lookup-mms-no-code"}, "5.0");
  });

  it("lookup-mms-residual" + 'R5-cached', async () => {
    await runTest({"suite":"icd-11","test":"lookup-mms-residual"}, "5.0");
  });

  it("lookup-mms-fr" + 'R5-cached', async () => {
    await runTest({"suite":"icd-11","test":"lookup-mms-fr"}, "5.0");
  });

  it("lookup-icf-code" + 'R5-cached', async () => {
    await runTest({"suite":"icd-11","test":"lookup-icf-code"}, "5.0");
  });

  it("lookup-foundation" + 'R5-cached', async () => {
    await runTest({"suite":"icd-11","test":"lookup-foundation"}, "5.0");
  });

  it("lookup-bad-code" + 'R5-cached', async () => {
    await runTest({"suite":"icd-11","test":"lookup-bad-code"}, "5.0");
  });

  it("lookup-bad-system" + 'R5-cached', async () => {
    await runTest({"suite":"icd-11","test":"lookup-bad-system"}, "5.0");
  });

  it("lookup-bad-version" + 'R5-cached', async () => {
    await runTest({"suite":"icd-11","test":"lookup-bad-version"}, "5.0");
  });

  it("lookup-foundation-bare" + 'R5-cached', async () => {
    await runTest({"suite":"icd-11","test":"lookup-foundation-bare"}, "5.0");
  });

  it("lookup-foundation-residual" + 'R5-cached', async () => {
    await runTest({"suite":"icd-11","test":"lookup-foundation-residual"}, "5.0");
  });

  it("lookup-bad-language" + 'R5-cached', async () => {
    await runTest({"suite":"icd-11","test":"lookup-bad-language"}, "5.0");
  });

  it("lookup-pc-simple" + 'R5-cached', async () => {
    await runTest({"suite":"icd-11","test":"lookup-pc-simple"}, "5.0");
  });

  it("lookup-pc-uri-form" + 'R5-cached', async () => {
    await runTest({"suite":"icd-11","test":"lookup-pc-uri-form"}, "5.0");
  });

  it("lookup-pc-cluster" + 'R5-cached', async () => {
    await runTest({"suite":"icd-11","test":"lookup-pc-cluster"}, "5.0");
  });

  it("lookup-pc-repeated-value" + 'R5-cached', async () => {
    await runTest({"suite":"icd-11","test":"lookup-pc-repeated-value"}, "5.0");
  });

  it("lookup-pc-nondisjoint" + 'R5-cached', async () => {
    await runTest({"suite":"icd-11","test":"lookup-pc-nondisjoint"}, "5.0");
  });

  it("lookup-pc-invalid-axis" + 'R5-cached', async () => {
    await runTest({"suite":"icd-11","test":"lookup-pc-invalid-axis"}, "5.0");
  });

  it("lookup-pc-other" + 'R5-cached', async () => {
    await runTest({"suite":"icd-11","test":"lookup-pc-other"}, "5.0");
  });

  it("lookup-icf-pc" + 'R5-cached', async () => {
    await runTest({"suite":"icd-11","test":"lookup-icf-pc"}, "5.0");
  });

  it("lookup-icf-pc-old" + 'R5-cached', async () => {
    await runTest({"suite":"icd-11","test":"lookup-icf-pc-old"}, "5.0");
  });

  it("cs-validate-good" + 'R5-cached', async () => {
    await runTest({"suite":"icd-11","test":"cs-validate-good"}, "5.0");
  });

  it("cs-validate-good-display" + 'R5-cached', async () => {
    await runTest({"suite":"icd-11","test":"cs-validate-good-display"}, "5.0");
  });

  it("cs-validate-bad-display" + 'R5-cached', async () => {
    await runTest({"suite":"icd-11","test":"cs-validate-bad-display"}, "5.0");
  });

  it("cs-validate-bad-code" + 'R5-cached', async () => {
    await runTest({"suite":"icd-11","test":"cs-validate-bad-code"}, "5.0");
  });

  it("cs-validate-case" + 'R5-cached', async () => {
    await runTest({"suite":"icd-11","test":"cs-validate-case"}, "5.0");
  });

  it("cs-validate-lang" + 'R5-cached', async () => {
    await runTest({"suite":"icd-11","test":"cs-validate-lang"}, "5.0");
  });

  it("cs-validate-pc" + 'R5-cached', async () => {
    await runTest({"suite":"icd-11","test":"cs-validate-pc"}, "5.0");
  });

  it("cs-validate-uri" + 'R5-cached', async () => {
    await runTest({"suite":"icd-11","test":"cs-validate-uri"}, "5.0");
  });

  it("expand-pcs" + 'R5-cached', async () => {
    await runTest({"suite":"icd-11","test":"expand-pcs"}, "5.0");
  });

  it("expand-pcs-count" + 'R5-cached', async () => {
    await runTest({"suite":"icd-11","test":"expand-pcs-count"}, "5.0");
  });

  it("expand-pcs-offset" + 'R5-cached', async () => {
    await runTest({"suite":"icd-11","test":"expand-pcs-offset"}, "5.0");
  });

  it("expand-pcs-filter" + 'R5-cached', async () => {
    await runTest({"suite":"icd-11","test":"expand-pcs-filter"}, "5.0");
  });

  it("expand-pcs-fr" + 'R5-cached', async () => {
    await runTest({"suite":"icd-11","test":"expand-pcs-fr"}, "5.0");
  });

  it("expand-bad-url" + 'R5-cached', async () => {
    await runTest({"suite":"icd-11","test":"expand-bad-url"}, "5.0");
  });

  it("expand-inline-vs" + 'R5-cached', async () => {
    await runTest({"suite":"icd-11","test":"expand-inline-vs"}, "5.0");
  });

  it("expand-adhoc-enum" + 'R5-cached', async () => {
    await runTest({"suite":"icd-11","test":"expand-adhoc-enum"}, "5.0");
  });

  it("expand-adhoc-enum-uri" + 'R5-cached', async () => {
    await runTest({"suite":"icd-11","test":"expand-adhoc-enum-uri"}, "5.0");
  });

  it("expand-adhoc-isa" + 'R5-cached', async () => {
    await runTest({"suite":"icd-11","test":"expand-adhoc-isa"}, "5.0");
  });

  it("expand-adhoc-isa-uri" + 'R5-cached', async () => {
    await runTest({"suite":"icd-11","test":"expand-adhoc-isa-uri"}, "5.0");
  });

  it("expand-adhoc-bad-code" + 'R5-cached', async () => {
    await runTest({"suite":"icd-11","test":"expand-adhoc-bad-code"}, "5.0");
  });

  it("expand-pcs-uri-form" + 'R5-cached', async () => {
    await runTest({"suite":"icd-11","test":"expand-pcs-uri-form"}, "5.0");
  });

  it("expand-pcs-code-form" + 'R5-cached', async () => {
    await runTest({"suite":"icd-11","test":"expand-pcs-code-form"}, "5.0");
  });

  it("vs-validate-in" + 'R5-cached', async () => {
    await runTest({"suite":"icd-11","test":"vs-validate-in"}, "5.0");
  });

  it("vs-validate-out" + 'R5-cached', async () => {
    await runTest({"suite":"icd-11","test":"vs-validate-out"}, "5.0");
  });

  it("vs-validate-adhoc" + 'R5-cached', async () => {
    await runTest({"suite":"icd-11","test":"vs-validate-adhoc"}, "5.0");
  });

  it("vs-validate-adhoc-out" + 'R5-cached', async () => {
    await runTest({"suite":"icd-11","test":"vs-validate-adhoc-out"}, "5.0");
  });

});

describe('regex-bad', () => {
  // Bad Regex - checking defences against denial of service attack. These are unusual because servers have the option to succeed, or to refuse the request

  it("expand-regex-bad" + 'R5-cached', async () => {
    await runTest({"suite":"regex-bad","test":"expand-regex-bad"}, "5.0");
  });

  it("validate-regex-bad" + 'R5-cached', async () => {
    await runTest({"suite":"regex-bad","test":"validate-regex-bad"}, "5.0");
  });

  it("expand-regex-bad-2" + 'R5-cached', async () => {
    await runTest({"suite":"regex-bad","test":"expand-regex-bad-2"}, "5.0");
  });

  it("validate-regex-bad-2" + 'R5-cached', async () => {
    await runTest({"suite":"regex-bad","test":"validate-regex-bad-2"}, "5.0");
  });

});

describe('related2', () => {
  // Tests for $compare operation - comparing two value sets to determine their relationship (equivalent, subset, superset, overlap, disjoint, unknown)

  it("related-eq-identical-def" + 'R5-cached', async () => {
    await runTest({"suite":"related2","test":"related-eq-identical-def"}, "5.0");
  });

  it("related-eq-enum-reorder" + 'R5-cached', async () => {
    await runTest({"suite":"related2","test":"related-eq-enum-reorder"}, "5.0");
  });

  it("related-eq-multi-include-reorder" + 'R5-cached', async () => {
    await runTest({"suite":"related2","test":"related-eq-multi-include-reorder"}, "5.0");
  });

  it("related-eq-filter-vs-enum" + 'R5-cached', async () => {
    await runTest({"suite":"related2","test":"related-eq-filter-vs-enum"}, "5.0");
  });

  it("related-eq-import-vs-inline" + 'R5-cached', async () => {
    await runTest({"suite":"related2","test":"related-eq-import-vs-inline"}, "5.0");
  });

  it("related-eq-import-reorder" + 'R5-cached', async () => {
    await runTest({"suite":"related2","test":"related-eq-import-reorder"}, "5.0");
  });

  it("related-expeq-exclude-vs-enum" + 'R5-cached', async () => {
    await runTest({"suite":"related2","test":"related-expeq-exclude-vs-enum"}, "5.0");
  });

  it("related-expeq-exclude-partial" + 'R5-cached', async () => {
    await runTest({"suite":"related2","test":"related-expeq-exclude-partial"}, "5.0");
  });

  it("related-sub-branch-vs-root" + 'R5-cached', async () => {
    await runTest({"suite":"related2","test":"related-sub-branch-vs-root"}, "5.0");
  });

  it("related-sub-enum-vs-filter" + 'R5-cached', async () => {
    await runTest({"suite":"related2","test":"related-sub-enum-vs-filter"}, "5.0");
  });

  it("related-sub-base-vs-import-plus" + 'R5-cached', async () => {
    await runTest({"suite":"related2","test":"related-sub-base-vs-import-plus"}, "5.0");
  });

  it("related-sub-leaf-vs-subtree" + 'R5-cached', async () => {
    await runTest({"suite":"related2","test":"related-sub-leaf-vs-subtree"}, "5.0");
  });

  it("related-super-root-vs-branch" + 'R5-cached', async () => {
    await runTest({"suite":"related2","test":"related-super-root-vs-branch"}, "5.0");
  });

  it("related-expsub-exclude-narrower" + 'R5-cached', async () => {
    await runTest({"suite":"related2","test":"related-expsub-exclude-narrower"}, "5.0");
  });

  it("related-disj-diff-systems" + 'R5-cached', async () => {
    await runTest({"suite":"related2","test":"related-disj-diff-systems"}, "5.0");
  });

  it("related-disj-diff-branches" + 'R5-cached', async () => {
    await runTest({"suite":"related2","test":"related-disj-diff-branches"}, "5.0");
  });

  it("related-disj-enum-no-intersection" + 'R5-cached', async () => {
    await runTest({"suite":"related2","test":"related-disj-enum-no-intersection"}, "5.0");
  });

  it("related-disj-multi-system" + 'R5-cached', async () => {
    await runTest({"suite":"related2","test":"related-disj-multi-system"}, "5.0");
  });

  it("related-ov-enum-partial" + 'R5-cached', async () => {
    await runTest({"suite":"related2","test":"related-ov-enum-partial"}, "5.0");
  });

  it("related-ov-filter-vs-enum" + 'R5-cached', async () => {
    await runTest({"suite":"related2","test":"related-ov-filter-vs-enum"}, "5.0");
  });

  it("related-ov-multi-include-partial" + 'R5-cached', async () => {
    await runTest({"suite":"related2","test":"related-ov-multi-include-partial"}, "5.0");
  });

  it("related-ov-import-partial" + 'R5-cached', async () => {
    await runTest({"suite":"related2","test":"related-ov-import-partial"}, "5.0");
  });

  it("related-ov-cross-system" + 'R5-cached', async () => {
    await runTest({"suite":"related2","test":"related-ov-cross-system"}, "5.0");
  });

  it("related-ov-exclude-partial" + 'R5-cached', async () => {
    await runTest({"suite":"related2","test":"related-ov-exclude-partial"}, "5.0");
  });

  it("related-unk-snomed-both-filter" + 'R5-cached', async () => {
    await runTest({"suite":"related2","test":"related-unk-snomed-both-filter"}, "5.0");
  });

  it("related-unk-snomed-filter-vs-enum" + 'R5-cached', async () => {
    await runTest({"suite":"related2","test":"related-unk-snomed-filter-vs-enum"}, "5.0");
  });

  it("related-unk-unknown-system" + 'R5-cached', async () => {
    await runTest({"suite":"related2","test":"related-unk-unknown-system"}, "5.0");
  });

  it("related-ver-same-def-diff-cs-version" + 'R5-cached', async () => {
    await runTest({"suite":"related2","test":"related-ver-same-def-diff-cs-version"}, "5.0");
  });

  it("related-ver-all-diff-cs-version" + 'R5-cached', async () => {
    await runTest({"suite":"related2","test":"related-ver-all-diff-cs-version"}, "5.0");
  });

  it("related-ver-branch-diff-cs-version" + 'R5-cached', async () => {
    await runTest({"suite":"related2","test":"related-ver-branch-diff-cs-version"}, "5.0");
  });

  it("related-ver-unversioned-vs-pinned" + 'R5-cached', async () => {
    await runTest({"suite":"related2","test":"related-ver-unversioned-vs-pinned"}, "5.0");
  });

  it("related-ver-same-vs-diff-version" + 'R5-cached', async () => {
    await runTest({"suite":"related2","test":"related-ver-same-vs-diff-version"}, "5.0");
  });

  it("related-ver-import-version-cascade" + 'R5-cached', async () => {
    await runTest({"suite":"related2","test":"related-ver-import-version-cascade"}, "5.0");
  });

});

describe('langcodes', () => {
  // IETF language code (BCP-47) test cases

  it("validate-lang-base" + 'R5-cached', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-base"}, "5.0");
  });

  it("validate-lang-region" + 'R5-cached', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-region"}, "5.0");
  });

  it("validate-lang-script" + 'R5-cached', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-script"}, "5.0");
  });

  it("validate-lang-script-region" + 'R5-cached', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-script-region"}, "5.0");
  });

  it("validate-lang-region-private" + 'R5-cached', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-region-private"}, "5.0");
  });

  it("validate-lang-grandfathered" + 'R5-cached', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-grandfathered"}, "5.0");
  });

  it("validate-lang-base-bad" + 'R5-cached', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-base-bad"}, "5.0");
  });

  it("validate-lang-region-bad" + 'R5-cached', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-region-bad"}, "5.0");
  });

  it("validate-lang-script-bad" + 'R5-cached', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-script-bad"}, "5.0");
  });

  it("validate-lang-extlang-prefix-bad" + 'R5-cached', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-extlang-prefix-bad"}, "5.0");
  });

  it("validate-lang-variant-prefix-bad" + 'R5-cached', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-variant-prefix-bad"}, "5.0");
  });

  it("validate-lang-case-language" + 'R5-cached', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-case-language"}, "5.0");
  });

  it("validate-lang-case-region" + 'R5-cached', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-case-region"}, "5.0");
  });

  it("validate-lang-case-all" + 'R5-cached', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-case-all"}, "5.0");
  });

  it("subsumes-lang-base-region" + 'R5-cached', async () => {
    await runTest({"suite":"langcodes","test":"subsumes-lang-base-region"}, "5.0");
  });

  it("subsumes-lang-reverse" + 'R5-cached', async () => {
    await runTest({"suite":"langcodes","test":"subsumes-lang-reverse"}, "5.0");
  });

  it("subsumes-lang-equivalent" + 'R5-cached', async () => {
    await runTest({"suite":"langcodes","test":"subsumes-lang-equivalent"}, "5.0");
  });

  it("subsumes-lang-script" + 'R5-cached', async () => {
    await runTest({"suite":"langcodes","test":"subsumes-lang-script"}, "5.0");
  });

  it("subsumes-lang-skipped-script" + 'R5-cached', async () => {
    await runTest({"suite":"langcodes","test":"subsumes-lang-skipped-script"}, "5.0");
  });

  it("subsumes-lang-variant" + 'R5-cached', async () => {
    await runTest({"suite":"langcodes","test":"subsumes-lang-variant"}, "5.0");
  });

  it("subsumes-lang-siblings" + 'R5-cached', async () => {
    await runTest({"suite":"langcodes","test":"subsumes-lang-siblings"}, "5.0");
  });

  it("subsumes-lang-scripts" + 'R5-cached', async () => {
    await runTest({"suite":"langcodes","test":"subsumes-lang-scripts"}, "5.0");
  });

  it("subsumes-lang-crossed" + 'R5-cached', async () => {
    await runTest({"suite":"langcodes","test":"subsumes-lang-crossed"}, "5.0");
  });

  it("subsumes-lang-unrelated" + 'R5-cached', async () => {
    await runTest({"suite":"langcodes","test":"subsumes-lang-unrelated"}, "5.0");
  });

  it("subsumes-lang-case" + 'R5-cached', async () => {
    await runTest({"suite":"langcodes","test":"subsumes-lang-case"}, "5.0");
  });

  it("subsumes-lang-grandfathered" + 'R5-cached', async () => {
    await runTest({"suite":"langcodes","test":"subsumes-lang-grandfathered"}, "5.0");
  });

  it("validate-lang-filter-language-in" + 'R5-cached', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-filter-language-in"}, "5.0");
  });

  it("validate-lang-filter-language-out" + 'R5-cached', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-filter-language-out"}, "5.0");
  });

  it("validate-lang-filter-region-in" + 'R5-cached', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-filter-region-in"}, "5.0");
  });

  it("validate-lang-filter-region-out" + 'R5-cached', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-filter-region-out"}, "5.0");
  });

  it("validate-lang-filter-both-in" + 'R5-cached', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-filter-both-in"}, "5.0");
  });

  it("validate-lang-filter-both-out" + 'R5-cached', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-filter-both-out"}, "5.0");
  });

  it("validate-lang-filter-script-in" + 'R5-cached', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-filter-script-in"}, "5.0");
  });

  it("validate-lang-filter-script-out" + 'R5-cached', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-filter-script-out"}, "5.0");
  });

  it("validate-lang-filter-language-bare" + 'R5-cached', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-filter-language-bare"}, "5.0");
  });

  it("validate-lang-filter-region-absent" + 'R5-cached', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-filter-region-absent"}, "5.0");
  });

  it("validate-lang-filter-script-absent" + 'R5-cached', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-filter-script-absent"}, "5.0");
  });

  it("validate-lang-filter-both-absent" + 'R5-cached', async () => {
    await runTest({"suite":"langcodes","test":"validate-lang-filter-both-absent"}, "5.0");
  });

  it("expand-lang-language" + 'R5-cached', async () => {
    await runTest({"suite":"langcodes","test":"expand-lang-language"}, "5.0");
  });

  it("expand-lang-both" + 'R5-cached', async () => {
    await runTest({"suite":"langcodes","test":"expand-lang-both"}, "5.0");
  });

  it("expand-lang-region" + 'R5-cached', async () => {
    await runTest({"suite":"langcodes","test":"expand-lang-region"}, "5.0");
  });

  it("expand-lang-script" + 'R5-cached', async () => {
    await runTest({"suite":"langcodes","test":"expand-lang-script"}, "5.0");
  });

  it("expand-langcodes-all" + 'R5-cached', async () => {
    await runTest({"suite":"langcodes","test":"expand-langcodes-all"}, "5.0");
  });

});

});

});

