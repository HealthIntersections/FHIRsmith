//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * The processing pipeline: what happens to an IPS document once it has been received.
 * One process works through the queue (ips.js: processQueue), and runs these steps over
 * each document, in this order:
 *
 *   1. translate     translate CodeableConcepts that fail the terminology check to codes that pass it
 *   2. narrative     generate the narrative with the IPS presenter (presenter.js), into the analysed copy
 *   3. validation    validate the (translated) document with the FHIR validator (fhir-validator-wrapper)
 *   4. terminology   check each CodeableConcept against the value sets for international exchange
 *   5. piqi          measure the quality of the document with PIQI                        (not yet)
 *   6. profiles      check the document against each clinical profile (profiles.js)
 *   7. ai            assess the document for consistency and its terminology with an AI service (ai-client.js)
 *
 * Each step is { name, run(row, project, module) -> result }. A step keeps what it finds in
 * one of two places: as a result stored against the document (store.saveResult - the
 * validation outcome), or written into row.analysed, a second copy of the document that
 * the steps adorn with extensions (the terminology check); the master document is never
 * changed. A step that throws marks the document 'error' with its message and stops the
 * pipeline; a step that returns normally gives a note for the document's status line.
 * Steps not yet written are simply not in the list.
 *
 * @module ips/pipeline
 */

const { terminologyOf } = require('./terminology');
const { isHl7System } = require('./ips-valuesets');
const { Presenter } = require('./presenter');
const ai = require('./ai-client');
const { evaluateAsync } = require('./fhirpath-ips');

const IPS_BUNDLE_PROFILE = 'http://hl7.org/fhir/uv/ips/StructureDefinition/Bundle-uv-ips';
const VALIDATE_TIMEOUT_MS = 120000;

// the extension the terminology check leaves on each CodeableConcept in the analysed copy
const CHECK_EXTENSION = 'http://healthintersections.com.au/fhirsmith/StructureDefinition/ips-valueset-check';
// its result codes
const CHECK_RESULTS = ['in', 'international', 'not-in', 'unknown'];
// the extension the translate step leaves on each Coding it adds: where it came from
const TRANSLATION_EXTENSION = 'http://healthintersections.com.au/fhirsmith/StructureDefinition/ips-translation';
// how the step marks a Coding's extension list, so a resubmitted analysed copy can be cleaned
const OUR_EXTENSIONS = new Set([CHECK_EXTENSION, TRANSLATION_EXTENSION]);
// the most terminology-server questions asked for one document; beyond it, concepts are
// left unknown. A document is the submitter's, and each question carries a value set
const MAX_CHECKS_PER_DOCUMENT = 2000;
// answers remembered across documents
const MAX_CACHED_ANSWERS = 20000;

/** The counts of an OperationOutcome's issues, by severity. */
function issueCounts(outcome) {
  const counts = { fatal: 0, error: 0, warning: 0, information: 0 };
  for (const i of Array.isArray(outcome?.issue) ? outcome.issue : []) {
    if (i && typeof i.severity === 'string' && counts[i.severity] !== undefined) {
      counts[i.severity]++;
    }
  }
  return counts;
}

/** "2 errors, 5 warnings" / "no issues" */
function issueSummary(counts) {
  const parts = [];
  const word = (n, s) => `${n} ${s}${n === 1 ? '' : 's'}`;
  if (counts.fatal) {
    parts.push(word(counts.fatal, 'fatal error'));
  }
  if (counts.error) {
    parts.push(word(counts.error, 'error'));
  }
  if (counts.warning) {
    parts.push(word(counts.warning, 'warning'));
  }
  if (counts.information) {
    parts.push(word(counts.information, 'note'));
  }
  return parts.length ? parts.join(', ') : 'no issues';
}

/**
 * Validation: the document goes to the FHIR validator (started by the module from
 * modules.ips.validator), against the IPS Bundle profile unless the configuration says
 * otherwise, with the validator's IPS code checks on, and the OperationOutcome is kept.
 */
const validation = {
  name: 'validation',
  async run(row, project, module) {
    const v = module.validator;
    if (!v) {
      throw new Error('The validator is not configured (modules.ips.validator)');
    }
    if (!v.isRunning()) {
      throw new Error('The validator is not running');
    }
    const cfg = module.config.validator || {};
    const profiles = Array.isArray(cfg.profiles) ? cfg.profiles : [IPS_BUNDLE_PROFILE];
    // the validator's own IPS checks (code systems and value sets the IPS expects), unless
    // the configuration turns them off
    const checkIpsCodes = cfg.checkIpsCodes !== false;
    const started = Date.now();
    // fhir-validator-wrapper 1.5.0 or later: earlier versions sent the profiles in a form the
    // validator service refuses
    // the analysed copy: the translations are in it, and the validator should see them
    const outcome = await v.validate(JSON.stringify(row.analysed || row.bundle), { profiles, checkIpsCodes, timeout: VALIDATE_TIMEOUT_MS });
    if (!outcome || outcome.resourceType !== 'OperationOutcome') {
      throw new Error('The validator did not return an OperationOutcome');
    }
    const counts = issueCounts(outcome);
    module.store.saveResult(row.id, 'validation', {
      ms: Date.now() - started,
      profiles,
      validatorVersion: typeof v.jarVersion === 'function' ? v.jarVersion() : null,
      counts,
      outcome
    });
    return `validation: ${issueSummary(counts)}`;
  }
};

// ---- the terminology check ------------------------------------------------------------

/**
 * Ask the terminology server whether a coding is in a value set. The value set itself goes
 * with the request (as the operation's valueSet parameter), and so do the value sets it
 * includes and the code systems of our own it draws on (as tx-resource parameters), so the
 * server needn't know them.
 *
 * @returns {Promise<{result: boolean|null, message: string|null}>} null when the server
 *   didn't say true or false
 */
async function validateCodeInValueSet(tx, valueSets, valueSetUrl, coding) {
  const vs = valueSets.valueSet(valueSetUrl);
  const params = { resourceType: 'Parameters', parameter: [] };
  if (vs) {
    params.parameter.push({ name: 'valueSet', resource: vs });
    for (const other of valueSets.referencedResources(valueSetUrl)) {
      params.parameter.push({ name: 'tx-resource', resource: other });
    }
  } else {
    params.parameter.push({ name: 'url', valueUri: valueSetUrl });
  }
  params.parameter.push({ name: 'coding', valueCoding: plainCoding(coding) });
  return answerOf(tx, await ask(tx, '/ValueSet/$validate-code', params));
}

/**
 * Ask the terminology server whether a code is in a code system at all (the fallback for a
 * code in an HL7 terminology, which has no value set here).
 */
async function validateCodeInSystem(tx, coding) {
  const params = { resourceType: 'Parameters', parameter: [{ name: 'url', valueUri: coding.system }] };
  if (typeof coding.version === 'string') {
    params.parameter.push({ name: 'version', valueString: coding.version });
  }
  params.parameter.push({ name: 'code', valueCode: coding.code });
  if (typeof coding.display === 'string') {
    params.parameter.push({ name: 'display', valueString: coding.display });
  }
  return answerOf(tx, await ask(tx, '/CodeSystem/$validate-code', params));
}

function plainCoding(coding) {
  const c = { system: coding.system, code: coding.code };
  if (typeof coding.version === 'string') {
    c.version = coding.version;
  }
  if (typeof coding.display === 'string') {
    c.display = coding.display;
  }
  return c;
}

async function ask(tx, operation, params) {
  try {
    return await tx.post(operation, params);
  } catch (e) {
    // the detail (host, port, path) is for the log, not the page
    if (tx.log) {
      tx.log.error(`IPS module: the terminology server could not be reached: ${e.message}`);
    }
    return null;
  }
}

/**
 * What a $validate-code response says: true, false, or null with the reason it said neither;
 * and whether the server called the code inactive.
 */
function answerOf(tx, r) {
  if (!r) {
    return { result: null, message: 'The terminology server could not be reached' };
  }
  const res = r.resource;
  const issueText = (oo) => (Array.isArray(oo?.issue) ? oo.issue : []).map(i => i?.details?.text || i?.diagnostics).filter(Boolean).join('; ');
  if (res?.resourceType === 'Parameters') {
    const result = (res.parameter || []).find(p => p?.name === 'result');
    if (result && typeof result.valueBoolean === 'boolean') {
      const message = (res.parameter || []).find(p => p?.name === 'message');
      const inactive = (res.parameter || []).find(p => p?.name === 'inactive');
      return { result: result.valueBoolean, message: typeof message?.valueString === 'string' ? message.valueString : null, inactive: inactive?.valueBoolean === true };
    }
    const issues = (res.parameter || []).find(p => p?.name === 'issues');
    return { result: null, message: issueText(issues?.resource) || 'The terminology server gave no result' };
  }
  if (res?.resourceType === 'OperationOutcome') {
    return { result: null, message: issueText(res) || `The terminology server answered HTTP ${r.status}` };
  }
  if (r.status === 404 && tx.internal) {
    return { result: null, message: 'The terminology server is not configured correctly (see the server log)' };
  }
  return { result: null, message: `The terminology server answered HTTP ${r.status}` };
}

/**
 * Check a CodeableConcept: is any coding in the element's value set (if it has one)? If
 * not, is any coding international anyway - in the fallback value set (SNOMED CT
 * International, LOINC), or a code in an HL7 terminology? Answers are cached on the module
 * (module.txCache) across documents.
 *
 * @param {Object} concept
 * @param {string|null} valueSetUrl - the element's value set, or null when it has none
 * @returns {Promise<{result: 'in'|'international'|'not-in'|'unknown', valueSet?: string,
 *   system?: string, coding?: Object, message: string}>} - result 'in' when a coding is in
 *   the element's value set, or when the element has no value set and a coding is
 *   international; 'international' when the element has a value set but only the fallback
 *   accepts a coding
 */
async function checkConcept(module, concept, valueSetUrl, budget = { left: Infinity }) {
  const codings = (Array.isArray(concept.coding) ? concept.coding : [])
    .filter(c => c && typeof c === 'object' && typeof c.system === 'string' && typeof c.code === 'string');
  if (codings.length === 0) {
    return { result: 'not-in', message: 'The concept has no codings' };
  }
  const valueSets = module.valueSets;
  const cache = module.txCache || (module.txCache = new Map());
  const remember = (key, answer) => {
    if (cache.size >= MAX_CACHED_ANSWERS) {
      // the oldest goes: a Map iterates in insertion order
      cache.delete(cache.keys().next().value);
    }
    cache.set(key, answer);
  };
  const unknowns = [];
  // one question, through the cache and the budget
  const answered = async (key, what, question) => {
    let answer = cache.get(key);
    if (answer === undefined) {
      if (budget.left <= 0) {
        unknowns.push(`${what}: not checked - the document has more codes than are checked (${MAX_CHECKS_PER_DOCUMENT})`);
        return null;
      }
      budget.left--;
      answer = await question();
      // a server that could not answer is asked again next time; true and false are kept
      if (answer.result !== null) {
        remember(key, answer);
      }
    }
    if (answer.result === null) {
      unknowns.push(`${what}: ${answer.message}`);
    }
    return answer;
  };
  const inactive = (answer) => (answer.inactive ? ' (the code is inactive)' : '');
  const codingKey = (c) => `${c.system}|${c.version || ''}|${c.code}`;
  if (valueSetUrl) {
    for (const coding of codings) {
      const r = await answered(`${valueSetUrl}|${codingKey(coding)}`, `${coding.system}|${coding.code} in ${valueSetUrl}`,
        () => validateCodeInValueSet(module.tx, valueSets, valueSetUrl, coding));
      if (r?.result === true) {
        return { result: 'in', valueSet: valueSetUrl, coding, message: `${coding.system}|${coding.code} is in ${valueSetUrl}${inactive(r)}` };
      }
    }
  }
  // the fallback: international anyway?
  for (const coding of codings) {
    if (isHl7System(coding.system)) {
      const r = await answered(`${coding.system}|${codingKey(coding)}`, `${coding.system}|${coding.code}`,
        () => validateCodeInSystem(module.tx, coding));
      if (r?.result === true) {
        return {
          result: valueSetUrl ? 'international' : 'in', system: coding.system, coding,
          message: `${coding.system}|${coding.code} is a code in an HL7 terminology` + (valueSetUrl ? `, but not in ${valueSetUrl}` : '') + inactive(r)
        };
      }
    } else {
      const r = await answered(`${valueSets.fallback}|${codingKey(coding)}`, `${coding.system}|${coding.code} in ${valueSets.fallback}`,
        () => validateCodeInValueSet(module.tx, valueSets, valueSets.fallback, coding));
      if (r?.result === true) {
        return {
          result: valueSetUrl ? 'international' : 'in', valueSet: valueSets.fallback, coding,
          message: `${coding.system}|${coding.code} is in ${valueSets.fallback}` + (valueSetUrl ? `, but not in ${valueSetUrl}` : '') + inactive(r)
        };
      }
    }
  }
  if (unknowns.length > 0) {
    return { result: 'unknown', message: 'Could not be determined - ' + unknowns.join('; ') };
  }
  return {
    result: 'not-in',
    message: (valueSetUrl ? `No coding is in ${valueSetUrl}, and none` : 'No coding') + ' is in an international terminology (SNOMED CT International, LOINC, or an HL7 terminology)'
  };
}

/** The check's extension on a CodeableConcept in the analysed copy, if there is one. */
function checkOf(concept) {
  const ext = (Array.isArray(concept?.extension) ? concept.extension : []).find(e => e?.url === CHECK_EXTENSION);
  if (!ext) {
    return null;
  }
  const sub = (name) => (Array.isArray(ext.extension) ? ext.extension : []).filter(e => e?.url === name);
  const result = sub('result')[0]?.valueCode;
  return {
    result: CHECK_RESULTS.includes(result) ? result : 'unknown',
    valueSet: sub('valueSet')[0]?.valueCanonical || null,
    system: sub('system')[0]?.valueUri || null,
    coding: sub('coding')[0]?.valueCoding || null,
    message: sub('message')[0]?.valueString || null
  };
}

/**
 * Remove the check's and the translations' extensions from a document - a resubmitted
 * analysed copy carries the last run's; the analysed copy starts clean. (A translated coding
 * stays: resubmitted, it is the submitter's.)
 */
function stripChecks(node) {
  if (Array.isArray(node)) {
    node.forEach(stripChecks);
  } else if (node && typeof node === 'object') {
    if (Array.isArray(node.extension)) {
      node.extension = node.extension.filter(e => !OUR_EXTENSIONS.has(e?.url));
      if (node.extension.length === 0) {
        delete node.extension;
      }
    }
    Object.values(node).forEach(stripChecks);
  }
  return node;
}

/**
 * Write the check's extension onto a CodeableConcept (in the analysed copy): the result, the
 * value set the element is held to (or, for a fallback answer, the value set or code system
 * that accepted the coding), the coding that was accepted, and the message.
 */
function addCheck(concept, outcome, valueSetUrl) {
  const ext = { url: CHECK_EXTENSION, extension: [{ url: 'result', valueCode: outcome.result }] };
  const vs = outcome.result === 'in' || outcome.result === 'international' ? outcome.valueSet : valueSetUrl;
  if (vs) {
    ext.extension.push({ url: 'valueSet', valueCanonical: vs });
  }
  if (outcome.system) {
    ext.extension.push({ url: 'system', valueUri: outcome.system });
  }
  if (outcome.coding) {
    ext.extension.push({ url: 'coding', valueCoding: outcome.coding });
  }
  if (outcome.message) {
    ext.extension.push({ url: 'message', valueString: outcome.message });
  }
  if (!Array.isArray(concept.extension)) {
    concept.extension = [];
  }
  concept.extension.push(ext);
}

/**
 * Terminology: every CodeableConcept the terminology view lists (terminology.js), checked
 * against the value set this module holds its element to for international exchange
 * (ips-valuesets.js), and failing that against the international fallback. The answer goes
 * on the concept in the analysed copy as an extension - in, international (but not in the
 * element's value set), not-in, or unknown when the server could not say.
 */
const terminology = {
  name: 'terminology',
  async run(row, project, module) {
    if (!module.tx) {
      throw new Error('No terminology server is configured (modules.ips.txServer)');
    }
    const valueSets = module.valueSets;
    if (!valueSets || !valueSets.loaded) {
      throw new Error('The value sets have not been loaded');
    }
    if (!row.analysed) {
      throw new Error('No analysed copy of the document to write to');
    }
    const t = terminologyOf(row.analysed);
    const concepts = [...t.composition];
    for (const s of t.sections) {
      for (const e of s.entries) {
        concepts.push(...e.concepts);
      }
    }
    const counts = { in: 0, international: 0, 'not-in': 0, unknown: 0 };
    const budget = { left: MAX_CHECKS_PER_DOCUMENT };
    // the same concept (same codings, same value set) is answered once per document
    const answered = new Map();
    for (const c of concepts) {
      if (checkOf(c.concept)) {
        continue; // the same resource in two sections
      }
      const valueSetUrl = valueSets.valueSetFor(c.element);
      const key = JSON.stringify([c.concept.coding, valueSetUrl]);
      let outcome = answered.get(key);
      if (!outcome) {
        outcome = await checkConcept(module, c.concept, valueSetUrl, budget);
        answered.set(key, outcome);
      }
      addCheck(c.concept, outcome, valueSetUrl);
      counts[outcome.result]++;
    }
    return `terminology: ${counts.in} in, ${counts.international} international only, ${counts['not-in']} not in, ${counts.unknown} unknown`;
  }
};

// ---- translation ------------------------------------------------------------------------

/**
 * Ask the terminology server to translate a CodeableConcept into a value set
 * (ConceptMap/$translate with sourceCodeableConcept and targetScope; the value set and what
 * it draws on go as tx-resource). The server picks the concept maps.
 *
 * @returns {Promise<{matches: Array<{coding: Object, relationship: string|null, conceptMap: string|null}>, message: string|null, failed: boolean}>}
 */
async function translateConcept(tx, valueSets, concept, valueSetUrl) {
  const params = { resourceType: 'Parameters', parameter: [
    { name: 'sourceCodeableConcept', valueCodeableConcept: concept },
    { name: 'targetScope', valueUri: valueSetUrl }
  ] };
  const vs = valueSets.valueSet(valueSetUrl);
  if (vs) {
    params.parameter.push({ name: 'tx-resource', resource: vs });
    for (const other of valueSets.referencedResources(valueSetUrl)) {
      params.parameter.push({ name: 'tx-resource', resource: other });
    }
  }
  const r = await ask(tx, '/ConceptMap/$translate', params);
  const answer = answerOf(tx, r);
  if (answer.result === null) {
    return { matches: [], message: answer.message, failed: true };
  }
  const matches = [];
  const part = (m, name) => (Array.isArray(m.part) ? m.part : []).find(p => p?.name === name);
  for (const m of (r.resource.parameter || []).filter(p => p?.name === 'match')) {
    const coding = part(m, 'concept')?.valueCoding;
    if (!coding || typeof coding.system !== 'string' || typeof coding.code !== 'string') {
      continue;
    }
    // R5 names, and the R4 ones a server may still use
    const rel = part(m, 'relationship')?.valueCode || part(m, 'equivalence')?.valueCode || null;
    const mapPart = part(m, 'originMap') || part(m, 'source');
    const conceptMap = mapPart?.valueCanonical || mapPart?.valueUri || mapPart?.valueString || null;
    matches.push({ coding: plainCoding(coding), relationship: typeof rel === 'string' ? rel : null, conceptMap: typeof conceptMap === 'string' ? conceptMap : null });
  }
  return { matches, message: answer.message, failed: false };
}

/** The translation's extension on a Coding in the analysed copy, if there is one. */
function translationOf(coding) {
  const ext = (Array.isArray(coding?.extension) ? coding.extension : []).find(e => e?.url === TRANSLATION_EXTENSION);
  if (!ext) {
    return null;
  }
  const sub = (name) => (Array.isArray(ext.extension) ? ext.extension : []).find(e => e?.url === name);
  return {
    server: sub('server')?.valueUri || null,
    conceptMap: sub('conceptMap')?.valueCanonical || null,
    relationship: sub('relationship')?.valueCode || null
  };
}

/** A CodeableConcept as the server should see it: without our extensions. */
function withoutOurExtensions(concept) {
  const c = structuredClone(concept);
  stripChecks(c);
  return c;
}

/**
 * Translate: every CodeableConcept that fails the terminology check (no coding in the
 * element's value set - or, for an element with none, in the international fallback) is
 * sent to the terminology server to translate into that value set, and the matches are
 * added to it as codings in the analysed copy, each with an extension saying which server
 * (and concept map, and with what relationship) it came from. The terminology step then
 * checks the document again, translations included. What happened to each concept is kept
 * as the step's result (store.saveResult), for the translation view.
 */
const translate = {
  name: 'translate',
  async run(row, project, module) {
    if (!module.tx) {
      throw new Error('No terminology server is configured (modules.ips.txServer)');
    }
    const valueSets = module.valueSets;
    if (!valueSets || !valueSets.loaded) {
      throw new Error('The value sets have not been loaded');
    }
    if (!row.analysed) {
      throw new Error('No analysed copy of the document to write to');
    }
    const t = terminologyOf(row.analysed);
    const concepts = [...t.composition];
    for (const s of t.sections) {
      for (const e of s.entries) {
        concepts.push(...e.concepts);
      }
    }
    const counts = { tried: 0, translated: 0, codings: 0, failed: 0 };
    const budget = { left: MAX_CHECKS_PER_DOCUMENT };
    const cache = module.txCache || (module.txCache = new Map());
    const started = Date.now();
    // what happened to each concept, for the translation view
    const entries = [];
    // the same resource in two sections, and the same concept in two places: once
    const seen = new Set();
    const done = new Map();
    for (const c of concepts) {
      if (seen.has(c.concept)) {
        continue;
      }
      seen.add(c.concept);
      const valueSetUrl = valueSets.valueSetFor(c.element);
      const target = valueSetUrl || valueSets.fallback;
      const codings = Array.isArray(c.concept.coding) ? c.concept.coding : [];
      const entry = {
        path: c.path, element: c.element, target, ownValueSet: !!valueSetUrl,
        codings: codings.filter(x => x && typeof x === 'object').map(plainCoding), text: typeof c.concept.text === 'string' ? c.concept.text : null,
        outcome: null, check: null, message: null, added: []
      };
      entries.push(entry);
      if (codings.length === 0) {
        entry.outcome = 'no-codings';
        entry.message = 'The concept has no codings to translate from';
        continue;
      }
      const key = JSON.stringify([target, codings]);
      let translation = done.get(key);
      if (!translation) {
        const check = await checkConcept(module, c.concept, valueSetUrl, budget);
        if (check.result === 'in' || check.result === 'unknown') {
          translation = { matches: [], skipped: true, check };
        } else if (budget.left <= 0) {
          translation = { matches: [], failed: true, check, message: `not translated - the document has more codes than are checked (${MAX_CHECKS_PER_DOCUMENT})` };
        } else {
          const cacheKey = `translate|${key}`;
          translation = cache.get(cacheKey);
          if (!translation) {
            budget.left--;
            translation = await translateConcept(module.tx, valueSets, withoutOurExtensions(c.concept), target);
            if (!translation.failed) {
              if (cache.size >= MAX_CACHED_ANSWERS) {
                cache.delete(cache.keys().next().value);
              }
              cache.set(cacheKey, translation);
            }
          }
          translation = { ...translation, check };
        }
        done.set(key, translation);
      }
      entry.check = { result: translation.check.result, message: translation.check.message };
      if (translation.skipped) {
        entry.outcome = translation.check.result === 'in' ? 'not-needed' : 'not-checked';
        entry.message = translation.check.message;
        continue;
      }
      counts.tried++;
      if (translation.failed) {
        counts.failed++;
        entry.outcome = 'failed';
        entry.message = translation.message;
        if (module.log) {
          module.log.warn(`IPS module: document ${row.id}: ${c.path} could not be translated: ${translation.message}`);
        }
        continue;
      }
      let added = 0;
      for (const m of translation.matches) {
        if (codings.some(x => x && x.system === m.coding.system && x.code === m.coding.code)) {
          entry.added.push({ ...m, present: true });
          continue; // already there
        }
        const ext = { url: TRANSLATION_EXTENSION, extension: [{ url: 'server', valueUri: module.tx.url }] };
        if (m.conceptMap) {
          ext.extension.push({ url: 'conceptMap', valueCanonical: m.conceptMap });
        }
        if (m.relationship) {
          ext.extension.push({ url: 'relationship', valueCode: m.relationship });
        }
        c.concept.coding.push({ ...m.coding, extension: [ext] });
        entry.added.push(m);
        added++;
      }
      if (added > 0) {
        counts.translated++;
        counts.codings += added;
        entry.outcome = 'translated';
        entry.message = `${added} coding${added === 1 ? '' : 's'} added`;
      } else {
        entry.outcome = 'no-translation';
        entry.message = translation.matches.length > 0 ? 'The translation gave only codings the concept already has' : (translation.message || 'The terminology server has no translation');
      }
    }
    module.store.saveResult(row.id, 'translate', { ms: Date.now() - started, server: module.tx.url, counts, entries });
    return `translate: ${counts.translated} of ${counts.tried} concepts translated (${counts.codings} codings added)` +
      (counts.failed ? `, ${counts.failed} not translated (see the log)` : '');
  }
};

// ---- narrative --------------------------------------------------------------------------

// the most $lookup questions the narrative asks for one document
const MAX_LOOKUPS_PER_DOCUMENT = 500;

/**
 * Ask the terminology server for a coding's display (CodeSystem/$lookup).
 * @returns {Promise<string|null>} null when it has none, or could not say
 */
async function lookupDisplay(tx, coding) {
  const q = `system=${encodeURIComponent(coding.system)}&code=${encodeURIComponent(coding.code)}` +
    (typeof coding.version === 'string' ? `&version=${encodeURIComponent(coding.version)}` : '');
  let r;
  try {
    r = await tx.get(`/CodeSystem/$lookup?${q}`);
  } catch (e) {
    if (tx.log) {
      tx.log.error(`IPS module: the terminology server could not be reached: ${e.message}`);
    }
    return null;
  }
  if (r?.resource?.resourceType !== 'Parameters') {
    return null;
  }
  const display = (r.resource.parameter || []).find(p => p?.name === 'display');
  return typeof display?.valueString === 'string' && display.valueString ? display.valueString : null;
}

/**
 * Narrative: generate the document's narrative with the IPS presenter, after translation
 * (so the translated codings are in it) and before validation (so the validator sees it).
 * The narrative is kept as the step's result (the whole document, and each section), and
 * written into the analysed copy as the Composition's and each section's text.
 */
const narrative = {
  name: 'narrative',
  async run(row, project, module) {
    if (!row.analysed) {
      throw new Error('No analysed copy of the document to write to');
    }
    const started = Date.now();
    const cache = module.txCache || (module.txCache = new Map());
    const budget = { left: MAX_LOOKUPS_PER_DOCUMENT };
    const counts = { lookups: 0 };
    // displays from the terminology server, if there is one: cached, bounded
    const lookup = module.tx ? async (coding) => {
      const key = `lookup|${coding.system}|${coding.version || ''}|${coding.code}`;
      if (cache.has(key)) {
        return cache.get(key);
      }
      if (budget.left <= 0) {
        return null;
      }
      budget.left--;
      counts.lookups++;
      const display = await lookupDisplay(module.tx, coding);
      if (cache.size >= MAX_CACHED_ANSWERS) {
        cache.delete(cache.keys().next().value);
      }
      cache.set(key, display);
      return display;
    } : null;
    const presenter = new Presenter({ lookup });
    const out = await presenter.render(row.analysed);
    const composition = row.analysed.entry?.[0]?.resource;
    if (composition && composition.resourceType === 'Composition') {
      composition.text = { status: 'generated', div: out.header };
      for (const s of out.sections) {
        s.section.text = { status: 'generated', div: s.html };
      }
    }
    module.store.saveResult(row.id, 'narrative', {
      ms: Date.now() - started,
      lookups: counts.lookups,
      html: out.html,
      sections: out.sections.map(s => ({ title: s.title, level: s.level, html: s.html }))
    });
    return `narrative: ${out.sections.length} section${out.sections.length === 1 ? '' : 's'}` + (counts.lookups ? ` (${counts.lookups} display lookup${counts.lookups === 1 ? '' : 's'})` : '');
  }
};

// ---- the AI assessment --------------------------------------------------------------------

// what the document can be, as JSON, before it is too big to send
const DEFAULT_AI_MAX_BYTES = 300000;
const DEFAULT_AI_DAILY_CAP = 50;
// what is kept of the model's raw answer
const MAX_RAW_ANSWER = 64 * 1024;
const GRADES = ['A', 'B', 'C', 'D', 'F'];
const SEVERITIES = ['high', 'medium', 'low'];

const AI_SYSTEM_PROMPT = `You are a clinical informatics reviewer assessing an International Patient Summary (IPS), a FHIR R4 document Bundle in JSON.
The document has been processed: some CodeableConcepts carry codings that were added by translation (with an extension whose url ends in /ips-translation), and most carry an extension (url ending in /ips-valueset-check) recording whether a coding is in the value set preferred for international exchange ('in'), only in an international terminology ('international'), in neither ('not-in'), or could not be checked ('unknown').

Assess the document in two ways:
1. As a whole, for consistency and integrity: do its details agree with each other and with the overall picture of the patient (ages and dates, sexes, problems against medications and procedures, allergies against medications, results against problems, immunizations against age, and so on)? Is anything missing that a summary of this patient would be expected to have, or that one part of the document implies another part should hold?
2. Its terminology: are the codes consistent with each other and with the text and displays they sit beside? Are any codes wrong, contradictory, in the wrong element, duplicated with different meanings, or failing the international check in a way that matters clinically? Mention specific codes as system|code.

Be concrete and brief. Do not restate the document. Do not invent findings: when the document is consistent, say so.
`;

const AI_NARRATIVE_PROMPT = `The narratives (the text.div of the Composition, its sections and the resources) are as the sender wrote them - they have not been generated from the structured data. A third, important assessment: what does the narrative say that the structured data does not back up, and what does the structured data hold that the narrative leaves out or contradicts? Report these as consistency findings, saying which it is.
`;

const AI_NO_NARRATIVE_PROMPT = `The narratives have been removed from the document to save space.
`;

const AI_ANSWER_PROMPT = `

Answer with a single JSON object and nothing else, of this shape:
{
  "grade": "A" | "B" | "C" | "D" | "F",
  "summary": "two or three sentences on the document as a whole",
  "consistency": [{ "severity": "high" | "medium" | "low", "finding": "...", "where": "the resource or section it concerns" }],
  "missing": ["..."],
  "terminology": [{ "severity": "high" | "medium" | "low", "finding": "...", "codes": ["system|code"] }]
}
Grade A: consistent and complete; B: minor issues; C: issues a clinician should notice; D: significant inconsistencies; F: not usable as a summary. Empty arrays are fine.`;

/** The whole system prompt, with or without the narrative's part. */
function aiSystemPrompt(withNarrative) {
  return AI_SYSTEM_PROMPT + (withNarrative ? AI_NARRATIVE_PROMPT : AI_NO_NARRATIVE_PROMPT) + AI_ANSWER_PROMPT;
}

/**
 * The document as the model sees it: the analysed copy, either without any narrative, or
 * with the narratives as the sender wrote them (from the master: the analysed copy's were
 * generated by the narrative step). The two copies have the same entries and sections, in
 * the same order, so the narratives are matched by position.
 */
function documentForAi(analysed, master = null) {
  const copy = structuredClone(analysed);
  const strip = (node) => {
    if (Array.isArray(node)) {
      node.forEach(strip);
    } else if (node && typeof node === 'object') {
      if (node.text && typeof node.text === 'object' && typeof node.text.div === 'string') {
        delete node.text;
      }
      Object.values(node).forEach(strip);
    }
  };
  strip(copy);
  if (!master) {
    return copy;
  }
  const narrative = (from, to) => {
    if (from && typeof from === 'object' && from.text && typeof from.text === 'object' && typeof from.text.div === 'string' && to && typeof to === 'object') {
      to.text = { status: from.text.status, div: from.text.div };
    }
  };
  const sections = (from, to) => {
    const a = Array.isArray(from?.section) ? from.section : [];
    const b = Array.isArray(to?.section) ? to.section : [];
    for (let i = 0; i < a.length && i < b.length; i++) {
      narrative(a[i], b[i]);
      sections(a[i], b[i]);
    }
  };
  const a = Array.isArray(master.entry) ? master.entry : [];
  const b = Array.isArray(copy.entry) ? copy.entry : [];
  for (let i = 0; i < a.length && i < b.length; i++) {
    narrative(a[i]?.resource, b[i]?.resource);
    if (a[i]?.resource?.resourceType === 'Composition') {
      sections(a[i].resource, b[i].resource);
    }
  }
  return copy;
}

/** The model's answer, tidied into what the view expects (anything odd dropped). */
function assessmentOf(json) {
  if (!json || typeof json !== 'object') {
    return null;
  }
  const str = (v, max = 2000) => (typeof v === 'string' ? v.substring(0, max) : '');
  const sev = (v) => (SEVERITIES.includes(v) ? v : 'medium');
  const grade = typeof json.grade === 'string' ? json.grade.trim().toUpperCase().charAt(0) : '';
  return {
    grade: GRADES.includes(grade) ? grade : null,
    summary: str(json.summary, 4000),
    consistency: (Array.isArray(json.consistency) ? json.consistency : []).filter(x => x && typeof x === 'object').slice(0, 100)
      .map(x => ({ severity: sev(x.severity), finding: str(x.finding), where: str(x.where, 300) })).filter(x => x.finding),
    missing: (Array.isArray(json.missing) ? json.missing : []).slice(0, 100).map(x => (typeof x === 'string' ? x : (x && typeof x === 'object' ? str(x.finding || x.item) : ''))).filter(Boolean).map(x => x.substring(0, 2000)),
    terminology: (Array.isArray(json.terminology) ? json.terminology : []).filter(x => x && typeof x === 'object').slice(0, 100)
      .map(x => ({ severity: sev(x.severity), finding: str(x.finding), codes: (Array.isArray(x.codes) ? x.codes : []).filter(c => typeof c === 'string').slice(0, 20).map(c => c.substring(0, 300)) })).filter(x => x.finding)
  };
}

/**
 * AI: the analysed document (narratives stripped) goes to the project's AI service - or
 * the server's default one - to be graded for consistency and integrity, and for its
 * terminology. The project must have turned the assessment on; a project with no account
 * of its own uses the server's; a project over its daily cap, or a document too big to
 * send, is skipped with a note (the step does not fail). The assessment, and what the
 * model answered, is the step's result, for the AI view.
 */
// ---- clinical profiles -----------------------------------------------------------------

// a constraint's evaluation that takes longer than this is reported as an error
const CONSTRAINT_TIMEOUT_MS = 60000;

/** The value sets an expression names in entryIn() or resourcesIn(). */
function valueSetsIn(expression) {
  const out = [];
  const re = /\b(?:entryIn|resourcesIn)\s*\(\s*'((?:[^'\\]|\\.)*)'/g;
  for (let m = re.exec(expression); m; m = re.exec(expression)) {
    out.push(m[1].replace(/\\(.)/g, '$1'));
  }
  return out;
}

/**
 * One constraint on the document: passed, failed, or not checked - an error in the
 * expression, or a value set the terminology server couldn't answer for (a failure for
 * that reason isn't the document's).
 * @returns {Promise<{passed: boolean, reason?: 'failed'|'unresolved'|'error', message?: string}>}
 */
async function checkConstraint(doc, constraint, session) {
  let result;
  let timer;
  try {
    result = await Promise.race([
      evaluateAsync(doc, constraint.expression, { membership: session.membership }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`took longer than ${CONSTRAINT_TIMEOUT_MS / 1000} seconds`)), CONSTRAINT_TIMEOUT_MS);
      })
    ]);
  } catch (e) {
    return { passed: false, reason: 'error', message: String(e.message || e).split('\n')[0].substring(0, 300) };
  } finally {
    clearTimeout(timer);
  }
  // true, and only true, passes (as a FHIR invariant must evaluate to true)
  if (Array.isArray(result) && result.length === 1 && result[0] === true) {
    return { passed: true };
  }
  const unresolved = valueSetsIn(constraint.expression).filter(url => session.problems.has(url));
  if (unresolved.length) {
    return { passed: false, reason: 'unresolved', message: unresolved.map(url => `${url}: ${session.problems.get(url)}`).join('; ') };
  }
  return { passed: false, reason: 'failed' };
}

/**
 * Profiles: the document against each clinical profile. Every constraint is evaluated on
 * the analysed copy (so the translations count); the profile's outcome is 'conforms' when
 * all pass, 'fails' when any plainly fails, and 'unknown' when the only failures are ones
 * that couldn't be checked. Value set membership is asked of the terminology server, once
 * per question for the whole document (one membership session across the profiles). The
 * profiles are as they are when the document is processed: the result keeps their titles
 * and the failed constraints' descriptions.
 */
const profilesStep = {
  name: 'profiles',
  async run(row, project, module) {
    const started = Date.now();
    const doc = row.analysed || row.bundle;
    const list = module.store.profiles();
    const session = module.membershipSession();
    const results = [];
    for (const p of list) {
      const sd = module.store.profile(p.id);
      const constraints = sd?.differential?.element?.[0]?.constraint || [];
      const failed = [];
      for (const c of constraints) {
        if (typeof c?.expression !== 'string') {
          continue;
        }
        const r = await checkConstraint(doc, c, session);
        if (!r.passed) {
          failed.push({ key: c.key, human: c.human || c.key, reason: r.reason, ...(r.message ? { message: r.message } : {}) });
        }
      }
      const outcome = failed.length === 0 ? 'conforms' : (failed.some(f => f.reason === 'failed') ? 'fails' : 'unknown');
      results.push({ id: sd.id, url: sd.url, title: sd.title, constraints: constraints.length, outcome, failed });
    }
    module.store.saveResult(row.id, 'profiles', { ms: Date.now() - started, questions: session.questions, profiles: results, unresolved: session.unresolved() });
    if (results.length === 0) {
      return 'profiles: none defined';
    }
    const n = (o) => results.filter(r => r.outcome === o).length;
    return `profiles: ${n('conforms')} conform, ${n('fails')} do not` + (n('unknown') ? `, ${n('unknown')} could not be fully checked` : '');
  }
};

const aiStep = {
  name: 'ai',
  async run(row, project, module) {
    if (!row.analysed) {
      throw new Error('No analysed copy of the document to assess');
    }
    const started = Date.now();
    const settings = module.store.projectAi(project);
    const skip = (reason) => {
      module.store.saveResult(row.id, 'ai', { ms: Date.now() - started, skipped: reason });
      return `ai: ${reason}`;
    };
    if (settings.enabled !== true) {
      return skip('not enabled for this project');
    }
    const resolved = module.aiAccountFor(project);
    if (!resolved) {
      return skip('no AI account: the project has none and the server has no default (modules.ips.ai)');
    }
    const cfg = module.config.ai || {};
    const cap = Number.isInteger(settings.dailyCap) ? settings.dailyCap : (Number.isInteger(cfg.dailyCap) ? cfg.dailyCap : DEFAULT_AI_DAILY_CAP);
    const since = Date.now() - 24 * 60 * 60 * 1000;
    if (cap >= 0 && module.store.aiCallsSince(project.id, since) >= cap) {
      return skip(`the project's daily cap of ${cap} assessments is spent`);
    }
    // the narratives as submitted, when the project (else the server) says so
    const withNarrative = typeof settings.sendNarrative === 'boolean' ? settings.sendNarrative : cfg.sendNarrative === true;
    const payload = JSON.stringify(documentForAi(row.analysed, withNarrative ? row.bundle : null));
    const maxBytes = Number.isInteger(cfg.maxBytes) && cfg.maxBytes > 0 ? cfg.maxBytes : DEFAULT_AI_MAX_BYTES;
    if (Buffer.byteLength(payload, 'utf8') > maxBytes) {
      return skip(`the document is too big to send (${Buffer.byteLength(payload, 'utf8')} bytes; the limit is ${maxBytes})`);
    }
    const callId = module.store.recordAiCall(project.id);
    const answer = await ai.complete(resolved.account, {
      system: aiSystemPrompt(withNarrative),
      user: `Assess this IPS document:\n\n${payload}`,
      maxTokens: Number.isInteger(cfg.maxTokens) ? cfg.maxTokens : undefined,
      timeoutMs: Number.isInteger(cfg.timeout) ? cfg.timeout * 1000 : undefined,
      fetch: module.aiFetch || undefined
    });
    const assessment = assessmentOf(ai.jsonIn(answer.text));
    // the cost: what the service said, else from the price list (the project's, else the server's)
    const cost = ai.costOf(answer.usage, answer.model, { ...ai.DEFAULT_PRICES, ...(settings.prices || cfg.prices || {}) });
    module.store.finishAiCall(callId, { model: answer.model, input: answer.usage.input, output: answer.usage.output, cost });
    module.store.saveResult(row.id, 'ai', {
      ms: Date.now() - started,
      provider: answer.provider,
      model: answer.model,
      account: resolved.source,
      withNarrative,
      usage: answer.usage,
      cost,
      truncated: answer.truncated,
      maxTokens: answer.maxTokens,
      bytesSent: Buffer.byteLength(payload, 'utf8'),
      assessment,
      raw: answer.text.length > MAX_RAW_ANSWER ? answer.text.substring(0, MAX_RAW_ANSWER) + '\n...' : answer.text
    });
    if (!assessment) {
      return `ai: ${answer.model} answered, but not with the expected JSON${answer.truncated ? ` - the answer was cut off at ${answer.maxTokens} tokens (modules.ips.ai.maxTokens)` : ''} (see the AI view)`;
    }
    const n = assessment.consistency.length + assessment.missing.length + assessment.terminology.length;
    return `ai: grade ${assessment.grade || '?'}, ${n} finding${n === 1 ? '' : 's'} (${answer.model})`;
  }
};

/** The steps, in order. Only the ones that exist yet. */
const STEPS = [translate, narrative, validation, terminology, profilesStep, aiStep];

module.exports = {
  STEPS, translate, narrative, validation, terminology, profiles: profilesStep, ai: aiStep, checkConstraint, valueSetsIn, lookupDisplay, checkConcept, documentForAi, assessmentOf, aiSystemPrompt, AI_SYSTEM_PROMPT, checkOf, addCheck, stripChecks, translateConcept, translationOf,
  validateCodeInValueSet, validateCodeInSystem, issueCounts, issueSummary,
  IPS_BUNDLE_PROFILE, CHECK_EXTENSION, TRANSLATION_EXTENSION, MAX_CHECKS_PER_DOCUMENT, MAX_CACHED_ANSWERS
};
