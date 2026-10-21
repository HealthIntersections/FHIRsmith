#!/usr/bin/env node
/**
 * Generates the "national extension" content for the SNOMED CT test edition
 * (module 31000003106, namespace 1000003) that the tx-ecosystem tests use.
 *
 * The test edition at tx/data/snomed is a subontology extract of the
 * International Edition; everything in it except the module concept itself
 * is International content. This script adds a handful of extension concepts
 * whose definitions are built entirely from International concepts that are
 * in the subset, so that national -> international translation can be tested:
 *
 *   - one fully defined concept with a single ungrouped attribute (laterality)
 *   - one fully defined concept with role-grouped attributes, not equivalent
 *     to any International concept
 *   - one fully defined concept that is exactly equivalent to an existing
 *     International concept (same defining relationships)
 *   - one primitive concept with only an IS A (closest ancestor only)
 *   - one primitive concept directly under a top-level hierarchy (no useful ancestor)
 *   - one inactive concept with no historical association (nothing to translate to)
 *   - one inactive concept REPLACED BY an International concept
 *
 * Output is a set of RF2 snapshot files alongside the INT ones, with the
 * TEST1000003 namespace tag in the filename. Rows are deterministic, so the
 * script can be re-run safely; ids are allocated from item numbers >= 100001
 * so they never collide with the extractor-generated ids.
 *
 * Usage: node utilities/make-sct-test-extension.js [tx/data/snomed]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = process.argv[2] || path.join(__dirname, '..', 'tx', 'data', 'snomed');
const TAG = 'TEST1000003';
const ET = '20250909';
const MODULE = '31000003106';
const NAMESPACE = '1000003';
const EOL = '\r\n';

// --- SCTID construction -------------------------------------------------

// Verhoeff check digit
const d = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]];
const p = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 8, 1, 5, 3, 9, 2]];
const inv = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

function verhoeff(numStr) {
  let c = 0;
  const digits = numStr.split('').reverse().map(Number);
  for (let i = 0; i < digits.length; i++) {
    c = d[c][p[(i + 1) % 8][digits[i]]];
  }
  return inv[c];
}

function sctid(item, partition) {
  const body = `${item}${NAMESPACE}${partition}`;
  return body + verhoeff(body);
}

let nextItem = 100001;
const conceptId = () => sctid(nextItem++, '10');
const descriptionId = () => sctid(nextItem++, '11');
const relationshipId = () => sctid(nextItem++, '12');

// Deterministic UUID for refset members (name-based, so re-runs are stable)
function memberId(...parts) {
  const h = crypto.createHash('sha1').update(['sct-test-ext', ...parts].join('|')).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// --- RF2 constants ------------------------------------------------------

const FULLY_DEFINED = '900000000000073002';
const PRIMITIVE = '900000000000074008';
const FSN = '900000000000003001';
const SYNONYM = '900000000000013009';
const CASE_INSENSITIVE = '900000000000448009';
const INITIAL_CHAR_CI = '900000000000020002';
const IS_A = '116680003';
const INFERRED = '900000000000011006';
const EXISTENTIAL = '900000000000451002';
const EN_GB = '900000000000508004';
const EN_US = '900000000000509007';
const PREFERRED = '900000000000548007';
const ACCEPTABLE = '900000000000549004';
const OWL_AXIOM_REFSET = '733073007';
const ROLE_GROUP = '609096000';
const REPLACED_BY = '900000000000526001';   // the SAME AS refset concept is not in the subset

// --- The extension content ---------------------------------------------

// All destination/attribute ids below are International concepts present in
// the test subset. Each concept: fsn, synonyms (first is preferred),
// parents, groups (array of arrays of [typeId, destinationId]; group 0 =
// ungrouped), definition status, and the stated OWL axiom.
const concepts = [
  {
    key: 'right-kidney',
    // shape 1: fully defined, one ungrouped attribute (Laterality is never grouped)
    fsn: 'Structure of kidney adjacent to liver (body structure)',
    synonyms: ['Right kidney (the one under the liver)', 'Liver-side kidney'],
    parents: ['64033007'],                                  // Kidney structure
    ungrouped: [['272741003', '24028007']],                 // Laterality = Right
    groups: [],
    status: FULLY_DEFINED,
    owl: (id) => `EquivalentClasses(:${id} ObjectIntersectionOf(:64033007 ObjectSomeValuesFrom(:272741003 :24028007)))`
  },
  {
    key: 'pate-hepatitis',
    // shape 2: fully defined, role-grouped, no International equivalent
    fsn: 'Acute toxic hepatitis caused by liver pate (disorder)',
    synonyms: ['Pate-induced hepatitis', 'Revenge of the liver'],
    parents: ['4896000'],                                   // Acute toxic hepatitis
    ungrouped: [],
    groups: [
      [['116676008', '4532008'],                            // Associated morphology = Acute inflammation
       ['246075003', '227014008'],                          // Causative agent = Liver pate
       ['363698007', '10200004']],                          // Finding site = Liver structure
      [['263502005', '424124008']]                          // Clinical course = Sudden onset AND/OR short duration
    ],
    status: FULLY_DEFINED,
    // Same shape as the International axiom for 4896000, with the causative agent refined
    owl: (id) => `EquivalentClasses(:${id} ObjectIntersectionOf(:75478009 ObjectSomeValuesFrom(:${ROLE_GROUP} ObjectIntersectionOf(ObjectSomeValuesFrom(:116676008 :4532008) ObjectSomeValuesFrom(:246075003 :227014008) ObjectSomeValuesFrom(:363698007 :10200004))) ObjectSomeValuesFrom(:${ROLE_GROUP} ObjectSomeValuesFrom(:263502005 :424124008))))`
  },
  {
    key: 'us-liver-biopsy',
    // shape 3: fully defined, exactly equivalent to 438300009 |Biopsy of liver using ultrasound guidance|
    fsn: 'Liver biopsy using the ultrasound thingy (procedure)',
    synonyms: ['Ultrasound-guided liver biopsy (local dialect)'],
    parents: ['105377009', '86259008'],                     // Ultrasonography of liver, Biopsy of liver
    ungrouped: [],
    groups: [
      [['260686004', '129314006'],                          // Method = Biopsy - action
       ['405813007', '10200004']],                          // Procedure site - Direct = Liver structure
      [['260686004', '278292003'],                          // Method = Ultrasound imaging - action
       ['363703001', '429892002'],                          // Has intent = Guidance intent
       ['405813007', '10200004']]                           // Procedure site - Direct = Liver structure
    ],
    status: FULLY_DEFINED,
    owl: (id) => `EquivalentClasses(:${id} :438300009)`
  },
  {
    key: 'liverish',
    // shape 4: primitive, IS A only
    fsn: 'Feeling liverish (finding)',
    synonyms: ['Liverish', 'Bit liverish this morning'],
    parents: ['300338006'],                                 // Liver problem
    ungrouped: [],
    groups: [],
    status: PRIMITIVE,
    owl: (id) => `SubClassOf(:${id} :300338006)`
  },
  {
    key: 'vaguely-unwell',
    // shape 5: primitive, directly under a top-level hierarchy - the only International
    // ancestor carries no information, so there is no useful translation
    fsn: 'Feeling vaguely unwell about the liver (finding)',
    synonyms: ['Vaguely unwell about the liver'],
    parents: ['404684003'],                                 // Clinical finding
    ungrouped: [],
    groups: [],
    status: PRIMITIVE,
    owl: (id) => `SubClassOf(:${id} :404684003)`
  },
  {
    key: 'dropsy',
    // shape 6: inactive, no relationships, no historical association - nothing at all
    fsn: 'Dropsy of the liver (disorder)',
    synonyms: ['Hepatic dropsy'],
    parents: [], ungrouped: [], groups: [],
    status: PRIMITIVE,
    active: false
  },
  {
    key: 'hepatic-revenge',
    // shape 7: inactive, REPLACED BY an International concept
    fsn: 'Hepatic revenge syndrome (disorder)',
    synonyms: ['Hepatic revenge'],
    parents: [], ungrouped: [], groups: [],
    status: PRIMITIVE,
    active: false,
    replacedBy: '4896000'                                   // Acute toxic hepatitis
  }
];

// --- Row builders -------------------------------------------------------

const conceptRows = [];
const descriptionRows = [];
const relationshipRows = [];
const languageRows = [];
const owlRows = [];
const associationRows = [];
const summary = [];

for (const c of concepts) {
  const id = conceptId();
  const active = c.active === false ? '0' : '1';
  conceptRows.push([id, ET, active, MODULE, c.status]);

  const terms = [[FSN, c.fsn, PREFERRED], ...c.synonyms.map((t, i) => [SYNONYM, t, i === 0 ? PREFERRED : ACCEPTABLE])];
  for (const [typeId, term, acceptability] of terms) {
    const did = descriptionId();
    descriptionRows.push([did, ET, '1', MODULE, id, 'en', typeId, term, CASE_INSENSITIVE]);
    for (const refset of [EN_GB, EN_US]) {
      languageRows.push([memberId('lang', refset, did), ET, '1', MODULE, refset, did, acceptability]);
    }
  }

  for (const parent of c.parents) {
    relationshipRows.push([relationshipId(), ET, '1', MODULE, id, parent, '0', IS_A, INFERRED, EXISTENTIAL]);
  }
  for (const [typeId, dest] of c.ungrouped) {
    relationshipRows.push([relationshipId(), ET, '1', MODULE, id, dest, '0', typeId, INFERRED, EXISTENTIAL]);
  }
  c.groups.forEach((group, gi) => {
    for (const [typeId, dest] of group) {
      relationshipRows.push([relationshipId(), ET, '1', MODULE, id, dest, String(gi + 1), typeId, INFERRED, EXISTENTIAL]);
    }
  });

  if (c.owl) {
    owlRows.push([memberId('owl', id), ET, '1', MODULE, OWL_AXIOM_REFSET, id, c.owl(id)]);
  }
  if (c.replacedBy) {
    associationRows.push([memberId('assoc', REPLACED_BY, id), ET, '1', MODULE, REPLACED_BY, id, c.replacedBy]);
  }
  summary.push(`${id}  ${c.fsn}${c.active === false ? '  (inactive)' : ''}`);
}

// --- Write files --------------------------------------------------------

function write(rel, header, rows) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [header, ...rows.map(r => r.join('\t'))].join(EOL) + EOL, 'utf8');
  console.log(`${rows.length.toString().padStart(3)} rows  ${rel}`);
}

write(`Terminology/sct2_Concept_Snapshot_${TAG}_${ET}.txt`,
  'id\teffectiveTime\tactive\tmoduleId\tdefinitionStatusId', conceptRows);
write(`Terminology/sct2_Description_Snapshot-en_${TAG}_${ET}.txt`,
  'id\teffectiveTime\tactive\tmoduleId\tconceptId\tlanguageCode\ttypeId\tterm\tcaseSignificanceId', descriptionRows);
write(`Terminology/sct2_Relationship_Snapshot_${TAG}_${ET}.txt`,
  'id\teffectiveTime\tactive\tmoduleId\tsourceId\tdestinationId\trelationshipGroup\ttypeId\tcharacteristicTypeId\tmodifierId', relationshipRows);
write(`Terminology/sct2_sRefset_OWLExpressionSnapshot_${TAG}_${ET}.txt`,
  'id\teffectiveTime\tactive\tmoduleId\trefsetId\treferencedComponentId\towlExpression', owlRows);
// the IG master keeps the content refsets under Refset/Content; FHIRsmith's copy has them in Refset/
const contentDir = fs.existsSync(path.join(root, 'Refset', 'Content')) ? 'Refset/Content' : 'Refset';
write(`${contentDir}/der2_cRefset_AssociationSnapshot_${TAG}_${ET}.txt`,
  'id\teffectiveTime\tactive\tmoduleId\trefsetId\treferencedComponentId\ttargetComponentId', associationRows);
write(`Refset/Language/der2_cRefset_LanguageSnapshot-en_${TAG}_${ET}.txt`,
  'id\teffectiveTime\tactive\tmoduleId\trefsetId\treferencedComponentId\tacceptabilityId', languageRows);

console.log('\nConcepts:');
for (const s of summary) console.log('  ' + s);
