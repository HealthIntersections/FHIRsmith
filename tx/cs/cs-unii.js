const sqlite3 = require('sqlite3').verbose();
const assert = require('assert');
const { CodeSystem } = require('../library/codesystem');
const { CodeSystemProvider, CodeSystemFactoryProvider} = require('./cs-api');
const { guarded } = require('../library/sqlite-utilities');

class UniiConcept {
  constructor(code, display) {
    this.code = code;
    this.display = display;
    this.others = []; // Array of other descriptions from UniiDesc table
  }
}

class UniiServices extends CodeSystemProvider {
  constructor(opContext, supplements, db, version) {
    super(opContext, supplements);
    this.db = db;
    this._version = version;
  }

  // Clean up database connection when provider is destroyed
  close() {
    this.closeDb();
  }

  // Metadata methods
  system() {
    return 'http://fdasis.nlm.nih.gov'; // UNII system URI
  }

  version() {
    return this._version;
  }

  description() {
    return 'UNII Codes';
  }

  name() {
    return 'UNII Codes';
  }

  totalCount() {
    return -1; // Database-driven, use count query if needed
  }

  hasParents() {
    return false; // No hierarchical relationships
  }

  hasAnyDisplays(languages) {
    const langs = this._ensureLanguages(languages);
    if (this._hasAnySupplementDisplays(langs)) {
      return true;
    }
    return super.hasAnyDisplays(langs);
  }

  // Core concept methods
  async code(code) {
    
    const ctxt = await this.#ensureContext(code);
    return ctxt ? ctxt.code : null;
  }

  async display(code) {
    
    const ctxt = await this.#ensureContext(code);
    if (!ctxt) {
      return null;
    }
    if (ctxt.display && this.opContext.langs.isEnglishOrNothing()) {
      return ctxt.display.trim();
    }
    let disp = this._displayFromSupplements(ctxt.code);
    if (disp) {
      return disp;
    }
    return ctxt.display ? ctxt.display.trim() : '';
  }

  async definition(code) {
    
    await this.#ensureContext(code);
    return null; // No definitions provided
  }

  async isAbstract(code) {
    await this.#ensureContext(code);
    return false; // No abstract concepts
  }

  async isInactive(code) {
    await this.#ensureContext(code);
    return false; // No inactive concepts
  }

  async isDeprecated(code) {
    await this.#ensureContext(code);
    return false; // No deprecated concepts
  }

  async designations(code, displays) {
    
    const ctxt = await this.#ensureContext(code);
    if (ctxt != null) {
      // Add main display
      if (ctxt.display) {
        displays.addDesignation(true, 'active', 'en', CodeSystem.makeUseForDisplay(), ctxt.display.trim());
      }
      // Add other descriptions
      ctxt.others.forEach(other => {
        if (other && other.trim()) {
          displays.addDesignation(false, 'active', 'en', CodeSystem.makeUseForDisplay(), other.trim());
        }
      });
      this._listSupplementDesignations(ctxt.code, displays);
    }
  }

  async #ensureContext(code) {
    if (!code) {
      return code;
    }
    if (typeof code === 'string') {
      const ctxt = await this.locate(code);
      if (!ctxt.context) {
        throw new Error(ctxt.message);
      } else {
        return ctxt.context;
      }
    }
    if (code instanceof UniiConcept) {
      return code;
    }
    throw new Error("Unknown Type at #ensureContext: " + (typeof code));
  }

  // Database helper methods
  async #getVersion() {
    return new Promise((resolve, reject) => {
      this.db.get('SELECT Version FROM UniiVersion', guarded(reject, (err, row) => {
        if (err) reject(err);
        else resolve(row ? row.Version : 'unknown');
      }));
    });
  }

  async #getTotalCount() {
    return new Promise((resolve, reject) => {
      this.db.get('SELECT COUNT(*) as count FROM Unii', guarded(reject, (err, row) => {
        if (err) reject(err);
        else resolve(row.count);
      }));
    });
  }

  // Lookup methods
  async locate(code) {
    
    assert(!code || typeof code === 'string', 'code must be string');
    if (!code) return { context: null, message: 'Empty code' };

    return new Promise((resolve, reject) => {
      // First query: get main concept
      this.db.get('SELECT UniiKey, Display FROM Unii WHERE Code = ?', [code], guarded(reject, (err, row) => {
        if (err) {
          return reject(err);
        }

        if (!row) {
          return resolve({ context: null, message: `UNII Code '${code}' not found` });
        }

        const concept = new UniiConcept(code, row.Display);
        const uniiKey = row.UniiKey;

        // Second query: get all descriptions
        this.db.all('SELECT Display FROM UniiDesc WHERE UniiKey = ?', [uniiKey], guarded(reject, (err, rows) => {
          if (err) return reject(err);

          // Add unique descriptions to others array
          rows.forEach(descRow => {
            const desc = descRow.Display;
            if (desc && desc.trim() && !concept.others.includes(desc.trim())) {
              concept.others.push(desc.trim());
            }
          });

          resolve({ context: concept, message: undefined });
        }));
      }));
    });
  }

  versionAlgorithm() {
    return 'date';
  }
}

class UniiServicesFactory extends CodeSystemFactoryProvider {
  constructor(i18n, dbPath) {
    super(i18n);
    this.dbPath = dbPath;
    this.uses = 0;
    this._version = null;
  }

  async load() {
    const db = new sqlite3.Database(this.dbPath, sqlite3.OPEN_READONLY);
    try {
      const row = await new Promise((resolve, reject) => {
        db.get('SELECT Version FROM UniiVersion', (err, result) => {
          if (err) reject(new Error(err));
          else resolve(result);
        });
      });
      this._version = row ? row.Version : 'unknown';
    } finally {
      await new Promise((resolve) => db.close(() => resolve()));
    }
  }

  defaultVersion() {
    return 'unknown';
  }

  system() {
    return 'http://fdasis.nlm.nih.gov'; // UNII system URI
  }

  version() {
    return this._version;
  }

  build(opContext, supplements) {
    this.uses++;

    return new UniiServices(opContext, supplements, new sqlite3.Database(this.dbPath), this._version);
  }

  // eslint-disable-next-line no-unused-vars
  async buildKnownValueSet(url, version) {
    return null;
  }

  useCount() {
    return this.uses;
  }

  recordUse() {
    this.uses++;
  }
  name() {
    return 'UNII Codes';
  }

  id() {
    return "unii";
  }

}

module.exports = {
  UniiServices,
  UniiServicesFactory,
  UniiConcept
};