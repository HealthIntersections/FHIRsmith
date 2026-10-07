#!/usr/bin/env node
/**
 * import-icd11.js -- build a SQLite database of ICD-11 content from the WHO ICD-API.
 *
 *   node import-icd11.js --native <native endpoint> --fhir <fhir endpoint> --dest <file.db>
 *
 * The native API is the content source: it is the only one that can enumerate the
 * classification (GET the linearization root for its top-level children, then
 * `?include=descendant` on each for its whole subtree). The FHIR endpoint is used for
 * release metadata and for an optional sample of $lookup responses kept for
 * cross-checking a provider's output against WHO's own server.
 *
 * Everything with structural meaning -- hierarchy, codes, class kinds, postcoordination
 * axes and their permitted values, cross references -- is stored in real columns and
 * rows. Free text that has no structural consequence is stored in `designation`, and the
 * untouched native JSON for each concept is kept in `concept.blob` as a fallback.
 *
 * The crawl is resumable: re-running against an existing database skips concepts that
 * are already complete, so it can be stopped and restarted, or topped up with an extra
 * language later.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { Command } = require('commander');

const TOOL_VERSION = '1.0.0';
const WHO = 'http://id.who.int';

// ---------------------------------------------------------------------------
// schema
// ---------------------------------------------------------------------------

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS meta (
  key    TEXT PRIMARY KEY,
  value  TEXT
);

-- one row per code system served out of this database
CREATE TABLE IF NOT EXISTS system (
  id        INTEGER PRIMARY KEY,
  code      TEXT NOT NULL UNIQUE,   -- mms | icf | foundation
  url       TEXT NOT NULL,          -- canonical url, the FHIR CodeSystem.url
  version   TEXT NOT NULL,          -- release id, eg 2026-01
  title     TEXT,
  is_tree   INTEGER NOT NULL,       -- 1 if every concept has at most one parent
  api_root  TEXT NOT NULL,          -- native path the crawl started from
  uri_stem  TEXT NOT NULL           -- versioned uri prefix used by the native API
);

-- one row per concept
CREATE TABLE IF NOT EXISTS concept (
  id           INTEGER PRIMARY KEY,
  system       INTEGER NOT NULL REFERENCES system(id),
  entity_id    TEXT NOT NULL,       -- 257068234, or 1363559646/other for a residual
  uri          TEXT NOT NULL,       -- unversioned uri; this is what FHIR accepts as a code
  code         TEXT,                -- the short code, NULL where the entity has none
  class_kind   TEXT,                -- chapter | block | category | window
  selectable   INTEGER NOT NULL,    -- 1 if this may be used to code with
  residual     TEXT,                -- NULL | other | unspecified
  depth        INTEGER,             -- shortest distance from a root
  child_count  INTEGER NOT NULL DEFAULT 0,
  block_id     TEXT,
  code_range   TEXT,
  source_uri   TEXT,                -- the Foundation entity this linearization entry came from
  browser_url  TEXT,
  lft          INTEGER,             -- nested set interval; only populated for tree systems
  rgt          INTEGER,
  blob         TEXT                 -- the native JSON, primary language
);
CREATE UNIQUE INDEX IF NOT EXISTS concept_uri    ON concept(system, uri);
CREATE INDEX        IF NOT EXISTS concept_code   ON concept(system, code);
CREATE INDEX        IF NOT EXISTS concept_kind   ON concept(system, class_kind);
CREATE INDEX        IF NOT EXISTS concept_src    ON concept(source_uri);
CREATE INDEX        IF NOT EXISTS concept_nested ON concept(system, lft, rgt);

-- parent/child edges. A concept may have several parents in the Foundation.
CREATE TABLE IF NOT EXISTS concept_parent (
  child   INTEGER NOT NULL REFERENCES concept(id),
  parent  INTEGER NOT NULL REFERENCES concept(id),
  seq     INTEGER NOT NULL,
  PRIMARY KEY (child, parent)
);
CREATE INDEX IF NOT EXISTS concept_parent_p ON concept_parent(parent);

-- transitive closure, so is-a / descendant-of never needs a recursive query at runtime.
-- Includes the reflexive (ancestor = descendant, depth 0) row for every concept.
CREATE TABLE IF NOT EXISTS concept_closure (
  ancestor    INTEGER NOT NULL REFERENCES concept(id),
  descendant  INTEGER NOT NULL REFERENCES concept(id),
  depth       INTEGER NOT NULL,
  PRIMARY KEY (ancestor, descendant)
);
CREATE INDEX IF NOT EXISTS concept_closure_d ON concept_closure(descendant);

-- all the human-readable text, in every language crawled
CREATE TABLE IF NOT EXISTS designation (
  concept  INTEGER NOT NULL REFERENCES concept(id),
  lang     TEXT NOT NULL,
  kind     TEXT NOT NULL,   -- title | definition | longDefinition | codingNote
                            -- | fullySpecifiedName | diagnosticCriteria | indexTerm | inclusion
  value    TEXT NOT NULL,
  seq      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS designation_c ON designation(concept, lang, kind);
CREATE INDEX IF NOT EXISTS designation_v ON designation(value COLLATE NOCASE);

-- pointers from one concept to another that are not hierarchy
CREATE TABLE IF NOT EXISTS concept_reference (
  concept        INTEGER NOT NULL REFERENCES concept(id),
  kind           TEXT NOT NULL,   -- exclusion | foundationChildElsewhere
                                  -- | relatedMaternal | relatedPerinatal
  target         INTEGER REFERENCES concept(id),  -- resolved where possible
  target_uri     TEXT,
  foundation_uri TEXT,
  label          TEXT,
  lang           TEXT,
  seq            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS concept_reference_c ON concept_reference(concept, kind);
CREATE INDEX IF NOT EXISTS concept_reference_t ON concept_reference(target);

-- the postcoordination axes declared on a stem concept
CREATE TABLE IF NOT EXISTS pc_scale (
  id             INTEGER PRIMARY KEY,
  concept        INTEGER NOT NULL REFERENCES concept(id),
  axis           TEXT NOT NULL,   -- http://id.who.int/icd/schema/infectiousAgent
  axis_name      TEXT NOT NULL,   -- infectiousAgent
  required       INTEGER NOT NULL,
  allow_multiple TEXT,            -- AllowAlways | NotAllowed | AllowedExceptFromSameBlock
  value_set_uri  TEXT NOT NULL,   -- the FHIR ValueSet canonical for this axis
  seq            INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS pc_scale_ca ON pc_scale(concept, axis);

-- the roots of each axis. The permitted values are these plus their descendants,
-- so membership is pc_scale_entity JOIN concept_closure.
CREATE TABLE IF NOT EXISTS pc_scale_entity (
  scale       INTEGER NOT NULL REFERENCES pc_scale(id),
  target      INTEGER REFERENCES concept(id),
  target_uri  TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  PRIMARY KEY (scale, target_uri)
);
CREATE INDEX IF NOT EXISTS pc_scale_entity_t ON pc_scale_entity(target);

-- a sample of $lookup responses from the FHIR endpoint, for cross-checking
CREATE TABLE IF NOT EXISTS fhir_sample (
  concept  INTEGER PRIMARY KEY REFERENCES concept(id),
  fetched  TEXT NOT NULL,
  status   INTEGER NOT NULL,
  body     TEXT NOT NULL
);

-- crawl bookkeeping, so an interrupted run can pick up where it left off
CREATE TABLE IF NOT EXISTS crawl_lang (
  system   INTEGER NOT NULL REFERENCES system(id),
  concept  INTEGER NOT NULL REFERENCES concept(id),
  lang     TEXT NOT NULL,
  PRIMARY KEY (system, concept, lang)
);

-- anything that went wrong, kept rather than thrown away
CREATE TABLE IF NOT EXISTS problem (
  id      INTEGER PRIMARY KEY,
  at      TEXT NOT NULL,
  system  TEXT,
  lang    TEXT,
  uri     TEXT,
  kind    TEXT NOT NULL,
  detail  TEXT
);
`;

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const now = () => new Date().toISOString();

function stripTrailingSlash(s) {
  return s.replace(/\/+$/, '');
}

/** Rewrite a WHO canonical uri onto the endpoint we are actually talking to. */
function toEndpoint(uri, nativeBase) {
  return uri.startsWith(WHO) ? nativeBase + uri.slice(WHO.length) : uri;
}

/** The unversioned form of a linearization uri -- what the FHIR API uses as a code. */
function unversion(uri) {
  return uri.replace(/(\/icd\/release\/11)\/[^/]+\/(mms|icf)\b/, '$1/$2');
}

/**
 * The tail of an entity uri: '257068234', or '1363559646/other' for a residual.
 * Accepts both the versioned (.../release/11/2026-01/mms/x) and unversioned
 * (.../release/11/mms/x) forms, and Foundation uris (.../icd/entity/x).
 */
function entityIdOf(uri) {
  const m = uri.match(/\/icd\/(?:entity|release\/11\/(?:[^/]+\/)?(?:mms|icf))\/(.+)$/);
  return m ? m[1] : uri;
}

function residualOf(entityId) {
  if (entityId.endsWith('/other')) return 'other';
  if (entityId.endsWith('/unspecified')) return 'unspecified';
  return null;
}

/** Language-tagged native values come as { '@language': .., '@value': .. }. */
function textOf(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  return v['@value'] ?? null;
}

function langOf(v, fallback) {
  return (v && typeof v === 'object' && v['@language']) || fallback;
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h${String(m).padStart(2, '0')}m` : m ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

// ---------------------------------------------------------------------------
// http
// ---------------------------------------------------------------------------

class Fetcher {
  constructor({ concurrency, retries, timeout, verbose }) {
    this.concurrency = concurrency;
    this.retries = retries;
    this.timeout = timeout;
    this.verbose = verbose;
    this.count = 0;
    this.retried = 0;
  }

  async json(url, headers) {
    let wait = 1000;
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        const ctl = AbortSignal.timeout(this.timeout);
        res = await fetch(url, { headers, signal: ctl });
      } catch (e) {
        if (attempt >= this.retries) return { ok: false, status: 0, error: String(e && e.message || e) };
        this.retried++;
        await new Promise(r => setTimeout(r, wait)); wait = Math.min(wait * 2, 30000);
        continue;
      }
      this.count++;
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= this.retries) {
          return { ok: false, status: res.status, error: `HTTP ${res.status}` };
        }
        this.retried++;
        const ra = Number(res.headers.get('retry-after'));
        await new Promise(r => setTimeout(r, Number.isFinite(ra) && ra > 0 ? ra * 1000 : wait));
        wait = Math.min(wait * 2, 30000);
        continue;
      }
      let body = null;
      try { body = await res.json(); } catch { /* not json */ }
      if (!res.ok) return { ok: false, status: res.status, body, error: `HTTP ${res.status}` };
      return { ok: true, status: res.status, body };
    }
  }

  /** Run `worker` over `items` with a fixed number of concurrent slots. */
  async pool(items, worker) {
    let next = 0;
    const runners = Array.from({ length: Math.min(this.concurrency, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        await worker(items[i], i);
      }
    });
    await Promise.all(runners);
  }
}

// ---------------------------------------------------------------------------
// system definitions
// ---------------------------------------------------------------------------

/** Where each code system's crawl starts, and what it is called in FHIR. */
function systemDefs(release) {
  return {
    mms: {
      code: 'mms',
      url: 'http://id.who.int/icd/release/11/mms',
      apiRoot: `/icd/release/11/${release}/mms`,
      uriStem: `${WHO}/icd/release/11/${release}/mms`,
      isTree: 1,
    },
    icf: {
      code: 'icf',
      url: 'http://id.who.int/icd/release/11/icf',
      apiRoot: `/icd/release/11/${release}/icf`,
      uriStem: `${WHO}/icd/release/11/${release}/icf`,
      isTree: 1,
    },
    foundation: {
      code: 'foundation',
      url: 'http://id.who.int/icd/entity',
      apiRoot: '/icd/entity',
      uriStem: `${WHO}/icd/entity`,
      isTree: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// importer
// ---------------------------------------------------------------------------

class Icd11Importer {
  constructor(opts) {
    this.opts = opts;
    this.native = stripTrailingSlash(opts.native);
    this.fhir = opts.fhir ? stripTrailingSlash(opts.fhir) : null;
    this.fetcher = new Fetcher(opts);
    this.log = (...a) => console.log(...a);
    this.warn = (...a) => console.warn(...a);
  }

  headers(lang) {
    return {
      'Accept': 'application/json',
      'API-Version': 'v2',
      'Accept-Language': lang,
    };
  }

  async getEntity(uri, lang, include) {
    const url = toEndpoint(uri, this.native) + (include ? `?include=${include}` : '');
    return this.fetcher.json(url, this.headers(lang));
  }

  problem(kind, detail, { system, lang, uri } = {}) {
    this.stmt.problem.run(now(), system ?? null, lang ?? null, uri ?? null, kind, detail ?? null);
  }

  // -- setup ---------------------------------------------------------------

  open() {
    const dest = this.opts.dest;
    if (this.opts.overwrite && fs.existsSync(dest)) {
      for (const suffix of ['', '-wal', '-shm']) {
        if (fs.existsSync(dest + suffix)) fs.unlinkSync(dest + suffix);
      }
    }
    fs.mkdirSync(path.dirname(path.resolve(dest)), { recursive: true });
    this.db = new Database(dest);
    this.db.exec(SCHEMA);
    this.prepare();
  }

  prepare() {
    const db = this.db;
    this.stmt = {
      setMeta: db.prepare(`INSERT INTO meta(key,value) VALUES (?,?)
                           ON CONFLICT(key) DO UPDATE SET value=excluded.value`),
      getMeta: db.prepare(`SELECT value FROM meta WHERE key=?`),
      insSystem: db.prepare(`INSERT INTO system(code,url,version,title,is_tree,api_root,uri_stem)
                             VALUES (@code,@url,@version,@title,@is_tree,@api_root,@uri_stem)
                             ON CONFLICT(code) DO UPDATE SET
                               url=excluded.url, version=excluded.version, title=excluded.title,
                               is_tree=excluded.is_tree, api_root=excluded.api_root,
                               uri_stem=excluded.uri_stem
                             RETURNING id`),
      insConcept: db.prepare(`INSERT INTO concept
          (system,entity_id,uri,code,class_kind,selectable,residual,child_count,
           block_id,code_range,source_uri,browser_url,blob)
          VALUES (@system,@entity_id,@uri,@code,@class_kind,@selectable,@residual,@child_count,
                  @block_id,@code_range,@source_uri,@browser_url,@blob)
          ON CONFLICT(system,uri) DO UPDATE SET
            entity_id=excluded.entity_id, code=excluded.code, class_kind=excluded.class_kind,
            selectable=excluded.selectable, residual=excluded.residual,
            child_count=excluded.child_count, block_id=excluded.block_id,
            code_range=excluded.code_range, source_uri=excluded.source_uri,
            browser_url=excluded.browser_url, blob=excluded.blob
          RETURNING id`),
      conceptId: db.prepare(`SELECT id FROM concept WHERE system=? AND uri=?`),
      delParents: db.prepare(`DELETE FROM concept_parent WHERE child=?`),
      insParent: db.prepare(`INSERT OR IGNORE INTO concept_parent(child,parent,seq) VALUES (?,?,?)`),
      delDesig: db.prepare(`DELETE FROM designation WHERE concept=? AND lang=?`),
      insDesig: db.prepare(`INSERT INTO designation(concept,lang,kind,value,seq) VALUES (?,?,?,?,?)`),
      delRefs: db.prepare(`DELETE FROM concept_reference WHERE concept=? AND lang=?`),
      insRef: db.prepare(`INSERT INTO concept_reference
          (concept,kind,target,target_uri,foundation_uri,label,lang,seq) VALUES (?,?,?,?,?,?,?,?)`),
      delScales: db.prepare(`DELETE FROM pc_scale_entity WHERE scale IN (SELECT id FROM pc_scale WHERE concept=?)`),
      delScales2: db.prepare(`DELETE FROM pc_scale WHERE concept=?`),
      insScale: db.prepare(`INSERT INTO pc_scale
          (concept,axis,axis_name,required,allow_multiple,value_set_uri,seq)
          VALUES (?,?,?,?,?,?,?) RETURNING id`),
      insScaleEntity: db.prepare(`INSERT OR IGNORE INTO pc_scale_entity(scale,target,target_uri,seq)
                                  VALUES (?,?,?,?)`),
      markLang: db.prepare(`INSERT OR IGNORE INTO crawl_lang(system,concept,lang) VALUES (?,?,?)`),
      doneLangs: db.prepare(`SELECT c.uri AS uri FROM crawl_lang cl JOIN concept c ON c.id=cl.concept
                             WHERE cl.system=? AND cl.lang=?`),
      insFhir: db.prepare(`INSERT INTO fhir_sample(concept,fetched,status,body) VALUES (?,?,?,?)
                           ON CONFLICT(concept) DO UPDATE SET
                             fetched=excluded.fetched, status=excluded.status, body=excluded.body`),
      problem: db.prepare(`INSERT INTO problem(at,system,lang,uri,kind,detail) VALUES (?,?,?,?,?,?)`),
    };
  }

  // -- enumeration ---------------------------------------------------------

  /**
   * The complete id list for a system. GET the root for its top-level children, then
   * ?include=descendant on each child for its entire subtree. This is the only reliable
   * enumeration the API offers, and it is 1 + n calls rather than one per concept.
   */
  async enumerate(def, lang) {
    const rootRes = await this.getEntity(WHO + def.apiRoot, lang);
    if (!rootRes.ok) throw new Error(`cannot read ${def.apiRoot}: ${rootRes.error}`);
    const root = rootRes.body;
    const tops = root.child || [];
    this.log(`  root: ${textOf(root.title)} -- ${tops.length} top-level children`);

    const all = new Set(tops);
    let seq = 0;
    await this.fetcher.pool(tops, async (uri) => {
      const r = await this.getEntity(uri, lang, 'descendant');
      if (!r.ok) {
        this.problem('enumerate-failed', r.error, { system: def.code, lang, uri });
        this.warn(`  ! could not enumerate ${uri}: ${r.error}`);
        return;
      }
      const ds = r.body.descendant || [];
      for (const d of ds) all.add(d);
      seq++;
      this.log(`  [${String(seq).padStart(2)}/${tops.length}] ${String(ds.length).padStart(6)} descendants  ${textOf(r.body.title) || ''}`.slice(0, 110));
    });
    return { root, uris: [...all] };
  }

  // -- one concept ---------------------------------------------------------

  /** Write everything a single native entity document tells us. */
  storeConcept(systemId, systemCode, doc, lang, isPrimary) {
    const uriVersioned = doc['@id'];
    const uri = unversion(uriVersioned);
    const entityId = entityIdOf(uri);
    const code = (doc.code ?? '').trim() || null;
    const classKind = doc.classKind ?? null;
    const children = doc.child || [];

    let conceptId;
    if (isPrimary) {
      conceptId = this.stmt.insConcept.get({
        system: systemId,
        entity_id: entityId,
        uri,
        code,
        class_kind: classKind,
        selectable: code && classKind === 'category' ? 1 : 0,
        residual: residualOf(entityId),
        child_count: children.length,
        block_id: doc.blockId ?? null,
        code_range: doc.codeRange ?? null,
        source_uri: doc.source ?? null,
        browser_url: doc.browserUrl ?? null,
        blob: JSON.stringify(doc),
      }).id;

      // hierarchy -- parents are resolved to ids in a second pass, so record the uris
      this.pendingParents.push([conceptId, (doc.parent || []).map(unversion)]);

      // postcoordination
      this.stmt.delScales.run(conceptId);
      this.stmt.delScales2.run(conceptId);
      (doc.postcoordinationScale || []).forEach((sc, i) => {
        const axis = sc.axisName || '';
        const axisName = axis.split('/').pop();
        const scaleId = this.stmt.insScale.get(
          conceptId,
          axis,
          axisName,
          String(sc.requiredPostcoordination) === 'true' ? 1 : 0,
          sc.allowMultipleValues ?? null,
          unversion(sc['@id'] || `${uri}/postcoordinationScale/${axisName}`),
          i
        ).id;
        (sc.scaleEntity || []).forEach((se, j) => {
          this.pendingScaleEntities.push([scaleId, unversion(se), j]);
        });
      });
    } else {
      const row = this.stmt.conceptId.get(systemId, uri);
      if (!row) return null;          // language pass found something the primary pass did not
      conceptId = row.id;
    }

    // text, per language
    this.stmt.delDesig.run(conceptId, lang);
    let seq = 0;
    const put = (kind, value) => {
      if (value != null && String(value).length) {
        this.stmt.insDesig.run(conceptId, lang, kind, String(value), seq++);
      }
    };
    put('title', textOf(doc.title));
    put('definition', textOf(doc.definition));
    put('longDefinition', textOf(doc.longDefinition));
    put('fullySpecifiedName', textOf(doc.fullySpecifiedName));
    put('codingNote', textOf(doc.codingNote));
    put('diagnosticCriteria', textOf(doc.diagnosticCriteria));
    for (const t of doc.indexTerm || []) put('indexTerm', textOf(t.label));
    for (const t of doc.inclusion || []) put('inclusion', textOf(t.label));

    // cross references, per language (the labels are translated)
    this.stmt.delRefs.run(conceptId, lang);
    const ref = (kind, list, i0 = 0) => {
      (list || []).forEach((r, i) => {
        const isObj = r && typeof r === 'object';
        const targetUri = isObj ? (r.linearizationReference || r.foundationReference || null) : r;
        this.stmt.insRef.run(
          conceptId, kind, null,
          targetUri ? unversion(targetUri) : null,
          isObj ? (r.foundationReference ?? null) : null,
          isObj ? textOf(r.label) : null,
          lang, i0 + i
        );
      });
    };
    ref('exclusion', doc.exclusion);
    ref('foundationChildElsewhere', doc.foundationChildElsewhere);
    ref('relatedMaternal', doc.relatedEntitiesInMaternalChapter);
    ref('relatedPerinatal', doc.relatedEntitiesInPerinatalChapter);

    this.stmt.markLang.run(systemId, conceptId, lang);
    return conceptId;
  }

  // -- the crawl ------------------------------------------------------------

  async crawlSystem(def, languages) {
    this.log(`\n=== ${def.code}  (${def.url})`);
    const primaryLang = languages[0];

    const { root, uris } = await this.enumerate(def, primaryLang);
    const release = root.releaseId || this.release;

    const sysRow = this.stmt.insSystem.get({
      code: def.code, url: def.url, version: release,
      title: textOf(root.title), is_tree: def.isTree,
      api_root: def.apiRoot, uri_stem: def.uriStem,
    });
    const systemId = sysRow.id;
    this.log(`  ${uris.length} entities to fetch, languages: ${languages.join(', ')}`);

    for (const lang of languages) {
      const isPrimary = lang === primaryLang;
      const done = new Set(this.stmt.doneLangs.all(systemId, lang).map(r => r.uri));
      const todo = uris.filter(u => !done.has(unversion(u)));
      if (!todo.length) { this.log(`  [${lang}] already complete`); continue; }
      this.log(`  [${lang}] ${todo.length} to fetch${done.size ? ` (${done.size} already done)` : ''}`);

      this.pendingParents = [];
      this.pendingScaleEntities = [];

      const started = Date.now();
      let done_ = 0, failed = 0;
      const batch = [];
      const flush = this.db.transaction((docs) => {
        for (const d of docs) this.storeConcept(systemId, def.code, d, lang, isPrimary);
      });

      await this.fetcher.pool(todo, async (uri) => {
        const r = await this.getEntity(uri, lang, 'diagnosticCriteria');
        if (!r.ok) {
          failed++;
          this.problem('fetch-failed', r.error, { system: def.code, lang, uri });
        } else {
          batch.push(r.body);
          if (batch.length >= this.opts.batch) flush(batch.splice(0, batch.length));
        }
        if (++done_ % this.opts.progress === 0) {
          const el = Date.now() - started;
          const rate = done_ / (el / 1000);
          const eta = (todo.length - done_) / Math.max(rate, 0.01) * 1000;
          this.log(`    ${done_}/${todo.length}  ${rate.toFixed(1)}/s  eta ${fmtDuration(eta)}${failed ? `  ${failed} failed` : ''}`);
        }
      });
      if (batch.length) flush(batch);

      if (isPrimary) this.resolveLinks(systemId, def);
      this.log(`  [${lang}] done in ${fmtDuration(Date.now() - started)}${failed ? `, ${failed} failed (see the problem table)` : ''}`);
    }

    if (def.isTree) this.buildNestedSet(systemId);
    this.buildClosure(systemId);
    this.checkIntegrity(systemId, def);
    return systemId;
  }

  /**
   * Turn the parent and scale-entity uris collected during the crawl into real ids.
   * `rootUri` is the linearization root, which the top-level concepts name as their
   * parent but which is not itself a concept -- that is expected, not a problem.
   */
  resolveLinks(systemId, def) {
    const lookup = this.stmt.conceptId;
    const rootUri = unversion(WHO + def.apiRoot);
    const run = this.db.transaction(() => {
      for (const [childId, parentUris] of this.pendingParents) {
        this.stmt.delParents.run(childId);
        parentUris.forEach((pu, i) => {
          const p = lookup.get(systemId, pu);
          if (p) this.stmt.insParent.run(childId, p.id, i);
          else if (pu !== rootUri) this.problem('unresolved-parent', pu, { system: def.code });
        });
      }
      for (const [scaleId, uri, seq] of this.pendingScaleEntities) {
        const t = lookup.get(systemId, uri);
        this.stmt.insScaleEntity.run(scaleId, t ? t.id : null, uri, seq);
      }
      // resolve cross references now that every concept exists
      this.db.prepare(`
        UPDATE concept_reference
           SET target = (SELECT c.id FROM concept c
                          WHERE c.system = ? AND c.uri = concept_reference.target_uri)
         WHERE target IS NULL AND target_uri IS NOT NULL
           AND concept IN (SELECT id FROM concept WHERE system = ?)`).run(systemId, systemId);
    });
    run();
    this.pendingParents = [];
    this.pendingScaleEntities = [];
  }

  /** Transitive closure, built level by level so memory stays bounded. */
  buildClosure(systemId) {
    const t0 = Date.now();
    this.db.prepare(`DELETE FROM concept_closure WHERE ancestor IN (SELECT id FROM concept WHERE system=?)`).run(systemId);
    this.db.prepare(`INSERT INTO concept_closure(ancestor,descendant,depth)
                     SELECT id,id,0 FROM concept WHERE system=?`).run(systemId);
    const step = this.db.prepare(`
      INSERT OR IGNORE INTO concept_closure(ancestor,descendant,depth)
      SELECT cl.ancestor, cp.child, ? FROM concept_closure cl
        JOIN concept_parent cp ON cp.parent = cl.descendant
       WHERE cl.depth = ?`);
    for (let d = 0; d < 64; d++) {
      const info = step.run(d + 1, d);
      if (info.changes === 0) break;
    }
    this.db.prepare(`
      UPDATE concept SET depth = (
        SELECT MIN(cl.depth) FROM concept_closure cl
          JOIN concept r ON r.id = cl.ancestor
         WHERE cl.descendant = concept.id
           AND NOT EXISTS (SELECT 1 FROM concept_parent WHERE child = r.id))
      WHERE system = ?`).run(systemId);
    const n = this.db.prepare(`SELECT COUNT(*) n FROM concept_closure cl
                                 JOIN concept c ON c.id=cl.ancestor WHERE c.system=?`).get(systemId).n;
    this.log(`  closure: ${n} rows in ${fmtDuration(Date.now() - t0)}`);
  }

  /**
   * Nested-set intervals, so "all descendants of X" is a single range scan. Only valid
   * where the hierarchy really is a tree; the Foundation is skipped.
   */
  buildNestedSet(systemId) {
    const kids = new Map();
    for (const r of this.db.prepare(`
        SELECT cp.parent p, cp.child c FROM concept_parent cp
          JOIN concept x ON x.id = cp.child WHERE x.system = ? ORDER BY cp.seq`).all(systemId)) {
      if (!kids.has(r.p)) kids.set(r.p, []);
      kids.get(r.p).push(r.c);
    }
    const roots = this.db.prepare(`
      SELECT id FROM concept WHERE system = ?
        AND NOT EXISTS (SELECT 1 FROM concept_parent WHERE child = concept.id)
      ORDER BY id`).all(systemId).map(r => r.id);

    const out = [];
    let n = 0;
    for (const root of roots) {
      // iterative DFS so a deep tree cannot blow the stack
      const stack = [[root, false]];
      while (stack.length) {
        const frame = stack.pop();
        const [id, exiting] = frame;
        if (exiting) { out.push([id, null, ++n]); continue; }
        out.push([id, ++n, null]);
        stack.push([id, true]);
        const cs = kids.get(id) || [];
        for (let i = cs.length - 1; i >= 0; i--) stack.push([cs[i], false]);
      }
    }
    const lft = new Map(), rgt = new Map();
    for (const [id, l, r] of out) {
      if (l != null) lft.set(id, l); else rgt.set(id, r);
    }
    const upd = this.db.prepare(`UPDATE concept SET lft=?, rgt=? WHERE id=?`);
    this.db.transaction(() => {
      for (const [id, l] of lft) upd.run(l, rgt.get(id) ?? l, id);
    })();
    this.log(`  nested set: ${lft.size} concepts numbered`);
  }

  checkIntegrity(systemId, def) {
    const q = (sql, ...a) => this.db.prepare(sql).get(systemId, ...a);
    const total = q(`SELECT COUNT(*) n FROM concept WHERE system=?`).n;
    const noCode = q(`SELECT COUNT(*) n FROM concept WHERE system=? AND code IS NULL`).n;
    const sel = q(`SELECT COUNT(*) n FROM concept WHERE system=? AND selectable=1`).n;
    const orphan = q(`SELECT COUNT(*) n FROM concept WHERE system=?
                        AND NOT EXISTS (SELECT 1 FROM concept_parent WHERE child=concept.id)`).n;
    const multi = q(`SELECT COUNT(*) n FROM (SELECT child FROM concept_parent cp
                        JOIN concept c ON c.id=cp.child WHERE c.system=?
                        GROUP BY child HAVING COUNT(*)>1)`).n;
    const scales = q(`SELECT COUNT(*) n FROM pc_scale ps JOIN concept c ON c.id=ps.concept WHERE c.system=?`).n;
    const unres = q(`SELECT COUNT(*) n FROM pc_scale_entity pse
                       JOIN pc_scale ps ON ps.id=pse.scale JOIN concept c ON c.id=ps.concept
                      WHERE c.system=? AND pse.target IS NULL`).n;
    this.log(`  ${total} concepts, ${sel} selectable, ${noCode} without a short code`);
    this.log(`  ${orphan} roots, ${multi} with more than one parent, ${scales} postcoordination axes` +
             (unres ? `, ${unres} unresolved axis values` : ''));
    if (def.isTree && multi) {
      this.problem('tree-assumption-broken', `${multi} concepts have multiple parents`, { system: def.code });
      this.warn(`  ! ${def.code} was assumed to be a tree but ${multi} concepts have several parents; nested set values are unreliable`);
    }
  }

  // -- the FHIR sample ------------------------------------------------------

  async fhirSample(systemId, def, count) {
    if (!this.fhir || !count) return;
    const rows = this.db.prepare(`
      SELECT id, uri, code FROM concept WHERE system=? ORDER BY RANDOM() LIMIT ?`).all(systemId, count);
    this.log(`  fetching ${rows.length} $lookup responses for cross-checking`);
    let ok = 0;
    await this.fetcher.pool(rows, async (row) => {
      const url = `${this.fhir}/CodeSystem/$lookup?system=${encodeURIComponent(def.url)}`
                + `&code=${encodeURIComponent(row.uri)}`;
      const r = await this.fetcher.json(url, { Accept: 'application/fhir+json' });
      this.stmt.insFhir.run(row.id, now(), r.status, JSON.stringify(r.body ?? { error: r.error }));
      if (r.ok) ok++;
    });
    this.log(`  ${ok}/${rows.length} returned 2xx`);
  }

  // -- driver ---------------------------------------------------------------

  async run() {
    const t0 = Date.now();
    this.open();

    // release + languages come from the Foundation root, which names both
    const rootRes = await this.getEntity(`${WHO}/icd/entity`, 'en');
    if (!rootRes.ok) throw new Error(`cannot reach the native API at ${this.native}: ${rootRes.error}`);
    this.release = this.opts.release || rootRes.body.releaseId;
    const advertised = rootRes.body.availableLanguages || ['en'];
    const languages = this.opts.languages === 'all'
      ? advertised
      : this.opts.languages.split(',').map(s => s.trim()).filter(Boolean);
    const unknown = languages.filter(l => !advertised.includes(l));
    if (unknown.length) this.warn(`! the API does not advertise ${unknown.join(', ')} -- it will fall back to English for those`);

    this.log(`ICD-11 import`);
    this.log(`  native   : ${this.native}`);
    this.log(`  fhir     : ${this.fhir || '(none)'}`);
    this.log(`  database : ${this.opts.dest}`);
    this.log(`  release  : ${this.release}   languages: ${languages.join(', ')}`);

    for (const [k, v] of Object.entries({
      toolVersion: TOOL_VERSION,
      importStarted: now(),
      nativeEndpoint: this.native,
      fhirEndpoint: this.fhir || '',
      release: this.release,
      languages: languages.join(','),
      availableLanguages: advertised.join(','),
    })) this.stmt.setMeta.run(k, v);

    if (this.fhir) {
      const caps = await this.fetcher.json(`${this.fhir}/metadata?mode=terminology`,
        { Accept: 'application/fhir+json' });
      if (caps.ok) {
        this.stmt.setMeta.run('fhirTerminologyCapabilities', JSON.stringify(caps.body));
        this.stmt.setMeta.run('fhirSoftware',
          `${caps.body?.software?.name ?? '?'} ${caps.body?.software?.version ?? ''}`.trim());
      } else {
        this.warn(`! could not read TerminologyCapabilities from ${this.fhir}: ${caps.error}`);
      }
    }

    const defs = systemDefs(this.release);
    const wanted = this.opts.systems.split(',').map(s => s.trim()).filter(Boolean);
    for (const name of wanted) {
      const def = defs[name];
      if (!def) throw new Error(`unknown system '${name}' -- expected one of ${Object.keys(defs).join(', ')}`);
      const systemId = await this.crawlSystem(def, languages);
      await this.fhirSample(systemId, def, this.opts.fhirSample);
    }

    this.stmt.setMeta.run('importFinished', now());
    this.stmt.setMeta.run('httpRequests', String(this.fetcher.count));
    this.log(`\noptimising...`);
    this.db.exec('PRAGMA optimize; VACUUM; ANALYZE;');

    const probs = this.db.prepare(`SELECT kind, COUNT(*) n FROM problem GROUP BY kind`).all();
    this.log(`\ndone in ${fmtDuration(Date.now() - t0)}, ${this.fetcher.count} requests` +
             (this.fetcher.retried ? ` (${this.fetcher.retried} retried)` : ''));
    for (const p of probs) this.log(`  problem: ${p.kind} x${p.n}`);
    const size = fs.statSync(this.opts.dest).size;
    this.log(`  ${this.opts.dest}  ${(size / 1024 / 1024).toFixed(1)} MB`);
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// cli
// ---------------------------------------------------------------------------

function main(argv) {
  const program = new Command();
  program
    .name('import-icd11')
    .description('Build a SQLite database of ICD-11 content from the WHO ICD-API')
    .requiredOption('-n, --native <url>', 'native ICD-API endpoint, eg https://id.who.int')
    .option('-f, --fhir <url>', 'FHIR endpoint, used for release metadata and the $lookup sample')
    .requiredOption('-d, --dest <file>', 'destination SQLite database')
    .option('-s, --systems <list>', 'which code systems to import', 'mms,icf,foundation')
    .option('-l, --languages <list>', "comma separated, or 'all' for every language the API advertises", 'all')
    .option('-r, --release <id>', 'release to import (default: whatever the API says is current)')
    .option('-c, --concurrency <n>', 'concurrent requests', v => parseInt(v, 10), 16)
    .option('--fhir-sample <n>', 'how many $lookup responses to keep per system', v => parseInt(v, 10), 500)
    .option('--batch <n>', 'concepts per database transaction', v => parseInt(v, 10), 200)
    .option('--progress <n>', 'log progress every n concepts', v => parseInt(v, 10), 1000)
    .option('--retries <n>', 'retries per request', v => parseInt(v, 10), 4)
    .option('--timeout <ms>', 'request timeout', v => parseInt(v, 10), 90000)
    .option('--overwrite', 'delete any existing database first', false)
    .option('--verbose', 'more logging', false);

  program.parse(argv);
  return new Icd11Importer(program.opts()).run();
}

if (require.main === module) {
  main(process.argv).catch(e => {
    console.error(`\nimport failed: ${e && e.stack || e}`);
    process.exit(1);
  });
}

module.exports = { Icd11Importer, SCHEMA, unversion, entityIdOf, main };
