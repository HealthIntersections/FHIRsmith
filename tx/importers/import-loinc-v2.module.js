'use strict';

// LOINC CSV release -> sqlite-v2 (tx/importers/sqlite-v2/schema-v2.sql).
//
// Source-specific parsing only; the shared final stage (V2Builder.finish) numbers, rewrites,
// builds the sets and indexes. What is read (paths relative to the release root):
//   LoincTable/Loinc.csv          LOINC terms: display LONG_COMMON_NAME; inactive iff STATUS is
//                                 DISCOURAGED (as tx/cs/cs-loinc.js); literal properties; CLASS
//                                 link to the CLASS part; designations LONG_COMMON_NAME (preferred),
//                                 SHORTNAME, RELATEDNAMES2.
//   PartFile/Part.csv             parts: display PartName, DisplayName designation, STATUS.
//   PartFile/LoincPartLink_Primary.csv   COMPONENT, PROPERTY, ... links (term -> part).
//   ComponentHierarchyBySystem/ComponentHierarchyBySystem.csv
//                                 `parent` hierarchy links (child -> parent) and, from
//                                 PATH_TO_ROOT, the explicit ancestor pairs that define the
//                                 descendant sets. (2.83 ships this file instead of
//                                 MultiAxialHierarchy.csv.) The path closure is what tx.fhir.org
//                                 serves; the edge closure over-connects codes that appear under
//                                 several paths.
//   AnswerFile/AnswerList.csv     answer lists and answers; `Answer` links (list -> answer); the
//                                 list's members as a refset set; external answer codes.
//   AnswerFile/LoincAnswerListLink.csv   `answers-for` links (list -> term).
//   ConsumerName/ConsumerName.csv, LinguisticVariants/*LinguisticVariant.csv   designations; the
//                                 variants' axis columns give PartName designations on the parts.
//   PartFile/PartRelatedCodeMapping.csv,
//   LoincIeeeMedicalDeviceCodeMappingTable/*.csv   external_map rows.
// Not stored: the inverse properties `child` (of parent) and `AnswerList` (of Answer and
// answers-for); cs_config inverseProperties names them, their sets are the prop sets.

const fs = require('fs');
const path = require('path');
const { BaseTerminologyModule } = require('./tx-import-base');
const { V2Builder } = require('./sqlite-v2/builder');
const { csvObjects } = require('./sqlite-v2/text');

const LOINC = 'http://loinc.org';
const PROP = `${LOINC}/property`;

// LoincPartLink_Primary PartTypeName -> property code (tx.fhir.org's LOINC vocabulary).
const PART_LINK = {
  'COMPONENT': 'COMPONENT', 'PROPERTY': 'PROPERTY', 'TIME': 'TIME_ASPCT', 'SYSTEM': 'SYSTEM',
  'SCALE': 'SCALE_TYP', 'METHOD': 'METHOD_TYP',
  'Document.Kind': 'document-kind', 'Document.Role': 'document-role', 'Document.Setting': 'document-setting',
  'Document.SubjectMatterDomain': 'document-subject-matter-domain', 'Document.TypeOfService': 'document-type-of-service',
  'Rad.Anatomic Location.Imaging Focus': 'rad-anatomic-location-imaging-focus',
  'Rad.Anatomic Location.Laterality': 'rad-anatomic-location-laterality',
  'Rad.Anatomic Location.Laterality.Presence': 'rad-anatomic-location-laterality-presence',
  'Rad.Anatomic Location.Region Imaged': 'rad-anatomic-location-region-imaged',
  'Rad.Guidance for.Action': 'rad-guidance-for-action', 'Rad.Guidance for.Approach': 'rad-guidance-for-approach',
  'Rad.Guidance for.Object': 'rad-guidance-for-object', 'Rad.Guidance for.Presence': 'rad-guidance-for-presence',
  'Rad.Maneuver.Maneuver Type': 'rad-maneuver-maneuver-type',
  'Rad.Modality.Modality Subtype': 'rad-modality-modality-subtype', 'Rad.Modality.Modality Type': 'rad-modality-modality-type',
  'Rad.Pharmaceutical.Route': 'rad-pharmaceutical-route',
  'Rad.Pharmaceutical.Substance Given': 'rad-pharmaceutical-substance-given',
  'Rad.Reason for Exam': 'rad-reason-for-exam', 'Rad.Subject': 'rad-subject', 'Rad.Timing': 'rad-timing',
  'Rad.View.Aggregation': 'rad-view-aggregation', 'Rad.View.View Type': 'rad-view-view-type',
};

// The axis columns of a LinguisticVariant file, named as the term's links to its Parts are
const VARIANT_AXES = ['COMPONENT', 'PROPERTY', 'TIME_ASPCT', 'SYSTEM', 'SCALE_TYP', 'METHOD_TYP', 'CLASS'];

// Loinc.csv column -> literal property (all strings, as tx.fhir.org emits them).
const LITERALS = [
  ['CLASSTYPE', 'CLASSTYPE'], ['ORDER_OBS', 'ORDER_OBS'], ['EXAMPLE_UNITS', 'EXAMPLE_UNITS'],
  ['EXAMPLE_UCUM_UNITS', 'EXAMPLE_UCUM_UNITS'], ['PanelType', 'PanelType'], ['AskAtOrderEntry', 'AskAtOrderEntry'],
  ['UNITSREQUIRED', 'UNITSREQUIRED'], ['Copyright', 'EXTERNAL_COPYRIGHT_NOTICE'],
  ['ValidHL7AttachmentRequest', 'ValidHL7AttachmentRequest'], ['STATUS', 'STATUS'],
];

const STATUS = new Map([['NOTSTATED', 'NotStated'], ['ACTIVE', 'ACTIVE'], ['DEPRECATED', 'DEPRECATED'],
  ['TRIAL', 'TRIAL'], ['DISCOURAGED', 'DISCOURAGED'], ['EXAMPLE', 'EXAMPLE'], ['PREFERRED', 'PREFERRED'],
  ['PRIMARY', 'Primary'], ['DOCUMENTONTOLOGY', 'DocumentOntology'], ['RADIOLOGY', 'Radiology'], ['NORMATIVE', 'NORMATIVE']]);
const status = (s, dflt) => STATUS.get(String(s || '').trim().toUpperCase()) || dflt;

// Sort keys: siblings and roots are ordered by kind first, then code.
const KIND = { term: 0, part: 1, list: 2, answer: 3, node: 4 };

// The built-in importer's key order (import-loinc.module.js gives each code a CodeKey as it
// inserts it): Part.csv's parts, then Loinc.csv's terms, then AnswerList.csv's lists and answers
// as they first appear, then the ComponentHierarchyBySystem codes not seen yet. cs-loinc.js lists
// filter results by that key, and the whole system by type (its Codes.Type), then key. Kept in
// concept_order as (type, stage * ORDER_STAGE + row)
const ORDER_TYPE = { term: 1, part: 2, list: 3, answer: 4 };
const ORDER_STAGE = 1e7;
const ORDER = { parts: 0, terms: 1, answers: 2, hierarchy: 3, unkeyed: 4 };

/**
 * cs-loinc.js's whole-system order, which expand.js walks: every code by type, then key, each
 * followed (depth first) by the parts and terms below it, children in the order the importer
 * linked them (its Relationships rows), each code once. Only parts are walked into.
 * @param {Map<number, [number, number]>} order  index -> [type, key]
 * @param {Map<number, number[]>} children  part index -> child indexes, in link order
 * @returns {Map<number, number>} index -> place in the walk
 */
function loincWalk(order, children) {
  const roots = [...order.keys()].sort((a, b) => (order.get(a)[0] - order.get(b)[0]) || (order.get(a)[1] - order.get(b)[1]));
  const place = new Map();
  for (const r of roots) {
    const stack = [r];
    while (stack.length) {
      const i = stack.pop();
      if (place.has(i)) continue;
      place.set(i, place.size);
      const kids = order.get(i) && order.get(i)[0] === ORDER_TYPE.part ? children.get(i) : null;
      if (kids) for (let k = kids.length - 1; k >= 0; k--) if (!place.has(kids[k])) stack.push(kids[k]);
    }
  }
  return place;
}

// LOINC names some systems other than by their FHIR URI (as import-loinc.module.js).
const EXTERNAL_SYSTEMS = {
  'CMS/HCPCS': 'http://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets',
  'https://www.cdc.gov/phin': 'urn:oid:2.16.840.1.113883.6.238',
};
// IEEE equivalence is stated from the LOINC side; ConceptMap's from the target side.
const IEEE_EQUIVALENCE = { broader: 'narrower', narrower: 'wider', '': 'equivalent' };

function files(root) {
  const p = (...x) => path.join(root, ...x);
  const f = {
    loinc: p('LoincTable', 'Loinc.csv'),
    part: p('AccessoryFiles', 'PartFile', 'Part.csv'),
    partLink: p('AccessoryFiles', 'PartFile', 'LoincPartLink_Primary.csv'),
    hierarchy: p('AccessoryFiles', 'ComponentHierarchyBySystem', 'ComponentHierarchyBySystem.csv'),
    answerList: p('AccessoryFiles', 'AnswerFile', 'AnswerList.csv'),
    answerLink: p('AccessoryFiles', 'AnswerFile', 'LoincAnswerListLink.csv'),
    consumer: p('AccessoryFiles', 'ConsumerName', 'ConsumerName.csv'),
    partMap: p('AccessoryFiles', 'PartFile', 'PartRelatedCodeMapping.csv'),
    ieee: p('AccessoryFiles', 'LoincIeeeMedicalDeviceCodeMappingTable', 'LoincIeeeMedicalDeviceCodeMappingTable.csv'),
  };
  for (const k of ['loinc', 'part', 'partLink', 'hierarchy', 'answerList', 'answerLink', 'consumer']) {
    if (!fs.existsSync(f[k])) throw new Error(`required LOINC file missing: ${f[k]}`);
  }
  const lv = p('AccessoryFiles', 'LinguisticVariants');
  f.variants = fs.existsSync(lv) ? fs.readdirSync(lv).filter(n => /^[a-z]{2}[A-Z]{2}\d+LinguisticVariant\.csv$/.test(n)).sort().map(n => path.join(lv, n)) : [];
  return f;
}

/** The LOINC property definitions, in a fixed order (shared with import-loinc-v2-classic). */
function loincProperties(b) {
  const prop = (code, valueKind, isHierarchy = false) =>
    b.property({ code, uri: `${PROP}/${code}`, fhirType: valueKind === 'concept' ? 'code' : 'string', valueKind, isHierarchy, display: code });
  const parent = prop('parent', 'concept', true);
  const partProp = Object.fromEntries([...new Set(Object.values(PART_LINK)), 'CLASS'].map(c => [c, prop(c, 'concept')]));
  const lit = Object.fromEntries(LITERALS.map(([c]) => [c, prop(c, 'literal')]));
  const answer = prop('Answer', 'concept');
  const answersFor = prop('answers-for', 'concept');
  return { prop, parent, partProp, lit, answer, answersFor };
}

/** cs_config for LOINC (shared with import-loinc-v2-classic). */
function applyLoincConfig(b) {
  b.setConfig('caseSensitive', 1);
  b.setConfig('defaultLanguage', 'en-US');
  b.setConfig('hierarchyMeaning', 'is-a');
  b.setConfig('inverseProperties', { child: 'parent', AnswerList: ['Answer', 'answers-for'] });
  b.setConfig('propertyValueDescriptions', { CLASSTYPE: { 1: 'Laboratory class', 2: 'Clinical class', 3: 'Claims attachment', 4: 'Surveys' } });
  b.setConfig('designationsAsProperties', ['RELATEDNAMES2']);
  b.setConfig('implicitValueSets', [
    { pattern: `${LOINC}/vs`, kind: 'all' },
    { pattern: `${LOINC}/vs/{code}`, kind: 'refset' },
    { pattern: `${LOINC}/vs?fhir_vs=isa/{code}`, kind: 'isa' },
  ]);
}

/** @param {object} cfg { source, dest, version, overwrite, log } */
async function importLoincV2(cfg) {
  const log = cfg.log || console.log;
  const f = files(cfg.source);
  const b = new V2Builder(cfg.dest, { overwrite: cfg.overwrite, log, importer: 'loinc-v2' });
  for (const p of [f.loinc, f.part, f.partLink, f.hierarchy, f.answerList, f.answerLink, f.consumer, f.partMap, f.ieee, ...f.variants]) {
    if (fs.existsSync(p)) b.addSource(p);
  }
  b.setCodeSystem({ uri: LOINC, version: cfg.version, name: 'LOINC',
    title: 'Logical Observation Identifier Names and Codes (LOINC)', description: `LOINC ${cfg.version} (CSV release)` });

  const { parent, partProp, lit, answer, answersFor } = loincProperties(b);
  const use = (code) => ({ system: LOINC, code, display: code });
  // Designations stay active when the term is DISCOURAGED (as tx.fhir.org reports them).
  const desig = (i, language, code, term, preferred = false) =>
    term && b.designation(i, { language, use: use(code), term: term.trim(), active: true, preferred });
  const stats = { classLinksMissing: 0, partLinksSkipped: 0, hierarchyNodes: 0, ancestorPairs: 0 };

  // term -> { axis: part } for the axes a LinguisticVariant file translates (PartName below)
  const axisParts = new Map();
  const noteAxisPart = (term, axis, part) => {
    let a = axisParts.get(term);
    if (!a) axisParts.set(term, a = {});
    a[axis] = part;
  };

  // Concepts: terms, parts, answer lists, answers, then hierarchy-only nodes.
  const terms = [];
  let termRow = 0;
  await b.stage('parse Loinc.csv', async () => {
    for await (const r of csvObjects(f.loinc)) {
      const code = r.LOINC_NUM.trim();
      if (!code) continue;
      const st = status(r.STATUS, 'ACTIVE');
      const i = b.concept(code, { active: st !== 'DISCOURAGED', display: r.LONG_COMMON_NAME.trim() || code, sortKey: KIND.term });
      b.setSourceOrder(i, ORDER_TYPE.term, ORDER.terms * ORDER_STAGE + (++termRow));
      for (const [p, col] of LITERALS) b.literal(i, lit[p], p === 'STATUS' ? st : r[col].trim());
      desig(i, 'en-US', 'LONG_COMMON_NAME', r.LONG_COMMON_NAME, true);
      desig(i, 'en-US', 'SHORTNAME', r.SHORTNAME);
      desig(i, 'en-US', 'RELATEDNAMES2', r.RELATEDNAMES2);
      if (r.CLASS.trim()) terms.push(i, r.CLASS.trim().toUpperCase());
    }
    return terms.length;
  });

  const classPart = new Map();
  await b.stage('parse Part.csv', async () => {
    let n = 0;
    for await (const r of csvObjects(f.part)) {
      const code = r.PartNumber.trim();
      if (!code) continue;
      const st = status(r.Status, null);
      const active = st !== 'DISCOURAGED';
      const i = b.concept(code, { active, display: r.PartName.trim() || code, sortKey: KIND.part });
      b.setSourceOrder(i, ORDER_TYPE.part, ORDER.parts * ORDER_STAGE + n + 1);
      if (r.PartTypeName.trim() === 'CLASS' && r.PartName.trim()) classPart.set(r.PartName.trim().toUpperCase(), i);
      desig(i, 'en-US', 'DisplayName', r.PartDisplayName);
      if (st) b.literal(i, lit.STATUS, st);
      n++;
    }
    for (let k = 0; k < terms.length; k += 2) {
      const c = classPart.get(terms[k + 1]);
      if (c === undefined) stats.classLinksMissing++; else { b.link(terms[k], partProp.CLASS, c); noteAxisPart(terms[k], 'CLASS', c); }
    }
    terms.length = 0;
    return n;
  });

  await b.stage('parse AnswerList.csv', async () => {
    let n = 0;
    let row = 0;
    let currentList = ''; // (the built-in importer gives a list a key at each run of its rows)
    for await (const r of csvObjects(f.answerList)) {
      const listCode = r.AnswerListId.trim(), answerCode = r.AnswerStringId.trim();
      const newRun = listCode !== currentList;
      currentList = listCode;
      if (!listCode) continue;
      const list = b.concept(listCode, { display: r.AnswerListName.trim() || listCode, sortKey: KIND.list });
      if (newRun) b.setSourceOrder(list, ORDER_TYPE.list, ORDER.answers * ORDER_STAGE + (++row));
      if (!answerCode) continue;
      const known = b.idx(answerCode) !== undefined;
      const a = b.concept(answerCode, { display: r.DisplayText.trim() || answerCode, sortKey: KIND.answer });
      if (!b.hasSourceOrder(a)) b.setSourceOrder(a, ORDER_TYPE.answer, ORDER.answers * ORDER_STAGE + (++row));
      b.link(list, answer, a);
      // the answer's position in the list: lists are ordered (ordinal scales, questionnaires)
      b.refsetDef(list, ['sequence'], ['i']);
      const seq = Number.parseInt(r.SequenceNumber, 10);
      b.refsetMember(list, a, Number.isFinite(seq) ? [seq] : null);
      if (!known && r.ExtCodeId.trim() && r.ExtCodeSystem.trim()) {
        b.externalMap(a, { system: EXTERNAL_SYSTEMS[r.ExtCodeSystem.trim()] || r.ExtCodeSystem.trim(),
          version: r.ExtCodeSystemVersion.trim() || null, code: r.ExtCodeId.trim(), display: r.ExtCodeDisplayName.trim() || null });
      }
      n++;
    }
    return n;
  });

  await b.stage('parse LoincAnswerListLink.csv', async () => {
    let n = 0;
    for await (const r of csvObjects(f.answerLink)) {
      const t = b.idx(r.LoincNumber.trim()), l = b.idx(r.AnswerListId.trim());
      if (t === undefined || l === undefined) continue;
      b.link(l, answersFor, t);
      n++;
    }
    return n;
  });

  await b.stage('parse LoincPartLink_Primary.csv', async () => {
    let n = 0;
    for await (const r of csvObjects(f.partLink)) {
      const p = PART_LINK[r.PartTypeName.trim()];
      const s = b.idx(r.LoincNumber.trim()), t = b.idx(r.PartNumber.trim());
      if (!p || s === undefined || t === undefined) { stats.partLinksSkipped++; continue; }
      b.link(s, partProp[p], t);
      if (VARIANT_AXES.includes(p)) noteAxisPart(s, p, t);
      n++;
    }
    return n;
  });

  // A node can be named as a parent before its own row: placeholder display until then.
  const placeholder = new Set();
  // the built-in importer's child links (for the walk): a row's link only when its parent
  // already has a key, each (parent, child) once, in row order
  const childLinks = new Map();
  const hierPairs = new Set();
  const node = (code) => {
    const before = b.codes.length;
    const i = b.concept(code, { display: code, sortKey: KIND.node });
    if (b.codes.length > before) { placeholder.add(i); stats.hierarchyNodes++; }
    return i;
  };
  await b.stage('parse ComponentHierarchyBySystem.csv', async () => {
    let n = 0;
    for await (const r of csvObjects(f.hierarchy)) {
      const code = r.CODE.trim();
      if (!code) continue;
      const before = b.codes.length;
      const c = b.concept(code, { display: r.CODE_TEXT.trim() || code, sortKey: KIND.node });
      if (!b.hasSourceOrder(c)) b.setSourceOrder(c, ORDER_TYPE.part, ORDER.hierarchy * ORDER_STAGE + n + 1);
      if (b.codes.length > before) stats.hierarchyNodes++;
      else if (placeholder.delete(c)) b.setDisplay(c, r.CODE_TEXT.trim() || code);
      const parentCode = r.IMMEDIATE_PARENT.trim();
      if (parentCode && b.idx(parentCode) !== undefined && b.hasSourceOrder(b.idx(parentCode))) {
        const p = b.idx(parentCode);
        let kids = childLinks.get(p);
        if (!kids) childLinks.set(p, kids = []);
        if (!kids.includes(c)) kids.push(c);
        // the built-in importer's Relationships rows for this row: the code's parent, then the
        // parent's child, each pair once (its $lookup lists them in that order)
        const pair = c + ':' + p;
        if (!hierPairs.has(pair)) {
          hierPairs.add(pair);
          b.hierarchyEntry(c, p, false);
          b.hierarchyEntry(p, c, true);
        }
      }
      if (parentCode && parentCode !== code) {
        const p = node(parentCode);
        b.link(c, parent, p);
      }
      for (const a of r.PATH_TO_ROOT.split('.')) {
        const ac = a.trim();
        if (!ac || ac === code) continue;
        b.ancestor(c, node(ac));
        stats.ancestorPairs++;
      }
      n++;
    }
    return n;
  });

  await b.stage('parse designations', async () => {
    let n = 0;
    const partNamesSeen = new Set();
    for await (const r of csvObjects(f.consumer)) {
      const i = b.idx(r.LoincNumber.trim());
      if (i !== undefined && r.ConsumerName.trim()) { desig(i, 'en-US', 'ConsumerName', r.ConsumerName); n++; }
    }
    for (const file of f.variants) {
      const m = /^([a-z]{2})([A-Z]{2})/.exec(path.basename(file));
      const lang = `${m[1]}-${m[2]}`;
      for await (const r of csvObjects(file)) {
        const i = b.idx(r.LOINC_NUM.trim());
        if (i === undefined) continue;
        desig(i, lang, 'LONG_COMMON_NAME', r.LONG_COMMON_NAME);
        desig(i, lang, 'SHORTNAME', r.SHORTNAME);
        desig(i, lang, 'LinguisticVariantDisplayName', r.LinguisticVariantDisplayName);
        desig(i, lang, 'RELATEDNAMES2', r.RELATEDNAMES2);
        // The axis columns (COMPONENT ... CLASS) translate the term's Parts: each becomes a
        // PartName designation on the Part the term links to for that axis - for some languages
        // (ko-KR, most of fr-CA) the only translations LOINC has. Each distinct name once (as
        // import-loinc.module.js)
        const axes = axisParts.get(i);
        if (axes) {
          for (const axis of VARIANT_AXES) {
            const value = r[axis] ? r[axis].trim() : '';
            const part = axes[axis];
            if (!value || part === undefined) continue;
            const key = part + '|' + lang + '|' + value;
            if (partNamesSeen.has(key)) continue;
            partNamesSeen.add(key);
            desig(part, lang, 'PartName', value);
          }
        }
        n++;
      }
    }
    return n;
  });

  await b.stage('parse external maps', async () => {
    let n = 0;
    if (fs.existsSync(f.partMap)) {
      for await (const r of csvObjects(f.partMap)) {
        const i = b.idx(r.PartNumber.trim());
        const system = r.ExtCodeSystem.trim();
        // RadLex mappings are not code-to-code maps (as import-loinc.module.js)
        if (i === undefined || !r.ExtCodeId.trim() || !system || system === 'http://www.radlex.org') continue;
        b.externalMap(i, { system: EXTERNAL_SYSTEMS[system] || system, version: r.ExtCodeSystemVersion.trim() || null,
          code: r.ExtCodeId.trim(), display: r.ExtCodeDisplayName.trim() || null, equivalence: r.Equivalence.trim() || 'equivalent' });
        n++;
      }
    }
    if (fs.existsSync(f.ieee)) {
      for await (const r of csvObjects(f.ieee)) {
        const i = b.idx(r.LOINC_NUM.trim());
        if (i === undefined || !r.IEEE_CF_CODE10.trim()) continue;
        const eq = r.EQUIVALENCE.trim();
        b.externalMap(i, { system: 'urn:iso:std:iso:11073:10101', code: r.IEEE_CF_CODE10.trim(),
          display: r.IEEE_REFID.trim() || null, equivalence: IEEE_EQUIVALENCE[eq] || eq });
        n++;
      }
    }
    return n;
  });

  // codes the built-in importer gives no key (a hierarchy parent with no row of its own): last
  stats.unkeyed = 0;
  for (let i = 0; i < b.codes.length; i++) {
    if (!b.hasSourceOrder(i)) b.setSourceOrder(i, ORDER_TYPE.part, ORDER.unkeyed * ORDER_STAGE + (++stats.unkeyed));
  }
  await b.stage('whole-system walk', async () => {
    const place = loincWalk(b.sourceOrder, childLinks);
    for (const [i, w] of place) b.setSourceWalk(i, w);
    return place.size;
  });

  applyLoincConfig(b);
  return b.finish(stats);
}

class LoincV2Module extends BaseTerminologyModule {
  getName() { return 'loinc-v2'; }
  getDescription() { return 'LOINC CSV release -> SQLite (sqlite-v2 schema with stored Roaring sets)'; }
  getSupportedFormats() { return ['directory']; }

  registerCommands(cmd) {
    cmd.command('import')
      .description('Import an unzipped LOINC release into a sqlite-v2 database')
      .requiredOption('-s, --source <dir>', 'release root (contains LoincTable/ and AccessoryFiles/)')
      .requiredOption('-d, --dest <file>', 'destination .db')
      .requiredOption('-v, --loinc-version <version>', 'e.g. 2.83')
      .option('--overwrite', 'replace the destination')
      .action(async (o) => {
        const s = await importLoincV2({ source: o.source, dest: o.dest, version: o.loincVersion,
          overwrite: !!o.overwrite, log: (m) => this.logInfo(m) });
        this.logSuccess(`${s.concepts.toLocaleString()} concepts -> ${o.dest}`);
      });
  }
}

module.exports = { LoincV2Module, importLoincV2, loincProperties, applyLoincConfig, loincWalk, STATUS, KIND, LITERALS, LOINC };
