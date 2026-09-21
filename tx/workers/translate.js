//
// Translate Worker - Handles ConceptMap $translate operation
//
// GET /ConceptMap/$translate?{params}
// POST /ConceptMap/$translate
// GET /ConceptMap/{id}/$translate?{params}
// POST /ConceptMap/{id}/$translate
//

const { TerminologyWorker } = require('./worker');
const { TxParameters } = require('../params');
const { Parameters } = require('../library/parameters');
const { Issue, OperationOutcome, buildOperationOutcome, outcomeFromError } = require('../library/operation-outcome');
const {ConceptMap} = require("../library/conceptmap");
const {Extensions} = require("../library/extensions");
const {VersionUtilities} = require("../../library/version-utilities");
const {debugLog} = require("../operation-context");
const {ValueSetChecker, ValidationCheckMode} = require("./validate");

// ConceptMap.group.element.comment is R6; on an R5 ConceptMap it is carried by the
// cross-version extension. Read both, so a preadopted R5 resource and a native R6 one
// behave the same.
const EXT_ELEMENT_COMMENT = 'http://hl7.org/fhir/6.0/StructureDefinition/extension-ConceptMap.group.element.comment';

function elementComment(em) {
  return em.comment || Extensions.readString(em, EXT_ELEMENT_COMMENT);
}

class TranslateWorker extends TerminologyWorker {
  /**
   * @param {OperationContext} opContext - Operation context
   * @param {Logger} log - Logger instance
   * @param {Provider} provider - Provider for concept maps and resources
   * @param {LanguageDefinitions} languages - Language definitions
   * @param {I18nSupport} i18n - Internationalization support
   */
  constructor(opContext, log, provider, languages, i18n) {
    super(opContext, log, provider, languages, i18n);
  }

  /**
   * Get operation name
   * @returns {string}
   */
  opName() {
    return 'translate';
  }

  /**
   * Handle a type-level $translate request
   * GET/POST /ConceptMap/$translate
   * @param {express.Request} req - Express request
   * @param {express.Response} res - Express response
   */
  async handle(req, res) {
    try {
      await this.handleTypeLevelTranslate(req, res);
    } catch (error) {
      this.log.error(error);
      debugLog(error);
      if (error instanceof Issue) {
        const oo = new OperationOutcome();
        oo.addIssue(error);
        return res.status(error.statusCode || 500).json(oo.jsonObj);
      } else {
        return res.status(error.statusCode || 500).json(outcomeFromError(error));
      }
    }
  }

  /**
   * Handle an instance-level $translate request
   * GET/POST /ConceptMap/{id}/$translate
   * @param {express.Request} req - Express request
   * @param {express.Response} res - Express response
   */
  async handleInstance(req, res) {
    try {
      await this.handleInstanceLevelTranslate(req, res);
    } catch (error) {
      this.log.error(error);
      debugLog(error);
      if (error instanceof Issue) {
        const oo = new OperationOutcome();
        oo.addIssue(error);
        return res.status(error.statusCode || 500).json(oo.jsonObj);
      } else {
        return res.status(error.statusCode || 500).json(outcomeFromError(error));
      }
    }
  }

  /**
   * Handle type-level translate: /ConceptMap/$translate
   * ConceptMap identified by url+version params or from source/target
   */
  async handleTypeLevelTranslate(req, res) {
    this.deadCheck('translate-type-level');

    // Handle tx-resource and cache-id parameters from Parameters resource
    if (req.body && req.body.resourceType === 'Parameters') {
      this.setupAdditionalResources(req.body);
    }

    // Parse parameters from request
    const params = new Parameters(this.buildParameters(req));
    const txp = new TxParameters(this.opContext.i18n.languageDefinitions, this.opContext.i18n);
    txp.readParams(params.jsonObj);

    // Extract required parameters per FHIR spec
    // url - canonical URL of the concept map (optional for type-level if source/target specified)
    // conceptMapVersion - version of the concept map
    // sourceCode / sourceCoding / sourceCodeableConcept - the code to translate
    // system - system of the code (if sourceCode used)
    // version - version of the code system
    // sourceScope - source value set scope
    // targetScope - target value set scope
    // targetSystem - target code system to translate to
    // dependency - additional dependencies for translation

    let coding = null;
    let conceptMaps = [];
    let targetScope = null;
    let sourceScope = null;
    let targetSystem = null;
    let reverse = false;
    let reverseFromTargetConcept = false; // R5 style: the target concept was named directly

    // Get the source coding
    // Accept both R5 names (sourceCoding, sourceCodeableConcept, sourceCode/sourceSystem)
    // and R4 names (coding, codeableConcept, code/system) as aliases
    if (params.has('sourceCoding')) {
      coding = params.get('sourceCoding');
    } else if (params.has('coding')) {
      coding = params.get('coding');
    } else if (params.has('sourceCodeableConcept')) {
      const cc = params.get('sourceCodeableConcept');
      if (cc.coding && cc.coding.length > 0) {
        coding = cc.coding[0]; // Use first coding
      } else {
        throw new Issue('error', 'invalid', null, null,
          'sourceCodeableConcept must contain at least one coding', null, 400);
      }
    } else if (params.has('codeableConcept')) {
      const cc = params.get('codeableConcept');
      if (cc.coding && cc.coding.length > 0) {
        coding = cc.coding[0];
      } else {
        throw new Issue('error', 'invalid', null, null,
          'codeableConcept must contain at least one coding', null, 400);
      }
    } else if (params.has('sourceCode') || params.has('code')) {
      const code = params.has('sourceCode') ? params.get('sourceCode') : params.get('code');
      const system = params.has('sourceSystem') ? params.get('sourceSystem') : params.get('system');
      if (!system) {
        throw new Issue('error', 'invalid', null, null,
          'system parameter is required when using code/sourceCode', null, 400);
      }
      const version = params.has('sourceVersion') ? params.get('sourceVersion') : params.get('version');
      coding = {system, version, code};
    } else if (params.has('targetCoding')) {
      reverse = true;
      reverseFromTargetConcept = true;
      coding = params.get('targetCoding');
    } else if (params.has('targetCodeableConcept')) {
      reverse = true;
      reverseFromTargetConcept = true;
      const cc = params.get('targetCodeableConcept');
      if (cc.coding && cc.coding.length > 0) {
        coding = cc.coding[0]; // Use first coding
      } else {
        throw new Issue('error', 'invalid', null, null,
          'sourceCodeableConcept must contain at least one coding', null, 400);
      }
    } else if (params.has('targetCode') || params.has('targetcode')) {
      // targetcode is accepted alongside targetCode, as targetsystem is alongside targetSystem
      reverse = true;
      reverseFromTargetConcept = true;
      const code = params.has('targetCode') ? params.get('targetCode') : params.get('targetcode');
      const system = params.has('targetSystem') ? params.get('targetSystem') : params.get('targetsystem');
      if (!system) {
        throw new Issue('error', 'invalid', null, null,
          'targetSystem parameter is required when using targetCode', null, 400);
      }
      const version = params.get('targetVersion');
      coding = { system, version, code };
    } else {
      throw new Issue('error', 'invalid', null, null,
        'Must provide sourceCode+(source)system, sourceCoding, or sourceCodeableConcept, or targetCode+targetSystem), targetCoding, or targetCodeableConcept', null, 400);
    }

    // Get the concept map
    if (params.has('url')) {
      const url = params.get('url');
      const cmVersion = params.get('conceptMapVersion');
      let conceptMap = await this.findConceptMapByUrl(url, cmVersion);
      if (!conceptMap) {
        const msg = cmVersion
          ? `ConceptMap not found: ${url} version ${cmVersion}`
          : `ConceptMap not found: ${url}`;
        throw new Issue('error', 'not-found', null, null, msg, null, 404);
      } else {
        conceptMaps.push(conceptMap);
      }
    }

    // Get scope parameters. As with the source concept above, the R4 names are
    // accepted as aliases for the R5 ones: R4 calls the scopes 'source' and
    // 'target', and spells the target system 'targetsystem' (all lower case).
    if (params.has('sourceScope')) {
      sourceScope = params.get('sourceScope');
    } else if (params.has('source')) {
      sourceScope = params.get('source');
    }
    if (params.has('targetScope')) {
      targetScope = params.get('targetScope');
    } else if (params.has('target')) {
      targetScope = params.get('target');
    }
    if (params.has('targetSystem')) {
      targetSystem = params.get('targetSystem');
    } else if (params.has('targetsystem')) {
      targetSystem = params.get('targetsystem');
    }

    // R4's 'reverse' parameter: "this parameter reverses the meaning of the source and
    // target parameters". So do literally that - swap the two sides here, once the
    // parameters have all been read, and let the rest of the operation run as usual.
    // R5+ dropped it in favour of naming the target concept directly (targetCode,
    // targetCoding, targetCodeableConcept), so there it is an error rather than
    // something to interpret.
    if (params.has('reverse')) {
      const fhirVersion = this.provider.getFhirVersion();
      if (!VersionUtilities.isR4Ver(fhirVersion) && !VersionUtilities.isR3Ver(fhirVersion)) {
        throw new Issue('error', 'not-supported', null, null,
          `The 'reverse' parameter is not defined in ${fhirVersion}: name the target concept with targetCode, targetCoding or targetCodeableConcept instead`, null, 400);
      }
      const rev = params.get('reverse');
      if (rev === true || rev === 'true') {
        if (reverseFromTargetConcept) {
          throw new Issue('error', 'invalid', null, null,
            "The 'reverse' parameter cannot be combined with targetCode, targetCoding or targetCodeableConcept", null, 400);
        }
        reverse = true;
        // the concept named by system/code is now the target concept, the two value set
        // scopes swap roles, and targetsystem names the system the answers come from
        const scope = sourceScope;
        sourceScope = targetScope;
        targetScope = scope;
      }
    }

    // The R5-shaped reverse names the target concept directly; the source system then
    // says which system the answers should come from. R5 spells that 'system' (it is
    // the system of the source concept); 'sourceSystem' is accepted as an alias, as it
    // is for the forward direction.
    if (reverseFromTargetConcept) {
      if (params.has('sourceSystem')) {
        targetSystem = params.get('sourceSystem');
      } else if (params.has('system')) {
        targetSystem = params.get('system');
      }
    }
    // The sourceScope parameter is a precondition on the whole operation, not a way of picking
    // maps: the client is saying which codes it is asking about. So it is evaluated once, before
    // any map is considered, and if the code is not in it then no map applies under any
    // condition - including a map the client nominated by url. Once the code has been shown to
    // be in it, the parameter has done its work and plays no further part; each map is then
    // judged by its own scope. Under reverse the two scopes have already swapped above, so
    // sourceScope here is the scope of the concept that was named either way.
    if (sourceScope) {
      const inScope = await this.codeInScope(sourceScope, coding, txp,
        `${reverse ? 'targetScope' : 'sourceScope'} parameter`);
      if (!inScope) {
        return res.status(200).json(this.noMapsResponse(coding, sourceScope, targetScope, targetSystem, reverse,
          `'${coding.system}#${coding.code}' is not in the value set '${sourceScope}', so no ConceptMap can translate it`));
      }
    }

    // If no explicit concept map, we need to find one based on source/target
    if (conceptMaps.length == 0) {
      if (reverse) {
        await this.findConceptMapsInAdditionalResources(conceptMaps,targetSystem, targetScope, sourceScope, coding.system);
        await this.provider.findConceptMapForTranslation(this.opContext, conceptMaps, targetSystem, targetScope, sourceScope, coding.system, coding.code);
      } else {
        await this.findConceptMapsInAdditionalResources(conceptMaps, coding.system, sourceScope, targetScope, targetSystem);
        await this.provider.findConceptMapForTranslation(this.opContext, conceptMaps, coding.system, sourceScope, targetScope, targetSystem, coding.code);
      }
    }

    // Whether the map was nominated or found, it only applies if the code is within its own
    // declared scope, so the filter goes here rather than in the selection above - a nominated
    // map never passes through selection at all.
    const scoped = await this.filterMapsByScope(conceptMaps, coding, txp, reverse);
    conceptMaps = scoped.maps;

    if (conceptMaps.length == 0) {
      // No map covers this code. That is an answer - there is no translation - not an error;
      // a nominated map that cannot be *found* is the error case, and is reported when the url
      // parameter is resolved above.
      return res.status(200).json(this.noMapsResponse(coding, sourceScope, targetScope, targetSystem, reverse, null, scoped.anyScoped));
    }

    // Perform the translation
    const result = await this.doTranslate(conceptMaps, coding, targetScope, targetSystem, txp, reverse);
    return res.status(200).json(result);
  }

  /**
   * Handle instance-level translate: /ConceptMap/{id}/$translate
   * ConceptMap identified by resource ID
   */
  async handleInstanceLevelTranslate(req, res) {
    this.deadCheck('translate-instance-level');

    const { id } = req.params;

    // Find the ConceptMap by ID
    const conceptMap = await this.provider.getConceptMapById(this.opContext, id);

    if (!conceptMap) {
      throw new Issue('error', 'not-found', null, null,
        `ConceptMap/${id} not found`, null, 404);
    }

    // Handle tx-resource and cache-id parameters from Parameters resource
    if (req.body && req.body.resourceType === 'Parameters') {
      this.setupAdditionalResources(req.body);
    }

    // Parse parameters from request
    const params = new Parameters(this.buildParameters(req));
    const txp = new TxParameters(this.opContext.i18n.languageDefinitions, this.opContext.i18n);
    txp.readParams(params.jsonObj);

    // Get the source coding
    // Accept both R5 names (sourceCoding, sourceCodeableConcept, sourceCode)
    // and R4 names (coding, codeableConcept, code) as aliases
    let coding = null;

    if (params.has('sourceCoding')) {
      coding = params.get('sourceCoding');
    } else if (params.has('coding')) {
      coding = params.get('coding');
    } else if (params.has('sourceCodeableConcept')) {
      const cc = params.get('sourceCodeableConcept');
      if (cc.coding && cc.coding.length > 0) {
        coding = cc.coding[0];
      } else {
        throw new Issue('error', 'invalid', null, null,
          'sourceCodeableConcept must contain at least one coding', null, 400);
      }
    } else if (params.has('codeableConcept')) {
      const cc = params.get('codeableConcept');
      if (cc.coding && cc.coding.length > 0) {
        coding = cc.coding[0];
      } else {
        throw new Issue('error', 'invalid', null, null,
          'codeableConcept must contain at least one coding', null, 400);
      }
    } else if (params.has('sourceCode') || params.has('code')) {
      const code = params.has('sourceCode') ? params.get('sourceCode') : params.get('code');
      const system = params.has('system') ? params.get('system') : null;
      if (!system) {
        throw new Issue('error', 'invalid', null, null,
          'system parameter is required when using code/sourceCode', null, 400);
      }
      coding = {
        system,
        version: params.get('version'),
        code
      };
    } else {
      throw new Issue('error', 'invalid', null, null,
        'Must provide sourceCode (with system), sourceCoding, or sourceCodeableConcept', null, 400);
    }

    // Get optional scope/target parameters
    const targetScope = params.has('targetScope') ? params.get('targetScope') : null;
    const targetSystem = params.has('targetSystem') ? params.get('targetSystem') : null;

    let conceptMaps = [];
    conceptMaps.push(conceptMap);

    // Naming the map by id does not put an out-of-scope code into its scope, any more than
    // naming it by url does: the map either covers this code or it does not.
    const scoped = await this.filterMapsByScope(conceptMaps, coding, txp, false);
    if (scoped.maps.length === 0) {
      return res.status(200).json(this.noMapsResponse(coding, null, targetScope, targetSystem, false, null, scoped.anyScoped));
    }

    // Perform the translation
    const result = await this.doTranslate(scoped.maps, coding, targetScope, targetSystem, params);
    return res.status(200).json(result);
  }


  checkCode(op, langList, path, code, system, version, display) {
    let result = false;
    const cp = this.findCodeSystem(system, version, null, ['complete', 'fragment'], true, true, false, null, this.requiredSupplements);
    if (cp != null) {
      const lct = cp.locate(this.opContext, code);
      if (op.error('InstanceValidator', 'invalid', path, lct != null, 'Unknown Code (' + system + '#' + code + ')')) {
        result = op.warning('InstanceValidator', 'invalid', path,
          (!display) || (display === cp.display(this.opContext, lct, null)),
          'Display for ' + system + ' code "' + code + '" should be "' + cp.display(this.opContext, lct, null) + '"');
      }
    }
    return result;
  }

  async translateUsingGroupsForwards(cm, coding, targetScope, targetSystem, params, output, origin, visited) {
    let result = false;
    // originMap names where the chain of maps started, not the map that happened to
    // supply the answer; any other map consulted along the way is a used-conceptmap.
    const originMap = origin || cm.vurl;
    // Work group by group. group.unmapped says what this group does with a concept it
    // has no element for, so it is decided per group: a mapping in one group does not
    // speak for another group, and does not suppress another group's fallback.
    for (const g of cm.listGroupsInScope(coding, targetScope, targetSystem)) {
      let groupResult = false;
      for (const em of (g.element || []).filter(e => e.code === coding.code)) {
        // ConceptMap.group.element.noMap says, positively, that this concept has no
        // mapping in this map - which is an answer, not the absence of one. Report it
        // as a match that states the source concept and the map it came from, with no
        // concept and no relationship, and nothing to say about a target.
        if (em.noMap === true) {
          groupResult = true;
          if (this.hasNoMap(output, g.source, em.code)) {
            continue; // another map has already said this; saying it twice adds nothing
          }
          const noMapParts = [];
          noMapParts.push({
            name: 'noMap',
            valueBoolean: true
          });
          const noMapComment = elementComment(em);
          if (noMapComment) {
            noMapParts.push({
              name: 'sourceComment',
              valueString: noMapComment
            });
          }
          noMapParts.push({
            name: 'sourceConcept',
            valueCoding: {
              system: g.source,
              code: em.code
            }
          });
          noMapParts.push({
            name: 'originMap',
            valueCanonical: originMap
          });
          output.push({
            name: 'match',
            part: noMapParts
          });
          continue;
        }
        for (const map of em.target || []) {
          let ok = false;
          if (map.equivalence) { // R4 mode
            ok = ['null', 'relatedto', 'equivalent', 'equal', 'wider', 'subsumes', 'narrower', 'specializes', 'inexact', 'unmatched', 'disjoint'].includes(map.equivalence);
          } else {
            ok = ['null', 'related-to', 'equivalent',  'source-is-narrower-than-target', 'source-is-broader-than-target', 'not-related-to'].includes(map.relationship);
          }
          if (ok) {
            groupResult = true;

            const outcome = {
              system: g.target,
              code: map.code
            };

            if (!this.hasMatch(output, outcome)) {
              const matchParts = [];
              matchParts.push({
                name: 'concept',
                valueCoding: outcome
              });
              matchParts.push({
                name: 'sourceConcept',
                valueCoding: {
                  system: g.source,
                  code: em.code
                }
              });
              matchParts.push({
                name: 'relationship',
                valueCode: map.relationship
              });
              // equivalence vs relationship will be sorted out in the version transform for parameters
              if (map.equivalence) {
                matchParts.push({
                  name: 'equivalence',
                  valueCode: map.equivalence
                });
              }
              // ConceptMap.group.element.comment is about the source concept,
              // ConceptMap.group.element.target.comment is about this particular map
              const srcComment = elementComment(em);
              if (srcComment) {
                matchParts.push({
                  name: 'sourceComment',
                  valueString: srcComment
                });
              }
              if (map.comment) {
                matchParts.push({
                  name: 'targetComment',
                  valueString: map.comment
                });
              }
              for (const prod of map.product || []) {
                const productParts = [];
                productParts.push({
                  name: 'element',
                  valueString: prod.property
                });
                productParts.push({
                  name: 'concept',
                  valueCoding: {
                    system: prod.system,
                    code: prod.value
                  }
                });
                matchParts.push({
                  name: 'product',
                  part: productParts
                });
              }
              matchParts.push({
                name: 'originMap',
                valueCanonical: originMap
              });
              output.push({
                name: 'match',
                part: matchParts
              });
            }
          }
        }
      }
      if (!groupResult) {
        groupResult = await this.translateUsingUnmapped(cm, g, coding, targetScope, targetSystem, params, output,
          visited || new Set([cm.vurl]), originMap);
      }
      result = groupResult || result;
    }
    return result;
  }

  translateUsingGroupsReverse(cm, coding, targetScope, targetSystem, params, output) {
    let result = false;
    const matches = cm.listTranslationsReverse(coding, targetScope, targetSystem);
    if (matches.length > 0) {
      for (let match of matches) {
        const g = match.group;
        const em = match.match;
        const map = match.target;
        let ok = false;
        if (map.equivalence) { // R4 mode
          ok = ['null', 'relatedto', 'equivalent', 'equal', 'wider', 'subsumes', 'narrower', 'specializes', 'inexact', 'unmatched', 'disjoint'].includes(map.equivalence);
        } else {
          ok = ['null', 'related-to', 'equivalent',  'source-is-narrower-than-target', 'source-is-broader-than-target', 'not-related-to'].includes(map.relationship);
        }
        if (ok) {
          result = true;

          const outcome = {
            system: g.source,
            code: em.code
          };
          const t = {
            system: g.target,
            code: coding.code
          };

          if (!this.hasMatch(output, outcome)) {
            const matchParts = [];
            matchParts.push({
              name: 'sourceConcept',
              valueCoding: outcome
            });
            matchParts.push({
              name: 'concept',
              valueCoding: t
            });
            matchParts.push({
              name: 'relationship',
              valueCode: map.relationship
            });
            // equivalence vs relationship will be sorted out in the version transform for parameters
            if (map.equivalence) {
              matchParts.push({
                name: 'equivalence',
                valueCode: map.equivalence
              });
            }
            // as above: element.comment describes the source concept, and
            // element.target.comment describes this particular map
            const srcComment = elementComment(em);
            if (srcComment) {
              matchParts.push({
                name: 'sourceComment',
                valueString: srcComment
              });
            }
            if (map.comment) {
              matchParts.push({
                name: 'targetComment',
                valueString: map.comment
              });
            }
            for (const prod of map.product || []) {
              const productParts = [];
              productParts.push({
                name: 'element',
                valueString: prod.property
              });
              productParts.push({
                name: 'concept',
                valueCoding: {
                  system: prod.system,
                  code: prod.value
                }
              });
              matchParts.push({
                name: 'product',
                part: productParts
              });
            }
            matchParts.push({
              name: 'originMap',
              valueCanonical: cm.vurl
            });
            output.push({
              name: 'match',
              part: matchParts
            });
          }
        }
      }
    }
    return result;
  }

  /**
   * Order the candidate maps for translation. url and version play no part:
   *
   *  - dependency first: a map that defers to another (group.unmapped.otherMap) is
   *    consulted before the map it defers to
   *  - then by date, most recent first, with dateless maps last
   *
   * A dependency edge only counts when the map it names is itself a candidate. Any map
   * caught in a dependency cycle keeps its place at the end, in date order - the cycle
   * itself is reported when the translation actually follows it.
   * @param {ConceptMap[]} conceptMaps
   * @returns {ConceptMap[]} a new, ordered array
   */
  sortConceptMaps(conceptMaps) {
    if (!conceptMaps || conceptMaps.length < 2) {
      return conceptMaps; // nothing to decide
    }

    const dateOf = (cm) => {
      const d = cm.jsonObj.date;
      if (!d) {
        return null;
      }
      const t = Date.parse(d);
      return isNaN(t) ? null : t; // an unusable date is treated as no date
    };
    const byDate = (a, b) => {
      const da = dateOf(a), db = dateOf(b);
      if (da === null && db === null) return 0; // stable: input order is kept
      if (da === null) return 1;
      if (db === null) return -1;
      return db - da;
    };

    // a dependency can name its target with or without a version
    const byRef = new Map();
    for (const cm of conceptMaps) {
      if (cm.url && !byRef.has(cm.url)) {
        byRef.set(cm.url, cm);
      }
      if (cm.vurl) {
        byRef.set(cm.vurl, cm);
      }
    }

    const dependsOn = new Map();
    const waitingOn = new Map();
    for (const cm of conceptMaps) {
      dependsOn.set(cm, new Set());
      waitingOn.set(cm, 0);
    }
    for (const cm of conceptMaps) {
      for (const ref of cm.listDependencies()) {
        const dep = byRef.get(ref) || byRef.get(ref.split('|')[0]);
        if (dep && dep !== cm && !dependsOn.get(cm).has(dep)) {
          dependsOn.get(cm).add(dep);
          waitingOn.set(dep, waitingOn.get(dep) + 1);
        }
      }
    }

    const ready = conceptMaps.filter(cm => waitingOn.get(cm) === 0).sort(byDate);
    const ordered = [];
    while (ready.length > 0) {
      const cm = ready.shift();
      ordered.push(cm);
      for (const dep of dependsOn.get(cm)) {
        waitingOn.set(dep, waitingOn.get(dep) - 1);
        if (waitingOn.get(dep) === 0) {
          ready.push(dep);
          ready.sort(byDate);
        }
      }
    }
    if (ordered.length < conceptMaps.length) {
      const seen = new Set(ordered);
      ordered.push(...conceptMaps.filter(cm => !seen.has(cm)).sort(byDate));
    }
    return ordered;
  }

  /**
   * ConceptMap.group.unmapped: what to do when the group is in scope but has no element
   * for this concept. Only consulted once the map itself has produced nothing.
   *
   *   use-source-code  the source code is also the target code
   *   fixed            a nominated code (and display) is the target
   *   other-map        defer to another ConceptMap entirely
   *
   * `visited` guards against a cycle in other-map chains.
   * @returns {Promise<boolean>} whether anything was added
   */
  async translateUsingUnmapped(cm, g, coding, targetScope, targetSystem, params, output, visited, origin) {
    let result = false;
    const originMap = origin || cm.vurl;
    {
      const u = g.unmapped;
      if (!u || !u.mode) {
        return false;
      }
      if (u.valueSet) {
        // "all the codes in the specified value set" - that needs an expansion, which
        // this operation does not do. Better to say so than to silently return nothing.
        throw new Issue('error', 'not-supported', null, null,
          `ConceptMap ${cm.vurl} uses group.unmapped.valueSet, which this server does not support`, null, 422);
      }
      switch (u.mode) {
        case 'use-source-code' :
          result = this._addUnmappedMatch(output, originMap, coding, {system: g.target, code: coding.code}, u.relationship) || result;
          break;
        case 'fixed' :
          if (u.code) {
            const outcome = {system: g.target, code: u.code};
            if (u.display) {
              outcome.display = u.display;
            }
            result = this._addUnmappedMatch(output, originMap, coding, outcome, u.relationship) || result;
          }
          break;
        case 'other-map' :
          if (u.otherMap) {
            const other = await this.findConceptMapByUrl(u.otherMap);
            if (!other) {
              throw new Issue('error', 'not-found', null, null,
                `The ConceptMap ${u.otherMap} named in group.unmapped.otherMap was not found`, null, 422);
            }
            // Key the cycle check on the map that was actually resolved, not on the
            // reference as written: the same map can be named with or without a
            // version, or by a version that resolves to the same instance.
            const key = other.vurl;
            if (visited.has(key)) {
              throw new Issue('error', 'business-rule', null, null,
                `ConceptMap ${cm.vurl} has a circular group.unmapped.otherMap reference to ${other.vurl}`
                + (key === u.otherMap ? '' : ` (referenced as ${u.otherMap})`), null, 422);
            }
            // `visited` is the chain currently being followed, not every map seen: two
            // groups (or two maps) legitimately deferring to the same other map is a
            // diamond, not a cycle, so the entry is removed again on the way back out.
            visited.add(key);
            try {
              // we are about to look in this map, and it is not where the chain started
              this.recordUsedConceptMap(output, other.vurl);
              result = await this.translateUsingGroupsForwards(other, coding, targetScope, targetSystem, params, output, originMap, visited) || result;
            } finally {
              visited.delete(key);
            }
          }
          break;
        default :
          throw new Issue('error', 'not-supported', null, null,
            `ConceptMap ${cm.vurl} uses an unknown group.unmapped.mode '${u.mode}'`, null, 422);
      }
    }
    return result;
  }

  /**
   * Build the match for an unmapped fallback. The source concept is the one that was
   * asked for - it is, by definition, not an element of the map.
   */
  _addUnmappedMatch(output, originMap, coding, outcome, relationship) {
    if (this.hasMatch(output, outcome)) {
      return false;
    }
    const matchParts = [];
    matchParts.push({
      name: 'concept',
      valueCoding: outcome
    });
    matchParts.push({
      name: 'sourceConcept',
      valueCoding: {
        system: coding.system,
        code: coding.code
      }
    });
    if (relationship) {
      matchParts.push({
        name: 'relationship',
        valueCode: relationship
      });
    }
    matchParts.push({
      name: 'originMap',
      valueCanonical: originMap
    });
    output.push({
      name: 'match',
      part: matchParts
    });
    return true;
  }

  /**
   * Report a ConceptMap that was consulted but is not where the chain started. Reported
   * once per map, at the top level of the response rather than per match.
   */
  recordUsedConceptMap(output, vurl) {
    if (!vurl) {
      return;
    }
    for (const o of output) {
      if (o.name === 'used-conceptmap' && (o.valueCanonical === vurl || o.valueUri === vurl)) {
        return;
      }
    }
    output.push({
      name: 'used-conceptmap',
      valueUri: vurl
    });
  }

  async translateUsingCodeSystem(cm, coding, target, params, output, reverse) {
    let result = false;
    const factory = cm.jsonObj.internalSource;
    let prov = await factory.build(this.opContext, []);
    this.opContext.registerProvider(prov);

    output.push({
      name: 'used-system',
      valueUri: prov.system() + '|' + prov.version()
    });

    let translations = await prov.getTranslations(cm, coding, target, reverse);

    if (translations.length > 0) {
      result = true;

      for (const t of translations) {
        if (t.map) {
          output.push({
            name: 'used-conceptmap',
            valueUri: t.map
          });
        }

        const outcome = {
          system: t.system,
          code: t.code,
          version: t.version,
          display: t.display
        };

        const matchParts = [];
        matchParts.push({
          name: 'concept',
          valueCoding: outcome
        });
        matchParts.push({
          name: 'sourceConcept',
          valueCoding: {
            system: coding.system,
            code: coding.code
          }
        });
        matchParts.push({
          name: 'relationship',
          valueCode: t.relationship
        });
        if (t.message) {
          matchParts.push({
            name: 'message',
            valueString: t.message
          });
        }
        matchParts.push({
          name: 'originMap',
          valueCanonical: cm.vurl
        });
        output.push({
          name: 'match',
          part: matchParts
        });
      }
    }
    return result;
  }

  /**
   * ConceptMap.sourceScope "limits the scope of the map to source codes that are members of
   * this value set", so a code outside it means the map does not apply at all - not that the
   * map has no element for it. The difference matters because group.unmapped answers the
   * second question and must not answer the first: a map with unmapped mode=fixed would
   * otherwise translate every code in the code system its group names, whatever its author
   * declared, and sourceScope would have no effect on any map that has an unmapped.
   *
   * Resolving a scope costs a value set lookup and a $validate-code, and the same scope is
   * usually shared by several of the candidate maps, so both are memoised for the life of the
   * operation. They are deliberately not cached beyond it: tx-resource makes the resolution of
   * a canonical a property of the request, not of the server.
   */
  scopeVsCache = new Map();    // canonical -> ValueSet
  scopeCodeCache = new Map();  // canonical + coding -> boolean

  async resolveScopeValueSet(canonical, why) {
    if (this.scopeVsCache.has(canonical)) {
      return this.scopeVsCache.get(canonical);
    }
    const { url, version } = VersionUtilities.splitCanonical(canonical);
    let vs = null;
    try {
      vs = await this.findValueSet(url, version);
    } catch (e) {
      if (e instanceof Issue) {
        throw e;
      }
      vs = null;
    }
    if (!vs) {
      // Fatal to the operation, deliberately. A scope that cannot be resolved is a scope that
      // cannot be evaluated, and dropping the map silently would report "no translation" for
      // what is really "cannot tell" - the same trap as answering not-subsumed when the real
      // answer is unknown.
      throw new Issue('error', 'not-found', null, null,
        `The value set '${canonical}', which is the ${why}, could not be found, so the scope of the translation cannot be determined`, null, 404);
    }
    this.scopeVsCache.set(canonical, vs);
    return vs;
  }

  async codeInScope(canonical, coding, params, why) {
    const key = canonical + '\u0000' + coding.system + '|' + (coding.version || '') + '#' + coding.code;
    if (this.scopeCodeCache.has(key)) {
      return this.scopeCodeCache.get(key);
    }
    const vs = await this.resolveScopeValueSet(canonical, why);
    let inScope;
    try {
      const checker = new ValueSetChecker(this, vs, params);
      await checker.prepare();
      // The coding is wrapped in a CodeableConcept so that this goes through
      // checkCodeableConcept - the same path every $validate-code takes, and the only one the
      // test suite exercises.
      const outcome = await checker.checkCodeableConcept('Coding',
        { coding: [{ system: coding.system, version: coding.version, code: coding.code }] },
        ValidationCheckMode.Coding);
      inScope = outcome.has('result') && outcome.get('result') === true;
    } catch (e) {
      if (e instanceof Issue) {
        throw e;
      }
      // The value set resolved; checking the code against it is what failed. Say so - the
      // earlier wording claimed it could not be found, which sent the reader looking for a
      // missing resource that was in fact right there.
      throw new Issue('error', 'not-supported', null, null,
        `The value set '${canonical}' was found, but '${coding.system}#${coding.code}' could not be checked against it (${e.message}), so the ${why} cannot be evaluated`, null, 422);
    }
    this.scopeCodeCache.set(key, inScope);
    return inScope;
  }

  /**
   * The answer when nothing can translate this code: a successful operation with a negative
   * result, not an error. Where any candidate map declared a scope, the message names the code,
   * because the code is then the reason - saying only that no map goes from this system to that
   * one would be wrong, since such maps exist and simply do not cover this code.
   */
  noMapsResponse(coding, sourceScope, targetScope, targetSystem, reverse, message, anyScoped) {
    let text = message;
    if (!text) {
      const from = reverse ? (targetSystem || sourceScope) : coding.system;
      const to = reverse ? coding.system : (targetSystem || targetScope);
      text = anyScoped
        ? `No ConceptMap that translates from '${from || '(unspecified)'}' to '${to || '(unspecified)'}' has '${coding.system}#${coding.code}' in scope`
        : `No ConceptMap is available to translate from '${from || '(unspecified)'}' to '${to || '(unspecified)'}'`;
    }
    return {
      resourceType: 'Parameters',
      parameter: [{
        name: 'message',
        valueString: text
      },
      {
        name: 'result',
        valueBoolean: false
      }]
    };
  }

  /**
   * Drop the candidate maps that do not apply to this code. A map that declares no scope on the
   * relevant side is not filtered - it applies on the strength of its group source/target
   * systems alone. Under reverse the concept named is the target concept, so it is
   * ConceptMap.targetScope that governs.
   * @returns {Promise<{maps: Object[], anyScoped: boolean}>} anyScoped says whether any candidate
   *   declared a scope, which decides whether the "no map" message names the code
   */
  async filterMapsByScope(conceptMaps, coding, params, reverse) {
    const maps = [];
    let anyScoped = false;
    const side = reverse ? 'target' : 'source';
    for (const cm of conceptMaps) {
      const canonical = reverse ? cm.targetScope : cm.sourceScope;
      if (!canonical) {
        maps.push(cm);
        continue;
      }
      anyScoped = true;
      if (await this.codeInScope(canonical, coding, params, `${side} scope of the ConceptMap '${cm.url || '(inline)'}'`)) {
        maps.push(cm);
      } else {
        this.opContext.addNote(null, `ConceptMap '${cm.url}' does not apply: '${coding.code}' is not in its ${side} scope '${canonical}'`, 0);
      }
    }
    return { maps, anyScoped };
  }

  /**
   * Perform the actual translate operation
   * @param {Object} conceptMap - ConceptMap resource
   * @param {Object} coding - Source coding to translate
   * @param {string} targetScope - Target value set scope (optional)
   * @param {string} targetSystem - Target code system (optional)
   * @param {Parameters} params - Full parameters object
   * @param {boolean} reverse - Full parameters object*
   * @returns {Object} Parameters resource with translate result
   */
  async doTranslate(conceptMaps, coding, targetScope, targetSystem, params, reverse) {
    this.deadCheck('doTranslate');

    const result = [];

    try {
      // The maps are consulted in order (see sortConceptMaps), and each group within
      // them decides for itself: a group with a mapping for this concept reports it, a
      // group without one falls back to its own group.unmapped. Nothing is remembered
      // across groups - one group having mapped the concept does not stop another group
      // from saying what it does with it.
      const maps = this.sortConceptMaps(conceptMaps);
      let added = false;
      for (const cm of maps) {
        if (cm.jsonObj.internalSource) {
          added = await this.translateUsingCodeSystem(cm, coding, targetSystem, params, result, reverse) || added;
        } else if (reverse) {
          added = this.translateUsingGroupsReverse(cm, coding, targetScope, targetSystem, params, result) || added;
        } else {
          added = await this.translateUsingGroupsForwards(cm, coding, targetScope, targetSystem, params, result) || added;
        }
      }
      result.push({
        name: 'result',
        valueBoolean: added
      });
      if (!added) {
        result.push({
          name: 'message',
          valueString: 'No translations found'
        });
      }
    } catch (error) {
      if (error instanceof Issue) {
        // A coded problem with the request or with the maps themselves. That is not a
        // translation outcome, so it must not be flattened into result=false plus a
        // message - let it out, to be reported as an OperationOutcome with its status.
        throw error;
      }
      this.log.error(error);
      debugLog(error);
      result.push({
        name: 'result',
        valueBoolean: false
      });
      result.push({
        name: 'message',
        valueString: error.message
      });
    }

    return {
      resourceType: 'Parameters',
      parameter: result
    };
  }

  // eslint-disable-next-line no-unused-vars
  isOkTarget(cm, vs) {
    // if cm.target != null then
    //   result := cm.target.url = vs.url
    // else
    return false;
    // todo: or it might be ok to use this value set if it's a subset of the specified one?
  }

  // isOkSourceWithValueSet(cm, vs, coding) {
  //   let result = { found: false, group: null, match: null };
  //
  //   if (true /* (vs == null) || ((cm.source != null) && (cm.source.url === vs.url)) */) {
  //     for (const g of cm.groups || []) {
  //       for (const em of g.elements || []) {
  //         if ((g.source === coding.system) && (em.code === coding.code)) {
  //           result = {
  //             found: true,
  //             group: g,
  //             match: em
  //           };
  //         }
  //       }
  //     }
  //   }
  //   return result;
  // }


  findConceptMap(cm) {
    let msg = '';
    if (cm != null) {
      return { found: true, message: msg };
    } else {
      return { found: false, message: msg };
    }
  }
  /**
   * Build an OperationOutcome. Delegates to the shared builder so that every outcome this
   * server emits has details.text and a tx-issue-type coding: diagnostics is stripped by
   * the test harness, so nothing a caller needs may live there.
   * @param {string} severity - error, warning, information
   * @param {string} code - FHIR issue type
   * @param {string} message - the human readable account of the problem
   * @param {string} [txIssueType] - tx-issue-type; defaulted from code when not given
   * @returns {Object} OperationOutcome resource
   */
  operationOutcome(severity, code, message, txIssueType = null) {
    return buildOperationOutcome(severity, code, message, txIssueType);
  }

  /**
   * Resolve a ConceptMap by canonical reference. Resources supplied with the request
   * (tx-resource, or a front-loaded cache) come first: they are part of the caller's
   * context, and a map named by group.unmapped.otherMap or by the url parameter may
   * well be one of them rather than something the server already knows.
   * @param {string} ref - canonical reference, possibly url|version
   * @param {string} [version] - version, when supplied separately
   * @returns {Promise<ConceptMap|null>}
   */
  async findConceptMapByUrl(ref, version) {
    if (!ref) {
      return null;
    }
    let url = ref;
    let ver = version;
    const bar = ref.indexOf('|');
    if (!ver && bar !== -1) {
      url = ref.substring(0, bar);
      ver = ref.substring(bar + 1);
    }
    const supplied = this.findInAdditionalResources(ver ? url : ref, ver || '', 'ConceptMap', false);
    if (supplied) {
      return supplied;
    }
    return await this.provider.findConceptMap(this.opContext, url, ver);
  }

  async findConceptMapsInAdditionalResources(conceptMaps, system, sourceScope, targetScope, targetSystem) {
    for (let res of this.additionalResources || []) {
      if (res instanceof ConceptMap) {
        if (res.providesTranslation(system, sourceScope, targetScope, targetSystem)) {
          conceptMaps.push(res);
        }
      }
    }
  }

  /**
   * Has some map already stated that this source concept has no mapping? Two maps that
   * agree there is no map are making the same statement, so it is reported once - the
   * same way two maps that agree on a target concept report one match. (A noMap match
   * carries no concept, so hasMatch can never see it.)
   */
  hasNoMap(output, system, code) {
    for (let o of output) {
      if (o.name !== 'match' || !Array.isArray(o.part)) {
        continue;
      }
      const n = o.part.find(x => x.name === 'noMap');
      const sc = o.part.find(x => x.name === 'sourceConcept');
      if (n && n.valueBoolean === true && sc && sc.valueCoding
          && sc.valueCoding.system === system && sc.valueCoding.code === code) {
        return true;
      }
    }
    return false;
  }

  hasMatch(output, outcome) {
    for (let o of output) {
      // output is not all matches: translateUsingCodeSystem also pushes used-system and
      // used-conceptmap, which have no parts at all. And a noMap match has parts but no
      // concept - it is the statement that there is no coded outcome, so it can never
      // collide with one.
      if (o.name !== 'match' || !Array.isArray(o.part)) {
        continue;
      }
      let c = o.part.find(x => x.name === 'concept');
      if (c && c.valueCoding && c.valueCoding.code === outcome.code && c.valueCoding.system === outcome.system) {
        return true;
      }
    }
    return false;
  }
}

module.exports = TranslateWorker;