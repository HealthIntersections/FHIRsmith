//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * Transactions against a model: random transactions of Patients and Observations (creates,
 * conditional creates, updates, conditional updates, deletes, patches, reads, references to
 * resources in and outside the Bundle, valid and not), each predicted by a small model of the
 * specification's rules before it is sent.
 *
 *  - the model says it fails: it must, and every table must be as it was
 *  - the model says it succeeds: it must, and every resource must then be what the model says
 *    (its version, whether it is deleted, its name, what refers to it)
 *
 * The random sequence comes from a seed (FHIRSMITH_FUZZ_SEED, else a new one each run, printed
 * when a round fails); FHIRSMITH_FUZZ_ROUNDS sets how many transactions (default 120).
 */

const request = require('supertest');
const { engines, makeApp, body, snapshot, invariants, FHIR_JSON } = require('./helpers');

const ROUNDS = Number(process.env.FHIRSMITH_FUZZ_ROUNDS || 120);

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

describe.each(engines())('transactions against a model (%s)', (engine) => {
  let t;
  beforeAll(async () => {
    t = await makeApp(engine);
  });
  afterAll(async () => {
    await t.close();
  });

  test(`${ROUNDS} random transactions`, async () => {
    const seed = Number(process.env.FHIRSMITH_FUZZ_SEED || Math.floor(Math.random() * 2 ** 31));
    const rnd = prng(seed);
    const pick = (list) => list[Math.floor(rnd() * list.length)];
    const chance = (p) => rnd() < p;
    let n = 0;
    const fresh = (p) => `${p}${seed.toString(36)}x${(++n).toString(36)}`;

    // the model: id -> { deleted, version, family, ident }, and observations id -> { deleted, version, subject }
    const patients = new Map();
    const observations = new Map();
    const live = (m) => [...m.entries()].filter(([, v]) => !v.deleted).map(([k]) => k);

    const send = (entry) => request(t.app).post('/r4').set('Content-Type', FHIR_JSON).send(body({ resourceType: 'Bundle', type: 'transaction', entry }));

    // a few patients to start with
    for (let i = 0; i < 5; i++) {
      const ident = fresh('id');
      const family = fresh('f');
      const r = await request(t.app).post('/r4/Patient').set('Content-Type', FHIR_JSON)
        .send(body({ resourceType: 'Patient', identifier: [{ system: 'urn:fz', value: ident }], name: [{ family }] }));
      patients.set(r.body.id, { deleted: false, version: 1, family, ident });
    }

    let succeeded = 0;
    let failed = 0;
    for (let round = 0; round < ROUNDS; round++) {
      // ---- make a transaction, and say what should happen ----
      const entries = [];
      const plans = [];
      const count = 1 + Math.floor(rnd() * 6);
      for (let i = 0; i < count; i++) {
        const kind = pick(['post-patient', 'post-patient', 'post-patient-ine', 'post-obs', 'post-obs', 'put-patient', 'put-new',
          'put-cond', 'delete', 'delete-missing', 'patch', 'get', 'delete-obs']);
        const existing = [...patients.keys()];
        const alive = live(patients);
        switch (kind) {
          case 'post-patient': {
            const ident = fresh('id');
            const family = fresh('f');
            const fu = `urn:uuid:${fresh('u')}`;
            entries.push({ fullUrl: fu, resource: { resourceType: 'Patient', identifier: [{ system: 'urn:fz', value: ident }], name: [{ family }] }, request: { method: 'POST', url: 'Patient' } });
            plans.push({ kind, fu, ident, family });
            break;
          }
          case 'post-patient-ine': {
            // the identifier of a patient that exists (live or deleted), or a new one
            const p = existing.length && chance(0.7) ? patients.get(pick(existing)) : null;
            const ident = p ? p.ident : fresh('id');
            const family = fresh('f');
            const fu = `urn:uuid:${fresh('u')}`;
            entries.push({ fullUrl: fu, resource: { resourceType: 'Patient', identifier: [{ system: 'urn:fz', value: ident }], name: [{ family }] },
              request: { method: 'POST', url: 'Patient', ifNoneExist: `identifier=urn:fz|${ident}` } });
            plans.push({ kind, fu, ident, family });
            break;
          }
          case 'post-obs': {
            // the subject: a patient in this Bundle, one that exists, one that is deleted, or nobody
            const inBundle = plans.filter(p => p.fu);
            let subject;
            const r = rnd();
            if (inBundle.length && r < 0.4) {
              subject = { urn: pick(inBundle).fu };
            } else if (existing.length && r < 0.9) {
              subject = { id: pick(existing) };
            } else {
              subject = { id: fresh('nobody') };
            }
            const ref = subject.urn || `Patient/${subject.id}`;
            entries.push({ resource: { resourceType: 'Observation', status: 'final', code: { text: 'fz' }, subject: { reference: ref } }, request: { method: 'POST', url: 'Observation' } });
            plans.push({ kind, subject });
            break;
          }
          case 'put-patient': {
            if (!existing.length) {
              continue;
            }
            const id = pick(existing);
            const family = fresh('f');
            const fu = chance(0.3) ? `urn:uuid:${fresh('u')}` : undefined;
            entries.push({ ...(fu ? { fullUrl: fu } : {}), resource: { resourceType: 'Patient', id, identifier: [{ system: 'urn:fz', value: patients.get(id).ident }], name: [{ family }] },
              request: { method: 'PUT', url: `Patient/${id}` } });
            plans.push({ kind, id, family, fu });
            break;
          }
          case 'put-new': {
            const id = fresh('new');
            const ident = fresh('id');
            const family = fresh('f');
            entries.push({ resource: { resourceType: 'Patient', id, identifier: [{ system: 'urn:fz', value: ident }], name: [{ family }] }, request: { method: 'PUT', url: `Patient/${id}` } });
            plans.push({ kind, id, ident, family });
            break;
          }
          case 'put-cond': {
            const p = existing.length && chance(0.7) ? pick(existing) : null;
            const ident = p ? patients.get(p).ident : fresh('id');
            const family = fresh('f');
            entries.push({ resource: { resourceType: 'Patient', identifier: [{ system: 'urn:fz', value: ident }], name: [{ family }] },
              request: { method: 'PUT', url: `Patient?identifier=urn:fz|${ident}` } });
            plans.push({ kind, ident, family });
            break;
          }
          case 'delete': {
            if (!existing.length) {
              continue;
            }
            const id = pick(existing);
            entries.push({ request: { method: 'DELETE', url: `Patient/${id}` } });
            plans.push({ kind, id });
            break;
          }
          case 'delete-missing': {
            const id = fresh('gone');
            entries.push({ request: { method: 'DELETE', url: `Patient/${id}` } });
            plans.push({ kind: 'delete', id });
            break;
          }
          case 'delete-obs': {
            const obs = live(observations);
            if (!obs.length) {
              continue;
            }
            const id = pick(obs);
            entries.push({ request: { method: 'DELETE', url: `Observation/${id}` } });
            plans.push({ kind, id });
            break;
          }
          case 'patch': {
            if (!existing.length) {
              continue;
            }
            const id = pick(existing);
            const family = fresh('f');
            entries.push({ resource: { resourceType: 'Binary', contentType: 'application/json-patch+json',
              data: Buffer.from(JSON.stringify([{ op: 'replace', path: '/name/0/family', value: family }])).toString('base64') }, request: { method: 'PATCH', url: `Patient/${id}` } });
            plans.push({ kind, id, family });
            break;
          }
          case 'get': {
            const id = existing.length && chance(0.8) ? pick(existing) : fresh('nobody');
            entries.push({ request: { method: 'GET', url: `Patient/${id}` } });
            plans.push({ kind, id });
            break;
          }
        }
        void alive;
      }

      // ---- the model ----
      let why = null;
      const fail = (w) => {
        why = why || w;
      };
      const changed = new Map();
      const change = (ident, i) => {
        if (changed.has(ident)) {
          fail(`entries ${changed.get(ident)} and ${i} both change ${ident}`);
        }
        changed.set(ident, i);
      };
      const ineSeen = new Set();
      // what each entry resolves to, from the state before the transaction
      const byIdent = (ident) => [...patients.entries()].filter(([, p]) => !p.deleted && p.ident === ident).map(([k]) => k);
      plans.forEach((p, i) => {
        if (p.kind === 'post-patient-ine') {
          if (ineSeen.has(p.ident)) {
            fail('two conditional creates with the same criteria');
          }
          ineSeen.add(p.ident);
          const m = byIdent(p.ident);
          if (m.length > 1) {
            fail('the conditional create matches more than one');
          }
          p.resolved = m.length === 1 ? m[0] : null;
          if (!p.resolved) {
            p.creates = true;
          }
        } else if (p.kind === 'post-patient') {
          p.creates = true;
        } else if (p.kind === 'put-patient' || p.kind === 'patch' || p.kind === 'delete') {
          change(`Patient/${p.id}`, i);
        } else if (p.kind === 'put-new') {
          change(`Patient/${p.id}`, i);
        } else if (p.kind === 'put-cond') {
          const m = byIdent(p.ident);
          if (m.length > 1) {
            fail('the conditional update matches more than one');
          }
          p.resolved = m.length === 1 ? m[0] : null;
          if (p.resolved) {
            change(`Patient/${p.resolved}`, i);
          }
        } else if (p.kind === 'delete-obs') {
          change(`Observation/${p.id}`, i);
        }
      });
      // the state afterwards: deletes, then creates, then updates and patches
      const after = new Map([...patients].map(([k, v]) => [k, { ...v }]));
      for (const p of plans) {
        if (p.kind === 'delete' && after.has(p.id)) {
          after.get(p.id).deleted = true;
        }
      }
      for (const p of plans) {
        if (p.kind === 'patch') {
          const x = patients.get(p.id);
          if (!x || x.deleted || after.get(p.id).deleted) {
            fail(`patch of ${p.id}, which is ${x ? 'deleted' : 'not there'}`);
          }
        }
        if (p.kind === 'get') {
          // reads run last
          const deletedNow = plans.some(q => q.kind === 'delete' && q.id === p.id);
          const createdNow = plans.some(q => (q.kind === 'put-new' || q.kind === 'put-patient') && q.id === p.id);
          const x = patients.get(p.id);
          if (!createdNow && (!x || x.deleted || deletedNow)) {
            fail(`read of ${p.id}, which is ${x ? 'deleted' : 'not there'}`);
          }
        }
      }
      // a reference must be to a patient that exists, and isn't deleted, once everything is written
      const aliveAfter = (id) => {
        const x = after.get(id);
        if (plans.some(p => (p.kind === 'put-patient' || p.kind === 'put-new') && p.id === id)) {
          return true;
        }
        return !!x && !x.deleted;
      };
      for (const p of plans) {
        if (p.kind !== 'post-obs') {
          continue;
        }
        if (p.subject.urn) {
          const target = plans.find(q => q.fu === p.subject.urn);
          if (target.kind === 'post-patient-ine' && target.resolved && !aliveAfter(target.resolved)) {
            fail('reference to a conditional create\'s match, which is deleted');
          }
          if (target.kind === 'put-patient' && !aliveAfter(target.id)) {
            fail('reference to a deleted patient');
          }
        } else if (!aliveAfter(p.subject.id)) {
          fail(`reference to ${p.subject.id}, which won't exist`);
        }
      }

      // ---- send it ----
      const before = await snapshot(t.ep);
      const r = await send(entries);
      const context = `seed ${seed}, round ${round}: ${JSON.stringify(plans.map(p => ({ ...p })))}`;
      if (why) {
        if (r.status < 400 || r.status >= 500) {
          throw new Error(`expected a failure (${why}), got ${r.status} ${JSON.stringify(r.body).substring(0, 500)}; ${context}`);
        }
        const nowSnap = await snapshot(t.ep);
        if (JSON.stringify(nowSnap) !== JSON.stringify(before)) {
          throw new Error(`a failed transaction changed the database: ${JSON.stringify(before)} -> ${JSON.stringify(nowSnap)}; ${context}`);
        }
        failed++;
      } else {
        if (r.status !== 200) {
          throw new Error(`expected success, got ${r.status} ${JSON.stringify(r.body).substring(0, 500)}; ${context}`);
        }
        succeeded++;
        // apply to the model, binding the server's ids
        for (const p of plans) {
          if (p.kind === 'delete' && patients.has(p.id) && !patients.get(p.id).deleted) {
            const x = patients.get(p.id);
            x.deleted = true;
            x.version++;
          }
          if (p.kind === 'delete-obs') {
            const o = observations.get(p.id);
            o.deleted = true;
            o.version++;
          }
        }
        plans.forEach((p, i) => {
          const res = r.body.entry[i].response;
          const id = res.location ? res.location.split('/')[1] : null;
          if (p.kind === 'post-patient' || (p.kind === 'post-patient-ine' && !p.resolved)) {
            patients.set(id, { deleted: false, version: 1, family: p.family, ident: p.ident });
            p.boundId = id;
          } else if (p.kind === 'post-patient-ine') {
            if (res.status !== '200 OK' || id !== p.resolved) {
              throw new Error(`conditional create should have found ${p.resolved}: ${JSON.stringify(res)}; ${context}`);
            }
            p.boundId = p.resolved;
          } else if (p.kind === 'put-patient' || p.kind === 'put-new' || p.kind === 'patch') {
            const x = patients.get(p.id);
            if (!x) {
              patients.set(p.id, { deleted: false, version: 1, family: p.family, ident: p.ident });
            } else {
              x.version++;
              x.deleted = false;
              x.family = p.family;
            }
          } else if (p.kind === 'put-cond') {
            if (p.resolved) {
              const x = patients.get(p.resolved);
              x.version++;
              x.family = p.family;
              if (id !== p.resolved) {
                throw new Error(`conditional update should have updated ${p.resolved}, went to ${id}; ${context}`);
              }
            } else {
              patients.set(id, { deleted: false, version: 1, family: p.family, ident: p.ident });
            }
          }
        });
        plans.forEach((p, i) => {
          if (p.kind === 'post-obs') {
            const id = r.body.entry[i].response.location.split('/')[1];
            const subject = p.subject.urn ? plans.find(q => q.fu === p.subject.urn) : null;
            const sid = subject ? (subject.boundId || subject.id) : p.subject.id;
            observations.set(id, { deleted: false, version: 1, subject: sid });
          }
        });
      }

      // ---- the database is what the model says ----
      if (round % 10 === 9 || round === ROUNDS - 1) {
        for (const [id, p] of patients) {
          const g = await request(t.app).get(`/r4/Patient/${id}`);
          const expect = p.deleted ? 410 : 200;
          if (g.status !== expect) {
            throw new Error(`Patient/${id}: ${g.status}, the model says ${expect}; seed ${seed}, round ${round}`);
          }
          if (!p.deleted && (g.body.meta.versionId !== String(p.version) || g.body.name[0].family !== p.family)) {
            throw new Error(`Patient/${id}: version ${g.body.meta.versionId} ${g.body.name[0].family}, the model says ${p.version} ${p.family}; seed ${seed}, round ${round}`);
          }
          const h = await request(t.app).get(`/r4/Patient/${id}/_history?_count=500`);
          if (h.body.total !== p.version) {
            throw new Error(`Patient/${id}: ${h.body.total} versions, the model says ${p.version}; seed ${seed}, round ${round}`);
          }
          const refs = [...observations.values()].filter(o => !o.deleted && o.subject === id).length;
          const s = await request(t.app).get(`/r4/Observation?subject=Patient/${id}&_summary=count`);
          if (s.body.total !== refs) {
            throw new Error(`Observation?subject=Patient/${id}: ${s.body.total}, the model says ${refs}; seed ${seed}, round ${round}`);
          }
        }
        const problems = await invariants(t.ep);
        if (problems.length) {
          throw new Error(`${problems.join('; ')}; seed ${seed}, round ${round}`);
        }
      }
    }
    // both kinds were exercised
    expect(succeeded).toBeGreaterThan(ROUNDS / 5);
    expect(failed).toBeGreaterThan(ROUNDS / 10);
  }, 30 * 60 * 1000);
});
