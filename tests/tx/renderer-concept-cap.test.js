/**
 * A large code system as HTML: the concept table shows the first MAX_RENDERED_CONCEPTS concepts,
 * then says how many there are and links to the whole code system as JSON, and building it lets
 * other work run. ICD-10-CM's page (98,000 concepts, 24 MB) held the event loop for 5-6 s.
 *
 * The JSON and XML tabs show the same number of codes (capResourceCodes), with a link to the
 * whole resource in that format.
 */

const { Renderer, MAX_RENDERED_CONCEPTS } = require('../../tx/library/renderer');
const { capResourceCodes } = require('../../tx/tx-html');

function renderer() {
  const opContext = { i18n: { formatPhrase: (id) => id, translate: (id) => id }, langs: null };
  return new Renderer(opContext, null);
}

/** n top-level concepts, each with `kids` children */
function codeSystem(n, kids = 0) {
  return {
    resourceType: 'CodeSystem', id: 'big', url: 'http://example.org/cs', status: 'active', content: 'complete',
    concept: Array.from({ length: n }, (_, i) => {
      const c = { code: 'c' + i, display: 'Concept ' + i };
      if (kids > 0) {
        c.concept = Array.from({ length: kids }, (_, j) => ({ code: `c${i}.${j}`, display: `Child ${i}.${j}` }));
      }
      return c;
    })
  };
}

// the rows of the concept table, less its header row
const rows = (html) => {
  const table = html.substring(html.indexOf('class="codes"'));
  return (table.substring(0, table.indexOf('</table>')).match(/<tr/g) || []).length - 1;
};

describe('the HTML concept table', () => {
  test('the default is 1000 concepts', () => {
    expect(MAX_RENDERED_CONCEPTS).toBe(1000);
    expect(renderer().conceptLimit).toBe(1000);
  });

  test('a code system within the limit is shown whole, with no note', async () => {
    const html = await renderer().renderCodeSystem(codeSystem(10));
    expect(rows(html)).toBe(10);
    expect(html).not.toContain('This page shows the first');
  });

  test('a larger one stops at the limit, and links to the whole of it as JSON', async () => {
    const r = renderer();
    r.fullContentHref = '/tx/r4/CodeSystem/big?_format=json';
    const html = await r.renderCodeSystem(codeSystem(5000));
    expect(rows(html)).toBe(1000);
    expect(html).toContain('This page shows the first 1,000 of the 5,000 concepts.');
    expect(html).toContain('href="/tx/r4/CodeSystem/big?_format=json"');
    expect(html).toContain('c999');
    expect(html).not.toContain('>c1000<');
  });

  test('nested concepts count towards the limit, depth first', async () => {
    const r = renderer();
    r.conceptLimit = 10;
    const html = await r.renderCodeSystem(codeSystem(5, 3)); // 20 concepts in all
    expect(rows(html)).toBe(10);
    expect(html).toContain('This page shows the first 10 of the 20 concepts.');
    // c0, its 3 children, c1, its 3 children, c2 and its first child
    expect(html).toContain('c2.0');
    expect(html).not.toContain('c2.1');
  });

  test('with no limit, every concept is shown', async () => {
    const r = renderer();
    r.conceptLimit = null;
    expect(rows(await r.renderCodeSystem(codeSystem(1500)))).toBe(1500);
  });

  test('building a large table lets other work run', async () => {
    const r = renderer();
    r.conceptLimit = null;
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    try {
      await r.renderCodeSystem(codeSystem(20000));
    } finally {
      clearInterval(timer);
    }
    // a table this size takes well over 25 ms to build; without yielding the timer never runs
    expect(ticks).toBeGreaterThan(0);
  });
});

describe('capResourceCodes (the JSON and XML tabs)', () => {
  test('a resource within the limit comes back as it is', () => {
    const cs = codeSystem(10);
    const capped = capResourceCodes(cs, 1000);
    expect(capped.resource).toBe(cs);
    expect(capped).toMatchObject({ shown: 10, total: 10 });
  });

  test('a code system is cut to the limit, depth first, without changing the original', () => {
    const cs = codeSystem(5, 3);
    const capped = capResourceCodes(cs, 10);
    expect(capped).toMatchObject({ shown: 10, total: 20 });
    expect(capped.resource.concept.map(c => c.code)).toEqual(['c0', 'c1', 'c2']);
    expect(capped.resource.concept[2].concept.map(c => c.code)).toEqual(['c2.0']);
    expect(cs.concept.length).toBe(5);
    expect(cs.concept[2].concept.length).toBe(3);
  });

  test('a value set: its include concept lists and its expansion share the limit', () => {
    const vs = {
      resourceType: 'ValueSet', id: 'vs',
      compose: { include: [{ system: 'a', concept: Array.from({ length: 6 }, (_, i) => ({ code: 'a' + i })) },
        { system: 'b', concept: Array.from({ length: 6 }, (_, i) => ({ code: 'b' + i })) }] },
      expansion: { contains: Array.from({ length: 6 }, (_, i) => ({ system: 'a', code: 'x' + i })) }
    };
    const capped = capResourceCodes(vs, 8);
    expect(capped).toMatchObject({ shown: 8, total: 18 });
    expect(capped.resource.compose.include[0].concept.length).toBe(6);
    expect(capped.resource.compose.include[1].concept.length).toBe(2);
    expect(capped.resource.expansion.contains.length).toBe(0);
    expect(vs.compose.include[1].concept.length).toBe(6);
    expect(vs.expansion.contains.length).toBe(6);
  });

  test('other resources are not touched', () => {
    const cm = { resourceType: 'ConceptMap', group: [] };
    expect(capResourceCodes(cm, 1).resource).toBe(cm);
  });
});
