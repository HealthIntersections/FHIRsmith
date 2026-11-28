//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// What a server does with requests it can't do

const { patient, isOutcome } = require('./common');

module.exports = {
  name: 'Errors',
  tests: [
    {
      name: 'A type the server doesn\'t have',
      run: async (ctx) => {
        const res = await ctx.client.get('NotAResourceType/1');
        ctx.must([400, 404].includes(res.status), `GET [base]/NotAResourceType/1: ${res.status}, not 404 (or 400)`);
        ctx.should(isOutcome(res), `GET [base]/NotAResourceType/1: the ${res.status} has no OperationOutcome`);
      }
    },
    {
      name: 'A body that isn\'t JSON is refused (400)',
      requires: { interactions: [['Patient', 'create']] },
      run: async (ctx) => {
        const res = await ctx.client.post('Patient', '{"resourceType": "Patient", "active": tru', { contentType: 'application/fhir+json' });
        if (res.status === 201) {
          ctx.fail('POST of broken JSON was accepted (201)');
        }
        ctx.must(res.status === 400, `POST of broken JSON: ${res.status}, not 400`);
        ctx.should(isOutcome(res), 'POST of broken JSON: the 400 has no OperationOutcome');
      }
    },
    {
      name: 'A resource of another type is refused',
      requires: { interactions: [['Patient', 'create']] },
      run: async (ctx) => {
        const res = await ctx.client.post('Patient', ctx.resource('Organization', { name: 'Not a patient' }));
        if (res.status === 201) {
          const m = /Organization\/([A-Za-z0-9\-.]{1,64})|Patient\/([A-Za-z0-9\-.]{1,64})/.exec(res.headers.location || '');
          if (m) {
            ctx.created(m[1] ? 'Organization' : 'Patient', m[1] || m[2]);
          }
        }
        ctx.must([400, 422].includes(res.status), `POST [base]/Patient of an Organization: ${res.status}, not 400 (or 422)`);
      }
    },
    {
      name: 'Something that isn\'t a resource is refused',
      requires: { interactions: [['Patient', 'create']] },
      run: async (ctx) => {
        const res = await ctx.client.post('Patient', { name: 'no resourceType' });
        ctx.must([400, 422].includes(res.status), `POST of JSON with no resourceType: ${res.status}, not 400 (or 422)`);
      }
    },
    {
      name: 'A resource that breaks the rules',
      requires: { interactions: [['Patient', 'create']] },
      run: async (ctx) => {
        // gender has a required binding
        const res = await ctx.client.post('Patient', patient(ctx, { gender: 'not-a-gender' }));
        if (res.status === 201) {
          const m = /Patient\/([A-Za-z0-9\-.]{1,64})/.exec(res.headers.location || '');
          if (m) {
            ctx.created('Patient', m[1]);
          }
        }
        ctx.should([400, 422].includes(res.status), `POST of a Patient with gender 'not-a-gender' (a required binding): ${res.status} (a server that checks: 400 or 422)`);
      }
    },
    {
      name: 'A content type the server doesn\'t do is refused (415)',
      requires: { interactions: [['Patient', 'create']] },
      run: async (ctx) => {
        const res = await ctx.client.post('Patient', 'resourceType: Patient', { contentType: 'text/yaml' });
        ctx.must(res.status >= 400 && res.status < 500, `POST as text/yaml: ${res.status}, not 415 (or another 4xx)`);
        ctx.should(res.status === 415, `POST as text/yaml: ${res.status}, not 415 Unsupported Media Type`);
      }
    }
  ]
};
