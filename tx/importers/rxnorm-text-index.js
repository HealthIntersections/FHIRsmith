//
// The text index of an RxNorm database: what a text filter ($expand filter=...) searches
//

/**
 * RXNTEXT is a text index (text-match.js: the rules every provider's text search follows) of
 * every RxNorm name (each RXNCONSO row of the database's own source, SAB RXNORM - or NCI - in
 * English), one row per name, keyed by its RXCUI. Each row has the name's words and their stems,
 * made here, so SQLite only looks them up.
 *
 * It replaces RXNSTEMS (one stem per row, of the words of three or more letters that start with
 * a letter). It is built from RXNCONSO, so a database made before it can be brought up to date
 * without importing RxNorm again: `tx-import rxnorm upgrade-text-index -d <file>`.
 *
 * @module tx/importers/rxnorm-text-index
 */

const { createTextIndexSql, isTextIndexSql, indexColumns } = require('../library/text-match');
const { insertRows } = require('./text-index-insert');

const TEXT_INDEX_TABLE = 'RXNTEXT';
const CREATE_TEXT_INDEX = createTextIndexSql(TEXT_INDEX_TABLE, ['cui']);

// rows read and written at a time
const PAGE = 10000;

/**
 * Whether an RXNTEXT (its CREATE statement, from sqlite_master) is the current one
 * @param {string|null} sql
 */
function isCurrentTextIndex(sql) {
  return isTextIndexSql(sql);
}

/**
 * (Re)build RXNTEXT from RXNCONSO, and drop RXNSTEMS, which it replaces. The connection should
 * not be in a transaction (this makes its own)
 *
 * @param {Object} db - a sqlite3 Database
 * @param {string} [sab] - the source whose names are indexed
 * @param {function(string)} [log]
 * @returns {Promise<number>} the names indexed
 */
async function buildTextIndex(db, sab = 'RXNORM', log = () => {}) {
  const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, (err) => err ? reject(err) : resolve()));
  const all = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
  let count = 0;
  await run('BEGIN');
  try {
    await run(`DROP TABLE IF EXISTS ${TEXT_INDEX_TABLE}`);
    await run('DROP TABLE IF EXISTS RXNSTEMS');
    await run(CREATE_TEXT_INDEX);
    log('Indexing the names');
    for (let last = -1; ;) {
      const rows = await all(`SELECT rowid AS k, RXCUI AS cui, STR AS text FROM RXNCONSO WHERE rowid > ? AND SAB = ? ORDER BY rowid LIMIT ${PAGE}`, [last, sab]);
      if (rows.length === 0) {
        break;
      }
      const values = [];
      for (const r of rows) {
        const c = indexColumns(r.text, 'en');
        if (c.words) {
          values.push([r.cui, c.words, c.stems]);
        }
      }
      await insertRows(db, TEXT_INDEX_TABLE, ['cui', 'words', 'stems'], values);
      count += values.length;
      last = rows[rows.length - 1].k;
    }
    await run(`INSERT INTO ${TEXT_INDEX_TABLE} (${TEXT_INDEX_TABLE}) VALUES ('optimize')`);
    await run('COMMIT');
  } catch (e) {
    await run('ROLLBACK').catch(() => {});
    throw e;
  }
  return count;
}

module.exports = { TEXT_INDEX_TABLE, CREATE_TEXT_INDEX, isCurrentTextIndex, buildTextIndex };
