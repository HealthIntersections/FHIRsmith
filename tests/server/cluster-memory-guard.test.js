/**
 * The memory guard for a cluster, for real: cluster.js with two workers and a 900 MB
 * limit for the whole service, measured by adding up the processes' RSS (the measure
 * used where the service has no cgroup of its own - so this runs anywhere). One worker
 * is made heavy:
 *  - with the service over the reject threshold, both workers refuse new requests (503);
 *  - over the abort threshold, the heavy worker's operations abort (422) and the light
 *    one's carry on;
 *  - kept over (8 s here), the heavy worker is drained and restarted, and the service recovers.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const PORT = 19687;
const MB = 1024 * 1024;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function get(p) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${PORT}${p}`, { agent: false }, (res) => {
      let text = '';
      res.on('data', d => { text += d; });
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          // not JSON
        }
        resolve({ status: res.statusCode, pid: Number(res.headers['x-served-by']), json });
      });
    }).on('error', reject);
  });
}

// Send a request to one worker. The primary hands new connections to the two workers in
// turn, so once a no-op request has been answered by the other worker, the next goes to
// this one
async function to(pid, p) {
  for (let i = 0; i < 10; i++) {
    const probe = await get('/__mem/whoami');
    if (probe.pid !== pid) {
      const r = await get(p);
      if (r.pid === pid) {
        return r;
      }
    }
  }
  throw new Error(`could not reach pid ${pid} for ${p}`);
}

describe('memory guard in cluster mode', () => {
  let dir;
  let proc;
  let output = '';
  const workerPids = () => [...output.matchAll(/worker \d \(pid (\d+)\) listening/g)].map(m => Number(m[1]));

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-memory-'));
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      server: {
        port: PORT,
        cluster: { workers: 2 },
        memory: { limit: 900 * MB, measure: 'processes', recycleAfterSeconds: 8, drainSeconds: 3 }
      },
      stats: { enabled: false },
      npmAudit: { enabled: false },
      logging: { console: { level: 'info' }, file: { level: 'warn' } },
      modules: { testing: { enabled: true } }
    }));
    proc = spawn(process.execPath, ['--require', path.join(__dirname, '..', 'utils', 'memory-test-routes.js'), 'cluster.js'], {
      cwd: ROOT, env: { ...process.env, FHIRSMITH_DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe']
    });
    proc.stdout.on('data', d => { output += d; });
    proc.stderr.on('data', d => { output += d; });
    for (let i = 0; i < 600 && workerPids().length < 2; i++) {
      await sleep(100);
    }
    expect(workerPids()).toHaveLength(2);
    await sleep(1500); // the first reports
  }, 90000);

  afterAll(async () => {
    if (proc && proc.exitCode === null) {
      await new Promise(resolve => {
        proc.once('exit', resolve);
        proc.kill('SIGTERM');
      });
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('refuse in every worker, abort only in the heavy one, then recycle it', async () => {
    expect(output).toMatch(/memory: limit 0\.88 GB for the service \(from configured\), measured as the sum of the processes' RSS/);
    const [a, b] = workerPids();

    // A keeps 300 MB: the service is now ~0.6 GB, under the reject threshold (765 MB)
    expect((await to(a, '/__mem/leak?mb=300')).status).toBe(200);
    await sleep(2500);
    expect((await get('/testing')).status).toBe(200);
    const state = (await to(b, '/__mem/state')).json;
    expect(state.measured).toBeLessThan(state.rejectAt);

    // A fills enough for a while to take the service to 96% of the limit: over reject and
    // abort (828 MB). (How much that is depends on how a process is measured.)
    const fill = Math.ceil((0.96 * 900 * MB - state.measured) / MB / 10) * 10;
    const filling = to(a, `/__mem/fill?mb=${fill}&hold=4000`);
    await sleep(3000);
    const refusedA = await to(a, '/testing');
    const refusedB = await to(b, '/testing');
    expect([refusedA.status, refusedB.status]).toEqual([503, 503]);
    const checkA = await to(a, '/__mem/check');
    const checkB = await to(b, '/__mem/check');
    expect(checkA.json.aborts).toBe(true);   // the largest
    expect(checkB.json.aborts).toBe(false);  // carries on
    await filling;
    await sleep(2500);
    expect((await get('/testing')).status).toBe(200);

    // an operation in A that grows until the guard says stop: aborted (422) part way
    const heavy = await to(a, '/__mem/heavy?mb=600');
    expect(heavy.status).toBe(422);
    expect(heavy.json.atMb).toBeLessThan(600);

    // A keeps enough to stay over: after 8 s it is drained and restarted
    const now = (await to(b, '/__mem/state')).json;
    await to(a, `/__mem/leak?mb=${Math.ceil((now.rejectAt - now.measured) / MB / 10) * 10 + 60}`);
    for (let i = 0; i < 300 && !/recycled for memory/.test(output); i++) {
      await sleep(100);
    }
    expect(output).toMatch(new RegExp(`recycling the largest worker, pid ${a}`));
    expect(output).toMatch(new RegExp(`worker \\d \\(pid ${a}\\) recycled for memory`));
    for (let i = 0; i < 300 && workerPids().length < 3; i++) {
      await sleep(100);
    }
    const c = workerPids()[2];
    expect(c).not.toBe(a);
    await sleep(2500);
    const after = new Set();
    for (let i = 0; i < 6; i++) {
      const r = await get('/testing');
      expect(r.status).toBe(200);
      after.add(r.pid);
    }
    expect([...after].sort()).toEqual([b, c].sort());
    expect(output).toMatch(/the service is back under/);
  }, 120000);
});
