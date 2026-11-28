//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// The tester's engine (tester/engine.js), against a small server that does what each test
// needs it to: what isn't in the CapabilityStatement isn't run; optional features refused
// aren't supported, done must be right, and ignored are a warning; setup is marked.

const http = require('http');
const express = require('express');
const { TestRun } = require('../../tester/engine');

const PATIENT_SEARCH = ['_tag', 'family', 'gender'];

/** A server with Patient create and search, whose answer to a search is given by the test */
async function server(answer) {
  const app = express();
  app.use(express.json({ type: () => true }));
  const store = [];
  app.get('/fhir/metadata', (req, res) => res.json({
    resourceType: 'CapabilityStatement', status: 'active', kind: 'instance', fhirVersion: '4.0.1', format: ['json'],
    rest: [{ mode: 'server', resource: [{ type: 'Patient', interaction: [{ code: 'create' }, { code: 'search-type' }, { code: 'read' }, { code: 'delete' }],
      searchParam: PATIENT_SEARCH.map(name => ({ name, type: 'token' })) }] }]
  }));
  app.post('/fhir/Patient', (req, res) => {
    const p = { ...req.body, id: String(store.length + 1), meta: { ...(req.body.meta || {}), versionId: '1', lastUpdated: new Date().toISOString() } };
    store.push(p);
    res.status(201).set('Location', `/fhir/Patient/${p.id}/_history/1`).json(p);
  });
  app.get('/fhir/Patient/:id', (req, res) => {
    const p = store.find(x => x.id === req.params.id);
    return p ? res.json(p) : res.status(404).json({ resourceType: 'OperationOutcome', issue: [] });
  });
  app.delete('/fhir/Patient/:id', (req, res) => res.status(204).end());
  app.get('/fhir/Patient', (req, res) => {
    const tag = String(req.query._tag || '').split('|')[1];
    const mine = store.filter(p => (p.meta.tag || []).some(t => t.code === tag));
    const out = answer(req.query, mine, store);
    if (typeof out === 'number') {
      return res.status(out).json({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'not-supported', diagnostics: 'not supported' }] });
    }
    return res.json({ resourceType: 'Bundle', type: 'searchset', entry: out.map(p => ({ fullUrl: `http://x/fhir/Patient/${p.id}`, resource: p, search: { mode: 'match' } })) });
  });
  const s = http.createServer(app);
  await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${s.address().port}/fhir`, close: () => new Promise(resolve => s.close(resolve)) };
}

/** Run one made-up test against the server */
async function runOne(answer, test) {
  const srv = await server(answer);
  try {
    const run = new TestRun({ base: srv.base, allowPrivate: true, groups: [{ name: 'G', tests: [{ name: 'T', ...test }] }] });
    const out = await run.run();
    return { out, result: out.results[0] };
  } finally {
    await srv.close();
  }
}

const OPTIONAL = {
  requires: { interactions: [['Patient', 'create'], ['Patient', 'search-type']], scope: ['Patient'] },
  run: async (ctx) => {
    const a = await ctx.create(ctx.resource('Patient', { gender: 'female' }));
    await ctx.create(ctx.resource('Patient', { gender: 'male' }));
    await ctx.optional('Patient', [['gender:not', 'male']], [a.id], { feature: 'gender:not' });
  }
};

describe('optional features', () => {
  test('refused (4xx): the test isn\'t run, and says so', async () => {
    const { result } = await runOne((q, mine) => (q['gender:not'] ? 400 : mine), OPTIONAL);
    expect(result.outcome).toBe('skip');
    expect(result.message).toMatch(/doesn't support it: gender:not \(400: not supported\)/);
  });

  test('done right: a pass', async () => {
    const { result } = await runOne((q, mine) => (q['gender:not'] ? mine.filter(p => p.gender !== 'male') : mine), OPTIONAL);
    expect(result.outcome).toBe('pass');
  });

  test('done wrong: a fail', async () => {
    const { result } = await runOne((q, mine) => (q['gender:not'] ? mine.filter(p => p.gender === 'male') : mine), OPTIONAL);
    expect(result.outcome).toBe('fail');
    expect(result.message).toMatch(/gender:not=male found 2, not 1/);
  });

  test('ignored (everything the test made): a warning', async () => {
    const { result } = await runOne((q, mine) => mine, OPTIONAL);
    expect(result.outcome).toBe('warning');
    expect(result.message).toMatch(/as if the server ignored it/);
  });
});

describe('what runs', () => {
  test('what the CapabilityStatement doesn\'t list isn\'t run, and says why', async () => {
    const { result } = await runOne((q, mine) => mine, { requires: { interactions: [['Patient', 'update']] }, run: async () => {} });
    expect(result.outcome).toBe('skip');
    expect(result.message).toBe('The CapabilityStatement doesn\'t list update for Patient');
    const { result: r2 } = await runOne((q, mine) => mine, { requires: { search: [['Patient', 'birthdate']] }, run: async () => {} });
    expect(r2.message).toBe('The CapabilityStatement doesn\'t list the birthdate search parameter for Patient');
  });

  test('setup is marked, the test\'s resources are kept, and what was made is cleaned up', async () => {
    const { out, result } = await runOne((q, mine) => mine, {
      requires: { interactions: [['Patient', 'create']] },
      run: async (ctx) => {
        const p = await ctx.create(ctx.resource('Patient', { gender: 'other' }));
        ctx.status(await ctx.client.get(`Patient/${p.id}`), 200, 'read');
      }
    });
    expect(result.outcome).toBe('pass');
    expect(result.exchanges.map(x => `${x.phase} ${x.request.method} ${x.response.status}`)).toEqual(['setup POST 201', 'test GET 200']);
    expect(result.resources).toEqual([{ type: 'Patient', id: '1', resource: expect.objectContaining({ resourceType: 'Patient', gender: 'other' }) }]);
    expect(out.cleanup).toEqual({ created: 1, deleted: 1, expunged: 0, left: [] });
  });

  test('a server that isn\'t R4 or R5 isn\'t tested', async () => {
    const app = express();
    app.get('/fhir/metadata', (req, res) => res.json({ resourceType: 'CapabilityStatement', fhirVersion: '3.0.2', format: ['json'], rest: [{ mode: 'server' }] }));
    const s = http.createServer(app);
    await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
    try {
      const out = await new TestRun({ base: `http://127.0.0.1:${s.address().port}/fhir`, allowPrivate: true }).run();
      expect(out.outcome).toBe('error');
      expect(out.message).toBe('The server is FHIR 3.0.2: only R4 and R5 servers are tested');
    } finally {
      await new Promise(resolve => s.close(resolve));
    }
  });
});
