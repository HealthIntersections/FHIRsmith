const { monitorEventLoopDelay } = require('perf_hooks');
const {Utilities} = require("./library/utilities");
const escape = require('escape-html');
const StatsDatabase = require('./stats-db');

// Requests that aren't counted by a module (the root page, the dashboard) are
// attributed here, and requests that have no endpoint dimension (everything
// outside the tx module) carry NO_ENDPOINT.
const SERVER_MODULE = '(server)';
const NO_ENDPOINT = '';

/**
 * A per-module view of the server statistics.
 *
 * Modules are handed one of these instead of the ServerStats itself, so that
 * everything they count is attributed to them without each of the ~76 call
 * sites having to name its own module. The API is deliberately the same shape
 * as ServerStats, so a module can't tell the difference - except that
 * countRequest takes an optional endpoint, which is how the tx module
 * distinguishes /tx/r4 from /tx/r5.
 */
class ModuleStats {

  constructor(parent, module) {
    this.parent = parent;
    this.module = module;
  }

  countRequest(name, tat, endpoint = NO_ENDPOINT) {
    this.parent.countRequest(name, tat, this.module, endpoint);
  }

  addTask(name, frequency) { this.parent.addTask(name, frequency); }
  task(name, state) { this.parent.task(name, state); }
  taskDone(name, state) { this.parent.taskDone(name, state); }
  taskError(name, state) { this.parent.taskError(name, state); }

  // Pass-throughs for the handful of properties modules read off the stats
  // object. These have to be getters, not copies, or a module would capture
  // the value at construction time and never see it change.
  get cachingModules() { return this.parent.cachingModules; }
  get requestCount() { return this.parent.requestCount; }
  get staticRequestCount() { return this.parent.staticRequestCount; }
  get history() { return this.parent.history; }
  get startTime() { return this.parent.startTime; }

  /**
   * What this module served in (since, now]: {total, operations: {name: count},
   * endpoints: {endpoint: {name: count}}} - see ServerStats.countsSince(). This
   * is what a module's dailyReport() builds its numbers from.
   */
  countsSince(since, now = Date.now()) {
    return this.parent.countsSince(since, now, this.module);
  }
}

class ServerStats {
  started = false;
  requestCount = 0;
  staticRequestCount = 0;
  requestTime = 0;
  // Collect metrics every 10 minutes
  intervalMs = 10 * 60 * 1000;
  history = [];
  requestCountSnapshot = 0;
  startMem = 0;
  startTime = Date.now();
  timer;
  cachingModules = [];
  taskMap = new Map();
  // key (module/endpoint/operation) -> counter. See countRequest().
  counters = new Map();
  db = null;
  // this run's row in server_runs, and what the earlier runs add up to - see overallUptime()
  runId = null;
  earlierRuns = {firstStart: null, runningMs: 0};
  // how often this run says "still alive"; a crash loses at most this much
  // from the overall uptime figure
  heartbeatMs = 60 * 1000;
  heartbeat = null;

  constructor(config, log) {
    this.config = config || {};
    this.log = log || console;
    if (this.config.intervalMinutes) {
      this.intervalMs = this.config.intervalMinutes * 60 * 1000;
    }
    this.openDatabase();
    this.timer = setInterval(() => {
      this.recordMetrics();
    }, this.intervalMs);
  }

  /**
   * Open the persistent counter store and pick up where the last run of the
   * server left off. Statistics must never be the reason the server won't
   * start, so a failure here is logged and then ignored: the counters carry
   * on in memory, they just don't survive the next restart.
   */
  openDatabase() {
    if (this.config.enabled === false) {
      return;
    }
    try {
      this.db = new StatsDatabase(this.config, this.log).open();
      for (const row of this.db.loadTotals()) {
        const counter = this.counterFor(row.module, row.endpoint, row.operation);
        counter.countTotal = row.countTotal;
        counter.timeTotal = row.timeTotal;
      }
    } catch (e) {
      this.log.error(`Unable to open the statistics database: ${e.message}. Statistics will not be persisted`);
      this.db = null;
    }
  }

  /**
   * A view of the statistics that attributes everything counted through it to
   * the named module (see ModuleStats).
   */
  forModule(module) {
    return new ModuleStats(this, module);
  }

  recordMetrics() {
    if (this.started) {
      const now = Date.now();

      const currentMem = process.memoryUsage().heapUsed;
      const combinedCount = this.requestCount + this.staticRequestCount;
      const requestsDelta = combinedCount - this.requestCountSnapshot;
      const requestsTat = requestsDelta > 0 ? this.requestTime / requestsDelta : 0;
      const minutesSinceStart = this.history.length > 1
        ? this.intervalMs / 60000
        : (now - this.startTime) / 60000;
      const requestsPerMin = minutesSinceStart > 0 ? requestsDelta / minutesSinceStart : 0;

      const loopDelay = this.eventLoopMonitor.mean / 1e6;
      // Worst single stall in the window - the mean dilutes a multi-second
      // event-loop block into noise; the max is what shows request-freezing
      // stalls (see the 2026-07-30 tx.fhir.org incident).
      const loopMax = this.eventLoopMonitor.max / 1e6;
      // The client (resource) cache, as concepts held - a sense of how much it's carrying.
      // (The expansion cache isn't tracked over time: it fills to its limit over a few
      // days and then sits there, so a history of it says nothing. The home page still
      // shows its current size.)
      const clientConcepts = this._sumCachingModules('clientConceptCount');

      this.history.push({time: now, mem: currentMem - this.startMem, rpm: requestsPerMin, tat: requestsTat, block: loopDelay, blockMax: loopMax, clientConcepts: clientConcepts});

      this.eventLoopMonitor.reset();
      this.requestCountSnapshot = combinedCount;
      this.requestTime = 0;
      this.lastTime = now;

      // Prune old data (keep 24 hours). Only the in-memory history is pruned -
      // the per-endpoint counters are persisted and kept indefinitely.
      const cutoff = now - (24 * 60 * 60 * 1000); // 24 hours ago
      this.history = this.history.filter(m => m.time > cutoff);

      this.flushCounters(now, this.intervalMs);
    }
  }

  markStarted(version = null) {
    this.started = true;
    this.version = version;
    this.startMem = process.memoryUsage().heapUsed;
    this.startTime = Date.now();
    this.lastTime = this.startTime;
    this.eventLoopMonitor = monitorEventLoopDelay({ resolution: 20 });
    this.eventLoopMonitor.enable();
    this.startRun();
    this.recordMetrics();
  }

  /**
   * Record this run in the database and start the heartbeat that keeps its
   * last_seen current. As with everything else here, a failure is logged and
   * the overall uptime just isn't available for this run.
   */
  startRun() {
    if (!this.db) {
      return;
    }
    try {
      this.runId = this.db.startRun(this.startTime, this.version);
      this.earlierRuns = this.db.loadRunHistory(this.runId);
    } catch (e) {
      this.log.error(`Unable to record the server run: ${e.message}. Overall uptime will not be available`);
      this.runId = null;
      return;
    }
    this.heartbeat = setInterval(() => this.touchRun(), this.heartbeatMs);
    if (typeof this.heartbeat.unref === 'function') {
      this.heartbeat.unref();
    }
  }

  /**
   * The server's runs since `since`, oldest first, each {started, lastSeen,
   * version, current}, preceded by the run before that (if any) - see
   * StatsDatabase.loadRuns(). The current run is reported as seen now, not as
   * of its last heartbeat. null if the history isn't being kept.
   */
  runHistory(since, now = Date.now()) {
    if (this.runId == null) {
      return null;
    }
    let runs;
    try {
      runs = this.db.loadRuns(since);
    } catch (e) {
      this.log.error(`Unable to read the server run history: ${e.message}`);
      return null;
    }
    return runs.map(r => r.id === this.runId
      ? {started: r.started, lastSeen: now, version: r.version, current: true}
      : {started: r.started, lastSeen: r.lastSeen, version: r.version, current: false});
  }

  touchRun() {
    if (this.db && this.runId != null) {
      try {
        this.db.touchRun(this.runId, Date.now());
      } catch (e) {
        this.log.error(`Unable to record the server heartbeat: ${e.message}`);
      }
    }
  }

  /**
   * The proportion of time the server has been up, over every run recorded
   * in the statistics database: time it was known to be running (each run,
   * from its start to the last heartbeat it wrote, plus this run up to now)
   * as a percentage of the time since the first recorded run started.
   *
   * Returns {percent, since} or null if the history isn't being kept.
   */
  overallUptime(now = Date.now()) {
    if (this.runId == null) {
      return null;
    }
    const since = this.earlierRuns.firstStart == null ? this.startTime : Math.min(this.earlierRuns.firstStart, this.startTime);
    const elapsed = now - since;
    if (elapsed <= 0) {
      return {percent: 100, since: since};
    }
    const running = this.earlierRuns.runningMs + (now - this.startTime);
    return {percent: Math.min(100, (running * 100) / elapsed), since: since};
  }

  /**
   * The counter for one (module, endpoint, operation), created on first use.
   *
   * countDelta/timeDelta accumulate within the current interval and are reset
   * each time they're written out; countTotal/timeTotal are cumulative for the
   * life of the database, not the life of the process.
   */
  counterFor(module, endpoint, operation) {
    const key = `${module}\u001f${endpoint}\u001f${operation}`;
    let counter = this.counters.get(key);
    if (!counter) {
      counter = {
        module: module, endpoint: endpoint, operation: operation,
        countDelta: 0, timeDelta: 0, countTotal: 0, timeTotal: 0
      };
      this.counters.set(key, counter);
    }
    return counter;
  }

  /**
   * Count one request. Modules go through their own ModuleStats, which fills
   * in module (and, for tx, the endpoint) for them.
   *
   * @param {string} name - the operation, e.g. '$expand' or 'login'
   * @param {number} tat - turnaround time in ms
   * @param {string} module - the module that served it
   * @param {string} endpoint - the endpoint within the module, where the
   *   module has more than one (the tx module does; nothing else does yet)
   */
  countRequest(name, tat, module = SERVER_MODULE, endpoint = NO_ENDPOINT) {
    this.requestCount++;
    this.requestTime = this.requestTime + tat;

    const counter = this.counterFor(module || SERVER_MODULE, endpoint || NO_ENDPOINT, name || '(unnamed)');
    counter.countDelta++;
    counter.countTotal++;
    counter.timeDelta = counter.timeDelta + tat;
    counter.timeTotal = counter.timeTotal + tat;
  }

  /**
   * Write out the counters that saw traffic this interval, and start the next
   * one. The deltas are only cleared if the write succeeded, so a transient
   * database problem delays the numbers rather than losing them (the interval
   * they're eventually written against is longer, which is what interval_ms on
   * the row is for).
   */
  flushCounters(now, intervalMs) {
    if (!this.db) {
      return 0;
    }
    const rows = [];
    for (const counter of this.counters.values()) {
      if (counter.countDelta > 0) {
        rows.push({...counter});
      }
    }
    if (rows.length === 0) {
      this.lastFlush = now;
      return 0;
    }
    try {
      this.db.write(now, intervalMs, rows);
    } catch (e) {
      this.log.error(`Unable to write statistics: ${e.message}`);
      return 0;
    }
    for (const counter of this.counters.values()) {
      counter.countDelta = 0;
      counter.timeDelta = 0;
    }
    this.lastFlush = now;
    return rows.length;
  }

  /**
   * Write out whatever has been counted since the last flush, so that a
   * countsSince() up to `now` sees everything. Used by the daily report.
   */
  flushNow(now = Date.now()) {
    this.flushCounters(now, now - (this.lastFlush || this.lastTime || this.startTime));
  }

  /**
   * The requests a module served in (since, now], from the persisted rows plus
   * anything counted since the last flush. Without the database only the
   * unflushed counts are known, so persisted is false to say the numbers are
   * partial.
   */
  countsSince(since, now, module) {
    const result = {total: 0, operations: {}, endpoints: {}, persisted: Boolean(this.db)};
    const add = (endpoint, operation, count) => {
      if (!count) {
        return;
      }
      result.total += count;
      result.operations[operation] = (result.operations[operation] || 0) + count;
      const ep = result.endpoints[endpoint] || (result.endpoints[endpoint] = {});
      ep[operation] = (ep[operation] || 0) + count;
    };
    if (this.db) {
      try {
        for (const row of this.db.countsSince(since, now, module)) {
          add(row.endpoint, row.operation, row.count);
        }
      } catch (e) {
        this.log.error(`Unable to read request counts: ${e.message}`);
        result.persisted = false;
      }
    }
    for (const counter of this.counters.values()) {
      if (counter.module === module) {
        add(counter.endpoint, counter.operation, counter.countDelta);
      }
    }
    return result;
  }

  addTask(name, frequency) {
    let info = {};
    this.taskMap.set(name, info);
    info.frequency = frequency;
    info.state = "Started";
    info.status = "started"
  }

  task(name, state) {
    let info = this.taskMap.get(name);
    if (info) {
      info.date = Date.now();
      info.state = state;
      info.status = 'working';
    }
  }

  taskDone(name, state) {
    let info = this.taskMap.get(name);
    if (info) {
      info.date = Date.now();
      info.state = state;
      info.status = 'resting';
    }
  }

  taskError(name, state) {
    let info = this.taskMap.get(name);
    if (info) {
      info.date = Date.now();
      info.state = state;
      info.status = 'error';
    }
  }

  /**
   * The background tasks whose last run failed: [{name, state, frequency, date}]
   */
  failedTasks() {
    const failed = [];
    for (const [name, info] of this.taskMap) {
      if (info.status === 'error') {
        failed.push({name: name, state: info.state, frequency: info.frequency, date: info.date});
      }
    }
    return failed;
  }

  taskDetails() {
    if (this.taskMap.size == 0) {
      return "";
    }
    let html = '<table class="grid" >';
    html += "<tr><th>Background Task</th><th>Status</th><th>Frequency</th><th>Last Seen</th></tr>";
    for (let m of this.taskMap.keys()) {
      let mm = this.taskMap.get(m);
      let color = this.getTaskColor(mm.status);
      html += `<tr style="background-color: ${color}"><td>`;
      html += escape(m);
      html += "</td><td>";
      html += escape(mm.state);
      html += "</td><td>";
      html += mm.frequency;
      html += "</td><td>";
      html += Utilities.formatDuration(mm.date, Date.now());
      html += "</td></tr>";
    }
    html += "</table>";
    return html;
  }

  finishStats() {
    clearInterval(this.timer);
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    this.touchRun();
    // Synchronous, so the last partial interval is on disk before server.js
    // calls process.exit().
    this.flushCounters(Date.now(), Date.now() - (this.lastTime || this.startTime));
    if (this.db) {
      try {
        this.db.close();
      } catch (e) {
        this.log.error(`Unable to close the statistics database: ${e.message}`);
      }
      this.db = null;
    }
  }

  // Live cache aggregates across all registered caching modules (defensive: a
  // module that doesn't expose a given metric contributes 0).
  _sumCachingModules(method) {
    let total = 0;
    for (let m of this.cachingModules) {
      if (typeof m[method] === 'function') {
        total = total + m[method]();
      }
    }
    return total;
  }

  expansionItems() { return this._sumCachingModules('expansionItemCount'); }
  clientCaches() { return this._sumCachingModules('clientCacheCount'); }
  clientConcepts() { return this._sumCachingModules('clientConceptCount'); }
  maxClientCaches() { return this._sumCachingModules('maxClientCacheCount'); }
  maxClientConcepts() { return this._sumCachingModules('maxClientConceptCount'); }

  // $closure usage, from whichever module keeps closure tables; null if none does
  closureStats() {
    for (let m of this.cachingModules) {
      if (typeof m.closureStats === 'function') {
        const s = m.closureStats();
        if (s) {
          return s;
        }
      }
    }
    return null;
  }

  getTaskColor(status) {
    switch (status) {
      case "started": return "LightGrey";
      case "working": return "LightGreen";
      case "resting": return "White";
      case "error": return "LightRed";
      default: return "DarkBlue"; // should not happen
    }
  }
}
module.exports = ServerStats;
module.exports.ModuleStats = ModuleStats;
module.exports.SERVER_MODULE = SERVER_MODULE;