//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * Async requests: the FHIR asynchronous interaction request pattern.
 *
 *   kickoff   a request with Prefer: respond-async (or _async=true, as the Pascal server
 *             took) is checked (access, and that it can be done this way), queued in
 *             AsyncJobs with its request in JobFiles, and answered 202 with Content-Location:
 *             [base]/_async/{uuid}
 *   status    GET that: 202 (X-Progress, Retry-After) while it is queued or running; when it
 *             is done, 200 with a batch-response Bundle whose entry[0] is the request's own
 *             response (so a 200 can carry a 4xx outcome); 500 if it failed; 404 for a job
 *             that is unknown, someone else's, cancelled, or expired
 *   cancel    DELETE it: 202. A queued job is dropped; a running transaction or batch stops
 *             at its next entry (a transaction rolls back); anything else runs to its end, and
 *             its result is thrown away
 *
 * Only searches, history, batches, transactions and operations are taken (as the Pascal
 * server did); anything else with respond-async is refused (400). The queue runner
 * (queue/runner.js) runs the jobs, one at a time per runner, as the user who asked: they are
 * looked up again, and their access checked again, when the job starts. A runner keeps a
 * heartbeat on the job it is running; a job whose runner has stopped (its heartbeat older
 * than STALE_MS) is marked failed rather than run again: it may have written something
 * already. Results are kept asyncKeepHours (24), then removed with the job.
 *
 * The result is written in the format the kickoff asked for (its Accept or _format, and
 * _pretty).
 *
 * @module rest/queue/async
 */

const crypto = require('crypto');
const os = require('os');
const fhirJson = require('../../library/fhir-json');
const { FhirError, badRequest, notFound, operationOutcome } = require('../library/errors');
const { DatabaseJobFiles } = require('./files');
const format = require('../format');
const access = require('../access');
const { responseEntry, errorEntry } = require('../interactions/bundle');

const PATH = '_async';
// the interactions that can be done asynchronously (the Pascal server's list)
const ALLOWED = new Set(['search-type', 'search-system', 'history-instance', 'history-type', 'history-system', 'bundle', 'operation']);
// the request headers the job keeps (not cookies, nor the credentials: the job runs as its user)
const KEEP_HEADERS = ['accept', 'accept-language', 'prefer', 'content-type', 'if-match', 'if-none-match', 'if-none-exist', 'if-modified-since', 'x-provenance'];
const HEARTBEAT_MS = 5000;
// a running job whose runner's heartbeat is this old: its runner has stopped
const STALE_MS = 60 * 1000;
// what a client is told to wait between polls
const RETRY_AFTER = '2';
const RESPOND_ASYNC = /(^|[\s,;])respond-async(?=$|[\s,;])/i;

/** Whether the request asks to be done asynchronously */
function wanted(req, freq) {
  if (RESPOND_ASYNC.test(String(req.get('Prefer') || ''))) {
    return true;
  }
  return Array.isArray(freq.params) && freq.params.some(([n, v]) => n === '_async' && v === 'true');
}

/** The Prefer header, without respond-async */
function withoutRespondAsync(prefer) {
  const rest = String(prefer || '').split(',').map(s => s.trim()).filter(s => s && !/^respond-async$/i.test(s));
  return rest.length ? rest.join(', ') : undefined;
}

/** A cancelled job's transaction or batch stops with this */
class Cancelled extends FhirError {
  constructor() {
    super(409, 'processing', 'The request was cancelled');
    this.cancelled = true;
  }
}

class AsyncJobs {
  /**
   * @param {Object} ep - the Endpoint
   */
  constructor(ep) {
    this.ep = ep;
    this.files = new DatabaseJobFiles(ep.db);
    this.runnerId = `${os.hostname()}:${process.pid}:${Date.now()}`;
    // the job this process is running: { key, cancel }
    this.current = null;
  }

  wanted(req, freq) {
    return !!this.ep.settings.asyncRequests && wanted(req, freq);
  }

  /** Who a job belongs to: the user's id, or null for anyone (anonymous) */
  static userKey(principal) {
    return principal && principal.id !== undefined && principal.id !== null ? String(principal.id) : null;
  }

  /**
   * Queue the request.
   * @param {Object} req
   * @param {Object} freq - from request.js, its access already checked
   * @returns {Promise<{status: number, headers: Object, outcome: Object}>}
   */
  async kickoff(req, freq) {
    const ep = this.ep;
    if (!ALLOWED.has(freq.interaction)) {
      throw badRequest(`This request (${freq.interaction}) can't be done asynchronously: only searches, history, batches, transactions and operations can`);
    }
    if (Array.isArray(freq.params) && freq.params.some(([n]) => n === '_outputFormat')) {
      throw new FhirError(501, 'not-supported', 'Bulk data requests (_outputFormat) are not supported yet');
    }
    const userKey = AsyncJobs.userKey(freq.principal);
    const max = Number(ep.settings.asyncMaxPerUser);
    if (max > 0) {
      const n = await ep.db.read(q => q.get(`SELECT COUNT(*) AS N FROM AsyncJobs WHERE State IN ('queued', 'running') AND ${userKey === null ? 'UserKey IS NULL' : 'UserKey = ?'}`,
        userKey === null ? [] : [userKey]));
      if (Number(n.N) >= max) {
        throw new FhirError(429, 'throttled', `You have ${n.N} async requests queued or running on this endpoint, the most allowed (asyncMaxPerUser): wait for one to finish`,
          { headers: { 'Retry-After': '30' } });
      }
    }
    const fmt = format.responseFormat(req, ep.xmlModel());
    const headers = {};
    for (const h of KEEP_HEADERS) {
      if (freq.headers[h] !== undefined) {
        headers[h] = freq.headers[h];
      }
    }
    const prefer = withoutRespondAsync(headers.prefer);
    if (prefer) {
      headers.prefer = prefer;
    } else {
      delete headers.prefer;
    }
    const { principal, ...rest } = freq;
    const stored = {
      freq: { ...rest, headers, params: (freq.params || []).filter(([n]) => n !== '_async') },
      format: fmt, pretty: req.query && req.query._pretty === 'true'
    };
    const id = crypto.randomUUID();
    const now = Date.now();
    const label = principal ? String(principal.login || principal.name || principal.id) : null;
    const key = await ep.db.write(async (q) => {
      const r = await q.run('INSERT INTO AsyncJobs (Id, State, Interaction, Url, UserKey, UserLabel, Created, Expires, Cancel) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)',
        [id, 'queued', freq.interaction, String(freq.url || '').substring(0, 4000), userKey, label, now, now + keepMs(ep)]);
      return Number(r.lastId);
    });
    await this.files.put(key, 'request', fhirJson.stringify(stored));
    ep.log.info(`Rest ${ep.path}: async ${freq.interaction} queued as ${id}${label ? ` for ${label}` : ''}`);
    return {
      status: 202,
      headers: { 'Content-Location': `${freq.base}/${PATH}/${id}` },
      outcome: { severity: 'information', code: 'informational', diagnostics: `The request is queued: its result will be at ${freq.base}/${PATH}/${id}` }
    };
  }

  /** The job, if it is the principal's (else null) */
  async find(id, principal) {
    if (!/^[0-9a-f-]{36}$/i.test(String(id))) {
      return null;
    }
    const row = await this.ep.db.read(q => q.get('SELECT * FROM AsyncJobs WHERE Id = ?', [String(id).toLowerCase()]));
    if (!row) {
      return null;
    }
    const owner = row.UserKey === null || row.UserKey === undefined ? null : String(row.UserKey);
    if (owner !== null && owner !== AsyncJobs.userKey(principal)) {
      return null;
    }
    return row;
  }

  /**
   * GET [base]/_async/{id}
   * @returns {Promise<{status: number, headers: Object, body?: Buffer|string, contentType?: string, outcome?: Object}>}
   */
  async status(id, principal) {
    const row = await this.find(id, principal);
    if (!row || row.State === 'cancelled' || Number(row.Expires) < Date.now()) {
      throw notFound(`There is no async request ${id} (or it has expired, or been cancelled)`);
    }
    if (row.State === 'queued' || row.State === 'running') {
      let progress = row.State === 'running' ? (row.Progress || 'running') : 'queued';
      if (row.State === 'queued') {
        const ahead = await this.ep.db.read(q => q.get("SELECT COUNT(*) AS N FROM AsyncJobs WHERE State = 'queued' AND JobKey < ?", [row.JobKey]));
        if (Number(ahead.N)) {
          progress = `queued (${ahead.N} ahead)`;
        }
      }
      return { status: 202, headers: { 'X-Progress': progress, 'Retry-After': RETRY_AFTER } };
    }
    if (row.State === 'failed') {
      throw new FhirError(500, 'exception', `The async request failed: ${row.Message || 'unknown error'}`);
    }
    const body = await this.files.get(Number(row.JobKey), 'result');
    if (!body) {
      throw notFound(`The result of the async request ${id} is no longer available`);
    }
    return { status: 200, headers: { Expires: new Date(Number(row.Expires)).toUTCString() }, body, contentType: row.ContentType || format.FHIR_JSON };
  }

  /** DELETE [base]/_async/{id} */
  async cancel(id, principal) {
    const row = await this.find(id, principal);
    if (!row || row.State === 'cancelled') {
      throw notFound(`There is no async request ${id} (or it has expired, or been cancelled)`);
    }
    const key = Number(row.JobKey);
    if (row.State === 'running') {
      // the runner sees it on its next heartbeat, and stops where it can
      await this.ep.db.write(q => q.run('UPDATE AsyncJobs SET Cancel = 1 WHERE JobKey = ?', [key]));
      if (this.current && this.current.key === key) {
        this.current.cancel = true;
      }
    } else {
      await this.ep.db.write(q => q.run("UPDATE AsyncJobs SET State = 'cancelled', Cancel = 1, Finished = ? WHERE JobKey = ? AND State <> 'running'", [Date.now(), key]));
      await this.files.remove(key);
    }
    return { status: 202, headers: {}, outcome: { severity: 'information', code: 'informational', diagnostics: `The async request ${id} is cancelled` } };
  }

  // ---- the queue runner's tasks ----

  /**
   * Run the next queued job, if this runner isn't running one.
   * @returns {Promise<boolean>} whether one was run
   */
  async runNext() {
    if (this.current) {
      return false;
    }
    const ep = this.ep;
    const row = await ep.db.read(q => q.get("SELECT JobKey, Id, UserKey FROM AsyncJobs WHERE State = 'queued' ORDER BY JobKey LIMIT 1"));
    if (!row) {
      return false;
    }
    const key = Number(row.JobKey);
    const now = Date.now();
    const claimed = await ep.db.write(q => q.run("UPDATE AsyncJobs SET State = 'running', Runner = ?, Started = ?, Heartbeat = ?, Progress = 'running' WHERE JobKey = ? AND State = 'queued'",
      [this.runnerId, now, now, key]));
    if (!claimed.changes) {
      // another runner took it
      return false;
    }
    const job = { key, id: row.Id, user: row.UserKey === null || row.UserKey === undefined ? null : String(row.UserKey), cancel: false, started: now };
    this.current = job;
    const beat = setInterval(() => {
      this.heartbeat(job).catch(() => {});
    }, HEARTBEAT_MS);
    beat.unref();
    try {
      await this.execute(job);
    } catch (e) {
      ep.log.warn(`Rest ${ep.path}: async request ${job.id} failed: ${e.message}`);
      await ep.db.write(q => q.run("UPDATE AsyncJobs SET State = 'failed', Finished = ?, Message = ? WHERE JobKey = ?",
        [Date.now(), String(e.message).substring(0, 2000), key]));
      await this.files.remove(key);
    } finally {
      clearInterval(beat);
      this.current = null;
    }
    return true;
  }

  /** The runner is alive; and has the job been cancelled? */
  async heartbeat(job) {
    await this.ep.db.write(q => q.run('UPDATE AsyncJobs SET Heartbeat = ? WHERE JobKey = ?', [Date.now(), job.key]));
    const r = await this.ep.db.read(q => q.get('SELECT Cancel FROM AsyncJobs WHERE JobKey = ?', [job.key]));
    if (r && Number(r.Cancel)) {
      job.cancel = true;
    }
  }

  async execute(job) {
    const ep = this.ep;
    const text = await this.files.get(job.key, 'request');
    if (!text) {
      throw new Error('its request is missing');
    }
    const stored = fhirJson.parse(text.toString('utf8'));
    // (whose it is: the job's row says)
    let principal = null;
    if (job.user !== null) {
      principal = ep.options.principalById ? await ep.options.principalById(job.user) : null;
      if (!principal) {
        throw new Error('the user who asked for it is no longer known, or is disabled');
      }
    }
    const freq = stored.freq;
    freq.principal = principal;
    freq.cancelled = () => job.cancel;
    let entry;
    let status;
    try {
      const acc = access.check(principal, ep, ep.accessInteraction(freq));
      const result = await ep.dispatch(freq, { access: acc });
      if (ep.auditing('all') && !result.write && freq.interaction !== 'bundle') {
        ep.auditLater(freq, freq.interaction === 'operation' ? 'operation' : freq.interaction, result.status);
      }
      entry = responseEntry(ep, freq, result.shape && result.resource ? { ...result, resource: ep.shapeResource(result.resource, freq) } : result);
      if (!result.write && !result.resource && result.outcome) {
        entry.response.outcome = operationOutcome([result.outcome]);
      }
      status = result.status;
    } catch (e) {
      if (!(e instanceof FhirError) || (e.cancelled && job.cancel)) {
        if (job.cancel) {
          return this.finishCancelled(job);
        }
        throw e;
      }
      entry = errorEntry(e);
      status = e.status;
      if (ep.settings.audit !== 'off' && e.status !== 401) {
        ep.auditLater(freq, freq.interaction === 'bundle' ? 'transaction' : freq.interaction, e.status, e.message);
      }
    }
    if (job.cancel) {
      return this.finishCancelled(job);
    }
    const bundle = { resourceType: 'Bundle', type: 'batch-response', entry: [entry] };
    const fakeReq = { query: { _pretty: stored.pretty ? 'true' : '' } };
    let out;
    try {
      out = format.serialise(fakeReq, bundle, stored.format, ep.xmlModel());
    } catch (e) {
      out = format.serialise(fakeReq, bundle, 'json');
    }
    await this.files.put(job.key, 'result', out.text);
    const now = Date.now();
    await ep.db.write(q => q.run("UPDATE AsyncJobs SET State = 'done', Finished = ?, Expires = ?, Status = ?, ContentType = ?, Progress = NULL WHERE JobKey = ?",
      [now, now + keepMs(ep), status, out.contentType, job.key]));
    await ep.db.write(q => q.run("DELETE FROM JobFiles WHERE JobKey = ? AND Name = 'request'", [job.key]));
    ep.log.info(`Rest ${ep.path}: async request ${job.id} done (${status}, ${now - (job.started || now)} ms)`);
  }

  async finishCancelled(job) {
    await this.ep.db.write(q => q.run("UPDATE AsyncJobs SET State = 'cancelled', Finished = ? WHERE JobKey = ?", [Date.now(), job.key]));
    await this.files.remove(job.key);
    this.ep.log.info(`Rest ${this.ep.path}: async request ${job.id} cancelled`);
  }

  /**
   * Jobs whose runner stopped are failed; expired jobs are removed, with their files.
   * @returns {Promise<{failed: number, removed: number}>}
   */
  async tidy() {
    const ep = this.ep;
    const now = Date.now();
    const stale = await ep.db.write(q => q.run("UPDATE AsyncJobs SET State = 'failed', Finished = ?, Message = ? WHERE State = 'running' AND Runner <> ? AND Heartbeat < ?",
      [now, 'The process running it stopped before it finished (it is not run again: it may have done some of its work)', this.runnerId, now - STALE_MS]));
    const expired = await ep.db.read(q => q.all('SELECT JobKey FROM AsyncJobs WHERE Expires < ? AND State <> ?', [now, 'running']));
    for (const r of expired) {
      await this.files.remove(Number(r.JobKey));
      await ep.db.write(q => q.run('DELETE FROM AsyncJobs WHERE JobKey = ?', [r.JobKey]));
    }
    return { failed: Number(stale.changes || 0), removed: expired.length };
  }
}

function keepMs(ep) {
  const h = Number(ep.settings.asyncKeepHours);
  return (Number.isFinite(h) && h > 0 ? h : 24) * 60 * 60 * 1000;
}

module.exports = { AsyncJobs, Cancelled, PATH, ALLOWED, wanted, withoutRespondAsync, STALE_MS, HEARTBEAT_MS };
