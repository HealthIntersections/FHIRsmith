//
// Closure Worker - Handles the $closure operation
//
// POST [base]/$closure
//
// $closure is defined on ConceptMap (OperationDefinition ConceptMap-closure) but is a
// SYSTEM-level operation: system=true, type=false, instance=false in R3, R4 and R5.
// So it lives at [base]/$closure, not [base]/ConceptMap/$closure (issue #100).
//
// A closure table is state held on the server between calls, and between client
// sessions, so it only exists when the administrator has turned it on and said where
// it is kept (modules.tx.closure - see ClosureStore). Without that, every request gets
// a not-supported OperationOutcome.
//
// The calls:
//   name (+ reset, + configuration)   initialise the table. It is an error if the table
//                                      already exists, unless reset = true, which wipes it
//   name + concept(s)                  add concepts; returns the entries they produce
//   name + version                     resync; returns every entry added after version
//
// The configuration is fixed when the table is initialised, and replayed on every later
// call: tx-resource (the code systems it is built over, which the client does not send
// again), useSupplement, system-version, check-system-version, force-system-version.
//
// Closure is stable across sessions, so it never uses a client's terminology cache: the
// X-Cache-Id header is ignored here.
//

const { TerminologyWorker, Unknown_Code_in_VersionSCT, SCTVersion } = require('./worker');
const { TxParameters } = require('../params');
const { Issue, OperationOutcome, buildOperationOutcome, outcomeFromError } = require('../library/operation-outcome');
const { debugLog } = require('../operation-context');
const { NARROWER, EQUIVALENT } = require('../closure/closure-store');
const { VersionUtilities } = require('../../library/version-utilities');

// parameters that configure a table, and so are only accepted when it is initialised
const CONFIG_PARAMS = ['tx-resource', 'useSupplement', 'system-version', 'check-system-version', 'force-system-version'];
// parameters that are about the call, not the table
const CALL_PARAMS = ['name', 'reset', 'concept', 'version'];

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

class ClosureWorker extends TerminologyWorker {
  /**
   * @param {OperationContext} opContext - Operation context
   * @param {Logger} log - Logger instance
   * @param {Provider} provider - Provider for code systems and resources
   * @param {LanguageDefinitions} languages - Language definitions
   * @param {I18nSupport} i18n - Internationalization support
   * @param {ClosureStore|null} store - where closure tables are kept; null = not supported
   * @param {Object} [config] - modules.tx.closure
   */
  constructor(opContext, log, provider, languages, i18n, store = null, config = {}) {
    super(opContext, log, provider, languages, i18n);
    this.store = store;
    this.closureConfig = config || {};
  }

  opName() {
    return 'closure';
  }

  // Not a value-set operation; the base class requires this to be implemented.
  vsHandle() {
    return null;
  }

  /**
   * Express entry point for [base]/$closure (GET and POST).
   * @param {express.Request} req - Express request
   * @param {express.Response} res - Express response
   */
  async handle(req, res) {
    try {
      if (!this.store) {
        return res.status(501).json(buildOperationOutcome('error', 'not-supported',
          this.i18n.translate('CLOSURE_NOT_SUPPORTED', this.opContext.langs, []), 'not-supported'));
      }
      // $closure changes state on the server (affectsState = true), so GET isn't allowed
      if (req.method !== 'POST') {
        throw this.closureIssue('invalid', 'CLOSURE_POST_ONLY', [], 'invalid-data', 405);
      }
      const params = this.buildParameters(req);
      const fhirVersion = req.txEndpoint ? req.txEndpoint.fhirVersion : '5.0';
      const cm = await this.closure(params, fhirVersion);
      return res.status(200).json(cm);
    } catch (error) {
      this.log.error(error);
      debugLog(error);
      req.logInfo = this.usedSources.join('|') + ' - error' + (error.msgId ? ' ' + error.msgId : '');
      if (error instanceof Issue) {
        const oo = new OperationOutcome();
        oo.addIssue(error);
        return res.status(error.statusCode || 500).json(oo.jsonObj);
      }
      return res.status(error.statusCode || 500).json(outcomeFromError(error));
    }
  }

  /**
   * Do the operation. Everything after the name check happens with the table locked, so
   * two calls on the same table can't interleave - each one reads the table, works out
   * what's new (which awaits, and yields), and writes, before the next starts.
   *
   * @param {Object} params - Parameters resource
   * @param {string} fhirVersion - the endpoint's FHIR version, for the response
   * @returns {Object} ConceptMap
   */
  async closure(params, fhirVersion) {
    // never the client's terminology cache - see the header comment
    this.opContext.cacheId = null;
    const list = (params.parameter || []).filter(p => p.name !== 'cache-id');

    const name = this.readName(list);
    const concepts = list.filter(p => p.name === 'concept');
    const versionParam = list.find(p => p.name === 'version');
    const reset = list.some(p => p.name === 'reset' && (p.valueBoolean === true || p.valueString === 'true'));
    const config = list.filter(p => CONFIG_PARAMS.includes(p.name));

    for (const p of list) {
      if (!CALL_PARAMS.includes(p.name) && !CONFIG_PARAMS.includes(p.name)) {
        throw this.closureIssue('not-supported', 'CLOSURE_PARAM_UNKNOWN', [p.name], 'not-supported', 400);
      }
    }
    if (concepts.length > 0 && versionParam) {
      throw this.closureIssue('invalid', 'CLOSURE_CONCEPT_AND_VERSION', [], 'invalid-data', 400);
    }

    return await this.store.withLock(name, async () => {
      const initialise = reset || (concepts.length === 0 && !versionParam);
      let table = this.store.getTable(name);

      if (initialise) {
        if (versionParam) {
          throw this.closureIssue('invalid', 'CLOSURE_RESET_AND_VERSION', [], 'invalid-data', 400);
        }
        if (table && !reset) {
          throw this.closureIssue('duplicate', 'CLOSURE_TABLE_EXISTS', [name], 'business-rule', 409);
        }
        const max = this.closureConfig.maxTables;
        if (!table && max && this.store.tableCount() >= max) {
          throw this.closureIssue('too-costly', 'CLOSURE_TOO_MANY_TABLES', [String(max)], 'too-costly', 422);
        }
        table = this.store.createTable(name, config);
        this.log.info(`closure table '${name}' ${reset ? 'reset' : 'created'}`);
        if (concepts.length === 0) {
          return this.buildConceptMap(name, table.version, [], fhirVersion);
        }
      } else {
        if (!table) {
          throw this.closureIssue('not-found', 'CLOSURE_TABLE_UNKNOWN', [name], 'not-found', 404);
        }
        if (config.length > 0) {
          throw this.closureIssue('invalid', 'CLOSURE_CONFIG_NOT_ALLOWED', [config[0].name], 'invalid-data', 400);
        }
      }

      if (versionParam) {
        return this.resync(table, name, versionParam, fhirVersion);
      }
      return await this.add(table, name, concepts, fhirVersion);
    });
  }

  /**
   * The table name: required, no whitespace, at most 64 characters - and a UUID, if the
   * administrator has said so (tx.fhir.org does, so names chosen by different clients
   * can't collide).
   */
  readName(list) {
    const p = list.find(x => x.name === 'name');
    const name = p ? this.getParameterValue(p) : null;
    if (typeof name !== 'string' || name.length === 0) {
      throw this.closureIssue('required', 'CLOSURE_NAME_REQUIRED', [], 'invalid-data', 400);
    }
    if (/\s/.test(name) || name.length > 64) {
      throw this.closureIssue('invalid', 'CLOSURE_NAME_INVALID', [name], 'invalid-data', 400);
    }
    if (this.closureConfig.requireUuidNames && !UUID.test(name)) {
      throw this.closureIssue('invalid', 'CLOSURE_NAME_NOT_UUID', [name], 'invalid-data', 400);
    }
    return name;
  }

  /**
   * Resync: every entry added after the nominated version, at the table's current version.
   */
  resync(table, name, versionParam, fhirVersion) {
    const raw = this.getParameterValue(versionParam);
    const v = typeof raw === 'number' ? raw : (/^\d+$/.test(String(raw)) ? parseInt(raw, 10) : NaN);
    if (!Number.isInteger(v) || v < 0 || v > table.version) {
      throw this.closureIssue('invalid', 'CLOSURE_VERSION_INVALID', [String(raw), name, String(table.version)], 'invalid-data', 400);
    }
    this.store.touch(table.id);
    const rows = this.store.entriesSince(table.id, v).map(r => ({
      source: { system: r.source_system, code: r.source_code, display: r.source_display },
      target: { system: r.target_system, code: r.target_code, display: r.target_display },
      relationship: r.relationship
    }));
    return this.buildConceptMap(name, table.version, rows, fhirVersion);
  }

  /**
   * Add concepts. Each new concept is compared with every concept of the same code system
   * already in the table (and with the ones added before it in this call), in both
   * directions. Nothing is written until every concept has been checked: an unknown code
   * system or code fails the whole call.
   */
  async add(table, name, conceptParams, fhirVersion) {
    // replay the table's configuration: its code systems, and its version rules
    const stored = { resourceType: 'Parameters', parameter: this.store.getParams(table.id) };
    this.setupAdditionalResources(stored);
    const txp = new TxParameters(this.opContext.i18n.languageDefinitions, this.opContext.i18n);
    txp.readParams(stored);

    const existing = this.store.getConcepts(table.id);
    const known = new Set(existing.map(c => c.system + '|' + c.code));
    const providers = new Map();
    const fresh = [];

    for (const p of conceptParams) {
      await this.checkAndYield('closure-add');
      const coding = p.valueCoding;
      if (!coding || !coding.system || !coding.code) {
        throw this.closureIssue('invalid', 'CLOSURE_CONCEPT_INVALID', [], 'invalid-data', 400);
      }
      let cs = providers.get(coding.system);
      if (!cs) {
        cs = await this.findCodeSystem(coding.system, coding.version || '', txp, ['complete'], null, false, true);
        this.seeSourceProvider(cs, coding.system);
        providers.set(coding.system, cs);
      }
      const loc = await cs.locate(coding.code);
      if (!loc || !loc.context) {
        throw this.unknownCodeIssue(cs, coding.code, loc ? loc.message : null, txp);
      }
      // the code system's own spelling of the code, so a case-insensitive code system
      // doesn't end up with the same concept in the table twice
      const code = (await cs.code(loc.context)) || coding.code;
      const key = coding.system + '|' + code;
      if (known.has(key)) {
        continue;
      }
      known.add(key);
      // ref: how the store refers to it until it has an id (see ClosureStore.recordAdd)
      fresh.push({ key, ref: key, system: coding.system, code, display: await cs.display(loc.context), cs });
    }

    const max = this.closureConfig.maxConceptsPerTable;
    if (max && fresh.length > 0 && existing.length + fresh.length > max) {
      throw this.closureIssue('too-costly', 'CLOSURE_TOO_MANY_CONCEPTS', [name, String(max)], 'too-costly', 422);
    }

    // work out the entries: each new concept against everything before it
    const entries = [];
    const out = [];
    const before = existing.map(c => ({ ref: c.id, system: c.system, code: c.code, display: c.display }));
    for (const n of fresh) {
      for (const o of before) {
        if (o.system !== n.system) {
          continue;
        }
        await this.checkAndYield('closure-subsumes');
        const outcome = await n.cs.subsumesTest(n.code, o.code);
        let source, target, relationship;
        if (outcome === 'subsumes') {          // the new concept is the broader one
          source = o; target = n; relationship = NARROWER;
        } else if (outcome === 'subsumed-by') { // the new concept is the narrower one
          source = n; target = o; relationship = NARROWER;
        } else if (outcome === 'equivalent') {
          source = n; target = o; relationship = EQUIVALENT;
        } else {
          continue;
        }
        entries.push({ source: source.ref, target: target.ref, relationship });
        out.push({ source, target, relationship });
      }
      before.push(n);
    }

    const version = this.store.recordAdd(table, fresh, entries);
    if (fresh.length > 0) {
      this.log.info(`closure table '${name}': added ${fresh.length} concept(s), ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}, now version ${version}`);
    }
    return this.buildConceptMap(name, version, out, fhirVersion);
  }

  /**
   * The response: a ConceptMap of the entries, one group per source/target system, sorted
   * so the same table always reads the same way. For R3/R4 the relationship is also given
   * as the equivalence the R3/R4 OperationDefinition names ('subsumes' - the target
   * subsumes the source), which the version transform then keeps in preference to the one
   * it would work out itself ('wider').
   */
  buildConceptMap(name, version, entries, fhirVersion) {
    const legacy = VersionUtilities.isR3Ver(fhirVersion) || VersionUtilities.isR4Ver(fhirVersion);
    const cm = {
      resourceType: 'ConceptMap',
      version: String(version),
      title: `Closure table ${name}`,
      status: 'active',
      experimental: true,
      date: new Date().toISOString()
    };
    const groups = new Map();
    for (const e of entries) {
      const gk = e.source.system + ' ' + e.target.system;
      if (!groups.has(gk)) {
        groups.set(gk, { source: e.source.system, target: e.target.system, elements: new Map() });
      }
      const g = groups.get(gk);
      if (!g.elements.has(e.source.code)) {
        g.elements.set(e.source.code, { code: e.source.code, display: e.source.display, target: [] });
      }
      const t = { code: e.target.code, display: e.target.display, relationship: e.relationship };
      if (legacy) {
        t.equivalence = e.relationship === EQUIVALENT ? 'equal' : 'subsumes';
      }
      g.elements.get(e.source.code).target.push(t);
    }
    const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    const group = [...groups.values()]
      .sort((a, b) => byKey(a.source, b.source) || byKey(a.target, b.target))
      .map(g => ({
        source: g.source,
        target: g.target,
        element: [...g.elements.values()]
          .sort((a, b) => byKey(a.code, b.code))
          .map(el => {
            const r = { code: el.code };
            if (el.display) r.display = el.display;
            r.target = el.target.sort((a, b) => byKey(a.code, b.code)).map(t => {
              const x = { code: t.code };
              if (t.display) x.display = t.display;
              x.relationship = t.relationship;
              if (t.equivalence) x.equivalence = t.equivalence;
              return x;
            });
            return r;
          })
      }));
    if (group.length > 0) {
      cm.group = group;
    }
    return cm;
  }

  closureIssue(cause, msgId, params, txIssueType, status) {
    return new Issue('error', cause, null, msgId, this.i18n.translate(msgId, this.opContext.langs, params), txIssueType, status);
  }

  /**
   * An unknown code - the same message id and tx-issue-type as $validate-code and $subsumes.
   */
  unknownCodeIssue(cs, code, message, txp) {
    const system = cs.system();
    const version = cs.version();
    const msgId = Unknown_Code_in_VersionSCT(system, version);
    const msg = this.i18n.translate(msgId, txp ? txp.HTTPLanguages : this.opContext.langs, [code, system, version, SCTVersion(system, version)]);
    const issue = new Issue('error', 'code-invalid', 'concept', msgId, msg, 'invalid-code', 404);
    if (message) {
      issue.withDiagnostics(message);
    }
    return issue;
  }
}

module.exports = ClosureWorker;
