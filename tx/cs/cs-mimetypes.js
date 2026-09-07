const { CodeSystemProvider, CodeSystemFactoryProvider, FilterExecutionContext, cannotDetermineSubsumption} = require('./cs-api');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { XMLParser } = require('fast-xml-parser');
const { CodeSystem } = require("../library/codesystem");
const { Issue } = require("../library/operation-outcome");

/**
 * Media type parameters this server understands well enough to reason about subsumption.
 *
 * Deciding whether one media type subsumes another needs two things of a parameter: that
 * adding it NARROWS the type, and that two different values are mutually exclusive. Both
 * are properties of the specific parameter, not of parameters in general, so they can
 * only be asserted for parameters whose definition is known. Where an unknown parameter
 * is what distinguishes the two codes, the answer is not knowable and the server says so
 * rather than guessing (FHIR-58748).
 *
 *  - charset  (RFC 2046) narrows, and two charsets are different encodings
 *  - format   (RFC 3676, text/plain) fixed vs flowed, mutually exclusive
 *  - delsp    (RFC 3676) yes vs no
 *  - version  narrows, and two versions are distinct
 *
 * Deliberately NOT here, though both are common:
 *  - boundary (multipart, RFC 2046) does not narrow at all - two multipart bodies with
 *    different boundaries are the same media type, so treating a differing boundary as
 *    "not subsumed" would be wrong, and treating it as narrowing would be worse
 *  - profile  values can be hierarchical (one profile derived from another), so two
 *    different values are not necessarily mutually exclusive
 *
 * Both of those therefore yield cannot-determine, which is the honest answer until
 * someone implements what they actually mean.
 *
 * @type {Set<string>}
 */
const UNDERSTOOD_PARAMETERS = new Set(['charset', 'format', 'delsp', 'version']);

/**
 * Parameters whose VALUES are case-insensitive.
 *
 * RFC 2045 section 5.1 makes type, subtype and parameter names case-insensitive, and then says
 * of values: "Parameter values are normally case sensitive, but sometimes are interpreted in a
 * case-insensitive fashion, depending on the intended use." So a value is only folded where its
 * own definition says to fold it, and this is the list of those we know of:
 *
 *  - charset  RFC 2046 section 4.1.2: "Unlike some other parameter values, the values of the
 *             charset parameter are NOT case sensitive." (RFC 9110 section 8.3.2 agrees.)
 *  - format   RFC 3676 section 4, of Format and DelSp together: "(Neither the parameter names
 *  - delsp    nor values are case sensitive.)"
 *
 * `version` is deliberately absent: there is no general definition of a version parameter -
 * it exists only per-registration (text/vcard has one, text/html deliberately removed one) -
 * so there is nothing that says its values fold, and folding them could equate two versions
 * that a registration means to distinguish.
 *
 * @type {Set<string>}
 */
const CASE_INSENSITIVE_VALUES = new Set(['charset', 'format', 'delsp']);

/**
 * Media types whose registration gives a parameter a DEFAULT value.
 *
 * This is the thing that breaks the otherwise tidy rule that a parameter narrows a media type.
 * Where a parameter has a default, the bare form is not the general case - it already carries
 * that value - so `text/plain` does not subsume `text/plain; charset=utf-8`, the two are
 * different things. Applying the default to whichever side omits it, and then comparing as
 * usual, gets this right in both directions: it also makes `text/plain` and
 * `text/plain; charset=us-ascii` come out equivalent, which they are and which we used to
 * get wrong in the other direction.
 *
 * There is no list to load this from. IANA's registry schema has no parameter element at all -
 * a record is a name, a deprecation flag, cross-references and a pointer to a template - and
 * defaults live only in the prose of each defining RFC. `text/plain`, the type that needs this
 * most, has no IANA registration template whatsoever ("No registration template available"),
 * so all of the below comes from the RFCs directly:
 *
 *  - text/plain charset: RFC 2046 section 4.1.2 made US-ASCII the default, and RFC 6657
 *    section 4 exists specifically to say it stayed: "The default "charset" parameter value
 *    for "text/plain" is unchanged from [RFC2046] and remains as "US-ASCII"."
 *  - text/plain format and delsp: RFC 3676 section 4, "If Format is not specified, or if the
 *    value is not recognized, a value of Fixed is assumed" and "If DelSp is not specified, or
 *    if its value is not recognized, a value of No is assumed."
 *  - text/vcard charset: RFC 6350 section 3.1, "The charset ... for vCard is UTF-8 ... There is
 *    no way to override this." A default expressed as a prohibition, but a default.
 *
 * Keyed by lower-case type/subtype; the inner map is lower-case parameter name to the value
 * the bare form implies. Values are stored folded, matching CASE_INSENSITIVE_VALUES.
 *
 * @type {Map<string, Map<string, string>>}
 */
const PARAMETER_DEFAULTS = new Map([
  ['text/plain', new Map([['charset', 'us-ascii'], ['format', 'fixed'], ['delsp', 'no']])],
  ['text/vcard', new Map([['charset', 'utf-8']])]
]);

/**
 * text/* types whose registration says explicitly that charset has NO default.
 *
 * RFC 6657 section 3 left a residual rule behind that is the awkward part of all this:
 * "existing "text/*" registrations that fail to specify how the charset is determined still
 * default to US-ASCII." So for a text/* type, silence in the registration is not the absence
 * of a default - it IS a default, of US-ASCII. That set cannot be enumerated without reading
 * every legacy text/* registration and judging whether it "clearly specifies", so instead of
 * guessing, charset on an unlisted text/* type yields cannot-determine.
 *
 * This set is the escape hatch: text/* types we have actually read, which say there is no
 * default, and for which the narrowing rule therefore holds.
 *
 *  - text/markdown: RFC 7763 section 2, "charset: Per Section 4.2.1 of [RFC6838], charset is
 *    REQUIRED. There is no default value because neither [MDSYNTAX] nor many popular
 *    implementations at the time of this registration do either."
 *  - text/html: a judgement rather than a quoted default, and the only entry here that is.
 *    Neither registration states one - RFC 2854 section 6 recites the RFC 2046 and RFC 2616
 *    rules, observes that they conflict, and only recommends being explicit; the current IANA
 *    registration is the W3C one, whose whole optional-parameters text is that charset
 *    "may be provided to definitively specify the document's character encoding, overriding
 *    any character encoding declarations in the document". HTML determines its encoding in
 *    band, and the phrase "overriding any character encoding declarations in the document"
 *    only makes sense if the absence of the parameter means "whatever the document says"
 *    rather than "US-ASCII". Listed because text/html is the most asked-about media type
 *    there is, and declining to answer for it is a poor trade for a defensible reading.
 *
 * Non-text types need no entry: RFC 6657 is a text/* rule, so silence elsewhere really is
 * silence (application/xml, for instance - RFC 7303 section 3.2 tells consumers they "SHOULD
 * NOT assume a default encoding").
 *
 * @type {Set<string>}
 */
const TEXT_TYPES_WITH_NO_CHARSET_DEFAULT = new Set(['text/markdown', 'text/html']);

// The IANA media types registry. Only the names are kept - the registry is a few MB of
// cross-references and templates, and all the `registered` filter asks is whether a type is in it
const IANA_MEDIA_TYPES_URL = 'https://www.iana.org/assignments/media-types/media-types.xml';
const IANA_MEDIA_TYPES_FILE = 'media-types.xml';
const IANA_DOWNLOAD_TIMEOUT = 15000;

class MimeTypeConcept {
  constructor(code) {
    this.code = code;
    this.mimeType = this.#parseMimeType(code);
    this.normalized = this.#normalize(code);
  }

  /**
   * The canonical spelling of this media type.
   *
   * Four things are canonicalised, and each is something the specs say carries no meaning:
   *
   *  - case, in the type, the subtype, every parameter name, and the values of the parameters
   *    in CASE_INSENSITIVE_VALUES (RFC 2045 section 5.1, RFC 2046 section 4.1.2, RFC 3676
   *    section 4). Every other parameter value keeps its case: RFC 2045 makes values
   *    case-sensitive unless their own definition says otherwise, and a boundary or a profile
   *    URI can genuinely differ by case
   *  - parameter ORDER, which is not significant, so sorting by name gives two spellings of one
   *    media type one spelling. Without this, `text/plain; charset=utf-8; format=flowed` and
   *    `text/plain; format=flowed; charset=utf-8` would have two different "normal" forms,
   *    which is not a normal form at all
   *  - the separator, which becomes '; '
   *  - surrounding and internal padding
   *
   * Quoting is NOT canonicalised. A quoted value can always be written quoted, so removing the
   * quotes needs to know that the value contains no tspecials, and getting that wrong produces
   * a "canonical" form that is not a legal media type. Left for someone who needs it.
   *
   * Note the consequence for validation: reordering or respacing makes this differ from the
   * submitted code by more than case, so it is reported as a normal-form difference rather
   * than a case difference. That is the honest description of what changed.
   */
  #normalize(code) {
    if (!this.mimeType.isValid) {
      return code;
    }
    const segments = code.split(';');
    const params = [];
    for (const segment of segments.slice(1)) {
      const trimmed = segment.trim();
      if (trimmed === '') {
        continue;
      }
      const eq = trimmed.indexOf('=');
      if (eq === -1) {
        // not a name=value pair. The parser ignores it, but dropping it here would make the
        // canonical form say something the submitted code did not, so it is carried through -
        // untouched, since only parameter NAMES fold and nothing says this is one
        params.push({ name: trimmed.toLowerCase(), text: trimmed });
        continue;
      }
      const name = trimmed.slice(0, eq).trim().toLowerCase();
      const value = trimmed.slice(eq + 1).trim();
      params.push({
        name: name,
        text: name + '=' + (CASE_INSENSITIVE_VALUES.has(name) ? value.toLowerCase() : value)
      });
    }
    // by name, then by the whole parameter, so a repeated name is still ordered predictably
    params.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : (a.text < b.text ? -1 : a.text > b.text ? 1 : 0)));
    return [segments[0].trim().toLowerCase(), ...params.map(p => p.text)].join('; ');
  }

  #parseMimeType(code) {
    // type/subtype with optional parameters. Type, subtype and parameter names are all
    // case-insensitive (RFC 9110); parameter values are case-sensitive unless the parameter
    // says otherwise, and charset is the one in common use that says otherwise (RFC 2046)
    const trimmed = code.trim();
    const segments = trimmed.split(';');
    const typeParts = segments[0].trim().split('/');

    if (typeParts.length !== 2 || !typeParts[0].trim() || !typeParts[1].trim()) {
      return { type: '', subtype: '', params: new Map(), isValid: false, source: trimmed };
    }

    const params = new Map();
    for (const segment of segments.slice(1)) {
      const eq = segment.indexOf('=');
      if (eq === -1) {
        continue;
      }
      const name = segment.slice(0, eq).trim().toLowerCase();
      let value = segment.slice(eq + 1).trim();
      if (value.length > 1 && value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      }
      if (CASE_INSENSITIVE_VALUES.has(name)) {
        value = value.toLowerCase();
      }
      if (name) {
        params.set(name, value);
      }
    }

    return {
      type: typeParts[0].trim().toLowerCase(),
      subtype: typeParts[1].trim().toLowerCase(),
      params: params,
      isValid: true,
      source: trimmed
    };
  }

  isValid() {
    return this.mimeType.isValid && !!this.mimeType.subtype;
  }
}

/**
 * The set produced by a `base` filter: the type, and the subtype when one was given. Media types
 * cannot be enumerated, so this set is only ever tested against a code, never iterated.
 */
class MimeTypeFilter {
  constructor(type, subtype) {
    this.type = type;
    this.subtype = subtype;
  }

  /**
   * Is a parsed media type consistent with this base? Parameters on the code are irrelevant -
   * `text/plain; charset=utf-8` is still a text/plain
   * @param {Object} mimeType - the parsed mimeType of a MimeTypeConcept
   * @returns {boolean}
   */
  matches(mimeType) {
    if (mimeType.type !== this.type) {
      return false;
    }
    return this.subtype === null || mimeType.subtype === this.subtype;
  }

  describe() {
    return this.subtype === null ? this.type : this.type + '/' + this.subtype;
  }

  rejection(code) {
    return `The mime type '${code}' is not a ${this.describe()}`;
  }
}

/**
 * The set produced by a `registered` filter: whether the code has to be in the IANA registry,
 * or has to not be. Like MimeTypeFilter it can only be tested, never iterated.
 */
class MimeTypeRegisteredFilter {
  constructor(registered) {
    this.registered = registered;
    this.codes = null;   // set when the filter is being iterated: the registry, sorted
    this.cursor = -1;
  }

  describe() {
    return this.registered ? 'registered with IANA' : 'not registered with IANA';
  }

  rejection(code) {
    return this.registered
      ? `The mime type '${code}' is not registered with IANA`
      : `The mime type '${code}' is registered with IANA, and this filter is for media types that are not`;
  }
}

class MimeTypeServices extends CodeSystemProvider {
  /**
   * @param {OperationContext} opContext
   * @param {CodeSystem[]} supplements
   * @param {Set<string>|null} registeredTypes - lower-cased type/subtype names from the IANA
   *   registry, or null if no copy of the registry could be obtained
   */
  constructor(opContext, supplements, registeredTypes = null) {
    super(opContext, supplements);
    this.registeredTypes = registeredTypes;
  }

  // Metadata methods
  system() {
    return 'urn:ietf:bcp:13'; // BCP 13 defines MIME types
  }

  version() {
    return null;
  }

  description() {
    return 'Mime Types';
  }

  name() {
    return 'Mime Types';
  }

  totalCount() {
    return -1; // Not bounded - infinite possible MIME types
  }

  hasParents() {
    return false; // No hierarchical relationships
  }

  hasAnyDisplays(languages) {
    const langs = this._ensureLanguages(languages);
    if (this._hasAnySupplementDisplays(langs)) {
      return true;
    }
    return false; // MIME types don't have displays by default
  }

  // Core concept methods
  async code(code) {
    
    const ctxt = await this.#ensureContext(code);
    return ctxt ? ctxt.normalized : null;
  }

  async display(code) {
    
    const ctxt = await this.#ensureContext(code);
    if (!ctxt) {
      return null;
    }

    // Check supplements first, by the normalised code - a supplement that designates
    // 'text/plain' has to be found for a request that spells it 'TEXT/Plain'
    const suppDisplay = this._displayFromSupplements(ctxt.normalized);
    if (suppDisplay) {
      return suppDisplay;
    }

    // Default display is the code itself, normalised and trimmed
    return ctxt.normalized.trim();
  }

  async definition(code) {
    
    await this.#ensureContext(code);
    return null; // No definitions provided
  }

  async isAbstract(code) {
    
    await this.#ensureContext(code);
    return false; // MIME types are not abstract
  }

  async isInactive(code) {
    
    await this.#ensureContext(code);
    return false; // MIME types are not inactive
  }

  async isDeprecated(code) {
    
    await this.#ensureContext(code);
    return false; // MIME types are not deprecated
  }

  async designations(code, displays) {
    
    const ctxt = await this.#ensureContext(code);
    if (ctxt != null) {
      const display = await this.display(ctxt);
      if (display) {
        !displays.addDesignation(true, 'active', 'en', CodeSystem.makeUseForDisplay(), display);
      }
      this._listSupplementDesignations(ctxt.code, displays);
    }
  }

  async #ensureContext(code) {
    if (!code) {
      return code;
    }
    if (typeof code === 'string') {
      const ctxt = await this.locate(code);
      if (!ctxt.context) {
        throw new Error(ctxt.message ? ctxt.message : `Invalid MIME type '${code}'`);
      } else {
        return ctxt.context;
      }
    }
    if (code instanceof MimeTypeConcept) {
      return code;
    }
    throw new Error("Unknown Type at #ensureContext: " + (typeof code));
  }

  // Lookup methods
  async locate(code) {
    
    assert(!code || typeof code === 'string', 'code must be string');
    if (!code) return { context: null, message: 'Empty code' };

    const concept = new MimeTypeConcept(code);
    if (concept.isValid()) {
      return { context: concept, message: null };
    }

    return { context: null, message: undefined};
  }

  /**
   * Media types have no registered hierarchy - one subtype is never a kind of another, and a
   * structured syntax suffix does not make one either: `application/fhir+xml` says it is XML
   * syntax (RFC 6839), but it is a separate registration and `Accept: application/xml` does
   * not match it.
   *
   * Parameters are a different matter. A parameter narrows the type: everything true of
   * `text/plain` is true of `text/plain; charset=utf-8`, and anything that is the latter is
   * also the former. So within one type/subtype, the media type with fewer parameters subsumes
   * the one that adds to them, provided they agree on the parameters they share.
   *
   * That reasoning only holds for parameters the server understands - see
   * UNDERSTOOD_PARAMETERS. Where the two codes differ in a parameter it does not, the
   * relationship cannot be determined and this throws rather than guessing.
   *
   * @param {string|MimeTypeConcept} codeA
   * @param {string|MimeTypeConcept} codeB
   * @returns {string} equivalent, subsumes, subsumed-by or not-subsumed
   * @throws {Error} cannot-determine, when an unknown parameter is what differs
   */
  async subsumesTest(codeA, codeB) {
    const a = (await this.#ensureContext(codeA)).mimeType;
    const b = (await this.#ensureContext(codeB)).mimeType;

    if (a.type !== b.type || a.subtype !== b.subtype) {
      // Decidable whatever the parameters say: no parameter makes one type a kind of
      // another, so an unknown one cannot change this answer.
      return 'not-subsumed';
    }

    // Where the registration gives a parameter a default, the bare form already carries that
    // value, so fill it in on both sides before comparing anything. After this, a parameter
    // that defaults is present on both sides and the narrowing logic below never sees it as
    // "added" - which is the point: adding format=flowed to text/plain does not narrow it, it
    // contradicts the format=fixed the bare form meant all along.
    const key = a.type + '/' + a.subtype;
    const defaults = PARAMETER_DEFAULTS.get(key);
    const aParams = new Map(a.params);
    const bParams = new Map(b.params);
    if (defaults) {
      for (const [name, value] of defaults) {
        if (!aParams.has(name)) aParams.set(name, value);
        if (!bParams.has(name)) bParams.set(name, value);
      }
    }

    // Only the parameters the two codes DISAGREE on can decide the answer - one present
    // on one side only, or present on both with different values. A parameter carried
    // identically by both, understood or not, cannot affect the result and is ignored.
    const deciding = [...new Set([...aParams.keys(), ...bParams.keys()])]
      .filter(name => aParams.get(name) !== bParams.get(name));
    const unknown = deciding.filter(name => !UNDERSTOOD_PARAMETERS.has(name));
    if (unknown.length > 0) {
      throw cannotDetermineSubsumption(
        `Unable to determine the subsumption relationship between '${a.source}' and `
        + `'${b.source}': they differ in the parameter${unknown.length > 1 ? 's' : ''} `
        + unknown.map(n => `'${n}'`).join(', ')
        + ', which this server does not know the meaning of. Whether such a parameter narrows '
        + 'the media type, and whether two of its values exclude one another, depends on the '
        + 'definition of that particular parameter, so no outcome is returned rather than one '
        + 'that may be wrong');
    }

    // RFC 6657 section 3: a text/* registration that does not say how the charset is determined
    // still defaults to US-ASCII. So on a text/* type we have not read, we do not know whether
    // the side without a charset means "any charset" or "US-ASCII", and that is exactly the
    // difference between subsumes and not-subsumed. Only bites when charset is present on one
    // side and absent on the other - two explicit values are just two values.
    if (deciding.includes('charset') && a.type === 'text'
        && !(defaults && defaults.has('charset'))
        && !TEXT_TYPES_WITH_NO_CHARSET_DEFAULT.has(key)
        && aParams.has('charset') !== bParams.has('charset')) {
      throw cannotDetermineSubsumption(
        `Unable to determine the subsumption relationship between '${a.source}' and `
        + `'${b.source}': one carries a charset and the other does not, and this server does `
        + `not know whether '${key}' gives charset a default value. RFC 6657 leaves every `
        + 'text/* registration that does not say how the charset is determined defaulting to '
        + 'US-ASCII, so the absence of a charset may mean "any charset" or may mean "US-ASCII", '
        + 'and those give opposite answers. No outcome is returned rather than one that may be '
        + 'wrong');
    }

    // Any parameter they both carry has to agree, or neither includes the other
    for (const [name, value] of aParams) {
      if (bParams.has(name) && bParams.get(name) !== value) {
        return 'not-subsumed';
      }
    }

    const aInB = [...aParams.keys()].every(name => bParams.has(name));
    const bInA = [...bParams.keys()].every(name => aParams.has(name));

    if (aInB && bInA) {
      return 'equivalent';
    }
    if (aInB) {
      return 'subsumes';
    }
    if (bInA) {
      return 'subsumed-by';
    }
    return 'not-subsumed';
  }

  // ========== Filter Methods ==========

  /**
   * `base` takes either `type` or `type/subtype` and tests that a code is consistent with it,
   * ignoring any parameters the code carries. Media types cannot be enumerated, so this filter
   * can only ever be tested against a code, never expanded.
   */
  async doesFilter(prop, op, value) {
    assert(prop != null && typeof prop === 'string', 'prop must be a non-null string');
    assert(op != null && typeof op === 'string', 'op must be a non-null string');
    assert(value != null && typeof value === 'string', 'value must be a non-null string');

    return (prop === 'base' || prop === 'registered') && op === '=';
  }

  /**
   * Parse a `base` filter value. Wildcards are refused rather than quietly matching nothing:
   * `text/*` is Accept-header range syntax, not a media type, and the server takes no position
   * on it - see subsumesTest
   * @param {string} value
   * @returns {MimeTypeFilter}
   */
  #parseBase(value) {
    const trimmed = (value || '').trim();
    if (!trimmed) {
      throw new Error('The base filter needs a value of the form "type" or "type/subtype"');
    }
    if (trimmed.includes(';')) {
      throw new Error(`Invalid base filter '${value}': a base is a type or type/subtype, and carries no parameters`);
    }
    if (trimmed.includes('*')) {
      throw new Error(`Invalid base filter '${value}': wildcards are not supported`);
    }
    const parts = trimmed.split('/');
    if (parts.length > 2 || parts.some(p => !p.trim())) {
      throw new Error(`Invalid base filter '${value}': expected "type" or "type/subtype"`);
    }
    return new MimeTypeFilter(parts[0].trim().toLowerCase(),
      parts.length === 2 ? parts[1].trim().toLowerCase() : null);
  }

  async filter(filterContext, forIteration, prop, op, value) {
    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    assert(prop != null && typeof prop === 'string', 'prop must be a non-null string');
    assert(op != null && typeof op === 'string', 'op must be a non-null string');
    assert(value != null && typeof value === 'string', 'value must be a non-null string');

    if (prop !== 'base' && prop !== 'registered') {
      throw new Error(`Unsupported filter property: ${prop}`);
    }
    if (op !== '=') {
      throw new Error(`Unsupported filter operator for ${prop}: ${op}`);
    }
    // forIteration marks the filter the expander will walk; any others are only ever used as
    // predicates over what that one produces, and those do not have to be enumerable
    const set = prop === 'base' ? this.#parseBase(value) : this.#parseRegistered(value);

    // `registered = true` is the one filter here that can be iterated: the registry is a finite
    // list, and we have it. The expansion is still incomplete, because every registered type also
    // has unboundedly many parameterised forms that belong to the value set - filtersNotClosed()
    // says so, and the expander marks the expansion unclosed. Nothing else can be enumerated:
    // `registered = false` is everything IANA has not registered, and a `base` covers every
    // parameterisation of a type, both of them infinite.
    if (forIteration) {
      if (set instanceof MimeTypeRegisteredFilter && set.registered) {
        set.codes = [...this.registeredTypes].sort();
      } else {
        throw new Issue('error', 'not-supported', null, 'CODESYSTEM_NOT_ENUMERABLE',
          this.opContext.i18n.translate('CODESYSTEM_NOT_ENUMERABLE', this.opContext.langs, [this.system()]),
          null, 422);
      }
    }

    filterContext.filters.push(set);
  }

  /**
   * Parse a `registered` filter value. This is where the absence of the IANA registry is
   * reported: the server has no way to answer the question, and saying 'not registered' to
   * everything would be a confident wrong answer rather than a missing one
   * @param {string} value - true or false
   * @returns {MimeTypeRegisteredFilter}
   */
  #parseRegistered(value) {
    const trimmed = (value || '').trim().toLowerCase();
    if (trimmed !== 'true' && trimmed !== 'false') {
      throw new Error(`Invalid registered filter '${value}': the value must be true or false`);
    }
    if (!this.registeredTypes) {
      throw new Error('The registered filter cannot be used: no copy of the IANA media types '
        + 'registry is available (it could not be downloaded, and none is cached)');
    }
    return new MimeTypeRegisteredFilter(trimmed === 'true');
  }

  /**
   * Is a parsed media type in the IANA registry? Parameters are irrelevant - it is the
   * type/subtype that is registered
   * @param {Object} mimeType - the parsed mimeType of a MimeTypeConcept
   * @returns {boolean}
   */
  #isRegistered(mimeType) {
    return this.registeredTypes.has(mimeType.type + '/' + mimeType.subtype);
  }

  async executeFilters(filterContext) {
    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    return filterContext.filters;
  }

  async filtersNotClosed(filterContext) {
    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    return true; // every type/subtype has unboundedly many parameterised forms
  }

  async filterSize(filterContext, set) {
    assert(set && this.#isFilterSet(set), 'set must be a mime type filter');
    if (set.codes) {
      return set.codes.length;
    }
    throw new Error('Mime types cannot be enumerated, so this filter has no size');
  }

  async filterMore(filterContext, set) {
    assert(set && this.#isFilterSet(set), 'set must be a mime type filter');
    if (!set.codes) {
      // Returning false here would hand back an empty expansion, which reads as "there are no
      // such media types" rather than "this cannot be enumerated"
      if (filterContext.forIterate) {
        throw new Error('Mime types cannot be enumerated, so this filter cannot be walked');
      }
      return false;
    }
    set.cursor++;
    return set.cursor < set.codes.length;
  }

  async filterConcept(filterContext, set) {
    assert(set && this.#isFilterSet(set), 'set must be a mime type filter');
    if (set.codes) {
      return new MimeTypeConcept(set.codes[set.cursor]);
    }
    throw new Error('Mime types cannot be enumerated, so this filter has no concepts to walk');
  }

  async filterLocate(filterContext, set, code) {
    assert(set && this.#isFilterSet(set), 'set must be a mime type filter');
    assert(typeof code === 'string', 'code must be a non-null string');

    const found = await this.locate(code);
    if (!found.context) {
      return found.message ? found.message : `Invalid mime type '${code}'`;
    }
    if (!this.#matches(set, found.context.mimeType)) {
      return set.rejection(code);
    }
    return found.context;
  }

  async filterCheck(filterContext, set, concept) {
    assert(set && this.#isFilterSet(set), 'set must be a mime type filter');

    const ctxt = await this.#ensureContext(concept);
    return this.#matches(set, ctxt.mimeType);
  }

  #isFilterSet(set) {
    return set instanceof MimeTypeFilter || set instanceof MimeTypeRegisteredFilter;
  }

  #matches(set, mimeType) {
    if (set instanceof MimeTypeFilter) {
      return set.matches(mimeType);
    }
    return this.#isRegistered(mimeType) === set.registered;
  }

  async locateIsA(code, parent) {
    await this.#ensureContext(code);
    await this.#ensureContext(parent);
    return { context: null, message: 'Subsumption not supported for MIME types' };
  }

  versionAlgorithm() {
    return null;
  }

  isNotClosed() {
    return true;
  }

  canBeExpanded() {
    return false; // MIME types cannot be iterated / enumerated
  }

}

class MimeTypeServicesFactory extends CodeSystemFactoryProvider {
  /**
   * @param {I18nSupport} i18n
   * @param {string} cacheFolder - where the downloaded copy of the IANA registry is kept
   * @param {Logger} log
   */
  constructor(i18n, cacheFolder = null, log = null) {
    super(i18n);
    this.uses = 0;
    this.cacheFolder = cacheFolder;
    this.log = log;
    this.registeredTypes = null;
  }

  /**
   * Try to refresh the IANA media types registry, then load whatever copy we have. A failed
   * download is not fatal - an older cached copy still answers the question - but if there is
   * no copy at all the `registered` filter reports that rather than guessing (see
   * MimeTypeServices#parseRegistered).
   */
  async load() {
    if (!this.cacheFolder) {
      return; // no cache configured: the registered filter is unavailable
    }
    const target = path.join(this.cacheFolder, IANA_MEDIA_TYPES_FILE);
    await this.#refresh(target);

    if (fs.existsSync(target)) {
      try {
        this.registeredTypes = MimeTypeServicesFactory.parseRegistry(fs.readFileSync(target, 'utf8'));
        this.log?.info(`Mime types: ${this.registeredTypes.size} registered media types`);
      } catch (e) {
        this.log?.warn(`Mime types: could not read the IANA registry at ${target}: ${e.message}`);
        this.registeredTypes = null;
      }
    } else {
      this.log?.warn('Mime types: no copy of the IANA media types registry; the registered filter will not be available');
    }
  }

  /**
   * Download the registry over the top of the cached copy. Writes to a temporary file and
   * renames, so a download that fails part way through cannot leave a truncated registry
   * behind - which would look like a valid but much smaller registry.
   * @param {string} target
   */
  async #refresh(target) {
    const temp = target + '.tmp';
    try {
      if (!fs.existsSync(this.cacheFolder)) {
        fs.mkdirSync(this.cacheFolder, { recursive: true });
      }
      const response = await axios.get(IANA_MEDIA_TYPES_URL, {
        timeout: IANA_DOWNLOAD_TIMEOUT,
        responseType: 'text',
        transformResponse: [d => d]
      });
      // Check it parses before it replaces a copy that is known to work
      const names = MimeTypeServicesFactory.parseRegistry(response.data);
      fs.writeFileSync(temp, response.data, 'utf8');
      fs.renameSync(temp, target);
      this.log?.info(`Mime types: downloaded the IANA registry (${names.size} media types)`);
    } catch (e) {
      if (fs.existsSync(temp)) {
        try { fs.unlinkSync(temp); } catch { /* nothing useful to do */ }
      }
      this.log?.warn(`Mime types: could not download the IANA registry (${e.message}); using the cached copy if there is one`);
    }
  }

  /**
   * Pull the media type names out of the IANA registry document. The document is a registry of
   * registries: the outer one is `media-types`, and each inner one is a type (application,
   * text, ...) whose records are its subtypes. A record's `file` element carries the full
   * type/subtype; where it is missing the registry id and the record name give the same thing.
   *
   * Names in the registry sometimes carry annotations - "example (OBSOLETE)" and the like - so
   * anything after the first whitespace is dropped.
   *
   * @param {string} xml
   * @returns {Set<string>} lower-cased type/subtype names
   * @throws if the document yields no names at all, which means it is not the registry
   */
  static parseRegistry(xml) {
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', trimValues: true });
    const doc = parser.parse(xml);
    const root = doc.registry;
    if (!root) {
      throw new Error('not an IANA registry document (no registry element)');
    }
    const names = new Set();
    const registries = Array.isArray(root.registry) ? root.registry : (root.registry ? [root.registry] : []);
    for (const registry of registries) {
      const type = String(registry['@_id'] || '').trim().toLowerCase();
      const records = Array.isArray(registry.record) ? registry.record : (registry.record ? [registry.record] : []);
      for (const record of records) {
        let name = null;
        if (record.file) {
          const file = typeof record.file === 'object' ? record.file['#text'] : record.file;
          if (file) {
            name = String(file);
          }
        }
        if (!name && record.name && type) {
          name = type + '/' + String(typeof record.name === 'object' ? record.name['#text'] : record.name);
        }
        if (name) {
          name = name.trim().split(/\s/)[0].toLowerCase();
          if (name.includes('/')) {
            names.add(name);
          }
        }
      }
    }
    if (names.size === 0) {
      throw new Error('no media types found - this does not look like the IANA registry');
    }
    return names;
  }

  defaultVersion() {
    return null;
  }

  system() {
    return 'urn:ietf:bcp:13'; // BCP 13 defines MIME types
  }

  version() {
    return null;
  }

  // eslint-disable-next-line no-unused-vars
  async buildKnownValueSet(url, version) {
    return null;
  }

  build(opContext, supplements) {
    this.uses++;
    return new MimeTypeServices(opContext, supplements, this.registeredTypes);
  }

  useCount() {
    return this.uses;
  }

  recordUse() {
    this.uses++;
  }
  name() {
    return 'Mime Types';
  }


  id() {
    return "mimetypes";
  }
}

module.exports = {
  MimeTypeFilter,
  MimeTypeServices,
  MimeTypeServicesFactory,
  MimeTypeConcept
};