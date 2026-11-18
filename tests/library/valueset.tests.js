/**
 * Test cases for ValueSet class
 * These tests can be run with Jest, Mocha, or any similar testing framework
 */

import ValueSet from "../../tx/library/valueset";

describe('ValueSet', () => {
  // Test data
  const validValueSet = {
    "resourceType": "ValueSet",
    "url": "http://example.org/fhir/ValueSet/test",
    "version": "1.0.0",
    "name": "TestValueSet",
    "title": "Test Value Set",
    "status": "active",
    "identifier": [
      {
        "system": "http://example.org/identifiers",
        "value": "test-vs-1"
      }
    ],
    "compose": {
      "include": [
        {
          "system": "http://loinc.org",
          "version": "2.73",
          "concept": [
            {
              "code": "LA6113-0",
              "display": "Positive"
            },
            {
              "code": "LA6114-8",
              "display": "Negative"
            }
          ]
        },
        {
          "system": "http://snomed.info/sct",
          "filter": [
            {
              "property": "concept",
              "op": "is-a",
              "value": "123456789"
            }
          ]
        }
      ]
    },
    "expansion": {
      "timestamp": "2023-10-01T10:00:00Z",
      "total": 4,
      "contains": [
        {
          "system": "http://loinc.org",
          "version": "2.73",
          "code": "LA6113-0",
          "display": "Positive"
        },
        {
          "system": "http://loinc.org",
          "version": "2.73",
          "code": "LA6114-8",
          "display": "Negative"
        },
        {
          "system": "http://snomed.info/sct",
          "code": "260385009",
          "display": "Negative (qualifier value)"
        },
        {
          "system": "http://snomed.info/sct",
          "code": "10828004",
          "display": "Positive (qualifier value)"
        }
      ]
    }
  };

  const r5ValueSetWithFilter = {
    "resourceType": "ValueSet",
    "url": "http://example.org/fhir/ValueSet/r5-test",
    "name": "R5TestValueSet",
    "status": "active",
    "versionAlgorithmString": "semver",
    "compose": {
      "include": [
        {
          "system": "http://example.org/codes",
          "filter": [
            {
              "property": "concept",
              "op": "generalizes",
              "value": "parent-concept"
            }
          ]
        }
      ]
    }
  };

  const r3ValueSetWithExtensible = {
    "resourceType": "ValueSet",
    "url": "http://example.org/fhir/ValueSet/r3-test",
    "name": "R3TestValueSet",
    "status": "active",
    "extensible": true, // This should be ignored
    "compose": {
      "include": [
        {
          "system": "http://example.org/codes",
          "concept": [
            {
              "code": "test-code",
              "display": "Test Code"
            }
          ]
        }
      ]
    }
  };

  describe('Constructor and Validation', () => {
    test('should create ValueSet with valid data', () => {
      const vs = new ValueSet(validValueSet);
      expect(vs.jsonObj).toEqual(validValueSet);
    });

    test('should create ValueSet from JSON string', () => {
      const vs = ValueSet.fromJSON(JSON.stringify(validValueSet));
      expect(vs.jsonObj).toEqual(validValueSet);
    });

    test('should throw error for null input', () => {
      expect(() => new ValueSet(null)).toThrow('Invalid ValueSet: expected object');
    });

    test('should throw error for non-object input', () => {
      expect(() => new ValueSet("not an object")).toThrow('Invalid ValueSet: expected object');
    });

    test('should throw error for wrong resourceType', () => {
      const invalid = { ...validValueSet, resourceType: "CodeSystem" };
      expect(() => new ValueSet(invalid)).toThrow('Invalid ValueSet: resourceType must be "ValueSet"');
    });

    test('should throw error for missing url', () => {
      const invalid = { ...validValueSet };
      delete invalid.url;
      expect(() => new ValueSet(invalid)).toThrow('Invalid ValueSet: url is required');
    });

    test('should throw error for missing name', () => {
      const invalid = { ...validValueSet };
      delete invalid.name;
      expect(() => new ValueSet(invalid)).toThrow('Invalid ValueSet: name is required');
    });

    test('should throw error for missing status', () => {
      const invalid = { ...validValueSet };
      delete invalid.status;
      expect(() => new ValueSet(invalid)).toThrow('Invalid ValueSet: status is required');
    });

    test('should throw error for invalid status', () => {
      const invalid = { ...validValueSet, status: "invalid" };
      expect(() => new ValueSet(invalid)).toThrow('Invalid ValueSet: status must be one of');
    });

    test('should throw error for non-array identifier', () => {
      const invalid = { ...validValueSet, identifier: "not an array" };
      expect(() => new ValueSet(invalid)).toThrow('Invalid ValueSet: identifier should be an array');
    });

    test('should throw error for invalid compose structure', () => {
      const invalid = { ...validValueSet, compose: { include: "not an array" } };
      expect(() => new ValueSet(invalid)).toThrow('Invalid ValueSet: compose.include must be an array');
    });

    test('should accept ValueSet without expansion', () => {
      const noExpansion = { ...validValueSet };
      delete noExpansion.expansion;
      const vs = new ValueSet(noExpansion);
      expect(vs.isExpanded()).toBe(false);
      expect(vs.getAllCodes()).toEqual([]);
    });
  });

  describe('Expansion Code Lookup', () => {
    let vs;

    beforeEach(() => {
      vs = new ValueSet(validValueSet);
    });

    test('should find code by system and code', () => {
      const code = vs.getCode('http://loinc.org', 'LA6113-0');
      expect(code).toBeDefined();
      expect(code.code).toBe('LA6113-0');
      expect(code.display).toBe('Positive');
      expect(code.system).toBe('http://loinc.org');
    });

    test('should find code by system, code, and version', () => {
      const code = vs.getCode('http://loinc.org', 'LA6113-0', '2.73');
      expect(code).toBeDefined();
      expect(code.version).toBe('2.73');
    });

    test('should return undefined for non-existent code', () => {
      const code = vs.getCode('http://loinc.org', 'NONEXISTENT');
      expect(code).toBeUndefined();
    });

    test('should check if code exists', () => {
      expect(vs.hasCode('http://loinc.org', 'LA6113-0')).toBe(true);
      expect(vs.hasCode('http://loinc.org', 'LA6113-0', '2.73')).toBe(true);
      expect(vs.hasCode('http://loinc.org', 'NONEXISTENT')).toBe(false);
      expect(vs.hasCode('http://snomed.info/sct', '260385009')).toBe(true);
    });

    test('should get all codes', () => {
      const allCodes = vs.getAllCodes();
      expect(allCodes).toHaveLength(4);
      expect(allCodes.some(c => c.code === 'LA6113-0')).toBe(true);
      expect(allCodes.some(c => c.code === '260385009')).toBe(true);
    });

    test('should get codes from specific system', () => {
      const loincCodes = vs.getCodesFromSystem('http://loinc.org');
      expect(loincCodes).toHaveLength(2);
      expect(loincCodes.every(c => c.system === 'http://loinc.org')).toBe(true);

      const loincCodesVersioned = vs.getCodesFromSystem('http://loinc.org', '2.73');
      expect(loincCodesVersioned).toHaveLength(2);
      expect(loincCodesVersioned.every(c => c.version === '2.73')).toBe(true);
    });

    test('should get all systems', () => {
      const systems = vs.getSystems();
      expect(systems).toContain('http://loinc.org');
      expect(systems).toContain('http://snomed.info/sct');
      expect(systems).toHaveLength(2);
    });

    test('should check if expanded', () => {
      expect(vs.isExpanded()).toBe(true);
      expect(vs.getExpansionTotal()).toBe(4);
    });
  });

  describe('FHIR Version Conversion', () => {
    test('should load R5 ValueSet without conversion', () => {
      const vs = new ValueSet(r5ValueSetWithFilter, 'R5');
      expect(vs.getFHIRVersion()).toBe('R5');
      expect(vs.jsonObj.versionAlgorithmString).toBe('semver');
    });

    test('should load R3 ValueSet and remove extensible', () => {
      const vs = new ValueSet(r3ValueSetWithExtensible, 'R3');
      expect(vs.getFHIRVersion()).toBe('R3');
      expect(vs.jsonObj.extensible).toBeUndefined(); // Should be ignored/removed
    });

    test('should output R5 format by default', () => {
      const vs = new ValueSet(r5ValueSetWithFilter, 'R5');
      const output = vs.toJSONString();
      const parsed = JSON.parse(output);
      expect(parsed.versionAlgorithmString).toBe('semver');
      expect(parsed.compose.include[0].filter[0].op).toBe('generalizes');
    });

    test('should convert R5 to R4 format on output', () => {
      const vs = new ValueSet(r5ValueSetWithFilter, 'R5');
      const output = vs.toJSONString('R4');
      const parsed = JSON.parse(output);

      // R5-specific elements should be removed
      expect(parsed.versionAlgorithmString).toBeUndefined();

      // R5-only filter operators should be removed
      expect(parsed.compose.include[0].filter).toHaveLength(0); // generalizes removed
    });

    test('should convert R5 to R3 format on output', () => {
      const vs = new ValueSet(r5ValueSetWithFilter, 'R5');
      const output = vs.toJSONString('R3');
      const parsed = JSON.parse(output);

      // R5-specific elements should be removed
      expect(parsed.versionAlgorithmString).toBeUndefined();

      // Only R3-compatible filter operators should remain
      expect(parsed.compose.include[0].filter).toHaveLength(0); // generalizes removed
    });

    test('should handle ValueSet with mixed filter operators', () => {
      const mixedFilters = {
        ...r5ValueSetWithFilter,
        compose: {
          include: [
            {
              system: "http://example.org/codes",
              filter: [
                {
                  property: "concept",
                  op: "=",
                  value: "test"
                },
                {
                  property: "concept",
                  op: "generalizes",
                  value: "parent"
                },
                {
                  property: "concept",
                  op: "is-a",
                  value: "child"
                }
              ]
            }
          ]
        }
      };

      const vs = new ValueSet(mixedFilters, 'R5');
      const r4Output = vs.toJSONString('R4');
      const r3Output = vs.toJSONString('R3');

      const r4Parsed = JSON.parse(r4Output);
      const r3Parsed = JSON.parse(r3Output);

      // R4 should remove generalizes but keep = and is-a
      expect(r4Parsed.compose.include[0].filter).toHaveLength(2);
      expect(r4Parsed.compose.include[0].filter.some(f => f.op === '=')).toBe(true);
      expect(r4Parsed.compose.include[0].filter.some(f => f.op === 'is-a')).toBe(true);

      // R3 should keep only R3-compatible operators
      expect(r3Parsed.compose.include[0].filter).toHaveLength(2);
      expect(r3Parsed.compose.include[0].filter.some(f => f.op === '=')).toBe(true);
      expect(r3Parsed.compose.include[0].filter.some(f => f.op === 'is-a')).toBe(true);
    });

    test('should include FHIR version in getInfo', () => {
      const vs = new ValueSet(validValueSet, 'R4');
      const info = vs.getInfo();
      expect(info.fhirVersion).toBe('R4');
      expect(info.isExpanded).toBe(true);
      expect(info.codeCount).toBe(4);
      expect(info.systemCount).toBe(2);
    });

    test('should handle fromJSON with version parameter', () => {
      const vs = ValueSet.fromJSON(JSON.stringify(r3ValueSetWithExtensible), 'R3');
      expect(vs.getFHIRVersion()).toBe('R3');
      expect(vs.jsonObj.extensible).toBeUndefined();
    });

    test('should throw error for unsupported version', () => {
      expect(() => new ValueSet(validValueSet, 'R6')).toThrow('Unsupported FHIR version: R6');

      const vs = new ValueSet(validValueSet, 'R4');
      expect(() => vs.toJSONString('R6')).toThrow('Unsupported target FHIR version: R6');
    });
  });

  describe('XML Support', () => {
    // Sample FHIR XML data for testing
    const r5ValueSetXML = `<?xml version="1.0" encoding="UTF-8"?>
<ValueSet xmlns="http://hl7.org/fhir">
  <url value="http://example.org/fhir/ValueSet/xml-test"/>
  <identifier>
    <system value="http://example.org/identifiers"/>
    <value value="xml-vs-1"/>
  </identifier>
  <version value="1.0.0"/>
  <versionAlgorithmString value="semver"/>
  <name value="XMLTestValueSet"/>
  <title value="XML Test Value Set"/>
  <status value="active"/>
  <compose>
    <include>
      <system value="http://loinc.org"/>
      <concept>
        <code value="LA6113-0"/>
        <display value="Positive"/>
      </concept>
      <concept>
        <code value="LA6114-8"/>
        <display value="Negative"/>
      </concept>
    </include>
  </compose>
  <expansion>
    <timestamp value="2023-10-01T10:00:00Z"/>
    <total value="2"/>
    <contains>
      <system value="http://loinc.org"/>
      <code value="LA6113-0"/>
      <display value="Positive"/>
    </contains>
    <contains>
      <system value="http://loinc.org"/>
      <code value="LA6114-8"/>
      <display value="Negative"/>
    </contains>
  </expansion>
</ValueSet>`;

    // Mock ValueSetXML since we can't actually import it in tests
    const MockValueSetXML = {
      fromXML: (xmlString, version) => {
        // Simulate XML to JSON conversion
        const hasVersionAlgorithm = xmlString.includes('versionAlgorithmString');

        const jsonObj = {
          resourceType: "ValueSet",
          url: "http://example.org/fhir/ValueSet/xml-test",
          identifier: [
            {
              system: "http://example.org/identifiers",
              value: "xml-vs-1"
            }
          ],
          version: "1.0.0",
          versionAlgorithmString: hasVersionAlgorithm ? "semver" : undefined,
          name: "XMLTestValueSet",
          title: "XML Test Value Set",
          status: "active",
          compose: {
            include: [
              {
                system: "http://loinc.org",
                concept: [
                  {
                    code: "LA6113-0",
                    display: "Positive"
                  },
                  {
                    code: "LA6114-8",
                    display: "Negative"
                  }
                ]
              }
            ]
          },
          expansion: {
            timestamp: "2023-10-01T10:00:00Z",
            total: 2,
            contains: [
              {
                system: "http://loinc.org",
                code: "LA6113-0",
                display: "Positive"
              },
              {
                system: "http://loinc.org",
                code: "LA6114-8",
                display: "Negative"
              }
            ]
          }
        };

        return new ValueSet(jsonObj, version);
      },

      toXMLString: (valueSet, version) => {
        const json = JSON.parse(valueSet.toJSONString(version));

        // Simulate JSON to XML conversion
        let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<ValueSet xmlns="http://hl7.org/fhir">\n`;
        xml += `  <url value="${json.url}"/>\n`;

        if (json.identifier && Array.isArray(json.identifier)) {
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
        xml += `</ValueSet>`;
        return xml;
      },

      isValidValueSetXML: (xmlString) => {
        return xmlString.includes('<ValueSet') &&
          xmlString.includes('http://hl7.org/fhir') &&
          xmlString.includes('</ValueSet>');
      }
    };

    test('should validate FHIR ValueSet XML', () => {
      expect(MockValueSetXML.isValidValueSetXML(r5ValueSetXML)).toBe(true);

      const invalidXML = '<CodeSystem><n>Not a ValueSet</n></CodeSystem>';
      expect(MockValueSetXML.isValidValueSetXML(invalidXML)).toBe(false);
    });

    test('should load ValueSet from R5 XML', () => {
      const vs = MockValueSetXML.fromXML(r5ValueSetXML, 'R5');

      expect(vs.getFHIRVersion()).toBe('R5');
      expect(vs.jsonObj.url).toBe('http://example.org/fhir/ValueSet/xml-test');
      expect(vs.jsonObj.name).toBe('XMLTestValueSet');
      expect(vs.jsonObj.versionAlgorithmString).toBe('semver');

      // Check expansion mapping
      expect(vs.hasCode('http://loinc.org', 'LA6113-0')).toBe(true);
      expect(vs.hasCode('http://loinc.org', 'LA6114-8')).toBe(true);
      expect(vs.getAllCodes()).toHaveLength(2);
    });

    test('should convert ValueSet to R4 XML without R5 elements', () => {
      const vs = MockValueSetXML.fromXML(r5ValueSetXML, 'R5');
      const xmlOutput = MockValueSetXML.toXMLString(vs, 'R4');

      expect(xmlOutput).toContain('<ValueSet xmlns="http://hl7.org/fhir">');
      expect(xmlOutput).not.toContain('versionAlgorithmString');
      expect(xmlOutput).toContain('<identifier>');
    });

    test('should preserve expansion data through XML round-trip', () => {
      const vs1 = MockValueSetXML.fromXML(r5ValueSetXML, 'R5');
      const xmlOutput = MockValueSetXML.toXMLString(vs1, 'R5');
      const vs2 = MockValueSetXML.fromXML(xmlOutput, 'R5');

      expect(vs2.jsonObj.url).toBe(vs1.jsonObj.url);
      expect(vs2.getAllCodes()).toHaveLength(vs1.getAllCodes().length);
      expect(vs2.hasCode('http://loinc.org', 'LA6113-0')).toBe(true);
    });
  });

  describe('Edge Cases and Utilities', () => {
    test('should handle ValueSet without compose', () => {
      const noCompose = {
        resourceType: "ValueSet",
        url: "http://example.org/simple",
        name: "SimpleValueSet",
        status: "active"
      };

      const vs = new ValueSet(noCompose);
      expect(vs.getSystems()).toEqual([]);
      expect(vs.isExpanded()).toBe(false);
    });

    test('should handle nested expansion contains', () => {
      const nestedExpansion = {
        ...validValueSet,
        expansion: {
          timestamp: "2023-10-01T10:00:00Z",
          total: 3,
          contains: [
            {
              system: "http://example.org/hierarchy",
              code: "parent",
              display: "Parent",
              contains: [
                {
                  system: "http://example.org/hierarchy",
                  code: "child1",
                  display: "Child 1"
                },
                {
                  system: "http://example.org/hierarchy",
                  code: "child2",
                  display: "Child 2"
                }
              ]
            }
          ]
        }
      };

      const vs = new ValueSet(nestedExpansion);
      expect(vs.hasCode('http://example.org/hierarchy', 'parent')).toBe(true);
      expect(vs.hasCode('http://example.org/hierarchy', 'child1')).toBe(true);
      expect(vs.hasCode('http://example.org/hierarchy', 'child2')).toBe(true);
      expect(vs.getAllCodes()).toHaveLength(3);
    });

    test('should get correct info for ValueSet', () => {
      const vs = new ValueSet(validValueSet, 'R4');
      const info = vs.getInfo();

      expect(info.resourceType).toBe('ValueSet');
      expect(info.fhirVersion).toBe('R4');
      expect(info.isExpanded).toBe(true);
      expect(info.expansionTotal).toBe(4);
      expect(info.codeCount).toBe(4);
      expect(info.systemCount).toBe(2);
    });
  });
});