//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// Async requests (rest/queue/async.js): Prefer: respond-async, the status URL, the result as a
// batch-response, cancelling, and the queue runner that runs them.

const request = require('supertest');
const { engines, makeApp, FHIR_JSON } = require('./helpers');
const { DatabaseJobFiles, PIECE } = require('../../rest/queue/files');

const PAT = (family) => ({ resourceType: 'Patient', name: [{ family }] });

describe.each(engines())('async requests (%s)', (engine) => {
  let t;
  beforeEach(async () => {
    t = await makeApp(engine);
    // the tests run the queue themselves
    await t.ep.runner.stop();
  });
  afterEach(async () => {
    await t.close();
  });

  const create = (r) => request(t.app).post(`/r4/${r.resourceType}`).set('Content-Type', FHIR_JSON).send(JSON.stringify(r));
  const kickoff = (req) => req.set('Prefer', 'respond-async');
  const path = (res) => res.headers['content-location'].replace('http://test.example', '');
  const run = () => t.ep.runner.runNow('async requests');

  test('a search: 202 with where to look; queued; then the result, as a batch-response', async () => {
    await create(PAT('Chalmers'));
    await create(PAT('Smith'));
    const k = await kickoff(request(t.app).get('/r4/Patient?family=Chalmers').set('Accept', FHIR_JSON));
    expect(k.status).toBe(202);
    expect(k.headers['content-location']).toMatch(/^http:\/\/test\.example\/r4\/_async\/[0-9a-f-]{36}$/);
    expect(k.body.resourceType).toBe('OperationOutcome');
    const before = await request(t.app).get(path(k));
    expect(before.status).toBe(202);
    expect(before.headers['x-progress']).toBe('queued');
    expect(before.headers['retry-after']).toBeDefined();
    await run();
    const done = await request(t.app).get(path(k));
    expect(done.status).toBe(200);
    expect(done.body.resourceType).toBe('Bundle');
    expect(done.body.type).toBe('batch-response');
    expect(done.body.entry[0].response.status).toBe('200 OK');
    const set = done.body.entry[0].resource;
    expect(set.type).toBe('searchset');
    expect(set.entry.map(e => e.resource.name[0].family)).toEqual(['Chalmers']);
    // _summary applies, as it would have done
    const c = await kickoff(request(t.app).get('/r4/Patient?_summary=count'));
    await run();
    expect((await request(t.app).get(path(c))).body.entry[0].resource.total).toBe(2);
  });

  test('the result is in the format the kickoff asked for; _async=true asks too', async () => {
    await create(PAT('Chalmers'));
    const k = await request(t.app).get('/r4/Patient?_async=true').set('Accept', 'application/fhir+xml');
    expect(k.status).toBe(202);
    await run();
    const done = await request(t.app).get(path(k));
    expect(done.status).toBe(200);
    expect(done.headers['content-type']).toMatch(/fhir\+xml/);
    expect(done.text).toContain('<Bundle xmlns="http://hl7.org/fhir">');
    expect(done.text).toContain('<family value="Chalmers"/>');
  });

  test('a transaction: written when it runs; a failure is the entry\'s response, in a 200', async () => {
    const tx = { resourceType: 'Bundle', type: 'transaction', entry: [{ resource: PAT('Async'), request: { method: 'POST', url: 'Patient' } }] };
    const k = await kickoff(request(t.app).post('/r4').set('Content-Type', FHIR_JSON)).send(JSON.stringify(tx));
    expect(k.status).toBe(202);
    expect((await request(t.app).get('/r4/Patient?family=Async')).body.total).toBe(0);
    await run();
    const done = await request(t.app).get(path(k));
    expect(done.body.entry[0].resource.type).toBe('transaction-response');
    expect((await request(t.app).get('/r4/Patient?family=Async')).body.total).toBe(1);
    const bad = { resourceType: 'Bundle', type: 'transaction', entry: [{ resource: PAT('X'), request: { method: 'PUT', url: 'Patient/no/such/thing' } }] };
    const k2 = await kickoff(request(t.app).post('/r4').set('Content-Type', FHIR_JSON)).send(JSON.stringify(bad));
    await run();
    const failed = await request(t.app).get(path(k2));
    expect(failed.status).toBe(200);
    expect(failed.body.entry[0].response.status).toMatch(/^4/);
    expect(failed.body.entry[0].response.outcome.resourceType).toBe('OperationOutcome');
  });

  test('only searches, history, batches, transactions and operations; and only with the setting', async () => {
    const c = await create(PAT('Chalmers'));
    const read = await kickoff(request(t.app).get(`/r4/Patient/${c.body.id}`));
    expect(read.status).toBe(400);
    expect(read.body.issue[0].details.text).toMatch(/can't be done asynchronously/);
    const hist = await kickoff(request(t.app).get(`/r4/Patient/${c.body.id}/_history`));
    expect(hist.status).toBe(202);
    const bulk = await kickoff(request(t.app).get('/r4/Patient?_outputFormat=application/fhir%2Bndjson'));
    expect(bulk.status).toBe(501);
  });

  test('someone else\'s job is not there for them; an unknown one is 404', async () => {
    const k = await kickoff(request(t.app).get('/r4/Patient'));
    const other = await makeApp(engine, { dir: t.dir, keep: true, master: false, jobs: false, principal: async () => ({ id: 99, login: 'other', has: () => true }) });
    try {
      expect((await request(other.app).get(path(k))).status).toBe(404);
      expect((await request(other.app).delete(path(k))).status).toBe(404);
    } finally {
      await other.stop();
    }
    expect((await request(t.app).get('/r4/_async/00000000-0000-0000-0000-000000000000')).status).toBe(404);
    expect((await request(t.app).get('/r4/_async/nonsense')).status).toBe(404);
  });

  test('cancelled while queued: it never runs, and is gone', async () => {
    const tx = { resourceType: 'Bundle', type: 'transaction', entry: [{ resource: PAT('Never'), request: { method: 'POST', url: 'Patient' } }] };
    const k = await kickoff(request(t.app).post('/r4').set('Content-Type', FHIR_JSON)).send(JSON.stringify(tx));
    const d = await request(t.app).delete(path(k));
    expect(d.status).toBe(202);
    await run();
    expect((await request(t.app).get(path(k))).status).toBe(404);
    expect((await request(t.app).get('/r4/Patient?family=Never')).body.total).toBe(0);
  });

  test('cancelled while running: a transaction stops at its next entry, and rolls back', async () => {
    const tx = { resourceType: 'Bundle', type: 'transaction', entry: [{ resource: PAT('Stopped'), request: { method: 'POST', url: 'Patient' } }] };
    const k = await kickoff(request(t.app).post('/r4').set('Content-Type', FHIR_JSON)).send(JSON.stringify(tx));
    // the DELETE comes as the job starts
    const dispatch = t.ep.dispatch.bind(t.ep);
    t.ep.dispatch = async (freq, ctx) => {
      if (freq.interaction === 'bundle') {
        expect((await request(t.app).delete(path(k))).status).toBe(202);
      }
      return dispatch(freq, ctx);
    };
    await run();
    t.ep.dispatch = dispatch;
    expect((await request(t.app).get(path(k))).status).toBe(404);
    expect((await request(t.app).get('/r4/Patient?family=Stopped')).body.total).toBe(0);
  });

  test('at most asyncMaxPerUser queued or running at once', async () => {
    await t.ep.db.write(q => q.run("INSERT INTO Config (Name, Value) VALUES ('asyncMaxPerUser', '1')"));
    await t.ep.db.write(q => require('../../rest/endpoint/settings').bumpGeneration(q));
    t.ep.lastGenerationCheck = 0;
    expect((await kickoff(request(t.app).get('/r4/Patient'))).status).toBe(202);
    const second = await kickoff(request(t.app).get('/r4/Patient'));
    expect(second.status).toBe(429);
    expect(second.headers['retry-after']).toBeDefined();
    await run();
    expect((await kickoff(request(t.app).get('/r4/Patient'))).status).toBe(202);
  });

  test('a job whose runner stopped is failed, not run again; expired jobs are removed', async () => {
    const k = await kickoff(request(t.app).get('/r4/Patient'));
    const id = path(k).split('/').pop();
    await t.ep.db.write(q => q.run("UPDATE AsyncJobs SET State = 'running', Runner = 'gone:1:1', Heartbeat = ? WHERE Id = ?", [Date.now() - 5 * 60 * 1000, id]));
    expect((await t.ep.asyncJobs.tidy()).failed).toBe(1);
    const r = await request(t.app).get(path(k));
    expect(r.status).toBe(500);
    expect(r.body.issue[0].details.text).toMatch(/stopped before it finished/);
    await t.ep.db.write(q => q.run('UPDATE AsyncJobs SET Expires = 1 WHERE Id = ?', [id]));
    expect((await t.ep.asyncJobs.tidy()).removed).toBe(1);
    expect((await request(t.app).get(path(k))).status).toBe(404);
    expect(Number((await t.ep.db.read(q => q.get('SELECT COUNT(*) AS N FROM JobFiles'))).N)).toBe(0);
  });

  test('the queue as the status page sees it: waiting, then how long it waited to be started, and took', async () => {
    const queueStatus = require('../../rest/queue/status');
    await kickoff(request(t.app).get('/r4/Patient'));
    await kickoff(request(t.app).get('/r4/Patient'));
    // (queued a while ago)
    await t.ep.db.write(q => q.run('UPDATE AsyncJobs SET Created = Created - 3000'));
    const waiting = await queueStatus.measure(t.ep);
    expect(waiting.async.queued).toBe(2);
    expect(waiting.async.oldestWaitingMs).toBeGreaterThanOrEqual(3000);
    expect(waiting.async.waited).toBeNull();
    await run();
    await run();
    const after = await queueStatus.measure(t.ep);
    expect(after.async.queued).toBe(0);
    expect(after.async.oldestWaitingMs).toBeNull();
    expect(after.async.waited.count).toBe(2);
    expect(after.async.waited.max).toBeGreaterThanOrEqual(3000);
    expect(after.async.took.count).toBe(2);
    expect(queueStatus.summarise([5, 1, 3, 100])).toEqual({ count: 4, avg: 27, p95: 100, max: 100 });
  });

  test('a job runs as its user, looked up again: one no longer there fails', async () => {
    const k = await kickoff(request(t.app).get('/r4/Patient'));
    const id = path(k).split('/').pop();
    await t.ep.db.write(q => q.run("UPDATE AsyncJobs SET UserKey = '42' WHERE Id = ?", [id]));
    // (the user is now 42, whom principalById doesn't know; and only 42 may see it)
    await run();
    const row = await t.ep.db.read(q => q.get('SELECT State, Message FROM AsyncJobs WHERE Id = ?', [id]));
    expect(row.State).toBe('failed');
    expect(row.Message).toMatch(/no longer known/);
  });

  test('one process queues it, the jobs process runs it, and the first gives the result', async () => {
    await create(PAT('Chalmers'));
    const api = await makeApp(engine, { dir: t.dir, keep: true, master: false, jobs: false });
    const jobs = await makeApp(engine, { dir: t.dir, keep: true, master: false, jobs: true });
    try {
      await jobs.ep.runner.stop();
      expect(api.ep.runner).toBeNull();
      const k = await kickoff(request(api.app).get('/r4/Patient'));
      expect(k.status).toBe(202);
      await jobs.ep.runner.runNow('async requests');
      const done = await request(api.app).get(path(k));
      expect(done.status).toBe(200);
      expect(done.body.entry[0].resource.total).toBe(1);
    } finally {
      await api.stop();
      await jobs.stop();
    }
  });

  test('job files go in pieces, and come back whole', async () => {
    const files = new DatabaseJobFiles(t.ep.db);
    const big = Buffer.alloc(PIECE * 2 + 17, 7);
    big[PIECE] = 1;
    await files.put(5, 'result', big);
    expect(Number((await t.ep.db.read(q => q.get('SELECT COUNT(*) AS N FROM JobFiles WHERE JobKey = 5'))).N)).toBe(3);
    expect((await files.get(5, 'result')).equals(big)).toBe(true);
    await files.put(5, 'result', 'small');
    expect((await files.get(5, 'result')).toString()).toBe('small');
    await files.put(5, 'empty', '');
    expect((await files.get(5, 'empty')).length).toBe(0);
    await files.remove(5);
    expect(await files.get(5, 'result')).toBeNull();
  });
});
