//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * Observation/$lastn and Observation/$stats, from the values kept for each Observation
 * (indexing/observations.js).
 *
 * $lastn is a search (the normal Observation search parameters, which must say whose
 * observations - patient or subject - and which: category, or a parameter on the code) that
 * returns, of what matches, the most recent `max` (default 1) in each group of observations
 * with the same code, a group after another; _include, _count paging and the rest as for a
 * search.
 *
 * $stats works out statistics for a subject's observations with a code, over a period (the
 * last `duration` hours, or `period`; or all of them), from their valueQuantity: for each code
 * asked for, the observations with that code, and those components that have it. When the
 * code's observations have components, or members (hasMember), as panels do, each code in those
 * gets its own statistics too. One Observation for each, with a component for each statistic
 * asked for (in the observation-statistics code system), and with `include`, the observations
 * they come from (at most `limit`, the most recent). Observations entered in error are left out.
 *
 * The values are in their own unit when all of them have the same one; else in the canonical
 * UCUM unit when they can all be put in one; else the statistics can't be worked out (count
 * and total-count still are). total-count is every observation in the period, count those
 * with a value that could be used. The statistics:
 *
 *   average, maximum, minimum, sum, median
 *   variance, std-dev     population (divided by n)
 *   20-percent, 80-percent, 4-lower, 4-upper (quartiles), 5-1 ... 5-4 (quintiles):
 *                         percentiles, interpolating between the two values either side
 *                         (as spreadsheets' PERCENTILE.INC does)
 *   4-dev                 half the interquartile range
 *   skew                  the moment coefficient of skewness, m3 / m2^1.5
 *   kurtosis              excess kurtosis, m4 / m2^2 - 3
 *   regression            least squares against time: two components, the gradient (per
 *                         day: code.text "gradient") and the value at the start of the period
 *                         (code.text "intercept")
 *
 * A statistic that can't be worked out from what there is (no values; skew of values that are
 * all the same) is left out.
 *
 * @module rest/operations/observations
 */

const { badRequest } = require('../library/errors');
const { periodRange } = require('../../library/fhir-search-values');
const { parseReference, UCUM } = require('../indexing/values');
const { CODE, PANEL } = require('../indexing/observations');
const { majorMinor } = require('../indexing/definitions');

const STATISTICS = {
  'average': 'Average', 'maximum': 'Maximum', 'minimum': 'Minimum', 'count': 'Count', 'total-count': 'Total Count',
  'median': 'Median', 'std-dev': 'Standard Deviation', 'sum': 'Sum', 'variance': 'Variance', '20-percent': '20th Percentile',
  '80-percent': '80th Percentile', '4-lower': 'Lower Quartile', '4-upper': 'Upper Quartile', '4-dev': 'Quartile Deviation',
  '5-1': '1st Quintile', '5-2': '2nd Quintile', '5-3': '3rd Quintile', '5-4': '4th Quintile', 'skew': 'Skew', 'kurtosis': 'Kurtosis',
  'regression': 'Regression'
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** The observation-statistics code system, by FHIR version */
function statisticsSystem(fhirVersion) {
  const v = majorMinor(fhirVersion || '4.0');
  return Number(v.split('.')[0]) >= 5 ? 'http://hl7.org/fhir/observation-statistics' : 'http://terminology.hl7.org/CodeSystem/observation-statistics';
}

// ---- $lastn ----

/**
 * Observation/$lastn
 */
async function lastn(ep, freq, ctx) {
  const maxText = freq.params.filter(([n]) => n === 'max').map(([, v]) => v);
  if (maxText.length > 1 || (maxText.length === 1 && !/^[1-9]\d*$/.test(maxText[0].trim()))) {
    throw badRequest('max must be a whole number, 1 or more');
  }
  const max = maxText.length ? Math.min(Number(maxText[0].trim()), ep.settings.searchMaxResults) : 1;
  const params = freq.params.filter(([n]) => n !== 'max');
  if (param(freq, '_getpages') === undefined) {
    const names = params.map(([n]) => n.split(/[:.]/)[0]);
    if (!freq.compartment && !names.some(n => n === 'patient' || n === 'subject')) {
      throw badRequest('$lastn needs the patient or the subject (the patient or subject parameter)');
    }
    const defs = ep.definitions.forType('Observation');
    const onCode = (n) => {
      const d = defs.get(n);
      return !!d && typeof d.expression === 'string' && /\.code\b/.test(d.expression);
    };
    if (!names.some(n => n === 'category' || onCode(n))) {
      throw badRequest('$lastn needs a category, or a parameter on the code (such as code)');
    }
  }
  const r = await ep.searcher.search({ ...freq, params }, ctx, { lastn: max });
  r.resource.type = 'searchset';
  return r;
}

function param(freq, name) {
  const p = freq.params.find(([n]) => n === name);
  return p ? p[1] : undefined;
}

// ---- $stats: the inputs ----

/**
 * The inputs, from the URL (and a form), and a Parameters body: [{ name, text } | { name, part }]
 */
function readInputs(freq) {
  const out = freq.params.map(([name, text]) => ({ name, text }));
  const b = freq.body;
  if (b && typeof b === 'object' && !Array.isArray(b)) {
    if (b.resourceType !== 'Parameters') {
      throw badRequest('The body must be a Parameters resource');
    }
    for (const p of b.parameter || []) {
      out.push({ name: p.name, part: p });
    }
  }
  return out;
}

function primitive(input) {
  if (input.text !== undefined) {
    return input.text;
  }
  for (const k of Object.keys(input.part)) {
    if (k.startsWith('value') && k.length > 5) {
      const v = input.part[k];
      return v !== null && typeof v === 'object' ? undefined : v;
    }
  }
  return undefined;
}

function one(inputs, name) {
  const list = inputs.filter(i => i.name === name);
  if (list.length > 1) {
    throw badRequest(`There can only be one ${name}`);
  }
  return list[0];
}

/** The inputs of $stats, checked */
function statsInputs(ep, freq) {
  const inputs = readInputs(freq);

  const subjectInput = one(inputs, 'subject');
  let subjectText = subjectInput ? primitive(subjectInput) : undefined;
  if (subjectInput && subjectInput.part && subjectInput.part.valueReference) {
    subjectText = subjectInput.part.valueReference.reference;
  }
  if (typeof subjectText !== 'string' || !subjectText) {
    throw badRequest('$stats needs a subject (such as Patient/123)');
  }
  const subject = parseReference(subjectText.trim(), [freq.base]);
  if (!subject || !subject.local) {
    throw badRequest(`The subject ${subjectText} isn't a resource on this server: statistics are only worked out for its own observations`);
  }

  const codings = [];
  const systemInput = one(inputs, 'system');
  const system = systemInput ? primitive(systemInput) : undefined;
  for (const i of inputs.filter(x => x.name === 'code')) {
    const v = primitive(i);
    for (const code of String(v === undefined ? '' : v).split(',').map(s => s.trim()).filter(s => s)) {
      if (!system) {
        throw badRequest(`The code ${code} needs a system (or give a coding)`);
      }
      codings.push({ system, code });
    }
  }
  for (const i of inputs.filter(x => x.name === 'coding')) {
    if (i.part) {
      const c = i.part.valueCoding;
      if (!c || !c.system || !c.code) {
        throw badRequest('A coding must have a system and a code');
      }
      codings.push({ system: c.system, code: c.code, display: c.display });
    } else {
      for (const t of i.text.split(',').map(s => s.trim()).filter(s => s)) {
        const bar = t.lastIndexOf('|');
        if (bar <= 0 || bar === t.length - 1) {
          throw badRequest(`The coding ${t} must be system|code`);
        }
        codings.push({ system: t.substring(0, bar), code: t.substring(bar + 1) });
      }
    }
  }
  if (!codings.length) {
    throw badRequest('$stats needs a code (code and system, or coding)');
  }

  const statistics = [];
  for (const i of inputs.filter(x => x.name === 'statistic')) {
    const v = primitive(i);
    for (const s of String(v === undefined ? '' : v).split(',').map(x => x.trim()).filter(x => x)) {
      if (!STATISTICS[s]) {
        throw badRequest(`${s} isn't a statistic (they are ${Object.keys(STATISTICS).join(', ')})`);
      }
      if (!statistics.includes(s)) {
        statistics.push(s);
      }
    }
  }
  if (!statistics.length) {
    throw badRequest('$stats needs at least one statistic');
  }

  // the period
  const now = Date.now();
  let window = null;
  let period = null;
  const durationInput = one(inputs, 'duration');
  const periodInput = one(inputs, 'period');
  if (durationInput) {
    const h = Number(primitive(durationInput));
    if (!Number.isFinite(h) || h <= 0) {
      throw badRequest('duration must be a number of hours, more than 0');
    }
    window = { lo: now - h * 3600000, hi: now };
    period = { start: new Date(window.lo).toISOString(), end: new Date(window.hi).toISOString() };
  } else if (periodInput) {
    const p = periodInput.part ? periodInput.part.valuePeriod : null;
    if (!p) {
      throw badRequest('period must be a Period (in a Parameters body)');
    }
    window = periodRange(p, ep.timeZone);
    if (!window) {
      throw badRequest('The period can\'t be read');
    }
    period = { ...p };
  }

  const includeInput = one(inputs, 'include');
  const include = includeInput ? String(primitive(includeInput)) === 'true' : false;
  const limitInput = one(inputs, 'limit');
  let limit = null;
  if (limitInput) {
    const l = Number(primitive(limitInput));
    if (!Number.isInteger(l) || l < 1) {
      throw badRequest('limit must be a whole number, 1 or more');
    }
    limit = l;
  }
  return { subject, codings, statistics, window, period, include, limit };
}

// ---- $stats: the numbers ----

function percentile(sorted, p) {
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  return lo + 1 < sorted.length ? sorted[lo] + (h - lo) * (sorted[lo + 1] - sorted[lo]) : sorted[lo];
}

/**
 * The statistics of some values.
 * @param {Array<{value: number, at: number}>} points - at: epoch ms
 * @param {number} [t0] - the time regression's intercept is at (default: the first point's)
 * @returns {Object} by statistic code (regression: { gradient, intercept }); those that
 *   can't be worked out are missing
 */
function computeStatistics(points, t0) {
  const out = {};
  const n = points.length;
  out.count = n;
  if (n === 0) {
    return out;
  }
  const xs = points.map(p => p.value);
  const sorted = [...xs].sort((a, b) => a - b);
  const sum = xs.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  out.sum = sum;
  out.average = mean;
  out.minimum = sorted[0];
  out.maximum = sorted[n - 1];
  out.median = percentile(sorted, 0.5);
  const m2 = xs.reduce((a, x) => a + (x - mean) ** 2, 0) / n;
  const m3 = xs.reduce((a, x) => a + (x - mean) ** 3, 0) / n;
  const m4 = xs.reduce((a, x) => a + (x - mean) ** 4, 0) / n;
  out.variance = m2;
  out['std-dev'] = Math.sqrt(m2);
  out['20-percent'] = percentile(sorted, 0.2);
  out['80-percent'] = percentile(sorted, 0.8);
  out['4-lower'] = percentile(sorted, 0.25);
  out['4-upper'] = percentile(sorted, 0.75);
  out['4-dev'] = (out['4-upper'] - out['4-lower']) / 2;
  out['5-1'] = percentile(sorted, 0.2);
  out['5-2'] = percentile(sorted, 0.4);
  out['5-3'] = percentile(sorted, 0.6);
  out['5-4'] = percentile(sorted, 0.8);
  if (m2 > 0) {
    out.skew = m3 / Math.pow(m2, 1.5);
    out.kurtosis = m4 / (m2 * m2) - 3;
  }
  // regression: days since t0
  const base = t0 === undefined || t0 === null ? Math.min(...points.map(p => p.at)) : t0;
  const ds = points.map(p => (p.at - base) / DAY_MS);
  const md = ds.reduce((a, b) => a + b, 0) / n;
  const sxx = ds.reduce((a, d) => a + (d - md) ** 2, 0);
  if (sxx > 0) {
    const sxy = ds.reduce((a, d, i) => a + (d - md) * (xs[i] - mean), 0);
    const gradient = sxy / sxx;
    out.regression = { gradient, intercept: mean - gradient * md };
  }
  return out;
}

// ---- $stats: the operation ----

const VALUE_COLUMNS = 'ov.ValueKey, ov.ResourceKey, ov.Component, ov.CodeGroup, ov.CodeText, ov.Effective, ov.Value, ov.UnitSpaceKey, ov.Unit, ' +
  'ov.UnitDisplay, ov.Canonical, ov.CanonicalUnit';

/** A Quantity for a statistic, in the units the values are in */
function statQuantity(value, units, kind) {
  const q = { value: Number(value.toPrecision(15)) };
  let code = units.code;
  let display = units.display;
  if (kind === 'squared') {
    code = code && code !== '1' ? `(${code}).(${code})` : code;
    display = display ? `(${display})²` : display;
  } else if (kind === 'per-day') {
    code = code && code !== '1' ? `(${code})/d` : '/d';
    display = display ? `${display}/day` : 'per day';
  } else if (kind === 'none') {
    return { value: q.value, system: UCUM, code: '1' };
  }
  if (display) {
    q.unit = display;
  }
  if (units.system) {
    q.system = units.system;
    if (code) {
      q.code = code;
    }
  }
  return q;
}

async function stats(ep, freq, ctx) {
  const input = statsInputs(ep, freq);
  const statsSystem = statisticsSystem(ep.definitions.fhirVersion);
  const hasMember = ep.definitions.param('Observation', 'has-member');
  const hasMemberKey = hasMember && hasMember.key !== null && hasMember.key !== undefined ? Number(hasMember.key) : null;

  const result = await ep.inRead(ctx, async (q) => {
    const where = ['ov.SubjectType = ?', 'ov.SubjectId = ?', "(ov.Status IS NULL OR ov.Status <> 'entered-in-error')"];
    const args = [input.subject.type, input.subject.id];
    if (input.window) {
      where.push('ov.EffectiveHi > ?', 'ov.EffectiveLo < ?');
      args.push(input.window.lo, input.window.hi);
    }
    const acc = ep.compartmentFilter(ctx.access, 'ov.ResourceKey');
    if (acc) {
      where.push(acc.sql);
      args.push(...acc.args);
    }
    const base = `SELECT ${VALUE_COLUMNS} FROM ObservationValues ov JOIN Ids i ON i.ResourceKey = ov.ResourceKey AND i.Deleted = 0 WHERE ${where.join(' AND ')}`;

    const groups = [];
    for (const coding of input.codings) {
      const sk = await ep.lookups.spaceKey(q, coding.system);
      const ck = sk === null ? null : (await ep.lookups.conceptKeys(q, [[sk, coding.code]], false)).get(sk + '|' + coding.code);
      let direct = [];
      let members = [];
      if (ck) {
        direct = await q.all(`${base} AND ov.ValueKey IN (SELECT ValueKey FROM ObservationCodes WHERE ConceptKey = ? AND Source = ${CODE})`, [...args, ck]);
        // a panel: its components, and its members
        members = await q.all(`${base} AND ov.ValueKey IN (SELECT ValueKey FROM ObservationCodes WHERE ConceptKey = ? AND Source = ${PANEL})`, [...args, ck]);
        if (hasMemberKey !== null) {
          members.push(...await q.all(`${base} AND ov.Component = 0 AND ov.ResourceKey IN (SELECT r.TargetKey FROM IndexReferences r
            WHERE r.ParamKey = ? AND r.TargetKey IS NOT NULL AND r.ResourceKey IN (SELECT pv.ResourceKey FROM ObservationValues pv
            JOIN ObservationCodes pc ON pc.ValueKey = pv.ValueKey WHERE pc.ConceptKey = ? AND pc.Source = ${CODE} AND pv.Component = 0
            AND pv.SubjectType = ? AND pv.SubjectId = ?))`, [...args, hasMemberKey, ck, input.subject.type, input.subject.id]));
        }
      }
      const seen = new Set(direct.map(r => Number(r.ValueKey)));
      const byGroup = new Map();
      for (const r of members) {
        const k = Number(r.ValueKey);
        if (seen.has(k)) {
          continue;
        }
        seen.add(k);
        if (!byGroup.has(r.CodeGroup)) {
          byGroup.set(r.CodeGroup, []);
        }
        byGroup.get(r.CodeGroup).push(r);
      }
      // the code itself: unless all it has are panels whose parts have their own statistics
      if (!byGroup.size || direct.some(r => r.Value !== null)) {
        groups.push({ code: { coding: [{ system: coding.system, code: coding.code, ...(coding.display ? { display: coding.display } : {}) }] }, rows: direct });
      }
      for (const g of [...byGroup.keys()].sort()) {
        const rows = byGroup.get(g);
        groups.push({ code: await codeOf(q, rows[0]), rows });
      }
    }
    for (const g of groups) {
      g.units = await unitsOf(q, g.rows);
    }
    let sources = [];
    if (input.include) {
      const latest = new Map();
      for (const g of groups) {
        for (const r of g.rows) {
          const k = Number(r.ResourceKey);
          latest.set(k, Math.max(latest.get(k) || -Infinity, Number(r.Effective)));
        }
      }
      let keys = [...latest.keys()].sort((a, b) => latest.get(b) - latest.get(a) || b - a);
      const cap = Math.min(input.limit || ep.settings.searchMaxResults, ep.settings.searchMaxResults);
      keys = keys.slice(0, cap);
      sources = await ep.searcher.byKeys(q, keys);
    }
    return { groups, sources };
  });

  const parameter = [];
  for (const g of result.groups) {
    parameter.push({ name: 'statistics', resource: statisticsObservation(g, input, statsSystem) });
  }
  for (const s of result.sources) {
    parameter.push({ name: 'source', resource: ep.shapeResource(s.resource, freq, {}) });
  }
  return { status: 200, resource: { resourceType: 'Parameters', parameter } };
}

/** The code of a group of values, from one of them */
async function codeOf(q, row) {
  const rows = await q.all(`SELECT s.Uri, c.Code FROM ObservationCodes oc JOIN Concepts c ON c.ConceptKey = oc.ConceptKey
    JOIN Spaces s ON s.SpaceKey = c.SpaceKey WHERE oc.ValueKey = ? AND oc.Source = ${CODE} ORDER BY s.Uri, c.Code`, [row.ValueKey]);
  const code = {};
  if (rows.length) {
    code.coding = rows.map(r => ({ system: r.Uri, code: r.Code }));
  }
  if (row.CodeText) {
    code.text = row.CodeText;
  }
  return code;
}

/**
 * The units a group's values can be compared in: { mode: 'native' | 'canonical' |
 * 'inconsistent' | 'none', system, code, display, values: [{value, at}] }
 */
async function unitsOf(q, rows) {
  const valued = rows.filter(r => r.Value !== null && r.Value !== undefined);
  if (!valued.length) {
    return { mode: 'none', values: [] };
  }
  const first = valued[0];
  const sameUnit = valued.every(r => String(r.UnitSpaceKey) === String(first.UnitSpaceKey) && (r.Unit || '') === (first.Unit || ''));
  if (sameUnit) {
    let system = null;
    if (first.UnitSpaceKey !== null && first.UnitSpaceKey !== undefined) {
      const s = await q.get('SELECT Uri FROM Spaces WHERE SpaceKey = ?', [first.UnitSpaceKey]);
      system = s ? s.Uri : null;
    }
    return { mode: 'native', system, code: first.Unit || null, display: first.UnitDisplay || first.Unit || null,
      values: valued.map(r => ({ value: Number(r.Value), at: Number(r.Effective) })) };
  }
  if (valued.every(r => r.CanonicalUnit !== null && r.CanonicalUnit === first.CanonicalUnit)) {
    return { mode: 'canonical', system: UCUM, code: first.CanonicalUnit, display: first.CanonicalUnit,
      values: valued.map(r => ({ value: Number(r.Canonical), at: Number(r.Effective) })) };
  }
  const units = [...new Set(valued.map(r => r.Unit || r.UnitDisplay || '(none)'))];
  return { mode: 'inconsistent', units, values: valued.map(r => ({ value: Number(r.Value), at: Number(r.Effective) })) };
}

function statisticsObservation(g, input, statsSystem) {
  const obs = { resourceType: 'Observation', status: 'final', code: g.code, subject: { reference: `${input.subject.type}/${input.subject.id}` } };
  if (input.period) {
    obs.effectivePeriod = input.period;
  } else if (g.rows.length) {
    const times = g.rows.map(r => Number(r.Effective));
    obs.effectivePeriod = { start: new Date(Math.min(...times)).toISOString(), end: new Date(Math.max(...times)).toISOString() };
  }
  const u = g.units;
  const usable = u.mode === 'native' || u.mode === 'canonical';
  const s = usable ? computeStatistics(u.values, input.window ? input.window.lo : undefined) : {};
  const component = [];
  const comp = (code, value, text) => {
    const c = { code: { coding: [{ system: statsSystem, code, display: STATISTICS[code] }] } };
    if (text) {
      c.code.text = text;
    }
    Object.assign(c, value);
    component.push(c);
  };
  for (const code of input.statistics) {
    if (code === 'total-count') {
      comp(code, { valueInteger: g.rows.length });
    } else if (code === 'count') {
      comp(code, { valueInteger: usable ? u.values.length : 0 });
    } else if (code === 'regression') {
      if (s.regression) {
        comp(code, { valueQuantity: statQuantity(s.regression.gradient, u, 'per-day') }, 'gradient');
        comp(code, { valueQuantity: statQuantity(s.regression.intercept, u) }, 'intercept');
      }
    } else if (s[code] !== undefined) {
      const kind = code === 'variance' ? 'squared' : (code === 'skew' || code === 'kurtosis') ? 'none' : null;
      comp(code, { valueQuantity: statQuantity(s[code], u, kind) });
    }
  }
  if (component.length) {
    obs.component = component;
  }
  if (u.mode === 'inconsistent') {
    obs.note = [{ text: `The values have units that can't all be compared (${u.units.join(', ')}), so only the counts are given` }];
  }
  return obs;
}

module.exports = { lastn, stats, computeStatistics, statisticsSystem, STATISTICS };
