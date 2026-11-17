'use strict';

// RxNorm RRF release -> sqlite-v2 (tx/importers/sqlite-v2/schema-v2.sql).
//
// Source-specific parsing only; the shared final stage (V2Builder.finish) numbers, rewrites,
// builds the sets and indexes. Semantics follow tx/cs/cs-rxnorm.js (what tx.fhir.org serves):
//   concepts      every RXCUI with an SAB=RXNORM atom in RXNCONSO; inactive ("obsolete") when
//                 its display atom (cs-rxnorm.js DISPLAY_RANK_SQL: lowest rank, non-SY) has
//                 SUPPRESS = O, else active. RXCUIs found only in RXNATOMARCHIVE (SAB=RXNORM) are
//                 inactive ("archived") and have no SUPPRESS literal, which is how the provider
//                 tells the two apart.
//   display       the lowest-ranked non-SY RXNORM atom (DISPLAY_RANK: PSN 1, ET 2, TMSY 3, any other
//                 TTY 0), the first in file order of that rank (archive: same rule), as cs-rxnorm.js
//                 #createConceptFromRows chooses it.
//   designations  every RXNORM atom's text, once (the first atom with it), use = TTY (system .../rxnorm), en-US, active (archived ones
//                 too: tx.fhir.org reports them so; the concept carries the inactive status).
//   properties    TTY (each TTY of the concept's RXNORM atoms), SAB (each source with an atom
//                 for the RXCUI), SUPPRESS (each flag of its RXNORM atoms), STY (RXNSTY TUI);
//                 one concept-valued property per RELA from RXNREL SAB=RXNORM CUI rows,
//                 source = RXCUI2, target = RXCUI1 (RRF states RELA as RXCUI2's relation to
//                 RXCUI1, e.g. SCD has_tradename SBD). REL filters map onto RELA sets via
//                 cs_config relaByRel.
//   no hierarchy  RxNorm is served without subsumption. Concepts are ordered by (primary TTY
//                 rank, ingredient group, code) so TTY sets are single runs and a drug's
//                 forms sit near its ingredient.

const fs = require('fs');
const path = require('path');
const { BaseTerminologyModule } = require('./tx-import-base');
const { V2Builder } = require('./sqlite-v2/builder');
const { lines } = require('./sqlite-v2/text');

const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm';
const TTY_RANK = ['IN', 'PIN', 'MIN', 'BN', 'DF', 'DFG', 'SCDC', 'SCDF', 'SCDFP', 'SCDG', 'SCDGP', 'SCD',
  'SBDC', 'SBDF', 'SBDFP', 'SBDG', 'SBD', 'GPCK', 'BPCK', 'PSN', 'SY', 'TMSY', 'ET'];
// relations followed from a drug towards its ingredient(s) for the ordering
// cs-rxnorm.js DISPLAY_RANK_SQL: the display atom is the lowest-ranked non-SY RXNORM atom
const DISPLAY_RANK = { PSN: 1, ET: 2, TMSY: 3, SY: 4 };
const TOWARDS_INGREDIENT = new Set(['has_ingredient', 'has_precise_ingredient', 'has_ingredients', 'tradename_of',
  'consists_of', 'isa', 'has_part', 'contains', 'form_of', 'quantified_form_of']);

async function* rrf(file) {
  for await (const l of lines(file)) if (l) yield l.split('|');
}

/** @param {object} cfg { source (rrf dir), dest, version (MMDDYYYY), overwrite, log } */
async function importRxNormV2(cfg) {
  const log = cfg.log || console.log;
  const f = (n) => path.join(cfg.source, n);
  for (const n of ['RXNCONSO.RRF', 'RXNREL.RRF', 'RXNSTY.RRF']) if (!fs.existsSync(f(n))) throw new Error(`missing ${f(n)}`);
  const b = new V2Builder(cfg.dest, { overwrite: cfg.overwrite, log, importer: 'rxnorm-v2' });
  for (const n of ['RXNCONSO.RRF', 'RXNREL.RRF', 'RXNSTY.RRF', 'RXNATOMARCHIVE.RRF']) if (fs.existsSync(f(n))) b.addSource(f(n));
  const v = cfg.version;
  b.setCodeSystem({ uri: RXNORM, version: v, name: 'RxNorm', title: 'RxNorm',
    releaseDate: /^\d{8}$/.test(v) ? `${v.slice(4)}-${v.slice(0, 2)}-${v.slice(2, 4)}` : null,
    description: 'RxNorm normalized drug nomenclature (U.S. National Library of Medicine)' });

  const lit = (code, display) => b.property({ code, uri: `${RXNORM}/${code}`, fhirType: 'code', valueKind: 'literal', display });
  const TTY = lit('TTY', 'Term Type'), SAB = lit('SAB', 'Source'), SUPPRESS = lit('SUPPRESS', 'Suppress flag'),
    STY = lit('STY', 'Semantic Type (TUI)');
  const use = (tty) => ({ system: RXNORM, code: tty || 'unknown', display: tty || null });
  const rank = new Map(); // concept index -> primary TTY rank
  const stats = { archivedConcepts: 0, relSkipped: 0, relaWithSeveralRel: [] };

  // RXNCONSO: RXCUI|LAT|TS|LUI|STT|SUI|ISPREF|RXAUI|SAUI|SCUI|SDUI|SAB|TTY|CODE|STR|SRL|SUPPRESS|CVF
  const sabs = [];
  await b.stage('parse RXNCONSO', async () => {
    let n = 0;
    const seen = new Map(); // index -> Set of TTY|SUPPRESS literals already written
    const shown = new Map(); // index -> [rank, SUPPRESS] of its display atom so far (cs-rxnorm.js)
    for await (const c of rrf(f('RXNCONSO.RRF'))) {
      const cui = c[0], sab = c[11], tty = c[12], str = c[14], sup = c[16];
      if (sab !== 'RXNORM') { sabs.push(cui, sab); continue; }
      const i = b.concept(cui);
      if (tty !== 'SY') {
        const cur = shown.get(i);
        if (!cur || (DISPLAY_RANK[tty] || 0) < cur[0]) b.setDisplay(i, str.trim());
      }
      let s = seen.get(i);
      if (!s) seen.set(i, s = new Set());
      // each text once, as cs-rxnorm.js lists a concept's names (the display, then the other texts)
      if (!s.has(`D${str.trim()}`)) { s.add(`D${str.trim()}`); b.designation(i, { language: 'en-US', use: use(tty), term: str.trim(), active: true }); }
      if (!s.has(`T${tty}`)) { s.add(`T${tty}`); b.literal(i, TTY, tty); }
      if (!s.has(`S${sup}`)) { s.add(`S${sup}`); b.literal(i, SUPPRESS, sup); }
      if (tty !== 'SY') {
        const dr = DISPLAY_RANK[tty] || 0, cur = shown.get(i);
        if (!cur || dr < cur[0]) shown.set(i, [dr, sup]);
      }
      const r = TTY_RANK.indexOf(tty);
      const rr = r < 0 ? TTY_RANK.length : r;
      if (!rank.has(i) || rr < rank.get(i)) rank.set(i, rr);
      n++;
    }
    // obsolete: the display atom is SUPPRESS = O (cs-rxnorm.js #isObsolete)
    stats.obsoleteConcepts = 0;
    for (const [i, [, sup]] of shown) if (sup === 'O') { b.setActive(i, false); stats.obsoleteConcepts++; }
    shown.clear();
    // SAB: every source with an atom for an RXNORM concept (RXNORM itself included)
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
      const archShown = new Map(); // index -> rank of its display atom so far
      const archTerms = new Map(); // index -> its texts so far
      let n = 0;
      for await (const c of rrf(f('RXNATOMARCHIVE.RRF'))) {
        const cui = c[12], sab = c[13], tty = c[14], str = c[2];
        if (sab !== 'RXNORM' || !cui) continue;
        const known = b.idx(cui);
        if (known !== undefined && known < live) continue; // still live: archive atoms are history
        const i = b.concept(cui, { active: false });
        if (tty !== 'SY') {
          const dr = DISPLAY_RANK[tty] || 0, cur = archShown.get(i);
          if (cur === undefined || dr < cur) { archShown.set(i, dr); b.setDisplay(i, str.trim()); }
        }
        const terms = archTerms.get(i) || archTerms.set(i, new Set()).get(i);
        if (!terms.has(str.trim())) { terms.add(str.trim()); b.designation(i, { language: 'en-US', use: use(tty), term: str.trim(), active: true }); }
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
  const relaByRel = {};
  const relOf = new Map();
  const relRows = []; // (source, target, RELA property, REL code) per link, for REL-qualified links
  const REL_CODES = [];
  const relCode = (rel) => { let i = REL_CODES.indexOf(rel); if (i < 0) { i = REL_CODES.length; REL_CODES.push(rel); } return i; };
  const towards = []; // (drug, ingredient-ward target) pairs for the ordering
  await b.stage('parse RXNREL', async () => {
    let n = 0;
    for await (const c of rrf(f('RXNREL.RRF'))) {
      if (c[10] !== 'RXNORM' || !c[0] || !c[4] || !c[7]) continue;
      const t = b.idx(c[0]), s = b.idx(c[4]);
      if (s === undefined || t === undefined) { stats.relSkipped++; continue; }
      const rela = c[7], rel = c[3];
      const p = b.property({ code: rela, uri: `${RXNORM}/${rela}`, fhirType: 'code', valueKind: 'concept', display: rela });
      b.link(s, p, t);
      let rels = relOf.get(rela);
      if (!rels) relOf.set(rela, rels = new Set());
      if (!rels.has(rel)) { rels.add(rel); (relaByRel[rel] = relaByRel[rel] || []).push(rela); }
      relRows.push(s, t, p, relCode(rel));
      if (TOWARDS_INGREDIENT.has(rela)) towards.push(s, t);
      n++;
    }
    // RELAs whose rows carry more than one REL (has_precise_ingredient and its inverse occur
    // under RN and RO): the RELA set alone would make a REL filter a superset. For those, the
    // links are also stored under a REL-qualified property `<RELA>@<REL>`, and relaByRel names
    // that property instead, so REL = X is exact.
    stats.relaWithSeveralRel = [...relOf].filter(([, r]) => r.size > 1).map(([a]) => a).sort();
    const several = new Map();
    for (const rela of stats.relaWithSeveralRel) several.set(b.property({ code: rela, fhirType: 'code', valueKind: 'concept' }), rela);
    const qualified = new Map();
    for (let k = 0; k < relRows.length; k += 4) {
      const rela = several.get(relRows[k + 2]);
      if (rela === undefined) continue;
      const rel = REL_CODES[relRows[k + 3]];
      const code = `${rela}@${rel}`;
      let q = qualified.get(code);
      if (q === undefined) {
        q = b.property({ code, uri: `${RXNORM}/${rela}`, fhirType: 'code', valueKind: 'concept', display: `${rela} (REL ${rel})` });
        qualified.set(code, q);
        const list = relaByRel[rel];
        const i = list.indexOf(rela);
        if (i >= 0) list.splice(i, 1);
        list.push(code);
      }
      b.link(relRows[k], q, relRows[k + 1]);
    }
    stats.relQualifiedProperties = [...qualified.keys()].sort();
    relRows.length = 0;
    return n;
  });

  // Ordering key: (primary TTY rank, ingredient group). Ingredient group = position (in code
  // order) of the smallest ingredient reachable over TOWARDS_INGREDIENT, found by fixpoint.
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

  b.setConfig('caseSensitive', 1);
  b.setConfig('defaultLanguage', 'en-US');
  b.setConfig('relaByRel', relaByRel);
  b.setConfig('filterValuePrefix', 'CUI:');
  b.setConfig('implicitValueSets', [{ pattern: `${RXNORM}/vs`, kind: 'all' }]);
  return b.finish(stats);
}

class RxNormV2Module extends BaseTerminologyModule {
  getName() { return 'rxnorm-v2'; }
  getDescription() { return 'RxNorm RRF -> SQLite (sqlite-v2 schema with stored Roaring sets)'; }
  getSupportedFormats() { return ['directory']; }

  registerCommands(cmd) {
    cmd.command('import')
      .description('Import an unzipped RxNorm full release (rrf folder) into a sqlite-v2 database')
      .requiredOption('-s, --source <dir>', 'the rrf/ folder of the release')
      .requiredOption('-d, --dest <file>', 'destination .db')
      .requiredOption('-v, --rxnorm-version <MMDDYYYY>', 'e.g. 03022026')
      .option('--overwrite', 'replace the destination')
      .action(async (o) => {
        const s = await importRxNormV2({ source: o.source, dest: o.dest, version: o.rxnormVersion,
          overwrite: !!o.overwrite, log: (m) => this.logInfo(m) });
        this.logSuccess(`${s.concepts.toLocaleString()} concepts -> ${o.dest}`);
      });
  }
}

module.exports = { RxNormV2Module, importRxNormV2 };
