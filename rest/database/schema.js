//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * The rest module's tables, written once and turned into DDL for SQLite or MySQL.
 *
 * - Every key is made by the database (autoincrement), never counted in a process.
 * - Times are BIGINT milliseconds since the epoch, UTC.
 * - Text is compared as binary (utf8mb4_bin in MySQL, SQLite's default): ids, codes and
 *   systems are case-sensitive. Case-insensitive search uses copies normalised in JavaScript.
 * - The index tables are one per search parameter type, all keyed by ResourceKey and
 *   ParamKey; GroupNo and Comp tie together the components of a composite parameter.
 *
 * Column types: key (the table's autoincrement primary key), bigint, int, double,
 * str(n), text, blob.
 *
 * @module rest/database/schema
 */

const SCHEMA_VERSION = 9;

// columns every index table has
const INDEX_COMMON = [
  ['ResourceKey', 'bigint', { notNull: true }],
  ['ParamKey', 'bigint', { notNull: true }],
  ['GroupNo', 'int'],
  ['Comp', 'int']
];

const TABLES = [
  {
    name: 'Config',
    columns: [['Name', 'str(64)', { notNull: true }], ['Value', 'text']],
    primaryKey: ['Name']
  },
  {
    name: 'Types',
    columns: [['TypeKey', 'key'], ['Name', 'str(64)', { notNull: true }], ['Supported', 'int', { notNull: true }], ['Settings', 'text']],
    indexes: [{ name: 'SK_Types_Name', columns: ['Name'], unique: true }]
  },
  {
    name: 'Ids',
    columns: [['ResourceKey', 'key'], ['TypeKey', 'bigint', { notNull: true }], ['Id', 'str(64)', { notNull: true }],
      ['MostRecent', 'bigint'], ['Deleted', 'int', { notNull: true }]],
    indexes: [{ name: 'SK_Ids_Id', columns: ['TypeKey', 'Id'], unique: true }, { name: 'SK_Ids_TypeDel', columns: ['TypeKey', 'Deleted', 'ResourceKey'] }]
  },
  {
    name: 'Versions',
    columns: [['VersionKey', 'key'], ['ResourceKey', 'bigint', { notNull: true }], ['VersionId', 'int', { notNull: true }],
      ['LastUpdated', 'bigint', { notNull: true }], ['Operation', 'int', { notNull: true }], ['UserId', 'str(128)'],
      ['AuditKey', 'bigint'], ['Compressed', 'int', { notNull: true }], ['Content', 'blob']],
    indexes: [{ name: 'SK_Versions_ResVer', columns: ['ResourceKey', 'VersionId'], unique: true },
      { name: 'SK_Versions_Updated', columns: ['LastUpdated'] }]
  },
  {
    name: 'Tags',
    columns: [['TagKey', 'key'], ['Kind', 'int', { notNull: true }], ['TagSystem', 'str(255)', { notNull: true }],
      ['Code', 'str(255)', { notNull: true }], ['Display', 'str(255)']],
    indexes: [{ name: 'SK_Tags_Code', columns: ['Kind', 'TagSystem', 'Code'], unique: true }]
  },
  {
    name: 'VersionTags',
    columns: [['VersionKey', 'bigint', { notNull: true }], ['TagKey', 'bigint', { notNull: true }]],
    primaryKey: ['VersionKey', 'TagKey'],
    indexes: [{ name: 'SK_VersionTags_Tag', columns: ['TagKey', 'VersionKey'] }]
  },
  {
    name: 'SearchParams',
    columns: [['ParamKey', 'key'], ['Url', 'str(512)', { notNull: true }], ['Code', 'str(128)', { notNull: true }],
      ['Type', 'str(16)', { notNull: true }], ['Bases', 'text'], ['Expression', 'text'], ['Hash', 'str(64)', { notNull: true }],
      ['Reindex', 'int', { notNull: true }]],
    indexes: [{ name: 'SK_SearchParams_Url', columns: ['Url'], unique: true }]
  },
  {
    name: 'Spaces',
    columns: [['SpaceKey', 'key'], ['Uri', 'str(512)', { notNull: true }]],
    indexes: [{ name: 'SK_Spaces_Uri', columns: ['Uri'], unique: true }]
  },
  {
    name: 'IndexStrings',
    columns: [...INDEX_COMMON, ['Norm', 'str(255)', { notNull: true }], ['Exact', 'str(1024)', { notNull: true }]],
    indexes: [{ name: 'SK_IndexStrings_Value', columns: ['ParamKey', 'Norm', 'ResourceKey'] }, { name: 'SK_IndexStrings_Res', columns: ['ResourceKey'] }]
  },
  {
    name: 'IndexTokens',
    columns: [...INDEX_COMMON, ['SpaceKey', 'bigint'], ['Code', 'str(255)', { notNull: true }], ['Implicit', 'int', { notNull: true }],
      ['ConceptKey', 'bigint'], ['TextNorm', 'str(255)'], ['TypeSpaceKey', 'bigint'], ['TypeCode', 'str(255)']],
    indexes: [{ name: 'SK_IndexTokens_Value', columns: ['ParamKey', 'Code', 'SpaceKey', 'ResourceKey'] },
      { name: 'SK_IndexTokens_Concept', columns: ['ParamKey', 'ConceptKey'] },
      { name: 'SK_IndexTokens_Res', columns: ['ResourceKey'] }]
  },
  {
    name: 'IndexDates',
    columns: [...INDEX_COMMON, ['Lo', 'bigint', { notNull: true }], ['Hi', 'bigint', { notNull: true }]],
    indexes: [{ name: 'SK_IndexDates_Lo', columns: ['ParamKey', 'Lo'] }, { name: 'SK_IndexDates_Hi', columns: ['ParamKey', 'Hi'] },
      { name: 'SK_IndexDates_Res', columns: ['ResourceKey'] }]
  },
  {
    name: 'IndexNumbers',
    columns: [...INDEX_COMMON, ['Lo', 'double', { notNull: true }], ['Hi', 'double', { notNull: true }], ['Value', 'double', { notNull: true }]],
    indexes: [{ name: 'SK_IndexNumbers_Lo', columns: ['ParamKey', 'Lo'] }, { name: 'SK_IndexNumbers_Res', columns: ['ResourceKey'] }]
  },
  {
    name: 'IndexQuantities',
    columns: [...INDEX_COMMON, ['Lo', 'double', { notNull: true }], ['Hi', 'double', { notNull: true }], ['Value', 'double', { notNull: true }],
      ['SpaceKey', 'bigint'], ['Unit', 'str(128)'], ['CanonLo', 'double'], ['CanonHi', 'double'], ['CanonUnit', 'str(128)']],
    indexes: [{ name: 'SK_IndexQuantities_Lo', columns: ['ParamKey', 'Lo'] }, { name: 'SK_IndexQuantities_Canon', columns: ['ParamKey', 'CanonUnit', 'CanonLo'] },
      { name: 'SK_IndexQuantities_Res', columns: ['ResourceKey'] }]
  },
  {
    name: 'IndexReferences',
    columns: [...INDEX_COMMON, ['TargetKey', 'bigint'], ['TargetType', 'str(64)'], ['TargetId', 'str(64)'], ['TargetVersion', 'str(64)'],
      ['Url', 'str(512)'], ['UrlVersion', 'str(64)'], ['IdentSpaceKey', 'bigint'], ['IdentValue', 'str(255)']],
    indexes: [{ name: 'SK_IndexReferences_Target', columns: ['ParamKey', 'TargetKey'] },
      { name: 'SK_IndexReferences_TargetId', columns: ['TargetId', 'TargetType', 'ParamKey'] },
      { name: 'SK_IndexReferences_Url', columns: ['ParamKey', 'Url'] },
      { name: 'SK_IndexReferences_Ident', columns: ['ParamKey', 'IdentValue'] },
      { name: 'SK_IndexReferences_TargetKey', columns: ['TargetKey'] },
      { name: 'SK_IndexReferences_Res', columns: ['ResourceKey'] }]
  },
  {
    name: 'IndexUris',
    columns: [...INDEX_COMMON, ['Value', 'str(512)', { notNull: true }]],
    indexes: [{ name: 'SK_IndexUris_Value', columns: ['ParamKey', 'Value'] }, { name: 'SK_IndexUris_Res', columns: ['ResourceKey'] }]
  },
  {
    name: 'Compartments',
    columns: [['ResourceKey', 'bigint', { notNull: true }], ['CompType', 'str(64)', { notNull: true }], ['CompId', 'str(64)', { notNull: true }],
      ['CompKey', 'bigint']],
    indexes: [{ name: 'SK_Compartments_Comp', columns: ['CompType', 'CompId', 'ResourceKey'] }, { name: 'SK_Compartments_Res', columns: ['ResourceKey'] }]
  },
  {
    name: 'Searches',
    columns: [['SearchKey', 'key'], ['SearchId', 'str(32)', { notNull: true }], ['Query', 'text'], ['Total', 'int'],
      ['StoredCount', 'int', { notNull: true }], ['UserId', 'str(128)'], ['Created', 'bigint', { notNull: true }], ['Expires', 'bigint', { notNull: true }]],
    indexes: [{ name: 'SK_Searches_Id', columns: ['SearchId'], unique: true }, { name: 'SK_Searches_Expires', columns: ['Expires'] }]
  },
  {
    name: 'SearchEntries',
    columns: [['SearchKey', 'bigint', { notNull: true }], ['Pos', 'int', { notNull: true }], ['ResourceKey', 'bigint', { notNull: true }]],
    primaryKey: ['SearchKey', 'Pos']
  },
  {
    name: 'Concepts',
    columns: [['ConceptKey', 'key'], ['SpaceKey', 'bigint', { notNull: true }], ['Code', 'str(255)', { notNull: true }],
      ['InClosure', 'int', { notNull: true }]],
    indexes: [{ name: 'SK_Concepts_Code', columns: ['SpaceKey', 'Code'], unique: true }, { name: 'SK_Concepts_Closure', columns: ['InClosure'] }]
  },
  {
    name: 'Closures',
    columns: [['ClosureKey', 'key'], ['Name', 'str(128)', { notNull: true }], ['Version', 'str(64)']],
    indexes: [{ name: 'SK_Closures_Name', columns: ['Name'], unique: true }]
  },
  {
    name: 'ClosureEntries',
    columns: [['ClosureKey', 'bigint', { notNull: true }], ['SubsumesKey', 'bigint', { notNull: true }], ['SubsumedKey', 'bigint', { notNull: true }]],
    primaryKey: ['ClosureKey', 'SubsumesKey', 'SubsumedKey'],
    indexes: [{ name: 'SK_ClosureEntries_Subsumed', columns: ['ClosureKey', 'SubsumedKey'] }]
  },
  {
    name: 'SubscriptionQueue',
    columns: [['QueueKey', 'key'], ['ResourceKey', 'bigint', { notNull: true }], ['VersionKey', 'bigint', { notNull: true }],
      ['PreviousVersionKey', 'bigint'], ['Operation', 'int', { notNull: true }], ['Entered', 'bigint', { notNull: true }], ['Handled', 'bigint']],
    indexes: [{ name: 'SK_SubscriptionQueue_Handled', columns: ['Handled'] }]
  }
];

/**
 * Contained resources that their container refers to: each is indexed with its own type's
 * search parameters, under the key -ContainedKey (negative, so it can never be a resource's key:
 * chains reach it through IndexReferences.TargetKey, and nothing that looks in Ids finds it).
 * Made at schema version 3, so not in TABLES.
 */
// version 4: the codes in each place a code can be (a resource type's token search parameter),
// each place with its own closure table on the terminology server. InClosure: 0 not sent yet,
// 1 sent, 2 refused by the server (an unknown code, or the table full). (Concepts.InClosure,
// from version 1, is no longer used.)
const PARAM_CONCEPTS_TABLE = { name: 'ParamConcepts',
  columns: [['TypeKey', 'bigint', { notNull: true }], ['ParamKey', 'bigint', { notNull: true }], ['ConceptKey', 'bigint', { notNull: true }],
    ['InClosure', 'int', { notNull: true }]],
  primaryKey: ['TypeKey', 'ParamKey', 'ConceptKey'],
  indexes: [{ name: 'SK_ParamConcepts_Closure', columns: ['InClosure', 'TypeKey', 'ParamKey'] }] };

// version 5: value sets registered for searching (:in, :not-in) by membership, worked out by
// asking the terminology server about each concept (terminology.js), for value sets too big to
// expand, or not closed. Systems: the code systems the value set draws on (JSON), for
// concepts in other systems to be left out without asking; '*' when that can't be known, null
// before it's been looked for. Status: 0 being worked out, 1 ready
const VALUESET_TABLES = [
  { name: 'ValueSets',
    columns: [['ValueSetKey', 'key'], ['Url', 'str(255)', { notNull: true }], ['Version', 'str(64)'], ['Systems', 'text'],
      ['Status', 'int', { notNull: true }], ['Registered', 'bigint', { notNull: true }], ['RegisteredBy', 'str(128)']],
    indexes: [{ name: 'SK_ValueSets_Url', columns: ['Url'], unique: true }] },
  { name: 'ValueSetMembers',
    columns: [['ValueSetKey', 'bigint', { notNull: true }], ['ConceptKey', 'bigint', { notNull: true }], ['Member', 'int', { notNull: true }]],
    primaryKey: ['ValueSetKey', 'ConceptKey'],
    indexes: [{ name: 'SK_ValueSetMembers_Member', columns: ['ValueSetKey', 'Member', 'ConceptKey'] }] }
];

// version 6: packages loaded into the endpoint (rest/packages.js), queued for the master.
// Status: 0 queued, 1 loading, 2 loaded, 3 failed. Report: what happened (JSON)
const PACKAGE_LOADS_TABLE = { name: 'PackageLoads',
  columns: [['LoadKey', 'key'], ['Package', 'str(128)', { notNull: true }], ['Version', 'str(64)'], ['Examples', 'int', { notNull: true }],
    ['Status', 'int', { notNull: true }], ['Requested', 'bigint', { notNull: true }], ['RequestedBy', 'str(128)'],
    ['Started', 'bigint'], ['Finished', 'bigint'], ['Message', 'text'], ['Report', 'text']],
  indexes: [{ name: 'SK_PackageLoads_Status', columns: ['Status'] }] };

// version 7: the values of Observations, for $lastn and $stats (indexing/observations.js): a
// row for the observation itself (Component 0), and one for each component (1...), for each
// Observation with an effective[x] and a code. CodeGroup: the code, as one string (its concepts'
// keys, in order; or its text, when it has no codings), the same for codes with the same
// codings. Effective: the time to sort by (the end of a period, the last time of a Timing);
// EffectiveLo, EffectiveHi: the range it covers. Value: a valueQuantity's value, with its unit,
// and the UCUM canonical form when the unit is UCUM. ObservationCodes: the concepts of each
// value's code (Source 2), the observation's categories (Source 1), and for a component, the
// observation's code (Source 3)
const OBSERVATION_TABLES = [
  { name: 'ObservationValues',
    columns: [['ValueKey', 'key'], ['ResourceKey', 'bigint', { notNull: true }], ['Component', 'int', { notNull: true }],
      ['CodeGroup', 'str(255)', { notNull: true }], ['CodeText', 'str(255)'], ['SubjectType', 'str(64)'], ['SubjectId', 'str(64)'],
      ['Status', 'str(32)'], ['Effective', 'bigint', { notNull: true }], ['EffectiveLo', 'bigint', { notNull: true }],
      ['EffectiveHi', 'bigint', { notNull: true }], ['Value', 'double'], ['UnitSpaceKey', 'bigint'], ['Unit', 'str(128)'],
      ['UnitDisplay', 'str(128)'], ['Canonical', 'double'], ['CanonicalUnit', 'str(128)']],
    indexes: [{ name: 'SK_ObservationValues_Res', columns: ['ResourceKey', 'Component'] },
      { name: 'SK_ObservationValues_Subject', columns: ['SubjectId', 'SubjectType', 'EffectiveLo'] }] },
  { name: 'ObservationCodes',
    columns: [['ValueKey', 'bigint', { notNull: true }], ['Source', 'int', { notNull: true }], ['ConceptKey', 'bigint', { notNull: true }]],
    primaryKey: ['ValueKey', 'Source', 'ConceptKey'],
    indexes: [{ name: 'SK_ObservationCodes_Concept', columns: ['ConceptKey', 'Source', 'ValueKey'] }] }
];

// version 8: the queued work of the queue runner (queue/runner.js), and its files. AsyncJobs:
// the async requests (queue/async.js), by a UUID. State: queued, running, done, failed,
// cancelled; Cancel: 1 when a DELETE asked for a running job to stop; Runner: the process
// running it, with its Heartbeat. JobFiles: what a job keeps (its request, its result), in
// pieces (queue/files.js), so no one value is too big for MySQL's max_allowed_packet
const JOB_TABLES = [
  { name: 'AsyncJobs',
    columns: [['JobKey', 'key'], ['Id', 'str(64)', { notNull: true }], ['State', 'str(16)', { notNull: true }],
      ['Interaction', 'str(64)', { notNull: true }], ['Url', 'text'], ['UserKey', 'str(128)'], ['UserLabel', 'str(255)'],
      ['Created', 'bigint', { notNull: true }], ['Started', 'bigint'], ['Finished', 'bigint'], ['Expires', 'bigint', { notNull: true }],
      ['Runner', 'str(128)'], ['Heartbeat', 'bigint'], ['Cancel', 'int', { notNull: true }], ['Progress', 'str(100)'],
      ['Status', 'int'], ['Message', 'text'], ['ContentType', 'str(128)']],
    indexes: [{ name: 'SK_AsyncJobs_Id', columns: ['Id'], unique: true }, { name: 'SK_AsyncJobs_State', columns: ['State', 'JobKey'] },
      { name: 'SK_AsyncJobs_User', columns: ['UserKey', 'State'] }, { name: 'SK_AsyncJobs_Expires', columns: ['Expires'] }] },
  { name: 'JobFiles',
    columns: [['JobKey', 'bigint', { notNull: true }], ['Name', 'str(64)', { notNull: true }], ['Seq', 'int', { notNull: true }],
      ['Data', 'blob']],
    primaryKey: ['JobKey', 'Name', 'Seq'] }
];

// version 9: maintenance (rest/maintenance.js): while there's a row, every request is answered
// 'under maintenance'. A reset drops every table but this one, so every process sees what is
// happening while the rest is gone. State: requested, wiping, loading, failed
const MAINTENANCE_TABLE = { name: 'Maintenance',
  columns: [['Id', 'int', { notNull: true }], ['State', 'str(16)', { notNull: true }], ['Started', 'bigint', { notNull: true }],
    ['StartedBy', 'str(128)'], ['Updated', 'bigint'], ['Message', 'text']],
  primaryKey: ['Id'] };

const CONTAINED_TABLE = {
  name: 'Contained',
  columns: [['ContainedKey', 'key'], ['ResourceKey', 'bigint', { notNull: true }], ['TypeKey', 'bigint'], ['LocalId', 'str(64)', { notNull: true }]],
  indexes: [{ name: 'SK_Contained_Resource', columns: ['ResourceKey'] }]
};

const INDEX_TABLES = ['IndexStrings', 'IndexTokens', 'IndexDates', 'IndexNumbers', 'IndexQuantities', 'IndexReferences', 'IndexUris'];

function columnType(type, dialect) {
  const m = /^str\((\d+)\)$/.exec(type);
  if (dialect === 'sqlite') {
    if (m || type === 'text') {
      return 'TEXT';
    }
    return { key: 'INTEGER PRIMARY KEY AUTOINCREMENT', bigint: 'INTEGER', int: 'INTEGER', double: 'REAL', blob: 'BLOB' }[type];
  }
  if (m) {
    return `VARCHAR(${m[1]})`;
  }
  return { key: 'BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY', bigint: 'BIGINT', int: 'INT', double: 'DOUBLE', text: 'MEDIUMTEXT', blob: 'LONGBLOB' }[type];
}

/**
 * The statements that create a table and its indexes.
 * @param {Object} table - from TABLES
 * @param {string} dialect - 'sqlite' or 'mysql'
 * @returns {string[]}
 */
function tableDDL(table, dialect) {
  const cols = table.columns.map(([name, type, opts]) => {
    let s = `${name} ${columnType(type, dialect)}`;
    if (opts && opts.notNull && type !== 'key') {
      s += ' NOT NULL';
    }
    return s;
  });
  if (table.primaryKey) {
    cols.push(`PRIMARY KEY (${table.primaryKey.join(', ')})`);
  }
  let create = `CREATE TABLE ${table.name} (${cols.join(', ')})`;
  if (dialect === 'mysql') {
    create += ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin';
  }
  const out = [create];
  for (const ix of table.indexes || []) {
    out.push(`CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${ix.name} ON ${table.name} (${ix.columns.join(', ')})`);
  }
  return out;
}

/**
 * The schema's migrations, by version: each a function(q) that brings the schema from the
 * version before to this one. Version 1 creates everything.
 */
const MIGRATIONS = {
  1: async (q) => {
    for (const table of TABLES) {
      for (const sql of tableDDL(table, q.dialect.name)) {
        await q.exec(sql);
      }
    }
  },
  // full-text search (_text, _content): the TextIndex table, which each engine makes its own way
  // (indexing/fulltext.js). Resources already there are reindexed in the background to fill it
  2: async (q) => {
    for (const sql of require('../indexing/fulltext').ddl(q.dialect.name)) {
      await q.exec(sql);
    }
    await flagReindexAll(q);
  },
  // contained resources: indexed with their own search parameters, so chains reach into them
  3: async (q) => {
    for (const sql of tableDDL(CONTAINED_TABLE, q.dialect.name)) {
      await q.exec(sql);
    }
    await flagReindexAll(q);
  },
  // a closure table for each place a code can be (indexing/indexer.js, terminology.js), in
  // place of one for everything: what there was is dropped, and rebuilt in the background
  4: async (q) => {
    for (const sql of tableDDL(PARAM_CONCEPTS_TABLE, q.dialect.name)) {
      await q.exec(sql);
    }
    if (q.dialect.name === 'sqlite') {
      await q.exec('ALTER TABLE Closures ADD COLUMN TypeKey INTEGER');
      await q.exec('ALTER TABLE Closures ADD COLUMN ParamKey INTEGER');
    } else {
      await q.exec('ALTER TABLE Closures ADD COLUMN TypeKey BIGINT, ADD COLUMN ParamKey BIGINT');
    }
    await q.exec('CREATE UNIQUE INDEX SK_Closures_Param ON Closures (TypeKey, ParamKey)');
    await q.exec('DELETE FROM ClosureEntries');
    await q.exec('DELETE FROM Closures');
    await q.exec(`INSERT INTO ParamConcepts (TypeKey, ParamKey, ConceptKey, InClosure)
      SELECT DISTINCT x.TypeKey, x.ParamKey, x.ConceptKey, 0 FROM (
        SELECT i.TypeKey AS TypeKey, t.ParamKey AS ParamKey, t.ConceptKey AS ConceptKey FROM IndexTokens t JOIN Ids i ON i.ResourceKey = t.ResourceKey
          WHERE t.ConceptKey IS NOT NULL AND t.Comp IS NULL
        UNION ALL
        SELECT c.TypeKey, t.ParamKey, t.ConceptKey FROM IndexTokens t JOIN Contained c ON c.ContainedKey = -t.ResourceKey
          WHERE t.ConceptKey IS NOT NULL AND t.Comp IS NULL AND t.ResourceKey < 0) x
      WHERE x.TypeKey IS NOT NULL`);
  },
  // value sets registered for searching by membership
  5: async (q) => {
    for (const table of VALUESET_TABLES) {
      for (const sql of tableDDL(table, q.dialect.name)) {
        await q.exec(sql);
      }
    }
  },
  // packages loaded into the endpoint
  6: async (q) => {
    for (const sql of tableDDL(PACKAGE_LOADS_TABLE, q.dialect.name)) {
      await q.exec(sql);
    }
  },
  // the values of Observations ($lastn, $stats), filled by reindexing what is there (which
  // also brings the canonical forms of quantities to the UCUM service the server now uses)
  7: async (q) => {
    for (const table of OBSERVATION_TABLES) {
      for (const sql of tableDDL(table, q.dialect.name)) {
        await q.exec(sql);
      }
    }
    await flagReindexAll(q);
  },
  // the queue runner's queued work: async requests, and the files they keep
  8: async (q) => {
    for (const table of JOB_TABLES) {
      for (const sql of tableDDL(table, q.dialect.name)) {
        await q.exec(sql);
      }
    }
  },
  // maintenance: kept through a reset, which then makes everything else again from version 1
  9: async (q) => {
    if (!(await tableExists(q, MAINTENANCE_TABLE.name))) {
      for (const sql of tableDDL(MAINTENANCE_TABLE, q.dialect.name)) {
        await q.exec(sql);
      }
    }
  }
};

/** Everything already there gets reindexed in the background (Endpoint.reindexBatch) */
async function flagReindexAll(q) {
  const any = await q.get('SELECT ResourceKey FROM Ids WHERE MostRecent IS NOT NULL LIMIT 1');
  const flagged = await q.get("SELECT Value FROM Config WHERE Name = 'reindexAll'");
  if (any && !flagged) {
    await q.run("INSERT INTO Config (Name, Value) VALUES ('reindexAll', '1')");
  }
}

async function tableExists(q, name) {
  if (q.dialect.name === 'sqlite') {
    const row = await q.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [name]);
    return !!row;
  }
  const row = await q.get('SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [name]);
  return !!row;
}

/**
 * The schema version of the database, 0 if it has no tables yet.
 * @param {Object} q - a query object
 */
async function schemaVersion(q) {
  if (!(await tableExists(q, 'Config'))) {
    return 0;
  }
  const row = await q.get("SELECT Value FROM Config WHERE Name = 'schemaVersion'");
  return row ? parseInt(row.Value, 10) : 0;
}

/**
 * Bring the database's schema up to date, holding the schema lock. Run by the master (or a
 * process with no role) at start.
 * @param {Object} db - an open database
 * @param {function(string)} [log]
 * @returns {Promise<number>} the version it was at
 */
async function migrate(db, log = () => {}) {
  return db.withSchemaLock(async (q) => {
    const from = await schemaVersion(q);
    if (from > SCHEMA_VERSION) {
      throw new Error(`The database's schema is version ${from}, newer than this server knows (${SCHEMA_VERSION}): upgrade the server`);
    }
    for (let v = from + 1; v <= SCHEMA_VERSION; v++) {
      log(`Migrating the database schema to version ${v}`);
      await MIGRATIONS[v](q);
      if (v === 1) {
        await q.run("INSERT INTO Config (Name, Value) VALUES ('schemaVersion', ?)", [String(v)]);
      } else {
        await q.run("UPDATE Config SET Value = ? WHERE Name = 'schemaVersion'", [String(v)]);
      }
    }
    return from;
  });
}

/**
 * Wait until the master has brought the schema to this server's version. A worker never
 * changes the schema; it refuses a schema newer than it knows.
 * @param {Object} db
 * @param {number} [timeoutMs]
 */
async function waitForSchema(db, timeoutMs = 120000) {
  const start = Date.now();
  for (;;) {
    const v = await db.read(schemaVersion);
    if (v === SCHEMA_VERSION) {
      return;
    }
    if (v > SCHEMA_VERSION) {
      throw new Error(`The database's schema is version ${v}, newer than this server knows (${SCHEMA_VERSION}): upgrade the server`);
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`The database's schema is version ${v}; waited ${timeoutMs / 1000}s for the master to bring it to ${SCHEMA_VERSION}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/**
 * Drop every table but the ones named (a reset: rest/maintenance.js), holding the schema lock.
 * The schema is then made again by migrate().
 * @param {Object} db
 * @param {string[]} keep - table names
 * @returns {Promise<number>} how many tables were dropped
 */
async function dropTables(db, keep) {
  return db.withSchemaLock(async (q) => {
    const kept = new Set(keep.map(k => k.toLowerCase()));
    let n = 0;
    if (q.dialect.name === 'sqlite') {
      // virtual tables (full text) first: dropping one drops the tables it keeps its data in
      const list = async () => (await q.all("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"))
        .filter(r => !kept.has(String(r.name).toLowerCase()));
      for (const r of (await list()).filter(r => /^CREATE VIRTUAL TABLE/i.test(r.sql || ''))) {
        await q.exec(`DROP TABLE IF EXISTS "${r.name}"`);
        n++;
      }
      for (const r of await list()) {
        await q.exec(`DROP TABLE IF EXISTS "${r.name}"`);
        n++;
      }
    } else {
      const rows = await q.all('SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()');
      for (const r of rows.filter(r => !kept.has(String(r.name).toLowerCase()))) {
        await q.exec(`DROP TABLE IF EXISTS \`${r.name}\``);
        n++;
      }
    }
    return n;
  });
}

module.exports = { SCHEMA_VERSION, TABLES, CONTAINED_TABLE, PARAM_CONCEPTS_TABLE, VALUESET_TABLES, PACKAGE_LOADS_TABLE, OBSERVATION_TABLES, JOB_TABLES, INDEX_TABLES,
  MAINTENANCE_TABLE, tableDDL, migrate, waitForSchema, schemaVersion, tableExists, dropTables };
