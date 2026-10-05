//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// The terminology server's OpenAPI description (R5 endpoints only): openapi.yaml (the
// overview, /metadata, /$versions, the shared components), plus the paths made here from
// the operations in openapi-operations.js and the read and search interactions, plus the
// FHIR resource schemas generated into openapi-schemas.json (see openapi-schemas.config.js).

const path = require('path');
const { createOpenApiDoc } = require('../library/openapi-doc');
const { OPERATIONS, COMMON } = require('./openapi-operations');

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const param = (name) => ({ $ref: `#/components/parameters/${name}` });

const RESOURCE_TYPES = ['CodeSystem', 'ValueSet', 'ConceptMap'];

const PRIMITIVES = new Set([
  'boolean', 'canonical', 'code', 'date', 'dateTime', 'decimal', 'id', 'instant', 'integer',
  'integer64', 'markdown', 'oid', 'positiveInt', 'string', 'time', 'unsignedInt', 'uri', 'url', 'uuid'
]);

function isPrimitive(type) {
  return PRIMITIVES.has(type);
}

/** The JSON schema of a primitive parameter, as a query parameter. */
function querySchema(type) {
  switch (type) {
    case 'boolean': return { type: 'boolean' };
    case 'integer': return { type: 'integer' };
    case 'positiveInt': return { type: 'integer', minimum: 1 };
    case 'unsignedInt': return { type: 'integer', minimum: 0 };
    case 'decimal': return { type: 'number' };
    default: return { type: 'string', 'x-fhir-type': type };
  }
}

function cell(s) {
  return String(s || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function typeCell(p) {
  if (p.type === '(parts)') {
    return 'parts';
  }
  return isPrimitive(p.type) ? `\`${p.type}\`` : p.type;
}

/** A markdown table of parameters. */
function paramTable(params, inbound) {
  const rows = [];
  for (const p of params) {
    let doc = p.doc || '';
    if (inbound && !isPrimitive(p.type)) {
      doc += (doc ? ' ' : '') + '(POST, in a Parameters resource, only)';
    }
    rows.push(`| \`${cell(p.name)}\` | ${typeCell(p)} | ${p.min}..${p.max} | ${cell(doc)} |`);
    for (const part of p.parts || []) {
      rows.push(`| &nbsp;&nbsp;\`${cell(p.name)}.${cell(part.name)}\` | ${typeCell(part)} | ${part.min}..${part.max} | ${cell(part.doc)} |`);
    }
  }
  return '| Name | Type | Card. | Description |\n|---|---|---|---|\n' + rows.join('\n');
}

function camel(s) {
  return s.replace(/-([a-z])/g, (m, c) => c.toUpperCase());
}

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function errorResponses(extra = {}) {
  return {
    '400': { $ref: '#/components/responses/Outcome', description: 'The request is not valid' },
    '404': { $ref: '#/components/responses/Outcome', description: 'Something the request names was not found' },
    '422': { $ref: '#/components/responses/Outcome', description: 'The request could not be processed (e.g. the value set is not valid, or the expansion is too large)' },
    '500': { $ref: '#/components/responses/Outcome', description: 'The server failed' },
    ...extra
  };
}

function okResponse(op) {
  const schema = ref(op.returns || 'Parameters');
  return {
    description: op.returnsDoc || 'The out parameters (see the table)',
    content: { 'application/fhir+json': { schema }, 'application/json': { schema } }
  };
}

/** The paths of one operation: its levels, and its methods. */
function queryParameter(qp) {
  const schema = querySchema(qp.type);
  const result = {
    name: qp.name,
    in: 'query',
    description: qp.doc,
    schema: qp.max === '*' ? { type: 'array', items: schema } : schema
  };
  if (qp.min > 0) {
    result.required = true;
  }
  if (qp.max === '*') {
    result.style = 'form';
    result.explode = true;
  }
  return result;
}

function formSchema(params) {
  const form = { type: 'object', properties: {} };
  for (const fp of params) {
    form.properties[fp.name] = fp.max === '*' ? { type: 'array', items: querySchema(fp.type) } : querySchema(fp.type);
  }
  return form;
}

/** The common parameters: in the overview, and as components the operations refer to. */
function addCommon(spec) {
  spec.info.description += '\n**Common parameters.** These are read by $expand, $validate-code, ' +
    '$lookup, $subsumes, $translate and $compare, as well as their own parameters:\n\n' + paramTable(COMMON, true) + '\n';
  for (const cp of COMMON.filter(x => isPrimitive(x.type))) {
    spec.components.parameters[`common-${cp.name}`] = queryParameter(cp);
  }
}

function addOperation(spec, op) {
  const methods = op.methods || ['get', 'post'];
  const queryParams = op.in.filter(p => isPrimitive(p.type));
  const commonQuery = op.common ? COMMON.filter(x => isPrimitive(x.type)) : [];
  let description = (op.description || '') + '\n\n**In parameters**' +
    (op.common ? ' (and the common parameters - see the overview)' : '') + '\n\n' + paramTable(op.in, true);
  if (op.out) {
    description += '\n\n**Out parameters** (a Parameters resource)\n\n' + paramTable(op.out, false);
  }
  for (const level of op.levels) {
    const p = level === 'system' ? `/$${op.name}`
      : level === 'type' ? `/${op.resource}/$${op.name}`
        : `/${op.resource}/{id}/$${op.name}`;
    const item = spec.paths[p] = spec.paths[p] || {};
    const baseId = camel(op.name) + (op.resource || '') + (level === 'instance' ? 'Instance' : '');
    const common = [param('acceptLanguage'), param('cacheId'), param('format')];
    if (level === 'instance') {
      common.unshift(param('id'));
    }
    const levelDoc = level === 'instance' ? `\n\nThe ${op.resource} is the one with this id.` : '';
    for (const method of methods) {
      const o = {
        tags: [op.resource || 'Server'],
        operationId: method === 'get' || methods.length === 1 ? baseId : baseId + 'Post',
        summary: op.summary,
        description: description + levelDoc
      };
      if (method === 'get') {
        o.parameters = [...common, ...queryParams.map(queryParameter), ...commonQuery.map(cp => param(`common-${cp.name}`))];
      } else {
        // parameters that are in the query even for a POST
        o.parameters = [...common, ...op.in.filter(x => x.inQuery).map(qp => ({
          name: qp.name, in: 'query', description: qp.doc, required: qp.min > 0, schema: querySchema(qp.type)
        }))];
        const bodies = op.postBody || ['Parameters'];
        const schema = bodies.length === 1 ? ref(bodies[0]) : { anyOf: bodies.map(ref) };
        const form = formSchema([...queryParams.filter(x => !x.inQuery), ...commonQuery]);
        o.requestBody = {
          required: true,
          description: bodies.length === 1 ? 'The in parameters, as a Parameters resource (or a form)'
            : `The in parameters, as a Parameters resource (or a form), or the ${bodies[1]} itself`,
          content: {
            'application/fhir+json': { schema },
            'application/json': { schema },
            'application/x-www-form-urlencoded': { schema: form }
          }
        };
      }
      o.responses = { '200': okResponse(op), ...errorResponses(op.responses || {}) };
      item[method] = o;
    }
  }
}

const SEARCH_DOCS = {
  url: 'The canonical url (exact)',
  system: 'The canonical url (exact; the same as url)',
  version: 'The version (contains)',
  name: 'The name (contains)',
  title: 'The title (contains)',
  status: 'The status (contains)',
  publisher: 'The publisher (contains)',
  description: 'The description (contains)',
  date: 'The date (contains)',
  identifier: 'An identifier (contains)',
  jurisdiction: 'A jurisdiction: a code or display (contains)',
  text: 'The title or description (contains)',
  'content-mode': 'CodeSystem: the content mode (contains)',
  supplements: 'CodeSystem: what it supplements (contains)',
  'source-system': 'ConceptMap: the source code system',
  'target-system': 'ConceptMap: the target code system',
  _offset: 'Paging: where to start (0 based)',
  _count: 'Paging: how many to return (at most 200, or 2000 with _elements)',
  _elements: 'The elements to return (comma separated)',
  _sort: 'The element to sort by (default id)',
  _summary: '`true`, `text`, `data`, `count` or `false`',
  _total: '`none` to leave out the total (default accurate)'
};

/** Read, and search (GET, and POST _search), for each resource type. */
function addReadSearch(spec) {
  // required here: the search worker requires tx-html, which requires this
  const SEARCH_PARAMS = require('./workers/search').ALLOWED_PARAMS;
  for (const type of RESOURCE_TYPES) {
    const searchParams = SEARCH_PARAMS.filter(n => n !== '_format').map(n => ({
      name: n,
      in: 'query',
      description: SEARCH_DOCS[n] || '',
      schema: ['_offset', '_count'].includes(n) ? { type: 'integer', minimum: 0 } : { type: 'string' }
    }));
    if (type !== 'CodeSystem') {
      searchParams.push({ name: 'source', in: 'query', description: 'Only those from this source (package)', schema: { type: 'string' } });
    }
    const bundle = ref(`${type}SearchBundle`);
    const searchDoc = `Searches the ${type}s the server has. Text matches are case insensitive and partial ` +
      '(contains), except url and system; all the parameters given must match.';
    const searchResponses = {
      '200': { description: `A searchset Bundle of ${type}s`, content: { 'application/fhir+json': { schema: bundle } } },
      '500': { $ref: '#/components/responses/Outcome' }
    };
    spec.paths[`/${type}`] = {
      get: {
        tags: [type], operationId: `search${type}`, summary: `Search ${type}s`, description: searchDoc,
        parameters: [...searchParams, param('format')], responses: searchResponses
      }
    };
    const form = { type: 'object', properties: {} };
    searchParams.forEach(sp => {
      form.properties[sp.name] = sp.schema;
    });
    spec.paths[`/${type}/_search`] = {
      post: {
        tags: [type], operationId: `search${type}Post`, summary: `Search ${type}s (POST)`,
        description: searchDoc + ' The parameters are in a form body.',
        requestBody: { content: { 'application/x-www-form-urlencoded': { schema: form } } },
        responses: searchResponses
      }
    };
    spec.paths[`/${type}/{id}`] = {
      get: {
        tags: [type], operationId: `read${type}`, summary: `Read a ${type}`,
        parameters: [param('id'), param('format')],
        responses: {
          '200': { description: `The ${type}`, content: { 'application/fhir+json': { schema: ref(type) } } },
          '404': { $ref: '#/components/responses/Outcome', description: 'There is no such resource' }
        }
      }
    };
  }
}

function build(spec) {
  addCommon(spec);
  addReadSearch(spec);
  for (const op of OPERATIONS) {
    addOperation(spec, op);
  }
}

const SPEC_PATH = path.join(__dirname, 'openapi.yaml');
const SCHEMAS_PATH = path.join(__dirname, 'openapi-schemas.json');

const docs = new Map();

/**
 * The description, for an R5 endpoint (its servers url is the endpoint)
 * @param {string} endpointPath - e.g. /tx/r5
 */
function forEndpoint(endpointPath) {
  if (!docs.has(endpointPath)) {
    docs.set(endpointPath, createOpenApiDoc(SPEC_PATH, endpointPath,
      { schemasPath: SCHEMAS_PATH, build, serverUrl: endpointPath }));
  }
  return docs.get(endpointPath);
}

/** Whether an endpoint's FHIR version is the one described (R5) */
function describes(fhirVersion) {
  return String(fhirVersion).startsWith('5');
}

module.exports = { forEndpoint, describes, isPrimitive, RESOURCE_TYPES, SEARCH_DOCS };
