//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// Serves a module's hand-maintained OpenAPI description: loads the YAML file, sets
// info.version from package.json, and renders it as an HTML reference page. Used by the
// package server (packages/openapi.yaml) and the terminology registry (registry/openapi.yaml);
// each module has its own, independent spec.

const fs = require('fs');
const YAML = require('yaml');
const escape = require('escape-html');
const commonmark = require('commonmark');
const packageJson = require('../package.json');

// patterns longer than this are collapsed
const PATTERN_INLINE = 40;

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

function commonmarkHtml(text) {
  const reader = new commonmark.Parser();
  const writer = new commonmark.HtmlRenderer({ safe: true });
  return writer.render(reader.parse(text));
}

// GitHub-style pipe tables, which CommonMark doesn't have (and the terminology server's
// operations use, for their parameters): a header row, a delimiter row, and the rows
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_DELIMITER = /^\s*\|(\s*:?-+:?\s*\|)+\s*$/;

function tableCells(line) {
  const cells = [];
  let cell = '';
  const s = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '\\') {
      // an escaped backslash, left for CommonMark (so \\| is a backslash, then the next cell)
      cell += '\\\\';
      i++;
    } else if (s[i] === '\\' && s[i + 1] === '|') {
      cell += '|';
      i++;
    } else if (s[i] === '|') {
      cells.push(cell.trim());
      cell = '';
    } else {
      cell += s[i];
    }
  }
  cells.push(cell.trim());
  return cells;
}

function tableCellHtml(text) {
  return commonmarkHtml(text).trim().replace(/^<p>([\s\S]*)<\/p>$/, '$1');
}

function tableHtml(header, rows) {
  let html = '<table class="table table-condensed"><thead><tr>';
  html += header.map(h => `<th>${tableCellHtml(h)}</th>`).join('');
  html += '</tr></thead><tbody>';
  for (const row of rows) {
    html += '<tr>' + header.map((h, i) => `<td>${tableCellHtml(row[i] || '')}</td>`).join('') + '</tr>';
  }
  return html + '</tbody></table>';
}

function markdown(text) {
  if (!text) {
    return '';
  }
  const lines = text.split('\n');
  const out = [];
  let buf = [];
  const flush = () => {
    if (buf.length > 0) {
      out.push(commonmarkHtml(buf.join('\n')));
      buf = [];
    }
  };
  for (let i = 0; i < lines.length; i++) {
    if (TABLE_ROW.test(lines[i]) && i + 1 < lines.length && TABLE_DELIMITER.test(lines[i + 1])) {
      flush();
      const header = tableCells(lines[i]);
      const rows = [];
      i += 2;
      while (i < lines.length && TABLE_ROW.test(lines[i])) {
        rows.push(tableCells(lines[i]));
        i++;
      }
      i--;
      out.push(tableHtml(header, rows));
    } else {
      buf.push(lines[i]);
    }
  }
  flush();
  return out.join('');
}

// Resolves a local '#/components/...' reference.
function resolveRef(spec, obj) {
  if (!obj || !obj.$ref) {
    return obj;
  }
  let target = spec;
  for (const part of obj.$ref.replace(/^#\//, '').split('/')) {
    target = target ? target[part] : undefined;
  }
  return target;
}

function refName(ref) {
  return ref.substring(ref.lastIndexOf('/') + 1);
}

function schemaLink(name) {
  return `<a href="#schema-${escape(name)}"><code>${escape(name)}</code></a>`;
}

// A one-line description of a schema: a link for a reference, otherwise its type and the
// constraints a client needs to know.
function describeSchema(schema) {
  if (!schema) {
    return '';
  }
  if (schema.$ref) {
    return schemaLink(refName(schema.$ref));
  }
  if (schema.allOf) {
    return schema.allOf.map(describeSchema).join(' + ');
  }
  if (schema.oneOf || schema.anyOf) {
    return (schema.oneOf || schema.anyOf).map(describeSchema).join(' or ');
  }
  if (schema.const !== undefined) {
    return `<code>${escape(JSON.stringify(schema.const))}</code>`;
  }
  if (schema.type === 'array') {
    return `array of ${describeSchema(schema.items)}`;
  }
  if (schema.type === 'object' && schema.additionalProperties && !schema.properties) {
    return `map of ${describeSchema(schema.additionalProperties)}`;
  }
  const parts = [`<code>${escape(schema.type || 'any')}</code>`];
  if (schema['x-fhir-type']) {
    parts.push(`(FHIR <code>${escape(schema['x-fhir-type'])}</code>)`);
  }
  if (schema.format) {
    parts.push(`(${escape(schema.format)})`);
  }
  if (schema.enum) {
    parts.push('one of ' + schema.enum.map(v => `<code>${escape(String(v))}</code>`).join(', '));
  } else if (schema.pattern && schema.pattern.length <= PATTERN_INLINE) {
    parts.push(`matching <code>${escape(schema.pattern)}</code>`);
  } else if (schema.pattern) {
    // long regexes (FHIR's dateTime one is over 200 characters) are shown on demand
    parts.push(`<details class="pattern"><summary>pattern</summary><code>${escape(schema.pattern)}</code></details>`);
  }
  if (schema.maxLength) {
    parts.push(`max ${schema.maxLength} chars`);
  }
  if (schema.default !== undefined) {
    parts.push(`default <code>${escape(String(schema.default))}</code>`);
  }
  return parts.join(' ');
}

function renderParameters(spec, parameters) {
  if (!parameters || parameters.length === 0) {
    return '';
  }
  let html = '<h5>Parameters</h5><table class="table table-condensed"><thead><tr>' +
    '<th>Name</th><th>In</th><th>Schema</th><th>Description</th></tr></thead><tbody>';
  for (const p of parameters.map(p => resolveRef(spec, p))) {
    html += '<tr>';
    html += `<td><code>${escape(p.name)}</code>${p.required ? ' <span class="label label-default">required</span>' : ''}</td>`;
    html += `<td>${escape(p.in)}</td>`;
    html += `<td>${describeSchema(p.schema)}</td>`;
    html += `<td>${markdown(p.description)}</td>`;
    html += '</tr>';
  }
  return html + '</tbody></table>';
}

function renderResponses(spec, responses) {
  let html = '<h5>Responses</h5><table class="table table-condensed"><thead><tr>' +
    '<th>Status</th><th>Description</th><th>Content</th></tr></thead><tbody>';
  for (const [status, r] of Object.entries(responses || {})) {
    const response = resolveRef(spec, r);
    const content = Object.entries(response.content || {})
      .map(([type, media]) => `<code>${escape(type)}</code>: ${describeSchema(media.schema)}`)
      .join('<br/>');
    html += `<tr><td>${escape(status)}</td><td>${markdown(response.description)}</td><td>${content}</td></tr>`;
  }
  return html + '</tbody></table>';
}

function renderSchema(name, schema) {
  let html = `<div class="openapi-schema" id="schema-${escape(name)}"><h4><code>${escape(name)}</code></h4>`;
  html += markdown(schema.description);
  if (schema.properties) {
    const required = new Set(schema.required || []);
    html += '<table class="table table-condensed"><thead><tr><th>Property</th><th>Schema</th><th>Description</th></tr></thead><tbody>';
    for (const [prop, propSchema] of Object.entries(schema.properties)) {
      html += '<tr>';
      html += `<td><code>${escape(prop)}</code>${required.has(prop) ? ' <span class="label label-default">required</span>' : ''}</td>`;
      html += `<td>${describeSchema(propSchema)}</td>`;
      html += `<td>${markdown(propSchema.description)}</td>`;
      html += '</tr>';
    }
    html += '</tbody></table>';
    if (schema.additionalProperties) {
      html += `<p>Other properties: ${describeSchema(schema.additionalProperties)}</p>`;
    }
  } else {
    html += `<p>${describeSchema(schema)}</p>`;
  }
  return html + '</div>';
}

// ---- "try it" ----
//
// Each GET operation gets a form built from its documented parameters; Send makes the request
// with fetch(), asking for the operation's JSON (not HTML - a browser following the link
// would get the web page), and shows the URL, the status, some headers, the body, and the
// same request as a curl command. Other methods get an example curl command only: trying a
// POST from a public page would create real resources.

/**
 * The request a try-it form describes. Runs in the browser (it's serialised into the page)
 * and in the tests.
 *
 * @param {string} pathTemplate - e.g. /packages/{id}/{version}
 * @param {Array<{in: string, name: string, value: string}>} values - the form's fields
 * @returns {{url: string, headers: Object, missing: string[]}}
 */
function buildTryItRequest(pathTemplate, values) {
  const missing = [];
  let url = pathTemplate;
  const query = [];
  const headers = {};
  for (const v of values) {
    const value = (v.value || '').trim();
    if (v.in === 'path') {
      if (!value) {
        missing.push(v.name);
      }
      url = url.split('{' + v.name + '}').join(encodeURIComponent(value));
    } else if (!value) {
      continue;
    } else if (v.in === 'query') {
      query.push(encodeURIComponent(v.name) + '=' + encodeURIComponent(value));
    } else if (v.in === 'header') {
      headers[v.name] = value;
    }
  }
  if (query.length > 0) {
    url += '?' + query.join('&');
  }
  return { url, headers, missing };
}

/** A curl command for a request; quoted for a POSIX shell. */
function curlCommand(method, url, headers, dataFile) {
  const q = (s) => "'" + String(s).split("'").join("'\\''") + "'";
  let cmd = 'curl';
  if (method !== 'GET') {
    cmd += ' -X ' + method;
  }
  for (const [k, v] of Object.entries(headers)) {
    cmd += ' -H ' + q(k + ': ' + v);
  }
  if (dataFile) {
    cmd += ' --data-binary @' + dataFile;
  }
  return cmd + ' ' + q(url);
}

// The page script: wires up every try-it form, and fills in the absolute URLs of the
// example curl commands.
function tryItScript() {
  const MAX_SHOW = 200000;
  document.querySelectorAll('form.try-it').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      const values = Array.prototype.map.call(form.querySelectorAll('[data-in]'), function (el) {
        return { in: el.dataset.in, name: el.dataset.name, value: el.value };
      });
      const req = buildTryItRequest(form.dataset.path, values);
      const out = form.querySelector('.try-result');
      const show = function (cls, text) {
        out.querySelector(cls).textContent = text;
      };
      out.hidden = false;
      if (req.missing.length > 0) {
        show('.try-status', 'Required: ' + req.missing.join(', '));
        show('.try-url', '');
        show('.try-curl', '');
        show('.try-body', '');
        return;
      }
      const headers = Object.assign({ Accept: form.dataset.accept }, req.headers);
      show('.try-url', 'GET ' + req.url);
      show('.try-curl', curlCommand('GET', location.origin + req.url, headers));
      show('.try-status', 'Sending...');
      show('.try-body', '');
      const started = Date.now();
      fetch(req.url, { headers: headers }).then(function (res) {
        const type = res.headers.get('Content-Type') || '';
        let status = res.status + ' ' + res.statusText + ' (' + (Date.now() - started) + 'ms)';
        status += '\nContent-Type: ' + type;
        ['Location', 'Last-Modified', 'Link'].forEach(function (h) {
          if (res.headers.get(h)) {
            status += '\n' + h + ': ' + res.headers.get(h);
          }
        });
        show('.try-status', status);
        if (/json|text|xml|yaml/.test(type)) {
          return res.text().then(function (text) {
            let body = text;
            if (/json/.test(type)) {
              try {
                body = JSON.stringify(JSON.parse(text), null, 2);
              } catch (err) {
                // show it as it came
              }
            }
            if (body.length > MAX_SHOW) {
              body = body.substring(0, MAX_SHOW) + '\n... (' + body.length + ' characters; the rest is not shown)';
            }
            show('.try-body', body);
          });
        }
        return res.blob().then(function (b) {
          show('.try-body', '(' + b.size + ' bytes of ' + (type || 'unknown content') + ')');
        });
      }).catch(function (err) {
        show('.try-status', 'The request failed: ' + err.message);
      });
    });
  });
  document.querySelectorAll('.try-example').forEach(function (el) {
    el.textContent = curlCommand(el.dataset.method, location.origin + el.dataset.path,
      JSON.parse(el.dataset.headers), el.dataset.file || null);
  });
}

// The content type a try-it request asks for: the success response's first non-HTML one.
function tryItAccept(op) {
  const ok = Object.keys(op.responses || {}).find(s => /^2/.test(s));
  const types = ok ? Object.keys((op.responses[ok] && op.responses[ok].content) || {}) : [];
  return types.find(t => t !== 'text/html') || 'application/json';
}

function renderTryIt(spec, method, fullPath, item, op) {
  const params = [...(item.parameters || []), ...(op.parameters || [])].map(p => resolveRef(spec, p));
  if (method !== 'get') {
    // an example only
    const headers = {};
    let file = null;
    const content = op.requestBody && resolveRef(spec, op.requestBody).content;
    if (content) {
      headers['Content-Type'] = Object.keys(content)[0];
      file = 'body.json';
    }
    if ((op.security || []).some(s => Object.keys(s).length > 0)) {
      headers.Authorization = 'Bearer {token}';
    }
    return '<h5>Example</h5><pre class="try-example" data-method="' + method.toUpperCase() +
      '" data-path="' + escape(fullPath) + '" data-headers="' + escape(JSON.stringify(headers)) + '"' +
      (file ? ' data-file="' + file + '"' : '') + '></pre>';
  }
  // closed until wanted: the summary is the button that opens it
  let html = '<details class="try-it-panel"><summary class="btn btn-default btn-sm try-btn">Try it</summary>';
  html += `<form class="try-it" data-path="${escape(fullPath)}" data-accept="${escape(tryItAccept(op))}">`;
  if (params.length > 0) {
    html += '<table class="table table-condensed"><tbody>';
    for (const p of params) {
      const id = `try-${escape(op.operationId || '')}-${escape(p.in)}-${escape(p.name)}`;
      const attrs = `id="${id}" data-in="${escape(p.in)}" data-name="${escape(p.name)}" class="form-control input-sm"`;
      html += `<tr><td style="width: 30%"><label for="${id}"><code>${escape(p.name)}</code>` +
        `${p.required ? ' <span class="label label-default">required</span>' : ''}` +
        `${p.in !== 'query' ? ` <small>(${escape(p.in)})</small>` : ''}</label></td><td>`;
      const schema = resolveRef(spec, p.schema) || {};
      if (Array.isArray(schema.enum)) {
        html += `<select ${attrs}><option value=""></option>` +
          schema.enum.map(v => `<option>${escape(String(v))}</option>`).join('') + '</select>';
      } else {
        const example = p.example !== undefined ? String(p.example) : '';
        // a required path parameter starts with its example, so Send works straight away
        const value = p.in === 'path' && example ? ` value="${escape(example)}"` : '';
        html += `<input type="text" ${attrs}${value} placeholder="${escape(example)}"/>`;
      }
      html += '</td></tr>';
    }
    html += '</tbody></table>';
  }
  html += '<button type="submit" class="btn btn-primary btn-sm">Send</button>';
  html += '<div class="try-result" hidden>' +
    '<pre class="try-url"></pre><pre class="try-curl"></pre>' +
    '<pre class="try-status"></pre><pre class="try-body"></pre></div>';
  return html + '</form></details>';
}

// The page's own styles. The site's stylesheet is Bootstrap 3, so these use its classes
// (panel, table-condensed, label, input-sm, btn-default) and fill in the rest.
const PAGE_STYLE = `<style>
.openapi-ref td, .openapi-ref th { vertical-align: top; }
.openapi-ref td code, .openapi-ref td { overflow-wrap: anywhere; }
.openapi-ref pre { white-space: pre-wrap; overflow-wrap: anywhere; }
.openapi-ref hr { border-top: 2px solid #ccc; margin: 24px 0; }
.openapi-ref .openapi-schema { margin-bottom: 24px; }
.openapi-ref details.pattern { display: inline; }
.openapi-ref details.pattern > summary { display: inline; cursor: pointer; color: #555; text-decoration: underline dotted; }
.openapi-ref details.pattern[open] > code { display: block; margin-top: 4px; }
.openapi-ref summary.try-btn { list-style: none; display: inline-block; margin: 4px 0 8px; font-weight: bold;
  color: #333; background-color: #fff; border: 1px solid #adadad; box-shadow: 0 1px 2px rgba(0,0,0,0.15); }
.openapi-ref summary.try-btn:hover { background-color: #ebebeb; color: #333; }
.openapi-ref summary.try-btn::-webkit-details-marker { display: none; }
.openapi-ref summary.try-btn::before { content: '\\25B6\\00a0'; font-size: 80%; }
.openapi-ref details[open] > summary.try-btn::before { content: '\\25BC\\00a0'; }
.openapi-ref details[open] > summary.try-btn { background-color: #e6e6e6; color: #333; box-shadow: inset 0 2px 3px rgba(0,0,0,0.15); }
.openapi-ref form.try-it { border: 1px solid #ddd; border-radius: 4px; padding: 8px 12px; margin-bottom: 8px; background: #fafafa; }
.openapi-ref .try-result { margin-top: 8px; }
.openapi-ref .try-body { max-height: 30em; overflow: auto; }
</style>`;

function buildHtml(spec, BASE_PATH) {
  let html = PAGE_STYLE + '<div class="openapi-ref">';
  html += `<h1>${escape(spec.info.title)} API</h1>`;
  html += `<p class="lead">${escape(spec.info.summary || '')}</p>`;
  html += `<p>Machine-readable description (OpenAPI ${escape(spec.openapi)}): ` +
    `<a href="${BASE_PATH}/openapi.json">openapi.json</a> &middot; ` +
    `<a href="${BASE_PATH}/openapi.yaml">openapi.yaml</a></p>`;
  html += markdown(spec.info.description);
  if (spec.externalDocs) {
    html += `<p>See also: <a href="${escape(spec.externalDocs.url)}">${escape(spec.externalDocs.description || spec.externalDocs.url)}</a></p>`;
  }

  html += '<h2>Endpoints</h2>';
  // an index, when there are enough of them to need one
  const all = Object.entries(spec.paths).flatMap(([p, item]) => METHODS.filter(m => item[m]).map(m => [p, m, item[m]]));
  if (all.length > 12) {
    html += '<table class="table table-condensed"><tbody>';
    for (const [p, method, op] of all) {
      html += `<tr><td><span class="label label-default">${method.toUpperCase()}</span></td>` +
        `<td><a href="#${escape(op.operationId || '')}"><code>${escape(BASE_PATH + p)}</code></a></td><td>${escape(op.summary || '')}</td></tr>`;
    }
    html += '</tbody></table>';
  }
  let first = true;
  for (const [p, item] of Object.entries(spec.paths)) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op) {
        continue;
      }
      if (!first) {
        html += '<hr/>';
      }
      first = false;
      html += `<div class="panel panel-default" id="${escape(op.operationId || '')}"><div class="panel-heading">`;
      html += `<span class="label label-primary">${method.toUpperCase()}</span> <code>${escape(BASE_PATH + p)}</code> &mdash; ${escape(op.summary || '')}`;
      html += '</div><div class="panel-body">';
      html += markdown(op.description);
      html += renderParameters(spec, [...(item.parameters || []), ...(op.parameters || [])]);
      html += renderResponses(spec, op.responses);
      html += renderTryIt(spec, method, BASE_PATH + p, item, op);
      html += '</div></div>';
    }
  }

  html += '<hr/><h2>Schemas</h2>';
  for (const [name, schema] of Object.entries((spec.components && spec.components.schemas) || {})) {
    html += renderSchema(name, schema);
  }
  html += '</div>';
  html += '<script>\n' + buildTryItRequest.toString() + '\n' + curlCommand.toString() + '\n(' +
    tryItScript.toString() + ')();\n</script>';
  return html;
}

/**
 * @param {string} specPath - the YAML file
 * @param {string} basePath - where the module is mounted (e.g. '/packages'); used for links
 *   and to show full paths in the HTML reference
 * @param {Object} [options]
 * @param {string} [options.schemasPath] - a generated schemas file (see
 *   utilities/generate-openapi-schemas.js) whose schemas are merged into components.schemas.
 *   A schema in the YAML of the same name wins.
 * @param {Function} [options.build] - adds to the spec once it's loaded (paths made from
 *   data, say). The YAML served is then the whole spec, not the file
 * @param {string} [options.serverUrl] - the server url, when the module is mounted in more
 *   than one place (the YAML's servers are replaced)
 */
function createOpenApiDoc(specPath, basePath, options = {}) {
  let cachedYaml = null;
  let cachedSpec = null;
  let cachedHtml = null;

  function getYaml() {
    if (cachedYaml === null) {
      cachedYaml = options.build || options.serverUrl
        ? YAML.stringify(getSpec(), { lineWidth: 0 })
        : fs.readFileSync(specPath, 'utf8');
    }
    return cachedYaml;
  }

  // The parsed spec, with info.version set to this server's version. Callers get a copy, so
  // nothing can modify the cached one.
  function getSpec() {
    if (cachedSpec === null) {
      const spec = YAML.parse(fs.readFileSync(specPath, 'utf8'));
      spec.info.version = packageJson.version;
      if (options.serverUrl) {
        spec.servers = [{ url: options.serverUrl }];
      }
      if (options.schemasPath) {
        const generated = JSON.parse(fs.readFileSync(options.schemasPath, 'utf8'));
        spec.components = spec.components || {};
        spec.components.schemas = { ...generated.schemas, ...(spec.components.schemas || {}) };
      }
      if (options.build) {
        options.build(spec);
      }
      cachedSpec = spec;
    }
    return structuredClone(cachedSpec);
  }

  // The body of the HTML reference page (to be wrapped in the module's page template).
  function renderHtml() {
    if (cachedHtml === null) {
      cachedHtml = buildHtml(getSpec(), basePath);
    }
    return cachedHtml;
  }

  return { getSpec, getYaml, renderHtml, SPEC_PATH: specPath, BASE_PATH: basePath };
}

module.exports = { createOpenApiDoc, buildTryItRequest, curlCommand, markdown };
