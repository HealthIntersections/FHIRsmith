//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * Parse search parameters into a tree. Ordinary parameters and _filter produce the same tree,
 * so there is one SQL generator (sql.js).
 *
 * Nodes:
 *   { kind: 'and', items }  { kind: 'or', items }  { kind: 'not', item }  { kind: 'none' }
 *   { kind: 'param', spType, keys, modifier, values, code }   values OR'd; a value can be
 *       negated (ne, :not) - see sql.js
 *   { kind: 'missing', spType, keys, missing: boolean }
 *   { kind: 'chain', keys, targetType, inner }   a reference to a resource that matches inner
 *   { kind: 'has', typeKey, keys, inner }        a resource of the type refers to this one
 *   { kind: 'id', ids, negate }  { kind: 'lastUpdated', values }
 *   { kind: 'tag', tagKind, values, negate }     { kind: 'list', id }
 *   { kind: 'compartment', type, id }
 *
 * keys: the ParamKeys of the parameter across the types searched (a code can belong to a
 * different definition on each type).
 *
 * @module rest/search/parser
 */

const { badRequest } = require('../library/errors');
const { dateRange, approxDateRange, numberRange, splitPrefix, PREFIXES } = require('../../library/fhir-search-values');
const { normalise, parseReference } = require('../indexing/values');
const { TAG, SECURITY, PROFILE, PROFILE_SYSTEM } = require('../store');

const MAX_CHAIN = 3;
const MAX_HAS = 3;

// the result parameters: not criteria
const CONTROL = new Set(['_sort', '_count', '_include', '_revinclude', '_summary', '_elements', '_total', '_format', '_pretty',
  '_contained', '_containedType', '_getpages', '_offset']);

const MODIFIERS = {
  string: ['exact', 'contains', 'missing', 'text'],
  token: ['text', 'not', 'missing', 'below', 'above', 'in', 'not-in', 'of-type', 'code-text'],
  date: ['missing'],
  number: ['missing'],
  quantity: ['missing'],
  reference: ['missing', 'identifier', 'type'],
  uri: ['missing', 'below', 'above', 'contains'],
  composite: ['missing']
};

class Unsupported extends Error {}

/**
 * Split a value at unescaped separators ($ for composites, | for tokens).
 */
function splitEscaped(s, sep) {
  const out = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && (s[i + 1] === sep || s[i + 1] === '\\' || s[i + 1] === ',' || s[i + 1] === '$' || s[i + 1] === '|')) {
      cur += s[i + 1];
      i++;
    } else if (s[i] === sep) {
      out.push(cur);
      cur = '';
    } else {
      cur += s[i];
    }
  }
  out.push(cur);
  return out;
}

/** Split on commas that aren't escaped, keeping the escapes for the next split */
function splitOr(value) {
  const out = [];
  let cur = '';
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '\\' && i + 1 < value.length) {
      if (value[i + 1] === ',') {
        cur += ',';
      } else {
        cur += c + value[i + 1];
      }
      i++;
    } else if (c === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.filter(v => v.length > 0);
}

function unescape(s) {
  return s.replace(/\\([\\,$|])/g, '$1');
}

class SearchParser {
  /**
   * @param {Object} ep - the Endpoint (definitions, typeKeys, timeZone, base)
   */
  constructor(ep) {
    this.ep = ep;
    this.defs = ep.definitions;
  }

  /**
   * The ParamKeys and definitions for a code across types.
   * @returns {{keys: number[], defs: Object[], spType: string}|null}
   */
  lookup(types, code) {
    const defs = [];
    for (const t of types) {
      const d = this.defs.param(t, code);
      if (d && d.key !== null && d.key !== undefined && !defs.includes(d)) {
        defs.push(d);
      }
    }
    if (defs.length === 0) {
      return null;
    }
    const spType = defs[0].type;
    const same = defs.filter(d => d.type === spType);
    return { keys: same.map(d => d.key), defs: same, spType };
  }

  /**
   * Parse the parameters.
   * @param {Object} p
   * @param {string[]} p.types - the types searched
   * @param {Array<[string, string]>} p.params
   * @param {boolean} [p.strict] - an unknown parameter or modifier is an error
   * @returns {{criteria: Object, control: Object, used: Array, ignored: string[], warnings: string[], keysUsed: Set}}
   */
  parse(p) {
    const items = [];
    const used = [];
    const ignored = [];
    const warnings = [];
    this.keysUsed = new Set();
    const control = { sort: [], include: [], revinclude: [], count: null, total: null, summary: null, elements: null };
    for (const [name, value] of p.params) {
      const base = name.split(':')[0].split('.')[0];
      if (CONTROL.has(base)) {
        this.parseControl(control, name, value, p.types);
        if (base !== '_getpages' && base !== '_offset' && base !== '_format') {
          used.push([name, value]);
        }
        continue;
      }
      if (base === '_type') {
        // handled by the caller
        used.push([name, value]);
        continue;
      }
      try {
        const node = this.criterion(p.types, name, value, 0);
        if (node) {
          items.push(node);
          used.push([name, value]);
        }
      } catch (e) {
        if (e instanceof Unsupported) {
          if (p.strict) {
            throw badRequest(e.message);
          }
          ignored.push(name);
          warnings.push(e.message + ': ignored');
        } else {
          throw e;
        }
      }
    }
    for (const k of this.keysUsed) {
      const def = [...this.defs.byUrl.values()].find(d => d.key === k);
      if (def && this.defs.reindexing && this.defs.reindexing.has(def.url)) {
        warnings.push(`The search parameter ${def.code} is being reindexed: results may be incomplete`);
      }
    }
    return { criteria: { kind: 'and', items }, control, used, ignored, warnings };
  }

  parseControl(control, name, value, types) {
    const [base, modifier] = name.split(':');
    switch (base) {
      case '_count':
        if (!/^\d+$/.test(value)) {
          throw badRequest(`_count must be a number, not '${value}'`);
        }
        control.count = Number(value);
        break;
      case '_total':
        if (!['none', 'estimate', 'accurate'].includes(value)) {
          throw badRequest(`_total is none, estimate or accurate, not '${value}'`);
        }
        control.total = value;
        break;
      case '_summary':
        if (!['true', 'false', 'text', 'data', 'count'].includes(value)) {
          throw badRequest(`_summary is true, false, text, data or count, not '${value}'`);
        }
        control.summary = value;
        break;
      case '_elements':
        control.elements = (control.elements || []).concat(value.split(',').map(s => s.trim()).filter(s => s));
        break;
      case '_sort':
        for (const s of value.split(',').map(x => x.trim()).filter(x => x)) {
          const desc = s.startsWith('-');
          const code = desc ? s.substring(1) : s;
          if (code === '_id' || code === '_lastUpdated') {
            control.sort.push({ code, desc });
          } else {
            const l = this.lookup(types, code);
            if (!l || l.spType === 'composite') {
              throw badRequest(`Can't sort by '${code}': it isn't a search parameter of ${types.length === 1 ? types[0] : 'these types'}`);
            }
            control.sort.push({ code, desc, keys: l.keys, spType: l.spType });
          }
        }
        break;
      case '_include':
      case '_revinclude': {
        const iterate = modifier === 'iterate' || modifier === 'recurse';
        const list = base === '_include' ? control.include : control.revinclude;
        if (value === '*') {
          list.push({ all: true, iterate });
          break;
        }
        const parts = value.split(':');
        if (parts.length < 2) {
          throw badRequest(`${base} is Type:parameter[:targetType], not '${value}'`);
        }
        const [srcType, code, target] = parts;
        if (!this.ep.typeKeys.has(srcType)) {
          throw badRequest(`${base}: unknown type ${srcType}`);
        }
        if (code === '*') {
          list.push({ srcType, all: true, target: target || null, iterate });
          break;
        }
        const d = this.defs.param(srcType, code);
        if (!d || d.type !== 'reference' || d.key === null) {
          throw badRequest(`${base}: ${srcType} has no reference parameter '${code}'`);
        }
        list.push({ srcType, key: d.key, target: target || null, iterate });
        break;
      }
      default:
        break;
    }
  }

  /**
   * One parameter (name[:modifier][.chain] = value) as a node.
   */
  criterion(types, name, value, depth) {
    if (name.startsWith('_has:')) {
      return this.has(types, name, value, depth);
    }
    const dot = name.indexOf('.');
    if (dot > 0) {
      return this.chain(types, name.substring(0, dot), name.substring(dot + 1), value, depth);
    }
    const colon = name.indexOf(':');
    const code = colon >= 0 ? name.substring(0, colon) : name;
    const modifier = colon >= 0 ? name.substring(colon + 1) : null;
    switch (code) {
      case '_id':
        return this.idNode(value, modifier);
      case '_lastUpdated':
        if (modifier && modifier !== 'missing') {
          throw new Unsupported(`_lastUpdated:${modifier} is not supported`);
        }
        if (modifier === 'missing') {
          return value === 'true' ? { kind: 'none' } : null;
        }
        return { kind: 'lastUpdated', values: splitOr(value).map(v => this.dateValue(v)) };
      case '_tag':
      case '_security':
      case '_profile':
        return this.tagNode(code, modifier, value);
      case '_list':
        return { kind: 'list', id: value };
      case '_filter':
        return require('./filter').parseFilter(this, types, value);
      case '_text':
      case '_content':
      case '_query':
        throw new Unsupported(`${code} is not supported yet`);
      default:
        break;
    }
    const l = this.lookup(types, code);
    if (!l) {
      throw new Unsupported(`Unknown search parameter '${code}' for ${types.length === 1 ? types[0] : types.length + ' types'}`);
    }
    l.keys.forEach(k => this.keysUsed.add(k));
    if (modifier === 'missing') {
      if (value !== 'true' && value !== 'false') {
        throw badRequest(`${name} is true or false, not '${value}'`);
      }
      return { kind: 'missing', spType: l.spType, keys: l.keys, missing: value === 'true' };
    }
    if (l.spType === 'reference' && modifier && modifier !== 'identifier' && modifier !== 'missing') {
      // :[type]
      if (!this.ep.typeKeys.has(modifier)) {
        throw new Unsupported(`Unknown modifier or type '${modifier}' on ${code}`);
      }
    } else if (modifier && !(MODIFIERS[l.spType] || []).includes(modifier)) {
      throw new Unsupported(`The modifier :${modifier} is not supported on ${code} (a ${l.spType} parameter)`);
    }
    const values = splitOr(value).map(v => this.value(l, modifier, v, code));
    return { kind: 'param', spType: l.spType, keys: l.keys, defs: l.defs, modifier, values, code };
  }

  idNode(value, modifier) {
    if (modifier && modifier !== 'not' && modifier !== 'missing') {
      throw new Unsupported(`_id:${modifier} is not supported`);
    }
    if (modifier === 'missing') {
      return value === 'true' ? { kind: 'none' } : null;
    }
    return { kind: 'id', ids: splitOr(value).map(unescape), negate: modifier === 'not' };
  }

  tagNode(code, modifier, value) {
    if (modifier && modifier !== 'not' && modifier !== 'missing' && !(code === '_profile' && (modifier === 'below'))) {
      throw new Unsupported(`${code}:${modifier} is not supported`);
    }
    const tagKind = code === '_tag' ? TAG : code === '_security' ? SECURITY : PROFILE;
    if (modifier === 'missing') {
      return { kind: 'tagMissing', tagKind, missing: value === 'true' };
    }
    const values = splitOr(value).map(v => {
      if (tagKind === PROFILE) {
        return { system: PROFILE_SYSTEM, code: unescape(v), below: modifier === 'below' };
      }
      const parts = splitEscaped(v, '|');
      if (parts.length === 1) {
        return { system: undefined, code: parts[0] };
      }
      return { system: parts[0], code: parts.slice(1).join('|') || undefined };
    });
    return { kind: 'tag', tagKind, values, negate: modifier === 'not' };
  }

  dateValue(v) {
    const { prefix, rest } = splitPrefix(v);
    let range = dateRange(rest, this.ep.timeZone);
    if (!range) {
      throw badRequest(`'${v}' is not a valid date search value`);
    }
    if (prefix === 'ap') {
      range = approxDateRange(range);
    }
    return { prefix, range };
  }

  /**
   * A value for a parameter, by type and modifier.
   */
  value(l, modifier, v, code) {
    switch (l.spType) {
      case 'string': {
        const text = unescape(v);
        return { mode: modifier === 'exact' ? 'exact' : modifier === 'contains' ? 'contains' : 'start', text, norm: normalise(text).substring(0, 255) };
      }
      case 'token':
        return this.tokenValue(modifier, v);
      case 'date':
        return this.dateValue(v);
      case 'number': {
        const { prefix, rest } = splitPrefix(v);
        const r = numberRange(rest);
        if (!r) {
          throw badRequest(`'${v}' is not a valid number search value for ${code}`);
        }
        return { prefix, ...r };
      }
      case 'quantity': {
        const { prefix, rest } = splitPrefix(v);
        const parts = splitEscaped(rest, '|');
        const r = numberRange(parts[0]);
        if (!r) {
          throw badRequest(`'${v}' is not a valid quantity search value for ${code}`);
        }
        return { prefix, ...r, system: parts.length > 1 ? parts[1] || null : null, unit: parts.length > 2 ? parts.slice(2).join('|') || null : null };
      }
      case 'reference':
        return this.referenceValue(l, modifier, v);
      case 'uri':
        return { mode: modifier === 'below' ? 'below' : modifier === 'above' ? 'above' : modifier === 'contains' ? 'contains' : 'eq', value: unescape(v) };
      case 'composite':
        return this.compositeValue(l, v, code);
    }
    throw new Unsupported(`Search parameters of type ${l.spType} are not supported`);
  }

  tokenValue(modifier, v) {
    if (modifier === 'text' || modifier === 'code-text') {
      return { mode: 'text', norm: normalise(unescape(v)).substring(0, 255) };
    }
    if (modifier === 'in' || modifier === 'not-in') {
      return { mode: 'in', valueSet: unescape(v), negate: modifier === 'not-in' };
    }
    const parts = splitEscaped(v, '|');
    if (modifier === 'of-type') {
      if (parts.length !== 3) {
        throw badRequest(`:of-type takes system|code|value, not '${v}'`);
      }
      return { mode: 'of-type', typeSystem: parts[0], typeCode: parts[1], code: parts[2] };
    }
    let system;
    let code;
    if (parts.length === 1) {
      code = parts[0];
    } else {
      system = parts[0] === '' ? null : parts[0];
      code = parts.slice(1).join('|') || undefined;
    }
    const mode = modifier === 'below' ? 'below' : modifier === 'above' ? 'above' : 'code';
    if ((mode === 'below' || mode === 'above') && (!system || !code)) {
      throw badRequest(`:${mode} needs a system and a code (system|code)`);
    }
    return { mode, system, code, negate: modifier === 'not' };
  }

  referenceValue(l, modifier, v) {
    const text = unescape(v);
    if (modifier === 'identifier') {
      const parts = splitEscaped(v, '|');
      return parts.length === 1 ? { mode: 'identifier', system: undefined, value: parts[0] }
        : { mode: 'identifier', system: parts[0] || null, value: parts.slice(1).join('|') };
    }
    const typed = modifier && modifier !== 'missing' ? modifier : null;
    if (!text.includes('/') && !text.includes(':')) {
      // a bare id: of the :type, or any of the parameter's target types
      return { mode: 'local', type: typed, id: text };
    }
    const p = parseReference(text, [this.ep.baseUrl].filter(x => x));
    if (!p) {
      throw badRequest(`'${v}' is not a reference`);
    }
    if (p.local) {
      if (typed && p.type !== typed) {
        return { mode: 'nothing' };
      }
      return { mode: 'local', type: p.type, id: p.id, version: p.version };
    }
    return { mode: 'url', url: p.url, urlVersion: p.urlVersion };
  }

  compositeValue(l, v, code) {
    const def = l.defs[0];
    const parts = splitEscaped(v, '$');
    if (parts.length !== def.component.length) {
      throw badRequest(`${code} takes ${def.component.length} values separated by $, not '${v}'`);
    }
    const comps = def.component.map((c, i) => {
      const cdef = this.defs.byUrl.get(c.definition);
      if (!cdef) {
        throw new Unsupported(`The component ${c.definition} of ${code} is not known`);
      }
      return { spType: cdef.type, value: this.value({ spType: cdef.type, keys: [], defs: [cdef] }, null, parts[i], code) };
    });
    return { comps };
  }

  /**
   * subject.name=x, subject:Patient.name=x: the reference must point at a resource that
   * matches the rest.
   */
  chain(types, head, rest, value, depth) {
    if (depth >= MAX_CHAIN) {
      throw badRequest(`Chains are limited to ${MAX_CHAIN} links`);
    }
    const [code, targetType] = head.split(':');
    const l = this.lookup(types, code);
    if (!l || l.spType !== 'reference') {
      throw new Unsupported(`'${code}' is not a reference parameter, so it can't be chained`);
    }
    l.keys.forEach(k => this.keysUsed.add(k));
    let targets;
    if (targetType) {
      if (!this.ep.typeKeys.has(targetType)) {
        throw badRequest(`Unknown type ${targetType} in ${head}`);
      }
      targets = [targetType];
    } else {
      targets = [...new Set(l.defs.flatMap(d => d.target || []))].filter(t => this.ep.typeKeys.has(t));
      if (targets.length === 0) {
        targets = [...this.ep.typeKeys.keys()];
      }
      // only the targets that have the next parameter
      const nextCode = rest.split('.')[0].split(':')[0];
      if (!nextCode.startsWith('_')) {
        const withIt = targets.filter(t => this.defs.param(t, nextCode));
        if (withIt.length === 0) {
          throw new Unsupported(`None of the targets of ${code} has a search parameter '${nextCode}'`);
        }
        targets = withIt;
      }
    }
    const inner = this.criterion(targets, rest, value, depth + 1);
    return { kind: 'chain', keys: l.keys, targetTypes: targetType ? [targetType] : null, inner };
  }

  /**
   * _has:Observation:patient:code=x - an Observation whose patient is this resource, with code x.
   */
  has(types, name, value, depth) {
    if (depth >= MAX_HAS) {
      throw badRequest(`_has is limited to ${MAX_HAS} levels`);
    }
    const m = /^_has:([A-Za-z]+):([^:]+):(.+)$/.exec(name);
    if (!m) {
      throw badRequest(`_has is _has:Type:reference:parameter, not '${name}'`);
    }
    const [, type, ref, rest] = m;
    if (!this.ep.typeKeys.has(type)) {
      throw badRequest(`Unknown type ${type} in ${name}`);
    }
    const d = this.defs.param(type, ref);
    if (!d || d.type !== 'reference' || d.key === null) {
      throw badRequest(`${type} has no reference parameter '${ref}'`);
    }
    this.keysUsed.add(d.key);
    const inner = this.criterion([type], rest, value, depth + 1);
    return { kind: 'has', typeKey: this.ep.typeKeys.get(type), keys: [d.key], inner };
  }
}

module.exports = { SearchParser, Unsupported, splitOr, splitEscaped, unescape, CONTROL, PREFIXES };
