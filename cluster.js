#!/usr/bin/env node

//
// Copyright 2025, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * An optional launcher: one master and N terminology workers on one machine, behind one port
 * (see cluster.md). It does what the nginx configuration in nginx.md does, for those who
 * don't run nginx in front:
 *
 *  - starts the master (node server.js --role=master), waits until it answers /health, then
 *    starts the workers (--role=tx-worker) one after another, each once the one before is
 *    ready, each with its own instance code and port
 *  - routes: a request with X-Cache-Id to the process that issued it (by the id's prefix);
 *    $closure, the syndication feed, the source info pages and everything that isn't a tx
 *    endpoint to the master; any other tx request to the tx process with the fewest
 *    requests outstanding
 *  - restarts a process that exits, waiting longer each time it fails quickly (up to a minute)
 *  - on SIGTERM or SIGINT, stops taking connections, lets the requests in progress finish,
 *    then stops the processes (each shuts down as a single server does)
 *
 *   node cluster.js [--workers=N] [--port=P] [--master-serves-tx=false]
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const HEALTH_POLL_MS = 250;
const MAX_BACKOFF_MS = 60000;
// An idle keep-alive connection to a process is closed by the launcher after this long:
// below the processes' own keepAliveTimeout (65 s with library/keep-alive.js, Node's default
// of 5 s on a server without it), so the launcher never sends a request down a connection the
// process is closing at that moment (a reset, which the client would see as a 502)
const UPSTREAM_IDLE_MS = 4000;
// a process that ran this long before exiting is restarted at once
const HEALTHY_RUN_MS = 60000;
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'expect'];

/**
 * The settings, from the flags, then the environment, then config.json (server.cluster).
 * @param {string[]} argv - process.argv.slice(2)
 * @param {Object} env - process.env
 * @param {Object} config - config.json
 */
function loadSettings(argv, env, config) {
  const flags = {};
  for (const a of argv) {
    const m = /^--([a-z-]+)=(.*)$/.exec(a);
    if (m) {
      flags[m[1]] = m[2];
    }
  }
  const cluster = (config.server && config.server.cluster) || {};
  const tx = (config.modules && config.modules.tx) || {};
  if (!tx.enabled) {
    throw new Error('cluster.js runs terminology workers: the tx module must be enabled in config.json');
  }
  const port = Number(flags.port || env.PORT || (config.server && config.server.port) || 3000);
  const workers = Number(flags.workers || env.FHIRSMITH_WORKERS || cluster.workers || 2);
  const internalPort = Number(flags['internal-port'] || cluster.internalPort || port + 1);
  const masterCode = tx.instanceCode || 'm0';
  const servesTx = flags['master-serves-tx'] !== undefined ? flags['master-serves-tx'] !== 'false' : cluster.masterServesTx !== false;
  const procs = [{ name: 'master', role: 'master', code: masterCode, port: internalPort, servesTx }];
  for (let i = 1; i <= workers; i++) {
    const code = 'tx' + i;
    if (code === masterCode) {
      throw new Error(`modules.tx.instanceCode '${masterCode}' is also the code of a worker: choose another`);
    }
    procs.push({ name: 'worker ' + code, role: 'tx-worker', code, port: internalPort + i, servesTx: true });
  }
  // the options (cluster.md, "Options"): with the shared cache, any process can answer any
  // cache-id, so by default a cached request goes to the least loaded; cacheAffinity: true
  // keeps sending it to the process that issued it while that one is up
  const sharedCache = cluster.sharedCache === true;
  return {
    port,
    procs,
    txPaths: (tx.endpoints || []).map(e => String(e.path).replace(/\/+$/, '')),
    drainMs: Number(cluster.drainSeconds || 30) * 1000,
    routing: { cacheAffinity: !sharedCache || cluster.cacheAffinity === true, sharedClosure: cluster.sharedClosure === true }
  };
}

/**
 * Where a request goes, by the rules in nginx.md.
 * @param {string} url - the request target (path and query)
 * @param {Object} headers - the request headers (lower case names)
 * @param {string[]} txPaths - the tx endpoint paths, e.g. ['/r4', '/r5']
 * @param {Object} [routing] - from loadSettings: cacheAffinity (default true) sends a
 *   request with a cache-id to the process that issued it; sharedClosure sends $closure
 *   to any tx process rather than the master
 * @returns {{to: 'master'}|{to: 'owner', code: string}|{to: 'tx'}}
 */
function classify(url, headers, txPaths, routing = {}) {
  let p = String(url).split('?')[0];
  try {
    p = decodeURIComponent(p);
  } catch {
    // leave it as it is
  }
  const ep = txPaths.find(e => p === e || p.startsWith(e + '/'));
  if (!ep) {
    return { to: 'master' };
  }
  const rest = p.substring(ep.length);
  // the closure tables (unless shared) and the syndication store are the master's; the
  // source info pages carry the VSAC resync form, which writes the VSAC database
  if (/^\/\$closure\/?$/.test(rest)) {
    // closure never uses a cache-id, so the least loaded, whatever the header says
    return routing.sharedClosure ? { to: 'tx' } : { to: 'master' };
  }
  if (/^\/syndication(\/|$)/.test(rest) || rest.startsWith('/info/')) {
    return { to: 'master' };
  }
  if (routing.cacheAffinity === false) {
    return { to: 'tx' };
  }
  const m = /^([A-Za-z0-9]{1,16})\./.exec(headers['x-cache-id'] || '');
  return m ? { to: 'owner', code: m[1] } : { to: 'tx' };
}

/**
 * The process to send a request to, or null if none is ready.
 * @param {Object} route - from classify
 * @param {Object[]} procs - {code, role, servesTx, ready, outstanding}
 */
let rotation = 0;
function pickTarget(route, procs) {
  if (route.to === 'master') {
    return procs.find(p => p.role === 'master' && p.ready) || null;
  }
  if (route.to === 'owner') {
    const owner = procs.find(p => p.code === route.code && p.ready && p.servesTx);
    if (owner) {
      return owner;
    }
    // the owner is down (or the code is unknown): any tx process answers. Without the
    // shared cache that is cache-id-unknown, which the client recovers from by starting a
    // new cache; with it, the cache is there
  }
  const candidates = procs.filter(p => p.servesTx && p.ready);
  if (candidates.length === 0) {
    return null;
  }
  rotation = (rotation + 1) % candidates.length;
  let best = null;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[(rotation + i) % candidates.length];
    if (!best || c.outstanding < best.outstanding) {
      best = c;
    }
  }
  return best;
}

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1';
}

/**
 * @param {Object} settings - from loadSettings, plus optionally
 *   command(proc): [executable, args] to start a process (tests), healthPath, log
 */
function createLauncher(settings) {
  const log = settings.log || ((msg) => console.log(`[cluster] ${msg}`));
  const healthPath = settings.healthPath || '/health';
  const command = settings.command || ((proc) => [process.execPath, [
    ...new Set(['--expose-gc', ...process.execArgv]), path.join(__dirname, 'server.js'),
    `--role=${proc.role}`, `--instance-code=${proc.code}`, `--port=${proc.port}`]]);
  const procs = settings.procs.map(p => ({
    ...p, child: null, ready: false, outstanding: 0, failures: 0, startedAt: 0, restartTimer: null,
    // timeout: a connection idle in the pool this long is closed (see UPSTREAM_IDLE_MS); a
    // request in progress is not affected
    agent: new http.Agent({ keepAlive: true, maxSockets: 256, timeout: settings.upstreamIdleMs || UPSTREAM_IDLE_MS })
  }));
  let server = null;
  let stopping = false;
  let onIdle = null;

  function totalOutstanding() {
    return procs.reduce((n, p) => n + p.outstanding, 0);
  }

  function startProcess(proc) {
    return new Promise((resolve) => {
      if (stopping) {
        return resolve(false);
      }
      const [cmd, args] = command(proc);
      proc.startedAt = Date.now();
      const child = spawn(cmd, args, { stdio: 'inherit', env: process.env });
      proc.child = child;
      let poll = null;
      child.on('exit', (code, signal) => {
        clearTimeout(poll);
        proc.ready = false;
        proc.child = null;
        resolve(false);
        if (stopping) {
          return;
        }
        proc.failures = Date.now() - proc.startedAt > HEALTHY_RUN_MS ? 1 : proc.failures + 1;
        const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (proc.failures - 1));
        log(`${proc.name} exited (${signal || code}); restarting in ${delay / 1000} s`);
        proc.restartTimer = setTimeout(() => startProcess(proc), delay);
      });
      const check = () => {
        const req = http.get({ host: '127.0.0.1', port: proc.port, path: healthPath, agent: false }, (res) => {
          res.resume();
          if (res.statusCode === 200 && proc.child === child) {
            proc.ready = true;
            log(`${proc.name} (${proc.code}) ready on port ${proc.port}`);
            resolve(true);
          } else {
            poll = setTimeout(check, HEALTH_POLL_MS);
          }
        });
        req.on('error', () => {
          if (proc.child === child) {
            poll = setTimeout(check, HEALTH_POLL_MS);
          }
        });
      };
      poll = setTimeout(check, HEALTH_POLL_MS);
    });
  }

  function proxy(req, res) {
    const target = pickTarget(classify(req.url, req.headers, settings.txPaths, settings.routing), procs);
    if (!target) {
      return fail(res, 503, 'No server process is ready to take this request; try again shortly');
    }
    target.outstanding++;
    let finished = false;
    const finish = () => {
      if (!finished) {
        finished = true;
        target.outstanding--;
        if (onIdle && totalOutstanding() === 0) {
          onIdle();
        }
      }
    };
    const headers = { ...req.headers };
    for (const h of HOP_BY_HOP) {
      delete headers[h];
    }
    const client = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    headers['x-forwarded-for'] = headers['x-forwarded-for'] ? `${headers['x-forwarded-for']}, ${client}` : client;
    if (!headers['x-forwarded-proto'] || !isLoopback(client)) {
      headers['x-forwarded-proto'] = 'http';
    }
    const upstream = http.request({
      host: '127.0.0.1', port: target.port, method: req.method, path: req.url, headers, agent: target.agent
    }, (ures) => {
      const out = { ...ures.headers };
      for (const h of HOP_BY_HOP) {
        delete out[h];
      }
      if (stopping) {
        out.connection = 'close';
      }
      res.writeHead(ures.statusCode, ures.statusMessage, out);
      ures.pipe(res);
      ures.on('error', () => res.destroy());
    });
    upstream.on('error', (err) => {
      if (!res.headersSent) {
        fail(res, 502, `The ${target.name} process did not answer (${err.code || err.message})`);
      } else {
        res.destroy();
      }
      finish();
    });
    res.on('close', () => {
      if (!res.writableFinished) {
        upstream.destroy();
      }
      finish();
    });
    req.pipe(upstream);
  }

  function fail(res, status, text) {
    res.writeHead(status, { 'Content-Type': 'application/fhir+json', 'Retry-After': '5', ...(stopping ? { Connection: 'close' } : {}) });
    res.end(JSON.stringify({
      resourceType: 'OperationOutcome',
      issue: [{ severity: 'error', code: 'transient', details: { text }, diagnostics: text }]
    }));
  }

  async function start() {
    const master = procs.find(p => p.role === 'master');
    // the master first, and on its own: on a new data directory it builds the package
    // caches and creates the VSAC database, which processes starting together would corrupt.
    // (If it exits before it is ready, it is started again, as any process is.)
    log(`starting the master (${master.code}) on port ${master.port}`);
    void startProcess(master);
    await new Promise(resolve => {
      const t = setInterval(() => {
        if (master.ready || stopping) {
          clearInterval(t);
          resolve();
        }
      }, HEALTH_POLL_MS);
    });
    if (stopping) {
      return;
    }
    server = http.createServer(proxy);
    server.keepAliveTimeout = 65000;
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(settings.port, resolve);
    });
    log(`listening on port ${settings.port}; starting ${procs.length - 1} worker(s)`);
    // one after another, each once the one before is ready (or has exited, and is being
    // restarted): a worker only reads the caches the master built, but starting them together
    // would put every worker's load (and its memory peak) at the same moment
    // (in the background: start() returns once the master is ready and the port is open)
    void (async () => {
      for (const p of procs) {
        if (p !== master && !stopping) {
          await startProcess(p);
        }
      }
    })();
  }

  /**
   * Stop taking connections, wait for the requests in progress (up to drainMs), then stop
   * every process (SIGTERM, then SIGKILL after 30 s).
   */
  async function stop() {
    if (stopping) {
      return;
    }
    stopping = true;
    for (const p of procs) {
      clearTimeout(p.restartTimer);
    }
    if (server) {
      server.close();
      server.closeIdleConnections();
      const idle = setInterval(() => server.closeIdleConnections(), 100);
      if (totalOutstanding() > 0) {
        log(`draining: ${totalOutstanding()} request(s) in progress`);
        await new Promise(resolve => {
          const timer = setTimeout(resolve, settings.drainMs);
          onIdle = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
      clearInterval(idle);
      server.closeAllConnections();
    }
    await Promise.all(procs.filter(p => p.child).map(p => new Promise(resolve => {
      const child = p.child;
      const kill = setTimeout(() => child.kill('SIGKILL'), 30000);
      child.once('exit', () => {
        clearTimeout(kill);
        resolve();
      });
      child.kill('SIGTERM');
    })));
    for (const p of procs) {
      p.agent.destroy();
    }
    log('stopped');
  }

  return { start, stop, procs, get server() { return server; } };
}

async function main() {
  const folders = require('./library/folder-setup');
  let launcher;
  try {
    const config = JSON.parse(fs.readFileSync(folders.filePath('config.json'), 'utf8'));
    launcher = createLauncher(loadSettings(process.argv.slice(2), process.env, config));
  } catch (error) {
    console.error(`cluster.js: ${error.message}`);
    process.exit(1);
  }
  const shutdown = () => launcher.stop().then(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  await launcher.start();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { loadSettings, classify, pickTarget, createLauncher };
