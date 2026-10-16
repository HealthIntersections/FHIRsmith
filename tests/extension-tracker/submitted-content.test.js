// Anyone can submit to the extension tracker, so what is submitted must not be able to put
// script in its pages

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');
const parse5 = require('parse5');
const ExtensionTrackerModule = require('../../extension-tracker/extension-tracker');
const { validateSubmission } = ExtensionTrackerModule;

const EVIL = '</script><script>alert(document.domain)</script>';
const EVIL_ATTR = '"><img src=x onerror=alert(document.domain)>';

// script elements and event handlers in a page that run the injected alert
function injected(html) {
  const found = [];
  (function walk(n) {
    // a script element of its own (the page's filter script may hold the text, escaped)
    if (n.tagName === 'script' && (n.childNodes || []).map(c => c.value).join('').trim() === 'alert(document.domain)') {
      found.push('script');
    }
    for (const a of n.attrs || []) {
      if (/^on/i.test(a.name)) {
        found.push(`${n.tagName} ${a.name}`);
      }
    }
    (n.childNodes || []).forEach(walk);
  })(parse5.parse(html));
  return found;
}

describe('extension tracker: submitted content', () => {
  let dir, app, module;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-tracker-'));
    app = express();
    module = new ExtensionTrackerModule({ countRequest() {} });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    module.initialize({ database: path.join(dir, 'ext.db') }, app);
    // straight into the database: submissions are checked (see below), but the pages must
    // be safe whatever is in it
    module.ingestData({
      package: 'evil' + EVIL_ATTR, version: '1.0.0' + EVIL, fhirVersion: '4.0.1', jurisdiction: EVIL_ATTR,
      extensions: [{ url: 'http://x/ext' + EVIL, title: EVIL_ATTR, types: [EVIL] }],
      profiles: { [EVIL]: [{ url: 'http://x/p' + EVIL_ATTR, title: EVIL }] },
      usage: { ['http://x/ext' + EVIL]: [EVIL_ATTR] }
    });
  });

  afterAll(() => {
    module.db.close();
    jest.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test.each([
    '/ext-tracker',
    '/ext-tracker/extensions',
    '/ext-tracker/extensions/packages',
    '/ext-tracker/extensions/packages?url=' + encodeURIComponent('http://x/ext' + EVIL),
    '/ext-tracker/profiles',
    '/ext-tracker/usage',
    '/ext-tracker/usage/packages',
    '/ext-tracker/usage/packages?url=' + encodeURIComponent(EVIL) + '&location=' + encodeURIComponent(EVIL_ATTR),
    '/ext-tracker/package/' + encodeURIComponent('evil' + EVIL_ATTR),
    '/ext-tracker/package/' + encodeURIComponent(EVIL)
  ])('%s has no injected script', async (url) => {
    const res = await request(app).get(url);
    expect(res.status).toBeLessThan(500);
    expect(injected(res.text)).toEqual([]);
  });
});

// what the IG Publisher sent for the tx-ecosystem IG
const PUBLISHER = {
  package: 'hl7.fhir.uv.tx-ecosystem',
  version: '1.9.1',
  fhirVersion: '5.0.0',
  jurisdiction: '001',
  extensions: [{ url: 'http://example.org/fhir/StructureDefinition/ext', title: 'My Extension', types: ['string', 'CodeableConcept'] }],
  profiles: { Patient: [{ url: 'http://example.org/fhir/StructureDefinition/p', title: 'My Profile' }] },
  usage: {
    'http://hl7.org/fhir/StructureDefinition/structuredefinition-fmm': ['ImplementationGuide'],
    'http://hl7.org/fhir/StructureDefinition/structuredefinition-standards-status': ['ImplementationGuide', 'ImplementationGuide.definition.page']
  }
};

describe('extension tracker: what a submission must look like', () => {
  test('what the IG Publisher sends is accepted', () => {
    expect(validateSubmission(PUBLISHER)).toEqual([]);
    expect(validateSubmission({ package: 'a.b', version: '0.1.0', fhirVersion: '4.0.1', extensions: [], profiles: {}, usage: {} })).toEqual([]);
    expect(validateSubmission({ ...PUBLISHER, jurisdiction: null, extensions: [{ url: 'http://x/e' }] })).toEqual([]);
  });

  test.each([
    ['not an object', []],
    ['an extra property', { ...PUBLISHER, other: 1 }],
    ['no package', { ...PUBLISHER, package: undefined }],
    ['a package that is not an id', { ...PUBLISHER, package: 'a b' }],
    ['a version with markup', { ...PUBLISHER, version: '1.0' + EVIL }],
    ['a fhirVersion that is not one', { ...PUBLISHER, fhirVersion: 'R4' }],
    ['a jurisdiction that is not a code', { ...PUBLISHER, jurisdiction: EVIL_ATTR }],
    ['an extension url that is not a URL', { ...PUBLISHER, extensions: [{ url: EVIL }] }],
    ['an extension with an extra property', { ...PUBLISHER, extensions: [{ url: 'http://x/e', x: 1 }] }],
    ['an extension type that is not a code', { ...PUBLISHER, extensions: [{ url: 'http://x/e', types: [EVIL] }] }],
    ['a profile keyed by something other than a resource type', { ...PUBLISHER, profiles: { [EVIL]: [{ url: 'http://x/p' }] } }],
    ['a profile url that is not a URL', { ...PUBLISHER, profiles: { Patient: [{ url: 'x' }] } }],
    ['a title that is not text', { ...PUBLISHER, profiles: { Patient: [{ url: 'http://x/p', title: { a: 1 } }] } }],
    ['a very long title', { ...PUBLISHER, extensions: [{ url: 'http://x/e', title: 'x'.repeat(2000) }] }],
    ['a usage key that is not a URL', { ...PUBLISHER, usage: { [EVIL]: ['Patient'] } }],
    ['a usage location that is not a path', { ...PUBLISHER, usage: { 'http://x/e': [EVIL_ATTR] } }],
    ['too many items', { ...PUBLISHER, usage: { 'http://x/e': Array(20001).fill('Patient') } }]
  ])('refused: %s', (_, data) => {
    expect(validateSubmission(data).length).toBeGreaterThan(0);
  });
});

describe('extension tracker: submitting', () => {
  let dir, app, module;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-tracker-'));
    app = express();
    module = new ExtensionTrackerModule({ countRequest() {} });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    module.initialize({ database: path.join(dir, 'ext.db'), token: 'the-token' }, app);
  });

  afterAll(() => {
    module.db.close();
    jest.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('needs the token, when one is configured', async () => {
    expect((await request(app).post('/ext-tracker').send(PUBLISHER)).status).toBe(401);
    expect((await request(app).post('/ext-tracker').set('Authorization', 'Bearer wrong').send(PUBLISHER)).status).toBe(401);
    expect((await request(app).post('/ext-tracker').set('Authorization', 'Bearer the-token').send(PUBLISHER)).status).toBe(200);
  });

  test('refuses what doesn\'t look like a publisher submission, and stores nothing from it', async () => {
    const res = await request(app).post('/ext-tracker').set('Authorization', 'Bearer the-token')
      .send({ ...PUBLISHER, package: 'other.pkg', profiles: { [EVIL]: [{ url: 'http://x/p' }] } });
    expect(res.status).toBe(400);
    expect(res.body.issues.join()).toMatch(/is not a resource type/);
    expect(module.db.prepare('SELECT COUNT(*) AS n FROM packages WHERE package = ?').get('other.pkg').n).toBe(0);
  });
});
