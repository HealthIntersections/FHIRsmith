const fs = require('fs');
const os = require('os');
const path = require('path');
const { csvRecords } = require('../../tx/importers/csv-records');

async function records(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csv-records-'));
  const file = path.join(dir, 'test.csv');
  fs.writeFileSync(file, text);
  try {
    const result = [];
    for await (const r of csvRecords(file)) {
      result.push(r);
    }
    return result;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('csvRecords', () => {
  test('one record per line', async () => {
    expect(await records('"a","b"\n"c","d"\n')).toEqual(['"a","b"', '"c","d"']);
  });

  test('a quoted field with a line break is one record', async () => {
    // as in LOINC 2.83 ComponentHierarchyBySystem.csv (LP409416-7)
    expect(await records('"h1","h2"\r\n"1","\r\nBCKDHB gene | Mutations"\r\n"2","x"\r\n'))
      .toEqual(['"h1","h2"', '"1","\nBCKDHB gene | Mutations"', '"2","x"']);
  });

  test('escaped quotes do not start or end a field', async () => {
    expect(await records('"a ""b"" c","d"\n"e","f ""g\nh"" i"\n"j"\n'))
      .toEqual(['"a ""b"" c","d"', '"e","f ""g\nh"" i"', '"j"']);
  });

  test('an unterminated last record is still returned', async () => {
    expect(await records('"a"\n"b\n')).toEqual(['"a"', '"b']);
  });
});
