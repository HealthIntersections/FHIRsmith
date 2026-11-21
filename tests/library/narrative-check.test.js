// library/narrative-check.js: active content in narrative

const { checkNarrative, checkResourceNarratives, assertNoActiveContent } = require('../../library/narrative-check');

const div = (inner) => `<div xmlns="http://www.w3.org/1999/xhtml">${inner}</div>`;

describe('checkNarrative: content that is fine', () => {
  test.each([
    ['empty', ''],
    ['nothing', null],
    ['text and formatting', div('<p>Some <b>bold</b>, <i>italic</i> and <code>code</code></p><ul><li>one</li></ul>')],
    ['a table', div('<table class="grid"><tr><th>Code</th><td>Display</td></tr></table>')],
    ['links', div('<a href="http://example.org/x?a=1&amp;b=2">x</a> <a href="#frag">y</a> <a name="anchor"/> <a href="CodeSystem-x.html">z</a> <a href="mailto:a@example.org">m</a>')],
    ['an image', div('<img src="tbl_spacer.png" alt="x"/>')],
    ['an inline image', div('<img src="data:image/png;base64,iVBORw0KGgo=" alt="x"/>')],
    ['an inline svg image in an img', div('<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="/>')],
    ['style attributes', div('<span style="color: red; background-color: #fff; padding-left: 3px">x</span>')],
    ['the word javascript in text', div('<p>javascript: is a URL scheme; onclick is an attribute; &lt;script&gt;</p>')],
    ['a title that mentions script', div('<span title="javascript:alert(1)">x</span>')],
    ['a comment', div('<!-- <script>alert(1)</script> -->x')]
  ])('%s', (_, xhtml) => {
    expect(checkNarrative(xhtml)).toBeNull();
  });
});

describe('checkNarrative: active content', () => {
  test.each([
    ['a script', '<script>alert(1)</script>', /<script> element/],
    ['a script in odd case', '<ScRiPt>alert(1)</sCrIpT>', /<script> element/],
    ['a script inside other elements', '<p><b><script>x</script></b></p>', /<script> element/],
    ['an event handler', '<img src="x" onerror="alert(1)"/>', /event handler attribute \(onerror\) on <img>/],
    ['an event handler in odd case', '<p OnMouseOver="alert(1)">x</p>', /onmouseover/],
    ['a javascript: link', '<a href="javascript:alert(1)">x</a>', /javascript: URL in the href of <a>/],
    ['a javascript: link with entities', '<a href="&#106;&#x61;vascript:alert(1)">x</a>', /javascript: URL/],
    ['a javascript: link with spacing', '<a href=" \tjava\nscript:alert(1)">x</a>', /javascript: URL/],
    ['a JAVASCRIPT: link', '<a href="JAVASCRIPT:alert(1)">x</a>', /javascript: URL/],
    ['a vbscript: link', '<a href="vbscript:msgbox(1)">x</a>', /vbscript: URL/],
    ['a data: link', '<a href="data:text/html,&lt;script&gt;alert(1)&lt;/script&gt;">x</a>', /data: URL in the href of <a>/],
    ['a data: image that is not an image', '<img src="data:text/html,x"/>', /data: URL in the src of <img>/],
    ['a javascript: image', '<img src="javascript:alert(1)"/>', /javascript: URL in the src/],
    ['a javascript: srcset', '<img srcset="ok.png 1x, javascript:alert(1) 2x"/>', /javascript: URL in the srcset/],
    ['an iframe', '<iframe src="http://example.org"></iframe>', /<iframe> element/],
    ['srcdoc', '<iframe srcdoc="&lt;script&gt;x&lt;/script&gt;"></iframe>', /srcdoc/],
    ['an object', '<object data="x.swf"></object>', /<object> element/],
    ['an embed', '<embed src="x.swf"/>', /<embed> element/],
    ['a form', '<form action="http://example.org"><input name="x"/></form>', /<form> element/],
    ['a button with formaction', '<button formaction="javascript:x">b</button>', /<button> element/],
    ['a base', '<base href="http://evil.example.org/"/>', /<base> element/],
    ['a link', '<link rel="stylesheet" href="http://example.org/x.css"/>', /<link> element/],
    ['a meta refresh', '<meta http-equiv="refresh" content="0;url=http://example.org"/>', /<meta> element/],
    ['a style element', '<style>body { display: none }</style>', /<style> element/],
    ['an svg', '<svg><script>alert(1)</script></svg>', /<svg> element/],
    ['an svg with a handler', '<svg onload="alert(1)"/>', /<svg> element/],
    ['an svg link', '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>', /<svg> element/],
    ['math', '<math><mtext>x</mtext></math>', /<math> element/],
    ['a template', '<template><script>x</script></template>', /<template> element/],
    ['css expression', '<p style="width: expression(alert(1))">x</p>', /style attribute/],
    ['css expression, escaped', '<p style="width: \\65 xpression(alert(1))">x</p>', /style attribute/],
    ['css expression, with a comment', '<p style="width: expr/**/ession(alert(1))">x</p>', /style attribute/],
    ['css javascript: url', '<p style="background: url(javascript:alert(1))">x</p>', /style attribute/],
    ['css -moz-binding', '<p style="-moz-binding: url(x.xml#y)">x</p>', /style attribute/],
    ['css @import', '<p style="@import url(x.css)">x</p>', /style attribute/],
    ['unclosed markup', '<img src=x onerror=alert(1)', /onerror/],
    ['a script after an unclosed comment', '<p>x</p><!-- -- --><script>y</script>', /<script> element/]
  ])('%s', (_, inner, expected) => {
    const found = checkNarrative(div(inner));
    expect(found).toMatch(/^active content in the narrative: /);
    expect(found).toMatch(expected);
  });

  test('several problems are listed, up to three', () => {
    const found = checkNarrative(div('<script>1</script><iframe></iframe><img onerror="x"/><form></form><embed/>'));
    expect(found).toMatch(/<script>.*<iframe>.*onerror.*\(and 2 more\)/);
  });

  test('a narrative that is not a string', () => {
    expect(checkNarrative({ div: 'x' })).toMatch(/not a string/);
  });
});

describe('checkResourceNarratives', () => {
  const ok = div('<p>fine</p>');
  const bad = div('<script>x</script>');

  test('a resource with no narrative, or a fine one', () => {
    expect(checkResourceNarratives({ resourceType: 'ValueSet', id: 'a' })).toBeNull();
    expect(checkResourceNarratives({ resourceType: 'ValueSet', id: 'a', text: { status: 'generated', div: ok } })).toBeNull();
  });

  test('says where the active content is: the resource', () => {
    expect(checkResourceNarratives({ resourceType: 'CodeSystem', id: 'cs', text: { div: bad } }))
      .toMatch(/^CodeSystem\/cs: active content in the narrative: a <script> element$/);
  });

  test('a contained resource', () => {
    expect(checkResourceNarratives({
      resourceType: 'ValueSet', id: 'vs', text: { div: ok },
      contained: [{ resourceType: 'CodeSystem', id: 'c1', text: { div: ok } }, { resourceType: 'CodeSystem', id: 'c2', text: { div: bad } }]
    })).toMatch(/^ValueSet\/vs\.contained\[1\] \(#c2\): /);
  });

  test('a Bundle entry', () => {
    expect(checkResourceNarratives({ resourceType: 'Bundle', entry: [{ resource: { resourceType: 'ValueSet', text: { div: bad } } }] }))
      .toMatch(/^Bundle\.entry\[0\]: /);
  });

  test('assertNoActiveContent throws with the context', () => {
    expect(() => assertNoActiveContent({ resourceType: 'ValueSet', id: 'v', text: { div: bad } }, 'Package x#1.0'))
      .toThrow(/^Package x#1\.0: ValueSet\/v: active content/);
    expect(() => assertNoActiveContent({ resourceType: 'ValueSet', id: 'v', text: { div: ok } }, 'Package x#1.0')).not.toThrow();
  });
});
