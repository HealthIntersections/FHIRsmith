//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/*
 * What a document needs before the document creators (the general and patient IPS editors)
 * offer to submit, download or share it: a minimal International Patient Summary. That is a
 * document Bundle (ips.js validateDocument checks that first) whose Composition is an IPS
 * (LOINC 60591-5) with a title, date and author, about a Patient with a name, and with the
 * three sections the IPS requires - allergies, problems and medications - each with entries,
 * or saying why it is empty (emptyReason).
 */
const { compositionOf, patientOf } = require('./search');

const LOINC = 'http://loinc.org';
const IPS_CODE = '60591-5';
const REQUIRED_SECTIONS = [
  { code: '48765-2', name: 'allergies and intolerances' },
  { code: '11450-4', name: 'problems' },
  { code: '10160-0', name: 'medications' }
];

function hasLoinc(cc, code) {
  return Array.isArray(cc?.coding) && cc.coding.some(c => c && c.system === LOINC && c.code === code);
}

function hasName(patient) {
  return Array.isArray(patient?.name) && patient.name.some(n => n && ((typeof n.text === 'string' && n.text.trim()) ||
    (typeof n.family === 'string' && n.family.trim()) || (Array.isArray(n.given) && n.given.some(g => typeof g === 'string' && g.trim()))));
}

/**
 * The ways the document falls short of a minimal IPS ([] if it doesn't). Call it on a
 * document that has passed validateDocument.
 * @param {Object} bundle
 * @returns {string[]}
 */
function minimalIpsProblems(bundle) {
  const problems = [];
  const comp = compositionOf(bundle);
  if (!comp) {
    return ['The document has no Composition'];
  }
  if (!hasLoinc(comp.type, IPS_CODE)) {
    problems.push(`The Composition's type must be the IPS code (LOINC ${IPS_CODE}, Patient summary Document)`);
  }
  if (typeof comp.title !== 'string' || !comp.title.trim()) {
    problems.push('The document has no title');
  }
  if (typeof comp.date !== 'string' || !comp.date.trim()) {
    problems.push('The document has no date');
  }
  if (!Array.isArray(comp.author) || comp.author.length === 0) {
    problems.push('The document has no author');
  }
  const patient = patientOf(bundle, comp);
  if (patient && !hasName(patient)) {
    problems.push("The patient has no name");
  }
  const sections = Array.isArray(comp.section) ? comp.section : [];
  for (const req of REQUIRED_SECTIONS) {
    const s = sections.find(x => hasLoinc(x?.code, req.code));
    if (!s) {
      problems.push(`The document has no ${req.name} section (LOINC ${req.code}); the IPS requires one`);
    } else if (!(Array.isArray(s.entry) && s.entry.length > 0) && !(Array.isArray(s.emptyReason?.coding) && s.emptyReason.coding.length > 0)) {
      problems.push(`The ${req.name} section has no entries, and doesn't say why it is empty`);
    }
  }
  return problems;
}

module.exports = { minimalIpsProblems, IPS_CODE, REQUIRED_SECTIONS };
