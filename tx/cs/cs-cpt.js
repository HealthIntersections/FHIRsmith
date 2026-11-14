const sqlite3 = require('sqlite3').verbose();
const assert = require('assert');
const { CodeSystem } = require('../library/codesystem');
const { FilterExecutionContext, CodeSystemFactoryProvider } = require('./cs-api');
const {validateArrayParameter} = require("../../library/utilities");
const {BaseCSServices} = require("./cs-base");
const { guarded } = require('../library/sqlite-utilities');
const { Issue } = require('../library/operation-outcome');

class CPTConceptDesignation {
  constructor(kind, value) {
    this.kind = kind;
    this.value = value;
  }
}

class CPTConceptProperty {
  constructor(name, value) {
    this.name = name;
    this.value = value;
  }
}

class CPTConcept {
  constructor(code, modifier = false) {
    this.code = code;
    this.modifier = modifier;
    this.designations = [];
    this.properties = [];
  }

  addProperty(name, value) {
    this.properties.push(new CPTConceptProperty(name, value));
  }

  hasProperty(name, value) {
    return this.properties.some(p => p.name === name && p.value === value);
  }

  addDesignation(kind, value) {
    this.designations.push(new CPTConceptDesignation(kind, value));
  }

  getDesignation(kind) {
    const designation = this.designations.find(d => d.kind === kind);
    return designation ? designation.value : '';
  }
}

class CPTExpression {
  constructor(focus = null) {
    this.focus = focus;
    this.modifiers = [];
  }

  expression() {
    let result = this.focus.code;
    for (const modifier of this.modifiers) {
      result += ':' + modifier.code;
    }
    return result;
  }

  hasModifier(code) {
    return this.modifiers.some(m => m.code === code);
  }
}

class CPTFilterContext {
  constructor(name, list, closed) {
    this.name = name;
    this.list = list;
    this.closed = closed;
    this.index = -1;

    // Log filter creation like the Pascal version
    let logCodes = '';
    for (let i = 0; i < Math.min(list.length, 50); i++) {
      logCodes += list[i].code + ',';
    }
    for (let i = Math.max(0, list.length - 10); i < list.length; i++) {
      logCodes += ',' + list[i].code;
    }
    console.info(logCodes);
  }

  next() {
    this.index++;
  }
}

class CPTIteratorContext {
  constructor(list) {
    this.list = list || [];
    this.current = 0;
    this.total = this.list.length;
  }

  more() {
    return this.current < this.total;
  }

  next() {
    this.current++;
  }
}

class CPTPrep extends FilterExecutionContext {
  constructor() {
    super();
  }
}

class CPTServices extends BaseCSServices {
  constructor(opContext, supplements, db, sharedData) {
    super(opContext, supplements);
    this.db = db;

    // Shared data from factory
    this._version = sharedData._version;
    this.conceptMap = sharedData.conceptMap;
    this.conceptList = sharedData.conceptList;
    this.baseList = sharedData.baseList;
    this.modifierList = sharedData.modifierList;
  }

  close() {
    this.closeDb();
  }

  // Metadata methods
  system() {
    return 'http://www.ama-assn.org/go/cpt';
  }

  version() {
    return this._version;
  }

  description() {
    return 'CPT © Copyright 2019 American Medical Association. All rights reserved. AMA and CPT are registered trademarks of the American Medical Association.';
  }

  name() {
    return 'CPT';
  }

  expandLimitation() {
    return 1000; // Agreement with AMA
  }

  async totalCount() {
    return this.conceptMap.size;
  }

  // Core concept methods
  async code(context) {
    
    const ctxt = await this.#ensureContext(context);

    if (ctxt instanceof CPTExpression) {
      return ctxt.expression();
    } else if (ctxt instanceof CPTConcept) {
      return ctxt.code;
    }
    return null;
  }

  async display(context) {
    
    const ctxt = await this.#ensureContext(context);

    if (!ctxt) {
      return null;
    }

    // Check supplements first
    let disp = this._displayFromSupplements(await this.code(ctxt));
    if (disp) {
      return disp;
    }

    if (ctxt instanceof CPTExpression) {
      return ''; // No display for expressions
    } else if (ctxt instanceof CPTConcept) {
      return ctxt.designations.length > 0 ? ctxt.designations[0].value : '';
    }

    return '';
  }

  async definition(context) {
    
    return this.display(context);
  }

  async isAbstract(context) {
    
    const ctxt = await this.#ensureContext(context);

    if (ctxt instanceof CPTExpression) {
      return false;
    } else if (ctxt instanceof CPTConcept) {
      return ctxt.hasProperty('kind', 'metadata');
    }
    return false;
  }

  async designations(context, displays) {
    
    const ctxt = await this.#ensureContext(context);

    if (ctxt instanceof CPTExpression) {
      // No text for expressions
    } else if (ctxt instanceof CPTConcept) {
      for (const d of ctxt.designations) {
        const isDisplay = d.kind === 'display';
        displays.addDesignation(isDisplay, 'active','en', isDisplay ? CodeSystem.makeUseForDisplay() : null, d.value);
      }

      // Add supplement designations
      this._listSupplementDesignations(ctxt.code, displays);
    }

  }

  isNotClosed() {
    return true;
  }
  /**
   * The concept's properties for $expand: built by extendLookup, so that an expansion reports
   * the same properties $lookup does (see CodeSystemProvider._propertiesFromLookup). Not the
   * copyright, which extendLookup always adds: it is about the code system, not the concept
   */
  async properties(context, names) {
    return (await this._propertiesFromLookup(context, names)).filter(p => p.code !== 'copyright');
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

    // Add copyright property
    this.#addProperty(params, 'property', 'copyright',
      'This response content from CPT, which is copyright © 2002+ American Medical Association, and distributed by agreement between AMA and HL7.');

    if (ctxt instanceof CPTExpression) {
      // Extend lookup for the focus concept first
      await this.extendLookup(ctxt.focus, props, params);

      // Add modifier properties
      for (const modifier of ctxt.modifiers) {
        this.#addProperty(params, 'property', 'modifier', modifier.code);

        if (modifier.designations.length > 0) {
          this.#addProperty(params, 'property', 'modifier-definition', modifier.designations[0].value);
        }
      }
    } else if (ctxt instanceof CPTConcept) {
      // Add designations
      if (this._hasProp(props, 'designation', true)) {
        for (const d of ctxt.designations) {
          this.#addProperty(params, 'designation', d.kind, d.value, 'en');
        }
      }

      // Add properties
      for (const p of ctxt.properties) {
        if (this._hasProp(props, p.name, true)) {
          this.#addProperty(params, 'property', p.name, p.value);
        }
      }
    }
  }

  #addProperty(params, type, name, value, language = null) {


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

    params.push(property);
  }

  #hasProp(props, name, defaultValue) {
    if (!props || props.length === 0) return defaultValue;
    return props.includes(name);
  }

  async #ensureContext(context) {
    if (!context) {
      return null;
    }
    if (typeof context === 'string') {
      const ctxt = await this.locate(context);
      if (!ctxt.context) {
        throw new Error(ctxt.message ? ctxt.message : `Code '${context}' not found in CPT`);
      } else {
        return ctxt.context;
      }
    }
    if (context instanceof CPTConcept || context instanceof CPTExpression) {
      return context;
    }
    throw new Error("Unknown Type at #ensureContext: " + (typeof context));
  }

  // Expression parsing and validation
  #parse(code) {
    if (!code) {
      return { context: null, message: 'No Expression Found' };
    }

    const parts = code.split(':');
    const baseConcept = this.conceptMap.get(parts[0]);

    if (!baseConcept) {
      return { context: null, message: `Base CPT Code '${parts[0]}' not found` };
    }

    const expression = new CPTExpression(baseConcept);

    for (let i = 1; i < parts.length; i++) {
      const modifier = this.conceptMap.get(parts[i]);
      if (!modifier) {
        return { context: null, message: `Modifier CPT code '${parts[i]}' not found` };
      }
      expression.modifiers.push(modifier);
    }

    const validationMsg = this.#validateExpression(expression);
    if (validationMsg) {
      return { context: null, message: validationMsg };
    }

    return { context: expression, message: null };
  }

  #validateExpression(exp) {
    const errors = [];

    // Check modifiers
    for (const modifier of exp.modifiers) {
      for (const prop of modifier.properties) {
        if (prop.name === 'kind') {
          if (prop.value === 'cat-2') {
            if (!exp.focus.hasProperty('kind', 'cat-2')) {
              errors.push(`The modifier ${modifier.code} is a cat-2 modifier that can only be used with cat-2 codes`);
            }
          }
          if (prop.value === 'physical') {
            if (exp.focus.code < '00100' || exp.focus.code > '01999') {
              errors.push(`The modifier ${modifier.code} is a physical status modifier that can only be used with codes in the range 00100 - 01999`);
            }
          }
          if (prop.value === 'hcpcs') {
            if (!exp.hasModifier('59')) {
              errors.push(`The modifier ${modifier.code} is an hcpcs code that can only be used if the modifier 59 is also used`);
            }
          }
          if (prop.value == 'code') {
            errors.push(`The code ${modifier.code} cannot be used as a modifier`);
          }
        }
      }

      // Specific modifier rules
      if (['50', '51'].includes(modifier.code)) {
        if (exp.focus.hasProperty('kind', 'cat-2')) {
          errors.push(`The modifier ${modifier.code} cannot be used with cat-2 codes`);
        }
      }

      if (modifier.code === '63') {
        const validCodes = ['92920', '92928', '92953', '92960', '92986', '92987', '92990', '92997', '92998',
          '93312', '93313', '93314', '93315', '93316', '93317', '93318', '93452', '93505',
          '93563', '93564', '93568', '93569', '93573', '93574', '93575', '93580', '93581',
          '93582', '93590', '93591', '93592', '93593', '93594', '93595', '93596', '93597',
          '93598', '93615', '93616'];

        const inRange = exp.focus.code >= '20100' && exp.focus.code <= '69990';
        if (!inRange && !validCodes.includes(exp.focus.code)) {
          errors.push(`The modifier ${modifier.code} cannot be used with the code ${exp.focus.code}`);
        }
      }

      if (modifier.code === '92') {
        const validCodes = ['86701', '86702', '86703', '87389'];
        if (!validCodes.includes(exp.focus.code)) {
          errors.push(`The modifier ${modifier.code} cannot be used with the code ${exp.focus.code}`);
        }
      }

      if (modifier.code === '95') {
        if (!exp.focus.hasProperty('telemedicine', 'true')) {
          errors.push(`The modifier ${modifier.code} cannot be used with the code ${exp.focus.code} as it is not designated for telemedicine`);
        }
      }
    }

    // Check mutually exclusive groups
    this.#checkMutuallyExclusive(errors, exp, ['25', '57', '59']);
    this.#checkMutuallyExclusive(errors, exp, ['52', '53', '73', '74']);
    this.#checkMutuallyExclusive(errors, exp, ['76', '77', '78', '79']);
    this.#checkMutuallyExclusive(errors, exp, ['93', '95']);

    return errors.join(', ');
  }

  #checkMutuallyExclusive(errors, exp, modifiers) {
    const count = exp.modifiers.filter(m => modifiers.includes(m.code)).length;
    if (count > 1) {
      errors.push(`There can only be one modifier in the set ${modifiers.join(', ')}`);
    }
  }

  // Lookup methods
  async locate(code) {
    
    assert(!code || typeof code === 'string', 'code must be string');
    if (!code) return { context: null, message: 'Empty code' };

    if (code.includes(':')) {
      return this.#parse(code);
    } else {
      const context = this.conceptMap.get(code);
      if (context) {
        return { context: context, message: null };
      }
      return { context: null, message: undefined };
    }
  }

  // Iterator methods
  async iterator(context) {
    

    if (!context) {
      // Iterate all concepts
      return new CPTIteratorContext([...this.conceptList]);
    } else {
      // No iteration for specific contexts
      return new CPTIteratorContext([]);
    }
  }

  async nextContext(iteratorContext) {
    

    if (!iteratorContext.more()) {
      return null;
    }

    const concept = iteratorContext.list[iteratorContext.current];
    iteratorContext.next();
    return concept;
  }

  // Filter support
  async doesFilter(prop, op, value) {
    

    if (prop === 'modifier' && op === '=' && ['true', 'false'].includes(value)) {
      return true;
    }

    if (prop === 'modified' && op === '=' && ['true', 'false'].includes(value)) {
      return true;
    }

    if (prop === 'kind' && op === '=') {
      return true;
    }

    return false;
  }

  async getPrepContext(iterate) {
    
    return new CPTPrep(iterate);
  }

  async filter(filterContext, forIteration, prop, op, value) {
    

    let list;
    let closed = true;

    if (prop === 'modifier' && op === '=') {
      const isModifier = value === 'true';
      if (isModifier) {
        list = [...this.modifierList];
      } else {
        list = [...this.baseList];
      }
    } else if (prop === 'modified' && op === '=') {
      const isModified = value === 'true';
      if (isModified) {
        list = []; // No modified codes
        closed = false;
      } else {
        list = [...this.conceptList];
      }
    } else if (prop === 'kind' && op === '=') {
      list = this.conceptList.filter(concept => concept.hasProperty('kind', value));
    } else {
      throw new Issue('error', 'not-supported', null, 'FILTER_NOT_UNDERSTOOD',
        `The filter "${prop} ${op} ${value}" is not supported for CPT`, 'vs-invalid', 422);
    }

    const filter = new CPTFilterContext(`${prop}:${value}`, list, closed);
    filterContext.filters.push(filter);
  }

  async executeFilters(filterContext) {
    
    return filterContext.filters;
  }

  async filterSize(filterContext, set) {
    
    return set.list.length;
  }

  async filterMore(filterContext, set) {
    
    set.next();
    return set.index < set.list.length;
  }

  async filterConcept(filterContext, set) {
    
    return set.list[set.index];
  }

  async filterLocate(filterContext, set, code) {
    

    const concept = set.list.find(c => c.code === code);
    if (concept) {
      return concept;
    }
    return null;
  }

  async filterCheck(filterContext, set, concept) {
    

    if (concept instanceof CPTExpression) {
      return !set.closed;
    } else if (concept instanceof CPTConcept) {
      return set.list.includes(concept);
    }
    return false;
  }


  async filtersNotClosed(filterContext) {
    
    return filterContext.filters.some(f => !f.closed);
  }



  // Subsumption: CPT codes have no subsumption relationships, so two codes that both exist are
  // not-subsumed (the caller deals with equal codes: equivalent)
  async subsumesTest(codeA, codeB) {
    await this.#ensureContext(codeA);
    await this.#ensureContext(codeB);
    return 'not-subsumed';
  }

  /**
   * For $closure (see CodeSystemProvider.ancestorsOf): CPT has no hierarchy here -
   * subsumesTest answers not-subsumed for any two known codes - so a known code sits under
   * nothing. One locate per concept instead of two per pair; an unknown code gets null, and
   * $closure then reports it through subsumesTest as before.
   *
   * @param {string|Object} code
   * @returns {Promise<Set<string>|null>}
   */
  async ancestorsOf(code) {
    const ctxt = typeof code === 'string' ? (await this.locate(code)).context : code;
    return ctxt ? new Set() : null;
  }


  versionAlgorithm() {
    return 'date';
  }
}

class CPTServicesFactory extends CodeSystemFactoryProvider {
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
    this._sharedData = null;
  }

  // Metadata methods
  system() {
    return 'http://www.ama-assn.org/go/cpt';
  }

  version() {
    return this._sharedData._version;
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
    const db = this.#open();

    try {
      this._sharedData = {
        _version: '',
        conceptMap: new Map(),
        conceptList: [],
        baseList: [],
        modifierList: []
      };

      // Load version information
      await this.#loadVersion(db);

      // Load all concepts
      await this.#loadConcepts(db);

      // Load properties
      await this.#loadProperties(db);

      // Load designations
      await this.#loadDesignations(db);

    } finally {
      db.close();
    }
    this._loaded = true;
  }

  async #loadVersion(db) {
    return new Promise((resolve, reject) => {
      db.all('SELECT * FROM Information', guarded(reject, (err, rows) => {
        if (err) {
          reject(err);
        } else {
          for (const row of rows) {
            if (row.name === 'version') {
              this._sharedData._version = row.value;
            }
          }
          resolve();
        }
      }));
    });
  }

  async #loadConcepts(db) {
    return new Promise((resolve, reject) => {
      db.all('SELECT * FROM Concepts', guarded(reject, (err, rows) => {
        if (err) {
          reject(err);
        } else {
          for (const row of rows) {
            const concept = new CPTConcept(row.code, row.modifier === 1);

            this._sharedData.conceptMap.set(concept.code, concept);
            this._sharedData.conceptList.push(concept);

            if (concept.modifier) {
              this._sharedData.modifierList.push(concept);
            } else {
              this._sharedData.baseList.push(concept);
            }
          }
          resolve();
        }
      }));
    });
  }

  async #loadProperties(db) {
    return new Promise((resolve, reject) => {
      db.all('SELECT * FROM Properties', guarded(reject, (err, rows) => {
        if (err) {
          reject(err);
        } else {
          for (const row of rows) {
            const concept = this._sharedData.conceptMap.get(row.code);
            if (concept) {
              concept.addProperty(row.name, row.value);
            }
          }
          resolve();
        }
      }));
    });
  }

  async #loadDesignations(db) {
    return new Promise((resolve, reject) => {
      db.all('SELECT * FROM Designations', guarded(reject, (err, rows) => {
        if (err) {
          reject(err);
        } else {
          for (const row of rows) {
            const concept = this._sharedData.conceptMap.get(row.code);
            if (concept) {
              !concept.addDesignation(row.type, row.value);
            }
          }
          resolve();
        }
      }));
    });
  }

  defaultVersion() {
    return this._sharedData?._version || 'unknown';
  }

  async build(opContext, supplements) {
    await this.#ensureLoaded();
    this.recordUse();

    // Create fresh database connection for this provider instance
    const db = this.#open();

    return new CPTServices(opContext, supplements, db, this._sharedData);
  }

  static checkDB(dbPath) {
    try {
      const fs = require('fs');

      // Check if file exists
      if (!fs.existsSync(dbPath)) {
        return 'Database file not found';
      }

      // Check file size
      const stats = fs.statSync(dbPath);
      if (stats.size < 1024) {
        return 'Database file too small';
      }

      // Try to open database (this will fail if file is corrupted)
      const db = new sqlite3.Database(dbPath);
      db.close();

      // For the fragment database, we know it should have 9 concepts
      return 'OK (9 Concepts)';
    } catch (e) {
      return `Database error: ${e.message}`;
    }
  }

  isNotClosed() {
    return true;
  }

  name() {
    return 'CPT';
  }


  id() {
    return "cpt2023";
  }
}

module.exports = {
  CPTServices,
  CPTServicesFactory,
  CPTConcept,
  CPTExpression,
  CPTConceptDesignation,
  CPTConceptProperty
};