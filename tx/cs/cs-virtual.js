const { CodeSystemProvider, FilterExecutionContext } = require('./cs-api');
const { DesignationUse } = require('../library/designations');

/**
 * A code system (and version) that this server doesn't hold, answered by asking another server
 * in the terminology ecosystem that does (see ecosystem-resolver.js, and
 * modules.tx.ecosystem in README.md).
 *
 * This is deliberately minimal: only what $validate-code against a value set needs, and with no
 * regard for performance (every concept is a $lookup, every filter check a $validate-code). Every
 * other method of the code system provider API throws, saying so - the defaults that
 * CodeSystemProvider provides would otherwise give plausible but wrong answers (not abstract, not
 * inactive, no designations...) for a code system that isn't here
 */
class VirtualCodeSystemProvider extends CodeSystemProvider {

  /**
   * @param {OperationContext} opContext
   * @param {CodeSystem[]} supplements
   * @param {string} server - the address of the server that has the code system
   * @param {string} system - the code system
   * @param {string} version - the version of the code system on that server (may be null)
   * @param {EcosystemResolver} ecosystem - sends the requests to the server (with its credentials)
   */
  constructor(opContext, supplements, server, system, version, ecosystem) {
    super(opContext, supplements);
    this.ecosystem = ecosystem;
    this.server = server.endsWith('/') ? server.substring(0, server.length - 1) : server;
    this.systemUrl = system;
    this.versionId = version || null;
    for (const name of Object.getOwnPropertyNames(CodeSystemProvider.prototype)) {
      if (name === 'constructor' || name.startsWith('_') || Object.prototype.hasOwnProperty.call(VirtualCodeSystemProvider.prototype, name)) {
        continue;
      }
      const d = Object.getOwnPropertyDescriptor(CodeSystemProvider.prototype, name);
      if (d && typeof d.value === 'function') {
        this[name] = () => { throw this.#notSupported(name); };
      }
    }
  }

  #notSupported(name) {
    return new Error(`${this.vurl()} is not held on this server, and is provided by ${this.server}, but '${name}' isn't supported for code systems on other servers`);
  }

  // --- metadata -------------------------------------------------------------------------------

  system() { return this.systemUrl; }
  version() { return this.versionId; }
  vurl() { return this.systemUrl + (this.versionId ? '|' + this.versionId : ''); }
  name() { return this.vurl(); }
  description() { return this.vurl() + ' (on ' + this.server + ')'; }
  defLang() { return 'en'; }
  contentMode() { return 'complete'; }
  sourcePackage() { return null; }
  status() { return {}; }
  versionNeeded() { return false; }
  versionAlgorithm() { return null; }
  hasSupplement() { return false; }

  versionIsMoreDetailed(checkVersion, actualVersion) {
    return !!actualVersion && !!checkVersion && actualVersion.startsWith(checkVersion);
  }

  // --- talking to the other server --------------------------------------------------------------

  // $lookup and $validate-code: the answers are kept (EcosystemResolver.sendCached), so the
  // same question is only asked once (the validator asks for the same concept several times)
  async #send(url, body) {
    return this.ecosystem.sendCached(this.server, url, body, this.opContext);
  }

  static #outcomeText(oo) {
    return (oo && oo.issue || []).map(i => (i.details && i.details.text) || i.diagnostics).filter(t => t).join('; ');
  }

  // --- concepts ---------------------------------------------------------------------------------

  /**
   * One $lookup on the other server. The context is what it says about the concept
   */
  async locate(code) {
    if (code && typeof code === 'object') {
      return { context: code, message: null };
    }
    let url = this.server + '/CodeSystem/$lookup?system=' + encodeURIComponent(this.systemUrl) + '&code=' + encodeURIComponent(code);
    if (this.versionId) {
      url = url + '&version=' + encodeURIComponent(this.versionId);
    }
    url = url + '&property=inactive&property=notSelectable&property=status';
    const { status, json } = await this.#send(url);
    if (status >= 300 || !json || json.resourceType !== 'Parameters') {
      const msg = json && json.resourceType === 'OperationOutcome' ? VirtualCodeSystemProvider.#outcomeText(json) : null;
      return { context: null, message: msg || `Code '${code}' not found on ${this.server}` };
    }
    const ctxt = { code, display: null, inactive: false, abstract: false, status: null, designations: [] };
    for (const p of json.parameter || []) {
      if (p.name === 'display') {
        ctxt.display = p.valueString;
      } else if (p.name === 'abstract') {
        ctxt.abstract = p.valueBoolean === true;
      } else if (p.name === 'inactive') {
        ctxt.inactive = p.valueBoolean === true;
      } else if (p.name === 'designation') {
        const d = {};
        for (const part of p.part || []) {
          if (part.name === 'language') d.language = part.valueCode;
          if (part.name === 'use') d.use = part.valueCoding;
          if (part.name === 'value') d.value = part.valueString;
        }
        if (d.value) {
          ctxt.designations.push(d);
        }
      } else if (p.name === 'property') {
        const pc = (p.part || []).find(x => x.name === 'code');
        const pv = (p.part || []).find(x => x.name === 'value');
        if (pc && pv) {
          if (pc.valueCode === 'inactive' && pv.valueBoolean !== undefined) ctxt.inactive = pv.valueBoolean;
          if (pc.valueCode === 'notSelectable' && pv.valueBoolean !== undefined) ctxt.abstract = pv.valueBoolean;
          if (pc.valueCode === 'status') ctxt.status = pv.valueCode || pv.valueString || null;
        }
      }
    }
    return { context: ctxt, message: null };
  }

  async code(context) { return typeof context === 'string' ? context : context.code; }
  async display(context) { return (await this.locate(context)).context?.display || null; }
  async isAbstract(context) { return (await this.locate(context)).context?.abstract || false; }
  async isInactive(context) { return (await this.locate(context)).context?.inactive || false; }
  async getStatus(context) {
    const ctxt = (await this.locate(context)).context;
    return ctxt ? (ctxt.status || (ctxt.inactive ? 'inactive' : null)) : null;
  }
  async incompleteValidationMessage() { return null; }
  async classificationCode() { return null; }
  async codeIssues() { return []; }
  async reportedClassificationCode() { return null; }

  async designations(context, displays) {
    const ctxt = (await this.locate(context)).context;
    if (ctxt) {
      if (ctxt.display) {
        displays.addDesignation(true, 'active', this.defLang(), DesignationUse.DISPLAY, ctxt.display);
      }
      for (const d of ctxt.designations) {
        if (d.value !== ctxt.display) {
          // any designation is a valid display, except a fully specified name
          const fsn = d.use && d.use.code === DesignationUse.FSN.code;
          displays.addDesignation(!fsn, 'active', d.language || '', d.use || null, d.value);
        }
      }
    }
  }

  // --- filters ----------------------------------------------------------------------------------
  //
  // the filters on an include are collected, and a code is checked against them all at once, by
  // $validate-code on the other server against a value set with just that include

  async doesFilter() { return true; } // the other server says, when the filter is used

  async getPrepContext(iterate) {
    return new FilterExecutionContext(iterate);
  }

  async filter(filterContext, forIteration, prop, op, value) {
    filterContext.filters.push({ property: prop, op, value });
  }

  async executeFilters(filterContext) {
    return [{ filters: filterContext.filters }];
  }

  async filterLocate(filterContext, set, code) {
    const include = { system: this.systemUrl, filter: set.filters };
    if (this.versionId) {
      include.version = this.versionId;
    }
    const parameters = { resourceType: 'Parameters', parameter: [
      { name: 'valueSet', resource: { resourceType: 'ValueSet', status: 'active', compose: { include: [include] } } },
      { name: 'system', valueUri: this.systemUrl },
      { name: 'code', valueCode: code }
    ]};
    if (this.versionId) {
      parameters.parameter.push({ name: 'systemVersion', valueString: this.versionId });
    }
    const { status, json } = await this.#send(this.server + '/ValueSet/$validate-code', parameters);
    if (status >= 300 || !json || json.resourceType !== 'Parameters') {
      // the other server couldn't say: that's why the code isn't located, and it's worth reporting
      // (it's passed up to the message, if the code turns out not to be in the value set)
      return `Unable to check '${code}' against the filter ${set.filters.map(f => f.property + ' ' + f.op + ' ' + f.value).join(' and ')} on ${this.server}: ` +
        (json && json.resourceType === 'OperationOutcome' ? VirtualCodeSystemProvider.#outcomeText(json) : 'it returned status ' + status);
    }
    const result = (json.parameter || []).find(p => p.name === 'result');
    if (result && result.valueBoolean === true) {
      const loc = await this.locate(code);
      return loc.context || loc.message;
    }
    // not in the filter: nothing worth saying (the other server's message is about the value set made up here)
    return null;
  }
}

module.exports = { VirtualCodeSystemProvider };
