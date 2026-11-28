//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// Binary: content in, content out

const { uniqueWord } = require('./common');

module.exports = {
  name: 'Binary',
  tests: [
    {
      name: 'Binary: posted as content, read as content or as a resource',
      requires: { interactions: [['Binary', 'create'], ['Binary', 'read']] },
      run: async (ctx) => {
        const content = `FHIRsmith tester ${uniqueWord()}\n`;
        const res = await ctx.client.post('Binary', Buffer.from(content, 'utf8'), { contentType: 'text/plain', accept: 'application/fhir+json' });
        const m = /Binary\/([A-Za-z0-9\-.]{1,64})/.exec(res.headers.location || '');
        const id = (res.resource && res.resource.resourceType === 'Binary' && res.resource.id) || (m && m[1]);
        if (id) {
          ctx.created('Binary', id);
        }
        ctx.status(res, 201, 'POST [base]/Binary of text/plain');
        ctx.must(id, 'POST [base]/Binary: no Location');
        const raw = ctx.status(await ctx.client.get(`Binary/${id}`, { accept: 'text/plain' }), 200, `GET [base]/Binary/${id} as text/plain`);
        ctx.must(raw.text === content, `GET [base]/Binary/${id}, asking for text/plain: the content isn't what was posted`);
        ctx.should(/^text\/plain/.test(raw.headers['content-type'] || ''), `The content's type is ${raw.headers['content-type']}, not text/plain`);
        const fhir = ctx.status(await ctx.client.get(`Binary/${id}`), 200, `GET [base]/Binary/${id} as FHIR`);
        const binary = ctx.body(fhir, 'Binary', 'the Binary as a resource');
        ctx.must(binary.contentType && binary.contentType.startsWith('text/plain'), `The Binary's contentType is ${binary.contentType}`);
        const data = binary.data || binary.content;
        ctx.must(data && Buffer.from(data, 'base64').toString('utf8') === content, 'The Binary\'s data isn\'t the content posted');
      }
    }
  ]
};
