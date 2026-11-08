#!/usr/bin/env node

//
// Copyright 2025, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * An optional launcher: one master and N terminology workers on one machine, behind one port
 * (see cluster.md). It applies the routing of nginx.md's configuration, as one upstream: always
 * run it behind nginx on the same host, with request buffering on (proxy_request_buffering,
 * nginx's default). It is not built to face clients itself. It:
 *
 *  - starts the master (node server.js --role=master), waits until it is ready (it says so
 *    on its IPC channel once it listens), then starts the workers (--role=tx-worker) one
 *    after another, each once the one before is ready, each with its own instance code and
 *    port; exits 1 if the master exits maxStartFailures times without ever being ready
 *  - routes: a request with X-Cache-Id to the process that issued it (by the id's prefix);
 *    $closure, the syndication feed, the source info pages and everything that isn't a tx
 *    endpoint to the master; any other tx request to the tx process with the fewest
 *    requests outstanding
 *  - sends a process at most maxOutstanding tx requests at once (those routed to a tx process,
 *    not the master's own paths or CORS preflights, which neither wait nor count); the rest
 *    wait, and one that has waited queueSeconds (ownerQueueSeconds with a cache-id) gets 503
 *    + Retry-After
 *  - lets cheap requests (by method and path: the fast lane) use fastLaneExtra more slots
 *    than maxOutstanding, ahead of the others, leaving them normalMinSlots
 *  - sends no new requests to a process that answered 503 for cooldownSeconds, while
 *    another can take them
 *  - answers 504 for a process that hasn't begun its response in upstreamTimeoutSeconds, and
 *    aborts that request; after SUSPECT_TIMEOUTS in a row, the process cools as on a 503
 *  - frees a tx request's slot when the process's response ends, however slowly the client
 *    reads it, and closes the connection of a client that takes none of a response for
 *    writeTimeoutSeconds
 *  - restarts a process that exits, waiting longer each time it fails quickly (up to a minute)
 *  - restarts a tx-worker held over the memory guard's refusal threshold for recycleSeconds
 *    with no request at work
 *  - on SIGTERM or SIGINT, stops taking connections, lets the requests in progress finish,
 *    then stops the processes (each shuts down as a single server does)
 *
 *   node cluster.js [--workers=N] [--port=P] [--internal-port=P] [--master-serves-tx=false]
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { checkInstanceCode, bindAddress, connectAddress, ROLE_TRIM_ALLOCATOR, READY } = require('./library/role');
const { ClusterMetrics, METRIC, SNAPSHOT } = require('./library/cluster-metrics');
const { PendingCounts, COUNTS } = require('./library/cluster-counts');
const { readCgroupAnon } = require('./library/cgroup-memory');
const { thresholds } = require('./library/memory-guard');
const { defaultWorkers, describeDecision } = require('./library/worker-count');
const { englishMessage } = require('./library/i18nsupport');
const { formatDuration } = require('./tx/operation-context');

const TX_ISSUE_TYPE = 'http://hl7.org/fhir/tools/CodeSystem/tx-issue-type';
const MESSAGE_ID_EXTENSION = 'http://hl7.org/fhir/StructureDefinition/operationoutcome-message-id';

// how often start() looks whether the master is ready (an in-memory flag)
const WAIT_POLL_MS = 250;
const MAX_BACKOFF_MS = 60000;
// an idle connection to a process is closed after this long: below the process's own
// keep-alive timeout (5 s at the least), so no request goes down one it is closing (a 502)
const UPSTREAM_IDLE_MS = 4000;
// a process that ran this long after it was ready, before exiting, is restarted at once
const HEALTHY_RUN_MS = 60000;
// a master that exits this many times in a row without ever having been ready: the launcher
// exits 1 (cluster.md, maxStartFailures). With the waits between (1, 2, 4, 8, 16 s), the
// sixth start is 31 s after the first failure, past the 30 s an old process still shutting
// down may hold the port for (each process's SIGKILL deadline)
const MAX_START_FAILURES = 6;
// tx requests sent to one process at once; the rest wait in the launcher (cluster.md)
const MAX_OUTSTANDING = 16;
// a waiting tx request gets 503 after this long; one with a cache-id, which only its owner
// can take, after OWNER_QUEUE_MS
const QUEUE_MS = 1000;
const OWNER_QUEUE_MS = 30000;
// a process that answered 503 gets no new requests for this long while another can take
// them. Short: its memory guard re-measures only when a request arrives
const COOLDOWN_MS = 2000;
// a process that hasn't begun its response this long after the request was sent is taken to be
// wedged: the client gets 504 and the request is aborted. The operation limit
// (modules.tx.operationTimeLimit, 20 s) counts an operation's own compute, not the turns it
// waits for others on its event loop, so a heavy one in a busy process takes longer by the
// clock: three times it. Time in the launcher's queue is apart
const UPSTREAM_TIMEOUT_MS = 60000;
// this many timeouts in a row, and the process cools (as on a 503) while another can take them
const SUSPECT_TIMEOUTS = 3;
// a client that takes none of the response waiting for it this long is cut off (cluster.md,
// writeTimeoutSeconds): one that reads takes some within milliseconds; nginx's own
// send_timeout is the same 60 s
const WRITE_TIMEOUT_MS = 60000;
// a tx-worker over the memory guard's refusal threshold this long, with no request at work, is
// restarted (cluster.md, "Memory"): past the guard's own GC and trims, short next to a retry
const RECYCLE_MS = 30000;
// how often the launcher measures for that
const RECYCLE_CHECK_MS = 1000;
// a request in flight this long is work; a refusal (503) is answered at once
const AT_WORK_MS = 1000;
// memory to leave under the refusal threshold with every process loaded and idle: about what
// one heavy operation (a large SNOMED $expand, a big $batch-validate-code) uses
const HEADROOM_GB = 2;
// a fast-lane request (isFastLane) may go to a process with this many more than
// MAX_OUTSTANDING; a POST takes the lane only with a Content-Length up to FAST_LANE_MAX_BYTES
const FAST_LANE_EXTRA = 4;
const FAST_LANE_MAX_BYTES = 1024;
// while other requests wait, the fast lane leaves them this many of a process's slots, so
// heavy work goes on during a flood of cheap requests
const NORMAL_MIN_SLOTS = 4;
const GB = (b) => (b / 2 ** 30).toFixed(1);
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'expect'];

/**
 * The settings, from the flags, then the environment, then config.json (server.cluster).
 * @param {string[]} argv - process.argv.slice(2)
 * @param {Object} env - process.env
 * @param {Object} config - config.json
 * @param {Object} [cpu] - for tests: the CPU inputs (library/worker-count.js, cpuInputs)
 */
function loadSettings(argv, env, config, cpu = {}) {
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
  // not given: absent, null, or an empty FHIRSMITH_WORKERS; 0: the master alone
  const workersGiven = flags.workers ?? (env.FHIRSMITH_WORKERS || undefined) ?? cluster.workers ?? undefined;
  if (workersGiven !== undefined && !/^\d+$/.test(String(workersGiven))) {
    throw new Error(`the number of workers (--workers, FHIRSMITH_WORKERS or server.cluster.workers) must be a whole number, not '${workersGiven}'`);
  }
  // not given: from the CPUs, by the engine's rule (library/worker-count.js; cluster.md)
  const workerDecision = defaultWorkers({ ...cpu, cores: cluster.cores ?? cpu.cores, rule: cluster.workerRule });
  const workers = Number(workersGiven ?? workerDecision.workers);
  const internalPort = Number(flags['internal-port'] || cluster.internalPort || port + 1);
  // the master is on internalPort, worker n on internalPort + n
  if (!Number.isInteger(internalPort) || internalPort < 1 || internalPort + workers > 65535) {
    throw new Error(`the internal ports (--internal-port or server.cluster.internalPort ${internalPort}, to + ${workers} for the workers) must be port numbers`);
  }
  if (port >= internalPort && port <= internalPort + workers) {
    throw new Error(`the public port ${port} is one of the internal ports ${internalPort}-${internalPort + workers} (the master's, and one per worker): ` +
      'choose server.cluster.internalPort (--internal-port) outside it');
  }
  const masterCode = checkInstanceCode(tx.instanceCode || 'm0', 'modules.tx.instanceCode');
  const servesTx = flags['master-serves-tx'] !== undefined ? flags['master-serves-tx'] !== 'false' : cluster.masterServesTx !== false;
  // where the processes listen (server.cluster.bindAddress: loopback by default)
  const host = connectAddress(bindAddress(config));
  const procs = [{ name: 'master', role: 'master', code: masterCode, host, port: internalPort, servesTx }];
  for (let i = 1; i <= workers; i++) {
    const code = 'tx' + i;
    if (code === masterCode) {
      throw new Error(`modules.tx.instanceCode '${masterCode}' is also the code of a worker: choose another`);
    }
    procs.push({ name: 'worker ' + code, role: 'tx-worker', code, host, port: internalPort + i, servesTx: true });
  }
  // with the shared cache any process can answer any cache-id (cluster.md, "Options")
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
    upstreamTimeoutMs: Number(cluster.upstreamTimeoutSeconds ?? UPSTREAM_TIMEOUT_MS / 1000) * 1000,
    writeTimeoutMs: Number(cluster.writeTimeoutSeconds ?? WRITE_TIMEOUT_MS / 1000) * 1000,
    recycleMs: Number(cluster.recycleSeconds ?? RECYCLE_MS / 1000) * 1000,
    maxStartFailures: Number(cluster.maxStartFailures ?? MAX_START_FAILURES),
    // the number of workers was not given: fewer if memory is short (see sizeWorkers)
    workersDefault: workersGiven === undefined,
    workerDecision,
    headroomBytes: Number(cluster.memoryHeadroomGB ?? HEADROOM_GB) * 2 ** 30,
    memory: (config.server && config.server.memory) || {},
    fastLaneExtra: Number(cluster.fastLaneExtra ?? FAST_LANE_EXTRA),
    fastLaneMaxBytes: Number(cluster.fastLaneMaxBytes ?? FAST_LANE_MAX_BYTES),
    normalMinSlots: Number(cluster.normalMinSlots ?? NORMAL_MIN_SLOTS),
    routing: { cacheAffinity: !sharedCache || cluster.cacheAffinity === true, sharedClosure: cluster.sharedClosure === true, sharedCache }
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

/**
 * Whether a tx request takes the fast lane (cluster.md), by method, path and declared size (the
 * launcher doesn't read bodies): a GET or HEAD of metadata, $lookup, $subsumes or
 * $validate-code, or a POST of those three with a Content-Length of at most maxBytes (0: none).
 * @param {Object} req - method, url, headers
 */
function isFastLane(req, txPaths, maxBytes) {
  const rest = txRest(req.url, txPaths);
  if (rest === null) {
    return false;
  }
  const r = rest.replace(/\/+$/, '');
  if (req.method === 'GET' || req.method === 'HEAD') {
    return r === '/metadata' || FAST_OPS.test(r);
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
 * @param {function(Object): boolean} [hasRoom] - whether a process has room for this request:
 *   the least loaded of those that do, if any
 */
let rotation = 0;
function pickTarget(route, procs, hasRoom = () => true) {
  if (route.to === 'master') {
    return procs.find(p => p.role === 'master' && p.ready) || null;
  }
  if (route.to === 'owner') {
    const owner = procs.find(p => p.code === route.code && p.ready && p.servesTx);
    if (owner) {
      return owner;
    }
    // the owner is down (send answers that itself, without the shared cache) or the code is
    // unknown: any tx process answers. With the shared cache, the cache is there; for an
    // unknown code it is cache-id-unknown, and the client starts a new cache
  }
  const ready = procs.filter(p => p.servesTx && p.ready);
  if (ready.length === 0) {
    return null;
  }
  // not one that is refusing (it answered 503), unless they all are
  const now = Date.now();
  const warm = ready.filter(p => !(p.coolUntil > now));
  const usable = warm.length ? warm : ready;
  const open = usable.filter(hasRoom);
  const candidates = open.length ? open : usable;
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
 * The launcher's view of the memory guard's refusal threshold: the same limit, fraction and
 * cgroup (thresholds in library/memory-guard.js). sample(procs) gives each proc's RssAnon (0:
 * not known; Linux only) and, with the cgroup measured, how far it is over (`excess`; else null).
 * @param {Object} memory - config.server.memory
 */
function memorySampler(memory = {}) {
  const { limit, group, rejectFraction, rejectAt } = thresholds({ ...memory, group: true });
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
    describe: `over ${(rejectAt / 2 ** 30).toFixed(1)} GB (${Math.round(rejectFraction * 100)}% of ${(limit / 2 ** 30).toFixed(1)} GB)` +
      (group ? ' for the whole cgroup' : ' for the process'),
    sample(procs) {
      const excess = group ? readCgroupAnon(group) - rejectAt : null;
      return { excess, own: new Map(procs.map(p => [p, p.child && p.child.pid ? anonOf(p.child.pid) : 0])) };
    }
  };
}

// Node flags for the launcher itself, not its children: a debugger port each child would fight
// over (--inspect...), or a watcher that restarts a child behind the launcher's back (--watch...)
const OWN_FLAGS = /^--(inspect(-brk|-wait|-port|-publish-uid)?|debug-port|watch(-path|-preserve-output|-kill-signal)?)(=|$)/;
// those of them that take their value as the next argument when written without '='
const OWN_FLAGS_WITH_VALUE = ['--inspect-port', '--debug-port', '--inspect-publish-uid', '--watch-path', '--watch-kill-signal'];

/**
 * The launcher's Node flags (process.execArgv) that its children get: all but OWN_FLAGS.
 * @param {string[]} execArgv
 */
function childExecArgv(execArgv) {
  const out = [];
  for (let i = 0; i < execArgv.length; i++) {
    if (OWN_FLAGS.test(execArgv[i])) {
      if (OWN_FLAGS_WITH_VALUE.includes(execArgv[i])) {
        i++;
      }
      continue;
    }
    out.push(execArgv[i]);
  }
  return out;
}

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1';
}

/**
 * @param {Object} settings - from loadSettings, plus optionally
 *   command(proc): [executable, args] to start a process (tests), healthyRunMs (tests), log
 */
function createLauncher(settings) {
  const log = settings.log || ((msg) => console.log(`[cluster] ${msg}`));
  const healthyRunMs = settings.healthyRunMs ?? HEALTHY_RUN_MS;
  const maxStartFailures = settings.maxStartFailures ?? MAX_START_FAILURES; // 0: never give up
  const maxOutstanding = settings.maxOutstanding ?? MAX_OUTSTANDING; // 0: no limit
  const queueMs = settings.queueMs ?? QUEUE_MS; // 0: refuse at once
  const ownerQueueMs = settings.ownerQueueMs ?? OWNER_QUEUE_MS;
  const cooldownMs = settings.cooldownMs ?? COOLDOWN_MS; // 0: none
  const upstreamTimeoutMs = settings.upstreamTimeoutMs ?? UPSTREAM_TIMEOUT_MS; // 0: none
  const writeTimeoutMs = settings.writeTimeoutMs ?? WRITE_TIMEOUT_MS; // 0: none
  const recycleMs = settings.recycleMs ?? RECYCLE_MS; // 0: never
  // (tests give their own)
  const memory = settings.memorySampler || memorySampler(settings.memory);
  const headroom = settings.headroomBytes ?? HEADROOM_GB * 2 ** 30;
  const fastLaneExtra = settings.fastLaneExtra ?? FAST_LANE_EXTRA; // 0: no fast lane
  const fastLaneMaxBytes = settings.fastLaneMaxBytes ?? FAST_LANE_MAX_BYTES;
  const normalMinSlots = Math.min(settings.normalMinSlots ?? NORMAL_MIN_SLOTS, maxOutstanding);
  // what each process does: every one has a role (library/role.js)
  const trimAllocator = (settings.memory && settings.memory.trimAllocator) ?? ROLE_TRIM_ALLOCATOR;
  const command = settings.command || ((proc) => [process.execPath, [
    ...new Set(['--expose-gc', ...childExecArgv(process.execArgv)]), path.join(__dirname, 'server.js'),
    `--role=${proc.role}`, `--instance-code=${proc.code}`, `--port=${proc.port}`]]);
  const procs = settings.procs.map(p => ({
    // outstanding: the tx requests it has (those that wait for a slot); active: every request
    ...p, child: null, ready: false, outstanding: 0, fastOutstanding: 0, active: 0, coolUntil: 0, timeouts: 0, failures: 0, startedAt: 0, readyAt: 0, everReady: false, exitedAt: 0, restartTimer: null,
    // for checkMemory: when each request in flight was sent, since when it has been over with
    // none at work, whether it is being restarted, its memory when it was ready
    sentAt: new Set(), overSince: 0, recycling: false, readyMemory: null,
    agent: new http.Agent({ keepAlive: true, maxSockets: 256, timeout: settings.upstreamIdleMs || UPSTREAM_IDLE_MS })
  }));
  const metrics = new ClusterMetrics(procs);
  // the workers' request counts, on their way to the master's statistics
  const pendingCounts = new PendingCounts();
  let countsInFlight = null;
  let server = null;
  let stopping = false;
  // why the launcher gave up starting (see maxStartFailures), or null
  let gaveUp = null;
  let onIdle = null;
  // tx requests waiting for a process with room, oldest first; the fast lane's apart
  const waiting = [];
  const fastWaiting = [];
  let queueRefused = 0;
  let lastQueueLog = 0;
  // requests the launcher has not finished answering, for the drain on stop
  let inFlight = 0;
  let writeTimeouts = 0;
  let lastWriteTimeoutLog = 0;
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
  // ready: it is listening by then. One lot at a time; a lot that can't be
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
      child.on('exit', (code, signal) => {
        proc.ready = false;
        proc.exitedAt = Date.now();
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
          proc.readyAt = 0;
          log(`${proc.name} exited (${signal || code}) to be recycled; restarting`);
          void startProcess(proc);
          return;
        }
        // counted from when it was ready: one that fails late in a long load is still failing
        const ran = proc.readyAt ? Date.now() - proc.readyAt : 0;
        proc.readyAt = 0;
        proc.failures = ran > healthyRunMs ? 1 : proc.failures + 1;
        if (proc.role === 'master' && !proc.everReady && maxStartFailures > 0 && proc.failures >= maxStartFailures) {
          // nothing would be served: exit, so the service manager sees the failure
          gaveUp = `the master exited ${proc.failures} time(s) (the last: ${signal || code}) and was never ready (server.cluster.maxStartFailures ${maxStartFailures})`;
          log(`ERROR ${gaveUp}: giving up`);
          return;
        }
        const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (proc.failures - 1));
        log(`${proc.name} exited (${signal || code}); restarting in ${delay / 1000} s`);
        proc.restartTimer = setTimeout(() => startProcess(proc), delay);
      });
      // ready: the process says so from its listen callback (server.js), on its own channel,
      // so an old process still shutting down on the same port can't answer for it
      child.on('message', message => {
        if (!message || message.type !== READY || proc.child !== child || proc.ready) {
          return;
        }
        proc.ready = true;
        proc.everReady = true;
        proc.readyAt = Date.now();
        sendWaiting();
        metrics.state(proc.code, 'ready');
        publishMetrics();
        if (proc.role === 'master') {
          void deliverCounts();
        }
        log(`${proc.name} (${proc.code}) ready on port ${proc.port}`);
        resolve(true);
      });
    });
  }

  // A process has maxOutstanding + fastLaneExtra slots. The fast lane may use them all, but
  // while others wait it leaves free what they need to have normalMinSlots running; the
  // others use up to maxOutstanding, or more to reach normalMinSlots
  const full = (p, fast) => {
    const slots = maxOutstanding + fastLaneExtra;
    const short = Math.max(0, normalMinSlots - (p.outstanding - p.fastOutstanding));
    if (maxOutstanding <= 0) {
      return false;
    }
    if (fast) {
      return p.outstanding >= slots - (waiting.length ? short : 0);
    }
    return p.outstanding >= maxOutstanding && !(short > 0 && p.outstanding < slots);
  };

  // true if the request was sent (or refused), false if it must wait. The master's own
  // paths and CORS preflights don't wait
  function send(w) {
    if (lostToRestart(w)) {
      return true;
    }
    const target = pickTarget(w.route, procs, p => !full(p, w.fast));
    if (!target) {
      fail(w.res, 503, 'No server process is ready to take this request; try again shortly');
      return true;
    }
    if (w.route.to !== 'master' && w.req.method !== 'OPTIONS' && full(target, w.fast)) {
      return false;
    }
    // only the tx requests, which wait for a slot, take one
    forward(w.req, w.res, target, w.fast, w.route.to !== 'master' && w.req.method !== 'OPTIONS');
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

  // Without the shared cache, a cache lives only in the process that issued it: while that
  // process is restarting, the cache is gone, so say so at once rather than have another
  // process answer that the id is someone else's (the restarted process says the same)
  function lostToRestart(w) {
    const owner = w.route.to === 'owner' && !(settings.routing && settings.routing.sharedCache) &&
      procs.find(p => p.code === w.route.code && p.servesTx);
    if (!owner || owner.ready || w.req.method === 'OPTIONS') {
      return false;
    }
    const id = String(w.req.headers['x-cache-id']);
    const messageId = 'CACHE_ID_LOST_TO_RESTART';
    const text = englishMessage(messageId, [id, formatDuration(Date.now() - (owner.exitedAt || Date.now()))]);
    w.res.writeHead(404, { 'Content-Type': 'application/fhir+json', ...(stopping ? { Connection: 'close' } : {}) });
    w.res.end(JSON.stringify({
      resourceType: 'OperationOutcome',
      issue: [{
        severity: 'error', code: 'not-found',
        details: { text, coding: [{ system: TX_ISSUE_TYPE, code: 'cache-id-unknown' }] },
        diagnostics: `instance '${owner.code}', which issued it, is restarting`,
        extension: [{ url: MESSAGE_ID_EXTENSION, valueString: messageId }]
      }]
    }));
    return true;
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

  // a client that took none of a response for writeTimeoutMs: its connection is closed
  function writeTimedOut(req) {
    writeTimeouts++;
    const now = Date.now();
    if (now - lastWriteTimeoutLog >= 60000) {
      lastWriteTimeoutLog = now;
      log(`a client took none of the response to ${req.method} ${req.url} for ${writeTimeoutMs / 1000} s (writeTimeoutSeconds): ` +
        `its connection was closed (${writeTimeouts} so far)`);
    }
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

  function forward(req, res, target, fast = false, counted = true) {
    inFlight++;
    target.active++;
    if (counted) {
      target.outstanding++;
      target.fastOutstanding += fast ? 1 : 0;
    }
    const sent = { at: Date.now() };
    target.sentAt.add(sent);
    let released = false;
    let finished = false;
    let timedOut = false;
    let timer = null;
    let stall = null;
    // the process is done with it: its response has ended (or failed), so its slot is free,
    // though the client may still be taking the response from the launcher
    const release = () => {
      clearTimeout(timer);
      if (!released) {
        released = true;
        target.active--;
        if (counted) {
          target.outstanding--;
          target.fastOutstanding -= fast ? 1 : 0;
        }
        target.sentAt.delete(sent);
        sendWaiting();
      }
    };
    // the launcher is done with it: the client has the whole response, or is gone
    const finish = () => {
      release();
      clearTimeout(stall);
      if (!finished) {
        finished = true;
        inFlight--;
        if (onIdle && inFlight === 0) {
          onIdle();
        }
      }
    };
    const headers = { ...req.headers };
    for (const h of HOP_BY_HOP) {
      delete headers[h];
    }
    // a chunked body goes on chunked. Without this, Node sends a GET, HEAD, DELETE or OPTIONS
    // body raw (no Content-Length, no chunking), and the process reads it as a second request
    // on the kept-alive connection, past the routing (Node's server accepts only chunked as
    // the last coding, so the body is chunked whatever the header listed)
    if (req.headers['transfer-encoding'] !== undefined) {
      headers['transfer-encoding'] = 'chunked';
    }
    const client = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    headers['x-forwarded-for'] = headers['x-forwarded-for'] ? `${headers['x-forwarded-for']}, ${client}` : client;
    if (!headers['x-forwarded-proto'] || !isLoopback(client)) {
      headers['x-forwarded-proto'] = 'http';
    }
    const upstream = http.request({
      host: target.host || '127.0.0.1', port: target.port, method: req.method, path: req.url, headers, agent: target.agent
    }, (ures) => {
      clearTimeout(timer);
      target.timeouts = 0;
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
      // A tx request's response is read to its end as fast as the process sends it, so its
      // slot is free once the process is done, however slowly the client reads (the process
      // held the whole response in memory already). Any other is passed on as the client takes
      // it (a package download can be large). Either way, a client that takes none of what is
      // waiting for it for writeTimeoutMs is cut off
      const stalled = () => {
        if (writeTimeoutMs > 0 && !stall) {
          stall = setTimeout(() => {
            writeTimedOut(req);
            upstream.destroy();
            res.destroy();
          }, writeTimeoutMs);
        }
      };
      res.on('drain', () => {
        clearTimeout(stall);
        stall = null;
        ures.resume();
      });
      ures.on('data', (chunk) => {
        if (!res.write(chunk)) {
          stalled();
          if (!counted) {
            ures.pause();
          }
        }
      });
      ures.on('end', () => {
        release();
        res.end();
      });
      ures.on('error', () => res.destroy());
    });
    upstream.on('error', (err) => {
      if (timedOut) {
        return;
      }
      if (!res.headersSent) {
        fail(res, 502, `The ${target.name} process did not answer (${err.code || err.message})`);
      } else {
        res.destroy();
      }
      finish();
    });
    res.on('close', () => {
      if (!res.writableFinished && !released) {
        upstream.destroy();
      }
      finish();
    });
    // until the response begins; a response already streaming is not timed
    if (upstreamTimeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        target.timeouts++;
        const suspect = target.timeouts >= SUSPECT_TIMEOUTS && cooldownMs > 0;
        log(`WARNING ${target.name} did not begin its response to ${req.method} ${req.url} in ${upstreamTimeoutMs / 1000} s: answered 504 and aborted ` +
          `(${target.timeouts} in a row${suspect ? `; no new requests for ${cooldownMs / 1000} s while another can take them` : ''})`);
        if (suspect) {
          target.coolUntil = Date.now() + cooldownMs;
          setTimeout(sendWaiting, cooldownMs).unref();
        }
        upstream.destroy();
        fail(res, 504, `The ${target.name} process did not begin its response in ${upstreamTimeoutMs / 1000} s (server.cluster.upstreamTimeoutSeconds); the request was abandoned`, false, 'timeout');
        finish();
      }, upstreamTimeoutMs);
    }
    req.pipe(upstream);
  }

  /**
   * Every RECYCLE_CHECK_MS: restart a tx-worker over the refusal threshold for recycleMs with no
   * request at work, the largest first, one at a time. Only one that has grown since it was
   * ready by more than the excess: a restart takes it back to its ready size, so restarting
   * one that was already too big would not reopen the gate. Never the master.
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
        if (excess === null && mine > memory.rejectAt) {
          log(`WARNING memory: ${p.name} uses ${GB(mine)} GB loaded and idle, ${memory.describe}: its memory guard refuses its requests, ` +
            'and restarting it would not help, so it is not recycled; use a larger limit');
        }
      }
      const atWork = [...p.sentAt].some(s => now - s.at >= AT_WORK_MS);
      const pExcess = excess === null ? mine - memory.rejectAt : excess;
      over.set(p, mine > 0 && pExcess > 0 && mine - p.readyMemory > pExcess ? mine : 0);
      if (!p.ready || !over.get(p) || atWork) {
        p.overSince = 0;
        continue;
      }
      p.overSince = p.overSince || now;
      // and none in flight at all now (a refusal is answered within milliseconds)
      if (now - p.overSince >= recycleMs && p.active === 0 && (!largest || over.get(p) > over.get(largest))) {
        largest = p;
      }
    }
    if (largest) {
      recycle(largest, `its memory (${(over.get(largest) / 2 ** 30).toFixed(1)} GB) has been ${memory.describe}` +
        (excess !== null ? ` (by ${(excess / 2 ** 30).toFixed(1)} GB)` : '') + ` for ${Math.round((now - largest.overSince) / 1000)} s with no request at work`);
    }
  }

  // no new requests; those it has finish; it stops as on shutdown, and exit starts it again
  function recycle(p, why) {
    log(`recycling ${p.name}: ${why}`);
    p.recycling = true;
    p.ready = false;
    p.exitedAt = 0;
    p.overSince = 0;
    metrics.state(p.code, 'restarting');
    publishMetrics();
    const child = p.child;
    const t0 = Date.now();
    const stopWhenIdle = () => {
      if (p.child !== child) {
        return;
      }
      if (p.active > 0 && Date.now() - t0 < settings.drainMs) {
        return void setTimeout(stopWhenIdle, 100);
      }
      const kill = setTimeout(() => child.kill('SIGKILL'), 30000);
      child.once('exit', () => clearTimeout(kill));
      child.kill('SIGTERM');
    };
    stopWhenIdle();
  }

  // close: the request body has not been read, and an overloaded server sheds the connection too.
  // The launcher's own refusals (503: busy, stopping, no process ready; 504: no response in
  // time) are tx-issue-type too-costly, as CLOSURE_TABLE_BUSY is: the code system has none for
  // a server that can't take the request now. A 502 (the process failed) has none that fits
  function fail(res, status, text, close = false, code = 'transient') {
    res.writeHead(status, { 'Content-Type': 'application/fhir+json', 'Retry-After': '5', ...(stopping || close ? { Connection: 'close' } : {}) });
    const details = status === 503 || status === 504 ? { text, coding: [{ system: TX_ISSUE_TYPE, code: 'too-costly' }] } : { text };
    res.end(JSON.stringify({
      resourceType: 'OperationOutcome',
      issue: [{ severity: 'error', code, details, diagnostics: text }]
    }));
  }

  async function start() {
    const master = procs.find(p => p.role === 'master');
    // the master first, and on its own: on a new data directory it builds the package
    // caches and creates the VSAC database, which processes starting together would corrupt.
    // (If it exits before it is ready, it is started again, as any process is.)
    log(`starting the master (${master.code}) on port ${master.port}` + (maxStartFailures > 0
      ? `; if it exits ${maxStartFailures} times without being ready, the launcher exits (maxStartFailures)` : ''));
    void startProcess(master);
    await new Promise((resolve, reject) => {
      const t = setInterval(() => {
        if (master.ready || stopping) {
          clearInterval(t);
          resolve();
        } else if (gaveUp) {
          clearInterval(t);
          reject(new Error(gaveUp));
        }
      }, WAIT_POLL_MS);
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
    log(`limits: maxOutstanding ${maxOutstanding}, queueSeconds ${queueMs / 1000}, ownerQueueSeconds ${ownerQueueMs / 1000}, cooldownSeconds ${cooldownMs / 1000}, upstreamTimeoutSeconds ${upstreamTimeoutMs / 1000}, writeTimeoutSeconds ${writeTimeoutMs / 1000}, ` +
      `fastLaneExtra ${fastLaneExtra}, fastLaneMaxBytes ${fastLaneMaxBytes}, normalMinSlots ${normalMinSlots}, memoryHeadroomGB ${headroom / 2 ** 30}, drainSeconds ${settings.drainMs / 1000}, ` +
      `trimAllocator ${trimAllocator}, recycleSeconds ${recycleMs / 1000}` + (recycleMs > 0 ? ` (a tx-worker ${memory.describe} that long, with no request at work, is restarted)` : ' (never)'));
    if (recycleMs > 0) {
      memoryTimer = setInterval(checkMemory, settings.recycleCheckMs || RECYCLE_CHECK_MS);
      memoryTimer.unref();
    }
    // one after another, so their loads (and memory peaks) don't coincide; in the background
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


  /**
   * Once the master is loaded, take its memory as each worker's. Workers not given: start only
   * as many as fit under the refusal threshold with `headroom` to spare (at least one); given:
   * warn if they don't fit.
   */
  function sizeWorkers(master) {
    const workers = procs.filter(p => p.role === 'tx-worker');
    const decided = (fitText) => {
      if (settings.workerDecision) {
        log(describeDecision(settings.workerDecision, procs.length - 1, fitText, !settings.workersDefault));
      }
    };
    const perProcess = memory.sample([master]).own.get(master) || 0;
    if (!perProcess) {
      decided('memory not measured');
      return; // not measurable here (not Linux)
    }
    const fits = Math.floor((memory.rejectAt - headroom - perProcess) / perProcess);
    const fit = Math.max(1, fits);
    const idle = (1 + workers.length) * perProcess;
    const line = `the master uses ${GB(perProcess)} GB loaded, so ${workers.length + 1} processes would use about ${GB(idle)} GB idle; ` +
      `the memory guard refuses requests ${memory.describe}, and memoryHeadroomGB is ${GB(headroom)}`;
    if (idle + headroom <= memory.rejectAt) {
      decided(`memory fits ${fits}`);
      log(`memory: ${line}`);
      return;
    }
    if (settings.workersDefault) {
      for (const p of workers.slice(fit)) {
        procs.splice(procs.indexOf(p), 1);
        metrics.series.delete(p.code);
      }
    }
    const starting = procs.length - 1;
    decided(`memory fits ${Math.max(0, fits)}`);
    if (fits < 1) {
      log(`WARNING memory: ${line}: even 1 worker leaves too little room; starting ${starting}: raise the limit, or run a single server`);
    } else if (starting < workers.length) {
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
      if (inFlight > 0) {
        log(`draining: ${inFlight} request(s) in progress`);
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

module.exports = { loadSettings, classify, isFastLane, pickTarget, createLauncher, memorySampler, childExecArgv };
