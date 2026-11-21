/**
 * A resource is read at [type]/[id] in its provider's id space, and carries that id.
 *
 * Issue #256 was package ConceptMaps served under a space-prefixed id ("1-foo") but held
 * under their original id ("foo"), so a read returned a resource whose id disagreed with
 * its URL. Now every provider gives its resources their prefixed id (see
 * tx/library/resource-ids.js), so read returns the resource as it is - and an
 * unprefixed id finds nothing.
 */

const ReadWorker = require('../../tx/workers/read');
const { applyIdPrefix, stripIdPrefix, checkIdPrefix } = require('../../tx/library/resource-ids');

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
  return new ReadWorker(opContext, log, provider, null, null);
}

describe('read returns the resource in its id space', () => {
  const held = { id: 'vaccines-cm', jsonObj: { resourceType: 'ConceptMap', id: 'vaccines-cm', url: 'http://example.org/cm' } };
  applyIdPrefix(held, 'ch');
  const provider = {
    conceptMapProviders: [{
      spaceId: 'ch',
      // like cm-package: only ids in its space, held under the original id
      async fetchConceptMapById(id) {
        return stripIdPrefix(id, this.spaceId) === 'vaccines-cm' ? held : null;
      }
    }],
    valueSetProviders: []
  };

  test('a prefixed ConceptMap read carries the prefixed id', async () => {
    const res = fakeRes();
    await worker(provider).handle({ params: { id: 'ch-vaccines-cm' } }, res, 'ConceptMap');
    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBe('ch-vaccines-cm');
    expect(res.body.url).toBe('http://example.org/cm');
  });

  test('the unprefixed id is a 404', async () => {
    const res = fakeRes();
    await worker(provider).handle({ params: { id: 'vaccines-cm' } }, res, 'ConceptMap');
    expect(res.statusCode).toBe(404);
  });
});

describe('resource ids', () => {
  test('applyIdPrefix prefixes the wrapper and its json, once', () => {
    const r = { id: 'a', jsonObj: { id: 'a' } };
    applyIdPrefix(r, 'tho');
    applyIdPrefix(r, 'tho');
    expect(r.id).toBe('tho-a');
    expect(r.jsonObj.id).toBe('tho-a');
  });

  test('applyIdPrefix still prefixes a raw id that looks prefixed', () => {
    const r = { jsonObj: { id: 'tho-a' } };
    applyIdPrefix(r, 'tho');
    expect(r.jsonObj.id).toBe('tho-tho-a');
  });

  test('applyIdPrefix leaves a resource without an id, or without a spaceId, alone', () => {
    const r = { jsonObj: {} };
    applyIdPrefix(r, 'tho');
    expect(r.jsonObj.id).toBeUndefined();
    const s = { jsonObj: { id: 'a' } };
    applyIdPrefix(s, undefined);
    expect(s.jsonObj.id).toBe('a');
  });

  test('stripIdPrefix only accepts ids in the space', () => {
    expect(stripIdPrefix('tho-v3-ActCode', 'tho')).toBe('v3-ActCode');
    expect(stripIdPrefix('v3-ActCode', 'tho')).toBeNull();
    expect(stripIdPrefix('tho-', 'tho')).toBeNull();
    expect(stripIdPrefix('tho-a', undefined)).toBeNull();
  });

  test('checkIdPrefix', () => {
    expect(checkIdPrefix('tho')).toBeNull();
    expect(checkIdPrefix('us.core')).toBeNull();
    expect(checkIdPrefix('3')).toBeNull();
    expect(checkIdPrefix('a-b')).not.toBeNull();
    expect(checkIdPrefix('')).not.toBeNull();
    expect(checkIdPrefix('core')).not.toBeNull();
    expect(checkIdPrefix('x')).not.toBeNull();
  });
});
