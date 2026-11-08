/**
 * server.cluster.sharedClosure with real processes: a master and two tx-workers behind
 * cluster.js, all answering $closure on databases/closure.db.
 *
 * Contention: 3 processes x 4 clients add concepts at once - all of them to one table, and
 * in fours to four more tables - each client a request at a time, one or two concepts per
 * request, with overlaps between clients. Then each table is checked against a reference
 * built by a single writer, and against the responses the clients were given:
 *  - the same concepts (none lost, none twice) and the same entries (none lost, none twice)
 *  - versions go up by one per write, with no gaps; every write was answered with its own
 *    version and exactly the entries stored at that version
 *  - "changes since v", asked of any process, is the union of the answers after v, for
 *    every v
 * Also: 12 concurrent creates of one table make exactly one; creates racing for the table
 * limit stop exactly at it; and $closure through the launcher reaches the workers.
 */
const path = require('path');
const Database = require('better-sqlite3');
const { startCluster, request, sleep } = require('../utils/cluster-harness');
const fs = require('fs');

const FRONT = 20070;
const VSAC = 20079;
const MAX_TABLES = 40;
const NARROWER = 'source-is-narrower-than-target';
const SYS = 'http://example.org/closure-contention/cs';

// a ternary tree of 40 concepts: c0 is the root, the parent of ci is c((i-1)/3)
const N = 40;
function tree(i) {
  const kids = [];
  for (let j = 3 * i + 1; j <= 3 * i + 3 && j < N; j++) {
    kids.push(tree(j));
  }
  return { code: `c${i}`, display: `C${i}`, ...(kids.length ? { concept: kids } : {}) };
}
const CS = { resourceType: 'CodeSystem', url: SYS, version: '1', status: 'active', content: 'complete', hierarchyMeaning: 'is-a', concept: [tree(0)] };

const params = (...parameter) => ({ resourceType: 'Parameters', parameter });
const name = n => ({ name: 'name', valueString: n });
const concept = code => ({ name: 'concept', valueCoding: { system: SYS, code } });
const closure = (port, body) => request(port, 'POST', '/r4/$closure', { body });

function entries(cm) {
  const out = [];
  for (const g of (cm && cm.group) || []) {
    for (const e of g.element || []) {
      for (const t of e.target || []) {
        out.push(`${e.code}>${t.code}`);
      }
    }
  }
  return out.sort();
}

// a deterministic shuffle, so a failure can be run again the same way
function rng(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}
function shuffle(list, rand) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

describe('cluster.js with server.cluster.sharedClosure', () => {
  let cluster;
  let ports;
  let db;
  const stats = { busy: 0, retriesLogged: 0 };

  beforeAll(async () => {
    cluster = await startCluster({
      front: FRONT, vsac: VSAC, cluster: { sharedClosure: true },
      tx: { closure: { enabled: true, maxTables: MAX_TABLES } }
    });
    ports = [cluster.master, ...cluster.workers];
    db = new Database(path.join(cluster.dir, 'databases', 'closure.db'), { readonly: true });
  }, 330000);

  afterAll(async () => {
    if (db) {
      db.close();
    }
    if (cluster) {
      // (the processes log to logs/server.log; the dated file is a copy)
      const log = fs.readFileSync(path.join(cluster.dir, 'logs', 'server.log'), 'utf8');
      stats.retriesLogged = (log.match(/working the add out again/g) || []).length;
      // for the record: how much contention the run produced
      console.log(`shared closure: ${stats.retriesLogged} retries after a conflict, ${stats.busy} busy answers (retried by the client)`);
      await cluster.stop();
    }
  });

  // one client: add its concepts a request at a time; a busy answer (429) is retried, as a
  // client would. Returns what each successful add was answered with.
  async function client(port, table, codes, rand) {
    const answers = [];
    let i = 0;
    while (i < codes.length) {
      const take = rand() < 0.5 ? 1 : 2;
      const batch = codes.slice(i, i + take);
      const r = await closure(port, params(name(table), ...batch.map(concept)));
      if (r.status === 429) {
        stats.busy++;
        await sleep(5 + rand() * 20);
        continue;
      }
      expect(r.status).toBe(200);
      answers.push({ version: Number(r.json.version), entries: entries(r.json), codes: batch });
      i += take;
    }
    return answers;
  }

  // the table as stored: concepts, entries by the version they were added in, the version
  function stored(table) {
    const t = db.prepare('SELECT id, version FROM closure_table WHERE name = ?').get(table);
    const concepts = db.prepare('SELECT code, added_version FROM closure_concept WHERE table_id = ?').all(t.id);
    const rows = db.prepare(`SELECT s.code AS s, t.code AS t, e.relationship AS rel, e.added_version AS v
      FROM closure_entry e JOIN closure_concept s ON s.id = e.source_id JOIN closure_concept t ON t.id = e.target_id
      WHERE e.table_id = ?`).all(t.id);
    return { version: t.version, concepts, rows };
  }

  async function reference(table, codes) {
    expect((await closure(cluster.master, params(name(table), { name: 'tx-resource', resource: CS }))).status).toBe(200);
    const r = await closure(cluster.master, params(name(table), ...[...codes].sort().map(concept)));
    expect(r.status).toBe(200);
    return entries(r.json);
  }

  async function check(table, answers, codes, ref) {
    const s = stored(table);
    // concepts: every one asked for, once
    const asked = new Set(codes);
    expect(s.concepts.map(c => c.code).sort()).toEqual([...asked].sort());
    // entries: the reference's, once each, all narrower-than in this code system
    expect(s.rows.map(r => `${r.s}>${r.t}`).sort()).toEqual(ref);
    expect(s.rows.every(r => r.rel === NARROWER)).toBe(true);
    // versions: one per write, 1..version, no gaps
    const versions = [...new Set(s.concepts.map(c => c.added_version))].sort((a, b) => a - b);
    expect(versions).toEqual(Array.from({ length: s.version }, (_, i) => i + 1));
    // every write was answered with its version and exactly the entries stored at it
    const byVersion = new Map();
    for (const r of s.rows) {
      byVersion.set(r.v, [...(byVersion.get(r.v) || []), `${r.s}>${r.t}`]);
    }
    const writes = answers.filter(a => a.entries.length > 0);
    expect(new Set(writes.map(a => a.version)).size).toBe(writes.length);
    for (const a of writes) {
      expect(a.entries).toEqual((byVersion.get(a.version) || []).sort());
    }
    for (const v of byVersion.keys()) {
      expect(writes.some(a => a.version === v)).toBe(true);
    }
    // no answer claims a version the table hasn't reached
    expect(Math.max(...answers.map(a => a.version))).toBeLessThanOrEqual(s.version);
    // changes since v, from any process, for every v
    for (let v = 0; v <= s.version; v++) {
      const r = await closure(ports[v % ports.length], params(name(table), { name: 'version', valueString: String(v) }));
      expect(r.status).toBe(200);
      expect(Number(r.json.version)).toBe(s.version);
      const fromAnswers = writes.filter(a => a.version > v).flatMap(a => a.entries).sort();
      expect(entries(r.json)).toEqual(fromAnswers);
    }
  }

  test('3 processes x 4 clients adding to one table and to four others: the tables a single writer makes', async () => {
    const all = Array.from({ length: N }, (_, i) => `c${i}`);
    const tables = ['S', 'D0', 'D1', 'D2', 'D3'];
    for (const t of tables) {
      expect((await closure(ports[tables.indexOf(t) % 3], params(name(t), { name: 'tx-resource', resource: CS }))).status).toBe(200);
    }
    const runs = [];
    const plan = [];
    for (let p = 0; p < 3; p++) {
      for (let k = 0; k < 4; k++) {
        const c = p * 4 + k;
        const rand = rng(1000 + c);
        // the shared table: every concept is someone's, and each client takes 6 others too
        const mine = all.filter((_, i) => i % 12 === c);
        const S = shuffle([...mine, ...shuffle(all, rand).slice(0, 6)].filter((x, i, a) => a.indexOf(x) === i), rand);
        // its four-way table: the three clients with this k share it
        const D = shuffle(all.filter((_, i) => i % 4 === k || i % 7 === p), rand);
        plan.push({ table: 'S', codes: S }, { table: `D${k}`, codes: D });
        runs.push(client(ports[p], 'S', S, rand).then(answers => ({ table: 'S', answers })));
        runs.push(client(ports[p], `D${k}`, D, rng(2000 + c)).then(answers => ({ table: `D${k}`, answers })));
      }
    }
    const results = await Promise.all(runs);

    for (const t of tables) {
      const codes = [...new Set(plan.filter(x => x.table === t).flatMap(x => x.codes))];
      const answers = results.filter(r => r.table === t).flatMap(r => r.answers);
      const ref = await reference(`${t}-reference`, codes);
      expect(ref.length).toBeGreaterThan(0);
      await check(t, answers, codes, ref);
    }
  }, 300000);

  test('12 concurrent creates of one table, on three processes: exactly one makes it', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      closure(ports[i % 3], params(name('race'), { name: 'tx-resource', resource: CS }))));
    const statuses = results.map(r => r.status).sort();
    expect(statuses.filter(s => s === 200)).toHaveLength(1);
    expect(statuses.filter(s => s === 409)).toHaveLength(11);
    expect(db.prepare("SELECT count(*) AS n FROM closure_table WHERE name = 'race'").get().n).toBe(1);
  }, 60000);

  test('creates racing for the table limit stop exactly at it', async () => {
    const before = db.prepare('SELECT count(*) AS n FROM closure_table').get().n;
    const room = MAX_TABLES - before;
    expect(room).toBeGreaterThan(5);
    const tries = room + 15;
    const results = await Promise.all(Array.from({ length: tries }, (_, i) =>
      closure(ports[i % 3], params(name(`limit-${i}`)))));
    expect(results.filter(r => r.status === 200)).toHaveLength(room);
    expect(results.filter(r => r.status === 422)).toHaveLength(15);
    expect(db.prepare('SELECT count(*) AS n FROM closure_table').get().n).toBe(MAX_TABLES);
  }, 60000);

  test('$closure through the launcher is answered', async () => {
    // (that the launcher sends it to the least-loaded tx process is in cluster-launcher.test.js)
    const rs = await Promise.all(Array.from({ length: 30 }, () => closure(FRONT, params(name('S'), { name: 'version', valueString: '0' }))));
    expect(rs.every(r => r.status === 200)).toBe(true);
  }, 60000);
});
