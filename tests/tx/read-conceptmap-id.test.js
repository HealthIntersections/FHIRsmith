/**
 * Issue #256: a resource read at [type]/[id] must carry that id.
 *
 * Package ConceptMaps are served under a space-prefixed id ("1-foo") but are held
 * under their original id ("foo"). The read returned the resource unchanged, so its
 * id disagreed with its URL, and the HTML tabs (JSON, Original Narrative, Translate),
 * which link to ConceptMap/[resource.id], pointed at a 404.
 */

const ReadWorker = require('../../tx/workers/read');

function fakeRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; }
  };
}

function worker(provider) {
  const log = { debug() {}, error() {}, info() {}, warn() {} };
  const opContext = { deadCheck() {} };
  const w = new ReadWorker(opContext, log, provider, null, null);
  return w;
}

describe('read returns the id it was read at (#256)', () => {
  const held = { resourceType: 'ConceptMap', id: 'ch-vacd-vaccines-targetdiseases-cm', url: 'http://example.org/cm' };
  const provider = {
    conceptMapProviders: [{
      // like cm-package with spaceId "1": strips the prefix and returns the held object
      async fetchConceptMapById(id) {
        return id === '1-' + held.id ? { jsonObj: held } : null;
      }
    }],
    valueSetProviders: [{
      async fetchValueSetById(id) {
        return id === 'vs1' ? { jsonObj: { resourceType: 'ValueSet', id: 'vs1' } } : null;
      }
    }]
  };

  test('a space-prefixed ConceptMap read carries the prefixed id', async () => {
    const res = fakeRes();
    await worker(provider).handle({ params: { id: '1-' + held.id } }, res, 'ConceptMap');
    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBe('1-' + held.id);
    expect(res.body.url).toBe(held.url);
  });

  test('the provider\'s object is not mutated, so later lookups by its own id still work', async () => {
    const res = fakeRes();
    await worker(provider).handle({ params: { id: '1-' + held.id } }, res, 'ConceptMap');
    expect(held.id).toBe('ch-vacd-vaccines-targetdiseases-cm');
    expect(res.body).not.toBe(held);
  });

  test('a resource whose id already matches is returned as is', async () => {
    const res = fakeRes();
    await worker(provider).handle({ params: { id: 'vs1' } }, res, 'ValueSet');
    expect(res.body.id).toBe('vs1');
  });

  test('an unknown id is still a 404', async () => {
    const res = fakeRes();
    await worker(provider).handle({ params: { id: held.id } }, res, 'ConceptMap');
    expect(res.statusCode).toBe(404);
  });
});
