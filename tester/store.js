//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * The tester's database (SQLite): the runs, queued and done, and each test's result. A run is
 * of a FHIR server (Kind 'fhir': the RESTful API tests) or of an npm registry (Kind 'npm': the
 * npm registry protocol checks, of a package and version it holds) or of a terminology server
 * (Kind 'tx': the HL7 terminology service tests, in the Modes chosen).
 *
 * A run's bearer token is kept only while the run is queued or running (Token), and is set to
 * NULL as it ends, however it ends. It is never read but by the queue.
 *
 * @module tester/store
 */

const Database = require('better-sqlite3');

const STATUSES = ['queued', 'running', 'completed', 'cancelled', 'error', 'interrupted'];

class TesterStore {
  /**
   * @param {string} file - the database file, or ':memory:'
   */
  constructor(file) {
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS Runs (
        Id TEXT PRIMARY KEY,
        Server TEXT NOT NULL,
        UserId INTEGER,
        UserName TEXT,
        Requested INTEGER NOT NULL,
        Started INTEGER,
        Finished INTEGER,
        Status TEXT NOT NULL,
        Message TEXT,
        Progress TEXT,
        FhirVersion TEXT,
        Software TEXT,
        Pass INTEGER NOT NULL DEFAULT 0,
        Fail INTEGER NOT NULL DEFAULT 0,
        Warning INTEGER NOT NULL DEFAULT 0,
        Skip INTEGER NOT NULL DEFAULT 0,
        Error INTEGER NOT NULL DEFAULT 0,
        Token TEXT,
        CancelAsked INTEGER NOT NULL DEFAULT 0,
        Cleanup TEXT,
        Report TEXT,
        Uploaded TEXT,
        UploadError TEXT,
        Kind TEXT NOT NULL DEFAULT 'fhir',
        Package TEXT,
        Version TEXT,
        Modes TEXT
      );
      CREATE INDEX IF NOT EXISTS RunsRequested ON Runs (Requested);
      CREATE INDEX IF NOT EXISTS RunsStatus ON Runs (Status);
      CREATE TABLE IF NOT EXISTS Results (
        RunId TEXT NOT NULL,
        Seq INTEGER NOT NULL,
        GroupName TEXT NOT NULL,
        Name TEXT NOT NULL,
        Outcome TEXT NOT NULL,
        Message TEXT,
        Ms INTEGER,
        Start TEXT,
        End TEXT,
        Exchanges TEXT,
        Resources TEXT,
        PRIMARY KEY (RunId, Seq)
      );
    `);
    // (a database from before Resources)
    if (!this.db.prepare('PRAGMA table_info(Results)').all().some(c => c.name === 'Resources')) {
      this.db.exec('ALTER TABLE Results ADD COLUMN Resources TEXT');
    }
    // (a database from before npm registry runs)
    const runColumns = this.db.prepare('PRAGMA table_info(Runs)').all().map(c => c.name);
    if (!runColumns.includes('Kind')) {
      this.db.exec("ALTER TABLE Runs ADD COLUMN Kind TEXT NOT NULL DEFAULT 'fhir'");
      this.db.exec('ALTER TABLE Runs ADD COLUMN Package TEXT');
      this.db.exec('ALTER TABLE Runs ADD COLUMN Version TEXT');
    }
    // (a database from before terminology runs)
    if (!this.db.prepare('PRAGMA table_info(Runs)').all().some(c => c.name === 'Modes')) {
      this.db.exec('ALTER TABLE Runs ADD COLUMN Modes TEXT');
    }
  }

  close() {
    this.db.close();
  }

  /** Queue a run: kind 'fhir' (the default), 'npm' (with pkg and version), or 'tx' (with modes, a list) */
  queue({ id, server, token, userId, userName, kind, pkg, version, modes }) {
    this.db.prepare('INSERT INTO Runs (Id, Server, UserId, UserName, Requested, Status, Token, Kind, Package, Version, Modes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, server, userId, userName, Date.now(), 'queued', token || null, ['npm', 'tx'].includes(kind) ? kind : 'fhir', pkg || null, version || null,
        modes ? JSON.stringify(modes) : null);
  }

  /** A user's run that is queued or running, or null */
  activeFor(userId) {
    return this.db.prepare("SELECT Id FROM Runs WHERE UserId = ? AND Status IN ('queued', 'running')").get(userId) || null;
  }

  /** The next queued run, with its token (for the queue only) */
  nextQueued() {
    return this.db.prepare("SELECT Id, Server, Token, Kind, Package, Version, Modes FROM Runs WHERE Status = 'queued' AND CancelAsked = 0 ORDER BY Requested LIMIT 1").get() || null;
  }

  /** The runs queued (oldest first), for a run's place in the queue */
  queuedIds() {
    return this.db.prepare("SELECT Id FROM Runs WHERE Status = 'queued' ORDER BY Requested").all().map(r => r.Id);
  }

  started(id) {
    this.db.prepare("UPDATE Runs SET Status = 'running', Started = ?, Progress = 'Starting' WHERE Id = ?").run(Date.now(), id);
  }

  progress(id, text) {
    this.db.prepare('UPDATE Runs SET Progress = ? WHERE Id = ?').run(String(text).substring(0, 500), id);
  }

  /** What the run found out about the server */
  server(id, { fhirVersion, software }) {
    this.db.prepare('UPDATE Runs SET FhirVersion = ?, Software = ? WHERE Id = ?').run(fhirVersion || null, software || null, id);
  }

  /** A test's result, as it comes */
  addResult(id, seq, r) {
    const col = { pass: 'Pass', fail: 'Fail', warning: 'Warning', skip: 'Skip', error: 'Error' }[r.outcome] || 'Error';
    this.db.transaction(() => {
      this.db.prepare('INSERT OR REPLACE INTO Results (RunId, Seq, GroupName, Name, Outcome, Message, Ms, Start, End, Exchanges, Resources) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, seq, r.group, r.name, r.outcome, r.message || null, r.ms || 0, r.start || null, r.end || null,
          r.exchanges && r.exchanges.length ? JSON.stringify(r.exchanges) : null, r.resources && r.resources.length ? JSON.stringify(r.resources) : null);
      this.db.prepare(`UPDATE Runs SET ${col} = ${col} + 1 WHERE Id = ?`).run(id);
    })();
  }

  /** The run is over: its status, why, what was cleaned up, the report; the token is gone */
  finished(id, { status, message, cleanup, report }) {
    this.db.prepare('UPDATE Runs SET Status = ?, Message = ?, Finished = ?, Cleanup = ?, Report = ?, Token = NULL, Progress = NULL WHERE Id = ?')
      .run(STATUSES.includes(status) ? status : 'error', message || null, Date.now(), cleanup ? JSON.stringify(cleanup) : null,
        report ? JSON.stringify(report) : null, id);
  }

  uploaded(id, where, error) {
    this.db.prepare('UPDATE Runs SET Uploaded = ?, UploadError = ? WHERE Id = ?').run(where || null, error || null, id);
  }

  /** Ask for a run to stop: a queued one is cancelled now; a running one when the queue sees it */
  cancel(id) {
    const r = this.db.prepare('SELECT Status FROM Runs WHERE Id = ?').get(id);
    if (!r || !['queued', 'running'].includes(r.Status)) {
      return false;
    }
    if (r.Status === 'queued') {
      this.db.prepare("UPDATE Runs SET Status = 'cancelled', Message = 'Cancelled before it started', Finished = ?, Token = NULL WHERE Id = ? AND Status = 'queued'")
        .run(Date.now(), id);
    } else {
      this.db.prepare('UPDATE Runs SET CancelAsked = 1 WHERE Id = ?').run(id);
    }
    return true;
  }

  cancelAsked(id) {
    const r = this.db.prepare('SELECT CancelAsked FROM Runs WHERE Id = ?').get(id);
    return !!(r && r.CancelAsked);
  }

  /**
   * As the module starts: a run that was running when the server stopped didn't finish (and its
   * token is dropped)
   * @returns {number} how many
   */
  interrupted() {
    return this.db.prepare("UPDATE Runs SET Status = 'interrupted', Message = ?, Finished = ?, Token = NULL, Progress = NULL WHERE Status = 'running'")
      .run('The server stopped during the run: what the run made may be left on the server, tagged with the run\'s id', Date.now()).changes;
  }

  /** A run (without its token), or null */
  get(id) {
    const r = this.db.prepare('SELECT * FROM Runs WHERE Id = ?').get(id);
    if (!r) {
      return null;
    }
    delete r.Token;
    return r;
  }

  /** A run's results, in order: without the exchanges and resources (see result()) */
  results(id) {
    return this.db.prepare('SELECT RunId, Seq, GroupName, Name, Outcome, Message, Ms, Start, End FROM Results WHERE RunId = ? ORDER BY Seq').all(id);
  }

  /** One test's result, with its exchanges and the resources it made, or null */
  result(id, seq) {
    const r = this.db.prepare('SELECT * FROM Results WHERE RunId = ? AND Seq = ?').get(id, seq);
    return r ? { ...r, Exchanges: r.Exchanges ? JSON.parse(r.Exchanges) : [], Resources: r.Resources ? JSON.parse(r.Resources) : [] } : null;
  }

  /** The runs, newest first (without tokens) */
  list(offset = 0, limit = 50) {
    return this.db.prepare(`SELECT Id, Server, UserName, Requested, Started, Finished, Status, Message, Progress, FhirVersion, Software,
      Pass, Fail, Warning, Skip, Error, Uploaded, UploadError, Kind, Package, Version, Modes FROM Runs ORDER BY Requested DESC LIMIT ? OFFSET ?`).all(limit, offset);
  }

  count() {
    return this.db.prepare('SELECT COUNT(*) AS N FROM Runs').get().N;
  }

  /** Delete the runs finished before a time */
  purgeBefore(time) {
    return this.db.transaction(() => {
      const ids = this.db.prepare("SELECT Id FROM Runs WHERE Finished IS NOT NULL AND Finished < ? AND Status NOT IN ('queued', 'running')").all(time).map(r => r.Id);
      for (const id of ids) {
        this.db.prepare('DELETE FROM Results WHERE RunId = ?').run(id);
        this.db.prepare('DELETE FROM Runs WHERE Id = ?').run(id);
      }
      return ids.length;
    })();
  }
}

module.exports = { TesterStore, STATUSES };
