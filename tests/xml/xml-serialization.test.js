//
// XML Serialization Round-Trip Tests
//
// Tests XML <-> JSON conversion for all supported FHIR resource types.
// Strategy:
//   1. Fixture-based: XML -> JSON -> XML round-trip using spec examples (R4 & R5)
//   2. Fixture-based: JSON -> XML -> JSON round-trip using spec examples
//   3. Synthetic: hand-crafted resources that exercise corner cases
//      (extensions on primitives, special characters, empty arrays, deep nesting, etc.)
//

const fs = require('fs');
const path = require('path');

const { FhirXmlBase } = require('../../tx/xml/xml-base');
const { BundleXML } = require('../../tx/xml/bundle-xml');
const { CapabilityStatementXML } = require('../../tx/xml/capabilitystatement-xml');
const { CodeSystemXML } = require('../../tx/xml/codesystem-xml');
const { ConceptMapXML } = require('../../tx/xml/conceptmap-xml');
const { NamingSystemXML } = require('../../tx/xml/namingsystem-xml');
const { OperationOutcomeXML } = require('../../tx/xml/operationoutcome-xml');
const { ParametersXML } = require('../../tx/xml/parameters-xml');
const { TerminologyCapabilitiesXML } = require('../../tx/xml/terminologycapabilities-xml');
const { ValueSetXML } = require('../../tx/xml/valueset-xml');

// ==================== Helpers ====================

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

function loadJson(version, name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, version, `${name}.json`), 'utf8'));
}

function loadXml(version, name) {
  return fs.readFileSync(path.join(FIXTURES_DIR, version, `${name}.xml`), 'utf8');
}

/**
 * Normalise a JSON resource for comparison:
 * - Remove text.div (narrative may not round-trip perfectly)
 * - Sort object keys recursively for stable comparison
 */
function normaliseJson(obj) {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(normaliseJson);
  if (typeof obj !== 'object') return obj;

  const result = {};
  const keys = Object.keys(obj).sort();
  for (const key of keys) {
    if (key === 'text' && obj[key] && obj[key].div) continue;
    if (key.startsWith('_') && obj[key] === null) continue;
    const v = normaliseJson(obj[key]);
    if (v !== undefined) {
      result[key] = v;
    }
  }
  return result;
}

// ==================== R4 Fixture Round-Trips: XML -> JSON -> XML ====================

describe('R4 Fixtures - XML -> JSON -> XML', () => {

  test('CodeSystem', () => {
    const srcXml = loadXml('r4', 'codesystem-example');
    const json = CodeSystemXML.fromXml(srcXml);
    expect(json.resourceType).toBe('CodeSystem');
    const reXml = CodeSystemXML.toXml(json);
    const rejson = CodeSystemXML.fromXml(reXml);
    expect(normaliseJson(rejson)).toEqual(normaliseJson(json));
  });

  test('ValueSet', () => {
    const srcXml = loadXml('r4', 'valueset-example');
    const json = ValueSetXML.fromXml(srcXml);
    expect(json.resourceType).toBe('ValueSet');
    const reXml = ValueSetXML.toXml(json);
    const rejson = ValueSetXML.fromXml(reXml);
    expect(normaliseJson(rejson)).toEqual(normaliseJson(json));
  });

  test('ConceptMap', () => {
    const srcXml = loadXml('r4', 'conceptmap-example');
    const json = ConceptMapXML.fromXml(srcXml);
    expect(json.resourceType).toBe('ConceptMap');
    const reXml = ConceptMapXML.toXml(json);
    const rejson = ConceptMapXML.fromXml(reXml);
    expect(normaliseJson(rejson)).toEqual(normaliseJson(json));
  });

  test('OperationOutcome', () => {
    const srcXml = loadXml('r4', 'operationoutcome-example');
    const json = OperationOutcomeXML.fromXml(srcXml);
    expect(json.resourceType).toBe('OperationOutcome');
    const reXml = OperationOutcomeXML.toXml(json);
    const rejson = OperationOutcomeXML.fromXml(reXml);
    expect(normaliseJson(rejson)).toEqual(normaliseJson(json));
  });

  test('Parameters', () => {
    const srcXml = loadXml('r4', 'parameters-example');
    const json = ParametersXML.fromXml(srcXml, 4);
    expect(json.resourceType).toBe('Parameters');
    const reXml = ParametersXML.toXml(json, 4);
    const rejson = ParametersXML.fromXml(reXml, 4);
    expect(normaliseJson(rejson)).toEqual(normaliseJson(json));
  });

  test('CapabilityStatement', () => {
    const srcXml = loadXml('r4', 'capabilitystatement-example');
    const json = CapabilityStatementXML.fromXml(srcXml);
    expect(json.resourceType).toBe('CapabilityStatement');
    const reXml = CapabilityStatementXML.toXml(json, 4);
    const rejson = CapabilityStatementXML.fromXml(reXml);
    expect(normaliseJson(rejson)).toEqual(normaliseJson(json));
  });

  test('TerminologyCapabilities', () => {
    const srcXml = loadXml('r4', 'terminologycapabilities-example');
    const json = TerminologyCapabilitiesXML.fromXml(srcXml);
    expect(json.resourceType).toBe('TerminologyCapabilities');
    const reXml = TerminologyCapabilitiesXML.toXml(json, 4);
    const rejson = TerminologyCapabilitiesXML.fromXml(reXml);
    expect(normaliseJson(rejson)).toEqual(normaliseJson(json));
  });

  test('NamingSystem', () => {
    const srcXml = loadXml('r4', 'namingsystem-example');
    const json = NamingSystemXML.fromXml(srcXml);
    expect(json.resourceType).toBe('NamingSystem');
    const reXml = NamingSystemXML.toXml(json, 4);
    const rejson = NamingSystemXML.fromXml(reXml);
    expect(normaliseJson(rejson)).toEqual(normaliseJson(json));
  });

  test('Bundle', () => {
    const srcXml = loadXml('r4', 'bundle-example');
    const element = FhirXmlBase.parseXmlString(srcXml);
    const json = FhirXmlBase.convertElementToFhirJson(element, 'Bundle');
    expect(json.resourceType).toBe('Bundle');
    // There is no Bundle XML parser (BundleXML has no fromXml): the generic conversion used here
    // doesn't read an entry's resource as a resource, so it has no resourceType. Written out, that
    // was <undefined xmlns=...>; a resource type is now checked like any element name, and refused
    expect(json.entry.some(e => e.resource && !e.resource.resourceType)).toBe(true);
    expect(() => BundleXML.toXml(json, 4)).toThrow(/is not an element name/);
  });
});

// ==================== R4 Fixture Round-Trips: JSON -> XML -> JSON ====================

describe('R4 Fixtures - JSON -> XML -> JSON', () => {

  test('CodeSystem', () => {
    const srcJson = loadJson('r4', 'codesystem-example');
    const xml = CodeSystemXML.toXml(srcJson);
    expect(xml).toContain('<CodeSystem');
    const rejson = CodeSystemXML.fromXml(xml);
    expect(normaliseJson(rejson)).toEqual(normaliseJson(srcJson));
  });

  test('ValueSet', () => {
    const srcJson = loadJson('r4', 'valueset-example');
    const xml = ValueSetXML.toXml(srcJson);
    expect(xml).toContain('<ValueSet');
    const rejson = ValueSetXML.fromXml(xml);
    expect(normaliseJson(rejson)).toEqual(normaliseJson(srcJson));
  });

  test('ConceptMap', () => {
    const srcJson = loadJson('r4', 'conceptmap-example');
    const xml = ConceptMapXML.toXml(srcJson, 4);
    expect(xml).toContain('<ConceptMap');
    const rejson = ConceptMapXML.fromXml(xml, 4);
    expect(normaliseJson(rejson)).toEqual(normaliseJson(srcJson));
  });

  test('OperationOutcome', () => {
    const srcJson = loadJson('r4', 'operationoutcome-example');
    const xml = OperationOutcomeXML.toXml(srcJson);
    expect(xml).toContain('<OperationOutcome');
    const rejson = OperationOutcomeXML.fromXml(xml);
    expect(normaliseJson(rejson)).toEqual(normaliseJson(srcJson));
  });

  test('Parameters', () => {
    const srcJson = loadJson('r4', 'parameters-example');
    const xml = ParametersXML.toXml(srcJson, 4);
    expect(xml).toContain('<Parameters');
    const rejson = ParametersXML.fromXml(xml, 4);
    expect(normaliseJson(rejson)).toEqual(normaliseJson(srcJson));
  });

  test('CapabilityStatement', () => {
    const srcJson = loadJson('r4', 'capabilitystatement-example');
    const xml = CapabilityStatementXML.toXml(srcJson, 4);
    expect(xml).toContain('<CapabilityStatement');
    const rejson = CapabilityStatementXML.fromXml(xml);
    expect(normaliseJson(rejson)).toEqual(normaliseJson(srcJson));
  });

  test('TerminologyCapabilities', () => {
    const srcJson = loadJson('r4', 'terminologycapabilities-example');
    const xml = TerminologyCapabilitiesXML.toXml(srcJson, 4);
    expect(xml).toContain('<TerminologyCapabilities');
    const rejson = TerminologyCapabilitiesXML.fromXml(xml);
    expect(normaliseJson(rejson)).toEqual(normaliseJson(srcJson));
  });

  test('NamingSystem', () => {
    const srcJson = loadJson('r4', 'namingsystem-example');
    const xml = NamingSystemXML.toXml(srcJson, 4);
    expect(xml).toContain('<NamingSystem');
    const rejson = NamingSystemXML.fromXml(xml);
    expect(normaliseJson(rejson)).toEqual(normaliseJson(srcJson));
  });

  test('Bundle', () => {
    const srcJson = loadJson('r4', 'bundle-example');
    const xml = BundleXML.toXml(srcJson, 4);
    expect(xml).toContain('<Bundle');
    expect(xml).toContain('xmlns="http://hl7.org/fhir"');
    if (srcJson.type) {
      expect(xml).toContain(`<type value="${srcJson.type}"`);
    }
    if (srcJson.entry && srcJson.entry.length > 0) {
      expect(xml).toContain('<entry>');
    }
  });
});

// ==================== R5 Fixture Round-Trips: XML -> JSON -> XML ====================

describe('R5 Fixtures - XML -> JSON -> XML', () => {

  test('CodeSystem', () => {
    const srcXml = loadXml('r5', 'codesystem-example');
    const json = CodeSystemXML.fromXml(srcXml);
    expect(json.resourceType).toBe('CodeSystem');
    const reXml = CodeSystemXML.toXml(json);
    const rejson = CodeSystemXML.fromXml(reXml);
    expect(normaliseJson(rejson)).toEqual(normaliseJson(json));
  });

  test('ValueSet', () => {
    const srcXml = loadXml('r5', 'valueset-example');
    const json = ValueSetXML.fromXml(srcXml);
    expect(json.resourceType).toBe('ValueSet');
    const reXml = ValueSetXML.toXml(json);
    const rejson = ValueSetXML.fromXml(reXml);
    expect(normaliseJson(rejson)).toEqual(normaliseJson(json));
  });

  test('ConceptMap', () => {
    const srcXml = loadXml('r5', 'conceptmap-example');
    const json = ConceptMapXML.fromXml(srcXml);
    expect(json.resourceType).toBe('ConceptMap');
    const reXml = ConceptMapXML.toXml(json, 5);
    const rejson = ConceptMapXML.fromXml(reXml, 5);
    expect(normaliseJson(rejson)).toEqual(normaliseJson(json));
  });

  test('OperationOutcome', () => {
    const srcXml = loadXml('r5', 'operationoutcome-example');
    const json = OperationOutcomeXML.fromXml(srcXml);
    expect(json.resourceType).toBe('OperationOutcome');
    const reXml = OperationOutcomeXML.toXml(json);
    const rejson = OperationOutcomeXML.fromXml(reXml);
    expect(normaliseJson(rejson)).toEqual(normaliseJson(json));
  });

  test('Parameters', () => {
    const srcXml = loadXml('r5', 'parameters-example');
    const json = ParametersXML.fromXml(srcXml, 5);
    expect(json.resourceType).toBe('Parameters');
    const reXml = ParametersXML.toXml(json, 5);
    const rejson = ParametersXML.fromXml(reXml, 5);
    expect(normaliseJson(rejson)).toEqual(normaliseJson(json));
  });

  test('CapabilityStatement', () => {
    const srcXml = loadXml('r5', 'capabilitystatement-example');
    const json = CapabilityStatementXML.fromXml(srcXml);
    expect(json.resourceType).toBe('CapabilityStatement');
    const reXml = CapabilityStatementXML.toXml(json, 5);
    const rejson = CapabilityStatementXML.fromXml(reXml);
    expect(normaliseJson(rejson)).toEqual(normaliseJson(json));
  });

  test('TerminologyCapabilities', () => {
    const srcXml = loadXml('r5', 'terminologycapabilities-example');
    const json = TerminologyCapabilitiesXML.fromXml(srcXml);
    expect(json.resourceType).toBe('TerminologyCapabilities');
    const reXml = TerminologyCapabilitiesXML.toXml(json, 5);
    const rejson = TerminologyCapabilitiesXML.fromXml(reXml);
    expect(normaliseJson(rejson)).toEqual(normaliseJson(json));
  });

  test('NamingSystem', () => {
    const srcXml = loadXml('r5', 'namingsystem-example');
    const json = NamingSystemXML.fromXml(srcXml);
    expect(json.resourceType).toBe('NamingSystem');
    const reXml = NamingSystemXML.toXml(json, 5);
    const rejson = NamingSystemXML.fromXml(reXml);
    expect(normaliseJson(rejson)).toEqual(normaliseJson(json));
  });

  test('Bundle', () => {
    const srcXml = loadXml('r5', 'bundle-example');
    const element = FhirXmlBase.parseXmlString(srcXml);
    const json = FhirXmlBase.convertElementToFhirJson(element, 'Bundle');
    expect(json.resourceType).toBe('Bundle');
    // as for R4: no Bundle XML parser, so the entries' resources have no resourceType, and are refused
    expect(json.entry.some(e => e.resource && !e.resource.resourceType)).toBe(true);
    expect(() => BundleXML.toXml(json, 5)).toThrow(/is not an element name/);
  });
});

// ==================== R5 Fixture Round-Trips: JSON -> XML -> JSON ====================

describe('R5 Fixtures - JSON -> XML -> JSON', () => {

  test('CodeSystem', () => {
    const srcJson = loadJson('r5', 'codesystem-example');
    const xml = CodeSystemXML.toXml(srcJson);
    expect(xml).toContain('<CodeSystem');
    const rejson = CodeSystemXML.fromXml(xml);
    expect(normaliseJson(rejson)).toEqual(normaliseJson(srcJson));
  });

  test('ValueSet', () => {
    const srcJson = loadJson('r5', 'valueset-example');
    const xml = ValueSetXML.toXml(srcJson);
    expect(xml).toContain('<ValueSet');
    const rejson = ValueSetXML.fromXml(xml);
    expect(normaliseJson(rejson)).toEqual(normaliseJson(srcJson));
  });

  test('OperationOutcome', () => {
    const srcJson = loadJson('r5', 'operationoutcome-example');
    const xml = OperationOutcomeXML.toXml(srcJson);
    expect(xml).toContain('<OperationOutcome');
    const rejson = OperationOutcomeXML.fromXml(xml);
    expect(normaliseJson(rejson)).toEqual(normaliseJson(srcJson));
  });

  test('Parameters', () => {
    const srcJson = loadJson('r5', 'parameters-example');
    const xml = ParametersXML.toXml(srcJson, 5);
    expect(xml).toContain('<Parameters');
    const rejson = ParametersXML.fromXml(xml, 5);
    expect(normaliseJson(rejson)).toEqual(normaliseJson(srcJson));
  });

  test('CapabilityStatement', () => {
    const srcJson = loadJson('r5', 'capabilitystatement-example');
    const xml = CapabilityStatementXML.toXml(srcJson, 5);
    expect(xml).toContain('<CapabilityStatement');
    const rejson = CapabilityStatementXML.fromXml(xml);
    expect(normaliseJson(rejson)).toEqual(normaliseJson(srcJson));
  });

  test('TerminologyCapabilities', () => {
    const srcJson = loadJson('r5', 'terminologycapabilities-example');
    const xml = TerminologyCapabilitiesXML.toXml(srcJson, 5);
    expect(xml).toContain('<TerminologyCapabilities');
    const rejson = TerminologyCapabilitiesXML.fromXml(xml);
    expect(normaliseJson(rejson)).toEqual(normaliseJson(srcJson));
  });

  test('NamingSystem', () => {
    const srcJson = loadJson('r5', 'namingsystem-example');
    const xml = NamingSystemXML.toXml(srcJson, 5);
    expect(xml).toContain('<NamingSystem');
    const rejson = NamingSystemXML.fromXml(xml);
    expect(normaliseJson(rejson)).toEqual(normaliseJson(srcJson));
  });

  test('Bundle', () => {
    const srcJson = loadJson('r5', 'bundle-example');
    const xml = BundleXML.toXml(srcJson, 5);
    expect(xml).toContain('<Bundle');
    expect(xml).toContain('xmlns="http://hl7.org/fhir"');
    if (srcJson.type) {
      expect(xml).toContain(`<type value="${srcJson.type}"`);
    }
    if (srcJson.entry && srcJson.entry.length > 0) {
      expect(xml).toContain('<entry>');
    }
  });
});

// ==================== Error cases ====================

describe('Error Cases', () => {

  test('CodeSystem rejects wrong root element', () => {
    const xml = '<?xml version="1.0"?><ValueSet xmlns="http://hl7.org/fhir"><id value="test"/></ValueSet>';
    expect(() => CodeSystemXML.fromXml(xml)).toThrow('Expected CodeSystem root element');
  });

  test('ValueSet rejects wrong root element', () => {
    const xml = '<?xml version="1.0"?><CodeSystem xmlns="http://hl7.org/fhir"><id value="test"/></CodeSystem>';
    expect(() => ValueSetXML.fromXml(xml)).toThrow('Expected ValueSet root element');
  });

  test('ConceptMap rejects wrong root element', () => {
    const xml = '<?xml version="1.0"?><ValueSet xmlns="http://hl7.org/fhir"><id value="test"/></ValueSet>';
    expect(() => ConceptMapXML.fromXml(xml)).toThrow('Expected ConceptMap root element');
  });

  test('OperationOutcome rejects wrong root element', () => {
    const xml = '<?xml version="1.0"?><Parameters xmlns="http://hl7.org/fhir"><id value="test"/></Parameters>';
    expect(() => OperationOutcomeXML.fromXml(xml)).toThrow('Expected OperationOutcome root element');
  });

  test('Parameters rejects wrong root element', () => {
    const xml = '<?xml version="1.0"?><CodeSystem xmlns="http://hl7.org/fhir"><id value="test"/></CodeSystem>';
    expect(() => ParametersXML.fromXml(xml)).toThrow('Expected Parameters root element');
  });

  test('CapabilityStatement rejects wrong root element', () => {
    const xml = '<?xml version="1.0"?><ValueSet xmlns="http://hl7.org/fhir"><id value="test"/></ValueSet>';
    expect(() => CapabilityStatementXML.fromXml(xml)).toThrow('Expected CapabilityStatement root element');
  });

  test('TerminologyCapabilities rejects wrong root element', () => {
    const xml = '<?xml version="1.0"?><ValueSet xmlns="http://hl7.org/fhir"><id value="test"/></ValueSet>';
    expect(() => TerminologyCapabilitiesXML.fromXml(xml)).toThrow('Expected TerminologyCapabilities root element');
  });

  test('NamingSystem rejects wrong root element', () => {
    const xml = '<?xml version="1.0"?><ValueSet xmlns="http://hl7.org/fhir"><id value="test"/></ValueSet>';
    expect(() => NamingSystemXML.fromXml(xml)).toThrow('Expected NamingSystem root element');
  });
});

// ==================== Special characters ====================

describe('Special Characters', () => {

  test('ampersand and angle brackets in CodeSystem name', () => {
    const json = {
      resourceType: 'CodeSystem', id: 'test', status: 'active', content: 'complete',
      name: 'Test<Code>&System',
      description: 'A "quoted" description with <angles> & ampersands',
    };
    const xml = CodeSystemXML.toXml(json);
    expect(xml).toContain('&amp;');
    expect(xml).toContain('&lt;');
    expect(xml).toContain('&gt;');
    expect(xml).toContain('&quot;');
    const rejson = CodeSystemXML.fromXml(xml);
    expect(rejson.name).toBe('Test<Code>&System');
    expect(rejson.description).toBe('A "quoted" description with <angles> & ampersands');
  });

  test('apostrophes in OperationOutcome diagnostics', () => {
    const json = {
      resourceType: 'OperationOutcome',
      issue: [{ severity: 'error', code: 'invalid', diagnostics: "The code 'xyz' is not valid" }],
    };
    const xml = OperationOutcomeXML.toXml(json);
    const rejson = OperationOutcomeXML.fromXml(xml);
    expect(rejson.issue[0].diagnostics).toBe("The code 'xyz' is not valid");
  });

  test('URL with query string in extension url', () => {
    const json = {
      resourceType: 'ValueSet', id: 'test-url', status: 'active',
      extension: [{ url: 'http://example.org/fhir/ext?a=1&b=2', valueString: 'test' }],
    };
    const xml = ValueSetXML.toXml(json);
    const rejson = ValueSetXML.fromXml(xml);
    expect(rejson.extension[0].url).toBe('http://example.org/fhir/ext?a=1&b=2');
  });

  test('unicode characters in display values', () => {
    const json = {
      resourceType: 'CodeSystem', id: 'test-unicode', status: 'active', content: 'complete',
      concept: [{ code: 'greeting', display: 'Héllo Wörld — 你好世界' }],
    };
    const xml = CodeSystemXML.toXml(json);
    const rejson = CodeSystemXML.fromXml(xml);
    expect(rejson.concept[0].display).toBe('Héllo Wörld — 你好世界');
  });
});

// ==================== Extensions on primitives ====================

describe('Extensions on Primitives', () => {

  test('extension on a primitive with a value', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CodeSystem xmlns="http://hl7.org/fhir">
  <id value="test-ext-primitive"/>
  <status value="active">
    <extension url="http://example.org/fhir/ext-on-status">
      <valueString value="extra info"/>
    </extension>
  </status>
  <content value="complete"/>
</CodeSystem>`;
    const json = CodeSystemXML.fromXml(xml);
    expect(json.status).toBe('active');
    expect(json._status).toBeDefined();
    expect(json._status.extension).toHaveLength(1);
    expect(json._status.extension[0].url).toBe('http://example.org/fhir/ext-on-status');
    expect(json._status.extension[0].valueString).toBe('extra info');
  });

  test('extension on a primitive without a value (null in JSON)', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CodeSystem xmlns="http://hl7.org/fhir">
  <id value="test-ext-no-value"/>
  <status value="active"/>
  <content value="complete"/>
  <description>
    <extension url="http://example.org/data-absent-reason">
      <valueCode value="unknown"/>
    </extension>
  </description>
</CodeSystem>`;
    const json = CodeSystemXML.fromXml(xml);
    expect(json.description).toBeUndefined();
    expect(json._description).toBeDefined();
    expect(json._description.extension).toHaveLength(1);
    expect(json._description.extension[0].valueCode).toBe('unknown');
  });

  test('multiple extensions on the same primitive', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CodeSystem xmlns="http://hl7.org/fhir">
  <id value="test-multi-ext"/>
  <status value="draft">
    <extension url="http://example.org/ext-a">
      <valueString value="first"/>
    </extension>
    <extension url="http://example.org/ext-b">
      <valueInteger value="42"/>
    </extension>
  </status>
  <content value="complete"/>
</CodeSystem>`;
    const json = CodeSystemXML.fromXml(xml);
    expect(json.status).toBe('draft');
    expect(json._status.extension).toHaveLength(2);
    expect(json._status.extension[0].url).toBe('http://example.org/ext-a');
    expect(json._status.extension[0].valueString).toBe('first');
    expect(json._status.extension[1].url).toBe('http://example.org/ext-b');
    expect(json._status.extension[1].valueInteger).toBe(42);
  });

  test('extension on boolean primitive', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CodeSystem xmlns="http://hl7.org/fhir">
  <id value="test-bool-ext"/>
  <status value="active"/>
  <content value="complete"/>
  <caseSensitive value="true">
    <extension url="http://example.org/certainty">
      <valueDecimal value="0.95"/>
    </extension>
  </caseSensitive>
</CodeSystem>`;
    const json = CodeSystemXML.fromXml(xml);
    expect(json.caseSensitive).toBe(true);
    expect(json._caseSensitive).toBeDefined();
    expect(json._caseSensitive.extension[0].valueDecimal).toBeCloseTo(0.95);
  });

  test('extension on uri primitive in ValueSet', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ValueSet xmlns="http://hl7.org/fhir">
  <id value="test-uri-ext"/>
  <status value="active"/>
  <url value="http://example.org/vs/test">
    <extension url="http://example.org/approved-by">
      <valueString value="Standards Board"/>
    </extension>
  </url>
</ValueSet>`;
    const json = ValueSetXML.fromXml(xml);
    expect(json.url).toBe('http://example.org/vs/test');
    expect(json._url).toBeDefined();
    expect(json._url.extension[0].valueString).toBe('Standards Board');
  });
});

// ==================== Extensions on complex elements ====================

describe('Extensions on Complex Elements', () => {

  test('resource-level extensions round-trip', () => {
    const json = {
      resourceType: 'CodeSystem', id: 'test-resource-ext', status: 'active', content: 'complete',
      extension: [
        { url: 'http://example.org/fhir/ext-a', valueString: 'hello' },
        { url: 'http://example.org/fhir/ext-b', valueBoolean: true },
      ],
    };
    const xml = CodeSystemXML.toXml(json);
    expect(xml).toContain('url="http://example.org/fhir/ext-a"');
    expect(xml).toContain('url="http://example.org/fhir/ext-b"');
    const rejson = CodeSystemXML.fromXml(xml);
    expect(rejson.extension).toHaveLength(2);
    expect(rejson.extension[0].valueString).toBe('hello');
    expect(rejson.extension[1].valueBoolean).toBe(true);
  });

  test('nested extension (extension within extension)', () => {
    const json = {
      resourceType: 'ValueSet', id: 'test-nested-ext', status: 'active',
      extension: [{
        url: 'http://example.org/complex-ext',
        extension: [
          { url: 'http://example.org/complex-ext#part1', valueString: 'inner value' },
          { url: 'http://example.org/complex-ext#part2', valueCode: 'ABC' },
        ],
      }],
    };
    const xml = ValueSetXML.toXml(json);
    const rejson = ValueSetXML.fromXml(xml);
    expect(rejson.extension).toHaveLength(1);
    expect(rejson.extension[0].extension).toHaveLength(2);
    expect(rejson.extension[0].extension[0].valueString).toBe('inner value');
    expect(rejson.extension[0].extension[1].valueCode).toBe('ABC');
  });

  test('modifierExtension round-trips', () => {
    const json = {
      resourceType: 'CodeSystem', id: 'test-mod-ext', status: 'active', content: 'complete',
      modifierExtension: [{ url: 'http://example.org/fhir/must-understand', valueBoolean: true }],
    };
    const xml = CodeSystemXML.toXml(json);
    expect(xml).toContain('<modifierExtension');
    const rejson = CodeSystemXML.fromXml(xml);
    expect(rejson.modifierExtension).toHaveLength(1);
    expect(rejson.modifierExtension[0].url).toBe('http://example.org/fhir/must-understand');
    expect(rejson.modifierExtension[0].valueBoolean).toBe(true);
  });
});

// ==================== Type handling: booleans ====================

describe('Type Handling - Booleans', () => {

  test('boolean true values preserved', () => {
    const json = {
      resourceType: 'CodeSystem', id: 'bools', status: 'active', content: 'complete',
      experimental: true, caseSensitive: true, compositional: true,
    };
    const xml = CodeSystemXML.toXml(json);
    const rejson = CodeSystemXML.fromXml(xml);
    expect(rejson.experimental).toBe(true);
    expect(rejson.caseSensitive).toBe(true);
    expect(rejson.compositional).toBe(true);
    expect(typeof rejson.experimental).toBe('boolean');
  });

  test('boolean false values preserved', () => {
    const json = {
      resourceType: 'CodeSystem', id: 'bools-false', status: 'active', content: 'complete',
      experimental: false, caseSensitive: false, versionNeeded: false,
    };
    const xml = CodeSystemXML.toXml(json);
    const rejson = CodeSystemXML.fromXml(xml);
    expect(rejson.experimental).toBe(false);
    expect(rejson.caseSensitive).toBe(false);
    expect(rejson.versionNeeded).toBe(false);
    expect(typeof rejson.experimental).toBe('boolean');
  });

  test('Parameters valueBoolean round-trips', () => {
    const json = {
      resourceType: 'Parameters',
      parameter: [
        { name: 'yes', valueBoolean: true },
        { name: 'no', valueBoolean: false },
      ],
    };
    const xml = ParametersXML.toXml(json);
    const rejson = ParametersXML.fromXml(xml);
    expect(rejson.parameter[0].valueBoolean).toBe(true);
    expect(rejson.parameter[1].valueBoolean).toBe(false);
  });
});

// ==================== Type handling: numbers ====================

describe('Type Handling - Numbers', () => {

  test('integer count preserved', () => {
    const json = {
      resourceType: 'CodeSystem', id: 'ints', status: 'active', content: 'complete', count: 42,
    };
    const xml = CodeSystemXML.toXml(json);
    const rejson = CodeSystemXML.fromXml(xml);
    expect(rejson.count).toBe(42);
    expect(typeof rejson.count).toBe('number');
  });

  test('integer zero preserved', () => {
    const json = {
      resourceType: 'CodeSystem', id: 'zero', status: 'active', content: 'complete', count: 0,
    };
    const xml = CodeSystemXML.toXml(json);
    expect(xml).toContain('<count value="0"/>');
    const rejson = CodeSystemXML.fromXml(xml);
    expect(rejson.count).toBe(0);
  });

  test('Parameters valueInteger round-trips', () => {
    const json = {
      resourceType: 'Parameters',
      parameter: [{ name: 'count', valueInteger: 99 }],
    };
    const xml = ParametersXML.toXml(json);
    const rejson = ParametersXML.fromXml(xml);
    expect(rejson.parameter[0].valueInteger).toBe(99);
    expect(typeof rejson.parameter[0].valueInteger).toBe('number');
  });

  test('Parameters valueDecimal round-trips', () => {
    const json = {
      resourceType: 'Parameters',
      parameter: [{ name: 'weight', valueDecimal: 3.14 }],
    };
    const xml = ParametersXML.toXml(json);
    const rejson = ParametersXML.fromXml(xml);
    expect(rejson.parameter[0].valueDecimal).toBeCloseTo(3.14);
    expect(typeof rejson.parameter[0].valueDecimal).toBe('number');
  });

  test('ValueSet expansion total and offset preserved as integers', () => {
    const json = {
      resourceType: 'ValueSet', id: 'exp-nums', status: 'active',
      expansion: { identifier: 'urn:uuid:1', timestamp: '2024-01-01T00:00:00Z', total: 100, offset: 20 },
    };
    const xml = ValueSetXML.toXml(json);
    const rejson = ValueSetXML.fromXml(xml);
    expect(rejson.expansion.total).toBe(100);
    expect(rejson.expansion.offset).toBe(20);
    expect(typeof rejson.expansion.total).toBe('number');
  });
});

// ==================== Parameters ====================

describe('Parameters', () => {

  test('parameter with nested parts', () => {
    const json = {
      resourceType: 'Parameters',
      parameter: [
        { name: 'result', valueBoolean: true },
        {
          name: 'match',
          part: [
            { name: 'equivalence', valueCode: 'equivalent' },
            { name: 'concept', valueCoding: { system: 'http://example.org', code: 'ABC', display: 'Test' } },
          ],
        },
      ],
    };
    const xml = ParametersXML.toXml(json, 5);
    expect(xml).toContain('<part>');
    const rejson = ParametersXML.fromXml(xml, 5);
    expect(rejson.parameter).toHaveLength(2);
    expect(rejson.parameter[0].valueBoolean).toBe(true);
    expect(rejson.parameter[1].part).toHaveLength(2);
    expect(rejson.parameter[1].part[0].valueCode).toBe('equivalent');
  });

  test('parameter with embedded ValueSet resource', () => {
    const json = {
      resourceType: 'Parameters',
      parameter: [{
        name: 'return',
        resource: {
          resourceType: 'ValueSet', id: 'embedded-vs', status: 'active',
          url: 'http://example.org/fhir/ValueSet/embedded',
        },
      }],
    };
    const xml = ParametersXML.toXml(json, 5);
    expect(xml).toContain('<resource>');
    expect(xml).toContain('<ValueSet');
    const rejson = ParametersXML.fromXml(xml, 5);
    expect(rejson.parameter[0].resource.resourceType).toBe('ValueSet');
    expect(rejson.parameter[0].resource.id).toBe('embedded-vs');
  });

  test('parameter with embedded CodeSystem resource', () => {
    const json = {
      resourceType: 'Parameters',
      parameter: [{
        name: 'codeSystem',
        resource: {
          resourceType: 'CodeSystem', id: 'embedded-cs', status: 'active', content: 'complete',
          concept: [{ code: 'A', display: 'Alpha' }],
        },
      }],
    };
    const xml = ParametersXML.toXml(json, 5);
    const rejson = ParametersXML.fromXml(xml, 5);
    expect(rejson.parameter[0].resource.resourceType).toBe('CodeSystem');
    expect(rejson.parameter[0].resource.concept[0].code).toBe('A');
  });

  test('parameter with embedded OperationOutcome resource', () => {
    const json = {
      resourceType: 'Parameters',
      parameter: [{
        name: 'outcome',
        resource: {
          resourceType: 'OperationOutcome',
          issue: [{ severity: 'error', code: 'invalid' }],
        },
      }],
    };
    const xml = ParametersXML.toXml(json, 5);
    const rejson = ParametersXML.fromXml(xml, 5);
    expect(rejson.parameter[0].resource.resourceType).toBe('OperationOutcome');
    expect(rejson.parameter[0].resource.issue[0].severity).toBe('error');
  });

  test('empty Parameters resource', () => {
    const json = { resourceType: 'Parameters' };
    const xml = ParametersXML.toXml(json);
    expect(xml).toContain('<Parameters');
    const rejson = ParametersXML.fromXml(xml);
    expect(rejson.resourceType).toBe('Parameters');
  });

  test('many value[x] types', () => {
    const json = {
      resourceType: 'Parameters',
      parameter: [
        { name: 'str', valueString: 'hello' },
        { name: 'code', valueCode: 'active' },
        { name: 'uri', valueUri: 'http://example.org' },
        { name: 'bool', valueBoolean: false },
        { name: 'int', valueInteger: 7 },
        { name: 'dec', valueDecimal: 2.718 },
      ],
    };
    const xml = ParametersXML.toXml(json);
    const rejson = ParametersXML.fromXml(xml);
    expect(rejson.parameter[0].valueString).toBe('hello');
    expect(rejson.parameter[1].valueCode).toBe('active');
    expect(rejson.parameter[2].valueUri).toBe('http://example.org');
    expect(rejson.parameter[3].valueBoolean).toBe(false);
    expect(rejson.parameter[4].valueInteger).toBe(7);
    expect(rejson.parameter[5].valueDecimal).toBeCloseTo(2.718);
  });
});

// ==================== OperationOutcome ====================

describe('OperationOutcome', () => {

  test('multiple issues with all fields', () => {
    const json = {
      resourceType: 'OperationOutcome',
      issue: [
        {
          severity: 'error', code: 'invalid',
          details: { text: 'Invalid code value' },
          diagnostics: 'Code xyz not found in system http://example.org',
          location: ['Coding.code'], expression: ['Coding.code'],
        },
        {
          severity: 'warning', code: 'not-found',
          details: {
            coding: [{ system: 'http://example.org/issue-type', code: 'not-found' }],
            text: 'Code system not found',
          },
        },
      ],
    };
    const xml = OperationOutcomeXML.toXml(json);
    const rejson = OperationOutcomeXML.fromXml(xml);
    expect(rejson.issue).toHaveLength(2);
    expect(rejson.issue[0].severity).toBe('error');
    expect(rejson.issue[0].diagnostics).toContain('Code xyz');
    expect(rejson.issue[0].location).toHaveLength(1);
    expect(rejson.issue[1].details.text).toBe('Code system not found');
  });

  test('single issue with only required fields', () => {
    const json = {
      resourceType: 'OperationOutcome',
      issue: [{ severity: 'information', code: 'informational' }],
    };
    const xml = OperationOutcomeXML.toXml(json);
    const rejson = OperationOutcomeXML.fromXml(xml);
    expect(rejson.issue).toHaveLength(1);
    expect(rejson.issue[0].severity).toBe('information');
  });
});

// ==================== ValueSet expansion ====================

describe('ValueSet - Expansion', () => {

  test('expansion with contains and designations', () => {
    const json = {
      resourceType: 'ValueSet', id: 'expanded', status: 'active',
      expansion: {
        identifier: 'urn:uuid:12345', timestamp: '2024-01-01T00:00:00Z', total: 2, offset: 0,
        parameter: [{ name: 'displayLanguage', valueCode: 'en' }],
        contains: [
          { system: 'http://example.org', code: 'A', display: 'Alpha' },
          { system: 'http://example.org', code: 'B', display: 'Beta',
            designation: [{ language: 'de', value: 'Beta (de)' }] },
        ],
      },
    };
    const xml = ValueSetXML.toXml(json);
    expect(xml).toContain('<expansion>');
    expect(xml).toContain('<contains>');
    const rejson = ValueSetXML.fromXml(xml);
    expect(rejson.expansion.contains).toHaveLength(2);
    expect(rejson.expansion.contains[0].code).toBe('A');
    expect(rejson.expansion.contains[1].designation).toHaveLength(1);
    expect(rejson.expansion.total).toBe(2);
    expect(rejson.expansion.offset).toBe(0);
  });

  test('expansion with nested contains (hierarchy)', () => {
    const json = {
      resourceType: 'ValueSet', id: 'hierarchical', status: 'active',
      expansion: {
        identifier: 'urn:uuid:67890', timestamp: '2024-01-01T00:00:00Z',
        contains: [{
          system: 'http://example.org', code: 'parent', display: 'Parent',
          contains: [
            { system: 'http://example.org', code: 'child1', display: 'Child 1' },
            { system: 'http://example.org', code: 'child2', display: 'Child 2' },
          ],
        }],
      },
    };
    const xml = ValueSetXML.toXml(json);
    const rejson = ValueSetXML.fromXml(xml);
    expect(rejson.expansion.contains).toHaveLength(1);
    expect(rejson.expansion.contains[0].contains).toHaveLength(2);
    expect(rejson.expansion.contains[0].contains[0].code).toBe('child1');
  });
});

// ==================== ValueSet compose ====================

describe('ValueSet - Compose', () => {

  test('compose with include concepts', () => {
    const json = {
      resourceType: 'ValueSet', id: 'composed', status: 'active',
      compose: {
        include: [{
          system: 'http://example.org/cs',
          concept: [{ code: 'A', display: 'Alpha' }, { code: 'B', display: 'Beta' }],
        }],
      },
    };
    const xml = ValueSetXML.toXml(json);
    const rejson = ValueSetXML.fromXml(xml);
    expect(rejson.compose.include).toHaveLength(1);
    expect(rejson.compose.include[0].concept).toHaveLength(2);
  });

  test('compose with filter', () => {
    const json = {
      resourceType: 'ValueSet', id: 'filtered', status: 'active',
      compose: {
        include: [{
          system: 'http://example.org/cs',
          filter: [{ property: 'concept', op: 'is-a', value: 'root' }],
        }],
      },
    };
    const xml = ValueSetXML.toXml(json);
    const rejson = ValueSetXML.fromXml(xml);
    expect(rejson.compose.include[0].filter).toHaveLength(1);
    expect(rejson.compose.include[0].filter[0].op).toBe('is-a');
  });

  test('compose with include and exclude', () => {
    const json = {
      resourceType: 'ValueSet', id: 'inc-exc', status: 'active',
      compose: {
        include: [
          { system: 'http://example.org/cs' },
          { system: 'http://example.org/cs2', filter: [{ property: 'concept', op: 'is-a', value: 'root' }] },
        ],
        exclude: [{ system: 'http://example.org/cs', concept: [{ code: 'A' }] }],
      },
    };
    const xml = ValueSetXML.toXml(json);
    const rejson = ValueSetXML.fromXml(xml);
    expect(rejson.compose.include).toHaveLength(2);
    expect(rejson.compose.exclude).toHaveLength(1);
  });

  test('compose with valueSet import', () => {
    const json = {
      resourceType: 'ValueSet', id: 'import', status: 'active',
      compose: {
        include: [{ valueSet: ['http://example.org/fhir/ValueSet/base1', 'http://example.org/fhir/ValueSet/base2'] }],
      },
    };
    const xml = ValueSetXML.toXml(json);
    const rejson = ValueSetXML.fromXml(xml);
    expect(rejson.compose.include[0].valueSet).toHaveLength(2);
  });
});

// ==================== CodeSystem concepts ====================

describe('CodeSystem - Concepts', () => {

  test('concepts with designations and properties', () => {
    const json = {
      resourceType: 'CodeSystem', id: 'test-concepts', status: 'active', content: 'complete',
      url: 'http://example.org/fhir/CodeSystem/test', caseSensitive: true,
      property: [{ code: 'weight', type: 'decimal', description: 'Weight of concept' }],
      concept: [
        {
          code: 'A', display: 'Alpha', definition: 'The first letter',
          designation: [{ language: 'de', value: 'Alpha (DE)' }, { language: 'fr', value: 'Alpha (FR)' }],
          property: [{ code: 'weight', valueDecimal: 1.5 }],
        },
        { code: 'B', display: 'Beta' },
      ],
    };
    const xml = CodeSystemXML.toXml(json);
    const rejson = CodeSystemXML.fromXml(xml);
    expect(rejson.concept).toHaveLength(2);
    expect(rejson.concept[0].designation).toHaveLength(2);
    expect(rejson.concept[0].property).toHaveLength(1);
    expect(rejson.concept[0].property[0].valueDecimal).toBeCloseTo(1.5);
  });

  test('nested concepts (hierarchy)', () => {
    const json = {
      resourceType: 'CodeSystem', id: 'nested', status: 'active', content: 'complete',
      concept: [{
        code: 'A', display: 'Alpha',
        concept: [
          { code: 'A1', display: 'Alpha One' },
          { code: 'A2', display: 'Alpha Two', concept: [{ code: 'A2a', display: 'Alpha Two A' }] },
        ],
      }],
    };
    const xml = CodeSystemXML.toXml(json);
    const rejson = CodeSystemXML.fromXml(xml);
    expect(rejson.concept[0].concept).toHaveLength(2);
    expect(rejson.concept[0].concept[0].code).toBe('A1');
    expect(rejson.concept[0].concept[1].concept).toHaveLength(1);
    expect(rejson.concept[0].concept[1].concept[0].code).toBe('A2a');
  });

  test('concept with extensions', () => {
    const json = {
      resourceType: 'CodeSystem', id: 'concept-ext', status: 'active', content: 'complete',
      concept: [{
        code: 'X', display: 'Ex',
        extension: [{ url: 'http://hl7.org/fhir/StructureDefinition/codesystem-conceptOrder', valueInteger: 10 }],
      }],
    };
    const xml = CodeSystemXML.toXml(json);
    const rejson = CodeSystemXML.fromXml(xml);
    expect(rejson.concept[0].extension).toHaveLength(1);
    expect(rejson.concept[0].extension[0].valueInteger).toBe(10);
  });

  test('CodeSystem filter definitions with operator array', () => {
    const json = {
      resourceType: 'CodeSystem', id: 'filters', status: 'active', content: 'complete',
      filter: [{ code: 'concept', description: 'Filter by concept', operator: ['is-a', 'descendent-of'], value: 'A code' }],
    };
    const xml = CodeSystemXML.toXml(json);
    const rejson = CodeSystemXML.fromXml(xml);
    expect(rejson.filter).toHaveLength(1);
    expect(rejson.filter[0].operator).toHaveLength(2);
    expect(rejson.filter[0].operator).toContain('is-a');
  });
});

// ==================== ConceptMap ====================

describe('ConceptMap', () => {

  test('group with elements and targets', () => {
    const json = {
      resourceType: 'ConceptMap', id: 'test-cm', status: 'active',
      sourceScopeCanonical: 'http://example.org/vs1', targetScopeCanonical: 'http://example.org/vs2',
      group: [{
        source: 'http://example.org/cs1', target: 'http://example.org/cs2',
        element: [{ code: 'A', display: 'Alpha', target: [{ code: 'X', display: 'Ex', relationship: 'equivalent' }] }],
      }],
    };
    const xml = ConceptMapXML.toXml(json, 5);
    const rejson = ConceptMapXML.fromXml(xml, 5);
    expect(rejson.group).toHaveLength(1);
    expect(rejson.group[0].element).toHaveLength(1);
    expect(rejson.group[0].element[0].target).toHaveLength(1);
    expect(rejson.group[0].element[0].target[0].relationship).toBe('equivalent');
  });

  test('ConceptMap with multiple groups', () => {
    const json = {
      resourceType: 'ConceptMap', id: 'multi-group', status: 'active',
      group: [
        { source: 'http://example.org/cs1', target: 'http://example.org/cs2',
          element: [{ code: 'A', target: [{ code: 'X', relationship: 'equivalent' }] }] },
        { source: 'http://example.org/cs3', target: 'http://example.org/cs4',
          element: [{ code: 'B', target: [{ code: 'Y', relationship: 'wider' }] }] },
      ],
    };
    const xml = ConceptMapXML.toXml(json, 5);
    const rejson = ConceptMapXML.fromXml(xml, 5);
    expect(rejson.group).toHaveLength(2);
    expect(rejson.group[1].element[0].target[0].relationship).toBe('wider');
  });
});

// ==================== NamingSystem ====================

describe('NamingSystem', () => {

  test('uniqueId array with preferred boolean', () => {
    const json = {
      resourceType: 'NamingSystem', id: 'test-ns', name: 'TestNamingSystem',
      status: 'active', kind: 'codesystem', date: '2024-01-01',
      uniqueId: [
        { type: 'oid', value: '1.2.3.4.5', preferred: true },
        { type: 'uri', value: 'http://example.org/ns' },
      ],
    };
    const xml = NamingSystemXML.toXml(json);
    const rejson = NamingSystemXML.fromXml(xml);
    expect(rejson.uniqueId).toHaveLength(2);
    expect(rejson.uniqueId[0].type).toBe('oid');
    expect(rejson.uniqueId[0].preferred).toBe(true);
    expect(rejson.uniqueId[1].type).toBe('uri');
  });

  test('NamingSystem with contact', () => {
    const json = {
      resourceType: 'NamingSystem', id: 'ns-contact', name: 'TestNS',
      status: 'active', kind: 'identifier', date: '2024-06-01',
      contact: [{ name: 'Admin', telecom: [{ system: 'email', value: 'admin@example.org' }] }],
      uniqueId: [{ type: 'uri', value: 'http://example.org/ns2' }],
    };
    const xml = NamingSystemXML.toXml(json);
    const rejson = NamingSystemXML.fromXml(xml);
    expect(rejson.contact).toHaveLength(1);
    expect(rejson.contact[0].telecom[0].value).toBe('admin@example.org');
  });
});

// ==================== Bundle ====================

describe('Bundle', () => {

  test('searchset bundle with mixed entry types', () => {
    const json = {
      resourceType: 'Bundle', id: 'test-bundle', type: 'searchset', total: 2,
      link: [{ relation: 'self', url: 'http://example.org/fhir/ValueSet?_count=10' }],
      entry: [
        {
          fullUrl: 'http://example.org/fhir/ValueSet/1',
          resource: { resourceType: 'ValueSet', id: '1', status: 'active', url: 'http://example.org/fhir/ValueSet/test1' },
          search: { mode: 'match', score: 1 },
        },
        {
          fullUrl: 'http://example.org/fhir/OperationOutcome/2',
          resource: { resourceType: 'OperationOutcome', issue: [{ severity: 'information', code: 'informational', diagnostics: 'Search completed' }] },
          search: { mode: 'outcome' },
        },
      ],
    };
    const xml = BundleXML.toXml(json, 5);
    expect(xml).toContain('<type value="searchset"');
    expect(xml).toContain('<total value="2"');
    expect(xml).toContain('<entry>');
    expect(xml).toContain('<fullUrl');
    expect(xml).toContain('<resource>');
    expect(xml).toContain('<search>');
    expect(xml).toContain('<mode value="match"');
    expect(xml).toContain('<score value="1"');
  });

  test('empty collection bundle', () => {
    const json = { resourceType: 'Bundle', type: 'collection' };
    const xml = BundleXML.toXml(json, 5);
    expect(xml).toContain('<type value="collection"');
    expect(xml).not.toContain('<entry>');
  });

  test('bundle with multiple link elements', () => {
    const json = {
      resourceType: 'Bundle', type: 'searchset',
      link: [
        { relation: 'self', url: 'http://example.org/fhir/CodeSystem?page=1' },
        { relation: 'next', url: 'http://example.org/fhir/CodeSystem?page=2' },
      ],
    };
    const xml = BundleXML.toXml(json, 5);
    expect(xml).toContain('<link>');
    expect(xml).toContain('<relation value="self"');
    expect(xml).toContain('<relation value="next"');
  });

  test('bundle with meta', () => {
    const json = {
      resourceType: 'Bundle', id: 'meta-bundle', type: 'collection',
      meta: { versionId: '1', lastUpdated: '2024-01-01T00:00:00Z' },
    };
    const xml = BundleXML.toXml(json, 5);
    expect(xml).toContain('<meta>');
    expect(xml).toContain('<versionId value="1"');
    expect(xml).toContain('<lastUpdated');
  });
});

// ==================== Element ordering ====================

describe('Element Ordering', () => {

  test('CodeSystem elements in FHIR-specified order', () => {
    const json = {
      resourceType: 'CodeSystem',
      content: 'complete', status: 'active', url: 'http://example.org/test',
      id: 'test-order', name: 'TestOrder', count: 5,
    };
    const xml = CodeSystemXML.toXml(json);
    const idPos = xml.indexOf('<id');
    const urlPos = xml.indexOf('<url');
    const namePos = xml.indexOf('<name');
    const statusPos = xml.indexOf('<status');
    const contentPos = xml.indexOf('<content');
    const countPos = xml.indexOf('<count');
    expect(idPos).toBeLessThan(urlPos);
    expect(urlPos).toBeLessThan(namePos);
    expect(namePos).toBeLessThan(statusPos);
    expect(statusPos).toBeLessThan(contentPos);
    expect(contentPos).toBeLessThan(countPos);
  });

  test('OperationOutcome issue elements in correct order', () => {
    const json = {
      resourceType: 'OperationOutcome',
      issue: [{ diagnostics: 'some diagnostic', code: 'invalid', severity: 'error', details: { text: 'details text' } }],
    };
    const xml = OperationOutcomeXML.toXml(json);
    const severityPos = xml.indexOf('<severity');
    const codePos = xml.indexOf('<code');
    const detailsPos = xml.indexOf('<details');
    const diagnosticsPos = xml.indexOf('<diagnostics');
    expect(severityPos).toBeLessThan(codePos);
    expect(codePos).toBeLessThan(detailsPos);
    expect(detailsPos).toBeLessThan(diagnosticsPos);
  });

  test('Parameters: name before value', () => {
    const json = {
      resourceType: 'Parameters',
      parameter: [{ name: 'test', valueString: 'hello' }],
    };
    const xml = ParametersXML.toXml(json);
    const namePos = xml.indexOf('<name');
    const valuePos = xml.indexOf('<valueString');
    expect(namePos).toBeLessThan(valuePos);
  });

  test('ValueSet: url before status before compose', () => {
    const json = {
      resourceType: 'ValueSet',
      compose: { include: [{ system: 'http://example.org' }] },
      status: 'active', url: 'http://example.org/vs',
    };
    const xml = ValueSetXML.toXml(json);
    const urlPos = xml.indexOf('<url');
    const statusPos = xml.indexOf('<status');
    const composePos = xml.indexOf('<compose');
    expect(urlPos).toBeLessThan(statusPos);
    expect(statusPos).toBeLessThan(composePos);
  });

  test('CapabilityStatement: url before status before kind', () => {
    const json = {
      resourceType: 'CapabilityStatement',
      kind: 'instance', status: 'active', url: 'http://example.org/cs',
      date: '2024-01-01', fhirVersion: '5.0.0', format: ['json'],
    };
    const xml = CapabilityStatementXML.toXml(json, 5);
    const urlPos = xml.indexOf('<url');
    const statusPos = xml.indexOf('<status');
    const kindPos = xml.indexOf('<kind');
    expect(urlPos).toBeLessThan(statusPos);
    expect(statusPos).toBeLessThan(kindPos);
  });
});

// ==================== Minimal resources ====================

describe('Minimal Resources', () => {

  test('minimal CodeSystem', () => {
    const json = { resourceType: 'CodeSystem', status: 'active', content: 'complete' };
    const xml = CodeSystemXML.toXml(json);
    const rejson = CodeSystemXML.fromXml(xml);
    expect(rejson.resourceType).toBe('CodeSystem');
    expect(rejson.status).toBe('active');
  });

  test('minimal ValueSet', () => {
    const json = { resourceType: 'ValueSet', status: 'draft' };
    const xml = ValueSetXML.toXml(json);
    const rejson = ValueSetXML.fromXml(xml);
    expect(rejson.resourceType).toBe('ValueSet');
    expect(rejson.status).toBe('draft');
  });

  test('minimal OperationOutcome', () => {
    const json = { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'exception' }] };
    const xml = OperationOutcomeXML.toXml(json);
    const rejson = OperationOutcomeXML.fromXml(xml);
    expect(rejson.issue).toHaveLength(1);
  });

  test('minimal Parameters', () => {
    const json = { resourceType: 'Parameters' };
    const xml = ParametersXML.toXml(json);
    const rejson = ParametersXML.fromXml(xml);
    expect(rejson.resourceType).toBe('Parameters');
  });

  test('minimal ConceptMap', () => {
    const json = { resourceType: 'ConceptMap', status: 'active' };
    const xml = ConceptMapXML.toXml(json, 5);
    const rejson = ConceptMapXML.fromXml(xml, 5);
    expect(rejson.resourceType).toBe('ConceptMap');
  });

  test('minimal NamingSystem', () => {
    const json = {
      resourceType: 'NamingSystem', name: 'X', status: 'active', kind: 'codesystem',
      date: '2024-01-01', uniqueId: [{ type: 'uri', value: 'http://example.org' }],
    };
    const xml = NamingSystemXML.toXml(json);
    const rejson = NamingSystemXML.fromXml(xml);
    expect(rejson.resourceType).toBe('NamingSystem');
  });

  test('minimal CapabilityStatement', () => {
    const json = {
      resourceType: 'CapabilityStatement', status: 'active', date: '2024-01-01',
      kind: 'instance', fhirVersion: '5.0.0', format: ['json'],
    };
    const xml = CapabilityStatementXML.toXml(json, 5);
    const rejson = CapabilityStatementXML.fromXml(xml);
    expect(rejson.resourceType).toBe('CapabilityStatement');
  });

  test('minimal TerminologyCapabilities', () => {
    const json = {
      resourceType: 'TerminologyCapabilities', status: 'active', date: '2024-01-01', kind: 'instance',
    };
    const xml = TerminologyCapabilitiesXML.toXml(json, 5);
    const rejson = TerminologyCapabilitiesXML.fromXml(xml);
    expect(rejson.resourceType).toBe('TerminologyCapabilities');
  });
});

// ==================== Complex data types ====================

describe('Complex Data Types', () => {

  test('identifier array', () => {
    const json = {
      resourceType: 'CodeSystem', id: 'ids', status: 'active', content: 'complete',
      identifier: [
        { system: 'http://example.org/ids', value: '12345' },
        { system: 'urn:ietf:rfc:3986', value: 'urn:oid:2.16.840.1.113883.4.642' },
      ],
    };
    const xml = CodeSystemXML.toXml(json);
    const rejson = CodeSystemXML.fromXml(xml);
    expect(rejson.identifier).toHaveLength(2);
    expect(rejson.identifier[0].system).toBe('http://example.org/ids');
    expect(rejson.identifier[1].value).toBe('urn:oid:2.16.840.1.113883.4.642');
  });

  test('contact with telecom', () => {
    const json = {
      resourceType: 'CodeSystem', id: 'contact', status: 'active', content: 'complete',
      contact: [{ name: 'Test Author', telecom: [{ system: 'email', value: 'test@example.org' }] }],
    };
    const xml = CodeSystemXML.toXml(json);
    const rejson = CodeSystemXML.fromXml(xml);
    expect(rejson.contact).toHaveLength(1);
    expect(rejson.contact[0].name).toBe('Test Author');
    expect(rejson.contact[0].telecom[0].system).toBe('email');
  });

  test('meta with profile, security, and tag', () => {
    const json = {
      resourceType: 'ValueSet', id: 'test-meta', status: 'active',
      meta: {
        versionId: '3', lastUpdated: '2024-06-01T12:00:00Z',
        profile: ['http://hl7.org/fhir/StructureDefinition/shareablevalueset'],
        security: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActReason', code: 'HTEST' }],
        tag: [{ system: 'http://example.org/tags', code: 'reviewed' }],
      },
    };
    const xml = ValueSetXML.toXml(json);
    const rejson = ValueSetXML.fromXml(xml);
    expect(rejson.meta.versionId).toBe('3');
    expect(rejson.meta.lastUpdated).toBe('2024-06-01T12:00:00Z');
    expect(rejson.meta.profile).toHaveLength(1);
  });

  test('CodeableConcept with multiple codings', () => {
    const json = {
      resourceType: 'OperationOutcome',
      issue: [{
        severity: 'error', code: 'invalid',
        details: {
          coding: [
            { system: 'http://example.org/codes', code: 'ERR001', display: 'Error One' },
            { system: 'http://example.org/codes', code: 'ERR002', display: 'Error Two' },
          ],
          text: 'Multiple codings',
        },
      }],
    };
    const xml = OperationOutcomeXML.toXml(json);
    const rejson = OperationOutcomeXML.fromXml(xml);
    expect(rejson.issue[0].details.coding).toHaveLength(2);
    expect(rejson.issue[0].details.coding[0].code).toBe('ERR001');
    expect(rejson.issue[0].details.coding[1].code).toBe('ERR002');
  });
});

// ==================== XML structure ====================

describe('XML Structure', () => {

  test('CodeSystem toXml includes XML declaration and namespace', () => {
    const xml = CodeSystemXML.toXml({ resourceType: 'CodeSystem', status: 'active', content: 'complete' });
    expect(xml).toMatch(/^<\?xml version="1\.0"/);
    expect(xml).toContain('xmlns="http://hl7.org/fhir"');
  });

  test('ValueSet toXml includes XML declaration and namespace', () => {
    const xml = ValueSetXML.toXml({ resourceType: 'ValueSet', status: 'active' });
    expect(xml).toMatch(/^<\?xml version="1\.0"/);
    expect(xml).toContain('xmlns="http://hl7.org/fhir"');
  });

  test('OperationOutcome toXml includes XML declaration and namespace', () => {
    const xml = OperationOutcomeXML.toXml({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'exception' }] });
    expect(xml).toMatch(/^<\?xml version="1\.0"/);
    expect(xml).toContain('xmlns="http://hl7.org/fhir"');
  });

  test('Parameters toXml includes XML declaration and namespace', () => {
    const xml = ParametersXML.toXml({ resourceType: 'Parameters' });
    expect(xml).toMatch(/^<\?xml version="1\.0"/);
    expect(xml).toContain('xmlns="http://hl7.org/fhir"');
  });

  test('toXml produces well-formed XML (matching open/close tags)', () => {
    const json = {
      resourceType: 'CodeSystem', id: 'wellformed', status: 'active', content: 'complete',
      concept: [{ code: 'A', display: 'Alpha' }],
    };
    const xml = CodeSystemXML.toXml(json);
    const opens = (xml.match(/<CodeSystem/g) || []).length;
    const closes = (xml.match(/<\/CodeSystem>/g) || []).length;
    expect(opens).toBe(1);
    expect(closes).toBe(1);
  });
});