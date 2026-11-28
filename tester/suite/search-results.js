//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// search: what comes back - sorting, summaries, totals, the entries - and searching across types
// and in a compartment

const { patient, observation, uniqueWord } = require('./common');

const same = (a, b) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
const show = (ids) => ids.length ? ids.join(', ') : 'nothing';
const PATIENTS = [['Patient', 'search-type'], ['Patient', 'create']];

const subsetted = (r) => !!(r.meta && (r.meta.tag || []).some(t => t.code === 'SUBSETTED'));

module.exports = {
  name: 'Search: results',
  tests: [
    {
      name: '_sort: several keys, and descending',
      requires: { interactions: PATIENTS, search: [['Patient', 'family'], ['Patient', 'birthdate']], scope: ['Patient'] },
      run: async (ctx) => {
        const word = uniqueWord();
        const a = await ctx.create(patient(ctx, { name: [{ family: word + 'b' }], birthDate: '1980-01-01' }));
        const b = await ctx.create(patient(ctx, { name: [{ family: word + 'a' }], birthDate: '1990-01-01' }));
        const c = await ctx.create(patient(ctx, { name: [{ family: word + 'c' }], birthDate: '1980-01-01' }));
        const order = async (sort) => {
          const scope = ctx.scope('Patient');
          const res = await ctx.client.get(`Patient?_sort=${sort}&${scope.map(([n, v]) => `${n}=${encodeURIComponent(v)}`).join('&')}`);
          if ([400, 404, 422, 501].includes(res.status)) {
            ctx.unsupported.push(`_sort=${sort} (${res.status})`);
            return null;
          }
          ctx.optionalRan++;
          return ctx.matches(ctx.body(ctx.status(res, 200, `_sort=${sort}`), 'Bundle', '_sort'), 'Patient');
        };
        const byDate = await order('birthdate,family');
        if (byDate) {
          ctx.should(byDate.join() === [a.id, c.id, b.id].join(), `_sort=birthdate,family: ${show(byDate)}, not ${[a.id, c.id, b.id].join(', ')}`);
        }
        const down = await order('-birthdate,-family');
        if (down) {
          ctx.should(down.join() === [b.id, c.id, a.id].join(), `_sort=-birthdate,-family: ${show(down)}, not ${[b.id, c.id, a.id].join(', ')}`);
        }
        const updated = await order('_lastUpdated');
        if (updated) {
          ctx.should(updated.join() === [a.id, b.id, c.id].join(), `_sort=_lastUpdated: ${show(updated)}, not ${[a.id, b.id, c.id].join(', ')} (the order they were made)`);
        }
      }
    },
    {
      name: '_summary=true and _summary=data',
      requires: { interactions: PATIENTS, search: [['Patient', 'family']], scope: ['Patient'] },
      run: async (ctx) => {
        const made = await ctx.create(patient(ctx, { text: { status: 'generated', div: '<div xmlns="http://www.w3.org/1999/xhtml">A test patient</div>' },
          contact: [{ name: { family: 'Contact' } }] }));
        const s = await ctx.search('Patient', [['_summary', 'true']]);
        const summary = (s.bundle.entry || []).map(e => e.resource).find(r => r && r.id === made.id);
        ctx.must(summary, '_summary=true didn\'t return the Patient');
        ctx.should(!summary.contact && !summary.text, '_summary=true: the Patient has elements that aren\'t in the summary (contact, or text)');
        ctx.should(subsetted(summary), '_summary=true: the Patient isn\'t tagged SUBSETTED');
        const d = await ctx.search('Patient', [['_summary', 'data']]);
        const data = (d.bundle.entry || []).map(e => e.resource).find(r => r && r.id === made.id);
        ctx.must(data, '_summary=data didn\'t return the Patient');
        ctx.should(!data.text && data.contact, '_summary=data: the Patient should have everything but its text');
        ctx.should(subsetted(data), '_summary=data: the Patient isn\'t tagged SUBSETTED');
      }
    },
    {
      name: 'The entries: fullUrl, search.mode, and total',
      requires: { interactions: PATIENTS, search: [['Patient', 'family']], scope: ['Patient'] },
      run: async (ctx) => {
        const word = uniqueWord();
        const a = await ctx.create(patient(ctx, { name: [{ family: word + 'a' }] }));
        const b = await ctx.create(patient(ctx, { name: [{ family: word + 'b' }] }));
        const { bundle, ids } = await ctx.search('Patient', [['family', word], ['_total', 'accurate']]);
        ctx.must(same(ids, [a.id, b.id]), `The search found ${show(ids)}`);
        const entries = (bundle.entry || []).filter(e => e.resource && e.resource.resourceType === 'Patient');
        ctx.must(entries.every(e => e.fullUrl), 'Search results have no fullUrl');
        ctx.should(entries.every(e => /^https?:\/\//.test(e.fullUrl) && e.fullUrl.endsWith(`/Patient/${e.resource.id}`)),
          `The fullUrls (${entries.map(e => e.fullUrl).join(', ')}) aren't [base]/Patient/[id]`);
        ctx.should(entries.every(e => e.search && e.search.mode === 'match'), 'The matches\' search.mode isn\'t match');
        ctx.should(bundle.total === 2, `_total=accurate: the total is ${bundle.total}, not 2`);
      }
    },
    {
      name: 'Searching across types: [base]?_type',
      requires: { interactions: [['Patient', 'create'], ['Observation', 'create']], system: ['search-system'],
        check: (cap) => (cap.rest.searchParam || []).some(p => p.name === '_tag') ? null : 'The CapabilityStatement doesn\'t list _tag for a search of the server (to limit it to the test\'s resources)' },
      run: async (ctx) => {
        const p = await ctx.create(patient(ctx));
        const o = await ctx.create(observation(ctx, p.id));
        const tag = `${ctx.testTag.system}|${ctx.testTag.code}`;
        const res = await ctx.client.get(`?_type=Patient,Observation&_tag=${encodeURIComponent(tag)}`);
        if ([400, 404, 422, 501].includes(res.status)) {
          ctx.unsupported.push(`_type (${res.status})`);
          return;
        }
        ctx.optionalRan++;
        const bundle = ctx.body(ctx.status(res, 200, 'GET [base]?_type=Patient,Observation'), 'Bundle', 'the search');
        const got = (bundle.entry || []).map(e => e.resource).filter(Boolean).map(r => `${r.resourceType}/${r.id}`);
        ctx.must(same(got, [`Patient/${p.id}`, `Observation/${o.id}`]), `[base]?_type=Patient,Observation found ${show(got)}`);
        const all = await ctx.client.get(`?_tag=${encodeURIComponent(tag)}`);
        ctx.status(all, 200, 'GET [base]?_tag');
        const every = (ctx.body(all, 'Bundle', 'the search').entry || []).map(e => e.resource).filter(Boolean).map(r => `${r.resourceType}/${r.id}`);
        ctx.must(same(every, [`Patient/${p.id}`, `Observation/${o.id}`]), `[base]?_tag found ${show(every)}`);
      }
    },
    {
      name: 'A compartment: [base]/Patient/[id]/Observation',
      requires: { interactions: [['Patient', 'create'], ['Observation', 'create'], ['Observation', 'search-type']], scope: ['Observation'] },
      run: async (ctx) => {
        const p = await ctx.create(patient(ctx));
        const other = await ctx.create(patient(ctx));
        const o = await ctx.create(observation(ctx, p.id));
        await ctx.create(observation(ctx, other.id));
        const listed = (ctx.cap.rest.compartment || []).some(c => /CompartmentDefinition\/patient$/i.test(String(c)));
        const scope = ctx.scope('Observation');
        const res = await ctx.client.get(`Patient/${p.id}/Observation?${scope.map(([n, v]) => `${n}=${encodeURIComponent(v)}`).join('&')}`);
        if (!listed && [400, 404, 405, 422, 501].includes(res.status)) {
          ctx.unsupported.push(`the Patient compartment (${res.status}; the CapabilityStatement doesn't list it)`);
          return;
        }
        ctx.optionalRan++;
        const bundle = ctx.body(ctx.status(res, 200, `GET [base]/Patient/${p.id}/Observation`), 'Bundle', 'the compartment');
        const ids = ctx.matches(bundle, 'Observation');
        ctx.must(same(ids, [o.id]), `[base]/Patient/${p.id}/Observation found ${show(ids)}, not ${o.id}`);
      }
    },
    {
      name: 'A compartment: with parameters, and every type in it ([base]/Patient/[id]/*)',
      requires: { interactions: [['Patient', 'create'], ['Observation', 'create'], ['Observation', 'search-type']], search: [['Observation', 'code']], scope: ['Observation'] },
      run: async (ctx) => {
        const p = await ctx.create(patient(ctx));
        const weight = await ctx.create(observation(ctx, p.id));
        await ctx.create(observation(ctx, p.id, { code: { coding: [{ system: 'http://loinc.org', code: '8302-2', display: 'Body height' }] }, valueQuantity: { value: 170, unit: 'cm', system: 'http://unitsofmeasure.org', code: 'cm' } }));
        const scope = ctx.scope('Observation').map(([n, v]) => `&${n}=${encodeURIComponent(v)}`).join('');
        const res = await ctx.client.get(`Patient/${p.id}/Observation?code=${encodeURIComponent('http://loinc.org|29463-7')}${scope}`);
        if ([400, 404, 405, 422, 501].includes(res.status)) {
          ctx.unsupported.push(`the Patient compartment (${res.status})`);
          return;
        }
        ctx.optionalRan++;
        const ids = ctx.matches(ctx.body(ctx.status(res, 200, `GET [base]/Patient/${p.id}/Observation?code=...`), 'Bundle', 'the compartment'), 'Observation');
        ctx.must(same(ids, [weight.id]), `[base]/Patient/${p.id}/Observation?code=29463-7 found ${show(ids)}, not ${weight.id}`);
        const all = await ctx.client.get(`Patient/${p.id}/*?_tag=${encodeURIComponent(`${ctx.testTag.system}|${ctx.testTag.code}`)}`);
        if ([400, 404, 405, 422, 501].includes(all.status)) {
          ctx.unsupported.push(`[base]/Patient/[id]/* (${all.status})`);
          return;
        }
        const got = (ctx.body(ctx.status(all, 200, `GET [base]/Patient/${p.id}/*`), 'Bundle', 'the compartment').entry || [])
          .map(e => e.resource).filter(r => r && r.resourceType === 'Observation').map(r => r.id);
        ctx.should(got.length === 2 && got.includes(weight.id), `[base]/Patient/${p.id}/* found ${show(got)}, not the patient's two Observations`);
      }
    }
  ]
};
