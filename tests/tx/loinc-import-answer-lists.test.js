// LOINC importer: an externally defined answer list (no AnswerStringId) adds the list, and no
// blank Answer code. AnswerList.csv in 2.83 has 65 such rows; they all became one Answer whose
// code is '', so LOINC had one code too many (257,267 rather than 257,266)
const { LoincDataMigrator, csvSplit } = require('../../tx/importers/import-loinc.module');

function migrator() {
  const m = new LoincDataMigrator();
  m.codeKey = 0;
  m.codes = new Map();
  m.rels = new Map([['Answer', 40], ['AnswerList', 39]]);
  m.relationships = [];
  m.addRelationship = (db, s, t, r) => m.relationships.push([s, t, r]);
  m.addExternalMapping = () => {};
  return m;
}

function db() {
  const inserts = [];
  return { inserts, run: (sql, params) => inserts.push(params) };
}

// AnswerListId, AnswerListName, AnswerListOID, ExtDefinedYN, ExtDefinedAnswerListCodeSystem,
// ExtDefinedAnswerListLink, AnswerStringId, LocalAnswerCode, LocalAnswerCodeSystem, SequenceNumber, DisplayText, ...
const row = (list, name, answer, display) => [list, name, '', answer ? 'N' : 'Y', '', '', answer, '', '', '1', display, '', '', '', '', '', '', '', ''];

describe('LOINC import: answer lists', () => {
  test('an externally defined list (no AnswerStringId) is a code, with no blank answer', async () => {
    const m = migrator();
    const d = db();
    await m.processListItem(d, row('LL1892-0', 'ICD-9_ICD-10', '', ''), null);
    await m.processListItem(d, row('LL1894-6', 'RxNorm', '', ''), 'LL1892-0');
    expect(d.inserts.map(p => p[1])).toEqual(['LL1892-0', 'LL1894-6']);
    expect(m.codes.has('')).toBe(false);
    expect(m.relationships).toEqual([]);
  });

  test('a list with answers still adds each answer once, linked both ways', async () => {
    const m = migrator();
    const d = db();
    await m.processListItem(d, row('LL1-1', 'Yes/No', 'LA33-6', 'Yes'), null);
    await m.processListItem(d, row('LL1-1', 'Yes/No', 'LA32-8', 'No'), 'LL1-1');
    await m.processListItem(d, row('LL2-2', 'Yes', 'LA33-6', 'Yes'), 'LL1-1');
    expect(d.inserts.map(p => [p[1], p[2]])).toEqual([['LL1-1', 3], ['LA33-6', 4], ['LA32-8', 4], ['LL2-2', 3]]);
    expect(m.relationships).toHaveLength(6);
  });
});

describe('LOINC import: CSV fields', () => {
  test('a quoted field loses its enclosing quotes, and nothing else', () => {
    const line = '"LL1","List","He said ""no"" to it","""Poker face""","5"" or more","ends with ""quote""",""';
    expect(csvSplit(line, 8)).toEqual(['LL1', 'List', 'He said "no" to it', '"Poker face"', '5" or more', 'ends with "quote"', '', '']);
  });

  test('commas inside quotes, unquoted fields, and a quote inside an unquoted field', () => {
    expect(csvSplit('"a, b",c,5" tall,"d"', 4)).toEqual(['a, b', 'c', '5" tall', 'd']);
  });

  test('at most expectedCount fields', () => {
    expect(csvSplit('a,b,c,d', 2)).toEqual(['a', 'b']);
  });
});
