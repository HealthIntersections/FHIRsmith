//
// Expand Worker - Handles ValueSet $expand operation
//
// GET /ValueSet/{id}/$expand
// GET /ValueSet/$expand?url=...&version=...
// POST /ValueSet/$expand (form body or Parameters with url)
// POST /ValueSet/$expand (body is ValueSet resource)
// POST /ValueSet/$expand (body is Parameters with valueSet parameter)
//

const { TerminologyWorker } = require('./worker');
const {TxParameters} = require("../params");
const {Designations, SearchFilterText} = require("../library/designations");
const {Extensions} = require("../library/extensions");
const {getValuePrimitive, getValueName, validateParameter} = require("../../library/utilities");
const {div} = require("../../library/html");
const { Issue, OperationOutcome, buildOperationOutcome, outcomeFromError } = require('../library/operation-outcome');
const crypto = require('crypto');
const ValueSet = require("../library/valueset");
const {VersionUtilities} = require("../../library/version-utilities");
const {debugLog} = require("../operation-context");

// Expansion limits (from Pascal constants)
const EXTERNAL_DEFAULT_LIMIT = 1000;
const EXTERNAL_TEST_DEFAULT_LIMIT = 3000;
const INTERNAL_DEFAULT_LIMIT = 10000;
const EXPANSION_DEAD_TIME_SECS = 30;
const CACHE_WHEN_DEBUGGING = false;

/**
 * Total status for expansion
 */
const TotalStatus = {
  Uninitialized: 'uninitialized',
  Set: 'set',
  Off: 'off'
};

/**
 * Wraps an already-expanded ValueSet for fast code lookups
 * Used when importing ValueSets during expansion
 */
class ImportedValueSet {
  /**
   * @param {Object} valueSet - Expanded ValueSet resource
   */
  constructor(valueSet) {
    this.valueSet = valueSet;
    this.url = valueSet.url || '';
    this.version = valueSet.version || '';

    /** @type {Map<string, Object>} Maps system|code -> contains entry */
    this.codeMap = new Map();

    /** @type {Set<string>} Set of systems in this ValueSet */
    this.systems = new Set();

    this._buildCodeMap();
  }

  /**
   * Build the code lookup map from the expansion
   * @private
   */
  _buildCodeMap() {
    if (!this.valueSet.expansion || !this.valueSet.expansion.contains) {
      return;
    }

    this._indexContains(this.valueSet.expansion.contains);
  }

  /**
   * Recursively index contains entries
   * @private
   */
  _indexContains(contains) {
    for (const entry of contains) {
      if (entry.system && entry.code) {
        const key = this._makeKey(entry.system, entry.code);
        this.codeMap.set(key, entry);
        this.systems.add(entry.system);
      }

      // Handle nested contains (hierarchy)
      if (entry.contains && entry.contains.length > 0) {
        this._indexContains(entry.contains);
      }
    }
  }

  /**
   * Make a lookup key from system and code
   * @private
   */
  _makeKey(system, code) {
    return `${system}\x00${code}`;
  }

  /**
   * Check if this ValueSet contains a specific code
   * @param {string} system - Code system URL
   * @param {string} code - Code value
   * @returns {boolean}
   */
  hasCode(system, code) {
    return this.codeMap.has(this._makeKey(system, code));
  }

  /**
   * Get a contains entry for a specific code
   * @param {string} system - Code system URL
   * @param {string} code - Code value
   * @returns {Object|null}
   */
  getCode(system, code) {
    return this.codeMap.get(this._makeKey(system, code)) || null;
  }

  /**
   * Check if this ValueSet contains any codes from a system
   * @param {string} system - Code system URL
   * @returns {boolean}
   */
  hasSystem(system) {
    return this.systems.has(system);
  }

  /**
   * Get total number of codes
   * @returns {number}
   */
  get count() {
    return this.codeMap.size;
  }

  /**
   * Iterate over all codes
   * @yields {{system: string, code: string, entry: Object}}
   */
  *codes() {
    for (const entry of this.codeMap.values()) {
      yield {
        system: entry.system,
        code: entry.code,
        entry
      };
    }
  }
}

/**
 * Special filter context for ValueSet import optimization
 * When a ValueSet can be used as a filter instead of full expansion
 */
class ValueSetFilterContext {
  /**
   * @param {ImportedValueSet} importedVs - The imported ValueSet
   */
  constructor(importedVs) {
    this.importedVs = importedVs;
    this.type = 'valueset';
  }

  /**
   * Check if a code passes this filter
   * @param {string} system - Code system URL
   * @param {string} code - Code value
   * @returns {boolean}
   */
  passesFilter(system, code) {
    return this.importedVs.hasCode(system, code);
  }
}

/**
 * Special filter context for empty filter (nothing matches)
 */
class EmptyFilterContext {
  constructor() {
    this.type = 'empty';
  }

  passesFilter() {
    return false;
  }
}

class ValueSetCounter {
  constructor() {
    this.count = 0;
  }

  increment() {
    this.count++;
  }
}

class ValueSetExpander {
  worker;
  params;
  doingVersion = true;
  excludedSystems = new Set();
  excluded = new Set();
  hasExclusions = false;
  requiredSupplements = new Set();
  usedSupplements = new Set();
  reportedSupplements = new Set();
  internalLimit = INTERNAL_DEFAULT_LIMIT;
  externalLimit = EXTERNAL_DEFAULT_LIMIT;
  noDetails = false;

  constructor(worker, params) {
    this.worker = worker;
    this.params = params;
    this.internalLimit = worker.internalLimit;
    this.externalLimit = worker.externalLimit;

    this.csCounter = new Map();
  }

  async listDisplaysFromProvider(displays, cs, context) {
    await cs.designations(context, displays, true);
    displays.source = cs;
  }

  listDisplaysFromConcept(displays, concept) {
    for (const ccd of concept.designations || []) {
      displays.addDesignation(ccd);
    }
  }

  listDisplaysFromIncludeConcept(displays, concept, vs) {
    if (concept.display) {
      if (!VersionUtilities.isR4Plus(this.worker.provider.getFhirVersion())) {
        displays.clear();
      }
      let lang = vs.language ? this.worker.languages.parse(vs.language) : null;
      displays.addDesignation(true, "active", lang, null, concept.display);
      }
    for (const cd of concept.designation || []) {
      displays.addDesignationFromConcept(cd);
    }
  }
  canonical(system, version) {
    if (!version) {
      return system;
    } else {
      return system + '|' + version;
    }
  }

  passesImport(imp, system, code) {
    return imp.hasCode(system, code);
  }

  passesImports(imports, system, code, offset) {
    if (imports == null) {
      return true;
    }
    for (let i = offset; i < imports.length; i++) {
      if (!this.passesImport(imports[i], system, code)) {
        return false;
      }
    }
    return true;
  }

  useDesignation(cd) {
    if (!this.params.hasDesignations) {
      return true;
    }
    for (const s of this.params.designations) {
      const [l, r] = s.split('|');
      if (cd.use != null && cd.use.system === l && cd.use.code === r) {
        return true;
      }
      if (cd.language != null && l === 'urn:ietf:bcp:47' && r === cd.language.code) {
        return true;
      }
    }
    return false;
  }

  isValidating() {
    return false;
  }

  opName() {
    return 'expansion';
  }

  redundantDisplay(n, lang, use, value) {
    if (!((lang == null) && (!this.valueSet.language)) || ((lang) && lang.code.startsWith(this.valueSet.language))) {
      return false;
    } else if (!((use == null) || (use.code === 'display'))) {
      return false;
    } else {
      return value.asString === n.display;
    }
  }

  includeCode(cs, parent, system, version, code, isAbstract, isInactive, deprecated, status, displays, definition, itemWeight, expansion, imports, csExtList, vsExtList, csProps, expProps, excludeInactive, srcURL) {
    let result = null;
    this.worker.deadCheck('processCode');

    if (!this.passesImports(imports, system, code, 0)) {
      return null;
    }
    if (isInactive && excludeInactive) {
      return null;
    }
    if (this.isExcluded(system, version, code)) {
      return null;
    }

    // expandLimitation() caps how many codes a single code system may contribute
    // (e.g. CPT limits enumeration to 1000 codes by agreement with the AMA).
    // NB: expandLimitation and system are methods - reading them as properties
    // (cs.expandLimitation > 0) compares the function object and is always false,
    // which silently disabled this cap.
    const expandLimit = cs != null ? cs.expandLimitation() : 0;
    if (expandLimit > 0) {
      let cnt = this.csCounter.get(cs.system());
      if (cnt == null) {
        cnt = new ValueSetCounter();
        this.csCounter.set(cs.system(), cnt);
      }
      cnt.increment();
      if (cnt.count > expandLimit) {
        return null;
      }
    }

    if (this.limitCount > 0 && this.fullList.length >= this.limitCount && !this.hasExclusions) {
      if (this.count > -1 && this.offset > -1 && this.count + this.offset > 0 && this.fullList.length >= this.count + this.offset) {
        this.noTotal();
        throw new Issue('information', 'informational', null, null, null, null).setFinished();
      } else {
        if (!srcURL) {
          srcURL = '??';
        }
        throw new Issue("error", "too-costly", null, 'VALUESET_TOO_COSTLY', this.worker.i18n.translate('VALUESET_TOO_COSTLY', this.params.httpLanguages, [srcURL, '>' + this.limitCount]), null, 422).withDiagnostics(this.worker.opContext.diagnostics());
      }
    }

    if (expansion && !this.noDetails) {
      const s = this.canonical(system, version);
      this.addParamUri(expansion, 'used-codesystem', s);
      if (cs != null) {
        const ts = cs.listSupplements(false);
        for (const vs of ts) {
          this.reportedSupplements.add(vs);
        }
      }
    }

    const s = this.keyS(system, version, code);

    if (!this.map.has(s)) {
      const n = {};
      n.system = system;
      n.code = code;
      if (this.doingVersion) {
        n.version = version;
      }
      if (isAbstract) {
        n.abstract = isAbstract;
      }
      if (isInactive) {
        n.inactive = true;
      }
      if (!this.noDetails) {
        if (status && status.toLowerCase() !== 'active') {
          this.defineProperty(expansion, n, 'http://hl7.org/fhir/concept-properties#status', 'status', "valueCode", status);
        } else if (deprecated) {
          this.defineProperty(expansion, n, 'http://hl7.org/fhir/concept-properties#status', 'status', "valueCode", 'deprecated');
        }

        if (Extensions.has(csExtList, 'http://hl7.org/fhir/StructureDefinition/codesystem-label')) {
          this.defineProperty(expansion, n, 'http://hl7.org/fhir/concept-properties#label', 'label', "valueString", Extensions.readString(csExtList, 'http://hl7.org/fhir/StructureDefinition/codesystem-label'));
        }
        if (Extensions.has(vsExtList, 'http://hl7.org/fhir/StructureDefinition/valueset-label')) {
          this.defineProperty(expansion, n, 'http://hl7.org/fhir/concept-properties#label', 'label', "valueString", Extensions.readString(vsExtList, 'http://hl7.org/fhir/StructureDefinition/valueset-label'));
        }

        if (Extensions.has(csExtList, 'http://hl7.org/fhir/StructureDefinition/codesystem-conceptOrder')) {
          this.defineProperty(expansion, n, 'http://hl7.org/fhir/concept-properties#order', 'order', "valueDecimal", Extensions.readNumber(csExtList, 'http://hl7.org/fhir/StructureDefinition/codesystem-conceptOrder', undefined));
        }
        if (Extensions.has(vsExtList, 'http://hl7.org/fhir/StructureDefinition/valueset-conceptOrder')) {
          this.defineProperty(expansion, n, 'http://hl7.org/fhir/concept-properties#order', 'order', "valueDecimal", Extensions.readNumber(vsExtList, 'http://hl7.org/fhir/StructureDefinition/valueset-conceptOrder', undefined));
        }

        if (Extensions.has(csExtList, 'http://hl7.org/fhir/StructureDefinition/itemWeight')) {
          this.defineProperty(expansion, n, 'http://hl7.org/fhir/concept-properties#itemWeight', 'weight', "valueDecimal", Extensions.readNumber(csExtList, 'http://hl7.org/fhir/StructureDefinition/itemWeight', undefined));
        }
        if (Extensions.has(vsExtList, 'http://hl7.org/fhir/StructureDefinition/itemWeight')) {
          this.defineProperty(expansion, n, 'http://hl7.org/fhir/concept-properties#itemWeight', 'weight', "valueDecimal", Extensions.readNumber(vsExtList, 'http://hl7.org/fhir/StructureDefinition/itemWeight', undefined));
        }

        if (csExtList != null) {
          for (const ext of csExtList) {
            if (['http://hl7.org/fhir/StructureDefinition/coding-sctdescid', 'http://hl7.org/fhir/StructureDefinition/rendering-style',
              'http://hl7.org/fhir/StructureDefinition/rendering-xhtml', 'http://hl7.org/fhir/StructureDefinition/codesystem-alternate'].includes(ext.url)) {
              if (!n.extension) {
                n.extension = []
              }
              n.extension.push(ext);
            }
            if (['http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status'].includes(ext.url)) {
              this.defineProperty(expansion, n, 'http://hl7.org/fhir/concept-properties#status', 'status', "valueCode", getValuePrimitive(ext));
            }
          }
        }

        if (vsExtList != null) {
          for (const ext of vsExtList || []) {
            if (['http://hl7.org/fhir/StructureDefinition/valueset-supplement', 'http://hl7.org/fhir/StructureDefinition/valueset-deprecated',
              'http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status',
              'http://hl7.org/fhir/StructureDefinition/valueset-concept-definition', 'http://hl7.org/fhir/StructureDefinition/coding-sctdescid',
              'http://hl7.org/fhir/StructureDefinition/rendering-style', 'http://hl7.org/fhir/StructureDefinition/rendering-xhtml'].includes(ext.url)) {
              if (!n.extension) {
                n.extension = []
              }
              n.extension.push(ext);
            }
          }
        }

        // display and designations
        const pref = displays.preferredDesignation(this.params.workingLanguages(), this.reportedSupplements);
        if (pref && pref.value) {
          n.display = pref.value;
        }

        if (this.params.includeDesignations) {
          for (const t of displays.designations) {
            if (t !== pref && this.useDesignation(t) && t.value != null && !this.redundantDisplay(n, t.language, t.use, t.value)) {
              if (!n.designation) {
                n.designation = [];
              }
              if (t.source) {
                this.reportedSupplements.add(t.source);
              }
              n.designation.push(t.asObject());
            }
          }
        }

        // '*' asks for every property the code system defines for the concept (R6's
        // ValueSet.compose.property allows it, and a request can name it too). It is handled
        // here rather than by expanding it into a list of names, because which properties
        // exist is a property of the concept, not of the request
        if (this.params.properties.includes('*') && csProps != null && cs != null) {
          for (const cp of csProps) {
            const vn = getValueName(cp);
            this.defineProperty(expansion, n, this.getPropUrl(cs, cp.code, cp), cp.code, vn, cp[vn], true);
          }
        }

        for (const pn of this.params.properties) {
          if (pn === '*') {
            continue; // done above
          } else if (pn === 'definition') {
            if (definition) {
              this.defineProperty(expansion, n, 'http://hl7.org/fhir/concept-properties#definition', pn, "valueString", definition);
            }
          } else if (pn === 'usage-count') {
            let counter = cs.usages().get(code);
            this.defineProperty(expansion, n, 'http://fhir.org/FHIRsmith/CodeSystem/concept-properties#usage-count', pn, "valueInteger", counter ? counter.count : 0);
          } else if (csProps != null && cs != null) {
            for (const cp of csProps) {
              if (cp.code === pn) {
                let vn = getValueName(cp);
                let v = cp[vn];
                // a concept may carry the same property more than once (the
                // "dup" property in the test code system has two values)
                this.defineProperty(expansion, n, this.getPropUrl(cs, pn, cp), pn, vn, v, true);
              }
            }
          }
        }
      }
      this.fullList.push(n);
      this.map.set(s, n);
      if (parent != null && !this.noDetails) {
        if (!parent.contains) {
          parent.contains = [];
        }
        parent.contains.push(n);
      } else {
        this.rootList.push(n);
      }
      result = n;
    } else {
      this.canBeHierarchy = false;
    }
    return result;
  }

  excludeCode(cs, system, version, code, expansion, imports, srcURL) {
    this.worker.deadCheck('excludeCode');
    if (!this.passesImports(imports, system, code, 0)) {
      return;
    }

    if (this.limitCount > 0 && this.fullList.length >= this.limitCount && !this.hasExclusions) {
      if (this.count > -1 && this.offset > -1 && this.count + this.offset > 0 && this.fullList.length >= this.count + this.offset) {
        throw new Issue('information', 'informational', null, null, null, null).setFinished();
      } else {
        if (!srcURL) {
          srcURL = '??';
        }
        throw new Issue("error", "too-costly", null, 'VALUESET_TOO_COSTLY', this.worker.i18n.translate('VALUESET_TOO_COSTLY', this.params.httpLanguages, [srcURL, '>' + this.limitCount]), null, 422).withDiagnostics(this.worker.opContext.diagnostics());
      }
    }

    if (expansion) {
      const s = this.canonical(system, version);
      this.addParamUri(expansion, 'used-codesystem', s);
      if (cs) {
        const ts= cs.listSupplements(false);
        for (const vs of ts) {
          this.reportedSupplements.add(vs);
        }
      }
    }

    let key = (this.doingVersion && !this.params.versionsMatch ? system + '|' + version : system) + '#' + code
    this.excluded.add(key);
  }

  async checkCanExpandValueSet(uri, version, source) {
    const vs = await this.worker.findValueSet(uri, version, source);
    if (vs == null) {
      if (!version && uri.includes('|')) {
        version = uri.substring(uri.indexOf('|') + 1);
        uri = uri.substring(0, uri.indexOf('|'));
      }
      if (!version) {
        throw new Issue('error', 'not-found', null, 'VS_EXP_IMPORT_UNK', this.worker.i18n.translate('VS_EXP_IMPORT_UNK', this.params.httpLanguages, [uri]), 'unknown', 422);
      } else {
        throw new Issue('error', 'not-found', null, 'VS_EXP_IMPORT_UNK_PINNED', this.worker.i18n.translate('VS_EXP_IMPORT_UNK_PINNED', this.params.httpLanguages, [uri, version]), 'not-found', 422);
      }
    } else {
      this.worker.seeSourceVS(vs, uri);
    }
  }

  async expandValueSet(uri, version, vs, filter, notClosed) {

    if (!vs) {
      if (version) {
        throw new Issue('error', 'not-found', null, 'VS_EXP_IMPORT_UNK_PINNED', this.worker.i18n.translate('VS_EXP_IMPORT_UNK_PINNED', this.params.httpLanguages, [uri, version]), "not-found", 422);
      } else if (uri.includes('|')) {
        throw new Issue('error', 'not-found', null, 'VS_EXP_IMPORT_UNK_PINNED', this.worker.i18n.translate('VS_EXP_IMPORT_UNK_PINNED', this.params.httpLanguages, [uri.substring(0, uri.indexOf("|")), uri.substring(uri.indexOf("|")+1)]), "not-found", 422);
      } else {
        throw new Issue('error', 'not-found', null, 'VS_EXP_IMPORT_UNK', this.worker.i18n.translate('VS_EXP_IMPORT_UNK', this.params.httpLanguages, [uri]), "not-found", 422);
      }
    }
    let worker = new ExpandWorker(this.worker.opContext, this.worker.log, this.worker.provider, this.worker.languages, this.worker.i18n);
    worker.additionalResources = this.worker.additionalResources;
    // we're going to let this one do more expansion for technical reasons
    let paramsInner = this.params.clone();
    paramsInner.limit = this.internalLimit;
    let expander = new ValueSetExpander(worker, paramsInner);
    expander.internalLimit = this.internalLimit;
    expander.externalLimit = this.internalLimit; // it's deliberate that this is the internal limit
    let result = await expander.expand(vs, filter, false);
    if (result == null) {
      throw new Issue('error', 'not-found', null, 'VS_EXP_IMPORT_UNK', this.worker.i18n.translate('VS_EXP_IMPORT_UNK', this.params.httpLanguages, [uri]), 'unknown');
    }
    if (Extensions.has(result.expansion, 'http://hl7.org/fhir/params/questionnaire-extensions#closed')) {
      notClosed.value = true;
    }
    return result;
  }

  async importValueSet(vs, expansion, imports, offset) {
    let count = 0;
    this.canBeHierarchy = false;
    for (let p of vs.expansion.parameter || []) {
      let vn = getValueName(p);
      let v = getValuePrimitive(p);
      this.addParam(expansion, p.name, vn, v);
    }
    this.checkResourceCanonicalStatus(expansion, vs, this.valueSet);

    const imported = [];
    for (const c of vs.expansion.contains || []) {
      await this.worker.checkAndYield('importValueSet');
      count += await this.importValueSetItem(null, c, imports, offset, imported);
    }
    this.importPropertyDefinitions(expansion, vs.expansion.property, imported);
    return count;
  }

  async importValueSetItem(p, c, imports, offset, imported) {
    let count = 0;
    await this.worker.checkAndYield('importValueSetItem');
    const s = this.keyC(c);
    if (this.passesImports(imports, c.system, c.code, offset) && !this.map.has(s) && !this.isExcluded(c.system, c.version, c.code)) {
      count++;
      if (imported) {
        imported.push(c);
      }
      this.fullList.push(c);
      if (p != null) {
        if (!p.contains) {p.contains = [] }
        p.contains.push(c);
      } else {
        this.rootList.push(c);
      }
      this.map.set(s, c);
    }
    for (const cc of c.contains || []) {
      await this.worker.checkAndYield('importValueSetItem');
      count += await this.importValueSetItem(c, cc, imports, offset, imported);
    }
    return count;
  }

  excludeValueSet(vs, expansion, imports, offset) {
    for (const c of vs.expansion.contains) {
      this.worker.deadCheck('excludeValueSet');
      const s = this.keyC(c);
      if (this.passesImports(imports, c.system, c.code, offset) && this.map.has(s)) {
        const idx = this.fullList.indexOf(this.map.get(s));
        if (idx >= 0) {
          this.fullList.splice(idx, 1);
        }
        this.map.delete(s);
        this.decTotal();
      }
    }
  }

  async checkSource(cset, exp, filter, srcURL, ts, vsInfo , source) {
    await this.worker.checkAndYield('checkSource');
    Extensions.checkNoModifiers(cset, 'ValueSetExpander.checkSource', 'set', srcURL);
    let imp = false;
    for (const u of cset.valueSet || []) {
      await this.worker.checkAndYield('checkSource');
      const s = this.worker.pinValueSet(u);
      await this.checkCanExpandValueSet(s, '', source);
      imp = true;
    }

    if (ts.has(cset.system)) {
      const v = ts.get(cset.system);
      if (v !== cset.version) {
        this.doingVersion = true;
      }
    } else {
      ts.set(cset.system, cset.version);
    }

    if (cset.system) {
      const cs = await this.worker.findCodeSystem(cset.system, cset.version, this.params, ['complete', 'fragment'],
        false, true, true, null, this.requiredSupplements);
      this.worker.seeSourceProvider(cs, cset.system);
      if (cs == null) {
        // nothing
      } else {
        if (vsInfo && vsInfo.isSimple) {
          vsInfo.handleByCS = cs.handlesSelecting();
        }
        if (!cs.contentMode()) {
          throw new Issue('error', 'business-rule', null, null, 'The code system definition for ' + cset.system + ' has no content property, so this expansion cannot be performed', 'invalid');
        } else if (cs.contentMode() !== 'complete') {
          if (cs.contentMode() === 'not-present') {
            throw new Issue('error', 'business-rule', null, null, 'The code system definition for ' + cset.system + ' has no content, so this expansion cannot be performed', 'invalid');
          } else if (cs.contentMode() === 'supplement') {
            throw new Issue('error', 'business-rule', null, null, 'The code system definition for ' + cset.system + ' defines a supplement, so this expansion cannot be performed', 'invalid');
          } else if (cs.contentMode() === 'fragment') {
            this.addParamUri(exp, 'used-fragment', cs.system()+ (cs.version() ?  '|' + cs.version(): ""));
            Extensions.addBoolean(exp, "http://hl7.org/fhir/StructureDefinition/valueset-unclosed", true);
            Extensions.addString(exp, "http://hl7.org/fhir/StructureDefinition/valueset-unclosed-reason","This extension is based on a fragment of the code system " + cset.system);
          } else {
            this.addParamUri(exp, cs.contentMode(), cs.system() + cs.system()+ (cs.version() ?  '|' + cs.version(): ""));
            Extensions.addBoolean(exp, "http://hl7.org/fhir/StructureDefinition/valueset-unclosed", true);
            Extensions.addString(exp, "http://hl7.org/fhir/StructureDefinition/valueset-unclosed-reason","This extension is based on a fragment of the code system " + cset.system);
          }
        }

        if (!cset.concept && !cset.filter) {
          if (cs.specialEnumeration()) {
            await this.checkCanExpandValueSet(cs.specialEnumeration(), '', null);
          } else if (filter.isNull) {
            // The unclosed marking for a grammar code system is added by
            // processCodes (the actual expansion); checkSource only guards size.
            // Refuse up-front only when enumeration could not succeed anyway:
            // count=0 is answered by counting (no enumeration), and a count/offset
            // window that fits inside limitCount is answered by partial
            // enumeration (includeCode stops at limitCount). Otherwise the walk
            // would only ever end in VALUESET_TOO_COSTLY at limitCount codes -
            // throw the same error now without doing the work.
            // NB: totalCount is a method - as a property read (cs.totalCount) the
            // comparison was against the function object, always false, so this
            // guard was silently dead.
            if (!imp && this.count !== 0 && this.limitCount > 0 && await cs.totalCount() > this.limitCount
                && !(this.count > 0 && this.count + Math.max(this.offset, 0) <= this.limitCount)) {
              // Report the versioned url (vurl), matching the message the
              // enumeration path produces when it hits the same limit - this
              // guard is just that refusal moved earlier.
              throw new Issue("error", "too-costly", null, 'VALUESET_TOO_COSTLY', this.worker.i18n.translate('VALUESET_TOO_COSTLY', this.params.httpLanguages, [source && source.vurl ? source.vurl : srcURL, '>' + this.limitCount]), null, 422).withDiagnostics(this.worker.opContext.diagnostics());
            }
          }
        }
      }
    }
  }

  async processCodes(path, vsSrc, compose, filter, expansion, excludeInactive, notClosed, vsInfo) {
    const cs = await this.worker.findCodeSystem(vsInfo.system, vsInfo.version, this.params, ['complete', 'fragment'],
      false, false, true, null, this.requiredSupplements);
    if (cs != null) {

      // set up the call to the provider
      // call the provider
      // include the codes
    }
  }

  async includeCodes(cset, path, vsSrc, compose, filter, expansion, excludeInactive, notClosed) {
    await this.worker.checkAndYield('processCodes#1');
    const valueSets = [];

    Extensions.checkNoModifiers(cset, 'ValueSetExpander.processCodes', 'set', vsSrc.vurl);

    if (cset.valueSet || cset.concept || (cset.filter || []).length > 1) {
      this.canBeHierarchy = false;
    }

    if (!cset.system) {
      for (const u of cset.valueSet) {
        await this.worker.checkAndYield('processCodes#2');
        const s = this.worker.pinValueSet(u);
        this.worker.opContext.log('import value set ' + s);
        let vs = await this.worker.findValueSet(s, '', vsSrc);
        const ivs = new ImportedValueSet(await this.expandValueSet(s, '', vs, filter, notClosed));
        this. checkResourceCanonicalStatus(expansion, ivs.valueSet, this.valueSet);
        if (!vs.isContained) {
          this.addParamUri(expansion, 'used-valueset', this.worker.makeVurl(ivs.valueSet));
        }
        valueSets.push(ivs);
      }
      this.addToTotal(await this.importValueSet(valueSets[0].valueSet, expansion, valueSets, 1));
    } else {
      const filters = [];
      const prep = null;
      const cs = await this.worker.findCodeSystem(cset.system, cset.version, this.params, ['complete', 'fragment'],
        false, false, true, null, this.requiredSupplements);

      if (cs == null) {
        // nothing
      } else {
        this.worker.checkSupplements(cs, cset, this.requiredSupplements, this.usedSupplements);
        this.checkProviderCanonicalStatus(expansion, cs, this.valueSet);
        const sv = this.canonical(await cs.system(), await cs.version());
        this.addParamUri(expansion, 'used-codesystem', sv);

        for (const u of cset.valueSet || []) {
          await this.worker.checkAndYield('processCodes#2');
          const s = this.worker.pinValueSet(u);
          this.worker.opContext.log('import value set ' + s);
          let vs = await this.worker.findValueSet(s, '', vsSrc);
          const ivs = new ImportedValueSet(await this.expandValueSet(s, '', vs, filter, notClosed));
          this.checkResourceCanonicalStatus(expansion, ivs.valueSet, this.valueSet);
          if (!vs.isContained) {
            this.addParamUri(expansion, 'used-valueset', this.worker.makeVurl(ivs.valueSet));
          }
          valueSets.push(ivs);
        }

        if (!cset.concept && !cset.filter) {
          if (cs.specialEnumeration() && filters.length === 0) {
            this.worker.opContext.log('import special value set ' + cs.specialEnumeration());
            let vs = await this.worker.findValueSet(cs.specialEnumeration(), '', null);
            const base = await this.expandValueSet(cs.specialEnumeration(), '', vs, filter, notClosed);
            Extensions.addBoolean(expansion, "http://hl7.org/fhir/StructureDefinition/valueset-unclosed", true);
            Extensions.addString(expansion, "http://hl7.org/fhir/StructureDefinition/valueset-unclosed-reason", "The code System '" + cs.system() + "' has a grammar and so has infinite members. This extension is based on " + cs.specialEnumeration());
            await this.importValueSet(base, expansion, valueSets, 0);
            notClosed.value = true;
          } else if (!cs.canBeExpanded()) {
            throw new Issue("error", "not-supported", null, 'CODESYSTEM_NOT_ENUMERABLE', this.worker.i18n.translate('CODESYSTEM_NOT_ENUMERABLE', this.params.httpLanguages, [cs.system()]), null, 422).withDiagnostics(this.worker.opContext.diagnostics());
          } else if (filter.isNull) {
            this.worker.opContext.log('add whole code system');
            if (cs.isNotClosed()) {
              if (cs.specialEnumeration()) {
                Extensions.addBoolean(expansion, "http://hl7.org/fhir/StructureDefinition/valueset-unclosed", true);
                Extensions.addString(expansion, "http://hl7.org/fhir/StructureDefinition/valueset-unclosed-reason", "The code System '" + cs.system() + "' has a grammar and so has infinite members. This extension is based on " + cs.specialEnumeration());
              } else {
                // Grammar code system with no special enumeration (e.g. SNOMED CT):
                // enumerate the precoordinated concepts we can, and mark the
                // expansion incomplete rather than refusing it.
                Extensions.addBoolean(expansion, "http://hl7.org/fhir/StructureDefinition/valueset-unclosed", true);
                Extensions.addString(expansion, "http://hl7.org/fhir/StructureDefinition/valueset-unclosed-reason", "The code System '" + cs.system() + "' has a grammar and so has infinite members");
              }
              notClosed.value = true;
            }

            if (this.count === 0 && filters.length === 0 && valueSets.length === 0) {
              // count=0 (count only) with a single whole-code-system include and no
              // additional filters: report the code count directly rather than
              // enumerating - which for a poly-hierarchy (e.g. SNOMED) is both
              // expensive and pointless when no codes are being materialised.
              this.addToTotal(await cs.countAllCodes(excludeInactive));
            } else {
              const iter = await cs.iterator(null);
              if (valueSets.length === 0 && this.limitCount > 0 && (iter && iter.total > this.limitCount) && this.offset < 0) {
                throw new Issue("error", "too-costly", null, 'VALUESET_TOO_COSTLY', this.worker.i18n.translate('VALUESET_TOO_COSTLY', this.params.httpLanguages, [vsSrc.vurl, '>' + this.limitCount]), null, 422).withDiagnostics(this.worker.opContext.diagnostics());

              }
              let tcount = 0;
              // One visited set across all roots: in a poly-hierarchy the walks
              // from different roots can reach the same concepts.
              const visited = new Set();
              let c = await cs.nextContext(iter);
              while (c) {
                await this.worker.checkAndYield('processCodes#3a');
                if (await this.passesFilters(cs, c, prep, filters, 0)) {
                  tcount += await this.includeCodeAndDescendants(cs, c, expansion, valueSets, null, excludeInactive, vsSrc.vurl, visited);
                }
                c = await cs.nextContext(iter);
              }
              this.addToTotal(tcount);
            }
          } else {
            this.worker.opContext.log('prepare filters');
            if (cs.isNotClosed(filter)) {
              notClosed.value = true;
            }
            const prep = await cs.getPrepContext(true);
            const ctxt = await cs.searchFilter(prep, filter, false);
            let set = await cs.executeFilters(prep);
            if (this.count === 0 && valueSets.length === 0) {
              // count=0 (count only): report the filtered size directly without
              // materialising the codes.
              this.addToTotal(await cs.filterSize(ctxt, set[0]));
            } else {
            this.noTotal();
            this.worker.opContext.log('iterate filters');
            while (await cs.filterMore(ctxt, set[0])) {
              await this.worker.checkAndYield('processCodes#4');
              const c = await cs.filterConcept(ctxt, set[0]);
              if (await this.passesFilters(cs, c, prep, set, 1)) {
                const cds = new Designations(this.worker.i18n.languageDefinitions);
                let added;
                if (this.noDetails) {
                  await this.listDisplaysFromProvider(cds, cs, c);
                  added = await this.includeCode(cs, null, await cs.system(), await cs.version(), await cs.code(c), await cs.isAbstract(c), await cs.isInactive(c), false, null,
                      cds, null, null, expansion, valueSets, null, null, null, null, excludeInactive, vsSrc.url);

                } else {
                  await this.listDisplaysFromProvider(cds, cs, c);
                  added = await this.includeCode(cs, null, await cs.system(), await cs.version(), await cs.code(c), await cs.isAbstract(c), await cs.isInactive(c), await cs.isDeprecated(c), await cs.getStatus(c),
                      cds, await cs.definition(c), await cs.itemWeight(c), expansion, valueSets, await cs.extensions(c), null, await cs.properties(c), null, excludeInactive, vsSrc.url);
                }
                if (added) {
                  this.addToTotal();
                }
              }
              if (this.pageFilled()) {
                // No total is reported for this path (noTotal above), so once
                // the requested page is full there is nothing left to learn
                // from the rest of the matches - and a text filter on a large
                // code system can match tens of thousands of them, each
                // costing a designations/properties lookup.
                break;
              }
            }
            this.worker.opContext.log('iterate filters done');
            }
          }
        }

        if (cset.concept) {
          this.worker.opContext.log('iterate concepts');
          const cds = new Designations(this.worker.i18n.languageDefinitions);

          for (const cc of cset.concept) {
            await this.worker.checkAndYield('processCodes#3');
            cds.clear();
            Extensions.checkNoModifiers(cc, 'ValueSetExpander.processCodes', 'set concept reference', vsSrc.vurl);
            const cctxt = await cs.locate(cc.code, this.allAltCodes);
            if (cctxt && cctxt.context && (!this.params.activeOnly || !await cs.isInactive(cctxt.context)) && await this.passesFilters(cs, cctxt.context, prep, filters, 0)) {
              let added;
              if (this.noDetails) {
                added = await this.includeCode(cs, null, cs.system(), cs.version(), cc.code, await cs.isAbstract(cctxt.context), await cs.isInactive(cctxt.context), null, null, cds,
                    null, null, expansion, valueSets, null, null, null, null, excludeInactive, vsSrc.url);
              } else {
                await this.listDisplaysFromProvider(cds, cs, cctxt.context);
                this.listDisplaysFromIncludeConcept(cds, cc, vsSrc);
                if (filter.passesDesignations(cds) || filter.passes(cc.code)) {
                  let ov = Extensions.readString(cc, 'http://hl7.org/fhir/StructureDefinition/itemWeight');
                  if (!ov) {
                    ov = await cs.itemWeight(cctxt.context);
                  }
                  added = await this.includeCode(cs, null, cs.system(), cs.version(), cc.code, await cs.isAbstract(cctxt.context), await cs.isInactive(cctxt.context), await cs.isDeprecated(cctxt.context), await cs.getStatus(cctxt.context), cds,
                      await cs.definition(cctxt.context), ov, expansion, valueSets, await cs.extensions(cctxt.context), cc.extension, await cs.properties(cctxt.context), null, excludeInactive, vsSrc.url);
                }
                if (added) {
                  this.addToTotal();
                }
              }
            }
          }
          this.worker.opContext.log('iterate concepts done');
        }

        if (cset.filter && cset.filter.length > 0) {
          this.worker.opContext.log('prepare filters');
          const fcl = cset.filter;
          const prep = await cs.getPrepContext(true);

          if (!filter.isNull) {
            await cs.searchFilter(prep, filter, true);
          }

          if (cs.specialEnumeration()) {
            Extensions.addBoolean(expansion, "http://hl7.org/fhir/StructureDefinition/valueset-unclosed", true);
            Extensions.addString(expansion, "http://hl7.org/fhir/StructureDefinition/valueset-unclosed-reason", "The code System '" + cs.system() + "' has a grammar and so has infinite members. This extension is based on " + cs.specialEnumeration());
            notClosed.value = true;
          }

          for (let i = 0; i < fcl.length; i++) {
            await this.worker.checkAndYield('processCodes#4a');
            const fc = fcl[i];
            if (!fc.value) {
              throw new Issue('error', 'invalid', path + ".filter[" + i + "]", 'UNABLE_TO_HANDLE_SYSTEM_FILTER_WITH_NO_VALUE', this.worker.i18n.translate('UNABLE_TO_HANDLE_SYSTEM_FILTER_WITH_NO_VALUE', this.params.httpLanguages, [cs.system(), fc.property, fc.op]), 'vs-invalid', 400);
            }
            Extensions.checkNoModifiers(fc, 'ValueSetExpander.processCodes', 'filter', vsSrc.vurl);
            await cs.filter(prep, i == 0, fc.property, fc.op, fc.value, vsSrc.isCached ? fc : null);
          }

          const fset = await cs.executeFilters(prep);
          if (await cs.filtersNotClosed(prep)) {
            notClosed.value = true;
          } else if (fset.length === 1 && !excludeInactive && !this.params.activeOnly) {
            // this.addToTotal(await cs.filterSize(prep, fset[0]));
          }

          this.worker.opContext.log('iterate filters');
          this.addToTotal(0);
          const cds = new Designations(this.worker.i18n.languageDefinitions);
          while (await cs.filterMore(prep, fset[0])) {
            await this.worker.checkAndYield('processCodes#5');
            const c = await cs.filterConcept(prep, fset[0]);
            const ok = (!this.params.activeOnly || !await cs.isInactive(c)) && (await this.passesFilters(cs, c, prep, fset, 1));
            if (ok) {
              cds.clear();
              // count++;
              if (this.passesImports(valueSets, cs.system(), await cs.code(c), 0)) {
                let added;
                if (this.noDetails) {
                  added = await this.includeCode(cs, null, await cs.system(), await cs.version(), await cs.code(c), await cs.isAbstract(c), await cs.isInactive(c),
                      null,  null, cds, null, null,
                      expansion, null, null, null, null, null, excludeInactive, vsSrc.url);

                } else {
                  await this.listDisplaysFromProvider(cds, cs, c);
                  let parent = null;
                  if (cs.hasParents()) {
                    parent = this.map.get(this.keyS(cs.system(), cs.version(), await cs.parent(c)));
                  } else {
                    this.canBeHierarchy = false;
                  }
                  added = await this.includeCode(cs, parent, await cs.system(), await cs.version(), await cs.code(c), await cs.isAbstract(c), await cs.isInactive(c),
                      await cs.isDeprecated(c), await cs.getStatus(c), cds, await cs.definition(c), await cs.itemWeight(c),
                      expansion, null, await cs.extensions(c), null, await cs.properties(c), null, excludeInactive, vsSrc.url);
                }
                if (added) {
                  this.addToTotal();
                }
              }
            }
          }
          this.worker.opContext.log('iterate filters done');
        }
      }
    }
  }

  async passesFilters(cs, c, prep, filters, offset) {
    for (let j = offset; j < filters.length; j++) {
      const f = filters[j];
      let ok = await cs.filterCheck(prep, f, c);
      if (ok != true) {
        return false;
      }
    }
    return true;
  }

  async excludeCodes(cset, path, vsSrc, filter, expansion, excludeInactive, notClosed) {
    await this.worker.checkAndYield('processCodes#1');
    const valueSets = [];

    Extensions.checkNoModifiers(cset, 'ValueSetExpander.processCodes', 'set', vsSrc.vurl);

    if (cset.valueSet || cset.concept || (cset.filter || []).length > 1) {
      this.canBeHierarchy = false;
    }

    if (!cset.system) {
      if (cset.valueSet) {
        this.noTotal();
        for (const u of cset.valueSet) {
          const s = this.worker.pinValueSet(u);
          await this.worker.checkAndYield('processCodes#2');
          let vs = await this.worker.findValueSet(s, '', vsSrc);
          const ivs = new ImportedValueSet(await this.expandValueSet(s, '',  vs, filter, notClosed));
          this.checkResourceCanonicalStatus(expansion, ivs.valueSet, this.valueSet);
          if (!vs.isContained && ivs.valueSet.vurl) {
            this.addParamUri(expansion, 'used-valueset', ivs.valueSet.vurl);
          }
          valueSets.push(ivs);
        }
        this.excludeValueSet(valueSets[0].valueSet, expansion, valueSets, 1);
      }
    } else {
      const filters = [];
      const prep = null;
      const cs = await this.worker.findCodeSystem(cset.system, cset.version, this.params, ['complete', 'fragment'], false,
        true, true, null, this.requiredSupplements);

      if (cs == null) {
        // nothing?
      } else {
        this.worker.checkSupplements(cs, cset, this.requiredSupplements, this.usedSupplements);
        this.checkResourceCanonicalStatus(expansion, cs, this.valueSet);
        const sv = this.canonical(await cs.system(), await cs.version());
        this.addParamUri(expansion, 'used-codesystem', sv);

        for (const u of cset.valueSet || []) {
          await this.worker.checkAndYield('processCodes#3');
          const s = this.worker.pinValueSet(u);
          this.worker.opContext.log('import value set ' + s);
          let vs = await this.worker.findValueSet(s, '', vsSrc);
          const ivs = new ImportedValueSet(await this.expandValueSet(s, '', vs, filter, notClosed));
          this.checkResourceCanonicalStatus(expansion, ivs.valueSet, this.valueSet);
          if (!vs.isContained) {
            this.addParamUri(expansion, 'used-valueset', this.worker.makeVurl(ivs.valueSet));
          }
          valueSets.push(ivs);
        }

        if (!cset.concept && !cset.filter) {
          this.worker.opContext.log('handle system');
          if (!cset.valueSet) {
            if (!this.excludeSpecialCase) {
              // excluding a whole system - we don't list the codes in this case
              this.excludedSystems.add(cset.system + (this.doingVersion && cset.version ? '|' + cset.version : ''));
            } else {
              const iter = await cs.iteratorAll();
              if (iter) {
                let c = await cs.nextContext(iter);
                while (c) {
                  await this.worker.checkAndYield('processCodes#3aa');
                  this.excludeCode(cs, cs.system(), cs.version(), await cs.code(c), expansion, valueSets, vsSrc.url);
                  c = await cs.nextContext(iter);
                }
              }
            }
          } else {
            if (cs.isNotClosed(filter)) {
              if (cs.specialEnumeration()) {
                Extensions.addBoolean(expansion, "http://hl7.org/fhir/StructureDefinition/valueset-unclosed", true);
                Extensions.addString(expansion, "http://hl7.org/fhir/StructureDefinition/valueset-unclosed-reason", "The code System '" + cs.system() + "' has a grammar and so has infinite members. This extension is based on " + cs.specialEnumeration());
              } else {
                // Grammar code system with no special enumeration (e.g. SNOMED CT):
                // enumerate the precoordinated concepts we can, and mark the
                // expansion incomplete rather than refusing it.
                Extensions.addBoolean(expansion, "http://hl7.org/fhir/StructureDefinition/valueset-unclosed", true);
                Extensions.addString(expansion, "http://hl7.org/fhir/StructureDefinition/valueset-unclosed-reason", "The code System '" + cs.system() + "' has a grammar and so has infinite members");
              }
            }

            const iter = await cs.iteratorAll();
            if (iter) {
              let c = await cs.nextContext(iter);
              while (c) {
                await this.worker.checkAndYield('processCodes#3a');
                if (await this.passesFilters(cs, c, prep, filters, 0)) {
                  this.excludeCode(cs, cs.system(), cs.version(), await cs.code(c), expansion, valueSets, vsSrc.url);
                }
                c = await cs.nextContext(iter);
              }
            }
          }
        }

        if (cset.concept) {
          this.worker.opContext.log('iterate concepts');
          const cds = new Designations(this.worker.i18n.languageDefinitions);
          for (const cc of cset.concept) {
            await this.worker.checkAndYield('processCodes#3');
            cds.clear();
            Extensions.checkNoModifiers(cc, 'ValueSetExpander.processCodes', 'set concept reference', vsSrc.vurl);
            const cctxt = await cs.locate(cc.code, this.allAltCodes);
            if (cctxt && cctxt.context && (!this.params.activeOnly || !await cs.isInactive(cctxt.context)) && await this.passesFilters(cs, cctxt.context, prep, filters, 0)) {
              if (filter.passesDesignations(cds) || filter.passes(cc.code)) {
                let ov = Extensions.readString(cc, 'http://hl7.org/fhir/StructureDefinition/itemWeight');
                if (!ov) {
                  ov = await cs.itemWeight(cctxt.context);
                }
                this.excludeCode(cs, await cs.system(), await cs.version(), cc.code, expansion, valueSets, vsSrc.url);
              }
            }
          }
        }

        if (cset.filter) {
          this.worker.opContext.log('prep filters');
          const prep = await cs.getPrepContext(true);
          if (!filter.isNull) {
            await cs.searchFilter(prep, filter, true);
          }

          if (cs.specialEnumeration()) {
            await cs.specialFilter(prep, true);
            Extensions.addBoolean(expansion, "http://hl7.org/fhir/StructureDefinition/valueset-unclosed", true);
            Extensions.addString(expansion, "http://hl7.org/fhir/StructureDefinition/valueset-unclosed-reason", "The code System '" + cs.system() + "' has a grammar and so has infinite members. This extension is based on " + cs.specialEnumeration());
          }

          let first = true;
          for (let fc of cset.filter) {
            await this.worker.checkAndYield('processCodes#4a');
            Extensions.checkNoModifiers(fc, 'ValueSetExpander.processCodes', 'filter', vsSrc.vurl);
            await cs.filter(prep, first, fc.property, fc.op, fc.value, vsSrc.isCached ? fc : null);
            first = false;
          }

          this.worker.opContext.log('iterate filters');
          const fset = await cs.executeFilters(prep);
          if (await cs.filtersNotClosed(prep)) {
            notClosed.value = true;
          }
          //let count = 0;
          while (await cs.filterMore(prep, fset[0])) {
            await this.worker.checkAndYield('processCodes#5');
            const c = await cs.filterConcept(prep, fset[0]);
            const ok = (!this.params.activeOnly || !await cs.isInactive(c)) && (await this.passesFilters(cs, c, prep, fset, 1));
            if (ok) {
              //count++;
              if (this.passesImports(valueSets, await cs.system(), await cs.code(c), 0)) {
                this.excludeCode(cs, await cs.system(), await cs.version(), await cs.code(c), expansion, null, vsSrc.url);
              }
            }
          }
          this.worker.opContext.log('iterate filters finished');
        }
      }
    }
  }

  async includeCodeAndDescendants(cs, context, expansion, imports, parent, excludeInactive, srcUrl, visited = null) {
    let result = 0;
    await this.worker.checkAndYield('processCodeAndDescendants');

    // In a poly-hierarchy (e.g. SNOMED CT) a concept is reachable through every
    // one of its parents; without a visited set the recursion walks every *path*
    // rather than every *node* - for the full SNOMED International edition that
    // is ~15.8M visits for ~520k concepts, which is what turned an aborted
    // expansion into a 30-second event-loop stall. Reaching a concept a second
    // time means it has multiple parents, so (as when includeCode detects a
    // duplicate) the expansion cannot be represented as a tree.
    if (visited == null) {
      visited = new Set();
    }
    // NB: contexts do not reliably carry a .code property (SnomedExpressionContext
    // does not) - cs.code(context) is the accessor. Reading context.code here
    // used to yield undefined for every SNOMED concept, collapsing the whole
    // expansion onto one map key so no size guard could ever fire.
    const code = await cs.code(context);
    if (visited.has(code)) {
      this.canBeHierarchy = false;
      return 0;
    }
    visited.add(code);

    if (expansion) {
      const vs = this.canonical(await cs.system(), await cs.version());
      this.addParamUri(expansion, 'used-codesystem', vs);
      const ts = cs.listSupplements(false);
      for (const v of ts) {
        this.reportedSupplements.add(v);
      }
    }

    let n = null;
    if ((!this.params.excludeNotForUI || !await cs.isAbstract(context)) && (!this.params.activeOnly || !await cs.isInactive(context))) {
      const cds = new Designations(this.worker.i18n.languageDefinitions);
      let t;
      if (this.noDetails) {
        t = await this.includeCode(cs, null, await cs.system(), await cs.version(), code, await cs.isAbstract(context), await cs.isInactive(context), null, null, null,
            null, null, expansion, imports, null, null, null, null, excludeInactive, srcUrl);

      } else {
        await this.listDisplaysFromProvider(cds, cs, context);
        t = await this.includeCode(cs, parent, await cs.system(), await cs.version(), code, await cs.isAbstract(context), await cs.isInactive(context), await cs.isDeprecated(context), await cs.getStatus(context), cds, await cs.definition(context),
            await cs.itemWeight(context), expansion, imports, await cs.extensions(context), null, await cs.properties(context), null, excludeInactive, srcUrl);
      }
      if (t != null) {
        result++;
      }
      if (n == null) {
        n = t;
      }
    } else {
      n = parent;
    }

    const iter = await cs.iterator(context);
    if (iter) {
      let c = await cs.nextContext(iter);
      while (c) {
        await this.worker.checkAndYield('processCodeAndDescendants#3');
        result += await this.includeCodeAndDescendants(cs, c, expansion, imports, n, excludeInactive, srcUrl, visited);
        c = await cs.nextContext(iter);
      }
    }
    return result;
  }

  async excludeCodeAndDescendants(cs, context, expansion, imports, excludeInactive, srcUrl, visited = null) {
    await this.worker.checkAndYield('processCodeAndDescendants');

    // Same visited-set protection as includeCodeAndDescendants: walk nodes, not
    // paths (see that method for why), and same accessor fix - context.code is
    // not reliably present, and passing the raw context as the code produced
    // useless "[object Object]" exclusion keys.
    if (visited == null) {
      visited = new Set();
    }
    const code = await cs.code(context);
    if (visited.has(code)) {
      return;
    }
    visited.add(code);

    if (expansion) {
      const vs = this.canonical(await cs.system(), await cs.version());
      this.addParamUri(expansion, 'used-codesystem', vs);
      const ts= cs.listSupplements(false);
      for (const v of ts) {
        this.reportedSupplements.add(v);
      }
    }

    if ((!this.params.excludeNotForUI || !await cs.isAbstract(context)) && (!this.params.activeOnly || !await cs.isInactive(context))) {
      const cds = new Designations(this.worker.i18n.languageDefinitions);
      await this.listDisplaysFromProvider(cds, cs, context);
      await this.worker.checkAndYield('processCodeAndDescendants#2');
      this.excludeCode(cs, await cs.system(), await cs.version(), code, expansion, imports, srcUrl);
    }

    const iter = await cs.iterator(context);
    let c = await cs.nextContext(iter);
    while (c) {
      await this.worker.checkAndYield('processCodeAndDescendants#3');
      await this.excludeCodeAndDescendants(cs, c, expansion, imports, excludeInactive, srcUrl, visited);
      c = await cs.nextContext(iter);
    }
  }

  async handleCompose(source, filter, expansion, notClosed, vsInfo) {
    this.worker.opContext.log('compose #1');

    this.doingVersion = false;
    const ts = new Map();
    for (const c of source.jsonObj.compose.include || []) {
      await this.worker.checkAndYield('handleCompose#2');
      await this.checkSource(c, expansion, filter, source.url, ts, vsInfo, source);
    }
    for (const c of source.jsonObj.compose.exclude || []) {
      await this.worker.checkAndYield('handleCompose#3');
      this.hasExclusions = true;
      await this.checkSource(c, expansion, filter, source.url, ts, null, source);
    }

    this.worker.opContext.log('compose #2');

    if (vsInfo.handleByCS) {
      await this.processCodes("ValueSet.compose", source, source.jsonObj.compose, filter, expansion, this.excludeInactives(source), notClosed, vsInfo);
    } else {
      this.checkForExclusionVersionSpecialCase(source, expansion);

      let i = 0;
      for (const c of source.jsonObj.compose.exclude || []) {
        await this.worker.checkAndYield('handleCompose#4');
        await this.excludeCodes(c, "ValueSet.compose.exclude[" + i + "]", source, filter, expansion, this.excludeInactives(source), notClosed);
      }

      i = 0;
      const includes = [...(source.jsonObj.compose.include || [])];
      includes.sort((a, b) => {
        if (a.system === b.system && a.version && b.version) {
          return -VersionUtilities.compareVersionsGeneral(a.version, b.version);
        }
        return 0;
      });
      for (const c of includes) {
        await this.worker.checkAndYield('handleCompose#5');
        await this.includeCodes(c, "ValueSet.compose.include[" + i + "]", source, source.jsonObj.compose, filter, expansion, this.excludeInactives(source), notClosed);
        i++;
      }
    }
  }

  excludeInactives(source) {
    return source.jsonObj.compose && source.jsonObj.compose.inactive != undefined && !source.jsonObj.compose.inactive;
  }

  async expand(source, filter, noCacheThisOne) {
    this.noCacheThisOne = noCacheThisOne;
    this.totalStatus = 'uninitialised';
    this.total = 0;

    Extensions.checkNoImplicitRules(source,'ValueSetExpander.Expand', 'ValueSet', source.vurl);
    Extensions.checkNoModifiers(source,'ValueSetExpander.Expand', 'ValueSet', source.vurl);
    this.worker.seeValueSet(source, this.params);
    this.valueSet = source;

    const result = structuredClone(source.jsonObj);
    result.id = undefined;
    let table = null;
    let div_ = null;

    if (!this.params.includeDefinition) {
      result.purpose = undefined;
      result.compose = undefined;
      result.description = undefined;
      result.contactList = undefined;
      result.copyright = undefined;
      result.publisher = undefined;
      result.extension = undefined;
      result.text = undefined;
      result.contained = undefined;
    }

    for (let s of this.params.supplements) this.requiredSupplements.add(s);
    for (const ext of Extensions.list(source.jsonObj, 'http://hl7.org/fhir/StructureDefinition/valueset-supplement')) {
      this.requiredSupplements.add(getValuePrimitive(ext));
    }

    if (result.expansion) {
      return result; // just return the expansion
    }

    if (this.params.generateNarrative && !this.noDetails) {
      div_ = div();
      table = div_.table("grid");
    } else {
      result.text = undefined;
    }

    this.map = new Map();
    this.rootList = [];
    this.fullList = [];
    this.canBeHierarchy = !this.params.excludeNested;

    if (this.params.limit <= 0) {
      this.limitCount = this.externalLimit;
    } else if (this.externalLimit) {
      this.limitCount = Math.min(this.params.limit, this.externalLimit);
    } else {
      this.limitCount = this.params.limit;
    }
    this.offset = this.params.offset;
    this.count = this.params.count;

    if (this.params.offset > 0) {
      this.canBeHierarchy = false;
    }

    const exp = {};
    exp.timestamp = new Date().toISOString();
    exp.identifier = 'urn:uuid:' + crypto.randomUUID();
    result.expansion = exp;

    if (!filter.isNull) {
      this.addParamStr(exp, 'filter', filter.filter);
    }

    if (this.params.DisplayLanguages) {
      this.addParamCode(exp, 'displayLanguage', this.params.DisplayLanguages.asString(true));
    } else if (this.params.HTTPLanguages) {
      this.addParamCode(exp, 'displayLanguage', this.params.HTTPLanguages.asString(true));
    }
    if (this.params.designations) {
      for (const s of this.params.designations) {
        this.addParamStr(exp, 'designation', s);
      }
    }
    if (this.params.hasExcludeNested) {
      this.addParamBool(exp, 'excludeNested', this.params.excludeNested);
    }
    if (this.params.versionsMatch) {
      this.addParamBool(exp, 'versionsMatch', this.params.versionsMatch);
    }
    if (this.params.hasActiveOnly) {
      this.addParamBool(exp, 'activeOnly', this.params.activeOnly);
    }
    if (this.params.hasIncludeDesignations) {
      this.addParamBool(exp, 'includeDesignations', this.params.includeDesignations);
    }
    if (this.params.hasIncludeDefinition) {
      this.addParamBool(exp, 'includeDefinition', this.params.includeDefinition);
    }
    if (this.params.hasExcludeNotForUI) {
      this.addParamBool(exp, 'excludeNotForUI', this.params.excludeNotForUI);
    }
    if (this.params.hasExcludePostCoordinated) {
      this.addParamBool(exp, 'excludePostCoordinated', this.params.excludePostCoordinated);
    }

    this.checkResourceCanonicalStatus(exp, source, source);

    if (this.offset > -1) {
      this.addParamInt(exp,'offset', this.offset);
      exp.offset = this.offset;
    }
    if (this.count > -1) {
      this.addParamInt(exp, 'count', this.count);
    }
    if (this.count > 0 && this.offset === -1) {
      this.offset = 0;
    }

    this.worker.opContext.log('start working');
    await this.worker.checkAndYield('expand');

    let notClosed = { value :  false};

    let vsInfo = this.scanValueSet(source.jsonObj.compose);
    try {
      if (source.jsonObj.compose && Extensions.checkNoModifiers(source.jsonObj.compose, 'ValueSetExpander.Expand', 'compose', source.vurl)
          && this.worker.checkNoLockedDate(source.url, source.jsonObj.compose)) {
        await this.handleCompose(source, filter, exp, notClosed, vsInfo);
      }

      const unused = new Set([...this.requiredSupplements].filter(s => !this.usedSupplements.has(s)));
      if (unused.size > 0) {
        throw new Issue('error', 'not-found', null, 'VALUESET_SUPPLEMENT_MISSING', this.worker.i18n.translatePlural(unused.size, 'VALUESET_SUPPLEMENT_MISSING', this.params.HTTPLanguages, [[...unused].join(',')]), 'not-found').handleAsOO(422);
      }
    } catch (e) {
      if (e instanceof Issue) {
        if (e.finished) {
          // nothing - we're just trapping this
          if (this.totalStatus === 'uninitialised') {
            this.totalStatus = 'off';
          } else if (e.toocostly) {
            Extensions.addBoolean(exp, 'http://hl7.org/fhir/StructureDefinition/valueset-toocostly', 'value', true);
            if (table != null) {
              div_.p().style('color: Maroon').tx(e.message);
            }
          } else {
            // nothing- swallow it
          }
        } else {
          throw e;
        }
      } else {
        throw e;
      }
    }

    const ts = this.reportedSupplements;
    for (const v of ts) {
      this.addParamUri(exp, 'used-supplement', v);
    }

    this.worker.opContext.log('finish up');

    let list;
    if (notClosed.value) {
      if (!Extensions.has(exp, 'http://hl7.org/fhir/StructureDefinition/valueset-unclosed')) {
        Extensions.addBoolean(exp, 'http://hl7.org/fhir/StructureDefinition/valueset-unclosed', true);
      }
      if (this.totalStatus === 'set' && this.total > -1) {
        exp.total = this.total;
      }
      list = this.fullList;
      if (!this.noDetails) {
        for (const c of this.fullList) {
          c.contains = undefined;
        }
      }
      if (table != null) {
        div_.addTag('p').setAttribute('style', 'color: Navy').tx('Because of the way that this value set is defined, not all the possible codes can be listed in advance');
      }
    } else {
      if (this.totalStatus === 'off' || this.total === -1) {
        this.canBeHierarchy = false;
      } else if (this.total > 0) {
        exp.total = this.total;
      } else {
        exp.total = this.fullList.length;
      }

      if (this.canBeHierarchy && (this.count < 0 || this.count > this.fullList.length)) {
        list = this.rootList;
      } else {
        list = this.fullList;
        for (const c of this.fullList) {
          c.contains = undefined;
        }
      }
    }

    if (this.offset + this.count < 0 && this.fullList.length > this.limit) {
      this.log.log('Operation took too long @ expand (' + this.constructor.name + ')');
      throw new Issue("error", "too-costly", null, 'VALUESET_TOO_COSTLY', this.worker.i18n.translate('VALUESET_TOO_COSTLY', this.params.httpLanguages, [source.vurl, '>' + this.limit]), null, 422).withDiagnostics(this.worker.opContext.diagnostics());
    } else {
      let t = 0;
      let o = 0;
      for (let i = 0; i < list.length; i++) {
        await this.worker.checkAndYield('expand#1');
        const c = list[i];
        if (this.map.has(this.keyC(c))) {
          o++;
          if ((vsInfo.csDoOffset) || (o > this.offset && (this.count < 0 || t < this.count))) {
            t++;
            if (!exp.contains) {
              exp.contains = [];
            }
            exp.contains.push(c);
            if (table != null) {
              const tr = table.tr();
              tr.td().tx(c.system);
              tr.td().tx(c.code);
              tr.td().tx(c.display);
            }
          }
        }
      }
    }

    for (const s of this.worker.foundParameters) {
      const [l, r] = s.split('=');
      if (r != source.vurl) {
        this.addParamUri(exp, l, r);
      }
    }

    if (result.expansion.contains && result.expansion.contains.length > 0) {
      let hasChildren = false;
      for (let c of result.expansion.contains) {
        if (c.contains) {
          hasChildren = true;
          break;
        }
      }

      if (!hasChildren) {
        let sort = this.params.sort;
        let order = 1;
        if (sort.startsWith('-')) {
          order = -1;
          sort = sort.substring(1);
        }
        switch (sort) {
          case "design":
            break; // do nothing - that's the natural order of this class
          case "code" :
            result.expansion.contains.sort((a, b) => order * (a.code ?? 'zzz').localeCompare(b.code ?? 'zzz'));
            break;
          case "display" :
            result.expansion.contains.sort((a, b) => order * (a.display ?? 'zzz').localeCompare(b.display ?? 'zzz'));
            break;
          case "codesystem" :
            // do nothing about that here
            break;
          default:
            if (sort.startsWith("prop:")) {
              result.expansion.contains.sort((a, b) => order * this.sortByProp(a, b, sort.substring(5)));
            } else {
              // do nothing?
            }
        }
      }
    }
    return result;
  }

  checkResourceCanonicalStatus(exp, resource, source) {
    if (resource.jsonObj) {
      resource = resource.jsonObj;
    }
    this.checkCanonicalStatus(exp, this.worker.makeVurl(resource), resource.status, Extensions.readString(resource, 'http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status'), resource.experimental, source);
  }

  checkProviderCanonicalStatus(exp, cs, source) {
    let status = cs.status();
    this.checkCanonicalStatus(exp, cs.vurl(), status.status, status.standardsStatus, status.experimental, source);
  }

  checkCanonicalStatus(exp, vurl, status, standardsStatus, experimental, source) {
    let sourceStatus = source ? source.status : undefined;
    let sourceStandardsStatus= source ? Extensions.readString(source, 'http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status') : undefined;
    if (standardsStatus == 'deprecated') {
      if (sourceStandardsStatus != 'deprecated') {
        this.addParamUri(exp, 'warning-deprecated', vurl);
      }
    } else if (standardsStatus == 'withdrawn') {
      if (sourceStandardsStatus != 'withdrawn') {
        this.addParamUri(exp, 'warning-withdrawn', vurl);
      }
    } else if (status == 'retired') {
      if (sourceStatus != 'retired') {
        this.addParamUri(exp, 'warning-retired', vurl);
      }
    } else if (experimental) {
      if (!source.experimental) {
        this.addParamUri(exp, 'warning-experimental', vurl);
      }
    } else if (((status == 'draft') || (standardsStatus == 'draft'))) {
      if (!((source.status == 'draft') || (Extensions.readString(source, 'http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status') == 'draft'))) {
        this.addParamUri(exp, 'warning-draft', vurl)
      }
    }
  }

  addParamStr(exp, name, value) {
    if (!this.hasParam(exp, name, value)) {
      if (!exp.parameter) {
        exp.parameter = [];
      }
      exp.parameter.push({name: name, valueString: value});
    }
  }

  addParamBool(exp, name, value) {
    if (!this.hasParam(exp, name, value)) {
      if (!exp.parameter) {
        exp.parameter = [];
      }
      exp.parameter.push({name: name, valueBoolean: value});
    }
  }

  addParamCode(exp, name, value) {
    if (!this.hasParam(exp, name, value)) {
      if (!exp.parameter) {
        exp.parameter = [];
      }
      exp.parameter.push({name: name, valueCode: value});
    }
  }

  addParamInt(exp, name, value) {
    if (!this.hasParam(exp, name, value)) {
      if (!exp.parameter) {
        exp.parameter = [];
      }
      exp.parameter.push({name: name, valueInteger: value});
    }
  }

  addParamUri(exp, name, value) {
    validateParameter(name, 'name', String);
    validateParameter(value, 'value', String);

    if (!this.hasParam(exp, name, value)) {
      if (!exp.parameter) {
        exp.parameter = [];
      }
      exp.parameter.push({name: name, valueUri: value});
    }
  }

  addParam(exp, name, valueName, value) {
    if (!this.hasParam(exp, name, value)) {
      if (!exp.parameter) {
        exp.parameter = [];
      }
      let p = {name: name}
      exp.parameter.push(p);
      p[valueName] = value;
    }
  }


  hasParam(exp, name, value) {
    return (exp.parameter || []).find((ex => ex.name == name && getValuePrimitive(ex) == value));
  }

  isExcluded(system, version, code) {
    if (this.excludedSystems.has(system)) {
      return true;
    }
    let key = this.doingVersion && !this.params.versionsMatch? system+'|'+version : system;
    if (this.excludedSystems.has(key)) {
      return true;
    }
    key = (this.doingVersion && !this.params.versionsMatch ? system+'|'+version : system)+'#'+code;
    return this.excluded.has(key);
  }

  keyS(system, version, code) {
    return system+"~"+(this.doingVersion && !this.params.versionsMatch ? version+"~" : "")+code;
  }

  keyC(contains) {
    return this.keyS(contains.system, contains.version, contains.code);
  }

  /**
   * Record a property definition in expansion.property, and return the code to
   * use for the per-concept value (an existing definition's code wins).
   *
   * @param {Object} expansion
   * @param {string} url
   * @param {string} code
   * @returns {string}
   */
  declareProperty(expansion, url, code) {
    if (!expansion.property) {
      expansion.property = [];
    }
    // match on the uri only when there is one. A code system may declare several properties with
    // no uri at all, and those are told apart by their code - matching on an undefined uri would
    // collapse all of them into whichever one was declared first
    let pd = url
      ? expansion.property.find(t1 => t1.uri == url || t1.code == code)
      : expansion.property.find(t1 => t1.code == code);
    if (!pd) {
      pd = {};
      expansion.property.push(pd);
      pd.code = code;
      if (url) {
        pd.uri = url;
      }
    } else if (url && !pd.uri) {
      pd.uri = url;
    }
    if (url && pd.uri != url) {
      throw new Error('URL mismatch on expansion: ' + pd.uri + ' vs ' + url + ' for code ' + code);
    }
    return pd.code;
  }

  /**
   * Carry the property definitions of an imported expansion across to this one.
   *
   * Imported concepts are copied whole (see importValueSetItem), properties and
   * all, but the definitions that give those properties a uri live on the
   * imported expansion, so without this the outer expansion has concepts
   * carrying a property that it never declares. Only definitions for properties
   * that survived the import are copied.
   *
   * @param {Object} expansion - the expansion being built
   * @param {Array} definitions - the imported expansion's `property`
   * @param {Array} items - the concepts actually taken from the import
   */
  importPropertyDefinitions(expansion, definitions, items) {
    if (!expansion || !definitions || definitions.length === 0 || items.length === 0) {
      return;
    }
    const used = new Set();
    for (const item of items) {
      for (const property of item.property || []) {
        used.add(property.code);
      }
    }
    for (const definition of definitions) {
      if (used.has(definition.code)) {
        this.declareProperty(expansion, definition.uri, definition.code);
      }
    }
  }

  /**
   * @param {boolean} [repeatable] - true when the code system may carry more than
   *   one value for this property on one concept (only the code system property
   *   loop passes this). Single-valued properties keep last-one-wins, so a status
   *   derived from two sources still yields one entry.
   */
  defineProperty(expansion, contains, url, code, valueName, value, repeatable) {
    if (value === undefined || value == null) {
      return;
    }
    // every property that appears in contains.property has to be declared in expansion.property,
    // whether or not the code system gave it a uri
    code = this.declareProperty(expansion, url, code);

    if (!contains.property) {
      contains.property = [];
    }
    let pdv = repeatable
      ? contains.property.find(t2 => t2.code == code && t2[valueName] === value)
      : contains.property.find(t2 => t2.code == code);
    if (!pdv) {
      pdv = {};
      contains.property.push(pdv);
      pdv.code = code;
    }
    pdv[valueName] = value;
  }

  /**
   * True when the requested page (offset + count) has been filled, so an
   * iteration that is not counting a total can stop. Exclusions are handled
   * after the fact and can remove codes already collected, so a value set
   * with any exclusion never stops early.
   * @returns {boolean}
   */
  pageFilled() {
    return this.count > 0 && this.offset > -1 && !this.hasExclusions
        && this.fullList.length >= this.count + this.offset;
  }

  addToTotal(t = 1) {
    if (this.total > -1 && this.totalStatus != "off") {
      this.total = this.total + t;
      this.totalStatus = 'set';
    }
  }

  decTotal(t= 1) {
    if (this.total > -1 && this.totalStatus != "off") {
      this.total = this.total - t;
      this.totalStatus = 'set';
    }
  }

  noTotal() {
    this.total = -1;
    this.totalStatus = 'off';
  }

  getPropUrl(cs, pn, cp) {
    if (cp.definition?.uri) {
      return cp.definition.uri;
    }
    for (let p of cs.propertyDefinitions()) {
      if (pn == p.code) {
        return p.uri;
      }
    }
    return undefined;
  }

  /**
   * we have a look at the value set compose to see what we have.
   * If it's all one code system(|version), and has no value set dependencies,
   * then we call it simple - this will affect how it can be handled later
   *
   * @param compose
   * @returns {undefined}
   */
  scanValueSet(compose) {
    let result = { isSimple : false, hasExcludes : true, csset : new Set(), csDoExcludes : false, csDoOffset : false};
    let simple = true;
    for (let inc of compose.include || {}) {
      if (!this.isSimpleSelect(inc, result.csset)) {
        simple = false;
      }
    }
    for (let exc of compose.exclude || []) {
      if (!this.isSimpleSelect(exc, result.csset)) {
        simple = false;
      }
      result.hasExcludes = true;
    }
    if (simple && result.csset.size == 1) {
      result.isSimple = true;
    }
    return result;
  }

  isSimpleSelect(inc, set) {
    set.add(inc.system+"|"+inc.version);
    return !inc.valueset || inc.valueset.length == 0;
  }

  excludeFilterList(exc) {
    const results = [];

    for (const f of exc.filter || []) {
      results.push({ prop: f.property, op: f.op, value: f.value });
    }

    return results;
  }

  sortByProp(a, b, name) {
    let pA = this.getPropValue(a, name);
    let pB = this.getPropValue(b, name);

    // nulls sort last
    if (pA == null && pB == null) return 0;
    if (pA == null) return 1;
    if (pB == null) return -1;

    // unwrap objects with a code property
    if (typeof pA === 'object') pA = pA.code ?? '';
    if (typeof pB === 'object') pB = pB.code ?? '';

    // numbers and booleans: subtract
    if (typeof pA === 'number' || typeof pA === 'boolean') {
      return pA - pB;
    } else {
      // strings
      return pA.localeCompare(pB);
    }
  }

  getPropValue(cc, name) {
    for (let p of cc.property) {
      if (p.code == name) {
        return getValuePrimitive(p);
      }
    }
    return null;
  }


  // special case: excluding a different version from the include
  checkForExclusionVersionSpecialCase(source, exp) {
    if (!this.params.hasVersionsMatch) {


      const includes = source.jsonObj.compose.include || [];
      const excludes = source.jsonObj.compose.exclude || [];

      if (includes.length > 0 && excludes.length > 0) {
        const system = includes[0].system;
        const allSameSystem = includes.every(i => i.system === system && i.version)
          && excludes.every(e => e.system === system && e.version);
        const noOverlap = !includes.some(i => excludes.some(e => e.version === i.version));

        if (allSameSystem && noOverlap) {
          this.params.versionsMatch = true;
          this.excludeSpecialCase = true;
          this.addParamBool(exp, 'versionsMatch', this.params.versionsMatch);

        }
      }
    }
  }
}

class ExpandWorker extends TerminologyWorker {
  internalLimit = INTERNAL_DEFAULT_LIMIT;
  externalLimit = EXTERNAL_DEFAULT_LIMIT;


  /**
   * @param {OperationContext} opContext - Operation context
   * @param {Logger} log - Logger instance
   * @param {Provider} provider - Provider for code systems and resources
   * @param {LanguageDefinitions} languages - Language definitions
   * @param {I18nSupport} i18n - Internationalization support
   */
  constructor(opContext, log, provider, languages,
              i18n, internalLimit = INTERNAL_DEFAULT_LIMIT, externalLimit = EXTERNAL_DEFAULT_LIMIT) {
    super(opContext, log, provider, languages, i18n);
    this.externalLimit = externalLimit;
    this.internalLimit = internalLimit;
  }

  /**
   * Get operation name
   * @returns {string}
   */
  opName() {
    return 'expand';
  }

  /**
   * Handle a type-level $expand request
   * GET/POST /ValueSet/$expand
   * @param {express.Request} req - Express request
   * @param {express.Response} res - Express response
   */
  async handle(req, res) {
    try {
      await this.handleTypeLevelExpand(req, res);
    } catch (error) {
      this.log.error(error);
      debugLog(error);
      req.logInfo = this.usedSources.join("|")+" - error"+(error.msgId  ? " "+error.msgId : "");
      const statusCode = error.statusCode || 500;
      if (error instanceof Issue) {
        let oo = new OperationOutcome();
        oo.addIssue(error);
        return res.status(error.statusCode || 500).json(oo.jsonObj);
      } else {
        return res.status(statusCode).json(outcomeFromError(error));
      }
    }
  }

  /**
   * Handle an instance-level $expand request
   * GET/POST /ValueSet/{id}/$expand
   * @param {express.Request} req - Express request
   * @param {express.Response} res - Express response
   */
  async handleInstance(req, res) {
    try {
      await this.handleInstanceLevelExpand(req, res);
    } catch (error) {
      this.log.error(error);
      debugLog(error);
      req.logInfo = this.usedSources.join("|")+" - error"+(error.msgId  ? " "+error.msgId : "");
      const statusCode = error.statusCode || 500;
      return res.status(statusCode).json(outcomeFromError(error));
    }
  }

  /**
   * Handle type-level expand: /ValueSet/$expand
   * ValueSet identified by url, or provided directly in body
   */
  async handleTypeLevelExpand(req, res) {
    this.deadCheck('expand-type-level');

    // Determine how the request is structured
    let valueSet = null;
    let params = null;

    if (req.method === 'POST' && req.body) {
      if (req.body.resourceType === 'ValueSet') {
        // Body is directly a ValueSet resource
        valueSet = new ValueSet(req.body);
        params = this.queryToParameters(req.query);
        this.seeSourceVS(valueSet);

      } else if (req.body.resourceType === 'Parameters') {
        // Body is a Parameters resource
        params = req.body;

        // Check for valueSet parameter
        const valueSetParam = this.findParameter(params, 'valueSet');
        if (valueSetParam && valueSetParam.resource) {
          valueSet = new ValueSet(valueSetParam.resource);
          this.seeSourceVS(valueSet);
        }

      } else {
        // Assume form body - convert to Parameters
        params = this.formToParameters(req.body, req.query);
      }
    } else {
      // GET request - convert query to Parameters
      params = this.queryToParameters(req.query);
    }
    this.addHttpParams(req, params);

    // Check for context parameter - not supported yet
    const contextParam = this.findParameter(params, 'context');
    if (contextParam) {
      return res.status(400).json(this.operationOutcome('error', 'not-supported',
        'The context parameter is not yet supported'));
    }

    // Handle tx-resource and cache-id parameters
    this.setupAdditionalResources(params);
    const logExtraOutput = this.findParameter(params, 'logExtraOutput');

    let txp = new TxParameters(this.opContext.i18n.languageDefinitions, this.opContext.i18n, false);
    txp.readParams(params);

    // If no valueSet yet, try to find by url
    if (!valueSet) {
      const urlParam = this.findParameter(params, 'url');
      const versionParam = this.findParameter(params, 'valueSetVersion');

      if (!urlParam) {
        return res.status(400).json(this.operationOutcome('error', 'invalid',
          'Must provide either a ValueSet resource or a url parameter'));
      }

      const url = this.getParameterValue(urlParam);
      const version = versionParam ? this.getParameterValue(versionParam) : null;

      valueSet = await this.findValueSet(url, version, null);
      this.seeSourceVS(valueSet, url);
      if (!valueSet) {
        return res.status(422).json(this.operationOutcome('error', 'not-found',
          version ? `ValueSet not found: ${url} version ${version}` : `ValueSet not found: ${url}`));
      }
    }

    // Perform the expansion
    const result = await this.doExpand(valueSet, txp, logExtraOutput);
    req.logInfo = this.usedSources.join("|")+txp.logInfo();
    return res.json(result);
  }

  /**
   * Handle type-level expand: /ValueSet/$expand
   * ValueSet identified by url, or provided directly in body
   */
  async handleInternalExpand(valueSet, req) {
    this.deadCheck('expand-internal');

    if (!valueSet.jsonObj) {
      valueSet = new ValueSet(valueSet);
    }
    // Determine how the request is structured
    let params = null;
    this.seeSourceVS(valueSet);

    if (req.method === 'POST' && req.body) {
      if (req.body.resourceType === 'ValueSet') {
        params = this.queryToParameters(req.query);
      } else if (req.body.resourceType === 'Parameters') {
        // Body is a Parameters resource
        params = req.body;
      } else {
        // Assume form body - convert to Parameters
        params = this.formToParameters(req.body, req.query);
      }
    } else {
      // GET request - convert query to Parameters
      params = this.queryToParameters(req.query);
    }
    this.addHttpParams(req, params);

    // Handle tx-resource and cache-id parameters
    this.setupAdditionalResources(params);
    const logExtraOutput = this.findParameter(params, 'logExtraOutput');

    let txp = new TxParameters(this.opContext.i18n.languageDefinitions, this.opContext.i18n, false);
    txp.readParams(params);

    // Perform the expansion
    return await this.doExpand(valueSet, txp, logExtraOutput);
  }

  /**
   * Handle instance-level expand: /ValueSet/{id}/$expand
   * ValueSet identified by resource ID
   */
  async handleInstanceLevelExpand(req, res) {
    this.deadCheck('expand-instance-level');

    const { id } = req.params;

    // Find the ValueSet by ID
    const valueSet = await this.provider.getValueSetById(this.opContext, id);

    if (!valueSet) {
      return res.status(422).json(this.operationOutcome('error', 'not-found',
        `ValueSet/${id} not found`));
    }

    // Parse parameters
    let params;
    if (req.method === 'POST' && req.body) {
      if (req.body.resourceType === 'Parameters') {
        params = req.body;
      } else {
        // Form body
        params = this.formToParameters(req.body, req.query);
      }
    } else {
      params = this.queryToParameters(req.query);
    }

    // Check for context parameter - not supported yet
    const contextParam = this.findParameter(params, 'context');
    if (contextParam) {
      return res.status(400).json(this.operationOutcome('error', 'not-supported',
        'The context parameter is not yet supported'));
    }

    // Handle tx-resource and cache-id parameters
    this.setupAdditionalResources(params);
    const logExtraOutput = this.findParameter(params, 'logExtraOutput');

    let txp = new TxParameters(this.opContext.i18n.languageDefinitions, this.opContext.i18n, false);
    txp.readParams(params);

    // Perform the expansion
    const result = await this.doExpand(valueSet, txp, logExtraOutput);
    req.logInfo = this.usedSources.join("|")+txp.logInfo();
    return res.json(result);
  }

  // Note: setupAdditionalResources, queryToParameters, formToParameters,
  // findParameter, getParameterValue, and wrapRawResource are inherited
  // from TerminologyWorker base class

  /**
   * Perform the actual expansion operation
   * Uses expansion cache for expensive operations
   * @param {Object} valueSet - ValueSet resource to expand
   * @param {Object} params - Parameters resource with expansion options
   * @returns {Object} Expanded ValueSet resource
   */
  async doExpand(valueSet, params, logExtraOutput) {
    this.deadCheck('doExpand');

    const expansionCache = this.opContext.expansionCache;
    // Compute cache key (only if caching is available and not debugging)
    let cacheKey = null;
    if (expansionCache && (CACHE_WHEN_DEBUGGING || !this.opContext.debugging)) {
      cacheKey = expansionCache.computeKey(valueSet, params, this.additionalResources);

      // Check for cached expansion
      const cached = expansionCache.get(cacheKey);
      if (cached) {
        this.log.debug('Using cached expansion');
        return cached;
      }
    }

    // Perform the actual expansion
    const startTime = performance.now();
    const result = await this.performExpansion(valueSet, params, logExtraOutput);
    const durationMs = performance.now() - startTime;

    // Cache if it took long enough (and not debugging)
    if (cacheKey && expansionCache && (CACHE_WHEN_DEBUGGING || !this.opContext.debugging)) {
      const wasCached = expansionCache.set(cacheKey, result, durationMs);
      if (wasCached) {
        this.log.debug(`Cached expansion (took ${Math.round(durationMs)}ms)`);
      }
    }

    return result;
  }

  /**
   * Perform the actual expansion logic
   * @param {Object} valueSet - ValueSet resource to expand
   * @param {Object} params - Parameters resource with expansion options
   * @returns {Object} Expanded ValueSet resource
   */
  async performExpansion(valueSet, params, logExtraOutput) {
    this.deadCheck('performExpansion');

    // Store params for worker methods
    this.params = params;

    if (params.limit < -1) {
      params.limit = -1;
    } else if (params.limit > this.externalLimit) {
      params.limit = this.externalLimit; // can't ask for more than this externally, though you can internally
    }

    const filter = new SearchFilterText(params.filter);
    const expander = new ValueSetExpander(this, params);
    expander.logExtraOutput = logExtraOutput;
    return await expander.expand(valueSet, filter);
  }

  /**
   * Generate a UUID
   * @returns {string} UUID
   */
  generateUuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  /**
   * Build an OperationOutcome
   * @param {string} severity - error, warning, information
   * @param {string} code - Issue code
   * @param {string} message - Diagnostic message
   * @returns {Object} OperationOutcome resource
   */
  operationOutcome(severity, code, message, txIssueType = null) {
    // the shared builder, so that every outcome has details.text and a tx-issue-type coding
    return buildOperationOutcome(severity, code, message, txIssueType);
  }

}

module.exports = {
  ExpandWorker,
  ValueSetExpander,
  ValueSetCounter,
  ImportedValueSet,
  ValueSetFilterContext,
  EmptyFilterContext,
  EXTERNAL_DEFAULT_LIMIT,
  INTERNAL_DEFAULT_LIMIT,
  EXTERNAL_TEST_DEFAULT_LIMIT,
  TotalStatus,
  EXPANSION_DEAD_TIME_SECS
};