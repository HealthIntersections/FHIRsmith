/**
 * The HTML page of a value set lists the first 500 codes of each include and links to the
 * same page with ?_showAll=true, which lists them all.
 */

const { TxHtmlRenderer } = require('../../tx/tx-html');
const { Renderer } = require('../../tx/library/renderer');

const big = (n) => ({
  resourceType: 'ValueSet',
  id: 'big',
  status: 'active',
  compose: {
    include: [{
      system: 'http://example.org/cs',
      concept: Array.from({ length: n }, (_, i) => ({ code: 'c' + i, display: 'Code ' + i })),
    }],
  },
});

function build() {
  const looked = [];
  const linkResolver = {
    resolveURL: async () => null,
    resolveCode: async () => null,
    resolveCodes: async (ctx, system, version, codes) => {
      looked.push(codes.length);
      return codes.map(() => null);
    },
  };
  const renderer = new Renderer({ i18n: { formatPhrase: (id) => id, formatPhrasePlural: (id) => id }, langs: null }, linkResolver);
  return { looked, html: new TxHtmlRenderer(renderer, null, null, null, '/tx/r4') };
}

// The page's own expansion needs a server; without one it reports an error, which is
// not what is being tested.
const get = (url) => {
  const query = Object.fromEntries(new URL(url, 'http://localhost').searchParams);
  return { method: 'GET', path: '/ValueSet/big', originalUrl: url, query };
};

const rows = (html) => (html.match(/<li>c\d+: /g) || []).length;

describe('value set page: show all codes', () => {
  test('by default, 500 codes and a link to this page with _showAll=true', async () => {
    const { looked, html } = build();
    const out = await html.render(big(33341), get('/tx/r4/ValueSet/big?_format=html&lang=en'));
    expect(rows(out)).toBe(500);
    expect(looked).toEqual([500]);
    expect(out).toContain('… and 32,841 more codes.</i> '
      + '<a href="/tx/r4/ValueSet/big?_format=html&amp;lang=en&amp;_showAll=true">Show all</a>');
  });

  test('_showAll=true lists every code', async () => {
    const { looked, html } = build();
    const out = await html.render(big(33341), get('/tx/r4/ValueSet/big?_format=html&_showAll=true'));
    expect(rows(out)).toBe(33341);
    expect(looked).toEqual([33341]);
    expect(out).not.toContain('more codes');
  });

  test('in a bundle, the link goes to the value set\'s own page', async () => {
    const { html } = build();
    const out = await html.render(big(600), get('/tx/r4/ValueSet?_format=html&_showAll=true'), true);
    expect(rows(out)).toBe(500);
    expect(out).toContain('<a href="/tx/r4/ValueSet/big?_format=html&amp;_showAll=true">Show all</a>');
  });

  test('a page that came from a POST says how many more, without a link', async () => {
    const { html } = build();
    const req = { ...get('/tx/r4/ValueSet/$expand?_format=html'), method: 'POST', path: '/ValueSet/$expand' };
    const out = await html.render(big(600), req);
    expect(out).toContain('… and 100 more codes.');
    expect(out).not.toContain('Show all');
  });

  test('a small value set is listed in full, with no extra line', async () => {
    const { html } = build();
    const out = await html.render(big(3), get('/tx/r4/ValueSet/big?_format=html'));
    expect(rows(out)).toBe(3);
    expect(out).not.toContain('more code');
  });
});
