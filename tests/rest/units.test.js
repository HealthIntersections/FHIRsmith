//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

const { applyPatch, PatchError } = require('../../rest/library/json-patch');
const { splitUrl, classify, parseQuery, ifMatchVersion } = require('../../rest/request');
const { tokenise } = require('../../rest/search/filter');
const { Definitions } = require('../../rest/indexing/definitions');
const { Indexer } = require('../../rest/indexing/indexer');
const { extractValues, parseReference, canonicalQuantity, normalise } = require('../../rest/indexing/values');
const { shape } = require('../../rest/search/shape');
const { decide } = require('../../rest/access');
const { auditBuilder } = require('../../rest/audit/audit');
const { applyRole, workerModules } = require('../../library/role');
const { loadSettings, classify: route } = require('../../cluster');
const { DEFINITIONS } = require('./helpers');

describe('JSON Patch', () => {
  const doc = { a: 1, b: { c: [1, 2, 3] } };
  test('the operations', () => {
    expect(applyPatch(doc, [{ op: 'add', path: '/d', value: 4 }]).d).toBe(4);
    expect(applyPatch(doc, [{ op: 'add', path: '/b/c/1', value: 9 }]).b.c).toEqual([1, 9, 2, 3]);
    expect(applyPatch(doc, [{ op: 'add', path: '/b/c/-', value: 9 }]).b.c).toEqual([1, 2, 3, 9]);
    expect(applyPatch(doc, [{ op: 'remove', path: '/a' }]).a).toBeUndefined();
    expect(applyPatch(doc, [{ op: 'replace', path: '/a', value: 2 }]).a).toBe(2);
    expect(applyPatch(doc, [{ op: 'move', from: '/a', path: '/z' }])).toEqual({ z: 1, b: { c: [1, 2, 3] } });
    expect(applyPatch(doc, [{ op: 'copy', from: '/b/c/0', path: '/y' }]).y).toBe(1);
    expect(applyPatch(doc, [{ op: 'test', path: '/b', value: { c: [1, 2, 3] } }])).toEqual(doc);
    // the original is untouched
    expect(doc).toEqual({ a: 1, b: { c: [1, 2, 3] } });
  });
  test('errors', () => {
    expect(() => applyPatch(doc, [{ op: 'test', path: '/a', value: 2 }])).toThrow(PatchError);
    expect(() => applyPatch(doc, [{ op: 'remove', path: '/nope' }])).toThrow(PatchError);
    expect(() => applyPatch(doc, [{ op: 'replace', path: '/nope', value: 1 }])).toThrow(PatchError);
    expect(() => applyPatch(doc, [{ op: 'add', path: '/b/c/9', value: 1 }])).toThrow(PatchError);
    expect(() => applyPatch(doc, [{ op: 'add', path: '/__proto__', value: { x: 1 } }])).toThrow(PatchError);
    expect(() => applyPatch(doc, [{ op: 'bogus', path: '/a' }])).toThrow(PatchError);
    expect(() => applyPatch(doc, {})).toThrow(PatchError);
  });
  test('pointer escapes', () => {
    expect(applyPatch({ 'a/b': 1, 'c~d': 2 }, [{ op: 'remove', path: '/a~1b' }, { op: 'remove', path: '/c~0d' }])).toEqual({});
  });
});

describe('requests', () => {
  const c = (method, url) => {
    const { segments, params } = splitUrl(url);
    return classify({ method, segments, params });
  };
  test('interactions from method and path', () => {
    expect(c('GET', 'metadata').interaction).toBe('capabilities');
    expect(c('POST', '').interaction).toBe('bundle');
    expect(c('GET', '').interaction).toBe('search-system');
    expect(c('GET', '_history').interaction).toBe('history-system');
    expect(c('GET', 'Patient').interaction).toBe('search-type');
    expect(c('POST', 'Patient').interaction).toBe('create');
    expect(c('PUT', 'Patient?identifier=x').interaction).toBe('conditional-update');
    expect(c('DELETE', 'Patient?identifier=x').interaction).toBe('conditional-delete');
    expect(c('POST', 'Patient/_search').interaction).toBe('search-type');
    expect(c('GET', 'Patient/_history').interaction).toBe('history-type');
    expect(c('GET', 'Patient/1')).toMatchObject({ interaction: 'read', type: 'Patient', id: '1' });
    expect(c('PUT', 'Patient/1').interaction).toBe('update');
    expect(c('PATCH', 'Patient/1').interaction).toBe('patch');
    expect(c('DELETE', 'Patient/1').interaction).toBe('delete');
    expect(c('GET', 'Patient/1/_history').interaction).toBe('history-instance');
    expect(c('GET', 'Patient/1/_history/2')).toMatchObject({ interaction: 'vread', vid: '2' });
    expect(c('GET', 'Patient/1/Observation')).toMatchObject({ interaction: 'search-type', type: 'Observation', compartment: { type: 'Patient', id: '1' } });
    expect(c('POST', 'Patient/1/Observation/_search')).toMatchObject({ interaction: 'search-type', type: 'Observation' });
    expect(c('GET', 'Patient/1/$everything')).toMatchObject({ interaction: 'operation', operation: 'everything', id: '1' });
    expect(c('GET', '$meta')).toMatchObject({ interaction: 'operation', operation: 'meta' });
    expect(() => c('POST', 'Patient/1')).toThrow();
    expect(() => c('GET', 'patient/1')).toThrow();
  });
  test('the query keeps order and repeats', () => {
    expect(parseQuery('a=1&b=2&a=3&c=x%20y&d=a+b')).toEqual([['a', '1'], ['b', '2'], ['a', '3'], ['c', 'x y'], ['d', 'a b']]);
    expect(() => parseQuery('a=%zz')).toThrow();
  });
  test('If-Match', () => {
    expect(ifMatchVersion({ headers: { 'if-match': 'W/"3"' } })).toBe('3');
    expect(ifMatchVersion({ headers: { 'if-match': '"3"' } })).toBe('3');
    expect(ifMatchVersion({ headers: {} })).toBeNull();
  });
});

describe('_filter tokens', () => {
  test('words, strings, brackets', () => {
    expect(tokenise('name eq "a \\"b\\"" and (x gt 3)').map(t => t.v || t.t)).toEqual(['name', 'eq', 'a "b"', 'and', '(', 'x', 'gt', '3', ')']);
    expect(() => tokenise('name eq "open')).toThrow();
    expect(tokenise('value-quantity eq 120||mm[Hg]').map(t => t.v)).toEqual(['value-quantity', 'eq', '120||mm[Hg]']);
  });
});

describe('definitions and values', () => {
  const defs = new Definitions(DEFINITIONS);
  test('every definition in the fixture compiles', () => {
    expect(defs.problems).toEqual([]);
    expect(defs.param('Observation', 'subject').type).toBe('reference');
    expect(defs.param('Patient', '_id')).toBeNull();
    // Resource's parameters apply to every type
    expect(defs.forType('Patient').has('_lastUpdated')).toBe(false);
    expect(defs.compartments.get('Patient').get('Observation')).toContain('subject');
  });

  test('resolve() is X picks references by type', () => {
    const sp = defs.param('Observation', 'patient');
    expect(sp.expression).toMatch(/resolve\(\) is Patient/);
    const nodes = sp.fn({ resourceType: 'Observation', subject: { reference: 'Patient/1' } });
    expect(nodes.length).toBe(1);
    expect(sp.fn({ resourceType: 'Observation', subject: { reference: 'Group/1' } }).length).toBe(0);
    expect(sp.fn({ resourceType: 'Observation', subject: { reference: 'http://x.org/fhir/Patient/1' } }).length).toBe(1);
    expect(sp.fn({ resourceType: 'Observation', subject: { type: 'Patient', identifier: { value: '1' } } }).length).toBe(1);
  });

  test('values by type', () => {
    const ctx = { timeZone: 'UTC', baseUrls: ['http://me/fhir'] };
    const def = defs.param('Patient', 'name');
    const rows = extractValues('string', def.fn({ resourceType: 'Patient', name: [{ family: 'Zoë', given: ['A', 'B'], text: 'Zoë A B' }] }), ctx);
    expect(rows.map(r => r.Norm).sort()).toEqual(['a', 'b', 'zoe', 'zoe a b']);
    const ident = defs.param('Patient', 'identifier');
    const t = extractValues('token', ident.fn({ resourceType: 'Patient', identifier: [{ system: 'urn:x', value: '1', type: { coding: [{ system: 's', code: 'MR' }] } }] }), ctx);
    expect(t[0]).toMatchObject({ system: 'urn:x', Code: '1', typeSystem: 's', TypeCode: 'MR', concept: false });
    const code = defs.param('Observation', 'code');
    const c = extractValues('token', code.fn({ resourceType: 'Observation', code: { coding: [{ system: 'http://loinc.org', code: '1-8' }], text: 'Thing' } }), ctx);
    expect(c[0]).toMatchObject({ system: 'http://loinc.org', Code: '1-8', TextNorm: 'thing', concept: true });
    const birth = defs.param('Patient', 'birthdate');
    const d = extractValues('date', birth.fn({ resourceType: 'Patient', birthDate: '2000-02' }), ctx);
    expect(d[0]).toEqual({ table: 'IndexDates', Lo: Date.parse('2000-02-01T00:00:00Z'), Hi: Date.parse('2000-03-01T00:00:00Z') });
    const q = extractValues('quantity', defs.param('Observation', 'value-quantity').fn({ resourceType: 'Observation',
      valueQuantity: { value: 1.5, system: 'http://unitsofmeasure.org', code: 'g' } }), ctx);
    expect(q[0]).toMatchObject({ Value: 1.5, Unit: 'g', CanonUnit: 'g' });
    const ref = extractValues('reference', defs.param('Observation', 'subject').fn({ resourceType: 'Observation', subject: { reference: 'http://me/fhir/Patient/9' } }), ctx);
    expect(ref[0]).toMatchObject({ local: true, targetType: 'Patient', targetId: '9' });
  });

  test('references', () => {
    expect(parseReference('Patient/1')).toMatchObject({ local: true, type: 'Patient', id: '1' });
    expect(parseReference('Patient/1/_history/2')).toMatchObject({ local: true, version: '2' });
    expect(parseReference('http://x.org/ValueSet/a|1.0')).toMatchObject({ local: false, urlVersion: '1.0' });
    expect(parseReference('#c1')).toBeNull();
  });

  test('canonical quantities and normalised strings', () => {
    expect(canonicalQuantity('kg', 1).value).toBeCloseTo(1000);
    expect(canonicalQuantity('kg', 1).unit).toBe(canonicalQuantity('g', 1).unit);
    expect(canonicalQuantity('notaunit', 1)).toBeNull();
    expect(normalise('Ångström')).toBe('angstrom');
  });

  test('composite rows share a group', () => {
    const ix = new Indexer({ definitions: defs, lookups: null, typeKeys: new Map() });
    for (const d of defs.byUrl.values()) {
      d.key = d.key || 1;
    }
    const { rows } = ix.extract({ resourceType: 'Observation', status: 'final', code: { text: 'x' }, component: [
      { code: { coding: [{ system: 'http://loinc.org', code: 'a' }] }, valueQuantity: { value: 1 } },
      { code: { coding: [{ system: 'http://loinc.org', code: 'b' }] }, valueQuantity: { value: 2 } }] });
    const comp = rows.filter(r => r.code === 'component-code-value-quantity');
    expect(comp.map(r => [r.GroupNo, r.Comp])).toEqual([[1, 0], [1, 1], [2, 0], [2, 1]]);
  });
});

describe('_summary and _elements', () => {
  const defs = new Definitions(DEFINITIONS);
  const p = { resourceType: 'Patient', id: '1', meta: { versionId: '1' }, text: { div: '<div/>' }, name: [{ family: 'x' }], photo: [{}], gender: 'male', deceasedBoolean: false };
  test('summary keeps the summary elements', () => {
    const s = shape(p, { summary: 'true' }, defs);
    expect(s.name).toBeDefined();
    expect(s.photo).toBeUndefined();
    expect(s.deceasedBoolean).toBe(false);
    expect(s.meta.tag[0].code).toBe('SUBSETTED');
  });
  test('data drops text; elements keeps what is asked', () => {
    expect(shape(p, { summary: 'data' }, defs).text).toBeUndefined();
    const e = shape(p, { elements: ['gender'] }, defs);
    expect(Object.keys(e).sort()).toEqual(['gender', 'id', 'meta', 'resourceType']);
  });
});

describe('access', () => {
  const ep = (anonymous = 'none') => ({ path: '/r4', settings: { anonymous } });
  const user = (roles) => ({ has: (m, r, scope) => m === 'rest' && roles.includes(r) && scope === '/r4' });
  test('roles', () => {
    expect(decide(null, ep(), 'read').allowed).toBe(false);
    expect(decide(null, ep('read'), 'read').allowed).toBe(true);
    expect(decide(null, ep('read'), 'create').allowed).toBe(false);
    expect(decide(null, ep('write'), 'create').allowed).toBe(true);
    expect(decide(user(['read']), ep(), 'search-type').allowed).toBe(true);
    expect(decide(user(['read']), ep(), 'update').allowed).toBe(false);
    expect(decide(user(['write']), ep(), 'read').allowed).toBe(true);
    expect(decide(user(['write']), ep(), 'manage').allowed).toBe(false);
    expect(decide(user(['manage']), ep(), 'delete').allowed).toBe(true);
    expect(decide(user(['read']), ep(), 'read').compartments).toBeNull();
  });
});

describe('AuditEvents', () => {
  test('R4 and R5 shapes', () => {
    const e4 = auditBuilder('4.0.1').build({ interaction: 'read', status: 404, principal: null, ip: '1.2.3.4', what: 'Patient/1', source: 'http://x' });
    expect(e4.type.code).toBe('rest');
    expect(e4.outcome).toBe('4');
    expect(e4.subtype[0].code).toBe('read');
    const e5 = auditBuilder('5.0.0').build({ interaction: 'create', status: 201, principal: { id: 1, login: 'me' }, source: 'http://x' });
    expect(e5.category[0].coding[0].code).toBe('rest');
    expect(e5.outcome.code.code).toBe('informational');
    expect(e5.agent[0].who.identifier.value).toBe('me');
  });
});

describe('the cluster: workers that run the rest module', () => {
  const config = (workerMods) => ({
    server: { port: 3000, cluster: { workerModules: workerMods } },
    modules: { tx: { enabled: true, instanceCode: 'm0', endpoints: [{ path: '/r4' }] }, rest: { enabled: true, endpoints: [{ path: '/fhir/r4' }] }, ips: { enabled: true } }
  });
  test('workerModules', () => {
    expect(workerModules({})).toEqual(['tx']);
    expect(workerModules(config(['rest']))).toEqual(['tx', 'rest']);
    expect(() => workerModules(config(['ips']))).toThrow(/ips/);
    expect(() => workerModules(config('rest'))).toThrow();
  });
  test('a worker keeps the rest module when told to', () => {
    const c = applyRole(config(['rest']), { role: 'tx-worker', instanceCode: 'tx1' });
    expect(c.modules.rest.enabled).toBe(true);
    expect(c.modules.ips.enabled).toBe(false);
    const d = applyRole(config(undefined), { role: 'tx-worker', instanceCode: 'tx1' });
    expect(d.modules.rest.enabled).toBe(false);
  });
  test('the launcher sends rest requests to the workers only when they run it', () => {
    const s = loadSettings(['--workers=2'], {}, config(['rest']));
    expect(route('/fhir/r4/Patient/1', {}, s.txPaths, s.routing).to).toBe('tx');
    const n = loadSettings(['--workers=2'], {}, config(undefined));
    expect(route('/fhir/r4/Patient/1', {}, n.txPaths, n.routing).to).toBe('master');
  });
});
