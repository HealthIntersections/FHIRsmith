// Resources whose narrative has active content are not loaded (library/narrative-check.js),
// and the Original Narrative tab won't show such a narrative if one gets through

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Library } = require('../../tx/library');
const { TxHtmlRenderer } = require('../../tx/tx-html');
const Logger = require('../../library/logger');

const div = (inner) => `<div xmlns="http://www.w3.org/1999/xhtml">${inner}</div>`;
const GOOD = div('<p>A fine narrative, with <a href="http://example.org">a link</a></p>');
const BAD = div('<p>Hello</p><img src="x" onerror="alert(1)"/>');

const RESOURCES = {
  'CodeSystem-good.json': { resourceType: 'CodeSystem', id: 'good', url: 'http://example.org/cs/good', version: '1', status: 'active', content: 'complete', text: { status: 'generated', div: GOOD }, concept: [{ code: 'a' }] },
  'CodeSystem-bad.json': { resourceType: 'CodeSystem', id: 'bad', url: 'http://example.org/cs/bad', version: '1', status: 'active', content: 'complete', text: { status: 'generated', div: BAD }, concept: [{ code: 'a' }] },
  'ValueSet-good.json': { resourceType: 'ValueSet', id: 'good', url: 'http://example.org/vs/good', version: '1', status: 'active', text: { status: 'generated', div: GOOD }, compose: { include: [{ system: 'http://example.org/cs/good' }] } },
  'ValueSet-bad.json': { resourceType: 'ValueSet', id: 'bad', url: 'http://example.org/vs/bad', version: '1', status: 'active', text: { status: 'generated', div: BAD }, compose: { include: [{ system: 'http://example.org/cs/good' }] } },
  'ConceptMap-good.json': { resourceType: 'ConceptMap', id: 'good', url: 'http://example.org/cm/good', version: '1', status: 'active', text: { status: 'generated', div: GOOD } },
  'ConceptMap-bad.json': { resourceType: 'ConceptMap', id: 'bad', url: 'http://example.org/cm/bad', version: '1', status: 'active', text: { status: 'generated', div: BAD } }
};

describe('loading content with active narrative', () => {
  let tmp, library, warnings;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'narrative-loading-'));
    for (const [name, json] of Object.entries(RESOURCES)) {
      fs.writeFileSync(path.join(tmp, name), JSON.stringify(json));
    }
    warnings = [];
    // CodeSystems are reported through the Library's log; ValueSets and ConceptMaps through
    // the shared logger
    const log = { info() {}, debug() {}, error() {}, warn: (m) => warnings.push(String(m)) };
    jest.spyOn(Logger.getInstance(), '_log').mockImplementation((level, msg) => {
      if (level === 'warn') {
        warnings.push(String(msg));
      }
    });
    library = new Library(null, null, log, null);
    await library.loadFolder(tmp, false, 'npm');
  });

  afterAll(() => {
    jest.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const urls = async (providers, list) => {
    const found = [];
    for (const p of providers) {
      for (const r of await list(p)) {
        found.push(r.url);
      }
    }
    return found.sort();
  };

  test('a CodeSystem with active content in its narrative is not loaded', async () => {
    const found = library.codeSystemProviders.flatMap(p => p.codeSystems.map(cs => cs.url));
    expect(found).toContain('http://example.org/cs/good');
    expect(found).not.toContain('http://example.org/cs/bad');
  });

  test('nor is a ValueSet', async () => {
    const found = await urls(library.valueSetProviders, async p => [...p.valueSetMap.values()]);
    expect(found).toContain('http://example.org/vs/good');
    expect(found).not.toContain('http://example.org/vs/bad');
  });

  test('nor is a ConceptMap', async () => {
    const found = await urls(library.conceptMapProviders, async p => [...p.conceptMapMap.values()].map(cm => cm.jsonObj || cm));
    expect(found).toContain('http://example.org/cm/good');
    expect(found).not.toContain('http://example.org/cm/bad');
  });

  test('each is reported, saying what was found', () => {
    for (const type of ['CodeSystem', 'ValueSet', 'ConceptMap']) {
      expect(warnings.some(w => w.includes(type) && /event handler attribute \(onerror\) on <img>/.test(w))).toBe(true);
    }
  });
});

describe('the Original Narrative tab', () => {
  const renderer = Object.create(TxHtmlRenderer.prototype);

  test('shows a narrative without active content as it is', async () => {
    const html = await renderer.renderOriginalNarrative({ resourceType: 'ValueSet', id: 'v', text: { div: GOOD } });
    expect(html).toContain(GOOD);
  });

  test('refuses one with active content, saying why', async () => {
    const html = await renderer.renderOriginalNarrative({ resourceType: 'ValueSet', id: 'v', text: { div: BAD } });
    expect(html).not.toContain('onerror="alert(1)"');
    expect(html).toMatch(/This narrative is not shown: ValueSet\/v: active content in the narrative: an event handler attribute \(onerror\) on &lt;img&gt;/);
  });
});
