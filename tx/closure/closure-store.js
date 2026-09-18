//
// ClosureStore - persistent storage for $closure tables
//
// A closure table is named by the client, lives across sessions (and server restarts),
// and is shared across FHIR versions: the same name reaches the same table from /r4 and
// /r5. What's held for each table:
//
//   closure_table   the name, the current version, and when it was created / last used
//   closure_param   the parameters the table was initialised with, as an ordered series
//                   of name = value pairs (value is the JSON of the Parameters.parameter
//                   entry, so tx-resource resources and typed values survive). These are
//                   replayed on every later call: they are how the table remembers the
//                   code systems a client supplied, and the version / supplement rules
//   closure_concept every concept added, and the version it was added in
//   closure_entry   one row per related pair (narrower -> broader, or equivalent), and the
//                   version it was added in - which is what makes resync work
//
// better-sqlite3 on purpose: every write is synchronous, so a write transaction can never
// be interleaved with another request's. The only thing that needs a lock is the span of
// one $closure call on one table - read the table, compute (which awaits, and yields),
// write - and that is the per-table lock below.
//
// Synchronous also means every statement blocks the event loop while it runs, so nothing
// here reads or writes an unbounded amount in one go: reads that can be large are paged
// (entriesPage), and the size of what one call can write is capped by the worker.
//

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const folders = require('../../library/folder-setup');

const NARROWER = 'source-is-narrower-than-target';
const EQUIVALENT = 'equivalent';

class ClosureStore {

  /**
   * @param {Object} config - modules.tx.closure
   * @param {Object} [log]
   */
  constructor(config, log) {
    this.config = config || {};
    this.log = log || console;
    this.db = null;
    this.path = ClosureStore.resolvePath(this.config);
    this.locks = new Map(); // table name -> { tail: Promise, count: holder + waiters }
  }

  /**
   * config.database if given (relative paths resolve under the data folder's databases
   * directory), otherwise closure.db there. ':memory:' is passed through, for tests.
   */
  static resolvePath(config) {
    const configured = config && config.database;
    if (!configured) {
      return path.join(folders.databasesDir(), 'closure.db');
    }
    if (configured === ':memory:' || path.isAbsolute(configured)) {
      return configured;
    }
    return path.join(folders.databasesDir(), configured);
  }

  open() {
    if (this.path !== ':memory:') {
      fs.mkdirSync(path.dirname(this.path), {recursive: true});
    }
    this.db = new Database(this.path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS closure_table (
        id        INTEGER PRIMARY KEY,
        name      TEXT NOT NULL UNIQUE,
        version   INTEGER NOT NULL DEFAULT 0,
        created   TEXT NOT NULL,
        last_used TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS closure_param (
        table_id  INTEGER NOT NULL REFERENCES closure_table(id) ON DELETE CASCADE,
        seq       INTEGER NOT NULL,
        name      TEXT NOT NULL,
        value     TEXT NOT NULL,
        PRIMARY KEY (table_id, seq)
      );
      CREATE TABLE IF NOT EXISTS closure_concept (
        id            INTEGER PRIMARY KEY,
        table_id      INTEGER NOT NULL REFERENCES closure_table(id) ON DELETE CASCADE,
        system        TEXT NOT NULL,
        code          TEXT NOT NULL,
        display       TEXT,
        added_version INTEGER NOT NULL,
        UNIQUE (table_id, system, code)
      );
      CREATE TABLE IF NOT EXISTS closure_entry (
        table_id      INTEGER NOT NULL REFERENCES closure_table(id) ON DELETE CASCADE,
        source_id     INTEGER NOT NULL REFERENCES closure_concept(id) ON DELETE CASCADE,
        target_id     INTEGER NOT NULL REFERENCES closure_concept(id) ON DELETE CASCADE,
        relationship  TEXT NOT NULL,
        added_version INTEGER NOT NULL,
        PRIMARY KEY (table_id, source_id, target_id)
      );
      CREATE INDEX IF NOT EXISTS closure_entry_version ON closure_entry (table_id, added_version);
    `);
    this.stmt = {
      getTable: this.db.prepare('SELECT id, name, version, created, last_used FROM closure_table WHERE name = ?'),
      countTables: this.db.prepare('SELECT count(*) AS n FROM closure_table'),
      insertTable: this.db.prepare('INSERT INTO closure_table (name, version, created, last_used) VALUES (?, 0, ?, ?)'),
      deleteTable: this.db.prepare('DELETE FROM closure_table WHERE id = ?'),
      touchTable: this.db.prepare('UPDATE closure_table SET last_used = ? WHERE id = ?'),
      setVersion: this.db.prepare('UPDATE closure_table SET version = ?, last_used = ? WHERE id = ?'),
      insertParam: this.db.prepare('INSERT INTO closure_param (table_id, seq, name, value) VALUES (?, ?, ?, ?)'),
      getParams: this.db.prepare('SELECT name, value FROM closure_param WHERE table_id = ? ORDER BY seq'),
      getConcepts: this.db.prepare('SELECT id, system, code, display FROM closure_concept WHERE table_id = ?'),
      countConcepts: this.db.prepare('SELECT count(*) AS n FROM closure_concept WHERE table_id = ?'),
      insertConcept: this.db.prepare('INSERT INTO closure_concept (table_id, system, code, display, added_version) VALUES (?, ?, ?, ?, ?)'),
      insertEntry: this.db.prepare('INSERT OR IGNORE INTO closure_entry (table_id, source_id, target_id, relationship, added_version) VALUES (?, ?, ?, ?, ?)'),
      countEntries: this.db.prepare('SELECT count(*) AS n FROM closure_entry WHERE table_id = ?'),
      entriesPage: this.db.prepare(`
        SELECT e.rowid AS rowid,
               s.system AS source_system, s.code AS source_code, s.display AS source_display,
               t.system AS target_system, t.code AS target_code, t.display AS target_display,
               e.relationship
          FROM closure_entry e
          JOIN closure_concept s ON s.id = e.source_id
          JOIN closure_concept t ON t.id = e.target_id
         WHERE e.table_id = ? AND e.added_version > ? AND e.rowid > ?
         ORDER BY e.rowid
         LIMIT ?`),
      entriesSince: this.db.prepare(`
        SELECT s.system AS source_system, s.code AS source_code, s.display AS source_display,
               t.system AS target_system, t.code AS target_code, t.display AS target_display,
               e.relationship
          FROM closure_entry e
          JOIN closure_concept s ON s.id = e.source_id
          JOIN closure_concept t ON t.id = e.target_id
         WHERE e.table_id = ? AND e.added_version > ?`),
      staleTables: this.db.prepare('SELECT id, name FROM closure_table WHERE last_used < ?')
    };
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /**
   * Run fn with exclusive use of the named table. Calls on different tables run in
   * parallel; calls on the same table queue, in arrival order. fn may await (and yield)
   * as much as it likes - nothing else touches that table until it settles.
   *
   * The queue is bounded, and so is the wait, so a flood of calls on one table can't pile
   * up requests (and their sockets) without limit. A caller that gives up - timeout, or
   * opts.waitFor throwing because the client went away - never runs fn, and passes its
   * turn on to the next in line as soon as it comes.
   *
   * @param {string} name
   * @param {Function} fn - async () => result
   * @param {Object} [opts]
   * @param {number} [opts.maxQueue] - most calls allowed in the queue, counting the one
   *   running; beyond that the call fails at once. 0/absent = no limit
   * @param {number} [opts.timeoutMs] - longest to wait for the lock. 0/absent = no limit
   * @param {Function} [opts.waitFor] - (promise) => promise; wraps the wait (the worker
   *   uses OperationContext.waitFor, so the wait isn't charged to the compute deadline and
   *   a disconnected client stops waiting)
   * @throws {Error} with .closureBusy = 'queue' | 'timeout' when the lock isn't got
   */
  async withLock(name, fn, opts = {}) {
    let q = this.locks.get(name);
    if (!q) {
      q = { tail: Promise.resolve(), count: 0 };
      this.locks.set(name, q);
    }
    if (opts.maxQueue && q.count >= opts.maxQueue) {
      const error = new Error(`closure table '${name}' is busy`);
      error.closureBusy = 'queue';
      throw error;
    }
    const prior = q.tail;
    let release;
    const mine = new Promise(resolve => { release = resolve; });
    q.tail = prior.then(() => mine);
    q.count++;

    let timer = null;
    let acquired = false;
    try {
      let wait = prior;
      if (opts.timeoutMs) {
        wait = Promise.race([prior, new Promise((resolve, reject) => {
          timer = setTimeout(() => {
            const error = new Error(`timed out waiting for closure table '${name}'`);
            error.closureBusy = 'timeout';
            reject(error);
          }, opts.timeoutMs);
        })]);
      }
      await (opts.waitFor ? opts.waitFor(wait) : wait);
      acquired = true;
      return await fn();
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
      if (acquired) {
        release();
      } else {
        prior.then(release); // hand the turn on when it comes
      }
      q.count--;
      if (q.count === 0 && this.locks.get(name) === q) {
        this.locks.delete(name);
      }
    }
  }

  /**
   * @param {string} name
   * @returns {{id, name, version, created, last_used}|null}
   */
  getTable(name) {
    return this.stmt.getTable.get(name) || null;
  }

  tableCount() {
    return this.stmt.countTables.get().n;
  }

  conceptCount(tableId) {
    return this.stmt.countConcepts.get(tableId).n;
  }

  entryCount(tableId) {
    return this.stmt.countEntries.get(tableId).n;
  }

  /**
   * One page of the entries added after the given version, in the order they were
   * written. Page through with the last row's rowid as afterRowid (start with 0).
   * @returns {Array<{rowid, source_system, source_code, source_display, target_system, target_code, target_display, relationship}>}
   */
  entriesPage(tableId, version, afterRowid, limit) {
    return this.stmt.entriesPage.all(tableId, version, afterRowid, limit);
  }

  /**
   * Create a table, replacing any table of the same name (the caller has already decided
   * whether that's allowed). Its parameters are fixed here, for the life of the table.
   * @param {string} name
   * @param {Array<Object>} params - Parameters.parameter entries that configure the table
   * @returns {Object} the new table row
   */
  createTable(name, params) {
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      const existing = this.stmt.getTable.get(name);
      if (existing) {
        this.stmt.deleteTable.run(existing.id);
      }
      const info = this.stmt.insertTable.run(name, now, now);
      const id = info.lastInsertRowid;
      params.forEach((p, i) => this.stmt.insertParam.run(id, i, p.name, JSON.stringify(p)));
      return this.stmt.getTable.get(name);
    });
    return tx();
  }

  /**
   * The parameters the table was initialised with, as Parameters.parameter entries.
   */
  getParams(tableId) {
    return this.stmt.getParams.all(tableId).map(r => JSON.parse(r.value));
  }

  /**
   * @returns {Array<{id, system, code, display}>}
   */
  getConcepts(tableId) {
    return this.stmt.getConcepts.all(tableId);
  }

  touch(tableId) {
    this.stmt.touchTable.run(new Date().toISOString(), tableId);
  }

  /**
   * Record the outcome of an add, all at once: the new concepts, the new entries, and the
   * table's new version. Nothing is written unless everything is.
   *
   * @param {Object} table - the table row (id, version)
   * @param {Array<{key, system, code, display}>} concepts - new concepts; key identifies
   *   the concept in the entries below
   * @param {Array<{source, target, relationship}>} entries - source/target are either the
   *   id of an existing concept (number) or the key of a new one (string)
   * @returns {number} the table's version after the add
   */
  recordAdd(table, concepts, entries) {
    if (concepts.length === 0) {
      this.touch(table.id);
      return table.version;
    }
    const version = table.version + 1;
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      const ids = new Map();
      for (const c of concepts) {
        const info = this.stmt.insertConcept.run(table.id, c.system, c.code, c.display || null, version);
        ids.set(c.key, info.lastInsertRowid);
      }
      const id = ref => (typeof ref === 'string' ? ids.get(ref) : ref);
      for (const e of entries) {
        this.stmt.insertEntry.run(table.id, id(e.source), id(e.target), e.relationship, version);
      }
      this.stmt.setVersion.run(version, now, table.id);
    });
    tx();
    return version;
  }

  /**
   * Every entry added after the given version.
   * @returns {Array<{source_system, source_code, source_display, target_system, target_code, target_display, relationship}>}
   */
  entriesSince(tableId, version) {
    return this.stmt.entriesSince.all(tableId, version);
  }

  /**
   * Drop tables that nobody has used for the given number of days. Each table is dropped
   * under its lock (a table in use is not pulled out from under the call using it - it is
   * checked again once the lock is held), one at a time, yielding in between.
   * @returns {Promise<Array<string>>} the names dropped
   */
  async pruneUnused(days) {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const stale = this.stmt.staleTables.all(cutoff);
    const dropped = [];
    for (const t of stale) {
      await this.withLock(t.name, async () => {
        const now = this.db ? this.stmt.getTable.get(t.name) : null;
        if (now && now.id === t.id && now.last_used < cutoff) {
          this.stmt.deleteTable.run(t.id);
          dropped.push(t.name);
        }
      });
      await new Promise(resolve => setImmediate(resolve));
    }
    return dropped;
  }
}

module.exports = { ClosureStore, NARROWER, EQUIVALENT };
