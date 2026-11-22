'use strict';

// FHIRsmith SNOMED CT cache (*.cache, tx/sct/structures.js) -> a terminology file ("reverse loader"),
// for the editions we can only get as tx.fhir.org's binary caches. Cache decoding only; where each
// fact goes is the shared stage (sct-v2-common.js SnomedSink), as for RF2:
//   concepts        active (status nibble), module, definition status (primitive flag), effectiveTime
//   descriptions    every description record (incl. text definitions), active and inactive, language
//                   from the cache's language byte
//   relationships   every relationship record, active and inactive, in record order
//   concrete values cache v19 and later (active inferred rows)
//   identifiers     cache v18 and later (active rows)
//   refsets         language refsets (members referencing descriptions, refset under 900000000000506000);
//                   every other refset's members, on concepts or on descriptions
// What the cache does not carry (inactive refset members, map refsets, concrete values before v19,
// ...) is not in the file either. Dates: 'auto' adds a day to caches built east of UTC (upstream
// b082f98); known defects of older cache vintages stop the import unless forced.

const path = require('path');
const { BaseTerminologyModule } = require('./tx-import-base');
const {
  SnomedStrings, SnomedReferences, SnomedDescriptions, SnomedConceptList, SnomedRelationshipList,
  SnomedReferenceSetMembers, SnomedReferenceSetIndex,
} = require('../sct/structures');
const { SnomedFileReader, SNOMED_CACHE_VERSION } = require('../sct/structures');
const { isoDate, displayRefsetsFor, checkDisplayRefsets, concrete, SnomedSink, SCT } = require('./sct-v2-common');
const { editionName } = require('../sct/editions');

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

/** @param {object} cfg { source (.cache), dest, overwrite, dateShift ('auto' | days), force, log, normalForms } */
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

  const code = new Array(nC);
  for (let k = 0; k < nC; k++) code[k] = cbuf.readBigUInt64LE(k * C).toString();
  const ord = (offset) => {
    if (offset % C !== 0 || offset >= cbuf.length) throw new Error(`bad concept offset ${offset}`);
    return offset / C;
  };
  const ordOf = new Map();
  for (let k = 0; k < nC; k++) ordOf.set(code[k], k);
  const known = (c) => ordOf.get(c);
  const descId = (k) => dbuf.readBigUInt64LE(k * D + 5).toString();

  // dates ('auto': +1 day for caches built east of UTC before upstream b082f98)
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

  const refsets = [];
  for (let k = 0; k < rsIndex.count(); k++) refsets.push(rsIndex.getReferenceSet(k));
  // the known defects of older cache vintages (fatal unless cfg.force), and warnings
  const warnings = [];
  {
    const fatal = [];
    let noModule = 0, primitive = 0;
    for (let k = 0; k < nC; k++) {
      if (!cbuf.readUInt32LE(k * C + 36)) noModule++;
      if (cbuf.readUInt8(k * C + 8) & SnomedConceptList.MASK_CONCEPT_PRIMITIVE) primitive++;
    }
    if (noModule > nC / 100) fatal.push(`${noModule} of ${nC} concepts have no module`);
    if (primitive === 0) fatal.push('no concept is primitive (definition status lost)');
    const defs = new Map(), members = new Map();
    for (const e of refsets) {
      defs.set(e.definition, (defs.get(e.definition) || 0) + 1);
      members.set(e.definition, (members.get(e.definition) || 0) + rsMembers.getMemberCount(e.membersByRef));
    }
    const dup = [...defs].filter(([, n]) => n > 1);
    if (dup.length) fatal.push(`refset index names ${dup.map(([o, n]) => `${code[o / C]} x${n}`).join(', ')} (refsets collapsed onto one concept)`);
    const shown = checkDisplayRefsets(edition, displayRefsetsFor(edition).filter((r) => known(r) !== undefined),
      (r) => members.get(known(r) * C), nC);
    fatal.push(...shown.fatal);
    warnings.push(...shown.warnings);
    if (shift) warnings.push(`dates shifted by ${shift} day(s) (cache built east of UTC before upstream b082f98)`);
    if (!(d.concreteValues || []).length) warnings.push(`no concrete values (cache v${d.cacheVersion}; carried from v19)`);
    warnings.push(...fatal);
    for (const w of warnings) log(`WARNING: ${w}`);
    if (cfg.inspectOnly) return { inspectOnly: true, cacheVersion: d.cacheVersion, versionUri: d.versionUri, shift, fatal, warnings,
      counts: { concepts: nC, descriptions: nD, relationships: nR, refsets: refsets.length } };
    if (fatal.length && !cfg.force) throw new Error(`${path.basename(cfg.source)}: defective cache (${fatal.join('; ')}); use --force to import anyway`);
  }

  const displayRefsets = displayRefsetsFor(edition).filter((c) => known(c) !== undefined);
  const defByte = cacheDefaultLanguage(d);
  const name = (editionName(edition) ? `SNOMED CT ${editionName(edition)}` : `SNOMED CT edition ${edition}`);
  const sink = new SnomedSink({
    dest: cfg.dest, overwrite: cfg.overwrite, log, importer: 'sct-v2-from-cache', edition,
    codeSystem: { uri: SCT, version: d.versionUri, name, title: name, releaseDate: isoDate(version),
      description: `SNOMED CT edition ${edition} version ${version}, from FHIRsmith cache v${d.cacheVersion} (${path.basename(cfg.source)})`,
      // the cache's default-language slot (cacheDefaultLanguage; en-US for English)
      defaultLanguage: defByte !== 1 && LANGUAGE[defByte] ? LANGUAGE[defByte] : 'en-US' },
    // the description flag `preferred` = Preferred in the first display refset
    displayRefsets, preferredRefset: displayRefsets[0], normalForms: cfg.normalForms,
  });
  sink.b.addSource(cfg.source);
  sink.b.setMeta('provenance.sourceFormat', `fhirsmith-cache-v${d.cacheVersion}`);
  const stats = { cacheVersion: d.cacheVersion, dateShiftDays: shift, cacheWarnings: warnings, conceptsWithoutModule: 0, unknownFieldValues: 0, refsetsWithoutConcept: 0, otherRefsetRowsSkipped: 0, languageRefsets: [] };

  await sink.stage('decode concepts', async () => {
    for (let k = 0; k < nC; k++) {
      const flags = cbuf.readUInt8(k * C + 8);
      const i = sink.concept(code[k], (flags & SnomedConceptList.MASK_CONCEPT_STATUS) === 0);
      if (i !== k) throw new Error(`duplicate concept ${code[k]} in cache`);
    }
    const prim = known(PRIMITIVE), defd = known(DEFINED);
    for (let k = 0; k < nC; k++) {
      const o = k * C;
      const mod = cbuf.readUInt32LE(o + 36);
      if (!mod) stats.conceptsWithoutModule++;
      const ds = (cbuf.readUInt8(o + 8) & SnomedConceptList.MASK_CONCEPT_PRIMITIVE) ? prim : defd;
      const t = date(cbuf.readUInt16LE(o + 34));
      sink.conceptMeta(k, mod ? ord(mod) : undefined, ds, t ? isoDate(t) : null);
    }
    return nC;
  });

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

  // a member's extra field values as RF2 text (component ids as SCTIDs)
  const fieldValues = (valuesRef) => {
    const v = getRefs(valuesRef);
    const out = [];
    for (let j = 0; j + 1 < v.length; j += 2) {
      const val = v[j], type = v[j + 1];
      switch (type) {
        case 1: out.push(val > 0 && val % C === 0 && val < cbuf.length ? code[val / C] : (stats.unknownFieldValues++, '')); break;
        case 2: out.push(dbuf.readBigUInt64LE(val + 5).toString()); break;
        case 4: out.push(String(val | 0)); break;
        case 5: out.push(strings.getEntry(val)); break;
        default: stats.unknownFieldValues++; out.push('');
      }
    }
    return out;
  };

  const langs = new Set();
  await sink.stage('decode language refsets', async () => {
    let n = 0;
    for (const e of refsets) {
      const r = e.definition / C;
      const members = rsMembers.getMembers(e.membersByRef) || [];
      if (!members.some((x) => x.kind === 1) || !isLanguageRefset(r)) continue;
      stats.languageRefsets.push(code[r]);
      langs.add(code[r]);
      for (const x of members) {
        if (x.kind !== 1) continue;
        const acc = getRefs(x.values);
        if (acc.length < 2 || acc[1] !== 1) continue;
        sink.languageMember(descId(x.ref / D), code[r], code[acc[0] / C]);
        n++;
      }
    }
    return n;
  });

  await sink.stage('decode descriptions', async () => {
    for (let k = 0; k < nD; k++) {
      const o = k * D;
      const id = descId(k);
      sink.description({ key: id, id, concept: ord(dbuf.readUInt32LE(o + 13)), language: LANGUAGE[dbuf.readUInt8(o + 31)] || 'en',
        type: code[ord(dbuf.readUInt32LE(o + 21))], term: strings.getEntry(dbuf.readUInt32LE(o)), active: dbuf.readUInt8(o + 4) !== 0 });
    }
    sink.descriptionsDone();
    return nD;
  });

  // concrete-value attribute types (of known concepts), with the literal type of each type's first value
  const concreteTypes = new Map();
  for (const [src, type, , raw] of d.concreteValues || []) {
    if (known(String(src)) !== undefined && !concreteTypes.has(String(type))) concreteTypes.set(String(type), concrete(String(raw)).fhirType);
  }
  sink.setConcreteTypes(concreteTypes);
  await sink.stage('decode relationships', async () => {
    for (let k = 0; k < nR; k++) {
      const o = k * R;
      sink.relationship(ord(rbuf.readUInt32LE(o)), ord(rbuf.readUInt32LE(o + 4)), code[ord(rbuf.readUInt32LE(o + 8))],
        rbuf.readInt32LE(o + 28) || 0, rbuf.readUInt8(o + 26) !== 0);
    }
    return nR;
  });
  await sink.stage('decode concrete values', async () => {
    let n = 0;
    for (const [src, type, group, raw] of d.concreteValues || []) {
      sink.concreteValue(known(String(src)), String(type), Number(group) || 0, String(raw));
      n++;
    }
    sink.concreteDone();
    return n;
  });

  await sink.stage('decode identifiers', async () => {
    for (const [scheme, , id, concept] of d.identifiers || []) sink.identifier(String(scheme), String(id), String(concept));
    return (d.identifiers || []).length;
  });

  await sink.stage('decode refsets', async () => {
    let n = 0;
    for (const e of refsets) {
      const r = e.definition / C;
      let rname = '';
      try { rname = strings.getEntry(e.name) || ''; } catch (err) { rname = ''; }
      if (code[r] === '900000000000534007' || rname.startsWith('ModuleDependency')) {
        for (const x of rsMembers.getMembers(e.membersByRef) || []) {
          if (x.kind !== 0 || x.module == null) continue;
          const f = fieldValues(x.values);
          sink.moduleDependency([code[ord(x.module)], code[ord(x.ref)], f[0] || null, f[1] || null]);
          n++;
        }
        continue;
      }
      if (langs.has(code[r])) continue;
      if (r === 0) { stats.refsetsWithoutConcept++; continue; }
      const types = getRefs(e.fieldTypes).map((t) => String.fromCharCode(t));
      const names = getRefs(e.fieldNames).map((s) => strings.getEntry(s));
      const def = { names: names.length === types.length ? names : types.map((t, j) => `field${j + 1}`), types };
      for (const x of rsMembers.getMembers(e.membersByRef) || []) {
        if (x.kind !== 0 && x.kind !== 1) { stats.otherRefsetRowsSkipped++; continue; }
        const ref = x.kind === 0 ? code[ord(x.ref)] : descId(x.ref / D);
        const meta = { time: x.date != null ? date(x.date) : null, module: x.module != null ? code[ord(x.module)] : null };
        sink.refsetMember(code[r], ref, def, types.length ? fieldValues(x.values) : null, meta, x.kind === 1);
        n++;
      }
    }
    return n;
  });

  log(`default language: slot ${d.defaultLanguage} -> ${LANGUAGE[defByte] || 'en'}`);
  return sink.finish(stats);
}

class SnomedV2FromCacheModule extends BaseTerminologyModule {
  getName() { return 'snomed-v2-from-cache'; }
  getDescription() { return 'FHIRsmith SNOMED CT .cache -> SQLite terminology file (sqlite-v2 provider), for editions without RF2'; }
  getSupportedFormats() { return ['file']; }

  registerCommands(cmd) {
    cmd.command('import')
      .description('Reverse-load a FHIRsmith SNOMED CT cache (*.cache) into a terminology file')
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

module.exports = { SnomedV2FromCacheModule, importSnomedV2FromCache, cacheDefaultLanguage, readCache, view, sctDate };
