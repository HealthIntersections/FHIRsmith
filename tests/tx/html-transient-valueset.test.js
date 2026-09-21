/**
 * Expansions of value sets that only existed for the request that carried them.
 *
 * The operations tab on a CodeSystem builds a value set in the browser and posts it to
 * $expand - that is how a text search and a filter are run, since neither is an operation
 * on a code system. Nobody but that one request ever sees the value set, so the usual
 * summary is worthless: a defining URL that is a uuid minted a moment ago, a status of
 * "active" that was never in question, and an expansion identifier that is another uuid.
 *
 * So those value sets carry a marker extension, and the marker changes what is rendered:
 * what was expanded and how, then - when the expansion came from a filter - the compose
 * as JSON, then the expansion itself.
 */

const { TxHtmlRenderer } = require('../../tx/tx-html');

const TRANSIENT = 'http://healthintersections.com.au/fhirsmith/StructureDefinition/valueset-transient';

function transient(compose, expansion) {
  return {
    resourceType: 'ValueSet',
    extension: [{ url: TRANSIENT, valueBoolean: true }],
    url: 'urn:uuid:bae70062-a2f7-4d67-946f-c485f5ca47dd',
    status: 'active',
    compose: compose,
    expansion: Object.assign({
      identifier: 'urn:uuid:62f8be6d-3724-4419-a341-0129d0980aa2',
      timestamp: '2026-09-21T05:29:51.032Z',
      total: 25
    }, expansion)
  };
}

const SEARCH = transient(
  { include: [{ system: 'http://snomed.info/sct', version: 'http://snomed.info/sct/32506021000036107/version/20260430' }] },
  { parameter: [{ name: 'filter', valueString: 'diabetes' }] }
);

const FILTERED = transient(
  {
    include: [{
      system: 'http://snomed.info/sct',
      filter: [{ property: 'constraint', op: '=', value: '< 404684003' }]
    }]
  },
  {}
);

// The renderer proper is exercised elsewhere; here it only needs to report what it was
// handed, so that what this page strips before delegating can be asserted.
function build() {
  const seen = {};
  const html = new TxHtmlRenderer(
    { renderVSExpansion: (vs) => { seen.vs = vs; return '<div>EXPANSION</div>'; } },
    null, null, null, '/tx/r4');
  return { html, seen };
}

describe('a transient value set expansion', () => {
  test('does not show the uuid url, the status, or the expansion identifier', async () => {
    const { html, seen } = build();
    const out = await html.renderValueSet(SEARCH, false, undefined, true);
    const summary = out.substring(0, out.indexOf('Show JSON Source'));
    expect(summary).not.toContain('bae70062');
    expect(summary).not.toContain('62f8be6d');
    // and the renderer is not given them either, so it cannot put them back
    expect(seen.vs.url).toBeUndefined();
    expect(seen.vs.expansion.identifier).toBeUndefined();
    // without touching the outcome the client actually received
    expect(SEARCH.url).toBe('urn:uuid:bae70062-a2f7-4d67-946f-c485f5ca47dd');
    expect(SEARCH.expansion.identifier).toBe('urn:uuid:62f8be6d-3724-4419-a341-0129d0980aa2');
  });

  test('says what was expanded, and what was searched for', async () => {
    const { html } = build();
    const out = await html.renderValueSet(SEARCH, false, undefined, true);
    expect(out).toContain('http://snomed.info/sct/32506021000036107/version/20260430');
    expect(out).toContain('Text Search');
    expect(out).toContain('diabetes');
    expect(out).toContain('EXPANSION');
  });

  test('shows the compose as JSON when the expansion came from filters', async () => {
    const { html } = build();
    const out = await html.renderValueSet(FILTERED, false, undefined, true);
    expect(out).toContain('<h3>Filters</h3>');
    expect(out).toContain('&quot;constraint&quot;');
    expect(out).toContain('&lt; 404684003');
  });

  test('does not show a Filters block for a plain text search', async () => {
    const { html } = build();
    const out = await html.renderValueSet(SEARCH, false, undefined, true);
    expect(out).not.toContain('<h3>Filters</h3>');
  });

  test('keeps the raw resource one click away', async () => {
    const { html } = build();
    const out = await html.renderValueSet(SEARCH, false, undefined, true);
    expect(out).toContain('Show JSON Source');
    expect(out).toContain('bae70062');
  });

  test('titles the page for what it is', () => {
    const { html } = build();
    expect(html.buildTitle(SEARCH, { path: '/ValueSet/$expand' })).toBe('Expansion');
  });

  test('leaves an ordinary value set alone', async () => {
    const { html, seen } = build();
    html.renderer.renderValueSet = (vs) => { seen.plain = vs; return '<div>PLAIN</div>'; };
    const ordinary = {
      resourceType: 'ValueSet',
      url: 'http://hl7.org/fhir/ValueSet/administrative-gender',
      status: 'active',
      expansion: { identifier: 'urn:uuid:1', timestamp: '2026-09-21T05:29:51.032Z' }
    };
    const out = await html.renderValueSet(ordinary, false, undefined, true);
    expect(out).toContain('PLAIN');
    expect(seen.plain.url).toBe('http://hl7.org/fhir/ValueSet/administrative-gender');
  });
});
