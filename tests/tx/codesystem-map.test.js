/**
 * CodeSystemMap keeps an index of supplements by the URL they supplement, maintained on every
 * set/delete, so Provider.loadSupplements() does not scan every loaded CodeSystem per lookup.
 */
const { CodeSystemMap } = require('../../tx/provider');

const cs = (url, version, extra = {}) => ({ url, version, vurl: url + '|' + version, jsonObj: { url, version, content: 'complete', ...extra } });
const supp = (url, version, of) => cs(url, version, { content: 'supplement', supplements: of });

describe('CodeSystemMap supplement index', () => {
  test('indexes supplements by the supplemented URL, without its version', () => {
    const m = new CodeSystemMap();
    m.set('http://x/base', cs('http://x/base', '1'));
    m.set('http://x/s1', supp('http://x/s1', '1', 'http://x/base'));
    m.set('http://x/s2|2', supp('http://x/s2', '2', 'http://x/base|1'));
    m.set('http://x/other', supp('http://x/other', '1', 'http://y/base'));
    expect([...m.supplementsOf('http://x/base')].map((c) => c.url).sort()).toEqual(['http://x/s1', 'http://x/s2']);
    expect([...m.supplementsOf('http://y/base')].map((c) => c.url)).toEqual(['http://x/other']);
    expect([...m.supplementsOf('http://z')]).toEqual([]);
  });

  test('replacing or deleting an entry keeps the index right', () => {
    const m = new CodeSystemMap();
    m.set('k', supp('http://x/s1', '1', 'http://x/base'));
    m.set('k', supp('http://x/s1', '2', 'http://x/other'));
    expect([...m.supplementsOf('http://x/base')]).toEqual([]);
    expect([...m.supplementsOf('http://x/other')].map((c) => c.version)).toEqual(['2']);
    m.delete('k');
    expect([...m.supplementsOf('http://x/other')]).toEqual([]);
    expect(m.supplementIndex.size).toBe(0);
    m.set('a', supp('http://x/s1', '1', 'http://x/base'));
    m.clear();
    expect([...m.supplementsOf('http://x/base')]).toEqual([]);
  });

  test('behaves as a Map', () => {
    const m = new CodeSystemMap([['a', cs('http://x/a', '1')]]);
    expect(m.get('a').url).toBe('http://x/a');
    expect(m.size).toBe(1);
    expect(m instanceof Map).toBe(true);
  });
});
