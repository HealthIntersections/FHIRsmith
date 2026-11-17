//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * Reports: tables of data drawn from every document in every project by a SQL on FHIR
 * ViewDefinition, and SQL statements that summarise them.
 *
 * The administrator defines each report: a title, what the view runs over (the source), the
 * ViewDefinition, and zero or more named SQL statements. The source is one of
 *   uploaded     each document as it was submitted
 *   transformed  each document as the pipeline left it (the modified copy: translations, generated narrative)
 *   outcomes     the validation step's OperationOutcome for each document
 * A report over the documents is a view of Bundle - the document - which it walks to what it
 * wants (entry.resource.ofType(Condition), say), with references resolved inside the document;
 * a report over the outcomes is a view of OperationOutcome.
 *
 * Where things are kept:
 *   - the definitions in the IPS database (store.js: reports)
 *   - the tables in a database of their own (modules.ips.reports.database, default
 *     ips-reports.db beside the IPS database): one table per report, named after the view,
 *     holding the rows of every project, each row marked with its _project and _document
 *     (which a view's own columns can't be called: SQL names start with a letter). Rebuilding
 *     a table, or a statement gone wrong, can't touch anything else
 *   - in that database, _builds (where each report's table build is up to) and _errors (the
 *     documents a view failed on, and why)
 *
 * When a report's view or source changes (or a report is new), its table is rebuilt in the
 * background: a new table, _build_{name}, is filled from every document the pipeline has
 * finished with, a few at a time between the processing queue's documents, and then swapped
 * in for the old one, which is shown meanwhile. When the pipeline processes a document, its
 * last step (pipeline.js: reports) deletes the document's rows from every table and runs it
 * through every report again - into the live table, and into a table being built if the build
 * has got past the document already. Deleting a document or a project deletes its rows.
 *
 * Statements are run per project (reports-query.js), in a child process with a time limit.
 *
 * The ViewDefinitions are R4: the documents are R4. A view is checked by the FHIR validator
 * (with the SQL on FHIR IG loaded) before it is accepted, and again here for what the runner
 * needs: a name, and a type on every column.
 *
 * @module ips/reports
 */

const path = require('path');
const { fork } = require('child_process');
const Database = require('better-sqlite3');
const r4 = require('fhirpath/fhir-context/r4');
const { Runner, MemoryProvider, SqliteStorage, prepareView, ViewDefinitionError, defaultResourceKey } = require('../library/sql');
const { runRequest, quote } = require('./reports-query');

const SOURCES = {
  uploaded: 'The documents as submitted',
  transformed: 'The documents as processed (the modified copy)',
  outcomes: 'The validation outcomes'
};

const FIXED_COLUMNS = [{ name: '_project', type: 'INTEGER' }, { name: '_document', type: 'INTEGER' }];
const SQL_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const R4_VERSION = '4.0.1';
// the SQL on FHIR IG's ViewDefinition (a logical model)
const VIEW_DEFINITION_PROFILE = 'https://sql-on-fhir.org/ig/StructureDefinition/ViewDefinition';
// documents read per database round trip while building
const BUILD_BATCH = 20;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS _builds (
    report_id    TEXT PRIMARY KEY,
    generation   INTEGER NOT NULL,   -- the report's generation the table is (being) built for
    state        TEXT NOT NULL,      -- pending | building | ready
    cursor       INTEGER NOT NULL,   -- building: the last document id done
    docs         INTEGER NOT NULL,   -- building: how many documents done
    started_ms   INTEGER,
    finished_ms  INTEGER
  );
  CREATE TABLE IF NOT EXISTS _errors (
    report_id    TEXT NOT NULL,
    generation   INTEGER NOT NULL,
    doc_id       INTEGER NOT NULL,
    project_id   INTEGER NOT NULL,
    message      TEXT NOT NULL,
    at_ms        INTEGER NOT NULL,
    PRIMARY KEY (report_id, generation, doc_id)
  );
`;

class Reports {
  /**
   * @param {Object} options
   * @param {Object} options.store - the IpsStore
   * @param {string} options.dbPath - the reports database (file, or ':memory:')
   * @param {Object} options.log
   * @param {Object} [options.config] - modules.ips.reports
   */
  constructor({ store, dbPath, log, config = {} }) {
    this.store = store;
    this.log = log;
    this.dbPath = dbPath;
    this.db = new Database(dbPath);
    if (dbPath !== ':memory:') {
      this.db.pragma('journal_mode = WAL');
    }
    this.db.exec(SCHEMA);
    this.timeoutMs = (config.queryTimeoutSeconds > 0 ? config.queryTimeoutSeconds : 10) * 1000;
    this.maxRows = config.maxRows > 0 ? config.maxRows : 1000;
    this.csvMaxRows = config.csvMaxRows > 0 ? config.csvMaxRows : 100000;
    this.profile = typeof config.profile === 'string' && config.profile ? config.profile : VIEW_DEFINITION_PROFILE;
    // per report table: the runner and work context that write to it, for the report's generation
    this.targets = new Map();
    // the document being run through the views, for the keys (keyFor)
    this.current = null;
    this.syncBuilds();
  }

  close() {
    this.db.close();
  }

  // ---- definitions --------------------------------------------------------------------

  /** The reports, with where each table is up to (state()). */
  list() {
    return this.store.reports().map(r => ({ ...r, build: this.state(r) }));
  }

  get(id) {
    const r = this.store.report(id);
    return r ? { ...r, build: this.state(r) } : null;
  }

  count() {
    return this.store.reports().length;
  }

  /**
   * Where a report's table is: ready (built for the current definition), building (with how far
   * it has got), or pending (waiting to start); and whether there is an older table to show meanwhile.
   */
  state(report) {
    const b = this.db.prepare('SELECT * FROM _builds WHERE report_id = ?').get(report.id);
    const live = this.tableExists(report.id);
    if (!b || b.generation !== report.generation) {
      return { state: 'pending', live, docs: 0, total: this.store.countReportDocuments() };
    }
    const errors = this.db.prepare('SELECT COUNT(*) AS n FROM _errors WHERE report_id = ? AND generation = ?').get(report.id, report.generation).n;
    return {
      state: b.state, live, docs: b.docs, total: b.state === 'ready' ? b.docs : this.store.countReportDocuments(),
      started: b.started_ms, finished: b.finished_ms, errors
    };
  }

  tableExists(name) {
    return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  }

  /**
   * Checks a report before it is saved. Returns the problems (strings); none means it can be
   * saved. The view is checked here for what the runner needs, then by the validator.
   *
   * @param {Object} def - {title, description, source, view (object), statements [{name, sql}]}
   * @param {Object|null} existing - the report being edited
   * @param {Object|null} validator - the FHIR validator (fhir-validator-wrapper), if running
   * @returns {Promise<string[]>}
   */
  async check(def, existing, validator) {
    const issues = [];
    if (!def.title || !def.title.trim()) {
      issues.push('A title is required');
    }
    if (!SOURCES[def.source]) {
      issues.push('Choose what the report runs over');
    }
    const view = def.view;
    if (!view || typeof view !== 'object' || Array.isArray(view)) {
      issues.push('The ViewDefinition must be a JSON object');
      return issues;
    }
    if (view.resourceType !== undefined && view.resourceType !== 'ViewDefinition') {
      issues.push(`The resource is a ${view.resourceType}, not a ViewDefinition`);
    }
    // the name is the table's
    if (typeof view.name !== 'string' || !SQL_NAME.test(view.name)) {
      issues.push('The ViewDefinition needs a name (a letter, then letters, digits and _): it names the report\'s table');
    } else if (/^sqlite_/i.test(view.name) || view.name.toLowerCase() === 'new') {
      issues.push(`'${view.name}' can't be a report's name`);
    } else if (existing && view.name !== existing.id) {
      issues.push(`The ViewDefinition's name can't be changed from '${existing.id}': it names the report's table. Make a new report instead`);
    } else if (!existing && this.store.reports().some(r => r.id.toLowerCase() === view.name.toLowerCase())) {
      issues.push(`There is already a report called '${view.name}'`);
    }
    // R4: the documents are R4
    if (view.fhirVersion === undefined) {
      view.fhirVersion = [R4_VERSION];
    } else if (!Array.isArray(view.fhirVersion) || !view.fhirVersion.includes(R4_VERSION)) {
      issues.push(`The ViewDefinition's fhirVersion must include ${R4_VERSION}: the documents are R4`);
    }
    let prepared = null;
    try {
      prepared = prepareView(view, { model: r4, needsName: true });
    } catch (e) {
      if (e instanceof ViewDefinitionError) {
        issues.push(...e.issues.map(i => `${i.path}: ${i.message}`));
      } else {
        issues.push(e.message);
      }
    }
    if (prepared) {
      const untyped = prepared.columns.filter(c => !c.type).map(c => c.name);
      if (untyped.length > 0) {
        issues.push(`Every column needs a type: ${untyped.join(', ')} ${untyped.length === 1 ? 'has' : 'have'} none`);
      }
      if (def.source === 'outcomes' && prepared.resourceName !== 'OperationOutcome') {
        issues.push(`A report on the validation outcomes is a view of OperationOutcome, not ${prepared.resourceName}`);
      }
      if (def.source !== 'outcomes' && prepared.resourceName !== 'Bundle') {
        issues.push(`A report on the documents is a view of Bundle (the document), not ${prepared.resourceName}: ` +
          `walk to what you want, e.g. "forEach": "entry.resource.ofType(${prepared.resourceName})"`);
      }
    }
    issues.push(...this.checkStatements(def.statements || [], prepared ? { id: view.name, columns: prepared.columns } : null));
    if (issues.length > 0) {
      return issues;
    }
    // last, because it is the slow part
    if (!validator || (typeof validator.isRunning === 'function' && !validator.isRunning())) {
      issues.push('The FHIR validator is not running, so the ViewDefinition can\'t be checked. Try again when it is');
      return issues;
    }
    try {
      const outcome = await validator.validate(JSON.stringify(view), { profiles: [this.profile] });
      for (const i of Array.isArray(outcome?.issue) ? outcome.issue : []) {
        if (i && (i.severity === 'error' || i.severity === 'fatal')) {
          const where = (i.expression || i.location || [])[0];
          issues.push((where ? `${where}: ` : '') + (i.details?.text || i.diagnostics || i.code));
        }
      }
    } catch (e) {
      issues.push(`The validator could not check the ViewDefinition: ${e.message}`);
    }
    return issues;
  }

  /**
   * Each statement needs a name (unique in the report) and must read: it is prepared against
   * every report's table, this one as it is about to be, in a scratch database.
   */
  checkStatements(statements, self) {
    const issues = [];
    const names = new Set();
    const scratch = new Database(':memory:');
    try {
      const tables = this.store.reports().filter(r => !self || r.id !== self.id).map(r => {
        try {
          return { id: r.id, columns: prepareView(r.view, { model: r4 }).columns };
        } catch (e) {
          return null;
        }
      }).filter(Boolean);
      if (self) {
        tables.push(self);
      }
      for (const t of tables) {
        scratch.exec(SqliteStorage.createTableSql(t.id, t.columns, FIXED_COLUMNS));
      }
      for (const s of statements) {
        const label = s.name ? `Statement '${s.name}'` : 'A statement';
        if (!s.name || !s.name.trim()) {
          issues.push('Each statement needs a name');
        } else if (names.has(s.name.toLowerCase())) {
          issues.push(`There are two statements called '${s.name}'`);
        }
        names.add((s.name || '').toLowerCase());
        if (!s.sql || !s.sql.trim()) {
          issues.push(`${label} has no SQL`);
          continue;
        }
        try {
          const stmt = scratch.prepare(s.sql);
          if (!stmt.reader) {
            issues.push(`${label} doesn't read: only SELECT statements can be used`);
          }
        } catch (e) {
          issues.push(`${label}: ${e.message}`);
        }
      }
    } finally {
      scratch.close();
    }
    return issues;
  }

  /**
   * Saves a checked report. A new view, or a changed view or source, means a new table: the
   * report's generation goes up and its table is rebuilt in the background.
   * @returns {boolean} whether the table is to be rebuilt
   */
  save(def, existing) {
    const id = def.view.name;
    const changed = !existing || existing.source !== def.source || canonical(existing.view) !== canonical(def.view);
    const generation = existing ? existing.generation + (changed ? 1 : 0) : 1;
    this.store.saveReport({ id, title: def.title.trim(), description: (def.description || '').trim() || null, source: def.source, view: def.view, statements: def.statements || [], generation });
    if (changed) {
      this.scheduleBuild(id, generation);
    }
    return changed;
  }

  delete(id) {
    this.forget(id);
    this.db.exec(`DROP TABLE IF EXISTS ${quote(id)}`);
    this.db.exec(`DROP TABLE IF EXISTS ${quote(buildTable(id))}`);
    this.db.prepare('DELETE FROM _builds WHERE report_id = ?').run(id);
    this.db.prepare('DELETE FROM _errors WHERE report_id = ?').run(id);
    return this.store.deleteReport(id);
  }

  scheduleBuild(id, generation) {
    this.forget(id);
    this.db.exec(`DROP TABLE IF EXISTS ${quote(buildTable(id))}`);
    this.db.prepare(`INSERT INTO _builds (report_id, generation, state, cursor, docs) VALUES (?, ?, 'pending', 0, 0)
      ON CONFLICT (report_id) DO UPDATE SET generation = excluded.generation, state = 'pending', cursor = 0, docs = 0, started_ms = NULL, finished_ms = NULL`).run(id, generation);
  }

  /**
   * At start up: a report whose table isn't built for its definition (or has gone - the reports
   * database was deleted, say) is built again, and tables of reports that no longer exist go.
   */
  syncBuilds() {
    const reports = this.store.reports();
    const ids = new Set(reports.map(r => r.id));
    for (const r of reports) {
      const b = this.db.prepare('SELECT * FROM _builds WHERE report_id = ?').get(r.id);
      if (!b || b.generation !== r.generation || (b.state === 'ready' && !this.tableExists(r.id))) {
        this.scheduleBuild(r.id, r.generation);
      }
    }
    for (const t of this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(x => x.name)) {
      if (t === '_builds' || t === '_errors' || t.startsWith('sqlite_')) {
        continue;
      }
      const id = t.startsWith('_build_') ? t.substring(7) : t;
      if (!ids.has(id)) {
        this.db.exec(`DROP TABLE IF EXISTS ${quote(t)}`);
      }
    }
    this.db.prepare(`DELETE FROM _builds WHERE report_id NOT IN (${reports.map(() => '?').join(', ') || "''"})`).run(...reports.map(r => r.id));
  }

  forget(id) {
    for (const key of [...this.targets.keys()]) {
      if (key.startsWith(id + '|')) {
        this.targets.delete(key);
      }
    }
  }

  // ---- running the views over a document -------------------------------------------------

  /**
   * What a report runs over in a document - the Bundle, or the validation outcome - and the
   * provider that resolves references inside it; null when the document doesn't have that
   * source (no validation outcome yet, or no processed copy).
   */
  sourceOf(report, doc) {
    if (report.source === 'outcomes') {
      if (!doc.outcome) {
        return null;
      }
      return { resources: [doc.outcome], provider: new MemoryProvider().add(doc.outcome) };
    }
    const bundle = report.source === 'transformed' ? doc.analysed : doc.bundle;
    if (!bundle || bundle.resourceType !== 'Bundle') {
      return null;
    }
    // the entries are added so references between them resolve, and resources with no id
    // can be keyed by their fullUrl; only the Bundle goes through the view
    return { resources: [bundle], provider: new MemoryProvider().addBundle(bundle) };
  }

  /**
   * The keys getResourceKey() and getReferenceKey() give: scoped to the document, since the same
   * Patient/123 turns up in many documents. A resource with no id is keyed by its entry's
   * fullUrl, or by its type (the outcome).
   */
  keyFor(resource, root) {
    const c = this.current;
    if (!c || !resource || !resource.resourceType) {
      return null;
    }
    const base = defaultResourceKey(resource, root) || c.provider.fullUrlOf(resource) || resource.resourceType;
    return `${c.docId}/${base}`;
  }

  /** The runner, and its work context, that write a report's rows into a table. */
  target(report, table) {
    const key = `${report.id}|${report.generation}|${table}`;
    let t = this.targets.get(key);
    if (!t) {
      const storage = new SqliteStorage(this.db, {
        table, fixedColumns: FIXED_COLUMNS, create: false, transaction: false,
        keyFor: (res, root) => this.keyFor(res, root)
      });
      const runner = new Runner({ model: r4, storage });
      t = { storage, runner, wc: runner.prepare(report.view) };
      this.targets.set(key, t);
    }
    return t;
  }

  /** The tables a document's rows go in for a report: the live one when it is current, and one being built that has got past the document. */
  tablesFor(report, docId) {
    const b = this.db.prepare('SELECT * FROM _builds WHERE report_id = ?').get(report.id);
    if (!b || b.generation !== report.generation) {
      return [];
    }
    if (b.state === 'ready') {
      return this.tableExists(report.id) ? [report.id] : [];
    }
    if (b.state === 'building' && docId <= b.cursor && this.tableExists(buildTable(report.id))) {
      return [buildTable(report.id)];
    }
    return [];
  }

  async runInto(report, table, doc) {
    const source = this.sourceOf(report, doc);
    if (!source) {
      return 0;
    }
    const t = this.target(report, table);
    t.storage.fixedValues = { _project: doc.projectId, _document: doc.id };
    t.runner.provider = source.provider;
    this.current = { docId: doc.id, provider: source.provider };
    try {
      for (const resource of source.resources) {
        await t.runner.processResource(t.wc, resource);
      }
    } finally {
      this.current = null;
    }
    return this.db.prepare(`SELECT COUNT(*) AS n FROM ${quote(table)} WHERE _document = ?`).get(doc.id).n;
  }

  /**
   * Runs one document through one report into one table, in a savepoint: a view that fails on
   * the document leaves no rows from it, and the failure is recorded against the report.
   */
  async runReport(report, table, doc, result) {
    this.db.exec('SAVEPOINT report');
    try {
      result.rows += await this.runInto(report, table, doc);
      this.db.exec('RELEASE report');
    } catch (e) {
      this.db.exec('ROLLBACK TO report');
      this.db.exec('RELEASE report');
      this.db.prepare('INSERT OR REPLACE INTO _errors (report_id, generation, doc_id, project_id, message, at_ms) VALUES (?, ?, ?, ?, ?, ?)')
        .run(report.id, report.generation, doc.id, doc.projectId, e.message, Date.now());
      result.errors.push({ report: report.id, message: e.message });
    }
  }

  /**
   * The pipeline's last step: the document's rows go from every report table, and it is run
   * through every report again.
   *
   * The work is one transaction. Nothing else can write to the reports database in between: the
   * runner's awaits are all on values (no FHIRPath function here answers asynchronously), so
   * no other request runs until it is done.
   *
   * @param {{id, projectId, bundle, analysed, outcome}} doc
   * @returns {Promise<{reports: number, rows: number, errors: Array}>}
   */
  async processDocument(doc) {
    const reports = this.store.reports();
    const result = { reports: 0, rows: 0, errors: [] };
    this.db.exec('BEGIN');
    try {
      this.deleteRows('_document', doc.id);
      this.db.prepare('DELETE FROM _errors WHERE doc_id = ?').run(doc.id);
      for (const report of reports) {
        const tables = this.tablesFor(report, doc.id);
        for (const table of tables) {
          await this.runReport(report, table, doc, result);
        }
        if (tables.length > 0) {
          result.reports++;
        }
      }
      this.db.exec('COMMIT');
    } catch (e) {
      if (this.db.inTransaction) {
        this.db.exec('ROLLBACK');
      }
      throw e;
    }
    return result;
  }

  /** A document has been deleted: its rows go. */
  deleteDocument(docId) {
    this.deleteRows('_document', docId);
    this.db.prepare('DELETE FROM _errors WHERE doc_id = ?').run(docId);
  }

  /** A project has been deleted: its rows go. */
  deleteProject(projectId) {
    this.deleteRows('_project', projectId);
    this.db.prepare('DELETE FROM _errors WHERE project_id = ?').run(projectId);
  }

  deleteRows(column, value) {
    for (const r of this.store.reports()) {
      for (const t of [r.id, buildTable(r.id)]) {
        if (this.tableExists(t)) {
          this.db.prepare(`DELETE FROM ${quote(t)} WHERE ${column} = ?`).run(value);
        }
      }
    }
  }

  // ---- building tables ---------------------------------------------------------------

  /** Whether any report table is waiting to be built, or being built. */
  building() {
    return !!this.db.prepare("SELECT 1 FROM _builds WHERE state <> 'ready' LIMIT 1").get();
  }

  /**
   * Gets on with building report tables, for about budgetMs: called by the processing queue
   * after it has dealt with the documents waiting. A table is built a document at a time, each in
   * a transaction of its own, giving the event loop a turn between documents; where it is up to
   * is kept, so a build carries on after a restart. When every document is done, the new table
   * replaces the old one.
   * @returns {Promise<number>} how many documents were done
   */
  async buildStep(budgetMs = 2000) {
    const started = Date.now();
    let done = 0;
    while (Date.now() - started < budgetMs) {
      const b = this.db.prepare("SELECT * FROM _builds WHERE state <> 'ready' ORDER BY report_id LIMIT 1").get();
      if (!b) {
        break;
      }
      const report = this.store.report(b.report_id);
      if (!report || report.generation !== b.generation) {
        // deleted or changed while waiting: syncBuilds/save will have dealt with it
        this.db.prepare('DELETE FROM _builds WHERE report_id = ? AND generation = ?').run(b.report_id, b.generation);
        continue;
      }
      if (b.state === 'pending') {
        this.startBuild(report);
        continue;
      }
      const rows = this.store.reportDocuments(b.cursor, BUILD_BATCH);
      if (rows.length === 0) {
        this.finishBuild(report);
        continue;
      }
      for (const row of rows) {
        await this.buildDocument(report, row);
        done++;
        await new Promise(resolve => setImmediate(resolve));
        if (Date.now() - started >= budgetMs) {
          break;
        }
      }
    }
    return done;
  }

  startBuild(report) {
    const table = buildTable(report.id);
    const columns = prepareView(report.view, { model: r4 }).columns;
    this.db.exec(`DROP TABLE IF EXISTS ${quote(table)}`);
    this.db.exec(SqliteStorage.createTableSql(table, columns, FIXED_COLUMNS));
    // named for the generation: the old table's indexes keep their names until it is dropped
    this.db.exec(`CREATE INDEX ${quote(`_ix_${report.id}_${report.generation}_document`)} ON ${quote(table)} (_document)`);
    this.db.exec(`CREATE INDEX ${quote(`_ix_${report.id}_${report.generation}_project`)} ON ${quote(table)} (_project)`);
    this.db.prepare('DELETE FROM _errors WHERE report_id = ? AND generation = ?').run(report.id, report.generation);
    this.db.prepare("UPDATE _builds SET state = 'building', cursor = 0, docs = 0, started_ms = ?, finished_ms = NULL WHERE report_id = ?").run(Date.now(), report.id);
    this.log.info(`IPS module: building the table for report '${report.id}' (generation ${report.generation})`);
  }

  async buildDocument(report, row) {
    const doc = {
      id: row.id,
      projectId: row.project_id,
      bundle: report.source === 'uploaded' ? JSON.parse(row.json) : null,
      analysed: report.source === 'transformed' && row.analysed_json ? JSON.parse(row.analysed_json) : null,
      outcome: report.source === 'outcomes' ? (this.store.readResult(row.id, 'validation')?.result?.outcome || null) : null
    };
    const result = { rows: 0, errors: [] };
    this.db.exec('BEGIN');
    try {
      await this.runReport(report, buildTable(report.id), doc, result);
      this.db.prepare('UPDATE _builds SET cursor = ?, docs = docs + 1 WHERE report_id = ?').run(row.id, report.id);
      this.db.exec('COMMIT');
    } catch (e) {
      if (this.db.inTransaction) {
        this.db.exec('ROLLBACK');
      }
      throw e;
    }
  }

  finishBuild(report) {
    this.forget(report.id);
    this.db.exec('BEGIN');
    try {
      this.db.exec(`DROP TABLE IF EXISTS ${quote(report.id)}`);
      this.db.exec(`ALTER TABLE ${quote(buildTable(report.id))} RENAME TO ${quote(report.id)}`);
      this.db.prepare("UPDATE _builds SET state = 'ready', finished_ms = ? WHERE report_id = ?").run(Date.now(), report.id);
      this.db.prepare('DELETE FROM _errors WHERE report_id = ? AND generation < ?').run(report.id, report.generation);
      this.db.exec('COMMIT');
    } catch (e) {
      if (this.db.inTransaction) {
        this.db.exec('ROLLBACK');
      }
      throw e;
    }
    const b = this.db.prepare('SELECT docs FROM _builds WHERE report_id = ?').get(report.id);
    this.log.info(`IPS module: the table for report '${report.id}' is built (${b ? b.docs : 0} documents)`);
  }

  // ---- reading ---------------------------------------------------------------------

  /** The documents a report's view failed on, in a project. */
  errors(report, projectId) {
    return this.db.prepare('SELECT doc_id, message FROM _errors WHERE report_id = ? AND generation = ? AND project_id = ? ORDER BY doc_id LIMIT 100')
      .all(report.id, report.generation, projectId);
  }

  /**
   * A report for a project: each statement's output, and the table's first rows (and how many
   * there are). Statements see every report's table, each limited to the project.
   * @returns {Promise<{statements: Array, raw: Object|null}>}
   */
  query(report, projectId, options = {}) {
    const tables = this.store.reports().map(r => r.id).filter(t => this.tableExists(t));
    const request = {
      projectId,
      tables,
      statements: options.statements === false ? [] : report.statements,
      maxRows: options.maxRows || this.maxRows,
      raw: tables.includes(report.id) ? { table: report.id, limit: options.rawLimit || this.maxRows } : null
    };
    return this.run(request);
  }

  /** The project's rows of a report's table, as CSV (up to csvMaxRows). */
  async csv(report, projectId) {
    const out = await this.query(report, projectId, { statements: false, rawLimit: this.csvMaxRows });
    if (!out.raw || out.raw.error) {
      throw new Error(out.raw ? out.raw.error : `The table for '${report.id}' has not been built yet`);
    }
    const keep = out.raw.columns.map((c, i) => [c, i]).filter(([c]) => c !== 'ViewRowKey' && c !== '_project');
    const lines = [keep.map(([c]) => csvField(c)).join(',')];
    for (const row of out.raw.rows) {
      lines.push(keep.map(([, i]) => csvField(row[i])).join(','));
    }
    return lines.join('\r\n') + '\r\n';
  }

  run(request) {
    if (this.dbPath === ':memory:') {
      // no file for another process to open
      return Promise.resolve(runRequest(this.db, request));
    }
    return new Promise((resolve, reject) => {
      const child = fork(path.join(__dirname, 'reports-query.js'), ['--reports-query'], {
        execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], serialization: 'advanced'
      });
      let settled = false;
      const done = (fn) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          fn();
        }
      };
      const timer = setTimeout(() => done(() => {
        child.kill('SIGKILL');
        reject(new Error(`The report took longer than ${Math.round(this.timeoutMs / 1000)} seconds, and was stopped`));
      }), this.timeoutMs);
      child.once('message', (m) => done(() => (m.ok ? resolve(m.result) : reject(new Error(m.error)))));
      child.once('error', (e) => done(() => reject(e)));
      child.once('exit', (code) => done(() => reject(new Error(`The report query stopped (exit code ${code})`))));
      child.send({ dbPath: this.dbPath, request });
    });
  }
}

function buildTable(id) {
  return '_build_' + id;
}

function csvField(v) {
  if (v === null || v === undefined) {
    return '';
  }
  const s = String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** JSON with its keys sorted, to tell whether a view has really changed. */
function canonical(v) {
  if (Array.isArray(v)) {
    return '[' + v.map(canonical).join(',') + ']';
  }
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

module.exports = { Reports, SOURCES, FIXED_COLUMNS, VIEW_DEFINITION_PROFILE };
