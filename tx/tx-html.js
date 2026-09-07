//
// TX HTML Rendering Module
//
// Renders FHIR resources as HTML for browser clients
//

const path = require('path');
const htmlServer = require('../library/html-server');
const Logger = require('../library/logger');
const packageJson = require("../package.json");
const escape = require('escape-html');
const {ExpandWorker} = require("./workers/expand");
const ValueSet = require("./library/valueset");
const {CodeSystemXML} = require("./xml/codesystem-xml");
const {ValueSetXML} = require("./xml/valueset-xml");
const {BundleXML} = require("./xml/bundle-xml");
const {CapabilityStatementXML} = require("./xml/capabilitystatement-xml");
const {TerminologyCapabilitiesXML} = require("./xml/terminologycapabilities-xml");
const {ParametersXML} = require("./xml/parameters-xml");
const {OperationOutcomeXML} = require("./xml/operationoutcome-xml");
const {debugLog} = require("./operation-context");
const {InvalidError} = require("./library/errors");

const txHtmlLog = Logger.getInstance().child({ module: 'tx-html' });

const TEMPLATE_PATH = path.join(__dirname, 'html', 'tx-template.html');

// Search parameters for the search form
const SEARCH_PARAMS = [
  { name: 'url', type: 'text', label: 'URL' },
  { name: 'version', type: 'text', label: 'Version' },
  { name: 'name', type: 'text', label: 'Name' },
  { name: 'title', type: 'text', label: 'Title' },
  { name: 'status', type: 'select', label: 'Status', options: ['', 'draft', 'active', 'retired', 'unknown'] },
  { name: 'publisher', type: 'text', label: 'Publisher' },
  { name: 'description', type: 'text', label: 'Description' },
  { name: 'identifier', type: 'text', label: 'Identifier' },
  { name: 'jurisdiction', type: 'text', label: 'Jurisdiction' },
  { name: 'date', type: 'text', label: 'Date' }
];

const CODESYSTEM_PARAMS = [
  ...SEARCH_PARAMS,
  { name: 'content-mode', type: 'select', label: 'Content Mode', options: ['', 'not-present', 'example', 'fragment', 'complete', 'supplement'] },
  { name: 'supplements', type: 'text', label: 'Supplements' },
  { name: 'system', type: 'text', label: 'System' }
];

const SORT_OPTIONS = ['', 'id', 'url', 'version', 'date', 'name', 'vurl'];

const ELEMENT_OPTIONS = ['id', 'url', 'version', 'name', 'title', 'status', 'date', 'publisher', 'description'];

/**
 * Load the TX HTML template
 */
function loadTemplate() {
  try {
    const templateLoaded = htmlServer.loadTemplate('tx', TEMPLATE_PATH);
    if (!templateLoaded) {
      txHtmlLog.error('Failed to load TX HTML template');
    }
  } catch (error) {
    txHtmlLog.error(`Failed to load TX HTML template: ${error.message}`);
  }
}

/**
 * Check if a request wants HTML back (by _format/format param, else Accept header).
 * Module-level so non-rendering code (e.g. the search worker choosing a default
 * page size) can make the same call the response renderer will make.
 */
function acceptsHtml(req) {
  let _fmt = req.query._format || req.query.format || req.body?._format;
  if (_fmt && typeof _fmt !== 'string') {
    _fmt = null;
  }
  if (_fmt && (_fmt == 'html' || _fmt.startsWith('html/'))) {
    return true;
  }
  if (!_fmt) {
    _fmt = req.headers.accept || '';
  }
  if (typeof _fmt !== 'string') {
    return false;
  }
  return _fmt.includes('text/html');
}

// Whether this server publishes its library source YAML. Off unless the operator turns
// modules.tx.publishLibrarySource on, and it gates both the route and the nav item, so a
// server that does not publish it has no link to a 404.
let publishLibrarySource = false;

function setPublishLibrarySource(enabled) {
  publishLibrarySource = enabled === true;
}

function publishesLibrarySource() {
  return publishLibrarySource;
}

/**
 * Highlight a YAML document for display.
 *
 * Deliberately line-oriented and modest: this is the operator's own source file, not a
 * general YAML parser, and it has to survive anything a hand-edited file contains without
 * ever emitting the file's bytes unescaped. Each line is split into its parts FIRST and
 * every part is escaped before any markup goes near it, so no amount of angle brackets or
 * ampersands in a value can break out.
 */
function highlightYaml(source) {
  const lines = String(source).replace(/\r\n/g, '\n').split('\n');
  const out = lines.map(line => {
    if (line.trim() === '') {
      return '';
    }
    // a whole-line comment
    const wholeComment = /^(\s*)(#.*)$/.exec(line);
    if (wholeComment) {
      return escape(wholeComment[1]) + '<span class="y-c">' + escape(wholeComment[2]) + '</span>';
    }
    // split off a trailing comment, but only one introduced by whitespace-then-#, so a
    // '#' inside a value (a FHIR fragment URL, say) stays part of the value
    let body = line;
    let comment = '';
    const trailing = /^(.*?)(\s+#.*)$/.exec(line);
    if (trailing) {
      body = trailing[1];
      comment = '<span class="y-c">' + escape(trailing[2]) + '</span>';
    }

    // a mapping key needs whitespace (or end of line) after the colon - without it the
    // colon is just part of a scalar, which is exactly what a source line like
    // '- internal:lang' or '- snomed!:sct_intl_20250201.cache' is
    const m = /^(\s*)(-\s+)?([A-Za-z0-9_.$-]+)(:)(\s+|$)(.*)$/.exec(body);
    if (m) {
      return escape(m[1])
        + (m[2] ? '<span class="y-d">' + escape(m[2]) + '</span>' : '')
        + '<span class="y-k">' + escape(m[3]) + '</span>'
        + '<span class="y-p">' + escape(m[4]) + '</span>'
        + escape(m[5])
        + (m[6] ? '<span class="y-v">' + escape(m[6]) + '</span>' : '')
        + comment;
    }
    const item = /^(\s*)(-\s+)(.*)$/.exec(body);
    if (item) {
      return escape(item[1])
        + '<span class="y-d">' + escape(item[2]) + '</span>'
        + '<span class="y-v">' + escape(item[3]) + '</span>'
        + comment;
    }
    return escape(body) + comment;
  });
  return out.join('\n');
}

const YAML_STYLE = '<style>' +
  '.yaml-source { background: #f7f7f7; border: 1px solid #ddd; padding: 12px; overflow-x: auto; ' +
  'font-family: Menlo, Consolas, monospace; font-size: 90%; line-height: 1.45; }' +
  '.yaml-source .y-k { color: #0b5394; font-weight: bold; }' +
  '.yaml-source .y-v { color: #444; }' +
  '.yaml-source .y-p, .yaml-source .y-d { color: #999; }' +
  '.yaml-source .y-c { color: #777; font-style: italic; }' +
  '</style>';

/**
 * The page body for the library source: what the file is, where to get the raw bytes, and
 * the file itself.
 */
function buildLibrarySourcePage(source, filename, endpointPath) {
  return YAML_STYLE
    + '<p>This is the library source this server loads its content from - the code system files, '
    + 'the packages, and the terminology sources it makes available. It is shown here as it is on '
    + 'disk.</p>'
    + '<p>The same URL returns the file itself to anything that does not ask for HTML: '
    + '<code>curl -H "Accept: application/yaml" ' + escape(endpointPath) + '/library</code>, or '
    + '<a href="library?_format=yaml">' + escape(endpointPath) + '/library?_format=yaml</a>.</p>'
    + '<p>Source file: <code>' + escape(filename) + '</code></p>'
    + '<pre class="yaml-source">' + highlightYaml(source) + '</pre>';
}


class TxHtmlRenderer {
  renderer;
  liquid;
  languages;
  i18n;
  path;

  constructor(renderer, liquid, languages, i18n, path) {
    this.renderer = renderer;
    this.liquid = liquid;
    this.languages = languages;
    this.i18n = i18n;
    this.path = path;
  }

  /**
   * Render a page with the TX template
   */
  renderPage(title, content, endpoint, startTime) {
    const options = {
      version: packageJson.version,
      endpointpath: endpoint.path,
      fhirversion: endpoint.fhirVersion,
      ms: Date.now() - startTime,
      libraryLink: publishLibrarySource
        ? '<a href="' + escape(endpoint.path) + '/library" style="color: gold">Library</a>  &nbsp;|&nbsp;'
        : ''
    };

    return htmlServer.renderPage('tx', title, content, options);
  }

  /**
   * Check if request accepts HTML
   */
  acceptsHtml(req) {
    return acceptsHtml(req);
  }

  /**
   * Build page title from JSON response
   */
  buildTitle(json, req) {
    if (req.path == "/") {
      return "Server Home";
    } else {
      const resourceType = json.resourceType || 'Response';

      let pfx = resourceType;
      if (req.path.includes('$')) {
        let s = req.path.substring(req.path.indexOf('$') + 1).replace(/[^a-zA-Z].*$/, '');
        switch (s) {
          case 'expand': pfx = "Expansion for "+resourceType;
        }
      }

      if (resourceType === 'Bundle' && json.type === 'searchset') {
        // Extract the resource type being searched from self link or entries
        const selfLink = json.link?.find(l => l.relation === 'self')?.url || '';
        const typeMatch = selfLink.match(/\/(CodeSystem|ValueSet|ConceptMap)\?/);
        if (typeMatch) {
          return `Search: ${typeMatch[1]}`;
        }
        const firstEntry = json.entry?.[0]?.resource;
        const searchedType = firstEntry?.resourceType || 'Resources';
        return `Search: ${searchedType}`;
      }

      if (resourceType === 'OperationOutcome') {
        const severity = json.issue?.[0]?.severity || 'info';
        return `${severity.charAt(0).toUpperCase() + severity.slice(1)}`;
      }

      if (json.id) {
        return `${pfx} ${json.id}`;
      }

      if (json.name) {
        return `${pfx} ${json.name}`;
      }

      return resourceType;
    }
  }

// eslint-disable-next-line no-unused-vars
  async buildSearchForm(req, mode, params) {
    const html = await this.liquid.renderFile('search-form', { baseUrl: escape(req.baseUrl), sourceOptions : this.buildSourceOptions(req.txProvider) });
    return html;
  }

  async buildHomePage(req) {
    const provider = req.txProvider;

    let html = '';

    // ===== Summary Section =====

    // Calculate uptime
    const uptimeMs = Date.now() - provider.startTime;
    const uptimeSeconds = Math.floor(uptimeMs / 1000);
    const uptimeDays = Math.floor(uptimeSeconds / 86400);
    const uptimeHours = Math.floor((uptimeSeconds % 86400) / 3600);
    const uptimeMinutes = Math.floor((uptimeSeconds % 3600) / 60);
    const uptimeSecs = uptimeSeconds % 60;
    let uptimeStr = '';
    if (uptimeDays > 0) uptimeStr += `${uptimeDays}d `;
    if (uptimeHours > 0 || uptimeDays > 0) uptimeStr += `${uptimeHours}h `;
    if (uptimeMinutes > 0 || uptimeHours > 0 || uptimeDays > 0) uptimeStr += `${uptimeMinutes}m `;
    uptimeStr += `${uptimeSecs}s`;

    // Memory usage
    const memUsage = process.memoryUsage();
    const heapUsedMB = (memUsage.heapUsed / 1024 / 1024).toFixed(2);
    const heapTotalMB = (memUsage.heapTotal / 1024 / 1024).toFixed(2);
    const rssMB = (memUsage.rss / 1024 / 1024).toFixed(2);

    html += '<table class="grid">';
    html += '<tr>';
    html += `<td><strong>FHIR Version:</strong> ${escape(provider.getFhirVersion())}</td>`;
    html += `<td><strong>Uptime:</strong> ${escape(uptimeStr)}</td>`;
    html += `<td><strong>Request Count:</strong> ${provider.requestCount}</td>`;
    html += '</tr>';
    html += '<tr>';
    html += `<td><strong>Heap Used:</strong> ${heapUsedMB} MB</td>`;
    html += `<td><strong>Heap Total:</strong> ${heapTotalMB} MB</td>`;
    html += `<td><strong>Process Memory:</strong> ${rssMB} MB</td>`;
    html += '</tr>';

    // Count unique code systems
    const uniqueFactorySystems = new Set();
    for (const factory of provider.codeSystemFactories.values()) {
      uniqueFactorySystems.add(factory.system());
    }
    const uniqueCodeSystems = new Set();
    for (const cs of provider.codeSystems.values()) {
      uniqueCodeSystems.add(cs.url);
    }
    html += '<tr>';
    html += `<td><strong>CodeSystem #:</strong> ${new Set([...uniqueFactorySystems, ...uniqueCodeSystems]).size}</td>`;

    // Count value sets
    let totalValueSets = 0;
    for (const vsp of provider.valueSetProviders) {
      totalValueSets += vsp.vsCount();
    }
    html += `<td><strong>ValueSet #:</strong> ${totalValueSets || 'Unknown'}</td>`;

    let totalConceptMaps = 0;
    for (const cmp of provider.conceptMapProviders) {
      totalConceptMaps += cmp.cmCount();
    }
    html += `<td><strong>ConceptMap #:</strong> ${totalConceptMaps || 'Unknown'}</td>`;
    html += '</tr>';
    html += '</table>';

    html += '<hr/>';
    html += await this.buildSearchForm(req);

    // ===== Packages and Factories Section =====
    // What follows is the loaded content; the library YAML is where it came from, so when
    // the operator publishes it, link it from the heading over the list it produced.
    html += '<hr/><h3>Source Content';
    if (publishLibrarySource) {
      html += ` <a href="${escape(this.path)}/library" style="font-size: 60%; font-weight: normal;"` +
        ' title="The library source this server loaded this content from">source</a>';
    }
    html += '</h3>';

    // List Packages
    html += '<h6>FHIR Packages</h6>';
    if (provider.packageSources && provider.packageSources.length > 0) {
      const sorted = [...provider.packageSources].sort();
      html += '<ul>';
      for (const source of sorted) {
        html += `<li>${escape(source)}</li>`;
      }
      html += '</ul>';
    } else {
      html += '<p><em>No FHIR Packages Loaded</em></p>';
    }

    // List Packages
    html += '<h6>External Sources</h6>';
    if (provider.externalSources && provider.externalSources.length > 0) {
      const sorted = [...provider.externalSources].sort();
      html += '<ul>';
      for (const source of sorted) {
        let n = source.name();
        if (!n) {
          n = source.sourcePackage();
        }
        let ii = source.infoName();
        if (ii) {
          html += `<li>${escape(n)} (<a href="info/${source.id()}">${ii}</a>)</li>`;
        } else {
          html += `<li>${escape(n)}</li>`;
        }
      }
      html += '</ul>';
    } else {
      html += '<p><em>No External Sources Configured</em></p>';
    }

    html += '<h6 class="mt-4">Special CodeSystems</h6>';
    html += '<table class="grid">';
    html += '<thead><tr><th>Name</th><th>URI</th><th>Version</th><th>Use Count</th></tr></thead>';
    html += '<tbody>';

// Deduplicate factories and sort by system URL
    const seenFactories = new Set();
    const uniqueFactories = [];
    for (const factory of provider.codeSystemFactories.values()) {
      const key = factory.system() + '|' + (factory.version() || '');
      if (!seenFactories.has(key)) {
        seenFactories.add(key);
        uniqueFactories.push(factory);
      }
    }
    uniqueFactories.sort((a, b) => a.name().localeCompare(b.name()));

    for (const factory of uniqueFactories) {
      html += '<tr>';
      html += `<td>${escape(factory.name())}</td>`;
      html += `<td>${escape(factory.system())}</td>`;
      html += `<td>${escape(factory.version() || '-')}</td>`;
      html += `<td>${factory.useCount ? factory.useCount() : '-'}</td>`;
      html += '</tr>';
    }

    html += '</tbody></table>';
    html += '</div></div>';

    return html;
  }

  /**
   * Main render - determines what to render based on resource type
   */
  async render(json, req, inBundle = false) {
    if (req && req.path == "/") {
      return await this.buildHomePage(req);
    } else {
      try {
        if (json === null || json === undefined || typeof json !== 'object' || Array.isArray(json)) {
          throw new InvalidError(`Cannot render: expected a FHIR resource object but got ${json === null ? 'null' : (Array.isArray(json) ? 'an array' : typeof json)}`);
        }
        if (json.resourceType === undefined || json.resourceType === null || typeof json.resourceType !== 'string' || json.resourceType === '') {
          throw new InvalidError(`Cannot render: resource has no resourceType (got ${json.resourceType === undefined ? 'undefined' : JSON.stringify(json.resourceType)})`);
        }
        const _fmt = req?.query?._format || req?.query?.format || req?.body?._format;
        const op = req ? req.path.includes("$") : false;
        const resourceType = json.resourceType;

        switch (resourceType) {
          case 'Parameters':
            return await this.renderParameters(json);
          case 'CodeSystem':
            return await this.renderCodeSystem(json, inBundle, _fmt, op, req.sourcePackage);
          case 'ValueSet': {
            let exp = undefined;
            if (!inBundle && !op && (!_fmt || _fmt == 'html')) {
              try {
                let worker = new ExpandWorker(req.txOpContext, this.log, req.txProvider, this.languages, this.i18n);
                exp = new ValueSet(await worker.handleInternalExpand(json, req));
              } catch (error) {
                exp = error;
              }
            }
            return await this.renderValueSet(json, inBundle, _fmt, op, exp, req.sourcePackage);
          }
          case 'ConceptMap':
            return await this.renderConceptMap(json, inBundle, _fmt, op, req.sourcePackage);
          case 'CapabilityStatement':
            return await this.renderCapabilityStatement(json, inBundle);
          case 'TerminologyCapabilities':
            return await this.renderTerminologyCapabilities(json, inBundle);
          case 'Bundle':
            return await this.renderBundle(json, req, inBundle);
          case 'OperationOutcome':
            return await this.renderOperationOutcome(json, req);
          case 'Operations':
            return await this.renderOperationsForm(json, req);
          default:
            return await this.renderGeneric(json, inBundle);
        }
      } catch (error) {
        debugLog(error);
        console.error(error);
        throw error;
      }
    }
  }

  /**
   * Render Parameters resource
   */
  async renderParameters(json) {
    let html = '<table class="table grid">';
    html += '<thead><tr><th>Name</th><th>Value</th></tr></thead>';
    html += '<tbody>';

    if (json.parameter && Array.isArray(json.parameter)) {
      for (const param of json.parameter) {
        html += await this.renderParameter(param);
      }
    }

    html += '</tbody></table>';

    // Collapsible JSON source
    const resourceId = this.generateResourceId();
    html += '<div class="json-source">';
    html += `<button type="button" class="btn btn-sm btn-outline-secondary" onclick="toggleJsonSource('${resourceId}')">`;
    html += 'Show JSON Source</button>';
    html += `<div id="${resourceId}" class="json-content" style="display: none; margin-top: 10px;">`;
    html += `<pre>${escape(JSON.stringify(json, null, 2))}</pre>`;
    html += '</div>';
    html += '</div>';

    return html;
  }

  /**
   * Render a single parameter row
   */
  async renderParameter(param) {
    let html = '<tr>';
    html += `<td>${escape(param.name || '')}</td>`;
    html += '<td>';
    html += await this.renderParameterValue(param);
    html += '</td>';
    html += '</tr>';
    return html;
  }

  /**
   * Render the value portion of a parameter
   */
  async renderParameterValue(param) {
    // Check for parts (nested parameters)
    if (param.part && Array.isArray(param.part)) {
      let html = '<ul>';
      for (const part of param.part) {
        html += '<li>';
        html += `<strong>${escape(part.name || '')}:</strong> `;
        html += await this.renderParameterValue(part);
        html += '</li>';
      }
      html += '</ul>';
      return html;
    }

    // Check for resource
    if (param.resource) {
      return await this.render(param.resource, null, true);
    }

    // Check for complex datatypes
    if (param.valueCoding) {
      return this.renderCoding(param.valueCoding);
    }
    if (param.valueCodeableConcept) {
      return this.renderCodeableConcept(param.valueCodeableConcept);
    }
    if (param.valueQuantity) {
      return this.renderQuantity(param.valueQuantity);
    }
    if (param.valueAttachment) {
      return this.renderAttachment(param.valueAttachment);
    }
    if (param.valueIdentifier) {
      return this.renderIdentifier(param.valueIdentifier);
    }
    if (param.valuePeriod) {
      return this.renderPeriod(param.valuePeriod);
    }

    // Primitive types
    if (param.valueString !== undefined) {
      return escape(param.valueString);
    }
    if (param.valueBoolean !== undefined) {
      return param.valueBoolean ? 'true' : 'false';
    }
    if (param.valueInteger !== undefined) {
      return escape(String(param.valueInteger));
    }
    if (param.valueDecimal !== undefined) {
      return escape(String(param.valueDecimal));
    }
    if (param.valueUri !== undefined) {
      return escape(param.valueUri);
    }
    if (param.valueUrl !== undefined) {
      return escape(param.valueUrl);
    }
    if (param.valueCanonical !== undefined) {
      return escape(param.valueCanonical);
    }
    if (param.valueCode !== undefined) {
      return `<code>${escape(param.valueCode)}</code>`;
    }
    if (param.valueId !== undefined) {
      return escape(String(param.valueId));
    }
    if (param.valueOid !== undefined) {
      return escape(String(param.valueOid));
    }
    if (param.valueUuid !== undefined) {
      return escape(String(param.valueUuid));
    }
    if (param.valueMarkdown !== undefined) {
      // Render markdown to HTML the same way the rest of the server does, using
      // commonmark in safe mode (raw HTML in the markdown is escaped, so this is
      // XSS-safe).
      const commonmark = require('commonmark');
      const reader = new commonmark.Parser();
      const writer = new commonmark.HtmlRenderer({ safe: true });
      return writer.render(reader.parse(String(param.valueMarkdown)));
    }
    if (param.valueInteger64 !== undefined) {
      return escape(String(param.valueInteger64));
    }
    if (param.valuePositiveInt !== undefined) {
      return escape(String(param.valuePositiveInt));
    }
    if (param.valueUnsignedInt !== undefined) {
      return escape(String(param.valueUnsignedInt));
    }
    if (param.valueDate !== undefined) {
      return escape(param.valueDate);
    }
    if (param.valueDateTime !== undefined) {
      return escape(param.valueDateTime);
    }
    if (param.valueTime !== undefined) {
      return escape(param.valueTime);
    }
    if (param.valueInstant !== undefined) {
      return escape(param.valueInstant);
    }

    return '<em>(empty)</em>';
  }

  /**
   * Render Coding datatype
   */
  async renderCoding(coding) {
    if (!coding) return '';

    let parts = [];
    if (coding.system) {
      parts.push(escape(coding.system));
    }
    if (coding.code) {
      parts.push(`<code>${escape(coding.code)}</code>`);
    }
    if (coding.display) {
      parts.push(`"${escape(coding.display)}"`);
    }
    if (coding.version) {
      parts.push(`(version: ${escape(coding.version)})`);
    }

    return parts.join(' | ') || '<em>(empty coding)</em>';
  }

  /**
   * Render CodeableConcept datatype
   */
  async renderCodeableConcept(cc) {
    if (!cc) return '';

    let html = '';

    if (cc.text) {
      html += `<strong>${escape(cc.text)}</strong>`;
    }

    if (cc.coding && Array.isArray(cc.coding) && cc.coding.length > 0) {
      if (cc.text) html += '<br/>';
      html += '<ul style="margin: 0; padding-left: 20px;">';
      for (const coding of cc.coding) {
        html += `<li>${this.renderCoding(coding)}</li>`;
      }
      html += '</ul>';
    }

    return html || '<em>(empty CodeableConcept)</em>';
  }

  /**
   * Render Quantity datatype
   */
  async renderQuantity(qty) {
    if (!qty) return '';

    let html = '';

    if (qty.comparator) {
      html += escape(qty.comparator) + ' ';
    }
    if (qty.value !== undefined) {
      html += escape(String(qty.value));
    }
    if (qty.unit) {
      html += ' ' + escape(qty.unit);
    } else if (qty.code) {
      html += ' ' + escape(qty.code);
    }
    if (qty.system) {
      html += ` <small>(${escape(qty.system)})</small>`;
    }

    return html || '<em>(empty Quantity)</em>';
  }

  /**
   * Render Attachment datatype
   */
  async renderAttachment(att) {
    if (!att) return '';

    let html = '';

    if (att.title) {
      html += `<strong>${escape(att.title)}</strong><br/>`;
    }
    if (att.contentType) {
      html += `Content-Type: ${escape(att.contentType)}<br/>`;
    }
    if (att.url) {
      html += `URL: <a href="${escape(att.url)}">${escape(att.url)}</a><br/>`;
    }
    if (att.size !== undefined) {
      html += `Size: ${escape(String(att.size))} bytes<br/>`;
    }
    if (att.language) {
      html += `Language: ${escape(att.language)}<br/>`;
    }
    if (att.data) {
      html += `<small>(base64 data present, ${att.data.length} chars)</small>`;
    }

    return html || '<em>(empty Attachment)</em>';
  }

  /**
   * Render Identifier datatype
   */
  async renderIdentifier(id) {
    if (!id) return '';

    let parts = [];

    if (id.use) {
      parts.push(`[${escape(id.use)}]`);
    }
    if (id.type && id.type.text) {
      parts.push(escape(id.type.text));
    }
    if (id.system) {
      parts.push(escape(id.system));
    }
    if (id.value) {
      parts.push(`<strong>${escape(id.value)}</strong>`);
    }
    if (id.period) {
      parts.push(this.renderPeriod(id.period));
    }

    return parts.join(' | ') || '<em>(empty Identifier)</em>';
  }

  /**
   * Render Period datatype
   */
  async renderPeriod(period) {
    if (!period) return '';

    let html = '';

    if (period.start && period.end) {
      html = `${escape(period.start)} to ${escape(period.end)}`;
    } else if (period.start) {
      html = `from ${escape(period.start)}`;
    } else if (period.end) {
      html = `until ${escape(period.end)}`;
    }

    return html || '<em>(empty Period)</em>';
  }

  /**
   * Render CodeSystem resource
   */
  async renderCodeSystem(json, inBundle, _fmt, op, sourcePackage) {
    if (inBundle) {
      return await this.renderResourceWithNarrative(json, await this.renderer.renderCodeSystem(json));
    } else {
      let html = `<ul class="nav nav-tabs">`;
      html += this.tab(!_fmt || _fmt == 'html', json.resourceType, json.resourceType, 'html', json.id);
      html += this.tab(_fmt && _fmt == 'html/json', 'JSON', json.resourceType, 'html/json', json.id);
      html += this.tab(_fmt && _fmt == 'html/xml', 'XML', json.resourceType, 'html/xml', json.id);
      html += this.tab(_fmt && _fmt == 'html/narrative', 'Original Narrative', json.resourceType, 'html/narrative', json.id);
      html += this.tab(_fmt && _fmt == 'html/ops', 'LookUp / Subsumes', json.resourceType, 'html/ops', json.id);
      html += `</ul>`;

      if (!_fmt || _fmt == 'html') {
        html += await this.renderResourceWithNarrative(json, await this.renderer.renderCodeSystem(json, sourcePackage));
      } else if (_fmt == "html/json") {
        html += await this.renderResourceJson(json);
      } else if (_fmt == "html/xml") {
        html += await this.renderResourceXml(json);
      } else if (_fmt == "html/narrative") {
        html += await this.renderResourceWithNarrative(json, json.text?.div);
      } else if (_fmt == "html/ops") {
        html += await this.liquid.renderFile('codesystem-operations', {
          opsId: this.generateResourceId(),
          vcSystemId: this.generateResourceId(),
          inferSystemId: this.generateResourceId(),
          url: escape(json.url || '')
        });
      }


      return html;
    }
  }

  tab(b, name, rtype, type, id) {
    if (b) {
      return `<li class="active"><a href="#">${name}</a></li>`;
    } else {
      return `<li><a href="${this.path}/${rtype}/${id}?_format=${type}">${name}</a></li>`;
    }
  }
  /**
   * Render ValueSet resource
   */
  async renderValueSet(json, inBundle, _fmt, op, exp) {
    if (inBundle || op) {
      return await this.renderResourceWithNarrative(json, await this.renderer.renderValueSet(json));
    } else {
      let html = `<ul class="nav nav-tabs">`;
      html += this.tab(!_fmt || _fmt == 'html', json.resourceType, json.resourceType, 'html', json.id);
      html += this.tab(_fmt && _fmt == 'html/json', 'JSON', json.resourceType, 'html/json', json.id);
      html += this.tab(_fmt && _fmt == 'html/xml', 'XML', json.resourceType, 'html/xml', json.id);
      html += this.tab(_fmt && _fmt == 'html/narrative', 'Original Narrative', json.resourceType, 'html/narrative', json.id);
      html += this.tab(_fmt && _fmt == 'html/ops', 'Expand / Validate', json.resourceType, 'html/ops', json.id);
      html += `</ul>`;

      if (!_fmt || _fmt == 'html') {
        html += await this.renderResourceWithNarrative(json, await this.renderer.renderValueSet(json));
        if (exp) {
          html += "<h2>Expansion</h2>";
          if (exp instanceof ValueSet) {
            html += await this.renderer.renderVSExpansion(exp.jsonObj, false)
          } else {
            html += `<p>Error: `+exp.message+`</p>`;
          }
        }
      } else if (_fmt == "html/json") {
        html += await this.renderResourceJson(json);
      } else if (_fmt == "html/xml") {
        html += await this.renderResourceXml(json);
      } else if (_fmt == "html/narrative") {
        html += await this.renderResourceWithNarrative(json, json.text?.div);
      } else if (_fmt == "html/ops") {
        html += await this.liquid.renderFile('valueset-operations', {
          opsId: this.generateResourceId(),
          vcSystemId: this.generateResourceId(),
          inferSystemId: this.generateResourceId(),
          url: escape(json.url || '')
        });
      }
      return html;
    }
  }

  /**
   * Render ConceptMap resource
   */
  // eslint-disable-next-line no-unused-vars
  async renderConceptMap(json, inBundle, _fmt, op) {
    if (inBundle || op) {
      return await this.renderResourceWithNarrative(json, await this.renderer.renderConceptMap(json));
    } else {
      let html = `<ul class="nav nav-tabs">`;
      html += this.tab(!_fmt || _fmt == 'html', json.resourceType, json.resourceType, 'html', json.id);
      html += this.tab(_fmt && _fmt == 'html/json', 'JSON', json.resourceType, 'html/json', json.id);
      html += this.tab(_fmt && _fmt == 'html/narrative', 'Original Narrative', json.resourceType, 'html/narrative', json.id);
      html += this.tab(_fmt && _fmt == 'html/ops', 'Translate', json.resourceType, 'html/ops', json.id);
      html += `</ul>`;

      if (!_fmt || _fmt == 'html') {
        html += await this.renderResourceWithNarrative(json, await this.renderer.renderConceptMap(json));
      } else if (_fmt == "html/json") {
        html += await this.renderResourceJson(json);
      } else if (_fmt == "html/narrative") {
        html += await this.renderResourceWithNarrative(json, json.text?.div);
      } else if (_fmt == "html/ops") {
        const sourceSet = new Set();
        const codeSet = new Set();
        const targetSet = new Set();

        for (const grp of json.group || []) {
          if (grp.source) sourceSet.add(`<option value="${escape(grp.source)}">${escape(grp.source)}</option>`);
          if (grp.target) targetSet.add(`<option value="${escape(grp.target)}">${escape(grp.target)}</option>`);
          for (const elem of grp.element || []) {
            if (elem.code) codeSet.add(`<option value="${escape(elem.code)}">${escape(elem.code)}</option>`);
          }
        }
        const sources = [...sourceSet];
        const codes = [...codeSet];
        const targets = [...targetSet];

        html += await this.liquid.renderFile('conceptmap-operations', {
          opsId: this.generateResourceId(),
          cmSystemId: this.generateResourceId(),
          inferSystemId: this.generateResourceId(),
          sources: sources,
          codes: codes,
          targets: targets,
          url: escape(json.url || '')
        });
      }
      return html;
    }
  }

  /**
   * Render CapabilityStatement resource
   */
  // eslint-disable-next-line no-unused-vars
  async renderCapabilityStatement(json, inBundle) {
    return await this.renderResourceWithNarrative(json, await this.renderer.renderCapabilityStatement(json));
  }

  // eslint-disable-next-line no-unused-vars
  async renderTerminologyCapabilities(json, inBundle) {
    return await this.renderResourceWithNarrative(json, await this.renderer.renderTerminologyCapabilities(json));
  }

  /**
   * Render OperationOutcome resource
   */
  async renderOperationOutcome(json) {
    let html = '<div class="operation-outcome">';
    html += `<h4>OperationOutcome</h4>`;

    if (json.issue && Array.isArray(json.issue)) {
      for (const issue of json.issue) {
        html += '<div class="alert ';

        // Determine alert style based on this issue's severity
        const severity = issue.severity || 'information';
        switch (severity) {
          case 'error':
          case 'fatal':
            html += 'alert-danger';
            break;
          case 'warning':
            html += 'alert-warning';
            break;
          case 'information':
            html += 'alert-info';
            break;
          default:
            html += 'alert-secondary';
        }

        html += '">';
        html += `<strong>${escape(issue.severity || 'unknown')}:</strong> `;
        html += `[${escape(issue.code || 'unknown')}] `;
        html += escape(issue.diagnostics || issue.details?.text || 'No details');
        html += '</div>';
      }
    }

    html += '</div>';
    return html;
  }

  /**
   * Render Bundle resource
   */
  async renderBundle(json, req) {
    if (json.type === 'searchset') {
      return await this.renderSearchBundle(json, req);
    }

    // Generic bundle rendering
    return await this.renderGenericBundle(json, req);
  }

  /**
   * Render a search result Bundle
   */
  async renderSearchBundle(json, req) {

    // Check if there are any actual search parameters (not just pagination/control params)
    const selfLink = json.link?.find(l => l.relation === 'self')?.url || '';
    const hasSearchParams = this.checkForSearchParams(selfLink);

    // If no search params provided, show the search form
    if (!hasSearchParams) {
      return this.renderSearchForm(json, req);
    }

    // Check if _elements was specified (look in self link)
    const elementsMatch = selfLink.match(/[?&]_elements=([^&]*)/);
    const elements = elementsMatch ? decodeURIComponent(elementsMatch[1]).split(',').map(e => e.trim()) : null;

    if (elements && elements.length > 0) {
      return this.renderSearchTable(json, elements, req);
    }

    // Default: render as summary with individual resources
    return await this.renderSearchSummary(json, req);
  }

  /**
   * Check if URL has any actual search parameters (not just _offset, _count, _elements, _sort)
   */
  checkForSearchParams(url) {
    try {
      const urlObj = new URL(url);
      const controlParams = ['_offset', '_count', '_sort'];

      for (const [key, value] of urlObj.searchParams) {
        if (!controlParams.includes(key) && value) {
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Render search form (when no search params provided)
   */
  async renderSearchForm(json, req) {
    const resourceType = this.getSearchResourceType(json);
    const params = resourceType === 'CodeSystem' ? CODESYSTEM_PARAMS : SEARCH_PARAMS;

    let html = '<div class="alert alert-info">Enter search criteria:</div>';
    html += `<form method="get" action="${escape(req.baseUrl)}/${escape(resourceType)}">`;
    html += '<div class="row">';

    // Build form fields
    for (const param of params) {
      html += '<div class="col-md-4 mb-3">';
      html += `<label for="${param.name}" class="form-label">${escape(param.label)}</label>`;

      if (param.type === 'select') {
        html += `<select name="${param.name}" id="${param.name}" class="form-select">`;
        for (const opt of param.options) {
          html += `<option value="${escape(opt)}">${escape(opt || '(any)')}</option>`;
        }
        html += '</select>';
      } else {
        html += `<input type="text" name="${param.name}" id="${param.name}"/>`;
      }

      html += '</div>';
    }

    html += '</div>';

    // Sort dropdown
    html += '<div class="row">';
    html += '<div class="col-md-4 mb-3">';
    html += '<label for="_sort" class="form-label">Sort By</label>';
    html += '<select name="_sort" id="_sort" class="form-select">';
    for (const opt of SORT_OPTIONS) {
      html += `<option value="${escape(opt)}">${escape(opt || '(default)')}</option>`;
    }
    html += '</select>';
    html += '</div>';
    html += '</div>';

    // Elements checkboxes
    html += '<div class="mb-3">';
    html += '<label class="form-label">Elements to include:</label><br/>';
    for (const elem of ELEMENT_OPTIONS) {
      html += `<div class="form-check form-check-inline">`;
      html += `<input type="checkbox" name="_elements" value="${escape(elem)}" id="elem_${elem}" class="form-check-input"/>`;
      html += `<label for="elem_${elem}" class="form-check-label">${escape(elem)}</label>`;
      html += '</div>';
    }
    html += '</div>';

    html += '<button type="submit" class="btn btn-primary">Search</button>';
    html += '</form>';

    return html;
  }

  /**
   * Get resource type from search bundle (from self link or first entry)
   */
  getSearchResourceType(json) {
    // Try to get from self link first
    const selfLink = json.link?.find(l => l.relation === 'self')?.url || '';
    const typeMatch = selfLink.match(/\/(CodeSystem|ValueSet|ConceptMap)\?/);
    if (typeMatch) {
      return typeMatch[1];
    }

    // Fall back to first entry
    const firstEntry = json.entry?.[0]?.resource;
    return firstEntry?.resourceType || 'Resource';
  }

  /**
   * Build a human-readable description of what this search bundle represents,
   * by parsing the self link URL parameters.
   */
  describeSearchBundle(json) {
    const selfLink = json.link?.find(l => l.relation === 'self')?.url || '';
    if (!selfLink) return '';

    let urlObj;
    try {
      urlObj = new URL(selfLink);
    } catch {
      return '';
    }

    // Extract resource type from path
    const typeMatch = selfLink.match(/\/(CodeSystem|ValueSet|ConceptMap)\b/);
    const resourceType = typeMatch ? typeMatch[1] : 'Resource';

    // Human-friendly labels for search params
    const PARAM_LABELS = {
      'url': 'URL',
      'version': 'Version',
      'name': 'Name',
      'title': 'Title',
      'status': 'Status',
      'publisher': 'Publisher',
      'description': 'Description',
      'identifier': 'Identifier',
      'jurisdiction': 'Jurisdiction',
      'date': 'Date',
      'text': 'Text',
      'system': 'System',
      'supplements': 'Supplements',
      'content-mode': 'Content mode',
      'source': 'Source'
    };

    const WORDS = {
      'url': 'contains',
      'version': 'contains',
      'name': 'contains',
      'title': 'contains',
      'status': 'is',
      'publisher': 'contains',
      'description': 'contains',
      'identifier': 'matches',
      'jurisdiction': 'contains',
      'date': 'matches',
      'text': 'contains',
      'system': 'matches',
      'supplements': 'matches',
      'content-mode': 'is',
      'source': 'is'
    };

    const CONTROL_PARAMS = new Set(['_offset', '_count', '_sort', '_summary', '_elements', '_total']);

    // Collect filter criteria
    const criteria = [];
    for (const [key, value] of urlObj.searchParams) {
      if (key != 'mode') {
        if (CONTROL_PARAMS.has(key) || !value) continue;
        const label = PARAM_LABELS[key] || key;
        const word = WORDS[key] || "contains";
        criteria.push(`<strong>${escape(label)}</strong> ${word} &ldquo;${escape(value)}&rdquo;`);
      }
    }

    // Collect display/pagination context
    const total = json.total;
    const offset = parseInt(urlObj.searchParams.get('_offset') || '0');
    const count = parseInt(urlObj.searchParams.get('_count') || '20');
    const sort = urlObj.searchParams.get('_sort');
    const summary = urlObj.searchParams.get('_summary');
    const elementsParam = urlObj.searchParams.get('_elements');

    // Build the description sentence
    let desc = `Searching <strong>${escape(resourceType)}s</strong>`;

    if (criteria.length > 0) {
      desc += ' where ' + criteria.join(', ');
    } else {
      desc += ' (all)';
    }

    // Pagination context
    if (typeof total === 'number') {
      const from = Math.min(offset + 1, total);
      const to = Math.min(offset + count, total);
      if (total === 0) {
        desc += ' — <strong>no results found</strong>';
      } else {
        desc += ` — showing <strong>${from}–${to}</strong> of <strong>${total}</strong>`;
      }
    }

    // Sort
    if (sort) {
      desc += `, sorted by <strong>${escape(sort)}</strong>`;
    }

    // Summary mode
    if (summary && summary !== 'false') {
      desc += ` [summary: ${escape(summary)}]`;
    }

    // Elements
    if (elementsParam) {
      desc += ` [fields: ${escape(elementsParam)}]`;
    }

    return `<p class="search-description">${desc}</p>`;
  }

  /**
   * Render search results as a table (when _elements is specified)
   */
  async renderSearchTable(json, elements, req) {
    const entries = json.entry || [];

    let html = this.describeSearchBundle(json);

    // Pagination links
    html += this.renderPaginationLinks(json);

    // Build table
    html += '<table class="table table-striped grid">';
    html += '<thead><tr>';
    html += '<th>ID</th>';
    for (const elem of elements) {
      if (elem !== 'id') {
        html += `<th>${escape(elem)}</th>`;
      }
    }
    html += '</tr></thead>';
    html += '<tbody>';

    for (const entry of entries) {
      const resource = entry.resource;
      if (!resource) continue;

      html += '<tr>';

      // ID column with link
      const id = resource.id || '';
      const resourceType = resource.resourceType || '';
      html += `<td><a href="${escape(req.baseUrl)}/${escape(resourceType)}/${escape(id)}">${escape(id)}</a></td>`;

      // Other element columns
      for (const elem of elements) {
        if (elem !== 'id') {
          const value = resource[elem];
          html += `<td>${escape(this.formatValue(value))}</td>`;
        }
      }

      html += '</tr>';
    }

    html += '</tbody></table>';

    // Pagination links again at bottom
    html += this.renderPaginationLinks(json);

    return html;
  }

  /**
   * Render search results as summary with individual resources
   */
  async renderSearchSummary(json, req) {
    const entries = json.entry || [];

    let html = this.describeSearchBundle(json);

    // Pagination links
    html += this.renderPaginationLinks(json);

    // Each entry
    for (const entry of entries) {
      html += '<hr/>';

      if (entry.resource) {
        const resource = entry.resource;
        html += `<h4>${escape(resource.resourceType)}/${escape(resource.id || 'unknown')}</h4>`;

        if (entry.fullUrl) {
          html += `<p><small><a href="${escape(entry.fullUrl)}">${escape(entry.fullUrl)}</a></small></p>`;
        }

        // Render the resource
        html += await this.render(resource, req, true);
      }
    }

    // Pagination links again at bottom
    html += this.renderPaginationLinks(json);

    return html;
  }

  /**
   * Render pagination links
   */
  renderPaginationLinks(json) {
    const links = json.link || [];
    if (links.length === 0) return '';

    let html = '<nav><ul class="pagination">';

    const linkOrder = ['first', 'previous', 'self', 'next', 'last'];

    for (const rel of linkOrder) {
      const link = links.find(l => l.relation === rel);
      if (link) {
        const isDisabled = rel === 'self';
        const label = rel.charAt(0).toUpperCase() + rel.slice(1);

        if (isDisabled) {
          html += `<li class="page-item active"><span class="page-link">${escape(label)}</span></li>`;
        } else {
          html += `<li class="page-item"><a class="page-link" href="${escape(link.url)}">${escape(label)}</a></li>`;
        }
      }
    }

    html += '</ul></nav>';
    return html;
  }

  /**
   * Render a generic bundle (non-search)
   */
  async renderGenericBundle(json, req) {
    let html = '<div class="card mb-3">';
    html += '<div class="card-header">Bundle</div>';
    html += '<div class="card-body">';
    html += `<p><strong>Type:</strong> ${escape(json.type)}</p>`;
    html += `<p><strong>Total:</strong> ${json.total || 'N/A'}</p>`;
    html += '</div>';
    html += '</div>';

    // Links
    if (json.link && json.link.length > 0) {
      html += '<h4>Links</h4>';
      html += '<ul>';
      for (const link of json.link) {
        html += `<li><strong>${escape(link.relation)}:</strong> <a href="${escape(link.url)}">${escape(link.url)}</a></li>`;
      }
      html += '</ul>';
    }

    // Entries
    if (json.entry && json.entry.length > 0) {
      for (const entry of json.entry) {
        html += '<hr/>';
        if (entry.resource) {
          html += await this.render(entry.resource, req, true);
        }
      }
    }

    return html;
  }

  /**
   * Render generic resource (fallback)
   */
  async renderGeneric(json, inBundle) {
    return this.renderResourceWithNarrative(json, inBundle);
  }

  /**
   * Format a value for display
   */
  formatValue(value) {
    if (value === null || value === undefined) {
      return '';
    }
    if (typeof value === 'object') {
      return JSON.stringify(value);
    }
    return String(value);
  }

  /**
   * Generate a unique ID for collapsible sections
   */
  let
  resourceIdCounter = 0;

  generateResourceId() {
    return 'resource_' + (++this.resourceIdCounter);
  }


  /**
   * Render resource with text/div narrative and collapsible JSON source
   */
  async renderResourceWithNarrative(json, rendered) {
    let html = '';

    // Show text/div narrative if present
    if (rendered) {
      html += '<div class="narrative">';
      html += rendered;  // Already HTML, render as-is
      html += '</div>';
    } else {
      html += '<div class="narrative">(No Narrative)</div>';
    }

    return html;
  }

  async renderResourceJson(json) {
    let html = "";
    html += `<div class="json-content" style="margin-top: 10px;">`;
    html += `<pre>${escape(JSON.stringify(json, null, 2))}</pre>`;
    html += '</div>';
    return html;
  }

  convertResourceToXml(res) {
    switch (res.resourceType) {
      case "CodeSystem" : return CodeSystemXML.toXml(res);
      case "ValueSet" : return ValueSetXML.toXml(res);
      case "Bundle" : return BundleXML.toXml(res, this.fhirVersion);
      case "CapabilityStatement" : return CapabilityStatementXML.toXml(res, "R5");
      case "TerminologyCapabilities" : return TerminologyCapabilitiesXML.toXml(res, "R5");
      case "Parameters": return ParametersXML.toXml(res, this.fhirVersion);
      case "OperationOutcome": return OperationOutcomeXML.toXml(res, this.fhirVersion);
    }
    throw new Error(`Resource type ${res.resourceType} not supported in XML`);
  }

  async renderResourceXml(json) {
    let xml = this.convertResourceToXml(json);
    let html = "";
    html += `<div class="xml-content" style="margin-top: 10px;">`;
    html += `<pre>${escape(xml)}</pre>`;
    html += '</div>';
    return html;
  }

  // eslint-disable-next-line no-unused-vars
  async renderOperationsForm(json, req) {
    const vcSystemId = this.generateResourceId();
    const inferSystemId = this.generateResourceId();

    return await this.liquid.renderFile('operations-form', {
      vcSystemId,
      inferSystemId,
      valueSetsJson: JSON.stringify(json.valueSets || [])
    });
  }

  async buildInfoPage(source, req) {
    let html = '';
    const infoContent = await source.info(req);
    html += infoContent;
    return html;
  }

  buildSourceOptions(provider) {
    let result = '<option value=""></option>';
    result += `<option value="internal">internal</option>`;
    for (let sp of provider.listValueSetSourceCodes()) {
      result += `<option value="${sp}">${sp}</option>`;
    }
    return result;
  }
}

module.exports = {
  TxHtmlRenderer, loadTemplate, acceptsHtml,
  setPublishLibrarySource, publishesLibrarySource, highlightYaml, buildLibrarySourcePage
};