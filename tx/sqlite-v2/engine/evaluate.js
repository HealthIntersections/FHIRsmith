'use strict';
// Set evaluation of IR nodes over one store (one release of one code system).
//
// IR (all ids are concept_ids = bit positions):
//   {t:'all'} {t:'active'} {t:'inactive'} {t:'leaf'} {t:'empty'}
//   {t:'ids', ids}                                explicit concepts
//   {t:'set', kind, pid, value}                   one stored set (descendants, prop, hasProp, refset)
//   {t:'self', id, of:node}                       node ∪ {id}
//   {t:'anc', id, self} {t:'parents', id, self}   upward walks over hierarchy facts
//   {t:'hier', dir, self, of}                     hierarchy operator applied to a set
//   {t:'propIn', pids, values:node}               concepts with P -> a member of values
//   {t:'propOf', pids, sources:node}              targets of P from sources (reverse / dotted)
//   {t:'litIn', pid, values} {t:'litMatch', pid, re}  literal-valued property
//   {t:'text', field:'code'|'display', re}        regex on code / display
//   {t:'search', text, mode, lang}                full-text (FTS), in one language (lang) or all
//   {t:'group', attrs:[{pids, values}]}           attributes satisfied inside one role group
//   {t:'and', items} {t:'or', items} {t:'minus', a, b}
//   {t:'layer', layer, node}                      node evaluated on a supplement layer (same ids)
//
// Cost classes: stored sets and explicit ids are "free" (one batched read, exact size); the
// others ("costly") read facts. An intersection evaluates its free inputs first, smallest first,
// then narrows the candidates with each costly input by probing the candidates' facts when there
// are few of them, or by materialising the input when that is cheaper.

const { RoaringBitmap32 } = require('roaring');
const { KIND, count } = require('../store');
const regexUtilities = require('../../../library/regex-utilities');
const { ftsQuery, stripAnyAffixes } = require('./regex-literals');
const { settings, TooCostly } = require('../settings');

const PROBE_MAX = 20000;      // probe a costly input when the candidates are at most this many
const SCAN_CHUNK = 4096;      // lazy evaluation: candidates examined per chunk
const ROW_CHUNK = 5000;       // rows read and tested per statement between pauses (scans, probes)

// Cooperative evaluation. The evaluation steps are generators: a bare `yield` marks a pause
// point between chunks of a long read, `yield*` runs a sub-step. runSync drives one straight
// through (the sync API: compile.js, stored code systems); runAsync awaits `pause` (the request's
// opContext.checkAndYield, which gives the event loop a turn every 10 ms of compute) at each
// pause point, so a long evaluation does not hold the worker's event loop. better-sqlite3 is
// synchronous and a connection cannot run another statement while an iterator is open, so no
// statement iterator is held across a pause: long scans read bounded chunks with .all().
function runSync(g) {
  let r = g.next();
  while (!r.done) r = g.next();
  return r.value;
}

async function runAsync(g, pause) {
  let r = g.next();
  while (!r.done) {
    try {
      await pause();
    } catch (e) {
      g.return();
      throw e;
    }
    r = g.next();
  }
  return r.value;
}

/** run a generator step inside a trace span (as Tracer.span does for a function) */
function* spanG(trace, label, kind, system, g) {
  const s = trace.open(label, kind, system);
  let r = null;
  let ok = false;
  try {
    r = yield* g;
    ok = true;
    return r;
  } catch (e) {
    s.error = e.message;
    throw e;
  } finally {
    trace.close(s, ok ? r : null);
  }
}

const FREE = new Set(['all', 'active', 'inactive', 'leaf', 'empty', 'ids', 'set']);

class Unsupported extends Error {
  constructor(reason, detail) {
    super(reason + (detail ? ': ' + detail : ''));
    this.reason = reason;
    this.detail = detail;
    this.unsupported = true;
  }
}

function key(node) {
  let k = node._key;
  if (!k) {
    k = JSON.stringify(node, (n, v) => {
      if (n === '_key' || n === 'why' || n === 'label' || n === 'eclOrder') return undefined; // eclOrder: order only (engine.js)
      if (n === 'layer') return 'L' + v.id; // a supplement layer: its identity, not its content
      if (n === 'from') return 'S' + v.uid; // another file of the same system
      return v;
    });
    Object.defineProperty(node, '_key', { value: k, enumerable: false });
  }
  return k;
}

/** a short human label for a node (trace spans) */
function label(node) {
  if (node.label) return node.label;
  switch (node.t) {
    case 'set': return ['', 'all', 'active', 'leaf', 'descendants', 'prop', 'hasProp', 'refset'][node.kind] + (node.pid ? ' p' + node.pid : '') + (node.kind > 3 ? ' ' + node.value : '');
    case 'ids': return node.ids.length + ' codes';
    case 'and': case 'or': return node.t + '(' + node.items.length + ')';
    case 'text': return node.field + ' ~ /' + node.re + '/';
    case 'litMatch': return 'p' + node.pid + ' ~ /' + node.re + '/';
    case 'search': return 'search "' + node.text + '"';
    default: return node.t;
  }
}

class Evaluator {
  /**
   * @param {V2Store} store
   * @param {object} [opts] { trace: Tracer|null }
   */
  constructor(store, opts = {}) {
    this.store = store;
    this.trace = opts.trace || null;
    this.stats = this.trace ? this.trace.stats : null;
    this.memo = new Map();
    this.local = new Map(); // stored sets read in this evaluation (read once, used by every step)
    this.history = new Map(); // association indexes built in this evaluation
    this.spent = 0; // planner estimate of fact rows this evaluation reads
  }

  /** account for an estimated read before doing it; refuse when over the budget */
  spend(rows, what) {
    this.spent += rows;
    if (this.spent > settings.maxScanRows) {
      throw new TooCostly(`estimated cost ${Math.round(this.spent).toLocaleString('en-US')} rows (${what}) > ${settings.maxScanRows.toLocaleString('en-US')}`);
    }
  }

  isFree(node) {
    if (FREE.has(node.t)) return true;
    if (node.t === 'self') return this.isFree(node.of);
    if (node.t === 'and' || node.t === 'or') return node.items.every((i) => this.isFree(i));
    if (node.t === 'minus') return this.isFree(node.a) && this.isFree(node.b);
    if (node.t === 'propIn') return this.isFree(node.values);
    return this.memo.has(key(node));
  }

  /** load every stored-set leaf of a plan with one statement per (kind, property) */
  prefetch(nodes) {
    const want = new Map();
    const walk = (n) => {
      if (!n || typeof n !== 'object') return;
      if (n.t === 'layer' || n.t === 'xlate') return;
      if (n.t === 'set') {
        const k = n.kind + ':' + n.pid;
        if (!want.has(k)) want.set(k, { kind: n.kind, pid: n.pid, values: new Set() });
        want.get(k).values.add(n.value);
        return;
      }
      for (const v of Object.values(n)) {
        if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === 'object' && v.t) walk(v);
      }
    };
    nodes.forEach(walk);
    if (!want.size) return;
    const run = () => {
      for (const w of want.values()) this.store.loadSets(w.kind, w.pid, [...w.values], this.stats, this.local);
    };
    if (this.trace) this.trace.span('load stored sets (' + [...want.values()].reduce((n, w) => n + w.values.size, 0) + ' keys, ' + want.size + ' statements)', 'set', this.store.system, run);
    else run();
  }

  // ---- materialise -------------------------------------------------------------------------

  /** the members of a node (sync: no pauses) */
  mat(node) { return runSync(this.matG(node)); }

  /** the members of a node, pausing between chunks (pause: the request's checkAndYield) */
  matAsync(node, pause) { return pause ? runAsync(this.matG(node), pause) : Promise.resolve(this.mat(node)); }

  * matG(node) {
    const k = key(node);
    let b = this.memo.get(k);
    if (b) return b;
    if (this.trace && !FREE.has(node.t)) b = yield* spanG(this.trace, label(node), 'set', this.store.system, this._mat(node));
    else b = yield* this._mat(node);
    this.memo.set(k, b);
    return b;
  }

  * _mat(node) {
    const S = this.store;
    const st = this.stats;
    switch (node.t) {
      case 'empty': return new RoaringBitmap32();
      case 'all': return S.all(st, this.local);
      case 'active': return S.active(st, this.local);
      case 'inactive': return RoaringBitmap32.andNot(S.all(st, this.local), S.active(st, this.local));
      case 'leaf': return S.leaf(st, this.local);
      case 'ids': return new RoaringBitmap32(node.ids);
      case 'set': return S.getSet(node.kind, node.pid, node.value, st, this.local);
      case 'self': {
        const r = (yield* this.matG(node.of)).clone();
        r.add(node.id);
        return r;
      }
      case 'anc': {
        const r = new RoaringBitmap32(S.ancestorsOf(node.id, st));
        if (node.self) r.add(node.id);
        return r;
      }
      case 'parents': {
        const r = new RoaringBitmap32(S.parentsOf(node.id, st));
        if (node.self) r.add(node.id);
        return r;
      }
      case 'hier': return yield* this._hier(node);
      case 'propIn': return yield* this._propIn(node);
      case 'propOf': {
        const src = yield* this.matG(node.sources);
        this.spend(src.size * 8, 'relation image');
        const pids = new Set(node.pids);
        const out = new RoaringBitmap32();
        const ids = src.toArray();
        for (let i = 0; i < ids.length; i += 50000) {
          if (i) yield;
          for (const r of S.linksFrom(ids.slice(i, i + 50000), pids, true, st)) out.add(r.t);
        }
        return out;
      }
      case 'litIn': {
        const sets = S.loadSets(KIND.prop, node.pid, node.values, st, this.local);
        return RoaringBitmap32.orMany([...sets.values()]);
      }
      case 'litMatch': {
        const re = wholeTerm(node.re);
        this.spend(S.propValues(node.pid, st).length, 'regex over property values');
        const keys = S.propValues(node.pid, st).filter((r) => re.test(String(r.value))).map((r) => r.value);
        if (!keys.length) return new RoaringBitmap32();
        return RoaringBitmap32.orMany([...S.loadSets(KIND.prop, node.pid, keys, st, this.local).values()]);
      }
      case 'refsetOf': {
        const ids = (yield* this.matG(node.of)).toArray();
        const sets = [...S.loadSets(KIND.refset, 0, ids, st, this.local).values()];
        return sets.length ? RoaringBitmap32.orMany(sets) : new RoaringBitmap32();
      }
      case 'descFilter': {
        if (node.words.length) {
          // full-text pre-selection, then the exact test on the candidates
          const q = node.words.map((w) => '"' + w.replace(/"/g, '""') + '"').join(' AND ');
          const sq = S.stmt('SELECT DISTINCT d.concept_id AS id FROM search_designation s JOIN designation d ON d.designation_id = s.rowid WHERE search_designation MATCH ? AND d.concept_id BETWEEN ? AND ?');
          const rows = sq.all(q, S.lo, S.hi);
          if (st) count(st, S, sq, rows.length);
          return yield* this._descFilter(node, new RoaringBitmap32(rows.map((r) => r.id)));
        }
        this.spend(S.conceptCount * 3, 'description scan');
        return yield* this._descFilter(node, S.all(st, this.local));
      }
      case 'history': {
        const base = yield* this.matG(node.of);
        const add = new RoaringBitmap32();
        for (const rs of node.refsets) {
          for (const [target, sources] of this._historyIndex(rs)) if (base.has(target)) for (const x of sources) add.add(x);
        }
        return RoaringBitmap32.or(base, add);
      }
      case 'desigMatch': return yield* this._desigMatch(node, null);
      case 'desigRegex': return yield* this._desigRegex(node, null);
      case 'text': return yield* this._textScan(node, null);
      case 'search': return (yield* S.searchTextG(node.text, st, node.mode, node.lang || null, node.defLang)) || new RoaringBitmap32();
      case 'group': return yield* this.filterG(node, yield* this.matG({ t: 'and', items: node.attrs.map(attrNode) }));
      case 'attrCard': {
        const has = yield* this.matG(node.base); // at least one occurrence
        const counted = yield* this._attrCard(node, has);
        return node.min === 0 ? RoaringBitmap32.or(counted, RoaringBitmap32.andNot(S.all(st, this.local), has)) : counted;
      }
      case 'layer': return yield* new Evaluator(node.layer.store, { trace: this.trace }).matG(node.node);
      case 'xlate': {
        // evaluate on the other file, then map its ids to this file's by code
        const b = yield* new Evaluator(node.from, { trace: this.trace }).matG(node.node);
        return S.translateFrom(node.from, b, st);
      }
      case 'and': return yield* this._and(node.items);
      case 'or': {
        const parts = [];
        for (const i of node.items) parts.push(yield* this.matG(i));
        return parts.length === 1 ? parts[0] : RoaringBitmap32.orMany(parts);
      }
      case 'minus': {
        const A = yield* this.matG(node.a);
        return RoaringBitmap32.andNot(A, yield* this.filterG(node.b, A));
      }
      default: throw new Error('mat: unknown node ' + node.t);
    }
  }

  * _hier(node) {
    const of = yield* this.matG(node.of);
    const ids = of.toArray();
    const S = this.store;
    let out;
    if (node.dir === 'desc') {
      const sets = S.loadSets(KIND.descendants, 0, ids, this.stats, this.local);
      out = RoaringBitmap32.orMany([...sets.values()]);
    } else if (node.dir === 'children') {
      const sets = S.loadSets(KIND.prop, S.hierarchy.id, ids, this.stats, this.local);
      out = RoaringBitmap32.orMany([...sets.values()]);
    } else if (node.dir === 'top' || node.dir === 'bottom') {
      const sets = S.loadSets(KIND.descendants, 0, ids, this.stats, this.local);
      if (node.dir === 'top') {
        out = RoaringBitmap32.andNot(of, RoaringBitmap32.orMany([...sets.values()]));
      } else {
        out = new RoaringBitmap32();
        for (const id of ids) if (!sets.get(id).intersects(of)) out.add(id);
      }
      return out;
    } else if (node.dir === 'parents') {
      out = new RoaringBitmap32();
      for (const r of S.linksFrom(ids, new Set([S.hierarchy.id]), true, this.stats)) out.add(r.t);
    } else {
      out = new RoaringBitmap32();
      for (let i = 0; i < ids.length; i++) {
        if (i && i % 200 === 0) yield;
        out.orInPlace(new RoaringBitmap32(S.ancestorsOf(ids[i], this.stats)));
      }
    }
    if (node.self) out = RoaringBitmap32.or(out, of);
    return out;
  }

  * _propIn(node) {
    const V = yield* this._propValues(node);
    if (V.size === 0) return new RoaringBitmap32();
    this.spend(V.size * node.pids.length, 'value sets');
    const vals = V.toArray();
    const parts = [];
    for (const pid of node.pids) {
      // one statement for all the values: stored prop sets keyed by target concept_id
      const sets = this.store.loadSets(KIND.prop, pid, vals, this.stats, this.local);
      for (const b of sets.values()) if (b.size) parts.push(b);
    }
    return parts.length ? RoaringBitmap32.orMany(parts) : new RoaringBitmap32();
  }

  /**
   * The values of a propIn node that can matter: only a target of one of its properties has a
   * stored prop set, so a costly values node (a regex over the targets' displays) is evaluated on
   * the properties' targets (the keys of their prop sets) instead of the whole system. The union
   * _propIn takes is the same; a LOINC CLASS regex tests ~1,000 part displays, not 250,000.
   */
  * _propValues(node) {
    if (this.isFree(node.values)) return yield* this.matG(node.values);
    let targets = null;
    for (const pid of node.pids) {
      const keys = new RoaringBitmap32(this.store.propValues(pid, this.stats).map((r) => r.value).filter((v) => Number.isInteger(v)));
      targets = targets ? RoaringBitmap32.or(targets, keys) : keys;
    }
    return yield* this.filterG(node.values, targets);
  }

  * _and(items) {
    const free = items.filter((i) => this.isFree(i));
    const costly = items.filter((i) => !this.isFree(i));
    let cand = null;
    if (free.length) {
      const sets = [];
      for (const i of free) sets.push(yield* this.matG(i));
      sets.sort((a, b) => a.size - b.size);
      cand = sets[0];
      for (let j = 1; j < sets.length && cand.size; j++) cand = RoaringBitmap32.and(cand, sets[j]);
    }
    for (const c of costly) {
      if (cand && cand.size === 0) break;
      cand = cand ? yield* this.filterG(c, cand) : yield* this.matG(c);
    }
    return cand || new RoaringBitmap32();
  }

  // ---- filter: members of `cand` that are in node's set ----------------------------------

  /** the members of cand in node (sync: no pauses) */
  filter(node, cand) { return runSync(this.filterG(node, cand)); }

  filterAsync(node, cand, pause) { return pause ? runAsync(this.filterG(node, cand), pause) : Promise.resolve(this.filter(node, cand)); }

  * filterG(node, cand) {
    if (cand.size === 0) return cand;
    if (this.isFree(node) || cand.size > PROBE_MAX) return RoaringBitmap32.and(cand, yield* this.matG(node));
    if (this.trace) return yield* spanG(this.trace, 'probe ' + label(node) + ' on ' + cand.size, 'rows', this.store.system, this._probe(node, cand));
    return yield* this._probe(node, cand);
  }

  * _probe(node, cand) {
    const S = this.store;
    const st = this.stats;
    switch (node.t) {
      case 'and': {
        let cur = cand;
        const order = [...node.items].sort((a, b) => (this.isFree(b) ? 1 : 0) - (this.isFree(a) ? 1 : 0));
        for (const i of order) { if (!cur.size) break; cur = yield* this.filterG(i, cur); }
        return cur;
      }
      case 'or': {
        let res = new RoaringBitmap32();
        let rem = cand;
        for (const i of node.items) {
          if (!rem.size) break;
          const f = yield* this.filterG(i, rem);
          res = RoaringBitmap32.or(res, f);
          rem = RoaringBitmap32.andNot(rem, f);
        }
        return res;
      }
      case 'minus': {
        const x = yield* this.filterG(node.a, cand);
        return RoaringBitmap32.andNot(x, yield* this.filterG(node.b, x));
      }
      case 'propIn': {
        const pids = new Set(node.pids);
        this.spend(cand.size * 8, 'attribute probe');
        const rows = S.linksFrom(cand.toArray(), pids, true, st);
        if (!rows.length) return new RoaringBitmap32();
        const targets = new RoaringBitmap32(rows.map((r) => r.t));
        const ok = yield* this.filterG(node.values, targets);
        const out = new RoaringBitmap32();
        for (const r of rows) if (ok.has(r.t)) out.add(r.s);
        return out;
      }
      case 'group': return yield* this._group(node, cand);
      case 'attrCard': return RoaringBitmap32.and(cand, yield* this.matG(node));
      case 'descFilter': return yield* this._descFilter(node, cand);
      case 'desigMatch': return yield* this._desigMatch(node, cand);
      case 'desigRegex': return yield* this._desigRegex(node, cand);
      case 'text': return yield* this._textScan(node, cand);
      case 'litMatch': {
        const re = wholeTerm(node.re);
        const out = new RoaringBitmap32();
        for (const r of S.literalsOf(cand.toArray(), true, st)) if (r.p === node.pid && re.test(String(r.v))) out.add(r.c);
        return out;
      }
      default:
        return RoaringBitmap32.and(cand, yield* this.matG(node));
    }
  }

  /** concepts in cand with one description that passes every filter of the block */
  * _descFilter(node, cand) {
    const S = this.store;
    const out = new RoaringBitmap32();
    const ids = cand.toArray();
    const activeFilter = node.filters.find((f) => f.field === 'active');
    // a dialect filter reads the acceptability rows (a file with designation.rank does not read them
    // otherwise)
    const opts = { withAcc: node.filters.some((f) => f.field === 'dialect' || f.field === 'dialectid') };
    for (let i = 0; i < ids.length; i += ROW_CHUNK) {
      if (i) yield;
      const rows = S.designationRows(ids.slice(i, i + ROW_CHUNK), this.stats, opts);
      for (const [id, list] of rows) {
        if (list.some((d) => (activeFilter || d.active) && node.filters.every((f) => descMatches(d, f)))) out.add(id);
      }
    }
    return out;
  }

  /** designation = / regex (R5 generic filter): the display or an active designation */
  * _desigMatch(node, cand) {
    const S = this.store;
    const test = node.re != null ? ((re) => (t) => t != null && re.test(t))(wholeTerm(node.re)) : (t) => t === node.eq;
    if (!cand && node.eq != null && node.eq.length >= 3 && S.hasFts) {
      // full-text candidates, then the exact test
      const q = '"' + node.eq.replace(/"/g, '""') + '"';
      const ids = new Set();
      const q1 = S.stmt('SELECT rowid AS id FROM search_display WHERE search_display MATCH ? AND rowid BETWEEN ? AND ?');
      const q2 = S.stmt('SELECT d.concept_id AS id FROM search_designation s JOIN designation d ON d.designation_id = s.rowid WHERE search_designation MATCH ? AND d.concept_id BETWEEN ? AND ?');
      const r1 = q1.all(q, S.lo, S.hi);
      const r2 = q2.all(q, S.lo, S.hi);
      for (const r of r1) ids.add(r.id);
      for (const r of r2) ids.add(r.id);
      if (this.stats) { count(this.stats, S, q1, r1.length); count(this.stats, S, q2, r2.length); }
      cand = new RoaringBitmap32([...ids]);
    }
    const out = new RoaringBitmap32();
    if (!cand) {
      this.spend(S.conceptCount * 4, 'designation scan');
      const q1 = S.stmt('SELECT concept_id, display FROM concept WHERE concept_id BETWEEN ? AND ?').raw();
      for (const [a, b] of idRanges(S)) {
        for (const [id, display] of q1.all(a, b)) if (test(display)) out.add(id);
        yield;
      }
      const q2 = S.stmt('SELECT concept_id, term FROM designation WHERE active = 1 AND concept_id BETWEEN ? AND ?').raw();
      for (const [a, b] of idRanges(S)) {
        for (const [id, term] of q2.all(a, b)) if (test(term)) out.add(id);
        yield;
      }
      return out;
    }
    this.spend(cand.size * 4, 'designation probe');
    const ids = cand.toArray();
    for (let i = 0; i < ids.length; i += ROW_CHUNK) {
      if (i) yield;
      const chunk = ids.slice(i, i + ROW_CHUNK);
      for (const r of S.conceptRows(chunk, this.stats).values()) if (test(r.display)) out.add(r.concept_id);
      for (const [id, list] of S.designationRows(chunk, this.stats)) if (!out.has(id) && list.some((d) => d.active && test(d.term))) out.add(id);
    }
    return out;
  }

  /**
   * SNOMED CT display regex: concepts with an active description of one of node.uses (FSN,
   * synonym) in node.lang whose whole term matches (RE2, case-sensitive). With required literals the
   * candidates come from the trigram index on designations; otherwise that language's active
   * descriptions are scanned.
   */
  * _desigRegex(node, cand) {
    const S = this.store;
    const whole = (t) => wholeTermRe.test(t);
    const wholeTermRe = wholeTerm(node.re);
    const useIds = new Set();
    for (const [id, u] of S.uses) if (u && node.uses.includes(u.code)) useIds.add(id);
    const lang = String(node.lang).toLowerCase();
    const inLang = (l) => { if (!l) return false; const x = String(l).toLowerCase(); return x === lang || x.startsWith(lang + '-'); };
    const out = new RoaringBitmap32();
    const take = (cid, term, language, use, active) => { if (active && useIds.has(use) && inLang(language) && whole(term)) out.add(cid); };
    // candidates given (a lazy chunk, a membership probe, an is-a): read their descriptions, unless
    // the trigram candidates are the smaller set
    if (cand && (cand.size <= 2000 || (!node.lits && cand.size <= 200000))) {
      this.spend(cand.size * 4, 'description regex probe');
      const ids = cand.toArray();
      const st = S.stmt('SELECT concept_id, term, language, use_id, active FROM designation WHERE concept_id IN (SELECT value FROM json_each(?))').raw();
      for (let i = 0; i < ids.length; i += ROW_CHUNK) {
        if (i) yield;
        const rows = st.all(JSON.stringify(ids.slice(i, i + ROW_CHUNK)));
        if (this.stats) count(this.stats, S, st, rows.length);
        for (const [cid, term, language, use, active] of rows) take(cid, term, language, use, active);
      }
      return out;
    }
    if (node.lits && S.hasFts) {
      // one statement (each chunk would run the trigram query again); the rows tested in chunks
      const q = S.stmt('SELECT d.concept_id, d.term, d.language, d.use_id, d.active FROM search_designation s JOIN designation d ON d.designation_id = s.rowid WHERE search_designation MATCH ? AND d.concept_id BETWEEN ? AND ?');
      const rows = q.raw().all(ftsQuery(node.lits), S.lo, S.hi);
      this.spend(rows.length, 'description regex (trigram candidates)');
      if (this.stats) count(this.stats, S, q, rows.length);
      for (let i = 0; i < rows.length; i++) {
        if (i && i % ROW_CHUNK === 0) yield;
        const [cid, term, language, use, active] = rows[i];
        if (!cand || cand.has(cid)) take(cid, term, language, use, active);
      }
      return out;
    }
    this.spend(S.conceptCount * 4, 'description regex scan');
    const q = S.stmt("SELECT concept_id, term, language, use_id, active FROM designation WHERE active = 1 AND concept_id BETWEEN ? AND ? AND (lower(language) = ? OR lower(language) LIKE ? || '-%')").raw();
    let n = 0;
    for (const [a, b] of idRanges(S)) {
      const rows = q.all(a, b, lang, lang);
      n += rows.length;
      for (const [cid, term, language, use, active] of rows) if (!cand || cand.has(cid)) take(cid, term, language, use, active);
      yield;
    }
    if (this.stats) count(this.stats, S, q, n);
    return out;
  }

  /** association refset: target concept -> [source concepts], built once per evaluation */
  _historyIndex(refsetId) {
    const S = this.store;
    let m = this.history.get(refsetId);
    if (!m) {
      m = new Map();
      const rows = S.stmt('SELECT concept_id, fields FROM refset_member WHERE refset_id = ?').all(refsetId);
      const targets = S.resolveCodes([...new Set(rows.map((r) => JSON.parse(r.fields)[0]).filter(Boolean).map(String))]);
      for (const r of rows) {
        const t = targets.get(String(JSON.parse(r.fields)[0]));
        if (t == null) continue;
        if (!m.has(t)) m.set(t, []);
        m.get(t).push(r.concept_id);
      }
      this.history.set(refsetId, m);
    }
    return m;
  }

  /** candidates whose count of matching (group, value) occurrences is within [min, max] */
  * _attrCard(node, cand) {
    const out = new RoaringBitmap32();
    if (!cand.size) return out;
    const V = yield* this.matG(node.values);
    const pids = new Set(node.pids);
    this.spend(cand.size * 8, 'cardinality count');
    const ids = cand.toArray();
    for (let i = 0; i < ids.length; i += 50000) {
      if (i) yield;
      const counts = new Map();
      for (const r of this.store.linksFrom(ids.slice(i, i + 50000), pids, true, this.stats)) {
        if (!V.has(r.t)) continue;
        let m = counts.get(r.s);
        if (!m) counts.set(r.s, m = new Set());
        m.add(r.g + ':' + r.t);
      }
      for (const [s, m] of counts) if (m.size >= node.min && m.size <= node.max) out.add(s);
    }
    return out;
  }

  /**
   * attributes that must hold together in one role group (group 0, ungrouped, is not a role
   * group); with min/max, the number of such groups must be in range
   */
  * _group(node, cand) {
    let pre = cand;
    for (const a of node.attrs) pre = yield* this.filterG(attrNode(a), pre);
    if (!pre.size) return pre;
    const allPids = new Set(node.attrs.flatMap((a) => a.pids));
    const rows = this.store.linksFrom(pre.toArray(), allPids, true, this.stats);
    const valueSets = [];
    for (const a of node.attrs) valueSets.push(yield* this.matG(a.values));
    const bySource = new Map();
    for (const r of rows) {
      if (r.g === 0) continue;
      let m = bySource.get(r.s);
      if (!m) bySource.set(r.s, m = new Map());
      let g = m.get(r.g);
      if (!g) m.set(r.g, g = []);
      g.push(r);
    }
    const min = node.min ?? 1;
    const max = node.max ?? Infinity;
    const out = new RoaringBitmap32();
    for (const [s, groups] of bySource) {
      let n = 0;
      for (const g of groups.values()) {
        if (node.attrs.every((a, i) => g.some((r) => a.pids.includes(r.p) && valueSets[i].has(r.t)))) n++;
      }
      if (n >= min && n <= max) out.add(s);
    }
    return out;
  }

  * _textScan(node, cand) {
    const re = wholeTerm(node.re);
    const col = node.field === 'code' ? 'code' : 'display';
    const out = new RoaringBitmap32();
    // (a few candidates, e.g. one code's membership, are cheaper to test directly)
    if (node.lits && col === 'display' && this.store.hasFts && !(cand && cand.size <= 2000)) {
      // trigram prefilter: the concepts whose display contains every required literal, then RE2
      let c = this.store.ftsDisplayIds(ftsQuery(node.lits), this.stats);
      if (cand) c = RoaringBitmap32.and(c, cand);
      this.spend(c.size, 'text scan (trigram candidates)');
      const ids = c.toArray();
      for (let i = 0; i < ids.length; i += ROW_CHUNK) {
        if (i) yield;
        for (const r of this.store.conceptRows(ids.slice(i, i + ROW_CHUNK), this.stats).values()) if (r[col] != null && re.test(r[col])) out.add(r.concept_id);
      }
      return out;
    }
    this.spend(cand ? cand.size : this.store.conceptCount, 'text scan');
    if (cand) {
      const ids = cand.toArray();
      for (let i = 0; i < ids.length; i += ROW_CHUNK) {
        if (i) yield;
        for (const r of this.store.conceptRows(ids.slice(i, i + ROW_CHUNK), this.stats).values()) if (r[col] != null && re.test(r[col])) out.add(r.concept_id);
      }
      return out;
    }
    let n = 0;
    // raw rows: no object per row; id ranges, one statement each, a pause between them
    const q = this.store.stmt(`SELECT concept_id, ${col} AS v FROM concept WHERE concept_id BETWEEN ? AND ?`).raw();
    for (const [a, b] of idRanges(this.store)) {
      for (const [id, v] of q.all(a, b)) {
        n++;
        if (v != null && re.test(v)) out.add(id);
      }
      yield;
    }
    if (this.stats) count(this.stats, this.store, q, n);
    return out;
  }

  // ---- lazy: first members of driver ∩ filters in id order, stopping at `want` ----------------

  /**
   * Evaluate `driver` (free) narrowed by `filters` (costly) chunk by chunk in id order until
   * `want` members are found. Returns { ids: RoaringBitmap32, done, cursor } where cursor is the
   * last driver id examined (resume after it).
   */
  lazy(driver, filters, want, after = 0) { return runSync(this.lazyG(driver, filters, want, after)); }

  * lazyG(driver, filters, want, after = 0) {
    const D = yield* this.matG(driver);
    const out = new RoaringBitmap32();
    const it = D.iterator();
    let chunk = [];
    let cursor = after;
    let done = false;
    const self = this;
    function* flush() {
      if (!chunk.length) return;
      let c = new RoaringBitmap32(chunk);
      for (const f of filters) { if (!c.size) break; c = yield* self._probe(f, c); }
      out.orInPlace(c);
      cursor = chunk[chunk.length - 1];
      chunk = [];
      yield;
    }
    if (after > 0) {
      // skip to the cursor
      for (;;) {
        const n = it.next();
        if (n.done) { done = true; break; }
        if (n.value > after) { chunk.push(n.value); break; }
      }
    }
    while (!done) {
      const n = it.next();
      if (n.done) { done = true; break; }
      chunk.push(n.value);
      if (chunk.length >= SCAN_CHUNK) {
        yield* flush();
        if (out.size >= want) break;
      }
    }
    yield* flush();
    return { ids: out, done, cursor };
  }
}

/** [lo, hi] id ranges covering the store's block, ROW_CHUNK ids each (a long scan in bounded statements) */
function* idRanges(S) {
  for (let a = S.lo; a <= S.hi; a += ROW_CHUNK) yield [a, Math.min(a + ROW_CHUNK - 1, S.hi)];
}

/** concepts with attribute a (any of its properties) = a value in a.values; `= *` is hasProp */
function attrNode(a) {
  if (a.values.t !== 'all') return { t: 'propIn', pids: a.pids, values: a.values };
  const items = a.pids.map((pid) => ({ t: 'set', kind: KIND.hasProp, pid, value: 0 }));
  return items.length === 1 ? items[0] : { t: 'or', items };
}

function descMatches(d, f) {
  let r;
  switch (f.field) {
    case 'term': r = f.matchers.some((m) => m(d.term)); break;
    case 'language': r = f.values.includes(String(d.language || 'en').toLowerCase().split('-')[0]); break;
    case 'type': case 'typeid': r = !f.uses || (!!d.use && f.uses.includes(d.use.code)); break;
    case 'active': r = d.active === f.value; break;
    case 'dialect': case 'dialectid': {
      const acc = (d.acc || '').split(',').filter(Boolean).map((a) => a.split(':').map(Number));
      r = f.dialects.some((dl) => acc.some(([rs, av]) => (!dl.refsets || dl.refsets.includes(rs)) && (!dl.acceptability || dl.acceptability.includes(av))));
      break;
    }
    default: r = false;
  }
  return f.neg ? !r : r;
}

/**
 * Regex filters as upstream evaluates them (library/regex-utilities): RE2 (linear time, so a
 * request cannot make it backtrack) and found anywhere in the value, not anchored.
 */
/**
 * Every regex filter matches the whole value (tx-ecosystem: simple-expand-regex, regex2,
 * validation-simple-code-bad-regex, expand-regex-bad(-2), snomed display regex): RE2 find of
 * "^(?:P)$". ".*X.*" is tested as find("X") when X has no top-level alternation and the value has
 * no line break (where "." would stop), which skips scanning every prefix.
 * @returns {{test: function(string): boolean}}
 */
function wholeTerm(src) {
  const p = String(src);
  const full = compileRe('^(?:' + p + ')$');
  const inner = p.startsWith('.*') && p.endsWith('.*') && p.length >= 4 ? p.slice(2, -2) : null;
  if (inner != null && stripAnyAffixes(p) !== p && !/^[?*+{]/.test(inner) && !inner.endsWith('\\')) {
    const re = compileRe(stripAnyAffixes(p));
    return { test: (t) => t != null && (String(t).indexOf('\n') < 0 ? re.test(t) : full.test(t)) };
  }
  return { test: (t) => t != null && full.test(t) };
}

function compileRe(src) {
  try {
    return regexUtilities.compile(src);
  } catch (e) {
    throw new Unsupported('bad-regex', src);
  }
}

module.exports = { Evaluator, Unsupported, key, label, compileRe, PROBE_MAX, FREE, runSync, runAsync };
