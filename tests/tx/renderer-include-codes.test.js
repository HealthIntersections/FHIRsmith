/**
 * A value set that lists its codes is rendered one row per code. VSAC's Medication Brand
 * Name lists 33,341 codes in one include, so by default an include shows its first
 * MAX_RENDERED_INCLUDE_CODES codes, then a line saying how many more there are, with a
 * link to the page that shows them all.
 *
 * The codes that are shown are looked up for a link and a description in one request to
 * the link resolver per include, not one request per code.
 */

const { Renderer, MAX_RENDERED_INCLUDE_CODES } = require('../../tx/library/renderer');
const { div } = require('../../library/html');

const SYSTEM = 'http://example.org/cs';

/** A link resolver that counts its calls, with or without resolveCodes. */
function setup({ batch = true } = {}) {
  const single = [];
  const batches = [];
  const resolve = (code) => ({ link: 'LINK:' + code, description: 'Described ' + code });
  const linkResolver = {
    resolveURL: async () => null,
    resolveCode: async (ctx, system, version, code) => {
      single.push(code);
      return resolve(code);
    },
  };
  if (batch) {
    linkResolver.resolveCodes = async (ctx, system, version, codes) => {
      batches.push({ system, version, codes });
      return codes.map(resolve);
    };
  }
  const opContext = { i18n: { formatPhrase: (id) => id }, langs: null };
  return { single, batches, renderer: new Renderer(opContext, linkResolver) };
}

const include = (n, withDisplay = true) => ({
  system: SYSTEM,
  concept: Array.from({ length: n }, (_, i) => (withDisplay ? { code: 'c' + i, display: 'Code ' + i } : { code: 'c' + i })),
});

async function render(renderer, inc) {
  const x = div();
  await renderer.renderInclude(x, inc);
  return x.toString();
}

const rows = (html) => (html.match(/<li>/g) || []).length;

describe('renderInclude: how many codes are listed', () => {
  test('the default is 500 codes', () => {
    expect(MAX_RENDERED_INCLUDE_CODES).toBe(500);
    expect(setup().renderer.includeCodeLimit).toBe(500);
  });

  test('a longer include lists the first 500, then how many more, with a link to them all', async () => {
    const { renderer } = setup();
    renderer.showAllCodesHref = '/tx/r4/ValueSet/big?_format=html&_showAll=true';
    const html = await render(renderer, include(33341));
    expect(rows(html)).toBe(501);
    expect(html).toContain('c499</a>: Code 499');
    expect(html).not.toContain('c500');
    expect(html).toContain('<i>… and 32,841 more codes.</i> <a href="/tx/r4/ValueSet/big?_format=html&amp;_showAll=true">Show all</a>');
  });

  test('without a link to give, it still says how many more there are', async () => {
    const { renderer } = setup();
    const html = await render(renderer, include(501));
    expect(html).toContain('… and 1 more code.');
    expect(html).not.toContain('Show all');
  });

  test('with no limit, every code is listed and looked up', async () => {
    const { batches, renderer } = setup();
    renderer.includeCodeLimit = null;
    const html = await render(renderer, include(1200));
    expect(rows(html)).toBe(1200);
    expect(html).toContain('<a href="LINK:c1199">c1199</a>: Code 1199');
    expect(html).not.toContain('more code');
    expect(batches[0].codes).toHaveLength(1200);
  });

  test('at 500 codes, nothing is cut', async () => {
    const { renderer } = setup();
    const html = await render(renderer, include(500));
    expect(rows(html)).toBe(500);
    expect(html).not.toContain('more code');
  });

  test('every code is still checked, including the ones not listed', async () => {
    const { renderer } = setup();
    const inc = include(600);
    inc.concept[550].code = '';
    await expect(render(renderer, inc)).rejects.toThrow();
  });
});

describe('renderInclude: look-ups', () => {
  test('the listed codes are looked up in one request, and only those', async () => {
    const { single, batches, renderer } = setup();
    await render(renderer, { ...include(2000), version: '2' });
    expect(single).toHaveLength(0);
    expect(batches).toHaveLength(1);
    expect(batches[0].system).toBe(SYSTEM);
    expect(batches[0].version).toBe('2');
    expect(batches[0].codes).toEqual(Array.from({ length: 500 }, (_, i) => 'c' + i));
  });

  test('a resolver without resolveCodes is asked one code at a time', async () => {
    const { single, renderer } = setup({ batch: false });
    const html = await render(renderer, include(3));
    expect(single).toEqual(['c0', 'c1', 'c2']);
    expect(html).toContain('<a href="LINK:c0">c0</a>: Code 0');
  });

  test('a small include renders as it did before', async () => {
    const { renderer } = setup();
    renderer.linkResolver.resolveCodes = async (ctx, system, version, codes) =>
      codes.map((code) => (code === 'c1' ? { link: 'LINK:c1', description: 'Described c1' } : null));
    const html = await render(renderer, {
      system: SYSTEM,
      concept: [{ code: 'c0', display: 'Code 0' }, { code: 'c1' }, { code: 'c2', display: 'Code 2' }],
    });
    // The same as main renders it.
    expect(html).toBe('<div xmlns="http://www.w3.org/1999/xhtml">\n'
      + 'VALUE_SET_THESE_CODES_DEF <code>http://example.org/cs</code>:  <ul>\n'
      + '    <li>c0: Code 0</li>\n'
      + '    <li><a href="LINK:c1">c1</a><span style="opaque: 0.5">: Described c1</span></li>\n'
      + '    <li>c2: Code 2</li>\n'
      + '  </ul>\n'
      + '</div>\n');
  });
});
