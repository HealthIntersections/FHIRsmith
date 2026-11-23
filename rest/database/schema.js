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

const SCHEMA_VERSION = 1;

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
  }
};

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

module.exports = { SCHEMA_VERSION, TABLES, INDEX_TABLES, tableDDL, migrate, waitForSchema, schemaVersion };
