//
// Validate Worker - Handles $validate-code operations
//
// GET /CodeSystem/$validate-code?{params}
// POST /CodeSystem/$validate-code
// GET /CodeSystem/{id}/$validate-code?{params}
// POST /CodeSystem/{id}/$validate-code
// GET /ValueSet/$validate-code?{params}
// POST /ValueSet/$validate-code
// GET /ValueSet/{id}/$validate-code?{params}
// POST /ValueSet/{id}/$validate-code
//

const { TerminologyWorker, Unknown_Code_in_VersionSCT, SCTVersion } = require('./worker');
const {Languages, Language} = require("../../library/languages");
const {Extensions} = require("../library/extensions");
const {validateParameter, isAbsoluteUrl, validateOptionalParameter, getValuePrimitive} = require("../../library/utilities");
const {TxParameters} = require("../params");
const { OperationOutcome, Issue, buildOperationOutcome, outcomeFromError } = require('../library/operation-outcome');
const {Parameters} = require("../library/parameters");
const {Designations, DisplayCheckingStyle, DisplayDifference, SearchFilterText} = require("../library/designations");
const ValueSet = require("../library/valueset");
const {ValueSetExpander} = require("./expand");
const {FhirCodeSystemProvider} = require("../cs/cs-cs");
const {CodeSystem} = require("../library/codesystem");
const {VersionUtilities} = require("../../library/version-utilities");
const {debugLog} = require("../operation-context");

const DEV_IGNORE_VALUESET = false; // todo: what's going on with this (ported from pascal)

/**
 * Validation check mode - affects how errors are reported
 */
const ValidationCheckMode = {
  Code: 'code',           // Just code string, infer system
  Coding: 'coding',       // Single coding with system/code
  CodeableConcept: 'codeableConcept'  // Multiple codings, any match is success
};

/**
 * Value Set Checker - performs validation against a ValueSet
 * Port of TValueSetChecker from Pascal
 */
class ValueSetChecker {
  worker;
  valueSet;
  params;
  others = new Map();
  indentCount = 0;

  constructor(worker, valueSet, params) {
    validateParameter(worker, "worker", TerminologyWorker);
    validateOptionalParameter(valueSet, "valueSet", ValueSet);
    validateParameter(params, "params", TxParameters);
    this.worker = worker;
    this.valueSet = valueSet;
    this.params = params;
  }

  checkCanonicalStatus(path, op, resource, source) {
    if (resource.jsonObj) {
      resource = resource.jsonObj;
    }
    this.checkCanonicalStatusFull(path, op, resource.resourceType, this.worker.makeVurl(resource), resource.SourcePackage, resource.status, Extensions.readString(resource, 'http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status'), resource.experimental, source);
  }

  async checkCanonicalStatusCS(path, op, cs, source) {
    let status = await cs.status();
    if (cs.version()) {
      this.checkCanonicalStatusFull(path, op, 'CodeSystem', cs.system() + '|' + cs.version(), cs.sourcePackage(), status.status, status.standardsStatus, status.experimental, source);
    } else {
      this.checkCanonicalStatusFull(path, op, 'CodeSystem', cs.system(), cs.sourcePackage(), status.status, status.standardsStatus, status.experimental, source);
    }
  }

  checkCanonicalStatusFull(path, op, rtype, vurl, pid, status, standardsStatus, experimental, source) {
    if (op !== null) {
      if (standardsStatus === 'deprecated') {
        op.addIssueIfNew(new Issue('information', 'business-rule', '', 'MSG_DEPRECATED', this.worker.i18n.translate('MSG_DEPRECATED', this.params.HTTPLanguages, [vurl, '', rtype]), 'status-check'), false);
      } else if (standardsStatus === 'withdrawn') {
        op.addIssueIfNew(new Issue('information', 'business-rule', '', 'MSG_WITHDRAWN', this.worker.i18n.translate('MSG_WITHDRAWN', this.params.HTTPLanguages, [vurl, '', rtype]), 'status-check'), false);
      } else if (status === 'retired') {
        op.addIssueIfNew(new Issue('information', 'business-rule', '', 'MSG_RETIRED', this.worker.i18n.translate('MSG_RETIRED', this.params.HTTPLanguages, [vurl, '', rtype]), 'status-check'), false);
      } else if (source !== null) {
        if (experimental && !source.experimental) {
          op.addIssueIfNew(new Issue('information', 'business-rule', '', 'MSG_EXPERIMENTAL', this.worker.i18n.translate('MSG_EXPERIMENTAL', this.params.HTTPLanguages, [vurl, '', rtype]), 'status-check'), false);
        } else if ((status === 'draft' || standardsStatus === 'draft') &&
          !((source.status === 'draft') || (Extensions.readString(source, 'http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status') === 'draft'))) {
          if (pid) {
            op.addIssueIfNew(new Issue('information', 'business-rule', '', 'MSG_DRAFT', this.worker.i18n.translate('MSG_DRAFT_SRC', this.params.HTTPLanguages, [vurl, pid, rtype]), 'status-check'), false);
          } else {
            op.addIssueIfNew(new Issue('information', 'business-rule', '', 'MSG_DRAFT', this.worker.i18n.translate('MSG_DRAFT', this.params.HTTPLanguages, [vurl, '', rtype]), 'status-check'), false);
          }
        }
      }
    }
  }

  dispWarning() {
    if (this.params.displayWarning) {
      return 'warning';
    } else {
      return 'error';
    }
  }

  async determineSystemFromExpansion(code, systems) {
    let result;
    try {
      let txpe = this.params.clone();
      txpe.limit = 10000;
      let exp = new ValueSetExpander(this.worker, txpe);
      let vse = await exp.expand(this.valueSet, new SearchFilterText(''), true);
      result = '';
      for (let c of vse.expansion.contains || []) {
        this.worker.deadCheck('determineSystemFromExpansion');
        if (c.code === code) {
          systems.add(c.system);
          if (!result) {
            result = c.system;
          } else {
            return '';
          }
        }
      }
    } catch (error) {
      this.worker.log.error(error);
      debugLog(error);
      throw new Error('Exception expanding value set in order to infer system: ' + error.message);
    }
    return result;
  }

  fixedSystemFromValueSet() {
    if (this.valueSet === null) {
      return '';
    }

    let result = '';
    for (let c of this.valueSet.jsonObj.include) {
      this.worker.deadCheck('fixedSystemFromValueSet');
      if (c.hasValueSets || !c.system) {
        return '';
      }
      if (!result) {
        result = c.system;
      } else if (result !== c.system) {
        return '';
      }
    }
    return result;
  }

  async determineSystem(opContext, code, systems, op) {
    let result = '';
    let needDoExpansion = false;
    let mayNeedExpansion = false;

    for (let vsi of this.valueSet.jsonObj.compose.exclude || []) {
      if (vsi.valueSet || !vsi.system || vsi.filter) {
        needDoExpansion = true;
      }
    }
    for (let vsi of this.valueSet.jsonObj.compose.include || []) {
      if (vsi.valueSet || !vsi.system) {
        needDoExpansion = true;
      }
      if (vsi.filter) {
        mayNeedExpansion = true;
      }
    }

    if (needDoExpansion) {
      result = await this.determineSystemFromExpansion(code, systems);
    } else {
      for (let vsi of this.valueSet.jsonObj.compose.include) {
        this.worker.deadCheck('determineSystem');
        let cs = await this.worker.findCodeSystem(vsi.system, '', null, ['complete', 'fragment'], op,true, false, false, this.worker.requiredSupplements);
        if (cs === null) {
          return '';
        }
        if (vsi.concept) {
          for (let cc of vsi.concept) {
            this.worker.deadCheck('determineSystem#2');
            let match = cc.code === code;
            if (match) {
              systems.add(vsi.system);
              if (!result) {
                result = vsi.system;
              } else if (result !== vsi.system) {
                return '';
              }
            }
          }
        } else {
          let loc = await cs.locate(code);
          if (loc.context !== null) {
            systems.add(vsi.system);
            if (!result) {
              result = vsi.system;
            } else if (result !== vsi.system) {
              if (mayNeedExpansion) {
                result = await this.determineSystemFromExpansion(code, systems);
              } else {
                return '';
              }
            }
          }
        }
      }
    }
    return result;
  }

  async determineVersion(path, system, versionVS, versionCoding, op, unknownSystems, messages) {
    validateParameter(path, "path", String);
    validateParameter(system, "system", String);
    validateOptionalParameter(versionVS, "versionVS", String);
    validateOptionalParameter(versionCoding, "versionCoding", String);
    validateParameter(op, "op", OperationOutcome);
    validateParameter(unknownSystems, "unknownSystems", Set);
    validateParameter(messages, "messages", Array);


    let result;
    let csa = await this.worker.findCodeSystem(system, '', this.params, "*",  op,true, false, true, this.worker.requiredSupplements);

    result = this.worker.determineVersionBase(system, versionVS, this.params);

    if (versionCoding) {
      if (result) {
        if (csa !== null) {
          if (versionCoding != result && csa.versionIsMoreDetailed(result, versionCoding)) {
            result = versionCoding;
          }
        }
      }
      if (!result) {
        let vl = await this.worker.listVersions(system);
        if (vl.find(v => v == versionCoding || (csa && csa.versionIsMoreDetailed(versionCoding, v)))) {
          result = versionCoding;
        }
      }

      let cs = await this.worker.findCodeSystem(system, result, this.params, ['complete', 'fragment'], op,true, false, false, this.worker.requiredSupplements);
      if (cs !== null && cs.version() !== versionCoding && !cs.versionIsMoreDetailed(versionCoding, cs.version())) {
        let errLvl = 'error';
        let msg, mid;
        if (!result) {
          if (!cs.versionNeeded()) {
            errLvl = 'warning';
          }
          msg = this.worker.i18n.translate('VALUESET_VALUE_MISMATCH_DEFAULT', this.params.HTTPLanguages, [system, cs.version(), versionVS, versionCoding]);
          mid = 'VALUESET_VALUE_MISMATCH_DEFAULT';
        } else if (result !== versionVS) {
          msg = this.worker.i18n.translate('VALUESET_VALUE_MISMATCH_CHANGED', this.params.HTTPLanguages, [system, result, versionVS ? versionVS : "", versionCoding]);
          mid = 'VALUESET_VALUE_MISMATCH_CHANGED';
        } else {
          msg = this.worker.i18n.translate('VALUESET_VALUE_MISMATCH', this.params.HTTPLanguages, [system, versionVS, versionCoding]);
          mid = 'VALUESET_VALUE_MISMATCH';
        }
        op.addIssue(new Issue(errLvl, 'invalid', addToPath(path, 'version'), mid, msg, 'vs-invalid'));
        if (errLvl === 'error') {
          messages.push(msg);
        }
        let cs2 = await this.worker.findCodeSystem(system, versionCoding, this.params, ['complete', 'fragment'], op, true, false, true, this.worker.requiredSupplements);
        if (cs2 !== null) {
          cs2 = null;
        } else {
          let vl = await this.worker.listVersions(system);
          unknownSystems.add(system + '|' + versionCoding);
          msg = this.worker.i18n.translate('UNKNOWN_CODESYSTEM_VERSION', this.params.HTTPLanguages, [system, versionCoding, this.worker.presentVersionList(vl)]);
          op.addIssue(new Issue('error', 'not-found', addToPath(path, 'system'), 'UNKNOWN_CODESYSTEM_VERSION', msg, 'not-found'));
          messages.push(msg);
        }
      } else if (cs === null && result !== versionCoding) {
        let msg = this.worker.i18n.translate('VALUESET_VALUE_MISMATCH', this.params.HTTPLanguages, [system, result, versionCoding]);
        op.addIssue(new Issue('error', 'invalid', addToPath(path, 'version'), 'VALUESET_VALUE_MISMATCH', msg, 'vs-invalid'));
        messages.push(msg);
      }
    }
    return result;
  }

  seeValueSet() {
    this.worker.opContext.seeContext(this.valueSet.vurl);
    if (this.valueSet.jsonObj.compose && this.valueSet.jsonObj.compose.extension) {
      for (let ext of this.valueSet.jsonObj.compose.extension) {
        if (ext.url === 'http://hl7.org/fhir/StructureDefinition/valueset-expansion-parameter' || ext.url === 'http://hl7.org/fhir/tools/StructureDefinition/valueset-expansion-parameter') {
          let n = Extensions.readString(ext, 'name');
          let v = Extensions.readValue(ext, 'value');
          this.params.seeParameter(n, v, false);
        }
      }
    }
    // R6's ValueSet.compose.property
    this.params.seeCompose(this.valueSet.jsonObj.compose);
    if (!this.params.HTTPLanguages && this.valueSet.jsonObj.language) {
      this.params.HTTPLanguages = Languages.fromAcceptLanguage(this.valueSet.jsonObj.language, this.worker.languages, false);
    }
  }

  async prepare() {
    if (this.valueSet === null) {
      throw new Issue('error', 'not-found', null, null, 'Error Error: vs = nil', null, 422);
    } else {
      this.seeValueSet();
      this.worker.opContext.addNote(this.valueSet, 'Analysing ' + this.valueSet.vurl + ' for validation purposes', this.indentCount);
      if (this.indentCount === 0) {
        this.worker.opContext.addNote(this.valueSet, 'Parameters: ' + this.params.summary(), this.indentCount);
        let vrs = this.params.verSummary();
        if (vrs) {
          this.worker.opContext.addNote(this.valueSet, 'Version Rules: ' + vrs, this.indentCount);
        }
      }
      if (this.worker.requiredSupplements.size > 0) {
        await this.checkSupplementsExist(this.valueSet);
      }

      Extensions.checkNoImplicitRules(this.valueSet, 'ValueSetChecker.prepare', 'ValueSet');
      Extensions.checkNoModifiers(this.valueSet, 'ValueSetChecker.prepare', 'ValueSet', this.valueSet.vurl);

      this.allValueSet = this.valueSet.url === 'http://hl7.org/fhir/ValueSet/@all';

      if (this.valueSet.jsonObj.compose) {
        Extensions.checkNoModifiers(this.valueSet.jsonObj.compose, 'ValueSetChecker.prepare', 'ValueSet.compose', this.valueSet.vurl);
        this.worker.checkNoLockedDate(this.valueSet.vurl, this.valueSet.jsonObj.compose)
        let i = 0;
        for (let cc of this.valueSet.jsonObj.compose.include || []) {
          await this.prepareConceptSet('include['+i+']', cc, this.valueSet);
          i++;
        }
        i = 0;
        for (let cc of this.valueSet.jsonObj.compose.exclude || []) {
          await this.prepareConceptSet('exclude['+i+']', cc, this.valueSet);
          i++;
        }
      }
    }

    const unused = new Set([...this.worker.requiredSupplements].filter(s => !this.worker.usedSupplements.has(s)));
    if (unused.size > 0) {
     throw new Issue('error', 'not-found', null, 'VALUESET_SUPPLEMENT_MISSING', this.worker.i18n.translatePlural(unused.size, 'VALUESET_SUPPLEMENT_MISSING', this.params.HTTPLanguages, [[...unused].join(',')]), 'not-found').handleAsOO(422);
    }
  }

  async prepareConceptSet(desc, cc, vs) {
    this.worker.deadCheck('prepareConceptSet');
    Extensions.checkNoModifiers(cc, 'ValueSetChecker.prepare', desc, vs.vurl);
    this.worker.opContext.addNote(this.valueSet, 'Prepare ' + desc + ': "' + this.worker.renderer.displayValueSetInclude(cc) + '"', this.indentCount);
    if (cc.valueSet) {
      for (let u of cc.valueSet) {
        let s = this.worker.pinValueSet(u);
        this.worker.deadCheck('prepareConceptSet');
        if (!this.others.has(s)) {
          let other = await this.worker.findValueSet(s, '', vs);
          if (other === null) {
            throw new Issue('error', 'not-found', null, 'Unable_to_resolve_value_Set_', this.worker.i18n.translate('Unable_to_resolve_value_Set_', this.params.HTTPLanguages, [s]), 'not-found', 422);
          }
          let checker = new ValueSetChecker(this.worker, other, this.params);
          checker.indentCount = this.indentCount + 1;
          await checker.prepare(other, this.params, null);
          this.others.set(s, checker);
        }
      }
    }
    let v = this.worker.determineVersionBase(cc.system, cc.version, this.params);
    let cs = await this.worker.findCodeSystem(cc.system, v, this.params, ['complete', 'fragment'], null, true, false, false, this.worker.requiredSupplements);
    if (cs !== null) {
      this.worker.opContext.addNote(this.valueSet, 'CodeSystem found: "' + this.worker.renderer.displayCoded(cs) + '"', this.indentCount);
      for (const s of this.worker.requiredSupplements) {
        if (cs.hasSupplement(s)) {
          this.worker.usedSupplements.add(s);
        }
      }
      let i = 0;
      for (let ccf of cc.filter || []) {
        this.worker.deadCheck('prepareConceptSet#2');
        Extensions.checkNoModifiers(ccf, 'ValueSetChecker.prepare', desc + '.filter', this.valueSet.vurl);
        if (!ccf.value) {
          throw new Issue('error', 'invalid', "ValueSet.compose."+desc+".filter["+i+"]", 'UNABLE_TO_HANDLE_SYSTEM_FILTER_WITH_NO_VALUE',
            this.worker.i18n.translate('UNABLE_TO_HANDLE_SYSTEM_FILTER_WITH_NO_VALUE', this.params.HTTPLanguages, [cs.system(), ccf.property, ccf.op]), "vs-invalid").handleAsOO(400);
        }
        if (!(ccf.property === 'concept' && ['is-a', 'descendent-of'].includes(ccf.op))) {
          if (!(await cs.doesFilter(ccf.property, ccf.op, ccf.value))) {
            throw new Issue('error', 'not-supported', "ValueSet.compose."+desc+".filter["+i+"]", 'FILTER_NOT_UNDERSTOOD', this.worker.i18n.translate('FILTER_NOT_UNDERSTOOD', 
              this.params.HTTPLanguages, [ccf.property, ccf.op, ccf.value, this.valueSet.url, cs.system()]), "vs-invalid").handleAsOO(400);
          }
        }
        i++;
      }
    } else if (cc.system) {
      this.worker.opContext.addNote(this.valueSet, 'CodeSystem version ' + v + ' not found: "' + this.worker.renderer.displayCoded(cc.system, cc.version) + '"', this.indentCount);
    }
  }

  async findCode(cs, code, list, displays, isabstract) {
    let result = false;
    for (let i = 0; i < list.length; i++) {
      this.worker.deadCheck('findCode');
      if (code === list[i].code) {
        result = true;
        if (cs === null) {
          isabstract.value = false;
        } else {
          isabstract.value = await cs.isAbstract(list[i]);
        }
        displays.baseLang = this.FLanguages.parse(cs.language);
        !displays.addDesignation(true, "active", '', '', list[i].displayElement);
        throw new Error("Check this");
        // return result;
      }
      let ccl = list[i].conceptList;
      if (await this.findCode(cs, code, ccl, displays, isabstract)) {
        result = true;
        return result;
      }
    }
    return result;
  }

  getName() {
    if (this.valueSet !== null) {
      return this.valueSet.name;
    } else {
      return '??';
    }
  }

  async checkSimple(issuePath, system, version, code, op) {
    this.worker.opContext.clearContexts();
    if (this.params.inferSystem) {
      this.worker.opContext.addNote(this.valueSet, 'Validate "' + code + '" and infer system', this.indentCount);
    } else {
      this.worker.opContext.addNote(this.valueSet, 'Validate "' + this.worker.renderer.displayCoded(system, version, code) + '"', this.indentCount);
    }
    let unknownSystems = new Set();
    let ts = [];
    let msgs = [];
    let ver = {value: ''};
    let inactive = {value: false};
    let normalForm = {value: ''};
    let vstatus = {value: ''};
    let it = {value: null};
    let contentMode = {value: null};
    let impliedSystem = {value: ''};
    let defLang = {value: null};
    return await this.check(issuePath, system, version, code, null, unknownSystems, ver, inactive, normalForm, vstatus, it, op, null, null, contentMode, impliedSystem, ts, msgs, defLang);
  }

  async check(path, system, version, code, displays, unknownSystems, ver, inactive, normalForm, vstatus, cause, op, vcc, params, contentMode, impliedSystem, unkCodes, messages, defLang, display) {
    defLang.value = new Language('en');
    this.worker.opContext.addNote(this.valueSet, 'Check "' + this.worker.renderer.displayCoded(system, version, code) + '"', this.indentCount);

    if (!system && !this.params.inferSystem) {
      let msg = this.worker.i18n.translate('Coding_has_no_system__cannot_validate', this.params.HTTPLanguages, []);
      messages.push(msg);
      op.addIssue(new Issue('warning', 'invalid', path, 'Coding_has_no_system__cannot_validate', msg, 'invalid-data'));
      return false;
    }

    let result;
    let s = this.valueSet.url;
    if (s === 'http://hl7.org/fhir/ValueSet/@all') {
      if (system) {
        let msg = this.worker.i18n.translate('Coding_has_no_system__cannot_validate_NO_INFER', this.params.HTTPLanguages, []);
        messages.push(msg);
        op.addIssue(new Issue('warning', 'invalid', path, 'Coding_has_no_system__cannot_validate_NO_INFER', msg, 'invalid-data'));
        return false;
      }
      let cs = await this.worker.findCodeSystem(system, version, this.params, ['complete', 'fragment'], op,true, false, false, this.worker.requiredSupplements);
      this.worker.seeSourceProvider(cs, system);
      if (cs === null) {
        this.worker.opContext.addNote(this.valueSet, 'Didn\'t find CodeSystem "' + this.worker.renderer.displayCoded(system, version) + '"', this.indentCount);
        result = null;
        cause.value = 'not-found';
        let vss = await this.worker.findValueSet(system, '', null);
        if (vss !== null) {
          vss = null;
          let msg = this.worker.i18n.translate('Terminology_TX_System_ValueSet2', this.params.HTTPLanguages, [system]);
          messages.push(msg);
          op.addIssue(new Issue('error', 'invalid', addToPath(path, 'system'), 'Terminology_TX_System_ValueSet2', msg, 'invalid-data'));
          unknownSystems.add(system);
        } else {
          let css = await this.worker.findCodeSystem(system, version, this.params, ['supplement'], op,true, false, false, this.worker.requiredSupplements);
          if (css !== null) {
            vss = null;
            let msg = this.worker.i18n.translate('CODESYSTEM_CS_NO_SUPPLEMENT', this.params.HTTPLanguages, [this.canonical(css.system(), css.version())]);
            messages.push(msg);
            op.addIssue(new Issue('error', 'invalid', addToPath(path, 'system'), 'CODESYSTEM_CS_NO_SUPPLEMENT', msg, 'invalid-data'));
            unknownSystems.add(system);
          } else if (version) {
            let vl = await this.worker.listVersions(system);
            let mid, vn;
            if (vl.length == 0) {
              mid = 'UNKNOWN_CODESYSTEM_VERSION_NONE';
              vn = system;
            } else {
              mid = 'UNKNOWN_CODESYSTEM_VERSION';
              vn = system + '|' + version;
            }
            let msg = this.worker.i18n.translate(mid, this.params.HTTPLanguages, [system, version,  this.worker.presentVersionList(vl)]);
            messages.push(msg);
            if (!unknownSystems.has(vn)) {
              op.addIssue(new Issue('error', 'not-found', addToPath(path, 'system'), mid, msg, 'not-found'));
              unknownSystems.add(vn);
            }
          } else {
            let msg = this.worker.i18n.translate('UNKNOWN_CODESYSTEM', this.params.HTTPLanguages, [system]);
            messages.push(msg);
            op.addIssue(new Issue('error', 'not-found', addToPath(path, 'system'), 'UNKNOWN_CODESYSTEM', msg, 'not-found'));
            unknownSystems.add(system);
          }
        }
      } else {
        defLang.value = cs.defLang();
        this.worker.opContext.addNote(this.valueSet, 'Using CodeSystem "' + this.worker.renderer.displayCoded(cs) + '" (content = ' + cs.contentMode() + ')', this.indentCount);
        await this.checkCanonicalStatus(path, op, cs, this.valueSet);
        ver.value = cs.version();
        contentMode.value = cs.contentMode();
        let ctxt = await cs.locate(code);
        if (ctxt.context === null) {
          unkCodes.push(cs.system() + '|' + cs.version + '#' + code);
          if (cs.contentMode() !== 'complete') {
            result = true;
            cause.value = 'code-invalid';
            this.worker.opContext.addNote(this.valueSet, 'Not found in Incomplete Code System', this.indentCount);
            let msg = this.worker.i18n.translate('UNKNOWN_CODE_IN_FRAGMENT', this.params.HTTPLanguages, [code, cs.system(), cs.version()]);
            // messages.push(msg); disabled 15-1-2026 GG - it's not considered invalid if it's just a warning
            op.addIssue(new Issue('warning', 'code-invalid', addToPath(path, 'code'), 'UNKNOWN_CODE_IN_FRAGMENT', msg, 'invalid-code'));
          } else {
            result = false;
            cause.value = 'code-invalid';
            this.worker.opContext.addNote(this.valueSet, 'Unknown code', this.indentCount);
            let msg = this.worker.i18n.translate(Unknown_Code_in_VersionSCT(cs.system, cs.version()), this.params.HTTPLanguages, [code, cs.system(), cs.version(), SCTVersion(cs.system(), cs.version())]);
            messages.push(msg);
            op.addIssue(new Issue('error', 'code-invalid', addToPath(path, 'code'), 'Unknown_Code_in_Version', msg, 'invalid-code'));
          }
        } else {
          if (vcc !== null) {
            vcc.addCoding(cs.system(), cs.version(), await cs.code(ctxt), cs.display(ctxt, this.params.workingLanguages()));
          }
          cause.value = 'null';
          if (!(this.params.abstractOk || !(await cs.isAbstract(ctxt)))) {
            result = false;
            this.worker.opContext.addNote(this.valueSet, 'Abstract code when not allowed', this.indentCount);
            cause.value = 'business-rule';
            let msg = this.worker.i18n.translate('ABSTRACT_CODE_NOT_ALLOWED', this.params.HTTPLanguages, [system, code]);
            messages.push(msg);
            op.addIssue(new Issue('error', 'business-rule', addToPath(path, 'code'), 'ABSTRACT_CODE_NOT_ALLOWED', msg, 'code-rule'));
          } else if (this.params !== null && this.params.activeOnly && await cs.isInactive(ctxt)) {
            result = false;
            this.worker.opContext.addNote(this.valueSet, 'Inactive code when not allowed', this.indentCount);
            cause.value = 'business-rule';
            let msg = this.worker.i18n.translate('STATUS_CODE_WARNING_CODE', this.params.HTTPLanguages, ['not active', code]);
            messages.push(msg);
            op.addIssue(new Issue('error', 'business-rule', addToPath(path, 'code'), 'STATUS_CODE_WARNING_CODE', msg, 'code-rule'));
          } else {
            this.worker.opContext.addNote(this.valueSet, 'found OK', this.indentCount);
            result = true;
            const normalised = await cs.code(ctxt.context);
            if (normalised && normalised !== code) {
              messages.push(this.addNormalisationIssue(op, path, code, normalised, cs));
              normalForm.value = normalised;
            }
            let msg = await cs.incompleteValidationMessage(ctxt.context, this.params.HTTPLanguages);
            if (msg) {
              op.addIssue(new Issue('information', 'informational', addToPath(path, 'code'), null, msg, 'process-note'));
            }
            inactive.value = await cs.isInactive(ctxt.context);
            inactive.path = path;
            vstatus.value = await cs.getStatus(ctxt.context);
          }
          if (displays !== null) {
            await this.worker.listDisplaysFromCodeSystem(displays, cs, ctxt.context);
          }
        }
      }
    } else if (DEV_IGNORE_VALUESET) {
      // anyhow, we ignore the value set (at least for now)
      let cs = await this.worker.findCodeSystem(system, version, this.params, ['complete', 'fragment'], op, true, true, false, this.worker.requiredSupplements);
      if (cs === null) {
        result = null;
        cause.value = 'not-found';
        this.worker.opContext.addNote(this.valueSet, 'Unknown code system', this.indentCount);
        let vl, mid, vn;
        if (version) {
          vl = this.listVersions(system);
          if (vl.length == 0) {
            mid = 'UNKNOWN_CODESYSTEM_VERSION_NONE';
            vn = system + '|' + version;
          } else {
            mid = 'UNKNOWN_CODESYSTEM_VERSION';
            vn = system + '|' + version;
          }
          let msg = this.worker.i18n.translate(mid, this.params.HTTPLanguages, [system, version,  this.worker.presentVersionList(vl)]);
          messages.push(msg);
          if (!unknownSystems.has(vn)) {
            op.addIssue(new Issue('error', 'not-found', addToPath(path, 'system'), mid, msg, 'not-found'));
            unknownSystems.add(vn);
          }
        } else {
          let msg = this.worker.i18n.translate('UNKNOWN_CODESYSTEM', this.params.HTTPLanguages, [system]);
          messages.push(msg);
          op.addIssue(new Issue('error', 'not-found', addToPath(path, 'system'), 'UNKNOWN_CODESYSTEM', msg, 'not-found'));
          unknownSystems.add(system);
        }
      } else {
        defLang.value = cs.defLang();
        this.checkCanonicalStatus(path, op, cs, this.valueSet);
        ver.value = cs.version();
        contentMode.value = cs.contentMode();
        let ctxt = cs.locate(code);
        if (ctxt.context === null) {
          unkCodes.push(system + '|' + version + '#' + code);
          if (cs.contentMode() !== 'complete') {
            result = true;
            cause.value = 'code-invalid';
            this.worker.opContext.addNote(this.valueSet, 'Not found in Incomplete Code System', this.indentCount);
            let msg = this.worker.i18n.translate('UNKNOWN_CODE_IN_FRAGMENT', this.params.HTTPLanguages, [code, system, version]);
            // messages.push(msg); it's just a warning
            op.addIssue(new Issue('warning', 'code-invalid', addToPath(path, 'code'), 'UNKNOWN_CODE_IN_FRAGMENT', msg, 'invalid-code'));
          } else {
            result = false;
            cause.value = 'code-invalid';
            this.worker.opContext.addNote(this.valueSet, 'Unknown code', this.indentCount);
            let msg = this.worker.i18n.translate(Unknown_Code_in_VersionSCT(system, version), this.params.HTTPLanguages, [code, system, version, SCTVersion(system, version)]);
            messages.push(msg);
            op.addIssue(new Issue('warning', 'code-invalid', addToPath(path, 'code'), 'Unknown_Code_in_Version', msg, 'invalid-code'));
          }
        } else {
          ctxt = ctxt.context;
          cause.value = 'null';
          if (!(this.params.abstractOk || !(await cs.isAbstract(ctxt)))) {
            result = false;
            this.worker.opContext.addNote(this.valueSet, 'Abstract code when not allowed', this.indentCount);
            cause.value = 'business-rule';
            let msg = this.worker.i18n.translate('STATUS_CODE_WARNING_CODE', this.params.HTTPLanguages, ['not active', code]);
            messages.push(msg);
            op.addIssue(new Issue('error', 'business-rule', addToPath(path, 'code'), 'STATUS_CODE_WARNING_CODE', msg, 'code-rule'));
          } else if (this.params !== null && this.params.activeOnly && await cs.isInactive(ctxt)) {
            result = false;
            this.worker.opContext.addNote(this.valueSet, 'Inactive code when not allowed', this.indentCount);
            cause.value = 'business-rule';
            let msg = this.worker.i18n.translate('STATUS_CODE_WARNING_CODE', this.params.HTTPLanguages, ['not active', code]);
            messages.push(msg);
            op.addIssue(new Issue('error', 'business-rule', addToPath(path, 'code'), 'STATUS_CODE_WARNING_CODE', msg, 'code-rule'));
          } else {
            this.worker.opContext.addNote(this.valueSet, 'found', this.indentCount);
            result = true;
          }
          await this.worker.listDisplaysFromCodeSystem(displays, cs, ctxt);
        }
      }
    } else {
      if (!system && this.params.inferSystem) {
        let systems = new Set();
        system = await this.determineSystem(this.worker.opContext, code, systems, op);
        if (!system) {
          let msg;
          if (systems.size > 1) {
            msg = this.worker.i18n.translate('Unable_to_resolve_system__value_set_has_multiple_matches', this.params.HTTPLanguages, [code, this.valueSet.vurl, Array.from(systems).join(',')]);
            messages.push(msg);
            op.addIssue(new Issue('error', 'not-found', 'code', 'Unable_to_resolve_system__value_set_has_multiple_matches', msg, 'cannot-infer'));
          } else {
            msg = this.worker.i18n.translate('UNABLE_TO_INFER_CODESYSTEM', this.params.HTTPLanguages, [code, this.valueSet.vurl]);
            messages.push(msg);
            op.addIssue(new Issue('error', 'not-found', 'code', 'UNABLE_TO_INFER_CODESYSTEM', msg, 'cannot-infer'));
          }
          return false;
        } else {
          impliedSystem.value = system;
          this.worker.opContext.addNote(this.valueSet, 'Inferred CodeSystem = "' + system + '"', this.indentCount);
        }
      }

      const unused = new Set([...this.worker.requiredSupplements].filter(s => !this.worker.usedSupplements.has(s)));
      if (unused.size > 0) {
        throw new Issue('error', 'not-found', null, 'VALUESET_SUPPLEMENT_MISSING', this.worker.i18n.translatePlural(unused.size, 'VALUESET_SUPPLEMENT_MISSING', this.params.HTTPLanguages, [[...unused].join(',')]), 'not-found').handleAsOO(422);
      }

      if (Extensions.checkNoModifiers(this.valueSet.jsonObj.compose, 'ValueSetChecker.prepare', 'ValueSet.compose', this.valueSet.vurl)) {
        result = false;
        let determinedVersion = undefined;
        if (!version) {
          // if we don't have a fixed version, and we have more than one possible version, we have to pick the version
          // now, by looking to see which version we can find the value in, starting from the most revent.
          let includes = (this.valueSet.jsonObj.compose.include || []).filter(inc => inc.system == system);
          let vset = new Set(includes.map(inc => inc.version).filter(Boolean));
          if (vset.size > 1) {
            determinedVersion = await this.pickApplicableVersion(vset, system, code, display);
          }
        }
        const includes = [...(this.valueSet.jsonObj.compose.include || [])];
        includes.sort((a, b) => {
          if (a.system === b.system && a.version && b.version) {
            return -VersionUtilities.compareVersionsGeneral(a.version, b.version);
          }
          return 0;
        });
        for (let cc of includes) {
          this.worker.deadCheck('check#2');
          if (!cc.system) {
            result = true;
          } else if ((cc.system === system || system === '%%null%%') && (!determinedVersion || cc.version == determinedVersion) && this.useThisVersion(cc, version)) {
            let v = await this.determineVersion(path, cc.system, cc.version, version, op, unknownSystems, messages);
            let cs = await this.worker.findCodeSystem(system, v, this.params, ["complete", "fragment"], op,true, true, false, this.worker.requiredSupplements);
            if (cs === null) {
              this.worker.opContext.addNote(this.valueSet, 'CodeSystem not found: ' + this.worker.renderer.displayCoded(cc.system, v), this.indentCount);
              if (!this.params.membershipOnly) {
                let bAdd = true;
                let msg, mid, vn;
                if (!v) {
                  msg = this.worker.i18n.translate('UNKNOWN_CODESYSTEM', this.params.HTTPLanguages, [system]);
                  unknownSystems.add(system);
                  mid = 'UNKNOWN_CODESYSTEM';
                } else {
                  let vl = await this.worker.listVersions(system);
                  if (vl.length == 0) {
                    mid = 'UNKNOWN_CODESYSTEM_VERSION_NONE';
                    vn = system;
                  } else {
                    mid = 'UNKNOWN_CODESYSTEM_VERSION';
                    vn = system + '|' + v;
                  }
                  msg = this.worker.i18n.translate(mid, this.params.HTTPLanguages, [system, v,  this.worker.presentVersionList(vl)]);
                  bAdd = !unknownSystems.has(vn);
                  if (bAdd) {
                    unknownSystems.add(vn);
                  }
                }
                messages.push(msg);
                if (bAdd) {
                  op.addIssue(new Issue('error', 'not-found', addToPath(path, 'system'), mid, msg, 'not-found'));
                }
                return null;
              } else {
                return false;
              }
            }
            defLang.value = new Language(cs.defLang());
            this.worker.opContext.addNote(this.valueSet, 'CodeSystem found: ' + this.worker.renderer.displayCoded(cs) + ' for ' + this.worker.renderer.displayCoded(cc.system, v), this.indentCount);
            await this.checkCanonicalStatusCS(path, op, cs, this.valueSet);
            this.worker.checkSupplements(cs, cc, this.worker.requiredSupplements, this.worker.usedSupplements);
            contentMode.value = cs.contentMode();

            let msg = '';
            if ((system === '%%null%%' || cs.system() === system) && await this.checkConceptSet(path, 'in', cs, cc, code, displays, this.valueSet, msg, inactive, normalForm, vstatus, op, vcc, messages)) {
              ver.value = cs.version();
              result = true;
            } else {
              result = false;
            }
            if (msg) {
              messages.push(msg);
            }
          } else {
            this.worker.opContext.addNote(this.valueSet, 'Include for ' + this.worker.renderer.displayCoded(cc.system, cc.version) + ' not considered for "' + this.worker.renderer.displayCoded(system, version) + '"', this.indentCount);
            result = false;
          }
          for (let u of cc.valueSet || []) {
            this.worker.deadCheck('check#3');
            let s = this.worker.pinValueSet(u);
            this.worker.opContext.addNote(this.valueSet, 'Check included value set ' + s, this.indentCount);
            let checker = this.others.get(s);
            if (checker === null || checker === undefined) {
              throw new Issue('error', 'unknown', null, null, 'No Match for ' + s + ' in ' + Array.from(this.others.keys()).join(','));
            }
            this.checkCanonicalStatus(path, op, checker.valueSet, this.valueSet);
            if (result === true) {
              result = await checker.check(path, system, version, code, displays, unknownSystems, ver, inactive, normalForm, vstatus, cause, op, null, params, contentMode, impliedSystem, unkCodes, messages, defLang);
            }
          }
          if (result === true) {
            break;
          }
        }
        if (result === true) {
          for (let cc of this.valueSet.jsonObj.compose.exclude || []) {
            this.worker.deadCheck('check#4');
            let excluded;
            if (!cc.system) {
              excluded = true;
            } else {
              let cs = await this.worker.findCodeSystem(cc.system, cc.version, this.params, ['complete', 'fragment'], op,true, true, false, this.worker.requiredSupplements);
              if (cs === null) {
                throw new Issue('error', 'unknown', null, null, 'No Match for ' + cc.system + '|' + cc.version);
              }
              await this.checkCanonicalStatus(path, op, cs, this.valueSet);
              this.worker.checkSupplements(cs, cc, this.worker.requiredSupplements, this.worker.usedSupplements);
              contentMode.value = cs.contentMode();
              let msg = '';
              excluded = (system === '%%null%%' || cs.system() === system) && await this.checkConceptSet(path, 'not in', cs, cc, code, displays, this.valueSet, msg, inactive, normalForm, vstatus, op, vcc);
              if (msg) {
                messages.push(msg);
              }
            }
            for (let u of cc.valueSet || []) {
              this.worker.deadCheck('check#5');
              let s = this.worker.pinValueSet(u);
              let checker = this.others.get(s);
              if (checker === null) {
                throw new Issue('error', 'unknown', null, null, 'No Match for ' + cc.system + '|' + cc.version + ' in ' + Array.from(this.others.keys()).join(','));
              }
              this.checkCanonicalStatus(path, op, checker.valueSet, this.valueSet);
              excluded = excluded && (await checker.check(path, system, version, code, displays, unknownSystems, ver, inactive, normalForm, vstatus, cause, op, null, params, contentMode, impliedSystem, unkCodes, messages, defLang) === true);
            }
            if (excluded) {
              return false;
            }
          }
        }
      } else if (Extensions.checkNoModifiers(this.valueSet.jsonObj.expansion, 'ValueSetChecker.prepare', 'ValueSet.expansion', this.valueSet.vurl)) {
        let ccc = this.valueSet.findContains(system, version, code);
        if (ccc === null) {
          result = false;
        } else {
          let v;
          if (!ccc.version && !version) {
            v = '';
          } else if (!ccc.version) {
            v = version;
          } else if (!version || version === ccc.version) {
            v = ccc.version;
          } else if (cs !== null && cs.versionIsMoreDetailed(ccc.version, version)) {
            v = version;
          } else {
            let msg = 'The code system "' + ccc.system + '" version "' + ccc.version + '" in the ValueSet expansion is different to the one in the value ("' + version + '")';
            messages.push(msg);
            op.addIssue(new Issue('error', 'not-found', addToPath(path, 'version'), null, msg, 'vs-invalid'));
            return false;
          }
          let cs = await this.worker.findCodeSystem(system, v, this.params, ['complete', 'fragment'], op, true, true, false, this.worker.requiredSupplements);
          if (cs === null) {
            if (!this.params.membershipOnly) {
              let bAdd = true;
              let msg, mid, vn;
              if (!v) {
                mid = 'UNKNOWN_CODESYSTEM';
                msg = this.worker.i18n.translate('UNKNOWN_CODESYSTEM', this.params.HTTPLanguages, [system]);
                unknownSystems.add(system);
              } else {
                bAdd = !unknownSystems.has(system + '|' + version);
                if (bAdd) {
                  let vl = await this.worker.listVersions(system);
                  if (vl.length == 0) {
                    mid = 'UNKNOWN_CODESYSTEM_VERSION_NONE';
                    vn = system;
                  } else {
                    mid = 'UNKNOWN_CODESYSTEM_VERSION';
                    vn = system + '|' + v;
                  }
                  msg = this.worker.i18n.translate(mid, this.params.HTTPLanguages, [system, v,  this.worker.presentVersionList(vl)]);
                  unknownSystems.add(vn);
                }
              }
              messages.push(msg);
              if (bAdd) {
                op.addIssue(new Issue('error', 'not-found', addToPath(path, 'system'), mid, msg, 'not-found'));
              }
              return null;
            } else {
              return false;
            }
          }
          defLang.value = cs.defLang();
          await this.checkCanonicalStatus(path, op, cs, this.valueSet);
          ver.value = cs.version();
          contentMode.value = cs.contentMode();
          let msg = '';
          if ((system === '%%null%%' || cs.system() === system) && await this.checkExpansion(path, cs, ccc, code, displays, this.valueSet, msg, inactive, vstatus, op)) {
            result = true;
          } else {
            result = false;
          }
          if (msg) {
            messages.push(msg);
          }
        }
      } else {
        this.worker.opContext.addNote(this.valueSet, 'ValueSet has neither compose nor expansion - cannot determine membership', this.indentCount);
        result = false;
      }
    }

    return result;
  }

  async checkCoding(issuePath, coding) {
    let inactive = false;
    let path = issuePath;
    let unknownSystems = new Set();
    let unkCodes = [];
    let messages = [];
    let result = new Parameters();

    this.worker.opContext.clearContexts();
    if (this.params.inferSystem) {
      this.worker.opContext.addNote(this.valueSet, 'Validate "' + this.worker.renderer.displayCoded(coding) + '" and infer system', this.indentCount);
    } else {
      this.worker.opContext.addNote(this.valueSet, 'Validate "' + this.worker.renderer.displayCoded(coding) + '"', this.indentCount);
    }

    let op = new OperationOutcome();
    this.checkCanonicalStatus(path, op, this.valueSet, this.valueSet);
    let list = new Designations(this.worker.languages);
    let ver = {value: ''};
    inactive = {value: false};
    let normalForm = {value: ''};
    let vstatus = {value: ''};
    let cause = {value: null};
    let contentMode = {value: null};
    let impliedSystem = {value: ''};
    let defLang = {value: null};

    let ok = await this.check(path, coding.system, coding.version, coding.code, list, unknownSystems, ver, inactive, normalForm, vstatus, cause, op, null, result, contentMode, impliedSystem, unkCodes, messages, defLang);
    if (ok === true) {
      result.AddParamBool('result', true);
      if ((cause.value === 'not-found' && contentMode.value !== 'complete') || contentMode.value === 'example') {
        result.addParamStr('message', 'The system "' + coding.system + ' was found but did not contain enough information to properly validate the code (mode = ' + contentMode.value + ')');
      }
      if (coding.display && !list.hasDisplay(this.params.workingLanguages(), defLang.value, coding.display, false, DisplayCheckingStyle.CASE_INSENSITIVE).found) {
        let baseMsg = 'Display_Name_for__should_be_one_of__instead_of';
        let dc = list.displayCount(this.params.workingLanguages(), null, true);
        if (dc > 0) {
          if (list.hasDisplay(this.params.workingLanguages(), defLang.value, coding.display, false, DisplayCheckingStyle.CASE_INSENSITIVE).difference === DisplayDifference.Normalised) {
            baseMsg = 'Display_Name_WS_for__should_be_one_of__instead_of';
          }
          if (dc === 1) {
            result.addParamStr('message', this.worker.i18n.translate(baseMsg + '_one', this.params.HTTPLanguages,
              ['', coding.system, coding.code, list.present(this.params.workingLanguages(), defLang.value, true), coding.display, this.params.langSummary()]));
          } else {
            result.addParamStr('message', this.worker.i18n.translate(baseMsg + '_other', this.params.HTTPLanguages, [dc.toString(), coding.system, coding.code, list.present(this.params.workingLanguages(), defLang.value, true), coding.display, this.params.langSummary()]));
          }
        }
      }
      let pd = list.preferredDisplay(this.params.workingLanguages());
      if (pd) {
        result.addParamStr('display', pd);
      }
      result.addParamUri('system', coding.system);
      if (ver.value) {
        result.addParamStr('version', ver.value);
      }
      if (cause.value !== 'null') {
        result.AddParamCode('cause', cause.value);
      }
      if (inactive.value) {
        result.AddParamBool('inactive', inactive.value);
        if (vstatus.value && vstatus.value !== 'inactive') {
          result.addParamCode('status', vstatus.value);
        }
        let msg = this.worker.i18n.translate('INACTIVE_CONCEPT_FOUND', this.params.HTTPLanguages, [vstatus.value, coding.code]);
        messages.push(msg);
        op.addIssue(new Issue('warning', 'business-rule', path, 'INACTIVE_CONCEPT_FOUND', msg, 'code-comment'));
      } else if (vstatus.value && vstatus.value.toLowerCase() === 'deprecated') {
        result.addParamCode('status', vstatus.value);
        let msg = this.worker.i18n.translate('DEPRECATED_CONCEPT_FOUND', this.params.HTTPLanguages, [vstatus.value, coding.code]);
        messages.push(msg);
        op.addIssue(new Issue('warning', 'business-rule', path, 'DEPRECATED_CONCEPT_FOUND', msg, 'code-comment'));
      }
    } else if (ok === null) {
      result.AddParamBool('result', false);
      result.addParamStr('message', 'The CodeSystem "' + coding.system + '" is unknown, so the code "' + coding.code + '" is not known to be in the ' + this.valueSet.name);
      for (let us of unknownSystems) {
        result.addParamCanonical('x-caused-by-unknown-system', us);
      }
    } else {
      result.AddParamBool('result', false);
      if (ver.value) {
        result.addParamStr('version', ver.value);
      }
      result.addParamStr('message', 'The system/code "' + coding.system + '"/"' + coding.code + '" is not in the value set ' + this.valueSet.name);
      if (cause.value !== 'null') {
        result.AddParamCode('cause', cause.value);
      }
    }
    if (op.hasIssues) {
      result.addParam('issues').resource = op.jsonObj;
    }
    return result;
  }

  valueSetDependsOnCodeSystem(url, version) {
    for (let inc of this.valueSet.include) {
      this.worker.deadCheck('valueSetDependsOnCodeSystem');
      if (inc.system === url && (!version || version === inc.version || !inc.version)) {
        return true;
      }
    }
    return false;
  }

  async checkSupplementsExist(vs) {
    for (let inc of vs.jsonObj.compose.include) {
      if (inc.system) {
        let cs = await this.worker.findCodeSystem(inc.system, inc.version, this.params, ['complete', 'fragment'], null,true, false, false, this.worker.requiredSupplements);
        if (cs !== null) {
          await this.worker.checkSupplements(cs, null, this.worker.requiredSupplements, this.worker.usedSupplements);
        }
      }
    }
  }

  async checkCodeableConcept(issuePath, code, mode) {
    this.worker.opContext.clearContexts();
    if (this.params.inferSystem) {
      this.worker.opContext.addNote(this.valueSet, 'Validate "' + this.worker.renderer.displayCoded(code) + '" and infer system', this.indentCount);
    } else {
      this.worker.opContext.addNote(this.valueSet, 'Validate "' + this.worker.renderer.displayCoded(code) + '"', this.indentCount);
    }

    let inactive = { value: false };
    let cause = { value: "null" };
    if (this.valueSet === null) {
      throw new Issue('error', 'invalid', null, null, 'Error: cannot validate a CodeableConcept without a nominated valueset');
    }
    let pdisp;
    let psys;
    let pcode;
    let pver;


    let vstatus = {value: ''};
    let normalForm = {value: ''};
    let mt = [];
    let ts = [];
    let tsys = '';
    let tcode = '';
    let tver = '';
    let vcc = {}; // todo: VCC is an appendage, and useless. remove it
    if (code.text) {
      vcc.text = code.text;
    }
    let unknownSystems = new Set();
    let result = new Parameters();

    const msg = (s, clear = false) => {
      if (!s) {
        return;
      }
      if (clear) {
        mt = [];
      }
      if (!mt.includes(s)) {
        mt.push(s);
      }
    };

    let op = new OperationOutcome();
    this.checkCanonicalStatus(issuePath, op, this.valueSet.jsonObj, this.valueSet.jsonObj);
    let list = new Designations(this.worker.languages);
    let ok = false;
    let matchedCodings = new Set();
    let codelist = '';
    mt = [];
    let i = 0;
    let impliedSystem = { value: '' };
    for (let c of code.coding || []) {
      if (this.worker.opContext.usageTracker) {
        this.worker.opContext.usageTracker.seeConcept(c.system, c.code);
      }
      let vsImpliedVersion = this.findVSVersionForSystem(c.system);
      const csd = await this.worker.findCodeSystem(c.system, vsImpliedVersion, this.params, ['complete', 'fragment'], false, true, false, false, this.worker.requiredSupplements);
      this.worker.seeSourceProvider(csd, c.system);
      this.worker.deadCheck('check-b#1');
      let path;
      if (issuePath === 'CodeableConcept') {
        path = addToPath(issuePath, 'coding[' + i + ']');
      } else {
        path = issuePath;
      }
      if (!c.code) {
        let msg = `Coding has no code for system ${c.system} and cannot be validated`;
        op.addIssue(new Issue('error', 'invalid', path, null, msg, 'invalid-data'));
        break;
      }
      list.clear();
      let ver = { value: '' };
      let contentMode = { value: null };
      let defLang = { value: null };
      let v = await this.check(path, c.system, c.version, c.code, list, unknownSystems, ver, inactive, normalForm, vstatus, cause, op, vcc, result, contentMode, impliedSystem, ts, mt, defLang, c.display);
      if (v === false) {
        cause.value = 'code-invalid';
      }
      if (v === true) {
        matchedCodings.add(i);
      }
      let ws;
      if (impliedSystem.value) {
        ws = impliedSystem.value;
      } else {
        ws = c.system;
      }
      if (!tcode || v == true) {
        tsys = c.system;
        tcode = c.code;
        tver = c.version;
      }
      if (!tver && ver.value) {
        tver = ver.value;
      }
      let cc;
      if (!ws) {
        ws = "";
      }
      if (!c.version) {
        cc = ws + '#' + c.code;
      } else {
        cc = ws + '|' + c.version + '#' + c.code;
      }
      if (c.display) {
        cc = cc + ' (\'' + c.display + '\')';
      }
      codelist = !codelist ? '\'' + cc + '\'' : codelist + ', \'' + cc + '\'';

      if (v === false && !this.valueSet.jsonObj.internallyDefined && mode === 'codeableConcept') {
        let m = this.worker.i18n.translate('None_of_the_provided_codes_are_in_the_value_set_one', this.params.HTTPLanguages, ['', this.valueSet.vurlOrMsg, '\'' + cc + '\'']);
        let p = issuePath + '.coding[' + i + '].code';
        op.addIssue(new Issue('information', 'code-invalid', p, 'None_of_the_provided_codes_are_in_the_value_set_one', m, 'this-code-not-in-vs'));
        if (cause.value === 'null') {
          cause.value = 'unknown';
        }
      }

      if (ok !== true && v !== false) {
        ok = v;
      }
      if (v === true) {
        if ((cause.value === 'not-found' && contentMode.value !== 'complete') || contentMode.value === 'example') {
          let m = 'The system ' + c.system + ' was found but did not contain enough information to properly validate the code "' + c.code + '" ("' + c.display + '") (mode = ' + contentMode.value + ')';
          msg(m);
          op.addIssue(new Issue('warning', 'not-found', path, null, m, 'vs-invalid'));
        } else if (c.display && list.designations.length > 0) {
          await this.checkDisplays(list, defLang, c, msg, op, path);
        }
        // Report the FIRST matching coding, not the last: when a CodeableConcept
        // has several valid codings, the code/system/version/display echoed back
        // are those of the earliest coding that validated. Only capture once
        // (pcode is undefined until the first match).
        if (pcode === undefined) {
          psys = c.system;
          pcode = c.code;
          if (ver.value) {
            pver = ver.value;
          }
          let pd = list.preferredDisplay(this.params.workingLanguages());
          if (pd) {
            pdisp = pd;
          }
          if (!pdisp) {
            pdisp = list.preferredDisplay(null);
          }
        }
      } else if (!this.params.membershipOnly && ws) {
        if (!isAbsoluteUrl(ws)) {
          let m = this.worker.i18n.translate('Terminology_TX_System_Relative', this.params.HTTPLanguages, []);
          let p;
          if (mode === 'coding') {
            p = issuePath + '.system';
          } else if (mode === 'codeableConcept') {
            p = issuePath + '.coding[' + i + '].system';
          } else {
            p = issuePath;
          }
          mt.push(m);
          op.addIssue(new Issue('error', 'invalid', p, 'Terminology_TX_System_Relative', m, 'invalid-data'));
        }
        let prov = await this.worker.findCodeSystem(ws, c.version, this.params, ['complete', 'fragment'],  op,true, true, false, this.worker.requiredSupplements);
        if (prov === null) {
          let vss = await this.worker.findValueSet(ws, '', null);
          if (vss !== null) {
            vss = null;
            let m = this.worker.i18n.translate('Terminology_TX_System_ValueSet2', this.params.HTTPLanguages, [ws]);
            msg(m);
            op.addIssue(new Issue('error', 'invalid', addToPath(path, 'system'), 'Terminology_TX_System_ValueSet2', m, 'invalid-data'));
            cause.value = 'invalid';
          } else {
            let provS = await this.worker.findCodeSystem(ws, c.version, this.params, ['supplement'], op,true, true, false, this.worker.requiredSupplements);
            if (provS !== null) {
              vss = null;
              let m = this.worker.i18n.translate('CODESYSTEM_CS_NO_SUPPLEMENT', this.params.HTTPLanguages, [provS.vurl()]);
              msg(m);
              op.addIssue(new Issue('error', 'invalid', addToPath(path, 'system'), 'CODESYSTEM_CS_NO_SUPPLEMENT', m, 'invalid-data'));
              cause.value = 'invalid';
            } else {
              let prov2 = await this.worker.findCodeSystem(ws, '', this.params, ['complete', 'fragment'], op,true, true, false, this.worker.requiredSupplements);
              let bAdd = true;
              let m, mid, vn;
              if (prov2 === null && !c.version) {
                mid = 'UNKNOWN_CODESYSTEM';
                m = this.worker.i18n.translate('UNKNOWN_CODESYSTEM', this.params.HTTPLanguages, [ws]);
                bAdd = !unknownSystems.has(ws);
                if (bAdd) {
                  unknownSystems.add(ws);
                }
              } else {
                let vl = await this.worker.listVersions(c.system);
                if (vl.length == 0) {
                  mid = 'UNKNOWN_CODESYSTEM_VERSION_NONE';
                  vn = ws;
                } else {
                  mid = 'UNKNOWN_CODESYSTEM_VERSION';
                  vn = ws + '|' + c.version;
                }
                m = this.worker.i18n.translate(mid, this.params.HTTPLanguages, [ws, c.version,  this.worker.presentVersionList(vl)]);
                bAdd = !unknownSystems.has(vn);
                if (bAdd) {
                  unknownSystems.add(vn);
                }
              }
              if (bAdd) {
                op.addIssue(new Issue('error', 'not-found', addToPath(path, 'system'), mid, m, 'not-found'));
              }
              msg(m);
              cause.value = 'not-found';
            }
          }
        } else {
          await this.checkCanonicalStatusCS(path, op, prov, this.valueSet);
          let ctxt = await prov.locate(c.code);
          if (!ctxt.context) {
            // message can never be populated in pascal?
            // if (ctxt.message) {
            //   let p;
            //   if (mode !== 'code') {
            //     p = path + '.code';
            //   }
            //   op.addIssue(new Issue('information', cause.value, p, null, ctxt.message, 'invalid-code'));
            //   message = '';
            // }
            if (vcc.coding) {
              vcc.coding = vcc.coding.filter(ccc => ccc.system === prov.system() && (!prov.version() || ccc.version == prov.version()) && ccc.code === c.code);
            }
            let vs = ws + '|' + prov.version() + '#' + c.code;
            if (!ts.includes(vs)) {
              ts.push(vs);
              let m;
              if (prov.contentMode() === 'complete') {
                m = this.worker.i18n.translate(Unknown_Code_in_VersionSCT(ws, prov.version()), this.params.HTTPLanguages, [c.code, ws, prov.version(), SCTVersion(ws, prov.version())]);
                cause.value = 'code-invalid';
                msg(m);
                op.addIssue(new Issue('error', 'code-invalid', addToPath(path, 'code'), 'Unknown_Code_in_Version', m, 'invalid-code'), true);
              } else {
                m = this.worker.i18n.translate('UNKNOWN_CODE_IN_FRAGMENT', this.params.HTTPLanguages, [c.code, ws, prov.version()]);
                cause.value = 'code-invalid';
                // msg(m); - it's just a warning
                op.addIssue(new Issue('warning', 'code-invalid', addToPath(path, 'code'), 'UNKNOWN_CODE_IN_FRAGMENT', m, 'invalid-code'), true);
              }
            }
          } else {
            if (!c.version && mode == 'codeableConcept' && prov.version()) {
              c.version = prov.version();
            }
            await this.worker.listDisplaysFromCodeSystem(list, prov, ctxt.context);
            // the code resolved in the code system, so its status is known whether or not it
            // turns out to be in the value set. check() only picks the status up on the paths
            // where the code was found in the value set, so pick it up here for the rest
            if (!this.params.membershipOnly && !inactive.value && await prov.isInactive(ctxt.context)) {
              inactive.value = true;
              inactive.path = path;
              const st = await prov.getStatus(ctxt.context);
              if (st) {
                vstatus.value = st;
              }
            }
            let pd = list.preferredDisplay(this.params.workingLanguages());
            if (pd) {
              pdisp = pd;
            }
            if (!pdisp) {
              pdisp = list.preferredDisplay(null);
            }
            let severity = this.dispWarning();
            if (c.display && list.designations.length > 0 && !list.hasDisplay(this.params.workingLanguages(), defLang.value, c.display, false, DisplayCheckingStyle.CASE_INSENSITIVE).found) {
              let baseMsg;
              if (list.hasDisplay(this.params.workingLanguages(), defLang.value, c.display, false, DisplayCheckingStyle.CASE_INSENSITIVE).difference === DisplayDifference.Normalized) {
                baseMsg = 'Display_Name_WS_for__should_be_one_of__instead_of';
              } else {
                baseMsg = 'Display_Name_for__should_be_one_of__instead_of';
              }

              let dc = list.displayCount(this.params.workingLanguages(), null, true);
              let m;
              if (dc === 0) {
                severity = 'warning';
                baseMsg = 'NO_VALID_DISPLAY_AT_ALL';
                m = this.worker.i18n.translate('NO_VALID_DISPLAY_AT_ALL', this.params.HTTPLanguages,
                  [c.display, prov.system(), c.code, this.params.langSummary()]);
              } else if (dc === 1) {
                m = this.worker.i18n.translate(baseMsg + '_one', this.params.HTTPLanguages,
                  ['', prov.system(), c.code, list.present(this.params.workingLanguages(), defLang.value, true), c.display, this.params.langSummary()]);
              } else {
                m = this.worker.i18n.translate(baseMsg + '_other', this.params.HTTPLanguages,
                  [dc.toString(), prov.system(), c.code, list.present(this.params.workingLanguages(), defLang.value, true), c.display, this.params.langSummary()]);
              }
              msg(m);
              op.addIssue(new Issue(severity, 'invalid', addToPath(path, 'display'), baseMsg, m, 'invalid-display'));
            }
            if (prov.version() && mode != 'codeableConcept') {
              result.addParamStr('version', prov.version());
            }
          }
        }
      }
      i++;
    }

    // A required binding on a CodeableConcept is satisfied when ANY coding is in the value set, so
    // a coding whose code system could not be resolved must not veto a membership that another
    // coding has confirmed. It is still reported, but as a warning, and with a message that does
    // not read as though nothing could be validated (hapifhir/org.hl7.fhir.core#2272).
    if (issuePath === 'CodeableConcept' && matchedCodings.size > 0) {
      const notChecked = ['UNKNOWN_CODESYSTEM', 'UNKNOWN_CODESYSTEM_VERSION', 'UNKNOWN_CODESYSTEM_VERSION_NONE'];
      let j = 0;
      for (let c of code.coding || []) {
        if (!matchedCodings.has(j)) {
          let sysPath = issuePath + '.coding[' + j + '].system';
          for (let iss of op.jsonObj.issue || []) {
            let mid = (iss.extension || []).find(e => e.url === 'http://hl7.org/fhir/StructureDefinition/operationoutcome-message-id');
            if (iss.severity === 'error' && mid && notChecked.includes(mid.valueString) && (iss.expression || []).includes(sysPath)) {
              let was = iss.details.text;
              let now = this.worker.i18n.translate('UNKNOWN_CODESYSTEM_CODING_NOT_CHECKED', this.params.HTTPLanguages,
                [c.version ? c.system + '|' + c.version : c.system]);
              iss.severity = 'warning';
              iss.details.text = now;
              mid.valueString = 'UNKNOWN_CODESYSTEM_CODING_NOT_CHECKED';
              // the summary message is built from mt, so it has to say the same thing
              mt = mt.filter(t => t !== was);
              msg(now);
            }
          }
        }
        j++;
      }
    }

    // for an internally defined value set (CodeSystem validation), the code-system-level
    // message is preferred - but if nothing produced an error, this is the only
    // explanation there will be, so it can't be suppressed
    if (ok === false && (!this.valueSet.jsonObj.internallyDefined || !op.hasErrors())) {
      let mid, m, p;
      if (mode === 'codeableConcept') {
        mid = 'TX_GENERAL_CC_ERROR_MESSAGE';
        m = this.worker.i18n.translate('TX_GENERAL_CC_ERROR_MESSAGE', this.params.HTTPLanguages, [this.valueSet.vurlOrMsg]);
      } else {
        mid = 'None_of_the_provided_codes_are_in_the_value_set_one';
        m = this.worker.i18n.translate('None_of_the_provided_codes_are_in_the_value_set_one', this.params.HTTPLanguages, ['', this.valueSet.vurlOrMsg, codelist]);
      }

      if (mode === 'codeableConcept') {
        p = '';
      } else if (!issuePath) {
        p = 'code';
      } else if (issuePath !== 'CodeableConcept') {
        p = issuePath + '.code';
      } else if (code.codingCount === 1) {
        p = issuePath + '.coding[0].code';
      } else {
        p = issuePath;
      }

      if (op.addIssue(new Issue('error', 'code-invalid', p, mid, m, 'not-in-vs'))) {
        msg(m);
      }
      if (cause.value === 'null') {
        cause.value = 'unknown';
      }
    }

    // the answer, which is not the same as ok: a coding can be in the value set and still carry an
    // error of its own (an unknown version, say), and then the CodeableConcept is not valid
    let valid = ok === true && !op.hasErrors();
    result.addParamBool('result', valid);
    if (psys) {
      result.addParamUri('system', psys);
    } else if (ok === true && impliedSystem.value) {
      result.addParamUri('system', impliedSystem.value);
    } else if (tsys && mode !== 'codeableConcept') {
      result.addParamUri('system', tsys);
    }

    for (let us of unknownSystems) {
      if (ok === false) {
        result.addParamCanonical('x-unknown-system', us);
      } else if (!valid) {
        result.addParamCanonical('x-caused-by-unknown-system', us);
      }
      // if the CodeableConcept is valid, the unknown system caused nothing: neither parameter applies
    }
    if (normalForm.value) {
      result.addParamCode('normalized-code', normalForm.value);
    }

    if (pcode) {
      result.addParamCode('code', pcode);
    } else if (tcode && mode !== 'codeableConcept') {
      result.addParamCode('code', tcode);
    }
    if (pver) {
      result.addParamStr('version', pver);
    } else if (tver && mode !== 'codeableConcept') {
      result.addParamStr('version', tver);
    }

    if (pdisp && (pcode || (tcode && mode !== 'codeableConcept'))) {
      result.addParamStr('display', pdisp);
    }

    if (inactive.value) {
      result.addParamBool('inactive', inactive.value);
      if (vstatus.value && vstatus.value !== 'inactive') {
        result.addParamCode('status', vstatus.value);
      }
      let mpath = inactive.path;
      if (!mpath) {
        mpath = 'code';
      }
      let mid1 = "INACTIVE_CONCEPT_FOUND";
      let mm1 = "";
      if (!['inactive', 'DISCOURAGED'].includes(vstatus.value)) {
        mid1 = 'INACTIVE_CONCEPT_FOUND_ADD';
        mm1 = 'inactive';
      }
      let m = this.worker.i18n.translate(mid1, this.params.HTTPLanguages, [vstatus.value, tcode, mm1]);
      msg(m);
      op.addIssue(new Issue('warning', 'business-rule', mpath, 'INACTIVE_CONCEPT_FOUND', m, 'code-comment'));
    } else if (vstatus.value && vstatus.value.toLowerCase() === 'deprecated') {
      result.addParamCode('status', 'deprecated');
      let m = this.worker.i18n.translate('DEPRECATED_CONCEPT_FOUND', this.params.HTTPLanguages, [vstatus.value, tcode]);
      msg(m);
      op.addIssue(new Issue('warning', 'business-rule', issuePath, 'DEPRECATED_CONCEPT_FOUND', m, 'code-comment'));
    }
    for (let iss of op.issue || []) {
      if (iss.severity === 'error') {
        if (!mt.includes(iss.display)) {
          mt.push(iss.display);
        }
      }
    }
    op.listMissedErrors(mt);
    if (mt.length > 0) {
      mt.sort();
      result.addParamStr('message', toText(mt, '; '));
    }
    if (mode === 'codeableConcept') {
      result.addParam('codeableConcept', 'valueCodeableConcept', code);
    }
    if (op.hasIssues()) {
      result.addParamResource('issues', op.jsonObj);
    }
    return result;
  }

  async checkDisplays(list, defLang, c, msg, op, path) {
    let hd = list.hasDisplay(this.params.workingLanguages(), null, c.display, false, DisplayCheckingStyle.CASE_INSENSITIVE)
    if (!hd.found) {
      let baseMsg;
      let severity = this.dispWarning();
      if (list.userDefined) {
        baseMsg = 'Display_Name_Not_Fixed_use_Supplement';
        severity = 'information';
      } else if (hd.difference === DisplayDifference.Normalized) {
        baseMsg = 'Display_Name_WS_for__should_be_one_of__instead_of';
      } else {
        baseMsg = 'Display_Name_for__should_be_one_of__instead_of';
      }
      let dc = list.displayCount(this.params.workingLanguages(), null, true);
      let mid = baseMsg;
      if (severity !== 'information') {
        if (dc === 0) {
          severity = 'warning';
          dc = list.displayCount(this.params.workingLanguages(), null, false);
        }
      }

      let m, ds;
      if (dc === 0) {
        ds = await list.preferredDisplay(null);
        if (!ds) {
          m = this.worker.i18n.translate('NO_VALID_DISPLAY_AT_ALL', this.params.HTTPLanguages, [c.display, c.system, c.code]);
          mid = 'NO_VALID_DISPLAY_AT_ALL';
        } else {
          // no displays in the requested language(s): fall back to checking against the
          // displays + designations in the code system's default language, not just the
          // single preferred display (see tests validation-simple-*-good-language-none)
          let hdDef = list.hasDisplay(this.params.workingLanguages(), defLang.value, c.display, false, DisplayCheckingStyle.CASE_INSENSITIVE);
          if (hdDef.found) {
            m = this.worker.i18n.translate('NO_VALID_DISPLAY_FOUND_NONE_FOR_LANG_OK', this.params.HTTPLanguages, [c.display, c.system, c.code, this.params.langSummary(), ds]);
            mid = 'NO_VALID_DISPLAY_FOUND_NONE_FOR_LANG_OK';
            severity = 'information';
          } else {
            m = this.worker.i18n.translate('NO_VALID_DISPLAY_FOUND_NONE_FOR_LANG_ERR', this.params.HTTPLanguages, [c.display, c.system, c.code, this.params.langSummary(), ds]);
            mid = 'NO_VALID_DISPLAY_FOUND_NONE_FOR_LANG_ERR';
            if (this.params.displayWarning) {
              severity = 'warning';
            } else {
              severity = 'error';
            }
          }
        }
      } else if (dc === 1) {
        m = this.worker.i18n.translate(baseMsg + '_one', this.params.workingLanguages(),
          ['', c.system, c.code, list.present(this.params.workingLanguages(), defLang.value, dc > 0), c.display, this.params.langSummary()]);
      } else {
        m = this.worker.i18n.translate(baseMsg + '_other', this.params.workingLanguages(),
          [dc.toString(), c.system, c.code, list.present(this.params.workingLanguages(), defLang.value, dc > 0), c.display, this.params.langSummary()]);
      }
      msg(m);
      op.addIssue(new Issue(severity, 'invalid', addToPath(path, 'display'), mid, m, 'invalid-display'));
    } else {
      let hd = list.hasDisplay(this.params.workingLanguages(), null, c.display, false, DisplayCheckingStyle.CASE_INSENSITIVE);
      if (!hd.found) {
        let m, mid;
        if (list.source !== null && list.source.hasAnyDisplays(this.params.workingLanguages())) {
          mid = 'NO_VALID_DISPLAY_FOUND_LANG_SOME';
          m = this.worker.i18n.translatePlural(this.params.workingLanguages().length, 'NO_VALID_DISPLAY_FOUND_LANG_SOME', this.params.HTTPLanguages,
            [c.system, c.code, c.display, this.params.workingLanguages().toString(), c.display]);
        } else {
          mid = 'NO_VALID_DISPLAY_FOUND_LANG_NONE';
          m = this.worker.i18n.translatePlural(this.params.workingLanguages().length, 'NO_VALID_DISPLAY_FOUND_LANG_NONE', this.params.HTTPLanguages,
            [c.system, c.code, c.display, this.params.workingLanguages().toString(), c.display]);
        }
        op.addIssue(new Issue('information', 'invalid', addToPath(path, 'display'), mid, m, 'display-comment'));
      } else {
        let hd = list.hasDisplay(this.params.workingLanguages(), null, c.display, true, DisplayCheckingStyle.CASE_INSENSITIVE);
        if (!hd.found) {
          let ts2 = [];
          list.allowedDisplays(ts2, null, defLang.value);
          let mid = 'INACTIVE_DISPLAY_FOUND';
          let m = this.worker.i18n.translatePlural(ts2.length, mid, this.params.HTTPLanguages, [c.display, c.code, ts2.join(','), list.status(c.display)]);
          // The display IS a designation of this concept, just not a current one,
          // so lenient-display-validation decides whether that fails the code:
          // a warning (and result true) when lenient, an error when not - the
          // same rule the other display checks use.
          op.addIssue(new Issue(this.dispWarning(), 'invalid', addToPath(path, 'display'), mid, m, 'display-comment'));
        }
      }
    }
  }

  async checkSystemCode(issuePath, system, version, code) {
    this.worker.opContext.clearContexts();
    if (this.params.inferSystem) {
      this.worker.opContext.addNote(this.valueSet, 'Validate "' + code + '" and infer system', this.indentCount);
    } else {
      this.worker.opContext.addNote(this.valueSet, 'Validate "' + this.worker.renderer.displayCoded(system, version, code) + '"', this.indentCount);
    }
    let unknownSystems = new Set();
    let unkCodes = [];
    let messages = [];
    let result = new Parameters();
    let op = new OperationOutcome();
    this.checkCanonicalStatus(issuePath, op, this.valueSet, this.valueSet);
    let list = new Designations(this.worker.languages);
    let ver = {value: ''};
    let inactive = {value: false};
    let normalForm = {value: ''};
    let vstatus = {value: ''};
    let cause = {value: null};
    let contentMode = {value: null};
    let impliedSystem = {value: ''};
    let defLang = {value: null};

    let ok = await this.check(issuePath, system, version, code, true, list, unknownSystems, ver, inactive, normalForm, vstatus, cause, op, null, result, contentMode, impliedSystem, unkCodes, messages, defLang);
    if (ok === true) {
      result.AddParamBool('result', true);
      let pd = list.preferredDisplay(this.params.workingLanguages());
      if (pd) {
        result.addParamStr('display', pd);
      }
      result.addParamUri('system', system);
      if ((cause.value === 'not-found' && contentMode.value !== 'complete') || contentMode.value === 'example') {
        result.addParamStr('message', 'The system "' + system + ' was found but did not contain enough information to properly validate the code (mode = ' + contentMode.value + ')');
      }
      if (cause.value) {
        result.addParamCode('cause', cause.value);
      }
      if (inactive.value) {
        result.addParamBool('inactive', inactive.value);
        if (vstatus.value && vstatus.value !== 'inactive') {
          result.addParamCode('status', vstatus.value);
        }
        let msg = this.worker.i18n.translate('INACTIVE_CONCEPT_FOUND', this.params.HTTPLanguages, [vstatus.value, code]);
        messages.push(msg);
        op.addIssue(new Issue('warning', 'business-rule', 'code', 'INACTIVE_CONCEPT_FOUND', msg, 'code-comment'));
      } else if (vstatus.value && vstatus.value.toLowerCase() === 'deprecated') {
        result.addParamCode('status', vstatus.value);
        let msg = this.worker.i18n.translate('DEPRECATED_CONCEPT_FOUND', this.params.HTTPLanguages, [vstatus.value, code]);
        messages.push(msg);
        op.addIssue(new Issue('warning', 'business-rule', 'code', 'DEPRECATED_CONCEPT_FOUND', msg, 'code-comment'));
      }
    } else if (ok === null) {
      result.AddParamBool('result', false);
      result.addParamStr('message', 'The system "' + system + '" is unknown so the /"' + code + '" cannot be confirmed to be in the value set ' + this.valueSet.name);
      op.addIssue(new Issue('error', cause.value, 'code', null, 'The system "' + system + '" is unknown so the /"' + code + '" cannot be confirmed to be in the value set ' + this.valueSet.name, 'not-found'));
      for (let us of unknownSystems) {
        result.addParamCanonical('x-caused-by-unknown-system', us);
      }
    } else {
      result.AddParamBool('result', false);
      result.addParamStr('message', 'The system/code "' + system + '"/"' + code + '" is not in the value set ' + this.valueSet.name);
      op.addIssue(new Issue('error', cause.value, 'code', null, 'The system/code "' + system + '"/"' + code + '" is not in the value set ' + this.valueSet.name, 'not-in-vs'));
      if (cause.value) {
        result.AddParamCode('cause', cause.value);
      }
    }
    if (op.hasIssues()) {
      result.addParam('issues').resource = op.jsonObj;
    }
    return result;
  }

  /**
   * The code as submitted differs from the code as the code system renders it. Report why.
   *
   * Every such difference used to be reported as CODE_CASE_DIFFERENCE, which is where that
   * assumption came from - cs-lang, where the canonical form really does differ only in case.
   * It is not true in general. cs-snomed re-renders any postcoordinated expression through
   * renderExpression(Minimal), so every legal alternative serialisation (the optional comma
   * before an attribute group, whitespace, |terms|, attribute order) came back to the caller
   * as a complaint about their casing; ICD-11 normalises a URI to the code it denotes and did
   * the same. Neither has anything to do with case, and unlike case there is nothing the
   * caller did wrong - the submitted form is valid, it simply is not the normal form.
   *
   * So: case-only differences stay CODE_CASE_DIFFERENCE, everything else is
   * CODE_NOT_IN_NORMAL_FORM. Both are information severity (they were warning in one of the
   * two call sites and information in the other; every tx-ecosystem fixture expects
   * information).
   *
   * @returns {string} the message, for callers that also collect it into `messages`
   */
  addNormalisationIssue(op, path, code, normalised, cs) {
    const caseOnly = normalised.toLowerCase() === code.toLowerCase();
    const id = caseOnly ? 'CODE_CASE_DIFFERENCE' : 'CODE_NOT_IN_NORMAL_FORM';
    const csDesc = cs.version() ? cs.system() + '|' + cs.version() : cs.system();
    const msg = this.worker.i18n.translate(id, this.params.HTTPLanguages, [code, normalised, csDesc]);
    op.addIssue(new Issue('information', 'business-rule', addToPath(path, 'code'), id, msg, 'code-rule'));
    return msg;
  }

  async checkConceptSet(path, role, cs, cset, code, displays, vs, message, inactive, normalForm, vstatus, op, vcc, messages) {
    this.worker.opContext.addNote(vs, 'check code ' + role + ' ' + this.worker.renderer.displayValueSetInclude(cset) + ' at ' + path, this.indentCount);
    let result = false;
    if (!cset.concept && !cset.filter) {
      let loc = await cs.locate(code);
      result = false;
      if (loc.context == null) {
        this.worker.opContext.addNote(this.valueSet, 'Code "' + code + '" not found in ' + this.worker.renderer.displayCoded(cs)+": "+loc.message, this.indentCount);
        if (!this.params.membershipOnly && role !== 'not in') {
          if (cs.contentMode() !== 'complete') {
            op.addIssue(new Issue('warning', 'code-invalid', addToPath(path, 'code'), 'UNKNOWN_CODE_IN_FRAGMENT', this.worker.i18n.translate('UNKNOWN_CODE_IN_FRAGMENT', this.params.HTTPLanguages, [code, cs.system(), cs.version()]), 'invalid-code'));
            result = true;
          } else {
            op.addIssue(new Issue('error', 'code-invalid', addToPath(path, 'code'), cs.version() ? 'Unknown_Code_in_Version' : 'Unknown_Code_in',
              this.worker.i18n.translate(Unknown_Code_in_VersionSCT(cs.system(), cs.version()), this.params.HTTPLanguages, [code, cs.system(), cs.version(), SCTVersion(cs.system(), cs.version())]), 'invalid-code'));
          }
        }
        if (loc.message && op) {
          op.addIssue(new Issue('information', 'code-invalid', addToPath(path, 'code'), null, loc.message, 'invalid-code'));
        }
      } else {
        this.worker.opContext.addNote(this.valueSet, 'Code "' + code + '" found in ' + this.worker.renderer.displayCoded(cs), this.indentCount);
        const normalised = await cs.code(loc.context);
        if (normalised && normalised != code) {
          this.addNormalisationIssue(op, path, code, normalised, cs);
          normalForm.value = normalised;
        }
        let msg = await cs.incompleteValidationMessage(loc.context, this.params.HTTPLanguages);
        if (msg) {
          op.addIssue(new Issue('information', 'informational', addToPath(path, 'code'), null, msg, 'process-note'));
        }
        await this.worker.listDisplaysFromCodeSystem(displays, cs, loc.context);

        if (!(this.params.abstractOk || !(await cs.isAbstract(loc.context)))) {
          this.worker.opContext.addNote(this.valueSet, 'Code "' + code + '" found in ' + this.worker.renderer.displayCoded(cs) + ' but is abstract', this.indentCount);
          if (!this.params.membershipOnly && role !== 'not in') {
            op.addIssue(new Issue('error', 'business-rule', addToPath(path, 'code'), 'ABSTRACT_CODE_NOT_ALLOWED', this.worker.i18n.translate('ABSTRACT_CODE_NOT_ALLOWED', this.params.HTTPLanguages, [cs.system(), code]), 'code-rule'));
          }
        } else if (this.excludeInactives() && await cs.isInactive(loc.context)) {
          this.worker.opContext.addNote(this.valueSet, 'Code "' + code + '" found in ' + this.worker.renderer.displayCoded(cs) + ' but is inactive', this.indentCount);
          if (role !== 'not in') {
            let msg = this.worker.i18n.translate('STATUS_CODE_WARNING_CODE', this.params.HTTPLanguages, ['not active', code]);
            op.addIssue(new Issue('error', 'business-rule', addToPath(path, 'code'), 'STATUS_CODE_WARNING_CODE', msg, 'code-rule'));
            messages.push(msg);
          }
          result = false;
          if (!this.params.membershipOnly && role !== 'not in') {
            inactive.value = true;
            inactive.path = path;
            if (inactive.value) {
              vstatus.value = await cs.getStatus(loc.context);
            }
          }
        } else if (this.params.activeOnly && await cs.isInactive(loc.context)) {
          this.worker.opContext.addNote(this.valueSet, 'Code "' + code + '" found in ' + this.worker.renderer.displayCoded(cs) + ' but is inactive', this.indentCount);
          result = false;
          if (role !== 'not in') {
            inactive.value = true;
            inactive.path = path;
            vstatus.value = await cs.getStatus(loc.context);
            let msg = this.worker.i18n.translate('STATUS_CODE_WARNING_CODE', this.params.HTTPLanguages, ['not active', code]);
            messages.push(msg);
            op.addIssue(new Issue('error', 'business-rule', addToPath(path, 'code'), 'STATUS_CODE_WARNING_CODE', msg, 'code-rule'));
          }
        } else {
          result = true;
          if (role !== 'not in') {
            inactive.value = await cs.isInactive(loc.context);
            inactive.path = path;
            vstatus.value = await cs.getStatus(loc.context);
            if (vcc !== null) {
              if (!vcc.coding) {
                vcc.coding = [];
              }
              vcc.coding.push({
                system: cs.system(),
                version: cs.version(),
                code: await cs.code(loc.context),
                display: displays.preferredDisplay(this.params.workingLanguages())
              });
            }
          }
          return result;
        }
      }
    }

    for (let cc of cset.concept || []) {
      this.worker.deadCheck('checkConceptSet#1');
      let c = cc.code;
      if (code === c) {
        let loc = await cs.locate(code);
        if (loc.context !== null) {
          loc = loc.context;
          this.worker.opContext.addNote(this.valueSet, 'Code "' + code + '" found in ' + this.worker.renderer.displayCoded(cs), this.indentCount);
          await this.worker.listDisplaysFromCodeSystem(displays, cs, loc);
          this.worker.listDisplaysFromIncludeConcept(displays, cc, vs);
          if (!(this.params.abstractOk || !(await cs.isAbstract(loc)))) {
            if (!this.params.membershipOnly) {
              op.addIssue(new Issue('error', 'business-rule', addToPath(path, 'code'), 'ABSTRACT_CODE_NOT_ALLOWED', this.worker.i18n.translate('ABSTRACT_CODE_NOT_ALLOWED', this.params.HTTPLanguages, [cs.system(), code]), 'code-rule'));
            }
          } else if (this.excludeInactives() && await cs.isInactive(loc)) {
            result = false;
            if (!this.params.membershipOnly) {
              inactive.value = true;
              inactive.path = path;
              vstatus.value = await cs.getStatus(loc);
            }
          } else {
            if (vcc !== null) {
              if (!vcc.coding)  {vcc.coding = [];}
              vcc.coding.push({system: cs.system(), version: cs.version(), code: await cs.code(loc), display: displays.preferredDisplay(this.params.workingLanguages())});
            }
            let sstatus = Extensions.readString(cc, 'http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status');
            if (['withdrawn', 'deprecated'].includes(sstatus)) {
              op.addIssue(new Issue('warning', 'business-rule', addToPath(path, 'code'), 'CONCEPT_DEPRECATED_IN_VALUESET', this.worker.i18n.translate('CONCEPT_DEPRECATED_IN_VALUESET', this.params.HTTPLanguages, [cs.system(), code, sstatus, vs.vurl]), 'code-comment'));
            } else if (Extensions.has(cc,'http://hl7.org/fhir/StructureDefinition/valueset-deprecated')) {
              op.addIssue(new Issue('warning', 'business-rule', addToPath(path, 'code'), 'CONCEPT_DEPRECATED_IN_VALUESET', this.worker.i18n.translate('CONCEPT_DEPRECATED_IN_VALUESET', this.params.HTTPLanguages, [cs.system(), code, 'deprecated', vs.vurl]), 'code-comment'));
            }
            inactive.value = await cs.isInactive(loc);
            inactive.path = path;
            vstatus.value = await cs.getStatus(loc);
            result = true;
            return result;
          }
        } else {
          this.worker.opContext.addNote(this.valueSet, 'Code "' + code + '" in concept list, but not found in ' + this.worker.renderer.displayCoded(cs)+": "+loc.message, this.indentCount);
        }
      }
    }

    if (cset.filter) {
      let cfl = cset.filter;
      let prep = await cs.getPrepContext(false);
      for (let fc of cfl) {
        this.worker.deadCheck('checkConceptSet#2');
        if (!fc.value) {
          throw new Issue('error', 'invalid', null, 'UNABLE_TO_HANDLE_SYSTEM_FILTER_WITH_NO_VALUE', this.worker.i18n.translate('UNABLE_TO_HANDLE_SYSTEM_FILTER_WITH_NO_VALUE', this.params.HTTPLanguages, [cs.system(), fc.property, fc.op]));
        }
        await cs.filter(prep, false, fc.property, fc.op, fc.value, (vs && vs.isCached) ? fc : null);
        // if (f === null) {
        //   throw new Issue('error', 'not-supported', null, 'FILTER_NOT_UNDERSTOOD', this.worker.i18n.translate('FILTER_NOT_UNDERSTOOD', this.params.HTTPLanguages, [fc.property, fc.op, fc.value, vs.vurl, cs.system()]) + ' (2)', 'vs-invalid');
        // }
      }
      let filters = await cs.executeFilters(prep);
      if (!filters || filters.length == 0) {
        throw new Error("executing filters failed for " + cs.name());
      }
      let loc = await cs.filterLocate(prep, filters[0], code);
      if (loc != null && !(typeof loc === 'string') && filters.length > 1) {
        for (let i = 1; i < filters.length; i++) {
          if (!(await cs.filterCheck(prep, filters[i], loc))) {
            loc = null;
            break;
          }
        }
      }
      if (loc != null && !(typeof loc === 'string')) {
        await this.worker.listDisplaysFromCodeSystem(displays, cs, loc);
        if (!(this.params.abstractOk || !(await cs.isAbstract(loc)))) {
          this.worker.opContext.addNote(this.valueSet, 'Filter ' + this.filterSummary(cset) + ': Code "' + code + '" found in ' + this.worker.renderer.displayCoded(cs) + ' but is abstract', this.indentCount);
          if (!this.params.membershipOnly) {
            op.addIssue(new Issue('error', 'business-rule', addToPath(path, 'code'), 'ABSTRACT_CODE_NOT_ALLOWED', this.worker.i18n.translate('ABSTRACT_CODE_NOT_ALLOWED', this.params.HTTPLanguages, [cs.system(), code]), 'code-rule'));
          }
        } else if (this.excludeInactives() && await cs.isInactive(loc)) {
          result = false;
          this.worker.opContext.addNote(this.valueSet, 'Filter ' + this.filterSummary(cset) + ': Code "' + code + '" found in ' + this.worker.renderer.displayCoded(cs) + ' but is inactive', this.indentCount);
          if (!this.params.membershipOnly) {
            inactive.value = true;
            inactive.path = path;
            vstatus.value = await cs.getStatus(loc);
          }
        } else {
          this.worker.opContext.addNote(this.valueSet, 'Filter ' + this.filterSummary(cset) + ': Code "' + code + '" found in ' + this.worker.renderer.displayCoded(cs), this.indentCount);
          if (vcc !== null) {
            if (!vcc.coding) { vcc.coding = []}
            vcc.coding.push( { system : cs.system(), version: cs.version(), code: await cs.code(loc), display: displays.preferredDisplay(this.params.workingLanguages())});
          }
          if (role !== 'not in' && !inactive.value) {
            if (await cs.isInactive(loc)) {
              inactive.value = true;
              inactive.path = path;
              // only replace a status we already have with a real one - a filter context
              // doesn't always carry the status (SNOMED, LOINC), and the assembly reads
              // vstatus for the message wording as well as for the status parameter
              const st = await cs.getStatus(loc);
              if (st) {
                vstatus.value = st;
              }
            }
          }
          result = true;
          return result;
        }
      } else if (loc != null) {
        this.worker.opContext.addNote(this.valueSet, 'Filter ' + this.filterSummary(cset) + ': Code "' + code + '" not found in ' + this.worker.renderer.displayCoded(cs)+ ": "+loc, this.indentCount);
        messages.push(loc);
      } else {
        this.worker.opContext.addNote(this.valueSet, 'Filter ' + this.filterSummary(cset) + ': Code "' + code + '" not found in ' + this.worker.renderer.displayCoded(cs), this.indentCount);
      }
    }
    return result;
  }

  async checkExpansion(path, cs, cset, code, displays, vs, message, inactive, vstatus, op) {
    let result = false;
    let loc = await cs.locate(code, null, message);
    result = false;
    if (loc === null || loc.context == null) {
      if (!this.params.membershipOnly) {
        op.addIssue(new Issue('error', 'code-invalid', addToPath(path, 'code'), 'Unknown_Code_in_Version',
          this.worker.i18n.translate(Unknown_Code_in_VersionSCT(cs.system(), cs.version()), this.params.HTTPLanguages, [code, cs.system(), cs.version(), SCTVersion(cs.system(), cs.version())]), 'invalid-code'));
      }
    } else if (!(this.params.abstractOk || !(await cs.isAbstract(loc.context)))) {
      if (!this.params.membershipOnly) {
        op.addIssue(new Issue('error', 'business-rule', addToPath(path, 'code'), 'ABSTRACT_CODE_NOT_ALLOWED', this.worker.i18n.translate('ABSTRACT_CODE_NOT_ALLOWED', this.params.HTTPLanguages, [cs.system(), code]), 'code-rule'));
      }
    } else {
      result = true;
      inactive.value = await cs.isInactive(loc.context);
      inactive.path = path;
      vstatus.value = await cs.getStatus(loc.context);
      await this.worker.listDisplaysFromCodeSystem(displays, cs, loc.context);
      return result;
    }
    return result;
  }


  excludeInactives() {
    return this.valueSet.jsonObj.compose && this.valueSet.jsonObj.compose.inactive != undefined && !this.valueSet.jsonObj.compose.inactive;
  }

  filterSummary(cset) {
    let list = [];
    for (let filter of cset.filter) {
      let s = cset.filter.length > 1 ? "(" : "";
      s = filter.property+" "+filter.op+" "+filter.value;
      s = s + (cset.filter.length > 1 ? ")" : "");
      list.push(s)
    }
    return list.join(",");
  }

  findVSVersionForSystem(system) {
    let set = new Set();
    for (let inc of this.valueSet.jsonObj.compose?.include || []) {
      if (inc.system == system && inc.version) {
        set.add(inc.version);
      }
    }
    let v = null;
    for (let t of set) {
      if (!v || VersionUtilities.compareVersionsGeneral(t, v) > 0) {
        v = t;
      }
    }
    return v;
  }

  async pickApplicableVersion(vset, system, code, display) {
    let found = [];
    for (let v of vset) {
      let cs = await this.worker.findCodeSystem(system, v, this.params, ["complete", "fragment"], null, true, true, false, this.worker.requiredSupplements);
      if (cs != null) {
        let loc = await cs.locate(code);
        if (loc.context) {
          if (!display || await this.displayIsOk(cs, loc.context, display)) {
            found.push(v);
          }
        }
      }
    }
    // if it was found in none or all of them, we don't do anything
    if (found.length == vset.size) {
      return undefined;
    }
    if (found.length > 0) {
      let sorted = found.sort((a, b) => -VersionUtilities.compareVersionsGeneral(a, b));
      return sorted[0];
    } else { // well, none of them, we'll go with the latest
      let sorted = [...vset].sort((a, b) => -VersionUtilities.compareVersionsGeneral(a, b));
      return sorted[0];
    }
  }

  async displayIsOk(cs, context, display) {
    if (display == await cs.display(context)) {
      return true;
    }
    const cds = new Designations(this.worker.i18n.languageDefinitions);
    await cs.designations(context, cds);
    return cds.designations.find(cd => cd.value == display);
  }

  hasMatchForVersion(includes, version) {
    for (let inc of includes) {
      if (inc.version == version) {
        return true;
      }
    }
    return false;
  }

  useThisVersion(cc, version) {
    if (!version || cc.version == version) {
      return true;
    }
    return !this.hasMatchForVersion(this.valueSet.jsonObj.compose.include || [], version);
  }
}

function addToPath(path, name) {
  if (!path) {
    return name;
  } else {
    return path + '.' + name;
  }
}




function toText(st, sep) {
  if (st === null || st.length === 0) {
    return '';
  } else {
    let result = st[0];
    for (let i = 1; i < st.length; i++) {
      result = result + sep + st[i];
    }
    return result;
  }
}

class ValidateWorker extends TerminologyWorker {

  requiredSupplements = new Set();
  usedSupplements = new Set();
  /**
   * @param {OperationContext} opContext - Operation context
   * @param {Logger} log - Logger instance
   * @param {Provider} provider - Provider for code systems and resources
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
    return 'validate-code';
  }

  // ========== Entry Points ==========

  /**
   * Handle a type-level CodeSystem $validate-code request
   * GET/POST /CodeSystem/$validate-code
   */
  async handleCodeSystem(req, res) {
    try {
      const params = this.buildParameters(req);
      this.addHttpParams(req, params);
      this.log.debug('CodeSystem $validate-code with params:', params);

      let result = await this.handleCodeSystemInner(params);

      return res.status(200).json(result);

    } catch (error) {
      this.log.error(error);
      debugLog(error);
      if (error instanceof Issue) {
        if (error.isHandleAsOO()) {
          let oo = new OperationOutcome();
          oo.addIssue(error);
          return res.status(error.statusCode || 500).json(oo.jsonObj);
        } else {
          // this is actually handled in the inner method
        }
      } else {
        return res.status(error.statusCode || 500).json(outcomeFromError(error));
      }

    }
  }

  async handleCodeSystemInner(params, req) {
    let coded;
    let mode;

    // Handle tx-resource and cache-id parameters
    this.setupAdditionalResources(params);

    let txp = new TxParameters(this.languages, this.i18n, true);
    txp.readParams(params);
    for (const item of txp.supplements) this.requiredSupplements.add(item);

    try {

      // Extract coded value
      mode = {mode: null};
      coded = this.extractCodedValue(params, true, mode);
      if (!coded) {
        throw new Issue('error', 'invalid', null, null, 'Unable to find code to validate (looked for coding | codeableConcept | code in parameters)', null, 400).handleAsOO(400);
      }

      // Get the CodeSystem - from parameter or by url
      const codeSystem = await this.resolveCodeSystem(params, txp, coded?.coding?.[0] ?? null, mode);
      if (!codeSystem) {
        if (!coded?.coding?.[0].system) {
          let msg = this.i18n.translate('Coding_has_no_system__cannot_validate', txp.HTTPLanguages, []);
          throw new Issue('warning', 'invalid', mode.issuePath, 'Coding_has_no_system__cannot_validate', msg, 'invalid-data');
        } else {
          throw new Issue('error', 'invalid', null, null, 'No CodeSystem specified - provide url parameter or codeSystem resource', null, 400);
        }
      }
      if (codeSystem.contentMode() == 'supplement') {
        throw new Issue('error', 'invalid', this.systemPath(mode), 'CODESYSTEM_CS_NO_SUPPLEMENT', this.opContext.i18n.translate('CODESYSTEM_CS_NO_SUPPLEMENT', txp.HTTPLanguages, [codeSystem.vurl()]), "invalid-data", 400);
      }

      // Perform validation
      const result = await this.doValidationCS(coded, codeSystem, txp, mode);
      if (req) {
        req.logInfo = this.usedSources.join("|") + txp.logInfo();
      }
      return result;
    } catch (error) {
      this.log.error(error);
      debugLog(error);
      if (error instanceof Issue && !error.isHandleAsOO()) {
        return await this.handlePrepareError(error, coded, mode.mode, txp);
      } else {
        throw error;
      }

    }


  }
  systemPath(mode) {
    switch (mode.mode) {
      case 'code': return 'system';
      case 'coding': return 'Coding.system';
      default: return 'CodeableConcept.coding[0].system';
    }
  }

  /**
   * Handle an instance-level CodeSystem $validate-code request
   * GET/POST /CodeSystem/{id}/$validate-code
   */
  async handleCodeSystemInstance(req, res) {
    try {
      const {id} = req.params;
      const params = this.buildParameters(req);
      this.log.debug(`CodeSystem/${id}/$validate-code with params:`, params);

      // Handle tx-resource and cache-id parameters
      this.setupAdditionalResources(params);

      let txp = new TxParameters(this.languages, this.i18n, true);
      txp.readParams(params);
      for (const item of txp.supplements) this.requiredSupplements.add(item);

      // Get the CodeSystem by id
      const codeSystem = await this.provider.getCodeSystemById(this.opContext, id);
      if (!codeSystem) {
        return res.status(422).json(this.operationOutcome('error', 'not-found',
          `CodeSystem/${id} not found`));
      }
      const csp = new FhirCodeSystemProvider(this.opContext, new CodeSystem(codeSystem), []);

      // Extract coded value
      let mode = { mode : null }
      const coded = this.extractCodedValue(params, true, mode);
      if (!coded) {
        return res.status(400).json(this.operationOutcome('error', 'invalid',
          'Unable to find code to validate (looked for coding | codeableConcept | code in parameters =codingX:Coding)'));
      }

      // Perform validation
      const result = await this.doValidationCS(coded, csp, txp, mode);
      req.logInfo = this.usedSources.join("|") + txp.logInfo();
      return res.json(result);

    } catch (error) {
      this.log.error(error);
      debugLog(error);
      return res.status(error.statusCode || 500).json(outcomeFromError(error));
    }
  }

  /**
   * Handle a type-level ValueSet $validate-code request
   * GET/POST /ValueSet/$validate-code
   */
  async handleValueSet(req, res) {
    try {
      const params = this.buildParameters(req);
      this.addHttpParams(req, params);
      this.log.debug('ValueSet $validate-code with params:', params);

      const result = await this.handleValueSetInner(params, req);
      return res.json(result);

    } catch (error) {
      this.log.error(error);
      debugLog(error);
      if (error instanceof Issue) {
        let op = new OperationOutcome();
        op.addIssue(error);
        return res.status(error.statusCode || 500).json(op.jsonObj);
      } else {
        return res.status(error.statusCode || 500).json(outcomeFromError(error));
      }
    }
  }

  async handleValueSetInner(params, req) {
    // Handle tx-resource and cache-id parameters
    this.setupAdditionalResources(params);

    let txp = new TxParameters(this.languages, this.i18n, true);
    txp.readParams(params);
    for (const item of txp.supplements) this.requiredSupplements.add(item);

    // Get the ValueSet - from parameter or by url
    const valueSet = await this.resolveValueSet(params, txp);
    if (!valueSet) {
      throw new Issue("error", "invalid", null, null, 'No ValueSet specified - provide url parameter or valueSet resource', null, 400);
    }
    // Extract coded value

    let mode = { mode : null };
    const coded = this.extractCodedValue(params, false, mode);
    if (!coded) {
      throw new Issue("error", "invalid", null, null, 'Unable to find code to validate (looked for coding | codeableConcept | code+system | code+inferSystem in parameters', null, 422);
    }

    // Perform validation
    let res = await this.doValidationVS(coded, valueSet, txp, mode.mode, mode.issuePath);
    if (req) {
      req.logInfo = this.usedSources.join("|") + txp.logInfo();
    }
    return res;
  }
  /**
   * Handle an instance-level ValueSet $validate-code request
   * GET/POST /ValueSet/{id}/$validate-code
   */
  async handleValueSetInstance(req, res) {
    try {
      const {id} = req.params;
      const params = this.buildParameters(req);
      this.log.debug(`ValueSet/${id}/$validate-code with params:`, params);

      // Handle tx-resource and cache-id parameters
      this.setupAdditionalResources(params);

      let txp = new TxParameters(this.languages, this.i18n, true);
      txp.readParams(params);
      for (const item of txp.supplements) this.requiredSupplements.add(item);

      // Get the ValueSet by id
      const valueSet = await this.provider.getValueSetById(this.opContext, id);
      this.seeSourceVS(valueSet, id);
      if (!valueSet) {
        return res.status(422).json(this.operationOutcome('error', 'not-found',
          `ValueSet/${id} not found`));
      }

      // Extract coded value
      let mode = { mode : null };
      const coded = this.extractCodedValue(params, false, mode);
      if (!coded) {
        return res.status(400).json(this.operationOutcome('error', 'invalid',
          'Unable to find code to validate (looked for coding | codeableConcept | code in parameters =codingX:Coding)'));
      }

      // Perform validation
      const result = await this.doValidationVS(coded, valueSet, txp, mode.mode, mode.issuePath);
      req.logInfo = this.usedSources.join("|")+txp.logInfo();
      return res.json(result);

    } catch (error) {
      this.log.error(error);
      debugLog(error);
      return res.status(error.statusCode || 500).json(outcomeFromError(error));
    }
  }

  // ========== Resource Resolution ==========

  /**
   * Resolve the CodeSystem to validate against
   * @param {Object} params - Parameters resource
   * @param {string|null} id - Instance id (if instance-level request)
   * @returns {CodeSystemProvider|null} CodeSystem resource (wrapper or JSON)
   */
  async resolveCodeSystem(params, txParams, coded, mode) {
    // Check for codeSystem resource parameter
    const csResource = this.getResourceParam(params, 'codeSystem');
    if (csResource) {
      return new FhirCodeSystemProvider(this.opContext, new CodeSystem(csResource), []); // todo: supplements
    }
    let path = coded == null ? null : mode.issuePath+".system";
    let fromCoded = false;
    // Check for url parameter
    let url = this.getStringParam(params, 'url');
    if (!url && coded.system) {
      fromCoded = true;
      url = coded.system;
    }
    if (!url) {
      return null;
    }

    let issue = null;
    if (!isAbsoluteUrl(url)) {
      let m = this.i18n.translate('Terminology_TX_System_Relative', txParams.HTTPLanguages, [url]);
      issue = new Issue('error', 'invalid', path, 'Terminology_TX_System_Relative', m, 'invalid-data');
    }

    let version = this.getStringParam(params, 'version');
    if (!version && fromCoded) {
      version = coded.version;
    }
    version = this.determineVersionBase(url, version, txParams);

    let supplements = this.loadSupplements(url, version, this.requiredSupplements);

    // First check additional resources
    const fromAdditional = this.findInAdditionalResources(url, version, 'CodeSystem', false);
    if (fromAdditional) {
      return this.provider.createCodeSystemProvider(this.opContext, fromAdditional, supplements);
    } else {

      let csp = await this.provider.getCodeSystemProvider(this.opContext, url, version, supplements);
      if (csp) {
        return csp;
      } else {
        let vs = await this.findValueSet(url, version, null);
        if (vs) {
          let msg = this.i18n.translate('Terminology_TX_System_ValueSet2', txParams.HTTPLanguages, [url]);
          throw new Issue('error', 'invalid', path, 'Terminology_TX_System_ValueSet2', msg, 'invalid-data');
        } else if (version) {
          let vl = await this.listVersions(url);
          if (vl.length == 0) {
            throw new Issue("error", "not-found", this.systemPath(mode), 'UNKNOWN_CODESYSTEM_VERSION_NONE', this.opContext.i18n.translate('UNKNOWN_CODESYSTEM_VERSION_NONE', this.opContext.HTTPLanguages, [url, version]), 'not-found', 422).setUnknownSystem(url).addIssue(issue);
          } else {
            throw new Issue("error", "not-found", this.systemPath(mode), 'UNKNOWN_CODESYSTEM_VERSION', this.opContext.i18n.translate('UNKNOWN_CODESYSTEM_VERSION', this.opContext.HTTPLanguages, [url, version, this.presentVersionList(vl)], 422), 'not-found').setUnknownSystem(url + "|" + version).addIssue(issue);
          }
        } else {
          throw new Issue("error", "not-found", this.systemPath(mode), 'UNKNOWN_CODESYSTEM', this.opContext.i18n.translate('UNKNOWN_CODESYSTEM', this.opContext.HTTPLanguages, [url]), 'not-found', 422).setUnknownSystem(url).addIssue(issue);
        }
      }
    }
  }

  /**
   * Resolve the ValueSet to validate against
   * @param {Object} params - Parameters resource
   * @param {string|null} id - Instance id (if instance-level request)
   * @returns {Object|null} ValueSet resource (wrapper or JSON)
   */
  async resolveValueSet(params, txParams) {
    // Check for valueSet resource parameter
    const vsResource = this.getResourceParam(params, 'valueSet');
    if (vsResource) {
      this.seeSourceVS(vsResource);
      return new ValueSet(vsResource);
    }

    // Check for url parameter
    const url = this.getStringParam(params, 'url');
    if (url) {
      const version = this.determineVersionBase(url, this.getStringParam(params, 'valueSetVersion'), txParams);

      // First check additional resources
      const fromAdditional = this.findInAdditionalResources(url, version, 'ValueSet', false);
      if (fromAdditional) {
        return fromAdditional;
      }

      let vs = await this.provider.findValueSet(this.opContext, url, version);
      this.seeSourceVS(vs, url);
      if (vs == null) {
        throw new Issue('error', 'not-found', null, 'Unable_to_resolve_value_Set_', this.i18n.translate('Unable_to_resolve_value_Set_', params.HTTPLanguages, [url+(version ? "|"+version : "")]), 'not-found', 422);
      } else {
        return vs;
      }
    }

    return null;
  }

  // ========== Coded Value Extraction ==========

  /**
   * Extract the coded value to validate as a CodeableConcept
   * @param {Object} params - Parameters resource
   * @param {string} mode - 'cs' for CodeSystem, 'vs' for ValueSet
   * @returns {Object|null} CodeableConcept or null
   */
  extractCodedValue(params, isCs, mode) {
    // Priority 1: codeableConcept parameter
    const cc = this.getCodeableConceptParam(params, 'codeableConcept');
    if (cc) {
      mode.mode = 'codeableConcept';
      mode.issuePath = "CodeableConcept";
      return cc;
    }

    // Priority 2: coding parameter
    const coding = this.getCodingParam(params, 'coding');
    if (coding) {
      mode.mode = 'coding';
      mode.issuePath = "Coding";
      return {coding: [coding]};
    }

    // Priority 3: individual parameters (code required)
    const code = this.getStringParam(params, 'code');
    if (code) {
      mode.mode = 'code';
      mode.issuePath = "";
      // For CodeSystem mode: url/version
      // For ValueSet mode: system/systemVersion
      let system, version;
      if (isCs) {
        system = this.getStringParam(params, 'url');
        if (!system) {
          system = this.getStringParam(params, 'system');

        }
        version = this.getStringParam(params, 'version');
      } else {
        system = this.getStringParam(params, 'system');
        version = this.getStringParam(params, 'systemVersion');
      }
      const display = this.getStringParam(params, 'display');

      if (!system && !this.getStringParam(params, 'inferSystem')) {
        return null;
      }
      const codingObj = {code};
      if (system) codingObj.system = system;
      if (version) codingObj.version = version;
      if (display) codingObj.display = display;

      return {coding: [codingObj]};
    }

    return null;
  }

  // ========== Validation Logic ==========

  /**
   * Perform CodeSystem validation
   * @param {Object} coded - CodeableConcept to validate
   * @param {Object} codeSystem - CodeSystem to validate against
   * @param {Object} params - Full parameters
   * @returns {Object} Parameters resource with result
   */
  async doValidationCS(coded, codeSystem, params, mode) {
    this.deadCheck('doValidationCS');
    this.params = params;

    let vs = this.makeVsForCS(codeSystem);

    // Create and prepare checker
    const checker = new ValueSetChecker(this, vs, params);

    // Perform validation
    const result = await checker.checkCodeableConcept(mode.issuePath, coded, mode.mode);

    // Add diagnostics if requested
    if (params.diagnostics) {
      result.jsonObj.parameter.push({name: 'diagnostics', valueString: this.opContext.diagnostics()});
    }

    return result.jsonObj;
  }

  makeVsForCS(codeSystem) {
    let vs = {
      resourceType: "ValueSet",
      internallyDefined : true,
      status: 'active',
      url : codeSystem.valueSet() ? codeSystem.valueSet() : codeSystem.system()+"/vs",
      compose : {
        "include" : [{
          system: codeSystem.system()
        }]
      }
    }
    if (codeSystem.version()) {
      vs.version = codeSystem.version();
      vs.compose.include[0].version = codeSystem.version();
    }
    return new ValueSet(vs);
  }

  /**
   * Perform ValueSet validation
   * @param {Object} coded - CodeableConcept to validate
   * @param {Object} valueSet - ValueSet to validate against
   * @param {Object} params - Full parameters
   * @returns {Object} Parameters resource with result
   */
  async doValidationVS(coded, valueSet, params, mode, issuePath) {
    this.deadCheck('doValidationVS');
    this.params = params;

    for (let ext of Extensions.list(valueSet.jsonObj, 'http://hl7.org/fhir/StructureDefinition/valueset-supplement')) {
      this.requiredSupplements.add(getValuePrimitive(ext));
    }

    // Create and prepare checker
    const checker = new ValueSetChecker(this, valueSet, params);
    try {
      await checker.prepare();
    } catch (error) {
      this.log.error(error);
      debugLog(error);
      if (!(error instanceof Issue) || error.isHandleAsOO()) {
        throw error;
      } else {
        return await this.handlePrepareError(error, coded, mode, params);
      }
    }

    // Perform validation
    const result = await checker.checkCodeableConcept(issuePath, coded, mode);

    // Add diagnostics if requested
    if (params.diagnostics) {
      result.jsonObj.parameter.push({name: 'diagnostics', valueString: this.opContext.diagnostics()});
    }

    return result.jsonObj;
  }

  /**
   * Get a boolean parameter value
   * @private
   */
  _getBoolParam(params, name, defaultValue) {
    if (!params?.parameter) return defaultValue;
    const p = params.parameter.find(param => param.name === name);
    if (!p) return defaultValue;
    if (p.valueBoolean !== undefined) return p.valueBoolean;
    if (p.valueString !== undefined) return p.valueString === 'true';
    return defaultValue;
  }

  // /**
  //  * Find a ValueSet by URL
  //  * @param {string} url - ValueSet URL
  //  * @param {string} [version] - ValueSet version
  //  * @returns {Object|null} ValueSet resource or null
  //  */
  // async findValueSet(url, version = null) {
  //   // First check additional resources
  //   const found = this.findInAdditionalResources(url, version || '', 'ValueSet', false);
  //   if (found) {
  //     return found;
  //   }
  //
  //   // Then check provider
  //   return await this.provider.findValueSet(this.opContext, url, version);
  // }

  /**
   * Get display text for a code (stub implementation for doValidationCS)
   * @private
   */
  getDisplayForCode(code) {
    const displays = {
      'male': 'Male',
      'female': 'Female',
      'unknown': 'Unknown',
      'other': 'Other'
    };
    return displays[code] || code;
  }

  /**
   * Build the validation result Parameters resource
   */
  buildValidationResult(result, message, display, coded) {
    const parameters = {
      resourceType: 'Parameters',
      parameter: [
        {name: 'result', valueBoolean: result}
      ]
    };

    if (message) {
      parameters.parameter.push({name: 'message', valueString: message});
    }

    if (display && result) {
      parameters.parameter.push({name: 'display', valueString: display});
    }

    // Include the code that was validated
    if (coded.coding && coded.coding.length > 0) {
      const coding = coded.coding[0];
      if (coding.code) {
        parameters.parameter.push({name: 'code', valueCode: coding.code});
      }
      if (coding.system) {
        parameters.parameter.push({name: 'system', valueUri: coding.system});
      }
      if (coding.version) {
        parameters.parameter.push({name: 'version', valueString: coding.version});
      }
    }

    return parameters;
  }

  /**
   * Build an OperationOutcome
   */
  operationOutcome(severity, code, message, txIssueType = null) {
    // the shared builder, so that every outcome has details.text and a tx-issue-type coding
    return buildOperationOutcome(severity, code, message, txIssueType);
  }


  async handlePrepareError(error, coded, mode, txp) {
    let op = new OperationOutcome();
    op.addIssue(error);
    let p = new Parameters();
    p.addParamResource('issues', op.jsonObj);
    p.addParamBool('result', false);
    p.addParamStr('message', error.message);
    if (!mode || !coded) {
      // nothing to add
    } else if (mode == 'codeableConcept') {
      p.addParam('codeableConcept', 'valueCodeableConcept', coded);
    } else if (coded.coding) {
      if (coded.coding[0].system) {
        p.addParamUri('system', coded.coding[0].system)
      }
      if (coded.coding[0].version) {
        p.addParamStr('version', coded.coding[0].version)
      } else if (coded.coding[0].system) {
        try {
          let cs = await this.findCodeSystem(coded.coding[0].system, null, txp);
          if (cs && cs.version()) {
            p.addParamStr('version', cs.version());
          }
        } catch (e) {
          // nothing. not interested.
        }
      }
      if (coded.coding[0].code) {
        p.addParamCode('code', coded.coding[0].code)
      }
    }
    if (error.unknownSystem) {
      p.addParamCanonical("x-caused-by-unknown-system", error.unknownSystem);
    }
    return p.jsonObj;
  }

  isValidating() {
    return true;
  }

}

module.exports = {
  ValidateWorker,
  ValueSetChecker,
  ValidationCheckMode,
};