/**
 * How each SNOMED CT cache file is loaded: the tx module's "snomed" block in config.json
 * (tx/sct/load-config.js), and the library applying it.
 */
const { SnomedLoadConfig } = require('../../tx/sct/load-config');
const { SnomedFileReader } = require('../../tx/sct/structures');
const { Library } = require('../../tx/library');
const folders = require('../../library/folder-setup');
const memoryGuard = require('../../library/memory-guard');
const path = require('path');
const fs = require('fs');
const os = require('os');

const INTL = 'http://snomed.info/sct/900000000000207008';
const US = 'http://snomed.info/sct/731000124108';
const intl25 = ['/data/sct_intl_20250201.cache', `${INTL}/version/20250201`];
const intl26 = ['/data/Snomed_Intl_20260701.cache', `${INTL}/version/20260701`];
const us = ['/data/sct_us_20250901b.cache', `${US}/version/20250901`];
const uk = ['/data/sct_uk_20230412.cache', 'http://snomed.info/sct/83821000000107/version/20230412'];

function config(block) {
  const warnings = [];
  return { cfg: new SnomedLoadConfig(block, (m) => warnings.push(m)), warnings };
}

describe('SnomedLoadConfig', () => {
  test('no block: everything is read, as before', () => {
    const { cfg, warnings } = config(undefined);
    expect([intl25, us, uk].map(f => cfg.modeFor(...f))).toEqual(['read', 'read', 'read']);
    expect(cfg.mapsAnything()).toBe(false);
    cfg.checkUnused();
    expect(warnings).toEqual([]);
  });

  test('load mmap maps everything', () => {
    const { cfg } = config({ load: 'mmap' });
    expect([intl25, us, uk].map(f => cfg.modeFor(...f))).toEqual(['mmap', 'mmap', 'mmap']);
    expect(cfg.mapsAnything()).toBe(true);
  });

  test('entries match a file name, a version URI, or an edition URI (every version)', () => {
    const { cfg, warnings } = config({
      load: 'mmap',
      read: ['sct_us_20250901b.cache'],
      prewarm: [`${INTL}/version/20250201`, 'http://snomed.info/sct/83821000000107']
    });
    expect(cfg.modeFor(...us)).toBe('read');
    expect(cfg.modeFor(...intl25)).toBe('prewarm');
    expect(cfg.modeFor(...intl26)).toBe('mmap');
    expect(cfg.modeFor(...uk)).toBe('prewarm');
    cfg.checkUnused();
    expect(warnings).toEqual([]);
  });

  test('an edition URI matches every version of it', () => {
    const { cfg } = config({ load: 'mmap', read: [INTL] });
    expect(cfg.modeFor(...intl25)).toBe('read');
    expect(cfg.modeFor(...intl26)).toBe('read');
    expect(cfg.modeFor(...us)).toBe('mmap');
  });

  test('"read" wins over "prewarm", which wins over "load"', () => {
    const { cfg, warnings } = config({ load: 'read', read: ['sct_uk_20230412.cache'], prewarm: ['sct_uk_20230412.cache', `${US}/version/20250901`] });
    expect(cfg.modeFor(...uk)).toBe('read');
    expect(cfg.modeFor(...us)).toBe('prewarm'); // prewarm maps the file even when load is read
    expect(cfg.modeFor(...intl25)).toBe('read');
    expect(cfg.mapsAnything()).toBe(true);
    expect(warnings).toEqual([expect.stringMatching(/sct_uk_20230412.cache is in both "prewarm" and "read"/)]);
  });

  test('bad values are warned about and ignored', () => {
    const { cfg, warnings } = config({ load: 'fast', read: 'sct_us_20250901b.cache', prewarm: [3] });
    expect(cfg.load).toBe('read');
    expect(cfg.modeFor(...us)).toBe('read');
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toMatch(/snomed.load must be "read" or "mmap"/);
    expect(warnings[1]).toMatch(/snomed.prewarm must be a list/);
    expect(warnings[2]).toMatch(/snomed.read must be a list/);
  });

  test('entries that match no loaded edition are warned about', () => {
    const { cfg, warnings } = config({ load: 'mmap', read: ['sct_us_20250901.cache'], prewarm: [US] });
    cfg.modeFor(...us);
    cfg.modeFor(...intl25);
    cfg.checkUnused();
    expect(warnings).toEqual([expect.stringMatching(/snomed.read: "sct_us_20250901.cache" matches no SNOMED CT edition/)]);
  });
});

describe('SnomedFileReader.versionUri', () => {
  test('reads the edition version URI from the header', () => {
    const file = path.resolve(__dirname, '../../tx/data/snomed-testing.cache');
    expect(SnomedFileReader.versionUri(file)).toMatch(/^http:\/\/snomed\.info\/x?sct\/\d+\/version\/\d{8}$/);
  });
});

describe('Library: SNOMED CT load mode from config', () => {
  const COMMITTED = path.resolve(__dirname, '../../tx/data/snomed-testing.cache');
  const SYSTEM = 'http://snomed.info/sct';
  let tmpDir;
  let yamlPath;

  beforeAll(() => {
    const target = path.join(folders.subDir('terminology-cache'), 'snomed-testing.cache');
    if (!fs.existsSync(target)) {
      fs.copyFileSync(COMMITTED, target);
    }
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lib-sct-load-'));
    yamlPath = path.join(tmpDir, 'library.yml');
    fs.writeFileSync(yamlPath, 'base:\n  url: https://storage.googleapis.com/tx-fhir-org\nsources:\n  - snomed:snomed-testing.cache\n');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    memoryGuard._state.excludeFileBacked = false;
  });

  async function load(block) {
    const log = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
    const library = new Library(yamlPath, undefined, log, { addStat: jest.fn() }, block);
    await library.load();
    return { library, log };
  }

  const version = () => SnomedFileReader.versionUri(COMMITTED);

  test.each([
    ['no block', undefined, 'read'],
    ['load mmap', { load: 'mmap' }, 'mmap'],
    ['load mmap, file read', { load: 'mmap', read: ['snomed-testing.cache'] }, 'read'],
    ['load read, version prewarmed', { prewarm: ['VERSION'] }, 'prewarm']
  ])('%s: loaded with mode %#', async (name, block, expected) => {
    if (block && block.prewarm) block = { ...block, prewarm: [version()] };
    const { library, log } = await load(block);
    const factory = library.codeSystemFactories.get(SYSTEM);
    expect(factory.loadMode).toBe(expected);
    expect(factory.snomedServices.concepts.count()).toBeGreaterThan(0);
    expect(memoryGuard._state.excludeFileBacked).toBe(expected !== 'read' && process.platform === 'linux');
    expect(log.warn).not.toHaveBeenCalled();
  }, 30000);

  test('an entry that matches nothing is warned about', async () => {
    const { log } = await load({ load: 'mmap', read: ['sct_us_20250901b.cache'] });
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/"sct_us_20250901b.cache" matches no SNOMED CT edition/));
  }, 30000);
});
