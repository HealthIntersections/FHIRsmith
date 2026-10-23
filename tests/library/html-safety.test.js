// Output escaping in the shared HTML code: the page template (html-server) and the
// XHTML builder (html.js) that the tx renderers use

const path = require('path');
const escape = require('escape-html');
const htmlServer = require('../../library/html-server');
const { div } = require('../../library/html');

describe('renderPage', () => {
  beforeAll(() => {
    htmlServer.loadTemplate('tx', path.join(__dirname, '../../tx/html/tx-template.html'));
  });

  const render = (content, title = 't') =>
    htmlServer.renderPage('tx', title, content, { totalResources: 0, totalPackages: 0, processingTime: 0 });

  test.each([['$`'], ['$\''], ['$&'], ['$1']])('content containing %s is inserted literally', (pattern) => {
    // escape() leaves $ and ` alone; String.replace would treat $` as "the text before the
    // match" and splice the template in, which can end an attribute early
    const value = escape(`x${pattern}y onmouseover=alert(1)`);
    const page = render(`<a title="${value}">hi</a>`);
    expect(page).toContain(`<a title="${value}">hi</a>`);
  });

  test('a title containing $` is inserted literally', () => {
    expect(render('c', 'a$`b')).toContain('a$`b');
  });

  test('placeholders inside content are left alone: one pass over the template', () => {
    // a narrative that names a placeholder must not get the placeholder's raw HTML spliced in
    const content = '<p title="[%context-link%] <img src=x onerror=alert(1)>">[%about%][%ver%][%title%][%content%][%custom%]</p>';
    const page = htmlServer.renderPage('tx', 'T', content, { totalResources: 0, totalPackages: 0, processingTime: 0,
      contextLink: '<a href="/x" style="color: gold">X</a>', about: '<b>about</b>', templateVars: { custom: 'C' } });
    expect(page).toContain(content);
    expect(page).not.toContain('<a href="/x" style="color: gold">X</a> <img');
  });

  test('the template\'s own placeholders are still filled, and template variables are escaped', () => {
    const page = htmlServer.renderPage('tx', '<T>', '<i>c</i>', { totalResources: 1234, totalPackages: 0, processingTime: 5 });
    expect(page).toContain('&lt;T&gt;');
    expect(page).toContain('<i>c</i>');
    expect(page).not.toMatch(/\[%(title|content|ver|ms)%\]/);
  });
});

describe('XhtmlNode URL attributes', () => {
  test.each([
    'javascript:alert(1)',
    ' JavaScript:alert(1)',
    'java\tscript:alert(1)',
    '\x01javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)'
  ])('a link to %j is neutralised', (url) => {
    const d = div();
    d.ah(url).tx('x');
    const html = d.toString();
    expect(html).toContain('href="#"');
    expect(html.toLowerCase()).not.toMatch(/script:|data:/);
  });

  test.each([
    'http://example.org/x', 'https://example.org/x?a=1&b=2', 'mailto:a@example.org', '#anchor', 'relative/path', '/abs'
  ])('a link to %j is kept', (url) => {
    const d = div();
    d.ah(url).tx('x');
    const html = d.toString();
    expect(html).toContain(`href="${url.replace(/&/g, '&amp;')}"`);
  });

  test('other attributes are not affected', () => {
    expect(div().setAttribute('title', 'javascript: is a word').toString()).toContain('title="javascript: is a word"');
  });
});
