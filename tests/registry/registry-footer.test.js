// The registry page footer: "last updated ..." only once a crawl has completed

const path = require('path');
const htmlServer = require('../../library/html-server');
const RegistryAPI = require('../../registry/api');
const { ServerRegistries, ServerRegistry, ServerInformation } = require('../../registry/model');

function apiFor(data) {
  return new RegistryAPI({ getData: () => data });
}

function footer(stats) {
  if (!htmlServer.hasTemplate('registry')) {
    htmlServer.loadTemplate('registry', path.join(__dirname, '../../registry/registry-template.html'));
  }
  const html = htmlServer.renderPage('registry', 'Test', '', stats);
  return html.substring(html.indexOf('Terminology Registry'), html.indexOf('Terminology Registry') + 80);
}

describe('registry footer', () => {
  test('before the first crawl', () => {
    const stats = apiFor(new ServerRegistries()).getStatistics();
    expect(stats.crawlerStatus).toBe('not yet updated');
    expect(footer(stats)).toContain('Terminology Registry not yet updated');
  });

  test('after a crawl', () => {
    const data = new ServerRegistries();
    data.lastRun = new Date(Date.now() - 35 * 60 * 1000);
    const registry = new ServerRegistry();
    registry.servers.push(new ServerInformation(), new ServerInformation());
    data.registries.push(registry);
    const stats = apiFor(data).getStatistics();
    expect(stats.crawlerStatus).toBe('last updated 35 minutes ago, 2 servers');
    const text = footer(stats);
    expect(text).toContain('Terminology Registry last updated 35 minutes ago, 2 servers');
    expect(text).not.toContain('[%');
  });
});
