//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * FHIRPath Patch (https://hl7.org/fhir/fhirpatch.html), applied to a copy of a resource.
 *
 * A patch is a Parameters resource with a parameter "operation" for each change, applied in
 * order, each to the result of the one before:
 *
 *   add      path, name, value          adds the element name to the element at path (to the
 *                                       end of the list, if it repeats; an element that doesn't
 *                                       repeat must not be there already)
 *   insert   path, value, index         inserts into the list at path, at index (0 based, at
 *                                       most the list's length)
 *   delete   path                       deletes the element at path, if there is one
 *   replace  path, value                replaces the element at path
 *   move     path, source, destination  moves an item of the list at path
 *
 * Each path is FHIRPath, evaluated (by fhirpath.js) on the resource, and must find one element
 * (or, for insert and move, the whole of one list). A value is a value[x] (whose type must be
 * one the element can have: for a choice element, the type picks the JSON name), a resource,
 * or parts, one per element, for anonymous (backbone) elements and other types Parameters
 * can't carry, as deep as necessary. What an element is - whether it repeats, its types, the
 * elements of the types - comes from the model the XML converter uses (library/fhir-xml.js),
 * derived from the core StructureDefinitions.
 *
 * Primitives are held as JSON holds them: a value, and its id and extensions in "_name" (for a
 * list, "_name" is a list as long as the values, with null where there is nothing). Elements
 * left empty by a delete are taken out.
 *
 * Only applying a patch is supported, not making one.
 *
 * @module rest/library/fhirpath-patch
 */

const fhirpath = require('fhirpath');
const fhirJson = require('../../library/fhir-json');
const { PatchError } = require('./json-patch');

const OPERATIONS = new Set(['add', 'insert', 'delete', 'replace', 'move']);

const ucFirst = (s) => s.charAt(0).toUpperCase() + s.substring(1);
const an = (w) => (/^[aeiou]/.test(w) ? 'an ' : 'a ') + w;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The value[x] of a part or parameter: [suffix, json name] (or null) */
function valueKey(part) {
  for (const k of Object.keys(part)) {
    if (k.startsWith('value') && k.length > 5 && /[A-Z]/.test(k.charAt(5))) {
      return [k.substring(5), k];
    }
  }
  return null;
}

/** An operation's parameters, by name */
function readOperation(p, n) {
  if (!isObject(p) || p.name !== 'operation') {
    throw new PatchError(`Parameter ${n + 1} isn't an operation ('${isObject(p) ? p.name : p}'): a FHIRPath Patch has only operations`);
  }
  const op = {};
  for (const part of p.part || []) {
    if (!isObject(part) || typeof part.name !== 'string') {
      throw new PatchError(`Operation ${n + 1} has a part with no name`);
    }
    if (op[part.name] !== undefined) {
      throw new PatchError(`Operation ${n + 1} has more than one ${part.name}`);
    }
    op[part.name] = part;
  }
  const text = (name, required) => {
    const part = op[name];
    if (!part) {
      if (required) {
        throw new PatchError(`Operation ${n + 1} (${op.type ? text('type') : 'no type'}) needs ${an(name)}`);
      }
      return undefined;
    }
    const vk = valueKey(part);
    if (!vk || typeof part[vk[1]] !== 'string') {
      throw new PatchError(`Operation ${n + 1}: its ${name} must be a string`);
    }
    return part[vk[1]];
  };
  const integer = (name) => {
    const part = op[name];
    const vk = part && valueKey(part);
    const v = vk ? part[vk[1]] : undefined;
    if (!Number.isInteger(v) || v < 0) {
      throw new PatchError(`Operation ${n + 1} (${op.type ? text('type') : 'no type'}) needs ${an(name)}, a whole number, 0 or more`);
    }
    return v;
  };
  const type = text('type', true);
  if (!OPERATIONS.has(type)) {
    throw new PatchError(`Operation ${n + 1}: '${type}' isn't an operation (it can be ${[...OPERATIONS].join(', ')})`);
  }
  const out = { n: n + 1, type, path: text('path', true) };
  if (type === 'add') {
    out.name = text('name', true);
  }
  if (type === 'add' || type === 'insert' || type === 'replace') {
    if (!op.value) {
      throw new PatchError(`Operation ${n + 1} (${type}) needs a value`);
    }
    out.value = op.value;
  }
  if (type === 'insert') {
    out.index = integer('index');
  }
  if (type === 'move') {
    out.source = integer('source');
    out.destination = integer('destination');
  }
  return out;
}

// FHIRPath's keywords that are also the names of elements (Narrative.div): after a '.', they can
// only be names, but fhirpath.js wants them quoted (`div`)
const KEYWORDS = new Set(['div', 'mod', 'and', 'or', 'xor', 'implies', 'is', 'as', 'in', 'contains']);

/** A path, with element names that are keywords quoted (strings and quoted names left alone) */
function quoteNames(path) {
  let out = '';
  let i = 0;
  while (i < path.length) {
    const c = path.charAt(i);
    if (c === '\'' || c === '`' || c === '"') {
      let j = i + 1;
      while (j < path.length && path.charAt(j) !== c) {
        j += path.charAt(j) === '\\' ? 2 : 1;
      }
      out += path.substring(i, j + 1);
      i = j + 1;
    } else if (c === '.') {
      const m = /^\.\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(path.substring(i));
      if (m && KEYWORDS.has(m[1]) && !/^\s*\(/.test(path.substring(i + m[0].length))) {
        out += '.`' + m[1] + '`';
      } else {
        out += m ? m[0] : c;
      }
      i += m ? m[0].length : 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// fhirpath.js doesn't export ResourceNode, but every typed result is one
const RESOURCE_NODES = new WeakMap();
function resourceNodeClass(model) {
  let c = RESOURCE_NODES.get(model);
  if (!c) {
    c = fhirpath.evaluate({ resourceType: 'Patient' }, 'Patient', null, model, { resolveInternalTypes: false })[0].constructor;
    RESOURCE_NODES.set(model, c);
  }
  return c;
}

class Patcher {
  /**
   * @param {Object} resource - the copy being patched
   * @param {Object} context - { model (fhirpath.js), options (fhirpath.js), xml (XmlModel) }
   */
  constructor(resource, context) {
    this.resource = resource;
    this.fpModel = context.model;
    const options = context.options || {};
    this.fpOptions = { ...options, resolveInternalTypes: false, userInvocationTable: { ...(options.userInvocationTable || {}), resolve: this.resolver() } };
    this.xml = context.xml;
    this.places = new Map();
  }

  /**
   * resolve(), which in a patch can only find the resource's own contained resources ('#id'),
   * or the resource itself ('#')
   */
  resolver() {
    const patcher = this;
    const ResourceNode = resourceNodeClass(this.fpModel);
    return {
      internalStructures: true,
      fn: function (inputs) {
        const out = [];
        for (const input of inputs) {
          const d = input instanceof ResourceNode ? input.data : input;
          const ref = typeof d === 'string' ? d : (d && typeof d === 'object' ? d.reference : undefined);
          if (typeof ref !== 'string' || !ref.startsWith('#')) {
            throw new PatchError('In a patch, resolve() can only refer to the resource being patched, and the resources it contains');
          }
          const id = ref.substring(1);
          const r = patcher.resource;
          const target = !id ? r : (Array.isArray(r.contained) ? r.contained.find(c => c && c.id === id) : null);
          if (target) {
            out.push(ResourceNode.makeResNode(this, target, null, target.resourceType, null, target.resourceType));
          }
        }
        return out;
      }
    };
  }

  evaluate(path) {
    this.places = new Map();
    let nodes;
    try {
      nodes = fhirpath.evaluate(this.resource, quoteNames(path), null, this.fpModel, this.fpOptions);
    } catch (e) {
      if (e instanceof PatchError) {
        throw e;
      }
      throw new PatchError(`The path '${path}' can't be evaluated: ${e.message}`);
    }
    for (const node of nodes) {
      if (!node || typeof node !== 'object' || !('parentResNode' in node)) {
        throw new PatchError(`The path '${path}' finds a value that isn't part of the resource`);
      }
    }
    return nodes;
  }

  /** The elements of a type in the model (key: a type, or a backbone element's path) */
  elements(key) {
    const t = this.xml.type(key);
    if (!t) {
      throw new PatchError(`The definitions have nothing for ${key}`);
    }
    return t;
  }

  element(key, name, path) {
    const el = this.elements(key).list.find(e => e.name === name);
    if (!el) {
      throw new PatchError(`${key} has no element '${name}' (at ${path})`);
    }
    return el;
  }

  /**
   * Where a node is: { container (the object holding it), key (its JSON name there), index (in
   * a list, or null), el, type (its type code), modelKey (when complex: its type or backbone
   * path), primitive, resource, root }
   */
  place(node) {
    let p = this.places.get(node);
    if (!p) {
      p = this.placeUncached(node);
      this.places.set(node, p);
    }
    return p;
  }

  placeUncached(node) {
    const data = node.data;
    const parent = node.parentResNode;
    if (!parent) {
      if (data === this.resource) {
        return { root: true, resource: true, modelKey: data.resourceType };
      }
      // resolve() to a contained resource
      const i = Array.isArray(this.resource.contained) ? this.resource.contained.indexOf(data) : -1;
      if (i < 0) {
        throw new PatchError('In a patch, a path can only refer to the resource being patched, and the resources it contains');
      }
      const el = this.element(this.resource.resourceType, 'contained', 'contained');
      return { container: this.resource, key: 'contained', index: i, el, resource: true, modelKey: data.resourceType };
    }
    const pp = this.place(parent);
    let container;
    let containerKey;
    if (pp.primitive) {
      // an element of a primitive (its id, or an extension): in "_name"
      container = this.primitiveObject(pp, false);
      containerKey = 'Element';
    } else {
      container = parent.data;
      containerKey = pp.modelKey;
    }
    if (!isObject(container)) {
      throw new PatchError(`Can't find where ${node.path || 'a value'} is in the resource`);
    }
    const name = node.propName;
    const key = this.jsonKey(container, name);
    const index = Number.isInteger(node.index) ? node.index : null;
    const found = this.elements(containerKey).byJson.get(key);
    if (!found) {
      throw new PatchError(`${containerKey} has no element '${key}'`);
    }
    const out = { container, key, index, el: found.el, type: found.type };
    const kind = this.xml.kindOf(found.el, found.type);
    if (kind.kind === 'primitive' || kind.kind === 'xhtml') {
      out.primitive = true;
    } else if (kind.kind === 'resource') {
      out.resource = true;
      out.modelKey = data && data.resourceType;
    } else {
      out.modelKey = kind.key;
    }
    return out;
  }

  /** The JSON name of an element in an object (for a choice, with its type) */
  jsonKey(container, name) {
    if (name in container || ('_' + name) in container) {
      return name;
    }
    for (const k of Object.keys(container)) {
      const b = k.startsWith('_') ? k.substring(1) : k;
      if (b.length > name.length && b.startsWith(name) && /[A-Z]/.test(b.charAt(name.length))) {
        return b;
      }
    }
    return name;
  }

  /** A primitive's "_name" object (made, if create) */
  primitiveObject(p, create) {
    const ek = '_' + p.key;
    if (p.index === null) {
      if (!isObject(p.container[ek])) {
        if (!create) {
          return null;
        }
        p.container[ek] = {};
      }
      return p.container[ek];
    }
    const values = p.container[p.key];
    let ext = p.container[ek];
    if (!Array.isArray(ext)) {
      if (!create) {
        return null;
      }
      ext = p.container[ek] = new Array(Array.isArray(values) ? values.length : 0).fill(null);
    }
    if (!isObject(ext[p.index])) {
      if (!create) {
        return null;
      }
      ext[p.index] = {};
    }
    return ext[p.index];
  }

  /**
   * A value from a patch, for an element: { json (the JSON name), value, ext (a primitive's
   * id and extensions) }
   */
  makeValue(el, part, where) {
    const vk = valueKey(part);
    if (vk) {
      const [suffix, k] = vk;
      // Parameters has no valueXhtml: the narrative's div is a string
      const type = el.types.find(t => ucFirst(t) === suffix || (t === 'xhtml' && suffix === 'String'));
      if (!type) {
        throw new PatchError(`A ${suffix} can't go in ${where} (it can be ${el.types.join(', ')})`);
      }
      const kind = this.xml.kindOf(el, type);
      const json = el.choice ? el.name + ucFirst(type) : el.name;
      if (kind.kind === 'primitive' || kind.kind === 'xhtml') {
        return { json, value: part[k], ext: isObject(part['_' + k]) ? part['_' + k] : undefined, written: fhirJson.writtenAs(part, k) };
      }
      if (!isObject(part[k])) {
        throw new PatchError(`The ${suffix} for ${where} isn't an object`);
      }
      return { json, value: part[k] };
    }
    if (isObject(part.resource)) {
      if (this.xml.kindOf(el, el.types[0]).kind !== 'resource') {
        throw new PatchError(`A resource can't go in ${where}`);
      }
      return { json: el.name, value: part.resource };
    }
    if (Array.isArray(part.part)) {
      if (el.choice && el.types.length !== 1) {
        throw new PatchError(`${where} can have more than one type: its value must say which (value[x])`);
      }
      const type = el.types[0];
      const kind = this.xml.kindOf(el, type);
      if (kind.kind !== 'complex') {
        throw new PatchError(`${where} is a ${type}: its value must be a value[x], not parts`);
      }
      return { json: el.choice ? el.name + ucFirst(type) : el.name, value: this.fromParts(kind.key, part.part, where) };
    }
    throw new PatchError(`There is no value for ${where}`);
  }

  /** An element given as parts, one for each of its elements */
  fromParts(key, parts, where) {
    const obj = {};
    for (const part of parts) {
      if (!isObject(part) || typeof part.name !== 'string') {
        throw new PatchError(`A part of the value for ${where} has no name`);
      }
      const el = this.element(key, part.name, where);
      const v = this.makeValue(el, part, `${where}.${part.name}`);
      if (el.array) {
        this.insertInto(obj, v, null);
      } else {
        if (el.forms.some(f => f.json in obj || f.ext in obj)) {
          throw new PatchError(`The value for ${where} has more than one ${part.name}`);
        }
        this.set(obj, v);
      }
    }
    return obj;
  }

  set(obj, v) {
    if (v.value !== undefined) {
      obj[v.json] = v.value;
      if (v.written) {
        fhirJson.remember(obj, v.json, v.written);
      }
    }
    if (v.ext) {
      obj['_' + v.json] = v.ext;
    }
  }

  /** Inserts a value into a list (index null: at the end), with its "_name" alongside */
  insertInto(obj, v, index) {
    const list = obj[v.json] = Array.isArray(obj[v.json]) ? obj[v.json] : [];
    const at = index === null ? list.length : index;
    const ek = '_' + v.json;
    const ext = obj[ek];
    if (v.ext || Array.isArray(ext)) {
      const e = Array.isArray(ext) ? ext : new Array(list.length).fill(null);
      while (e.length < list.length) {
        e.push(null);
      }
      e.splice(at, 0, v.ext || null);
      obj[ek] = e;
    }
    list.splice(at, 0, v.value === undefined ? null : v.value);
    if (v.written) {
      fhirJson.remember(list, at, v.written);
    }
    tidyExtensions(obj, ek);
  }

  removeFrom(obj, key, index) {
    const ek = '_' + key;
    if (index === null) {
      delete obj[key];
      delete obj[ek];
      return;
    }
    if (Array.isArray(obj[key])) {
      obj[key].splice(index, 1);
    }
    if (Array.isArray(obj[ek])) {
      obj[ek].splice(index, 1);
    }
    tidyExtensions(obj, ek);
  }

  /** One element, found at a path (null: none, when allowed) */
  single(path, what, noneOk) {
    const nodes = this.evaluate(path);
    if (nodes.length === 0) {
      if (noneOk) {
        return null;
      }
      throw new PatchError(`No content found at ${path} when ${what}`);
    }
    if (nodes.length > 1) {
      throw new PatchError(`Multiple locations found at ${path} when ${what}`);
    }
    return nodes[0];
  }

  /** The whole of a list, found at a path: { container, key, el, length } */
  list(path, what, emptyOk) {
    const nodes = this.evaluate(path);
    if (nodes.length === 0) {
      // an empty list: found by the element that holds it, and its name
      const m = emptyOk && /^(.+)\.([A-Za-z][A-Za-z0-9]*)$/.exec(path);
      if (m) {
        const owner = this.single(m[1], what, true);
        if (owner) {
          const op = this.place(owner);
          const obj = op.primitive ? this.primitiveObject(op, true) : owner.data;
          const key = op.primitive ? 'Element' : op.modelKey;
          if (isObject(obj) && key) {
            const el = this.element(key, m[2], path);
            if (el.array && !el.choice) {
              return { container: obj, key: el.name, el, length: 0 };
            }
          }
        }
      }
      throw new PatchError(`No content found at ${path} when ${what}`);
    }
    const first = this.place(nodes[0]);
    if (first.index === null) {
      throw new PatchError(`${path} isn't a list (when ${what})`);
    }
    const all = first.container[first.key];
    for (const node of nodes) {
      const p = this.place(node);
      if (p.container !== first.container || p.key !== first.key) {
        throw new PatchError(`${path} finds more than one list (when ${what})`);
      }
    }
    if (!Array.isArray(all) || nodes.length !== all.length) {
      throw new PatchError(`${path} must find the whole of the list (when ${what})`);
    }
    return { container: first.container, key: first.key, el: first.el, length: all.length };
  }

  add(op) {
    const node = this.single(op.path, 'adding');
    const p = this.place(node);
    const obj = p.primitive ? this.primitiveObject(p, true) : node.data;
    const key = p.primitive ? 'Element' : p.modelKey;
    if (!isObject(obj) || !key) {
      throw new PatchError(`Nothing can be added to ${op.path}`);
    }
    const el = this.element(key, op.name, op.path);
    const v = this.makeValue(el, op.value, `${op.path}.${op.name}`);
    if (el.array) {
      this.insertInto(obj, v, null);
    } else {
      if (el.forms.some(f => f.json in obj || f.ext in obj)) {
        throw new PatchError(`${op.path}.${op.name} already has a value: use replace`);
      }
      this.set(obj, v);
    }
  }

  insert(op) {
    const l = this.list(op.path, 'inserting', true);
    if (op.index > l.length) {
      throw new PatchError(`Can't insert at ${op.index} in ${op.path}: it has ${l.length} item${l.length === 1 ? '' : 's'}`);
    }
    const v = this.makeValue(l.el, op.value, op.path);
    if (v.json !== l.key) {
      throw new PatchError(`The value for ${op.path} has the wrong type`);
    }
    this.insertInto(l.container, v, op.index);
  }

  delete(op) {
    const node = this.single(op.path, 'deleting', true);
    if (!node) {
      return;
    }
    const p = this.place(node);
    if (p.root) {
      throw new PatchError('The resource itself can\'t be deleted by a patch');
    }
    this.removeFrom(p.container, p.key, p.index);
  }

  replace(op) {
    const node = this.single(op.path, 'replacing');
    const p = this.place(node);
    if (p.root) {
      throw new PatchError('The resource itself can\'t be replaced by a patch: use update');
    }
    const v = this.makeValue(p.el, op.value, op.path);
    if (p.index !== null) {
      if (v.json !== p.key) {
        throw new PatchError(`The value for ${op.path} has the wrong type`);
      }
      this.removeFrom(p.container, p.key, p.index);
      this.insertInto(p.container, v, p.index);
    } else {
      for (const f of p.el.forms) {
        delete p.container[f.json];
        delete p.container[f.ext];
      }
      this.set(p.container, v);
    }
  }

  move(op) {
    const l = this.list(op.path, 'moving', false);
    for (const [name, i] of [['source', op.source], ['destination', op.destination]]) {
      if (i >= l.length) {
        throw new PatchError(`The ${name} (${i}) isn't in ${op.path}: it has ${l.length} item${l.length === 1 ? '' : 's'}`);
      }
    }
    for (const k of [l.key, '_' + l.key]) {
      const list = l.container[k];
      if (Array.isArray(list)) {
        const [item] = list.splice(op.source, 1);
        list.splice(op.destination, 0, item);
      }
    }
  }
}

/** A primitive list's "_name" list goes when nothing is left in it */
function tidyExtensions(obj, ek) {
  if (Array.isArray(obj[ek]) && obj[ek].every(e => e === null)) {
    delete obj[ek];
  }
}

/** Takes out what's left empty: objects and lists with nothing in them, and "_name" lists of nulls */
function dropEmpty(v) {
  if (Array.isArray(v)) {
    for (let i = v.length - 1; i >= 0; i--) {
      if (v[i] !== null && typeof v[i] === 'object' && dropEmpty(v[i])) {
        v.splice(i, 1);
      }
    }
    return v.length === 0;
  }
  if (isObject(v)) {
    for (const k of Object.keys(v)) {
      const x = v[k];
      if (x !== null && typeof x === 'object') {
        if (Array.isArray(x) && k.startsWith('_')) {
          // keep the positions: only empty when nothing is left in it
          for (let i = 0; i < x.length; i++) {
            if (isObject(x[i]) && dropEmpty(x[i])) {
              x[i] = null;
            }
          }
          if (x.every(e => e === null)) {
            delete v[k];
          }
        } else if (dropEmpty(x)) {
          delete v[k];
        }
      }
    }
    return Object.keys(v).length === 0;
  }
  return false;
}

/**
 * Applies a FHIRPath Patch to a copy of a resource.
 * @param {Object} resource
 * @param {Object} patch - a Parameters resource
 * @param {Object} context - { model: the fhirpath.js model, options: fhirpath.js options (e.g.
 *   functions), xml: the XmlModel for the FHIR version }
 * @returns {Object} the patched copy
 * @throws PatchError when the patch can't be applied
 */
function applyFhirPathPatch(resource, patch, context) {
  if (!isObject(patch) || patch.resourceType !== 'Parameters') {
    throw new PatchError('A FHIRPath Patch is a Parameters resource');
  }
  if (!context || !context.xml) {
    throw new PatchError('FHIRPath Patch needs the definitions of the FHIR version');
  }
  const ops = (patch.parameter || []).map(readOperation);
  const patcher = new Patcher(fhirJson.clone(resource), context);
  let deleted = false;
  for (const op of ops) {
    try {
      patcher[op.type](op);
    } catch (e) {
      if (e instanceof PatchError && ops.length > 1) {
        e.message = `Operation ${op.n} (${op.type} at ${op.path}): ${e.message}`;
      }
      throw e;
    }
    deleted = deleted || op.type === 'delete';
  }
  if (deleted) {
    dropEmpty(patcher.resource);
  }
  return patcher.resource;
}

module.exports = { applyFhirPathPatch, PatchError };
