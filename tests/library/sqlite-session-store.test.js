// The express-session store that replaced connect-sqlite3 (library/sqlite-session-store.js)

const sqlite3 = require('sqlite3');
const { SqliteSessionStore } = require('../../library/sqlite-session-store');

const HOUR = 60 * 60 * 1000;

function openDb() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(':memory:', err => err ? reject(err) : resolve(db));
  });
}

function call(store, method, ...args) {
  return new Promise((resolve, reject) => {
    store[method](...args, (err, result) => err ? reject(err) : resolve(result));
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
}

function sess(data, maxAge = HOUR) {
  return { cookie: { maxAge, expires: new Date(Date.now() + maxAge).toISOString() }, ...data };
}

let db;
let store;

beforeEach(async () => {
  db = await openDb();
});

afterEach(async () => {
  if (store) {
    store.close();
    store = null;
  }
  await new Promise(resolve => db.close(resolve));
});

describe('SqliteSessionStore', () => {
  test('set, get and destroy', async () => {
    store = new SqliteSessionStore({ db });
    await call(store, 'set', 'abc', sess({ userId: 7 }));
    expect((await call(store, 'get', 'abc')).userId).toBe(7);
    expect(await call(store, 'length')).toBe(1);
    await call(store, 'destroy', 'abc');
    expect(await call(store, 'get', 'abc')).toBeNull();
  });

  test('an unknown session is null, not an error', async () => {
    store = new SqliteSessionStore({ db });
    expect(await call(store, 'get', 'nope')).toBeNull();
  });

  test('set replaces an existing session', async () => {
    store = new SqliteSessionStore({ db });
    await call(store, 'set', 'abc', sess({ n: 1 }));
    await call(store, 'set', 'abc', sess({ n: 2 }));
    expect((await call(store, 'get', 'abc')).n).toBe(2);
    expect(await call(store, 'length')).toBe(1);
  });

  test('an expired session is not returned, and touch does not revive it', async () => {
    store = new SqliteSessionStore({ db });
    await call(store, 'set', 'old', sess({ userId: 1 }, -1000));
    expect(await call(store, 'get', 'old')).toBeNull();
    await call(store, 'touch', 'old', sess({ userId: 1 }));
    expect(await call(store, 'get', 'old')).toBeNull();
  });

  test('touch extends a live session', async () => {
    store = new SqliteSessionStore({ db });
    await call(store, 'set', 'abc', sess({}, 1000));
    const later = sess({}, 10 * HOUR);
    await call(store, 'touch', 'abc', later);
    const rows = await all(db, 'SELECT expired FROM sessions WHERE sid = ?', ['abc']);
    expect(rows[0].expired).toBe(new Date(later.cookie.expires).getTime());
  });

  test('expired sessions are deleted at startup', async () => {
    await new Promise(resolve => db.run('CREATE TABLE sessions (sid PRIMARY KEY, expired, sess)', resolve));
    await new Promise(resolve => db.run('INSERT INTO sessions VALUES (?, ?, ?)', ['gone', Date.now() - 1000, '{}'], resolve));
    store = new SqliteSessionStore({ db });
    await store.ready;
    expect(await all(db, 'SELECT * FROM sessions')).toEqual([]);
  });

  test('reads sessions written by connect-sqlite3 (same table layout)', async () => {
    // connect-sqlite3's DDL and row format, verbatim
    await new Promise(resolve => db.exec('CREATE TABLE IF NOT EXISTS sessions (sid PRIMARY KEY, expired, sess)', resolve));
    const legacy = JSON.stringify({ cookie: { originalMaxAge: HOUR, httpOnly: true, path: '/' }, passport: { user: 42 } });
    await new Promise(resolve => db.run('INSERT OR REPLACE INTO sessions VALUES (?, ?, ?)', ['legacy', Date.now() + HOUR, legacy], resolve));
    store = new SqliteSessionStore({ db, table: 'sessions' });
    expect((await call(store, 'get', 'legacy')).passport.user).toBe(42);
  });

  test('clear removes everything', async () => {
    store = new SqliteSessionStore({ db });
    await call(store, 'set', 'a', sess({}));
    await call(store, 'set', 'b', sess({}));
    await call(store, 'clear');
    expect(await call(store, 'length')).toBe(0);
  });

  test('a session with no cookie expiry gets a day', async () => {
    store = new SqliteSessionStore({ db });
    await call(store, 'set', 'abc', { data: 1 });
    const rows = await all(db, 'SELECT expired FROM sessions');
    expect(rows[0].expired).toBeGreaterThan(Date.now() + 23 * HOUR);
  });

  test('rejects a missing database and an unsafe table name', () => {
    expect(() => new SqliteSessionStore({})).toThrow('needs an open sqlite3 database');
    expect(() => new SqliteSessionStore({ db, table: 'x; DROP TABLE users' })).toThrow('Invalid session table name');
  });

  test('close stops the cleanup timer', () => {
    store = new SqliteSessionStore({ db, cleanupIntervalMs: 1000 });
    expect(store.timer).not.toBeNull();
    store.close();
    expect(store.timer).toBeNull();
  });

  test('works as the express-session store', async () => {
    const express = require('express');
    const session = require('express-session');
    const http = require('http');
    store = new SqliteSessionStore({ db });
    const app = express();
    app.use(session({ store, secret: 'test', resave: false, saveUninitialized: false, rolling: true, cookie: { maxAge: HOUR } }));
    app.get('/login', (req, res) => { req.session.userId = 5; res.send('ok'); });
    app.get('/me', (req, res) => res.send(String(req.session.userId || 'none')));
    const server = app.listen(0);
    try {
      const port = server.address().port;
      const get = (p, cookie) => new Promise((resolve, reject) => {
        http.get({ port, path: p, headers: cookie ? { cookie } : {} }, res => {
          let body = '';
          res.on('data', d => { body += d; });
          res.on('end', () => resolve({ body, cookie: (res.headers['set-cookie'] || [])[0] }));
        }).on('error', reject);
      });
      const login = await get('/login');
      const cookie = login.cookie.split(';')[0];
      expect((await get('/me', cookie)).body).toBe('5');
      expect((await get('/me')).body).toBe('none');
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});
