/**
 * The caches page across the cluster (tx/tx-caches.js, /{path}/caches).
 *
 * Under the launcher (cluster.js), the process a /caches request reaches asks the launcher
 * (ASK); the launcher passes the request to every process that is ready (RUN), each one
 * reports its caches or empties them (local), and answers (DONE); the launcher gathers the
 * answers, and hands them all to the process that asked (ALL). The page then shows every
 * process, and an action empties the caches of every process - server wide, whichever process
 * nginx or the launcher happened to send the request to.
 *
 * A process that doesn't answer within timeoutMs (busy, or restarting) is reported as not
 * answering. Without the launcher (no role, or processes started by hand behind nginx) there
 * is no IPC channel, and the page shows only the process that answered.
 *
 * The password is checked by the process the request reached, before it asks: the launcher
 * and the other processes trust their own IPC channel.
 */
const crypto = require('crypto');

const ASK = 'fhirsmith:caches-ask'; // the process with the request, to the launcher
const RUN = 'fhirsmith:caches-run'; // the launcher, to each process
const DONE = 'fhirsmith:caches-done'; // each process, to the launcher
const ALL = 'fhirsmith:caches-all'; // the launcher, to the process that asked
// how long to wait for the processes: emptying the caches is followed by a full GC, which
// takes a few seconds on a big heap
const DEFAULT_TIMEOUT_MS = 30000;
// list: the entries of one cache (arg: its id)
const ACTIONS = ['report', 'unload', 'unload-all', 'list'];
const okArg = (arg) => arg === undefined || arg === null || (typeof arg === 'string' && arg.length <= 64);

/**
 * A process's side.
 * @param {Function} local - async (action, arg) => this process's result (a plain object)
 * @param {Object} [channel] - process, or a stand-in (tests); none (no send): this process only
 * @param {Object} [options]
 * @param {boolean} [options.cluster] - whether the launcher is there to ask (a role, with IPC)
 * @param {number} [options.timeoutMs] - the launcher's wait for the processes
 * @param {number} [options.marginMs] - how much longer this process waits for the launcher
 * @returns {{ask: Function, disconnect: Function}} ask(action, arg) => Promise<{cluster, results}>,
 *   results [{code, name, role, result} or {code, name, role, error}]
 */
function connectCaches(local, channel = process, { cluster = false, timeoutMs = DEFAULT_TIMEOUT_MS, marginMs = 5000 } = {}) {
  const usable = cluster && channel && typeof channel.send === 'function';
  const pending = new Map(); // id -> {resolve, timer}

  const alone = async (action, arg, note = null) => {
    const self = { code: null, name: 'this process', role: null };
    try {
      return { cluster: false, note, results: [{ ...self, result: await local(action, arg) }] };
    } catch (e) {
      return { cluster: false, note, results: [{ ...self, error: e.message }] };
    }
  };

  const receive = async (message) => {
    if (!message || typeof message !== 'object') {
      return;
    }
    if (message.type === RUN && ACTIONS.includes(message.action) && okArg(message.arg)) {
      let reply;
      try {
        reply = { type: DONE, id: message.id, result: await local(message.action, message.arg) };
      } catch (e) {
        reply = { type: DONE, id: message.id, error: e.message };
      }
      try {
        channel.send(reply);
      } catch (e) {
        // the launcher is gone: it times out
      }
    } else if (message.type === ALL && pending.has(message.id)) {
      const p = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(p.timer);
      p.resolve({ cluster: true, note: null, results: Array.isArray(message.results) ? message.results : [] });
    }
  };
  if (usable) {
    channel.on('message', receive);
  }

  const ask = (action, arg = null) => {
    if (!ACTIONS.includes(action) || !okArg(arg)) {
      return Promise.reject(new Error(`Unknown action ${action}`));
    }
    if (!usable || channel.connected === false) {
      return alone(action, arg);
    }
    const id = crypto.randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        pending.delete(id);
        // the launcher didn't answer at all: this process at least (not emptied twice: the
        // launcher didn't pass it on, or it would have answered)
        resolve(alone(action, arg, 'The launcher did not answer: this process only'));
      }, timeoutMs + marginMs);
      pending.set(id, { resolve, timer });
      try {
        channel.send({ type: ASK, id, action, arg });
      } catch (e) {
        clearTimeout(timer);
        pending.delete(id);
        resolve(alone(action, arg, 'The launcher could not be asked: this process only'));
      }
    });
  };

  const disconnect = () => {
    if (usable) {
      channel.removeListener('message', receive);
    }
    for (const p of pending.values()) {
      clearTimeout(p.timer);
    }
    pending.clear();
  };
  return { ask, disconnect };
}

/**
 * The launcher's side: passes an ASK on to every process that is ready, and hands what they
 * answer to the process that asked.
 */
class CacheFanout {
  /**
   * @param {Object[]} procs - the launcher's processes: {code, name, role, ready, child}
   * @param {Object} [options]
   * @param {number} [options.timeoutMs]
   */
  constructor(procs, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.procs = procs;
    this.timeoutMs = timeoutMs;
    this.pending = new Map(); // id -> {asker, results: Map(code -> entry), waiting: Set(code), timer}
  }

  static #who(p) {
    return { code: p.code, name: p.name, role: p.role };
  }

  /**
   * An ASK from a process
   * @param {Object} from - the process that asked
   * @param {Object} message
   */
  ask(from, message) {
    if (!message || typeof message.id !== 'string' || !ACTIONS.includes(message.action) || !okArg(message.arg) || this.pending.has(message.id)) {
      return;
    }
    const asker = from.child;
    const targets = this.procs.filter(p => p.ready && p.child && p.child.connected);
    const entry = { asker, results: new Map(), waiting: new Set(), timer: null };
    this.pending.set(message.id, entry);
    for (const p of this.procs) {
      if (!targets.includes(p)) {
        entry.results.set(p.code, { ...CacheFanout.#who(p), error: 'not running' });
      }
    }
    for (const p of targets) {
      entry.waiting.add(p.code);
      try {
        p.child.send({ type: RUN, id: message.id, action: message.action, arg: message.arg });
      } catch (e) {
        entry.waiting.delete(p.code);
        entry.results.set(p.code, { ...CacheFanout.#who(p), error: 'could not be asked' });
      }
    }
    entry.timer = setTimeout(() => this.#finish(message.id), this.timeoutMs);
    if (typeof entry.timer.unref === 'function') {
      entry.timer.unref();
    }
    if (entry.waiting.size === 0) {
      this.#finish(message.id);
    }
  }

  /**
   * A DONE from a process
   */
  done(from, message) {
    const entry = message && this.pending.get(message.id);
    if (!entry || !entry.waiting.has(from.code)) {
      return;
    }
    entry.waiting.delete(from.code);
    entry.results.set(from.code, message.error ? { ...CacheFanout.#who(from), error: String(message.error) }
      : { ...CacheFanout.#who(from), result: message.result });
    if (entry.waiting.size === 0) {
      this.#finish(message.id);
    }
  }

  #finish(id) {
    const entry = this.pending.get(id);
    if (!entry) {
      return;
    }
    this.pending.delete(id);
    clearTimeout(entry.timer);
    for (const code of entry.waiting) {
      const p = this.procs.find(q => q.code === code);
      entry.results.set(code, { ...(p ? CacheFanout.#who(p) : { code }), error: `no answer in ${Math.round(this.timeoutMs / 1000)} s` });
    }
    // in the launcher's order: the master first
    const results = this.procs.map(p => entry.results.get(p.code)).filter(Boolean);
    try {
      if (entry.asker && entry.asker.connected) {
        entry.asker.send({ type: ALL, id, results });
      }
    } catch (e) {
      // the process that asked is gone
    }
  }
}

module.exports = { connectCaches, CacheFanout, ASK, RUN, DONE, ALL, DEFAULT_TIMEOUT_MS };
