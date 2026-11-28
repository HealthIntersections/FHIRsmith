//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// search: every search is limited to the run's own resources (ctx.search adds _tag, or identifier)

const { patient, observation, uniqueWord, family, UCUM, LOINC, before } = require('./common');

const same = (a, b) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
const show = (ids) => ids.length ? ids.join(', ') : 'nothing';

/** The search must find exactly these */
async function finds(ctx, type, params, expected, options) {
  const { ids } = await ctx.search(type, params, options);
  ctx.must(same(ids, expected), `${type}?${params.map(([n, v]) => `${n}=${v}`).join('&')} found ${show(ids)}, not ${show(expected)}`);
  return ids;
}

// searching Patients the test makes
const P = () => [['Patient', 'search-type'], ['Patient', 'create']];

module.exports = {
  name: 'Search',
  tests: [
    {
      name: 'string: starts with, whatever the case and accents',
      requires: { interactions: P(), search: [['Patient', 'family']], scope: ['Patient'] },
      run: async (ctx) => {
        const word = uniqueWord();
        const a = await ctx.create(patient(ctx, { name: [{ family: word + 'alpha' }] }));
        const b = await ctx.create(patient(ctx, { name: [{ family: word + 'beta' }] }));
        await finds(ctx, 'Patient', [['family', word]], [a.id, b.id]);
        await finds(ctx, 'Patient', [['family', word + 'al']], [a.id]);
        await finds(ctx, 'Patient', [['family', (word + 'AL').toLowerCase()]], [a.id]);
        await finds(ctx, 'Patient', [['family', word.toUpperCase() + 'BETA']], [b.id]);
        // accents
        const c = await ctx.create(patient(ctx, { name: [{ family: word + 'Müller' }] }));
        await finds(ctx, 'Patient', [['family', word + 'muller']], [c.id]);
      }
    },
    {
      name: 'string: :exact and :contains',
      requires: { interactions: P(), search: [['Patient', 'family']], scope: ['Patient'] },
      run: async (ctx) => {
        const word = uniqueWord();
        const a = await ctx.create(patient(ctx, { name: [{ family: word }] }));
        const b = await ctx.create(patient(ctx, { name: [{ family: word + 'son' }] }));
        const exact = await ctx.search('Patient', [['family:exact', word]]);
        ctx.should(same(exact.ids, [a.id]), `family:exact=${word} found ${show(exact.ids)}, not just ${a.id}`);
        const contains = await ctx.search('Patient', [['family:contains', word.substring(3) + 'so']]);
        ctx.should(same(contains.ids, [b.id]), `family:contains found ${show(contains.ids)}, not ${b.id}`);
      }
    },
    {
      name: 'token: code, system|code, |code, and :not',
      requires: { interactions: P(), search: [['Patient', 'gender'], ['Patient', 'identifier']], scope: ['Patient'] },
      run: async (ctx) => {
        const word = uniqueWord();
        const ident = { system: 'http://example.org/tester/mrn', value: word };
        const f = await ctx.create(patient(ctx, { gender: 'female', identifier: [ident] }));
        const m = await ctx.create(patient(ctx, { gender: 'male' }));
        const female = await ctx.search('Patient', [['gender', 'female']]);
        ctx.must(female.ids.includes(f.id) && !female.ids.includes(m.id), `gender=female found ${show(female.ids)}`);
        await finds(ctx, 'Patient', [['identifier', `${ident.system}|${word}`]], [f.id]);
        await finds(ctx, 'Patient', [['identifier', word]], [f.id]);
        await finds(ctx, 'Patient', [['identifier', `http://example.org/other|${word}`]], []);
        const genders = await ctx.search('Patient', [['gender', 'http://hl7.org/fhir/administrative-gender|male']]);
        ctx.must(genders.ids.includes(m.id) && !genders.ids.includes(f.id), `gender=http://hl7.org/fhir/administrative-gender|male found ${show(genders.ids)}`);
        const not = await ctx.search('Patient', [['gender:not', 'female']]);
        ctx.should(not.ids.includes(m.id) && !not.ids.includes(f.id), `gender:not=female found ${show(not.ids)}`);
      }
    },
    {
      name: 'date: exact, ranges, and prefixes',
      requires: { interactions: P(), search: [['Patient', 'birthdate']], scope: ['Patient'] },
      run: async (ctx) => {
        const a = await ctx.create(patient(ctx, { birthDate: '1970-03-04' }));
        const b = await ctx.create(patient(ctx, { birthDate: '1985-11-20' }));
        await finds(ctx, 'Patient', [['birthdate', '1970-03-04']], [a.id]);
        await finds(ctx, 'Patient', [['birthdate', '1970']], [a.id]);
        await finds(ctx, 'Patient', [['birthdate', '1985-11']], [b.id]);
        await finds(ctx, 'Patient', [['birthdate', 'ge1980-01-01']], [b.id]);
        await finds(ctx, 'Patient', [['birthdate', 'lt1980']], [a.id]);
        await finds(ctx, 'Patient', [['birthdate', 'ge1970-03-04'], ['birthdate', 'le1985-11-20']], [a.id, b.id]);
        await finds(ctx, 'Patient', [['birthdate', 'gt1985-11-20']], []);
      }
    },
    {
      name: 'reference: by id, and by type/id',
      requires: { interactions: [...P(), ['Observation', 'create'], ['Observation', 'search-type']], search: [['Observation', 'subject']], scope: ['Observation'] },
      run: async (ctx) => {
        const p1 = await ctx.create(patient(ctx));
        const p2 = await ctx.create(patient(ctx));
        const o1 = await ctx.create(observation(ctx, p1.id));
        const o2 = await ctx.create(observation(ctx, p2.id));
        await finds(ctx, 'Observation', [['subject', `Patient/${p1.id}`]], [o1.id]);
        await finds(ctx, 'Observation', [['subject:Patient', p2.id]], [o2.id]);
      }
    },
    {
      name: 'quantity and token on an Observation',
      requires: { interactions: [...P(), ['Observation', 'create'], ['Observation', 'search-type']], search: [['Observation', 'value-quantity'], ['Observation', 'code']], scope: ['Observation'] },
      run: async (ctx) => {
        const p = await ctx.create(patient(ctx));
        const light = await ctx.create(observation(ctx, p.id, { valueQuantity: { value: 5.4, unit: 'kg', system: UCUM, code: 'kg' } }));
        const heavy = await ctx.create(observation(ctx, p.id, { valueQuantity: { value: 80, unit: 'kg', system: UCUM, code: 'kg' } }));
        await finds(ctx, 'Observation', [['value-quantity', `5.4|${UCUM}|kg`]], [light.id]);
        await finds(ctx, 'Observation', [['value-quantity', `gt10|${UCUM}|kg`]], [heavy.id]);
        await finds(ctx, 'Observation', [['value-quantity', 'lt10']], [light.id]);
        await finds(ctx, 'Observation', [['code', `${LOINC}|29463-7`]], [light.id, heavy.id]);
        await finds(ctx, 'Observation', [['code', `${LOINC}|8302-2`]], []);
      }
    },
    {
      name: '_id and _lastUpdated',
      requires: { interactions: P(), search: [['Patient', '_id'], ['Patient', '_lastUpdated']], scope: ['Patient'] },
      run: async (ctx) => {
        const a = await ctx.create(patient(ctx));
        const b = await ctx.create(patient(ctx));
        await finds(ctx, 'Patient', [['_id', a.id]], [a.id]);
        await finds(ctx, 'Patient', [['_id', `${a.id},${b.id}`]], [a.id, b.id]);
        const since = before(a.resource);
        const recent = await ctx.search('Patient', [['_lastUpdated', `ge${since}`], ['_id', `${a.id},${b.id}`]]);
        ctx.must(same(recent.ids, [a.id, b.id]), `_lastUpdated=ge${since} found ${show(recent.ids)}`);
        await finds(ctx, 'Patient', [['_lastUpdated', 'lt2000-01-01'], ['_id', `${a.id},${b.id}`]], []);
      }
    },
    {
      name: 'Several values (OR) and repeated parameters (AND)',
      requires: { interactions: P(), search: [['Patient', 'family'], ['Patient', 'gender']], scope: ['Patient'] },
      run: async (ctx) => {
        const word = uniqueWord();
        const a = await ctx.create(patient(ctx, { name: [{ family: word + 'one' }], gender: 'female' }));
        const b = await ctx.create(patient(ctx, { name: [{ family: word + 'two' }], gender: 'male' }));
        await ctx.create(patient(ctx, { name: [{ family: word + 'three' }], gender: 'female' }));
        await finds(ctx, 'Patient', [['family', `${word}one,${word}two`]], [a.id, b.id]);
        await finds(ctx, 'Patient', [['family', word], ['gender', 'male']], [b.id]);
      }
    },
    {
      name: 'Nothing found: an empty Bundle',
      requires: { interactions: P(), search: [['Patient', 'family']], scope: ['Patient'] },
      run: async (ctx) => {
        const { bundle, ids } = await ctx.search('Patient', [['family', uniqueWord()]]);
        ctx.must(ids.length === 0, `A search for a name no one has found ${show(ids)}`);
        ctx.should(bundle.total === undefined || bundle.total === 0, `A search that found nothing has total ${bundle.total}`);
      }
    },
    {
      name: 'A deleted resource isn\'t found',
      requires: { interactions: [...P(), ['Patient', 'delete']], search: [['Patient', 'family']], scope: ['Patient'] },
      run: async (ctx) => {
        const made = await ctx.create(patient(ctx));
        ctx.status(await ctx.client.delete(`Patient/${made.id}`), [200, 202, 204], 'delete');
        await finds(ctx, 'Patient', [['family', family(made.resource)]], []);
      }
    },
    {
      name: 'Searching with POST [type]/_search',
      requires: { interactions: P(), search: [['Patient', 'family']], scope: ['Patient'] },
      run: async (ctx) => {
        const made = await ctx.create(patient(ctx));
        const { ids } = await ctx.search('Patient', [['family', family(made.resource)]], { post: true });
        ctx.must(same(ids, [made.id]), `POST [base]/Patient/_search found ${show(ids)}, not ${made.id}`);
      }
    },
    {
      name: 'Paging: every match once, through the next links',
      requires: { interactions: P(), search: [['Patient', 'family']], scope: ['Patient'] },
      run: async (ctx) => {
        const word = uniqueWord();
        const made = [];
        for (let i = 0; i < 5; i++) {
          made.push((await ctx.create(patient(ctx, { name: [{ family: word + 'abcde'[i] }] }))).id);
        }
        const first = await ctx.search('Patient', [['family', word], ['_count', '2']]);
        ctx.must(first.ids.length <= 2, `_count=2: the first page has ${first.ids.length} matches`);
        ctx.should(first.bundle.total === undefined || first.bundle.total === 5, `The Bundle's total is ${first.bundle.total}, not 5`);
        const { ids, pages } = await ctx.allPages(first.bundle, 'Patient', 'paging');
        ctx.must(pages.length >= 3, `_count=2 over 5 matches gave ${pages.length} page(s)`);
        ctx.must(ids.length === 5 && same(ids, made), `Paging found ${show(ids)}, not each of ${show(made)} once`);
        ctx.should((first.bundle.link || []).some(l => l.relation === 'self'), 'The search Bundle has no self link');
      }
    },
    {
      name: '_include and _revinclude',
      requires: { interactions: [...P(), ['Observation', 'create'], ['Observation', 'search-type']], search: [['Observation', 'subject'], ['Patient', '_id']],
        scope: ['Observation', 'Patient'],
        check: (cap) => (cap.searchInclude('Observation').some(i => i === '*' || i === 'Observation:subject') ? null : 'The CapabilityStatement doesn\'t list _include=Observation:subject') },
      run: async (ctx) => {
        const p = await ctx.create(patient(ctx));
        const o = await ctx.create(observation(ctx, p.id));
        const inc = await ctx.search('Observation', [['subject', `Patient/${p.id}`], ['_include', 'Observation:subject']]);
        ctx.must(same(inc.ids, [o.id]), `The matches are ${show(inc.ids)}`);
        const included = (inc.bundle.entry || []).find(e => e.resource && e.resource.resourceType === 'Patient' && e.resource.id === p.id);
        ctx.must(included, '_include=Observation:subject didn\'t include the Patient');
        ctx.should(included.search && included.search.mode === 'include', `The included Patient's search.mode is ${included.search && included.search.mode}, not include`);
        if (ctx.cap.searchRevInclude('Patient').some(i => i === '*' || i === 'Observation:subject')) {
          const rev = await ctx.search('Patient', [['_id', p.id], ['_revinclude', 'Observation:subject']]);
          ctx.must(same(rev.ids, [p.id]), `The matches are ${show(rev.ids)}`);
          ctx.must((rev.bundle.entry || []).some(e => e.resource && e.resource.resourceType === 'Observation' && e.resource.id === o.id),
            '_revinclude=Observation:subject didn\'t include the Observation');
        }
      }
    },
    {
      name: '_has',
      requires: { interactions: [...P(), ['Observation', 'create']], search: [['Patient', '_has'], ['Observation', 'code']], scope: ['Patient'] },
      run: async (ctx) => {
        const p = await ctx.create(patient(ctx));
        const other = await ctx.create(patient(ctx));
        const code = 'tester-' + uniqueWord().toLowerCase();
        await ctx.create(observation(ctx, p.id, { code: { coding: [{ system: 'http://example.org/tester', code }] } }));
        await finds(ctx, 'Patient', [['_has:Observation:subject:code', `http://example.org/tester|${code}`], ['_id', `${p.id},${other.id}`]], [p.id]);
      }
    },
    {
      name: '_summary=count and _elements',
      requires: { interactions: P(), search: [['Patient', 'family']], scope: ['Patient'] },
      run: async (ctx) => {
        const word = uniqueWord();
        await ctx.create(patient(ctx, { name: [{ family: word + 'a' }] }));
        await ctx.create(patient(ctx, { name: [{ family: word + 'b' }] }));
        const count = await ctx.search('Patient', [['family', word], ['_summary', 'count']]);
        ctx.should(count.bundle.total === 2, `_summary=count: total is ${count.bundle.total}, not 2`);
        ctx.should(!(count.bundle.entry || []).some(e => e.resource && e.resource.resourceType === 'Patient'), '_summary=count returned the Patients');
        const els = await ctx.search('Patient', [['family', word], ['_elements', 'gender']]);
        const r = (els.bundle.entry || []).map(e => e.resource).filter(x => x && x.resourceType === 'Patient');
        ctx.should(r.length === 2 && r.every(x => x.gender && !x.name), '_elements=gender: the Patients have more than gender (or not gender)');
        ctx.should(r.every(x => x.meta && (x.meta.tag || []).some(t => t.code === 'SUBSETTED')), '_elements: the Patients aren\'t tagged SUBSETTED');
      }
    },
    {
      name: '_filter',
      requires: { interactions: P(), search: [['Patient', 'family'], ['Patient', 'gender']], scope: ['Patient'] },
      run: async (ctx) => {
        // _filter is optional: refused, it isn't supported; done, it must be right
        const word = uniqueWord();
        const a = await ctx.create(patient(ctx, { name: [{ family: word + 'a' }], gender: 'female' }));
        const b = await ctx.create(patient(ctx, { name: [{ family: word + 'b' }], gender: 'male' }));
        const c = await ctx.create(patient(ctx, { name: [{ family: word + 'c' }], gender: 'female', birthDate: '1990-06-01' }));
        const f = (expr, expected) => ctx.optional('Patient', [['_filter', expr]], expected, { feature: '_filter', what: `_filter=${expr}` });
        if (!await f(`family eq ${word}a`, [a.id])) {
          return;
        }
        await f(`family sw ${word} and gender eq female`, [a.id, c.id]);
        await f(`family eq ${word}a or family eq ${word}b`, [a.id, b.id]);
        await f(`family sw ${word} and not (gender eq female)`, [b.id]);
        await f(`family sw ${word} and birthdate ge 1990-01-01`, [c.id]);
      }
    },
    {
      name: 'The self link: the search as the server did it',
      requires: { interactions: P(), search: [['Patient', 'family']], scope: ['Patient'] },
      run: async (ctx) => {
        const word = uniqueWord();
        const a = await ctx.create(patient(ctx, { name: [{ family: word + 'a' }] }));
        const b = await ctx.create(patient(ctx, { name: [{ family: word + 'b' }] }));
        const first = await ctx.search('Patient', [['family', word]]);
        const self = (first.bundle.link || []).find(l => l.relation === 'self');
        ctx.must(self && self.url, 'The search Bundle has no self link');
        ctx.should(/[?&]family=/.test(decodeURIComponent(self.url)) || /_getpages|_page|page=/.test(self.url),
          `The self link (${self.url}) doesn't show the family parameter the search used`);
        const again = ctx.body(ctx.status(await ctx.client.get(self.url), 200, 'Following the self link'), 'Bundle', 'the self link');
        const ids = ctx.matches(again, 'Patient');
        ctx.must(same(ids, [a.id, b.id]), `Following the self link found ${show(ids)}, not ${show([a.id, b.id])}`);
        // a parameter the server didn't use isn't in the self link
        const scope = ctx.scope('Patient').map(([n, v]) => `&${n}=${encodeURIComponent(v)}`).join('');
        const lenient = await ctx.client.get(`Patient?family=${encodeURIComponent(word)}&tester-not-a-parameter=x${scope}`, { headers: { Prefer: 'handling=lenient' } });
        if (lenient.status === 200) {
          const link = (ctx.body(lenient, 'Bundle', 'the search').link || []).find(l => l.relation === 'self');
          ctx.should(link && !/tester-not-a-parameter/.test(link.url), `The self link (${link ? link.url : 'none'}) has the parameter the server ignored: it should show the search as the server did it`);
        }
      }
    },
    {
      name: 'Unknown parameters: ignored, or refused when strict',
      requires: { interactions: P(), search: [['Patient', 'family']], scope: ['Patient'] },
      run: async (ctx) => {
        // servers SHOULD ignore unknown parameters, and SHOULD honour Prefer: handling=strict (or lenient)
        const made = await ctx.create(patient(ctx));
        const scope = ctx.scope('Patient').map(([n, v]) => `&${n}=${encodeURIComponent(v)}`).join('');
        const query = `Patient?family=${encodeURIComponent(family(made.resource))}&not-a-parameter=x${scope}`;
        const plain = await ctx.client.get(query);
        ctx.must(plain.status === 200 || (plain.status >= 400 && plain.status < 500), `An unknown parameter: ${plain.status}`);
        if (ctx.should(plain.status === 200, `An unknown parameter was refused (${plain.status}): servers SHOULD ignore them`)) {
          const ids = ctx.matches(ctx.body(plain, 'Bundle', 'the search'), 'Patient');
          ctx.must(same(ids, [made.id]), `With an unknown parameter, the search found ${show(ids)}`);
        }
        const lenient = await ctx.client.get(query, { headers: { Prefer: 'handling=lenient' } });
        ctx.should(lenient.status === 200, `With Prefer: handling=lenient, an unknown parameter: ${lenient.status}, not 200`);
        const strict = await ctx.client.get(query, { headers: { Prefer: 'handling=strict' } });
        ctx.should(strict.status === 400, `With Prefer: handling=strict, an unknown parameter: ${strict.status}, not 400`);
      }
    }
  ]
};
