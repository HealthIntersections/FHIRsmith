'use strict';
const { TxParameters } = require('../params');
// Generic CodeSystemProvider over one sqlite-v2 file (LOINC, RxNorm, and the base of SNOMED CT;
// see snomed.js for the SNOMED layer).
//
// Membership questions (filters, validate-code, subsumes) are answered by the engine over the
// stored bitmaps; SQL is used for facts only (rows of a page, designations, properties). Rows are
// fetched in batches: a page of an expansion is one statement per table.
//
// handlesSelecting()/processSelection() hand whole single-system composes to the engine.
// Anything the engine does not support returns null, and expand.js then takes its usual path,
// which reaches this provider through the filter API (itself engine-backed).

const { Issue } = require('../library/operation-outcome');
const { CodeSystemFactoryProvider, CodeSystemProvider } = require('../cs/cs-api');
const { BaseCSServices } = require('../cs/cs-base');
const { CodeSystem } = require('../library/codesystem');
const { Language } = require('../../library/languages');
const { V2Store, KIND, count: countStatement } = require('./store');
const { Engine } = require('./engine/engine');
const { Compiler, FilterError } = require('./engine/compile');
const { dialectFor, LOINC, RXNORM } = require('./dialects');
const { SupplementLayers } = require('./layers');
const { orderKind, computeOrder, storedOrder, builtOrder, hasTable, HIER_CHILD } = require('./orders');
const { RoaringBitmap32 } = require('roaring');
const { sctTextSearchG, sctTextLanguages, rxTextSearchG, loincTextSearchG, genericTextSearchG } = require('./text-index');
const { runAsync: runPausing } = require('./engine/evaluate');
const { SupplementTextIndex } = require('../library/supplement-text-index');
const { languageByte, languageCode, languageBytesFor } = require('../sct/languages');

const CHUNK = 500; // rows fetched per statement while iterating a filter set
const PAGE_ROWS = 2000; // a processSelection page's rows read per statement, with a pause between

/** a concept handle: id (concept_id), code; row/designations filled lazily or by a page batch */
class V2Concept {
  constructor(id, code, row = null) {
    this.id = id;
    this.code = code;
    this.row = row;
    this.desigs = null;
    this.peers = null; // the chunk whose designations are read together (_loadChunk)
    this.status = undefined; // LOINC STATUS, when read with the row (undefined = not read)
  }
}

/** a filter set: a bitmap (or a page of ids) iterated with batched row fetches */
class V2FilterSet {
  constructor(bm, opts = {}) {
    this.bm = bm;               // RoaringBitmap32 or null (membership by probing `node`)
    this.node = opts.node || null;
    this.ids = opts.ids || null; // explicit page (processSelection)
    this.total = opts.total;
    this.pos = -1;
    this.buf = [];
    this.bufStart = 0;
    this.current = null;
    this.expressionsFalse = !!opts.expressionsFalse;
  }
  get size() { return this.ids ? this.ids.length : (this.bm ? this.bm.size : 0); }
}

class V2Prep {
  constructor(iterate, languages = null) {
    this.forIterate = iterate;
    this.languages = languages; // what the request asked for (a text filter searches one language)
    this.filters = [];
    this.nodes = [];
    this.specs = []; // the filters as given (prop, op, value), for providers that hand some requests on
    this.expressionsFalse = false;
  }
}

class SqliteV2Provider extends BaseCSServices {
  /**
   * @param {OperationContext} opContext
   * @param {CodeSystem[]} supplements
   * @param {SqliteV2Factory} factory
   */
  constructor(opContext, supplements, factory) {
    super(opContext, supplements);
    this.f = factory;
    this.store = factory.store;
    this.engine = factory.engine;
    this.dialect = factory.dialect;
    this.concepts = new Map(); // id -> V2Concept handle, for this request (the provider is per request)
    this.byCode = new Map(); // normalised code -> V2Concept (or null: not in this file) located by this request
    this.layers = factory.layers.forSupplements(supplements || []);
    // the request's trace (OperationContext.tracer: a tracer a request may carry), or null: store
    // reads count into it
    this._trace = opContext.tracer || null;
  }

  // ---- metadata ---------------------------------------------------------------------------

  system() { return this.store.system; }
  version() { return this.store.version; }
  name() { return this.f.name(); }
  description() { return this.f.description(); }
  lookupName() { return this.f.lookupName(); }
  defLang() { return this.f.defLang(); }
  totalCount() { return this.f.totalCount(); }
  async countAllCodes(excludeInactive) { return excludeInactive ? this.store.active().size : this.totalCount(); }
  hasParents() { return !!this.store.hierarchy || this.dialect.name === 'rxnorm'; }
  isNotClosed() { return !!this.store.config.notClosed; }
  contentMode() { return this.store.cs.content || 'complete'; }
  versionAlgorithm() { return this.f.versionAlgorithm(); }
  isCaseSensitive() { return this.store.config.caseSensitive !== 0 && this.store.config.caseSensitive !== '0'; }
  sourcePackage() { return null; }

  /**
   * cs-api _supplementSearchCodes (main since #398): the codes a supplement in use gives a name in
   * the search language that has every word of the filter, but those whose matching names only
   * repeat the code's own display (_rootDisplay); `sources` gets the supplement each came from (for
   * used-supplement), each searched with main's SupplementTextIndex
   */
  async _supplementSearchCodes(filter, searchLang, sources = null) {
    const codes = new Set();
    for (const s of this.supplements || []) {
      const matches = await SupplementTextIndex.of(s, this.defLang()).searchTexts(filter, searchLang);
      // the codes' own displays, read together (a language pack's copies of the English names
      // can match thousands of codes)
      const roots = this._rootDisplays([...matches.keys()].filter((c) => !codes.has(c)));
      for (const [code, texts] of matches) {
        if (codes.has(code)) continue;
        const root = roots.get(code);
        if (root && texts.every((t) => CodeSystemProvider.sameText(t, root))) continue;
        codes.add(code);
        if (sources) sources.set(code, s.vurl);
      }
    }
    return codes;
  }

  /** _rootDisplay of many codes: Map code -> display (those with one) */
  _rootDisplays(codes) {
    const out = new Map();
    if (!codes.length || (this.dialect.name !== 'snomed' && this.dialect.name !== 'loinc')) return out;
    const norm = codes.map((c) => this.normaliseCode(c));
    const ids = this.store.resolveCodes(norm, this._stats());
    const rows = this.store.conceptRows([...new Set(ids.values())], this._stats());
    codes.forEach((c, i) => {
      const id = ids.get(norm[i]);
      const row = id != null ? rows.get(id) : null;
      if (row && row.display) out.set(c, row.display);
    });
    return out;
  }

  /** the code's own display in the file (cs-api _rootDisplay): SNOMED CT's preferred term, LOINC's display */
  async _rootDisplay(code) {
    if (this.dialect.name !== 'snomed' && this.dialect.name !== 'loinc') return null;
    const id = this.store.idOf(this.normaliseCode(code), this._stats());
    if (id == null) return null;
    const row = this.store.conceptRows([id], this._stats()).get(id);
    return (row && row.display) || null;
  }

  hasAnyDisplays(languages) {
    const langs = this._ensureLanguages(languages);
    if (this._hasAnySupplementDisplays(langs)) return true;
    for (const requested of langs.languages) {
      for (const l of this.f.languages()) {
        if (new Language(l).matchesForDisplay(requested)) return true;
      }
    }
    return super.hasAnyDisplays(langs);
  }

  // ---- concepts ---------------------------------------------------------------------------

  _concept(id, row) {
    let c = this.concepts.get(id);
    if (!c) {
      c = new V2Concept(id, row ? row.code : null, row || null);
      this.concepts.set(id, c);
    } else if (row && !c.row) {
      c.row = row;
      c.code = row.code;
    }
    return c;
  }

  /** make sure the page's rows (and designations) are loaded, in one statement per table */
  _loadRows(concepts, withDesignations = true) {
    const need = concepts.filter((c) => !c.row).map((c) => c.id);
    const st = this._stats();
    if (need.length) {
      const rows = this.store.conceptRows(need, st);
      for (const c of concepts) if (!c.row) { c.row = rows.get(c.id); c.code = c.row ? c.row.code : c.code; }
    }
    // LOINC STATUS with the rows: getStatus() is asked for every code of an expansion
    const sp = this.dialect.name === 'loinc' ? this.store.props.get('STATUS') : null;
    if (sp) {
      const ns = concepts.filter((c) => c.status === undefined && c.row).map((c) => c.id);
      if (ns.length) {
        const vals = this.store.literalValues(ns, sp.id, st);
        for (const c of concepts) if (c.status === undefined && c.row) c.status = vals.has(c.id) ? vals.get(c.id) : null;
      }
    }
    if (withDesignations) {
      const nd = concepts.filter((c) => !c.desigs).map((c) => c.id);
      if (nd.length) {
        // LOINC: RELATEDNAMES2 is never a designation or a display (only a $lookup property): not read here
        const skip = this._relatedUse();
        const d = this.store.designationRows(nd, st, skip != null ? { skipUse: skip } : {});
        for (const c of concepts) if (!c.desigs) { c.desigs = d.get(c.id) || []; if (skip != null) c.desigsNoRelated = true; }
      }
    }
  }

  /**
   * An iterated chunk's rows now, its designations when one of them first needs them (_needDesigs),
   * in one statement for the chunk's others still without them. An import expanded for its codes
   * only (expand.js deferDetails) never reads most of its designations: an imported SNOMED CT
   * value set of 100,000s of codes held them all in this request's working set until it ended.
   */
  _loadChunk(concepts) {
    this._loadRows(concepts, false);
    const peers = concepts.filter((c) => !c.desigs && !c.displayOnly);
    for (const c of peers) c.peers = peers;
  }

  /** a concept's designations, read with its chunk's (see _loadChunk) */
  _needDesigs(c) {
    if (c.desigs) return;
    const peers = c.peers;
    if (!peers) {
      this._loadRows([c], true);
      return;
    }
    this._loadRows(peers.filter((p) => !p.desigs), true);
    for (const p of peers) p.peers = null;
  }

  _stats() { return this._trace ? this._trace.stats : null; }

  /**
   * The request's cooperative yield for engine evaluations (opContext.checkAndYield: it gives the
   * event loop a turn after each 10 ms of compute, and stops at the request's deadline or when the
   * client has gone, as the built-in providers' loops do), or null outside a request
   */
  _pause() {
    const oc = this.opContext;
    if (!oc || typeof oc.checkAndYield !== 'function') return null;
    return () => oc.checkAndYield('sqlite-v2');
  }

  /** LOINC's RELATEDNAMES2 use_id when designation reads leave it out (else null) */
  _relatedUse() {
    if (this.dialect.name !== 'loinc') return null;
    if (this.f._relatedUseId === undefined) {
      this.f._relatedUseId = null;
      for (const [id, u] of this.store.uses) if (u.code === 'RELATEDNAMES2') this.f._relatedUseId = id;
    }
    return this.f._relatedUseId;
  }

  async _ensure(context) {
    if (context == null) return null;
    if (context instanceof V2Concept) {
      if (!context.row) this._loadRows([context], false);
      return context;
    }
    if (typeof context === 'string') {
      const r = await this.locate(context);
      if (!r.context) throw new Error(r.message || `Unknown code ${context}`);
      return r.context;
    }
    throw new Error('Invalid context for ' + this.name());
  }

  async locate(code, prefetched = null) {
    if (!this._trace) return this._locate(code, prefetched);
    return this._trace.spanAsync('locate code', 'sql', this.system(), () => this._locate(code, prefetched));
  }

  async _locate(code, prefetched = null) {
    if (code == null || code === '') return { context: null, message: 'Empty code' };
    const n = this.normaliseCode(code);
    // a prefetchCodes handle read from this file answers for the codes it holds, without a
    // statement: this provider's, or, in a $batch-validate-code, the batch's (cs-api.md, Batches)
    const ids = prefetched && prefetched.store === this.store && prefetched.ids ? prefetched.ids : null;
    let c;
    if (ids && ids.has(n)) {
      const id = ids.get(n);
      c = id == null ? null : this._fromHandle(prefetched, id);
    } else {
      // a code this request already located is not looked up again; otherwise the code and its
      // row in one statement
      c = this.byCode.get(n);
      if (c === undefined) {
        const row = this.store.rowForCode(n, this._stats());
        c = row ? this._concept(row.concept_id, row) : null;
        this.byCode.set(n, c);
      }
    }
    if (!c) return { context: null, message: undefined };
    if (!c.row) this._loadRows([c], false);
    return { context: c, message: null };
  }

  normaliseCode(code) { return String(code); }

  /** a listed code that locate() finds as written, so processSelection can resolve it by code */
  _plainListedCode(code) { return typeof code === 'string' && code !== '' && this.normaliseCode(code) === code; }

  /**
   * This provider's concept for an id a prefetchCodes handle holds. The handle may be another
   * provider's of this file (a $batch-validate-code's, read before its entries ran): what it read
   * is taken into this provider's working set.
   */
  _fromHandle(handle, id) {
    const got = handle.concepts && handle.concepts.get(id);
    const c = this._concept(id, got ? got.row : null);
    if (got && got !== c) {
      if (!c.desigs && got.desigs) { c.desigs = got.desigs; c.desigsNoRelated = got.desigsNoRelated; }
      if (!c.desigs && got.displayOnly) c.displayOnly = true;
      if (c.status === undefined) c.status = got.status;
    }
    return c;
  }

  /**
   * cs-api: the worker is about to locate these listed codes one by one. Resolve them and read
   * their rows in one statement (and designations, and LOINC STATUS, in one more each), and return the handle the worker passes
   * back to locate(): { store, ids, concepts }, ids a map of normalised code -> id (or null),
   * concepts what was read, by id. Nothing about the list is kept on the provider; two lists in
   * progress have two handles. The handle holds what it read, and is told by its file (store), so
   * another provider of the file can use it: a $batch-validate-code reads its codes once, before
   * its entries run, and each entry has its own provider (cs-api.md, Batches). (The concepts read
   * are in this request's working set, this.concepts, as any concept the request reads.)
   * hints.displayOnly: the response shows each code's display only (expand.js, the rule
   * processSelection applies itself), so the designation rows aren't read; designations()
   * reports the display.
   */
  async prefetchCodes(codes, withDesignations = true, hints = {}) {
    const norm = [];
    for (const c of codes || []) {
      if (c == null || c === '') continue;
      norm.push(this.normaliseCode(c));
    }
    if (!norm.length) return null;
    const ids = new Map();
    const read = new Map();
    const run = () => {
      const concepts = [];
      // codes and their rows in one statement
      const uniq = [...new Set(norm)];
      const rows = this.store.rowsForCodes(uniq, this._stats());
      for (const n of uniq) {
        const r = rows.get(n);
        ids.set(n, r ? r.concept_id : null);
        if (r) concepts.push(this._concept(r.concept_id, r));
      }
      for (const c of concepts) read.set(c.id, c);
      const displayOnly = !!(hints && hints.displayOnly);
      if (displayOnly) for (const c of concepts) if (!c.desigs) c.displayOnly = true;
      this._loadRows(concepts, withDesignations && !displayOnly);
    };
    if (this._trace) this._trace.span('prefetch enumerated codes (' + norm.length + ')', 'rows', this.system(), run);
    else run();
    return { store: this.store, ids, concepts: read };
  }

  async code(context) {
    const c = await this._ensure(context);
    return c ? c.code : null;
  }

  async display(context) {
    const c = await this._ensure(context);
    if (!c) return null;
    const s = this._displayFromSupplements(c.code);
    if (s) return s;
    if (this.dialect.name === 'loinc' && this.opContext.langs && !this.opContext.langs.isEnglishOrNothing()) {
      this._needDesigs(c);
      const types = ['LONG_COMMON_NAME', 'SHORTNAME', 'DisplayName'];
      const cands = [{ language: 'en-US', term: c.row.display }]
        .concat(c.desigs.filter((d) => d.use && types.includes(d.use.code)).sort((a, b) => types.indexOf(a.use.code) - types.indexOf(b.use.code)));
      const langs = this.opContext.langs.languages || [];
      for (const exact of [true, false]) {
        for (const l of langs) for (const d of cands) if (l.matches(d.language, exact)) return d.term;
      }
    }
    return (c.row && c.row.display) || '';
  }

  async definition(context) {
    const c = await this._ensure(context);
    return c && c.row ? c.row.definition || null : null;
  }

  async isAbstract() { return false; }

  async isInactive(context) {
    const c = await this._ensure(context);
    return c ? !c.row.active : false;
  }

  async isDeprecated(context) {
    const c = await this._ensure(context);
    if (this.dialect.name === 'rxnorm') return this._rxArchived(c);
    return false;
  }

  /** RxNorm: the concepts in RXNCONSO (active or obsolete), not the archived ones */
  _rxLive() {
    const p = this.store.props.get('SUPPRESS');
    return p ? this.store.getSet(KIND.hasProp, p.id, 0, this._stats()) : this.store.active();
  }

  /** RxNorm: inactive because archived (RXNATOMARCHIVE only), not obsolete (SUPPRESS = O) */
  _rxArchived(c) { return !c.row.active && !this._rxLive().has(c.id); }

  async getStatus(context) {
    const c = await this._ensure(context);
    if (!c) return null;
    if (this.dialect.name === 'loinc') {
      if (c.status !== undefined) return c.status;
      const p = this.store.props.get('STATUS');
      if (!p) return null;
      const q = this.store.stmt('SELECT value FROM concept_literal WHERE concept_id = +? AND property_id = ? AND active = 1 LIMIT 1');
      const r = q.get(c.id, p.id);
      const st = this._stats();
      if (st) countStatement(st, this.store, q, r ? 1 : 0);
      return r ? r.value : null;
    }
    if (this.dialect.name === 'rxnorm') return c.row.active ? null : (this._rxArchived(c) ? 'archived' : 'obsolete');
    return c.row.active ? 'active' : 'inactive';
  }

  async parent() { return null; }

  isDisplay(d) {
    if (this.dialect.name === 'loinc') return !!(d.use && ['SHORTNAME', 'LONG_COMMON_NAME', 'LinguisticVariantDisplayName'].includes(d.use.code));
    return false;
  }

  async designations(context, displays, significantOnly) {
    // one step only when it reads rows (an expansion page has them already)
    const c = context instanceof V2Concept ? context : null;
    if (!this._trace || (c && (c.desigs || c.displayOnly))) return this._designations(context, displays, significantOnly);
    return this._trace.spanAsync('designations', 'rows', this.system(), () => this._designations(context, displays, significantOnly));
  }

  async _designations(context, displays) {
    const c = await this._ensure(context);
    if (!c) return;
    if (!c.desigs && c.displayOnly) {
      // a page whose response shows displays only (see processSelection)
      this._displayOnly(c, displays);
      return;
    }
    this._needDesigs(c);
    if (this.dialect.name === 'loinc') {
      displays.addDesignation(true, 'active', 'en-US', CodeSystem.makeUseForDisplay(), (c.row.display || '').trim());
      for (const d of sortLoinc(c.desigs)) {
        if (d.use && d.use.code === 'RELATEDNAMES2') continue;
        displays.addDesignation(false, 'active', d.language, d.use ? { system: d.use.system, code: d.use.code, display: d.use.display } : null, d.term.trim());
      }
    } else if (this.dialect.name === 'rxnorm') {
      // upstream: the display is the first non-SY atom; every other atom is a designation
      displays.addDesignation(true, 'active', 'en-US', null, c.row.display || '');
      let skipped = false;
      for (const d of c.desigs) {
        if (!skipped && d.term === c.row.display && !(d.use && d.use.code === 'SY')) { skipped = true; continue; }
        displays.addDesignation(false, 'active', 'en-US', null, d.term);
      }
    } else {
      if (c.row.display) displays.addDesignation(true, 'active', this.defLang(), null, c.row.display);
      for (const d of c.desigs) {
        displays.addDesignation(false, d.active ? 'active' : 'inactive', d.language, d.use, d.term);
      }
    }
    this._listSupplementDesignations(c.code, displays);
  }

  /** the display as the one designation, as each dialect adds it, plus supplement designations */
  _displayOnly(c, displays) {
    const d = (c.row && c.row.display) || '';
    if (this.dialect.name === 'loinc') displays.addDesignation(true, 'active', 'en-US', CodeSystem.makeUseForDisplay(), d.trim());
    else if (this.dialect.name === 'rxnorm' || this.dialect.name === 'snomed') displays.addDesignation(true, 'active', 'en-US', null, d);
    else if (d) displays.addDesignation(true, 'active', this.defLang(), null, d);
    this._listSupplementDesignations(c.code, displays);
  }



  // ---- iteration --------------------------------------------------------------------------

  async iterator(context) {
    let ids;
    if (context == null) {
      // the usual path's whole-system walk (expand.js includeCodeAndDescendants): rows are then
      // read in batches by nextContext and counted in the include's span
      if (this._trace) this._trace.annotate({ walk: 'whole system from roots (expand.js usual path)' });
      ids = this._roots();
    } else {
      const c = await this._ensure(context);
      if (!this.store.hierarchy) return { ids: [], pos: 0, total: 0 };
      ids = this.store.getSet(KIND.prop, this.store.hierarchy.id, c.id, this._stats()).toArray();
    }
    return { ids, pos: 0, total: context == null ? this.totalCount() : ids.length };
  }

  _roots() {
    if (this.dialect.name === 'loinc' || this.dialect.name === 'rxnorm') {
      return (this.dialect.name === 'rxnorm' ? this._rxLive() : this.store.all()).toArray();
    }
    // concepts without an active parent
    const hid = this.store.hierarchy ? this.store.hierarchy.id : -1;
    const hasParent = this.store.getSet(KIND.hasProp, hid, 0);
    return RoaringBitmap32.andNot(this.store.active(), hasParent).toArray();
  }

  async iteratorAll() {
    const ids = (this.dialect.name === 'rxnorm' ? this._rxLive() : this.store.all()).toArray();
    return { ids, pos: 0, total: ids.length };
  }

  async nextContext(iter) {
    if (!iter || iter.pos >= iter.ids.length) return null;
    if (!iter.loaded || iter.pos >= iter.loaded) {
      const batch = iter.ids.slice(iter.pos, iter.pos + CHUNK).map((id) => this._concept(id));
      this._loadChunk(batch);
      iter.loaded = iter.pos + batch.length;
    }
    return this._concept(iter.ids[iter.pos++]);
  }

  // ---- subsumption --------------------------------------------------------------------------

  async subsumesTest(codeA, codeB) {
    if (!this._trace) return this._subsumesTest(codeA, codeB);
    return this._trace.spanAsync('subsumes', 'set', this.system(), () => this._subsumesTest(codeA, codeB));
  }

  async _subsumesTest(codeA, codeB) {
    const a = await this._ensure(codeA);
    const b = await this._ensure(codeB);
    if (this.dialect.name === 'rxnorm') return 'not-subsumed';
    if (a.id === b.id) return 'equivalent';
    const st = this._stats();
    if (this.store.getSet(KIND.descendants, 0, a.id, st).has(b.id)) return 'subsumes';
    if (this.store.getSet(KIND.descendants, 0, b.id, st).has(a.id)) return 'subsumed-by';
    return 'not-subsumed';
  }

  /**
   * The codes a code sits under, for $closure (CodeSystemProvider.ancestorsOf), answered from
   * what subsumesTest reads: a is in ancestorsOf(b) exactly when a's descendant set holds b.
   *
   * The candidates are the upward walk over the hierarchy links (store.ancestorsOf), and each is
   * kept only if its descendant set holds the code, so nothing is listed that subsumesTest would
   * not say subsumes. The walk reaches every such ancestor when the descendant sets are the
   * closure of those links (SNOMED CT: the importer's hierarchy-closure). For LOINC the sets are
   * the explicit PATH_TO_ROOT pairs, and the link graph is a superset of each path (a part's own
   * rows give its parents), so the walk reaches them too; this is checked over every concept of
   * the LOINC files in use (engine-1114b/tools/anc-check.js). A file with more than one
   * hierarchy property gets null: the walk follows one.
   *
   * Only a code in the form code() gives is answered: another spelling (a SNOMED CT id with
   * spaces or a term, an expression) gets null, and $closure asks subsumesTest. RxNorm's
   * subsumesTest is flat (not-subsumed), so a known RxNorm code sits under nothing.
   *
   * @param {string|V2Concept} code
   * @returns {Promise<Set<string>|null>}
   */
  async ancestorsOf(code) {
    const c = typeof code === 'string' ? (await this.locate(code)).context : code;
    if (!(c instanceof V2Concept) || (typeof code === 'string' && c.code !== code)) return null;
    if (this.dialect.name === 'rxnorm') return new Set();
    const S = this.store;
    if (!S.hierarchy) return new Set();
    if ([...S.props.values()].filter((p) => p.isHierarchy).length > 1) return null;
    const st = this._stats();
    const candidates = S.ancestorsOf(c.id, st).filter((a) => a !== c.id);
    if (!candidates.length) return new Set();
    const sets = S.loadSets(KIND.descendants, 0, candidates, st);
    const kept = candidates.filter((a) => { const d = sets.get(a); return !!d && d.has(c.id); });
    const rows = S.conceptRows(kept, st);
    return new Set(kept.map((a) => rows.get(a)).filter(Boolean).map((r) => r.code));
  }

  async locateIsA(code, parent, disallowParent = false) {
    const r = await this.locate(code);
    if (!r.context) return r;
    const p = await this.locate(parent);
    if (!p.context) return { context: null, message: 'Concept not found' };
    if (r.context.id === p.context.id) return disallowParent ? { context: null, message: 'Concept is not subsumed by parent' } : r;
    return this.store.getSet(KIND.descendants, 0, p.context.id).has(r.context.id) ? r : { context: null, message: 'Concept is not subsumed by parent' };
  }

  // ---- $lookup --------------------------------------------------------------------------------

  async extendLookup(context, props, params) {
    if (!this._trace) return this._extendLookup(context, props, params);
    return this._trace.spanAsync('lookup properties', 'rows', this.system(), () => this._extendLookup(context, props, params));
  }

  async _extendLookup(context, props, params) {
    const c = await this._ensure(context);
    if (!c) return;
    if (this.dialect.name === 'loinc') return this._loincLookup(c, props, params);
    if (this.dialect.name === 'rxnorm') return this._rxnormLookup(c, props, params);
    return this._genericLookup(c, props, params);
  }

  _targetDisplays(ids) {
    return this.store.conceptRows(ids, this._stats());
  }

  _loincLookup(c, props, params) {
    // order as main emits it since #385 (cs-loinc.js extendLookup's fixed groups): relationships
    // (CLASS, the axes, the rest), the other properties, STATUS, RELATEDNAMES2, then the mappings
    const S = this.store;
    const st = this._stats();
    const AXES = ['CLASS', 'COMPONENT', 'PROPERTY', 'TIME_ASPCT', 'SYSTEM', 'SCALE_TYP', 'METHOD_TYP'];
    // (an answer list's answers-for links come after its answers: upstream's rows are in import order,
    // AnswerList.csv before LoincAnswerListLink.csv)
    const pos = (code) => { const i = AXES.indexOf(code); return i >= 0 ? i : code === 'parent' || code === 'child' ? 100 : code === 'answers-for' ? 60 : 50; };
    const links = S.linksFrom([c.id], null, true, st);
    const inv = S.config.inverseProperties || {};
    for (const [name, of] of Object.entries(inv)) {
      for (const pc of [].concat(of)) {
        const p = S.props.get(pc);
        if (!p) continue;
        for (const id of S.getSet(KIND.prop, p.id, c.id, st).toArray()) links.push({ t: id, name });
      }
    }
    const rows = this._targetDisplays(links.map((l) => l.t));
    const named = links.map((l) => ({ ...l, code: l.name || (S.propsById.get(l.p) || {}).code })).filter((l) => l.code && rows.get(l.t));
    const seq = new Map((S.sequenceOf(c.id) || []).map((id, i) => [id, i]));
    // answers-for: LoincAnswerListLink.csv's order, by term code as text
    // the other relationships (document and radiology axes, ...): the part links file's order, by part code as text
    const textOrder = (a, b) => (rows.get(a.t).code < rows.get(b.t).code ? -1 : rows.get(a.t).code > rows.get(b.t).code ? 1 : 0);
    const byCode = (a, b) => ((a.code === 'answers-for' && b.code === 'answers-for') || (pos(a.code) === 50 && pos(b.code) === 50 && !seq.has(a.t) && !seq.has(b.t)) ? textOrder(a, b) : 0);
    // parent and child: the built-in importer's Relationships rows' order (hierarchy-file order, a
    // part's second parent among its children), when the file has it (orders.js)
    const hier = S.hierarchyOrderOf(c.id);
    let hierRank = null;
    if (hier && hier.length) {
      hierRank = new Map();
      for (let i = 0; i < hier.length; i++) hierRank.set(hier[i], i);
    }
    const hierOf = (l) => {
      if (!hierRank || pos(l.code) !== 100) return 0;
      const r = hierRank.get(((l.code === 'child' ? HIER_CHILD : 0) | l.t) >>> 0);
      return r === undefined ? hier.length : r;
    };
    named.sort((a, b) => (pos(a.code) - pos(b.code)) || (hierOf(a) - hierOf(b)) || ((seq.get(a.t) ?? 0) - (seq.get(b.t) ?? 0)) || byCode(a, b));
    for (const l of named) {
      if (!this._hasProp(props, l.code, true)) continue;
      const t = rows.get(l.t);
      if (l.code === 'CLASS') {
        const pr = this._addStringProperty(params, 'property', 'CLASS', t.display || t.code);
        pr.part.push({ name: 'partCode', valueCode: t.code });
      } else {
        this._addCodeProperty(params, 'property', l.code, t.code);
      }
    }
    const lits = S.literalsOf([c.id], true, st).map((r) => ({ ...r, code: (S.propsById.get(r.p) || {}).code })).filter((r) => r.code);
    for (const r of lits) {
      if (r.code === 'STATUS' || !this._hasProp(props, r.code, true)) continue;
      if (r.code === 'CLASSTYPE') {
        const map = (S.config.propertyValueDescriptions || {}).CLASSTYPE || {};
        const pr = this._addStringProperty(params, 'property', 'CLASSTYPE', String(r.v));
        if (map[r.v]) pr.part.push({ name: 'description', valueString: map[r.v] });
      } else {
        this._addStringProperty(params, 'property', r.code, String(r.v));
      }
    }
    for (const r of lits) if (r.code === 'STATUS' && this._hasProp(props, 'STATUS', true)) this._addStringProperty(params, 'property', 'STATUS', String(r.v));
    this._needDesigs(c);
    if (this._hasProp(props, 'RELATEDNAMES2', true)) {
      const rel = c.desigsNoRelated ? (S.designationRows([c.id], st, { onlyUse: this._relatedUse() }).get(c.id) || []) : c.desigs;
      for (const d of rel) if (d.use && d.use.code === 'RELATEDNAMES2') this._addStringProperty(params, 'property', 'RELATEDNAMES2', d.term, d.language);
    }
    const maps = S.stmt('SELECT system, version, code, display, equivalence FROM external_map WHERE concept_id = ? ORDER BY system, code').all(c.id);
    for (const m of maps) {
      const key = loincMapKey(m.system);
      if (!key || !this._hasProp(props, key, true)) continue;
      // main's key order: system, version, code, display
      const coding = { system: m.system };
      if (m.version) coding.version = m.version;
      coding.code = m.code;
      if (m.display) coding.display = m.display;
      params.push({ name: 'property', part: [{ name: 'code', valueCode: key }, { name: 'value', valueCoding: coding },
        { name: 'subproperty', part: [{ name: 'code', valueCode: 'equivalence' }, { name: 'value', valueCode: m.equivalence }] }] });
    }
  }

  /**
   * RxNorm properties as cs-rxnorm.js gives them: TTY, STY and SAB (by default), each sorted by
   * value; then, only when properties are named (property=* or by name, never by default), the
   * RxNorm relationships by RELA (REL where there is none), then the related RXCUI as text,
   * each name and RXCUI once, with no description. SUPPRESS is not reported (the built-in
   * provider has no such property).
   */
  _rxnormLookup(c, props, params) {
    const S = this.store;
    const st = this._stats();
    const lits = new Map();
    for (const r of S.literalsOf([c.id], true, st)) {
      const p = S.propsById.get(r.p);
      if (p) (lits.get(p.code) || lits.set(p.code, new Set()).get(p.code)).add(String(r.v));
    }
    const asText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    for (const name of ['TTY', 'STY', 'SAB']) {
      if (!this._hasProp(props, name, true)) continue;
      for (const v of [...(lits.get(name) || [])].sort(asText)) this._addCodeProperty(params, 'property', name, v);
    }
    if (!(props && props.length > 0)) return;
    const links = S.linksFrom([c.id], null, true, st).filter((l) => { const p = S.propsById.get(l.p); return p && !p.code.includes('@'); });
    const rows = this._targetDisplays(links.map((l) => l.t));
    // cs-rxnorm.js: ORDER BY RELA, REL, RXCUI1 - a REL-only name (upper case: RB, RN, ...) has a null RELA, which sorts first
    const relOnly = (n) => /^[A-Z]+$/.test(n);
    const named = [];
    const seen = new Set();
    for (const l of links) {
      const name = S.propsById.get(l.p).code;
      const t = rows.get(l.t);
      if (!t || seen.has(name + '|' + t.code) || !this._hasProp(props, name, false)) continue;
      seen.add(name + '|' + t.code);
      named.push({ name, code: t.code });
    }
    named.sort((a, b) => (relOnly(b.name) - relOnly(a.name)) || asText(relOnly(a.name) ? '' : a.name, relOnly(b.name) ? '' : b.name)
      || asText(a.name, b.name) || asText(a.code, b.code));
    for (const n of named) this._addCodeProperty(params, 'property', n.name, n.code);
  }

  /**
   * The properties this system reports ({code, uri, type}), for expansion.property: the file's
   * property definitions plus the ones the lookup builds (parent, child, ...). FHIR's standard
   * concept-property URIs where they exist.
   *
   * None for SNOMED CT, LOINC and RxNorm, as main (cs-snomed.js, cs-loinc.js and cs-rxnorm.js
   * declare none), so expansion.property carries their codes without a uri. The HL7 tester sorts
   * expansion.property by uri (absent first), then code, so a uri here would put the definitions
   * in a different order from the expected responses, which have none.
   */
  propertyDefinitions() { return this.f.propDefs; }

  /**
   * Properties of a concept for an expansion (ValueSet contains.property): the same values
   * $lookup reports, read only when the request asks for properties: expand.js passes the names
   * (none = nothing is read).
   */
  async properties(context, names) {
    // the names expand.js asks for (#335: the requested ones and the mandatory ones; none means
    // none), else those processSelection noted
    const wanted = names !== undefined
      ? ((names || []).filter((p) => p !== 'definition').length ? names.filter((p) => p !== 'definition') : null)
      : this._propertiesWanted;
    if (!wanted) return [];
    const c = await this._ensure(context);
    if (!c) return [];
    const params = [];
    await this._extendLookup(c, wanted, params);
    const out = [];
    for (const p of params) {
      const code = p.part.find((x) => x.name === 'code');
      const value = p.part.find((x) => x.name === 'value');
      if (!code || !value) continue;
      const vk = Object.keys(value).find((k) => k.startsWith('value'));
      out.push({ code: code.valueCode, [vk]: value[vk] });
    }
    return out;
  }

  async getTranslations(map, coding, target) {
    const lm = map && map.jsonObj && map.jsonObj.loincMap;
    if (!lm) return [];
    const targetSystem = target ? target.split('|')[0] : null;
    const S = this.store;
    const out = [];
    if (coding.system === this.system() && (!targetSystem || targetSystem === lm.system)) {
      const id = S.idOf(coding.code);
      if (id == null) return [];
      for (const r of S.stmt('SELECT version, code, display, equivalence FROM external_map WHERE concept_id = ? AND system = ? ORDER BY code').all(id, lm.system)) {
        const t = { map: map.vurl, system: lm.system, code: r.code, relationship: mapRelationship(r.equivalence, true) };
        if (r.version) t.version = r.version;
        if (r.display) t.display = r.display;
        out.push(t);
      }
    } else if (coding.system === lm.system && (!targetSystem || targetSystem === this.system())) {
      for (const r of S.stmt('SELECT c.code, c.display, m.equivalence FROM external_map m JOIN concept c ON c.concept_id = m.concept_id WHERE m.system = ? AND m.code = ? ORDER BY c.code').all(lm.system, coding.code)) {
        out.push({ map: map.vurl, system: this.system(), version: this.version(), code: r.code, display: r.display, relationship: mapRelationship(r.equivalence, false) });
      }
    }
    return out;
  }

  _genericLookup(c, props, params) {
    const S = this.store;
    const links = S.linksFrom([c.id], null, true, this._stats());
    const rows = this._targetDisplays(links.map((l) => l.t));
    for (const l of links) {
      const p = S.propsById.get(l.p);
      const t = rows.get(l.t);
      if (!p || !t || !this._hasProp(props, p.code, true)) continue;
      this._addCodeProperty(params, 'property', p.isHierarchy ? 'parent' : p.code, t.code, null, t.display);
    }
    for (const r of S.literalsOf([c.id], true, this._stats())) {
      const p = S.propsById.get(r.p);
      if (p && this._hasProp(props, p.code, true)) this._addStringProperty(params, 'property', p.code, String(r.v));
    }
  }

  // ---- filters --------------------------------------------------------------------------------

  _compiler(stats) {
    const provider = this;
    let lang;
    // lang: the language of a display regex (dialects.js), chosen when one asks for it, so that
    // another filter or ECL does not list the file's languages (sctTextLanguages)
    const term = { store: this.store, dialect: this.dialect, layers: this.layers,
      get lang() { return lang === undefined ? (lang = provider._regexLanguage()) : lang; } };
    return new Compiler(term, { stats: stats || this._stats() });
  }

  /**
   * The one language a SNOMED CT display regex searches: the first language the request names
   * (displayLanguage, else Accept-Language: getPrepContext, processSelection) that the file has
   * descriptions in; else the file's default language.
   */
  _regexLanguage() {
    const primary = (c) => String(c || '').toLowerCase().split('-')[0];
    if (this.dialect.searchMode === 'designation') {
      const requested = (this._requestedLangs && this._requestedLangs.languages) || [];
      return this._sctFilterLanguage(requested.map((l) => l && l.language));
    }
    const named = (this._requestLangs && this._requestLangs.languages) || (this.opContext.langs && this.opContext.langs.languages) || [];
    const have = new Set((this.f.languages() || []).map(primary));
    for (const l of named) {
      const p = primary(l && (l.code || l.language));
      if (p && p !== '*' && have.has(p)) return p;
    }
    return primary(this.store.config.defaultLanguage) || 'en';
  }

  /**
   * The one language a SNOMED CT text or display regex filter searches, as cs-snomed.js
   * #filterLanguage chooses it: the first language named (each as tx/sct/languages.js
   * languageBytesFor has it: Norwegian under either "no" or "nb"/"nn") that the edition has active
   * descriptions in; else the edition's default language (cs_config defaultLanguage, which the
   * importers set as main's importer and server read the cache's default-language slot), if it
   * has active descriptions in it, or has none at all; else the edition's language with the lowest
   * language byte.
   * @param {string[]} named language codes or tags, in the request's order
   * @returns {string} a primary language subtag
   */
  _sctFilterLanguage(named) {
    const present = sctTextLanguages(this.store);
    for (const l of named || []) {
      for (const b of languageBytesFor(l)) {
        const code = languageCode(b);
        if (present.has(code)) return code;
      }
    }
    const def = String(this.store.config.defaultLanguage || 'en').toLowerCase().split('-')[0];
    if (present.has(def) || present.size === 0) return def;
    const bytes = [...present].map(languageByte).filter((b) => b);
    return bytes.length ? languageCode(Math.min(...bytes)) : def;
  }

  async doesFilter(prop, op, value) {
    try {
      this._compiler().filter(prop, op, value);
      return true;
    } catch (e) {
      return false;
    }
  }

  /** is this ValueSet filter on a property only a supplement in use defines (a supplement layer)? */
  _isSupplementFilter(f) {
    try {
      return this._compiler().filter(f.property, f.op, f.value).t === 'layer';
    } catch (e) {
      return false;
    }
  }

  /**
   * cs-api getPrepContext(iterate, languages) (#331): languages is what the request asked for
   * (displayLanguage, else Accept-Language). Kept for the request's later filters too: a SNOMED
   * CT display regex searches one of them (_regexLanguage).
   */
  async getPrepContext(iterate, languages = null) {
    if (languages) this._requestLangs = languages;
    // what the request named, or null: a SNOMED CT filter's language (cs-snomed.js reads the filter
    // context's languages only)
    this._requestedLangs = languages || null;
    return new V2Prep(iterate, languages);
  }

  async filter(prep, forIteration, prop, op, value) {
    let node;
    try {
      node = this._compiler().filter(prop, op, value);
    } catch (e) {
      throw this.filterError(e, prop, op, value);
    }
    if (node.t === 'all' && node.expressionsFalse) prep.expressionsFalse = true;
    prep.nodes.push(node);
    prep.specs.push({ prop, op, value });
    return null;
  }

  /** errors as the upstream provider reports them; dialects may wrap them (SNOMED ECL) */
  filterError(e) {
    if (e.unsupported) return new Error(`The filter is not supported: ${e.message}`);
    if (e.notUnderstood) {
      // a filter the code system has no rule for: a 4xx, as main's providers since #383
      return new Issue('error', 'not-supported', null, 'FILTER_NOT_UNDERSTOOD',
        this.opContext.i18n.translate('FILTER_NOT_UNDERSTOOD', this.opContext.langs, e.notUnderstood), 'vs-invalid', 422);
    }
    return e;
  }

  /**
   * A text filter searches one language, as main does since #335 (CodeSystemProvider.searchLanguage):
   * the first language the request names (displayLanguage, else Accept-Language) that the file or
   * a supplement in use has text in, else the file's own language. The file's names in that
   * language take part (V2Store.searchText, text-index.js), and, as each built-in provider adds
   * them, the codes a supplement in use gives a matching name in that language that the file's
   * own search does not find (_supplementSearchCodes; SNOMED CT: active ones; RxNorm: none). A
   * supplement that adds codes is noted on the filter context (prep.usedSupplements), for
   * used-supplement.
   */
  async searchFilter(prep, filter) {
    const text = typeof filter === 'string' ? filter : (filter && filter.filter) || '';
    const node = { t: 'search', text, mode: this.dialect.searchMode };
    const requested = (prep && prep.languages) || this._requestLangs || this.opContext.langs || null;
    // SNOMED CT: the filter context's languages only, as cs-snomed.js (none: the edition's default)
    const searchLang = this.dialect.searchMode === 'designation' ? this._sctSearchLanguage(prep ? prep.languages : this._requestedLangs) : this.searchLanguage(requested);
    node.lang = (searchLang.language || this.defLang() || 'en').toLowerCase();
    node.defLang = this.defLang();
    let n = node;
    if (this.dialect.searchMode !== 'rxnorm' && this.supplements && this.supplements.length && filter && typeof filter.passes === 'function') {
      const sources = new Map();
      const codes = await this._supplementSearchCodes(filter, searchLang, sources);
      const base = codes.size ? ((await this._pausing(this.store.searchTextG(text, this._stats(), node.mode, node.lang, node.defLang))) || new RoaringBitmap32()) : null;
      const ids = [];
      const active = this.dialect.searchMode === 'designation' ? this.store.active(this._stats()) : null;
      const idsOf = this.store.resolveCodes([...codes].map((c) => this.normaliseCode(c)), this._stats());
      for (const code of codes) {
        const id = idsOf.get(this.normaliseCode(code));
        if (id == null || base.has(id) || (active && !active.has(id)) || ids.includes(id)) continue;
        ids.push(id);
        CodeSystemProvider.noteSupplementUsed(prep, sources.get(code));
      }
      if (ids.length) {
        // codes only a supplement's text matches: after the file's matches, in the supplement's
        // order (SNOMED CT, LOINC), or rated 10 among them (other code systems: cs-cs.js)
        prep.searchExtras = ids;
        n = { t: 'or', items: [{ t: 'ids', ids: base.toArray() }, { t: 'ids', ids }] };
      }
    }
    prep.nodes.push(n);
    prep.searchText = text;
    prep.searchLang = node.lang;
    return null;
  }

  /**
   * The language a SNOMED CT text filter searches, as cs-snomed.js chooses it (#filterLanguage):
   * _sctFilterLanguage, for the languages the request names.
   */
  _sctSearchLanguage(languages) {
    const named = ((languages && languages.languages) || []).filter((l) => l && l.language);
    const code = this._sctFilterLanguage(named.map((l) => l.language));
    // the request's own Language when it is the one chosen (its region and the rest kept)
    return named.find((l) => l.language.toLowerCase() === code) || new Language(code);
  }

  /** a text-index.js search step, pausing at its pause points (the request's checkAndYield) */
  _pausing(g) {
    const pause = this._pause();
    if (pause) return runPausing(g, pause);
    let r = g.next();
    while (!r.done) r = g.next();
    return Promise.resolve(r.value);
  }

  /** the order the built-in provider lists text-search results in (text-index.js) */
  async _searchOrder(bm, text, extras = null, lang = null) {
    const keep = (ids) => { const out = []; for (const id of ids) if (bm.has(id)) out.push(id); return out; };
    const mode = this.dialect.searchMode;
    if (mode === 'rxnorm') return keep((await this._pausing(rxTextSearchG(this.store, text, this.store.rxSearchable(this._stats()), this._stats()))).ids);
    if (mode !== 'designation' && mode !== 'display') {
      // cs-cs.js: a supplement's codes are rated 10, among the others
      const extra = extras && extras.length ? new Set(this.store.conceptRows(extras, this._stats()).values().map((r) => r.code)) : null;
      return keep((await this._pausing(genericTextSearchG(this.store, text, lang || 'en', this.defLang(), this._stats(), extra))).ids);
    }
    const ordinal = this.store.ordinal || ((id) => id);
    const found = (await this._pausing(mode === 'designation'
      ? sctTextSearchG(this.store, text, lang || 'en', ordinal, this._stats())
      : loincTextSearchG(this.store, text, lang || 'en', ordinal, this._stats()))).ids;
    const out = keep(found);
    if (extras && extras.length) {
      // the supplements' codes, after the file's own matches (cs-snomed.js, cs-loinc.js)
      for (const id of extras) if (bm.has(id)) out.push(id);
    }
    return out;
  }

  async executeFilters(prep) {
    if (!this._trace) return this._executeFilters(prep);
    return this._trace.spanAsync('evaluate filters', 'set', this.system(), () => this._executeFilters(prep));
  }

  async _executeFilters(prep) {
    if (!prep.nodes.length) return [];
    const node = prep.nodes.length === 1 ? prep.nodes[0] : { t: 'and', items: prep.nodes };
    if (prep.forIterate) {
      if (prep.searchText != null) {
        const bm = await this.engine.evaluateAsync(node, this._trace, this._pause());
        prep.filters = [new V2FilterSet(null, { node, ids: await this._searchOrder(bm, prep.searchText, prep.searchExtras, prep.searchLang), expressionsFalse: prep.expressionsFalse })];
        return prep.filters;
      }
      if (this.engine._order) {
        // a system with a built-in answer order (LOINC, SNOMED CT): the members in that order, as
        // processSelection lists them (is-a: the concept first; child-of: release order; answer
        // lists: their sequence). expand.js iterates a filter this way when it does not hand the
        // compose over whole (an include that also names a value set; several systems)
        const ids = await this.engine.orderedAsync(node, this._trace, this._pause());
        prep.filters = [new V2FilterSet(new RoaringBitmap32(ids), { node, ids, expressionsFalse: prep.expressionsFalse })];
      } else {
        prep.filters = [new V2FilterSet(await this.engine.evaluateAsync(node, this._trace, this._pause()), { node, expressionsFalse: prep.expressionsFalse })];
      }
    } else {
      prep.filters = [new V2FilterSet(null, { node, expressionsFalse: prep.expressionsFalse })];
    }
    for (const f of prep.filters) f.specs = prep.specs;
    return prep.filters;
  }

  async filtersNotClosed(prep) {
    if (!this.isNotClosed()) return false;
    // filters only on properties a supplement in use defines select from the supplement's
    // listed codes, a closed set (main evaluates them outside the code system: supplement-filters.js)
    if (prep.supplementOnly || (prep.nodes && prep.nodes.length && prep.nodes.every((n) => n.t === 'layer'))) return false;
    return !prep.expressionsFalse;
  }

  async filterSize(prep, set) {
    if (!set.bm && !set.ids) set.bm = await this.engine.evaluateAsync(set.node, this._trace, this._pause());
    return set.total != null ? set.total : set.size;
  }

  async filterMore(prep, set) {
    if (!set.bm && !set.ids) set.bm = await this.engine.evaluateAsync(set.node, this._trace, this._pause());
    set.pos++;
    if (set.pos >= set.size) return false;
    const off = set.pos - set.bufStart;
    if (off >= set.buf.length || set.pos < set.bufStart) {
      const ids = set.ids ? set.ids.slice(set.pos, set.pos + CHUNK) : Array.from(set.bm.rangeUint32Array(set.pos, CHUNK));
      set.buf = ids.map((id) => this._concept(id));
      set.bufStart = set.pos;
      this._loadChunk(set.buf);
    }
    set.current = set.buf[set.pos - set.bufStart];
    return true;
  }

  async filterConcept(prep, set) { return set.current; }

  async filterLocate(prep, set, code) {
    if (!this._trace) return this._filterLocate(prep, set, code);
    return this._trace.spanAsync('membership', 'set', this.system(), () => this._filterLocate(prep, set, code));
  }

  async _filterLocate(prep, set, code) {
    const r = await this.locate(code);
    if (!r.context) return this.dialect.name === 'loinc' ? `Not a valid code: ${code}` : r.message;
    return this._member(set, r.context.id) ? r.context : null;
  }

  async filterCheck(prep, set, concept) {
    const c = await this._ensure(concept);
    return this._member(set, c.id);
  }

  _member(set, id) {
    if (set.bm) return set.bm.has(id);
    if (set.ids) return set.ids.includes(id);
    return this.engine.contains(set.node, id, this._trace);
  }

  async filterFinish() { }

  // ---- processSelection (whole single-system composes) ----------------------------------------

  handlesSelecting() { return true; }

  /**
   * cs-api processSelection (expand.js processCodes): the page of the whole compose, with the
   * selection's total. offset -1 = from the start; count -1 = to the end, 0 = the total only.
   * context.valueSet ({ url, version }) is the value set the compose belongs to; it names a refusal.
   * @returns {{sets: V2FilterSet[], total: number, notClosed: boolean}|null} null = not handled
   *   (expand.js takes its usual path)
   */
  /** whether an include filter selects by concept on a code the code system doesn't have (expand.js #filterNamesUnknownCode) */
  async _namesUnknownConcept(includes) {
    const { UNKNOWN_CONCEPT_FILTER_PROPS, UNKNOWN_CONCEPT_FILTER_OPS } = require('../workers/expand');
    for (const cset of includes) {
      for (const fc of cset.filter || []) {
        if (!fc.value || !UNKNOWN_CONCEPT_FILTER_PROPS.has(fc.property) || !UNKNOWN_CONCEPT_FILTER_OPS.has(fc.op)) continue;
        let loc = null;
        try { loc = await this.locate(fc.value); } catch (e) { loc = null; }
        if (!loc || !loc.context) return true;
      }
    }
    return false;
  }

  async processSelection(params, includes, excludes, excludeInactive, offset, count, context = {}) {
    // the request's working languages, for a display regex in the compose (_regexLanguage)
    if (params && typeof params.workingLanguages === 'function' && params.workingLanguages()) this._requestLangs = params.workingLanguages();
    if (params && typeof params.requestedLanguages === 'function') this._requestedLangs = params.requestedLanguages() || null;
    const trace = this._trace;
    // an include filter that selects by concept (is-a, =, ...) on a code the file doesn't have: the
    // usual path reports it (#396: an expansion-issue warning, or 422 with errorsForInvalidCodes)
    // and the include adds nothing
    if (await this._namesUnknownConcept(includes)) return null;
    // listed codes (an exclude's concept list) are resolved by the code as written. One that
    // locate() would read otherwise (normalised, or an expression) is left to the usual path
    for (const cset of [...includes, ...excludes]) {
      for (const cc of cset.concept || []) {
        if (!this._plainListedCode(cc.code)) return null;
      }
    }
    // properties requested (property=..., compose.property): properties() reads them per code
    this._propertiesWanted = params && params.properties && params.properties.length ? params.properties.filter((p) => p !== 'definition') : null;
    let sel;
    try {
      const compile = () => this._compiler(trace ? trace.stats : null).selection(includes, excludes, excludeInactive || (params && params.activeOnly));
      sel = trace ? trace.span('compile compose', 'sql', this.system(), compile) : compile();
    } catch (e) {
      if (trace) trace.span('fallback: ' + e.message, 'set', this.system(), () => null);
      if (e.unsupported) return null;
      if (e.filterError) return null; // expand.js reports it through filter()
      throw e;
    }
    const start = Math.max(offset, 0);
    let result;
    try {
      result = await this.engine.runAsync(sel, { offset: start, count, trace, pause: this._pause() });
    } catch (e) {
      if (e && e.tooCostly) throw this._tooCostly(params, context, e.message);
      throw e;
    }
    const page = result.page(start, count);
    const set = new V2FilterSet(null, { ids: page, total: result.complete ? result.total : null });
    if (count >= 0) {
      // the page's rows, and its designations only when the response can use them: one
      // statement each. An English-or-default request without includeDesignations/designation
      // shows the display only, so the designation rows are not read.
      const needDesignations = !TxParameters.prototype.showsDisplayOnly.call(params || {}, this.opContext.langs);
      const concepts = page.map((id) => this._concept(id));
      if (!needDesignations) for (const c of concepts) c.displayOnly = true;
      // in slices of PAGE_ROWS with a pause between: a whole-system page (count=-1) is 100,000s of rows
      const pause = this._pause();
      const fetch = async () => {
        for (let i = 0; i < concepts.length; i += PAGE_ROWS) {
          if (i && pause) await pause();
          this._loadRows(i === 0 && concepts.length <= PAGE_ROWS ? concepts : concepts.slice(i, i + PAGE_ROWS), needDesignations);
        }
      };
      if (trace) await trace.spanAsync('fetch page rows (' + concepts.length + ')', 'rows', this.system(), fetch);
      else await fetch();
      set.buf = concepts;
      set.bufStart = 0;
    }
    set.complete = result.complete;
    set.result = result;
    if (trace) trace.annotate({ codesReturned: page.length, total: result.complete ? result.total : null });
    const expressionsFalse = includes.some((inc) => (inc.filter || []).some((f) => f.property === 'expressions' && String(f.value) === 'false'));
    const supplementOnly = includes.length > 0 && includes.every((inc) => (inc.filter || []).length > 0 && inc.filter.every((f) => this._isSupplementFilter(f)));
    // count=0 on the whole system: what expand.js asks the built-in provider for (countAllCodes:
    // cs-snomed.js the concepts, or the active ones for a compose without inactive codes; cs-loinc.js
    // every code), not the walk's count (activeOnly does not change it; SNOMED CT's walk does not
    // reach the inactive concepts)
    const total = count === 0 && result.wholeSystem
      ? (this.dialect.name === 'loinc' ? this.totalCount() : await this.countAllCodes(excludeInactive)) : result.total;
    return { sets: [set], total: result.complete ? total : -1, notClosed: await this.filtersNotClosed({ expressionsFalse, supplementOnly }) };
  }

  /**
   * The engine's planner refused (estimated cost over maxScanRows): the standard too-costly Issue
   * (cs-api processSelection), naming the value set processSelection was told it serves.
   */
  _tooCostly(params, context, what) {
    const vs = (context && context.valueSet) || {};
    const vurl = vs.url ? (vs.version ? vs.url + '|' + vs.version : vs.url) : '??';
    return new Issue('error', 'too-costly', null, 'VALUESET_TOO_COSTLY',
      this.opContext.i18n.translate('VALUESET_TOO_COSTLY', (params && params.httpLanguages) || this.opContext.langs, [vurl, what]), null, 422)
      .withDiagnostics(this.opContext.diagnostics());
  }

  /** request end (opContext.closeProviders): release the supplement layers built for it */
  async close() { this.layers.close(); }

}

/** the property definitions a file reports (data built at load) */
const NO_PROPERTY_DEFINITIONS = new Set(['snomed', 'loinc', 'rxnorm']);

function propertyDefinitionsFor(store, dialect) {
  // main's SNOMED CT, LOINC and RxNorm providers declare none (see propertyDefinitions)
  if (NO_PROPERTY_DEFINITIONS.has(dialect.name)) return null;
  const std = { parent: 'http://hl7.org/fhir/concept-properties#parent', child: 'http://hl7.org/fhir/concept-properties#child',
    inactive: 'http://hl7.org/fhir/concept-properties#inactive', status: 'http://hl7.org/fhir/concept-properties#status' };
  const defs = [];
  const seen = new Set();
  const add = (code, uri, type) => { if (!seen.has(code)) { seen.add(code); defs.push({ code, uri: uri || std[code] || undefined, type }); } };
  for (const p of store.props.values()) if (!p.code.includes('@')) add(p.isHierarchy ? 'parent' : p.code, p.uri, p.type);
  for (const c of ['parent', 'child', 'inactive']) add(c, null, 'code');
  return defs;
}

function sortLoinc(desigs) {
  // a part's PartName rows (the linguistic variants' part files) come after its DisplayName (Part.csv), as main's
  // Descriptions rows do (its query has no ORDER BY; rows in import order)
  const order = ['LONG_COMMON_NAME', 'SHORTNAME', 'ConsumerName', 'RELATEDNAMES2', 'DisplayName', 'LinguisticVariantDisplayName', 'PartName'];
  return [...desigs].sort((a, b) => {
    const ua = a.use ? order.indexOf(a.use.code) : 99;
    const ub = b.use ? order.indexOf(b.use.code) : 99;
    if (ua !== ub) return ua - ub;
    if (a.language === 'en-US' && b.language !== 'en-US') return -1;
    if (b.language === 'en-US' && a.language !== 'en-US') return 1;
    return a.id - b.id;
  });
}

// LOINC's mappings to other systems: $lookup properties named <key>, and the implicit
// ConceptMaps http://loinc.org/cm/<key> (as cs-loinc.js)
const LOINC_MAPS = [
  { system: 'http://loinc.org', key: 'loinc' },
  { system: 'http://pubchem.ncbi.nlm.nih.gov', key: 'ncbi' },
  { system: 'http://snomed.info/sct', key: 'sct' },
  { system: 'http://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets', key: 'hcpcs' },
  { system: 'http://www.genenames.org', key: 'gene-names' },
  { system: 'http://www.nlm.nih.gov/research/umls/rxnorm', key: 'rxnorm' },
  { system: 'https://www.ebi.ac.uk/chebi', key: 'chebi' },
  { system: 'https://www.ncbi.nlm.nih.gov/clinvar', key: 'ncbi-clinvar' },
  { system: 'https://www.ncbi.nlm.nih.gov/gene', key: 'ncbi-gene' },
  { system: 'https://www.ncbi.nlm.nih.gov/taxonomy', key: 'ncbi-taxo' },
  { system: 'urn:iso:std:iso:11073:10101', key: 'mdc' },
  { system: 'urn:oid:2.16.840.1.113883.6.238', key: 'race' }
];
const LOINC_MAP_BASE = 'http://loinc.org/cm/';
function loincMapKey(system) { const m = LOINC_MAPS.find((x) => x.system === system); return m ? m.key : null; }

/** R4 equivalence from the LOINC side -> R5 relationship from the translated code's side */
function mapRelationship(equivalence, fromLoinc) {
  switch (equivalence) {
    case 'equivalent': case 'equal': return 'equivalent';
    case 'narrower': return fromLoinc ? 'source-is-broader-than-target' : 'source-is-narrower-than-target';
    case 'wider': return fromLoinc ? 'source-is-narrower-than-target' : 'source-is-broader-than-target';
    default: return 'related-to';
  }
}

// ---- factory -------------------------------------------------------------------------------

class SqliteV2Factory extends CodeSystemFactoryProvider {
  constructor(i18n, file, opts = {}) {
    super(i18n);
    this.file = file;
    this.opts = opts;
  }

  async load() {
    this.store = new V2Store(this.file, this.opts);
    this.dialect = dialectFor(this.store.system);
    const kind = orderKind(this.dialect.name);
    const order = kind ? this._systemOrder(kind) : null;
    this.engine = new Engine(this.store, order ? { ...this.opts, order } : this.opts);
    // SNOMED CT text search ranks ties by the built-in concept order (text-index.js)
    if (order) this.store.ordinal = (id) => order.rank[id];
    this.layers = new SupplementLayers(this.store);
    this.propDefs = propertyDefinitionsFor(this.store, this.dialect);
    // data, not cache: read once when the file loads
    this._langs = this.store.withoutMmap(() => this.store.db.prepare('SELECT DISTINCT language FROM designation WHERE language IS NOT NULL').all().map((r) => r.language));
  }

  /**
   * The built-in answer order of LOINC and SNOMED CT (orders.js): data the importer computed and
   * stored in the file (system_order), read lazily, array by array. A file built before
   * system_order computes it here, at load, from its rows.
   */
  _systemOrder(kind) {
    const t0 = Date.now();
    const order = hasTable(this.store.db, 'system_order')
      ? storedOrder(this.store, kind)
      : builtOrder(this.store.withoutMmap(() => computeOrder(this.store.db, kind, this.store.conceptCount)), kind);
    this.orderBuildMs = Date.now() - t0;
    return order;
  }

  system() { return this.store.system; }
  version() { return this.store.version; }
  defaultVersion() { return this.store.version; }
  name() {
    if (this.store.system === LOINC) return 'LOINC';
    if (this.store.system === RXNORM) return 'RxNorm';
    return this.store.cs.name || this.store.system;
  }
  description() { return this.store.system === LOINC ? 'LOINC' : (this.store.cs.title || this.name()); }
  lookupName() { return this.store.system === LOINC ? 'Logical Observation Identifier Names and Codes (LOINC)' : this.name(); }
  defLang() { return 'en'; }
  totalCount() { return this.store.conceptCount; }
  versionAlgorithm() {
    if (this.store.system === LOINC) return 'natural';
    if (this.store.system === RXNORM) return 'date';
    return null;
  }
  /**
   * The factory id, as main's provider for the same system forms it (read.js and search.js serve
   * it as CodeSystem/x-<id>; tx.fhir.org uses the same ids): LOINC 'loinc' + version
   * (cs-loinc.js: x-loinc2.82), RxNorm name + '-' + version (cs-rxnorm.js: x-RxNorm-03022026).
   * SNOMED CT is SnomedV2Factory.id(). Other systems have no classic provider to follow.
   */
  id() {
    if (this.store.system === LOINC) return 'loinc' + this.version();
    if (this.store.system === RXNORM) return this.name() + '-' + this.version();
    return (this.name().replace(/\W/g, '') + '-' + this.version()).toLowerCase();
  }
  describeVersion(v) {
    if (this.store.system === RXNORM) {
      const { formatDateMMDDYYYY } = require('../../library/utilities');
      return formatDateMMDDYYYY(v);
    }
    return super.describeVersion(v);
  }

  /** designation languages: data read at load */
  languages() { return this._langs; }

  async build(opContext, supplements) {
    this.recordUse();
    return new SqliteV2Provider(opContext, supplements, this);
  }

  async buildKnownValueSet(url, version) {
    if (version && version !== this.version()) return null;
    if (this.store.system === LOINC) return this._loincKnownValueSet(url);
    return null;
  }

  _loincKnownValueSet(url) {
    if (url === 'http://loinc.org/vs') {
      // (the members in cs-loinc.js's order, so the JSON matches)
      return { resourceType: 'ValueSet', url, version: this.version(), status: 'active',
        name: 'LOINC Value Set - all LOINC codes', description: 'All LOINC codes', date: new Date().toISOString(), experimental: false,
        compose: { include: [{ system: LOINC }] } };
    }
    const m = /^http:\/\/loinc\.org\/vs\/(.+)$/.exec(url);
    if (!m) return null;
    const code = m[1];
    const id = this.store.idOf(code);
    if (id == null) return null;
    const row = this.store.conceptRows([id]).get(id);
    const base = { resourceType: 'ValueSet', url, version: this.version(), status: 'active' };
    const dated = () => ({ date: new Date().toISOString(), experimental: false });
    if (code.startsWith('LP')) {
      return { ...base, name: 'LOINCValueSetFor' + code.replace(/-/g, '_'), description: `LOINC value set for code ${code}: ${row.display}`,
        ...dated(), compose: { include: [{ system: LOINC, filter: [{ property: 'ancestor', op: '=', value: code }] }] } };
    }
    if (code.startsWith('LL')) {
      const members = this.store.sequenceOf(id) || this.store.getSet(KIND.refset, 0, id).toArray();
      const rows = this.store.conceptRows(members);
      return { ...base, name: 'LOINCAnswerList' + code.replace(/-/g, '_'), description: `LOINC Answer list for code ${code}: ${row.display}`,
        ...dated(), compose: { include: [{ system: LOINC, concept: members.map((i) => ({ code: rows.get(i).code })) }] } };
    }
    return null;
  }

  // LOINC's implicit concept maps (http://loinc.org/cm/<key>)
  async findImplicitConceptMaps(conceptMaps, source, sourceVersion, dest, code = null) {
    if (this.store.system !== LOINC || !dest) return;
    const destSystem = dest.split('|')[0];
    const other = source === LOINC ? destSystem : destSystem === LOINC ? source : null;
    const lm = LOINC_MAPS.find((m) => m.system === other);
    if (!lm || conceptMaps.some((m) => m.url === LOINC_MAP_BASE + lm.key)) return;
    if (code) {
      const id = this.store.idOf(code);
      const has = (id != null && this.store.stmt('SELECT 1 FROM external_map WHERE concept_id = ? AND system = ? LIMIT 1').get(id, lm.system))
        || this.store.stmt('SELECT 1 FROM external_map WHERE system = ? AND code = ? LIMIT 1').get(lm.system, code);
      if (!has) return;
    }
    conceptMaps.push(this._loincMap(lm));
  }

  async findImplicitConceptMap(url, version) {
    if (this.store.system !== LOINC || !url || !url.startsWith(LOINC_MAP_BASE)) return null;
    if (version && version !== this.version()) return null;
    const lm = LOINC_MAPS.find((m) => LOINC_MAP_BASE + m.key === url);
    return lm ? this._loincMap(lm) : null;
  }

  _loincMap(lm) {
    const { ConceptMap } = require('../library/conceptmap');
    const groups = [{ source: LOINC, target: lm.system }];
    if (lm.system !== LOINC) groups.push({ source: lm.system, target: LOINC });
    return new ConceptMap({ resourceType: 'ConceptMap', internalSource: this, loincMap: lm, url: LOINC_MAP_BASE + lm.key,
      name: `LOINC ${lm.key} Concept Map`, description: `The mappings between LOINC ${this.version()} and ${lm.system}, as published by LOINC`,
      status: 'active', group: groups });
  }

  async close() { this.store.close(); }
}

module.exports = { SqliteV2Provider, SqliteV2Factory, V2Concept, V2FilterSet, FilterError };
