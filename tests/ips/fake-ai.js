//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

const http = require('http');
const express = require('express');

/** A fake AI service on a real port: both shapes, answering with what the request's model asks for. */
function fakeService() {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  const calls = [];
  const answerFor = (model, text) => {
    if (model === 'bad-json') {
      return 'Sure! Here you go: {"grade": "B", "summary": "ok"';
    }
    if (model === 'prose') {
      return 'Here is my assessment:\n```json\n{"grade": "c", "summary": "Some issues", "consistency": [{"severity": "high", "finding": "x", "where": "y"}], "missing": ["z"], "terminology": [{"severity": "silly", "finding": "t", "codes": ["http://snomed.info/sct|1"]}]}\n```\nHope that helps.';
    }
    return JSON.stringify({ grade: 'A', summary: `Consistent (${text.length} chars)`, consistency: [], missing: [], terminology: [] });
  };
  app.post('/v1/chat/completions', (req, res) => {
    calls.push({ shape: 'openai', auth: req.get('authorization'), body: req.body });
    if (req.body.model === 'boom') {
      return res.status(500).json({ error: { message: 'kaboom' } });
    }
    if (req.body.model === 'empty') {
      return res.json({ choices: [{ message: { content: '' } }] });
    }
    // 'router' says what it cost, as OpenRouter does
    res.json({ model: req.body.model + '-2026', choices: [{ message: { role: 'assistant', content: answerFor(req.body.model, req.body.messages[1].content) }, finish_reason: req.body.model === 'bad-json' ? 'length' : 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 20, ...(req.body.model === 'router' ? { cost: 0.0042 } : {}) } });
  });
  app.post('/v1/messages', (req, res) => {
    calls.push({ shape: 'anthropic', key: req.get('x-api-key'), version: req.get('anthropic-version'), body: req.body });
    res.json({ model: req.body.model, content: [{ type: 'text', text: answerFor(req.body.model, req.body.messages[0].content) }], stop_reason: req.body.model === 'bad-json' ? 'max_tokens' : 'end_turn', usage: { input_tokens: 50, output_tokens: 10 } });
  });
  app.post('/slow/chat/completions', (req, res) => setTimeout(() => res.json({ choices: [] }), 500));
  const server = http.createServer(app);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}` })));
}

module.exports = { fakeService };
