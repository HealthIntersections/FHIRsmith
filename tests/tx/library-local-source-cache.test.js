/**
 * folder:/file: sources keep their caches in <terminology-cache>/folder-source-<hash>. A load
 * removes the ones it didn't use, but only once they're stale - the cache folder may be shared
 * with another Library that is using them.
 */
const { Library } = require('../../tx/library');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');

describe('Library local source caches', () => {
  let tmpDir;
  let cacheDir;
  let yamlPath;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lib-source-cache-test-'));
    cacheDir = path.join(tmpDir, 'cache');
    await fs.mkdir(cacheDir);
    yamlPath = path.join(tmpDir, 'library.yml');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function cacheFolder(name, ageMs) {
    const dir = path.join(cacheDir, name);
    await fs.mkdir(dir);
    await fs.writeFile(path.join(dir, '.valuesets-2.db'), '');
    const when = new Date(Date.now() - ageMs);
    await fs.utimes(dir, when, when);
    return dir;
  }

  const exists = async (p) => fs.access(p).then(() => true, () => false);

  test('unused caches are removed once stale; recent ones and the ones in use are kept', async () => {
    const source = path.join(tmpDir, 'source');
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, 'cs.json'), JSON.stringify({
      resourceType: 'CodeSystem', id: 'thing', url: 'http://example.org/CodeSystem/thing', version: '1.0.0',
      status: 'active', content: 'complete', concept: [{ code: 'a' }]
    }));
    await fs.writeFile(yamlPath, ['base:', '  url: https://storage.googleapis.com/tx-fhir-org',
      'sources:', `  - folder:${source}`].join('\n'));

    const DAY = 24 * 60 * 60 * 1000;
    const stale = await cacheFolder('folder-source-00000000000000aa', 2 * DAY);
    const recent = await cacheFolder('folder-source-00000000000000bb', 60 * 1000);
    const other = await cacheFolder('some-package#1.0.0', 2 * DAY);

    const log = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
    const library = new Library(yamlPath, undefined, log, { addStat: jest.fn() });
    library.cacheFolder = cacheDir;
    await library.load();

    expect(await exists(stale)).toBe(false);
    expect(await exists(recent)).toBe(true);
    expect(await exists(other)).toBe(true);
    const used = (await fs.readdir(cacheDir)).filter(n => n.startsWith('folder-source-') && n !== path.basename(recent));
    expect(used).toHaveLength(1);
  }, 30000);
});
