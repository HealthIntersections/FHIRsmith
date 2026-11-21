// Search and package-document behaviour of the package server, against an in-memory
// database built with the module's own schema.

const express = require('express');
const request = require('supertest');
const sqlite3 = require('sqlite3');
const PackagesModule = require('../../packages/packages');

// [id, version, kind, fhirVersion, canonical, description, dependencies, pubDate, current]
const FIXTURES = [
  ['hl7.fhir.r4.core', '4.0.1', 0, '4.0.1', 'http://hl7.org/fhir', 'FHIR R4 core definitions', [], '2019-11-01', true],
  ['hl7.fhir.r4b.core', '4.3.0', 0, '4.3.0', 'http://hl7.org/fhir', 'FHIR R4B core definitions', [], '2022-05-28', true],
  ['hl7.fhir.uv.ips', '1.1.0', 1, '4.0.1', 'http://hl7.org/fhir/uv/ips', 'International Patient Summary', ['hl7.fhir.r4.core@4.0.1'], '2022-11-01', true],
  ['hl7.fhir.uv.ips', '2.0.0-ballot', 1, '4.0.1', 'http://hl7.org/fhir/uv/ips', 'International Patient Summary', ['hl7.fhir.r4.core@4.0.1'], '2024-09-01', false],
  ['hl7.fhir.uv.extensions.r4b', '5.1.0', 1, '4.3.0', 'http://hl7.org/fhir/extensions', 'Extensions for R4B', ['hl7.fhir.r4b.core@4.3.0'], '2023-03-01', true],
  ['hl7.fhir.r6.core', '6.0.0-ballot3', 0, '6.0.0-ballot3', 'http://hl7.org/fhir', 'FHIR R6 ballot', [], '2025-06-01', true],
  ['@example/scoped', '1.0.0', 2, '5.0.0', 'http://example.org/scoped', 'A scoped template', [], '2025-01-01', true]
];

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) {
        reject(err);
      } else {
        resolve(this.lastID);
      }
    });
  });
}

async function buildModule(configOverrides = {}) {
  const module = new PackagesModule({ countRequest() {} });
  module.config = { database: ':memory:', mirrorPath: '/nonexistent', crawler: { enabled: false }, ...configOverrides };
  module.db = new sqlite3.Database(':memory:');
  await module.createTables();

  const current = {};
  for (const [id, version, kind, fhirVersion, canonical, description, deps, pubDate, isCurrent] of FIXTURES) {
    const key = await run(module.db,
      `INSERT INTO PackageVersions (GUID, PubDate, Indexed, Id, Version, Kind, DownloadCount, Canonical,
         FhirVersions, Hash, Author, License, HomePage, Description, Content)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 'hash', 'HL7', 'CC0-1.0', '', ?, ?)`,
      [`${id}#${version}`, pubDate, pubDate, id, version, kind, canonical, fhirVersion,
        Buffer.from(description, 'utf8'), Buffer.from('tgz')]);
    await run(module.db, 'INSERT INTO PackageFHIRVersions (PackageVersionKey, Version) VALUES (?, ?)', [key, fhirVersion]);
    for (const dep of deps) {
      await run(module.db, 'INSERT INTO PackageDependencies (PackageVersionKey, Dependency) VALUES (?, ?)', [key, dep]);
    }
    if (isCurrent) {
      current[id] = { key, canonical };
    }
  }
  for (const [id, { key, canonical }] of Object.entries(current)) {
    await run(module.db,
      'INSERT INTO Packages (Id, Canonical, DownloadCount, CurrentVersion) VALUES (?, ?, 5, ?)', [id, canonical, key]);
  }
  return module;
}

function appFor(module) {
  const app = express();
  app.use('/packages', module.router);
  return app;
}

const names = body => body.map(p => p.name);

describe('package server search', () => {
  let module;
  let app;

  beforeAll(async () => {
    module = await buildModule();
    app = appFor(module);
  });

  afterAll(() => module.db.close());

  const catalog = query => request(app).get('/packages/catalog').query(query).set('Accept', 'application/json');

  describe('dependency and dependson (stored as id@version)', () => {
    test.each([
      ['hl7.fhir.r4.core'],
      ['hl7.fhir.r4.core|4.0.1'],
      ['hl7.fhir.r4.core#4.0.1'],
      ['hl7.fhir.r4.core@4.0'],
      ['hl7.fhir.r4.core#4.0']
    ])('dependency=%s finds the dependents', async dependency => {
      const res = await catalog({ dependency });
      expect(res.status).toBe(200);
      expect(names(res.body)).toEqual(['hl7.fhir.uv.ips']);
    });

    test('dependency on another version finds nothing', async () => {
      const res = await catalog({ dependency: 'hl7.fhir.r4.core|3.0.2' });
      expect(res.body).toEqual([]);
    });

    test('dependency does not match a package whose id merely starts the same', async () => {
      const res = await catalog({ dependency: 'hl7.fhir.r4' });
      expect(res.body).toEqual([]);
    });

    test('dependson with a version matches every version that has the dependency', async () => {
      const res = await catalog({ dependson: 'hl7.fhir.r4.core#4.0.1' });
      expect(res.body.map(p => `${p.name}#${p.version}`).sort())
        .toEqual(['hl7.fhir.uv.ips#1.1.0', 'hl7.fhir.uv.ips#2.0.0-ballot']);
    });
  });

  describe('fhirversion', () => {
    test.each([
      ['R4', ['hl7.fhir.r4.core', 'hl7.fhir.uv.ips']],
      ['R4B', ['hl7.fhir.r4b.core', 'hl7.fhir.uv.extensions.r4b']],
      ['R5', ['@example/scoped']],
      ['R6', ['hl7.fhir.r6.core']]
    ])('fhirversion=%s', async (fhirversion, expected) => {
      const res = await catalog({ fhirversion });
      expect(res.status).toBe(200);
      expect(names(res.body).sort()).toEqual(expected);
    });
  });

  describe('sort', () => {
    test('sort=fhirversion orders by FHIR version, pre-releases first', async () => {
      const res = await catalog({ sort: 'fhirversion' });
      expect(res.body.map(p => p.fhirVersion))
        .toEqual(['4.0.1', '4.0.1', '4.3.0', '4.3.0', '5.0.0', '6.0.0-ballot3']);
    });

    test('sort=-kind orders by kind, descending', async () => {
      const res = await catalog({ sort: '-kind' });
      const kinds = res.body.map(p => p.kind);
      expect(kinds).toEqual([...kinds].sort().reverse());
      expect(kinds[0]).toBe('fhir.template');
    });

    test('sort=canonical orders by canonical URL', async () => {
      const res = await catalog({ sort: 'canonical' });
      const canonicals = res.body.map(p => p.canonical);
      expect(canonicals).toEqual([...canonicals].sort());
    });

    test('sort=version puts a pre-release before its release', async () => {
      const res = await catalog({ name: 'hl7.fhir.uv.ips#', sort: 'version' });
      expect(res.body.map(p => p.version)).toEqual(['1.1.0', '2.0.0-ballot']);
    });
  });

  describe('objWrapper and prerelease', () => {
    test('objWrapper=false returns a plain array', async () => {
      const res = await catalog({ name: 'hl7.fhir.uv.ips', objWrapper: 'false' });
      expect(Array.isArray(res.body)).toBe(true);
    });

    test('objWrapper=true wraps the results', async () => {
      const res = await catalog({ name: 'hl7.fhir.uv.ips', objWrapper: 'true' });
      expect(res.body.objects.map(o => o.package.name)).toEqual(['hl7.fhir.uv.ips']);
    });

    test('prerelease (sent by the Java PackageClient) is accepted', async () => {
      const res = await catalog({ name: 'hl7.fhir.uv.ips', prerelease: 'true' });
      expect(res.status).toBe(200);
      expect(names(res.body)).toEqual(['hl7.fhir.uv.ips']);
    });
  });

  describe('/-/v1/search (npm)', () => {
    const v1 = query => request(app).get('/packages/-/v1/search').query(query).set('Accept', 'application/json');

    test('accepts the parameters the npm CLI sends', async () => {
      const res = await v1({ text: 'patient summary', size: '20', from: '0', quality: '0.65', popularity: '0.98', maintenance: '0.5' });
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      expect(res.body.objects[0].package.name).toBe('hl7.fhir.uv.ips');
      expect(typeof res.body.time).toBe('string');
    });

    test('results carry the fields the npm CLI reads', async () => {
      const res = await v1({ text: 'ips' });
      const entry = res.body.objects[0];
      expect(entry.package.maintainers).toEqual([]);
      expect(entry.package.keywords).toEqual([]);
      expect(entry.score.final).toBe(1);
      expect(entry.searchScore).toBe(1);
    });

    test('every text term must match', async () => {
      expect((await v1({ text: 'core R4B' })).body.objects.map(o => o.package.name)).toEqual(['hl7.fhir.r4b.core']);
      expect((await v1({ text: 'core nothing-matches' })).body.total).toBe(0);
    });

    test('npm qualifiers are ignored', async () => {
      const res = await v1({ text: 'keywords:fhir ips' });
      expect(res.body.objects.map(o => o.package.name)).toEqual(['hl7.fhir.uv.ips']);
    });

    test('size and from page the results; total counts them all', async () => {
      const all = await v1({ sort: 'name' });
      const page = await v1({ sort: 'name', size: '2', from: '1' });
      expect(page.body.total).toBe(all.body.total);
      expect(page.body.objects.map(o => o.package.name))
        .toEqual(all.body.objects.slice(1, 3).map(o => o.package.name));
    });

    test('combines with the FHIR search parameters', async () => {
      const res = await v1({ text: 'core', fhirversion: 'R4' });
      expect(res.body.objects.map(o => o.package.name)).toEqual(['hl7.fhir.r4.core']);
    });
  });

  describe('package document', () => {
    test('version _id is id@version', async () => {
      const res = await request(app).get('/packages/hl7.fhir.uv.ips').set('Accept', 'application/json');
      expect(res.status).toBe(200);
      expect(res.body.versions['1.1.0']._id).toBe('hl7.fhir.uv.ips@1.1.0');
      expect(res.body.versions['2.0.0-ballot']._id).toBe('hl7.fhir.uv.ips@2.0.0-ballot');
    });
  });
});

describe('package server with bucket storage', () => {
  let module;
  let app;

  beforeAll(async () => {
    module = await buildModule({ bucketPath: 'https://bucket.example.org/packages' });
    app = appFor(module);
  });

  afterAll(() => module.db.close());

  test('tarball and search URLs for a scoped package use the mirror file name', async () => {
    const doc = await request(app).get('/packages/%40example%2Fscoped').set('Accept', 'application/json');
    expect(doc.status).toBe(200);
    expect(doc.body.versions['1.0.0'].dist.tarball).toBe('https://bucket.example.org/packages/$example$scoped-1.0.0.tgz');

    const search = await request(app).get('/packages/catalog').query({ name: 'scoped' }).set('Accept', 'application/json');
    expect(search.body[0].url).toBe('https://bucket.example.org/packages/$example$scoped-1.0.0.tgz');
  });

  test('tarball URL for an unscoped package is unchanged', async () => {
    const doc = await request(app).get('/packages/hl7.fhir.uv.ips').set('Accept', 'application/json');
    expect(doc.body.versions['1.1.0'].dist.tarball).toBe('https://bucket.example.org/packages/hl7.fhir.uv.ips-1.1.0.tgz');
  });
});

describe('compareVersions', () => {
  const module = new PackagesModule({ countRequest() {} });

  test('orders numerically, with pre-releases before their release', () => {
    const versions = ['1.10.0', '1.0.0', '1.0.0-ballot', '1.2.0', '1.0.0-ballot2', '0.9'];
    expect(versions.sort((a, b) => module.compareVersions(a, b)))
      .toEqual(['0.9', '1.0.0-ballot', '1.0.0-ballot2', '1.0.0', '1.2.0', '1.10.0']);
  });

  test('never returns NaN', () => {
    expect(Number.isNaN(module.compareVersions('current', '1.0.0'))).toBe(false);
  });
});

describe('database age', () => {
  const folders = require('../../library/folder-setup');
  const fs = require('fs');
  const path = require('path');

  test('a relative database path is found in the data directory, as initializeDatabase opens it', () => {
    const name = `age-test-${process.pid}.db`;
    const file = folders.filePath('packages', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    try {
      const module = new PackagesModule({ countRequest() {} });
      module.config = { database: name, crawler: { enabled: false } };
      expect(module.getDatabaseAgeInfo().status).toBe('Today');
    } finally {
      fs.unlinkSync(file);
    }
  });

  test('a missing database file is reported', () => {
    const module = new PackagesModule({ countRequest() {} });
    module.config = { database: `missing-${process.pid}.db`, crawler: { enabled: false } };
    expect(module.getDatabaseAgeInfo().status).toBe('No database file');
  });
});
