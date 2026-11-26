//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * The values of Observations, kept for $lastn and $stats (operations/observations.js), the way
 * the old Pascal server did: written with the resource's other index rows, in the write
 * transaction (indexer.js), and taken out with them.
 *
 * An Observation gets rows only if it has an effective[x] and a code (codings, or text). Then
 * it has a row for itself (Component 0), and one for each component (1, 2, ...), each with:
 *
 *   CodeGroup     the code as one string: its codings' concept keys, in order ("12,40"), or,
 *                 for a code with only text, "t:" and the text (lower case). Observations
 *                 with the same codings are in the same group (as the Pascal server grouped
 *                 them). Too long, it is a hash ("h:...")
 *   Subject       the subject's type and id, when it is a local reference (Patient/123)
 *   Status        Observation.status
 *   Effective     the time to sort by: the dateTime or instant, the end of a period (its start,
 *                 when it has no end), the last time of a Timing; EffectiveLo and EffectiveHi,
 *                 the range it covers
 *   Value         a valueQuantity's value, unit (code, system, and what's shown), and when the
 *                 unit is UCUM, its canonical form (values.canonicalQuantity)
 *
 * and in ObservationCodes, the concepts of its code (Source 2), the observation's categories
 * (Source 1), and for a component, the observation's own code (Source 3: a panel's members).
 *
 * @module rest/indexing/observations
 */

const crypto = require('crypto');
const { dateRange, periodRange } = require('../../library/fhir-search-values');
const { canonicalQuantity, parseReference, normalise, truncate, UCUM } = require('./values');

const CATEGORY = 1;
const CODE = 2;
const PANEL = 3;

const MAX_GROUP = 255;
const MAX_COMPONENTS = 100;

function codings(cc) {
  if (!cc || typeof cc !== 'object' || !Array.isArray(cc.coding)) {
    return [];
  }
  return cc.coding.filter(c => c && typeof c.system === 'string' && c.system && typeof c.code === 'string' && c.code);
}

function text(cc) {
  return cc && typeof cc.text === 'string' && cc.text.trim() ? cc.text.trim() : null;
}

/**
 * When an Observation was: { at, lo, hi } (epoch ms), or null if it has no effective[x] (or
 * none that can be read).
 */
function effective(obs, timeZone) {
  if (typeof obs.effectiveDateTime === 'string' || typeof obs.effectiveInstant === 'string') {
    const r = dateRange(obs.effectiveDateTime || obs.effectiveInstant, timeZone);
    return r ? { at: r.lo, lo: r.lo, hi: r.hi } : null;
  }
  if (obs.effectivePeriod && typeof obs.effectivePeriod === 'object') {
    const r = periodRange(obs.effectivePeriod, timeZone);
    if (!r) {
      return null;
    }
    const end = obs.effectivePeriod.end ? dateRange(obs.effectivePeriod.end, timeZone) : null;
    const start = obs.effectivePeriod.start ? dateRange(obs.effectivePeriod.start, timeZone) : null;
    return { at: end ? end.lo : start.lo, lo: r.lo, hi: r.hi };
  }
  if (obs.effectiveTiming && typeof obs.effectiveTiming === 'object') {
    const t = obs.effectiveTiming;
    const events = (Array.isArray(t.event) ? t.event : []).map(e => dateRange(e, timeZone)).filter(r => r);
    if (events.length) {
      const lo = Math.min(...events.map(r => r.lo));
      const hi = Math.max(...events.map(r => r.hi));
      return { at: Math.max(...events.map(r => r.lo)), lo, hi };
    }
    if (t.repeat && t.repeat.boundsPeriod) {
      const r = periodRange(t.repeat.boundsPeriod, timeZone);
      if (r) {
        const end = t.repeat.boundsPeriod.end ? dateRange(t.repeat.boundsPeriod.end, timeZone) : null;
        return { at: end ? end.lo : r.lo, lo: r.lo, hi: r.hi };
      }
    }
  }
  return null;
}

function quantity(q) {
  if (!q || typeof q !== 'object' || typeof q.value !== 'number' || !Number.isFinite(q.value)) {
    return null;
  }
  const out = { value: q.value, system: typeof q.system === 'string' ? q.system : null, unit: typeof q.code === 'string' ? q.code : null,
    display: typeof q.unit === 'string' ? q.unit : null };
  if (!out.unit && !out.system && out.display) {
    // a unit given only as text
    out.unit = out.display;
  }
  if (out.system === UCUM && out.unit) {
    out.canonical = canonicalQuantity(out.unit, q.value);
  }
  return out;
}

/**
 * The values of an Observation, before the keys are known: null if it doesn't have them.
 * @param {Object} obs
 * @param {Object} [options] - { timeZone (for dates without one), baseUrls (that are this server) }
 * @returns {{values: Object[], categories: Object[], panel: Object[]}|null}
 */
function extract(obs, options = {}) {
  const timeZone = options.timeZone;
  if (!obs || obs.resourceType !== 'Observation') {
    return null;
  }
  const when = effective(obs, timeZone);
  const own = codings(obs.code);
  if (!when || (own.length === 0 && !text(obs.code))) {
    return null;
  }
  const ref = obs.subject && typeof obs.subject.reference === 'string' ? parseReference(obs.subject.reference, options.baseUrls || []) : null;
  const subject = ref && ref.local ? ref : null;
  const common = {
    subjectType: subject ? subject.type : null,
    subjectId: subject ? subject.id : null,
    status: typeof obs.status === 'string' ? obs.status : null,
    when
  };
  const values = [{ ...common, component: 0, codings: own, text: text(obs.code), quantity: quantity(obs.valueQuantity) }];
  const comps = Array.isArray(obs.component) ? obs.component.slice(0, MAX_COMPONENTS) : [];
  comps.forEach((c, i) => {
    if (c && typeof c === 'object' && (codings(c.code).length || text(c.code))) {
      values.push({ ...common, component: i + 1, codings: codings(c.code), text: text(c.code), quantity: quantity(c.valueQuantity) });
    }
  });
  const categories = (Array.isArray(obs.category) ? obs.category : []).flatMap(codings);
  return { values, categories, panel: own };
}

function codeGroup(conceptKeys, codeText) {
  let g;
  if (conceptKeys.length) {
    g = [...new Set(conceptKeys)].sort((a, b) => a - b).join(',');
  } else {
    g = 't:' + normalise(codeText);
  }
  if (g.length > MAX_GROUP) {
    g = 'h:' + crypto.createHash('sha256').update(g).digest('hex');
  }
  return g;
}

/**
 * Write an Observation's values (its old ones are gone: remove).
 * @param {Object} q - in the write transaction
 * @param {import('../database/lookups').Lookups} lookups
 * @param {number} resourceKey
 * @param {Object} obs
 * @param {Object} [options] - as for extract
 */
async function write(q, lookups, resourceKey, obs, options) {
  const x = extract(obs, options);
  if (!x) {
    return;
  }
  const all = [...x.categories, ...x.panel, ...x.values.flatMap(v => v.codings)];
  const systems = [...new Set([...all.map(c => c.system), ...x.values.filter(v => v.quantity && v.quantity.system).map(v => v.quantity.system)])];
  const spaces = await lookups.spaceKeys(q, systems);
  const concepts = await lookups.conceptKeys(q, all.map(c => [spaces.get(c.system), c.code]));
  const keyOf = (c) => concepts.get(spaces.get(c.system) + '|' + c.code);
  const keysOf = (list) => [...new Set(list.map(keyOf).filter(k => k))];
  const categoryKeys = keysOf(x.categories);
  const panelKeys = keysOf(x.panel);
  for (const v of x.values) {
    const own = keysOf(v.codings);
    const qty = v.quantity;
    const r = await q.run(`INSERT INTO ObservationValues (ResourceKey, Component, CodeGroup, CodeText, SubjectType, SubjectId, Status, Effective,
      EffectiveLo, EffectiveHi, Value, UnitSpaceKey, Unit, UnitDisplay, Canonical, CanonicalUnit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [resourceKey, v.component, codeGroup(own, v.text), v.text ? truncate(v.text, 255) : null, v.subjectType, v.subjectId,
      v.status ? truncate(v.status, 32) : null, v.when.at, v.when.lo, v.when.hi,
      qty ? qty.value : null, qty && qty.system ? spaces.get(qty.system) : null, qty && qty.unit ? truncate(qty.unit, 128) : null,
      qty && qty.display ? truncate(qty.display, 128) : null, qty && qty.canonical ? qty.canonical.value : null,
      qty && qty.canonical ? truncate(qty.canonical.unit, 128) : null]);
    const valueKey = Number(r.lastId);
    const codes = [...own.map(k => [CODE, k]), ...categoryKeys.map(k => [CATEGORY, k])];
    if (v.component > 0) {
      codes.push(...panelKeys.map(k => [PANEL, k]));
    }
    if (codes.length) {
      await q.run('INSERT INTO ObservationCodes (ValueKey, Source, ConceptKey) VALUES ' + codes.map(() => '(?, ?, ?)').join(', '),
        codes.flatMap(([s, k]) => [valueKey, s, k]));
    }
  }
}

/** Take out a resource's values */
async function remove(q, resourceKey) {
  await q.run('DELETE FROM ObservationCodes WHERE ValueKey IN (SELECT ValueKey FROM ObservationValues WHERE ResourceKey = ?)', [resourceKey]);
  await q.run('DELETE FROM ObservationValues WHERE ResourceKey = ?', [resourceKey]);
}

module.exports = { extract, write, remove, codeGroup, effective, CATEGORY, CODE, PANEL };
