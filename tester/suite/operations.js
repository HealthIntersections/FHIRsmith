//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// operations the server lists: $meta, $meta-add, $meta-delete, $everything

const { patient, observation } = require('./common');

const TAG = { system: 'http://example.org/tester/tags', code: 'tester-added' };

const hasTag = (meta) => !!(meta && (meta.tag || []).some(t => t.system === TAG.system && t.code === TAG.code));

/** The Meta in a $meta answer (Parameters, with a parameter named "return") */
function metaOf(ctx, res, what) {
  const params = ctx.body(res, 'Parameters', what);
  const p = (params.parameter || []).find(x => x.name === 'return');
  ctx.must(p && p.valueMeta, `${what}: the Parameters has no "return" with a valueMeta`);
  return p.valueMeta;
}

module.exports = {
  name: 'Operations',
  tests: [
    {
      name: '$meta-add, $meta and $meta-delete',
      requires: { interactions: [['Patient', 'create'], ['Patient', 'read']], operations: [['Patient', 'meta-add'], ['Patient', 'meta-delete'], ['Patient', 'meta']] },
      run: async (ctx) => {
        const made = await ctx.create(patient(ctx));
        const params = { resourceType: 'Parameters', parameter: [{ name: 'meta', valueMeta: { tag: [TAG] } }] };
        const added = metaOf(ctx, ctx.status(await ctx.client.post(`Patient/${made.id}/$meta-add`, params), 200, '$meta-add'), '$meta-add');
        ctx.must(hasTag(added), 'The Meta $meta-add returned doesn\'t have the tag');
        const meta = metaOf(ctx, ctx.status(await ctx.client.get(`Patient/${made.id}/$meta`), 200, '$meta'), '$meta');
        ctx.must(hasTag(meta), '$meta doesn\'t have the tag $meta-add added');
        const read = ctx.body(ctx.status(await ctx.client.get(`Patient/${made.id}`), 200, 'read'), 'Patient', 'read');
        ctx.must(hasTag(read.meta), 'The Patient doesn\'t have the tag $meta-add added');
        const deleted = metaOf(ctx, ctx.status(await ctx.client.post(`Patient/${made.id}/$meta-delete`, params), 200, '$meta-delete'), '$meta-delete');
        ctx.must(!hasTag(deleted), 'The Meta $meta-delete returned still has the tag');
        const after = ctx.body(ctx.status(await ctx.client.get(`Patient/${made.id}`), 200, 'read'), 'Patient', 'read');
        ctx.must(!hasTag(after.meta), 'The Patient still has the tag after $meta-delete');
        ctx.must((after.meta.tag || []).some(t => t.system === ctx.run.tag.system && t.code === ctx.run.tag.code), '$meta-delete took the other tags too');
      }
    },
    {
      name: 'Patient $everything',
      requires: { interactions: [['Patient', 'create'], ['Observation', 'create']], operations: [['Patient', 'everything']] },
      run: async (ctx) => {
        const p = await ctx.create(patient(ctx));
        const o = await ctx.create(observation(ctx, p.id));
        const other = await ctx.create(patient(ctx));
        await ctx.create(observation(ctx, other.id));
        const res = ctx.status(await ctx.client.get(`Patient/${p.id}/$everything`), 200, 'Patient/$everything');
        const bundle = ctx.body(res, 'Bundle', '$everything');
        const { pages } = await ctx.allPages(bundle, 'Patient', '$everything');
        const all = pages.flatMap(b => b.entry || []).map(e => e.resource).filter(Boolean);
        ctx.must(all.some(r => r.resourceType === 'Patient' && r.id === p.id), '$everything doesn\'t have the Patient');
        ctx.must(all.some(r => r.resourceType === 'Observation' && r.id === o.id), '$everything doesn\'t have the Patient\'s Observation');
        ctx.must(!all.some(r => r.resourceType === 'Patient' && r.id === other.id), '$everything has another Patient');
      }
    }
  ]
};
