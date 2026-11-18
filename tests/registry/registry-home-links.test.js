// The "Register your own server" and "Documentation" links on the registry home page
// depend on the ecosystem, so they come from the master registration file

const { ServerRegistries } = require('../../registry/model');
const RegistryModule = require('../../registry/registry');

function homePage(master) {
  const data = new ServerRegistries();
  data.registration = master.registration || '';
  data.ecosystemDoco = master['ecosystem-documentation'] || '';
  const module = new RegistryModule({ countRequest() {} });
  module.api = { getStatistics: () => ({}), getData: () => data };
  module.crawler = { getData: () => data };
  module.releases = { latest: () => null, source: 'test', describe: () => ({}) };
  return module.buildHtmlContent();
}

describe('registry home page: ecosystem links', () => {
  test('both links come from the master file', async () => {
    const html = await homePage({
      registration: 'https://example.org/register.html',
      'ecosystem-documentation': 'https://example.org/ecosystem.html'
    });
    expect(html).toContain('<a href="https://example.org/register.html">Register your own server</a> - see <a href="https://example.org/ecosystem.html">Documentation</a>');
    expect(html).not.toContain('github.com/FHIR/ig-registry');
    expect(html).not.toContain('fhir-tx-ecosystem-ig');
  });

  test('a link the master file does not give is left out', async () => {
    let html = await homePage({ 'ecosystem-documentation': 'https://example.org/ecosystem.html' });
    expect(html).not.toContain('Register your own server');
    expect(html).toContain('see <a href="https://example.org/ecosystem.html">Documentation</a>');

    html = await homePage({ registration: 'https://example.org/register.html' });
    expect(html).toContain('Register your own server</a></p>');
    expect(html).not.toContain('Documentation');
  });

  test('the links survive a save and load', () => {
    const data = new ServerRegistries();
    data.registration = 'https://example.org/register.html';
    data.ecosystemDoco = 'https://example.org/ecosystem.html';
    const copy = ServerRegistries.fromJSON(JSON.parse(JSON.stringify(data.toJSON())));
    expect(copy.registration).toBe(data.registration);
    expect(copy.ecosystemDoco).toBe(data.ecosystemDoco);
  });
});
