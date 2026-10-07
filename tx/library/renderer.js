const {CodeSystemProvider} = require("../cs/cs-api");
const {Extensions} = require("./extensions");
const {div} = require("../../library/html");
const {getValuePrimitive} = require("../../library/utilities");
const {getValueName} = require("../../library/utilities");
const {InvalidError} = require("./errors");

// Valid FHIR value sets used when validating values before rendering, so that
// illegal input produces an error that names the offending value rather than
// being silently rendered or causing a generic crash downstream.
const VALID_FILTER_OPS = new Set([
  '=', 'is-a', 'descendent-of', 'is-not-a', 'regex', 'in', 'not-in',
  'generalizes', 'child-of', 'descendent-leaf', 'exists'
]);
const VALID_CONCEPTMAP_RELATIONSHIPS = new Set([
  'related-to', 'equivalent', 'source-is-narrower-than-target',
  'source-is-broader-than-target', 'not-related-to'
]);
const VALID_CONCEPTMAP_EQUIVALENCES = new Set([
  'relatedto', 'equivalent', 'equal', 'wider', 'subsumes', 'narrower',
  'specializes', 'inexact', 'unmatched', 'disjoint'
]);
const VALID_CODESYSTEM_CONTENT = new Set([
  'not-present', 'example', 'fragment', 'complete', 'supplement'
]);
const VALID_PUBLICATION_STATUS = new Set(['draft', 'active', 'retired', 'unknown']);

/**
 * @typedef {Object} TerminologyLinkResolver
 * @property {function(OperationContext, string, string=): {description: string, link: string}|null} resolveURL
 *   Given a URL and optional version, returns description and link, or null if not found
 * @property {function(OperationContext, string, string, string=): {display: string, link: string}|null} resolveCode
 *   Given a URL, code, and optional version, returns display and link, or null if not found
 */

class Renderer {

  constructor(opContext, linkResolver = null) {
    this.opContext = opContext;
    this.linkResolver = linkResolver;
  }

  displayCoded(...args) {
    if (args.length === 1) {
      const arg = args[0];
      if (arg instanceof CodeSystemProvider) {
        return arg.system() + "|" + arg.version();
      } else  if (arg.system !== undefined && arg.version !== undefined && arg.code !== undefined && arg.display !== undefined) {
        // It's a Coding
        return this.displayCodedCoding(arg);
      } else if (arg.coding !== undefined || arg.text) {
        // It's a CodeableConcept
        return this.displayCodedCodeableConcept(arg);
      } else if (arg.system !== undefined && arg.version !== undefined) {
        // It's a CodeSystemProvider
        return this.displayCodedProvider(arg);
      }
    } else if (args.length === 2) {
      return this.displayCodedSystemVersion(args[0], args[1]);
    } else if (args.length === 3) {
      return this.displayCodedSystemVersionCode(args[0], args[1], args[2]);
    } else if (args.length === 4) {
      return this.displayCodedSystemVersionCodeDisplay(args[0], args[1], args[2], args[3]);
    }
    throw new Error('Invalid arguments to renderCoded');
  }

  displayCodedProvider(system) {
    let result = system.system + '|' + system.version;
    if (system.sourcePackage) {
      result = result + ' (from ' + system.sourcePackage + ')';
    }
    return result;
  }

  displayCodedSystemVersion(system, version) {
    if (!version) {
      return system;
    } else {
      return system + '|' + version;
    }
  }

  displayCodedSystemVersionCode(system, version, code) {
    return this.displayCodedSystemVersion(system, version) + '#' + code;
  }

  displayCodedSystemVersionCodeDisplay(system, version, code, display) {
    return this.displayCodedSystemVersionCode(system, version, code) + ' ("' + display + '")';
  }

  displayCodedCoding(code) {
    return this.displayCodedSystemVersionCodeDisplay(code.system, code.version, code.code, code.display);
  }

  displayCodedCodeableConcept(code) {
    let result = '';
    if (code.text && !code.coding) {
      result = '"'+code.text+'"';
    } else {
      for (const c of code.coding || []) {
        if (result) {
          result = result + ', ';
        }
        result = result + this.displayCodedCoding(c);
      }
    }
    return '[' + result + ']';
  }

  displayValueSetInclude(inc) {
    let result;
    if (inc.system) {
      result = '(' + inc.system + ')';
      if (inc.concept) {
        result = result + '(';
        let first = true;
        for (const cc of inc.concept) {
          if (first) {
            first = false;
          } else {
            result = result + ',';
          }
          result = result + cc.code;
        }
        result = result + ')';
      }
      if (inc.filter) {
        result = result + '(';
        let first = true;
        for (const ci of inc.filter) {
          if (first) {
            first = false;
          } else {
            result = result + ',';
          }
          result = result + ci.property + ci.op + ci.value;
        }
        result = result + ')';
      }
    } else {
      result = '(';
      let first = true;
      for (const s of inc.valueSet || []) {
        if (first) {
          first = false;
        } else {
          result = result + ',';
        }
        result = result + '^' + s;
      }
      result = result + ')';
    }
    return result;
  }

  async renderMetadataTable(res, tbl, sourcePackage) {
    this.renderMetadataVersion(res, tbl);
    await this.renderMetadataProfiles(res, tbl);
    await this.renderMetadataTags(res, tbl);
    await this.renderMetadataLabels(res, tbl);
    this.renderMetadataLastUpdated(res, tbl);
    this.renderMetadataSource(res, tbl);
    this.renderProperty(tbl, 'TEST_PLAN_LANG', res.language);
    this.renderPropertyCopy(tbl, 'GENERAL_DEFINING_URL', res.url);
    this.renderPropertyCopy(tbl, 'GENERAL_VER', res.version);
    this.renderProperty(tbl, 'GENERAL_NAME', res.name);
    this.renderProperty(tbl, 'GENERAL_TITLE', res.title);
    this.renderProperty(tbl, 'GENERAL_STATUS', res.status);
    this.renderPropertyMD(tbl, 'GENERAL_DEFINITION', res.description);
    this.renderPropertyMD(tbl, 'GENERAL_PURPOSE', res.purpose);
    this.renderProperty(tbl, 'CANON_REND_PUBLISHER', res.publisher);
    this.renderProperty(tbl, 'CANON_REND_COMMITTEE', Extensions.readString(res, 'http://hl7.org/fhir/StructureDefinition/structuredefinition-wg'));
    this.renderPropertyCopy(tbl, 'GENERAL_COPYRIGHT', res.copyright);
    this.renderProperty(tbl, 'EXT_FMM_LEVEL', Extensions.readString(res, 'http://hl7.org/fhir/StructureDefinition/structuredefinition-fmm'));
    this.renderProperty(tbl, 'EXT_STANDARDS_STATUS', Extensions.readString(res, 'http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status'));
    this.renderProperty(tbl, 'PAT_PERIOD', res.effectivePeriod);
    this.renderPropertyLink(tbl, 'WEB_SOURCE', Extensions.readString(res, 'http://hl7.org/fhir/StructureDefinition/web-source'));
    this.renderProperty(tbl, 'GENERAL_SOURCE', sourcePackage);
    for (let ext of Extensions.list(res, 'http://hl7.org/fhir/uv/application-feature/StructureDefinition/feature')) {
      this.renderProperty(tbl, 'FEATURE', this.featureSummary(ext));
    }


    // capability statement things
    this.renderProperty(tbl, 'Kind', res.kind);
    if (res.software?.name) {
      let s = res.software.name;
      if (res.software.version) {
        s = s+" v"+res.software.version;
        this.renderProperty(tbl, 'Software', s);
      }
    }
    this.renderProperty(tbl, 'GENERAL_URL', res.implementation?.url);
    this.renderProperty(tbl, 'EX_SCEN_FVER', res.fhirVersion);

    if (res.content === 'supplement' && res.supplements) {
      const tr = tbl.tr();
      tr.td().b().tx(this.translate('CODESYSTEM_SUPPLEMENTS'));
      await this.renderLink(tr.td(), res.supplements);
    }

    if (res.valueSet) {
      const tr = tbl.tr();
      tr.td().b().tx(this.translate('GENERAL_VALUESET'));
      await this.renderLink(tr.td(), res.valueSet);
    }
  }

  async renderMetadataProfiles(res, tbl) {
    if (res.meta?.profile) {
      let tr = tbl.tr();
      tr.td().b().tx(this.translate('GENERAL_PROF'));
      if (res.meta.profile.length > 1) {
        let ul = tr.td();
        for (let u of res.meta.profile) {
          await this.renderLink(ul.li(), u);
        }
      } else {
        await this.renderLink(tr.td(), res.meta.profile[0]);
      }
    }
  }

  async renderMetadataTags(res, tbl) {
    if (res.meta?.tag) {
      let tr = tbl.tr();
      tr.td().b().tx(this.translate('GENERAL_PROF'));
      if (res.meta.tag.length > 1) {
        let ul = tr.td();
        for (let u of res.meta.tag) {
          await this.renderCoding(ul.li(), u);
        }
      } else {
        await this.renderCoding(tr.td(), res.meta.tag[0]);
      }
    }
  }

  async renderMetadataLabels(res, tbl) {
    if (res.meta?.label) {
      let tr = tbl.tr();
      tr.td().b().tx(this.translate('GENERAL_PROF'));
      if (res.meta.label.length > 1) {
        let ul = tr.td();
        for (let u of res.meta.label) {
          await this.renderCoding(ul.li(), u);
        }
      } else {
        await this.renderCoding(tr.td(), res.meta.label[0]);
      }
    }
  }

  // Inline phrases inherited from the Java core translations (RES_REND_VER = "version: {0}"
  // etc) are not table labels; when rendering into a name/value table we use the dedicated
  // *_NAME / *_VALUE phrases instead, and leave the inline phrases to the Java code.

  renderMetadataVersion(res, tbl) {
    if (res.meta?.version) {
      let tr = tbl.tr();
      tr.td().b().tx(this.translate('RES_REND_VER_NAME'));
      tr.td().tx(this.translate('RES_REND_VER_VALUE', [res.meta.version]));
    }
  }

  renderMetadataLastUpdated(res, tbl) {
    if (res.meta?.lastUpdated) {
      this._requireValidDate(res.meta.lastUpdated, 'meta.lastUpdated');
      let tr = tbl.tr();
      tr.td().b().tx(this.translate('RES_REND_UPDATED_NAME'));
      tr.td().tx(this.translate('RES_REND_UPDATED_VALUE', [this.displayDate(res.meta.lastUpdated)]));
    }
  }

  renderProperty(tbl, msgId, value) {
    if (value) {
      let tr = tbl.tr();
      tr.td().b().tx(this.translate(msgId));
      if (value instanceof Object) {
        tr.td().tx("todo");
      } else {
        tr.td().tx(value);
      }
    }
  }

  renderPropertyCopy(tbl, msgId, value) {
    if (value) {
      let tr = tbl.tr();
      tr.td().b().tx(this.translate(msgId));
      if (value instanceof Object) {
        tr.td().tx("todo");
      } else {
        let td = tr.td();
        let span = td.span("copy-text");
        span.tx(value);
        let btn = span.button();
        btn.attr("class", "btn-copy");
        btn.attr("data-clipboard-text", value);
        btn.attr("data-original-title", this.translate('GENERAL_COPY'));
      }
    }
  }

  renderPropertyLink(tbl, msgId, value) {
    if (value) {
      let tr = tbl.tr();
      tr.td().b().tx(this.translate(msgId));
      if (value instanceof Object) {
        tr.td().tx("todo");
      } else {
        tr.td().ah(value).tx(value);
      }
    }
  }

  renderPropertyMD(tbl, msgId, value) {
    if (value) {
      let tr = tbl.tr();
      tr.td().b().tx(this.translate(msgId));
      if (value instanceof Object) {
        tr.td().tx("todo");
      } else {
        tr.td().markdown(value);
      }
    }
  }

  renderMetadataSource(res, tbl) {
    if (res.meta?.source) {
      let tr = tbl.tr();
      tr.td().b().tx(this.translate('RES_REND_INFO_SOURCE_NAME'));
      tr.td().tx(this.translate('RES_REND_INFO_SOURCE_VALUE', [res.meta.source]));
    }
  }

  async renderLink(x, uri) {
    const result = this.linkResolver ? await this.linkResolver.resolveURL(this.opContext, uri) : null;
    if (result) {
      x.ah(result.link).tx(result.description);
    } else {
      x.code().tx(uri);
    }
  }

  async renderLinkComma(x, uri) {
    let {description, link} = await (this.linkResolver ? this.linkResolver.resolveURL(this.opContext, uri) : null) || {};
    if (link) {
      x.commaItem(description, link);
    } else {
      x.commaItem(link);
    }
  }


  async renderCoding(x, coding) {
    if (coding === null || coding === undefined || typeof coding !== 'object') {
      this._invalid('Coding', coding, 'invalid Coding');
    }
    if (coding.code !== undefined && coding.code !== null &&
        (typeof coding.code !== 'string' || coding.code.trim() === '')) {
      this._invalid('Coding.code', coding.code, 'invalid code');
    }
    let {
      desc,
      url
    } = (this.linkResolver ? await this.linkResolver.resolveCode(this.opContext, coding.system, coding.version, coding.code) : null) || {};
    if (url) {
      x.ah(url).tx(desc);
    } else {
      x.code(coding.code);
    }
  }

  translate(msgId, params = []) {
    return this.opContext.i18n.formatPhrase(msgId, this.opContext.langs, params);
  }

  translatePlural(num, msgId) {
    return this.opContext.i18n.formatPhrasePlural(msgId, this.opContext.langs, num,[]);
  }

  /**
   * Determine the BCP-47 locale to use for formatting, derived from the user's
   * requested languages (parsed from the Accept-Language header). The region
   * subtag (e.g. US vs GB) is what selects day/month ordering and month names.
   * Falls back to 'en-US' when no usable language is available.
   * @returns {string} a BCP-47 locale tag accepted by Intl
   * @private
   */
  _formatLocale() {
    const langs = this.opContext && this.opContext.langs;
    if (langs) {
      for (const lang of langs) {
        if (lang.language && lang.language !== '*') {
          let tag = lang.language;
          if (lang.script) tag += '-' + lang.script;
          if (lang.region) tag += '-' + lang.region;
          try {
            if (Intl.DateTimeFormat.supportedLocalesOf(tag).length > 0) {
              return tag;
            }
            // Locale is structurally valid but not supported by the runtime;
            // Intl will still resolve it to a sensible fallback, so use it.
            return tag;
          } catch (_) {
            // Structurally invalid tag — skip and try the next language.
          }
        }
      }
    }
    return 'en-US';
  }

  // ── Validation helpers ──────────────────────────────────────────────────────
  // These exist so that illegal input is reported with an error that names the
  // offending field and value, rather than being silently rendered or causing a
  // generic "Cannot read properties of null" style crash further down.

  /**
   * Render a value for inclusion in an error message, distinguishing null,
   * undefined, objects, and primitives, and truncating long values.
   * @private
   */
  _showValue(value) {
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    if (typeof value === 'object') {
      let s;
      try { s = JSON.stringify(value); } catch (_) { s = Object.prototype.toString.call(value); }
      return s.length > 80 ? s.slice(0, 77) + '...' : s;
    }
    const s = String(value);
    return `'${s.length > 80 ? s.slice(0, 77) + '...' : s}'`;
  }

  /**
   * Throw an InvalidError that identifies the offending value and its location.
   * @param {string} path - dotted path to the offending element (e.g. "ConceptMap.group[0].target[0].relationship")
   * @param {*} value - the offending value
   * @param {string} what - short description of what is wrong (e.g. "invalid ConceptMap relationship")
   * @private
   */
  _invalid(path, value, what) {
    throw new InvalidError(`${what} at ${path}: ${this._showValue(value)}`);
  }

  /**
   * Validate, unwrap, and type-check a resource before rendering. Accepts either
   * a raw resource object or a wrapper exposing `.json`. Throws an InvalidError
   * naming the problem when the input is missing, not an object, or of the wrong
   * resourceType.
   * @param {*} res - the resource (or wrapper) to render
   * @param {string} expectedType - the FHIR resourceType this method renders
   * @param {string} method - the calling method name, for the error message
   * @returns {object} the unwrapped resource object
   * @private
   */
  _resolveResource(res, expectedType, method) {
    if (res === null || res === undefined) {
      throw new InvalidError(`${method}: no resource supplied (got ${res === null ? 'null' : 'undefined'})`);
    }
    if (typeof res !== 'object' || Array.isArray(res)) {
      throw new InvalidError(`${method}: expected a ${expectedType} resource object but got ${Array.isArray(res) ? 'an array' : typeof res}`);
    }
    const r = (res.json !== undefined && res.json !== null) ? res.json : res;
    if (r === null || typeof r !== 'object' || Array.isArray(r)) {
      throw new InvalidError(`${method}: expected a ${expectedType} resource object but got ${this._showValue(r)}`);
    }
    if (r.resourceType !== undefined && r.resourceType !== expectedType) {
      throw new InvalidError(`${method}: expected resourceType '${expectedType}' but found ${this._showValue(r.resourceType)}`);
    }
    return r;
  }

  /**
   * True when `value` is a syntactically valid FHIR date/dateTime/instant.
   * Used both to validate (via _requireValidDate) and to drive display.
   * @private
   */
  _isValidFhirDate(value) {
    if (typeof value !== 'string') return false;
    if (/^\d{4}$/.test(value)) return true;

    let m = /^(\d{4})-(\d{2})$/.exec(value);
    if (m) {
      const y = Number(m[1]), mo = Number(m[2]);
      const d = new Date(Date.UTC(y, mo - 1, 1));
      return !isNaN(d.getTime()) && d.getUTCFullYear() === y && d.getUTCMonth() === mo - 1;
    }

    m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (m) {
      const y = Number(m[1]), mo = Number(m[2]), da = Number(m[3]);
      const d = new Date(Date.UTC(y, mo - 1, da));
      return !isNaN(d.getTime()) && d.getUTCFullYear() === y &&
             d.getUTCMonth() === mo - 1 && d.getUTCDate() === da;
    }

    if (value.includes('T')) {
      const dt = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
      if (!dt) return false;
      if (isNaN(new Date(value).getTime())) return false;
      const mo = Number(dt[2]), da = Number(dt[3]), hh = Number(dt[4]), mi = Number(dt[5]), ss = Number(dt[6]);
      return mo >= 1 && mo <= 12 && da >= 1 && da <= 31 && hh <= 23 && mi <= 59 && ss <= 60;
    }
    return false;
  }

  /**
   * Require a value (when present) to be a valid FHIR date; otherwise throw an
   * error naming the field and value. Empty/absent values are allowed and
   * returned unchanged.
   * @private
   */
  _requireValidDate(value, path) {
    if (value === null || value === undefined || value === '') return value;
    if (!this._isValidFhirDate(value)) {
      this._invalid(path, value, 'invalid date');
    }
    return value;
  }

  /**
   * Require a value to be a non-empty string code; otherwise throw an error
   * naming the field and value.
   * @private
   */
  _requireValidCode(value, path) {
    if (typeof value !== 'string' || value.trim() === '') {
      this._invalid(path, value, 'invalid code');
    }
    return value;
  }

  /**
   * Require a value (when present) to be a member of an allowed set; otherwise
   * throw an error naming the field and value.
   * @private
   */
  _requireAllowed(value, allowed, path, what) {
    if (value === null || value === undefined) return value;
    if (!allowed.has(value)) {
      this._invalid(path, value, what);
    }
    return value;
  }

  /**
   * Format a FHIR date / dateTime / instant value into a human-readable string
   * using the user's locale. The output precision follows the input precision:
   * a year stays a year, a year-month becomes "Month Year", a full date becomes
   * a localised date, and a dateTime/instant becomes a localised date and time.
   *
   * Unparseable values are returned unchanged so the renderer never throws on
   * unexpected input.
   *
   * @param {string} value - a FHIR date, dateTime, or instant (e.g. "2024",
   *   "2024-03", "2024-03-15", "2024-03-15T10:30:00Z")
   * @returns {string} the localised representation, or '' for empty input
   */
  displayDate(value) {
    if (value === null || value === undefined || value === '') {
      return '';
    }
    if (typeof value !== 'string') {
      value = String(value);
    }

    const locale = this._formatLocale();

    // Year only — nothing to localise.
    if (/^\d{4}$/.test(value)) {
      return value;
    }

    // Year-month → "Month Year".
    let m = /^(\d{4})-(\d{2})$/.exec(value);
    if (m) {
      const year = Number(m[1]), month = Number(m[2]);
      const d = new Date(Date.UTC(year, month - 1, 1));
      // Reject values that Date silently rolled over (e.g. month 13).
      if (isNaN(d.getTime()) || d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1) {
        return value;
      }
      return new Intl.DateTimeFormat(locale, {
        year: 'numeric', month: 'long', timeZone: 'UTC'
      }).format(d);
    }

    // Full date → localised date.
    m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (m) {
      const year = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
      const d = new Date(Date.UTC(year, month - 1, day));
      // Reject values that Date silently rolled over (e.g. 2024-02-30).
      if (isNaN(d.getTime()) || d.getUTCFullYear() !== year ||
          d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
        return value;
      }
      return new Intl.DateTimeFormat(locale, {
        year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC'
      }).format(d);
    }

    // dateTime / instant → localised date and time.
    if (value.includes('T')) {
      const d = new Date(value);
      if (isNaN(d.getTime())) return value;
      const hasTimezone = /(Z|[+-]\d{2}:\d{2})$/.test(value);
      const opts = {
        year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      };
      if (hasTimezone) {
        // We don't know the user's timezone, so render the absolute instant in
        // UTC and label it, rather than silently using the server's zone.
        opts.timeZone = 'UTC';
        opts.timeZoneName = 'short';
      }
      return new Intl.DateTimeFormat(locale, opts).format(d);
    }

    // Unrecognised format — return unchanged.
    return value;
  }

  async renderValueSet(vs) {
    vs = this._resolveResource(vs, 'ValueSet', 'renderValueSet');
    this._requireAllowed(vs.status, VALID_PUBLICATION_STATUS, 'ValueSet.status', 'invalid status');

    let div_ = div();
    div_.h2().tx("Properties");
    let tbl = div_.table("grid");
    await this.renderMetadataTable(vs, tbl);
    if (vs.compose) {
      div_.h2().tx("Logical Definition");
      await this.renderCompose(vs, div_.table("grid"));
    }
    if (vs.expansion) {
      div_.h2().tx("Expansion");
      await this.renderExpansion(div_, vs, tbl);
    }

    return div_.toString();
  }

  async renderCodeSystem(cs, sourcePackage) {
    cs = this._resolveResource(cs, 'CodeSystem', 'renderCodeSystem');
    this._requireAllowed(cs.status, VALID_PUBLICATION_STATUS, 'CodeSystem.status', 'invalid status');
    this._requireAllowed(cs.content, VALID_CODESYSTEM_CONTENT, 'CodeSystem.content', 'invalid CodeSystem content');

    let div_ = div();

    // Metadata table
    div_.h3().tx("Properties");
    await this.renderMetadataTable(cs, div_.table("grid"), sourcePackage);

    // Code system properties
    const hasProps = await this.generateProperties(div_, cs);

    // Filters
    this.generateFilters(div_, cs);

    // Concepts
    await this.generateCodeSystemContent(div_, cs, hasProps);

    return div_.toString();
  }

  async renderCompose(vs, x) {
    let supplements = Extensions.list(vs, 'http://hl7.org/fhir/StructureDefinition/valueset-supplement');
    if (supplements && supplements.length > 0) {
      let p = x.para();
      p.tx(this.translatePlural(supplements.length, 'VALUE_SET_NEEDS_SUPPL'));
      p.tx(" ");
      p.startCommaList("and");
      for (let ext of supplements) {
        await this.renderLinkComma(p, getValuePrimitive(ext));
      }
      p.stopCommaList();
      p.tx(".");
    }
    let parameters = Extensions.list(vs, 'http://hl7.org/fhir/tools/StructureDefinition/valueset-parameter');
    if (parameters && parameters.length > 0) {
      x.para().b().tx("This ValueSet has parameters");
      const tbl = x.table("grid");
      const tr = tbl.tr();
      tr.th().tx("Name");
      tr.th().tx("Documentation");
      for (let ext of parameters) {
        const tr = tbl.tr();
        tr.td().tx(Extensions.readValue(ext, "name"));
        tr.td().markdown(Extensions.readValue(ext, "documentation"));
      }
    }
    let comp = vs.compose;
    if (comp.include) {
      let p = x.para();
      p.tx(this.translatePlural(supplements.length, 'VALUE_SET_RULES_INC'));
      let ul = x.ul();
      for (let inc of comp.include) {
        await this.renderInclude(ul.li(), inc);
      }
    }
    if (comp.exclude) {
      let p = x.para();
      p.tx(this.translatePlural(supplements.length, 'VALUE_SET_RULES_EXC'));
      let ul = x.ul();
      for (let inc of comp.exclude) {
        await this.renderInclude(ul.li(), inc);
      }
    }
  }

  async renderInclude(li, inc) {
    if (inc.system) {
      if (!inc.concept && !inc.filter) {
        li.tx(this.translate('VALUE_SET_ALL_CODES_DEF')+" ");
        await this.renderLink(li,inc.system+(inc.version ? "|"+inc.version : ""));
      } else if (inc.concept) {
        li.tx(this.translate('VALUE_SET_THESE_CODES_DEF')+" ");
        await this.renderLink(li,inc.system+(inc.version ? "|"+inc.version : ""));
        li.tx(":");
        const ul = li.ul();
        for (let c of inc.concept) {
          this._requireValidCode(c.code, 'ValueSet.compose.include.concept.code');
          const li = ul.li();
          const link = this.linkResolver ? await this.linkResolver.resolveCode(this.opContext, inc.system, inc.version, c.code) : null;
          if (link) {
            li.ah(link.link).tx(c.code);
          } else {
            li.tx(c.code);
          }
          if (c.display) {
            li.tx(": "+c.display);
          } else if (link) {
            li.span("opaque: 0.5").tx(": "+link.description);
          }
        }
      } else {
        li.tx(this.translate('VALUE_SET_CODES_FROM')+" ");
        await this.renderLink(li,inc.system+(inc.version ? "|"+inc.version : ""));
        li.tx(" "+ this.translate('VALUE_SET_WHERE')+" ");
        li.startCommaList("and");
        for (let f of inc.filter) {
          let op = this.readFilterOp(f);
          this._requireAllowed(op, VALID_FILTER_OPS, 'ValueSet.compose.include.filter.op', 'invalid filter operator');
          if (op == 'exists') {
            if (f.value == "true") {
              li.commaItem(f.property+" "+ this.translate('VALUE_SET_EXISTS'));
            } else {
              li.commaItem(f.property+" "+ this.translate('VALUE_SET_DOESNT_EXIST'));
            }
          } else {
            li.commaItem(f.property + " " + op + " ");
            const loc = this.linkResolver ? await this.linkResolver.resolveCode(this.opContext, inc.system, inc.version, f.value) : null;
            if (loc) {
              li.ah(loc.link).tx(loc.description);
            } else {
              li.tx(f.value);
            }
          }
        }
        li.stopCommaList();
      }
    } else if (inc.valueSet && inc.valueSet.length > 0) {
      li.tx(this.translatePlural(inc.valueSet.length, 'VALUE_SET_IMPORT')+" ");
      li.startCommaList("and");
      for (let vs of inc.valueSet) {
        await this.renderLinkComma(li, vs);
      }
      li.stopCommaList();
    } else {
      this._invalid('ValueSet.compose.include', inc, 'invalid ValueSet include (must specify a system or at least one valueSet)');
    }
  }

  async generateProperties(x, cs) {
    if (!cs.property || cs.property.length === 0) {
      return false;
    }

    const EXT_PROPERTY_VALUESET = 'http://hl7.org/fhir/StructureDefinition/codesystem-property-valueset';

    // Check what columns we need
    let hasURI = false;
    let hasDescription = false;
    let hasValueSet = false;

    for (const p of cs.property) {
      hasURI = hasURI || !!p.uri;
      hasDescription = hasDescription || !!p.description;
      hasValueSet = hasValueSet || !!Extensions.has(p, EXT_PROPERTY_VALUESET);
    }

    x.para().b().tx(this.translate('GENERAL_PROPS'));
    x.para().tx(this.translate('CODESYSTEM_PROPS_DESC'));

    const tbl = x.table("grid");
    const tr = tbl.tr();
    tr.th().tx(this.translate('GENERAL_CODE'));
    if (hasURI) {
      tr.th().tx(this.translate('GENERAL_URI'));
    }
    tr.th().tx(this.translate('GENERAL_TYPE'));
    if (hasDescription) {
      tr.th().tx(this.translate('GENERAL_DESC'));
    }
    if (hasValueSet) {
      tr.th().tx(this.translate('GENERAL_VALUESET'));
    }

    for (const p of cs.property) {
      const row = tbl.tr();
      row.td().tx(p.code);
      if (hasURI) {
        row.td().tx(p.uri || '');
      }
      row.td().tx(p.type || '');
      if (hasDescription) {
        row.td().tx(p.description || '');
      }
      if (hasValueSet) {
        const td = row.td();
        const vsUrl = Extensions.readString(p, EXT_PROPERTY_VALUESET);
        if (vsUrl) {
          await this.renderLink(td, vsUrl);
        }
      }
    }

    return true;
  }

  generateFilters(x, cs) {
    if (!cs.filter || cs.filter.length === 0) {
      return;
    }

    x.para().b().tx(this.translate('CODESYSTEM_FILTERS'));

    const tbl = x.table("grid");
    const tr = tbl.tr();
    tr.th().tx(this.translate('GENERAL_CODE'));
    tr.th().tx(this.translate('GENERAL_DESC'));
    tr.th().tx(this.translate('CODESYSTEM_FILTER_OP'));
    tr.th().tx(this.translate('GENERAL_VALUE'));

    for (const f of cs.filter) {
      const row = tbl.tr();
      row.td().tx(f.code);
      row.td().tx(f.description || '');
      row.td().tx(f.operator ? f.operator.join(' ') : '');
      row.td().tx(f.value || '');
    }
  }

  async generateCodeSystemContent(x, cs, hasProps) {
    if (hasProps) {
      x.para().b().tx(this.translate('CODESYSTEM_CONCEPTS'));
    }

    const p = x.para();
    p.startScript("csc");
    p.param("cs").code().tx(cs.url);
    this.makeCasedParam(p.param("cased"), cs, cs.caseSensitive);
    this.makeHierarchyParam(p.param("h"), cs, cs.hierarchyMeaning);
    p.paramValue("code-count", this.countConcepts(cs.concept));
    p.execScript(this.sentenceForContent(cs.content, cs));
    p.closeScript();

    if (cs.content === 'not-present') {
      return;
    }

    if (!cs.concept || cs.concept.length === 0) {
      return;
    }

    // Determine table columns needed
    const columnInfo = this.analyzeConceptColumns(cs);

    // Build the concepts table
    const tbl = x.table("codes");

    // Header row
    const headerRow = tbl.tr();
    if (columnInfo.hasHierarchy) {
      headerRow.th().tx(this.translate('CODESYSTEM_LVL'));
    }
    headerRow.th().tx(this.translate('GENERAL_CODE'));
    if (columnInfo.hasDisplay) {
      headerRow.th().tx(this.translate('TX_DISPLAY'));
    }
    if (columnInfo.hasDefinition) {
      headerRow.th().tx(this.translate('GENERAL_DEFINITION'));
    }
    if (columnInfo.hasComment) {
      headerRow.th().tx(this.translate('GENERAL_COMMENTS'));
    }
    if (columnInfo.hasDeprecated) {
      headerRow.th().tx(this.translate('CODESYSTEM_DEPRECATED'));
    }

    // Property columns
    for (const prop of columnInfo.properties) {
      headerRow.th().tx(this.getDisplayForProperty(prop) || prop.code);
    }

    // Designation columns (by use + language)
    for (const desig of columnInfo.designations) {
      headerRow.th().tx(this.formatDesignationHeader(desig));
    }

    // Render concepts recursively
    for (const concept of cs.concept) {
      await this.addConceptRow(tbl, concept, 0, cs, columnInfo);
    }
  }

  makeCasedParam(x, cs, caseSensitive) {
    if (caseSensitive) {
      let s = caseSensitive ? "case-sensitive" : "case-insensitive";
      x.tx(s);
    } else {
      x.tx("");
    }
  }

  makeHierarchyParam(x, cs, hm) {
    if (hm) {
      let s = hm; // look it up?
      x.tx(" "+this.translate('CODE_SYS_IN_A_HIERARCHY', [s]));
    } else if ((cs.concept || []).find(c => (c.concept || []).length > 0)) {
      x.tx(" "+ this.translate('CODE_SYS_UNDEF_HIER'));
    }
  }

  analyzeConceptColumns(cs) {
    const EXT_CS_COMMENT = 'http://hl7.org/fhir/StructureDefinition/codesystem-concept-comments';
    const EXT_DISPLAY_HINT = 'http://hl7.org/fhir/StructureDefinition/structuredefinition-display-hint';
    const info = {
      hasHierarchy: false,
      hasDisplay: false,
      hasDefinition: false,
      hasDeprecated: false,
      hasComment: false,
      properties: [],
      designations: [],
      useMarkdown: this.hasMarkdownInDefinitions(cs)
    };

    // Check which properties are actually used
    const usedProperties = new Set();
    // Track distinct designations, keyed by use + language.
    const usedDesignations = new Map();

    const analyzeConceptList = (concepts) => {
      for (const c of concepts) {
        if (c.display && c.display !== c.code) {
          info.hasDisplay = true;
        }
        if (c.definition) {
          info.hasDefinition = true;
        }
        if (c.concept && c.concept.length > 0) {
          info.hasHierarchy = true;
          analyzeConceptList(c.concept);
        }

        // Check for deprecated
        if (this.isDeprecated(c)) {
          info.hasDeprecated = true;
        }

        // Check for concept comments
        if (Extensions.has(c, EXT_CS_COMMENT)) {
          info.hasComment = true;
        }

        // Track used properties
        if (c.property) {
          for (const prop of c.property) {
            usedProperties.add(prop.code);
          }
        }

        // Track distinct designations (by use + language)
        if (c.designation) {
          for (const desig of c.designation) {
            const key = this.getDesignationKey(desig);
            if (!usedDesignations.has(key)) {
              usedDesignations.set(key, { use: desig.use, language: desig.language });
            }
          }
        }
      }
    };

    analyzeConceptList(cs.concept || []);

    // If any property carries a display-hint extension, switch to "manual"
    // column selection: only properties explicitly hinted display/no-link show.
    const isManual = (cs.property || []).some(p => Extensions.has(p, EXT_DISPLAY_HINT));

    // Filter to properties that are actually used
    if (cs.property) {
      for (const prop of cs.property) {
        if (usedProperties.has(prop.code) && this.showPropertyInTable(prop, isManual)) {
          info.properties.push(prop);
        }
      }
    }

    // Convert designation map to array, sorted for stable ordering
    info.designations = Array.from(usedDesignations.values()).sort((a, b) => {
      return this.getDesignationKey(a).localeCompare(this.getDesignationKey(b));
    });

    return info;
  }

  showPropertyInTable(prop, isManual = false) {
    if (isManual) {
      // Manual mode: only show properties explicitly hinted display/no-link.
      const hint = Extensions.readString(prop, 'http://hl7.org/fhir/StructureDefinition/structuredefinition-display-hint');
      return hint === 'display' || hint === 'no-link';
    }
    // Skip certain internal properties
    const skipCodes = ['status', 'inactive', 'deprecated', 'notSelectable'];
    return !skipCodes.includes(prop.code);
  }

  getDisplayForProperty(prop) {
    // Could look up a display name for well-known properties
    return prop.description || prop.code;
  }

  /**
   * Translations of a concept's definition, carried as translation extensions
   * on the definition primitive (the sibling _definition element in JSON).
   * Returns [{lang, value}]. Display translations are intentionally NOT read
   * here - display variants belong in designations.
   */
  definitionTranslations(concept) {
    const el = concept._definition;
    if (!el || !el.extension) {
      return [];
    }
    const out = [];
    for (const ext of el.extension) {
      if (ext.url === 'http://hl7.org/fhir/StructureDefinition/translation') {
        const lang = Extensions.readString(ext, 'lang');
        const value = Extensions.readString(ext, 'content');
        if (value) {
          out.push({ lang: lang || '', value });
        }
      }
    }
    return out;
  }

  /**
   * Whether concept definitions should be rendered as markdown. Honours the
   * codesystem-use-markdown extension; otherwise auto-detects common markdown
   * constructs in any definition.
   */
  hasMarkdownInDefinitions(cs) {
    const flag = Extensions.readValue(cs, 'http://hl7.org/fhir/StructureDefinition/codesystem-use-markdown');
    if (flag && typeof flag.valueBoolean === 'boolean') {
      return flag.valueBoolean;
    }
    const looksMarkdown = (str) => {
      if (!str) {
        return false;
      }
      return /\]\([^)]*\)|^\s*#{1,6}\s+|^\s*[-*+]\s+|^\s*\d+\.\s+/m.test(str);
    };
    const walk = (concepts) => {
      for (const c of concepts || []) {
        if (looksMarkdown(c.definition)) {
          return true;
        }
        if (c.concept && walk(c.concept)) {
          return true;
        }
      }
      return false;
    };
    return walk(cs.concept || []);
  }

  isDeprecated(concept) {
    if (concept.property) {
      for (const prop of concept.property) {
        if ((prop.code === 'status' && prop.valueCode === 'deprecated') ||
            (prop.code === 'deprecated' && prop.valueBoolean === true) ||
            (prop.code === 'inactive' && prop.valueBoolean === true)) {
          return true;
        }
      }
    }
    // The valueset-deprecated extension (on compose.include.concept or
    // expansion.contains) marks a concept as deprecated within this value set.
    const ext = Extensions.has(concept, 'http://hl7.org/fhir/StructureDefinition/valueset-deprecated');
    if (ext && ext.valueBoolean === true) {
      return true;
    }
    return false;
  }

  async addConceptRow(tbl, concept, level, cs, columnInfo) {
    this._requireValidCode(concept.code, 'CodeSystem.concept.code');
    const tr = tbl.tr();

    // Apply styling for deprecated concepts
    if (this.isDeprecated(concept)) {
      tr.style("background-color: #ffeeee");
    }

    // Level column
    if (columnInfo.hasHierarchy) {
      tr.td().tx(String(level + 1));
    }

    // Code column
    const codeTd = tr.td();
    if (level > 0) {
      codeTd.tx('\u00A0'.repeat(level * 2)); // Non-breaking spaces for indentation
    }

    // Link code if it's a supplement
    if (cs.content === 'supplement' && cs.supplements) {
      const link = this.linkResolver ?
          await this.linkResolver.resolveCode(this.opContext, cs.supplements, null, concept.code) : null;
      if (link) {
        codeTd.ah(link.link).tx(concept.code);
      } else {
        codeTd.tx(concept.code);
      }
    } else {
      codeTd.code().tx(concept.code);
    }
    codeTd.an(concept.code);

    // Display column
    if (columnInfo.hasDisplay) {
      tr.td().tx(concept.display || '');
    }

    // Definition column
    if (columnInfo.hasDefinition) {
      const td = tr.td();
      const useMarkdown = columnInfo.useMarkdown;
      if (concept.definition) {
        if (useMarkdown) {
          td.markdown(concept.definition);
        } else {
          td.tx(concept.definition);
        }
      }
      // Translations of the definition (translation extension on the
      // definition primitive) are rendered below the definition, same cell.
      for (const t of this.definitionTranslations(concept)) {
        td.br();
        td.i().tx('(' + t.lang + ') ');
        if (useMarkdown) {
          td.markdown(t.value);
        } else {
          td.tx(t.value);
        }
      }
    }

    // Comment column
    if (columnInfo.hasComment) {
      const td = tr.td();
      const comment = Extensions.readString(concept, 'http://hl7.org/fhir/StructureDefinition/codesystem-concept-comments');
      if (comment) {
        td.tx(comment);
      }
    }

    // Deprecated column
    if (columnInfo.hasDeprecated) {
      const td = tr.td();
      if (this.isDeprecated(concept)) {
        td.tx(this.translate('CODESYSTEM_DEPRECATED_TRUE'));

        // Replacement: prefer the codesystem-replacedby extension (a Coding),
        // then fall back to a 'replacedBy' property value.
        const replacedByExt = Extensions.readValue(concept, 'http://hl7.org/fhir/StructureDefinition/codesystem-replacedby');
        const replacedByCoding = replacedByExt && replacedByExt.valueCoding;
        const replacedByProp = this.getPropertyValue(concept, 'replacedBy');
        if (replacedByCoding) {
          td.tx(' ' + this.translate('CODESYSTEM_REPLACED_BY') + ' ');
          const link = this.linkResolver ?
            await this.linkResolver.resolveCode(this.opContext, replacedByCoding.system, replacedByCoding.version, replacedByCoding.code) : null;
          if (link) {
            td.ah(link.link).tx(replacedByCoding.code);
          } else {
            td.code().tx(replacedByCoding.code);
          }
          if (replacedByCoding.display) {
            td.tx(' "' + replacedByCoding.display + '"');
          }
        } else if (replacedByProp) {
          td.tx(' ' + this.translate('CODESYSTEM_REPLACED_BY') + ' ');
          td.code().tx(replacedByProp.value);
        } else {
          // No replacement: show the concept-level standards-status reason.
          const ssExt = Extensions.readValue(concept, 'http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status');
          if (ssExt) {
            const reason = Extensions.readString(ssExt, 'http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status-reason');
            if (reason) {
              td.tx(' ');
              td.markdown(reason);
            }
          }
        }
      }
    }

    // Property columns
    for (const prop of columnInfo.properties) {
      const td = tr.td();
      const noLink = Extensions.readString(prop, 'http://hl7.org/fhir/StructureDefinition/structuredefinition-display-hint') === 'no-link';
      const values = this.getPropertyValues(concept, prop.code);

      let first = true;
      for (const val of values) {
        if (!first) {
          td.tx(', ');
        }
        first = false;

        await this.renderPropertyValue(td, val, prop, cs, noLink);
      }
    }

    // Designation columns (by use + language)
    for (const desigDef of columnInfo.designations) {
      const td = tr.td();
      const value = this.getDesignationValue(concept, desigDef);
      if (value) {
        td.tx(value);
      }
    }

    // Recurse for child concepts
    if (concept.concept) {
      for (const child of concept.concept) {
        await this.addConceptRow(tbl, child, level + 1, cs, columnInfo);
      }
    }
  }

  getPropertyValue(concept, code) {
    if (!concept.property) return null;
    const prop = concept.property.find(p => p.code === code);
    return prop ? this.extractPropertyValue(prop) : null;
  }

  getPropertyValues(concept, code) {
    if (!concept.property) return [];
    return concept.property
        .filter(p => p.code === code)
        .map(p => this.extractPropertyValue(p))
        .filter(v => v !== null);
  }

  extractPropertyValue(prop) {
    if (prop.valueCode !== undefined) return { type: 'code', value: prop.valueCode };
    if (prop.valueString !== undefined) return { type: 'string', value: prop.valueString };
    if (prop.valueBoolean !== undefined) return { type: 'boolean', value: prop.valueBoolean };
    if (prop.valueInteger !== undefined) return { type: 'integer', value: prop.valueInteger };
    if (prop.valueDecimal !== undefined) return { type: 'decimal', value: prop.valueDecimal };
    if (prop.valueDateTime !== undefined) return { type: 'dateTime', value: prop.valueDateTime };
    if (prop.valueCoding !== undefined) return { type: 'coding', value: prop.valueCoding };
    return null;
  }

  async renderPropertyValue(td, val, propDef, cs, noLink = false) {
    if (!val) return;

    switch (val.type) {
      case 'code': {
        // If it's a parent reference, link to it
        if ((propDef.code === 'parent' || propDef.code === 'child') && !noLink) {
          td.ah('#' + cs.id + '-' + val.value).tx(val.value);
        } else {
          td.code().tx(val.value);
        }
        break;
      }
      case 'coding': {
        const coding = val.value;
        const link = (!noLink && this.linkResolver) ?
            await this.linkResolver.resolveCode(this.opContext, coding.system, coding.version, coding.code) : null;
        if (link) {
          td.ah(link.link).tx(coding.code);
        } else {
          td.tx(coding.code);
        }
        if (coding.display) {
          td.tx(' "' + coding.display + '"');
        }
        break;
      }
      case 'boolean': {
        td.tx(val.value ? 'true' : 'false');
        break;
      }
      case 'string': {
        // Check if it's a URL
        if (!noLink && (val.value.startsWith('http://') || val.value.startsWith('https://'))) {
          td.ah(val.value).tx(val.value);
        } else {
          td.tx(val.value);
        }
        break;
      }
      default:
        td.tx(String(val.value));
    }
  }

  sentenceForContent(mode, cs) {
    switch (mode) {
      case 'complete':
        return this.translate('CODESYSTEM_CONTENT_COMPLETE');
      case 'example':
        return this.translate('CODESYSTEM_CONTENT_EXAMPLE');
      case 'fragment':
        return this.translate('CODESYSTEM_CONTENT_FRAGMENT');
      case 'not-present':
        return this.translate('CODESYSTEM_CONTENT_NOTPRESENT');
      case 'supplement': {
        const hasProperties = cs.property && cs.property.length > 0;
        const hasDesignations = this.hasDesignations(cs);
        let features;
        if (hasProperties && hasDesignations) {
          features = this.translate('CODE_SYS_DISP_PROP');
        } else if (hasProperties) {
          features = this.translate('CODE_SYS_PROP');
        } else if (hasDesignations) {
          features = this.translate('CODE_SYS_DISP');
        } else {
          features = this.translate('CODE_SYS_FEAT');
        }
        return this.translate('CODESYSTEM_CONTENT_SUPPLEMENT', [features]);
      }
      default:
        return this.translate('CODESYSTEM_CONTENT_NOTPRESENT');
    }
  }

  hasDesignations(cs) {
    const checkConcepts = (concepts) => {
      for (const c of concepts) {
        if (c.designation && c.designation.length > 0) {
          return true;
        }
        if (c.concept && checkConcepts(c.concept)) {
          return true;
        }
      }
      return false;
    };
    return checkConcepts(cs.concept || []);
  }

  countConcepts(concepts) {
    if (!concepts) {
      return 0;
    }
    let count = concepts.length;
    for (const c of concepts) {
      if (c.concept) {
        count += this.countConcepts(c.concept);
      }
    }
    return count;
  }

  async renderVSExpansion(vs, showProps) {
    let div_ = div();
    let tbl;
    if (showProps) {
      div_.h2().tx("Expansion Properties");
      tbl = div_.table("grid");
    } else {
      tbl = div(); // dummy
    }
    await this.renderExpansion(div_.table("grid"), vs, tbl);
    return div_.toString();
  }

  async renderExpansion(x, vs, tbl) {
    // Surface expansion-level status extensions as prominent warnings: the
    // expansion may not contain every code in the value set.
    if (Extensions.has(vs.expansion, 'http://hl7.org/fhir/StructureDefinition/valueset-unclosed')) {
      const reason = Extensions.readString(vs.expansion, 'http://hl7.org/fhir/StructureDefinition/valueset-unclosed-reason');
      const p = x.para();
      p.b().tx('Warning: ');
      p.tx('This expansion is not closed - it may not contain all the codes in the value set.' + (reason ? ' ' + reason : ''));
    }
    if (Extensions.has(vs.expansion, 'http://hl7.org/fhir/StructureDefinition/valueset-toocostly')) {
      const p = x.para();
      p.b().tx('Warning: ');
      p.tx('This expansion is incomplete - a complete expansion was too costly to produce.');
    }
    this.renderProperty(tbl, 'Expansion Identifier', vs.expansion.identifier);
    this.renderProperty(tbl, 'Expansion Timestamp', vs.expansion.timestamp);
    this.renderProperty(tbl, 'Expansion Total', vs.expansion.total);
    this.renderProperty(tbl, 'Expansion Offset', vs.expansion.offset);
    const warnings = [];
    const warningNames = new Set(['deprecated', 'withdrawn', 'retired', 'experimental', 'draft']);
    const useds = [];
    const usedNames = new Set(['codesystem', 'valueset', 'supplement']);
    for (let p of vs.expansion.parameter || []) {
      if (p.name.startsWith('warning-') && warningNames.has(p.name.substring(8))) {
        warnings.push(p);
      } else if (p.name.startsWith('used-') && usedNames.has(p.name.substring(5))) {
        useds.push(p);
      } else if( getValueName(p) === 'valueUri' || getValueName(p) === 'valueCanonical') {
        await this.renderPropertyLink(tbl, "Parameter: " + p.name, getValuePrimitive(p));
      } else {
        this.renderProperty(tbl, "Parameter: " + p.name, getValuePrimitive(p));
      }
    }
    if (useds.length > 0) {
      await this.renderUsed(x, useds);
    }
    if (warnings.length > 0) {
      await this.renderWarnings(x, warnings);
    }

    if (!vs.expansion.contains || vs.expansion.contains.length === 0) {
      x.para().i().tx('No concepts in expansion');
      return;
    }

    // Analyze columns needed
    const columnInfo = this.analyzeExpansionColumns(vs.expansion);
    columnInfo.versions = this.expansionVersions(vs);

    // Build the expansion table
    const expTbl = x.table("codes");

    // Header row
    const headerRow = expTbl.tr();

    if (columnInfo.hasHierarchy) {
      headerRow.th().tx(this.translate('CODESYSTEM_LVL'));
    }
    headerRow.th().tx(this.translate('GENERAL_CODE'));
    headerRow.th().tx(this.translate('VALUE_SET_SYSTEM'));
    if (columnInfo.hasVersion) {
      headerRow.th().tx(this.translate('GENERAL_VER'));
    }
    headerRow.th().tx(this.translate('TX_DISPLAY'));
    if (columnInfo.hasAbstract) {
      headerRow.th().tx(this.translate('Abstract'));
    }
    if (columnInfo.hasInactive) {
      headerRow.th().tx(this.translate('VALUE_SET_INACTIVE'));
    }

    // Property columns (from expansion.property definitions)
    for (const prop of columnInfo.properties) {
      headerRow.th().tx(prop.code);
    }

    // Designation columns (use|language combinations)
    for (const desig of columnInfo.designations) {
      headerRow.th().tx(this.formatDesignationHeader(desig));
    }

    // Render contains recursively
    for (const contains of vs.expansion.contains) {
      await this.addExpansionRow(expTbl, contains, 0, columnInfo);
    }
  }

  /**
   * Analyze expansion contains to determine which columns are needed
   */
  analyzeExpansionColumns(expansion) {
    const info = {
      hasHierarchy: false,
      hasVersion: false,
      hasAbstract: false,
      hasInactive: false,
      properties: [],
      designations: []
    };

    // Build map of property codes from expansion.property
    const propertyDefs = new Map();
    for (const prop of expansion.property || []) {
      propertyDefs.set(prop.code, prop);
    }

    // Track which properties and designations are actually used
    const usedProperties = new Set();
    const usedDesignations = new Map(); // key: "use|language", value: {use, language}

    const analyzeContains = (containsList, level) => {
      for (const c of containsList) {
        if (c.version) {
          info.hasVersion = true;
        }
        if (c.abstract === true) {
          info.hasAbstract = true;
        }
        if (c.inactive === true) {
          info.hasInactive = true;
        }

        // Check for nested contains (hierarchy)
        if (c.contains && c.contains.length > 0) {
          info.hasHierarchy = true;
          analyzeContains(c.contains, level + 1);
        }

        // Track used properties
        if (c.property) {
          for (const prop of c.property) {
            usedProperties.add(prop.code);
          }
        }

        // Track used designations
        if (c.designation) {
          for (const desig of c.designation) {
            const key = this.getDesignationKey(desig);
            if (!usedDesignations.has(key)) {
              usedDesignations.set(key, {
                use: desig.use,
                language: desig.language
              });
            }
          }
        }
      }
    };

    analyzeContains(expansion.contains || [], 0);

    // Filter to properties that are defined and used
    for (const [code, def] of propertyDefs) {
      if (usedProperties.has(code)) {
        info.properties.push(def);
      }
    }

    // Convert designation map to array, sorted for consistent ordering
    info.designations = Array.from(usedDesignations.values()).sort((a, b) => {
      const keyA = this.getDesignationKey(a);
      const keyB = this.getDesignationKey(b);
      return keyA.localeCompare(keyB);
    });

    return info;
  }

  /**
   * Get a unique key for a designation based on use and language
   */
  getDesignationKey(desig) {
    const useCode = desig.use?.code || '';
    const useSystem = desig.use?.system || '';
    const lang = desig.language || '';
    return `${useSystem}|${useCode}|${lang}`;
  }

  /**
   * Format a designation header for display
   */
  formatDesignationHeader(desig) {
    const parts = [];
    if (desig.use?.display) {
      parts.push(desig.use.display);
    } else if (desig.use?.code) {
      parts.push(desig.use.code);
    }
    if (desig.language) {
      parts.push(`(${desig.language})`);
    }
    return parts.length > 0 ? parts.join(' ') : 'Designation';
  }

  /**
   * Add a row for an expansion contains entry
   */
  /**
   * The version each code system was expanded at, by system uri.
   *
   * An expansion.contains only carries a version when the expansion needed to distinguish
   * one, so a link built from the row alone would silently point at whichever version the
   * server happens to prefer - not what the reader is looking at. The expansion says which
   * version it used in its used-codesystem parameters, and a value set that came with its
   * definition says so in its compose; either will do.
   *
   * @param {Object} vs the expanded ValueSet
   * @returns {Map<string, string>} system uri to version
   */
  expansionVersions(vs) {
    const versions = new Map();
    for (const inc of vs.compose?.include || []) {
      if (inc.system && inc.version && !versions.has(inc.system)) {
        versions.set(inc.system, inc.version);
      }
    }
    for (const p of vs.expansion?.parameter || []) {
      if (p.name !== 'used-codesystem') {
        continue;
      }
      const vurl = getValuePrimitive(p);
      if (vurl && vurl.includes('|')) {
        const system = vurl.substring(0, vurl.indexOf('|'));
        if (!versions.has(system)) {
          versions.set(system, vurl.substring(vurl.indexOf('|') + 1));
        }
      }
    }
    return versions;
  }

  async addExpansionRow(tbl, contains, level, columnInfo) {
    const tr = tbl.tr();

    // Apply styling for abstract or inactive concepts
    if (contains.abstract === true) {
      tr.style("font-style: italic");
    }
    if (contains.inactive === true) {
      tr.style("background-color: #ffeeee");
    }

    // Level column
    if (columnInfo.hasHierarchy) {
      tr.td().tx(String(level + 1));
    }

    // Code column
    const codeTd = tr.td();
    if (level > 0) {
      codeTd.tx('\u00A0'.repeat(level * 2)); // Non-breaking spaces for indentation
    }

    // The code links to $lookup on it - what a reader wants from a row in an expansion is
    // to find out what that code is - at the version the expansion used.
    if (contains.code) {
      const version = contains.version || columnInfo.versions?.get(contains.system) || null;
      const link = this.linkResolver?.lookupLink
        ? this.linkResolver.lookupLink(contains.system, version, contains.code) : null;
      if (link) {
        codeTd.ah(link, 'Look this code up').code().tx(contains.code);
      } else {
        codeTd.code().tx(contains.code);
      }
    }

    // System column
    const systemTd = tr.td();
    if (contains.system) {
      systemTd.code().tx(contains.system);
    }

    // Version column
    if (columnInfo.hasVersion) {
      tr.td().tx(contains.version || '');
    }

    // Display column
    tr.td().tx(contains.display || '');

    // Abstract column
    if (columnInfo.hasAbstract) {
      tr.td().tx(contains.abstract === true ? 'abstract' : '');
    }

    // Inactive column
    if (columnInfo.hasInactive) {
      tr.td().tx(contains.inactive === true ? this.translate('VALUE_SET_INACT') : '');
    }

    // Property columns
    for (const propDef of columnInfo.properties) {
      const td = tr.td();
      const values = this.getContainsPropertyValues(contains, propDef.code);

      let first = true;
      for (const val of values) {
        if (!first) {
          td.tx(', ');
        }
        first = false;
        await this.renderExpansionPropertyValue(td, val, propDef);
      }
    }

    // Designation columns
    for (const desigDef of columnInfo.designations) {
      const td = tr.td();
      const value = this.getDesignationValue(contains, desigDef);
      if (value) {
        td.tx(value);
      }
    }

    // Recurse for nested contains
    if (contains.contains) {
      for (const child of contains.contains) {
        await this.addExpansionRow(tbl, child, level + 1, columnInfo);
      }
    }
  }

  /**
   * Get property values from a contains entry
   */
  getContainsPropertyValues(contains, code) {
    if (!contains.property) return [];
    return contains.property
        .filter(p => p.code === code)
        .map(p => this.extractExpansionPropertyValue(p))
        .filter(v => v !== null);
  }

  /**
   * Extract the value from an expansion property
   */
  extractExpansionPropertyValue(prop) {
    if (prop.valueCode !== undefined) return { type: 'code', value: prop.valueCode };
    if (prop.valueString !== undefined) return { type: 'string', value: prop.valueString };
    if (prop.valueBoolean !== undefined) return { type: 'boolean', value: prop.valueBoolean };
    if (prop.valueInteger !== undefined) return { type: 'integer', value: prop.valueInteger };
    if (prop.valueDecimal !== undefined) return { type: 'decimal', value: prop.valueDecimal };
    if (prop.valueDateTime !== undefined) return { type: 'dateTime', value: prop.valueDateTime };
    if (prop.valueCoding !== undefined) return { type: 'coding', value: prop.valueCoding };
    return null;
  }

  /**
   * Render an expansion property value
   */
  // eslint-disable-next-line no-unused-vars
  async renderExpansionPropertyValue(td, val, propDef) {
    if (!val) return;

    switch (val.type) {
      case 'code': {
        td.code().tx(val.value);
        break;
      }
      case 'coding': {
        const coding = val.value;
        const link = this.linkResolver ?
            await this.linkResolver.resolveCode(this.opContext, coding.system, coding.version, coding.code) : null;
        if (link) {
          td.ah(link.link).tx(coding.code);
        } else {
          td.code().tx(coding.code);
        }
        if (coding.display) {
          td.tx(' "' + coding.display + '"');
        }
        break;
      }
      case 'boolean': {
        td.tx(val.value ? 'true' : 'false');
        break;
      }
      case 'string': {
        if (val.value.startsWith('http://') || val.value.startsWith('https://')) {
          td.ah(val.value).tx(val.value);
        } else {
          td.tx(val.value);
        }
        break;
      }
      default:
        td.tx(String(val.value));
    }
  }

  /**
   * Get a designation value matching the given use/language
   */
  getDesignationValue(contains, desigDef) {
    if (!contains.designation) return null;

    for (const desig of contains.designation) {
      // Match on use and language
      const useMatches = this.codingMatches(desig.use, desigDef.use);
      const langMatches = (desig.language || '') === (desigDef.language || '');

      if (useMatches && langMatches) {
        return desig.value;
      }
    }
    return null;
  }

  /**
   * Check if two codings match (both null, or same system/code)
   */
  codingMatches(a, b) {
    if (!a && !b) return true;
    if (!a || !b) return false;
    return (a.system || '') === (b.system || '') && (a.code || '') === (b.code || '');
  }

  async renderCapabilityStatement(cs) {
    cs = this._resolveResource(cs, 'CapabilityStatement', 'renderCapabilityStatement');
    this._requireAllowed(cs.status, VALID_PUBLICATION_STATUS, 'CapabilityStatement.status', 'invalid status');

    let div_ = div();

    // Metadata table
    div_.h3().tx("Properties");
    await this.renderMetadataTable(cs, div_.table("grid"));

    // Formats
    if (cs.format && cs.format.length > 0) {
      div_.h3().tx(this.translate('Formats') || 'Formats');
      div_.para().tx(cs.format.join(', '));
    }

    // Implementation Guides
    if (cs.implementationGuide && cs.implementationGuide.length > 0) {
      div_.h3().tx(this.translate('CAPABILITY_IMP_GUIDES') || 'Implementation Guides');
      const ul = div_.ul();
      for (const ig of cs.implementationGuide) {
        await this.renderLink(ul.li(), ig);
      }
    }

    // REST definitions
    if (cs.rest && cs.rest.length > 0) {
      for (const rest of cs.rest) {
        await this.renderCapabilityRest(div_, rest, cs);
      }
    }

    return div_.toString();
  }

  async renderCapabilityRest(x, rest) {
    x.h3().tx(`REST ${rest.mode || 'server'} Definition`);

    if (rest.documentation) {
      x.para().markdown(rest.documentation);
    }

    // Security
    if (rest.security) {
      await this.renderCapabilitySecurity(x, rest.security);
    }

    // Resources table
    if (rest.resource && rest.resource.length > 0) {
      await this.renderCapabilityResources(x, rest);
    }

    // System-level operations
    if (rest.operation && rest.operation.length > 0) {
      x.h4().tx(this.translate('CAPABILITY_OP') || 'System Operations');
      const ul = x.ul();
      for (const op of rest.operation) {
        const li = ul.li();
        if (op.definition) {
          li.ah(op.definition).tx(op.name);
        } else {
          li.tx(op.name);
        }
        if (op.documentation) {
          li.tx(': ');
          li.tx(op.documentation);
        }
      }
    }

    // Compartments
    if (rest.compartment && rest.compartment.length > 0) {
      x.h4().tx(this.translate('CAPABILITY_COMPARTMENTS') || 'Compartments');
      const ul = x.ul();
      for (const comp of rest.compartment) {
        await this.renderLink(ul.li(), comp);
      }
    }
  }

  async renderCapabilitySecurity(x, security) {
    x.h4().tx('Security');

    const tbl = x.table("grid");

    if (security.cors !== undefined) {
      const tr = tbl.tr();
      tr.td().b().tx('CORS');
      tr.td().tx(security.cors ? 'enabled' : 'disabled');
    }

    if (security.service && security.service.length > 0) {
      const tr = tbl.tr();
      tr.td().b().tx(this.translate('CAPABILITY_SEC_SERVICES') || 'Security Services');
      const td = tr.td();
      let first = true;
      for (const svc of security.service) {
        if (!first) {
          td.tx(', ');
        }
        first = false;
        // Render CodeableConcept - prefer text, then first coding display, then first coding code
        if (svc.text) {
          td.tx(svc.text);
        } else if (svc.coding && svc.coding.length > 0) {
          const coding = svc.coding[0];
          td.tx(coding.display || coding.code || '');
        }
      }
    }

    if (security.description) {
      const tr = tbl.tr();
      tr.td().b().tx(this.translate('GENERAL_DESC') || 'Description');
      tr.td().markdown(security.description);
    }
  }

  async renderCapabilityResources(x, rest) {
    x.h4().tx('Resources');

    // Analyze what columns we need
    const columnInfo = this.analyzeCapabilityResourceColumns(rest.resource);

    const tbl = x.table("grid");

    // Header row
    const headerRow = tbl.tr();
    headerRow.th().tx(this.translate('GENERAL_TYPE') || 'Type');

    if (columnInfo.hasProfile) {
      headerRow.th().tx(this.translate('GENERAL_PROF') || 'Profile');
    }

    // Interaction columns
    for (const intCode of columnInfo.interactions) {
      headerRow.th().tx(intCode);
    }

    if (columnInfo.hasSearchParams) {
      headerRow.th().tx(this.translate('CAPABILITY_SEARCH_PARS') || 'Search Parameters');
    }

    if (columnInfo.hasOperations) {
      headerRow.th().tx(this.translate('CAPABILITY_OP') || 'Operations');
    }

    // Resource rows
    for (const resource of rest.resource) {
      await this.addCapabilityResourceRow(tbl, resource, columnInfo);
    }
  }

  analyzeCapabilityResourceColumns(resources) {
    const info = {
      hasProfile: false,
      interactions: new Set(),
      hasSearchParams: false,
      hasOperations: false
    };

    for (const res of resources) {
      if (res.profile) {
        info.hasProfile = true;
      }

      if (res.interaction) {
        for (const int of res.interaction) {
          info.interactions.add(int.code);
        }
      }

      if (res.searchParam && res.searchParam.length > 0) {
        info.hasSearchParams = true;
      }

      if (res.operation && res.operation.length > 0) {
        info.hasOperations = true;
      }
    }

    // Convert interactions to sorted array for consistent column ordering
    const interactionOrder = ['read', 'vread', 'update', 'patch', 'delete', 'history-instance', 'history-type', 'create', 'search-type'];
    info.interactions = interactionOrder.filter(i => info.interactions.has(i));

    // Add any other interactions not in our predefined order
    for (const res of resources) {
      if (res.interaction) {
        for (const int of res.interaction) {
          if (!info.interactions.includes(int.code)) {
            info.interactions.push(int.code);
          }
        }
      }
    }

    return info;
  }

  async addCapabilityResourceRow(tbl, resource, columnInfo) {
    const tr = tbl.tr();

    // Type column
    tr.td().b().tx(resource.type);

    // Profile column
    if (columnInfo.hasProfile) {
      const td = tr.td();
      if (resource.profile) {
        await this.renderLink(td, resource.profile);
      }
      // Also show supportedProfile if present
      if (resource.supportedProfile && resource.supportedProfile.length > 0) {
        if (resource.profile) {
          td.br();
          td.tx('Also: ');
        }
        let first = true;
        for (const sp of resource.supportedProfile) {
          if (!first) {
            td.tx(', ');
          }
          first = false;
          await this.renderLink(td, sp);
        }
      }
    }

    // Interaction columns - render checkmarks
    const supportedInteractions = new Set(
        (resource.interaction || []).map(i => i.code)
    );

    for (const intCode of columnInfo.interactions) {
      const td = tr.td();
      td.style("text-align: center");
      if (supportedInteractions.has(intCode)) {
        td.tx('✓');
      }
    }

    // Search parameters column
    if (columnInfo.hasSearchParams) {
      const td = tr.td();
      if (resource.searchParam && resource.searchParam.length > 0) {
        const paramNames = resource.searchParam.map(sp => sp.name);
        td.tx(paramNames.join(', '));
      }
    }

    // Operations column
    if (columnInfo.hasOperations) {
      const td = tr.td();
      if (resource.operation && resource.operation.length > 0) {
        let first = true;
        for (const op of resource.operation) {
          if (!first) {
            td.tx(', ');
          }
          first = false;
          if (op.definition) {
            td.ah(op.definition).tx(op.name);
          } else {
            td.tx(op.name);
          }
        }
      }
    }
  }

  async renderTerminologyCapabilities(tc) {
    tc = this._resolveResource(tc, 'TerminologyCapabilities', 'renderTerminologyCapabilities');
    this._requireAllowed(tc.status, VALID_PUBLICATION_STATUS, 'TerminologyCapabilities.status', 'invalid status');

    let div_ = div();

    // Metadata table
    div_.h3().tx("Properties");
    await this.renderMetadataTable(tc, div_.table("grid"));

    // Code Systems
    if (tc.codeSystem && tc.codeSystem.length > 0) {
      div_.h3().tx('Code Systems');
      const ul = div_.ul();
      for (const cs of tc.codeSystem) {
        if (cs.uri) {
          const li = ul.li();
          if (cs.version && cs.version.length > 0) {
            // List each version
            let first = true;
            for (const v of cs.version) {
              if (!first) {
                li.tx(', ');
              }
              first = false;
              const versionedUri = v.code ? `${cs.uri}|${v.code}` : cs.uri;
              await this.renderLink(li, versionedUri);
            }
          } else {
            // No versions specified
            await this.renderLink(li, cs.uri);
          }
          let content = cs.content || Extensions.readString(cs, "http://hl7.org/fhir/4.0/StructureDefinition/extension-TerminologyCapabilities.codeSystem.content");
          if (content && content != "complete") {
            li.tx(" (" + content + ")");
          }
        }
      }
    }

    return div_.toString();
  }

  async renderWarnings(x, warnings) {
    await this.renderWarningsForStatus(x, 'deprecated', warnings);
    await this.renderWarningsForStatus(x, 'withdrawn', warnings);
    await this.renderWarningsForStatus(x, 'retired', warnings);
    await this.renderWarningsForStatus(x, 'experimental', warnings);
    await this.renderWarningsForStatus(x, 'draft', warnings);
  }

  async renderWarningsForStatus(x, name, warnings) {
    const wl = warnings.filter(item => item.name == 'warning-'+name);
    if (wl && wl.length > 0) {
      x.para().tx(`This ValueSet depends on the following ${name} ValueSets: `);
      let ul = x.ul();
      for (const w of wl) {
        const linkinfo = await this.linkResolver.resolveURL(this.opContext, getValuePrimitive(w));
        if (linkinfo) {
          ul.li().ah(linkinfo.link).tx(linkinfo.description);
        } else {
          ul.li().code().tx(getValuePrimitive(w));
        }
      }
    }
  }

  async renderUsed(x, list) {
    x.para().tx(`This ValueSet depends on the following items:`);
    let ul = x.ul();
    await this.renderUsedForType(ul, 'codesystem', 'CodeSystem', list);
    await this.renderUsedForType(ul, 'valueset', 'ValueSet', list);
    await this.renderUsedForType(ul, 'supplement', 'Supplement', list);
  }

  async renderUsedForType(ul, name, title, list) {
    const wl = list.filter(item => item.name == 'used-' + name);
    for (const w of wl) {
      const li = ul.li();
      li.tx(title+": ");
      const linkinfo = await this.linkResolver.resolveURL(this.opContext, getValuePrimitive(w));
      if (linkinfo) {
        li.ah(linkinfo.link).tx(linkinfo.description);
      } else {
        li.code().tx(getValuePrimitive(w));
      }
    }
  }

  // Methods to add to the Renderer class in renderer.js for ConceptMap rendering.
// These follow the Java ConceptMapRenderer logic and use the same translated strings.

// ---- Add these methods to the Renderer class ----

  /**
   * Render a ConceptMap resource to HTML.
   * Follows the same pattern as renderValueSet/renderCodeSystem:
   * metadata table (reusing renderMetadataTable), then group-by-group rendering.
   */
  async renderConceptMap(cm) {
    cm = this._resolveResource(cm, 'ConceptMap', 'renderConceptMap');
    this._requireAllowed(cm.status, VALID_PUBLICATION_STATUS, 'ConceptMap.status', 'invalid status');

    let div_ = div();

    // Metadata table
    div_.h3().tx("Properties");
    await this.renderMetadataTable(cm, div_.table("grid"));

    div_.h3("Mapping Details");
    // Source/Target scope line (mirrors Java: CONC_MAP_FROM / CONC_MAP_TO)
    const p = div_.para();
    p.tx(this.translate('CONC_MAP_FROM') + " ");
    const sourceScope = cm.sourceScope || cm.sourceCanonical || cm.sourceUri;
    if (sourceScope) {
      await this.renderLink(p, sourceScope);
    } else {
      p.tx(this.translate('CONC_MAP_NOT_SPEC'));
    }
    p.tx(" " + this.translate('CONC_MAP_TO') + " ");
    const targetScope = cm.targetScope || cm.targetCanonical || cm.targetUri;
    if (targetScope) {
      await this.renderLink(p, targetScope);
    } else {
      p.tx(this.translate('CONC_MAP_NOT_SPEC'));
    }

    div_.br();

    // Render each group
    let gc = 0;
    for (const grp of cm.group || []) {
      gc++;
      if (gc > 1) {
        div_.hr();
      }
      await this.renderConceptMapGroup(div_, cm, grp, gc);
    }

    return div_.toString();
  }

  /**
   * Render a single ConceptMap group.
   * Determines whether this is a "simple" group (1:1 mappings, no dependsOn/product)
   * or a "complex" group, and delegates accordingly.
   */
  async renderConceptMapGroup(x, cm, grp, gc) {
    // Analyze the group to determine rendering mode
    let hasComment = false;
    let hasProperties = false;
    let ok = true; // true = simple rendering

    const props = {};   // property code -> Set of systems
    const sources = { code: new Set() };
    const targets = { code: new Set() };

    if (grp.source) sources.code.add(grp.source);
    if (grp.target) targets.code.add(grp.target);

    for (const elem of grp.element || []) {
      const isSimple = elem.noMap ||
        (elem.target && elem.target.length === 1 &&
          (!elem.target[0].dependsOn || elem.target[0].dependsOn.length === 0) &&
          (!elem.target[0].product || elem.target[0].product.length === 0));
      ok = ok && isSimple;

      if (Extensions.readString(elem, 'http://hl7.org/fhir/StructureDefinition/conceptmap-nomap-comment')) {
        hasComment = true;
      }

      for (const tgt of elem.target || []) {
        if (tgt.comment) {
          hasComment = true;
        }
        for (const pp of tgt.property || []) {
          if (!props[pp.code]) {
            props[pp.code] = new Set();
          }
        }
        for (const d of tgt.dependsOn || []) {
          if (!sources[d.attribute]) {
            sources[d.attribute] = new Set();
          }
        }
        for (const d of tgt.product || []) {
          if (!targets[d.attribute]) {
            targets[d.attribute] = new Set();
          }
        }
      }
    }

    if (Object.keys(props).length > 0) {
      hasProperties = true;
    }

    // Group header
    const pp = x.para();
    pp.b().tx(this.translate('CONC_MAP_GRP', [gc])+ " ");
    pp.tx(this.translate('CONC_MAP_FROM') + " ");
    if (grp.source) {
      await this.renderLink(pp, grp.source);
    } else {
      pp.code().tx(this.translate('CONC_MAP_CODE_SYS_UNSPEC'));
    }
    pp.tx(" to ");
    if (grp.target) {
      await this.renderLink(pp, grp.target);
    } else {
      pp.code().tx(this.translate('CONC_MAP_CODE_SYS_UNSPEC'));
    }

    if (ok) {
      await this.renderSimpleConceptMapGroup(x, grp, hasComment);
    } else {
      await this.renderComplexConceptMapGroup(x, grp, hasComment, hasProperties, props, sources, targets);
    }
  }

  /**
   * Render a simple ConceptMap group: Source | Relationship | Target | Comment
   * This is the "ok" path from the Java code where all elements have at most
   * one target and no dependsOn/product.
   */
  async renderSimpleConceptMapGroup(x, grp, hasComment) {
    const tbl = x.table("grid");
    let tr = tbl.tr();
    tr.td().b().tx(this.translate('CONC_MAP_SOURCE'));
    tr.td().b().tx(this.translate('CONC_MAP_REL'));
    tr.td().b().tx(this.translate('CONC_MAP_TRGT'));
    if (hasComment) {
      tr.td().b().tx(this.translate('GENERAL_COMMENT'));
    }

    for (const elem of grp.element || []) {
      tr = tbl.tr();
      const td = tr.td();
      td.tx(elem.code);
      const display = elem.display || await this.getDisplayForConcept(grp.source, elem.code);
      if (display && !this.isSameCodeAndDisplay(elem.code, display)) {
        td.tx(" (" + display + ")");
      }

      if (elem.noMap) {
        const nomapComment = Extensions.readString(elem, 'http://hl7.org/fhir/StructureDefinition/conceptmap-nomap-comment');
        if (!hasComment) {
          tr.td().setAttribute('colspan',"2").style("background-color: #efefef").tx("(not mapped)");
        } else if (nomapComment) {
          tr.td().setAttribute('colspan',"2").style("background-color: #efefef").tx("(not mapped)");
          tr.td().style("background-color: #efefef").tx(nomapComment);
        } else {
          tr.td().setAttribute('colspan',"3").style("background-color: #efefef").tx("(not mapped)");
        }
      } else {
        let first = true;
        for (const tgt of elem.target || []) {
          if (first) {
            first = false;
          } else {
            tr = tbl.tr();
            tr.td().style("opacity: 0.5").tx('"');
          }

          // Relationship cell
          this.renderConceptMapRelationship(tr, tgt);

          // Target code cell
          const tgtTd = tr.td();
          tgtTd.tx(tgt.code || '');
          const tgtDisplay = tgt.display || await this.getDisplayForConcept(grp.target, tgt.code);
          if (tgtDisplay && !this.isSameCodeAndDisplay(tgt.code, tgtDisplay)) {
            tgtTd.tx(" (" + tgtDisplay + ")");
          }

          if (hasComment) {
            tr.td().tx(tgt.comment || '');
          }
        }
      }
    }
    this.addUnmapped(tbl, grp);
  }

  /**
   * Render a complex ConceptMap group with dependsOn, product, and/or property columns.
   * This is the "!ok" path from the Java code.
   */
  async renderComplexConceptMapGroup(x, grp, hasComment, hasProperties, props, sources, targets) {
    // Check if any targets have relationships
    let hasRelationships = false;
    for (const elem of grp.element || []) {
      for (const tgt of elem.target || []) {
        if (tgt.relationship) {
          hasRelationships = true;
        }
      }
    }

    const tbl = x.table("grid");

    // First header row: Source Details | Relationship | Target Details | Comment | Properties
    let tr = tbl.tr();
    const sourceColCount = 1 + Object.keys(sources).length - 1; // code + dependsOn attributes
    const targetColCount = 1 + Object.keys(targets).length - 1; // code + product attributes
    tr.td().setAttribute('colspan', String(sourceColCount + 1)).b().tx(this.translate('CONC_MAP_SRC_DET'));
    if (hasRelationships) {
      tr.td().b().tx(this.translate('CONC_MAP_REL'));
    }
    tr.td().setAttribute('colspan', String(targetColCount + 1)).b().tx(this.translate('CONC_MAP_TRGT_DET'));
    if (hasComment) {
      tr.td().b().tx(this.translate('GENERAL_COMMENT'));
    }
    if (hasProperties) {
      tr.td().setAttribute('colspan', String(Object.keys(props).length)).b().tx(this.translate('GENERAL_PROPS'));
    }

    // Second header row: actual column headers
    tr = tbl.tr();

    // Source code column
    if (sources.code.size === 1) {
      const url = [...sources.code][0];
      await this.renderCSDetailsLink(tr, url, true);
    } else {
      tr.td().b().tx(this.translate('GENERAL_CODE'));
    }
    // Source dependsOn attribute columns
    for (const s of Object.keys(sources)) {
      if (s !== 'code') {
        if (sources[s].size === 1) {
          const url = [...sources[s]][0];
          await this.renderCSDetailsLink(tr, url, false);
        } else {
          tr.td().b().tx(this.getDescForConcept(s));
        }
      }
    }
    // Relationship column
    if (hasRelationships) {
      tr.td();
    }
    // Target code column
    if (targets.code.size === 1) {
      const url = [...targets.code][0];
      await this.renderCSDetailsLink(tr, url, true);
    } else {
      tr.td().b().tx(this.translate('GENERAL_CODE'));
    }
    // Target product attribute columns
    for (const s of Object.keys(targets)) {
      if (s !== 'code') {
        if (targets[s].size === 1) {
          const url = [...targets[s]][0];
          await this.renderCSDetailsLink(tr, url, false);
        } else {
          tr.td().b().tx(this.getDescForConcept(s));
        }
      }
    }
    // Comment column header
    if (hasComment) {
      tr.td();
    }
    // Property column headers
    if (hasProperties) {
      for (const s of Object.keys(props)) {
        if (props[s].size === 1) {
          const url = [...props[s]][0];
          await this.renderCSDetailsLink(tr, url, false);
        } else {
          tr.td().b().tx(this.getDescForConcept(s));
        }
      }
    }

    // Data rows
    for (const elem of grp.element || []) {
      if (elem.noMap) {
        tr = tbl.tr();
        const td = tr.td().style("border-right-width: 0px");
        if (sources.code.size === 1) {
          td.tx(elem.code);
        } else {
          td.tx(grp.source + " / " + elem.code);
        }
        const display = elem.display || await this.getDisplayForConcept(grp.source, elem.code);
        tr.td().style("border-left-width: 0px").tx(display || '');

        const nomapComment = Extensions.readString(elem, 'http://hl7.org/fhir/StructureDefinition/conceptmap-nomap-comment');
        if (nomapComment) {
          tr.td().setAttribute('colspan',"3").style("background-color: #efefef").tx("(not mapped)");
          tr.td().style("background-color: #efefef").tx(nomapComment);
        } else {
          tr.td().setAttribute('colspan',"4").style("background-color: #efefef").tx("(not mapped)");
        }
      } else {
        let first = true;
        for (let ti = 0; ti < (elem.target || []).length; ti++) {
          const tgt = elem.target[ti];
          const last = ti === elem.target.length - 1;
          tr = tbl.tr();

          // Source code cell
          const td = tr.td().style("border-right-width: 0px");
          if (!first && !last) {
            td.style("border-top-style: none; border-bottom-style: none");
          } else if (!first) {
            td.style("border-top-style: none");
          } else if (!last) {
            td.style("border-bottom-style: none");
          }

          if (first) {
            if (sources.code.size === 1) {
              td.tx(elem.code);
            } else {
              td.tx(grp.source + " / " + elem.code);
            }
            const display = elem.display || await this.getDisplayForConcept(grp.source, elem.code);
            const dispTd = tr.td();
            if (!last) {
              dispTd.style("border-left-width: 0px; border-bottom-style: none");
            } else {
              dispTd.style("border-left-width: 0px");
            }
            dispTd.tx(display || '');
          } else {
            // Empty display cell for subsequent targets
            const dispTd = tr.td();
            if (!last) {
              dispTd.style("border-left-width: 0px; border-top-style: none; border-bottom-style: none");
            } else {
              dispTd.style("border-top-style: none; border-left-width: 0px");
            }
          }

          // Source dependsOn columns
          for (const s of Object.keys(sources)) {
            if (s !== 'code') {
              const depTd = tr.td();
              const val = this.getDependsOnValue(tgt.dependsOn, s, sources[s].size !== 1);
              depTd.tx(val || '');
              const depDisplay = this.getDependsOnDisplay(tgt.dependsOn, s);
              if (depDisplay) {
                depTd.tx(" (" + depDisplay + ")");
              }
            }
          }

          first = false;

          // Relationship cell
          if (hasRelationships) {
            this.renderConceptMapRelationship(tr, tgt);
          }

          // Target code cell
          const tgtTd = tr.td().style("border-right-width: 0px");
          if (targets.code.size === 1) {
            tgtTd.tx(tgt.code || '');
          } else {
            tgtTd.tx((grp.target || '') + " / " + (tgt.code || ''));
          }
          const tgtDisplay = tgt.display || await this.getDisplayForConcept(grp.target, tgt.code);
          tr.td().style("border-left-width: 0px").tx(tgtDisplay || '');

          // Target product columns
          for (const s of Object.keys(targets)) {
            if (s !== 'code') {
              const prodTd = tr.td();
              const val = this.getDependsOnValue(tgt.product, s, targets[s].size !== 1);
              prodTd.tx(val || '');
              const prodDisplay = this.getDependsOnDisplay(tgt.product, s);
              if (prodDisplay) {
                prodTd.tx(" (" + prodDisplay + ")");
              }
            }
          }

          // Comment cell
          if (hasComment) {
            tr.td().tx(tgt.comment || '');
          }

          // Property cells
          if (hasProperties) {
            for (const s of Object.keys(props)) {
              const propTd = tr.td();
              propTd.tx(this.getPropertyValueFromList(tgt.property, s));
            }
          }
        }
      }
    }
    this.addUnmapped(tbl, grp);
  }

  /**
   * Render the relationship cell for a target element.
   * Handles both R5 relationship codes and legacy R4 equivalence codes via extension.
   */
  renderConceptMapRelationship(tr, tgt) {
    if (tgt.relationship) {
      this._requireAllowed(tgt.relationship, VALID_CONCEPTMAP_RELATIONSHIPS,
        'ConceptMap.group.element.target.relationship', 'invalid ConceptMap relationship');
      tr.td().tx(this.presentRelationshipCode(tgt.relationship));
    } else if (tgt.equivalence) {
      this._requireAllowed(tgt.equivalence, VALID_CONCEPTMAP_EQUIVALENCES,
        'ConceptMap.group.element.target.equivalence', 'invalid ConceptMap equivalence');
      tr.td().tx(this.presentEquivalenceCode(tgt.equivalence));
    } else {
      tr.td().tx("(" + "equivalent" + ")");
    }
  }

  /**
   * Render a code system details link in a header cell.
   * Mirrors Java renderCSDetailsLink.
   */
  async renderCSDetailsLink(tr, url, span2) {
    const td = tr.td();
    if (span2) {
      td.setAttribute('colspan',"2");
    }
    td.b().tx(this.translate('CONC_MAP_CODES'));
    td.tx(" " + this.translate('CONC_MAP_FRM') + " ");
    const linkinfo = this.linkResolver ? await this.linkResolver.resolveURL(this.opContext, url) : null;
    if (linkinfo) {
      td.ah(linkinfo.link).tx(linkinfo.description);
    } else {
      td.tx(url);
    }
  }

  /**
   * Translate a FHIR R5 ConceptMap relationship code to a human-readable string.
   * Uses the same strings as the Java renderer.
   */
  presentRelationshipCode(code) {
    switch (code) {
      case 'related-to':                   return 'is related to';
      case 'equivalent':                   return 'is equivalent to';
      case 'source-is-narrower-than-target': return 'is narrower than';
      case 'source-is-broader-than-target':  return 'is broader than';
      case 'not-related-to':               return 'is not related to';
      default:                             return code;
    }
  }

  /**
   * Translate a legacy (R2/R3/R4) ConceptMap equivalence code to a human-readable string.
   * Uses the same strings as the Java renderer.
   */
  presentEquivalenceCode(code) {
    switch (code) {
      case 'relatedto':    return 'is related to';
      case 'equivalent':   return 'is equivalent to';
      case 'equal':        return 'is equal to';
      case 'wider':        return 'maps to wider concept';
      case 'subsumes':     return 'is subsumed by';
      case 'narrower':     return 'maps to narrower concept';
      case 'specializes':  return 'has specialization';
      case 'inexact':      return 'maps loosely to';
      case 'unmatched':    return 'has no match';
      case 'disjoint':     return 'is not related to';
      default:             return code;
    }
  }

  /**
   * Check if a code and its display text are essentially the same
   * (ignoring spaces, hyphens, and case).
   */
  isSameCodeAndDisplay(code, display) {
    if (!code || !display) return false;
    const c = code.replace(/[ -]/g, '').toLowerCase();
    const d = display.replace(/[ -]/g, '').toLowerCase();
    return c === d;
  }

  /**
   * Look up a display string for a concept. Delegates to the linkResolver if available.
   */
  async getDisplayForConcept(system, code) {
    if (!system || !code) return null;
    if (!this.linkResolver) return null;
    const result = await this.linkResolver.resolveCode(this.opContext, system, null, code);
    return result ? result.description : null;
  }

  /**
   * Get a description for a concept attribute code (used in complex table headers).
   * Mirrors Java getDescForConcept.
   */
  getDescForConcept(s) {
    if (s.startsWith('http://hl7.org/fhir/v2/element/')) {
      return 'v2 ' + s.substring('http://hl7.org/fhir/v2/element/'.length);
    }
    return s;
  }

  /**
   * Extract a value from a dependsOn or product list by attribute name.
   */
  getDependsOnValue(list, attribute) {
    if (!list) return null;
    for (const item of list) {
      if (item.attribute === attribute) {
        // R5 uses value[x], try common types
        if (item.valueCode) return item.valueCode;
        if (item.valueString) return item.valueString;
        if (item.valueCoding) return item.valueCoding.code || '';
        if (item.value) return String(item.value);
      }
    }
    return null;
  }

  /**
   * Extract a display from a dependsOn or product list by attribute name.
   */
  // eslint-disable-next-line no-unused-vars
  getDependsOnDisplay(list, attribute) {
    // In current FHIR, dependsOn display is not directly available;
    // would require a lookup. Return null for now (matches Java which also returns null).
    return null;
  }

  /**
   * Extract a property value from a target's property list by code.
   */
  getPropertyValueFromList(list, code) {
    if (!list) return '';
    const results = [];
    for (const item of list) {
      if (item.code === code) {
        // R5 MappingPropertyComponent uses value[x]
        if (item.valueCode !== undefined) results.push(item.valueCode);
        else if (item.valueString !== undefined) results.push(item.valueString);
        else if (item.valueCoding !== undefined) results.push(item.valueCoding.code || '');
        else if (item.valueBoolean !== undefined) results.push(String(item.valueBoolean));
        else if (item.valueInteger !== undefined) results.push(String(item.valueInteger));
        else if (item.valueDecimal !== undefined) results.push(String(item.valueDecimal));
        else if (item.valueDateTime !== undefined) results.push(item.valueDateTime);
      }
    }
    return results.join(', ');
  }

  /**
   * Render the unmapped section for a group, if present.
   * Currently a stub matching the Java implementation.
   */
  addUnmapped(tbl, grp) {
    if (grp.unmapped) {
      // TODO: render unmapped mode/code/url when needed
    }
  }

  featureSummary(ext) {
    let defn = Extensions.readString(ext, 'definition');
    let value = Extensions.readString(ext, 'value');
    switch (defn) {
      case 'http://hl7.org/fhir/uv/tx-tests/FeatureDefinition/test-version':
        return 'Tx Test version = ' + value;
      case 'http://hl7.org/fhir/uv/tx-ecosystem/FeatureDefinition/CodeSystemAsParameter':
        return 'CodeSystems as parameters = ' + value;
      default:
        return defn+' = ' + value;
    }
  }

  readFilterOp(f) {
    if (f._op) {
      return Extensions.readString(f._op, 'http://hl7.org/fhir/5.0/StructureDefinition/extension-ValueSet.compose.include.filter.op');
    } else {
      return f.op;
    }
  }

}

module.exports = { Renderer, VALID_FILTER_OPS };
