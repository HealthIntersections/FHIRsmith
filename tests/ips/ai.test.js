//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

const { fakeService } = require('./fake-ai');
const { complete, checkAccount, jsonIn, costOf, encryptKey, decryptKey } = require('../../ips/ai-client');
const { assessmentOf, documentForAi, aiSystemPrompt, AI_SYSTEM_PROMPT } = require('../../ips/pipeline');

describe('the AI client', () => {
  let svc;
  beforeAll(async () => { svc = await fakeService(); });
  afterAll(() => svc.server.close());

  test('talks both shapes', async () => {
    const a = await complete({ provider: 'openai', baseUrl: svc.url + '/v1/', model: 'm1', apiKey: 'k1' }, { system: 'S', user: 'U' });
    expect(a).toEqual({ text: expect.stringContaining('Consistent'), usage: { input: 100, output: 20, cost: null }, model: 'm1-2026', provider: 'openai', truncated: false, maxTokens: 16384 });
    expect(svc.calls[0]).toMatchObject({ shape: 'openai', auth: 'Bearer k1', body: { model: 'm1', temperature: 0, max_tokens: 16384, messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }] } });
    const b = await complete({ provider: 'anthropic', baseUrl: svc.url, model: 'm2', apiKey: 'k2' }, { system: 'S', user: 'U', maxTokens: 100 });
    expect(b).toEqual({ text: expect.stringContaining('Consistent'), usage: { input: 50, output: 10, cost: null }, model: 'm2', provider: 'anthropic', truncated: false, maxTokens: 100 });
    // a cut-off answer says so
    expect((await complete({ provider: 'anthropic', baseUrl: svc.url, model: 'bad-json', apiKey: 'k' }, { system: 'S', user: 'U' })).truncated).toBe(true);
    expect(svc.calls[1]).toMatchObject({ shape: 'anthropic', key: 'k2', version: '2023-06-01', body: { model: 'm2', max_tokens: 100, system: 'S', messages: [{ role: 'user', content: 'U' }] } });
  });

  test('reports failures without the key or the URL', async () => {
    const acct = { provider: 'openai', baseUrl: svc.url + '/v1', model: 'boom', apiKey: 'secret-key' };
    await expect(complete(acct, { system: 'S', user: 'U' })).rejects.toThrow('The AI service (openai, boom) answered HTTP 500: kaboom');
    await expect(complete({ ...acct, model: 'empty' }, { system: 'S', user: 'U' })).rejects.toThrow('answered with no text');
    await expect(complete({ ...acct, baseUrl: svc.url + '/slow' }, { system: 'S', user: 'U', timeoutMs: 50 })).rejects.toThrow('did not answer within 50 ms');
    await expect(complete({ ...acct, baseUrl: 'http://127.0.0.1:1' }, { system: 'S', user: 'U' })).rejects.toThrow(/could not be reached/);
    for (const e of [complete({ ...acct, baseUrl: svc.url + '/slow' }, { system: 'S', user: 'U', timeoutMs: 50 }).catch(x => x)]) {
      expect(String((await e).message)).not.toContain('secret-key');
    }
  });

  test('checks accounts', () => {
    expect(() => checkAccount(null)).toThrow('No AI account');
    expect(() => checkAccount({ provider: 'x', model: 'm', apiKey: 'k' })).toThrow(/Unknown AI provider 'x'/);
    expect(() => checkAccount({ provider: 'openai', apiKey: 'k' })).toThrow('no model');
    expect(() => checkAccount({ provider: 'openai', model: 'm' })).toThrow('no API key');
    expect(() => checkAccount({ provider: 'openai', model: 'm', apiKey: 'k', baseUrl: 'nope' })).toThrow('not a URL');
    expect(() => checkAccount({ provider: 'openai', model: 'm', apiKey: 'k', baseUrl: 'ftp://x' })).toThrow('http(s)');
    expect(checkAccount({ provider: 'anthropic', model: 'm', apiKey: 'k' }).baseUrl).toBe('https://api.anthropic.com');
    expect(checkAccount({ provider: 'openai', model: 'm', apiKey: 'k', baseUrl: 'https://x/v1//' }).baseUrl).toBe('https://x/v1');
  });

  test('works out the cost', () => {
    const prices = { 'claude-sonnet': { input: 3, output: 15 }, 'claude-sonnet-5-5': { input: 4, output: 20 }, gpt: { input: 'x' } };
    expect(costOf({ input: 1000000, output: 100000, cost: null }, 'claude-sonnet-5-5-20260101', prices)).toBeCloseTo(4 + 2, 6);
    expect(costOf({ input: 1000000, output: 0, cost: null }, 'claude-sonnet-4', prices)).toBe(3);
    expect(costOf({ input: 10, output: 10, cost: 0.0123 }, 'anything', null)).toBe(0.0123);
    expect(costOf({ input: 10, output: 10, cost: null }, 'gpt-4o', prices)).toBeNull();
    expect(costOf({ input: 10, output: 10, cost: null }, 'other', prices)).toBeNull();
    expect(costOf({ input: null, output: 10, cost: null }, 'claude-sonnet', prices)).toBeNull();
    expect(costOf(null, 'claude-sonnet', prices)).toBeNull();
    const { DEFAULT_PRICES } = require('../../ips/ai-client');
    expect(costOf({ input: 1000000, output: 1000000, cost: null }, 'claude-opus-5-5-20261001', DEFAULT_PRICES)).toBe(24);
  });

  test('finds the JSON in an answer', () => {
    expect(jsonIn('{"a": 1}')).toEqual({ a: 1 });
    expect(jsonIn('Sure:\n```json\n{"a": 1}\n```')).toEqual({ a: 1 });
    expect(jsonIn('text {"a": {"b": 2}} more')).toEqual({ a: { b: 2 } });
    expect(jsonIn('nothing here')).toBeNull();
    expect(jsonIn('[1, 2]')).toBeNull();
    expect(jsonIn(null)).toBeNull();
  });

  test('keeps keys encrypted', () => {
    const enc = encryptKey('sk-123', 'secret');
    expect(enc.startsWith('v1:')).toBe(true);
    expect(enc).not.toContain('sk-123');
    expect(decryptKey(enc, 'secret')).toBe('sk-123');
    expect(decryptKey(enc, 'other')).toBeNull();
    expect(decryptKey('garbage', 'secret')).toBeNull();
    expect(decryptKey(null, 'secret')).toBeNull();
    expect(encryptKey('sk-123', 'secret')).not.toBe(enc);
  });

  test('tidies the assessment and strips the document', () => {
    expect(assessmentOf(null)).toBeNull();
    expect(assessmentOf({ grade: 'b', summary: 's', consistency: [{ severity: 'high', finding: 'f', where: 'w' }, { finding: '' }, 'junk'], missing: ['m', { finding: 'n' }, 3], terminology: [{ severity: 'odd', finding: 't', codes: ['a|b', 4] }] }))
      .toEqual({ grade: 'B', summary: 's', consistency: [{ severity: 'high', finding: 'f', where: 'w' }], missing: ['m', 'n'], terminology: [{ severity: 'medium', finding: 't', codes: ['a|b'] }] });
    expect(assessmentOf({ grade: 'Z' }).grade).toBeNull();
    const analysed = { resourceType: 'Bundle', entry: [
      { resource: { resourceType: 'Composition', text: { status: 'generated', div: '<div>generated</div>' }, section: [{ title: 't', text: { div: '<div>generated section</div>' }, section: [{ title: 'sub', text: { div: '<div>gen sub</div>' } }] }] } },
      { resource: { resourceType: 'Patient', text: { div: '<div>gen patient</div>' }, extension: [{ url: 'x' }] } }
    ] };
    const master = { resourceType: 'Bundle', entry: [
      { resource: { resourceType: 'Composition', text: { status: 'additional', div: '<div>as sent</div>' }, section: [{ title: 't', text: { status: 'generated', div: '<div>section as sent</div>' }, section: [{ title: 'sub', text: { div: '<div>sub as sent</div>' } }] }] } },
      { resource: { resourceType: 'Patient', text: { div: '<div>patient as sent</div>' } } }
    ] };
    const d = documentForAi(analysed);
    expect(JSON.stringify(d)).not.toContain('div');
    expect(d.entry[0].resource.section[0].title).toBe('t');
    // with the narrative: the sender's, not the generated one, matched by position
    const n = documentForAi(analysed, master);
    expect(n.entry[0].resource.text).toEqual({ status: 'additional', div: '<div>as sent</div>' });
    expect(n.entry[0].resource.section[0].text.div).toBe('<div>section as sent</div>');
    expect(n.entry[0].resource.section[0].section[0].text.div).toBe('<div>sub as sent</div>');
    expect(n.entry[1].resource.text.div).toBe('<div>patient as sent</div>');
    expect(n.entry[1].resource.extension).toEqual([{ url: 'x' }]);
    expect(JSON.stringify(n)).not.toContain('<div>gen');
    expect(aiSystemPrompt(false)).toContain('"grade"');
    expect(aiSystemPrompt(false)).toContain('narratives have been removed');
    expect(aiSystemPrompt(true)).toContain('what does the narrative say that the structured data does not back up');
    expect(aiSystemPrompt(true)).not.toContain('narratives have been removed');
    expect(AI_SYSTEM_PROMPT).toContain('International Patient Summary');
  });
});

describe('the ai_calls table', () => {
  test('is rebuilt from its first shape, keeping the calls', () => {
    const Database = require('better-sqlite3');
    const { IpsStore } = require('../../ips/store');
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ips-db-'));
    const file = path.join(dir, 'ips.db');
    try {
      const db = new Database(file);
      db.exec(`CREATE TABLE projects (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, description TEXT, token TEXT, created TEXT NOT NULL);
        CREATE TABLE ai_calls (project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, at_ms INTEGER NOT NULL);
        INSERT INTO projects (code, name, created) VALUES ('p', 'P', 'now');
        INSERT INTO ai_calls (project_id, at_ms) VALUES (1, 5), (1, 6);`);
      db.close();
      const store = new IpsStore(file);
      expect(store.aiCallsSince(1, 0)).toBe(2);
      const id = store.recordAiCall(1, 7);
      expect(id).toBe(3);
      store.finishAiCall(id, { model: 'm', input: 10, output: 5, cost: 0.01 });
      expect(store.aiUsage(1, 0)).toEqual({ calls: 3, input: 10, output: 5, cost: 0.01, costed: 1 });
      store.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
