//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * Two FHIRPath functions for IPS documents, for fhirpath.js (a user invocation table):
 *
 *   section(system, code [, min, max])
 *     The input: documents (Bundles) or Compositions. On a document, section() moves into
 *     its Composition (the Bundle's first Composition entry) by itself, so the rules of a
 *     clinical profile, which are on the document, can say Bundle.section(...). For each
 *     input, the Composition's sections, nested ones too, whose
 *     code has a coding with that system and code. When the number found is within
 *     min..max, they are all in the output; when it is not, none of that item's are.
 *
 *   entry(system, code [, min, max])
 *     The input: sections (usually from section(), but any section will do). For each,
 *     its entries, resolved, whose code (code, medicationCodeableConcept or vaccineCode)
 *     has a coding with that system and code. Within min..max, they are all in the
 *     output; otherwise none of that section's are.
 *
 *   resources(system, code [, type])
 *     The input: documents (Bundles), or anything in one (a Composition, say). Every
 *     resource in the Bundle whose code (as entry() matches it) has a coding with that
 *     system and code - and, when a type is given, that is of that type (Condition...).
 *
 *   entryIn(valueSet [, min, max])
 *   resourcesIn(valueSet [, type])
 *     As entry() and resources(), with the code in a value set (a canonical, with |version
 *     or not) rather than a given code: a resource is in when any coding of its code is.
 *     Whether a code is in a value set is the caller's membership() (ipsFunctions), which
 *     usually asks a terminology server - asynchronously, so the evaluation must be
 *     (evaluateAsync); answers are best cached (membership.js).
 *
 *   isKnown(), hasData()
 *     The input: sections. isKnown(): each has no emptyReason, or a nil known one
 *     (list-empty-reason#nilknown) - any other emptyReason is not known. hasData(): each has an
 *     emptyReason, or else entries. Empty on no input; false for an item that isn't a section
 *     of a Composition (the one above it, or the document's).
 *
 *   sameSubject([other])
 *     On a section: true when it has no focus, otherwise whether the focus is the subject of
 *     other - or, without other, of its Composition. On a resource: whether its subject (or
 *     patient) is other's - or, without other, the document's Composition's (the evaluation
 *     must be on a Bundle of type document). Empty when the input isn't one item, other is
 *     given but isn't one item, or a subject is missing (or more than one). References are the
 *     same when their reference strings are identical (both having one), else when their
 *     identifiers' system and value are (both having one); otherwise not. (other is evaluated
 *     as fhirpath.js does a function's argument, from the root: use %resource.)
 *
 *   These are the Java DocumentFunctions' (org.hl7.fhir.core), which the validator runs.
 *
 * min and max are optional (together): with neither, section() is 1..1 (one such section:
 * two of the same is none) and entry() and entryIn() are 0..* (no constraint), as in the Java
 * DocumentFunctions; max may be '*'. Being outside the bounds is not an error - the item adds nothing.
 *
 * References are resolved in the Bundle the section is in: found by walking up from the
 * section, or else the Bundle the expression was evaluated on (the evaluation's
 * context). A reference is matched to an entry by fullUrl - absolute (urn:uuid:, http..)
 * as is, relative (Type/id) against the base of the Composition's fullUrl, or by type
 * and id when the entries have no usable fullUrl - and '#id' is a contained resource of
 * the Composition. When there is no Bundle, or it doesn't have the resource, the
 * caller's resolve(reference, composition) is asked, when there is one. A medication
 * given by reference (medicationReference) is not followed.
 *
 * @module ips/fhirpath-ips
 */

const fhirpath = require('fhirpath');
const r4Model = require('fhirpath/fhir-context/r4');
const { ResourceNode } = require('fhirpath/src/types.js');

const valData = fhirpath.util.valData;
// the elements of a resource that hold the code entry() matches
const CODE_ELEMENTS = ['code', 'medicationCodeableConcept', 'vaccineCode'];

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** A number as fhirpath.js gives it (an integer literal is one of its decimals), as a JS number. */
function num(v) {
  return v && typeof v === 'object' && typeof v.toNumber === 'function' ? v.toNumber() : v;
}

/**
 * min and max from the arguments: min an Integer, max an Integer or '*'; without them, the
 * function's default (section(): 1..1; the others: 0..*), as the Java DocumentFunctions has them.
 */
function bounds(fnName, min, max, defaults = { min: 0, max: Infinity }) {
  if (min === undefined) {
    return { ...defaults };
  }
  min = num(min);
  if (!Number.isInteger(min) || min < 0) {
    throw new Error(`${fnName}(): min must be a non-negative integer`);
  }
  const m = Array.isArray(max) ? max.map(valData) : [max];
  if (m.length !== 1) {
    throw new Error(`${fnName}(): max must be an integer or '*'`);
  }
  const v = num(m[0]);
  if (v === '*') {
    return { min, max: Infinity };
  }
  if (!Number.isInteger(v)) {
    throw new Error(`${fnName}(): max must be an integer or '*'`);
  }
  if (v < min) {
    throw new Error(`${fnName}(): max must be an integer no less than min, or '*'`);
  }
  return { min, max: v };
}

/** Whether a CodeableConcept has a coding with the system and code. */
function hasCoding(concept, system, code) {
  return isObject(concept) && Array.isArray(concept.coding) &&
    concept.coding.some(c => isObject(c) && c.system === system && c.code === code);
}

/** The nearest node above (or at) a node whose data is a resource of the type. */
function ancestor(node, resourceType) {
  for (let n = node; n; n = n.parentResNode) {
    if (n instanceof ResourceNode && valData(n)?.resourceType === resourceType) {
      return n;
    }
  }
  return null;
}

/** The Bundle node the evaluation was started on, if it was. */
function rootBundle(ctx) {
  const root = Array.isArray(ctx.dataRoot) ? ctx.dataRoot : [ctx.dataRoot];
  return root.find(n => valData(n)?.resourceType === 'Bundle') || null;
}

/**
 * The Composition for an input item, as a node: the item itself, or a document's first
 * Composition entry (a node under the Bundle's, so the Bundle can be found from it).
 */
function compositionNode(ctx, item) {
  const data = valData(item);
  if (!isObject(data)) {
    return null;
  }
  const node = item instanceof ResourceNode ? item : ResourceNode.makeResNode(ctx, data, null, null, null, null);
  if (data.resourceType === 'Composition') {
    return node;
  }
  if (data.resourceType !== 'Bundle' || !Array.isArray(data.entry)) {
    return null;
  }
  const i = data.entry.findIndex(e => e?.resource?.resourceType === 'Composition');
  if (i < 0) {
    return null;
  }
  const entry = ResourceNode.makeResNode(ctx, data.entry[i], node, 'Bundle.entry', null, 'BackboneElement', 'entry', i);
  return ResourceNode.makeResNode(ctx, data.entry[i].resource, entry, 'Bundle.entry.resource', null, null, 'resource', null);
}

/** All of a node's sections, nested ones after their parent, as nodes. */
function allSections(ctx, parent, out = []) {
  const list = valData(parent)?.section;
  if (!Array.isArray(list)) {
    return out;
  }
  list.forEach((s, i) => {
    if (isObject(s)) {
      const node = ResourceNode.makeResNode(ctx, s, parent, 'Composition.section', null, 'BackboneElement', 'section', i);
      out.push(node);
      allSections(ctx, node, out);
    }
  });
  return out;
}

/** The base of an absolute RESTful fullUrl ([base]/Type/id), or null. */
function baseOf(fullUrl) {
  const m = typeof fullUrl === 'string' ? /^(https?:\/\/.+?\/)[A-Z][A-Za-z]+\/[A-Za-z0-9\-.]{1,64}(\/_history\/[A-Za-z0-9\-.]{1,64})?$/.exec(fullUrl) : null;
  return m ? m[1] : null;
}

/**
 * A reference resolved in a Bundle: the entry index and resource, or null.
 * @param {Object} bundle
 * @param {string} reference
 * @param {string|undefined} fromFullUrl - the fullUrl of the referring resource's entry
 */
function inBundle(bundle, reference, fromFullUrl) {
  const entries = Array.isArray(bundle?.entry) ? bundle.entry : [];
  const ref = reference.replace(/\/_history\/[^/]+$/, '');
  const at = (pred) => {
    const i = entries.findIndex(e => isObject(e) && isObject(e.resource) && pred(e));
    return i < 0 ? null : { index: i, resource: entries[i].resource };
  };
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref)) {
    return at(e => e.fullUrl === ref);
  }
  const m = /^([A-Z][A-Za-z]+)\/([A-Za-z0-9\-.]{1,64})$/.exec(ref);
  if (!m) {
    return null;
  }
  const base = baseOf(fromFullUrl);
  if (base) {
    const found = at(e => e.fullUrl === base + ref);
    if (found) {
      return found;
    }
  }
  // no usable base: an entry with that type and id, whose fullUrl (if any) ends with it
  return at(e => e.resource.resourceType === m[1] && e.resource.id === m[2] &&
    (typeof e.fullUrl !== 'string' || e.fullUrl.endsWith('/' + ref) || !baseOf(e.fullUrl)));
}

/**
 * A section's entries, resolved, as nodes: in the Bundle the section is in (or the one the
 * evaluation was started on), a resource contained in the Composition, or what the
 * caller's resolve() gives. Unresolvable references are left out.
 */
function sectionEntryNodes(ctx, item, resolve) {
  const s = valData(item);
  if (!isObject(s) || !Array.isArray(s.entry)) {
    return null;
  }
  const sectionNode = item instanceof ResourceNode ? item : null;
  const compNode = ancestor(sectionNode, 'Composition');
  const comp = compNode ? valData(compNode) : null;
  const bundleNode = ancestor(sectionNode, 'Bundle') || rootBundle(ctx);
  const bundle = bundleNode ? valData(bundleNode) : null;
  const compEntry = compNode?.parentResNode && valData(compNode.parentResNode);
  const fromFullUrl = isObject(compEntry) && typeof compEntry.fullUrl === 'string' ? compEntry.fullUrl
    : (bundle && comp ? bundle.entry?.find(e => e?.resource === comp)?.fullUrl : undefined);
  const nodes = [];
  for (const ref of s.entry) {
    const reference = isObject(ref) && typeof ref.reference === 'string' ? ref.reference : null;
    if (!reference) {
      continue;
    }
    let node = null;
    if (reference.startsWith('#')) {
      const c = Array.isArray(comp?.contained) ? comp.contained.findIndex(r => isObject(r) && r.id === reference.substring(1)) : -1;
      if (c >= 0) {
        node = ResourceNode.makeResNode(ctx, comp.contained[c], compNode, 'Composition.contained', null, null, 'contained', c);
      }
    } else if (bundle) {
      const r = inBundle(bundle, reference, fromFullUrl);
      if (r) {
        const e = ResourceNode.makeResNode(ctx, bundle.entry[r.index], bundleNode, 'Bundle.entry', null, 'BackboneElement', 'entry', r.index);
        node = ResourceNode.makeResNode(ctx, r.resource, e, 'Bundle.entry.resource', null, null, 'resource', null);
      }
    }
    if (!node && resolve) {
      const r = resolve(reference, comp);
      if (isObject(r) && r.resourceType) {
        node = ResourceNode.makeResNode(ctx, r, null, null, null, null);
      }
    }
    if (node) {
      nodes.push(node);
    }
  }
  return nodes;
}

/** The resources of the documents the inputs are (or are in), as nodes; each document once. */
function documentResourceNodes(ctx, inputs, fnName, type) {
  if (type !== undefined && (typeof type !== 'string' || !/^[A-Z][A-Za-z]{1,63}$/.test(type))) {
    throw new Error(`${fnName}(): type must be a resource type`);
  }
  const out = [];
  const seen = new Set();
  for (const item of inputs) {
    const data = valData(item);
    const node = item instanceof ResourceNode ? item : (isObject(data) ? ResourceNode.makeResNode(ctx, data, null, null, null, null) : null);
    const bundleNode = data?.resourceType === 'Bundle' ? node : (ancestor(node, 'Bundle') || rootBundle(ctx));
    const bundle = bundleNode ? valData(bundleNode) : null;
    if (!bundle || seen.has(bundle) || !Array.isArray(bundle.entry)) {
      continue;
    }
    seen.add(bundle);
    bundle.entry.forEach((e, i) => {
      const r = isObject(e) ? e.resource : null;
      if (!isObject(r) || (type && r.resourceType !== type)) {
        return;
      }
      const en = ResourceNode.makeResNode(ctx, e, bundleNode, 'Bundle.entry', null, 'BackboneElement', 'entry', i);
      out.push(ResourceNode.makeResNode(ctx, r, en, 'Bundle.entry.resource', null, null, 'resource', null));
    });
  }
  return out;
}

/** A value set's canonical, as entryIn() and resourcesIn() take it: a URL, with |version or not. */
function checkCanonical(fnName, url) {
  if (typeof url !== 'string' || !/^[a-z][a-z0-9+.-]*:[^\s|]{1,250}(\|[^\s|]{1,64})?$/i.test(url)) {
    throw new Error(`${fnName}(): the value set must be a canonical URL (optionally with |version)`);
  }
}

/**
 * Of the nodes, those with a code (code, medicationCodeableConcept or vaccineCode) in the
 * value set, as membership() says. membership(url, concept) answers true or false, or null
 * when it can't tell (which is not a member), at once or as a Promise. Synchronous answers
 * give a synchronous result; any Promise makes the result one, which fhirpath.js accepts
 * only when the evaluation is asynchronous.
 */
function membersOf(ctx, fnName, nodes, url, membership) {
  const asks = nodes.map(n => {
    const r = valData(n);
    const concepts = CODE_ELEMENTS.map(el => r[el]).filter(c => isObject(c) && Array.isArray(c.coding) && c.coding.length);
    return concepts.map(c => membership(url, c));
  });
  const isMember = (answers) => answers.some(a => a === true);
  if (!asks.some(list => list.some(a => a && typeof a.then === 'function'))) {
    return nodes.filter((n, i) => isMember(asks[i]));
  }
  fhirpath.util.checkAllowAsync(ctx, fnName);
  return Promise.all(asks.map(list => Promise.all(list))).then(answers => nodes.filter((n, i) => isMember(answers[i])));
}

/**
 * The fhirpath.js user invocation table with section(), entry(), resources(), entryIn()
 * and resourcesIn().
 *
 * @param {{resolve?: function(string, Object): (Object|null), membership?: function(string, Object): (boolean|null|Promise<boolean|null>)}} [options]
 *   resolve: for references that aren't in a Bundle; given the reference and the
 *   Composition, it returns the resource or null. membership: whether a CodeableConcept is
 *   in a value set (a canonical) - without it, entryIn() and resourcesIn() find nothing
 */
// ---- the section checks, and sameSubject() --------------------------------------------------

const LIST_EMPTY_REASON = 'http://terminology.hl7.org/CodeSystem/list-empty-reason';

/** Whether data is one of a Composition's sections, at any depth (by identity). */
function isSectionOf(comp, data) {
  const walk = (list) => Array.isArray(list) && list.some(s => s === data || (isObject(s) && walk(s.section)));
  return isObject(comp) && walk(comp.section);
}

/**
 * The Composition an item is a section of, at any depth: the one above it, or the document's
 * the evaluation is on (or the Composition it is on) - null when the item isn't a section of one.
 */
function sectionComposition(ctx, item) {
  const data = valData(item);
  if (!isObject(data) || data.resourceType) {
    return null;
  }
  const above = item instanceof ResourceNode ? ancestor(item, 'Composition') : null;
  if (above && isSectionOf(valData(above), data)) {
    return valData(above);
  }
  const roots = Array.isArray(ctx.dataRoot) ? ctx.dataRoot : [ctx.dataRoot];
  for (const r of roots) {
    const comp = compositionNode(ctx, r);
    if (comp && isSectionOf(valData(comp), data)) {
      return valData(comp);
    }
  }
  return null;
}

/** A resource's subject (or patient), when it has one: null when it has neither, or more than one (R5+ Composition.subject repeats). */
function subjectOf(resource) {
  if (!isObject(resource)) {
    return null;
  }
  const s = resource.subject !== undefined ? resource.subject : resource.patient;
  const list = Array.isArray(s) ? s : (s === undefined ? [] : [s]);
  return list.length === 1 && isObject(list[0]) ? list[0] : null;
}

/**
 * Whether two references are to the same thing: identical reference strings, when both have one;
 * else, when both have an identifier, the same system and value; otherwise false.
 */
function sameReference(a, b) {
  const refA = typeof a.reference === 'string' ? a.reference : '';
  const refB = typeof b.reference === 'string' ? b.reference : '';
  if (refA && refB) {
    return refA === refB;
  }
  if (isObject(a.identifier) && isObject(b.identifier)) {
    const value = a.identifier.value;
    return typeof value === 'string' && value !== '' && value === b.identifier.value && a.identifier.system === b.identifier.system;
  }
  return false;
}

function ipsFunctions(options = {}) {
  const resolve = typeof options.resolve === 'function' ? options.resolve : null;
  const membership = typeof options.membership === 'function' ? options.membership : () => false;

  function section(inputs, system, code, min, max) {
    const ctx = this;
    const b = bounds('section', min, max, { min: 1, max: 1 });
    const out = [];
    for (const item of inputs) {
      const comp = compositionNode(ctx, item);
      if (!comp) {
        continue;
      }
      const found = allSections(ctx, comp).filter(s => hasCoding(valData(s).code, system, code));
      if (found.length >= b.min && found.length <= b.max) {
        out.push(...found);
      }
    }
    return out;
  }

  const hasCode = (system, code) => (node) => CODE_ELEMENTS.some(el => hasCoding(valData(node)[el], system, code));
  const within = (b, found) => (found.length >= b.min && found.length <= b.max ? found : []);

  function entry(inputs, system, code, min, max) {
    const ctx = this;
    const b = bounds('entry', min, max);
    const out = [];
    for (const item of inputs) {
      const nodes = sectionEntryNodes(ctx, item, resolve);
      if (nodes) {
        out.push(...within(b, nodes.filter(hasCode(system, code))));
      }
    }
    return out;
  }

  function entryIn(inputs, valueSet, min, max) {
    const ctx = this;
    checkCanonical('entryIn', valueSet);
    const b = bounds('entryIn', min, max);
    const found = inputs.map(item => sectionEntryNodes(ctx, item, resolve)).filter(Boolean).map(nodes => membersOf(ctx, 'entryIn', nodes, valueSet, membership));
    if (!found.some(f => typeof f.then === 'function')) {
      return found.flatMap(f => within(b, f));
    }
    return Promise.all(found).then(all => all.flatMap(f => within(b, f)));
  }

  function resources(inputs, system, code, type) {
    return documentResourceNodes(this, inputs, 'resources', type).filter(hasCode(system, code));
  }

  function resourcesIn(inputs, valueSet, type) {
    checkCanonical('resourcesIn', valueSet);
    return membersOf(this, 'resourcesIn', documentResourceNodes(this, inputs, 'resourcesIn', type), valueSet, membership);
  }

  const arity = { 2: ['String', 'String'], 4: ['String', 'String', 'Integer', 'Any'] };
  // internalStructures: the input and output are nodes, so the paths (and the Bundle a
  // section is in) are known; and fhirpath.js calls the function with the context as this
  // isKnown(): each input a section with no emptyReason, or a nil known one
  function isKnown(inputs) {
    if (inputs.length === 0) {
      return [];
    }
    return [inputs.every(item => {
      if (!sectionComposition(this, item)) {
        return false;
      }
      const reason = valData(item).emptyReason;
      return reason === undefined || hasCoding(reason, LIST_EMPTY_REASON, 'nilknown');
    })];
  }

  // hasData(): each input a section with an emptyReason, or else entries
  function hasData(inputs) {
    if (inputs.length === 0) {
      return [];
    }
    return [inputs.every(item => {
      if (!sectionComposition(this, item)) {
        return false;
      }
      const s = valData(item);
      return s.emptyReason !== undefined || (Array.isArray(s.entry) && s.entry.length > 0);
    })];
  }

  // sameSubject([other]): as the Java DocumentFunctions.sameSubject
  function sameSubject(inputs, other) {
    if (inputs.length !== 1) {
      return [];
    }
    if (other !== undefined && other.length !== 1) {
      return [];
    }
    const item = inputs[0];
    const comp = sectionComposition(this, item);
    if (comp) {
      // a section: its focus, if it has one, against the Composition's subject (or other's)
      const focus = valData(item).focus;
      if (!isObject(focus)) {
        return [true];
      }
      const target = subjectOf(other !== undefined ? valData(other[0]) : comp);
      return target ? [sameReference(focus, target)] : [];
    }
    let o;
    if (other !== undefined) {
      o = valData(other[0]);
    } else {
      const bundle = rootBundle(this);
      const doc = bundle ? valData(bundle) : null;
      o = doc && doc.type === 'document' ? valData(compositionNode(this, bundle)) : null;
    }
    const a = subjectOf(valData(item));
    const b = subjectOf(o);
    return a && b ? [sameReference(a, b)] : [];
  }

  return {
    section: { fn: section, arity, internalStructures: true },
    entry: { fn: entry, arity, internalStructures: true },
    resources: { fn: resources, arity: { 2: ['String', 'String'], 3: ['String', 'String', 'String'] }, internalStructures: true },
    entryIn: { fn: entryIn, arity: { 1: ['String'], 3: ['String', 'Integer', 'Any'] }, internalStructures: true },
    resourcesIn: { fn: resourcesIn, arity: { 1: ['String'], 2: ['String', 'String'] }, internalStructures: true },
    isKnown: { fn: isKnown, arity: { 0: [] }, internalStructures: true },
    hasData: { fn: hasData, arity: { 0: [] }, internalStructures: true },
    sameSubject: { fn: sameSubject, arity: { 0: [], 1: ['Any'] }, internalStructures: true }
  };
}

/**
 * Evaluate an expression on a document (or anything else) with the module's functions.
 * Synchronous: a membership() that answers with Promises needs evaluateAsync().
 *
 * @param {Object} resource
 * @param {string} expression
 * @param {{vars?: Object, resolve?: Function, membership?: Function}} [options]
 * @returns {Array} the result, as plain values
 */
function evaluate(resource, expression, options = {}) {
  return fhirpath.evaluate(resource, expression, options.vars || null, r4Model, { userInvocationTable: ipsFunctions(options) });
}

/** As evaluate(), always asynchronous: what a membership() that asks a server needs. */
function evaluateAsync(resource, expression, options = {}) {
  return fhirpath.evaluate(resource, expression, options.vars || null, r4Model, { userInvocationTable: ipsFunctions(options), async: 'always' });
}

module.exports = { ipsFunctions, evaluate, evaluateAsync, hasCoding, inBundle, CODE_ELEMENTS };
