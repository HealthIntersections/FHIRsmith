//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// history: of a resource, of a type

const { patient, ifMatch, uniqueWord, before } = require('./common');

module.exports = {
  name: 'History',
  tests: [
    {
      name: 'The history of a resource: every version, newest first',
      requires: { interactions: [['Patient', 'create'], ['Patient', 'update'], ['Patient', 'history-instance']] },
      run: async (ctx) => {
        const made = await ctx.create(patient(ctx));
        const res1 = ctx.status(await ctx.client.put(`Patient/${made.id}`, { ...made.resource, name: [{ family: uniqueWord() }] },
          { headers: ifMatch(ctx, 'Patient', made.version) }), 200, 'update');
        const v2 = res1.resource && res1.resource.meta ? res1.resource.meta.versionId : null;
        const res = ctx.status(await ctx.client.get(`Patient/${made.id}/_history`), 200, `GET [base]/Patient/${made.id}/_history`);
        const bundle = ctx.body(res, 'Bundle', 'history');
        ctx.must(bundle.type === 'history', `The history is a ${bundle.type} Bundle, not a history`);
        const entries = (bundle.entry || []).filter(e => e.resource && e.resource.id === made.id);
        ctx.must(entries.length === 2, `The history has ${entries.length} versions of the Patient, not 2`);
        ctx.must(entries.every(e => e.request && e.request.method), 'History entries have no request (method and url)');
        ctx.should(entries.every(e => e.response && e.response.status), 'History entries have no response (status)');
        ctx.must(entries.every(e => e.fullUrl), 'History entries have no fullUrl');
        if (v2 && made.version) {
          ctx.should(entries[0].resource.meta.versionId === v2, 'The history isn\'t newest first');
        }
        const methods = entries.map(e => e.request.method);
        ctx.should(methods[0] === 'PUT' && methods[1] === 'POST', `The history's requests are ${methods.join(', ')}, not PUT (the update) and POST (the create)`);
      }
    },
    {
      name: 'A delete is in the history',
      requires: { interactions: [['Patient', 'create'], ['Patient', 'delete'], ['Patient', 'history-instance']] },
      run: async (ctx) => {
        const made = await ctx.create(patient(ctx));
        ctx.status(await ctx.client.delete(`Patient/${made.id}`), [200, 202, 204], 'delete');
        const bundle = ctx.body(ctx.status(await ctx.client.get(`Patient/${made.id}/_history`), 200, 'history of a deleted resource'), 'Bundle', 'history');
        const entries = bundle.entry || [];
        ctx.must(entries.length === 2, `The history of a created then deleted Patient has ${entries.length} entries, not 2`);
        ctx.must(entries[0].request && entries[0].request.method === 'DELETE', `The newest entry's request is ${entries[0].request && entries[0].request.method}, not DELETE`);
        ctx.must(!entries[0].resource, 'The delete\'s history entry has a resource');
      }
    },
    {
      name: 'The history of a type, since a time',
      requires: { interactions: [['Patient', 'create'], ['Patient', 'history-type']] },
      run: async (ctx) => {
        const made = await ctx.create(patient(ctx));
        const since = before(made.resource);
        const res = ctx.status(await ctx.client.get(`Patient/_history?_since=${encodeURIComponent(since)}&_count=100`), 200, 'GET [base]/Patient/_history?_since');
        const first = ctx.body(res, 'Bundle', 'type history');
        ctx.must(first.type === 'history', `The history is a ${first.type} Bundle, not a history`);
        const { pages } = await ctx.allPages(first, 'Patient', 'type history');
        const found = pages.some(b => (b.entry || []).some(e => e.resource && e.resource.resourceType === 'Patient' && e.resource.id === made.id));
        ctx.must(found, `The Patient just created (${made.id}) isn't in the Patient history since ${since}`);
        const others = pages.flatMap(b => b.entry || []).filter(e => e.resource && e.resource.resourceType !== 'Patient');
        ctx.must(!others.length, `The Patient history has ${others[0] && others[0].resource.resourceType}s in it`);
      }
    }
  ]
};
