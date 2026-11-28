//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// patch: JSON Patch and FHIRPath Patch

const { patient, family, uniqueWord, ifMatch, etag } = require('./common');

const JSON_PATCH = 'application/json-patch+json';

module.exports = {
  name: 'Patch',
  tests: [
    {
      name: 'JSON Patch',
      requires: { interactions: [['Patient', 'create'], ['Patient', 'patch'], ['Patient', 'read']],
        check: (cap) => cap.patchFormat(JSON_PATCH) ? null : 'The CapabilityStatement doesn\'t list JSON Patch (application/json-patch+json)' },
      run: async (ctx) => {
        const made = await ctx.create(patient(ctx, { active: true }));
        const name = uniqueWord();
        const ops = [{ op: 'replace', path: '/active', value: false }, { op: 'replace', path: '/name/0/family', value: name }, { op: 'add', path: '/gender', value: 'other' }];
        const res = ctx.status(await ctx.client.patch(`Patient/${made.id}`, JSON.stringify(ops), { contentType: JSON_PATCH, headers: ifMatch(ctx, 'Patient', made.version) }),
          200, `PATCH [base]/Patient/${made.id} (JSON Patch)`);
        ctx.should(res.headers.etag, 'The patch\'s response has no ETag');
        const read = ctx.body(ctx.status(await ctx.client.get(`Patient/${made.id}`), 200, 'read'), 'Patient', 'read');
        ctx.must(read.active === false && family(read) === name && read.gender === 'other', 'After the patch, the Patient isn\'t as patched');
      }
    },
    {
      name: 'JSON Patch: a test that fails changes nothing',
      requires: { interactions: [['Patient', 'create'], ['Patient', 'patch'], ['Patient', 'read']],
        check: (cap) => cap.patchFormat(JSON_PATCH) ? null : 'The CapabilityStatement doesn\'t list JSON Patch (application/json-patch+json)' },
      run: async (ctx) => {
        const made = await ctx.create(patient(ctx, { active: true }));
        const ops = [{ op: 'test', path: '/active', value: false }, { op: 'replace', path: '/active', value: false }];
        const res = await ctx.client.patch(`Patient/${made.id}`, JSON.stringify(ops), { contentType: JSON_PATCH, headers: ifMatch(ctx, 'Patient', made.version) });
        ctx.must([400, 409, 412, 422].includes(res.status), `A JSON Patch whose test fails: ${res.status}, not 400, 409, 412 or 422`);
        const read = ctx.body(ctx.status(await ctx.client.get(`Patient/${made.id}`), 200, 'read'), 'Patient', 'read');
        ctx.must(read.active === true, 'The patch whose test failed changed the Patient');
      }
    },
    {
      name: 'JSON Patch: If-Match with an old version is refused (412, or 409)',
      requires: { interactions: [['Patient', 'create'], ['Patient', 'patch'], ['Patient', 'update']],
        check: (cap) => !cap.patchFormat(JSON_PATCH) ? 'The CapabilityStatement doesn\'t list JSON Patch (application/json-patch+json)'
          : cap.versioning('Patient') !== 'versioned-update' ? 'The CapabilityStatement doesn\'t say Patient is versioned-update' : null },
      run: async (ctx) => {
        const made = await ctx.create(patient(ctx, { active: true }));
        ctx.status(await ctx.client.put(`Patient/${made.id}`, { ...made.resource, gender: 'male' }, { headers: ifMatch(ctx, 'Patient', made.version) }), 200, 'update');
        const res = await ctx.client.patch(`Patient/${made.id}`, JSON.stringify([{ op: 'replace', path: '/active', value: false }]),
          { contentType: JSON_PATCH, headers: { 'If-Match': etag(made.version) } });
        // as an update: 409 or 412, and Managing Resource Contention says 412
        ctx.must([409, 412].includes(res.status), `A patch with If-Match an old version: ${res.status}, not 412 (or 409)`);
        ctx.should(res.status === 412, `A patch with If-Match an old version: ${res.status} (Managing Resource Contention says 412 Precondition Failed)`);
      }
    },
    {
      name: 'FHIRPath Patch',
      requires: { interactions: [['Patient', 'create'], ['Patient', 'patch'], ['Patient', 'read']],
        check: (cap) => cap.patchFormat('application/fhir+json') ? null : 'The CapabilityStatement doesn\'t list FHIRPath Patch (application/fhir+json)' },
      run: async (ctx) => {
        const made = await ctx.create(patient(ctx, { active: true, gender: undefined }));
        const params = { resourceType: 'Parameters', parameter: [
          { name: 'operation', part: [{ name: 'type', valueCode: 'replace' }, { name: 'path', valueString: 'Patient.active' }, { name: 'value', valueBoolean: false }] },
          { name: 'operation', part: [{ name: 'type', valueCode: 'add' }, { name: 'path', valueString: 'Patient' }, { name: 'name', valueString: 'gender' }, { name: 'value', valueCode: 'unknown' }] }
        ] };
        ctx.status(await ctx.client.patch(`Patient/${made.id}`, params, { headers: ifMatch(ctx, 'Patient', made.version) }), 200, `PATCH [base]/Patient/${made.id} (FHIRPath Patch)`);
        const read = ctx.body(ctx.status(await ctx.client.get(`Patient/${made.id}`), 200, 'read'), 'Patient', 'read');
        ctx.must(read.active === false && read.gender === 'unknown', 'After the FHIRPath Patch, the Patient isn\'t as patched');
      }
    },
    {
      name: 'FHIRPath Patch in XML',
      requires: { format: 'xml', interactions: [['Patient', 'create'], ['Patient', 'patch'], ['Patient', 'read']],
        check: (cap) => cap.patchFormat('application/fhir+xml') ? null : 'The CapabilityStatement doesn\'t list FHIRPath Patch in XML (application/fhir+xml)' },
      run: async (ctx) => {
        const made = await ctx.create(patient(ctx, { active: true }));
        const params = { resourceType: 'Parameters', parameter: [
          { name: 'operation', part: [{ name: 'type', valueCode: 'replace' }, { name: 'path', valueString: 'Patient.active' }, { name: 'value', valueBoolean: false }] }] };
        ctx.status(await ctx.client.patch(`Patient/${made.id}`, params, { format: 'xml', headers: ifMatch(ctx, 'Patient', made.version) }), 200, `PATCH [base]/Patient/${made.id} (FHIRPath Patch, XML)`);
        const read = ctx.body(ctx.status(await ctx.client.get(`Patient/${made.id}`), 200, 'read'), 'Patient', 'read');
        ctx.must(read.active === false, 'After the FHIRPath Patch, the Patient isn\'t as patched');
      }
    }
  ]
};
