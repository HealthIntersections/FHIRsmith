/**
 * How each SNOMED CT cache file is loaded: the tx module's "snomed" block in config.json
 * (tx/sct/load-config.js), and the library applying it.
 */
const { SnomedLoadConfig } = require('../../tx/sct/load-config');
const { SnomedFileReader, SnomedConceptList } = require('../../tx/sct/structures');
const { SnomedServices } = require('../../tx/cs/cs-snomed');
const { mappingAvailable, _setMmapForTesting } = require('../../tx/sct/mmap');
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

const CACHE = path.resolve(__dirname, '../../tx/data/snomed-testing.cache');
const CAN_MAP = mappingAvailable();
const NO_MAP = ' (skipped: memory mapping is not available on this platform - needs 64-bit Linux/macOS/BSD with koffi)';
const testIfMapping = CAN_MAP ? test : test.skip;
const ifMapping = (name) => CAN_MAP ? name : name + NO_MAP;

/** Whether this process has filePath mapped, from /proc/self/maps (Linux only). */
function inProcMaps(filePath) {
  return fs.readFileSync('/proc/self/maps', 'utf8').split('\n').some(l => l.endsWith(' ' + fs.realpathSync(filePath)));
}

// Fails every mmap() call the way libc does (MAP_FAILED, errno set)
const FAILING_MMAP = {
  koffi: { address: () => 0xFFFFFFFFFFFFFFFFn, errno: () => 12 },
  mmap: () => ({})
};

async function readCache(loadMode, log) {
  const reader = new SnomedFileReader(CACHE, loadMode, log);
  const data = await reader.loadSnomedData();
  return { reader, data, services: new SnomedServices(data) };
}

/** Everything the services report about one concept. */
function describeConcept(sct, index) {
  const c = sct.concepts.getConcept(index);
  const descriptions = c.descriptions === 0 ? [] : sct.refs.getReferences(c.descriptions).map(i => {
    const d = sct.descriptions.getDescription(i);
    return { id: String(d.id), term: sct.strings.getEntry(d.iDesc), active: d.active, kind: d.kind, lang: d.lang };
  });
  const rels = (ref) => ref === 0 ? [] : sct.refs.getReferences(ref).map(i => {
    const r = sct.relationships.getRelationship(i);
    return [String(sct.concepts.getConceptId(r.source)), String(sct.concepts.getConceptId(r.target)),
      String(sct.concepts.getConceptId(r.relType)), r.group, r.active];
  });
  return {
    id: String(sct.concepts.getConceptId(index)),
    display: sct.getDisplayName(index),
    active: sct.isActive(index),
    descriptions,
    outbound: rels(c.outbounds),
    inbound: rels(c.inbounds),
    parents: sct.getConceptParents(index).map(p => String(sct.concepts.getConceptId(p)))
  };
}

describe('SnomedFileReader: memory mapping', () => {
  afterEach(() => _setMmapForTesting());

  test('load read: the buffer is not a mapping', async () => {
    const { reader } = await readCache('read');
    expect(reader.mapped).toBe(false);
  });

  testIfMapping(ifMapping('load mmap: the buffer really is a mapping of the file'), async () => {
    const before = process.platform === 'linux' && inProcMaps(CACHE);
    const { reader } = await readCache('mmap');
    expect(reader.mapped).toBe(true);
    if (process.platform === 'linux') {
      expect(before).toBe(false);
      expect(inProcMaps(CACHE)).toBe(true); // the kernel lists the file among this process's mappings
    }
  });

  testIfMapping(ifMapping('prewarm: mapped, and the background read finishes'), async () => {
    const { reader } = await readCache('prewarm');
    expect(reader.mapped).toBe(true);
    expect(typeof await reader.prewarmed).toBe('number');
  });

  testIfMapping(ifMapping('a mapped load gives the same data as a read load'), async () => {
    const read = await readCache('read');
    const mapped = await readCache('mmap');
    expect(read.reader.mapped).toBe(false);
    expect(mapped.reader.mapped).toBe(true);

    // the structures, byte for byte, and everything else in the header
    const sections = ['strings', 'refs', 'desc', 'words', 'stems', 'concept', 'rel', 'refSetIndex', 'refSetMembers', 'descRef'];
    const rest = (d) => Object.fromEntries(Object.entries(d).filter(([k]) => !sections.includes(k)));
    for (const k of sections) {
      expect(mapped.data[k].length).toBe(read.data[k].length);
      expect(Buffer.compare(mapped.data[k], read.data[k])).toBe(0);
    }
    expect(rest(mapped.data)).toEqual(rest(read.data));

    // and what the services make of them: counts, and every concept's descriptions and relationships
    for (const what of ['concepts', 'descriptions', 'relationships', 'words', 'stems', 'refSetIndex']) {
      expect(mapped.services[what].count()).toBe(read.services[what].count());
    }
    const n = read.services.concepts.count();
    expect(n).toBeGreaterThan(1000);
    let withRels = 0;
    for (let i = 0; i < n; i++) {
      const index = i * SnomedConceptList.CONCEPT_SIZE;
      const a = describeConcept(read.services, index);
      expect(describeConcept(mapped.services, index)).toEqual(a);
      if (a.descriptions.length && a.outbound.length) withRels++;
    }
    expect(withRels).toBeGreaterThan(100); // the comparison covered real content, not empty concepts
  }, 60000);

  test.each([
    ['mapping not available', () => _setMmapForTesting(null, 'simulated'), /memory mapping is not available here \(simulated\); reading .*snomed-testing.cache into memory/],
    ['mmap() failing', () => _setMmapForTesting(FAILING_MMAP), /could not map .*snomed-testing.cache \(errno 12\); reading it into memory/]
  ])('%s: falls back to reading, mapped is false, and the log says why', async (name, simulate, message) => {
    simulate();
    const log = { warn: jest.fn() };
    const { reader, services } = await readCache('mmap', log);
    expect(reader.mapped).toBe(false);
    expect(services.concepts.count()).toBeGreaterThan(0);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(message));
  });

  test('with no logger, the fallback warning goes to the console', async () => {
    _setMmapForTesting(null, 'simulated');
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { reader } = await readCache('mmap');
      expect(reader.mapped).toBe(false);
      expect(spy).toHaveBeenCalledWith(expect.stringMatching(/memory mapping is not available here \(simulated\)/));
    } finally {
      spy.mockRestore();
    }
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
    expect(factory.mapped).toBe(expected !== 'read' && CAN_MAP);
    expect(factory.snomedServices.concepts.count()).toBeGreaterThan(0);
    expect(memoryGuard._state.excludeFileBacked).toBe(factory.mapped && process.platform === 'linux');
    if (expected !== 'read') {
      expect(log.info).toHaveBeenCalledWith(expect.stringMatching(
        CAN_MAP ? /snomed-testing.cache: load \w+, memory-mapped$/ : /snomed-testing.cache: load \w+, not mapped, read into memory$/));
    }
    if (CAN_MAP) expect(log.warn).not.toHaveBeenCalled();
  }, 30000);

  test('load mmap where mapping fails: read instead, and the server log says so', async () => {
    _setMmapForTesting(FAILING_MMAP);
    try {
      const { library, log } = await load({ load: 'mmap' });
      const factory = library.codeSystemFactories.get(SYSTEM);
      expect(factory.loadMode).toBe('mmap');
      expect(factory.mapped).toBe(false);
      expect(factory.snomedServices.concepts.count()).toBeGreaterThan(0);
      expect(memoryGuard._state.excludeFileBacked).toBe(false);
      expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/could not map .*snomed-testing.cache \(errno 12\); reading it into memory/));
      expect(log.info).toHaveBeenCalledWith(expect.stringMatching(/snomed-testing.cache: load mmap, not mapped, read into memory$/));
    } finally {
      _setMmapForTesting();
    }
  }, 30000);

  test('an entry that matches nothing is warned about', async () => {
    const { log } = await load({ load: 'mmap', read: ['sct_us_20250901b.cache'] });
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/"sct_us_20250901b.cache" matches no SNOMED CT edition/));
  }, 30000);
});
