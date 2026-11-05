/**
 * server.cluster.sharedCache with real processes: a master and two tx-workers behind
 * cluster.js, sharing databases/resource-cache.db.
 *
 *  - a $cache-control session started on one process is used on each of the others,
 *    directly and through the launcher (which, without cacheAffinity, spreads cached
 *    requests by load), with no cache-id-unknown
 *  - an id no process issued is CACHE_ID_UNKNOWN_SHARED
 *  - a worker killed and restarted by the launcher still has the sessions
 */
const { startCluster, request, param, unknownCache, pidOn, canFindPid, sleep, ROOT } = require('../utils/cluster-harness');

// killing one process needs its pid (ss on Linux, lsof on macOS); without either, those cases skip
const withPid = canFindPid() ? test : test.skip;
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const FRONT = 20080;
const VSAC = 20089;

const cs = (n) => ({ resourceType: 'CodeSystem', url: `http://example.org/shared/cs${n}`, version: '1', status: 'active', content: 'complete',
  concept: [{ code: 'a', display: 'A' }, { code: 'b', display: 'B' }] });
const vs = (n) => ({ resourceType: 'ValueSet', url: `http://example.org/shared/vs${n}`, version: '1', status: 'active',
  compose: { include: [{ system: cs(n).url }] } });

function validate(port, cid, n, code = 'a') {
  return request(port, 'POST', '/r4/ValueSet/$validate-code', {
    headers: { 'X-Cache-Id': cid },
    body: { resourceType: 'Parameters', parameter: [{ name: 'url', valueUri: vs(n).url }, { name: 'coding', valueCoding: { system: cs(n).url, code } }] }
  });
}

describe('cluster.js with server.cluster.sharedCache', () => {
  let cluster;

  beforeAll(async () => {
    cluster = await startCluster({ front: FRONT, vsac: VSAC, cluster: { sharedCache: true } });
  }, 330000);

  afterAll(async () => {
    if (cluster) {
      await cluster.stop();
    }
  });

  const sessions = [];

  test('a session started on one process is used on every other one', async () => {
    const all = [cluster.master, ...cluster.workers];
    let unknown = 0;
    let ok = 0;
    for (const [i, port] of all.entries()) {
      // started (sealed, with its resources) on this process, by its own port
      const start = await request(port, 'POST', '/r4/$cache-control?mode=start', {
        body: { resourceType: 'Parameters', parameter: [{ name: 'sealed', valueBoolean: true },
          { name: 'tx-resource', resource: cs(i) }, { name: 'tx-resource', resource: vs(i) }] }
      });
      expect(start.status).toBe(200);
      const cid = param(start.json, 'cache-id').valueId;
      sessions.push({ cid, n: i, issuer: port });
      for (const other of all) {
        for (const code of ['a', 'b']) {
          const r = await validate(other, cid, i, code);
          if (unknownCache(r)) {
            unknown++;
          } else if (r.status === 200 && param(r.json, 'result').valueBoolean === true) {
            ok++;
          }
        }
      }
    }
    expect(unknown).toBe(0);
    expect(ok).toBe(all.length * all.length * 2);
    expect(new Set(sessions.map(s => s.cid.split('.')[0]))).toEqual(new Set(['m0', 'tx1', 'tx2']));
  }, 60000);

  test('through the launcher, cached requests go to every tx process and all find their cache', async () => {
    // concurrent, so the least-loaded choice spreads them
    const results = await Promise.all(Array.from({ length: 60 }, (_, k) => {
      const s = sessions[k % sessions.length];
      return validate(FRONT, s.cid, s.n);
    }));
    expect(results.filter(unknownCache)).toHaveLength(0);
    expect(results.filter(r => r.status === 200 && param(r.json, 'result').valueBoolean === true)).toHaveLength(60);
  }, 60000);

  test('an id that no process issued is unknown, in the shared store\'s words', async () => {
    const r = await validate(FRONT, 'tx1.00000000-0000-4000-8000-000000000000', 0);
    expect(r.status).toBe(404);
    expect(unknownCache(r)).toBe(true);
    const text = r.json.issue[0].details.text;
    expect(text).toMatch(/cluster restart/);
    expect(text).not.toMatch(/survive a restart/);
    expect(text).not.toMatch(/restarted since/);
    expect(text).not.toMatch(/reached the wrong server/);
  });

  withPid('a worker that is killed and restarted still has the sessions, its own included', async () => {
    const port = cluster.workers[0];
    const pid = pidOn(port);
    expect(pid).toBeGreaterThan(0);
    process.kill(pid, 'SIGKILL');
    const t0 = Date.now();
    while (pidOn(port) === pid || pidOn(port) === null) {
      if (Date.now() - t0 > 120000) {
        throw new Error('the worker was not restarted');
      }
      await sleep(250);
    }
    await cluster.waitUp([port]);
    expect(pidOn(port)).not.toBe(pid);
    for (const s of sessions) {
      const r = await validate(port, s.cid, s.n);
      expect(unknownCache(r)).toBe(false);
      expect(param(r.json, 'result').valueBoolean).toBe(true);
    }
  }, 180000);

  withPid('a master child restart preserves sessions issued by every process', async () => {
    const port = cluster.master;
    const pid = pidOn(port);
    process.kill(pid, 'SIGKILL');
    const t0 = Date.now();
    while (pidOn(port) === pid || pidOn(port) === null) {
      if (Date.now() - t0 > 120000) throw new Error('the master was not restarted');
      await sleep(250);
    }
    await cluster.waitUp([port]);
    for (const s of sessions) {
      const r = await validate(port, s.cid, s.n);
      expect(unknownCache(r)).toBe(false);
      expect(param(r.json, 'result').valueBoolean).toBe(true);
    }
  }, 180000);

  test('a full launcher restart invalidates old IDs and accepts fresh sessions on every process', async () => {
    await cluster.restart();
    for (const port of [cluster.master, ...cluster.workers]) {
      for (const s of sessions) {
        const r = await validate(port, s.cid, s.n);
        expect(r.status).toBe(404);
        expect(unknownCache(r)).toBe(true);
      }
      const start = await request(port, 'POST', '/r4/$cache-control?mode=start', {
        body:{ resourceType:'Parameters', parameter:[{ name:'tx-resource', resource:cs(7) }, { name:'tx-resource', resource:vs(7) }] }
      });
      expect(start.status).toBe(200);
      const id = param(start.json, 'cache-id').valueId;
      expect(id).toMatch(/^[A-Za-z0-9.-]{1,64}$/);
      const r = await validate(FRONT, id, 7);
      expect(param(r.json, 'result').valueBoolean).toBe(true);
    }
  }, 330000);

  test('home and dashboard include graph histories from the whole cluster', async () => {
    for (const page of ['/', '/dashboard']) {
      const r = await request(FRONT, 'GET', page, { headers:{ Accept:'text/html' } });
      expect(r.status).toBe(200);
      expect(r.text).toContain('Master m0: uptime and request counts for this process');
      expect(r.text).toContain('Heap change since process start');
      const match = /const metrics = (.+);/.exec(r.text);
      expect(match).not.toBeNull();
      const data = JSON.parse(match[1]);
      expect(data.cluster).toBe(true);
      expect(data.series.map(s => s.id)).toEqual(['m0', 'tx1', 'tx2']);
      expect(data.series.every(s => s.history.length > 0)).toBe(true);
    }
  });

  test('manual master startup invalidates old IDs while a surviving worker accepts fresh sessions', async () => {
    await cluster.stopLauncher();
    const children = [];
    const stop = async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise(resolve => {
        const kill = setTimeout(() => child.kill('SIGKILL'), 30000);
        child.once('exit', () => { clearTimeout(kill); resolve(); });
        child.kill('SIGTERM');
      });
    };
    const launch = async (role, code, port) => {
      const env = { ...process.env, FHIRSMITH_DATA_DIR:cluster.dir };
      delete env.FHIRSMITH_CLUSTER_GENERATION; // ordinary manually started roles have no launcher token
      const out = fs.openSync(path.join(cluster.dir, 'manual.log'), 'a');
      const child = spawn(process.execPath, [path.join(ROOT, 'server.js'), `--role=${role}`, `--instance-code=${code}`, `--port=${port}`],
        { cwd:ROOT, env, stdio:['ignore', out, out] });
      fs.closeSync(out);
      children.push(child);
      const t0 = Date.now();
      while (Date.now() - t0 <= 120000 && child.exitCode === null) {
        const up = await request(port, 'GET', '/health').then(r => r.status === 200, () => false);
        if (up) return child;
        await sleep(250);
      }
      throw new Error('manual role did not start');
    };
    try {
      const master = await launch('master', 'm0', cluster.master);
      await launch('tx-worker', 'tx1', cluster.workers[0]);
      const start = await request(cluster.workers[0], 'POST', '/r4/$cache-control?mode=start', {
        body:{ resourceType:'Parameters', parameter:[{ name:'tx-resource', resource:cs(8) }, { name:'tx-resource', resource:vs(8) }] }
      });
      expect(start.status).toBe(200);
      const old = param(start.json, 'cache-id').valueId;
      expect(param((await validate(cluster.master, old, 8)).json, 'result').valueBoolean).toBe(true);
      await stop(master);
      await launch('master', 'm0', cluster.master);
      expect(unknownCache(await validate(cluster.workers[0], old, 8))).toBe(true);
      const fresh = await request(cluster.workers[0], 'POST', '/r4/$cache-control?mode=start', {
        body:{ resourceType:'Parameters', parameter:[{ name:'tx-resource', resource:cs(8) }, { name:'tx-resource', resource:vs(8) }] }
      });
      expect(fresh.status).toBe(200);
      const id = param(fresh.json, 'cache-id').valueId;
      expect(param((await validate(cluster.master, id, 8)).json, 'result').valueBoolean).toBe(true);
    } finally {
      await Promise.all(children.map(stop));
    }
  }, 330000);
});
