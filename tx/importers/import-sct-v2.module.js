'use strict';

// SNOMED CT RF2 Snapshot -> sqlite-v2 (tx/importers/sqlite-v2/schema-v2.sql).
//
// Source-specific parsing only; numbering, id rewrite, sets, indexes and provenance are the
// shared final stage (V2Builder.finish). What is read, from the Snapshot folder:
//   concepts        sct2_Concept: active flag; module (moduleId) and definitionStatusId as concept-valued
//                   properties, effectiveTime as a dateTime literal.
//   descriptions    sct2_Description + sct2_TextDefinition (all languages present): designations
//                   (use = description type), active and inactive.
//   display         preferred synonym in the edition's display language refsets, in their order
//                   (DISPLAY_REFSETS: US English for the International edition), else preferred
//                   synonym in any language refset, else FSN, else first active description
//                   (description-id order) - the rule of tx/cs/cs-snomed.js.
//   relationships   sct2_Relationship (inferred; stated is not read), active and inactive rows:
//                   116680003 |Is a| is the hierarchy, every other typeId a concept-valued
//                   property keyed by typeId, role group in group_id. Inactive rows whose typeId is
//                   a concrete-value attribute (below) are left out: a property has one value kind.
//   concrete values sct2_RelationshipConcreteValues, active inferred rows: literal properties
//                   keyed by typeId (#n -> decimal, "s" -> string, true/false -> boolean).
//   identifiers     sct2_Identifier, active rows -> alternate_identifier.
//   language refsets -> designation_acceptability (+ designation.preferred for US English).
//   other refsets   every der2_*Refset_* file under Refset/ with concept members: membership
//                   set per refset; extra columns (maps, associations, attribute values, ...)
//                   kept in refset_member. Rows that reference descriptions are counted, skipped.

const MODULE_DEPENDENCY = '900000000000534007';
const path = require('path');
const { BaseTerminologyModule } = require('./tx-import-base');
const { V2Builder } = require('./sqlite-v2/builder');
const { tsvRows, firstLine, walk } = require('./sqlite-v2/text');

const SCT = 'http://snomed.info/sct';
const IS_A = '116680003';
const FSN = '900000000000003001';
const SYNONYM = '900000000000013009';
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
 * in it; else English. A primary subtag, or null for English (cs_config keeps en-US then).
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

/** Provider configuration shared by the SNOMED v2 importers (RF2 and reverse-loaded caches). */
function applySnomedConfig(b, displayRefsets) {
  b.setConfig('caseSensitive', 1);
  b.setConfig('defaultLanguage', 'en-US');
  b.setConfig('hierarchyMeaning', 'is-a');
  b.setConfig('notClosed', 1);
  b.setConfig('displayRefsets', displayRefsets);
  // designation.rank (v5): the display order the engine uses (tx/sqlite-v2/snomed.js), without
  // reading acceptability at run time
  b.designationRank = { useSystem: SCT, useCode: SYNONYM, preferred: PREFERRED, refsets: [].concat(displayRefsets) };
  b.setConfig('inverseProperties', { child: IS_A });
  b.setConfig('implicitValueSets', [
    { pattern: '?fhir_vs', kind: 'all' },
    { pattern: '?fhir_vs=isa/{code}', kind: 'isa' },
    { pattern: '?fhir_vs=refset', kind: 'refsets' },
    { pattern: '?fhir_vs=refset/{code}', kind: 'refset' },
  ]);
}

/**
 * @param {object} cfg { source, dest, edition, version (YYYYMMDD), overwrite, log }
 */
/**
 * Normal forms of the fully defined concepts, stored in the finished file for native
 * post-coordination (data, built at import). Shared with the reverse loader.
 */
function storeNormalForms(dest, summary, log = () => {}) {
  const Database = require('better-sqlite3');
  const { V2Store } = require('../sqlite-v2/store');
  const { buildNormalForms } = require('../sqlite-v2/sct-native');
  const t0 = Date.now();
  const db = new Database(dest);
  const store = new V2Store(dest, { db, unregistered: true });
  const r = buildNormalForms(store, db, log);
  const secs = (Date.now() - t0) / 1000;
  db.prepare('INSERT OR REPLACE INTO provenance (key, value) VALUES (?, ?)').run('normalForms', JSON.stringify({ ...r, seconds: secs }));
  db.close();
  log(`normal forms: ${r.written.toLocaleString()} stored (${r.failed} could not be built), ${secs.toFixed(1)} s`);
  if (summary) summary.normalForms = r;
  return r;
}

async function importSnomedV2(cfg) {
  const log = cfg.log || console.log;
  const files = discover(cfg.source);
  const b = new V2Builder(cfg.dest, { overwrite: cfg.overwrite, log, importer: 'sct-v2' });
  for (const p of [files.concept, ...files.description, files.relationship, files.concrete, ...files.identifier,
    ...files.language, ...files.refset].filter(Boolean)) b.addSource(p);
  // cfg.versionUri: e.g. a test edition published as http://snomed.info/xsct/<module>/version/<date>
  const versionUri = cfg.versionUri || `${SCT}/${cfg.edition}/version/${cfg.version}`;
  const name = EDITION_NAMES[cfg.edition] || `SNOMED CT edition ${cfg.edition}`;
  b.setCodeSystem({
    uri: SCT, version: versionUri, name, title: name, edition: cfg.edition, releaseDate: isoDate(cfg.version),
    description: `SNOMED CT RF2 Snapshot, module ${cfg.edition}, version ${cfg.version}`,
  });
  const stats = { descriptionsSkipped: 0, relationshipsSkipped: 0, refsetDescriptionRows: 0, refsetUnknownRows: 0,
    inactiveConcreteTypeRelationshipsSkipped: 0 };

  const isA = b.property({ code: IS_A, uri: `${SCT}/${IS_A}`, fhirType: 'code', valueKind: 'concept', isHierarchy: true });
  const moduleProp = b.property({ code: 'module', fhirType: 'code', valueKind: 'concept', display: 'Module' });
  const defStatus = b.property({ code: 'definitionStatusId', fhirType: 'code', valueKind: 'concept', display: 'Definition status' });
  const effTime = b.property({ code: 'effectiveTime', fhirType: 'dateTime', valueKind: 'literal', display: 'Effective time' });

  // Concepts first (every fact below references them), then their module / status links.
  const meta = [];
  await b.stage('parse concepts', async () => {
    for await (const c of tsvRows(files.concept)) {
      const i = b.concept(c[0], { active: c[2] === '1' });
      meta.push(i, c[3], c[4], c[1]);
    }
    for (let k = 0; k < meta.length; k += 4) {
      const i = meta[k];
      const m = b.idx(meta[k + 1]), d = b.idx(meta[k + 2]);
      if (m !== undefined) b.link(i, moduleProp, m);
      if (d !== undefined) b.link(i, defStatus, d);
      b.literal(i, effTime, isoDate(meta[k + 3]));
    }
    return meta.length / 4;
  });
  meta.length = 0;

  // Language refsets before descriptions: acceptability drives display and `preferred`.
  // Rows are held until the descriptions have staging ids.
  const usPreferred = new Set(); // description ids Preferred in US English
  const anyPreferred = new Set(); // ... Preferred in any language refset
  // the display refsets the edition has, and each description's best place in them (where Preferred)
  const displayRefsets = displayRefsetsFor(cfg.edition).filter((c) => b.idx(c) !== undefined);
  const displayRank = new Map(displayRefsets.map((c, r) => [c, r]));
  const prefRank = new Map(); // description id -> best display-refset rank where it is Preferred
  const accDesc = [], accRefset = [], accValue = [];
  await b.stage('parse language refsets', async () => {
    let n = 0;
    for (const f of files.language) {
      for await (const r of tsvRows(f)) {
        if (r[2] !== '1') continue;
        const refset = b.idx(r[4]), acc = b.idx(r[6]);
        if (refset === undefined || acc === undefined) continue;
        accDesc.push(r[5]); accRefset.push(refset); accValue.push(acc);
        if (r[6] === PREFERRED) {
          anyPreferred.add(r[5]);
          if (r[4] === US_ENGLISH) usPreferred.add(r[5]);
          const k = displayRank.get(r[4]);
          if (k !== undefined && !(prefRank.get(r[5]) <= k)) prefRank.set(r[5], k);
        }
        n++;
      }
    }
    return n;
  });

  // Descriptions; display candidates per concept: [tier, descriptionId, term] (lower tier wins,
  // then smaller description id).
  const best = new Map();
  const consider = (i, tier, id, term) => {
    const cur = best.get(i);
    if (!cur || tier < cur[0] || (tier === cur[0] && idLess(id, cur[1]))) best.set(i, [tier, id, term]);
  };
  const stageId = new Map(); // description id -> designation staging id
  const activeLanguages = new Set(); // primary subtags of the active descriptions
  await b.stage('parse descriptions', async () => {
    let n = 0;
    for (const f of files.description) {
      for await (const r of tsvRows(f)) {
        const i = b.idx(r[4]);
        if (i === undefined) { stats.descriptionsSkipped++; continue; }
        const active = r[2] === '1', type = r[6], term = r[7];
        const d = b.designation(i, { language: r[5], use: { system: SCT, code: type }, term, active,
          preferred: usPreferred.has(r[0]) });
        if (d !== null) stageId.set(r[0], d);
        n++;
        if (!active) continue;
        activeLanguages.add(String(r[5] || '').toLowerCase().split('-')[0]);
        const syn = type === SYNONYM;
        const k = displayRefsets.length;
        if (syn && prefRank.has(r[0])) consider(i, prefRank.get(r[0]), r[0], term);
        else if (syn && anyPreferred.has(r[0])) consider(i, k, r[0], term);
        else if (type === FSN) consider(i, k + 1, r[0], term);
        else consider(i, k + 2, r[0], term);
        if (type === '900000000000550004') b.setDefinition(i, term);
      }
    }
    for (const [i, c] of best) b.setDisplay(i, c[2].trim());
    return n;
  });
  await b.stage('stage acceptability', async () => {
    let n = 0;
    for (let k = 0; k < accDesc.length; k++) {
      const d = stageId.get(accDesc[k]);
      if (d !== undefined) { b.acceptability(d, accRefset[k], accValue[k]); n++; }
    }
    return n;
  });
  usPreferred.clear(); anyPreferred.clear(); best.clear(); stageId.clear();
  accDesc.length = accRefset.length = accValue.length = 0;
  for (const u of b.uses.values()) { const i = b.idx(u.code); if (i !== undefined) u.display = b.display[i]; }

  // The concrete-value attribute types (the literal properties of the concrete values stage). An
  // inactive relationship row with one of these types and a concept target (UK Edition: retired
  // pre-concrete-domain drug rows) is left out: a property has one value kind, and main's provider
  // never reads inactive relationships (cs-snomed.js getConceptRelationships).
  const concreteTypes = new Set();
  if (files.concrete) {
    for await (const r of tsvRows(files.concrete)) {
      if (r[2] === '1' && r[8] === INFERRED && b.idx(r[4]) !== undefined) concreteTypes.add(r[7]);
    }
  }
  await b.stage('parse relationships', async () => {
    let n = 0;
    for await (const r of tsvRows(files.relationship)) {
      const s = b.idx(r[4]), t = b.idx(r[5]);
      if (s === undefined || t === undefined) { stats.relationshipsSkipped++; continue; }
      const type = r[7];
      if (r[2] !== '1' && concreteTypes.has(type)) { stats.inactiveConcreteTypeRelationshipsSkipped++; continue; }
      const p = type === IS_A ? isA : b.property({ code: type, uri: `${SCT}/${type}`, fhirType: 'code', valueKind: 'concept' });
      // seq: the row, the order cs-snomed.js lists parents, children and relationships in
      b.link(s, p, t, { group: Number(r[6]) || 0, active: r[2] === '1', seq: n });
      n++;
    }
    return n;
  });

  if (files.concrete) {
    await b.stage('parse concrete values', async () => {
      let n = 0;
      for await (const r of tsvRows(files.concrete)) {
        if (r[2] !== '1' || r[8] !== INFERRED) continue;
        const s = b.idx(r[4]);
        if (s === undefined) continue;
        const v = concrete(r[5]);
        const p = b.property({ code: r[7], uri: `${SCT}/${r[7]}`, fhirType: v.fhirType, valueKind: 'literal' });
        b.literal(s, p, v.value, { group: Number(r[6]) || 0 });
        n++;
      }
      return n;
    });
  }

  await b.stage('parse identifiers', async () => {
    let n = 0;
    for (const f of files.identifier) {
      for await (const r of tsvRows(f)) {
        if (r[2] !== '1') continue;
        const scheme = b.idx(r[4]), c = b.idx(r[5]);
        if (scheme === undefined || c === undefined) continue;
        b.alternateIdentifier(c, scheme, r[0]);
        n++;
      }
    }
    return n;
  });

  const moduleDependencies = [];
  await b.stage('parse refsets', async () => {
    let n = 0;
    for (const f of files.refset) {
      // der2_<types>Refset_<Name>Snapshot...: <types> = one letter per extra column (c, i, s)
      const m = /^der2_([cis]*)Refset_/.exec(path.basename(f));
      const types = m ? m[1].split('') : [];
      const header = firstLine(f).split('\t');
      const names = header.slice(6);
      const hasFields = names.length > 0;
      for await (const r of tsvRows(f)) {
        if (r[2] !== '1') continue;
        if (r[4] === MODULE_DEPENDENCY) {
          // module dependencies (which module depends on which, at which dates) go to cs_config:
          // the row's own moduleId matters, and the refset concept need not be in the edition
          moduleDependencies.push([r[3], r[5], r[6] || null, r[7] || null]);
          n++;
          continue;
        }
        const refset = b.idx(r[4]);
        const c = b.idx(r[5]);
        if (refset === undefined) { stats.refsetUnknownRows++; continue; }
        if (c === undefined) { if (/^\d+$/.test(r[5]) && r[5].slice(-2, -1) === '1') stats.refsetDescriptionRows++; else stats.refsetUnknownRows++; continue; }
        if (hasFields) b.refsetDef(refset, names, types.length === names.length ? types : names.map(() => 's'));
        b.refsetMember(refset, c, hasFields ? r.slice(6) : null, { time: r[1], module: b.idx(r[3]) });
        n++;
      }
    }
    if (moduleDependencies.length) b.setConfig('moduleDependencies', moduleDependencies);
    return n;
  });

  applySnomedConfig(b, displayRefsets.length ? displayRefsets : [US_ENGLISH]);
  const defLang = rf2DefaultLanguage(cfg, activeLanguages);
  if (defLang) b.setConfig('defaultLanguage', defLang);
  const summary = await b.finish(stats);
  if (cfg.normalForms !== false) storeNormalForms(cfg.dest, summary, log);
  return summary;
}

class SnomedV2Module extends BaseTerminologyModule {
  getName() { return 'snomed-v2'; }
  getDescription() { return 'SNOMED CT RF2 Snapshot -> SQLite (sqlite-v2 schema with stored Roaring sets)'; }
  getSupportedFormats() { return ['directory']; }

  registerCommands(cmd) {
    cmd.command('import')
      .description('Import an RF2 Snapshot (complete edition) into a sqlite-v2 database')
      .requiredOption('-s, --source <dir>', 'unzipped RF2 release (the Snapshot folder is used)')
      .requiredOption('-d, --dest <file>', 'destination .db')
      .requiredOption('-e, --edition <module>', 'edition module id, e.g. 900000000000207008 or 731000124108')
      .requiredOption('--snomed-version <YYYYMMDD>', 'release date')
      .option('--version-uri <uri>', 'version URI to record instead of http://snomed.info/sct/<edition>/version/<date>')
      .option('--overwrite', 'replace the destination')
      .option('-l, --language <code>', 'default language code (overrides the edition default, as main\'s importer)')
      .action(async (o) => {
        const s = await importSnomedV2({ source: o.source, dest: o.dest, edition: o.edition, version: o.snomedVersion,
          versionUri: o.versionUri, language: o.language, overwrite: !!o.overwrite, log: (m) => this.logInfo(m) });
        this.logSuccess(`${s.concepts.toLocaleString()} concepts -> ${o.dest}`);
      });
  }
}

module.exports = { SnomedV2Module, importSnomedV2, applySnomedConfig, displayRefsetsFor, DISPLAY_REFSETS, storeNormalForms, concrete, isoDate, idLess, EDITION_NAMES, EDITION_LANGUAGES, rf2DefaultLanguage };
