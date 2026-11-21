//
// Text indexes kept in SQLite, from one run to the next
//
// The text indexes (text-match.js) of the code systems and supplements the server loads
// as it starts - the ones defined as resources, searched by cs-cs.js and
// supplement-text-index.js - kept in a SQLite database in the terminology cache rather
// than in the heap. They take time to build and memory to hold, and the content they index
// rarely changes from one run to the next, so:
//
// - each index is keyed on a hash of what it indexes (its names, their languages, and the
//   codes, in order): an index that was built in an earlier run for the same content is
//   used as it is, whatever the code system's url and version; content that changed (a
//   current build of an IG republished under the same version) gets a new index
// - the server waits for them as it starts (prepare): the first run with new content
//   builds the index, letting other work run while it does; later runs only hash
// - when the server has started, the indexes that nothing loaded this run used are
//   deleted (finish)
// - code systems and supplements that arrive later (from a client, tx-resource) are not
//   kept here: they are indexed in memory, as before (NameIndex)
//
// The same rules as NameIndex: a name in a language matches when it has every word of the
// filter (a word, by prefix or by stem), and a code when it starts with the filter. The
// keys are whatever the indexer gave (a concept's place in the code system, or a code).
//
// In a cluster (cluster.md), the master builds and deletes; the tx-workers only read,
// using the indexes the master has built, and indexing in memory anything they don't find.
//

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { languageOf, indexColumns, TEXT_INDEX_TOKENIZE } = require('./text-match');

const SCHEMA_VERSION = 1;
const YIELD_MS = 25;
const BATCH = 2000;

// object (a CodeSystem wrapper) -> its StoredNameIndex
const handles = new WeakMap();

/**
 * The scope token of an index's names in a language: the index's names are found with it
 * (an FTS5 query is restricted to one index, and one language, by matching it)
 */
function scopeToken(id, lang) {
  return `s${id}x${String(lang).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
}

/**
 * A sink for an indexer (NameIndex's add and addCode) that hashes what it is given
 */
class HashSink {
  constructor(prefix) {
    this.hash = crypto.createHash('sha256');
    this.hash.update(prefix + '\n');
    this.names = 0;
    this.codes = 0;
    this.langs = new Set();
  }

  add(key, lang, text) {
    if (text) {
      const l = languageOf(lang);
      this.langs.add(l);
      this.names++;
      this.hash.update(`n\0${typeof key}\0${key}\0${l}\0${text}\n`);
    }
  }

  addCode(key, code) {
    if (code != null && code !== '') {
      this.codes++;
      this.hash.update(`c\0${typeof key}\0${key}\0${code}\n`);
    }
  }

  digest() {
    return this.hash.digest('hex');
  }
}

/**
 * A sink that keeps what it is given, to insert
 */
class RowSink {
  constructor() {
    this.names = [];
    this.codes = [];
  }

  add(key, lang, text) {
    if (text) {
      this.names.push([key, languageOf(lang), text]);
    }
  }

  addCode(key, code) {
    if (code != null && code !== '') {
      this.codes.push([key, String(code).toLowerCase()]);
    }
  }
}

/**
 * A text index kept in the store: searched as a NameIndex is
 */
class StoredNameIndex {
  /**
   * @param {TextIndexStore} store
   * @param {Object} row - its row in the indexes table
   */
  constructor(store, row) {
    this.store = store;
    this.id = row.id;
    this.hash = row.hash;
    // how many concepts it was built for (the caller checks it still has as many)
    this.size = row.size;
    // the language given to the indexer (supplement-text-index.js: '' for a supplement that
    // says its own)
    this.lang = row.lang;
    this._languages = new Set(JSON.parse(row.langs || '[]'));
    this.built = true;
  }

  /** The language subtags it has names in */
  languages() {
    return this._languages;
  }

  /**
   * As NameIndex.searchNames: key -> its matching texts, keys in the order they were added
   * @param {TextQuery} query
   * @param {string|Object|null} lang
   * @returns {Map<*, string[]>}
   */
  searchNames(query, lang) {
    const result = new Map();
    const l = languageOf(lang);
    if (!this._languages.has(l)) {
      return result;
    }
    const fts = query.ftsQuery(lang);
    if (!fts) {
      return result;
    }
    const rows = this.store._searchNames(`scope : "${scopeToken(this.id, l)}" AND (${fts})`);
    for (const row of rows) {
      let texts = result.get(row.key);
      if (!texts) {
        texts = [];
        result.set(row.key, texts);
      }
      texts.push(row.text);
    }
    return result;
  }

  /**
   * As NameIndex.searchCodes: the keys whose code starts with the filter, in code order
   * @param {TextQuery} query
   * @returns {Array}
   */
  searchCodes(query) {
    if (query.code === '') {
      return [];
    }
    return this.store._searchCodes(this.id, query.code).map(r => r.key);
  }
}

class TextIndexStore {
  /**
   * @param {string} file - the database
   * @param {Object} [options]
   * @param {boolean} [options.readOnly] - only use what is there (a tx-worker)
   * @param {Object} [options.log]
   */
  constructor(file, options = {}) {
    this.file = file;
    this.readOnly = !!options.readOnly;
    this.log = options.log || null;
    this.db = null;
    // this run: what prepare matched or built is marked with it, and finish deletes the rest
    this.run = Date.now();
    this.stats = { kept: 0, built: 0, dropped: 0, objects: 0 };
  }

  /**
   * The index kept for an object (a CodeSystem wrapper) that prepare indexed, or null
   * @param {Object} object
   * @returns {StoredNameIndex|null}
   */
  static indexFor(object) {
    const index = object ? handles.get(object) : null;
    if (!index) {
      return null;
    }
    // another process with the same terminology cache may have deleted it (its finish, for
    // another library); then the caller indexes in memory, as for content loaded later
    if (!index.store.db || !index.store._alive(index)) {
      handles.delete(object);
      return null;
    }
    return index;
  }

  /**
   * The indexer's input for a code system defined as a resource (cs-cs.js): the concepts'
   * codes, displays (in the code system's language) and designations (in theirs), keyed by
   * the concept's place in getAllConcepts()
   * @param {Object[]} allConcepts
   * @param {string} csLang
   * @param {Object} sink - add(key, lang, text), addCode(key, code)
   */
  static fillCodeSystem(allConcepts, csLang, sink) {
    for (let ordinal = 0; ordinal < allConcepts.length; ordinal++) {
      const concept = allConcepts[ordinal];
      sink.addCode(ordinal, concept.code);
      sink.add(ordinal, csLang, concept.display);
      for (const d of concept.designation || []) {
        sink.add(ordinal, d.language || csLang, d.value);
      }
    }
  }

  /**
   * Open (creating it, unless read only) the database
   * @returns {TextIndexStore}
   */
  open() {
    if (this.readOnly) {
      this.db = new Database(this.file, { readonly: true, fileMustExist: true });
      this.db.pragma('busy_timeout = 5000');
      const version = this.db.prepare(`SELECT value FROM meta WHERE key = 'schema'`).get();
      if (!version || Number(version.value) !== SCHEMA_VERSION) {
        throw new Error(`${this.file} is not a text index store of this version`);
      }
    } else {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      this.db = new Database(this.file);
      this.db.pragma('busy_timeout = 5000');
      const meta = this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'`).get();
      const version = meta ? this.db.prepare(`SELECT value FROM meta WHERE key = 'schema'`).get() : null;
      if (meta && (!version || Number(version.value) !== SCHEMA_VERSION)) {
        // another version's: start again
        this.db.close();
        for (const suffix of ['', '-wal', '-shm']) {
          fs.rmSync(this.file + suffix, { force: true });
        }
        this.db = new Database(this.file);
        this.db.pragma('busy_timeout = 5000');
      }
      this.db.pragma('auto_vacuum = INCREMENTAL');
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE IF NOT EXISTS indexes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          hash TEXT NOT NULL UNIQUE,
          kind TEXT NOT NULL,
          url TEXT,
          version TEXT,
          lang TEXT,
          size INTEGER NOT NULL,
          names INTEGER NOT NULL,
          codes INTEGER NOT NULL,
          langs TEXT NOT NULL,
          first_row INTEGER,
          last_row INTEGER,
          complete INTEGER NOT NULL DEFAULT 0,
          built INTEGER NOT NULL,
          used INTEGER NOT NULL
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS names USING fts5(key UNINDEXED, text UNINDEXED, scope, words, stems,
          tokenize = "${TEXT_INDEX_TOKENIZE}");
        CREATE TABLE IF NOT EXISTS codes (idx INTEGER NOT NULL, code TEXT NOT NULL, key);
        CREATE INDEX IF NOT EXISTS codes_by_idx ON codes (idx, code);
      `);
      this.db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', ?)`).run(String(SCHEMA_VERSION));
      // later than any run before (two starts in the same millisecond are still two runs)
      const last = this.db.prepare(`SELECT max(used) AS used FROM indexes`).get().used;
      this.run = Math.max(this.run, (last || 0) + 1);
      // an index whose build didn't finish (the server stopped part way through) is no use
      for (const row of this.db.prepare(`SELECT * FROM indexes WHERE complete = 0`).all()) {
        this.#drop(row);
      }
    }
    // a page cache of its own: the names table is searched by every text filter
    this.db.pragma('cache_size = -16000');
    this._names = this.db.prepare(`SELECT key, text FROM names WHERE names MATCH ? ORDER BY rowid`);
    this._codes = this.db.prepare(`SELECT key FROM codes WHERE idx = ? AND code >= ? AND code < ? ORDER BY code`);
    this._byHash = this.db.prepare(`SELECT * FROM indexes WHERE hash = ? AND complete = 1`);
    this._byId = this.db.prepare(`SELECT hash FROM indexes WHERE id = ? AND complete = 1`);
    return this;
  }

  /** Whether an index is still in the store (and is the same one) */
  _alive(index) {
    const row = this._byId.get(index.id);
    return !!row && row.hash === index.hash;
  }

  _searchNames(match) {
    return this._names.all(match);
  }

  _searchCodes(id, code) {
    return this._codes.all(id, code, code + '\u{10FFFF}');
  }

  /**
   * Find, or build, the index of each item, and remember it for the item's object
   * (indexFor). Lets other work run while it builds
   * @param {Object[]} items - {object, kind ('cs' or 'supplement'), url, version, lang (what
   *   the indexer is given as the default language), size (concepts), fill(sink)}
   * @returns {Promise<Object>} {kept, built, objects}
   */
  async prepare(items) {
    let last = performance.now();
    const breathe = async () => {
      if (performance.now() - last >= YIELD_MS) {
        await new Promise(resolve => setImmediate(resolve));
        last = performance.now();
      }
    };
    const byHash = new Map(); // hash -> StoredNameIndex, this run
    for (const item of items) {
      await breathe();
      const hs = new HashSink(`${item.kind}\0${item.lang}\0${item.size}`);
      item.fill(hs);
      if (hs.names === 0 && hs.codes === 0) {
        continue;
      }
      const hash = hs.digest();
      let index = byHash.get(hash);
      if (!index) {
        const row = this._byHash.get(hash);
        if (row) {
          if (!this.readOnly) {
            this.db.prepare(`UPDATE indexes SET used = ? WHERE id = ?`).run(this.run, row.id);
          }
          index = new StoredNameIndex(this, row);
          this.stats.kept++;
        } else if (!this.readOnly) {
          index = await this.#build(item, hash, hs, breathe);
          this.stats.built++;
        }
        if (index) {
          byHash.set(hash, index);
        }
      }
      if (index) {
        handles.set(item.object, index);
        this.stats.objects++;
      }
    }
    return { kept: this.stats.kept, built: this.stats.built, objects: this.stats.objects };
  }

  async #build(item, hash, hs, breathe) {
    const rows = new RowSink();
    item.fill(rows);
    const now = Date.now();
    const id = Number(this.db.prepare(`INSERT INTO indexes (hash, kind, url, version, lang, size, names, codes, langs, built, used)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(hash, item.kind, item.url || null, item.version || null, item.lang ?? null,
      item.size, rows.names.length, rows.codes.length, JSON.stringify([...hs.langs]), now, this.run).lastInsertRowid);
    const insertName = this.db.prepare(`INSERT INTO names (key, text, scope, words, stems) VALUES (?, ?, ?, ?, ?)`);
    const insertCode = this.db.prepare(`INSERT INTO codes (idx, code, key) VALUES (?, ?, ?)`);
    let first = null;
    let lastRow = null;
    const names = this.db.transaction(batch => {
      for (const [key, lang, text] of batch) {
        const cols = indexColumns(text, lang);
        const r = Number(insertName.run(key, text, scopeToken(id, lang), cols.words, cols.stems).lastInsertRowid);
        first = first ?? r;
        lastRow = r;
      }
    });
    const codes = this.db.transaction(batch => {
      for (const [key, code] of batch) {
        insertCode.run(id, code, key);
      }
    });
    for (let i = 0; i < rows.names.length; i += BATCH) {
      names(rows.names.slice(i, i + BATCH));
      await breathe();
    }
    for (let i = 0; i < rows.codes.length; i += BATCH) {
      codes(rows.codes.slice(i, i + BATCH));
      await breathe();
    }
    this.db.prepare(`UPDATE indexes SET first_row = ?, last_row = ?, complete = 1 WHERE id = ?`).run(first, lastRow, id);
    return new StoredNameIndex(this, this.db.prepare(`SELECT * FROM indexes WHERE id = ?`).get(id));
  }

  #drop(row) {
    this.db.transaction(() => {
      if (row.first_row != null) {
        this.db.prepare(`DELETE FROM names WHERE rowid BETWEEN ? AND ?`).run(row.first_row, row.last_row);
      } else {
        // a build cut short: its names are the ones with its scope tokens
        for (const lang of JSON.parse(row.langs || '[]')) {
          this.db.prepare(`DELETE FROM names WHERE rowid IN (SELECT rowid FROM names WHERE names MATCH ?)`)
            .run(`scope : "${scopeToken(row.id, lang)}"`);
        }
      }
      this.db.prepare(`DELETE FROM codes WHERE idx = ?`).run(row.id);
      this.db.prepare(`DELETE FROM indexes WHERE id = ?`).run(row.id);
    })();
  }

  /**
   * Delete the indexes that nothing used this run (not read only). Call when everything the
   * server loads at startup has been through prepare. An index a process started since this
   * one has used is kept; one a process that is still running uses may go (it then indexes
   * that content in memory: see indexFor) - the store belongs to one server
   * @returns {number} how many were deleted
   */
  finish() {
    if (this.readOnly) {
      return 0;
    }
    const unused = this.db.prepare(`SELECT * FROM indexes WHERE used < ?`).all(this.run);
    for (const row of unused) {
      this.#drop(row);
    }
    this.stats.dropped = unused.length;
    if (unused.length > 0) {
      this.db.exec(`INSERT INTO names (names) VALUES ('optimize')`);
      this.db.pragma('incremental_vacuum');
    }
    return unused.length;
  }

  /**
   * What the store holds (for the caches page)
   * @returns {{indexes: number, names: number, bytes: number}}
   */
  summary() {
    const r = this.db.prepare(`SELECT count(*) AS indexes, coalesce(sum(names), 0) AS names FROM indexes WHERE complete = 1`).get();
    let bytes = 0;
    try {
      bytes = fs.statSync(this.file).size;
    } catch (e) {
      // gone
    }
    return { indexes: r.indexes, names: r.names, bytes };
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

module.exports = { TextIndexStore, StoredNameIndex, HashSink, scopeToken };
