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

function build(known = CONCEPTS) {
  const asked = [];
  const linkResolver = {
    codeChecker: async () => async (code) => {
      asked.push(code);
      return Object.prototype.hasOwnProperty.call(known, code) ? known[code] : null;
    },
    lookupLink: (system, version, code) => '/tx/r4/CodeSystem/$lookup?system='
      + encodeURIComponent(system) + (version ? '&version=' + encodeURIComponent(version) : '')
      + '&code=' + encodeURIComponent(code)
  };
  const html = new TxHtmlRenderer({ linkResolver, opContext: {} }, null, null, null, '/tx/r4');
  return { html, asked };
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
