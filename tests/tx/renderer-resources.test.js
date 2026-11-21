const { Renderer } = require('../../tx/library/renderer');
const { TxHtmlRenderer } = require('../../tx/tx-html');
const { OperationContext } = require('../../tx/operation-context');
const { Languages } = require('../../library/languages');
const { TestUtilities } = require('../test-utilities');

/**
 * These tests cover every resource type the renderer supports, plus the
 * tx-html dispatch layer. They exercise valid rendering AND illegal-input
 * corner cases (bad dates, codes, enums, filter ops, relationships, malformed
 * structure). For illegal input the key assertion is that the error IDENTIFIES
 * THE OFFENDING VALUE — not just that it throws.
 */

let renderer;
let txHtml;

beforeAll(async () => {
  const langDefs = await TestUtilities.loadLanguageDefinitions();
  const i18n = await TestUtilities.loadTranslations(langDefs);
  const opContext = new OperationContext(Languages.fromAcceptLanguage('en-US', langDefs), i18n);
  renderer = new Renderer(opContext);
  txHtml = new TxHtmlRenderer(renderer, null, Languages.fromAcceptLanguage('en-US', langDefs), i18n, null);
});

/**
 * Assert that calling `fn` rejects with an InvalidError whose message contains
 * every one of `expected` substrings (used to confirm the offending value and
 * its location are named).
 */
async function expectInvalid(fn, expected) {
  let err;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeDefined();
  expect(err.name).toBe('InvalidError');
  for (const s of expected) {
    expect(err.message).toContain(s);
  }
  return err;
}

// ─── Valid rendering smoke tests for every supported type ────────────────────

describe('Renderer — valid rendering of all supported resource types', () => {
  test('CodeSystem renders to non-empty HTML', async () => {
    const html = await renderer.renderCodeSystem({
      resourceType: 'CodeSystem', url: 'http://example.org/cs', status: 'active',
      content: 'complete', name: 'Example',
      concept: [{ code: 'a', display: 'Alpha' }, { code: 'b', display: 'Beta' }]
    });
    expect(typeof html).toBe('string');
    expect(html).toContain('Alpha');
    expect(html).toContain('a');
  });

  test('ValueSet (compose) renders to non-empty HTML', async () => {
    const html = await renderer.renderValueSet({
      resourceType: 'ValueSet', url: 'http://example.org/vs', status: 'active',
      compose: { include: [{ system: 'http://example.org/cs', concept: [{ code: 'a', display: 'Alpha' }] }] }
    });
    expect(html).toContain('Alpha');
  });

  test('ConceptMap renders to non-empty HTML', async () => {
    const html = await renderer.renderConceptMap({
      resourceType: 'ConceptMap', url: 'http://example.org/cm', status: 'active',
      group: [{ source: 'http://s', target: 'http://t',
        element: [{ code: 'a', target: [{ code: 'b', relationship: 'equivalent' }] }] }]
    });
    expect(typeof html).toBe('string');
    expect(html.length).toBeGreaterThan(0);
  });

  test('CapabilityStatement renders to non-empty HTML', async () => {
    const html = await renderer.renderCapabilityStatement({
      resourceType: 'CapabilityStatement', status: 'active'
    });
    expect(typeof html).toBe('string');
    expect(html.length).toBeGreaterThan(0);
  });

  test('TerminologyCapabilities renders to non-empty HTML', async () => {
    const html = await renderer.renderTerminologyCapabilities({
      resourceType: 'TerminologyCapabilities', status: 'active'
    });
    expect(typeof html).toBe('string');
    expect(html.length).toBeGreaterThan(0);
  });

  test('lastUpdated is formatted and the {0} placeholder is substituted', async () => {
    const html = await renderer.renderCodeSystem({
      resourceType: 'CodeSystem', url: 'http://x', status: 'active', content: 'complete',
      meta: { lastUpdated: '2024-03-15T10:30:00Z' }
    });
    expect(html).not.toContain('{0}');     // the bug we fixed
    expect(html).toContain('March');       // localised date actually rendered
  });

  test('wrapper objects exposing .json are unwrapped', async () => {
    const html = await renderer.renderCodeSystem({
      json: { resourceType: 'CodeSystem', url: 'http://x', status: 'active', content: 'complete' }
    });
    expect(typeof html).toBe('string');
  });
});

// ─── CodeSystem corner cases ─────────────────────────────────────────────────

describe('Renderer.renderCodeSystem — illegal input', () => {
  test('null resource names the problem', () =>
    expectInvalid(() => renderer.renderCodeSystem(null), ['renderCodeSystem', 'null']));

  test('undefined resource names the problem', () =>
    expectInvalid(() => renderer.renderCodeSystem(undefined), ['renderCodeSystem', 'undefined']));

  test('wrong resourceType names the actual type', () =>
    expectInvalid(() => renderer.renderCodeSystem({ resourceType: 'ValueSet' }),
      ['CodeSystem', 'ValueSet']));

  test('illegal status names the bad value', () =>
    expectInvalid(() => renderer.renderCodeSystem({ resourceType: 'CodeSystem', status: 'wat', content: 'complete' }),
      ['status', 'wat']));

  test('illegal content names the bad value', () =>
    expectInvalid(() => renderer.renderCodeSystem({ resourceType: 'CodeSystem', content: 'BOGUS' }),
      ['content', 'BOGUS']));

  test('non-string concept code names the bad value and path', () =>
    expectInvalid(() => renderer.renderCodeSystem({
      resourceType: 'CodeSystem', status: 'active', content: 'complete',
      concept: [{ code: { nope: 1 }, display: 'A' }]
    }), ['CodeSystem.concept.code', 'nope']));

  test('illegal lastUpdated date names the bad value', () =>
    expectInvalid(() => renderer.renderCodeSystem({
      resourceType: 'CodeSystem', status: 'active', content: 'complete',
      meta: { lastUpdated: '2024-13-45' }
    }), ['date', 'meta.lastUpdated', '2024-13-45']));
});

// ─── ValueSet corner cases ───────────────────────────────────────────────────

describe('Renderer.renderValueSet — illegal input', () => {
  test('null resource names the problem', () =>
    expectInvalid(() => renderer.renderValueSet(null), ['renderValueSet', 'null']));

  test('illegal status names the bad value', () =>
    expectInvalid(() => renderer.renderValueSet({ resourceType: 'ValueSet', status: 'nope' }),
      ['status', 'nope']));

  test('illegal filter operator names the bad op and path', () =>
    expectInvalid(() => renderer.renderValueSet({
      resourceType: 'ValueSet', status: 'active',
      compose: { include: [{ system: 'http://y', filter: [{ property: 'p', op: 'BOGUS', value: 'v' }] }] }
    }), ['filter.op', 'BOGUS']));

  test('empty include (no system, no valueSet) names the include', () =>
    expectInvalid(() => renderer.renderValueSet({
      resourceType: 'ValueSet', status: 'active', compose: { include: [{}] }
    }), ['ValueSet.compose.include']));

  test('non-string concept code in include names the bad value', () =>
    expectInvalid(() => renderer.renderValueSet({
      resourceType: 'ValueSet', status: 'active',
      compose: { include: [{ system: 'http://y', concept: [{ code: 42 }] }] }
    }), ['concept.code', '42']));
});

// ─── ConceptMap corner cases ─────────────────────────────────────────────────

describe('Renderer.renderConceptMap — illegal input', () => {
  test('null resource names the problem', () =>
    expectInvalid(() => renderer.renderConceptMap(null), ['renderConceptMap', 'null']));

  test('illegal relationship names the bad value', () =>
    expectInvalid(() => renderer.renderConceptMap({
      resourceType: 'ConceptMap', status: 'active',
      group: [{ source: 'http://s', target: 'http://t',
        element: [{ code: 'a', target: [{ code: 'b', relationship: 'BOGUS' }] }] }]
    }), ['relationship', 'BOGUS']));

  test('illegal (legacy) equivalence names the bad value', () =>
    expectInvalid(() => renderer.renderConceptMap({
      resourceType: 'ConceptMap', status: 'active',
      group: [{ source: 'http://s', target: 'http://t',
        element: [{ code: 'a', target: [{ code: 'b', equivalence: 'BOGUS' }] }] }]
    }), ['equivalence', 'BOGUS']));
});

// ─── CapabilityStatement / TerminologyCapabilities corner cases ──────────────

describe('Renderer — CapabilityStatement / TerminologyCapabilities illegal input', () => {
  test('CapabilityStatement null names the problem', () =>
    expectInvalid(() => renderer.renderCapabilityStatement(null),
      ['renderCapabilityStatement', 'null']));

  test('CapabilityStatement illegal status names the bad value', () =>
    expectInvalid(() => renderer.renderCapabilityStatement({ resourceType: 'CapabilityStatement', status: 'zzz' }),
      ['status', 'zzz']));

  test('TerminologyCapabilities null names the problem', () =>
    expectInvalid(() => renderer.renderTerminologyCapabilities(null),
      ['renderTerminologyCapabilities', 'null']));

  test('TerminologyCapabilities illegal status names the bad value', () =>
    expectInvalid(() => renderer.renderTerminologyCapabilities({ resourceType: 'TerminologyCapabilities', status: 'zzz' }),
      ['status', 'zzz']));
});

// ─── tx-html dispatch layer ──────────────────────────────────────────────────

describe('TxHtmlRenderer.render — dispatch guards', () => {
  const req = { path: '/CodeSystem/x', query: {} };

  test('null resource is reported, not a generic crash', () =>
    expectInvalid(() => txHtml.render(null, req), ['Cannot render', 'null']));

  test('non-object resource is reported', () =>
    expectInvalid(() => txHtml.render('a string', req), ['Cannot render', 'string']));

  test('missing resourceType is reported', () =>
    expectInvalid(() => txHtml.render({ url: 'http://x' }, req), ['resourceType']));

  test('empty resourceType is reported', () =>
    expectInvalid(() => txHtml.render({ resourceType: '' }, req), ['resourceType']));
});

// ─── displayDate is unaffected (still lenient for low-level formatting) ───────

describe('displayDate remains lenient (separate from resource validation)', () => {
  test('illegal date returned unchanged by the low-level formatter', () => {
    expect(renderer.displayDate('2024-13-45')).toBe('2024-13-45');
  });
});

// ─── Parameters primitive value rendering (valueId etc.) ─────────────────────

describe('Parameters value rendering covers id-family primitives', () => {
  test('valueId is rendered, not shown as (empty) - the cache-id case', async () => {
    const html = await txHtml.renderParameters({
      resourceType: 'Parameters',
      parameter: [{ name: 'cache-id', valueId: '70995493-fd31-477e-b570-e0a2b3275bb5' }]
    });
    expect(html).toContain('70995493-fd31-477e-b570-e0a2b3275bb5');
    expect(html).not.toContain('(empty)');
  });

  test('renders the other id-family / numeric primitives', async () => {
    const cases = [
      { name: 'oid', valueOid: 'urn:oid:1.2.3' , expect: 'urn:oid:1.2.3' },
      { name: 'uuid', valueUuid: 'urn:uuid:abc', expect: 'urn:uuid:abc' },
      { name: 'i64', valueInteger64: '9007199254740993', expect: '9007199254740993' },
      { name: 'pos', valuePositiveInt: 5, expect: '5' },
      { name: 'uns', valueUnsignedInt: 0, expect: '0' }
    ];
    for (const c of cases) {
      const html = await txHtml.renderParameters({ resourceType: 'Parameters', parameter: [c] });
      expect(html).toContain(c.expect);
      expect(html).not.toContain('(empty)');
    }
  });

  test('valueMarkdown is rendered as HTML (consistent with the rest of the server)', async () => {
    const html = await txHtml.renderParameters({
      resourceType: 'Parameters',
      parameter: [{ name: 'doc', valueMarkdown: 'see **the docs** for details' }]
    });
    // The rendered table cell contains real HTML (the JSON-source block below the
    // table still echoes the raw markdown, so we only assert the rendered form).
    expect(html).toContain('<strong>the docs</strong>');
    expect(html).not.toContain('(empty)');
  });

  test('valueMarkdown rendering is XSS-safe (raw HTML escaped)', async () => {
    const html = await txHtml.renderParameters({
      resourceType: 'Parameters',
      parameter: [{ name: 'doc', valueMarkdown: 'hi <script>alert(1)</script>' }]
    });
    expect(html).not.toContain('<script>alert(1)</script>');
  });
});
