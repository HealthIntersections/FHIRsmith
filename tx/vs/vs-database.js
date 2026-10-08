const fs = require('fs').promises;
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const { VersionUtilities } = require('../../library/version-utilities');
const ValueSet = require("../library/valueset");

// Columns that can be returned directly without parsing JSON
const INDEXED_COLUMNS = ['id', 'url', 'version', 'date', 'description', 'name', 'publisher', 'status', 'title'];

/**
 * Is `candidate` a newer version than `current`? Used to keep the version-less
 * (bare-url) and url|major.minor map keys pointing at the latest version when several
 * versions of the same value set are present. Handles both semver (IG/package value
 * sets) and VSAC-style YYYYMMDD date versions (not semver, but fixed-width so they
 * order correctly numerically).
 * @param {string|null|undefined} candidate
 * @param {string|null|undefined} current
 * @returns {boolean}
 */
function isNewerVersion(candidate, current) {
  if (current == null) return true;
  if (candidate == null) return false;
  if (candidate === current) return false;
  if (VersionUtilities.isSemVer(candidate) && VersionUtilities.isSemVer(current)) {
    return VersionUtilities.isThisOrLater(current, candidate); // candidate >= current (semver-aware)
  }
  if (/^\d+$/.test(candidate) && /^\d+$/.test(current)) {
    // e.g. VSAC YYYYMMDD - compare numerically (handles differing widths too)
    return Number(candidate) > Number(current);
  }
  return candidate > current; // best-effort lexical fallback
}

/**
 * Shared database layer for ValueSet providers
 * Handles SQLite operations for indexing and searching ValueSets
 */
class ValueSetDatabase {
  vsCount;

  /**
   * @param {string} dbPath - Path to the SQLite database file
   */
  constructor(dbPath) {
    this.dbPath = dbPath;
    // Single read-write connection used for everything. Using a separate
    // OPEN_READONLY connection for reads can miss WAL-based schema changes
    // made through the write connection (because read-only opens can't fully
    // participate in the shared-memory protocol), so queries issued right
    // after a migration ALTER TABLE can fail with a stale schema cache.
    this._writeDb = null;
    this._migrationPromise = null;
  }

  /**
   * Apply any pending schema migrations
   * @param {sqlite3.Database} db
   * @returns {Promise<void>}
   * @private
   */
  _migrateIfNeeded(db) {
    // Run migrations SEQUENTIALLY. node-sqlite3 does not guarantee that
    // separately-submitted statements run in submission order on the same
    // connection — `db.serialize()` is opt-in. Without sequencing, a
    // `CREATE INDEX` can race ahead of its `CREATE TABLE`, or a `PRAGMA
    // table_info` can race ahead of a `CREATE TABLE IF NOT EXISTS`, and
    // you get "no such table" errors on DDL that should have been fine.
    const run = (sql) => new Promise((res, rej) => {
      db.run(sql, [], (err) => err ? rej(err) : res());
    });
    const all = (sql) => new Promise((res, rej) => {
      db.all(sql, [], (err, rows) => err ? rej(err) : res(rows));
    });

    return (async () => {
      const cols = await all("PRAGMA table_info(valuesets)");
      const hasDateFirstSeen = cols.some(c => c.name === 'date_first_seen');
      const hasContentHash = cols.some(c => c.name === 'content_hash');

      if (!hasDateFirstSeen) {
        await run("ALTER TABLE valuesets ADD COLUMN date_first_seen INTEGER DEFAULT 0");
      }
      if (!hasContentHash) {
        await run("ALTER TABLE valuesets ADD COLUMN content_hash TEXT");
      }

      // Ensure vsac_runs table exists (with total_updated for fresh installs)
      await run(`
        CREATE TABLE IF NOT EXISTS vsac_runs (
                                               id INTEGER PRIMARY KEY AUTOINCREMENT,
                                               started_at INTEGER NOT NULL,
                                               finished_at INTEGER,
                                               status TEXT NOT NULL DEFAULT 'running',
                                               error_message TEXT,
                                               total_fetched INTEGER,
                                               total_new INTEGER,
                                               total_updated INTEGER
        )
      `);

      // If vsac_runs already existed (older schema), add total_updated column
      const runCols = await all("PRAGMA table_info(vsac_runs)");
      const hasTotalUpdated = runCols.some(c => c.name === 'total_updated');
      if (!hasTotalUpdated && runCols.length > 0) {
        await run("ALTER TABLE vsac_runs ADD COLUMN total_updated INTEGER");
      }

      // Ensure vsac_settings table exists (for _lastUpdated tracking etc.)
      await run(`
        CREATE TABLE IF NOT EXISTS vsac_settings (
                                                   key TEXT PRIMARY KEY,
                                                   value TEXT
        )
      `);

      // Ensure vsac_events table exists (audit log of new/updated/deleted value sets)
      await run(`
        CREATE TABLE IF NOT EXISTS vsac_events (
                                                 id INTEGER PRIMARY KEY AUTOINCREMENT,
                                                 timestamp INTEGER NOT NULL,
                                                 event_type TEXT NOT NULL,
                                                 url TEXT NOT NULL,
                                                 version TEXT,
                                                 detail TEXT
        )
      `);
      await run("CREATE INDEX IF NOT EXISTS idx_events_timestamp ON vsac_events(timestamp)");

      // Backfill content_hash for any existing rows that don't have one.
      // This establishes a baseline so the NEXT sync can detect real content
      // changes immediately (otherwise the first sync just silently populates
      // hashes and can never flag anything as 'updated').
      const needHash = await all(
          "SELECT COUNT(*) AS n FROM valuesets WHERE content_hash IS NULL"
      );
      const missing = (needHash[0] && needHash[0].n) || 0;
      if (missing > 0) {
        console.log(`Backfilling content_hash for ${missing} existing value sets...`);
        const rows = await all(
            "SELECT id, content FROM valuesets WHERE content_hash IS NULL"
        );
        let done = 0;
        for (const row of rows) {
          const hash = crypto.createHash('sha256').update(row.content).digest('hex');
          await new Promise((res, rej) => {
            db.run(
                'UPDATE valuesets SET content_hash = ? WHERE id = ?',
                [hash, row.id],
                (err) => err ? rej(err) : res()
            );
          });
          done++;
          if (done % 1000 === 0) {
            console.log(`  ...${done}/${missing}`);
          }
        }
        console.log(`Backfilled ${done} hashes.`);
      }
    })();
  }

  /**
   * Get a read-only database connection (opens lazily if needed)
   * @returns {Promise<sqlite3.Database>}
   * @private
   */
  _getReadConnection() {
    // Reads go through the same connection as writes. See the constructor
    // comment for why we don't use a separate OPEN_READONLY connection.
    return this._ensureMigrated().then(() => this._writeDb);
  }

  /**
   * Get a read-write database connection (opens lazily if needed)
   * @returns {Promise<sqlite3.Database>}
   * @private
   */
  _getWriteConnection() {
    return this._ensureMigrated().then(() => this._writeDb);
  }

  /**
   * Ensure the database schema is migrated. Idempotent: subsequent calls
   * return the cached promise. Opens a write connection (which is required
   * for ALTER TABLE) if one is not already open. The write connection is
   * kept open for reuse by later _getWriteConnection calls.
   * @returns {Promise<void>}
   * @private
   */
  _ensureMigrated() {
    if (this._migrationPromise) {
      return this._migrationPromise;
    }
    this._migrationPromise = new Promise((resolve, reject) => {
      if (this._writeDb) {
        this._migrateIfNeeded(this._writeDb).then(resolve).catch(reject);
        return;
      }
      this._writeDb = new sqlite3.Database(this.dbPath, (err) => {
        if (err) {
          this._writeDb = null;
          reject(new Error(`Failed to open database for writing: ${err.message}`));
          return;
        }
        this._migrateIfNeeded(this._writeDb).then(resolve).catch(reject);
      });
    });
    // If migration fails, clear the cached promise so a retry can attempt again
    this._migrationPromise.catch(() => { this._migrationPromise = null; });
    return this._migrationPromise;
  }

  /**
   * Close all database connections
   * @returns {Promise<void>}
   */
  async close() {
    // Clear the cached migration promise so a subsequent open re-migrates
    this._migrationPromise = null;

    if (!this._writeDb) {
      return;
    }

    await new Promise((resolve) => {
      this._writeDb.close((err) => {
        if (err) console.warn(`Warning closing database connection: ${err.message}`);
        this._writeDb = null;
        resolve();
      });
    });
  }

  /**
   * Check if the SQLite database already exists
   * @returns {Promise<boolean>}
   */
  async exists() {
    try {
      await fs.access(this.dbPath);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Create the SQLite database with required schema
   * @returns {Promise<void>}
   */
  async create() {
    // Close any existing connections first
    await this.close();

    return new Promise((resolve, reject) => {
      const db = new sqlite3.Database(this.dbPath, (err) => {
        if (err) {
          reject(new Error(`Failed to create database ${this.dbPath}: ${err.message}`));
          return;
        }

        // Create tables
        db.serialize(() => {
          // Main value sets table
          db.run(`
            CREATE TABLE valuesets (
                                     id TEXT PRIMARY KEY,
                                     url TEXT,
                                     version TEXT,
                                     date TEXT,
                                     description TEXT,
                                     effectivePeriod_start TEXT,
                                     effectivePeriod_end TEXT,
                                     expansion_identifier TEXT,
                                     name TEXT,
                                     publisher TEXT,
                                     status TEXT,
                                     title TEXT,
                                     content TEXT NOT NULL,
                                     content_hash TEXT,
                                     last_seen INTEGER DEFAULT (strftime('%s', 'now')),
                                     date_first_seen INTEGER DEFAULT (strftime('%s', 'now'))
            )
          `);

          // Identifiers table (0..* Identifier)
          db.run(`
            CREATE TABLE valueset_identifiers (
                                                valueset_id TEXT,
                                                system TEXT,
                                                value TEXT,
                                                use_code TEXT,
                                                type_system TEXT,
                                                type_code TEXT,
                                                FOREIGN KEY (valueset_id) REFERENCES valuesets(url)
            )
          `);

          // Jurisdictions table (0..* CodeableConcept with 0..* Coding)
          db.run(`
            CREATE TABLE valueset_jurisdictions (
                                                  valueset_id TEXT,
                                                  system TEXT,
                                                  code TEXT,
                                                  display TEXT,
                                                  FOREIGN KEY (valueset_id) REFERENCES valuesets(url)
            )
          `);

          // Systems table (from compose.include[].system)
          db.run(`
            CREATE TABLE valueset_systems (
                                            valueset_id TEXT,
                                            system TEXT,
                                            version TEXT,
                                            FOREIGN KEY (valueset_id) REFERENCES valuesets(url)
            )
          `);

          // Run tracking table
          db.run(`
            CREATE TABLE vsac_runs (
                                     id INTEGER PRIMARY KEY AUTOINCREMENT,
                                     started_at INTEGER NOT NULL,
                                     finished_at INTEGER,
                                     status TEXT NOT NULL DEFAULT 'running',
                                     error_message TEXT,
                                     total_fetched INTEGER,
                                     total_new INTEGER,
                                     total_updated INTEGER
            )
          `);

          // Settings table (key-value store for _lastUpdated tracking etc.)
          db.run(`
            CREATE TABLE IF NOT EXISTS vsac_settings (
                                                       key TEXT PRIMARY KEY,
                                                       value TEXT
            )
          `);

          // Event log table (new/updated/deleted value sets)
          db.run(`
            CREATE TABLE IF NOT EXISTS vsac_events (
                                                     id INTEGER PRIMARY KEY AUTOINCREMENT,
                                                     timestamp INTEGER NOT NULL,
                                                     event_type TEXT NOT NULL,
                                                     url TEXT NOT NULL,
                                                     version TEXT,
                                                     detail TEXT
            )
          `);
          db.run('CREATE INDEX idx_events_timestamp ON vsac_events(timestamp)');

          // Create indexes for better search performance
          db.run('CREATE INDEX idx_valuesets_url ON valuesets(url, version)');
          db.run('CREATE INDEX idx_valuesets_version ON valuesets(version)');
          db.run('CREATE INDEX idx_valuesets_status ON valuesets(status)');
          db.run('CREATE INDEX idx_valuesets_name ON valuesets(name)');
          db.run('CREATE INDEX idx_valuesets_title ON valuesets(title)');
          db.run('CREATE INDEX idx_valuesets_publisher ON valuesets(publisher)');
          db.run('CREATE INDEX idx_valuesets_last_seen ON valuesets(last_seen)');
          db.run('CREATE INDEX idx_valuesets_date_first_seen ON valuesets(date_first_seen)');
          db.run('CREATE INDEX idx_identifiers_system ON valueset_identifiers(system)');
          db.run('CREATE INDEX idx_identifiers_value ON valueset_identifiers(value)');
          db.run('CREATE INDEX idx_jurisdictions_system ON valueset_jurisdictions(system)');
          db.run('CREATE INDEX idx_jurisdictions_code ON valueset_jurisdictions(code)');
          db.run('CREATE INDEX idx_systems_system ON valueset_systems(system, version)');

          db.close((err) => {
            if (err) {
              reject(new Error(`Failed to close database after creation: ${err.message}`));
            } else {
              resolve();
            }
          });
        });
      });
    });
  }

  /**
   * Record the start of a VSAC sync run
   * @returns {Promise<number>} The run ID
   */
  async startRun() {
    const db = await this._getWriteConnection();
    return new Promise((resolve, reject) => {
      db.run(
          `INSERT INTO vsac_runs (started_at, status) VALUES (strftime('%s','now'), 'running')`,
          [],
          function(err) { err ? reject(err) : resolve(this.lastID); }
      );
    });
  }

  /**
   * Record the successful completion of a VSAC sync run
   * @param {number} id - The run ID from startRun()
   * @param {number} totalFetched - Total value sets fetched
   * @param {number} totalNew - Number of new value sets found
   * @param {number} [totalUpdated=0] - Number of existing value sets whose content changed
   * @returns {Promise<void>}
   */
  async finishRun(id, totalFetched, totalNew, totalUpdated = 0) {
    const db = await this._getWriteConnection();
    return new Promise((resolve, reject) => {
      db.run(
          `UPDATE vsac_runs SET finished_at = strftime('%s','now'), status = 'ok',
                                total_fetched = ?, total_new = ?, total_updated = ? WHERE id = ?`,
          [totalFetched, totalNew, totalUpdated, id],
          err => err ? reject(err) : resolve()
      );
    });
  }

  /**
   * Record a VSAC event in the audit log
   * @param {string} eventType - 'new', 'updated', or 'deleted'
   * @param {string} url - The value set URL
   * @param {string|null} version - The version, or null
   * @param {string|null} [detail] - Optional detail string
   * @returns {Promise<void>}
   */
  async recordEvent(eventType, url, version, detail = null) {
    const db = await this._getWriteConnection();
    return new Promise((resolve, reject) => {
      db.run(
          `INSERT INTO vsac_events (timestamp, event_type, url, version, detail)
           VALUES (strftime('%s','now'), ?, ?, ?, ?)`,
          [eventType, url, version || null, detail],
          err => err ? reject(err) : resolve()
      );
    });
  }

  /**
   * Record a failed VSAC sync run
   * @param {number} id - The run ID from startRun()
   * @param {string} errorMessage - The error message
   * @returns {Promise<void>}
   */
  async failRun(id, errorMessage) {
    const db = await this._getWriteConnection();
    return new Promise((resolve, reject) => {
      db.run(
          `UPDATE vsac_runs SET finished_at = strftime('%s','now'), status = 'error',
                                error_message = ? WHERE id = ?`,
          [errorMessage, id],
          err => err ? reject(err) : resolve()
      );
    });
  }

  /**
   * Get a setting value from the vsac_settings table
   * @param {string} key - The setting key
   * @returns {Promise<string|null>} The setting value, or null if not found
   */
  async getSetting(key) {
    const db = await this._getReadConnection();
    return new Promise((resolve, reject) => {
      db.get('SELECT value FROM vsac_settings WHERE key = ?', [key], (err, row) => {
        if (err) reject(err);
        else resolve(row ? row.value : null);
      });
    });
  }

  /**
   * Set a setting value in the vsac_settings table
   * @param {string} key - The setting key
   * @param {string} value - The setting value
   * @returns {Promise<void>}
   */
  async setSetting(key, value) {
    const db = await this._getWriteConnection();
    return new Promise((resolve, reject) => {
      db.run(
          `INSERT INTO vsac_settings (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          [key, value],
          err => err ? reject(err) : resolve()
      );
    });
  }

  /**
   * Insert or update a single ValueSet in the database
   * @param {Object} valueSet - The ValueSet resource
   * @param {string} [contentHash] - Optional pre-computed content hash to store
   * @returns {Promise<void>}
   */
  async upsertValueSet(valueSet, contentHash = null) {
    if (!valueSet.url) {
      throw new Error('ValueSet must have a url property');
    }

    const db = await this._getWriteConnection();

    return new Promise((resolve, reject) => {
      // Step 1: Delete existing related records
      db.run('DELETE FROM valueset_identifiers WHERE valueset_id = ?', [valueSet.id], (err) => {
        if (err) {
          reject(new Error(`Failed to delete identifiers: ${err.message}`));
          return;
        }

        db.run('DELETE FROM valueset_jurisdictions WHERE valueset_id = ?', [valueSet.id], (err) => {
          if (err) {
            reject(new Error(`Failed to delete jurisdictions: ${err.message}`));
            return;
          }

          db.run('DELETE FROM valueset_systems WHERE valueset_id = ?', [valueSet.id], (err) => {
            if (err) {
              reject(new Error(`Failed to delete systems: ${err.message}`));
              return;
            }

            // Step 2: Insert main record
            const effectiveStart = valueSet.effectivePeriod?.start || null;
            const effectiveEnd = valueSet.effectivePeriod?.end || null;
            const expansionId = valueSet.expansion?.identifier || null;

            db.run(`
              INSERT INTO valuesets (
                id, url, version, date, description, effectivePeriod_start, effectivePeriod_end,
                expansion_identifier, name, publisher, status, title, content, content_hash,
                last_seen, date_first_seen
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%s', 'now'), strftime('%s', 'now'))
                ON CONFLICT(id) DO UPDATE SET
                url=excluded.url,
                                     version=excluded.version,
                                     date=excluded.date,
                                     description=excluded.description,
                                     effectivePeriod_start=excluded.effectivePeriod_start,
                                     effectivePeriod_end=excluded.effectivePeriod_end,
                                     expansion_identifier=excluded.expansion_identifier,
                                     name=excluded.name,
                                     publisher=excluded.publisher,
                                     status=excluded.status,
                                     title=excluded.title,
                                     content=excluded.content,
                                     content_hash=excluded.content_hash,
                                     last_seen=strftime('%s', 'now')
            `, [
              valueSet.id,
              valueSet.url,
              valueSet.version || null,
              valueSet.date || null,
              valueSet.description || null,
              effectiveStart,
              effectiveEnd,
              expansionId,
              valueSet.name || null,
              valueSet.publisher || null,
              valueSet.status || null,
              valueSet.title || null,
              JSON.stringify(valueSet),
              contentHash
            ], (err) => {
              if (err) {
                reject(new Error(`Failed to insert main record: ${err.message}`));
                return;
              }

              // Step 3: Insert related records
              this._insertRelatedRecords(db, valueSet, resolve, reject);
            });
          });
        });
      });
    });
  }

  /**
   * Backfill the content_hash column for a row without rewriting content or
   * emitting an event. Used for legacy rows from before content_hash existed.
   * @param {string} id - The ValueSet id
   * @param {string} hash - The SHA-256 hex hash to store
   * @returns {Promise<void>}
   */
  async setContentHash(id, hash) {
    const db = await this._getWriteConnection();
    return new Promise((resolve, reject) => {
      db.run(
          'UPDATE valuesets SET content_hash = ? WHERE id = ?',
          [hash, id],
          err => err ? reject(err) : resolve()
      );
    });
  }

  /**
   * Just update the timestamp on the valueset
   * @param {Object} valueSet - The ValueSet resource
   * @returns {Promise<void>}
   */
  async seeValueSet(valueSet) {
    if (!valueSet.url) {
      throw new Error('ValueSet must have a url property');
    }

    const db = await this._getWriteConnection();

    return new Promise((resolve, reject) => {
      db.run(`
        update valuesets
        set last_seen = strftime('%s', 'now')
        where url = ?
          and version = ?
      `, [
        valueSet.url,
        valueSet.version
      ], (err) => {
        if (err) {
          reject(new Error(`Failed to update value Set: ${err.message}`));
          return;
        }
        resolve();
      });
    });
  }

  /**
   * Insert related records for a ValueSet
   * @param {sqlite3.Database} db - Database connection
   * @param {Object} valueSet - ValueSet resource
   * @param {Function} resolve - Promise resolve function
   * @param {Function} reject - Promise reject function
   * @private
   */
  _insertRelatedRecords(db, valueSet, resolve, reject) {
    let pendingOperations = 0;
    let hasError = false;

    const operationComplete = () => {
      pendingOperations--;
      if (pendingOperations === 0 && !hasError) {
        resolve();
      }
    };

    const operationError = (err) => {
      if (!hasError) {
        hasError = true;
        reject(err);
      }
    };

    // Insert identifiers
    if (valueSet.identifier) {
      const identifiers = Array.isArray(valueSet.identifier) ? valueSet.identifier : [valueSet.identifier];
      for (const id of identifiers) {
        pendingOperations++;
        const typeSystem = id.type?.coding?.[0]?.system || null;
        const typeCode = id.type?.coding?.[0]?.code || null;

        db.run(`
          INSERT INTO valueset_identifiers (
            valueset_id, system, value, use_code, type_system, type_code
          ) VALUES (?, ?, ?, ?, ?, ?)
        `, [
          valueSet.id,
          id.system || null,
          id.value || null,
          id.use || null,
          typeSystem,
          typeCode
        ], (err) => {
          if (err) operationError(new Error(`Failed to insert identifier: ${err.message}`));
          else operationComplete();
        });
      }
    }

    // Insert jurisdictions
    if (valueSet.jurisdiction) {
      for (const jurisdiction of valueSet.jurisdiction) {
        if (jurisdiction.coding) {
          for (const coding of jurisdiction.coding) {
            pendingOperations++;
            db.run(`
              INSERT INTO valueset_jurisdictions (
                valueset_id, system, code, display
              ) VALUES (?, ?, ?, ?)
            `, [
              valueSet.id,
              coding.system || null,
              coding.code || null,
              coding.display || null
            ], (err) => {
              if (err) operationError(new Error(`Failed to insert jurisdiction: ${err.message}`));
              else operationComplete();
            });
          }
        }
      }
    }

    // Insert systems from compose.include
    if (valueSet.compose?.include) {
      for (const include of valueSet.compose.include) {
        if (include.system) {
          pendingOperations++;

          db.run(`
            INSERT INTO valueset_systems (valueset_id, system, version) VALUES (?, ?, ?)
          `, [valueSet.id, include.system, include.version], function(err) {
            if (err) {
              operationError(new Error(`Failed to insert system: ${err.message}`));
            } else {
              operationComplete();
            }
          });
        }
      }
    }

    // If no pending operations, resolve immediately
    if (pendingOperations === 0) {
      resolve();
    }
  }

  /**
   * Load all ValueSets from the database
   * @returns {Promise<Map<string, Object>>} Map of all ValueSets keyed by various combinations
   */
  async loadAllValueSets(source) {
    const db = await this._getReadConnection();

    return new Promise((resolve, reject) => {
      db.all('SELECT id, url, version, content, content_hash FROM valuesets', [], (err, rows) => {
        if (err) {
          reject(new Error(`Failed to load value sets: ${err.message}`));
          return;
        }

        try {
          this.vsCount = rows.length;
          const valueSetMap = new Map();

          for (const row of rows) {
            let valueSet;
            try {
              valueSet = new ValueSet(JSON.parse(row.content));
            } catch (e) {
              // one unacceptable value set (e.g. one containing a CodeSystem, which the
              // server doesn't support) must not take the whole package's value sets with it
              require('../../library/logger').getInstance().child({ module: 'tx' })
                .warn(`${source || 'ValueSet database'}: skipping ValueSet ${row.url || row.id}${row.version ? '|' + row.version : ''}: ${e.message}`);
              this.vsCount--;
              continue;
            }
            valueSet.sourcePackage = source;
            // Attach the stored content hash so callers can detect changes
            // without recomputing over the full JSON.
            valueSet.contentHash = row.content_hash || null;
            // Store by URL and id alone
            this.addToMap(valueSetMap, row.id, row.url, row.version, valueSet);
          }

          resolve(valueSetMap);
        } catch (error) {
          reject(new Error(`Failed to parse value set content: ${error.message}`));
        }
      });
    });
  }

  addToMap(valueSetMap, id, url, version, valueSet) {
    // The bare-url key must resolve to the *latest* version, but rows arrive in no
    // particular order (and several versions of the same url coexist - e.g. VSAC, where
    // each date-version is its own row). So only overwrite it when this version is newer.
    this._setIfNewer(valueSetMap, url, version, valueSet);
    valueSetMap.set(id, valueSet); // id is unique per version

    if (version) {
      // Store by url|version (exact - unique per version, always set)
      valueSetMap.set(`${url}|${version}`, valueSet);

      // If version is semver, also store by url|major.minor, keeping the latest patch
      try {
        if (VersionUtilities.isSemVer(version)) {
          const majorMinor = VersionUtilities.getMajMin(version);
          if (majorMinor) {
            this._setIfNewer(valueSetMap, `${url}|${majorMinor}`, version, valueSet);
          }
        }
      } catch (error) {
        // Ignore version parsing errors, just don't add major.minor key
      }
    }
  }

  // Set map[key] = valueSet only if `version` is newer than the version already there.
  _setIfNewer(valueSetMap, key, version, valueSet) {
    const existing = valueSetMap.get(key);
    if (!existing || isNewerVersion(version, existing.version)) {
      valueSetMap.set(key, valueSet);
    }
  }

  /**
   * Search for ValueSets based on criteria
   * @param {Array<{name: string, value: string}>} searchParams - Search criteria
   * @param {Array<string>|null} elements - Optional list of elements to return (for optimization)
   * @returns {Promise<Array<Object>>} List of matching ValueSets
   */
  async search(spaceId, map, searchParams, elements = null) {
    // Check if we can optimize by selecting only indexed columns
    const canOptimize = elements && elements.length > 0 &&
        elements.every(e => INDEXED_COLUMNS.includes(e));

    // Always include 'id' in the columns to select when optimizing
    const columnsToSelect = canOptimize
        ? (elements.includes('id') ? elements : ['id', ...elements])
        : null;

    const db = await this._getReadConnection();

    return new Promise((resolve, reject) => {
      const { query, params } = this._buildSearchQuery(searchParams, columnsToSelect);

      db.all(query, params, (err, rows) => {
        if (err) {
          reject(new Error(`Search query failed: ${err.message}`));
          return;
        }

        try {
          let results;
          if (canOptimize) {
            // Construct objects directly from columns - much faster!
            results = rows.map(row => {
              const obj = { resourceType: 'ValueSet' };
              for (const elem of columnsToSelect) {
                if (row[elem] !== null && row[elem] !== undefined) {
                  if (elem === 'id' && spaceId) {
                    obj[elem] = `${spaceId}-${row[elem]}`;
                  } else {
                    obj[elem] = row[elem];
                  }
                }
              }
              return obj;
            });
          } else {
            // Fall back to parsing JSON
            // a value set the map doesn't have was rejected when the map was loaded
            // (see loadAllValueSets), so it isn't a result
            results = rows.map(row => map.get(row.id)).filter(vs => vs);
          }

          resolve(results);
        } catch (error) {
          reject(new Error(`Failed to parse search results: ${error.message}`));
        }
      });
    });
  }

  /**
   * Delete ValueSets that weren't seen in the latest scan
   * @param {number} cutoffTimestamp - Unix timestamp, delete records older than this
   * @returns {Promise<number>} Number of records deleted
   */
  async deleteOldValueSets(cutoffTimestamp) {
    const db = await this._getWriteConnection();

    return new Promise((resolve, reject) => {
      // Get URLs to delete first
      db.all('SELECT url FROM valuesets WHERE last_seen < ?', [cutoffTimestamp], (err, rows) => {
        if (err) {
          reject(new Error(`Failed to find old records: ${err.message}`));
          return;
        }

        if (rows.length === 0) {
          resolve(0);
          return;
        }

        const idsToDelete = rows.map(row => row.id);
        let deletedCount = 0;
        let pendingDeletes = 0;
        let hasError = false;

        const deleteComplete = () => {
          pendingDeletes--;
          if (pendingDeletes === 0 && !hasError) {
            // Finally delete main records
            db.run('DELETE FROM valuesets WHERE last_seen < ?', [cutoffTimestamp], function(err) {
              if (err) {
                reject(new Error(`Failed to delete old records: ${err.message}`));
              } else {
                deletedCount = this.changes;
                resolve(deletedCount);
              }
            });
          }
        };

        const deleteError = (err) => {
          if (!hasError) {
            hasError = true;
            reject(err);
          }
        };

        // Delete related records first
        const placeholders = idsToDelete.map(() => '?').join(',');

        pendingDeletes = 3; // identifiers, jurisdictions, systems

        db.run(`DELETE FROM valueset_identifiers WHERE valueset_id IN (${placeholders})`, idsToDelete, (err) => {
          if (err) deleteError(new Error(`Failed to delete identifier records: ${err.message}`));
          else deleteComplete();
        });

        db.run(`DELETE FROM valueset_jurisdictions WHERE valueset_id IN (${placeholders})`, idsToDelete, (err) => {
          if (err) deleteError(new Error(`Failed to delete jurisdiction records: ${err.message}`));
          else deleteComplete();
        });

        db.run(`DELETE FROM valueset_systems WHERE valueset_id IN (${placeholders})`, idsToDelete, (err) => {
          if (err) deleteError(new Error(`Failed to delete system records: ${err.message}`));
          else deleteComplete();
        });
      });
    });
  }

  /**
   * Get statistics about the database
   * @returns {Promise<Object>} Statistics object
   */
  async getStatistics() {
    const db = await this._getReadConnection();

    return new Promise((resolve, reject) => {
      const queries = [
        'SELECT COUNT(*) as total FROM valuesets',
        'SELECT status, COUNT(*) as count FROM valuesets GROUP BY status',
        'SELECT COUNT(DISTINCT system) as systems FROM valueset_systems'
      ];

      const results = {};
      let completed = 0;
      let hasError = false;

      const checkComplete = () => {
        completed++;
        if (completed === queries.length && !hasError) {
          resolve(results);
        }
      };

      const handleError = (err) => {
        if (!hasError) {
          hasError = true;
          reject(err);
        }
      };

      // Total count
      db.get(queries[0], [], (err, row) => {
        if (err) {
          handleError(err);
          return;
        }
        results.totalValueSets = row.total;
        checkComplete();
      });

      // Status breakdown
      db.all(queries[1], [], (err, rows) => {
        if (err) {
          handleError(err);
          return;
        }
        results.byStatus = {};
        for (const row of rows) {
          results.byStatus[row.status || 'null'] = row.count;
        }
        checkComplete();
      });

      // System count
      db.get(queries[2], [], (err, row) => {
        if (err) {
          handleError(err);
          return;
        }
        results.totalSystems = row.systems;
        checkComplete();
      });
    });
  }

  /**
   * Build SQL query for search parameters
   * @param {Array<{name: string, value: string}>} searchParams - Search parameters
   * @param {Array<string>|null} elements - If provided, select only these columns (optimization)
   * @returns {{query: string, params: Array}} Query and parameters
   * @private
   */
  _buildSearchQuery(searchParams, elements = null) {
    const conditions = [];
    const params = [];
    const joins = new Set();

    for (const param of searchParams) {
      const { name, value } = param;

      switch (name.toLowerCase()) {
        case 'url':
          conditions.push('v.url = ?');
          params.push(value);
          break;

        case 'version':
          conditions.push('v.version LIKE ?');
          params.push(`%${value}%`);
          break;

        case 'name':
          conditions.push('v.name LIKE ?');
          params.push(`%${value}%`);
          break;

        case 'title':
          conditions.push('v.title LIKE ?');
          params.push(`%${value}%`);
          break;

        case 'status':
          conditions.push('v.status LIKE ?');
          params.push(`%${value}%`);
          break;

        case 'publisher':
          conditions.push('v.publisher LIKE ?');
          params.push(`%${value}%`);
          break;

        case 'description':
          conditions.push('v.description LIKE ?');
          params.push(`%${value}%`);
          break;

        case 'date':
          conditions.push('v.date LIKE ?');
          params.push(`%${value}%`);
          break;

        case 'identifier':
          joins.add('JOIN valueset_identifiers vi ON v.id = vi.valueset_id');
          conditions.push('(vi.system = ? OR vi.value LIKE ?)');
          params.push(value, `%${value}%`);
          break;

        case 'jurisdiction':
          joins.add('JOIN valueset_jurisdictions vj ON v.id = vj.valueset_id');
          conditions.push('(vj.system = ? OR vj.code LIKE ?)');
          params.push(value, `%${value}%`);
          break;

        case 'system':
          joins.add('JOIN valueset_systems vs ON v.id = vs.valueset_id');
          if (value.includes('|')) {
            conditions.push('vs.system = ?');
            params.push(value.substring(0, value.indexOf('|')));
            conditions.push('vs.version = ?');
            params.push(value.substring(value.indexOf('|')+1));
          } else {
            conditions.push('vs.system = ?');
            params.push(value);
          }
          break;

        default:
          // For unknown parameters, try to search in the JSON content
          conditions.push('v.content LIKE ?');
          params.push(`%${value}%`);
          break;
      }
    }

    const joinClause = Array.from(joins).join(' ');
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Select columns based on optimization
    let selectClause;
    if (elements) {
      // Optimized: select only the columns we need
      const columns = elements.map(e => `v.${e}`).join(', ');
      selectClause = `SELECT DISTINCT ${columns}`;
    } else {
      // Full content needed
      selectClause = 'SELECT DISTINCT v.id';
    }

    const query = `
        ${selectClause}
        FROM valuesets v
            ${joinClause}
            ${whereClause}
        ORDER BY v.url
    `;

    return { query, params };
  }


  /**
   * Get a list of all ValueSet URLs in the database
   * @returns {Promise<string[]>} Array of ValueSet URLs
   */
  async listAllValueSets() {
    const db = await this._getReadConnection();

    return new Promise((resolve, reject) => {
      db.all('SELECT url FROM valuesets ORDER BY url', [], (err, rows) => {
        if (err) {
          reject(new Error(`Failed to list value sets: ${err.message}`));
          return;
        }

        const urls = rows.map(row => row.url);
        resolve(urls);
      });
    });
  }
}

module.exports = {
  ValueSetDatabase
};