'use strict';

// SNOMED CT RF2 Snapshot -> a terminology file. RF2 parsing only; where each fact goes is the shared
// stage (sct-v2-common.js SnomedSink). What is read, from the Snapshot folder: sct2_Concept,
// sct2_Description and sct2_TextDefinition (every language), sct2_Relationship (inferred; stated is
// not read), sct2_RelationshipConcreteValues (active inferred rows), sct2_Identifier, the language
// refsets and every der2_*Refset_* file under Refset/ (rows on concepts and on descriptions; the
// module dependency refset as meta moduleDependencies).

const path = require('path');
const { BaseTerminologyModule } = require('./tx-import-base');
const { tsvRows, firstLine } = require('./sqlite-v2/text');
const {
  SnomedSink, discover, MODULE_DEPENDENCY, displayRefsetsFor, isoDate, concrete, EDITION_NAMES, rf2DefaultLanguage,
  SCT, US_ENGLISH, INFERRED,
} = require('./sct-v2-common');

/** @param {object} cfg { source, dest, edition, version (YYYYMMDD), versionUri, language, overwrite, log, normalForms } */
async function importSnomedV2(cfg) {
  const log = cfg.log || console.log;
  const files = discover(cfg.source);
  const versionUri = cfg.versionUri || `${SCT}/${cfg.edition}/version/${cfg.version}`;
  const name = EDITION_NAMES[cfg.edition] || `SNOMED CT edition ${cfg.edition}`;
  // the display refsets are known once the concepts are read: the sink gets them by reference
  const displayRefsets = [];
  const sink = new SnomedSink({
    dest: cfg.dest, overwrite: cfg.overwrite, log, importer: 'sct-v2', edition: cfg.edition,
    codeSystem: { uri: SCT, version: versionUri, name, title: name, releaseDate: isoDate(cfg.version),
      description: `SNOMED CT RF2 Snapshot, module ${cfg.edition}, version ${cfg.version}`, defaultLanguage: 'en-US' },
    displayRefsets, preferredRefset: US_ENGLISH, normalForms: cfg.normalForms,
  });
  const b = sink.b;
  for (const p of [files.concept, ...files.description, files.relationship, files.concrete, ...files.identifier,
    ...files.language, ...files.refset].filter(Boolean)) b.addSource(p);
  const stats = {};

  const meta = [];
  await sink.stage('parse concepts', async () => {
    for await (const c of tsvRows(files.concept)) meta.push(sink.concept(c[0], c[2] === '1'), c[3], c[4], c[1]);
    for (let k = 0; k < meta.length; k += 4) sink.conceptMeta(meta[k], sink.idx(meta[k + 1]), sink.idx(meta[k + 2]), isoDate(meta[k + 3]));
    return meta.length / 4;
  });
  meta.length = 0;
  for (const c of displayRefsetsFor(cfg.edition)) if (sink.idx(c) !== undefined) displayRefsets.push(c);
  // an edition without any of its display refsets lists US English
  if (!displayRefsets.length) sink.displayContextsFallback = [US_ENGLISH];

  await sink.stage('parse language refsets', async () => {
    let n = 0;
    for (const f of files.language) {
      for await (const r of tsvRows(f)) {
        if (r[2] !== '1') continue;
        sink.languageMember(r[5], r[4], r[6]);
        n++;
      }
    }
    return n;
  });

  const activeLanguages = new Set();
  await sink.stage('parse descriptions', async () => {
    let n = 0;
    for (const f of files.description) {
      for await (const r of tsvRows(f)) {
        const i = sink.idx(r[4]);
        if (i === undefined) continue;
        const active = r[2] === '1';
        sink.description({ key: r[0], id: r[0], concept: i, language: r[5], type: r[6], term: r[7], active });
        if (active) activeLanguages.add(String(r[5] || '').toLowerCase().split('-')[0]);
        n++;
      }
    }
    sink.descriptionsDone();
    return n;
  });

  // the concrete-value attribute types (active inferred rows of known concepts), with the literal
  // type of each type's first row
  const concreteTypes = new Map();
  if (files.concrete) {
    for await (const r of tsvRows(files.concrete)) {
      if (r[2] === '1' && r[8] === INFERRED && sink.idx(r[4]) !== undefined && !concreteTypes.has(r[7])) concreteTypes.set(r[7], concrete(r[5]).fhirType);
    }
  }
  sink.setConcreteTypes(concreteTypes);
  await sink.stage('parse relationships', async () => {
    let n = 0;
    for await (const r of tsvRows(files.relationship)) {
      sink.relationship(sink.idx(r[4]), sink.idx(r[5]), r[7], Number(r[6]) || 0, r[2] === '1');
      n++;
    }
    return n;
  });
  await sink.stage('parse concrete values', async () => {
    let n = 0;
    if (files.concrete) {
      for await (const r of tsvRows(files.concrete)) {
        if (r[2] !== '1' || r[8] !== INFERRED) continue;
        sink.concreteValue(sink.idx(r[4]), r[7], Number(r[6]) || 0, r[5]);
        n++;
      }
    }
    sink.concreteDone();
    return n;
  });

  await sink.stage('parse identifiers', async () => {
    let n = 0;
    for (const f of files.identifier) {
      for await (const r of tsvRows(f)) {
        if (r[2] !== '1') continue;
        sink.identifier(r[4], r[0], r[5]);
        n++;
      }
    }
    return n;
  });

  await sink.stage('parse refsets', async () => {
    let n = 0;
    for (const f of files.refset) {
      // der2_<types>Refset_<Name>Snapshot...: <types> = one letter per extra column (c, i, s)
      const m = /^der2_([cis]*)Refset_/.exec(path.basename(f));
      const types = m ? m[1].split('') : [];
      const names = firstLine(f).split('\t').slice(6);
      const def = { names, types: types.length === names.length ? types : names.map(() => 's') };
      for await (const r of tsvRows(f)) {
        if (r[2] !== '1') continue;
        n++;
        if (r[4] === MODULE_DEPENDENCY) { sink.moduleDependency([r[3], r[5], r[6] || null, r[7] || null]); continue; }
        sink.refsetMember(r[4], r[5], def, names.length ? r.slice(6) : null, { time: r[1], module: r[3] });
      }
    }
    return n;
  });

  if (sink.displayContextsFallback) sink.displayRefsets.push(...sink.displayContextsFallback);
  const defLang = rf2DefaultLanguage(cfg, activeLanguages);
  if (defLang) b.systems[0].defaultLanguage = defLang;
  return sink.finish(stats);
}

class SnomedV2Module extends BaseTerminologyModule {
  getName() { return 'snomed-v2'; }
  getDescription() { return 'SNOMED CT RF2 Snapshot -> SQLite terminology file (sqlite-v2 provider)'; }
  getSupportedFormats() { return ['directory']; }

  registerCommands(cmd) {
    cmd.command('import')
      .description('Import an RF2 Snapshot into a terminology file')
      .requiredOption('-s, --source <dir>', 'unzipped RF2 release (the Snapshot folder is used)')
      .requiredOption('-d, --dest <file>', 'destination .db')
      .requiredOption('-e, --edition <module>', 'edition module id')
      .requiredOption('--snomed-version <YYYYMMDD>', 'release date')
      .option('--version-uri <uri>', 'version URI to record')
      .option('--overwrite', 'replace the destination')
      .option('-l, --language <code>', 'default language code')
      .action(async (o) => {
        const s = await importSnomedV2({ source: o.source, dest: o.dest, edition: o.edition, version: o.snomedVersion,
          versionUri: o.versionUri, language: o.language, overwrite: !!o.overwrite, log: (m) => this.logInfo(m) });
        this.logSuccess(`${s.concepts.toLocaleString()} concepts -> ${o.dest}`);
      });
  }
}

module.exports = { SnomedV2Module, importSnomedV2, rf2DefaultLanguage };
