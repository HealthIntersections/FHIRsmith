const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { LoincServicesFactory } = require('../../tx/cs/cs-loinc');
const { OperationContext } = require('../../tx/operation-context');
const { TestUtilities } = require('../test-utilities');
const { loincTestingDbCopy } = require('../loinc-testing-db');
const { Designations } = require('../../tx/library/designations');

/**
 * LOINC requests share the factory's connections (library/sqlite-pool.js) rather than each
 * opening and closing one of its own; modules.tx.loincConnections sets how many, and 0 goes back
 * to a connection per request. Either way a request has to get the same answers.
 */

describe('LOINC: shared connections', () => {
  let dir;
  let dbPath;
  let opContext;
  let codes;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loinc-pool-'));
    dbPath = await loincTestingDbCopy(dir);
    opContext = new OperationContext('en', await TestUtilities.loadTranslations(await TestUtilities.loadLanguageDefinitions()));
    const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY);
    codes = await new Promise((resolve, reject) => db.all('SELECT Code FROM Codes ORDER BY Code LIMIT 40', [],
      (err, rows) => err ? reject(err) : resolve(rows.map(r => r.Code))));
    await new Promise(resolve => db.close(resolve));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // what a $lookup of each code produces
  async function lookups(factory) {
    return Promise.all(codes.map(async (code) => {
      const provider = await factory.build(opContext, []);
      try {
        const located = await provider.locate(code);
        if (!located.context) {
          return { code, message: located.message };
        }
        const designations = new Designations(opContext.i18n.languageDefinitions);
        await provider.designations(located.context, designations);
        const params = [];
        await provider.extendLookup(located.context, ['*'], params);
        return { code, display: await provider.display(located.context), designations: designations.count, params };
      } finally {
        provider.close();
      }
    }));
  }

  test('the same answers with shared connections as with one per request', async () => {
    const shared = new LoincServicesFactory(opContext.i18n, dbPath);
    const own = new LoincServicesFactory(opContext.i18n, dbPath, { connections: 0 });
    try {
      expect(shared.connections).toBe(4);
      const a = await lookups(shared);
      const b = await lookups(own);
      expect(a.filter(r => r.display).length).toBeGreaterThan(0);
      expect(a).toEqual(b);
    } finally {
      await shared.close();
      await own.close();
    }
  });

  test('a request closing does not close the shared connections; the factory closing does', async () => {
    const factory = new LoincServicesFactory(opContext.i18n, dbPath, { connections: 2 });
    const first = await factory.build(opContext, []);
    const pool = first.db;
    expect(pool.size).toBe(2);
    first.close();
    expect(pool.closed).toBe(false);

    const second = await factory.build(opContext, []);
    expect(second.db).toBe(pool);
    expect((await second.locate(codes[0])).context).toBeTruthy();
    second.close();

    await factory.close();
    expect(pool.closed).toBe(true);
    await factory.close(); // a factory can be registered under several names: closed more than once
  });

  test('0: each request opens a connection of its own, and closes it', async () => {
    const factory = new LoincServicesFactory(opContext.i18n, dbPath, { connections: 0 });
    const a = await factory.build(opContext, []);
    const b = await factory.build(opContext, []);
    expect(a.db).toBeInstanceOf(sqlite3.Database);
    expect(a.db).not.toBe(b.db);
    a.close();
    b.close();
    expect(a.dbClosed).toBe(true);
    await factory.close();
  });

  test('a database that cannot be opened: requests open their own, as before', async () => {
    const factory = new LoincServicesFactory(opContext.i18n, dbPath);
    await factory.build(opContext, []); // loaded
    factory.dbPath = path.join(dir, 'missing', 'loinc.db'); // the shared ones can't be opened now
    await factory.close();
    const provider = await factory.build(opContext, []).catch(e => e);
    // without the shared connections, it tried to open its own - which can't be opened either
    expect(String(provider && provider.message)).toMatch(/SQLITE_CANTOPEN/);
    expect(factory._poolPromise).toBeNull(); // the next request tries again
  });
});
