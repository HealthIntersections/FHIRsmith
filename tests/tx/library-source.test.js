/**
 * Publishing the library source.
 *
 * A user asked to be able to see what a server actually loads. The library YAML is the
 * honest answer to that, but it also names every database, cache and package the server
 * runs, so publishing it is the operator's decision: modules.tx.publishLibrarySource, off
 * by default. The setting gates the route AND the nav item, so a server that does not
 * publish it shows no link to a 404 - both halves are pinned below.
 *
 * There is one URL, content negotiated through the same acceptsHtml() the rest of the
 * module uses, so ?_format overrides the Accept header exactly as it does everywhere else.
 * The YAML representation must be the file's bytes, not a re-serialisation: a round trip
 * through a YAML parser would drop the operator's comments, which are often the only
 * explanation of why a particular cache is pinned.
 */

const request = require('supertest');
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const TXModule = require('../../tx/tx');

const LIBRARY = path.join(__dirname, 'fixtures', 'test-library.yaml');
const BASE = '/tx/r5';

/** A TX module of our own, so each block controls the setting under test. */
async function startApp(extraConfig) {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  const txModule = new TXModule();
  await txModule.initialize({
    librarySource: LIBRARY,
    endpoints: [{ path: BASE, fhirVersion: '5.0', context: null }],
    ...extraConfig
  }, app);
  return { app, txModule };
}

describe('library source is not published by default', () => {
  let app, txModule;

  beforeAll(async () => { ({ app, txModule } = await startApp({})); }, 120000);
  afterAll(async () => { await txModule.shutdown(); });

  test('the route is not registered', async () => {
    const res = await request(app).get(`${BASE}/library`).set('Accept', 'application/yaml');
    expect(res.status).toBe(404);
  });

  test('and no Library item appears in the navigation', async () => {
    const res = await request(app).get(`${BASE}/metadata`).set('Accept', 'text/html');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('/library"');
  });

  test('and the home page heading is the bare one', async () => {
    const res = await request(app).get(BASE).set('Accept', 'text/html');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Source Content</h3>');
    expect(res.text).not.toContain('/library"');
  });

  test('publishLibrarySource: false is the same as absent', async () => {
    // guards against a truthiness slip - only an explicit true turns it on
    const other = await startApp({ publishLibrarySource: false });
    try {
      const res = await request(other.app).get(`${BASE}/library`);
      expect(res.status).toBe(404);
    } finally {
      await other.txModule.shutdown();
    }
  }, 120000);
});

describe('library source published', () => {
  let app, txModule, fileContent;

  beforeAll(async () => {
    ({ app, txModule } = await startApp({ publishLibrarySource: true }));
    fileContent = fs.readFileSync(LIBRARY, 'utf8');
  }, 120000);
  afterAll(async () => { await txModule.shutdown(); });

  describe('the YAML representation', () => {
    test('a non-HTML Accept gets the file itself, byte for byte', async () => {
      const res = await request(app).get(`${BASE}/library`).set('Accept', 'application/yaml');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/yaml');
      expect(res.text).toBe(fileContent);
    });

    test('the comments survive, so it is the file and not a re-serialisation', async () => {
      const res = await request(app).get(`${BASE}/library`).set('Accept', 'application/yaml');
      expect(res.text).toContain('# Minimal test library');
    });

    test('?_format=yaml forces it past a browser Accept header', async () => {
      const res = await request(app).get(`${BASE}/library?_format=yaml`).set('Accept', 'text/html');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('application/yaml');
      expect(res.text).toBe(fileContent);
    });
  });

  describe('the HTML representation', () => {
    test('a browser gets a page, in the tx template', async () => {
      const res = await request(app).get(`${BASE}/library`).set('Accept', 'text/html');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(res.text).toContain('Library Source');
      expect(res.text).toContain('yaml-source');
    });

    test('?_format=html forces it past a non-browser Accept header', async () => {
      const res = await request(app).get(`${BASE}/library?_format=html`).set('Accept', 'application/yaml');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
    });

    test('the page carries the content of the file', async () => {
      const res = await request(app).get(`${BASE}/library`).set('Accept', 'text/html');
      expect(res.text).toContain('storage.googleapis.com/tx-fhir-org');
      expect(res.text).toContain('Minimal test library');
    });
  });

  test('the Library item now appears in the navigation', async () => {
    const res = await request(app).get(`${BASE}/metadata`).set('Accept', 'text/html');
    expect(res.status).toBe(200);
    expect(res.text).toContain(`href="${BASE}/library"`);
    expect(res.text).toContain('>Library</a>');
  });

  // The nav item is one route away from anywhere; this one is where a reader is actually
  // looking when the question occurs to them - they are reading the list of loaded content
  // and want to know where it came from.
  test('the home page links the source from the Source Content heading', async () => {
    const res = await request(app).get(BASE).set('Accept', 'text/html');
    expect(res.status).toBe(200);
    expect(res.text).toContain(`Source Content <a href="${BASE}/library"`);
    expect(res.text).toContain('>source</a>');
  });
});

describe('the YAML highlighter', () => {
  const { highlightYaml } = require('../../tx/tx-html');

  test('marks up keys, values, list items and comments', () => {
    const html = highlightYaml('# a comment\nbase:\n  url: https://example.org\nsources:\n  - internal:lang\n');
    expect(html).toContain('<span class="y-c"># a comment</span>');
    expect(html).toContain('<span class="y-k">base</span>');
    expect(html).toContain('<span class="y-v">https://example.org</span>');
    expect(html).toContain('<span class="y-d">- </span>');
  });

  test('a trailing comment is separated from its value', () => {
    const html = highlightYaml('  - snomed!:sct_intl_20250201.cache  # the default edition');
    expect(html).toContain('<span class="y-c">  # the default edition</span>');
    expect(html).not.toContain('the default edition</span></span>');
  });

  test('a colon with no space after it is part of a scalar, not a mapping key', () => {
    // '- internal:lang' is a plain scalar in YAML; colouring 'internal' as a key would
    // misrepresent the file to anyone reading the page to learn the syntax
    const html = highlightYaml('  - internal:lang');
    expect(html).toContain('<span class="y-v">internal:lang</span>');
    expect(html).not.toContain('y-k');
    // where the colon IS followed by space, it is a key
    expect(highlightYaml('  url: https://example.org')).toContain('<span class="y-k">url</span>');
  });

  test("a '#' inside a value is not treated as a comment", () => {
    // package and canonical references carry one, and losing the tail would misrepresent
    // the file
    const html = highlightYaml('  - npm:hl7.terminology#7.0.1');
    expect(html).toContain('hl7.terminology#7.0.1');
    expect(html).not.toContain('y-c');
  });

  test('escapes before it marks up, so a value cannot inject markup', () => {
    const html = highlightYaml('  note: <script>alert(1)</script> & more');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp; more');
  });

  test('blank lines and indentation are preserved', () => {
    expect(highlightYaml('a: 1\n\n  b: 2').split('\n')).toHaveLength(3);
    expect(highlightYaml('  b: 2')).toMatch(/^ {2}</);
  });
});
