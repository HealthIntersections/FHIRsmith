// The token module's JSON API takes the API key from a header, not the URL path, so that keys
// don't end up in access logs; and its usage statistics don't include IP addresses

const TokenModule = require('../../token/token');

function module_(keyInfo = { id: 7, user_id: 1, email: 'a@example.org', name: 'A', key_name: 'k', is_active: true, scopes: 'read' }) {
  const m = Object.create(TokenModule.prototype);
  m.config = {};
  m.log = { error: jest.fn() };
  m.stats = { countRequest() {} };
  m.findApiKeyByValue = jest.fn(async (key) => (key === 'tk_good' ? keyInfo : null));
  m.updateKeyLastUsed = jest.fn(async () => {});
  m.getTodayUsage = jest.fn(async () => 0);
  m.incrementUsage = jest.fn(async () => {});
  m.getApiKeyUsageStats = jest.fn(async () => [{ date: '2026-10-17', request_count: 3 }]);
  return m;
}

function req(headers = {}, extra = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name) => lower[name.toLowerCase()], params: {}, query: {}, body: {}, ip: '127.0.0.1', ...extra };
}

function res() {
  return {
    statusCode: 200,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }
  };
}

describe('token API keys', () => {
  test('the key is read from Authorization: Bearer or X-API-Key', () => {
    const m = module_();
    expect(m.apiKeyFrom(req({ Authorization: 'Bearer tk_good' }))).toBe('tk_good');
    expect(m.apiKeyFrom(req({ authorization: 'bearer tk_good' }))).toBe('tk_good');
    expect(m.apiKeyFrom(req({ 'X-API-Key': 'tk_good' }))).toBe('tk_good');
    expect(m.apiKeyFrom(req({ Authorization: 'Basic abc' }))).toBeNull();
    expect(m.apiKeyFrom(req())).toBeNull();
  });

  test('validate accepts a key in a header, and not one in the path', async () => {
    const m = module_();
    const ok = res();
    await m.validateApiKey(req({ Authorization: 'Bearer tk_good' }), ok);
    expect(ok.statusCode).toBe(200);
    expect(ok.body.valid).toBe(true);

    const inPath = res();
    await m.validateApiKey(req({}, { params: { key: 'tk_good' } }), inPath);
    expect(inPath.statusCode).toBe(400);
  });

  test('usage and stats take the key from a header too', async () => {
    const m = module_();
    const usage = res();
    await m.recordUsage(req({ 'X-API-Key': 'tk_good' }, { body: { count: 2 } }), usage);
    expect(usage.statusCode).toBe(200);
    expect(m.incrementUsage).toHaveBeenCalledWith(7, 2, '127.0.0.1');

    const stats = res();
    await m.getUsageStats(req({ Authorization: 'Bearer tk_good' }, { query: { days: '-5' } }), stats);
    expect(stats.statusCode).toBe(200);
    expect(m.getApiKeyUsageStats).toHaveBeenCalledWith(7, 1);
  });

  test('the routes have no key in the path', () => {
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../../token/token'), 'utf8');
    expect(src).not.toMatch(/\/api\/(validate|usage|stats)\/:key/);
  });
});
