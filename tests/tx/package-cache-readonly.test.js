/**
 * A tx-worker's package caches (cluster.md): ValueSetDatabase with readOnly never writes the
 * file - one that still needs a migration (here, rows without content_hash) fails to open, and
 * opens once its builder has migrated it - and a row is never written without its hash.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3');
const { ValueSetDatabase } = require('../../tx/vs/vs-database');
const { waitForCache } = require('../../tx/library/wait-for-cache');

const vs = (id) => ({ resourceType: 'ValueSet', id, url: `http://example.org/vs/${id}`, version: '1', status: 'active' });

function run(file, sql) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(file, (err) => {
      if (err) {
        return reject(err);
      }
      db.run(sql, [], (err) => db.close(() => err ? reject(err) : resolve()));
    });
  });
}

describe('package value set cache, read-only', () => {
  let dir;
  let file;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-ro-'));
    file = path.join(dir, '.valuesets-2.db');
    const db = new ValueSetDatabase(file);
    await db.create();
    await db.upsertValueSet(vs('a'));
    await db.upsertValueSet(vs('b'));
    await db.markComplete();
    await db.close();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a value set is stored with the hash the backfill would give it', async () => {
    const db = new ValueSetDatabase(file, { readOnly: true });
    const conn = await db._getReadConnection();
    const rows = await new Promise((resolve, reject) => conn.all('SELECT content, content_hash FROM valuesets', [], (e, r) => e ? reject(e) : resolve(r)));
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.content_hash).toBe(crypto.createHash('sha256').update(row.content).digest('hex'));
    }
    expect(await db.isComplete()).toBe(true);
    expect((await db.loadAllValueSets('test')).size).toBeGreaterThan(0);
    await db.close();
  });

  test('a file that needs a backfill is not opened read-only, nor changed; it is once migrated', async () => {
    await run(file, 'UPDATE valuesets SET content_hash = NULL');
    const before = fs.readFileSync(file);
    const ro = new ValueSetDatabase(file, { readOnly: true });
    expect(await ro.isComplete()).toBe(false);
    await expect(ro.getSetting('cache-complete')).rejects.toThrow(/not migrated yet/);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
    await expect(ro.upsertValueSet(vs('c'))).rejects.toThrow();

    // the builder (the master) opens it, and the backfill runs there
    const rw = new ValueSetDatabase(file);
    expect(await rw.isComplete()).toBe(true);
    await rw.close();
    expect(await ro.isComplete()).toBe(true);
    // and a write through the read-only one still fails
    await expect(ro.setSetting('x', 'y')).rejects.toThrow(/SQLITE_READONLY/);
    await ro.close();
  });

  test('a missing file is not created', async () => {
    const missing = path.join(dir, 'none.db');
    const ro = new ValueSetDatabase(missing, { readOnly: true });
    expect(await ro.isComplete()).toBe(false);
    expect(fs.existsSync(missing)).toBe(false);
  });

  test('waitForCache: waits for the cache, and gives up with a clear error', async () => {
    let n = 0;
    await waitForCache(async () => ++n >= 2, 'test cache', { waitMs: 5000 });
    expect(n).toBe(2);
    await expect(waitForCache(async () => false, 'test cache', { waitMs: 10 })).rejects.toThrow(/the master builds it/);
  });
});
