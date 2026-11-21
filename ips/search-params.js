//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * The search parameters the /ips module indexes, by resource: the standard R4
 * parameters for Bundle, Composition and Patient (IPS is an R4 specification), with
 * their FHIRPath expressions as the specification defines them, simplified where
 * fhirpath.js has no resolve().
 *
 * A search on a project's documents is a search on Bundle, and the Composition and
 * Patient parameters are reached by chaining: composition.date, composition.patient.name,
 * composition.subject.birthdate. Each document is indexed once, when it is received,
 * against everything here (see search.js).
 *
 * Only the types the parameters below have are implemented: string, token, date,
 * reference. Nothing in these three resources is a number or quantity.
 *
 * @module ips/search-params
 */

const BUNDLE = {
  // the Composition is always the first entry; indexed specially (search.js) because the
  // expression yields the resource, not a reference to it
  composition: { type: 'reference', expression: 'Bundle.entry[0].resource', description: 'The first resource in the bundle, the Composition' },
  identifier: { type: 'token', expression: 'Bundle.identifier', description: 'Persistent identifier for the bundle' },
  timestamp: { type: 'date', expression: 'Bundle.timestamp', description: 'When the bundle was assembled' },
  type: { type: 'token', expression: 'Bundle.type', description: 'document' }
};

const COMPOSITION = {
  attester: { type: 'reference', expression: 'Composition.attester.party', description: 'Who attested the composition' },
  author: { type: 'reference', expression: 'Composition.author', description: 'Who and/or what authored the composition' },
  category: { type: 'token', expression: 'Composition.category', description: 'Categorization of Composition' },
  confidentiality: { type: 'token', expression: 'Composition.confidentiality', description: 'As defined by affinity domain' },
  context: { type: 'token', expression: 'Composition.event.code', description: 'Code(s) that apply to the event being documented' },
  date: { type: 'date', expression: 'Composition.date', description: 'Composition editing time' },
  encounter: { type: 'reference', expression: 'Composition.encounter', description: 'Context of the Composition' },
  entry: { type: 'reference', expression: 'Composition.section.entry', description: 'A reference to data that supports this section' },
  identifier: { type: 'token', expression: 'Composition.identifier', description: 'Version-independent identifier for the Composition' },
  patient: { type: 'reference', expression: 'Composition.subject', description: 'Who and/or what the composition is about', target: 'Patient' },
  period: { type: 'date', expression: 'Composition.event.period', description: 'The period covered by the documentation' },
  section: { type: 'token', expression: 'Composition.section.code', description: 'Classification of section (recommended)' },
  status: { type: 'token', expression: 'Composition.status', description: 'preliminary | final | amended | entered-in-error' },
  subject: { type: 'reference', expression: 'Composition.subject', description: 'Who and/or what the composition is about', target: 'Patient' },
  title: { type: 'string', expression: 'Composition.title', description: 'Human Readable name/title' },
  type: { type: 'token', expression: 'Composition.type', description: 'Kind of composition (LOINC if possible)' }
};

const PATIENT = {
  active: { type: 'token', expression: 'Patient.active', description: 'Whether the patient record is active' },
  address: { type: 'string', expression: 'Patient.address', description: 'Any part of the address' },
  'address-city': { type: 'string', expression: 'Patient.address.city', description: 'A city specified in an address' },
  'address-country': { type: 'string', expression: 'Patient.address.country', description: 'A country specified in an address' },
  'address-postalcode': { type: 'string', expression: 'Patient.address.postalCode', description: 'A postal code specified in an address' },
  'address-state': { type: 'string', expression: 'Patient.address.state', description: 'A state specified in an address' },
  'address-use': { type: 'token', expression: 'Patient.address.use', description: 'A use code specified in an address' },
  birthdate: { type: 'date', expression: 'Patient.birthDate', description: "The patient's date of birth" },
  'death-date': { type: 'date', expression: '(Patient.deceased as dateTime)', description: 'The date of death has been provided and satisfies this search value' },
  deceased: { type: 'token', expression: 'Patient.deceased.exists() and Patient.deceased != false', description: 'This patient has been marked as deceased, or as a death date entered' },
  email: { type: 'token', expression: "Patient.telecom.where(system='email')", description: 'A value in an email contact' },
  family: { type: 'string', expression: 'Patient.name.family', description: 'A portion of the family name of the patient' },
  gender: { type: 'token', expression: 'Patient.gender', description: 'Gender of the patient' },
  'general-practitioner': { type: 'reference', expression: 'Patient.generalPractitioner', description: "Patient's nominated general practitioner" },
  given: { type: 'string', expression: 'Patient.name.given', description: 'A portion of the given name of the patient' },
  identifier: { type: 'token', expression: 'Patient.identifier', description: 'A patient identifier' },
  language: { type: 'token', expression: 'Patient.communication.language', description: 'Language code (irrespective of use value)' },
  name: { type: 'string', expression: 'Patient.name', description: 'Any part of the name: family, given, prefix, suffix, or text' },
  organization: { type: 'reference', expression: 'Patient.managingOrganization', description: 'The organization that is the custodian of the patient record' },
  phone: { type: 'token', expression: "Patient.telecom.where(system='phone')", description: 'A value in a phone contact' },
  telecom: { type: 'token', expression: 'Patient.telecom', description: 'The value in any kind of telecom details of the patient' }
};

const BY_RESOURCE = { Bundle: BUNDLE, Composition: COMPOSITION, Patient: PATIENT };

// the chains a search can use: the parameter name on Bundle, and what it leads to
const CHAINS = {
  composition: { resource: 'Composition', via: { patient: 'Patient', subject: 'Patient' } }
};

module.exports = { BUNDLE, COMPOSITION, PATIENT, BY_RESOURCE, CHAINS };
