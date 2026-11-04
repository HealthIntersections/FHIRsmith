/**
 * cluster.js on a new data directory whose package has no value set or concept map cache yet
 * (.valuesets-2.db and .conceptmaps-2.db removed): the master builds them before it is ready,
 * the workers only read them. Every process starts once - none exits and is restarted - and
 * neither cache file is written after the master is ready.
 */
const fs = require('fs');
const path = require('path');
const { startCluster, request } = require('../utils/cluster-harness');

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
