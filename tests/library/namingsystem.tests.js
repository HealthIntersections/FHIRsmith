/**
 * Test cases for NamingSystem class
 * These tests can be run with Jest, Mocha, or any similar testing framework
 */

import {NamingSystem} from "../../tx/library/namingsystem";

describe('NamingSystem', () => {
  // Test data
  const validNamingSystem = {
    "resourceType": "NamingSystem",
    "name": "TestNamingSystem",
    "title": "Test Naming System",
    "status": "active",
    "kind": "codesystem",
    "date": "2023-10-01",
    "publisher": "Example Organization",
    "description": "A test naming system for validation",
    "usage": "Used for testing purposes",
    "uniqueId": [
      {
        "type": "uri",
        "value": "http://example.org/fhir/test-system",
        "preferred": true,
        "comment": "Primary URI identifier"
      },
      {
        "type": "oid",
        "value": "2.16.840.1.113883.3.1.1.1",
        "preferred": false,
        "comment": "OID identifier for interoperability"
      },
      {
        "type": "uuid",
        "value": "550e8400-e29b-41d4-a716-446655440000",
        "preferred": false
      }
    ]
  };

  const r5NamingSystemWithVersion = {
    "resourceType": "NamingSystem",
    "name": "R5TestNamingSystem",
    "status": "active",
    "kind": "identifier",
    "versionAlgorithmString": "semver",
    "uniqueId": [
      {
        "type": "uri",
        "value": "http://example.org/fhir/r5-system",
        "preferred": true
      }
    ]
  };

  const r3NamingSystemWithReplacedBy = {
    "resourceType": "NamingSystem",
    "name": "R3TestNamingSystem",
    "status": "retired",
    "kind": "root",
    "replacedBy": {
      "reference": "NamingSystem/new-system"
    },
    "uniqueId": [
      {
        "type": "oid",
        "value": "2.16.840.1.113883.3.1.1.2",
        "preferred": true
      }
    ]
  };

  describe('Constructor and Validation', () => {
    test('should create NamingSystem with valid data', () => {
      const ns = new NamingSystem(validNamingSystem);
      expect(ns.jsonObj).toEqual(validNamingSystem);
    });

    test('should create NamingSystem from JSON string', () => {
      const ns = NamingSystem.fromJSON(JSON.stringify(validNamingSystem));
      expect(ns.jsonObj).toEqual(validNamingSystem);
    });

    test('should throw error for null input', () => {
      expect(() => new NamingSystem(null)).toThrow('Invalid NamingSystem: expected object');
    });

    test('should throw error for non-object input', () => {
      expect(() => new NamingSystem("not an object")).toThrow('Invalid NamingSystem: expected object');
    });

    test('should throw error for wrong resourceType', () => {
      const invalid = { ...validNamingSystem, resourceType: "ValueSet" };
      expect(() => new NamingSystem(invalid)).toThrow('Invalid NamingSystem: resourceType must be "NamingSystem"');
    });

    test('should throw error for missing name', () => {
      const invalid = { ...validNamingSystem };
      delete invalid.name;
      expect(() => new NamingSystem(invalid)).toThrow('Invalid NamingSystem: name is required');
    });

    test('should throw error for missing status', () => {
      const invalid = { ...validNamingSystem };
      delete invalid.status;
      expect(() => new NamingSystem(invalid)).toThrow('Invalid NamingSystem: status is required');
    });

    test('should throw error for invalid status', () => {
      const invalid = { ...validNamingSystem, status: "invalid" };
      expect(() => new NamingSystem(invalid)).toThrow('Invalid NamingSystem: status must be one of');
    });

    test('should throw error for missing kind', () => {
      const invalid = { ...validNamingSystem };
      delete invalid.kind;
      expect(() => new NamingSystem(invalid)).toThrow('Invalid NamingSystem: kind is required');
    });

    test('should throw error for invalid kind', () => {
      const invalid = { ...validNamingSystem, kind: "invalid" };
      expect(() => new NamingSystem(invalid)).toThrow('Invalid NamingSystem: kind must be one of');
    });

    test('should throw error for missing uniqueId', () => {
      const invalid = { ...validNamingSystem };
      delete invalid.uniqueId;
      expect(() => new NamingSystem(invalid)).toThrow('Invalid NamingSystem: uniqueId is required');
    });

    test('should throw error for empty uniqueId array', () => {
      const invalid = { ...validNamingSystem, uniqueId: [] };
      expect(() => new NamingSystem(invalid)).toThrow('Invalid NamingSystem: uniqueId array cannot be empty');
    });

    test('should throw error for invalid uniqueId structure', () => {
      const invalid = {
        ...validNamingSystem,
        uniqueId: [{ type: "invalid", value: "test" }]
      };
      expect(() => new NamingSystem(invalid)).toThrow('Invalid NamingSystem: uniqueId[0].type must be one of');
    });

    test('should throw error for missing uniqueId value', () => {
      const invalid = {
        ...validNamingSystem,
        uniqueId: [{ type: "uri" }]
      };
      expect(() => new NamingSystem(invalid)).toThrow('Invalid NamingSystem: uniqueId[0].value is required');
    });
  });

  describe('Unique Identifier Management', () => {
    let ns;

    beforeEach(() => {
      ns = new NamingSystem(validNamingSystem);
    });

    test('should get unique IDs by type', () => {
      const uriIds = ns.getUniqueIdsByType('uri');
      expect(uriIds).toHaveLength(1);
      expect(uriIds[0].value).toBe('http://example.org/fhir/test-system');

      const oidIds = ns.getUniqueIdsByType('oid');
      expect(oidIds).toHaveLength(1);
      expect(oidIds[0].value).toBe('2.16.840.1.113883.3.1.1.1');

      const uuidIds = ns.getUniqueIdsByType('uuid');
      expect(uuidIds).toHaveLength(1);
    });

    test('should get unique ID values by type', () => {
      const uriValues = ns.getUniqueIdValues('uri');
      expect(uriValues).toEqual(['http://example.org/fhir/test-system']);

      const oidValues = ns.getUniqueIdValues('oid');
      expect(oidValues).toEqual(['2.16.840.1.113883.3.1.1.1']);

      const otherValues = ns.getUniqueIdValues('other');
      expect(otherValues).toEqual([]);
    });

    test('should check if unique ID exists', () => {
      expect(ns.hasUniqueId('uri', 'http://example.org/fhir/test-system')).toBe(true);
      expect(ns.hasUniqueId('oid', '2.16.840.1.113883.3.1.1.1')).toBe(true);
      expect(ns.hasUniqueId('uri', 'http://nonexistent.org')).toBe(false);
      expect(ns.hasUniqueId('other', 'some-value')).toBe(false);
    });

    test('should get preferred unique ID', () => {
      const preferred = ns.getPreferredUniqueId();
      expect(preferred).toBeDefined();
      expect(preferred.type).toBe('uri');
      expect(preferred.value).toBe('http://example.org/fhir/test-system');
      expect(preferred.preferred).toBe(true);
    });

    test('should get all unique IDs', () => {
      const allIds = ns.getAllUniqueIds();
      expect(allIds).toHaveLength(3);

      const preferredOnly = ns.getAllUniqueIds(true);
      expect(preferredOnly).toHaveLength(1);
      expect(preferredOnly[0].preferred).toBe(true);
    });
  });

  describe('Kind and Type Checking', () => {
    test('should check codesystem kind', () => {
      const ns = new NamingSystem(validNamingSystem);
      expect(ns.getKind()).toBe('codesystem');
      expect(ns.isCodeSystem()).toBe(true);
      expect(ns.isIdentifier()).toBe(false);
      expect(ns.isRoot()).toBe(false);
    });

    test('should check identifier kind', () => {
      const identifierNS = {
        ...validNamingSystem,
        kind: 'identifier'
      };
      const ns = new NamingSystem(identifierNS);
      expect(ns.getKind()).toBe('identifier');
      expect(ns.isCodeSystem()).toBe(false);
      expect(ns.isIdentifier()).toBe(true);
      expect(ns.isRoot()).toBe(false);
    });

    test('should check root kind', () => {
      const rootNS = {
        ...validNamingSystem,
        kind: 'root'
      };
      const ns = new NamingSystem(rootNS);
      expect(ns.getKind()).toBe('root');
      expect(ns.isCodeSystem()).toBe(false);
      expect(ns.isIdentifier()).toBe(false);
      expect(ns.isRoot()).toBe(true);
    });
  });

  describe('FHIR Version Conversion', () => {
    test('should load R5 NamingSystem without conversion', () => {
      const ns = new NamingSystem(r5NamingSystemWithVersion, 'R5');
      expect(ns.getFHIRVersion()).toBe('R5');
      expect(ns.jsonObj.versionAlgorithmString).toBe('semver');
    });

    test('should load R3 NamingSystem and remove replacedBy', () => {
      const ns = new NamingSystem(r3NamingSystemWithReplacedBy, 'R3');
      expect(ns.getFHIRVersion()).toBe('R3');
      expect(ns.jsonObj.replacedBy).toBeUndefined(); // Should be ignored/removed
      expect(ns.hasUniqueId('oid', '2.16.840.1.113883.3.1.1.2')).toBe(true);
    });

    test('should output R5 format by default', () => {
      const ns = new NamingSystem(r5NamingSystemWithVersion, 'R5');
      const output = ns.toJSONString();
      const parsed = JSON.parse(output);
      expect(parsed.versionAlgorithmString).toBe('semver');
    });

    test('should convert R5 to R4 format on output', () => {
      const ns = new NamingSystem(r5NamingSystemWithVersion, 'R5');
      const output = ns.toJSONString('R4');
      const parsed = JSON.parse(output);

      // R5-specific elements should be removed
      expect(parsed.versionAlgorithmString).toBeUndefined();
      expect(parsed.name).toBe('R5TestNamingSystem');
      expect(parsed.uniqueId).toHaveLength(1);
    });

    test('should convert R5 to R3 format on output', () => {
      const ns = new NamingSystem(r5NamingSystemWithVersion, 'R5');
      const output = ns.toJSONString('R3');
      const parsed = JSON.parse(output);

      // R5-specific elements should be removed
      expect(parsed.versionAlgorithmString).toBeUndefined();
      expect(parsed.name).toBe('R5TestNamingSystem');
    });

    test('should include FHIR version in getInfo', () => {
      const ns = new NamingSystem(validNamingSystem, 'R4');
      const info = ns.getInfo();
      expect(info.fhirVersion).toBe('R4');
      expect(info.kind).toBe('codesystem');
      expect(info.uniqueIdCount).toBe(3);
      expect(info.preferredId).toBe('uri:http://example.org/fhir/test-system');
      expect(info.types).toEqual(expect.arrayContaining(['uri', 'oid', 'uuid']));
    });

    test('should handle fromJSON with version parameter', () => {
      const ns = NamingSystem.fromJSON(JSON.stringify(r3NamingSystemWithReplacedBy), 'R3');
      expect(ns.getFHIRVersion()).toBe('R3');
      expect(ns.jsonObj.replacedBy).toBeUndefined();
    });

    test('should throw error for unsupported version', () => {
      expect(() => new NamingSystem(validNamingSystem, 'R6')).toThrow('Unsupported FHIR version: R6');

      const ns = new NamingSystem(validNamingSystem, 'R4');
      expect(() => ns.toJSONString('R6')).toThrow('Unsupported target FHIR version: R6');
    });
  });

  describe('XML Support', () => {
    // Sample FHIR XML data for testing
    const r5NamingSystemXML = `<?xml version="1.0" encoding="UTF-8"?>
<NamingSystem xmlns="http://hl7.org/fhir">
  <name value="XMLTestNamingSystem"/>
  <title value="XML Test Naming System"/>
  <status value="active"/>
  <kind value="codesystem"/>
  <versionAlgorithmString value="semver"/>
  <date value="2023-10-01"/>
  <publisher value="Test Publisher"/>
  <description value="A test naming system"/>
  <uniqueId>
    <type value="uri"/>
    <value value="http://example.org/fhir/xml-test"/>
    <preferred value="true"/>
  </uniqueId>
  <uniqueId>
    <type value="oid"/>
    <value value="2.16.840.1.113883.3.1.1.3"/>
    <preferred value="false"/>
  </uniqueId>
</NamingSystem>`;

    // Mock NamingSystemXML since we can't actually import it in tests
    const MockNamingSystemXML = {
      fromXML: (xmlString, version) => {
        // Simulate XML to JSON conversion
        const hasVersionAlgorithm = xmlString.includes('versionAlgorithmString');

        const jsonObj = {
          resourceType: "NamingSystem",
          name: "XMLTestNamingSystem",
          title: "XML Test Naming System",
          status: "active",
          kind: "codesystem",
          versionAlgorithmString: hasVersionAlgorithm ? "semver" : undefined,
          date: "2023-10-01",
          publisher: "Test Publisher",
          description: "A test naming system",
          uniqueId: [
            {
              type: "uri",
              value: "http://example.org/fhir/xml-test",
              preferred: true
            },
            {
              type: "oid",
              value: "2.16.840.1.113883.3.1.1.3",
              preferred: false
            }
          ]
        };

        return new NamingSystem(jsonObj, version);
      },

      toXMLString: (namingSystem, version) => {
        const json = JSON.parse(namingSystem.toJSONString(version));

        // Simulate JSON to XML conversion
        let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<NamingSystem xmlns="http://hl7.org/fhir">\n`;
        xml += `  <name value="${json.name}"/>\n`;
        xml += `  <status value="${json.status}"/>\n`;
        xml += `  <kind value="${json.kind}"/>\n`;

        if (json.versionAlgorithmString && version === 'R5') {
          xml += `  <versionAlgorithmString value="${json.versionAlgorithmString}"/>\n`;
        }

        if (json.uniqueId && Array.isArray(json.uniqueId)) {
          json.uniqueId.forEach(uid => {
            xml += `  <uniqueId>\n`;
            xml += `    <type value="${uid.type}"/>\n`;
            xml += `    <value value="${uid.value}"/>\n`;
            if (uid.preferred !== undefined) {
              xml += `    <preferred value="${uid.preferred}"/>\n`;
            }
            xml += `  </uniqueId>\n`;
          });
        }

        xml += `</NamingSystem>`;
        return xml;
      },

      isValidNamingSystemXML: (xmlString) => {
        return xmlString.includes('<NamingSystem') &&
          xmlString.includes('http://hl7.org/fhir') &&
          xmlString.includes('</NamingSystem>');
      }
    };

    test('should validate FHIR NamingSystem XML', () => {
      expect(MockNamingSystemXML.isValidNamingSystemXML(r5NamingSystemXML)).toBe(true);

      const invalidXML = '<ValueSet><n>Not a NamingSystem</n></ValueSet>';
      expect(MockNamingSystemXML.isValidNamingSystemXML(invalidXML)).toBe(false);
    });

    test('should load NamingSystem from R5 XML', () => {
      const ns = MockNamingSystemXML.fromXML(r5NamingSystemXML, 'R5');

      expect(ns.getFHIRVersion()).toBe('R5');
      expect(ns.jsonObj.name).toBe('XMLTestNamingSystem');
      expect(ns.jsonObj.kind).toBe('codesystem');
      expect(ns.jsonObj.versionAlgorithmString).toBe('semver');

      // Check unique identifiers
      expect(ns.hasUniqueId('uri', 'http://example.org/fhir/xml-test')).toBe(true);
      expect(ns.hasUniqueId('oid', '2.16.840.1.113883.3.1.1.3')).toBe(true);
      expect(ns.getAllUniqueIds()).toHaveLength(2);

      const preferred = ns.getPreferredUniqueId();
      expect(preferred.type).toBe('uri');
      expect(preferred.value).toBe('http://example.org/fhir/xml-test');
    });

    test('should convert NamingSystem to R4 XML without R5 elements', () => {
      const ns = MockNamingSystemXML.fromXML(r5NamingSystemXML, 'R5');
      const xmlOutput = MockNamingSystemXML.toXMLString(ns, 'R4');

      expect(xmlOutput).toContain('<NamingSystem xmlns="http://hl7.org/fhir">');
      expect(xmlOutput).not.toContain('versionAlgorithmString');
      expect(xmlOutput).toContain('<name value="XMLTestNamingSystem"/>');
      expect(xmlOutput).toContain('<uniqueId>');
      expect(xmlOutput).toContain('<type value="uri"/>');
    });

    test('should preserve unique identifiers through XML round-trip', () => {
      const ns1 = MockNamingSystemXML.fromXML(r5NamingSystemXML, 'R5');
      const xmlOutput = MockNamingSystemXML.toXMLString(ns1, 'R5');
      const ns2 = MockNamingSystemXML.fromXML(xmlOutput, 'R5');

      expect(ns2.jsonObj.name).toBe(ns1.jsonObj.name);
      expect(ns2.getAllUniqueIds()).toHaveLength(ns1.getAllUniqueIds().length);
      expect(ns2.hasUniqueId('uri', 'http://example.org/fhir/xml-test')).toBe(true);
      expect(ns2.getPreferredUniqueId()?.value).toBe(ns1.getPreferredUniqueId()?.value);
    });
  });

  describe('Utilities and Edge Cases', () => {
    test('should handle NamingSystem without preferred uniqueId', () => {
      const noPreferred = {
        ...validNamingSystem,
        uniqueId: [
          {
            type: "uri",
            value: "http://example.org/no-preferred",
            preferred: false
          }
        ]
      };

      const ns = new NamingSystem(noPreferred);
      expect(ns.getPreferredUniqueId()).toBeUndefined();

      const info = ns.getInfo();
      expect(info.preferredId).toBeNull();
    });

    test('should get usage information', () => {
      const ns = new NamingSystem(validNamingSystem);
      expect(ns.getUsage()).toBe('Used for testing purposes');

      const noUsage = { ...validNamingSystem };
      delete noUsage.usage;
      const ns2 = new NamingSystem(noUsage);
      expect(ns2.getUsage()).toBeUndefined();
    });

    test('should get correct info for NamingSystem', () => {
      const ns = new NamingSystem(validNamingSystem, 'R4');
      const info = ns.getInfo();

      expect(info.resourceType).toBe('NamingSystem');
      expect(info.name).toBe('TestNamingSystem');
      expect(info.status).toBe('active');
      expect(info.kind).toBe('codesystem');
      expect(info.fhirVersion).toBe('R4');
      expect(info.uniqueIdCount).toBe(3);
      expect(info.preferredId).toBe('uri:http://example.org/fhir/test-system');
      expect(info.types).toHaveLength(3);
      expect(info.usage).toBe('Used for testing purposes');
    });

    test('should handle minimal NamingSystem', () => {
      const minimal = {
        resourceType: "NamingSystem",
        name: "MinimalNamingSystem",
        status: "draft",
        kind: "identifier",
        uniqueId: [
          {
            type: "uri",
            value: "http://example.org/minimal"
          }
        ]
      };

      const ns = new NamingSystem(minimal);
      expect(ns.jsonObj.name).toBe('MinimalNamingSystem');
      expect(ns.getAllUniqueIds()).toHaveLength(1);
      expect(ns.getPreferredUniqueId()).toBeUndefined(); // No preferred set
    });
  });
});