const { analyseDocument, earliest } = require('../../ips/analysis');

const NOW = Date.UTC(2026, 10, 1, 0, 0, 0);

const doc = (comp, ...rest) => ({ resourceType: 'Bundle', type: 'document', entry: [
  { fullUrl: 'urn:uuid:comp', resource: { resourceType: 'Composition', id: 'comp', status: 'final', title: 'IPS', subject: { reference: 'urn:uuid:p' },
    author: [{ reference: 'urn:uuid:dr' }], text: { status: 'generated', div: '<div>x</div>' }, ...comp } },
  { fullUrl: 'urn:uuid:p', resource: { resourceType: 'Patient', id: 'p', text: { status: 'generated', div: '<div>p</div>' } } },
  { fullUrl: 'urn:uuid:dr', resource: { resourceType: 'Practitioner', id: 'dr' } },
  ...rest] });
const entry = (resource) => ({ fullUrl: `urn:uuid:${resource.id}`, resource });
const section = (refs, more = {}) => ({ section: [{ title: 'S', entry: refs.map(r => ({ reference: `urn:uuid:${r}` })), ...more }] });
const texts = (fs) => fs.map(f => f.text || `${f.kind}:${f.url}@${f.path}:${f.found}`);
const kinds = (fs) => fs.map(f => f.kind);

describe('the analysis', () => {
  test('a document with no Composition', async () => {
    expect(await analyseDocument({ resourceType: 'Bundle', entry: [] })).toBeNull();
  });

  test('nothing to say is All OK, with the narrative noted', async () => {
    const out = await analyseDocument(doc(), { now: NOW });
    expect(out.items.e0).toEqual([{ kind: 'ok', text: 'All OK' }, { kind: 'negation', text: 'Negation: none observed' }, { kind: 'narrative', text: 'Has narrative (generated)' }]);
    expect(out.items.e1).toEqual([{ kind: 'ok', text: 'All OK' }, { kind: 'narrative', text: 'Has narrative (generated)' }]);
    expect(out.items.e2).toEqual([{ kind: 'ok', text: 'All OK' }, { kind: 'narrative', text: 'No narrative' }]);
    expect(out.counts).toEqual({ nodes: 3, ok: 3, extensions: 0, notFound: 0 });
  });

  test('extensions and modifier extensions, at any depth, looked up once each', async () => {
    const asked = [];
    const lookupExtension = async (url) => {
      asked.push(url);
      return url === 'http://x.org/known' ? { title: 'Known', description: 'A known extension' } : null;
    };
    const out = await analyseDocument(doc({}, entry({ resourceType: 'Patient', id: 'q' })), { now: NOW, lookupExtension });
    expect(out.items.e1.length).toBe(2);
    const d = doc({ subject: { reference: 'urn:uuid:p' } });
    d.entry[1].resource = {
      ...d.entry[1].resource,
      extension: [{ url: 'http://x.org/known' }, { url: 'http://x.org/complex', extension: [{ url: 'part', valueString: 'a' }] }],
      modifierExtension: [{ url: 'http://x.org/mod' }],
      _birthDate: { extension: [{ url: 'http://x.org/known' }] },
      name: [{ family: 'X', extension: [{ url: 'http://x.org/other' }] }],
      text: { status: 'generated', div: '<div>p</div>', extension: [{ url: 'http://hl7.org/fhir/StructureDefinition/textLink' }] }
    };
    const out2 = await analyseDocument(d, { now: NOW, lookupExtension });
    expect(out2.items.e1.filter(f => f.url).map(f => [f.kind, f.url, f.path, f.found])).toEqual([
      ['extension', 'http://x.org/known', 'Patient', true],
      ['extension', 'http://x.org/complex', 'Patient', false],
      ['modifier', 'http://x.org/mod', 'Patient', false],
      ['extension', 'http://x.org/known', 'Patient.birthDate', true],
      ['extension', 'http://x.org/other', 'Patient.name[0]', false]
    ]);
    expect(out2.items.e1[0]).toMatchObject({ title: 'Known', description: 'A known extension' });
    expect(asked.filter(u => u === 'http://x.org/known').length).toBe(1);
    expect(out2.counts).toMatchObject({ extensions: 5, notFound: 3 });
  });

  test('implicitRules, inactive, entered in error, unknown and missing status', async () => {
    const out = await analyseDocument(doc(section(['a', 'b', 'c', 'd', 'e']),
      entry({ resourceType: 'Observation', id: 'a', implicitRules: 'http://x.org/rules', status: 'final', subject: { reference: 'urn:uuid:p' } }),
      entry({ resourceType: 'Condition', id: 'b', verificationStatus: { coding: [{ code: 'entered-in-error' }] }, subject: { reference: 'urn:uuid:p' } }),
      entry({ resourceType: 'Immunization', id: 'c', status: 'entered-in-error', patient: { reference: 'urn:uuid:p' } }),
      entry({ resourceType: 'Procedure', id: 'd', status: 'unknown', subject: { reference: 'urn:uuid:p' } }),
      entry({ resourceType: 'MedicationStatement', id: 'e', subject: { reference: 'urn:uuid:p' } })), { now: NOW });
    expect(texts(out.items.e3)).toEqual(['implicitRules: http://x.org/rules', 'No narrative']);
    expect(kinds(out.items.e3)).toEqual(['modifier', 'narrative']);
    expect(texts(out.items.e4)).toEqual(['Entered in error (verificationStatus = entered-in-error)', 'No narrative']);
    expect(texts(out.items.e5)).toEqual(['Entered in error (status = entered-in-error)', 'No narrative']);
    expect(texts(out.items.e6)).toEqual(['Status unknown (status = unknown)', 'No narrative']);
    expect(texts(out.items.e7)).toEqual(['No status (a MedicationStatement should have one)', 'No narrative']);
    expect(kinds(out.items.e7)).toEqual(['status', 'narrative']);
    const inactive = await analyseDocument(doc({}), { now: NOW });
    expect(inactive.items.e1[0].kind).toBe('ok');
    const d = doc();
    d.entry[2].resource.active = false;
    expect(texts((await analyseDocument(d, { now: NOW })).items.e2)).toEqual(['Not active (active = false)', 'No narrative']);
  });

  test('a subject other than the document\'s, and a focus', async () => {
    const out = await analyseDocument(doc(section(['a', 'b', 'c', 'd']),
      // the same patient, by another form of reference: same
      entry({ resourceType: 'Condition', id: 'a', subject: { reference: 'Patient/p' } }),
      entry({ resourceType: 'Condition', id: 'b', subject: { reference: 'urn:uuid:other' } }),
      entry({ resourceType: 'AllergyIntolerance', id: 'c', patient: { reference: 'urn:uuid:p' } }),
      entry({ resourceType: 'Observation', id: 'd', status: 'final', subject: { reference: 'urn:uuid:p' }, focus: [{ reference: 'urn:uuid:other', display: 'Mum' }] })), { now: NOW });
    expect(kinds(out.items.e3)).toEqual(['ok', 'narrative']);
    expect(texts(out.items.e4)).toEqual(['The subject (urn:uuid:other) is not the document\'s subject (urn:uuid:p)', 'No narrative']);
    expect(kinds(out.items.e4)).toEqual(['subject', 'narrative']);
    expect(kinds(out.items.e5)).toEqual(['ok', 'narrative']);
    expect(texts(out.items.e6)).toEqual(['Has a focus: urn:uuid:other "Mum"', 'No narrative']);
  });

  test('dates in the future, except in an Appointment', async () => {
    const out = await analyseDocument(doc(section(['a', 'b', 'c']),
      entry({ resourceType: 'Condition', id: 'a', subject: { reference: 'urn:uuid:p' }, onsetDateTime: '2027-01', recordedDate: '2026-10-31', note: [{ text: '2030-01-01' }] }),
      entry({ resourceType: 'Appointment', id: 'b', start: '2027-02-01T10:00:00Z' }),
      entry({ resourceType: 'Immunization', id: 'c', status: 'completed', patient: { reference: 'urn:uuid:p' }, occurrenceDateTime: '2026-11-01T09:00:00+10:00', protocolApplied: [{ doseNumberString: '2028' }] })), { now: NOW });
    // a note's text is not a date, whatever it looks like
    expect(texts(out.items.e3)).toEqual(['A date in the future: Condition.onsetDateTime = 2027-01', 'No narrative']);
    expect(kinds(out.items.e3)[0]).toBe('attention');
    expect(kinds(out.items.e4)).toEqual(['ok', 'narrative']);
    // 9am in Brisbane is 23:00 UTC the day before: not the future; a dose number of 2028 is not a date
    expect(kinds(out.items.e5)).toEqual(['ok', 'narrative']);
  });

  test('dates about the future by their nature: period ends, expiry and due dates, schedules; and only real dates', async () => {
    const d = doc(section(['a', 'b', 'c']),
      entry({ resourceType: 'Immunization', id: 'a', status: 'completed', patient: { reference: 'urn:uuid:p' }, occurrenceDateTime: '2026-10-01',
        expirationDate: '2027-06-30', identifier: [{ value: '2030-05', period: { start: '2026-01-01', end: '2031-01-01' } }],
        extension: [{ url: 'http://x.org/next', valueDateTime: '2027-01-01' }] }),
      entry({ resourceType: 'MedicationStatement', id: 'b', status: 'active', subject: { reference: 'urn:uuid:p' },
        effectivePeriod: { start: '2026-01-01', end: '2027-12-31' }, dosage: [{ timing: { event: ['2027-01-01'], repeat: { boundsPeriod: { start: '2027-01-01' } } } }] }),
      entry({ resourceType: 'Goal', id: 'c', lifecycleStatus: 'completed', subject: { reference: 'urn:uuid:p' }, startDate: '2027-02-01', target: [{ dueDate: '2027-03-01' }] }));
    d.entry[1].resource.name = [{ family: 'X', period: { end: '2030-01-01' } }];
    const out = await analyseDocument(d, { now: NOW });
    expect(kinds(out.items.e1)[0]).toBe('ok');
    expect(kinds(out.items.e3)).toEqual(['extension', 'narrative']);
    expect(kinds(out.items.e4)).toEqual(['ok', 'narrative']);
    // a completed goal that starts in the future; its due date is a due date
    expect(texts(out.items.e5)).toEqual(['A date in the future: Goal.startDate = 2027-02-01', 'No narrative']);
  });

  test('requests, plans and events still to come may be in the future; once over, they may not', async () => {
    const out = await analyseDocument(doc(section(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']),
      entry({ resourceType: 'ServiceRequest', id: 'a', status: 'active', subject: { reference: 'urn:uuid:p' }, occurrenceDateTime: '2027-01-01' }),
      entry({ resourceType: 'ServiceRequest', id: 'b', status: 'completed', subject: { reference: 'urn:uuid:p' }, occurrenceDateTime: '2027-01-01' }),
      entry({ resourceType: 'Procedure', id: 'c', status: 'preparation', subject: { reference: 'urn:uuid:p' }, performedDateTime: '2027-01-01' }),
      entry({ resourceType: 'Procedure', id: 'd', status: 'completed', subject: { reference: 'urn:uuid:p' }, performedDateTime: '2027-01-01' }),
      entry({ resourceType: 'CarePlan', id: 'e', status: 'active', subject: { reference: 'urn:uuid:p' }, period: { start: '2027-01-01' } }),
      entry({ resourceType: 'Goal', id: 'f', lifecycleStatus: 'active', subject: { reference: 'urn:uuid:p' }, startDate: '2027-01-01' }),
      entry({ resourceType: 'ImmunizationRecommendation', id: 'g', patient: { reference: 'urn:uuid:p' }, date: '2027-01-01' }),
      entry({ resourceType: 'Encounter', id: 'h', status: 'planned', subject: { reference: 'urn:uuid:p' }, period: { start: '2027-01-01' } }),
      entry({ resourceType: 'MedicationStatement', id: 'i', status: 'intended', subject: { reference: 'urn:uuid:p' }, effectiveDateTime: '2027-01-01' })), { now: NOW });
    const future = (k) => out.items[k].filter(f => f.kind === 'attention').map(f => f.text);
    expect(future('e3')).toEqual([]);
    expect(future('e4')).toEqual(['A date in the future: ServiceRequest.occurrenceDateTime = 2027-01-01']);
    expect(future('e5')).toEqual([]);
    expect(future('e6')).toEqual(['A date in the future: Procedure.performedDateTime = 2027-01-01']);
    for (const k of ['e7', 'e8', 'e9', 'e10', 'e11']) {
      expect(future(k)).toEqual([]);
    }
  });

  test('a date with no time zone is in the future only if it is everywhere', () => {
    expect(earliest('2026-11-01')).toBe(Date.UTC(2026, 10, 1) - 14 * 3600000);
    expect(earliest('2026-11-01T10:00:00Z')).toBe(Date.UTC(2026, 10, 1, 10));
    expect(earliest('not a date')).toBeNull();
  });

  test('a Patient\'s links, and a Composition that is not final', async () => {
    const d = doc({ status: 'preliminary' }, entry({ resourceType: 'Patient', id: 'q' }));
    d.entry[1].resource.link = [{ other: { reference: 'urn:uuid:q' }, type: 'replaced-by' }, { other: { reference: 'Patient/zz' }, type: 'seealso' }];
    const out = await analyseDocument(d, { now: NOW });
    expect(texts(out.items.e0)).toEqual(['The Composition\'s status is preliminary, not final', 'Negation: none observed', 'Has narrative (generated)']);
    expect(kinds(out.items.e0)[0]).toBe('attention');
    expect(texts(out.items.e1)).toEqual(['Linked (replaced-by) to urn:uuid:q', 'Linked (seealso) to Patient/zz - not in the document', 'Has narrative (generated)']);
  });

  test('sections: emptyReason, an author other than the container\'s, and the same checks otherwise', async () => {
    const d = doc({ section: [
      { title: 'A', emptyReason: { coding: [{ code: 'nilknown', display: 'Nil Known' }] }, extension: [{ url: 'http://x.org/s' }] },
      { title: 'B', author: [{ reference: 'urn:uuid:dr' }], text: { status: 'additional', div: '<div>b</div>' },
        section: [{ title: 'B1', author: [{ reference: 'urn:uuid:other' }], focus: { reference: 'urn:uuid:p' } }] },
      { title: 'C', author: [{ reference: 'urn:uuid:other' }] }
    ] });
    const out = await analyseDocument(d, { now: NOW });
    const s = (p) => out.items[`s:Composition.${p}`];
    expect(texts(s('section[0]'))).toEqual(['Empty: Nil Known', 'extension:http://x.org/s@section:false', 'No narrative']);
    expect(kinds(s('section[1]'))).toEqual(['ok', 'narrative']);
    expect(texts(s('section[1]'))[1]).toBe('Has narrative (additional)');
    expect(texts(s('section[1].section[0]'))).toEqual(['The author (urn:uuid:other) is not the containing section\'s (urn:uuid:dr)', 'Has a focus: urn:uuid:p', 'No narrative']);
    expect(texts(s('section[2]'))).toEqual(['The author (urn:uuid:other) is not the Composition\'s (urn:uuid:dr)', 'No narrative']);
    // the Composition's own analysis leaves its sections out (but notes the emptyReason as how it does negation)
    expect(texts(out.items.e0)).toEqual(['All OK', 'Negation: section emptyReason (A: Nil Known)', 'Has narrative (generated)']);
  });

  test('each resource is analysed once, where it is first met; contained resources too', async () => {
    const out = await analyseDocument(doc(section(['m', 'p']),
      entry({ resourceType: 'MedicationStatement', id: 'm', status: 'active', subject: { reference: 'urn:uuid:p' }, medicationReference: { reference: '#med' },
        contained: [{ resourceType: 'Medication', id: 'med', implicitRules: 'http://x.org/r' }] })), { now: NOW });
    expect(Object.keys(out.items).sort()).toEqual(['e0', 'e1', 'e2', 'e3', 'e3#med', 's:Composition.section[0]']);
    expect(texts(out.items['e3#med'])).toEqual(['implicitRules: http://x.org/r', 'No narrative']);
  });

  describe('SNOMED CT codes with no edition, when the nationality is unknown', () => {
    const SCT = 'http://snomed.info/sct';
    const condition = (id, coding) => entry({ resourceType: 'Condition', id, subject: { reference: 'urn:uuid:p' }, code: { coding: [coding] },
      text: { status: 'generated', div: '<div>c</div>' } });
    const d = () => doc(section(['c1', 'c2', 'c3']),
      condition('c1', { system: SCT, code: '38341003', display: 'Hypertension' }),
      condition('c2', { system: SCT, version: 'http://snomed.info/sct/32506021000036107', code: '44054006' }),
      condition('c3', { system: SCT, version: '20250131', code: '73211009', display: 'Diabetes mellitus' }));

    test('an error on the Composition, with the International Edition assumed', async () => {
      const out = await analyseDocument(d(), { now: NOW, jurisdiction: null });
      expect(kinds(out.items.e0)).toEqual(['error', 'negation', 'narrative']);
      // a version that isn't an edition (a date) doesn't say which edition
      expect(texts(out.items.e0)[0]).toBe('2 SNOMED CT codes do not say which edition they are from (38341003 Hypertension, 73211009 Diabetes mellitus), ' +
        'and the nationality of the document is unknown, so the edition cannot be worked out. The International Edition of SNOMED CT is assumed');
      expect(out.counts.ok).toBe(Object.values(out.items).filter(fs => fs[0].kind === 'ok').length);
    });

    test('not when the nationality is known, or not given, or every code names its edition', async () => {
      expect(kinds((await analyseDocument(d(), { now: NOW, jurisdiction: 'AU' })).items.e0)).toEqual(['ok', 'negation', 'narrative']);
      expect(kinds((await analyseDocument(d(), { now: NOW })).items.e0)).toEqual(['ok', 'negation', 'narrative']);
      const versioned = doc(section(['c1']), condition('c1', { system: SCT, version: 'http://snomed.info/sct/900000000000207008/version/20250201', code: '38341003' }));
      expect(kinds((await analyseDocument(versioned, { now: NOW, jurisdiction: null })).items.e0)).toEqual(['ok', 'negation', 'narrative']);
    });

    test('named up to three, then counted', async () => {
      const codes = ['1', '2', '3', '4', '5'].map(n => condition(`c${n}`, { system: SCT, code: `10000${n}` }));
      const out = await analyseDocument(doc(section(codes.map(c => c.resource.id)), ...codes), { now: NOW, jurisdiction: null });
      expect(texts(out.items.e0)[0]).toMatch(/^5 SNOMED CT codes do not say which edition they are from \(100001, 100002, 100003, and 2 more\)/);
    });
  });

  describe('negation: how the document says there is nothing to report', () => {
    const SCT = 'http://snomed.info/sct';
    const IPS = 'http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips';
    const nilKnown = { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/list-empty-reason', code: 'nilknown', display: 'Nil Known' }] };
    const allergy = (id, system, code, display) => entry({ resourceType: 'AllergyIntolerance', id, patient: { reference: 'urn:uuid:p' },
      code: { coding: [{ system, code, display }] }, text: { status: 'generated', div: '<div>a</div>' } });

    test('more than one approach: an emptyReason in one section, and a negation code in another', async () => {
      const out = await analyseDocument(doc({ section: [
        { title: 'Allergies', entry: [{ reference: 'urn:uuid:a' }] },
        { title: 'Problems', emptyReason: nilKnown }
      ] }, allergy('a', SCT, '716186003', 'No known allergy')), { now: NOW });
      expect(kinds(out.items.e0)).toEqual(['attention', 'narrative']);
      expect(texts(out.items.e0)[0]).toBe('Negation: more than one approach - section emptyReason (Problems: Nil Known), and codes in entries (Allergies: No known allergy). A document should use one approach throughout');
      // the Composition isn't All OK any more
      expect(out.counts.ok).toBe(Object.values(out.items).filter(fs => fs[0].kind === 'ok').length);
    });

    test('the IPS absent-unknown codes - negations, and no information - and a medication by reference', async () => {
      const out = await analyseDocument(doc({ section: [
        { title: 'Allergies', entry: [{ reference: 'urn:uuid:a' }] },
        { title: 'Medications', entry: [{ reference: 'urn:uuid:m' }] },
        { title: 'Problems', emptyReason: { coding: [{ code: 'notasked', display: 'Not Asked' }] } },
        { title: 'Procedures', emptyReason: { coding: [{ code: 'withheld', display: 'Information Withheld' }] } }
      ] }, allergy('a', IPS, 'no-known-allergies', 'No known allergies'),
      entry({ resourceType: 'MedicationStatement', id: 'm', status: 'active', subject: { reference: 'urn:uuid:p' }, medicationReference: { reference: 'urn:uuid:med' } }),
      entry({ resourceType: 'Medication', id: 'med', code: { coding: [{ system: IPS, code: 'no-medication-info' }] } })), { now: NOW });
      expect(texts(out.items.e0)[0]).toBe('Negation: more than one approach - section emptyReason (Problems: Not Asked), and codes in entries (Allergies: No known allergies; Medications: no-medication-info). A document should use one approach throughout');
    });

    test('one approach is noted, and is All OK; so is none', async () => {
      const codes = await analyseDocument(doc({ section: [
        { title: 'Allergies', entry: [{ reference: 'urn:uuid:a' }] },
        { title: 'Problems', emptyReason: { coding: [{ code: 'withheld' }] } }
      ] }, allergy('a', SCT, '409137002', 'No known drug allergy')), { now: NOW });
      expect(codes.items.e0).toEqual([{ kind: 'ok', text: 'All OK' }, { kind: 'negation', text: 'Negation: codes in entries (Allergies: No known drug allergy)' }, { kind: 'narrative', text: 'Has narrative (generated)' }]);
      const reasons = await analyseDocument(doc({ section: [
        { title: 'Allergies', entry: [{ reference: 'urn:uuid:a' }] },
        { title: 'Problems', emptyReason: nilKnown }
      ] }, allergy('a', SCT, '91936005', 'Allergy to penicillin')), { now: NOW });
      expect(texts(reasons.items.e0)).toEqual(['All OK', 'Negation: section emptyReason (Problems: Nil Known)', 'Has narrative (generated)']);
      const none = await analyseDocument(doc(section(['a']), allergy('a', SCT, '91936005', 'Allergy to penicillin')), { now: NOW });
      expect(texts(none.items.e0)).toEqual(['All OK', 'Negation: none observed', 'Has narrative (generated)']);
    });
  });
});
