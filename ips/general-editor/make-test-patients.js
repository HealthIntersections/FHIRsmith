//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/*
 * The general IPS editor's test patients: the same five people as the patient IPS editor's,
 * but as their GP would summarise them - clinical rather than personal, with the functional
 * status in ICF (qualified codes) and the story as the GP's summary and plan (Plan of Care).
 * The clinical detail beyond what the patients say about themselves is made up, to round out
 * the picture. Each is an editor model, built into a document by the editor's own composer,
 * so the editor can load it back exactly.
 *
 *   node ips/general-editor/make-test-patients.js
 *
 * writes ips/general-editor/test-patients/{n}-{name}.json.
 */
const fs = require('fs');
const path = require('path');
const composer = require('../composer');

const SCT = 'http://snomed.info/sct';
const LOINC = 'http://loinc.org';
const ICF = 'http://hl7.org/fhir/sid/icf';
const V3INT = 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation';

const sct = (code, display) => ({ system: SCT, code, display });
const loinc = (code, display) => ({ system: LOINC, code, display });
// ICF says which version a code is from (versionNeeded); these are ICF 2017
const icf = (code, display) => ({ system: ICF, version: '2017a', code, display });
const txt = (text) => ({ text });
const HIGH = { system: V3INT, code: 'H', display: 'High' };
const LOW = { system: V3INT, code: 'L', display: 'Low' };
const NORMAL = { system: V3INT, code: 'N', display: 'Normal' };
const MILD = sct('255604002', 'Mild');
const MODERATE = sct('6736007', 'Moderate severity');
const SEVERE = sct('24484000', 'Severe');

const LAB = {
  creatinine: loinc('14682-9', 'Creatinine [Moles/volume] in Serum or Plasma'),
  egfr: loinc('62238-1', 'Glomerular filtration rate [Volume Rate/Area] in Serum, Plasma or Blood by Creatinine-based formula (CKD-EPI)/1.73 sq M'),
  hba1c: loinc('4548-4', 'Hemoglobin A1c/Hemoglobin.total in Blood'),
  cholesterol: loinc('14647-2', 'Cholesterol [Moles/volume] in Serum or Plasma'),
  ldl: loinc('22748-8', 'Cholesterol in LDL [Moles/volume] in Serum or Plasma'),
  potassium: loinc('2823-3', 'Potassium [Moles/volume] in Serum or Plasma'),
  hb: loinc('718-7', 'Hemoglobin [Mass/volume] in Blood'),
  ferritin: loinc('2276-4', 'Ferritin [Mass/volume] in Serum or Plasma'),
  tsh: loinc('3016-3', 'Thyrotropin [Units/volume] in Serum or Plasma'),
  alt: loinc('1742-6', 'Alanine aminotransferase [Enzymatic activity/volume] in Serum or Plasma'),
  ggt: loinc('2324-2', 'Gamma glutamyl transferase [Enzymatic activity/volume] in Serum or Plasma'),
  lithium: loinc('14334-7', 'Lithium [Moles/volume] in Serum or Plasma'),
  hcvRna: loinc('11011-4', 'Hepatitis C virus RNA [Units/volume] (viral load) in Serum or Plasma by NAA with probe detection'),
  uacr: loinc('9318-7', 'Albumin/Creatinine [Mass Ratio] in Urine')
};
const VACCINE = {
  influenza: sct('836377006', 'Influenza virus antigen-containing vaccine product'),
  pneumococcal: sct('836398006', 'Streptococcus pneumoniae antigen-containing vaccine product'),
  covid: sct('1119349007', 'SARS-CoV-2 mRNA vaccine'),
  hepB: sct('836374004', 'Hepatitis B virus antigen-containing vaccine product')
};
const DISEASE = {
  influenza: sct('6142004', 'Influenza'),
  pneumococcal: sct('16814004', 'Pneumococcal infectious disease'),
  covid: sct('840539006', 'Disease caused by severe acute respiratory syndrome coronavirus 2'),
  hepB: sct('66071002', 'Viral hepatitis type B'),
  zoster: sct('4740000', 'Herpes zoster'),
  tetanus: sct('76902006', 'Tetanus'),
  hpv: sct('240532009', 'Human papillomavirus infection')
};
const lab = (code, value, unit, date, interpretation, referenceRange, note) =>
  ({ code, value: { value, unit }, date, interpretation: interpretation ? [interpretation] : undefined, referenceRange, note });
const vitals = (date, { bp, hr, rr, spo2, weight, height, bmi }) => [
  bp ? { code: '85354-9', value: { value: bp[0], unit: 'mm[Hg]' }, value2: { value: bp[1], unit: 'mm[Hg]' }, date } : null,
  hr ? { code: '8867-4', value: { value: hr, unit: '/min' }, date } : null,
  rr ? { code: '9279-1', value: { value: rr, unit: '/min' }, date } : null,
  spo2 ? { code: '2708-6', value: { value: spo2, unit: '%' }, date } : null,
  weight ? { code: '29463-7', value: { value: weight, unit: 'kg' }, date } : null,
  height ? { code: '8302-2', value: { value: height, unit: 'cm' }, date } : null,
  bmi ? { code: '39156-5', value: { value: bmi, unit: 'kg/m2' }, date } : null
].filter(Boolean);
const data = (rows) => ({ mode: 'data', rows });
const NIL_KNOWN = { mode: 'empty', emptyReason: 'nilknown' };

const PATIENTS = [
  {
    file: '1-retired-man',
    model: {
      patient: { family: 'McKenzie', given: 'William Robert', gender: 'male', birthDate: '1955-03-15', phone: '0429876543', email: 'bill.mckenzie@bigpond.com', address: '14 Banksia Street, Belmont, 3216, AU' },
      document: { title: 'Patient Summary - William McKenzie', author: 'Dr Helen Fraser', authorType: 'Practitioner', custodian: 'Belmont Family Medical Centre', date: '2025-01-14' },
      sections: {
        problems: data([
          { code: sct('239873007', 'Osteoarthritis of knee'), clinicalStatus: 'active', verificationStatus: 'confirmed', severity: MODERATE, onset: '2012', note: 'Bilateral, right worse than left. X-ray 2023: moderate medial tibiofemoral joint space narrowing both knees. Orthopaedic review 2023: elected conservative management; knee replacement to be reconsidered if walking tolerance falls below 500 m.' },
          { code: sct('278860009', 'Chronic low back pain'), clinicalStatus: 'active', verificationStatus: 'confirmed', severity: MILD, onset: '2008', note: 'Mechanical, no red flags. CT 2021: lumbar spondylosis L4-5, L5-S1, no canal stenosis.' },
          { code: sct('60700002', 'Sensorineural hearing loss'), clinicalStatus: 'active', verificationStatus: 'confirmed', severity: MODERATE, onset: '2010', note: 'Bilateral noise-induced (occupational) loss. Audiogram Sept 2024: moderate to severe high-frequency loss. Bilateral hearing aids fitted Oct 2024.' },
          { code: sct('38341003', 'Hypertensive disorder, systemic arterial'), clinicalStatus: 'active', verificationStatus: 'confirmed', onset: '2016', note: 'Controlled on amlodipine. Home BP average 132/80.' },
          { code: sct('55822004', 'Hyperlipidemia'), clinicalStatus: 'active', verificationStatus: 'confirmed', onset: '2016' }
        ]),
        allergies: data([
          { code: sct('91936005', 'Allergy to penicillin'), type: 'allergy', category: ['medication'], criticality: 'low', clinicalStatus: 'active', verificationStatus: 'confirmed', onset: '1985',
            reactions: [{ manifestation: [sct('126485001', 'Urticaria')], severity: 'moderate', description: 'Generalised urticarial rash 2 days into a course of amoxicillin, 1985. No angioedema or anaphylaxis.' }] }
        ]),
        medications: data([
          { medication: sct('387517004', 'Paracetamol'), status: 'active', start: '2015-03-01', reason: [sct('239873007', 'Osteoarthritis of knee')], dosage: '1 g twice daily, up to 4 g a day', route: sct('26643006', 'Oral route') },
          { medication: sct('387207008', 'Ibuprofen'), status: 'active', start: '2018-06-01', reason: [sct('239873007', 'Osteoarthritis of knee')], dosage: '400 mg three times daily with food when needed, for no more than 5 days at a time', route: sct('26643006', 'Oral route'), note: 'Intermittent use only: watch blood pressure and renal function.' },
          { medication: sct('386864001', 'Amlodipine'), status: 'active', start: '2016-05-10', reason: [sct('38341003', 'Hypertensive disorder, systemic arterial')], dosage: '5 mg once daily', route: sct('26643006', 'Oral route') },
          { medication: sct('373444002', 'Atorvastatin'), status: 'active', start: '2016-05-10', reason: [sct('55822004', 'Hyperlipidemia')], dosage: '20 mg at night', route: sct('26643006', 'Oral route') }
        ]),
        immunizations: data([
          { vaccine: VACCINE.influenza, status: 'completed', date: '2024-04-16', targetDisease: [DISEASE.influenza] },
          { vaccine: VACCINE.covid, status: 'completed', date: '2024-05-20', targetDisease: [DISEASE.covid], doseNumber: '6' },
          { vaccine: VACCINE.pneumococcal, status: 'completed', date: '2020-06-02', targetDisease: [DISEASE.pneumococcal] },
          { vaccine: txt('Zoster vaccine, recombinant (Shingrix)'), status: 'completed', date: '2023-05-11', targetDisease: [DISEASE.zoster], doseNumber: '2' },
          { vaccine: txt('Diphtheria, tetanus and pertussis vaccine (dTpa)'), status: 'completed', date: '2019-09-03', targetDisease: [DISEASE.tetanus] }
        ]),
        procedures: data([
          { code: txt('Amputation of left ring and little fingers'), status: 'completed', performed: '1978-06-12', note: 'Crush injury at work: completion amputation of the left ring and little fingers at the proximal phalanges.' },
          { code: sct('80146002', 'Excision of appendix'), status: 'completed', performed: '1978-06-12', note: 'Same admission: laparotomy for blunt abdominal trauma, appendix removed.' }
        ]),
        devices: data([
          { device: 'Behind-the-ear hearing aids, both ears', deviceType: 'Hearing aid', status: 'active', start: '2024-10-08' }
        ]),
        results: data([
          lab(LAB.egfr, 78, 'mL/min/{1.73_m2}', '2024-12-02', NORMAL, '>60'),
          lab(LAB.creatinine, 88, 'umol/L', '2024-12-02', NORMAL, '60-110'),
          lab(LAB.cholesterol, 4.6, 'mmol/L', '2024-12-02', undefined, '<5.5'),
          lab(LAB.ldl, 2.4, 'mmol/L', '2024-12-02', HIGH, '<2.0 (treatment target)')
        ]),
        vitals: data(vitals('2025-01-14', { bp: [138, 84], hr: 72, weight: 96, height: 178, bmi: 30.3 })),
        pastProblems: data([
          { code: txt('Crush injury of left hand with traumatic amputation of fingers'), clinicalStatus: 'resolved', onset: '1978-06-12', abatement: '1978-09' },
          { code: txt('Blunt abdominal trauma'), clinicalStatus: 'resolved', onset: '1978-06-12', abatement: '1978-07' }
        ]),
        social: data([
          { code: '72166-2', smoking: '8517006', date: '2025-01-14', note: 'Stopped 2005; about 30 pack-years before that.' },
          { code: '74013-4', value: { value: 1.5, unit: '/d' }, date: '2025-01-14', note: 'About 10 standard drinks a week, mostly beer at weekends.' }
        ]),
        functional: data([
          { code: icf('b230.2', 'Hearing functions: MODERATE impairment'), clinicalStatus: 'active', onset: '2010', note: 'With hearing aids. Face him, speak clearly, and confirm complex information in writing.' },
          { code: icf('b280.2', 'Sensation of pain: MODERATE impairment'), clinicalStatus: 'active', note: 'Knees and lower back; worse on stairs and after standing.' },
          { code: icf('d450.12', 'Walking: performance MILD problem, capacity MODERATE problem'), clinicalStatus: 'active', note: 'Walks about 1 km before knee pain stops him; no walking aid.' },
          { code: icf('d430.2', 'Lifting and carrying objects: performance MODERATE problem'), clinicalStatus: 'active' },
          { code: icf('d440.1', 'Fine hand use: performance MILD problem'), clinicalStatus: 'active', note: 'Partial loss of the left ring and little fingers.' },
          { code: icf('e310+3', 'Immediate family: SUBSTANTIAL facilitator'), clinicalStatus: 'active', note: 'Wife Margaret manages his medications.' }
        ]),
        planOfCare: data([
          { title: 'GP chronic disease management plan', status: 'active', start: '2025-01-14', end: '2026-01-14',
            description: 'Recently retired (45 years in construction and heavy industry). Main problems are bilateral knee osteoarthritis and chronic mechanical low back pain, limiting walking and lifting, and noise-induced hearing loss, now aided. Cardiovascular risk: treated hypertension and hyperlipidaemia, ex-smoker, BMI 30; LDL above target.\n\nPlan: exercise physiology and physiotherapy under a GP management plan; weight loss to 90 kg; keep NSAID use intermittent (blood pressure, renal function); increase atorvastatin to 40 mg if LDL still above 2.0 in 3 months; annual audiology review; review in 3 months with blood pressure, lipids and renal function. He wants to stay active for his grandchildren and his garden.' }
        ]),
        directives: data([
          { category: 'Enduring power of attorney (medical treatment)', status: 'active', date: '2019-08-20', description: 'Medical treatment decision maker: Margaret McKenzie (wife).' },
          { category: 'Advance care plan', status: 'active', date: '2024-12-02', description: 'For full active treatment, including resuscitation. Registered organ donor. Accepts blood transfusion.' }
        ]),
        alerts: data([
          { code: 'Hearing impaired: face the patient, speak clearly, and give written instructions', status: 'active', start: '2024-10-08' }
        ])
      }
    }
  },
  {
    file: '2-new-mother',
    model: {
      patient: { family: 'Rahman', given: 'Fatima Abdul', gender: 'female', birthDate: '1995-07-12', phone: '0456789123', email: 'fatima.rahman@hotmail.com', address: '7/21 Station Road, Dandenong, 3175, AU' },
      document: { title: 'Patient Summary - Fatima Rahman', author: 'Dr Laila Sharif', authorType: 'Practitioner', custodian: 'Dandenong Community Health Service', date: '2025-01-20' },
      sections: {
        problems: data([
          { code: sct('84757009', 'Epilepsy'), clinicalStatus: 'active', verificationStatus: 'confirmed', onset: '2024-02', note: 'Focal epilepsy with focal to bilateral tonic-clonic seizures, first presenting in the second trimester (Feb 2024). EEG: left temporal epileptiform discharges; MRI brain normal. Last seizure Sept 2024. Neurology follow-up at Monash Health. Not to drive until 12 months seizure-free.' },
          { code: sct('197480006', 'Anxiety disorder'), clinicalStatus: 'active', verificationStatus: 'confirmed', severity: MODERATE, onset: '2024-06', note: 'Postpartum onset. GAD-7 14 (Dec 2024). Referred to perinatal mental health; counselling with a Dari interpreter.' },
          { code: sct('17226007', 'Adjustment disorder'), clinicalStatus: 'active', verificationStatus: 'provisional', onset: '2022', note: 'Settlement stress since resettling from Afghanistan in 2021; limited English; small social network.' },
          { code: sct('87522002', 'Iron deficiency anemia'), clinicalStatus: 'active', verificationStatus: 'confirmed', severity: MILD, onset: '2024-05', note: 'Postpartum; on oral iron. Recheck in 3 months.' },
          { code: sct('34713006', 'Vitamin D deficiency'), clinicalStatus: 'active', verificationStatus: 'confirmed', onset: '2022' }
        ]),
        allergies: NIL_KNOWN,
        medications: data([
          { medication: sct('387000003', 'Levetiracetam'), status: 'active', start: '2024-02-20', reason: [sct('84757009', 'Epilepsy')], dosage: '500 mg twice daily', route: sct('26643006', 'Oral route'), note: 'Considered compatible with breastfeeding; infant drowsiness and feeding reviewed - no concerns.' },
          { medication: sct('63718003', 'Folic acid'), status: 'active', start: '2024-02-20', dosage: '5 mg once daily', route: sct('26643006', 'Oral route'), note: 'High dose while on an antiseizure medication and of child-bearing age.' },
          { medication: txt('Ferrous sulfate 325 mg (iron 105 mg) modified-release tablet'), status: 'active', start: '2024-12-10', reason: [sct('87522002', 'Iron deficiency anemia')], dosage: '1 tablet daily', route: sct('26643006', 'Oral route') },
          { medication: txt('Colecalciferol 1000 IU capsule'), status: 'active', start: '2022-03-01', reason: [sct('34713006', 'Vitamin D deficiency')], dosage: '1 capsule daily', route: sct('26643006', 'Oral route') }
        ]),
        immunizations: data([
          { vaccine: txt('Diphtheria, tetanus and pertussis vaccine (dTpa)'), status: 'completed', date: '2024-01-15', targetDisease: [DISEASE.tetanus], note: 'Given in pregnancy (28 weeks).' },
          { vaccine: VACCINE.influenza, status: 'completed', date: '2024-04-02', targetDisease: [DISEASE.influenza], note: 'Given in pregnancy.' },
          { vaccine: VACCINE.covid, status: 'completed', date: '2023-02-14', targetDisease: [DISEASE.covid], doseNumber: '3' }
        ]),
        procedures: data([
          { code: sct('48782003', 'Delivery normal'), status: 'completed', performed: '2024-04-30', note: 'Spontaneous vaginal delivery at 39 weeks; no seizures in labour. Daughter, 3.1 kg.' }
        ]),
        results: data([
          lab(LAB.hb, 112, 'g/L', '2024-12-10', LOW, '115-160'),
          lab(LAB.ferritin, 14, 'ug/L', '2024-12-10', LOW, '30-200'),
          lab(LAB.tsh, 1.8, 'mU/L', '2024-12-10', NORMAL, '0.5-4.0')
        ]),
        vitals: data(vitals('2025-01-20', { bp: [112, 70], hr: 78, weight: 61, height: 158, bmi: 24.4 })),
        pregnancy: data([
          { code: '82810-3', status: '60001007', date: '2025-01-20', note: 'Breastfeeding. Contraception: progestogen-only pill.' },
          { code: '11636-8', value: { value: 1, unit: '{births}' }, date: '2025-01-20' }
        ]),
        social: data([
          { code: '72166-2', smoking: '266919005', date: '2025-01-20' },
          { code: '74013-4', value: { value: 0, unit: '/d' }, date: '2025-01-20' }
        ]),
        functional: data([
          { code: icf('b110.1', 'Consciousness functions: MILD impairment'), clinicalStatus: 'active', onset: '2024-02', note: 'Seizures: none since Sept 2024.' },
          { code: icf('b152.2', 'Emotional functions: MODERATE impairment'), clinicalStatus: 'active', onset: '2024-06' },
          { code: icf('b134.1', 'Sleep functions: MILD impairment'), clinicalStatus: 'active', note: 'Broken sleep with infant feeding; sleep deprivation lowers her seizure threshold.' },
          { code: icf('d310.3', 'Communicating with - receiving - spoken messages: performance SEVERE problem'), clinicalStatus: 'active', note: 'In English. Needs a Dari interpreter for clinical discussions.' },
          { code: icf('d475.4', 'Driving: performance COMPLETE problem'), clinicalStatus: 'active', note: 'Not permitted to drive until 12 months seizure-free.' },
          { code: icf('e310+3', 'Immediate family: SUBSTANTIAL facilitator'), clinicalStatus: 'active', note: 'Husband Ahmad attends appointments.' }
        ]),
        planOfCare: data([
          { title: 'Postnatal and epilepsy care plan', status: 'active', start: '2025-01-20', end: '2025-07-20',
            description: 'Nine months postpartum, breastfeeding, with new-onset focal epilepsy (onset in pregnancy), postpartum anxiety, and iron and vitamin D deficiency. Resettled from Afghanistan in 2021; speaks Dari, limited English.\n\nPlan: continue levetiracetam; seizure diary; sleep protection (partner to do a night feed); seizure safety with the baby (bathing, carrying on stairs); neurology review in March. Perinatal mental health: counselling continuing, review GAD-7 in 6 weeks. Iron and ferritin recheck in 3 months. Her daughter is under paediatric review for developmental delay; the family is linked with early intervention. Book a Dari interpreter and a female clinician for every visit.' }
        ]),
        directives: data([
          { category: 'Refusal of blood transfusion', status: 'active', date: '2024-03-12', description: 'Declines transfusion of blood products. Discussed at the antenatal booking; she accepts iron infusion.' }
        ]),
        alerts: data([
          { code: 'Interpreter required: Dari (book in advance)', status: 'active', start: '2021-09-01' },
          { code: 'Prefers female clinicians', status: 'active', start: '2021-09-01' }
        ])
      }
    }
  },
  {
    file: '3-grandmother',
    model: {
      patient: { family: 'Henderson', given: 'Patricia Joan', gender: 'female', birthDate: '1952-11-08', phone: '0423567891', email: 'pat.henderson@outlook.com', address: '3 Lakeview Crescent, Ballarat, 3350, AU' },
      document: { title: 'Patient Summary - Patricia Henderson', author: 'Dr Andrew Collins', authorType: 'Practitioner', custodian: 'Lakeside Medical Centre', date: '2025-01-22' },
      sections: {
        problems: data([
          { code: sct('254837009', 'Malignant neoplasm of breast'), clinicalStatus: 'active', verificationStatus: 'confirmed', onset: '2024-12-04', bodySite: sct('80248007', 'Left breast structure'), note: 'Left breast invasive ductal carcinoma, grade 2, ER+ PR+ HER2-, stage IIA (pT2 N0). Wide local excision and sentinel node biopsy 10 Jan 2025, clear margins. Adjuvant radiotherapy then letrozole planned (Ballarat Regional Integrated Cancer Centre).' },
          { code: sct('44054006', 'Diabetes mellitus type 2'), clinicalStatus: 'active', verificationStatus: 'confirmed', onset: '2018', note: 'HbA1c 7.4% (Dec 2024). Basal insulin since 2023. Retinal screening 2024: no retinopathy. Feet: monofilament sensation intact.' },
          { code: sct('431856006', 'Chronic kidney disease stage 2'), clinicalStatus: 'active', verificationStatus: 'confirmed', onset: '2022', note: 'Diabetic kidney disease: eGFR 68, albuminuria. On an ACE inhibitor. Avoid nephrotoxins; check renal function before and after iodinated contrast.' },
          { code: sct('38341003', 'Hypertensive disorder, systemic arterial'), clinicalStatus: 'active', verificationStatus: 'confirmed', onset: '2015' },
          { code: sct('386807006', 'Memory impairment'), clinicalStatus: 'active', verificationStatus: 'provisional', severity: MILD, onset: '2024', note: 'Mild. MoCA 25/30 (Oct 2024). Confusion with medicines; dose administration aid started.' }
        ]),
        allergies: data([
          { code: sct('373529000', 'Morphine'), type: 'intolerance', category: ['medication'], criticality: 'low', clinicalStatus: 'active', verificationStatus: 'confirmed', onset: '2016-08',
            note: 'Tolerates oxycodone.',
            reactions: [{ manifestation: [sct('16932000', 'Nausea and vomiting')], severity: 'moderate', description: 'Intractable vomiting with morphine PCA after colectomy, 2016.' }] }
        ]),
        medications: data([
          { medication: sct('372567009', 'Metformin'), status: 'active', start: '2018-04-01', reason: [sct('44054006', 'Diabetes mellitus type 2')], dosage: '1 g twice daily with meals', route: sct('26643006', 'Oral route'), note: 'Reduce if eGFR falls below 45; withhold for 48 hours after iodinated contrast.' },
          { medication: sct('411529005', 'Insulin glargine'), status: 'active', start: '2023-02-01', reason: [sct('44054006', 'Diabetes mellitus type 2')], dosage: '24 units at bedtime', route: sct('34206005', 'Subcutaneous route') },
          { medication: sct('386873009', 'Lisinopril'), status: 'active', start: '2015-09-01', reason: [sct('431856006', 'Chronic kidney disease stage 2')], dosage: '10 mg once daily', route: sct('26643006', 'Oral route') },
          { medication: sct('373444002', 'Atorvastatin'), status: 'active', start: '2018-04-01', dosage: '40 mg at night', route: sct('26643006', 'Oral route') },
          { medication: txt('Letrozole 2.5 mg tablet'), status: 'intended', start: '2025-04-01', reason: [sct('254837009', 'Malignant neoplasm of breast')], dosage: '2.5 mg once daily for 5 years, after radiotherapy', route: sct('26643006', 'Oral route') }
        ]),
        immunizations: data([
          { vaccine: VACCINE.influenza, status: 'completed', date: '2024-04-09', targetDisease: [DISEASE.influenza] },
          { vaccine: VACCINE.covid, status: 'completed', date: '2024-03-18', targetDisease: [DISEASE.covid], doseNumber: '6' },
          { vaccine: VACCINE.pneumococcal, status: 'completed', date: '2018-01-22', targetDisease: [DISEASE.pneumococcal] },
          { vaccine: txt('Zoster vaccine, recombinant (Shingrix)'), status: 'completed', date: '2022-08-30', targetDisease: [DISEASE.zoster], doseNumber: '2' }
        ]),
        procedures: data([
          { code: sct('392021009', 'Lumpectomy of breast'), status: 'completed', performed: '2025-01-10', bodySite: [sct('80248007', 'Left breast structure')], reason: [sct('254837009', 'Malignant neoplasm of breast')], note: 'Wide local excision, clear margins.' },
          { code: sct('396487001', 'Sentinel lymph node biopsy'), status: 'completed', performed: '2025-01-10', note: 'Left axilla: 0/2 nodes involved.' },
          { code: sct('23968004', 'Colectomy'), status: 'completed', performed: '2016-08-15', note: 'Right hemicolectomy for colon adenocarcinoma, with resection of a single liver metastasis (segment VI); adjuvant FOLFOX. Disease-free on surveillance.' }
        ]),
        results: data([
          lab(LAB.hba1c, 7.4, '%', '2024-12-10', HIGH, '<7.0 (target)'),
          lab(LAB.egfr, 68, 'mL/min/{1.73_m2}', '2024-12-10', LOW, '>90'),
          lab(LAB.creatinine, 78, 'umol/L', '2024-12-10', NORMAL, '45-90'),
          lab(LAB.uacr, 45, 'mg/g', '2024-12-10', HIGH, '<30'),
          lab(LAB.potassium, 4.6, 'mmol/L', '2024-12-10', NORMAL, '3.5-5.2')
        ]),
        vitals: data(vitals('2025-01-22', { bp: [132, 78], hr: 80, weight: 74, height: 162, bmi: 28.2 })),
        pastProblems: data([
          { code: sct('363406005', 'Malignant neoplasm of colon'), clinicalStatus: 'remission', verificationStatus: 'confirmed', onset: '2016-06', note: 'Stage IV (single liver metastasis) at diagnosis; resected. CEA and surveillance CT normal to Nov 2024.' }
        ]),
        social: data([
          { code: '72166-2', smoking: '266919005', date: '2025-01-22' },
          { code: '74013-4', value: { value: 0.3, unit: '/d' }, date: '2025-01-22', note: 'About 2 standard drinks a week.' }
        ]),
        functional: data([
          { code: icf('b144.1', 'Memory functions: MILD impairment'), clinicalStatus: 'active', onset: '2024' },
          { code: icf('d570.12', "Looking after one's health: performance MILD problem, capacity MODERATE problem"), clinicalStatus: 'active', note: 'Manages her medicines with a pharmacy-packed dose administration aid; capacity without it is reduced.' },
          { code: icf('b130.1', 'Energy and drive functions: MILD impairment'), clinicalStatus: 'active', onset: '2025-01', note: 'Post-operative fatigue.' },
          { code: icf('e310+3', 'Immediate family: SUBSTANTIAL facilitator'), clinicalStatus: 'active', note: 'Daughter Sarah coordinates appointments and holds medical power of attorney.' }
        ]),
        planOfCare: data([
          { title: 'Shared care: breast cancer treatment with diabetes and kidney disease', status: 'active', start: '2025-01-22', end: '2025-12-31',
            description: 'Newly diagnosed early left breast cancer, now excised, in a 72-year-old with type 2 diabetes on basal insulin, stage 2 diabetic kidney disease, and a history of resected stage IV colon cancer (2016, in remission). Mild memory impairment; family very involved.\n\nPlan: adjuvant radiotherapy then letrozole (oncology); GP to monitor glucose closely during treatment - sick day plan given, insulin titration by the diabetes educator; keep renal function stable (no NSAIDs, contrast precautions, metformin hold rules); bone density before letrozole; continue colon cancer surveillance with oncology. Any medication change must go to her pharmacy so the dose administration aid is updated. She is focused on staying well for her grandchildren.' }
        ]),
        directives: data([
          { category: 'Enduring power of attorney (medical treatment)', status: 'active', date: '2017-02-14', description: 'Medical treatment decision maker: Sarah Henderson-Williams (daughter).' },
          { category: 'Advance care plan', status: 'active', date: '2025-01-22', description: 'Wants full active treatment, including resuscitation. Organ donor. Accepts blood transfusion. To be revisited if the cancer recurs.' }
        ]),
        alerts: data([
          { code: 'Uses a dose administration aid: send every medication change to her pharmacy', status: 'active', start: '2024-10-15' }
        ])
      }
    }
  },
  {
    file: '4-teenage-boy',
    model: {
      patient: { family: 'Ngalarra', given: 'Jaiden William', gender: 'male', birthDate: '2010-09-23', phone: '0487654321', email: 'ngalarra.family@gmail.com', address: 'One Arm Point, 6725, AU' },
      document: { title: 'Patient Summary - Jaiden Ngalarra', author: 'Dr Kate Morrison', authorType: 'Practitioner', custodian: 'Dampier Peninsula Remote Health Clinic', date: '2024-12-18' },
      sections: {
        problems: data([
          { code: sct('33737001', 'Fracture of rib'), clinicalStatus: 'active', verificationStatus: 'confirmed', onset: '2024-11-14', bodySite: sct('51185008', 'Thoracic structure'), note: 'Left 5th to 8th rib fractures (bicycle crash, 14 Nov 2024), no flail segment; healing. Pain controlled with paracetamol.' },
          { code: txt('Liver contusion (grade II), managed non-operatively'), clinicalStatus: 'active', verificationStatus: 'confirmed', onset: '2024-11-14', note: 'CT 15 Nov 2024. LFTs normalised Dec 2024. No contact sport for 3 months from injury (until mid-Feb 2025).' }
        ]),
        allergies: NIL_KNOWN,
        medications: data([
          { medication: sct('387517004', 'Paracetamol'), status: 'active', start: '2024-11-20', end: '2025-01-15', reason: [sct('33737001', 'Fracture of rib')], dosage: '500 mg every 6 hours when needed, up to 4 doses a day', route: sct('26643006', 'Oral route') }
        ]),
        immunizations: data([
          { vaccine: txt('Human papillomavirus 9-valent vaccine (Gardasil 9)'), status: 'completed', date: '2023-03-08', targetDisease: [DISEASE.hpv], note: 'School program, year 7.' },
          { vaccine: txt('Diphtheria, tetanus and pertussis vaccine (dTpa)'), status: 'completed', date: '2023-03-08', targetDisease: [DISEASE.tetanus], note: 'School program, year 7.' },
          { vaccine: VACCINE.influenza, status: 'completed', date: '2024-05-02', targetDisease: [DISEASE.influenza] }
        ]),
        procedures: data([
          { code: txt('Insertion of intercostal catheter (left)'), status: 'completed', performed: '2024-11-15', reason: [sct('36118008', 'Pneumothorax')], note: 'Removed on day 4.' }
        ]),
        results: data([
          lab(LAB.hb, 128, 'g/L', '2024-12-10', NORMAL, '120-160'),
          lab(LAB.alt, 28, 'U/L', '2024-12-10', NORMAL, '<40', 'ALT was 210 U/L on admission.')
        ]),
        vitals: data(vitals('2024-12-18', { bp: [112, 68], hr: 76, rr: 16, spo2: 98, weight: 52, height: 165 })),
        pastProblems: data([
          { code: sct('36118008', 'Pneumothorax'), clinicalStatus: 'resolved', verificationStatus: 'confirmed', onset: '2024-11-14', abatement: '2024-11-19', note: 'Left traumatic pneumothorax; intercostal catheter; chest X-ray 10 Dec 2024 shows full re-expansion.' }
        ]),
        social: data([
          { code: '72166-2', smoking: '266919005', date: '2024-12-18' }
        ]),
        functional: data([
          { code: icf('b280.1', 'Sensation of pain: MILD impairment'), clinicalStatus: 'active', onset: '2024-11-14', note: 'Chest wall pain on deep breathing and twisting.' },
          { code: icf('b455.1', 'Exercise tolerance functions: MILD impairment'), clinicalStatus: 'active', onset: '2024-11-14' },
          { code: icf('d9201.4', 'Sports: performance COMPLETE problem'), clinicalStatus: 'active', note: 'No football or other contact sport until cleared (liver injury) - mid-February 2025 at the earliest.' },
          { code: icf('d820.1', 'School education: performance MILD problem'), clinicalStatus: 'active', note: 'Missed 3 weeks of term 4; back at school with modified PE.' },
          { code: icf('e310+3', 'Immediate family: SUBSTANTIAL facilitator'), clinicalStatus: 'active', note: 'Mother Michelle and grandmother closely involved.' }
        ]),
        planOfCare: data([
          { title: 'Recovery after chest and abdominal trauma', status: 'active', start: '2024-12-18', end: '2025-03-31',
            description: '14-year-old from One Arm Point, five weeks after a bicycle crash with left rib fractures, a traumatic pneumothorax (drained, resolved) and a grade II liver contusion (non-operative). Recovering well; pain mild.\n\nPlan: graded return to activity - walking and swimming now; bike riding from January; no contact sport until cleared at the review in mid-February 2025 (liver). Breathing exercises. Seek care at once with abdominal pain, shoulder-tip pain, dizziness or breathlessness. Review by the visiting doctor in 4 weeks, with the Aboriginal Health Worker; family to be present. Telehealth follow-up with the Perth Children\'s Hospital trauma team if needed. He wants to get back to football and fishing, and is interested in marine biology.' }
        ]),
        alerts: data([
          { code: 'Prefers a family member present; involve the Aboriginal Health Worker', status: 'active', start: '2024-11-15' }
        ])
      }
    }
  },
  {
    file: '5-young-woman',
    model: {
      patient: { family: 'Taylor', given: 'Chloe Marie', gender: 'female', birthDate: '2004-02-14', phone: '0434567812', email: 'chloe.taylor94@gmail.com', address: 'Unit 4, 18 Commercial Road, Port Adelaide, 5015, AU' },
      document: { title: 'Patient Summary - Chloe Taylor', author: 'Dr Priya Raman', authorType: 'Practitioner', custodian: 'Port Adelaide Family Practice', date: '2024-12-12' },
      sections: {
        problems: data([
          { code: sct('371596008', 'Bipolar I disorder'), clinicalStatus: 'active', verificationStatus: 'confirmed', onset: '2024-10', note: 'Diagnosed by psychiatry Oct 2024 after a manic episode with psychotic features (inpatient 10 days). Shared care with the community mental health team. Lithium started.' },
          { code: sct('21897009', 'Generalized anxiety disorder'), clinicalStatus: 'active', verificationStatus: 'confirmed', severity: SEVERE, onset: '2023', note: 'With agoraphobic avoidance.' },
          { code: txt('Alcohol use disorder, moderate'), clinicalStatus: 'active', verificationStatus: 'confirmed', onset: '2024-06', note: 'AUDIT 24 (Oct 2024). Thiamine; withdrawal plan with the drug and alcohol service.' },
          { code: txt('Stimulant (methamphetamine) use disorder'), clinicalStatus: 'active', verificationStatus: 'confirmed', onset: '2024-08', note: 'Smoked, about weekly; last use 5 Dec 2024. Engaged with the drug and alcohol service.' },
          { code: sct('128302006', 'Chronic hepatitis C'), clinicalStatus: 'active', verificationStatus: 'confirmed', onset: '2024-11', note: 'Genotype 3, viral load 2.1 million IU/mL; no cirrhosis (elastography 5.8 kPa). Sofosbuvir/velpatasvir started 2 Dec 2024 (12 weeks). SVR12 test due May 2025.' }
        ]),
        allergies: data([
          { code: sct('387494007', 'Codeine'), type: 'intolerance', category: ['medication'], criticality: 'low', clinicalStatus: 'active', verificationStatus: 'confirmed', onset: '2019',
            reactions: [{ manifestation: [sct('422400008', 'Vomiting')], severity: 'moderate', description: 'Vomiting after codeine-containing analgesic, 2019.' }] }
        ]),
        medications: data([
          { medication: txt('Lithium carbonate 450 mg modified-release tablet'), status: 'active', start: '2024-10-18', reason: [sct('371596008', 'Bipolar I disorder')], dosage: '450 mg twice daily', route: sct('26643006', 'Oral route'), note: 'Level 0.7 mmol/L (5 Dec 2024). Levels, renal and thyroid function every 3 months.' },
          { medication: sct('372594008', 'Sertraline'), status: 'active', start: '2024-10-25', reason: [sct('21897009', 'Generalized anxiety disorder')], dosage: '50 mg in the morning', route: sct('26643006', 'Oral route'), note: 'Only with a mood stabiliser; watch for a switch to mania.' },
          { medication: txt('Sofosbuvir 400 mg / velpatasvir 100 mg tablet (Epclusa)'), status: 'active', start: '2024-12-02', end: '2025-02-24', reason: [sct('128302006', 'Chronic hepatitis C')], dosage: '1 tablet once daily for 12 weeks', route: sct('26643006', 'Oral route') },
          { medication: txt('Thiamine 100 mg tablet'), status: 'active', start: '2024-10-18', dosage: '100 mg once daily', route: sct('26643006', 'Oral route') }
        ]),
        immunizations: data([
          { vaccine: VACCINE.hepB, status: 'completed', date: '2024-12-12', targetDisease: [DISEASE.hepB], doseNumber: '1', note: 'Non-immune (HBsAb negative); accelerated course started.' },
          { vaccine: txt('Hepatitis A vaccine'), status: 'completed', date: '2024-12-12', doseNumber: '1' },
          { vaccine: txt('Human papillomavirus 9-valent vaccine (Gardasil 9)'), status: 'completed', date: '2017-03-14', targetDisease: [DISEASE.hpv], note: 'School program.' },
          { vaccine: VACCINE.influenza, status: 'completed', date: '2024-05-06', targetDisease: [DISEASE.influenza] }
        ]),
        procedures: NIL_KNOWN,
        results: data([
          lab(LAB.hcvRna, 2100000, '[IU]/mL', '2024-11-05', HIGH, 'Not detected'),
          lab(LAB.alt, 68, 'U/L', '2024-11-05', HIGH, '<35'),
          lab(LAB.ggt, 95, 'U/L', '2024-11-05', HIGH, '<38'),
          lab(LAB.lithium, 0.7, 'mmol/L', '2024-12-05', NORMAL, '0.6-1.0 (therapeutic)', '12 hours after the dose.'),
          lab(LAB.creatinine, 64, 'umol/L', '2024-12-05', NORMAL, '45-90'),
          lab(LAB.tsh, 2.1, 'mU/L', '2024-12-05', NORMAL, '0.5-4.0')
        ]),
        vitals: data(vitals('2024-12-12', { bp: [118, 72], hr: 88, weight: 55, height: 166, bmi: 20 })),
        pregnancy: data([
          { code: '82810-3', status: '60001007', date: '2024-12-12', note: 'Urine hCG negative. Lithium is teratogenic: etonogestrel implant inserted 12 Dec 2024.' }
        ]),
        social: data([
          { code: '72166-2', smoking: '449868002', date: '2024-12-12', note: 'About 10 cigarettes a day; nicotine replacement offered.' },
          { code: '74013-4', value: { value: 3.5, unit: '/d' }, date: '2024-12-12', note: 'About 25 standard drinks a week, in binges; less since November.' },
          { code: '11331-6', valueText: 'Alcohol use disorder - see problem list', date: '2024-12-12' }
        ]),
        functional: data([
          { code: icf('b152.3', 'Emotional functions: SEVERE impairment'), clinicalStatus: 'active', onset: '2024-06' },
          { code: icf('b140.2', 'Attention functions: MODERATE impairment'), clinicalStatus: 'active', note: 'Give information in short pieces, in writing.' },
          { code: icf('b144.1', 'Memory functions: MILD impairment'), clinicalStatus: 'active' },
          { code: icf('d240.3', 'Handling stress and other psychological demands: performance SEVERE problem'), clinicalStatus: 'active' },
          { code: icf('d460.3', 'Moving around in different locations: performance SEVERE problem'), clinicalStatus: 'active', note: 'Rarely leaves home because of anxiety; telehealth helps.' },
          { code: icf('d850.4', 'Remunerative employment: performance COMPLETE problem'), clinicalStatus: 'active', onset: '2024-08', note: 'Not working since August 2024.' },
          { code: icf('e355+3', 'Health professionals: SUBSTANTIAL facilitator'), clinicalStatus: 'active', note: 'Community mental health team and the drug and alcohol service.' },
          { code: icf('e310+1', 'Immediate family: MILD facilitator'), clinicalStatus: 'active', note: 'Mother Rebecca supportive; parents recently separated.' }
        ]),
        planOfCare: data([
          { title: 'Mental health, drug and alcohol, and hepatitis C care plan', status: 'active', start: '2024-12-12', end: '2025-06-12',
            description: '20-year-old with newly diagnosed bipolar I disorder (lithium), severe generalised anxiety with agoraphobic avoidance, alcohol and methamphetamine use disorders, and chronic hepatitis C (genotype 3, on treatment). Recent major stressors: parents\' separation and the end of a relationship.\n\nPlan: mental health treatment plan with the community mental health team (case manager, psychology); lithium levels, renal and thyroid function every 3 months, and lithium safety (no NSAIDs, keep hydrated, report vomiting or diarrhoea). Drug and alcohol service: counselling, consider naltrexone. Complete 12 weeks of sofosbuvir/velpatasvir with weekly dispensing; SVR12 in May 2025; complete hepatitis A and B vaccination. Contraception: implant. Trauma-informed, non-judgemental care; telehealth when she can\'t come in. She wants to stop drinking and using, and to get back to her art.' }
        ]),
        alerts: data([
          { code: 'Lithium therapy: risk of toxicity with NSAIDs, ACE inhibitors, diuretics or dehydration - check a level if unwell', status: 'active', start: '2024-10-18' }
        ])
      }
    }
  }
];

async function main() {
  const out = path.join(__dirname, 'test-patients');
  fs.mkdirSync(out, { recursive: true });
  for (const p of PATIENTS) {
    const built = await composer.build(p.model, { now: new Date(p.model.document.date + 'T10:00:00+10:00') });
    if (!built.bundle || built.problems.length > 0) {
      throw new Error(`${p.file}: ${built.problems.join('; ')}`);
    }
    fs.writeFileSync(path.join(out, `${p.file}.json`), JSON.stringify(built.bundle, null, 2) + '\n');
    console.log(`${p.file}: ${built.bundle.entry.length} entries`); // eslint-disable-line no-console
  }
}

if (require.main === module) {
  main().catch(e => { console.error(e.message); process.exitCode = 1; }); // eslint-disable-line no-console
}

module.exports = { PATIENTS };
