// node server.js --check / cluster.js --check (library/config-check.js): the configuration
// checked without starting anything

const fs = require('fs');
const os = require('os');
const path = require('path');
const { checkParsedConfig, runCheck, wantsCheck } = require('../../library/config-check');
const { readConfig } = require('../../library/config-reader');

const ROOT = path.join(__dirname, '..', '..');

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'config-check-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function check(config) {
  return checkParsedConfig(config, { dataDir: tmp, environment: false });
}

const where = (list) => list.map(e => e.where);

let libraries = 0;
function library(text) {
  const file = path.join(tmp, `library-${++libraries}.yml`);
  fs.writeFileSync(file, text);
  return file;
}

function txConfig(extra = {}) {
  return {
    modules: {
      tx: {
        enabled: true,
        librarySource: library('base:\n  url: https://example.org\nsources:\n  - internal:lang\n  - npm:hl7.terminology=tho\n'),
        endpoints: [{ path: '/tx/r4', fhirVersion: '4.0' }],
        ...extra
      }
    }
  };
}

describe('config-check', () => {
  test('the command line flags', () => {
    expect(wantsCheck(['--check'])).toBe(true);
    expect(wantsCheck(['-t'])).toBe(true);
    expect(wantsCheck(['--role=master'])).toBe(false);
  });

  test('config-template.json, with every module enabled, has no errors or unknown settings', () => {
    const config = readConfig(path.join(ROOT, 'config-template.json'));
    for (const m of Object.values(config.modules)) {
      m.enabled = true;
    }
    // the template's paths are placeholders: point the ones that are checked at real files
    config.modules.tx.librarySource = path.join(ROOT, 'tx', 'tx.fhir.org.yml');
    delete config.modules.shl.certificates;
    delete config.modules.publisher['github-app'];
    config.modules.folder.folders = [];
    const report = check(config);
    expect(report.errors).toEqual([]);
    expect(report.warnings.filter(w => !w.where.startsWith('modules.publisher.sessionSecret'))).toEqual([]);
  });

  test('an unknown setting is a warning, with the setting it may have meant', () => {
    const report = check({ servr: {}, server: { port: 3000, prot: 1 }, ...txConfig({ cacheTimout: 30 }) });
    expect(report.ok).toBe(true);
    expect(where(report.warnings)).toEqual(expect.arrayContaining(['servr', 'server.prot', 'modules.tx.cacheTimout']));
    expect(report.warnings.find(w => w.where === 'modules.tx.cacheTimout').message).toContain('did you mean cacheTimeout?');
  });

  test('keys starting with _ or x- are parked, not unknown', () => {
    const report = check({ server: { 'x-webBase': 'http://example.org', _note: 'hi' } });
    expect(report.warnings).toEqual([]);
  });

  test('an unknown module is a warning', () => {
    const report = check({ modules: { txx: { enabled: true } } });
    expect(report.warnings[0].where).toBe('modules.txx');
    expect(report.warnings[0].message).toContain('did you mean tx?');
  });

  test('a disabled module is not checked', () => {
    const report = check({ modules: { tx: { enabled: false, cacheTimeout: 'soon', bogus: 1 } } });
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  test('types, ranges, allowed values and schedules', () => {
    const report = check({
      server: { port: 70000, memory: { rejectFraction: 1.5 } },
      logging: { level: 'loud' },
      modules: {
        packages: { enabled: true, database: 'p.db', crawler: { schedule: '61 * * * *', signatures: 'maybe', maxFiles: 0 } },
        ...txConfig({ cacheTimeout: 'soon', publishLibrarySource: 'yes' }).modules
      }
    });
    expect(where(report.errors).sort()).toEqual([
      'logging.level', 'modules.packages.crawler.maxFiles', 'modules.packages.crawler.schedule',
      'modules.packages.crawler.signatures', 'modules.tx.cacheTimeout', 'modules.tx.publishLibrarySource',
      'server.memory.rejectFraction', 'server.port'
    ]);
    expect(report.errors.find(e => e.where === 'server.port').message).toBe('must be at most 65535, not 70000');
  });

  test('a required setting', () => {
    const report = check({ modules: { tx: { enabled: true, endpoints: [{ fhirVersion: '4.0' }] } } });
    expect(where(report.errors)).toEqual(expect.arrayContaining(['modules.tx.librarySource', 'modules.tx.endpoints[0].path']));
  });

  test('a replaced setting is an error that names its replacement', () => {
    const report = check(txConfig({ ecosystemResolution: true }));
    expect(report.errors[0].where).toBe('modules.tx.ecosystemResolution');
    expect(report.errors[0].message).toContain('modules.tx.ecosystem');
  });

  test('a setting the server makes itself can\'t be in the file', () => {
    const report = check(txConfig({ clusterRole: 'master', vsacCfg: { apiKey: 'k', cluster: 'leader' } }));
    expect(where(report.errors).sort()).toEqual(['modules.tx.clusterRole', 'modules.tx.vsacCfg.cluster']);
  });

  test('the ecosystem block is checked as the tx module checks it', () => {
    const report = check(txConfig({ ecosystem: { use: 'yes', excludedServer: [] } }));
    expect(report.errors[0].message).toBe('use must be true or false, not "yes"');
    expect(report.warnings[0].message).toContain('did you mean excludedServers?');
  });

  test('the expansion limits go together', () => {
    expect(where(check(txConfig({ externalLimit: 200000 })).errors)).toEqual(['modules.tx.externalLimit']);
    expect(where(check(txConfig({ internalLimit: 5000, walkLimit: 4000, externalLimit: 100 })).errors)).toEqual(['modules.tx.walkLimit']);
    expect(check(txConfig({ internalLimit: 5000 })).errors).toEqual([]);
  });

  test('the library: missing', () => {
    const report = check(txConfig({ librarySource: path.join(tmp, 'none.yml') }));
    expect(report.errors[0].message).toContain('doesn\'t exist');
  });

  test('the library: its sources', () => {
    const file = library('base:\n  url: https://example.org\nsources:\n  - internal:lang\n  - nope:x\n  - npm:a=tho\n  - npm:b=tho\n  - npm:c=bad_prefix!\n  - folder:no/such/folder\n  - nocolon\n');
    const report = check(txConfig({ librarySource: file }));
    const messages = report.errors.map(e => e.message);
    expect(messages).toEqual(expect.arrayContaining([
      expect.stringContaining('\'nope\' is not a source type'),
      expect.stringContaining('the id prefix \'tho\' is also given for \'npm:a=tho\''),
      expect.stringContaining('doesn\'t exist'),
      expect.stringContaining('a source is type:details')
    ]));
    expect(report.errors.length).toBe(5);
  });

  test('the library: no base url, and YAML that doesn\'t parse', () => {
    expect(check(txConfig({ librarySource: library('sources:\n  - internal:lang\n') })).errors[0].message).toContain('no base: url:');
    expect(check(txConfig({ librarySource: library('base: [\n') })).errors[0].message).toContain('can\'t be read');
  });

  test('two endpoints with one path', () => {
    const report = check(txConfig({ endpoints: [{ path: '/r4', fhirVersion: '4.0' }, { path: '/r4/', fhirVersion: '4.0' }] }));
    expect(report.errors[0].message).toContain('given twice');
  });

  test('the data folder: one that isn\'t there yet is made by the server', () => {
    const report = checkParsedConfig({}, { dataDir: path.join(tmp, 'data'), environment: false });
    expect(report.ok).toBe(true);
    expect(report.notes.map(n => n.message)).toEqual(expect.arrayContaining([expect.stringContaining('the server will make it')]));
    expect(fs.existsSync(path.join(tmp, 'data'))).toBe(false);
  });

  test('the data folder: a file is not a folder', () => {
    const file = path.join(tmp, 'data');
    fs.writeFileSync(file, '');
    expect(checkParsedConfig({}, { dataDir: file, environment: false }).errors[0].message).toContain('is not a folder');
  });

  test('a daily report with no email', () => {
    expect(check({ dailyReport: { enabled: true, to: 'ops@example.org' } }).warnings[0].where).toBe('dailyReport');
  });

  test('the report reads like nginx -t', () => {
    const report = check({ server: { port: 0 }, servr: {} });
    const text = report.format('/data/config.json');
    expect(text).toContain('fhirsmith: [error] server.port: must be at least 1, not 0');
    expect(text).toContain('fhirsmith: [warn] servr: ');
    expect(text.split('\n').pop()).toBe('fhirsmith: the configuration file /data/config.json test failed (1 error, 1 warning)');
  });
});

describe('runCheck', () => {
  function run(config, argv = ['--check'], options = {}) {
    if (config !== undefined) {
      fs.writeFileSync(path.join(tmp, 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
    }
    let text = '';
    const code = runCheck(argv, { FHIRSMITH_DATA_DIR: tmp }, { out: (t) => { text += t; }, ...options });
    return { code, text };
  }

  test('no config.json', () => {
    const { code, text } = run(undefined);
    expect(code).toBe(1);
    expect(text).toContain('config.json: doesn\'t exist');
  });

  test('config.json that isn\'t JSON', () => {
    const { code, text } = run('{ "server": ');
    expect(code).toBe(1);
    expect(text).toContain('test failed');
  });

  test('with a role, what the role makes of it', () => {
    const config = txConfig();
    const { text } = run(config, ['--check', '--role=tx-worker']);
    expect(text).toContain('[error] role: A tx-worker needs its own instance code');
    expect(run(config, ['--check', '--role=master', '--instance-code=m0']).text).toContain('[info] role: master (instance code m0)');
  });

  test('the cluster: the launcher\'s settings, and each process', () => {
    const { loadSettings } = require('../../cluster');
    const config = txConfig({ instanceCode: 'm0' });
    config.server = { port: 3000 };
    const ok = run(config, ['--check', '--workers=2'], { cluster: true, loadSettings });
    expect(ok.text).toContain('[info] cluster: the launcher listens on port 3000; the master on 127.0.0.1:3001, 2 tx-workers on 3002-3003');
    const bad = run(config, ['--check', '--workers=x'], { cluster: true, loadSettings });
    expect(bad.code).toBe(1);
    expect(bad.text).toContain('[error] cluster: the number of workers');
    config.modules.tx.instanceCode = 'tx1';
    expect(run(config, ['--check', '--workers=2'], { cluster: true, loadSettings }).text).toContain('is also the code of a worker');
  });
});
