/**
 * A tx-worker (cluster.md) only reads the package caches the master builds. Until the master
 * has finished one - normally it has, since the workers start once it is ready - the worker
 * waits for it, and gives up with a clear error rather than building it itself.
 *
 * @module tx/library/wait-for-cache
 */

// how long a worker waits for the master to finish a cache, and how often it looks
const DEFAULT_WAIT_MS = 5 * 60 * 1000;
const POLL_MS = 500;

/**
 * Resolve once isReady() says true; reject if it hasn't within waitMs.
 *
 * @param {function(): Promise<boolean>} isReady
 * @param {string} what - the cache, for the messages
 * @param {Object} [options]
 * @param {number} [options.waitMs] - default DEFAULT_WAIT_MS, or FHIRSMITH_CACHE_WAIT_MS
 * @returns {Promise<void>}
 */
async function waitForCache(isReady, what, options = {}) {
  const waitMs = options.waitMs ?? (Number(process.env.FHIRSMITH_CACHE_WAIT_MS) || DEFAULT_WAIT_MS);
  const start = Date.now();
  let logged = false;
  for (;;) {
    if (await isReady()) {
      return;
    }
    if (Date.now() - start >= waitMs) {
      throw new Error(`${what} is not ready after ${Math.round(waitMs / 1000)} s. A tx-worker only reads it; ` +
        'the master builds it: start the master first, and the workers once it answers /health (cluster.md)');
    }
    if (!logged) {
      logged = true;
      require('../../library/logger').getInstance().child({ module: 'tx' })
        .warn(`${what} is missing, incomplete or not yet migrated: waiting for the master to finish it`);
    }
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}

module.exports = { waitForCache };
