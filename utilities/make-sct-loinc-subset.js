#!/usr/bin/env node
/**
 * Generates the LOINC Extension (LOINC ontology, module 11010000107,
 * namespace 1010000) content for the SNOMED CT test edition that the
 * tx-ecosystem tests use.
 *
 * The agreed scope for LOINC Extension support is:
 *   - $lookup on a SNOMED concept returns its LOINC code
 *   - $translate using the implicit map ?fhir_cm=11010000107 (the LOINC module)
 *   - $expand with a filter for concepts that have a LOINC code
 *
 * None of that needs the LOINC ontology's concept model, so this script takes
 * a handful of real LOINC Extension concepts from the published release and
 * copies their concept, description, language refset and identifier rows,
 * but NOT their defining relationships or OWL axioms (those reference
 * hundreds of concepts that are not in the test subset). Instead each concept
 * gets a single generated IS A to an observable entity that is in the
 * subset, and is made primitive (a fully defined concept defined only by an
 * IS A would be equivalent to its parent).
 *
 * The two metadata concepts the identifiers hang off - the module concept and
 * the LOINC identifier scheme - are copied too, re-parented to metadata
 * concepts that are in the subset (their real parents are not).
 *
 * All rows are given the edition's effective time (20250909). Everything else
 * - ids, terms, case significance, acceptability, LOINC codes - is as
 * published. Rows are deterministic, so the script can be re-run safely.
 *
 * Usage:
 *   node utilities/make-sct-loinc-subset.js <LOINC Extension release folder> [tx/data/snomed]
 * e.g.
 *   node utilities/make-sct-loinc-subset.js \
 *     ~/archive/terminologies/SnomedCT_LOINCExtension_PRODUCTION_LO1010000_20261021T120000Z \
 *     ../../igs/tx-ecosystem-ig/tx-source/snomed
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const source = process.argv[2];
if (!source) {
  console.error('Usage: node utilities/make-sct-loinc-subset.js <LOINC Extension release folder> [target snomed folder]');
  process.exit(1);
}
const root = process.argv[3] || path.join(__dirname, '..', 'tx', 'data', 'snomed');
const TAG = 'LO1010000';
const ET = '20250909';
const MODULE = '11010000107';            // LOINC Extension module
const EDITION_MODULE = '31000003106';    // the test edition module
const NAMESPACE = '1010000';
const EOL = '\r\n';

// --- RF2 constants ------------------------------------------------------

const PRIMITIVE = '900000000000074008';
const IS_A = '116680003';
const INFERRED = '900000000000011006';
const EXISTENTIAL = '900000000000451002';
const OWL_AXIOM_REFSET = '733073007';
const MODULE_DEPENDENCY_REFSET = '900000000000534007';
const INT_CORE = '900000000000207008';
const INT_MODEL = '900000000000012004';
const INT_ET = '20250801';               // the International release the subset was extracted from

// --- The subset ---------------------------------------------------------

// LOINC code -> parent in the test subset (null = inactive, no relationships).
// The LOINC concept id is taken from the release's identifier file.
const loincCodes = [
  // all but the last are in the tx-ecosystem LOINC test subset, so they can be translated both ways
  ['2823-3', '11953005'],    // Potassium [Moles/volume] in Serum or Plasma    -> Renal function
  ['22760-3', '11953005'],   // Potassium [Mass/volume] in Serum or Plasma     -> Renal function
  ['6298-4', '11953005'],    // Potassium [Moles/volume] in Blood              -> Renal function
  ['2828-2', '11953005'],    // Potassium [Moles/volume] in Urine              -> Renal function
  ['14402-2', '11953005'],   // Creatinine [Mass/volume] in Gastric fluid      -> Renal function
  ['14394-1', '11953005'],   // Urea nitrogen [Mass/volume] in Pleural fluid   -> Renal function
  ['104597-0', '363787002'], // Glucose [Mass/volume] in Venous blood by Glucometer -> Observable entity
  ['95084-0', '363787002'],  // C peptide [Mass/volume] in Serum or Plasma --2 hours post meal -> Observable entity
  ['95095-6', '363787002'],  // Glucagon [Mass/volume] in Serum or Plasma --2 hours post meal -> Observable entity
  ['31157-1', '363787002'],  // Carboxyhemoglobin [Mass/volume] in Blood       -> Observable entity
  ['95594-8', '363787002'],  // Calcifediol [Mass/volume] in Capillary blood   -> Observable entity
  ['2067-7', null]           // inactive in the release, but still has an (active) LOINC identifier; not in the LOINC test subset
];

// metadata concepts -> substitute parent in the test subset
const metadata = [
  [MODULE, '900000000000443000'],            // LOINC Extension module -> Module (real parent 1201891009 not in subset)
  ['30051010000102', '900000000000454005']   // LOINC code identifier -> Foundation metadata concept (real parent 900000000000453004 not in subset)
];

// --- Read the release ---------------------------------------------------

function findFile(dir, prefix) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const r = findFile(p, prefix);
      if (r) return r;
    } else if (entry.name.startsWith(prefix)) {
      return p;
    }
  }
  return null;
}

function readRf2(prefix) {
  const file = findFile(path.join(source, 'Snapshot'), prefix);
  if (!file) throw new Error(`No ${prefix}* file in ${source}/Snapshot`);
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.length > 0);
  return { header: lines[0], rows: lines.slice(1).map(l => l.split('\t')) };
}

const identifiers = readRf2('sct2_Identifier_Snapshot');
const conceptFile = readRf2('sct2_Concept_Snapshot');
const descriptionFile = readRf2('sct2_Description_Snapshot');
const languageFile = readRf2('der2_cRefset_LanguageSnapshot');
const relationshipFile = readRf2('sct2_Relationship_Snapshot');

const conceptById = new Map(conceptFile.rows.map(r => [r[0], r]));
const identifierByCode = new Map(identifiers.rows.map(r => [r[0], r]));

// --- Ids for generated rows ---------------------------------------------

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

// Relationship ids are allocated from a high item range and checked against
// the release so they can never collide with a published relationship id.
const usedRelationshipIds = new Set(relationshipFile.rows.map(r => r[0]));
let nextItem = 99000001;
function relationshipId() {
  for (;;) {
    const body = `${nextItem++}${NAMESPACE}12`;
    const id = body + verhoeff(body);
    if (!usedRelationshipIds.has(id)) return id;
  }
}

function memberId(...parts) {
  const h = crypto.createHash('sha1').update(['sct-loinc-subset', ...parts].join('|')).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// --- Build rows ---------------------------------------------------------

const wanted = [];   // [conceptId, parent|null, loincCode|null]
for (const [code, parent] of loincCodes) {
  const ident = identifierByCode.get(code);
  if (!ident) throw new Error(`LOINC code ${code} has no identifier in the release`);
  if (ident[3] !== MODULE) throw new Error(`Identifier for ${code} is in module ${ident[3]}, not ${MODULE}`);
  wanted.push([ident[5], parent, code]);
}
for (const [id, parent] of metadata) wanted.push([id, parent, null]);

const conceptRows = [];
const relationshipRows = [];
const owlRows = [];
const identifierRows = [];
const summary = [];
const wantedIds = new Set(wanted.map(w => w[0]));

for (const [id, parent, code] of wanted) {
  const c = conceptById.get(id);
  if (!c) throw new Error(`Concept ${id} not found in the release`);
  if (c[3] !== MODULE) throw new Error(`Concept ${id} is in module ${c[3]}, not ${MODULE}`);
  const active = c[2];
  if (active === '1' && !parent) throw new Error(`Active concept ${id} needs a parent`);
  if (active === '0' && parent) throw new Error(`Inactive concept ${id} must not be given a parent`);
  conceptRows.push([id, ET, active, MODULE, PRIMITIVE]);
  if (parent) {
    relationshipRows.push([relationshipId(), ET, '1', MODULE, id, parent, '0', IS_A, INFERRED, EXISTENTIAL]);
    owlRows.push([memberId('owl', id), ET, '1', MODULE, OWL_AXIOM_REFSET, id, `SubClassOf(:${id} :${parent})`]);
  }
  if (code) {
    const ident = identifierByCode.get(code);
    identifierRows.push([ident[0], ET, ident[2], ident[3], ident[4], ident[5]]);
  }
  summary.push({ id, code, active, parent });
}

const descriptionRows = descriptionFile.rows
  .filter(r => wantedIds.has(r[4]))
  .map(r => [r[0], ET, ...r.slice(2)]);
const descriptionIds = new Set(descriptionRows.map(r => r[0]));
for (const s of summary) {
  const fsn = descriptionRows.find(r => r[4] === s.id && r[2] === '1' && r[6] === '900000000000003001');
  if (!fsn) throw new Error(`No active FSN for ${s.id}`);
  s.fsn = fsn[7];
}

const languageRows = languageFile.rows
  .filter(r => descriptionIds.has(r[5]))
  .map(r => [r[0], ET, ...r.slice(2)]);

const moduleDependencyRows = [
  [memberId('dep', MODULE, INT_CORE), ET, '1', MODULE, MODULE_DEPENDENCY_REFSET, INT_CORE, ET, INT_ET],
  [memberId('dep', MODULE, INT_MODEL), ET, '1', MODULE, MODULE_DEPENDENCY_REFSET, INT_MODEL, ET, INT_ET],
  [memberId('dep', EDITION_MODULE, MODULE), ET, '1', EDITION_MODULE, MODULE_DEPENDENCY_REFSET, MODULE, ET, ET]
];

// --- Write files --------------------------------------------------------

function sortRows(rows) {
  return rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function write(rel, header, rows) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [header, ...sortRows(rows).map(r => r.join('\t'))].join(EOL) + EOL, 'utf8');
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
write(`Terminology/sct2_Identifier_Snapshot_${TAG}_${ET}.txt`,
  'alternateIdentifier\teffectiveTime\tactive\tmoduleId\tidentifierSchemeId\treferencedComponentId', identifierRows);
write(`Refset/Language/der2_cRefset_LanguageSnapshot-en_${TAG}_${ET}.txt`,
  'id\teffectiveTime\tactive\tmoduleId\trefsetId\treferencedComponentId\tacceptabilityId', languageRows);
write(`Refset/Metadata/der2_ssRefset_ModuleDependencySnapshot_${TAG}_${ET}.txt`,
  'id\teffectiveTime\tactive\tmoduleId\trefsetId\treferencedComponentId\tsourceEffectiveTime\ttargetEffectiveTime', moduleDependencyRows);

console.log('\nConcepts:');
for (const s of summary) {
  console.log(`  ${s.id.padEnd(16)} ${(s.code || '').padEnd(8)} ${s.active === '0' ? '(inactive) ' : ''}${s.fsn}`);
}
