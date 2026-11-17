'use strict';

// FHIRsmith classic LOINC db (import-loinc.module.js, served by tx/cs/cs-loinc.js) -> sqlite-v2
// ("reverse loader"). For releases we only have as a classic file (LOINC 2.77: loinc-2.77-a.db).
//
// Source-specific decoding only; numbering, sets, indexes and provenance are the shared final
// stage (V2Builder.finish), with the property definitions and cs_config of the CSV importer
// (import-loinc-v2.module.js), so a reverse-loaded file serves like one built from the release.
// What is read, and how it maps:
//   Codes          concepts. Type 1 term, 2 part, 3 answer list, 4 answer; a Type 2 code with
//                  RelationshipKey 0 and no status is a ComponentHierarchyBySystem-only node.
//                  display = Description; inactive iff StatusKey is DISCOURAGED (cs-loinc.js
//                  isInactive); STATUS literal iff StatusKey != 0 (what cs-loinc.js reports).
//                  The blank code '' (older classic files made one Answer '' shared by the
//                  externally defined answer lists) is dropped with its links, as the CSV
//                  importer does.
//   Properties     literal properties by PropertyTypes name; CLASSTYPE back from its description
//                  ('Laboratory class') to its code ('1'), as the CSV importer stores it.
//   Relationships  links by RelationshipTypes name: the part axes, CLASS, parent, Answer
//                  (list -> answer, in RelationshipKey order = AnswerList.csv order, which also
//                  gives each answer's sequence in its list), answers-for (list -> term). The
//                  inverses child and AnswerList are not stored (cs_config inverseProperties).
//   Closure        the explicit ancestor pairs (PATH_TO_ROOT closure, as the CSV importer).
//   Descriptions   designations, language from Languages, use from DescriptionTypes; preferred
//                  for the en-US LONG_COMMON_NAME (as the CSV importer).
//   ExternalCodes/ExternalMappings (when present)   external_map rows.
// Not in a classic file: answer SequenceNumber (the list order stands in for it), parts whose
// Part.csv status is NOTSTATED are indistinguishable from parts with no status (no STATUS
// literal either way, as cs-loinc.js reports them).

const fs = require('fs');
const Database = require('better-sqlite3');
const { BaseTerminologyModule } = require('./tx-import-base');
const { V2Builder } = require('./sqlite-v2/builder');
const { loincProperties, applyLoincConfig, loincWalk, KIND, LOINC } = require('./import-loinc-v2.module');

// classic stores CLASSTYPE as its description (cs_config propertyValueDescriptions); v2 the code
const CLASSTYPE_CODE = { 'Laboratory class': '1', 'Clinical class': '2', 'Claims attachment': '3', 'Surveys': '4' };
const SKIP_REL = new Set(['child', 'AnswerList', 'N/A']);
const TYPE_KIND = { 1: KIND.term, 2: KIND.part, 3: KIND.list, 4: KIND.answer };
const DISCOURAGED = 'DISCOURAGED';

/** @param {object} cfg { source (classic .db), dest, version (default: Config key 2), overwrite, log } */
async function importLoincV2FromClassic(cfg) {
  const log = cfg.log || console.log;
  if (!fs.existsSync(cfg.source)) throw new Error(`classic LOINC db not found: ${cfg.source}`);
  const src = new Database(cfg.source, { readonly: true, fileMustExist: true });
  try {
    const tables = new Set(src.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
    for (const t of ['Codes', 'Relationships', 'RelationshipTypes', 'Properties', 'PropertyTypes', 'PropertyValues',
      'Descriptions', 'DescriptionTypes', 'Languages', 'StatusCodes', 'Closure', 'Config']) {
      if (!tables.has(t)) throw new Error(`not a classic LOINC db (no ${t} table): ${cfg.source}`);
    }
    const conf = new Map(src.prepare('SELECT ConfigKey k, Value v FROM Config').all().map(r => [r.k, r.v]));
    const version = cfg.version || conf.get(2);
    if (!version) throw new Error('no version: pass one (the classic Config has no key 2)');
    if (cfg.version && conf.get(2) && cfg.version !== conf.get(2)) {
      throw new Error(`version ${cfg.version} given, but the classic db says ${conf.get(2)}`);
    }
    const lookup = (sql) => new Map(src.prepare(sql).all().map(r => [r.k, r.v]));
    const statusName = lookup('SELECT StatusKey k, Description v FROM StatusCodes');
    const relName = lookup('SELECT RelationshipTypeKey k, Description v FROM RelationshipTypes');
    const propName = lookup('SELECT PropertyTypeKey k, Description v FROM PropertyTypes');
    const descName = lookup('SELECT DescriptionTypeKey k, Description v FROM DescriptionTypes');
    const langCode = lookup('SELECT LanguageKey k, Code v FROM Languages');

    const b = new V2Builder(cfg.dest, { overwrite: cfg.overwrite, log, importer: 'loinc-v2-classic' });
    b.addSource(cfg.source);
    b.setCodeSystem({ uri: LOINC, version, name: 'LOINC',
      title: 'Logical Observation Identifier Names and Codes (LOINC)', description: `LOINC ${version} (FHIRsmith classic db)` });
    const { prop, parent, partProp, lit, answer, answersFor } = loincProperties(b);
    const stats = { blankCodesDropped: 0, linksToDropped: 0, unknownRelationshipTypes: {}, hierarchyNodes: 0, ancestorPairs: 0 };

    // classic CodeKey -> staging index (undefined: dropped)
    const idx = new Map();
    await b.stage('read Codes', async () => {
      let n = 0;
      for (const r of src.prepare('SELECT CodeKey, Code, Type, RelationshipKey, StatusKey, Description FROM Codes ORDER BY Type, CodeKey').iterate()) {
        const code = (r.Code || '').trim();
        if (!code) { stats.blankCodesDropped++; continue; }
        const node = r.Type === 2 && r.RelationshipKey === 0 && r.StatusKey === 0;
        if (node) stats.hierarchyNodes++;
        const st = r.StatusKey ? statusName.get(r.StatusKey) : null;
        const i = b.concept(code, { active: st !== DISCOURAGED, display: (r.Description || '').trim() || code,
          sortKey: node ? KIND.node : (TYPE_KIND[r.Type] ?? KIND.node) });
        idx.set(r.CodeKey, i);
        b.setSourceOrder(i, r.Type, r.CodeKey); // the classic file's own keys (cs-loinc.js's orders)
        if (st) b.literal(i, lit.STATUS, st);
        n++;
      }
      return n;
    });

    await b.stage('read Properties', async () => {
      let n = 0;
      const litProp = new Map();
      const litFor = (k) => {
        if (!litProp.has(k)) litProp.set(k, lit[propName.get(k)] ?? prop(propName.get(k) || `property-${k}`, 'literal'));
        return litProp.get(k);
      };
      for (const r of src.prepare(`SELECT p.CodeKey c, p.PropertyTypeKey t, v.Value v FROM Properties p
          JOIN PropertyValues v ON v.PropertyValueKey = p.PropertyValueKey ORDER BY p.PropertyKey`).iterate()) {
        const i = idx.get(r.c);
        if (i === undefined) { stats.linksToDropped++; continue; }
        const name = propName.get(r.t);
        const v = String(r.v).trim();
        b.literal(i, litFor(r.t), name === 'CLASSTYPE' ? (CLASSTYPE_CODE[v] ?? v) : v);
        n++;
      }
      return n;
    });

    const childLinks = new Map();
    await b.stage('read Relationships', async () => {
      let n = 0;
      // property per relationship type, defined on first use (the CSV importer defines no
      // property for axes LOINC does not link, e.g. adjustment, count)
      const relProp = new Map();
      const propFor = (k) => {
        if (!relProp.has(k)) {
          const name = relName.get(k);
          relProp.set(k, name === undefined || SKIP_REL.has(name) ? undefined
            : name === 'parent' ? parent : name === 'Answer' ? answer : name === 'answers-for' ? answersFor
              : (partProp[name] ?? prop(name, 'concept')));
        }
        return relProp.get(k);
      };
      const seq = new Map(); // list index -> answers so far
      const hierSeen = new Set();
      for (const r of src.prepare('SELECT RelationshipTypeKey t, SourceKey s, TargetKey g FROM Relationships ORDER BY RelationshipKey').iterate()) {
        if (relName.get(r.t) === 'child' && idx.has(r.s) && idx.has(r.g)) {
          // (the child links, in their rows' order: the whole-system walk below)
          let kids = childLinks.get(idx.get(r.s));
          if (!kids) childLinks.set(idx.get(r.s), kids = []);
          if (!kids.includes(idx.get(r.g))) kids.push(idx.get(r.g));
        }
        const rel = relName.get(r.t);
        if ((rel === 'parent' || rel === 'child') && idx.has(r.s) && idx.has(r.g)) {
          // a code's parent and child rows in RelationshipKey order: cs-loinc.js's $lookup order
          const key = rel + ':' + r.s + ':' + r.g;
          if (!hierSeen.has(key)) { hierSeen.add(key); b.hierarchyEntry(idx.get(r.s), idx.get(r.g), rel === 'child'); }
        }
        const p = propFor(r.t);
        if (p === undefined) {
          if (!relName.has(r.t)) stats.unknownRelationshipTypes[r.t] = (stats.unknownRelationshipTypes[r.t] || 0) + 1;
          continue;
        }
        const s = idx.get(r.s), t = idx.get(r.g);
        if (s === undefined || t === undefined) { stats.linksToDropped++; continue; }
        b.link(s, p, t);
        if (p === answer) {
          const k = (seq.get(s) || 0) + 1;
          seq.set(s, k);
          b.refsetDef(s, ['sequence'], ['i']);
          b.refsetMember(s, t, [k]);
        }
        n++;
      }
      return n;
    });

    await b.stage('read Closure', async () => {
      let n = 0;
      for (const r of src.prepare('SELECT AncestorKey a, DescendentKey d FROM Closure ORDER BY DescendentKey, AncestorKey').iterate()) {
        const a = idx.get(r.a), d = idx.get(r.d);
        if (a === undefined || d === undefined || a === d) continue;
        b.ancestor(d, a);
        n++;
      }
      stats.ancestorPairs = n;
      return n;
    });

    await b.stage('read Descriptions', async () => {
      let n = 0;
      for (const r of src.prepare('SELECT CodeKey c, LanguageKey l, DescriptionTypeKey t, Value v FROM Descriptions ORDER BY DescriptionKey').iterate()) {
        const i = idx.get(r.c);
        const term = (r.v || '').trim();
        if (i === undefined || !term) continue;
        const language = langCode.get(r.l) || null;
        const use = descName.get(r.t);
        b.designation(i, { language, use: use ? { system: LOINC, code: use, display: use } : null, term, active: true,
          preferred: use === 'LONG_COMMON_NAME' && language === 'en-US' });
        n++;
      }
      return n;
    });

    if (tables.has('ExternalMappings') && tables.has('ExternalCodes')) {
      await b.stage('read external maps', async () => {
        let n = 0;
        for (const r of src.prepare(`SELECT m.CodeKey c, e.System s, e.Version v, e.Code code, e.Display d, m.Equivalence q
            FROM ExternalMappings m JOIN ExternalCodes e ON e.ExternalCodeKey = m.ExternalCodeKey ORDER BY m.ExternalMappingKey`).iterate()) {
          const i = idx.get(r.c);
          if (i === undefined || !r.code || !r.s) continue;
          b.externalMap(i, { system: r.s, version: r.v || null, code: r.code, display: r.d || null, equivalence: r.q || 'equivalent' });
          n++;
        }
        return n;
      });
    }

    await b.stage('whole-system walk', async () => {
      const place = loincWalk(b.sourceOrder, childLinks);
      for (const [i, w] of place) b.setSourceWalk(i, w);
      return place.size;
    });

    applyLoincConfig(b);
    return b.finish(stats);
  } finally {
    src.close();
  }
}

class LoincV2ClassicModule extends BaseTerminologyModule {
  getName() { return 'loinc-v2-classic'; }
  getDescription() { return 'FHIRsmith classic LOINC db -> SQLite (sqlite-v2 schema with stored Roaring sets)'; }
  getSupportedFormats() { return ['sqlite']; }

  registerCommands(cmd) {
    cmd.command('import')
      .description('Convert a classic FHIRsmith LOINC .db into a sqlite-v2 database')
      .requiredOption('-s, --source <file>', 'classic LOINC .db (e.g. loinc-2.77-a.db)')
      .requiredOption('-d, --dest <file>', 'destination .db')
      .option('-v, --loinc-version <version>', 'checked against the classic Config (default: its version)')
      .option('--overwrite', 'replace the destination')
      .action(async (o) => {
        const s = await importLoincV2FromClassic({ source: o.source, dest: o.dest, version: o.loincVersion,
          overwrite: !!o.overwrite, log: (m) => this.logInfo(m) });
        this.logSuccess(`${s.concepts.toLocaleString()} concepts -> ${o.dest}`);
      });
  }
}

module.exports = { LoincV2ClassicModule, importLoincV2FromClassic };
