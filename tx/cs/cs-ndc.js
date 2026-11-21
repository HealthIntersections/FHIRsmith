const sqlite3 = require('sqlite3').verbose();
const assert = require('assert');
const { CodeSystem } = require('../library/codesystem');
const { CodeSystemProvider, CodeSystemFactoryProvider} = require('./cs-api');
const {validateArrayParameter} = require("../../library/utilities");
const { guarded } = require('../library/sqlite-utilities');
const { Issue } = require('../library/operation-outcome');

class NdcConcept {
  constructor(code, display, isPackage = false, key = null) {
    this.code = code;
    this.display = display;
    this.isPackage = isPackage;
    this.key = key;

    // Additional NDC-specific properties
    this.productCode = null; // For packages, the related product code
    this.code11 = null; // 11-digit version for packages
    this.active = true;
    this.category = null; // the FDA marketing category (a package's is its product's)
    this.properties = {}; // Store additional properties from database
  }
}

// when an 11 digit code belongs to more than one package: the active one, then the one seen most
// recently, then the first imported (the importer reads newer files first, listings before excluded)
const NDC_CODE11_PREFERENCE = 'pkg.Active DESC, pkg.LastSeen DESC, pkg.NDCKey';

// how many codes a filter reads from the database at a time
const NDC_FILTER_PAGE = 500;

/**
 * The version of an NDC distribution is its date as YYYYMMDD, as the HL7 page for NDC says.
 * Databases built before the importer wrote it that way have YYYY-MM-DD: that's read as the same
 * version, so they don't need to be rebuilt
 *
 * @param {string} version - the version recorded in NDCVersion
 * @returns {string} the version to report
 */
function ndcVersionName(version) {
  const s = String(version);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.replace(/-/g, '') : s;
}

// what extendLookup adds properties to: only the ones asked for get through
class NdcPropertyFilter {
  constructor(params, want) {
    this.params = params;
    this.want = want;
  }

  push(param) {
    const code = param.name === 'property' ? (param.part || []).find(p => p.name === 'code') : null;
    if (!code || this.want(code.valueCode)) {
      this.params.push(param);
    }
  }
}

class NdcServices extends CodeSystemProvider {
  constructor(opContext, supplements, db, lookupTables, packageCount, productCount, version) {
    super(opContext, supplements);
    this.db = db;
    this._version = version;
    this._lookupTables = lookupTables;
    this._packageCount = packageCount;
    this._productCount = productCount;
  }

  // Clean up database connection when provider is destroyed
  close() {
    this.closeDb();
  }

  // Metadata methods
  system() {
    return 'http://hl7.org/fhir/sid/ndc'; // NDC system URI
  }

  version() {
    return this._version;
  }

  description() {
    return 'National Drug Code (NDC) Directory';
  }

  name() {
    return 'NDC Codes';
  }

  async totalCount() {
    return this._packageCount + this._productCount;
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

    // Check supplements first
    let disp = this._displayFromSupplements(ctxt.code);
    if (disp) {
      return disp;
    }

    return ctxt.display ? ctxt.display.trim() : '';
  }

  async definition(code) {
    await this.#ensureContext(code);
    return null; // No definitions provided in NDC
  }

  async isAbstract(code) {
    await this.#ensureContext(code);
    return false; // No abstract concepts in NDC
  }

  async isInactive(code) {
    
    const ctxt = await this.#ensureContext(code);
    return ctxt ? !ctxt.active : false;
  }

  async getStatus(code) {

    const ctxt = await this.#ensureContext(code);
    return ctxt.active ? "active" : "inactive";
  }

  async isDeprecated(code) {
    await this.#ensureContext(code);
    return false; // NDC doesn't track deprecated status separately
  }

  async designations(code, displays) {
    const ctxt = await this.#ensureContext(code);

    if (ctxt) {
      // Add main display
      if (ctxt.display) {
        displays.addDesignation(true, 'active', 'en', CodeSystem.makeUseForDisplay(), ctxt.display.trim());
      }

      // Add supplement designations
      this._listSupplementDesignations(ctxt.code, displays);
    }
  }

  /**
   * The concept's properties for $expand: built by extendLookup, so that an expansion reports
   * the same properties $lookup does (see CodeSystemProvider._propertiesFromLookup)
   */
  async properties(context, names) {
    return this._propertiesFromLookup(context, names);
  }

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

    if (!(ctxt instanceof NdcConcept)) {
      throw new Error('Invalid context for NDC lookup');
    }

    // Get full data for the concept
    const fullData = await this.#getFullConceptData(ctxt);
    // the properties asked for (all of them, if none were)
    const want = (name) => !props || props.length === 0 || props.some(p => p === '*' || p.toLowerCase() === name.toLowerCase());
    params = new NdcPropertyFilter(params, want);

    // Add NDC-specific properties
    if (!ctxt.isPackage) {
      // Product properties
      this.#addProperty(params, 'code-type', 'product');
      this.#addProperty(params, 'description', fullData.display || '');
    } else {
      // Package properties
      if (ctxt.code.includes('-')) {
        this.#addProperty(params, 'code-type', '10-digit');
        // a few 11 digit codes belong to two packages (a labeler re-issued a code in another
        // configuration: 49799-0001-1 and 49799-001-01 are both 49799000101). The 11 digit code
        // means the package it resolves to; the other doesn't have it as a synonym
        if (fullData.code11 && await this.#ownsCode11(ctxt.key, fullData.code11)) {
          this.#addProperty(params, 'synonym', fullData.code11);
        }
      } else {
        this.#addProperty(params, 'code-type', '11-digit');
        if (fullData.originalCode) {
          this.#addProperty(params, 'synonym', fullData.originalCode);
        }
      }
      this.#addProperty(params, 'description', fullData.display || '');
      if (fullData.productCode) {
        this.#addProperty(params, 'product', fullData.productCode);
      }
    }

    // Common properties
    if (fullData.type && this._lookupTables.types.has(fullData.type)) {
      this.#addProperty(params, 'type', this._lookupTables.types.get(fullData.type));
    }

    this.#addProperty(params, 'active', fullData.active ? 'true' : 'false');

    if (fullData.tradeName) {
      this.#addProperty(params, 'trade-name', fullData.tradeName);
    }

    if (fullData.doseForm && this._lookupTables.doseForms.has(fullData.doseForm)) {
      this.#addProperty(params, 'dose-form', this._lookupTables.doseForms.get(fullData.doseForm));
    }

    if (fullData.route && this._lookupTables.routes.has(fullData.route)) {
      this.#addProperty(params, 'route', this._lookupTables.routes.get(fullData.route));
    }

    if (fullData.company && this._lookupTables.organizations.has(fullData.company)) {
      this.#addProperty(params, 'company', this._lookupTables.organizations.get(fullData.company));
    }

    if (fullData.category) {
      this.#addProperty(params, 'category', fullData.category);
    }

    if (fullData.generics) {
      this.#addProperty(params, 'generic', fullData.generics);
    }

    // the properties from the FDA files (NDCProperties, named as openFDA names them). A package
    // has its own (marketing dates, sample) and its product's (rxcui, application_number...)
    // (where a package and its product both have a property, the package's is the one)
    const packageNames = new Set();
    for (const row of await this.#getExtraProperties(ctxt)) {
      if (row.IsPackage) {
        packageNames.add(row.Name);
      } else if (packageNames.has(row.Name)) {
        continue;
      }
      this.#addProperty(params, row.Name, row.Value);
    }
  }

  async #ownsCode11(key, code11) {
    return new Promise((resolve, reject) => {
      this.db.get(`SELECT NDCKey FROM NDCPackages pkg WHERE Code11 = ? ORDER BY ${NDC_CODE11_PREFERENCE} LIMIT 1`, [code11],
        guarded(reject, (err, row) => err ? reject(err) : resolve(!!row && row.NDCKey === key)));
    });
  }

  async #getExtraProperties(ctxt) {
    if (!this._lookupTables.hasProperties) {
      return []; // a database from before the importer recorded properties
    }
    const sql = ctxt.isPackage
      ? `SELECT Name, Value, IsPackage FROM NDCProperties
         WHERE (IsPackage = 1 AND NDCKey = ?) OR (IsPackage = 0 AND NDCKey = (SELECT ProductKey FROM NDCPackages WHERE NDCKey = ?))
         ORDER BY IsPackage DESC, rowid`
      : 'SELECT Name, Value, IsPackage FROM NDCProperties WHERE IsPackage = 0 AND NDCKey = ? ORDER BY rowid';
    const args = ctxt.isPackage ? [ctxt.key, ctxt.key] : [ctxt.key];
    return new Promise((resolve, reject) => {
      this.db.all(sql, args, guarded(reject, (err, rows) => err ? reject(err) : resolve(rows)));
    });
  }

  #addProperty(params, name, value) {
    if (value === undefined || value === null || value === '') {
      return; // (key 1 in the lookup tables is 'no value')
    }
    // This follows the FHIR Parameters structure for lookup responses
    // Each property becomes a parameter with name='property' and sub-parameters
    const property = {
      name: 'property',
      part: [
        { name: 'code', valueCode: name },
        { name: 'value', valueString: value }
      ]
    };

    params.push(property);
  }

  async #getFullConceptData(concept) {
    return new Promise((resolve, reject) => {
      let sql, params;

      if (concept.isPackage) {
        sql = `
          SELECT p.Code as PCode, pkg.Code, pkg.Code11, pkg.Active, pkg.Description,
                 p.TradeName, p.Suffix, p.Type, p.DoseForm, p.Route, p.Company, 
                 p.Category, p.Generics
          FROM NDCProducts p
          JOIN NDCPackages pkg ON p.NDCKey = pkg.ProductKey
          WHERE pkg.NDCKey = ?
        `;
        params = [concept.key];
      } else {
        sql = `
          SELECT Code, TradeName, Suffix, Type, DoseForm, Route, Company, 
                 Category, Generics, Active
          FROM NDCProducts 
          WHERE NDCKey = ?
        `;
        params = [concept.key];
      }

      this.db.get(sql, params, guarded(reject, (err, row) => {
        if (err) {
          reject(err);
        } else if (!row) {
          resolve({});
        } else {
          const result = {
            active: row.Active === 1,
            tradeName: row.TradeName,
            suffix: row.Suffix,
            type: row.Type,
            doseForm: row.DoseForm,
            route: row.Route,
            company: row.Company,
            category: row.Category,
            generics: row.Generics
          };

          if (concept.isPackage) {
            result.productCode = row.PCode;
            result.code11 = row.Code11;
            result.originalCode = row.Code;
            result.display = this.#packageDisplay(row);
          } else {
            result.display = this.#productDisplay(row);
          }

          resolve(result);
        }
      }));
    });
  }

  #productDisplay(row) {
    const tradeName = row.TradeName || '';
    const suffix = row.Suffix || '';
    if (suffix) {
      return `${tradeName} ${suffix} (product)`.trim();
    }
    return `${tradeName} (product)`.trim();
  }

  #packageDisplay(row) {
    const tradeName = row.TradeName || '';
    const suffix = row.Suffix || '';
    const description = row.Description || '';

    let display = tradeName;
    if (suffix) {
      display += ` ${suffix}`;
    }
    if (description) {
      display += `, ${description}`;
    }
    display += ' (package)';

    return display.replace(/\s+/g, ' ').trim();
  }

  async #ensureContext(code) {
    if (!code) {
      return null;
    }
    if (typeof code === 'string') {
      const ctxt = await this.locate(code);
      if (!ctxt.context) {
        throw new Error(ctxt.message);
      } else {
        return ctxt.context;
      }
    }
    if (code instanceof NdcConcept) {
      return code;
    }
    throw new Error("Unknown Type at #ensureContext: " + (typeof code));
  }

  // Lookup methods
  async locate(code) {
    
    assert(!code || typeof code === 'string', 'code must be string');
    if (!code) return { context: null, message: 'Empty code' };

    // First try packages (both regular code and code11)
    const packageResult = await this.#locateInPackages(code);
    if (packageResult) {
      return { context: packageResult, message: null };
    }

    // Then try products
    const productResult = await this.#locateInProducts(code);
    if (productResult) {
      return { context: productResult, message: null };
    }

    return { context: null, message: undefined };
  }

  async #locateInPackages(code) {
    // Try both regular code and code11 formats
    const row = await this.#get(`
        SELECT pkg.NDCKey, pkg.Code, pkg.Code11, p.TradeName, p.Suffix, pkg.Description,
               p.Code as ProductCode, pkg.Active, p.Category
        FROM NDCPackages pkg
        JOIN NDCProducts p ON pkg.ProductKey = p.NDCKey
        WHERE pkg.Code = ? OR pkg.Code11 = ?
        ORDER BY ${NDC_CODE11_PREFERENCE}
        LIMIT 1
      `, [code, code]);
    return row ? this.#packageConcept(code, row) : null;
  }

  #packageConcept(code, row) {
    const concept = new NdcConcept(code, this.#packageDisplay(row), true, row.NDCKey);
    concept.productCode = row.ProductCode;
    concept.code11 = row.Code11;
    concept.active = row.Active === 1;
    concept.category = row.Category;
    return concept;
  }

  #productConcept(code, row) {
    const concept = new NdcConcept(code, this.#productDisplay(row), false, row.NDCKey);
    concept.active = row.Active === 1;
    concept.category = row.Category;
    return concept;
  }

  async #locateInProducts(code) {
    const row = await this.#get('SELECT NDCKey, Code, TradeName, Suffix, Active, Category FROM NDCProducts WHERE Code = ? LIMIT 1', [code]);
    return row ? this.#productConcept(code, row) : null;
  }

  // Filters. Besides the standard ones HL7 says apply to NDC:
  //   inactive = true|false                  whether the code is still listed
  //   kind = product|package                 the two kinds of NDC code
  //   category = {value}, category in {a,b}  the FDA marketing category (a package's is its product's)
  //   code-type = product|10-digit|11-digit  (as before)
  // A filter selects products, packages or both. Products come first, in import order (NDCKey),
  // then packages, so an expansion's codes are always in the same order
  async doesFilter(prop, op, value) {
    return this.#filterSpec(prop, op, value) !== null;
  }

  /**
   * What a filter selects: whether products and/or packages, the SQL conditions on each
   * (p = NDCProducts, pkg = NDCPackages), and a test of a located concept. null if not supported
   */
  #filterSpec(prop, op, value) {
    const v = value === undefined || value === null ? '' : String(value);
    switch (prop) {
      case 'inactive': {
        if (op !== '=' || !['true', 'false'].includes(v)) return null;
        const active = v === 'false' ? 1 : 0;
        return {
          products: true, packages: true,
          productWhere: 'p.Active = ?', productArgs: [active],
          packageWhere: 'pkg.Active = ?', packageArgs: [active],
          check: (c) => c.active === (active === 1)
        };
      }
      case 'kind': {
        if (op !== '=' || !['product', 'package'].includes(v)) return null;
        const pkg = v === 'package';
        return { products: !pkg, packages: pkg, check: (c) => c.isPackage === pkg };
      }
      case 'category': {
        let values;
        if (op === '=') {
          values = [v];
        } else if (op === 'in') {
          values = v.split(',').map(s => s.trim()).filter(s => s);
        } else {
          return null;
        }
        if (values.length === 0 || values.some(s => !s)) return null;
        const marks = values.map(() => '?').join(', ');
        return {
          products: true, packages: true,
          productWhere: `p.Category IN (${marks})`, productArgs: values,
          packageWhere: `p.Category IN (${marks})`, packageArgs: values,
          check: (c) => values.includes(c.category)
        };
      }
      case 'code-type': {
        if (op !== '=' || !['10-digit', '11-digit', 'product'].includes(v)) return null;
        if (v === 'product') {
          return { products: true, packages: false, check: (c) => !c.isPackage };
        }
        const hyphen = v === '10-digit';
        return {
          products: false, packages: true, code11: !hyphen,
          // an 11 digit code shared by two packages is listed once, as the package it resolves to
          packageWhere: hyphen ? null : `pkg.NDCKey = (SELECT o.NDCKey FROM NDCPackages o WHERE o.Code11 = pkg.Code11 ORDER BY ${NDC_CODE11_PREFERENCE.replace(/pkg\./g, 'o.')} LIMIT 1)`,
          check: (c) => c.isPackage && c.code.includes('-') === hyphen
        };
      }
      default:
        return null;
    }
  }

  async filter(filterContext, forIteration, prop, op, value) {
    const spec = this.#filterSpec(prop, op, value);
    if (!spec) {
      throw new Issue('error', 'not-supported', null, 'FILTER_NOT_UNDERSTOOD',
        this.opContext.i18n.translate('FILTER_NOT_UNDERSTOOD', this.opContext.langs, [prop, op, value]), 'vs-invalid', 422);
    }
    const set = { property: prop, op, value, spec, _iterator: null };
    filterContext.filters.push(set);
    return set;
  }

  async executeFilters(filterContext) {
    return filterContext.filters;
  }

  #productSql(spec, select) {
    const where = spec.productWhere ? ` AND ${spec.productWhere}` : '';
    return { sql: `SELECT ${select} FROM NDCProducts p WHERE 1 = 1${where}`, args: spec.productArgs || [] };
  }

  #packageSql(spec, select) {
    const where = [spec.packageWhere].filter(w => w).map(w => ` AND ${w}`).join('');
    return {
      sql: `SELECT ${select} FROM NDCPackages pkg JOIN NDCProducts p ON pkg.ProductKey = p.NDCKey WHERE 1 = 1${where}`,
      args: spec.packageArgs || []
    };
  }

  #get(sql, args) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, args, guarded(reject, (err, row) => err ? reject(err) : resolve(row)));
    });
  }

  #all(sql, args) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, args, guarded(reject, (err, rows) => err ? reject(err) : resolve(rows)));
    });
  }

  async filterSize(filterContext, set) {
    let count = 0;
    if (set.spec.products) {
      const q = this.#productSql(set.spec, 'COUNT(*) AS count');
      count += (await this.#get(q.sql, q.args)).count;
    }
    if (set.spec.packages) {
      const q = this.#packageSql(set.spec, 'COUNT(*) AS count');
      count += (await this.#get(q.sql, q.args)).count;
    }
    return count;
  }

  // the next page of a filter's codes: products, then packages, each in NDCKey order
  async #fillFilterPage(set) {
    const it = set._iterator;
    const spec = set.spec;
    while (it.buffer.length === 0 && it.stage < 2) {
      const products = it.stage === 0;
      if ((products && !spec.products) || (!products && !spec.packages)) {
        it.stage++;
        it.lastKey = 0;
        continue;
      }
      const q = products
        ? this.#productSql(spec, 'p.NDCKey, p.Code, p.TradeName, p.Suffix, p.Active, p.Category')
        : this.#packageSql(spec, 'pkg.NDCKey, pkg.Code, pkg.Code11, p.TradeName, p.Suffix, pkg.Description, pkg.Active, p.Code AS ProductCode, p.Category');
      const key = products ? 'p.NDCKey' : 'pkg.NDCKey';
      const rows = await this.#all(`${q.sql} AND ${key} > ? ORDER BY ${key} LIMIT ${NDC_FILTER_PAGE}`, [...q.args, it.lastKey]);
      for (const row of rows) {
        it.buffer.push(products ? this.#productConcept(row.Code, row) : this.#packageConcept(spec.code11 ? row.Code11 : row.Code, row));
      }
      if (rows.length > 0) {
        it.lastKey = rows[rows.length - 1].NDCKey;
      }
      if (rows.length < NDC_FILTER_PAGE) {
        it.stage++;
        it.lastKey = 0;
      }
    }
  }

  async filterMore(filterContext, set) {
    if (!set._iterator) {
      set._iterator = { stage: 0, lastKey: 0, buffer: [] };
    }
    await this.#fillFilterPage(set);
    return set._iterator.buffer.length > 0;
  }

  async filterConcept(filterContext, set) {
    if (!(await this.filterMore(filterContext, set))) {
      return null;
    }
    return set._iterator.buffer.shift();
  }

  async filterLocate(filterContext, set, code) {
    const located = await this.locate(code);
    if (!located.context) {
      return located.message;
    }
    // not in the filter: null (the value set check reports it)
    return set.spec.check(located.context) ? located.context : null;
  }

  async filterCheck(filterContext, set, concept) {
    if (!(concept instanceof NdcConcept)) {
      return false;
    }
    return set.spec.check(concept);
  }

  // Iterator methods - not supported for NDC

  versionAlgorithm() {
    return 'date';
  }
}

class NdcServicesFactory extends CodeSystemFactoryProvider {
  /**
   * @param {Object} [options] - {readOnly: true} in a tx-worker (cluster.md): the file is
   *   the master's; this process opens it read-only
   */
  constructor(i18n, dbPath, options = {}) {
    super(i18n);
    this.dbPath = dbPath;
    this.readOnly = !!options.readOnly;
    this.uses = 0;
    this._loaded = false;
    this._lookupTables = null;
    this._packageCount = null;
    this._productCount = null;
    this._version = null;
  }

  system() {
    return 'http://hl7.org/fhir/sid/ndc'; // NDC system URI
  }

  version() {
    return this._version;
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

  #open() {
    return this.readOnly ? new sqlite3.Database(this.dbPath, sqlite3.OPEN_READONLY) : new sqlite3.Database(this.dbPath);
  }

  async load() {
    // Use temporary database connection for loading
    const tempDb = this.#open();

    try {
      // Load version
      this._version = await new Promise((resolve, reject) => {
        tempDb.get('SELECT Version FROM NDCVersion ORDER BY Version DESC LIMIT 1', guarded(reject, (err, row) => {
          if (err) reject(err);
          else resolve(row ? ndcVersionName(row.Version) : 'unknown');
        }));
      });

      // Initialize lookup tables
      this._lookupTables = {
        types: new Map(),
        organizations: new Map(),
        doseForms: new Map(),
        routes: new Map()
      };

      // Load lookup tables
      const tables = [
        { name: 'types', sql: 'SELECT NDCKey, Name FROM NDCProductTypes' },
        { name: 'organizations', sql: 'SELECT NDCKey, Name FROM NDCOrganizations' },
        { name: 'doseForms', sql: 'SELECT NDCKey, Name FROM NDCDoseForms' },
        { name: 'routes', sql: 'SELECT NDCKey, Name FROM NDCRoutes' }
      ];

      for (const table of tables) {
        await new Promise((resolve, reject) => {
          tempDb.all(table.sql, guarded(reject, (err, rows) => {
            if (err) reject(err);
            else {
              const map = this._lookupTables[table.name];
              rows.forEach(row => map.set(row.NDCKey, row.Name));
              resolve();
            }
          }));
        });
      }

      // databases from before the importer recorded properties don't have NDCProperties
      this._lookupTables.hasProperties = await new Promise((resolve, reject) => {
        tempDb.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'NDCProperties'", guarded(reject, (err, row) => {
          if (err) reject(err);
          else resolve(!!row);
        }));
      });

      // Load counts
      this._packageCount = await new Promise((resolve, reject) => {
        tempDb.get('SELECT COUNT(NDCKey) as count FROM NDCPackages', guarded(reject, (err, row) => {
          if (err) reject(err);
          else resolve(row.count);
        }));
      });

      this._productCount = await new Promise((resolve, reject) => {
        tempDb.get('SELECT COUNT(NDCKey) as count FROM NDCProducts', guarded(reject, (err, row) => {
          if (err) reject(err);
          else resolve(row.count);
        }));
      });

    } finally {
      tempDb.close();
    }
    this._loaded = true;
  }

  defaultVersion() {
    return this._version || 'unknown';
  }

  async build(opContext, supplements) {
    
    this.recordUse();

    // Create fresh database connection for this provider instance
    const db = this.#open();

    return new NdcServices(
      opContext, supplements,
      db,
      this._lookupTables,
      this._packageCount,
      this._productCount,
      this._version
    );
  }

  useCount() {
    return this.uses;
  }

  recordUse() {
    this.uses++;
  }

  name() {
    return 'NDC Codes';
  }


  id() {
    return "ndc";
  }
}

module.exports = {
  NdcServices,
  NdcServicesFactory,
  NdcConcept,
  ndcVersionName
};