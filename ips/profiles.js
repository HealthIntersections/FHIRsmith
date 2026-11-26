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

/**
 * The IPS sections, for the editor's shortcuts and the read-only view: the general editor's, and
 * the Patient Story (which that editor doesn't make).
 */
const IPS_SECTIONS = [...SECTIONS.map(s => ({ code: s.code, title: s.title })), { code: '81338-6', title: 'Patient Story' }];

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ---- the two shapes ----

const STR = "'((?:[^'\\\\]|\\\\.)*)'";
const ARGS = `\\s*${STR}\\s*,\\s*${STR}\\s*(?:,\\s*(\\d{1,6})\\s*,\\s*(?:(\\d{1,6})|'\\*')\\s*)?`;
const CARD = `(?:,\\s*(\\d{1,6})\\s*,\\s*(?:(\\d{1,6})|'\\*')\\s*)?`;
// a required section (and entries) rule is Bundle.section(system, code) - no bounds: a section
// with bounds is a rule of its own (other) - then the section's checks, then the entry part:
//   Bundle.section(s, c).exists()                       the section is there
//   Bundle.section(s, c).isKnown()                      one check (no entry part)
//   Bundle.section(s, c).where(isKnown() and hasData()).exists()     more than one
//   Bundle.section(s, c)[.where(checks)].entry(system, code [, min, max]).exists()
//   Bundle.section(s, c)[.where(checks)].entryIn(valueSet [, min, max]).exists()
const SECTION_HEAD_RE = new RegExp(`^\\s*Bundle\\s*\\.\\s*section\\s*\\(\\s*${STR}\\s*,\\s*${STR}\\s*\\)`);
// the section checks, in the order they are written
const SECTION_CHECKS = ['isKnown', 'hasData', 'sameSubject'];
const CHECK = '(isKnown|hasData|sameSubject)\\s*\\(\\s*\\)';
const ONE_CHECK_RE = new RegExp(`^\\s*\\.\\s*${CHECK}\\s*$`);
const WHERE_RE = new RegExp(`^\\s*\\.\\s*where\\s*\\(\\s*(${CHECK.replace(/\(isKnown/, '(?:isKnown')}(?:\\s+and\\s+${CHECK.replace(/\(isKnown/, '(?:isKnown')})*)\\s*\\)`);
const ENTRY_RE = new RegExp(`^\\s*\\.\\s*(?:entry\\s*\\(${ARGS}\\)|entryIn\\s*\\(\\s*${STR}\\s*${CARD}\\))`);
const EXISTS_RE = /^\s*\.\s*exists\s*\(\s*\)\s*$/;
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

/** The checks named in a where(): in their order, or null when one is named twice. */
function checksIn(list) {
  const names = list.split(/\s+and\s+/).map(x => x.replace(/\s*\(\s*\)\s*$/, '').trim());
  return new Set(names).size === names.length ? SECTION_CHECKS.filter(c => names.includes(c)) : null;
}

/**
 * The parts of an expression in one of the two shapes, or null.
 * @returns {{section: {system, code, checks: string[]}, entry: {system, code, min, max}|{valueSet, min, max}|null}|null}
 *   checks are isKnown, hasData, sameSubject (in that order); an entry's min and max are null
 *   for no bounds, max is a number or '*'; an entry has a system and code, or a value set
 */
function parseShape(expression) {
  if (typeof expression !== 'string' || expression.length > MAX_EXPRESSION) {
    return null;
  }
  const head = SECTION_HEAD_RE.exec(expression);
  if (!head) {
    return null;
  }
  const section = { system: unquote(head[1]), code: unquote(head[2]), checks: [] };
  if (!section.system || !section.code) {
    return null;
  }
  let rest = expression.substring(head[0].length);
  const one = ONE_CHECK_RE.exec(rest);
  if (one) {
    section.checks = [one[1]];
    return { section, entry: null };
  }
  const where = WHERE_RE.exec(rest);
  if (where) {
    const checks = checksIn(where[1]);
    if (!checks) {
      return null;
    }
    section.checks = checks;
    rest = rest.substring(where[0].length);
  }
  let entry = null;
  const m = ENTRY_RE.exec(rest);
  if (m) {
    if (m[1] !== undefined) {
      entry = part(m[1], m[2], m[3], m[4], m[3] !== undefined);
      if (!entry.system || !entry.code) {
        return null;
      }
    } else {
      entry = { valueSet: unquote(m[5]), ...card(m[6], m[7], m[6] !== undefined) };
      if (!CANONICAL_RE.test(entry.valueSet)) {
        return null;
      }
    }
    if (entry.min !== null && entry.max !== '*' && entry.max < entry.min) {
      return null;
    }
    rest = rest.substring(m[0].length);
  }
  return EXISTS_RE.test(rest) ? { section, entry } : null;
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

/**
 * The expression for a shape: one check on its own is the rule (Bundle.section(...).isKnown());
 * more than one, or any with an entry part, go in a where() before it.
 */
function shapeExpression(shape) {
  const e = shape.entry;
  const checks = SECTION_CHECKS.filter(c => (shape.section.checks || []).includes(c));
  const head = `Bundle.section(${quote(shape.section.system)}, ${quote(shape.section.code)})`;
  if (!e && checks.length === 1) {
    return `${head}.${checks[0]}()`;
  }
  const where = checks.length ? `.where(${checks.map(c => `${c}()`).join(' and ')})` : '';
  const entry = !e ? '' : (e.valueSet !== undefined ? `.entryIn(${quote(e.valueSet)}${cardArgs(e)})` : `.entry(${args(e)})`);
  return head + where + entry + '.exists()';
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
 * @param {{id: string, url: string, title: string, constraints: Array, guides?: Array, date?: string}} p - guides: checked (checkGuides)
 */
function build(p) {
  return {
    resourceType: 'StructureDefinition',
    id: `profile-${p.id}`,
    ...guideResources(p.guides),
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
const UPLOAD_KEYS = new Set(['resourceType', 'id', 'meta', 'text', 'contained', 'extension', 'url', 'version', 'name', 'title', 'status', 'date', 'publisher',
  'fhirVersion', 'kind', 'abstract', 'type', 'baseDefinition', 'derivation', 'differential']);
const ELEMENT_KEYS = new Set(['id', 'path', 'constraint']);
const CONSTRAINT_KEYS = new Set(['key', 'severity', 'human', 'expression', 'source']);

/**
 * An uploaded StructureDefinition, as the editor's input (title, constraints and guided input,
 * the keys and linkIds dropped so they are assigned afresh), or the reasons it can't be taken.
 * @returns {{input: {title, constraints, guides}|null, problems: string[]}}
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
  const guided = guidesFromUpload(sd);
  problems.push(...guided.problems);
  const title = typeof sd.title === 'string' && sd.title.trim() ? sd.title : (typeof sd.name === 'string' ? sd.name : '');
  return { input: { title, constraints: list.map(c => (isObject(c) ? { human: c.human, expression: c.expression } : c)), guides: guided.guides }, problems };
}

// ---- guided input ----------------------------------------------------------------------------
//
// A profile's guided input: input-guide extensions on the StructureDefinition, each naming
// questions in the Questionnaire it contains (#Q), the section they are about (a Coding), and
// optionally the kind of resource the answers make and its code. Their order is the extensions'.

const INPUT_GUIDE = 'http://www.healthintersections.com.au/fhir/StructureDefinition/input-guide';
const UNIT_OPTION = 'http://hl7.org/fhir/StructureDefinition/questionnaire-unitOption';
const Q_ID = 'Q';
const QUESTION_TYPES = ['display', 'boolean', 'quantity', 'date', 'choice'];
// the resources a guide can make: resource type, and the class that says how it is used
const GUIDE_RESOURCES = [
  { code: 'Condition:problem', label: 'Condition (problem)' },
  { code: 'Condition:diagnosis', label: 'Condition (diagnosis)' },
  { code: 'Observation:vitals', label: 'Observation (vital signs)' },
  { code: 'MedicationStatement', label: 'MedicationStatement' },
  { code: 'AllergyIntolerance', label: 'AllergyIntolerance' }
];
const MAX_GUIDES = 100;
const MAX_QUESTIONS = 50;
const MAX_ANSWERS = 100;
const MAX_TEXT = 1000;
// a question's definition, as the editor has it: a path in a resource (Condition.onset[x], Observation.code.text)
const DEFINITION_RE = /^([A-Z][A-Za-z]{1,63})((?:\.[a-z][A-Za-z0-9]{0,63}(?:\[x\])?){1,8})$/;
const DEFINITION_URI_RE = /^http:\/\/hl7\.org\/fhir\/StructureDefinition\/([A-Z][A-Za-z]{1,63})#(\1(?:\.[a-z][A-Za-z0-9]{0,63}(?:\[x\])?){1,8})$/;

/** A question's definition as stored: http://hl7.org/fhir/StructureDefinition/{Type}#{path}. */
function definitionUri(path) {
  const m = DEFINITION_RE.exec(path);
  return m ? `http://hl7.org/fhir/StructureDefinition/${m[1]}#${path}` : null;
}

/** A stored definition as the editor shows it (the path), or null when it isn't one of ours. */
function definitionPath(uri) {
  const m = typeof uri === 'string' ? DEFINITION_URI_RE.exec(uri) : null;
  return m ? m[2] : null;
}

/** A new linkId: random, so one is never used again for another question. */
function newLinkId(used) {
  let id;
  do {
    id = 'q' + crypto.randomBytes(4).toString('hex');
  } while (used.has(id));
  return id;
}

/** A Coding as given: {system, code[, display]}, or null when it isn't one. */
function codingOf(c) {
  if (!isObject(c)) {
    return null;
  }
  const system = typeof c.system === 'string' ? c.system.trim() : '';
  const code = typeof c.code === 'string' ? c.code.trim() : '';
  if (!system || !code || system.length > 255 || code.length > 255) {
    return null;
  }
  const display = typeof c.display === 'string' && c.display.trim() ? c.display.trim().substring(0, MAX_TEXT) : null;
  return display ? { system, code, display } : { system, code };
}

/** The contained Questionnaire, or null. */
function questionnaireOf(sd) {
  return (Array.isArray(sd?.contained) ? sd.contained : []).find(r => isObject(r) && r.resourceType === 'Questionnaire' && r.id === Q_ID) || null;
}

/** A Questionnaire item as the editor has a question. */
function questionOf(item) {
  const ext = Array.isArray(item.extension) ? item.extension : [];
  return {
    linkId: item.linkId,
    text: typeof item.text === 'string' ? item.text : '',
    type: item.type,
    definition: item.definition !== undefined ? (definitionPath(item.definition) || item.definition) : '',
    answers: (Array.isArray(item.answerOption) ? item.answerOption : []).map(a => a?.valueCoding).filter(isObject),
    units: ext.filter(e => isObject(e) && e.url === UNIT_OPTION).map(e => e.valueCoding).filter(isObject)
  };
}

/** The sub-extensions of an extension with a url. */
function subs(ext, url) {
  return (Array.isArray(ext?.extension) ? ext.extension : []).filter(e => isObject(e) && e.url === url);
}

/**
 * A profile's guided input, as the editor has it, in order.
 * @returns {Array<{section: Coding, questions: Array<{linkId, text, type, definition, answers, units}>, resource: string|null, code: Coding|null}>}
 */
function guidesOf(sd) {
  const items = new Map();
  for (const item of Array.isArray(questionnaireOf(sd)?.item) ? questionnaireOf(sd).item : []) {
    if (isObject(item) && typeof item.linkId === 'string') {
      items.set(item.linkId, item);
    }
  }
  return (Array.isArray(sd?.extension) ? sd.extension : []).filter(e => isObject(e) && e.url === INPUT_GUIDE).map(ext => ({
    section: subs(ext, 'section')[0]?.valueCoding || null,
    questions: subs(ext, 'question').map(e => items.get(e.valueId)).filter(Boolean).map(questionOf),
    resource: subs(ext, 'resource')[0]?.valueCode || null,
    code: subs(ext, 'code')[0]?.valueCoding || null
  }));
}

/**
 * Check guided input from the editor (or an upload), and give each question its linkId: one it
 * already has in the profile it replaces is kept, the others get new ones.
 * @param {*} list - the guides
 * @param {Object|null} previous - the StructureDefinition being replaced
 * @returns {{guides: Array, problems: string[]}}
 */
function checkGuides(list, previous = null) {
  const problems = [];
  if (list === undefined || list === null) {
    return { guides: [], problems };
  }
  if (!Array.isArray(list)) {
    return { guides: [], problems: ['The guided input must be a list'] };
  }
  if (list.length > MAX_GUIDES) {
    problems.push(`There can be no more than ${MAX_GUIDES} input guides`);
  }
  const known = new Set(guidesOf(previous).flatMap(g => g.questions.map(q => q.linkId)));
  const used = new Set();
  const guides = [];
  list.slice(0, MAX_GUIDES).forEach((g, gi) => {
    const at = `Input guide ${gi + 1}`;
    if (!isObject(g)) {
      problems.push(`${at} is not an object`);
      return;
    }
    const section = codingOf(g.section);
    if (!section) {
      problems.push(`${at} has no section (a system and code)`);
    }
    const resource = typeof g.resource === 'string' && g.resource ? g.resource : null;
    if (resource && !GUIDE_RESOURCES.some(r => r.code === resource)) {
      problems.push(`${at} makes a resource this server doesn't know: '${resource}' (${GUIDE_RESOURCES.map(r => r.code).join(', ')})`);
    }
    let code = null;
    if (g.code !== undefined && g.code !== null && g.code !== '') {
      code = codingOf(g.code);
      if (!code) {
        problems.push(`${at} has a code that isn't a system and code`);
      } else if (!resource) {
        problems.push(`${at} has a code, but no resource: the code is the resource's`);
      }
    }
    const qs = Array.isArray(g.questions) ? g.questions : [];
    if (qs.length === 0) {
      problems.push(`${at} has no questions`);
    } else if (qs.length > MAX_QUESTIONS) {
      problems.push(`${at} has more than ${MAX_QUESTIONS} questions`);
    }
    const questions = [];
    qs.slice(0, MAX_QUESTIONS).forEach((q, qi) => {
      const qat = `${at}, question ${qi + 1}`;
      if (!isObject(q)) {
        problems.push(`${qat} is not an object`);
        return;
      }
      const text = typeof q.text === 'string' ? q.text.trim() : '';
      if (!text) {
        problems.push(`${qat} has no text`);
      } else if (text.length > MAX_TEXT) {
        problems.push(`${qat}'s text is longer than ${MAX_TEXT} characters`);
      }
      const type = q.type;
      if (!QUESTION_TYPES.includes(type)) {
        problems.push(`${qat} has no type (${QUESTION_TYPES.join(', ')})`);
      }
      const definition = typeof q.definition === 'string' ? q.definition.trim() : '';
      if (definition && !DEFINITION_RE.test(definition)) {
        problems.push(`${qat}'s definition is not a path in a resource, like Condition.onset[x]`);
      }
      const answers = [];
      for (const a of Array.isArray(q.answers) ? q.answers.slice(0, MAX_ANSWERS) : []) {
        const c = codingOf(a);
        if (c) {
          answers.push(c);
        } else {
          problems.push(`${qat} has an answer that isn't a system and code`);
        }
      }
      const units = [];
      for (const u of Array.isArray(q.units) ? q.units.slice(0, MAX_ANSWERS) : []) {
        const c = codingOf(u);
        if (c) {
          units.push(c);
        } else {
          problems.push(`${qat} has a unit that isn't a system and code`);
        }
      }
      if (type === 'choice' && answers.length === 0) {
        problems.push(`${qat} is a choice, but has no answers to choose from`);
      }
      if (type !== 'choice' && answers.length) {
        problems.push(`${qat} has answers, but only a choice can have them`);
      }
      if (type !== 'quantity' && units.length) {
        problems.push(`${qat} has units, but only a quantity can have them`);
      }
      let linkId = typeof q.linkId === 'string' && known.has(q.linkId) && !used.has(q.linkId) ? q.linkId : null;
      if (!linkId) {
        linkId = newLinkId(new Set([...known, ...used]));
      }
      used.add(linkId);
      questions.push({ linkId, text, type, definition, answers, units });
    });
    // what a guide with answers needs: a resource to make, a yes/no first question (the one that
    // decides - the only kind there is for now), and, with a yes/no question, a code
    if (questions.some(q => q.type !== 'display')) {
      if (!resource) {
        problems.push(`${at} has questions to answer, so it needs a resource for the answers to make`);
      }
      if (questions[0] && questions[0].type !== 'boolean') {
        problems.push(`${at}'s first question must be a yes/no question: it is the one the answers depend on`);
      }
    }
    if (questions.some(q => q.type === 'boolean') && !code) {
      problems.push(`${at} has a yes/no question, so it needs a code: what the answer is about`);
    }
    guides.push({ section, questions, resource, code: resource ? code : null });
  });
  return { guides, problems };
}

/** The contained Questionnaire and the input-guide extensions for guided input (none for none). */
function guideResources(guides) {
  if (!Array.isArray(guides) || guides.length === 0) {
    return {};
  }
  const item = guides.flatMap(g => g.questions.map(q => {
    const it = {};
    if (q.units && q.units.length) {
      it.extension = q.units.map(u => ({ url: UNIT_OPTION, valueCoding: u }));
    }
    it.linkId = q.linkId;
    if (q.definition) {
      it.definition = definitionUri(q.definition);
    }
    it.text = q.text;
    it.type = q.type;
    if (q.answers && q.answers.length) {
      it.answerOption = q.answers.map(a => ({ valueCoding: a }));
    }
    return it;
  }));
  return {
    contained: [{ resourceType: 'Questionnaire', id: Q_ID, status: 'active', item }],
    extension: guides.map(g => ({
      url: INPUT_GUIDE,
      extension: [
        { url: 'questionnaire', valueCanonical: `#${Q_ID}` },
        ...g.questions.map(q => ({ url: 'question', valueId: q.linkId })),
        { url: 'section', valueCoding: g.section },
        ...(g.resource ? [{ url: 'resource', valueCode: g.resource }] : []),
        ...(g.resource && g.code ? [{ url: 'code', valueCoding: g.code }] : [])
      ]
    }))
  };
}

const Q_KEYS = new Set(['resourceType', 'id', 'status', 'item']);
const ITEM_KEYS = new Set(['extension', 'linkId', 'definition', 'text', 'type', 'answerOption']);
const GUIDE_SUBS = new Set(['questionnaire', 'question', 'section', 'resource', 'code']);

/**
 * An uploaded profile's guided input, as the editor's (linkIds dropped, so they are assigned
 * afresh), and what is wrong with it: anything more than this server makes is refused, as is a
 * guide naming a question the Questionnaire doesn't have.
 */
function guidesFromUpload(sd) {
  const problems = [];
  const exts = sd.extension === undefined ? [] : sd.extension;
  if (!Array.isArray(exts) || exts.some(e => !isObject(e) || e.url !== INPUT_GUIDE)) {
    problems.push(`Its only extensions may be input guides (${INPUT_GUIDE})`);
    return { guides: [], problems };
  }
  const contained = sd.contained === undefined ? [] : sd.contained;
  if (!Array.isArray(contained) || contained.length > 1 || (contained.length === 1 && !(isObject(contained[0]) && contained[0].resourceType === 'Questionnaire' && contained[0].id === Q_ID))) {
    problems.push(`It may contain only the input guides' Questionnaire (#${Q_ID})`);
    return { guides: [], problems };
  }
  if (exts.length && !contained.length) {
    problems.push(`It has input guides, but no Questionnaire (#${Q_ID})`);
    return { guides: [], problems };
  }
  const q = contained[0];
  const items = new Map();
  if (q) {
    const extraQ = Object.keys(q).filter(k => !Q_KEYS.has(k));
    if (extraQ.length) {
      problems.push(`Its Questionnaire has more than input guides use: ${extraQ.join(', ')}`);
    }
    (Array.isArray(q.item) ? q.item : []).forEach((item, i) => {
      if (!isObject(item) || typeof item.linkId !== 'string') {
        problems.push(`Its Questionnaire's item ${i + 1} has no linkId`);
        return;
      }
      const extra = Object.keys(item).filter(k => !ITEM_KEYS.has(k));
      if (extra.length) {
        problems.push(`Question '${item.linkId}' has more than input guides use: ${extra.join(', ')}`);
      }
      if ((Array.isArray(item.extension) ? item.extension : []).some(e => !isObject(e) || e.url !== UNIT_OPTION)) {
        problems.push(`Question '${item.linkId}' has an extension other than ${UNIT_OPTION}`);
      }
      if ((Array.isArray(item.answerOption) ? item.answerOption : []).some(a => !isObject(a) || Object.keys(a).some(k => k !== 'valueCoding'))) {
        problems.push(`Question '${item.linkId}' has an answer that isn't a Coding`);
      }
      if (item.definition !== undefined && !definitionPath(item.definition)) {
        problems.push(`Question '${item.linkId}' has a definition that isn't http://hl7.org/fhir/StructureDefinition/{type}#{path}`);
      }
      items.set(item.linkId, item);
    });
  }
  const guides = exts.map((ext, i) => {
    const at = `Input guide ${i + 1}`;
    const all = Array.isArray(ext.extension) ? ext.extension : [];
    const odd = all.filter(e => !isObject(e) || !GUIDE_SUBS.has(e.url));
    if (odd.length || Object.keys(ext).some(k => k !== 'url' && k !== 'extension')) {
      problems.push(`${at} has more than questionnaire, question, section, resource and code`);
    }
    if (subs(ext, 'questionnaire').length !== 1 || subs(ext, 'questionnaire')[0].valueCanonical !== `#${Q_ID}`) {
      problems.push(`${at} must name the Questionnaire #${Q_ID}, once`);
    }
    for (const u of ['section', 'resource', 'code']) {
      if (subs(ext, u).length > 1) {
        problems.push(`${at} has more than one ${u}`);
      }
    }
    const questions = [];
    for (const e of subs(ext, 'question')) {
      const item = items.get(e.valueId);
      if (!item) {
        problems.push(`${at} names question '${e.valueId}', which the Questionnaire doesn't have`);
      } else {
        const qn = questionOf(item);
        delete qn.linkId;
        questions.push(qn);
      }
    }
    return {
      section: subs(ext, 'section')[0]?.valueCoding,
      questions,
      resource: subs(ext, 'resource')[0]?.valueCode || null,
      code: subs(ext, 'code')[0]?.valueCoding || null
    };
  });
  return { guides, problems };
}

/**
 * The order the guided input is shown in: grouped by section - the IPS sections in their
 * order first, then the others as they first appear - and in a section, the guides' own order.
 * @returns {Array<{section: Coding, guides: Array<{guide, index}>}>} index: the guide's place in the profile
 */
function guideGroups(guides, ipsOrder) {
  const groups = new Map();
  guides.forEach((guide, index) => {
    const key = `${guide.section?.system}|${guide.section?.code}`;
    if (!groups.has(key)) {
      groups.set(key, { section: guide.section, guides: [], first: index });
    }
    groups.get(key).guides.push({ guide, index });
  });
  const rank = (g) => {
    const i = g.section?.system === LOINC ? ipsOrder.indexOf(g.section.code) : -1;
    return i >= 0 ? i : ipsOrder.length + g.first;
  };
  return [...groups.values()].sort((a, b) => rank(a) - rank(b));
}

/**
 * What the general IPS editor needs from a profile it is started with: per section (by
 * system|code), what the profile's section rules ask of it - the checks (isKnown, hasData,
 * sameSubject), whether it must have entries (an entry part), and the rules' descriptions - and
 * the guided input, each guide with a key (its questions' linkIds) and its section's title.
 */
function editorGuidance(sd) {
  const sections = {};
  for (const c of constraintsOf(sd)) {
    const shape = parseShape(c.expression);
    if (!shape) {
      continue;
    }
    const key = `${shape.section.system}|${shape.section.code}`;
    const s = sections[key] || (sections[key] = { checks: [], needsEntries: false, rules: [] });
    for (const ch of shape.section.checks) {
      if (!s.checks.includes(ch)) {
        s.checks.push(ch);
      }
    }
    // an entry part's .exists() needs at least one entry
    if (shape.entry) {
      s.needsEntries = true;
    }
    s.rules.push(c.human);
  }
  const guides = guidesOf(sd).filter(g => g.section && g.questions.length).map(g => {
    const named = g.section.system === LOINC ? IPS_SECTIONS.find(x => x.code === g.section.code) : null;
    return {
      key: g.questions.map(q => q.linkId).join('+'),
      section: g.section,
      sectionTitle: named ? named.title : (g.section.display || `${g.section.system}|${g.section.code}`),
      questions: g.questions.map(q => ({ linkId: q.linkId, text: q.text, type: q.type, definition: q.definition, answers: q.answers, units: q.units })),
      resource: g.resource,
      code: g.code
    };
  });
  return { id: sd.id, title: sd.title, sections, guides };
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
  SYSTEMS, IPS_SECTIONS, SECTION_CHECKS, RESOURCE_TYPES,
  INPUT_GUIDE, UNIT_OPTION, QUESTION_TYPES, GUIDE_RESOURCES, guidesOf, checkGuides, guideGroups, editorGuidance, definitionUri, definitionPath, BUNDLE, MAX_CONSTRAINTS, ID_RE, migrate,
  parseResourceShape, resourceShapeExpression, kindOf, describeResource,
  parseShape, shapeExpression, parseCard, cardText, expressionProblem, nameFromTitle, newId,
  checkInput, build, constraintsOf, fromUpload, describePart
};
