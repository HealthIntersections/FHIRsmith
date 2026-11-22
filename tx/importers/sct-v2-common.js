'use strict';

// SNOMED CT -> a terminology file (tx/importers/sqlite-v2/schema.sql): the RF2 reading helpers and
// everything after parsing, shared by the RF2 importer (import-sct-v2.module.js) and the cache
// importer (import-sct-v2-cache.module.js).
//
// A parser feeds a SnomedSink in this order: concepts, conceptMeta, languageMember (held until the
// descriptions), description, concreteTypes, relationship, concreteValue, identifier,
// refsetMember / moduleDependency; then finish(). Where each fact goes:
//   concept          code, active; display (derived: preferred synonym in the display refsets in
//                    order, else preferred in any language refset, else FSN, else the first active
//                    description; ties by description id: cs-snomed.js's rule)
//   item             every description and text definition (kind 1), active and inactive:
//                    external_id = the description SCTID, use = its type (item_use display = the type
//                    concept's display), language, preferred (a description Preferred in
//                    `preferredRefset`; a definition: the one the concept shows, its last active
//                    one); rank is derived by the builder from the language relations and meta
//                    displayContexts (synonyms: 0 Preferred in a display refset, 1 in another, 2 any other)
//   link             relationships (inferred, active and inactive; group_id = role group, seq = row
//                    order), moduleId and definitionStatusId (non-refinable); a relationship typed by
//                    a concrete-value attribute (UK: retired drug rows) is a link of that literal
//                    property, which is then shape 'both'
//   literal          concrete values (active inferred), effectiveTime (non-refinable)
//   record           every reference set: language refsets (role 'language': rows on items,
//                    target = acceptability), all others (rows on concepts or on descriptions,
//                    columns effectiveTime, moduleId, then the refset's own; the first component
//                    column is the target). Active rows only.
//   identifier       alternate identifiers (scheme = an identifier catalog row)
//   catalog          is-a (subsumption), attributes (refinable, wildcard), moduleId /
//                    definitionStatusId / effectiveTime (filterable, not refinable: named as ECL's
//                    concept filters name them), `child` (inverse_of is-a), one record row per
//                    refset, one identifier row per scheme
//   code_system      compositional = 1 (post-coordinated expressions are codes too, so an
//                    expansion is never closed)
//   behaviour        grammar 'snomed', expansionOrder 'stored-self-first', lookupSkipsMixedLinks
//   meta             edition, displayContexts ({relations: the display refsets, ordered, preferred:
//                    the acceptability that ranks, use: synonym}), moduleDependencies,
//                    derived-by-importer: normal forms (ix_key 'normalForm') and the walk (ix_order
//                    'walk', reached in meta 'ix.ix_order.walk.reached'), written after the build;
//                    then the file is vacuumed.

const path = require('path');
const Database = require('better-sqlite3');
const { TerminologyBuilder, vacuumFile, analyze } = require('./sqlite-v2/builder');

const MODULE_DEPENDENCY = '900000000000534007';
const { firstLine, walk } = require('./sqlite-v2/text');

const SCT = 'http://snomed.info/sct';
const IS_A = '116680003';
const FSN = '900000000000003001';
const SYNONYM = '900000000000013009';
const DEFINITION = '900000000000550004';
const PREFERRED = '900000000000548007';
const US_ENGLISH = '900000000000509007';
const GB_ENGLISH = '900000000000508004';
// The edition's display language reference sets, in the order they are tried: main's table
// (tx/cs/cs-snomed.js SnomedServices._displayRefsetOrder), and its default for any other edition.
// Those the edition doesn't have are left out
const DISPLAY_REFSETS = {
  '900000000000207008': [US_ENGLISH], // International
  '31000003106': [US_ENGLISH], // tx-ecosystem test edition
  '731000124108': [US_ENGLISH], // US
  '5991000124107': [US_ENGLISH], // US (with ICD-10-CM maps)
  '83821000000107': [GB_ENGLISH], // UK
  '999000021000000109': [GB_ENGLISH], // UK Clinical
  '32506021000036107': ['32570271000036106', GB_ENGLISH, US_ENGLISH], // Australian
  '20621000087109': ['19491000087109', US_ENGLISH, GB_ENGLISH], // Canadian (English)
  '21000210109': ['271000210107', GB_ENGLISH, US_ENGLISH], // New Zealand
  '11000220105': ['21000220103', GB_ENGLISH, US_ENGLISH] // Irish
};
const displayRefsetsFor = (edition) => DISPLAY_REFSETS[edition] || [US_ENGLISH, GB_ENGLISH];
const INFERRED = '900000000000011006';
const EDITION_NAMES = {
  '900000000000207008': 'SNOMED CT International Edition',
  '731000124108': 'SNOMED CT US Edition',
};

// The edition's language, as main's importer has it (tx/importers/import-sct.module.js, its
// editions table): the language a text or display filter with no request language searches
const EDITION_LANGUAGES = {
  '900000000000207008': 'en-US', '731000124108': 'en-US', '32506021000036107': 'en-AU', '449081005': 'es',
  '11000279109': 'cs-CZ', '554471000005108': 'da-DK', '11000146104': 'nl-NL', '45991000052106': 'sv-SE',
  '83821000000107': 'en-GB', '11000172109': 'fr-BE', '11000221109': 'es-AR', '11000234105': 'de-AT',
  '20621000087109': 'en-CA', '20611000087101': 'fr-CA', '11000181102': 'et-EE', '11000229106': 'fi-FI',
  '11000274103': 'de-DE', '1121000189102': 'en-IN', '11000220105': 'en-IE', '21000210109': 'en-NZ',
  '51000202101': 'no-NO', '11000267109': 'ko-KR', '900000001000122104': 'es-ES', '2011000195101': 'de-CH',
  '999000021000000109': 'en-GB', '5631000179106': 'es-UY', '21000325107': 'es-CL', '5991000124107': 'en-US',
};

/**
 * The edition's default description language, as main's importer records it (defaultLanguageByte):
 * cfg.language (--language), else the edition's language, if the edition has active descriptions
 * in it; else English. A primary subtag, or null for English (the file keeps en-US then).
 */
function rf2DefaultLanguage(cfg, activeLanguages) {
  const { languageByte, languageCode } = require('../sct/languages');
  const b = languageByte(cfg.language || EDITION_LANGUAGES[cfg.edition] || 'en-US');
  const code = b ? languageCode(b) : null;
  return code && code !== 'en' && activeLanguages.has(code) ? code : null;
}

const H = {
  concept: 'id\teffectiveTime\tactive\tmoduleId\tdefinitionStatusId',
  description: 'id\teffectiveTime\tactive\tmoduleId\tconceptId\tlanguageCode\ttypeId\tterm\tcaseSignificanceId',
  relationship: 'id\teffectiveTime\tactive\tmoduleId\tsourceId\tdestinationId\trelationshipGroup\ttypeId\tcharacteristicTypeId\tmodifierId',
  concrete: 'id\teffectiveTime\tactive\tmoduleId\tsourceId\tvalue\trelationshipGroup\ttypeId\tcharacteristicTypeId\tmodifierId',
  identifier: 'alternateIdentifier\teffectiveTime\tactive\tmoduleId\tidentifierSchemeId\treferencedComponentId',
  language: 'id\teffectiveTime\tactive\tmoduleId\trefsetId\treferencedComponentId\tacceptabilityId',
  refset: 'id\teffectiveTime\tactive\tmoduleId\trefsetId\treferencedComponentId',
};

function discover(root) {
  const f = { concept: null, description: [], relationship: null, concrete: null, identifier: [], language: [], refset: [] };
  for (const p of walk(root)) {
    if (!p.endsWith('.txt') || !/snapshot/i.test(p)) continue;
    const name = path.basename(p);
    const h = firstLine(p);
    if (h.startsWith(H.concept)) f.concept = p;
    else if (h.startsWith(H.description)) f.description.push(p);
    else if (h.startsWith(H.relationship)) { if (!/StatedRelationship/i.test(name)) f.relationship = p; }
    else if (h.startsWith(H.concrete)) f.concrete = p;
    else if (h.startsWith(H.identifier)) f.identifier.push(p);
    else if (h.startsWith(H.language) && /Language/i.test(name)) f.language.push(p);
    else if (h.startsWith(H.refset) && /^der2_/.test(name) && p.includes('/Refset/')) f.refset.push(p);
  }
  if (!f.concept || !f.description.length || !f.relationship) throw new Error(`${root}: not an RF2 Snapshot (concept/description/relationship missing)`);
  return f;
}

const isoDate = (t) => (/^\d{8}$/.test(t) ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}` : t);
// SCTIDs compare numerically: shorter is smaller, then lexically.
const idLess = (a, b) => (a.length !== b.length ? a.length < b.length : a < b);

function concrete(raw) {
  if (raw.startsWith('#')) return { fhirType: 'decimal', value: raw.slice(1) };
  if (raw === 'true' || raw === 'false') return { fhirType: 'boolean', value: raw };
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) return { fhirType: 'string', value: raw.slice(1, -1) };
  return { fhirType: 'string', value: raw };
}


const DERIVED = [{ table: 'ix_key', name: 'normalForm' }, { table: 'ix_order', name: 'walk' }];

class SnomedSink {
  /**
   * @param {object} cfg { dest, overwrite, log, importer, codeSystem: {uri, version, name, title,
   *   description, releaseDate, defaultLanguage}, edition, displayRefsets: [codes, in order],
   *   preferredRefset: code (item.preferred), normalForms (default true) }
   */
  constructor(cfg) {
    this.cfg = cfg;
    this.log = cfg.log || (() => {});
    const b = this.b = new TerminologyBuilder(cfg.dest, { overwrite: cfg.overwrite, log: this.log, importer: cfg.importer });
    b.codeSystem({ caseSensitive: true, hierarchyMeaning: 'is-a', compositional: true, ...cfg.codeSystem });
    b.setMeta('edition', cfg.edition);
    // how cs-snomed.js presents it: SNOMED CT expressions and ECL; results by concept id, an is-a
    // filter's concept first; $lookup reads no link of a concrete-value attribute
    b.setBehaviour('grammar', 'snomed');
    b.setBehaviour('expansionOrder', 'stored-self-first');
    b.setBehaviour('lookupSkipsMixedLinks', true);
    b.setMeta('derived-by-importer', DERIVED);
    this.stats = { languageRows: 0, languageRowsSkipped: 0, descriptions: 0, relationships: 0, relationshipsSkipped: 0,
      concreteTypeLinks: 0, concreteValues: 0, identifiers: 0, refsetRows: 0, refsetRowsOnDescriptions: 0,
      refsetRowsUnknown: 0, refsetTargetsNotNodes: 0, moduleDependencies: 0 };
    // the catalog rows every SNOMED file has (is-a may be named in a refinement; `* = x` is over
    // the attributes, not the hierarchy). moduleId, definitionStatusId and effectiveTime are named
    // as ECL's concept filters ({{ C moduleId = ... }}) and the FHIR filter moduleId name them
    this.isA = b.property({ code: IS_A, uri: `${SCT}/${IS_A}`, shape: 'link', subsumption: true, refinable: true, wildcard: false });
    this.module = b.property({ code: 'moduleId', shape: 'link', display: 'Module', refinable: false, wildcard: false });
    this.defStatus = b.property({ code: 'definitionStatusId', shape: 'link', display: 'Definition status', refinable: false, wildcard: false });
    this.effTime = b.property({ code: 'effectiveTime', shape: 'literal', fhirType: 'dateTime', display: 'Effective time', refinable: false, wildcard: false });
    this.displayRefsets = cfg.displayRefsets;
    // language members, held until the descriptions: [key, refset handle, acceptability handle]
    this.lang = { key: [], refset: [], acc: [] };
    this.prefRank = new Map();     // description key -> best display-refset rank where Preferred
    this.anyPreferred = new Set(); // description keys Preferred in any language refset
    this.preferredKeys = new Set(); // description keys Preferred in cfg.preferredRefset
    this.descItem = new Map();     // description key -> item handle
    this.lastDefinition = new Map(); // concept handle -> its last active definition item (preferred)
    this.best = new Map();         // concept handle -> [tier, description id, term]
    this.relSeq = 0;
    this.concreteTypes = new Map();
    this.deferred = [];            // relationships typed by a concrete attribute, until its property exists
    this.relations = new Map();    // refset code -> {id, cols}
    this.schemes = new Map();
    this.moduleDependencies = [];
  }

  idx(code) { return this.b.idx(code); }

  concept(code, active) { return this.b.concept(code, { active }); }

  /** module / definition status handles (undefined: none), effectiveTime as YYYY-MM-DD */
  conceptMeta(i, module, defStatus, effectiveTime) {
    if (module !== undefined) this.b.link(i, this.module, module);
    if (defStatus !== undefined) this.b.link(i, this.defStatus, defStatus);
    if (effectiveTime) this.b.literal(i, this.effTime, effectiveTime);
  }

  /** an active language refset row; key: the parser's description key */
  languageMember(key, refsetCode, accCode) {
    const refset = this.b.idx(refsetCode), acc = this.b.idx(accCode);
    if (refset === undefined || acc === undefined) { this.stats.languageRowsSkipped++; return; }
    this.lang.key.push(key); this.lang.refset.push(refset); this.lang.acc.push(acc);
    if (accCode === PREFERRED) {
      this.anyPreferred.add(key);
      if (refsetCode === this.cfg.preferredRefset) this.preferredKeys.add(key);
      const k = this.displayRefsets.indexOf(refsetCode);
      if (k >= 0 && !(this.prefRank.get(key) <= k)) this.prefRank.set(key, k);
    }
  }

  /** { key, id (SCTID), concept (handle), language, type (code), term, active } */
  description(d) {
    const syn = d.type === SYNONYM;
    const def = d.type === DEFINITION;
    const h = this.b.item(d.concept, { kind: def ? 1 : 0, externalId: d.id, language: d.language,
      use: { system: SCT, code: d.type }, text: d.term, active: d.active, preferred: !def && this.preferredKeys.has(d.key) });
    if (h !== null) this.descItem.set(d.key, h);
    if (h !== null && def && d.active) this.lastDefinition.set(d.concept, h);
    this.stats.descriptions++;
    if (!d.active) return;
    const k = this.displayRefsets.length;
    if (syn && this.prefRank.has(d.key)) this._consider(d.concept, this.prefRank.get(d.key), d.id, d.term);
    else if (syn && this.anyPreferred.has(d.key)) this._consider(d.concept, k, d.id, d.term);
    else if (d.type === FSN) this._consider(d.concept, k + 1, d.id, d.term);
    else this._consider(d.concept, k + 2, d.id, d.term);
  }

  _consider(i, tier, id, term) {
    const cur = this.best.get(i);
    if (!cur || tier < cur[0] || (tier === cur[0] && idLess(id, cur[1]))) this.best.set(i, [tier, id, term]);
  }

  /** after the descriptions: displays (concepts and use codings) */
  descriptionsDone() {
    for (const [i, c] of this.best) this.b.setDisplay(i, c[2].trim());
    this.best.clear();
    for (const u of this.b.uses.values()) { const i = this.b.idx(u.code); if (i !== undefined) u.display = this.b.display[i]; }
    this.prefRank.clear(); this.anyPreferred.clear(); this.preferredKeys.clear();
  }

  /** the concrete-value attribute types and the literal type of each (type code -> fhirType) */
  setConcreteTypes(map) { this.concreteTypes = map; }

  _attr(type) {
    return this.b.property({ code: type, uri: `${SCT}/${type}`, shape: 'link', refinable: true, wildcard: true });
  }

  /** a relationship row (inferred); s, t: concept handles */
  relationship(s, t, type, group, active) {
    if (s === undefined || t === undefined) { this.stats.relationshipsSkipped++; return; }
    const seq = this.relSeq++;
    if (this.concreteTypes.has(type)) { this.deferred.push([s, t, type, group, active ? 1 : 0, seq]); return; }
    this.b.link(s, type === IS_A ? this.isA : this._attr(type), t, { group, active, seq });
    this.stats.relationships++;
  }

  _concreteProp(type, fhirType) {
    const known = this.b.propertyId(type);
    if (known !== undefined) return known;
    if (!this.deferredTypes) this.deferredTypes = new Set(this.deferred.map((r) => r[2]));
    const both = this.deferredTypes.has(type);
    return this.b.property({ code: type, uri: `${SCT}/${type}`, shape: both ? 'both' : 'literal', fhirType, refinable: true, wildcard: true });
  }

  /** an active inferred concrete value row; s: concept handle; raw: the RF2 value (#n, "s", true) */
  concreteValue(s, type, group, raw) {
    if (s === undefined) return;
    const v = concrete(raw);
    this.b.literal(s, this._concreteProp(type, v.fhirType), v.value, { group });
    this.stats.concreteValues++;
  }

  /** after the concrete values: the deferred links of concrete-typed relationships */
  concreteDone() {
    for (const [s, t, type, group, active, seq] of this.deferred) {
      const p = this._concreteProp(type, this.concreteTypes.get(type));
      this.b.link(s, p, t, { group, active: !!active, seq });
      this.stats.concreteTypeLinks++;
    }
    this.deferred.length = 0;
    // the inverse catalog row: child, the reverse of is-a
    // (not a filter name: cs-snomed.js takes no `child` filter; $lookup reports children itself)
    this.b.property({ code: 'child', shape: 'link', display: 'Child', inverseOf: this.isA, filterable: false, refinable: false, wildcard: false });
    // language refset rows, now that the descriptions are items
    const L = this.lang;
    for (let k = 0; k < L.key.length; k++) {
      const item = this.descItem.get(L.key[k]);
      if (item === undefined) { this.stats.languageRowsSkipped++; continue; }
      this.b.record(this._languageRelation(L.refset[k]), item, { target: L.acc[k] });
      this.stats.languageRows++;
    }
    this.lang = null;
  }

  _languageRelation(refset) {
    const code = this.b.codes[refset];
    let r = this.relations.get(code);
    if (!r) {
      r = { id: this.b.property({ code, uri: `${SCT}/${code}`, shape: 'record', role: 'language', concept: refset, refinable: false, wildcard: false,
        fields: [{ name: 'acceptabilityId', type: 'c', target: true }] }), cols: null };
      this.relations.set(code, r);
    }
    return r.id;
  }

  /** an active alternate identifier row */
  identifier(schemeCode, value, conceptCode) {
    const scheme = this.b.idx(schemeCode), c = this.b.idx(conceptCode);
    if (scheme === undefined || c === undefined) return;
    let p = this.schemes.get(schemeCode);
    if (p === undefined) {
      p = this.b.property({ code: schemeCode, uri: `${SCT}/${schemeCode}`, shape: 'identifier', concept: scheme, refinable: false, wildcard: false });
      this.schemes.set(schemeCode, p);
    }
    this.b.identifier(p, value, c);
    this.stats.identifiers++;
  }

  /**
   * An active refset row (not a language refset, not module dependency).
   * @param {string} refsetCode
   * @param {string} ref referencedComponentId: a concept code or a description key (see `onDescription`)
   * @param {{names: string[], types: string[]}} def the refset's own columns (c component, i int, s string)
   * @param {string[]|null} values their values, as RF2 text
   * @param {{time?: string, module?: string}} meta the row's effectiveTime (YYYYMMDD) and moduleId
   * @param {boolean} [onDescription] ref is a description key
   */
  refsetMember(refsetCode, ref, def, values, meta = {}, onDescription = false) {
    const refset = this.b.idx(refsetCode);
    if (refset === undefined) { this.stats.refsetRowsUnknown++; return; }
    let subject = onDescription ? undefined : this.b.idx(ref);
    if (subject === undefined) {
      subject = this.descItem.get(ref);
      if (subject === undefined) { this.stats.refsetRowsUnknown++; return; }
      this.stats.refsetRowsOnDescriptions++;
    }
    let r = this.relations.get(refsetCode);
    if (!r) {
      const own = (def.names || []).map((name, j) => ({ name, type: def.types[j] || 's' }));
      const first = own.findIndex((c) => c.type === 'c');
      if (first >= 0) own[first].target = true;
      const cols = [{ name: 'effectiveTime', type: 't' }, { name: 'moduleId', type: 'c' }, ...own];
      r = { id: this.b.property({ code: refsetCode, uri: `${SCT}/${refsetCode}`, shape: 'record', concept: refset, refinable: false, wildcard: false, fields: cols }), cols };
      this.relations.set(refsetCode, r);
    }
    const fields = [];
    let target = null, tail;
    const time = meta.time ? Number(meta.time) : null;
    const mod = meta.module != null && meta.module !== '' ? this.b.idx(meta.module) : undefined;
    fields.push(time, mod !== undefined ? mod : (meta.module || null));
    for (let j = 2; j < r.cols.length; j++) {
      const c = r.cols[j];
      const v = values ? values[j - 2] : undefined;
      let x;
      if (v == null) x = null;
      else if (c.type === 'c') {
        const h = v === '' ? undefined : (this.b.idx(v) ?? this.descItem.get(v));
        x = h !== undefined ? h : v;
      } else if (c.type === 'i') x = v === '' ? null : Number(v);
      else x = v;
      if (c.target) {
        if (typeof x === 'number') target = x;
        else { tail = x; this.stats.refsetTargetsNotNodes++; }
      } else fields.push(x);
    }
    if (target === null && r.cols.some((c) => c.target)) fields.push(tail ?? null);
    this.b.record(r.id, subject, { target, fields });
    this.stats.refsetRows++;
  }

  /** a module dependency row: [moduleId, referencedComponentId, sourceEffectiveTime, targetEffectiveTime] */
  moduleDependency(row) { this.moduleDependencies.push(row); this.stats.moduleDependencies++; }

  stage(name, fn) { return this.b.stage(name, fn); }

  /** build the file, then the derived-by-importer indexes (normal forms, the walk) */
  async finish(extra = {}) {
    const b = this.b;
    this.descItem.clear();
    for (const h of this.lastDefinition.values()) b.setItemPreferred(h, true);
    this.lastDefinition.clear();
    // the display refsets in order, the acceptability that ranks, the item use ranked (synonyms)
    b.setMeta('displayContexts', { relations: this.displayRefsets, preferred: PREFERRED, use: { system: SCT, code: SYNONYM } });
    if (this.moduleDependencies.length) b.setMeta('moduleDependencies', this.moduleDependencies);
    const summary = b.finish({ ...extra, ...this.stats }, { vacuum: false });
    const t0 = Date.now();
    const derived = derivedIndexes(this.cfg.dest, this.log, this.cfg.normalForms !== false);
    summary.derived = derived;
    summary.normalForms = derived.normalForms;
    summary.timings.derived = { s: (Date.now() - t0) / 1000, peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024) };
    const t1 = Date.now();
    vacuumFile(this.cfg.dest);
    summary.timings.vacuum = { s: (Date.now() - t1) / 1000 };
    summary.fileBytes = require('fs').statSync(this.cfg.dest).size;
    return summary;
  }
}

/**
 * The derived-by-importer indexes of a built SNOMED file: the walk (tx/sqlite-v2/orders.js
 * snomedWalk, over the is-a links) and the normal forms (sct-native.js buildNormalForms over the
 * file's store), into ix_order / ix_key. Rerunnable: replaces the rows of those names.
 */
function derivedIndexes(file, log = () => {}, normalForms = true) {
  const db = new Database(file);
  db.pragma('journal_mode = OFF');
  db.pragma('synchronous = OFF');
  const { writeOrderArray, writeActiveOrder } = require('./sqlite-v2/indexes');
  const out = {};
  try {
    const { computeOrder } = require('../sqlite-v2/orders');
    const n = db.prepare('SELECT concept_count FROM main.code_system WHERE served = 1').pluck().get();
    let t = Date.now();
    const walk = computeOrder(db, 'snomed', n).walk;
    db.exec('BEGIN');
    db.prepare("DELETE FROM main.ix_order WHERE name = 'walk'").run();
    out.walk = { rows: writeOrderArray(db, 'walk', walk), reached: walk.reached, seconds: (Date.now() - t) / 1000 };
    out.activeOrderRows = writeActiveOrder(db);
    db.exec('COMMIT');
    log(`  walk: ${walk.reached.toLocaleString()} reached, ${out.walk.seconds.toFixed(1)} s`);
    if (normalForms) {
      t = Date.now();
      const { Store } = require('../sqlite-v2/store');
      const { buildNormalForms } = require('../sqlite-v2/sct-native');
      const store = new Store(file, { db, unregistered: true });
      db.prepare("DELETE FROM main.ix_key WHERE name = 'normalForm'").run();
      const ins = db.prepare("INSERT OR REPLACE INTO main.ix_key VALUES ('normalForm', ?, ?)");
      const r = buildNormalForms(store, db, log, { write: (id, nf) => ins.run(nf, id) });
      out.normalForms = { ...r, seconds: (Date.now() - t) / 1000 };
      db.prepare("INSERT OR REPLACE INTO main.meta VALUES ('ix.ix_key.normalForm.stats', ?)").run(JSON.stringify(out.normalForms));
      log(`normal forms: ${r.written.toLocaleString()} stored (${r.failed} could not be built), ${out.normalForms.seconds.toFixed(1)} s`);
    }
    analyze(db, 'main.ix_key'); analyze(db, 'main.ix_order');
    db.pragma('journal_mode = DELETE');
  } finally {
    db.close();
  }
  return out;
}

module.exports = { SnomedSink, derivedIndexes, discover, isoDate, idLess, concrete, displayRefsetsFor, rf2DefaultLanguage,
  DISPLAY_REFSETS, EDITION_NAMES, EDITION_LANGUAGES, MODULE_DEPENDENCY, SCT, IS_A, PREFERRED, US_ENGLISH, INFERRED };
