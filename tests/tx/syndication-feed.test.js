/**
 * The syndication feed (tx/syndication/syndication-feed.js): the Atom documents built from
 * the store - NCTS ASF content, and RFC 5005 archived-feed paging.
 */

const { XMLParser } = require('fast-xml-parser');
const { renderAtom, renderHtml, selectPage, feedId, esc, PAGE_SIZE } = require('../../tx/syndication/syndication-feed');
const { NCTS_SCHEME, FHIRSMITH_SCHEME } = require('../../tx/syndication/syndication-store');

const BASE = 'https://tx.example.org/tx/r4';

function entry(n, extra = {}) {
  return {
    id: `urn:uuid:00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    inducted: new Date(Date.parse('2026-10-23T00:00:00Z') + n * 1000).toISOString(),
    key: `package:p${n}#1.0.0`,
    kind: 'package',
    category: { scheme: NCTS_SCHEME, term: 'FHIR_Package', label: 'FHIR Package' },
    identifier: `http://example.org/p${n}`,
    version: `http://example.org/p${n}|1.0.0`,
    title: `Package ${n}`,
    link: { href: `https://npm.fhir.org/web/p${n}-1.0.0.tgz`, type: 'application/gzip', length: 100 + n, sha256: 'ab'.repeat(32) },
    ...extra
  };
}

function fakeStore(entries) {
  return {
    id: '11111111-2222-4333-8444-555555555555',
    created: '2026-10-22T00:00:00.000Z',
    entriesFor: (v) => entries.filter(e => !e.fhirVersion || e.fhirVersion === v)
  };
}

function parse(xml) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', parseTagValue: false, parseAttributeValue: false, isArray: (name) => ['entry', 'link'].includes(name) });
  return parser.parse(xml).feed;
}

function links(feed) {
  const map = {};
  for (const l of feed.link) {
    map[l['@rel']] = l['@href'];
  }
  return map;
}

function render(entries, page = null, extra = {}) {
  return renderAtom({ store: fakeStore(entries), endpointPath: '/tx/r4', fhirVersion: '4.0.1', base: BASE, page, title: 'Test Server', serverVersion: '1.2.3', ...extra });
}

describe('paging', () => {
  test('pages are full archives, then the rest in the current document', () => {
    const all = Array.from({ length: 65 }, (_, i) => entry(i));
    expect(PAGE_SIZE).toBe(30);
    expect(selectPage(all, null)).toEqual({ archives: 2, entries: all.slice(60) });
    expect(selectPage(all, 1).entries).toEqual(all.slice(0, 30));
    expect(selectPage(all, 2).entries).toEqual(all.slice(30, 60));
    expect(selectPage(all, 3)).toBeNull();
    expect(selectPage(all, 0)).toBeNull();
    expect(selectPage(all.slice(0, 30), null)).toEqual({ archives: 1, entries: [] });
  });

  test('the current document links to the newest archive', () => {
    const feed = parse(render(Array.from({ length: 65 }, (_, i) => entry(i))));
    expect(links(feed)).toEqual({
      self: `${BASE}/syndication`,
      current: `${BASE}/syndication`,
      'prev-archive': `${BASE}/syndication/archive/2`
    });
    expect(feed['fh:archive']).toBeUndefined();
    expect(feed.entry).toHaveLength(5);
  });

  test('archives are marked, and linked back to the one before', () => {
    const all = Array.from({ length: 95 }, (_, i) => entry(i));
    const first = parse(render(all, 1));
    expect(first['fh:archive']).toBeDefined();
    // no next-archive anywhere: it would make the newest archive change
    expect(links(first)).toEqual({
      self: `${BASE}/syndication/archive/1`,
      current: `${BASE}/syndication`
    });
    expect(links(parse(render(all, 2)))['prev-archive']).toBe(`${BASE}/syndication/archive/1`);
    const newest = links(parse(render(all, 3)));
    expect(newest['prev-archive']).toBe(`${BASE}/syndication/archive/2`);
    expect(newest['next-archive']).toBeUndefined();
    expect(render(all, 4)).toBeNull();
  });

  test('an archive does not change as entries are added', () => {
    const all = Array.from({ length: 31 }, (_, i) => entry(i));
    const before = render(all, 1);
    all.push(...Array.from({ length: 40 }, (_, i) => entry(100 + i)));
    expect(render(all, 1)).toBe(before);
  });
});

describe('the feed', () => {
  test('carries the feed level elements the IG asks for', () => {
    const feed = parse(render([entry(1), entry(2)]));
    expect(feed['@xmlns']).toBe('http://www.w3.org/2005/Atom');
    expect(feed['@xmlns:ncts']).toBe('http://ns.electronichealth.net.au/ncts/syndication/asf/extensions/1.0.0');
    expect(feed.id).toBe(feedId('11111111-2222-4333-8444-555555555555', '/tx/r4'));
    expect(feed.title).toBe('Test Server Syndication Feed (FHIR 4.0)');
    expect(feed.updated).toBe(entry(2).inducted);
    expect(feed['ncts:atomSyndicationFormatProfile']).toBe('http://ns.electronichealth.net.au/ncts/syndication/asf/profile/1.0.0');
    expect(feed.generator['#text']).toBe('FHIRsmith');
  });

  test('the feed id is stable and differs by endpoint', () => {
    const a = feedId('s', '/tx/r4');
    expect(a).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(feedId('s', '/tx/r4')).toBe(a);
    expect(feedId('s', '/tx/r5')).not.toBe(a);
  });

  test('an empty feed dates from when the store started', () => {
    const feed = parse(render([]));
    expect(feed.updated).toBe('2026-10-22T00:00:00.000Z');
    expect(feed.entry).toBeUndefined();
  });

  test('entries are newest first, with the NCTS elements', () => {
    const feed = parse(render([entry(1), entry(2, { summary: 'second <one>' })]));
    expect(feed.entry.map(e => e.title)).toEqual(['Package 2', 'Package 1']);
    const e = feed.entry[0];
    expect(e.id).toBe(entry(2).id);
    expect(e.updated).toBe(entry(2).inducted);
    expect(e.published).toBe(entry(2).inducted);
    expect(e.summary).toBe('second <one>');
    expect(e.category['@term']).toBe('FHIR_Package');
    expect(e.category['@scheme']).toBe(NCTS_SCHEME);
    expect(e.link[0]['@rel']).toBe('alternate');
    expect(e.link[0]['@href']).toBe('https://npm.fhir.org/web/p2-1.0.0.tgz');
    expect(e.link[0]['@length']).toBe('102');
    expect(e.link[0]['@ncts:sha256Hash']).toBe('ab'.repeat(32));
    expect(e['ncts:contentItemIdentifier']).toBe('http://example.org/p2');
    expect(e['ncts:contentItemVersion']).toBe('http://example.org/p2|1.0.0');
    expect(e['ncts:fhirVersion']).toBe('4.0');
  });

  test('version specific entries only appear in their own endpoint\'s feed', () => {
    const core4 = entry(1, { fhirVersion: '4.0', title: 'R4 core' });
    const core5 = entry(2, { fhirVersion: '5.0', title: 'R5 core' });
    const r4 = parse(render([core4, core5, entry(3)]));
    expect(r4.entry.map(e => e.title)).toEqual(['Package 3', 'R4 core']);
    const r5 = parse(render([core4, core5, entry(3)], null, { fhirVersion: '5.0', endpointPath: '/tx/r5' }));
    expect(r5.entry.map(e => e.title)).toEqual(['Package 3', 'R5 core']);
    expect(r5.entry.map(e => e['ncts:fhirVersion'])).toEqual(['5.0', '5.0']);
  });

  test('resource files are linked under the endpoint; binaries carry rights and no fhirVersion', () => {
    const res = entry(1, {
      kind: 'resource', category: { scheme: NCTS_SCHEME, term: 'FHIR_CodeSystem' },
      link: { file: 'f.json', type: 'application/fhir+json', length: 5, sha256: 'cd'.repeat(32) }
    });
    const bin = entry(2, {
      kind: 'binary', category: { scheme: FHIRSMITH_SCHEME, term: 'LOINC_DB', label: 'LOINC_DB' }, rights: 'Licensed',
      link: { href: 'https://storage.example.org/Loinc.db', type: 'application/octet-stream', length: 5, sha256: 'ef'.repeat(32) }
    });
    const feed = parse(render([res, bin]));
    expect(feed.entry[0].rights).toBe('Licensed');
    expect(feed.entry[0]['ncts:fhirVersion']).toBeUndefined();
    expect(feed.entry[1].link[0]['@href']).toBe(`${BASE}/syndication/files/f.json`);
    expect(feed.entry[1]['ncts:fhirVersion']).toBe('4.0');
  });
});

describe('escaping', () => {
  test('characters XML does not allow are dropped, so metadata cannot break a document', () => {
    expect(esc('a\u0000b\u0008c\u000Bd\u001Fe\uFFFEf')).toBe('abcdef');
    expect(esc('tab\tnl\ncr\r')).toBe('tab\tnl\ncr\r');
    expect(esc('pair \uD83D\uDE00 lone \uD83D x \uDE00')).toBe('pair \uD83D\uDE00 lone  x ');
    expect(esc('<a href="x">&\'</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;');
    const xml = render([entry(1, { summary: 'bad \u0001 summary', title: 'bad \u0002 title' })]);
    const feed = parse(xml);
    expect(feed.entry[0].summary).toBe('bad  summary');
    expect([...xml].some(ch => ch.charCodeAt(0) < 9)).toBe(false);
  });
});

describe('the HTML view', () => {
  test('lists the entries and escapes them', () => {
    const html = renderHtml({ store: fakeStore([entry(1, { title: '<script>x</script>' })]), endpointPath: '/tx/r4', fhirVersion: '4.0.1', base: BASE, page: null });
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('https://npm.fhir.org/web/p1-1.0.0.tgz');
  });

  test('links between the documents', () => {
    const all = Array.from({ length: 65 }, (_, i) => entry(i));
    const current = renderHtml({ store: fakeStore(all), endpointPath: '/tx/r4', fhirVersion: '4.0', base: BASE, page: null });
    expect(current).toContain(`${BASE}/syndication/archive/2">Older`);
    const first = renderHtml({ store: fakeStore(all), endpointPath: '/tx/r4', fhirVersion: '4.0', base: BASE, page: 1 });
    expect(first).toContain(`${BASE}/syndication/archive/2">Newer`);
    expect(renderHtml({ store: fakeStore(all), endpointPath: '/tx/r4', fhirVersion: '4.0', base: BASE, page: 9 })).toBeNull();
  });
});
