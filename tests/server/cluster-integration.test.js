/**
 * cluster.js with real processes: a master and two tx-workers on a temporary data
 * directory, behind the launcher's port, with a fake VSAC.
 *
 *  - $cache-control sessions started through the launcher are used on later requests,
 *    and every one of those requests reaches the process that holds the cache
 *  - $closure and the non-tx paths reach the master
 *  - a VSAC sync on the master is seen by both workers
 *  - the master's home page counts every process's requests
 *  - SIGTERM: the requests in progress finish, every process stops, the launcher exits 0
 *  - the master's statistics database counts the requests every process served, once each
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { pidOn } = require('../utils/cluster-harness');

const ROOT = path.join(__dirname, '..', '..');
const FRONT = 20020;
const MASTER = 20021;
const WORKERS = [20022, 20023];
const VSAC = 20029;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const GENDER = 'http://hl7.org/fhir/administrative-gender';
const vsacValueSet = (id) => ({
  resourceType: 'ValueSet', id, url: `http://cts.nlm.nih.gov/fhir/ValueSet/${id}`, version: '1', status: 'active',
  compose: { include: [{ system: GENDER, concept: [{ code: 'male' }] }] }
});

function request(port, method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({
      host: '127.0.0.1', port, method, path: urlPath, agent: false,
      headers: { Accept: 'application/fhir+json', ...(data ? { 'Content-Type': 'application/fhir+json' } : {}), ...headers }
    }, (res) => {
      let text = '';
      res.on('data', d => { text += d; });
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          // not JSON
        }
        resolve({ status: res.statusCode, headers: res.headers, json });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

function requestText(port, urlPath, headers) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath, agent: false, headers }, (res) => {
      let text = '';
      res.on('data', d => { text += d; });
      res.on('end', () => resolve(text));
    }).on('error', reject);
  });
}

const isUp = (port) => request(port, 'GET', '/health').then(r => r.status === 200, () => false);
const param = (body, name) => ((body && body.parameter) || []).find(p => p.name === name);
const unknownCache = (r) => r.json && r.json.resourceType === 'OperationOutcome' &&
  (r.json.issue || []).some(i => ((i.details && i.details.coding) || []).some(c => c.code === 'cache-id-unknown'));

describe('master and two tx-workers behind cluster.js', () => {
  let dir;
  let launcher;
  let launcherExit;
  let vsacServer;
  const vsacList = [vsacValueSet('one')];

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-'));
    // the R4 core package, if a test run has already downloaded it, saves fetching it again
    const core = path.join(ROOT, 'data', 'terminology-cache', 'hl7.fhir.r4.core#4.0.1');
    if (fs.existsSync(core)) {
      fs.cpSync(core, path.join(dir, 'terminology-cache', 'hl7.fhir.r4.core#4.0.1'), { recursive: true });
    }
    fs.writeFileSync(path.join(dir, 'library.yml'), 'base:\n  url: https://storage.googleapis.com/tx-fhir-org\n\nsources:\n  - internal:vsac=vsac\n');
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      hostName: 'cluster-test',
      logging: { console: false },
      server: { port: FRONT, cluster: { workers: 2, internalPort: MASTER } },
      modules: {
        vcl: { enabled: true },
        tx: {
          enabled: true,
          instanceCode: 'm0',
          librarySource: path.join(dir, 'library.yml'),
          endpoints: [{ path: '/r4', fhirVersion: '4.0', context: null }],
          closure: { enabled: true },
          // a sync every 1.8 s
          vsacCfg: { apiKey: 'test', baseUrl: `http://127.0.0.1:${VSAC}/fhir`, refreshIntervalHours: 0.0005 }
        }
      }
    }));

    // a fake VSAC: every listing is the whole list, ?url= the one asked for
    vsacServer = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      const url = u.searchParams.get('url');
      const list = url ? vsacList.filter(v => v.url === url) : vsacList;
      res.setHeader('Content-Type', 'application/fhir+json');
      res.end(JSON.stringify({ resourceType: 'Bundle', type: 'searchset', total: list.length, entry: list.map(resource => ({ resource })), link: [] }));
    });
    await new Promise(resolve => vsacServer.listen(VSAC, resolve));

    const out = fs.openSync(path.join(dir, 'processes.log'), 'a');
    launcher = spawn(process.execPath, [path.join(ROOT, 'cluster.js')], {
      cwd: ROOT, env: { ...process.env, FHIRSMITH_DATA_DIR: dir }, stdio: ['ignore', out, out]
    });
    launcherExit = new Promise(resolve => launcher.once('exit', (code, signal) => resolve({ code, signal })));
    const t0 = Date.now();
    for (const port of [MASTER, ...WORKERS, FRONT]) {
      while (!(await isUp(port))) {
        if (Date.now() - t0 > 300000 || launcher.exitCode !== null) {
          throw new Error(`port ${port} did not come up; see ${path.join(dir, 'processes.log')}`);
        }
        await sleep(250);
      }
    }
    // the launcher marks a worker ready a moment after it first answers
    await sleep(500);
  }, 330000);

  afterAll(async () => {
    if (launcher && launcher.exitCode === null && launcher.signalCode === null) {
      launcher.kill('SIGTERM');
      await launcherExit;
    }
    if (vsacServer) {
      await new Promise(resolve => vsacServer.close(resolve));
    }
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the master and the workers listen on loopback only (server.cluster.bindAddress)', async () => {
    const outside = Object.values(os.networkInterfaces()).flat().find(a => a && a.family === 'IPv4' && !a.internal);
    for (const port of [MASTER, ...WORKERS]) {
      expect(await isUp(port)).toBe(true);
      if (outside) {
        // the same port on this machine's own non-loopback address: nothing listens there
        const r = await new Promise(resolve => http.get({ host: outside.address, port, path: '/health', agent: false }, res => {
          res.resume();
          resolve(res.statusCode);
        }).on('error', e => resolve(e.code)));
        expect(r).toBe('ECONNREFUSED');
      }
    }
  });

  test('each process runs what its role says', async () => {
    // non-tx paths reach the master: it alone has the vcl module
    const viaFront = await request(FRONT, 'GET', '/health');
    expect(Object.keys(viaFront.json.modules).sort()).toEqual(['tx', 'vcl']);
    for (const port of WORKERS) {
      expect(Object.keys((await request(port, 'GET', '/health')).json.modules)).toEqual(['tx']);
    }
    expect((await request(FRONT, 'GET', '/VCL?vcl=' + encodeURIComponent('(http://loinc.org)1-8'))).status).toBe(200);
  });

  test('$cache-control sessions started through the launcher hold on every later request', async () => {
    const issuers = new Set();
    let unknown = 0;
    let ok = 0;
    for (let s = 0; s < 6; s++) {
      const start = await request(FRONT, 'POST', '/r4/$cache-control?mode=start', { body: { resourceType: 'Parameters', parameter: [] } });
      expect(start.status).toBe(200);
      const cid = param(start.json, 'cache-id').valueId;
      issuers.add(cid.split('.')[0]);
      const cs = { resourceType: 'CodeSystem', url: `http://example.org/cs${s}`, version: '1', status: 'active', content: 'complete', concept: [{ code: 'a' }] };
      const vs = { resourceType: 'ValueSet', url: `http://example.org/vs${s}`, version: '1', status: 'active', compose: { include: [{ system: cs.url }] } };
      // the first request leaves the resources in the cache; the later ones refer to them by url
      const first = await request(FRONT, 'POST', '/r4/ValueSet/$validate-code', {
        headers: { 'X-Cache-Id': cid },
        body: { resourceType: 'Parameters', parameter: [{ name: 'tx-resource', resource: cs }, { name: 'tx-resource', resource: vs },
          { name: 'url', valueUri: vs.url }, { name: 'coding', valueCoding: { system: cs.url, code: 'a' } }] }
      });
      expect(param(first.json, 'result').valueBoolean).toBe(true);
      for (let i = 0; i < 8; i++) {
        const r = await request(FRONT, 'POST', '/r4/ValueSet/$validate-code', {
          headers: { 'X-Cache-Id': cid },
          body: { resourceType: 'Parameters', parameter: [{ name: 'url', valueUri: vs.url }, { name: 'coding', valueCoding: { system: cs.url, code: 'a' } }] }
        });
        if (unknownCache(r)) {
          unknown++;
        } else if (r.status === 200 && param(r.json, 'result').valueBoolean === true) {
          ok++;
        }
      }
    }
    expect(unknown).toBe(0);
    expect(ok).toBe(48);
    // the sessions were spread over the tx processes, and each id names its issuer
    expect(issuers.size).toBeGreaterThan(1);
    for (const code of issuers) {
      expect(['m0', 'tx1', 'tx2']).toContain(code);
    }
  });

  test('$closure goes to the master, whatever the cache-id says', async () => {
    for (const cid of ['tx1.abc', 'tx2.abc', undefined]) {
      const r = await request(FRONT, 'POST', '/r4/$closure', {
        headers: cid ? { 'X-Cache-Id': cid } : {},
        body: { resourceType: 'Parameters', parameter: [{ name: 'name', valueString: `t-${cid}` }] }
      });
      expect(r.status).toBe(200);
      expect(r.json.resourceType).toBe('ConceptMap');
    }
    // a worker has no closure tables of its own, but says the service offers $closure
    const direct = await request(WORKERS[0], 'POST', '/r4/$closure', { body: { resourceType: 'Parameters', parameter: [{ name: 'name', valueString: 'x' }] } });
    expect(direct.status).toBe(501);
    const cap = await request(WORKERS[0], 'GET', '/r4/metadata');
    expect(cap.json.rest[0].operation.map(o => o.name)).toContain('closure');
  });

  test('a VSAC sync on the master reaches both workers', async () => {
    const validate = (port) => request(port, 'GET', '/r4/ValueSet/$validate-code?url=' +
      encodeURIComponent('http://cts.nlm.nih.gov/fhir/ValueSet/two') + `&system=${encodeURIComponent(GENDER)}&code=male`)
      .then(r => r.status === 200 && param(r.json, 'result') && param(r.json, 'result').valueBoolean === true);
    for (const port of WORKERS) {
      expect(await validate(port)).toBe(false);
    }
    vsacList.push(vsacValueSet('two'));
    const t0 = Date.now();
    for (const port of [MASTER, ...WORKERS]) {
      while (!(await validate(port))) {
        if (Date.now() - t0 > 30000) {
          throw new Error(`the process on ${port} never saw the new value set`);
        }
        await sleep(200);
      }
    }
  });

  // $lookup is used nowhere else here but in the SIGTERM test (10 more, through the launcher)
  const LOOKUP = `/r4/CodeSystem/$lookup?system=${encodeURIComponent(GENDER)}&code=male`;
  const DIRECT_LOOKUPS = { [MASTER]: 2, [WORKERS[0]]: 3, [WORKERS[1]]: 4 };

  test('each process serves some requests of its own', async () => {
    for (const [port, n] of Object.entries(DIRECT_LOOKUPS)) {
      for (let i = 0; i < n; i++) {
        expect((await request(Number(port), 'GET', LOOKUP)).status).toBe(200);
      }
    }
  });

  test('the master\'s home page counts every process\'s requests', async () => {
    // a worker stopped sends its last counts; the launcher passes them on and restarts it
    process.kill(pidOn(WORKERS[0]), 'SIGTERM');
    const t0 = Date.now();
    let m = null;
    while (Date.now() - t0 < 30000) {
      const page = await requestText(MASTER, '/', { Accept: 'text/html' });
      m = /Request Count:<\/strong> (\d+) \(master: (\d+), workers: (\d+)/.exec(page);
      if (m && Number(m[3]) >= DIRECT_LOOKUPS[WORKERS[0]]) {
        expect(page).toContain('Cluster: request counts for every process');
        break;
      }
      await sleep(250);
    }
    expect(Number(m[3])).toBeGreaterThanOrEqual(DIRECT_LOOKUPS[WORKERS[0]]);
    expect(Number(m[1])).toBe(Number(m[2]) + Number(m[3]));
    // a worker's own page is still its own
    while (!(await isUp(WORKERS[0]))) {
      await sleep(250);
    }
    await sleep(500);
    expect(await requestText(WORKERS[1], '/', { Accept: 'text/html' })).toContain("Worker tx2: every figure is this process's");
  }, 60000);

  test('SIGTERM: requests in progress finish, then every process stops', async () => {
    const inFlight = [];
    for (let i = 0; i < 10; i++) {
      inFlight.push(request(FRONT, 'GET', `/r4/CodeSystem/$lookup?system=${encodeURIComponent(GENDER)}&code=male`));
    }
    await sleep(50);
    launcher.kill('SIGTERM');
    const results = await Promise.all(inFlight);
    expect(results.map(r => r.status)).toEqual(Array(10).fill(200));
    expect(await launcherExit).toEqual({ code: 0, signal: null });
    for (const port of [FRONT, MASTER, ...WORKERS]) {
      expect(await isUp(port)).toBe(false);
    }
  });

  test('the master\'s statistics database counts every process\'s requests, once each', () => {
    const Database = require('better-sqlite3');
    const db = new Database(path.join(dir, 'databases', 'stats.db'), { readonly: true });
    try {
      const row = db.prepare("SELECT SUM(count_delta) AS n FROM request_counts WHERE module = 'tx' AND operation = '$lookup'").get();
      const direct = Object.values(DIRECT_LOOKUPS).reduce((a, b) => a + b, 0);
      expect(row.n).toBe(direct + 10);
    } finally {
      db.close();
    }
  });
});
