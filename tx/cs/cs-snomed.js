const { CodeSystemContentMode, CodeSystemFactoryProvider, cannotDetermineSubsumption} = require('./cs-api');
const {
  SnomedStrings, SnomedWords, SnomedStems, SnomedReferences,
  SnomedDescriptions, SnomedDescriptionIndex, SnomedConceptList,
  SnomedRelationshipList, SnomedReferenceSetMembers, SnomedReferenceSetIndex,
  SnomedFileReader
} = require('../sct/structures');
const {
  SnomedExpressionServices, SnomedExpression, SnomedConcept,
  SnomedExpressionParser, NO_REFERENCE, SnomedServicesRenderOption
} = require('../sct/expressions');
const {DesignationUse} = require("../library/designations");
const {BaseCSServices} = require("./cs-base");
const {formatDateMMDDYYYY} = require("../../library/utilities");
const {ConceptMap} = require("../library/conceptmap");
const {ECLLexer, ECLParser, ECLNodeType, ECLTokenType} = require("../sct/ecl");
const {Issue} = require("../library/operation-outcome");
const {debugLog} = require("../operation-context");
const {editionName, editionCode} = require("../sct/editions");
const {SnomedTextIndex, rankMatches, filterTokens} = require("../sct/text-index");
const Logger = require("../../library/logger");

// Symbol key under which a resolved ECL filter analysis is memoised directly on
// the ValueSet compose.include.filter element (`fc`). Symbol-keyed and defined
// non-enumerable, so it never serialises, clones, or spreads into a response;
// it lives and dies with the filter element (and thus the cached ValueSet).
// Value: Map(codeSystemUrl|version -> {descendants, members, matches, eclAst}).
// SNOMED editions vary the url (and always have a version), so both url and
// version are part of the key. Only iteration-INSENSITIVE ECL is cached (see
// _cacheEcl): a wildcard's materialised form depends on forIteration and is not
// shared - it simply recomputes.
const SNOMED_FILTER_ANALYSIS = Symbol('snomedFilterAnalysis');

/**
 * Alternate identifier schemes (sct2_Identifier) that FHIRsmith knows how to present:
 * the code system the identifiers are codes in, and the $lookup property they are
 * returned as. An identifier in an unknown scheme is kept but not reported.
 */
const IDENTIFIER_SCHEMES = {
  '30051010000102': { system: 'http://loinc.org', property: 'loinc', alias: 'LOINC' }   // |LOINC code identifier| (LOINC Extension)
};

/** The $expand / ECL-free filter on alternate identifiers: mapped:<scheme> exists true|false */
const MAPPED_FILTER_PREFIX = 'mapped:';

// Description language index -> language code. The index is assigned at import
// time by SnomedImporter.mapLanguageCode(); this table is its inverse and must
// be kept in step with it.
const SCT_LANGUAGE_CODES = {
  1: 'en',
  2: 'fr',
  3: 'nl',
  4: 'es',
  5: 'sv',
  6: 'da',
  7: 'de',
  8: 'it',
  9: 'cs'
};

// ECL dialect aliases (ECL specification, appendix "Dialect aliases") to the
// language reference set they denote. Used by {{ D dialect = en-gb }}.
const ECL_DIALECT_ALIASES = {
  'en-us': '900000000000509007',
  'en-gb': '900000000000508004',
  'en-au': '32570271000036106',
  'en-ca': '19491000087109',
  'en-nz': '271000210107',
  'en-ie': '21000220103',
  'fr-ca': '20581000087109',
  'fr-be': '21000172104',
  'nl-be': '31000172101',
  'nl-nl': '31000146106',
  'es-es': '448879004',
  'sv-se': '46011000052107',
  'da-dk': '554461000005103'
};

// Context kinds matching Pascal enum
const SnomedProviderContextKind = {
  CODE: 0,
  EXPRESSION: 1
};

/**
 * SNOMED Expression Context - represents either a simple concept or complex expression
 */
class SnomedExpressionContext {
  constructor(source = '', expression = null) {
    this.source = source;
    this.expression = expression;
  }

  static fromReference(reference) {
    const expression = new SnomedExpression();
    expression.concepts.push(new SnomedConcept(reference));
    return new SnomedExpressionContext('', expression);
  }

  static fromCode(code, reference) {
    const expression = new SnomedExpression();
    const concept = new SnomedConcept(reference);
    concept.code = code;
    expression.concepts.push(concept);
    return new SnomedExpressionContext(code, expression);
  }

  static fromExpression(source, expression) {
    return new SnomedExpressionContext(source, expression);
  }

  isComplex() {
    return this.expression && this.expression.isComplex();
  }

  isSimple() {
    return this.expression && this.expression.isSimple();
  }

  getReference() {
    return this.expression && this.expression.concepts.length > 0
        ? this.expression.concepts[0].reference
        : NO_REFERENCE;
  }

  getCode() {
    if (this.source) return this.source;
    return this.expression && this.expression.concepts.length > 0
        ? this.expression.concepts[0].code
        : '';
  }
}

/**
 * Filter context for SNOMED filtering operations
 */
class SnomedFilterContext {
  constructor() {
    this.ndx = 0;
    this.cursor = 0;
    this.matches = [];
    this.members = [];
    this.descendants = [];
    this.expressions = undefined; // special use
  }
}

class SnomedPrep {
  constructor() {
    this.filters = [];
  }
}

/**
 * Core SNOMED services providing access to structures and expression processing
 */
class SnomedServices {
  constructor(sharedData) {
    // Core data structures
    this.strings = new SnomedStrings(sharedData.strings);
    this.words = new SnomedWords(sharedData.words);
    this.stems = new SnomedStems(sharedData.stems);
    // Free-text search index, built on first search (see getTextIndex)
    this._textIndex = null;
    this._textIndexPromise = null;
    this.refs = new SnomedReferences(sharedData.refs);
    this.descriptions = new SnomedDescriptions(sharedData.desc);
    this.descriptionIndex = new SnomedDescriptionIndex(sharedData.descRef);
    this.concepts = new SnomedConceptList(sharedData.concept);
    this.relationships = new SnomedRelationshipList(sharedData.rel);
    this.refSetIndex = new SnomedReferenceSetIndex(sharedData.refSetIndex, sharedData.hasLangs);
    this.refSetMembers = new SnomedReferenceSetMembers(sharedData.refSetMembers);

    // Metadata
    this.versionUri = sharedData.versionUri;
    this.versionDate = sharedData.versionDate;
    this.edition = sharedData.edition;
    this.version = sharedData.version;
    this.totalCount = this.concepts.count();

    // Indexes and roots
    this.isAIndex = sharedData.isAIndex;
    this.activeRoots = sharedData.activeRoots;
    this.inactiveRoots = sharedData.inactiveRoots;
    this.defaultLanguage = sharedData.defaultLanguage;
    this.isTesting = sharedData.isTesting;

    // Expression services
    this.expressionServices = new SnomedExpressionServices({
      strings: this.strings,
      words: this.words,
      stems: this.stems,
      refs: this.refs,
      descriptions: this.descriptions,
      descriptionIndex: this.descriptionIndex,
      concepts: this.concepts,
      relationships: this.relationships,
      refSetMembers: this.refSetMembers,
      refSetIndex: this.refSetIndex
    }, this.isAIndex);

    // The expression services check the MRCM attribute ranges, but those are ECL
    // and the ECL engine lives here, so hand them an evaluator. Returning null
    // means "could not decide", and leaves the value unchecked.
    this.expressionServices.eclConstraintMatcher = (constraint, value) => this.mrcmRangeSatisfied(constraint, value);
    this._mrcmRangeCache = new Map();

    this.#loadIdentifiers(sharedData.identifiers || []);
    this.#loadConcreteValues(sharedData.concreteValues);
  }

  /**
   * Index the concrete value relationships (cache version 19: rows of
   * [sourceId, typeId, group, value], value as written in RF2 - "#500", "#5.5",
   * a quoted string, or true/false) by source concept index, for the ECL
   * evaluator. `concreteValues` stays null when the cache predates them, which
   * is how a concrete-value refinement knows to report itself as unsupported
   * rather than answering with nothing.
   */
  #loadConcreteValues(rows) {
    this.concreteValues = null;
    if (!rows) return;
    this.concreteValues = new Map();
    for (const [sourceId, typeId, group, raw] of rows) {
      const src = this.concepts.findConcept(sourceId);
      const type = this.concepts.findConcept(typeId);
      if (!src.found || !type.found) continue;
      let value;
      if (/^#-?\d+(\.\d+)?$/.test(raw)) {
        value = { kind: 'number', value: Number(raw.substring(1)), decimal: raw.includes('.') };
      } else if (/^".*"$/.test(raw)) {
        value = { kind: 'string', value: raw.substring(1, raw.length - 1) };
      } else if (/^(true|false)$/i.test(raw)) {
        value = { kind: 'boolean', value: raw.toLowerCase() === 'true' };
      } else {
        value = { kind: 'string', value: raw };
      }
      const list = this.concreteValues.get(src.index) || [];
      list.push({ relType: type.index, group: group || 0, concrete: value });
      this.concreteValues.set(src.index, list);
    }
  }

  /**
   * Index the alternate identifiers (sct2_Identifier rows, active only, as
   * [scheme, module, code, conceptId]) both ways: concept -> identifiers, and
   * scheme|code -> concepts. Also which modules carry identifiers, since each such
   * module defines an implicit map (?fhir_cm=<module>).
   */
  #loadIdentifiers(rows) {
    this.identifiersByConcept = new Map();
    this.conceptsByIdentifier = new Map();
    this.identifierModules = new Map(); // module -> Set of schemes
    for (const [scheme, module, code, conceptId] of rows) {
      const entry = { scheme, module, code };
      if (!this.identifiersByConcept.has(conceptId)) {
        this.identifiersByConcept.set(conceptId, []);
      }
      this.identifiersByConcept.get(conceptId).push(entry);
      const key = scheme + '|' + code;
      if (!this.conceptsByIdentifier.has(key)) {
        this.conceptsByIdentifier.set(key, []);
      }
      this.conceptsByIdentifier.get(key).push(conceptId);
      if (!this.identifierModules.has(module)) {
        this.identifierModules.set(module, new Set());
      }
      this.identifierModules.get(module).add(scheme);
    }
  }

  /** The alternate identifiers of a concept (by id), optionally only those of one scheme */
  getIdentifiers(conceptId, scheme = null) {
    const list = this.identifiersByConcept.get(String(conceptId)) || [];
    return scheme ? list.filter(i => i.scheme === scheme) : list;
  }

  /** The concept ids that have the given code in the given scheme */
  getConceptsForIdentifier(scheme, code) {
    return this.conceptsByIdentifier.get(scheme + '|' + code) || [];
  }

  /**
   * Does this refinement value satisfy an MRCM range constraint?
   *
   * @param {string} constraint - the rangeConstraint ECL, e.g. "<< 182353008 |Side|"
   * @param {SnomedExpression} value - the refinement's value expression
   * @returns {boolean|null} null when the constraint cannot be evaluated
   */
  mrcmRangeSatisfied(constraint, value) {
    let entry = this._mrcmRangeCache.get(constraint);
    if (entry === undefined) {
      entry = null;
      try {
        const ast = new ECLParser(new ECLLexer(constraint).tokenize()).parse();
        const ctxt = this._evalECLNode(ast, null);
        entry = {
          ast: ast,
          wildcard: !!ctxt.eclWildcard,
          members: new Set(this._eclToIndexArray(ctxt))
        };
      } catch (error) {
        // Concrete value ranges (dec/int/str) and anything else the ECL engine
        // does not support: remembered as unusable so it is parsed only once.
        entry = null;
      }
      this._mrcmRangeCache.set(constraint, entry);
    }
    if (!entry) {
      return null;
    }
    if (entry.wildcard) {
      return true;
    }

    const concepts = (value.concepts || []).filter(c => c.reference != null && c.reference !== NO_REFERENCE);
    const refined = value.hasRefinements() || value.hasRefinementGroups();
    if (!refined) {
      if (concepts.length === 0) {
        return null; // a concrete value, or nothing we can resolve
      }
      // Every focus concept of a plain value must be in the constraint's set.
      return concepts.every(c => entry.members.has(c.reference));
    }
    // A refined value: ask the ECL engine whether the expression satisfies the
    // constraint (it knows that a refinement of X is still << X).
    return this._eclExpressionSatisfies({ expression: value }, entry.ast, null);
  }

  close() {
    // Cleanup if needed
  }

  getSystemUri() {
    return 'http://snomed.info/sct';
  }

  getVersion() {
    return this.versionUri;
  }

  getDescription() {
    return `SNOMED CT ${getEditionName(this.edition)}`;
  }

  name() {
    return `SCT ${getEditionCode(this.edition)}`;
  }

  stringToIdOrZero(str) {
    try {
      if (!str) return 0n;
      return BigInt(str);
    } catch {
      return 0n;
    }
  }

  stringToId(str) {
    return BigInt(str);
  }

  getConceptId(reference) {
    try {
      const concept = this.concepts.getConcept(reference);
      return concept.identity.toString();
    } catch (error) {
      return reference.toString();
    }
  }

  conceptExists(conceptId) {
    const id = this.stringToIdOrZero(conceptId);
    if (id === 0n) return false;

    const result = this.concepts.findConcept(id);
    return result.found;
  }

  isActive(reference) {
    try {
      const concept = this.concepts.getConcept(reference);
      // Check status flags - active concepts typically have status 0
      return (concept.flags & 0x0F) === 0;
    } catch (error) {
      return false;
    }
  }

  // Count of active concepts (status nibble == 0), computed once and cached.
  // Concepts are fixed-size records addressed by byte offset, so iterate by
  // ordinal via getConceptByCount. Used by the count=0 expansion fast path.
  activeConceptCount() {
    if (this._activeConceptCount != null) return this._activeConceptCount;
    let n = 0;
    const total = this.concepts.count();
    for (let ord = 0; ord < total; ord++) {
      const c = this.concepts.getConceptByCount(ord);
      if ((c.flags & 0x0F) === 0) n++;
    }
    this._activeConceptCount = n;
    return n;
  }

  isPrimitive(reference) {
    try {
      const concept = this.concepts.getConcept(reference);
      // Check primitive flag
      return (concept.flags & 0x10) !== 0;
    } catch (error) {
      return true; // Assume primitive if can't read
    }
  }

  subsumes(parentRef, childRef) {
    if (parentRef === childRef) {
      return true;
    }

    try {
      // Get the closure (all descendants) for parent concept
      const closureRef = this.concepts.getAllDesc(parentRef);

      if (closureRef === 0 || closureRef === 0xFFFFFFFF) {
        return false;
      }

      const descendants = this.refs.getReferences(closureRef);
      if (!descendants) {
        return false;
      }
      // The closure array is stored sorted ascending (see the importer's
      // buildConceptClosure), so membership is a binary search rather than a
      // linear scan - this is the hot path for is-a and ECL refinement checks.
      let lo = 0;
      let hi = descendants.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const v = descendants[mid];
        if (v === childRef) {
          return true;
        } else if (v < childRef) {
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      return false;
    } catch (error) {
      return false;
    }
  }

  // Key concept indexes used for preferred-term selection, resolved once per
  // loaded edition. US English (900000000000509007) is the global default
  // language reference set for display.
  _displayConstants() {
    if (this._dispConst) return this._dispConst;
    const idx = (id) => { const r = this.concepts.findConcept(id); return r.found ? r.index : -1; };
    this._dispConst = {
      usRefset: idx(900000000000509007n),   // US English language reference set
      preferred: idx(900000000000548007n),  // Preferred
      synonym: idx(900000000000013009n),    // Synonym
      fsn: idx(900000000000003001n)         // Fully specified name
    };
    return this._dispConst;
  }

  // Ordered display language reference set(s) for the loaded edition. SNOMED's
  // default display language differs by edition, and a concept can carry a
  // preferred synonym in more than one dialect at once (the International
  // edition ships both US English 509007 and GB English 508004, each marking a
  // different synonym Preferred). The edition default decides which term is
  // shown.
  //
  // Editions not listed here default to English (US then GB) rather than to
  // "preferred synonym in any language refset". A national edition carries a
  // Preferred synonym in each of its own language refsets as well as in English
  // (e.g. the Belgian edition 11000172109 marks a French term Preferred in
  // 21000172104 and a Dutch one in 31000172101), so "any refset" resolved to
  // whichever description happened to be stored first - French for one concept,
  // Dutch for the next, English for a third. A caller who asked for no
  // particular language got an arbitrary mix. English is the only defensible
  // default: it is the one language every edition has, and it is what a request
  // with no displayLanguage is taken to mean everywhere else in the server. An
  // edition with no English at all still falls through to the any-refset step
  // below, so nothing regresses.
  _displayRefsetOrder() {
    if (this._dispOrder) return this._dispOrder;
    const idx = (id) => { const r = this.concepts.findConcept(id); return r.found ? r.index : -1; };
    const US = 900000000000509007n;   // US English
    const GB = 900000000000508004n;   // GB English
    const byEdition = {
      '900000000000207008': [US],       // International Edition (US English is the default)
      '31000003106': [US],              // tx-ecosystem test edition (International-derived, US English default)
      '731000124108': [US],             // US Edition
      '5991000124107': [US],            // US Edition (with ICD-10-CM maps)
      '83821000000107': [GB],           // UK Edition
      '999000021000000109': [GB]        // UK Clinical Edition
    };
    const ids = byEdition[String(this.edition)] || [US, GB];
    this._dispOrder = ids.map(idx).filter((i) => i >= 0);
    return this._dispOrder;
  }

  // Acceptability (a concept index, e.g. Preferred/Acceptable) of a description
  // within the given language reference set, or -1 if it is not a member.
  _descAcceptability(description, refsetIndex) {
    if (!description.refsets || !description.valueses) return -1;
    const refsets = this.refs.getReferences(description.refsets);
    const valueses = this.refs.getReferences(description.valueses);
    if (!refsets || !valueses) return -1;
    for (let i = 0; i < refsets.length; i++) {
      if (refsets[i] === refsetIndex) {
        const vals = this.refs.getReferences(valueses[i]); // [acceptabilityIndex, type]
        return (vals && vals.length > 0) ? vals[0] : -1;
      }
    }
    return -1;
  }

  // True if the description is a synonym marked Preferred (900000000000548007)
  // in ANY of its language reference sets. Editions use different English
  // language refsets (International US-English 509007, GB 508004, US extension,
  // ...), so we accept a preferred marking in any of them rather than a single
  // hard-coded refset. (Multi-language dialect selection is a separate concern.)
  _synonymIsPreferred(description) {
    const K = this._displayConstants();
    if (description.kind !== K.synonym) return false;
    if (!description.valueses) return false;
    const valueses = this.refs.getReferences(description.valueses);
    if (!valueses) return false;
    for (let i = 0; i < valueses.length; i++) {
      const vals = this.refs.getReferences(valueses[i]); // [acceptabilityIndex, type]
      if (vals && vals.length > 0 && vals[0] === K.preferred) return true;
    }
    return false;
  }

  // Return a concept's display, together with the language it is actually in:
  // the synonym marked Preferred in the edition's display language reference
  // set; failing that a preferred synonym in any language refset; failing that
  // the FSN; failing that the first active description. Previously this
  // returned the first active description outright, which is only the preferred
  // term by accident of import order.
  //
  // The language matters as much as the term: the display is emitted as a
  // designation (DesignationUse.DISPLAY) during $expand, and tagging a French
  // term as en-US puts it in an IG's English display column and makes the real
  // French designation look like a duplicate.
  //
  // Returns {term, lang} - lang is a language code, or null when no description
  // could be read.
  getDisplayNameEx(reference = 0) {
    const none = { term: '', lang: null };
    try {
      const concept = this.concepts.getConcept(reference);
      const descriptionsRef = concept.descriptions;

      if (descriptionsRef === 0) {
        return none;
      }

      const descriptionIndices = this.refs.getReferences(descriptionsRef);
      const K = this._displayConstants();
      const pick = (description) => ({
        term: this.strings.getEntry(description.iDesc).trim(),
        lang: SCT_LANGUAGE_CODES[description.lang] || 'en'
      });

      // 1. Preferred synonym in the edition's default display refset(s), tried
      //    in priority order. This is what disambiguates dialects: on the
      //    International edition a concept may be Preferred in both US and GB
      //    English, and the edition default (US English) must win. It is also
      //    what keeps a multi-language national edition from picking a
      //    different language for each concept.
      for (const refsetIdx of this._displayRefsetOrder()) {
        for (const descIndex of descriptionIndices) {
          const description = this.descriptions.getDescription(descIndex);
          if (!description.active || description.kind !== K.synonym) continue;
          if (this._descAcceptability(description, refsetIdx) === K.preferred) {
            return pick(description);
          }
        }
      }

      // 2. Fallback: preferred synonym in ANY language refset; then FSN; then
      //    the first active description. Reached only by editions with no
      //    English language refset at all, and by concepts with no preferred
      //    synonym in the edition's display refsets.
      let fsn = null;
      let firstActive = null;
      for (const descIndex of descriptionIndices) {
        const description = this.descriptions.getDescription(descIndex);
        if (!description.active) continue;
        if (firstActive === null) firstActive = pick(description);
        if (this._synonymIsPreferred(description)) {
          return pick(description); // preferred synonym (any language refset)
        }
        if (description.kind === K.fsn && fsn === null) {
          fsn = pick(description);
        }
      }
      return fsn || firstActive || none;
    } catch (error) {
      return none;
    }
  }

  getDisplayName(reference = 0) {
    return this.getDisplayNameEx(reference).term;
  }

  getConceptDescendants(reference) {
    try {
      const allDescRef = this.concepts.getAllDesc(reference);
      if (allDescRef === 0 || allDescRef === 0xFFFFFFFF) {
        return [];
      }
      return this.refs.getReferences(allDescRef) || [];
    } catch (error) {
      return [];
    }
  }

  getConceptChildren(reference) {
    try {
      const concept = this.concepts.getConcept(reference);
      const inboundsRef = concept.inbounds;

      if (inboundsRef === 0) return [];

      const inbounds = this.refs.getReferences(inboundsRef);
      const children = [];

      for (const relIndex of inbounds) {
        const rel = this.relationships.getRelationship(relIndex);
        if (rel.active && rel.relType === this.isAIndex && rel.group === 0) {
          children.push(rel.source);
        }
      }

      return children;
    } catch (error) {
      return [];
    }
  }

  getConceptParents(reference) {
    try {
      const concept = this.concepts.getConcept(reference);
      const parentsRef = concept.parents;

      if (parentsRef === 0) return [];

      return this.refs.getReferences(parentsRef) || [];
    } catch (error) {
      return [];
    }
  }

  getConceptRelationships(reference) {
    try {
      const concept = this.concepts.getConcept(reference);
      const relRef = concept.outbounds;

      if (relRef === 0) return [];

      return this.refs.getReferences(relRef) || [];
    } catch (error) {
      return [];
    }
  }

  /**
   * The module this edition is published under, as a concept index (0 if it cannot be found),
   * taken from the edition URI http://snomed.info/[x]sct/<module>[/version/<date>]
   */
  editionModule() {
    const m = /^http:\/\/snomed\.info\/x?sct\/(\d+)/.exec(this.getVersion() || '');
    if (!m) return 0;
    const r = this.concepts.findConcept(m[1]);
    return r.found ? r.index : 0;
  }

  /**
   * The module dependency reference set (900000000000534007). Found by its defining concept
   * when that is present; a subontology extract may carry the members without the concept,
   * so the filename-derived refset name is the fallback.
   * @returns {object|null} the reference set record
   */
  moduleDependencyRefSet() {
    if (this._mdrs !== undefined) return this._mdrs;
    this._mdrs = null;
    const r = this.concepts.findConcept('900000000000534007');
    for (let i = 0; i < this.refSetIndex.count(); i++) {
      const rs = this.refSetIndex.getReferenceSet(i);
      if ((r.found && rs.definition === r.index) || this.strings.getEntry(rs.name).startsWith('ModuleDependency')) {
        this._mdrs = rs;
        break;
      }
    }
    return this._mdrs;
  }

  /**
   * The modules that the given module depends on, per the module dependency reference set:
   * [{module: <concept index>, sourceEffectiveTime, targetEffectiveTime}]. Only the direct
   * dependencies - the dependencies of those modules are their own rows.
   */
  moduleDependencies(moduleIndex) {
    const rs = this.moduleDependencyRefSet();
    if (!rs || !moduleIndex) return [];
    const result = [];
    for (const m of this.refSetMembers.getMembers(rs.membersByRef)) {
      if (m.module !== moduleIndex || !m.ref) continue;
      // values are [value, type, value, type...]; both fields here are strings
      const vals = m.values ? this.refs.getReferences(m.values) || [] : [];
      const str = (i) => vals.length > i && vals[i + 1] === 5 ? this.strings.getEntry(vals[i]) : null;
      result.push({ module: m.ref, sourceEffectiveTime: str(0), targetEffectiveTime: str(2) });
    }
    return result;
  }

  /**
   * The concept indexes of all the modules that make up the edition published under the
   * given module: the module itself and, transitively, everything it depends on.
   */
  editionModules(moduleIndex) {
    const result = new Set();
    const todo = [moduleIndex];
    while (todo.length) {
      const m = todo.pop();
      if (!m || result.has(m)) continue;
      result.add(m);
      for (const d of this.moduleDependencies(m)) todo.push(d.module);
    }
    return result;
  }

  /**
   * Translation from this edition to another edition it depends on (see
   * SnomedProvider.translateToEdition). The target is an edition URI,
   * http://snomed.info/sct/<module>[/version/<date>]; the result says which module and
   * version that is, and which modules' content belongs to it, or null if this edition
   * does not depend on it (or not on that version of it).
   */
  editionDependency(targetEdition) {
    const m = /^http:\/\/snomed\.info\/x?sct\/(\d+)(?:\/version\/(\d{8}))?$/.exec(targetEdition || '');
    if (!m) return null;
    const mine = this.editionModule();
    const target = this.concepts.findConcept(m[1]);
    if (!mine || !target.found) return null;
    for (const d of this.moduleDependencies(mine)) {
      if (d.module === target.index && (!m[2] || m[2] === d.targetEffectiveTime)) {
        const version = d.targetEffectiveTime ? `http://snomed.info/sct/${m[1]}/version/${d.targetEffectiveTime}` : `http://snomed.info/sct/${m[1]}`;
        return { moduleId: m[1], moduleIndex: target.index, version, modules: this.editionModules(target.index) };
      }
    }
    return null;
  }

  /**
   * The concept whose normal form is the given expression, if there is one. The index is
   * built on first use: every defined concept's stored normal form, rendered in the minimal
   * form so that two expressions compare as strings.
   * @param {string} rendered - the expression, rendered with SnomedServicesRenderOption.Minimal
   * @returns {number} the concept index, or -1
   */
  conceptWithNormalForm(rendered) {
    if (!this._normalFormIndex) {
      const index = new Map();
      const total = this.concepts.count();
      for (let ord = 0; ord < total; ord++) {
        const c = this.concepts.getConceptByCount(ord);
        if ((c.flags & 0x0F) !== 0 || this.concepts.getNormalForm(c.index) === 0) continue;
        try {
          const nf = this.expressionServices.createNormalForm(c.index);
          const key = this.expressionServices.renderExpression(nf, SnomedServicesRenderOption.Minimal);
          if (!index.has(key)) index.set(key, c.index);
        } catch (e) {
          // a normal form that cannot be built is simply not indexed
        }
      }
      this._normalFormIndex = index;
    }
    const r = this._normalFormIndex.get(rendered);
    return r === undefined ? -1 : r;
  }

  getConceptRefSet(conceptIndex, byName = false) {
    for (let i = 0; i < this.refSetIndex.count(); i++) {
      const refSet = this.refSetIndex.getReferenceSet(i);
      if (refSet.definition === conceptIndex) {
        return byName ? refSet.membersByName : refSet.membersByRef;
      }
    }
    return 0;
  }

  // Like getConceptRefSet, but distinguishes "this concept is not a reference
  // set" (returns null) from "it is a reference set that happens to have no
  // members" (returns a numeric membersByRef, which may be 0 or the
  // MAGIC_NO_CHILDREN sentinel). Used by memberOf to reject non-refset operands.
  _findRefSetMembersRef(conceptIndex) {
    const refSet = this._findRefSetRecord(conceptIndex);
    return refSet ? refSet.membersByRef : null;
  }

  // Filter support methods
  filterEquals(id) {
    const result = new SnomedFilterContext();
    const conceptResult = this.concepts.findConcept(id);

    if (!conceptResult.found) {
      throw new Error(`The SNOMED CT Concept ${id} is not known`);
    }

    result.descendants = [conceptResult.index];
    return result;
  }

  filterIsA(id, includeBase = true) {
    const result = new SnomedFilterContext();
    const conceptResult = this.concepts.findConcept(id);

    if (!conceptResult.found) {
      throw new Error(`The SNOMED CT Concept ${id} is not known`);
    }

    const descendants = this.getConceptDescendants(conceptResult.index);

    if (includeBase) {
      result.descendants = [conceptResult.index, ...descendants];
    } else {
      result.descendants = descendants;
    }

    return result;
  }

  filterChildOf(id = true) {
    const result = new SnomedFilterContext();
    const conceptResult = this.concepts.findConcept(id);

    if (!conceptResult.found) {
      throw new Error(`The SNOMED CT Concept ${id} is not known`);
    }

    const descendants = this.getConceptChildren(conceptResult.index);

    result.descendants = descendants;

    return result;
  }


  filterGeneralizes(id = true, opContext = null) {
    const result = new SnomedFilterContext();
    const conceptResult = this.concepts.findConcept(id);

    if (!conceptResult.found) {
      throw new Error(`The SNOMED CT Concept ${id} is not known`);
    }

    let ancestors = new Set();
    let parents = this.getConceptParents(conceptResult.index);
    let isNew = true;
    while (isNew) {
      if (opContext) opContext.deadCheck('ecl:filterGeneralizes');
      isNew = false;
      let np = [];
      for (let parent of parents) {
        if (!ancestors.has(parent)) {
          isNew = true;
          ancestors.add(parent);
          np.push(...this.getConceptParents(parent));
        }
      }
      parents = np;
    }

    result.descendants = [...ancestors];

    return result;
  }


  filterIn(idList) {
    const result = new SnomedFilterContext();
    let members = [];
    for (let id of idList.split(',')) {
      const conceptResult = this.concepts.findConcept(id);

      if (!conceptResult.found) {
        throw new Error(`The SNOMED CT Concept ${id} is not known`);
      }

      const refSetIndex = this.getConceptRefSet(conceptResult.index, false);
      if (refSetIndex === 0) {
        members.push(conceptResult.index);
      } else {
        members.push(...this.refSetMembers.getMembers(refSetIndex));
      }
    }
    result.members = members;
    return result;
  }

  filterInactive(state) {
    const result = new SnomedFilterContext();
    result.inactive = state;
    return result;
  }

  filterModuleId(id) {
    const result = new SnomedFilterContext();
    let concept = this.concepts.findConcept(id);
    result.moduleId = concept.index;
    return result;
  }

  filterByProperty(prop, value) {
    const result = new SnomedFilterContext();
    let p = this.concepts.findConcept(prop);
    let v = this.concepts.findConcept(value);
    result.propProp = p.index;
    result.propValue = v.index;
    return result;

  }

  /**
   * Supported ECL subset:
   *   Plain concept ref      404684003
   *   << (descendant-or-self-of)
   *   <! (strict descendant-of)
   *   <  (child-of)
   *   >> (ancestor-or-self-of)
   *   >! (strict ancestor-of)
   *   >  (parent-of)
   *   ^  (member-of refset)      — a concept or any bracketed expression, with
   *                                 {{ M ... }} member filters
   *   *  (wildcard)
   *   hierarchy operators on *, ^ and bracketed sets (applied per member)
   *   AND / OR / MINUS compound expressions
   *   !!> / !!< (top / bottom of set)
   *   refinements (= and != against an expression, reversed (R) attributes,
   *   attribute AND/OR/",", groups, attribute and group cardinality,
   *   attribute names that are expressions),
   *   dotted expressions, {{ C ... }} concept filters, {{ D ... }} description
   *   filters, {{ + HISTORY... }} history supplements, concrete (numeric /
   *   string / boolean) values in refinements (cache version 19+), comments
   *
   *   alternate identifiers (LOINC#code, from the identifier scheme aliases)
   *
   * Everything else (reference set field selection on ^) throws an informative
   * error which is reported as UNSUPPORTED_ECL.
   */

  /**
   * Parse an ECL expression string and return a SnomedFilterContext whose
   * `descendants` array contains the resolved concept indexes.
   *
   * Throws an Error for syntax errors, unknown concepts, or unsupported features.
   *
   * @param {string} eclExpression
   * @returns {SnomedFilterContext}
   */
  filterECL = function (eclExpression, forIteration, opContext) {
    let ast;
    try {
      const tokens = new ECLLexer(eclExpression).tokenize();
      ast = new ECLParser(tokens).parse();
    } catch (err) {
      debugLog(err);
      throw new Issue('error', 'invalid', null, 'INVALID_ECL', opContext.i18n.translate('INVALID_ECL', opContext.langs, [eclExpression, err.message]), 'vs-invalid').handleAsOO(400);
    }
    let result;
    try {
      result = this._evalECLNode(ast, opContext);
    } catch (err) {
      debugLog(err);
      // Distinguish an *invalid* ECL expression (a malformed SCTID, or a
      // reference to a concept that does not exist - the expression can never
      // be valid) from an *unsupported* one (a well-formed expression using a
      // feature this server does not implement). The tx-ecosystem test suite
      // expects INVALID_ECL for the former, UNSUPPORTED_ECL for the latter.
      // The parser has accepted the expression by now, so an evaluation error
      // means an unsupported feature - unless it is explicitly about a concept
      // that does not exist (err.eclInvalid, or the legacy "is not known" text).
      const emsg = (err && err.message) ? err.message : String(err);
      const invalid = (err && err.eclInvalid) || /is not known/.test(emsg);
      const msgId = invalid ? 'INVALID_ECL' : 'UNSUPPORTED_ECL';
      throw new Issue('error', 'invalid', null, msgId, opContext.i18n.translate(msgId, opContext.langs, [eclExpression, err.message]), 'vs-invalid').handleAsOO(400);
    }
    // Wildcard + iteration: the `eclWildcard` flag is only consulted by the
    // per-concept membership checks (filterCheck/filterLocate). For an $expand
    // we actually need the full concept list, otherwise filterSize returns 0
    // and the iteration yields nothing. Materialise active concepts now.
    if (forIteration && result.eclWildcard && (!result.descendants || result.descendants.length === 0)) {
      result.descendants = this._eclEnumerateAllConcepts(opContext);
      delete result.eclWildcard;
      // The materialised wildcard form differs from the lazy (eclWildcard) form,
      // so mark it: the filter cache must not share it across iteration modes.
      result.iterationSensitive = true;
    }
    // Keep the parsed AST so validate-code can test a post-coordinated
    // expression's membership against the constraint (see _eclExpressionSatisfies).
    result.eclAst = ast;
    return result;
  };

  /**
   * Return every concept's index. Used to materialise wildcard results when the
   * filter needs to be iterated over (e.g. $expand).
   *
   * `*` means every concept the server knows, so this deliberately walks the
   * concept table rather than descending from 138875005 |SNOMED CT Concept|.
   * Two kinds of concept are in the table but not reachable from that root:
   * inactive concepts (their is-a relationships are inactive too), and the
   * foundation-metadata concepts that a subset carries without their is-a
   * relationships - module concepts above all. Both belong in `*`, and both are
   * counted by countAllCodes, so descending from the root made $expand of a
   * `constraint = *` filter disagree with $expand of the whole code system.
   *
   * Inactive concepts are not filtered out here: activeOnly is applied by the
   * expansion itself (see ValueSetExpander.processCodes), which is what lets one
   * enumeration serve both activeOnly=true and activeOnly=false.
   * @returns {number[]}
   */
  _eclEnumerateAllConcepts = function (opContext) {
    const all = [];
    const n = this.concepts.count();
    for (let i = 0; i < n; i++) {
      if (opContext) opContext.deadCheck('ecl:enumerateAllConcepts');
      all.push(this.concepts.getConceptByCount(i).index);
    }
    return all;
  };

  /**
   * Recursive ECL AST evaluator.
   * @param {object} node
   * @returns {SnomedFilterContext}
   */
  _evalECLNode = function (node, opContext) {
    if (!node) {
      throw new Error('ECL evaluation error: null AST node');
    }
    if (opContext) opContext.deadCheck('ecl:evalNode');

    switch (node.type) {

      case ECLNodeType.SUB_EXPRESSION_CONSTRAINT:
        return this._evalSubExpression(node, opContext);

      case ECLNodeType.COMPOUND_EXPRESSION_CONSTRAINT: {
        const left = this._evalECLNode(node.left, opContext);
        const right = this._evalECLNode(node.right, opContext);
        switch (node.operator) {
          case ECLNodeType.CONJUNCTION:
            return this._eclIntersect(left, right, opContext);
          case ECLNodeType.DISJUNCTION:
            return this._eclUnion(left, right, opContext);
          case ECLNodeType.EXCLUSION:
            return this._eclMinus(left, right, opContext);
          default:
            throw new Error(`Unsupported ECL compound operator: ${node.operator}`);
        }
      }

      case ECLNodeType.REFINED_EXPRESSION_CONSTRAINT:
        return this._evalRefined(node, opContext);

      case ECLNodeType.DOTTED_EXPRESSION_CONSTRAINT:
        return this._evalDotted(node, opContext);

      default:
        // Could be a bare concept reference or wildcard passed in directly
        // (e.g. when a parenthesised expression resolves to one of these).
        if (node.type === ECLNodeType.CONCEPT_REFERENCE ||
            node.type === ECLNodeType.WILDCARD ||
            node.type === ECLNodeType.MEMBER_OF) {
          // Wrap it as if it came from a no-operator SubExpressionConstraint
          return this._evalSubExpression({type: ECLNodeType.SUB_EXPRESSION_CONSTRAINT, operator: null, focus: node}, opContext);
        }
        throw new Error(`Unsupported ECL node type: ${node.type}`);
    }
  };

  /**
   * Evaluate a SUB_EXPRESSION_CONSTRAINT node, which combines an optional
   * hierarchy operator with a focus (concept ref, wildcard, or member-of).
   * @param {object} node
   * @returns {SnomedFilterContext}
   */
  _evalSubExpression = function (node, opContext) {
    const operator = node.operator; // an ECLTokenType string, or null
    const focus = node.focus;

    // History supplements are parsed but not implemented. Member filters
    // ({{ M ... }}) are handled in _evalMemberOf; concept filters ({{ C ... }})
    // and description filters ({{ D ... }}) are applied to the result below.
    if (node.filters && node.filters.length > 0) {
      const inner = { ...node, filters: undefined };
      let ctx = this._evalSubExpression(inner, opContext);
      const conceptFilters = node.filters.filter(fc => fc.kind === 'C');
      if (conceptFilters.length > 0) {
        ctx = this._applyConceptFilters(ctx, conceptFilters, opContext);
      }
      for (const fc of node.filters.filter(fc => fc.kind === 'D')) {
        ctx = this._applyDescriptionFilter(ctx, fc.filters, opContext);
      }
      for (const fc of node.filters.filter(fc => fc.kind === '+')) {
        ctx = this._applyHistorySupplement(ctx, fc, opContext);
      }
      return ctx;
    }

    // Alternate identifiers (ECL 2.1 "scheme#code"): the concept(s) that carry
    // the code in that identifier scheme, then the operator applies to them as
    // to any set. The scheme is an alias from the ECL specification (LOINC) or
    // the identifier scheme concept's own id.
    if (focus.type === ECLNodeType.ALT_IDENTIFIER) {
      const set = this._eclAltIdentifier(focus);
      if (!operator) {
        const result = new SnomedFilterContext();
        result.descendants = set;
        return result;
      }
      const base = new SnomedFilterContext();
      base.descendants = set;
      return this._eclApplyOperatorToSet(base, operator, opContext);
    }

    // Top / bottom of set: the members of the focus set with no ancestor
    // (respectively descendant) in that set
    if (operator === ECLTokenType.TOP_OF_SET || operator === ECLTokenType.BOTTOM_OF_SET) {
      const set = this._eclResolveSet(this._evalECLNode(focus, opContext), opContext);
      return this._eclTopOrBottom(set, operator === ECLTokenType.TOP_OF_SET, opContext);
    }

    // Plain concept reference
    if (focus.type === ECLNodeType.CONCEPT_REFERENCE) {
      return this._evalConceptWithOperator(focus.conceptId, operator, opContext);
    }

    // Wildcard, member-of, or a parenthesised sub-expression: evaluate the
    // focus to a set, then apply the operator to each member and union the
    // results ("< (A OR B)" is "< A OR < B"; "<< ^ refset" is the descendants
    // of every member). Without an operator the set is the answer.
    let base;
    if (focus.type === ECLNodeType.WILDCARD) {
      base = this._eclWildcard();
    } else if (focus.type === ECLNodeType.MEMBER_OF) {
      base = this._evalMemberOf(focus, opContext);
    } else {
      base = this._evalECLNode(focus, opContext);
    }
    if (!operator) {
      return base;
    }
    return this._eclApplyOperatorToSet(base, operator, opContext);
  };

  /**
   * Apply a hierarchy operator to every concept in a set and union the results.
   * The wildcard is special-cased: its self-inclusive forms are the wildcard
   * again, and the others are "every concept that has a parent / child".
   */
  _eclApplyOperatorToSet = function (ctx, operator, opContext) {
    if (ctx.eclWildcard && (!ctx.descendants || ctx.descendants.length === 0)) {
      switch (operator) {
        case ECLTokenType.DESCENDANT_OR_SELF_OF:
        case ECLTokenType.ANCESTOR_OR_SELF_OF:
        case ECLTokenType.CHILD_OR_SELF_OF:
        case ECLTokenType.PARENT_OR_SELF_OF:
          return this._eclWildcard();
        case ECLTokenType.DESCENDANT_OF:
        case ECLTokenType.CHILD_OF: {
          const result = new SnomedFilterContext();
          result.descendants = this._eclEnumerateAllConcepts(opContext).filter(idx => this.getConceptParents(idx).length > 0);
          return result;
        }
        case ECLTokenType.ANCESTOR_OF:
        case ECLTokenType.PARENT_OF: {
          const result = new SnomedFilterContext();
          result.descendants = this._eclEnumerateAllConcepts(opContext).filter(idx => this.getConceptChildren(idx).length > 0);
          return result;
        }
        default:
          throw new Error(`Unsupported ECL hierarchy operator: ${operator}`);
      }
    }
    const union = new Set();
    for (const idx of this._eclToIndexArray(ctx)) {
      if (opContext) opContext.deadCheck('ecl:operatorOnSet');
      const part = this._evalConceptWithOperator(this.concepts.getConceptId(idx), operator, opContext);
      for (const r of this._eclToIndexArray(part)) {
        union.add(r);
      }
    }
    const result = new SnomedFilterContext();
    result.descendants = [...union];
    return result;
  };

  /**
   * Resolve an ECL alternate identifier (scheme#code) to concept indexes. The
   * scheme is a known alias (IDENTIFIER_SCHEMES[].alias, case-insensitive) or
   * an identifier scheme concept id. An unknown scheme, or a code nobody has,
   * is an invalid expression - the same standing as an unknown concept.
   */
  _eclAltIdentifier = function (node) {
    let schemeId = null;
    if (/^\d{6,18}$/.test(node.scheme)) {
      schemeId = node.scheme;
    } else {
      for (const [id, def] of Object.entries(IDENTIFIER_SCHEMES)) {
        if (def.alias && def.alias.toLowerCase() === node.scheme.toLowerCase()) schemeId = id;
      }
    }
    const invalid = (msg) => { const e = new Error(msg); e.eclInvalid = true; return e; };
    if (!schemeId) {
      throw invalid(`The alternate identifier scheme "${node.scheme}" is not known`);
    }
    const concepts = this.getConceptsForIdentifier(schemeId, node.code);
    if (concepts.length === 0) {
      throw invalid(`No concept has the alternate identifier ${node.scheme}#${node.code}`);
    }
    return concepts.map(id => this.concepts.findConcept(id)).filter(r => r.found).map(r => r.index);
  };

  /**
   * !!> / !!< : keep the concepts in `set` that have no ancestor (top) or no
   * descendant (bottom) that is also in `set`. Walks the stated parents of each
   * member within the set, so the cost is bounded by the set's own size.
   */
  _eclTopOrBottom = function (set, top, opContext) {
    const members = new Set(set);
    // a member is "covered" (not top) when some ancestor is in the set; for
    // bottom, the ancestor is the one that is covered
    const covered = new Set();
    for (const idx of members) {
      if (opContext) opContext.deadCheck('ecl:topBottom');
      const seen = new Set();
      const stack = [...this.getConceptParents(idx)];
      while (stack.length > 0) {
        const p = stack.pop();
        if (seen.has(p)) continue;
        seen.add(p);
        if (members.has(p)) {
          covered.add(top ? idx : p);
          if (top) break;
        }
        stack.push(...this.getConceptParents(p));
      }
    }
    const result = new SnomedFilterContext();
    result.descendants = [...members].filter(idx => !covered.has(idx));
    return result;
  };

  /**
   * Resolve an attribute name (the left side of a refinement or a dotted step)
   * to the set of relationship type indexes it denotes: a bare concept gives one
   * index, `*` any type, and an expression (<< 762705008, (A OR B), ^ refset)
   * whatever it evaluates to.
   * @returns {{any: boolean, types: Set<number>|null}}
   */
  _eclAttributeTypes = function (nameNode, opContext) {
    if (nameNode.type === ECLNodeType.WILDCARD) {
      return { any: true, types: null };
    }
    if (nameNode.type === ECLNodeType.CONCEPT_REFERENCE) {
      const attrResult = this.concepts.findConcept(nameNode.conceptId);
      if (!attrResult.found) {
        throw new Error(`The SNOMED CT Concept ${nameNode.conceptId} is not known`);
      }
      return { any: false, types: new Set([attrResult.index]) };
    }
    const ctx = this._evalECLNode(nameNode, opContext);
    if (ctx.eclWildcard && (!ctx.descendants || ctx.descendants.length === 0)) {
      return { any: true, types: null };
    }
    return { any: false, types: new Set(this._eclToIndexArray(ctx)) };
  };

  /**
   * Resolve a concept ID + hierarchy operator.
   * @param {string} conceptId
   * @param {string|null} operator  ECLTokenType constant
   * @returns {SnomedFilterContext}
   */
  _evalConceptWithOperator = function (conceptId, operator, opContext) {
    switch (operator) {
      case null:
      case undefined:
        return this.filterEquals(conceptId);

        // ── Descendants ────────────────────────────────────────────────────────
      case ECLTokenType.DESCENDANT_OR_SELF_OF: { // <<   self + all transitive descendants
        return this.filterIsA(conceptId, true);
      }

      case ECLTokenType.DESCENDANT_OF: {         // <    all transitive descendants, no self
        return this.filterIsA(conceptId, false);
      }

      case ECLTokenType.CHILD_OR_SELF_OF: {      // <<!  self + direct children only
        const conceptResult = this.concepts.findConcept(conceptId);
        if (!conceptResult.found) {
          throw new Error(`The SNOMED CT Concept ${conceptId} is not known`);
        }
        const result = new SnomedFilterContext();
        const children = this.getConceptChildren(conceptResult.index);
        result.descendants = [conceptResult.index, ...children];
        return result;
      }

      case ECLTokenType.CHILD_OF: {              // <!   direct children only
        return this.filterChildOf(conceptId);
      }

        // ── Ancestors ──────────────────────────────────────────────────────────
      case ECLTokenType.ANCESTOR_OR_SELF_OF: {   // >>   self + all transitive ancestors
        const result = this.filterGeneralizes(conceptId, opContext);
        const self = this.concepts.findConcept(conceptId);
        if (self.found && !result.descendants.includes(self.index)) {
          result.descendants.push(self.index);
        }
        return result;
      }

      case ECLTokenType.ANCESTOR_OF: {           // >    all transitive ancestors, no self
        return this.filterGeneralizes(conceptId, opContext);
      }

      case ECLTokenType.PARENT_OR_SELF_OF: {     // >>!  self + direct parents only
        const conceptResult = this.concepts.findConcept(conceptId);
        if (!conceptResult.found) {
          throw new Error(`The SNOMED CT Concept ${conceptId} is not known`);
        }
        const result = new SnomedFilterContext();
        const parents = this.getConceptParents(conceptResult.index);
        result.descendants = [conceptResult.index, ...parents];
        return result;
      }

      case ECLTokenType.PARENT_OF: {             // >!   direct parents only
        const conceptResult = this.concepts.findConcept(conceptId);
        if (!conceptResult.found) {
          throw new Error(`The SNOMED CT Concept ${conceptId} is not known`);
        }
        const result = new SnomedFilterContext();
        result.descendants = this.getConceptParents(conceptResult.index);
        return result;
      }

      default:
        throw new Error(`Unsupported ECL hierarchy operator: ${operator}`);
    }
  };

  /**
   * Evaluate a MEMBER_OF (^) node. The operand may be any ECL expression: it is
   * resolved to a set of candidate reference-set concepts, and the result is the
   * union of their active concept members' referenced components.
   *
   * When the operand concept is not a reference set the result is empty (a
   * non-refset concept simply has no members - this matches Snowstorm and the
   * tx-ecosystem test suite). When the
   * operand is a computed expression (e.g. ^(<<900000000000455006)), concepts in
   * the resolved set that are not reference sets are simply skipped — the closure
   * of "Reference set" necessarily includes the non-refset parent itself.
   *
   * @param {object} memberOfNode
   * @param {OperationContext} [opContext]
   * @returns {SnomedFilterContext}
   */
  _evalMemberOf = function (memberOfNode, opContext) {
    // ^ [field, ...] refset selects which field of the member rows to return
    // instead of the referenced component. Not supported: the referenced
    // components, and the fields, may be descriptions or other non-concept
    // components, which an expansion cannot carry.
    if (memberOfNode.fields) {
      throw new Error(`ECL reference set field selection (^ [${memberOfNode.fields.join(', ')}] ...) is not supported`);
    }
    const refsetConcepts = this._eclResolveSet(this._evalECLNode(memberOfNode.refSet, opContext), opContext);
    const memberFilters = this._eclPrepareMemberFilters(memberOfNode.memberFilters, opContext);
    const rs = memberOfNode.refSet;
    const explicit = rs.type === ECLNodeType.CONCEPT_REFERENCE ||
      (rs.type === ECLNodeType.SUB_EXPRESSION_CONSTRAINT && !rs.operator && rs.focus.type === ECLNodeType.CONCEPT_REFERENCE);

    const members = new Set();
    for (const refsetIdx of refsetConcepts) {
      if (opContext) opContext.deadCheck('ecl:memberOf');
      const refSet = this._findRefSetRecord(refsetIdx);
      const membersRef = refSet ? refSet.membersByRef : null;
      if (membersRef === null) {
        // Operand concept is not a reference set: yield no members for it
        // (empty result) rather than erroring. Applies to both a bare concept
        // reference (e.g. "^ 10200004") and a computed operand.
        continue;
      }
      if (membersRef === 0 || membersRef === 0xFFFFFFFF) {
        continue; // a reference set with no members
      }
      const memberList = this.refSetMembers.getMembers(membersRef) || [];
      // A reference set whose members are descriptions (a language reference
      // set, say) has no concept members to return. When it was named
      // explicitly, say so rather than answering with an empty set, which would
      // read as "no members". When it merely falls inside a computed operand
      // (^ *, ^ (< 900000000000455006)) it contributes nothing and the rest of
      // the operand still counts.
      if (explicit && memberList.length > 0 && !memberList.some(m => m.kind === 0)) {
        throw new Error(`The members of reference set ${this.concepts.getConceptId(refsetIdx)} are descriptions, not concepts, so ^ cannot be evaluated for it`);
      }
      for (const m of memberList) {
        // Concept referenced components only (kind 0). Description/other members
        // are excluded, which also prevents the no-component sentinel (0xFFFFFFFF)
        // from leaking in. The referenced concept may itself be INACTIVE and is
        // still returned — "active" in the spec qualifies the membership row (and
        // inactive rows are already dropped at import), not the referenced
        // concept. The expansion marks/handles inactivity (e.g. activeOnly).
        if (m.kind === 0 && this._eclMemberMatches(m, refSet, memberFilters)) {
          members.add(m.ref);
        }
      }
    }
    const result = new SnomedFilterContext();
    result.descendants = [...members];
    return result;
  };

  /**
   * Apply a history supplement ({{ + HISTORY... }}): add to the result the
   * inactive concepts that the selected historical association reference sets
   * associate with a concept in the result (the association rows whose
   * targetComponentId is in the result).
   *
   * Profiles (ECL 2.x): MIN = SAME AS; MOD = SAME AS, WAS A, REPLACED BY,
   * PARTIALLY EQUIVALENT TO; MAX (and a bare HISTORY) = every reference set
   * under 900000000000522004 |Historical association|; HISTORY (expr) = the
   * reference sets the expression yields. A reference set the edition does not
   * carry simply contributes nothing.
   */
  _applyHistorySupplement = function (ctx, hs, opContext) {
    const HISTORICAL_ASSOCIATION = '900000000000522004';
    const PROFILES = {
      MIN: ['900000000000527005'],
      MOD: ['900000000000527005', '900000000000528000', '900000000000526001', '1186924009']
    };
    let refsetIdxs;
    if (hs.profile === 'EXPLICIT') {
      refsetIdxs = this._eclResolveSet(this._evalECLNode(hs.refsets, opContext), opContext);
    } else if (hs.profile === 'MAX') {
      const root = this.concepts.findConcept(HISTORICAL_ASSOCIATION);
      refsetIdxs = root.found ? this._eclToIndexArray(this.filterIsA(HISTORICAL_ASSOCIATION, false)) : [];
    } else {
      refsetIdxs = PROFILES[hs.profile].map(id => this.concepts.findConcept(id)).filter(r => r.found).map(r => r.index);
    }

    const base = this._eclResolveSet(ctx, opContext);
    const inResult = new Set(base);
    const added = new Set();
    for (const refsetIdx of refsetIdxs) {
      if (opContext) opContext.deadCheck('ecl:history');
      const byTarget = this._historyIndex(refsetIdx);
      if (!byTarget) continue;
      for (const [target, sources] of byTarget) {
        if (inResult.has(target)) {
          for (const src of sources) {
            if (!inResult.has(src)) added.add(src);
          }
        }
      }
    }
    const result = new SnomedFilterContext();
    result.descendants = base.concat([...added]);
    return result;
  };

  /**
   * target concept index -> [referenced (inactive) concept indexes] for one
   * association reference set, built once per edition. null when the concept
   * is not a reference set with concept-valued members.
   */
  _historyIndex = function (refsetIdx) {
    this._historyIndexes = this._historyIndexes || new Map();
    if (this._historyIndexes.has(refsetIdx)) {
      return this._historyIndexes.get(refsetIdx);
    }
    let index = null;
    const refSet = this._findRefSetRecord(refsetIdx);
    if (refSet && refSet.membersByRef && refSet.membersByRef !== 0xFFFFFFFF) {
      for (const m of this.refSetMembers.getMembers(refSet.membersByRef) || []) {
        if (m.kind !== 0 || !m.values) continue;
        const values = this.refs.getReferences(m.values);
        // targetComponentId is the first additional field, stored as (value, type) with type 1 = concept
        if (!values || values.length < 2 || values[1] !== 1) continue;
        index = index || new Map();
        const list = index.get(values[0]) || [];
        list.push(m.ref);
        index.set(values[0], list);
      }
    }
    this._historyIndexes.set(refsetIdx, index);
    return index;
  };

  /**
   * Apply {{ C ... }} concept filters to a result: each concept is tested on
   * its own active flag, module, effectiveTime and definition status. Several
   * filter constraints, and the comma-separated filters within one, all AND.
   */
  _applyConceptFilters = function (ctx, filterConstraints, opContext) {
    const filters = [];
    for (const fc of filterConstraints) {
      for (const f of fc.filters) {
        if (f.valueType === 'expression') {
          const vctx = this._evalECLNode(f.value, opContext);
          if (vctx.eclWildcard && (!vctx.descendants || vctx.descendants.length === 0)) {
            filters.push({ ...f, wildcard: true });
          } else {
            filters.push({ ...f, set: new Set(this._eclToIndexArray(vctx)) });
          }
        } else {
          filters.push(f);
        }
      }
    }
    // The definition status concepts, if this edition has them
    const statusIndex = (id) => {
      const r = this.concepts.findConcept(id);
      return r.found ? r.index : null;
    };
    const primitiveIdx = statusIndex('900000000000074008');
    const definedIdx = statusIndex('900000000000073002');

    const matching = [];
    for (const idx of this._eclResolveSet(ctx, opContext)) {
      if (opContext) opContext.deadCheck('ecl:conceptFilter');
      let ok = true;
      for (const f of filters) {
        const field = f.field.toLowerCase();
        let r;
        if (field === 'active') {
          r = this.isActive(idx) === f.value;
          if (f.operator === '!=') r = !r;
        } else if (field === 'effectivetime') {
          const concept = this.concepts.getConcept(idx);
          r = this._eclCompareValues(this._snomedDateToString(concept.effectiveTime), f.operator, f.values, (a, b) => a.localeCompare(b));
        } else if (field === 'moduleid') {
          const inSet = f.wildcard || f.set.has(this.concepts.getModuleId(idx));
          r = f.operator === '=' ? inSet : !inSet;
        } else if (field === 'definitionstatusid') {
          const statusIdx = this.isPrimitive(idx) ? primitiveIdx : definedIdx;
          const inSet = f.wildcard || (statusIdx !== null && f.set.has(statusIdx));
          r = f.operator === '=' ? inSet : !inSet;
        } else if (field === 'definitionstatus') {
          const status = this.isPrimitive(idx) ? 'primitive' : 'defined';
          const inSet = f.values.includes(status);
          r = f.operator === '=' ? inSet : !inSet;
        } else {
          throw new Error(`Unsupported concept filter ${f.field}`);
        }
        if (!r) {
          ok = false;
          break;
        }
      }
      if (ok) {
        matching.push(idx);
      }
    }
    const result = new SnomedFilterContext();
    result.descendants = matching;
    return result;
  };

  /**
   * Apply one {{ D ... }} block: a concept is kept when at least one of its
   * descriptions satisfies every filter in the block. Only active descriptions
   * are considered unless the block has an `active` filter. Several blocks
   * AND at the concept level (each may be satisfied by a different description).
   */
  _applyDescriptionFilter = function (ctx, filters, opContext) {
    const K = this._displayConstants();
    const idx = (id) => { const r = this.concepts.findConcept(id); return r.found ? r.index : -1; };
    const typeTokens = { syn: K.synonym, fsn: K.fsn, def: idx('900000000000550004') };
    const acceptabilityIdx = { preferred: K.preferred, acceptable: idx('900000000000549004') };
    const resolveSet = (expr) => {
      const vctx = this._evalECLNode(expr, opContext);
      if (vctx.eclWildcard && (!vctx.descendants || vctx.descendants.length === 0)) return null; // any
      return new Set(this._eclToIndexArray(vctx));
    };
    let activeFilter = null;
    const prepared = filters.map(f => {
      const field = f.field.toLowerCase();
      switch (f.valueType) {
        case 'term':
          return { ...f, field, matchers: f.values.map(v => this._eclTermMatcher(v)) };
        case 'expression':
          return { ...f, field, set: resolveSet(f.value) };
        case 'type':
          return { ...f, field, set: new Set(f.values.map(t => typeTokens[t]).filter(i => i >= 0)) };
        case 'dialectId':
        case 'dialect':
          return { ...f, field, dialects: f.dialects.map(d => {
            let set;
            if (d.alias) {
              const id = ECL_DIALECT_ALIASES[d.alias];
              if (!id) throw new Error(`Unknown dialect alias ${d.alias} in description filter`);
              const i = idx(id);
              set = new Set(i >= 0 ? [i] : []);
            } else {
              set = resolveSet(d.expression);
            }
            const acceptability = d.acceptability
              ? new Set(d.acceptability.map(a => acceptabilityIdx[a] !== undefined ? acceptabilityIdx[a] : idx(a)))
              : null;
            return { set, acceptability };
          }) };
        case 'boolean':
          activeFilter = f;
          return { ...f, field };
        case 'id':
          return { ...f, field, ids: new Set(f.values.map(v => BigInt(v))) };
        default:
          return { ...f, field };
      }
    });

    const matching = [];
    for (const conceptIdx of this._eclResolveSet(ctx, opContext)) {
      if (opContext) opContext.deadCheck('ecl:descriptionFilter');
      const concept = this.concepts.getConcept(conceptIdx);
      const descIndices = concept.descriptions ? (this.refs.getReferences(concept.descriptions) || []) : [];
      let found = false;
      for (const descIndex of descIndices) {
        const d = this.descriptions.getDescription(descIndex);
        if (!activeFilter && !d.active) continue;
        if (prepared.every(f => this._eclDescriptionMatches(d, f))) {
          found = true;
          break;
        }
      }
      if (found) matching.push(conceptIdx);
    }
    const result = new SnomedFilterContext();
    result.descendants = matching;
    return result;
  };

  /**
   * Does one description satisfy one prepared description filter?
   */
  _eclDescriptionMatches = function (d, f) {
    const neg = f.operator === '!=';
    const eq = (r) => neg ? !r : r;
    switch (f.field) {
      case 'term':
        return eq(f.matchers.some(m => m(this.strings.getEntry(d.iDesc))));
      case 'language':
        return eq(f.values.includes(SCT_LANGUAGE_CODES[d.lang] || 'en'));
      case 'typeid':
        return eq(f.set === null || f.set.has(d.kind));
      case 'type':
        return eq(f.set.has(d.kind));
      case 'moduleid':
        return eq(f.set === null || f.set.has(d.module));
      case 'dialectid':
      case 'dialect': {
        const refsets = d.refsets ? (this.refs.getReferences(d.refsets) || []) : [];
        const inDialect = f.dialects.some(dl => refsets.some(r => {
          if (dl.set !== null && !dl.set.has(r)) return false;
          if (!dl.acceptability) return true;
          return dl.acceptability.has(this._descAcceptability(d, r));
        }));
        return eq(inDialect);
      }
      case 'effectivetime':
        return this._eclCompareValues(this._snomedDateToString(d.date), f.operator, f.values, (a, b) => a.localeCompare(b));
      case 'active':
        return eq(d.active === f.value);
      case 'id':
        return eq(f.ids.has(d.id));
      default:
        throw new Error(`Unsupported description filter ${f.field}`);
    }
  };

  /**
   * A matcher for one typed search term. "match" semantics (the default): every
   * word of the search term is a prefix of some word of the description, case
   * insensitively. "wild" semantics: the whole description matches the pattern,
   * with * standing for any characters.
   */
  _eclTermMatcher = function (v) {
    if (v.kind === 'wild') {
      const re = new RegExp('^' + v.value.split('*').map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
      return (term) => re.test(term);
    }
    const words = v.value.toLowerCase().split(/\s+/).filter(w => w.length > 0);
    return (term) => {
      const termWords = term.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 0);
      return words.every(w => termWords.some(tw => tw.startsWith(w)));
    };
  };

  /**
   * Resolve the expression-valued member filters (moduleId = ..., <conceptField> = ...)
   * once, before the members are walked. Returns the filters with a `set` of
   * concept indexes attached (or `wildcard: true`), or null when there are none.
   */
  _eclPrepareMemberFilters = function (filters, opContext) {
    if (!filters || filters.length === 0) {
      return null;
    }
    return filters.map(f => {
      if (f.valueType !== 'expression') {
        return f;
      }
      const ctx = this._evalECLNode(f.value, opContext);
      if (ctx.eclWildcard && (!ctx.descendants || ctx.descendants.length === 0)) {
        return { ...f, wildcard: true };
      }
      return { ...f, set: new Set(this._eclToIndexArray(ctx)) };
    });
  };

  /**
   * Does a reference set member row satisfy every member filter?
   *
   * Member rows are only stored when active, so `active = false` matches
   * nothing. effectiveTime and moduleId come from the row itself (present when
   * the reference set stores ids); any other field name is looked up in the
   * reference set's additional fields (e.g. targetComponentId, mapTarget,
   * acceptabilityId), typed by the refset file name (c / i / s).
   */
  _eclMemberMatches = function (m, refSet, filters) {
    if (!filters) {
      return true;
    }
    for (const f of filters) {
      const field = f.field.toLowerCase();
      let ok;
      if (field === 'active') {
        ok = (f.operator === '=') === f.value;
      } else if (field === 'effectivetime') {
        if (m.date == null) {
          return false;
        }
        ok = this._eclCompareValues(this._snomedDateToString(m.date), f.operator, f.values, (a, b) => a.localeCompare(b));
      } else if (field === 'moduleid') {
        if (m.module == null) {
          return false;
        }
        const inSet = f.wildcard || f.set.has(m.module);
        ok = f.operator === '=' ? inSet : !inSet;
      } else {
        const fv = this._eclMemberFieldValue(m, refSet, f.field);
        if (fv === undefined) {
          throw new Error(`Reference set ${this.concepts.getConceptId(refSet.definition)} has no field named ${f.field}`);
        }
        if (fv === null) {
          return false;
        }
        switch (f.valueType) {
          case 'expression': {
            if (fv.type !== 'concept') {
              throw new Error(`Reference set field ${f.field} is not a concept field`);
            }
            const inSet = f.wildcard || f.set.has(fv.value);
            ok = f.operator === '=' ? inSet : !inSet;
            break;
          }
          case 'numeric': {
            if (fv.type !== 'integer') {
              throw new Error(`Reference set field ${f.field} is not a numeric field`);
            }
            ok = this._eclCompareValues(Number(fv.value), f.operator, [Number(f.value)], (a, b) => a - b);
            break;
          }
          case 'string': {
            if (fv.type !== 'string') {
              throw new Error(`Reference set field ${f.field} is not a string field`);
            }
            ok = this._eclCompareValues(fv.value, f.operator, f.values, (a, b) => a.localeCompare(b));
            break;
          }
          case 'time': {
            if (fv.type !== 'string') {
              throw new Error(`Reference set field ${f.field} is not a time field`);
            }
            ok = this._eclCompareValues(fv.value, f.operator, f.values, (a, b) => a.localeCompare(b));
            break;
          }
          case 'boolean': {
            if (fv.type !== 'string' && fv.type !== 'integer') {
              throw new Error(`Reference set field ${f.field} is not a boolean field`);
            }
            const b = String(fv.value) === '1' || String(fv.value).toLowerCase() === 'true';
            ok = (f.operator === '=') === (b === f.value);
            break;
          }
          default:
            throw new Error(`Unsupported member filter on ${f.field}`);
        }
      }
      if (!ok) {
        return false;
      }
    }
    return true;
  };

  /**
   * Compare one value against a value set with an ECL comparison operator.
   * "=" is true when any set value matches, "!=" when none does; the ordering
   * operators compare against the single value.
   */
  _eclCompareValues = function (actual, operator, values, cmp) {
    switch (operator) {
      case '=': return values.some(v => cmp(actual, v) === 0);
      case '!=': return !values.some(v => cmp(actual, v) === 0);
      case '<': return cmp(actual, values[0]) < 0;
      case '<=': return cmp(actual, values[0]) <= 0;
      case '>': return cmp(actual, values[0]) > 0;
      case '>=': return cmp(actual, values[0]) >= 0;
      default: throw new Error(`Unsupported comparison operator ${operator}`);
    }
  };

  /**
   * Read a named additional field from a member row. Returns undefined when the
   * reference set has no such field, null when the row has no value for it, and
   * otherwise { type: 'concept'|'description'|'integer'|'string', value }.
   */
  _eclMemberFieldValue = function (m, refSet, fieldName) {
    if (!refSet.fieldNames) {
      return undefined;
    }
    const names = this.refs.getReferences(refSet.fieldNames) || [];
    const idx = names.findIndex(n => this.strings.getEntry(n).trim().toLowerCase() === fieldName.toLowerCase());
    if (idx < 0) {
      return undefined;
    }
    const values = m.values ? this.refs.getReferences(m.values) : null;
    if (!values || values.length < (idx + 1) * 2) {
      return null;
    }
    const value = values[idx * 2];
    const type = values[idx * 2 + 1];
    switch (type) {
      case 1: return { type: 'concept', value };
      case 2: return { type: 'description', value };
      case 4: return { type: 'integer', value };
      case 5: return { type: 'string', value: this.strings.getEntry(value) };
      default: return null;
    }
  };

  /**
   * Stored SNOMED dates are days since the Pascal TDateTime epoch (1899-12-30);
   * render as YYYYMMDD for comparison with an ECL time value.
   */
  _snomedDateToString = function (days) {
    const d = new Date(Date.UTC(1899, 11, 30) + days * 86400000);
    return d.toISOString().slice(0, 10).replace(/-/g, '');
  };

  _findRefSetRecord = function (conceptIndex) {
    for (let i = 0; i < this.refSetIndex.count(); i++) {
      const refSet = this.refSetIndex.getReferenceSet(i);
      // definition 0 means the importer could not resolve the reference set's
      // concept (it is outside the subset) - not "the concept at offset 0"
      if (refSet.definition === conceptIndex && refSet.definition !== 0) {
        return refSet;
      }
    }
    return null;
  };

  /**
   * Wildcard — every concept, active or not.  The eclWildcard flag tells filterCheck /
   * filterLocate to accept every active concept without enumeration.
   * @returns {SnomedFilterContext}
   */
  _eclWildcard = function () {
    const result = new SnomedFilterContext();
    result.eclWildcard = true;
    return result;
  };

// ── Dotted expressions ───────────────────────────────────────────────────────

  /**
   * Evaluate a dotted expression: `<baseConstraint> . attrA . attrB`.
   * For each chained attribute, replaces the current set with the set of
   * active relationship targets whose `relType` matches the attribute.
   * Only plain concept-reference attribute names are supported.
   * @param {object} node
   * @returns {SnomedFilterContext}
   */
  _evalDotted = function (node, opContext) {
    let current = this._eclResolveSet(this._evalECLNode(node.base, opContext), opContext);

    for (const attr of node.attributes || []) {
      const types = this._eclAttributeTypes(attr, opContext);

      const next = new Set();
      for (const conceptIdx of current) {
        if (opContext) opContext.deadCheck('ecl:dotted');
        const relIdxs = this.getConceptRelationships(conceptIdx);
        for (const relIdx of relIdxs) {
          const rel = this.relationships.getRelationship(relIdx);
          if (rel.active && (types.any || types.types.has(rel.relType))) {
            next.add(rel.target);
          }
        }
      }
      current = [...next];
    }

    const result = new SnomedFilterContext();
    result.descendants = current;
    return result;
  };

// ── Refinements ──────────────────────────────────────────────────────────────

  /**
   * Evaluate a refined expression: `<baseConstraint> : <refinement>`.
   * Supported refinement shapes:
   *   - ATTRIBUTE            attr = valueExpr
   *   - ATTRIBUTE_SET        attr1 = v1, attr2 = v2 / attr1 = v1 AND|OR attr2 = v2 (operator 'AND'|'OR')
   *   - ATTRIBUTE_GROUP      { attr1 = v1, attr2 = v2 } (same relationship group)
   * Reverse attributes, cardinality, `!=`, and non-concept attribute names
   * throw informative errors.
   * @param {object} node
   * @returns {SnomedFilterContext}
   */
  _evalRefined = function (node, opContext) {
    const baseSet = this._eclResolveSet(this._evalECLNode(node.base, opContext), opContext);
    const matching = [];
    for (const conceptIdx of baseSet) {
      if (opContext) opContext.deadCheck('ecl:refined');
      if (this._refinementMatches(this._conceptRelRecords(conceptIdx), node.refinement, opContext)) {
        matching.push(conceptIdx);
      }
    }
    const result = new SnomedFilterContext();
    result.descendants = matching;
    return result;
  };

  /**
   * Check whether a single concept satisfies a refinement node (ATTRIBUTE,
   * ATTRIBUTE_SET, or ATTRIBUTE_GROUP).
   * @param {number} conceptIdx
   * @param {object} refinement
   * @returns {boolean}
   */
  _refinementMatches = function (rels, refinement, opContext) {
    switch (refinement.type) {
      case ECLNodeType.ATTRIBUTE:
        return this._attributeMatches(rels, refinement, null, opContext);
      case ECLNodeType.ATTRIBUTE_SET:
        // operator is 'AND' (also for ",") or 'OR'
        if (refinement.operator === 'OR') {
          return refinement.attributes.some(a => this._refinementMatches(rels, a, opContext));
        }
        return refinement.attributes.every(a => this._refinementMatches(rels, a, opContext));
      case ECLNodeType.ATTRIBUTE_GROUP:
        return this._attributeGroupMatches(rels, refinement, opContext);
      default:
        throw new Error(`Unsupported refinement node type: ${refinement.type}`);
    }
  };

  /**
   * The same, restricted to the relationships in one role group: an attribute
   * set inside { } may itself be an AND/OR tree of attributes.
   */
  _refinementMatchesInGroup = function (rels, node, g, opContext) {
    if (node.type === ECLNodeType.ATTRIBUTE_SET) {
      if (node.operator === 'OR') {
        return node.attributes.some(a => this._refinementMatchesInGroup(rels, a, g, opContext));
      }
      return node.attributes.every(a => this._refinementMatchesInGroup(rels, a, g, opContext));
    }
    if (node.type !== ECLNodeType.ATTRIBUTE) {
      throw new Error(`Unsupported node type in attribute group: ${node.type}`);
    }
    return this._attributeMatches(rels, node, g, opContext);
  };

  /**
   * Check whether a concept has at least one active relationship whose
   * `relType` matches the attribute name and whose `target` is in the value
   * expression's result set. If `groupFilter` is not null, the relationship
   * must also have that exact `group` number (used by group matching).
   * @param {number} conceptIdx
   * @param {object} attr
   * @param {number|null} groupFilter
   * @returns {boolean}
   */
  _attributeMatches = function (rels, attr, groupFilter, opContext) {
    if (!attr.comparison) {
      throw new Error('ECL attribute without a comparison is not supported');
    }
    if (attr.comparison.type !== ECLNodeType.EXPRESSION_COMPARISON && !this.concreteValues) {
      throw new Error('ECL concrete values (numeric, string and boolean attribute values) cannot be evaluated - this edition was imported without its concrete value relationships');
    }

    const count = this._countAttributeMatches(rels, attr, groupFilter, opContext);

    if (attr.cardinality) {
      return this._cardinalityAccepts(attr.cardinality, count);
    }
    return count >= 1;
  };

  /**
   * Count the number of active relationships on the concept whose `relType`
   * matches the attribute name and whose `target` is in the value expression's
   * result set. Honours an optional group filter.
   * @param {number} conceptIdx
   * @param {object} attr
   * @param {number|null} groupFilter
   * @returns {number}
   */
  _countAttributeMatches = function (rels, attr, groupFilter, opContext) {
    // The attribute type and the value set depend only on the (static) AST node,
    // not on the concept being tested, so resolve them once per refinement
    // attribute and reuse across the whole base set. Without this memo the value
    // expression is re-evaluated for every concept — and for a wildcard value
    // (`= *`) the entire active-concept set is re-enumerated per concept —
    // making refinement evaluation O(baseSet × valueExpr). The AST is parsed
    // fresh per request, so memoising on the node is safe within a request.
    let resolved = attr._eclResolved;
    if (!resolved) {
      resolved = { types: this._eclAttributeTypes(attr.name, opContext) };
      if (attr.comparison.type === ECLNodeType.EXPRESSION_COMPARISON) {
        resolved.valueSet = new Set(this._eclResolveSet(this._evalECLNode(attr.comparison.value, opContext), opContext));
      } else {
        resolved.concrete = this._eclConcreteMatcher(attr.comparison);
      }
      attr._eclResolved = resolved;
    }
    const types = resolved.types;
    const valueSet = resolved.valueSet;

    if (resolved.concrete) {
      // A concrete-value comparison: only the concrete rows count, each
      // occurrence being a (group, value) pair
      const matched = new Set();
      for (const rel of rels) {
        if (!rel.concrete) continue;
        if (!types.any && !types.types.has(rel.relType)) continue;
        if (groupFilter !== null && rel.group !== groupFilter) continue;
        if (resolved.concrete(rel.concrete)) matched.add(rel.group + ':' + JSON.stringify(rel.concrete.value));
      }
      return matched.size;
    }

    // ECL cardinality counts OCCURRENCES of a matching attribute, per role group
    // — not distinct values. ECL runs against the necessary normal form, where a
    // role group has no redundant attributes, so the same (type, value) in two
    // different role groups counts as two occurrences (confirmed by the SNOMED
    // Computable Languages Group; ECL 6.3 "non-redundant" refers to the normal
    // form, not to de-duplicating across groups). We therefore count distinct
    // (group, target) pairs: within a group filter this is the matching values
    // in that group; ungrouped it is the total occurrences across all groups.
    //
    // "!=" counts the occurrences whose value is NOT in the set (so "A != X"
    // matches a concept with at least one A whose value is something other than
    // X, and "[0..0] A != X" one whose every A is X).
    //
    // A reversed attribute ("R A = X") is matched against the concept's INBOUND
    // relationships: the concept is the value of an A attribute on some concept
    // in X. _conceptRelRecords supplies those tagged `inbound`; the records built
    // for a post-coordinated expression have none, so R matches nothing there.
    const notEquals = attr.comparison.operator === ECLTokenType.NOT_EQUALS;
    const reverse = !!attr.reverse;
    const matched = new Set();
    for (const rel of rels) {
      if (opContext) opContext.deadCheck('ecl:countAttributeMatches');
      if (!rel.active || rel.concrete) continue;
      if (!!rel.inbound !== reverse) continue;
      if (!types.any && !types.types.has(rel.relType)) continue;
      if (groupFilter !== null && rel.group !== groupFilter) continue;
      const value = reverse ? rel.source : rel.target;
      if (valueSet.has(value) !== notEquals) matched.add(rel.group + ':' + value);
    }
    return matched.size;
  };

  /**
   * Test a count against a parsed cardinality `{min, max}` where `max` is
   * either an integer or the string `'*'` (unbounded).
   * @param {{min: number, max: number|'*'}} cardinality
   * @param {number} count
   * @returns {boolean}
   */
  _cardinalityAccepts = function (cardinality, count) {
    const { min, max } = cardinality;
    if (min != null && count < min) return false;
    if (max != null && max !== '*' && count > max) return false;
    return true;
  };

  /**
   * Check whether any single relationship group on the concept satisfies all
   * attributes in an ATTRIBUTE_GROUP. Ungrouped relationships (group === 0)
   * are not eligible — an attribute group must match within a real group.
   *
   * If the group itself carries cardinality (e.g. `[1..1] {…}`), the match
   * requires the count of matching groups to fall within the specified range.
   * @param {number} conceptIdx
   * @param {object} group
   * @returns {boolean}
   */
  _attributeGroupMatches = function (rels, group, opContext) {
    const groupNumbers = new Set();
    for (const rel of rels) {
      if (rel.active && rel.group > 0) {
        groupNumbers.add(rel.group);
      }
    }

    let matchingGroupCount = 0;
    for (const g of groupNumbers) {
      if (opContext) opContext.deadCheck('ecl:attributeGroup');
      let allMatch = true;
      for (const attr of group.attributes) {
        if (!this._refinementMatchesInGroup(rels, attr, g, opContext)) {
          allMatch = false;
          break;
        }
      }
      if (allMatch) {
        matchingGroupCount++;
        // With no cardinality, short-circuit on the first matching group.
        if (!group.cardinality) return true;
      }
    }

    if (group.cardinality) {
      return this._cardinalityAccepts(group.cardinality, matchingGroupCount);
    }
    return false;
  };

  // Materialise a concept's relationships as plain records {active, relType,
  // target, group} — the shape the refinement matchers consume. Sharing this
  // shape lets the same matchers run against a post-coordinated expression's
  // relationships (see _expressionRelRecords).
  /**
   * A predicate over a stored concrete value for one comparison node:
   *   numeric: = != < <= > >= against a number (integers and decimals compare as
   *            numbers, so #5 = #5.0)
   *   string:  = / != against typed search terms (match / wild semantics, as for
   *            description terms), any of a set
   *   boolean: = / != true/false
   * A value of another kind never matches (and never "not-matches" either: a
   * string attribute is not "!= #5").
   */
  _eclConcreteMatcher = function (comparison) {
    switch (comparison.type) {
      case ECLNodeType.NUMERIC_COMPARISON: {
        const n = Number(comparison.value);
        const op = { [ECLTokenType.EQUALS]: '=', [ECLTokenType.NOT_EQUALS]: '!=', [ECLTokenType.LT]: '<', [ECLTokenType.LTE]: '<=', [ECLTokenType.GT]: '>', [ECLTokenType.GTE]: '>=' }[comparison.operator] || comparison.operator;
        return (v) => v.kind === 'number' && this._eclCompareValues(v.value, op, [n], (a, b) => a - b);
      }
      case ECLNodeType.STRING_COMPARISON: {
        const matchers = comparison.values.map(t => this._eclTermMatcher(typeof t === 'string' ? { kind: 'match', value: t } : t));
        const neg = comparison.operator === ECLTokenType.NOT_EQUALS;
        return (v) => v.kind === 'string' && (matchers.some(m => m(v.value)) !== neg);
      }
      case ECLNodeType.BOOLEAN_COMPARISON: {
        const neg = comparison.operator === ECLTokenType.NOT_EQUALS;
        return (v) => v.kind === 'boolean' && ((v.value === comparison.value) !== neg);
      }
      default:
        throw new Error(`Unsupported comparison ${comparison.type}`);
    }
  };

  _conceptRelRecords = function (conceptIdx) {
    const out = [];
    for (const relIdx of this.getConceptRelationships(conceptIdx)) {
      out.push(this.relationships.getRelationship(relIdx));
    }
    // concrete value rows, for numeric / string / boolean comparisons
    if (this.concreteValues) {
      for (const cv of this.concreteValues.get(conceptIdx) || []) {
        out.push({ active: true, relType: cv.relType, group: cv.group, target: -1, concrete: cv.concrete });
      }
    }
    // inbound relationships, for reversed (R) attributes
    const concept = this.concepts.getConcept(conceptIdx);
    if (concept.inbounds) {
      for (const relIdx of this.refs.getReferences(concept.inbounds) || []) {
        const rel = this.relationships.getRelationship(relIdx);
        if (rel.active && rel.relType !== this.isAIndex) {
          out.push({ ...rel, inbound: true });
        }
      }
    }
    return out;
  };

  // Turn one parsed expression refinement (name = attribute concept, value =
  // sub-expression) into a relationship record in the given group, or null if it
  // is not a plain concept = concept pair.
  _refinementToRel = function (refinement, group) {
    const relType = (refinement.name && refinement.name.reference != null)
      ? refinement.name.reference : NO_REFERENCE;
    let target = NO_REFERENCE;
    const val = refinement.value;
    if (val && val.concepts && val.concepts.length > 0) {
      target = val.concepts[0].reference;
    }
    if (relType === NO_REFERENCE || target === NO_REFERENCE) return null;
    return { active: true, relType, target, group };
  };

  // Effective relationships of a post-coordinated expression: the focus
  // concept(s) stated relationships (inherited) plus the expression's own
  // refinements. Stated ungrouped refinements go in group 0; each stated
  // refinement group gets a fresh group number beyond any inherited group so the
  // two never collide. This is sufficient for the common single-focus
  // expressions; it is not a full necessary normal form (no redundancy pruning
  // across inherited and stated attributes).
  _expressionRelRecords = function (expression) {
    const rels = [];
    for (const c of expression.concepts || []) {
      if (c.reference != null && c.reference !== NO_REFERENCE && c.reference >= 0) {
        for (const rel of this._conceptRelRecords(c.reference)) rels.push(rel);
      }
    }
    let maxGroup = 0;
    for (const r of rels) if (r.group > maxGroup) maxGroup = r.group;
    for (const ref of expression.refinements || []) {
      const rec = this._refinementToRel(ref, 0);
      if (rec) rels.push(rec);
    }
    let g = maxGroup;
    for (const grp of expression.refinementGroups || []) {
      g += 1;
      for (const ref of grp.refinements || []) {
        const rec = this._refinementToRel(ref, g);
        if (rec) rels.push(rec);
      }
    }
    return rels;
  };

  // Does a post-coordinated expression satisfy an ECL constraint? Unlike the
  // enumerating evaluator (_evalECLNode), this tests a single expression by its
  // focus subsumption and its (normal-form) relationships, so validate-code can
  // accept a composed expression that is a *member* of an ECL value set even
  // though it never appears in the (precoordinated) expansion.
  _eclExpressionSatisfies = function (exprContext, node, opContext) {
    const expr = exprContext.expression;
    const rels = this._expressionRelRecords(expr);
    return this._eclExprNode(expr, rels, node, opContext);
  };

  _eclExprNode = function (expr, rels, node, opContext) {
    if (!node) return false;
    if (opContext) opContext.deadCheck('ecl:exprSatisfies');
    switch (node.type) {
      case ECLNodeType.SUB_EXPRESSION_CONSTRAINT: {
        const focus = node.focus;
        if (focus.type === ECLNodeType.WILDCARD) return true;
        if (focus.type === ECLNodeType.MEMBER_OF) return false; // an expression is not a refset member
        if (focus.type === ECLNodeType.CONCEPT_REFERENCE) {
          return this._complexExprSatisfiesConcept(expr, focus.conceptId, node.operator);
        }
        return this._eclExprNode(expr, rels, focus, opContext); // parenthesised
      }
      case ECLNodeType.COMPOUND_EXPRESSION_CONSTRAINT: {
        const l = this._eclExprNode(expr, rels, node.left, opContext);
        const r = this._eclExprNode(expr, rels, node.right, opContext);
        switch (node.operator) {
          case ECLNodeType.CONJUNCTION: return l && r;
          case ECLNodeType.DISJUNCTION: return l || r;
          case ECLNodeType.EXCLUSION:   return l && !r;
          default: throw new Error(`Unsupported ECL compound operator: ${node.operator}`);
        }
      }
      case ECLNodeType.REFINED_EXPRESSION_CONSTRAINT:
        return this._eclExprNode(expr, rels, node.base, opContext)
            && this._refinementMatches(rels, node.refinement, opContext);
      case ECLNodeType.CONCEPT_REFERENCE:
        return this._complexExprSatisfiesConcept(expr, node.conceptId, null);
      case ECLNodeType.WILDCARD:
        return true;
      case ECLNodeType.MEMBER_OF:
        return false;
      default:
        throw new Error(`Unsupported ECL node type for expression membership: ${node.type}`);
    }
  };

  // Whether a post-coordinated expression's focus stands in the given hierarchy
  // relation to conceptId. A refined expression is always strictly more specific
  // than its focus, so it can never be an ancestor/self/parent/child edge — only
  // the descendant operators (<, <<) hold, via focus subsumption.
  _complexExprSatisfiesConcept = function (expr, conceptId, operator) {
    const cr = this.concepts.findConcept(conceptId);
    if (!cr.found) {
      throw new Error(`The SNOMED CT Concept ${conceptId} is not known`);
    }
    const target = cr.index;
    const focusRefs = (expr.concepts || [])
      .map(c => c.reference)
      .filter(r => r != null && r !== NO_REFERENCE && r >= 0);
    if (focusRefs.length === 0) return false;
    const subsumed = focusRefs.every(f => this.subsumes(target, f));
    switch (operator) {
      case ECLTokenType.DESCENDANT_OR_SELF_OF: // <<
      case ECLTokenType.DESCENDANT_OF:         // <
        return subsumed;
      // exact / ancestors / parents / children: a refined expression has no such
      // materialised standing, so it is not a member.
      default:
        return false;
    }
  };

// ── Set operation helpers ────────────────────────────────────────────────────

  /**
   * Flatten a SnomedFilterContext to a plain array of concept indexes,
   * handling the three different storage slots used by the existing filters.
   * @param {SnomedFilterContext} ctx
   * @returns {number[]}
   */
  _eclToIndexArray = function (ctx) {
    if (ctx.descendants && ctx.descendants.length > 0) return ctx.descendants;
    if (ctx.members && ctx.members.length > 0) return ctx.members.map(m => m.ref);
    if (ctx.matches && ctx.matches.length > 0) return ctx.matches.map(m => m.index);
    return [];
  };

  /**
   * Like _eclToIndexArray, but if the context is a bare wildcard (no
   * descendants populated) it materialises the full concept list
   * via _eclEnumerateAllConcepts. Used by dotted/refined evaluation,
   * which need an explicit concept set to iterate over.
   * @param {SnomedFilterContext} ctx
   * @returns {number[]}
   */
  _eclResolveSet = function (ctx, opContext) {
    if (ctx.eclWildcard && (!ctx.descendants || ctx.descendants.length === 0)) {
      return this._eclEnumerateAllConcepts(opContext);
    }
    return this._eclToIndexArray(ctx);
  };

  /**
   * AND: concepts present in both sets.
   */
  _eclIntersect = function (left, right, opContext) {
    if (left.eclWildcard) return right;
    if (right.eclWildcard) return left;
    const leftSet = new Set(this._eclToIndexArray(left));
    const result = new SnomedFilterContext();
    result.descendants = this._eclToIndexArray(right).filter(idx => {
      if (opContext) opContext.deadCheck('ecl:intersect');
      return leftSet.has(idx);
    });
    return result;
  };

  /**
   * OR: concepts present in either set.
   */
  _eclUnion = function (left, right, opContext) {
    if (left.eclWildcard || right.eclWildcard) return this._eclWildcard();
    if (opContext) opContext.deadCheck('ecl:union');
    const combined = new Set([
      ...this._eclToIndexArray(left),
      ...this._eclToIndexArray(right)
    ]);
    const result = new SnomedFilterContext();
    result.descendants = [...combined];
    return result;
  };

  /**
   * MINUS: concepts in left that are not in right.
   */
  _eclMinus = function (left, right, opContext) {
    const result = new SnomedFilterContext();

    if (right.eclWildcard) {
      result.descendants = [];
      return result;
    }

    const rightSet = new Set(this._eclToIndexArray(right));

    if (left.eclWildcard) {
      // Wildcard minus the right set: use the shared enumeration so `*` behaves
      // consistently everywhere.
      result.descendants = this._eclEnumerateAllConcepts(opContext)
        .filter(idx => !rightSet.has(idx));
      return result;
    }

    result.descendants = this._eclToIndexArray(left).filter(idx => {
      if (opContext) opContext.deadCheck('ecl:minus');
      return !rightSet.has(idx);
    });
    return result;
  };


  /**
   * Free-text search over active descriptions.
   *
   * Uses the in-memory word index (see tx/sct/text-index.js), built the first
   * time this edition is searched: every filter token (stop words aside) must
   * match a word of the concept's active descriptions, either as a prefix or
   * by sharing its stem. Filters with no indexable token (only 1-character
   * tokens), or an edition whose index failed to build, fall back to
   * scanSearch().
   *
   * Previously the third parameter was `exactMatch`, which the provider fed
   * from its unrelated `sort` flag - so $expand with a filter on an
   * include-all-codes value set matched ANY term by brute-force scan: 10k+
   * matches for a typical multi-word filter, with the event loop blocked for
   * the whole scan (tx.fhir.org incident 2026-09-17).
   *
   * @param {SearchFilterText} searchText
   * @param {boolean} includeInactive - include inactive concepts
   * @param {OperationContext|null} opContext - for yielding / deadline checks
   * @returns {Promise<SnomedFilterContext>}
   */
  async searchFilter(searchText, includeInactive = false, opContext = null) {
    const filterText = (searchText && searchText.filter ? searchText.filter : '').toLowerCase().trim();
    const tokens = filterTokens(filterText);
    if (tokens.length > 0) {
      const index = await this.getTextIndex(opContext);
      if (index) {
        const result = new SnomedFilterContext();
        const ordinals = index.search(tokens, opContext);
        if (opContext) {
          await opContext.checkAndYield('sct:searchFilter');
        }
        result.matches = rankMatches(this, index, ordinals, filterText, tokens, includeInactive);
        return result;
      }
    }
    return await this.scanSearch(filterText, includeInactive, opContext);
  }

  /**
   * The edition's text index, building it on first use. The build is shared:
   * concurrent searches wait on the same promise, and time spent waiting is
   * not charged to the waiting operation's compute budget. Resolves to null
   * if the build failed (the next search retries it).
   * @param {OperationContext|null} opContext
   * @returns {Promise<SnomedTextIndex|null>}
   */
  async getTextIndex(opContext = null) {
    if (this._textIndex) {
      return this._textIndex;
    }
    if (!this._textIndexPromise) {
      const started = Date.now();
      // Logger fetched lazily: importers and tests require this module too
      const textIndexLog = Logger.getInstance().child({module: 'tx-sct'});
      this._textIndexPromise = SnomedTextIndex.build(this).then(index => {
        this._textIndex = index;
        textIndexLog.info(`SNOMED text index for ${this.versionUri}: ${index.words.length} words, built in ${Date.now() - started}ms`);
        return index;
      }, error => {
        this._textIndexPromise = null;
        textIndexLog.error(`SNOMED text index build failed for ${this.versionUri}: ${error.message}`);
        return null;
      });
    }
    if (opContext && typeof opContext.waitFor === 'function') {
      return await opContext.waitFor(this._textIndexPromise, 'sct:textIndex');
    }
    return await this._textIndexPromise;
  }

  /**
   * Brute-force scan of every concept's active descriptions: every
   * whitespace-separated term of the filter must appear (as a substring) in
   * the same description. Expensive (hundreds of ms on a full edition), so it
   * yields through opContext.checkAndYield and the compute deadline applies.
   *
   * @param {string} filterText - lower-cased, trimmed
   * @param {boolean} includeInactive
   * @param {OperationContext|null} opContext
   * @returns {Promise<SnomedFilterContext>}
   */
  async scanSearch(filterText, includeInactive = false, opContext = null) {
    const result = new SnomedFilterContext();
    const searchTerms = filterText.split(/\s+/).filter(t => t.length > 0);
    const matches = [];
    if (searchTerms.length === 0) {
      result.matches = matches;
      return result;
    }

    const conceptCount = this.concepts.count();
    const conceptSize = this.concepts.constructor.CONCEPT_SIZE;
    for (let i = 0; i < conceptCount; i++) {
      if (opContext && (i & 0x3FF) === 0) {
        await opContext.checkAndYield('sct:searchFilter');
      }
      const conceptIndex = i * conceptSize;

      try {
        const concept = this.concepts.getConcept(conceptIndex);
        if (!includeInactive && !this.isActive(conceptIndex)) {
          continue;
        }

        const descriptionsRef = concept.descriptions;
        if (descriptionsRef === 0) continue;

        const descriptionIndices = this.refs.getReferences(descriptionsRef);
        let matchFound = false;
        let priority = 0;

        for (const descIndex of descriptionIndices) {
          const description = this.descriptions.getDescription(descIndex);
          if (description.active) {
            const term = this.strings.getEntry(description.iDesc).toLowerCase();
            if (searchTerms.every(searchTerm => term.includes(searchTerm))) {
              matchFound = true;
              // Calculate priority based on match quality
              let p;
              if (term === filterText) {
                p = 100; // Exact match
              } else if (term.startsWith(filterText)) {
                p = 50; // Prefix match
              } else {
                p = 10; // Contains match
              }
              if (p > priority) {
                priority = p;
              }
              if (priority === 100) {
                break;
              }
            }
          }
        }

        if (matchFound) {
          matches.push({
            index: conceptIndex,
            term: concept.identity,
            priority: priority
          });
        }
      } catch (error) {
        if (error instanceof Issue || (error && error.abandoned)) {
          throw error;
        }
        // Skip problematic concepts
        continue;
      }
    }

    // Sort by priority (descending)
    matches.sort((a, b) => b.priority - a.priority);

    result.matches = matches;
    return result;
  }
}

/**
 * SNOMED CT Code System Provider
 */
class SnomedProvider extends BaseCSServices {
  constructor(opContext, supplements, snomedServices) {
    super(opContext, supplements);
    this.sct = snomedServices;
  }

  // Metadata methods
  system() {
    return this.sct.getSystemUri();
  }

  version() {
    return this.sct.getVersion();
  }


  /**
   * @param {string} checkVersion - first version
   * @param {string} actualVersion - second version
   * @returns {boolean} True if actualVersion is more detailed than checkVersion (for SCT)
   */
  versionIsMoreDetailed(checkVersion, actualVersion) {
    return actualVersion && actualVersion.startsWith(checkVersion);
  }

  /**
   * The display name of the code system, as $lookup reports it.
   *
   * Without this, CodeSystemProvider's fallback applies, which returns the versioned uri -
   * so a SNOMED lookup answered "http://snomed.info/sct|http://snomed.info/sct/731000124108
   * /version/20230301" where every other code system answers something like "LOINC". The
   * edition is named because for SNOMED that is the part worth knowing; the version
   * parameter carries the uri.
   */
  name() {
    return this.sct.getDescription();
  }

  /**
   * $lookup's display name: the edition description (e.g. "SNOMED CT International
   * Edition"), which says more than the bare code system title.
   */
  // eslint-disable-next-line no-unused-vars
  lookupName(languages) {
    return this.sct.getDescription();
  }

  description() {
    return this.sct.getDescription();
  }

  totalCount() {
    return this.sct.totalCount;
  }

  async countAllCodes(excludeInactive) {
    return excludeInactive ? this.sct.activeConceptCount() : this.sct.totalCount;
  }

  contentMode() {
    return CodeSystemContentMode.Complete;
  }

  hasParents() {
    return true;
  }

  hasAnyDisplays(languages) {
    const langs = this._ensureLanguages(languages);

    // Check supplements first
    if (this._hasAnySupplementDisplays(langs)) {
      return true;
    }

    // SNOMED has displays for English and other languages
    return langs.isEnglishOrNothing();
  }

  // Core concept methods
  async code(context) {

    const ctxt = await this.#ensureContext(context);

    if (!ctxt) return null;

    if (ctxt.isComplex()) {
      return this.sct.expressionServices.renderExpression(ctxt.expression, SnomedServicesRenderOption.Minimal);
    } else {
      return ctxt.getCode() || this.sct.getConceptId(ctxt.getReference());
    }
  }

  async display(context) {

    const ctxt = await this.#ensureContext(context);

    if (!ctxt) return null;

    // Check supplements first
    let disp = this._displayFromSupplements(ctxt.getCode());
    if (disp) return disp;

    if (ctxt.isComplex()) {
      return this.sct.expressionServices.renderExpression(ctxt.expression, SnomedServicesRenderOption.FillMissing);
    } else {
      return this.sct.getDisplayName(ctxt.getReference(), this.sct.defaultLanguage);
    }
  }

  async definition(context) {
    await this.#ensureContext(context);
    return null; // SNOMED doesn't provide definitions in this sense
  }

  async isAbstract(context) {
    await this.#ensureContext(context);
    return false; // SNOMED concepts are not abstract
  }

  async isInactive(context) {

    const ctxt = await this.#ensureContext(context);

    if (!ctxt || ctxt.isComplex()) return false;

    return !this.sct.isActive(ctxt.getReference());
  }

  async isDeprecated(context) {
    await this.#ensureContext(context);

    return false; // Handle via status if needed
  }

  async getStatus(context) {

    const ctxt = await this.#ensureContext(context);

    if (!ctxt || ctxt.isComplex()) return null;

    return this.sct.isActive(ctxt.getReference()) ? 'active' : 'inactive';
  }

  async designations(context, displays, significantOnly = false) {

    const ctxt = await this.#ensureContext(context);

    if (ctxt) {


      if (ctxt.isComplex()) {
        // For complex expressions, just add the display
        const display = await this.display(context);
        if (display) {
          displays.addDesignation(true, 'active', 'en-US', DesignationUse.PREFERRED, display);
        }
      } else {
        // Get all designations for the concept
        try {
          const concept = this.sct.concepts.getConcept(ctxt.getReference());
          const descriptionsRef = concept.descriptions;

          if (descriptionsRef !== 0) {
            const descriptionIndices = this.sct.refs.getReferences(descriptionsRef);
            const K = this.sct._displayConstants();

            if (significantOnly) {
              // $expand: emit the "significant" designations only — the FSN and
              // the preferred synonym, active descriptions only. Acceptable
              // synonyms are the bulk of a SNOMED concept's descriptions and are
              // not needed to render an expansion, so they are dropped.
              //
              // One per LANGUAGE, though, not one overall: the display for a
              // request is chosen downstream by
              // Designations.preferredDesignation(displayLanguage), so a concept
              // that emits only its English terms has nothing for a
              // displayLanguage=de request to match and silently falls back to
              // English. Keeping the preferred synonym in every language the
              // concept has is what makes localized expansions work at all
              // (e.g. the Swiss edition, whose German terms are preferred in the
              // Swiss German language refset 2041000195100).
              //
              // The edition-default display is also added as the display
              // designation (which the expand worker selects for `display` when
              // no language was asked for, and skips from the emitted list).
              const fsns = new Map(), prefSyns = new Map();
              for (const descIndex of descriptionIndices) {
                const description = this.sct.descriptions.getDescription(descIndex);
                if (!description.active) continue;
                const term = this.sct.strings.getEntry(description.iDesc).trim();
                const langCode = this.getLanguageCode(description.lang);
                const kind = this.sct.concepts.getConcept(description.kind);
                const use = { system: 'http://snomed.info/sct', code: String(kind.identity), display: this.sct.getDisplayName(description.kind) };
                if (description.kind === K.fsn) {
                  if (!fsns.has(langCode)) fsns.set(langCode, { langCode, use, term });
                } else if (this.sct._synonymIsPreferred(description)) {
                  if (!prefSyns.has(langCode)) prefSyns.set(langCode, { langCode, use, term });
                }
              }
              // Tagged with the language the term is actually in, not a
              // hard-coded en-US: on a multi-language edition the edition
              // display can be French or Dutch, and mislabelling it as English
              // is what puts it in an IG's English display column and makes the
              // real French designation look like a duplicate of it. English
              // stays 'en-US' (the term comes from the US English language
              // reference set), so nothing changes for English editions.
              const display = this.sct.getDisplayNameEx(ctxt.getReference());
              const displayLang = (!display.lang || display.lang === 'en') ? 'en-US' : display.lang;
              if (display.term) displays.addDesignation(true, 'active', displayLang, null, display.term);
              // FSNs before synonyms, matching the designation order the published
              // tx-ecosystem expectations were written against (sct/expand-inactive).
              // Which of the two is chosen as the display is settled by
              // Designations.preferredDesignation(), which ranks the SNOMED synonym
              // above the FSN - not by the order they are emitted in.
              for (const d of fsns.values()) displays.addDesignation(false, 'active', d.langCode, d.use, d.term);
              for (const d of prefSyns.values()) displays.addDesignation(false, 'active', d.langCode, d.use, d.term);
            } else {
              // $lookup: emit every description. Order matters only for the
              // display: a request with no displayLanguage takes the first
              // designation Designations._isPreferred() accepts, which is any
              // SNOMED synonym. Ranking by the edition's display language
              // reference set first (rather than by "preferred in any refset")
              // keeps that pick in one language - otherwise a national edition
              // answers $lookup in French for one concept and Dutch for the
              // next, depending on description storage order.
              const K2 = this.sct._displayConstants();
              const displayRefsets = this.sct._displayRefsetOrder();
              // Buckets: 0 = preferred in the edition's display refset, 1 =
              // preferred in some other language refset, 2 = everything else
              // (FSNs and acceptable synonyms, left in their original order -
              // Array.sort is stable, so nothing else about the output moves).
              const rank = (description) => {
                if (description.kind !== K2.synonym) return 2;
                for (const refsetIdx of displayRefsets) {
                  if (this.sct._descAcceptability(description, refsetIdx) === K2.preferred) return 0;
                }
                return this.sct._synonymIsPreferred(description) ? 1 : 2;
              };
              const orderedIndices = descriptionIndices.slice().sort((a, b) => {
                const da = this.sct.descriptions.getDescription(a);
                const db = this.sct.descriptions.getDescription(b);
                return rank(da) - rank(db);
              });
              for (const descIndex of orderedIndices) {
                const description = this.sct.descriptions.getDescription(descIndex);
                const term = this.sct.strings.getEntry(description.iDesc).trim();
                const langCode = this.getLanguageCode(description.lang);
                const kind = this.sct.concepts.getConcept(description.kind);
                const kid = String(kind.identity);
                const kdesc = this.sct.getDisplayName(description.kind);
                let use = { system: 'http://snomed.info/sct', code: kid, display : kdesc};
                displays.addDesignation(false, description.active ? 'active' : 'inactive', langCode, use, term);
              }
            }
          }
        } catch (error) {
          // Add basic designation if we can't read detailed descriptions
          const display = this.sct.getDisplayName(ctxt.getReference());
          if (display) {
            displays.addDesignation(true, 'active','en-US', null, display);
          }
        }

        // Add supplement designations
        this._listSupplementDesignations(ctxt.getCode(), displays);
      }
    }
  }

  getLanguageCode(langIndex) {
    return SCT_LANGUAGE_CODES[langIndex] || 'en';
  }

  // Lookup methods
  async locate(code) {
    if (!code) return { context: null, message: 'Empty code' };

    const conceptId = this.sct.stringToIdOrZero(code);

    if (conceptId === 0n) {
      // Try parsing as expression
      try {
        const expression = new SnomedExpressionParser().parse(code);
        this.sct.expressionServices.checkExpression(expression);
        return {
          context: SnomedExpressionContext.fromExpression(code, expression),
          message: null
        };
      } catch (error) {
        return {
          context: null,
          message: Number.isInteger(code) ? undefined : `Not a valid expression: ${error.message}`
        };
      }
    } else {
      const result = this.sct.concepts.findConcept(conceptId);
      if (result.found) {
        return {
          context: SnomedExpressionContext.fromCode(code, result.index),
          message: null
        };
      } else {
        return {
          context: null,
          message: undefined
        };
      }
    }
  }

  async locateIsA(code, parent, disallowParent = false) {


    const childId = this.sct.stringToIdOrZero(code);
    const parentId = this.sct.stringToIdOrZero(parent);

    if (childId === 0n || parentId === 0n) {
      return { context: null, message: 'Invalid concept ID' };
    }

    const childResult = this.sct.concepts.findConcept(childId);
    const parentResult = this.sct.concepts.findConcept(parentId);

    if (!childResult.found || !parentResult.found) {
      return { context: null, message: 'Concept not found' };
    }

    const subsumes = this.sct.subsumes(parentResult.index, childResult.index);
    const allowedByParent = !disallowParent || (childResult.index !== parentResult.index);

    if (subsumes && allowedByParent) {
      return {
        context: SnomedExpressionContext.fromCode(code, childResult.index),
        message: null
      };
    } else {
      return { context: null, message: 'Concept is not subsumed by parent' };
    }
  }

  // Iterator methods
  async iterator(context) {


    if (!context) {
      // Iterate all active root concepts; the walk descends into each root's
      // children via includeCodeAndDescendants. `total` reports the real concept
      // count (not the root count) so the expansion size cap is meaningful, while
      // `keys` are the roots and nextContext bounds on keys.length.
      // activeRoots holds concept *ids* (BigInt); map them to concept indices so
      // the contexts and the getConceptChildren descent work (which key on index).
      const rootKeys = [];
      for (const rootId of this.sct.activeRoots) {
        const r = this.sct.concepts.findConcept(rootId);
        if (r.found) rootKeys.push(r.index);
      }
      return {
        context: null,
        keys: rootKeys,
        current: 0,
        total: this.sct.totalCount
      };
    } else {
      const ctxt = await this.#ensureContext(context);
      if (!ctxt || ctxt.isComplex()) {
        return { context: ctxt, keys: [], current: 0, total: 0 };
      }

      // Get children of this concept
      const children = this.sct.getConceptChildren(ctxt.getReference());
      return {
        context: ctxt,
        keys: children,
        current: 0,
        total: children.length
      };
    }
  }

  async nextContext(iteratorContext) {
    if (iteratorContext.current >= iteratorContext.keys.length) {
      return null;
    }

    const key = iteratorContext.keys[iteratorContext.current];
    iteratorContext.current++;

    return SnomedExpressionContext.fromReference(key);
  }

  async extendLookup(context, props, params) {
    const ctxt = await this.#ensureContext(context);
    if (ctxt) {
      if (!(ctxt instanceof SnomedExpressionContext) || ctxt.expression?.concepts.length == 1) {
        // Only what was asked for, if anything was (see _hasProp): effectiveTime, module,
        // parent, child and the defining relationships are returned by default but are not
        // important enough to return when the client named the properties it wants.
        // The mappings (alternate identifiers such as the LOINC code) are returned by
        // default too, and when asked for by name.
        if (this._hasProp(props, 'effectiveTime', true)) {
          const time = this.sct.concepts.getConcept(ctxt.getReference()).effectiveTime;
          // Pascal TDateTime epoch (1899-12-30) computed in UTC so the formatted
          // date is timezone-independent. new Date(1899,11,30) is LOCAL midnight,
          // which in zones ahead of UTC rolls the ISO date back by one day.
          const pascalEpochUTC = Date.UTC(1899, 11, 30);
          const date = new Date(pascalEpochUTC + time * 86400000);
          const dateStr = date.toISOString().slice(0, 10);
          this._addDateTimeProperty(params, 'property', 'effectiveTime', dateStr);
        }

        if (this._hasProp(props, 'parent', true)) {
          const parents = this.sct.getConceptParents(ctxt.getReference());
          for (let parentRef of parents) {
            const code = this.sct.getConceptId(parentRef);
            const description = this.sct.getDisplayName(parentRef);
            this._addCodeProperty(params, 'property', 'parent', code, null, description);
          }
        }

        if (this._hasProp(props, 'child', true)) {
          const children = this.sct.getConceptChildren(ctxt.getReference());
          for (let childRef of children) {
            const code = this.sct.getConceptId(childRef);
            const description = this.sct.getDisplayName(childRef);
            this._addCodeProperty(params, 'property', 'child', code, null, description);
          }
        }

        if (this._hasProp(props, 'module', true)) {
          const moduleId = this.sct.concepts.getModuleId(ctxt.getReference());
          if (moduleId) {
            const code = this.sct.getConceptId(moduleId);
            this._addCodeProperty(params, 'property', 'module', code, null, this.sct.getDisplayName(moduleId));
          }
        }

        const relationships = this.sct.getConceptRelationships(ctxt.getReference());
        let set = new Set();
        for (let relationshipRef of relationships) {
          const relationship = this.sct.relationships.getRelationship(relationshipRef);
          const relType = this.sct.getConceptId(relationship.relType);
          if (relType != '116680003' && this._hasProp(props, relType, true)) {
            const relTypeD = this.sct.getDisplayName(relationship.relType);
            const code = this.sct.getConceptId(relationship.target);
            const description = this.sct.getDisplayName(relationship.target);
            if (!set.has(relType + ":" + code)) {
              set.add(relType + ":" + code);
              let p = this._addCodeProperty(params, 'property', relType, code, null, description);
              p.part.push({name: 'code-display', valueString: relTypeD});
            }
          }
        }

        this.#addMappingProperties(ctxt, props, params);
      }
      if (ctxt instanceof SnomedExpressionContext) {
        // ignore concepts for now, but list refinements and refinement groups
        for (const refinement of ctxt.expression.refinements) {
          await this._addRefinementProperty(params, refinement);
        }
        for (const refinementGroup of ctxt.expression.refinementGroups) {
          for (const refinement of refinementGroup.refinements) {
            await this._addRefinementProperty(params, refinement);
          }
        }
      }
    }
  }

  /**
   * The concept's alternate identifiers in the schemes we know (IDENTIFIER_SCHEMES), as
   * Coding-valued properties named for the scheme - e.g. loinc = http://loinc.org#2160-0.
   * Returned by default, and when asked for by name.
   */
  #addMappingProperties(ctxt, props, params) {
    const conceptId = this.sct.getConceptId(ctxt.getReference());
    for (const ident of this.sct.getIdentifiers(conceptId)) {
      const scheme = IDENTIFIER_SCHEMES[ident.scheme];
      if (scheme && this._hasProp(props, scheme.property, true)) {
        params.push({
          name: 'property',
          part: [
            { name: 'code', valueCode: scheme.property },
            { name: 'value', valueCoding: { system: scheme.system, code: ident.code } }
          ]
        });
      }
    }
  }

  /**
   * Report one refinement of a post-coordinated expression as a lookup property.
   *
   * The value is handled as an expression, not as a string: SnomedExpression's
   * describe() is a human-readable rendering that joins concepts and refinements
   * with commas ("85562004,272741003=24028007"), so round-tripping it through
   * display() parsed it back as SCG and failed on any refined value.
   *
   * @param {Object} params - the Parameters being built
   * @param {SnomedRefinement} refinement
   */
  async _addRefinementProperty(params, refinement) {
    const codeA = refinement.name.code;
    const value = SnomedExpressionContext.fromExpression('', refinement.value);
    const codeB = await this.code(value);
    const description = await this.display(value);
    const p = this._addCodeProperty(params, 'property', codeA, codeB, null, description);
    p.part.push({name: 'code-display', valueString: await this.display(codeA)});
  }

  // Filter support
  async doesFilter(prop, op, value) {
    if (prop === 'concept') {
      const id = this.sct.stringToIdOrZero(value);
      if (id !== 0n && ['=', 'is-a', 'descendent-of', 'in', 'generalizes', 'child-of'].includes(op)) {
        return this.sct.conceptExists(value);
      }
      if (op === 'in' && value.includes(',')) {
        let ok = true;
        for (const idStr of value.split(',')) {
          const id = this.sct.stringToIdOrZero(idStr);
          if (id === 0n) {
            ok = false;
            break;
          }
        }
        return ok;
      }
    }
    if (prop === 'inactive') {
      return op === '=' && ['true', 'false'].includes(value);
    }

    if (prop === 'moduleId') {
      const id = this.sct.stringToIdOrZero(value);
      return id !== 0n && op === '=';
    }
    if (prop === 'constraint') {
      return op === '=';
    }

    if (prop == 'expressions' && op == '=' && ['true', 'false'].includes(value)) {
      return true;
    }

    if (prop.startsWith(MAPPED_FILTER_PREFIX)) {
      return op === 'exists' && ['true', 'false'].includes(value) &&
        this.sct.stringToIdOrZero(prop.substring(MAPPED_FILTER_PREFIX.length)) !== 0n;
    }

    const cid = this.sct.stringToIdOrZero(prop);
    if (cid != 0) {
      const id = this.sct.stringToIdOrZero(value);
      return id !== 0n && op === '=';
    }

    return false;
  }

  // eslint-disable-next-line no-unused-vars
  async getPrepContext(iterate) {

    return new SnomedPrep(); // Simple filter context
  }

  // Cache key pinning resolved analysis to the SNOMED edition url + version.
  // SNOMED always has both; the url varies across editions (incl. the test set).
  _snomedFilterCacheKey() {
    return this.system() + '|' + this.version();
  }

  // Return a fresh filter context wrapping a cached ECL analysis, or null on
  // miss. The concept arrays are shared read-only (nothing mutates them for an
  // ECL set); only the cursor state is per-context.
  _getCachedEcl(fc) {
    if (!fc) {
      return null;
    }
    const byVersion = fc[SNOMED_FILTER_ANALYSIS];
    if (!byVersion) {
      return null;
    }
    const data = byVersion.get(this._snomedFilterCacheKey());
    if (!data) {
      return null;
    }
    const ctx = new SnomedFilterContext();
    ctx.descendants = data.descendants;
    ctx.members = data.members;
    ctx.matches = data.matches;
    ctx.eclAst = data.eclAst;
    return ctx;
  }

  // Memoise an ECL analysis on fc, keyed by url+version. Skips iteration-
  // sensitive results (wildcards): their materialised form is not valid for the
  // other iteration mode, and their lazy form is cheap to recompute anyway.
  _cacheEcl(fc, resolved) {
    if (!fc || !resolved || resolved.eclWildcard || resolved.iterationSensitive) {
      return;
    }
    let byVersion = fc[SNOMED_FILTER_ANALYSIS];
    if (!byVersion) {
      byVersion = new Map();
      Object.defineProperty(fc, SNOMED_FILTER_ANALYSIS, { value: byVersion, enumerable: false, configurable: true, writable: true });
    }
    byVersion.set(this._snomedFilterCacheKey(), {
      descendants: resolved.descendants,
      members: resolved.members,
      matches: resolved.matches,
      eclAst: resolved.eclAst,
    });
  }

  async filter(filterContext, forIteration, prop, op, value, fc) {

    if (prop === 'concept') {
      const id = this.sct.stringToIdOrZero(value);
      if (id === 0n && op !== 'in') {
        throw new Error(`Invalid concept ID: ${value}`);
      }

      switch (op) {
        case '=': {
          filterContext.filters.push(this.sct.filterEquals(id));
          return null;
        }
        case 'is-a': {
          filterContext.filters.push(this.sct.filterIsA(id, true));
          return null;
        }
        case 'descendent-of': {
          filterContext.filters.push(this.sct.filterIsA(id, false));
          return null;
        }
        case 'child-of': {
          filterContext.filters.push(this.sct.filterChildOf(id));
          return null;
        }
        case 'generalizes': {
          filterContext.filters.push(this.sct.filterGeneralizes(id, false));
          return null;
        }
        case 'in': {
          filterContext.filters.push(this.sct.filterIn(value));
          return null;
        }
        default:
          throw new Error(`Unsupported filter operation: concept ${op} ${value}`);
      }
    }

    if (prop === 'inactive') {
      if (value !== 'true' && value !== 'false') {
        throw new Error(`Invalid filter value: ${value}`);
      }

      switch (op) {
        case '=': {
          filterContext.filters.push(this.sct.filterInactive(value === 'true'));
          return null;
        }
        default:
          throw new Error(`Unsupported filter operation: inactive ${op} ${value}`);
      }
    }

    if (prop === 'constraint' && op === '=') {
      // Reuse a previously resolved ECL analysis for this same cached value set
      // filter against the same code system (url+version). ECL resolution is the
      // expensive SNOMED filter to prepare; the resolved concept list is shared
      // read-only, wrapped in a fresh context so the iteration cursor is per-use.
      const cached = this._getCachedEcl(fc);
      if (cached) {
        filterContext.filters.push(cached);
        return null;
      }
      const resolved = await this.sct.filterECL(value, forIteration, this.opContext);
      this._cacheEcl(fc, resolved);
      filterContext.filters.push(resolved);
      return null;
    }

    if (prop === 'moduleId') {
      const id = this.sct.stringToIdOrZero(value);
      if (id === 0n) {
        throw new Error(`Invalid concept ID: ${value}`);
      }

      switch (op) {
        case '=': {
          filterContext.filters.push(this.sct.filterModuleId(id));
          return null;
        }
        default:
          throw new Error(`Unsupported filter operation: moduleId ${op} ${value}`);
      }
    }

    if (prop == 'expressions' && op == '=') {
      const filter = new SnomedFilterContext();
      filter.expressions = value == 'true';
      filterContext.filters.push(filter);
      return null;
    }

    // mapped:<identifier scheme> exists true|false - concepts that do (or don't) have an
    // alternate identifier in that scheme (e.g. mapped:30051010000102: has a LOINC code).
    // A prefix, so as not to be confused with the attribute filters (<attribute> = <value>)
    if (prop.startsWith(MAPPED_FILTER_PREFIX)) {
      const scheme = prop.substring(MAPPED_FILTER_PREFIX.length);
      if (this.sct.stringToIdOrZero(scheme) === 0n) {
        throw new Error(`Invalid identifier scheme: ${scheme}`);
      }
      if (op !== 'exists') {
        throw new Error(`Unsupported filter operation: ${prop} ${op} ${value}`);
      }
      if (value !== 'true' && value !== 'false') {
        throw new Error(`Invalid filter value: ${value}`);
      }
      const filter = new SnomedFilterContext();
      filter.mappedScheme = scheme;
      filter.mappedExists = value === 'true';
      filterContext.filters.push(filter);
      return null;
    }

    const cid = this.sct.stringToIdOrZero(prop);
    if (cid != 0) {

      const id = this.sct.stringToIdOrZero(value);
      if (id === 0n) {
        throw new Error(`Invalid concept ID: ${value}`);
      }

      switch (op) {
        case '=': {
          filterContext.filters.push(this.sct.filterByProperty(cid, id));
          return null;
        }
        default:
          throw new Error(`Unsupported filter operation: ${prop} ${op} ${value}`);
      }
    }

    throw new Error(`Unsupported filter property: ${prop}`);
  }


  async executeFilters(filterContext) {
    return filterContext.filters;
  }

  // eslint-disable-next-line no-unused-vars
  async filtersNotClosed(filterContext) {
    for (let filter of filterContext.filters) {
      if (filter.expressions != undefined && !filter.expressions) {
        return false;
      }
    }
    return true;
  }

  async filterSize(filterContext, set) {
    // A wildcard (`*`) set is lazy - it carries the eclWildcard flag rather than a
    // materialised descendant list - so count the active concepts it denotes.
    if (set.eclWildcard && (!set.descendants || set.descendants.length === 0)) {
      return this.sct._eclEnumerateAllConcepts(this.opContext).length;
    }
    if (set.matches && set.matches.length > 0) {
      return set.matches.length;
    } else if (set.members && set.members.length > 0) {
      return set.members.length;
    } else if (set.descendants && set.descendants.length > 0) {
      return set.descendants.length;
    }

    return 0;
  }

  async filterMore(filterContext, set) {
    set.cursor = set.cursor || 0;
    this.#ensurePopulated(set);
    const size = await this.filterSize(filterContext, set);
    return set.cursor < size;
  }

  async filterConcept(filterContext, set) {
    const size = await this.filterSize(filterContext, set);
    if (set.cursor >= size) {
      return null;
    }

    let key;
    if (set.matches && set.matches.length > 0) {
      key = set.matches[set.cursor].index;
    } else if (set.members && set.members.length > 0) {
      key = set.members[set.cursor].ref;
    } else if (set.descendants && set.descendants.length > 0) {
      key = set.descendants[set.cursor];
    } else {
      return null;
    }

    set.cursor++;
    return SnomedExpressionContext.fromReference(key);
  }

  async filterLocate(filterContext, set, code) {

    const conceptResult = await this.locate(code);
    if (!conceptResult.context) {
      return conceptResult.message;
    }

    const ctxt = conceptResult.context;
    const reference = ctxt.getReference();

    if (set.eclWildcard) {
      return ctxt; // `*` is every concept; inactive ones included
    }

    // A post-coordinated expression validated against an ECL value set: test the
    // expression's membership against the constraint directly (subsumption +
    // refinements), rather than collapsing it to its focus concept.
    if (set.eclAst && ctxt.isComplex()) {
      return this.sct._eclExpressionSatisfies(ctxt, set.eclAst, this.opContext) ? ctxt : null;
    }
    let found = false;

    if (set.mappedScheme !== undefined) {
      found = this.#isMapped(reference, set.mappedScheme) === set.mappedExists;
    } else if (set.inactive !== undefined) {
      let concept = this.sct.concepts.getConcept(reference);
      let active = (concept.flags & 0x0F) === 0;
      found = active !== set.inactive
    } else if (set.moduleId) {
      let concept = this.sct.concepts.getConcept(reference);
      let moduleId = this.sct.concepts.getModuleId(concept.index);
      found = moduleId === set.moduleId;
    } else if (set.propProp || set.propValue) {
      found = false;
      const relationships = this.sct.getConceptRelationships(reference);
      for (let relationshipRef of relationships) {
        const relationship = this.sct.relationships.getRelationship(relationshipRef);
        if (set.propProp === relationship.relType && set.propValue === relationship.target) {
          found = true;
        }
      }
    } else if (set.matches && set.matches.length > 0) {
      // filterLocate is only ever called once per set (single code, validate
      // path), so a Set would cost O(n) to build for one lookup - a plain scan
      // is the right call here. filterCheck, which is looped, uses the Sets.
      found = set.matches.some(m => m.index === reference);
    } else if (set.members && set.members.length > 0) {
      found = set.members.some(m => m.ref === reference);
    } else if (set.descendants && set.descendants.length > 0) {
      found = set.descendants.includes(reference);
    }

    if (found) {
      return ctxt;
    } else {
      return null;
    }
  }

  async filterCheck(filterContext, set, concept) {
    if (!(concept instanceof SnomedExpressionContext)) {
      return false;
    }

    if (set.expressions != undefined) {
      let b = set.expressions || !concept.isComplex();
      return b;
    }

    const reference = concept.getReference();
    if (set.mappedScheme !== undefined) {
      return this.#isMapped(reference, set.mappedScheme) === set.mappedExists;
    }
    if (set.inactive !== undefined) {
      return this.sct.isActive(reference) !== set.inactive;
    }

    if (set.moduleId) {
      return this.sct.concepts.getModuleId(reference) === set.moduleId;
    }

    if (set.propProp || set.propValue) {
      const relationships = this.sct.getConceptRelationships(reference);
      for (let relationshipRef of relationships) {
        const relationship = this.sct.relationships.getRelationship(relationshipRef);
        if (set.propProp === relationship.relType && set.propValue === relationship.target) {
          return true;
        }
      }
    }

    if (set.matches && set.matches.length > 0) {
      return this.#matchesHas(set, reference);
    } else if (set.members && set.members.length > 0) {
      return this.#membersHas(set, reference);
    } else if (set.descendants && set.descendants.length > 0) {
      return this.#descendantsHas(set, reference);
    }
    if (set.eclWildcard) {
      return true; // `*` is every concept; inactive ones included
    }
    return false;
  }

  // Lazily build and cache a membership Set on the filter context so repeated
  // filterLocate/filterCheck calls test membership in O(1) instead of scanning
  // the descendants/members/matches array each time. The length guard rebuilds
  // the Set if the underlying array was mutated (e.g. by #ensurePopulated).
  #descendantsHas(set, reference) {
    if (!set._descSet || set._descSetLen !== set.descendants.length) {
      set._descSet = new Set(set.descendants);
      set._descSetLen = set.descendants.length;
    }
    return set._descSet.has(reference);
  }

  #membersHas(set, reference) {
    if (!set._memberSet || set._memberSetLen !== set.members.length) {
      set._memberSet = new Set(set.members.map(m => m.ref));
      set._memberSetLen = set.members.length;
    }
    return set._memberSet.has(reference);
  }

  #matchesHas(set, reference) {
    if (!set._matchSet || set._matchSetLen !== set.matches.length) {
      set._matchSet = new Set(set.matches.map(m => m.index));
      set._matchSetLen = set.matches.length;
    }
    return set._matchSet.has(reference);
  }

  /** Whether the concept (by reference) has an alternate identifier in the scheme */
  #isMapped(reference, scheme) {
    return this.sct.getIdentifiers(this.sct.getConceptId(reference), scheme).length > 0;
  }

  #ensurePopulated(set) {
    if (set.populationDone) {
      return;
    }
    if (set.mappedScheme !== undefined) {
      if (set.mappedExists) {
        // straight from the identifier index, in concept order
        const refs = new Set();
        for (const [conceptId, idents] of this.sct.identifiersByConcept) {
          if (idents.some(i => i.scheme === set.mappedScheme)) {
            const r = this.sct.concepts.findConcept(BigInt(conceptId));
            if (r.found) {
              refs.add(r.index);
            }
          }
        }
        set.descendants = [...refs].sort((a, b) => a - b);
      } else {
        for (let i = 0; i < this.sct.concepts.count(); i++) {
          const concept = this.sct.concepts.getConceptByCount(i);
          if (!this.#isMapped(concept.index, set.mappedScheme)) {
            set.descendants.push(concept.index);
          }
        }
      }
      set.populationDone = true;
      return;
    }
    if (set.inactive !== undefined && set.descendants.length === 0) {
      for (let i = 0; i < this.sct.concepts.count(); i++) {
        let concept = this.sct.concepts.getConceptByCount(i);
        let active = (concept.flags & 0x0F) === 0;
        if (active !== set.inactive) {
          set.descendants.push(concept.index);
        }
      }
    }
    if (set.moduleId) {
      for (let i = 0; i < this.sct.concepts.count(); i++) {
        let concept = this.sct.concepts.getConceptByCount(i);
        let moduleId = this.sct.concepts.getModuleId(concept.index);
        if (moduleId === set.moduleId) {
          set.descendants.push(concept.index);
        }
      }
    }
    if (set.propProp || set.propValue) {
      for (let i = 0; i < this.sct.concepts.count(); i++) {
        let concept = this.sct.concepts.getConceptByCount(i);
        const relationships = this.sct.getConceptRelationships(concept.index);
        for (let relationshipRef of relationships) {
          const relationship = this.sct.relationships.getRelationship(relationshipRef);
          if (set.propProp === relationship.relType && set.propValue === relationship.target) {
            set.descendants.push(concept.index);
          }
        }
      }
    }
    set.populationDone = true;
  }

  // Search filter
  // eslint-disable-next-line no-unused-vars
  async searchFilter(filterContext, filter, sort) {
    // `sort` is not a match-mode flag: results are always ranked.
    let f = await this.sct.searchFilter(filter, false, this.opContext);
    filterContext.filters.push(f);
    return f;
  }

  // Subsumption testing
  /**
   * Subsumption between two codes, either of which may be a postcoordinated expression.
   *
   * PRECONDITION: both codes have already been validated. doSubsumes (the only caller)
   * runs locate() on each first, which parses and runs checkExpression - so an
   * expression that breaks the concept model is reported as an invalid code before it
   * gets here, rather than having a subsumption answer computed for it. The check is
   * deliberately not repeated here: it evaluates ECL for the MRCM range constraints, and
   * doing that twice per request is not free.
   *
   * @param {string} codeA
   * @param {string} codeB
   * @returns {Promise<string>} equivalent | subsumes | subsumed-by | not-subsumed
   */
  async subsumesTest(codeA, codeB) {
    try {
      const exprA = new SnomedExpressionParser(this.sct.concepts).parse(codeA);
      const exprB = new SnomedExpressionParser(this.sct.concepts).parse(codeB);

      if (exprA.isSimple() && exprB.isSimple()) {
        const refA = exprA.concepts[0].reference;
        const refB = exprB.concepts[0].reference;

        if (refA === refB) {
          return 'equivalent';
        } else if (this.sct.subsumes(refA, refB)) {
          return 'subsumes';
        } else if (this.sct.subsumes(refB, refA)) {
          return 'subsumed-by';
        } else {
          return 'not-subsumed';
        }
      } else {
        const b1 = this.sct.expressionServices.expressionSubsumes(exprA, exprB);
        const b2 = this.sct.expressionServices.expressionSubsumes(exprB, exprA);

        if (b1 && b2) {
          return 'equivalent';
        } else if (b1) {
          return 'subsumes';
        } else if (b2) {
          return 'subsumed-by';
        } else {
          // No structural relationship found - which is NOT the same as there being
          // none. Structural comparison of normal forms is sound when it succeeds (a
          // proof is a proof) but not when it fails: SNOMED's OWL axiom reference set
          // carries general concept inclusions and property chains whose entailments
          // are baked into the distributed inferred relationships for precoordinated
          // concepts, but a postcoordinated expression is one the classifier never saw,
          // so those entailments are not available for it. Answering 'not-subsumed'
          // here would assert something we have not established, in the direction that
          // wrongly excludes a code from a cohort.
          //
          // $subsumes has four outcome codes and none of them means "unknown", so the
          // only honest answer is an error. Both codes are valid and the request is
          // well formed, hence 422 rather than 400.
          throw cannotDetermineSubsumption('Unable to determine the subsumption relationship between '
            + `'${codeA}' and '${codeB}': at least one is a postcoordinated expression and no `
            + 'relationship follows from comparing their normal forms. Establishing that there '
            + 'is no relationship would require classification, which this server does not do, '
            + 'so no outcome is returned rather than one that may be wrong');
        }
      }
    } catch (error) {
      // Errors that already say how they should be reported pass straight through -
      // wrapping them would lose the status and issue code.
      if (error.statusCode) {
        throw error;
      }
      throw new Error(`Error in subsumption test: ${error.message}`);
    }
  }

  // Helper methods
  async #ensureContext(context) {
    if (!context) {
      return null;
    }

    if (typeof context === 'string') {
      const result = await this.locate(context);
      if (!result.context) {
        throw new Error(result.message);
      }
      return result.context;
    }

    if (context instanceof SnomedExpressionContext) {
      return context;
    }

    throw new Error(`Unknown type at #ensureContext: ${typeof context}`);
  }

  versionAlgorithm() {
    return 'url';
  }

  isNotClosed() {
    return true;
  }

  isDisplay(cd) {
    return cd.use.system === this.system() &&
        (cd.use.code === '900000000000013009' || cd.use.code === '900000000000003001');
  }

  async getTranslations(map, coding, target, reverse) {
    if (map && map.jsonObj.identifierMap) {
      return this.translateByIdentifier(map, coding, target);
    }
    if (!map || reverse) {
      return [];
    }
    if (map.jsonObj.editionTranslation) {
      return this.translateToEdition(map, coding);
    }
    if (target && target !== this.system()) {
      return [];
    }
    let ref = this.sct.concepts.findConcept(map.id);
    if (!ref.found) {
      return [];
    }
    let rref = this.sct.refSetIndex.getRefSetByConcept(ref.index);
    if (rref == -1) {
      return [];
    }
    let refSetRecord = this.sct.refSetIndex.getReferenceSet(rref);
    let members = this.sct.refSetMembers.getMembers(refSetRecord.membersByRef);
    let srcConcept = this.sct.concepts.findConcept(coding.code);
    if (!srcConcept.found) {
      return [];
    }

    let result = [];
    let L = 0;
    let H = members.length - 1;
    while (L <= H) {
      const I = Math.floor((L + H) / 2);
      const ref = members[I].ref;
      if (ref < srcConcept.index) {
        L = I + 1;
      } else if (ref > srcConcept.index) {
        H = I - 1;
      } else {
        // Found — but scan left for first match in case of duplicates
        let first = I;
        while (first > 0 && members[first - 1].ref === srcConcept.index) {
          first--;
        }
        // Process all matching members
        for (let i = first; i < members.length && members[i].ref === srcConcept.index; i++) {
          let values = this.sct.refs.getReferences(members[i].values);
          if (values && values.length >= 1) {
            let tgtId = String(this.sct.concepts.getConceptId(values[0]));
            let ct = {
              map: map.vurl,
              code: tgtId,
              system: this.system(),
              version : this.version(),
              display: await this.display(tgtId),
              relationship: map.jsonObj.relationship
            }
            result.push(ct);
          }
        }
        break;
      }
    }

    return result;
  }

  /**
   * Translate using a module's alternate identifiers (the implicit map ?fhir_cm=<module>,
   * e.g. the LOINC Extension's LOINC codes). The identifiers say the concept and the code
   * are the same thing, so the map works the same in both directions: a SNOMED CT concept
   * translates to its codes, and a code in the identifier's system to its concepts. Either
   * way the relationship is equivalent.
   */
  async translateByIdentifier(map, coding, target) {
    const { schemes } = map.jsonObj.identifierMap;
    const targetSystem = target ? target.split('|')[0] : null;
    const result = [];
    if (coding.system === this.system()) {
      const ctxt = await this.locate(coding.code);
      if (!ctxt.context) {
        return [];
      }
      const conceptId = this.sct.getConceptId(ctxt.context.getReference());
      for (const ident of this.sct.getIdentifiers(conceptId)) {
        const scheme = IDENTIFIER_SCHEMES[ident.scheme];
        if (scheme && schemes.includes(ident.scheme) && (!targetSystem || targetSystem === scheme.system)) {
          result.push({
            map: map.vurl,
            system: scheme.system,
            code: ident.code,
            relationship: 'equivalent'
          });
        }
      }
    } else if (!targetSystem || targetSystem === this.system()) {
      for (const schemeId of schemes) {
        const scheme = IDENTIFIER_SCHEMES[schemeId];
        if (scheme && scheme.system === coding.system) {
          for (const conceptId of this.sct.getConceptsForIdentifier(schemeId, coding.code)) {
            result.push({
              map: map.vurl,
              system: this.system(),
              version: this.version(),
              code: conceptId,
              display: await this.display(conceptId),
              relationship: 'equivalent'
            });
          }
        }
      }
    }
    return result;
  }

  /**
   * Translate a concept of this edition to the edition it depends on (typically a national
   * extension to the International Edition). There is no map: the answer comes from the
   * definitions.
   *  - a concept in one of the target edition's modules is its own translation
   *  - an inactive concept translates via its historical associations (REPLACED BY, SAME AS,
   *    POSSIBLY EQUIVALENT TO, ALTERNATIVE) to concepts in the target edition
   *  - a fully defined extension concept translates to its normal form, provided every concept
   *    in it belongs to the target edition; if the target edition has a concept with that same
   *    normal form, to that concept
   *  - otherwise (a primitive extension concept, or a definition that uses other extension
   *    content) to its proximal ancestors in the target edition, which it is narrower than -
   *    unless the only such ancestors are top-level hierarchies (or the root), which carry no
   *    information: that is reported as a reason rather than a translation
   */
  async translateToEdition(map, coding) {
    const ed = map.jsonObj.editionTranslation;
    const sct = this.sct;
    const src = sct.concepts.findConcept(coding.code);
    if (!src.found) {
      return [];
    }
    const inTarget = (ref) => ed.modules.has(sct.concepts.getModuleId(ref));
    const mk = (code, display, relationship) => ({
      map: map.vurl, system: this.system(), version: ed.version, code, display, relationship
    });
    const named = (ref) => `${sct.getConceptId(ref)} |${sct.getDisplayName(ref, sct.defaultLanguage)}|`;

    if (inTarget(src.index)) {
      return [mk(sct.getConceptId(src.index), sct.getDisplayName(src.index, sct.defaultLanguage), 'equivalent')];
    }

    if (!sct.isActive(src.index)) {
      const result = [];
      for (const [refset, relationship] of [['900000000000527005', 'equivalent'], ['900000000000526001', 'equivalent'],
        ['900000000000523009', 'related-to'], ['900000000000530003', 'related-to']]) {
        for (const tgt of this.#historicalAssociations(refset, src.index)) {
          if (inTarget(tgt)) {
            result.push(mk(sct.getConceptId(tgt), sct.getDisplayName(tgt, sct.defaultLanguage), relationship));
          }
        }
      }
      return result;
    }

    if (!sct.isPrimitive(src.index)) {
      const nf = sct.expressionServices.createNormalForm(src.index);
      if (this.#expressionConcepts(nf).every(inTarget)) {
        const same = sct.conceptWithNormalForm(sct.expressionServices.renderExpression(nf, SnomedServicesRenderOption.Minimal));
        if (same >= 0 && same !== src.index && inTarget(same)) {
          return [mk(sct.getConceptId(same), sct.getDisplayName(same, sct.defaultLanguage), 'equivalent')];
        }
        // the canonical form self-groups every attribute; for output, never-grouped ones go back ungrouped
        const out = sct.expressionServices.ungroupNeverGroupedRefinements(nf);
        return [mk(sct.expressionServices.renderExpression(out, SnomedServicesRenderOption.Minimal),
          sct.expressionServices.renderExpression(out, SnomedServicesRenderOption.FillMissing), 'equivalent')];
      }
    }

    const ancestors = this.#proximalAncestorsIn(src.index, inTarget);
    if (ancestors.length === 0) {
      return [];
    }
    const useful = ancestors.filter(a => sct.concepts.getDepth(a) >= 2);
    if (useful.length === 0) {
      const list = ancestors.map(named);
      const msgId = list.length === 1 ? 'TRANSLATE_SCT_EDITION_TOP_LEVEL_ONE' : 'TRANSLATE_SCT_EDITION_TOP_LEVEL_MANY';
      return [{ message: this.opContext.i18n.translate(msgId, this.opContext.langs,
        [getEditionName(ed.moduleId), named(src.index), list.join(', ')]) }];
    }
    return useful.map(a => mk(sct.getConceptId(a), sct.getDisplayName(a, sct.defaultLanguage), 'source-is-narrower-than-target'));
  }

  /** The target components of the given association reference set for a concept */
  #historicalAssociations(refsetId, conceptIndex) {
    const sct = this.sct;
    const rs = sct.concepts.findConcept(refsetId);
    if (!rs.found) return [];
    const rref = sct.refSetIndex.getRefSetByConcept(rs.index);
    if (rref === -1) return [];
    const members = sct.refSetMembers.getMembers(sct.refSetIndex.getReferenceSet(rref).membersByRef);
    const result = [];
    for (const m of members) {
      if (m.ref !== conceptIndex) continue;
      const values = m.values ? sct.refs.getReferences(m.values) : null;
      if (values && values.length >= 1 && values[0]) {
        result.push(values[0]);
      }
    }
    return result;
  }

  /** Every concept reference used anywhere in an expression */
  #expressionConcepts(exp, into = []) {
    for (const c of exp.concepts) {
      if (c.reference !== NO_REFERENCE) into.push(c.reference);
    }
    const refinements = [...exp.refinements, ...exp.refinementGroups.flatMap(g => g.refinements)];
    for (const r of refinements) {
      if (r.name && r.name.reference !== NO_REFERENCE) into.push(r.name.reference);
      if (r.value) this.#expressionConcepts(r.value, into);
    }
    return into;
  }

  /**
   * The nearest ancestors of a concept that satisfy the test: a parent that does is taken
   * and not looked beyond; one that does not is replaced by its own parents.
   */
  #proximalAncestorsIn(conceptIndex, test) {
    const result = [];
    const seen = new Set();
    const todo = [...this.sct.expressionServices.getConceptParents(conceptIndex)];
    while (todo.length) {
      const p = todo.shift();
      if (seen.has(p)) continue;
      seen.add(p);
      if (test(p)) {
        result.push(p);
      } else {
        todo.push(...this.sct.expressionServices.getConceptParents(p));
      }
    }
    // an ancestor that is itself subsumed by another in the list is not proximal
    return result.filter(a => !result.some(b => b !== a && this.sct.subsumes(a, b)));
  }

  hasMultiHierarchy() {
    return true;
  }

}

/**
 * Factory for creating SNOMED services and providers
 */
class SnomedServicesFactory extends CodeSystemFactoryProvider {
  constructor(i18n, filePath) {
    super(i18n);
    this.filePath = filePath;
    this.uses = 0;
    this._loaded = false;
    this._sharedData = null;
  }

  system() {
    return 'http://snomed.info/sct';
  }

  version() {
    return this._sharedData.versionUri;
  }

  getPartialVersion() {
    let ver = this.version();
    if (ver.includes("/version")) {
      return ver.substring(0, ver.indexOf("/version"));
    } else {
      return null;
    }
  }


  /**
   * Build an implicit SNOMED CT ValueSet from a URL.
   *
   * Handles the following URL patterns:
   *   http://snomed.info/sct?fhir_vs                    – all of SNOMED CT
   *   http://snomed.info/sct?fhir_vs=refset             – list of reference sets
   *   http://snomed.info/sct?fhir_vs=refset/<id>        – members of a reference set
   *   http://snomed.info/sct?fhir_vs=isa/<id>           – concept and descendants
   *
   * The URL may optionally include edition and/or version segments:
   *   http://snomed.info/sct/<edition>?fhir_vs...
   *   http://snomed.info/sct/<edition>/version/<ver>?fhir_vs...
   *
   * @param {string} url - The ValueSet URL to resolve
   * @returns {object|null} A FHIR ValueSet JSON object, or null if the URL is not recognised
   */
  async buildKnownValueSet(url, version) {
    if (!url.startsWith("http://snomed.info/sct")) {
      return null;
    }
    if (version != null && !this.version().startsWith(version)) {
      return null;
    }

    const URI_SNOMED = 'http://snomed.info/sct';

    // Extract the query portion (?fhir_vs...) if this is a recognised SNOMED implicit VS URL
    let id = null;
    const qIdx = url.indexOf('?');
    if (qIdx === -1) {
      return null;
    }

    if (url.startsWith('http://snomed.info/sct?fhir_vs') ||
        url.startsWith(`http://snomed.info/sct/${this.edition}?fhir_vs`) ||
        url.startsWith(`http://snomed.info/sct/${this.edition}/version/${this.version()}?fhir_vs`)) {
      id = url.substring(qIdx);
    } else {
      return null;
    }

    const now = new Date().toISOString();

    if (id === '?fhir_vs=refset') {
      // List of all reference sets
      const concepts = [];
      for (let i = 0; i < this.refSetIndex.count; i++) {
        const code = this.refSetIndex.getReferenceSetCode(i);
        concepts.push({code: this.getConceptId(code)});
      }
      return {
        resourceType: 'ValueSet',
        url,
        status: 'active',
        version: this.versionDate,
        name: 'SNOMEDCTReferenceSetList',
        title: 'SNOMED CT Reference Set List',
        description: 'Reference Sets defined in this SNOMED-CT version',
        date: now,
        compose: {
          include: [{
            system: URI_SNOMED,
            concept: concepts,
          }],
        },
      };
    }

    if (id === '?fhir_vs') {
      // All of SNOMED CT
      return {
        resourceType: 'ValueSet',
        url,
        status: 'active',
        version: this.versionDate,
        name: 'ALLSNOMEDCT',
        title: 'SNOMED CT Reference Set (All of SNOMED CT)',
        description: 'SNOMED CT Reference Set (All of SNOMED CT)',
        date: now,
        compose: {
          include: [{
            system: URI_SNOMED,
          }],
        },
      };
    }

    if (id.startsWith('?fhir_vs=refset/')) {
      const refsetId = id.substring(16);
      let ref = this.snomedServices.concepts.findConcept(refsetId);
      if (!ref.found) {
        return null;
      }
      let rref = this.snomedServices.refSetIndex.getRefSetByConcept(ref.index);
      if (rref == -1) {
        return null;
      }
      return {
        resourceType: 'ValueSet',
        url,
        status: 'active',
        version: this.versionDate,
        name: 'SNOMEDCTRefSet' + refsetId,
        title: 'SNOMED CT Reference Set ' + refsetId,
        description: this.snomedServices.getDisplayName(ref.index),
        date: now,
        compose: {
          include: [{
            system: URI_SNOMED,
            filter: [{
              property: 'concept',
              op: 'in',
              value: refsetId,
            }],
          }],
        },
      };
    }

    if (id.startsWith('?fhir_vs=isa/')) {
      const conceptId = id.substring(13);
      let ref = this.snomedServices.concepts.findConcept(conceptId);
      if (!ref.found) {
        return null;
      }
      return {
        resourceType: 'ValueSet',
        url,
        status: 'active',
        version: this.versionDate,
        name: 'SNOMEDCTConcept' + conceptId,
        title: 'SNOMED CT Concept ' + conceptId + ' and descendants',
        description: 'All Snomed CT concepts for ' + this.snomedServices.getDisplayName(ref.index),
        date: now,
        compose: {
          include: [{
            system: URI_SNOMED,
            filter: [{
              property: 'concept',
              op: 'is-a',
              value: conceptId,
            }],
          }],
        },
      };
    }
    return null;
  }

  async #ensureLoaded() {
    if (!this._loaded) {
      await this.load();
    }
  }

  async load() {
    const reader = new SnomedFileReader(this.filePath);
    this._sharedData = await reader.loadSnomedData();
    this.snomedServices = new SnomedServices(this._sharedData);
    this._loaded = true;
  }

  defaultVersion() {
    return this._sharedData?.version || 'unknown';
  }

  async build(opContext, supplements = []) {
    await this.#ensureLoaded();
    this.recordUse();
    return new SnomedProvider(opContext, supplements, this.snomedServices);
  }

  useCount() {
    return this.uses;
  }

  recordUse() {
    this.uses++;
  }

  name() {
    if (this.version().includes("xsct")) {
      return "SNOMED CT Test Set";
    } else {
      return `SCT ${getEditionCode(this._sharedData.edition)}`;
    }
  }

  nameBase() {
    return `SCT`;
  }

  id() {
    let match = this.version().match(/^http:\/\/snomed\.info\/sct\/(\d+)(?:\/version\/(\d{8}))?$/);
    if (!match) {
      match = this.version().match(/^http:\/\/snomed\.info\/xsct\/(\d+)(?:\/version\/(\d{8}))?$/);
      if (match) {
        match = "x"+match;
      }
    }
    return match && match[1] && match[2] ? "SCT-"+match[1]+"-"+match[2] : null;
  }

  describeVersion(version) {
    const match = version.match(/^http:\/\/snomed\.info\/sct\/(\d+)(?:\/version\/(\d{8}))?$/);
    if (!match) return version;

    const edition = getEditionName(match[1]);
    if (!match[2]) return edition;

    return edition + ' ' + formatDateMMDDYYYY(match[2].substring(4, 6) + match[2].substring(6, 8) + match[2].substring(0, 4));
  }

  /**
   * A translation from this edition to an edition it depends on needs no map: the answer
   * comes from the definitions (see SnomedProvider.translateToEdition). The request names
   * the source by its edition URI (with or without a version) and the target as
   * system|edition URI (with or without a version); the map's url is the versioned source
   * edition URI plus ?fhir_cm=edition/<target edition module>
   */
  async findImplicitConceptMaps(conceptMaps, source, sourceVersion, dest) {
    if (dest) {
      this.#findIdentifierMaps(conceptMaps, source, sourceVersion, dest);
    }
    if (source !== this.system() || !sourceVersion || !dest || !this.isMyEdition(sourceVersion)) {
      return;
    }
    const bar = dest.indexOf('|');
    if (bar === -1 || dest.substring(0, bar) !== this.system()) {
      return;
    }
    const dep = this.snomedServices.editionDependency(dest.substring(bar + 1));
    if (dep) {
      conceptMaps.push(this.editionTranslationMap(dep));
    }
  }

  /**
   * The implicit map from this edition to an edition it depends on. Its url is the one
   * agreed with SNOMED International: <source edition>/version/<date>?fhir_cm=edition/<target module>
   * (the source always versioned, whatever the request said)
   */
  editionTranslationMap(dep) {
    return new ConceptMap({
      resourceType: 'ConceptMap',
      internalSource: this,
      editionTranslation: dep,
      url: `${this.version()}?fhir_cm=edition/${dep.moduleId}`,
      name: `SNOMED CT ${this.describeVersion(this.version())} to ${getEditionName(dep.moduleId)} Concept Map`,
      description: `The translation implied by the concept definitions of the edition ${this.version()} to the ${getEditionName(dep.moduleId)} that it depends on`,
      status: 'active',
      group: [{
        source: this.system(),
        target: this.system()
      }]
    });
  }

  /**
   * Maps implied by alternate identifiers, found from the systems rather than nominated:
   * from this edition (source system|version naming it) to an identifier system (LOINC,
   * say), or from an identifier system to this edition (the target given as
   * system|edition URI, with or without the version)
   */
  #findIdentifierMaps(conceptMaps, source, sourceVersion, dest) {
    const bar = dest.indexOf('|');
    const destSystem = bar === -1 ? dest : dest.substring(0, bar);
    const destVersion = bar === -1 ? null : dest.substring(bar + 1);
    let identSystem;
    if (source === this.system() && sourceVersion && this.isMyEdition(sourceVersion)) {
      identSystem = destSystem;
    } else if (destSystem === this.system() && destVersion && this.isMyEdition(destVersion)) {
      identSystem = source;
    } else {
      return;
    }
    for (const [moduleId, schemes] of this.snomedServices.identifierModules) {
      if ([...schemes].some(s => IDENTIFIER_SCHEMES[s] && IDENTIFIER_SCHEMES[s].system === identSystem)) {
        const cm = this.identifierMap(moduleId);
        if (cm && !conceptMaps.some(m => m.url === cm.url)) {
          conceptMaps.push(cm);
        }
      }
    }
  }

  /**
   * The implicit map defined by a module's alternate identifiers, if the module has any
   * in a scheme we know. Its url follows the edition maps: <source edition>/version/<date>?fhir_cm=<module>
   */
  identifierMap(moduleId) {
    const schemes = [...(this.snomedServices.identifierModules.get(moduleId) || [])].filter(s => IDENTIFIER_SCHEMES[s]);
    if (schemes.length === 0) {
      return null;
    }
    const systems = schemes.map(s => IDENTIFIER_SCHEMES[s].system);
    const moduleName = this.snomedServices.conceptExists(moduleId)
      ? this.snomedServices.getDisplayName(this.snomedServices.concepts.findConcept(BigInt(moduleId)).index) : moduleId;
    return new ConceptMap({
      resourceType: 'ConceptMap',
      internalSource: this,
      identifierMap: { module: moduleId, schemes: schemes },
      url: `${this.version()}?fhir_cm=${moduleId}`,
      name: `SNOMED CT ${moduleName} Concept Map`,
      description: `The concept map implied by the alternate identifiers (${systems.join(', ')}) of the module ${moduleId} |${moduleName}| in ${this.version()}`,
      status: 'active',
      group: [
        ...systems.map(s => ({ source: this.system(), target: s })),
        ...systems.map(s => ({ source: s, target: this.system() }))
      ]
    });
  }

  /** Whether a source version names this edition: exactly, or the edition without a version */
  isMyEdition(version) {
    const mine = this.version();
    return version === mine || mine.startsWith(version + '/version/');
  }

  async findImplicitConceptMap(url, version) {
    if (version && (version !== this.version())) {
      return null;
    }
    if (!url) {
      return null;
    }
    // <edition[/version/date]>?fhir_cm=edition/<module>: this edition's definition-based
    // translation to an edition it depends on, nominated by url
    const q = url.indexOf('?fhir_cm=edition/');
    if (q !== -1) {
      if (!this.isMyEdition(url.substring(0, q))) {
        return null;
      }
      const dep = this.snomedServices.editionDependency(`http://snomed.info/sct/${url.substring(q + '?fhir_cm=edition/'.length)}`);
      return dep ? this.editionTranslationMap(dep) : null;
    }
    // <edition[/version/date]>?fhir_cm=<module>: the map implied by a module's alternate
    // identifiers (e.g. 11010000107, the LOINC Extension's LOINC codes)
    const qm = url.indexOf('?fhir_cm=');
    if (qm !== -1 && url.substring(0, qm) !== this.system()) {
      if (!this.isMyEdition(url.substring(0, qm))) {
        return null;
      }
      await this.#ensureLoaded();
      return this.identifierMap(url.substring(qm + '?fhir_cm='.length));
    }
    if (!url.startsWith(this.system()+"?fhir_cm=")) {
      return null;
    }
    let id = url.substring(url.indexOf("=")+1);
    if (['900000000000523009', '900000000000526001', '900000000000527005', '900000000000530003'].includes(id)) {
      let name = '';
      let relationship = '';
      switch (id) {
        case '900000000000523009':
          name = 'POSSIBLY EQUIVALENT TO';
          relationship = 'inexact';
          break;
        case '900000000000526001':
          name = 'REPLACED BY';
          relationship = 'equivalent';
          break;
        case '900000000000527005':
          name = 'SAME AS';
          relationship = 'equal';
          break;
        case '900000000000530003':
          name = 'ALTERNATIVE';
          relationship = 'inexact';
          break;
      }
      let cm = {
        resourceType: 'ConceptMap',
        internalSource : this,
        relationship: relationship,
        id : id,
        url: `${this.system()}?fhir_cm=${id}`,
        version: this.version(),
        name: `SNOMED CT ${name} Concept Map`,
        description: `The concept map implicitly defined by the ${name} Association Reference Set`,
        copyright: 'This value set includes content from SNOMED CT, which is copyright © 2002+ International Health Terminology Standards Development Organisation (SNOMED International), and distributed by agreement between SNOMED International and HL7',
        status: 'active',
        sourceUri: `${this.system()}?fhir_vs`,
        targetUri: `${this.system()}?fhir_vs`,
        group: [{
          source: 'http://snomed.info/sct',
          target: 'http://snomed.info/sct'
        }]
      }
      return new ConceptMap(cm);
    } else {
      return null;
    }
  }

  webSource() {
    return this.version();
  }

}

function getEditionName(edition) {
  return editionName(edition) || 'Unknown Edition';
}

function getEditionCode(edition) {
  return editionCode(edition) || 'Unknown Edition';
}


module.exports = {
  SnomedProvider,
  SnomedServicesFactory,
  SnomedExpressionContext,
  SnomedServices,
  SnomedFilterContext,
  SnomedProviderContextKind
};