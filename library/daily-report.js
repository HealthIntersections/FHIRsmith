// library/daily-report.js
// A daily markdown report on the server, emailed at midnight (local time) - or, if the
// server was down at midnight, as soon as it comes up afterwards. It's only sent when
// there's a way to send it: the top-level "email" block (see library/mailer.js) and
// someone to send it to:
//
//   "dailyReport": {
//     "enabled": true,          // default true; the report still needs "email" and "to"
//     "to": ["ops@example.org"]
//   }
//
// The report is:
//  - a paragraph on the server's own stability since the last report: how much of the
//    time it was up, restarts, and any upgrade (from the run history ServerStats keeps)
//  - a paragraph from each running module that has something to say. A module takes part
//    by having `dailyReport({since, now})` return markdown (a string, or a promise of one);
//    an empty return means no paragraph. By default modules have nothing to say
//  - a paragraph on the system: version, Node and OS, how long this run has been up, the
//    log files and the free disk space they're drawing on
//
// When each report was sent is kept in [data]/daily-report.json, which is how a restart
// knows whether last midnight's report is still owed, and what period the next one covers.

const fs = require('fs');
const os = require('os');
const path = require('path');
const folders = require('./folder-setup');

const DAY_MS = 24 * 60 * 60 * 1000;
// headings for the modules' paragraphs; a module not listed is headed by its key
const MODULE_TITLES = {
  tx: 'Terminology server',
  registry: 'Terminology server registry',
  packages: 'Packages',
  xig: 'XIG',
  shl: 'SMART Health Links',
  ips: 'IPS',
  testing: 'Testing',
  publisher: 'Publisher',
  vcl: 'VCL',
  token: 'Tokens',
  npmprojector: 'npm projector',
  extTracker: 'Extension tracker',
  folder: 'Folders'
};
const STATE_FILE = 'daily-report.json';
const TASK_NAME = 'daily report';

function pad(n) {
  return String(n).padStart(2, '0');
}

/** 2026-10-22 for the local date of `time` */
function localDate(time) {
  const d = new Date(time);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 2026-10-22 14:05 local */
function localDateTime(time) {
  const d = new Date(time);
  return `${localDate(time)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The next local midnight after `now` */
function nextMidnight(now) {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

/** "2d 3h 15m" - to the minute, which is all a daily report needs */
function formatSpan(ms) {
  const minutes = Math.round(Math.max(0, ms) / 60000);
  if (minutes < 1) {
    return 'less than a minute';
  }
  const parts = [];
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (mins || parts.length === 0) parts.push(`${mins}m`);
  return parts.join(' ');
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

class DailyReport {

  /**
   * @param config - the "dailyReport" block
   * @param deps - {log, stats, modules, mailer, npmAudit, version, serverId, stateFile}
   *   modules is the server's {name: instance} map; npmAudit the server's NpmAudit (optional);
   *   version the server's version; serverId the name the report goes out under (config.hostName)
   */
  constructor(config, deps) {
    this.config = config || {};
    this.log = deps.log || console;
    this.stats = deps.stats;
    this.modules = deps.modules || {};
    this.mailer = deps.mailer;
    this.npmAudit = deps.npmAudit || null;
    this.version = deps.version;
    this.serverId = deps.serverId || os.hostname();
    this.stateFile = deps.stateFile || folders.filePath(STATE_FILE);
    this.timer = null;
    this.running = false;
  }

  /**
   * Whether reports will go out: turned on, somewhere to send them, and a
   * way to send them.
   */
  get enabled() {
    const to = this.config.to;
    const hasRecipient = Array.isArray(to) ? to.length > 0 : Boolean(to);
    return this.config.enabled !== false && hasRecipient && Boolean(this.mailer && this.mailer.configured());
  }

  /**
   * Say in the log why reports won't be sent, if they won't; then send the
   * one owed from last midnight if the server was down for it, and set the
   * timer for the next.
   */
  start(now = Date.now()) {
    if (this.config.enabled === false) {
      return;
    }
    if (!this.enabled) {
      const why = !(this.mailer && this.mailer.configured()) ? 'no "email" block in the configuration' : 'no "dailyReport.to" recipients';
      this.log.info(`Daily report: not sent (${why})`);
      return;
    }
    if (this.stats) {
      this.stats.addTask(TASK_NAME, 'daily');
    }
    const state = this.readState();
    // owed if a midnight has passed since the last report went out (a server
    // that has never reported waits for its first midnight)
    if (state.sentAt && localDate(state.sentAt) !== localDate(now)) {
      this.log.info('Daily report: the server was down at midnight, sending it now');
      void this.run(now);
    }
    this.schedule(now);
  }

  schedule(now = Date.now()) {
    const delay = Math.max(1000, nextMidnight(now) - now);
    this.timer = setTimeout(() => {
      this.timer = null;
      // run() handles its own errors, so the promise never rejects
      void this.run().finally(() => this.schedule());
    }, delay);
    if (this.timer.unref) {
      this.timer.unref();
    }
  }

  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  readState() {
    try {
      if (fs.existsSync(this.stateFile)) {
        return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) || {};
      }
    } catch (e) {
      this.log.warn(`Daily report: unable to read ${this.stateFile}: ${e.message}`);
    }
    return {};
  }

  writeState(state) {
    try {
      fs.mkdirSync(path.dirname(this.stateFile), {recursive: true});
      fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
    } catch (e) {
      this.log.error(`Daily report: unable to write ${this.stateFile}: ${e.message}`);
    }
  }

  /**
   * Build and send the report covering the time since the last one (or the
   * last day, for a first report). Never throws.
   */
  async run(now = Date.now()) {
    if (this.running) {
      return false;
    }
    this.running = true;
    try {
      const state = this.readState();
      const since = state.sentAt || (now - DAY_MS);
      if (this.stats) {
        this.stats.task(TASK_NAME, 'Building');
        if (typeof this.stats.flushNow === 'function') {
          // so the modules' counts run right up to now
          this.stats.flushNow(now);
        }
      }
      const text = await this.build(since, now);
      await this.mailer.send({to: this.config.to, subject: this.subject(), text: text});
      this.writeState({sentAt: now, date: localDate(now)});
      if (this.stats) {
        this.stats.taskDone(TASK_NAME, `Sent ${localDateTime(now)}`);
      }
      return true;
    } catch (e) {
      this.log.error(`Daily report: not sent: ${e.message}`);
      if (this.stats) {
        this.stats.taskError(TASK_NAME, `Not sent: ${e.message}`);
      }
      return false;
    } finally {
      this.running = false;
    }
  }

  subject() {
    return `${this.serverId} daily report`;
  }

  /**
   * The report as markdown, for the period since .. now.
   */
  async build(since, now = Date.now()) {
    const parts = [];
    parts.push(`# ${this.serverId} daily report`);
    parts.push(`${localDateTime(now)}, covering the ${formatSpan(now - since)} since ${localDateTime(since)}.`);
    parts.push('## Stability');
    parts.push(this.stabilityParagraph(since, now));
    for (const [name, module] of Object.entries(this.modules)) {
      const text = await this.moduleParagraph(name, module, since, now);
      if (text) {
        parts.push(`## ${MODULE_TITLES[name] || name}`);
        parts.push(text);
      }
    }
    parts.push('## System');
    parts.push(this.systemParagraph(now));
    const tasks = this.tasksParagraph(now);
    if (tasks) {
      parts.push('## Background tasks');
      parts.push(tasks);
    }
    return parts.join('\n\n') + '\n';
  }

  /**
   * How much of the period the server was running, restarts, and upgrades -
   * from the run history. Each run counts from its start to its last
   * heartbeat (every minute), so a crash shows as down from about when it
   * happened.
   */
  stabilityParagraph(since, now) {
    const runs = this.stats ? this.stats.runHistory(since, now) : null;
    if (!runs) {
      return 'No run history is available (the statistics database is not in use), so the uptime over the period is unknown.';
    }
    const period = now - since;
    let running = 0;
    const restarts = [];
    const upgrades = [];
    let previous = null;
    for (const run of runs) {
      const from = Math.max(run.started, since);
      const to = Math.min(run.lastSeen, now);
      if (to > from) {
        running += to - from;
      }
      if (run.started >= since) {
        restarts.push(run);
      }
      if (previous && run.version && previous.version && run.version !== previous.version) {
        upgrades.push({from: previous.version, to: run.version, at: run.started});
      }
      previous = run;
    }
    const percent = period > 0 ? Math.min(100, (running * 100) / period) : 100;
    const pct = percent >= 100 ? '100' : (Math.floor(percent * 10) / 10).toFixed(1);
    const sentences = [];
    sentences.push(`${this.serverId} was up for ${formatSpan(running)} of the ${formatSpan(now - since)} since the last report (${pct}%).`);
    if (restarts.length === 0) {
      sentences.push('It ran without interruption.');
    } else {
      const when = restarts.map(r => localDateTime(r.started)).join(', ');
      sentences.push(`It ${restarts.length === 1 ? 'started' : 'started ' + plural(restarts.length, 'time')} during the period (${when}).`);
    }
    // the gap before a restart is the downtime; name the worst one if there is one
    let worst = null;
    for (let i = 1; i < runs.length; i++) {
      const gapStart = Math.max(runs[i - 1].lastSeen, since);
      const gap = runs[i].started - gapStart;
      if (gap > 0 && (!worst || gap > worst.length)) {
        worst = {length: gap, at: gapStart};
      }
    }
    if (worst && worst.length >= 60 * 1000) {
      sentences.push(`The longest outage was ${formatSpan(worst.length)}, from ${localDateTime(worst.at)}.`);
    }
    for (const u of upgrades) {
      sentences.push(`It was upgraded from v${u.from} to v${u.to} at ${localDateTime(u.at)}.`);
    }
    if (upgrades.length === 0) {
      sentences.push(`It was not upgraded (v${this.version}).`);
    }
    return sentences.join(' ');
  }

  /**
   * A module's paragraph, if it has one. A module that throws gets a line
   * saying so rather than taking the report down.
   */
  async moduleParagraph(name, module, since, now) {
    if (!module || typeof module.dailyReport !== 'function') {
      return null;
    }
    try {
      const text = await module.dailyReport({since: since, now: now});
      return typeof text === 'string' && text.trim() ? text.trim() : null;
    } catch (e) {
      this.log.error(`Daily report: the ${name} module's report failed: ${e.message}`);
      return `The ${name} module's report failed: ${e.message}`;
    }
  }

  /**
   * Version, platform, how long this run has been up, and the log files and
   * the disk they're on.
   */
  systemParagraph(now) {
    const sentences = [];
    sentences.push(`${this.serverId} is running FHIRsmith v${this.version} on Node.js ${process.version} (${os.type()} ${os.release()}, ${os.arch()}).`);
    if (this.stats && typeof this.stats.startTime === 'number') {
      let up = `This run has been up for ${formatSpan(now - this.stats.startTime)}, since ${localDateTime(this.stats.startTime)}`;
      const overall = typeof this.stats.overallUptime === 'function' ? this.stats.overallUptime(now) : null;
      if (overall) {
        const pct = overall.percent >= 100 ? '100' : (Math.floor(overall.percent * 10) / 10).toFixed(1);
        up += `; over all its recorded runs (since ${localDate(overall.since)}) the server has been up ${pct}% of the time`;
      }
      sentences.push(up + '.');
    }
    sentences.push(this.logsSentence());
    if (this.npmAudit && typeof this.npmAudit.reportText === 'function') {
      const audit = this.npmAudit.reportText();
      if (audit) {
        sentences.push(audit);
      }
    }
    return sentences.join(' ');
  }

  /**
   * The background tasks whose last run failed, if any - one line each. The
   * npm audit has its own sentence in the system paragraph, and this report's
   * own task is never in a failed state while it's being written.
   */
  tasksParagraph(now) {
    if (!this.stats || typeof this.stats.failedTasks !== 'function') {
      return null;
    }
    const failed = this.stats.failedTasks().filter(t => t.name !== 'npm audit' && t.name !== TASK_NAME);
    if (failed.length === 0) {
      return null;
    }
    const lines = failed.map(t => {
      const when = t.date ? ` (${formatSpan(now - t.date)} ago)` : '';
      return `- ${t.name}: the last run failed${when}: ${t.state}`;
    });
    return `${plural(failed.length, 'background task')} ${failed.length === 1 ? 'is' : 'are'} in a failed state:\n\n${lines.join('\n')}`;
  }

  logsSentence() {
    const logDir = folders.logsDir();
    try {
      const files = fs.readdirSync(logDir).filter(f => f.endsWith('.log'));
      let total = 0;
      for (const f of files) {
        total += fs.statSync(path.join(logDir, f)).size;
      }
      let disk = '';
      try {
        const fstats = fs.statfsSync(logDir);
        const free = fstats.bavail * fstats.bsize;
        const size = fstats.blocks * fstats.bsize;
        const freePct = size > 0 ? Math.round((free * 100) / size) : 0;
        disk = `, on a disk with ${formatBytes(free)} free of ${formatBytes(size)} (${freePct}% free)`;
      } catch {
        disk = ', on a disk whose free space could not be read';
      }
      return `The logs folder (${logDir}) holds ${plural(files.length, 'log file')} totalling ${formatBytes(total)}${disk}.`;
    } catch (e) {
      return `The logs folder (${logDir}) could not be read: ${e.message}.`;
    }
  }
}

module.exports = DailyReport;
module.exports.nextMidnight = nextMidnight;
module.exports.localDate = localDate;
module.exports.formatSpan = formatSpan;
// for modules writing their paragraph: "3 packages", "1 package"
module.exports.plural = plural;
module.exports.localDateTime = localDateTime;
