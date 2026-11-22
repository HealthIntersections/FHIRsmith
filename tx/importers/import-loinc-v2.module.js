'use strict';

// LOINC CSV release -> a terminology file (tx/importers/sqlite-v2/schema.sql). The files read
// (paths relative to the release root): LoincTable/Loinc.csv, AccessoryFiles/PartFile/{Part,
// LoincPartLink_Primary,PartRelatedCodeMapping}.csv, ComponentHierarchyBySystem/
// ComponentHierarchyBySystem.csv, AnswerFile/{AnswerList,LoincAnswerListLink}.csv,
// ConsumerName/ConsumerName.csv, LinguisticVariants/*LinguisticVariant.csv and the IEEE device
// code table. Where each fact goes:
//   concept      terms, parts, answer lists, answers, hierarchy-only nodes; display; inactive iff
//                STATUS is DISCOURAGED; sort keys by kind (the builder's numbering)
//   item         every designation (LONG_COMMON_NAME preferred, SHORTNAME, RELATEDNAMES2, the part's
//                DisplayName, ConsumerName, the linguistic variants and their PartName translations)
//   link         part links (LoincPartLink_Primary, seq = its row), CLASS (Loinc.csv, seq = the term's
//                row), parent (ComponentHierarchyBySystem, seq = the first row of the pair: the
//                hierarchy order upstream lists parents and children in, see below), Answer (list ->
//                answer, seq = the answer's SequenceNumber in the list: answer lists are ordered),
//                answers-for (list -> term, seq = its LoincAnswerListLink row), ancestor (PATH_TO_ROOT
//                pairs, descendant -> ancestor; the closure of `parent`, catalog closure_from)
//   literal      the Loinc.csv properties and the part's STATUS
//   value_label  CLASSTYPE 1-4 names
//   mapping      PartRelatedCodeMapping, the IEEE device code table, answers' external codes
//   catalog      loincCatalog: the link and literal properties, then `child` (inverse_of parent),
//                `Answer|answers-for` (a union, filterable 0), `AnswerList` (inverse_of that union) and
//                `ancestor` (the closure source, filterable through the hierarchy's sets only)
//   ix_order     derived-by-importer: rank / ids (upstream's code key order: Part.csv's parts,
//                Loinc.csv's terms, AnswerList.csv's lists and answers as they first appear, then
//                hierarchy-only codes) and walk (the whole system in upstream's walk of that order).
//                They are the upstream importer's numbering, not a release fact, and need its file
//                sequence to compute: the importer writes them. hier_start / hier (upstream's
//                parent / child entry order) only when the parent links' seq does not reproduce it.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { TerminologyBuilder, vacuumFile, analyze } = require('./sqlite-v2/builder');
const { writeOrderArray, writeActiveOrder } = require('./sqlite-v2/indexes');
const { csvObjects } = require('./sqlite-v2/text');
const { hierarchyArrays } = require('../sqlite-v2/orders');
const { BaseTerminologyModule } = require('./tx-import-base');

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
// as (type, stage * ORDER_STAGE + row): the ix_order rank / ids the importer writes (writeOrders)
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


const CLASSTYPE = { 1: 'Laboratory class', 2: 'Clinical class', 3: 'Claims attachment', 4: 'Surveys' };

/**
 * The LOINC catalog (shared with the classic-db importer): the hierarchy, the part axes and CLASS,
 * the Loinc.csv literals, Answer (ordered: link.seq is the answer's place in its list) and
 * answers-for; the inverse rows cs-loinc.js names (`child` of parent; `AnswerList` of the union of
 * Answer and answers-for, which no filter names); `ancestor`, the PATH_TO_ROOT pairs the
 * hierarchy's descendants come from (closure_from); the CLASSTYPE value labels.
 */
function loincCatalog(b) {
  const link = (code, extra = {}) => b.property({ code, uri: `${PROP}/${code}`, shape: 'link', display: code, ...extra });
  const parent = link('parent', { subsumption: true });
  const partProp = Object.fromEntries([...new Set(Object.values(PART_LINK)), 'CLASS'].map((c) => [c, link(c)]));
  const lit = Object.fromEntries(LITERALS.map(([c]) => [c, b.property({ code: c, uri: `${PROP}/${c}`, shape: 'literal', fhirType: 'string', display: c })]));
  const answer = link('Answer', { ordered: true });
  const answersFor = link('answers-for');
  b.property({ code: 'child', uri: `${PROP}/child`, shape: 'link', display: 'child', inverseOf: parent });
  const listLinks = b.property({ code: 'Answer|answers-for', shape: 'union', display: 'Answer and answers-for', filterable: false });
  b.propertyMember(listLinks, answer);
  b.propertyMember(listLinks, answersFor);
  b.property({ code: 'AnswerList', uri: `${PROP}/AnswerList`, shape: 'link', display: 'AnswerList', inverseOf: listLinks });
  const ancestor = b.property({ code: 'ancestor', uri: `${PROP}/ancestor`, shape: 'link', display: 'ancestor (PATH_TO_ROOT)' });
  b.setClosureFrom(parent, ancestor);
  for (const [v, d] of Object.entries(CLASSTYPE)) b.valueLabel(lit.CLASSTYPE, String(v), d);
  return { link, parent, partProp, lit, answer, answersFor, ancestor };
}

/** the code system row of a LOINC file */
function loincCodeSystem(b, version, description) {
  b.codeSystem({ uri: LOINC, version, name: 'LOINC', title: 'Logical Observation Identifier Names and Codes (LOINC)',
    description, caseSensitive: true, hierarchyMeaning: 'is-a', defaultLanguage: 'en-US' });
  // as cs-loinc.js presents it: the stored order (main's key order and walk), $lookup's name the
  // title, the description the name, versions compared naturally
  b.setBehaviour('expansionOrder', 'stored');
  b.setBehaviour('lookupName', 'title');
  b.setBehaviour('description', 'name');
  b.setBehaviour('versionAlgorithm', 'natural');
}

/** @param {object} cfg { source, dest, version, overwrite, log, hierarchyArrays: 'auto' | 'always' | 'never' } */
async function importLoincV2(cfg) {
  const log = cfg.log || console.log;
  const f = files(cfg.source);
  const b = new TerminologyBuilder(cfg.dest, { overwrite: cfg.overwrite, log, importer: 'loinc-v2' });
  for (const p of [f.loinc, f.part, f.partLink, f.hierarchy, f.answerList, f.answerLink, f.consumer, f.partMap, f.ieee, ...f.variants]) {
    if (fs.existsSync(p)) b.addSource(p);
  }
  loincCodeSystem(b, cfg.version, `LOINC ${cfg.version} (CSV release)`);
  const { parent, partProp, lit, answer, answersFor, ancestor } = loincCatalog(b);

  const use = (code) => ({ system: LOINC, code, display: code });
  // Designations stay active when the term is DISCOURAGED (as tx.fhir.org reports them).
  const desig = (i, language, code, term, preferred = false) =>
    term && b.item(i, { language, use: use(code), text: term.trim(), active: true, preferred });
  const stats = { classLinksMissing: 0, partLinksSkipped: 0, hierarchyNodes: 0, ancestorPairs: 0 };

  // upstream's code key order and walk, by concept handle
  const sourceOrder = new Map();
  const setOrder = (i, type, seq) => sourceOrder.set(i, [type, seq]);

  const axisParts = new Map();
  const noteAxisPart = (term, axis, part) => {
    let a = axisParts.get(term);
    if (!a) axisParts.set(term, a = {});
    a[axis] = part;
  };

  const terms = [];
  let termRow = 0;
  await b.stage('parse Loinc.csv', async () => {
    for await (const r of csvObjects(f.loinc)) {
      const code = r.LOINC_NUM.trim();
      if (!code) continue;
      const st = status(r.STATUS, 'ACTIVE');
      const i = b.concept(code, { active: st !== 'DISCOURAGED', display: r.LONG_COMMON_NAME.trim() || code, sortKey: KIND.term });
      setOrder(i, ORDER_TYPE.term, ORDER.terms * ORDER_STAGE + (++termRow));
      for (const [p, col] of LITERALS) b.literal(i, lit[p], p === 'STATUS' ? st : r[col].trim());
      desig(i, 'en-US', 'LONG_COMMON_NAME', r.LONG_COMMON_NAME, true);
      desig(i, 'en-US', 'SHORTNAME', r.SHORTNAME);
      desig(i, 'en-US', 'RELATEDNAMES2', r.RELATEDNAMES2);
      if (r.CLASS.trim()) terms.push(i, r.CLASS.trim().toUpperCase(), termRow);
    }
    return termRow;
  });

  const classPart = new Map();
  await b.stage('parse Part.csv', async () => {
    let n = 0;
    for await (const r of csvObjects(f.part)) {
      const code = r.PartNumber.trim();
      if (!code) continue;
      const st = status(r.Status, null);
      const i = b.concept(code, { active: st !== 'DISCOURAGED', display: r.PartName.trim() || code, sortKey: KIND.part });
      setOrder(i, ORDER_TYPE.part, ORDER.parts * ORDER_STAGE + n + 1);
      if (r.PartTypeName.trim() === 'CLASS' && r.PartName.trim()) classPart.set(r.PartName.trim().toUpperCase(), i);
      desig(i, 'en-US', 'DisplayName', r.PartDisplayName);
      if (st) b.literal(i, lit.STATUS, st);
      n++;
    }
    for (let k = 0; k < terms.length; k += 3) {
      const c = classPart.get(terms[k + 1]);
      if (c === undefined) stats.classLinksMissing++;
      else { b.link(terms[k], partProp.CLASS, c, { seq: terms[k + 2] }); noteAxisPart(terms[k], 'CLASS', c); }
    }
    terms.length = 0;
    return n;
  });

  await b.stage('parse AnswerList.csv', async () => {
    let n = 0, row = 0, currentList = '';
    for await (const r of csvObjects(f.answerList)) {
      const listCode = r.AnswerListId.trim(), answerCode = r.AnswerStringId.trim();
      const newRun = listCode !== currentList;
      currentList = listCode;
      if (!listCode) continue;
      const list = b.concept(listCode, { display: r.AnswerListName.trim() || listCode, sortKey: KIND.list });
      if (newRun) setOrder(list, ORDER_TYPE.list, ORDER.answers * ORDER_STAGE + (++row));
      if (!answerCode) continue;
      const known = b.idx(answerCode) !== undefined;
      const a = b.concept(answerCode, { display: r.DisplayText.trim() || answerCode, sortKey: KIND.answer });
      if (!sourceOrder.has(a)) setOrder(a, ORDER_TYPE.answer, ORDER.answers * ORDER_STAGE + (++row));
      // the answer's position in the list (lists are ordered: ordinal scales, questionnaires)
      const seq = Number.parseInt(r.SequenceNumber, 10);
      b.link(list, answer, a, { seq: Number.isFinite(seq) ? seq : null });
      if (!known && r.ExtCodeId.trim() && r.ExtCodeSystem.trim()) {
        b.mapping(a, { system: EXTERNAL_SYSTEMS[r.ExtCodeSystem.trim()] || r.ExtCodeSystem.trim(), version: r.ExtCodeSystemVersion.trim() || null,
          code: r.ExtCodeId.trim(), display: r.ExtCodeDisplayName.trim() || null, relationship: 'equivalent' });
      }
      n++;
    }
    return n;
  });

  await b.stage('parse LoincAnswerListLink.csv', async () => {
    let n = 0, row = 0;
    for await (const r of csvObjects(f.answerLink)) {
      row++;
      const t = b.idx(r.LoincNumber.trim()), l = b.idx(r.AnswerListId.trim());
      if (t === undefined || l === undefined) continue;
      b.link(l, answersFor, t, { seq: row });
      n++;
    }
    return n;
  });

  await b.stage('parse LoincPartLink_Primary.csv', async () => {
    let n = 0, row = 0;
    for await (const r of csvObjects(f.partLink)) {
      row++;
      const p = PART_LINK[r.PartTypeName.trim()];
      const s = b.idx(r.LoincNumber.trim()), t = b.idx(r.PartNumber.trim());
      if (!p || s === undefined || t === undefined) { stats.partLinksSkipped++; continue; }
      b.link(s, partProp[p], t, { seq: row });
      if (VARIANT_AXES.includes(p)) noteAxisPart(s, p, t);
      n++;
    }
    return n;
  });

  const placeholder = new Set();
  const childLinks = new Map();   // upstream's child links (for the walk)
  const hierPairs = new Set();
  const hier = { xs: [], others: [], child: [] };   // upstream's entries, in order (v2 hierarchyEntry)
  const node = (code) => {
    const before = b.codes.length;
    const i = b.concept(code, { display: code, sortKey: KIND.node });
    if (b.codes.length > before) { placeholder.add(i); stats.hierarchyNodes++; }
    return i;
  };
  const parentLinks = [];         // [child, parent, first row] of each parent link, for the order check
  const parentSeen = new Set();
  await b.stage('parse ComponentHierarchyBySystem.csv', async () => {
    let n = 0;
    for await (const r of csvObjects(f.hierarchy)) {
      const code = r.CODE.trim();
      if (!code) continue;
      const before = b.codes.length;
      const c = b.concept(code, { display: r.CODE_TEXT.trim() || code, sortKey: KIND.node });
      if (!sourceOrder.has(c)) setOrder(c, ORDER_TYPE.part, ORDER.hierarchy * ORDER_STAGE + n + 1);
      if (b.codes.length > before) stats.hierarchyNodes++;
      else if (placeholder.delete(c)) b.setDisplay(c, r.CODE_TEXT.trim() || code);
      const parentCode = r.IMMEDIATE_PARENT.trim();
      if (parentCode && b.idx(parentCode) !== undefined && sourceOrder.has(b.idx(parentCode))) {
        const p = b.idx(parentCode);
        let kids = childLinks.get(p);
        if (!kids) childLinks.set(p, kids = []);
        if (!kids.includes(c)) kids.push(c);
        const pair = c + ':' + p;
        if (!hierPairs.has(pair)) {
          hierPairs.add(pair);
          hier.xs.push(c, p); hier.others.push(p, c); hier.child.push(0, 1);
        }
      }
      if (parentCode && parentCode !== code) {
        const p = node(parentCode);
        // seq: the hierarchy row (the builder keeps a pair's first)
        b.link(c, parent, p, { seq: n + 1 });
        const k = c + ':' + p;
        if (!parentSeen.has(k)) { parentSeen.add(k); parentLinks.push(c, p, n + 1); }
      }
      for (const a of r.PATH_TO_ROOT.split('.')) {
        const ac = a.trim();
        if (!ac || ac === code) continue;
        b.link(c, ancestor, node(ac));
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
        if (i === undefined || !r.ExtCodeId.trim() || !system || system === 'http://www.radlex.org') continue;
        b.mapping(i, { system: EXTERNAL_SYSTEMS[system] || system, version: r.ExtCodeSystemVersion.trim() || null,
          code: r.ExtCodeId.trim(), display: r.ExtCodeDisplayName.trim() || null, relationship: r.Equivalence.trim() || 'equivalent' });
        n++;
      }
    }
    if (fs.existsSync(f.ieee)) {
      for await (const r of csvObjects(f.ieee)) {
        const i = b.idx(r.LOINC_NUM.trim());
        if (i === undefined || !r.IEEE_CF_CODE10.trim()) continue;
        const eq = r.EQUIVALENCE.trim();
        b.mapping(i, { system: 'urn:iso:std:iso:11073:10101', code: r.IEEE_CF_CODE10.trim(),
          display: r.IEEE_REFID.trim() || null, relationship: IEEE_EQUIVALENCE[eq] || eq });
        n++;
      }
    }
    return n;
  });

  stats.unkeyed = 0;
  for (let i = 0; i < b.codes.length; i++) if (!sourceOrder.has(i)) setOrder(i, ORDER_TYPE.part, ORDER.unkeyed * ORDER_STAGE + (++stats.unkeyed));
  const walkPlace = await b.stage('whole-system walk', async () => loincWalk(sourceOrder, childLinks));

  // does the parent links' seq give upstream's entry order? (then the reader merges a concept's
  // parent links and its children's links by seq, and no array is stored)
  const order = await b.stage('hierarchy order check', async () => hierarchyCheck(b.codes.length, hier, parentLinks));
  stats.hierarchyOrder = order.stats;
  const storeHier = cfg.hierarchyArrays === 'always' || (cfg.hierarchyArrays !== 'never' && order.stats.conceptsDiffering > 0);
  const derived = [{ table: 'ix_order', name: 'rank' }, { table: 'ix_order', name: 'ids' }, { table: 'ix_order', name: 'walk' }];
  if (storeHier) derived.push({ table: 'ix_order', name: 'hier_start' }, { table: 'ix_order', name: 'hier' });
  b.setMeta('derived-by-importer', derived);
  stats.hierarchyArraysStored = storeHier;

  const summary = b.finish(stats, { vacuum: false });
  const t0 = Date.now();
  writeOrders(cfg.dest, b, sourceOrder, walkPlace, storeHier ? hier : null);
  summary.timings.derived = { s: (Date.now() - t0) / 1000, peakRssMiB: Math.round(process.resourceUsage().maxRSS / 1024) };
  const t1 = Date.now();
  vacuumFile(cfg.dest);
  summary.timings.vacuum = { s: (Date.now() - t1) / 1000 };
  summary.fileBytes = fs.statSync(cfg.dest).size;
  return summary;
}

/**
 * Upstream's entries (per concept: its parent and child relations in hierarchy-file row order,
 * only pairs whose parent had a key at that row, each once) against the parent links ordered by
 * the first row of each pair. Counts concepts whose lists differ (by handle).
 */
function hierarchyCheck(n, hier, parentLinks) {
  const key = (other, isChild) => `${isChild ? 'c' : 'p'}${other}`;
  const up = new Map();
  for (let k = 0; k < hier.xs.length; k++) {
    let l = up.get(hier.xs[k]);
    if (!l) up.set(hier.xs[k], l = []);
    l.push(key(hier.others[k], hier.child[k]));
  }
  const fromLinks = new Map();
  const add = (x, e, seq) => { let l = fromLinks.get(x); if (!l) fromLinks.set(x, l = []); l.push([seq, e]); };
  for (let k = 0; k < parentLinks.length; k += 3) {
    const [c, p, seq] = [parentLinks[k], parentLinks[k + 1], parentLinks[k + 2]];
    add(c, key(p, 0), seq);
    add(p, key(c, 1), seq);
  }
  let differ = 0, extra = 0, missing = 0;
  const examples = [];
  for (let x = 0; x < n; x++) {
    const a = up.get(x) || [];
    const l = (fromLinks.get(x) || []).sort((u, v) => u[0] - v[0]).map((e) => e[1]);
    if (a.length !== l.length || a.some((e, i) => e !== l[i])) {
      differ++;
      if (l.length > a.length) extra++; else if (l.length < a.length) missing++;
      if (examples.length < 5) examples.push({ handle: x, upstream: a.slice(0, 6), links: l.slice(0, 6) });
    }
  }
  return { stats: { concepts: n, upstreamEntries: hier.xs.length, conceptsDiffering: differ, withExtraLinks: extra, withMissingLinks: missing, examples } };
}

/** the derived-by-importer ix_order rows: rank, ids, walk (and hier_start / hier when asked) */
function writeOrders(file, b, sourceOrder, walkPlace, hier) {
  const db = new Database(file);
  db.pragma('journal_mode = OFF');
  db.pragma('synchronous = OFF');
  try {
    const n = db.prepare('SELECT concept_count FROM main.code_system WHERE served = 1').pluck().get();
    const idOf = new Uint32Array(b.codes.length);
    for (const [id, code] of db.prepare('SELECT id, code FROM main.concept').raw().iterate()) idOf[b.idx(code)] = id;
    const rows = [...sourceOrder].map(([i, [type, seq]]) => [idOf[i], type, seq, walkPlace.get(i)]);
    // rank by key, the walk by its place (or, without a walk, by type then key)
    rows.sort((x, y) => x[2] - y[2]);
    const rank = new Uint32Array(n + 1), ids = new Uint32Array(n + 1);
    rows.forEach((r, k) => { rank[r[0]] = k; ids[k] = r[0]; });
    const byWalk = rows.every((r) => r[3] != null);
    const walk = Uint32Array.from(rows.slice().sort(byWalk ? (x, y) => x[3] - y[3] : (x, y) => x[1] - y[1]).map((r) => r[0]));
    db.exec('BEGIN');
    db.prepare("DELETE FROM main.ix_order WHERE name IN ('rank', 'ids', 'walk', 'hier_start', 'hier')").run();
    const ins = db.prepare('INSERT INTO main.ix_order VALUES (?, ?, ?)');
    writeOrderArray(db, 'rank', rank, ins);
    writeOrderArray(db, 'ids', ids, ins);
    writeOrderArray(db, 'walk', walk, ins);
    writeActiveOrder(db);
    if (hier) {
      const arrays = hierarchyArrays(n, hier.xs.map((i) => idOf[i]), hier.others.map((i) => idOf[i]), hier.child);
      writeOrderArray(db, 'hier_start', arrays.start, ins);
      writeOrderArray(db, 'hier', arrays.entries, ins);
    }
    db.exec('COMMIT');
    analyze(db, 'main.ix_order');
    db.pragma('journal_mode = DELETE');
  } finally {
    db.close();
  }
}

class LoincV2Module extends BaseTerminologyModule {
  getName() { return 'loinc-v2'; }
  getDescription() { return 'LOINC CSV release -> SQLite terminology file (sqlite-v2 provider)'; }
  getSupportedFormats() { return ['directory']; }

  registerCommands(cmd) {
    cmd.command('import')
      .description('Import an unzipped LOINC release into a terminology file')
      .requiredOption('-s, --source <dir>', 'release root (contains LoincTable/ and AccessoryFiles/)')
      .requiredOption('-d, --dest <file>', 'destination .db')
      .requiredOption('-v, --loinc-version <version>', 'e.g. 2.83')
      .option('--overwrite', 'replace the destination')
      .action(async (o) => {
        const s = await importLoincV2({ source: o.source, dest: o.dest, version: o.loincVersion, overwrite: !!o.overwrite, log: (m) => this.logInfo(m) });
        this.logSuccess(`${s.concepts.toLocaleString()} concepts -> ${o.dest}`);
      });
  }
}

module.exports = { LoincV2Module, importLoincV2, loincCatalog, loincCodeSystem, loincWalk, writeOrders, hierarchyCheck, files, status,
  KIND, LOINC, ORDER_TYPE, ORDER_STAGE, ORDER, LITERALS, PART_LINK };
