//
// Compare Worker - Handles ValueSet $compare operation
//
// GET /ValueSet/{id}/$compare
// GET /ValueSet/$compare?url=...&version=...
// POST /ValueSet/$compare (form body or Parameters with url)
// POST /ValueSet/$compare (body is ValueSet resource)
// POST /ValueSet/$compare (body is Parameters with valueSet parameter)
//

const { TerminologyWorker } = require('./worker');
const {TxParameters} = require("../params");
const {Extensions} = require("../library/extensions");
const { Issue, OperationOutcome, buildOperationOutcome, outcomeFromError } = require('../library/operation-outcome');
const ValueSet = require("../library/valueset");
const {ValueSetExpander} = require("./expand");
const {SearchFilterText} = require("../library/designations");
const {ArrayMatcher} = require("../../library/utilities");
const {debugLog} = require("../operation-context");

class CompareWorker extends TerminologyWorker {
  showLogic = false;

  /**
   * @param {OperationContext} opContext - Operation context
   * @param {Logger} log - Logger instance
   * @param {Provider} provider - Provider for code systems and resources
   * @param {LanguageDefinitions} languages - Language definitions
   * @param {I18nSupport} i18n - Internationalization support
   */
  constructor(opContext, log, provider, languages, i18n) {
    super(opContext, log, provider, languages, i18n);
  }

  /**
   * Get operation name
   * @returns {string}
   */
  opName() {
    return 'compare';
  }

  /**
   * Handle a type-level $compare request
   * GET/POST /ValueSet/$compare
   * @param {express.Request} req - Express request
   * @param {express.Response} res - Express response
   */
  async handle(req, res) {
    try {
      await this.handleTypeLevelCompare(req, res);
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
   * Handle an instance-level $compare request
   * GET/POST /ValueSet/{id}/$compare
   * @param {express.Request} req - Express request
   * @param {express.Response} res - Express response
   */
  async handleInstance(req, res) {
    try {
      await this.handleInstanceLevelCompare(req, res);
    } catch (error) {
      this.log.error(error);
      debugLog(error);
      req.logInfo = this.usedSources.join("|")+" - error"+(error.msgId  ? " "+error.msgId : "");
      const statusCode = error.statusCode || 500;
      return res.status(statusCode).json(outcomeFromError(error));
    }
  }

  /**
   * Handle type-level $compare: /ValueSet/$compare
   * ValueSet identified by url, or provided directly in body
   */
  async handleTypeLevelCompare(req, res) {
    this.deadCheck('compare-type-level');

    let params = req.body;
    this.addHttpParams(req, params);
    this.setupAdditionalResources(params);
    let txp = new TxParameters(this.opContext.i18n.languageDefinitions, this.opContext.i18n, false);
    txp.readParams(params);
    this.params = txp;

    let thisVS = await this.readValueSet(res, "this", params, txp);
    let otherVS = await this.readValueSet(res, "other", params, txp);

    const result = await this.doCompare(txp, thisVS, otherVS);
    return res.json(result);
  }
  
  /**
   * Handle instance-level compare: /ValueSet/{id}/$compare
   * ValueSet identified by resource ID
   */
  async handleInstanceLevelCompare(req, res) {
    this.deadCheck('compare-instance-level');

    let params = req.body;
    this.addHttpParams(req, params);
    this.setupAdditionalResources(params);
    let txp = new TxParameters(this.opContext.i18n.languageDefinitions, this.opContext.i18n, false);
    txp.readParams(params);

    const { id } = req.params;
    // Find the ValueSet by ID
    const thisVS = await this.provider.getValueSetById(this.opContext, id);
    if (!thisVS) {
      return res.status(404).json(this.operationOutcome('error', 'not-found',
        `ValueSet/${id} not found`));
    }
    let otherVS = await this.readValueSet(res, "other", params, txp);

    const result = await this.doCompare(txp, thisVS, otherVS);
    return res.json(result);
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

  async readValueSet(res, prefix, params) {
    const valueSetParam = this.findParameter(params, prefix+'ValueSet');
    if (valueSetParam && valueSetParam.resource) {
      let valueSet = new ValueSet(valueSetParam.resource);
      this.seeSourceVS(valueSet);
      return valueSet;
    }
    // If no valueSet yet, try to find by url
    const urlParam = this.findParameter(params, prefix+'Url');
    const versionParam = this.findParameter(params, 'valueSetVersion');

    if (!urlParam) {
      return res.status(400).json(this.operationOutcome('error', 'invalid',
        `Must provide either a ${prefix}ValueSet resource or a ${prefix}Url parameter`));
    }

    const url = this.getParameterValue(urlParam);
    const version = versionParam ? this.getParameterValue(versionParam) : null;

    let valueSet = await this.findValueSet(url, version, null);
    this.seeSourceVS(valueSet, url);
    if (!valueSet) {
      return res.status(404).json(this.operationOutcome('error', 'not-found',
        version ? `ValueSet not found: ${url} version ${version}` : `ValueSet not found: ${url}`));
    } else {
      return valueSet;
    }
  }

  async doCompare(txp, thisVS, otherVS) {

    // ok, we have to compare the composes. we don't care about anything else
    const thisC = thisVS.jsonObj.compose;
    const otherC = otherVS.jsonObj.compose;
    if (!thisC) {
      return this.makeOutcome("indeterminate", `The ValueSet ${thisVS.vurl} has no compose`);
    }
    Extensions.checkNoModifiers(thisC, 'CompareWorker.doCompare', 'compose', thisVS.vurl)
    this.checkNoLockedDate(thisVS.vurl, thisC);
    if (!otherC) {
      return this.makeOutcome("indeterminate", `The ValueSet ${otherVS.vurl} has no compose`);
    }
    Extensions.checkNoModifiers(otherC, 'CompareWorker.doCompare', 'compose', otherVS.vurl)
    this.checkNoLockedDate(otherVS.vurl, otherC);

    let systems = new Map(); // tracks whether the comparison is version dependent or not

    // ok, first, if we can determine that the value sets match from the definitions, we will
    // if that fails, then we have to do the expansions, and then decide

    let allCriteria = [...thisC.include || [], ...thisC.exclude || [], ...otherC.include || [], ...otherC.exclude || []];
    // first, we sort the includes by system, and then compare them as a group
    // Build a map of system -> { this: [...includes], other: [...includes] }
    const systemMap = new Map();
    await this.addIncludes(systems, systemMap, thisC.include || [], 'this', txp, allCriteria);
    await this.addIncludes(systems, systemMap, otherC.include || [], 'other', txp, allCriteria);
    await this.addIncludes(systems, systemMap, thisC.exclude || [], 'thisEx', txp, allCriteria);
    await this.addIncludes(systems, systemMap, otherC.exclude || [], 'otherEx', txp, allCriteria);

    let status = { empty: false, left: false, right: false, fail: false, common : false};
    let diagnostics = {};

    let canBeQuick = !this.hasMultipleVersionsForAnySystem(systems, systemMap);
    if (canBeQuick) {
      for (const [key, value] of systemMap.entries()) {
        if (key) {
          let cs = await this.findCodeSystem(key, null, txp, ['complete', 'fragment'], null, true);
          await this.compareSystems(systems, status, cs, value, diagnostics);
        } else {
          this.compareNonSystems(status, value, diagnostics);
        }
      }
    } else {
      status.fail = true;
    }

    let exp = false;
    // can't tell? OK, we need to do expansions. Note that
    // expansions might not work (infinite value sets) so
    // we can't tell.
    if (status.fail) {
      status = { left: false, right: false, fail: false, common : false}; // reset;
      exp = true;
      await this.compareExpansions(systems, status, thisVS, otherVS, diagnostics);
    }
    let outcome;
    if (status.fail) {
      outcome = this.makeOutcome("indeterminate", `Unable to compare ${thisVS.vurl} and ${otherVS.vurl}: `+status.reason);
    } else if (status.empty) {
      outcome = this.makeOutcome("empty", `Both the value sets ${thisVS.vurl} and ${otherVS.vurl} are empty`);
    } else if (!status.common) {
      outcome = this.makeOutcome("disjoint", `No shared codes between the value sets ${thisVS.vurl} and ${otherVS.vurl}`);
    } else if (!status.left && !status.right) {
      outcome = this.makeOutcome("same", `The value sets ${thisVS.vurl} and ${otherVS.vurl} contain the same codes`);
    } else if (status.left && status.right) {
      outcome = this.makeOutcome("overlapping", `Both value sets ${thisVS.vurl} and ${otherVS.vurl} contain the codes the other doesn't, but there is some overlap`);
    } else if (status.left) {
      outcome = this.makeOutcome("superset", `The valueSet ${thisVS.vurl} is a super-set of the valueSet ${otherVS.vurl}`);
    } else {
      outcome = this.makeOutcome("subset", `The valueSet ${thisVS.vurl} is a sub-set of the valueSet ${otherVS.vurl}`);
    }
    if (txp.diagnostics) {
      outcome.parameter.push({name: 'performed-expansion', valueBoolean: exp ? true : false})
      if (diagnostics.missing && diagnostics.missing.length > 0) {
        outcome.parameter.push({name: 'missing-codes', valueString: diagnostics.missing.map(c => c.code).join(',') })
      }
      if (diagnostics.extra && diagnostics.extra.length > 0) {
        outcome.parameter.push({name: 'extra-codes', valueString: diagnostics.extra.map(c => c.code).join(',') })
      }
      if (diagnostics.common && diagnostics.common.length > 0) {
        outcome.parameter.push({name: 'common-codes', valueString: diagnostics.common.map(c => c.left.code).join(',') })
      }
      if (!exp) {
        if (diagnostics.missingCodes && diagnostics.missingCodes.length > 0) {
          outcome.parameter.push({name: 'missing-codes', valueString: diagnostics.missingCodes.join(',')})
        }
        if (diagnostics.extraCodes && diagnostics.extraCodes.length > 0) {
          outcome.parameter.push({name: 'extra-codes', valueString: diagnostics.extraCodes.join(',')})
        }
        if (diagnostics.commonCodes && diagnostics.commonCodes.length > 0) {
          outcome.parameter.push({name: 'common-codes', valueString: diagnostics.commonCodes.join(',')})
        }
      }
    }
    return outcome;
  }

  async addIncludes(systems, systemMap, includes, side, txp, allCriteria) {
    for (const inc of includes) {
      let key = inc.system || '';
      let v = {};
      if (await this.versionMatters(systems, key, inc.version, v, txp, allCriteria)) {
        key = key + "|" + v.version;
      }
      if (!systemMap.has(key)) {
        systemMap.set(key, {this: [], other: [], thisEx: [], otherEx: []});
      }
      systemMap.get(key)[side].push(inc);
    }
  }

  async versionMatters(systems, key, version, v, txp, allCriteria) {
    let cs = await this.findCodeSystem(key, version, txp, ['complete', 'fragment'], null, true);
    let alreadyVersionDependent = systems.has(key) && systems.get(key).criteria;
    let res = cs != null && (alreadyVersionDependent || ((version || cs.version()) && (cs.versionNeeded() || this.anyCriteriaHasFilters(allCriteria, key)))); // if there's filters, the version always matters
    if (res) {
      v.version = version || cs ? cs.version() : undefined;
    }
    if (!systems.has(key)) {
      systems.set(key, {criteria: res, codes: cs ? cs.versionNeeded() : false});
    }
    return res;
  }

  compareNonSystems(status) {
    // not done yet
    status.fail = true;
  }

  async compareSystems(systems, status, cs, value, diagnostics) {
    if ((value.thisEx && value.thisEx.length > 0) || (value.otherEx && value.otherEx.length > 0)) {
      // we don't try in this case
      status.fail = true;
      status.common = true;
    } else if (!value.this) {
      // left has nothing for this one.
      status.right = true;
      status.common = true;
    } else if (!value.other) {
      status.left = true;
      status.common = true;
    } else {
      // for now, we don't do value set imports
      if (this.hasValueSets(value.this) || this.hasValueSets(value.other)) {
        status.fail = true;
        return;
      }
      if (this.hasConceptsAndFilters(value.this) || this.hasConceptsAndFilters(value.other)) {
        status.fail = true;
        return;
      }
      // we have includes on both sides. We might have full system, a list, or a filter. we don't care about order. so clean up and sort
      this.tidyIncludes(value.this);
      this.tidyIncludes(value.other);
      if (!value.this || value.this.length === 0) {
        status.right = true;
        return;
      } else if (!value.other || value.other.length === 0) {
        status.left = true;
        return;
      } else if (this.isFullSystem(value.this[0]) && this.isFullSystem(value.other[0])) {
          // if both sides have full include, they match, period.
        status.common = true;
        return;
      } else if (this.isFullSystem(value.this[0])) {
        status.common = true;
        status.left = true;
        return;
      } else if (this.isFullSystem(value.other[0])) {
        status.common = true;
        status.right = true;
        return;
      } else if (value.this.length > 1 || value.other.length > 1) {
        status.common = true;
        // if we have mixed concepts, or multiple filters, we can't reason about them (too many scenarios where they overlap in
        // unpredictable ways. If they're not identical, we fail
        if (value.this.length != value.other.length) {
          status.fail = true;
        } else {
          for (let i = 0; i < value.this.length; i++) {
            let t = value.this[i];
            let o = value.other[i];
            if (!this.includesIdentical(t, o)) {
              status.fail = true;
              break;
            }
          }
        }
        return;
      } else if (this.isConcepts(value.this[0]) && this.isConcepts(value.other[0])) {
        this.compareCodeLists(status, value.this[0], value.other[0], diagnostics);
        return;
      } else if (this.isFilter(value.this[0]) && this.isFilter(value.other[0])) {
        let t = value.this[0];
        let o = value.other[0];
        if (!await this.filterSetsMatch(status, cs, t, o)) {
          status.fail = true;
        }
        return;
      }
    }
    status.fail = true; // not sure why we got to here, but it doesn't matter: we can't tell
  }

  hasValueSets(list) {
    for (const inc of list) {
      if (inc.valueSet) {
        return true;
      }
    }
    return false;
  }

  hasConceptsAndFilters(list) {
    for (const inc of list) {
      if (inc.concept?.length > 0 && inc.filter?.length > 0) {
        return true;
      }
    }
    return false;
  }

  hasFilters(list) {
    for (const inc of list) {
      if (inc.filter?.length > 0) {
        return true;
      }
    }
    return false;
  }

  tidyIncludes(list) {
    let collector = null;
    for (let i = list.length - 1; i >= 0; i--) {
      const inc = list[i];
      if (inc.system && inc.concept && !inc.filter) {
        if (collector) {
          collector.concept.push(...inc.concept);
          list.splice(i, 1);
        } else {
          collector = inc;
        }
      }
    }
    for (let inc of list) {
      if (inc.concept) {
        inc.concept.sort((a, b) => (a.code || '').localeCompare(b.code));
      }
      if (inc.filter) {
        inc.filter.sort((a, b) => (a.property || '').localeCompare(b.property) || (a.op || '').localeCompare(b.op) || (a.value || '').localeCompare(b.value));
      }
    }
    function includeRank(inc) {
      if (!inc.system) return 0;
      const hasConcepts = inc.concept?.length > 0;
      const hasFilters = inc.filter?.length > 0;
      if (!hasConcepts && !hasFilters) return 1;
      if (hasConcepts && !hasFilters) return 2;
      if (!hasConcepts && hasFilters) return 3;
      return 4;
    }

    function compareFilter(a, b) {
      const af = a.filter?.[0];
      const bf = b.filter?.[0];
      if (!af && !bf) return 0;
      if (!af) return -1;
      if (!bf) return 1;
      return (af.property || '').localeCompare(bf.property || '') ||
        (af.op || '').localeCompare(bf.op || '') ||
        (af.value || '').localeCompare(bf.value || '');
    }

    list.sort((a, b) =>
      includeRank(a) - includeRank(b) ||
      compareFilter(a, b)
    );
  }

  compareCodeLists(status, t, o, diagnostics) {
    const tSet = new Set(t.concept.map(x => x.code));
    const oSet = new Set(o.concept.map(x => x.code));

    diagnostics.commonCodes = [...tSet].filter(c => oSet.has(c));
    diagnostics.missingCodes = [...tSet].filter(c => !oSet.has(c));
    diagnostics.extraCodes = [...oSet].filter(c => !tSet.has(c));
    status.common = diagnostics.commonCodes.length > 0;
    status.left = diagnostics.missingCodes.length > 0;
    status.right =diagnostics.extraCodes.length > 0;
  }

  makeOutcome(code, msg) {
    const parameters = {
      resourceType: 'Parameters',
      parameter: [
        {name: 'result', valueCode: code}
      ]
    };
    if (msg) {
      parameters.parameter.push({name: 'message', valueString: msg})
    }
    return parameters;
  }

  isFullSystem(inc) {
    return !inc.concept && !inc.filter;
  }

  async compareExpansions(systems, status, thisC, otherC, diagnostics) {

    const expResThis = await this.doExpand(thisC);
    this.opContext.unSeeAll();
    const expResOther = await this.doExpand(otherC);

    if (expResThis.error || expResOther.error) {
      status.fail = true;
      if (expResThis.error && expResOther.error) {
        if (expResThis.error == expResOther.error) {
          status.reason = "Both expansions failed: "+expResThis.error.message;
        } else {
          status.reason = "Both expansions failed with different errors: "+expResThis.error.message+"; "+expResOther.error.message;
        }
      } else if (expResThis.error) {
        status.reason = "This expansion failed: "+expResThis.error.message
      } else {
        status.reason = "Other expansion failed: "+expResOther.error.message
      }
      return;
    }
    let expThis = expResThis.vs;
    let expOther = expResOther.vs;
    if (this.isUnclosed(expThis) || this.isUnclosed(expOther)) {
      status.fail = true;
      if (this.isUnclosed(expThis) && this.isUnclosed(expOther)) {
        status.reason = "Both expansions are unclosed."
      } else if (this.isUnclosed(expThis)) {
        status.reason = "This expansion is unclosed."
      } else {
        status.reason = "Other expansion is unclosed."
      }
      return;
    }

    if ((!expThis.expansion.contains || expThis.expansion.contains.length == 0) && (!expOther.expansion.contains || expOther.expansion.contains.length == 0)) {
      status.empty = true;
      return;
    }
    const matcher = new ArrayMatcher((l, r) =>
      this.matchContains(systems, l, r)
    );
    await matcher.match(expThis.expansion.contains, expOther.expansion.contains);
    if (!expThis.expansion.contains) {
      expThis.expansion.contains = [];
    }
    if (matcher.matched.length > 0) {
      status.common = true;
    }
    if (matcher.unmatchedLeft.length > 0) {
      status.left = true;
    }
    if (matcher.unmatchedRight.length > 0) {
      status.right = true;
    }
    if (matcher.unmatchedLeft.length > 0 || matcher.unmatchedRight.length > 0) {
      diagnostics.common = matcher.matched;
    }
    diagnostics.missing = matcher.unmatchedLeft;
    diagnostics.extra = matcher.unmatchedRight;
  }

  isUnclosed(vs) {
    return Extensions.has(vs.expansion, "http://hl7.org/fhir/StructureDefinition/valueset-unclosed");
  }

  matchContains(systems, thisC, otherC) {
    if (thisC.system != otherC.system) {
      return false;
    }
    if (thisC.code != otherC.code) {
      return false;
    }
    let versionMatters = systems.has(thisC.system) && systems.get(thisC.system).codes;
    if (versionMatters && thisC.version != otherC.version) {
      return false;
    } else {
      return true;
    }
  }

  async doExpand(vs) {
    try {
      let txpe = this.params.clone();
      txpe.limit = 10000;
      txpe.excludeNested = true;
      let start = new Date();
      console.log("Expanding value set");
      let exp = new ValueSetExpander(this, txpe);
      exp.noDetails = true;
      let vse = await exp.expand(vs, new SearchFilterText(''), true);
      console.log("Expanded value set - took " + (new Date() - start) + "ms");
      return {vs: vse, error: null};
    } catch (error) {
      debugLog(error, "Error expanding value set");
      return {vs: null, error: error};
    }
  }

  isConcepts(inc) {
    return inc.concept && inc.concept.length > 0 && !this.isFilter(inc);
  }

  isFilter(inc) {
    return inc.filter && inc.filter.length > 0;
  }

  async filterSetsMatch(status, cs, t, o) {
    // two includes have matching filters if the set of filters match.
    if (t.filter.length != o.filter.length) {
      return false;
    }
    if (t.filter.length > 1) {
      t.filter.sort((a, b) => (a.property || '').localeCompare(b.property) || (a.op || '').localeCompare(b.op) || (a.value || '').localeCompare(b.value));
      o.filter.sort((a, b) => (a.property || '').localeCompare(b.property) || (a.op || '').localeCompare(b.op) || (a.value || '').localeCompare(b.value))
      // we can't draw any conclusions if there's more than one filter, and they aren't identical,
      // because we don't guess how they might interact with each other
      for (let i = 0; i < (t.filter || []).length; i++) {
        if (t.filter[i].property !== o.filter[i].property || t.filter[i].op !== o.filter[i].op || t.filter[i].value !== o.filter[i].value) {
          return false;
        }
      }
      status.common = true;
      return true;
    } else {
      let tf = t.filter[0];
      let of = o.filter[0];
      if (tf.property != of.property || tf.op != of.op) {
        return false;
      }
      if (tf.value == of.value) {
        status.common = true;
        return true;
      } else if (tf.op == 'is-a') {
        let rel = await cs.subsumesTest(tf.value, of.value)
        switch (rel) {
          case 'equivalent':
            return true;
          case 'subsumes':
            status.common = true;
            status.left = true;
            return true;
          case 'subsumed-by':
            status.common = true;
            status.right = true;
            return true;
          default:
            // we know that the codes aren't related, but we don't know whether they have common children
            // well, that depends on whether there's a multi-heirarchy in play
            if (!cs.hasMultiHierarchy()) {
              status.common = false;
              status.left = true;
              status.right = true;
              return true;

            } else {
              return false;
            }
        }
      } else {
        return false;
      }
    }
  }

  includesIdentical(t, o) {
    if ((t.concept || []).length !== (o.concept || []).length) {
      return false;
    }
    for (let i = 0; i < (t.concept || []).length; i++) {
      if (t.concept[i].code !== o.concept[i].code) {
        return false;
      }
    }
    if ((t.filter || []).length !== (o.filter || []).length) {
      return false;
    }
    for (let i = 0; i < (t.filter || []).length; i++) {
      if (t.filter[i].property !== o.filter[i].property || t.filter[i].op !== o.filter[i].op || t.filter[i].value !== o.filter[i].value ) {
        return false;
      }
    }

    return true;
  }

  anyCriteriaHasFilters(allCriteria, key) {
    return allCriteria.some(c => c.system === key && c.filter && c.filter.length > 0);
  }

  hasMultipleVersionsForAnySystem(systems, systemMap) {
    return [...systems.entries()].some(([url, val]) => {
      if (val.criteria !== true) return false;
      let count = 0;
      for (const k of systemMap.keys()) {
        if (k.startsWith(url)) {
          count++;
        }
      }
      return count > 1;
    });
  }
}

module.exports = {
  CompareWorker
};