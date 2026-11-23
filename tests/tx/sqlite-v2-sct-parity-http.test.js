'use strict';

// SNOMED CT on sqlite-v2 against main's provider (tx/cs/cs-snomed.js) through the real router,
// both over the repo's SNOMED CT test cache (tx/data/snomed-testing.cache): code spellings main
// reads as a concept id (cs-snomed.js stringToIdOrZero: BigInt), a text filter of digits only,
// and an unknown concept in a `concept in` / `not-in` filter.

const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { getTestApp, getTxModule, shutdownTestApp } = require('./setup');
const { importSnomedV2FromCache } = require('../../tx/importers/import-sct-v2-cache.module');
const { SnomedServicesFactory } = require('../../tx/cs/cs-snomed');
const { SnomedV2Factory } = require('../../tx/sqlite-v2/snomed');

const SCT = 'http://snomed.info/sct';
const CACHE = path.resolve(__dirname, '../../tx/data/snomed-testing.cache');
let app, tx, dir, v2, classic;

function use(f) {
  const p = tx.endpoints[0].provider;
  for (const key of [...p.codeSystemFactories.keys()]) if (key === SCT || key.startsWith(SCT + '|')) p.codeSystemFactories.delete(key);
  p.codeSystemFactories.set(SCT, f);
  p.codeSystemFactories.set(SCT + '|' + f.version(), f);
  for (const e of tx.endpoints) e.expansionCache.clearAll();
}

const issuesOf = (body) => (body.issue || []).map((i) => [i.severity, i.code, i.details && i.details.text]);

async function call(method, url, body) {
  const res = method === 'get' ? await request(app).get(url) : await request(app).post(url).send(body);
  return res;
}

async function both(fn) {
  use(v2);
  const a = await fn();
  use(classic);
  const b = await fn();
  use(v2);
  return { v2: a, main: b };
}

const param = (body, name) => {
  const p = (body.parameter || []).find((x) => x.name === name);
  return p ? (p.valueString ?? p.valueBoolean ?? p.valueCode ?? p.valueUri) : undefined;
};

beforeAll(async () => {
  app = await getTestApp();
  tx = getTxModule();
  dir = fs.mkdtempSync(path.join(process.env.SQLITE_V2_TEST_TMP || os.tmpdir(), 'sqlite-v2-sct-http-'));
  await importSnomedV2FromCache({ source: CACHE, dest: path.join(dir, 'sct.db'), overwrite: true, force: true, normalForms: false, log: () => {} });
  v2 = new SnomedV2Factory(tx.i18n, path.join(dir, 'sct.db'));
  await v2.load();
  classic = new SnomedServicesFactory(tx.i18n, CACHE);
  await classic.load();
  use(v2);
}, 180000);

afterAll(async () => {
  await shutdownTestApp();
  if (v2 && v2.store) v2.store.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

describe('SNOMED CT code spellings, as main reads them (BigInt)', () => {
  // 22298006 |Myocardial infarction|; 0x1543d96 is 22298006 in hexadecimal
  test.each(['22298006', '022298006', ' 22298006 ', '+22298006', '0x1543d96', '-22298006', '0', '22298007', 'abc'])('$lookup %j', async (code) => {
    const r = await both(async () => {
      const res = await call('get', `/tx/r5/CodeSystem/$lookup?system=${encodeURIComponent(SCT)}&code=${encodeURIComponent(code)}`);
      return { status: res.status, display: param(res.body, 'display'), issues: issuesOf(res.body) };
    });
    expect(r.v2).toEqual(r.main);
  });

  test.each(['+22298006', '0x1543d96', '-22298006'])('$validate-code %j', async (code) => {
    const r = await both(async () => {
      const res = await call('get', `/tx/r5/CodeSystem/$validate-code?url=${encodeURIComponent(SCT)}&code=${encodeURIComponent(code)}`);
      return { status: res.status, result: param(res.body, 'result'), display: param(res.body, 'display'), message: param(res.body, 'message') };
    });
    expect(r.v2).toEqual(r.main);
  });
});

describe('SNOMED CT text filter of digits only', () => {
  // filter=0 / 00 with count=0: main counts a concept again for each identifier length its range
  // covers (#addCodeMatches: the ranges for a prefix of zeros nest), so its total is inflated; v2
  // counts each concept once. A known difference: the codes listed are the same
  test.each([['0', 0], ['00', 0]])('filter=%s count=%i: main\'s total counts repeats, v2\'s does not', async (filter, count) => {
    const r = await both(async () => {
      const res = await call('get', `/tx/r5/ValueSet/$expand?url=${encodeURIComponent(SCT + '?fhir_vs')}&filter=${filter}&count=${count}`);
      return (res.body.expansion || {}).total;
    });
    use(v2);
    const all = await call('get', `/tx/r5/ValueSet/$expand?url=${encodeURIComponent(SCT + '?fhir_vs')}&filter=${filter}&count=100000`);
    expect(r.v2).toBe((all.body.expansion.contains || []).length);
    expect(r.main).toBeGreaterThan(r.v2);
  });

  test.each([['0', 20], ['0', 100000], ['2', 0], ['2229', 20], ['22298006', 0]])('filter=%s count=%i', async (filter, count) => {
    const r = await both(async () => {
      const res = await call('get', `/tx/r5/ValueSet/$expand?url=${encodeURIComponent(SCT + '?fhir_vs')}&filter=${filter}&count=${count}`);
      const e = res.body.expansion || {};
      return { status: res.status, total: e.total, codes: (e.contains || []).map((c) => c.code), issues: issuesOf(res.body) };
    });
    expect(r.v2).toEqual(r.main);
  });
});

describe('SNOMED CT description id as a code: an unknown code, as main', () => {
  // 183388015 is a description of 118696008 |Procedure on mediastinum| in the test cache
  const DESCRIPTION = '183388015';
  const vsBody = { resourceType: 'Parameters', parameter: [
    { name: 'valueSet', resource: { resourceType: 'ValueSet', status: 'active', compose: { include: [{ system: SCT }] } } },
    { name: 'coding', valueCoding: { system: SCT, code: DESCRIPTION } }] };
  test.each([
    ['$lookup', 'get', `/tx/r5/CodeSystem/$lookup?system=${encodeURIComponent(SCT)}&code=${DESCRIPTION}`, null],
    ['CodeSystem/$validate-code', 'get', `/tx/r5/CodeSystem/$validate-code?url=${encodeURIComponent(SCT)}&code=${DESCRIPTION}`, null],
    ['ValueSet/$validate-code', 'post', '/tx/r5/ValueSet/$validate-code', vsBody],
  ])('%s', async (name, method, url, body) => { // every row has a body (null for a GET): jest passes done as a 4th argument otherwise
    const r = await both(async () => {
      const res = await call(method, url, body);
      return { status: res.status, result: param(res.body, 'result'), message: param(res.body, 'message'), issues: issuesOf(res.body),
        oo: (res.body.parameter || []).filter((p) => p.resource && p.resource.resourceType === 'OperationOutcome').flatMap((p) => issuesOf(p.resource)) };
    });
    expect(r.v2).toEqual(r.main);
    expect(JSON.stringify(r.v2)).not.toContain('description id');
  });
});

describe('SNOMED CT concept in / not-in with an unknown concept', () => {
  // in: expand.js reports an unknown concept and skips the include (filterConceptCodes, since
  // main 4e99d163); not-in: cs-snomed.js doesn't have it (SNOMED_CONCEPT_FILTER_OPS), a 422
  test.each([['in', '22298006,99999999999'], ['in', '22298006, 22298007'], ['not-in', '22298006,99999999999'], ['not-in', '22298006']])('concept %s %s', async (op, value) => {
    const vs = { resourceType: 'ValueSet', status: 'active', compose: { include: [{ system: SCT, filter: [{ property: 'concept', op, value }] }] } };
    const r = await both(async () => {
      const res = await call('post', '/tx/r5/ValueSet/$expand', { resourceType: 'Parameters', parameter: [{ name: 'valueSet', resource: vs }, { name: 'count', valueInteger: 5 }] });
      const e = res.body.expansion || {};
      const oo = (res.body.contained || []).filter((c) => c.resourceType === 'OperationOutcome').flatMap((c) => issuesOf(c));
      return { status: res.status, total: e.total, codes: (e.contains || []).map((c) => c.code), issues: issuesOf(res.body), oo };
    });
    expect(r.v2).toEqual(r.main);
  });
});

describe('SNOMED CT filter properties and operators: accepted and refused as main', () => {
  // 235856003 |Disease of liver| (41 children in the test cache), 64572001 |Disease|, 10200004 |Liver structure|
  const props = ['concept', 'code', 'inactive', 'moduleId', 'constraint', 'expressions', 'display', 'parent', 'child', '116680003', '363698007', 'mapped:30051010000102', 'nonsense'];
  const ops = ['=', 'in', 'not-in', 'is-a', 'descendent-of', 'child-of', 'generalizes', 'descendent-leaf', 'is-not-a', 'regex', 'exists'];
  const valueFor = (prop, op) => {
    if (op === 'exists') return 'true';
    if (prop === 'inactive' || prop === 'expressions') return 'false';
    if (prop === 'constraint') return '<< 235856003';
    if (prop === 'display') return op === 'regex' ? 'Disease of.*' : 'Disease of liver';
    if (prop === 'moduleId') return '900000000000207008';
    if (prop === '363698007') return op === 'in' || op === 'not-in' ? '10200004,1340143004' : '10200004';
    if (op === 'regex') return '2358.*';
    if (op === 'in' || op === 'not-in') return '235856003,64572001';
    return '235856003';
  };
  // known differences, listed in the PR (not compared here): the order of `concept in` (main: the
  // list's order; v2: by id) and `generalizes` (main: its ancestor walk; v2: by id); `expressions`
  // as the only filter (main: no codes; v2: every concept); `116680003 = X` (main: one concept; v2:
  // none); an unknown concept in is-not-a (main: 500; v2: 400)
  const KNOWN = new Set(['concept in', 'code in', 'concept generalizes', 'code generalizes', 'expressions =', '116680003 =']);
  const cases = [...props.flatMap((p) => ops.map((o) => [p, o, valueFor(p, o)])), ['expressions', '=', 'true'], ['inactive', '=', 'true'],
    ['concept', '=', '22298006']].filter(([p, o]) => !KNOWN.has(p + ' ' + o));
  test.each(cases)('%s %s %s', async (property, op, value) => {
    const vs = { resourceType: 'ValueSet', status: 'active', compose: { include: [{ system: SCT, filter: [{ property, op, value }] }] } };
    const r = await both(async () => {
      const res = await call('post', '/tx/r5/ValueSet/$expand', { resourceType: 'Parameters', parameter: [{ name: 'valueSet', resource: vs }, { name: 'count', valueInteger: 10 }] });
      const e = res.body.expansion || {};
      return { status: res.status, total: e.total, codes: (e.contains || []).map((c) => c.code), issues: issuesOf(res.body) };
    });
    expect(r.v2).toEqual(r.main);
  });
});

describe('SNOMED CT closedness of unions and excludes, as main', () => {
  // main decides one include and exclude at a time (expand.js includeCodes / excludeCodes): an
  // include of the whole system, or an include or exclude whose filters are not closed
  // (cs-snomed.js filtersNotClosed: none of them `expressions = false`), makes the expansion
  // unclosed; one include with `expressions = false` does not close a union
  // 235856003 |Disease of liver|, 10200004 |Liver structure|, 192008 |Congenital syphilitic hepatomegaly| (a disease of liver)
  const E = { property: 'expressions', op: '=', value: 'false' };
  const isa = (code, closed) => ({ system: SCT, filter: [{ property: 'concept', op: 'is-a', value: code }, ...(closed ? [E] : [])] });
  const cases = [
    ['is-a+E', [isa('235856003', true)], [], false],
    ['is-a', [isa('235856003', false)], [], true],
    ['is-a+E, is-a+E', [isa('235856003', true), isa('10200004', true)], [], false],
    ['is-a+E, is-a', [isa('235856003', true), isa('10200004', false)], [], true],
    ['is-a, is-a+E', [isa('235856003', false), isa('10200004', true)], [], true],
    ['is-a+E, whole system', [isa('235856003', true), { system: SCT }], [], true],
    ['is-a+E exclude is-a', [isa('235856003', true)], [isa('192008', false)], true],
    ['is-a+E exclude is-a+E', [isa('235856003', true)], [isa('192008', true)], false],
    ['is-a+E, is-a+E exclude is-a', [isa('235856003', true), isa('10200004', true)], [isa('192008', false)], true],
  ];
  test.each(cases)('%s', async (name, include, exclude, unclosed) => {
    const compose = exclude.length ? { include, exclude } : { include };
    const vs = { resourceType: 'ValueSet', status: 'active', compose };
    const r = await both(async () => {
      const res = await call('post', '/tx/r5/ValueSet/$expand', { resourceType: 'Parameters', parameter: [{ name: 'valueSet', resource: vs }, { name: 'count', valueInteger: 10 }] });
      const ext = (res.body.expansion || {}).extension || [];
      return { status: res.status, unclosed: ext.some((e) => e.url.endsWith('valueset-unclosed') && e.valueBoolean),
        reasons: ext.filter((e) => e.url.endsWith('valueset-unclosed-reason')).map((e) => e.valueString) };
    });
    expect(r.v2).toEqual(r.main);
    expect(r.v2.status).toBe(200);
    expect(r.v2.unclosed).toBe(unclosed);
  });
});
