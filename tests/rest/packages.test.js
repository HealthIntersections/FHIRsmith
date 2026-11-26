//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// Loading packages into the endpoint (rest/packages.js): from initialSettings.loadPackages
// when the database is made, and from the administration page.

const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { engines, makeApp, body, invariants, FHIR_JSON } = require('./helpers');
const { rewriteReferences, sameContent } = require('../../rest/packages');

const PKG = 'test.pkg';

/** A package folder, as the package manager would leave it: <dir>/<id>#<version>/package/... */
function makePackage(dir, id, version, resources, options = {}) {
  const folder = path.join(dir, `${id}#${version}`, 'package');
  fs.mkdirSync(path.join(folder, 'example'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ name: id, version, fhirVersions: [options.fhirVersion || '4.0.1'] }));
  fs.writeFileSync(path.join(folder, '.index.json'), JSON.stringify({ 'index-version': 1, files: [] }));
  resources.forEach((r, i) => fs.writeFileSync(path.join(folder, `${r.resourceType}-${r.id || 'noid' + i}.json`), JSON.stringify(r)));
  (options.examples || []).forEach((r, i) => fs.writeFileSync(path.join(folder, 'example', `${r.resourceType}-${r.id || i}.json`), JSON.stringify(r)));
  return folder;
}

function packageManager(dir) {
  return {
    cacheFolder: dir,
    fetch: async (id, version) => {
      const versions = fs.readdirSync(dir).filter(f => f.startsWith(id + '#')).map(f => f.split('#')[1]).sort();
      const v = version || versions[versions.length - 1];
      if (!versions.includes(v)) {
        throw new Error(`The package ${id}#${version || '(latest)'} wasn't found`);
      }
      return `${id}#${v}`;
    }
  };
}

const PACKAGE = [
  { resourceType: 'Organization', id: 'org1', name: 'Acme' },
  // the same as what's there already: left alone
  { resourceType: 'Organization', id: 'same', name: 'Same' },
  // a different one is there already: a new id
  { resourceType: 'Practitioner', id: 'prac1', name: [{ family: 'FromPackage' }] },
  { resourceType: 'Patient', id: 'pat1', managingOrganization: { reference: 'Organization/org1' },
    generalPractitioner: [{ reference: 'Practitioner/prac1' }],
    extension: [{ url: 'http://example.org/ext', valueReference: { reference: 'Practitioner/prac1/_history/1' } }] },
  // no id: one is given
  { resourceType: 'Observation', status: 'final', code: { text: 'x' }, subject: { reference: 'Patient/pat1' }, performer: [{ reference: 'Practitioner/prac1' }] },
  // a type this endpoint doesn't have
  { resourceType: 'Basic', id: 'b1', code: { text: 'x' } },
  // can't be stored: it refers to a contained resource that isn't there
  { resourceType: 'Patient', id: 'broken', generalPractitioner: [{ reference: '#nobody' }] },
  // nor this one, with no id
  { resourceType: 'Patient', generalPractitioner: [{ reference: '#nobody' }] }
];

describe.each(engines())('loading packages (%s)', (engine) => {
  let dir;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rest-packages-'));
    makePackage(dir, PKG, '1.0.0', PACKAGE, { examples: [{ resourceType: 'Patient', id: 'example1', name: [{ family: 'Example' }] }] });
    makePackage(dir, 'r5.pkg', '1.0.0', [{ resourceType: 'Patient', id: 'r5' }], { fhirVersion: '5.0.0' });
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const read = async (t, url) => {
    const r = await request(t.app).get(url);
    return r.status === 200 ? r.body : null;
  };
  const loads = (t) => t.ep.db.read(q => q.all('SELECT * FROM PackageLoads ORDER BY LoadKey'));

  describe('from the administration page', () => {
    let t;
    const form = (fields) => request(t.app).post('/r4/_admin/packages').type('form').send(fields);
    const page = (url) => request(t.app).get(url).set('Accept', 'text/html');

    beforeAll(async () => {
      t = await makeApp(engine, { packageManager: packageManager(dir) });
      const put = (r) => request(t.app).put(`/r4/${r.resourceType}/${r.id}`).set('Content-Type', FHIR_JSON).send(body(r));
      expect((await put({ resourceType: 'Practitioner', id: 'prac1', name: [{ family: 'AlreadyHere' }] })).status).toBe(201);
      expect((await put({ resourceType: 'Organization', id: 'same', name: 'Same' })).status).toBe(201);
    });

    afterAll(async () => {
      await t.close();
    });

    test('queued from the page, and loaded by the master', async () => {
      const r = await form({ action: 'load', package: PKG, version: '1.0.0' });
      expect(r.status).toBe(303);
      expect(r.headers.location).toBe('/r4/_admin/packages');
      expect((await page('/r4/_admin/packages')).text).toContain('queued');
      expect(await t.ep.packages.runQueued()).toBe(true);
      const [load] = await loads(t);
      expect(load.Status).toBe(2);
      expect(load.Message).toBe('3 created, 1 given new ids, 1 unchanged, 1 skipped, 2 failed');
    });

    test('each resource at its id; one with a different resource there already gets a new id, and references to it follow', async () => {
      expect((await read(t, '/r4/Organization/org1')).name).toBe('Acme');
      // what was there is untouched
      expect((await read(t, '/r4/Practitioner/prac1')).name[0].family).toBe('AlreadyHere');
      expect((await read(t, '/r4/Organization/same')).meta.versionId).toBe('1');
      const pat = await read(t, '/r4/Patient/pat1');
      const newRef = pat.generalPractitioner[0].reference;
      expect(newRef).toMatch(/^Practitioner\/(?!prac1$)[^/]+$/);
      expect((await read(t, `/r4/${newRef}`)).name[0].family).toBe('FromPackage');
      // a version-specific reference, deep in an extension, too
      expect(pat.extension[0].valueReference.reference).toBe(newRef);
      expect(pat.managingOrganization.reference).toBe('Organization/org1');
      // the one with no id, found by what it refers to (the references are indexed)
      const obs = await read(t, `/r4/Observation?performer=${newRef}`);
      expect(obs.entry).toHaveLength(1);
      expect(obs.entry[0].resource.subject.reference).toBe('Patient/pat1');
      // the report
      const [load] = await loads(t);
      const report = JSON.parse(load.Report);
      expect(report.renamed).toEqual([{ from: 'Practitioner/prac1', to: newRef }]);
      expect(report.skippedTypes).toEqual({ Basic: 1 });
      expect(report.errors.map(e => e.file).sort()).toEqual(['Patient-broken.json', 'Patient-noid7.json']);
      // the examples weren't asked for
      expect(await read(t, '/r4/Patient/example1')).toBe(null);
      // no reservation left behind for the one with no id that failed
      expect(await invariants(t.ep)).toEqual([]);
    });

    test('the page shows the loads, and a report', async () => {
      const p = await page('/r4/_admin/packages');
      expect(p.text).toContain(`${PKG}#1.0.0`);
      expect(p.text).toContain('loaded');
      const [load] = await loads(t);
      const d = await page(`/r4/_admin/packages?load=${load.LoadKey}`);
      expect(d.status).toBe(200);
      expect(d.text).toContain('Practitioner/prac1');
      expect(d.text).toContain('Patient-broken.json');
      expect(d.text).toContain('Basic (1)');
    });

    test('loading it again changes nothing, renamed resources included', async () => {
      const before = await t.ep.db.read(q => q.get('SELECT COUNT(*) AS N FROM Versions'));
      await form({ action: 'load', package: PKG });
      await t.ep.packages.runQueued();
      const all = await loads(t);
      expect(all[1].Status).toBe(2);
      expect(all[1].Message).toBe('0 created, 0 given new ids, 5 unchanged, 1 skipped, 2 failed');
      const after = await t.ep.db.read(q => q.get('SELECT COUNT(*) AS N FROM Versions'));
      expect(Number(after.N)).toBe(Number(before.N));
    });

    test('a resource referring to one renamed now is renamed too', async () => {
      // the Organization at 'same' is changed: the package's is given a new id, and anything
      // in the package referring to it compares differently (none here), while org1 is untouched
      const r = await request(t.app).put('/r4/Organization/same').set('Content-Type', FHIR_JSON).send(body({ resourceType: 'Organization', id: 'same', name: 'Changed' }));
      expect(r.status).toBe(200);
      await form({ action: 'load', package: PKG, examples: '1' });
      await t.ep.packages.runQueued();
      const all = await loads(t);
      expect(all[2].Message).toBe('1 created, 1 given new ids, 4 unchanged, 1 skipped, 2 failed');
      expect((await read(t, '/r4/Patient/example1')).name[0].family).toBe('Example');
      expect(await invariants(t.ep)).toEqual([]);
    });

    test('when a resource is given a new id, those referring to it in the package are too', async () => {
      // org1 is changed: the package's org1 gets a new id; pat1 refers to it, so the package's
      // pat1 no longer matches what's stored, and gets one too; and so does the Observation
      // (no id) that refers to pat1
      const r = await request(t.app).put('/r4/Organization/org1').set('Content-Type', FHIR_JSON).send(body({ resourceType: 'Organization', id: 'org1', name: 'Changed' }));
      expect(r.status).toBe(200);
      await form({ action: 'load', package: PKG });
      await t.ep.packages.runQueued();
      const all = await loads(t);
      expect(all[3].Message).toBe('1 created, 2 given new ids, 2 unchanged, 1 skipped, 2 failed');
      const report = JSON.parse(all[3].Report);
      const to = Object.fromEntries(report.renamed.map(x => [x.from, x.to]));
      const pat = await read(t, `/r4/${to['Patient/pat1']}`);
      expect(pat.managingOrganization.reference).toBe(to['Organization/org1']);
      expect((await read(t, `/r4/${to['Organization/org1']}`)).name).toBe('Acme');
      const obs = await read(t, `/r4/Observation?subject=${to['Patient/pat1']}`);
      expect(obs.entry).toHaveLength(1);
      // what was there is untouched
      expect((await read(t, '/r4/Patient/pat1')).managingOrganization.reference).toBe('Organization/org1');
      expect(await invariants(t.ep)).toEqual([]);
    });

    test('a package for another FHIR version, or one that can\'t be found, fails', async () => {
      await form({ action: 'load', package: 'r5.pkg' });
      await t.ep.packages.runQueued();
      await form({ action: 'load', package: 'no.such.pkg', version: '1.0.0' });
      await t.ep.packages.runQueued();
      const all = await loads(t);
      expect(all[4].Status).toBe(3);
      expect(all[4].Message).toMatch(/is for FHIR 5\.0\.0, and this endpoint is FHIR 4\.0\.1/);
      expect(all[5].Status).toBe(3);
      expect(all[5].Message).toMatch(/wasn't found/);
      expect(await read(t, '/r4/Patient/r5')).toBe(null);
    });

    test('a queued load can be cancelled; bad requests are refused', async () => {
      await form({ action: 'load', package: PKG });
      const queued = (await loads(t)).find(l => l.Status === 0);
      expect((await form({ action: 'cancel', key: String(queued.LoadKey) })).status).toBe(303);
      expect((await loads(t)).find(l => l.Status === 0)).toBeUndefined();
      expect((await form({ action: 'load', package: 'not a package' })).status).toBe(400);
      expect((await form({ action: 'load', package: PKG, version: 'has space' })).status).toBe(400);
      expect((await form({ action: 'explode' })).status).toBe(400);
    });
  });

  test('from initialSettings.loadPackages, when the database is made (and only then)', async () => {
    let t = await makeApp(engine, { packageManager: packageManager(dir), settings: { loadPackages: [`${PKG}#1.0.0`, { package: PKG, examples: true }] } });
    try {
      let all = await loads(t);
      expect(all.map(l => [l.Package, l.Version, l.Examples, l.Status, l.RequestedBy])).toEqual([
        [PKG, '1.0.0', 0, 0, 'initialSettings'], [PKG, null, 1, 0, 'initialSettings']]);
      while (await t.ep.packages.runQueued()) {
        // the next
      }
      all = await loads(t);
      expect(all.map(l => l.Status)).toEqual([2, 2]);
      expect((await read(t, '/r4/Practitioner/prac1')).name[0].family).toBe('FromPackage');
      expect((await read(t, '/r4/Patient/example1'))).not.toBe(null);
      // started again on the same database: nothing more queued
      await t.stop();
      t = await makeApp(engine, { dir: t.dir, keep: true, packageManager: packageManager(dir), settings: { loadPackages: [`${PKG}#1.0.0`] } });
      expect(await loads(t)).toHaveLength(2);
    } finally {
      await t.close();
    }
  });

  test('a load running when the server stopped is marked as failed at the start', async () => {
    let t = await makeApp(engine, { packageManager: packageManager(dir) });
    try {
      await t.ep.db.write(q => q.run("INSERT INTO PackageLoads (Package, Version, Examples, Status, Requested, Started) VALUES ('x', '1', 0, 1, 1, 1)"));
      await t.stop();
      t = await makeApp(engine, { dir: t.dir, keep: true, packageManager: packageManager(dir) });
      const [l] = await loads(t);
      expect(l.Status).toBe(3);
      expect(l.Message).toMatch(/The server stopped while it was loading/);
    } finally {
      await t.close();
    }
  });
});

describe('package loading helpers', () => {
  test('rewriteReferences: only Type/id and Type/id/_history/n, anywhere', () => {
    const r = { a: { reference: 'Patient/p' }, b: [{ reference: 'Patient/p/_history/2' }], c: { reference: 'http://x/Patient/p' },
      d: { reference: 'Patient/q' }, e: { reference: '#p' }, f: { nested: [{ deeper: { reference: 'Patient/p' } }] }, reference: 'not an object' };
    rewriteReferences(r, new Map([['Patient/p', 'NEW']]));
    expect(r).toEqual({ a: { reference: 'Patient/NEW' }, b: [{ reference: 'Patient/NEW' }], c: { reference: 'http://x/Patient/p' },
      d: { reference: 'Patient/q' }, e: { reference: '#p' }, f: { nested: [{ deeper: { reference: 'Patient/NEW' } }] }, reference: 'not an object' });
  });

  test('sameContent: ignores meta and the order of properties', () => {
    expect(sameContent({ resourceType: 'X', id: '1', a: 1, b: { c: 2, d: 3 }, meta: { versionId: '3' } }, { b: { d: 3, c: 2 }, a: 1, id: '1', resourceType: 'X' })).toBe(true);
    expect(sameContent({ resourceType: 'X', id: '1', a: 1 }, { resourceType: 'X', id: '1', a: 2 })).toBe(false);
    expect(sameContent({ resourceType: 'X', a: [1, 2] }, { resourceType: 'X', a: [2, 1] })).toBe(false);
  });
});
