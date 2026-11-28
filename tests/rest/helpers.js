//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * Helpers for the rest module's tests: the engines to run on (SQLite always; MySQL when
 * FHIRSMITH_TEST_MYSQL says where), and an express app with one endpoint.
 *
 * FHIRSMITH_TEST_MYSQL is host:port/database:user, with the password in
 * FHIRSMITH_TEST_MYSQL_PASSWORD. The database is emptied before each app is made.
 */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const RestModule = require('../../rest/rest');
const { TABLES } = require('../../rest/database/schema');

const DEFINITIONS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'rest', 'r4-definitions.json'), 'utf8'));
const FHIR_JSON = 'application/fhir+json';

function mysqlConfig() {
  const v = process.env.FHIRSMITH_TEST_MYSQL;
  if (!v) {
    return null;
  }
  const m = /^([^:/]+)(?::(\d+))?\/([^:]+):(.+)$/.exec(v);
  if (!m) {
    throw new Error('FHIRSMITH_TEST_MYSQL is host:port/database:user');
  }
  return { type: 'mysql', host: m[1], port: m[2] ? Number(m[2]) : 3306, database: m[3], user: m[4], passwordEnv: 'FHIRSMITH_TEST_MYSQL_PASSWORD' };
}

let warned = false;
/** The engines to test on: [['sqlite'], ['mysql']?] for describe.each */
function engines() {
  const list = [['sqlite']];
  if (mysqlConfig()) {
    list.push(['mysql']);
  } else if (!warned) {
    warned = true;
    // eslint-disable-next-line no-console -- says that the MySQL half didn't run
    console.log('rest tests: FHIRSMITH_TEST_MYSQL is not set - the MySQL half is skipped');
  }
  return list;
}

async function emptyMysql(cfg) {
  const mysql = require('mysql2/promise');
  const conn = await mysql.createConnection({ host: cfg.host, port: cfg.port, user: cfg.user, password: process.env[cfg.passwordEnv], database: cfg.database });
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of [...TABLES.map(x => x.name), 'TextIndex', 'Contained', 'ParamConcepts', 'ValueSets', 'ValueSetMembers', 'PackageLoads',
      'ObservationValues', 'ObservationCodes', 'AsyncJobs', 'JobFiles', 'Maintenance']) {
      await conn.query(`DROP TABLE IF EXISTS ${t}`);
    }
  } finally {
    await conn.end();
  }
}

const silent = { info: () => {}, warn: () => {}, error: (...a) => console.error(...a), debug: () => {} };

/**
 * An app with one endpoint at /r4.
 * @param {string} engine - 'sqlite' or 'mysql'
 * @param {Object} [options]
 * @param {Object} [options.settings] - initialSettings
 * @param {Object} [options.types] - per-type settings
 * @param {function(req): Object|null} [options.principal] - who a request is (default an
 *   administrator)
 * @param {boolean} [options.master]
 * @param {string} [options.dir] - the data folder (to open the same SQLite database again)
 * @returns {Promise<{app, mod, ep, dir, stop, close}>} stop() ends the app and leaves its data;
 *   close() deletes the data too (SQLite, unless options.keep). app is a server listening on 127.0.0.1, for
 *   supertest's request(app): given an Express app, supertest starts a server on port 0 for
 *   each request, on every address, and the system may give it a port that something else
 *   holds on one address (TextMate's rmate server holds 52698 on macOS), whose answer the
 *   test then gets ("Parse Error: Expected HTTP/"). Bound to 127.0.0.1, the server is never
 *   given a port that is taken there, and there is one for all the app's requests
 */
async function makeApp(engine, options = {}) {
  const dir = options.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'fhirsmith-rest-'));
  let database;
  if (engine === 'mysql') {
    database = mysqlConfig();
    if (!options.dir) {
      await emptyMysql(database);
    }
  } else {
    database = { type: 'sqlite', file: path.join(dir, 'test.db') };
  }
  const app = express();
  app.use(express.raw({ type: 'application/fhir+json', limit: '20mb' }));
  // as server.js: the text kept alongside (req.rawBody)
  app.use(express.json({ limit: '20mb', verify: (req, res, buf) => {
    req.rawBody = buf;
  } }));
  if (options.before) {
    // something else on the same app (the tx module, as a terminology server)
    await options.before(app);
  }
  const mod = new RestModule(null, options.log || silent);
  const admin = { id: 1, login: 'admin', name: 'Admin', isAdmin: true, has: () => true };
  await mod.initialize({
    endpoints: [{ path: '/r4', fhirVersion: '4.0.1', database, baseUrl: 'http://test.example/r4', initialSettings: { audit: 'off', ...(options.settings || {}) }, types: options.types }]
  }, app, {
    derived: () => DEFINITIONS,
    packageManager: options.packageManager,
    master: options.master !== false,
    jobs: options.jobs,
    localBase: options.localBase,
    maintenanceGraceMs: options.maintenanceGraceMs,
    principal: options.principal || (async () => admin),
    principalById: options.principalById || (async (id) => (String(id) === String(admin.id) ? admin : null))
  });
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  // a test that forgets to stop it doesn't keep jest from exiting
  server.unref();
  // the server and the module, leaving the data (to open the same database again)
  const stop = async () => {
    if (server.listening) {
      // supertest's connections are kept alive: close them, or close() waits for them
      server.closeAllConnections();
      await new Promise(resolve => server.close(() => resolve()));
    }
    await mod.shutdown();
  };
  return {
    app: server, mod, ep: mod.endpoints[0], dir, stop,
    close: async () => {
      await stop();
      if (!options.keep && engine === 'sqlite') {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  };
}

/** A JSON body for supertest */
function body(resource) {
  return JSON.stringify(resource);
}

/**
 * Row counts of every table: equal before and after a failed transaction means it left nothing.
 * @param {Object} ep - an Endpoint
 */
async function snapshot(ep) {
  return ep.db.read(async (q) => {
    const out = {};
    for (const t of [...TABLES.map(x => x.name), 'TextIndex', 'Contained', 'ParamConcepts', 'ValueSets', 'ValueSetMembers', 'PackageLoads',
      'ObservationValues', 'ObservationCodes', 'AsyncJobs', 'JobFiles', 'Maintenance']) {
      const r = await q.get(`SELECT COUNT(*) AS N FROM ${t}`);
      out[t] = Number(r.N);
    }
    return out;
  });
}

/**
 * What must always be true of the database, whatever happened: no reservation left without a
 * version, versions numbered upwards from 1, Ids pointing at the newest version, deletions marked, index
 * rows only for resources that aren't deleted, references to local resources keyed when the
 * target exists, and a subscription queue row for every version.
 * @param {Object} ep
 * @returns {Promise<string[]>} what is wrong (empty if nothing)
 */
async function invariants(ep) {
  const problems = [];
  await ep.db.read(async (q) => {
    const ids = await q.all('SELECT ResourceKey, TypeKey, Id, MostRecent, Deleted FROM Ids');
    const versions = await q.all('SELECT VersionKey, ResourceKey, VersionId, Operation FROM Versions ORDER BY ResourceKey, VersionId');
    const byRes = new Map();
    for (const v of versions) {
      const k = Number(v.ResourceKey);
      if (!byRes.has(k)) {
        byRes.set(k, []);
      }
      byRes.get(k).push(v);
    }
    for (const i of ids) {
      const k = Number(i.ResourceKey);
      const vs = byRes.get(k) || [];
      if (i.MostRecent === null) {
        problems.push(`Ids ${k} (${i.Id}) has no version: a reservation was left behind`);
        continue;
      }
      // numbered upwards from 1 (gaps where versions were expunged)
      vs.forEach((v, n) => {
        if (n > 0 ? Number(v.VersionId) <= Number(vs[n - 1].VersionId) : Number(v.VersionId) < 1) {
          problems.push(`resource ${k} (${i.Id}): version ${n + 1} is numbered ${v.VersionId}`);
        }
      });
      const last = vs[vs.length - 1];
      if (!last || Number(last.VersionKey) !== Number(i.MostRecent)) {
        problems.push(`resource ${k} (${i.Id}): MostRecent is not the newest version`);
      } else if ((Number(last.Operation) === 3) !== !!Number(i.Deleted)) {
        problems.push(`resource ${k} (${i.Id}): Deleted doesn't match its newest version`);
      }
    }
    for (const t of ['IndexStrings', 'IndexTokens', 'IndexDates', 'IndexReferences', 'IndexUris', 'IndexQuantities', 'IndexNumbers', 'Compartments',
      'ObservationValues']) {
      const r = await q.get(`SELECT COUNT(*) AS N FROM ${t} x JOIN Ids i ON i.ResourceKey = x.ResourceKey WHERE i.Deleted = 1`);
      if (Number(r.N)) {
        problems.push(`${t} has ${r.N} rows for deleted resources`);
      }
      const o = await q.get(`SELECT COUNT(*) AS N FROM ${t} x LEFT JOIN Ids i ON i.ResourceKey = x.ResourceKey WHERE i.ResourceKey IS NULL AND x.ResourceKey > 0`);
      if (Number(o.N)) {
        problems.push(`${t} has ${o.N} rows for resources that don't exist`);
      }
      // contained resources are indexed under -ContainedKey
      const c = await q.get(`SELECT COUNT(*) AS N FROM ${t} x LEFT JOIN Contained c ON c.ContainedKey = -x.ResourceKey WHERE x.ResourceKey < 0 AND c.ContainedKey IS NULL`);
      if (Number(c.N)) {
        problems.push(`${t} has ${c.N} rows for contained resources that aren't in Contained`);
      }
    }
    const oc = await q.get('SELECT COUNT(*) AS N FROM ObservationCodes c LEFT JOIN ObservationValues v ON v.ValueKey = c.ValueKey WHERE v.ValueKey IS NULL');
    if (Number(oc.N)) {
      problems.push(`ObservationCodes has ${oc.N} rows for values that aren't in ObservationValues`);
    }
    const cDeleted = await q.get('SELECT COUNT(*) AS N FROM Contained c JOIN Ids i ON i.ResourceKey = c.ResourceKey WHERE i.Deleted = 1');
    if (Number(cDeleted.N)) {
      problems.push(`Contained has ${cDeleted.N} rows for deleted resources`);
    }
    const cOrphans = await q.get('SELECT COUNT(*) AS N FROM Contained c LEFT JOIN Ids i ON i.ResourceKey = c.ResourceKey WHERE i.ResourceKey IS NULL');
    if (Number(cOrphans.N)) {
      problems.push(`Contained has ${cOrphans.N} rows for resources that don't exist`);
    }
    const cDangling = await q.get(`SELECT COUNT(*) AS N FROM IndexReferences r LEFT JOIN Contained c ON c.ContainedKey = -r.TargetKey
      WHERE r.TargetKey < 0 AND c.ContainedKey IS NULL`);
    if (Number(cDangling.N)) {
      problems.push(`${cDangling.N} references to contained resources that aren't in Contained`);
    }
    const unkeyed = await q.all(`SELECT r.TargetType, r.TargetId FROM IndexReferences r JOIN Ids i ON i.Id = r.TargetId
      JOIN Types t ON t.TypeKey = i.TypeKey AND t.Name = r.TargetType WHERE r.TargetKey IS NULL AND i.MostRecent IS NOT NULL`);
    for (const u of unkeyed) {
      problems.push(`a reference to ${u.TargetType}/${u.TargetId} has no TargetKey though the target exists`);
    }
    const wrong = await q.all(`SELECT r.TargetType, r.TargetId FROM IndexReferences r JOIN Ids i ON i.ResourceKey = r.TargetKey
      JOIN Types t ON t.TypeKey = i.TypeKey WHERE i.Id <> r.TargetId OR t.Name <> r.TargetType`);
    for (const u of wrong) {
      problems.push(`a reference to ${u.TargetType}/${u.TargetId} is keyed to another resource`);
    }
    const ftKey = q.dialect.name === 'sqlite' ? 'rowid' : 'ResourceKey';
    const ftDeleted = await q.get(`SELECT COUNT(*) AS N FROM TextIndex f JOIN Ids i ON i.ResourceKey = f.${ftKey} WHERE i.Deleted = 1`);
    if (Number(ftDeleted.N)) {
      problems.push(`TextIndex has ${ftDeleted.N} rows for deleted resources`);
    }
    const ftOrphans = await q.get(`SELECT COUNT(*) AS N FROM TextIndex f LEFT JOIN Ids i ON i.ResourceKey = f.${ftKey} WHERE i.ResourceKey IS NULL`);
    if (Number(ftOrphans.N)) {
      problems.push(`TextIndex has ${ftOrphans.N} rows for resources that don't exist`);
    }
    const sq = await q.get('SELECT COUNT(*) AS N FROM SubscriptionQueue');
    if (Number(sq.N) !== versions.length) {
      problems.push(`${sq.N} subscription queue rows for ${versions.length} versions`);
    }
  });
  return problems;
}

module.exports = { engines, makeApp, body, mysqlConfig, emptyMysql, snapshot, invariants, DEFINITIONS, FHIR_JSON };
