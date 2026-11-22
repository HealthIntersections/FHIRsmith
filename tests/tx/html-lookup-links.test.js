/**
 * Codes in a $lookup response, linked to $lookup on them.
 *
 * Which values are linkable follows from the response alone, and from where they sit in
 * it. A Coding says which code system it is in. A bare code does not - but
 * CodeSystem.property.type of 'code' is defined as a concept in the same code system, so
 * a property's value part that came back as a code belongs to the system the response is
 * about, which the response names in its system and version parameters.
 *
 * Position matters as much as type, because the core response has codes in it that are
 * not concepts at all: the code part of a property is the property's NAME, and a
 * designation's language and status are codes from other vocabularies entirely. Linking
 * by type alone would turn "en-AU" into a link to a SNOMED concept.
 *
 * And a declared type is not a promise. cs-icd11 declares classKind as a code and then
 * puts chapter|block|window|category in it, none of which is an ICD-11 concept, so the
 * code is checked against the code system before it is offered as a link.
 */

const { TxHtmlRenderer } = require('../../tx/tx-html');

const SCT = 'http://snomed.info/sct';
const INTL = SCT + '/900000000000207008/version/20250201';

// The concepts this fake code system has; anything else does not resolve.
const CONCEPTS = { '40541001': 'Acute pulmonary oedema', '64572001': 'Disease', '900000000000003001': '' };

const THO = 'http://terminology.hl7.org/CodeSystem/hl7TermMaintInfra';

// The code systems this fake server has: SNOMED CT (by default with CONCEPTS) and the
// THO designation-use code system; anything else it doesn't have
function build(known = CONCEPTS) {
  const asked = [];
  const built = [];
  const systems = { [SCT]: known, [THO]: { preferredForLanguage: 'Preferred For Language' } };
  const linkResolver = {
    codeChecker: async (opContext, system) => {
      built.push(system);
      const concepts = systems[system];
      return concepts ? async (code) => {
        asked.push(code);
        return Object.prototype.hasOwnProperty.call(concepts, code) ? concepts[code] : null;
      } : null;
    },
    lookupLink: (system, version, code) => '/tx/r4/CodeSystem/$lookup?system='
      + encodeURIComponent(system) + (version ? '&version=' + encodeURIComponent(version) : '')
      + '&code=' + encodeURIComponent(code)
  };
  const html = new TxHtmlRenderer({ linkResolver, opContext: {} }, null, null, null, '/tx/r4');
  return { html, asked, built };
}

function lookupResponse(...extra) {
  return {
    resourceType: 'Parameters',
    parameter: [
      { name: 'name', valueString: 'SNOMED CT' },
      { name: 'code', valueCode: '40541001' },
      { name: 'system', valueUri: SCT },
      { name: 'version', valueString: INTL },
      { name: 'display', valueString: 'Acute pulmonary oedema' },
      ...extra
    ]
  };
}

const property = (code, valueKey, value, extraParts = []) => ({
  name: 'property',
  part: [{ name: 'code', valueCode: code }, { name: 'value', [valueKey]: value }, ...extraParts]
});

describe('$lookup output', () => {
  test('links a property whose value is a code in the code system', async () => {
    const { html } = build();
    const out = await html.renderParameters(lookupResponse(property('parent', 'valueCode', '64572001')));
    expect(out).toContain('href="/tx/r4/CodeSystem/$lookup?system=http%3A%2F%2Fsnomed.info%2Fsct&amp;version='
      + encodeURIComponent(INTL) + '&amp;code=64572001"');
    expect(out).toContain('title="Disease"');
  });

  test('does not link the property name, which is also a code', async () => {
    const { html, asked } = build();
    await html.renderParameters(lookupResponse(property('parent', 'valueCode', '64572001')));
    expect(asked).toEqual(['64572001']);
  });

  test('does not link a designation language or status', async () => {
    const { html, asked } = build();
    const out = await html.renderParameters(lookupResponse({
      name: 'designation',
      part: [
        { name: 'language', valueCode: 'en-AU' },
        { name: 'status', valueCode: 'deprecated' },
        { name: 'value', valueString: 'Acute pulmonary oedema' }
      ]
    }));
    expect(asked).toEqual([]);
    expect(out).not.toContain('code=en-AU');
  });

  test('does not link a property value that is not a code', async () => {
    const { html, asked } = build();
    const out = await html.renderParameters(lookupResponse(property('effectiveTime', 'valueString', '20250201')));
    expect(asked).toEqual([]);
    expect(out).not.toContain('<a ');
  });

  test('leaves a code that is not in the code system as text - ICD-11 classKind', async () => {
    const { html, asked } = build();
    const out = await html.renderParameters(lookupResponse(property('classKind', 'valueCode', 'category')));
    expect(asked).toEqual(['category']);
    expect(out).not.toContain('<a ');
    expect(out).toContain('<code>category</code>');
  });

  test('links a coding in the same code system - a designation use', async () => {
    const { html } = build();
    const out = await html.renderParameters(lookupResponse({
      name: 'designation',
      part: [
        { name: 'use', valueCoding: { system: SCT, code: '900000000000003001', display: 'Fully specified name' } },
        { name: 'value', valueString: 'Acute pulmonary oedema (disorder)' }
      ]
    }));
    expect(out).toContain('&amp;code=900000000000003001"');
  });

  test('leaves a coding from somewhere else as text', async () => {
    const { html, asked } = build();
    const out = await html.renderParameters(lookupResponse({
      name: 'property',
      part: [
        { name: 'code', valueCode: 'something' },
        { name: 'value', valueCoding: { system: 'http://loinc.org', code: '1234-5' } }
      ]
    }));
    expect(asked).toEqual([]);
    expect(out).toContain('<code>1234-5</code>');
    expect(out).not.toContain('code=1234-5"');
  });

  test('renders normally when the server does not have the code system', async () => {
    const { html } = build();
    html.renderer.linkResolver.codeChecker = async () => null;
    const out = await html.renderParameters(lookupResponse(property('parent', 'valueCode', '64572001')));
    expect(out).toContain('<code>64572001</code>');
    expect(out).not.toContain('<a ');
  });

  test('renders normally for a Parameters that names no code system', async () => {
    const { html, asked } = build();
    const out = await html.renderParameters({
      resourceType: 'Parameters',
      parameter: [{ name: 'result', valueBoolean: true }]
    });
    expect(asked).toEqual([]);
    expect(out).toContain('true');
  });
});

describe('$lookup properties and designations tables', () => {
  const designation = (parts) => ({ name: 'designation', part: parts });

  test('pulls properties and designations out of the main table into their own tables', async () => {
    const { html } = build();
    const out = await html.renderParameters(lookupResponse(
      designation([
        { name: 'language', valueCode: 'en' },
        { name: 'use', valueCoding: { system: SCT, code: '900000000000003001', display: 'Fully specified name' } },
        { name: 'value', valueString: 'Acute pulmonary oedema (disorder)' }
      ]),
      property('parent', 'valueCode', '64572001'),
      property('inactive', 'valueBoolean', false)
    ));
    const main = out.substring(0, out.indexOf('</table>'));
    expect(main).toContain('Acute pulmonary oedema');
    expect(main).not.toContain('>property<');
    expect(main).not.toContain('>designation<');
    expect(main).not.toContain('<ul>');

    expect(out).toContain('<h3>Properties</h3>');
    expect(out).toContain('<h3>Designations</h3>');
    // Properties first, then designations, both after the main table
    expect(out.indexOf('<h3>Properties</h3>')).toBeGreaterThan(out.indexOf('</table>'));
    expect(out.indexOf('<h3>Designations</h3>')).toBeGreaterThan(out.indexOf('<h3>Properties</h3>'));

    const props = out.substring(out.indexOf('<h3>Properties</h3>'), out.indexOf('<h3>Designations</h3>'));
    expect(props).toContain('<th scope="col">code</th><th scope="col">value</th>');
    expect((props.match(/<tr>/g) || []).length).toBe(3); // header + 2 rows
    expect(props).toContain('<td><code>parent</code></td>');
    expect(props).toContain('code=64572001"'); // still linked
    expect(props).toContain('<td>false</td>');

    const desigs = out.substring(out.indexOf('<h3>Designations</h3>'));
    expect(desigs).toContain('<th scope="col">language</th><th scope="col">use</th><th scope="col">value</th>');
    expect(desigs).toContain('<td><code>en</code></td>');
  });

  test('a column for every part name, empty where a row does not have it', async () => {
    const { html } = build();
    const out = await html.renderParameters(lookupResponse(
      property('parent', 'valueCode', '64572001'),
      property('note', 'valueString', 'a note', [{ name: 'description', valueString: 'A note' }])
    ));
    const props = out.substring(out.indexOf('<h3>Properties</h3>'));
    expect(props).toContain('<th scope="col">code</th><th scope="col">value</th><th scope="col">description</th>');
    expect(props).toMatch(/<td><code>parent<\/code><\/td><td>.*?<\/td><td><\/td><\/tr>/);
    expect(props).toContain('<td>A note</td>');
  });

  test('repeated parts share a cell, and subproperties keep their links', async () => {
    const { html } = build();
    const out = await html.renderParameters(lookupResponse(
      designation([
        { name: 'value', valueString: 'x' },
        { name: 'additionalUse', valueCoding: { system: 'http://example.org', code: 'a' } },
        { name: 'additionalUse', valueCoding: { system: 'http://example.org', code: 'b' } }
      ]),
      property('group', 'valueString', '1', [{
        name: 'subproperty',
        part: [{ name: 'code', valueCode: 'attr' }, { name: 'value', valueCode: '64572001' }]
      }])
    ));
    const desigs = out.substring(out.indexOf('<h3>Designations</h3>'));
    expect(desigs).toMatch(/<code>a<\/code>.*<br\/>.*<code>b<\/code>/);
    const props = out.substring(out.indexOf('<h3>Properties</h3>'), out.indexOf('<h3>Designations</h3>'));
    expect(props).toContain('<th scope="col">subproperty</th>');
    expect(props).toContain('code=64572001"');
  });

  test('no tables when there are no properties or designations', async () => {
    const { html } = build();
    const out = await html.renderParameters(lookupResponse());
    expect(out).not.toContain('<h3>Properties</h3>');
    expect(out).not.toContain('<h3>Designations</h3>');
  });
});

describe('$lookup codings in other code systems, and the name parameter', () => {
  const use = (system, code) => ({
    name: 'designation',
    part: [
      { name: 'language', valueCode: 'en' },
      { name: 'use', valueCoding: { system, code } },
      { name: 'value', valueString: 'Acute pulmonary oedema' }
    ]
  });

  test('links a designation use from another code system the server has', async () => {
    const { html } = build();
    const out = await html.renderParameters(lookupResponse(use(THO, 'preferredForLanguage')));
    expect(out).toContain('<a href="/tx/r4/CodeSystem/$lookup?system=' + encodeURIComponent(THO)
      + '&amp;code=preferredForLanguage" title="' + THO + '#preferredForLanguage">Preferred For Language</a>');
  });

  test('a designation use is shown as its display, linked, with the system and code in its title', async () => {
    const { html } = build();
    const out = await html.renderParameters(lookupResponse({
      name: 'designation',
      part: [
        { name: 'use', valueCoding: { system: SCT, code: '900000000000003001', display: 'Fully specified name' } },
        { name: 'value', valueString: 'Acute pulmonary oedema (disorder)' }
      ]
    }));
    const desigs = out.substring(out.indexOf('<h3>Designations</h3>'));
    expect(desigs).toContain('title="' + SCT + '#900000000000003001">Fully specified name</a>');
    expect(desigs).not.toContain(SCT + ' |');
    expect(desigs).not.toContain('<code>900000000000003001</code>');
  });

  test('a designation use that can\'t be linked is still shown as its display', async () => {
    const { html } = build();
    const out = await html.renderParameters(lookupResponse(
      { name: 'designation', part: [{ name: 'use', valueCoding: { system: 'http://loinc.org', code: 'LONG_COMMON_NAME', display: 'LONG_COMMON_NAME' } }, { name: 'value', valueString: 'x' }] }));
    expect(out).toContain('<span title="http://loinc.org#LONG_COMMON_NAME">LONG_COMMON_NAME</span>');
    expect(out).not.toContain('code=LONG_COMMON_NAME');
  });

  test('builds each code system\'s checker once for the page', async () => {
    const { html, built } = build();
    await html.renderParameters(lookupResponse(use(THO, 'preferredForLanguage'), use(THO, 'preferredForLanguage'),
      use('http://loinc.org', 'x'), use('http://loinc.org', 'y')));
    expect(built.sort()).toEqual(['http://loinc.org', SCT, THO].sort());
  });

  test('a coding from another code system is linked only if the code is in it', async () => {
    const { html } = build();
    const out = await html.renderParameters(lookupResponse(use(THO, 'noSuchUse')));
    expect(out).toContain('<code>noSuchUse</code>');
    expect(out).not.toContain('code=noSuchUse');
  });

  test('links codings in other code systems when the server does not have the response\'s', async () => {
    const { html } = build();
    const response = lookupResponse(use(THO, 'preferredForLanguage'));
    response.parameter.find((p) => p.name === 'system').valueUri = 'http://example.org/unknown';
    const out = await html.renderParameters(response);
    expect(out).toContain('&amp;code=preferredForLanguage"');
  });

  test('the name parameter of a $lookup response is shown as Code System name', async () => {
    const { html } = build();
    const out = await html.renderParameters(lookupResponse());
    expect(out).toContain('<td>Code System name</td><td>SNOMED CT</td>');
    expect(out).not.toContain('<td>name</td>');
  });

  test('a name parameter in other Parameters keeps its name', async () => {
    const { html } = build();
    const out = await html.renderParameters({ resourceType: 'Parameters', parameter: [{ name: 'name', valueString: 'x' }] });
    expect(out).toContain('<td>name</td>');
  });
});
