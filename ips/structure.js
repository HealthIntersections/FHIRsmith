//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * The logical structure of an IPS document, as a tree: the Composition, then what it
 * refers to (other than its sections), then the sections, nested, each with what it refers
 * to (entries, author, focus...). Each resource referred to holds what it refers to in turn.
 * A resource is expanded once, where it is first met; met again, it is a 'seen' node. A
 * reference that doesn't resolve in the document is a 'missing' node. References resolve as
 * in a Bundle (fullUrl, absolute or relative to the referring entry's), and #id is a
 * resource contained in the referring resource (or in the resource it is contained in).
 *
 * The structure view (render.js) draws the tree as a tree table; the analysis step and view
 * (analysis.js) walk the same tree.
 *
 * @module ips/structure
 */

const escape = require('escape-html');
const { dateText, describeResource, codeText, quantityText } = require('./presenter');
const { inBundle } = require('./fhirpath-ips');

function text(v) {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * The references in a resource or a part of one, in document order, as [path, reference]:
 * every Reference with a .reference, at any depth, except under the keys skipped (the
 * Composition's sections, which are shown as sections) and contained resources (shown
 * when something refers to them).
 */
function referencesIn(node, skip = [], path = '', out = []) {
  if (Array.isArray(node)) {
    node.forEach((v, i) => referencesIn(v, [], `${path}[${i}]`, out));
  } else if (isObject(node)) {
    if (typeof node.reference === 'string') {
      out.push([path, node.reference]);
    }
    for (const [k, v] of Object.entries(node)) {
      if (k !== 'contained' && k !== 'text' && !skip.includes(k) && v !== null && typeof v === 'object') {
        referencesIn(v, [], path ? `${path}.${k}` : k, out);
      }
    }
  }
  return out;
}

// the icon for a resource, by type
const ICONS = {
  person: ['Patient', 'Practitioner', 'PractitionerRole', 'RelatedPerson', 'Person'],
  organization: ['Organization'],
  medication: ['Medication', 'MedicationStatement', 'MedicationRequest', 'MedicationAdministration', 'MedicationDispense', 'MedicationUsage', 'MedicationKnowledge'],
  audit: ['Provenance', 'AuditEvent'],
  clinical: ['AllergyIntolerance', 'Condition', 'Observation', 'Procedure', 'Immunization', 'ImmunizationRecommendation', 'DiagnosticReport',
    'DeviceUseStatement', 'DeviceUsage', 'CarePlan', 'ClinicalImpression', 'Flag', 'Consent', 'Encounter', 'ImagingStudy', 'Specimen',
    'FamilyMemberHistory', 'RiskAssessment', 'Goal', 'ServiceRequest', 'NutritionOrder', 'DocumentReference', 'QuestionnaireResponse']
};

function iconOf(type) {
  return Object.keys(ICONS).find(k => ICONS[k].includes(type)) || 'other';
}

/**
 * What a resource is: a name (a person's, an organization's...), else its code (code,
 * medication, vaccineCode...), with an Observation's value. HTML, escaped.
 */
function whatOf(r) {
  let what = describeResource(r) || codeText(r.medicationCodeableConcept) || codeText(r.medication?.concept) ||
    (text(r.medicationReference?.display) ? escape(r.medicationReference.display) : '') ||
    codeText(r.medication?.reference ? null : r.medication) ||
    (Array.isArray(r.type) ? codeText(r.type[0]) : codeText(r.type)) || codeText(r.activity) ||
    (Array.isArray(r.category) ? codeText(r.category[0]) : codeText(r.category));
  if (r.resourceType === 'Observation') {
    const value = quantityText(r.valueQuantity) || codeText(r.valueCodeableConcept) ||
      (text(r.valueString) ? escape(r.valueString) : '') || (typeof r.valueBoolean === 'boolean' ? String(r.valueBoolean) : '');
    if (value) {
      what = what ? `${what}: ${value}` : value;
    }
  }
  return what || '';
}

// where to look for when a resource happened, best first: the clinical dates, then the
// record's own
const WHEN_PATHS = [
  'onsetDateTime', 'onsetPeriod.start', 'occurrenceDateTime', 'occurrencePeriod.start', 'performedDateTime', 'performedPeriod.start',
  'effectiveDateTime', 'effectiveInstant', 'effectivePeriod.start', 'timingDateTime', 'timingPeriod.start', 'whenHandedOver', 'whenPrepared',
  'authoredOn', 'period.start', 'actualPeriod.start', 'dateTime', 'birthDate', 'recordedDate', 'recorded', 'occurredDateTime',
  'issued', 'dateAsserted', 'recordedOn', 'created', 'date', 'meta.lastUpdated'
];

/** When a resource happened: a good try, not a rule. HTML, escaped. */
function whenOf(r) {
  for (const p of WHEN_PATHS) {
    const v = p.split('.').reduce((o, k) => (isObject(o) ? o[k] : undefined), r);
    if (text(v)) {
      return dateText(v);
    }
  }
  return '';
}

/**
 * The document as a tree. Each node is
 *   { kind: 'root'|'section'|'resource'|'seen'|'missing', key, path, fullPath, icon, type, id,
 *     ref, what, when, note, open, children, resource?, section?, entry?, container? }
 * - path is where the node is in what contains it (subject, entry[0], section[1]); fullPath
 *   is the whole of it as FHIRPath from the Composition (Composition.section[0].entry[0].resolve().subject)
 * - key identifies what the node is about, the same each time the tree is made: e{n} for
 *   bundle entry n, e{n}#id for a resource contained in it, s:{fullPath} for a section
 * - resource is the resource (resource and seen nodes, and the root), section the section;
 *   entry is {key, resource, fullUrl, container} - where references in it resolve from
 * - authors (sections) are the authors that apply to the section: its own, else those of
 *   what contains it; parentAuthors are those of what contains it
 *
 * @returns {Object|null} the root, or null when the document has no Composition
 */
function structureTree(bundle) {
  const entries = Array.isArray(bundle?.entry) ? bundle.entry : [];
  const comp = entries[0]?.resource;
  if (!isObject(comp) || comp.resourceType !== 'Composition') {
    return null;
  }
  const shown = new Set(['e0']);

  function resolve(from, ref) {
    if (ref.startsWith('#')) {
      const host = from.container || from;
      if (ref === '#') {
        return host;
      }
      const list = Array.isArray(host.resource.contained) ? host.resource.contained : [];
      const i = list.findIndex(c => isObject(c) && c.id === ref.substring(1));
      return i < 0 ? null : { key: `${host.key}#${ref.substring(1)}`, resource: list[i], fullUrl: host.fullUrl, container: host };
    }
    const found = inBundle(bundle, ref, from.fullUrl);
    return found ? { key: `e${found.index}`, resource: found.resource, fullUrl: entries[found.index].fullUrl } : null;
  }

  const resourceNode = (path, fullPath, entry, extra = {}) => {
    const r = entry.resource;
    return {
      kind: 'resource', key: entry.key, path, fullPath, icon: iconOf(r.resourceType), type: r.resourceType || '?', id: text(r.id) ? r.id : '',
      what: whatOf(r), when: whenOf(r), note: '', children: [], resource: r, entry, ...extra
    };
  };

  function refNodes(from, refs, base) {
    return refs.map(([path, ref]) => {
      const fullPath = `${base}.${path}`;
      const target = resolve(from, ref);
      if (!target) {
        const m = /(?:^|\/)([A-Z][A-Za-z]+)\/([^/]+?)(?:\/_history\/[^/]+)?$/.exec(ref);
        return { kind: 'missing', key: null, path, fullPath, icon: 'external', type: m ? m[1] : '', id: m ? m[2] : '', ref, what: '', when: '', note: 'not in document', children: [] };
      }
      const contained = target.container ? 'contained' : '';
      if (shown.has(target.key)) {
        return resourceNode(path, fullPath, target, { kind: 'seen', ref, note: [contained, 'shown above'].filter(Boolean).join(', ') });
      }
      shown.add(target.key);
      const node = resourceNode(path, fullPath, target, { ref, note: contained });
      // a medication statement, request... by reference: what it is is the Medication's
      const med = target.resource.medicationReference?.reference || target.resource.medication?.reference?.reference;
      if (!node.what && typeof med === 'string') {
        const m = resolve(target, med);
        node.what = m ? whatOf(m.resource) : '';
      }
      node.children = refNodes(target, referencesIn(target.resource), `${fullPath}.resolve()`);
      return node;
    });
  }

  const rootEntry = { key: 'e0', resource: comp, fullUrl: entries[0].fullUrl };
  const authorsOf = (x) => (Array.isArray(x?.author) ? x.author.filter(isObject) : []);
  function sectionNodes(list, base, prefix, parentAuthors) {
    return (Array.isArray(list) ? list : []).map((sec, i) => [sec, i]).filter(([sec]) => isObject(sec)).map(([sec, i]) => {
      const path = `${prefix}section[${i}]`;
      const fullPath = `Composition.${path}`;
      const title = text(sec.title) ? sec.title : text(sec.code?.text) ? sec.code.text :
        (Array.isArray(sec.code?.coding) && sec.code.coding.find(c => text(c?.display))?.display) || '(untitled section)';
      const authors = authorsOf(sec).length ? authorsOf(sec) : parentAuthors;
      const children = [...refNodes(rootEntry, referencesIn(sec, ['section']), fullPath), ...sectionNodes(sec.section, fullPath, `${path}.`, authors)];
      return {
        kind: 'section', key: `s:${fullPath}`, path, fullPath, icon: 'section', type: 'Section', id: '', what: `<b>${escape(title)}</b>`, when: '',
        note: children.length ? '' : 'empty', open: true, children, section: sec, entry: rootEntry, authors, parentAuthors, nested: base !== 'Composition'
      };
    });
  }
  const top = { ...resourceNode('Composition', 'Composition', rootEntry, { open: true }), kind: 'root' };
  top.what = text(comp.title) ? escape(comp.title) : top.what;
  top.icon = 'document';
  top.children = [...refNodes(rootEntry, referencesIn(comp, ['section']), 'Composition'), ...sectionNodes(comp.section, 'Composition', '', authorsOf(comp))];
  top.resolve = resolve;
  return top;
}

/** The nodes of a tree, depth first, as [node, depth, parent]. */
function flatten(node, depth = 0, parent = null, out = []) {
  out.push([node, depth, parent]);
  for (const c of node.children) {
    flatten(c, depth + 1, node, out);
  }
  return out;
}

module.exports = { structureTree, flatten, referencesIn, whatOf, whenOf, iconOf, isObject, text };
