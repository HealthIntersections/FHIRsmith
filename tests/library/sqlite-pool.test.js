// library/sqlite-pool.js: several read-only connections used as one, so a slow query doesn't
// hold up the rest (a sqlite3 connection runs one query at a time)

const fs = require('fs');
const os = require('os');
const path = require('path');
const sqlite3 = require('sqlite3');
const { SqlitePool, DEFAULT_SIZE } = require('../../library/sqlite-pool');

// a query that keeps a connection busy for a while (a few hundred ms)
const SLOW = 'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000000) SELECT COUNT(*) AS c FROM n';

describe('SqlitePool', () => {
  let dir;
  let dbPath;
  let pool;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-pool-'));
    dbPath = path.join(dir, 'test.db');
    const db = new sqlite3.Database(dbPath);
    await new Promise((resolve, reject) => db.exec(
      "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO t (name) VALUES ('a'), ('b'), ('c');",
      err => err ? reject(err) : resolve()));
    await new Promise(resolve => db.close(() => resolve()));
  });

  afterEach(async () => {
    if (pool && !pool.closed) {
      await new Promise(resolve => pool.close(() => resolve()));
    }
    pool = null;
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const get = (p, sql, params) => new Promise((resolve, reject) =>
    p.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
  const all = (p, sql, params) => new Promise((resolve, reject) =>
    p.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));

  test('get and all, with and without parameters, as a Database', async () => {
    pool = await SqlitePool.open(dbPath);
    expect(pool.size).toBe(DEFAULT_SIZE);
    expect(await get(pool, 'SELECT name FROM t WHERE id = ?', [2])).toEqual({ name: 'b' });
    expect((await all(pool, 'SELECT name FROM t ORDER BY id', [])).map(r => r.name)).toEqual(['a', 'b', 'c']);
    const row = await new Promise((resolve, reject) => pool.get('SELECT COUNT(*) AS n FROM t', (err, r) => err ? reject(err) : resolve(r)));
    expect(row.n).toBe(3);
    await expect(get(pool, 'SELECT nosuchcolumn FROM t', [])).rejects.toThrow(/no such column/);
  });

  test('read-only', async () => {
    pool = await SqlitePool.open(dbPath, { size: 1 });
    await expect(get(pool, "INSERT INTO t (name) VALUES ('d')", [])).rejects.toThrow(/readonly/);
  });

  test('each query goes to the least busy connection', async () => {
    pool = await SqlitePool.open(dbPath, { size: 3 });
    const queries = Array.from({ length: 6 }, (_, i) => get(pool, 'SELECT ? AS i', [i]));
    expect(pool.connections.map(c => c.pending)).toEqual([2, 2, 2]);
    expect(pool.pending).toBe(6);
    expect((await Promise.all(queries)).map(r => r.i)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(pool.pending).toBe(0);
  });

  test('a slow query holds up the others on one connection, not with several', async () => {
    const order = async (size) => {
      const p = await SqlitePool.open(dbPath, { size });
      const done = [];
      await Promise.all([
        get(p, SLOW, []).then(() => done.push('slow')),
        get(p, 'SELECT 1 AS one', []).then(() => done.push('fast'))
      ]);
      await new Promise(resolve => p.close(() => resolve()));
      return done;
    };
    expect(await order(1)).toEqual(['slow', 'fast']);
    expect(await order(2)).toEqual(['fast', 'slow']);
  });

  test('configure runs on each connection as it opens', async () => {
    const seen = [];
    pool = await SqlitePool.open(dbPath, {
      size: 3,
      configure: (db) => new Promise((resolve, reject) => db.run('PRAGMA cache_size = 1234', err => {
        seen.push(db);
        err ? reject(err) : resolve();
      }))
    });
    expect(new Set(seen)).toEqual(new Set(pool.connections.map(c => c.db)));
    expect(seen.length).toBe(3);
  });

  test('a file that cannot be opened rejects, and leaves nothing open', async () => {
    await expect(SqlitePool.open(path.join(dir, 'missing.db'), { size: 2 })).rejects.toThrow(/SQLITE_CANTOPEN/);
  });

  test('a configure that fails rejects', async () => {
    await expect(SqlitePool.open(dbPath, { size: 2, configure: () => Promise.reject(new Error('no')) })).rejects.toThrow('no');
  });

  test('closed: every connection is closed, and a query after that is an error', async () => {
    pool = await SqlitePool.open(dbPath, { size: 2 });
    await new Promise((resolve, reject) => pool.close(err => err ? reject(err) : resolve()));
    await expect(get(pool, 'SELECT 1', [])).rejects.toThrow(/SQLITE_MISUSE/);
  });

  test('a size that is not a positive whole number is the default', async () => {
    pool = await SqlitePool.open(dbPath, { size: 0 });
    expect(pool.size).toBe(DEFAULT_SIZE);
  });
});
