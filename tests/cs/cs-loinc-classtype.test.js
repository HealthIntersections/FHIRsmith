const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LoincServicesFactory } = require('../../tx/cs/cs-loinc');
const { OperationContext } = require('../../tx/operation-context');
const { TestUtilities } = require('../test-utilities');

/**
 * CLASSTYPE 3: the importer stores its description as 'Claims attachment', which the provider
 * didn't know ('Claims attachments'), so $lookup produced a property with no value - a 500 for
 * every claims attachment code (18719-5 etc.) - and CLASSTYPE = 3 selected nothing (L6). The
 * LOINC test subset has no claims attachment codes, so a copy of the test database gets one.
 */

const run = (db, sql, args = []) => new Promise((resolve, reject) => db.run(sql, args, function (err) { err ? reject(err) : resolve(this); }));
const get = (db, sql, args = []) => new Promise((resolve, reject) => db.get(sql, args, (err, row) => err ? reject(err) : resolve(row)));

describe('LOINC CLASSTYPE: claims attachments', () => {
  const source = path.resolve(__dirname, '../../data/loinc-testing.db');
  let dir;
  let provider;
  let code;

  beforeAll(async () => {
    expect(fs.existsSync(source)).toBe(true);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loinc-classtype-'));
    const dbPath = path.join(dir, 'loinc.db');
    fs.copyFileSync(source, dbPath);

    // make one code's CLASSTYPE a claims attachment, as the importer stores it
    const db = new sqlite3.Database(dbPath);
    const row = await get(db, `SELECT Codes.Code, Properties.PropertyKey FROM Codes, Properties, PropertyTypes
      WHERE Properties.CodeKey = Codes.CodeKey AND Properties.PropertyTypeKey = PropertyTypes.PropertyTypeKey
        AND PropertyTypes.Description = 'CLASSTYPE' ORDER BY Codes.Code LIMIT 1`);
    code = row.Code;
    const max = await get(db, 'SELECT MAX(PropertyValueKey) AS k FROM PropertyValues');
    await run(db, 'INSERT INTO PropertyValues (PropertyValueKey, Value) VALUES (?, ?)', [max.k + 1, 'Claims attachment']);
    await run(db, 'UPDATE Properties SET PropertyValueKey = ? WHERE PropertyKey = ?', [max.k + 1, row.PropertyKey]);
    await new Promise(resolve => db.close(resolve));

    const opContext = new OperationContext('en', await TestUtilities.loadTranslations(await TestUtilities.loadLanguageDefinitions()));
    const factory = new LoincServicesFactory(opContext.i18n, dbPath);
    provider = await factory.build(opContext, []);
  });

  afterAll(() => {
    if (provider) {
      provider.close();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('$lookup reports CLASSTYPE 3, with its description', async () => {
    const params = [];
    await provider.extendLookup(code, ['CLASSTYPE'], params);
    const prop = params.find(p => p.part.some(pp => pp.name === 'code' && pp.valueCode === 'CLASSTYPE'));
    expect(prop).toBeDefined();
    expect(prop.part.find(pp => pp.name === 'value').valueString).toBe('3');
    expect(prop.part.find(pp => pp.name === 'description').valueString).toBe('Claims attachment');
  });

  test('CLASSTYPE = 3 selects it', async () => {
    const ctxt = await provider.getPrepContext(true);
    await provider.filter(ctxt, true, 'CLASSTYPE', '=', '3');
    const sets = await provider.executeFilters(ctxt);
    expect(await provider.filterSize(ctxt, sets[0])).toBe(1);
    expect(await provider.filterLocate(ctxt, sets[0], code)).toBeTruthy();
  });

  test('so does CLASSTYPE = Claims attachment', async () => {
    const ctxt = await provider.getPrepContext(true);
    await provider.filter(ctxt, true, 'CLASSTYPE', '=', 'Claims attachment');
    const sets = await provider.executeFilters(ctxt);
    expect(await provider.filterSize(ctxt, sets[0])).toBe(1);
  });
});
