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
// Access: the table name is the only thing that identifies a table, so anyone who knows a
// name can read, add to, or reset that table. On a public server, require UUID names
// (requireUuidNames) so that a name is effectively a secret held by the client that made it.
//
// Cost: everything a client can make this do is bounded (see LIMITS) - the tables, the
// concepts and entries in a table, what one call can add, what a table's configuration
// can store, and how many calls can queue for one table and for how long. The work itself
// yields (checkAndYield) and runs against the operation's compute deadline; the storage
// is synchronous, so reads that can be large are paged and writes are capped.
//

const { TerminologyWorker, Unknown_Code_in_VersionSCT, SCTVersion } = require('./worker');
const { TxParameters } = require('../params');
const { Issue, OperationOutcome, buildOperationOutcome, outcomeFromError } = require('../library/operation-outcome');
const { debugLog } = require('../operation-context');
const { NARROWER, EQUIVALENT } = require('../closure/closure-store');
const { VersionUtilities } = require('../../library/version-utilities');

// parameters that configure a table, and so are only accepted when it is initialised
const CONFIG_PARAMS = ['tx-resource', 'useSupplement', 'system-version', 'check-system-version', 'force-system-version'];

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Defaults for modules.tx.closure.<name>. Absent = the default; 0 = no limit.
const LIMITS = {
  maxTables: 1000,
  maxConceptsPerTable: 10000,
  maxConceptsPerRequest: 1000,
  maxEntriesPerTable: 250000,
  maxEntriesPerRequest: 50000,
  maxConfigSize: 5 * 1024 * 1024,  // bytes of stored configuration (mostly tx-resource)
  maxQueue: 10,                     // calls queued on one table, counting the running one
  lockTimeout: 60                   // seconds a call will wait for its table
};

const RESYNC_PAGE = 2000; // rows read from the store at a time

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
   * The configured value of a limit, or its default. 0 means no limit (Infinity).
   */
  limit(name) {
    const v = this.closureConfig[name];
    const n = (v === undefined || v === null) ? LIMITS[name] : Number(v);
    return (!Number.isFinite(n) || n <= 0) ? Infinity : n;
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
   * Do the operation. Everything after the request checks happens with the table locked,
   * so two calls on the same table can't interleave - each one reads the table, works out
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
    const concepts = [];
    const config = [];
    let versionParam = null;
    let reset = false;
    for (const p of list) {
      if (p.name === 'concept') {
        concepts.push(p);
      } else if (CONFIG_PARAMS.includes(p.name)) {
        config.push(p);
      } else if (p.name === 'version') {
        versionParam = p;
      } else if (p.name === 'reset') {
        reset = p.valueBoolean === true || p.valueString === 'true';
      } else if (p.name !== 'name') {
        throw this.closureIssue('not-supported', 'CLOSURE_PARAM_UNKNOWN', [safeText(p.name)], 'not-supported', 400);
      }
    }
    if (concepts.length > 0 && versionParam) {
      throw this.closureIssue('invalid', 'CLOSURE_CONCEPT_AND_VERSION', [], 'invalid-data', 400);
    }
    const maxRequest = this.limit('maxConceptsPerRequest');
    if (concepts.length > maxRequest) {
      throw this.closureIssue('too-costly', 'CLOSURE_TOO_MANY_REQUEST_CONCEPTS', [String(maxRequest)], 'too-costly', 422);
    }
    // checked here, before anything waits for the table
    let configSize = 0;
    for (const p of config) {
      configSize += JSON.stringify(p).length;
    }
    const maxConfig = this.limit('maxConfigSize');
    if (configSize > maxConfig) {
      throw this.closureIssue('too-costly', 'CLOSURE_CONFIG_TOO_LARGE', [String(maxConfig)], 'too-costly', 422);
    }

    return await this.lockTable(name, async () => {
      const initialise = reset || (concepts.length === 0 && !versionParam);
      let table = this.store.getTable(name);

      if (initialise) {
        if (versionParam) {
          throw this.closureIssue('invalid', 'CLOSURE_RESET_AND_VERSION', [], 'invalid-data', 400);
        }
        if (table && !reset) {
          throw this.closureIssue('duplicate', 'CLOSURE_TABLE_EXISTS', [name], 'business-rule', 409);
        }
        const max = this.limit('maxTables');
        if (!table && this.store.tableCount() >= max) {
          throw this.closureIssue('too-costly', 'CLOSURE_TOO_MANY_TABLES', [String(max)], 'too-costly', 422);
        }
        table = this.store.createTable(name, config);
        this.log.info(`closure table '${name}' ${reset ? 'reset' : 'created'}`);
        if (concepts.length === 0) {
          return await this.buildConceptMap(name, table.version, [], fhirVersion);
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
        return await this.resync(table, name, versionParam, fhirVersion);
      }
      return await this.add(table, name, concepts, fhirVersion);
    });
  }

  /**
   * Take the table's lock, with a bounded queue and a bounded wait. The wait goes through
   * OperationContext.waitFor: it isn't charged to the compute deadline (the call isn't
   * computing), and a client that has gone away stops waiting.
   */
  async lockTable(name, fn) {
    const maxQueue = this.limit('maxQueue');
    const timeout = this.limit('lockTimeout');
    try {
      return await this.store.withLock(name, fn, {
        maxQueue: maxQueue === Infinity ? 0 : maxQueue,
        timeoutMs: timeout === Infinity ? 0 : timeout * 1000,
        waitFor: p => this.opContext.waitFor(p, 'closure-lock')
      });
    } catch (error) {
      if (error.closureBusy) {
        throw this.closureIssue('too-costly', 'CLOSURE_TABLE_BUSY', [name], 'too-costly', 429);
      }
      throw error;
    }
  }

  /**
   * The table name: required, no whitespace or control characters, at most 64 characters
   * - and a UUID, if the administrator has said so (tx.fhir.org does, so names chosen by
   * different clients can't collide, and can't be guessed).
   */
  readName(list) {
    const p = list.find(x => x.name === 'name');
    const name = p ? this.getParameterValue(p) : null;
    if (typeof name !== 'string' || name.length === 0) {
      throw this.closureIssue('required', 'CLOSURE_NAME_REQUIRED', [], 'invalid-data', 400);
    }
    if (/[\s\p{Cc}]/u.test(name) || name.length > 64) {
      throw this.closureIssue('invalid', 'CLOSURE_NAME_INVALID', [safeText(name)], 'invalid-data', 400);
    }
    if (this.closureConfig.requireUuidNames && !UUID.test(name)) {
      throw this.closureIssue('invalid', 'CLOSURE_NAME_NOT_UUID', [name], 'invalid-data', 400);
    }
    return name;
  }

  /**
   * Resync: every entry added after the nominated version, at the table's current version.
   * The table can be large, so it is read a page at a time, yielding in between.
   */
  async resync(table, name, versionParam, fhirVersion) {
    const raw = this.getParameterValue(versionParam);
    const v = typeof raw === 'number' ? raw : (/^\d{1,15}$/.test(String(raw)) ? parseInt(raw, 10) : NaN);
    if (!Number.isInteger(v) || v < 0 || v > table.version) {
      throw this.closureIssue('invalid', 'CLOSURE_VERSION_INVALID', [safeText(raw), name, String(table.version)], 'invalid-data', 400);
    }
    this.store.touch(table.id);
    const entries = [];
    let after = 0;
    for (;;) {
      await this.checkAndYield('closure-resync');
      const page = this.store.entriesPage(table.id, v, after, RESYNC_PAGE);
      for (const r of page) {
        entries.push({
          source: { system: r.source_system, code: r.source_code, display: r.source_display },
          target: { system: r.target_system, code: r.target_code, display: r.target_display },
          relationship: r.relationship
        });
      }
      if (page.length < RESYNC_PAGE) {
        break;
      }
      after = page[page.length - 1].rowid;
    }
    return await this.buildConceptMap(name, table.version, entries, fhirVersion);
  }

  /**
   * Add concepts. Each new concept is compared with every concept of the same code system
   * already in the table (and with the ones added before it in this call), in both
   * directions. Nothing is written until every concept has been checked: an unknown code
   * system or code, or going over a limit, fails the whole call.
   */
  async add(table, name, conceptParams, fhirVersion) {
    // replay the table's configuration: its code systems, and its version rules
    const stored = { resourceType: 'Parameters', parameter: this.store.getParams(table.id) };
    this.setupAdditionalResources(stored);
    const txp = new TxParameters(this.opContext.i18n.languageDefinitions, this.opContext.i18n);
    txp.readParams(stored);

    const existing = this.store.getConcepts(table.id);
    const known = new Set();
    for (const c of existing) {
      known.add(c.system + '|' + c.code);
    }
    const providers = new Map();
    const fresh = [];

    for (const p of conceptParams) {
      await this.checkAndYield('closure-add');
      const coding = p.valueCoding;
      if (!coding || typeof coding.system !== 'string' || typeof coding.code !== 'string' || !coding.system || !coding.code) {
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

    const maxConcepts = this.limit('maxConceptsPerTable');
    if (fresh.length > 0 && existing.length + fresh.length > maxConcepts) {
      throw this.closureIssue('too-costly', 'CLOSURE_TOO_MANY_CONCEPTS', [name, String(maxConcepts)], 'too-costly', 422);
    }

    // work out the entries: each new concept against everything before it. The number of
    // entries is capped as it grows - a client-supplied code system can be shaped so that
    // nearly every pair is related - so the write below is always bounded
    const maxEntries = Math.min(this.limit('maxEntriesPerRequest'),
      this.limit('maxEntriesPerTable') - (fresh.length > 0 ? this.store.entryCount(table.id) : 0));
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
        if (entries.length >= maxEntries) {
          throw this.closureIssue('too-costly', 'CLOSURE_TOO_MANY_ENTRIES', [name], 'too-costly', 422);
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
    return await this.buildConceptMap(name, version, out, fhirVersion);
  }

  /**
   * The response: a ConceptMap of the entries, one group per source/target system, sorted
   * so the same table always reads the same way. For R3/R4 the relationship is also given
   * as the equivalence the R3/R4 OperationDefinition names ('subsumes' - the target
   * subsumes the source), which the version transform then keeps in preference to the one
   * it would work out itself ('wider').
   *
   * A resync can hand this a whole table, so it yields as it goes, and never sorts the
   * entries as one list: elements are sorted within their group (at most one per concept)
   * and targets within their element.
   */
  async buildConceptMap(name, version, entries, fhirVersion) {
    const legacy = VersionUtilities.isR3Ver(fhirVersion) || VersionUtilities.isR4Ver(fhirVersion);
    const cm = {
      resourceType: 'ConceptMap',
      version: String(version),
      title: `Closure table ${name}`,
      status: 'active',
      experimental: true,
      date: new Date().toISOString()
    };
    const groups = new Map(); // source system -> target system -> source code -> element
    for (const e of entries) {
      await this.checkAndYield('closure-response');
      let bySource = groups.get(e.source.system);
      if (!bySource) {
        bySource = new Map();
        groups.set(e.source.system, bySource);
      }
      let g = bySource.get(e.target.system);
      if (!g) {
        g = new Map();
        bySource.set(e.target.system, g);
      }
      let el = g.get(e.source.code);
      if (!el) {
        el = { code: e.source.code };
        if (e.source.display) {
          el.display = e.source.display;
        }
        el.target = [];
        g.set(e.source.code, el);
      }
      const t = { code: e.target.code };
      if (e.target.display) {
        t.display = e.target.display;
      }
      t.relationship = e.relationship;
      if (legacy) {
        t.equivalence = e.relationship === EQUIVALENT ? 'equal' : 'subsumes';
      }
      el.target.push(t);
    }

    const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    const group = [];
    for (const src of [...groups.keys()].sort(byKey)) {
      const bySource = groups.get(src);
      for (const tgt of [...bySource.keys()].sort(byKey)) {
        const g = bySource.get(tgt);
        const element = [];
        for (const code of [...g.keys()].sort(byKey)) {
          await this.checkAndYield('closure-response');
          const el = g.get(code);
          el.target.sort((a, b) => byKey(a.code, b.code));
          element.push(el);
        }
        group.push({ source: src, target: tgt, element });
      }
    }
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
    const msg = this.i18n.translate(msgId, txp ? txp.HTTPLanguages : this.opContext.langs, [safeText(code), system, version, SCTVersion(system, version)]);
    const issue = new Issue('error', 'code-invalid', 'concept', msgId, msg, 'invalid-code', 404);
    if (message) {
      issue.withDiagnostics(message);
    }
    return issue;
  }
}

/**
 * Client-supplied text going into a message (and so into the log): no control characters
 * - a newline would let a client write lines of its own into the log - and not too long.
 */
function safeText(v) {
  const s = String(v).replace(/\p{Cc}/gu, '?');
  return s.length > 100 ? s.substring(0, 100) + '...' : s;
}

module.exports = ClosureWorker;
module.exports.LIMITS = LIMITS;
