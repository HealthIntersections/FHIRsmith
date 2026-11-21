/**
 * cluster.js on a new data directory whose package has no value set or concept map cache yet
 * (.valuesets-2.db and .conceptmaps-2.db removed): the master builds them before it is ready,
 * the workers only read them. Every process starts once - none exits and is restarted - and
 * neither cache file is written after the master is ready.
 *
 * The same for the caches of file: library sources: every process uses the master's
 * folder-source-master-<hash> folder, which the master builds before it is ready and the
 * workers only read.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startCluster, request, param } = require('../utils/cluster-harness');

const FRONT = 20150;
const VSAC = 20159;
const CORE = 'hl7.fhir.r4.core#4.0.1';
const CACHES = ['.valuesets-2.db', '.conceptmaps-2.db'];

describe('the package caches on a new data directory', () => {
  let cluster;
  const state = (file) => {
    const st = fs.statSync(file);
    return { mtimeMs: st.mtimeMs, size: st.size };
  };

  afterAll(async () => {
    if (cluster) {
      await cluster.stop();
    }
  });

  test('the master builds them, the workers read them and start once', async () => {
    let folder = null;
    cluster = await startCluster({
      front: FRONT, vsac: VSAC, workers: 2,
      sources: [`npm:${CORE}`],
      prepare: (dir) => {
        folder = path.join(dir, 'terminology-cache', CORE);
        for (const name of CACHES) {
          fs.rmSync(path.join(folder, name), { force: true });
        }
      }
    });
    const masterUp = cluster.upAt.get(cluster.master);
    const files = CACHES.map(name => path.join(folder, name));
    const before = files.map(state);
    for (const s of before) {
      // written by the master, before it was ready
      expect(s.mtimeMs).toBeLessThanOrEqual(masterUp);
    }

    // the workers serve the package's value sets
    for (const port of cluster.workers) {
      const r = await request(port, 'GET', '/r4/ValueSet?url=http://hl7.org/fhir/ValueSet/administrative-gender');
      expect(r.status).toBe(200);
      expect((r.json.entry || []).length).toBeGreaterThan(0);
    }

    expect(files.map(state)).toEqual(before);
    // no journal or WAL left by a writer
    for (const file of files) {
      for (const suffix of ['-journal', '-wal']) {
        expect(fs.existsSync(file + suffix)).toBe(false);
      }
    }
    const log = fs.readFileSync(path.join(cluster.dir, 'processes.log'), 'utf8');
    expect(log).not.toMatch(/exited \(/);
    expect(log).not.toMatch(/Backfilling content_hash/);
    expect(log).not.toMatch(/SQLITE_(BUSY|READONLY|IOERR)/);
  }, 600000);
});

describe('the caches of file: sources on a new data directory', () => {
  const FILE_FRONT = 20160;
  const FILE_VSAC = 20169;
  const SYSTEM = 'http://example.org/fhir/CodeSystem/cluster-file-source';
  const VS = 'http://example.org/fhir/ValueSet/cluster-file-source';
  let cluster;
  let fixtures;

  afterAll(async () => {
    if (cluster) {
      await cluster.stop();
    }
    if (fixtures) {
      fs.rmSync(fixtures, { recursive: true, force: true });
    }
  });

  // every file under the folder-source-* folders, with its mtime and size, and the folders'
  const snapshot = (cacheDir) => {
    const out = {};
    for (const name of fs.readdirSync(cacheDir).filter(n => n.startsWith('folder-source-')).sort()) {
      const dir = path.join(cacheDir, name);
      out[name] = fs.statSync(dir).mtimeMs;
      for (const file of fs.readdirSync(dir).sort()) {
        const st = fs.statSync(path.join(dir, file));
        out[name + '/' + file] = [st.mtimeMs, st.size];
      }
    }
    return out;
  };

  test('the master builds them in its folder, the workers read it and start once', async () => {
    fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-fx-'));
    fs.writeFileSync(path.join(fixtures, 'cs.json'), JSON.stringify({
      resourceType: 'CodeSystem', id: 'cluster-file-source', url: SYSTEM, version: '1.0.0',
      name: 'ClusterFileSource', status: 'active', content: 'complete',
      concept: [{ code: 'A', display: 'Alpha' }, { code: 'B', display: 'Beta' }]
    }));
    fs.writeFileSync(path.join(fixtures, 'vs.json'), JSON.stringify({
      resourceType: 'ValueSet', id: 'cluster-file-source', url: VS, version: '1.0.0',
      name: 'ClusterFileSource', status: 'active', compose: { include: [{ system: SYSTEM }] }
    }));
    cluster = await startCluster({
      front: FILE_FRONT, vsac: FILE_VSAC, workers: 2,
      sources: [`file:${path.join(fixtures, 'cs.json')}`, `file:${path.join(fixtures, 'vs.json')}`]
    });
    const cacheDir = path.join(cluster.dir, 'terminology-cache');
    const before = snapshot(cacheDir);
    const folders = Object.keys(before).filter(k => !k.includes('/'));
    // one folder per source, the master's, and nothing left from the build
    expect(folders).toHaveLength(2);
    for (const name of folders) {
      expect(name).toMatch(/^folder-source-master-[0-9a-f]{16}$/);
      expect(before[name + '/.valuesets-2.db']).toBeDefined();
    }

    const lookup = `/r4/CodeSystem/$lookup?system=${encodeURIComponent(SYSTEM)}&code=A`;
    for (const port of [...cluster.workers, cluster.front, cluster.front, cluster.front]) {
      const r = await request(port, 'GET', lookup);
      expect(r.status).toBe(200);
      expect(param(r.json, 'display').valueString).toBe('Alpha');
      const v = await request(port, 'GET', `/r4/ValueSet?url=${encodeURIComponent(VS)}`);
      expect(v.status).toBe(200);
      expect((v.json.entry || []).length).toBe(1);
    }

    // the workers wrote nothing
    expect(snapshot(cacheDir)).toEqual(before);
    const log = fs.readFileSync(path.join(cluster.dir, 'processes.log'), 'utf8');
    expect(log).not.toMatch(/exited \(/);
    expect(log).not.toMatch(/is not ready after/);
  }, 600000);
});
