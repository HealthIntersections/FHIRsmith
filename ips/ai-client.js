//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * A client for the AI services the assessment step can use: two API shapes, which between
 * them cover most of what there is.
 *
 *   openai     the chat-completions API: OpenAI, OpenRouter, LiteLLM, Groq, Ollama, Azure,
 *              Gemini's compatibility endpoint... POST {baseUrl}/chat/completions
 *   anthropic  the Messages API: POST {baseUrl}/v1/messages
 *
 * An account is { provider, baseUrl, model, apiKey }. The client sends one system prompt
 * and one user message and returns the text that comes back, with the token counts the
 * service reports. Responses are bounded, and nothing about the account is in an error's
 * message beyond the provider and model.
 *
 * Also here: the encryption of API keys at rest (AES-256-GCM, a key derived from a server
 * secret), so a copy of the database is not a copy of the accounts.
 *
 * @module ips/ai-client
 */

const crypto = require('crypto');

const PROVIDERS = {
  openai: { name: 'OpenAI-compatible (chat completions)', defaultBaseUrl: 'https://api.openai.com/v1' },
  anthropic: { name: 'Anthropic (Messages API)', defaultBaseUrl: 'https://api.anthropic.com' }
};
const DEFAULT_TIMEOUT_MS = 120000;
// of the answer: a thorough assessment of a big document runs to several thousand tokens
const DEFAULT_MAX_TOKENS = 16384;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const ANTHROPIC_VERSION = '2023-06-01';

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Check an account's shape; throws with a message fit for a settings page. */
function checkAccount(account) {
  if (!isObject(account)) {
    throw new Error('No AI account');
  }
  if (!PROVIDERS[account.provider]) {
    throw new Error(`Unknown AI provider '${account.provider}' (openai or anthropic)`);
  }
  if (typeof account.model !== 'string' || !account.model.trim()) {
    throw new Error('The AI account has no model');
  }
  if (typeof account.apiKey !== 'string' || !account.apiKey) {
    throw new Error('The AI account has no API key');
  }
  const base = typeof account.baseUrl === 'string' && account.baseUrl.trim() ? account.baseUrl.trim() : PROVIDERS[account.provider].defaultBaseUrl;
  let u;
  try {
    u = new URL(base);
  } catch {
    throw new Error('The AI account\'s base URL is not a URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new Error('The AI account\'s base URL must be http(s)');
  }
  return { ...account, baseUrl: base.replace(/\/+$/, '') };
}

/** Read a response body, up to a limit. */
async function readBounded(res, limit) {
  const reader = res.body?.getReader ? res.body.getReader() : null;
  if (!reader) {
    const t = await res.text();
    return t.length > limit ? t.substring(0, limit) : t;
  }
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new Error('The AI service\'s response was too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Ask the service.
 *
 * @param {{provider: string, baseUrl?: string, model: string, apiKey: string}} account
 * @param {{system: string, user: string, maxTokens?: number, timeoutMs?: number, fetch?: Function}} request
 * @returns {Promise<{text: string, usage: {input: number|null, output: number|null, cost: number|null}, model: string, provider: string, truncated: boolean, maxTokens: number}>}
 *   usage.cost: in USD, when the service says (OpenRouter does); truncated: the answer was
 *   cut off at maxTokens
 */
async function complete(account, request) {
  const a = checkAccount(account);
  const doFetch = request.fetch || fetch;
  const maxTokens = Number.isInteger(request.maxTokens) && request.maxTokens > 0 ? request.maxTokens : DEFAULT_MAX_TOKENS;
  const timeoutMs = Number.isInteger(request.timeoutMs) && request.timeoutMs > 0 ? request.timeoutMs : DEFAULT_TIMEOUT_MS;
  let url;
  let headers;
  let body;
  if (a.provider === 'anthropic') {
    url = `${a.baseUrl}/v1/messages`;
    headers = { 'content-type': 'application/json', 'x-api-key': a.apiKey, 'anthropic-version': ANTHROPIC_VERSION };
    body = { model: a.model, max_tokens: maxTokens, system: request.system, messages: [{ role: 'user', content: request.user }] };
  } else {
    url = `${a.baseUrl}/chat/completions`;
    headers = { 'content-type': 'application/json', authorization: `Bearer ${a.apiKey}` };
    body = { model: a.model, max_tokens: maxTokens, temperature: 0, messages: [{ role: 'system', content: request.system }, { role: 'user', content: request.user }] };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  let text;
  try {
    res = await doFetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal, redirect: 'manual' });
    text = await readBounded(res, MAX_RESPONSE_BYTES);
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? `The AI service (${a.provider}, ${a.model}) did not answer within ${timeoutMs} ms` : `The AI service (${a.provider}, ${a.model}) could not be reached: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON: reported below
  }
  if (res.status < 200 || res.status >= 300) {
    const detail = json?.error?.message || json?.message || (typeof json?.error === 'string' ? json.error : '') || '';
    throw new Error(`The AI service (${a.provider}, ${a.model}) answered HTTP ${res.status}${detail ? `: ${String(detail).substring(0, 300)}` : ''}`);
  }
  if (!isObject(json)) {
    throw new Error(`The AI service (${a.provider}, ${a.model}) did not answer with JSON`);
  }
  let out;
  let usage;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  // whether the answer was cut off at the token limit
  let truncated;
  if (a.provider === 'anthropic') {
    out = (Array.isArray(json.content) ? json.content : []).filter(c => c?.type === 'text' && typeof c.text === 'string').map(c => c.text).join('\n');
    usage = { input: num(json.usage?.input_tokens), output: num(json.usage?.output_tokens), cost: null };
    truncated = json.stop_reason === 'max_tokens';
  } else {
    const choice = Array.isArray(json.choices) ? json.choices[0] : null;
    const msg = choice?.message;
    out = typeof msg?.content === 'string' ? msg.content : (Array.isArray(msg?.content) ? msg.content.filter(c => typeof c?.text === 'string').map(c => c.text).join('\n') : '');
    // OpenRouter says what the call cost (in USD) in usage.cost; others don't
    usage = { input: num(json.usage?.prompt_tokens), output: num(json.usage?.completion_tokens), cost: num(json.usage?.cost) };
    truncated = choice?.finish_reason === 'length';
  }
  if (typeof out !== 'string' || !out.trim()) {
    throw new Error(`The AI service (${a.provider}, ${a.model}) answered with no text`);
  }
  return { text: out, usage, model: typeof json.model === 'string' ? json.model : a.model, provider: a.provider, truncated: truncated === true, maxTokens };
}

/**
 * The JSON object in a model's answer: the whole answer, or the first {...} in it (models
 * wrap JSON in prose or code fences however they are asked not to), or null.
 */
function jsonIn(text) {
  if (typeof text !== 'string') {
    return null;
  }
  const tries = [text.trim()];
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fence) {
    tries.push(fence[1].trim());
  }
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) {
    tries.push(text.substring(first, last + 1));
  }
  for (const t of tries) {
    try {
      const v = JSON.parse(t);
      if (isObject(v)) {
        return v;
      }
    } catch {
      // the next
    }
  }
  return null;
}

// list prices, USD per million tokens, for the models a server is likely to use without
// configuring prices (Anthropic's, as published October 2026). They go stale: the
// configuration's prices (modules.ips.ai.prices) override them, by model name or prefix
const DEFAULT_PRICES = {
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 }
};

/**
 * What a call cost, in USD: what the service said, else from a price list - model name (or
 * a prefix of it, the longest wins) -> { input, output } in USD per million tokens - else null.
 */
function costOf(usage, model, prices) {
  if (typeof usage?.cost === 'number') {
    return usage.cost;
  }
  if (!isObject(prices) || typeof model !== 'string' || typeof usage?.input !== 'number' || typeof usage?.output !== 'number') {
    return null;
  }
  let best = null;
  for (const [name, p] of Object.entries(prices)) {
    if ((model === name || model.startsWith(name)) && isObject(p) && (!best || name.length > best.name.length)) {
      best = { name, p };
    }
  }
  if (!best || typeof best.p.input !== 'number' || typeof best.p.output !== 'number') {
    return null;
  }
  return usage.input / 1e6 * best.p.input + usage.output / 1e6 * best.p.output;
}

// ---- keys at rest ----

function keyFrom(secret) {
  return crypto.createHash('sha256').update(`ips-ai-key:${secret}`).digest();
}

/** Encrypt an API key for the database: v1:iv:tag:ciphertext, base64. */
function encryptKey(apiKey, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const enc = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
  return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
}

/** @returns {string|null} the key, or null when it cannot be read (another secret, or damaged) */
function decryptKey(stored, secret) {
  if (typeof stored !== 'string') {
    return null;
  }
  const parts = stored.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    return null;
  }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyFrom(secret), Buffer.from(parts[1], 'base64'));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

module.exports = { complete, checkAccount, jsonIn, costOf, encryptKey, decryptKey, DEFAULT_PRICES, PROVIDERS, MAX_RESPONSE_BYTES, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_TOKENS };
