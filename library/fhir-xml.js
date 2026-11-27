//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * FHIR XML: converting resources between JSON and XML, by the type model derived from the
 * core package's StructureDefinitions (library/fhir-model.js: deriveXmlModel, and loadXmlModel,
 * which fetches the core package for a FHIR version and keeps the model in the cache folder,
 * are its, exported here too). Used by the rest module (whose model is kept with its other
 * derived definitions) and the tx module.
 *
 * The conversion is the same for every type, given, for each element of each type (and each
 * backbone element, by path): its order, whether it repeats, its type (or types: value[x]),
 * whether it's an XML attribute (id on an element, url on an extension, a primitive's value),
 * and, for an element defined elsewhere (Questionnaire.item.item), where. And for each type:
 * whether it's a primitive (and what JSON makes of it: a string, a number or a boolean), a
 * resource (wrapped in an element named for its type, where JSON uses resourceType), or the
 * narrative's XHTML (literal XML, where JSON has a string).
 *
 * XML coming in is refused if it has a DOCTYPE (so no entities can be defined); otherwise
 * only XML's own entities (&amp; &lt; &gt; &quot; &apos;) and character references are
 * expanded, and any other is an error.
 *
 * Large resources (a CodeSystem of hundreds of thousands of concepts) are written by
 * toXmlChunks without holding the event loop: the arrays of complex values are set aside as
 * the resource is written, then written an item at a time, letting other work run every
 * YIELD_MS, into parts (strings, and Buffers from a fragment cache) to be written to the
 * response one after another (writeParts). The text is the same as toXml's.
 *
 * @module library/fhir-xml
 */

const fhirJson = require('./fhir-json');
const { deriveXmlModel, XmlModel, loadXmlModel } = require('./fhir-model');
const { performance } = require('perf_hooks');
const { XMLParser, XMLValidator } = require('fast-xml-parser');

// how long toXmlChunks writes before it lets the event loop handle other work
const YIELD_MS = 25;
// marks where a set-aside array goes in the text: NUL can't be in XML (escapeAttr refuses it,
// and the narrative is checked)
// eslint-disable-next-line no-control-regex
const MARK = /\u0000(\d+)\u0000/;

const FHIR_NS = 'http://hl7.org/fhir';
// indentation strings, by level
const INDENTS = Array.from({ length: 32 }, (_, i) => '  '.repeat(i));
const XHTML_NS = 'http://www.w3.org/1999/xhtml';

// ---- JSON to XML ----

class XmlProblem extends Error {}

/**
 * A resource as FHIR XML.
 * @param {Object} resource
 * @param {XmlModel} model
 * @param {Object} [options] - { pretty }
 * @returns {string}
 * @throws XmlProblem when the resource has something XML can't carry (a property that isn't
 *   in the definitions)
 */
function toXml(resource, model, options = {}) {
  const w = new Writer(model, !!options.pretty);
  w.out.push('<?xml version="1.0" encoding="UTF-8"?>' + w.nl);
  w.resource(resource, 0, true);
  return w.out.join('');
}

class Writer {
  /**
   * @param {XmlModel} model
   * @param {boolean} pretty - indented, a line to an element
   * @param {Array|null} [jobs] - when set, arrays of complex values are set aside here (with a
   *   MARK in the text where they go), for toXmlChunks
   */
  constructor(model, pretty, jobs = null) {
    this.model = model;
    this.pretty = pretty;
    this.nl = pretty ? '\n' : '';
    this.out = [];
    this.jobs = jobs;
  }

  indent(level) {
    return this.pretty ? INDENTS[level] || '  '.repeat(level) : '';
  }

  resource(r, level, root) {
    const type = r && r.resourceType;
    if (typeof type !== 'string' || !this.model.resources.has(type) || !this.model.has(type)) {
      throw new XmlProblem(`'${type}' is not a resource type`);
    }
    this.object(type, r, type, level, root ? ` xmlns="${FHIR_NS}"` : '', type);
  }

  /** An element with children (a resource, a datatype, a backbone element) */
  object(name, obj, key, level, extraAttrs, where) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new XmlProblem(`${where}: an object was expected`);
    }
    const t = this.model.type(key);
    if (!t) {
      throw new XmlProblem(`${where}: no definition of ${key}`);
    }
    this.checkProperties(obj, t, where);
    let attrs = extraAttrs || '';
    for (const el of t.list) {
      if (el.attr && obj[el.name] !== undefined && obj[el.name] !== null) {
        attrs += ` ${el.name}="${escapeAttr(String(obj[el.name]))}"`;
      }
    }
    // the start tag's place, filled in when it's known whether there's anything inside
    const start = this.out.length;
    this.out.push(null);
    for (const el of t.list) {
      if (el.attr) {
        continue;
      }
      for (const f of el.forms) {
        const v = obj[f.json];
        const x = obj[f.ext];
        if (v !== undefined || x !== undefined) {
          this.element(f.json, el, f.type, v, x, level + 1, where, obj);
        }
      }
    }
    if (this.out.length === start + 1) {
      this.out[start] = `${this.indent(level)}<${name}${attrs}/>${this.nl}`;
    } else {
      this.out[start] = `${this.indent(level)}<${name}${attrs}>${this.nl}`;
      this.out.push(`${this.indent(level)}</${name}>${this.nl}`);
    }
  }

  checkProperties(obj, t, where) {
    for (const k of Object.keys(obj)) {
      // (undefined is nothing, as in JSON)
      if (k === 'resourceType' || k === 'fhir_comments' || obj[k] === undefined) {
        continue;
      }
      const name = k.startsWith('_') ? k.substring(1) : k;
      const m = t.byJson.get(name);
      if (!m || (k.startsWith('_') && this.model.kindOf(m.el, m.type).kind !== 'primitive')) {
        throw new XmlProblem(`${where}: '${k}' isn't an element the definitions have, so it can't be written as XML`);
      }
    }
  }

  element(name, el, type, value, ext, level, parent, holder) {
    const where = `${parent}.${name}`;
    const k = this.model.kindOf(el, type);
    if (el.array) {
      const vs = value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
      const es = ext === undefined || ext === null ? [] : Array.isArray(ext) ? ext : [ext];
      if (this.jobs && !es.length && vs.length && (k.kind === 'complex' || k.kind === 'resource')) {
        // written later, an item at a time (toXmlChunks)
        this.out.push('\u0000' + this.jobs.length + '\u0000');
        this.jobs.push({ name, k, values: vs, level, where });
        return;
      }
      const n = Math.max(vs.length, es.length);
      for (let i = 0; i < n; i++) {
        this.value(name, k, vs[i] === undefined ? null : vs[i], es[i] === undefined ? null : es[i], level, `${where}[${i}]`,
          Array.isArray(value) ? fhirJson.writtenAs(value, i) : fhirJson.writtenAs(holder, name));
      }
    } else {
      if (Array.isArray(value) || Array.isArray(ext)) {
        throw new XmlProblem(`${where}: one value was expected, not a list`);
      }
      this.value(name, k, value === undefined ? null : value, ext === undefined ? null : ext, level, where, fhirJson.writtenAs(holder, name));
    }
  }

  /** written: how a number was written, when it was noted (library/fhir-json) */
  value(name, k, v, ext, level, where, written) {
    const ind = this.indent(level);
    if (k.kind === 'primitive') {
      if (v === null && ext === null) {
        return;
      }
      let attrs = '';
      if (ext && ext.id !== undefined) {
        attrs += ` id="${escapeAttr(String(ext.id))}"`;
      }
      if (v !== null) {
        if (typeof v === 'object') {
          throw new XmlProblem(`${where}: a primitive value was expected`);
        }
        attrs += ` value="${escapeAttr(typeof v === 'number' && written !== undefined ? written : String(v))}"`;
      }
      const exts = ext && Array.isArray(ext.extension) ? ext.extension : [];
      if (ext) {
        for (const key of Object.keys(ext)) {
          if (key !== 'id' && key !== 'extension') {
            throw new XmlProblem(`${where}: '_${name}' can only have an id and extensions, not '${key}'`);
          }
        }
      }
      if (!exts.length) {
        this.out.push(`${ind}<${name}${attrs}/>${this.nl}`);
      } else {
        this.out.push(`${ind}<${name}${attrs}>${this.nl}`);
        exts.forEach((x, i) => this.object('extension', x, 'Extension', level + 1, '', `${where}.extension[${i}]`));
        this.out.push(`${ind}</${name}>${this.nl}`);
      }
    } else if (v === null) {
      // nothing (a null in a list of complex values isn't anything)
    } else if (k.kind === 'xhtml') {
      this.out.push(ind + xhtmlForXml(v, where) + this.nl);
    } else if (k.kind === 'resource') {
      this.out.push(`${ind}<${name}>${this.nl}`);
      this.resource(v, level + 1, false);
      this.out.push(`${ind}</${name}>${this.nl}`);
    } else {
      this.object(name, v, k.key, level, '', where);
    }
  }
}

/** The narrative's XHTML, checked, with the XHTML namespace */
function xhtmlForXml(div, where) {
  if (typeof div !== 'string') {
    throw new XmlProblem(`${where}: the narrative should be a string of XHTML`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(div)) {
    throw new XmlProblem(`${where}: the narrative has a character XML can't carry`);
  }
  const v = XMLValidator.validate(div);
  if (v !== true) {
    throw new XmlProblem(`${where}: the narrative isn't well-formed XHTML (${v.err && v.err.msg})`);
  }
  if (!/^\s*<div[\s>/]/.test(div)) {
    throw new XmlProblem(`${where}: the narrative should be a div`);
  }
  if (!/^\s*<div[^>]*\sxmlns\s*=/.test(div)) {
    return div.replace(/^(\s*<div)/, `$1 xmlns="${XHTML_NS}"`);
  }
  return div;
}

// eslint-disable-next-line no-control-regex
const ATTR_NEEDS = /[&<>"\u0000-\u001F]/;

function escapeAttr(s) {
  if (!ATTR_NEEDS.test(s)) {
    return s;
  }
  return s.replace(/[&<>"\n\r\t]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\n': '&#10;', '\r': '&#13;', '\t': '&#9;' }[c]))
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, () => {
      throw new XmlProblem('a value has a character XML can\'t carry');
    });
}

// ---- XML to JSON ----

const PARSER_OPTIONS = {
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  // entities are decoded here (decodeEntities), all in one go: the parser's own would leave
  // character references, or (with htmlEntities) take HTML's too
  processEntities: false,
  htmlEntities: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
  commentPropName: false,
  // the narrative is kept as it is, as XML
  stopNodes: ['*.div']
};

/**
 * A resource from FHIR XML.
 * @param {string} text
 * @param {XmlModel} model
 * @returns {Object}
 * @throws XmlProblem when it isn't FHIR XML the model can read
 */
function fromXml(text, model) {
  if (/<!DOCTYPE/i.test(text)) {
    throw new XmlProblem('XML with a DOCTYPE is not accepted');
  }
  let nodes;
  try {
    const valid = XMLValidator.validate(text);
    if (valid !== true) {
      throw new XmlProblem(`The XML isn't well-formed: ${valid.err.msg} (line ${valid.err.line})`);
    }
    nodes = new XMLParser(PARSER_OPTIONS).parse(text);
  } catch (e) {
    if (e instanceof XmlProblem) {
      throw e;
    }
    // the parser's own limits (nesting...), and the stack
    throw new XmlProblem(e instanceof RangeError ? 'The XML is nested too deeply' : `The XML can't be read: ${e.message}`);
  }
  const roots = nodes.filter(n => elementName(n));
  if (roots.length !== 1) {
    throw new XmlProblem('The XML should have one root element, a resource');
  }
  const r = new Reader(model);
  const root = roots[0];
  const attrs = root[':@'] || {};
  if (attrs.xmlns !== FHIR_NS) {
    throw new XmlProblem(`The resource should be in the FHIR namespace (${FHIR_NS})`);
  }
  return r.resource(root, elementName(root));
}

/** XML's own entities and character references, in a value */
/**
 * Attributes that aren't content: namespace prefixes (xmlns:f), and the schema instance's
 * (xsi:schemaLocation)
 */
function notContent(name) {
  return name.startsWith('xmlns:') || name.startsWith('xsi:');
}

function decodeEntities(s, where) {
  if (!s.includes('&')) {
    return s;
  }
  return s.replace(/&([^;&\s]*);?/g, (all, name) => {
    if (!all.endsWith(';')) {
      throw new XmlProblem(`${where}: a '&' that doesn't start an entity`);
    }
    switch (name) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
    }
    const m = /^#(x[0-9a-fA-F]+|[0-9]+)$/.exec(name);
    if (m) {
      const cp = m[1].startsWith('x') ? parseInt(m[1].substring(1), 16) : parseInt(m[1], 10);
      if (cp > 0x10FFFF || (cp < 0x20 && cp !== 9 && cp !== 10 && cp !== 13)) {
        throw new XmlProblem(`${where}: &${name}; isn't a character XML can carry`);
      }
      return String.fromCodePoint(cp);
    }
    throw new XmlProblem(`${where}: &${name}; isn't one of XML's entities`);
  });
}

function elementName(node) {
  return Object.keys(node).find(k => k !== ':@' && k !== '#text') || null;
}

class Reader {
  constructor(model) {
    this.model = model;
  }

  resource(node, where) {
    const type = elementName(node);
    if (!this.model.resources.has(type) || !this.model.has(type)) {
      throw new XmlProblem(`${where}: '${type}' is not a resource type`);
    }
    const attrs = node[':@'] || {};
    if (attrs.xmlns !== undefined && attrs.xmlns !== FHIR_NS) {
      throw new XmlProblem(`${where}: the resource should be in the FHIR namespace`);
    }
    return { resourceType: type, ...this.object(node, type, where, true) };
  }

  /** The content of an element with children */
  object(node, key, where, isResource = false) {
    const name = elementName(node);
    const t = this.model.type(key);
    if (!t) {
      throw new XmlProblem(`${where}: no definition of ${key}`);
    }
    const out = {};
    const attrs = node[':@'] || {};
    for (const [a, v] of Object.entries(attrs)) {
      if ((a === 'xmlns' && (v === FHIR_NS || isResource)) || notContent(a)) {
        continue;
      }
      const m = t.byJson.get(a);
      if (!m || !m.el.attr) {
        throw new XmlProblem(`${where}: unknown attribute '${a}'`);
      }
      out[a] = this.primitive(decodeEntities(String(v), `${where}/@${a}`), this.model.kindOf(m.el, m.type), `${where}/@${a}`);
    }
    // primitives in lists are gathered, then set (their values and extensions in step)
    const lists = new Map();
    for (const child of node[name] || []) {
      const cn = elementName(child);
      if (!cn) {
        if (child['#text'] !== undefined && String(child['#text']).trim()) {
          throw new XmlProblem(`${where}: text where elements were expected`);
        }
        continue;
      }
      const m = t.byJson.get(cn);
      if (!m || m.el.attr) {
        throw new XmlProblem(`${where}: unknown element '${cn}'`);
      }
      const k = this.model.kindOf(m.el, m.type);
      const at = `${where}/${cn}`;
      let value;
      let ext = null;
      let written;
      if (k.kind === 'primitive') {
        [value, ext, written] = this.primitiveElement(child, cn, k, at);
      } else if (k.kind === 'xhtml') {
        value = this.xhtml(child, at);
      } else if (k.kind === 'resource') {
        const inner = (child[cn] || []).filter(c => elementName(c));
        if (inner.length !== 1) {
          throw new XmlProblem(`${at}: should hold one resource`);
        }
        value = this.resource(inner[0], at);
      } else {
        value = this.object(child, k.key, at);
      }
      if (m.el.array) {
        if (!lists.has(cn)) {
          lists.set(cn, { values: [], exts: [], written: [] });
        }
        lists.get(cn).values.push(value === undefined ? null : value);
        lists.get(cn).exts.push(ext);
        lists.get(cn).written.push(written);
      } else {
        if (cn in out || ('_' + cn) in out) {
          throw new XmlProblem(`${at}: is there more than once, and can only be there once`);
        }
        if (value !== undefined) {
          out[cn] = value;
          if (typeof value === 'number' && written !== undefined && String(value) !== written) {
            fhirJson.remember(out, cn, written);
          }
        }
        if (ext) {
          out['_' + cn] = ext;
        }
      }
    }
    for (const [cn, l] of lists) {
      if (l.values.some(v => v !== null)) {
        out[cn] = l.values;
        l.values.forEach((v, i) => {
          if (typeof v === 'number' && l.written[i] !== undefined && String(v) !== l.written[i]) {
            fhirJson.remember(l.values, i, l.written[i]);
          }
        });
      }
      if (l.exts.some(e => e !== null)) {
        out['_' + cn] = l.exts;
      }
    }
    return out;
  }

  /** A primitive's element: [value (or undefined), its id and extensions (or null), its text] */
  primitiveElement(node, name, k, where) {
    const attrs = node[':@'] || {};
    let ext = null;
    for (const a of Object.keys(attrs)) {
      if (a !== 'value' && a !== 'id' && !notContent(a)) {
        throw new XmlProblem(`${where}: unknown attribute '${a}'`);
      }
    }
    if (attrs.id !== undefined) {
      ext = { id: decodeEntities(String(attrs.id), `${where}/@id`) };
    }
    const exts = [];
    for (const child of node[name] || []) {
      const cn = elementName(child);
      if (!cn) {
        if (String(child['#text'] || '').trim()) {
          throw new XmlProblem(`${where}: a primitive's value goes in its value attribute`);
        }
        continue;
      }
      if (cn !== 'extension') {
        throw new XmlProblem(`${where}: unknown element '${cn}'`);
      }
      exts.push(this.object(child, 'Extension', `${where}/extension`));
    }
    if (exts.length) {
      ext = { ...(ext || {}), extension: exts };
    }
    if (attrs.value === undefined && !ext) {
      throw new XmlProblem(`${where}: has no value, id or extensions`);
    }
    const text = attrs.value === undefined ? undefined : decodeEntities(String(attrs.value), `${where}/@value`);
    const value = text === undefined ? undefined : this.primitive(text, k, `${where}/@value`);
    return [value, ext, text];
  }

  primitive(text, k, where) {
    const s = String(text);
    if (k.json === 'boolean') {
      if (s !== 'true' && s !== 'false') {
        throw new XmlProblem(`${where}: '${s}' is not a boolean`);
      }
      return s === 'true';
    }
    if (k.json === 'number') {
      if (!/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(s)) {
        throw new XmlProblem(`${where}: '${s}' is not a number`);
      }
      return Number(s);
    }
    return s;
  }

  /** The narrative: its XHTML, as a string */
  xhtml(node, where) {
    const attrs = node[':@'] || {};
    if (attrs.xmlns !== XHTML_NS) {
      throw new XmlProblem(`${where}: the narrative's div should be in the XHTML namespace (${XHTML_NS})`);
    }
    const inner = (node.div || []).map(c => c['#text'] || '').join('');
    // (the attributes as they were: their entities weren't decoded)
    let open = '<div';
    for (const [a, v] of Object.entries(attrs)) {
      open += ` ${a}="${String(v).replace(/"/g, '&quot;')}"`;
    }
    return inner === '' ? open + '/>' : `${open}>${inner}</div>`;
  }
}

// ---- large resources: in parts, without holding the event loop ----

/**
 * toXml, in parts (strings, and Buffers from the fragment cache), without holding the event
 * loop for longer than YIELD_MS at a time: the arrays of complex values are set aside as the
 * resource is written, then written an item at a time, yielding between items (an item's own
 * arrays the same way, so one concept with a large subtree doesn't hold the loop either). The
 * parts, joined, are toXml's text.
 *
 * @param {Object} resource
 * @param {XmlModel} model
 * @param {Object} [options]
 * @param {boolean} [options.pretty]
 * @param {Function} [options.stillWanted] - asked at each yield: when it returns false (the
 *   client has gone), writing stops, with an error marked abandoned
 * @param {number} [options.yieldMs] - how long to write before yielding (YIELD_MS)
 * @param {Object} [options.cache] - an XmlFragmentCache (tx/xml/xml-fragment-cache.js): the XML
 *   of a resource's large arrays is kept there (by the array, which must not change), and used
 *   again
 * @returns {Promise<Array<string|Buffer>>}
 * @throws XmlProblem (as toXml)
 */
async function toXmlChunks(resource, model, options = {}) {
  const pretty = !!options.pretty;
  const jobs = [];
  const w = new Writer(model, pretty, jobs);
  w.out.push('<?xml version="1.0" encoding="UTF-8"?>' + w.nl);
  w.resource(resource, 0, true);
  const text = w.out.join('');
  if (!jobs.length) {
    return [text];
  }
  const clock = { last: performance.now(), busy: 0, stillWanted: options.stillWanted || null, chunks: [], out: [],
    yieldMs: options.yieldMs === undefined ? YIELD_MS : options.yieldMs };
  const cache = options.cache || null;
  // the cache is shared with the tx module's own writer, which writes the same arrays
  // differently: these entries are this writer's, for this model, in this layout
  const prefix = `fhir-xml|${model.raw.version || ''}|${pretty ? 'p' : 'c'}|`;
  await expand(text, jobs, model, pretty, clock, cache, prefix);
  flush(clock);
  return clock.chunks;
}

function flush(clock) {
  if (clock.out.length) {
    clock.chunks.push(clock.out.join(''));
    clock.out.length = 0;
  }
}

function busyNow(clock) {
  return clock.busy + (performance.now() - clock.last);
}

async function maybeYield(clock) {
  const now = performance.now();
  if (now - clock.last >= clock.yieldMs) {
    clock.busy += now - clock.last;
    flush(clock);
    await new Promise(resolve => setImmediate(resolve));
    if (clock.stillWanted && !clock.stillWanted()) {
      const error = new Error('Serialising abandoned: the response is no longer wanted');
      error.abandoned = true;
      throw error;
    }
    clock.last = performance.now();
  }
}

/** The text, with each set-aside array written in its place, an item at a time */
async function expand(text, jobs, model, pretty, clock, cache, prefix) {
  const parts = text.split(MARK);
  // split leaves the text between the marks at the even positions, and the job numbers at the odd ones
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      if (parts[i]) {
        clock.out.push(parts[i]);
      }
      continue;
    }
    const job = jobs[Number(parts[i])];
    // the arrays at the first level (a CodeSystem's concepts, an expansion's contains) can be kept
    const key = cache ? prefix + job.name + '|' + job.level : null;
    const kept = key ? cache.get(job.values, key) : null;
    if (Array.isArray(kept)) {
      flush(clock);
      clock.chunks.push(...kept);
      continue;
    }
    // (a kept array's text is in chunks of its own)
    if (key) {
      flush(clock);
    }
    const first = clock.chunks.length;
    const started = busyNow(clock);
    for (let n = 0; n < job.values.length; n++) {
      const itemJobs = [];
      const w = new Writer(model, pretty, itemJobs);
      w.value(job.name, job.k, job.values[n] === undefined ? null : job.values[n], null, job.level, `${job.where}[${n}]`);
      const itemText = w.out.join('');
      if (itemJobs.length) {
        await expand(itemText, itemJobs, model, pretty, clock, null, prefix);
      } else {
        clock.out.push(itemText);
      }
      await maybeYield(clock);
    }
    if (key) {
      flush(clock);
    }
    if (key && cache.wants(job.values, key, busyNow(clock) - started)) {
      // kept encoded, a chunk at a time, and used for this response too
      const encoded = [];
      for (let c = first; c < clock.chunks.length; c++) {
        const b = Buffer.from(clock.chunks[c], 'utf8');
        clock.chunks[c] = b;
        encoded.push(b);
        await maybeYield(clock);
      }
      cache.put(job.values, key, encoded);
    }
  }
}

/**
 * Write parts (toXmlChunks) to an HTTP response and end it: Content-Length from the parts, then
 * each part as it is, waiting whenever the socket says to. Nothing is joined or encoded whole.
 * @param {http.ServerResponse} res - headers other than Content-Length already set
 * @param {Array<string|Buffer>} parts
 * @returns {Promise<number>} the bytes written
 */
async function writeParts(res, parts) {
  let size = 0;
  for (const p of parts) {
    size += typeof p === 'string' ? Buffer.byteLength(p, 'utf8') : p.length;
  }
  res.setHeader('Content-Length', size);
  if (res.req && res.req.method === 'HEAD') {
    res.end();
    return size;
  }
  for (const p of parts) {
    if (res.destroyed || res.writableEnded) {
      return size;
    }
    if (!res.write(p)) {
      await new Promise(resolve => {
        const done = () => {
          res.off('drain', done);
          res.off('close', done);
          resolve();
        };
        res.on('drain', done);
        res.on('close', done);
      });
    }
  }
  res.end();
  return size;
}

module.exports = { deriveXmlModel, XmlModel, toXml, toXmlChunks, writeParts, fromXml, loadXmlModel, XmlProblem, FHIR_NS, YIELD_MS };
