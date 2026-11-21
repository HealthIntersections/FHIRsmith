const { VSACValueSetProvider } = require('../../tx/vs/vs-vsac');
const { setupAuth, makeUser, auth } = require('../helpers/auth');

/**
 * Tests for the operator "resync a ValueSet" action on the VSAC /info page: for the server's
 * administrators (library/auth), logged in. The provider is built with Object.create to skip
 * the real constructor (which opens the sqlite database); we only exercise the form/permission/
 * dispatch logic.
 */

function provider({ allowed = true, refreshing = false, resync } = {}) {
  const p = Object.create(VSACValueSetProvider.prototype);
  p.resyncAllowed = allowed;
  p.isRefreshing = refreshing;
  p.stats = { task() {} };
  if (resync) p.resyncValueSet = resync;
  return p;
}

let adminId;
let userId;
beforeAll(async () => {
  setupAuth();
  adminId = await makeUser('admin', null, { admin: true });
  userId = await makeUser('someone', null);
});

// a request from a session logged in as the user (or no one)
const postReq = (body, uid = adminId) => ({
  method: 'POST', body, originalUrl: '/tx/r4/info/vsac', headers: {}, get() { return undefined; },
  session: uid ? { auth: { uid, epoch: auth.store.userById(uid).epoch } } : {}
});
const getReq = (uid) => ({ ...postReq({}, uid), method: 'GET' });

describe('VSAC resync - who sees it', () => {
  test('nothing at all when resync is false', () => {
    const p = provider({ allowed: false });
    expect(p._resyncEnabled()).toBe(false);
    expect(p._resyncFormHtml(getReq(adminId))).toBe('');
  });

  test('an administrator gets the form, with the session\'s CSRF token and no password', () => {
    const p = provider();
    expect(p._resyncEnabled()).toBe(true);
    const form = p._resyncFormHtml(getReq(adminId), { locals: { _csrf: 'tok' } });
    expect(form).toContain('method="post"');
    expect(form).toContain('name="url"');
    expect(form).toContain('name="_csrf" value="tok"');
    expect(form).not.toContain('type="password"');
  });

  test('anyone else gets a link to log in', () => {
    const p = provider();
    for (const req of [getReq(null), getReq(userId)]) {
      const html = p._resyncFormHtml(req);
      expect(html).not.toContain('<form');
      expect(html).toContain('/auth/login?return=');
    }
  });
});

describe('VSAC resync - request handling', () => {
  test('does nothing when the feature is disabled', async () => {
    let called = false;
    const p = provider({ allowed: false, resync: async () => { called = true; return 1; } });
    expect(await p._handleResyncRequest(postReq({ url: 'http://x' }))).toBe('');
    expect(called).toBe(false);
  });

  test('not an administrator: says so and does not resync', async () => {
    let called = false;
    const p = provider({ resync: async () => { called = true; return 1; } });
    expect(await p._handleResyncRequest(postReq({ url: 'http://x' }, userId))).toMatch(/Only the server's administrators/);
    expect(await p._handleResyncRequest(postReq({ url: 'http://x' }, null))).toMatch(/Only the server's administrators/);
    expect(called).toBe(false);
  });

  test('empty url: asks for a url, does not resync', async () => {
    let called = false;
    const p = provider({ resync: async () => { called = true; return 1; } });
    expect(await p._handleResyncRequest(postReq({ url: '  ' }))).toMatch(/Enter a ValueSet URL/i);
    expect(called).toBe(false);
  });

  test('while a full sync is running: defers, does not resync', async () => {
    let called = false;
    const p = provider({ refreshing: true, resync: async () => { called = true; return 1; } });
    expect(await p._handleResyncRequest(postReq({ url: 'http://x' }))).toMatch(/full sync is currently running/i);
    expect(called).toBe(false);
  });

  test('idle: resyncs and reports the version count', async () => {
    let withUrl = null;
    const p = provider({ resync: async (u) => { withUrl = u; return 4; } });
    const note = await p._handleResyncRequest(postReq({ url: 'http://example.org/vs' }));
    expect(withUrl).toBe('http://example.org/vs');
    expect(note).toMatch(/Resynced/);
    expect(note).toContain('http://example.org/vs');
    expect(note).toContain('4');
  });

  test('a bare OID is expanded to the VSAC canonical URL before resyncing', async () => {
    let withUrl = null;
    const p = provider({ resync: async (u) => { withUrl = u; return 1; } });
    await p._handleResyncRequest(postReq({ url: '2.16.840.1.113883.3.526.3.1240' }));
    expect(withUrl).toBe('http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1.113883.3.526.3.1240');
  });

  test('resync failure is reported, not thrown', async () => {
    const p = provider({ resync: async () => { throw new Error('VSAC down'); } });
    const note = await p._handleResyncRequest(postReq({ url: 'http://x' }));
    expect(note).toMatch(/failed/i);
    expect(note).toContain('VSAC down');
  });
});

describe('VSAC resync - OID/URL expansion', () => {
  const p = provider();

  test('bare OID expands', () => {
    expect(p._expandOidOrUrl('2.16.840.1.113883.3.526.3.1240'))
      .toBe('http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1.113883.3.526.3.1240');
  });

  test('urn:oid: prefix is stripped then expanded', () => {
    expect(p._expandOidOrUrl('urn:oid:2.16.840.1.113883.3.526.3.1240'))
      .toBe('http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1.113883.3.526.3.1240');
  });

  test('a full URL is left unchanged', () => {
    expect(p._expandOidOrUrl('http://hl7.org/fhir/ValueSet/x')).toBe('http://hl7.org/fhir/ValueSet/x');
  });

  test('whitespace is trimmed', () => {
    expect(p._expandOidOrUrl('  2.16.840.1  ')).toBe('http://cts.nlm.nih.gov/fhir/ValueSet/2.16.840.1');
  });

  test('empty input stays empty', () => {
    expect(p._expandOidOrUrl('')).toBe('');
    expect(p._expandOidOrUrl(null)).toBe('');
  });
});
