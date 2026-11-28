//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// The CapabilityStatement (the run has read it already: only a server that has one is tested)

module.exports = {
  name: 'Capabilities',
  tests: [
    {
      name: 'The CapabilityStatement describes the server',
      run: async (ctx) => {
        const res = ctx.status(await ctx.client.get('metadata'), 200, 'GET [base]/metadata');
        const cs = ctx.body(res, 'CapabilityStatement', 'GET [base]/metadata');
        ctx.must(cs.fhirVersion, 'The CapabilityStatement has no fhirVersion');
        ctx.must((cs.rest || []).some(r => r.mode === 'server'), 'The CapabilityStatement has no rest entry with mode server');
        ctx.must(Array.isArray(cs.format) && cs.format.length, 'The CapabilityStatement lists no formats');
        ctx.must(cs.status, 'The CapabilityStatement has no status');
        ctx.should(cs.kind === 'instance', `The CapabilityStatement's kind is ${cs.kind}, not instance (it describes this server)`);
        ctx.should(cs.software || cs.implementation, 'The CapabilityStatement says neither what software this is (software) nor which installation (implementation)');
      }
    },
    {
      name: 'The CapabilityStatement in XML',
      requires: { format: 'xml' },
      run: async (ctx) => {
        const res = ctx.status(await ctx.client.get('metadata', { format: 'xml' }), 200, 'GET [base]/metadata in XML');
        ctx.must(res.format === 'xml', `GET [base]/metadata, asking for XML: the answer is ${res.headers['content-type'] || 'of no content type'}`);
        ctx.body(res, 'CapabilityStatement', 'GET [base]/metadata in XML');
      }
    },
    {
      name: '_format chooses the format',
      requires: { format: 'xml' },
      run: async (ctx) => {
        const res = ctx.status(await ctx.client.get('metadata?_format=xml', { accept: 'application/fhir+json' }), 200, 'GET [base]/metadata?_format=xml');
        ctx.must(res.format === 'xml', `GET [base]/metadata?_format=xml, with Accept: application/fhir+json: the answer is ${res.headers['content-type']}, not XML (_format overrides Accept)`);
        const json = ctx.status(await ctx.client.get('metadata?_format=json', { accept: 'application/fhir+xml' }), 200, 'GET [base]/metadata?_format=json');
        ctx.must(json.format === 'json', `GET [base]/metadata?_format=json: the answer is ${json.headers['content-type']}, not JSON`);
      }
    }
  ]
};
