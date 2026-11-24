//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * Every core search parameter for R4 and R5 compiles, and every R4 one evaluates without error
 * against the specification's examples. The packages come through the package manager (into
 * the tx module's package cache): if they can't be had, the tests say so and pass.
 */

const path = require('path');
const fs = require('fs');
const folders = require('../../library/folder-setup');
const { PackageManager } = require('../../library/package-manager');
const { deriveDefinitions, Definitions } = require('../../rest/indexing/definitions');
const { Indexer } = require('../../rest/indexing/indexer');

const SERVERS = ['https://packages2.fhir.org/packages', 'https://packages.fhir.org'];

async function packageFolder(id, version) {
  const cache = folders.subDir('terminology-cache');
  const pm = new PackageManager(SERVERS, cache);
  try {
    const name = await pm.fetch(id, version);
    return path.isAbsolute(name) ? name : path.join(cache, name);
  } catch (e) {
    // eslint-disable-next-line no-console -- says why the test passes without checking
    console.log(`rest definitions tests: ${id}#${version} is not available (${e.message}) - skipped`);
    return null;
  }
}

function keyed(defs) {
  let k = 1;
  for (const d of defs.byUrl.values()) {
    d.key = k++;
  }
  return defs;
}

describe('core search parameters', () => {
  test.each([['hl7.fhir.r4.core', '4.0.1', 1300], ['hl7.fhir.r5.core', '5.0.0', 1150]])('%s#%s: every one compiles', async (id, version, atLeast) => {
    const folder = await packageFolder(id, version);
    if (!folder) {
      return;
    }
    const defs = new Definitions(deriveDefinitions([folder], version));
    expect(defs.problems).toEqual([]);
    expect(defs.byUrl.size).toBeGreaterThan(atLeast);
    expect(defs.compartments.get('Patient').size).toBeGreaterThan(50);
  });

  test('R4: every parameter evaluates against the examples', async () => {
    const core = await packageFolder('hl7.fhir.r4.core', '4.0.1');
    const examples = core ? await packageFolder('hl7.fhir.r4.examples', '4.0.1') : null;
    if (!examples) {
      return;
    }
    const defs = keyed(new Definitions(deriveDefinitions([core], '4.0.1')));
    const ix = new Indexer({ definitions: defs, lookups: null, typeKeys: new Map() });
    const dir = fs.existsSync(path.join(examples, 'package')) ? path.join(examples, 'package') : examples;
    const problems = [];
    let n = 0;
    let rows = 0;
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json') && x !== 'package.json' && !x.startsWith('.'))) {
      let r;
      try {
        r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      } catch (e) {
        continue;
      }
      if (!r || !r.resourceType) {
        continue;
      }
      n++;
      const out = ix.extract(r);
      rows += out.rows.length;
      for (const p of out.problems) {
        // the cap on values per parameter isn't a failure
        if (!/more than \d+ values/.test(p)) {
          problems.push(`${f}: ${p}`);
        }
      }
    }
    expect(n).toBeGreaterThan(5000);
    expect(rows).toBeGreaterThan(100000);
    expect(problems).toEqual([]);
  });
});
