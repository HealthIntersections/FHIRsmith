//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// library/fhir-xml.js: writing large resources in parts without holding the event loop, the
// fragment cache, writing parts to a response, and a model from a core package. (The
// conversion itself: tests/rest/xml.test.js.)

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { XmlModel, toXml, toXmlChunks, writeParts, fromXml, loadXmlModel, XmlProblem } = require('../../library/fhir-xml');
const { XmlFragmentCache } = require('../../tx/xml/xml-fragment-cache');
const { DEFINITIONS } = require('../rest/helpers');

const model = new XmlModel({ ...DEFINITIONS.xml, version: '4.0.1' });
const joined = (parts) => parts.map(p => (typeof p === 'string' ? p : p.toString('utf8'))).join('');

/** A ValueSet with a large, nested expansion (ValueSet is in the test definitions; CodeSystem isn't) */
function bigValueSet(n) {
  const contains = [];
  for (let i = 0; i < n; i++) {
    contains.push({ system: 'http://example.org/cs', code: `c${i}`, display: `Code ${i} & <more>`,
      designation: [{ language: 'fr', value: `Code ${i}` }],
      contains: [{ system: 'http://example.org/cs', code: `c${i}.1`, display: `Child of ${i}` }] });
  }
  return { resourceType: 'ValueSet', id: 'big', url: 'http://example.org/vs', status: 'active',
    text: { status: 'generated', div: '<div xmlns="http://www.w3.org/1999/xhtml">big</div>' },
    expansion: { identifier: 'urn:uuid:1', timestamp: '2026-01-01T00:00:00Z', total: n, contains } };
}

describe('toXmlChunks', () => {
  test('the parts are toXml\'s text, compact and indented, however often it yields', async () => {
    const vs = bigValueSet(2000);
    for (const pretty of [false, true]) {
      const whole = toXml(vs, model, { pretty });
      for (const yieldMs of [0, 25, 100000]) {
        expect(joined(await toXmlChunks(vs, model, { pretty, yieldMs }))).toBe(whole);
      }
    }
    expect(fromXml(toXml(vs, model), model)).toEqual(vs);
  });

  test('a resource with nothing to set aside is one string', async () => {
    const parts = await toXmlChunks({ resourceType: 'Patient', id: 'x', active: true }, model);
    expect(parts).toEqual([toXml({ resourceType: 'Patient', id: 'x', active: true }, model)]);
  });

  test('other work runs while a large resource is written', async () => {
    const vs = bigValueSet(20000);
    let ticks = 0;
    const timer = setInterval(() => {
      ticks++;
    }, 0);
    try {
      await toXmlChunks(vs, model, { yieldMs: 1 });
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(5);
  });

  test('stops, marked abandoned, when the response is no longer wanted', async () => {
    let asked = 0;
    const p = toXmlChunks(bigValueSet(5000), model, { yieldMs: 0, stillWanted: () => ++asked < 3 });
    await expect(p).rejects.toMatchObject({ abandoned: true });
    expect(asked).toBe(3);
  });

  test('problems are found before any of it is returned', async () => {
    const vs = bigValueSet(100);
    vs.expansion.contains[50].nonsense = true;
    await expect(toXmlChunks(vs, model, { yieldMs: 0 })).rejects.toThrow(XmlProblem);
    await expect(toXmlChunks(vs, model, { yieldMs: 0 })).rejects.toThrow(/contains\[50\]: 'nonsense' isn't an element/);
  });

  test('the fragment cache: a large array that took long, the second time, is kept, encoded, and used', async () => {
    const vs = bigValueSet(3000);
    const cache = new XmlFragmentCache({ budgetBytes: 100 * 1024 * 1024, minMs: 0 });
    const whole = toXml(vs, model, { pretty: true });
    const first = await toXmlChunks(vs, model, { pretty: true, cache });
    expect(cache.stored).toBe(0);
    const second = await toXmlChunks(vs, model, { pretty: true, cache });
    expect(cache.stored).toBe(1);
    const third = await toXmlChunks(vs, model, { pretty: true, cache });
    expect(cache.hits).toBe(1);
    for (const parts of [first, second, third]) {
      expect(joined(parts)).toBe(whole);
    }
    expect(third.some(p => Buffer.isBuffer(p))).toBe(true);
    // compact is kept apart from indented, and both from the tx module's own writer's entries
    expect(joined(await toXmlChunks(vs, model, { pretty: false, cache }))).toBe(toXml(vs, model));
    expect(cache.get(vs.expansion.contains, 'contains|2')).toBe(null);
  });
});

describe('writeParts', () => {
  function response(method = 'GET') {
    const res = new EventEmitter();
    res.req = { method };
    res.headers = {};
    res.written = [];
    res.full = false;
    res.setHeader = (k, v) => {
      res.headers[k] = v;
    };
    res.write = (p) => {
      res.written.push(p);
      // the socket fills up now and then
      res.full = !res.full;
      if (res.full) {
        setImmediate(() => res.emit('drain'));
        return false;
      }
      return true;
    };
    res.end = () => {
      res.ended = true;
    };
    return res;
  }

  test('Content-Length, then each part, waiting for the socket', async () => {
    const res = response();
    const parts = ['<a>', Buffer.from('é€'), '</a>'];
    expect(await writeParts(res, parts)).toBe(3 + 5 + 4);
    expect(res.headers['Content-Length']).toBe(12);
    expect(res.written).toEqual(parts);
    expect(res.ended).toBe(true);
  });

  test('HEAD: the length, and nothing else', async () => {
    const res = response('HEAD');
    await writeParts(res, ['<a/>']);
    expect(res.headers['Content-Length']).toBe(4);
    expect(res.written).toEqual([]);
    expect(res.ended).toBe(true);
  });
});

describe('fromXml', () => {
  test('XML nested too deeply is a problem, not a crash', () => {
    const n = 200000;
    const xml = '<Patient xmlns="http://hl7.org/fhir">' + '<contact>'.repeat(n) + '</contact>'.repeat(n) + '</Patient>';
    expect(() => fromXml(xml, model)).toThrow(XmlProblem);
  });

  test('namespace prefixes and schema attributes are not content', () => {
    const xml = '<Patient xmlns="http://hl7.org/fhir" xmlns:f="http://hl7.org/fhir" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
      'xsi:schemaLocation="http://hl7.org/fhir patient.xsd"><id value="p"/><gender value="male" xmlns:x="urn:x"/></Patient>';
    expect(fromXml(xml, model)).toEqual({ resourceType: 'Patient', id: 'p', gender: 'male' });
    expect(() => fromXml('<Patient xmlns="http://hl7.org/fhir" colour="red"><id value="p"/></Patient>', model)).toThrow(/unknown attribute 'colour'/);
  });
});

describe('loadXmlModel', () => {
  test('from the core package, kept in the cache folder', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fhir-xml-'));
    try {
      const pkg = path.join(dir, 'test.core#1.0.0', 'package');
      fs.mkdirSync(pkg, { recursive: true });
      fs.writeFileSync(path.join(pkg, 'StructureDefinition-string.json'), JSON.stringify({ resourceType: 'StructureDefinition', kind: 'primitive-type',
        type: 'string', derivation: 'specialization', snapshot: { element: [{ path: 'string' }] } }));
      fs.writeFileSync(path.join(pkg, 'StructureDefinition-Thing.json'), JSON.stringify({ resourceType: 'StructureDefinition', kind: 'resource',
        type: 'Thing', derivation: 'specialization', snapshot: { element: [{ path: 'Thing' }, { path: 'Thing.id', max: '1', type: [{ code: 'string' }] },
          { path: 'Thing.name', max: '*', type: [{ code: 'string' }] }] } }));
      let fetched = 0;
      const pm = { cacheFolder: dir, fetch: async () => {
        fetched++;
        return 'test.core#1.0.0';
      } };
      const m = await loadXmlModel({ corePackage: 'test.core#1.0.0', packageManager: pm, cacheFolder: dir });
      expect(toXml({ resourceType: 'Thing', id: 'a', name: ['x', 'y'] }, m)).toBe(
        '<?xml version="1.0" encoding="UTF-8"?><Thing xmlns="http://hl7.org/fhir"><id value="a"/><name value="x"/><name value="y"/></Thing>');
      const kept = fs.readdirSync(dir).filter(f => f.startsWith('fhir-xml-model-'));
      expect(kept).toEqual(['fhir-xml-model-test.core-1.0.0-v1.json']);
      // the second time, from the file (the package still fetched, so it counts as used)
      fs.rmSync(pkg, { recursive: true });
      const m2 = await loadXmlModel({ corePackage: 'test.core#1.0.0', packageManager: pm, cacheFolder: dir });
      expect(m2.has('Thing')).toBe(true);
      expect(fetched).toBe(2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
