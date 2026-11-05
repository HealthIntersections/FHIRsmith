/**
 * cluster.js: the routing rules (as in nginx.md), least-loaded choice, restarts and the
 * drain on stop - against fake upstream processes (tests/utils/fake-upstream.js).
 */
const http = require('http');
const path = require('path');
const { loadSettings, classify, pickTarget, createLauncher } = require('../../cluster');

const FAKE = path.join(__dirname, '..', 'utils', 'fake-upstream.js');
const TX = ['/r4', '/r5'];
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function get(port, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, headers, agent: false }, (res) => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(body);
        } catch {
          // not JSON
        }
        resolve({ status: res.statusCode, headers: res.headers, json });
      });
    });
    req.on('error', reject);
  });
}

async function until(fn, ms = 10000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) {
      throw new Error('timed out');
    }
    await sleep(50);
  }
}

describe('routing rules', () => {
  test('cache-ids go to their issuer, by the prefix', () => {
    expect(classify('/r4/ValueSet/$validate-code', { 'x-cache-id': 'tx2.4f0c2d1e' }, TX)).toEqual({ to: 'owner', code: 'tx2' });
    expect(classify('/r5/CodeSystem/$lookup?x=1', { 'x-cache-id': 'm0.abc' }, TX)).toEqual({ to: 'owner', code: 'm0' });
    // no prefix: any tx process (it answers cache-id-unknown)
    expect(classify('/r4/ValueSet/$expand', { 'x-cache-id': '4f0c2d1e-aaaa' }, TX)).toEqual({ to: 'tx' });
    expect(classify('/r4/ValueSet/$expand', {}, TX)).toEqual({ to: 'tx' });
  });

  test('with the shared cache, a cache-id goes to any tx process, unless cacheAffinity is on', () => {
    const shared = loadSettings([], {}, { server: { cluster: { sharedCache: true } }, modules: { tx: { enabled: true } } }).routing;
    expect(shared).toEqual({ cacheAffinity: false, sharedClosure: false });
    expect(classify('/r4/ValueSet/$validate-code', { 'x-cache-id': 'tx2.4f0c2d1e' }, TX, shared)).toEqual({ to: 'tx' });
    const affinity = loadSettings([], {}, { server: { cluster: { sharedCache: true, cacheAffinity: true } }, modules: { tx: { enabled: true } } }).routing;
    expect(classify('/r4/ValueSet/$validate-code', { 'x-cache-id': 'tx2.4f0c2d1e' }, TX, affinity)).toEqual({ to: 'owner', code: 'tx2' });
    // without the shared cache, a cache-id always goes to its issuer: there is nowhere else it is
    const plain = loadSettings([], {}, { server: { cluster: { cacheAffinity: false } }, modules: { tx: { enabled: true } } }).routing;
    expect(plain).toEqual({ cacheAffinity: true, sharedClosure: false });
    expect(classify('/r4/ValueSet/$validate-code', { 'x-cache-id': 'tx2.4f0c2d1e' }, TX, plain)).toEqual({ to: 'owner', code: 'tx2' });
    // the master-only paths stay the master's
    expect(classify('/r4/$closure', { 'x-cache-id': 'tx2.4f0c2d1e' }, TX, shared)).toEqual({ to: 'master' });
    expect(classify('/', {}, TX, shared)).toEqual({ to: 'master' });
  });

  test('with the shared closure tables, $closure goes to any tx process; the rest of the master\'s paths stay its', () => {
    const routing = loadSettings([], {}, { server: { cluster: { sharedClosure: true } }, modules: { tx: { enabled: true } } }).routing;
    expect(routing).toEqual({ cacheAffinity: true, sharedClosure: true });
    for (const url of ['/r4/$closure', '/r5/%24closure', '/r4/$closure?name=x']) {
      expect(classify(url, { 'x-cache-id': 'tx1.abc' }, TX, routing)).toEqual({ to: 'tx' });
    }
    expect(classify('/r4/syndication', {}, TX, routing)).toEqual({ to: 'master' });
    expect(classify('/r4/info/vsac', {}, TX, routing)).toEqual({ to: 'master' });
    expect(classify('/xig', {}, TX, routing)).toEqual({ to: 'master' });
    // and cache-ids are routed as without it
    expect(classify('/r4/ValueSet/$expand', { 'x-cache-id': 'tx1.abc' }, TX, routing)).toEqual({ to: 'owner', code: 'tx1' });
  });

  test('$closure, in any FHIR version, encoded or not, goes to the master, whatever the cache-id', () => {
    for (const url of ['/r4/$closure', '/r5/$closure', '/r4/%24closure', '/r4/$closure?name=x']) {
      expect(classify(url, { 'x-cache-id': 'tx1.abc' }, TX)).toEqual({ to: 'master' });
    }
  });

  test('the syndication feed and the source info pages go to the master', () => {
    expect(classify('/r4/syndication', {}, TX)).toEqual({ to: 'master' });
    expect(classify('/r5/syndication/archive/2', {}, TX)).toEqual({ to: 'master' });
    expect(classify('/r4/info/vsac', {}, TX)).toEqual({ to: 'master' });
  });

  test('every path outside the tx endpoints goes to the master', () => {
    for (const url of ['/', '/health', '/packages/hl7.fhir.r4.core', '/tx-reg', '/xig', '/dashboard', '/r4x/metadata', '/r']) {
      expect(classify(url, { 'x-cache-id': 'tx1.abc' }, TX)).toEqual({ to: 'master' });
    }
  });

  test('least outstanding requests, among the ready tx processes', () => {
    const procs = [
      { code: 'm0', role: 'master', servesTx: true, ready: true, outstanding: 3 },
      { code: 'tx1', role: 'tx-worker', servesTx: true, ready: true, outstanding: 2 },
      { code: 'tx2', role: 'tx-worker', servesTx: true, ready: true, outstanding: 1 },
      { code: 'tx3', role: 'tx-worker', servesTx: true, ready: false, outstanding: 0 }
    ];
    expect(pickTarget({ to: 'tx' }, procs).code).toBe('tx2');
    expect(pickTarget({ to: 'owner', code: 'tx1' }, procs).code).toBe('tx1');
    // the owner isn't ready, or doesn't exist: the least loaded
    expect(pickTarget({ to: 'owner', code: 'tx3' }, procs).code).toBe('tx2');
    expect(pickTarget({ to: 'owner', code: 'zz9' }, procs).code).toBe('tx2');
    expect(pickTarget({ to: 'master' }, procs).code).toBe('m0');
    // a master that doesn't serve tx gets none of it
    procs[0].servesTx = false;
    procs[0].outstanding = 0;
    expect(pickTarget({ to: 'tx' }, procs).code).toBe('tx2');
    expect(pickTarget({ to: 'master' }, [procs[1]])).toBeNull();
  });

  test('settings from flags, environment and config', () => {
    const config = { server: { port: 20000, cluster: { workers: 3 } }, modules: { tx: { enabled: true, instanceCode: 'main', endpoints: [{ path: '/r4/' }] } } };
    const s = loadSettings([], {}, config);
    expect(s.port).toBe(20000);
    expect(s.txPaths).toEqual(['/r4']);
    expect(s.procs.map(p => [p.code, p.role, p.port, p.servesTx])).toEqual([
      ['main', 'master', 20001, true], ['tx1', 'tx-worker', 20002, true], ['tx2', 'tx-worker', 20003, true], ['tx3', 'tx-worker', 20004, true]]);
    const s2 = loadSettings(['--workers=1', '--port=20010', '--master-serves-tx=false'], {}, config);
    expect(s2.procs.map(p => [p.code, p.port, p.servesTx])).toEqual([['main', 20011, false], ['tx1', 20012, true]]);
    expect(() => loadSettings([], {}, { modules: { tx: { enabled: true, instanceCode: 'tx1' } } })).toThrow(/also the code of a worker/);
  });
});

describe('the launcher, with fake processes', () => {
  const PORT = 20013;
  let launcher;
  const settings = (servesTx) => ({
    port: PORT,
    txPaths: TX,
    drainMs: 10000,
    procs: [
      { name: 'master', role: 'master', code: 'm0', port: 20010, servesTx },
      { name: 'worker tx1', role: 'tx-worker', code: 'tx1', port: 20011, servesTx: true },
      { name: 'worker tx2', role: 'tx-worker', code: 'tx2', port: 20012, servesTx: true }
    ],
    command: (proc) => [process.execPath, [FAKE, proc.code, String(proc.port)]],
    log: () => {}
  });

  afterEach(async () => {
    if (launcher) {
      await launcher.stop();
      launcher = null;
    }
  });

  test('routes by the rules, and adds X-Forwarded-For', async () => {
    launcher = createLauncher(settings(true));
    await launcher.start();
    await until(() => launcher.procs.every(p => p.ready));
    expect((await get(PORT, '/packages')).json.code).toBe('m0');
    expect((await get(PORT, '/r4/$closure', { 'X-Cache-Id': 'tx2.x' })).json.code).toBe('m0');
    expect((await get(PORT, '/r4/metadata', { 'X-Cache-Id': 'tx2.x' })).json.code).toBe('tx2');
    expect((await get(PORT, '/r4/metadata', { 'X-Cache-Id': 'm0.x' })).json.code).toBe('m0');
    const r = await get(PORT, '/r4/metadata', { 'X-Forwarded-For': '203.0.113.9' });
    expect(r.json.xff).toBe('203.0.113.9, 127.0.0.1');
    expect(r.json.proto).toBe('http');
  });

  test('a tx request goes to the process with the fewest outstanding', async () => {
    launcher = createLauncher(settings(false));
    await launcher.start();
    await until(() => launcher.procs.every(p => p.ready));
    // a slow request on one worker: the next requests go to the other
    const slow = get(PORT, '/r4/ValueSet/$expand?delay=1500');
    await until(() => launcher.procs.some(p => p.outstanding === 1));
    const busy = launcher.procs.find(p => p.outstanding === 1).code;
    for (let i = 0; i < 5; i++) {
      const quick = await get(PORT, '/r4/ValueSet/$expand');
      expect(['tx1', 'tx2']).toContain(quick.json.code);
      expect(quick.json.code).not.toBe(busy);
    }
    expect((await slow).json.code).toBe(busy);
  });

  test('a process that exits is started again', async () => {
    launcher = createLauncher(settings(true));
    await launcher.start();
    await until(() => launcher.procs.every(p => p.ready));
    const tx1 = launcher.procs.find(p => p.code === 'tx1');
    const old = tx1.child;
    old.kill('SIGKILL');
    await until(() => !tx1.ready);
    // meanwhile its cache-ids go to another tx process, which says it doesn't know them
    expect(['m0', 'tx2']).toContain((await get(PORT, '/r4/metadata', { 'X-Cache-Id': 'tx1.x' })).json.code);
    await until(() => tx1.ready && tx1.child !== old);
    expect((await get(PORT, '/r4/metadata', { 'X-Cache-Id': 'tx1.x' })).json.code).toBe('tx1');
  });

  test('the master receives every process history, with a gap across a child restart', async () => {
    launcher = createLauncher(settings(true));
    await launcher.start();
    await until(() => launcher.procs.every(p => p.ready));
    const tx1 = launcher.procs.find(p => p.code === 'tx1');
    const old = tx1.child;
    const before = (await get(PORT, '/metrics')).json;
    expect(before.metrics.series.map(s => s.id)).toEqual(['m0', 'tx1', 'tx2']);
    expect(before.metrics.series.every(s => s.history.length)).toBe(true);
    const first = before.metrics.series[1].history[0];
    old.kill('SIGKILL');
    await until(() => !tx1.ready);
    expect(launcher.metrics.snapshot().series[1].status).toBe('restarting');
    await until(() => tx1.ready && tx1.child !== old);
    old.emit('message', { type:'fhirsmith:metric', startedAt:Date.now(), intervalMs:100,
      point:{ time:Date.now() + 10000, rpm:99999 } });
    const after = (await get(PORT, '/metrics')).json;
    expect(after.metrics.series[1].history).toContainEqual(first);
    expect(after.metrics.series[1].history.some(p => p.rpm === null)).toBe(true);
    expect(after.metrics.series[1].history.some(p => p.rpm === 99999)).toBe(false);
    expect(after.metrics.series[1].restarts).toBe(1);
    // Losing the observation channel does not remove the healthy request target.
    tx1.child.disconnect();
    await until(() => launcher.metrics.snapshot().series[1].status === 'unavailable');
    expect(tx1.ready).toBe(true);
    expect((await get(tx1.port, '/r4/metadata')).status).toBe(200);
  });

  test('coalesces backpressured snapshots and survives send failures', async () => {
    launcher = createLauncher(settings(true));
    await launcher.start();
    await until(() => launcher.procs.every(p => p.ready));
    const master = launcher.procs[0];
    await until(() => !master.metricsSending);
    const originalSend = master.child.send;
    const callbacks = [];
    const send = master.child.send = jest.fn((message, callback) => { callbacks.push(callback); return false; });
    await until(() => send.mock.calls.length === 1);
    await sleep(350);
    expect(send).toHaveBeenCalledTimes(1);
    callbacks.shift()();
    expect(send).toHaveBeenCalledTimes(2);
    // A disconnected channel can throw; statistics must not crash the launcher.
    send.mockImplementationOnce(() => { throw new Error('channel closed'); });
    launcher.procs[1].child.emit('message', { type:'fhirsmith:metric', startedAt:Date.now(), intervalMs:100,
      point:{ time:Date.now() + 10000, rpm:2 } });
    expect(() => callbacks.shift()()).not.toThrow();
    expect(send).toHaveBeenCalledTimes(3);
    master.child.send = originalSend;
  });

  test('stop drains: no new connections, the request in progress finishes, then the processes stop', async () => {
    launcher = createLauncher(settings(true));
    await launcher.start();
    await until(() => launcher.procs.every(p => p.ready));
    const children = launcher.procs.map(p => p.child);
    const slow = get(PORT, '/r4/ValueSet/$expand?delay=1500');
    await until(() => launcher.procs.some(p => p.outstanding === 1));
    const stopped = launcher.stop();
    await sleep(100);
    await expect(get(PORT, '/r4/metadata')).rejects.toThrow(/ECONNREFUSED/);
    // the processes are still running while the request is in progress
    expect(children.every(c => c.exitCode === null && c.signalCode === null)).toBe(true);
    const r = await slow;
    expect(r.status).toBe(200);
    expect(r.headers.connection).toBe('close');
    await stopped;
    expect(children.every(c => c.exitCode !== null || c.signalCode !== null)).toBe(true);
    launcher = null;
  });
});

describe('the launcher\'s keep-alive connections to the processes', () => {
  // a process that closes idle connections as Node's default does (5 s): the launcher must
  // close its idle ones first, or a request sent as the process closes one is reset
  const PORT = 20190;
  let launcher;
  afterEach(async () => {
    if (launcher) {
      await launcher.stop();
      launcher = null;
    }
  });

  test('an idle connection is closed by the launcher before the process closes it, and a long request is not cut', async () => {
    launcher = createLauncher({
      port: PORT,
      txPaths: TX,
      drainMs: 10000,
      procs: [
        { name: 'master', role: 'master', code: 'm0', port: 20191, servesTx: false },
        { name: 'worker tx1', role: 'tx-worker', code: 'tx1', port: 20192, servesTx: true }
      ],
      command: (proc) => [process.execPath, [FAKE, proc.code, String(proc.port), '5000']],
      log: () => {}
    });
    await launcher.start();
    await until(() => launcher.procs.every(p => p.ready));
    const tx1 = launcher.procs.find(p => p.code === 'tx1');
    const pooled = () => Object.values(tx1.agent.freeSockets).reduce((n, list) => n + list.length, 0);

    expect((await get(PORT, '/r4/ValueSet/$expand')).status).toBe(200);
    await until(() => pooled() === 1);
    // reused while it is fresh
    const before = (await get(PORT, '/r4/connections')).json.connections;
    expect((await get(PORT, '/r4/connections')).json.connections).toBe(before);
    // gone from the pool before the process's 5 s are up
    const idleSince = Date.now();
    await until(() => pooled() === 0, 6000);
    expect(Date.now() - idleSince).toBeLessThan(4900);
    // so a request at the moment the process would close it goes down a new connection
    await sleep(5000 - (Date.now() - idleSince));
    const r = await get(PORT, '/r4/connections');
    expect(r.status).toBe(200);
    expect(r.json.connections).toBeGreaterThan(before);

    // the idle limit doesn't apply to a request in progress
    const slow = await get(PORT, '/r4/ValueSet/$expand?delay=6000');
    expect(slow.status).toBe(200);
    expect(slow.json.code).toBe('tx1');
  }, 30000);
});
