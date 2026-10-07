#!/usr/bin/env node
/**
 * export-icd11-codesystem.js -- write FHIR resources out of the database built by
 * import-icd11.js: CodeSystems, language supplements, and the postcoordination scale
 * ValueSets, optionally assembled into a FHIR NPM package.
 *
 *   node export-icd11-codesystem.js --src data/icd11-2026-01.db --out out/ --package
 *
 * For each code system it writes a base CodeSystem in the base language, plus one
 * CodeSystem supplement per additional language. MMS and ICF are emitted with a nested
 * concept hierarchy; the Foundation is a DAG so it is emitted flat, with parent and child
 * properties carrying the structure.
 *
 * These are big files, so everything is streamed -- no complete resource is ever held in
 * memory, and JSON.stringify is only ever called on one concept at a time.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { Command } = require('commander');

const TOOL_VERSION = '1.0.0';
const SCHEMA_NS = 'http://id.who.int/icd/schema';

// How the native field names map onto the resource.
// `definition` becomes CodeSystem.concept.definition; everything else is a designation.
const DESIGNATION_KINDS = [
  'fullySpecifiedName', 'longDefinition', 'codingNote', 'diagnosticCriteria',
  'inclusion', 'indexTerm',
];

// ---------------------------------------------------------------------------
// a minimal streaming JSON writer
// ---------------------------------------------------------------------------

class JsonWriter {
  constructor(stream, pretty) {
    this.s = stream;
    this.pretty = pretty;
    this.pending = Promise.resolve();
  }
  write(chunk) {
    if (!this.s.write(chunk)) {
      this.pending = this.pending.then(() => new Promise(r => this.s.once('drain', r)));
    }
    return this.pending;
  }
  /** Serialise one value. Only ever called on a single concept, never the whole resource. */
  value(v, indent) {
    return this.pretty ? JSON.stringify(v, null, 2).replace(/\n/g, '\n' + ' '.repeat(indent))
                       : JSON.stringify(v);
  }
  async end() {
    await this.pending;
    await new Promise((res, rej) => { this.s.end(err => err ? rej(err) : res()); });
  }
}

// ---------------------------------------------------------------------------
// a minimal streaming ustar writer, so packaging needs no external tar binary
// ---------------------------------------------------------------------------

function tarHeader(name, size, mtime) {
  const h = Buffer.alloc(512);
  let prefix = '';
  let nm = name;
  if (Buffer.byteLength(nm) > 100) {          // split long paths across name/prefix
    const cut = nm.lastIndexOf('/', nm.length - 100);
    if (cut < 0) throw new Error(`path too long for tar: ${nm}`);
    prefix = nm.slice(0, cut);
    nm = nm.slice(cut + 1);
  }
  const put = (s, off, len) => h.write(s.slice(0, len), off, len, 'utf8');
  const oct = (n, off, len) => h.write(n.toString(8).padStart(len - 1, '0') + '\0', off, len, 'ascii');
  put(nm, 0, 100);
  oct(0o644, 100, 8); oct(0, 108, 8); oct(0, 116, 8);
  oct(size, 124, 12); oct(Math.floor(mtime / 1000), 136, 12);
  h.write('        ', 148, 8, 'ascii');       // checksum placeholder: spaces
  h.write('0', 156, 1, 'ascii');              // typeflag: regular file
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  if (prefix) put(prefix, 345, 155);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return h;
}

/** tar + gzip every file in `dir` (recursively) into `outFile`, streaming. */
async function tarGzDirectory(dir, outFile, root) {
  const gz = zlib.createGzip({ level: 9 });
  const out = fs.createWriteStream(outFile);
  const done = new Promise((res, rej) => { out.on('finish', res); out.on('error', rej); });
  gz.pipe(out);
  const write = (chunk) => new Promise((res) => { if (gz.write(chunk)) res(); else gz.once('drain', res); });

  const walk = function* (d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const full = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) yield* walk(full, r); else yield [full, r];
    }
  };
  for (const [full, rel] of walk(dir, root)) {
    const st = fs.statSync(full);
    await write(tarHeader(rel, st.size, st.mtimeMs));
    await new Promise((res, rej) => {
      const rs = fs.createReadStream(full);
      rs.on('data', c => { if (!gz.write(c)) { rs.pause(); gz.once('drain', () => rs.resume()); } });
      rs.on('end', res); rs.on('error', rej);
    });
    const pad = (512 - (st.size % 512)) % 512;
    if (pad) await write(Buffer.alloc(pad));
  }
  await write(Buffer.alloc(1024));            // two zero blocks terminate the archive
  gz.end();
  await done;
}

function openOut(file, gzip) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const target = gzip ? file + '.gz' : file;
  const out = fs.createWriteStream(target);
  if (!gzip) return { stream: out, target, finished: new Promise(r => out.on('finish', r)) };
  const gz = zlib.createGzip({ level: 9 });
  gz.pipe(out);
  return { stream: gz, target, finished: new Promise(r => out.on('finish', r)) };
}

// ---------------------------------------------------------------------------
// exporter
// ---------------------------------------------------------------------------

class CodeSystemExporter {
  constructor(opts) {
    this.opts = opts;
    this.db = new Database(opts.src, { readonly: true });
    this.log = (...a) => console.log(...a);
  }

  meta(key) {
    const r = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key);
    return r ? r.value : null;
  }

  /**
   * Which string is CodeSystem.concept.code. This is the unresolved community question --
   * the Geneva straw poll ran 7-1 for bare entity ids over the current hybrid -- so it is
   * a switch rather than a decision baked into the output.
   *
   *   hybrid : the short code where there is one, the entity uri otherwise (what the WHO
   *            FHIR server does today, and what existing data uses)
   *   short  : the short code; concepts without one are dropped from the resource
   *   uri    : the unversioned entity uri, always
   *   id     : the bare entity id, always (straw poll option 4)
   */
  codeOf(c) {
    switch (this.opts.codeForm) {
      case 'short': return c.code;
      case 'uri':   return c.uri;
      case 'id':    return c.entity_id;
      default:      return c.code || c.uri;
    }
  }

  // -- the declarations WHO's own CodeSystem omits --------------------------

  // NOTE on types: CodeSystem.property.type is bound to a required value set that does not
  // include `uri`, and concept.property.value[x] has no valueUri choice either -- the
  // allowed types are code | Coding | string | integer | boolean | dateTime | decimal.
  // Uri-valued properties are therefore declared and emitted as strings. (This is the same
  // mistake the WHO server makes on ValueSet.expansion.contains.property.value[x], where it
  // returns valueUri and no conformant client can parse the result.)
  properties(sys) {
    const p = [
      { code: 'entityId', uri: `${SCHEMA_NS}/entityId`, type: 'string',
        description: 'The stable WHO entity id. Residual categories carry a derived id such as 1363559646/other.' },
      { code: 'uri', uri: `${SCHEMA_NS}/uri`, type: 'string',
        description: 'The canonical entity uri, unversioned.' },
      // Coding, not code: CodeSystem.property gives no way to say which code system a
      // code-typed property draws its values from, so the validator assumes this one, and
      // 'category' is not a code in ICD-11. A Coding names the schema code system outright.
      { code: 'classKind', uri: `${SCHEMA_NS}/classKind`, type: 'Coding',
        description: 'chapter | block | window | category. Only categories may be used to code with.' },
      { code: 'notSelectable', uri: 'http://hl7.org/fhir/concept-properties#notSelectable', type: 'boolean',
        description: 'True where the concept is a grouper: it has no short code and must not be used to code with.' },
      { code: 'child', uri: 'http://hl7.org/fhir/concept-properties#child', type: 'code',
        description: 'A child of this concept.' },
      { code: 'parent', uri: 'http://hl7.org/fhir/concept-properties#parent', type: 'code',
        description: 'A parent of this concept.' },
    ];
    if (this.opts.codeForm !== 'short') {
      p.push({ code: 'shortCode', uri: `${SCHEMA_NS}/code`, type: 'string',
        description: 'The short "pretty" code, where the entity has one. Short codes may change between releases; entity ids do not.' });
    }
    if (sys.code !== 'foundation') {
      p.push(
        { code: 'foundationUri', uri: `${SCHEMA_NS}/source`, type: 'string',
          description: 'The Foundation entity this linearization entry was derived from.' },
        { code: 'blockId', uri: `${SCHEMA_NS}/blockId`, type: 'string' },
        { code: 'codeRange', uri: `${SCHEMA_NS}/codeRange`, type: 'string' },
        { code: 'postcoordinationScale', uri: `${SCHEMA_NS}/postcoordinationScale`, type: 'string',
          description: 'The ValueSet of permitted values for one postcoordination axis of this concept. Repeats, once per axis.' },
        { code: 'requiredPostcoordination', uri: `${SCHEMA_NS}/requiredPostcoordination`, type: 'string',
          description: 'A postcoordination axis that WHO marks as required. In practice this means strongly encouraged: the code stays valid without it.' },
      );
    }
    p.push({ code: 'browserUrl', uri: `${SCHEMA_NS}/browserUrl`, type: 'string' });
    return p;
  }

  filters() {
    return [
      { code: 'concept', description: 'Filter on the classification hierarchy.',
        operator: ['is-a', 'descendent-of'], value: 'A code in this code system' },
      { code: 'classKind', description: 'Filter by the kind of entity.',
        operator: ['=', 'in'], value: 'chapter | block | window | category' },
      { code: 'notSelectable', description: 'Include or exclude groupers.',
        operator: ['='], value: 'true or false' },
    ];
  }

  // -- data loading ---------------------------------------------------------

  loadDesignations(systemId, lang) {
    const map = new Map();
    const stmt = this.db.prepare(`
      SELECT d.concept, d.kind, d.value FROM designation d
        JOIN concept c ON c.id = d.concept
       WHERE c.system = ? AND d.lang = ?
       ORDER BY d.concept, d.seq`);
    for (const r of stmt.iterate(systemId, lang)) {
      let e = map.get(r.concept);
      if (!e) { e = {}; map.set(r.concept, e); }
      (e[r.kind] ||= []).push(r.value);
    }
    return map;
  }

  loadScales(systemId) {
    const map = new Map();
    for (const r of this.db.prepare(`
        SELECT ps.concept, ps.value_set_uri, ps.required FROM pc_scale ps
          JOIN concept c ON c.id = ps.concept WHERE c.system = ? ORDER BY ps.seq`).iterate(systemId)) {
      let e = map.get(r.concept);
      if (!e) { e = []; map.set(r.concept, e); }
      e.push(r);
    }
    return map;
  }

  loadConcepts(systemId) {
    const rows = this.db.prepare(`
      SELECT id, entity_id, uri, code, class_kind, selectable, residual, depth,
             block_id, code_range, source_uri, browser_url, lft
        FROM concept WHERE system = ? ORDER BY COALESCE(lft, id)`).all(systemId);
    const byId = new Map(rows.map(r => [r.id, r]));
    const kids = new Map();
    const parents = new Map();
    for (const r of this.db.prepare(`
        SELECT cp.child, cp.parent FROM concept_parent cp
          JOIN concept c ON c.id = cp.child WHERE c.system = ? ORDER BY cp.seq`).iterate(systemId)) {
      (kids.get(r.parent) ?? kids.set(r.parent, []).get(r.parent)).push(r.child);
      (parents.get(r.child) ?? parents.set(r.child, []).get(r.child)).push(r.parent);
    }
    const roots = rows.filter(r => !parents.has(r.id)).map(r => r.id);
    return { rows, byId, kids, parents, roots };
  }

  // -- one concept ----------------------------------------------------------

  conceptJson(c, ctx, { nested }) {
    const code = this.codeOf(c);
    if (code == null) return null;
    const d = ctx.desig.get(c.id) || {};
    const out = { code };

    const title = d.title && d.title[0];
    if (title) out.display = title;
    if (d.definition && d.definition[0]) out.definition = d.definition[0];

    const designation = [];
    for (const kind of DESIGNATION_KINDS) {
      for (const v of d[kind] || []) {
        designation.push({
          language: ctx.lang,
          use: { system: SCHEMA_NS, code: kind },
          value: v,
        });
      }
    }
    if (designation.length) out.designation = designation;

    const property = [];
    const put = (c_, k, v) => { if (v != null && v !== '') property.push({ code: c_, [k]: v }); };
    put('entityId', 'valueString', c.entity_id);
    put('uri', 'valueString', c.uri);
    if (this.opts.codeForm !== 'short') put('shortCode', 'valueString', c.code);
    if (c.class_kind) property.push({ code: 'classKind',
      valueCoding: { system: SCHEMA_NS, code: c.class_kind } });
    if (!c.selectable) property.push({ code: 'notSelectable', valueBoolean: true });
    put('blockId', 'valueString', c.block_id);
    put('codeRange', 'valueString', c.code_range);
    put('foundationUri', 'valueString', c.source_uri);
    put('browserUrl', 'valueString', c.browser_url);
    for (const s of ctx.scales.get(c.id) || []) {
      property.push({ code: 'postcoordinationScale', valueString: s.value_set_uri });
      if (s.required) property.push({ code: 'requiredPostcoordination', valueString: s.value_set_uri });
    }
    // A flat resource has to carry the hierarchy in properties; a nested one does not.
    if (!nested) {
      for (const p of ctx.parents.get(c.id) || []) {
        const pc = this.codeOf(ctx.byId.get(p));
        if (pc != null) property.push({ code: 'parent', valueCode: pc });
      }
      for (const k of ctx.kids.get(c.id) || []) {
        const kc = this.codeOf(ctx.byId.get(k));
        if (kc != null) property.push({ code: 'child', valueCode: kc });
      }
    }
    if (property.length) out.property = property;
    return out;
  }

  // -- the base resource ----------------------------------------------------

  async exportSystem(sys, languages) {
    const baseLang = languages[0];
    const nested = !!sys.is_tree && this.opts.hierarchy !== 'flat';
    const ctx = this.loadConcepts(sys.id);
    ctx.desig = this.loadDesignations(sys.id, baseLang);
    ctx.scales = this.loadScales(sys.id);
    ctx.lang = baseLang;

    const count = ctx.rows.filter(r => this.codeOf(r) != null).length;
    const base = `CodeSystem-icd11-${sys.code}-${sys.version}.json`;
    const file = path.join(this.dir, base);
    this.index.push({ filename: base, resourceType: 'CodeSystem',
                      id: `icd11-${sys.code}-${sys.version}`, url: sys.url, version: sys.version });
    const { stream, target, finished } = openOut(file, this.opts.gzip);
    const w = new JsonWriter(stream, this.opts.pretty);
    const nl = this.opts.pretty ? '\n' : '';
    const ind = this.opts.pretty ? '  ' : '';

    const header = {
      resourceType: 'CodeSystem',
      id: `icd11-${sys.code}-${sys.version}`,
      url: sys.url,
      version: sys.version,
      name: `ICD11${sys.code.toUpperCase()}`,
      title: sys.title,
      status: 'active',
      experimental: false,
      date: this.meta('importStarted') || new Date().toISOString(),
      publisher: 'World Health Organization',
      contact: [{ telecom: [{ system: 'url', value: 'https://icd.who.int' }] }],
      description: `${sys.title}. Generated from the WHO ICD-API by export-icd11-codesystem ${TOOL_VERSION}.`,
      copyright: 'World Health Organization. ICD-11 is licensed under CC BY-ND 3.0 IGO. '
               + 'The licence prohibits distributing mappings to or from other classifications, '
               + 'and translations require a separate written agreement with WHO.',
      caseSensitive: this.opts.caseSensitive,
      valueSet: this.opts.valueSet ? `${sys.url}/vs` : undefined,
      hierarchyMeaning: sys.code === 'foundation' ? 'is-a' : 'classified-with',
      compositional: sys.code !== 'foundation',
      versionNeeded: true,
      content: 'complete',
      count,
      filter: this.filters(),
      property: this.properties(sys),
    };
    for (const k of Object.keys(header)) if (header[k] === undefined) delete header[k];

    // header, then the concept array streamed one entry at a time
    const head = JSON.stringify(header, null, this.opts.pretty ? 2 : 0);
    await w.write(head.slice(0, head.lastIndexOf('}')).replace(/\s*$/, '') + `,${nl}${ind}"concept": [`);

    let written = 0, first = true;
    const emit = async (json, depth) => {
      await w.write((first ? '' : ',') + nl + (this.opts.pretty ? ind.repeat(depth + 1) : '')
                    + w.value(json, this.opts.pretty ? 2 * (depth + 1) : 0));
      first = false;
      if (++written % 20000 === 0) this.log(`    ${written}/${count}`);
    };

    if (nested) {
      // Depth-first, emitting each concept with its children inline. Children are written
      // by hand rather than nested into the parent object, so no subtree is ever fully
      // materialised in memory.
      const self = this;
      const walk = async (id, depth) => {
        const c = ctx.byId.get(id);
        const json = this.conceptJson(c, ctx, { nested: true });
        if (!json) { // a concept with no code under --code-form short: skip it, keep its children
          for (const k of ctx.kids.get(id) || []) await walk(k, depth);
          return;
        }
        const kids = ctx.kids.get(id) || [];
        const body = w.value(json, this.opts.pretty ? 2 * (depth + 1) : 0);
        const pad = this.opts.pretty ? ind.repeat(depth + 1) : '';
        if (!kids.length) {
          await w.write((first ? '' : ',') + nl + pad + body);
          first = false;
        } else {
          await w.write((first ? '' : ',') + nl + pad
            + body.slice(0, body.lastIndexOf('}')).replace(/\s*$/, '')
            + `,${nl}${this.opts.pretty ? ind.repeat(depth + 2) : ''}"concept": [`);
          const outerFirst = first; first = true;
          for (const k of kids) await walk(k, depth + 2);
          first = outerFirst;
          await w.write(`${nl}${this.opts.pretty ? ind.repeat(depth + 2) : ''}]${nl}${pad}}`);
          first = false;
        }
        if (++written % 20000 === 0) this.log(`    ${written}/${count}`);
      };
      for (const r of ctx.roots) await walk(r, 0);
    } else {
      for (const c of ctx.rows) {
        const json = this.conceptJson(c, ctx, { nested: false });
        if (json) await emit(json, 0);
      }
    }

    await w.write(`${nl}${ind}]${nl}}${nl}`);
    await w.end();
    await finished;
    const size = fs.statSync(target).size;
    this.log(`  ${path.basename(target)}  ${written} concepts, ${(size / 1048576).toFixed(1)} MB`
             + `  [${nested ? 'nested' : 'flat'}, ${this.opts.codeForm}]`);
    return { target, written, ctx };
  }

  // -- supplements ----------------------------------------------------------

  async exportSupplement(sys, lang, ctx) {
    const desig = this.loadDesignations(sys.id, lang);
    const base = `CodeSystem-icd11-${sys.code}-${sys.version}-${lang}.json`;
    const file = path.join(this.dir, base);
    this.index.push({ filename: base, resourceType: 'CodeSystem',
                      id: `icd11-${sys.code}-${sys.version}-${lang}`,
                      url: `${sys.url}/supplement/${lang}`, version: sys.version });
    const { stream, target, finished } = openOut(file, this.opts.gzip);
    const w = new JsonWriter(stream, this.opts.pretty);
    const nl = this.opts.pretty ? '\n' : '';
    const ind = this.opts.pretty ? '  ' : '';

    const header = {
      resourceType: 'CodeSystem',
      id: `icd11-${sys.code}-${sys.version}-${lang}`,
      url: `${sys.url}/supplement/${lang}`,
      version: sys.version,
      name: `ICD11${sys.code.toUpperCase()}${lang.toUpperCase()}`,
      title: `${sys.title} -- ${lang}`,
      status: 'active',
      experimental: false,
      language: lang,
      date: this.meta('importStarted') || new Date().toISOString(),
      publisher: 'World Health Organization',
      description: `${lang} language supplement for ${sys.url}.`,
      copyright: 'World Health Organization. Translations of ICD-11 are produced under WHO '
               + 'control; redistributing a translation requires a separate written agreement with WHO.',
      content: 'supplement',
      supplements: `${sys.url}|${sys.version}`,
    };
    const head = JSON.stringify(header, null, this.opts.pretty ? 2 : 0);
    await w.write(head.slice(0, head.lastIndexOf('}')).replace(/\s*$/, '') + `,${nl}${ind}"concept": [`);

    let written = 0, first = true;
    for (const c of ctx.rows) {
      const code = this.codeOf(c);
      if (code == null) continue;
      const d = desig.get(c.id);
      if (!d) continue;
      const designation = [];
      const title = d.title && d.title[0];
      if (title) designation.push({ language: lang, value: title });
      if (d.definition && d.definition[0]) {
        designation.push({ language: lang, use: { system: SCHEMA_NS, code: 'definition' }, value: d.definition[0] });
      }
      for (const kind of DESIGNATION_KINDS) {
        for (const v of d[kind] || []) {
          designation.push({ language: lang, use: { system: SCHEMA_NS, code: kind }, value: v });
        }
      }
      if (!designation.length) continue;
      await w.write((first ? '' : ',') + nl + (this.opts.pretty ? ind.repeat(2) : '')
                    + w.value({ code, designation }, this.opts.pretty ? 4 : 0));
      first = false;
      written++;
    }
    await w.write(`${nl}${ind}]${nl}}${nl}`);
    await w.end();
    await finished;
    const size = fs.statSync(target).size;
    this.log(`  ${path.basename(target)}  ${written} concepts, ${(size / 1048576).toFixed(1)} MB  [supplement]`);
  }

  /**
   * The vocabulary the exported resources lean on: the designation.use codes and the
   * classKind values. Without this, every designation raises "a definition for CodeSystem
   * http://id.who.int/icd/schema could not be found" and the codes cannot be validated.
   */
  writeSchemaCodeSystem() {
    const cs = {
      resourceType: 'CodeSystem',
      id: 'icd11-schema',
      url: SCHEMA_NS,
      version: this.meta('release') || '2026-01',
      name: 'ICD11Schema',
      title: 'ICD-11 schema vocabulary',
      status: 'active',
      experimental: false,
      publisher: 'World Health Organization',
      description: 'The designation kinds and class kinds used by the generated ICD-11 CodeSystem '
                 + 'resources. These names are WHO\'s own, taken from the ICD-API entity model.',
      caseSensitive: true,
      content: 'complete',
      concept: [
        { code: 'title', display: 'Title', definition: 'The preferred display for the entity.' },
        { code: 'definition', display: 'Definition', definition: 'The short definition of the entity.' },
        { code: 'longDefinition', display: 'Long definition' },
        { code: 'fullySpecifiedName', display: 'Fully specified name' },
        { code: 'codingNote', display: 'Coding note', definition: 'Guidance to the coder, not a synonym.' },
        { code: 'diagnosticCriteria', display: 'Diagnostic criteria' },
        { code: 'inclusion', display: 'Inclusion term', definition: 'A term the entity explicitly includes.' },
        { code: 'indexTerm', display: 'Index term', definition: 'A term the alphabetical index maps to this entity. These are what the ICD Browser searches on.' },
        { code: 'chapter', display: 'Chapter', definition: 'A top-level division of the classification.' },
        { code: 'block', display: 'Block', definition: 'A grouper. Has no short code and cannot be used to code with.' },
        { code: 'window', display: 'Window', definition: 'A presentation grouper. Cannot be used to code with.' },
        { code: 'category', display: 'Category', definition: 'A codeable entity.' },
      ],
    };
    cs.count = cs.concept.length;
    const file = path.join(this.dir, 'CodeSystem-icd11-schema.json');
    fs.writeFileSync(file, JSON.stringify(cs, null, 2) + '\n');
    this.index.push({ filename: 'CodeSystem-icd11-schema.json', resourceType: 'CodeSystem',
                      id: cs.id, url: cs.url, version: cs.version });
    this.log(`  ${path.basename(file)}  ${cs.count} concepts  [schema vocabulary]`);
  }

  // -- postcoordination value sets -----------------------------------------

  /**
   * One ValueSet per postcoordination axis per stem -- 25,354 of them for 2026-01.
   *
   * These are compose-only. Pre-expanding the set would be 14.6 million expansion rows
   * (1,743 axes have over a thousand members each), so membership is expressed the way
   * WHO expresses it: one `concept is-a` include per scale root.
   *
   * The axis rules -- whether the axis is required, and whether it admits more than one
   * value -- have nowhere to live in a ValueSet, so they go on as extensions. A validator
   * checking a postcoordinated expression needs them.
   */
  writeValueSets(sys) {
    const rows = this.db.prepare(`
      SELECT ps.id, ps.axis, ps.axis_name, ps.required, ps.allow_multiple, ps.value_set_uri,
             c.id AS cid, c.entity_id, c.uri AS stem_uri, c.code AS stem_code
        FROM pc_scale ps JOIN concept c ON c.id = ps.concept
       WHERE c.system = ? ORDER BY c.id, ps.seq`).all(sys.id);
    if (!rows.length) return 0;

    const entities = new Map();
    for (const r of this.db.prepare(`
        SELECT e.scale, e.target_uri, c.code, c.entity_id, c.uri
          FROM pc_scale_entity e
          JOIN pc_scale ps ON ps.id = e.scale
          JOIN concept s ON s.id = ps.concept
          LEFT JOIN concept c ON c.id = e.target
         WHERE s.system = ? ORDER BY e.scale, e.seq`).iterate(sys.id)) {
      (entities.get(r.scale) ?? entities.set(r.scale, []).get(r.scale)).push(r);
    }
    const titleOf = new Map();
    for (const r of this.db.prepare(`
        SELECT d.concept, d.value FROM designation d JOIN concept c ON c.id = d.concept
         WHERE c.system = ? AND d.lang = ? AND d.kind = 'title'`).iterate(sys.id, this.baseLang)) {
      if (!titleOf.has(r.concept)) titleOf.set(r.concept, r.value);
    }

    const date = this.meta('importStarted') || new Date().toISOString();
    const seen = new Set();
    let n = 0, longest = 0, hashed = 0;
    for (const r of rows) {
      // FHIR ids are capped at 64 chars. Rather than truncate and hope, anything over the
      // limit keeps a deterministic hash of the full name so two long axis names on one
      // stem can never collide.
      let id = `icd11-${sys.code}-${r.entity_id.replace(/\//g, '-')}-${r.axis_name}`
        .replace(/[^A-Za-z0-9.-]/g, '-');
      if (id.length > 64) {
        const h = crypto.createHash('sha1').update(id).digest('hex').slice(0, 7);
        id = `${id.slice(0, 56)}-${h}`;
      }
      if (seen.has(id)) throw new Error(`duplicate ValueSet id ${id}`);
      seen.add(id);
      longest = Math.max(longest, id.length);
      if (id.length === 64 && id[56] === '-') hashed++;
      const stemLabel = titleOf.get(r.cid) || r.entity_id;
      const include = (entities.get(r.id) || []).map(e => ({
        system: sys.url,
        version: sys.version,
        filter: [{ property: 'concept', op: 'is-a',
                   value: e.code == null && e.uri == null ? e.target_uri
                        : this.codeOf({ code: e.code, uri: e.uri, entity_id: e.entity_id }) }],
      })).filter(i => i.filter[0].value != null);

      const vs = {
        resourceType: 'ValueSet',
        id,
        extension: [
          { url: `${SCHEMA_NS}/postcoordinationAxis`, valueUri: r.axis },
          { url: `${SCHEMA_NS}/stem`, valueUri: r.stem_uri },
          { url: `${SCHEMA_NS}/requiredPostcoordination`, valueBoolean: !!r.required },
          { url: `${SCHEMA_NS}/allowMultipleValues`, valueCode: r.allow_multiple || 'NotAllowed' },
        ],
        url: r.value_set_uri,
        version: sys.version,
        // ValueSet.name is bound to [A-Z]([A-Za-z0-9_]){1,254}
        name: 'ICD11_' + id.replace(/^icd11-/, '').replace(/[^A-Za-z0-9]/g, '_'),
        title: `Postcoordination scale ${r.axis_name} for ${r.stem_code || r.entity_id}`,
        status: 'active',
        experimental: false,
        date,
        publisher: 'World Health Organization',
        description: `Values permitted on the ${r.axis_name} postcoordination axis of `
          + `${r.stem_code ? r.stem_code + ' ' : ''}${stemLabel}. `
          + `${r.required ? 'WHO marks this axis as required, which in practice means strongly '
                          + 'encouraged: the stem code stays valid without it. ' : ''}`
          + `Multiple values: ${r.allow_multiple || 'NotAllowed'}.`,
        compose: { include },
      };
      fs.writeFileSync(path.join(this.dir, `ValueSet-${id}.json`), JSON.stringify(vs) + '\n');
      this.index.push({ filename: `ValueSet-${id}.json`, resourceType: 'ValueSet',
                        id, url: vs.url, version: vs.version });
      if (++n % 10000 === 0) this.log(`    ${n}/${rows.length}`);
    }
    this.log(`  ${n} ValueSets  [compose-only, longest id ${longest} chars`
           + `${hashed ? `, ${hashed} hash-suffixed` : ''}]`);
    return n;
  }

  /**
   * StructureDefinitions for the four extensions the ValueSets carry. An undefined
   * extension is an ERROR to the validator ("could not be found so is not allowed here"),
   * not a warning, so a package that uses extensions has to define them to be loadable.
   */
  writeExtensionDefinitions() {
    const exts = [
      ['postcoordinationAxis', 'uri', 'Postcoordination axis',
       'The WHO schema uri of the postcoordination axis this value set enumerates.'],
      ['stem', 'uri', 'Stem concept',
       'The concept whose postcoordination axis this value set belongs to.'],
      ['requiredPostcoordination', 'boolean', 'Required postcoordination',
       'Whether WHO marks this axis as required. In practice this means strongly encouraged: '
       + 'the stem code remains valid without a value on the axis.'],
      ['allowMultipleValues', 'code', 'Allow multiple values',
       'AllowAlways | NotAllowed | AllowedExceptFromSameBlock -- whether more than one value '
       + 'may be given on this axis of this stem.'],
    ];
    for (const [name, type, title, desc] of exts) {
      const id = `icd11-${name}`;
      const url = `${SCHEMA_NS}/${name}`;
      const sd = {
        resourceType: 'StructureDefinition',
        id, url,
        version: this.meta('release') || '2026-01',
        name: `ICD11${name[0].toUpperCase()}${name.slice(1)}`,
        title, status: 'active', experimental: false,
        publisher: 'World Health Organization',
        description: desc,
        fhirVersion: '5.0.0',
        kind: 'complex-type', abstract: false,
        context: [{ type: 'element', expression: 'ValueSet' }],
        type: 'Extension',
        baseDefinition: 'http://hl7.org/fhir/StructureDefinition/Extension',
        derivation: 'constraint',
        differential: { element: [
          { id: 'Extension', path: 'Extension', short: title, definition: desc, min: 0, max: '1' },
          { id: 'Extension.extension', path: 'Extension.extension', max: '0' },
          { id: 'Extension.url', path: 'Extension.url', fixedUri: url },
          { id: 'Extension.value[x]', path: 'Extension.value[x]', min: 1, max: '1',
            type: [{ code: type }] },
        ] },
      };
      fs.writeFileSync(path.join(this.dir, `StructureDefinition-${id}.json`),
                       JSON.stringify(sd, null, 2) + '\n');
      this.index.push({ filename: `StructureDefinition-${id}.json`,
                        resourceType: 'StructureDefinition', id, url, version: sd.version });
    }
    this.log(`  ${exts.length} extension StructureDefinitions`);
  }

  // -- package --------------------------------------------------------------

  writePackageJson(systems) {
    const pkg = {
      name: this.opts.packageId,
      version: this.opts.packageVersion,
      description: 'ICD-11 as FHIR CodeSystem and ValueSet resources, generated from the WHO '
                 + `ICD-API release ${this.meta('release')} by export-icd11-codesystem ${TOOL_VERSION}. `
                 + 'Not a WHO publication.',
      fhirVersions: ['5.0.0'],
      type: 'fhir.ig',
      canonical: 'http://id.who.int/icd',
      url: 'https://icd.who.int',
      author: 'World Health Organization (content); generated by FHIRsmith tooling',
      license: 'CC-BY-ND-3.0-IGO',
      dependencies: { 'hl7.fhir.r5.core': '5.0.0' },
      'icd11:systems': systems,
      'icd11:release': this.meta('release'),
      'icd11:sourceEndpoint': this.meta('nativeEndpoint'),
    };
    fs.writeFileSync(path.join(this.dir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  }

  writeIndex() {
    fs.writeFileSync(path.join(this.dir, '.index.json'),
      JSON.stringify({ 'index-version': 2, files: this.index }, null, 2) + '\n');
  }

  // -- driver ---------------------------------------------------------------

  async run() {
    const t0 = Date.now();
    if (!this.opts.packageVersion) {
      const rel = this.meta('release') || '0.0.0';
      const m = rel.match(/^(\d{4})-(\d{2})$/);
      this.opts.packageVersion = m ? `${m[1]}.${parseInt(m[2], 10)}.0` : rel;
    }
    const available = (this.meta('languages') || 'en').split(',');
    const languages = this.opts.languages === 'all'
      ? available
      : this.opts.languages.split(',').map(s => s.trim()).filter(Boolean);
    const wanted = this.opts.systems.split(',').map(s => s.trim()).filter(Boolean);
    this.baseLang = languages[0];
    this.index = [];

    // When packaging, every resource goes under out/package/ so the directory can be
    // tarred as-is into a FHIR NPM package.
    this.dir = this.opts.package ? path.join(this.opts.out, 'package') : this.opts.out;
    fs.mkdirSync(this.dir, { recursive: true });

    this.log(`ICD-11 FHIR export`);
    this.log(`  source    : ${this.opts.src}`);
    this.log(`  out       : ${this.dir}`);
    this.log(`  code form : ${this.opts.codeForm}`);
    this.log(`  languages : ${languages.join(', ')} (base ${this.baseLang})`);
    this.log(`  value sets: ${this.opts.valueSets ? 'yes' : 'no'}`
           + `   package: ${this.opts.package ? `${this.opts.packageId}#${this.opts.packageVersion}` : 'no'}`);

    this.log('');
    this.writeSchemaCodeSystem();
    if (this.opts.valueSets) this.writeExtensionDefinitions();

    const done = [];
    for (const code of wanted) {
      const sys = this.db.prepare('SELECT * FROM system WHERE code=?').get(code);
      if (!sys) { this.log(`  ! ${code} is not in this database, skipping`); continue; }
      this.log(`\n${sys.code} -- ${sys.title}`);
      const { ctx } = await this.exportSystem(sys, languages);
      for (const lang of languages.slice(1)) await this.exportSupplement(sys, lang, ctx);
      if (this.opts.valueSets) this.writeValueSets(sys);
      done.push(sys.code);
    }

    if (this.opts.package) {
      this.writePackageJson(done);
      this.writeIndex();
      const tgz = path.join(this.opts.out, `${this.opts.packageId}-${this.opts.packageVersion}.tgz`);
      this.log(`\npackaging ${this.index.length + 2} files...`);
      await tarGzDirectory(this.dir, tgz, 'package');
      const size = fs.statSync(tgz).size;
      this.log(`  ${path.basename(tgz)}  ${(size / 1048576).toFixed(1)} MB`);
    }
    this.log(`\ndone in ${Math.round((Date.now() - t0) / 1000)}s`);
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// cli
// ---------------------------------------------------------------------------

function main(argv) {
  const program = new Command();
  program
    .name('export-icd11-codesystem')
    .description('Write FHIR CodeSystem resources from an ICD-11 import database')
    .requiredOption('-s, --src <file>', 'the database built by import-icd11.js')
    .requiredOption('-o, --out <dir>', 'output directory')
    .option('--systems <list>', 'which code systems to export', 'mms,icf,foundation')
    .option('-l, --languages <list>', "comma separated, or 'all'; the first is the base language", 'all')
    .option('--code-form <form>', 'hybrid | short | uri | id -- what goes in concept.code', 'hybrid')
    .option('--hierarchy <how>', 'nested | flat (the Foundation is always flat)', 'nested')
    .option('--no-value-set', 'do not declare an all-codes value set in CodeSystem.valueSet')
    .option('--case-sensitive <b>', 'value for CodeSystem.caseSensitive', v => v !== 'false', true)
    .option('--no-value-sets', 'skip the postcoordination scale ValueSets')
    .option('--package', 'assemble the output as a FHIR NPM package (.tgz)', false)
    .option('--package-id <id>', 'package name', 'who.icd11')
    .option('--package-version <v>', 'package version (semver); default derived from the release')
    .option('--gzip', 'gzip individual files (ignored when --package is set)', false)
    .option('--pretty', 'pretty print (much larger)', false);

  program.parse(argv);
  const opts = program.opts();
  if (!['hybrid', 'short', 'uri', 'id'].includes(opts.codeForm)) {
    throw new Error(`--code-form must be hybrid, short, uri or id`);
  }
  // A package holds plain JSON; the tarball does the compressing.
  if (opts.package) opts.gzip = false;
  return new CodeSystemExporter(opts).run();
}

if (require.main === module) {
  main(process.argv).catch(e => {
    console.error(`\nexport failed: ${e && e.stack || e}`);
    process.exit(1);
  });
}

module.exports = { CodeSystemExporter, main };
