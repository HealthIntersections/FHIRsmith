//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// XML, when the server says it does it: the same interactions, sent and read as XML

const { patient, family, uniqueWord, ifMatch, unknownId } = require('./common');

const XML = { format: 'xml' };

module.exports = {
  name: 'XML',
  tests: [
    {
      name: 'Create, read and update in XML',
      requires: { format: 'xml', interactions: [['Patient', 'create'], ['Patient', 'read'], ['Patient', 'update']] },
      run: async (ctx) => {
        const p = patient(ctx);
        const made = await ctx.createNow(p, XML);
        ctx.must(made.res.format === 'xml' || !made.res.text.trim(), `The create in XML answered ${made.res.headers['content-type']}`);
        const res = ctx.status(await ctx.client.get(`Patient/${made.id}`, XML), 200, `GET [base]/Patient/${made.id} in XML`);
        ctx.must(res.format === 'xml', `GET [base]/Patient/${made.id}, asking for XML: the answer is ${res.headers['content-type']}`);
        const read = ctx.body(res, 'Patient', 'read in XML');
        ctx.must(family(read) === family(p) && read.birthDate === p.birthDate && read.gender === p.gender, 'The Patient read in XML isn\'t what was sent in XML');
        const name = uniqueWord();
        ctx.status(await ctx.client.put(`Patient/${made.id}`, { ...read, name: [{ family: name }] }, { ...XML, headers: ifMatch(ctx, 'Patient', made.version) }), 200, 'PUT in XML');
        const json = ctx.body(ctx.status(await ctx.client.get(`Patient/${made.id}`), 200, 'read in JSON'), 'Patient', 'read in JSON');
        ctx.must(family(json) === name, 'The update sent in XML isn\'t what is read in JSON');
      }
    },
    {
      name: 'Search in XML',
      requires: { format: 'xml', interactions: [['Patient', 'create'], ['Patient', 'search-type']], search: [['Patient', 'family']], scope: ['Patient'] },
      run: async (ctx) => {
        const made = await ctx.create(patient(ctx));
        const { ids, res } = await ctx.search('Patient', [['family', family(made.resource)]], XML);
        ctx.must(res.format === 'xml', `A search asking for XML: the answer is ${res.headers['content-type']}`);
        ctx.must(ids.length === 1 && ids[0] === made.id, `The search in XML found ${ids.join(', ') || 'nothing'}`);
      }
    },
    {
      name: 'Errors in XML',
      requires: { format: 'xml', interactions: [['Patient', 'read']] },
      run: async (ctx) => {
        const res = await ctx.client.get(`Patient/${unknownId()}`, XML);
        ctx.must(res.status === 404, `Reading what isn't there, in XML: ${res.status}, not 404`);
        ctx.should(res.format === 'xml' && res.resource && res.resource.resourceType === 'OperationOutcome',
          `The 404, asking for XML, isn't an OperationOutcome in XML (it's ${res.headers['content-type'] || 'nothing'})`);
      }
    },
    {
      name: 'XML that isn\'t well formed is refused (400)',
      requires: { format: 'xml', interactions: [['Patient', 'create']] },
      run: async (ctx) => {
        const res = await ctx.client.post('Patient', '<Patient xmlns="http://hl7.org/fhir"><active value="true"/>', { contentType: 'application/fhir+xml', format: 'xml' });
        ctx.must(res.status === 400, `POST of XML that isn't well formed: ${res.status}, not 400`);
      }
    }
  ]
};
