//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// HTTP: mime types, _format, _pretty, _summary and _elements on a read, ids that aren't FHIR
// ids, the X-Provenance header, and asynchronous requests (Prefer: respond-async)

const { patient, uniqueWord } = require('./common');

const P = [['Patient', 'create'], ['Patient', 'read']];
const REFUSED = [400, 404, 405, 409, 422, 501];

const subsetted = (r) => !!(r && r.meta && (r.meta.tag || []).some(t => t.code === 'SUBSETTED'));
const mime = (res) => String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

module.exports = {
  name: 'HTTP: headers, formats and ids',
  tests: [
    {
      name: 'Mime types: Accept, and the Content-Type of what is sent',
      requires: { interactions: P },
      run: async (ctx) => {
        const made = await ctx.create(patient(ctx));
        const url = `Patient/${made.id}`;
        const fhir = ctx.status(await ctx.client.get(url, { accept: 'application/fhir+json' }), 200, 'Accept: application/fhir+json');
        ctx.must(mime(fhir) === 'application/fhir+json', `Accept: application/fhir+json: the answer's Content-Type is ${fhir.headers['content-type'] || 'missing'}, not application/fhir+json`);
        ctx.should(/charset\s*=\s*utf-8/i.test(fhir.headers['content-type'] || ''), `The Content-Type (${fhir.headers['content-type']}) doesn't say charset=utf-8`);
        const json = await ctx.client.get(url, { accept: 'application/json' });
        ctx.should(json.status === 200 && json.resource && json.resource.id === made.id, `Accept: application/json: the answer is ${json.status}, not the Patient in JSON`);
        ctx.should(json.status !== 200 || mime(json) === 'application/json', `Accept: application/json: the answer's Content-Type is ${json.headers['content-type']}, not the type asked for (application/json)`);
        const version = String(ctx.cap.fhirVersion || '').split('.').slice(0, 2).join('.');
        const versioned = await ctx.client.get(url, { accept: `application/fhir+json; fhirVersion=${version}` });
        ctx.should(versioned.status === 200 && versioned.format === 'json', `Accept: application/fhir+json; fhirVersion=${version} (the server's own version): the answer is ${versioned.status} ${versioned.headers['content-type'] || ''}`);
        const any = await ctx.client.get(url, { accept: '*/*' });
        ctx.should(any.status === 200 && any.format, `Accept: */*: the answer is ${any.status} ${any.headers['content-type'] || ''}, not the Patient in a FHIR format`);
        const odd = await ctx.client.get(url, { accept: 'application/x-tester-no-such-format' });
        ctx.should(odd.status === 406, `Accept: application/x-tester-no-such-format: the answer is ${odd.status}, not 406 (Not Acceptable is the appropriate response to a format the server doesn't support)`);
        const posted = await ctx.client.post('Patient', JSON.stringify(patient(ctx)), { contentType: 'application/json' });
        if (posted.status === 201) {
          const id = (posted.resource && posted.resource.id) || (/Patient\/([A-Za-z0-9\-.]{1,64})/.exec(posted.headers.location || '') || [])[1];
          ctx.created('Patient', id);
        }
        ctx.should(posted.status === 201, `POST with Content-Type: application/json: the answer is ${posted.status}, not 201`);
      }
    },
    {
      name: 'A read with _format, _pretty, _summary and _elements',
      requires: { interactions: P },
      run: async (ctx) => {
        const made = await ctx.create(patient(ctx, { communication: [{ language: { text: 'English' } }] }));
        const url = `Patient/${made.id}`;
        if (ctx.cap.format('xml')) {
          const json = ctx.status(await ctx.client.get(`${url}?_format=json`, { accept: 'application/fhir+xml' }), 200, `GET ${url}?_format=json`);
          ctx.should(json.format === 'json', `GET ${url}?_format=json, with Accept: application/fhir+xml: the answer is ${json.headers['content-type']}, not JSON (_format overrides Accept)`);
        }
        const mimeFormat = ctx.status(await ctx.client.get(`${url}?_format=${encodeURIComponent('application/fhir+json')}`), 200, `GET ${url}?_format=application/fhir+json`);
        ctx.should(mimeFormat.format === 'json', `_format=application/fhir+json: the answer is ${mimeFormat.headers['content-type']}`);
        const pretty = ctx.status(await ctx.client.get(`${url}?_pretty=true`), 200, `GET ${url}?_pretty=true`);
        ctx.body(pretty, 'Patient', '_pretty=true');
        if (!/\n\s+"/.test(pretty.text)) {
          ctx.note('_pretty=true isn\'t indented: the server doesn\'t do _pretty (a server may not)');
        }
        const summary = await ctx.client.get(`${url}?_summary=true`);
        if (REFUSED.includes(summary.status)) {
          ctx.unsupported.push(`_summary on a read (${summary.status})`);
        } else {
          ctx.optionalRan++;
          const r = ctx.body(ctx.status(summary, 200, `GET ${url}?_summary=true`), 'Patient', '_summary=true');
          ctx.must(r.id === made.id, `_summary=true: the Patient's id is ${r.id}`);
          ctx.should(!r.communication, '_summary=true: the Patient still has communication, which isn\'t a summary element');
          ctx.should(r.name, '_summary=true: the Patient has lost its name, which is a summary element');
          ctx.should(subsetted(r), '_summary=true: the Patient isn\'t tagged SUBSETTED');
        }
        const elements = await ctx.client.get(`${url}?_elements=gender`);
        if (REFUSED.includes(elements.status)) {
          ctx.unsupported.push(`_elements on a read (${elements.status})`);
        } else {
          ctx.optionalRan++;
          const r = ctx.body(ctx.status(elements, 200, `GET ${url}?_elements=gender`), 'Patient', '_elements=gender');
          ctx.should(r.gender && !r.name && !r.communication, '_elements=gender: the Patient has more than gender (or not gender)');
          ctx.should(subsetted(r), '_elements: the Patient isn\'t tagged SUBSETTED');
        }
      }
    },
    {
      name: 'Ids that aren\'t FHIR ids are refused',
      requires: { interactions: [['Patient', 'read']] },
      run: async (ctx) => {
        // ids are [A-Za-z0-9\-.]{1,64}
        const bad = [['an id with a $', 'tester$bad'], ['an id with an _', 'tester_bad'], ['an id of 65 characters', 'a'.repeat(65)]];
        for (const [what, id] of bad) {
          const res = await ctx.client.get(`Patient/${encodeURIComponent(id)}`);
          ctx.must(res.status >= 400 && res.status < 500, `GET [base]/Patient/${id} (${what}): the answer is ${res.status}, not 400 or 404`);
          ctx.should(res.status === 400 || res.status === 404, `GET [base]/Patient/${id} (${what}): the answer is ${res.status}, not 400 (or 404)`);
        }
        if (ctx.cap.interaction('Patient', 'update')) {
          for (const [what, id] of bad) {
            const res = await ctx.client.put(`Patient/${encodeURIComponent(id)}`, { ...patient(ctx), id });
            if (res.status === 200 || res.status === 201) {
              ctx.created('Patient', id);
            }
            ctx.must(res.status >= 400 && res.status < 500, `PUT [base]/Patient/${id} (${what}): the answer is ${res.status}, not 400`);
          }
        }
      }
    },
    {
      name: 'X-Provenance: a Provenance written with the resource',
      requires: { interactions: [['Patient', 'create'], ['Provenance', 'search-type']], search: [['Provenance', 'target']] },
      run: async (ctx) => {
        const agent = `FHIRsmith tester ${uniqueWord()}`;
        const provenance = ctx.resource('Provenance', {
          recorded: new Date().toISOString(),
          agent: [{ who: { display: agent } }]
        });
        const res = await ctx.client.post('Patient', patient(ctx), { headers: { 'X-Provenance': JSON.stringify(provenance) } });
        if (REFUSED.includes(res.status) || res.status === 415) {
          ctx.unsupported.push(`X-Provenance (${res.status})`);
          return;
        }
        ctx.status(res, 201, 'POST [base]/Patient with X-Provenance');
        const id = (res.resource && res.resource.id) || (/Patient\/([A-Za-z0-9\-.]{1,64})/.exec(res.headers.location || '') || [])[1];
        ctx.must(id, 'POST [base]/Patient: no id in the Location header or the body');
        ctx.created('Patient', id);
        const found = ctx.status(await ctx.client.get(`Provenance?target=${encodeURIComponent(`Patient/${id}`)}`), 200, `Provenance?target=Patient/${id}`);
        const list = (ctx.body(found, 'Bundle', 'the search').entry || []).map(e => e.resource).filter(r => r && r.resourceType === 'Provenance');
        for (const p of list) {
          ctx.created('Provenance', p.id);
        }
        if (!list.length) {
          ctx.unsupported.push('X-Provenance (the server took the Patient, but no Provenance targets it: it seems to have ignored the header)');
          return;
        }
        ctx.optionalRan++;
        const ours = list.find(p => (p.agent || []).some(a => a.who && a.who.display === agent));
        ctx.must(ours, `There is a Provenance for Patient/${id}, but not the one in the X-Provenance header (agent ${agent})`);
        ctx.should((ours.target || []).some(t => new RegExp(`(^|/)Patient/${id}/_history/[^/]+$`).test(String(t.reference || ''))),
          `The Provenance's target is ${(ours.target || []).map(t => t.reference).join(', ') || 'nothing'}, not the version written (Patient/${id}/_history/[vid])`);
      }
    },
    {
      name: 'Async: a search with Prefer: respond-async',
      requires: { interactions: [['Patient', 'create'], ['Patient', 'search-type']], search: [['Patient', 'family']], scope: ['Patient'] },
      run: async (ctx) => {
        const made = await ctx.create(patient(ctx));
        const word = made.resource.name[0].family;
        const scope = ctx.scope('Patient');
        const query = [['family', word], ...scope].map(([n, v]) => `${n}=${encodeURIComponent(v)}`).join('&');
        const kick = await ctx.client.get(`Patient?${query}`, { headers: { Prefer: 'respond-async' } });
        if (kick.status === 200) {
          ctx.unsupported.push('Prefer: respond-async (the server answered at once, as it may)');
          return;
        }
        if (REFUSED.includes(kick.status)) {
          ctx.unsupported.push(`Prefer: respond-async (${kick.status})`);
          return;
        }
        ctx.optionalRan++;
        ctx.status(kick, 202, 'A search with Prefer: respond-async');
        const where = kick.headers['content-location'];
        ctx.must(where, 'The 202 has no Content-Location: where the answer will be');
        let res = null;
        const deadline = Date.now() + 60000;
        for (let wait = 250; Date.now() < deadline; wait = Math.min(wait * 2, 4000)) {
          await sleep(wait);
          res = await ctx.client.get(where);
          if (res.status !== 202) {
            break;
          }
        }
        ctx.must(res && res.status === 200, `The async answer (${where}) is ${res ? res.status : 'nothing'}, not 200 (after a minute)`);
        const bundle = ctx.body(res, 'Bundle', 'The async answer');
        let searchset = bundle;
        if (bundle.type === 'batch-response') {
          const e = (bundle.entry || [])[0] || {};
          ctx.must(e.response && /^200/.test(String(e.response.status || '')), `The async answer's entry is ${e.response ? e.response.status : 'missing'}, not 200`);
          searchset = e.resource;
        } else {
          ctx.should(false, `The async answer is a ${bundle.type} Bundle, not a batch-response with the search's own answer in it`);
        }
        ctx.must(searchset && searchset.resourceType === 'Bundle', 'The async answer has no search Bundle in it');
        ctx.must(ctx.matches(searchset, 'Patient').includes(made.id), `The async search didn't find Patient/${made.id}`);
      }
    }
  ]
};
