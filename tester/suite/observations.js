//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// The Observation operations the server lists: $lastn and $stats

const { patient, observation, LOINC, UCUM } = require('./common');

const CATEGORY = { system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs', display: 'Vital Signs' };
const WEIGHT = { system: LOINC, code: '29463-7', display: 'Body weight' };
const HEIGHT = { system: LOINC, code: '8302-2', display: 'Body height' };

/** An Observation of a patient's, of a code, at a time, with a value */
function vital(ctx, patientId, code, when, value, unit) {
  return observation(ctx, patientId, {
    category: [{ coding: [CATEGORY] }],
    code: { coding: [code] },
    effectiveDateTime: when,
    valueQuantity: { value, unit, system: UCUM, code: unit }
  });
}

/** The ids of what a $lastn found, as a sorted list, for messages */
function show(ids) {
  return ids.length ? [...ids].sort().join(', ') : 'nothing';
}

function same(a, b) {
  return a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');
}

/** A patient with weights and heights over 2020, and another patient with a weight of their own */
async function patients(ctx) {
  const p = await ctx.create(patient(ctx));
  const other = await ctx.create(patient(ctx));
  const w = [];
  for (const [when, value] of [['2020-01-10T09:00:00Z', 70], ['2020-03-10T09:00:00Z', 72], ['2020-05-10T09:00:00Z', 74], ['2020-07-10T09:00:00Z', 76]]) {
    w.push((await ctx.create(vital(ctx, p.id, WEIGHT, when, value, 'kg'))).id);
  }
  const h = [];
  for (const [when, value] of [['2020-02-10T09:00:00Z', 170], ['2020-06-10T09:00:00Z', 171]]) {
    h.push((await ctx.create(vital(ctx, p.id, HEIGHT, when, value, 'cm'))).id);
  }
  const ow = (await ctx.create(vital(ctx, other.id, WEIGHT, '2020-08-10T09:00:00Z', 90, 'kg'))).id;
  return { p, other, w, h, ow };
}

/** The statistic's value in a $stats Observation's components (by code, whatever the code system), or undefined */
function statistic(obs, code) {
  const c = (obs.component || []).find(x => x && x.code && (x.code.coding || []).some(k => k && k.code === code));
  if (!c) {
    return undefined;
  }
  if (c.valueQuantity && typeof c.valueQuantity.value === 'number') {
    return c.valueQuantity.value;
  }
  return typeof c.valueInteger === 'number' ? c.valueInteger : typeof c.valueDecimal === 'number' ? c.valueDecimal : null;
}

module.exports = {
  name: 'Observation operations',
  tests: [
    {
      name: '$lastn: the latest observation of each code',
      requires: { interactions: [['Patient', 'create'], ['Observation', 'create']], operations: [['Observation', 'lastn']] },
      run: async (ctx) => {
        const d = await patients(ctx);
        const lastn = async (params, what) => {
          // the CapabilityStatement lists $lastn, so a refusal is the statement being wrong
          const res = ctx.status(await ctx.client.get(`Observation/$lastn?${params.map(([n, v]) => `${encodeURIComponent(n)}=${encodeURIComponent(v)}`).join('&')}`), 200,
            `${what} (the CapabilityStatement lists $lastn for Observation)`);
          const bundle = ctx.body(res, 'Bundle', what);
          ctx.should(bundle.type === 'searchset', `${what}: the Bundle is a ${bundle.type}, not a searchset`);
          return (await ctx.allPages(bundle, 'Observation', what)).ids;
        };
        const category = ['category', `${CATEGORY.system}|${CATEGORY.code}`];
        const subject = ['patient', `Patient/${d.p.id}`];

        let what = `$lastn?patient=Patient/${d.p.id}&category=vital-signs`;
        let ids = await lastn([subject, category], what);
        let expected = [d.w[3], d.h[1]];
        ctx.must(same(ids, expected), `${what} found ${show(ids)}, not the latest weight and height (${show(expected)})`);

        what = `$lastn?patient=Patient/${d.p.id}&category=vital-signs&max=2`;
        ids = await lastn([subject, category, ['max', '2']], what);
        expected = [d.w[3], d.w[2], d.h[1], d.h[0]];
        ctx.must(same(ids, expected), `${what} found ${show(ids)}, not the two latest weights and heights (${show(expected)})`);

        what = `$lastn?patient=Patient/${d.p.id}&category=vital-signs&code=${WEIGHT.system}|${WEIGHT.code}&max=3`;
        ids = await lastn([subject, category, ['code', `${WEIGHT.system}|${WEIGHT.code}`], ['max', '3']], what);
        expected = [d.w[3], d.w[2], d.w[1]];
        ctx.must(same(ids, expected), `${what} found ${show(ids)}, not the three latest weights (${show(expected)})`);
        ctx.must(!ids.includes(d.ow), `${what} found the other patient's weight`);
      }
    },
    {
      name: '$stats: statistics of a patient\'s observations of a code',
      requires: { interactions: [['Patient', 'create'], ['Observation', 'create']], operations: [['Observation', 'stats']] },
      run: async (ctx) => {
        const d = await patients(ctx);
        const params = {
          resourceType: 'Parameters',
          parameter: [
            { name: 'subject', valueUri: `Patient/${d.p.id}` },
            { name: 'code', valueString: WEIGHT.code },
            { name: 'system', valueUri: WEIGHT.system },
            { name: 'period', valuePeriod: { start: '2020-01-01T00:00:00Z', end: '2020-12-31T23:59:59Z' } },
            ...['average', 'minimum', 'maximum', 'count'].map(s => ({ name: 'statistic', valueCode: s }))
          ]
        };
        const what = `$stats of Patient/${d.p.id}'s body weights in 2020`;
        const res = ctx.status(await ctx.client.post('Observation/$stats', params), 200, `${what} (the CapabilityStatement lists $stats for Observation)`);
        const out = ctx.body(res, 'Parameters', what);
        const stats = (out.parameter || []).filter(p => p && p.name === 'statistics' && p.resource && p.resource.resourceType === 'Observation').map(p => p.resource);
        ctx.must(stats.length > 0, `${what}: the Parameters has no "statistics" Observation`);
        const obs = stats.find(o => o.code && (o.code.coding || []).some(c => c && c.system === WEIGHT.system && c.code === WEIGHT.code)) || stats[0];
        const close = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-6;
        for (const [code, value] of [['average', 73], ['minimum', 70], ['maximum', 76], ['count', 4]]) {
          const v = statistic(obs, code);
          ctx.must(v !== undefined, `${what}: there is no ${code} component`);
          ctx.must(close(v, value), `${what}: the ${code} is ${JSON.stringify(v)}, not ${value} (the other patient's weight, 90 kg, isn't theirs)`);
        }
        const avg = (obs.component || []).find(x => x && x.code && (x.code.coding || []).some(k => k && k.code === 'average'));
        ctx.should(avg && avg.valueQuantity && (avg.valueQuantity.code === 'kg' || avg.valueQuantity.unit === 'kg'),
          `${what}: the average isn't in kg, the unit of the observations`);
        ctx.should(obs.subject && String(obs.subject.reference || '').endsWith(`Patient/${d.p.id}`), `${what}: the statistics Observation's subject isn't the patient`);
      }
    }
  ]
};
