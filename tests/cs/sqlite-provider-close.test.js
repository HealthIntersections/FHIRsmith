/**
 * Closing a sqlite-backed provider while a query is in flight
 *
 * A request's providers are closed when the client disconnects, which can be
 * while one of them is half way through a lookup. UNII's locate() (like RxNorm's)
 * runs a second query from the first one's callback. close() used to set the
 * connection to null, so that callback threw - outside any promise - and the
 * uncaught exception took the process down. Now the queries already under way
 * finish, and one asked for after the connection has closed fails as an error.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');
const { UniiServices } = require('../../tx/cs/cs-unii');
const { OperationContext } = require('../../tx/operation-context');
const { Languages } = require('../../library/languages');

function run(db, sql) {
  return new Promise((resolve, reject) => db.run(sql, (err) => err ? reject(err) : resolve()));
}

describe('sqlite provider close() with a query in flight', () => {
  let dir;
  let dbPath;
  const uncaught = [];
  const onUncaught = (e) => uncaught.push(e);

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-close-'));
    dbPath = path.join(dir, 'unii.db');
    const db = new sqlite3.Database(dbPath);
    await run(db, 'CREATE TABLE Unii (UniiKey INTEGER PRIMARY KEY, Code TEXT, Display TEXT)');
    await run(db, 'CREATE TABLE UniiDesc (UniiKey INTEGER, Display TEXT)');
    await run(db, "INSERT INTO Unii VALUES (1, 'G9ZF61LE7G', 'TEST SUBSTANCE')");
    await run(db, "INSERT INTO UniiDesc VALUES (1, 'Another name')");
    await new Promise((resolve) => db.close(resolve));
    process.prependListener('uncaughtException', onUncaught);
  });

  afterAll(() => {
    process.removeListener('uncaughtException', onUncaught);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function provider() {
    return new UniiServices(new OperationContext(new Languages(null)), [], new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY), '1');
  }

  test('a lookup under way when close() is called completes, and no callback throws', async () => {
    const csp = provider();
    const located = csp.locate('G9ZF61LE7G');
    csp.close();
    csp.close(); // closing twice is harmless
    const result = await located;
    expect(result.context.display).toBe('TEST SUBSTANCE');
    expect(result.context.others).toEqual(['Another name']);
    await new Promise((resolve) => setImmediate(resolve));
    expect(uncaught).toEqual([]);
  });

  test('a lookup asked for after the connection has closed fails as an error', async () => {
    const csp = provider();
    csp.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(csp.locate('G9ZF61LE7G')).rejects.toThrow(/SQLITE_MISUSE/);
    expect(uncaught).toEqual([]);
  });
});
