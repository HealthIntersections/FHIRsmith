// registry-resolve.test.js
// Functional tests for the registry resolve endpoint

const fs = require('fs');
const path = require('path');
const RegistryCrawler = require('../../registry/crawler');
const RegistryAPI = require('../../registry/api');

// Load the test data
function loadTestData() {
  try {
    const dataPath = path.join(__dirname, 'test-data.json');
    const rawData = fs.readFileSync(dataPath, 'utf8');
    const jsonData = JSON.parse(rawData);
    return jsonData;
  } catch (error) {
    console.error(`Error loading test data: ${error.message}`);
    throw error;
  }
}

describe('Registry Resolve Functional Tests', () => {
  let crawler;
  let api;

  beforeAll(() => {
    // Set up the crawler with test data
    try {
      crawler = new RegistryCrawler();
      const testData = loadTestData();
      crawler.loadData(testData);
      api = new RegistryAPI(crawler);
      console.log('Test data loaded successfully.');
    } catch (error) {
      console.error('Failed to set up test environment:', error);
      throw error;
    }
  });

  /**
   * Helper function to perform resolver test
   * This is now a helper that gets called INSIDE each test
   * @param {Object} params - Test parameters
   */
  function runResolveTest({ fhirVersion, url, valueSet, usage, authoritativeOnly, expected }) {
    // Determine which resolver to use
    const isValueSet = !!valueSet;

    console.log(`Running with usage: ${usage || 'none'}`);

    // Call the appropriate resolver
    const resolveResult = isValueSet
      ? api.resolveValueSet(fhirVersion, valueSet, authoritativeOnly, usage)
      : api.resolveCodeSystem(fhirVersion, url, authoritativeOnly, usage);

    const actual = resolveResult.result;

    // Debug output
    console.log(`Matches: ${resolveResult.matches}`);
    console.log(JSON.stringify(actual, null, 2));

    // Basic structure checks
    expect(actual.formatVersion).toBe("1");
    expect(actual["registry-url"]).toBeDefined();

    // Check for arrays only if they're expected
    if (expected && expected.candidates) {
      expect(actual.candidates).toBeInstanceOf(Array);
    }
    if (expected && expected.authoritative) {
      expect(actual.authoritative).toBeInstanceOf(Array);
    }

    // If we have expected results, validate them
    if (expected) {
      // Replace registry-url with actual value for comparison
      const expectedWithCorrectUrl = {
        ...expected,
        "registry-url": actual["registry-url"]
      };

      // Compare entire objects
      expect(actual).toEqual(expectedWithCorrectUrl);
    }

    return actual;
  }

  // Test cases - each in a separate test function

  test('should resolve SNOMED CT with Australian extension', () => {
    runResolveTest({
      fhirVersion: 'R4',
      url: 'http://snomed.info/sct|http://snomed.info/sct/32506021000036107',
      authoritativeOnly: false,
      expected: {
        "formatVersion": "1",
        "registry-url": "https://fhir.github.io/ig-registry/tx-servers.json",
        "authoritative": [
          {
            "server-name": "HL7 Australia Server",
            "url": "https://tx.ontoserver.csiro.au/fhir",
            "security": "open",
            "fhirVersion": "4.0.1",
            "open": true,
            "access_info": "This server is open to the public"
          }
        ],
        // tx.fhir.org hosts versions of the Australian edition too, so it's a candidate
        "candidates": [
          {
            "server-name": "tx.fhir.org",
            "url": "http://tx.fhir.org/r4",
            "security": "open",
            "fhirVersion": "4.0.1",
            "open": true,
            "access_info": "This server is open to the public"
          }
        ]
      }
    });
  });

  test('should filter to authoritative servers only', () => {
    runResolveTest({
      fhirVersion: 'R4',
      url: 'http://snomed.info/sct|http://snomed.info/sct/32506021000036107',
      authoritativeOnly: true,
      expected: {
        "formatVersion": "1",
        "registry-url": "https://fhir.github.io/ig-registry/tx-servers.json",
        "authoritative": [
          {
            "server-name": "HL7 Australia Server",
            "url": "https://tx.ontoserver.csiro.au/fhir",
            "security": "open",
            "fhirVersion": "4.0.1",
            "open": true,
            "access_info": "This server is open to the public"
          }
        ]
      }
    });
  });

  test('should resolve FHIR Observation Codes ValueSet', () => {
    runResolveTest({
      fhirVersion: 'R4',
      valueSet: 'http://hl7.org/fhir/ValueSet/observation-codes',
      expected: {
        "formatVersion": "1",
        "registry-url": "https://fhir.github.io/ig-registry/tx-servers.json",
        "candidates": [
          {
            "server-name": "tx.fhir.org",
            "url": "http://tx.fhir.org/r4",
            "security": "open",
            "fhirVersion": "4.0.1",
            "open": true,
            "access_info": "This server is open to the public"
          },
          {
            "server-name": "HL7 Australia Server",
            "url": "https://tx.ontoserver.csiro.au/fhir",
            "security": "open",
            "fhirVersion": "4.0.1",
            "open": true,
            "access_info": "This server is open to the public"
          },
          {
            "server-name": "HL7 Europe Terminology Server",
            "url": "http://tx.hl7europe.eu/r4",
            "security": "open",
            "fhirVersion": "4.0.1",
            "open": true,
            "access_info": "Open"
          },
          {
            "server-name": "HL7 Switzerland Terminology Server",
            "url": "https://tx.fhir.ch/r4",
            "security": "open",
            "fhirVersion": "4.0.1",
            "open": true,
            "access_info": "Open"
          },
          {
            "server-name": "New Zealand Health Terminology Service (NZHTS)",
            "url": "https://nzhts.digital.health.nz/fhir",
            "security": "open",
            "fhirVersion": "4.0.1",
            "open": true,
            "access_info": "This server requires an API Key - see https://www.tewhatuora.govt.nz/health-services-and-programmes/digital-health/terminology-service"
          }
        ]
      }
    });
  });

  test('should resolve LOINC terminology', () => {
    runResolveTest({
      fhirVersion: '4.0',
      url: 'http://loinc.org',
      expected : {
        "formatVersion": "1",
        "registry-url": "https://fhir.github.io/ig-registry/tx-servers.json",
        "candidates": [
          {
            "server-name": "tx.fhir.org",
            "url": "http://tx.fhir.org/r4",
            "security": "open",
            "fhirVersion": "4.0.1",
            "open": true,
            "access_info": "This server is open to the public"
          },
          {
            "server-name": "HL7 Australia Server",
            "url": "https://tx.ontoserver.csiro.au/fhir",
            "security": "open",
            "fhirVersion": "4.0.1",
            "open": true,
            "access_info": "This server is open to the public"
          },
          {
            "server-name": "Canada Health Infoway Terminology Server",
            "url": "https://terminologystandardsservice.ca/tx/fhir",
            "security": "api-key",
            "fhirVersion": "4.0.1",
            "token": true,
            "access_info": "This server requires an API Key - see https://infocentral.infoway-inforoute.ca/en/tools/standards-tools/terminology-server"
          },
          {
            "server-name": "HL7 Europe Terminology Server",
            "url": "http://tx.hl7europe.eu/r4",
            "security": "open",
            "fhirVersion": "4.0.1",
            "open": true,
            "access_info": "Open"
          },
          {
            "server-name": "HL7 Switzerland Terminology Server",
            "url": "https://tx.fhir.ch/r4",
            "security": "open",
            "fhirVersion": "4.0.1",
            "open": true,
            "access_info": "Open"
          }
        ]
      }
    });
  });

  test('should filter SNOMED servers by FHIR R5', () => {
    runResolveTest({
      fhirVersion: 'R5',
      url: 'http://snomed.info/sct',
      expected: {
        "formatVersion": "1",
        "registry-url": "https://fhir.github.io/ig-registry/tx-servers.json",
        "candidates": [
          {
            "server-name": "tx.fhir.org",
            "url": "http://tx.fhir.org/r5",
            "security": "open",
            "fhirVersion": "5.0.0",
            "open": true,
            "access_info": "This server is open to the public"
          },
          {
            "server-name": "HL7 Europe Terminology Server",
            "url": "http://tx.hl7europe.eu/r5",
            "security": "open",
            "fhirVersion": "5.0.0",
            "open": true,
            "access_info": "Open"
          },
          {
            "server-name": "TEHIK Terminology Server",
            "url": "https://term.tehik.ee/fhir",
            "security": "open",
            "fhirVersion": "5.0.0",
            "open": true,
            "access_info": "Open"
          }
        ]
      }
    });
  });

  test('should return all servers when no usage filter specified', () => {
    runResolveTest({
      fhirVersion: '4.0',
      url: 'http://snomed.info/sct|http://snomed.info/sct/11000172109',
      expected: {
        // The Belgian server is authoritative but restricted to publication use; the
        // servers that host versions of the Belgian edition are still candidates
        "formatVersion": "1",
        "registry-url": "https://fhir.github.io/ig-registry/tx-servers.json",
        "candidates": [
          {
            "server-name": "tx.fhir.org",
            "url": "http://tx.fhir.org/r4",
            "security": "open",
            "fhirVersion": "4.0.1",
            "open": true,
            "access_info": "This server is open to the public"
          },
          {
            "server-name": "HL7 Australia Server",
            "url": "https://tx.ontoserver.csiro.au/fhir",
            "security": "open",
            "fhirVersion": "4.0.1",
            "open": true,
            "access_info": "This server is open to the public"
          }
        ]
      }
    });
  });

  test('should filter servers when invalid usage is specified', () => {
    runResolveTest({
      fhirVersion: '4.0',
      url: 'http://snomed.info/sct|http://snomed.info/sct/11000172109',
      usage: "validation",
      expected: {
        // The Belgian server is authoritative but restricted to publication use; the
        // servers that host versions of the Belgian edition are still candidates
        "formatVersion": "1",
        "registry-url": "https://fhir.github.io/ig-registry/tx-servers.json",
        "candidates": [
          {
            "server-name": "tx.fhir.org",
            "url": "http://tx.fhir.org/r4",
            "security": "open",
            "fhirVersion": "4.0.1",
            "open": true,
            "access_info": "This server is open to the public"
          },
          {
            "server-name": "HL7 Australia Server",
            "url": "https://tx.ontoserver.csiro.au/fhir",
            "security": "open",
            "fhirVersion": "4.0.1",
            "open": true,
            "access_info": "This server is open to the public"
          }
        ]
      }
    });
  });

  test('should filter servers by publication usage tag', () => {
    runResolveTest({
      fhirVersion: '4.0',
      url: 'http://snomed.info/sct|http://snomed.info/sct/11000172109',
      usage: 'publication',
      expected:{
        "formatVersion": "1",
        "registry-url": "https://fhir.github.io/ig-registry/tx-servers.json",
        "authoritative": [
          {
            "server-name": "Federal Public Service Health, Food Chain Safety and Environment",
            "url": "https://apps.health.belgium.be/ontoserver/fhir",
            "security": "open",
            "fhirVersion": "4.0.1",
            "open": true,
            "access_info": "This server is open to publishers of IGs"
          }
        ],
        "candidates": [
          {
            "server-name": "tx.fhir.org",
            "url": "http://tx.fhir.org/r4",
            "security": "open",
            "fhirVersion": "4.0.1",
            "open": true,
            "access_info": "This server is open to the public"
          },
          {
            "server-name": "HL7 Australia Server",
            "url": "https://tx.ontoserver.csiro.au/fhir",
            "security": "open",
            "fhirVersion": "4.0.1",
            "open": true,
            "access_info": "This server is open to the public"
          }
        ]
      }
    });
  });

  // Error tests
  test('should handle invalid inputs gracefully', () => {
    // Empty FHIR version
    expect(() => api.resolveCodeSystem('', 'http://snomed.info/sct')).toThrow(/FHIR version is required/);

    // Empty URL
    expect(() => api.resolveCodeSystem('R4', '')).toThrow(/code system URL is required/);

    // Empty value set
    expect(() => api.resolveValueSet('R4', '')).toThrow(/value set URL is required/);
  });
});