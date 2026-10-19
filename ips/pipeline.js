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
 *   1. translate     translate CodeableConcepts to the international terminologies        (not yet)
 *   2. narrative     generate the narrative with the module's own rules                   (not yet)
 *   3. validation    validate the document with the FHIR validator (fhir-validator-wrapper)
 *   4. terminology   check each CodeableConcept against the value sets the IPS prefers
 *   5. piqi          measure the quality of the document with PIQI                        (not yet)
 *   6. ai            assess the document for coherence and clinical sense                 (not yet)
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

const IPS_BUNDLE_PROFILE = 'http://hl7.org/fhir/uv/ips/StructureDefinition/Bundle-uv-ips';
const VALIDATE_TIMEOUT_MS = 120000;

// the extension the terminology check leaves on each CodeableConcept in the analysed copy
const CHECK_EXTENSION = 'http://healthintersections.com.au/fhirsmith/StructureDefinition/ips-valueset-check';
// its result codes
const CHECK_RESULTS = ['in', 'not-in', 'unknown'];
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
    const outcome = await v.validate(JSON.stringify(row.bundle), { profiles, checkIpsCodes, timeout: VALIDATE_TIMEOUT_MS });
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
 * with the request (as the operation's valueSet parameter), and so do the IPS value sets it
 * includes (as tx-resource parameters), so the server needn't know the IPS.
 *
 * @returns {Promise<{result: boolean|null, message: string|null}>} null when the server
 *   didn't say true or false
 */
async function validateCodeInValueSet(tx, bindings, valueSetUrl, coding) {
  const vs = bindings.valueSet(valueSetUrl) || (typeof bindings.fetchValueSet === 'function' ? await bindings.fetchValueSet(valueSetUrl) : null);
  const params = { resourceType: 'Parameters', parameter: [] };
  if (vs) {
    params.parameter.push({ name: 'valueSet', resource: vs });
    for (const other of bindings.referencedValueSets(valueSetUrl)) {
      params.parameter.push({ name: 'tx-resource', resource: other });
    }
  } else {
    params.parameter.push({ name: 'url', valueUri: valueSetUrl });
  }
  const c = { system: coding.system, code: coding.code };
  if (typeof coding.version === 'string') {
    c.version = coding.version;
  }
  if (typeof coding.display === 'string') {
    c.display = coding.display;
  }
  params.parameter.push({ name: 'coding', valueCoding: c });
  let r;
  try {
    r = await tx.post('/ValueSet/$validate-code', params);
  } catch (e) {
    // the detail (host, port, path) is for the log, not the page
    if (tx.log) {
      tx.log.error(`IPS module: the terminology server could not be reached: ${e.message}`);
    }
    return { result: null, message: 'The terminology server could not be reached' };
  }
  const res = r.resource;
  const issueText = (oo) => (Array.isArray(oo?.issue) ? oo.issue : []).map(i => i?.details?.text || i?.diagnostics).filter(Boolean).join('; ');
  if (res?.resourceType === 'Parameters') {
    const result = (res.parameter || []).find(p => p?.name === 'result');
    if (result && typeof result.valueBoolean === 'boolean') {
      const message = (res.parameter || []).find(p => p?.name === 'message');
      return { result: result.valueBoolean, message: typeof message?.valueString === 'string' ? message.valueString : null };
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
 * Is any coding of a CodeableConcept in any of the value sets? Answers are cached on the
 * module (module.txCache) across documents.
 *
 * @returns {Promise<{result: 'in'|'not-in'|'unknown', valueSet?: string, coding?: Object, message: string}>}
 */
async function checkConcept(module, concept, candidates, budget = { left: Infinity }) {
  const codings = (Array.isArray(concept.coding) ? concept.coding : [])
    .filter(c => c && typeof c === 'object' && typeof c.system === 'string' && typeof c.code === 'string');
  if (codings.length === 0) {
    return { result: 'not-in', message: 'The concept has no codings' };
  }
  const cache = module.txCache || (module.txCache = new Map());
  const remember = (key, answer) => {
    if (cache.size >= MAX_CACHED_ANSWERS) {
      // the oldest goes: a Map iterates in insertion order
      cache.delete(cache.keys().next().value);
    }
    cache.set(key, answer);
  };
  const unknowns = [];
  for (const b of candidates) {
    if (b.pattern) {
      // a fixed or pattern value: a value set of one (or a few), answered here
      const coding = codings.find(c => b.pattern.some(p => p.code === c.code && (!p.system || p.system === c.system)));
      if (coding) {
        return { result: 'in', pattern: b.pattern, coding, message: `${coding.system}|${coding.code} is the code the profile ${b.profile} fixes` };
      }
      continue;
    }
    for (const coding of codings) {
      const key = `${b.valueSet}|${coding.system}|${coding.version || ''}|${coding.code}`;
      let answer = cache.get(key);
      if (answer === undefined) {
        if (budget.left <= 0) {
          unknowns.push(`${coding.system}|${coding.code} in ${b.valueSet}: not checked - the document has more codes than are checked (${MAX_CHECKS_PER_DOCUMENT})`);
          continue;
        }
        budget.left--;
        answer = await validateCodeInValueSet(module.tx, module.ipsBindings, b.valueSet, coding);
        // a server that could not answer is asked again next time; true and false are kept
        if (answer.result !== null) {
          remember(key, answer);
        }
      }
      if (answer.result === true) {
        return { result: 'in', valueSet: b.valueSet, coding, message: `${coding.system}|${coding.code} is in ${b.valueSet}` };
      }
      if (answer.result === null) {
        unknowns.push(`${coding.system}|${coding.code} in ${b.valueSet}: ${answer.message}`);
      }
    }
  }
  if (unknowns.length > 0) {
    return { result: 'unknown', message: 'Could not be determined - ' + unknowns.join('; ') };
  }
  return { result: 'not-in', message: 'No coding is in ' + candidates.map(b => b.valueSet || `the fixed code ${b.pattern.map(p => `${p.system || ''}|${p.code}`).join(', ')}`).join(' or ') };
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
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
    valueSets: sub('valueSet').map(e => e.valueCanonical).filter(v => typeof v === 'string'),
    patterns: sub('pattern').map(e => e.valueCoding).filter(isObject),
    coding: sub('coding')[0]?.valueCoding || null,
    message: sub('message')[0]?.valueString || null
  };
}

/**
 * Remove the check's extensions from a document - a resubmitted analysed copy carries the
 * last run's; the analysed copy starts clean.
 */
function stripChecks(node) {
  if (Array.isArray(node)) {
    node.forEach(stripChecks);
  } else if (node && typeof node === 'object') {
    if (Array.isArray(node.extension)) {
      node.extension = node.extension.filter(e => e?.url !== CHECK_EXTENSION);
      if (node.extension.length === 0) {
        delete node.extension;
      }
    }
    Object.values(node).forEach(stripChecks);
  }
  return node;
}

/** Write the check's extension onto a CodeableConcept (in the analysed copy). */
function addCheck(concept, outcome, candidates) {
  const ext = { url: CHECK_EXTENSION, extension: [{ url: 'result', valueCode: outcome.result }] };
  // what it was checked against: the one that matched, else all of them
  const against = outcome.result === 'in' ? [outcome.valueSet ? { valueSet: outcome.valueSet } : { pattern: outcome.pattern }] : candidates;
  for (const c of against) {
    if (c.valueSet) {
      ext.extension.push({ url: 'valueSet', valueCanonical: c.valueSet });
    } else {
      for (const p of c.pattern) {
        ext.extension.push({ url: 'pattern', valueCoding: p });
      }
    }
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
 * against the value sets the IPS profiles bind to its element (ips-bindings.js): is any of
 * its codings in any of them? The answer goes on the concept in the analysed copy as an
 * extension - in, not-in, or unknown when the server could not say.
 */
const terminology = {
  name: 'terminology',
  async run(row, project, module) {
    if (!module.tx) {
      throw new Error('No terminology server is configured (modules.ips.txServer)');
    }
    const bindings = module.ipsBindings;
    if (!bindings || !bindings.loaded) {
      throw new Error('The IPS package has not been loaded');
    }
    if (!row.analysed) {
      throw new Error('No analysed copy of the document to write to');
    }
    const t = terminologyOf(row.analysed);
    const concepts = t.composition.map(c => ({ ...c, context: {} }));
    for (const s of t.sections) {
      // the section's code, for the profiles the IPS says its entries conform to
      const coding = (Array.isArray(s.code?.coding) ? s.code.coding : []).find(c => isObject(c) && typeof c.code === 'string');
      const context = coding ? { sectionCode: `${coding.system || ''}|${coding.code}` } : {};
      for (const e of s.entries) {
        concepts.push(...e.concepts.map(c => ({ ...c, context })));
      }
    }
    const counts = { in: 0, 'not-in': 0, unknown: 0, unbound: 0 };
    const budget = { left: MAX_CHECKS_PER_DOCUMENT };
    // the same concept (same codings, same candidates) is answered once per document
    const answered = new Map();
    for (const c of concepts) {
      if (checkOf(c.concept)) {
        continue; // the same resource in two sections
      }
      const candidates = bindings.bindingsFor(c.element, c.context);
      if (candidates.length === 0) {
        counts.unbound++;
        continue;
      }
      const key = JSON.stringify([c.concept.coding, candidates]);
      let outcome = answered.get(key);
      if (!outcome) {
        outcome = await checkConcept(module, c.concept, candidates, budget);
        answered.set(key, outcome);
      }
      addCheck(c.concept, outcome, candidates);
      counts[outcome.result]++;
    }
    return `terminology: ${counts.in} in, ${counts['not-in']} not in, ${counts.unknown} unknown` +
      (counts.unbound ? ` (${counts.unbound} with no IPS binding)` : '');
  }
};

/** The steps, in order. Only the ones that exist yet. */
const STEPS = [validation, terminology];

module.exports = {
  STEPS, validation, terminology, checkConcept, checkOf, addCheck, stripChecks, validateCodeInValueSet,
  issueCounts, issueSummary, IPS_BUNDLE_PROFILE, CHECK_EXTENSION, MAX_CHECKS_PER_DOCUMENT, MAX_CACHED_ANSWERS
};
