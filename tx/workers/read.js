//
// Read Worker - Handles resource read operations
//
// GET /{type}/{id}
//

const { TerminologyWorker } = require('./worker');
const {debugLog} = require("../operation-context");

const { buildOperationOutcome } = require('../library/operation-outcome');
const { originalId } = require('../library/resource-ids');
const { acceptsHtml } = require('../tx-html');

class ReadWorker extends TerminologyWorker {
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
    return 'read';
  }
  /**
   * Handle a read request
   * @param {express.Request} req - Express request (with txProvider attached)
   * @param {express.Response} res - Express response
   * @param {string} resourceType - The resource type (CodeSystem, ValueSet, ConceptMap)
   * @param {Function} [renderChoices] - (req, res, resourceType, id, matches) renders the
   *   page that lists the resources an unprefixed id could mean (see notFound)
   */
  async handle(req, res, resourceType, renderChoices = null) {
    const { id } = req.params;
    this.renderChoices = renderChoices;

    this.log.debug(`Read ${resourceType}/${id}`);

    try {
      switch (resourceType) {
        case 'CodeSystem':
          return await this.handleCodeSystem(req, res, id);

        case 'ValueSet':
          return await this.handleValueSet(req, res, id);

        case 'ConceptMap':
          return await this.handleConceptMap(req, res, id);

        default:
          return res.status(404).json(buildOperationOutcome('error', 'not-found', `Unknown resource type: ${resourceType}`));
      }
    } catch (error) {
      this.log.error(error);
      debugLog(error);
      req.logInfo = this.usedSources.join("|")+" - error"+(error.msgId  ? " "+error.msgId : "");
      return res.status(500).json(buildOperationOutcome('error', 'exception', error.message));
    }
  }

  /**
   * Handle CodeSystem read
   */
  async handleCodeSystem(req, res, id) {
    let cs = this.provider.getCodeSystemById(this.opContext, id);
    if (cs != null) {
      req.sourcePackage = cs.sourcePackage;
      return res.json(cs.jsonObj);
    }

    if (id.startsWith("x-")) {
      cs = this.provider.getCodeSystemFactoryById(this.opContext, id.substring(2));
      if (cs != null) {
        let json = {
          resourceType: "CodeSystem",
          id: "x-" + cs.id(),
          url: cs.system(),
          version: cs.version(),
          name: cs.name(),
          status: "active",
          description: "This is a place holder for the code system which is fully supported through internal means (not by this code system)",
          content: "not-present"
        }
        if (cs.webSource()) {
          json.extension = [{ url: "http://hl7.org/fhir/StructureDefinition/web-source", valueUrl : cs.webSource()}];
        }
        if (cs.version()) {
          json.version = cs.version();
        }
        if (cs.iteratable()) {
          json.content =  "complete",
          json.concept = [];
          let csp = cs.build(this.opContext, []);
          let iter = await csp.iteratorAll();
          let c = await csp.nextContext(iter);
          while (c) {
            let cc = {
              code: await csp.code(c),
              display: await csp.display(c)
            }
            let def = await csp.definition(c);
            if (def) {
              cc.definition = def;
            }
            json.concept.push(cc);
            c = await csp.nextContext(iter);
          }

        }
        return res.json(json);
      }
    }

    return await this.notFound(req, res, 'CodeSystem', id);
  }

  /**
   * Handle ValueSet read
   */
  async handleValueSet(req, res, id) {
    // Iterate through valueSetProviders in order
    for (const vsp of this.provider.valueSetProviders) {
      this.deadCheck('handleValueSet-loop');
      const vs = await vsp.fetchValueSetById(id);
      if (vs) {
        req.sourcePackage = vs.sourcePackage;
        return res.json(vs.jsonObj);
      }
    }

    return await this.notFound(req, res, 'ValueSet', id);
  }
  /**
   * Handle ConceptMap read
   */
  async handleConceptMap(req, res, id) {
    // Iterate through valueSetProviders in order
    for (const cmsp of this.provider.conceptMapProviders) {
      this.deadCheck('handleConceptMap-loop');
      const cm = await cmsp.fetchConceptMapById(id);
      if (cm) {
        req.sourcePackage = cm.sourcePackage;
        return res.json(cm.jsonObj);
      }
    }

    return await this.notFound(req, res, 'ConceptMap', id);
  }

  /**
   * Nothing has the id asked for. Published IGs link to resources by the id they had in
   * their source (ValueSet/2.16.840.1.113762.1.4.1), from before every id was put in its
   * provider's id space (ValueSet/vsac-2.16.840.1.113762.1.4.1). So for a browser, look
   * for resources that had that id in their source: if there's one, redirect to it, and
   * if there are several, list them. Anything other than a browser still gets a 404 -
   * an unprefixed id can't say which resource it means (see library/resource-ids.js).
   */
  async notFound(req, res, resourceType, id) {
    if (this.renderChoices && acceptsHtml(req)) {
      const matches = await this.findByOriginalId(resourceType, id);
      if (matches.length === 1) {
        req.logInfo = `redirected to ${matches[0].id}`;
        // relative, so that it works whatever path the server is behind; keeps the query
        const q = req.originalUrl.indexOf('?');
        return res.redirect(302, encodeURIComponent(matches[0].id) + (q >= 0 ? req.originalUrl.substring(q) : ''));
      }
      if (matches.length > 1) {
        req.logInfo = `${matches.length} matches`;
        return await this.renderChoices(req, res, resourceType, id, matches);
      }
    }
    return res.status(404).json(buildOperationOutcome('error', 'not-found', `${resourceType}/${id} not found`));
  }

  /**
   * The resources of a type that had this id in their source, across all the providers.
   *
   * @returns {Promise<Array<{id, url, version, title, source}>>} in provider order
   */
  async findByOriginalId(resourceType, id) {
    const found = [];
    const add = (resource) => {
      const json = resource.jsonObj || resource;
      if (json.id && !found.some(m => m.id === json.id)) {
        found.push({
          id: json.id,
          url: json.url || null,
          version: json.version || null,
          title: json.title || json.name || null,
          source: typeof resource.sourcePackage === 'string' ? resource.sourcePackage : null
        });
      }
    };

    switch (resourceType) {
      case 'CodeSystem':
        // the map holds a code system under more than one key (url, url|version)
        for (const cs of new Set(this.provider.codeSystems.values())) {
          this.deadCheck('findByOriginalId-cs');
          if (originalId(cs.jsonObj.id) === id) {
            add(cs);
          }
        }
        break;
      case 'ValueSet':
        for (const vsp of this.provider.valueSetProviders) {
          this.deadCheck('findByOriginalId-vs');
          const vs = vsp.spaceId ? await vsp.fetchValueSetById(`${vsp.spaceId}-${id}`) : null;
          if (vs) {
            add(vs);
          }
        }
        break;
      case 'ConceptMap':
        for (const cmp of this.provider.conceptMapProviders) {
          this.deadCheck('findByOriginalId-cm');
          const cm = cmp.spaceId ? await cmp.fetchConceptMapById(`${cmp.spaceId}-${id}`) : null;
          if (cm) {
            add(cm);
          }
        }
        break;
    }
    return found;
  }
}

module.exports = ReadWorker;