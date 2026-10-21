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
const { ICD11Expression, parseExpression, axisLabel } = require('./icd11-expressions');
const { Issue } = require('../library/operation-outcome');
const { DesignationUse } = require('../library/designations');
const assert = require('assert');

// WHO's own vocabulary for the kinds of text an entity carries, used as designation.use.
const SCHEMA_NS = 'http://id.who.int/icd/schema';
const FOUNDATION_URL = 'http://id.who.int/icd/entity';

// The extension a Coding may carry to save the reader a lookup: the short code (or the
// short-code form of an expression) for the entity id in Coding.code. Provisional url.
const CLASSIFICATION_CODE_EXT = 'http://id.who.int/icd/schema/extension/classificationCode';

// The code system of allowMultipleValues: AllowAlways | NotAllowed | AllowedExceptFromSameBlock
const ALLOW_MULTIPLE_CS = `${SCHEMA_NS}/allowMultipleValues`;

// designation.kind values that are not designations: `definition` is
// CodeSystem.concept.definition, and is returned by definition() instead.
const NOT_A_DESIGNATION = new Set(['definition']);

/**
 * The context object handed back by locate() and passed to every accessor. It carries
 * enough of the concept row that the cheap accessors never go back to the database.
 */
class ICD11Concept {
  /**
   * @param row     the concept row
   * @param bareIds true for the linearizations (MMS, ICF), whose code is the bare entity id;
   *                false for the Foundation, whose code is still the entity uri
   */
  constructor(row, bareIds) {
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
    this.bareIds = !!bareIds;
  }

  /**
   * The concept's code. In MMS and ICF it is the bare entity id (257068234, or
   * 1363559646/other for a residual): the full uri is the system url + '/' + the id, so
   * the prefix carries nothing (the October 2026 WHO meeting). The short code (this.code)
   * is its classificationCode, reported beside it. The Foundation was not part of that
   * decision, and keeps the entity uri.
   */
  get canonicalCode() {
    return this.bareIds ? this.entityId : this.uri;
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

  /** MMS and ICF codes are bare entity ids; the Foundation's are still entity uris. */
  get #bareIds() { return this.shared.systemCode !== 'foundation'; }

  #concept(row) {
    const c = new ICD11Concept(row, this.#bareIds);
    // "selectable" is a linearization's notion - a category with a short code. The importer
    // records 0 for every Foundation entity, which has neither; but nothing in the Foundation is
    // a grouper in that sense, so none of it is reported as not selectable
    if (!this.#bareIds) c.selectable = true;
    return c;
  }

  /** The code of a concept row, for references to it (parent, child, stem, values). */
  #ref(row) { return this.#bareIds ? row.entity_id : row.uri; }

  // -- metadata -------------------------------------------------------------------------

  system() { return this.shared.url; }
  version() { return this.shared.version; }

  /**
   * CodeSystem.name, as export-icd11-codesystem.js writes it: ICD11MMS, ICD11ICF,
   * ICD11FOUNDATION.
   */
  name() { return `ICD11${this.shared.systemCode.toUpperCase()}`; }

  /**
   * $lookup's display name: the linearization title in the request's language where WHO
   * translated it, else the primary title. $lookup passes its working languages
   * (displayLanguage, else Accept-Language), since displayLanguage never reaches
   * opContext.langs.
   */
  lookupName(languages) {
    return this.shared.titles?.[this.#displayLang(languages)] || this.shared.title || this.name();
  }
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
   * MMS and ICF accept the bare entity id (the code) and the short classification code;
   * the Foundation accepts its entity uri and the short code. Returns { context, message }; a plain miss carries no message, which the
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

  /**
   * A plain code as written - the short code, or the entity id (MMS, ICF) or uri
   * (Foundation); null if it is none of them. An id is looked up as system + '/' + id,
   * which is what its uri is, so the uri index serves both. The full uri is not accepted
   * in MMS or ICF: it is not a code there.
   */
  async #resolve(code) {
    const uri = this.#bareIds ? `${this.shared.url}/${code}` : code;
    const row = await this.#get(
      `SELECT * FROM concept WHERE system = ? AND (code = ? OR uri = ?)`,
      [this.shared.systemId, code, uri]);
    return row ? this.#concept(row) : null;
  }

  /** What the expression parser needs: the database, and the request's translations. */
  #expressionContext() {
    return {
      get: (sql, params) => this.#get(sql, params),
      all: (sql, params) => this.#all(sql, params),
      resolve: (text) => this.#resolve(text),
      translate: (msgId, params) => this.opContext.i18n.translate(msgId, this.opContext.langs, params),
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

  /** The short-code form (1A00, or 1A00&XN8P1 for an expression), where there is one. */
  async classificationCode(context) {
    const ctxt = await this.#ensureContext(context);
    if (ctxt === null) return null;
    return (ctxt instanceof ICD11Expression ? ctxt.classificationCode : ctxt.code) || null;
  }

  /** Value sets may enumerate short codes; the expansion carries the code, the uri. */
  async expansionCode(context, requested) {
    return (await this.code(context)) || requested;
  }

  mandatoryExpansionProperties() { return ['classificationCode']; }

  /**
   * $validate-code reports the classificationCode only for a code written with entity ids - in
   * any order, since the classificationCode is the short-code form of the normal form, beside
   * normalized-code. A code written with short codes (wholly or in part) gets none: it already
   * is, or contains, the classification code.
   */
  async reportedClassificationCode(context, code) {
    const ctxt = await this.#ensureContext(context);
    if (ctxt === null) return null;
    const idForm = ctxt instanceof ICD11Expression
      ? ctxt.tokens.every(t => t.text === t.concept.canonicalCode)
      : code === ctxt.canonicalCode;
    return idForm ? this.classificationCode(ctxt) : null;
  }

  /** A postcoordinated expression's parse records what validation should say about it. */
  async codeIssues(context) {
    const ctxt = await this.#ensureContext(context);
    return ctxt instanceof ICD11Expression ? ctxt.issues : [];
  }

  /**
   * The classificationCode extension on a Coding, when present, has to be true: it is there
   * so software can show the short code without a lookup, and a wrong one would be shown.
   * It is defined for an MMS or ICF coding whose code is the entity id (or the id form of an
   * expression) - a short code needs no other short code beside it - and its value has to be
   * that code's classificationCode exactly.
   */
  async checkCodingExtensions(coding, context) {
    const out = [];
    const exts = coding.extension || [];
    for (let index = 0; index < exts.length; index++) {
      const ext = exts[index];
      if (ext.url !== CLASSIFICATION_CODE_EXT) continue;
      const value = ext.valueCode ?? '';
      // the linearizations have classification codes; the Foundation has none
      if (this.shared.systemCode === 'foundation') {
        out.push({ index, msgId: 'ICD11_CLASSIFICATION_CODE_SYSTEM', params: [this.shared.url] });
        continue;
      }
      const ctxt = await this.#ensureContext(context);
      const id = await this.code(ctxt);
      const expected = await this.classificationCode(ctxt);
      if (coding.code !== id) {
        out.push({ index, msgId: 'ICD11_CLASSIFICATION_CODE_NOT_ID', params: [coding.code, id] });
      } else if (!expected) {
        out.push({ index, msgId: 'ICD11_CLASSIFICATION_CODE_NONE', params: [value, coding.code] });
      } else if (value !== expected) {
        out.push({ index, msgId: 'ICD11_CLASSIFICATION_CODE_WRONG', params: [value, coding.code, expected] });
      }
    }
    return out;
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
      `SELECT c.entity_id, c.uri FROM concept_parent cp JOIN concept c ON c.id = cp.parent
        WHERE cp.child = ? ORDER BY cp.seq LIMIT 1`, [ctxt.id]);
    return row ? this.#ref(row) : null;
  }

  /**
   * The best language for display, given what the request asked for. Languages is an
   * iterable of Language, in quality order; the database holds translations keyed on the
   * primary subtag, so that is what is matched.
   */
  #displayLang(languages) {
    const langs = languages || this.opContext?.langs;
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
      // The entity uri is the code (decided at the October 2026 test-case review); the short
      // code is reported alongside it as classificationCode. Both are codes in this code
      // system, so both are type code.
      { code: 'code', uri: `${SCHEMA_NS}/entityId`, type: 'code',
        description: this.#bareIds
          ? 'The code: the WHO entity id. The entity uri is the system url + \'/\' + the id.'
          : 'The code: the stable, unversioned WHO entity uri.' },
      { code: 'classificationCode', uri: `${SCHEMA_NS}/code`, type: 'code',
        description: 'The short classification code (e.g. 1A00), where the entity has one.' },
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
        { code: 'source', uri: `${SCHEMA_NS}/source`, type: 'Coding',
          description: 'The Foundation entity this linearization entry came from, as a Coding in '
            + 'the Foundation. Requested as `source.details`, it also carries what a $lookup of '
            + 'that entity returns: subproperties (definition, parent) and designation parts.' },
        { code: 'blockId', uri: `${SCHEMA_NS}/blockId`, type: 'string' },
        { code: 'codeRange', uri: `${SCHEMA_NS}/codeRange`, type: 'string' },
        { code: 'postcoordination', uri: `${SCHEMA_NS}/postcoordination`, type: 'string',
          description: 'One per axis the code declares, with subproperties axis, required, '
            + 'allowMultipleValues and valueSet; for an expression, also value (repeating), valued '
            + 'or not, and a value that is a cluster member carries its own postcoordination '
            + 'entries. Has no value of its own.' },
        { code: 'allowMultipleValues', uri: `${SCHEMA_NS}/allowMultipleValues`, type: 'Coding',
          description: 'Subproperty of postcoordination: AllowAlways | NotAllowed | AllowedExceptFromSameBlock.' },
        { code: 'valueSet', uri: `${SCHEMA_NS}/valueSet`, type: 'string',
          description: 'Subproperty of postcoordination: the canonical of the ValueSet of the values '
            + 'permitted on the axis.' },
        // only ever returned for a postcoordinated expression, never for a plain concept
        { code: 'stem', uri: `${SCHEMA_NS}/stem`, type: 'Coding',
          description: 'The root of the expression.' },
        { code: 'axis', uri: `${SCHEMA_NS}/axis`, type: 'Coding',
          description: 'Subproperty of postcoordination: the axis, in the schema vocabulary.' },
        { code: 'required', uri: `${SCHEMA_NS}/requiredPostcoordination`, type: 'boolean',
          description: 'Subproperty of postcoordination: the axis must be given a value.' },
        { code: 'value', uri: `${SCHEMA_NS}/value`, type: 'Coding',
          description: 'Subproperty of postcoordination: a code on the axis.' });
    }
    return defs;
  }

  async properties(context) {
    const ctxt = await this.#ensureContext(context);
    if (!ctxt) return [];
    if (ctxt instanceof ICD11Expression) {
      const out = [{ code: 'code', valueCode: ctxt.canonicalCode }];
      if (ctxt.classificationCode) out.push({ code: 'classificationCode', valueCode: ctxt.classificationCode });
      return out;
    }
    const out = [{ code: 'code', valueCode: ctxt.canonicalCode }];
    if (ctxt.classKind) out.push({ code: 'classKind', valueCode: ctxt.classKind });
    if (ctxt.code) out.push({ code: 'classificationCode', valueCode: ctxt.code });
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
  async extendLookup(ctxt, props, params, txParams) {
    validateArrayParameter(props, 'props', String);
    validateArrayParameter(params, 'params', Object);
    const concept = await this.#ensureContext(ctxt);
    if (!concept) return;
    // post-coordination-metadata=true asks for every axis, with its rules; otherwise only the
    // axes that carry a value are described, and only by what is on them
    const meta = !!txParams?.postCoordinationMetadata;
    if (concept instanceof ICD11Expression) {
      return this.#extendLookupExpression(concept, props, params, meta);
    }

    // code is the entity id (uri in the Foundation); classificationCode the short code,
    // only where there is one
    if (this._hasProp(props, 'code', true)) {
      this._addCodeProperty(params, 'property', 'code', concept.canonicalCode);
    }
    if (concept.code && this._hasProp(props, 'classificationCode', true)) {
      this._addCodeProperty(params, 'property', 'classificationCode', concept.code);
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
    // `source.details` is not a property of its own: it asks for source, with the Foundation
    // entity's own lookup content inside it
    const sourceDetails = props.some(p => String(p).toLowerCase() === 'source.details');
    if (concept.sourceUri && (sourceDetails || this._hasProp(props, 'source', true))) {
      params.push({ name: 'property', part: await this.#sourcePart(concept.sourceUri, sourceDetails) });
    }
    if (concept.browserUrl && this._hasProp(props, 'browserUrl', false)) {
      this._addStringProperty(params, 'property', 'browserUrl', concept.browserUrl);
    }

    // hierarchy. Parents and children are codes in this code system, so they are spelled
    // the same way as the code.
    if (this._hasProp(props, 'parent', true)) {
      for (const r of await this.#all(
          `SELECT c.entity_id, c.uri FROM concept_parent cp JOIN concept c ON c.id = cp.parent
            WHERE cp.child = ? ORDER BY cp.seq`, [concept.id])) {
        this._addCodeProperty(params, 'property', 'parent', this.#ref(r));
      }
    }
    if (this._hasProp(props, 'child', false)) {
      for (const r of await this.#all(
          `SELECT c.entity_id, c.uri FROM concept_parent cp JOIN concept c ON c.id = cp.child
            WHERE cp.parent = ? ORDER BY cp.seq`, [concept.id])) {
        this._addCodeProperty(params, 'property', 'child', this.#ref(r));
      }
    }

    // The postcoordination axes this concept declares: one postcoordination property per
    // axis, in the shape a postcoordinated expression uses, with nothing on any axis. Only
    // with post-coordination-metadata: without it only valued axes are listed, and a plain
    // concept has none.
    if (meta && this.shared.systemCode !== 'foundation' && this._hasProp(props, 'postcoordination', true)) {
      for (const axis of await this.#all(
          `SELECT id, seq, axis, axis_name, required, allow_multiple, value_set_uri FROM pc_scale
            WHERE concept = ? ORDER BY seq`, [concept.id])) {
        params.push({ name: 'property', part: this.#axisEntry(axis, true) });
      }
    }
  }

  /**
   * $lookup for a postcoordinated expression (the October 2026 WHO meeting):
   *
   *   code, classificationCode  the id form and the short-code form, as for a plain concept
   *   stem                      the root, as a Coding
   *   postcoordination          one per axis the root declares, valued or not:
   *                               axis                 Coding in the schema vocabulary
   *                               required             boolean
   *                               allowMultipleValues  Coding (AllowAlways | NotAllowed | ...)
   *                               valueSet             string: the canonical of the axis's ValueSet
   *                               value                Coding, repeating: what is on the axis
   *                             plus one with only `value`s, for `/` members on no axis of the
   *                             root.
   *
   * Without post-coordination-metadata=true only the axes that carry a value are listed, and
   * each carries only `axis` and its values: required, allowMultipleValues and valueSet, and
   * the unvalued axes, are the metadata. (A `/` member with no qualifiers is then just its
   * Coding.)
   *
   * A `value` that is a `/` member is a code with axes of its own, and carries its own
   * postcoordination entries inside it, one level down - the same shape. That nesting is the
   * only way to keep a member's qualifiers with that member: the same code can be a member
   * twice with different qualifiers. ($lookup does not describe subproperties inside
   * subproperties; Parameters allows them.)
   *
   * Everything comes out in normal-form order: axes in the order the code defines them,
   * values in the order the normal form puts them.
   */
  async #extendLookupExpression(expr, props, params, meta) {
    if (this._hasProp(props, 'code', true)) {
      this._addCodeProperty(params, 'property', 'code', expr.canonicalCode);
    }
    if (expr.classificationCode && this._hasProp(props, 'classificationCode', true)) {
      this._addCodeProperty(params, 'property', 'classificationCode', expr.classificationCode);
    }
    const root = expr.stems[0];
    if (this._hasProp(props, 'stem', true)) {
      params.push({ name: 'property', part: [
        { name: 'code', valueCode: 'stem' },
        { name: 'value', valueCoding: await this.#coding(root.stem.concept) }] });
    }
    if (this._hasProp(props, 'postcoordination', true)) {
      for (const part of await this.#postcoordination(expr, root, true, meta)) {
        params.push({ name: 'property', part });
      }
    }
  }

  /**
   * The `source` property: the Foundation entity a linearization entry came from, as a Coding
   * in the Foundation (whose codes are entity uris), with its title. With `details`, it also
   * carries what a $lookup of that entity would say: as subproperties, its definition and its
   * parents in the Foundation (codes there, as $lookup returns them); and its designations, as
   * `designation` parts shaped like a $lookup's own. The display is already on the Coding.
   * The Foundation is in the same database, so no second provider is needed; if a
   * database was built without it, the Coding is all there is.
   */
  async #sourcePart(uri, details) {
    const row = await this.#get(
      `SELECT c.id, s.url AS system_url FROM concept c JOIN system s ON s.id = c.system
        WHERE s.code = 'foundation' AND c.uri = ?`, [uri]);
    const coding = { system: row ? row.system_url : FOUNDATION_URL, code: uri };
    const label = row ? await this.#title(row) : null;
    if (label) coding.display = label;
    const part = [{ name: 'code', valueCode: 'source' }, { name: 'value', valueCoding: coding }];
    if (details && row) {
      const sub = (code, value) => ({ name: 'subproperty', part: [{ name: 'code', valueCode: code }, { name: 'value', ...value }] });
      const def = await this.#get(
        `SELECT value FROM designation
          WHERE concept = ? AND kind = 'definition' AND lang = ? ORDER BY seq LIMIT 1`,
        [row.id, this.#displayLang()]);
      if (def) part.push(sub('definition', { valueString: def.value }));
      for (const r of await this.#all(
          `SELECT c.uri FROM concept_parent cp JOIN concept c ON c.id = cp.parent
            WHERE cp.child = ? ORDER BY cp.seq`, [row.id])) {
        part.push(sub('parent', { valueCode: r.uri }));
      }
      // and its designations, in the same shape as a $lookup's own - which the operation does
      // not describe inside a property, but they are what a $lookup of the entity would say,
      // and a subproperty (a code and a value) cannot carry their language and use
      for (const r of await this.#all(
          `SELECT lang, kind, value FROM designation WHERE concept = ? ORDER BY lang, seq`, [row.id])) {
        if (NOT_A_DESIGNATION.has(r.kind)) continue;
        const value = r.value.trim();
        if (!value) continue;
        const use = r.kind === 'title' ? { ...DesignationUse.DISPLAY } : { system: SCHEMA_NS, code: r.kind };
        part.push({ name: 'designation', part: [
          { name: 'language', valueCode: r.lang },
          { name: 'use', valueCoding: use },
          { name: 'value', valueString: value }] });
      }
    }
    return part;
  }

  /** A concept in this code system as a Coding, with its display. */
  async #coding(concept) {
    const c = { system: this.shared.url, code: concept.canonicalCode };
    const label = await this.#title(concept);
    if (label) c.display = label;
    return c;
  }

  /**
   * The postcoordination entries for one code of an expression - the root, or a `/` member -
   * each as the `part` list of a property (or, one level down, of a subproperty).
   */
  async #postcoordination(expr, st, isRoot, meta) {
    const pos = (t) => expr.tokens.indexOf(t);
    const out = [];
    for (const axis of [...st.axes].sort((a, b) => a.seq - b.seq)) {
      const values = st.bindings.filter(b => b.axis === axis).map(b => b.token).sort((a, b) => pos(a) - pos(b));
      if (!meta && values.length === 0) continue;   // unvalued axes only with the metadata
      const part = this.#axisEntry(axis, meta);
      for (const t of values) part.push(await this.#valuePart(expr, t, meta));
      out.push(part);
    }
    if (isRoot) {
      // `/` members that are on no axis of the root still qualify it
      const loose = expr.tokens.filter(t => t.sep === '/' && !t.axis);
      if (loose.length) {
        const part = [{ name: 'code', valueCode: 'postcoordination' }];
        for (const t of loose) part.push(await this.#valuePart(expr, t, meta));
        out.push(part);
      }
    }
    return out;
  }

  /**
   * The start of a postcoordination entry: the axis and what is known about it. A plain
   * concept's lookup stops here; an expression's adds the values.
   */
  #axisEntry(axis, meta) {
    const sub = (code, value) => ({ name: 'subproperty', part: [{ name: 'code', valueCode: code }, { name: 'value', ...value }] });
    const part = [
      { name: 'code', valueCode: 'postcoordination' },
      sub('axis', { valueCoding: { system: SCHEMA_NS, code: axis.axis_name, display: axisLabel(axis.axis_name) } })];
    if (!meta) return part;      // the axis rules are post-coordination-metadata
    part.push(sub('required', { valueBoolean: !!axis.required }));
    if (axis.allow_multiple) {
      part.push(sub('allowMultipleValues', { valueCoding: { system: ALLOW_MULTIPLE_CS, code: axis.allow_multiple } }));
    }
    if (axis.value_set_uri) {
      part.push(sub('valueSet', { valueString: axis.value_set_uri }));
    }
    return part;
  }

  /** One `value` subproperty; a `/` member carries its own axes inside it. */
  async #valuePart(expr, token, meta) {
    const part = [{ name: 'code', valueCode: 'value' }, { name: 'value', valueCoding: await this.#coding(token.concept) }];
    const member = token.sep === '/' ? expr.stems.find(st => st.stem === token) : null;
    if (member) {
      for (const p of await this.#postcoordination(expr, member, false, meta)) {
        part.push({ name: 'subproperty', part: p });
      }
    }
    return { name: 'subproperty', part };
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
    return this.#concept(iteratorContext.rows[iteratorContext.cursor++]);
  }

  // -- filters ---------------------------------------------------------------------------

  /**
   * `concept is-a` and `concept descendent-of` are what WHO's own value sets use, and what
   * a postcoordination scale is expressed with. The filter value is a code as #resolve
   * reads it: the short code, or the entity id (MMS, ICF) or uri (Foundation).
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
      throw new Issue('error', 'code-invalid', null, 'FILTER_VALUE_UNKNOWN_CODE',
        this.opContext.i18n.translate('FILTER_VALUE_UNKNOWN_CODE', this.opContext.langs, [value, this.system()]),
        'invalid-code', 422);
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
      // the text, or the start of a short code (searching 1A0 finds 1A00..1A09): the code
      // is a uri now, so the short code is the one a person types
      set.rows = await this.#all(
        `SELECT c.* FROM concept c
          WHERE c.system = ?
            AND (LOWER(c.code) LIKE ?
              OR EXISTS (SELECT 1 FROM designation d
                          WHERE d.concept = c.id AND d.lang IN (?, ?)
                            AND d.kind IN ('title', 'indexTerm', 'inclusion', 'fullySpecifiedName')
                            AND LOWER(d.value) LIKE ?))
          ORDER BY COALESCE(c.lft, c.id)`,
        [this.shared.systemId, `${set.text}%`, this.#displayLang(), this.defLang(), `%${set.text}%`]);
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
    return this.#concept(rows[set.cursor++]);
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
      return row ? true : `'${concept.code || concept.canonicalCode}' is not in the value set`;
    }
    const rows = await this.#materialise(set);
    return rows.some(r => r.id === concept.id)
      ? true : `'${concept.code || concept.canonicalCode}' is not in the value set`;
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
      // per-language titles; a database built before system_title existed has none
      const all = (sql, p) => new Promise((res, rej) =>
        db.all(sql, p, (e, r) => e ? rej(e) : res(r || [])));
      const titles = {};
      const hasTitles = await get(
        "SELECT 1 x FROM sqlite_master WHERE type = 'table' AND name = 'system_title'", []);
      if (hasTitles) {
        for (const r of await all('SELECT lang, title FROM system_title WHERE system = ?', [sys.id])) {
          titles[r.lang] = r.title;
        }
      }
      this._shared = {
        systemCode: sys.code,
        systemId: sys.id,
        url: sys.url,
        version: sys.version,
        title: sys.title,
        titles,
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
   * them for 2026-01 -- and $lookup hands out their canonicals as the valueSet of each postcoordination
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
      // the filter values are codes, so ids: the scale root's uri is system + '/' + its id
      const roots = await all(
        `SELECT target_uri FROM pc_scale_entity WHERE scale = ? ORDER BY seq`, [scale.id]);
      const prefix = `${this._shared.url}/`;
      const rootCode = (u) => (u.startsWith(prefix) ? u.slice(prefix.length) : u);

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
          + `of ${scale.stem_code || scale.entity_id}.`,
        compose: {
          // one include per scale root: membership is the root and everything under it,
          // which is exactly how WHO expresses it in its own published value sets
          include: roots.map(r => ({
            system: this._shared.url,
            version: this._shared.version,
            filter: [{ property: 'concept', op: 'is-a', value: rootCode(r.target_uri) }],
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
