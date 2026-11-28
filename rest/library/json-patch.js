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

const fhirJson = require('../../library/fhir-json');

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

/** written: how a number value was written (library/fhir-json), to keep */
function add(doc, path, value, written) {
  const tokens = parsePointer(path);
  if (tokens.length === 0) {
    return value;
  }
  const parent = getParent(doc, tokens, path);
  const last = tokens[tokens.length - 1];
  if (Array.isArray(parent)) {
    if (last === '-') {
      parent.push(value);
      if (written) {
        fhirJson.remember(parent, parent.length - 1, written);
      }
    } else if (isIndex(last) && Number(last) <= parent.length) {
      parent.splice(Number(last), 0, value);
      if (written) {
        fhirJson.remember(parent, Number(last), written);
      }
    } else {
      throw new PatchError(`${path}: index ${last} is out of range`);
    }
  } else {
    if (last === '__proto__' || last === 'constructor' || last === 'prototype') {
      throw new PatchError(`${path}: not allowed`);
    }
    parent[last] = value;
    if (written) {
      fhirJson.remember(parent, last, written);
    }
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

// how big a value is, written as JSON (near enough: what the patch adds or takes away)
function sizeOf(v) {
  return v === undefined ? 0 : JSON.stringify(v).length;
}

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Apply a JSON Patch to a copy of a document.
 *
 * A copy doubles what it copies, so a short patch could otherwise make an enormous document
 * (copying the whole document into itself 30 times is a gigabyte, from a patch of 1 KB): the
 * whole document can't be copied, and the patched document can't get bigger than maxBytes.
 *
 * @param {Object} document
 * @param {Object[]} patch
 * @param {{maxBytes?: number}} [options] - maxBytes: the biggest the patched document may be
 *   (as JSON); default 50 MB, as the biggest body the server takes
 * @returns {Object} the patched copy
 * @throws {PatchError}
 */
function applyPatch(document, patch, options = {}) {
  if (!Array.isArray(patch)) {
    throw new PatchError('A JSON Patch is an array of operations');
  }
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : DEFAULT_MAX_BYTES;
  let size = sizeOf(document);
  const grow = (by, what) => {
    size += by;
    if (size > maxBytes) {
      throw new PatchError(`${what}: the patched resource would be bigger than this server takes (${Math.round(maxBytes / (1024 * 1024))} MB)`);
    }
  };
  let doc = fhirJson.clone(document);
  for (const op of patch) {
    if (!op || typeof op !== 'object' || typeof op.op !== 'string' || typeof op.path !== 'string') {
      throw new PatchError('Each operation needs op and path');
    }
    const clone = (v) => v === undefined ? v : fhirJson.clone(v);
    switch (op.op) {
      case 'add':
        if (!('value' in op)) {
          throw new PatchError(`add ${op.path}: no value`);
        }
        grow(sizeOf(op.value), `add ${op.path}`);
        doc = add(doc, op.path, clone(op.value), fhirJson.writtenAs(op, 'value'));
        break;
      case 'remove':
        size -= sizeOf(remove(doc, op.path));
        break;
      case 'replace':
        if (!('value' in op)) {
          throw new PatchError(`replace ${op.path}: no value`);
        }
        if (parsePointer(op.path).length === 0) {
          size = 0;
          grow(sizeOf(op.value), `replace ${op.path}`);
          doc = clone(op.value);
        } else {
          getValue(doc, op.path);
          size -= sizeOf(remove(doc, op.path));
          grow(sizeOf(op.value), `replace ${op.path}`);
          doc = add(doc, op.path, clone(op.value), fhirJson.writtenAs(op, 'value'));
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
      case 'copy': {
        if (typeof op.from === 'string' && parsePointer(op.from).length === 0) {
          throw new PatchError(`copy ${op.path}: the whole document can't be copied`);
        }
        const v = getValue(doc, op.from);
        grow(sizeOf(v), `copy ${op.from} to ${op.path}`);
        doc = add(doc, op.path, clone(v));
        break;
      }
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
