//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * An endpoint's settings. config.json says where the endpoint is and which database it uses;
 * everything else is in the endpoint's own database: the Config table (endpoint settings) and
 * Types.Settings (per type). There are no admin pages yet, so they are set in the database
 * directly, or seeded from the endpoint's "initialSettings" in config.json when the database is
 * new (a setting already in the database is never overwritten from config.json).
 *
 * Config carries a generation number that changes whenever a setting does: a process compares
 * its own with the database's at most once a second and reloads when they differ.
 *
 * @module rest/endpoint/settings
 */

const ENDPOINT_DEFAULTS = {
  name: 'FHIRsmith REST server',
  description: null,
  fhirVersion: null,
  // packages beyond the core, 'id#version'
  packages: [],
  // server-assigned ids: 'key' (the resource key) or 'uuid'
  idStrategy: 'key',
  createOnUpdate: true,
  checkReferences: true,
  // the terminology server for $closure and :in/:not-in: a path on this server, or a URL
  txServer: null,
  // the most codes a value set can have to be searched by expanding it (:in, :not-in); bigger
  // ones (and ones that aren't closed) can be registered for searching by an administrator
  maxValueSetExpansion: 10000,
  // 'off', 'writes' or 'all'
  audit: 'writes',
  defaultCount: 50,
  maxCount: 500,
  searchKeepMinutes: 30,
  searchMaxResults: 20000,
  // above this many results, _total is an estimate unless asked for as accurate
  totalEstimateAbove: 10000,
  // dates without a zone: IANA name, null for the server's own
  timeZone: null,
  compress: true,
  transactionMaxEntries: 1000,
  // 'none', 'read' (a public server) or 'write' (a sandbox)
  anonymous: 'none',
  customSearchParameters: false,
  // the most matches a conditional delete deletes (1: only a single match)
  conditionalDeleteMax: 1,
  // async requests (Prefer: respond-async; queue/async.js): whether they are taken, how long
  // a result is kept, and how many one user can have queued or running at once
  asyncRequests: true,
  asyncKeepHours: 24,
  asyncMaxPerUser: 5
};

const TYPE_DEFAULTS = {
  versionAware: false,
  // null: all of them
  interactions: null,
  conditionalCreate: true,
  conditionalUpdate: true,
  conditionalDelete: true
};

const INTERACTIONS = ['read', 'vread', 'update', 'patch', 'delete', 'history-instance', 'history-type', 'create', 'search-type'];

const BOOLEANS = new Set(Object.keys(ENDPOINT_DEFAULTS).filter(k => typeof ENDPOINT_DEFAULTS[k] === 'boolean'));
const NUMBERS = new Set(Object.keys(ENDPOINT_DEFAULTS).filter(k => typeof ENDPOINT_DEFAULTS[k] === 'number'));

function parseValue(name, text) {
  if (text === null || text === undefined) {
    return ENDPOINT_DEFAULTS[name];
  }
  if (BOOLEANS.has(name)) {
    return text === 'true' || text === '1' || text === 'on';
  }
  if (NUMBERS.has(name)) {
    const n = Number(text);
    return Number.isFinite(n) ? n : ENDPOINT_DEFAULTS[name];
  }
  if (name === 'packages') {
    try {
      const v = JSON.parse(text);
      return Array.isArray(v) ? v : [];
    } catch (e) {
      return String(text).split(',').map(s => s.trim()).filter(s => s);
    }
  }
  return text;
}

function valueText(v) {
  if (Array.isArray(v)) {
    return JSON.stringify(v);
  }
  return v === null || v === undefined ? null : String(v);
}

async function readGeneration(q) {
  const row = await q.get('SELECT Value FROM Config WHERE Name = ?', ['generation']);
  return row ? Number(row.Value) : 0;
}

/** Change the generation (in a write transaction): every process reloads */
async function bumpGeneration(q) {
  const g = await readGeneration(q);
  const n = g + 1;
  const r = await q.run('UPDATE Config SET Value = ? WHERE Name = ?', [String(n), 'generation']);
  if (!r.changes) {
    await q.run(q.dialect.insertIgnore('Config', ['Name', 'Value']) + '(?, ?)', ['generation', String(n)]);
  }
  return n;
}

/**
 * Seed settings that aren't in the database yet, and the types (master only).
 * @param {Object} db
 * @param {Object} initial - name -> value (from config.json)
 * @param {string[]} resourceTypes
 * @param {Object} [typeSettings] - type -> settings, seeded for types not yet present
 */
async function seed(db, initial, resourceTypes, typeSettings = {}) {
  await db.write(async (q) => {
    let changed = false;
    const rows = await q.all('SELECT Name FROM Config');
    const have = new Set(rows.map(r => r.Name));
    for (const [name, value] of Object.entries(initial || {})) {
      if (!(name in ENDPOINT_DEFAULTS)) {
        throw new Error(`Unknown endpoint setting '${name}' (known: ${Object.keys(ENDPOINT_DEFAULTS).join(', ')})`);
      }
      if (!have.has(name)) {
        await q.run('INSERT INTO Config (Name, Value) VALUES (?, ?)', [name, valueText(value)]);
        changed = true;
      }
    }
    const types = await q.all('SELECT Name FROM Types');
    const haveTypes = new Set(types.map(r => r.Name));
    for (const t of resourceTypes) {
      if (!haveTypes.has(t)) {
        await q.run(q.dialect.insertIgnore('Types', ['Name', 'Supported', 'Settings']) + '(?, ?, ?)',
          [t, 1, typeSettings[t] ? JSON.stringify(typeSettings[t]) : null]);
        changed = true;
      }
    }
    if (changed || !have.has('generation')) {
      await bumpGeneration(q);
    }
  });
}

/**
 * Load the settings.
 * @returns {Promise<{generation: number, endpoint: Object, types: Map<string, Object>, typeKeys: Map<string, number>}>}
 */
async function load(db) {
  return db.read(async (q) => {
    const rows = await q.all('SELECT Name, Value FROM Config');
    const map = new Map(rows.map(r => [r.Name, r.Value]));
    const endpoint = {};
    for (const name of Object.keys(ENDPOINT_DEFAULTS)) {
      endpoint[name] = map.has(name) ? parseValue(name, map.get(name)) : ENDPOINT_DEFAULTS[name];
    }
    const types = new Map();
    const typeKeys = new Map();
    for (const r of await q.all('SELECT TypeKey, Name, Supported, Settings FROM Types')) {
      typeKeys.set(r.Name, Number(r.TypeKey));
      let s = {};
      if (r.Settings) {
        try {
          s = JSON.parse(r.Settings);
        } catch (e) {
          s = {};
        }
      }
      types.set(r.Name, { ...TYPE_DEFAULTS, ...s, supported: !!Number(r.Supported) });
    }
    return { generation: map.has('generation') ? Number(map.get('generation')) : 0, endpoint, types, typeKeys };
  });
}

/**
 * Change endpoint settings (in a write transaction of its own).
 * @param {Object} db
 * @param {Object} values - name -> value
 */
async function set(db, values) {
  await db.write(async (q) => {
    for (const [name, value] of Object.entries(values)) {
      if (!(name in ENDPOINT_DEFAULTS)) {
        throw new Error(`Unknown endpoint setting '${name}'`);
      }
      const r = await q.run('UPDATE Config SET Value = ? WHERE Name = ?', [valueText(value), name]);
      if (!r.changes) {
        await q.run('INSERT INTO Config (Name, Value) VALUES (?, ?)', [name, valueText(value)]);
      }
    }
    await bumpGeneration(q);
  });
}

/**
 * Change a type's settings.
 * @param {Object} db
 * @param {string} type
 * @param {Object} values - merged over the type's current settings; supported (boolean) too
 */
async function setType(db, type, values) {
  await db.write(async (q) => {
    const row = await q.get('SELECT Supported, Settings FROM Types WHERE Name = ?', [type]);
    if (!row) {
      throw new Error(`Unknown type ${type}`);
    }
    const current = row.Settings ? JSON.parse(row.Settings) : {};
    const { supported, ...rest } = values;
    const next = { ...current, ...rest };
    await q.run('UPDATE Types SET Supported = ?, Settings = ? WHERE Name = ?',
      [supported === undefined ? row.Supported : (supported ? 1 : 0), JSON.stringify(next), type]);
    await bumpGeneration(q);
  });
}

/** Whether a type allows an interaction (by its settings) */
function typeAllows(typeSettings, interaction) {
  if (!typeSettings || !typeSettings.supported) {
    return false;
  }
  return !Array.isArray(typeSettings.interactions) || typeSettings.interactions.includes(interaction);
}

module.exports = { ENDPOINT_DEFAULTS, TYPE_DEFAULTS, INTERACTIONS, seed, load, set, setType, readGeneration, bumpGeneration, typeAllows };
