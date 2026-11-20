// The XML of large arrays kept for next time (tx/xml/xml-fragment-cache.js), and
// serialising without holding the event loop (FhirXmlBase.toXmlAsync)

const { XmlFragmentCache } = require('../../tx/xml/xml-fragment-cache');
const { FhirXmlBase } = require('../../tx/xml/xml-base');
const { CodeSystemXML } = require('../../tx/xml/codesystem-xml');
const { BundleXML } = require('../../tx/xml/bundle-xml');
const { ParametersXML } = require('../../tx/xml/parameters-xml');
const { codeSystemFromR5 } = require('../../tx/xversion/xv-codesystem');
const { bundleFromR5 } = require('../../tx/xversion/xv-bundle');

// a code system with nested concepts: 6 x 6 x 6
function codeSystem() {
  const concept = (code, depth) => {
    const c = { code, display: `Concept ${code} & <more>`, property: [{ code: 'active', valueBoolean: true }] };
    if (depth < 2) {
      c.concept = [];
      for (let i = 0; i < 6; i++) {
        c.concept.push(concept(`${code}.${i}`, depth + 1));
      }
    }
    return c;
  };
  const cs = {
    resourceType: 'CodeSystem', id: 'big', url: 'http://example.org/cs', version: '1', status: 'active', content: 'complete',
    extension: [{ url: 'http://example.org/ext', valueString: 'x' }],
    filter: [{ code: 'concept', operator: ['is-a', 'child-of'], value: 'code' }],
    concept: []
  };
  for (let i = 0; i < 6; i++) {
    cs.concept.push(concept(`C${i}`, 0));
  }
  return cs;
}

const searchBundle = (cs) => ({ resourceType: 'Bundle', type: 'searchset', total: 1, entry: [{ fullUrl: 'http://example.org/CodeSystem/big', resource: cs, search: { mode: 'match' } }] });

describe('XmlFragmentCache', () => {
  test('keeps an array only on its second expensive render', () => {
    const cache = new XmlFragmentCache({ budgetBytes: 1000, minMs: 50 });
    const a = [{}];
    expect(cache.wants(a, 'k', 10)).toBe(false); // cheap
    expect(cache.wants(a, 'k', 60)).toBe(false); // expensive, first time
    expect(cache.wants(a, 'k', 60)).toBe(true);
    expect(cache.wants(a, 'other', 60)).toBe(false); // keyed: name and level
  });

  test('get returns what was put, for the same array and key only', () => {
    const cache = new XmlFragmentCache({ budgetBytes: 1000 });
    const a = [{}];
    cache.put(a, 'k', 'xml');
    expect(cache.get(a, 'k')).toBe('xml');
    expect(cache.get(a, 'other')).toBeNull();
    expect(cache.get([{}], 'k')).toBeNull();
    expect(cache.hits).toBe(1);
  });

  test('an array whose length has changed since is not answered from the cache', () => {
    const cache = new XmlFragmentCache({ budgetBytes: 1000 });
    const a = [{}];
    cache.put(a, 'k', 'xml');
    a.push({});
    expect(cache.get(a, 'k')).toBeNull();
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
  });

  test('stays within its budget, dropping the least recently used', () => {
    const cache = new XmlFragmentCache({ budgetBytes: 10 });
    const a = [{}];
    const b = [{}];
    const c = [{}];
    cache.put(a, 'k', '1234');
    cache.put(b, 'k', '1234');
    cache.get(a, 'k'); // a is now more recent than b
    cache.put(c, 'k', '1234');
    expect(cache.get(b, 'k')).toBeNull();
    expect(cache.get(a, 'k')).toBe('1234');
    expect(cache.get(c, 'k')).toBe('1234');
    expect(cache.bytes).toBe(8);
  });

  test('text larger than the whole budget is not kept', () => {
    const cache = new XmlFragmentCache({ budgetBytes: 3 });
    cache.put([{}], 'k', '1234');
    expect(cache.size).toBe(0);
  });

  test('clear lets go of everything, and says how much', () => {
    const cache = new XmlFragmentCache({ budgetBytes: 100 });
    const a = [{}];
    cache.put(a, 'k', '1234');
    cache.put([{}], 'k', '12');
    expect(cache.clear()).toBe(6);
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
    expect(cache.get(a, 'k')).toBeNull();
  });
});

describe('FhirXmlBase.toXmlAsync', () => {
  afterEach(() => {
    FhirXmlBase.setFragmentCache(null);
  });

  test('produces the same XML as toXml', async () => {
    const cs = codeSystem();
    expect(await FhirXmlBase.toXmlAsync(() => CodeSystemXML.toXml(cs))).toBe(CodeSystemXML.toXml(cs));
    const bundle = bundleFromR5(searchBundle(cs), '4.0.1');
    expect(await FhirXmlBase.toXmlAsync(() => BundleXML.toXml(bundle, 4))).toBe(BundleXML.toXml(bundle, 4));
  });

  test('a resource embedded in Parameters is the same as with toXml (it is re-indented, so not set aside)', async () => {
    const params = { resourceType: 'Parameters', parameter: [{ name: 'return', resource: codeSystem() }] };
    expect(await FhirXmlBase.toXmlAsync(() => ParametersXML.toXml(params, 5))).toBe(ParametersXML.toXml(params, 5));
  });

  test('a value XML cannot carry still fails, as it does with toXml', async () => {
    const cs = codeSystem();
    cs.concept[3].concept[2].display = 'bad \u0001 character';
    expect(() => CodeSystemXML.toXml(cs)).toThrow(/U\+0001/);
    await expect(FhirXmlBase.toXmlAsync(() => CodeSystemXML.toXml(cs))).rejects.toThrow(/U\+0001/);
  });

  test('a key that is not an element name is refused, not written into the XML', async () => {
    const markup = { ...codeSystem(), 'a><injected/><b': 'v' };
    expect(() => CodeSystemXML.toXml(markup)).toThrow(/is not an element name/);
    await expect(FhirXmlBase.toXmlAsync(() => CodeSystemXML.toXml(markup))).rejects.toThrow(/is not an element name/);
    // nor one that would pass for the mark of an array set aside
    const mark = { ...codeSystem(), '\u00000\u0000': 'v' };
    await expect(FhirXmlBase.toXmlAsync(() => CodeSystemXML.toXml(mark))).rejects.toThrow(/is not an element name/);
    // deep inside, too (rendered by the asynchronous pass)
    const deep = codeSystem();
    deep.concept[2].concept[1]['bad name'] = 'v';
    await expect(FhirXmlBase.toXmlAsync(() => CodeSystemXML.toXml(deep))).rejects.toThrow(/is not an element name/);
    // and a resource's type, in a bundle
    const bundle = searchBundle({ ...codeSystem(), resourceType: 'CodeSystem><x' });
    expect(() => BundleXML.toXml(bundle, 5)).toThrow(/is not an element name/);
    // primitive extensions (_x) are still left out, as before
    expect(CodeSystemXML.toXml({ ...codeSystem(), _status: { extension: [] } })).toBe(CodeSystemXML.toXml(codeSystem()));
  });

  test('stops when the response is no longer wanted (the client has hung up)', async () => {
    const cs = codeSystem();
    for (let i = 0; i < 40000; i++) {
      cs.concept.push({ code: `X${i}`, display: `Extra concept ${i}` });
    }
    // enough to take well over 25 ms on any machine, so it yields, and asks
    for (let i = 0; i < 260000; i++) {
      cs.concept.push({ code: `Y${i}`, display: `More concepts ${i}`, designation: [{ value: `Designation ${i}` }] });
    }
    let asked = 0;
    const error = await FhirXmlBase.toXmlAsync(() => CodeSystemXML.toXml(cs), () => ++asked < 2).catch(e => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.abandoned).toBe(true);
    expect(asked).toBe(2);
    // still wanted: the whole thing
    expect(await FhirXmlBase.toXmlAsync(() => CodeSystemXML.toXml(cs), () => true)).toBe(CodeSystemXML.toXml(cs));
  });

  test('lets other work run while serialising a large resource', async () => {
    const cs = codeSystem();
    // enough concepts to take well over the 25 ms between yields, on any machine
    for (let i = 0; i < 300000; i++) {
      cs.concept.push({ code: `X${i}`, display: `Extra concept ${i}`, designation: [{ value: `Designation ${i}` }] });
    }
    let ran = 0;
    const timer = setInterval(() => ran++, 1);
    try {
      const xml = await FhirXmlBase.toXmlAsync(() => CodeSystemXML.toXml(cs));
      expect(xml).toBe(CodeSystemXML.toXml(cs));
    } finally {
      clearInterval(timer);
    }
    expect(ran).toBeGreaterThan(0);
  });

  test('with a cache: an array is kept on its second render, and used from the third', async () => {
    const cache = new XmlFragmentCache({ budgetBytes: 10 * 1024 * 1024, minMs: 0 });
    FhirXmlBase.setFragmentCache(cache);
    const cs = codeSystem();
    const expected = CodeSystemXML.toXml(cs);
    expect(await FhirXmlBase.toXmlAsync(() => CodeSystemXML.toXml(cs))).toBe(expected);
    expect(cache.size).toBe(0);
    expect(await FhirXmlBase.toXmlAsync(() => CodeSystemXML.toXml(cs))).toBe(expected);
    expect(cache.size).toBeGreaterThan(0);
    expect(cache.hits).toBe(0);
    expect(await FhirXmlBase.toXmlAsync(() => CodeSystemXML.toXml(cs))).toBe(expected);
    expect(cache.hits).toBeGreaterThan(0);
  });

  test('with a cache: the R3, R4 and R5 forms share the concepts, so they share what is kept', async () => {
    const cache = new XmlFragmentCache({ budgetBytes: 10 * 1024 * 1024, minMs: 0 });
    FhirXmlBase.setFragmentCache(cache);
    const cs = codeSystem();
    const r4 = codeSystemFromR5(cs, '4.0.1');
    const r3 = codeSystemFromR5(cs, '3.0.2');
    expect(r4.concept).toBe(cs.concept);
    await FhirXmlBase.toXmlAsync(() => CodeSystemXML.toXml(cs));
    await FhirXmlBase.toXmlAsync(() => CodeSystemXML.toXml(r4));
    const hits = cache.hits;
    expect(await FhirXmlBase.toXmlAsync(() => CodeSystemXML.toXml(r3))).toBe(CodeSystemXML.toXml(r3));
    expect(cache.hits).toBeGreaterThan(hits);
  });

  test('with a cache: a read and a search indent the concepts differently, and are kept apart', async () => {
    const cache = new XmlFragmentCache({ budgetBytes: 10 * 1024 * 1024, minMs: 0 });
    FhirXmlBase.setFragmentCache(cache);
    const cs = codeSystem();
    for (let i = 0; i < 2; i++) {
      await FhirXmlBase.toXmlAsync(() => CodeSystemXML.toXml(cs));
    }
    const bundle = searchBundle(cs);
    const expected = BundleXML.toXml(bundle, 5);
    for (let i = 0; i < 3; i++) {
      expect(await FhirXmlBase.toXmlAsync(() => BundleXML.toXml(bundle, 5))).toBe(expected);
    }
    expect(await FhirXmlBase.toXmlAsync(() => CodeSystemXML.toXml(cs))).toBe(CodeSystemXML.toXml(cs));
  });

  test('with a cache: a changed array is serialised afresh', async () => {
    const cache = new XmlFragmentCache({ budgetBytes: 10 * 1024 * 1024, minMs: 0 });
    FhirXmlBase.setFragmentCache(cache);
    const cs = codeSystem();
    for (let i = 0; i < 2; i++) {
      await FhirXmlBase.toXmlAsync(() => CodeSystemXML.toXml(cs));
    }
    cs.concept.push({ code: 'NEW', display: 'Added later' });
    const xml = await FhirXmlBase.toXmlAsync(() => CodeSystemXML.toXml(cs));
    expect(xml).toBe(CodeSystemXML.toXml(cs));
    expect(xml).toContain('<code value="NEW"/>');
  });
});

describe('FhirXmlBase.toXmlChunksAsync and writeXmlParts', () => {
  const { PassThrough } = require('stream');
  const joined = parts => Buffer.concat(parts.map(p => (typeof p === 'string' ? Buffer.from(p, 'utf8') : p))).toString('utf8');

  afterEach(() => FhirXmlBase.setFragmentCache(null));

  test('a small resource comes back as one string', async () => {
    const cs = { resourceType: 'CodeSystem', id: 'x', status: 'active', content: 'complete' };
    const parts = await FhirXmlBase.toXmlChunksAsync(() => CodeSystemXML.toXml(cs));
    expect(parts).toEqual([CodeSystemXML.toXml(cs)]);
  });

  test('kept XML is encoded once, and a later response is given those same Buffers', async () => {
    const cache = new XmlFragmentCache({ budgetBytes: 10 * 1024 * 1024, minMs: 0 });
    FhirXmlBase.setFragmentCache(cache);
    const cs = codeSystem();
    cs.concept.push({ code: 'U', display: 'Ünïcödé – ✓' });
    const expected = CodeSystemXML.toXml(cs);
    await FhirXmlBase.toXmlChunksAsync(() => CodeSystemXML.toXml(cs));
    const second = await FhirXmlBase.toXmlChunksAsync(() => CodeSystemXML.toXml(cs));
    expect(joined(second)).toBe(expected);
    const third = await FhirXmlBase.toXmlChunksAsync(() => CodeSystemXML.toXml(cs));
    expect(joined(third)).toBe(expected);
    const buffers = third.filter(p => Buffer.isBuffer(p));
    expect(buffers.length).toBeGreaterThan(0);
    expect(second.filter(p => Buffer.isBuffer(p))).toEqual(buffers);
    expect(buffers.every((b, i) => b === second.filter(p => Buffer.isBuffer(p))[i])).toBe(true);
    // the cache counts the bytes it holds, not characters
    expect(cache.bytes).toBe(buffers.reduce((n, b) => n + b.length, 0));
  });

  function fakeResponse(method = 'GET', highWaterMark = 16) {
    const res = new PassThrough({ highWaterMark });
    const headers = {};
    res.req = { method };
    res.setHeader = (k, v) => { headers[k] = v; };
    res.headers = headers;
    const received = [];
    res.on('data', c => received.push(c));
    res.received = () => Buffer.concat(received).toString('utf8');
    return res;
  }

  test('writes every part, waiting for the socket, with the length in bytes', async () => {
    const parts = ['<a>', Buffer.from('ünï', 'utf8'), 'x'.repeat(1000), Buffer.from('</a>')];
    const res = fakeResponse();
    const ended = new Promise(resolve => res.on('end', resolve));
    const size = await FhirXmlBase.writeXmlParts(res, parts);
    await ended;
    const expected = '<a>ünï' + 'x'.repeat(1000) + '</a>';
    expect(res.received()).toBe(expected);
    expect(size).toBe(Buffer.byteLength(expected, 'utf8'));
    expect(res.headers['Content-Length']).toBe(size);
  });

  test('a HEAD request gets the length and no body', async () => {
    const res = fakeResponse('HEAD');
    const size = await FhirXmlBase.writeXmlParts(res, ['<a>', Buffer.from('</a>')]);
    expect(size).toBe(7);
    expect(res.headers['Content-Length']).toBe(7);
    expect(res.writableEnded).toBe(true);
    expect(res.received()).toBe('');
  });

  test('stops when the client has gone', async () => {
    const res = fakeResponse('GET', 1);
    res.removeAllListeners('data'); // nobody reading: the first write fills the buffer
    const writing = FhirXmlBase.writeXmlParts(res, ['x'.repeat(100), 'y'.repeat(100)]);
    res.destroy();
    await expect(writing).resolves.toBe(200);
  });
});

describe('codeSystemFromR5', () => {
  test('does not change the R5 resource, and copies only what it changes', () => {
    const cs = codeSystem();
    cs.versionAlgorithmString = 'semver';
    const before = JSON.stringify(cs);
    const r4 = codeSystemFromR5(cs, '4.0.1');
    const r3 = codeSystemFromR5(cs, '3.0.2');
    expect(JSON.stringify(cs)).toBe(before);
    expect(r4.versionAlgorithmString).toBeUndefined();
    expect(r4.filter[0].operator).toEqual(['is-a']);
    expect(r3.filter[0].operator).toEqual(['is-a']);
    expect(r4.concept).toBe(cs.concept);
  });
});
