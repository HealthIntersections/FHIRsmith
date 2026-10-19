//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * SQLite storage for the /ips module: projects, their managers, the users, and the IPS
 * documents in each project, with the search index over them.
 *
 * A document is kept whole, as the JSON that was stored (with the server's id and
 * meta.lastUpdated), alongside a few columns the list page shows and the status of its
 * processing. Document ids are one serial across the whole database, so an id names
 * one document whichever project it is asked for in. The submitter's IP address is
 * recorded for tracing abuse, and is never returned by anything in this module.
 *
 * @module ips/store
 */

const Database = require('better-sqlite3');
const { indexDocument, parseSearch, compositionOf, patientOf, identifierClause } = require('./search');

// the most document JSON one search page carries
const MAX_PAGE_BYTES = 32 * 1024 * 1024;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS projects (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    code         TEXT UNIQUE NOT NULL,
    name         TEXT NOT NULL,
    description  TEXT,
    -- the token submissions must carry (the web form, or an Authorization header). The
    -- project's managers need to read it back to hand it out, so it is not hashed
    token        TEXT,
    created      TEXT NOT NULL
  );

  -- the people who can manage projects. The administrator is not in here: their login is
  -- in the configuration
  CREATE TABLE IF NOT EXISTS users (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    login          TEXT UNIQUE NOT NULL,
    name           TEXT NOT NULL,
    password_hash  TEXT NOT NULL,
    created        TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS project_managers (
    project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (project_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS documents (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    received        TEXT NOT NULL,      -- meta.lastUpdated
    received_ms     INTEGER NOT NULL,
    ip              TEXT,               -- never shared
    source          TEXT NOT NULL,      -- 'api' or 'form'
    status          TEXT NOT NULL,      -- submitted | processing | processed | error
    status_message  TEXT,
    processed_ms    INTEGER,
    size            INTEGER NOT NULL,
    -- for the list page
    patient_name    TEXT,
    patient_gender  TEXT,
    patient_birth   TEXT,
    comp_date       TEXT,
    comp_title      TEXT,
    json            TEXT NOT NULL,
    -- the analysed copy: the document as the processing steps adorned it (pipeline.js)
    analysed_json   TEXT
  );

  -- what each processing step made of a document (see pipeline.js): one row per step
  CREATE TABLE IF NOT EXISTS document_results (
    doc_id    INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    step      TEXT NOT NULL,
    made_ms   INTEGER NOT NULL,
    json      TEXT NOT NULL,
    PRIMARY KEY (doc_id, step)
  );

  CREATE TABLE IF NOT EXISTS ips_index (
    doc_id   INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    res      TEXT NOT NULL,     -- Bundle | Composition | Patient
    param    TEXT NOT NULL,
    type     TEXT NOT NULL,
    str      TEXT,
    str_lc   TEXT,
    sys      TEXT,
    code     TEXT,
    lo       INTEGER,
    hi       INTEGER,
    ref      TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_id, id);
  CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status, id);
  CREATE INDEX IF NOT EXISTS idx_ips_index_doc ON ips_index(doc_id, res, param);
  CREATE INDEX IF NOT EXISTS idx_ips_index_str ON ips_index(res, param, str_lc);
  CREATE INDEX IF NOT EXISTS idx_ips_index_code ON ips_index(res, param, code);
  CREATE INDEX IF NOT EXISTS idx_ips_index_date ON ips_index(res, param, lo);
  CREATE INDEX IF NOT EXISTS idx_ips_index_ref ON ips_index(res, param, ref);
  CREATE INDEX IF NOT EXISTS idx_project_managers_user ON project_managers(user_id);
`;

function str(v, max = 200) {
  return typeof v === 'string' && v !== '' ? v.substring(0, max) : null;
}

/** A HumanName as text: its text, or prefix given family suffix. */
function nameText(n) {
  if (!n || typeof n !== 'object') {
    return null;
  }
  if (typeof n.text === 'string' && n.text.trim()) {
    return n.text.trim();
  }
  const parts = [].concat(n.prefix || [], n.given || [], n.family || [], n.suffix || []).filter(s => typeof s === 'string' && s);
  return parts.length ? parts.join(' ') : null;
}

/** What the list page shows for a document. */
function summaryOf(bundle) {
  const comp = compositionOf(bundle);
  const patient = patientOf(bundle, comp);
  const names = Array.isArray(patient?.name) ? patient.name : [];
  // the official or usual name first, if there is one
  const best = names.find(n => n?.use === 'official') || names.find(n => n?.use === 'usual') || names.find(n => n?.use !== 'old') || names[0];
  return {
    patient_name: str(nameText(best)),
    patient_gender: str(patient?.gender, 20),
    patient_birth: str(patient?.birthDate, 20),
    comp_date: str(comp?.date, 40),
    comp_title: str(comp?.title, 300)
  };
}

class IpsStore {
  /**
   * @param {string} dbPath - file name, or ':memory:'
   */
  constructor(dbPath) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
    this.migrate();
    this.stmts = {
      insertDoc: this.db.prepare(`
        INSERT INTO documents (project_id, received, received_ms, ip, source, status, size,
          patient_name, patient_gender, patient_birth, comp_date, comp_title, json)
        VALUES (@project_id, @received, @received_ms, @ip, @source, 'submitted', @size,
          @patient_name, @patient_gender, @patient_birth, @comp_date, @comp_title, @json)`),
      setJson: this.db.prepare('UPDATE documents SET json = ? WHERE id = ?'),
      insertIndex: this.db.prepare(`
        INSERT INTO ips_index (doc_id, res, param, type, str, str_lc, sys, code, lo, hi, ref)
        VALUES (@doc_id, @res, @param, @type, @str, @str_lc, @sys, @code, @lo, @hi, @ref)`),
      readDoc: this.db.prepare('SELECT id, project_id, received, received_ms, source, status, status_message, processed_ms, size, patient_name, patient_gender, patient_birth, comp_date, comp_title, json, analysed_json FROM documents WHERE id = ?'),
      saveAnalysed: this.db.prepare('UPDATE documents SET analysed_json = ? WHERE id = ?'),
      deleteDoc: this.db.prepare('DELETE FROM documents WHERE id = ? AND project_id = ?'),
      countDocs: this.db.prepare('SELECT COUNT(*) AS n FROM documents WHERE project_id = ?'),
      countAll: this.db.prepare('SELECT COUNT(*) AS n FROM documents'),
      nextSubmitted: this.db.prepare("SELECT id FROM documents WHERE status = 'submitted' ORDER BY id LIMIT 1"),
      claim: this.db.prepare("UPDATE documents SET status = 'processing', status_message = NULL WHERE id = ? AND status = 'submitted'"),
      finish: this.db.prepare('UPDATE documents SET status = ?, status_message = ?, processed_ms = ? WHERE id = ?'),
      requeue: this.db.prepare("UPDATE documents SET status = 'submitted', status_message = NULL, processed_ms = NULL, analysed_json = NULL WHERE id = ? AND project_id = ?"),
      saveResult: this.db.prepare('INSERT OR REPLACE INTO document_results (doc_id, step, made_ms, json) VALUES (?, ?, ?, ?)'),
      readResult: this.db.prepare('SELECT made_ms, json FROM document_results WHERE doc_id = ? AND step = ?'),
      resultSteps: this.db.prepare('SELECT step, made_ms FROM document_results WHERE doc_id = ? ORDER BY step'),
      clearResults: this.db.prepare('DELETE FROM document_results WHERE doc_id = ?'),
      resetProcessing: this.db.prepare("UPDATE documents SET status = 'submitted' WHERE status = 'processing'")
    };
  }

  /** Bring a database made by an earlier version of the module up to date. */
  migrate() {
    const has = (table, col) => this.db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
    if (!has('documents', 'analysed_json')) {
      this.db.exec('ALTER TABLE documents ADD COLUMN analysed_json TEXT');
    }
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  // ---- projects ----

  /** All projects, with their document counts and managers; by name. */
  projects() {
    const rows = this.db.prepare(`
      SELECT p.id, p.code, p.name, p.description, p.created,
        (SELECT COUNT(*) FROM documents d WHERE d.project_id = p.id) AS documents
      FROM projects p ORDER BY p.name COLLATE NOCASE, p.code`).all();
    const managers = this.db.prepare(`
      SELECT pm.project_id, u.id, u.login, u.name FROM project_managers pm JOIN users u ON u.id = pm.user_id ORDER BY u.login`).all();
    const byProject = new Map();
    for (const m of managers) {
      if (!byProject.has(m.project_id)) {
        byProject.set(m.project_id, []);
      }
      byProject.get(m.project_id).push({ id: m.id, login: m.login, name: m.name });
    }
    for (const p of rows) {
      p.managers = byProject.get(p.id) || [];
    }
    return rows;
  }

  /** @returns {Object|null} the project, including its token */
  projectByCode(code) {
    return this.db.prepare('SELECT * FROM projects WHERE code = ?').get(code) || null;
  }

  projectById(id) {
    return this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) || null;
  }

  createProject(code, name, description) {
    const r = this.db.prepare('INSERT INTO projects (code, name, description, created) VALUES (?, ?, ?, ?)')
      .run(code, name, description || null, new Date().toISOString());
    return Number(r.lastInsertRowid);
  }

  updateProject(id, name, description) {
    return this.db.prepare('UPDATE projects SET name = ?, description = ? WHERE id = ?').run(name, description || null, id).changes > 0;
  }

  /** Set (or, with null, clear) the token submissions to the project must carry. */
  setProjectToken(id, token) {
    return this.db.prepare('UPDATE projects SET token = ? WHERE id = ?').run(token || null, id).changes > 0;
  }

  /** Delete a project and everything in it. @returns {boolean} whether there was one */
  deleteProject(id) {
    return this.db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes > 0;
  }

  /** Replace the set of users who manage a project. */
  setProjectManagers(projectId, userIds) {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM project_managers WHERE project_id = ?').run(projectId);
      const ins = this.db.prepare('INSERT OR IGNORE INTO project_managers (project_id, user_id) VALUES (?, ?)');
      for (const u of userIds) {
        ins.run(projectId, u);
      }
    })();
  }

  /** The ids of the projects a user manages. */
  managedProjectIds(userId) {
    return this.db.prepare('SELECT project_id FROM project_managers WHERE user_id = ?').all(userId).map(r => r.project_id);
  }

  // ---- users ----

  /** @returns {Array} users, without their password hashes, with the codes of the projects they manage */
  users() {
    const rows = this.db.prepare('SELECT id, login, name, created FROM users ORDER BY login').all();
    const pm = this.db.prepare('SELECT pm.user_id, p.code FROM project_managers pm JOIN projects p ON p.id = pm.project_id ORDER BY p.code').all();
    const by = new Map();
    for (const m of pm) {
      if (!by.has(m.user_id)) {
        by.set(m.user_id, []);
      }
      by.get(m.user_id).push(m.code);
    }
    for (const u of rows) {
      u.projects = by.get(u.id) || [];
    }
    return rows;
  }

  /** @returns {Object|null} the user, including the password hash */
  userByLogin(login) {
    return this.db.prepare('SELECT * FROM users WHERE login = ?').get(login) || null;
  }

  userById(id) {
    return this.db.prepare('SELECT id, login, name FROM users WHERE id = ?').get(id) || null;
  }

  createUser(login, name, passwordHash) {
    const r = this.db.prepare('INSERT INTO users (login, name, password_hash, created) VALUES (?, ?, ?, ?)')
      .run(login, name, passwordHash, new Date().toISOString());
    return Number(r.lastInsertRowid);
  }

  updateUser(id, name, passwordHash) {
    const n = this.db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, id).changes;
    if (n > 0 && passwordHash) {
      this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, id);
    }
    return n > 0;
  }

  deleteUser(id) {
    return this.db.prepare('DELETE FROM users WHERE id = ?').run(id).changes > 0;
  }

  // ---- documents ----

  /**
   * Store a document that has already been validated. The bundle gets its id (the
   * serial the database assigns) and meta.lastUpdated here, and is indexed.
   *
   * @param {number} projectId
   * @param {Object} bundle - the document; changed in place (id, meta.lastUpdated)
   * @param {{ip?: string, source: string, receivedMs: number}} info
   * @returns {number} the document's id
   */
  insert(projectId, bundle, info) {
    const received = new Date(info.receivedMs).toISOString();
    bundle.meta = { ...(bundle.meta || {}), lastUpdated: received };
    delete bundle.meta.versionId;
    return this.db.transaction(() => {
      // the id is the serial, so the row is inserted first, then the JSON is written with it
      const r = this.stmts.insertDoc.run({
        project_id: projectId, received, received_ms: info.receivedMs, ip: info.ip || null,
        source: info.source, size: 0, ...summaryOf(bundle), json: '{}'
      });
      const id = Number(r.lastInsertRowid);
      // id first in the JSON, as it is in the spec's examples
      const stored = { resourceType: 'Bundle', id: String(id), meta: bundle.meta };
      for (const [k, v] of Object.entries(bundle)) {
        if (!(k in stored)) {
          stored[k] = v;
        }
      }
      const json = JSON.stringify(stored);
      this.db.prepare('UPDATE documents SET json = ?, size = ? WHERE id = ?').run(json, Buffer.byteLength(json, 'utf8'), id);
      for (const row of indexDocument(stored)) {
        this.stmts.insertIndex.run({ doc_id: id, ...row });
      }
      // give the caller what was stored
      for (const k of Object.keys(bundle)) {
        delete bundle[k];
      }
      Object.assign(bundle, stored);
      return id;
    })();
  }

  /**
   * @param {number} id
   * @param {number} [projectId] - if given, the document must be in this project
   * @returns {Object|null} the row, with the bundle parsed as .bundle
   */
  read(id, projectId) {
    if (!Number.isInteger(id)) {
      return null;
    }
    const row = this.stmts.readDoc.get(id);
    if (!row || (projectId !== undefined && row.project_id !== projectId)) {
      return null;
    }
    row.bundle = JSON.parse(row.json);
    delete row.json;
    row.analysed = row.analysed_json ? JSON.parse(row.analysed_json) : null;
    delete row.analysed_json;
    return row;
  }

  /** Keep the analysed copy of a document (null to drop it). */
  saveAnalysed(id, bundle) {
    this.stmts.saveAnalysed.run(bundle ? JSON.stringify(bundle) : null, id);
  }

  /** @returns {boolean} whether there was such a document in the project */
  delete(id, projectId) {
    return Number.isInteger(id) && this.stmts.deleteDoc.run(id, projectId).changes > 0;
  }

  count(projectId) {
    return projectId === undefined ? this.stmts.countAll.get().n : this.stmts.countDocs.get(projectId).n;
  }

  /**
   * Run a parsed search (see search.js) over a project's documents.
   *
   * @param {number} projectId
   * @param {Object} search - from parseSearch
   * @param {{withJson?: boolean, identifier?: string}} options - include the stored JSON
   *   (FHIR API), or just the columns the HTML list needs; identifier is the web
   *   filter's partial match on the id or patient identifiers
   * @returns {{total: number, rows: Object[], truncated: boolean}} truncated: the page was
   *   cut short of _count by the byte budget (the next page starts at offset + rows.length)
   */
  search(projectId, search, options = {}) {
    const where = ['d.project_id = ?', ...search.where];
    const args = [projectId, ...search.args];
    const idc = identifierClause(options.identifier);
    if (idc) {
      where.push(idc.sql);
      args.push(...idc.args);
    }
    const w = 'WHERE ' + where.join(' AND ');
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM documents d ${w}`).get(...args).n;
    if (search.summaryCount || search.count === 0) {
      return { total, rows: [] };
    }
    if (!options.withJson) {
      const cols = 'd.id, d.received, d.source, d.status, d.status_message, d.size, d.patient_name, d.patient_gender, d.patient_birth, d.comp_date, d.comp_title';
      const rows = this.db.prepare(`SELECT ${cols} FROM documents d ${w} ORDER BY ${search.orderBy} LIMIT ? OFFSET ?`)
        .all(...args, ...search.orderArgs, search.count, search.offset);
      return { total, rows, truncated: false };
    }
    // the documents themselves: a page is cut short once it holds MAX_PAGE_BYTES of them (but
    // always at least one), so that _count=500 of 10MB documents is not a 5GB response
    const ids = this.db.prepare(`SELECT d.id, d.size FROM documents d ${w} ORDER BY ${search.orderBy} LIMIT ? OFFSET ?`)
      .all(...args, ...search.orderArgs, search.count, search.offset);
    const keep = [];
    let bytes = 0;
    for (const r of ids) {
      if (keep.length > 0 && bytes + r.size > MAX_PAGE_BYTES) {
        break;
      }
      keep.push(r.id);
      bytes += r.size;
    }
    const rows = keep.map(id => this.db.prepare('SELECT id, received, json FROM documents WHERE id = ?').get(id));
    return { total, rows, truncated: keep.length < ids.length };
  }

  /** The documents of a project the list page shows, all of them, newest first. */
  list(projectId) {
    return this.search(projectId, parseSearch({ _count: String(1000) })).rows;
  }

  // ---- the processing queue ----

  /**
   * Take the oldest submitted document for processing, marking it 'processing'.
   * @returns {Object|null} the row (as read()) or null if nothing is waiting
   */
  claimNext() {
    return this.db.transaction(() => {
      const next = this.stmts.nextSubmitted.get();
      if (!next || this.stmts.claim.run(next.id).changes === 0) {
        return null;
      }
      return this.read(next.id);
    })();
  }

  /** Record the outcome of processing a document. */
  finish(id, ok, message) {
    this.stmts.finish.run(ok ? 'processed' : 'error', message || null, Date.now(), id);
  }

  /** Put a document back in the queue. @returns {boolean} whether there was one */
  requeue(id, projectId) {
    return Number.isInteger(id) && this.stmts.requeue.run(id, projectId).changes > 0;
  }

  // ---- the processing steps' results ----

  /** Keep what a step made of a document, replacing any earlier run's. */
  saveResult(docId, step, result) {
    this.stmts.saveResult.run(docId, step, Date.now(), JSON.stringify(result));
  }

  /** @returns {{made: string, result: Object}|null} what a step made of a document */
  readResult(docId, step) {
    const row = this.stmts.readResult.get(docId, step);
    return row ? { made: new Date(row.made_ms).toISOString(), result: JSON.parse(row.json) } : null;
  }

  /** The steps that have results for a document. */
  resultSteps(docId) {
    return this.stmts.resultSteps.all(docId).map(r => r.step);
  }

  /**
   * Anything left 'processing' was being worked on when the server stopped; it goes back
   * in the queue. Called at startup. @returns {number} how many
   */
  resetProcessing() {
    return this.stmts.resetProcessing.run().changes;
  }

  /** How many documents are in each state, for the dashboard. */
  statusCounts(projectId) {
    const rows = projectId === undefined
      ? this.db.prepare('SELECT status, COUNT(*) AS n FROM documents GROUP BY status').all()
      : this.db.prepare('SELECT status, COUNT(*) AS n FROM documents WHERE project_id = ? GROUP BY status').all(projectId);
    const out = {};
    for (const r of rows) {
      out[r.status] = r.n;
    }
    return out;
  }
}

module.exports = { IpsStore, summaryOf, nameText, MAX_PAGE_BYTES };
