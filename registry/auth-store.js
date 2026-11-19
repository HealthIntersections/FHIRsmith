// registry/auth-store.js
// The registry's documents, and the requests made by each user and OIDC client, in SQLite
// (better-sqlite3: synchronous, like stats-db.js). Usage is counted per principal - a user of
// the server (user:{id}), or an OIDC client - and flushed in batches.
//
// The users and tokens tables are from before users and tokens were the server's
// (library/auth): no longer used, and kept so a database from before still opens.

const Database = require('better-sqlite3');

class AuthStore {
  /**
   * @param {string} dbPath file path, or ':memory:'
   */
  constructor(dbPath) {
    this.db = new Database(dbPath);
    if (dbPath !== ':memory:') {
      this.db.pragma('journal_mode = WAL');
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        login TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        password_hash TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        prefix TEXT NOT NULL,
        hash TEXT UNIQUE NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        expires_at TEXT,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS tokens_user ON tokens(user_id);
      CREATE TABLE IF NOT EXISTS usage (
        principal TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        requests INTEGER NOT NULL DEFAULT 0,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        type TEXT NOT NULL,
        public INTEGER NOT NULL DEFAULT 0,
        content TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS document_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        doc_id INTEGER NOT NULL,
        action TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        public INTEGER NOT NULL,
        content TEXT NOT NULL,
        at TEXT NOT NULL,
        by TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS document_log_doc ON document_log(doc_id);
    `);
    // added after the first release of the table
    if (!this.db.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = 'admin'").get()) {
      this.db.exec('ALTER TABLE users ADD COLUMN admin INTEGER NOT NULL DEFAULT 0');
    }
    this.db.pragma('foreign_keys = ON');
    this.pending = new Map(); // principal -> { kind, count, last }
    this.stmts = {
      usage: this.db.prepare('SELECT * FROM usage WHERE principal = ?'),
      allUsage: this.db.prepare('SELECT * FROM usage ORDER BY last_seen DESC'),
      upsertUsage: this.db.prepare(`INSERT INTO usage (principal, kind, requests, first_seen, last_seen) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(principal) DO UPDATE SET requests = requests + excluded.requests, last_seen = excluded.last_seen`),
      documents: this.db.prepare('SELECT id, name, type, public, updated_at, updated_by, length(content) AS size FROM documents ORDER BY name'),
      documentByName: this.db.prepare('SELECT * FROM documents WHERE name = ?'),
      documentById: this.db.prepare('SELECT * FROM documents WHERE id = ?'),
      insertDocument: this.db.prepare('INSERT INTO documents (name, type, public, content, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)'),
      updateDocument: this.db.prepare('UPDATE documents SET name = ?, type = ?, public = ?, content = ?, updated_at = ?, updated_by = ? WHERE id = ?'),
      deleteDocument: this.db.prepare('DELETE FROM documents WHERE id = ?'),
      logDocument: this.db.prepare('INSERT INTO document_log (doc_id, action, name, type, public, content, at, by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
      documentLog: this.db.prepare('SELECT id, action, name, type, public, at, by, length(content) AS size FROM document_log WHERE doc_id = ? ORDER BY id DESC'),
      documentLogEntry: this.db.prepare('SELECT * FROM document_log WHERE id = ? AND doc_id = ?')
    };
  }

  // ---- usage ----

  /**
   * Count a request by a principal. Counts are kept in memory and written by flush()
   * @param {string} principal e.g. token:12, api-token, oidc:{iss}|{sub}
   * @param {string} kind token | api-token | oidc
   */
  countRequest(principal, kind, now = Date.now()) {
    const p = this.pending.get(principal);
    if (p) {
      p.count++;
      p.last = now;
    } else {
      this.pending.set(principal, { kind, count: 1, last: now });
    }
  }

  flush() {
    if (this.pending.size === 0) {
      return 0;
    }
    const entries = [...this.pending.entries()];
    const write = this.db.transaction(() => {
      for (const [principal, p] of entries) {
        const at = new Date(p.last).toISOString();
        this.stmts.upsertUsage.run(principal, p.kind, p.count, at, at);
      }
    });
    // a transaction: all written, or none, and then the counts are still pending for the next try
    write();
    // what was written is taken off; counts that came in meanwhile stay
    for (const [principal, p] of entries) {
      if (this.pending.get(principal) === p) {
        this.pending.delete(principal);
      }
    }
    return entries.length;
  }

  usageOf(principal) {
    const row = this.stmts.usage.get(principal);
    const p = this.pending.get(principal);
    if (!row && !p) {
      return null;
    }
    return {
      requests: (row ? row.requests : 0) + (p ? p.count : 0),
      firstSeen: row ? row.first_seen : new Date(p.last).toISOString(),
      lastSeen: p ? new Date(p.last).toISOString() : row.last_seen
    };
  }

  /** Every principal's usage, most recent first */
  allUsage() {
    this.flush();
    return this.stmts.allUsage.all();
  }

  // ---- documents ----

  _document(row) {
    return row ? { ...row, public: !!row.public } : null;
  }

  /** The documents' metadata (no content), by name */
  documents() {
    return this.stmts.documents.all().map(d => this._document(d));
  }

  documentByName(name) {
    return this._document(this.stmts.documentByName.get(name));
  }

  documentById(id) {
    return this._document(this.stmts.documentById.get(id));
  }

  /**
   * Create a document; every change is also written to the log
   * @returns {number} the document's id
   * @throws if the name is taken
   */
  createDocument({ name, type, public: isPublic = false, content }, by, now = new Date()) {
    const at = now.toISOString();
    return this.db.transaction(() => {
      const r = this.stmts.insertDocument.run(name, type, isPublic ? 1 : 0, content, at, by);
      const id = Number(r.lastInsertRowid);
      this.stmts.logDocument.run(id, 'created', name, type, isPublic ? 1 : 0, content, at, by);
      return id;
    })();
  }

  updateDocument(id, { name, type, public: isPublic, content }, by, now = new Date()) {
    const d = this.stmts.documentById.get(id);
    if (!d) {
      return false;
    }
    const at = now.toISOString();
    const next = {
      name: name ?? d.name, type: type ?? d.type,
      public: (isPublic ?? !!d.public) ? 1 : 0, content: content ?? d.content
    };
    this.db.transaction(() => {
      this.stmts.updateDocument.run(next.name, next.type, next.public, next.content, at, by, id);
      this.stmts.logDocument.run(id, next.name !== d.name ? 'renamed' : 'edited', next.name, next.type, next.public, next.content, at, by);
    })();
    return true;
  }

  deleteDocument(id, by, now = new Date()) {
    const d = this.stmts.documentById.get(id);
    if (!d) {
      return false;
    }
    this.db.transaction(() => {
      this.stmts.logDocument.run(id, 'deleted', d.name, d.type, d.public, d.content, now.toISOString(), by);
      this.stmts.deleteDocument.run(id);
    })();
    return true;
  }

  /** A document's log, newest first, without the content */
  documentLog(docId) {
    return this.stmts.documentLog.all(docId).map(e => ({ ...e, public: !!e.public }));
  }

  /** One log entry, with the content as it was */
  documentLogEntry(docId, entryId) {
    const e = this.stmts.documentLogEntry.get(entryId, docId);
    return e ? { ...e, public: !!e.public } : null;
  }

  close() {
    try {
      this.flush();
    } finally {
      this.db.close();
    }
  }
}

module.exports = { AuthStore };
