/**
 * VSAC with --role (cluster.md): the master's provider (leader) syncs and bumps the
 * database's generation; a worker's (follower) never syncs, and when a request uses the
 * value sets it compares the generation with the one it loaded (at most once a second),
 * reloading only when it differs. Two real processes on one VSAC database.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');

const CHILD = path.join(__dirname, '..', 'utils', 'vsac-child.js');
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const vs = (id, version) => ({
  resourceType: 'ValueSet', id, url: `http://cts.nlm.nih.gov/fhir/ValueSet/${id}`, version, status: 'active',
  compose: { include: [{ system: 'http://loinc.org', concept: [{ code: '1-8' }] }] }
});

describe('VSAC value sets, master and worker', () => {
  let dir;
  const children = [];

  const spawn = (role) => {
    const child = fork(CHILD, [role], { env: { ...process.env, FHIRSMITH_DATA_DIR: dir }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    children.push(child);
    let seq = 0;
    const waiting = new Map();
    let readyResolve;
    const ready = new Promise(resolve => { readyResolve = resolve; });
    child.on('message', (m) => {
      if (m.ready) {
        readyResolve();
        return;
      }
      const w = waiting.get(m.seq);
      if (m.error) {
        w.reject(new Error(m.error));
      } else {
        w.resolve(m.result);
      }
    });
    const call = (op, args = {}) => new Promise((resolve, reject) => {
      const s = ++seq;
      waiting.set(s, { resolve, reject });
      child.send({ seq: s, op, ...args });
    });
    return ready.then(() => ({ call }));
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsac-gen-'));
  });
  afterEach(async () => {
    for (const c of children.splice(0)) {
      if (c.exitCode === null && c.signalCode === null) {
        await new Promise(resolve => {
          c.once('exit', resolve);
          c.kill();
        });
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('the worker picks up a sync on use, once, and only after it', async () => {
    // the master's first sync (of an empty VSAC) takes the generation to 1
    const a = await spawn('leader');
    expect(await a.call('init')).toBe('leader');
    const b = await spawn('follower');
    expect(await b.call('init')).toBe('follower');
    expect(await b.call('catchUpNow')).toBe(1);

    const url = 'http://cts.nlm.nih.gov/fhir/ValueSet/one';
    expect(await b.call('fetch', { url, version: '20250101' })).toBeNull();

    expect(await a.call('sync', { valueSets: [vs('one', '20250101')] })).toBe(2);
    expect(await a.call('fetch', { url, version: '20250101' })).toBe('20250101');

    // the worker notices on use, within a second or so (the check is throttled, and the
    // reload runs in the background, so the request that notices still has the old list)
    const before = await b.call('counts');
    let seen = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 5000 && !(seen = await b.call('fetch', { url, version: '20250101' }))) {
      await sleep(50);
    }
    expect(seen).toBe('20250101');
    expect(Date.now() - t0).toBeLessThan(2500);
    const after = await b.call('counts');
    expect(after.loaded).toBe(2);
    expect(after.reloads - before.reloads).toBe(1);

    // nothing changes: many uses over 1.5 s cost at most two generation reads, and no reload
    const quiet = await b.call('counts');
    const t1 = Date.now();
    let uses = 0;
    while (Date.now() - t1 < 1500) {
      await b.call('fetch', { url, version: '20250101' });
      uses++;
    }
    const end = await b.call('counts');
    expect(uses).toBeGreaterThan(20);
    expect(end.generationReads - quiet.generationReads).toBeLessThanOrEqual(2);
    expect(end.reloads).toBe(quiet.reloads);
  });

  test('a resync of one value set on the master reaches the worker', async () => {
    const a = await spawn('leader');
    await a.call('init');
    const b = await spawn('follower');
    await b.call('init');
    await a.call('sync', { valueSets: [vs('one', '1')] });
    expect(await b.call('catchUpNow')).toBe(2);
    const url = 'http://cts.nlm.nih.gov/fhir/ValueSet/one';
    expect(await a.call('resync', { url, valueSets: [vs('one', '1'), vs('one', '2')] })).toBe(3);
    expect(await b.call('catchUpNow')).toBe(3);
    expect(await b.call('fetch', { url, version: '2' })).toBe('2');
  });

  test('a worker started before the master has made the database leaves it alone', async () => {
    const b = await spawn('follower');
    expect(await b.call('init')).toBe('follower');
    expect(await b.call('catchUpNow')).toBeNull();
    expect(fs.existsSync(path.join(dir, 'terminology-cache', 'vsac', 'vsac-valuesets.db'))).toBe(false);
    const a = await spawn('leader');
    await a.call('init');
    expect(await b.call('catchUpNow')).toBe(1);
  });
});
