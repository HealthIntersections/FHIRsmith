//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * The _filter parameter: parsed into the same tree as ordinary parameters (parser.js).
 *
 *   filter     = expr
 *   expr       = andExpr ("or" andExpr)*
 *   andExpr    = unary ("and" unary)*
 *   unary      = "not" "(" expr ")" | "(" expr ")" | comparison
 *   comparison = path op value
 *   path       = name ("[" filter "]")? ("." path)?   a chain through reference parameters
 *   op         = eq ne co sw ew gt lt ge le ap sa eb pr po ss sb in ni re
 *   value      = "quoted string" | token
 *
 * A chain (subject.name eq x) asks for a reference to a resource that matches; a filter in
 * brackets on a step (performer[name sw Smith].active eq true) adds conditions the same
 * target must meet: unlike performer.name sw Smith and performer.active eq true, which two
 * different performers could meet between them.
 *
 * @module rest/search/filter
 */

const { badRequest } = require('../library/errors');
const { dateRange, numberRange } = require('../../library/fhir-search-values');
const { normalise } = require('../indexing/values');
const { parseQuery } = require('../indexing/fulltext');

/**
 * A _filter value (already unquoted: every character in it is literal) in the form the search
 * parser reads, where a backslash escapes the next character: so backslashes are doubled. A |
 * stays a separator (system|code), as it is in _filter.
 * @param {string} value
 */
function asSearchValue(value) {
  return value.replace(/\\/g, '\\\\');
}

const OPS = new Set(['eq', 'ne', 'co', 'sw', 'ew', 'gt', 'lt', 'ge', 'le', 'ap', 'sa', 'eb', 'pr', 'po', 'ss', 'sb', 'in', 'ni', 're']);
const MAX_LENGTH = 4000;

function tokenise(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === '(' || c === ')') {
      out.push({ t: c });
      i++;
    } else if (c === '"') {
      let s = '';
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < text.length) {
          s += text[i + 1];
          i += 2;
        } else {
          s += text[i++];
        }
      }
      if (i >= text.length) {
        throw badRequest('_filter: a quoted value is not closed');
      }
      i++;
      out.push({ t: 'str', v: s });
    } else {
      // a word; a [...] in it (a filter on a path step) is kept whole, spaces and all
      let s = '';
      while (i < text.length && !/[\s()]/.test(text[i])) {
        if (text[i] === '[') {
          const end = closingBracket(text, i);
          s += text.substring(i, end + 1);
          i = end + 1;
        } else {
          s += text[i++];
        }
      }
      out.push({ t: 'word', v: s });
    }
  }
  return out;
}

/**
 * Where the ] that closes the [ at start is: brackets nest, and brackets inside quoted
 * strings don't count.
 */
function closingBracket(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') {
          i++;
        }
        i++;
      }
    } else if (c === '[') {
      depth++;
    } else if (c === ']') {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  throw badRequest('_filter: a [ is not closed');
}

/**
 * The first step of a path: its parameter, the filter in brackets on it (or null), and the
 * rest of the path after the '.' (or null).
 * @param {string} path
 */
function splitPath(path) {
  let i = 0;
  while (i < path.length && path[i] !== '[' && path[i] !== '.') {
    i++;
  }
  const code = path.substring(0, i);
  let filter = null;
  if (path[i] === '[') {
    const end = closingBracket(path, i);
    filter = path.substring(i + 1, end).trim();
    if (!filter) {
      throw badRequest(`_filter: the [] on ${code} is empty`);
    }
    i = end + 1;
  }
  let rest = null;
  if (i < path.length) {
    if (path[i] !== '.' || i + 1 >= path.length) {
      throw badRequest(`_filter: '${path}' is not a parameter path`);
    }
    rest = path.substring(i + 1);
  }
  if (!code) {
    throw badRequest(`_filter: '${path}' is not a parameter path`);
  }
  return { code, filter, rest };
}

class FilterParser {
  /**
   * @param {Object} sp - the SearchParser
   * @param {string[]} types - the types the filter is about
   * @param {string} text
   * @param {number} [depth] - how many chain links in this filter is (a filter in brackets)
   */
  constructor(sp, types, text, depth = 0) {
    this.depth = depth;
    this.sp = sp;
    this.types = types;
    if (text.length > MAX_LENGTH) {
      throw badRequest(`_filter is limited to ${MAX_LENGTH} characters`);
    }
    this.tokens = tokenise(text);
    this.pos = 0;
  }

  peek() {
    return this.tokens[this.pos];
  }

  next() {
    return this.tokens[this.pos++];
  }

  isWord(tok, w) {
    return tok && tok.t === 'word' && tok.v.toLowerCase() === w;
  }

  parse() {
    const e = this.expr(0);
    if (this.pos < this.tokens.length) {
      throw badRequest(`_filter: unexpected '${this.peek().v || this.peek().t}'`);
    }
    return e;
  }

  expr(depth) {
    if (depth > 20) {
      throw badRequest('_filter: nested too deeply');
    }
    const items = [this.andExpr(depth)];
    while (this.isWord(this.peek(), 'or')) {
      this.next();
      items.push(this.andExpr(depth));
    }
    return items.length === 1 ? items[0] : { kind: 'or', items };
  }

  andExpr(depth) {
    const items = [this.unary(depth)];
    while (this.isWord(this.peek(), 'and')) {
      this.next();
      items.push(this.unary(depth));
    }
    return items.length === 1 ? items[0] : { kind: 'and', items };
  }

  unary(depth) {
    const tok = this.peek();
    if (!tok) {
      throw badRequest('_filter: incomplete expression');
    }
    if (this.isWord(tok, 'not') && this.tokens[this.pos + 1] && this.tokens[this.pos + 1].t === '(') {
      this.next();
      return { kind: 'not', item: this.group(depth) };
    }
    if (tok.t === '(') {
      return this.group(depth);
    }
    return this.comparison();
  }

  group(depth) {
    this.next();
    const e = this.expr(depth + 1);
    const close = this.next();
    if (!close || close.t !== ')') {
      throw badRequest('_filter: missing )');
    }
    return e;
  }

  comparison() {
    const path = this.next();
    const op = this.next();
    const value = this.next();
    if (!path || path.t !== 'word' || !op || op.t !== 'word' || !value || (value.t !== 'word' && value.t !== 'str')) {
      throw badRequest('_filter: expected parameter operator value');
    }
    const o = op.v.toLowerCase();
    if (!OPS.has(o)) {
      throw badRequest(`_filter: unknown operator '${op.v}'`);
    }
    return this.compare(this.types, path.v, o, value.v, this.depth);
  }

  compare(types, path, op, value, depth) {
    const sp = this.sp;
    const step = splitPath(path);
    if (step.filter !== null && step.rest === null) {
      throw badRequest(`_filter: a filter in brackets on ${step.code} needs a parameter after it (${step.code}[...].parameter)`);
    }
    if (step.rest !== null) {
      if (depth >= 3) {
        throw badRequest('_filter: chains are limited to 3 links');
      }
      const code = step.code;
      const l = sp.lookup(types, code);
      if (!l || l.spType !== 'reference') {
        throw badRequest(`_filter: '${code}' is not a reference parameter${step.filter !== null ? ', so it can\'t have a filter in brackets' : ''}`);
      }
      const nextCode = splitPath(step.rest).code;
      let targets = [...new Set(l.defs.flatMap(d => d.target || []))].filter(t => sp.ep.typeKeys.has(t));
      if (!nextCode.startsWith('_')) {
        targets = targets.filter(t => sp.defs.param(t, nextCode));
      }
      if (!targets.length) {
        throw badRequest(`_filter: none of the targets of ${code} has a parameter '${nextCode}'`);
      }
      let inner = this.compare(targets, step.rest, op, value, depth + 1);
      if (step.filter !== null) {
        // the bracket's conditions and the rest of the path, on the same target
        const filter = new FilterParser(sp, targets, step.filter, depth + 1).parse();
        inner = { kind: 'and', items: [filter, inner] };
      }
      return { kind: 'chain', keys: l.keys, targetTypes: null, inner };
    }
    if (path === '_id') {
      if (op !== 'eq' && op !== 'ne') {
        throw badRequest(`_filter: _id takes eq or ne, not ${op}`);
      }
      return { kind: 'id', ids: [value], negate: op === 'ne' };
    }
    if (path === '_lastUpdated') {
      const r = dateRange(value, sp.ep.timeZone);
      if (!r) {
        throw badRequest(`_filter: '${value}' is not a date`);
      }
      return { kind: 'lastUpdated', values: [{ prefix: op === 'po' ? 'ap' : op, range: r }] };
    }
    if (path === '_text' || path === '_content') {
      // the value is a full-text query, as for _text= and _content= (indexing/fulltext.js)
      if (!['eq', 'co', 'ne'].includes(op)) {
        throw badRequest(`_filter: ${path} takes eq or co (the same), or ne, not ${op}`);
      }
      sp.fullTextUsed = true;
      const node = { kind: 'fulltext', column: path === '_text' ? 'Narrative' : 'Content', tree: parseQuery(value) };
      return op === 'ne' ? { kind: 'not', item: node } : node;
    }
    if (path === '_tag' || path === '_security' || path === '_profile') {
      if (op !== 'eq' && op !== 'ne') {
        throw badRequest(`_filter: ${path} takes eq or ne`);
      }
      return sp.tagNode(path, op === 'ne' ? 'not' : null, value);
    }
    const l = sp.lookup(types, path);
    if (!l) {
      throw badRequest(`_filter: unknown search parameter '${path}'`);
    }
    l.keys.forEach(k => sp.keysUsed.add(k));
    if (op === 'pr') {
      return { kind: 'missing', spType: l.spType, keys: l.keys, missing: value === 'false' };
    }
    const node = (values, modifier = null) => ({ kind: 'param', spType: l.spType, keys: l.keys, defs: l.defs, modifier, values, code: path });
    const negate = op === 'ne';
    switch (l.spType) {
      case 'string': {
        const norm = normalise(value).substring(0, 255);
        const mode = { eq: 'eqnorm', ne: 'eqnorm', co: 'contains', sw: 'start', ew: 'end', gt: 'gt', lt: 'lt', ge: 'ge', le: 'le' }[op];
        if (!mode) {
          throw badRequest(`_filter: ${op} can't be used on the string parameter ${path}`);
        }
        return node([{ mode, text: value, norm, negate }]);
      }
      case 'token': {
        if (op === 'in' || op === 'ni') {
          return node([{ mode: 'in', valueSet: value, negate: op === 'ni' }]);
        }
        const v = sp.tokenValue(op === 'ss' ? 'below' : op === 'sb' ? 'above' : null, asSearchValue(value));
        if (!['eq', 'ne', 'ss', 'sb'].includes(op)) {
          throw badRequest(`_filter: ${op} can't be used on the token parameter ${path}`);
        }
        v.negate = negate;
        return node([v]);
      }
      case 'date': {
        const r = dateRange(value, sp.ep.timeZone);
        if (!r) {
          throw badRequest(`_filter: '${value}' is not a date`);
        }
        const prefix = op === 'po' ? 'ap' : op === 'ne' ? 'eq' : op;
        if (!['eq', 'gt', 'lt', 'ge', 'le', 'ap', 'sa', 'eb'].includes(prefix)) {
          throw badRequest(`_filter: ${op} can't be used on the date parameter ${path}`);
        }
        const range = op === 'ap' ? require('../../library/fhir-search-values').approxDateRange(r) : r;
        return node([{ prefix, range, negate }]);
      }
      case 'number':
      case 'quantity': {
        const parts = value.split('|');
        const r = numberRange(parts[0]);
        if (!r) {
          throw badRequest(`_filter: '${value}' is not a number`);
        }
        const prefix = op === 'ne' ? 'eq' : op;
        if (!['eq', 'gt', 'lt', 'ge', 'le', 'ap', 'sa', 'eb'].includes(prefix)) {
          throw badRequest(`_filter: ${op} can't be used on ${path}`);
        }
        return node([{ prefix, ...r, system: parts[1] || null, unit: parts.slice(2).join('|') || null, negate }]);
      }
      case 'reference': {
        if (!['eq', 'ne', 're'].includes(op)) {
          throw badRequest(`_filter: ${op} can't be used on the reference parameter ${path}`);
        }
        const v = sp.referenceValue(l, null, asSearchValue(value));
        v.negate = negate;
        return node([v]);
      }
      case 'uri': {
        const mode = { eq: 'eq', ne: 'eq', co: 'contains', sw: 'below', ss: 'above', sb: 'below' }[op];
        if (!mode) {
          throw badRequest(`_filter: ${op} can't be used on the uri parameter ${path}`);
        }
        return node([{ mode, value, negate }]);
      }
    }
    throw badRequest(`_filter: ${path} (${l.spType}) can't be used in _filter`);
  }
}

/**
 * Parse _filter into a search tree node.
 * @param {import('./parser').SearchParser} sp
 * @param {string[]} types
 * @param {string} text
 */
function parseFilter(sp, types, text) {
  return new FilterParser(sp, types, text).parse();
}

module.exports = { parseFilter, tokenise, asSearchValue, splitPath };
