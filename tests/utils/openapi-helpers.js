// Helpers for tests that check a module's hand-maintained OpenAPI description against its
// express router (used by tests/packages/openapi.test.js and tests/registry/openapi.test.js).

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

// "METHOD /path" for every route on the router, with express :params written as {params}.
function routerRoutes(router) {
  const routes = [];
  for (const layer of router.stack) {
    if (!layer.route) {
      continue;
    }
    const p = layer.route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    const methods = Object.keys(layer.route.methods).filter(m => layer.route.methods[m]);
    for (const m of methods) {
      routes.push(`${m === '_all' ? 'ALL' : m.toUpperCase()} ${p}`);
    }
  }
  return routes;
}

function specRoutes(spec) {
  const routes = [];
  for (const [p, item] of Object.entries(spec.paths)) {
    for (const m of HTTP_METHODS) {
      if (item[m]) {
        routes.push(`${m.toUpperCase()} ${p}`);
      }
    }
  }
  return routes;
}

function operations(spec) {
  const ops = {};
  for (const [p, item] of Object.entries(spec.paths)) {
    for (const m of HTTP_METHODS) {
      if (item[m]) {
        ops[item[m].operationId] = { path: p, item, op: item[m] };
      }
    }
  }
  return ops;
}

function resolve(spec, obj) {
  if (!obj || !obj.$ref) {
    return obj;
  }
  return obj.$ref.replace(/^#\//, '').split('/').reduce((o, k) => (o ? o[k] : undefined), spec);
}

function collectRefs(obj, refs = []) {
  if (Array.isArray(obj)) {
    obj.forEach(o => collectRefs(o, refs));
  } else if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (k === '$ref') {
        refs.push(v);
      } else {
        collectRefs(v, refs);
      }
    }
  }
  return refs;
}

function parametersOf(spec, operationId, location) {
  const { item, op } = operations(spec)[operationId];
  return [...(item.parameters || []), ...(op.parameters || [])]
    .map(p => resolve(spec, p))
    .filter(p => p.in === location);
}

// The structural checks every description should pass.
function describeSpecBasics(spec, packageJson) {
  test('is OpenAPI 3.1 and reports the server version', () => {
    expect(spec.openapi).toMatch(/^3\.1\.\d+$/);
    expect(spec.info.title).toBeTruthy();
    expect(spec.info.version).toBe(packageJson.version);
  });

  test('every operation has a unique operationId and at least one response', () => {
    const ids = [];
    for (const { op } of Object.values(operations(spec))) {
      ids.push(op.operationId);
      expect(Object.keys(op.responses || {}).length).toBeGreaterThan(0);
    }
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(specRoutes(spec).length);
  });

  test('every $ref resolves', () => {
    const unresolved = collectRefs(spec).filter(ref => !ref.startsWith('#/') || resolve(spec, { $ref: ref }) === undefined);
    expect(unresolved).toEqual([]);
  });

  test('every path parameter is declared, and every declared path parameter is in the path', () => {
    for (const { path: p, item, op } of Object.values(operations(spec))) {
      const inPath = [...p.matchAll(/\{([^}]+)\}/g)].map(m => m[1]).sort();
      const declared = [...(item.parameters || []), ...(op.parameters || [])]
        .map(x => resolve(spec, x)).filter(x => x.in === 'path');
      expect({ path: p, params: declared.map(x => x.name).sort() }).toEqual({ path: p, params: inPath });
      declared.forEach(x => expect(x.required).toBe(true));
    }
  });

  test('parameter examples satisfy their own schema', () => {
    const params = [
      ...Object.values((spec.components && spec.components.parameters) || {}),
      ...Object.values(operations(spec)).flatMap(({ op }) => op.parameters || [])
    ].map(p => resolve(spec, p));
    for (const p of params.filter(p => p.example !== undefined)) {
      if (p.schema.pattern) {
        expect({ name: p.name, ok: new RegExp(p.schema.pattern).test(String(p.example)) }).toEqual({ name: p.name, ok: true });
      }
      if (p.schema.maxLength) {
        expect(String(p.example).length).toBeLessThanOrEqual(p.schema.maxLength);
      }
    }
  });
}

// Every router route is documented or excluded, and vice versa.
function describeRouterAgreement(spec, router, excluded) {
  test('every route is documented or explicitly excluded', () => {
    const documented = new Set(specRoutes(spec));
    expect(routerRoutes(router).filter(r => !documented.has(r) && !excluded[r])).toEqual([]);
  });

  test('every documented operation exists on the router', () => {
    const actual = new Set(routerRoutes(router));
    expect(specRoutes(spec).filter(r => !actual.has(r))).toEqual([]);
  });

  test('no excluded route is also documented', () => {
    const documented = new Set(specRoutes(spec));
    expect(Object.keys(excluded).filter(r => documented.has(r))).toEqual([]);
  });
}

module.exports = {
  HTTP_METHODS, routerRoutes, specRoutes, operations, resolve, collectRefs, parametersOf,
  describeSpecBasics, describeRouterAgreement
};
