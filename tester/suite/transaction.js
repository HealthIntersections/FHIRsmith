//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// transactions and batches

const crypto = require('crypto');
const { patient, observation, family, uniqueWord, ifMatch } = require('./common');

const urn = () => `urn:uuid:${crypto.randomUUID()}`;

/** The type and id in a transaction response entry's location */
function where(entry) {
  const loc = entry && entry.response && entry.response.location;
  const m = /([A-Z][A-Za-z]+)\/([A-Za-z0-9\-.]{1,64})/.exec(String(loc || ''));
  return m ? { type: m[1], id: m[2] } : null;
}

/** Note what a response Bundle says was created, for cleaning up */
function remember(ctx, bundle) {
  for (const e of (bundle && bundle.entry) || []) {
    const w = where(e);
    if (w && e.response && /^201/.test(String(e.response.status))) {
      ctx.created(w.type, w.id);
    }
  }
}

async function post(ctx, bundle) {
  const res = await ctx.client.post('', bundle);
  if (res.resource && res.resource.resourceType === 'Bundle') {
    remember(ctx, res.resource);
  }
  return res;
}

module.exports = {
  name: 'Transactions and batches',
  tests: [
    {
      name: 'A transaction: new resources referring to each other by urn:uuid',
      requires: { system: ['transaction'], interactions: [['Patient', 'read'], ['Observation', 'read']] },
      run: async (ctx) => {
        const pUrl = urn();
        const oUrl = urn();
        const p = patient(ctx);
        const bundle = { resourceType: 'Bundle', type: 'transaction', entry: [
          // the Observation first: references go to entries before or after
          { fullUrl: oUrl, resource: observation(ctx, 'x', { subject: { reference: pUrl } }), request: { method: 'POST', url: 'Observation' } },
          { fullUrl: pUrl, resource: p, request: { method: 'POST', url: 'Patient' } }
        ] };
        const res = ctx.status(await post(ctx, bundle), 200, 'POST [base] (a transaction)');
        const out = ctx.body(res, 'Bundle', 'the transaction');
        ctx.must(out.type === 'transaction-response', `The response is a ${out.type} Bundle, not a transaction-response`);
        ctx.must((out.entry || []).length === 2, `The response has ${(out.entry || []).length} entries, not 2 (one for each)`);
        ctx.must(out.entry.every(e => e.response && /^201/.test(String(e.response.status))), `The entries' statuses are ${out.entry.map(e => e.response && e.response.status).join(', ')}, not 201`);
        const o = where(out.entry[0]);
        const pt = where(out.entry[1]);
        ctx.must(o && o.type === 'Observation' && pt && pt.type === 'Patient', 'The response entries aren\'t in the order of the request\'s, or have no location');
        const obs = ctx.body(ctx.status(await ctx.client.get(`Observation/${o.id}`), 200, 'reading the Observation'), 'Observation', 'read');
        ctx.must(obs.subject && obs.subject.reference === `Patient/${pt.id}`, `The Observation's subject is ${obs.subject && obs.subject.reference}, not Patient/${pt.id} (the urn:uuid, resolved)`);
        const read = ctx.body(ctx.status(await ctx.client.get(`Patient/${pt.id}`), 200, 'reading the Patient'), 'Patient', 'read');
        ctx.must(family(read) === family(p), 'The Patient isn\'t what was sent');
      }
    },
    {
      name: 'A transaction that fails changes nothing',
      requires: { system: ['transaction'], interactions: [['Patient', 'create'], ['Patient', 'update'], ['Patient', 'read'], ['Patient', 'search-type']],
        search: [['Patient', 'family']], scope: ['Patient'],
        check: (cap) => cap.versioning('Patient') === 'versioned-update' ? null : 'The CapabilityStatement doesn\'t say Patient is versioned-update (the test\'s failing entry is an update with If-Match an old version)' },
      run: async (ctx) => {
        // an entry no server can do: an update with If-Match a version that's no longer current
        const old = await ctx.create(patient(ctx));
        const current = ctx.status(await ctx.client.put(`Patient/${old.id}`, { ...old.resource, gender: 'male' }, { headers: ifMatch(ctx, 'Patient', old.version) }), 200, 'update');
        const word = uniqueWord();
        const bundle = { resourceType: 'Bundle', type: 'transaction', entry: [
          { fullUrl: urn(), resource: patient(ctx, { name: [{ family: word }] }), request: { method: 'POST', url: 'Patient' } },
          { fullUrl: `${ctx.serverBase}/Patient/${old.id}`, resource: { ...old.resource, gender: 'other' }, request: { method: 'PUT', url: `Patient/${old.id}`, ifMatch: `W/"${old.version}"` } }
        ] };
        const res = await post(ctx, bundle);
        ctx.must(res.status >= 400 && res.status < 600, `A transaction with an update whose If-Match is an old version: ${res.status}, not a 4xx (or 5xx)`);
        ctx.should(res.status < 500, `The failed transaction's status is ${res.status}: the request is what's wrong (4xx)`);
        ctx.should(res.resource && res.resource.resourceType === 'OperationOutcome', 'The failed transaction\'s response isn\'t an OperationOutcome');
        const { ids } = await ctx.search('Patient', [['family', word]]);
        ctx.must(ids.length === 0, 'The failed transaction made the Patient in its first entry');
        const read = ctx.body(ctx.status(await ctx.client.get(`Patient/${old.id}`), 200, 'read'), 'Patient', 'read');
        ctx.must(read.gender === 'male', `The failed transaction changed the Patient it couldn't update (gender ${read.gender})`);
        ctx.must(!current.resource || !current.resource.meta || read.meta.versionId === current.resource.meta.versionId, 'The failed transaction made a new version of the Patient');
      }
    },
    {
      name: 'A transaction: a PUT whose resource id isn\'t the URL\'s is refused',
      requires: { system: ['transaction'], interactions: [['Patient', 'update']] },
      run: async (ctx) => {
        // as for an update (400): the transaction section doesn't say it again, so a warning
        const id = 'tester-' + uniqueWord().toLowerCase();
        const res = await post(ctx, { resourceType: 'Bundle', type: 'transaction', entry: [
          { fullUrl: `${ctx.serverBase}/Patient/${id}`, resource: patient(ctx, { id: id + 'x' }), request: { method: 'PUT', url: `Patient/${id}` } }] });
        ctx.must(res.status < 500, `The transaction: ${res.status}`);
        ctx.should(res.status >= 400, `A transaction PUT of Patient/${id} with id ${id}x in the resource: ${res.status} (an update SHALL refuse that with 400)`);
      }
    },
    {
      name: 'A transaction: update, delete, conditional create and read together',
      requires: { system: ['transaction'], interactions: [['Patient', 'create'], ['Patient', 'update'], ['Patient', 'delete'], ['Patient', 'read']],
        check: (cap) => cap.conditionalCreate('Patient') ? null : 'The CapabilityStatement doesn\'t say Patient has conditionalCreate' },
      run: async (ctx) => {
        const a = await ctx.create(patient(ctx));
        const b = await ctx.create(patient(ctx));
        const ident = ctx.identifier();
        const name = uniqueWord();
        const bundle = { resourceType: 'Bundle', type: 'transaction', entry: [
          { fullUrl: `${ctx.serverBase}/Patient/${a.id}`, resource: { ...a.resource, name: [{ family: name }] },
            request: { method: 'PUT', url: `Patient/${a.id}`, ifMatch: ifMatch(ctx, 'Patient', a.version)['If-Match'] } },
          { request: { method: 'DELETE', url: `Patient/${b.id}` } },
          { fullUrl: urn(), resource: patient(ctx, { identifier: [ident] }), request: { method: 'POST', url: 'Patient', ifNoneExist: `identifier=${ident.system}|${ident.value}` } },
          { request: { method: 'GET', url: `Patient/${a.id}` } }
        ] };
        const out = ctx.body(ctx.status(await post(ctx, bundle), 200, 'the transaction'), 'Bundle', 'the transaction');
        const statuses = (out.entry || []).map(e => String(e.response && e.response.status).substring(0, 3));
        ctx.must(statuses.length === 4, `The response has ${statuses.length} entries, not 4`);
        ctx.must(statuses[0] === '200', `The PUT's status is ${statuses[0]}, not 200`);
        ctx.must(['200', '202', '204'].includes(statuses[1]), `The DELETE's status is ${statuses[1]}`);
        ctx.must(statuses[2] === '201', `The conditional create's status is ${statuses[2]}, not 201`);
        ctx.must(statuses[3] === '200', `The GET's status is ${statuses[3]}, not 200`);
        const read = ctx.body(ctx.status(await ctx.client.get(`Patient/${a.id}`), 200, 'read'), 'Patient', 'read');
        ctx.must(family(read) === name, 'The transaction\'s update didn\'t happen');
        const gone = await ctx.client.get(`Patient/${b.id}`);
        ctx.must([404, 410].includes(gone.status), `The transaction's delete didn't happen (${gone.status})`);
      }
    },
    {
      name: 'A batch: each entry on its own',
      requires: { system: ['batch'], interactions: [['Patient', 'create'], ['Patient', 'read']] },
      run: async (ctx) => {
        const bundle = { resourceType: 'Bundle', type: 'batch', entry: [
          { resource: patient(ctx), request: { method: 'POST', url: 'Patient' } },
          { resource: patient(ctx, { id: 'tester-a' }), request: { method: 'PUT', url: 'Patient/tester-b' } },
          { request: { method: 'GET', url: `Patient/tester-none-${uniqueWord().toLowerCase()}` } }
        ] };
        const out = ctx.body(ctx.status(await post(ctx, bundle), 200, 'POST [base] (a batch)'), 'Bundle', 'the batch');
        ctx.must(out.type === 'batch-response', `The response is a ${out.type} Bundle, not a batch-response`);
        const statuses = (out.entry || []).map(e => String(e.response && e.response.status).substring(0, 3));
        ctx.must(statuses.length === 3, `The response has ${statuses.length} entries, not 3`);
        ctx.must(statuses[0] === '201', `The POST's status is ${statuses[0]}, not 201`);
        ctx.must(statuses[1] === '400', `The PUT with the wrong id: ${statuses[1]}, not 400`);
        ctx.must(statuses[2] === '404', `The GET of nothing: ${statuses[2]}, not 404`);
        const made = where(out.entry[0]);
        ctx.must(made, 'The POST\'s response entry has no location');
        ctx.status(await ctx.client.get(`Patient/${made.id}`), 200, 'reading the Patient the batch made');
      }
    },
    {
      name: 'Not a transaction or batch is refused',
      requires: { check: (cap) => cap.systemInteraction('transaction') || cap.systemInteraction('batch') ? null : 'The CapabilityStatement lists neither transaction nor batch' },
      run: async (ctx) => {
        const res = await post(ctx, { resourceType: 'Bundle', type: 'collection', entry: [{ resource: patient(ctx) }] });
        ctx.must(res.status >= 400 && res.status < 500, `POST [base] of a collection Bundle: ${res.status}, not a 4xx`);
      }
    }
  ]
};
