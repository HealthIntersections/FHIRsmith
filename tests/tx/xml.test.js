/**
 * Test cases for FHIR XML serialization/deserialization
 * Tests the FhirXmlBase class and resource-specific XML classes
 */
const { FhirXmlBase, FhirXmlParser } = require('../../tx/xml/xml-base');
const { CodeSystemXML } = require('../../tx/xml/codesystem-xml');
const { ValueSetXML } = require('../../tx/xml/valueset-xml');
const { ParametersXML } = require('../../tx/xml/parameters-xml');
const { OperationOutcomeXML } = require('../../tx/xml/operationoutcome-xml');
const { ConceptMapXML } = require('../../tx/xml/conceptmap-xml');

describe('FhirXmlBase', () => {

  describe('XML Parsing Utilities', () => {

    test('should escape XML special characters', () => {
      expect(FhirXmlBase.escapeXml('a < b')).toBe('a &lt; b');
      expect(FhirXmlBase.escapeXml('a > b')).toBe('a &gt; b');
      expect(FhirXmlBase.escapeXml('a & b')).toBe('a &amp; b');
      expect(FhirXmlBase.escapeXml('a "b" c')).toBe('a &quot;b&quot; c');
      expect(FhirXmlBase.escapeXml("a 'b' c")).toBe("a &apos;b&apos; c");
      expect(FhirXmlBase.escapeXml(null)).toBe('');
      expect(FhirXmlBase.escapeXml(undefined)).toBe('');
    });

    // XML 1.0 cannot carry the C0 control characters at all - not even as
    // numeric character references - so serialising one is impossible rather
    // than merely ugly, and escapeXml refuses instead of emitting a document
    // no parser will read
    test('should reject control characters XML cannot represent', () => {
      for (const code of [0x00, 0x01, 0x08, 0x0B, 0x0C, 0x0E, 0x1F]) {
        const value = 'before' + String.fromCharCode(code) + 'after';
        expect(() => FhirXmlBase.escapeXml(value)).toThrow(/control character/);
      }
    });

    test('should report which character it rejected, and where', () => {
      expect(() => FhirXmlBase.escapeXml('ab' + String.fromCharCode(0x0B) + 'cd'))
        .toThrow(/U\+000B at offset 2/);
    });

    test('should keep the whitespace XML does allow', () => {
      const tab = String.fromCharCode(9), lf = String.fromCharCode(10), cr = String.fromCharCode(13);
      expect(FhirXmlBase.escapeXml('a' + tab + 'b' + lf + 'c' + cr + 'd'))
        .toBe('a' + tab + 'b' + lf + 'c' + cr + 'd');
      // DEL is legal in XML 1.0, unlike the C0 range
      const del = String.fromCharCode(127);
      expect(FhirXmlBase.escapeXml('a' + del + 'b')).toBe('a' + del + 'b');
    });

    test('should unescape XML entities', () => {
      expect(FhirXmlBase.unescapeXml('a &lt; b')).toBe('a < b');
      expect(FhirXmlBase.unescapeXml('a &gt; b')).toBe('a > b');
      expect(FhirXmlBase.unescapeXml('a &amp; b')).toBe('a & b');
      expect(FhirXmlBase.unescapeXml('a &quot;b&quot; c')).toBe('a "b" c');
      expect(FhirXmlBase.unescapeXml("a &apos;b&apos; c")).toBe("a 'b' c");
    });

    test('should generate correct indentation', () => {
      expect(FhirXmlBase.indent(0)).toBe('');
      expect(FhirXmlBase.indent(1)).toBe('  ');
      expect(FhirXmlBase.indent(2)).toBe('    ');
      expect(FhirXmlBase.indent(3)).toBe('      ');
    });

    test('should return FHIR namespace', () => {
      expect(FhirXmlBase.getNamespace()).toBe('http://hl7.org/fhir');
    });
  });

  describe('Primitive Value Conversion', () => {

    test('should convert boolean element values', () => {
      expect(FhirXmlBase._convertPrimitiveValue('valueBoolean', 'true')).toBe(true);
      expect(FhirXmlBase._convertPrimitiveValue('valueBoolean', 'false')).toBe(false);
      expect(FhirXmlBase._convertPrimitiveValue('experimental', 'true')).toBe(true);
      expect(FhirXmlBase._convertPrimitiveValue('caseSensitive', 'false')).toBe(false);
      expect(FhirXmlBase._convertPrimitiveValue('inactive', 'true')).toBe(true);
    });

    test('should convert integer element values', () => {
      expect(FhirXmlBase._convertPrimitiveValue('valueInteger', '42')).toBe(42);
      expect(FhirXmlBase._convertPrimitiveValue('valueUnsignedInt', '100')).toBe(100);
      expect(FhirXmlBase._convertPrimitiveValue('count', '5')).toBe(5);
      expect(FhirXmlBase._convertPrimitiveValue('offset', '10')).toBe(10);
      expect(FhirXmlBase._convertPrimitiveValue('total', '1000')).toBe(1000);
    });

    test('should convert decimal element values', () => {
      expect(FhirXmlBase._convertPrimitiveValue('valueDecimal', '3.14')).toBeCloseTo(3.14);
      expect(FhirXmlBase._convertPrimitiveValue('valueDecimal', '0.001')).toBeCloseTo(0.001);
    });

    test('should keep string values as strings', () => {
      // Filter values should NOT be converted to boolean even if they look like booleans
      expect(FhirXmlBase._convertPrimitiveValue('value', 'true')).toBe('true');
      expect(FhirXmlBase._convertPrimitiveValue('value', 'false')).toBe('false');
      expect(FhirXmlBase._convertPrimitiveValue('code', 'active')).toBe('active');
      expect(FhirXmlBase._convertPrimitiveValue('display', 'Test Display')).toBe('Test Display');
    });
  });

  describe('Array Element Detection', () => {

    test('should identify known array elements', () => {
      expect(FhirXmlBase._isArrayElement('coding', 'any')).toBe(true);
      expect(FhirXmlBase._isArrayElement('extension', 'any')).toBe(true);
      expect(FhirXmlBase._isArrayElement('identifier', 'any')).toBe(true);
      expect(FhirXmlBase._isArrayElement('concept', 'any')).toBe(true);
      expect(FhirXmlBase._isArrayElement('include', 'any')).toBe(true);
      expect(FhirXmlBase._isArrayElement('filter', 'any')).toBe(true);
    });

    test('should handle context-dependent property element', () => {
      // property is an array inside concept but NOT inside filter
      expect(FhirXmlBase._isArrayElement('property', 'concept')).toBe(true);
      expect(FhirXmlBase._isArrayElement('property', 'CodeSystem')).toBe(true);
      expect(FhirXmlBase._isArrayElement('property', 'filter')).toBe(false);
    });

    test('should identify non-array elements', () => {
      expect(FhirXmlBase._isArrayElement('url', 'any')).toBe(false);
      expect(FhirXmlBase._isArrayElement('version', 'any')).toBe(false);
      expect(FhirXmlBase._isArrayElement('status', 'any')).toBe(false);
      expect(FhirXmlBase._isArrayElement('name', 'any')).toBe(false);
    });
  });
});

describe('FhirXmlParser', () => {

  test('should parse simple self-closing element', () => {
    const xml = '<status value="active"/>';
    const parser = new FhirXmlParser(xml);
    const result = parser.parse();

    expect(result.name).toBe('status');
    expect(result.attributes.value).toBe('active');
    expect(result.children).toEqual([]);
  });

  test('should parse element with children', () => {
    const xml = `<identifier>
      <system value="http://example.org"/>
      <value value="test-123"/>
    </identifier>`;
    const parser = new FhirXmlParser(xml);
    const result = parser.parse();

    expect(result.name).toBe('identifier');
    expect(result.children.length).toBe(2);
    expect(result.children[0].name).toBe('system');
    expect(result.children[0].attributes.value).toBe('http://example.org');
    expect(result.children[1].name).toBe('value');
    expect(result.children[1].attributes.value).toBe('test-123');
  });

  test('should parse XML declaration', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
    <status value="active"/>`;
    const parser = new FhirXmlParser(xml);
    const result = parser.parse();

    expect(result.name).toBe('status');
    expect(result.attributes.value).toBe('active');
  });

  test('should unescape XML entities in attribute values', () => {
    const xml = '<display value="Test &amp; Display &lt;1&gt;"/>';
    const parser = new FhirXmlParser(xml);
    const result = parser.parse();

    expect(result.attributes.value).toBe('Test & Display <1>');
  });

  test('should handle extension url attribute', () => {
    const xml = `<extension url="http://example.org/ext">
      <valueString value="test"/>
    </extension>`;
    const parser = new FhirXmlParser(xml);
    const result = parser.parse();

    expect(result.name).toBe('extension');
    expect(result.attributes.url).toBe('http://example.org/ext');
    expect(result.children[0].name).toBe('valueString');
  });

  test('should accept single quoted attribute values', () => {
    const result = new FhirXmlParser("<status value='active'/>").parse();
    expect(result.attributes.value).toBe('active');
  });

  test('should skip comments, CDATA and character data between elements', () => {
    const xml = '<a><!-- c --><![CDATA[ raw ]]>text<b value="1"/></a>';
    const result = new FhirXmlParser(xml).parse();
    expect(result.children.length).toBe(1);
    expect(result.children[0].attributes.value).toBe('1');
  });
});

/**
 * The parser has to be total: every input either produces a tree or throws. It runs on
 * request bodies, synchronously, on node's only thread - so an input it cannot finish
 * does not fail one request, it stops the process answering anything.
 *
 * Each of these hung the parser before it was rewritten, or blew the stack. The mechanism
 * was always the same: an indexOf() that returned -1 whose result was assigned to the
 * cursor, sending it backwards.
 */
describe('FhirXmlParser refuses malformed input rather than looping', () => {

  // if any of these regress, the test run stops dead rather than failing, so keep the
  // timeout short enough to notice
  const parse = (xml) => () => new FhirXmlParser(xml).parse();

  test.each([
    ['an attribute with no value and no = later in the document', '<ValueSet><x bare></x></ValueSet>'],
    ['a document type declaration', '<!DOCTYPE v><ValueSet/>'],
    ['a document type declaration with entities', '<?xml version="1.0"?><!DOCTYPE l [<!ENTITY a "b">]><ValueSet/>'],
    ['an unterminated comment', '<ValueSet><!-- oops </ValueSet>'],
    ['an unterminated comment before the root', '<!-- oops <ValueSet/>'],
    ['an unterminated XML declaration', '<?xml version="1.0"'],
    ['an unterminated CDATA section', '<ValueSet><![CDATA[ oops </ValueSet>'],
    ['an unclosed element', '<ValueSet><x value="1">'],
    ['a mismatched closing tag', '<ValueSet><x value="1"></y></ValueSet>'],
    ['a start tag that never closes', '<ValueSet><x value="1"'],
    ['an unquoted attribute value', '<ValueSet><x value=1/></ValueSet>'],
    ['an unterminated attribute value', '<ValueSet><x value="1/></ValueSet>'],
    ['no element at all', '   '],
    ['character data where an element should be', 'hello'],
    ['a bare angle bracket', '<'],
    ['an empty element name', '< >']
  ])('rejects %s', (_label, xml) => {
    expect(parse(xml)).toThrow();
  }, 5000);

  test('rejects XML nested past the depth limit', () => {
    const deep = '<a>'.repeat(5000) + '</a>'.repeat(5000);
    expect(parse(deep)).toThrow(/nested more than/);
  }, 5000);

  test('accepts nesting within the depth limit', () => {
    const ok = '<a>'.repeat(100) + '</a>'.repeat(100);
    expect(parse(ok)).not.toThrow();
  }, 5000);

  test('reports the position of the problem', () => {
    expect(parse('<ValueSet><x value=1/></ValueSet>')).toThrow(/at position \d+/);
  }, 5000);

  test('parses a large document in reasonable time', () => {
    const many = '<ValueSet>' + '<x value="abc"/>'.repeat(50000) + '</ValueSet>';
    const started = Date.now();
    const result = new FhirXmlParser(many).parse();
    expect(result.children.length).toBe(50000);
    expect(Date.now() - started).toBeLessThan(5000);
  }, 10000);
});

describe('CodeSystemXML', () => {

  const simpleCodeSystemXml = `<?xml version="1.0" encoding="UTF-8"?>
<CodeSystem xmlns="http://hl7.org/fhir">
  <url value="http://example.org/fhir/CodeSystem/test"/>
  <version value="1.0.0"/>
  <name value="TestCodeSystem"/>
  <status value="active"/>
  <caseSensitive value="true"/>
  <concept>
    <code value="A"/>
    <display value="Concept A"/>
  </concept>
  <concept>
    <code value="B"/>
    <display value="Concept B"/>
  </concept>
</CodeSystem>`;

  const nestedConceptXml = `<?xml version="1.0" encoding="UTF-8"?>
<CodeSystem xmlns="http://hl7.org/fhir">
  <url value="http://example.org/fhir/CodeSystem/nested"/>
  <name value="NestedCodeSystem"/>
  <status value="active"/>
  <concept>
    <code value="parent"/>
    <display value="Parent"/>
    <concept>
      <code value="child1"/>
      <display value="Child 1"/>
    </concept>
    <concept>
      <code value="child2"/>
      <display value="Child 2"/>
    </concept>
  </concept>
</CodeSystem>`;

  const codeSystemWithDesignationsXml = `<?xml version="1.0" encoding="UTF-8"?>
<CodeSystem xmlns="http://hl7.org/fhir">
  <url value="http://example.org/fhir/CodeSystem/designations"/>
  <name value="DesignationCodeSystem"/>
  <status value="active"/>
  <concept>
    <code value="A"/>
    <display value="Concept A"/>
    <designation>
      <language value="de"/>
      <value value="Konzept A"/>
    </designation>
    <designation>
      <language value="fr"/>
      <value value="Concept A (fr)"/>
    </designation>
  </concept>
</CodeSystem>`;

  const codeSystemWithPropertiesXml = `<?xml version="1.0" encoding="UTF-8"?>
<CodeSystem xmlns="http://hl7.org/fhir">
  <url value="http://example.org/fhir/CodeSystem/properties"/>
  <name value="PropertyCodeSystem"/>
  <status value="active"/>
  <property>
    <code value="status"/>
    <type value="code"/>
  </property>
  <concept>
    <code value="A"/>
    <display value="Concept A"/>
    <property>
      <code value="status"/>
      <valueCode value="active"/>
    </property>
    <property>
      <code value="notSelectable"/>
      <valueBoolean value="true"/>
    </property>
  </concept>
</CodeSystem>`;

  describe('fromXml', () => {

    test('should parse simple CodeSystem', () => {
      const result = CodeSystemXML.fromXml(simpleCodeSystemXml, 5);

      expect(result.resourceType).toBe('CodeSystem');
      expect(result.url).toBe('http://example.org/fhir/CodeSystem/test');
      expect(result.version).toBe('1.0.0');
      expect(result.name).toBe('TestCodeSystem');
      expect(result.status).toBe('active');
      expect(result.caseSensitive).toBe(true);
      expect(result.concept).toHaveLength(2);
      expect(result.concept[0].code).toBe('A');
      expect(result.concept[1].code).toBe('B');
    });

    test('should parse nested concepts', () => {
      const result = CodeSystemXML.fromXml(nestedConceptXml, 5);

      expect(result.concept).toHaveLength(1);
      expect(result.concept[0].code).toBe('parent');
      expect(result.concept[0].concept).toHaveLength(2);
      expect(result.concept[0].concept[0].code).toBe('child1');
      expect(result.concept[0].concept[1].code).toBe('child2');
    });

    test('should parse designations as arrays', () => {
      const result = CodeSystemXML.fromXml(codeSystemWithDesignationsXml, 5);

      expect(result.concept[0].designation).toHaveLength(2);
      expect(result.concept[0].designation[0].language).toBe('de');
      expect(result.concept[0].designation[0].value).toBe('Konzept A');
      expect(result.concept[0].designation[1].language).toBe('fr');
    });

    test('should parse concept properties as arrays with correct types', () => {
      const result = CodeSystemXML.fromXml(codeSystemWithPropertiesXml, 5);

      // Resource-level property
      expect(result.property).toHaveLength(1);
      expect(result.property[0].code).toBe('status');

      // Concept-level properties
      expect(result.concept[0].property).toHaveLength(2);
      expect(result.concept[0].property[0].code).toBe('status');
      expect(result.concept[0].property[0].valueCode).toBe('active');
      expect(result.concept[0].property[1].valueBoolean).toBe(true);
    });
  });

  describe('toXml', () => {

    test('should generate valid XML', () => {
      const json = {
        resourceType: 'CodeSystem',
        url: 'http://example.org/test',
        name: 'Test',
        status: 'active',
        concept: [
          { code: 'A', display: 'Concept A' }
        ]
      };

      const xml = CodeSystemXML.toXml(json, 5);

      expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(xml).toContain('<CodeSystem xmlns="http://hl7.org/fhir">');
      expect(xml).toContain('<url value="http://example.org/test"/>');
      expect(xml).toContain('<name value="Test"/>');
      expect(xml).toContain('<status value="active"/>');
      expect(xml).toContain('<code value="A"/>');
      expect(xml).toContain('</CodeSystem>');
    });

    test('should escape special characters', () => {
      const json = {
        resourceType: 'CodeSystem',
        url: 'http://example.org/test',
        name: 'Test & Demo',
        status: 'active'
      };

      const xml = CodeSystemXML.toXml(json, 5);
      expect(xml).toContain('<name value="Test &amp; Demo"/>');
    });
  });

  describe('round-trip', () => {

    test('should preserve data through XML round-trip', () => {
      const original = CodeSystemXML.fromXml(simpleCodeSystemXml, 5);
      const xml = CodeSystemXML.toXml(original, 5);
      const restored = CodeSystemXML.fromXml(xml, 5);

      expect(restored.url).toBe(original.url);
      expect(restored.name).toBe(original.name);
      expect(restored.status).toBe(original.status);
      expect(restored.concept.length).toBe(original.concept.length);
    });
  });
});

describe('ValueSetXML', () => {

  const simpleValueSetXml = `<?xml version="1.0" encoding="UTF-8"?>
<ValueSet xmlns="http://hl7.org/fhir">
  <url value="http://example.org/fhir/ValueSet/test"/>
  <name value="TestValueSet"/>
  <status value="active"/>
  <compose>
    <include>
      <system value="http://example.org/CodeSystem/test"/>
    </include>
  </compose>
</ValueSet>`;

  const valueSetWithFilterXml = `<?xml version="1.0" encoding="UTF-8"?>
<ValueSet xmlns="http://hl7.org/fhir">
  <url value="http://example.org/fhir/ValueSet/filtered"/>
  <name value="FilteredValueSet"/>
  <status value="active"/>
  <compose>
    <include>
      <system value="http://example.org/CodeSystem/test"/>
      <filter>
        <property value="concept"/>
        <op value="is-a"/>
        <value value="parent"/>
      </filter>
      <filter>
        <property value="status"/>
        <op value="="/>
        <value value="active"/>
      </filter>
    </include>
  </compose>
</ValueSet>`;

  const valueSetWithExtensionXml = `<?xml version="1.0" encoding="UTF-8"?>
<ValueSet xmlns="http://hl7.org/fhir">
  <url value="http://example.org/fhir/ValueSet/extension"/>
  <name value="ExtensionValueSet"/>
  <status value="active"/>
  <compose>
    <extension url="http://example.org/ext/compose-param">
      <extension url="name">
        <valueCode value="displayLanguage"/>
      </extension>
      <extension url="value">
        <valueCode value="de"/>
      </extension>
    </extension>
    <include>
      <system value="http://example.org/CodeSystem/test"/>
    </include>
  </compose>
</ValueSet>`;

  describe('fromXml', () => {

    test('should parse simple ValueSet', () => {
      const result = ValueSetXML.fromXml(simpleValueSetXml, 5);

      expect(result.resourceType).toBe('ValueSet');
      expect(result.url).toBe('http://example.org/fhir/ValueSet/test');
      expect(result.name).toBe('TestValueSet');
      expect(result.compose.include).toHaveLength(1);
      expect(result.compose.include[0].system).toBe('http://example.org/CodeSystem/test');
    });

    test('should parse filters with property as single value (not array)', () => {
      const result = ValueSetXML.fromXml(valueSetWithFilterXml, 5);

      expect(result.compose.include[0].filter).toHaveLength(2);

      // property should be a string, NOT an array
      expect(result.compose.include[0].filter[0].property).toBe('concept');
      expect(typeof result.compose.include[0].filter[0].property).toBe('string');

      expect(result.compose.include[0].filter[0].op).toBe('is-a');
      expect(result.compose.include[0].filter[0].value).toBe('parent');

      expect(result.compose.include[0].filter[1].property).toBe('status');
      expect(result.compose.include[0].filter[1].value).toBe('active');
    });

    test('should parse filter value as string even when it looks like boolean', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ValueSet xmlns="http://hl7.org/fhir">
  <url value="http://example.org/fhir/ValueSet/bool-filter"/>
  <name value="BoolFilterValueSet"/>
  <status value="active"/>
  <compose>
    <include>
      <system value="http://example.org/CodeSystem/test"/>
      <filter>
        <property value="notSelectable"/>
        <op value="="/>
        <value value="false"/>
      </filter>
    </include>
  </compose>
</ValueSet>`;

      const result = ValueSetXML.fromXml(xml, 5);

      // filter.value should be string "false", not boolean false
      expect(result.compose.include[0].filter[0].value).toBe('false');
      expect(typeof result.compose.include[0].filter[0].value).toBe('string');
    });

    test('should parse nested extensions correctly', () => {
      const result = ValueSetXML.fromXml(valueSetWithExtensionXml, 5);

      // compose should have extension array
      expect(result.compose.extension).toHaveLength(1);
      expect(result.compose.extension[0].url).toBe('http://example.org/ext/compose-param');

      // nested extensions
      expect(result.compose.extension[0].extension).toHaveLength(2);
      expect(result.compose.extension[0].extension[0].url).toBe('name');
      expect(result.compose.extension[0].extension[0].valueCode).toBe('displayLanguage');
      expect(result.compose.extension[0].extension[1].url).toBe('value');
      expect(result.compose.extension[0].extension[1].valueCode).toBe('de');

      // include should still be there
      expect(result.compose.include).toHaveLength(1);
    });
  });

  describe('Primitive Extensions', () => {

    test('should parse primitive extension with no value', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ValueSet xmlns="http://hl7.org/fhir">
  <url value="http://example.org/fhir/ValueSet/prim-ext"/>
  <name value="PrimitiveExtValueSet"/>
  <status value="active"/>
  <compose>
    <include>
      <system value="http://example.org/CodeSystem/test"/>
      <filter>
        <property value="concept"/>
        <op value="is-a"/>
        <value>
          <extension url="http://hl7.org/fhir/StructureDefinition/data-absent-reason">
            <valueCode value="not-applicable"/>
          </extension>
        </value>
      </filter>
    </include>
  </compose>
</ValueSet>`;

      const result = ValueSetXML.fromXml(xml, 5);

      // filter.value should be null/undefined and _value should have extension
      expect(result.compose.include[0].filter[0].value).toBeUndefined();
      expect(result.compose.include[0].filter[0]._value).toBeDefined();
      expect(result.compose.include[0].filter[0]._value.extension).toHaveLength(1);
      expect(result.compose.include[0].filter[0]._value.extension[0].url).toBe('http://hl7.org/fhir/StructureDefinition/data-absent-reason');
      expect(result.compose.include[0].filter[0]._value.extension[0].valueCode).toBe('not-applicable');
    });
  });
});

describe('ParametersXML', () => {

  const simpleParametersXml = `<?xml version="1.0" encoding="UTF-8"?>
<Parameters xmlns="http://hl7.org/fhir">
  <parameter>
    <name value="url"/>
    <valueUri value="http://example.org/ValueSet/test"/>
  </parameter>
  <parameter>
    <name value="count"/>
    <valueInteger value="100"/>
  </parameter>
  <parameter>
    <name value="active"/>
    <valueBoolean value="true"/>
  </parameter>
</Parameters>`;

  const parametersWithResourceXml = `<?xml version="1.0" encoding="UTF-8"?>
<Parameters xmlns="http://hl7.org/fhir">
  <parameter>
    <name value="tx-resource"/>
    <resource>
      <CodeSystem xmlns="http://hl7.org/fhir">
        <url value="http://example.org/CodeSystem/embedded"/>
        <name value="EmbeddedCodeSystem"/>
        <status value="active"/>
        <concept>
          <code value="A"/>
          <display value="Concept A"/>
        </concept>
      </CodeSystem>
    </resource>
  </parameter>
</Parameters>`;

  const parametersWithPartsXml = `<?xml version="1.0" encoding="UTF-8"?>
<Parameters xmlns="http://hl7.org/fhir">
  <parameter>
    <name value="result"/>
    <part>
      <name value="code"/>
      <valueCode value="ABC"/>
    </part>
    <part>
      <name value="display"/>
      <valueString value="ABC Display"/>
    </part>
  </parameter>
</Parameters>`;

  describe('fromXml', () => {

    test('should parse simple parameters', () => {
      const result = ParametersXML.fromXml(simpleParametersXml, 5);

      expect(result.resourceType).toBe('Parameters');
      expect(result.parameter).toHaveLength(3);

      expect(result.parameter[0].name).toBe('url');
      expect(result.parameter[0].valueUri).toBe('http://example.org/ValueSet/test');

      expect(result.parameter[1].name).toBe('count');
      expect(result.parameter[1].valueInteger).toBe(100);

      expect(result.parameter[2].name).toBe('active');
      expect(result.parameter[2].valueBoolean).toBe(true);
    });

    test('should parse embedded resource', () => {
      const result = ParametersXML.fromXml(parametersWithResourceXml, 5);

      expect(result.parameter[0].name).toBe('tx-resource');
      expect(result.parameter[0].resource).toBeDefined();
      expect(result.parameter[0].resource.resourceType).toBe('CodeSystem');
      expect(result.parameter[0].resource.url).toBe('http://example.org/CodeSystem/embedded');
      expect(result.parameter[0].resource.concept).toHaveLength(1);
      expect(result.parameter[0].resource.concept[0].code).toBe('A');
    });

    test('should parse nested parts', () => {
      const result = ParametersXML.fromXml(parametersWithPartsXml, 5);

      expect(result.parameter[0].name).toBe('result');
      expect(result.parameter[0].part).toHaveLength(2);
      expect(result.parameter[0].part[0].name).toBe('code');
      expect(result.parameter[0].part[0].valueCode).toBe('ABC');
      expect(result.parameter[0].part[1].name).toBe('display');
      expect(result.parameter[0].part[1].valueString).toBe('ABC Display');
    });

    test('should parse complex valueCodeableConcept with coding array', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Parameters xmlns="http://hl7.org/fhir">
  <parameter>
    <name value="result"/>
    <valueCodeableConcept>
      <coding>
        <system value="http://example.org"/>
        <code value="ABC"/>
      </coding>
    </valueCodeableConcept>
  </parameter>
</Parameters>`;

      const result = ParametersXML.fromXml(xml, 5);

      expect(result.parameter[0].valueCodeableConcept).toBeDefined();
      expect(result.parameter[0].valueCodeableConcept.coding).toHaveLength(1);
      expect(result.parameter[0].valueCodeableConcept.coding[0].system).toBe('http://example.org');
      expect(result.parameter[0].valueCodeableConcept.coding[0].code).toBe('ABC');
    });
  });

  describe('toXml', () => {

    test('should generate valid XML', () => {
      const json = {
        resourceType: 'Parameters',
        parameter: [
          { name: 'url', valueUri: 'http://example.org/test' },
          { name: 'active', valueBoolean: true }
        ]
      };

      const xml = ParametersXML.toXml(json, 5);

      expect(xml).toContain('<Parameters xmlns="http://hl7.org/fhir">');
      expect(xml).toContain('<name value="url"/>');
      expect(xml).toContain('<valueUri value="http://example.org/test"/>');
      expect(xml).toContain('<valueBoolean value="true"/>');
    });
  });
});

describe('OperationOutcomeXML', () => {

  const simpleOutcomeXml = `<?xml version="1.0" encoding="UTF-8"?>
<OperationOutcome xmlns="http://hl7.org/fhir">
  <issue>
    <severity value="error"/>
    <code value="invalid"/>
    <diagnostics value="Invalid code"/>
  </issue>
</OperationOutcome>`;

  const multiIssueOutcomeXml = `<?xml version="1.0" encoding="UTF-8"?>
<OperationOutcome xmlns="http://hl7.org/fhir">
  <issue>
    <severity value="error"/>
    <code value="invalid"/>
    <diagnostics value="First error"/>
  </issue>
  <issue>
    <severity value="warning"/>
    <code value="informational"/>
    <diagnostics value="A warning"/>
  </issue>
</OperationOutcome>`;

  describe('fromXml', () => {

    test('should parse simple OperationOutcome', () => {
      const result = OperationOutcomeXML.fromXml(simpleOutcomeXml, 5);

      expect(result.resourceType).toBe('OperationOutcome');
      expect(result.issue).toHaveLength(1);
      expect(result.issue[0].severity).toBe('error');
      expect(result.issue[0].code).toBe('invalid');
      expect(result.issue[0].diagnostics).toBe('Invalid code');
    });

    test('should parse multiple issues', () => {
      const result = OperationOutcomeXML.fromXml(multiIssueOutcomeXml, 5);

      expect(result.issue).toHaveLength(2);
      expect(result.issue[0].severity).toBe('error');
      expect(result.issue[1].severity).toBe('warning');
    });
  });

  describe('toXml', () => {

    test('should generate valid XML with correct element order', () => {
      const json = {
        resourceType: 'OperationOutcome',
        issue: [
          {
            severity: 'error',
            code: 'invalid',
            diagnostics: 'Test error'
          }
        ]
      };

      const xml = OperationOutcomeXML.toXml(json, 5);

      expect(xml).toContain('<OperationOutcome xmlns="http://hl7.org/fhir">');
      expect(xml).toContain('<severity value="error"/>');
      expect(xml).toContain('<code value="invalid"/>');

      // Check element order: severity should come before code
      const severityIndex = xml.indexOf('<severity');
      const codeIndex = xml.indexOf('<code');
      expect(severityIndex).toBeLessThan(codeIndex);
    });
  });
});

describe('ConceptMapXML', () => {

  const simpleConceptMapXml = `<?xml version="1.0" encoding="UTF-8"?>
<ConceptMap xmlns="http://hl7.org/fhir">
  <url value="http://example.org/fhir/ConceptMap/test"/>
  <name value="TestConceptMap"/>
  <status value="active"/>
  <group>
    <source value="http://example.org/source"/>
    <target value="http://example.org/target"/>
    <element>
      <code value="A"/>
      <target>
        <code value="X"/>
        <relationship value="equivalent"/>
      </target>
    </element>
  </group>
</ConceptMap>`;

  describe('fromXml', () => {

    test('should parse simple ConceptMap', () => {
      const result = ConceptMapXML.fromXml(simpleConceptMapXml, 5);

      expect(result.resourceType).toBe('ConceptMap');
      expect(result.url).toBe('http://example.org/fhir/ConceptMap/test');
      expect(result.group).toHaveLength(1);
      expect(result.group[0].source).toBe('http://example.org/source');
      expect(result.group[0].element).toHaveLength(1);
      expect(result.group[0].element[0].code).toBe('A');
      expect(result.group[0].element[0].target).toHaveLength(1);
      expect(result.group[0].element[0].target[0].code).toBe('X');
    });
  });
});