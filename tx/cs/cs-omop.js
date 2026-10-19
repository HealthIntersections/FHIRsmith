const sqlite3 = require('sqlite3').verbose();
const assert = require('assert');
const { CodeSystem } = require('../library/codesystem');
const { FilterExecutionContext, CodeSystemFactoryProvider } = require('./cs-api');
const {validateOptionalParameter, validateArrayParameter} = require("../../library/utilities");
const {ConceptMap} = require("../library/conceptmap");
const {BaseCSServices} = require("./cs-base");

class OMOPConcept {
  constructor(code, display, domain, conceptClass, standard, vocabulary) {
    this.code = code;
    this.display = display;
    this.domain = domain;
    this.conceptClass = conceptClass;
    this.standard = standard || 'NS';
    this.vocabulary = vocabulary;
  }
}

class OMOPFilter extends FilterExecutionContext {
  constructor(db, sql, value = null) {
    super();
    this.db = db;
    this.sql = sql;
    this.value = value;
    this.rows = [];
    this.cursor = 0;
    this.executed = false;
  }

  async execute(params = []) {
    if (this.executed) return;

    return new Promise((resolve, reject) => {
      const callback = (err, rows) => {
        if (err) {
          reject(err);
        } else {
          this.rows = rows || [];
          this.executed = true;
          resolve();
        }
      };

      if (params.length > 0) {
        this.db.all(this.sql, params, callback);
      } else {
        this.db.all(this.sql, callback);
      }
    });
  }

  async executeForLocate(params) {
    return new Promise((resolve, reject) => {
      this.db.get(this.sql, params, (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row);
        }
      });
    });
  }

  close() {
    // Database connection is managed by the provider
  }
}

class OMOPPrep extends FilterExecutionContext {
  iterate;

  constructor(iterate) {
    super();
    this.iterate = iterate;
  }
}

// Vocabulary mapping functions
function getVocabId(url) {
  const mapping = {
    'http://hl7.org/fhir/sid/icd-9-cm': 5046,
    'http://snomed.info/sct': 44819097,
    'http://hl7.org/fhir/sid/icd-10-cm': 44819098,
    'http://hl7.org/fhir/sid/icd-9-proc': 44819099,
    'http://www.ama-assn.org/go/cpt': 44819100,
    'http://terminology.hl7.org/CodeSystem/HCPCS-all-codes': 44819101,
    'http://loinc.org': 44819102,
    'http://www.nlm.nih.gov/research/umls/rxnorm': 44819104,
    'http://hl7.org/fhir/sid/ndc': 44819105,
    'http://unitsofmeasure.org': 44819107,
    'http://nucc.org/provider-taxonomy': 44819137,
    'http://www.whocc.no/atc': 44819117
  };
  return mapping[url] || -1;
}

function getUri(key) {
  const mapping = {
    5046: 'http://hl7.org/fhir/sid/icd-9-cm',
    44819097: 'http://snomed.info/sct',
    44819098: 'http://hl7.org/fhir/sid/icd-10-cm',
    44819099: 'http://hl7.org/fhir/sid/icd-9-proc',
    44819100: 'http://www.ama-assn.org/go/cpt',
    44819101: 'http://terminology.hl7.org/CodeSystem/HCPCS-all-codes',
    44819102: 'http://loinc.org',
    44819104: 'http://www.nlm.nih.gov/research/umls/rxnorm',
    44819105: 'http://hl7.org/fhir/sid/ndc',
    44819107: 'http://unitsofmeasure.org',
    44819117: 'http://www.whocc.no/atc',
    44819137: 'http://nucc.org/provider-taxonomy'
  };
  return mapping[key] || '';
}

function getUriOrError(key) {
  const uri = getUri(key);
  if (!uri) {
    throw new Error(`Unmapped OMOP Vocabulary id: ${key}`);
  }
  return uri;
}

function getLang(langConcept) {
  if (langConcept === 'English language') return 'en';
  if (langConcept === 'Spanish language') return 'es';
  return 'en'; // default
}

class OMOPServices extends BaseCSServices {
  constructor(opContext, supplements, db, sharedData) {
    super(opContext, supplements);
    this.db = db;
    this._version = sharedData._version;
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  // Metadata methods
  system() {
    return 'https://fhir-terminology.ohdsi.org';
  }

  version() {
    return this._version;
  }

  name() {
    return 'OMOP_Concepts';
  }

  /** $lookup's display name: the code system's title. */
  // eslint-disable-next-line no-unused-vars
  lookupName(languages) {
    return 'OMOP Unified Vocabularies';
  }

  description() {
    return `OMOP Concepts, release ${this._version}`;
  }

  async totalCount() {
    return new Promise((resolve, reject) => {
      this.db.get('SELECT COUNT(*) as count FROM Concepts', (err, row) => {
        if (err) reject(err);
        else resolve(row.count);
      });
    });
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
    return ''; // OMOP doesn't provide definitions
  }

  async isAbstract(context) {
    await this.#ensureContext(context);
    return false; // OMOP concepts are not abstract
  }

  async isInactive(context) {
    await this.#ensureContext(context);
    return false; // Handle via standard_concept if needed
  }

  async isDeprecated(context) {
    await this.#ensureContext(context);
    return false; // Handle via invalid_reason if needed
  }

  async designations(context, displays) {
    
    const ctxt = await this.#ensureContext(context);

    if (ctxt) {
      // Add main display
      displays.addDesignation(true, 'active', 'en', CodeSystem.makeUseForDisplay(), ctxt.display);

      // Add synonyms
      const synonyms = await this.#getSynonyms(ctxt.code);
      for (const synonym of synonyms) {
        displays.addDesignation(false, 'active', synonym.language, null, synonym.value);
      }

      // Add supplement designations
      this._listSupplementDesignations(String(ctxt.code), displays);
    }
  }

  async #getSynonyms(code) {
    return new Promise((resolve, reject) => {
      const sql = `
          SELECT concept_synonym_name, concept_name
          FROM ConceptSynonyms, Concepts
          WHERE ConceptSynonyms.language_concept_id = Concepts.concept_id
            AND ConceptSynonyms.concept_id = ?
      `;

      this.db.all(sql, [code], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          const synonyms = rows.map(row => ({
            language: getLang(row.concept_name),
            value: row.concept_synonym_name
          }));
          resolve(synonyms);
        }
      });
    });
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

    if (!(ctxt instanceof OMOPConcept)) {
      throw new Error('Invalid context for OMOP lookup');
    }

    // Add basic properties
    if (this._hasProp(props, 'domain-id', true)) {
      this.#addCodeProperty(params, 'property', 'domain-id', ctxt.domain);
    }
    if (this._hasProp(props, 'concept-class-id', true)) {
      this.#addCodeProperty(params, 'property', 'concept-class-id', ctxt.conceptClass);
    }
    if (this._hasProp(props, 'standard-concept', true)) {
      this.#addCodeProperty(params, 'property', 'standard-concept', ctxt.standard);
    }
    if (this._hasProp(props, 'vocabulary-id', true)) {
      this.#addStringProperty(params, 'property', 'vocabulary-id', ctxt.vocabulary);
    }

    // Add synonyms as designations
    const synonyms = await this.#getSynonyms(ctxt.code);
    for (const synonym of synonyms) {
      this.#addStringProperty(params, 'designation', 'synonym', synonym.value, synonym.language);
    }

    // Add extended properties from database
    await this.#addExtendedProperties(ctxt, props, params);

    // Add relationships
    await this.#addRelationships(ctxt, props, params);
  }

  async #addExtendedProperties(ctxt, props, params) {
    return new Promise((resolve, reject) => {
      const sql = 'SELECT * FROM Concepts WHERE concept_id = ?';

      this.db.get(sql, [ctxt.code], (err, row) => {
        if (err) {
          reject(err);
        } else if (row) {
          if (this._hasProp(props, 'concept-class-concept-id', true)) {
            this.#addCodeProperty(params, 'property', 'concept-class-concept-id', row.concept_class_id);
          }
          if (this._hasProp(props, 'domain-concept-id', true)) {
            this.#addCodeProperty(params, 'property', 'domain-concept-id', row.domain_id);
          }
          if (this._hasProp(props, 'valid-start-date', true) && row.valid_start_date) {
            this.#addDateProperty(params, 'property', 'valid-start-date', row.valid_start_date);
          }
          if (this._hasProp(props, 'valid-end-date', true) && row.valid_end_date) {
            this.#addDateProperty(params, 'property', 'valid-end-date', row.valid_end_date);
          }
          if (this._hasProp(props, 'source-concept-code', true) && row.concept_code && getUri(row.vocabulary_id)) {
            this.#addCodingProperty(params, 'property', 'source-concept-code',
              getUriOrError(row.vocabulary_id), row.concept_code);
          }
          if (this._hasProp(props, 'vocabulary-concept-id', true)) {
            this.#addCodeProperty(params, 'property', 'vocabulary-concept-id', row.vocabulary_id);
          }
          if (this._hasProp(props, 'invalid-reason', true) && row.invalid_reason) {
            this.#addStringProperty(params, 'property', 'invalid-reason', row.invalid_reason);
          }
          resolve();
        } else {
          resolve();
        }
      });
    });
  }

  async #addRelationships(ctxt, props, params) {
    const seenConcepts = new Set();

    // Forward relationships
    await new Promise((resolve, reject) => {
      const sql = `
          SELECT Concepts.concept_id, Concepts.concept_name, Relationships.relationship_id
          FROM Concepts, ConceptRelationships, Relationships
          WHERE ConceptRelationships.relationship_id = Relationships.relationship_concept_id
            AND ConceptRelationships.concept_id_2 = Concepts.concept_id
            AND ConceptRelationships.concept_id_1 = ?
      `;

      this.db.all(sql, [ctxt.code], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          for (const row of rows) {
            seenConcepts.add(row.concept_id);
            if (this._hasProp(props, row.relationship_id, true)) {
              this.#addCodingProperty(params, 'property', row.relationship_id,
                this.system(), row.concept_id, row.concept_name);
            }
          }
          resolve();
        }
      });
    });

    // Reverse relationships
    await new Promise((resolve, reject) => {
      const sql = `
          SELECT Concepts.concept_id, Concepts.concept_name, Relationships.reverse_relationship_id
          FROM Concepts, ConceptRelationships, Relationships
          WHERE ConceptRelationships.relationship_id = Relationships.relationship_concept_id
            AND ConceptRelationships.concept_id_1 = Concepts.concept_id
            AND ConceptRelationships.concept_id_2 = ?
      `;

      this.db.all(sql, [ctxt.code], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          for (const row of rows) {
            if (!seenConcepts.has(row.concept_id)) {
              if (this._hasProp(props, row.reverse_relationship_id, true)) {
                this.#addCodingProperty(params, 'property', row.reverse_relationship_id,
                  this.system(), row.concept_id, row.concept_name);
              }
            }
          }
          resolve();
        }
      });
    });
  }

  #addStringProperty(params, type, name, value, language = null) {
    const property = {
      name: type,
      part: [
        { name: 'code', valueCode: name },
        { name: 'value', valueString: String(value) } // Ensure value is always a string
      ]
    };

    if (language) {
      property.part.push({ name: 'language', valueCode: language });
    }

    params.push(property);
  }

  #addDateProperty(params, type, name, value, language = null) {
    value = String(value);
    if (value && value.length === 8 && !value.includes('-')) {
      value = value.substring(0, 4) + '-' + value.substring(4, 6) + '-' + value.substring(6, 8);
    }

    const property = {
      name: type,
      part: [
        { name: 'code', valueCode: name },
        { name: 'value', valueDate: value }
      ]
    };

    if (language) {
      property.part.push({ name: 'language', valueCode: language });
    }

    params.push(property);
  }

  #addCodingProperty(params, type, name, system, code, display = undefined) {
    const valueCoding = {
      system: system,
      code: String(code)
    };

    if (display !== undefined) {
      valueCoding.display = display;
    }
    const property = {
      name: type,
      part: [
        { name: 'code', valueCode: name },
        { name: 'value', valueCoding:  valueCoding }
      ]
    };

    params.push(property);
  }

  #addCodeProperty(params, type, name, value, language = null) {
    const property = {
      name: type,
      part: [
        { name: 'code', valueCode: name },
        { name: 'value', valueCode: String(value) } // Ensure value is always a string
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
        throw new Error(ctxt.message ? ctxt.message : `OMOP Concept '${context}' not found`);
      } else {
        return ctxt.context;
      }
    }
    if (context instanceof OMOPConcept) {
      return context;
    }
    throw new Error("Unknown Type at #ensureContext: " + (typeof context));
  }

  // Lookup methods
  async locate(code) {
    
    assert(!code || typeof code === 'string', 'code must be string');
    if (!code) return { context: null, message: 'Empty code' };

    return new Promise((resolve, reject) => {
      const sql = `
          SELECT concept_id, concept_name, standard_concept,
                 Domains.domain_id, ConceptClasses.concept_class_id,
                 Vocabularies.vocabulary_id
          FROM Concepts, Domains, ConceptClasses, Vocabularies
          WHERE Concepts.domain_id = Domains.domain_concept_id
            AND ConceptClasses.concept_class_concept_id = Concepts.concept_class_id
            AND Concepts.vocabulary_id = Vocabularies.vocabulary_concept_id
            AND concept_id = ?
      `;

      this.db.get(sql, [code], (err, row) => {
        if (err) {
          reject(err);
        } else if (row && row.concept_id.toString() === code) {
          const concept = new OMOPConcept(
            code,
            row.concept_name,
            row.domain_id,
            row.concept_class_id,
            row.standard_concept || 'NS',
            row.vocabulary_id
          );
          resolve({ context: concept, message: null });
        } else {
          resolve({ context: null, message: undefined });
        }
      });
    });
  }

  // Iterator methods - not supported for OMOP due to size
  async iterator(context) {
    await this.#ensureContext(context);
    throw new Error('getNextContext not supported by OMOP - too large to iterate');
  }

  // eslint-disable-next-line no-unused-vars
  async nextContext(iteratorContext) {
    throw new Error('getNextContext not supported by OMOP - too large to iterate');
  }

  // Filter support
  async doesFilter(prop, op, value) {
    if (prop === 'domain' && op === '=') {
      return value != null;
    }
    return false;
  }

  async getPrepContext(iterate) {
    return new OMOPPrep(iterate);
  }

  async filter(filterContext, forIteration, prop, op, value) {
    

    if (prop === 'domain' && op === '=') {
      let sql = `
          SELECT concept_id, concept_name, domain_id
          FROM Concepts
          WHERE standard_concept = 'S'
            AND domain_id IN (
              SELECT domain_concept_id
              FROM Domains
              WHERE domain_id = ?
          )
      `;

      let filter;
      if (filterContext.iterate) {
        filter = new OMOPFilter(this.db, sql, value);
        await filter.execute([value]);
      } else {
        sql = sql + ' and concept_id = ?';
        filter = new OMOPFilter(this.db, sql, value);
      }
      filterContext.filters.push(filter);
    } else {
      throw new Error(`Filter "${prop} ${op} ${value}" not understood for OMOP`);
    }
  }

  async executeFilters(filterContext) {
    return filterContext.filters;
  }

  async filterSize(filterContext, set) {
    return set.rows.length;
  }

  async filterMore(filterContext, set) {
    return set.cursor < set.rows.length;
  }

  async filterConcept(filterContext, set) {
    if (set.cursor >= set.rows.length) {
      return null;
    }

    const row = set.rows[set.cursor];
    set.cursor++;

    return new OMOPConcept(
      row.concept_id,
      row.concept_name,
      row.domain_id,
      '', // concept_class not in basic filter query
      'S', // standard_concept is 'S' by filter
      '' // vocabulary not in basic filter query
    );
  }

  async filterLocate(filterContext, set, code) {
    if (filterContext.iterate) {
      return `Filter not configured for locate operations`;
    }

    const row = await set.executeForLocate([set.value, code]);
    if (row && row.concept_id.toString() === code) {
      return new OMOPConcept(
        String(row.concept_id),
        row.concept_name,
        row.domain_id,
        '',
        'S',
        ''
      );
    } else {
      return `Code '${code}' is not in the value set`;
    }
  }

  async filterCheck(filterContext, set, concept) {
    

    if (!(concept instanceof OMOPConcept)) {
      return false;
    }

    return set.rows.some(row => row.concept_id.toString() === concept.code);
  }

  async filterFinish(filterContext) {
    
    for (const filter of filterContext.filters) {
      filter.close();
    }
  }

  async filtersNotClosed(filterContext) {
    validateOptionalParameter(filterContext, "filterContext", FilterExecutionContext);
    return false; // OMOP filters are closed
  }


  // Subsumption testing - not implemented
  async subsumesTest(codeA, codeB) {
    await this.#ensureContext(codeA);
    await this.#ensureContext(codeB);
    
    return 'not-subsumed';
  }

  // Translation support
  async getTranslations(map, coding, target) {
    if (map == null) {
      return;
    }

    const vocabId = getVocabId(target);
    if (vocabId === -1) {
      return [];
    }

    return new Promise((resolve, reject) => {
      const sql = `
          SELECT concept_code, concept_name
          FROM Concepts
          WHERE concept_id = ? AND vocabulary_id = ?
      `;

      this.db.all(sql, [coding.code, vocabId], (err, rows) => {
        if (err) {
          reject(err);
        } else {
          const translations = rows.map(row => ({
            system: target,
            code: row.concept_code,
            display: row.concept_name,
            relationship: 'equivalent',
            map: `${this.system()}/ConceptMap/to-${vocabId}|${this._version}`
          }));
          resolve(translations);
        }
      });
    });
  }

  // Build value sets for domains
  async buildValueSet(factory, id) {
    const domain = id.substring(44); // Remove prefix

    return new Promise((resolve, reject) => {
      const sql = `
          SELECT concept_id, concept_name, Domains.domain_id
          FROM Concepts, Domains
          WHERE Domains.domain_id = ?
            AND Domains.domain_concept_id = Concepts.concept_id
      `;

      this.db.get(sql, [domain], (err, row) => {
        if (err) {
          reject(err);
        } else if (row && row.domain_id === domain) {
          // Create value set structure
          const valueSet = {
            url: id,
            status: 'active',
            version: this._version,
            name: `OMOPDomain${domain}`,
            description: `OMOP value set for domain ${row.concept_name}`,
            date: new Date().toISOString(),
            experimental: false,
            compose: {
              include: [{
                system: this.system(),
                filter: [{
                  property: 'domain',
                  op: '=',
                  value: domain
                }]
              }]
            }
          };
          resolve(valueSet);
        } else {
          reject(new Error(`Unknown Value Domain ${id}`));
        }
      });
    });
  }

  // Register concept maps for vocabularies
  async registerConceptMaps(list) {
    return new Promise((resolve, reject) => {
      const sql = 'SELECT DISTINCT vocabulary_id FROM Concepts';

      this.db.all(sql, (err, rows) => {
        if (err) {
          reject(err);
        } else {
          for (const row of rows) {
            const key = row.vocabulary_id;
            const uri = getUri(key);
            if (uri) {
              // Create concept maps (simplified structure)
              list.push({
                id: `to-${key}`,
                url: `${this.system()}/ConceptMap/to-${key}`,
                sourceUri: this.system(),
                targetUri: uri
              });
              list.push({
                id: `from-${key}`,
                url: `${this.system()}/ConceptMap/from-${key}`,
                sourceUri: uri,
                targetUri: this.system()
              });
            }
          }
          resolve();
        }
      });
    });
  }

  versionAlgorithm() {
    return 'date';
  }
}

class OMOPServicesFactory extends CodeSystemFactoryProvider {
  constructor(i18n, dbPath) {
    super(i18n);
    this.dbPath = dbPath;
    this.uses = 0;
    this._loaded = false;
    this._sharedData = null;
  }

  system() {
    return 'https://fhir-terminology.ohdsi.org';
  }

  version() {
    return this._sharedData._version;
  }

  async buildKnownValueSet(url, version) {
    if (!url.startsWith('https://fhir-terminology.ohdsi.org/ValueSet')) {
      return null;
    }
    if (version && version != this.version()) {
      return null;
    }
    if (url == 'https://fhir-terminology.ohdsi.org') {
      return {
        resourceType: 'ValueSet',
        url: url,
        status: 'active',
        version: this.version(),
        name: 'OMOP',
        description: 'OMOP value set',
        date: new Date().toISOString(),
        experimental: false,
        compose: {
          include: [{
            system: this.system()
          }]
        }
      }
    }
    const domain = url.substring(44);
    return {
      resourceType: 'ValueSet',
      url: url,
      status: 'active',
      version: this.version(),
      name: 'OMOPDomain' + domain,
      description: 'OMOP value set for domain ' + domain,
      date: new Date().toISOString(),
      experimental: false,
      compose: {
        include: [{
          system: this.system(),
          filter: [{
            property: 'domain',
            op: '=',
            value: domain
          }]
        }]
      }
    };


  }

  async #ensureLoaded() {
    if (!this._loaded) {
      await this.load();
    }
  }

  async load() {
    const db = new sqlite3.Database(this.dbPath);

    try {
      this._sharedData = {
        _version: 'unknown'
      };

      // Load version from OMOP Extension vocabulary
      await this.#loadVersion(db);

    } finally {
      db.close();
    }
    this._loaded = true;
  }

  async #loadVersion(db) {
    return new Promise((resolve, reject) => {
      const sql = `
          SELECT vocabulary_version
          FROM Vocabularies
          WHERE vocabulary_id = 'OMOP Extension'
      `;

      db.get(sql, (err, row) => {
        if (err) {
          reject(err);
        } else if (row) {
          // Extract version number from the end of the version string
          const version = row.vocabulary_version;
          const lastSpaceIndex = version.lastIndexOf(' ');
          this._sharedData._version = lastSpaceIndex !== -1 ?
            version.substring(lastSpaceIndex + 1) : version;
          resolve();
        } else {
          this._sharedData._version = 'unknown';
          resolve();
        }
      });
    });
  }

  defaultVersion() {
    return this._sharedData?._version || 'unknown';
  }

  async build(opContext, supplements) {
    await this.#ensureLoaded();
    this.recordUse();

    // Create fresh database connection for this provider instance
    const db = new sqlite3.Database(this.dbPath);

    return new OMOPServices(opContext, supplements, db, this._sharedData);
  }

  static async checkDB(dbPath) {
    const fs = require('fs');
    try {
      if (!fs.existsSync(dbPath)) {
        return 'Database file not found';
      }
      const stats = fs.statSync(dbPath);
      if (stats.size < 1024) {
        return 'Database file too small';
      }
    } catch (e) {
      return `Database error: ${e.message}`;
    }

    let db;
    try {
      db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
    } catch (e) {
      return `Database error: ${e.message}`;
    }

    try {
      // Simple count query to verify database integrity. If the Concepts
      // table is missing, db.get rejects and we fall through to the catch.
      const row = await new Promise((resolve, reject) => {
        db.get('SELECT COUNT(*) as count FROM Concepts', (err, result) => {
          if (err) reject(err);
          else resolve(result);
        });
      });
      return `OK (${row && row.count != null ? row.count : 0} Concepts)`;
    } catch (_e) {
      return 'Missing Tables - needs re-importing (by java)';
    } finally {
      await new Promise((resolve) => db.close(() => resolve()));
    }
  }


  /**
   * build and return a known concept map from the URL, if there is one.
   *
   * @param url
   * @param version
   * @returns {ConceptMap}
   */
  async findImplicitConceptMaps(conceptMaps, source, dest) {
    if (source == 'https://fhir-terminology.ohdsi.org') {
      let key = this.#getVocabId(dest);
      if (key) {
        conceptMaps.push(new ConceptMap(this.makeCM(source, dest, key)));
      }
    } else if (dest == 'https://fhir-terminology.ohdsi.org') {
      let key = this.#getVocabId(source);
      if (key) {
        conceptMaps.push(new ConceptMap(this.makeCM(source, dest, key)));
      }
    } else {
      // nothing
    }
  }

  // eslint-disable-next-line no-unused-vars
  async findImplicitConceptMap(url, version) {
    return null;
  }

  #getVocabId(url) {
    const vocabMap = {
      'http://hl7.org/fhir/sid/icd-9-cm': 5046,
      'http://snomed.info/sct': 44819097,
      'http://hl7.org/fhir/sid/icd-10-cm': 44819098,
      // 'http://hl7.org/fhir/sid/icd-9-cm': 44819099, // duplicate - using first value
      'http://www.ama-assn.org/go/cpt': 44819100,
      'http://terminology.hl7.org/CodeSystem/HCPCS-all-codes': 44819101,
      'http://loinc.org': 44819102,
      'http://www.nlm.nih.gov/research/umls/rxnorm': 44819104,
      'http://hl7.org/fhir/sid/ndc': 44819105,
      'http://unitsofmeasure.org': 44819107,
      'http://nucc.org/provider-taxonomy': 44819137,
      'http://www.whocc.no/atc': 44819117
    };

    return vocabMap[url];
  }

  makeCM(source, dest, key) {
    return {
      resourceType: 'ConceptMap',
      internalSource: this,
      url: this.system() + '/ConceptMap/' + key,
      status: 'active',
      group: [{
        source: source,
        target: dest
      }]
    };
  }


  name() {
    return 'OMOP_Concepts';
  }

  id() {
    return "omop";
  }
}

module.exports = {
  OMOPServices,
  OMOPServicesFactory,
  OMOPConcept,
  OMOPFilter
};