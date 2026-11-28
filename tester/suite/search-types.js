//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// search: the forms of each parameter type's values, the prefixes, and modifiers. What every
// server must do (the parameter types' own values: SHALL) is ctx.search and must; what it
// needn't (modifiers, the rarer prefixes) is ctx.optional: refused, it isn't supported, and
// done, it must be right

const { patient, observation, uniqueWord, UCUM, LOINC } = require('./common');

const same = (a, b) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
const show = (ids) => ids.length ? ids.join(', ') : 'nothing';

async function finds(ctx, type, params, expected) {
  const { ids } = await ctx.search(type, params);
  ctx.must(same(ids, expected), `${type}?${params.map(([n, v]) => `${n}=${v}`).join('&')} found ${show(ids)}, not ${show(expected)}`);
}

const PATIENTS = [['Patient', 'search-type'], ['Patient', 'create']];
const OBSERVATIONS = [['Observation', 'search-type'], ['Observation', 'create'], ['Patient', 'create']];
const V2_0203 = 'http://terminology.hl7.org/CodeSystem/v2-0203';
const GENDER_VS = 'http://hl7.org/fhir/ValueSet/administrative-gender';
// code systems with a hierarchy (top > middle > bottom), that most servers know: v3 ActCode
// (R4's core, and terminology.hl7.org), and FHIR's own types (R5 on)
const HIERARCHIES = [
  { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', codes: ['_ActEncounterCode', 'IMP', 'ACUTE'] },
  { system: 'http://hl7.org/fhir/fhir-types', codes: ['Resource', 'DomainResource', 'Patient'] }
];
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * :below the middle code, and :above the bottom one, of a hierarchy, with Observations coded
 * top, middle and bottom (ids in made). A server may relate new codes a little after they're
 * indexed: a few tries. 'unknown': the server found only the code itself, both times (it
 * doesn't seem to know the hierarchy); 'refused': it refused the modifiers; 'done': checked
 * (finding what isn't related fails; finding only some of what is, is a warning)
 */
async function subsumption(ctx, h, made) {
  const [top, middle, bottom] = made;
  const checks = [['code:below', h.codes[1], [middle, bottom], middle], ['code:above', h.codes[2], [top, middle, bottom], bottom]];
  const found = [];
  for (const [param, code, expected] of checks) {
    const value = `${h.system}|${code}`;
    let ids = null;
    for (let i = 0; i < 6; i++) {
      const res = await ctx.client.get(`Observation?${[[param, value], ...ctx.scope('Observation')].map(([n, v]) => `${n}=${encodeURIComponent(v)}`).join('&')}`);
      if ([400, 404, 405, 422, 501].includes(res.status)) {
        ctx.unsupported.push(`${param} (${res.status})`);
        return 'refused';
      }
      ids = ctx.matches(ctx.body(ctx.status(res, 200, `${param}=${value}`), 'Bundle', 'the search'), 'Observation');
      if (same(ids, expected)) {
        break;
      }
      await sleep(2500);
    }
    found.push(ids);
  }
  // only the code itself, both times: the hierarchy isn't known
  if (same(found[0], [middle]) && same(found[1], [bottom])) {
    return 'unknown';
  }
  ctx.optionalRan++;
  checks.forEach(([param, code, expected], i) => {
    const ids = found[i];
    const extra = ids.filter(id => !expected.includes(id));
    ctx.must(!extra.length, `Observation?${param}=${h.system}|${code} found ${show(extra)}, which ${extra.length === 1 ? 'isn\'t' : 'aren\'t'} ${param === 'code:below' ? 'below' : 'above'} it (all it found: ${show(ids)})`);
    ctx.should(same(ids, expected), `Observation?${param}=${h.system}|${code} found ${show(ids)}, not all of ${show(expected)}`);
  });
  return 'done';
}

module.exports = {
  name: 'Search: parameter types',
  tests: [
    {
      name: 'string: name finds family and given names; given',
      requires: { interactions: PATIENTS, search: [['Patient', 'name'], ['Patient', 'given']], scope: ['Patient'] },
      run: async (ctx) => {
        const word = uniqueWord();
        const a = await ctx.create(patient(ctx, { name: [{ family: word + 'fam', given: ['Anne'] }] }));
        const b = await ctx.create(patient(ctx, { name: [{ family: 'Smith', given: [word + 'giv', 'Mary'] }] }));
        await finds(ctx, 'Patient', [['name', word]], [a.id, b.id]);
        await finds(ctx, 'Patient', [['name', word + 'g']], [b.id]);
        await finds(ctx, 'Patient', [['given', word]], [b.id]);
      }
    },
    {
      name: 'string: an address, by any part, and by city',
      requires: { interactions: PATIENTS, search: [['Patient', 'address'], ['Patient', 'address-city']], scope: ['Patient'] },
      run: async (ctx) => {
        const word = uniqueWord();
        const a = await ctx.create(patient(ctx, { address: [{ line: ['1 Main St'], city: word + 'ville', postalCode: '3000', country: 'AU' }] }));
        const b = await ctx.create(patient(ctx, { address: [{ line: [word + ' Road'], city: 'Elsewhere' }] }));
        await finds(ctx, 'Patient', [['address-city', word]], [a.id]);
        await finds(ctx, 'Patient', [['address', word]], [a.id, b.id]);
      }
    },
    {
      name: 'token: a boolean',
      requires: { interactions: PATIENTS, search: [['Patient', 'active']], scope: ['Patient'] },
      run: async (ctx) => {
        const a = await ctx.create(patient(ctx, { active: true }));
        const b = await ctx.create(patient(ctx, { active: false }));
        await finds(ctx, 'Patient', [['active', 'true']], [a.id]);
        await finds(ctx, 'Patient', [['active', 'false']], [b.id]);
      }
    },
    {
      name: 'token: system|, |code (no system), and a ContactPoint',
      requires: { interactions: PATIENTS, search: [['Patient', 'identifier'], ['Patient', 'email']], scope: ['Patient'] },
      run: async (ctx) => {
        const word = uniqueWord().toLowerCase();
        const system = `http://example.org/tester/${word}`;
        const a = await ctx.create(patient(ctx, { identifier: [{ system, value: 'one' }], telecom: [{ system: 'email', value: `${word}@example.org` }] }));
        const b = await ctx.create(patient(ctx, { identifier: [{ system, value: 'two' }] }));
        const c = await ctx.create(patient(ctx, { identifier: [{ value: word }] }));
        await finds(ctx, 'Patient', [['identifier', `${system}|`]], [a.id, b.id]);
        await finds(ctx, 'Patient', [['identifier', `|${word}`]], [c.id]);
        await finds(ctx, 'Patient', [['identifier', word]], [c.id]);
        await finds(ctx, 'Patient', [['email', `${word}@example.org`]], [a.id]);
      }
    },
    {
      name: 'token: :text, :of-type and :missing',
      requires: { interactions: OBSERVATIONS, search: [['Observation', 'code'], ['Patient', 'identifier']], scope: ['Observation', 'Patient'] },
      run: async (ctx) => {
        const word = uniqueWord();
        const p = await ctx.create(patient(ctx, { identifier: [{ type: { coding: [{ system: V2_0203, code: 'MR' }] }, system: 'http://example.org/tester/mrn', value: word }] }));
        const q = await ctx.create(patient(ctx, { identifier: [] }));
        const o = await ctx.create(observation(ctx, p.id, { code: { coding: [{ system: LOINC, code: '29463-7', display: 'Body weight' }], text: `${word} weight` } }));
        await ctx.optional('Observation', [['code:text', word]], [o.id], { feature: 'code:text' });
        await ctx.optional('Patient', [['identifier:of-type', `${V2_0203}|MR|${word}`]], [p.id], { feature: 'identifier:of-type' });
        await ctx.optional('Patient', [['gender:missing', 'false']], [p.id, q.id], { feature: 'gender:missing' });
        await ctx.optional('Patient', [['gender:missing', 'true']], [], { feature: 'gender:missing' });
      }
    },
    {
      name: 'date: a dateTime, at each precision, and time zones',
      requires: { interactions: OBSERVATIONS, search: [['Observation', 'date']], scope: ['Observation'] },
      run: async (ctx) => {
        const p = await ctx.create(patient(ctx));
        const o = await ctx.create(observation(ctx, p.id, { effectiveDateTime: '2020-05-06T10:00:00Z' }));
        await finds(ctx, 'Observation', [['date', '2020']], [o.id]);
        await finds(ctx, 'Observation', [['date', '2020-05-06']], [o.id]);
        await finds(ctx, 'Observation', [['date', '2020-05-07']], []);
        await finds(ctx, 'Observation', [['date', '2020-05-06T10:00:00Z']], [o.id]);
        await finds(ctx, 'Observation', [['date', '2020-05-06T10:00:01Z']], []);
        await finds(ctx, 'Observation', [['date', '2020-05-06T20:00:00+10:00']], [o.id]);
        await finds(ctx, 'Observation', [['date', 'gt2020-05-06T09:59:59Z']], [o.id]);
        await finds(ctx, 'Observation', [['date', 'lt2020-05-06T10:00:00Z']], []);
        await finds(ctx, 'Observation', [['date', 'le2020-05-06T10:00:00Z']], [o.id]);
      }
    },
    {
      name: 'date: a Period',
      requires: { interactions: OBSERVATIONS, search: [['Observation', 'date']], scope: ['Observation'] },
      run: async (ctx) => {
        const p = await ctx.create(patient(ctx));
        const o = await ctx.create(observation(ctx, p.id, { effectiveDateTime: undefined, effectivePeriod: { start: '2020-01-01', end: '2020-01-31' } }));
        // eq: the search's range must contain the period
        await finds(ctx, 'Observation', [['date', '2020-01']], [o.id]);
        await finds(ctx, 'Observation', [['date', '2020-01-15']], []);
        // gt, lt, ge, le: the range above (or below) the search's overlaps the period
        await finds(ctx, 'Observation', [['date', 'ge2020-01-15']], [o.id]);
        await finds(ctx, 'Observation', [['date', 'lt2020-01-15']], [o.id]);
        await finds(ctx, 'Observation', [['date', 'gt2020-02-01']], []);
        await finds(ctx, 'Observation', [['date', 'lt2019-12-01']], []);
      }
    },
    {
      name: 'date: ne, sa, eb and ap',
      requires: { interactions: PATIENTS, search: [['Patient', 'birthdate']], scope: ['Patient'] },
      run: async (ctx) => {
        const a = await ctx.create(patient(ctx, { birthDate: '1970-03-04' }));
        const b = await ctx.create(patient(ctx, { birthDate: '1985-11-20' }));
        await ctx.optional('Patient', [['birthdate', 'ne1970-03-04']], [b.id], { feature: 'the ne prefix' });
        await ctx.optional('Patient', [['birthdate', 'sa1980']], [b.id], { feature: 'the sa prefix' });
        await ctx.optional('Patient', [['birthdate', 'eb1980']], [a.id], { feature: 'the eb prefix' });
        await ctx.optional('Patient', [['birthdate', 'ap1970-03-04']], [a.id], { feature: 'the ap prefix', level: 'should' });
      }
    },
    {
      name: 'quantity: number alone, code alone, and the precision of the value',
      requires: { interactions: OBSERVATIONS, search: [['Observation', 'value-quantity']], scope: ['Observation'] },
      run: async (ctx) => {
        const p = await ctx.create(patient(ctx));
        const o = await ctx.create(observation(ctx, p.id, { valueQuantity: { value: 72.5, unit: 'kg', system: UCUM, code: 'kg' } }));
        await finds(ctx, 'Observation', [['value-quantity', '72.5']], [o.id]);
        await finds(ctx, 'Observation', [['value-quantity', '72.5||kg']], [o.id]);
        await finds(ctx, 'Observation', [['value-quantity', `72.5|${UCUM}|g`]], []);
        // 72.4 is 72.35 to 72.45: not 72.5
        await finds(ctx, 'Observation', [['value-quantity', '72.4']], []);
        await finds(ctx, 'Observation', [['value-quantity', 'ge72.5']], [o.id]);
        await finds(ctx, 'Observation', [['value-quantity', 'gt72.5']], []);
        await ctx.optional('Observation', [['value-quantity', 'ne72.5']], [], { feature: 'the ne prefix on a quantity' });
        // the same, in grams: a server SHOULD compare UCUM units by their canonical form
        await ctx.optional('Observation', [['value-quantity', `72500|${UCUM}|g`]], [o.id], { feature: 'UCUM unit conversion', level: 'should' });
      }
    },
    {
      name: 'composite: code and value together',
      requires: { interactions: OBSERVATIONS, search: [['Observation', 'code-value-quantity']], scope: ['Observation'] },
      run: async (ctx) => {
        const p = await ctx.create(patient(ctx));
        const weight = await ctx.create(observation(ctx, p.id, { valueQuantity: { value: 72.5, unit: 'kg', system: UCUM, code: 'kg' } }));
        await ctx.create(observation(ctx, p.id, { code: { coding: [{ system: LOINC, code: '8302-2', display: 'Body height' }] }, valueQuantity: { value: 72.5, unit: 'cm', system: UCUM, code: 'cm' } }));
        await finds(ctx, 'Observation', [['code-value-quantity', `${LOINC}|29463-7$72.5|${UCUM}|kg`]], [weight.id]);
        await finds(ctx, 'Observation', [['code-value-quantity', `${LOINC}|29463-7$gt100`]], []);
      }
    },
    {
      name: 'string: :missing',
      requires: { interactions: PATIENTS, search: [['Patient', 'family'], ['Patient', 'birthdate']], scope: ['Patient'] },
      run: async (ctx) => {
        const named = await ctx.create(patient(ctx));
        const nameless = await ctx.create(patient(ctx, { name: undefined, birthDate: undefined }));
        await ctx.optional('Patient', [['family:missing', 'true']], [nameless.id], { feature: 'family:missing' });
        await ctx.optional('Patient', [['family:missing', 'false']], [named.id], { feature: 'family:missing' });
        await ctx.optional('Patient', [['birthdate:missing', 'true']], [nameless.id], { feature: 'birthdate:missing' });
      }
    },
    {
      name: 'token: :in and :not-in a value set',
      requires: { interactions: PATIENTS, search: [['Patient', 'family'], ['Patient', 'gender']], scope: ['Patient'] },
      run: async (ctx) => {
        // the value set every server knows: administrative-gender (male, female, other, unknown)
        const word = uniqueWord();
        const f = await ctx.create(patient(ctx, { name: [{ family: word + 'f' }], gender: 'female' }));
        const m = await ctx.create(patient(ctx, { name: [{ family: word + 'm' }], gender: 'male' }));
        const none = await ctx.create(patient(ctx, { name: [{ family: word + 'n' }], gender: undefined }));
        if (!await ctx.optional('Patient', [['family', word], ['gender:in', GENDER_VS]], [f.id, m.id], { feature: 'gender:in' })) {
          return;
        }
        const out = await ctx.client.get(`Patient?family=${word}&gender:not-in=${encodeURIComponent(GENDER_VS)}&${ctx.scope('Patient').map(([n, v]) => `${n}=${encodeURIComponent(v)}`).join('&')}`);
        if ([400, 404, 422, 501].includes(out.status)) {
          ctx.unsupported.push(`gender:not-in (${out.status})`);
          return;
        }
        const ids = ctx.matches(ctx.body(ctx.status(out, 200, 'gender:not-in'), 'Bundle', 'gender:not-in'), 'Patient');
        ctx.must(!ids.includes(f.id) && !ids.includes(m.id), `gender:not-in=${GENDER_VS} found a Patient whose gender is in it (${show(ids)})`);
        ctx.should(same(ids, [none.id]), `gender:not-in=${GENDER_VS} found ${show(ids)}, not the Patient with no gender (${none.id})`);
      }
    },
    {
      name: 'uri: :below and :above',
      requires: { interactions: [['ValueSet', 'create'], ['ValueSet', 'search-type']], search: [['ValueSet', 'url']], scope: ['ValueSet'] },
      run: async (ctx) => {
        const base = `http://example.org/tester/${uniqueWord()}`;
        const vs = (url) => ctx.create(ctx.resource('ValueSet', { url, name: 'TesterValueSet', status: 'draft' }));
        const a = await vs(`${base}/a`);
        const ab = await vs(`${base}/a/b`);
        const c = await vs(`${base}/c`);
        await finds(ctx, 'ValueSet', [['url', `${base}/a`]], [a.id]);
        await ctx.optional('ValueSet', [['url:below', `${base}/a`]], [a.id, ab.id], { feature: 'url:below' });
        await ctx.optional('ValueSet', [['url:below', base]], [a.id, ab.id, c.id], { feature: 'url:below' });
        await ctx.optional('ValueSet', [['url:above', `${base}/a/b/x`]], [a.id, ab.id], { feature: 'url:above' });
      }
    },
    {
      name: 'token: :below and :above in a hierarchy',
      requires: { interactions: OBSERVATIONS, search: [['Observation', 'code']], scope: ['Observation'] },
      run: async (ctx) => {
        // the server needs to know the code system's hierarchy (from a terminology server).
        // Code systems most servers know, tried in turn: one the server finds only the code
        // itself in doesn't seem to be known to it, and the next is tried
        const p = await ctx.create(patient(ctx));
        const unknown = [];
        for (const h of HIERARCHIES) {
          const coded = (code) => ctx.create(observation(ctx, p.id, { code: { coding: [{ system: h.system, code }] } }));
          const made = [];
          for (const code of h.codes) {
            made.push((await coded(code)).id);
          }
          const outcome = await subsumption(ctx, h, made);
          if (outcome !== 'unknown') {
            return;
          }
          unknown.push(h.system);
        }
        ctx.unsupported.push(`token :below and :above (the server found only the code itself, for ${unknown.join(' and ')}: it doesn't seem to know their hierarchies)`);
      }
    },
    {
      name: '_text and _content',
      requires: { interactions: PATIENTS, check: (cap) => cap.searchParam('Patient', '_text') || cap.searchParam('Patient', '_content') ? null : 'The CapabilityStatement lists neither _text nor _content for Patient' },
      run: async (ctx) => {
        const word = uniqueWord();
        const a = await ctx.create(patient(ctx, { text: { status: 'generated', div: `<div xmlns="http://www.w3.org/1999/xhtml">A note about ${word}</div>` } }));
        const b = await ctx.create(patient(ctx, { name: [{ family: word + 'x' }] }));
        if (ctx.cap.searchParam('Patient', '_text')) {
          await ctx.optional('Patient', [['_text', word]], [a.id], { feature: '_text', level: 'should' });
        }
        if (ctx.cap.searchParam('Patient', '_content')) {
          await ctx.optional('Patient', [['_content', word]], [a.id, b.id], { feature: '_content', level: 'should' });
        }
      }
    }
  ]
};
