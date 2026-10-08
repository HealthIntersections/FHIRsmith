// Keeps the terminology server's OpenAPI description (tx/openapi.yaml, the operations in
// tx/openapi-operations.js, and the generated tx/openapi-schemas.json) honest against the
// module: the routes, the parameters the code reads, the generated schemas being up to date
// - and real responses validating against the schemas.

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const Ajv2020 = require('ajv/dist/2020');

const { getTestApp, getTxModule, shutdownTestApp } = require('./setup');
const txOpenApi = require('../../tx/openapi');
const { OPERATIONS, COMMON, EXPANSION, VALIDATION } = require('../../tx/openapi-operations');
const config = require('../../tx/openapi-schemas.config');
const { generateSchemas } = require('../../library/fhir-openapi-schema');
const { packageDir } = require('../../utilities/generate-openapi-schemas');
const packageJson = require('../../package.json');
const { routerRoutes, specRoutes, operations, describeSpecBasics } = require('../utils/openapi-helpers');

const ENDPOINT = '/tx/r5';
const TX = path.join(__dirname, '../../tx');

// Routes the description deliberately leaves out, with the reason
const EXCLUDED = {
  'GET /': 'the home page (HTML)',
  'GET /op.html': 'the operations page (HTML)',
  'GET /ecl': 'the ECL page (HTML)',
  'GET /problems.html': 'the problems page (HTML)',
  'GET /info/{id}': 'an external source\'s page (HTML)',
  'POST /info/{id}': 'an external source\'s page (HTML form)',
  'GET /library': 'the library source (HTML, or the operator\'s YAML)',
  'GET /openapi': 'the description itself',
  'GET /openapi.json': 'the description itself',
  'GET /openapi.yaml': 'the description itself',
  'GET /CodeSystem/$batch-validate-code': 'a batch is POSTed',
  'GET /ValueSet/$batch-validate-code': 'a batch is POSTed',
  'GET /$closure': '$closure changes state: POST only (GET is refused, 405)',
  'ALL /CodeSystem/{id}': 'refuses other methods (405)',
  'ALL /ValueSet/{id}': 'refuses other methods (405)',
  'ALL /ConceptMap/{id}': 'refuses other methods (405)'
};

// Parameters the code reads that the description doesn't list, with the reason
const UNDOCUMENTED = {
  context: '$expand: refused (not supported)',
  logExtraOutput: '$expand: debugging',
  term: 'an old name for filter (jQuery)',
  'exclude-system': 'refused (not supported)',
  // $translate's R4 names (the description mentions them)
  code: '$translate: R4 name', coding: '$translate: R4 name', codeableConcept: '$translate: R4 name',
  system: '$translate: R4 name', version: '$translate: R4 name', source: '$translate: R4 name',
  target: '$translate: R4 name', targetsystem: '$translate: R4 name', targetcode: '$translate: R4 name',
  reverse: '$translate: R4 name'
};

const spec = txOpenApi.forEndpoint(ENDPOINT).getSpec();

function readSource(file) {
  return fs.readFileSync(path.join(TX, file), 'utf8');
}

// The request parameter names a worker reads
function namesRead(src, withNameCompare = false) {
  const names = new Set();
  const re = /(?:findParameter\((?:params|req\.body), |get(?:String|Coding|Resource|CodeableConcept)Param\(params, |params\.(?:has|get)\()'([^']+)'/g;
  for (const m of src.matchAll(re)) {
    names.add(m[1]);
  }
  if (withNameCompare) {
    for (const m of src.matchAll(/\.name\s*===?\s*['"]([^'"]+)['"]/g)) {
      names.add(m[1]);
    }
  }
  return names;
}

function documented(...ops) {
  const names = new Set();
  for (const op of ops) {
    op.in.forEach(p => names.add(p.name));
    if (op.common) {
      COMMON.forEach(p => names.add(p.name));
    }
  }
  return names;
}

function op(name, resource) {
  const found = OPERATIONS.find(o => o.name === name && (resource === undefined || o.resource === resource));
  if (!found) {
    throw new Error(`no operation ${name} ${resource}`);
  }
  return found;
}

describe('tx OpenAPI description', () => {
  afterAll(async () => {
    await shutdownTestApp();
  });

  describeSpecBasics(spec, packageJson);

  test('servers is the endpoint', () => {
    expect(spec.servers).toEqual([{ url: ENDPOINT }]);
  });

  describe('the routes', () => {
    let routes;
    beforeAll(async () => {
      await getTestApp();
      // express keeps the \$ the routes are written with
      routes = routerRoutes(getTxModule().routers.get(ENDPOINT)).map(r => r.replace(/\\/g, ''));
    }, 60000);

    test('every route is documented or explicitly excluded', () => {
      const documentedRoutes = new Set(specRoutes(spec));
      expect(routes.filter(r => !documentedRoutes.has(r) && !EXCLUDED[r])).toEqual([]);
    });

    test('every documented operation exists on the router', () => {
      const actual = new Set(routes);
      expect(specRoutes(spec).filter(r => !actual.has(r))).toEqual([]);
    });

    test('no excluded route is also documented', () => {
      const documentedRoutes = new Set(specRoutes(spec));
      expect(Object.keys(EXCLUDED).filter(r => documentedRoutes.has(r))).toEqual([]);
    });
  });

  describe('the parameters are the ones the code reads', () => {
    const check = (read, docs) => [...read].filter(n => !docs.has(n) && !UNDOCUMENTED[n]).sort();

    test('TxParameters (params.js): every parameter it reads is documented', () => {
      const src = readSource('params.js');
      const body = src.substring(src.indexOf('seeParameter(name, value, overwrite)'));
      const read = new Set([...body.matchAll(/case '([^']+)':/g)].map(m => m[1]));
      const docs = new Set([...COMMON, ...OPERATIONS.flatMap(o => o.in)].map(p => p.name));
      expect(check(read, docs)).toEqual([]);
    });

    test('every documented common, expansion or validation parameter is read by TxParameters or a worker', () => {
      const src = readSource('params.js') + readSource('workers/worker.js');
      const missing = [...COMMON, ...EXPANSION, ...VALIDATION].map(p => p.name).filter(n => !src.includes(`'${n}'`));
      expect(missing).toEqual([]);
    });

    const WORKERS = [
      ['$expand', 'workers/expand.js', [op('expand')]],
      ['$validate-code', 'workers/validate.js', [op('validate-code', 'ValueSet'), op('validate-code', 'CodeSystem')]],
      ['$lookup', 'workers/lookup.js', [op('lookup')]],
      ['$subsumes', 'workers/subsumes.js', [op('subsumes')]],
      ['$translate', 'workers/translate.js', [op('translate')]],
      ['$compare', 'workers/compare.js', [op('compare')]],
      ['$cache-control', 'workers/cache-control.js', [op('cache-control')]],
      ['$closure', 'workers/closure.js', [op('closure')], true],
      ['$batch-validate-code', 'workers/batch-validate.js', [op('batch-validate-code', 'ValueSet'), op('batch-validate-code', 'CodeSystem')], true]
    ];
    for (const [name, file, ops, withNameCompare] of WORKERS) {
      test(`${name}: every parameter the worker reads is documented, and every documented one is read`, () => {
        let src = readSource(file);
        if (name === '$compare') {
          // readValueSet(res, 'this' | 'other', ...) reads <prefix>ValueSet and <prefix>Url
          src += ['this', 'other'].map(p => `findParameter(params, '${p}ValueSet') findParameter(params, '${p}Url')`).join(' ');
        }
        const read = namesRead(src, withNameCompare);
        expect(check(read, documented(...ops))).toEqual([]);
        // and the other way: the operation's own parameters are in the worker (or TxParameters)
        const known = src + readSource('params.js') + readSource('workers/worker.js');
        const own = ops.flatMap(o => o.in.map(p => p.name));
        expect(own.filter(n => !known.includes(`'${n}'`) && !known.includes(`"${n}"`))).toEqual([]);
      });
    }
  });

  describe('the operations', () => {
    test('GET takes only primitive parameters, and every primitive in parameter', () => {
      for (const o of OPERATIONS.filter(x => !x.methods || x.methods.includes('get'))) {
        const getOp = Object.values(operations(spec)).find(x => x.op.operationId === o.name.replace(/-([a-z])/g, (m, c) => c.toUpperCase()) + (o.resource || '')).op;
        const names = getOp.parameters.map(p => p.$ref ? spec.components.parameters[p.$ref.split('/').pop()] : p)
          .filter(p => p.in === 'query').map(p => p.name).sort();
        const expected = [...o.in, ...(o.common ? COMMON : [])].filter(p => txOpenApi.isPrimitive(p.type)).map(p => p.name);
        expect(names).toEqual([...new Set([...expected, '_format'])].sort());
      }
    });

    test('every operation has a table of its parameters', () => {
      for (const { op: o } of Object.values(operations(spec)).filter(x => x.path.includes('$') && x.path !== '/$versions')) {
        expect(o.description).toMatch(/\*\*In parameters\*\*/);
        expect(o.description).toMatch(/\| Name \| Type \| Card\. \| Description \|/);
      }
    });
  });

  describe('the generated schemas', () => {
    const dir = packageDir(config.package);
    const havePackage = fs.existsSync(dir);

    (havePackage ? test : test.skip)(`are up to date with openapi-schemas.config.js (needs ${config.package})`, () => {
      const generated = generateSchemas(config, dir);
      const checkedIn = JSON.parse(fs.readFileSync(path.join(TX, 'openapi-schemas.json'), 'utf8'));
      // if this fails: node utilities/generate-openapi-schemas.js tx
      expect(checkedIn).toEqual(generated);
    });

    test('contained resources are value sets, in value sets, only', () => {
      const s = spec.components.schemas;
      for (const t of ['CodeSystem', 'ConceptMap', 'OperationOutcome', 'CapabilityStatement', 'TerminologyCapabilities']) {
        expect(s[t].properties).not.toHaveProperty('contained');
      }
      expect(s.ValueSet.properties.contained.items).toEqual({ $ref: '#/components/schemas/ValueSet' });
    });

    test('extension and parameter values are primitives (not base64Binary), Coding and CodeableConcept', () => {
      const s = spec.components.schemas;
      for (const name of ['Extension', 'Parameters_Parameter']) {
        const values = Object.keys(s[name].properties).filter(k => k.startsWith('value'));
        expect(values).toContain('valueString');
        expect(values).toContain('valueCoding');
        expect(values).toContain('valueCodeableConcept');
        expect(values).not.toContain('valueBase64Binary');
        expect(values).not.toContain('valueQuantity');
      }
    });

    test('a Bundle or a Parameters doesn\'t hold a Bundle', () => {
      const refs = (x) => JSON.stringify(x);
      expect(refs(spec.components.schemas.Bundle_Entry.properties.resource)).not.toMatch(/Bundle/);
      expect(refs(spec.components.schemas.Parameters_Parameter.properties.resource)).not.toMatch(/Bundle/);
      expect(spec.components.schemas).not.toHaveProperty('AnyResource');
    });
  });

  describe('real responses', () => {
    let app;
    let validate;

    beforeAll(async () => {
      app = await getTestApp();
      const ajv = new Ajv2020({ strict: false, allErrors: true });
      ajv.addSchema({ $id: 'spec', components: spec.components }, 'spec');
      validate = (name, value) => {
        const v = ajv.getSchema(`spec#/components/schemas/${name}`);
        return v(value) ? [] : v.errors.map(e => `${e.instancePath} ${e.message} ${JSON.stringify(e.params)}`);
      };
    }, 60000);

    const get = (url) => request(app).get(ENDPOINT + url).set('Accept', 'application/fhir+json');

    test('CapabilityStatement', async () => {
      const res = await get('/metadata');
      expect(res.status).toBe(200);
      expect(validate('CapabilityStatement', res.body)).toEqual([]);
    });

    test('TerminologyCapabilities', async () => {
      const res = await get('/metadata?mode=terminology');
      expect(res.status).toBe(200);
      expect(validate('TerminologyCapabilities', res.body)).toEqual([]);
    });

    test('read and search', async () => {
      let res = await get('/CodeSystem/core-administrative-gender');
      expect(res.status).toBe(200);
      expect(validate('CodeSystem', res.body)).toEqual([]);
      res = await get('/ValueSet?_count=20');
      expect(res.status).toBe(200);
      expect(validate('ValueSetSearchBundle', res.body)).toEqual([]);
      res = await get('/CodeSystem?url=http://hl7.org/fhir/administrative-gender');
      expect(validate('CodeSystemSearchBundle', res.body)).toEqual([]);
    });

    test('$expand', async () => {
      const res = await get('/ValueSet/$expand?url=http://hl7.org/fhir/ValueSet/administrative-gender&includeDesignations=true');
      expect(res.status).toBe(200);
      expect(validate('ValueSet', res.body)).toEqual([]);
    });

    test('$validate-code and $lookup', async () => {
      let res = await get('/ValueSet/$validate-code?url=http://hl7.org/fhir/ValueSet/administrative-gender&system=http://hl7.org/fhir/administrative-gender&code=male&display=Wrong');
      expect(res.status).toBe(200);
      expect(validate('Parameters', res.body)).toEqual([]);
      res = await get('/CodeSystem/$lookup?system=http://hl7.org/fhir/administrative-gender&code=male');
      expect(res.status).toBe(200);
      expect(validate('Parameters', res.body)).toEqual([]);
      res = await get('/CodeSystem/$subsumes?system=http://hl7.org/fhir/administrative-gender&codeA=male&codeB=male');
      expect(res.status).toBe(200);
      expect(validate('Parameters', res.body)).toEqual([]);
    });

    test('$batch-validate-code', async () => {
      const res = await request(app).post(ENDPOINT + '/ValueSet/$batch-validate-code').set('Content-Type', 'application/json')
        .send({
          resourceType: 'Parameters',
          parameter: [
            { name: 'url', valueUri: 'http://hl7.org/fhir/ValueSet/administrative-gender' },
            { name: 'validation', resource: { resourceType: 'Parameters', parameter: [{ name: 'code', valueCode: 'male' }, { name: 'system', valueUri: 'http://hl7.org/fhir/administrative-gender' }] } },
            { name: 'validation', resource: { resourceType: 'Parameters', parameter: [{ name: 'code', valueCode: 'nope' }, { name: 'system', valueUri: 'http://hl7.org/fhir/administrative-gender' }] } }
          ]
        });
      expect(res.status).toBe(200);
      expect(validate('Parameters', res.body)).toEqual([]);
    });

    test('errors are OperationOutcomes with tx-issue-type codes', async () => {
      const res = await get('/ValueSet/$expand?url=http://example.org/no-such-value-set');
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(validate('OperationOutcome', res.body)).toEqual([]);
      // and the overlay does require them
      expect(validate('OperationOutcome', { resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'invalid', details: { text: 'x' } }] })).not.toEqual([]);
    });

    test('$versions', async () => {
      let res = await get('/$versions');
      expect(validate('Parameters', res.body)).toEqual([]);
      res = await request(app).get(ENDPOINT + '/$versions').set('Accept', 'application/json');
      expect(res.body).toEqual({ versions: ['5.0'], default: '5.0' });
    });

    test('$cache-control', async () => {
      const res = await request(app).post(ENDPOINT + '/$cache-control?mode=start').set('Content-Type', 'application/json')
        .send({ resourceType: 'Parameters', parameter: [] });
      expect(res.status).toBe(200);
      expect(validate('Parameters', res.body)).toEqual([]);
    });
  });

  describe('serving it', () => {
    let app;
    beforeAll(async () => {
      app = await getTestApp();
    }, 60000);

    test('JSON, YAML, and an HTML reference for browsers', async () => {
      let res = await request(app).get(ENDPOINT + '/openapi.json');
      expect(res.status).toBe(200);
      expect(res.body.openapi).toBe('3.1.0');
      expect(res.body.servers).toEqual([{ url: ENDPOINT }]);
      res = await request(app).get(ENDPOINT + '/openapi.yaml');
      expect(res.status).toBe(200);
      expect(res.text).toMatch(/^openapi: 3\.1\.0/m);
      res = await request(app).get(ENDPOINT + '/openapi').set('Accept', 'text/html');
      expect(res.status).toBe(200);
      expect(res.text).toMatch(/FHIRsmith Terminology Server API/);
      expect(res.text).toMatch(/<table class="table table-condensed"><thead><tr><th>Name<\/th>/);
      res = await request(app).get(ENDPOINT + '/openapi').set('Accept', 'application/json');
      expect(res.body.openapi).toBe('3.1.0');
    });

    test('every response links to it (RFC 8631), and the pages do too', async () => {
      let res = await request(app).get(ENDPOINT + '/metadata').set('Accept', 'application/json');
      expect(res.headers.link).toBe(`<${ENDPOINT}/openapi.json>; rel="service-desc", <${ENDPOINT}/openapi>; rel="service-doc"`);
      res = await request(app).get(ENDPOINT + '/metadata').set('Accept', 'text/html');
      expect(res.text).toContain(`<link rel="service-desc" type="application/json" href="${ENDPOINT}/openapi.json"/>`);
      expect(res.text).toContain(`<a href="${ENDPOINT}/openapi" style="color: gold">API</a>`);
    });

    test('it describes the R5 endpoints only', () => {
      expect(txOpenApi.describes('5.0')).toBe(true);
      expect(txOpenApi.describes('4.0')).toBe(false);
      expect(txOpenApi.describes('3.0')).toBe(false);
    });
  });
});
