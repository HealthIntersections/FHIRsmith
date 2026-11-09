const {Library} = require("../../tx/library");
const path = require("path");
const {OperationContext, debugLog} = require("../../tx/operation-context");
const {Languages} = require("../../library/languages");

const NO_LOAD_TEST = true;

describe('Provider Test', () => {

  test('Full tx.fhir.org load', async () => {
    const isCI = process.env.CI === 'true';
    if (!NO_LOAD_TEST && !isCI) {
      let configFile = path.resolve(__dirname, '../../tx/tx.fhir.org.yml')
      let library = new Library(configFile);
      await library.load();
      expect(library.codeSystemFactories.size).toBeGreaterThan(0);
      expect(library.codeSystemProviders.length).toBeGreaterThan(0);
      expect(library.valueSetProviders.length).toBeGreaterThan(0);

      let r4 = await library.cloneWithFhirVersion("r4");

      expect(r4.codeSystemFactories.size).toEqual(library.codeSystemFactories.size);
      expect(r4.codeSystems.size).toBeGreaterThan(library.codeSystemProviders.length);
      expect(r4.valueSetProviders.length).toBeGreaterThanOrEqual(library.valueSetProviders.length);

      // Test all code system factories can produce providers
      await testAllCodeSystemFactories(r4);

      // Test random selection of loaded code systems can produce providers
      await testRandomCodeSystems(r4);
      await testCodeSystemProviderEdgeCases(r4);
    }
  }, 5000000);

  /**
   * Test that all loaded code system factories can successfully create CodeSystemProvider instances
   */
  async function testAllCodeSystemFactories(library) {
    const opContext = new OperationContext(Languages.fromAcceptLanguage("en"), library.i18n);
    const failures = [];

    for (const [key] of library.codeSystemFactories.entries()) {
      try {
        // Parse system and version from key
        let system, version;
        if (key.includes('|')) {
          [system, version] = key.split('|');
        } else {
          system = key;
          version = null;
        }

        // Attempt to get a provider using getCodeSystemProvider
        const provider = await library.getCodeSystemProvider(opContext, system, version, []);
        if (!provider) {
          failures.push(`${key}: getCodeSystemProvider returned null`);
        }
      } catch (error) {
        debugLog(error);
        failures.push(`${key}: ${error.message}`);
      }
    }

    expect(failures).toEqual([]);
  }

  /**
   * Test a random selection of loaded CodeSystem resources can create providers
   */
  async function testRandomCodeSystems(library) {
    const opContext = new OperationContext(Languages.fromAcceptLanguage('en'));
    const codeSystemEntries = Array.from(library.codeSystems.entries());

    // Test up to 20 random code systems, or all if less than 20
    const sampleSize = Math.min(20, codeSystemEntries.length);
    const randomSample = getRandomSample(codeSystemEntries, sampleSize);

    const failures = [];

    for (const [key, codeSystem] of randomSample) {
      try {
        // Test createCodeSystemProvider directly
        const provider = await library.createCodeSystemProvider(opContext, codeSystem, []);
        if (!provider) {
          failures.push(`${key}: createCodeSystemProvider returned null`);
        }
      } catch (error) {
        failures.push(`${key}: ${error.message}`);
      }
    }

    // Assert that all tested code systems can create providers successfully
    expect(failures).toEqual([]);
  }

  /**
   * Get a random sample from an array
   */
  function getRandomSample(array, sampleSize) {
    if (sampleSize >= array.length) {
      return array;
    }

    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    return shuffled.slice(0, sampleSize);
  }


  /**
   * Test edge cases for createCodeSystemProvider
   */async function testCodeSystemProviderEdgeCases(library) {
    const opContext = new OperationContext(Languages.fromAcceptLanguage('en'));

    // Test with invalid parameters
    await expect(library.createCodeSystemProvider(null, {}, []))
      .rejects.toThrow("opContext must be provided");

    await expect(library.createCodeSystemProvider(opContext, null, []))
      .rejects.toThrow("codeSystem must be provided");

    await expect(library.createCodeSystemProvider(opContext, library.codeSystems.get("http://terminology.hl7.org/CodeSystem/adjudication-error"), "not-an-array"))
      .rejects.toThrow("supplements must be an array");

    // Test with valid CodeSystem if available
    if (library.codeSystems.size > 0) {
      const firstCodeSystem = library.codeSystems.values().next().value;
      const provider = await library.createCodeSystemProvider(opContext, firstCodeSystem, []);
      expect(provider).not.toBeNull();
    }
  }
});