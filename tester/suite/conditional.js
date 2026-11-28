//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// conditional create, update, delete and patch: the criteria are always identifiers of the run's

const { patient, family, uniqueWord } = require('./common');

const criteria = (ident) => `identifier=${encodeURIComponent(`${ident.system}|${ident.value}`)}`;

/** A Patient with an identifier of its own, to find it by */
function identified(ctx, ident, fields) {
  return patient(ctx, { identifier: [ident], ...fields });
}

function located(ctx, res) {
  const m = /Patient\/([A-Za-z0-9\-.]{1,64})/.exec(res.headers.location || '');
  const id = (res.resource && res.resource.resourceType === 'Patient' && res.resource.id) || (m && m[1]);
  if (id) {
    ctx.created('Patient', id);
  }
  return id;
}

module.exports = {
  name: 'Conditional interactions',
  tests: [
    {
      name: 'Conditional create: no match creates, one match doesn\'t',
      requires: { interactions: [['Patient', 'create']], check: (cap) => cap.conditionalCreate('Patient') ? null : 'The CapabilityStatement doesn\'t say Patient has conditionalCreate' },
      run: async (ctx) => {
        const ident = ctx.identifier();
        const first = ctx.status(await ctx.client.post('Patient', identified(ctx, ident), { headers: { 'If-None-Exist': criteria(ident) } }), 201, 'A conditional create that matches nothing');
        const id = located(ctx, first);
        ctx.must(id, 'The conditional create said nothing about where the Patient is');
        const second = await ctx.client.post('Patient', identified(ctx, ident), { headers: { 'If-None-Exist': criteria(ident) } });
        const id2 = located(ctx, second);
        ctx.must(second.status === 200, `A conditional create that matches one: ${second.status}, not 200`);
        ctx.should(!id2 || id2 === id, `A conditional create that matches one points at ${id2}, not the match (${id})`);
      }
    },
    {
      name: 'Conditional create: more than one match is refused (412)',
      requires: { interactions: [['Patient', 'create']], check: (cap) => cap.conditionalCreate('Patient') ? null : 'The CapabilityStatement doesn\'t say Patient has conditionalCreate' },
      run: async (ctx) => {
        const ident = ctx.identifier();
        await ctx.create(identified(ctx, ident));
        await ctx.create(identified(ctx, ident));
        const res = await ctx.client.post('Patient', identified(ctx, ident), { headers: { 'If-None-Exist': criteria(ident) } });
        located(ctx, res);
        ctx.must(res.status === 412, `A conditional create that matches two: ${res.status}, not 412`);
      }
    },
    {
      name: 'Conditional update: one match is updated, no match is created',
      requires: { interactions: [['Patient', 'create'], ['Patient', 'update'], ['Patient', 'read']],
        check: (cap) => cap.conditionalUpdate('Patient') ? null : 'The CapabilityStatement doesn\'t say Patient has conditionalUpdate' },
      run: async (ctx) => {
        const ident = ctx.identifier();
        const made = await ctx.create(identified(ctx, ident));
        const name = uniqueWord();
        const res = ctx.status(await ctx.client.put(`Patient?${criteria(ident)}`, identified(ctx, ident, { name: [{ family: name }] })), 200, 'A conditional update that matches one');
        const id = located(ctx, res);
        ctx.should(!id || id === made.id, `The conditional update says it updated ${id}, not the match (${made.id})`);
        const read = ctx.body(ctx.status(await ctx.client.get(`Patient/${made.id}`), 200, 'read'), 'Patient', 'read');
        ctx.must(family(read) === name, 'The conditional update didn\'t change the Patient that matched');
        const fresh = ctx.identifier();
        const created = ctx.status(await ctx.client.put(`Patient?${criteria(fresh)}`, identified(ctx, fresh)), 201, 'A conditional update that matches nothing');
        ctx.must(located(ctx, created), 'The conditional update that created a Patient said nothing about where it is');
      }
    },
    {
      name: 'Conditional update: more than one match is refused (412)',
      requires: { interactions: [['Patient', 'create'], ['Patient', 'update']],
        check: (cap) => cap.conditionalUpdate('Patient') ? null : 'The CapabilityStatement doesn\'t say Patient has conditionalUpdate' },
      run: async (ctx) => {
        const ident = ctx.identifier();
        await ctx.create(identified(ctx, ident));
        await ctx.create(identified(ctx, ident));
        const res = await ctx.client.put(`Patient?${criteria(ident)}`, identified(ctx, ident));
        located(ctx, res);
        ctx.must(res.status === 412, `A conditional update that matches two: ${res.status}, not 412`);
      }
    },
    {
      name: 'Conditional delete',
      requires: { interactions: [['Patient', 'create'], ['Patient', 'delete'], ['Patient', 'read']],
        check: (cap) => cap.conditionalDelete('Patient') !== 'not-supported' ? null : 'The CapabilityStatement doesn\'t say Patient has conditionalDelete' },
      run: async (ctx) => {
        const ident = ctx.identifier();
        const made = await ctx.create(identified(ctx, ident));
        ctx.status(await ctx.client.delete(`Patient?${criteria(ident)}`), [200, 202, 204], 'A conditional delete that matches one');
        const read = await ctx.client.get(`Patient/${made.id}`);
        ctx.must([404, 410].includes(read.status), `After the conditional delete, the Patient reads ${read.status}`);
        const none = await ctx.client.delete(`Patient?${criteria(ctx.identifier())}`);
        ctx.must([200, 204, 404].includes(none.status), `A conditional delete that matches nothing: ${none.status}`);
        if (ctx.cap.conditionalDelete('Patient') === 'single') {
          const two = ctx.identifier();
          await ctx.create(identified(ctx, two));
          await ctx.create(identified(ctx, two));
          const res = await ctx.client.delete(`Patient?${criteria(two)}`);
          ctx.must(res.status === 412, `A conditional delete that matches two, on a server that deletes one at a time: ${res.status}, not 412`);
        } else if (ctx.cap.conditionalDelete('Patient') === 'multiple') {
          const two = ctx.identifier();
          const x = await ctx.create(identified(ctx, two));
          const y = await ctx.create(identified(ctx, two));
          ctx.status(await ctx.client.delete(`Patient?${criteria(two)}`), [200, 202, 204], 'A conditional delete that matches two, on a server that deletes several');
          for (const id of [x.id, y.id]) {
            const r = await ctx.client.get(`Patient/${id}`);
            ctx.must([404, 410].includes(r.status), `After a conditional delete of two, Patient/${id} reads ${r.status}`);
          }
        }
      }
    },
    {
      name: 'Conditional patch',
      requires: { interactions: [['Patient', 'create'], ['Patient', 'patch'], ['Patient', 'read']],
        check: (cap) => cap.conditionalPatch('Patient') === null
          ? 'The R4 CapabilityStatement doesn\'t say whether Patient has conditional patch (R5\'s conditionalPatch, as its cross-version extension: http://hl7.org/fhir/5.0/StructureDefinition/extension-CapabilityStatement.rest.resource.conditionalPatch)'
          : !cap.conditionalPatch('Patient') ? 'The CapabilityStatement doesn\'t say Patient has conditional patch'
            : !cap.patchFormat('application/json-patch+json') ? 'The CapabilityStatement doesn\'t list JSON Patch' : null },
      run: async (ctx) => {
        const ident = ctx.identifier();
        const made = await ctx.create(identified(ctx, ident));
        ctx.status(await ctx.client.patch(`Patient?${criteria(ident)}`, JSON.stringify([{ op: 'replace', path: '/active', value: false }]),
          { contentType: 'application/json-patch+json' }), 200, 'A conditional patch that matches one');
        const read = ctx.body(ctx.status(await ctx.client.get(`Patient/${made.id}`), 200, 'read'), 'Patient', 'read');
        ctx.must(read.active === false, 'The conditional patch didn\'t change the Patient');
      }
    }
  ]
};
