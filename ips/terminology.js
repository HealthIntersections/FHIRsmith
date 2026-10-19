//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * The terminology view of an IPS document: every CodeableConcept in it, in a fixed order
 * - the Composition's own, then section by section in the IPS order (whatever order the
 * sections come in), then any other sections in document order - and, within a section,
 * entry by entry, element by element.
 *
 * CodeableConcepts are found by walking each resource with the R4 type model fhirpath.js
 * ships (path -> type), so that an element is reported as a CodeableConcept because the
 * specification says it is one, not because it happens to look like one; for a resource
 * or element the model doesn't know, an object with a `coding` array is taken to be one.
 * Section codes are not reported (the section itself says what they are), nor are the
 * elements in IGNORED below.
 *
 * @module ips/terminology
 */

const r4Model = require('fhirpath/fhir-context/r4');
const { compositionOf, resolveInBundle, bundleIndex } = require('./search');
const { editionCode, editionName } = require('../tx/sct/editions');

// the IPS sections, in the order the view presents them: [LOINC code, title, words that
// identify the section by its title when the code is missing or different]
const SECTION_ORDER = [
  ['81338-6', 'Patient Story', /patient story/i],
  ['11450-4', 'Problems', /^(active )?problem/i],
  ['48765-2', 'Allergies and Intolerances', /allerg/i],
  ['10160-0', 'Medication Summary', /medication/i],
  ['11369-6', 'Immunizations', /immuni[sz]ation|vaccin/i],
  ['47519-4', 'History of Procedures', /procedure/i],
  ['11348-0', 'History of Past Problems', /past (problem|illness)|history of past/i],
  ['46264-8', 'Medical Devices', /device/i],
  ['42348-3', 'Advance Directives', /advance directive/i],
  ['104605-1', 'Alerts', /^alert/i],
  ['47420-5', 'Functional Status', /functional status/i],
  ['10162-6', 'Pregnancy History', /pregnan/i],
  ['29762-2', 'Social History', /social history/i],
  ['18776-5', 'Plan of Care', /plan of (care|treatment)|care plan/i],
  ['8716-3', 'Vital Signs', /vital sign/i],
  ['30954-2', 'Results', /^results?$|diagnostic results|relevant diagnostic/i]
];

// elements whose CodeableConcepts are not interesting: resource type + path within it
// (without indices), or *.name for an element of that name anywhere
const IGNORED = new Set([
  '*.category',
  'Composition.type',
  'Composition.event.code',
  'AllergyIntolerance.clinicalStatus',
  'AllergyIntolerance.verificationStatus',
  'Condition.clinicalStatus',
  'Condition.verificationStatus'
]);

/** Is this element (an index-free path) on the ignore list? */
function isIgnored(element) {
  return IGNORED.has(element) || IGNORED.has('*' + element.substring(element.lastIndexOf('.')));
}

// the external code systems - the big terminologies that no FHIR server holds as a
// CodeSystem resource, so there is nothing to link to - with their names for the display.
// Anything else under terminology.hl7.org or hl7.org/fhir is named by its last path segment
const SYSTEM_NAMES = {
  'http://snomed.info/sct': 'SNOMED CT',
  'http://loinc.org': 'LOINC',
  'http://www.nlm.nih.gov/research/umls/rxnorm': 'RxNorm',
  'http://unitsofmeasure.org': 'UCUM',
  'http://www.whocc.no/atc': 'ATC',
  'http://hl7.org/fhir/sid/icd-10': 'ICD-10',
  'http://hl7.org/fhir/sid/icd-10-cm': 'ICD-10-CM',
  'http://hl7.org/fhir/sid/icd-9-cm': 'ICD-9-CM',
  'http://hl7.org/fhir/sid/icd-9': 'ICD-9',
  'http://ncicb.nci.nih.gov/xml/owl/EVS/Thesaurus.owl': 'NCI Thesaurus',
  'http://id.who.int/icd/release/11/mms': 'ICD-11 MMS',
  'http://id.who.int/icd11/mms': 'ICD-11 MMS',
  'http://hl7.org/fhir/sid/cvx': 'CVX',
  'http://hl7.org/fhir/sid/ndc': 'NDC',
  'http://www.ama-assn.org/go/cpt': 'CPT',
  'http://fdasis.nlm.nih.gov': 'UNII',
  'http://www.radlex.org': 'RadLex',
  'http://dicom.nema.org/resources/ontology/DCM': 'DICOM',
  'urn:ietf:bcp:47': 'BCP 47 (language)',
  'urn:iso:std:iso:3166': 'ISO 3166 (country)',
  'urn:ietf:rfc:3986': 'URI',
  'http://unstats.un.org/unsd/methods/m49/m49.htm': 'UN M49',
  'http://standardterms.edqm.eu': 'EDQM',
  'https://www.gs1.org/gtin': 'GTIN',
  'http://www.nlm.nih.gov/research/umls': 'UMLS',
  'http://varnomen.hgvs.org': 'HGVS',
  'http://www.genenames.org': 'HGNC',
  'http://sequenceontology.org': 'Sequence Ontology',
  'http://purl.obolibrary.org/obo/hp.owl': 'HPO',
  'http://www.orpha.net': 'Orphanet'
};

/** Is this one of the external code systems (SNOMED CT, LOINC, ...)? */
function isExternalSystem(url) {
  return typeof url === 'string' && Object.prototype.hasOwnProperty.call(SYSTEM_NAMES, url);
}

/**
 * A readable name for a code system URL - DataRenderer.displaySystem, less the lookup of
 * a CodeSystem resource's title (the tx server might know one, but that's a query away).
 */
function systemName(url) {
  if (typeof url !== 'string' || url === '') {
    return '';
  }
  if (url.startsWith('http://snomed.info')) {
    return 'SNOMED CT';
  }
  if (SYSTEM_NAMES[url]) {
    return SYSTEM_NAMES[url];
  }
  const m = /^https?:\/\/(?:terminology\.hl7\.org\/CodeSystem|hl7\.org\/fhir(?:\/[a-z-]+)*)\/([^/]+)$/.exec(url);
  if (m) {
    return m[1];
  }
  return url;
}

const SCT_MONTHS = { '01': 'Jan', '02': 'Feb', '03': 'Mar', '04': 'Apr', '05': 'May', '06': 'Jun', '07': 'Jul', '08': 'Aug', '09': 'Sep', '10': 'Oct', '11': 'Nov', '12': 'Dec' };

/**
 * The edition module id in a SNOMED CT version URI (http://snomed.info/sct/[module] or
 * .../version/[date]), or a bare module id - SnomedUtilities.getEditionFromVersion, but
 * returning the id whether or not it is a known edition.
 */
function sctEdition(version) {
  if (typeof version !== 'string') {
    return null;
  }
  let v = version.startsWith('http://snomed.info/sct/') ? version.substring(23) : version;
  if (v.includes('/')) {
    v = v.substring(0, v.indexOf('/'));
  }
  return /^\d{6,18}$/.test(v) ? v : null;
}

/**
 * A short description of a code system version - DataRenderer.describeVersion. A SNOMED CT
 * version URI becomes the edition's short code (from tx/sct/editions.js) and release:
 * "US rel. Mar 2024"; anything else is returned as it is.
 *
 * @returns {{text: string, title: string|null}} title is the edition's full name, for a hover
 */
function describeVersion(version) {
  if (typeof version !== 'string' || version === '') {
    return { text: '', title: null };
  }
  if (!version.startsWith('http://snomed.info/sct')) {
    return { text: version, title: null };
  }
  const p = version.split('/');
  let ed;
  let dt = '';
  if (p.length >= 3 && p[p.length - 2] === 'version') {
    ed = p[p.length - 3];
    const date = p[p.length - 1];
    if (/^\d{8}$/.test(date)) {
      dt = ` rel. ${SCT_MONTHS[date.substring(4, 6)] || date.substring(4, 6)} ${date.substring(0, 4)}`;
    }
  } else {
    ed = p[p.length - 1];
  }
  const code = editionCode(ed);
  return { text: (code || '??') + dt, title: editionName(ed) || (ed ? `Unknown edition ${ed}` : null) };
}

/**
 * Where to read about a code system - DataRenderer.getLinkForSystem for the external
 * ones; null for anything else (the terminology server's page is the caller's business).
 */
function linkForSystem(system) {
  switch (system) {
    case 'http://snomed.info/sct': return 'https://browser.ihtsdotools.org/';
    case 'http://loinc.org': return 'https://loinc.org/';
    case 'http://unitsofmeasure.org': return 'http://ucum.org';
    case 'http://ncicb.nci.nih.gov/xml/owl/EVS/Thesaurus.owl': return 'https://ncit.nci.nih.gov/ncitbrowser/pages/home.jsf';
    default: return null;
  }
}

/**
 * Where to read about a code - DataRenderer.getLinkForCode for the external code systems
 * (SNOMED CT by SnomedUtilities.getSctLink: the edition's URI when the version names one,
 * else http://snomed.info/id/[code]; a post-coordinated expression goes to the browser);
 * null for anything else.
 */
function linkForCode(system, version, code) {
  const has = typeof code === 'string' && code !== '';
  switch (system) {
    case 'http://snomed.info/sct': {
      if (!has || code.includes(':')) {
        return 'https://browser.ihtsdotools.org/';
      }
      const ed = sctEdition(version);
      return ed && editionName(ed) ? `http://snomed.info/sct/${ed}/id/${encodeURIComponent(code)}` : `http://snomed.info/id/${encodeURIComponent(code)}`;
    }
    case 'http://loinc.org':
      return has ? `https://loinc.org/${encodeURIComponent(code)}` : 'https://loinc.org/';
    case 'http://www.nlm.nih.gov/research/umls/rxnorm':
      return has ? `https://mor.nlm.nih.gov/RxNav/search?searchBy=RXCUI&searchTerm=${encodeURIComponent(code)}` : 'https://www.nlm.nih.gov/research/umls/rxnorm/index.html';
    case 'http://ncicb.nci.nih.gov/xml/owl/EVS/Thesaurus.owl':
      return has ? `https://ncit.nci.nih.gov/ncitbrowser/ConceptReport.jsp?code=${encodeURIComponent(code)}` : 'https://ncit.nci.nih.gov/ncitbrowser/pages/home.jsf';
    case 'urn:iso:std:iso:3166':
      return has ? `https://en.wikipedia.org/wiki/ISO_3166-2:${encodeURIComponent(code)}` : 'https://en.wikipedia.org/wiki/ISO_3166-2';
    default:
      return null;
  }
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Does this look like a CodeableConcept, for when the model has nothing to say? */
function looksLikeCodeableConcept(v) {
  return isObject(v) && Array.isArray(v.coding) && v.coding.every(c => isObject(c)) &&
    Object.keys(v).every(k => ['coding', 'text', 'id', 'extension'].includes(k));
}

/**
 * The type of an element, from the model. `modelPath` is the path the model knows
 * (Type.element.element, with datatypes starting their own path); null if the model
 * doesn't know it.
 */
function typeOf(modelPath) {
  let p = modelPath;
  for (let i = 0; i < 5 && p; i++) {
    const t = r4Model.path2Type[p];
    if (t) {
      return { type: t, path: p };
    }
    // e.g. Composition.section.section is defined at Composition.section
    p = r4Model.pathsDefinedElsewhere[p];
  }
  return null;
}

/**
 * Walk a resource (or datatype) collecting its CodeableConcepts.
 *
 * @param {Object} node - the resource or element
 * @param {string} modelPath - the model's path for node (e.g. 'Observation.component')
 * @param {string} shownPath - the path shown to people (e.g. 'Observation.component[1]')
 * @param {string} resourceType - for the IGNORED check
 * @param {Array} out
 * @param {Set} skip - element names not to descend into, at this level
 */
function walk(node, modelPath, shownPath, resourceType, out, skip = null) {
  if (!isObject(node)) {
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'resourceType' || (skip && skip.has(key)) || value === null || typeof value !== 'object') {
      continue;
    }
    const resolved = typeOf(`${modelPath}.${key}`);
    const type = resolved ? resolved.type : null;
    const items = Array.isArray(value) ? value : [value];
    items.forEach((item, i) => {
      if (!isObject(item)) {
        return;
      }
      const shown = `${shownPath}.${key}${Array.isArray(value) ? `[${i}]` : ''}`;
      // the ignore list is by element path, without indices
      const plain = shown.replace(/\[\d+\]/g, '');
      if (type === 'CodeableConcept' || (type === null && looksLikeCodeableConcept(item))) {
        if (!isIgnored(plain)) {
          out.push({ path: shown, element: plain, concept: item });
        }
        return;
      }
      if (type === null) {
        // unknown to the model: keep looking inside, in case
        walk(item, `${modelPath}.${key}`, shown, resourceType, out);
      } else if (type === 'BackboneElement' || type === 'Element') {
        walk(item, resolved.path, shown, resourceType, out);
      } else if (/^[A-Z]/.test(type) && type !== 'Resource' && type !== 'Reference' && type !== 'Narrative') {
        // a datatype: its own elements are defined on the type
        walk(item, type, shown, resourceType, out);
      }
      // primitives, references and narratives have no CodeableConcepts in them
    });
  }
}

/**
 * The CodeableConcepts in one resource.
 * @param {Object} resource
 * @param {{skip?: string[]}} [options] - top-level elements to leave out
 * @returns {Array<{path: string, element: string, concept: Object}>}
 */
function conceptsOf(resource, options = {}) {
  const out = [];
  if (isObject(resource) && typeof resource.resourceType === 'string') {
    walk(resource, resource.resourceType, resource.resourceType, resource.resourceType, out, options.skip ? new Set(options.skip) : null);
  }
  return out;
}

/** Which IPS section this is, if any: its index in SECTION_ORDER, or -1. */
function sectionRank(section) {
  const codes = Array.isArray(section?.code?.coding) ? section.code.coding : [];
  for (const c of codes) {
    if (c?.system === 'http://loinc.org' || !c?.system) {
      const i = SECTION_ORDER.findIndex(s => s[0] === c?.code);
      if (i >= 0) {
        return i;
      }
    }
  }
  const title = typeof section?.title === 'string' ? section.title.trim() : '';
  if (title) {
    const i = SECTION_ORDER.findIndex(s => s[2].test(title));
    if (i >= 0) {
      return i;
    }
  }
  return -1;
}

/** A label for a resource: Type/id, or the entry's fullUrl, or just the type. */
function resourceLabel(resource, fullUrl) {
  if (!isObject(resource)) {
    return '';
  }
  if (typeof resource.id === 'string') {
    return `${resource.resourceType}/${resource.id}`;
  }
  return fullUrl ? `${resource.resourceType} (${fullUrl})` : resource.resourceType;
}

/**
 * The terminology of a document.
 *
 * @param {Object} bundle
 * @returns {{composition: Array, sections: Array<{title: string, known: boolean, entries: Array<{
 *   reference: string, label: string, resolved: boolean, concepts: Array}>}>}}
 */
function terminologyOf(bundle) {
  const comp = compositionOf(bundle);
  if (!comp) {
    return { composition: [], sections: [] };
  }
  const result = {
    composition: conceptsOf(comp, { skip: ['section'] }),
    sections: []
  };
  // sections, flattened (a nested section is its own entry in the list, after its parent)
  const flat = [];
  const collect = (secs, depth) => {
    for (const s of Array.isArray(secs) ? secs : []) {
      if (isObject(s)) {
        flat.push({ section: s, depth, order: flat.length });
        collect(s.section, depth + 1);
      }
    }
  };
  collect(comp.section, 0);
  const ranked = flat.map(f => ({ ...f, rank: sectionRank(f.section) }));
  ranked.sort((a, b) => {
    const ra = a.rank < 0 ? Number.MAX_SAFE_INTEGER : a.rank;
    const rb = b.rank < 0 ? Number.MAX_SAFE_INTEGER : b.rank;
    return ra - rb || a.order - b.order;
  });
  const fullUrls = bundleIndex(bundle).fullUrlOf;
  const fullUrlOf = (resource) => fullUrls.get(resource) || null;
  for (const { section, rank } of ranked) {
    const title = rank >= 0 ? SECTION_ORDER[rank][1] : (typeof section.title === 'string' && section.title ? section.title : '(untitled section)');
    const entries = [];
    for (const ref of Array.isArray(section.entry) ? section.entry : []) {
      const reference = typeof ref?.reference === 'string' ? ref.reference : '';
      const resource = resolveInBundle(bundle, reference);
      if (!resource) {
        entries.push({ reference, label: reference || '(no reference)', resolved: false, concepts: [] });
        continue;
      }
      entries.push({ reference, label: resourceLabel(resource, fullUrlOf(resource)), resolved: true, concepts: conceptsOf(resource) });
    }
    result.sections.push({ title, known: rank >= 0, code: section.code, entries });
  }
  return result;
}

module.exports = {
  terminologyOf, conceptsOf, systemName, describeVersion, sctEdition, linkForSystem, linkForCode, isExternalSystem, isIgnored,
  sectionRank, SECTION_ORDER, IGNORED, SYSTEM_NAMES
};
