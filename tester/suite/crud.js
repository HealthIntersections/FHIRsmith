//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// create, read, vread, update and delete

const { patient, unknownId, etag, versionOf, ifMatch, family, isOutcome, uniqueWord } = require('./common');

module.exports = {
  name: 'Create, read, update, delete',
  tests: [
    {
      name: 'create: 201, Location, and the resource as stored',
      requires: { interactions: [['Patient', 'create'], ['Patient', 'read']] },
      run: async (ctx) => {
        const p = patient(ctx);
        const res = ctx.status(await ctx.client.post('Patient', p), 201, 'POST [base]/Patient');
        ctx.must(res.headers.location, 'POST [base]/Patient: no Location header');
        const m = /Patient\/([A-Za-z0-9\-.]{1,64})\/_history\/([^/?]+)/.exec(res.headers.location);
        ctx.should(m, `POST [base]/Patient: the Location header (${res.headers.location}) should be [base]/Patient/[id]/_history/[vid]`);
        const id = (res.resource && res.resource.id) || (m && m[1]) || (/Patient\/([A-Za-z0-9\-.]{1,64})/.exec(res.headers.location) || [])[1];
        ctx.must(id, 'POST [base]/Patient: no id in the Location header or the body');
        ctx.created('Patient', id);
        ctx.should(res.headers.etag, 'POST [base]/Patient: no ETag header');
        ctx.should(res.headers['last-modified'], 'POST [base]/Patient: no Last-Modified header');
        const read = ctx.status(await ctx.client.get(`Patient/${id}`), 200, `GET [base]/Patient/${id}`);
        const stored = ctx.body(read, 'Patient', `GET [base]/Patient/${id}`);
        ctx.must(stored.id === id, `GET [base]/Patient/${id}: the resource's id is ${stored.id}`);
        ctx.must(family(stored) === family(p), `GET [base]/Patient/${id}: the name is ${family(stored)}, not ${family(p)}`);
        ctx.should(stored.meta && stored.meta.versionId, `GET [base]/Patient/${id}: no meta.versionId`);
        ctx.should(stored.meta && stored.meta.lastUpdated, `GET [base]/Patient/${id}: no meta.lastUpdated`);
        ctx.should(read.headers.etag, `GET [base]/Patient/${id}: no ETag header`);
        if (read.headers.etag && stored.meta && stored.meta.versionId) {
          ctx.should(versionOf(read.headers.etag) === stored.meta.versionId, `GET [base]/Patient/${id}: the ETag (${read.headers.etag}) isn't the version (${stored.meta.versionId})`);
        }
      }
    },
    {
      name: 'create: an id in the resource is ignored',
      requires: { interactions: [['Patient', 'create']] },
      run: async (ctx) => {
        const mine = 'tester-' + uniqueWord().toLowerCase();
        const made = await ctx.createNow(patient(ctx, { id: mine }));
        ctx.must(made.id !== mine, `POST [base]/Patient with id ${mine}: the server used that id (it SHALL ignore it, and assign its own)`);
      }
    },
    {
      name: 'read: what isn\'t there is 404',
      requires: { interactions: [['Patient', 'read']] },
      run: async (ctx) => {
        const id = unknownId();
        const res = ctx.status(await ctx.client.get(`Patient/${id}`), 404, `GET [base]/Patient/${id}`);
        ctx.should(isOutcome(res), `GET [base]/Patient/${id}: the 404 has no OperationOutcome`);
      }
    },
    {
      name: 'vread: a version, as it was',
      requires: { interactions: [['Patient', 'create'], ['Patient', 'vread'], ['Patient', 'update']] },
      run: async (ctx) => {
        const made = await ctx.create(patient(ctx));
        ctx.must(made.version, 'The Patient created has no version (meta.versionId)');
        const changed = { ...made.resource, name: [{ family: uniqueWord() }] };
        await ctx.setup(async () => ctx.status(await ctx.client.put(`Patient/${made.id}`, changed, { headers: ifMatch(ctx, 'Patient', made.version) }), [200, 201], `PUT [base]/Patient/${made.id}`));
        const res = ctx.status(await ctx.client.get(`Patient/${made.id}/_history/${made.version}`), 200, `GET [base]/Patient/${made.id}/_history/${made.version}`);
        const old = ctx.body(res, 'Patient', 'vread');
        ctx.must(family(old) === family(made.resource), `GET [base]/Patient/${made.id}/_history/${made.version}: the name is ${family(old)}, not the first version's (${family(made.resource)})`);
        ctx.should(old.meta && old.meta.versionId === made.version, `vread: meta.versionId is ${old.meta && old.meta.versionId}, not ${made.version}`);
        const none = await ctx.client.get(`Patient/${made.id}/_history/${unknownId()}`);
        ctx.must(none.status === 404, `GET of a version that doesn't exist: ${none.status}, not 404`);
      }
    },
    {
      name: 'update: a new version',
      requires: { interactions: [['Patient', 'create'], ['Patient', 'update'], ['Patient', 'read']] },
      run: async (ctx) => {
        const made = await ctx.create(patient(ctx));
        const name = uniqueWord();
        const changed = { ...made.resource, name: [{ family: name }] };
        const res = ctx.status(await ctx.client.put(`Patient/${made.id}`, changed, { headers: ifMatch(ctx, 'Patient', made.version) }), 200, `PUT [base]/Patient/${made.id}`);
        ctx.should(res.headers.etag, `PUT [base]/Patient/${made.id}: no ETag header`);
        const read = ctx.body(ctx.status(await ctx.client.get(`Patient/${made.id}`), 200, `GET [base]/Patient/${made.id}`), 'Patient', 'read');
        ctx.must(family(read) === name, `After the update, the name is ${family(read)}, not ${name}`);
        if (ctx.cap.versioning('Patient') !== 'no-version' && made.version) {
          ctx.should(read.meta && read.meta.versionId && read.meta.versionId !== made.version, `After the update, the version is still ${made.version}`);
        }
      }
    },
    {
      name: 'update: If-Match with an old version is refused (412, or 409)',
      requires: { interactions: [['Patient', 'create'], ['Patient', 'update']], check: (cap) => cap.versioning('Patient') === 'versioned-update' ? null : 'The CapabilityStatement doesn\'t say Patient is versioned-update' },
      run: async (ctx) => {
        const made = await ctx.create(patient(ctx));
        ctx.status(await ctx.client.put(`Patient/${made.id}`, { ...made.resource, active: false }, { headers: { 'If-Match': etag(made.version) } }), 200, 'PUT with If-Match the current version');
        const res = await ctx.client.put(`Patient/${made.id}`, { ...made.resource, active: true }, { headers: { 'If-Match': etag(made.version) } });
        // the update section allows 409 or 412 for a version conflict; Managing Resource Contention says 412
        ctx.must([409, 412].includes(res.status), `PUT with If-Match an old version: ${res.status}, not 412 Precondition Failed (or 409 Conflict)`);
        ctx.should(res.status === 412, `PUT with If-Match an old version: ${res.status} (Managing Resource Contention says 412 Precondition Failed)`);
        const read = ctx.body(ctx.status(await ctx.client.get(`Patient/${made.id}`), 200, 'read'), 'Patient', 'read');
        ctx.must(read.active === false, 'The update with an old version changed the resource');
      }
    },
    {
      name: 'update: an id in the resource that isn\'t the URL\'s is refused (400)',
      requires: { interactions: [['Patient', 'create'], ['Patient', 'update']] },
      run: async (ctx) => {
        const made = await ctx.create(patient(ctx));
        const res = await ctx.client.put(`Patient/${made.id}`, { ...made.resource, id: made.id + 'x' }, { headers: ifMatch(ctx, 'Patient', made.version) });
        ctx.must(res.status === 400, `PUT [base]/Patient/${made.id} with id ${made.id}x: ${res.status}, not 400`);
        const none = await ctx.client.put(`Patient/${made.id}`, { ...made.resource, id: undefined }, { headers: ifMatch(ctx, 'Patient', made.version) });
        ctx.must(none.status === 400, `PUT [base]/Patient/${made.id} with no id in the resource: ${none.status}, not 400`);
      }
    },
    {
      name: 'update as create: a PUT to a new id makes it (201)',
      requires: { interactions: [['Patient', 'update'], ['Patient', 'read']], check: (cap) => cap.updateCreate('Patient') ? null : 'The CapabilityStatement doesn\'t say Patient is updateCreate' },
      run: async (ctx) => {
        const id = 'tester-' + uniqueWord().toLowerCase();
        const p = { ...patient(ctx), id };
        const res = await ctx.client.put(`Patient/${id}`, p);
        if (res.status === 200 || res.status === 201) {
          ctx.created('Patient', id);
        }
        ctx.status(res, 201, `PUT [base]/Patient/${id} (new)`);
        const read = ctx.body(ctx.status(await ctx.client.get(`Patient/${id}`), 200, `GET [base]/Patient/${id}`), 'Patient', 'read');
        ctx.must(family(read) === family(p), 'The Patient made by PUT isn\'t what was sent');
      }
    },
    {
      name: 'delete: gone, and deleting it again is fine',
      requires: { interactions: [['Patient', 'create'], ['Patient', 'delete'], ['Patient', 'read']] },
      run: async (ctx) => {
        const made = await ctx.create(patient(ctx));
        ctx.status(await ctx.client.delete(`Patient/${made.id}`), [200, 202, 204], `DELETE [base]/Patient/${made.id}`);
        const read = await ctx.client.get(`Patient/${made.id}`);
        ctx.must([404, 410].includes(read.status), `GET [base]/Patient/${made.id} after the delete: ${read.status}, not 410 (or 404)`);
        ctx.should(read.status === 410, `GET [base]/Patient/${made.id} after the delete: 404 (the server knows it was deleted: 410 Gone)`);
        const again = await ctx.client.delete(`Patient/${made.id}`);
        ctx.must(again.status < 500, `DELETE again: ${again.status}`);
        ctx.should([200, 204].includes(again.status), `DELETE of a deleted resource: ${again.status} (it has no effect: 200 or 204)`);
      }
    },
    {
      name: 'Prefer: return=minimal and return=OperationOutcome',
      requires: { interactions: [['Patient', 'create']] },
      run: async (ctx) => {
        const minimal = ctx.status(await ctx.client.post('Patient', patient(ctx), { headers: { Prefer: 'return=minimal' } }), 201, 'POST with Prefer: return=minimal');
        const m = /Patient\/([A-Za-z0-9\-.]{1,64})/.exec(minimal.headers.location || '');
        if (m) {
          ctx.created('Patient', m[1]);
        }
        ctx.should(!minimal.text.trim(), 'POST with Prefer: return=minimal: the response has a body');
        const oo = ctx.status(await ctx.client.post('Patient', patient(ctx), { headers: { Prefer: 'return=OperationOutcome' } }), 201, 'POST with Prefer: return=OperationOutcome');
        const m2 = /Patient\/([A-Za-z0-9\-.]{1,64})/.exec(oo.headers.location || '');
        if (m2) {
          ctx.created('Patient', m2[1]);
        }
        ctx.should(isOutcome(oo), 'POST with Prefer: return=OperationOutcome: the response isn\'t an OperationOutcome');
      }
    },
    {
      name: 'If-Modified-Since: 304 when it hasn\'t changed since',
      requires: { interactions: [['Patient', 'create'], ['Patient', 'read']], check: (cap) => ['modified-since', 'full-support'].includes(cap.conditionalRead('Patient')) ? null : 'The CapabilityStatement doesn\'t say Patient has conditionalRead modified-since' },
      run: async (ctx) => {
        const made = await ctx.create(patient(ctx));
        const read = ctx.status(await ctx.client.get(`Patient/${made.id}`), 200, 'read');
        const since = read.headers['last-modified'] || new Date(Date.parse(made.resource.meta.lastUpdated) + 1000).toUTCString();
        const res = await ctx.client.get(`Patient/${made.id}`, { headers: { 'If-Modified-Since': since } });
        ctx.must(res.status === 304, `GET with If-Modified-Since ${since} (not changed since): ${res.status}, not 304`);
        const old = await ctx.client.get(`Patient/${made.id}`, { headers: { 'If-Modified-Since': 'Sat, 01 Jan 2000 00:00:00 GMT' } });
        ctx.must(old.status === 200, `GET with If-Modified-Since in 2000: ${old.status}, not 200`);
      }
    },
    {
      name: 'If-None-Match: 304 when the version hasn\'t changed',
      requires: { interactions: [['Patient', 'create'], ['Patient', 'read']], check: (cap) => ['not-match', 'full-support'].includes(cap.conditionalRead('Patient')) ? null : 'The CapabilityStatement doesn\'t say Patient has conditionalRead not-match' },
      run: async (ctx) => {
        const made = await ctx.create(patient(ctx));
        const res = await ctx.client.get(`Patient/${made.id}`, { headers: { 'If-None-Match': etag(made.version) } });
        ctx.must(res.status === 304, `GET with If-None-Match the current version: ${res.status}, not 304`);
        const other = await ctx.client.get(`Patient/${made.id}`, { headers: { 'If-None-Match': etag(made.version + '0') } });
        ctx.must(other.status === 200, `GET with If-None-Match another version: ${other.status}, not 200`);
      }
    }
  ]
};
