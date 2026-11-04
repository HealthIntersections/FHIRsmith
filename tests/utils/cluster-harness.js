// Runs `node cluster.js` on a temporary data directory, for the tests of the cluster options
// (tests/server/cluster-shared-*.test.js): a master, N tx-workers, a fake VSAC, and helpers
// to send requests to the launcher's port or to one process directly.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

const isUp = (port) => request(port, 'GET', '/health').then(r => r.status === 200, () => false);
const param = (body, name) => ((body && body.parameter) || []).find(p => p.name === name);
const issueCodes = (r) => ((r.json && r.json.issue) || []).flatMap(i => ((i.details && i.details.coding) || []).map(c => c.code));
const unknownCache = (r) => r.json && r.json.resourceType === 'OperationOutcome' && issueCodes(r).includes('cache-id-unknown');

/** The pid of the process listening on a port (Linux: ss). */
function pidOn(port) {
  const out = execFileSync('ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8' });
  const m = /pid=(\d+)/.exec(out);
  return m ? Number(m[1]) : null;
}

/**
 * Start the launcher.
 * @param {Object} opts
 * @param {number} opts.front - the launcher's port; the master is front+1, worker n front+1+n
 * @param {number} opts.vsac - a port for the fake VSAC
 * @param {number} [opts.workers=2]
 * @param {Object} [opts.cluster] - more server.cluster settings (the options)
 * @param {Object} [opts.tx] - more modules.tx settings
 */
async function startCluster({ front, vsac, workers = 2, cluster = {}, tx = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-opt-'));
  const master = front + 1;
  const workerPorts = Array.from({ length: workers }, (_, i) => master + 1 + i);
  // the R4 core package, if a test run has already downloaded it, saves fetching it again
  const core = path.join(ROOT, 'data', 'terminology-cache', 'hl7.fhir.r4.core#4.0.1');
  if (fs.existsSync(core)) {
    fs.cpSync(core, path.join(dir, 'terminology-cache', 'hl7.fhir.r4.core#4.0.1'), { recursive: true });
  }
  fs.writeFileSync(path.join(dir, 'library.yml'), 'base:\n  url: https://storage.googleapis.com/tx-fhir-org\n\nsources:\n  - internal:vsac=vsac\n');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    hostName: 'cluster-test',
    logging: { console: false },
    server: { port: front, cluster: { workers, internalPort: master, ...cluster } },
    modules: {
      tx: {
        enabled: true,
        instanceCode: 'm0',
        librarySource: path.join(dir, 'library.yml'),
        endpoints: [{ path: '/r4', fhirVersion: '4.0', context: null }],
        closure: { enabled: true },
        vsacCfg: { apiKey: 'test', baseUrl: `http://127.0.0.1:${vsac}/fhir`, refreshIntervalHours: 24 },
        ...tx
      }
    }
  }));

  const vsacServer = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/fhir+json');
    res.end(JSON.stringify({ resourceType: 'Bundle', type: 'searchset', total: 0, entry: [], link: [] }));
  });
  await new Promise(resolve => vsacServer.listen(vsac, resolve));

  const out = fs.openSync(path.join(dir, 'processes.log'), 'a');
  const launcher = spawn(process.execPath, [path.join(ROOT, 'cluster.js')], {
    cwd: ROOT, env: { ...process.env, FHIRSMITH_DATA_DIR: dir }, stdio: ['ignore', out, out]
  });
  const exited = new Promise(resolve => launcher.once('exit', (code, signal) => resolve({ code, signal })));

  async function waitUp(ports, ms = 300000) {
    const t0 = Date.now();
    for (const port of ports) {
      while (!(await isUp(port))) {
        if (Date.now() - t0 > ms || launcher.exitCode !== null) {
          throw new Error(`port ${port} did not come up; see ${path.join(dir, 'processes.log')}`);
        }
        await sleep(250);
      }
    }
    // the launcher marks a process ready a moment after it first answers
    await sleep(500);
  }
  await waitUp([master, ...workerPorts, front]);

  async function stop() {
    if (launcher.exitCode === null && launcher.signalCode === null) {
      launcher.kill('SIGTERM');
    }
    const result = await exited;
    await new Promise(resolve => vsacServer.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
    return result;
  }

  return { dir, front, master, workers: workerPorts, launcher, exited, waitUp, stop };
}

module.exports = { startCluster, request, isUp, param, issueCodes, unknownCache, pidOn, sleep, ROOT };
