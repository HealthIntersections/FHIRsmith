#!/usr/bin/env node
//
// FHIRsmith in cluster mode: several server processes on one port.
//
//   node cluster.js                    (npm run start:cluster)
//
// The number of processes comes from config.json "server": {"cluster": {"workers": N}}
// or the FHIRSMITH_WORKERS environment variable (which wins); default 2. Each worker
// is a complete server (server.js) with its own memory, library and expansion cache;
// Node's cluster module accepts connections on the port and hands them to the
// workers in turn, so any worker may receive any request.
//
// What has to be shared is shared on disk:
//  - the tx client resource cache ($cache-control): modules.tx.resourceCache.store
//    must be "sqlite" - with the memory store, a request that reaches a different
//    worker from the one that started its cache would fail with cache-id-unknown.
//    cluster.js refuses to start a configuration like that, or one with any other
//    part that only works in one process (see singleProcessOnly).
//  - background jobs (VSAC refresh, package crawler, XIG download, ...) run in one
//    worker at a time, chosen by a lock file - see library/background-jobs.js.
// Statistics and the dashboard stay per worker.
//
// Workers start one after another: each waits until the previous one is listening.
// The first start of a server on a data directory builds index databases next to
// the npm packages, and processes building them at the same time corrupt them. A
// worker that stops is started again (one at a time, backing off if it keeps
// failing to start).
//

const cluster = require('cluster');
const fs = require('fs');
const path = require('path');

const DEFAULT_WORKERS = 2;
const SHUTDOWN_GRACE_MS = 30 * 1000;
const MAX_BACKOFF_MS = 60 * 1000;

if (cluster.isPrimary) {
  runPrimary();
} else {
  require(path.join(__dirname, 'server.js'));
}

function log(msg) {
  console.log(`${new Date().toISOString()} [cluster ${process.pid}] ${msg}`);
}

function readConfig() {
  const folders = require('./library/folder-setup');
  const file = folders.filePath('config.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`cluster: failed to load configuration from ${file}: ${e.message}`);
    process.exit(1);
  }
}

/**
 * How many workers, and whether the configuration is safe to run that way.
 * @returns {number}
 */
function settings(config) {
  const fromEnv = process.env.FHIRSMITH_WORKERS;
  const configured = fromEnv !== undefined && fromEnv !== ''
    ? Number(fromEnv)
    : (config.server && config.server.cluster && config.server.cluster.workers) || DEFAULT_WORKERS;
  if (!Number.isInteger(configured) || configured < 1) {
    console.error(`cluster: the number of workers must be a whole number of at least 1 (got '${fromEnv ?? configured}')`);
    process.exit(1);
  }
  if (configured > 1) {
    const problems = singleProcessOnly(config);
    if (problems.length > 0) {
      console.error(`cluster: this configuration can't run in more than one worker:\n  - ${problems.join('\n  - ')}\n` +
        'Run those parts in a separate single-process server, or use one worker. See cluster.md.');
      process.exit(1);
    }
  }
  return configured;
}

/**
 * The parts of a configuration that only work in one process: each keeps state in
 * memory that a request reaching a different worker would not find.
 * @returns {string[]} what is wrong, one line each (empty: fine)
 */
function singleProcessOnly(config) {
  const problems = [];
  const mods = config.modules || {};
  const tx = mods.tx;
  if (tx && tx.enabled) {
    const store = tx.resourceCache && tx.resourceCache.store;
    if (store !== 'sqlite') {
      problems.push('modules.tx.resourceCache.store must be "sqlite": with the memory store each worker has its ' +
        'own client caches, so a request that reaches a different worker from the one that started its cache ' +
        'fails with cache-id-unknown');
    }
    if (tx.closure && tx.closure.enabled) {
      problems.push('modules.tx.closure: $closure keeps a per-table lock in memory around each read-compute-write, ' +
        'so two workers could interleave updates to the same closure table');
    }
  }
  for (const name of ['publisher', 'ips', 'testing']) {
    if (mods[name] && mods[name].enabled) {
      problems.push(`modules.${name}: logins are kept in each process's memory, so a user logged in on one worker ` +
        'is logged out on the next request that reaches another');
    }
  }
  return problems;
}

function runPrimary() {
  const config = readConfig();
  const n = settings(config);
  log(`starting ${n} worker${n === 1 ? '' : 's'}, one at a time`);

  const slots = new Map(); // worker.id -> slot number (1..n)
  const queue = [];        // slots waiting to start
  const failures = new Map(); // slot -> consecutive failed starts
  let starting = null;     // the slot whose worker is starting
  let stopping = false;

  const startNext = () => {
    if (stopping || starting !== null || queue.length === 0) {
      return;
    }
    const slot = queue.shift();
    starting = slot;
    const worker = cluster.fork({ FHIRSMITH_CLUSTER_WORKER: String(slot), FHIRSMITH_CLUSTER_SIZE: String(n) });
    slots.set(worker.id, slot);
    worker.startedAt = Date.now();
    log(`worker ${slot} (pid ${worker.process.pid}) starting`);
  };

  cluster.on('listening', (worker) => {
    const slot = slots.get(worker.id);
    worker.listening = true;
    failures.delete(slot);
    log(`worker ${slot} (pid ${worker.process.pid}) listening after ${Math.round((Date.now() - worker.startedAt) / 1000)} s`);
    if (starting === slot) {
      starting = null;
    }
    startNext();
  });

  cluster.on('exit', (worker, code, signal) => {
    const slot = slots.get(worker.id);
    slots.delete(worker.id);
    if (stopping) {
      return;
    }
    const how = signal ? `signal ${signal}` : `code ${code}`;
    if (starting === slot) {
      starting = null;
    }
    let delay = 1000;
    if (!worker.listening) {
      // failed to start: back off, so a broken configuration doesn't spin
      const f = (failures.get(slot) || 0) + 1;
      failures.set(slot, f);
      delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (f - 1));
      log(`worker ${slot} (pid ${worker.process.pid}) exited (${how}) before it was listening; starting it again in ${Math.round(delay / 1000)} s`);
    } else {
      log(`worker ${slot} (pid ${worker.process.pid}) exited (${how}); starting it again`);
    }
    setTimeout(() => {
      queue.push(slot);
      startNext();
    }, delay);
    startNext();
  });

  const shutdown = (sig) => {
    if (stopping) {
      return;
    }
    stopping = true;
    log(`${sig}: stopping the workers`);
    const workers = Object.values(cluster.workers || {});
    for (const w of workers) {
      try {
        w.process.kill('SIGTERM');
      } catch (e) {
        // already gone
      }
    }
    const done = () => Object.keys(cluster.workers || {}).length === 0;
    const timer = setTimeout(() => {
      for (const w of Object.values(cluster.workers || {})) {
        log(`worker pid ${w.process.pid} did not stop within ${SHUTDOWN_GRACE_MS / 1000} s; killing it`);
        try {
          w.process.kill('SIGKILL');
        } catch (e) {
          // already gone
        }
      }
      process.exit(0);
    }, SHUTDOWN_GRACE_MS);
    timer.unref();
    const check = () => {
      if (done()) {
        log('all workers stopped');
        process.exit(0);
      }
    };
    cluster.on('exit', check);
    check();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  for (let slot = 1; slot <= n; slot++) {
    queue.push(slot);
  }
  startNext();
}
