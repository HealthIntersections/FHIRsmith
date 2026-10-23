//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

const { Presenter, NONE, dateText, periodText, quantityText, rangeText, humanNameText, identifierText } = require('../../ips/presenter');

const SCT = 'http://snomed.info/sct';

/** A document: a patient with a problem, an allergy with reactions, a medication, a result and an empty section - sections out of IPS order. */
function doc() {
  return {
    resourceType: 'Bundle', type: 'document',
    entry: [
      { fullUrl: 'urn:uuid:comp', resource: { resourceType: 'Composition', id: 'comp', status: 'final', title: 'Summary <of> Jane', date: '2026-03-01T09:30:00+10:00',
        type: { coding: [{ system: 'http://loinc.org', code: '60591-5' }] },
        subject: { reference: 'urn:uuid:pat' }, author: [{ reference: 'urn:uuid:pract' }, { display: 'Dr Who' }], custodian: { reference: 'urn:uuid:org' },
        attester: [{ mode: 'legal', party: { reference: 'urn:uuid:pract' }, time: '2026-03-01' }],
        event: [{ code: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActClass', code: 'PCPR', display: 'care provision' }] }], period: { end: '2026-03-01' }}],
        section: [
          { title: 'Results', code: { coding: [{ system: 'http://loinc.org', code: '30954-2' }] }, entry: [{ reference: 'urn:uuid:obs' }, { reference: 'urn:uuid:nowhere' }] },
          { code: { coding: [{ system: 'http://loinc.org', code: '10160-0' }] }, entry: [{ reference: 'urn:uuid:ms' }] },
          { title: 'Allergies', code: { coding: [{ system: 'http://loinc.org', code: '48765-2' }] }, entry: [{ reference: 'urn:uuid:all' }, { reference: 'urn:uuid:all' }] },
          { title: 'Problems', code: { coding: [{ system: 'http://loinc.org', code: '11450-4' }] }, entry: [{ reference: 'urn:uuid:cond' }],
            section: [{ title: 'Old problems', code: { coding: [{ system: 'http://loinc.org', code: '11348-0' }] }, emptyReason: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/list-empty-reason', code: 'nilknown', display: 'Nil Known' }] } }] },
          { title: 'Devices', code: { coding: [{ system: 'http://loinc.org', code: '46264-8' }] }, text: { status: 'generated', div: '<div xmlns="http://www.w3.org/1999/xhtml"><p>No <b>devices</b></p></div>' } },
          { title: 'Something else', code: { coding: [{ system: 'http://example.org', code: 'x' }] }, entry: [{ reference: 'urn:uuid:flag' }, { reference: 'urn:uuid:basic' }] },
          { title: 'Vital Signs', code: { coding: [{ system: 'http://loinc.org', code: '8716-3' }] } }
        ] } },
      { fullUrl: 'urn:uuid:pat', resource: { resourceType: 'Patient', id: 'pat', identifier: [{ system: 'urn:oid:1.2.36.146.595.217.0.1', value: 'MRN-1' }, { type: { text: 'Passport' }, value: 'P1' }],
        name: [{ use: 'nickname', given: ['Janie'] }, { use: 'official', family: 'Smith', given: ['Jane', 'A'], prefix: ['Ms'] }], gender: 'female', birthDate: '1970-05-06',
        telecom: [{ system: 'phone', value: '+61 3 9999 0000', use: 'home' }], address: [{ line: ['1 Collins St'], city: 'Melbourne', postalCode: '3000', country: 'AU' }],
        maritalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-MaritalStatus', code: 'M' }] },
        communication: [{ language: { coding: [{ system: 'urn:ietf:bcp:47', code: 'en-AU', display: 'English (Australia)' }] }, preferred: true }],
        generalPractitioner: [{ reference: 'urn:uuid:pract' }], managingOrganization: { reference: 'urn:uuid:org' },
        contact: [{ relationship: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v2-0131', code: 'N', display: 'Next-of-Kin' }] }], name: { family: 'Smith', given: ['John'] }, telecom: [{ system: 'phone', value: '123' }] }] } },
      { fullUrl: 'urn:uuid:pract', resource: { resourceType: 'Practitioner', id: 'pract', name: [{ family: 'Jones', given: ['Sam'] }] } },
      { fullUrl: 'urn:uuid:org', resource: { resourceType: 'Organization', id: 'org', name: 'Acme & Co' } },
      { fullUrl: 'urn:uuid:cond', resource: { resourceType: 'Condition', id: 'cond', code: { coding: [{ system: SCT, code: '38341003' }] }, clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active', display: 'Active' }] },
        onsetDateTime: '2015', bodySite: [{ text: 'left arm' }], note: [{ text: 'a note', authorString: 'me' }] } },
      { fullUrl: 'urn:uuid:all', resource: { resourceType: 'AllergyIntolerance', id: 'all', code: { text: 'Penicillin' }, type: 'allergy', criticality: 'high',
        reaction: [{ manifestation: [{ coding: [{ system: SCT, code: '271807003', display: 'Rash' }] }], severity: 'moderate', substance: { text: 'Amoxicillin' } }, { manifestation: [{ text: 'Wheeze' }] }] } },
      { fullUrl: 'urn:uuid:med', resource: { resourceType: 'Medication', id: 'med', code: { coding: [{ system: SCT, code: '108774000', display: 'Anastrozole' }] } } },
      { fullUrl: 'urn:uuid:ms', resource: { resourceType: 'MedicationStatement', id: 'ms', status: 'active', medicationReference: { reference: 'urn:uuid:med' }, effectivePeriod: { start: '2015-03' },
        dosage: [{ doseAndRate: [{ doseQuantity: { value: 1, unit: 'tablet' } }], route: { text: 'oral' }, timing: { repeat: { frequency: 2, period: 1, periodUnit: 'd' } } }] } },
      { fullUrl: 'urn:uuid:obs', resource: { resourceType: 'Observation', id: 'obs', status: 'final', code: { coding: [{ system: 'http://loinc.org', code: '2339-0', display: 'Glucose' }] }, effectiveDateTime: '2026-02-01',
        valueQuantity: { value: 5.5, unit: 'mmol/L' }, interpretation: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation', code: 'N', display: 'Normal' }] }],
        referenceRange: [{ low: { value: 3.9, unit: 'mmol/L' }, high: { value: 6.1, unit: 'mmol/L' } }],
        component: [{ code: { text: 'Comment' }, valueString: 'fasting' }] } },
      { fullUrl: 'urn:uuid:flag', resource: { resourceType: 'Flag', id: 'flag', status: 'active', code: { text: 'Falls risk' } } },
      { fullUrl: 'urn:uuid:basic', resource: { resourceType: 'Basic', id: 'b1', code: { text: 'Something' } } }
    ]
  };
}

describe('the IPS presenter', () => {
  test('renders the header, the patient, and the sections in the IPS order with their titles', async () => {
    const lookups = [];
    const p = new Presenter({ lookup: async (c) => { lookups.push(`${c.system}|${c.code}`); return c.code === '38341003' ? 'Hypertension' : null; } });
    const out = await p.render(doc());
    expect(out.html.startsWith('<div xmlns="http://www.w3.org/1999/xhtml"><h1>Summary &lt;of&gt; Jane</h1>')).toBe(true);
    // the patient, as the Java renderer puts it
    expect(out.html).toContain('<p class="ips-patient"><b>Ms Jane A Smith</b>, female, DoB: 06-May 70, ( 1.2.36.146.595.217.0.1: MRN-1, Passport: P1 )</p>');
    expect(out.html).toContain('<tr><td><b>Other names</b></td><td>Janie (nickname)</td></tr>');
    expect(out.html).toContain('<tr><td><b>Contact details</b></td><td>phone: +61 3 9999 0000 (home)</td></tr>');
    expect(out.html).toContain('<tr><td><b>Address</b></td><td>1 Collins St, Melbourne, 3000, AU</td></tr>');
    expect(out.html).toContain('<tr><td><b>Marital status</b></td><td>M</td></tr>'); // no display, the lookup had none: the code
    expect(out.html).toContain('<tr><td><b>Language</b></td><td>English (Australia) (preferred)</td></tr>');
    expect(out.html).toContain('<tr><td><b>Managing organization</b></td><td>Acme &amp; Co</td></tr>');
    expect(out.html).toContain('<tr><td><b>General practitioner</b></td><td>Sam Jones</td></tr>');
    expect(out.html).toContain('<tr><td><b>Contacts</b></td><td>John Smith (Next-of-Kin) phone: 123</td></tr>');
    // the document's facts
    expect(out.html).toContain('<tr><td><b>Date</b></td><td>01-Mar 26 09:30 (+10:00)</td></tr>');
    expect(out.html).toContain('<tr><td><b>Author</b></td><td>Sam Jones; Dr Who</td></tr>');
    expect(out.html).toContain('<tr><td><b>Attester</b></td><td>legal Sam Jones 01-Mar 26</td></tr>');
    expect(out.html).toContain('<tr><td><b>Custodian</b></td><td>Acme &amp; Co</td></tr>');
    expect(out.html).toContain('<tr><td><b>Event</b></td><td>care provision until 01-Mar 26</td></tr>');
    // the sections, in the IPS order, the unknown one last, the nested one after its parent; the default title for the untitled one
    const titles = [...out.html.matchAll(/<h([23])>([^<]*)<\/h\d>/g)].map(m => `${m[1]}:${m[2]}`);
    expect(titles).toEqual(['2:Problems', '3:Old problems', '2:Allergies', '2:Medication Summary', '2:Devices', '2:Vital Signs', '2:Results', '2:Something else']);
    expect(out.sections.map(s => s.title)).toEqual(['Problems', 'Old problems', 'Allergies', 'Medication Summary', 'Devices', 'Vital Signs', 'Results', 'Something else']);
    expect(out.sections[0].section).toBe(p.bundle.entry[0].resource.section[3]);
    // a section with no entries: its narrative (parsed), its emptyReason, or nothing
    expect(out.html).toContain('<h2>Devices</h2><p class="ips-as-submitted"><i>Narrative as submitted</i></p><p>No <b>devices</b></p>');
    expect(out.html).toContain('<h3>Old problems</h3><p><i>Nil Known</i></p>');
    expect(out.html).toContain('<h2>Vital Signs</h2><p><i>Nothing found to render</i></p>');
    // an entry that is not in the document
    expect(out.html).toContain('<p><i>Not in the document: urn:uuid:nowhere</i></p>');
    // the problem: the lookup gave the display; empty columns left out (no category, severity, abatement...); the statuses in one column
    expect(out.html).toContain('<h2>Problems</h2><table class="ips-section"><thead><tr><th>Problem</th><th>Status</th><th>Onset</th></tr></thead><tbody>' +
      '<tr><td>Hypertension</td><td>Active</td><td>2015</td></tr>' +
      '<tr class="ips-follow"><td></td><td colspan="2"><b>Body sites</b><ul><li>left arm</li></ul></td></tr>' +
      '<tr class="ips-follow"><td></td><td colspan="2"><b>Notes</b><ul><li>a note <i>(me)</i></li></ul></td></tr></tbody></table>');
    expect(lookups).toEqual(['http://terminology.hl7.org/CodeSystem/v3-MaritalStatus|M', 'http://loinc.org|60591-5', `${SCT}|38341003`]);
    // the allergy, once though it is referenced twice, with its reactions as bullets
    expect(out.html.match(/<td>Penicillin<\/td>/g)).toHaveLength(1);
    expect(out.html).toContain('<b>Reactions</b><ul><li>Rash to Amoxicillin (moderate)</li><li>Wheeze</li></ul>');
    expect(out.html).toContain('<th>Allergy / intolerance</th><th>Type</th><th>Criticality</th></tr>');
    // the medication: resolved to the Medication's code, and the dosage as text
    expect(out.html).toContain('<tr><td>Anastrozole</td><td>active</td><td>from Mar 15</td><td>1 tablet oral 2 times per 1 d</td></tr>');
    // the result: value with unit, interpretation, the one reference range as a column, components beneath
    expect(out.html).toContain('<tr><td>Glucose</td><td>5.5 mmol/L</td><td>Normal</td><td>3.9 mmol/L - 6.1 mmol/L</td><td>01-Feb 26</td><td>final</td></tr>');
    expect(out.html).toContain('<b>Components</b><ul><li>Comment: fasting</li></ul>');
    expect(out.html).not.toContain('<b>Reference ranges</b>');
    // the mixed section: the generic columns - category, name, type, code, value, where they have them
    expect(out.html).toContain('<h2>Something else</h2><table class="ips-section"><thead><tr><th>Resource</th><th>Code</th><th>Status</th></tr></thead><tbody>' +
      '<tr><td>Flag/flag</td><td>Falls risk</td><td>active</td></tr><tr><td>Basic/b1</td><td>Something</td><td>--</td></tr></tbody></table>');
    // the header and each section are also given on their own, as divs
    expect(out.header.startsWith('<div xmlns="http://www.w3.org/1999/xhtml"><p class="ips-patient">')).toBe(true);
    expect(out.sections[4].html).toBe('<div xmlns="http://www.w3.org/1999/xhtml"><p class="ips-as-submitted"><i>Narrative as submitted</i></p><p>No <b>devices</b></p></div>');
  });

  test('what a document puts where a number belongs is escaped', async () => {
    const d = doc();
    const ms = d.entry.find(e => e.resource.resourceType === 'MedicationStatement').resource;
    ms.dosage[0].timing.repeat = { frequency: '<img src=x onerror=alert(1)>', frequencyMax: '<b>', period: '<i>', periodMax: '"><svg onload=x>', periodUnit: 'd' };
    const out = await new Presenter().render(d);
    expect(out.html).not.toMatch(/<img|<svg/);
    expect(out.html).toContain('&lt;img src=x onerror=alert(1)&gt;-&lt;b&gt; times per &lt;i&gt;-&quot;&gt;&lt;svg onload=x&gt; d');
    expect(require('../../library/narrative-check').checkNarrative(out.html)).toBeNull();
  });

  test('copes without a lookup, without a Composition, and with odd content', async () => {
    const p = new Presenter();
    expect(await p.codeableText({ coding: [{ system: SCT, code: '123' }] })).toBe('123');
    expect(await p.codeableText({ coding: [{ system: SCT, code: '123' }, { display: 'Second' }] })).toBe('Second');
    expect(await p.codeableText({ text: '<b>' })).toBe('&lt;b&gt;');
    expect(await p.codeableText({})).toBe(NONE);
    expect(await p.codeableText('nonsense')).toBe(NONE);
    const empty = await p.render({ resourceType: 'Bundle', entry: [] });
    expect(empty.html).toBe('<div xmlns="http://www.w3.org/1999/xhtml"><p><i>The document has no Composition</i></p></div>');
    // a Composition with no sections or subject
    const bare = await p.render({ resourceType: 'Bundle', entry: [{ resource: { resourceType: 'Composition', status: 'final', subject: { display: 'Someone' } } }] });
    expect(bare.html).toBe('<div xmlns="http://www.w3.org/1999/xhtml"><h1>International Patient Summary</h1><p>Subject: Someone</p><table class="ips-facts"><tr><td><b>Status</b></td><td>final</td></tr></table></div>');
    expect(bare.header).toBe('<div xmlns="http://www.w3.org/1999/xhtml"><p>Subject: Someone</p><table class="ips-facts"><tr><td><b>Status</b></td><td>final</td></tr></table></div>');
    expect(bare.sections).toEqual([]);
  });

  test('blood pressure, statuses, reasons and evidence by reference, and several reference ranges', async () => {
    const SYS = { system: 'http://loinc.org', code: '8480-6', display: 'Systolic' };
    const DIA = { system: 'http://loinc.org', code: '8462-4', display: 'Diastolic' };
    const bundle = {
      resourceType: 'Bundle', type: 'document',
      entry: [
        { fullUrl: 'urn:uuid:comp', resource: { resourceType: 'Composition', id: 'comp', status: 'final', title: 'T', section: [
          { title: 'Vital Signs', code: { coding: [{ system: 'http://loinc.org', code: '8716-3' }] }, entry: [{ reference: 'urn:uuid:bp' }, { reference: 'urn:uuid:hr' }] },
          { title: 'Problems', code: { coding: [{ system: 'http://loinc.org', code: '11450-4' }] }, entry: [{ reference: 'urn:uuid:cond' }] },
          { title: 'Medications', code: { coding: [{ system: 'http://loinc.org', code: '10160-0' }] }, entry: [{ reference: 'urn:uuid:ms' }] }
        ] } },
        { fullUrl: 'urn:uuid:bp', resource: { resourceType: 'Observation', id: 'bp', status: 'final', code: { text: 'Blood pressure' }, effectiveDateTime: '2026-02-01T10:00:00+10:00',
          component: [{ code: { coding: [SYS] }, valueQuantity: { value: 120, unit: 'mmHg' } }, { code: { coding: [DIA] }, valueQuantity: { value: 80, unit: 'mmHg' } }, { code: { text: 'Position' }, valueCodeableConcept: { text: 'sitting' } }] } },
        { fullUrl: 'urn:uuid:hr', resource: { resourceType: 'Observation', id: 'hr', status: 'final', code: { text: 'Heart rate' }, valueQuantity: { value: 70, unit: '/min' },
          referenceRange: [{ low: { value: 60 }, high: { value: 100 }, type: { text: 'normal' } }, { text: 'athletes: 40-60' }] } },
        { fullUrl: 'urn:uuid:cond', resource: { resourceType: 'Condition', id: 'cond', code: { text: 'Hypertension' }, verificationStatus: { coding: [{ code: 'confirmed', display: 'Confirmed' }] },
          evidence: [{ detail: [{ reference: 'urn:uuid:bp' }] }, { detail: [{ reference: 'urn:uuid:bp' }] }, { code: [{ text: 'headaches' }] }] } },
        { fullUrl: 'urn:uuid:ms', resource: { resourceType: 'MedicationStatement', id: 'ms', status: 'active', medicationCodeableConcept: { text: 'Amlodipine' }, reasonReference: [{ reference: 'urn:uuid:cond' }, { reference: 'urn:uuid:hr' }] } }
      ]
    };
    const out = await new Presenter().render(bundle);
    // the blood pressure as one value, the other component beneath; the heart rate with two reference ranges beneath
    expect(out.html).toContain('<h2>Vital Signs</h2><table class="ips-section"><thead><tr><th>Observation</th><th>Value</th><th>Date</th><th>Status</th></tr></thead><tbody>' +
      '<tr><td>Blood pressure</td><td>120/80 mmHg</td><td>01-Feb 26 10:00 (+10:00)</td><td>final</td></tr>' +
      '<tr class="ips-follow"><td></td><td colspan="3"><b>Components</b><ul><li>Position: sitting</li></ul></td></tr>' +
      '<tr><td>Heart rate</td><td>70 /min</td><td>--</td><td>final</td></tr>' +
      '<tr class="ips-follow"><td></td><td colspan="3"><b>Reference ranges</b><ul><li>60 - 100 (normal)</li><li>athletes: 40-60</li></ul></td></tr></tbody></table>');
    // only a verification status: shown alone; the evidence followed to the observation, once
    expect(out.html).toContain('<tr><td>Hypertension</td><td>Confirmed</td></tr>');
    expect(out.html).toContain('<b>Evidence</b><ul><li>Blood pressure: 120/80 mmHg</li><li>headaches</li></ul>');
    // reasons by reference: the condition by its code, the observation as code: value
    expect(out.html).toContain('<tr><td>Amlodipine</td><td>active</td><td>Hypertension, Heart rate: 70 /min</td></tr>');
  });

  test('renders datatypes', () => {
    expect(dateText('2026-03-01T09:30:00Z')).toBe('01-Mar 26 09:30 (UTC)');
    expect(dateText('2026-03-01T09:30:00.123+10:00')).toBe('01-Mar 26 09:30 (+10:00)');
    expect(dateText('2026-03-01')).toBe('01-Mar 26');
    expect(dateText('2026-03')).toBe('Mar 26');
    expect(dateText('2026')).toBe('2026');
    expect(dateText('not a date <')).toBe('not a date &lt;');
    expect(periodText({ start: '2020', end: '2021' })).toBe('2020 - 2021');
    expect(periodText({ end: '2021' })).toBe('until 2021');
    expect(quantityText({ value: 5, comparator: '<', unit: 'mg' })).toBe('&lt;5 mg');
    expect(quantityText({ value: 5, code: 'mg' })).toBe('5 mg');
    expect(rangeText({ low: { value: 1 } })).toBe('&gt;= 1');
    expect(humanNameText({ family: 'Smith', given: ['Jane'], suffix: ['PhD'] })).toBe('Jane Smith PhD');
    expect(humanNameText({ text: 'Jane <Smith>' })).toBe('Jane &lt;Smith&gt;');
    expect(identifierText({ system: 'http://example.org/mrn', value: '1' })).toBe('example.org/mrn: 1');
    expect(identifierText({ value: '1' })).toBe('1');
    expect(identifierText({})).toBe('');
  });
});
