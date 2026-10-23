//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

const { build, modelOf, textOf, narrativeDiv, setPath, getPath } = require('../../ips/composer');
const { SECTIONS, HEADER, forBrowser } = require('../../ips/editor-schema');
const { validateDocument } = require('../../ips/ips');
const { IpsValueSets } = require('../../ips/ips-valuesets');

const SCT = 'http://snomed.info/sct';

function fullModel() {
  return {
    patient: { family: 'Smith', given: 'Jane A', gender: 'female', birthDate: '1970-05-06', identifier: 'MRN1', identifierSystem: 'urn:oid:1.2.3', phone: '123', email: 'j@x.org', address: '1 Collins St, Melbourne' },
    document: { title: 'My summary', author: 'Dr Jones', authorType: 'Practitioner', custodian: 'Acme', date: '2026-10-22' },
    sections: {
      problems: { mode: 'data', rows: [{ code: { system: SCT, code: '38341003', display: 'Hypertension' }, clinicalStatus: 'active', verificationStatus: 'confirmed', severity: { system: SCT, code: '6736007', display: 'Moderate' }, onset: '2015', bodySite: { text: 'arm' }, note: 'a note' }] },
      allergies: { mode: 'data', rows: [{ code: { text: 'Penicillin' }, type: 'allergy', category: ['medication'], criticality: 'high', clinicalStatus: 'active', reactions: [{ manifestation: [{ system: SCT, code: '271807003', display: 'Rash' }], severity: 'moderate', onset: '2010-01-01' }] }] },
      medications: { mode: 'data', rows: [{ medication: { system: SCT, code: '108774000', display: 'Anastrozole' }, status: 'active', start: '2015-03', reason: [{ text: 'cancer' }], dosage: '1 tablet daily', route: { system: SCT, code: '26643006', display: 'Oral route' } }] },
      immunizations: { mode: 'data', rows: [{ vaccine: { text: 'Flu' }, status: 'completed', date: '2025-04-01', targetDisease: [{ system: SCT, code: '6142004', display: 'Influenza' }], doseNumber: '1', lotNumber: 'L1' }] },
      procedures: { mode: 'data', rows: [{ code: { text: 'Appendicectomy' }, status: 'completed', performed: '1999' }] },
      devices: { mode: 'data', rows: [{ device: 'Pacemaker', deviceType: 'cardiac', status: 'active', start: '2020' }] },
      results: { mode: 'data', rows: [{ code: { system: 'http://loinc.org', code: '2339-0', display: 'Glucose' }, value: { value: 5.5, unit: 'mmol/L' }, date: '2026-01-01', referenceRange: '3.9-6.1' }, { code: { text: 'Culture' }, valueText: 'no growth', date: '2026-01-02' }] },
      vitals: { mode: 'data', rows: [{ code: '85354-9', value: { value: 120 }, value2: { value: 80 }, date: '2026-01-01' }, { code: '29463-7', value: { value: 80, unit: 'kg' }, date: '2026-01-01' }] },
      pastProblems: { mode: 'empty', emptyReason: 'nilknown' },
      pregnancy: { mode: 'data', rows: [{ code: '82810-3', status: '60001007', date: '2026-01-01' }] },
      social: { mode: 'data', rows: [{ code: '72166-2', smoking: '266919005', date: '2026-01-01' }, { code: '74013-4', value: { value: 5, unit: '/wk' }, date: '2026-01-01' }] },
      functional: { mode: 'omit' },
      planOfCare: { mode: 'data', rows: [{ title: 'Lose weight', description: 'diet', status: 'active', start: '2026-01-01' }] },
      directives: { mode: 'data', rows: [{ category: 'DNR', status: 'active', date: '2024-01-01', description: 'Do not resuscitate' }] },
      alerts: { mode: 'narrative', narrative: 'Falls risk.\n\nHard of hearing.' }
    }
  };
}

describe('the composer', () => {
  test('builds a document from a full model, and reads it back', async () => {
    const { bundle, problems } = await build(fullModel(), { now: new Date('2026-10-22T10:00:00Z') });
    expect(problems).toEqual([]);
    expect(validateDocument(bundle)).toEqual([]);
    expect(bundle).toMatchObject({ resourceType: 'Bundle', type: 'document', timestamp: '2026-10-22T10:00:00.000Z' });
    const types = bundle.entry.map(e => e.resource.resourceType);
    expect(types.slice(0, 4)).toEqual(['Composition', 'Patient', 'Practitioner', 'Organization']);
    expect(types.filter(t => t === 'Observation')).toHaveLength(2 + 2 + 1 + 2);
    expect(types).toContain('Device');
    expect(types).toContain('DeviceUseStatement');
    expect(types).toContain('CarePlan');
    expect(types).toContain('Consent');
    expect(bundle.entry.every(e => /^urn:uuid:/.test(e.fullUrl))).toBe(true);
    const comp = bundle.entry[0].resource;
    expect(comp).toMatchObject({ status: 'final', title: 'My summary', date: '2026-10-22', type: { coding: [{ code: '60591-5' }] } });
    expect(comp.subject.reference).toBe(bundle.entry[1].fullUrl);
    expect(comp.author[0]).toEqual({ reference: bundle.entry[2].fullUrl, display: 'Dr Jones' });
    expect(comp.custodian.display).toBe('Acme');
    expect(comp.section.map(s => `${s.code.coding[0].code}:${s.entry ? s.entry.length : s.emptyReason ? 'empty' : 'narrative'}`)).toEqual([
      '11450-4:1', '48765-2:1', '10160-0:1', '11369-6:1', '47519-4:1', '46264-8:1', '30954-2:2', '8716-3:2', '11348-0:empty', '10162-6:1', '29762-2:2', '18776-5:1', '42348-3:1', '104605-1:narrative'
    ]);
    expect(comp.text.div).toContain('<b>Jane A Smith</b>, female, DoB: 06-May 70');
    // the patient
    const patient = bundle.entry[1].resource;
    expect(patient).toMatchObject({ name: [{ family: 'Smith', given: ['Jane', 'A'] }], gender: 'female', birthDate: '1970-05-06', identifier: [{ system: 'urn:oid:1.2.3', value: 'MRN1' }], telecom: [{ system: 'phone', value: '123' }, { system: 'email', value: 'j@x.org' }], address: [{ text: '1 Collins St, Melbourne' }] });
    // the resources
    const byType = (t) => bundle.entry.filter(e => e.resource.resourceType === t).map(e => e.resource);
    expect(byType('Condition')[0]).toMatchObject({
      code: { coding: [{ system: SCT, code: '38341003', display: 'Hypertension' }] },
      clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active', display: 'Active' }] },
      verificationStatus: { coding: [{ code: 'confirmed' }] }, severity: { coding: [{ code: '6736007' }] }, onsetDateTime: '2015',
      bodySite: [{ text: 'arm' }], note: [{ text: 'a note' }], category: [{ coding: [{ code: 'problem-list-item' }] }], subject: { reference: bundle.entry[1].fullUrl }
    });
    expect(byType('AllergyIntolerance')[0]).toMatchObject({ code: { text: 'Penicillin' }, type: 'allergy', category: ['medication'], criticality: 'high', reaction: [{ manifestation: [{ coding: [{ code: '271807003' }] }], severity: 'moderate', onset: '2010-01-01' }], patient: { reference: bundle.entry[1].fullUrl } });
    expect(byType('MedicationStatement')[0]).toMatchObject({ medicationCodeableConcept: { coding: [{ code: '108774000' }] }, status: 'active', effectivePeriod: { start: '2015-03' }, reasonCode: [{ text: 'cancer' }], dosage: [{ text: '1 tablet daily', route: { coding: [{ code: '26643006' }] } }] });
    expect(byType('Immunization')[0]).toMatchObject({ vaccineCode: { text: 'Flu' }, status: 'completed', occurrenceDateTime: '2025-04-01', protocolApplied: [{ targetDisease: [{ coding: [{ code: '6142004' }] }], doseNumberString: '1' }], lotNumber: 'L1' });
    expect(byType('Procedure')[0]).toMatchObject({ code: { text: 'Appendicectomy' }, status: 'completed', performedDateTime: '1999' });
    const device = byType('Device')[0];
    expect(device).toMatchObject({ deviceName: [{ name: 'Pacemaker', type: 'user-friendly-name' }], type: { text: 'cardiac' } });
    expect(byType('DeviceUseStatement')[0]).toMatchObject({ status: 'active', timingPeriod: { start: '2020' }, device: { display: 'Pacemaker' } });
    const obs = byType('Observation');
    expect(obs[0]).toMatchObject({ code: { coding: [{ code: '2339-0' }] }, valueQuantity: { value: 5.5, unit: 'mmol/L', system: 'http://unitsofmeasure.org', code: 'mmol/L' }, effectiveDateTime: '2026-01-01', referenceRange: [{ text: '3.9-6.1' }], status: 'final', category: [{ coding: [{ code: 'laboratory' }] }] });
    expect(obs[1]).toMatchObject({ code: { text: 'Culture' }, valueString: 'no growth' });
    // the blood pressure: components, the unit filled in
    expect(obs[2]).toMatchObject({ code: { coding: [{ system: 'http://loinc.org', code: '85354-9', display: 'Blood pressure' }] }, component: [
      { code: { coding: [{ code: '8480-6' }] }, valueQuantity: { value: 120, unit: 'mm[Hg]', code: 'mm[Hg]' } }, { code: { coding: [{ code: '8462-4' }] }, valueQuantity: { value: 80, unit: 'mm[Hg]' } }
    ], category: [{ coding: [{ code: 'vital-signs' }] }] });
    expect(obs[2].valueQuantity).toBeUndefined();
    expect(obs[3]).toMatchObject({ code: { coding: [{ code: '29463-7' }] }, valueQuantity: { value: 80, unit: 'kg' } });
    expect(obs[4]).toMatchObject({ code: { coding: [{ code: '82810-3' }] }, valueCodeableConcept: { coding: [{ system: SCT, code: '60001007', display: 'Not pregnant' }] } });
    expect(obs[5]).toMatchObject({ code: { coding: [{ code: '72166-2' }] }, valueCodeableConcept: { coding: [{ code: '266919005' }] } });
    expect(obs[6]).toMatchObject({ code: { coding: [{ code: '74013-4' }] }, valueQuantity: { value: 5, unit: '/wk' } });
    expect(byType('CarePlan')[0]).toMatchObject({ title: 'Lose weight', description: 'diet', status: 'active', intent: 'plan', period: { start: '2026-01-01' } });
    expect(byType('Consent')[0]).toMatchObject({ category: [{ text: 'DNR' }], status: 'active', dateTime: '2024-01-01', scope: { coding: [{ code: 'adr' }] }, text: { status: 'additional', div: '<div xmlns="http://www.w3.org/1999/xhtml"><p>Do not resuscitate</p></div>' } });
    // the narratives: generated for the data sections, the user's for theirs, the reason for the empty one
    expect(comp.section[0].text).toEqual({ status: 'generated', div: expect.stringContaining('<td>Hypertension</td>') });
    expect(comp.section[13].text).toEqual({ status: 'additional', div: '<div xmlns="http://www.w3.org/1999/xhtml"><p>Falls risk.</p><p>Hard of hearing.</p></div>' });
    expect(comp.section[8]).toMatchObject({ emptyReason: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/list-empty-reason', code: 'nilknown', display: 'Nil known' }] }, text: { div: expect.stringContaining('Nil known') } });
    // and back
    const m = modelOf(bundle);
    expect(m.patient).toEqual({ family: 'Smith', given: 'Jane A', gender: 'female', birthDate: '1970-05-06', identifier: 'MRN1', identifierSystem: 'urn:oid:1.2.3', phone: '123', email: 'j@x.org', address: '1 Collins St, Melbourne' });
    expect(m.document).toEqual({ title: 'My summary', date: '2026-10-22', authorType: 'Practitioner', author: 'Dr Jones', custodian: 'Acme' });
    expect(Object.keys(m.sections)).toEqual(['problems', 'allergies', 'medications', 'immunizations', 'procedures', 'devices', 'results', 'vitals', 'pastProblems', 'pregnancy', 'social', 'planOfCare', 'directives', 'alerts']);
    expect(m.sections.problems.rows[0]).toEqual({ code: { system: SCT, code: '38341003', display: 'Hypertension', text: '' }, clinicalStatus: 'active', verificationStatus: 'confirmed', severity: { system: SCT, code: '6736007', display: 'Moderate', text: '' }, onset: '2015', bodySite: { system: '', code: '', display: '', text: 'arm' }, note: 'a note' });
    expect(m.sections.allergies.rows[0].reactions).toEqual([{ manifestation: [{ system: SCT, code: '271807003', display: 'Rash', text: '' }], severity: 'moderate', onset: '2010-01-01' }]);
    expect(m.sections.medications.rows[0]).toMatchObject({ medication: { code: '108774000' }, status: 'active', start: '2015-03', reason: [{ text: 'cancer' }], dosage: '1 tablet daily', route: { code: '26643006' } });
    expect(m.sections.devices.rows[0]).toEqual({ device: 'Pacemaker', deviceType: 'cardiac', status: 'active', start: '2020' });
    expect(m.sections.vitals.rows[0]).toEqual({ code: '85354-9', value: { value: 120, unit: 'mm[Hg]' }, value2: { value: 80, unit: 'mm[Hg]' }, date: '2026-01-01' });
    expect(m.sections.results.rows[1]).toEqual({ code: { system: '', code: '', display: '', text: 'Culture' }, valueText: 'no growth', date: '2026-01-02' });
    expect(m.sections.pastProblems).toEqual({ mode: 'empty', emptyReason: 'nilknown' });
    expect(m.sections.alerts).toEqual({ mode: 'narrative', narrative: 'Falls risk.\nHard of hearing.' });
    expect(m.sections.directives.rows[0]).toEqual({ category: 'DNR', status: 'active', date: '2024-01-01', description: 'Do not resuscitate' });
    // building the read-back model gives the same document again
    const again = await build(m, { now: new Date('2026-10-22T10:00:00Z') });
    expect(again.problems).toEqual([]);
    expect(again.bundle.entry.map(e => e.resource.resourceType)).toEqual(types);
  });

  test('reports what is wrong with a model', async () => {
    const bad = await build({ patient: { gender: 'x', birthDate: 'soon' }, document: {}, sections: {
      problems: { mode: 'data', rows: [{ clinicalStatus: 'odd' }] },
      allergies: { mode: 'empty' },
      medications: { mode: 'narrative', narrative: '   ' },
      vitals: { mode: 'data', rows: [{ code: '85354-9', value: { value: 1 } }, { code: '8867-4', value: { value: 70 }, value2: { value: 1 }, date: '2026' }] },
      results: { mode: 'data', rows: [{ code: { text: 'x' }, date: '2026' }] }
    } });
    expect(bad.bundle).toBeNull();
    expect(bad.problems).toEqual([
      'The patient needs a family name',
      'The patient\'s gender is not one of the choices',
      'The patient\'s date of birth is not a date (YYYY, YYYY-MM or YYYY-MM-DD)',
      'The document needs an author',
      'Problem List, entry 1: Problem is required',
      'Problem List, entry 1: Clinical status is not valid',
      'The Allergies and Intolerances section needs a reason for being empty',
      'The Medication Summary section\'s narrative is empty',
      'Results, entry 1: a value is required',
      'Vital Signs, entry 1: Date is required',
      'Vital Signs, entry 2: only a blood pressure has a diastolic value'
    ]);
    expect((await build(null)).problems).toEqual(['The model must be an object']);
    expect((await build({ patient: { family: 'x' }, document: { author: 'a' }, sections: {} })).problems).toEqual([
      'The Problem List section is required: enter its entries, a narrative, or why it is empty',
      'The Allergies and Intolerances section is required: enter its entries, a narrative, or why it is empty',
      'The Medication Summary section is required: enter its entries, a narrative, or why it is empty'
    ]);
    const long = await build({ patient: { family: 'x' }, document: { author: 'a' }, sections: { problems: { mode: 'data', rows: new Array(201).fill({ code: { text: 'x' } }) }, allergies: { mode: 'empty', emptyReason: 'nilknown' }, medications: { mode: 'empty', emptyReason: 'nilknown' } } });
    expect(long.problems).toEqual(['The Problem List section has too many entries (200 at most)']);
  });

  test('the minimum: a patient, an author, and the three sections', async () => {
    const { bundle, problems } = await build({ patient: { family: 'Doe' }, document: { author: 'Clinic', authorType: 'Organization' }, sections: {
      problems: { mode: 'empty', emptyReason: 'nilknown' }, allergies: { mode: 'empty', emptyReason: 'notasked' }, medications: { mode: 'empty', emptyReason: 'nilknown' }
    } });
    expect(problems).toEqual([]);
    expect(validateDocument(bundle)).toEqual([]);
    expect(bundle.entry.map(e => e.resource.resourceType)).toEqual(['Composition', 'Patient', 'Organization']);
    expect(bundle.entry[0].resource.title).toMatch(/^Patient Summary as of \d{4}-\d\d-\d\d$/);
    expect(bundle.entry[0].resource.section).toHaveLength(3);
    const m = modelOf(bundle);
    expect(m.document).toMatchObject({ authorType: 'Organization', author: 'Clinic' });
  });

  test('reads a document the form cannot wholly hold', () => {
    const bundle = {
      resourceType: 'Bundle', type: 'document', entry: [
        { fullUrl: 'urn:uuid:c', resource: { resourceType: 'Composition', subject: { reference: 'Patient/p' }, author: [{ display: 'Someone' }], section: [
          { code: { coding: [{ system: 'http://loinc.org', code: '11450-4' }] }, entry: [{ reference: 'urn:uuid:x' }, { reference: 'urn:uuid:cond' }] },
          { code: { coding: [{ system: 'http://loinc.org', code: '48765-2' }] }, entry: [{ reference: 'urn:uuid:x' }], text: { div: '<div xmlns="http://www.w3.org/1999/xhtml"><p>See <b>notes</b></p><p>more &amp; more</p></div>' } },
          { code: { coding: [{ system: 'http://loinc.org', code: '10160-0' }] }, emptyReason: { coding: [{ code: 'oddreason' }] }, text: { div: '<div>nothing</div>' } },
          { code: { coding: [{ system: 'http://loinc.org', code: '99999-9' }] }, entry: [] }
        ] } },
        { fullUrl: 'urn:uuid:p', resource: { resourceType: 'Patient', id: 'p', name: [{ text: 'Jo Bloggs' }] } },
        { fullUrl: 'urn:uuid:x', resource: { resourceType: 'Basic', id: 'x' } },
        { fullUrl: 'urn:uuid:cond', resource: { resourceType: 'Condition', id: 'cond', code: { coding: [{ system: SCT, code: '1' }] }, onsetPeriod: { start: '2020' }, note: [{ text: 'a' }, { text: 'b' }] } }
      ]
    };
    const m = modelOf(bundle);
    expect(m.patient).toMatchObject({ family: 'Jo Bloggs', given: '' });
    expect(m.document).toMatchObject({ author: 'Someone' });
    expect(m.sections.problems).toEqual({ mode: 'data', rows: [{ code: { system: SCT, code: '1', display: '', text: '' }, note: 'a\nb' }], partial: true });
    // only unheld entries: the narrative instead
    expect(m.sections.allergies).toEqual({ mode: 'narrative', narrative: 'See notes\nmore & more' });
    // an empty reason the form doesn't offer: the narrative
    expect(m.sections.medications).toEqual({ mode: 'narrative', narrative: 'nothing' });
    expect(m.sections.immunizations).toBeUndefined();
    expect(modelOf(null)).toEqual({ patient: {}, document: {}, sections: {} });
    expect(textOf('<div><ul><li>a</li><li>b &lt;c&gt;</li></ul></div>')).toBe('a\nb <c>');
    // from a parse, not by stripping tags: what isn't text stays out, and > in an attribute is no tag end
    expect(textOf('<div xmlns="http://www.w3.org/1999/xhtml"><p title="a > b">one<br/>two</p><!-- note --><style>p { x: y }</style><p>three &amp; <b>four</b></p></div>')).toBe('one\ntwo\nthree & four');
    expect(textOf('<div><scr<script>ipt>alert(1)</script></div>')).toBe('ipt>alert(1)');
    expect(textOf('<div><table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table></div>')).toBe('a b\nc');
    expect(narrativeDiv('one\ntwo\n\nthree <x>')).toBe('<div xmlns="http://www.w3.org/1999/xhtml"><p>one<br/>two</p><p>three &lt;x&gt;</p></div>');
  });

  test('the schema holds together: every code field names one of our value sets, every section an IPS code', () => {
    const valueSets = new IpsValueSets().load();
    const VS = 'http://healthintersections.com.au/fhirsmith/ValueSet/';
    for (const def of SECTIONS) {
      expect(def.code).toMatch(/^\d+-\d$/);
      for (const f of [...def.fields, ...(def.subs || []).flatMap(s => s.fields)]) {
        if (f.type === 'code') {
          expect(valueSets.valueSet(VS + f.valueSet)).not.toBeNull();
        }
        if (f.type === 'select') {
          expect(f.options.length).toBeGreaterThan(0);
        }
        expect(f.path || f.name === 'note').toBeTruthy();
      }
    }
    expect(SECTIONS.filter(s => s.required).map(s => s.key)).toEqual(['problems', 'allergies', 'medications']);
    const b = forBrowser();
    expect(b.sections).toBe(SECTIONS);
    expect(b.header).toBe(HEADER);
    expect(b.emptyReasons.map(r => r.code)).toEqual(['nilknown', 'notasked', 'withheld', 'unavailable', 'notstarted', 'closed']);
  });
});

describe('paths', () => {
  test('never reach a prototype', () => {
    for (const path of ['__proto__.polluted', 'a.__proto__.polluted', 'constructor.prototype.polluted', 'a.prototype', '__proto__[x]']) {
      expect(() => setPath({}, path, 'yes', {})).toThrow(/is not one a resource can have/);
      expect(() => getPath({}, path, {})).toThrow(/is not one a resource can have/);
    }
    expect({}.polluted).toBeUndefined();
    expect(Object.prototype.polluted).toBeUndefined();
    // ordinary paths are as they were
    const r = {};
    setPath(r, 'code.text', 'x', {});
    expect(r).toEqual({ code: { text: 'x' } });
    expect(getPath(r, 'code.text', {})).toBe('x');
  });
});
