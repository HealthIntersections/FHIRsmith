const fs = require('fs');
const os = require('os');
const path = require('path');
const { ClosureStore } = require('../../tx/closure/closure-store');

describe('shared closure table identities', () => {
  let dir, file;
  const opened = [];
  const open = (shared = true) => {
    const store = new ClosureStore({ database: file }, null, { shared });
    store.open();
    opened.push(store);
    return store;
  };
  const config = [{ name: 'system-version', valueUri: 'http://example.org/cs|old' }];
  const concepts = [{ key: 'a', system: 'http://example.org/cs', code: 'a' }];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'closure-identity-'));
    file = path.join(dir, 'closure.db');
  });
  afterEach(() => {
    for (const store of opened.splice(0)) store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test.each(['reset', 'dispose and recreate'])('%s rejects an outstanding write to the old table', change => {
    const a = open(), b = open();
    const old = a.createTableChecked('table', config, { reset: false, maxTables: 1 }).table;
    if (change === 'dispose and recreate') b.dropTable('table');
    const replacement = b.createTableChecked('table', [], { reset: true, maxTables: 1 }).table;
    expect(a.recordAddChecked(old, concepts, [])).toBeNull();
    expect(a.getConcepts(replacement.id)).toEqual([]);
    expect(a.getParams(replacement.id)).toEqual([]);
  });

  test('a duplicate-only add still checks the snapshot it read', () => {
    const a = open(), b = open();
    const table = a.createTableChecked('table', config, { reset: false, maxTables: 1 }).table;
    a.recordAddChecked(table, concepts, []);
    const old = a.getTable('table');
    b.createTableChecked('table', [], { reset: true, maxTables: 1 });
    expect(a.recordAddChecked(old, [], [])).toBeNull();
    expect(a.getTable('table').version).toBe(0);
  });

  test('upgrading an existing database preserves its data, and deleted IDs stay retired across reopen', () => {
    const legacy = open(false);
    const old = legacy.createTable('existing', config);
    legacy.recordAdd(old, concepts, []);
    legacy.close();
    const a = open();
    expect(a.getTable('existing').id).toBe(old.id);
    expect(a.getParams(old.id)).toEqual(config);
    expect(a.getConcepts(old.id).map(c => c.code)).toEqual(['a']);
    const next = a.createTableChecked('new', [], { reset: false, maxTables: 2 }).table;
    expect(next.id).toBeGreaterThan(old.id);
    a.dropTable('existing');
    a.dropTable('new');
    a.close();
    const b = open();
    const afterRestart = b.createTableChecked('new', [], { reset: false, maxTables: 2 }).table;
    expect(afterRestart.id).toBeGreaterThan(next.id);
    expect(b.db.pragma('foreign_key_check')).toEqual([]);
  });
});
