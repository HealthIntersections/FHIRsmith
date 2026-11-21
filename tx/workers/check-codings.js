//
// Check Codings - what the ConceptMaps the server can find say about the codings in a CodeableConcept
//
// This is the server side of org.hl7.fhir.validation.instance.TranslationValidator in the core
// validator, and makes the same comments with the same messages. The server has a different set of
// maps - its packages and libraries, the tx-resources in the request, and the maps its code systems
// imply (LOINC, SNOMED CT editions...) - so it has different things to say.
//
// For each coding in the CodeableConcept, and each map from that coding's system to the system of
// another coding in it, the other coding is checked against what the map says about the first:
//
//  - the map relates the code to the other coding: fine, nothing to say
//  - the map says the code is not-related-to the other coding: warning
//  - the map says the code has no map (noMap): warning
//  - the map relates the code only to other codes: hint
//  - the map has nothing to say about the code: nothing to say
//
// Maps are read forwards only, in both directions: a map from A to B speaks about an A coding,
// and a map from B to A about a B coding.
//
// What a map says about a code is worked out by the $translate machinery (TranslateWorker), one map
// at a time - so group.unmapped, other-map chains (including their cycle protection) and implicit
// maps work here exactly as they do in $translate. When several maps say the same thing, there is one
// message that names all of them.
//
// None of this makes a code invalid - warnings and hints only.
//

const { Issue } = require('../library/operation-outcome');
const { debugLog } = require('../operation-context');

// R4 equivalence values that say there is no relationship (R5: not-related-to)
const NOT_RELATED_EQUIVALENCES = ['unmatched', 'disjoint'];

const MSG_DENIED = 'TRANSLATION_WARNING_DENIED';
const MSG_NOMAP = 'TRANSLATION_WARNING_NOMAP';
const MSG_OTHER = 'TRANSLATION_WARNING_OTHER';

class CodingsChecker {
  /**
   * @param {TerminologyWorker} worker - the worker doing the validation (supplies the context,
   *   the provider, and the request's additional resources)
   * @param {TxParameters} params
   */
  constructor(worker, params) {
    this.worker = worker;
    this.params = params;
    this.translator = null;
  }

  /**
   * Check the codings in a CodeableConcept against the maps, and add any issues to op
   *
   * @param {string} issuePath - the path of the CodeableConcept, for the issues
   * @param {Object} cc - the CodeableConcept (JSON)
   * @param {OperationOutcome} op - where the issues go
   */
  async check(issuePath, cc, op) {
    const codings = (cc && cc.coding || []).filter(c => c && c.system && c.code);
    if (codings.length < 2) {
      return;
    }
    const findings = new Map();
    for (const source of codings) {
      // the other codings, by the system (and version) a map has to translate to
      const targets = new Map();
      for (const other of codings) {
        if (other !== source) {
          const dest = other.version ? other.system + '|' + other.version : other.system;
          if (!targets.has(dest)) {
            targets.set(dest, []);
          }
          targets.get(dest).push(other);
        }
      }
      for (const [dest, candidates] of targets) {
        for (const cm of await this.findMaps(source, dest)) {
          const statements = await this.whatMapSays(cm, source, dest);
          for (const [mapUrl, statement] of statements) {
            this.assess(findings, source, candidates, mapUrl, statement);
          }
        }
      }
    }
    for (const f of findings.values()) {
      const maps = [...f.maps].sort();
      const m = this.worker.i18n.translatePlural(maps.length, f.msgId, this.params.HTTPLanguages, [f.source, f.other, maps.join(', '), f.detail]);
      op.addIssue(new Issue(f.msgId === MSG_OTHER ? 'information' : 'warning', 'business-rule', issuePath, f.msgId, m, 'code-comment'));
    }
  }

  /**
   * The $translate machinery, sharing this request's additional resources. Made on first use, so a
   * CodeableConcept with one coding costs nothing
   */
  getTranslator() {
    if (!this.translator) {
      // required here, not at the top: translate.js requires validate.js, which requires this
      const TranslateWorker = require('./translate');
      const w = this.worker;
      this.translator = new TranslateWorker(w.opContext, w.log, w.provider, w.languages, w.i18n);
      this.translator.additionalResources = w.additionalResources;
      this.translator.conceptMapValueSetMatching = w.conceptMapValueSetMatching;
    }
    return this.translator;
  }

  /**
   * The maps from source's system to dest, found the same way $translate finds them: the request's
   * additional resources, then the provider (which asks its ConceptMap providers, and the code systems
   * for any maps they imply). Looked up per pair, not indexed: many of the maps are implicit, and only
   * made when asked for
   */
  async findMaps(source, dest) {
    const translator = this.getTranslator();
    const maps = [];
    await translator.findConceptMapsInAdditionalResources(maps, source.system, null, null, dest);
    await this.worker.provider.findConceptMapForTranslation(this.worker.opContext, maps, source.system, source.version || null, null, null, dest, source.code);
    return translator.uniqueConceptMaps(maps);
  }

  /**
   * What one map says about the source code, as $translate would report it, gathered by the map the
   * statement is attributed to (the map the translation started from - a statement that came from
   * following other-map is the starting map's statement).
   *
   * A map $translate can't use (an unsupported feature, a missing or circular other-map) has nothing
   * to say here: that's for $translate to report, not $validate-code.
   *
   * @returns {Map<string, {noMap: boolean, targets: {code: string, notRelated: boolean}[]}>}
   */
  async whatMapSays(cm, source, dest) {
    const translator = this.getTranslator();
    const output = [];
    try {
      if (cm.jsonObj.internalSource) {
        await translator.translateUsingCodeSystem(cm, source, dest, this.params, output, false);
      } else {
        await translator.translateUsingGroupsForwards(cm, source, null, dest, this.params, output);
      }
    } catch (e) {
      debugLog(e);
      return new Map();
    }
    const result = new Map();
    for (const o of output) {
      if (o.name !== 'match' || !Array.isArray(o.part)) {
        continue;
      }
      const part = (name) => o.part.find(p => p.name === name);
      const mapUrl = part('originMap')?.valueCanonical || cm.vurl;
      if (!result.has(mapUrl)) {
        result.set(mapUrl, { noMap: false, targets: [] });
      }
      const statement = result.get(mapUrl);
      if (part('noMap')?.valueBoolean === true) {
        statement.noMap = true;
        continue;
      }
      const concept = part('concept')?.valueCoding;
      if (concept && concept.code) {
        const relationship = part('relationship')?.valueCode;
        const equivalence = part('equivalence')?.valueCode;
        statement.targets.push({
          code: concept.code,
          notRelated: relationship === 'not-related-to' || NOT_RELATED_EQUIVALENCES.includes(equivalence)
        });
      }
    }
    return result;
  }

  /**
   * Compare what a map says about the source code with the candidates (the other codings in the
   * target system), and record what there is to say
   */
  assess(findings, source, candidates, mapUrl, statement) {
    const confirmed = new Set();
    const denied = new Set();
    const mappedTo = new Set();
    for (const t of statement.targets) {
      if (!t.notRelated) {
        mappedTo.add(t.code);
      }
      for (const c of candidates) {
        if (t.code === c.code) {
          (t.notRelated ? denied : confirmed).add(c);
        }
      }
    }
    const src = describe(source);
    for (const c of candidates) {
      if (denied.has(c) && !confirmed.has(c)) {
        addFinding(findings, MSG_DENIED, src, describe(c), '', mapUrl);
      }
    }
    if (confirmed.size > 0) {
      return;
    }
    if (statement.noMap) {
      addFinding(findings, MSG_NOMAP, src, candidates.map(describe).join(', '), candidates[0].system, mapUrl);
    } else if (mappedTo.size > 0) {
      const codes = [...mappedTo].sort().join(', ');
      for (const c of candidates) {
        if (!denied.has(c)) {
          addFinding(findings, MSG_OTHER, src, describe(c), codes, mapUrl);
        }
      }
    }
  }
}

/**
 * The same thing said by more than one map is one finding, naming all the maps
 */
function addFinding(findings, msgId, source, other, detail, mapUrl) {
  const key = msgId + '|' + source + '|' + other + '|' + detail;
  if (!findings.has(key)) {
    findings.set(key, { msgId, source, other, detail, maps: new Set() });
  }
  findings.get(key).maps.add(mapUrl);
}

/**
 * system#code, with the version when there is one - the same form the core validator uses
 */
function describe(c) {
  return (c.version ? c.system + '|' + c.version : c.system) + '#' + c.code;
}

module.exports = {
  CodingsChecker
};
