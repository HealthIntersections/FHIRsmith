/**
 * cluster.js: the routing rules (as in nginx.md), least-loaded choice, restarts and the
 * drain on stop - against fake upstream processes (tests/utils/fake-upstream.js).
 */
const http = require('http');
const path = require('path');
const { loadSettings, classify, isFastLane, pickTarget, createLauncher, memorySampler } = require('../../cluster');
const { defaultWorkers } = require('../../library/worker-count');
const memoryGuard = require('../../library/memory-guard');

const FAKE = path.join(__dirname, '..', 'utils', 'fake-upstream.js');
const TX = ['/r4', '/r5'];
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function get(port, urlPath, headers = {}, { method = 'GET', agent = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, headers, method, agent }, (res) => {
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
    req.end();
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

  test('the fast lane: GET of metadata, $lookup, $subsumes, $validate-code; a POST of those by Content-Length', () => {
    const fast = (method, url, headers = {}, maxBytes = 0) => isFastLane({ method, url, headers }, TX, maxBytes);
    expect(fast('GET', '/r4/CodeSystem/$lookup?system=http://loinc.org&code=1')).toBe(true);
    expect(fast('GET', '/r5/metadata')).toBe(true);
    // a read is not: a large CodeSystem is costly to render
    expect(fast('GET', '/r4/CodeSystem/abc-1')).toBe(false);
    expect(fast('GET', '/r4/ValueSet/abc/$validate-code?code=1')).toBe(true);
    expect(fast('GET', '/r4/CodeSystem/%24subsumes?codeA=1')).toBe(true);
    // search, $expand and anything else: not
    expect(fast('GET', '/r4/ValueSet?url=x')).toBe(false);
    expect(fast('GET', '/r4/ValueSet/$expand?url=x')).toBe(false);
    expect(fast('GET', '/fhir/metadata')).toBe(false);
    // a POST: only up to fastLaneMaxBytes (0: never), and only with a Content-Length
    expect(fast('POST', '/r4/CodeSystem/$validate-code', { 'content-length': '400' })).toBe(false);
    expect(fast('POST', '/r4/CodeSystem/$validate-code', { 'content-length': '400' }, 1024)).toBe(true);
    expect(fast('POST', '/r4/ValueSet/$validate-code', { 'content-length': '5000' }, 1024)).toBe(false);
    expect(fast('POST', '/r4/ValueSet/$validate-code', { 'transfer-encoding': 'chunked' }, 1024)).toBe(false);
    expect(fast('POST', '/r4/ValueSet/$expand', { 'content-length': '10' }, 1024)).toBe(false);
  });

  test('with the shared cache, a cache-id goes to any tx process, unless cacheAffinity is on', () => {
    const shared = loadSettings([], {}, { server: { cluster: { sharedCache: true } }, modules: { tx: { enabled: true } } }).routing;
    expect(shared).toEqual({ cacheAffinity: false, sharedClosure: false, sharedCache: true });
    expect(classify('/r4/ValueSet/$validate-code', { 'x-cache-id': 'tx2.4f0c2d1e' }, TX, shared)).toEqual({ to: 'tx' });
    const affinity = loadSettings([], {}, { server: { cluster: { sharedCache: true, cacheAffinity: true } }, modules: { tx: { enabled: true } } }).routing;
    expect(classify('/r4/ValueSet/$validate-code', { 'x-cache-id': 'tx2.4f0c2d1e' }, TX, affinity)).toEqual({ to: 'owner', code: 'tx2' });
    // without the shared cache, a cache-id always goes to its issuer: there is nowhere else it is
    const plain = loadSettings([], {}, { server: { cluster: { cacheAffinity: false } }, modules: { tx: { enabled: true } } }).routing;
    expect(plain).toEqual({ cacheAffinity: true, sharedClosure: false, sharedCache: false });
    expect(classify('/r4/ValueSet/$validate-code', { 'x-cache-id': 'tx2.4f0c2d1e' }, TX, plain)).toEqual({ to: 'owner', code: 'tx2' });
    // the master-only paths stay the master's
    expect(classify('/r4/$closure', { 'x-cache-id': 'tx2.4f0c2d1e' }, TX, shared)).toEqual({ to: 'master' });
    expect(classify('/', {}, TX, shared)).toEqual({ to: 'master' });
  });

  test('with the shared closure tables, $closure goes to any tx process; the rest of the master\'s paths stay its', () => {
    const routing = loadSettings([], {}, { server: { cluster: { sharedClosure: true } }, modules: { tx: { enabled: true } } }).routing;
    expect(routing).toEqual({ cacheAffinity: true, sharedClosure: true, sharedCache: false });
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
    // one that answered 503 lately is passed over, unless every one did; an owner is not
    procs[2].coolUntil = Date.now() + 5000;
    expect(pickTarget({ to: 'tx' }, procs).code).toBe('tx1');
    expect(pickTarget({ to: 'owner', code: 'tx2' }, procs).code).toBe('tx2');
    procs[1].coolUntil = procs[2].coolUntil;
    expect(pickTarget({ to: 'tx' }, procs).code).toBe('tx2');
    // the least loaded of those with room for the request, whatever their counts; an owner
    // is still the owner
    const room = (p) => p.code !== 'tx2';
    expect(pickTarget({ to: 'tx' }, procs, room).code).toBe('tx1');
    expect(pickTarget({ to: 'owner', code: 'tx2' }, procs, room).code).toBe('tx2');
    // none with room: the least loaded, where the request waits
    expect(pickTarget({ to: 'tx' }, procs, () => false).code).toBe('tx2');
  });

  test('the launcher\'s threshold is the memory guard\'s', () => {
    for (const memory of [{}, { rejectFraction: 0.7 }, { rejectFraction: 2 }]) {
      expect(memorySampler(memory).rejectAt).toBe(memoryGuard.thresholds({ ...memory, group: true }).rejectAt);
    }
    expect(memorySampler({ rejectFraction: 0.7 }).describe).toMatch(/^over [\d.]+ GB \(70% of /);
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
    // the queue: 16 sent to a process at once, 1 s waiting for one
    expect([s.maxOutstanding, s.queueMs]).toEqual([16, 1000]);
    const s3 = loadSettings([], {}, { ...config, server: { cluster: { maxOutstanding: 4, queueSeconds: 1.5 } } });
    expect([s3.maxOutstanding, s3.queueMs]).toEqual([4, 1500]);
    expect(s.ownerQueueMs).toBe(30000);
    // 0 is 0: no limit, refuse at once
    const s4 = loadSettings([], {}, { ...config, server: { cluster: { maxOutstanding: 0, queueSeconds: 0, ownerQueueSeconds: 0 } } });
    expect([s4.maxOutstanding, s4.queueMs, s4.ownerQueueMs]).toEqual([0, 0, 0]);
    expect([s.cooldownMs, loadSettings([], {}, { ...config, server: { cluster: { cooldownSeconds: 0 } } }).cooldownMs]).toEqual([2000, 0]);
    // a process that hasn't begun its response: 504 after 60 s; 0 is none
    expect([s.upstreamTimeoutMs, ...[0, 2.5].map(v => loadSettings([], {}, { ...config, server: { cluster: { upstreamTimeoutSeconds: v } } }).upstreamTimeoutMs)]).toEqual([60000, 0, 2500]);
    // a tx-worker stuck over the refusal threshold: restarted after 30 s; 0 is never
    expect([s.recycleMs, loadSettings([], {}, { ...config, server: { cluster: { recycleSeconds: 0 } } }).recycleMs]).toEqual([30000, 0]);
    expect(loadSettings([], {}, { ...config, server: { memory: { rejectFraction: 0.8 } } }).memory).toEqual({ rejectFraction: 0.8 });
    // the number of workers given or not (sized to memory); 2 GB left free when idle
    expect([s.workersDefault, loadSettings([], {}, { ...config, server: {} }).workersDefault, loadSettings(['--workers=2'], {}, { ...config, server: {} }).workersDefault]).toEqual([false, true, false]);
    expect([s.headroomBytes, loadSettings([], {}, { ...config, server: { cluster: { memoryHeadroomGB: 3 } } }).headroomBytes]).toEqual([2 * 2 ** 30, 3 * 2 ** 30]);
    expect([s.fastLaneExtra, s.fastLaneMaxBytes, s.normalMinSlots]).toEqual([4, 1024, 4]);
    const s5 = loadSettings([], {}, { ...config, server: { cluster: { fastLaneExtra: 0, fastLaneMaxBytes: 0, normalMinSlots: 0 } } });
    expect([s5.fastLaneExtra, s5.fastLaneMaxBytes, s5.normalMinSlots]).toEqual([0, 0, 0]);
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

  test('a chunked body on a GET goes on chunked: it can\'t be read as a second request (request smuggling)', async () => {
    launcher = createLauncher({ ...settings(true), procs: settings(true).procs.slice(0, 1) });
    await launcher.start();
    await until(() => launcher.procs.every(p => p.ready));
    const hidden = 'GET /r4/hidden HTTP/1.1\r\nHost: x\r\n\r\n';
    for (const method of ['GET', 'DELETE', 'OPTIONS']) {
      const raw = await new Promise((resolve, reject) => {
        const socket = require('net').connect(PORT, '127.0.0.1', () => {
          socket.write(`${method} /r4/metadata HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n` +
            `${Buffer.byteLength(hidden).toString(16)}\r\n${hidden}\r\n0\r\n\r\n`);
        });
        let data = '';
        socket.on('data', d => { data += d; });
        socket.on('end', () => resolve(data));
        socket.on('error', reject);
      });
      expect(raw).toMatch(/^HTTP\/1\.1 200 /);
      // the process read the body as a body
      expect(JSON.parse(raw.substring(raw.indexOf('\r\n\r\n') + 4).replace(/^[0-9a-f]+\r\n|\r\n0\r\n\r\n$/g, '')).body).toBe(hidden);
    }
    const seen = (await get(PORT, '/r4/seen')).json.seen;
    expect(seen).toEqual(['GET /r4/metadata', 'DELETE /r4/metadata', 'OPTIONS /r4/metadata']);
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
    // meanwhile its cache-ids are answered at once: the cache was lost with the process
    const lost = await get(PORT, '/r4/metadata', { 'X-Cache-Id': 'tx1.x' });
    expect(lost.status).toBe(404);
    expect(lost.json.issue[0].details.coding[0].code).toBe('cache-id-unknown');
    expect(lost.json.issue[0].extension[0].valueString).toBe('CACHE_ID_LOST_TO_RESTART');
    expect(lost.json.issue[0].details.text).toMatch(/^The cache 'tx1\.x' was lost to a server restart \d+ s ago: instance 'tx1', which issued it, is restarting/);
    // an unknown prefix still goes to any tx process, which says it doesn't know it
    expect(['m0', 'tx1', 'tx2']).toContain((await get(PORT, '/r4/metadata', { 'X-Cache-Id': 'zz9.x' })).json.code);
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

  describe('at most maxOutstanding tx requests on a process; the rest wait', () => {
    const queued = (queueMs) => ({ ...settings(false), maxOutstanding: 1, queueMs });
    const busy = async (n, headers = {}) => {
      const slow = [];
      for (let i = 0; i < n; i++) {
        slow.push(get(PORT, '/r4/ValueSet/$expand?delay=1000', headers));
      }
      await until(() => launcher.procs.reduce((t, p) => t + p.outstanding, 0) === n);
      return slow;
    };

    test('a request waits while every process is full, and goes when one has room', async () => {
      launcher = createLauncher(queued(5000));
      await launcher.start();
      await until(() => launcher.procs.every(p => p.ready));
      const slow = await busy(2);
      const t0 = Date.now();
      const r = await get(PORT, '/r4/ValueSet/$expand');
      expect(r.status).toBe(200);
      expect(['tx1', 'tx2']).toContain(r.json.code);
      expect(Date.now() - t0).toBeGreaterThan(500);
      // each process had at most one at a time
      expect((await Promise.all(slow)).map(x => x.status)).toEqual([200, 200]);
    });

    test('one that has waited queueSeconds gets 503 and Retry-After, without waiting longer', async () => {
      launcher = createLauncher(queued(300));
      await launcher.start();
      await until(() => launcher.procs.every(p => p.ready));
      const slow = await busy(2);
      const t0 = Date.now();
      const r = await get(PORT, '/r4/ValueSet/$expand');
      const waited = Date.now() - t0;
      expect(r.status).toBe(503);
      expect(r.headers['retry-after']).toBe('5');
      expect(r.headers.connection).toBe('close');
      expect(r.json.issue[0].code).toBe('transient');
      expect(waited).toBeGreaterThanOrEqual(250);
      expect(waited).toBeLessThan(900);
      await Promise.all(slow);
      // and nothing is left waiting or counted
      expect(launcher.procs.every(p => p.outstanding === 0)).toBe(true);
    });

    test('a request with a cache-id waits for its issuer; one without goes to a process with room', async () => {
      launcher = createLauncher(queued(5000));
      await launcher.start();
      await until(() => launcher.procs.every(p => p.ready));
      const slow = await busy(1, { 'X-Cache-Id': 'tx1.x' });
      const cached = get(PORT, '/r4/ValueSet/$expand', { 'X-Cache-Id': 'tx1.x' });
      const plain = await get(PORT, '/r4/ValueSet/$expand');
      expect(plain.json.code).toBe('tx2');
      expect((await cached).json.code).toBe('tx1');
      await Promise.all(slow);
    });

    test('a request with a cache-id waits for its issuer longer than ownerless ones', async () => {
      launcher = createLauncher({ ...queued(300), ownerQueueMs: 5000 });
      await launcher.start();
      await until(() => launcher.procs.every(p => p.ready));
      const slow = await busy(2);
      const cached = await get(PORT, '/r4/ValueSet/$expand', { 'X-Cache-Id': 'tx1.x' });
      expect([cached.status, cached.json.code]).toEqual([200, 'tx1']);
      await Promise.all(slow);
    });

    test('maxOutstanding 0: no limit; queueSeconds 0: 503 at once', async () => {
      launcher = createLauncher(queued(0));
      await launcher.start();
      await until(() => launcher.procs.every(p => p.ready));
      const slow = await busy(2);
      const t0 = Date.now();
      expect((await get(PORT, '/r4/ValueSet/$expand')).status).toBe(503);
      expect(Date.now() - t0).toBeLessThan(200);
      await Promise.all(slow);
      await launcher.stop();
      launcher = createLauncher({ ...queued(0), maxOutstanding: 0 });
      await launcher.start();
      await until(() => launcher.procs.every(p => p.ready));
      expect((await Promise.all(await busy(4))).map(x => x.status)).toEqual([200, 200, 200, 200]);
    });

    test('the fast lane: fastLaneExtra more slots, ahead of the rest, but leaving the others normalMinSlots', async () => {
      launcher = createLauncher({ ...queued(5000), fastLaneExtra: 1, normalMinSlots: 1 });
      await launcher.start();
      await until(() => launcher.procs.every(p => p.ready));
      const txProcs = launcher.procs.filter(p => p.servesTx);
      const slow = await busy(2);
      const t0 = Date.now();
      expect((await get(PORT, '/r4/CodeSystem/$lookup?code=1')).status).toBe(200);
      expect(Date.now() - t0).toBeLessThan(500);
      // every slot full, each process with its one normal request: a heavy request waits, then
      // a lookup, which takes the first slot the lane frees
      const lanes = [get(PORT, '/r4/CodeSystem/$lookup?delay=300'), get(PORT, '/r4/CodeSystem/$lookup?delay=300')];
      await until(() => txProcs.every(p => p.outstanding === 2));
      const order = [];
      const heavy = get(PORT, '/r4/ValueSet/$expand').then(r => order.push('expand') && r);
      await sleep(50);
      const lookup = get(PORT, '/r4/CodeSystem/$lookup').then(r => order.push('lookup') && r);
      expect((await Promise.all([heavy, lookup, ...lanes, ...slow])).map(r => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
      expect(order).toEqual(['lookup', 'expand']);
      // every slot full of lookups: a heavy request waiting gets the next free slot, ahead of a lookup
      const flood = [1000, 1500, 2000, 2500].map(ms => get(PORT, `/r4/CodeSystem/$lookup?delay=${ms}`));
      await until(() => txProcs.every(p => p.outstanding === 2 && p.fastOutstanding === 2));
      const order2 = [];
      const heavy2 = get(PORT, '/r4/ValueSet/$expand?delay=300').then(r => order2.push('expand') && r);
      await sleep(50);
      const lookup2 = get(PORT, '/r4/CodeSystem/$lookup?delay=300').then(r => order2.push('lookup') && r);
      expect((await Promise.all([heavy2, lookup2, ...flood])).map(r => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
      expect(order2).toEqual(['expand', 'lookup']);
      expect(launcher.procs.every(p => p.outstanding === 0 && p.fastOutstanding === 0)).toBe(true);
      await launcher.stop();
      // fastLaneExtra 0: no lane
      launcher = createLauncher({ ...queued(300), fastLaneExtra: 0 });
      await launcher.start();
      await until(() => launcher.procs.every(p => p.ready));
      const slow2 = await busy(2);
      expect((await get(PORT, '/r4/CodeSystem/$lookup')).status).toBe(503);
      await Promise.all(slow2);
    });

    test('a CORS preflight doesn\'t wait', async () => {
      launcher = createLauncher(queued(5000));
      await launcher.start();
      await until(() => launcher.procs.every(p => p.ready));
      const slow = await busy(2);
      const t0 = Date.now();
      expect((await get(PORT, '/r4/ValueSet/$expand', {}, { method: 'OPTIONS' })).status).toBe(200);
      expect(Date.now() - t0).toBeLessThan(500);
      await Promise.all(slow);
    });

    test('a process that answered 503 gets no new requests while another can take them', async () => {
      launcher = createLauncher(settings(false));
      await launcher.start();
      await until(() => launcher.procs.every(p => p.ready));
      const refused = await get(PORT, '/r4/ValueSet/$expand?status=503');
      expect(refused.status).toBe(503);
      const other = refused.json.code === 'tx1' ? 'tx2' : 'tx1';
      for (let i = 0; i < 4; i++) {
        expect((await get(PORT, '/r4/ValueSet/$expand')).json.code).toBe(other);
      }
      // both refusing: they still get the requests
      expect((await get(PORT, '/r4/ValueSet/$expand?status=503')).json.code).toBe(other);
      expect((await get(PORT, '/r4/ValueSet/$expand')).status).toBe(200);
    });

    test('cooldownSeconds 0: a process that answered 503 still gets requests; the limits are logged', async () => {
      const lines = [];
      launcher = createLauncher({ ...settings(false), cooldownMs: 0, log: (m) => lines.push(m) });
      await launcher.start();
      await until(() => launcher.procs.every(p => p.ready));
      expect(lines.filter(l => l.startsWith('limits:'))).toEqual([expect.stringMatching(
        /^limits: maxOutstanding 16, queueSeconds 1, ownerQueueSeconds 30, cooldownSeconds 0, upstreamTimeoutSeconds 60, fastLaneExtra 4, fastLaneMaxBytes 1024, normalMinSlots 4, memoryHeadroomGB 2, drainSeconds 10, trimAllocator true, recycleSeconds 30 \(a tx-worker over [\d.]+ GB \(85% of [\d.]+ GB\) for the (whole cgroup|process) that long, with no request at work, is restarted\)$/)]);
      await get(PORT, '/r4/ValueSet/$expand?status=503');
      expect(launcher.procs.every(p => !p.coolUntil)).toBe(true);
    });

    test('while stopping, a new request on a kept-alive connection gets 503, not a place in the queue', async () => {
      launcher = createLauncher(queued(5000));
      await launcher.start();
      await until(() => launcher.procs.every(p => p.ready));
      const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
      expect((await get(PORT, '/packages', {}, { agent })).status).toBe(200);
      const slow = await busy(2);
      // as a client that sends just before the launcher closes its idle connection
      launcher.server.closeIdleConnections = () => {};
      const stopped = launcher.stop();
      const r = await get(PORT, '/r4/ValueSet/$expand', {}, { agent });
      expect(r.status).toBe(503);
      expect(r.json.issue[0].diagnostics).toMatch(/stopping/);
      expect((await Promise.all(slow)).map(x => x.status)).toEqual([200, 200]);
      agent.destroy();
      await stopped;
      launcher = null;
    });

    test('the master\'s own paths don\'t wait', async () => {
      launcher = createLauncher(queued(5000));
      await launcher.start();
      await until(() => launcher.procs.every(p => p.ready));
      const slow = await busy(2);
      const t0 = Date.now();
      expect((await get(PORT, '/packages')).json.code).toBe('m0');
      expect(Date.now() - t0).toBeLessThan(500);
      await Promise.all(slow);
    });

    test('on stop, the requests still waiting are refused at once', async () => {
      launcher = createLauncher(queued(5000));
      await launcher.start();
      await until(() => launcher.procs.every(p => p.ready));
      const slow = await busy(2);
      const waiting = get(PORT, '/r4/ValueSet/$expand');
      await sleep(100);
      const stopped = launcher.stop();
      const r = await waiting;
      expect(r.status).toBe(503);
      expect((await Promise.all(slow)).map(x => x.status)).toEqual([200, 200]);
      await stopped;
      launcher = null;
    });
  });

  describe('a process that doesn\'t begin its response in upstreamTimeoutSeconds', () => {
    const OUTCOME = /^The worker tx1 process did not begin its response in 0\.5 s \(server\.cluster\.upstreamTimeoutSeconds\)/;
    const timed = async (urlPath) => {
      const t0 = Date.now();
      const r = await get(PORT, urlPath);
      return { ...r, ms: Date.now() - t0 };
    };

    test('a wedged worker: 504 within the timeout, the others keep serving, and after 3 in a row it is routed around', async () => {
      const lines = [];
      launcher = createLauncher({
        ...settings(false), upstreamTimeoutMs: 500, log: (m) => lines.push(m),
        command: (proc) => [process.execPath, [FAKE, proc.code, String(proc.port), '', proc.code === 'tx1' ? 'hang' : '']]
      });
      await launcher.start();
      await until(() => launcher.procs.every(p => p.ready));
      const tx1 = launcher.procs.find(p => p.code === 'tx1');
      const results = [];
      while (results.filter(r => r.status === 504).length < 3) {
        expect(results.length).toBeLessThan(10);
        results.push(await timed('/r4/ValueSet/$expand'));
      }
      for (const r of results) {
        if (r.status === 504) {
          expect(r.ms).toBeGreaterThanOrEqual(450);
          expect(r.ms).toBeLessThan(1500);
          expect(r.json.issue[0].code).toBe('timeout');
          expect(r.json.issue[0].details.text).toMatch(OUTCOME);
        } else {
          expect([r.status, r.json.code]).toEqual([200, 'tx2']);
        }
      }
      // its slots are free; it cools, and the next requests all go to tx2, at once
      expect(tx1.outstanding).toBe(0);
      expect(tx1.coolUntil).toBeGreaterThan(Date.now());
      for (let i = 0; i < 4; i++) {
        const r = await timed('/r4/ValueSet/$expand');
        expect([r.status, r.json.code]).toEqual([200, 'tx2']);
        expect(r.ms).toBeLessThan(400);
      }
      const warnings = lines.filter(l => l.startsWith('WARNING worker tx1 did not begin its response'));
      expect(warnings).toHaveLength(3);
      expect(warnings[0]).toMatch(/to GET \/r4\/ValueSet\/\$expand in 0\.5 s: answered 504 and aborted \(1 in a row\)$/);
      expect(warnings[2]).toMatch(/\(3 in a row; no new requests for 2 s while another can take them\)$/);
      expect(lines.filter(l => l.startsWith('limits:'))[0]).toMatch(/ upstreamTimeoutSeconds 0\.5, /);
    });

    test('the timed-out request frees its slot: the one waiting for it is served', async () => {
      launcher = createLauncher({
        ...settings(false), maxOutstanding: 1, queueMs: 5000, upstreamTimeoutMs: 500,
        procs: settings(false).procs.slice(0, 2)
      });
      await launcher.start();
      await until(() => launcher.procs.every(p => p.ready));
      const hung = timed('/r4/ValueSet/$expand?delay=600000');
      await until(() => launcher.procs[1].outstanding === 1);
      const next = timed('/r4/ValueSet/$expand');
      const [h, n] = await Promise.all([hung, next]);
      expect(h.status).toBe(504);
      expect(h.ms).toBeLessThan(1500);
      expect([n.status, n.json.code]).toEqual([200, 'tx1']);
      expect(n.ms).toBeLessThan(1500);
      expect(launcher.procs[1].outstanding).toBe(0);
    });

    test('upstreamTimeoutSeconds 0: no timeout', async () => {
      launcher = createLauncher({ ...settings(false), upstreamTimeoutMs: 0 });
      await launcher.start();
      await until(() => launcher.procs.every(p => p.ready));
      const r = await timed('/r4/ValueSet/$expand?delay=1500');
      expect([r.status, r.json.code]).toEqual([200, expect.stringMatching(/^tx[12]$/)]);
      expect(r.ms).toBeGreaterThanOrEqual(1450);
    });
  });

  describe('a tx-worker held over the memory guard\'s refusal threshold, with no request at work, is restarted', () => {
    const GiB = 2 ** 30;
    // the memory each process has (by code), and how far the cgroup is over the threshold
    let mem, excess;
    const recycling = (extra = {}) => {
      const logs = [];
      return {
        logs,
        settings: {
          ...settings(true), recycleMs: 400, recycleCheckMs: 50, log: (m) => logs.push(m),
          memorySampler: {
            describe: 'over the test threshold', rejectAt: 5 * GiB,
            sample: (ps) => ({ excess, own: new Map(ps.map(p => [p, mem[p.code] || 0])) })
          },
          ...extra
        }
      };
    };
    beforeEach(() => {
      mem = { m0: 1 * GiB, tx1: 1 * GiB, tx2: 1 * GiB };
      excess = -1 * GiB;
    });

    test('the cgroup over: the worker that grew by more than that is restarted, once, and the master never', async () => {
      const { settings: s, logs } = recycling();
      launcher = createLauncher(s);
      await launcher.start();
      await until(() => launcher.procs.every(p => p.ready));
      await sleep(200); // each worker's size when ready is recorded
      const [m0, tx1, tx2] = launcher.procs;
      const children = launcher.procs.map(p => p.child);
      mem = { m0: 6 * GiB, tx1: 4 * GiB, tx2: 1.5 * GiB };
      excess = 2 * GiB;
      await until(() => tx1.child !== children[1] && tx1.ready);
      mem.tx1 = 1 * GiB;
      excess = -1 * GiB;
      expect(logs.some(m => /^recycling worker tx1: its memory \(4\.0 GB\) has been over the test threshold \(by 2\.0 GB\) for 0 s with no request at work$/.test(m))).toBe(true);
      await sleep(600);
      // tx2 grew by less than the excess, and the master is never restarted
      expect([m0.child, tx2.child]).toEqual([children[0], children[2]]);
      expect(logs.filter(m => m.startsWith('recycling')).length).toBe(1);
      expect((await get(PORT, '/r4/metadata', { 'X-Cache-Id': 'tx1.x' })).json.code).toBe('tx1');
    });

    test('not while a request is at work on it, and not while it is under', async () => {
      const { settings: s, logs } = recycling({ memorySampler: {
        describe: 'over', rejectAt: 5 * GiB, sample: (ps) => ({ excess: null, own: new Map(ps.map(p => [p, mem[p.code] || 0])) })
      } });
      launcher = createLauncher(s);
      await launcher.start();
      await until(() => launcher.procs.every(p => p.ready));
      const tx1 = launcher.procs.find(p => p.code === 'tx1');
      const tx2 = launcher.procs.find(p => p.code === 'tx2');
      const child = tx1.child;
      // a request at work on each worker (and the master): its memory may be that request's
      const slow = [1, 2, 3].map(() => get(PORT, '/r4/ValueSet/$expand?delay=1500'));
      await until(() => tx1.outstanding === 1 && tx2.outstanding === 1);
      // no cgroup measure: each process against the threshold itself; tx2 is under it
      mem = { m0: 1 * GiB, tx1: 6 * GiB, tx2: 4 * GiB };
      await sleep(1200);
      expect(tx1.child).toBe(child);
      expect((await Promise.all(slow)).map(r => r.status)).toEqual([200, 200, 200]);
      // once the request is done, the clock starts
      await until(() => tx1.child !== child && tx1.ready);
      expect(logs.filter(m => m.startsWith('recycling')).length).toBe(1);
    });

    test('no cgroup measure: a worker already over the threshold when ready is not recycled, with one warning', async () => {
      mem = { m0: 1 * GiB, tx1: 6 * GiB, tx2: 1 * GiB };
      const { settings: s, logs } = recycling({ memorySampler: {
        describe: 'over', rejectAt: 5 * GiB, sample: (ps) => ({ excess: null, own: new Map(ps.map(p => [p, mem[p.code] || 0])) })
      } });
      launcher = createLauncher(s);
      await launcher.start();
      await until(() => launcher.procs.every(p => p.ready));
      const children = launcher.procs.map(p => p.child);
      await sleep(1000);
      expect(launcher.procs.map(p => p.child)).toEqual(children);
      expect(logs.filter(m => m.startsWith('recycling'))).toEqual([]);
      expect(logs.filter(m => /^WARNING memory: worker tx1 uses 6\.0 GB loaded and idle, over: .* not recycled/.test(m)).length).toBe(1);
    });

    test('sizing: even 1 worker leaving too little room is a warning, with the numbers', async () => {
      mem = { m0: 2 * GiB, tx1: 2 * GiB, tx2: 2 * GiB };
      excess = null;
      const { settings: s, logs } = recycling({ workersDefault: true, headroomBytes: 2 * GiB });
      launcher = createLauncher(s);
      await launcher.start();
      await until(() => launcher.procs.every(p => p.ready));
      expect(launcher.procs.map(p => p.code)).toEqual(['m0', 'tx1']);
      expect(logs).toContain('WARNING memory: the master uses 2.0 GB loaded, so 3 processes would use about 6.0 GB idle; the memory guard refuses requests over the test threshold, and memoryHeadroomGB is 2.0: even 1 worker leaves too little room; starting 1: raise the limit, or run a single server');
    });

    test('sizing: with the number of workers not given, no more start than fit under the threshold with the headroom', async () => {
      // 5 GiB threshold, 2 GiB headroom, a 1.4 GiB master: 1 worker fits, not 2
      mem = { m0: 1.4 * GiB, tx1: 1.4 * GiB, tx2: 1.4 * GiB };
      excess = null; // each process on its own: the idle total is theirs added up
      // the CPU rule gave 2 (4 cores, 4 vCPU); memory lowers it to 1
      const workerDecision = defaultWorkers({ vcpu: 4, topology: { cpus: 4, cores: 4 }, quota: null, rule: 'classic' });
      const { settings: s, logs } = recycling({ workersDefault: true, headroomBytes: 2 * GiB, workerDecision });
      launcher = createLauncher(s);
      await launcher.start();
      await until(() => launcher.procs.every(p => p.ready));
      expect(launcher.procs.map(p => p.code)).toEqual(['m0', 'tx1']);
      expect(logs).toContain('workers 1: 4 physical cores (4 vCPU, SMT 1), quota none, memory fits 1 → classic rule min(4, round(0.6×4)) = 2, lowered to fit memory');
      expect(logs).toContain('memory: the master uses 1.4 GB loaded, so 3 processes would use about 4.2 GB idle; the memory guard refuses requests over the test threshold, and memoryHeadroomGB is 2.0: starting 1 worker(s), not 2 (set server.cluster.workers to choose)');
      await until(() => logs.some(m => /all processes loaded and idle/.test(m)));
      expect(logs.find(m => /all processes loaded and idle/.test(m))).toBe('memory: all processes loaded and idle use 2.8 GB, 2.2 GB under the threshold (memoryHeadroomGB 2.0)');
    });

    test('sizing: with the number of workers given, they all start, with a warning', async () => {
      mem = { m0: 1.4 * GiB, tx1: 1.4 * GiB, tx2: 1.4 * GiB };
      excess = (4.2 - 5) * GiB; // the cgroup measured: idle, 0.8 GiB under
      const { settings: s, logs } = recycling({ workersDefault: false, headroomBytes: 2 * GiB });
      launcher = createLauncher(s);
      await launcher.start();
      await until(() => launcher.procs.every(p => p.ready));
      expect(launcher.procs.map(p => p.code)).toEqual(['m0', 'tx1', 'tx2']);
      expect(logs.some(m => /^WARNING memory: the master uses 1\.4 GB .*: 2 worker\(s\) leave too little room; at most 1 would, or raise the limit$/.test(m))).toBe(true);
      await until(() => logs.some(m => /all processes loaded and idle/.test(m)));
      expect(logs.find(m => /all processes loaded and idle/.test(m))).toMatch(/^WARNING memory: all processes loaded and idle use 4\.2 GB, 0\.8 GB under the threshold .*use fewer workers or a larger limit$/);
    });

    test('recycleSeconds 0: never', async () => {
      const { settings: s, logs } = recycling({ recycleMs: 0 });
      launcher = createLauncher(s);
      await launcher.start();
      await until(() => launcher.procs.every(p => p.ready));
      const children = launcher.procs.map(p => p.child);
      mem = { m0: 1, tx1: 6 * GiB, tx2: 6 * GiB };
      excess = 2 * GiB;
      await sleep(800);
      expect(launcher.procs.map(p => p.child)).toEqual(children);
      expect(logs.some(m => /recycleSeconds 0 \(never\)/.test(m))).toBe(true);
    });
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
  }, 60000);
});

describe('requests around a worker restart (#342)', () => {
  // a 30 s hang was once seen for a plain $cache-control?mode=start sent just after a worker
  // came back: every request sent across the restart, with or without the worker's
  // cache-id, on new or kept-alive connections, is answered without waiting for the owner
  const PORT = 20700;
  let launcher;
  afterEach(async () => {
    if (launcher) {
      await launcher.stop();
      launcher = null;
    }
  });

  test('every request across the restart is answered at once', async () => {
    launcher = createLauncher({
      port: PORT,
      txPaths: TX,
      drainMs: 10000,
      procs: [
        { name: 'master', role: 'master', code: 'm0', port: 20701, servesTx: true },
        { name: 'worker tx1', role: 'tx-worker', code: 'tx1', port: 20702, servesTx: true },
        { name: 'worker tx2', role: 'tx-worker', code: 'tx2', port: 20703, servesTx: true }
      ],
      command: (proc) => [process.execPath, [FAKE, proc.code, String(proc.port)]],
      log: () => {}
    });
    await launcher.start();
    await until(() => launcher.procs.every(p => p.ready));
    const tx1 = launcher.procs.find(p => p.code === 'tx1');
    const keep = new http.Agent({ keepAlive: true, maxSockets: 4 });
    const results = [];
    const fire = (headers, agent) => {
      const t0 = Date.now();
      const p = get(PORT, '/r4/$cache-control?mode=start', headers, { agent })
        .then(r => ({ owned: !!headers['X-Cache-Id'], status: r.status, code: r.json && r.json.code, ms: Date.now() - t0 }),
          e => ({ error: e.message, ms: Date.now() - t0 }));
      results.push(p);
    };
    // warm the kept-alive connections onto tx1, then kill it
    for (let i = 0; i < 4; i++) {
      fire({ 'X-Cache-Id': 'tx1.x' }, keep);
    }
    await Promise.all(results);
    // three restarts (the backoff doubles), a request of each kind on each kind of connection every 10 ms, from
    // the exit until 1.5 s after the worker is ready again
    for (let round = 0; round < 3; round++) {
      const old = tx1.child;
      old.kill('SIGKILL');
      await until(() => !tx1.ready);
      let readyAt = 0;
      const t0 = Date.now();
      while (!readyAt || Date.now() - readyAt < 1500) {
        if (!readyAt && tx1.ready && tx1.child !== old) {
          readyAt = Date.now();
        }
        for (const agent of [false, keep]) {
          fire({}, agent);
          fire({ 'X-Cache-Id': 'tx1.x' }, agent);
        }
        await sleep(10);
        if (Date.now() - t0 > 15000) {
          throw new Error('tx1 did not come back');
        }
      }
    }
    const all = await Promise.all(results);
    keep.destroy();
    expect(all.filter(r => r.error || r.ms > 1500)).toEqual([]);
    // without a cache-id: 200; with tx1's: 200 from tx1, or 404 (lost) while it is down
    expect(all.filter(r => !r.owned && r.status !== 200).map(r => r.status)).toEqual([]);
    expect(all.filter(r => r.owned && !(r.status === 200 ? r.code === 'tx1' : r.status === 404))).toEqual([]);
    expect(all.some(r => r.owned && r.status === 404)).toBe(true);
  }, 60000);
});
