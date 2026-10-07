const {Languages, LanguageDefinitions} = require("../library/languages");
const { validateResource, strToBool, getValuePrimitive, validateParameter, Utilities} = require("../library/utilities");
const {Issue} = require("./library/operation-outcome");
const {I18nSupport} = require("../library/i18nsupport");

class VersionRule {
  system;
  version;
  mode;

  constructor(system, version, vs, mode = null) {
    this.system = system;
    this.version = version;
    this.vs = vs;
    this.mode = mode;
  }
  asString() {
    return this.mode + ':' + this.system + '#' + this.version;
  }

  asParam() {
    switch (this.mode) {
      case 'default': return (this.vs ? "default-valueset-version": "system-version") + '=' + this.system + '|' + this.version;
      case 'override': return (this.vs ? "force-valueset-version": "force-system-version") + '=' + this.system + '|' + this.version;
      case 'check': return (this.vs ? "check-valueset-version": "check-system-version") + '=' + this.system + '|' + this.version;
      default: throw new Error("Unsupported mode '" + this.mode + "'");
    }
  }

}

class TxParameters {
  count = -1;
  limit = -1;
  offset = -1;
  validating = false;
  abstractOk = true; // note true!
  inferSystem = false;
  sort = 'design';

  constructor(languages, i18n, validating) {
    validateParameter(languages, 'languages', LanguageDefinitions);
    validateParameter(i18n, 'i18n', I18nSupport);

    this.languageDefinitions = languages;
    this.i18n = i18n;
    this.validating = validating;
    this.FVersionRules = [];
    this.FProperties = [];
    this.FDesignations = [];
    this.supplements = new Set;
    this.FGenerateNarrative = true;

    this.FHTTPLanguages = null;
    this.FDisplayLanguages = null;
    // Whether languages were explicitly supplied by the request (vs a
    // synthesised default). Consumed by hasHTTPLanguages/hasDisplayLanguages so
    // the requested language folds into the expansion cache key.
    this.FHasHTTPLanguages = false;
    this.FHasDisplayLanguages = false;
    this.FValueSetVersionRules = null;
    this.FUid = '';

    // names of single-valued parameters that have been set explicitly, so that
    // parameters seen later with overwrite=false (i.e. from a ValueSet's
    // embedded expansion parameters) don't clobber them. See seeParameter.
    this.FSeen = new Set;

    this.FActiveOnly = false;
    this.FExcludeNested = false;
    this.FExcludeNotForUI = false;
    this.FExcludePostCoordinated = false;
    this.FIncludeDesignations = false;
    this.FIncludeDefinition = false;
    this.FDefaultToLatestVersion = false;
    this.FDisplayWarning = false;
    this.FMembershipOnly = false;
    this.FDiagnostics = false;
    this.FVersionsMatch = false;

    this.hasActiveOnly = false;
    this.hasExcludeNested = false;
    this.hasGenerateNarrative = false;
    this.hasExcludeNotForUI = false;
    this.hasExcludePostCoordinated = false;
    this.hasIncludeDesignations = false;
    this.hasIncludeDefinition = false;
    this.hasDefaultToLatestVersion = false;
    this.hasDisplayWarning = false;
    this.hasMembershipOnly = false;
    this.hasVersionsMatch = false;
  }

  readParams(params) {
    validateResource(params, "params", "Parameters");

    if (!params.parameter) {
      return;
    }
    if (this.hasParam(params, "__Content-Language")) {
      const lang = this.paramstr(params, "__Content-Language");
      this.HTTPLanguages = Languages.fromAcceptLanguage(lang, this.languageDefinitions, !this.validating);
      if (lang) this.FHasHTTPLanguages = true;
    }
    if (this.hasParam(params, "__Accept-Language")) {
      const lang = this.paramstr(params, "__Accept-Language");
      this.HTTPLanguages = Languages.fromAcceptLanguage(lang, this.languageDefinitions, !this.validating);
      if (lang) this.FHasHTTPLanguages = true;
    }

    for (let p of params.parameter) {
      // parameters that come from the request itself always win over anything
      // seen earlier (e.g. from a ValueSet's embedded expansion parameters)
      this.seeParameter(p.name, p, true);
    }

  }

  paramstr(params, name) {
    if (params.parameter) {
      for (let p of params.parameter) {
        if (p.name == name) {
          return getValuePrimitive(p);
        }
      }
    }
  }

  hasParam(params, name) {
    return params.parameter && params.parameter.find(p => p.name == name);
  }

  get HTTPLanguages() {
    return this.FHTTPLanguages;
  }

  set HTTPLanguages(value) {
    this.FHTTPLanguages = value;
  }

  get DisplayLanguages() {
    return this.FDisplayLanguages;
  }

  set DisplayLanguages(value) {
    this.FDisplayLanguages = value;
  }

  get hasHTTPLanguages() {
    return this.FHasHTTPLanguages;
  }

  get hasDisplayLanguages() {
    return this.FHasDisplayLanguages;
  }

  get hasDesignations() {
    return this.FDesignations.length > 0;
  }

  get activeOnly() {
    return this.FActiveOnly;
  }

  set activeOnly(value) {
    this.FActiveOnly = value;
    this.hasActiveOnly = true;
  }

  get excludeNested() {
    return this.FExcludeNested;
  }

  set excludeNested(value) {
    this.FExcludeNested = value;
    this.hasExcludeNested = true;
  }

  get generateNarrative() {
    return this.FGenerateNarrative;
  }

  set generateNarrative(value) {
    this.FGenerateNarrative = value;
    this.hasGenerateNarrative = true;
  }

  get excludeNotForUI() {
    return this.FExcludeNotForUI;
  }

  set excludeNotForUI(value) {
    this.FExcludeNotForUI = value;
    this.hasExcludeNotForUI = true;
  }

  get excludePostCoordinated() {
    return this.FExcludePostCoordinated;
  }

  set excludePostCoordinated(value) {
    this.FExcludePostCoordinated = value;
    this.hasExcludePostCoordinated = true;
  }

  get includeDesignations() {
    return this.FIncludeDesignations;
  }

  set includeDesignations(value) {
    this.FIncludeDesignations = value;
    this.hasIncludeDesignations = true;
  }

  get includeDefinition() {
    return this.FIncludeDefinition;
  }

  set includeDefinition(value) {
    this.FIncludeDefinition = value;
    this.hasIncludeDefinition = true;
  }

  get defaultToLatestVersion() {
    return this.FDefaultToLatestVersion;
  }

  set defaultToLatestVersion(value) {
    this.FDefaultToLatestVersion = value;
    this.hasDefaultToLatestVersion = true;
  }

  get displayWarning() {
    return this.FDisplayWarning;
  }

  set displayWarning(value) {
    this.FDisplayWarning = value;
    this.hasDisplayWarning = true;
  }

  get membershipOnly() {
    return this.FMembershipOnly;
  }

  set membershipOnly(value) {
    this.FMembershipOnly = value;
    this.hasMembershipOnly = true;
  }

  get versionsMatch() {
    return this.FVersionsMatch;
  }

  set versionsMatch(value) {
    this.FVersionsMatch = value;
    this.hasVersionsMatch = true;
  }

  get versionRules() {
    return this.FVersionRules;
  }

  get properties() {
    return this.FProperties;
  }

  get designations() {
    return this.FDesignations;
  }

  static defaultProfile(langDefs) {
    return new TxParameters(langDefs);
  }

  /**
   * Process a single parameter. This is the single place where parameter names
   * are interpreted; both the request Parameters resource (see readParams) and
   * the valueset-expansion-parameter extension route through here.
   *
   * @param {string} name - the parameter name
   * @param {Object} value - any element getValuePrimitive() understands: a
   *   Parameters.parameter entry, or the 'value' sub-extension of a
   *   valueset-expansion-parameter extension
   * @param {boolean} overwrite - true when the parameter comes from the request
   *   (later values win); false when it comes from a ValueSet's embedded
   *   expansion parameters, which must not clobber what the request set
   *   explicitly. Parameters that accumulate (version rules, designations,
   *   properties, supplements) are unaffected - they always add.
   */
  seeParameter(name, value, overwrite) {
    if (!name || !value) {
      return;
    }

    // returns false if this single-valued parameter has already been set
    // explicitly and we're not allowed to overwrite it
    const claim = (key) => {
      if (!overwrite && this.FSeen.has(key)) {
        return false;
      }
      this.FSeen.add(key);
      return true;
    };
    // string ('true') and boolean (valueBoolean) forms are both accepted, since
    // GET parameters always arrive as valueString
    const asBool = () => strToBool(getValuePrimitive(value), false);

    switch (name) {
      // -- accumulating parameters: version rules --------------------------
      case 'system-version': {
        this.seeVersionRule(getValuePrimitive(value), false, 'default');
        break;
      }
      case 'check-system-version': {
        this.seeVersionRule(getValuePrimitive(value), false, 'check');
        break;
      }
      case 'force-system-version': {
        this.seeVersionRule(getValuePrimitive(value), false, 'override');
        break;
      }
      case 'default-valueset-version': {
        this.seeVersionRule(getValuePrimitive(value), true, 'default');
        break;
      }
      case 'force-valueset-version': {
        this.seeVersionRule(getValuePrimitive(value), true, 'override');
        break;
      }
      case 'check-valueset-version': {
        this.seeVersionRule(getValuePrimitive(value), true, 'check');
        break;
      }

      // -- other accumulating parameters -----------------------------------
      case 'designation': {
        this.designations.push(getValuePrimitive(value));
        break;
      }
      case 'property': {
        // properties can arrive from the request, from an expansion parameter
        // extension, and (R6) from ValueSet.compose.property, so de-duplicate:
        // a repeat would emit the property twice and change the cache key
        const prop = getValuePrimitive(value);
        if (prop && !this.properties.includes(prop)) {
          this.properties.push(prop);
        }
        break;
      }
      case 'useSupplement': {
        this.supplements.add(getValuePrimitive(value));
        break;
      }

      // -- single valued parameters ----------------------------------------
      case 'displayLanguage': {
        if (claim('displayLanguage')) {
          const lang = getValuePrimitive(value);
          try {
            this.DisplayLanguages = Languages.fromAcceptLanguage(lang, this.languageDefinitions, !this.validating);
            if (lang) this.FHasDisplayLanguages = true;
          } catch (error) {
            throw new Issue("error", "processing", null, 'INVALID_DISPLAY_NAME', this.i18n.translate('INVALID_DISPLAY_NAME', this.HTTPLanguages, [lang]), "invalid-display").handleAsOO(400);
          }
        }
        break;
      }
      case 'no-cache': {
        // Write FUid (the field the cache key reads via hashSource); writing
        // `this.uid` was a no-op so no-cache=true never busted the cache.
        if (claim('no-cache') && asBool()) this.FUid = crypto.randomUUID();
        break;
      }
      case 'includeDesignations': {
        if (claim('includeDesignations')) this.includeDesignations = asBool();
        break;
      }
      case 'includeDefinition': {
        if (claim('includeDefinition')) this.includeDefinition = asBool();
        break;
      }
      case 'activeOnly': {
        if (claim('activeOnly')) this.activeOnly = asBool();
        break;
      }
      case 'excludeNested': {
        if (claim('excludeNested')) this.excludeNested = asBool();
        break;
      }
      case 'excludeNotForUI': {
        if (claim('excludeNotForUI')) this.excludeNotForUI = asBool();
        break;
      }
      case 'excludePostCoordinated': {
        if (claim('excludePostCoordinated')) this.excludePostCoordinated = asBool();
        break;
      }
      case 'default-to-latest-version': {
        if (claim('default-to-latest-version')) this.defaultToLatestVersion = asBool();
        break;
      }
      case 'diagnostics': {
        if (claim('diagnostics')) this.diagnostics = asBool();
        break;
      }
      case 'lenient-display-validation': {
        if (claim('lenient-display-validation')) this.displayWarning = asBool();
        break;
      }
      case 'valueset-membership-only': {
        if (claim('valueset-membership-only')) this.membershipOnly = asBool();
        break;
      }
      case 'versionsMatch': {
        if (claim('versionsMatch')) this.versionsMatch = asBool();
        break;
      }
      case 'inferSystem': {
        if (claim('inferSystem')) this.inferSystem = asBool();
        break;
      }
      case 'abstract': {
        // tri-state: only an explicit true/false changes the default (true)
        const v = getValuePrimitive(value);
        if (v === true || v === 'true') {
          if (claim('abstract')) this.abstractOk = true;
        } else if (v === false || v === 'false') {
          if (claim('abstract')) this.abstractOk = false;
        }
        break;
      }
      case 'term': // jQuery support
      case 'filter': {
        if (claim('filter')) this.filter = getValuePrimitive(value);
        break;
      }
      case 'count': {
        if (claim('count')) this.count = Utilities.parseIntOrDefault(getValuePrimitive(value), -1);
        break;
      }
      case 'offset': {
        if (claim('offset')) this.offset = Utilities.parseIntOrDefault(getValuePrimitive(value), -1);
        break;
      }
      case 'limit': {
        if (claim('limit')) this.limit = Utilities.parseIntOrDefault(getValuePrimitive(value), -1);
        break;
      }
      case 'sort': {
        if (claim('sort')) this.sort = getValuePrimitive(value);
        break;
      }

      // -- nested parameters -------------------------------------------------
      case 'profile': {
        // only meaningful from a Parameters.parameter, which can carry a resource
        const res = value.resource;
        if (res && (res.resourceType === 'Parameters' || res.resourceType === 'ExpansionProfile')) {
          this.readParams(res);
        }
        break;
      }

      case 'exclude-system': {
        throw new Issue('error', 'not-supported', null, null, "The parameter 'exclude-system' is not supported by this system", null, 400);
      }
    }
  }

  /**
   * Read parameters a ValueSet declares on its own compose. Presently that's
   * R6's ValueSet.compose.property (0..* code) - the properties to return in
   * the expansion, named by the value set rather than by the request. We don't
   * formally support R6, but the element is harmless in earlier versions and
   * honouring it costs nothing.
   *
   * @param {Object} compose - ValueSet.compose (raw JSON)
   */
  seeCompose(compose) {
    if (compose && Array.isArray(compose.property)) {
      for (const prop of compose.property) {
        if (typeof prop === 'string') {
          this.seeParameter('property', {valueCode: prop}, false);
        }
      }
    }
  }

  getVersionForRule(systemURI, mode) {
    for (let rule of this.FVersionRules) {
      if (rule.system === systemURI && rule.mode === mode) {
        return rule.version;
      }
    }
    return '';
  }

  rulesForSystem(systemURI) {
    let result = [];
    for (let t of this.FVersionRules) {
      if (t.system === systemURI) {
        result.push(t);
      }
    }
    return result;
  }

  seeVersionRule(url, vs, mode) {
    let sl = url ? url.split('|') : [];
    if (sl.length === 2) {
      this.versionRules.push(new VersionRule(sl[0], sl[1], vs, mode));
    } else {
      throw new Error('Unable to understand ' + mode + ' system version "' + url + '"');
    }
  }

  workingLanguages() {
    if (this.FDisplayLanguages) {
      return this.FDisplayLanguages;
    } else {
      return this.FHTTPLanguages;
    }
  }

  langSummary() {
    if (this.FDisplayLanguages) {
      return this.FDisplayLanguages.asString(false);
    } else if (this.FHTTPLanguages) {
      return this.FHTTPLanguages.asString(false);
    } else {
      return '--';
    }
  }

  summary() {
    let result = '';

    const commaAdd = (r, s) => {
      if (!r) return s;
      return r + ', ' + s;
    };

    const b = (s, v) => {
      if (v) {
        result = commaAdd(result, s);
      }
    };

    const sv = (s, v) => {
      if (v) {
        result = commaAdd(result, s + '=' + v);
      }
    };

    sv('uid', this.FUid);
    if (this.FProperties) {
      sv('properties', this.FProperties.join(','));
    }
    if (this.FHTTPLanguages) {
      sv('http-lang', this.FHTTPLanguages.asString(true));
    }
    if (this.FDisplayLanguages) {
      sv('disp-lang', this.FDisplayLanguages.asString(true));
    }
    if (this.FDesignations) {
      sv('designations', this.FDesignations.join(','));
    }
    b('active-only', this.FActiveOnly);
    b('exclude-nested', this.FExcludeNested);
    b('generate-narrative', this.FGenerateNarrative);
    b('for-ui', this.FExcludeNotForUI);
    b('exclude-post-coordinated', this.FExcludePostCoordinated);
    b('include-designations', this.FIncludeDesignations);
    b('include-definition', this.FIncludeDefinition);
    b('membership-only', this.FMembershipOnly);
    b('versions-match', this.FVersionsMatch);
    b('default-to-latest', this.FDefaultToLatestVersion);
    b('display-warning', this.FDisplayWarning);

    return result;
  }

  verSummary() {
    let result = '';
    for (let p of this.FVersionRules) {
      if (!result) {
        result = p.asString();
      } else {
        result = result + ', ' + p.asString();
      }
    }
    return result;
  }

  hashSource() {
    const b = (v) => {
      return v ? '1|' : '0|';
    };

    let s = '|'+this.count+'|'+this.limit+'|'+this.offset+
      this.FUid + '|' + b(this.FMembershipOnly) + '|' + b(this.FVersionsMatch)+'|' + this.FProperties.join(',') + '|' +
      b(this.FActiveOnly) + b(this.FDisplayWarning) + b(this.FExcludeNested) + b(this.FGenerateNarrative) + b(this.FExcludeNotForUI) + b(this.FExcludePostCoordinated) +
      b(this.FIncludeDesignations) + b(this.FIncludeDefinition) + b(this.hasActiveOnly) + b(this.hasExcludeNested) + b(this.hasGenerateNarrative) +
      b(this.hasExcludeNotForUI) + b(this.hasExcludePostCoordinated) + b(this.hasIncludeDesignations) + this.sort+'|'+
      b(this.hasIncludeDefinition) + b(this.hasDefaultToLatestVersion) + b(this.hasDisplayWarning) + b(this.hasExcludeNotForUI) + b(this.hasMembershipOnly) + b(this.hasVersionsMatch) + b(this.FDefaultToLatestVersion);

    if (this.hasHTTPLanguages) {
      s = s + this.FHTTPLanguages.asString(true) + '|';
    }
    if (this.hasDisplayLanguages) {
      s = s + '*' + this.FDisplayLanguages.asString(true) + '|';
    }
    if (this.hasDesignations) {
      s = s + this.FDesignations.join(',') + '|';
    }
    if (this.supplements && this.supplements.size > 0) {
      // useSupplement changes the expansion result (and a bad supplement must
      // error), so it must be part of the cache key. Sort for determinism.
      s = s + '$' + [...this.supplements].sort().join(',') + '|';
    }
    // Further result-affecting parameters that were previously omitted from the
    // key: the text filter (changes which codes expand), whether abstract codes
    // are included, and diagnostics.
    // filter is free text, so JSON.stringify it to avoid delimiter collisions.
    s = s + 'f:' + JSON.stringify(this.filter || '') + '|' +
      b(this.abstractOk) + b(this.diagnostics);
    for (let t of this.FVersionRules) {
      s = s + t.asString() + '|';
    }
    for (let t of this.FValueSetVersionRules || []) {
      s = s + t.asString() + '|';
    }

    return s;
  }

  link() {
    return this;
  }

  clone() {
    let result = new TxParameters(this.languageDefinitions, this.i18n, this.validating);
    result.assign(this);
    return result;
  }

  assign(other) {
    if (other.FVersionRules) {
      this.FVersionRules = [...other.FVersionRules];
    }
    if (other.FValueSetVersionRules) {
      this.FValueSetVersionRules = [...other.FValueSetVersionRules];
    }
    this.FActiveOnly = other.FActiveOnly;
    this.FExcludeNested = other.FExcludeNested;
    this.FGenerateNarrative = other.FGenerateNarrative;
    this.FExcludeNotForUI = other.FExcludeNotForUI;
    this.FExcludePostCoordinated = other.FExcludePostCoordinated;
    this.FIncludeDesignations = other.FIncludeDesignations;
    this.FIncludeDefinition = other.FIncludeDefinition;
    this.FUid = other.FUid;
    this.FMembershipOnly = other.FMembershipOnly;
    this.FVersionsMatch = other.FVersionsMatch;
    this.FDefaultToLatestVersion = other.FDefaultToLatestVersion;
    this.FDisplayWarning = other.FDisplayWarning;
    this.FDiagnostics = other.FDiagnostics;
    this.hasActiveOnly = other.hasActiveOnly;
    this.hasExcludeNested = other.hasExcludeNested;
    this.hasGenerateNarrative = other.hasGenerateNarrative;
    this.hasExcludeNotForUI = other.hasExcludeNotForUI;
    this.hasExcludePostCoordinated = other.hasExcludePostCoordinated;
    this.hasIncludeDesignations = other.hasIncludeDesignations;
    this.hasIncludeDefinition = other.hasIncludeDefinition;
    this.hasDefaultToLatestVersion = other.hasDefaultToLatestVersion;
    this.hasVersionsMatch = other.hasVersionsMatch;
    this.hasDisplayWarning = other.hasDisplayWarning;
    this.sort = other.sort;

    if (other.FSeen) {
      this.FSeen = new Set(other.FSeen);
    }

    if (other.FProperties) {
      this.FProperties = [...other.FProperties];
    }

    if (other.FDesignations) {
      this.FDesignations = [...other.FDesignations];
    }

    if (other.FHTTPLanguages) {
      this.FHTTPLanguages = other.FHTTPLanguages;
      this.FHasHTTPLanguages = this.FHasHTTPLanguages || other.FHasHTTPLanguages;
    }
    if (other.FDisplayLanguages) {
      this.FDisplayLanguages = other.FDisplayLanguages;
      this.FHasDisplayLanguages = this.FHasDisplayLanguages || other.FHasDisplayLanguages;
    }
  }

  logInfo() {
    return ""; // any parameters worth logging
  }
}

module.exports = { TxParameters, VersionRule };