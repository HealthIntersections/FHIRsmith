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
 *  - sends a process at most maxOutstanding tx requests at once; the rest wait, and one that
 *    has waited queueSeconds (ownerQueueSeconds with a cache-id) gets 503 + Retry-After
 *  - lets a cheap request (by method and path: the fast lane) go to a process with up to
 *    fastLaneExtra more than maxOutstanding, and ahead of the others waiting
 *  - sends no new requests to a process that answered 503 for cooldownSeconds, while
 *    another can take them
 *  - restarts a process that exits, waiting longer each time it fails quickly (up to a minute)
 *  - restarts a tx-worker that has held memory over the memory guard's refusal threshold for
 *    recycleSeconds with no request at work (it would otherwise refuse everything, for good)
 *  - on SIGTERM or SIGINT, stops taking connections, lets the requests in progress finish,
 *    then stops the processes (each shuts down as a single server does)
 *
 *   node cluster.js [--workers=N] [--port=P] [--master-serves-tx=false]
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { checkInstanceCode } = require('./library/role');
const { ClusterMetrics, METRIC, SNAPSHOT } = require('./library/cluster-metrics');
const { PendingCounts, COUNTS } = require('./library/cluster-counts');
const { readCgroupMemoryLimit, ownCgroupDir, readCgroupAnon } = require('./library/cgroup-memory');
const { DEFAULT_REJECT_FRACTION } = require('./library/memory-guard');

const HEALTH_POLL_MS = 250;
const MAX_BACKOFF_MS = 60000;
// An idle keep-alive connection to a process is closed by the launcher after this long:
// below the processes' own keepAliveTimeout (65 s with library/keep-alive.js, Node's default
// of 5 s on a server without it), so the launcher never sends a request down a connection the
// process is closing at that moment (a reset, which the client would see as a 502)
const UPSTREAM_IDLE_MS = 4000;
// a process that ran this long before exiting is restarted at once
const HEALTHY_RUN_MS = 60000;
// tx requests sent to one process at once; the rest wait in the launcher (cluster.md)
const MAX_OUTSTANDING = 16;
// a waiting tx request gets 503 after this long; one with a cache-id, which only its owner
// can take, after OWNER_QUEUE_MS
const QUEUE_MS = 1000;
const OWNER_QUEUE_MS = 30000;
// a process that answered 503 gets no new requests for this long while another can take
// them. Short: its memory guard re-measures only when a request arrives
const COOLDOWN_MS = 2000;
// a tx-worker over the memory guard's refusal threshold this long, with no request at work, is
// restarted (cluster.md, "Memory"). 30 s: well past a forced GC's effect (the guard forces one
// at once, then 5 s, 10 s, 20 s later), and short next to a client's retries
const RECYCLE_MS = 30000;
// how often the launcher measures for that
const RECYCLE_CHECK_MS = 1000;
// a request in flight this long is work; a refusal (503) is answered at once
const AT_WORK_MS = 1000;
// memory to leave free under the guard's refusal threshold once every process is loaded and
// idle (cluster.md, "Memory"): about what one heavy operation uses. 2 GB: an $expand of a large
// SNOMED value set or a big $batch-validate-code takes 1-2 GB; with less, the first one shuts
// the gate for everyone
const HEADROOM_GB = 2;
// a fast-lane request (isFastLane) may go to a process with this many more than
// MAX_OUTSTANDING; a POST takes the lane only with a Content-Length up to FAST_LANE_MAX_BYTES
const FAST_LANE_EXTRA = 4;
const FAST_LANE_MAX_BYTES = 1024;
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
  const workersGiven = flags.workers || env.FHIRSMITH_WORKERS || cluster.workers;
  const workers = Number(workersGiven || 2);
  const internalPort = Number(flags['internal-port'] || cluster.internalPort || port + 1);
  const masterCode = checkInstanceCode(tx.instanceCode || 'm0', 'modules.tx.instanceCode');
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
    maxOutstanding: Number(cluster.maxOutstanding ?? MAX_OUTSTANDING),
    queueMs: Number(cluster.queueSeconds ?? QUEUE_MS / 1000) * 1000,
    ownerQueueMs: Number(cluster.ownerQueueSeconds ?? OWNER_QUEUE_MS / 1000) * 1000,
    cooldownMs: Number(cluster.cooldownSeconds ?? COOLDOWN_MS / 1000) * 1000,
    recycleMs: Number(cluster.recycleSeconds ?? RECYCLE_MS / 1000) * 1000,
    // the number of workers was not given: fewer if memory is short (see sizeWorkers)
    workersDefault: !workersGiven,
    headroomBytes: Number(cluster.memoryHeadroomGB ?? HEADROOM_GB) * 2 ** 30,
    memory: (config.server && config.server.memory) || {},
    fastLaneExtra: Number(cluster.fastLaneExtra ?? FAST_LANE_EXTRA),
    fastLaneMaxBytes: Number(cluster.fastLaneMaxBytes ?? FAST_LANE_MAX_BYTES),
    routing: { cacheAffinity: !sharedCache || cluster.cacheAffinity === true, sharedClosure: cluster.sharedClosure === true }
  };
}

// the path after the tx endpoint ('' for the endpoint itself), or null if not a tx path
function txRest(url, txPaths) {
  let p = String(url).split('?')[0];
  try {
    p = decodeURIComponent(p);
  } catch {
    // leave it as it is
  }
  const ep = txPaths.find(e => p === e || p.startsWith(e + '/'));
  return ep === undefined ? null : p.substring(ep.length);
}

const FAST_OPS = /^(\/[A-Za-z]+(\/[A-Za-z0-9.-]{1,64})?)?\/\$(lookup|subsumes|validate-code)$/;
const READ = /^\/[A-Za-z]+\/[A-Za-z0-9.-]{1,64}$/;

/**
 * Whether a tx request takes the fast lane (cluster.md). By method, path and declared size
 * only: the launcher doesn't read bodies. A GET or HEAD of metadata, a read (/Type/id),
 * $lookup, $subsumes or $validate-code: its parameters are all in the URL, so it carries no
 * inline ValueSet or CodeSystem. A POST of those three operations only with a Content-Length
 * of at most maxBytes (0: none); one with a large inline resource, or with no length, waits
 * with the rest.
 * @param {Object} req - method, url, headers
 */
function isFastLane(req, txPaths, maxBytes) {
  const rest = txRest(req.url, txPaths);
  if (rest === null) {
    return false;
  }
  const r = rest.replace(/\/+$/, '');
  if (req.method === 'GET' || req.method === 'HEAD') {
    return r === '/metadata' || READ.test(r) || FAST_OPS.test(r);
  }
  const len = req.headers['content-length'];
  return req.method === 'POST' && maxBytes > 0 && FAST_OPS.test(r) && /^\d+$/.test(len || '') && Number(len) <= maxBytes;
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
  const rest = txRest(url, txPaths);
  if (rest === null) {
    return { to: 'master' };
  }
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
 * @param {Object[]} procs - {code, role, servesTx, ready, outstanding, coolUntil}
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
  const ready = procs.filter(p => p.servesTx && p.ready);
  if (ready.length === 0) {
    return null;
  }
  // not one that is refusing (it answered 503), unless they all are
  const now = Date.now();
  const warm = ready.filter(p => !(p.coolUntil > now));
  const candidates = warm.length ? warm : ready;
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

/**
 * The launcher's view of the memory guard's refusal threshold (library/memory-guard.js), for
 * recycling. With the limit on the processes' own cgroup, the guard measures the cgroup's
 * private memory, so `excess` is how far that is over the threshold; without, each process
 * measures its own RSS against the limit (`excess` null). A process's own memory is its RssAnon
 * (Linux /proc; elsewhere nothing is read and nothing is recycled).
 * @param {Object} memory - config.server.memory
 * @returns {{describe: string, rejectAt: number, sample: function(Object[]): {excess: number|null, own: Map}}}
 *   sample(procs): own maps each proc to its memory in bytes (0: not known)
 */
function memorySampler(memory = {}) {
  const f = memory.rejectFraction;
  const fraction = (typeof f === 'number' && f > 0 && f <= 1) ? f : DEFAULT_REJECT_FRACTION;
  const cg = readCgroupMemoryLimit();
  const limit = cg.limit || require('os').totalmem();
  const own = ownCgroupDir();
  const group = own && cg.source && path.dirname(cg.source) === own.dir ? own : null;
  const rejectAt = limit * fraction;
  const anonOf = (pid) => {
    try {
      const m = /^RssAnon:\s+(\d+) kB/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
      return m ? Number(m[1]) * 1024 : 0;
    } catch {
      return 0;
    }
  };
  return {
    rejectAt,
    describe: `over ${(rejectAt / 2 ** 30).toFixed(1)} GB (${Math.round(fraction * 100)}% of ${(limit / 2 ** 30).toFixed(1)} GB)` +
      (group ? ' for the whole cgroup' : ' for the process'),
    sample(procs) {
      const excess = group ? readCgroupAnon(group) - rejectAt : null;
      return { excess, own: new Map(procs.map(p => [p, p.child && p.child.pid ? anonOf(p.child.pid) : 0])) };
    }
  };
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
  const maxOutstanding = settings.maxOutstanding ?? MAX_OUTSTANDING; // 0: no limit
  const queueMs = settings.queueMs ?? QUEUE_MS; // 0: refuse at once
  const ownerQueueMs = settings.ownerQueueMs ?? OWNER_QUEUE_MS;
  const cooldownMs = settings.cooldownMs ?? COOLDOWN_MS; // 0: none
  const recycleMs = settings.recycleMs ?? RECYCLE_MS; // 0: never
  // (tests give their own)
  const memory = settings.memorySampler || memorySampler(settings.memory);
  const headroom = settings.headroomBytes ?? HEADROOM_GB * 2 ** 30;
  const fastLaneExtra = settings.fastLaneExtra ?? FAST_LANE_EXTRA; // 0: no fast lane
  const fastLaneMaxBytes = settings.fastLaneMaxBytes ?? FAST_LANE_MAX_BYTES;
  const command = settings.command || ((proc) => [process.execPath, [
    ...new Set(['--expose-gc', ...process.execArgv]), path.join(__dirname, 'server.js'),
    `--role=${proc.role}`, `--instance-code=${proc.code}`, `--port=${proc.port}`]]);
  const procs = settings.procs.map(p => ({
    ...p, child: null, ready: false, outstanding: 0, coolUntil: 0, failures: 0, startedAt: 0, restartTimer: null,
    // when each request in flight was sent; since when it has been over the refusal threshold
    // with none at work; whether it is being restarted for that
    // and its memory when it was ready (checkMemory)
    sentAt: new Set(), overSince: 0, recycling: false, readyMemory: null,
    // timeout: a connection idle in the pool this long is closed (see UPSTREAM_IDLE_MS); a
    // request in progress is not affected
    agent: new http.Agent({ keepAlive: true, maxSockets: 256, timeout: settings.upstreamIdleMs || UPSTREAM_IDLE_MS })
  }));
  const metrics = new ClusterMetrics(procs);
  // the workers' request counts, on their way to the master's statistics
  const pendingCounts = new PendingCounts();
  let countsInFlight = null;
  let server = null;
  let stopping = false;
  let onIdle = null;
  // tx requests waiting for a process with room, oldest first; fast-lane ones apart, and first
  const waiting = [];
  const fastWaiting = [];
  let queueRefused = 0;
  let lastQueueLog = 0;
  let memoryTimer = null;

  // Only the master renders the public home/dashboard pages. Keep at most one
  // snapshot in flight, coalescing changes if its IPC channel is backpressured.
  function publishMetrics() {
    const master = procs.find(p => p.role === 'master');
    const child = master && master.child;
    if (!child || !child.connected) return;
    if (master.metricsSending === child) {
      master.metricsDirty = true;
      return;
    }
    master.metricsSending = child;
    master.metricsDirty = false;
    try {
      child.send({ type: SNAPSHOT, ...metrics.snapshot() }, () => {
        if (master.metricsSending !== child) return;
        master.metricsSending = null;
        if (master.metricsDirty && master.child === child && child.connected) publishMetrics();
      });
    } catch {
      master.metricsSending = null;
    }
  }

  // Pass the workers' request counts on to the master (library/cluster-counts.js), once it is
  // ready: it listens before it answers /health. One lot at a time; a lot that can't be
  // delivered is kept for the next try (more counts arriving, or the master becoming ready)
  function deliverCounts() {
    const master = procs.find(p => p.role === 'master');
    const child = master && master.child;
    if (countsInFlight || pendingCounts.size === 0 || !child || !child.connected || !master.ready) {
      return countsInFlight || Promise.resolve();
    }
    const rows = pendingCounts.take();
    countsInFlight = new Promise(resolve => {
      const done = error => {
        countsInFlight = null;
        if (error) {
          pendingCounts.add(rows);
        }
        resolve();
        if (!error && pendingCounts.size > 0) {
          void deliverCounts();
        }
      };
      try {
        child.send({ type: COUNTS, rows }, done);
      } catch (error) {
        done(error);
      }
    });
    return countsInFlight;
  }

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
      proc.readyMemory = null;
      metrics.state(proc.code, 'starting');
      const child = spawn(cmd, args, { stdio: ['inherit', 'inherit', 'inherit', 'ipc'], env: process.env });
      proc.child = child;
      child.on('message', message => {
        if (proc.child === child && message && message.type === METRIC && metrics.record(proc.code, message)) {
          publishMetrics();
        } else if (message && message.type === COUNTS && proc.role !== 'master') {
          // real requests, even from a child that is going away
          pendingCounts.add(message.rows);
          void deliverCounts();
        }
      });
      child.on('disconnect', () => {
        if (proc.child === child) {
          metrics.state(proc.code, 'unavailable');
          publishMetrics();
        }
      });
      publishMetrics();
      let poll = null;
      child.on('exit', (code, signal) => {
        clearTimeout(poll);
        proc.ready = false;
        proc.child = null;
        metrics.state(proc.code, stopping ? 'unavailable' : 'restarting');
        publishMetrics();
        resolve(false);
        if (stopping) {
          return;
        }
        if (proc.recycling) {
          // the launcher stopped it (see checkMemory): at once, and not a failure
          proc.recycling = false;
          log(`${proc.name} exited (${signal || code}) to be recycled; restarting`);
          void startProcess(proc);
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
            sendWaiting();
            metrics.state(proc.code, 'ready');
            publishMetrics();
            if (proc.role === 'master') {
              void deliverCounts();
            }
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

  const full = (p, fast) => maxOutstanding > 0 && p.outstanding >= maxOutstanding + (fast ? fastLaneExtra : 0);

  // true if the request was sent (or refused), false if it must wait. The master's own
  // paths and CORS preflights don't wait
  function send(w) {
    const target = pickTarget(w.route, procs);
    if (!target) {
      fail(w.res, 503, 'No server process is ready to take this request; try again shortly');
      return true;
    }
    if (w.route.to !== 'master' && w.req.method !== 'OPTIONS' && full(target, w.fast)) {
      return false;
    }
    forward(w.req, w.res, target);
    return true;
  }

  // the fast lane first, then oldest first; one waiting for its owner doesn't hold up the rest
  function sendWaiting() {
    for (const queue of [fastWaiting, waiting]) {
      const fast = queue === fastWaiting;
      for (let i = 0; i < queue.length && procs.some(p => p.ready && p.servesTx && !full(p, fast));) {
        const w = queue[i];
        if (send(w)) {
          clearTimeout(w.timer);
          queue.splice(i, 1);
        } else {
          i++;
        }
      }
    }
  }

  function refuse(w, ms) {
    queueRefused++;
    const now = Date.now();
    if (now - lastQueueLog >= 60000) {
      lastQueueLog = now;
      log(`over capacity: requests waited ${ms / 1000} s for a process and were refused (${queueRefused} so far)`);
    }
    fail(w.res, 503, `The server is busy: no process was free for ${ms / 1000} s; try again shortly`, true);
  }

  function proxy(req, res) {
    const w = { req, res, route: classify(req.url, req.headers, settings.txPaths, settings.routing) };
    w.fast = fastLaneExtra > 0 && w.route.to !== 'master' && isFastLane(req, settings.txPaths, fastLaneMaxBytes);
    if (send(w)) {
      return;
    }
    if (stopping) {
      return fail(res, 503, 'The server is stopping; try again shortly');
    }
    const ms = w.route.to === 'owner' ? ownerQueueMs : queueMs;
    if (ms <= 0) {
      return refuse(w, 0);
    }
    const queue = w.fast ? fastWaiting : waiting;
    queue.push(w);
    const leave = () => {
      const i = queue.indexOf(w);
      if (i >= 0) {
        queue.splice(i, 1);
        clearTimeout(w.timer);
      }
    };
    res.on('close', leave);
    w.timer = setTimeout(() => {
      leave();
      refuse(w, ms);
    }, ms);
  }

  function forward(req, res, target) {
    target.outstanding++;
    const sent = { at: Date.now() };
    target.sentAt.add(sent);
    let finished = false;
    const finish = () => {
      if (!finished) {
        finished = true;
        target.outstanding--;
        target.sentAt.delete(sent);
        sendWaiting();
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
      if (ures.statusCode === 503 && cooldownMs > 0) {
        target.coolUntil = Date.now() + cooldownMs;
        setTimeout(sendWaiting, cooldownMs).unref();
      }
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

  /**
   * Every RECYCLE_CHECK_MS: a tx-worker that has been over the memory guard's refusal threshold
   * (see memorySampler) for recycleMs, with no request at work all that time, is restarted, the
   * largest first and one at a time. Its guard would refuse every request until its memory
   * fell, and with nothing running, nothing will free it. With the cgroup measured, only a
   * worker that has grown since it was ready by more than the cgroup is over: a restart takes
   * it back to about that size, so restarting a smaller one would not reopen the gate. The
   * master is not restarted: it holds what only it has (cluster.md, "What runs where").
   */
  function checkMemory() {
    if (stopping || procs.some(p => p.recycling)) {
      return;
    }
    const now = Date.now();
    const workers = procs.filter(p => p.role === 'tx-worker');
    const { excess, own } = memory.sample(workers);
    const over = new Map();
    let largest = null;
    for (const p of workers) {
      const mine = own.get(p) || 0;
      if (p.ready && p.readyMemory === null) {
        p.readyMemory = mine;
      }
      const atWork = [...p.sentAt].some(s => now - s.at >= AT_WORK_MS);
      over.set(p, mine > 0 && (excess === null ? mine > memory.rejectAt : excess > 0 && mine - p.readyMemory > excess) ? mine : 0);
      if (!p.ready || !over.get(p) || atWork) {
        p.overSince = 0;
        continue;
      }
      p.overSince = p.overSince || now;
      // and none in flight at all now (a refusal is answered within milliseconds)
      if (now - p.overSince >= recycleMs && p.outstanding === 0 && (!largest || over.get(p) > over.get(largest))) {
        largest = p;
      }
    }
    if (largest) {
      recycle(largest, `its memory (${(over.get(largest) / 2 ** 30).toFixed(1)} GB) has been ${memory.describe}` +
        (excess !== null ? ` (by ${(excess / 2 ** 30).toFixed(1)} GB)` : '') + ` for ${Math.round((now - largest.overSince) / 1000)} s with no request at work`);
    }
  }

  // no new requests; those it has (refusals) finish; then it stops as on shutdown, and the
  // exit handler starts it again at once
  function recycle(p, why) {
    log(`recycling ${p.name}: ${why}`);
    p.recycling = true;
    p.ready = false;
    p.overSince = 0;
    metrics.state(p.code, 'restarting');
    publishMetrics();
    const child = p.child;
    const t0 = Date.now();
    const stopWhenIdle = () => {
      if (p.child !== child) {
        return;
      }
      if (p.outstanding > 0 && Date.now() - t0 < settings.drainMs) {
        return void setTimeout(stopWhenIdle, 100);
      }
      const kill = setTimeout(() => child.kill('SIGKILL'), 30000);
      child.once('exit', () => clearTimeout(kill));
      child.kill('SIGTERM');
    };
    stopWhenIdle();
  }

  // close: the request body has not been read, and an overloaded server sheds the connection too
  function fail(res, status, text, close = false) {
    res.writeHead(status, { 'Content-Type': 'application/fhir+json', 'Retry-After': '5', ...(stopping || close ? { Connection: 'close' } : {}) });
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
    sizeWorkers(master);
    log(`listening on port ${settings.port}; starting ${procs.length - 1} worker(s)`);
    log(`limits: maxOutstanding ${maxOutstanding}, queueSeconds ${queueMs / 1000}, ownerQueueSeconds ${ownerQueueMs / 1000}, cooldownSeconds ${cooldownMs / 1000}, ` +
      `fastLaneExtra ${fastLaneExtra}, fastLaneMaxBytes ${fastLaneMaxBytes}, ` +
      `recycleSeconds ${recycleMs / 1000}` + (recycleMs > 0 ? ` (a tx-worker ${memory.describe} that long, with no request at work, is restarted)` : ' (never)'));
    if (recycleMs > 0) {
      memoryTimer = setInterval(checkMemory, settings.recycleCheckMs || RECYCLE_CHECK_MS);
      memoryTimer.unref();
    }
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
      if (!stopping) {
        checkIdleMemory();
      }
    })();
  }

  const GB = (b) => (b / 2 ** 30).toFixed(1);

  /**
   * Once the master is loaded: its memory is about what each worker will use idle. If the
   * number of workers was not given, start no more than fit under the refusal threshold with
   * `headroom` to spare (at least one); if it was, warn when they won't fit. The guard counts
   * every process against the one limit, so N+1 loaded processes sitting at the threshold
   * refuse every request, busy or not.
   */
  function sizeWorkers(master) {
    const perProcess = memory.sample([master]).own.get(master) || 0;
    if (!perProcess) {
      return; // not measurable here (not Linux)
    }
    const workers = procs.filter(p => p.role === 'tx-worker');
    const fit = Math.max(1, Math.floor((memory.rejectAt - headroom - perProcess) / perProcess));
    const idle = (1 + workers.length) * perProcess;
    const line = `the master uses ${GB(perProcess)} GB loaded, so ${workers.length + 1} processes would use about ${GB(idle)} GB idle; ` +
      `the memory guard refuses requests ${memory.describe}, and memoryHeadroomGB is ${GB(headroom)}`;
    if (idle + headroom <= memory.rejectAt) {
      log(`memory: ${line}`);
    } else if (settings.workersDefault && fit < workers.length) {
      for (const p of workers.slice(fit)) {
        procs.splice(procs.indexOf(p), 1);
        metrics.series.delete(p.code);
      }
      log(`memory: ${line}: starting ${fit} worker(s), not ${workers.length} (set server.cluster.workers to choose)`);
    } else {
      log(`WARNING memory: ${line}: ${workers.length} worker(s) leave too little room; at most ${fit} would, or raise the limit`);
    }
  }

  // once every worker is ready: what they all use idle, against the threshold
  function checkIdleMemory() {
    const { excess, own } = memory.sample(procs);
    const total = excess !== null ? excess + memory.rejectAt : [...own.values()].reduce((a, b) => a + b, 0);
    if (!total) {
      return;
    }
    const room = memory.rejectAt - total;
    log(`${room < headroom ? 'WARNING ' : ''}memory: all processes loaded and idle use ${GB(total)} GB, ` +
      `${GB(room)} GB under the threshold (memoryHeadroomGB ${GB(headroom)})` +
      (room < headroom ? '; a heavy request will shut the gate for everyone: use fewer workers or a larger limit' : ''));
  }

  /**
   * Stop taking connections, wait for the requests in progress (up to drainMs), then stop
   * the workers, then the master (SIGTERM, then SIGKILL after 30 s), so the workers' last
   * request counts reach the master's statistics.
   */
  async function stop() {
    if (stopping) {
      return;
    }
    stopping = true;
    clearInterval(memoryTimer);
    for (const p of procs) {
      clearTimeout(p.restartTimer);
    }
    // those still waiting haven't started: refuse them; drain only those in progress
    for (const w of [...fastWaiting.splice(0), ...waiting.splice(0)]) {
      clearTimeout(w.timer);
      fail(w.res, 503, 'The server is stopping; try again shortly');
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
    // the workers first: each sends its last request counts as it stops, and they reach
    // the master's statistics before the master stops
    const stopChild = (p) => new Promise(resolve => {
      const child = p.child;
      if (!child) {
        return resolve();
      }
      const kill = setTimeout(() => child.kill('SIGKILL'), 30000);
      // exited, and everything it sent on the channel has been read
      let waiting = child.connected ? 2 : 1;
      const one = () => {
        if (--waiting === 0) {
          clearTimeout(kill);
          resolve();
        }
      };
      child.once('exit', one);
      if (child.connected) {
        child.once('disconnect', one);
      }
      child.kill('SIGTERM');
    });
    await Promise.all(procs.filter(p => p.role !== 'master').map(stopChild));
    const deliverWait = new Promise(resolve => setTimeout(resolve, 5000).unref());
    await Promise.race([deliverCounts(), deliverWait]);
    await Promise.all(procs.filter(p => p.role === 'master').map(stopChild));
    for (const p of procs) {
      p.agent.destroy();
    }
    log('stopped');
  }

  return { start, stop, procs, metrics, get server() { return server; } };
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

module.exports = { loadSettings, classify, isFastLane, pickTarget, createLauncher, memorySampler };
