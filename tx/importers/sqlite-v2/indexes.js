'use strict';

// Index builder for the terminology file: drops and recreates every ix_* table from the fact tables.
// Runnable on a built file whose ix_* tables were dropped (node indexes.js <file>); the result is
// the same as the builder's. Rows listed in meta 'derived-by-importer' (terminology logic: SNOMED
// normal forms in ix_key, the SNOMED walk in ix_order, LOINC's orders) are kept as they are, with
// their meta keys. Facts about an index are meta keys 'ix.<table>.<name>', owned here.
//
//   ix_set           all, active, leaf, descendants (closure of the active subsumption links between
//                    concepts, or the explicit pairs of the catalog's closure_from property),
//                    property = value (for the properties a filter can name: filterable, or a member of
//                    a filterable union) and has-property (every property), from the active link /
//                    literal rows about concepts (not for a closure_from source: its sets are the
//                    descendants),
//                    record members (active rows about concepts)
//   ix_in            links by target, for the catalog rows with by_target = 1
//   ix_by_subject    identifier rows by subject, for the catalog rows with by_subject = 1
//   ix_text_display  concept.display, rowid = concept id
//   ix_text_item     item.text, rowid = item id
//   ix_order         the reader's system order (tx/sqlite-v2/orders.js computeOrder: rank and ids)
//   ix_word          the reader's word index (tx/sqlite-v2/text-index.js rules over the names
//                    tx/sqlite-v2/text-index.js eachName lists)
//   ix_key           nothing generic (SNOMED normal forms are derived-by-importer)

const Database = require('better-sqlite3');
const { serialize, rangeSet, descendantsFromEdges, descendantsFromPairs } = require('../sqlite-v2/sets');
const sets = require('../sqlite-v2/sets');
const dialectOf = (uri) => require('../../sqlite-v2/dialects').dialectFor(uri).name;

const KIND = { all: 1, active: 2, leaf: 3, descendants: 4, prop: 5, hasProp: 6, record: 7 };
const VK = { none: 0, node: 1, literal: 2 };
const ORDER_BLOCK = 1024;

function ixDdl() {
  const { schemaSections } = require('./builder');
  // IF NOT EXISTS: a table that holds derived-by-importer rows is kept (rows of other names deleted)
  return schemaSections().ix.replace(/CREATE (TABLE|INDEX|VIRTUAL TABLE) (?!IF NOT EXISTS)/g, 'CREATE $1 IF NOT EXISTS ');
}

function ixTables(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ix\\_%' ESCAPE '\\' AND sql IS NOT NULL AND name NOT LIKE 'ix\\_text\\_%\\_%' ESCAPE '\\'").pluck().all();
}

/** meta 'derived-by-importer': [{table, name}] (ix_key / ix_order rows the importer writes) */
function derivedByImporter(db) {
  const v = db.prepare("SELECT value FROM main.meta WHERE key = 'derived-by-importer'").pluck().get();
  const list = v ? JSON.parse(v) : [];
  for (const d of list) if (d.table !== 'ix_key' && d.table !== 'ix_order') throw new Error(`derived-by-importer: ${d.table} rows cannot be kept`);
  return list;
}

/**
 * drop every ix_* table (FTS shadow tables go with their virtual table) and the ix meta keys,
 * except the derived-by-importer rows: their tables keep those rows (and only those)
 */
function dropIndexes(db) {
  const derived = derivedByImporter(db);
  const keep = new Map();
  for (const d of derived) { if (!keep.has(d.table)) keep.set(d.table, []); keep.get(d.table).push(d.name); }
  for (const t of ixTables(db)) {
    const names = keep.get(t);
    if (names) db.prepare(`DELETE FROM "${t}" WHERE name NOT IN (SELECT value FROM json_each(?))`).run(JSON.stringify(names));
    else db.exec(`DROP TABLE IF EXISTS "${t}"`);
  }
  const keepKeys = derived.map((d) => `ix.${d.table}.${d.name}.`);
  for (const k of db.prepare("SELECT key FROM meta WHERE key LIKE 'ix.%'").pluck().all()) {
    if (!keepKeys.some((p) => k.startsWith(p))) db.prepare('DELETE FROM meta WHERE key = ?').run(k);
  }
}

/**
 * @param {Database} db a writable connection to a built file
 * @param {object} [opts] { log, time(name, fn) }
 */
function buildIndexes(db, opts = {}) {
  const time = opts.time || ((name, fn) => fn());
  dropIndexes(db);
  db.exec(ixDdl());
  const cs = db.prepare('SELECT cs_id, uri, concept_count AS n, active_count AS a, default_language FROM main.code_system WHERE served = 1').get();
  const n = cs.n;
  const stats = {};
  db.exec('BEGIN');
  stats.sets = time('ix_set', () => buildSets(db, n, cs.a));
  stats.in = time('ix_in', () => db.prepare(`INSERT INTO ix_in SELECT target_id, property_id, active, group_id, coalesce(seq, 0), subject_id
    FROM main.link WHERE property_id IN (SELECT id FROM main.property WHERE by_target = 1) ORDER BY 1, 2, 3, 4, 5, 6`).run().changes);
  stats.bySubject = time('ix_by_subject', () => db.prepare(`INSERT INTO ix_by_subject SELECT subject_id, property_id, value
    FROM main.identifier WHERE property_id IN (SELECT id FROM main.property WHERE by_subject = 1) ORDER BY 1, 2, 3`).run().changes);
  stats.textDisplay = time('ix_text_display', () => db.prepare(`INSERT INTO ix_text_display(rowid, text) SELECT id, display FROM main.concept
    WHERE display IS NOT NULL AND display <> '' ORDER BY id`).run().changes);
  stats.textItem = time('ix_text_item', () => db.prepare('INSERT INTO ix_text_item(rowid, text) SELECT id, text FROM main.item ORDER BY id').run().changes);
  db.exec('COMMIT');

  // the reader's orders and word index, from the fact tables (tx/sqlite-v2/orders.js, text-index.js)
  const dialect = dialectOf(cs.uri);
  const { Store } = require('../../sqlite-v2/store');
  const { orderKind, computeOrder } = require('../../sqlite-v2/orders');
  const { computeTextIndexFrom, indexed, FORMAT } = require('../../sqlite-v2/text-index');
  const { stem } = require('../../library/text-match');
  db.exec('BEGIN');
  const kind = orderKind(dialect);
  const derived = new Set(derivedByImporter(db).filter((d) => d.table === 'ix_order').map((d) => d.name));
  if (kind && !['rank', 'ids'].every((x) => derived.has(x))) {
    stats.order = time('ix_order', () => writeOrder(db, computeOrder(db, kind, n, { walk: false }), derived));
  }
  if (indexed(dialect)) {
    const store = new Store(db.name, { db, unregistered: true });
    stats.words = time('ix_word', () => writeWords(db, computeTextIndexFrom((fn) => store.eachSearchName(dialect, fn), dialect, n), stem));
    db.prepare("INSERT OR REPLACE INTO main.meta VALUES ('ix.ix_word.format', ?)").run(FORMAT);
  }
  // the 'active' order from a walk an importer kept (derived-by-importer); importers that write
  // the walk after this call it again
  stats.activeOrder = writeActiveOrder(db);
  db.exec('COMMIT');
  return stats;
}

function buildSets(db, n, activeCount) {
  const ins = db.prepare('INSERT INTO ix_set VALUES (?, ?, ?, ?, ?, ?)');
  const stats = {};
  // the sets by key, written after the reads (one connection); a key met twice (rows about
  // concepts, then rows about items projected to their concepts) is the union
  const out = new Map();
  const put = (kind, pid, vk, value, bm) => {
    if (bm.size === 0) return;
    const k = kind + '|' + pid + '|' + vk + '|' + (typeof value === 'string' ? 's' : 'n') + value;
    const cur = out.get(k);
    if (cur) cur[4].orInPlace(bm); else out.set(k, [kind, pid, vk, value, bm]);
  };
  // rows about items count for their concept (the item -> concept projection: an atom's
  // relationship, a description's refset row); language relations rank displays, no sets
  const hasItemRows = (table) => !!db.prepare(`SELECT 1 FROM main.${table} WHERE subject_id > ${n} LIMIT 1`).get();
  const projected = (table, cols, where) => `SELECT ${cols}, i.concept_id FROM main.${table} x JOIN main.item i ON i.id = x.subject_id
    WHERE x.active = 1 AND x.subject_id > ${n} ${where} ORDER BY 1, 2, 3`;
  put(KIND.all, 0, VK.none, 0, rangeSet(1, n));
  put(KIND.active, 0, VK.none, 0, rangeSet(1, activeCount));

  // descendants: the explicit pairs of a closure_from property, else the closure of the active
  // subsumption links between concepts
  const sub = db.prepare('SELECT id, closure_from FROM main.property WHERE subsumption = 1').all();
  const from = sub.map((p) => p.closure_from).filter((x) => x != null);
  let res;
  if (from.length) {
    // explicit (descendant -> ancestor) pairs as links of the closure_from property
    const [d, a] = intPairs(db.prepare(`SELECT subject_id, target_id FROM main.link WHERE active = 1 AND property_id IN (${from.join(',')})
      AND subject_id <= ${n} AND target_id <= ${n}`));
    res = descendantsFromPairs(n, d, a);
  } else {
    const [c, p] = sub.length
      ? intPairs(db.prepare(`SELECT subject_id, target_id FROM main.link WHERE active = 1 AND property_id IN (${sub.map((x) => x.id).join(',')})
        AND subject_id <= ${n} AND target_id <= ${n}`))
      : [new Int32Array(0), new Int32Array(0)];
    res = descendantsFromEdges(n, c, p);
  }
  if (res.cyclic) throw new Error(`hierarchy has a cycle: ${res.cyclic} concepts could not be closed`);
  const leaf = new sets.RoaringBitmap32();
  for (let id = 1; id <= n; id++) {
    const d = res.desc[id];
    if (d) put(KIND.descendants, 0, VK.node, id, d);
    else if (id <= activeCount) leaf.add(id);
  }
  put(KIND.leaf, 0, VK.none, 0, leaf);

  // property = value and has-property, from the active rows about concepts (not the closure
  // sources: their rows are the descendants sets above)
  const closureSources = from.length ? `AND property_id NOT IN (${from.join(',')})` : '';
  const has = new Map();
  const hasOf = (p) => { let b = has.get(p); if (!b) has.set(p, b = new sets.RoaringBitmap32()); return b; };
  // kind 5 sets only for what a filter can name: filterable rows, and the members of a filterable
  // union (a REL's RELAs); has-property sets for every property
  const named = new Set(db.prepare('SELECT id FROM main.property WHERE filterable = 1').pluck().all());
  const memberRows = db.prepare('SELECT parent_id, child_id FROM main.property_member').raw().all();
  for (let grew = true; grew;) {
    grew = false;
    for (const [a, c] of memberRows) if (named.has(a) && !named.has(c)) { named.add(c); grew = true; }
  }
  const passes = [];
  for (const [table, val, vk] of [['link', 'target_id', VK.node], ['literal', 'value', VK.literal]]) {
    passes.push([vk, `SELECT property_id, ${val}, subject_id FROM main.${table} WHERE active = 1 AND subject_id <= ${n}
      ${table === 'link' ? closureSources : ''} ORDER BY property_id, ${val}, subject_id`]);
    if (hasItemRows(table)) passes.push([vk, projected(table, `x.property_id, x.${val}`, table === 'link' ? closureSources.replace('property_id', 'x.property_id') : '')]);
  }
  for (const [vk, sql] of passes) {
    const it = db.prepare(sql).raw().iterate();
    let curP = null, curV, members = [];
    const flush = () => {
      if (curP === null) return;
      const bm = new sets.RoaringBitmap32(members);
      if (named.has(curP)) put(KIND.prop, curP, vk, curV, bm);
      hasOf(curP).orInPlace(bm);
      members = [];
    };
    // rows arrive grouped by (property, value); !== keeps 1 and '1' apart
    for (const [p, v, s] of it) {
      if (p !== curP || v !== curV) { flush(); curP = p; curV = v; }
      members.push(s);
    }
    flush();
  }
  // an inverse_of row's has-property set is the targets of the property it reverses (of
  // each member, for a union): `child exists`, `AnswerList exists` read one bitmap
  const union = new Map();
  for (const [a, c] of db.prepare('SELECT parent_id, child_id FROM main.property_member').raw().all()) {
    if (!union.has(a)) union.set(a, []);
    union.get(a).push(c);
  }
  const reversed = (pid) => (union.has(pid) ? union.get(pid).flatMap(reversed) : [pid]);
  for (const [inv, of] of db.prepare('SELECT id, inverse_of FROM main.property WHERE inverse_of IS NOT NULL').raw().all()) {
    const pids = reversed(of);
    const ids = db.prepare(`SELECT DISTINCT target_id FROM main.link WHERE active = 1 AND subject_id <= ${n} AND target_id <= ${n}
      AND property_id IN (${pids.join(',')}) ORDER BY 1`).pluck().all();
    if (ids.length) has.set(inv, new sets.RoaringBitmap32(ids));
  }
  // a property with both shapes has one has-property set (the union)
  for (const [p, bm] of [...has].sort((a, b) => a[0] - b[0])) put(KIND.hasProp, p, VK.none, 0, bm);

  // record members (active rows about concepts, and about items projected), per relation
  const lang = db.prepare("SELECT id FROM main.property WHERE role = 'language'").pluck().all();
  const recordPasses = [`SELECT DISTINCT relation_id, subject_id FROM main.record WHERE active = 1 AND subject_id <= ${n} ORDER BY 1, 2`];
  if (hasItemRows('record')) recordPasses.push(projected('record', 'x.relation_id, 0', lang.length ? `AND x.relation_id NOT IN (${lang.join(',')})` : '').replace('ORDER BY 1, 2, 3', 'ORDER BY 1, 3'));
  for (const sql of recordPasses) {
    let cur = null, members = [];
    const flushR = () => { if (cur !== null) put(KIND.record, cur, VK.none, 0, new sets.RoaringBitmap32(members)); members = []; };
    for (const row of db.prepare(sql).raw().iterate()) {
      const r = row[0], s = row[row.length - 1];
      if (r !== cur) { flushR(); cur = r; }
      members.push(s);
    }
    flushR();
  }
  for (const [kind, pid, vk, value, bm] of out.values()) {
    const buf = serialize(bm);
    ins.run(kind, pid, vk, value, bm.size, buf);
    const st = stats[kind] || (stats[kind] = { sets: 0, members: 0, bytes: 0 });
    st.sets++; st.members += bm.size; st.bytes += buf.length;
  }
  const names = Object.fromEntries(Object.entries(KIND).map(([k, v]) => [v, k]));
  return Object.fromEntries(Object.entries(stats).map(([k, s]) => [names[k], s]));
}

/**
 * {rank, ids, walk} Uint32Arrays -> ix_order rows of ORDER_BLOCK entries (names in `skip`: kept
 * as the importer wrote them). An array's `reached` (the SNOMED walk: how many concepts the walk
 * reaches) goes to meta 'ix.ix_order.<name>.reached'.
 */
function writeOrder(db, order, skip = new Set()) {
  const ins = db.prepare('INSERT INTO ix_order VALUES (?, ?, ?)');
  let rows = 0;
  for (const name of ['rank', 'ids', 'walk']) {
    const a = order[name];
    if (!a || skip.has(name)) continue;
    rows += writeOrderArray(db, name, a, ins);
  }
  return rows;
}

function writeOrderArray(db, name, a, ins = db.prepare('INSERT INTO ix_order VALUES (?, ?, ?)')) {
  let rows = 0;
  for (let b = 0; b * ORDER_BLOCK < a.length; b++) {
    const part = a.subarray(b * ORDER_BLOCK, Math.min(a.length, (b + 1) * ORDER_BLOCK));
    ins.run(name, b, toLE(part));
    rows++;
  }
  if (a.reached != null) db.prepare('INSERT OR REPLACE INTO main.meta VALUES (?, ?)').run(`ix.ix_order.${name}.reached`, String(a.reached));
  return rows;
}

/**
 * The standard order 'active': the walk restricted to the active concepts (ids 1..active_count),
 * stored only where they are not a prefix of the walk (else a reader takes the walk's first
 * active_count entries). Called after the walk is written; replaces an earlier 'active'.
 * @returns {number} rows written (0: not needed)
 */
function writeActiveOrder(db) {
  db.prepare("DELETE FROM main.ix_order WHERE name = 'active'").run();
  const blocks = db.prepare("SELECT data FROM main.ix_order WHERE name = 'walk' ORDER BY block").pluck().all();
  if (!blocks.length) return 0;
  const buf = Buffer.concat(blocks);
  const walk = new Uint32Array(buf.length / 4);
  for (let i = 0; i < walk.length; i++) walk[i] = buf.readUInt32LE(i * 4);
  const a = db.prepare('SELECT active_count FROM main.code_system WHERE served = 1').pluck().get();
  let prefix = walk.length >= a;
  for (let i = 0; prefix && i < a; i++) if (walk[i] > a) prefix = false;
  if (prefix) return 0;
  return writeOrderArray(db, 'active', walk.filter((id) => id <= a));
}

function toLE(a) {
  const buf = Buffer.alloc(a.length * 4);
  for (let i = 0; i < a.length; i++) buf.writeUInt32LE(a[i], i * 4);
  return buf;
}

/** computeTextIndex's Map(lang -> {words, counts}) -> ix_word rows; the counts in the row with word '' */
function writeWords(db, byLang, stem) {
  const ins = db.prepare('INSERT INTO ix_word VALUES (?, ?, ?, ?)');
  let words = 0;
  for (const [lang, x] of byLang) {
    for (const [w, ids] of x.words) {
      if (w === '') throw new Error("ix_word: an empty word (the row with word '' holds the counts)");
      ins.run(lang, w, stem(w, lang), new sets.RoaringBitmap32(ids).serialize('portable'));
      words++;
    }
    if (x.counts) ins.run(lang, '', '', Buffer.from(x.counts.buffer, x.counts.byteOffset, x.counts.byteLength));
  }
  return words;
}

function intPairs(stmt) {
  const a = [], b = [];
  for (const [x, y] of stmt.raw().iterate()) { a.push(x); b.push(y); }
  return [Int32Array.from(a), Int32Array.from(b)];
}

module.exports = { buildIndexes, dropIndexes, ixTables, derivedByImporter, writeOrderArray, writeActiveOrder, KIND, VK };

// node indexes.js <file> [--drop-only]: rebuild (or only drop) the ix_* tables of a built file
if (require.main === module) {
  const [file, flag] = process.argv.slice(2);
  const db = new Database(file);
  db.pragma('journal_mode = OFF');
  db.pragma('synchronous = OFF');
  const t0 = Date.now();
  if (flag === '--drop-only') { dropIndexes(db); db.exec('VACUUM'); console.log('dropped'); } else {
    const s = buildIndexes(db, { time: (name, fn) => { const t = Date.now(); const r = fn(); console.error(`${name}: ${((Date.now() - t) / 1000).toFixed(1)} s`); return r; } });
    require('./builder').analyze(db);
    console.log(JSON.stringify({ seconds: (Date.now() - t0) / 1000, ...s }));
  }
  db.close();
}
