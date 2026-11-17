'use strict';
// Expansion engine for one store: compiled selection -> ordered result -> pages.
//
// A selection is { includes: [Include], excludes: [Include], activeOnly }, where an Include is
// { parts: [{ node, order }] } in the order upstream expand.js would add codes (enumerated
// concepts first, then filters); order = explicit id order (enumerated concepts) or null
// (id order = depth-first hierarchy order).
//
// The result is a list of segments, one per part, each with the members not already in an
// earlier segment and not excluded. Paging is by position across segments. Nothing is cached:
// every request plans and evaluates. Ids are eager unless the plan has a costly unselective input
// (text/regex scan) and the request is paged: then only the members up to offset+count are
// produced (lazy first page, no total).

const { RoaringBitmap32 } = require('roaring');
const { Evaluator, runSync, runAsync } = require('./evaluate');
const { KIND, registry } = require('../store');

const LAZY_MIN_DRIVER = 50000; // a costly filter over at least this many candidates goes lazy when paged

class Result {
  constructor() {
    this.segments = []; // { bm } (id order) or { list } (explicit order)
    this.total = 0;
    this.complete = true; // false: lazy, total unknown
    this.bytes = 0;
  }

  add(seg) {
    const n = seg.bm ? seg.bm.size : seg.list.length;
    if (!n) return;
    seg.n = n;
    this.segments.push(seg);
    this.total += n;
    this.bytes += seg.bm ? seg.bm.getSerializationSizeInBytes('portable') + 352 : seg.list.length * 16 + 64;
  }

  /** ids at positions [offset, offset+count) */
  page(offset, count) {
    const out = [];
    let pos = 0;
    const end = count < 0 ? Infinity : offset + count;
    for (const s of this.segments) {
      if (pos + s.n <= offset) { pos += s.n; continue; }
      if (pos >= end) break;
      const from = Math.max(0, offset - pos);
      const take = Math.min(s.n - from, end - pos - from);
      if (s.bm) {
        for (const id of s.bm.rangeUint32Array(from, take)) out.push(id);
      } else {
        for (let i = from; i < from + take; i++) out.push(s.list[i]);
      }
      pos += s.n;
    }
    return out;
  }

  has(id) {
    for (const s of this.segments) if (s.bm ? s.bm.has(id) : s.list.includes(id)) return true;
    return false;
  }
}

class Engine {
  constructor(store, opts = {}) {
    this.store = store;
    registry.engines.add(this);
    this.lazyMinDriver = opts.lazyMinDriver || LAZY_MIN_DRIVER;
    // optional system order (LOINC, SNOMED CT; orders.js): { rank[id], ids[rank], walk, selfFirst },
    // data the importer stored in the file, read on first use
    this._order = opts.order || null;
  }

  /**
   * @param {object} sel compiled selection
   * @param {object} opts { offset, count, trace }
   * @returns {Result}
   */
  run(sel, opts = {}) {
    return runSync(this._runG(sel, opts));
  }

  /**
   * run(), pausing between the steps and chunks of a long evaluation: opts.pause (the request's
   * opContext.checkAndYield) is awaited at each pause point (evaluate.js runAsync)
   * @returns {Promise<Result>}
   */
  runAsync(sel, opts = {}) {
    return opts.pause ? runAsync(this._runG(sel, opts), opts.pause) : Promise.resolve(this.run(sel, opts));
  }

  * _runG(sel, opts) {
    // every request plans and evaluates: the design keeps no caches
    const trace = opts.trace || null;
    const want = opts.count >= 0 ? Math.max(opts.offset, 0) + opts.count : -1;
    const ev = new Evaluator(this.store, { trace });
    if (!trace) return yield* this._evaluate(ev, sel, want);
    const s = trace.open('evaluate selection', 'set', this.store.system);
    try {
      const r = yield* this._evaluate(ev, sel, want);
      trace.close(s, r);
      return r;
    } catch (e) {
      s.error = e.message;
      trace.close(s, null);
      throw e;
    }
  }

  * _evaluate(ev, sel, want) {
    const allNodes = [];
    for (const inc of [...sel.includes, ...sel.excludes]) for (const p of inc.parts) allNodes.push(p.node);
    ev.prefetch(allNodes);

    let excl = null;
    for (const inc of sel.excludes) {
      for (const p of inc.parts) {
        const b = yield* ev.matG(p.node);
        excl = excl ? RoaringBitmap32.or(excl, b) : b;
      }
    }
    const active = sel.activeOnly ? yield* ev.matG({ t: 'active' }) : null;

    const parts = [];
    for (const inc of sel.includes) for (const p of inc.parts) parts.push(p);

    // lazy only for a single filter part whose plan is driver ∧ costly filters over a large driver
    // lazy needs a page to stop at: count = 0 asks for the total, which only a full evaluation gives
    if (want > 0 && parts.length === 1 && !parts[0].order && !this._order) {
      const plan = yield* this._lazyPlan(ev, parts[0].node, active, excl);
      if (plan) {
        const r = new Result();
        const got = yield* ev.lazyG(plan.driver, plan.filters, want, 0);
        let ids = got.ids;
        if (excl) ids = RoaringBitmap32.andNot(ids, excl);
        {
          r.add({ bm: ids });
          if (!r.segments.length) r.segments.push({ bm: ids, n: 0 });
        }
        r.complete = got.done;
        return r;
      }
    }

    const r = new Result();
    let seen = null;
    for (const p of parts) {
      let b = yield* ev.matG(p.node);
      if (active) b = RoaringBitmap32.and(b, active);
      if (excl) b = RoaringBitmap32.andNot(b, excl);
      if (seen) b = RoaringBitmap32.andNot(b, seen);
      if (p.order) {
        const list = [];
        const dup = new Set();
        for (const id of p.order) if (b.has(id) && !dup.has(id)) { dup.add(id); list.push(id); }
        r.add({ list });
      } else if (p.node.order === 'firstSeen') {
        r.add({ list: this._firstSeen(ev, b, p.node.via) });
      } else if (p.node.order === 'lists') {
        r.add({ list: yield* this._listsInSequence(ev, p.node.of, b) });
      } else if (p.node.t === 'set' && p.node.kind === KIND.refset && this.store.sequenceOf(p.node.value)) {
        // an ordered list (LOINC answer list): its own order
        const seqd = this.store.sequenceOf(p.node.value).filter((id) => b.has(id));
        const rest = RoaringBitmap32.andNot(b, new RoaringBitmap32(seqd));
        r.add({ list: [...seqd, ...(this._order ? this._ordered(rest) : rest.toArray())] });
      } else if (this._order && this._order.selfFirst && this.store.hasLinkOrder && p.node.t === 'set' && p.node.kind === KIND.prop
          && this.store.hierarchy && p.node.pid === this.store.hierarchy.id) {
        // (SNOMED CT child-of, ECL <!: the children in release order, as cs-snomed.js filterChildOf)
        const ordered = [...new Set(this.store.linkSourcesInOrder(p.node.pid, p.node.value).filter((id) => b.has(id)))];
        const rest = RoaringBitmap32.andNot(b, new RoaringBitmap32(ordered));
        r.add({ list: [...ordered, ...this._ordered(rest)] });
      } else if (p.node.t === 'all' && p.node.whole && this._order && this._order.hasWalk) {
        // (an include of the whole code system: the built-in walk, see orders.js snomedWalk,
        // loincOrder; SNOMED CT's leaves out the concepts it does not reach. wholeSystem: its
        // count=0 total is the code system's size, SqliteV2Provider.processSelection. Every code
        // otherwise, as ECL *: the system order, by id for SNOMED CT, as cs-snomed.js lists it)
        const walk = this._order.walk;
        const end = walk.reached != null ? walk.reached : walk.length;
        const list = [];
        for (let k = 0; k < end; k++) {
          if (b.has(walk[k])) list.push(walk[k]);
          if (k && k % 100000 === 0) yield;
        }
        r.add({ list });
        if (!excl && parts.length === 1) r.wholeSystem = true;
      } else if (this._order && this._order.selfFirst && p.node.eclOrder) {
        // (SNOMED CT ECL: the order cs-snomed.js lists a compound, refined or filtered result in)
        r.add({ list: yield* this._eclOrdered(ev, p.node, b) });
      } else if (this._order && this._order.selfFirst && p.node.t === 'self' && b.has(p.node.id)) {
        // (SNOMED CT is-a, ECL <<: the concept, then its descendants in the system order; <<!: then
        // its children in release order)
        r.add({ list: yield* this._eclOrdered(ev, p.node, b) });
      } else if (this._order) {
        r.add({ list: this._ordered(b) });
      } else {
        r.add({ bm: b });
      }
      seen = seen ? RoaringBitmap32.or(seen, b) : b;
      yield;
    }
    return r;
  }

  /**
   * The members of one filter node in the order run() lists a part made of it (the system order,
   * with the part's own rules: is-a self first, child-of in release order, answer-list sequence)
   * @returns {number[]} concept ids
   */
  ordered(node, trace = null) {
    return this.run({ includes: [{ parts: [{ node }] }], excludes: [], activeOnly: false }, { offset: 0, count: -1, trace }).page(0, -1);
  }

  /** ordered(), pausing (see runAsync) */
  async orderedAsync(node, trace = null, pause = null) {
    return (await this.runAsync({ includes: [{ parts: [{ node }] }], excludes: [], activeOnly: false }, { offset: 0, count: -1, trace, pause })).page(0, -1);
  }

  /** a list's rank in the system order (LOINC: by code), else its id */
  _rank(id) {
    return this._order ? this._order.rank[id] : id;
  }

  /**
   * LOINC answers in the order they first appear in the release's answer-list file, which lists
   * the answer lists by code and each in its sequence: by (the first of its lists, its sequence
   * there). That is upstream's key order (cs-loinc.js LIST ... ORDER BY TargetKey). Members in no
   * list (via = the Answer property) come first, in the system order, as upstream's keys put
   * terms before answers. Two statements: the members' lists, their places in them.
   */
  _firstSeen(ev, b, via) {
    const S = this.store;
    const ids = b.toArray();
    const lists = S.loadSets(KIND.prop, via, ids, ev.stats, ev.local);
    const firstList = new Map();
    for (const id of ids) {
      const l = lists.get(id);
      if (!l || !l.size) continue;
      let best = -1;
      for (const x of l) if (best < 0 || this._rank(x) < this._rank(best)) best = x;
      firstList.set(id, best);
    }
    const seq = S.sequenceIn([...firstList].map(([m, l]) => [l, m]));
    const loose = ids.filter((id) => !firstList.has(id));
    const answers = ids.filter((id) => firstList.has(id));
    answers.sort((x, y) => (this._rank(firstList.get(x)) - this._rank(firstList.get(y))) || ((seq.get(x) ?? 0) - (seq.get(y) ?? 0)) || (x - y));
    return [...(this._order ? this._ordered(new RoaringBitmap32(loose)) : loose), ...answers];
  }

  /**
   * the members of the ordered lists `of` (LOINC answers-for = a term: its answer lists), list
   * by list in the system order, each in its sequence, an answer in several once (upstream's
   * order: cs-loinc.js answers-for). One statement for the lists' members
   */
  * _listsInSequence(ev, of, b) {
    const lists = (yield* ev.matG(of)).toArray().sort((x, y) => this._rank(x) - this._rank(y));
    const seqs = this.store.sequencesOf(lists);
    const out = [];
    const seen = new Set();
    for (const l of lists) for (const m of seqs.get(l)) if (b.has(m) && !seen.has(m)) { seen.add(m); out.push(m); }
    if (seen.size < b.size) {
      const rest = RoaringBitmap32.andNot(b, new RoaringBitmap32([...seen]));
      out.push(...(this._order ? this._ordered(rest) : rest.toArray()));
    }
    return out;
  }

  /** members of b in the system's order: sort their ranks (typed arrays) */
  /**
   * The members b of an ECL node, in the order cs-snomed.js lists them: a refinement or a {{ }}
   * filter keeps its base's order (_evalRefined, _eclDescriptionFilter walk the base); AND, the
   * right side's (_eclIntersect: the right filtered by the left, unless one side is *); OR, the
   * left side's, then the rest in the right side's (_eclUnion); MINUS, the left side's
   * (_eclMinus). << X: X first, then the rest in the system order (by id); <<! X: X first, then
   * its children; child-of in release order; anything else in the system order.
   * @returns {number[]}
   */
  * _eclOrdered(ev, node, b) {
    switch (node.eclOrder) {
      case 'base': return yield* this._eclOrdered(ev, node.items[0], b);
      case 'conj': {
        const [l, r] = node.items;
        return yield* this._eclOrdered(ev, r.t === 'all' ? l : r, b);
      }
      case 'minus': return yield* this._eclOrdered(ev, node.a, b);
      case 'disj': {
        const inLeft = RoaringBitmap32.and(b, yield* ev.matG(node.items[0]));
        const left = yield* this._eclOrdered(ev, node.items[0], inLeft);
        const right = yield* this._eclOrdered(ev, node.items[1], RoaringBitmap32.andNot(b, inLeft));
        return left.concat(right);
      }
      default: break;
    }
    if (node.t === 'self' && b.has(node.id)) {
      const rest = b.clone(); rest.remove(node.id);
      return [node.id, ...(node.of ? yield* this._eclOrdered(ev, node.of, rest) : this._ordered(rest))];
    }
    if (this.store.hasLinkOrder && node.t === 'set' && node.kind === KIND.prop && this.store.hierarchy && node.pid === this.store.hierarchy.id) {
      const ordered = [...new Set(this.store.linkSourcesInOrder(node.pid, node.value).filter((id) => b.has(id)))];
      return [...ordered, ...this._ordered(RoaringBitmap32.andNot(b, new RoaringBitmap32(ordered)))];
    }
    return this._ordered(b);
  }

  _ordered(b) {
    const { rank, ids } = this._order;
    const arr = b.toUint32Array();
    const ranks = new Uint32Array(arr.length);
    for (let i = 0; i < arr.length; i++) ranks[i] = rank[arr[i]];
    ranks.sort();
    const out = new Array(ranks.length);
    for (let k = 0; k < ranks.length; k++) out[k] = ids[ranks[k]];
    return out;
  }

  /** driver (free) and costly filters, if this node is worth evaluating lazily */
  * _lazyPlan(ev, node, active, excl) {
    const items = node.t === 'and' ? node.items : [node];
    const free = items.filter((i) => ev.isFree(i));
    const costly = items.filter((i) => !ev.isFree(i) && ((i.t === 'text' && !i.lits) || (i.t === 'desigRegex' && !i.lits) || i.t === 'litMatch' || i.t === 'descFilter' || (i.t === 'desigMatch' && i.re != null)));
    if (!costly.length || free.length + costly.length !== items.length) return null; // (a prefiltered text node is neither: evaluated whole)
    let driver = free.length ? (free.length === 1 ? free[0] : { t: 'and', items: free }) : { t: 'all' };
    if (active) driver = { t: 'and', items: [driver, { t: 'active' }] };
    const size = (yield* ev.matG(driver)).size;
    if (size < this.lazyMinDriver) return null;
    void excl;
    return { driver, filters: costly };
  }

  /** membership of one id in a node (validate-code): probes, never materialises costly inputs */
  contains(node, id, trace) {
    const ev = new Evaluator(this.store, { trace });
    ev.prefetch([node]);
    return ev.filter(node, new RoaringBitmap32([id])).has(id);
  }

  /** contains(), pausing (see runAsync) */
  async containsAsync(node, id, trace, pause = null) {
    const ev = new Evaluator(this.store, { trace });
    ev.prefetch([node]);
    return (await ev.filterAsync(node, new RoaringBitmap32([id]), pause)).has(id);
  }

  /** materialise one node (filter API) */
  evaluate(node, trace) {
    const ev = new Evaluator(this.store, { trace });
    ev.prefetch([node]);
    return ev.mat(node);
  }

  /** evaluate(), pausing (see runAsync) */
  evaluateAsync(node, trace, pause = null) {
    const ev = new Evaluator(this.store, { trace });
    ev.prefetch([node]);
    return ev.matAsync(node, pause);
  }
}

module.exports = { Engine, Result };
