/**
 * Test cases for CodeSystem class
 * These tests can be run with Jest, Mocha, or any similar testing framework
 */
const { CodeSystem } = require('../../tx/library/codesystem');

describe('CodeSystem', () => {
  // Test data
  const validCodeSystem = {
    "resourceType": "CodeSystem",
    "url": "http://example.org/fhir/CodeSystem/test",
    "version": "1.0.0",
    "name": "TestCodeSystem",
    "title": "Test Code System",
    "status": "active",
    "concept": [
      {
        "code": "root1",
        "display": "Root Concept 1",
        "definition": "First root concept"
      },
      {
        "code": "root2",
        "display": "Root Concept 2",
        "definition": "Second root concept"
      },
      {
        "code": "child1",
        "display": "Child 1",
        "property": [
          {
            "code": "parent",
            "valueCode": "root1"
          }
        ]
      },
      {
        "code": "child2",
        "display": "Child 2",
        "property": [
          {
            "code": "parent",
            "valueCode": "root1"
          },
          {
            "code": "parent",
            "valueCode": "root2"
          }
        ]
      },
      {
        "code": "grandchild1",
        "display": "Grandchild 1",
        "property": [
          {
            "code": "parent",
            "valueCode": "child1"
          }
        ]
      }
    ]
  };

  const nestedCodeSystem = {
    "resourceType": "CodeSystem",
    "url": "http://example.org/fhir/CodeSystem/nested",
    "name": "NestedCodeSystem",
    "status": "active",
    "concept": [
      {
        "code": "animals",
        "display": "Animals",
        "concept": [
          {
            "code": "mammals",
            "display": "Mammals",
            "concept": [
              {
                "code": "dogs",
                "display": "Dogs"
              },
              {
                "code": "cats",
                "display": "Cats"
              }
            ]
          },
          {
            "code": "birds",
            "display": "Birds"
          }
        ]
      }
    ]
  };

  const emptyCodeSystem = {
    "resourceType": "CodeSystem",
    "url": "http://example.org/fhir/CodeSystem/empty",
    "name": "EmptyCodeSystem",
    "status": "active"
  };

  describe('Constructor and Validation', () => {
    test('should create CodeSystem with valid data', () => {
      const cs = new CodeSystem(validCodeSystem);
      expect(cs.jsonObj).toEqual(validCodeSystem);
    });

    test('should create CodeSystem from JSON string', () => {
      const cs = CodeSystem.fromJSON(JSON.stringify(validCodeSystem));
      expect(cs.jsonObj).toEqual(validCodeSystem);
    });

    test('should throw error for null input', () => {
      expect(() => new CodeSystem(null)).toThrow('Invalid CodeSystem: expected object');
    });

    test('should throw error for non-object input', () => {
      expect(() => new CodeSystem("not an object")).toThrow('Invalid CodeSystem: expected object');
    });

    test('should throw error for wrong resourceType', () => {
      const invalid = { ...validCodeSystem, resourceType: "ValueSet" };
      expect(() => new CodeSystem(invalid)).toThrow('Invalid CodeSystem: resourceType must be "CodeSystem"');
    });

    test('should throw error for missing url', () => {
      const invalid = { ...validCodeSystem };
      delete invalid.url;
      expect(() => new CodeSystem(invalid)).toThrow('Invalid CodeSystem: url is required');
    });

    test('should throw error for invalid status', () => {
      const invalid = { ...validCodeSystem, status: "invalid" };
      expect(() => new CodeSystem(invalid)).toThrow('Invalid CodeSystem: status must be one of');
    });

    test('should throw error for non-array concept', () => {
      const invalid = { ...validCodeSystem, concept: "not an array" };
      expect(() => new CodeSystem(invalid)).toThrow('Invalid CodeSystem: concept must be an array');
    });

    test('should throw error for concept without code', () => {
      const invalid = {
        ...validCodeSystem,
        concept: [{ display: "No Code" }]
      };
      expect(() => new CodeSystem(invalid)).toThrow('Invalid CodeSystem: concept[0].code is required');
    });

    test('should accept empty CodeSystem', () => {
      const cs = new CodeSystem(emptyCodeSystem);
      expect(cs.getAllCodes()).toEqual([]);
    });
  });

  describe('Basic Concept Lookup', () => {
    let cs;

    beforeEach(() => {
      cs = new CodeSystem(validCodeSystem);
    });

    test('should find concept by code', () => {
      const concept = cs.getConceptByCode("root1");
      expect(concept).toBeDefined();
      expect(concept.code).toBe("root1");
      expect(concept.display).toBe("Root Concept 1");
    });

    test('should return undefined for non-existent code', () => {
      const concept = cs.getConceptByCode("nonexistent");
      expect(concept).toBeUndefined();
    });

    test('should find concept by display', () => {
      const concept = cs.getConceptByDisplay("Child 1");
      expect(concept).toBeDefined();
      expect(concept.code).toBe("child1");
    });

    test('should return undefined for non-existent display', () => {
      const concept = cs.getConceptByDisplay("Non-existent Display");
      expect(concept).toBeUndefined();
    });

    test('should check if code exists', () => {
      expect(cs.hasCode("root1")).toBe(true);
      expect(cs.hasCode("nonexistent")).toBe(false);
    });

    test('should get all codes', () => {
      const allCodes = cs.getAllCodes();
      expect(allCodes).toContain("root1");
      expect(allCodes).toContain("child1");
      expect(allCodes).toContain("grandchild1");
      expect(allCodes.length).toBe(5);
    });

    test('should get all concepts', () => {
      const allConcepts = cs.getAllConcepts();
      expect(allConcepts.length).toBe(5);
      expect(allConcepts.some(c => c.code === "root1")).toBe(true);
    });
  });

  describe('Hierarchy - Property-based', () => {
    let cs;

    beforeEach(() => {
      cs = new CodeSystem(validCodeSystem);
    });

    test('should get children of parent', () => {
      const children = cs.getChildren("root1");
      expect(children).toContain("child1");
      expect(children).toContain("child2");
      expect(children.length).toBe(2);
    });

    test('should get parents of child', () => {
      const parents = cs.getParents("child2");
      expect(parents).toContain("root1");
      expect(parents).toContain("root2");
      expect(parents.length).toBe(2);
    });

    test('should return empty array for non-existent relationships', () => {
      expect(cs.getChildren("nonexistent")).toEqual([]);
      expect(cs.getParents("nonexistent")).toEqual([]);
      expect(cs.getChildren("grandchild1")).toEqual([]);
      expect(cs.getParents("root1")).toEqual([]);
    });

    test('should get descendants', () => {
      const descendants = cs.getDescendants("root1");
      expect(descendants).toContain("child1");
      expect(descendants).toContain("child2");
      expect(descendants).toContain("grandchild1");
      expect(descendants.length).toBe(3);
    });

    test('should get ancestors', () => {
      const ancestors = cs.getAncestors("grandchild1");
      expect(ancestors).toContain("child1");
      expect(ancestors).toContain("root1");
      expect(ancestors.length).toBe(2);
    });

    test('should check descendant relationship', () => {
      expect(cs.isDescendantOf("grandchild1", "root1")).toBe(true);
      expect(cs.isDescendantOf("child1", "root1")).toBe(true);
      expect(cs.isDescendantOf("root1", "grandchild1")).toBe(false);
      expect(cs.isDescendantOf("child1", "root2")).toBe(false);
    });

    test('should get root concepts', () => {
      const roots = cs.getRootConcepts();
      expect(roots).toContain("root1");
      expect(roots).toContain("root2");
      expect(roots.length).toBe(2);
    });

    test('should get leaf concepts', () => {
      const leaves = cs.getLeafConcepts();
      expect(leaves).toContain("grandchild1");
      expect(leaves).toContain("child2");
      expect(leaves.length).toBe(2);
    });
  });

  describe('Hierarchy - Nested Structure', () => {
    let cs;

    beforeEach(() => {
      cs = new CodeSystem(nestedCodeSystem);
    });

    test('should build hierarchy from nested structure', () => {
      const children = cs.getChildren("animals");
      expect(children).toContain("mammals");
      expect(children).toContain("birds");
    });

    test('should handle multi-level nesting', () => {
      const children = cs.getChildren("mammals");
      expect(children).toContain("dogs");
      expect(children).toContain("cats");
    });

    test('should get correct parents in nested structure', () => {
      const parents = cs.getParents("dogs");
      expect(parents).toContain("mammals");
      expect(parents.length).toBe(1);
    });

    test('should get all descendants in nested structure', () => {
      const descendants = cs.getDescendants("animals");
      expect(descendants).toContain("mammals");
      expect(descendants).toContain("birds");
      expect(descendants).toContain("dogs");
      expect(descendants).toContain("cats");
      expect(descendants.length).toBe(4);
    });

    test('should get all ancestors in nested structure', () => {
      const ancestors = cs.getAncestors("dogs");
      expect(ancestors).toContain("mammals");
      expect(ancestors).toContain("animals");
      expect(ancestors.length).toBe(2);
    });
  });

  describe('Edge Cases', () => {
    test('should handle CodeSystem with no concepts', () => {
      const cs = new CodeSystem(emptyCodeSystem);
      expect(cs.getAllCodes()).toEqual([]);
      expect(cs.getRootConcepts()).toEqual([]);
      expect(cs.getLeafConcepts()).toEqual([]);
      expect(cs.getChildren("anything")).toEqual([]);
    });

    test('should handle concepts with no display', () => {
      const csData = {
        ...validCodeSystem,
        concept: [
          {
            "code": "no-display"
          }
        ]
      };
      const cs = new CodeSystem(csData);
      expect(cs.hasCode("no-display")).toBe(true);
      expect(cs.getConceptByDisplay("no-display")).toBeUndefined();
    });

    test('should handle concepts with empty property arrays', () => {
      const csData = {
        ...validCodeSystem,
        concept: [
          {
            "code": "empty-props",
            "property": []
          }
        ]
      };
      const cs = new CodeSystem(csData);
      expect(cs.getParents("empty-props")).toEqual([]);
      expect(cs.getChildren("empty-props")).toEqual([]);
    });

    test('should handle circular references without infinite loops', () => {
      const csData = {
        "resourceType": "CodeSystem",
        "url": "http://example.org/circular",
        "name": "CircularTest",
        "status": "active",
        "concept": [
          {
            "code": "a",
            "property": [{ "code": "parent", "valueCode": "b" }]
          },
          {
            "code": "b",
            "property": [{ "code": "parent", "valueCode": "a" }]
          }
        ]
      };

      const cs = new CodeSystem(csData);
      // Should not cause infinite loops
      const ancestorsA = cs.getAncestors("a");
      const ancestorsB = cs.getAncestors("b");

      expect(ancestorsA).toContain("b");
      expect(ancestorsB).toContain("a");
      expect(ancestorsA.length).toBe(1);
      expect(ancestorsB.length).toBe(1);
    });
  });

  describe('Utility Methods', () => {
    let cs;

    beforeEach(() => {
      cs = new CodeSystem(validCodeSystem);
    });

    test('should convert to JSON string', () => {
      const jsonString = cs.toJSONString();
      const parsed = JSON.parse(jsonString);
      expect(parsed).toEqual(validCodeSystem);
    });

    test('should get system info', () => {
      const info = cs.getInfo();
      expect(info.resourceType).toBe("CodeSystem");
      expect(info.url).toBe("http://example.org/fhir/CodeSystem/test");
      expect(info.name).toBe("TestCodeSystem");
      expect(info.status).toBe("active");
      expect(info.conceptCount).toBe(5);
      expect(info.rootConceptCount).toBe(2);
      expect(info.leafConceptCount).toBe(2);
    });

    test('should handle missing optional fields in info', () => {
      const minimal = {
        "resourceType": "CodeSystem",
        "url": "http://example.org/minimal",
        "name": "Minimal",
        "status": "draft"
      };
      const cs = new CodeSystem(minimal);
      const info = cs.getInfo();
      expect(info.version).toBeUndefined();
      expect(info.title).toBeUndefined();
      expect(info.conceptCount).toBe(0);
    });
  });

  describe('FHIR Version Conversion', () => {
    const r5CodeSystemWithFilter = {
      "resourceType": "CodeSystem",
      "url": "http://example.org/fhir/CodeSystem/version-test",
      "name": "VersionTestCodeSystem",
      "status": "active",
      "versionAlgorithmString": "semver",
      "identifier": [
        {
          "system": "http://example.org/identifiers",
          "value": "test-identifier-1"
        },
        {
          "system": "http://example.org/identifiers",
          "value": "test-identifier-2"
        }
      ],
      "filter": [
        {
          "code": "concept",
          "operator": ["=", "is-a", "generalizes", "regex"],
          "value": "A string value"
        }
      ],
      "concept": [
        {
          "code": "test1",
          "display": "Test 1"
        }
      ]
    };

    const r3CodeSystemWithSingleIdentifier = {
      "resourceType": "CodeSystem",
      "url": "http://example.org/fhir/CodeSystem/r3-test",
      "name": "R3TestCodeSystem",
      "status": "active",
      "identifier": {
        "system": "http://example.org/identifiers",
        "value": "r3-identifier"
      },
      "concept": [
        {
          "code": "test1",
          "display": "Test 1"
        }
      ]
    };

    const r4CodeSystem = {
      "resourceType": "CodeSystem",
      "url": "http://example.org/fhir/CodeSystem/r4-test",
      "name": "R4TestCodeSystem",
      "status": "active",
      "identifier": [
        {
          "system": "http://example.org/identifiers",
          "value": "r4-identifier"
        }
      ],
      "concept": [
        {
          "code": "test1",
          "display": "Test 1"
        }
      ]
    };

    test('should load R5 CodeSystem without conversion', () => {
      const cs = new CodeSystem(r5CodeSystemWithFilter, 'R5');
      expect(cs.getFHIRVersion()).toBe('R5');
      expect(cs.jsonObj.versionAlgorithmString).toBe('semver');
      expect(Array.isArray(cs.jsonObj.identifier)).toBe(true);
      expect(cs.jsonObj.identifier.length).toBe(2);
    });

    test('should load R3 CodeSystem and convert identifier to array', () => {
      const cs = new CodeSystem(r3CodeSystemWithSingleIdentifier, 'R3');
      expect(cs.getFHIRVersion()).toBe('R3');
      expect(cs.hasCode('test1')).toBe(true);

      // After conversion, identifier should be an array
      expect(Array.isArray(cs.jsonObj.identifier)).toBe(true);
      expect(cs.jsonObj.identifier.length).toBe(1);
      expect(cs.jsonObj.identifier[0].value).toBe('r3-identifier');
    });

    test('should load R4 CodeSystem and maintain identifier array', () => {
      const cs = new CodeSystem(r4CodeSystem, 'R4');
      expect(cs.getFHIRVersion()).toBe('R4');
      expect(cs.hasCode('test1')).toBe(true);

      // Identifier should remain as array
      expect(Array.isArray(cs.jsonObj.identifier)).toBe(true);
      expect(cs.jsonObj.identifier.length).toBe(1);
      expect(cs.jsonObj.identifier[0].value).toBe('r4-identifier');
    });

    test('should output R5 format by default', () => {
      const cs = new CodeSystem(r5CodeSystemWithFilter, 'R5');
      const output = cs.toJSONString();
      const parsed = JSON.parse(output);
      expect(parsed.versionAlgorithmString).toBe('semver');
      expect(parsed.filter[0].operator).toContain('generalizes');
      expect(Array.isArray(parsed.identifier)).toBe(true);
      expect(parsed.identifier.length).toBe(2);
    });

    test('should convert R5 to R4 format on output', () => {
      const cs = new CodeSystem(r5CodeSystemWithFilter, 'R5');
      const output = cs.toJSONString('R4');
      const parsed = JSON.parse(output);

      // R5-specific elements should be removed
      expect(parsed.versionAlgorithmString).toBeUndefined();

      // Identifier should remain as array in R4
      expect(Array.isArray(parsed.identifier)).toBe(true);
      expect(parsed.identifier.length).toBe(2);

      // 'generalizes' is a valid R4 operator (filter-operator value set, 4.0.1)
      // and must be retained on R5 -> R4 conversion
      expect(parsed.filter[0].operator).toContain('generalizes');
      expect(parsed.filter[0].operator).toContain('=');
      expect(parsed.filter[0].operator).toContain('is-a');
    });

    test('should convert R5 to R3 format on output with single identifier', () => {
      const cs = new CodeSystem(r5CodeSystemWithFilter, 'R5');
      const output = cs.toJSONString('R3');
      const parsed = JSON.parse(output);

      // R5-specific elements should be removed
      expect(parsed.versionAlgorithmString).toBeUndefined();

      // Identifier should be converted back to single object
      expect(Array.isArray(parsed.identifier)).toBe(false);
      expect(typeof parsed.identifier).toBe('object');
      expect(parsed.identifier.value).toBe('test-identifier-1'); // First one

      // Only R3-compatible operators should remain
      expect(parsed.filter[0].operator).not.toContain('generalizes');
      expect(parsed.filter[0].operator).toContain('=');
      expect(parsed.filter[0].operator).toContain('is-a');
    });

    test('should handle R3 CodeSystem with no identifier', () => {
      const r3NoIdentifier = { ...r3CodeSystemWithSingleIdentifier };
      delete r3NoIdentifier.identifier;

      const cs = new CodeSystem(r3NoIdentifier, 'R3');
      expect(cs.jsonObj.identifier).toBeUndefined();

      const r3Output = cs.toJSONString('R3');
      const parsed = JSON.parse(r3Output);
      expect(parsed.identifier).toBeUndefined();
    });

    test('should handle R5 to R3 conversion with empty identifier array', () => {
      const r5EmptyIdentifier = {
        ...r5CodeSystemWithFilter,
        identifier: []
      };

      const cs = new CodeSystem(r5EmptyIdentifier, 'R5');
      const r3Output = cs.toJSONString('R3');
      const parsed = JSON.parse(r3Output);

      // Empty array should be removed in R3
      expect(parsed.identifier).toBeUndefined();
    });

    test('should handle CodeSystem without filters', () => {
      const simpleR5 = {
        ...r5CodeSystemWithFilter,
        versionAlgorithmString: "semver"
      };
      delete simpleR5.filter;

      const cs = new CodeSystem(simpleR5, 'R5');
      const r4Output = cs.toJSONString('R4');
      const r3Output = cs.toJSONString('R3');

      const r4Parsed = JSON.parse(r4Output);
      const r3Parsed = JSON.parse(r3Output);

      expect(r4Parsed.versionAlgorithmString).toBeUndefined();
      expect(r3Parsed.versionAlgorithmString).toBeUndefined();

      // Check identifier conversion
      expect(Array.isArray(r4Parsed.identifier)).toBe(true);
      expect(Array.isArray(r3Parsed.identifier)).toBe(false);
    });

    test('should include FHIR version in getInfo', () => {
      const cs = new CodeSystem(r4CodeSystem, 'R4');
      const info = cs.getInfo();
      expect(info.fhirVersion).toBe('R4');
    });

    test('should handle fromJSON with version parameter', () => {
      const cs = CodeSystem.fromJSON(JSON.stringify(r3CodeSystemWithSingleIdentifier), 'R3');
      expect(cs.getFHIRVersion()).toBe('R3');
      expect(cs.hasCode('test1')).toBe(true);

      // Should have converted identifier to array internally
      expect(Array.isArray(cs.jsonObj.identifier)).toBe(true);
    });

    test('should throw error for unsupported version', () => {
      expect(() => new CodeSystem(r4CodeSystem, 'R6')).toThrow('Unsupported FHIR version: R6');

      const cs = new CodeSystem(r4CodeSystem, 'R4');
      expect(() => cs.toJSONString('R6')).toThrow('Unsupported target FHIR version: R6');
    });

    test('should preserve original object when converting for output', () => {
      const cs = new CodeSystem(r5CodeSystemWithFilter, 'R5');

      // Generate R4 and R3 output
      cs.toJSONString('R4');
      cs.toJSONString('R3');

      // Original should still have R5 elements and array identifier
      expect(cs.jsonObj.versionAlgorithmString).toBe('semver');
      expect(cs.jsonObj.filter[0].operator).toContain('generalizes');
      expect(Array.isArray(cs.jsonObj.identifier)).toBe(true);
      expect(cs.jsonObj.identifier.length).toBe(2);
    });

    test('should handle empty filter operators array', () => {
      const codeSystemWithEmptyFilter = {
        ...r5CodeSystemWithFilter,
        filter: [
          {
            "code": "concept",
            "operator": ["child-of"], // Only an R5-only operator (stripped for R4)
            "value": "A string value"
          }
        ]
      };

      const cs = new CodeSystem(codeSystemWithEmptyFilter, 'R5');
      const r4Output = cs.toJSONString('R4');
      const parsed = JSON.parse(r4Output);

      // Filter should be removed if no valid operators remain
      expect(parsed.filter).toEqual([]);
    });
  });

  describe('XML Support', () => {
    // Sample FHIR XML data for testing
    const r5CodeSystemXML = `<?xml version="1.0" encoding="UTF-8"?>
<CodeSystem xmlns="http://hl7.org/fhir">
  <url value="http://example.org/fhir/CodeSystem/xml-test"/>
  <identifier>
    <system value="http://example.org/identifiers"/>
    <value value="xml-test-1"/>
  </identifier>
  <identifier>
    <system value="http://example.org/identifiers"/>
    <value value="xml-test-2"/>
  </identifier>
  <version value="1.0.0"/>
  <versionAlgorithmString value="semver"/>
  <name value="XMLTestCodeSystem"/>
  <title value="XML Test Code System"/>
  <status value="active"/>
  <filter>
    <code value="concept"/>
    <operator value="="/>
    <operator value="is-a"/>
    <operator value="generalizes"/>
    <operator value="regex"/>
    <value value="A string value"/>
  </filter>
  <concept>
    <code value="parent"/>
    <display value="Parent Concept"/>
    <concept>
      <code value="child1"/>
      <display value="Child 1"/>
    </concept>
    <concept>
      <code value="child2"/>
      <display value="Child 2"/>
    </concept>
  </concept>
  <concept>
    <code value="standalone"/>
    <display value="Standalone Concept"/>
  </concept>
</CodeSystem>`;

    const r3CodeSystemXML = `<?xml version="1.0" encoding="UTF-8"?>
<CodeSystem xmlns="http://hl7.org/fhir">
  <url value="http://example.org/fhir/CodeSystem/r3-xml-test"/>
  <identifier>
    <system value="http://example.org/identifiers"/>
    <value value="r3-identifier"/>
  </identifier>
  <name value="R3XMLTestCodeSystem"/>
  <status value="active"/>
  <concept>
    <code value="test-concept"/>
    <display value="Test Concept"/>
  </concept>
</CodeSystem>`;

    // Mock CodeSystemXML since we can't actually import it in tests
    const CodeSystemXML = {
      fromXML: (xmlString, version) => {
        // Simulate XML to JSON conversion
        const isR3 = xmlString.includes('r3-xml-test');
        const hasVersionAlgorithm = xmlString.includes('versionAlgorithmString');

        let jsonObj;
        if (isR3) {
          jsonObj = {
            resourceType: "CodeSystem",
            url: "http://example.org/fhir/CodeSystem/r3-xml-test",
            identifier: {
              system: "http://example.org/identifiers",
              value: "r3-identifier"
            },
            name: "R3XMLTestCodeSystem",
            status: "active",
            concept: [
              {
                code: "test-concept",
                display: "Test Concept"
              }
            ]
          };
        } else {
          jsonObj = {
            resourceType: "CodeSystem",
            url: "http://example.org/fhir/CodeSystem/xml-test",
            identifier: [
              {
                system: "http://example.org/identifiers",
                value: "xml-test-1"
              },
              {
                system: "http://example.org/identifiers",
                value: "xml-test-2"
              }
            ],
            version: "1.0.0",
            versionAlgorithmString: hasVersionAlgorithm ? "semver" : undefined,
            name: "XMLTestCodeSystem",
            title: "XML Test Code System",
            status: "active",
            filter: [
              {
                code: "concept",
                operator: ["=", "is-a", "generalizes", "regex"],
                value: "A string value"
              }
            ],
            concept: [
              {
                code: "parent",
                display: "Parent Concept",
                concept: [
                  {
                    code: "child1",
                    display: "Child 1"
                  },
                  {
                    code: "child2",
                    display: "Child 2"
                  }
                ]
              },
              {
                code: "standalone",
                display: "Standalone Concept"
              }
            ]
          };
        }

        return new CodeSystem(jsonObj, version);
      },

      toXMLString: (codeSystem, version) => {
        const json = JSON.parse(codeSystem.toJSONString(version));

        // Simulate JSON to XML conversion
        let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<CodeSystem xmlns="http://hl7.org/fhir">\n`;
        xml += `  <url value="${json.url}"/>\n`;

        if (version === 'R3' && json.identifier && !Array.isArray(json.identifier)) {
          // R3 single identifier
          xml += `  <identifier>\n`;
          xml += `    <system value="${json.identifier.system}"/>\n`;
          xml += `    <value value="${json.identifier.value}"/>\n`;
          xml += `  </identifier>\n`;
        } else if (json.identifier && Array.isArray(json.identifier)) {
          // R4/R5 multiple identifiers
          json.identifier.forEach(id => {
            xml += `  <identifier>\n`;
            xml += `    <system value="${id.system}"/>\n`;
            xml += `    <value value="${id.value}"/>\n`;
            xml += `  </identifier>\n`;
          });
        }

        if (json.versionAlgorithmString && version === 'R5') {
          xml += `  <versionAlgorithmString value="${json.versionAlgorithmString}"/>\n`;
        }

        xml += `  <name value="${json.name}"/>\n`;
        xml += `  <status value="${json.status}"/>\n`;

        if (json.filter && json.filter.length > 0) {
          json.filter.forEach(filter => {
            xml += `  <filter>\n`;
            xml += `    <code value="${filter.code}"/>\n`;
            filter.operator.forEach(op => {
              xml += `    <operator value="${op}"/>\n`;
            });
            xml += `    <value value="${filter.value}"/>\n`;
            xml += `  </filter>\n`;
          });
        }

        xml += `</CodeSystem>`;
        return xml;
      },

      isValidCodeSystemXML: (xmlString) => {
        return xmlString.includes('<CodeSystem') &&
          xmlString.includes('http://hl7.org/fhir') &&
          xmlString.includes('</CodeSystem>');
      }
    };

    test('should validate FHIR CodeSystem XML', () => {
      expect(CodeSystemXML.isValidCodeSystemXML(r5CodeSystemXML)).toBe(true);
      expect(CodeSystemXML.isValidCodeSystemXML(r3CodeSystemXML)).toBe(true);

      const invalidXML = '<Patient><name>Not a CodeSystem</name></Patient>';
      expect(CodeSystemXML.isValidCodeSystemXML(invalidXML)).toBe(false);
    });

    test('should load CodeSystem from R5 XML', () => {
      const cs = CodeSystemXML.fromXML(r5CodeSystemXML, 'R5');

      expect(cs.getFHIRVersion()).toBe('R5');
      expect(cs.jsonObj.url).toBe('http://example.org/fhir/CodeSystem/xml-test');
      expect(cs.jsonObj.name).toBe('XMLTestCodeSystem');
      expect(cs.jsonObj.versionAlgorithmString).toBe('semver');

      // Check identifier array
      expect(Array.isArray(cs.jsonObj.identifier)).toBe(true);
      expect(cs.jsonObj.identifier.length).toBe(2);
      expect(cs.jsonObj.identifier[0].value).toBe('xml-test-1');

      // Check filter operator array
      expect(cs.jsonObj.filter[0].operator).toContain('generalizes');
      expect(cs.jsonObj.filter[0].operator).toContain('=');

      // Check concept hierarchy
      expect(cs.hasCode('parent')).toBe(true);
      expect(cs.hasCode('child1')).toBe(true);
      expect(cs.getChildren('parent')).toContain('child1');
      expect(cs.getChildren('parent')).toContain('child2');
    });

    test('should load CodeSystem from R3 XML with identifier conversion', () => {
      const cs = CodeSystemXML.fromXML(r3CodeSystemXML, 'R3');

      expect(cs.getFHIRVersion()).toBe('R3');
      expect(cs.hasCode('test-concept')).toBe(true);

      // Should have converted single identifier to array internally
      expect(Array.isArray(cs.jsonObj.identifier)).toBe(true);
      expect(cs.jsonObj.identifier.length).toBe(1);
      expect(cs.jsonObj.identifier[0].value).toBe('r3-identifier');
    });

    test('should convert CodeSystem to R5 XML', () => {
      const cs = CodeSystemXML.fromXML(r5CodeSystemXML, 'R5');
      const xmlOutput = CodeSystemXML.toXMLString(cs, 'R5');

      expect(xmlOutput).toContain('<CodeSystem xmlns="http://hl7.org/fhir">');
      expect(xmlOutput).toContain('<url value="http://example.org/fhir/CodeSystem/xml-test"/>');
      expect(xmlOutput).toContain('<versionAlgorithmString value="semver"/>');
      expect(xmlOutput).toContain('<operator value="generalizes"/>');

      // Should have multiple identifier elements
      const identifierMatches = xmlOutput.match(/<identifier>/g);
      expect(identifierMatches).toHaveLength(2);
    });

    test('should convert CodeSystem to R4 XML without R5 elements', () => {
      const cs = CodeSystemXML.fromXML(r5CodeSystemXML, 'R5');
      const xmlOutput = CodeSystemXML.toXMLString(cs, 'R4');

      expect(xmlOutput).toContain('<CodeSystem xmlns="http://hl7.org/fhir">');
      expect(xmlOutput).not.toContain('versionAlgorithmString');
      // 'generalizes' is valid in R4 and must be retained
      expect(xmlOutput).toContain('<operator value="generalizes"/>');
      expect(xmlOutput).toContain('<operator value="="/>');
      expect(xmlOutput).toContain('<operator value="is-a"/>');

      // Should still have multiple identifier elements in R4
      const identifierMatches = xmlOutput.match(/<identifier>/g);
      expect(identifierMatches).toHaveLength(2);
    });

    test('should convert CodeSystem to R3 XML with single identifier', () => {
      const cs = CodeSystemXML.fromXML(r5CodeSystemXML, 'R5');
      const xmlOutput = CodeSystemXML.toXMLString(cs, 'R3');

      expect(xmlOutput).toContain('<CodeSystem xmlns="http://hl7.org/fhir">');
      expect(xmlOutput).not.toContain('versionAlgorithmString');
      expect(xmlOutput).not.toContain('<operator value="generalizes"/>');

      // Should have only one identifier element in R3
      const identifierMatches = xmlOutput.match(/<identifier>/g);
      expect(identifierMatches).toHaveLength(1);
      expect(xmlOutput).toContain('<value value="xml-test-1"/>'); // First identifier
    });

    test('should handle nested concepts in XML', () => {
      const cs = CodeSystemXML.fromXML(r5CodeSystemXML, 'R5');

      // Check that nested concepts are properly parsed
      expect(cs.hasCode('parent')).toBe(true);
      expect(cs.hasCode('child1')).toBe(true);
      expect(cs.hasCode('child2')).toBe(true);
      expect(cs.hasCode('standalone')).toBe(true);

      // Check hierarchy relationships
      expect(cs.getChildren('parent')).toEqual(['child1', 'child2']);
      expect(cs.getParents('child1')).toEqual(['parent']);
      expect(cs.getRootConcepts()).toEqual(['parent', 'standalone']);
    });

    test('should handle filter operators array correctly', () => {
      const cs = CodeSystemXML.fromXML(r5CodeSystemXML, 'R5');

      // Check that operators are properly parsed as array
      expect(cs.jsonObj.filter).toHaveLength(1);
      expect(Array.isArray(cs.jsonObj.filter[0].operator)).toBe(true);
      expect(cs.jsonObj.filter[0].operator).toEqual(['=', 'is-a', 'generalizes', 'regex']);
    });

    test('should round-trip conversion preserve data', () => {
      // R5: XML -> CodeSystem -> XML
      const cs = CodeSystemXML.fromXML(r5CodeSystemXML, 'R5');
      const xmlOutput = CodeSystemXML.toXMLString(cs, 'R5');
      const cs2 = CodeSystemXML.fromXML(xmlOutput, 'R5');

      expect(cs2.jsonObj.url).toBe(cs.jsonObj.url);
      expect(cs2.jsonObj.name).toBe(cs.jsonObj.name);
      expect(cs2.getAllCodes()).toEqual(cs.getAllCodes());
      expect(cs2.jsonObj.versionAlgorithmString).toBe(cs.jsonObj.versionAlgorithmString);
    });
  });

  describe('Performance and Memory', () => {
    test('should handle large code systems efficiently', () => {
      // Create a large code system
      const largeConcepts = [];
      for (let i = 0; i < 1000; i++) {
        largeConcepts.push({
          code: `code-${i}`,
          display: `Display ${i}`,
          property: i > 0 ? [{ code: "parent", valueCode: `code-${i-1}` }] : []
        });
      }

      const largeCS = {
        "resourceType": "CodeSystem",
        "url": "http://example.org/large",
        "name": "LargeCodeSystem",
        "status": "active",
        "concept": largeConcepts
      };

      const start = performance.now();
      const cs = new CodeSystem(largeCS);
      const constructTime = performance.now() - start;

      // Construction should be reasonably fast (less than 1 second)
      expect(constructTime).toBeLessThan(1000);

      // Lookups should be fast
      const lookupStart = performance.now();
      const concept = cs.getConceptByCode("code-500");
      const lookupTime = performance.now() - lookupStart;

      expect(concept).toBeDefined();
      expect(lookupTime).toBeLessThan(10); // Should be very fast with Map lookup
    });
  });

  describe('CodeSystem version comparison', () => {


    test('Test Version Comparison', () => {
      expect(compareVersions('semver', '1.2.0', 'semver', '1.1.0')).toBe(true);
    });
// --- semver (explicit) ---
    test('semver: major version newer', () => {
      expect(compareVersions('semver', '2.0.0', 'semver', '1.9.9')).toBe(true);
    });
    test('semver: minor version newer', () => {
      expect(compareVersions('semver', '1.2.0', 'semver', '1.1.0')).toBe(true);
    });
    test('semver: patch version newer', () => {
      expect(compareVersions('semver', '1.1.1', 'semver', '1.1.0')).toBe(true);
    });
    test('semver: older major', () => {
      expect(compareVersions('semver', '1.9.9', 'semver', '2.0.0')).toBe(false);
    });
    test('semver: equal versions', () => {
      expect(compareVersions('semver', '1.2.0', 'semver', '1.2.0')).toBe(false);
    });
    test('semver: pre-release vs release', () => {
      expect(compareVersions('semver', '1.0.0', 'semver', '1.0.0-alpha')).toBe(true);
    });
    test('semver: only one side declares algorithm', () => {
      expect(compareVersions('semver', '2.0.0', null, '1.0.0')).toBe(true);
    });
    test('semver: other side declares algorithm', () => {
      expect(compareVersions(null, '2.0.0', 'semver', '1.0.0')).toBe(true);
    });

// --- semver (guessed, no explicit algorithm) ---
    test('semver guessed: newer minor', () => {
      expect(compareVersions(null, '1.2.0', null, '1.1.0')).toBe(true);
    });
    test('semver guessed: older minor', () => {
      expect(compareVersions(null, '1.1.0', null, '1.2.0')).toBe(false);
    });
    test('semver guessed: equal', () => {
      expect(compareVersions(null, '1.0.0', null, '1.0.0')).toBe(false);
    });

// --- integer (explicit) ---
    test('integer: larger is newer', () => {
      expect(compareVersions('integer', '10', 'integer', '9')).toBe(true);
    });
    test('integer: smaller is not newer', () => {
      expect(compareVersions('integer', '9', 'integer', '10')).toBe(false);
    });
    test('integer: equal', () => {
      expect(compareVersions('integer', '5', 'integer', '5')).toBe(false);
    });
    test('integer: multi-digit vs single-digit', () => {
      expect(compareVersions('integer', '100', 'integer', '99')).toBe(true);
    });

// --- date (explicit) ---
    test('date: YYYY-MM-DD newer', () => {
      expect(compareVersions('date', '2024-03-15', 'date', '2024-03-14')).toBe(true);
    });
    test('date: YYYY-MM-DD older', () => {
      expect(compareVersions('date', '2024-03-14', 'date', '2024-03-15')).toBe(false);
    });
    test('date: YYYYMMDD newer', () => {
      expect(compareVersions('date', '20240315', 'date', '20240314')).toBe(true);
    });
    test('date: YYYYMMDD older', () => {
      expect(compareVersions('date', '20240314', 'date', '20240315')).toBe(false);
    });
    test('date: YYYY-MM newer', () => {
      expect(compareVersions('date', '2024-03', 'date', '2024-02')).toBe(true);
    });
    test('date: YYYYMM newer', () => {
      expect(compareVersions('date', '202403', 'date', '202402')).toBe(true);
    });
    test('date: different years', () => {
      expect(compareVersions('date', '2025-01-01', 'date', '2024-12-31')).toBe(true);
    });
    test('date: equal dates', () => {
      expect(compareVersions('date', '2024-03-15', 'date', '2024-03-15')).toBe(false);
    });
    test('date: with time component ignored', () => {
      expect(compareVersions('date', '2024-03-15T12:00:00', 'date', '2024-03-14T23:59:59')).toBe(true);
    });
    test('date: mixed format YYYY-MM-DD vs YYYYMMDD', () => {
      expect(compareVersions('date', '2024-03-15', 'date', '20240314')).toBe(true);
    });
    test('date: mixed format YYYY-MM vs YYYYMM', () => {
      expect(compareVersions('date', '2024-03', 'date', '202402')).toBe(true);
    });

// --- date (guessed, no explicit algorithm) ---
    test('date guessed: YYYY-MM-DD newer', () => {
      expect(compareVersions(null, '2024-03-15', null, '2024-03-01')).toBe(true);
    });
    test('date guessed: YYYYMMDD newer', () => {
      expect(compareVersions(null, '20240315', null, '20240301')).toBe(true);
    });
    test('date guessed: YYYYMM newer', () => {
      expect(compareVersions(null, '202403', null, '202402')).toBe(true);
    });
    test('date guessed: YYYY-MM older', () => {
      expect(compareVersions(null, '2024-01', null, '2024-03')).toBe(false);
    });

// --- alpha (explicit) ---
    test('alpha: b > a', () => {
      expect(compareVersions('alpha', 'b', 'alpha', 'a')).toBe(true);
    });
    test('alpha: a not > b', () => {
      expect(compareVersions('alpha', 'a', 'alpha', 'b')).toBe(false);
    });
    test('alpha: equal strings', () => {
      expect(compareVersions('alpha', 'release', 'alpha', 'release')).toBe(false);
    });
    test('alpha: case insensitive (R2 vs r1)', () => {
      expect(compareVersions('alpha', 'R2', 'alpha', 'r1')).toBe(true);
    });

// --- alpha (guessed - non-semver, non-date strings) ---
    test('alpha guessed: b > a', () => {
      expect(compareVersions(null, 'beta', null, 'alpha')).toBe(true);
    });
    test('alpha guessed: release > preview', () => {
      expect(compareVersions(null, 'release', null, 'preview')).toBe(true);
    });

// --- mismatched algorithms (one side wins) ---
    test('mixed algorithms: semver wins over null', () => {
      expect(compareVersions('semver', '2.0.0', null, '1.0.0')).toBe(true);
    });
    test('mixed algorithms: date wins over null', () => {
      expect(compareVersions('date', '2024-03-15', null, '2024-03-01')).toBe(true);
    });

// --- no version present ---
    test('no versions: both null', () => {
      expect(compareVersions(null, null, null, null)).toBe(false);
    });
    test('no versions: one null', () => {
      expect(compareVersions('semver', null, 'semver', '1.0.0')).toBe(false);
    });
    test('no versions: other null', () => {
      expect(compareVersions('semver', '1.0.0', 'semver', null)).toBe(false);
    });
  });
});

/**
 * Additional tests for enhanced CodeSystem validation
 * Add these to your existing CodeSystem test suite
 */

describe('Enhanced CodeSystem Validation', () => {
  const validCodeSystem = {
    "resourceType": "CodeSystem",
    "url": "http://example.org/fhir/CodeSystem/test",
    "name": "TestCodeSystem",
    "status": "active"
  };

  describe('Array Null/Undefined Validation', () => {
    test('should reject null elements in identifier array', () => {
      const invalid = {
        ...validCodeSystem,
        identifier: [
          { system: "http://example.org", value: "valid" },
          null,
          { system: "http://example.org", value: "valid2" }
        ]
      };

      expect(() => new CodeSystem(invalid)).toThrow('Invalid CodeSystem: identifier[1] is null or undefined');
    });

    test('should reject undefined elements in identifier array', () => {
      const invalid = {
        ...validCodeSystem,
        identifier: [
          { system: "http://example.org", value: "valid" },
          undefined
        ]
      };

      expect(() => new CodeSystem(invalid)).toThrow('Invalid CodeSystem: identifier[1] is null or undefined');
    });

    test('should reject null elements in jurisdiction array', () => {
      const invalid = {
        ...validCodeSystem,
        jurisdiction: [
          { coding: [{ system: "http://unstats.un.org/unsd/methods/m49/m49.htm", code: "001" }] },
          null
        ]
      };

      expect(() => new CodeSystem(invalid)).toThrow('Invalid CodeSystem: jurisdiction[1] is null or undefined');
    });

    test('should reject null elements in useContext array', () => {
      const invalid = {
        ...validCodeSystem,
        useContext: [
          { code: { system: "http://terminology.hl7.org/CodeSystem/usage-context-type", code: "focus" } },
          null
        ]
      };

      expect(() => new CodeSystem(invalid)).toThrow('Invalid CodeSystem: useContext[1] is null or undefined');
    });

    test('should reject null elements in filter array', () => {
      const invalid = {
        ...validCodeSystem,
        filter: [
          { code: "concept", operator: ["="], value: "string" },
          null
        ]
      };

      expect(() => new CodeSystem(invalid)).toThrow('Invalid CodeSystem: filter[1] is null or undefined');
    });

    test('should reject null elements in filter operator array', () => {
      const invalid = {
        ...validCodeSystem,
        filter: [
          { code: "concept", operator: ["=", null, "is-a"], value: "string" }
        ]
      };

      expect(() => new CodeSystem(invalid)).toThrow('Invalid CodeSystem: filter[0].operator[1] is null or undefined');
    });

    test('should reject null elements in property array', () => {
      const invalid = {
        ...validCodeSystem,
        property: [
          { code: "parent", type: "code" },
          null
        ]
      };

      expect(() => new CodeSystem(invalid)).toThrow('Invalid CodeSystem: property[1] is null or undefined');
    });

    test('should reject null elements in concept array', () => {
      const invalid = {
        ...validCodeSystem,
        concept: [
          { code: "valid", display: "Valid Concept" },
          null
        ]
      };

      expect(() => new CodeSystem(invalid)).toThrow('Invalid CodeSystem: concept[1] is null or undefined');
    });

    test('should reject null elements in concept designation array', () => {
      const invalid = {
        ...validCodeSystem,
        concept: [
          {
            code: "test",
            designation: [
              { language: "en", value: "English" },
              null,
              { language: "fr", value: "French" }
            ]
          }
        ]
      };

      expect(() => new CodeSystem(invalid)).toThrow('Invalid CodeSystem: concept[0].designation[1] is null or undefined');
    });

    test('should reject null elements in concept property array', () => {
      const invalid = {
        ...validCodeSystem,
        concept: [
          {
            code: "test",
            property: [
              { code: "parent", valueCode: "parent1" },
              null
            ]
          }
        ]
      };

      expect(() => new CodeSystem(invalid)).toThrow('Invalid CodeSystem: concept[0].property[1] is null or undefined');
    });

    test('should reject null elements in nested concept arrays', () => {
      const invalid = {
        ...validCodeSystem,
        concept: [
          {
            code: "parent",
            concept: [
              { code: "child1" },
              null,
              { code: "child2" }
            ]
          }
        ]
      };

      expect(() => new CodeSystem(invalid)).toThrow('Invalid CodeSystem: concept[0].concept[1] is null or undefined');
    });

    test('should reject null elements in deeply nested structures', () => {
      const invalid = {
        ...validCodeSystem,
        concept: [
          {
            code: "level1",
            concept: [
              {
                code: "level2",
                concept: [
                  { code: "level3a" },
                  null  // Deep nesting null
                ]
              }
            ]
          }
        ]
      };

      expect(() => new CodeSystem(invalid)).toThrow('Invalid CodeSystem: concept[0].concept[0].concept[1] is null or undefined');
    });

    test('should reject null elements in nested concept designations', () => {
      const invalid = {
        ...validCodeSystem,
        concept: [
          {
            code: "parent",
            concept: [
              {
                code: "child",
                designation: [
                  { language: "en", value: "Child" },
                  null
                ]
              }
            ]
          }
        ]
      };

      expect(() => new CodeSystem(invalid)).toThrow('Invalid CodeSystem: concept[0].concept[0].designation[1] is null or undefined');
    });
  });

  describe('Array Type Validation', () => {
    test('should reject non-array jurisdiction', () => {
      const invalid = {
        ...validCodeSystem,
        jurisdiction: "not an array"
      };

      expect(() => new CodeSystem(invalid)).toThrow('Invalid CodeSystem: jurisdiction must be an array if present');
    });

    test('should reject non-array useContext', () => {
      const invalid = {
        ...validCodeSystem,
        useContext: { code: "invalid" }
      };

      expect(() => new CodeSystem(invalid)).toThrow('Invalid CodeSystem: useContext must be an array if present');
    });

    test('should reject non-array filter', () => {
      const invalid = {
        ...validCodeSystem,
        filter: { code: "concept" }
      };

      expect(() => new CodeSystem(invalid)).toThrow('Invalid CodeSystem: filter must be an array if present');
    });

    test('should reject non-array property', () => {
      const invalid = {
        ...validCodeSystem,
        property: { code: "parent" }
      };

      expect(() => new CodeSystem(invalid)).toThrow('Invalid CodeSystem: property must be an array if present');
    });

    test('should reject non-array filter operator', () => {
      const invalid = {
        ...validCodeSystem,
        filter: [
          { code: "concept", operator: "=", value: "string" }  // Should be array
        ]
      };

      expect(() => new CodeSystem(invalid)).toThrow('Invalid CodeSystem: filter[0].operator must be an array if present');
    });

    test('should reject non-array concept designation', () => {
      const invalid = {
        ...validCodeSystem,
        concept: [
          {
            code: "test",
            designation: { language: "en", value: "English" }  // Should be array
          }
        ]
      };

      expect(() => new CodeSystem(invalid)).toThrow('Invalid CodeSystem: concept[0].designation must be an array if present');
    });

    test('should reject non-array concept property', () => {
      const invalid = {
        ...validCodeSystem,
        concept: [
          {
            code: "test",
            property: { code: "parent", valueCode: "parent1" }  // Should be array
          }
        ]
      };

      expect(() => new CodeSystem(invalid)).toThrow('Invalid CodeSystem: concept[0].property must be an array if present');
    });

    test('should reject non-array nested concepts', () => {
      const invalid = {
        ...validCodeSystem,
        concept: [
          {
            code: "parent",
            concept: { code: "child" }  // Should be array
          }
        ]
      };

      expect(() => new CodeSystem(invalid)).toThrow('Invalid CodeSystem: concept[0].concept must be an array if present');
    });
  });

  describe('Required Field Validation', () => {
    test('should reject filter without code', () => {
      const invalid = {
        ...validCodeSystem,
        filter: [
          "string"
        ]
      };

      expect(() => new CodeSystem(invalid)).toThrow('Invalid CodeSystem: filter[0] must be an object');
    });

    test('should reject property without code', () => {
      const invalid = {
        ...validCodeSystem,
        property: [
          { type: "code" }  // Missing code
        ]
      };

      expect(() => new CodeSystem(invalid)).toThrow('Invalid CodeSystem: property[0].code is required and must be a string');
    });

    test('should reject concept property without code', () => {
      const invalid = {
        ...validCodeSystem,
        concept: [
          {
            code: "test",
            property: [
              { valueCode: "value" }  // Missing code
            ]
          }
        ]
      };

      expect(() => new CodeSystem(invalid)).toThrow('Invalid CodeSystem: concept[0].property[0].code is required and must be a string');
    });

    test('should reject non-string filter operator elements', () => {
      const invalid = {
        ...validCodeSystem,
        filter: [
          { code: "concept", operator: ["=", 123, "is-a"], value: "string" }  // 123 is not string
        ]
      };

      expect(() => new CodeSystem(invalid)).toThrow('Invalid CodeSystem: filter[0].operator[1] must be a string');
    });
  });

  describe('Valid Cases', () => {
    test('should accept valid CodeSystem with all arrays', () => {
      const valid = {
        ...validCodeSystem,
        identifier: [
          { system: "http://example.org", value: "id1" },
          { system: "http://example.org", value: "id2" }
        ],
        jurisdiction: [
          { coding: [{ system: "http://unstats.un.org/unsd/methods/m49/m49.htm", code: "001" }] }
        ],
        useContext: [
          { code: { system: "http://terminology.hl7.org/CodeSystem/usage-context-type", code: "focus" } }
        ],
        filter: [
          { code: "concept", operator: ["=", "is-a"], value: "string" }
        ],
        property: [
          { code: "parent", type: "code" }
        ],
        concept: [
          {
            code: "parent",
            display: "Parent",
            designation: [
              { language: "en", value: "Parent English" },
              { language: "fr", value: "Parent French" }
            ],
            property: [
              { code: "status", valueString: "active" }
            ],
            concept: [
              {
                code: "child",
                display: "Child",
                designation: [
                  { language: "en", value: "Child English" }
                ]
              }
            ]
          }
        ]
      };

      expect(() => new CodeSystem(valid)).not.toThrow();
    });

    test('should accept CodeSystem with empty arrays', () => {
      const valid = {
        ...validCodeSystem,
        identifier: [],
        jurisdiction: [],
        useContext: [],
        filter: [],
        property: [],
        concept: []
      };

      expect(() => new CodeSystem(valid)).not.toThrow();
    });

    test('should accept CodeSystem with no optional arrays', () => {
      const valid = {
        ...validCodeSystem
        // No optional arrays
      };

      expect(() => new CodeSystem(valid)).not.toThrow();
    });
  });
});

function compareVersions(va1, ver1, va2, ver2) {
  let jcs1 = {resourceType: "CodeSystem", url: "http://example.org"};
  if (va1) {
    jcs1.versionAlgorithmCoding = { system : "http://hl7.org/fhir/version-algorithm", code : va1}
  }
  if (ver1) {
    jcs1.version = ver1;
  }
  let cs1 = new CodeSystem(jcs1);
  let jcs2 = {resourceType: "CodeSystem", url: "http://example.org"};
  if (va2) {
    jcs2.versionAlgorithmCoding = { system : "http://hl7.org/fhir/version-algorithm", code : va2}
  }
  if (ver2) {
    jcs2.version = ver2;
  }
  let cs2 = new CodeSystem(jcs2);

  return cs1.isMoreRecent(cs2);
}
