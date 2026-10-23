//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * The composer: between what the IPS editor holds (a model - the patient, the document's
 * header, and each section's mode and rows, as editor-schema.js describes them) and a FHIR
 * document Bundle. `build` makes the document from a model, checking the model as it goes;
 * `modelOf` reads a document back into a model, as far as the form can hold it, so an
 * existing document can be edited.
 *
 * The model:
 *   { patient: { family, given, gender, birthDate, identifierSystem, identifier, phone, email, address },
 *     document: { title, author, authorType, custodian, date },
 *     sections: { <key>: { mode: 'data' | 'narrative' | 'empty' | 'omit', emptyReason, narrative, rows: [ { <field>: value, <sub>: [ {...} ] } ] } } }
 * A code value is { system, code, display, text }; a quantity is { value, unit }; a select
 * is its code; a list field holds an array of those.
 *
 * @module ips/composer
 */

const crypto = require('crypto');
const escape = require('escape-html');
const parse5 = require('parse5');
const { HEADER, SECTIONS, EMPTY_REASONS, EMPTY_REASON_SYSTEM, LOINC } = require('./editor-schema');
const { Presenter } = require('./presenter');

const UCUM = 'http://unitsofmeasure.org';
const XHTML = 'http://www.w3.org/1999/xhtml';
const COMPOSITION_TYPE = { coding: [{ system: LOINC, code: '60591-5', display: 'Patient summary Document' }] };
const MAX_ROWS = 200;
const MAX_TEXT = 4000;
const MAX_NARRATIVE = 20000;
// the elements that repeat, when a path goes through them
const ARRAYS = new Set(['protocolApplied', 'dosage', 'referenceRange', 'category', 'note', 'bodySite', 'reasonCode', 'interpretation', 'manifestation', 'reaction', 'component', 'targetDisease', 'deviceName']);

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

const uuid = () => `urn:uuid:${crypto.randomUUID()}`;

// ---- values -------------------------------------------------------------------------------

/** A code value from the form as a CodeableConcept, or null when it is empty. */
function codeableOf(v) {
  if (typeof v === 'string') {
    return str(v) ? { text: str(v) } : null;
  }
  if (!isObject(v)) {
    return null;
  }
  const cc = {};
  if (str(v.system) && str(v.code)) {
    const coding = { system: str(v.system), code: str(v.code) };
    if (str(v.display)) {
      coding.display = str(v.display);
    }
    cc.coding = [coding];
  }
  if (str(v.text)) {
    cc.text = str(v.text);
  } else if (!cc.coding && str(v.display)) {
    cc.text = str(v.display);
  }
  return cc.coding || cc.text ? cc : null;
}

function quantityOf(v) {
  if (!isObject(v)) {
    return null;
  }
  const n = typeof v.value === 'number' ? v.value : (str(v.value) ? Number(v.value) : NaN);
  if (!Number.isFinite(n)) {
    return null;
  }
  const q = { value: n };
  if (str(v.unit)) {
    q.unit = str(v.unit);
    q.system = UCUM;
    q.code = str(v.unit);
  }
  return q;
}

/** The value of a field, as FHIR: null when there is nothing. */
function fhirValue(field, v) {
  switch (field.type) {
    case 'code': return codeableOf(v);
    case 'quantity': return quantityOf(v);
    case 'select': {
      const c = str(v);
      if (!c) {
        return null;
      }
      const opt = (field.options || []).find(o => o.code === c);
      if (!opt) {
        return undefined; // not one of the options
      }
      return field.system ? { coding: [{ system: field.system, code: opt.code, display: opt.display }] } : opt.code;
    }
    case 'date': {
      const d = str(v);
      if (!d) {
        return null;
      }
      return /^\d{4}(-\d\d(-\d\d)?)?$/.test(d) ? d : undefined;
    }
    default: {
      const t = str(v);
      if (!t) {
        return null;
      }
      return field.as === 'codeable' ? { text: t } : t;
    }
  }
}

/** The name a choice element takes for a field's type: onset[x] + date -> onsetDateTime. */
function choiceName(base, field, value) {
  if (field.type === 'quantity') {
    return base + 'Quantity';
  }
  if (field.type === 'date') {
    return base + 'DateTime';
  }
  if (field.type === 'code' || (field.type === 'select' && field.system)) {
    return base + 'CodeableConcept';
  }
  return base + (typeof value === 'object' ? 'CodeableConcept' : 'String');
}

/**
 * The choice types a field reads back (the reverse of choiceName), so that fields sharing a
 * value[x] each read only their own: a text field a valueString, not the valueCodeableConcept
 * a code field made. A date reads any (dateTime, Period, ...); null for any.
 */
function choiceTypes(field) {
  if (!field || field.type === 'date') {
    return null;
  }
  if (field.type === 'quantity') {
    return ['Quantity'];
  }
  if (field.type === 'code' || (field.type === 'select' && field.system)) {
    return ['CodeableConcept'];
  }
  if (field.type === 'text' || field.type === 'textarea' || field.type === 'select') {
    return ['String'];
  }
  return null;
}

// path parts that would reach an object's prototype rather than a property of its own
const UNSAFE_PARTS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * The parts of a path. The paths are the schema's own (editor-schema.js), never a
 * request's; even so, a part that would reach a prototype is refused.
 */
function pathParts(path) {
  const parts = String(path).split('.');
  if (parts.some(p => UNSAFE_PARTS.has(p) || UNSAFE_PARTS.has(p.replace(/\[x\]$/, '')))) {
    throw new Error(`The path '${path}' is not one a resource can have`);
  }
  return parts;
}

/** Put a value at a path in a resource: a.b nests, an array element takes its first member. */
function setPath(resource, path, value, field) {
  const parts = pathParts(path);
  let node = resource;
  for (let i = 0; i < parts.length; i++) {
    let name = parts[i];
    const last = i === parts.length - 1;
    if (name.endsWith('[x]')) {
      name = choiceName(name.substring(0, name.length - 3), field, value);
    }
    if (last) {
      if (field.list || ARRAYS.has(name) && !['protocolApplied', 'dosage', 'referenceRange', 'reaction', 'component', 'deviceName'].includes(name)) {
        const list = Array.isArray(value) ? value : [value];
        node[name] = (node[name] || []).concat(list);
      } else {
        node[name] = value;
      }
      return;
    }
    if (ARRAYS.has(name)) {
      if (!Array.isArray(node[name]) || node[name].length === 0) {
        node[name] = [{}];
      }
      node = node[name][0];
    } else {
      if (!isObject(node[name])) {
        node[name] = {};
      }
      node = node[name];
    }
  }
}

/** Read a value at a path: the reverse of setPath, taking first members of arrays. */
function getPath(resource, path, field) {
  const parts = pathParts(path);
  let node = resource;
  for (let i = 0; i < parts.length; i++) {
    if (!isObject(node)) {
      return undefined;
    }
    let name = parts[i];
    if (name.endsWith('[x]')) {
      const base = name.substring(0, name.length - 3);
      const types = i === parts.length - 1 ? choiceTypes(field) : null;
      name = Object.keys(node).find(k => k.startsWith(base) && k.length > base.length && /^[A-Z]/.test(k[base.length]) &&
        (!types || types.includes(k.substring(base.length))));
      if (!name) {
        return undefined;
      }
    }
    let v = node[name];
    if (Array.isArray(v) && !(i === parts.length - 1 && field?.list)) {
      v = v[0];
    }
    if (i === parts.length - 1) {
      return v;
    }
    node = v;
  }
  return undefined;
}

/** A form value from FHIR: the reverse of fhirValue. */
function formValue(field, v) {
  if (v === undefined || v === null) {
    return undefined;
  }
  const one = (x) => {
    switch (field.type) {
      case 'code': {
        if (typeof x === 'string') {
          return { text: x };
        }
        if (!isObject(x)) {
          return undefined;
        }
        const c = (Array.isArray(x.coding) ? x.coding : []).find(isObject) || {};
        const out = { system: str(c.system), code: str(c.code), display: str(c.display), text: str(x.text) };
        return out.code || out.text ? out : undefined;
      }
      case 'quantity': return isObject(x) && typeof x.value === 'number' ? { value: x.value, unit: str(x.unit) || str(x.code) } : undefined;
      case 'select': {
        const c = typeof x === 'string' ? x : (isObject(x) ? str((Array.isArray(x.coding) ? x.coding : []).find(isObject)?.code) : '');
        return (field.options || []).some(o => o.code === c) ? c : undefined;
      }
      case 'date': return typeof x === 'string' && /^\d{4}(-\d\d(-\d\d)?)?/.test(x) ? x.substring(0, 10) : undefined;
      default: {
        if (typeof x === 'string') {
          return x;
        }
        if (isObject(x)) {
          return str(x.text) || str((Array.isArray(x.coding) ? x.coding : []).find(isObject)?.display) || undefined;
        }
        if (Array.isArray(x)) {
          return x.map(n => (isObject(n) ? str(n.text) : str(n))).filter(Boolean).join('\n') || undefined;
        }
        return undefined;
      }
    }
  };
  if (field.list) {
    const list = (Array.isArray(v) ? v : [v]).map(one).filter(x => x !== undefined);
    return list.length ? list : undefined;
  }
  return one(Array.isArray(v) ? v[0] : v);
}

// ---- building -------------------------------------------------------------------------------

/**
 * Build the document.
 * @param {Object} model
 * @param {{now?: Date}} [options]
 * @returns {Promise<{bundle: Object|null, problems: string[]}>} the document, or the problems with the model
 */
async function build(model, options = {}) {
  const problems = [];
  if (!isObject(model)) {
    return { bundle: null, problems: ['The model must be an object'] };
  }
  const now = options.now || new Date();
  const patientIn = isObject(model.patient) ? model.patient : {};
  const docIn = isObject(model.document) ? model.document : {};
  const sectionsIn = isObject(model.sections) ? model.sections : {};
  const bad = (what) => problems.push(what);

  // the people and organizations
  const patient = { resourceType: 'Patient', id: crypto.randomUUID() };
  const family = str(patientIn.family);
  if (!family) {
    bad('The patient needs a family name');
  }
  const name = { family };
  const given = str(patientIn.given);
  if (given) {
    name.given = given.split(/\s+/).filter(Boolean);
  }
  patient.name = [name];
  const gender = fhirValue(HEADER.patient.find(f => f.name === 'gender'), patientIn.gender);
  if (gender === undefined) {
    bad('The patient\'s gender is not one of the choices');
  } else if (gender) {
    patient.gender = gender;
  }
  const birthDate = fhirValue(HEADER.patient.find(f => f.name === 'birthDate'), patientIn.birthDate);
  if (birthDate === undefined) {
    bad('The patient\'s date of birth is not a date (YYYY, YYYY-MM or YYYY-MM-DD)');
  } else if (birthDate) {
    patient.birthDate = birthDate;
  }
  if (str(patientIn.identifier)) {
    patient.identifier = [{ value: str(patientIn.identifier).substring(0, 200), ...(str(patientIn.identifierSystem) ? { system: str(patientIn.identifierSystem).substring(0, 500) } : {}) }];
  }
  const telecom = [];
  if (str(patientIn.phone)) {
    telecom.push({ system: 'phone', value: str(patientIn.phone).substring(0, 100) });
  }
  if (str(patientIn.email)) {
    telecom.push({ system: 'email', value: str(patientIn.email).substring(0, 200) });
  }
  if (telecom.length) {
    patient.telecom = telecom;
  }
  if (str(patientIn.address)) {
    patient.address = [{ text: str(patientIn.address).substring(0, 500) }];
  }
  const authorName = str(docIn.author).substring(0, 200);
  if (!authorName) {
    bad('The document needs an author');
  }
  const authorType = docIn.authorType === 'Organization' ? 'Organization' : 'Practitioner';
  const author = authorType === 'Organization'
    ? { resourceType: 'Organization', id: crypto.randomUUID(), name: authorName }
    : { resourceType: 'Practitioner', id: crypto.randomUUID(), name: [{ text: authorName }] };
  const custodian = str(docIn.custodian) ? { resourceType: 'Organization', id: crypto.randomUUID(), name: str(docIn.custodian).substring(0, 200) } : null;
  const date = str(docIn.date) ? fhirValue({ type: 'date' }, docIn.date) : now.toISOString();
  if (date === undefined) {
    bad('The document\'s date is not a date');
  }

  const entries = [];
  const add = (resource) => {
    const fullUrl = uuid();
    entries.push({ fullUrl, resource });
    return fullUrl;
  };
  const composition = {
    resourceType: 'Composition', id: crypto.randomUUID(), status: 'final', type: COMPOSITION_TYPE, date: date || now.toISOString(),
    title: str(docIn.title).substring(0, 200) || `Patient Summary as of ${(date || now.toISOString()).substring(0, 10)}`,
    section: []
  };
  add(composition);
  const patientUrl = add(patient);
  const authorUrl = add(author);
  composition.subject = { reference: patientUrl, display: [given, family].filter(Boolean).join(' ') };
  composition.author = [{ reference: authorUrl, display: authorName }];
  if (custodian) {
    composition.custodian = { reference: add(custodian), display: custodian.name };
  }

  // the sections
  const userNarratives = new Map();
  for (const def of SECTIONS) {
    const s = isObject(sectionsIn[def.key]) ? sectionsIn[def.key] : null;
    const mode = s && ['data', 'narrative', 'empty', 'omit'].includes(s.mode) ? s.mode : (s && Array.isArray(s.rows) && s.rows.length ? 'data' : 'omit');
    if (mode === 'omit') {
      if (def.required) {
        bad(`The ${def.title} section is required: enter its entries, a narrative, or why it is empty`);
      }
      continue;
    }
    const section = { title: def.title, code: { coding: [{ system: LOINC, code: def.code, display: def.title }] } };
    composition.section.push(section);
    if (mode === 'empty') {
      const reason = EMPTY_REASONS.find(r => r.code === str(s.emptyReason));
      if (!reason) {
        bad(`The ${def.title} section needs a reason for being empty`);
        continue;
      }
      section.emptyReason = { coding: [{ system: EMPTY_REASON_SYSTEM, code: reason.code, display: reason.display }] };
      continue;
    }
    if (mode === 'narrative') {
      const narrative = str(s.narrative);
      if (!narrative) {
        bad(`The ${def.title} section's narrative is empty`);
        continue;
      }
      if (narrative.length > MAX_NARRATIVE) {
        bad(`The ${def.title} section's narrative is too long (${MAX_NARRATIVE} characters at most)`);
        continue;
      }
      userNarratives.set(section, narrative);
      continue;
    }
    const rows = Array.isArray(s.rows) ? s.rows.filter(isObject) : [];
    if (rows.length === 0) {
      bad(`The ${def.title} section has no entries: add some, or choose a narrative or a reason for being empty`);
      continue;
    }
    if (rows.length > MAX_ROWS) {
      bad(`The ${def.title} section has too many entries (${MAX_ROWS} at most)`);
      continue;
    }
    section.entry = [];
    rows.forEach((row, i) => {
      const where = `${def.title}, entry ${i + 1}`;
      const built = buildRow(def, row, where, patientUrl, bad);
      if (!built) {
        return;
      }
      entries.push(...built.extras);
      section.entry.push({ reference: add(built.resource) });
    });
  }
  if (problems.length > 0) {
    return { bundle: null, problems };
  }

  const bundle = {
    resourceType: 'Bundle',
    identifier: { system: 'urn:ietf:rfc:3986', value: uuid() },
    type: 'document',
    timestamp: now.toISOString(),
    entry: entries
  };
  // the narratives: the presenter's for the header and the data sections, the user's for theirs
  const presenter = new Presenter();
  const out = await presenter.render(bundle);
  composition.text = { status: 'generated', div: out.header };
  for (const sec of out.sections) {
    sec.section.text = userNarratives.has(sec.section)
      ? { status: 'additional', div: narrativeDiv(userNarratives.get(sec.section)) }
      : { status: 'generated', div: sec.html };
  }
  return { bundle, problems: [] };
}

/** A user's narrative as xhtml: paragraphs at blank lines, everything escaped. */
function narrativeDiv(text) {
  const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
  return `<div xmlns="${XHTML}">${paragraphs.map(p => `<p>${escape(p).replace(/\n/g, '<br/>')}</p>`).join('')}</div>`;
}

/**
 * One row of a section as its resource (and any companion resource - a Device for a
 * DeviceUseStatement).
 */
function buildRow(def, row, where, patientUrl, bad) {
  const resource = { resourceType: def.resourceType, id: crypto.randomUUID() };
  const extras = [];
  let ok = true;
  let device = null;
  let diastolic = null;
  const fail = (m) => {
    bad(`${where}: ${m}`);
    ok = false;
  };
  const apply = (target, field, raw, label) => {
    if (raw === undefined || raw === null || raw === '' || (Array.isArray(raw) && raw.length === 0)) {
      if (field.required) {
        fail(`${label} is required`);
      }
      return;
    }
    const values = field.list ? (Array.isArray(raw) ? raw : [raw]) : [raw];
    const out = [];
    for (const v of values) {
      if (typeof v === 'string' && v.length > MAX_TEXT) {
        fail(`${label} is too long`);
        return;
      }
      const fv = fhirValue(field, v);
      if (fv === undefined) {
        fail(`${label} is not valid`);
        return;
      }
      if (fv !== null) {
        out.push(fv);
      }
    }
    if (out.length === 0) {
      if (field.required) {
        fail(`${label} is required`);
      }
      return;
    }
    if (field.path === '$diastolic') {
      diastolic = out[0];
      return;
    }
    if (field.path.startsWith('$device.')) {
      device = device || { resourceType: 'Device', id: crypto.randomUUID() };
      setPath(device, field.path.substring('$device.'.length), out[0], field);
      if (field.path === '$device.deviceName.name') {
        device.deviceName[0].type = 'user-friendly-name';
      }
      return;
    }
    if (field.path === '$narrative') {
      target.text = { status: 'additional', div: narrativeDiv(out[0]) };
      return;
    }
    if (field.name === 'note') {
      target.note = [{ text: out[0] }];
      return;
    }
    // a choice element takes one type: a second field for the same value[x] (a quantity
    // and a text, say) would make two values, which FHIR doesn't allow
    if (field.path.endsWith('[x]') && !field.path.includes('.')) {
      const base = field.path.substring(0, field.path.length - 3);
      const taken = Object.keys(target).find(k => k.startsWith(base) && k.length > base.length && /^[A-Z]/.test(k[base.length]));
      if (taken) {
        fail(`${label}: only one of the ${base} fields can be filled in (${taken} already is)`);
        return;
      }
    }
    setPath(target, field.path, field.list ? out : out[0], field);
  };
  for (const field of def.fields) {
    apply(resource, field, row[field.name], field.label);
  }
  for (const sub of def.subs || []) {
    const items = Array.isArray(row[sub.name]) ? row[sub.name].filter(isObject) : [];
    if (items.length > MAX_ROWS) {
      fail(`too many ${sub.label.toLowerCase()}`);
      continue;
    }
    const built = [];
    for (const item of items) {
      const part = {};
      for (const field of sub.fields) {
        apply(part, field, item[field.name], `${sub.label}: ${field.label}`);
      }
      if (Object.keys(part).length > 0) {
        built.push(part);
      }
    }
    if (built.length > 0) {
      resource[sub.path] = built;
    }
  }
  if (!ok) {
    return null;
  }
  // what every resource of the type carries
  for (const [k, v] of Object.entries(def.fixed || {})) {
    if (resource[k] === undefined) {
      resource[k] = structuredClone(v);
    }
  }
  // the patient
  const subjectField = { Condition: 'subject', AllergyIntolerance: 'patient', MedicationStatement: 'subject', Immunization: 'patient', Procedure: 'subject', DeviceUseStatement: 'subject', Observation: 'subject', CarePlan: 'subject', Consent: 'patient', Flag: 'subject' }[def.resourceType];
  if (subjectField) {
    resource[subjectField] = { reference: patientUrl };
  }
  // a blood pressure: the two values as components, no value of its own
  if (def.key === 'vitals') {
    const option = def.fields[0].options.find(o => o.code === row.code);
    if (option && option.components) {
      const systolic = resource.valueQuantity;
      delete resource.valueQuantity;
      if (!systolic || !diastolic) {
        fail('a blood pressure needs both the systolic and the diastolic value');
        return null;
      }
      resource.component = [
        { code: { coding: [{ system: LOINC, ...option.components[0] }] }, valueQuantity: systolic },
        { code: { coding: [{ system: LOINC, ...option.components[1] }] }, valueQuantity: diastolic }
      ];
    } else if (!resource.valueQuantity) {
      fail('a value is required');
      return null;
    } else if (diastolic) {
      fail('only a blood pressure has a diastolic value');
      return null;
    }
    if (option && option.units && resource.valueQuantity && !resource.valueQuantity.unit) {
      resource.valueQuantity.unit = option.units;
      resource.valueQuantity.system = UCUM;
      resource.valueQuantity.code = option.units;
    }
    for (const c of resource.component || []) {
      if (!c.valueQuantity.unit) {
        c.valueQuantity.unit = option.units;
        c.valueQuantity.system = UCUM;
        c.valueQuantity.code = option.units;
      }
    }
  }
  if (def.resourceType === 'Observation' && !resource.valueQuantity && !resource.valueString && !resource.valueCodeableConcept && !resource.valueDateTime && !resource.component && !resource.dataAbsentReason) {
    fail('a value is required');
    return null;
  }
  if (device) {
    const deviceUrl = uuid();
    extras.push({ fullUrl: deviceUrl, resource: device });
    resource.device = { reference: deviceUrl, display: device.deviceName?.[0]?.name };
  }
  return { resource, extras };
}

// ---- reading a document back ------------------------------------------------------------------

/**
 * A model from a document, as far as the form can hold it (what it cannot - other
 * resource types, elements the form has no field for - is not carried; a section with
 * entries the form cannot represent becomes a narrative section with the document's own).
 */
function modelOf(bundle) {
  const entries = Array.isArray(bundle?.entry) ? bundle.entry.filter(isObject) : [];
  const byRef = new Map();
  for (const e of entries) {
    if (isObject(e.resource)) {
      if (typeof e.fullUrl === 'string') {
        byRef.set(e.fullUrl, e.resource);
      }
      if (typeof e.resource.id === 'string') {
        byRef.set(`${e.resource.resourceType}/${e.resource.id}`, e.resource);
      }
    }
  }
  const resolve = (ref) => (isObject(ref) && typeof ref.reference === 'string' ? byRef.get(ref.reference) || null : null);
  const composition = entries[0]?.resource?.resourceType === 'Composition' ? entries[0].resource : null;
  const model = { patient: {}, document: {}, sections: {} };
  const patient = resolve(composition?.subject) || entries.map(e => e.resource).find(r => r?.resourceType === 'Patient') || null;
  if (patient) {
    const name = (Array.isArray(patient.name) ? patient.name : []).find(n => isObject(n) && n.use === 'official') || (Array.isArray(patient.name) ? patient.name : []).find(isObject) || {};
    model.patient.family = str(name.family) || str(name.text);
    model.patient.given = (Array.isArray(name.given) ? name.given : []).map(str).filter(Boolean).join(' ');
    model.patient.gender = str(patient.gender);
    model.patient.birthDate = str(patient.birthDate);
    const id = (Array.isArray(patient.identifier) ? patient.identifier : []).find(isObject);
    if (id) {
      model.patient.identifier = str(id.value);
      model.patient.identifierSystem = str(id.system);
    }
    for (const t of Array.isArray(patient.telecom) ? patient.telecom : []) {
      if (isObject(t) && t.system === 'phone' && !model.patient.phone) {
        model.patient.phone = str(t.value);
      }
      if (isObject(t) && t.system === 'email' && !model.patient.email) {
        model.patient.email = str(t.value);
      }
    }
    const a = (Array.isArray(patient.address) ? patient.address : []).find(isObject);
    if (a) {
      model.patient.address = str(a.text) || [...(Array.isArray(a.line) ? a.line : []), a.city, a.state, a.postalCode, a.country].map(str).filter(Boolean).join(', ');
    }
  }
  if (composition) {
    model.document.title = str(composition.title);
    model.document.date = str(composition.date).substring(0, 10);
    const authorRef = (Array.isArray(composition.author) ? composition.author : []).find(isObject);
    const author = resolve(authorRef);
    if (author?.resourceType === 'Organization') {
      model.document.authorType = 'Organization';
      model.document.author = str(author.name);
    } else if (author) {
      model.document.authorType = 'Practitioner';
      const n = (Array.isArray(author.name) ? author.name : []).find(isObject) || {};
      model.document.author = str(n.text) || [...(Array.isArray(n.given) ? n.given : []), n.family].map(str).filter(Boolean).join(' ');
    } else if (authorRef) {
      model.document.author = str(authorRef.display);
    }
    const custodian = resolve(composition.custodian);
    model.document.custodian = custodian ? str(custodian.name) : str(composition.custodian?.display);
  }
  const sections = Array.isArray(composition?.section) ? composition.section.filter(isObject) : [];
  for (const def of SECTIONS) {
    const section = sections.find(s => (Array.isArray(s.code?.coding) ? s.code.coding : []).some(c => isObject(c) && c.code === def.code));
    if (!section) {
      continue;
    }
    const out = { mode: 'omit' };
    model.sections[def.key] = out;
    const refs = Array.isArray(section.entry) ? section.entry : [];
    if (refs.length > 0) {
      const rows = [];
      let unheld = false;
      for (const ref of refs) {
        const r = resolve(ref);
        if (!r || r.resourceType !== def.resourceType) {
          unheld = true;
          continue;
        }
        rows.push(rowOf(def, r, resolve));
      }
      if (rows.length > 0) {
        out.mode = 'data';
        out.rows = rows;
        out.partial = unheld;
        continue;
      }
    }
    const reason = (Array.isArray(section.emptyReason?.coding) ? section.emptyReason.coding : []).find(isObject);
    if (reason && EMPTY_REASONS.some(e => e.code === reason.code)) {
      out.mode = 'empty';
      out.emptyReason = reason.code;
      continue;
    }
    const div = str(section.text?.div);
    if (div) {
      out.mode = 'narrative';
      out.narrative = textOf(div);
    }
  }
  return model;
}

/** One resource as a row of its section. */
function rowOf(def, resource, resolve) {
  const row = {};
  const device = def.key === 'devices' ? resolve(resource.device) : null;
  for (const field of def.fields) {
    let v;
    if (field.path === '$diastolic') {
      const c = (Array.isArray(resource.component) ? resource.component : []).find(x => (Array.isArray(x?.code?.coding) ? x.code.coding : []).some(k => k?.code === '8462-4'));
      v = c ? formValue(field, c.valueQuantity) : undefined;
    } else if (field.path.startsWith('$device.')) {
      v = device ? formValue(field, getPath(device, field.path.substring('$device.'.length), field)) : undefined;
    } else if (field.path === '$narrative') {
      v = str(resource.text?.div) ? textOf(resource.text.div) : undefined;
    } else if (field.name === 'note') {
      v = (Array.isArray(resource.note) ? resource.note : []).map(n => str(n?.text)).filter(Boolean).join('\n') || undefined;
    } else if (def.key === 'vitals' && field.name === 'value' && Array.isArray(resource.component)) {
      const c = resource.component.find(x => (Array.isArray(x?.code?.coding) ? x.code.coding : []).some(k => k?.code === '8480-6'));
      v = c ? formValue(field, c.valueQuantity) : formValue(field, getPath(resource, field.path, field));
    } else {
      v = formValue(field, getPath(resource, field.path, field));
    }
    if (v !== undefined) {
      row[field.name] = v;
    }
  }
  for (const sub of def.subs || []) {
    const items = Array.isArray(resource[sub.path]) ? resource[sub.path].filter(isObject) : [];
    if (items.length) {
      row[sub.name] = items.map(item => {
        const part = {};
        for (const field of sub.fields) {
          const v = formValue(field, getPath(item, field.path, field));
          if (v !== undefined) {
            part[field.name] = v;
          }
        }
        return part;
      });
    }
  }
  return row;
}

// elements whose end is a line break in the text, and those whose content isn't text
const BLOCKS = new Set(['p', 'div', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'table', 'ul', 'ol', 'dl', 'dt', 'dd', 'pre', 'blockquote']);
const NOT_TEXT = new Set(['script', 'style', 'template', 'head', 'title']);

/**
 * The text of a narrative, for the editor's narrative box: what a reader sees, with block
 * ends and <br/> as line breaks. From a parse (parse5), not by stripping tags: the result
 * is plain text - characters such as < are themselves - and is only ever used as text
 * (a textarea's value; narrativeDiv() escapes it on the way back).
 */
function textOf(div) {
  const out = [];
  const walk = (node) => {
    for (const child of node.childNodes || []) {
      if (child.nodeName === '#text') {
        out.push(child.value);
      } else if (child.nodeName === 'br') {
        out.push('\n');
      } else if (child.tagName && !NOT_TEXT.has(child.tagName)) {
        walk(child.content || child);
        if (child.tagName === 'p') {
          out.push('\n\n');
        } else if (BLOCKS.has(child.tagName)) {
          out.push('\n');
        } else if (child.tagName === 'td' || child.tagName === 'th') {
          out.push(' ');
        }
      }
    }
  };
  walk(parse5.parseFragment(String(div)));
  // lines, with a blank line where a paragraph ended (as narrativeDiv() reads them back)
  return out.join('').split('\n').map(l => l.replace(/\s+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
}

module.exports = { build, modelOf, fhirValue, formValue, setPath, getPath, narrativeDiv, textOf, MAX_ROWS, MAX_TEXT, MAX_NARRATIVE };
