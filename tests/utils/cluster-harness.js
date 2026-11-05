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
        resolve({ status: res.statusCode, headers: res.headers, json, text });
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

// How to find the pid listening on a port: ss on Linux, lsof on macOS (and most Unixes).
// Each returns the pid, or null when nothing is listening.
const PID_TOOLS = [
  ['ss', (port) => {
    const out = execFileSync('ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = /pid=(\d+)/.exec(out);
    return m ? Number(m[1]) : null;
  }],
  ['lsof', (port) => {
    let out;
    try {
      out = execFileSync('lsof', [`-iTCP:${port}`, '-sTCP:LISTEN', '-P', '-n', '-t'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (error) {
      if (error.status === 1) {
        return null; // lsof found nothing
      }
      throw error;
    }
    const m = /^(\d+)/m.exec(out);
    return m ? Number(m[1]) : null;
  }]
];
let pidTool;

/**
 * The tool pidOn uses, or null if this machine has neither ss nor lsof (tests that need a
 * process's pid then skip; see canFindPid).
 */
function findPidTool() {
  if (pidTool === undefined) {
    pidTool = null;
    for (const [, lookup] of PID_TOOLS) {
      try {
        lookup(1);
        pidTool = lookup;
        break;
      } catch {
        // not installed (ENOENT), or it doesn't work this way here: try the next
      }
    }
  }
  return pidTool;
}

/** Whether pidOn can work here (ss or lsof is installed). */
const canFindPid = () => findPidTool() !== null;

/** The pid of the process listening on a port, or null if none is (needs canFindPid). */
function pidOn(port) {
  const lookup = findPidTool();
  if (!lookup) {
    throw new Error('Neither ss nor lsof is available to find the process listening on a port');
  }
  return lookup(port);
}

/**
 * Start the launcher.
 * @param {Object} opts
 * @param {number} opts.front - the launcher's port; the master is front+1, worker n front+1+n
 * @param {number} opts.vsac - a port for the fake VSAC
 * @param {number} [opts.workers=2]
 * @param {Object} [opts.cluster] - more server.cluster settings (the options)
 * @param {Object} [opts.tx] - more modules.tx settings
 * @param {string[]} [opts.sources] - more library sources (library.yml), after VSAC
 * @param {function(string)} [opts.prepare] - called with the data directory before the launch
 */
async function startCluster({ front, vsac, workers = 2, cluster = {}, tx = {}, sources = [], prepare = null }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cluster-opt-'));
  const master = front + 1;
  const workerPorts = Array.from({ length: workers }, (_, i) => master + 1 + i);
  // the R4 core package, if a test run has already downloaded it, saves fetching it again
  const core = path.join(ROOT, 'data', 'terminology-cache', 'hl7.fhir.r4.core#4.0.1');
  if (fs.existsSync(core)) {
    fs.cpSync(core, path.join(dir, 'terminology-cache', 'hl7.fhir.r4.core#4.0.1'), { recursive: true });
  }
  fs.writeFileSync(path.join(dir, 'library.yml'), 'base:\n  url: https://storage.googleapis.com/tx-fhir-org\n\nsources:\n  - internal:vsac=vsac\n' +
    sources.map(source => `  - ${source}\n`).join(''));
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

  if (prepare) {
    prepare(dir);
  }
  const out = fs.openSync(path.join(dir, 'processes.log'), 'a');
  let launcher;
  let exited;
  function launch() {
    launcher = spawn(process.execPath, [path.join(ROOT, 'cluster.js')], {
      cwd: ROOT, env: { ...process.env, FHIRSMITH_DATA_DIR: dir }, stdio: ['ignore', out, out]
    });
    exited = new Promise(resolve => launcher.once('exit', (code, signal) => resolve({ code, signal })));
  }
  launch();

  // port -> when it was first seen answering /health
  const upAt = new Map();
  async function waitUp(ports, ms = 300000) {
    const t0 = Date.now();
    for (const port of ports) {
      while (!(await isUp(port))) {
        if (Date.now() - t0 > ms || launcher.exitCode !== null) {
          throw new Error(`port ${port} did not come up; see ${path.join(dir, 'processes.log')}`);
        }
        await sleep(250);
      }
      if (!upAt.has(port)) {
        upAt.set(port, Date.now());
      }
    }
    // the launcher marks a process ready a moment after it first answers
    await sleep(500);
  }
  try {
    await waitUp([master, ...workerPorts, front]);
  } catch (error) {
    const log = fs.readFileSync(path.join(dir, 'processes.log'), 'utf8').slice(-4000);
    await stop();
    throw new Error(`${error.message}\n${log}`);
  }

  async function stopLauncher() {
    if (launcher.exitCode === null && launcher.signalCode === null) {
      launcher.kill('SIGTERM');
    }
    return exited;
  }

  // Keep the same SQLite files and fixture server while restarting every process.
  async function restart() {
    await stopLauncher();
    upAt.clear();
    launch();
    await waitUp([master, ...workerPorts, front]);
  }

  async function stop() {
    const result = await stopLauncher();
    await new Promise(resolve => vsacServer.close(resolve));
    fs.closeSync(out);
    fs.rmSync(dir, { recursive: true, force: true });
    return result;
  }

  return { dir, front, master, workers: workerPorts, get launcher() { return launcher; },
    get exited() { return exited; }, waitUp, upAt, stop, stopLauncher, restart };
}

module.exports = { startCluster, request, isUp, param, issueCodes, unknownCache, pidOn, canFindPid, sleep, ROOT };
