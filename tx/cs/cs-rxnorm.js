const sqlite3 = require('sqlite3').verbose();
const assert = require('assert');
const { CodeSystem } = require('../library/codesystem');
const { CodeSystemProvider, CodeSystemFactoryProvider } = require('./cs-api');
const {Designations} = require("../library/designations");
const {validateArrayParameter, formatDateMMDDYYYY} = require("../../library/utilities");

// Context for RxNorm concepts
class RxNormConcept {
  constructor(code, display) {
    this.code = code;
    this.display = display;
    this.others = []; // Array of alternative displays (SY terms, etc.)
    this.archived = false;
  }
}

// Filter holder for query building and iteration
class RxNormFilterHolder {
  constructor() {
    this.sql = '';
    this.text = false; // Whether this is a text search filter
    this.params = {}; // Parameters for the SQL query
    this.cursor = 0;
    this.results = null; // Will hold query results for iteration
    this.executed = false;
  }
}

// Filter preparation context
class RxNormPrep {
  constructor() {
    this.filters = [];
  }
}

// Iterator context
class RxNormIteratorContext {
  constructor(query, params = {}) {
    this.query = query;
    this.params = params;
    this.cursor = 0;
    this.results = null;
    this.executed = false;
  }

  more() {
    return this.cursor < (this.results ? this.results.length : 0);
  }

  next() {
    this.cursor++;
  }
}

class RxNormServices extends CodeSystemProvider {
  constructor(opContext, supplements, db, sharedData, isNCI = false) {
    super(opContext, supplements);
    this.db = db;
    this.isNCI = isNCI;

    // Shared data from factory
    this.dbVersion = sharedData.version;
    this.rels = sharedData.rels;
    this.reltypes = sharedData.reltypes;
    this.totalCodeCount = sharedData.totalCodeCount;
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  // Metadata methods
  system() {
    return this.isNCI ? 'http://ncimeta.nci.nih.gov' : 'http://www.nlm.nih.gov/research/umls/rxnorm';
  }

  version() {
    return this.dbVersion;
  }

  description() {
    return this.isNCI ? 'NCI Metathesaurus' : 'RxNorm';
  }

  name() {
    return this.isNCI ? 'NCI' : 'RxNorm';
  }

  async totalCount() {
    return this.totalCodeCount;
  }

  getSAB() {
    return this.isNCI ? 'NCI' : 'RXNORM';
  }

  getCodeField() {
    return this.isNCI ? 'SCUI' : 'RXCUI';
  }

  hasParents() {
    return true; // RxNorm has relationships
  }

  // Core concept methods
  async code(context) {
    
    const ctxt = await this.#ensureContext(context);
    return ctxt ? ctxt.code : null;
  }

  async display(context) {
    
    const ctxt = await this.#ensureContext(context);
    if (!ctxt) {
      return null;
    }

    // Check supplements first
    let disp = this._displayFromSupplements(ctxt.code);
    if (disp) {
      return disp;
    }

    return ctxt.display || '';
  }

  async definition(context) {
    await this.#ensureContext(context);
    return null; // RxNorm doesn't provide definitions
  }

  async isAbstract(context) {
    await this.#ensureContext(context);

    return false; // RxNorm codes are not abstract
  }

  async getStatus(context) {

    const ctxt = await this.#ensureContext(context);

    if (ctxt && ctxt.archived) {
      return 'archived';
    }

    // Check suppress flag
    return new Promise((resolve, reject) => {
      const sql = `SELECT suppress FROM rxnconso WHERE ${this.getCodeField()} = ? AND SAB = ? AND TTY <> 'SY'`;

      this.db.get(sql, [ctxt.code, this.getSAB()], (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row ? row.suppress === '1' ? 'suppressed' : null : null);
        }
      });
    });
  }

  async isInactive(context) {
    
    const ctxt = await this.#ensureContext(context);

    if (ctxt && ctxt.archived) {
      return true;
    }

    // Check suppress flag
    return new Promise((resolve, reject) => {
      const sql = `SELECT suppress FROM rxnconso WHERE ${this.getCodeField()} = ? AND SAB = ? AND TTY <> 'SY'`;

      this.db.get(sql, [ctxt.code, this.getSAB()], (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row ? row.suppress === '1' : false);
        }
      });
    });
  }

  async isDeprecated(context) {
    
    const ctxt = await this.#ensureContext(context);
    return ctxt ? ctxt.archived : false;
  }

  async designations(context, displays) {
    
    const ctxt = await this.#ensureContext(context);

    if (ctxt) {
      // Add main display
      displays.addDesignation(true, 'active', 'en-US', CodeSystem.makeUseForDisplay(), ctxt.display);

      // Add other displays
      for (const other of ctxt.others) {
        displays.addDesignation(false, 'active', 'en-US', null, other);
      }

      // Add supplement designations
      this._listSupplementDesignations(ctxt.code, displays);
    }
  }

  async #ensureContext(context) {
    if (!context) {
      return null;
    }
    if (typeof context === 'string') {
      const ctxt = await this.locate(context);
      if (!ctxt.context) {
        throw new Error(ctxt.message);
      } else {
        return ctxt.context;
      }
    }
    if (context instanceof RxNormConcept) {
      return context;
    }
    throw new Error("Unknown Type at #ensureContext: " + (typeof context));
  }

  // Lookup methods
  async locate(code) {
    
    assert(!code || typeof code === 'string', 'code must be string');
    if (!code) return { context: null, message: 'Empty code' };

    return new Promise((resolve, reject) => {
      let sql = `SELECT STR, TTY FROM rxnconso WHERE ${this.getCodeField()} = ? AND SAB = ?`;

      this.db.all(sql, [code, this.getSAB()], (err, rows) => {
        if (err) {
          reject(err);
          return;
        }

        if (rows.length === 0) {
          // Try archive
          sql = `SELECT STR, TTY FROM RXNATOMARCHIVE WHERE ${this.getCodeField()} = ? AND SAB = ?`;
          this.db.all(sql, [code, this.getSAB()], (err, archiveRows) => {
            if (err) {
              reject(err);
              return;
            }

            if (archiveRows.length === 0) {
              resolve({ context: null, message: undefined});
              return;
            }

            const concept = this.#createConceptFromRows(code, archiveRows, true);
            resolve({ context: concept, message: null });
          });
        } else {
          const concept = this.#createConceptFromRows(code, rows, false);
          resolve({ context: concept, message: null });
        }
      });
    });
  }

  #createConceptFromRows(code, rows, archived) {
    const concept = new RxNormConcept(code);
    concept.archived = archived;

    for (const row of rows) {
      if (row.TTY === 'SY' || concept.display && concept.display) {
        concept.others.push(row.STR.trim());
      } else {
        concept.display = row.STR.trim();
      }
    }

    return concept;
  }

  // Iterator methods
  async iterator(context) {
    

    if (!context) {
      // Iterate all codes
      const query = `SELECT ${this.getCodeField()}, STR FROM rxnconso WHERE SAB = ? AND TTY <> 'SY' ORDER BY ${this.getCodeField()}`;
      return new RxNormIteratorContext(query, { sab: this.getSAB() });
    } else {
      // No hierarchical iteration for specific contexts in this implementation
      return new RxNormIteratorContext('', {});
    }
  }

  async nextContext(iteratorContext) {
    

    if (!iteratorContext.executed) {
      await this.#executeIterator(iteratorContext);
    }

    if (!iteratorContext.more()) {
      return null;
    }

    const row = iteratorContext.results[iteratorContext.cursor];
    iteratorContext.next();

    const concept = new RxNormConcept(row[this.getCodeField()], row.STR);
    return concept;
  }

  async #executeIterator(iteratorContext) {
    return new Promise((resolve, reject) => {
      this.db.all(iteratorContext.query, Object.values(iteratorContext.params), (err, rows) => {
        if (err) {
          reject(err);
        } else {
          iteratorContext.results = rows;
          iteratorContext.executed = true;
          resolve();
        }
      });
    });
  }

  // Filter support
  async doesFilter(prop, op, value) {
    

    let propUC = prop.toUpperCase();

    // TTY filters
    if (propUC === 'TTY' && ['=', 'in'].includes(op)) {
      return true;
    }

    // STY filter
    if (propUC === 'STY' && op === '=') {
      return true;
    }

    // SAB filter
    if (propUC === 'SAB' && op === '=') {
      return true;
    }

    // Relationship filters (REL values like 'SY', 'RN', etc.)
    if (this.rels.includes(prop) && op === '=' && (value.startsWith('CUI:') || value.startsWith('AUI:'))) {
      return true;
    }

    // Relationship type filters (RELA values)
    if (this.reltypes.includes(prop) && op === '=' && (value.startsWith('CUI:') || value.startsWith('AUI:'))) {
      return true;
    }

    return false;
  }

  // eslint-disable-next-line no-unused-vars
  async getPrepContext(iterate) {
    return new RxNormPrep();
  }

  async filter(filterContext, forIteration, prop, op, value) {
    

    const filter = new RxNormFilterHolder();
    let propUC = prop.toUpperCase();

    let sql = '';
    let params = {};

    if (op === 'in' && propUC === 'TTY') {
      const values = value.split(',').map(v => v.trim()).filter(v => v);
      const placeholders = values.map((_, i) => `$tty${i}`).join(',');
      sql = `AND TTY IN (${placeholders})`;
      values.forEach((val, i) => {
        params[`tty${i}`] = this.#sqlWrapString(val);
      });
    } else if (op === '=') {
      if (propUC === 'STY') {
        sql = `AND ${this.getCodeField()} IN (SELECT RXCUI FROM rxnsty WHERE TUI = $sty)`;
        params.sty = this.#sqlWrapString(value);
      } else if (propUC === 'SAB') {
        sql = `AND ${this.getCodeField()} IN (SELECT ${this.getCodeField()} FROM rxnconso WHERE SAB = $sab)`;
        params.sab = this.#sqlWrapString(value);
      } else if (propUC === 'TTY') {
        sql = `AND TTY = $tty`;
        params.tty = this.#sqlWrapString(value);
      } else if (this.rels.includes(prop)) {
        if (value.startsWith('CUI:')) {
          const cui = value.substring(4);
          sql = `AND (${this.getCodeField()} IN (SELECT ${this.getCodeField()} FROM rxnconso WHERE RXCUI IN (SELECT RXCUI2 FROM rxnrel WHERE REL = $rel AND RXCUI1 = $cui2)))`;
          params.rel = this.#sqlWrapString(prop);
          params.cui2 = this.#sqlWrapString(cui);
        } else if (value.startsWith('AUI:')) {
          const aui = value.substring(4);
          sql = `AND (${this.getCodeField()} IN (SELECT ${this.getCodeField()} FROM rxnconso WHERE RXAUI IN (SELECT RXAUI2 FROM rxnrel WHERE REL = $rel AND RXAUI1 = $aui2)))`;
          params.rel = this.#sqlWrapString(prop);
          params.aui2 = this.#sqlWrapString(aui);
        }
      } else if (this.reltypes.includes(prop)) {
        if (value.startsWith('CUI:')) {
          const cui = value.substring(4);
          sql = `AND (${this.getCodeField()} IN (SELECT ${this.getCodeField()} FROM rxnconso WHERE RXCUI IN (SELECT RXCUI2 FROM rxnrel WHERE RELA = $rela AND RXCUI1 = $cui2)))`;
          params.rela = this.#sqlWrapString(prop);
          params.cui2 = this.#sqlWrapString(cui);
        } else if (value.startsWith('AUI:')) {
          const aui = value.substring(4);
          sql = `AND (${this.getCodeField()} IN (SELECT ${this.getCodeField()} FROM rxnconso WHERE RXAUI IN (SELECT RXAUI2 FROM rxnrel WHERE RELA = $rela AND RXAUI1 = $aui2)))`;
          params.rela = this.#sqlWrapString(prop);
          params.aui2 = this.#sqlWrapString(aui);
        }
      }
    }

    if (!sql) {
      throw new Error(`Unknown filter "${prop} ${op} ${value}"`);
    }

    filter.sql = sql;
    filter.params = params;
    filterContext.filters.push(filter);
  }

  /**
   * Whether RXNSTEMS can hold this stem at all.
   *
   * The importer only stems words that are longer than two characters and start with a
   * letter (see extractWords), so the table has nothing that begins with a digit. Every
   * token of a search is ANDed, so a token the table cannot hold takes the whole search
   * to nothing: "acetaminophen" found thousands of codes while "acetaminophen 500" found
   * none, which is not a result anyone would expect from adding a dose.
   * @private
   */
  #stemIsIndexed(stem) {
    return stem.length > 2 && /^[a-z]/.test(stem);
  }

  async searchFilter(filterContext, filter, sort) {

    if (!filter || !filter.stems || filter.stems.length === 0) {
      throw new Error('Invalid search filter');
    }

    for (let i = 0; i < filter.stems.length; i++) {
      const stem = filter.stems[i];
      const rxnormFilter = new RxNormFilterHolder();
      if (this.#stemIsIndexed(stem)) {
        rxnormFilter.text = true;
        rxnormFilter.sql = ` AND (${this.getCodeField()} = s${i}.CUI AND s${i}.stem LIKE $stem${i})`;
        rxnormFilter.params[`stem${i}`] = stem + '%';
      } else {
        // Not in the stem table, so match the token against the text itself. Left as a
        // plain (non-text) filter so that executeFilters does not join RXNSTEMS for it.
        // Unindexed, but it only ever narrows rows the other tokens have already found,
        // and the tokens are alphanumeric, so there are no LIKE wildcards to escape.
        rxnormFilter.sql = ` AND STR LIKE $text${i}`;
        rxnormFilter.params[`text${i}`] = '%' + ((filter.words && filter.words[i]) || stem) + '%';
      }

      filterContext.filters.push(rxnormFilter);
    }
    if (sort) {
      // TODO
    }
  }

  async executeFilters(filterContext) {
    

    if (filterContext.filters.length === 0) {
      return [];
    }

    // Build the complete query
    let sql1 = '';
    let sql2 = 'FROM rxnconso';
    let allParams = {};

    let stemIndex = 0;

    // Add non-text filters first
    for (const filter of filterContext.filters) {
      if (!filter.text) {
        sql1 += ' ' + filter.sql;
        Object.assign(allParams, filter.params);
      }
    }

    // Add text search joins and filters. Each one is renumbered to its position among the
    // text filters, which is not its position among the filters - searchFilter leaves gaps
    // where a token went to a plain STR match instead. The alias, the placeholder and the
    // parameter key all carry that number and have to move together: renaming the key but
    // not the placeholder leaves the query asking for a parameter that is not there.
    for (const filter of filterContext.filters) {
      if (filter.text) {
        sql2 += `, rxnstems as s${stemIndex}`;
        const stemSql = filter.sql
          .replace(/\bs\d+\./g, `s${stemIndex}.`)
          .replace(/\$stem\d+/g, `$stem${stemIndex}`);
        sql1 += ' ' + stemSql;

        for (const [key, value] of Object.entries(filter.params)) {
          allParams[key.replace(/\d+$/, stemIndex.toString())] = value;
        }
        stemIndex++;
      }
    }

    const fullQuery = `SELECT ${this.getCodeField()}, STR ${sql2} WHERE SAB = $sab AND TTY <> 'SY' ${sql1}`;
    allParams.sab = this.getSAB();

    // Create a single filter holder with the combined query
    const combinedFilter = new RxNormFilterHolder();
    combinedFilter.sql = fullQuery;
    combinedFilter.params = allParams;

    return [combinedFilter];
  }

  async filterSize(filterContext, set) {
    if (!set.executed) {
      await this.#executeFilter(set);
    }

    return set.results ? set.results.length : 0;
  }

  async filterMore(filterContext, set) {
    

    if (!set.executed) {
      await this.#executeFilter(set);
    }

    return set.cursor < (set.results ? set.results.length : 0);
  }

  async filterConcept(filterContext, set) {
    

    if (!set.executed) {
      await this.#executeFilter(set);
    }

    if (set.cursor >= set.results.length) {
      return null;
    }

    const row = set.results[set.cursor];
    set.cursor++;

    const concept = new RxNormConcept(row[this.getCodeField()], row.STR);
    return concept;
  }

  async filterLocate(filterContext, set, code) {
    

    return new Promise((resolve, reject) => {
      // Build query to check if code exists in filter
      const checkQuery = `SELECT ${this.getCodeField()}, STR FROM rxnconso WHERE SAB = $sab AND TTY <> 'SY' AND ${this.getCodeField()} = $code ${set.sql.replace(/SELECT.*?FROM rxnconso/, '').replace(/WHERE SAB = \$sab AND TTY <> 'SY'/, '')}`;

      const params = { ...set.params, code };

      this.db.get(checkQuery, this.#buildParamArray(checkQuery, params), (err, row) => {
        if (err) {
          reject(err);
        } else if (!row) {
          resolve(null);
        } else {
          const concept = new RxNormConcept(row[this.getCodeField()], row.STR);
          resolve(concept);
        }
      });
    });
  }

  async filterCheck(filterContext, set, concept) {
    

    if (!(concept instanceof RxNormConcept)) {
      return false;
    }

    if (!set.executed) {
      await this.#executeFilter(set);
    }

    return set.results.some(row => row[this.getCodeField()] === concept.code);
  }

  async #executeFilter(filter) {
    return new Promise((resolve, reject) => {
      const paramArray = this.#buildParamArray(filter.sql, filter.params);

      this.db.all(filter.sql, paramArray, (err, rows) => {
        if (err) {
          reject(err);
        } else {
          filter.results = rows;
          filter.executed = true;
          resolve();
        }
      });
    });
  }

  // Helper method to build parameter arrays for sqlite3
  #buildParamArray(sql, params) {
    const paramArray = [];
    const paramOrder = [];

    // Extract parameter names from SQL in order
    const paramMatches = sql.match(/\$\w+/g) || [];
    paramMatches.forEach(match => {
      const paramName = match.substring(1); // Remove $
      if (!paramOrder.includes(paramName)) {
        paramOrder.push(paramName);
      }
    });

    // Build array in correct order
    paramOrder.forEach(paramName => {
      if (Object.prototype.hasOwnProperty.call(params, paramName)) {
        paramArray.push(params[paramName]);
      }
    });

    return paramArray;
  }

  #sqlWrapString(str) {
    return str.replace(/'/g, "''");
  }

  // Subsumption testing
  async subsumesTest(codeA, codeB) {
    await this.#ensureContext(codeA);
    await this.#ensureContext(codeB);
    return 'not-subsumed'; // Not implemented yet
  }

  // Extension for lookup operation
  async extendLookup(ctxt, props, params) {
    validateArrayParameter(props, 'props', String);
    validateArrayParameter(params, 'params', Object);


    if (typeof ctxt === 'string') {
      const located = await this.locate(ctxt);
      if (!located.context) {
        throw new Error(located.message);
      }
      ctxt = located.context;
    }

    if (!(ctxt instanceof RxNormConcept)) {
      throw new Error('Invalid context for RxNorm lookup');
    }

    // Set abstract status
    params.abstract = false;

    // Add designations
    const designations =  new Designations(this.opContext.i18n.languageDefinitions);
    await this.designations(ctxt, designations);
    for (const designation of designations) {
      this.#addProperty(params, 'designation', 'display', designation.value, designation.language);
    }
  }

  #addProperty(params, type, name, value, language = null) {
    if (!params.parameter) {
      params.parameter = [];
    }

    const property = {
      name: type,
      part: [
        { name: 'code', valueCode: name },
        { name: 'value', valueString: value }
      ]
    };

    if (language) {
      property.part.push({ name: 'language', valueCode: language });
    }

    params.parameter.push(property);
  }

  versionAlgorithm() {
    return 'date';
  }
}

class RxNormTypeServicesFactory extends CodeSystemFactoryProvider {
  constructor(i18n, dbPath, isNCI = false) {
    super(i18n);
    this.dbPath = dbPath;
    this.isNCI = isNCI;
    this._loaded = false;
    this._sharedData = null;
  }

  system() {
    return this.isNCI ? 'http://ncimeta.nci.nih.gov' : 'http://www.nlm.nih.gov/research/umls/rxnorm';
  }

  version() {
    return this._sharedData.version;
  }

  // eslint-disable-next-line no-unused-vars
  async buildKnownValueSet(url, version) {
    return null;
  }

  async #ensureLoaded() {
    if (!this._loaded) {
      await this.load();
    }
  }

  async load() {
    const db = new sqlite3.Database(this.dbPath);

    try {
      await new Promise((resolve, reject) => {
        db.run(`CREATE INDEX IF NOT EXISTS idx_rxnstems_cui_stem ON RXNSTEMS(CUI, stem)`,
          err => err ? reject(err) : resolve());
      });

      this._sharedData = {
        version: '',
        rels: [],
        reltypes: [],
        totalCodeCount: 0
      };

      // Load version
      this._sharedData.version = await this.#readVersion(db);

      // Load relationship types
      this._sharedData.rels = await this.#loadList(db, 'SELECT DISTINCT REL FROM RXNREL');

      // Load relationship attributes
      this._sharedData.reltypes = await this.#loadList(db, 'SELECT DISTINCT RELA FROM RXNREL');

      // Get total count
      const sab = this.isNCI ? 'NCI' : 'RXNORM';
      this._sharedData.totalCodeCount = await this.#getCount(db, `SELECT COUNT(RXCUI) FROM rxnconso WHERE SAB = ? AND TTY <> 'SY'`, [sab]);

    } finally {
      db.close();
    }
    this._loaded = true;
  }

  async #readVersion(db) {
    return new Promise((resolve) => {
      db.get('SELECT version FROM RXNVer', (err, row) => {
        if (err || !row) {
          // Fallback: try to extract version from database path
          const dbDetails = this.dbPath;
          let version = '??';

          if (dbDetails.includes('.db')) {
            let d = dbDetails.substring(0, dbDetails.indexOf('.db'));
            if (d.includes('_')) {
              d = d.substring(d.lastIndexOf('_') + 1);
            }
            if (d.includes('-')) {
              d = d.substring(0, d.lastIndexOf('-'));
            }
            if (/^\d+$/.test(d)) {
              version = d;
            }
          }
          resolve(version);
        } else {
          resolve(row.version.toString());
        }
      });
    });
  }

  async #loadList(db, sql) {
    return new Promise((resolve, reject) => {
      db.all(sql, (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows.map(row => Object.values(row)[0]));
        }
      });
    });
  }

  async #getCount(db, sql, params = []) {
    return new Promise((resolve, reject) => {
      db.get(sql, params, (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row ? Object.values(row)[0] : 0);
        }
      });
    });
  }

  defaultVersion() {
    return this._sharedData?.version || 'unknown';
  }

  async build(opContext, supplements) {
    await this.#ensureLoaded();
    this.recordUse();

    // Create fresh database connection for this provider instance
    const db = new sqlite3.Database(this.dbPath);

    return new RxNormServices(opContext, supplements, db, this._sharedData, this.isNCI);
  }

  name() {
    return this.isNCI ? 'NCI' : 'RxNorm';
  }

  id() {
    return this.name()+"-"+this.version();
  }

  describeVersion(version) {
    try {
      return formatDateMMDDYYYY(version);
    } catch (error) {
      return "v" + version;
    }
  }
}

// Specific RxNorm implementation
class RxNormServicesFactory extends RxNormTypeServicesFactory {
  constructor(languageDefinitions, dbPath) {
    super(languageDefinitions, dbPath, false);
  }
}

// NCI Meta implementation
class NCIServicesFactory extends RxNormTypeServicesFactory {
  constructor(languageDefinitions, dbPath) {
    super(languageDefinitions, dbPath, true);
  }
}

module.exports = {
  RxNormServices,
  RxNormServicesFactory,
  NCIServicesFactory,
  RxNormConcept
};