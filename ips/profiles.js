//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * Clinical profiles: what a clinical document is expected to contain, as a profile on
 * Bundle (the document) whose root element carries the expectations as constraints - each
 * a human description and a FHIRPath expression on the document, most of them in one of
 * three shapes:
 *
 *   Bundle.section(system, code [, min, max]).exists()
 *   Bundle.section(system, code [, min, max]).entry(system, code [, min, max]).exists()
 *   Bundle.section(system, code [, min, max]).entryIn(valueSet [, min, max]).exists()
 *   Bundle.resources(system, code [, type]).{the rest of the rule}
 *   Bundle.resourcesIn(valueSet [, type]).{the rest of the rule}
 *
 * (section(), entry() and resources() are the module's own functions: fhirpath-ips.js;
 * section() on a document looks in its Composition). An expression in one of the first two
 * shapes is edited as a row of a table - the section's code and cardinality, the entry's
 * code and cardinality; one in the third as a row of another - the type, system and code,
 * and the rest of the rule; anything else as FHIRPath.
 *
 * The StructureDefinition's id ('profile-' + a random id), its url ([base]/StructureDefinition/{id}),
 * its name (derived from the title) and the constraints' keys are the server's: the
 * administrator edits the title and the constraints. An uploaded StructureDefinition must
 * be no more than that - a profile on Bundle with constraints on its root element - or it
 * is rejected; its id, url and keys are reassigned. Profiles made when they were on
 * Composition are moved onto Bundle (migrate()).
 *
 * @module ips/profiles
 */

const crypto = require('crypto');
const fhirpath = require('fhirpath');
const r4Model = require('fhirpath/fhir-context/r4');
const { ipsFunctions } = require('./fhirpath-ips');
const { SECTIONS, LOINC } = require('./editor-schema');

const BUNDLE = 'http://hl7.org/fhir/StructureDefinition/Bundle';
const OLD_BASE = 'http://hl7.org/fhir/StructureDefinition/Composition';
const MAX_TITLE = 200;
const MAX_HUMAN = 1000;
const MAX_EXPRESSION = 2000;
const MAX_CONSTRAINTS = 200;
const KEY_RE = /^cp-([1-9][0-9]{0,5})$/;
const ID_RE = /^[a-f0-9]{12}$/;

/** The code systems the editor offers for an entry's code (any other can be given by url). */
const SYSTEMS = [
  { url: 'http://snomed.info/sct', name: 'SNOMED CT' },
  { url: 'http://loinc.org', name: 'LOINC' },
  { url: 'http://hl7.org/fhir/sid/icd-10', name: 'ICD-10' },
  { url: 'http://id.who.int/icd/release/11/mms', name: 'ICD-11 MMS' },
  { url: 'http://www.whocc.no/atc', name: 'ATC' },
  { url: 'http://standardterms.edqm.eu', name: 'EDQM Standard Terms' },
  { url: 'http://www.nlm.nih.gov/research/umls/rxnorm', name: 'RxNorm' },
  { url: 'http://hl7.org/fhir/sid/cvx', name: 'CVX' },
  { url: 'http://unitsofmeasure.org', name: 'UCUM' }
];

/** The IPS sections, for the editor's shortcuts and the read-only view. */
const IPS_SECTIONS = SECTIONS.map(s => ({ code: s.code, title: s.title }));

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ---- the two shapes ----

const STR = "'((?:[^'\\\\]|\\\\.)*)'";
const ARGS = `\\s*${STR}\\s*,\\s*${STR}\\s*(?:,\\s*(\\d{1,6})\\s*,\\s*(?:(\\d{1,6})|'\\*')\\s*)?`;
const CARD = `(?:,\\s*(\\d{1,6})\\s*,\\s*(?:(\\d{1,6})|'\\*')\\s*)?`;
// the entry part: entry(system, code [, min, max]) or entryIn(valueSet [, min, max])
const SHAPE_RE = new RegExp(`^\\s*Bundle\\s*\\.\\s*section\\s*\\(${ARGS}\\)\\s*(?:\\.\\s*(?:entry\\s*\\(${ARGS}\\)|entryIn\\s*\\(\\s*${STR}\\s*${CARD}\\))\\s*)?\\.\\s*exists\\s*\\(\\s*\\)\\s*$`);
// a value set's canonical, as entryIn() and resourcesIn() take it
const CANONICAL_RE = /^[a-z][a-z0-9+.-]*:[^\s|]{1,250}(\|[^\s|]{1,64})?$/i;

// a FHIRPath string's escapes: \' \" \` \\ \/ \f \n \r \t and \uXXXX
const ESCAPES = { n: '\n', r: '\r', t: '\t', f: '\f' };
function unquote(s) {
  return s.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (m, c) => (c.length === 5 ? String.fromCharCode(parseInt(c.substring(1), 16)) : (ESCAPES[c] || c)));
}

function quote(s) {
  return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

function card(min, max, hasCard) {
  return { min: hasCard ? parseInt(min, 10) : null, max: hasCard ? (max === undefined ? '*' : parseInt(max, 10)) : null };
}

function part(system, code, min, max, hasCard) {
  return { system: unquote(system), code: unquote(code), ...card(min, max, hasCard) };
}

/**
 * The parts of an expression in one of the two shapes, or null.
 * @returns {{section: {system, code, min, max}, entry: {system, code, min, max}|{valueSet, min, max}|null}|null}
 *   min and max are null for no bounds; max is a number or '*'; an entry has a system and
 *   code, or a value set
 */
function parseShape(expression) {
  if (typeof expression !== 'string' || expression.length > MAX_EXPRESSION) {
    return null;
  }
  const m = SHAPE_RE.exec(expression);
  if (!m) {
    return null;
  }
  const section = part(m[1], m[2], m[3], m[4], m[3] !== undefined);
  let entry = null;
  if (m[5] !== undefined) {
    entry = part(m[5], m[6], m[7], m[8], m[7] !== undefined);
  } else if (m[9] !== undefined) {
    entry = { valueSet: unquote(m[9]), ...card(m[10], m[11], m[10] !== undefined) };
    if (!CANONICAL_RE.test(entry.valueSet)) {
      return null;
    }
  }
  for (const p of [section, entry].filter(Boolean)) {
    if ((p.valueSet === undefined && (!p.system || !p.code)) || (p.min !== null && p.max !== '*' && p.max < p.min)) {
      return null;
    }
  }
  return { section, entry };
}

const TYPE = `(?:,\\s*'([A-Z][A-Za-z]{1,63})'\\s*)?`;
const REST = '(\\.\\s*\\S[\\s\\S]*?)';
const RSHAPE_RE = new RegExp(`^\\s*Bundle\\s*\\.\\s*resources\\s*\\(\\s*${STR}\\s*,\\s*${STR}\\s*${TYPE}\\)\\s*${REST}\\s*$`);
const RSHAPE_IN_RE = new RegExp(`^\\s*Bundle\\s*\\.\\s*resourcesIn\\s*\\(\\s*${STR}\\s*${TYPE}\\)\\s*${REST}\\s*$`);

/**
 * The parts of a rule about resources, or null.
 * @returns {{type: string|null, system: string, code: string, rest: string}|{type: string|null, valueSet: string, rest: string}|null}
 *   rest starts with '.'
 */
function parseResourceShape(expression) {
  if (typeof expression !== 'string' || expression.length > MAX_EXPRESSION) {
    return null;
  }
  let m = RSHAPE_RE.exec(expression);
  if (m) {
    const r = { type: m[3] || null, system: unquote(m[1]), code: unquote(m[2]), rest: m[4] };
    return r.system && r.code ? r : null;
  }
  m = RSHAPE_IN_RE.exec(expression);
  if (m) {
    const r = { type: m[2] || null, valueSet: unquote(m[1]), rest: m[3] };
    return CANONICAL_RE.test(r.valueSet) ? r : null;
  }
  return null;
}

/** The expression for a rule about resources. */
function resourceShapeExpression(r) {
  const rest = String(r.rest || '').trim();
  const type = r.type ? `, ${quote(r.type)}` : '';
  const head = r.valueSet !== undefined ? `Bundle.resourcesIn(${quote(r.valueSet)}${type})` : `Bundle.resources(${quote(r.system)}, ${quote(r.code)}${type})`;
  return head + (rest.startsWith('.') ? rest : '.' + rest);
}

/** Which part of the editor an expression belongs in: 'section', 'resource' or 'other'. */
function kindOf(expression) {
  return parseShape(expression) ? 'section' : (parseResourceShape(expression) ? 'resource' : 'other');
}

function cardArgs(p) {
  return p.min !== null && p.min !== undefined ? `, ${p.min}, ${p.max === '*' ? "'*'" : p.max}` : '';
}

function args(p) {
  return `${quote(p.system)}, ${quote(p.code)}` + cardArgs(p);
}

/** The expression for a shape. */
function shapeExpression(shape) {
  const e = shape.entry;
  const entry = !e ? '' : (e.valueSet !== undefined ? `.entryIn(${quote(e.valueSet)}${cardArgs(e)})` : `.entry(${args(e)})`);
  return `Bundle.section(${args(shape.section)})` + entry + '.exists()';
}

/** A cardinality as written: '' for none, else 'min..max'. */
function cardText(p) {
  return p.min === null || p.min === undefined ? '' : `${p.min}..${p.max}`;
}

/** 'min..max' (max a number or *), or blank: {min, max} (nulls for blank), or null when it isn't one. */
function parseCard(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { min: null, max: null };
  }
  const m = /^\s*(\d{1,6})\s*\.\.\s*(\d{1,6}|\*)\s*$/.exec(text);
  if (!m) {
    return null;
  }
  const min = parseInt(m[1], 10);
  const max = m[2] === '*' ? '*' : parseInt(m[2], 10);
  return max !== '*' && max < min ? null : { min, max };
}

// ---- checking ----

/** A problem with an expression (it doesn't parse, or fails on an empty document), or null. */
function expressionProblem(expression) {
  if (typeof expression !== 'string' || !expression.trim()) {
    return 'has no FHIRPath expression';
  }
  if (expression.length > MAX_EXPRESSION) {
    return `has a FHIRPath expression longer than ${MAX_EXPRESSION} characters`;
  }
  const userInvocationTable = ipsFunctions();
  // fhirpath.js only warns (and returns nothing) when a function has the wrong number of
  // arguments: the trial run is synchronous, so its warnings are caught here
  const warnings = [];
  const warn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  try {
    const compiled = fhirpath.compile(expression, r4Model, { userInvocationTable });
    // a trial run on a document with nothing in it finds unknown functions and the like
    void compiled({ resourceType: 'Bundle', type: 'document', entry: [{ fullUrl: 'urn:uuid:c', resource: { resourceType: 'Composition', status: 'final', section: [] } }] });
  } catch (e) {
    return `has a FHIRPath expression that can't be used: ${String(e.message || e).split('\n')[0].substring(0, 200)}`;
  } finally {
    console.warn = warn;
  }
  const arity = warnings.find(w => /wrong arity/.test(w));
  return arity ? `has a FHIRPath expression that can't be used: ${arity.replace(/ wrong arity: got (\d+)/, '() has the wrong number of arguments ($1)')}` : null;
}

/** A name (an identifier, as FHIR wants StructureDefinition.name) from a title. */
function nameFromTitle(title) {
  const words = String(title || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  let name = words.map(w => w.charAt(0).toUpperCase() + w.substring(1)).join('');
  if (!/^[A-Z]/.test(name)) {
    name = 'Profile' + name;
  }
  return name.substring(0, 255);
}

/** A new private id. */
function newId() {
  return crypto.randomBytes(6).toString('hex');
}

/**
 * Check what the editor (or an upload) gives - a title and constraints - and give each
 * constraint its key: a key it already has in the profile it replaces is kept, the others
 * get new ones.
 *
 * @param {{title: *, constraints: *}} input
 * @param {Object|null} previous - the StructureDefinition being replaced
 * @returns {{title: string, constraints: Array<{key, human, expression}>, problems: string[]}}
 */
function checkInput(input, previous = null) {
  const problems = [];
  const title = typeof input?.title === 'string' ? input.title.trim() : '';
  if (!title) {
    problems.push('The profile needs a title');
  } else if (title.length > MAX_TITLE) {
    problems.push(`The title is longer than ${MAX_TITLE} characters`);
  }
  const list = Array.isArray(input?.constraints) ? input.constraints : [];
  if (input?.constraints !== undefined && !Array.isArray(input.constraints)) {
    problems.push('The constraints must be a list');
  }
  if (list.length > MAX_CONSTRAINTS) {
    problems.push(`There can be no more than ${MAX_CONSTRAINTS} constraints`);
  }
  const known = new Set(constraintsOf(previous).map(c => c.key));
  let next = Math.max(0, ...[...known].map(k => parseInt(KEY_RE.exec(k)[1], 10))) + 1;
  const used = new Set();
  const constraints = [];
  list.slice(0, MAX_CONSTRAINTS).forEach((c, i) => {
    const n = i + 1;
    if (!isObject(c)) {
      problems.push(`Constraint ${n} is not an object`);
      return;
    }
    const human = typeof c.human === 'string' ? c.human.trim() : '';
    const expression = typeof c.expression === 'string' ? c.expression.trim() : '';
    if (!human) {
      problems.push(`Constraint ${n} has no description`);
    } else if (human.length > MAX_HUMAN) {
      problems.push(`Constraint ${n}'s description is longer than ${MAX_HUMAN} characters`);
    }
    const p = expressionProblem(expression);
    if (p) {
      problems.push(`Constraint ${n} ${p}`);
    }
    let key = typeof c.key === 'string' && known.has(c.key) && !used.has(c.key) ? c.key : null;
    if (!key) {
      key = `cp-${next++}`;
    }
    used.add(key);
    constraints.push({ key, human, expression });
  });
  return { title, constraints, problems };
}

/**
 * The StructureDefinition.
 * @param {{id: string, url: string, title: string, constraints: Array, date?: string}} p
 */
function build(p) {
  return {
    resourceType: 'StructureDefinition',
    id: `profile-${p.id}`,
    url: p.url,
    name: nameFromTitle(p.title),
    title: p.title,
    status: 'active',
    date: p.date || new Date().toISOString(),
    fhirVersion: '4.0.1',
    kind: 'resource',
    abstract: false,
    type: 'Bundle',
    baseDefinition: BUNDLE,
    derivation: 'constraint',
    differential: {
      element: [{
        id: 'Bundle',
        path: 'Bundle',
        constraint: p.constraints.map(c => ({ key: c.key, severity: 'error', human: c.human, expression: c.expression, source: p.url }))
      }]
    }
  };
}

/** A StructureDefinition's constraints, as the editor has them. */
function constraintsOf(sd) {
  const el = sd?.differential?.element?.[0];
  return (Array.isArray(el?.constraint) ? el.constraint : [])
    .filter(c => isObject(c) && typeof c.key === 'string' && KEY_RE.test(c.key))
    .map(c => ({ key: c.key, human: c.human || '', expression: c.expression || '' }));
}

// what an uploaded StructureDefinition may have: what build() makes, and the metadata a
// tool might add that is replaced anyway
const UPLOAD_KEYS = new Set(['resourceType', 'id', 'meta', 'text', 'url', 'version', 'name', 'title', 'status', 'date', 'publisher',
  'fhirVersion', 'kind', 'abstract', 'type', 'baseDefinition', 'derivation', 'differential']);
const ELEMENT_KEYS = new Set(['id', 'path', 'constraint']);
const CONSTRAINT_KEYS = new Set(['key', 'severity', 'human', 'expression', 'source']);

/**
 * An uploaded StructureDefinition, as the editor's input (title and constraints, the
 * keys dropped so they are assigned afresh), or the reasons it can't be taken.
 * @returns {{input: {title, constraints}|null, problems: string[]}}
 */
function fromUpload(sd) {
  const problems = [];
  if (!isObject(sd) || sd.resourceType !== 'StructureDefinition') {
    return { input: null, problems: ['That is not a StructureDefinition'] };
  }
  if (sd.type === 'Composition' && sd.baseDefinition === OLD_BASE) {
    // one downloaded when profiles were on Composition: moved onto the document
    sd = structuredClone(sd);
    sd.type = 'Bundle';
    sd.baseDefinition = BUNDLE;
    for (const el of Array.isArray(sd.differential?.element) ? sd.differential.element : []) {
      if (isObject(el) && el.path === 'Composition') {
        el.path = 'Bundle';
        if (el.id === 'Composition') {
          el.id = 'Bundle';
        }
        for (const c of Array.isArray(el.constraint) ? el.constraint : []) {
          if (isObject(c) && typeof c.expression === 'string') {
            c.expression = onDocument(c.expression);
          }
        }
      }
    }
  }
  const extra = Object.keys(sd).filter(k => !UPLOAD_KEYS.has(k));
  if (extra.length) {
    problems.push(`It has more than a clinical profile can hold: ${extra.join(', ')}`);
  }
  if (sd.type !== 'Bundle' || sd.baseDefinition !== BUNDLE || (sd.derivation !== undefined && sd.derivation !== 'constraint') ||
    (sd.kind !== undefined && sd.kind !== 'resource') || (sd.abstract !== undefined && sd.abstract !== false)) {
    problems.push(`It must be a profile on Bundle (type Bundle, baseDefinition ${BUNDLE}, derivation constraint)`);
  }
  const elements = Array.isArray(sd.differential?.element) ? sd.differential.element : null;
  if (sd.differential !== undefined && (!isObject(sd.differential) || Object.keys(sd.differential).some(k => k !== 'element'))) {
    problems.push('Its differential may only have elements');
  }
  let list = [];
  if (!elements || elements.length !== 1 || !isObject(elements[0]) || elements[0].path !== 'Bundle' ||
    (elements[0].id !== undefined && elements[0].id !== 'Bundle')) {
    problems.push('Its differential must have just one element, the root (Bundle)');
  } else {
    const el = elements[0];
    const extraEl = Object.keys(el).filter(k => !ELEMENT_KEYS.has(k));
    if (extraEl.length) {
      problems.push(`Its root element has more than constraints: ${extraEl.join(', ')}`);
    }
    if (el.constraint !== undefined && !Array.isArray(el.constraint)) {
      problems.push('Its root element\'s constraints must be a list');
    }
    list = Array.isArray(el.constraint) ? el.constraint : [];
    list.forEach((c, i) => {
      if (!isObject(c)) {
        return;
      }
      const extraC = Object.keys(c).filter(k => !CONSTRAINT_KEYS.has(k));
      if (extraC.length) {
        problems.push(`Constraint ${i + 1} has more than a key, description and expression: ${extraC.join(', ')}`);
      }
      if (c.severity !== undefined && c.severity !== 'error') {
        problems.push(`Constraint ${i + 1} is not an error (the constraints of a clinical profile are)`);
      }
    });
  }
  const title = typeof sd.title === 'string' && sd.title.trim() ? sd.title : (typeof sd.name === 'string' ? sd.name : '');
  return { input: { title, constraints: list.map(c => (isObject(c) ? { human: c.human, expression: c.expression } : c)) }, problems };
}

/**
 * The read-only description of a shaped part: which section, which code or which value
 * set, with bounds. titleOf(url) gives a value set's title, when it is known.
 */
function describePart(p, isSection, titleOf) {
  if (p.valueSet !== undefined) {
    const title = typeof titleOf === 'function' ? titleOf(p.valueSet) : null;
    return { what: title || p.valueSet, code: title ? p.valueSet : null, card: cardText(p), valueSet: true };
  }
  const named = isSection && p.system === LOINC ? IPS_SECTIONS.find(s => s.code === p.code) : null;
  const sys = SYSTEMS.find(s => s.url === p.system);
  const what = named ? named.title : `${sys ? sys.name : p.system} ${p.code}`;
  return { what, code: named ? `${sys ? sys.name : p.system} ${p.code}` : null, card: cardText(p) };
}

/**
 * An expression written for a Composition, for its document: each Composition.section(...)
 * becomes Bundle.section(...) (section() on a document looks in its Composition), and any
 * other Composition.x becomes Bundle.entry.resource.ofType(Composition).x - every one in the
 * expression, not only a leading one, and never inside a string or a `quoted` name. A path
 * that doesn't start with a type name (title.exists()) can't be told from the document's
 * own, and is left as it is.
 */
function onDocument(expression) {
  let out = '';
  let i = 0;
  const n = expression.length;
  while (i < n) {
    const ch = expression[i];
    if (ch === "'" || ch === '`') {
      // a string or a delimited name, with its escapes, as it is
      let j = i + 1;
      while (j < n && expression[j] !== ch) {
        j += expression[j] === '\\' ? 2 : 1;
      }
      out += expression.substring(i, j + 1);
      i = j + 1;
      continue;
    }
    // Composition at the start of a path: not part of a longer name, not after a dot
    const prev = i > 0 ? expression[i - 1] : '';
    if (expression.startsWith('Composition', i) && !/[A-Za-z0-9_.]/.test(prev) && !/[A-Za-z0-9_]/.test(expression[i + 11] || '')) {
      const m = /^Composition\s*\.\s*(section\s*\()?/.exec(expression.substring(i));
      if (m) {
        out += m[1] ? 'Bundle.section(' : 'Bundle.entry.resource.ofType(Composition).';
        i += m[0].length;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * A profile made when profiles were on Composition, moved onto Bundle: the same id, url,
 * title and keys, the expressions moved onto the document (onDocument).
 * @returns {Object|null} the new StructureDefinition, or null when there is nothing to do
 */
function migrate(sd) {
  if (!isObject(sd) || sd.type !== 'Composition' || sd.baseDefinition !== OLD_BASE) {
    return null;
  }
  const constraints = constraintsOf(sd).map(c => ({ ...c, expression: onDocument(c.expression) }));
  return build({ id: String(sd.id).replace(/^profile-/, ''), url: sd.url, title: sd.title || sd.name || 'Profile', constraints, date: sd.date });
}

/** The resource types the editor offers for a rule about resources (any other can be typed). */
const RESOURCE_TYPES = ['Condition', 'AllergyIntolerance', 'MedicationStatement', 'MedicationRequest', 'MedicationAdministration', 'MedicationDispense',
  'Immunization', 'Procedure', 'Observation', 'DiagnosticReport', 'AdverseEvent', 'DetectedIssue'];

/** The read-only description of a rule about resources. */
function describeResource(r, titleOf) {
  if (r.valueSet !== undefined) {
    const title = typeof titleOf === 'function' ? titleOf(r.valueSet) : null;
    return { type: r.type, valueSet: r.valueSet, title, rest: r.rest };
  }
  const sys = SYSTEMS.find(s => s.url === r.system);
  return { type: r.type, code: `${sys ? sys.name : r.system} ${r.code}`, rest: r.rest };
}

module.exports = {
  SYSTEMS, IPS_SECTIONS, RESOURCE_TYPES, BUNDLE, MAX_CONSTRAINTS, ID_RE, migrate,
  parseResourceShape, resourceShapeExpression, kindOf, describeResource,
  parseShape, shapeExpression, parseCard, cardText, expressionProblem, nameFromTitle, newId,
  checkInput, build, constraintsOf, fromUpload, describePart
};
