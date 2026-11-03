/**
 * XIG in cluster mode: one process downloads a new database and renames it over the
 * old file; another notices on its next request (at most one stat a second) that the
 * file is a different one, and opens it. An update asked of one process while another
 * is updating is skipped, not run twice over the same temporary file.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');
const Database = require('better-sqlite3');
const clusterState = require('../../library/cluster-state');

const CHILD = path.join(__dirname, '..', 'utils', 'xig-child.js');
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

describe('XIG database followed across processes', () => {
  let dir;
  let child;
  let call;

  const makeDb = (file) => {
    const db = new Database(file);
    db.exec('CREATE TABLE Resources (id INTEGER)');
    db.close();
  };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xig-follow-'));
    fs.mkdirSync(path.join(dir, 'xig'));
    makeDb(path.join(dir, 'xig', 'xig.db'));
    child = fork(CHILD, [], { env: { ...process.env, FHIRSMITH_DATA_DIR: dir }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
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
    call = (op) => new Promise((resolve, reject) => {
      const s = ++seq;
      waiting.set(s, { resolve, reject });
      child.send({ seq: s, op });
    });
    await ready;
  });

  afterEach(async () => {
    clusterState._configure();
    if (child.exitCode === null) {
      await new Promise(resolve => {
        child.once('exit', resolve);
        child.kill();
      });
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a replaced file is opened on the next request, after one stat', async () => {
    const first = await call('open');
    expect(first).toBe(fs.statSync(path.join(dir, 'xig', 'xig.db')).ino);
    // another process downloads and renames a new file over it
    makeDb(path.join(dir, 'xig', 'new.db'));
    fs.renameSync(path.join(dir, 'xig', 'new.db'), path.join(dir, 'xig', 'xig.db'));
    const second = fs.statSync(path.join(dir, 'xig', 'xig.db')).ino;
    expect(second).not.toBe(first);

    await call('use');
    let now = first;
    for (let i = 0; i < 40 && now !== second; i++) {
      await sleep(50);
      now = await call('inode');
    }
    expect(now).toBe(second);

    // replaced again straight away: requests within the second don't look
    makeDb(path.join(dir, 'xig', 'new.db'));
    fs.renameSync(path.join(dir, 'xig', 'new.db'), path.join(dir, 'xig', 'xig.db'));
    const third = fs.statSync(path.join(dir, 'xig', 'xig.db')).ino;
    await call('use');
    await sleep(100);
    expect(await call('inode')).toBe(second);
    await sleep(1000);
    await call('use');
    for (let i = 0; i < 40 && now !== third; i++) {
      await sleep(50);
      now = await call('inode');
    }
    expect(now).toBe(third);
  });

  test('an update is skipped while another process holds the update lease', async () => {
    await call('open');
    const before = await call('inode');
    clusterState._configure({ file: path.join(dir, 'cluster-state.db'), shared: true });
    let release;
    const held = clusterState.withLease('xig-update', () => new Promise(resolve => { release = resolve; }));
    await sleep(20);
    // returns at once, downloads nothing
    const t0 = Date.now();
    await call('update');
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(fs.existsSync(path.join(dir, 'xig', 'xig.db.tmp'))).toBe(false);
    expect(await call('inode')).toBe(before);
    release();
    await held;
  });
});
