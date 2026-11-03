/**
 * State several server processes share (library/cluster-state.js): logins, the secret
 * session cookies are signed with, rate limits, leases. The multi-process tests run two
 * real processes on one data directory, each serving the testing module, the way
 * cluster-mode workers do: a login made through one is used through the other.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');
const clusterState = require('../../library/cluster-state');

const CHILD = path.join(__dirname, '..', 'utils', 'cluster-state-child.js');

describe('with one process nothing is shared', () => {
  beforeEach(() => clusterState._configure({ shared: false }));
  afterEach(() => clusterState._configure());

  test('memory sessions, a random secret, memory rate limits', () => {
    expect(clusterState.isShared()).toBe(false);
    expect(clusterState.sessionStore('publisher')).toBeUndefined();
    expect(clusterState.sessionSecret('publisher')).not.toBe(clusterState.sessionSecret('publisher'));
    expect(clusterState.sessionSecret('publisher', 'configured')).toBe('configured');
    const opts = { windowMs: 1000, limit: 3 };
    expect(clusterState.rateLimitOptions('x', opts)).toBe(opts);
  });

  test('the server decides by whether the background-jobs lock is on', () => {
    clusterState._configure();
    const bj = require('../../library/background-jobs');
    expect(clusterState.isShared()).toBe(bj.enabled);
  });
});

describe('server.sharedState: one process opts in', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-state-opt-'));
  });
  afterEach(() => {
    clusterState._configure();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('off (the default): nothing shared; on: shared, and the secret is kept across a restart', () => {
    clusterState._configure({ file: path.join(dir, 'cluster-state.db') });
    clusterState.configure({});
    expect(clusterState.isShared()).toBe(false);
    expect(clusterState.sessionStore('testing')).toBeUndefined();
    expect(fs.existsSync(path.join(dir, 'cluster-state.db'))).toBe(false);

    clusterState.configure({ sharedState: true });
    expect(clusterState.isShared()).toBe(true);
    expect(clusterState.sessionStore('testing')).toBeDefined();
    const secret = clusterState.sessionSecret('testing');
    // a restart: the database is closed and opened again
    clusterState._configure({ file: path.join(dir, 'cluster-state.db') });
    clusterState.configure({ sharedState: true });
    expect(clusterState.sessionSecret('testing')).toBe(secret);
  });
});

describe('shared, in one process', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-state-'));
    clusterState._configure({ file: path.join(dir, 'cluster-state.db'), shared: true });
  });
  afterEach(() => {
    clusterState._configure();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('the secret is made once and kept; a configured one wins', () => {
    const s = clusterState.sessionSecret('ips');
    expect(s).toMatch(/^[0-9a-f]{128}$/);
    expect(clusterState.sessionSecret('ips')).toBe(s);
    expect(clusterState.sessionSecret('testing')).not.toBe(s);
    expect(clusterState.sessionSecret('ips', 'mine')).toBe('mine');
  });

  test('the rate limit store counts per key, within the window, and can go down', async () => {
    const { store } = clusterState.rateLimitOptions('t', { windowMs: 200 });
    store.init({ windowMs: 200 });
    expect((await store.increment('a')).totalHits).toBe(1);
    expect((await store.increment('a')).totalHits).toBe(2);
    expect((await store.increment('b')).totalHits).toBe(1);
    await store.decrement('a');
    expect((await store.get('a')).totalHits).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(await store.get('a')).toBeUndefined();
    expect((await store.increment('a')).totalHits).toBe(1);
    await store.resetAll();
    expect(await store.get('b')).toBeUndefined();
  });

  test('a lease times out while another holds it, and lapses when its holder stops renewing', async () => {
    let release;
    const held = clusterState.withLease('x', () => new Promise(resolve => { release = resolve; }), { ttlMs: 300 });
    await new Promise(resolve => setTimeout(resolve, 20));
    await expect(clusterState.withLease('x', async () => 1, { timeoutMs: 100 })).rejects.toMatchObject({ leaseTimeout: true });
    release();
    await held;
    expect(await clusterState.withLease('x', async () => 2, { timeoutMs: 100 })).toBe(2);
  });
});

describe('two processes on one data directory', () => {
  let dir;
  const children = [];

  const spawn = (mode = 'cluster') => {
    const child = fork(CHILD, [dir, mode], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    children.push(child);
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    let seq = 0;
    const waiting = new Map();
    let readyResolve;
    let readyReject;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    child.on('exit', (code) => readyReject(new Error(`child exited (${code}): ${stderr}`)));
    child.on('message', (m) => {
      if (m.ready) {
        readyResolve(m.ready);
      } else {
        waiting.get(m.seq)(m.result);
      }
    });
    const call = (op, args = {}) => new Promise(resolve => {
      const s = ++seq;
      waiting.set(s, resolve);
      child.send({ seq: s, op, ...args });
    });
    const stop = () => new Promise(resolve => {
      child.once('exit', resolve);
      child.kill();
    });
    return ready.then(port => ({ port, call, stop, base: `http://127.0.0.1:${port}/testing` }));
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-state-mp-'));
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

  // a browser: cookies kept by name, whichever process set them
  const browser = () => {
    const jar = new Map();
    const go = async (url, opts = {}) => {
      const headers = { ...(opts.headers || {}) };
      if (jar.size) {
        headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      }
      const res = await fetch(url, { ...opts, headers, redirect: 'manual' });
      for (const c of res.headers.getSetCookie()) {
        const [kv] = c.split(';');
        const i = kv.indexOf('=');
        jar.set(kv.substring(0, i), kv.substring(i + 1));
      }
      return { status: res.status, text: await res.text(), location: res.headers.get('location') };
    };
    const csrf = async (base) => (await go(`${base}/login`)).text.match(/name="_csrf" value="([^"]+)"/)[1];
    const post = async (base, url, data) => go(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: new URL(base).origin },
      body: new URLSearchParams({ ...data, _csrf: await csrf(base) }).toString()
    });
    return { go, post };
  };

  test('a login made on one process is used, and ended, on the other', async () => {
    const [a, b] = await Promise.all([spawn(), spawn()]);
    expect(await a.call('secret')).toBe(await b.call('secret'));

    const me = browser();
    // the CSRF token comes from a page served by A; the login is posted to B
    const csrfFromA = await me.go(`${a.base}/login`).then(r => r.text.match(/name="_csrf" value="([^"]+)"/)[1]);
    const login = await me.go(`${b.base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: `http://127.0.0.1:${b.port}` },
      body: new URLSearchParams({ login: 'admin', password: 'admin-secret', _csrf: csrfFromA }).toString()
    });
    expect(login.status).toBe(302);
    // logged in on both
    expect((await me.go(`${a.base}`)).text).toContain('Logged in as <b>Administrator</b>');
    expect((await me.go(`${b.base}`)).text).toContain('Logged in as <b>Administrator</b>');
    expect((await me.go(`${a.base}/admin/users`)).status).toBe(200);
    // logged out on A: B no longer knows the session either
    expect((await me.post(a.base, `${a.base}/logout`, {})).status).toBe(302);
    expect((await me.go(`${b.base}/admin/users`)).status).toBe(302);
  });

  test('the login rate limit counts the attempts both processes saw', async () => {
    const [a, b] = await Promise.all([spawn(), spawn()]);
    const me = browser();
    const statuses = [];
    // the limit is 5 per window: three wrong passwords at A, two at B, then the sixth is refused
    for (const p of [a, a, a, b, b, b]) {
      statuses.push((await me.post(p.base, `${p.base}/login`, { login: 'admin', password: 'wrong' })).status);
    }
    expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
  });

  // one process, stopped and started again: is the login still good?
  const loginSurvivesRestart = async (mode) => {
    const first = await spawn(mode);
    const me = browser();
    const login = await me.post(first.base, `${first.base}/login`, { login: 'admin', password: 'admin-secret' });
    expect(login.status).toBe(302);
    expect((await me.go(`${first.base}/admin/users`)).status).toBe(200);
    await first.stop();
    const second = await spawn(mode);
    return (await me.go(`${second.base}/admin/users`)).status === 200;
  };

  test('one process by default: a login ends with a restart (as on main)', async () => {
    expect(await loginSurvivesRestart('off')).toBe(false);
    expect(fs.existsSync(path.join(dir, 'cluster-state.db'))).toBe(false);
  });

  test('one process with server.sharedState: a login survives a restart', async () => {
    expect(await loginSurvivesRestart('opt-in')).toBe(true);
  });

  test('a lease is held by one process at a time', async () => {
    const [a, b] = await Promise.all([spawn(), spawn()]);
    await Promise.all([a.call('lease', { times: 5, ms: 15 }), b.call('lease', { times: 5, ms: 15 })]);
    const events = fs.readFileSync(path.join(dir, 'lease.log'), 'utf8').trim().split('\n').map(l => l.split(' '));
    expect(events).toHaveLength(20);
    // in, out, in, out ... and each out is by the process that went in
    for (let i = 0; i < events.length; i += 2) {
      expect(events[i][1]).toBe('in');
      expect(events[i + 1][1]).toBe('out');
      expect(events[i + 1][0]).toBe(events[i][0]);
    }
    expect(new Set(events.map(e => e[0])).size).toBe(2);
  });
});
