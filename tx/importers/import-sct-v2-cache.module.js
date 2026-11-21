'use strict';

// FHIRsmith SNOMED CT cache (*.cache, tx/sct/structures.js) -> sqlite-v2 ("reverse loader").
//
// For the editions we can only get as tx.fhir.org's binary caches (the public tx-fhir-org bucket).
// Source-specific decoding only; numbering, sets, indexes and provenance are the shared final stage
// (V2Builder.finish), and the facts are the ones import-sct-v2.module.js reads from RF2:
//   concepts        active (status nibble), module, definition status (primitive flag), effectiveTime
//   descriptions    every description record (incl. text definitions), active and inactive:
//                   designations, language from the cache's language byte
//   display         preferred synonym in the edition's display refsets (main's table, cs-snomed.js
//                   _displayRefsetOrder), else preferred in any language refset, else FSN, else the
//                   first active description (description-id order) - the rule of the RF2 importer
//   relationships   every relationship record, active and inactive (the cache importer reads the same
//                   non-stated sct2_Relationship rows as the RF2 importer), in record order (link_order)
//   concrete values cache v19 only (active inferred rows)
//   identifiers     cache v18+ only (active rows)
//   language refsets (members referencing descriptions, refset under 900000000000506000) ->
//                   designation_acceptability
//   other refsets   members referencing concepts -> membership + refset_member rows for refsets with
//                   extra columns. Members referencing descriptions in other refsets are counted, skipped
//                   (as the RF2 importer does).
// What the cache does not carry (inactive refset members, map refsets, concrete values before v19,
// ...) is not in the file either.

const path = require('path');
const { BaseTerminologyModule } = require('./tx-import-base');
const { V2Builder } = require('./sqlite-v2/builder');
const {
  SnomedStrings, SnomedReferences, SnomedDescriptions, SnomedConceptList, SnomedRelationshipList,
  SnomedReferenceSetMembers, SnomedReferenceSetIndex, SnomedFileReader, SNOMED_CACHE_VERSION,
} = require('../sct/structures');
// main's display refset order per edition (tx/cs/cs-snomed.js _displayRefsetOrder)
const { applySnomedConfig, storeNormalForms, concrete, isoDate, idLess, displayRefsetsFor, DISPLAY_REFSETS } = require('./import-sct-v2.module');
const { editionName } = require('../sct/editions');

const SCT = 'http://snomed.info/sct';
const IS_A = '116680003';
const FSN = '900000000000003001';
const SYNONYM = '900000000000013009';
const DEFINITION = '900000000000550004';
const PREFERRED = '900000000000548007';
const LANGUAGE_TYPE_REFSET = '900000000000506000';
const PRIMITIVE = '900000000000074008';
const DEFINED = '900000000000073002';
// the cache's language byte -> ISO 639-1 code: main's one table (tx/sct/languages.js; before cache
// format 20 only 1-9 were written, anything else as 1)
const { LANGUAGE_CODES: LANGUAGE } = require('../sct/languages');
const DAY = 86400000;
const PASCAL_EPOCH = Date.UTC(1899, 11, 30);

function view(Cls, buf, ...args) {
  const o = new Cls(null, ...args);
  o.master = buf; // a view on the file buffer: no copy
  return o;
}

/**
 * The cache's default description language (a language byte). The current format (21): as main's
 * server resolves its slot. An older format (main's server no longer reads them, but this importer
 * does): as main's server read it, up to 1.0.4 - a language byte (only 1-9 before format 20), else
 * the membersByRef offset of the edition's default language reference set (the original server's
 * caches), read as the language most of that reference set's descriptions are in; else English.
 */
function cacheDefaultLanguage(d) {
  if (d.cacheVersion === SNOMED_CACHE_VERSION) {
    const { SnomedServices } = require('../cs/cs-snomed');
    return new SnomedServices(d).defaultLanguage;
  }
  const slot = d.defaultLanguage;
  const maxByte = parseInt(d.cacheVersion, 10) >= 20 ? 255 : 9;
  if (slot <= maxByte && LANGUAGE[slot]) return slot;
  const rsIndex = view(SnomedReferenceSetIndex, d.refSetIndex, d.hasLangs);
  const rsMembers = view(SnomedReferenceSetMembers, d.refSetMembers);
  const descs = view(SnomedDescriptions, d.desc);
  for (let i = 0; i < rsIndex.count(); i++) {
    if (rsIndex.getReferenceSet(i).membersByRef !== slot) continue;
    let best = 1, most = 0;
    for (const [lang, n] of rsMembers.descriptionLanguages(slot, descs)) {
      if (LANGUAGE[lang] && n > most) { best = lang; most = n; }
    }
    return best;
  }
  return 1;
}

// The cache formats before 21 this importer still reads. Main's server reads only the current
// format (1.0.5); an edition whose release is not at hand may only exist as an older cache.
const OLDER_FORMATS = ['16', '17', '18', '19', '20'];

/**
 * A cache's sections, as SnomedFileReader.loadSnomedData returns them: from main's reader for the
 * current format; for an older one, read here in its layout (the words and stems sections, which
 * nothing read, are skipped; no license, no text indexes).
 * @param {string} file
 */
async function readCache(file) {
  if (SnomedFileReader.isCurrent(file)) return new SnomedFileReader(file).loadSnomedData();
  const r = new SnomedFileReader(file);
  await r.load();
  const cacheVersion = r.readString();
  if (!OLDER_FORMATS.includes(cacheVersion)) {
    throw new Error(`${path.basename(file)}: SNOMED CT cache format ${cacheVersion} is not one this importer reads (${[...OLDER_FORMATS, SNOMED_CACHE_VERSION].join(', ')})`);
  }
  const v = parseInt(cacheVersion, 10);
  const d = { cacheVersion, versionUri: r.readString(), versionDate: r.readString(), hasLangs: v >= 17, license: null, textIndexes: null };
  d.isTesting = d.versionUri.includes('/xsct/');
  const parts = d.versionUri.split('/');
  if (parts.length >= 7) { d.edition = parts[4]; d.version = parts[6]; }
  d.strings = r.readBytes();
  d.refs = r.readBytes();
  d.desc = r.readBytes();
  r.readBytes(); // words
  r.readBytes(); // stems
  d.concept = r.readBytes();
  d.rel = r.readBytes();
  d.refSetIndex = r.readBytes();
  d.refSetMembers = r.readBytes();
  d.descRef = r.readBytes();
  d.isAIndex = r.readInteger();
  d.inactiveRoots = [];
  for (let i = r.readInteger(); i > 0; i--) d.inactiveRoots.push(r.readUInt64());
  d.activeRoots = [];
  for (let i = r.readInteger(); i > 0; i--) d.activeRoots.push(r.readUInt64());
  d.defaultLanguage = r.readInteger();
  d.identifiers = v >= 18 ? JSON.parse(r.readBytes().toString('utf8')) : [];
  d.concreteValues = v >= 19 ? JSON.parse(r.readBytes().toString('utf8')) : null;
  return d;
}

/** days since 1899-12-30 -> YYYYMMDD */
function sctDate(days) {
  if (!days) return null;
  return new Date(PASCAL_EPOCH + days * DAY).toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * @param {object} cfg { source (.cache), dest, overwrite, dateShift ('auto' | integer days), log }
 */
async function importSnomedV2FromCache(cfg) {
  const log = cfg.log || console.log;
  const t0 = Date.now();
  const d = await readCache(cfg.source);
  log(`cache v${d.cacheVersion} ${d.versionUri} loaded in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

  const strings = view(SnomedStrings, d.strings);
  const refs = view(SnomedReferences, d.refs);
  const descs = view(SnomedDescriptions, d.desc);
  const concepts = view(SnomedConceptList, d.concept);
  const rels = view(SnomedRelationshipList, d.rel);
  const rsIndex = view(SnomedReferenceSetIndex, d.refSetIndex, d.hasLangs);
  const rsMembers = view(SnomedReferenceSetMembers, d.refSetMembers);
  const C = SnomedConceptList.CONCEPT_SIZE, D = SnomedDescriptions.DESC_SIZE, R = SnomedRelationshipList.RELATIONSHIP_SIZE;
  const nC = concepts.count(), nD = descs.count(), nR = rels.count();
  const cbuf = concepts.master, dbuf = descs.master, rbuf = rels.master;
  const getRefs = (i) => (i ? refs.getReferences(i) : null) || [];

  const m = /^http:\/\/snomed\.info\/x?sct\/(\d+)\/version\/(\d{8})$/.exec(d.versionUri);
  if (!m) throw new Error(`unexpected version URI ${d.versionUri}`);
  const [, edition, version] = m;

  // concept offset -> code (the builder index is the concept ordinal: concepts are added in cache order)
  const code = new Array(nC);
  for (let k = 0; k < nC; k++) code[k] = cbuf.readBigUInt64LE(k * C).toString();
  const ord = (offset) => {
    if (offset % C !== 0 || offset >= cbuf.length) throw new Error(`bad concept offset ${offset}`);
    return offset / C;
  };
  const ordOf = new Map();
  for (let k = 0; k < nC; k++) ordOf.set(code[k], k);
  const known = (c) => ordOf.get(c);

  // Cache dates: caches built in a time zone ahead of UTC before upstream b082f98 store every date one
  // day early. 'auto' shifts by +1 day when no concept carries the release date but some carry the day
  // before it.
  let shift = 0;
  {
    const rel = Math.round((Date.UTC(+version.slice(0, 4), +version.slice(4, 6) - 1, +version.slice(6, 8)) - PASCAL_EPOCH) / DAY);
    let onRelease = 0, dayBefore = 0;
    for (let k = 0; k < nC; k++) {
      const t = cbuf.readUInt16LE(k * C + 34);
      if (t === rel) onRelease++; else if (t === rel - 1) dayBefore++;
    }
    if (cfg.dateShift === undefined || cfg.dateShift === 'auto') shift = onRelease === 0 && dayBefore > 0 ? 1 : 0;
    else shift = Number(cfg.dateShift) || 0;
    log(`dates: ${onRelease} concepts on the release date, ${dayBefore} the day before -> shift ${shift} day(s)`);
  }
  const date = (days) => (days ? sctDate(days + shift) : null);

  // Known defects of some cache vintages.
  const quality = inspect();
  for (const w of quality.warnings) log(`WARNING: ${w}`);
  if (cfg.inspectOnly) return { inspectOnly: true, cacheVersion: d.cacheVersion, versionUri: d.versionUri, shift, ...quality };
  if (quality.fatal.length && !cfg.force) {
    throw new Error(`${path.basename(cfg.source)}: defective cache (${quality.fatal.join('; ')}); use --force to import anyway`);
  }

  function inspect() {
    const warnings = [], fatal = [];
    let noModule = 0, primitive = 0;
    for (let k = 0; k < nC; k++) {
      if (!cbuf.readUInt32LE(k * C + 36)) noModule++;
      if (cbuf.readUInt8(k * C + 8) & SnomedConceptList.MASK_CONCEPT_PRIMITIVE) primitive++;
    }
    const counts = { concepts: nC, descriptions: nD, relationships: nR, noModule, primitive,
      refsets: rsIndex.count(), concreteValues: (d.concreteValues || []).length, identifiers: (d.identifiers || []).length };
    if (noModule > nC / 100) fatal.push(`${noModule} of ${nC} concepts have no module`);
    if (primitive === 0) fatal.push('no concept is primitive (definition status lost)');
    const defs = new Map(), members = new Map();
    for (let k = 0; k < rsIndex.count(); k++) {
      const e = rsIndex.getReferenceSet(k);
      defs.set(e.definition, (defs.get(e.definition) || 0) + 1);
      members.set(e.definition, (members.get(e.definition) || 0) + rsMembers.getMemberCount(e.membersByRef));
    }
    const dup = [...defs].filter(([, n]) => n > 1);
    if (dup.length) fatal.push(`refset index names ${dup.map(([o, n]) => `${code[o / C]} x${n}`).join(', ')} (refsets collapsed onto one concept)`);
    counts.refsetMembers = [...members.values()].reduce((a, b) => a + b, 0);
    for (const r of displayRefsetsFor(edition)) {
      if (known(r) === undefined) continue;
      const n = members.get(known(r) * C) || 0;
      if (n === 0 && (DISPLAY_REFSETS[edition] || []).includes(r)) fatal.push(`display language refset ${r} has no members`);
      else if (n > 0 && n < nC / 10) warnings.push(`display language refset ${r} has only ${n} members (displays fall back to the FSN)`);
    }
    if (shift) warnings.push(`dates shifted by ${shift} day(s) (cache built east of UTC before upstream b082f98)`);
    if (!counts.concreteValues) warnings.push(`no concrete values (cache v${d.cacheVersion}; carried from v19)`);
    warnings.push(...fatal);
    return { counts, warnings, fatal };
  }

  const b = new V2Builder(cfg.dest, { overwrite: cfg.overwrite, log, importer: 'sct-v2-from-cache' });
  b.addSource(cfg.source);
  const name = (editionName(edition) ? `SNOMED CT ${editionName(edition)}` : `SNOMED CT edition ${edition}`);
  b.setCodeSystem({
    uri: SCT, version: d.versionUri, name, title: name, edition, releaseDate: isoDate(version),
    description: `SNOMED CT edition ${edition} version ${version}, from FHIRsmith cache v${d.cacheVersion} (${path.basename(cfg.source)})`,
  });
  const stats = {
    cacheVersion: d.cacheVersion, dateShiftDays: shift, cacheWarnings: quality.warnings, cacheCounts: quality.counts, descriptionRefsetRowsSkipped: 0, refsetsWithoutConcept: 0,
    otherRefsetRowsSkipped: 0, unknownFieldValues: 0, languageRefsets: [], concreteValues: 0, identifiers: 0,
    conceptsWithoutModule: 0,
  };

  const isA = b.property({ code: IS_A, uri: `${SCT}/${IS_A}`, fhirType: 'code', valueKind: 'concept', isHierarchy: true });
  const moduleProp = b.property({ code: 'module', fhirType: 'code', valueKind: 'concept', display: 'Module' });
  const defStatus = b.property({ code: 'definitionStatusId', fhirType: 'code', valueKind: 'concept', display: 'Definition status' });
  const effTime = b.property({ code: 'effectiveTime', fhirType: 'dateTime', valueKind: 'literal', display: 'Effective time' });

  await b.stage('decode concepts', async () => {
    for (let k = 0; k < nC; k++) {
      const flags = cbuf.readUInt8(k * C + 8);
      const i = b.concept(code[k], { active: (flags & SnomedConceptList.MASK_CONCEPT_STATUS) === 0 });
      if (i !== k) throw new Error(`duplicate concept ${code[k]} in cache`);
    }
    const prim = known(PRIMITIVE), defd = known(DEFINED);
    for (let k = 0; k < nC; k++) {
      const o = k * C;
      const mod = cbuf.readUInt32LE(o + 36);
      // module 0 means "not set" except for the concept at offset 0 (never a module concept in practice)
      if (mod) b.link(k, moduleProp, ord(mod)); else stats.conceptsWithoutModule++;
      const ds = (cbuf.readUInt8(o + 8) & SnomedConceptList.MASK_CONCEPT_PRIMITIVE) ? prim : defd;
      if (ds !== undefined) b.link(k, defStatus, ds);
      const t = date(cbuf.readUInt16LE(o + 34));
      if (t) b.literal(k, effTime, isoDate(t));
    }
    return nC;
  });

  // Is r a language refset? (descends from 900000000000506000 |Language type reference set|)
  const langRoot = known(LANGUAGE_TYPE_REFSET);
  const isLanguageRefset = (k) => {
    const seen = new Set();
    const stack = [k];
    while (stack.length) {
      const x = stack.pop();
      if (x === langRoot) return true;
      if (seen.has(x)) continue;
      seen.add(x);
      for (const p of getRefs(cbuf.readUInt32LE(x * C + 9))) stack.push(ord(p));
    }
    return false;
  };

  // Refset index -> language refsets (acceptability per description ordinal) and the rest.
  const displayRefsets = displayRefsetsFor(edition).filter((c) => known(c) !== undefined);
  const displayRank = new Map(displayRefsets.map((c, r) => [known(c), r]));
  const prefIdx = known(PREFERRED);
  const prefRank = new Int8Array(nD).fill(127); // best display-refset rank where the description is Preferred
  const anyPref = new Uint8Array(nD);
  const accD = [], accR = [], accV = [];
  const refsets = [];
  for (let k = 0; k < rsIndex.count(); k++) {
    const e = rsIndex.getReferenceSet(k);
    refsets.push(e);
  }

  // decode a member's extra field values to RF2 strings
  const fieldValues = (valuesRef) => {
    const v = getRefs(valuesRef);
    const out = [];
    for (let j = 0; j + 1 < v.length; j += 2) {
      const val = v[j], type = v[j + 1];
      switch (type) {
        // the cache importer writes 0 (the first concept) for a component it could not find
        case 1: out.push(val > 0 && val % C === 0 && val < cbuf.length ? code[val / C] : (stats.unknownFieldValues++, '')); break;
        case 2: out.push(dbuf.readBigUInt64LE(val + 5).toString()); break;
        case 4: out.push(String(val | 0)); break;
        case 5: out.push(strings.getEntry(val)); break;
        default: stats.unknownFieldValues++; out.push('');
      }
    }
    return out;
  };

  await b.stage('decode language refsets', async () => {
    let n = 0;
    for (const e of refsets) {
      const r = e.definition / C;
      const members = rsMembers.getMembers(e.membersByRef) || [];
      if (!members.some((x) => x.kind === 1) || !isLanguageRefset(r)) continue;
      stats.languageRefsets.push(code[r]);
      const rank = displayRank.has(r) ? displayRank.get(r) : 127;
      for (const x of members) {
        if (x.kind !== 1) continue;
        const acc = getRefs(x.values);
        if (acc.length < 2 || acc[1] !== 1) continue;
        const di = x.ref / D;
        const a = acc[0] / C;
        accD.push(di); accR.push(r); accV.push(a);
        if (a === prefIdx) { anyPref[di] = 1; if (rank < prefRank[di]) prefRank[di] = rank; }
        n++;
      }
    }
    return n;
  });

  const best = new Map();
  const consider = (i, tier, id, term) => {
    const cur = best.get(i);
    if (!cur || tier < cur[0] || (tier === cur[0] && idLess(id, cur[1]))) best.set(i, [tier, id, term]);
  };
  const stageId = new Int32Array(nD).fill(-1);
  const synIdx = known(SYNONYM), fsnIdx = known(FSN), defIdx = known(DEFINITION);
  await b.stage('decode descriptions', async () => {
    let n = 0;
    for (let k = 0; k < nD; k++) {
      const o = k * D;
      const term = strings.getEntry(dbuf.readUInt32LE(o));
      const active = dbuf.readUInt8(o + 4) !== 0;
      const id = dbuf.readBigUInt64LE(o + 5).toString();
      const i = ord(dbuf.readUInt32LE(o + 13));
      const type = ord(dbuf.readUInt32LE(o + 21));
      const lang = LANGUAGE[dbuf.readUInt8(o + 31)] || 'en';
      const s = b.designation(i, { language: lang, use: { system: SCT, code: code[type] }, term, active,
        preferred: prefRank[k] === 0 });
      if (s !== null) stageId[k] = s;
      n++;
      if (!active) continue;
      const syn = type === synIdx;
      if (syn && prefRank[k] < 127) consider(i, prefRank[k], id, term);
      else if (syn && anyPref[k]) consider(i, 100, id, term);
      else if (type === fsnIdx) consider(i, 101, id, term);
      else consider(i, 102, id, term);
      if (type === defIdx) b.setDefinition(i, term);
    }
    for (const [i, c] of best) b.setDisplay(i, c[2].trim());
    return n;
  });
  await b.stage('stage acceptability', async () => {
    let n = 0;
    for (let k = 0; k < accD.length; k++) {
      const s = stageId[accD[k]];
      if (s >= 0) { b.acceptability(s, accR[k], accV[k]); n++; }
    }
    return n;
  });
  best.clear(); accD.length = accR.length = accV.length = 0;
  for (const u of b.uses.values()) { const i = b.idx(u.code); if (i !== undefined) u.display = b.display[i]; }

  await b.stage('decode relationships', async () => {
    const props = new Map();
    for (let k = 0; k < nR; k++) {
      const o = k * R;
      const s = ord(rbuf.readUInt32LE(o)), t = ord(rbuf.readUInt32LE(o + 4)), ty = ord(rbuf.readUInt32LE(o + 8));
      let p = props.get(ty);
      if (p === undefined) {
        const tc = code[ty];
        p = tc === IS_A ? isA : b.property({ code: tc, uri: `${SCT}/${tc}`, fhirType: 'code', valueKind: 'concept' });
        props.set(ty, p);
      }
      // seq: the record's place in the cache, the order cs-snomed.js lists parents, children and
      // relationships in (each concept's inbound and outbound lists are in record order)
      b.link(s, p, t, { group: rbuf.readInt32LE(o + 28) || 0, active: rbuf.readUInt8(o + 26) !== 0, seq: k });
    }
    return nR;
  });

  if (d.concreteValues && d.concreteValues.length) {
    await b.stage('decode concrete values', async () => {
      for (const [src, type, group, raw] of d.concreteValues) {
        const s = known(String(src));
        if (s === undefined) continue;
        const v = concrete(String(raw));
        const p = b.property({ code: String(type), uri: `${SCT}/${type}`, fhirType: v.fhirType, valueKind: 'literal' });
        b.literal(s, p, v.value, { group: Number(group) || 0 });
        stats.concreteValues++;
      }
      return stats.concreteValues;
    });
  }

  if (d.identifiers && d.identifiers.length) {
    await b.stage('decode identifiers', async () => {
      for (const [scheme, , id, concept] of d.identifiers) {
        const s = known(String(scheme)), c = known(String(concept));
        if (s === undefined || c === undefined) continue;
        b.alternateIdentifier(c, s, String(id));
        stats.identifiers++;
      }
      return stats.identifiers;
    });
  }

  await b.stage('decode refsets', async () => {
    let n = 0;
    const langs = new Set(stats.languageRefsets);
    const moduleDependencies = [];
    for (const e of refsets) {
      const r = e.definition / C;
      let rname = '';
      try { rname = strings.getEntry(e.name) || ''; } catch (err) { rname = ''; }
      if (code[r] === '900000000000534007' || rname.startsWith('ModuleDependency')) {
        // module dependencies go to cs_config, with each row's own module (as the RF2 importer does)
        for (const x of rsMembers.getMembers(e.membersByRef) || []) {
          if (x.kind !== 0 || x.module == null) continue;
          const f = fieldValues(x.values);
          moduleDependencies.push([code[ord(x.module)], code[ord(x.ref)], f[0] || null, f[1] || null]);
          n++;
        }
        continue;
      }
      if (langs.has(code[r])) continue;
      // a refset whose concept is not in the edition is written against offset 0 (the first concept)
      if (r === 0) { stats.refsetsWithoutConcept++; continue; }
      const types = getRefs(e.fieldTypes).map((t) => String.fromCharCode(t));
      const names = getRefs(e.fieldNames).map((s) => strings.getEntry(s));
      const hasFields = types.length > 0;
      for (const x of rsMembers.getMembers(e.membersByRef) || []) {
        if (x.kind !== 0) { if (x.kind === 1) stats.descriptionRefsetRowsSkipped++; else stats.otherRefsetRowsSkipped++; continue; }
        if (hasFields) b.refsetDef(r, names.length === types.length ? names : types.map((t, j) => `field${j + 1}`), types);
        // the row's effectiveTime and module, when the cache kept them (refsets stored with ids)
        const meta = x.module != null || x.date != null ? { time: x.date != null ? date(x.date) : null, module: x.module != null ? ord(x.module) : null } : null;
        b.refsetMember(r, ord(x.ref), hasFields ? fieldValues(x.values) : null, meta);
        n++;
      }
    }
    if (moduleDependencies.length) b.setConfig('moduleDependencies', moduleDependencies);
    return n;
  });

  applySnomedConfig(b, displayRefsets);
  b.setConfig('sourceFormat', `fhirsmith-cache-v${d.cacheVersion}`);
  // The language a text or display filter with no request language searches: the cache's
  // default-language slot, read as main's server reads it (cs-snomed.js SnomedServices: the
  // language byte the importer wrote, or the language of most of the descriptions in the
  // reference set whose offset the original server wrote, else English). Kept as en-US for
  // English, as for an RF2 import.
  const defByte = cacheDefaultLanguage(d);
  if (defByte !== 1 && LANGUAGE[defByte]) b.setConfig('defaultLanguage', LANGUAGE[defByte]);
  log(`default language: slot ${d.defaultLanguage} -> ${LANGUAGE[defByte] || 'en'}`);
  const summary = await b.finish(stats);
  if (cfg.normalForms !== false && !cfg.inspectOnly) storeNormalForms(cfg.dest, summary, cfg.log || (() => {}));
  return summary;
}

class SnomedV2FromCacheModule extends BaseTerminologyModule {
  getName() { return 'snomed-v2-from-cache'; }
  getDescription() { return 'FHIRsmith SNOMED CT .cache -> SQLite (sqlite-v2 schema), for editions without RF2'; }
  getSupportedFormats() { return ['file']; }

  registerCommands(cmd) {
    cmd.command('import')
      .description('Reverse-load a FHIRsmith SNOMED CT cache (*.cache) into a sqlite-v2 database')
      .requiredOption('-s, --source <file>', 'the .cache file')
      .requiredOption('-d, --dest <file>', 'destination .db')
      .option('--date-shift <days|auto>', 'days to add to every cache date (auto: fix caches built east of UTC)', 'auto')
      .option('--overwrite', 'replace the destination')
      .option('--force', 'import a cache with known defects (see the warnings)')
      .action(async (o) => {
        const s = await importSnomedV2FromCache({ source: o.source, dest: o.dest, overwrite: !!o.overwrite,
          dateShift: o.dateShift, force: !!o.force, log: (msg) => this.logInfo(msg) });
        this.logSuccess(`${s.concepts.toLocaleString()} concepts -> ${o.dest}`);
      });
    cmd.command('inspect')
      .description('Check FHIRsmith SNOMED CT caches for the known defects of older cache vintages (no import)')
      .argument('<files...>', '.cache files')
      .action(async (files) => {
        for (const f of files) {
          const s = await importSnomedV2FromCache({ source: f, inspectOnly: true, log: () => {} });
          console.log(JSON.stringify({ file: path.basename(f), version: s.cacheVersion, uri: s.versionUri,
            shift: s.shift, fatal: s.fatal, warnings: s.warnings.filter((w) => !s.fatal.includes(w)), counts: s.counts }));
        }
      });
  }
}

module.exports = { SnomedV2FromCacheModule, importSnomedV2FromCache, cacheDefaultLanguage, readCache };
