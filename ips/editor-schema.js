//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * What the IPS editor edits: the patient and the document's header, and the sections, each
 * with the fields of the resource it holds - the ones the presenter renders, with coded
 * fields bound to the value sets the terminology check holds them to (ips/valuesets/), so
 * the editor can look codes up. One declaration drives the form in the browser
 * (editor.js), the building of the document from what was entered, and the reading of a
 * document back into the form (composer.js).
 *
 * A field is { name, label, type, ... }:
 *   text, textarea, date, datetime      strings
 *   select                               one of options [{ code, display }]; `system` makes it a
 *                                        CodeableConcept, else it is a code
 *   code                                 a coding looked up in `valueSet` (an id in ips/valuesets/),
 *                                        or typed as text; { system, code, display, text }
 *   quantity                             { value, unit }
 * and `path` says where it goes in the resource: an element name, with [x] for a choice
 * (onset[x] takes the type from the field: date -> onsetDateTime; the composer decides) and
 * a.b for nesting. A section's `subs` are repeating parts of the resource (reactions,
 * components...), each with fields of its own and a `path` to the repeating element.
 *
 * @module ips/editor-schema
 */

const VS = 'http://healthintersections.com.au/fhirsmith/ValueSet/';
const SCT = 'http://snomed.info/sct';
const LOINC = 'http://loinc.org';
const THO = 'http://terminology.hl7.org/CodeSystem/';

const EMPTY_REASONS = [
  { code: 'nilknown', display: 'Nil known' },
  { code: 'notasked', display: 'Not asked' },
  { code: 'withheld', display: 'Information withheld' },
  { code: 'unavailable', display: 'Unavailable' },
  { code: 'notstarted', display: 'Not started' },
  { code: 'closed', display: 'Closed' }
];
const EMPTY_REASON_SYSTEM = THO + 'list-empty-reason';

const CLINICAL_STATUS = { system: THO + 'condition-clinical', options: [
  { code: 'active', display: 'Active' }, { code: 'recurrence', display: 'Recurrence' }, { code: 'relapse', display: 'Relapse' },
  { code: 'inactive', display: 'Inactive' }, { code: 'remission', display: 'Remission' }, { code: 'resolved', display: 'Resolved' }
] };
const VERIFICATION_STATUS = { system: THO + 'condition-ver-status', options: [
  { code: 'unconfirmed', display: 'Unconfirmed' }, { code: 'provisional', display: 'Provisional' }, { code: 'differential', display: 'Differential' },
  { code: 'confirmed', display: 'Confirmed' }, { code: 'refuted', display: 'Refuted' }, { code: 'entered-in-error', display: 'Entered in error' }
] };
const ALLERGY_CLINICAL = { system: THO + 'allergyintolerance-clinical', options: [
  { code: 'active', display: 'Active' }, { code: 'inactive', display: 'Inactive' }, { code: 'resolved', display: 'Resolved' }
] };
const ALLERGY_VERIFICATION = { system: THO + 'allergyintolerance-verification', options: [
  { code: 'unconfirmed', display: 'Unconfirmed' }, { code: 'confirmed', display: 'Confirmed' }, { code: 'refuted', display: 'Refuted' }, { code: 'entered-in-error', display: 'Entered in error' }
] };
const SEVERITY = [{ code: 'mild', display: 'Mild' }, { code: 'moderate', display: 'Moderate' }, { code: 'severe', display: 'Severe' }];

const sel = (name, label, options, extra = {}) => ({ name, label, type: 'select', options, ...extra });
const code = (name, label, valueSet, extra = {}) => ({ name, label, type: 'code', valueSet, ...extra });
const text = (name, label, extra = {}) => ({ name, label, type: 'text', ...extra });
const date = (name, label, extra = {}) => ({ name, label, type: 'date', ...extra });
const note = { name: 'note', label: 'Note', type: 'textarea', path: 'note' };

/** The patient, and the document's header. */
const HEADER = {
  patient: [
    text('family', 'Family name', { required: true }),
    text('given', 'Given names'),
    sel('gender', 'Gender', [{ code: 'male', display: 'Male' }, { code: 'female', display: 'Female' }, { code: 'other', display: 'Other' }, { code: 'unknown', display: 'Unknown' }]),
    date('birthDate', 'Date of birth'),
    text('identifierSystem', 'Identifier system', { placeholder: 'urn:oid:... or a URL' }),
    text('identifier', 'Identifier'),
    text('phone', 'Phone'),
    text('email', 'Email'),
    text('address', 'Address', { placeholder: 'line, city, postcode, country' })
  ],
  document: [
    text('title', 'Title', { placeholder: 'Patient Summary as of ...' }),
    text('author', 'Author', { placeholder: 'the person or organization writing it', required: true }),
    sel('authorType', 'Author is', [{ code: 'Practitioner', display: 'a practitioner' }, { code: 'Organization', display: 'an organization' }]),
    text('custodian', 'Custodian', { placeholder: 'the organization that holds the record' }),
    date('date', 'Date')
  ]
};

/** The sections, in the IPS order. */
const SECTIONS = [
  {
    key: 'problems', code: '11450-4', title: 'Problem List', required: true, resourceType: 'Condition', label: 'Problem',
    fields: [
      code('code', 'Problem', 'ips-condition-code', { path: 'code', required: true }),
      sel('clinicalStatus', 'Clinical status', CLINICAL_STATUS.options, { system: CLINICAL_STATUS.system, path: 'clinicalStatus', default: 'active' }),
      sel('verificationStatus', 'Verification', VERIFICATION_STATUS.options, { system: VERIFICATION_STATUS.system, path: 'verificationStatus' }),
      code('severity', 'Severity', 'ips-condition-severity', { path: 'severity' }),
      date('onset', 'Onset', { path: 'onset[x]' }),
      date('abatement', 'Abatement', { path: 'abatement[x]' }),
      code('bodySite', 'Body site', 'ips-body-site', { path: 'bodySite' }),
      note
    ],
    fixed: { category: [{ coding: [{ system: THO + 'condition-category', code: 'problem-list-item', display: 'Problem List Item' }] }] }
  },
  {
    key: 'allergies', code: '48765-2', title: 'Allergies and Intolerances', required: true, resourceType: 'AllergyIntolerance', label: 'Allergy / intolerance',
    fields: [
      code('code', 'Allergy / intolerance', 'ips-allergy-code', { path: 'code', required: true }),
      sel('type', 'Type', [{ code: 'allergy', display: 'Allergy' }, { code: 'intolerance', display: 'Intolerance' }], { path: 'type' }),
      sel('category', 'Category', [{ code: 'food', display: 'Food' }, { code: 'medication', display: 'Medication' }, { code: 'environment', display: 'Environment' }, { code: 'biologic', display: 'Biologic' }], { path: 'category', list: true }),
      sel('criticality', 'Criticality', [{ code: 'low', display: 'Low' }, { code: 'high', display: 'High' }, { code: 'unable-to-assess', display: 'Unable to assess' }], { path: 'criticality' }),
      sel('clinicalStatus', 'Clinical status', ALLERGY_CLINICAL.options, { system: ALLERGY_CLINICAL.system, path: 'clinicalStatus', default: 'active' }),
      sel('verificationStatus', 'Verification', ALLERGY_VERIFICATION.options, { system: ALLERGY_VERIFICATION.system, path: 'verificationStatus' }),
      date('onset', 'Onset', { path: 'onset[x]' }),
      note
    ],
    subs: [{
      name: 'reactions', label: 'Reactions', path: 'reaction',
      fields: [
        code('manifestation', 'Manifestation', 'ips-allergy-manifestation', { path: 'manifestation', list: true, required: true }),
        sel('severity', 'Severity', SEVERITY, { path: 'severity' }),
        date('onset', 'Onset', { path: 'onset' }),
        text('description', 'Description', { path: 'description' })
      ]
    }]
  },
  {
    key: 'medications', code: '10160-0', title: 'Medication Summary', required: true, resourceType: 'MedicationStatement', label: 'Medication',
    fields: [
      code('medication', 'Medication', 'ips-medication', { path: 'medication[x]', required: true }),
      sel('status', 'Status', [{ code: 'active', display: 'Active' }, { code: 'completed', display: 'Completed' }, { code: 'intended', display: 'Intended' }, { code: 'stopped', display: 'Stopped' }, { code: 'on-hold', display: 'On hold' }, { code: 'not-taken', display: 'Not taken' }], { path: 'status', default: 'active', required: true }),
      date('start', 'From', { path: 'effectivePeriod.start' }),
      date('end', 'Until', { path: 'effectivePeriod.end' }),
      code('reason', 'Reason', 'ips-clinical-finding-or-none', { path: 'reasonCode', list: true }),
      text('dosage', 'Dosage', { path: 'dosage.text', placeholder: 'e.g. 1 tablet twice daily' }),
      code('route', 'Route', 'ips-route', { path: 'dosage.route' }),
      note
    ]
  },
  {
    key: 'immunizations', code: '11369-6', title: 'Immunizations', resourceType: 'Immunization', label: 'Immunization',
    fields: [
      code('vaccine', 'Vaccine', 'ips-vaccine', { path: 'vaccineCode', required: true }),
      sel('status', 'Status', [{ code: 'completed', display: 'Completed' }, { code: 'not-done', display: 'Not done' }, { code: 'entered-in-error', display: 'Entered in error' }], { path: 'status', default: 'completed', required: true }),
      date('date', 'Date', { path: 'occurrence[x]', required: true }),
      code('targetDisease', 'Target disease', 'ips-target-disease', { path: 'protocolApplied.targetDisease', list: true }),
      text('doseNumber', 'Dose number', { path: 'protocolApplied.doseNumber[x]' }),
      code('route', 'Route', 'ips-route', { path: 'route' }),
      code('site', 'Site', 'ips-body-site', { path: 'site' }),
      text('lotNumber', 'Lot number', { path: 'lotNumber' }),
      note
    ]
  },
  {
    key: 'procedures', code: '47519-4', title: 'History of Procedures', resourceType: 'Procedure', label: 'Procedure',
    fields: [
      code('code', 'Procedure', 'ips-procedure', { path: 'code', required: true }),
      sel('status', 'Status', [{ code: 'completed', display: 'Completed' }, { code: 'in-progress', display: 'In progress' }, { code: 'not-done', display: 'Not done' }, { code: 'stopped', display: 'Stopped' }], { path: 'status', default: 'completed', required: true }),
      date('performed', 'Performed', { path: 'performed[x]' }),
      code('bodySite', 'Body site', 'ips-body-site', { path: 'bodySite', list: true }),
      code('reason', 'Reason', 'ips-procedure-reason', { path: 'reasonCode', list: true }),
      code('outcome', 'Outcome', 'ips-procedure-outcome', { path: 'outcome' }),
      note
    ]
  },
  {
    key: 'devices', code: '46264-8', title: 'Medical Devices', resourceType: 'DeviceUseStatement', label: 'Device',
    fields: [
      text('device', 'Device', { path: '$device.deviceName.name', required: true }),
      text('deviceType', 'Type', { path: '$device.type', as: 'codeable', placeholder: 'as text' }),
      sel('status', 'Status', [{ code: 'active', display: 'Active' }, { code: 'completed', display: 'Completed' }, { code: 'intended', display: 'Intended' }, { code: 'stopped', display: 'Stopped' }], { path: 'status', default: 'active', required: true }),
      date('start', 'From', { path: 'timingPeriod.start' }),
      date('end', 'Until', { path: 'timingPeriod.end' }),
      code('bodySite', 'Body site', 'ips-body-site', { path: 'bodySite' }),
      note
    ]
  },
  {
    key: 'results', code: '30954-2', title: 'Results', resourceType: 'Observation', label: 'Result',
    fields: [
      code('code', 'Test', 'ips-observation-code', { path: 'code', required: true }),
      { name: 'value', label: 'Value', type: 'quantity', path: 'value[x]' },
      text('valueText', 'Value (text)', { path: 'value[x]', placeholder: 'when the result is not a number' }),
      code('interpretation', 'Interpretation', 'ips-observation-interpretation', { path: 'interpretation', list: true }),
      date('date', 'Date', { path: 'effective[x]' }),
      text('referenceRange', 'Reference range', { path: 'referenceRange.text' }),
      note
    ],
    fixed: { status: 'final', category: [{ coding: [{ system: THO + 'observation-category', code: 'laboratory', display: 'Laboratory' }] }] }
  },
  {
    key: 'vitals', code: '8716-3', title: 'Vital Signs', resourceType: 'Observation', label: 'Vital sign',
    fields: [
      sel('code', 'Vital sign', [
        { code: '85354-9', display: 'Blood pressure', units: 'mm[Hg]', components: [{ code: '8480-6', display: 'Systolic blood pressure' }, { code: '8462-4', display: 'Diastolic blood pressure' }] },
        { code: '8867-4', display: 'Heart rate', units: '/min' }, { code: '9279-1', display: 'Respiratory rate', units: '/min' },
        { code: '8310-5', display: 'Body temperature', units: 'Cel' }, { code: '2708-6', display: 'Oxygen saturation', units: '%' },
        { code: '29463-7', display: 'Body weight', units: 'kg' }, { code: '8302-2', display: 'Body height', units: 'cm' },
        { code: '39156-5', display: 'Body mass index', units: 'kg/m2' }, { code: '9843-4', display: 'Head circumference', units: 'cm' }
      ], { system: LOINC, path: 'code', required: true }),
      { name: 'value', label: 'Value', type: 'quantity', path: 'value[x]', hint: 'for blood pressure, systolic' },
      { name: 'value2', label: 'Diastolic', type: 'quantity', path: '$diastolic', hint: 'blood pressure only' },
      date('date', 'Date', { path: 'effective[x]', required: true }),
      note
    ],
    fixed: { status: 'final', category: [{ coding: [{ system: THO + 'observation-category', code: 'vital-signs', display: 'Vital Signs' }] }] }
  },
  {
    key: 'pastProblems', code: '11348-0', title: 'History of Past Problems', resourceType: 'Condition', label: 'Past problem',
    fields: [
      code('code', 'Problem', 'ips-condition-code', { path: 'code', required: true }),
      sel('clinicalStatus', 'Clinical status', CLINICAL_STATUS.options, { system: CLINICAL_STATUS.system, path: 'clinicalStatus', default: 'resolved' }),
      sel('verificationStatus', 'Verification', VERIFICATION_STATUS.options, { system: VERIFICATION_STATUS.system, path: 'verificationStatus' }),
      date('onset', 'Onset', { path: 'onset[x]' }),
      date('abatement', 'Abatement', { path: 'abatement[x]' }),
      note
    ]
  },
  {
    key: 'pregnancy', code: '10162-6', title: 'Pregnancy History', resourceType: 'Observation', label: 'Pregnancy',
    fields: [
      sel('code', 'Observation', [{ code: '82810-3', display: 'Pregnancy status' }, { code: '11778-8', display: 'Estimated date of delivery' }, { code: '11636-8', display: 'Births, live (reported)' }], { system: LOINC, path: 'code', required: true }),
      sel('status', 'Pregnancy status', [{ code: '77386006', display: 'Pregnant' }, { code: '60001007', display: 'Not pregnant' }, { code: '102874004', display: 'Possible pregnancy' }], { system: SCT, path: 'value[x]', hint: 'for pregnancy status' }),
      date('valueDate', 'Date (EDD)', { path: 'value[x]', hint: 'for the estimated date of delivery' }),
      { name: 'value', label: 'Number', type: 'quantity', path: 'value[x]', hint: 'for a count' },
      date('date', 'Date', { path: 'effective[x]' }),
      note
    ],
    fixed: { status: 'final', category: [{ coding: [{ system: THO + 'observation-category', code: 'social-history', display: 'Social History' }] }] }
  },
  {
    key: 'social', code: '29762-2', title: 'Social History', resourceType: 'Observation', label: 'Social history',
    fields: [
      sel('code', 'Observation', [{ code: '72166-2', display: 'Tobacco smoking status' }, { code: '74013-4', display: 'Alcoholic drinks per week' }, { code: '11331-4', display: 'History of alcohol use' }], { system: LOINC, path: 'code', required: true }),
      sel('smoking', 'Smoking status', [{ code: '449868002', display: 'Current every day smoker' }, { code: '428041000124106', display: 'Current some day smoker' }, { code: '8517006', display: 'Ex-smoker' }, { code: '266919005', display: 'Never smoked tobacco' }, { code: '77176002', display: 'Smoker' }, { code: '266927001', display: 'Tobacco smoking consumption unknown' }], { system: SCT, path: 'value[x]', hint: 'for smoking status' }),
      { name: 'value', label: 'Amount', type: 'quantity', path: 'value[x]', hint: 'for drinks per week' },
      text('valueText', 'Value (text)', { path: 'value[x]' }),
      date('date', 'Date', { path: 'effective[x]' }),
      note
    ],
    fixed: { status: 'final', category: [{ coding: [{ system: THO + 'observation-category', code: 'social-history', display: 'Social History' }] }] }
  },
  {
    key: 'functional', code: '47420-5', title: 'Functional Status', resourceType: 'Condition', label: 'Functional status',
    fields: [
      code('code', 'Condition', 'ips-condition-code', { path: 'code', required: true }),
      sel('clinicalStatus', 'Clinical status', CLINICAL_STATUS.options, { system: CLINICAL_STATUS.system, path: 'clinicalStatus', default: 'active' }),
      date('onset', 'Onset', { path: 'onset[x]' }),
      note
    ]
  },
  {
    key: 'planOfCare', code: '18776-5', title: 'Plan of Care', resourceType: 'CarePlan', label: 'Plan',
    fields: [
      text('title', 'Title', { path: 'title', required: true }),
      { name: 'description', label: 'Description', type: 'textarea', path: 'description' },
      sel('status', 'Status', [{ code: 'active', display: 'Active' }, { code: 'draft', display: 'Draft' }, { code: 'on-hold', display: 'On hold' }, { code: 'completed', display: 'Completed' }], { path: 'status', default: 'active', required: true }),
      date('start', 'From', { path: 'period.start' }),
      date('end', 'Until', { path: 'period.end' })
    ],
    fixed: { intent: 'plan' }
  },
  {
    key: 'directives', code: '42348-3', title: 'Advance Directives', resourceType: 'Consent', label: 'Directive',
    fields: [
      text('category', 'Directive', { path: 'category', as: 'codeable', required: true, placeholder: 'e.g. Do not resuscitate' }),
      sel('status', 'Status', [{ code: 'active', display: 'Active' }, { code: 'inactive', display: 'Inactive' }, { code: 'draft', display: 'Draft' }], { path: 'status', default: 'active', required: true }),
      date('date', 'Date', { path: 'dateTime' }),
      { name: 'description', label: 'Details', type: 'textarea', path: '$narrative' }
    ],
    fixed: { scope: { coding: [{ system: THO + 'consentscope', code: 'adr', display: 'Advanced Care Directive' }] } }
  },
  {
    key: 'alerts', code: '104605-1', title: 'Alerts', resourceType: 'Flag', label: 'Alert',
    fields: [
      text('code', 'Alert', { path: 'code', as: 'codeable', required: true }),
      sel('status', 'Status', [{ code: 'active', display: 'Active' }, { code: 'inactive', display: 'Inactive' }], { path: 'status', default: 'active', required: true }),
      date('start', 'From', { path: 'period.start' }),
      date('end', 'Until', { path: 'period.end' })
    ]
  }
];

/** The schema as the browser gets it. */
function forBrowser() {
  return { header: HEADER, sections: SECTIONS, emptyReasons: EMPTY_REASONS };
}

module.exports = { HEADER, SECTIONS, EMPTY_REASONS, EMPTY_REASON_SYSTEM, VS, SCT, LOINC, forBrowser };
