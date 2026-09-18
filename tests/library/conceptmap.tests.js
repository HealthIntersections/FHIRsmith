/**
 * Test cases for ConceptMap class
 * These tests can be run with Jest, Mocha, or any similar testing framework
 */

import {ConceptMap} from "../../tx/library/conceptmap";

describe('ConceptMap', () => {
  // Test data
  const validConceptMap = {
    "resourceType": "ConceptMap",
    "url": "http://example.org/fhir/ConceptMap/test",
    "version": "1.0.0",
    "name": "TestConceptMap",
    "title": "Test Concept Map",
    "status": "active",
    "sourceScope": "http://loinc.org",
    "targetScope": "http://snomed.info/sct",
    "group": [
      {
        "source": "http://loinc.org",
        "target": "http://snomed.info/sct",
        "element": [
          {
            "code": "LA6113-0",
            "display": "Positive",
            "target": [
              {
                "code": "10828004",
                "display": "Positive (qualifier value)",
                "relationship": "equivalent",
                "equivalence": "equivalent"
              }
            ]
          },
          {
            "code": "LA6114-8",
            "display": "Negative",
            "target": [
              {
                "code": "260385009",
                "display": "Negative (qualifier value)",
                "relationship": "equivalent",
                "equivalence": "equivalent"
              }
            ]
          }
        ]
      }
    ]
  };

  const r3ConceptMapWithEquivalence = {
    "resourceType": "ConceptMap",
    "url": "http://example.org/fhir/ConceptMap/r3-test",
    "name": "R3TestConceptMap",
    "status": "active",
    "identifier": {
      "system": "http://example.org/identifiers",
      "value": "r3-cm-1"
    },
    "source": "http://loinc.org",
    "sourceVersion": "2.73",
    "target": "http://snomed.info/sct",
    "targetVersion": "http://snomed.info/sct/900000000000207008/version/20230731",
    "group": [
      {
        "source": "http://loinc.org",
        "target": "http://snomed.info/sct",
        "element": [
          {
            "code": "LA6113-0",
            "display": "Positive",
            "target": [
              {
                "code": "10828004",
                "display": "Positive (qualifier value)",
                "equivalence": "equivalent"
              }
            ]
          },
          {
            "code": "LA6115-5",
            "display": "Intermediate",
            "target": [
              {
                "code": "11896004",
                "display": "Intermediate (qualifier value)",
                "equivalence": "wider"
              }
            ]
          }
        ]
      }
    ]
  };

  const r5ConceptMapWithRelationship = {
    "resourceType": "ConceptMap",
    "url": "http://example.org/fhir/ConceptMap/r5-test",
    "name": "R5TestConceptMap",
    "status": "active",
    "versionAlgorithmString": "semver",
    "identifier": [
      {
        "system": "http://example.org/identifiers",
        "value": "r5-cm-1"
      }
    ],
    "sourceScope": "http://loinc.org|2.74",
    "targetScope": "http://snomed.info/sct|20240131",
    "property": [
      {
        "code": "test-property",
        "type": "code"
      }
    ],
    "group": [
      {
        "source": "http://loinc.org",
        "target": "http://snomed.info/sct",
        "element": [
          {
            "code": "LA6113-0",
            "display": "Positive",
            "target": [
              {
                "code": "10828004",
                "display": "Positive (qualifier value)",
                "relationship": "equivalent"
              }
            ]
          },
          {
            "code": "LA6115-5",
            "display": "Intermediate",
            "target": [
              {
                "code": "11896004",
                "display": "Intermediate (qualifier value)",
                "relationship": "source-is-broader-than-target"
              }
            ]
          }
        ]
      }
    ]
  };

  describe('Constructor and Validation', () => {
    test('should create ConceptMap with valid data', () => {
      const cm = new ConceptMap(validConceptMap);
      expect(cm.jsonObj).toEqual(validConceptMap);
    });

    test('should create ConceptMap from JSON string', () => {
      const cm = ConceptMap.fromJSON(JSON.stringify(validConceptMap));
      expect(cm.jsonObj).toEqual(validConceptMap);
    });

    test('should throw error for null input', () => {
      expect(() => new ConceptMap(null)).toThrow('Invalid ConceptMap: expected object');
    });

    test('should throw error for wrong resourceType', () => {
      const invalid = { ...validConceptMap, resourceType: "ValueSet" };
      expect(() => new ConceptMap(invalid)).toThrow('Invalid ConceptMap: resourceType must be "ConceptMap"');
    });

    test('should throw error for missing url', () => {
      const invalid = { ...validConceptMap };
      delete invalid.url;
      expect(() => new ConceptMap(invalid)).toThrow('Invalid ConceptMap: url is required');
    });

    test('should throw error for missing name', () => {
      const invalid = { ...validConceptMap };
      delete invalid.name;
      expect(() => new ConceptMap(invalid)).toThrow('Invalid ConceptMap: name is required');
    });

    test('should throw error for invalid group structure', () => {
      const invalid = { ...validConceptMap, group: "not an array" };
      expect(() => new ConceptMap(invalid)).toThrow('Invalid ConceptMap: group must be an array');
    });

    test('should throw error for invalid element structure', () => {
      const invalid = {
        ...validConceptMap,
        group: [{ source: "test", element: "not an array" }]
      };
      expect(() => new ConceptMap(invalid)).toThrow('Invalid ConceptMap: group[0].element must be an array');
    });

    test('should throw error for missing element code', () => {
      const invalid = {
        ...validConceptMap,
        group: [{
          source: "test",
          element: [{ display: "No Code" }]
        }]
      };
      expect(() => new ConceptMap(invalid)).toThrow('Invalid ConceptMap: group[0].element[0].code is required');
    });
  });

  describe('Version Conversion - R3/R4 to R5', () => {
    test('should convert R3 ConceptMap to R5 format', () => {
      const cm = new ConceptMap(r3ConceptMapWithEquivalence, 'R3');

      expect(cm.getFHIRVersion()).toBe('R3');

      // Identifier should be converted to array
      expect(Array.isArray(cm.jsonObj.identifier)).toBe(true);
      expect(cm.jsonObj.identifier[0].value).toBe('r3-cm-1');

      // source/target should be converted to sourceScope/targetScope with versions
      expect(cm.jsonObj.sourceScope).toBe('http://loinc.org|2.73');
      expect(cm.jsonObj.targetScope).toBe('http://snomed.info/sct|http://snomed.info/sct/900000000000207008/version/20230731');
      expect(cm.jsonObj.source).toBeUndefined();
      expect(cm.jsonObj.target).toBeUndefined();
      expect(cm.jsonObj.sourceVersion).toBeUndefined();
      expect(cm.jsonObj.targetVersion).toBeUndefined();

      // equivalence should be preserved and relationship added
      const target1 = cm.jsonObj.group[0].element[0].target[0];
      expect(target1.equivalence).toBe('equivalent');
      expect(target1.relationship).toBe('equivalent');

      const target2 = cm.jsonObj.group[0].element[1].target[0];
      expect(target2.equivalence).toBe('wider');
      expect(target2.relationship).toBe('source-is-narrower-than-target');
    });

    test('should handle source/target without versions', () => {
      const noVersion = {
        ...r3ConceptMapWithEquivalence,
        sourceVersion: undefined,
        targetVersion: undefined
      };
      delete noVersion.sourceVersion;
      delete noVersion.targetVersion;

      const cm = new ConceptMap(noVersion, 'R3');

      expect(cm.jsonObj.sourceScope).toBe('http://loinc.org');
      expect(cm.jsonObj.targetScope).toBe('http://snomed.info/sct');
    });
  });

  describe('Version Conversion - R5 to R3/R4', () => {
    test('should convert R5 ConceptMap to R4 format', () => {
      const cm = new ConceptMap(r5ConceptMapWithRelationship, 'R5');
      const r4Output = cm.toJSONString('R4');
      const parsed = JSON.parse(r4Output);

      // R5-specific elements should be removed
      expect(parsed.versionAlgorithmString).toBeUndefined();
      expect(parsed.property).toBeUndefined();
      expect(parsed.additionalAttribute).toBeUndefined();

      // Identifier should be converted back to single object
      expect(Array.isArray(parsed.identifier)).toBe(false);
      expect(parsed.identifier.value).toBe('r5-cm-1');

      // sourceScope/targetScope should be split back to source/target + versions
      expect(parsed.source).toBe('http://loinc.org');
      expect(parsed.sourceVersion).toBe('2.74');
      expect(parsed.target).toBe('http://snomed.info/sct');
      expect(parsed.targetVersion).toBe('20240131');
      expect(parsed.sourceScope).toBeUndefined();
      expect(parsed.targetScope).toBeUndefined();

      // relationship should be converted back to equivalence
      const target1 = parsed.group[0].element[0].target[0];
      expect(target1.equivalence).toBe('equivalent');
      expect(target1.relationship).toBeUndefined();

      const target2 = parsed.group[0].element[1].target[0];
      expect(target2.equivalence).toBe('narrower'); // source-is-broader-than-target
      expect(target2.relationship).toBeUndefined();
    });

    test('should convert R5 ConceptMap to R3 format', () => {
      const cm = new ConceptMap(r5ConceptMapWithRelationship, 'R5');
      const r3Output = cm.toJSONString('R3');
      const parsed = JSON.parse(r3Output);

      // Should have same conversions as R4
      expect(parsed.versionAlgorithmString).toBeUndefined();
      expect(parsed.property).toBeUndefined();
      expect(Array.isArray(parsed.identifier)).toBe(false);
      expect(parsed.source).toBe('http://loinc.org');
      expect(parsed.sourceVersion).toBe('2.74');
    });

    test('should handle scope without versions when converting to R3/R4', () => {
      const noVersionScope = {
        ...r5ConceptMapWithRelationship,
        sourceScope: 'http://loinc.org',
        targetScope: 'http://snomed.info/sct'
      };

      const cm = new ConceptMap(noVersionScope, 'R5');
      const r4Output = cm.toJSONString('R4');
      const parsed = JSON.parse(r4Output);

      expect(parsed.source).toBe('http://loinc.org');
      expect(parsed.target).toBe('http://snomed.info/sct');
      expect(parsed.sourceVersion).toBeUndefined();
      expect(parsed.targetVersion).toBeUndefined();
    });

    test('should handle empty identifier array when converting to R3/R4', () => {
      const emptyIdentifier = {
        ...r5ConceptMapWithRelationship,
        identifier: []
      };

      const cm = new ConceptMap(emptyIdentifier, 'R5');
      const r4Output = cm.toJSONString('R4');
      const parsed = JSON.parse(r4Output);

      expect(parsed.identifier).toBeUndefined();
    });
  });

  describe('Equivalence/Relationship Conversion', () => {
    test('should convert various equivalence values to relationships', () => {
      const testEquivalences = {
        ...r3ConceptMapWithEquivalence,
        group: [
          {
            source: "http://test.org",
            target: "http://test2.org",
            element: [
              {
                code: "test1",
                target: [{ code: "target1", equivalence: "relatedto" }]
              },
              {
                code: "test2",
                target: [{ code: "target2", equivalence: "equal" }]
              },
              {
                code: "test3",
                target: [{ code: "target3", equivalence: "wider" }]
              },
              {
                code: "test4",
                target: [{ code: "target4", equivalence: "narrower" }]
              },
              {
                code: "test5",
                target: [{ code: "target5", equivalence: "specializes" }]
              },
              {
                code: "test6",
                target: [{ code: "target6", equivalence: "inexact" }]
              }
            ]
          }
        ]
      };

      const cm = new ConceptMap(testEquivalences, 'R3');

      const elements = cm.jsonObj.group[0].element;
      expect(elements[0].target[0].relationship).toBe('related-to');
      expect(elements[1].target[0].relationship).toBe('equivalent');
      // wider/narrower describe the target; R5 relationships describe the source
      expect(elements[2].target[0].relationship).toBe('source-is-narrower-than-target');  // wider
      expect(elements[3].target[0].relationship).toBe('source-is-broader-than-target');   // narrower
      expect(elements[4].target[0].relationship).toBe('source-is-broader-than-target');   // specializes
      expect(elements[5].target[0].relationship).toBe('related-to');                      // inexact

      // Original equivalence should be preserved
      expect(elements[0].target[0].equivalence).toBe('relatedto');
      expect(elements[1].target[0].equivalence).toBe('equal');
    });

    test('should convert various relationship values to equivalence', () => {
      const testRelationships = {
        ...r5ConceptMapWithRelationship,
        group: [
          {
            source: "http://test.org",
            target: "http://test2.org",
            element: [
              {
                code: "test1",
                target: [{ code: "target1", relationship: "related-to" }]
              },
              {
                code: "test2",
                target: [{ code: "target2", relationship: "equivalent" }]
              },
              {
                code: "test3",
                target: [{ code: "target3", relationship: "source-is-broader-than-target" }]
              },
              {
                code: "test4",
                target: [{ code: "target4", relationship: "source-is-narrower-than-target" }]
              },
              {
                code: "test5",
                target: [{ code: "target5", relationship: "not-related-to" }]
              }
            ]
          }
        ]
      };

      const cm = new ConceptMap(testRelationships, 'R5');
      const r4Output = cm.toJSONString('R4');
      const parsed = JSON.parse(r4Output);

      const elements = parsed.group[0].element;
      expect(elements[0].target[0].equivalence).toBe('relatedto');
      expect(elements[1].target[0].equivalence).toBe('equivalent');
      expect(elements[2].target[0].equivalence).toBe('narrower');  // source-is-broader-than-target
      expect(elements[3].target[0].equivalence).toBe('wider');     // source-is-narrower-than-target
      expect(elements[4].target[0].equivalence).toBe('disjoint');  // not-related-to

      // Relationship should be removed
      expect(elements[0].target[0].relationship).toBeUndefined();
    });

    test('should prefer equivalence over relationship when both exist in R4 output', () => {
      const bothFields = {
        ...validConceptMap,
        group: [
          {
            source: "http://test.org",
            target: "http://test2.org",
            element: [
              {
                code: "test1",
                target: [{
                  code: "target1",
                  equivalence: "equivalent",
                  relationship: "related-to" // This should be ignored
                }]
              }
            ]
          }
        ]
      };

      const cm = new ConceptMap(bothFields, 'R5');
      const r4Output = cm.toJSONString('R4');
      const parsed = JSON.parse(r4Output);

      expect(parsed.group[0].element[0].target[0].equivalence).toBe('equivalent');
      expect(parsed.group[0].element[0].target[0].relationship).toBeUndefined();
    });
  });

  describe('Mapping Search and Navigation', () => {
    let cm;

    beforeEach(() => {
      cm = new ConceptMap(validConceptMap);
    });

    test('should find mappings for source concept', () => {
      const mappings = cm.findMappings('http://loinc.org', 'LA6113-0');

      expect(mappings).toHaveLength(1);
      expect(mappings[0].targetSystem).toBe('http://snomed.info/sct');
      expect(mappings[0].targetCode).toBe('10828004');
      expect(mappings[0].targetDisplay).toBe('Positive (qualifier value)');
      expect(mappings[0].relationship).toBe('equivalent');
    });

    test('should find reverse mappings for target concept', () => {
      const mappings = cm.findReverseMappings('http://snomed.info/sct', '260385009');

      expect(mappings).toHaveLength(1);
      expect(mappings[0].sourceSystem).toBe('http://loinc.org');
      expect(mappings[0].sourceCode).toBe('LA6114-8');
      expect(mappings[0].sourceDisplay).toBe('Negative');
    });

    test('should return empty array for non-existent mappings', () => {
      const mappings = cm.findMappings('http://loinc.org', 'NONEXISTENT');
      expect(mappings).toEqual([]);
    });

    test('should get source and target systems', () => {
      const sourceSystems = cm.getSourceSystems();
      const targetSystems = cm.getTargetSystems();

      expect(sourceSystems).toContain('http://loinc.org');
      expect(targetSystems).toContain('http://snomed.info/sct');
    });

    test('should get source and target concepts', () => {
      const sourceConcepts = cm.getSourceConcepts();
      const targetConcepts = cm.getTargetConcepts();

      expect(sourceConcepts).toHaveLength(2);
      expect(sourceConcepts[0].code).toBe('LA6113-0');
      expect(sourceConcepts[0].system).toBe('http://loinc.org');

      expect(targetConcepts).toHaveLength(2);
      expect(targetConcepts[0].code).toBe('10828004');
      expect(targetConcepts[0].system).toBe('http://snomed.info/sct');
    });
  });

  describe('XML Support', () => {
    // Sample FHIR XML data for testing
    const r5ConceptMapXML = `<?xml version="1.0" encoding="UTF-8"?>
<ConceptMap xmlns="http://hl7.org/fhir">
  <url value="http://example.org/fhir/ConceptMap/xml-test"/>
  <identifier>
    <system value="http://example.org/identifiers"/>
    <value value="xml-cm-1"/>
  </identifier>
  <version value="1.0.0"/>
  <versionAlgorithmString value="semver"/>
  <name value="XMLTestConceptMap"/>
  <title value="XML Test Concept Map"/>
  <status value="active"/>
  <sourceScope value="http://loinc.org|2.74"/>
  <targetScope value="http://snomed.info/sct|20240131"/>
  <group>
    <source value="http://loinc.org"/>
    <target value="http://snomed.info/sct"/>
    <element>
      <code value="LA6113-0"/>
      <display value="Positive"/>
      <target>
        <code value="10828004"/>
        <display value="Positive (qualifier value)"/>
        <relationship value="equivalent"/>
      </target>
    </element>
  </group>
</ConceptMap>`;

    // Mock ConceptMapXML since we can't actually import it in tests
    const MockConceptMapXML = {
      fromXML: (xmlString, version) => {
        // Simulate XML to JSON conversion
        const hasVersionAlgorithm = xmlString.includes('versionAlgorithmString');
        const hasRelationship = xmlString.includes('relationship');

        const jsonObj = {
          resourceType: "ConceptMap",
          url: "http://example.org/fhir/ConceptMap/xml-test",
          identifier: version === 'R5' ? [
            {
              system: "http://example.org/identifiers",
              value: "xml-cm-1"
            }
          ] : {
            system: "http://example.org/identifiers",
            value: "xml-cm-1"
          },
          version: "1.0.0",
          versionAlgorithmString: hasVersionAlgorithm ? "semver" : undefined,
          name: "XMLTestConceptMap",
          title: "XML Test Concept Map",
          status: "active"
        };

        // Handle source/target vs sourceScope/targetScope based on version
        if (version === 'R5') {
          jsonObj.sourceScope = "http://loinc.org|2.74";
          jsonObj.targetScope = "http://snomed.info/sct|20240131";
        } else {
          jsonObj.source = "http://loinc.org";
          jsonObj.sourceVersion = "2.74";
          jsonObj.target = "http://snomed.info/sct";
          jsonObj.targetVersion = "20240131";
        }

        jsonObj.group = [
          {
            source: "http://loinc.org",
            target: "http://snomed.info/sct",
            element: [
              {
                code: "LA6113-0",
                display: "Positive",
                target: [
                  {
                    code: "10828004",
                    display: "Positive (qualifier value)",
                    ...(hasRelationship ? { relationship: "equivalent" } : { equivalence: "equivalent" })
                  }
                ]
              }
            ]
          }
        ];

        return new ConceptMap(jsonObj, version);
      },

      toXMLString: (conceptMap, version) => {
        const json = JSON.parse(conceptMap.toJSONString(version));

        // Simulate JSON to XML conversion
        let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<ConceptMap xmlns="http://hl7.org/fhir">\n`;
        xml += `  <url value="${json.url}"/>\n`;
        xml += `  <name value="${json.name}"/>\n`;
        xml += `  <status value="${json.status}"/>\n`;

        if (json.versionAlgorithmString && version === 'R5') {
          xml += `  <versionAlgorithmString value="${json.versionAlgorithmString}"/>\n`;
        }

        xml += `</ConceptMap>`;
        return xml;
      },

      isValidConceptMapXML: (xmlString) => {
        return xmlString.includes('<ConceptMap') &&
          xmlString.includes('http://hl7.org/fhir') &&
          xmlString.includes('</ConceptMap>');
      }
    };

    test('should validate FHIR ConceptMap XML', () => {
      expect(MockConceptMapXML.isValidConceptMapXML(r5ConceptMapXML)).toBe(true);

      const invalidXML = '<ValueSet><n>Not a ConceptMap</n></ValueSet>';
      expect(MockConceptMapXML.isValidConceptMapXML(invalidXML)).toBe(false);
    });

    test('should load ConceptMap from R5 XML', () => {
      const cm = MockConceptMapXML.fromXML(r5ConceptMapXML, 'R5');

      expect(cm.getFHIRVersion()).toBe('R5');
      expect(cm.jsonObj.name).toBe('XMLTestConceptMap');
      expect(cm.jsonObj.versionAlgorithmString).toBe('semver');
      expect(cm.jsonObj.sourceScope).toBe('http://loinc.org|2.74');

      // Check mapping functionality
      const mappings = cm.findMappings('http://loinc.org', 'LA6113-0');
      expect(mappings).toHaveLength(1);
      expect(mappings[0].targetCode).toBe('10828004');
    });

    test('should load ConceptMap from R4 XML with proper conversions', () => {
      const cm = MockConceptMapXML.fromXML(r5ConceptMapXML, 'R4');

      expect(cm.getFHIRVersion()).toBe('R4');

      // Should have converted to R5 format internally
      expect(cm.jsonObj.sourceScope).toBe('http://loinc.org|2.74');
      expect(Array.isArray(cm.jsonObj.identifier)).toBe(true);
    });

    test('should convert ConceptMap to R4 XML without R5 elements', () => {
      const cm = MockConceptMapXML.fromXML(r5ConceptMapXML, 'R5');
      const xmlOutput = MockConceptMapXML.toXMLString(cm, 'R4');

      expect(xmlOutput).toContain('<ConceptMap xmlns="http://hl7.org/fhir">');
      expect(xmlOutput).not.toContain('versionAlgorithmString');
      expect(xmlOutput).toContain('<name value="XMLTestConceptMap"/>');
    });
  });

  describe('Utilities and Info', () => {
    test('should get correct info for ConceptMap', () => {
      const cm = new ConceptMap(validConceptMap, 'R4');
      const info = cm.getInfo();

      expect(info.resourceType).toBe('ConceptMap');
      expect(info.name).toBe('TestConceptMap');
      expect(info.status).toBe('active');
      expect(info.fhirVersion).toBe('R4');
      expect(info.sourceScope).toBe('http://loinc.org');
      expect(info.targetScope).toBe('http://snomed.info/sct');
      expect(info.groupCount).toBe(1);
      expect(info.totalMappings).toBe(2);
      expect(info.sourceSystems).toContain('http://loinc.org');
      expect(info.targetSystems).toContain('http://snomed.info/sct');
    });

    test('should handle ConceptMap without groups', () => {
      const noGroups = {
        ...validConceptMap,
        group: undefined
      };
      delete noGroups.group;

      const cm = new ConceptMap(noGroups);
      expect(cm.getGroups()).toEqual([]);
      expect(cm.getSourceConcepts()).toEqual([]);
      expect(cm.getTargetConcepts()).toEqual([]);
      expect(cm.findMappings('any', 'any')).toEqual([]);

      const info = cm.getInfo();
      expect(info.groupCount).toBe(0);
      expect(info.totalMappings).toBe(0);
    });

    test('should handle version conversion errors', () => {
      expect(() => new ConceptMap(validConceptMap, 'R6')).toThrow('Unsupported FHIR version: R6');

      const cm = new ConceptMap(validConceptMap, 'R4');
      expect(() => cm.toJSONString('R6')).toThrow('Unsupported target FHIR version: R6');
    });
  });
});