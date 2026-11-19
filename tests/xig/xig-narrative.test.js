// The XIG shows the narrative of every resource in every package it has crawled: whoever
// published a package wrote it, so it must not be able to put script in the XIG's pages

const parse5 = require('parse5');
const xig = require('../../xig/xig');
const { TxHtmlRenderer } = require('../../tx/tx-html');

// script elements and event handlers in a page
function active(html) {
  const found = [];
  (function walk(n) {
    if (n.tagName === 'script') {
      found.push('script');
    }
    for (const a of n.attrs || []) {
      if (/^on/i.test(a.name)) {
        found.push(`${n.tagName} ${a.name}`);
      }
    }
    (n.childNodes || []).forEach(walk);
    if (n.content) {
      walk(n.content);
    }
  })(parse5.parse(`<html><body>${html}</body></html>`));
  return found;
}

describe('xig: a resource\'s narrative', () => {
  test('active content is not shown', () => {
    for (const div of ['<div xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></div>',
      '<div><img src="x" onerror="alert(1)"/></div>', '<div><a href="javascript:alert(1)">x</a></div>']) {
      const html = xig.buildResourceNarrative({ text: { div } }, null);
      expect(html).toContain('The narrative is not shown');
      expect(active(html)).toEqual([]);
      expect(html).not.toMatch(/href="javascript:/);
    }
  });

  test('a clean narrative is shown, rebased to the package\'s address, which is escaped', () => {
    const html = xig.buildResourceNarrative({ text: { div: '<div><p>Hello</p><img src="pic.png"/><a href="page.html">p</a></div>' } },
      { Web: 'https://example.org/ig"><img src=x onerror=alert(1)>/index.html' });
    expect(html).toContain('<p>Hello</p>');
    expect(active(html)).toEqual([]);
    expect(html).toContain('src="https://example.org/ig&quot;&gt;&lt;img src=x onerror=alert(1)&gt;/pic.png"');
  });

  test('an unterminated tag doesn\'t swallow the page after it', () => {
    const html = xig.buildResourceNarrative({ text: { div: '<div><p title="unterminated' } }, null) + '<p id="after">after</p>';
    expect(html).toContain('<p id="after">after</p>');
    const doc = parse5.parse(`<html><body>${html}</body></html>`);
    const ids = [];
    (function walk(n) {
      for (const a of n.attrs || []) {
        if (a.name === 'id') {
          ids.push(a.value);
        }
      }
      (n.childNodes || []).forEach(walk);
    })(doc);
    expect(ids).toContain('after');
  });
});

describe('tx: a resource\'s Original Narrative', () => {
  test('is the parsed tree written out again: an unterminated attribute doesn\'t swallow the page', async () => {
    const r = new TxHtmlRenderer(null, null, null, null, '/tx/r4');
    const html = await r.renderOriginalNarrative({ resourceType: 'CodeSystem', id: 'x', text: { div: '<div><p title="unterminated' } });
    // the tag that never ended is dropped, as a browser would; what follows is untouched
    expect(html).toBe('<div class="narrative"><div></div></div>');
  });

  test('active content is not shown', async () => {
    const r = new TxHtmlRenderer(null, null, null, null, '/tx/r4');
    const html = await r.renderOriginalNarrative({ resourceType: 'CodeSystem', id: 'x', text: { div: '<div><img src="x" onerror="alert(1)"/></div>' } });
    expect(active(html)).toEqual([]);
  });
});
