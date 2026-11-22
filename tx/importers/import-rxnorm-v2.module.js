'use strict';

// RxNorm RRF release -> a terminology file (tx/importers/sqlite-v2/schema.sql). The selection and
// display rules follow cs-rxnorm.js; where each fact goes:
//   concepts      every RXCUI with an SAB=RXNORM atom in RXNCONSO, inactive when its display atom is
//                 SUPPRESS = O; RXCUIs only in RXNATOMARCHIVE (SAB=RXNORM) inactive, no SUPPRESS.
//                 concept.display (derived): the first non-SY atom by PSN, ET, TMSY rank, else the code.
//   items         every SAB=RXNORM atom of RXNCONSO (all of them, duplicates of a text included):
//                 external_id = RXAUI, use = its TTY (item_use system = RxNorm), en-US, active.
//                 Archived concepts: their RXNATOMARCHIVE atoms, active = 0.
//   literals      on the concept, as served: TTY (each TTY of its RXNORM atoms), SAB (each source
//                 with an atom for it), SUPPRESS (each flag of its RXNORM atoms), STY (RXNSTY TUI).
//   links         RXNREL SAB=RXNORM rows between concepts: one link under the RELA property,
//                 subject = RXCUI2, target = RXCUI1 (a row with no RELA: under `@REL`, a member of the REL).
//   catalog       TTY, SAB, SUPPRESS, STY literal properties; one link property per RELA
//                 (wildcard = 1) and per REL (wildcard = 0) that RXNREL names, from any source and
//                 at any level - those without concept-level RXNORM rows have n_rows = 0 (a name a
//                 filter may use that selects nothing). A REL is the union (property_member) of the
//                 RELAs its rows carry. A RELA whose rows carry more than one REL is also
//                 stored under `RELA@REL` properties (wildcard = 0), one per REL, which are the
//                 REL's members instead, so a REL's union is exact.
//   atom rows     with atomRelationships (optional, off by default): every RXNREL atom-level row
//                 (STYPE AUI, any source), as cs-rxnorm.js reads them for a REL / RELA = AUI:<rxaui>
//                 filter: one identifier statement value RXAUI1 -> the concept owning RXAUI2 (its
//                 RXCUI in RXNCONSO, any source; rows whose concept is not served are left out),
//                 under one catalog row per (REL, RELA) pair `AUI:<REL>:<RELA>` (shape identifier,
//                 filterable 0); `AUI:<REL>` and `AUI:<RELA>` are unions of the pairs. No item is
//                 needed for another source's atom: the value is the RXAUI.
//   not imported  other sources' atoms, RXNSAT, archive atoms of live concepts (as the built-in
//                 provider).
//   order         concepts by (primary TTY rank, ingredient group): the numbering's sort key.

const fs = require('fs');
const path = require('path');
const { BaseTerminologyModule } = require('./tx-import-base');
const { TerminologyBuilder } = require('./sqlite-v2/builder');
const { lines } = require('./sqlite-v2/text');

const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm';
const TTY_RANK = ['IN', 'PIN', 'MIN', 'BN', 'DF', 'DFG', 'SCDC', 'SCDF', 'SCDFP', 'SCDG', 'SCDGP', 'SCD',
  'SBDC', 'SBDF', 'SBDFP', 'SBDG', 'SBD', 'GPCK', 'BPCK', 'PSN', 'SY', 'TMSY', 'ET'];
const DISPLAY_RANK = { PSN: 1, ET: 2, TMSY: 3, SY: 4 };
const TOWARDS_INGREDIENT = new Set(['has_ingredient', 'has_precise_ingredient', 'has_ingredients', 'tradename_of',
  'consists_of', 'isa', 'has_part', 'contains', 'form_of', 'quantified_form_of']);

async function* rrf(file) {
  for await (const l of lines(file)) if (l) yield l.split('|');
}

/** @param {object} cfg { source (rrf dir), dest, version (MMDDYYYY), overwrite, log, atomRelationships } */
async function importRxNormV2(cfg) {
  const log = cfg.log || console.log;
  const f = (n) => path.join(cfg.source, n);
  for (const n of ['RXNCONSO.RRF', 'RXNREL.RRF', 'RXNSTY.RRF']) if (!fs.existsSync(f(n))) throw new Error(`missing ${f(n)}`);
  const b = new TerminologyBuilder(cfg.dest, { overwrite: cfg.overwrite, log, importer: 'rxnorm-v2' });
  for (const n of ['RXNCONSO.RRF', 'RXNREL.RRF', 'RXNSTY.RRF', 'RXNATOMARCHIVE.RRF']) if (fs.existsSync(f(n))) b.addSource(f(n));
  const v = cfg.version;
  b.codeSystem({ uri: RXNORM, version: v, name: 'RxNorm', title: 'RxNorm',
    releaseDate: /^\d{8}$/.test(v) ? `${v.slice(4)}-${v.slice(0, 2)}-${v.slice(2, 4)}` : null,
    description: 'RxNorm normalized drug nomenclature (U.S. National Library of Medicine)',
    caseSensitive: true, defaultLanguage: 'en-US' });
  // as cs-rxnorm.js presents it: by RXCUI as text (the stored order), each atom text once, no
  // designation uses, versions by date
  b.setBehaviour('expansionOrder', 'stored');
  b.setBehaviour('distinctDesignationTexts', true);
  b.setBehaviour('designationUses', 'drop');
  b.setBehaviour('versionAlgorithm', 'date');
  // cs-rxnorm.js takes = and in only, on TTY, STY, SAB and the relationships
  const EQ_IN = ['=', 'in'];

  const lit = (code, display, extra = {}) => b.property({ code, uri: `${RXNORM}/${code}`, shape: 'literal', fhirType: 'code', display, filterOps: EQ_IN, ...extra });
  // SUPPRESS is no filter name (cs-rxnorm.js filters TTY, STY, SAB): its has-property set is the
  // RXNCONSO concepts (the live domain), and it has no property = value sets
  const TTY = lit('TTY', 'Term Type'), SAB = lit('SAB', 'Source'), SUPPRESS = lit('SUPPRESS', 'Suppress flag', { filterable: false, filterOps: null }),
    STY = lit('STY', 'Semantic Type (TUI)');
  const useOf = new Map();
  const use = (tty) => { let u = useOf.get(tty); if (u === undefined) useOf.set(tty, u = b.use({ system: RXNORM, code: tty || 'unknown', display: tty || null })); return u; };
  const rank = new Map();
  const stats = { archivedConcepts: 0, relSkipped: 0, atomStatements: 0, atomRowsSkipped: 0 };
  const atomCui = cfg.atomRelationships ? new Map() : null; // RXAUI -> RXCUI, every source's atom

  // RXNCONSO: RXCUI|LAT|TS|LUI|STT|SUI|ISPREF|RXAUI|SAUI|SCUI|SDUI|SAB|TTY|CODE|STR|SRL|SUPPRESS|CVF
  const sabs = [];
  await b.stage('parse RXNCONSO', async () => {
    let n = 0;
    const shown = new Map(); // concept -> [rank, SUPPRESS] of its display atom so far
    for await (const c of rrf(f('RXNCONSO.RRF'))) {
      const cui = c[0], aui = c[7], sab = c[11], tty = c[12], str = c[14].trim(), sup = c[16];
      if (atomCui) atomCui.set(aui, cui);
      if (sab !== 'RXNORM') {
        sabs.push(cui, sab);
        continue;
      }
      const i = b.concept(cui);
      if (tty !== 'SY') {
        const cur = shown.get(i), dr = DISPLAY_RANK[tty] || 0;
        if (!cur || dr < cur[0]) { b.setDisplay(i, str); shown.set(i, [dr, sup]); }
      }
      b.item(i, { externalId: aui, language: 'en-US', use: use(tty), text: str, active: true });
      b.literal(i, TTY, tty);
      b.literal(i, SUPPRESS, sup);
      const r = TTY_RANK.indexOf(tty);
      const rr = r < 0 ? TTY_RANK.length : r;
      if (!rank.has(i) || rr < rank.get(i)) rank.set(i, rr);
      n++;
    }
    stats.obsoleteConcepts = 0;
    for (const [i, [, sup]] of shown) if (sup === 'O') { b.setActive(i, false); stats.obsoleteConcepts++; }
    shown.clear();
    const sabSeen = new Set();
    for (let i = 0; i < b.codes.length; i++) { b.literal(i, SAB, 'RXNORM'); if (b.display[i] === null) b.setDisplay(i, b.codes[i]); }
    for (let k = 0; k < sabs.length; k += 2) {
      const i = b.idx(sabs[k]);
      if (i === undefined || sabs[k + 1] === 'RXNORM') continue;
      const key = `${i}|${sabs[k + 1]}`;
      if (!sabSeen.has(key)) { sabSeen.add(key); b.literal(i, SAB, sabs[k + 1]); }
    }
    sabs.length = 0;
    return n;
  });

  // RXNATOMARCHIVE: RXAUI|AUI|STR|ARCHIVE_TIMESTAMP|CREATED_TIMESTAMP|UPDATED_TIMESTAMP|CODE|IS_BRAND|LAT|
  //                 LAST_RELEASED|SAUI|VSAB|RXCUI|SAB|TTY|MERGED_TO_RXCUI
  if (fs.existsSync(f('RXNATOMARCHIVE.RRF'))) {
    await b.stage('parse RXNATOMARCHIVE', async () => {
      const live = b.codes.length;
      const archShown = new Map();
      let n = 0;
      for await (const c of rrf(f('RXNATOMARCHIVE.RRF'))) {
        const cui = c[12], sab = c[13], tty = c[14], str = c[2].trim();
        if (sab !== 'RXNORM' || !cui) continue;
        const known = b.idx(cui);
        if (known !== undefined && known < live) continue; // still live: archive atoms are history (not imported)
        const i = b.concept(cui, { active: false });
        if (tty !== 'SY') {
          const dr = DISPLAY_RANK[tty] || 0, cur = archShown.get(i);
          if (cur === undefined || dr < cur) { archShown.set(i, dr); b.setDisplay(i, str); }
        }
        b.item(i, { externalId: c[0], language: 'en-US', use: use(tty), text: str, active: false });
        n++;
      }
      for (let i = live; i < b.codes.length; i++) if (b.display[i] === null) b.setDisplay(i, b.codes[i]);
      stats.archivedConcepts = b.codes.length - live;
      return n;
    });
  }

  // RXNSTY: RXCUI|TUI|STN|STY|ATUI|CVF
  await b.stage('parse RXNSTY', async () => {
    let n = 0;
    for await (const c of rrf(f('RXNSTY.RRF'))) {
      const i = b.idx(c[0]);
      if (i !== undefined && c[1]) { b.literal(i, STY, c[1]); n++; }
    }
    return n;
  });

  // RXNREL: RXCUI1|RXAUI1|STYPE1|REL|RXCUI2|RXAUI2|STYPE2|RELA|RUI|SRUI|SAB|SL|DIR|RG|SUPPRESS|CVF
  const relProp = (rel) => b.property({ code: rel, uri: `${RXNORM}/${rel}`, shape: 'link', display: rel, wildcard: false, filterOps: EQ_IN });
  const relaProp = (rela) => b.property({ code: rela, uri: `${RXNORM}/${rela}`, shape: 'link', display: rela, wildcard: true, filterOps: EQ_IN });
  // a REL's rows with no RELA (atom-level SY rows): their own property `@REL`, one of the REL's
  // members, so that a REL is a union whether or not its other rows carry RELAs
  const noRelaOf = new Map();
  const noRela = (rel) => {
    let p = noRelaOf.get(rel);
    if (p === undefined) {
      p = b.property({ code: `@${rel}`, uri: `${RXNORM}/${rel}`, shape: 'link', display: `${rel} (no RELA)`, wildcard: false, filterable: false });
      b.propertyMember(relProp(rel), p);
      noRelaOf.set(rel, p);
    }
    return p;
  };
  // atom-level rows: value RXAUI1 -> the concept of RXAUI2, one statement per row under its
  // (REL, RELA) pair; AUI:<REL> and AUI:<RELA> are the unions a filter reads
  const atomUnion = new Map();
  const atomUnionOf = (name) => {
    let u = atomUnion.get(name);
    if (u === undefined) {
      u = b.property({ code: `AUI:${name}`, uri: `${RXNORM}/${name}`, shape: 'union', display: `${name}, atom-level rows`, filterable: false });
      atomUnion.set(name, u);
    }
    return u;
  };
  const atomPair = new Map();
  const atomProp = (rel, rela) => {
    const code = `AUI:${rel}:${rela}`;
    let p = atomPair.get(code);
    if (p === undefined) {
      // read by value only (a filter's RXAUI): no by-subject index
      p = b.property({ code, uri: `${RXNORM}/${rela || rel}`, shape: 'identifier', bySubject: false,
        display: `${rel} ${rela}, atom-level rows (RXAUI1 -> the concept of RXAUI2)`, filterable: false });
      if (rel) b.propertyMember(atomUnionOf(rel), p);
      if (rela) b.propertyMember(atomUnionOf(rela), p);
      atomPair.set(code, p);
    }
    return p;
  };
  const towards = [];
  const names = { rel: new Set(), rela: new Set() };
  const relsOf = new Map();  // RELA -> the RELs its concept-level RXNORM rows carry
  const relRows = [];        // (subject, target, RELA property, REL) per link, for the RELA@REL split
  await b.stage('parse RXNREL', async () => {
    let n = 0;
    for await (const c of rrf(f('RXNREL.RRF'))) {
      const rel = c[3], rela = c[7];
      if (rel) names.rel.add(rel);
      if (rela) names.rela.add(rela);
      if (c[2] === 'AUI' || c[6] === 'AUI') {
        // an atom-level row (any source): with atomRelationships, value RXAUI1 -> RXAUI2's concept
        if (!atomCui || !c[1] || !c[5]) continue;
        const subject = b.idx(atomCui.get(c[5]));
        if (subject === undefined) { stats.atomRowsSkipped++; continue; }
        b.identifier(atomProp(rel, rela), c[1], subject);
        stats.atomStatements++;
        continue;
      }
      if (c[10] !== 'RXNORM' || !c[0] || !c[4]) continue;
      const t = b.idx(c[0]), s = b.idx(c[4]);
      if (s === undefined || t === undefined) { stats.relSkipped++; continue; }
      if (rela) {
        const p = relaProp(rela);
        b.link(s, p, t);
        if (rel) {
          let r = relsOf.get(rela);
          if (!r) relsOf.set(rela, r = new Set());
          r.add(rel);
          relRows.push(s, t, p, rel);
        }
      } else if (rel) b.link(s, noRela(rel), t); // a row with no RELA: under `@REL`, a member of the REL
      if (TOWARDS_INGREDIENT.has(rela) && s >= 0 && t >= 0) towards.push(s, t);
      n++;
    }
    // a RELA under several RELs: its rows again under RELA@REL, the REL's member instead of the RELA
    const split = new Map();
    for (const [rela, rels] of relsOf) if (rels.size > 1) split.set(relaProp(rela), rela);
    const qualified = new Map();
    for (let k = 0; k < relRows.length; k += 4) {
      const rela = split.get(relRows[k + 2]);
      if (rela === undefined) continue;
      const rel = relRows[k + 3], code = `${rela}@${rel}`;
      let q = qualified.get(code);
      if (q === undefined) {
        // (a member of one REL's union only: no filter names it, cs-rxnorm.js knows no such name)
        q = b.property({ code, uri: `${RXNORM}/${rela}`, shape: 'link', display: `${rela} (REL ${rel})`, wildcard: false, filterable: false });
        qualified.set(code, q);
      }
      b.link(relRows[k], q, relRows[k + 1]);
      stats.relQualifiedLinks = (stats.relQualifiedLinks || 0) + 1;
    }
    relRows.length = 0;
    for (const [rela, rels] of relsOf) {
      for (const rel of rels) b.propertyMember(relProp(rel), rels.size > 1 ? b.propertyId(`${rela}@${rel}`) : relaProp(rela));
    }
    stats.relQualifiedProperties = [...qualified.keys()].sort();
    // the names RXNREL has without concept-level RXNORM rows: catalog rows with no rows
    for (const rela of names.rela) relaProp(rela);
    for (const rel of names.rel) relProp(rel);
    return n;
  });

  await b.stage('ordering keys', async () => {
    const n = b.codes.length;
    const NONE = 1e6;
    const group = new Float64Array(n).fill(NONE);
    const ings = [];
    for (const [i, r] of rank) if (r <= 2) ings.push(i);
    ings.sort((x, y) => (b.codes[x].length - b.codes[y].length) || (b.codes[x] < b.codes[y] ? -1 : 1));
    ings.forEach((i, k) => { group[i] = k; });
    for (let round = 0; round < 20; round++) {
      let changed = 0;
      for (let k = 0; k < towards.length; k += 2) {
        const s = towards[k], t = towards[k + 1];
        if ((rank.get(s) ?? 99) <= 2) continue;
        if (group[t] < group[s]) { group[s] = group[t]; changed++; }
      }
      if (!changed) break;
    }
    for (let i = 0; i < n; i++) b.setSortKey(i, (rank.get(i) ?? TTY_RANK.length) * 2e6 + group[i]);
    towards.length = 0;
    return n;
  });

  return b.finish(stats);
}

class RxNormV2Module extends BaseTerminologyModule {
  getName() { return 'rxnorm-v2'; }
  getDescription() { return 'RxNorm RRF -> SQLite terminology file (sqlite-v2 provider)'; }
  getSupportedFormats() { return ['directory']; }

  registerCommands(cmd) {
    cmd.command('import')
      .description('Import an unzipped RxNorm full release (rrf folder) into a terminology file')
      .requiredOption('-s, --source <dir>', 'the rrf/ folder of the release')
      .requiredOption('-d, --dest <file>', 'destination .db')
      .requiredOption('-v, --rxnorm-version <MMDDYYYY>', 'e.g. 03022026')
      .option('--atom-relationships', 'also store RXNREL\'s atom-level rows, for REL / RELA = AUI:<rxaui> filters (otherwise refused)')
      .option('--overwrite', 'replace the destination')
      .action(async (o) => {
        const s = await importRxNormV2({ source: o.source, dest: o.dest, version: o.rxnormVersion,
          overwrite: !!o.overwrite, atomRelationships: !!o.atomRelationships, log: (m) => this.logInfo(m) });
        this.logSuccess(`${s.concepts.toLocaleString()} concepts -> ${o.dest}`);
      });
  }
}

module.exports = { RxNormV2Module, importRxNormV2 };
