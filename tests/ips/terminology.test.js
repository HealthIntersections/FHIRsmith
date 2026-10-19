const {
  terminologyOf, conceptsOf, systemName, describeVersion, linkForSystem, linkForCode, isExternalSystem, isIgnored, sectionRank, SECTION_ORDER
} = require('../../ips/terminology');
const { renderTerminology } = require('../../ips/render');
const { issueCounts, issueSummary } = require('../../ips/pipeline');
const { IpsBindings } = require('../../ips/ips-bindings');

const sct = (code, display) => ({ system: 'http://snomed.info/sct', code, display });
const loinc = (code) => ({ coding: [{ system: 'http://loinc.org', code }] });

function doc() {
  const entry = (fullUrl, resource) => ({ fullUrl, resource });
  return {
    resourceType: 'Bundle',
    type: 'document',
    entry: [
      entry('urn:uuid:comp', {
        resourceType: 'Composition',
        id: 'comp',
        status: 'final',
        type: { coding: [{ system: 'http://loinc.org', code: '60591-5', display: 'Patient summary Document' }] },
        category: [{ text: 'summary' }],
        subject: { reference: 'urn:uuid:pat' },
        date: '2026-03-01',
        title: 'IPS',
        section: [
          // out of IPS order on purpose
          { title: 'Vital Signs', code: loinc('8716-3'), entry: [{ reference: 'urn:uuid:bp' }] },
          { title: 'Something Else', code: loinc('99999-9'), entry: [{ reference: 'urn:uuid:missing' }] },
          { title: 'Medication Summary', code: loinc('10160-0'), entry: [{ reference: 'MedicationStatement/med' }] },
          { title: 'Allergies and Intolerances', code: loinc('48765-2'), entry: [{ reference: 'urn:uuid:allergy' }] },
          { title: 'Problem List', entry: [{ reference: 'urn:uuid:cond' }] },
          { title: 'Another Odd One', entry: [] }
        ]
      }),
      entry('urn:uuid:pat', { resourceType: 'Patient', id: 'pat', name: [{ family: 'Smith' }] }),
      entry('urn:uuid:allergy', {
        resourceType: 'AllergyIntolerance', id: 'allergy',
        clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }] },
        verificationStatus: { coding: [{ code: 'confirmed' }] },
        code: { coding: [sct('91936005', 'Allergy to penicillin')], text: 'Penicillin' },
        reaction: [{ manifestation: [{ coding: [sct('247472004', 'Hives')] }], severity: 'moderate' }]
      }),
      entry('urn:uuid:cond', {
        resourceType: 'Condition', id: 'cond',
        clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] },
        code: { coding: [sct('38341003', 'Hypertension')] }
      }),
      entry('urn:uuid:med', {
        resourceType: 'MedicationStatement', id: 'med', status: 'active',
        medicationCodeableConcept: { coding: [{ system: 'http://www.whocc.no/atc', code: 'C09AA02', display: 'enalapril' }] },
        dosage: [{ route: { coding: [sct('26643006', 'Oral')] }, doseAndRate: [{ type: { text: 'ordered' } }] }],
        extension: [{ url: 'http://example.org/x', valueCodeableConcept: { text: 'in an extension' } }]
      }),
      entry('urn:uuid:bp', {
        resourceType: 'Observation', id: 'bp', status: 'final',
        category: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] }],
        code: { coding: [{ system: 'http://loinc.org', code: '85354-9' }] },
        component: [
          { code: loinc('8480-6'), valueQuantity: { value: 120, unit: 'mmHg' } },
          { code: loinc('8462-4'), valueCodeableConcept: { text: 'low' } }
        ],
        interpretation: [{ coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation', code: 'N' }] }]
      })
    ]
  };
}

describe('conceptsOf', () => {
  test('finds CodeableConcepts by the type model, including choice types, datatypes and extensions', () => {
    const med = doc().entry.find(e => e.resource.id === 'med').resource;
    expect(conceptsOf(med).map(c => c.path)).toEqual([
      'MedicationStatement.medicationCodeableConcept',
      'MedicationStatement.dosage[0].route',
      'MedicationStatement.dosage[0].doseAndRate[0].type',
      'MedicationStatement.extension[0].valueCodeableConcept'
    ]);
    const bp = doc().entry.find(e => e.resource.id === 'bp').resource;
    expect(conceptsOf(bp).map(c => c.path)).toEqual([
      'Observation.code', 'Observation.component[0].code', 'Observation.component[1].code',
      'Observation.component[1].valueCodeableConcept', 'Observation.interpretation[0]'
    ]);
  });

  test('leaves out the ignored elements, and only those', () => {
    const allergy = doc().entry.find(e => e.resource.id === 'allergy').resource;
    expect(conceptsOf(allergy).map(c => c.element)).toEqual(['AllergyIntolerance.code', 'AllergyIntolerance.reaction.manifestation']);
    const cond = doc().entry.find(e => e.resource.id === 'cond').resource;
    expect(conceptsOf(cond).map(c => c.element)).toEqual(['Condition.code']);
    expect(isIgnored('Observation.category')).toBe(true);
    expect(isIgnored('MedicationRequest.dosageInstruction.category')).toBe(true);
    expect(isIgnored('Condition.verificationStatus')).toBe(true);
    expect(isIgnored('Procedure.category.coding')).toBe(false);
    expect(isIgnored('Observation.code')).toBe(false);
    expect(isIgnored('Composition.type')).toBe(true);
    expect(isIgnored('Composition.event.code')).toBe(true);
  });

  test('does not mistake other things for CodeableConcepts', () => {
    const r = {
      resourceType: 'Observation', status: 'final', code: { text: 'x' },
      text: { status: 'generated', div: '<div/>' }, note: [{ text: 'a note' }], valueQuantity: { value: 1, code: 'mg' },
      subject: { reference: 'Patient/1', display: 'x' }
    };
    expect(conceptsOf(r).map(c => c.path)).toEqual(['Observation.code']);
  });

  test('falls back to shape for resources the model does not know', () => {
    const r = { resourceType: 'Mystery', thing: { coding: [{ code: 'a' }] }, other: { text: 'not one' }, deep: { inner: { coding: [], text: 'y' } } };
    expect(conceptsOf(r).map(c => c.path)).toEqual(['Mystery.thing', 'Mystery.deep.inner']);
  });
});

describe('sectionRank and systemName', () => {
  test('ranks by LOINC code, then by title', () => {
    expect(sectionRank({ code: loinc('11450-4'), title: 'Whatever' })).toBe(1);
    expect(sectionRank({ title: 'Allergies' })).toBe(2);
    expect(sectionRank({ title: 'History of Procedures' })).toBe(5);
    expect(sectionRank({ title: 'Lab Results' })).toBe(-1);
    expect(sectionRank({ title: 'Results' })).toBe(15);
    expect(SECTION_ORDER.map(s => s[1])[0]).toBe('Patient Story');
  });

  test('names code systems', () => {
    expect(systemName('http://snomed.info/sct')).toBe('SNOMED CT');
    expect(systemName('http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation')).toBe('v3-ObservationInterpretation');
    expect(systemName('http://hl7.org/fhir/sid/icd-10')).toBe('ICD-10');
    expect(systemName('http://hl7.org/fhir/administrative-gender')).toBe('administrative-gender');
    expect(systemName('http://example.org/cs')).toBe('http://example.org/cs');
    expect(systemName(undefined)).toBe('');
    expect(isExternalSystem('http://snomed.info/sct')).toBe(true);
    expect(isExternalSystem('http://terminology.hl7.org/CodeSystem/condition-clinical')).toBe(false);
    expect(isExternalSystem(undefined)).toBe(false);
    expect(systemName('http://snomed.info/sct/731000124108')).toBe('SNOMED CT');
    expect(systemName('http://ncicb.nci.nih.gov/xml/owl/EVS/Thesaurus.owl')).toBe('NCI Thesaurus');
  });

  test('describes versions as the Java DataRenderer does, naming the SNOMED CT edition', () => {
    expect(describeVersion('http://snomed.info/sct/731000124108/version/20240301')).toEqual({ text: 'US rel. Mar 2024', title: 'US Edition' });
    expect(describeVersion('http://snomed.info/sct/900000000000207008/version/20250731')).toEqual({ text: 'Intl rel. Jul 2025', title: 'International Edition' });
    expect(describeVersion('http://snomed.info/sct/32506021000036107')).toEqual({ text: 'AU+', title: 'Australian Edition (with drug extension)' });
    expect(describeVersion('http://snomed.info/sct/123456/version/20240301')).toEqual({ text: '?? rel. Mar 2024', title: 'Unknown edition 123456' });
    expect(describeVersion('2.74')).toEqual({ text: '2.74', title: null });
    expect(describeVersion('')).toEqual({ text: '', title: null });
  });

  test('links external codes to their browsers', () => {
    expect(linkForSystem('http://snomed.info/sct')).toBe('https://browser.ihtsdotools.org/');
    expect(linkForSystem('http://loinc.org')).toBe('https://loinc.org/');
    expect(linkForSystem('http://terminology.hl7.org/CodeSystem/v3-ActCode')).toBeNull();
    expect(linkForCode('http://snomed.info/sct', 'http://snomed.info/sct/731000124108/version/20240301', '38341003')).toBe('http://snomed.info/sct/731000124108/id/38341003');
    expect(linkForCode('http://snomed.info/sct', undefined, '38341003')).toBe('http://snomed.info/id/38341003');
    expect(linkForCode('http://snomed.info/sct', 'http://snomed.info/sct/999/version/20240301', '38341003')).toBe('http://snomed.info/id/38341003');
    expect(linkForCode('http://snomed.info/sct', undefined, '38341003:363698007=39057004')).toBe('https://browser.ihtsdotools.org/');
    expect(linkForCode('http://loinc.org', undefined, '8480-6')).toBe('https://loinc.org/8480-6');
    expect(linkForCode('http://www.nlm.nih.gov/research/umls/rxnorm', undefined, '197361')).toBe('https://mor.nlm.nih.gov/RxNav/search?searchBy=RXCUI&searchTerm=197361');
    expect(linkForCode('urn:iso:std:iso:3166', undefined, 'AU')).toBe('https://en.wikipedia.org/wiki/ISO_3166-2:AU');
    expect(linkForCode('http://terminology.hl7.org/CodeSystem/v3-ActCode', undefined, 'PCPR')).toBeNull();
  });
});

describe('terminologyOf', () => {
  test('puts the Composition first, then the sections in IPS order, then the rest in document order', () => {
    const t = terminologyOf(doc());
    expect(t.composition.map(c => c.path)).toEqual([]);
    expect(t.sections.map(s => s.title)).toEqual([
      'Problems', 'Allergies and Intolerances', 'Medication Summary', 'Vital Signs', 'Something Else', 'Another Odd One'
    ]);
    expect(t.sections.map(s => s.known)).toEqual([true, true, true, true, false, false]);
    const meds = t.sections[2];
    expect(meds.entries).toHaveLength(1);
    expect(meds.entries[0]).toMatchObject({ reference: 'MedicationStatement/med', label: 'MedicationStatement/med', resolved: true });
    expect(meds.entries[0].concepts).toHaveLength(4);
    expect(t.sections[4].entries[0]).toMatchObject({ reference: 'urn:uuid:missing', resolved: false, concepts: [] });
    expect(t.sections[5].entries).toEqual([]);
  });

  test('copes with a document that has no Composition', () => {
    expect(terminologyOf({ resourceType: 'Bundle', entry: [] })).toEqual({ composition: [], sections: [] });
  });
});

describe('renderTerminology', () => {
  test('renders the table with a copy button per concept', () => {
    const h = renderTerminology(doc());
    expect(h).toContain('<th colspan="4" class="ips-section">Composition</th>');
    expect(h).not.toContain('<code>Composition.type</code>');
    expect(h.indexOf('>Problems<')).toBeLessThan(h.indexOf('>Allergies and Intolerances<'));
    expect(h.indexOf('>Vital Signs<')).toBeLessThan(h.indexOf('>Something Else'));
    expect(h).toContain('Something Else <small>(not an IPS section)</small>');
    expect(h).toContain('<code>AllergyIntolerance.code</code>');
    expect(h).not.toContain('<code>AllergyIntolerance.clinicalStatus</code>');
    expect(h).toContain('<li>Text: Penicillin</li>');
    expect(h).toContain('<a href="https://browser.ihtsdotools.org/" title="http://snomed.info/sct">SNOMED CT</a> <code><a href="http://snomed.info/id/91936005">91936005</a></code> "Allergy to penicillin"');
    expect(h).toContain('<a href="https://loinc.org/" title="http://loinc.org">LOINC</a> <code><a href="https://loinc.org/8480-6">8480-6</a></code>');
    expect(h).toContain('>ATC</span> <code><span>C09AA02</span></code>');
    expect(h).toContain('urn:uuid:missing - <b>not found in the document</b>');
    expect(h).toContain('data-json="{&quot;coding&quot;:[{&quot;system&quot;:&quot;http://snomed.info/sct&quot;,&quot;code&quot;:&quot;91936005&quot;');
    expect((h.match(/class="btn btn-default ips-copy"/g) || []).length).toBe(0 + 1 + 2 + 4 + 5);
    // no terminology server: nothing links to one
    expect(h).not.toContain('CodeSystem?url=');
    expect(h).toContain('<span title="http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation">v3-ObservationInterpretation</span>');
  });

  test('names the SNOMED CT edition and release from the version', () => {
    const d = doc();
    d.entry[3].resource.code.coding[0].version = 'http://snomed.info/sct/32506021000036107/version/20250131';
    const h = renderTerminology(d);
    expect(h).toContain('SNOMED CT</a> <small>[<span title="Australian Edition (with drug extension) (http://snomed.info/sct/32506021000036107/version/20250131)">AU+ rel. Jan 2025</span>]</small> ' +
      '<code><a href="http://snomed.info/sct/32506021000036107/id/38341003">38341003</a></code>');
  });

  test('links code systems to the terminology server, except the external ones', () => {
    const h = renderTerminology(doc(), { codeSystemLink: (s) => `/tx/r4/CodeSystem?url=${encodeURIComponent(s)}` });
    expect(h).toContain('<a href="/tx/r4/CodeSystem?url=http%3A%2F%2Fterminology.hl7.org%2FCodeSystem%2Fv3-ObservationInterpretation" title="http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation">v3-ObservationInterpretation</a>');
    expect(h).toContain('<a href="https://browser.ihtsdotools.org/" title="http://snomed.info/sct">SNOMED CT</a>');
    expect(h).not.toContain('CodeSystem?url=http%3A%2F%2Fsnomed');
    expect(h).not.toContain('CodeSystem?url=http%3A%2F%2Floinc');
  });

  test('can show only the concepts with a problem', () => {
    const { addCheck } = require('../../ips/pipeline');
    const d = doc();
    addCheck(d.entry[3].resource.code, { result: 'not-in', message: 'no' }, [{ valueSet: 'http://x' }]);
    addCheck(d.entry[2].resource.code, { result: 'in', valueSet: 'http://x', coding: d.entry[2].resource.code.coding[0], message: 'yes' }, [{ valueSet: 'http://x' }]);
    const all = renderTerminology(d, { analysed: true });
    expect(all).toContain('ips-check-not-in" title=');
    // the same document, not analysed: the verdicts are not believed
    expect(renderTerminology(d, { analysed: false })).not.toContain('ips-check-not-in" title=');
    expect(all).toContain('<code>AllergyIntolerance.code</code>');
    expect(all).toContain('<code>Condition.code</code>');
    expect(all).not.toContain('Showing');
    const h = renderTerminology(d, { analysed: true, problemsOnly: true });
    expect(h).toContain('Showing 1 of 12 concepts');
    expect(h).toContain('<code>Condition.code</code>');
    expect(h).not.toContain('<code>AllergyIntolerance.code</code>');
    expect(h).not.toContain('<code>MedicationStatement.medicationCodeableConcept</code>');
    expect(h).not.toContain('>Vital Signs</th>');
    expect(h).not.toContain('not an IPS section');
    expect(h).toContain('>Problems</th>');
    // nothing wrong at all
    const clean = renderTerminology(doc(), { analysed: true, problemsOnly: true });
    expect(clean).toContain('No problems');
    // not analysed yet: no checkbox
    expect(renderTerminology(doc(), {})).not.toContain('name="problems"');
  });

  test('escapes content from the document', () => {
    const d = doc();
    d.entry[3].resource.code = { text: '<script>alert(1)</script>', coding: [{ system: 'x', code: '"><b>', display: '</td>' }] };
    const h = renderTerminology(d);
    expect(h).not.toContain('<script>alert');
    expect(h).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(h).toContain('<code><span>&quot;&gt;&lt;b&gt;</span></code>');
  });
});

describe('issue summaries', () => {
  test('counts and words issues', () => {
    const oo = { resourceType: 'OperationOutcome', issue: [{ severity: 'error' }, { severity: 'error' }, { severity: 'warning' }, { severity: 'fatal' }, { severity: 'odd' }, null] };
    const c = issueCounts(oo);
    expect(c).toEqual({ fatal: 1, error: 2, warning: 1, information: 0 });
    expect(issueSummary(c)).toBe('1 fatal error, 2 errors, 1 warning');
    expect(issueSummary(issueCounts({}))).toBe('no issues');
    expect(issueSummary({ information: 3 })).toBe('3 notes');
  });
});

describe('IpsBindings', () => {
  const IPS = 'http://hl7.org/fhir/uv/ips/';
  const sd = (url, type, elements, base = 'http://hl7.org/fhir/StructureDefinition/' + type) => ({
    resourceType: 'StructureDefinition', url, kind: 'resource', derivation: 'constraint', type, baseDefinition: base, snapshot: { element: elements }
  });
  const bound = (path, valueSet, strength) => ({ path, type: [{ code: 'CodeableConcept' }], binding: { strength, valueSet } });

  function make() {
    const b = new IpsBindings('hl7.fhir.uv.ips#1.1.0', { packageManager: {} });
    b.valueSets.set(IPS + 'ValueSet/problems-uv-ips', { resourceType: 'ValueSet', url: IPS + 'ValueSet/problems-uv-ips', compose: { include: [{ valueSet: [IPS + 'ValueSet/inner|1.1.0'] }] } });
    b.valueSets.set(IPS + 'ValueSet/inner', { resourceType: 'ValueSet', url: IPS + 'ValueSet/inner', compose: { include: [{ valueSet: [IPS + 'ValueSet/problems-uv-ips'] }, { system: IPS + 'CodeSystem/absent-unknown-uv-ips' }, { system: 'http://snomed.info/sct' }] } });
    b.codeSystems.set(IPS + 'CodeSystem/absent-unknown-uv-ips', { resourceType: 'CodeSystem', url: IPS + 'CodeSystem/absent-unknown-uv-ips' });
    b.valueSets.set(IPS + 'ValueSet/labs', { resourceType: 'ValueSet', url: IPS + 'ValueSet/labs' });
    b.valueSets.set(IPS + 'ValueSet/meds', { resourceType: 'ValueSet', url: IPS + 'ValueSet/meds' });
    for (const u of b.valueSets.keys()) {
      b.ipsValueSets.add(u);
    }
    b.addProfile(sd(IPS + 'StructureDefinition/Condition-uv-ips', 'Condition', [
      { path: 'Condition' },
      bound('Condition.code', IPS + 'ValueSet/problems-uv-ips|1.1.0', 'preferred'),
      // the base specification's binding: kept at preferred, dropped at example
      bound('Condition.severity', 'http://hl7.org/fhir/ValueSet/condition-severity', 'preferred'),
      bound('Condition.bodySite', 'http://hl7.org/fhir/ValueSet/body-site', 'example'),
      { path: 'Condition.clinicalStatus', type: [{ code: 'code' }], binding: { strength: 'required', valueSet: IPS + 'ValueSet/meds' } }
    ]));
    b.addProfile({ ...sd(IPS + 'StructureDefinition/MedicationStatement-uv-ips', 'MedicationStatement', []), snapshot: undefined, differential: { element: [
      bound('MedicationStatement.medication[x]', IPS + 'ValueSet/meds', 'preferred')
    ] } });
    // an abstract results profile with a base binding only, and a lab profile derived from it
    b.addProfile(sd(IPS + 'StructureDefinition/Observation-results-uv-ips', 'Observation', [bound('Observation.code', 'http://hl7.org/fhir/ValueSet/observation-codes', 'example')]));
    b.addProfile(sd(IPS + 'StructureDefinition/Observation-results-laboratory-uv-ips', 'Observation', [bound('Observation.code', IPS + 'ValueSet/labs', 'preferred')], IPS + 'StructureDefinition/Observation-results-uv-ips'));
    // a pattern, as the tobacco use profile has
    b.addProfile(sd(IPS + 'StructureDefinition/Observation-tobaccouse-uv-ips', 'Observation', [
      { ...bound('Observation.code', 'http://hl7.org/fhir/ValueSet/observation-codes', 'example'), patternCodeableConcept: { coding: [{ system: 'http://loinc.org', code: '72166-2' }] } }
    ]));
    // a logical model and a base resource are ignored
    b.addProfile({ resourceType: 'StructureDefinition', url: 'x', kind: 'logical', derivation: 'specialization', type: 'X', differential: { element: [] } });
    return b;
  }

  test('reads CodeableConcept bindings and patterns from profiles', () => {
    const b = make();
    expect(b.count()).toBe(5);
    expect(b.bindingsFor('Condition.code')).toEqual([{ valueSet: IPS + 'ValueSet/problems-uv-ips', strength: 'preferred', profile: IPS + 'StructureDefinition/Condition-uv-ips' }]);
    expect(b.bindingsFor('Condition.severity').map(x => x.valueSet)).toEqual(['http://hl7.org/fhir/ValueSet/condition-severity']);
    expect(b.bindingsFor('Condition.bodySite')).toEqual([]);
    expect(b.bindingsFor('Condition.clinicalStatus')).toEqual([]);
    expect(b.bindingsFor('MedicationStatement.medicationCodeableConcept').map(x => x.valueSet)).toEqual([IPS + 'ValueSet/meds']);
    expect(b.bindingsFor('Observation.code').map(x => x.valueSet || x.pattern)).toEqual([IPS + 'ValueSet/labs', [{ system: 'http://loinc.org', code: '72166-2' }]]);
    expect(b.bindingsFor('nonsense')).toEqual([]);
    expect(b.valueSet(IPS + 'ValueSet/problems-uv-ips|1.1.0').url).toBe(IPS + 'ValueSet/problems-uv-ips');
    // includes are followed, once each, without looping; the IPS's own code systems come too
    expect(b.referencedValueSets(IPS + 'ValueSet/problems-uv-ips').map(v => v.url)).toEqual([IPS + 'ValueSet/inner', IPS + 'CodeSystem/absent-unknown-uv-ips']);
    expect(() => new IpsBindings('hl7.fhir.uv.ips', { packageManager: {} })).toThrow(/id#version/);
  });

  test('chooses profiles by section, following derived profiles and the core package', async () => {
    const b = make();
    // a core package with the vitalsigns profile and its value set
    b.core = {
      async loadByReference({ url }) {
        if (url === 'http://hl7.org/fhir/StructureDefinition/vitalsigns') {
          return sd(url, 'Observation', [bound('Observation.code', 'http://hl7.org/fhir/ValueSet/observation-vitalsignresult', 'extensible')]);
        }
        if (url === 'http://hl7.org/fhir/ValueSet/observation-vitalsignresult') {
          return { resourceType: 'ValueSet', url, compose: { include: [{ system: 'http://loinc.org' }] } };
        }
        return null;
      }
    };
    const section = (name, code, entries) => [
      { id: `Composition.section:${name}`, path: 'Composition.section' },
      { id: `Composition.section:${name}.code`, path: 'Composition.section.code', patternCodeableConcept: { coding: [{ system: 'http://loinc.org', code }] } },
      { id: `Composition.section:${name}.entry`, path: 'Composition.section.entry', type: [{ code: 'Reference', targetProfile: ['http://hl7.org/fhir/StructureDefinition/Observation'] }] },
      ...entries.map(([slice, profile]) => ({ id: `Composition.section:${name}.entry:${slice}`, path: 'Composition.section.entry', type: [{ code: 'Reference', targetProfile: [profile] }] }))
    ];
    await b.readSections({ snapshot: { element: [
      { id: 'Composition', path: 'Composition' },
      ...section('sectionProblems', '11450-4', [['problem', IPS + 'StructureDefinition/Condition-uv-ips']]),
      ...section('sectionResults', '30954-2', [['results', IPS + 'StructureDefinition/Observation-results-uv-ips']]),
      ...section('sectionVitalSigns', '8716-3', [['vitalSign', 'http://hl7.org/fhir/StructureDefinition/vitalsigns']]),
      ...section('sectionSocialHistory', '29762-2', [['tobacco', IPS + 'StructureDefinition/Observation-tobaccouse-uv-ips']]),
      ...section('sectionOdd', '99999-9', [['x', 'http://example.org/not-anywhere']])
    ] } });
    expect([...b.sections.keys()]).toEqual(['http://loinc.org|11450-4', 'http://loinc.org|30954-2', 'http://loinc.org|8716-3', 'http://loinc.org|29762-2', 'http://loinc.org|99999-9']);
    expect(b.sections.get('http://loinc.org|99999-9')).toEqual([]);
    // results: the abstract profile's derived lab profile
    expect(b.bindingsFor('Observation.code', { sectionCode: 'http://loinc.org|30954-2' }).map(x => x.valueSet)).toEqual([IPS + 'ValueSet/labs']);
    expect(b.bindingsFor('Observation.code', { sectionCode: '30954-2' }).map(x => x.valueSet)).toEqual([IPS + 'ValueSet/labs']);
    // vital signs: from the core package
    expect(b.bindingsFor('Observation.code', { sectionCode: 'http://loinc.org|8716-3' }).map(x => x.valueSet)).toEqual(['http://hl7.org/fhir/ValueSet/observation-vitalsignresult']);
    // social history: the pattern
    expect(b.bindingsFor('Observation.code', { sectionCode: 'http://loinc.org|29762-2' })).toEqual([{ pattern: [{ system: 'http://loinc.org', code: '72166-2' }], profile: IPS + 'StructureDefinition/Observation-tobaccouse-uv-ips' }]);
    // a section the IPS doesn't know, or whose profiles don't cover the type: every IPS profile of the type
    expect(b.bindingsFor('Observation.code', { sectionCode: 'http://loinc.org|11450-4' })).toHaveLength(2);
    expect(b.bindingsFor('Observation.code', { sectionCode: 'http://loinc.org|99999-9' })).toHaveLength(2);
    expect(b.bindingsFor('Condition.code', { sectionCode: 'http://loinc.org|11450-4' })).toHaveLength(1);
    // a core value set is fetched on demand, once
    expect(b.valueSet('http://hl7.org/fhir/ValueSet/observation-vitalsignresult')).toBeNull();
    expect((await b.fetchValueSet('http://hl7.org/fhir/ValueSet/observation-vitalsignresult')).url).toBe('http://hl7.org/fhir/ValueSet/observation-vitalsignresult');
    expect(b.valueSet('http://hl7.org/fhir/ValueSet/observation-vitalsignresult')).not.toBeNull();
    expect(await b.fetchValueSet('http://nope')).toBeNull();
  });
});
