const sqlite3 = require('sqlite3').verbose();
const assert = require('assert');
const { CodeSystem } = require('../library/codesystem');
const { CodeSystemFactoryProvider } = require('./cs-api');
const { BaseCSServices } = require('./cs-base');
const {validateArrayParameter, formatDateMMDDYYYY} = require("../../library/utilities");

// Context for RxNorm concepts
class RxNormConcept {
  constructor(code, display) {
    this.code = code;
    this.display = display;
    this.others = []; // Array of alternative displays (SY terms, etc.)
    this.archived = false;
    this.suppress = null; // SUPPRESS of the display atom, when known: N, E, O (obsolete) or Y
  }

  get obsolete() {
    return this.suppress === 'O';
  }
}

// Which RXNORM atom gives a concept its display: the atom with its main term type (IN, SCD,
// BN...), or failing that a prescribable name, an entry term, or a tall man synonym. SY atoms
// are never the display. As an SQL expression that is lowest for the best atom
const DISPLAY_RANK_SQL = `CASE TTY WHEN 'PSN' THEN 1 WHEN 'ET' THEN 2 WHEN 'TMSY' THEN 3 WHEN 'SY' THEN 4 ELSE 0 END`;
function displayRank(tty) {
  switch (tty) {
    case 'PSN': return 1;
    case 'ET': return 2;
    case 'TMSY': return 3;
    case 'SY': return 4;
    default: return 0;
  }
}

// RxNorm's own relationships are the only ones used, for now (filters and $lookup). RXNREL
// holds every source's (MTHSPL, VANDF...), and they are all imported
const RELATIONSHIP_SAB = 'RXNORM';

// indexes the provider needs beyond what older imports made (see also import-rxnorm.module.js)
const RXNORM_LOAD_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_rxnstems_cui_stem ON RXNSTEMS(CUI, stem)',
  'CREATE INDEX IF NOT EXISTS idx_rxnrel_rxcui2 ON RXNREL(RXCUI2, SAB)',
  'CREATE INDEX IF NOT EXISTS idx_rxnrel_rela_rxcui1 ON RXNREL(RELA, RXCUI1)',
  'CREATE INDEX IF NOT EXISTS idx_rxnrel_rela_rxaui1 ON RXNREL(RELA, RXAUI1)',
  'CREATE INDEX IF NOT EXISTS idx_rxnsty_rxcui ON RXNSTY(RXCUI)'
];

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
  /**
   * @param {string|null} query - the SQL that produces the rows, or null for an iterator with no rows
   * @param {object} params - the query parameters
   * @param {number} [total] - the number of rows the query will return, if known. The expander
   *   reads it to refuse an over-limit whole-code-system expansion before it is materialised
   */
  constructor(query, params = {}, total = undefined) {
    this.query = query;
    this.params = params;
    this.cursor = 0;
    if (query) {
      this.results = null;
      this.executed = false;
      this.total = total;
    } else {
      // nothing to run: an empty statement isn't a no-op in node-sqlite3, it fails with
      // "SQLITE_MISUSE: not an error"
      this.results = [];
      this.executed = true;
      this.total = 0;
    }
  }

  more() {
    return this.cursor < (this.results ? this.results.length : 0);
  }

  next() {
    this.cursor++;
  }
}

class RxNormServices extends BaseCSServices {
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
    // Keep the handle: sqlite runs the queries already queued (and any their
    // callbacks issue) before it closes, and fails later ones with an error.
    // Setting it to null made such a callback throw, outside any promise.
    if (this.db && !this.dbClosed) {
      this.dbClosed = true;
      this.db.close();
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
    return (await this.#isObsolete(ctxt)) ? 'obsolete' : null;
  }

  async isInactive(context) {
    
    const ctxt = await this.#ensureContext(context);

    if (ctxt && ctxt.archived) {
      return true;
    }
    return this.#isObsolete(ctxt);
  }

  /**
   * A concept is obsolete (inactive) when its display atom is: SUPPRESS = O
   * @private
   */
  async #isObsolete(ctxt) {
    if (!ctxt) {
      return false;
    }
    if (ctxt.suppress == null) {
      const row = await this.#dbGet(
        `SELECT SUPPRESS, MIN(${DISPLAY_RANK_SQL}) AS rnk FROM rxnconso WHERE ${this.getCodeField()} = ? AND SAB = ? AND TTY <> 'SY'`,
        [ctxt.code, this.getSAB()]);
      ctxt.suppress = row && row.SUPPRESS ? row.SUPPRESS : 'N';
    }
    return ctxt.obsolete;
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
      let sql = `SELECT STR, TTY, SUPPRESS FROM rxnconso WHERE ${this.getCodeField()} = ? AND SAB = ?`;

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

    // the display is the best ranked atom (see DISPLAY_RANK_SQL), the rest are other names
    let best = null;
    for (const row of rows) {
      if (row.TTY !== 'SY' && (!best || displayRank(row.TTY) < displayRank(best.TTY))) {
        best = row;
      }
    }
    if (best) {
      concept.display = best.STR.trim();
      if (!archived) {
        concept.suppress = best.SUPPRESS || 'N';
      }
    }
    for (const row of rows) {
      const str = row.STR.trim();
      if (row !== best && str !== concept.display && !concept.others.includes(str)) {
        concept.others.push(str);
      }
    }

    return concept;
  }

  /**
   * The query for a set of concepts: one row per concept, with its display, whatever atoms
   * the conditions matched on. Every condition is about the concept (its code), not the atom
   * @param {string} conditions - SQL 'AND ...' conditions on rxnconso.<code field>
   * @param {string} [from] - more tables to join (the text search stems)
   * @returns {string}
   * @private
   */
  #conceptQuery(conditions, from = '') {
    const cf = this.getCodeField();
    return `SELECT rxnconso.${cf} AS ${cf}, STR, SUPPRESS, MIN(${DISPLAY_RANK_SQL}) AS rnk FROM rxnconso${from} ` +
      `WHERE SAB = $sab AND TTY <> 'SY' ${conditions} GROUP BY rxnconso.${cf}`;
  }

  #conceptFromRow(row) {
    const concept = new RxNormConcept(row[this.getCodeField()], row.STR);
    concept.suppress = row.SUPPRESS || 'N';
    return concept;
  }

  #dbGet(sql, params) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
    });
  }

  #dbAll(sql, params) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
    });
  }

  // Iterator methods
  async iterator(context) {
    

    if (!context) {
      // Iterate all codes
      const query = this.#conceptQuery('') + ` ORDER BY rxnconso.${this.getCodeField()}`;
      return new RxNormIteratorContext(query, { sab: this.getSAB() }, this.totalCodeCount);
    } else {
      // No hierarchical iteration for specific contexts in this implementation. The expander
      // asks every concept for its children (includeCodeAndDescendants), so this has to be an
      // iterator with no rows - not one with an empty query, which sqlite rejects
      return new RxNormIteratorContext(null, {});
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

    return this.#conceptFromRow(row);
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
  //
  // Every filter is a condition on the concept (rxnconso.<code field> IN ...), not on the atom,
  // so a concept with several atoms (SCD + PSN + TMSY...) is one result, whichever atoms matched.
  // Filters in one include are ANDed. TTY, STY, SAB, concept (or code), and the relationships
  // (REL or RELA, with CUI: or AUI: values) all take = or in; in is the union

  /**
   * @returns {string[]} the values of an = or in filter
   * @private
   */
  static #filterValues(op, value) {
    if (op === 'in') {
      return (value || '').split(',').map(v => v.trim()).filter(v => v);
    }
    return value ? [value.trim()] : [];
  }

  static #isRelValue(v) {
    return v.startsWith('CUI:') || v.startsWith('AUI:');
  }

  async doesFilter(prop, op, value) {
    if (!['=', 'in'].includes(op)) {
      return false;
    }
    const values = RxNormServices.#filterValues(op, value);
    if (values.length === 0) {
      return false;
    }
    const propUC = prop.toUpperCase();
    if (['TTY', 'STY', 'SAB'].includes(propUC) || prop === 'concept' || prop === 'code') {
      return true;
    }
    if (this.rels.includes(prop) || this.reltypes.includes(prop)) {
      return values.every(v => RxNormServices.#isRelValue(v));
    }
    return false;
  }

  // eslint-disable-next-line no-unused-vars
  async getPrepContext(iterate) {
    return new RxNormPrep();
  }

  async filter(filterContext, forIteration, prop, op, value) {
    const filter = new RxNormFilterHolder();
    const propUC = prop.toUpperCase();
    const cf = this.getCodeField();
    const values = ['=', 'in'].includes(op) ? RxNormServices.#filterValues(op, value) : [];
    // each filter gets its own parameter names, so two filters of the same kind in one
    // include don't overwrite each other's values (or the SAB the whole query is about)
    const pfx = `f${filterContext.filters.length}_`;
    const params = {};
    const list = (name, vals) => vals.map((v, i) => {
      params[`${pfx}${name}${i}`] = v;
      return `$${pfx}${name}${i}`;
    }).join(', ');

    let sql = '';
    if (values.length > 0) {
      if (propUC === 'TTY') {
        sql = `AND rxnconso.${cf} IN (SELECT ${cf} FROM rxnconso WHERE SAB = $sab AND TTY IN (${list('tty', values)}))`;
      } else if (propUC === 'STY') {
        sql = `AND rxnconso.${cf} IN (SELECT RXCUI FROM rxnsty WHERE TUI IN (${list('sty', values)}))`;
      } else if (propUC === 'SAB') {
        sql = `AND rxnconso.${cf} IN (SELECT ${cf} FROM rxnconso WHERE SAB IN (${list('sab', values)}))`;
      } else if (prop === 'concept' || prop === 'code') {
        sql = `AND rxnconso.${cf} IN (${list('code', values)})`;
      } else if ((this.rels.includes(prop) || this.reltypes.includes(prop)) && values.every(v => RxNormServices.#isRelValue(v))) {
        // RXNREL rows read 'RXCUI2 <RELA> RXCUI1': has_ingredient = CUI:161 is the concepts
        // that have acetaminophen as an ingredient. Concept-level rows: RxNorm's own (SAB=RXNORM)
        const field = this.rels.includes(prop) ? 'REL' : 'RELA';
        params[`${pfx}rel`] = prop;
        const cuis = values.filter(v => v.startsWith('CUI:')).map(v => v.substring(4));
        const auis = values.filter(v => v.startsWith('AUI:')).map(v => v.substring(4));
        const targets = [];
        if (cuis.length > 0) {
          params[`${pfx}rsab`] = RELATIONSHIP_SAB;
          targets.push(`rxnconso.${cf} IN (SELECT RXCUI2 FROM rxnrel WHERE ${field} = $${pfx}rel AND SAB = $${pfx}rsab AND RXCUI1 IN (${list('cui', cuis)}))`);
        }
        if (auis.length > 0) {
          // Atom-level rows leave RXCUI2 empty, and most come from other sources (MMSL, MTHSPL...):
          // the target atom's concept comes from rxnconso, and every source's rows count
          targets.push(`rxnconso.${cf} IN (SELECT ${cf} FROM rxnconso WHERE RXAUI IN (SELECT RXAUI2 FROM rxnrel WHERE ${field} = $${pfx}rel AND RXAUI1 IN (${list('aui', auis)})))`);
        }
        sql = `AND (${targets.join(' OR ')})`;
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
        // Unindexed, but it only ever narrows concepts the other tokens have already found,
        // and the tokens are alphanumeric, so there are no LIKE wildcards to escape. Any of
        // the concept's RxNorm names can match, as for the stems
        const cf = this.getCodeField();
        rxnormFilter.sql = ` AND EXISTS (SELECT 1 FROM rxnconso t WHERE t.${cf} = rxnconso.${cf} AND t.SAB = $sab AND t.STR LIKE $text${i})`;
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

    allParams.sab = this.getSAB();

    // Create a single filter holder with the combined query
    const combinedFilter = new RxNormFilterHolder();
    combinedFilter.conditions = sql1;
    combinedFilter.from = sql2.substring('FROM rxnconso'.length);
    combinedFilter.sql = this.#conceptQuery(sql1, combinedFilter.from);
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
    return this.#conceptFromRow(row);
  }

  async filterLocate(filterContext, set, code) {
    const cf = this.getCodeField();
    const sql = this.#conceptQuery((set.conditions || '') + ` AND rxnconso.${cf} = $code`, set.from || '');
    const params = { ...set.params, code };
    const row = await this.#dbGet(sql, this.#buildParamArray(sql, params));
    return row ? this.#conceptFromRow(row) : null;
  }

  async filterCheck(filterContext, set, concept) {
    if (!(concept instanceof RxNormConcept)) {
      return false;
    }

    if (!set.executed) {
      await this.#executeFilter(set);
    }
    if (!set.codes) {
      set.codes = new Set(set.results.map(row => row[this.getCodeField()]));
    }
    return set.codes.has(concept.code);
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

  // Subsumption testing
  async subsumesTest(codeA, codeB) {
    await this.#ensureContext(codeA);
    await this.#ensureContext(codeB);
    return 'not-subsumed'; // Not implemented yet
  }

  /**
   * The concept's properties for $expand: built by extendLookup, so that an expansion reports
   * the same properties $lookup does (see CodeSystemProvider._propertiesFromLookup)
   */
  async properties(context, names) {
    return this._propertiesFromLookup(context, names);
  }

  // Extension for lookup operation
  //
  // TTY, STY and SAB are returned unless other properties are asked for; the relationships
  // (one property per REL/RELA, valued with the bare RXCUI of the other concept, RxNorm's
  // own relationships only) only when asked for, by name or with *
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
    if (ctxt.archived) {
      return;
    }

    const cf = this.getCodeField();
    if (this._hasProp(props, 'TTY', true)) {
      const rows = await this.#dbAll(`SELECT DISTINCT TTY FROM rxnconso WHERE ${cf} = ? AND SAB = ? ORDER BY TTY`, [ctxt.code, this.getSAB()]);
      for (const row of rows) {
        this._addCodeProperty(params, 'property', 'TTY', row.TTY);
      }
    }
    if (this._hasProp(props, 'STY', true)) {
      const rows = await this.#dbAll('SELECT DISTINCT TUI FROM rxnsty WHERE RXCUI = ? ORDER BY TUI', [ctxt.code]);
      for (const row of rows) {
        this._addCodeProperty(params, 'property', 'STY', row.TUI);
      }
    }
    if (this._hasProp(props, 'SAB', true)) {
      const rows = await this.#dbAll(`SELECT DISTINCT SAB FROM rxnconso WHERE ${cf} = ? ORDER BY SAB`, [ctxt.code]);
      for (const row of rows) {
        this._addCodeProperty(params, 'property', 'SAB', row.SAB);
      }
    }
    if (props && props.length > 0) {
      const rows = await this.#dbAll(
        'SELECT DISTINCT REL, RELA, RXCUI1 FROM rxnrel WHERE RXCUI2 = ? AND SAB = ? ORDER BY RELA, REL, RXCUI1',
        [ctxt.code, RELATIONSHIP_SAB]);
      const seen = new Set();
      for (const row of rows) {
        const name = row.RELA || row.REL;
        const key = name + '|' + row.RXCUI1;
        if (name && row.RXCUI1 && !seen.has(key) && this._hasProp(props, name, false)) {
          seen.add(key);
          this._addCodeProperty(params, 'property', name, row.RXCUI1);
        }
      }
    }
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
      // indexes the importer makes now, for databases imported before it did. A one-off cost
      // the first time an older database is loaded
      for (const sql of RXNORM_LOAD_INDEXES) {
        await new Promise((resolve, reject) => {
          db.run(sql, err => err ? reject(err) : resolve());
        });
      }

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
      // concepts, not atoms
      this._sharedData.totalCodeCount = await this.#getCount(db, `SELECT COUNT(DISTINCT RXCUI) FROM rxnconso WHERE SAB = ? AND TTY <> 'SY'`, [sab]);

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

  /**
   * RxNorm codes link to RxNav (as DataRenderer.getLinkForCode in org.hl7.fhir.core). The NCI
   * code system's codes are NCI Thesaurus codes (the SCUIs of SAB NCI), which link to EVS
   * Explore: the NCIt browser link core uses now lands on EVS Explore's home page.
   */
  codeLink(context) {
    if (!context || !context.code) {
      return undefined;
    }
    const code = encodeURIComponent(context.code);
    return this.isNCI
      ? `https://evsexplore.semantics.cancer.gov/evsexplore/concept/ncit/${code}`
      : `https://mor.nlm.nih.gov/RxNav/search?searchBy=RXCUI&searchTerm=${code}`;
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