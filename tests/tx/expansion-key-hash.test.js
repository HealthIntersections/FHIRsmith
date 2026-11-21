/**
 * ExpansionCache.computeKey hashes the content of every additional resource. With a
 * cache-id that is the client's whole $cache-control cache, on every $expand, so each
 * wrapper remembers its hash (CanonicalResource.expansionKeyHash) instead of serialising
 * and hashing itself again.
 *
 * - the key is byte-identical to the one computeKey made before (the reference below is
 *   that implementation, copied), so expansions already cached stay valid;
 * - a resource is hashed once however many keys it goes into;
 * - a different resource, or a different jsonObj, gets its own hash;
 * - and nothing writes to a cached resource's json while it is used through a cache-id,
 *   which is what makes remembering the hash safe.
 */

const crypto = require('crypto');
const request = require('supertest');
const { ExpansionCache } = require('../../tx/operation-context');
const { CanonicalResource } = require('../../tx/library/canonical-resource');
const { CodeSystem } = require('../../tx/library/codesystem');
const ValueSet = require('../../tx/library/valueset');
const { ConceptMap } = require('../../tx/library/conceptmap');
const { getTestApp, getTxModule, shutdownTestApp } = require('./setup');

// computeKey as it was before the hash was remembered - the reference the new key must match
function referenceComputeKey(valueSet, params, additionalResources) {
  const keyParts = [];
  const vsJson = valueSet.jsonObj || valueSet;
  keyParts.push(`vs:${JSON.stringify(vsJson)}`);
  if (params) {
    keyParts.push(`params:` + params.hashSource());
  }
  if (additionalResources && additionalResources.length > 0) {
    const resourceHashes = additionalResources
      .map(r => {
        const json = r.jsonObj || r;
        return crypto.createHash('sha256')
          .update(JSON.stringify(json))
          .digest('hex')
          .substring(0, 16);
      })
      .sort();
    keyParts.push(`additional:${resourceHashes.join(',')}`);
  }
  const keyString = keyParts.join('||');
  return crypto.createHash('sha256').update(keyString).digest('hex');
}

const CS_URL = 'http://example.org/p6/colors';

function colorsCS(extra = {}) {
  return {
    resourceType: 'CodeSystem', url: CS_URL, version: '1.0.0', status: 'active', content: 'complete',
    hierarchyMeaning: 'is-a',
    property: [{ code: 'shade', type: 'code' }],
    concept: [
      { code: 'red', display: 'Red', property: [{ code: 'shade', valueCode: 'warm' }],
        concept: [{ code: 'crimson', display: 'Crimson' }] },
      { code: 'green', display: 'Green', property: [{ code: 'shade', valueCode: 'cool' }] },
      { code: 'blue', display: 'Blue', designation: [{ language: 'fr', value: 'Bleu' }] }
    ],
    ...extra
  };
}

function supplementCS() {
  return {
    resourceType: 'CodeSystem', url: 'http://example.org/p6/colors-de', version: '1.0.0', status: 'active',
    content: 'supplement', supplements: `${CS_URL}|1.0.0`,
    concept: [{ code: 'red', designation: [{ language: 'de', value: 'Rot' }] }]
  };
}

function enumeratedVS() {
  return {
    resourceType: 'ValueSet', url: 'http://example.org/p6/warm-vs', version: '1.0.0', status: 'active',
    compose: { include: [{ system: CS_URL, concept: [{ code: 'red' }, { code: 'blue', display: 'Blue' }] }] }
  };
}

function filterVS() {
  return {
    resourceType: 'ValueSet', url: 'http://example.org/p6/red-family', version: '1.0.0', status: 'active',
    compose: {
      include: [
        { system: CS_URL, filter: [{ property: 'concept', op: 'is-a', value: 'red' }] },
        { system: CS_URL, filter: [{ property: 'shade', op: '=', value: 'cool' }] }
      ],
      exclude: [{ system: CS_URL, concept: [{ code: 'crimson' }] }]
    }
  };
}

function importingVS() {
  return {
    resourceType: 'ValueSet', url: 'http://example.org/p6/all', version: '1.0.0', status: 'active',
    compose: { include: [{ valueSet: ['http://example.org/p6/warm-vs|1.0.0'] }, { system: CS_URL }] }
  };
}

function conceptMap() {
  return {
    resourceType: 'ConceptMap', url: 'http://example.org/p6/cm', version: '1.0.0', status: 'active',
    group: [{ source: CS_URL, target: 'http://example.org/p6/other',
      element: [{ code: 'red', target: [{ code: 'r', relationship: 'equivalent' }] }] }]
  };
}

function wrapped() {
  return [
    new CodeSystem(colorsCS()),
    new CodeSystem(supplementCS()),
    new ValueSet(enumeratedVS()),
    new ValueSet(filterVS()),
    new ValueSet(importingVS()),
    new ConceptMap(conceptMap())
  ];
}

const params = (s) => ({ hashSource: () => s });

describe('ExpansionCache.computeKey with remembered resource hashes', () => {
  const cache = new ExpansionCache(null);

  test('makes exactly the key the previous implementation made', () => {
    const resources = wrapped();
    const raw = [colorsCS({ version: '2.0.0' }), enumeratedVS()]; // plain json is still accepted
    const vsWrapper = new ValueSet(filterVS());
    const cases = [
      [vsWrapper, null, undefined],
      [vsWrapper, null, []],
      [vsWrapper, params('lang=en|count=10'), resources],
      [filterVS(), params(''), resources],
      [vsWrapper, params('x'), [...resources].reverse()],
      [vsWrapper, params('x'), resources.slice(2)],
      [vsWrapper, params('x'), raw],
      [vsWrapper, params('x'), [...raw, ...resources]],
      [vsWrapper, params('x'), [resources[0], resources[0]]]
    ];
    for (const [vs, p, extra] of cases) {
      // twice: the second time the hashes are remembered
      expect(cache.computeKey(vs, p, extra)).toBe(referenceComputeKey(vs, p, extra));
      expect(cache.computeKey(vs, p, extra)).toBe(referenceComputeKey(vs, p, extra));
    }
  });

  test('a resource\'s hash is the one the key used to use', () => {
    for (const r of wrapped()) {
      expect(r.expansionKeyHash()).toBe(
        crypto.createHash('sha256').update(JSON.stringify(r.jsonObj)).digest('hex').substring(0, 16));
    }
  });

  test('each resource is serialised and hashed once, however many keys it goes into', () => {
    const resources = wrapped();
    const vs = new ValueSet(enumeratedVS());
    const stringified = new Set();
    const realStringify = JSON.stringify;
    const stringify = jest.spyOn(JSON, 'stringify').mockImplementation(function (v, ...rest) {
      stringified.add(v);
      return realStringify.call(JSON, v, ...rest);
    });
    const createHash = jest.spyOn(crypto, 'createHash');
    try {
      const first = cache.computeKey(vs, params('a'), resources);
      // one hash per resource, plus the key itself
      expect(createHash).toHaveBeenCalledTimes(resources.length + 1);
      for (const r of resources) {
        expect(stringified.has(r.jsonObj)).toBe(true);
      }
      createHash.mockClear();
      stringify.mockClear();
      stringified.clear();
      for (let i = 0; i < 50; i++) {
        expect(cache.computeKey(vs, params('a'), resources)).toBe(first);
        cache.computeKey(vs, params('b' + i), [...resources].reverse());
      }
      // only the key itself is hashed, and only the value set being expanded is serialised
      expect(createHash).toHaveBeenCalledTimes(100);
      expect(stringify).toHaveBeenCalledTimes(100);
      for (const r of resources) {
        expect(stringified.has(r.jsonObj)).toBe(false);
      }
    } finally {
      stringify.mockRestore();
      createHash.mockRestore();
    }
  });

  test('a replacement resource (a new object) gets its own hash, and so a new key', () => {
    const vs = new ValueSet(enumeratedVS());
    const before = wrapped();
    const keyBefore = cache.computeKey(vs, null, before);
    const changed = new CodeSystem(colorsCS({ title: 'Colours, revised' }));
    const after = [changed, ...before.slice(1)];
    expect(changed.expansionKeyHash()).not.toBe(before[0].expansionKeyHash());
    const keyAfter = cache.computeKey(vs, null, after);
    expect(keyAfter).not.toBe(keyBefore);
    expect(keyAfter).toBe(referenceComputeKey(vs, null, after));
    // an identical replacement is a new object with the same content: same hash, same key
    const same = [new CodeSystem(colorsCS()), ...before.slice(1)];
    expect(cache.computeKey(vs, null, same)).toBe(keyBefore);
  });

  test('a wrapper whose jsonObj is replaced is hashed again', () => {
    const cs = new CodeSystem(colorsCS());
    const h1 = cs.expansionKeyHash();
    cs.jsonObj = colorsCS({ title: 'Other' });
    expect(cs.expansionKeyHash()).not.toBe(h1);
    expect(cs.expansionKeyHash()).toBe(CanonicalResource.computeExpansionKeyHash(cs.jsonObj));
  });

  test('a store that knows the hash can record it, and it is used without hashing', () => {
    const cs = new CodeSystem(colorsCS());
    const known = CanonicalResource.computeExpansionKeyHash(cs.jsonObj);
    cs.setExpansionKeyHash(known);
    const createHash = jest.spyOn(crypto, 'createHash');
    try {
      expect(cs.expansionKeyHash()).toBe(known);
      expect(createHash).not.toHaveBeenCalled();
    } finally {
      createHash.mockRestore();
    }
  });

  test('the remembered hash never serialises or copies', () => {
    const cs = new CodeSystem(colorsCS());
    const h = cs.expansionKeyHash();
    expect(Object.keys(cs)).not.toContain('_expansionKeyHashMemo');
    expect(JSON.stringify(cs)).not.toContain(h);
    expect({ ...cs }._expansionKeyHashMemo).toBeUndefined();
  });
});

// Freeze a resource's json, so that anything that writes to it while it is in use throws
// (class bodies are strict code). The one exception: compose filter elements stay
// extensible, because a code system provider remembers its analysis of a cached filter on
// the element itself under a non-enumerable symbol (cs-cs.js FILTER_ANALYSIS) - which JSON
// never sees. Their existing properties are still read-only, and the test checks nothing
// enumerable was added to them.
function freezeJson(o, filterElements, inFilter = false) {
  if (!o || typeof o !== 'object' || Object.isFrozen(o)) {
    return o;
  }
  for (const [k, v] of Object.entries(o)) {
    freezeJson(v, filterElements, k === 'filter' && Array.isArray(v));
  }
  if (inFilter) {
    // the filter array itself
    Object.freeze(o);
    return o;
  }
  if (filterElements && filterElements.has(o)) {
    for (const k of Object.keys(o)) {
      Object.defineProperty(o, k, { writable: false, configurable: false });
    }
    return o;
  }
  Object.freeze(o);
  return o;
}

function collectFilterElements(json, into) {
  for (const part of ['include', 'exclude']) {
    for (const inc of (json.compose && json.compose[part]) || []) {
      for (const f of inc.filter || []) {
        into.add(f);
      }
    }
  }
  return into;
}

describe('cache-id resources are not written to while they are used', () => {
  let app;

  beforeAll(async () => {
    app = await getTestApp();
  }, 60000);

  afterAll(async () => {
    await shutdownTestApp();
  });

  function post(url, cacheId, parameter) {
    return request(app)
      .post(url)
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .set('x-cache-id', cacheId)
      .send({ resourceType: 'Parameters', parameter });
  }

  test('expand, validate-code, lookup and compare through a cache-id leave the cached json untouched', async () => {
    const start = await request(app)
      .post('/tx/r5/$cache-control')
      .query({ mode: 'start' })
      .set('Accept', 'application/json')
      .set('Content-Type', 'application/json')
      .send({ resourceType: 'Parameters', parameter: [
        { name: 'sealed', valueBoolean: true },
        ...[colorsCS(), supplementCS(), enumeratedVS(), filterVS(), importingVS(), conceptMap()]
          .map(resource => ({ name: 'tx-resource', resource }))
      ] });
    expect(start.status).toBe(200);
    const cacheId = start.body.parameter.find(p => p.name === 'cache-id').valueId;

    const endpoint = getTxModule().endpoints.find(e => e.resourceCache && e.resourceCache.has(cacheId));
    const cached = endpoint.resourceCache.get(cacheId);
    expect(cached.length).toBe(6);
    const filterElements = new Set();
    const before = new Map();
    for (const r of cached) {
      collectFilterElements(r.jsonObj, filterElements);
      before.set(r, JSON.stringify(r.jsonObj));
      freezeJson(r.jsonObj, filterElements);
      r.expansionKeyHash();
    }
    expect(filterElements.size).toBe(2);

    // every expansion takes the cache path, so computeKey and the cache store both run
    const expansionCache = endpoint.expansionCache;
    const wasForced = expansionCache.forceCaching;
    expansionCache.forceCaching = true;
    try {
      const calls = [];
      for (const url of ['http://example.org/p6/warm-vs', 'http://example.org/p6/red-family', 'http://example.org/p6/all']) {
        for (let i = 0; i < 2; i++) { // the second is answered from the expansion cache
          calls.push(['expand', url, await post('/tx/r5/ValueSet/$expand', cacheId, [
            { name: 'url', valueUri: url }, { name: 'includeDefinition', valueBoolean: true },
            { name: 'displayLanguage', valueCode: 'de' }])]);
        }
        calls.push(['expand+supplement', url, await post('/tx/r5/ValueSet/$expand', cacheId, [
          { name: 'url', valueUri: url }, { name: 'useSupplement', valueCanonical: 'http://example.org/p6/colors-de' }])]);
        for (const code of ['red', 'crimson', 'green', 'nope']) {
          calls.push(['validate-code', `${url}#${code}`, await post('/tx/r5/ValueSet/$validate-code', cacheId, [
            { name: 'url', valueUri: url }, { name: 'system', valueUri: CS_URL }, { name: 'code', valueCode: code },
            { name: 'display', valueString: 'Red' }])]);
        }
      }
      calls.push(['cs validate-code', CS_URL, await post('/tx/r5/CodeSystem/$validate-code', cacheId, [
        { name: 'url', valueUri: CS_URL }, { name: 'code', valueCode: 'blue' }, { name: 'display', valueString: 'Bleu' }])]);
      calls.push(['lookup', CS_URL, await post('/tx/r5/CodeSystem/$lookup', cacheId, [
        { name: 'system', valueUri: CS_URL }, { name: 'code', valueCode: 'red' }, { name: 'property', valueCode: '*' }])]);
      calls.push(['compare', 'warm vs all', await post('/tx/r5/ValueSet/$compare', cacheId, [
        { name: 'thisUrl', valueUri: 'http://example.org/p6/warm-vs' }, { name: 'otherUrl', valueUri: 'http://example.org/p6/all' }])]);
      calls.push(['compare', 'family vs family', await post('/tx/r5/ValueSet/$compare', cacheId, [
        { name: 'thisUrl', valueUri: 'http://example.org/p6/red-family' }, { name: 'otherUrl', valueUri: 'http://example.org/p6/red-family' }])]);

      // a write to frozen json throws, which would come back as a server error
      for (const [op, what, res] of calls) {
        expect({ op, what, status: res.status < 500 ? 'ok' : res.status, body: res.status < 500 ? null : res.body })
          .toEqual({ op, what, status: 'ok', body: null });
      }
      const expanded = calls.filter(([op, , res]) => op === 'expand' && res.status === 200);
      expect(expanded.length).toBe(6);
      expect(calls.filter(([op, , res]) => op === 'validate-code' && res.status === 200).length).toBe(12);
    } finally {
      expansionCache.forceCaching = wasForced;
    }

    for (const r of cached) {
      expect(JSON.stringify(r.jsonObj)).toBe(before.get(r));
      expect(r.expansionKeyHash()).toBe(CanonicalResource.computeExpansionKeyHash(r.jsonObj));
    }
    for (const f of filterElements) {
      expect(Object.keys(f).sort()).toEqual(['op', 'property', 'value']);
    }
  }, 60000);
});
