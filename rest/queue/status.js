//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * What the queue runner's queues look like, for the status page: how much is waiting, how
 * long the oldest has waited so far, and, of the work started in the last WINDOW_MS, how long
 * it waited to be started after it was queued (the most useful figure: whether the runner
 * keeps up) and how long it took. Measured by the queue runner (a task of its own) and kept,
 * so the status page reads it without going to the database.
 *
 * @module rest/queue/status
 */

const WINDOW_MS = 60 * 60 * 1000;
const FAILED_WINDOW_MS = 24 * 60 * 60 * 1000;
// the most recent jobs looked at, at most
const SAMPLE = 5000;

/**
 * Summary figures of some durations (ms): {count, avg, p95, max}, or null for none
 * @param {number[]} list
 */
function summarise(list) {
  const v = list.filter(x => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  if (!v.length) {
    return null;
  }
  const at = (p) => v[Math.min(v.length - 1, Math.ceil(p * v.length) - 1)];
  return { count: v.length, avg: Math.round(v.reduce((a, b) => a + b, 0) / v.length), p95: at(0.95), max: v[v.length - 1] };
}

/**
 * The endpoint's queues now.
 * @param {Object} ep - the Endpoint
 * @param {number} [now]
 * @returns {Promise<Object>} { measuredAt, windowMs, async, packages, reindex }
 */
async function measure(ep, now = Date.now()) {
  return ep.db.read(async (q) => {
    const counts = async (sql, params = []) => Number((await q.get(sql, params)).N);
    // async requests
    const queued = await counts("SELECT COUNT(*) AS N FROM AsyncJobs WHERE State = 'queued'");
    const running = await counts("SELECT COUNT(*) AS N FROM AsyncJobs WHERE State = 'running'");
    const oldest = await q.get("SELECT MIN(Created) AS T FROM AsyncJobs WHERE State = 'queued'");
    const started = await q.all(`SELECT Created, Started, Finished, State FROM AsyncJobs WHERE Started >= ? ORDER BY Started DESC LIMIT ${SAMPLE}`, [now - WINDOW_MS]);
    const failed = await counts("SELECT COUNT(*) AS N FROM AsyncJobs WHERE State = 'failed' AND Finished >= ?", [now - FAILED_WINDOW_MS]);
    const asyncFigures = {
      queued, running, failed,
      oldestWaitingMs: oldest && oldest.T !== null && oldest.T !== undefined ? now - Number(oldest.T) : null,
      waited: summarise(started.map(r => Number(r.Started) - Number(r.Created))),
      took: summarise(started.filter(r => r.Finished !== null && r.Finished !== undefined).map(r => Number(r.Finished) - Number(r.Started)))
    };
    // package loads (status 0 queued, 1 loading)
    const pq = await counts('SELECT COUNT(*) AS N FROM PackageLoads WHERE Status = 0');
    const pr = await counts('SELECT COUNT(*) AS N FROM PackageLoads WHERE Status = 1');
    const pOldest = await q.get('SELECT MIN(Requested) AS T FROM PackageLoads WHERE Status = 0');
    const last = await q.get('SELECT Requested, Started, Finished FROM PackageLoads WHERE Started IS NOT NULL ORDER BY Started DESC LIMIT 1');
    const packages = {
      queued: pq, running: pr,
      oldestWaitingMs: pOldest && pOldest.T !== null && pOldest.T !== undefined ? now - Number(pOldest.T) : null,
      lastWaitedMs: last ? Number(last.Started) - Number(last.Requested) : null,
      lastTookMs: last && last.Finished !== null && last.Finished !== undefined ? Number(last.Finished) - Number(last.Started) : null
    };
    // reindexing: where it has got to, by resource key
    let reindex = { active: false };
    if ((ep.definitions && ep.definitions.reindexing && ep.definitions.reindexing.size) || ep.reindexAll) {
      const from = await q.get("SELECT Value FROM Config WHERE Name = 'reindexFrom'");
      const top = await q.get('SELECT MAX(ResourceKey) AS K FROM Ids');
      const at = from ? Number(from.Value) : 0;
      const end = top && top.K !== null ? Number(top.K) : 0;
      reindex = { active: true, all: !!ep.reindexAll, parameters: ep.definitions.reindexing ? ep.definitions.reindexing.size : 0,
        done: end > 0 ? Math.min(1, at / end) : 0 };
    }
    return { measuredAt: now, windowMs: WINDOW_MS, async: asyncFigures, packages, reindex };
  });
}

module.exports = { measure, summarise, WINDOW_MS, FAILED_WINDOW_MS };
