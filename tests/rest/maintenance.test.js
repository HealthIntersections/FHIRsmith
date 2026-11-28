//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// Resetting the database (rest/maintenance.js): wiped and made again from config.json, with
// every request answered 'under maintenance' meanwhile.

const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
const { engines, makeApp, body, invariants, FHIR_JSON } = require('./helpers');
const settingsStore = require('../../rest/endpoint/settings');

const PKG = 'test.reset';

function makePackage(dir, id, version, resources) {
  const folder = path.join(dir, `${id}#${version}`, 'package');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ name: id, version, fhirVersions: ['4.0.1'] }));
  fs.writeFileSync(path.join(folder, '.index.json'), JSON.stringify({ 'index-version': 1, files: [] }));
  resources.forEach(r => fs.writeFileSync(path.join(folder, `${r.resourceType}-${r.id}.json`), JSON.stringify(r)));
}

function packageManager(dir) {
  return {
    cacheFolder: dir,
    fetch: async (id, version) => {
      if (!fs.existsSync(path.join(dir, `${id}#${version}`))) {
        throw new Error(`The package ${id}#${version} wasn't found`);
      }
      return `${id}#${version}`;
    }
  };
}

const RESOURCES = [
  { resourceType: 'Organization', id: 'org1', name: 'Acme' },
  { resourceType: 'Patient', id: 'pat1', name: [{ family: 'Packaged' }], managingOrganization: { reference: 'Organization/org1' } }
];

describe.each(engines())('resetting the database (%s)', (engine) => {
  let dir;
  let t;
  const options = () => ({ packageManager: packageManager(dir), settings: { loadPackages: [`${PKG}#1.0.0`] }, maintenanceGraceMs: 0 });
  const get = (url, accept = FHIR_JSON) => request(t.app).get(url).set('Accept', accept);
  const form = (fields) => request(t.app).post('/r4/_admin/reset').type('form').send(fields);
  const state = async (ep = t.ep) => {
    const m = await ep.maintenance.current(true);
    return m ? m.state : null;
  };
  /** Run the maintenance task until it is over (or has failed) */
  const runReset = async (ep = t.ep) => {
    for (let i = 0; i < 20 && ['requested', 'wiping', 'loading'].includes(await state(ep)); i++) {
      await ep.runner.runNow('maintenance');
    }
    return state(ep);
  };

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rest-reset-'));
    makePackage(dir, PKG, '1.0.0', RESOURCES);
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('from the reset page', () => {
    beforeAll(async () => {
      t = await makeApp(engine, options());
      // the new database's packages
      while (await t.ep.packages.runQueued()) {
        // loaded
      }
      expect((await get('/r4/Patient/pat1')).status).toBe(200);
      const r = await request(t.app).put('/r4/Patient/extra').set('Content-Type', FHIR_JSON).send(body({ resourceType: 'Patient', id: 'extra' }));
      expect(r.status).toBe(201);
      await settingsStore.set(t.ep.db, { name: 'Changed since' });
    });

    afterAll(async () => {
      await t.close();
    });

    test('the page says what will happen, and wants the path typed to confirm', async () => {
      const page = await get('/r4/_admin/reset', 'text/html');
      expect(page.status).toBe(200);
      expect(page.text).toContain('deletes everything in it');
      expect(page.text).toContain(`${PKG}#1.0.0`);
      const wrong = await form({ action: 'reset', confirm: '/r5' });
      expect(wrong.status).toBe(400);
      expect(await state()).toBeNull();
    });

    test('once asked for, every request is answered 503, under maintenance', async () => {
      const r = await form({ action: 'reset', confirm: '/r4' });
      expect(r.status).toBe(303);
      expect(r.headers.location).toBe('/r4/_admin/reset');
      expect(await state()).toBe('requested');
      t.ep.maintenance.checkedAt = 0;
      const api = await get('/r4/Patient/pat1');
      expect(api.status).toBe(503);
      expect(api.headers['retry-after']).toBe('30');
      expect(api.body.resourceType).toBe('OperationOutcome');
      expect(api.body.issue[0].code).toBe('transient');
      expect(api.body.issue[0].diagnostics).toMatch(/under maintenance \(requested/);
      expect((await get('/r4/metadata')).status).toBe(503);
      expect((await request(t.app).post('/r4/Patient').set('Content-Type', FHIR_JSON).send(body({ resourceType: 'Patient' }))).status).toBe(503);
      expect((await get('/r4/Patient', 'text/html')).status).toBe(503);
      expect((await get('/r4/_admin/packages', 'text/html')).status).toBe(503);
      expect((await get('/r4/_async/x')).status).toBe(503);
      // asking again: it's under way
      expect((await form({ action: 'reset', confirm: '/r4' })).status).toBe(409);
      // the reset page still answers, and says how it is going
      const page = await get('/r4/_admin/reset', 'text/html');
      expect(page.status).toBe(200);
      expect(page.text).toContain('The endpoint is under maintenance');
      expect(page.text).toContain('requested');
    });

    test('the jobs wipe it and make it again from config.json; when the packages are loaded, it is over', async () => {
      const epochBefore = t.ep.epoch;
      await t.ep.runner.runNow('maintenance');
      expect(await state()).toBe('loading');
      // still under maintenance while the packages load
      t.ep.maintenance.checkedAt = 0;
      expect((await get('/r4/Patient/pat1')).status).toBe(503);
      const page = await get('/r4/_admin/reset', 'text/html');
      expect(page.text).toContain(PKG);
      expect(await runReset()).toBeNull();
      expect(t.ep.epoch).not.toBe(epochBefore);
      // what the packages have, and nothing else; the settings as config.json has them
      expect((await get('/r4/Patient/pat1')).body.name[0].family).toBe('Packaged');
      expect((await get('/r4/Organization/org1')).status).toBe(200);
      expect((await get('/r4/Patient/extra')).status).toBe(404);
      expect(t.ep.settings.name).toBe('FHIRsmith REST server');
      const loads = await t.ep.db.read(q => q.all('SELECT Package, Status, RequestedBy FROM PackageLoads'));
      expect(loads).toEqual([{ Package: PKG, Status: 2, RequestedBy: 'initialSettings' }]);
      expect(await invariants(t.ep)).toEqual([]);
      // and it works as before
      const r = await request(t.app).post('/r4/Patient').set('Content-Type', FHIR_JSON).send(body({ resourceType: 'Patient', name: [{ family: 'After' }] }));
      expect(r.status).toBe(201);
      expect((await get('/r4/Patient?family=After')).body.total).toBe(1);
      expect((await get('/r4/Patient?organization=Organization/org1')).body.total).toBe(1);
    });
  });

  test('another process notices, and sets itself up from the new database', async () => {
    t = await makeApp(engine, options());
    const worker = await makeApp(engine, { ...options(), dir: t.dir, keep: true, master: false, jobs: false });
    try {
      while (await t.ep.packages.runQueued()) {
        // loaded
      }
      // the worker has keys cached from the database as it was
      expect((await request(worker.app).get('/r4/Patient?organization=Organization/org1')).body.total).toBe(1);
      expect(await t.ep.maintenance.request('admin')).toBe(true);
      worker.ep.maintenance.checkedAt = 0;
      expect((await request(worker.app).get('/r4/Patient/pat1')).status).toBe(503);
      expect(await runReset()).toBeNull();
      worker.ep.maintenance.checkedAt = 0;
      worker.ep.lastGenerationCheck = 0;
      const r = await request(worker.app).post('/r4/Patient').set('Content-Type', FHIR_JSON)
        .send(body({ resourceType: 'Patient', managingOrganization: { reference: 'Organization/org1' }, meta: { tag: [{ system: 'http://x', code: 'y' }] } }));
      expect(r.status).toBe(201);
      expect(worker.ep.epoch).toBe(t.ep.epoch);
      expect((await request(t.app).get(`/r4/Patient?organization=Organization/org1&_tag=http://x|y`)).body.total).toBe(1);
      expect(await invariants(t.ep)).toEqual([]);
    } finally {
      await worker.stop();
      await t.close();
    }
  });

  test('a reset that fails stays under maintenance, until it is tried again or ended', async () => {
    const errors = [];
    const log = { info: () => {}, warn: () => {}, debug: () => {}, error: (m) => errors.push(m) };
    t = await makeApp(engine, { ...options(), log });
    try {
      expect((await form({ action: 'reset', confirm: '/r4' })).status).toBe(303);
      const setup = jest.spyOn(t.ep, 'setup').mockRejectedValueOnce(new Error('the disk is full'));
      expect(await runReset()).toBe('failed');
      setup.mockRestore();
      expect(errors.some(e => /the reset failed: Error: the disk is full/.test(e))).toBe(true);
      t.ep.maintenance.checkedAt = 0;
      const api = await get('/r4/Patient/pat1');
      expect(api.status).toBe(503);
      expect(api.body.issue[0].diagnostics).toContain('the disk is full');
      const page = await get('/r4/_admin/reset', 'text/html');
      expect(page.text).toContain('Try the reset again');
      expect(page.text).toContain('End maintenance');
      // tried again: it goes this time
      expect((await form({ action: 'retry' })).status).toBe(303);
      expect(await runReset()).toBeNull();
      expect((await get('/r4/Patient/pat1')).status).toBe(200);
      expect((await form({ action: 'end' })).status).toBe(409);
      // ended instead: the database as the failed reset left it, set up again as it's used
      expect((await form({ action: 'reset', confirm: '/r4' })).status).toBe(303);
      jest.spyOn(t.ep, 'setup').mockRejectedValueOnce(new Error('again'));
      expect(await runReset()).toBe('failed');
      jest.restoreAllMocks();
      expect((await form({ action: 'end' })).status).toBe(303);
      t.ep.maintenance.checkedAt = 0;
      expect((await get('/r4/Patient/pat1')).status).toBe(404);
      expect((await get('/r4/metadata')).status).toBe(200);
    } finally {
      jest.restoreAllMocks();
      await t.close();
    }
  });

  test('a server that stops part way carries on when it starts again', async () => {
    t = await makeApp(engine, { ...options(), keep: true });
    let again = null;
    try {
      while (await t.ep.packages.runQueued()) {
        // loaded
      }
      expect(await t.ep.maintenance.request('admin')).toBe(true);
      await t.stop();
      again = await makeApp(engine, { ...options(), dir: t.dir, keep: true });
      expect(again.ep.ready).toBe(false);
      expect((await request(again.app).get('/r4/Patient/pat1')).status).toBe(503);
      expect(await runReset(again.ep)).toBeNull();
      expect((await request(again.app).get('/r4/Patient/pat1')).status).toBe(200);
      expect(await invariants(again.ep)).toEqual([]);
    } finally {
      if (again) {
        await again.stop();
      }
      if (engine === 'sqlite') {
        fs.rmSync(t.dir, { recursive: true, force: true });
      }
    }
  });
});
