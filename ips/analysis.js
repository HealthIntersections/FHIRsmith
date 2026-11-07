//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * The analysis step: a look at each resource in the document (and at the Composition
 * section by section) for the things a reader should know before trusting it - extensions
 * (with their definitions, where they can be found), modifier extensions and implicitRules,
 * records that are inactive, entered in error or of unknown status, narrative or the lack of
 * it, a subject other than the document's or a focus, dates in the future, and for a few
 * resources, things particular to them (a Patient's links, a Composition that isn't final,
 * a section's emptyReason or author). And for the document as a whole, on the Composition: how
 * it says there's nothing to report (negation) - with a section's emptyReason (the IPS
 * pattern), with entries whose codes say so, like No known allergy (the US Core pattern), or
 * not at all - and a warning when it uses both.
 *
 * It walks the same tree as the structure view (structure.js), and keeps a list of findings
 * for each resource and section, by the node's key; the analysis view shows the tree with
 * the findings under each node.
 *
 * A finding is { kind, text } - or for an extension { kind, url, path, found, title?,
 * description? } - where kind is one of
 *   ok         nothing to comment on
 *   narrative  whether there's narrative (always there; doesn't count against ok)
 *   extension  an extension (but not textLink)
 *   modifier   a modifier extension, or implicitRules (maroon)
 *   status     inactive, entered in error, unknown, or missing status (navy)
 *   subject    a subject other than the document's, or a focus (dark green)
 *   attention  a date in the future where one isn't expected, a Patient's link, a
 *              Composition that isn't final, a document that uses more than one approach
 *              to negation
 *   negation   how the document does negation (on the Composition; like narrative, always
 *              there, and doesn't count against ok)
 *   note       anything else (a section's emptyReason, a section's author)
 *
 * @module ips/analysis
 */

const { structureTree, flatten, isObject, text } = require('./structure');
const { typeOf } = require('./terminology');

// the resources whose status (or lifecycleStatus) is required, as the element that holds it
const STATUS_ELEMENTS = {
  Observation: 'status', DiagnosticReport: 'status', MedicationStatement: 'status', MedicationUsage: 'status', MedicationRequest: 'status',
  MedicationAdministration: 'status', MedicationDispense: 'status', Immunization: 'status', Procedure: 'status', CarePlan: 'status',
  ClinicalImpression: 'status', Flag: 'status', Consent: 'status', Encounter: 'status', DeviceUseStatement: 'status', DeviceUsage: 'status',
  Composition: 'status', Goal: 'lifecycleStatus', ServiceRequest: 'status', ImagingStudy: 'status', FamilyMemberHistory: 'status',
  RiskAssessment: 'status', DocumentReference: 'status', QuestionnaireResponse: 'status', NutritionOrder: 'status', ImmunizationRecommendation: null
};

// extensions not worth mentioning
const IGNORED_EXTENSIONS = new Set(['http://hl7.org/fhir/StructureDefinition/textLink']);

// ---- dates in the future ----
//
// Only elements the (R4) type model says are dates (date, dateTime, instant) are looked at,
// so a string or an identifier that happens to look like a date isn't one. Some dates are
// about the future by their nature, wherever they are; some resources are about the future
// - always, or while their status says the thing hasn't happened yet.

// the statuses of a request (or plan) that is over: its dates should be past
const CLOSED = new Set(['completed', 'revoked', 'cancelled', 'entered-in-error', 'stopped', 'failed', 'rejected']);
const open = (r) => !CLOSED.has(r.status);

// resources whose dates may be in the future, by type: a function of the resource that says
// whether they may (for that resource as it is)
const FUTURE_INTENT = {
  // about the future, whatever their status
  Appointment: () => true,
  AppointmentResponse: () => true,
  ImmunizationRecommendation: () => true,
  Schedule: () => true,
  Slot: () => true,
  // requests and plans, until they are over
  ServiceRequest: open,
  MedicationRequest: open,
  DeviceRequest: open,
  NutritionOrder: open,
  CommunicationRequest: open,
  SupplyRequest: open,
  VisionPrescription: open,
  CarePlan: open,
  Task: open,
  Goal: (r) => !CLOSED.has(r.lifecycleStatus),
  // events, while they are still to come
  Procedure: (r) => r.status === 'preparation',
  Encounter: (r) => r.status === 'planned',
  MedicationStatement: (r) => r.status === 'intended',
  MedicationUsage: (r) => r.status === 'intended',
  DeviceUseStatement: (r) => r.status === 'intended',
  DeviceUsage: (r) => r.status === 'intended'
};

/** Whether a resource's dates may be in the future. */
function mayBeFuture(r) {
  const f = FUTURE_INTENT[r.resourceType];
  return !!f && f(r);
}

// dates that are about the future by their nature, wherever they are: the end of a period
// (a name, an address, an identifier valid until; a prescription's validity), an expiry,
// a due date. By element name, or by the type they are in (a Timing is a schedule)
const FUTURE_ELEMENTS = new Set(['end', 'expirationDate', 'dueDate']);
const FUTURE_TYPES = new Set(['Timing']);
const DATE_TYPES = new Set(['date', 'dateTime', 'instant']);

const DATE_VALUE = /^(\d{4})(?:-(\d\d)(?:-(\d\d)(?:T(\d\d):(\d\d)(?::(\d\d)(?:\.\d+)?)?(Z|[+-]\d\d:\d\d)?)?)?)?$/;

/** The earliest moment a date/dateTime/instant can mean, as ms, or null if it isn't one. */
function earliest(v) {
  const m = DATE_VALUE.exec(v);
  if (!m) {
    return null;
  }
  const [, y, mo, d, h, mi, sec, tz] = m;
  if (h && tz) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  // no time zone: the earliest it could be anywhere (UTC+14)
  return Date.UTC(+y, mo ? +mo - 1 : 0, d ? +d : 1, h ? +h : 0, mi ? +mi : 0, sec ? +sec : 0) - 14 * 3600000;
}

/**
 * Walk a resource (or a section), calling visit(key, value, path) for every property, at
 * any depth, but not into contained resources (they are nodes of their own) nor into the
 * keys skipped. path is FHIRPath-like, from prefix; a primitive's extensions (_birthDate)
 * are at the primitive's path.
 */
function walk(node, prefix, skip, visit) {
  const go = (v, path) => {
    if (Array.isArray(v)) {
      v.forEach((x, i) => go(x, `${path}[${i}]`));
    } else if (isObject(v)) {
      for (const [k, x] of Object.entries(v)) {
        if (k === 'contained' || (path === prefix && skip.includes(k))) {
          continue;
        }
        const name = k.startsWith('_') ? k.substring(1) : k;
        visit(k, x, path, `${path}.${name}`);
        go(x, `${path}.${name}`);
      }
    }
  };
  go(node, prefix);
}

/** The extensions and modifier extensions on a resource or section, as [kind, url, path]. */
function extensionsIn(node, prefix, skip) {
  const out = [];
  walk(node, prefix, skip, (k, v, at) => {
    if ((k === 'extension' || k === 'modifierExtension') && Array.isArray(v)) {
      for (const ext of v) {
        // an extension's own parts (relative urls) are part of it, not extensions of their own
        if (isObject(ext) && text(ext.url) && /^[a-z][a-z0-9+.-]*:/i.test(ext.url) && !IGNORED_EXTENSIONS.has(ext.url)) {
          out.push([k === 'modifierExtension' ? 'modifier' : 'extension', ext.url, at]);
        }
      }
    }
  });
  return out;
}

/**
 * The dates after now in a resource or section, as [path, value]: the elements whose type is
 * date, dateTime or instant, walking the resource with the type model - but not those about
 * the future by their nature (FUTURE_ELEMENTS, FUTURE_TYPES), nor inside extensions (what
 * their dates mean isn't known), nor elements the model doesn't know.
 * @param {Object} node - the resource, or a section
 * @param {string} modelPath - the model's path for node: the resource type, or Composition.section
 * @param {string} prefix - the path shown for node
 * @param {string[]} skip - keys of node not to look in (a Composition's sections)
 * @param {number} now - in ms
 */
function futureDates(node, modelPath, prefix, skip, now) {
  const out = [];
  const go = (obj, model, shown, top) => {
    for (const [k, v] of Object.entries(obj)) {
      if (v === null || k === 'resourceType' || k === 'contained' || k === 'extension' || k === 'modifierExtension' ||
        k.startsWith('_') || (top && skip.includes(k)) || FUTURE_ELEMENTS.has(k)) {
        continue;
      }
      const resolved = typeOf(`${model}.${k}`);
      if (!resolved || FUTURE_TYPES.has(resolved.type)) {
        continue;
      }
      const items = Array.isArray(v) ? v : [v];
      items.forEach((item, i) => {
        const path = `${shown}.${k}${Array.isArray(v) ? `[${i}]` : ''}`;
        if (DATE_TYPES.has(resolved.type)) {
          const t = typeof item === 'string' ? earliest(item) : null;
          if (t !== null && t > now) {
            out.push([path, item]);
          }
        } else if (isObject(item)) {
          if (resolved.type === 'BackboneElement' || resolved.type === 'Element') {
            go(item, resolved.path, path, false);
          } else if (/^[A-Z]/.test(resolved.type) && !['Resource', 'Narrative', 'Extension'].includes(resolved.type)) {
            // a datatype: its own elements are defined on the type
            go(item, resolved.type, path, false);
          }
        }
      });
    }
  };
  go(node, modelPath, prefix, true);
  return out;
}

/** A CodeableConcept or Coding's code is one of codes. */
const hasCode = (cc, codes) => (Array.isArray(cc?.coding) ? cc.coding : []).some(c => isObject(c) && codes.includes(c.code));

/** A CodeableConcept, as words. */
function conceptWords(cc) {
  if (!isObject(cc)) {
    return '';
  }
  const codings = Array.isArray(cc.coding) ? cc.coding.filter(isObject) : [];
  return text(cc.text) || text(codings.find(c => text(c.display))?.display) || text(codings[0]?.code) || '';
}

/** A Reference, as words. */
function referenceWords(ref) {
  if (!isObject(ref)) {
    return '';
  }
  const id = isObject(ref.identifier) ? [text(ref.identifier.system), text(ref.identifier.value)].filter(Boolean).join('|') : '';
  return [text(ref.reference) || id, text(ref.display) ? `"${ref.display}"` : ''].filter(Boolean).join(' ') || '(empty reference)';
}

/**
 * Whether two references are to the same thing: they resolve to the same resource in the
 * document, or are the same string, or have the same identifier (system and value).
 */
function sameReference(a, fromA, b, fromB, resolve) {
  if (text(a.reference) && text(b.reference)) {
    const ta = resolve(fromA, a.reference);
    const tb = resolve(fromB, b.reference);
    if (ta && tb) {
      return ta.key === tb.key;
    }
    if (a.reference === b.reference) {
      return true;
    }
  }
  const ia = a.identifier;
  const ib = b.identifier;
  return isObject(ia) && isObject(ib) && text(ia.value) !== '' && ia.system === ib.system && ia.value === ib.value;
}

/** The findings common to resources and sections: extensions, narrative, focus, future dates. */
async function common(findings, thing, modelPath, prefix, skip, options, cache) {
  for (const [kind, url, path] of extensionsIn(thing, prefix, skip)) {
    if (!cache.has(url)) {
      let def = null;
      if (options.lookupExtension) {
        try {
          def = await options.lookupExtension(url);
        } catch (e) {
          def = null;
        }
      }
      cache.set(url, def);
    }
    const def = cache.get(url);
    findings.push({ kind, url, path, found: !!def, ...(def ? { title: text(def.title) || text(def.name), description: text(def.description) } : {}) });
  }
  const focus = Array.isArray(thing.focus) ? thing.focus.filter(isObject) : isObject(thing.focus) ? [thing.focus] : [];
  if (focus.length) {
    findings.push({ kind: 'subject', text: `Has a focus: ${focus.map(referenceWords).join(', ')}` });
  }
  if (!mayBeFuture(thing)) {
    for (const [path, v] of futureDates(thing, modelPath, prefix, skip, options.now)) {
      findings.push({ kind: 'attention', text: `A date in the future: ${path} = ${v}` });
    }
  }
}

/** The narrative finding. */
function narrativeOf(thing) {
  const div = text(thing.text?.div);
  return div ? { kind: 'narrative', text: `Has narrative${text(thing.text.status) ? ` (${thing.text.status})` : ''}` } : { kind: 'narrative', text: 'No narrative' };
}

/** What to say about a resource (the Composition without its sections). */
async function analyseResource(node, ctx) {
  const r = node.resource;
  const type = r.resourceType;
  const prefix = type || 'Resource';
  const skip = node.kind === 'root' ? ['section'] : [];
  const findings = [];
  if (text(r.implicitRules)) {
    findings.push({ kind: 'modifier', text: `implicitRules: ${r.implicitRules}` });
  }
  // status: inactive, entered in error, unknown, or missing
  if (r.active === false) {
    findings.push({ kind: 'status', text: 'Not active (active = false)' });
  }
  const statusElement = Object.prototype.hasOwnProperty.call(STATUS_ELEMENTS, type) ? STATUS_ELEMENTS[type] : 'status';
  const status = statusElement ? r[statusElement] : undefined;
  if (status === 'entered-in-error') {
    findings.push({ kind: 'status', text: `Entered in error (${statusElement} = entered-in-error)` });
  } else if (status === 'unknown') {
    findings.push({ kind: 'status', text: `Status unknown (${statusElement} = unknown)` });
  } else if (status === undefined && statusElement && STATUS_ELEMENTS[type]) {
    findings.push({ kind: 'status', text: `No ${statusElement} (a ${type} should have one)` });
  }
  if ((type === 'Condition' || type === 'AllergyIntolerance') && hasCode(r.verificationStatus, ['entered-in-error'])) {
    findings.push({ kind: 'status', text: 'Entered in error (verificationStatus = entered-in-error)' });
  }
  if (type === 'Composition' && text(status) && status !== 'final' && status !== 'entered-in-error' && status !== 'unknown') {
    findings.push({ kind: 'attention', text: `The Composition's status is ${status}, not final` });
  }
  // the subject: is it the document's?
  if (node.kind !== 'root') {
    const subject = isObject(r.subject) ? r.subject : isObject(r.patient) ? r.patient : null;
    const docSubject = ctx.comp.subject;
    if (subject && isObject(docSubject) && !sameReference(subject, node.entry, docSubject, ctx.rootEntry, ctx.resolve)) {
      findings.push({ kind: 'subject', text: `The subject (${referenceWords(subject)}) is not the document's subject (${referenceWords(docSubject)})` });
    }
  }
  if (type === 'Patient') {
    for (const link of Array.isArray(r.link) ? r.link.filter(isObject) : []) {
      const target = isObject(link.other) && text(link.other.reference) ? ctx.resolve(node.entry, link.other.reference) : null;
      findings.push({ kind: 'attention', text: `Linked${text(link.type) ? ` (${link.type})` : ''} to ${referenceWords(link.other)}${target ? '' : ' - not in the document'}` });
    }
  }
  await common(findings, r, type || 'Resource', prefix, skip, ctx.options, ctx.cache);
  return finish(findings, narrativeOf(r));
}

/** What to say about a section. */
async function analyseSection(node, ctx) {
  const sec = node.section;
  const findings = [];
  if (isObject(sec.emptyReason)) {
    findings.push({ kind: 'note', text: `Empty: ${conceptWords(sec.emptyReason) || '(no reason given)'}` });
  }
  const own = Array.isArray(sec.author) ? sec.author.filter(isObject) : [];
  if (own.length) {
    const parent = node.parentAuthors || [];
    const same = own.length === parent.length && own.every(a => parent.some(b => sameReference(a, ctx.rootEntry, b, ctx.rootEntry, ctx.resolve)));
    if (!same) {
      findings.push({ kind: 'note', text: `The author (${own.map(referenceWords).join(', ')}) is not ${node.nested ? 'the containing section\'s' : 'the Composition\'s'}` +
        (parent.length ? ` (${parent.map(referenceWords).join(', ')})` : ' (none)') });
    }
  }
  await common(findings, sec, 'Composition.section', 'section', ['section'], ctx.options, ctx.cache);
  return finish(findings, narrativeOf(sec));
}

// ---- saying there's nothing to report ----
//
// There are two ways: the section is empty, and its emptyReason says why (nilknown - nothing
// known - or notasked / unavailable - no information), which is the IPS pattern; or the
// section has an entry whose code says so (No known allergy; No information about allergies),
// which is the US Core pattern. Either is fine, but a document that uses both makes the
// reader (and a program) look for it in two places.

// the emptyReasons that say there's nothing to report (not withheld, closed or not started)
const NOTHING_REASONS = new Set(['nilknown', 'notasked', 'unavailable']);
// the IPS absent-unknown codes: no-known-* (a negation) and no-*-info (no information)
const IPS_ABSENT_UNKNOWN = 'http://hl7.org/fhir/uv/ips/CodeSystem/absent-unknown-uv-ips';
const SCT = 'http://snomed.info/sct';
// SNOMED CT codes that say there's nothing to report: the US Core refutation codes (No known
// allergy, ...drug, environmental, food, latex and insect allergy), No current problems or
// disability, and Patient not asked
const SCT_NOTHING = new Set(['716186003', '409137002', '428607008', '429625007', '716184000', '1003774007', '160245001', '1631000175102']);
// where a resource's code that would say so is
const CODE_ELEMENTS = ['code', 'medicationCodeableConcept', 'vaccineCode'];

/** The coding in a resource that says there's nothing to report, if there is one. */
function nothingCoding(r) {
  for (const e of CODE_ELEMENTS) {
    for (const c of Array.isArray(r[e]?.coding) ? r[e].coding.filter(isObject) : []) {
      if ((c.system === IPS_ABSENT_UNKNOWN && text(c.code)) || (c.system === SCT && SCT_NOTHING.has(c.code))) {
        return c;
      }
    }
  }
  return null;
}

/** A section node's title, as plain text. */
const sectionTitle = (node) => text(node.section.title) ? node.section.title : text(node.section.code?.text) ? node.section.code.text :
  (Array.isArray(node.section.code?.coding) && node.section.code.coding.find(c => text(c?.display))?.display) || node.path;

/**
 * How the document does negation: a finding - kind negation for none, or one approach, and
 * attention for more than one.
 * @param {Object} top - the structure tree
 */
function negationOf(top) {
  const reasons = [];
  const codes = [];
  const sectionOf = new Map();
  for (const [node, , parent] of flatten(top)) {
    const section = node.kind === 'section' ? node : parent ? sectionOf.get(parent) : null;
    sectionOf.set(node, section);
    if (node.kind === 'section') {
      const reason = (Array.isArray(node.section.emptyReason?.coding) ? node.section.emptyReason.coding : []).find(c => isObject(c) && NOTHING_REASONS.has(c.code));
      if (reason) {
        reasons.push(`${sectionTitle(node)}: ${conceptWords(node.section.emptyReason)}`);
      }
    } else if (node.kind === 'resource' && section && isObject(node.resource)) {
      const c = nothingCoding(node.resource);
      if (c) {
        codes.push(`${sectionTitle(section)}: ${text(c.display) || c.code}`);
      }
    }
  }
  const byReason = `section emptyReason (${reasons.join('; ')})`;
  const byCode = `codes in entries (${[...new Set(codes)].join('; ')})`;
  if (reasons.length && codes.length) {
    return { kind: 'attention', text: `Negation: more than one approach - ${byReason}, and ${byCode}. A document should use one approach throughout` };
  }
  if (reasons.length || codes.length) {
    return { kind: 'negation', text: `Negation: ${reasons.length ? byReason : byCode}` };
  }
  return { kind: 'negation', text: 'Negation: none observed' };
}

/** All OK when there's nothing but the narrative to say; the narrative last. */
function finish(findings, narrative) {
  return findings.length === 0 ? [{ kind: 'ok', text: 'All OK' }, narrative] : [...findings, narrative];
}

/**
 * Analyse a document.
 * @param {Object} bundle - the document
 * @param {{lookupExtension?: Function, now?: number}} options - lookupExtension(url) -> a
 *   definition ({title, name, description}) or null, perhaps async; now in ms
 * @returns {Promise<{items: Object, counts: Object}|null>} the findings by node key, or
 *   null when the document has no Composition
 */
async function analyseDocument(bundle, options = {}) {
  const top = structureTree(bundle);
  if (!top) {
    return null;
  }
  const ctx = {
    options: { ...options, now: typeof options.now === 'number' ? options.now : Date.now() },
    cache: new Map(), comp: top.resource, rootEntry: top.entry, resolve: top.resolve
  };
  const items = {};
  const counts = { nodes: 0, ok: 0, extensions: 0, notFound: 0 };
  for (const [node] of flatten(top)) {
    if (node.kind !== 'root' && node.kind !== 'resource' && node.kind !== 'section') {
      continue;
    }
    const findings = node.kind === 'section' ? await analyseSection(node, ctx) : await analyseResource(node, ctx);
    items[node.key] = findings;
    counts.nodes++;
    for (const f of findings) {
      if (f.kind === 'ok') {
        counts.ok++;
      } else if (f.url) {
        counts.extensions++;
        if (!f.found) {
          counts.notFound++;
        }
      }
    }
  }
  // the document as a whole, on the Composition, before its narrative
  const negation = negationOf(top);
  const findings = items[top.key];
  if (negation.kind === 'attention' && findings[0].kind === 'ok') {
    findings.shift();
    counts.ok--;
  }
  findings.splice(findings.length - 1, 0, negation);
  return { items, counts };
}

/**
 * The analysis step: the document as submitted (the master - it runs first, before anything
 * adorns the analysed copy) is analysed, and the findings kept as the step's result.
 */
const analysisStep = {
  name: 'analysis',
  async run(row, project, module) {
    const started = Date.now();
    const lookupExtension = typeof module.lookupExtension === 'function' ? (url) => module.lookupExtension(url) : null;
    const out = await analyseDocument(row.bundle, { lookupExtension });
    if (!out) {
      throw new Error('The document has no Composition');
    }
    module.store.saveResult(row.id, 'analysis', { ms: Date.now() - started, ...out });
    const { nodes, ok, extensions } = out.counts;
    return `analysis: ${nodes - ok} of ${nodes} resources and sections with something to note` +
      (extensions ? `, ${extensions} extension${extensions === 1 ? '' : 's'}` : '');
  }
};

module.exports = { analyseDocument, analysisStep, extensionsIn, futureDates, mayBeFuture, earliest, STATUS_ELEMENTS, FUTURE_INTENT };
