//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// Searching and contained resources (search.html): by default, search results only include
// resources that aren't contained in others; a chained condition is evaluated inside contained
// resources; _contained and _containedType (optional) find contained resources, and return
// their containers, or them.
//
// A contained resource has no tags of its own, so these searches can't be scoped to the test
// by _tag: they're scoped by a name made for the test (uniqueWord), which nothing else has.

const { observation, uniqueWord } = require('./common');

const OBS = [['Observation', 'create'], ['Observation', 'search-type']];

function show(ids) {
  return ids.length ? [...ids].sort().join(', ') : 'nothing';
}

function same(a, b) {
  return a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');
}

/** An Observation whose subject is a Patient it contains, with the family name given */
function containing(ctx, family) {
  return observation(ctx, null, {
    contained: [{ resourceType: 'Patient', id: 'p1', name: [{ family, given: ['Contained'] }], gender: 'female' }],
    subject: { reference: '#p1' }
  });
}

/** A search's answer, with no scope: its status, Bundle, and entries */
async function plain(ctx, type, params, what) {
  const res = await ctx.client.get(`${type}?${params.map(([n, v]) => `${encodeURIComponent(n)}=${encodeURIComponent(v)}`).join('&')}`);
  return { res, what };
}

module.exports = {
  name: 'Search: contained resources',
  tests: [
    {
      name: 'Contained resources aren\'t matches of a search by default',
      requires: { interactions: [...OBS, ['Patient', 'search-type']], search: [['Patient', 'family']] },
      run: async (ctx) => {
        const word = uniqueWord();
        await ctx.create(containing(ctx, word));
        const what = `Patient?family=${word}`;
        const { res } = await plain(ctx, 'Patient', [['family', word]], what);
        const bundle = ctx.body(ctx.status(res, 200, what), 'Bundle', what);
        const found = (bundle.entry || []).filter(e => e.resource && (!e.search || e.search.mode !== 'outcome')).map(e => `${e.resource.resourceType}/${e.resource.id}`);
        ctx.must(!found.length, `${what} found ${show(found)}: the only Patient with that name is contained in an Observation, and by default search results only include resources that aren't contained`);
      }
    },
    {
      name: 'A chain is evaluated inside contained resources',
      requires: { interactions: OBS, search: [['Observation', 'subject']], scope: ['Observation'] },
      run: async (ctx) => {
        // optional: chaining may be refused (unsupported); done, it must look inside
        const word = uniqueWord();
        const o = await ctx.create(containing(ctx, word));
        if (!await ctx.optional('Observation', [['subject:Patient.family', word]], [o.id], { feature: 'subject:Patient.family (a chain into a contained Patient)' })) {
          return;
        }
        if (ctx.cap.searchParam('Observation', 'patient')) {
          await ctx.optional('Observation', [['patient.family', word]], [o.id], { feature: 'patient.family (a chain into a contained Patient)' });
        }
      }
    },
    {
      name: '_contained and _containedType',
      requires: { interactions: [...OBS, ['Patient', 'create'], ['Patient', 'search-type']], search: [['Patient', 'family']] },
      run: async (ctx) => {
        // optional: refused, it isn't supported; ignored (the same answer as without it), a
        // warning; done, it must be right
        const word = uniqueWord();
        const o1 = await ctx.create(containing(ctx, word));
        const o2 = await ctx.create(containing(ctx, word));
        const own = await ctx.create(ctx.resource('Patient', { name: [{ family: word, given: ['Own'] }], gender: 'male' }));
        const ask = async (params) => {
          const what = `Patient?${params.map(([n, v]) => `${n}=${v}`).join('&')}`;
          const { res } = await plain(ctx, 'Patient', params, what);
          if ([400, 404, 422, 501].includes(res.status)) {
            ctx.unsupported.push(`${params.filter(([n]) => n.startsWith('_contained')).map(([n, v]) => `${n}=${v}`).join('&')} (${res.status})`);
            return null;
          }
          const bundle = ctx.body(ctx.status(res, 200, what), 'Bundle', what);
          const matches = (bundle.entry || []).filter(e => e.resource && (!e.search || e.search.mode === 'match'));
          return { what, bundle, matches, refs: matches.map(e => `${e.resource.resourceType}/${e.resource.id}`) };
        };

        const containers = await ask([['family', word], ['_contained', 'true'], ['_containedType', 'container']]);
        if (!containers) {
          return;
        }
        if (same(containers.refs, [`Patient/${own.id}`]) || !containers.refs.length) {
          ctx.should(false, `${containers.what} found ${show(containers.refs)}: _contained seems to have been ignored`);
          return;
        }
        ctx.optionalRan++;
        ctx.must(same(containers.refs, [`Observation/${o1.id}`, `Observation/${o2.id}`]),
          `${containers.what} found ${show(containers.refs)}, not the two Observations that contain a Patient called ${word} (and not the Patient of its own)`);
        ctx.must(containers.matches.every(e => e.search && e.search.mode === 'match'), `${containers.what}: the containers aren't marked search.mode = match`);

        const contained = await ask([['family', word], ['_contained', 'true'], ['_containedType', 'contained']]);
        if (contained) {
          const pats = contained.matches.filter(e => e.resource.resourceType === 'Patient');
          ctx.must(pats.length === 2 && pats.every(e => e.resource.id === 'p1' && !contained.refs.includes(`Patient/${own.id}`)),
            `${contained.what} found ${show(contained.refs)}, not the two contained Patients themselves`);
          ctx.should(pats.every(e => /\/Observation\/[^/#]+#p1$/.test(String(e.fullUrl || ''))),
            `${contained.what}: the contained Patients' fullUrls (${pats.map(e => e.fullUrl).join(', ') || 'none'}) aren't [base]/Observation/[id]#p1, which says they're contained`);
        }

        const both = await ask([['family', word], ['_contained', 'both'], ['_containedType', 'container']]);
        if (both) {
          ctx.must(same(both.refs, [`Patient/${own.id}`, `Observation/${o1.id}`, `Observation/${o2.id}`]),
            `${both.what} found ${show(both.refs)}, not the Patient of its own and the two Observations that contain one`);
        }
      }
    }
  ]
};
