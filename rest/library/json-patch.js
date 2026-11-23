//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * JSON Patch (RFC 6902) and JSON Pointer (RFC 6901), applied to a copy.
 *
 * @module rest/library/json-patch
 */

class PatchError extends Error {}

function parsePointer(p) {
  if (p === '') {
    return [];
  }
  if (typeof p !== 'string' || !p.startsWith('/')) {
    throw new PatchError(`'${p}' is not a JSON Pointer`);
  }
  return p.substring(1).split('/').map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function isIndex(s) {
  return /^(0|[1-9]\d*)$/.test(s);
}

function getParent(doc, tokens, path) {
  let cur = doc;
  for (let i = 0; i < tokens.length - 1; i++) {
    const t = tokens[i];
    if (Array.isArray(cur)) {
      if (!isIndex(t) || Number(t) >= cur.length) {
        throw new PatchError(`${path}: no element ${t}`);
      }
      cur = cur[Number(t)];
    } else if (cur && typeof cur === 'object' && Object.prototype.hasOwnProperty.call(cur, t)) {
      cur = cur[t];
    } else {
      throw new PatchError(`${path}: no element ${t}`);
    }
  }
  if (cur === null || typeof cur !== 'object') {
    throw new PatchError(`${path}: the parent is not an object or array`);
  }
  return cur;
}

function getValue(doc, path) {
  const tokens = parsePointer(path);
  if (tokens.length === 0) {
    return doc;
  }
  const parent = getParent(doc, tokens, path);
  const last = tokens[tokens.length - 1];
  if (Array.isArray(parent)) {
    if (!isIndex(last) || Number(last) >= parent.length) {
      throw new PatchError(`${path}: no element ${last}`);
    }
    return parent[Number(last)];
  }
  if (!Object.prototype.hasOwnProperty.call(parent, last)) {
    throw new PatchError(`${path}: no element ${last}`);
  }
  return parent[last];
}

function add(doc, path, value) {
  const tokens = parsePointer(path);
  if (tokens.length === 0) {
    return value;
  }
  const parent = getParent(doc, tokens, path);
  const last = tokens[tokens.length - 1];
  if (Array.isArray(parent)) {
    if (last === '-') {
      parent.push(value);
    } else if (isIndex(last) && Number(last) <= parent.length) {
      parent.splice(Number(last), 0, value);
    } else {
      throw new PatchError(`${path}: index ${last} is out of range`);
    }
  } else {
    if (last === '__proto__' || last === 'constructor' || last === 'prototype') {
      throw new PatchError(`${path}: not allowed`);
    }
    parent[last] = value;
  }
  return doc;
}

function remove(doc, path) {
  const tokens = parsePointer(path);
  if (tokens.length === 0) {
    throw new PatchError('Can\'t remove the whole document');
  }
  const parent = getParent(doc, tokens, path);
  const last = tokens[tokens.length - 1];
  if (Array.isArray(parent)) {
    if (!isIndex(last) || Number(last) >= parent.length) {
      throw new PatchError(`${path}: no element ${last}`);
    }
    return parent.splice(Number(last), 1)[0];
  }
  if (!Object.prototype.hasOwnProperty.call(parent, last)) {
    throw new PatchError(`${path}: no element ${last}`);
  }
  const v = parent[last];
  delete parent[last];
  return v;
}

function equal(a, b) {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

function sortKeys(v) {
  if (Array.isArray(v)) {
    return v.map(sortKeys);
  }
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) {
      o[k] = sortKeys(v[k]);
    }
    return o;
  }
  return v;
}

/**
 * Apply a JSON Patch to a copy of a document.
 * @param {Object} document
 * @param {Object[]} patch
 * @returns {Object} the patched copy
 * @throws {PatchError}
 */
function applyPatch(document, patch) {
  if (!Array.isArray(patch)) {
    throw new PatchError('A JSON Patch is an array of operations');
  }
  let doc = JSON.parse(JSON.stringify(document));
  for (const op of patch) {
    if (!op || typeof op !== 'object' || typeof op.op !== 'string' || typeof op.path !== 'string') {
      throw new PatchError('Each operation needs op and path');
    }
    const clone = (v) => v === undefined ? v : JSON.parse(JSON.stringify(v));
    switch (op.op) {
      case 'add':
        if (!('value' in op)) {
          throw new PatchError(`add ${op.path}: no value`);
        }
        doc = add(doc, op.path, clone(op.value));
        break;
      case 'remove':
        remove(doc, op.path);
        break;
      case 'replace':
        if (!('value' in op)) {
          throw new PatchError(`replace ${op.path}: no value`);
        }
        if (parsePointer(op.path).length === 0) {
          doc = clone(op.value);
        } else {
          getValue(doc, op.path);
          remove(doc, op.path);
          doc = add(doc, op.path, clone(op.value));
        }
        break;
      case 'move': {
        if (op.path.startsWith(op.from + '/')) {
          throw new PatchError(`move: ${op.path} is inside ${op.from}`);
        }
        const v = remove(doc, op.from);
        doc = add(doc, op.path, v);
        break;
      }
      case 'copy':
        doc = add(doc, op.path, clone(getValue(doc, op.from)));
        break;
      case 'test':
        if (!equal(getValue(doc, op.path), op.value)) {
          throw new PatchError(`test ${op.path} failed`);
        }
        break;
      default:
        throw new PatchError(`Unknown operation '${op.op}'`);
    }
  }
  return doc;
}

module.exports = { applyPatch, PatchError, getValue };
