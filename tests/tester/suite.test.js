//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// The tester's suite (tester/suite), run against this server's own rest endpoint, over HTTP,
// as the web pages run it against any server: every test runs, and passes.

const fs = require('fs');
const os = require('os');
const path = require('path');
const TXModule = require('../../tx/tx');
const { engines, makeApp } = require('../rest/helpers');
const { TestRun } = require('../../tester/engine');
const { count } = require('../../tester/suite');
const { XmlModel } = require('../../library/fhir-model');

const DEFINITIONS = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/rest/r4-definitions.json'), 'utf8'));

describe.each(engines())('the tester\'s suite against the rest endpoint (%s)', (engine) => {
  let t;
  let base;
  let outcome;

  beforeAll(async () => {
    // (t.app is an HTTP server, listening on 127.0.0.1)
    t = await makeApp(engine, {});
    base = `http://127.0.0.1:${t.app.address().port}/r4`;
    const run = new TestRun({ base, allowPrivate: true, xmlModel: async () => new XmlModel(DEFINITIONS.xml) });
    outcome = await run.run();
  }, 300000);

  afterAll(async () => {
    if (t) {
      await t.close();
    }
  });

  test('the run completes', () => {
    expect(outcome.message).toBeNull();
    expect(outcome.outcome).toBe('completed');
  });

  // what isn't a pass here, and why
  const EXPECTED = {
    // the rest module doesn't validate (yet)
    'Errors / A resource that breaks the rules': 'warning',
    // no terminology server here (the run below has one)
    'Search: parameter types / token: :in and :not-in a value set': 'skip',
    'Search: parameter types / token: :below and :above in a hierarchy': 'skip'
  };

  test('every test passes (but those expected not to)', () => {
    const problems = outcome.results.filter(r => r.outcome !== (EXPECTED[`${r.group} / ${r.name}`] || 'pass'))
      .map(r => `${r.group} / ${r.name}: ${r.outcome}: ${r.message}`);
    expect(problems).toEqual([]);
    expect(outcome.results.length).toBe(count());
  });

  test('what the run made is deleted and expunged', () => {
    expect(outcome.cleanup.left).toEqual([]);
    expect(outcome.cleanup.deleted).toBe(outcome.cleanup.created);
    expect(outcome.cleanup.expunged).toBe(outcome.cleanup.created);
  });
});

// The tests that need a terminology server (:in and :not-in, :below and :above), against an
// endpoint that has one: the tx module, in the same app, with closure on
describe.each(engines())('the tester\'s terminology tests against the rest endpoint, with a terminology server (%s)', (engine) => {
  const LIBRARY = path.join(__dirname, '..', 'tx', 'fixtures', 'test-library.yaml');
  let t;
  let tx;
  let txDir;
  let closure;
  let outcome;

  beforeAll(async () => {
    txDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tester-tx-'));
    t = await makeApp(engine, {
      settings: { txServer: '/tx/r5' },
      before: async (app) => {
        tx = new TXModule();
        await tx.initialize({ librarySource: LIBRARY, endpoints: [{ path: '/tx/r5', fhirVersion: '5.0', context: null }],
          closure: { enabled: true, database: path.join(txDir, 'closure.db'), requireUuidNames: true } }, app);
      }
    });
    // what the master's closure job does every few seconds
    let busy = false;
    closure = setInterval(async () => {
      if (!busy) {
        busy = true;
        try {
          while (await t.ep.terminology.updateClosure(t.ep) > 0) {
            // the next batch
          }
        } catch (e) {
          // tried again next time
        } finally {
          busy = false;
        }
      }
    }, 500);
    const base = `http://127.0.0.1:${t.app.address().port}/r4`;
    const run = new TestRun({ base, allowPrivate: true, xmlModel: async () => new XmlModel(DEFINITIONS.xml),
      filter: (test) => /:in and :not-in|:below and :above in a hierarchy/.test(test.name) });
    outcome = await run.run();
  }, 300000);

  afterAll(async () => {
    clearInterval(closure);
    if (t) {
      await t.close();
    }
    if (tx) {
      await tx.shutdown();
    }
    fs.rmSync(txDir, { recursive: true, force: true });
  });

  test(':in, :not-in, :below and :above pass', () => {
    expect(outcome.outcome).toBe('completed');
    expect(outcome.results.map(r => `${r.name}: ${r.outcome}${r.message ? ': ' + r.message : ''}`))
      .toEqual(['token: :in and :not-in a value set: pass', 'token: :below and :above in a hierarchy: pass']);
  });
});
