//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// FHIR XML (rest/xml.js): the conversion, every resource in the R4 and R5 core packages there
// and back, and XML through the API.

const path = require('path');
const fs = require('fs');
const request = require('supertest');
const folders = require('../../library/folder-setup');
const { PackageManager } = require('../../library/package-manager');
const { deriveXmlModel, XmlModel, toXml, fromXml, XmlProblem } = require('../../rest/xml');
const { engines, makeApp, body, DEFINITIONS, FHIR_JSON } = require('./helpers');

const model = new XmlModel(DEFINITIONS.xml);
const XHTML = 'http://www.w3.org/1999/xhtml';

/** JSON compared without regard to the order of properties */
function canon(v) {
  if (Array.isArray(v)) {
    return '[' + v.map(canon).join(',') + ']';
  }
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

const PATIENT = {
  resourceType: 'Patient', id: 'p1', meta: { versionId: '2', profile: ['http://x/a', 'http://x/b'] },
  text: { status: 'generated', div: `<div xmlns="${XHTML}"><p class="a&amp;b">Jo &amp; <b>Smith</b> &lt;x&gt;</p></div>` },
  contained: [{ resourceType: 'Organization', id: 'o', name: 'Line 1\nLine 2\twith "quotes" & <angles>' }],
  extension: [{ url: 'http://e/1', valueDecimal: 1.5 }, { url: 'http://e/2', extension: [{ url: 'inner', valueBoolean: false }] }],
  identifier: [{ system: 'urn:x', value: 'é ü 中 😀' }],
  active: true,
  name: [{ family: 'Smith', given: ['A', 'B', 'C'], _given: [null, { id: 'g2', extension: [{ url: 'http://x', valueString: 'y' }] }, null] },
    { _family: { extension: [{ url: 'http://data-absent-reason', valueCode: 'unknown' }] } }],
  gender: 'female',
  birthDate: '1970-01-01', _birthDate: { id: 'bd' },
  multipleBirthInteger: 2,
  managingOrganization: { reference: '#o' },
  contact: [{ name: { text: 'c' }, telecom: [{ system: 'phone', value: '123' }] }]
};

describe('converting', () => {
  test('there and back', () => {
    expect(canon(fromXml(toXml(PATIENT, model), model))).toBe(canon(PATIENT));
    expect(canon(fromXml(toXml(PATIENT, model, { pretty: true }), model))).toBe(canon(PATIENT));
  });

  test('the XML: definition order, attributes, primitives\' extensions, contained resources, escaping', () => {
    const x = toXml({ resourceType: 'Patient', gender: 'male', id: 'x', active: false, name: [{ given: ['a', 'b'], _given: [null, { extension: [{ url: 'u', valueString: 'v' }] }] }],
      contained: [{ resourceType: 'Organization', name: 'A"B<C>&\n' }] }, model);
    expect(x).toBe('<?xml version="1.0" encoding="UTF-8"?><Patient xmlns="http://hl7.org/fhir"><id value="x"/>' +
      '<contained><Organization><name value="A&quot;B&lt;C&gt;&amp;&#10;"/></Organization></contained>' +
      '<active value="false"/><name><given value="a"/><given value="b"><extension url="u"><valueString value="v"/></extension></given></name>' +
      '<gender value="male"/></Patient>');
  });

  test('XML coming in: XML\'s entities and character references, nothing else', () => {
    const r = fromXml('<Patient xmlns="http://hl7.org/fhir"><id value="a"/><gender value="&#x6D;ale"/>' +
      '<name><family value="&amp;#10; &lt;&gt;&quot;&apos;&#10;"/></name></Patient>', model);
    expect(r.gender).toBe('male');
    // &amp; once: &amp;#10; is the text &#10;
    expect(r.name[0].family).toBe('&#10; <>"\'\n');
  });

  test('the narrative is kept as it is', () => {
    const div = `<div xmlns="${XHTML}" title="a &amp; b"><p>x &amp; <i>y</i><br/></p></div>`;
    const r = fromXml(`<Patient xmlns="http://hl7.org/fhir"><text><status value="generated"/>${div}</text></Patient>`, model);
    expect(r.text.div).toBe(div);
  });

  test.each([
    ['<Patient xmlns="http://hl7.org/fhir"><foo value="x"/></Patient>', /unknown element 'foo'/],
    ['<Patient xmlns="http://hl7.org/fhir"><active value="true" bar="1"/></Patient>', /unknown attribute 'bar'/],
    ['<Patient xmlns="http://hl7.org/fhir" foo="1"/>', /unknown attribute 'foo'/],
    ['<!DOCTYPE p [<!ENTITY a "b">]><Patient xmlns="http://hl7.org/fhir"/>', /DOCTYPE/],
    ['<Patient xmlns="http://hl7.org/fhir"><active value="yes"/></Patient>', /'yes' is not a boolean/],
    ['<Patient xmlns="http://hl7.org/fhir"><multipleBirthInteger value="1.x"/></Patient>', /not a number/],
    ['<Patient><active value="true"/></Patient>', /FHIR namespace/],
    ['<Patient xmlns="http://example.org"/>', /FHIR namespace/],
    ['<Patient xmlns="http://hl7.org/fhir"><id value="a&nbsp;b"/></Patient>', /&nbsp; isn't one of XML's entities/],
    ['<Patient xmlns="http://hl7.org/fhir"><id value="a&#1;b"/></Patient>', /isn't a character XML can carry/],
    ['<Patient xmlns="http://hl7.org/fhir"><gender value="male"/><gender value="female"/></Patient>', /more than once/],
    ['<Patient xmlns="http://hl7.org/fhir"><name>text</name></Patient>', /text where elements were expected/],
    ['<Patient xmlns="http://hl7.org/fhir"><active/></Patient>', /no value, id or extensions/],
    ['<Patient xmlns="http://hl7.org/fhir"><active value="true">x</active></Patient>', /value attribute/],
    ['<Patient xmlns="http://hl7.org/fhir"><contained><resourceType value="Organization"/></contained></Patient>', /isn't a resource type|not a resource type|one resource/],
    ['<Patient xmlns="http://hl7.org/fhir"><contained><Organization/><Organization/></contained></Patient>', /should hold one resource/],
    ['<Nonsense xmlns="http://hl7.org/fhir"/>', /'Nonsense' is not a resource type/],
    ['<Patient xmlns="http://hl7.org/fhir"><text><status value="generated"/><div>x</div></text></Patient>', /XHTML namespace/],
    ['<Patient xmlns="http://hl7.org/fhir"><active value="true"></Patient>', /isn't well-formed/],
    ['<Patient xmlns="http://hl7.org/fhir"/><Patient xmlns="http://hl7.org/fhir"/>', /well-formed|one root/]
  ])('refused: %s', (xml, why) => {
    expect(() => fromXml(xml, model)).toThrow(XmlProblem);
    expect(() => fromXml(xml, model)).toThrow(why);
  });

  test.each([
    [{ resourceType: 'Patient', foo: 1 }, /'foo' isn't an element/],
    [{ resourceType: 'Patient', _name: {} }, /'_name' isn't an element/],
    [{ resourceType: 'Patient', gender: ['male'] }, /one value was expected/],
    [{ resourceType: 'Patient', active: { x: 1 } }, /a primitive value was expected/],
    [{ resourceType: 'Patient', _active: { url: 'x' } }, /only have an id and extensions/],
    [{ resourceType: 'Patient', text: { status: 'generated', div: '<div><p>unclosed</div>' } }, /isn't well-formed/],
    [{ resourceType: 'Patient', text: { status: 'generated', div: '<p>not a div</p>' } }, /should be a div/],
    [{ resourceType: 'Patient', contained: [{ resourceType: 'Nonsense' }] }, /'Nonsense' is not a resource type/],
    [{ resourceType: 'Patient', name: [{ family: 'a\u0001b' }] }, /character XML can't carry/]
  ])('can\'t be written: %j', (r, why) => {
    expect(() => toXml(r, model)).toThrow(XmlProblem);
    expect(() => toXml(r, model)).toThrow(why);
  });

  test('a narrative without the namespace gets it', () => {
    const x = toXml({ resourceType: 'Patient', text: { status: 'generated', div: '<div>hi</div>' } }, model);
    expect(x).toContain(`<div xmlns="${XHTML}">hi</div>`);
  });
});

// every resource in a core package, there and back: the same, apart from the narrative's line
// ends (an XML reader makes \r\n and \r into \n, as XML says)
const corpus = (id, version) => async () => {
  const cache = folders.subDir('terminology-cache');
  let folder;
  try {
    const name = await new PackageManager(['https://packages2.fhir.org/packages', 'https://packages.fhir.org'], cache).fetch(id, version);
    folder = path.join(path.isAbsolute(name) ? name : path.join(cache, name), 'package');
  } catch (e) {
    // eslint-disable-next-line no-console -- says why the test passes without checking
    console.log(`xml tests: ${id}#${version} is not available (${e.message}) - skipped`);
    return;
  }
  const files = fs.readdirSync(folder).filter(f => f.endsWith('.json') && !f.startsWith('.') && f !== 'package.json');
  const resources = files.map(f => [f, JSON.parse(fs.readFileSync(path.join(folder, f), 'utf8'))]);
  const m = new XmlModel(deriveXmlModel(resources.map(([, r]) => r).filter(r => r.resourceType === 'StructureDefinition')));
  const norm = (r) => canon(JSON.parse(JSON.stringify(r, (k, v) => (k === 'div' && typeof v === 'string' ? v.replace(/\r\n?/g, '\n') : v))));
  const failed = [];
  for (const [f, r] of resources) {
    try {
      if (norm(fromXml(toXml(r, m), m)) !== norm(r)) {
        failed.push(`${f}: different`);
      }
    } catch (e) {
      failed.push(`${f}: ${e.message}`);
    }
  }
  expect(failed).toEqual([]);
  expect(resources.length).toBeGreaterThan(2000);
};

describe('every resource in the core packages, there and back', () => {
  test('R4', corpus('hl7.fhir.r4.core', '4.0.1'), 600000);
  test('R5', corpus('hl7.fhir.r5.core', '5.0.0'), 600000);
});

// the tx module writes and reads XML its own way, for the resources it serves: each must read
// what the other writes
describe('the tx module\'s XML agrees with this', () => {
  test('R4 core: CodeSystem, ValueSet, ConceptMap, NamingSystem, CapabilityStatement, both ways', async () => {
    const cache = folders.subDir('terminology-cache');
    let folder;
    try {
      const name = await new PackageManager(['https://packages2.fhir.org/packages', 'https://packages.fhir.org'], cache).fetch('hl7.fhir.r4.core', '4.0.1');
      folder = path.join(path.isAbsolute(name) ? name : path.join(cache, name), 'package');
    } catch (e) {
      // eslint-disable-next-line no-console -- says why the test passes without checking
      console.log(`xml tests: hl7.fhir.r4.core#4.0.1 is not available (${e.message}) - skipped`);
      return;
    }
    const tx = {
      CodeSystem: require('../../tx/xml/codesystem-xml').CodeSystemXML, ValueSet: require('../../tx/xml/valueset-xml').ValueSetXML,
      ConceptMap: require('../../tx/xml/conceptmap-xml').ConceptMapXML, NamingSystem: require('../../tx/xml/namingsystem-xml').NamingSystemXML,
      CapabilityStatement: require('../../tx/xml/capabilitystatement-xml').CapabilityStatementXML
    };
    const files = fs.readdirSync(folder).filter(f => f.endsWith('.json') && !f.startsWith('.') && f !== 'package.json');
    const resources = files.map(f => [f, JSON.parse(fs.readFileSync(path.join(folder, f), 'utf8'))]);
    const m = new XmlModel(deriveXmlModel(resources.map(([, r]) => r).filter(r => r.resourceType === 'StructureDefinition')));
    const failed = [];
    let n = 0;
    for (const [f, r] of resources) {
      const C = tx[r.resourceType];
      if (!C) {
        continue;
      }
      n++;
      try {
        if (canon(fromXml(C.toXml(r, 4), m)) !== canon(r)) {
          failed.push(`${f}: read here from the tx module's XML, different`);
        }
        if (canon(C.fromXml(toXml(r, m), 4)) !== canon(r)) {
          failed.push(`${f}: read by the tx module from this XML, different`);
        }
      } catch (e) {
        failed.push(`${f}: ${e.message}`);
      }
    }
    expect(failed).toEqual([]);
    expect(n).toBeGreaterThan(2000);
  }, 600000);
});

describe.each(engines())('XML through the API (%s)', (engine) => {
  let t;
  const XML = 'application/fhir+xml';
  // the response as text, whatever its type
  const text = (r) => r.buffer(true).parse((res, cb) => {
    let d = '';
    res.setEncoding('utf8');
    res.on('data', c => {
      d += c;
    });
    res.on('end', () => cb(null, d));
  });

  beforeAll(async () => {
    t = await makeApp(engine);
  });

  afterAll(async () => {
    await t.close();
  });

  test('the CapabilityStatement, by _format and by Accept', async () => {
    const r = await text(request(t.app).get('/r4/metadata?_format=xml'));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/fhir+xml; charset=utf-8');
    expect(r.body.startsWith('<?xml version="1.0" encoding="UTF-8"?><CapabilityStatement xmlns="http://hl7.org/fhir">')).toBe(true);
    expect(fromXml(r.body, model).format).toEqual(['json', 'xml']);
    for (const [accept, type] of [[XML, 'xml'], ['application/xml', 'xml'], ['text/xml', 'xml'], [FHIR_JSON, 'json'], ['*/*', 'json'],
      [`${XML};q=0.5, ${FHIR_JSON}`, 'json'], [`${FHIR_JSON};q=0.5, ${XML}`, 'xml'], [`*/*;q=0.1, ${XML}`, 'xml']]) {
      const a = await text(request(t.app).get('/r4/metadata').set('Accept', accept));
      // a generic type asked for is the answer's type (application/xml); otherwise FHIR's own
      expect([accept, a.headers['content-type'].split(';')[0]]).toEqual([accept, accept === 'application/xml' ? 'application/xml' : type === 'xml' ? XML : FHIR_JSON]);
    }
    const json = await text(request(t.app).get('/r4/metadata').set('Accept', 'application/json'));
    expect(json.headers['content-type']).toBe('application/json; charset=utf-8');
    expect((await text(request(t.app).get('/r4/metadata?_format=application/json'))).headers['content-type']).toBe('application/json; charset=utf-8');
    expect((await text(request(t.app).get('/r4/metadata?_format=json'))).headers['content-type']).toBe('application/fhir+json; charset=utf-8');
    // a type the server can't do: 406, as an OperationOutcome in JSON
    const odd = await text(request(t.app).get('/r4/metadata').set('Accept', 'image/png'));
    expect(odd.status).toBe(406);
    expect(odd.headers['content-type']).toBe('application/fhir+json; charset=utf-8');
    expect(JSON.parse(odd.body).resourceType).toBe('OperationOutcome');
  });

  test('create, read, update in XML', async () => {
    const x = toXml({ resourceType: 'Patient', name: [{ family: 'Xml', given: ['A'] }], active: true, _active: { extension: [{ url: 'http://x', valueString: 'y' }] } }, model);
    const c = await text(request(t.app).post('/r4/Patient').set('Content-Type', XML).set('Accept', XML).send(x));
    expect(c.status).toBe(201);
    const created = fromXml(c.body, model);
    expect(created.name[0].family).toBe('Xml');
    const id = created.id;
    // stored as JSON, the same
    const j = await request(t.app).get(`/r4/Patient/${id}`);
    expect(j.body.active).toBe(true);
    expect(j.body._active.extension[0].valueString).toBe('y');
    // updated with application/xml, read as text/xml
    const u = await request(t.app).put(`/r4/Patient/${id}`).set('Content-Type', 'application/xml')
      .send(toXml({ resourceType: 'Patient', id, name: [{ family: 'Changed' }] }, model));
    expect(u.status).toBe(200);
    const r = await text(request(t.app).get(`/r4/Patient/${id}`).set('Accept', 'text/xml'));
    expect(fromXml(r.body, model).name[0].family).toBe('Changed');
    // pretty
    const p = await text(request(t.app).get(`/r4/Patient/${id}?_format=xml&_pretty=true`));
    expect(p.body).toContain('\n  <name>\n    <family value="Changed"/>');
  });

  test('a transaction in XML, and its answer', async () => {
    const tx = { resourceType: 'Bundle', type: 'transaction', entry: [
      { fullUrl: 'urn:uuid:11111111-1111-1111-1111-111111111111', resource: { resourceType: 'Organization', name: 'Xml Org' }, request: { method: 'POST', url: 'Organization' } },
      { resource: { resourceType: 'Patient', name: [{ family: 'InTx' }], managingOrganization: { reference: 'urn:uuid:11111111-1111-1111-1111-111111111111' } },
        request: { method: 'POST', url: 'Patient' } }
    ] };
    const r = await text(request(t.app).post('/r4').set('Content-Type', XML).set('Accept', XML).send(toXml(tx, model)));
    expect(r.status).toBe(200);
    const b = fromXml(r.body, model);
    expect(b.type).toBe('transaction-response');
    const org = b.entry[0].response.location.split('/')[1];
    const pat = await request(t.app).get(`/r4/${b.entry[1].response.location.split('/_history')[0]}`);
    expect(pat.body.managingOrganization.reference).toBe(`Organization/${org}`);
  });

  test('a search, as XML', async () => {
    const r = await text(request(t.app).get('/r4/Patient?family=InTx&_format=xml'));
    expect(r.status).toBe(200);
    const b = fromXml(r.body, model);
    expect(b.resourceType).toBe('Bundle');
    expect(b.entry.filter(e => e.search.mode === 'match')).toHaveLength(1);
  });

  test('errors are XML when XML is asked for', async () => {
    const r = await text(request(t.app).get('/r4/Patient/nope').set('Accept', XML));
    expect(r.status).toBe(404);
    expect(r.headers['content-type']).toBe('application/fhir+xml; charset=utf-8');
    expect(fromXml(r.body, model).resourceType).toBe('OperationOutcome');
    // XML that can't be read: 400, saying why
    const bad = await request(t.app).post('/r4/Patient').set('Content-Type', XML).send('<Patient xmlns="http://hl7.org/fhir"><nonsense value="1"/></Patient>');
    expect(bad.status).toBe(400);
    expect(bad.body.issue[0].diagnostics).toMatch(/unknown element 'nonsense'/);
    const dtd = await request(t.app).post('/r4/Patient').set('Content-Type', XML).send('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><Patient xmlns="http://hl7.org/fhir"/>');
    expect(dtd.status).toBe(400);
    // an unknown _format is still 406, in JSON
    const f = await request(t.app).get('/r4/metadata?_format=turtle');
    expect(f.status).toBe(406);
    expect(f.headers['content-type']).toMatch(/fhir\+json/);
  });

  test('a stored resource XML can\'t carry: JSON as ever, XML an error that says why', async () => {
    const r = await request(t.app).post('/r4/Patient').set('Content-Type', FHIR_JSON).send(body({ resourceType: 'Patient', notAnElement: 'x' }));
    expect(r.status).toBe(201);
    const id = r.body.id;
    expect((await request(t.app).get(`/r4/Patient/${id}`)).body.notAnElement).toBe('x');
    // (the error itself is XML: that's what was asked for)
    const x = await text(request(t.app).get(`/r4/Patient/${id}?_format=xml`));
    expect(x.status).toBe(500);
    expect(fromXml(x.body, model).issue[0].diagnostics).toMatch(/'notAnElement' isn't an element the definitions have/);
  });

  test('a large resource as XML: written in parts, the same as in one', async () => {
    const contains = [];
    for (let i = 0; i < 20000; i++) {
      contains.push({ system: 'http://example.org/cs', code: `c${i}`, display: `Code ${i}`, contains: [{ system: 'http://example.org/cs', code: `c${i}.1` }] });
    }
    const vs = { resourceType: 'ValueSet', url: 'http://example.org/big', status: 'active', expansion: { timestamp: '2026-01-01T00:00:00Z', total: 20000, contains } };
    const c = await request(t.app).post('/r4/ValueSet').set('Content-Type', FHIR_JSON).send(body(vs));
    expect(c.status).toBe(201);
    const r = await text(request(t.app).get(`/r4/ValueSet/${c.body.id}?_format=xml`));
    expect(r.status).toBe(200);
    expect(Number(r.headers['content-length'])).toBe(Buffer.byteLength(r.body, 'utf8'));
    const back = fromXml(r.body, model);
    expect(back.expansion.contains).toHaveLength(20000);
    expect(back.expansion.contains[19999].contains[0].code).toBe('c19999.1');
    expect(r.body).toBe(toXml({ ...back }, model));
  });

  test('the web pages link to the XML', async () => {
    const r = await request(t.app).get('/r4/Patient?family=InTx').set('Accept', 'text/html');
    expect(r.text).toMatch(/\?_format=xml">XML<\/a>/);
  });
});
