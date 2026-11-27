//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * FHIRPath Patch (rest/library/fhirpath-patch.js) against the shared test cases:
 * fhir-test-cases r4/patch/fhir-patch-tests.xml and r5/patch/fhir-patch-tests.xml, as the old
 * Pascal server ran them (found by tests/helpers/fhir-test-cases.js). Each case is an input, a
 * patch, and the output or the error; only applying is tested here (the cases marked "both"
 * also test making the patch from the input and output, which isn't supported). And then the
 * things the cases don't cover.
 */

const path = require('path');
const folders = require('../../library/folder-setup');
const { PackageManager } = require('../../library/package-manager');
const { loadXmlModel, fromXml } = require('../../library/fhir-xml');
const { readTestCase } = require('../helpers/fhir-test-cases');
const { applyFhirPathPatch, PatchError } = require('../../rest/library/fhirpath-patch');
const { modelFor, fhirpathOptions } = require('../../rest/indexing/definitions');

const VERSIONS = { r4: { core: 'hl7.fhir.r4.core#4.0.1', fhir: '4.0.1' }, r5: { core: 'hl7.fhir.r5.core#5.0.0', fhir: '5.0.0' } };

const decode = (s) => s.replace(/&apos;/g, '\'').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** The cases in a fhir-patch-tests.xml: { name, mode, input, diff, output, error } (XML text) */
function readCases(text) {
  const out = [];
  const section = (body, name) => {
    const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body);
    return m ? m[1].trim() : null;
  };
  for (const m of text.matchAll(/<case name="([^"]*)" mode="(\w+)"\s*>([\s\S]*?)<\/case>/g)) {
    const [, name, mode, body] = m;
    const error = /<error msg="([^"]*)"\s*\/>/.exec(body);
    out.push({ name: decode(name), mode, input: section(body, 'input'), diff: section(body, 'diff'), output: section(body, 'output'), error: error ? decode(error[1]) : null });
  }
  return out;
}

/**
 * JSON with its keys in order, for comparing. In the narrative, &quot; and " are the same text
 * (a div read from XML keeps its escapes; one in a patch's valueString has them decoded)
 */
function canon(v, key) {
  if (key === 'div' && typeof v === 'string') {
    return v.replace(/&quot;/g, '"').replace(/&apos;/g, '\'');
  }
  if (Array.isArray(v)) {
    return v.map(canon);
  }
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) {
      o[k] = canon(v[k], k);
    }
    return o;
  }
  return v;
}

const contexts = {};
async function context(v) {
  if (!contexts[v]) {
    const cache = folders.subDir('terminology-cache');
    const pm = new PackageManager(['https://packages2.fhir.org/packages', 'https://packages.fhir.org'], cache);
    const xml = await loadXmlModel({ corePackage: VERSIONS[v].core, packageManager: pm, cacheFolder: cache });
    const model = modelFor(VERSIONS[v].fhir);
    contexts[v] = { xml, model, options: fhirpathOptions(model).options };
  }
  return contexts[v];
}

for (const v of Object.keys(VERSIONS)) {
  const cases = readCases(readTestCase(path.posix.join(v, 'patch', 'fhir-patch-tests.xml')));

  describe(`FHIRPath Patch: fhir-test-cases ${v}/patch/fhir-patch-tests.xml`, () => {
    let ctx;
    beforeAll(async () => {
      ctx = await context(v);
    }, 300000);

    test('has cases', () => {
      expect(cases.length).toBeGreaterThan(30);
    });

    for (const c of cases) {
      test(c.name, () => {
        const input = fromXml(c.input, ctx.xml);
        const diff = fromXml(c.diff, ctx.xml);
        const before = JSON.stringify(input);
        if (c.error) {
          expect(() => applyFhirPathPatch(input, diff, ctx)).toThrow(PatchError);
          expect(() => applyFhirPathPatch(input, diff, ctx)).toThrow(c.error);
        } else {
          const out = applyFhirPathPatch(input, diff, ctx);
          expect(canon(out)).toEqual(canon(fromXml(c.output, ctx.xml)));
        }
        // the input isn't changed
        expect(JSON.stringify(input)).toBe(before);
      });
    }
  });
}

describe('FHIRPath Patch: beyond the shared cases (R4)', () => {
  let ctx;
  beforeAll(async () => {
    ctx = await context('r4');
  }, 300000);

  const op = (type, parts) => ({
    name: 'operation',
    part: [{ name: 'type', valueCode: type }, ...Object.entries(parts).map(([name, value]) =>
      (name === 'value' ? { name, ...value } : { name, [Number.isInteger(value) ? 'valueInteger' : 'valueString']: value }))]
  });
  const patch = (...ops) => ({ resourceType: 'Parameters', parameter: ops });
  const apply = (r, ...ops) => applyFhirPathPatch(r, patch(...ops), ctx);

  test('a primitive\'s extensions: kept alongside, in lists too', () => {
    const r = { resourceType: 'Patient', name: [{ given: ['a', 'b'], _given: [null, { id: 'x' }] }] };
    const ext = { valueString: 'c', _valueString: { extension: [{ url: 'http://example.org/e', valueBoolean: true }] } };
    let out = apply(r, op('insert', { path: 'Patient.name[0].given', index: 0, value: ext }));
    expect(out.name[0].given).toEqual(['c', 'a', 'b']);
    expect(out.name[0]._given).toEqual([{ extension: [{ url: 'http://example.org/e', valueBoolean: true }] }, null, { id: 'x' }]);
    out = apply(r, op('move', { path: 'Patient.name[0].given', source: 1, destination: 0 }));
    expect(out.name[0].given).toEqual(['b', 'a']);
    expect(out.name[0]._given).toEqual([{ id: 'x' }, null]);
    out = apply(r, op('delete', { path: 'Patient.name[0].given[1]' }));
    expect(out.name[0]).toEqual({ given: ['a'] });
    out = apply(r, op('replace', { path: 'Patient.name[0].given[1]', value: { valueString: 'z' } }));
    expect(out.name[0]).toEqual({ given: ['a', 'z'] });
  });

  test('adding an extension to a primitive', () => {
    const r = { resourceType: 'Patient', birthDate: '1920-01-01' };
    const out = apply(r, op('add', { path: 'Patient.birthDate', name: 'extension', value: { part: [
      { name: 'url', valueUri: 'http://example.org/e' }, { name: 'value', valueString: 'x' }] } }));
    expect(out).toEqual({ resourceType: 'Patient', birthDate: '1920-01-01', _birthDate: { extension: [{ url: 'http://example.org/e', valueString: 'x' }] } });
    const back = apply(out, op('delete', { path: 'Patient.birthDate.extension' }));
    expect(back).toEqual(r);
  });

  test('a choice element: the value\'s type picks the name, and replace can change it', () => {
    const r = { resourceType: 'Observation', status: 'final', code: { text: 'x' }, valueString: 'a' };
    const out = apply(r, op('replace', { path: 'Observation.value', value: { valueQuantity: { value: 1, unit: 'mg' } } }));
    expect(out.valueString).toBeUndefined();
    expect(out.valueQuantity).toEqual({ value: 1, unit: 'mg' });
    expect(() => apply(r, op('replace', { path: 'Observation.value', value: { valueHumanName: { text: 'n' } } }))).toThrow(/HumanName can't go in Observation.value/);
  });

  test('inserting into an empty list, and the index checked', () => {
    const r = { resourceType: 'Patient', id: 'p' };
    const id = { valueIdentifier: { value: '1' } };
    expect(apply(r, op('insert', { path: 'Patient.identifier', index: 0, value: id })).identifier).toEqual([{ value: '1' }]);
    expect(() => apply(r, op('insert', { path: 'Patient.identifier', index: 1, value: id }))).toThrow(/Can't insert at 1/);
    const two = { resourceType: 'Patient', identifier: [{ value: '1' }, { value: '2' }] };
    expect(() => apply(two, op('insert', { path: 'Patient.identifier.where(value = \'1\')', index: 0, value: id }))).toThrow(/whole of the list/);
    expect(() => apply(two, op('move', { path: 'Patient.identifier', source: 0, destination: 2 }))).toThrow(/destination \(2\)/);
  });

  test('add won\'t overwrite, and needs a known element', () => {
    const r = { resourceType: 'Patient', birthDate: '1920-01-01' };
    expect(() => apply(r, op('add', { path: 'Patient', name: 'birthDate', value: { valueDate: '1930-01-01' } }))).toThrow(/already has a value/);
    expect(() => apply(r, op('add', { path: 'Patient', name: 'colour', value: { valueString: 'red' } }))).toThrow(/Patient has no element 'colour'/);
    expect(() => apply(r, op('add', { path: 'Patient', name: 'gender', value: { valueBoolean: true } }))).toThrow(/Boolean can't go in Patient.gender/);
  });

  test('delete: nothing there is fine; more than one isn\'t; the resource can\'t go', () => {
    const r = { resourceType: 'Patient', identifier: [{ value: '1' }, { value: '2' }] };
    expect(apply(r, op('delete', { path: 'Patient.birthDate' }))).toEqual(r);
    expect(() => apply(r, op('delete', { path: 'Patient.identifier' }))).toThrow(/Multiple locations/);
    expect(() => apply(r, op('delete', { path: 'Patient' }))).toThrow(/resource itself/);
  });

  test('contained resources, and resolve() to them; not to other resources', () => {
    const r = { resourceType: 'Patient', contained: [{ resourceType: 'Organization', id: 'o', name: 'old' }], managingOrganization: { reference: '#o' } };
    let out = apply(r, op('replace', { path: 'Patient.contained[0].name', value: { valueString: 'new' } }));
    expect(out.contained[0].name).toBe('new');
    out = apply(r, op('replace', { path: 'Patient.managingOrganization.resolve().name', value: { valueString: 'resolved' } }));
    expect(out.contained[0].name).toBe('resolved');
    const ext = { resourceType: 'Patient', managingOrganization: { reference: 'Organization/1' } };
    expect(() => apply(ext, op('add', { path: 'Patient.managingOrganization.resolve()', name: 'name', value: { valueString: 'x' } })))
      .toThrow(/resolve\(\) can only refer to the resource being patched/);
  });

  test('operations apply in order, and an error says which', () => {
    const r = { resourceType: 'Patient' };
    const out = apply(r, op('add', { path: 'Patient', name: 'gender', value: { valueCode: 'male' } }), op('replace', { path: 'Patient.gender', value: { valueCode: 'female' } }));
    expect(out.gender).toBe('female');
    expect(() => apply(r, op('add', { path: 'Patient', name: 'gender', value: { valueCode: 'male' } }), op('replace', { path: 'Patient.birthDate', value: { valueDate: '2000' } })))
      .toThrow(/^Operation 2 \(replace at Patient.birthDate\): No content found/);
  });

  test('a badly made patch', () => {
    const r = { resourceType: 'Patient' };
    expect(() => applyFhirPathPatch(r, { resourceType: 'Parameters', parameter: [{ name: 'other', valueString: 'x' }] }, ctx)).toThrow(/only operations/);
    expect(() => apply(r, op('frobnicate', { path: 'Patient' }))).toThrow(/'frobnicate' isn't an operation/);
    expect(() => apply(r, op('add', { path: 'Patient', name: 'gender' }))).toThrow(/needs a value/);
    expect(() => apply(r, op('insert', { path: 'Patient.identifier', value: { valueIdentifier: {} } }))).toThrow(/needs an index, a whole number/);
    expect(() => apply(r, op('delete', { path: 'Patient.(' }))).toThrow(/can't be evaluated/);
    expect(() => applyFhirPathPatch(r, [], ctx)).toThrow(/Parameters resource/);
  });
});
