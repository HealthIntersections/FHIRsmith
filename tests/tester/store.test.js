//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// tester/store.js: what is kept, and for how long

const fs = require('fs');
const os = require('os');
const path = require('path');
const { TesterStore } = require('../../tester/store');
const { renderTest } = require('../../tester/render');

const DAY = 24 * 60 * 60 * 1000;
const TOKEN = 'a-token-that-must-not-stay-in-the-file';

function run(store, id, finished) {
  store.queue({ id, server: 'https://example.org/fhir', token: TOKEN, userId: 1, userName: 'u' });
  store.started(id);
  store.addResult(id, 1, { group: 'g', name: 'a test', outcome: 'pass', exchanges: [{ request: { method: 'GET', url: 'x' }, response: { status: 200, body: 'secret data' } }], resources: [{ type: 'Patient', id: '1', resource: {} }] });
  store.finished(id, { status: 'completed', message: null, cleanup: null, report: null });
  store.db.prepare('UPDATE Runs SET Finished = ? WHERE Id = ?').run(finished, id);
}

describe('tester store', () => {
  let dir;
  let store;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tester-store-'));
    store = new TesterStore(path.join(dir, 'tester.db'));
  });
  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('secure_delete is on, and a finished run\'s token isn\'t left in the file', () => {
    expect(store.db.pragma('secure_delete', { simple: true })).toBe(1);
    run(store, 'r1', Date.now());
    store.db.pragma('wal_checkpoint(TRUNCATE)');
    const bytes = Buffer.concat(['tester.db', 'tester.db-wal'].filter(f => fs.existsSync(path.join(dir, f))).map(f => fs.readFileSync(path.join(dir, f))));
    expect(bytes.includes(Buffer.from(TOKEN))).toBe(false);
  });

  test('step details are cleared after a while, the run deleted later', () => {
    const now = Date.now();
    run(store, 'new', now - 5 * DAY);
    run(store, 'old', now - 40 * DAY);
    run(store, 'ancient', now - 200 * DAY);
    expect(store.purgeBefore(now - 183 * DAY)).toBe(1);
    expect(store.get('ancient')).toBeNull();
    expect(store.clearDetailsBefore(now - 30 * DAY, now)).toBe(1);
    // (once only)
    expect(store.clearDetailsBefore(now - 30 * DAY, now)).toBe(0);
    const old = store.result('old', 1);
    expect(old.Exchanges).toEqual([]);
    expect(old.Resources).toEqual([]);
    expect(old.Outcome).toBe('pass');
    expect(store.get('old').DetailsCleared).toBe(now);
    expect(store.result('new', 1).Exchanges.length).toBe(1);
    expect(store.get('new').DetailsCleared).toBeNull();
    // the page says why there's nothing to see
    const html = renderTest({ base: '/tester', run: store.get('old'), result: old, detailDays: 30 });
    expect(html).toMatch(/no longer kept: a run's step details are cleared 30 days after it/);
    expect(html).not.toMatch(/secret data/);
  });
});
