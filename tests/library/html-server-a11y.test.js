const path = require('path');
const fs = require('fs');

const HtmlServer = require('../../library/html-server').constructor;

describe('Accessibility check panel', () => {
  let htmlServer;

  beforeEach(() => {
    htmlServer = new HtmlServer();
    htmlServer.useLog({ error: jest.fn(), warn: jest.fn() });
    htmlServer.loadTemplate('root', path.join(__dirname, '../../root-template.html'));
  });

  test('is not added by default', () => {
    const html = htmlServer.renderPage('root', 'Test', '<p>Main</p>');
    expect(html).not.toContain('fhir-a11y-panel');
    expect(html).not.toContain('a11y-check.js');
  });

  test('is added at the end of the body when turned on', () => {
    htmlServer.setAccessibilityPanel(true);
    const html = htmlServer.renderPage('root', 'Test', '<p>Main</p>');
    const panel = html.indexOf('<div id="fhir-a11y-panel"');
    expect(panel).toBeGreaterThan(html.indexOf('<p>Main</p>'));
    expect(html.indexOf('<script type="text/javascript" src="/a11y/a11y-check.js"></script>')).toBeGreaterThan(panel);
    expect(html.toLowerCase().lastIndexOf('</body>')).toBeGreaterThan(panel);
    expect(html).toContain('data-axe="/a11y/axe.min.js"');
    // once only
    expect(html.split('fhir-a11y-panel').length).toBe(2);
  });

  test('is added at the end when the template has no body end tag', () => {
    htmlServer.templates.set('bare', '<div>[%content%]</div>');
    htmlServer.setAccessibilityPanel(true);
    const html = htmlServer.renderPage('bare', 'Test', '<p>Main</p>');
    expect(html.startsWith('<div><p>Main</p></div>')).toBe(true);
    expect(html).toContain('fhir-a11y-panel');
  });

  test('content mentioning </body> does not move the panel', () => {
    htmlServer.setAccessibilityPanel(true);
    const html = htmlServer.renderPage('root', 'Test', '<pre>&lt;/body&gt;</pre><p>x</p></body>');
    // the panel goes before the template's own </body>, which is the last one
    expect(html.indexOf('fhir-a11y-panel')).toBeGreaterThan(html.indexOf('<p>x</p>'));
  });

  test('the scripts it uses are served from static/a11y', () => {
    expect(fs.existsSync(path.join(__dirname, '../../static/a11y/a11y-check.js'))).toBe(true);
    expect(fs.existsSync(path.join(__dirname, '../../static/a11y/axe.min.js'))).toBe(true);
  });
});
