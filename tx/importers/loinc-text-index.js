//
// The text index of a LOINC database: what a text filter ($expand filter=...) searches
//

/**
 * TextIndex is a text index (text-match.js: the rules every provider's text search follows) of
 * every name a LOINC code has, one row per name: its display (Codes.Description, type
 * DISPLAY_TYPE, in English) and each of its descriptions (Descriptions, with their type and
 * language), but RELATEDNAMES2, which is a list of keywords, not a name. Each row has the name's
 * words and their stems in its language, made here, so SQLite only looks them up, and a search
 * takes a few milliseconds.
 *
 * It is built from the tables, so a database made before it can be brought up to date without
 * importing LOINC again: `tx-import loinc upgrade-text-index -d <file>`.
 *
 * @module tx/importers/loinc-text-index
 */

const { createTextIndexSql, isTextIndexSql, indexColumns } = require('../library/text-match');
const { insertRows } = require('./text-index-insert');

// the type a code's display has in TextIndex: not a DescriptionTypes key (those start at 1)
const DISPLAY_TYPE = 0;
// RELATEDNAMES2: a list of keywords, not a name. Not indexed
const RELATED_NAMES_TYPE = 4;

const CREATE_TEXT_INDEX = createTextIndexSql('TextIndex', ['codekey', 'type', 'lang']);

// rows read and written at a time
const PAGE = 10000;

/**
 * Whether a TextIndex (its CREATE statement, from sqlite_master) is the current one
 * @param {string|null} sql
 */
function isCurrentTextIndex(sql) {
  return isTextIndexSql(sql);
}

/**
 * (Re)build TextIndex from Codes and Descriptions. The connection should not be in a
 * transaction (this makes its own)
 *
 * @param {Object} db - a sqlite3 Database
 * @param {function(string)} [log]
 * @returns {Promise<number>} the rows indexed
 */
async function buildTextIndex(db, log = () => {}) {
  const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, (err) => err ? reject(err) : resolve()));
  const get = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
  const all = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
  const languages = new Map((await all('SELECT LanguageKey, Code FROM Languages')).map(r => [r.LanguageKey, r.Code]));
  const english = await get("SELECT LanguageKey FROM Languages WHERE lower(Code) = 'en' OR lower(Code) LIKE 'en-%' ORDER BY LanguageKey LIMIT 1");
  if (!english) {
    throw new Error('the database has no English language (Languages)');
  }
  let count = 0;
  const insertAll = async (rows) => {
    const values = [];
    for (const r of rows) {
      const c = indexColumns(r.text, languages.get(r.lang) || 'en');
      if (c.words) {
        values.push([r.codekey, r.type, r.lang, c.words, c.stems]);
      }
    }
    await insertRows(db, 'TextIndex', ['codekey', 'type', 'lang', 'words', 'stems'], values);
    count += values.length;
  };
  await run('BEGIN');
  try {
    await run('DROP TABLE IF EXISTS TextIndex');
    await run(CREATE_TEXT_INDEX);
    log('Indexing the displays');
    for (let last = -1; ;) {
      const rows = await all(`SELECT CodeKey AS codekey, ${DISPLAY_TYPE} AS type, ? AS lang, Description AS text FROM Codes
                              WHERE CodeKey > ? AND Description IS NOT NULL AND Description != '' ORDER BY CodeKey LIMIT ${PAGE}`, [english.LanguageKey, last]);
      if (rows.length === 0) {
        break;
      }
      await insertAll(rows);
      last = rows[rows.length - 1].codekey;
    }
    log('Indexing the descriptions');
    for (let last = -1; ;) {
      const rows = await all(`SELECT DescriptionKey AS k, CodeKey AS codekey, DescriptionTypeKey AS type, LanguageKey AS lang, Value AS text FROM Descriptions
                              WHERE DescriptionKey > ? AND DescriptionTypeKey != ${RELATED_NAMES_TYPE} AND Value IS NOT NULL AND Value != ''
                              ORDER BY DescriptionKey LIMIT ${PAGE}`, [last]);
      if (rows.length === 0) {
        break;
      }
      await insertAll(rows);
      last = rows[rows.length - 1].k;
    }
    await run("INSERT INTO TextIndex (TextIndex) VALUES ('optimize')");
    await run('COMMIT');
  } catch (e) {
    await run('ROLLBACK').catch(() => {});
    throw e;
  }
  return count;
}

module.exports = { DISPLAY_TYPE, RELATED_NAMES_TYPE, CREATE_TEXT_INDEX, isCurrentTextIndex, buildTextIndex };
