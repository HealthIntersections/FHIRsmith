//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * A rest endpoint's terminology, published by the tx server: the CodeSystems, ValueSets and
 * ConceptMaps stored in a rest module endpoint (library source `rest:<endpoint path>`, e.g.
 * `rest:/r4`). Every tx process reads the endpoint's database itself, read only, so it doesn't
 * matter which processes run the rest module.
 *
 *  - what: the current version of each resource of the three types that isn't deleted (the
 *    resource's own version element is its version, not its history version)
 *  - when: code systems are loaded with the library and brought up to date by the tx server's
 *    minute timer (getCodeSystemChanges); value sets and concept maps are read again when a
 *    request finds that the endpoint has written one since it last looked (at most every
 *    REFRESH_MS). So a change appears on the tx server within a minute for a code system and
 *    a few seconds for the others
 *  - precedence: a resource from the rest endpoint wins over one with the same url (and
 *    version) from anywhere else: its providers take precedence (takesPrecedence)
 *  - FHIR version: the endpoint's resources are read as its FHIR version and converted to R5,
 *    as the tx server holds everything
 *
 * Everything the endpoint holds of these types is as public as the tx server: anyone who can
 * use the tx server can read it there, whatever the endpoint's own access rules.
 *
 * The database is opened when first needed; until the rest module has made (or migrated) it,
 * the source is empty, and tries again later.
 *
 * @module tx/rest/rest-source
 */

const path = require('path');
const { AbstractCodeSystemProvider } = require('../cs/cs-provider-api');
const { AbstractValueSetProvider } = require('../vs/vs-api');
const { AbstractConceptMapProvider } = require('../cm/cm-api');
const { CodeSystem } = require('../library/codesystem');
const ValueSet = require('../library/valueset');
const { ConceptMap } = require('../library/conceptmap');
const { applyIdPrefix, stripIdPrefix } = require('../library/resource-ids');
const { VersionUtilities } = require('../../library/version-utilities');
const { assertNoActiveContent } = require('../../library/narrative-check');

const TYPES = ['CodeSystem', 'ValueSet', 'ConceptMap'];
// value sets and concept maps: how often a request may check for changes
const REFRESH_MS = 5000;
// how long to wait before trying again to open a database that isn't ready
const RETRY_MS = 30000;

/**
 * The database, and what was read from it of each type.
 */
class RestSource {
  /**
   * @param {Object} options
   * @param {string} options.path - the endpoint's path (for messages, and as the source name)
   * @param {Object} options.database - the endpoint's database configuration (modules.rest.endpoints[].database)
   * @param {string} options.databasesDir - where a relative SQLite file is
   * @param {Object} [options.log]
   * @param {Object} [options.db] - an open database to use (tests)
   */
  constructor(options) {
    this.path = options.path;
    this.cfg = options.database;
    this.databasesDir = options.databasesDir;
    this.log = options.log || null;
    this.db = options.db || null;
    this.ownsDb = !options.db;
    this.opening = null;
    this.failedAt = 0;
    this.fhirVersion = null;
    // type -> { signature, checkedAt, entries: Map(id -> { versionKey, json }) }
    this.snapshots = new Map();
  }

  get name() {
    return `rest:${this.path}`;
  }

  /** The database, opened (null while it can't be: it is tried again after RETRY_MS) */
  async open() {
    if (this.db) {
      return this.db;
    }
    if (this.failedAt && Date.now() - this.failedAt < RETRY_MS) {
      return null;
    }
    if (!this.opening) {
      this.opening = (async () => {
        const { openDatabase } = require('../../rest/database');
        try {
          // (the rest module migrates it: not ready yet is not an error, only empty for now)
          this.db = await openDatabase(this.cfg, { databasesDir: this.databasesDir, master: false, schemaWaitMs: 0 });
          this.failedAt = 0;
        } catch (e) {
          this.failedAt = Date.now();
          this.warn(`can't read the rest endpoint's database yet: ${e.message}`);
        } finally {
          this.opening = null;
        }
        return this.db;
      })();
    }
    return this.opening;
  }

  warn(msg) {
    if (this.log) {
      this.log.warn(`Terminology source ${this.name}: ${msg}`);
    }
  }

  /**
   * The current resources of a type: Map(id -> { versionKey, json }), read again only when the
   * endpoint has changed them (and it was last checked more than maxAgeMs ago)
   * @param {string} type
   * @param {number} [maxAgeMs]
   */
  async current(type, maxAgeMs = REFRESH_MS) {
    let snap = this.snapshots.get(type);
    if (snap && Date.now() - snap.checkedAt < maxAgeMs) {
      return snap.entries;
    }
    const db = await this.open();
    if (!db) {
      return snap ? snap.entries : new Map();
    }
    try {
      const fresh = await db.read(async (q) => {
        // a reset under way (rest/maintenance.js): what was read before, until it's over
        if (await underMaintenance(q)) {
          return null;
        }
        if (!this.fhirVersion) {
          const v = await q.get("SELECT Value FROM Config WHERE Name = 'fhirVersion'");
          this.fhirVersion = v ? String(v.Value) : '4.0.1';
        }
        const t = await q.get('SELECT TypeKey FROM Types WHERE Name = ?', [type]);
        if (!t) {
          return { signature: 'none', entries: new Map() };
        }
        // anything written (or deleted, or expunged) changes the newest version or the count; a
        // reset, the database's epoch
        const sig = await q.get('SELECT MAX(MostRecent) AS M, COUNT(*) AS N FROM Ids WHERE TypeKey = ? AND MostRecent IS NOT NULL', [t.TypeKey]);
        const epoch = await q.get("SELECT Value FROM Config WHERE Name = 'epoch'");
        const signature = `${epoch ? epoch.Value : ''}|${sig.M}|${sig.N}`;
        if (snap && snap.signature === signature) {
          return null;
        }
        const { decode } = require('../../rest/store');
        const rows = await q.all(`SELECT i.Id, v.VersionKey, v.Compressed, v.Content FROM Ids i JOIN Versions v ON v.VersionKey = i.MostRecent
          WHERE i.TypeKey = ? AND i.Deleted = 0`, [t.TypeKey]);
        const entries = new Map();
        for (const r of rows) {
          try {
            const json = decode(r);
            if (json) {
              entries.set(String(r.Id), { versionKey: Number(r.VersionKey), json });
            }
          } catch (e) {
            this.warn(`${type}/${r.Id} can't be read: ${e.message}`);
          }
        }
        return { signature, entries };
      });
      if (fresh) {
        snap = { signature: fresh.signature, checkedAt: Date.now(), entries: fresh.entries };
        this.snapshots.set(type, snap);
      } else if (snap) {
        snap.checkedAt = Date.now();
      }
      return snap ? snap.entries : new Map();
    } catch (e) {
      this.warn(`reading ${type} failed: ${e.message}`);
      return snap ? snap.entries : new Map();
    }
  }

  /**
   * A resource as the tx server holds it (R5, a wrapper object), or null if it can't be
   * @param {string} type
   * @param {Object} json - as stored (not changed: a copy is converted)
   */
  make(type, json) {
    const copy = JSON.parse(JSON.stringify(json));
    try {
      // narrative is shown as-is in a page, so it must not carry script (see narrative-check.js)
      assertNoActiveContent(copy);
      const r = type === 'CodeSystem' ? new CodeSystem(copy, this.fhirVersion || '4.0.1')
        : type === 'ValueSet' ? new ValueSet(copy, this.fhirVersion || '4.0.1') : new ConceptMap(copy, this.fhirVersion || '4.0.1');
      r.sourcePackage = this.name;
      r.takesPrecedence = true;
      return r;
    } catch (e) {
      this.warn(`${type}/${json.id} is left out: ${e.message}`);
      return null;
    }
  }

  async close() {
    if (this.db && this.ownsDb) {
      await this.db.close();
    }
    this.db = null;
  }
}

/**
 * The value sets or concept maps of a source, as the tx server's providers look them up: by
 * url (and version), by id, and by search
 */
class Catalogue {
  constructor(source, type, spaceOf) {
    this.source = source;
    this.type = type;
    this.spaceOf = spaceOf;
    this.signature = null;
    this.byId = new Map();
    this.byUrl = new Map();
  }

  async refresh() {
    const entries = await this.source.current(this.type);
    const sig = this.source.snapshots.get(this.type);
    const signature = sig ? sig.signature : null;
    if (signature === this.signature && this.byId.size === entries.size) {
      return;
    }
    const byId = new Map();
    const byUrl = new Map();
    for (const [id, e] of entries) {
      const r = this.source.make(this.type, e.json);
      if (!r || !r.url) {
        continue;
      }
      applyIdPrefix(r, this.spaceOf());
      byId.set(id, r);
      // url|version, url|major.minor, and url (the most recent)
      const keys = [`${r.url}|${r.version || ''}`];
      try {
        if (r.version && VersionUtilities.isSemVer(r.version)) {
          keys.push(`${r.url}|${VersionUtilities.getMajMin(r.version)}`);
        }
      } catch (err) {
        // not semver
      }
      for (const k of keys) {
        byUrl.set(k, r);
      }
      const latest = byUrl.get(r.url);
      if (!latest || (typeof r.isMoreRecent === 'function' && r.isMoreRecent(latest))) {
        byUrl.set(r.url, r);
      }
    }
    this.byId = byId;
    this.byUrl = byUrl;
    this.signature = signature;
  }

  async fetch(url, version) {
    await this.refresh();
    if (version) {
      const exact = this.byUrl.get(`${url}|${version}`);
      if (exact) {
        return exact;
      }
      try {
        if (VersionUtilities.isSemVer(version)) {
          const mm = this.byUrl.get(`${url}|${VersionUtilities.getMajMin(version)}`);
          if (mm) {
            return mm;
          }
        }
      } catch (e) {
        // not semver
      }
      return null;
    }
    return this.byUrl.get(url) || null;
  }

  async fetchById(id) {
    await this.refresh();
    const own = stripIdPrefix(id, this.spaceOf());
    const r = own ? this.byId.get(own) : null;
    return r && r.id === id ? r : null;
  }

  async all() {
    await this.refresh();
    return [...this.byId.values()];
  }

  async search(searchParams) {
    const list = await this.all();
    return list.filter(r => matches(r.jsonObj, searchParams)).map(r => r.jsonObj);
  }
}

/** Whether a resource matches a tx search (the package providers' rules: vs-package.js) */
function matches(json, searchParams) {
  for (const { name, value } of searchParams) {
    const lower = String(value).toLowerCase();
    if (name === 'content-mode' || name === 'supplements') {
      continue;
    }
    if (name === 'url') {
      if (json.url !== value) {
        return false;
      }
    } else if (name === 'url:below') {
      if (!(json.url || '').startsWith(value)) {
        return false;
      }
    } else if (name === 'url:contains') {
      if (!(json.url || '').toLowerCase().includes(lower)) {
        return false;
      }
    } else if (name === 'version') {
      if (!VersionUtilities.versionSearchMatches(value, json.version, VersionUtilities.versionAlgorithmOf(json))) {
        return false;
      }
    } else if (name === 'system') {
      const systems = [...((json.compose && json.compose.include) || []).map(i => i.system),
        ...(json.group || []).flatMap(g => [g.source, g.target]), json.sourceScopeUri, json.targetScopeUri].filter(Boolean);
      if (!systems.some(s => s.toLowerCase().includes(lower))) {
        return false;
      }
    } else if (name === 'jurisdiction') {
      const hit = (json.jurisdiction || []).some(cc => (cc.coding || []).some(c => [c.code, c.display].some(x => x && x.toLowerCase().includes(lower))) ||
        (cc.text && cc.text.toLowerCase().includes(lower)));
      if (!hit) {
        return false;
      }
    } else if (name === 'identifier') {
      const ids = Array.isArray(json.identifier) ? json.identifier : json.identifier ? [json.identifier] : [];
      if (!ids.some(i => [i.system, i.value].some(x => x && x.toLowerCase().includes(lower)))) {
        return false;
      }
    } else {
      const v = json[name];
      if (v === undefined || v === null || !String(v).toLowerCase().includes(lower)) {
        return false;
      }
    }
  }
  return true;
}

class RestCodeSystemProvider extends AbstractCodeSystemProvider {
  constructor(source) {
    super();
    this.source = source;
    this.takesPrecedence = true;
    // what each endpoint (fhirVersion|context) was last given: Map(id -> { versionKey, cs })
    this.given = new Map();
  }

  prefixIds() {
    // ids are prefixed as each code system is made (see make)
  }

  make(json) {
    const cs = this.source.make('CodeSystem', json);
    if (cs) {
      applyIdPrefix(cs, this.spaceId);
    }
    return cs;
  }

  key(fhirVersion, context) {
    // (the library lists with '4.0', the endpoint's provider asks for changes with 4)
    return `${String(fhirVersion).split('.')[0]}|${context || ''}`;
  }

  async listCodeSystems(fhirVersion, context) {
    const entries = await this.source.current('CodeSystem', 0);
    const given = new Map();
    const out = [];
    for (const [id, e] of entries) {
      const cs = this.make(e.json);
      if (cs) {
        given.set(id, { versionKey: e.versionKey, cs });
        out.push(cs);
      }
    }
    this.given.set(this.key(fhirVersion, context), given);
    return out;
  }

  async getCodeSystemChanges(fhirVersion, context) {
    const key = this.key(fhirVersion, context);
    const before = this.given.get(key) || new Map();
    const entries = await this.source.current('CodeSystem', 0);
    const added = [];
    const changed = [];
    const deleted = [];
    const now = new Map();
    for (const [id, e] of entries) {
      const was = before.get(id);
      if (was && was.versionKey === e.versionKey) {
        now.set(id, was);
        continue;
      }
      const cs = this.make(e.json);
      if (was && cs && was.cs.vurl === cs.vurl) {
        // the same url and version: it replaces the one there (the tx server deletes after
        // it adds, so a delete would take the new one out too)
        changed.push(cs);
      } else {
        if (was) {
          deleted.push(was.cs);
        }
        if (cs) {
          added.push(cs);
        }
      }
      if (cs) {
        now.set(id, { versionKey: e.versionKey, cs });
      }
    }
    for (const [id, was] of before) {
      if (!entries.has(id)) {
        deleted.push(was.cs);
      }
    }
    this.given.set(key, now);
    return added.length || changed.length || deleted.length ? { added, changed, deleted } : null;
  }

  async close() {
    await this.source.close();
  }
}

class RestValueSetProvider extends AbstractValueSetProvider {
  constructor(source) {
    super();
    this.source = source;
    this.takesPrecedence = true;
    this.catalogue = new Catalogue(source, 'ValueSet', () => this.spaceId);
  }

  code() {
    return this.source.name;
  }

  sourcePackage() {
    return this.source.name;
  }

  prefixIds() {
    // made again with the prefix the next time they are read
    this.catalogue.signature = null;
  }

  async fetchValueSet(url, version) {
    return this.catalogue.fetch(url, version);
  }

  async fetchValueSetById(id) {
    return this.catalogue.fetchById(id);
  }

  async searchValueSets(searchParams) {
    this._validateSearchParams(searchParams);
    return this.catalogue.search(searchParams);
  }

  vsCount() {
    return this.catalogue.byId.size;
  }

  async listAllValueSets() {
    return [...new Set((await this.catalogue.all()).map(v => v.url))];
  }
}

class RestConceptMapProvider extends AbstractConceptMapProvider {
  constructor(source) {
    super();
    this.source = source;
    this.takesPrecedence = true;
    this.catalogue = new Catalogue(source, 'ConceptMap', () => this.spaceId);
  }

  sourcePackage() {
    return this.source.name;
  }

  prefixIds() {
    this.catalogue.signature = null;
  }

  async fetchConceptMap(url, version) {
    return this.catalogue.fetch(url, version);
  }

  async fetchConceptMapById(id) {
    return this.catalogue.fetchById(id);
  }

  async searchConceptMaps(searchParams) {
    this._validateSearchParams(searchParams);
    return this.catalogue.search(searchParams);
  }

  async findConceptMapForTranslation(opContext, conceptMaps, sourceSystem, sourceScope, targetScope, targetSystem) {
    for (const cm of await this.catalogue.all()) {
      if (cm.providesTranslation(sourceSystem, sourceScope, targetScope, targetSystem)) {
        conceptMaps.push(cm);
      }
    }
  }

  cmCount() {
    return this.catalogue.byId.size;
  }
}

/**
 * The providers for a `rest:` library source.
 * @param {string} details - the endpoint's path
 * @param {Object[]} endpoints - modules.rest.endpoints
 * @param {Object} options - databasesDir, log
 */
function restProviders(details, endpoints, options = {}) {
  const want = String(details || '').trim().replace(/\/+$/, '');
  if (!want.startsWith('/')) {
    throw new Error(`A rest source names a rest endpoint by its path, e.g. rest:/fhir/r4 (not '${details}')`);
  }
  const ep = (endpoints || []).find(e => String(e.path || '').replace(/\/+$/, '') === want);
  if (!ep || !ep.database) {
    throw new Error(`The rest source ${want}: there is no rest endpoint at ${want} in modules.rest.endpoints`);
  }
  const source = new RestSource({ path: want, database: ep.database, databasesDir: options.databasesDir || path.join(__dirname, '..', '..', 'data', 'databases'),
    log: options.log, db: options.db });
  return { source, codeSystems: new RestCodeSystemProvider(source), valueSets: new RestValueSetProvider(source), conceptMaps: new RestConceptMapProvider(source) };
}

/** Whether the rest endpoint is under maintenance (a database from before it could be, never) */
async function underMaintenance(q) {
  try {
    return !!(await q.get('SELECT State FROM Maintenance WHERE Id = 1'));
  } catch (e) {
    return false;
  }
}

module.exports = { RestSource, RestCodeSystemProvider, RestValueSetProvider, RestConceptMapProvider, restProviders, matches, REFRESH_MS, TYPES };
