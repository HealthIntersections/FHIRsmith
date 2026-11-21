/**
 * The IANA media types registry in a cluster (cluster.md): a tx-worker reads the cached copy
 * the master downloaded and never downloads or writes it; the master, and a server with no
 * role, refresh it on every load as before.
 */
jest.mock('axios');
const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MimeTypeServicesFactory } = require('../../tx/cs/cs-mimetypes');
const { Library } = require('../../tx/library');
const { TestUtilities } = require('../test-utilities');

const registry = (...names) => `<?xml version="1.0"?>
<registry xmlns="http://www.iana.org/assignments" id="media-types">
  <registry id="text">
    ${names.map(n => `<record><name>${n}</name><file template="text/${n}">text/${n}</file></record>`).join('\n    ')}
  </registry>
</registry>`;

function fakeLog() {
  const lines = [];
  const add = level => msg => lines.push(`${level}: ${msg}`);
  return { lines, info: add('info'), warn: add('warn'), error: add('error'), debug: add('debug') };
}

describe('Mime types registry and the cluster role', () => {
  let dir;
  let target;
  const OLD = new Date('2026-01-01T00:00:00Z');
  let i18n;

  beforeAll(async () => {
    i18n = await TestUtilities.loadTranslations();
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mime-role-'));
    target = path.join(dir, 'media-types.xml');
    axios.get.mockReset();
    axios.get.mockResolvedValue({ data: registry('plain', 'html', 'csv') });
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function seedCache() {
    fs.writeFileSync(target, registry('plain', 'html'), 'utf8');
    fs.utimesSync(target, OLD, OLD);
  }

  test('read-only (a tx-worker): no download, no write, the cached copy is used', async () => {
    seedCache();
    const log = fakeLog();
    const factory = new MimeTypeServicesFactory(i18n, dir, log, { readOnly: true });
    await factory.load();
    expect(axios.get).not.toHaveBeenCalled();
    expect(fs.statSync(target).mtimeMs).toBe(OLD.getTime());
    expect(fs.readdirSync(dir)).toEqual(['media-types.xml']);
    expect([...factory.registeredTypes].sort()).toEqual(['text/html', 'text/plain']);
  });

  test('read-only with no cached copy: a warning, no download, no registered filter', async () => {
    const log = fakeLog();
    const factory = new MimeTypeServicesFactory(i18n, dir, log, { readOnly: true });
    await factory.load();
    expect(axios.get).not.toHaveBeenCalled();
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(factory.registeredTypes).toBeNull();
    expect(log.lines.some(l => l.startsWith('warn: Mime types: no cached copy'))).toBe(true);
    expect(log.lines.some(l => l.startsWith('warn: Mime types: no copy of the IANA media types registry'))).toBe(true);
  });

  test('no role (the default): refreshes the cached copy', async () => {
    seedCache();
    const factory = new MimeTypeServicesFactory(i18n, dir, fakeLog());
    await factory.load();
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(fs.statSync(target).mtimeMs).toBeGreaterThan(OLD.getTime());
    expect(fs.readdirSync(dir)).toEqual(['media-types.xml']);
    expect(factory.registeredTypes.has('text/csv')).toBe(true);
  });

  describe('through the library, as tx.js sets it for each role', () => {
    async function loadWith(readOnly) {
      const library = new Library(null, null, fakeLog(), null);
      library.cacheFolder = dir;
      library.i18n = i18n;
      library.mimeTypesReadOnly = readOnly;
      library.registerProvider = () => {};
      await library.loadInternal('mimetypes', false, 'load');
    }

    test('tx-worker: no network call and no write', async () => {
      seedCache();
      await loadWith(true);
      expect(axios.get).not.toHaveBeenCalled();
      expect(fs.statSync(target).mtimeMs).toBe(OLD.getTime());
    });

    test('master or no role: refreshes', async () => {
      seedCache();
      await loadWith(false);
      expect(axios.get).toHaveBeenCalledTimes(1);
      expect(fs.statSync(target).mtimeMs).toBeGreaterThan(OLD.getTime());
    });
  });
});
