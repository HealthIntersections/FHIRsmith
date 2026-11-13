//
// Batch Validate Worker - Handles $batch-validate-code operations
//
// GET/POST /ValueSet/$batch-validate-code    - batch of ValueSet  $validate-code
// GET/POST /CodeSystem/$batch-validate-code  - batch of CodeSystem $validate-code
//
// A batch is a Parameters whose `validation` entries each carry a single
// $validate-code request (as a nested Parameters). Shared inputs may be supplied
// once at the top level ("globals") and are applied to every entry. Entries are
// dispatched per-shape (a url/valueSet entry validates against a value set; a
// system/codeSystem entry validates against a code system), so both batch routes
// share one implementation and even a mixed batch is handled correctly.
//
// The exception is `url`, which names a value set to ValueSet/$validate-code but a
// code system to CodeSystem/$validate-code. So on the CodeSystem route `url` is a
// shared global (the code system), and every entry is a CodeSystem validation;
// only the ValueSet route dispatches by shape.
//

const { TerminologyWorker } = require('./worker');
const { OperationOutcome, Issue, buildOperationOutcome, outcomeFromError } = require('../library/operation-outcome');
const {Parameters} = require("../library/parameters");
const {ValidateWorker} = require("./validate");
const {debugLog} = require("../operation-context");

class BatchValidateWorker extends TerminologyWorker {

  globalNames = new Set();

  /**
   * @param {OperationContext} opContext - Operation context
   * @param {Logger} log - Logger instance
   * @param {Provider} provider - Provider for code systems and resources
   * @param {LanguageDefinitions} languages - Language definitions
   * @param {I18nSupport} i18n - Internationalization support
   */
  constructor(opContext, log, provider, languages, i18n) {
    super(opContext, log, provider, languages, i18n);
    // "Global" parameters may be supplied once at the top level and are applied to
    // every entry that doesn't override them. tx-resource is always shared. The
    // primary differs by operation: a ValueSet batch shares url/valueSet (the value
    // set), a CodeSystem batch shares url/version/codeSystem (the code system), as
    // CodeSystem/$validate-code names them - and system, which it also accepts.
    this.valueSetGlobalNames = new Set([
      "tx-resource", "url", "valueSet", "lenient-display-validation",
      "__Accept-Language", "__Content-Language"
    ]);
    this.codeSystemGlobalNames = new Set([
      "tx-resource", "url", "version", "system", "codeSystem", "lenient-display-validation",
      "__Accept-Language", "__Content-Language"
    ]);
    // Back-compat: `globalNames` was the (ValueSet) set before CodeSystem batches.
    this.globalNames = this.valueSetGlobalNames;
  }

  /**
   * Get operation name
   * @returns {string}
   */
  opName() {
    return 'batch-validate-code';
  }

  /** ValueSet/$batch-validate-code: shared globals are url/valueSet. */
  async handleValueSet(req, res) {
    return this.processBatch(req, res, this.valueSetGlobalNames, false);
  }

  /** CodeSystem/$batch-validate-code: shared globals are url/version/system/codeSystem. */
  async handleCodeSystem(req, res) {
    return this.processBatch(req, res, this.codeSystemGlobalNames, true);
  }

  /**
   * Run a batch of $validate-code requests. Two passes: frontLoadBatch() pools all
   * supplied resources into an unsealed cache first (see that method); then each
   * `validation` entry is evaluated, inheriting the top-level globals it does not
   * override and dispatched by shape to the ValueSet or CodeSystem validator.
   *
   * @param {express.Request} req
   * @param {express.Response} res
   * @param {Set<string>} globalNames - which top-level params are shared globals
   * @param {boolean} codeSystemRoute - true for CodeSystem/$batch-validate-code: every
   *   entry is a CodeSystem validation (`url` there is the code system). On the
   *   ValueSet route, an entry with no url/valueSet is a CodeSystem validation
   */
  async processBatch(req, res, globalNames, codeSystemRoute = false) {
    try {
      let params = req.body;
      this.addHttpParams(req, params);

      let globalParams = [];
      for (const p of params.parameter) {
        if (globalNames.has(p.name)) {
          globalParams.push(p);
        }
      }

      // Pass 1: front-load every resource the batch supplies into the (unsealed)
      // session cache before any entry is evaluated. When this happens, pass 2
      // below drops per-entry tx-resource processing (they're already cached).
      const frontLoaded = this.frontLoadBatch(params);
      // Before any entry runs: prefetchCodes once per code system (and version) the entries
      // name, with all their codes. An entry passes the handle to locate (tx/cs/cs-api.md, Batches)
      this.opContext.prefetched = await this.prefetchBatch(params, globalParams, codeSystemRoute);

      let output = [];

      for (const p of params.parameter) {
        if (p.name == 'validation') {
          let op = new Parameters();
          op.jsonObj.parameter = [];
          for (const gp of globalParams) {
            if (gp.name == 'tx-resource') {
              // Pass 2: when the batch was front-loaded into an unsealed cache, the
              // tx-resources are already in the cache and every entry resolves them
              // by reference - don't re-inject or re-process them per entry. Without
              // front-loading (no cache, or a sealed cache) keep the original
              // behaviour: the global tx-resources apply to every entry.
              if (!frontLoaded) {
                op.jsonObj.parameter.push(gp);
              }
              continue;
            }
            let exists = p.resource.parameter.find(pp => gp.name == pp.name);
            if (!exists) {
              op.jsonObj.parameter.push(gp);
            }
          }
          const entryParams = frontLoaded
            ? p.resource.parameter.filter(pp => pp.name !== 'tx-resource')
            : p.resource.parameter;
          op.jsonObj.parameter.push(...entryParams);

          // Each entry gets its own provider list, closed as soon as the entry is
          // answered. Sharing the batch's list would keep every entry's providers
          // (each with an open sqlite connection, and a reference to the entry's
          // context and its log) alive until the whole batch ends.
          const entryContext = this.opContext.copy({ ownProviders: true });
          entryContext.batch = this.opContext;
          let worker = new ValidateWorker(entryContext, this.log, this.provider, this.languages, this.i18n);
          try {
            // Validating an entry never yields the event loop by itself, and IG builds send batches
            // of up to 1,000 entries (~1 s of compute): give other requests a turn between entries
            // (checkAndYield yields only after YIELD_INTERVAL ms of compute, so small batches don't),
            // and see a disconnect. Inside the try: the time limit tripping here is this entry's
            // too-costly, and the entries already answered keep their answers; a memory abort or
            // a disconnect is rethrown below and stops the whole batch.
            await this.opContext.checkAndYield('batch-validate');
            let p;
            if (!codeSystemRoute && this.hasValueSet(op.jsonObj.parameter)) {
              p = await worker.handleValueSetInner(op.jsonObj);
            } else {
              p = await worker.handleCodeSystemInner(op.jsonObj);
            }
            output.push({name: "validation", resource : p});
          } catch (error) {
            // the client has gone, or memory is short: the whole batch stops, not this entry
            if (error.abandoned || error.memoryAbort) {
              throw error;
            }
            this.log.error(error);
            debugLog(error);
            if (error instanceof Issue) {
              let op = new OperationOutcome();
              op.addIssue(error);
              output.push({name: "validation", resource : op.jsonObj});
            } else {
              output.push({name: "validation", resource : outcomeFromError(error) } );
            }
          } finally {
            await entryContext.closeProviders();
          }
        }
      }
      let result = { resourceType : "Parameters", parameter: output}
      req.logInfo = `${output.length} validations`;
      return res.json(result);
    } catch (error) {
      this.log.error(error);
      debugLog(error);
      // A batch-level failure (e.g. an unknown cache-id from pass 1) applies to the
      // whole batch. Preserve a coded Issue (like cache-id-unknown) so the client
      // gets the same coded OperationOutcome + status it would on a single op.
      if (error instanceof Issue) {
        const oo = new OperationOutcome();
        oo.addIssue(error);
        return res.status(error.statusCode || 500).json(oo.jsonObj);
      }
      return res.status(error.statusCode || 500).json(outcomeFromError(error));
    }
  }

  /**
   * Pass 1 of batch processing: front-load every resource the batch supplies
   * (each `tx-resource`, plus each entry's primary `valueSet`/`codeSystem`) into
   * the session cache before any entry is evaluated. This makes the batch
   * order-independent - an entry may refer by url to a resource another entry
   * supplied - and means a failing entry does not withhold the resources it
   * carried, because population happens up front and as one step.
   *
   * Front-loading is only relevant for an *unsealed* cache: that is what grows, so
   * that is how one entry's resources become visible to the others. A sealed cache
   * does not grow (each entry stays self-contained), and with no cache there is
   * nowhere to pool; in both cases this returns false and pass 2 keeps the original
   * per-entry tx-resource handling.
   *
   * The unknown-cache-id check is done here, once, for the whole batch.
   *
   * @param {Object} params - the batch Parameters (req.body)
   * @returns {boolean} true if resources were front-loaded into an unsealed cache
   */
  frontLoadBatch(params) {
    const cacheId = this.opContext ? this.opContext.cacheId : null;
    const cache = this.opContext ? this.opContext.resourceCache : null;
    if (!cacheId || !cache) {
      return false;
    }
    if (!cache.has(cacheId)) {
      // describeMissing names which fate the id met (never issued here / closed by
      // the client / idle-expired); the coding stays cache-id-unknown either way.
      const { messageId, params: msgParams } = cache.describeMissing(cacheId);
      throw new Issue('error', 'not-found', null, messageId,
        this.i18n.translate(messageId, this.opContext.langs, msgParams),
        'cache-id-unknown', 404);
    }
    if (cache.isSealed(cacheId)) {
      return false;
    }
    // Flatten the top-level params and every entry's params into one list, then let
    // collectSuppliedResources pick out the tx-resource + primary valueSet/codeSystem.
    const allParams = [];
    for (const p of params.parameter) {
      if (p.name === 'validation' && p.resource && Array.isArray(p.resource.parameter)) {
        allParams.push(...p.resource.parameter);
      } else {
        allParams.push(p);
      }
    }
    const { txResources, primaryResources } = this.collectSuppliedResources({ parameter: allParams });
    const pool = txResources.concat(primaryResources);
    if (pool.length > 0) {
      this.addToClientCache(cacheId, pool);
    }
    return true;
  }

  /**
   * Build an OperationOutcome
   */
  operationOutcome(severity, code, message, txIssueType = null) {
    // the shared builder, so that every outcome has details.text and a tx-issue-type coding
    return buildOperationOutcome(severity, code, message, txIssueType);
  }

  /**
   * The codes a batch's entries name, by code system and version: each coding, each coding of
   * a codeableConcept, and each code with its system (in a code system validation, its url, or its
   * codeSystem resource's), an entry's own parameters first, then the globals.
   *
   * @param {Object} params - the batch Parameters (req.body)
   * @param {Object[]} globalParams - its top-level shared parameters
   * @param {boolean} codeSystemRoute - see processBatch
   * @returns {Map<string, {system: string, version: string|null, codes: Set<string>}>} keyed system|version
   */
  batchCodes(params, globalParams, codeSystemRoute) {
    const bySystem = new Map();
    const add = (system, version, code) => {
      if (typeof system !== 'string' || !system || code == null || code === '') {
        return;
      }
      if (system.includes('|')) {
        [system, version] = [system.substring(0, system.indexOf('|')), system.substring(system.indexOf('|') + 1)];
      }
      version = typeof version === 'string' && version ? version : null;
      const key = system + '|' + (version || '');
      let entry = bySystem.get(key);
      if (!entry) {
        bySystem.set(key, entry = { system, version, codes: new Set() });
      }
      entry.codes.add(String(code));
    };
    const value = (p) => p ? (p.valueUri ?? p.valueUrl ?? p.valueCanonical ?? p.valueString ?? null) : null;
    for (const v of params.parameter) {
      if (v.name != 'validation' || !Array.isArray(v.resource?.parameter)) {
        continue;
      }
      const own = v.resource.parameter;
      const named = (name) => own.find(pp => pp.name == name) || globalParams.find(gp => gp.name == name);
      for (const p of own) {
        if (p.name == 'coding' && p.valueCoding) {
          add(p.valueCoding.system, p.valueCoding.version, p.valueCoding.code);
        } else if (p.name == 'codeableConcept' && p.valueCodeableConcept) {
          for (const c of p.valueCodeableConcept.coding || []) {
            add(c?.system, c?.version, c?.code);
          }
        } else if (p.name == 'code') {
          // as ValidateWorker reads them: a value set validation (on the ValueSet route, an
          // entry with url or valueSet; see processBatch) names system and systemVersion; a
          // code system validation url (or system, or its codeSystem resource) and version
          const code = p.valueCode ?? p.valueString;
          if (!codeSystemRoute && (named('url') || named('valueSet'))) {
            add(value(named('system')), value(named('systemVersion')), code);
          } else {
            const cs = named('codeSystem')?.resource;
            const system = value(named('url')) ?? value(named('system')) ?? cs?.url;
            add(system, value(named('version')) ?? (system === cs?.url ? cs?.version : null), code);
          }
        }
      }
    }
    return bySystem;
  }

  /**
   * prefetchCodes, on a provider of the batch's own, for each code system and version the
   * entries name that this server holds (not code system resources, nor the ecosystem), with
   * all the codes of it the entries name. Each entry builds its own provider; it passes the
   * handle for its provider's system|version to locate, and the provider uses it if it is one
   * of its own kind and data (tx/cs/cs-api.md, Batches). An entry whose code system resolves
   * to another version, or to another provider, finds no handle, or one it ignores.
   *
   * @returns {Promise<Map<string, *>|null>} system|version (as the provider reports them) -> handle
   */
  async prefetchBatch(params, globalParams, codeSystemRoute) {
    const byProvider = new Map();
    for (const { system, version, codes } of this.batchCodes(params, globalParams, codeSystemRoute).values()) {
      const factory = this.provider.codeSystemFactory(system, version);
      if (!factory) {
        continue;
      }
      let cs;
      try {
        cs = await this.provider.buildOnce(this.opContext, factory, []);
      } catch (error) {
        continue; // the entries that name it report it
      }
      this.opContext.registerProvider(cs);
      if (!cs) {
        continue;
      }
      const key = cs.system() + '|' + cs.version();
      let p = byProvider.get(key);
      if (!p) {
        byProvider.set(key, p = { cs, codes: new Set() });
      }
      for (const c of codes) {
        p.codes.add(c);
      }
    }
    const prefetched = new Map();
    for (const [key, { cs, codes }] of byProvider) {
      this.opContext.deadCheck('batch-prefetch');
      // the entries check displays, so designations are wanted
      const handle = await cs.prefetchCodes([...codes], true);
      if (handle != null) {
        prefetched.set(key, handle);
      }
    }
    return prefetched;
  }

  hasValueSet(parameter) {
    return parameter.find(p => p.name == 'url' || p.name == 'valueSet');
  }
}

module.exports = {
  BatchValidateWorker
};