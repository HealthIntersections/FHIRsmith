//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// search: references of each kind (relative, id only, absolute to this server, versioned, by
// identifier, to another server), chaining through them, reverse chaining, and includes. A
// server needn't chain, or include, so those are ctx.optional: refused, they're not supported;
// done, they must be right

const { patient, observation, uniqueWord, family } = require('./common');

const same = (a, b) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
const show = (ids) => ids.length ? ids.join(', ') : 'nothing';

async function finds(ctx, type, params, expected) {
  const { ids } = await ctx.search(type, params);
  ctx.must(same(ids, expected), `${type}?${params.map(([n, v]) => `${n}=${v}`).join('&')} found ${show(ids)}, not ${show(expected)}`);
}

const OBS = [['Observation', 'create'], ['Observation', 'search-type'], ['Patient', 'create']];
const SUBJECT = { interactions: OBS, search: [['Observation', 'subject']], scope: ['Observation'] };

/** Make an Observation whose subject is a reference of some kind: null if the server won't take it */
async function withSubject(ctx, subject, what) {
  const res = await ctx.setup(() => ctx.client.post('Observation', observation(ctx, 'x', { subject })));
  if (res.status !== 201) {
    ctx.note(`The server didn't take an Observation whose subject is ${what} (${res.status})`);
    return null;
  }
  const m = /Observation\/([A-Za-z0-9\-.]{1,64})/.exec(res.headers.location || '');
  const id = (res.resource && res.resource.id) || (m && m[1]);
  ctx.created('Observation', id);
  ctx.resources.push({ type: 'Observation', id, resource: res.resource || { subject } });
  return id;
}

/** A Patient of the run's, with an Organization */
async function patientWithOrganization(ctx) {
  const word = uniqueWord();
  const org = await ctx.create(ctx.resource('Organization', { name: word + 'org', active: true }));
  const p = await ctx.create(patient(ctx, { name: [{ family: word }], managingOrganization: { reference: `Organization/${org.id}` } }));
  return { org, p, word };
}

module.exports = {
  name: 'Search: references and chaining',
  tests: [
    {
      name: 'A relative reference: by Type/id, by id, by type modifier, and by absolute URL',
      requires: SUBJECT,
      run: async (ctx) => {
        const p = await ctx.create(patient(ctx));
        const o = await ctx.create(observation(ctx, p.id));
        await finds(ctx, 'Observation', [['subject', `Patient/${p.id}`]], [o.id]);
        await finds(ctx, 'Observation', [['subject', p.id]], [o.id]);
        await finds(ctx, 'Observation', [['subject:Patient', p.id]], [o.id]);
        await finds(ctx, 'Observation', [['subject', `Patient/${p.id}x`]], []);
        const { ids } = await ctx.search('Observation', [['subject', `${ctx.serverBase}/Patient/${p.id}`]]);
        ctx.should(same(ids, [o.id]), `subject=${ctx.serverBase}/Patient/${p.id} (the server's own address) found ${show(ids)}, not ${o.id}`);
      }
    },
    {
      name: 'A reference stored as an absolute URL to this server',
      requires: SUBJECT,
      run: async (ctx) => {
        const p = await ctx.create(patient(ctx));
        const id = await withSubject(ctx, { reference: `${ctx.serverBase}/Patient/${p.id}` }, 'an absolute URL to this server');
        if (!id) {
          ctx.skip('The server didn\'t take a reference that is an absolute URL to itself');
        }
        const rel = await ctx.search('Observation', [['subject', `Patient/${p.id}`]]);
        ctx.should(same(rel.ids, [id]), `subject=Patient/${p.id} found ${show(rel.ids)}, not the Observation that refers to [base]/Patient/${p.id}`);
        const abs = await ctx.search('Observation', [['subject', `${ctx.serverBase}/Patient/${p.id}`]]);
        ctx.must(same(abs.ids, [id]), `subject=[base]/Patient/${p.id} found ${show(abs.ids)}, not ${id} (the reference as it was written)`);
        await ctx.optional('Observation', [['subject:Patient.family', family(p.resource)]], [id], { feature: 'chaining through an absolute reference', level: 'should' });
      }
    },
    {
      name: 'A version-specific reference',
      requires: SUBJECT,
      run: async (ctx) => {
        const p = await ctx.create(patient(ctx));
        ctx.must(p.version, 'The Patient has no version to refer to');
        const id = await withSubject(ctx, { reference: `Patient/${p.id}/_history/${p.version}` }, 'a version-specific reference');
        if (!id) {
          ctx.skip('The server didn\'t take a version-specific reference');
        }
        const { ids } = await ctx.search('Observation', [['subject', `Patient/${p.id}`]]);
        ctx.should(same(ids, [id]), `subject=Patient/${p.id} found ${show(ids)}, not the Observation that refers to Patient/${p.id}/_history/${p.version}`);
        await ctx.optional('Observation', [['subject:Patient.family', family(p.resource)]], [id], { feature: 'chaining through a version-specific reference', level: 'should' });
      }
    },
    {
      name: 'A logical reference (an identifier): :identifier',
      requires: SUBJECT,
      run: async (ctx) => {
        const ident = ctx.identifier();
        const id = await withSubject(ctx, { identifier: ident, display: 'Someone known only by an identifier' }, 'a logical reference (an identifier, no reference)');
        if (!id) {
          ctx.skip('The server didn\'t take a reference that is only an identifier');
        }
        await ctx.optional('Observation', [['subject:identifier', `${ident.system}|${ident.value}`]], [id], { feature: 'subject:identifier' });
        await finds(ctx, 'Observation', [['subject', ident.value]], []);
      }
    },
    {
      name: 'A reference to another server',
      requires: SUBJECT,
      run: async (ctx) => {
        const word = uniqueWord().toLowerCase();
        const url = `http://example.org/fhir/Patient/${word}`;
        const id = await withSubject(ctx, { reference: url }, 'a reference to another server');
        if (!id) {
          ctx.skip('The server didn\'t take a reference to another server');
        }
        const { ids } = await ctx.search('Observation', [['subject', url]]);
        ctx.should(same(ids, [id]), `subject=${url} found ${show(ids)}, not ${id}`);
        // Patient/[id] resolves to this server's own Patient/[id], which isn't the other server's:
        // a match is "a relative reference resolving to the same value", but no SHALL says so
        const local = await ctx.search('Observation', [['subject', `Patient/${word}`]]);
        ctx.should(local.ids.length === 0, `subject=Patient/${word} (on this server) found ${show(local.ids)}, which refers to ${url} (another server's Patient)`);
      }
    },
    {
      name: 'Chaining: a parameter with one target type',
      requires: { interactions: [['Patient', 'create'], ['Patient', 'search-type'], ['Organization', 'create']], search: [['Patient', 'organization'], ['Organization', 'name']], scope: ['Patient'] },
      run: async (ctx) => {
        const { org, p } = await patientWithOrganization(ctx);
        await ctx.create(patient(ctx));
        await ctx.optional('Patient', [['organization.name', org.resource.name]], [p.id], { feature: 'chaining (organization.name)' });
        await ctx.optional('Patient', [['organization:Organization.name', org.resource.name]], [p.id], { feature: 'chaining with a type (organization:Organization.name)' });
      }
    },
    {
      name: 'Chaining: a parameter with several target types, with and without the type',
      requires: { ...SUBJECT, search: [['Observation', 'subject'], ['Patient', 'family']] },
      run: async (ctx) => {
        const p = await ctx.create(patient(ctx));
        const other = await ctx.create(patient(ctx));
        const o = await ctx.create(observation(ctx, p.id));
        await ctx.create(observation(ctx, other.id));
        await ctx.optional('Observation', [['subject:Patient.family', family(p.resource)]], [o.id], { feature: 'chaining with a type (subject:Patient.family)' });
        // without the type, a server may refuse it (more than one type has family), or search them all
        await ctx.optional('Observation', [['subject.family', family(p.resource)]], [o.id], { feature: 'chaining without a type (subject.family)' });
        await ctx.optional('Observation', [['subject:Patient.family:exact', family(p.resource)]], [o.id], { feature: 'a modifier at the end of a chain' });
        if (ctx.cap.searchParam('Patient', 'identifier')) {
          const ident = p.resource.identifier[0];
          await ctx.optional('Observation', [['subject:Patient.identifier', `${ident.system}|${ident.value}`]], [o.id], { feature: 'chaining to a token' });
        }
      }
    },
    {
      name: 'Chaining: two levels',
      requires: { ...SUBJECT, interactions: [...OBS, ['Organization', 'create']], search: [['Observation', 'subject'], ['Patient', 'organization'], ['Organization', 'name']] },
      run: async (ctx) => {
        const { org, p } = await patientWithOrganization(ctx);
        const other = await ctx.create(patient(ctx));
        const o = await ctx.create(observation(ctx, p.id));
        await ctx.create(observation(ctx, other.id));
        await ctx.optional('Observation', [['subject:Patient.organization.name', org.resource.name]], [o.id], { feature: 'chaining two levels' });
      }
    },
    {
      name: 'Reverse chaining: _has, and _has in _has',
      requires: { interactions: [...OBS, ['Organization', 'create'], ['Organization', 'search-type']], search: [['Organization', '_has'], ['Patient', 'organization'], ['Observation', 'code']], scope: ['Organization'] },
      run: async (ctx) => {
        const { org, p } = await patientWithOrganization(ctx);
        await ctx.create(ctx.resource('Organization', { name: uniqueWord() }));
        const code = 'tester-' + uniqueWord().toLowerCase();
        await ctx.create(observation(ctx, p.id, { code: { coding: [{ system: 'http://example.org/tester', code }] } }));
        await ctx.optional('Organization', [['_has:Patient:organization:_id', p.id]], [org.id], { feature: '_has' });
        await ctx.optional('Organization', [['_has:Patient:organization:_has:Observation:subject:code', `http://example.org/tester|${code}`]], [org.id], { feature: '_has inside _has' });
      }
    },
    {
      name: '_include: with a target type, :iterate, and *',
      requires: { interactions: [...OBS, ['Organization', 'create']], search: [['Observation', 'subject']], scope: ['Observation'],
        check: (cap) => cap.searchInclude('Observation').length ? null : 'The CapabilityStatement lists no _include for Observation' },
      run: async (ctx) => {
        const { org, p } = await patientWithOrganization(ctx);
        const o = await ctx.create(observation(ctx, p.id));
        const scope = ctx.scope('Observation');
        const get = async (params, feature) => {
          const res = await ctx.client.get(`Observation?${[...params, ...scope].map(([n, v]) => `${encodeURIComponent(n)}=${encodeURIComponent(v)}`).join('&')}`);
          if ([400, 404, 422, 501].includes(res.status)) {
            ctx.unsupported.push(`${feature} (${res.status})`);
            return null;
          }
          ctx.optionalRan++;
          ctx.status(res, 200, feature);
          const all = (ctx.body(res, 'Bundle', feature).entry || []).map(e => e.resource).filter(Boolean);
          ctx.must(all.some(r => r.resourceType === 'Observation' && r.id === o.id), `${feature}: the Observation isn't there`);
          return all;
        };
        const typed = await get([['_include', 'Observation:subject:Patient']], '_include=Observation:subject:Patient');
        if (typed) {
          ctx.must(typed.some(r => r.resourceType === 'Patient' && r.id === p.id), '_include=Observation:subject:Patient didn\'t include the Patient');
        }
        const iterate = await get([['_include', 'Observation:subject'], ['_include:iterate', 'Patient:organization']], '_include:iterate');
        if (iterate) {
          ctx.must(iterate.some(r => r.resourceType === 'Patient' && r.id === p.id), '_include=Observation:subject didn\'t include the Patient');
          ctx.should(iterate.some(r => r.resourceType === 'Organization' && r.id === org.id), '_include:iterate=Patient:organization didn\'t include the Patient\'s Organization');
        }
        const star = await get([['_include', '*']], '_include=*');
        if (star) {
          ctx.should(star.some(r => r.resourceType === 'Patient' && r.id === p.id), '_include=* didn\'t include the Patient');
        }
      }
    },
    {
      name: '_revinclude from another type',
      requires: { interactions: [['Organization', 'create'], ['Organization', 'search-type'], ['Patient', 'create']], search: [['Organization', '_id'], ['Patient', 'organization']],
        check: (cap) => cap.searchRevInclude('Organization').length ? null : 'The CapabilityStatement lists no _revinclude for Organization' },
      run: async (ctx) => {
        const { org, p } = await patientWithOrganization(ctx);
        const res = await ctx.client.get(`Organization?_id=${encodeURIComponent(org.id)}&_revinclude=Patient:organization`);
        if ([400, 404, 422, 501].includes(res.status)) {
          ctx.unsupported.push(`_revinclude=Patient:organization (${res.status})`);
          return;
        }
        ctx.optionalRan++;
        const bundle = ctx.body(ctx.status(res, 200, '_revinclude'), 'Bundle', '_revinclude');
        const all = (bundle.entry || []).map(e => e.resource).filter(Boolean);
        ctx.must(all.some(r => r.resourceType === 'Organization' && r.id === org.id), 'The Organization isn\'t there');
        ctx.must(all.some(r => r.resourceType === 'Patient' && r.id === p.id), '_revinclude=Patient:organization didn\'t include the Patient');
        const included = (bundle.entry || []).find(e => e.resource && e.resource.resourceType === 'Patient' && e.resource.id === p.id);
        ctx.should(included.search && included.search.mode === 'include', `The Patient's search.mode is ${included.search && included.search.mode}, not include`);
      }
    }
  ]
};
