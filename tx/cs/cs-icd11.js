/**
 * cs-icd11.js -- CodeSystemProvider for ICD-11, backed by the SQLite database built by
 * tx/importers/import-icd11.js. See tx/importers/icd11-schema.md for the schema.
 *
 * One database carries three code systems -- the MMS and ICF linearizations and the
 * Foundation -- so the factory is constructed per system and several factories share one
 * file. `tx/library.js` registers one per system found in the database.
 *
 * The tx-ecosystem `icd-11` test suite is the specification -- it was written to assert
 * correct behaviour, and it is what these are tested against; there is no unit test file
 * of their own. Metadata, code location, displays, definitions, designations, properties,
 * extendLookup, filters, iteration, subsumption and postcoordinated expressions are all
 * implemented.
 */

const sqlite3 = require('sqlite3').verbose();
const { CodeSystem } = require('../library/codesystem');
const { CodeSystemFactoryProvider, FilterExecutionContext } = require('./cs-api');
const { BaseCSServices } = require('./cs-base');
const { validateArrayParameter } = require('../../library/utilities');
const { ICD11Expression, parseExpression } = require('./icd11-expressions');
const { Issue } = require('../library/operation-outcome');
const assert = require('assert');

// WHO's own vocabulary for the kinds of text an entity carries, used as designation.use.
const SCHEMA_NS = 'http://id.who.int/icd/schema';

// designation.kind values that are not designations: `definition` is
// CodeSystem.concept.definition, and is returned by definition() instead.
const NOT_A_DESIGNATION = new Set(['definition']);

/**
 * The context object handed back by locate() and passed to every accessor. It carries
 * enough of the concept row that the cheap accessors never go back to the database.
 */
class ICD11Concept {
  constructor(row) {
    this.id = row.id;                 // internal rowid, used for joins
    this.entityId = row.entity_id;    // 257068234, or 1363559646/other for a residual
    this.uri = row.uri;               // unversioned canonical uri
    this.code = row.code;             // short code; null for groupers
    this.classKind = row.class_kind;  // chapter | block | window | category
    this.selectable = !!row.selectable;
    this.residual = row.residual;     // null | other | unspecified
    this.depth = row.depth;
    this.blockId = row.block_id;
    this.codeRange = row.code_range;
    this.sourceUri = row.source_uri;  // the Foundation entity this came from
    this.browserUrl = row.browser_url;
    this.lft = row.lft;               // nested set; null for the Foundation (a DAG)
    this.rgt = row.rgt;
  }

  /**
   * What this concept answers to. WHO's server accepts both the short code and the entity
   * uri, and the test suite asserts both address the same concept, so the provider echoes
   * back whichever form is canonical for the concept: the short code where there is one,
   * the uri otherwise. If the community settles the straw poll differently, this is the
   * one place that changes.
   */
  get canonicalCode() {
    return this.code || this.uri;
  }
}

/**
 * One filter's worth of concepts. Two shapes, because they are answered two different ways:
 * an `is-a` set is a range of the transitive closure and can be probed for one code without
 * being built, while a text search has to be run before anything can be said about it.
 */
class ICD11FilterSet {
  constructor(kind, props) {
    this.kind = kind;                 // 'isa' | 'search'
    this.rows = null;                 // materialised lazily, and only when iterated
    this.cursor = 0;
    Object.assign(this, props);
  }
}

class ICD11Services extends BaseCSServices {
  constructor(opContext, supplements, db, shared) {
    super(opContext, supplements);
    this.db = db;
    this.shared = shared;             // { systemCode, url, version, title, isTree, systemId, count }
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  // -- small promise wrappers, so no query below carries callback boilerplate -----------

  #get(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
    });
  }

  #all(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || []));
    });
  }

  // -- metadata -------------------------------------------------------------------------

  system() { return this.shared.url; }
  version() { return this.shared.version; }

  /**
   * The default is system|version, but $lookup's `name` is meant to be a display name for
   * the code system. OMOP overrides it the same way; WHO returns the linearization title.
   */
  name() { return this.shared.title; }
  description() { return this.shared.title; }
  totalCount() { return this.shared.count; }
  defLang() { return 'en'; }

  /**
   * WHO publishes the classification in the languages the database was crawled with, so
   * the base class's English-only assumption is wrong here: it decides whether a failed
   * display check says "no display in that language" or "none at all".
   */
  hasAnyDisplays(languages) {
    const langs = this._ensureLanguages(languages);
    for (const l of langs) {
      const base = l.language || String(l.code || '').split('-')[0];
      if (base && this.shared.languages.includes(base)) {
        return true;
      }
    }
    return super.hasAnyDisplays(langs);
  }

  /** Versions are WHO release ids -- '2026-01'. */
  versionAlgorithm() { return 'date'; }

  /**
   * The WHO CodeSystem says caseSensitive: false, but its own $validate-code rejects
   * '1a00'. The codes are case-sensitive tokens; the declaration is the part that is
   * wrong, and the test suite asserts the sensitive behaviour.
   */
  isCaseSensitive() { return true; }

  hasParents() { return true; }

  /** MMS and ICF are trees; the Foundation is a DAG. */
  hasMultiHierarchy() { return !this.shared.isTree; }

  /**
   * MMS and ICF admit postcoordinated expressions, so the set of valid codes is not
   * enumerable. The Foundation has no postcoordination.
   */
  isNotClosed() { return this.shared.systemCode !== 'foundation'; }

  versionIsMoreDetailed() { return false; }

  // -- locating -------------------------------------------------------------------------

  /**
   * Accepts the short code and the unversioned entity uri, matching what WHO's server
   * accepts. Returns { context, message }; a plain miss carries no message, which the
   * validation worker treats as "not there" rather than "malformed".
   */
  async locate(code) {
    assert(!code || typeof code === 'string', 'code must be a string');
    if (!code) return { context: null, message: 'Empty code' };

    const concept = await this.#resolve(code);
    if (concept) return { context: concept, message: null };

    // Not a code as written. It may still be a postcoordinated expression -- but only in a
    // linearization (the Foundation has no postcoordination), and only if it is punctuated
    // like one, so an ordinary unknown code costs nothing extra. parseExpression returns
    // null when the text does not resolve, and throws when it resolves but is wrong.
    if (this.shared.systemCode !== 'foundation' && /[&/.]/.test(code)) {
      const expr = await parseExpression(this.#expressionContext(), code);
      if (expr) return { context: expr, message: null };
    }
    return { context: null, message: undefined };
  }

  /** A plain code or entity uri, as written; null if it is neither. */
  async #resolve(code) {
    const row = await this.#get(
      `SELECT * FROM concept WHERE system = ? AND (code = ? OR uri = ?)`,
      [this.shared.systemId, code, code]);
    return row ? new ICD11Concept(row) : null;
  }

  /** The three things the expression parser needs from the database. */
  #expressionContext() {
    return {
      get: (sql, params) => this.#get(sql, params),
      all: (sql, params) => this.#all(sql, params),
      resolve: (text) => this.#resolve(text),
    };
  }

  /**
   * The label an expression shows for one of its parts. Falls back to the default language
   * the same way display() does, so a French lookup of a concept with no French title still
   * renders something.
   */
  async #title(concept) {
    const row = await this.#get(
      `SELECT value FROM designation
        WHERE concept = ? AND kind = 'title' AND lang = ? ORDER BY seq LIMIT 1`,
      [concept.id, this.#displayLang()]);
    if (row) return row.value.trim();
    const def = await this.#get(
      `SELECT value FROM designation
        WHERE concept = ? AND kind = 'title' AND lang = ? ORDER BY seq LIMIT 1`,
      [concept.id, this.defLang()]);
    return def ? def.value.trim() : null;
  }

  /**
   * The display for an expression renders what was written, not what it means: cluster
   * members joined by " / ", each postcoordinated value in brackets after its stem. So
   * 1D01.0Y/1G41/1G40 reads as three things separated by slashes even though two of them
   * are bound to axes of the first -- which is how the coder wrote it, and how the ICD
   * Browser shows it back.
   */
  async #expressionDisplay(expr) {
    const parts = [];
    for (const m of expr.members) {
      let text = await this.#title(m.head.concept) || m.head.text;
      for (const t of m.tail) {
        text += ` [${await this.#title(t.concept) || t.text}]`;
      }
      parts.push(text);
    }
    return parts.join(' / ');
  }

  /** Accepts a code string or an existing context; throws on anything else. */
  async #ensureContext(context) {
    if (context === null || context === undefined) return null;
    if (typeof context === 'string') {
      const result = await this.locate(context);
      if (result.context == null) {
        throw new Error(result.message ?? `Code '${context}' not found in ${this.system()}`);
      }
      return result.context;
    }
    if (context instanceof ICD11Concept || context instanceof ICD11Expression) return context;
    throw new Error(`Unknown Type at #ensureContext: ${typeof context}`);
  }

  async code(context) {
    const ctxt = await this.#ensureContext(context);
    return ctxt === null ? null : ctxt.canonicalCode;
  }

  async display(context) {
    const ctxt = await this.#ensureContext(context);
    if (ctxt === null) return null;
    if (ctxt instanceof ICD11Expression) return this.#expressionDisplay(ctxt);
    const row = await this.#get(
      `SELECT value FROM designation
        WHERE concept = ? AND kind = 'title' AND lang = ? ORDER BY seq LIMIT 1`,
      [ctxt.id, this.#displayLang()]);
    if (row) return row.value.trim();
    // fall back to the default language rather than returning nothing
    const def = await this.#get(
      `SELECT value FROM designation
        WHERE concept = ? AND kind = 'title' AND lang = ? ORDER BY seq LIMIT 1`,
      [ctxt.id, this.defLang()]);
    return def ? def.value.trim() : null;
  }

  async definition(context) {
    const ctxt = await this.#ensureContext(context);
    if (ctxt === null || ctxt instanceof ICD11Expression) return null;
    const row = await this.#get(
      `SELECT value FROM designation
        WHERE concept = ? AND kind = 'definition' AND lang = ? ORDER BY seq LIMIT 1`,
      [ctxt.id, this.#displayLang()]);
    return row ? row.value : null;
  }

  /** Groupers -- blocks, windows, and chapters -- cannot be used to code with. */
  async isAbstract(context) {
    const ctxt = await this.#ensureContext(context);
    if (ctxt === null || ctxt instanceof ICD11Expression) return false;
    return !ctxt.selectable;
  }

  async isInactive() { return false; }     // ICD-11 releases do not carry inactive codes
  async isDeprecated() { return false; }

  async parent(context) {
    const ctxt = await this.#ensureContext(context);
    // an expression has no place in the hierarchy: its stem does, but the expression is a
    // narrower thing than any concept in the classification
    if (ctxt === null || ctxt instanceof ICD11Expression) return null;
    const row = await this.#get(
      `SELECT c.code, c.uri FROM concept_parent cp JOIN concept c ON c.id = cp.parent
        WHERE cp.child = ? ORDER BY cp.seq LIMIT 1`, [ctxt.id]);
    return row ? (row.code || row.uri) : null;
  }

  /**
   * The best language for display, given what the request asked for. Languages is an
   * iterable of Language, in quality order; the database holds translations keyed on the
   * primary subtag, so that is what is matched.
   */
  #displayLang() {
    const langs = this.opContext?.langs;
    if (langs) {
      for (const l of langs) {
        const base = l.language || String(l.code || '').split('-')[0];
        if (base && this.shared.languages.includes(base)) return base;
      }
    }
    return this.defLang();
  }

  // -- designations ----------------------------------------------------------------------

  /**
   * Every piece of text the entity carries, in every language the database holds. The
   * title is the display; the rest -- index terms, inclusions, coding notes and so on --
   * are designations tagged with WHO's own name for what they are.
   *
   * This is also where $validate-code gets its display from: the validation worker builds
   * a Designations list and asks it for preferredDisplay(), rather than calling display().
   */
  async designations(context, displays) {
    const ctxt = await this.#ensureContext(context);
    if (!ctxt || !displays) return;
    if (ctxt instanceof ICD11Expression) {
      // an expression has exactly one piece of text: the display built from its parts
      const text = await this.#expressionDisplay(ctxt);
      if (text) displays.addDesignation(true, 'active', this.#displayLang(),
        CodeSystem.makeUseForDisplay(), text);
      return;
    }
    const rows = await this.#all(
      `SELECT lang, kind, value FROM designation WHERE concept = ? ORDER BY lang, seq`,
      [ctxt.id]);
    for (const r of rows) {
      if (NOT_A_DESIGNATION.has(r.kind)) continue;
      const value = r.value.trim();
      if (!value) continue;
      if (r.kind === 'title') {
        displays.addDesignation(true, 'active', r.lang, CodeSystem.makeUseForDisplay(), value);
      } else {
        displays.addDesignation(false, 'active', r.lang,
          { system: SCHEMA_NS, code: r.kind }, value);
      }
    }
    this._listSupplementDesignations(ctxt.canonicalCode, displays);
  }

  // -- properties ------------------------------------------------------------------------

  /**
   * The properties this code system defines. Uri-valued things are declared as strings:
   * CodeSystem.property.type has no `uri`, and concept.property.value[x] has no valueUri
   * either. (The WHO server gets this wrong on expansions, where it returns valueUri and
   * no conformant client can parse the result.)
   */
  propertyDefinitions() {
    const defs = [
      // code, not string: the entity uri identifies a concept in this code system, and
      // that is what the Geneva review concluded WHO gets wrong by returning valueString.
      { code: 'id', uri: `${SCHEMA_NS}/entityId`, type: 'code',
        description: 'The stable WHO entity uri.' },
      { code: 'code', uri: `${SCHEMA_NS}/code`, type: 'string',
        description: 'The short code, where the entity has one.' },
      { code: 'classKind', uri: `${SCHEMA_NS}/classKind`, type: 'code',
        description: 'chapter | block | window | category.' },
      { code: 'notSelectable', uri: 'http://hl7.org/fhir/concept-properties#notSelectable',
        type: 'boolean', description: 'The concept is a grouper and cannot be used to code with.' },
      { code: 'parent', uri: 'http://hl7.org/fhir/concept-properties#parent', type: 'code' },
      { code: 'child', uri: 'http://hl7.org/fhir/concept-properties#child', type: 'code' },
      { code: 'browserUrl', uri: `${SCHEMA_NS}/browserUrl`, type: 'string' },
    ];
    if (this.shared.systemCode !== 'foundation') {
      defs.push(
        { code: 'source', uri: `${SCHEMA_NS}/source`, type: 'string',
          description: 'The Foundation entity this linearization entry came from.' },
        { code: 'blockId', uri: `${SCHEMA_NS}/blockId`, type: 'string' },
        { code: 'codeRange', uri: `${SCHEMA_NS}/codeRange`, type: 'string' },
        { code: 'postcoordinationScale', uri: `${SCHEMA_NS}/postcoordinationScale`, type: 'string',
          description: 'A postcoordination axis of this concept; repeats once per axis.' },
        // only ever returned for a postcoordinated expression, never for a plain concept
        { code: 'stem', uri: `${SCHEMA_NS}/stem`, type: 'string',
          description: 'A concept in the expression that carries axes of its own.' },
        { code: 'postcoordinationValues', uri: `${SCHEMA_NS}/postcoordinationValues`, type: 'string',
          description: 'A value in the expression, with the axis it was placed on.' });
    }
    return defs;
  }

  async properties(context) {
    const ctxt = await this.#ensureContext(context);
    if (!ctxt) return [];
    if (ctxt instanceof ICD11Expression) {
      return [{ code: 'id', valueCode: ctxt.uriForm }, { code: 'code', valueString: ctxt.canonicalCode }];
    }
    const out = [{ code: 'id', valueCode: ctxt.uri }];
    if (ctxt.classKind) out.push({ code: 'classKind', valueCode: ctxt.classKind });
    if (ctxt.code) out.push({ code: 'code', valueString: ctxt.code });
    if (!ctxt.selectable) out.push({ code: 'notSelectable', valueBoolean: true });
    return out;
  }

  // -- lookup ----------------------------------------------------------------------------

  /**
   * Adds the ICD-11 specific parts of a $lookup response. `props` is the caller's
   * requested property list; _hasProp honours it, treating an empty list as "everything"
   * and '*' as the same. WHO ignores the property parameter entirely and always returns
   * the lot -- for 1A00 that is 7.5KB, mostly index terms -- which is one of the things
   * the test suite pins.
   */
  async extendLookup(ctxt, props, params) {
    validateArrayParameter(props, 'props', String);
    validateArrayParameter(params, 'params', Object);
    const concept = await this.#ensureContext(ctxt);
    if (!concept) return;
    if (concept instanceof ICD11Expression) {
      return this.#extendLookupExpression(concept, props, params);
    }

    if (this._hasProp(props, 'id', true)) {
      this._addCodeProperty(params, 'property', 'id', concept.uri);
    }
    if (concept.code && this._hasProp(props, 'code', true)) {
      this._addCodeProperty(params, 'property', 'code', concept.code);
    }
    if (this._hasProp(props, 'classKind', true) && concept.classKind) {
      this._addCodeProperty(params, 'property', 'classKind', concept.classKind);
    }
    if (!concept.selectable && this._hasProp(props, 'notSelectable', true)) {
      // BaseCSServices._addProperty always writes valueString, and this one is a boolean.
      params.push({ name: 'property', part: [
        { name: 'code', valueCode: 'notSelectable' },
        { name: 'value', valueBoolean: true }] });
    }
    if (concept.blockId && this._hasProp(props, 'blockId', true)) {
      this._addStringProperty(params, 'property', 'blockId', concept.blockId);
    }
    if (concept.codeRange && this._hasProp(props, 'codeRange', true)) {
      this._addStringProperty(params, 'property', 'codeRange', concept.codeRange);
    }
    if (concept.sourceUri && this._hasProp(props, 'source', false)) {
      this._addStringProperty(params, 'property', 'source', concept.sourceUri);
    }
    if (concept.browserUrl && this._hasProp(props, 'browserUrl', false)) {
      this._addStringProperty(params, 'property', 'browserUrl', concept.browserUrl);
    }

    // hierarchy. Parents and children are codes in this code system, so they use whichever
    // form is canonical for the target -- the short code where there is one.
    if (this._hasProp(props, 'parent', true)) {
      for (const r of await this.#all(
          `SELECT c.code, c.uri FROM concept_parent cp JOIN concept c ON c.id = cp.parent
            WHERE cp.child = ? ORDER BY cp.seq`, [concept.id])) {
        this._addCodeProperty(params, 'property', 'parent', r.code || r.uri);
      }
    }
    if (this._hasProp(props, 'child', false)) {
      for (const r of await this.#all(
          `SELECT c.code, c.uri FROM concept_parent cp JOIN concept c ON c.id = cp.child
            WHERE cp.parent = ? ORDER BY cp.seq`, [concept.id])) {
        this._addCodeProperty(params, 'property', 'child', r.code || r.uri);
      }
    }

    // The postcoordination axes this concept declares, as the canonical of the ValueSet
    // that enumerates each one. The cardinality rules live on those value sets.
    if (this.shared.systemCode !== 'foundation' && this._hasProp(props, 'postcoordinationScale', true)) {
      for (const r of await this.#all(
          `SELECT value_set_uri FROM pc_scale WHERE concept = ? ORDER BY seq`, [concept.id])) {
        this._addStringProperty(params, 'property', 'postcoordinationScale', r.value_set_uri);
      }
    }
  }

  /**
   * $lookup for a postcoordinated expression. Two properties carry what a client cannot
   * work out from the code string:
   *
   *   stem                   which parts of the expression are concepts in their own right
   *   postcoordinationValues which value went on which axis
   *
   * The second is the one that matters. `1D01.0Y/1G41/1G40` says nothing about whether
   * 1G40 is the causing condition or the manifestation, and both are legal there -- so a
   * client that only has the string cannot tell, and a server that reports both on the
   * first axis has told it something untrue. Each (axis, value) pair is therefore kept
   * distinct, and the axis is named by its schema uri, the same identifier the
   * postcoordinationScale property uses on a stem.
   */
  async #extendLookupExpression(expr, props, params) {
    if (this._hasProp(props, 'code', true)) {
      this._addCodeProperty(params, 'property', 'code', expr.canonicalCode);
    }
    if (this._hasProp(props, 'id', true)) {
      this._addCodeProperty(params, 'property', 'id', expr.uriForm);
    }
    if (this._hasProp(props, 'stem', true)) {
      for (const stem of expr.stems) {
        const label = await this.#title(stem.stem.concept);
        const part = [{ name: 'code', valueCode: 'stem' }];
        if (label) {
          part.push({ name: 'subproperty', part: [
            { name: 'code', valueCode: 'stemLabel' },
            { name: 'value', valueString: label }] });
        }
        part.push({ name: 'subproperty', part: [
          { name: 'code', valueCode: 'stemUri' },
          { name: 'value', valueUri: stem.stem.concept.uri }] });
        part.push({ name: 'value', valueCode: stem.stem.concept.canonicalCode });
        params.push({ name: 'property', part });
      }
    }
    if (this._hasProp(props, 'postcoordinationValues', true)) {
      // no sorting here: the test harness normalises repeated `property` parameters by
      // (code, value) before it compares, so these arrive ordered by axis whatever order
      // they leave in. Left in expression order, which is the one a reader of the raw
      // response would expect.
      const bindings = expr.stems.flatMap(stem => stem.bindings);
      for (const b of bindings) {
        const label = await this.#title(b.token.concept);
        const sub = [{ name: 'code', valueCode: b.token.concept.canonicalCode }];
        if (label) sub.push({ name: 'description', valueString: label });
        sub.push({ name: 'value', valueUri: b.token.concept.uri });
        params.push({ name: 'property', part: [
          { name: 'code', valueCode: 'postcoordinationValues' },
          { name: 'subproperty', part: sub },
          { name: 'value', valueCode: b.axis.axis }] });
      }
    }
  }

  // -- subsumption -----------------------------------------------------------------------

  /**
   * A single primary-key probe on the closure, each way. Expressions are not in the
   * hierarchy, so nothing is claimed about them.
   */
  async subsumesTest(codeA, codeB) {
    const a = await this.#ensureContext(codeA);
    const b = await this.#ensureContext(codeB);
    if (!a || !b || a instanceof ICD11Expression || b instanceof ICD11Expression) return 'not-subsumed';
    if (a.id === b.id) return 'equivalent';
    if (await this.#isA(a.id, b.id)) return 'subsumed-by';
    if (await this.#isA(b.id, a.id)) return 'subsumes';
    return 'not-subsumed';
  }

  /** Is `ancestorId` an ancestor of `descendantId` (or the same concept)? */
  async #isA(descendantId, ancestorId) {
    const row = await this.#get(
      `SELECT 1 AS ok FROM concept_closure WHERE ancestor = ? AND descendant = ? LIMIT 1`,
      [ancestorId, descendantId]);
    return !!row;
  }

  // -- iteration -------------------------------------------------------------------------

  /**
   * The children of a concept, or the roots when asked for nothing. Iterating the whole
   * classification is not offered: isNotClosed() already says the linearizations have a
   * grammar, and 37,000 concepts is not something to walk by accident.
   */
  async iterator(context) {
    const ctxt = await this.#ensureContext(context);
    if (ctxt instanceof ICD11Expression) return null;
    const rows = ctxt
      ? await this.#all(
        `SELECT c.* FROM concept_parent cp JOIN concept c ON c.id = cp.child
          WHERE cp.parent = ? ORDER BY cp.seq`, [ctxt.id])
      : await this.#all(
        `SELECT c.* FROM concept c WHERE c.system = ?
            AND NOT EXISTS (SELECT 1 FROM concept_parent WHERE child = c.id)
          ORDER BY COALESCE(c.lft, c.id)`, [this.shared.systemId]);
    return { rows, cursor: 0 };
  }

  async nextContext(iteratorContext) {
    if (!iteratorContext || iteratorContext.cursor >= iteratorContext.rows.length) return null;
    return new ICD11Concept(iteratorContext.rows[iteratorContext.cursor++]);
  }

  // -- filters ---------------------------------------------------------------------------

  /**
   * `concept is-a` and `concept descendent-of` are what WHO's own value sets use, and what
   * a postcoordination scale is expressed with. The filter value may be a short code or an
   * entity uri: WHO's published value sets mix the two, so both have to work.
   */
  async doesFilter(prop, op, value) {
    return prop === 'concept' && (op === 'is-a' || op === 'descendent-of') && !!value;
  }

  async getPrepContext(iterate) {
    return new FilterExecutionContext(iterate);
  }

  async filter(filterContext, forIteration, prop, op, value) {
    if (!await this.doesFilter(prop, op, value)) {
      throw new Issue('error', 'not-supported', null, 'FILTER_NOT_UNDERSTOOD',
        `The filter "${prop} ${op} ${value}" is not understood for ${this.system()}`,
        'vs-invalid', 422);
    }
    const target = await this.#resolve(value);
    if (!target) {
      // a value set that names a code that is not there is broken, and saying so is more
      // use than quietly expanding to nothing
      throw new Issue('error', 'code-invalid', null, null,
        `The filter value '${value}' is not a code in ${this.system()}`, 'invalid-code', 422);
    }
    filterContext.filters.push(new ICD11FilterSet('isa', {
      ancestorId: target.id, minDepth: op === 'is-a' ? 0 : 1, value,
    }));
  }

  /**
   * A text filter over the classification's own search surface: titles, index terms and
   * inclusions, which are what the ICD Browser matches on. A LIKE scan is honest but not
   * fast; the designation table is the right place for an FTS index when it matters.
   */
  async searchFilter(filterContext, filter, sort) { // eslint-disable-line no-unused-vars
    const text = (filter?.filter ?? filter ?? '').toString().toLowerCase();
    const set = new ICD11FilterSet('search', { text });
    filterContext.filters.push(set);
    return set;
  }

  async executeFilters(filterContext) {
    return filterContext.filters;
  }

  /** Build the rows of a set. Only ever needed when the set is going to be walked. */
  async #materialise(set) {
    if (set.rows) return set.rows;
    if (set.kind === 'isa') {
      set.rows = await this.#all(
        `SELECT c.* FROM concept_closure cl JOIN concept c ON c.id = cl.descendant
          WHERE cl.ancestor = ? AND cl.depth >= ?
          ORDER BY COALESCE(c.lft, c.id)`, [set.ancestorId, set.minDepth]);
    } else {
      set.rows = await this.#all(
        `SELECT DISTINCT c.* FROM designation d JOIN concept c ON c.id = d.concept
          WHERE c.system = ? AND d.lang IN (?, ?)
            AND d.kind IN ('title', 'indexTerm', 'inclusion', 'fullySpecifiedName')
            AND LOWER(d.value) LIKE ?
          ORDER BY COALESCE(c.lft, c.id)`,
        [this.shared.systemId, this.#displayLang(), this.defLang(), `%${set.text}%`]);
    }
    return set.rows;
  }

  async filterSize(filterContext, set) {
    return (await this.#materialise(set)).length;
  }

  async filterMore(filterContext, set) {
    return set.cursor < (await this.#materialise(set)).length;
  }

  async filterConcept(filterContext, set) {
    const rows = await this.#materialise(set);
    if (set.cursor >= rows.length) return null;
    return new ICD11Concept(rows[set.cursor++]);
  }

  async filterLocate(filterContext, set, code) {
    const found = await this.locate(code);
    if (!found.context) return found.message ?? `Code '${code}' is not valid in ${this.system()}`;
    const ok = await this.filterCheck(filterContext, set, found.context);
    return ok === true ? found.context : ok;
  }

  async filterCheck(filterContext, set, concept) {
    // an expression is a narrower thing than any concept, so it is never a member of a set
    // defined by is-a over the classification
    if (!(concept instanceof ICD11Concept)) return `'${await this.code(concept)}' is not in the value set`;
    if (set.kind === 'isa') {
      const row = await this.#get(
        `SELECT 1 AS ok FROM concept_closure
          WHERE ancestor = ? AND descendant = ? AND depth >= ? LIMIT 1`,
        [set.ancestorId, concept.id, set.minDepth]);
      return row ? true : `'${concept.canonicalCode}' is not in the value set`;
    }
    const rows = await this.#materialise(set);
    return rows.some(r => r.id === concept.id)
      ? true : `'${concept.canonicalCode}' is not in the value set`;
  }

  /** The filter sets are closed, whatever the code system as a whole may be. */
  async filtersNotClosed() { return false; }

  async filterFinish() { }
}

class ICD11ServicesFactory extends CodeSystemFactoryProvider {
  /**
   * @param i18n         translations
   * @param dbPath       the ICD-11 database
   * @param systemCode   which of the three code systems in it this factory serves
   */
  constructor(i18n, dbPath, systemCode) {
    super(i18n);
    this.dbPath = dbPath;
    this.systemCode = systemCode;
    this.uses = 0;
    this._loaded = false;
    this._shared = null;
  }

  system() { return this._shared?.url; }
  version() { return this._shared?.version; }
  defaultVersion() { return this._shared?.version; }

  /**
   * Short label for the home page and for code system links. Deliberately not the WHO
   * title from the database (which the provider uses): this has to answer before load(),
   * since the home page sorts factories by name.
   */
  name() {
    switch (this.systemCode) {
      case 'mms': return 'ICD-11 MMS';
      case 'icf': return 'ICD-11 ICF';
      case 'foundation': return 'ICD-11 Foundation';
      default: return `ICD-11 ${this.systemCode}`;
    }
  }

  id() { return `icd11-${this.systemCode}`; }

  async load() {
    if (this._loaded) return;
    const db = new sqlite3.Database(this.dbPath, sqlite3.OPEN_READONLY);
    try {
      const get = (sql, p) => new Promise((res, rej) =>
        db.get(sql, p, (e, r) => e ? rej(e) : res(r)));
      const sys = await get('SELECT * FROM system WHERE code = ?', [this.systemCode]);
      if (!sys) {
        throw new Error(`ICD-11 database ${this.dbPath} has no '${this.systemCode}' code system`);
      }
      const count = await get('SELECT COUNT(*) n FROM concept WHERE system = ?', [sys.id]);
      const langs = await get("SELECT value FROM meta WHERE key = 'languages'", []);
      this._shared = {
        systemCode: sys.code,
        systemId: sys.id,
        url: sys.url,
        version: sys.version,
        title: sys.title,
        isTree: !!sys.is_tree,
        count: count.n,
        languages: (langs?.value || 'en').split(','),
      };
    } finally {
      db.close();
    }
    this._loaded = true;
  }

  async build(opContext, supplements) {
    if (!this._loaded) await this.load();
    this.recordUse();
    const db = new sqlite3.Database(this.dbPath, sqlite3.OPEN_READONLY);
    return new ICD11Services(opContext, supplements, db, this._shared);
  }

  /**
   * The postcoordination scale value sets. WHO publishes one per axis per stem -- 25,354 of
   * them for 2026-01 -- and $lookup hands out their canonicals as the postcoordinationScale
   * property of a concept, so a client that follows one has to find something at the other
   * end. They are built on demand from pc_scale rather than shipped: the compose is three
   * or four is-a includes, and pre-expanding the lot would be 14.6 million rows.
   */
  async buildKnownValueSet(url, version) {
    if (!url || !url.includes('/postcoordinationScale/')) return null;
    if (!this._loaded) await this.load();
    if (version && version !== this._shared.version) return null;

    const db = new sqlite3.Database(this.dbPath, sqlite3.OPEN_READONLY);
    try {
      const get = (sql, p) => new Promise((res, rej) => db.get(sql, p, (e, r) => e ? rej(e) : res(r)));
      const all = (sql, p) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r || [])));
      const scale = await get(
        `SELECT ps.id, ps.axis, ps.axis_name, ps.required, ps.allow_multiple,
                c.entity_id, c.code AS stem_code, c.uri AS stem_uri
           FROM pc_scale ps JOIN concept c ON c.id = ps.concept
          WHERE ps.value_set_uri = ? AND c.system = ?`, [url, this._shared.systemId]);
      if (!scale) return null;
      const roots = await all(
        `SELECT target_uri FROM pc_scale_entity WHERE scale = ? ORDER BY seq`, [scale.id]);

      const slug = `${this._shared.systemCode}-${scale.entity_id}-${scale.axis_name}`.replace(/\//g, '-');
      return {
        resourceType: 'ValueSet',
        id: `icd11-${slug}`.slice(0, 64),
        url,
        version: this._shared.version,
        name: `ICD11_${slug.replace(/[^A-Za-z0-9_]/g, '_')}`,
        title: `${scale.axis_name} for ${scale.stem_code || scale.entity_id}`,
        status: 'active',
        experimental: false,
        date: this._shared.version,
        publisher: 'World Health Organization',
        description: `The values WHO permits on the ${scale.axis_name} postcoordination axis `
          + `of ${scale.stem_code || scale.stem_uri}.`,
        compose: {
          // one include per scale root: membership is the root and everything under it,
          // which is exactly how WHO expresses it in its own published value sets
          include: roots.map(r => ({
            system: this._shared.url,
            version: this._shared.version,
            filter: [{ property: 'concept', op: 'is-a', value: r.target_uri }],
          })),
        },
      };
    } finally {
      db.close();
    }
  }

  /** Which code systems a given database holds, so the library can register one each. */
  static listSystems(dbPath) {
    return new Promise((resolve, reject) => {
      const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
        if (err) { reject(new Error(`cannot open ICD-11 database ${dbPath}: ${err.message}`)); return; }
        db.all('SELECT code, url, version, title FROM system ORDER BY code', (e, rows) => {
          db.close();
          if (e) reject(new Error(`${dbPath} is not an ICD-11 database: ${e.message}`));
          else resolve(rows || []);
        });
      });
    });
  }
}

module.exports = { ICD11Services, ICD11ServicesFactory, ICD11Concept };
