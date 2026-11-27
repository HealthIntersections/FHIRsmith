//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// Observation/$lastn and Observation/$stats, from the values kept for each Observation
// (rest/indexing/observations.js, rest/operations/observations.js).

const request = require('supertest');
const { engines, makeApp, body, invariants, FHIR_JSON } = require('./helpers');
const { computeStatistics, statisticsSystem, STATISTICS } = require('../../rest/operations/observations');
const { extract, codeGroup } = require('../../rest/indexing/observations');

const LOINC = 'http://loinc.org';
const UCUM = 'http://unitsofmeasure.org';
const STATS = 'http://terminology.hl7.org/CodeSystem/observation-statistics';
const VITALS = { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] };
const LAB = { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'laboratory' }] };

const code = (c, display) => ({ coding: [{ system: LOINC, code: c, display }] });
const qty = (value, unit) => ({ value, unit, system: UCUM, code: unit });

describe('the statistics', () => {
  const pts = (...vs) => vs.map((value, i) => ({ value, at: Date.UTC(2026, 0, 1 + i) }));

  test('the values 1 to 5', () => {
    const s = computeStatistics(pts(5, 3, 1, 4, 2));
    expect(s.count).toBe(5);
    expect(s.sum).toBe(15);
    expect(s.average).toBe(3);
    expect(s.minimum).toBe(1);
    expect(s.maximum).toBe(5);
    expect(s.median).toBe(3);
    expect(s.variance).toBe(2);
    expect(s['std-dev']).toBeCloseTo(Math.SQRT2);
    expect(s['4-lower']).toBe(2);
    expect(s['4-upper']).toBe(4);
    expect(s['4-dev']).toBe(1);
    expect(s['20-percent']).toBeCloseTo(1.8);
    expect(s['80-percent']).toBeCloseTo(4.2);
    expect(s['5-1']).toBeCloseTo(1.8);
    expect(s['5-2']).toBeCloseTo(2.6);
    expect(s['5-3']).toBeCloseTo(3.4);
    expect(s['5-4']).toBeCloseTo(4.2);
    expect(s.skew).toBeCloseTo(0);
    expect(s.kurtosis).toBeCloseTo(-1.3);
    // 5, 3, 1, 4, 2 on days 0..4: gradient -0.5 a day
    expect(s.regression.gradient).toBeCloseTo(-0.5);
    expect(s.regression.intercept).toBeCloseTo(4);
  });

  test('an even number, skewed values, and what can\'t be worked out', () => {
    const s = computeStatistics(pts(1, 2, 3, 10));
    expect(s.median).toBe(2.5);
    expect(s.skew).toBeGreaterThan(0);
    const same = computeStatistics([{ value: 7, at: 0 }, { value: 7, at: 0 }]);
    expect(same.skew).toBeUndefined();
    expect(same.kurtosis).toBeUndefined();
    expect(same.regression).toBeUndefined();
    expect(same['std-dev']).toBe(0);
    expect(computeStatistics([])).toEqual({ count: 0 });
    expect(computeStatistics([{ value: 4, at: 0 }])).toMatchObject({ average: 4, median: 4, '4-lower': 4, '5-4': 4 });
  });

  test('the statistics code system, by version', () => {
    expect(statisticsSystem('4.0.1')).toBe('http://terminology.hl7.org/CodeSystem/observation-statistics');
    expect(statisticsSystem('5.0.0')).toBe('http://hl7.org/fhir/observation-statistics');
  });

  test('which observations have values, and what they are', () => {
    expect(extract({ resourceType: 'Observation', code: code('1'), valueQuantity: qty(1, 'kg') })).toBeNull();
    expect(extract({ resourceType: 'Observation', effectiveDateTime: '2026-01-01', valueQuantity: qty(1, 'kg') })).toBeNull();
    const x = extract({ resourceType: 'Observation', status: 'final', subject: { reference: 'Patient/p' }, category: [VITALS],
      code: code('85354-9'), effectivePeriod: { start: '2026-01-01T10:00:00Z', end: '2026-01-01T11:00:00Z' },
      component: [{ code: code('8480-6'), valueQuantity: qty(120, 'mm[Hg]') }, { code: { text: 'Note' }, valueString: 'x' }, { valueQuantity: qty(1, 'kg') }] },
    { timeZone: 'UTC' });
    expect(x.values.map(v => v.component)).toEqual([0, 1, 2]);
    expect(x.values[0].when.at).toBe(Date.UTC(2026, 0, 1, 11));
    expect(x.values[0]).toMatchObject({ subjectType: 'Patient', subjectId: 'p', status: 'final', quantity: null });
    expect(x.values[1].quantity).toMatchObject({ value: 120, unit: 'mm[Hg]', system: UCUM });
    expect(x.values[1].quantity.canonical.unit).toBe('g.m-1.s-2');
    expect(x.categories.map(c => c.code)).toEqual(['vital-signs']);
    expect(codeGroup([40, 12, 40], null)).toBe('12,40');
    expect(codeGroup([], 'Blood Sugar')).toBe('t:blood sugar');
    expect(codeGroup([], 'x'.repeat(300))).toMatch(/^h:[0-9a-f]{64}$/);
  });
});

describe.each(engines())('$lastn and $stats (%s)', (engine) => {
  let t;
  let pat;
  let other;

  const send = (method, url, resource) => request(t.app)[method](url).set('Content-Type', FHIR_JSON).send(body(resource));
  const post = async (resource) => {
    const r = await send('post', `/r4/${resource.resourceType}`, resource);
    if (r.status !== 201) {
      throw new Error(`create failed: ${r.status} ${JSON.stringify(r.body)}`);
    }
    return r.body.id;
  };
  const obs = (patient, c, when, extra = {}) => post({ resourceType: 'Observation', status: 'final', category: [VITALS], code: c,
    subject: { reference: `Patient/${patient}` }, effectiveDateTime: when, ...extra });
  const matches = (r) => (r.body.entry || []).filter(e => e.search.mode === 'match').map(e => e.resource);
  const lastn = async (qs) => {
    const r = await request(t.app).get(`/r4/Observation/$lastn?${qs}`);
    expect(r.status).toBe(200);
    return matches(r);
  };
  const stats = async (qs) => {
    const r = await request(t.app).get(`/r4/Observation/$stats?${qs}`);
    if (r.status !== 200) {
      throw new Error(`$stats failed: ${r.status} ${JSON.stringify(r.body)}`);
    }
    return r.body;
  };
  const statsOf = (p) => (p.parameter || []).filter(x => x.name === 'statistics').map(x => x.resource);
  const component = (o, c, text) => (o.component || []).find(x => x.code.coding[0].code === c && (!text || x.code.text === text));
  const valueOf = (o, c, text) => {
    const x = component(o, c, text);
    return x ? (x.valueQuantity ? x.valueQuantity.value : x.valueInteger) : undefined;
  };

  const ids = {};
  beforeEach(async () => {
    t = await makeApp(engine);
    pat = await post({ resourceType: 'Patient', name: [{ family: 'Smith' }] });
    other = await post({ resourceType: 'Patient', name: [{ family: 'Jones' }] });
    // heart rate, five times, and once entered in error
    ids.hr = [];
    for (const [i, v] of [72, 80, 76, 90, 68].entries()) {
      ids.hr.push(await obs(pat, code('8867-4', 'Heart rate'), `2026-03-0${i + 1}T08:00:00Z`, { valueQuantity: qty(v, '/min') }));
    }
    ids.hrError = await obs(pat, code('8867-4'), '2026-03-09T08:00:00Z', { status: 'entered-in-error', valueQuantity: qty(300, '/min') });
    // weight: in kg and pounds
    ids.wt = [await obs(pat, code('29463-7'), '2026-03-01', { valueQuantity: qty(80, 'kg') }),
      await obs(pat, code('29463-7'), '2026-03-02', { valueQuantity: { value: 176.37, unit: 'lb', system: UCUM, code: '[lb_av]' } })];
    // blood pressure panels
    ids.bp = [];
    for (const [i, [s, d]] of [[120, 80], [130, 85], [125, 82]].entries()) {
      ids.bp.push(await obs(pat, code('85354-9', 'Blood pressure'), `2026-03-0${i + 1}T09:00:00Z`, { component: [
        { code: code('8480-6', 'Systolic'), valueQuantity: qty(s, 'mm[Hg]') },
        { code: code('8462-4', 'Diastolic'), valueQuantity: qty(d, 'mm[Hg]') }] }));
    }
    // a vital signs panel with members
    ids.panel = await obs(pat, code('85353-1', 'Vital signs panel'), '2026-03-05T08:00:00Z',
      { hasMember: ids.hr.slice(3).map(id => ({ reference: `Observation/${id}` })) });
    // a text-only code, a lab result, someone else's, and one with no time
    ids.text = await obs(pat, { text: 'Blood sugar' }, '2026-03-04', { category: [LAB], valueQuantity: qty(5.5, 'mmol/L') });
    ids.other = await obs(other, code('8867-4'), '2026-03-08T08:00:00Z', { valueQuantity: qty(100, '/min') });
    ids.untimed = await post({ resourceType: 'Observation', status: 'final', category: [VITALS], code: code('8867-4'), subject: { reference: `Patient/${pat}` },
      valueQuantity: qty(60, '/min') });
  });
  afterEach(async () => {
    expect(await invariants(t.ep)).toEqual([]);
    await t.close();
  });

  test('$lastn: the most recent in each group of observations with the same code', async () => {
    const one = await lastn(`patient=${pat}&category=vital-signs`);
    const byCode = new Map(one.map(o => [o.code.coding ? o.code.coding[0].code : o.code.text, o.id]));
    // the entered-in-error one is the most recent heart rate: not filtered by status, it counts
    expect(byCode.get('8867-4')).toBe(ids.hrError);
    expect(byCode.get('29463-7')).toBe(ids.wt[1]);
    expect(byCode.get('85354-9')).toBe(ids.bp[2]);
    expect(byCode.get('85353-1')).toBe(ids.panel);
    expect(one.length).toBe(4);
    expect(one.map(o => o.id)).not.toContain(ids.untimed);

    const three = await lastn(`patient=${pat}&category=vital-signs&status=final&max=3`);
    const hr = three.filter(o => o.code.coding && o.code.coding[0].code === '8867-4');
    expect(hr.map(o => o.id)).toEqual([ids.hr[4], ids.hr[3], ids.hr[2]]);
    expect(three.filter(o => o.code.coding && o.code.coding[0].code === '85354-9').length).toBe(3);
    // the groups one after the other
    const codes = three.map(o => o.code.coding[0].code);
    expect(codes.filter((c, i) => i > 0 && c !== codes[i - 1]).length).toBe(new Set(codes).size - 1);
  });

  test('$lastn: filtered by code, text-only codes, _include and _summary=count, and the self link', async () => {
    const hr = await lastn(`subject=Patient/${pat}&code=${LOINC}|8867-4&max=2`);
    expect(hr.map(o => o.id)).toEqual([ids.hrError, ids.hr[4]]);
    expect((await lastn(`patient=${pat}&category=laboratory`)).map(o => o.id)).toEqual([ids.text]);

    const inc = await request(t.app).get(`/r4/Observation/$lastn?patient=${pat}&code=${LOINC}|8867-4&_include=Observation:subject`);
    expect(inc.body.entry.filter(e => e.search.mode === 'include').map(e => e.resource.id)).toEqual([pat]);
    expect(inc.body.link[0].url).toMatch(/\/r4\/Observation\/\$lastn\?.*max=1/);
    const count = await request(t.app).get(`/r4/Observation/$lastn?patient=${pat}&category=vital-signs&max=2&_summary=count`);
    // heart rate 2, weight 2, blood pressure 2, the panel 1
    expect(count.body.total).toBe(7);
  });

  test('$lastn: paged, and kept up to date as observations change', async () => {
    const r = await request(t.app).get(`/r4/Observation/$lastn?patient=${pat}&category=vital-signs&max=5&_count=4`);
    expect(r.status).toBe(200);
    const all = [...matches(r)];
    let next = r.body.link.find(l => l.relation === 'next');
    expect(next).toBeDefined();
    while (next) {
      const p = await request(t.app).get(next.url.substring(next.url.indexOf('/r4')));
      all.push(...matches(p));
      next = p.body.link.find(l => l.relation === 'next');
    }
    // heart rate 5 (of 6), weight 2, blood pressure 3, the panel 1
    expect(all.length).toBe(11);
    expect(new Set(all.map(o => o.id)).size).toBe(11);

    await request(t.app).delete(`/r4/Observation/${ids.hrError}`);
    expect((await lastn(`patient=${pat}&code=${LOINC}|8867-4`)).map(o => o.id)).toEqual([ids.hr[4]]);
    // a new code puts it in another group
    const moved = await request(t.app).get(`/r4/Observation/${ids.hr[4]}`);
    await send('put', `/r4/Observation/${ids.hr[4]}`, { ...moved.body, code: code('8310-5', 'Body temperature'), valueQuantity: qty(37, 'Cel') });
    expect((await lastn(`patient=${pat}&code=${LOINC}|8867-4`)).map(o => o.id)).toEqual([ids.hr[3]]);
    expect((await lastn(`patient=${pat}&code=${LOINC}|8310-5`)).map(o => o.id)).toEqual([ids.hr[4]]);
  });

  test('$lastn: what it needs', async () => {
    expect((await request(t.app).get('/r4/Observation/$lastn?category=vital-signs')).status).toBe(400);
    expect((await request(t.app).get(`/r4/Observation/$lastn?patient=${pat}`)).status).toBe(400);
    expect((await request(t.app).get(`/r4/Observation/$lastn?patient=${pat}&category=vital-signs&max=0`)).status).toBe(400);
    expect((await request(t.app).get(`/r4/Patient/$lastn?patient=${pat}`)).status).toBe(501);
  });

  test('$stats: a code, with the values in their own unit; entered in error left out', async () => {
    const p = await stats(`subject=Patient/${pat}&system=${LOINC}&code=8867-4&statistic=average,count,total-count,median,maximum,minimum,std-dev,regression`);
    const [o] = statsOf(p);
    expect(statsOf(p).length).toBe(1);
    expect(o).toMatchObject({ resourceType: 'Observation', status: 'final', code: { coding: [{ system: LOINC, code: '8867-4' }] }, subject: { reference: `Patient/${pat}` } });
    expect(o.effectivePeriod).toEqual({ start: '2026-03-01T08:00:00.000Z', end: '2026-03-05T08:00:00.000Z' });
    expect(valueOf(o, 'count')).toBe(5);
    expect(valueOf(o, 'total-count')).toBe(5);
    expect(valueOf(o, 'average')).toBe(77.2);
    expect(valueOf(o, 'median')).toBe(76);
    expect(valueOf(o, 'maximum')).toBe(90);
    expect(valueOf(o, 'minimum')).toBe(68);
    expect(component(o, 'average').valueQuantity).toEqual({ value: 77.2, unit: '/min', system: UCUM, code: '/min' });
    expect(component(o, 'average').code.coding[0]).toEqual({ system: STATS, code: 'average', display: 'Average' });
    expect(component(o, 'regression', 'gradient').valueQuantity.code).toBe('(/min)/d');
    expect(valueOf(o, 'regression', 'intercept')).toBeDefined();
    expect(o.component.map(c => c.code.coding[0].code)).toEqual(['average', 'count', 'total-count', 'median', 'maximum', 'minimum', 'std-dev', 'regression', 'regression']);
    // only the subject's
    const theirs = statsOf(await stats(`subject=Patient/${other}&system=${LOINC}&code=8867-4&statistic=average`));
    expect(valueOf(theirs[0], 'average')).toBe(100);
  });

  test('$stats: different units, in the canonical unit; and every statistic', async () => {
    const all = Object.keys(STATISTICS).join(',');
    const [o] = statsOf(await stats(`subject=Patient/${pat}&coding=${LOINC}|29463-7&statistic=${all}`));
    expect(component(o, 'average').valueQuantity.code).toBe('g');
    expect(valueOf(o, 'average')).toBeCloseTo(80000, -1);
    expect(valueOf(o, 'count')).toBe(2);
    expect(component(o, 'variance').valueQuantity.code).toBe('(g).(g)');
    expect(valueOf(o, 'skew')).toBeCloseTo(0);
    expect(component(o, 'skew').valueQuantity.code).toBe('1');
    // pounds and something that can't be compared
    await obs(pat, code('29463-7'), '2026-03-03', { valueQuantity: { value: 12, unit: 'stone', system: 'http://example.org/units', code: 'st' } });
    const [x] = statsOf(await stats(`subject=Patient/${pat}&coding=${LOINC}|29463-7&statistic=average,count,total-count`));
    expect(component(x, 'average')).toBeUndefined();
    expect(valueOf(x, 'count')).toBe(0);
    expect(valueOf(x, 'total-count')).toBe(3);
    expect(x.note[0].text).toMatch(/can't all be compared/);
  });

  test('$stats: a panel - its components, and its members, each their own', async () => {
    const bp = statsOf(await stats(`subject=Patient/${pat}&coding=${LOINC}|85354-9&statistic=average,count`));
    expect(bp.map(o => o.code.coding[0].code).sort()).toEqual(['8462-4', '8480-6']);
    const sys = bp.find(o => o.code.coding[0].code === '8480-6');
    expect(valueOf(sys, 'average')).toBe(125);
    expect(component(sys, 'average').valueQuantity.code).toBe('mm[Hg]');
    // a component's code, asked for directly
    const [dia] = statsOf(await stats(`subject=Patient/${pat}&coding=${LOINC}|8462-4&statistic=maximum`));
    expect(valueOf(dia, 'maximum')).toBe(85);
    // members
    const members = statsOf(await stats(`subject=Patient/${pat}&coding=${LOINC}|85353-1&statistic=average,count`));
    expect(members.length).toBe(1);
    expect(members[0].code.coding[0].code).toBe('8867-4');
    expect(valueOf(members[0], 'count')).toBe(2);
    expect(valueOf(members[0], 'average')).toBe(79);
  });

  test('$stats: a period or a duration, include and limit, POST, and a code with nothing', async () => {
    const p = { resourceType: 'Parameters', parameter: [{ name: 'subject', valueUri: `Patient/${pat}` },
      { name: 'coding', valueCoding: { system: LOINC, code: '8867-4' } }, { name: 'coding', valueCoding: { system: LOINC, code: '0000-0' } },
      { name: 'period', valuePeriod: { start: '2026-03-02', end: '2026-03-04' } },
      { name: 'statistic', valueCode: 'average' }, { name: 'statistic', valueCode: 'count' },
      { name: 'include', valueBoolean: true }, { name: 'limit', valueInteger: 2 }] };
    const r = await send('post', '/r4/Observation/$stats', p);
    expect(r.status).toBe(200);
    const [hr, none] = statsOf(r.body);
    expect(hr.effectivePeriod).toEqual({ start: '2026-03-02', end: '2026-03-04' });
    expect(valueOf(hr, 'count')).toBe(3);
    expect(valueOf(hr, 'average')).toBe(82);
    expect(none.code.coding[0].code).toBe('0000-0');
    expect(valueOf(none, 'count')).toBe(0);
    expect(component(none, 'average')).toBeUndefined();
    const sources = r.body.parameter.filter(x => x.name === 'source').map(x => x.resource.id);
    expect(sources).toEqual([ids.hr[3], ids.hr[2]]);

    const recent = await obs(pat, code('8867-4'), new Date(Date.now() - 3600000).toISOString(), { valueQuantity: qty(64, '/min') });
    const [d] = statsOf(await stats(`subject=Patient/${pat}&coding=${LOINC}|8867-4&duration=2&statistic=count,average&include=true`));
    expect(valueOf(d, 'count')).toBe(1);
    expect(valueOf(d, 'average')).toBe(64);
    expect(recent).toBeDefined();
  });

  test('$stats: what it needs', async () => {
    const bad = async (qs) => (await request(t.app).get(`/r4/Observation/$stats?${qs}`)).status;
    expect(await bad(`coding=${LOINC}|8867-4&statistic=average`)).toBe(400);
    expect(await bad(`subject=Patient/${pat}&statistic=average`)).toBe(400);
    expect(await bad(`subject=Patient/${pat}&coding=${LOINC}|8867-4`)).toBe(400);
    expect(await bad(`subject=Patient/${pat}&coding=${LOINC}|8867-4&statistic=mode`)).toBe(400);
    expect(await bad(`subject=Patient/${pat}&code=8867-4&statistic=average`)).toBe(400);
    expect(await bad(`subject=http://elsewhere.org/fhir/Patient/1&coding=${LOINC}|8867-4&statistic=average`)).toBe(400);
    expect(await bad(`subject=Patient/${pat}&coding=${LOINC}|8867-4&statistic=average&duration=-1`)).toBe(400);
  });

  test('reindexing fills the values in', async () => {
    await t.ep.db.write(async (q) => {
      await q.run('DELETE FROM ObservationCodes');
      await q.run('DELETE FROM ObservationValues');
      await q.run("INSERT INTO Config (Name, Value) VALUES ('reindexAll', '1')");
    });
    expect(await lastn(`patient=${pat}&category=vital-signs`)).toEqual([]);
    t.ep.reindexAll = true;
    while (await t.ep.reindexBatch() > 0) {
      // more
    }
    expect((await lastn(`patient=${pat}&category=vital-signs`)).length).toBe(4);
    const [o] = statsOf(await stats(`subject=Patient/${pat}&coding=${LOINC}|8867-4&statistic=average`));
    expect(valueOf(o, 'average')).toBe(77.2);
  });

  test('in the CapabilityStatement', async () => {
    const r = await request(t.app).get('/r4/metadata');
    const o = r.body.rest[0].resource.find(x => x.type === 'Observation');
    expect(o.operation.map(x => x.name)).toEqual(expect.arrayContaining(['lastn', 'stats']));
    const p = r.body.rest[0].resource.find(x => x.type === 'Patient');
    expect(p.operation.map(x => x.name)).not.toContain('lastn');
  });
});

describe.each(engines())('observations: a version 6 database is brought up to date (%s)', (engine) => {
  test('the tables are made, and what was there is reindexed in the background to fill them', async () => {
    let t = await makeApp(engine);
    const send = (resource) => request(t.app).post(`/r4/${resource.resourceType}`).set('Content-Type', FHIR_JSON).send(body(resource));
    const pat = (await send({ resourceType: 'Patient' })).body.id;
    await send({ resourceType: 'Observation', status: 'final', category: [VITALS], code: code('8867-4'), subject: { reference: `Patient/${pat}` },
      effectiveDateTime: '2026-03-01', valueQuantity: qty(70, '/min') });
    await t.ep.db.write(async (q) => {
      await q.exec('DROP TABLE ObservationValues');
      await q.exec('DROP TABLE ObservationCodes');
      // (and what version 8 added)
      await q.exec('DROP TABLE AsyncJobs');
      await q.exec('DROP TABLE JobFiles');
      await q.run('UPDATE Config SET Value = ? WHERE Name = ?', ['6', 'schemaVersion']);
    });
    await t.stop();
    t = await makeApp(engine, { dir: t.dir, keep: true });
    try {
      expect(t.ep.reindexAll).toBe(true);
      while (await t.ep.reindexBatch() > 0) {
        // more
      }
      const r = await request(t.app).get(`/r4/Observation/$lastn?patient=${pat}&category=vital-signs`);
      expect(r.body.entry.filter(e => e.search.mode === 'match').length).toBe(1);
      expect(await invariants(t.ep)).toEqual([]);
    } finally {
      await t.close();
    }
  });
});
