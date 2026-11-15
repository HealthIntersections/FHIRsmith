//
// The text index of an ICD-11 database: what a text filter ($expand filter=...) searches
//

/**
 * designation_text is a text index (text-match.js: the rules every provider's text search
 * follows) of the names of each concept, in each language crawled: its title, fully specified
 * name, index terms and inclusions (designation rows of SEARCH_KINDS), one row per name. Each
 * row has the name's words and their stems in its language, made here, so SQLite only looks
 * them up.
 *
 * It is built from designation, so a database made before it can be brought up to date without
 * crawling again: `node tx/importers/import-icd11.js --text-index-only --dest <file>`.
 *
 * @module tx/importers/icd11-text-index
 */

const { createTextIndexSql, isTextIndexSql, indexColumns } = require('../library/text-match');

const TEXT_INDEX_TABLE = 'designation_text';
const CREATE_TEXT_INDEX = createTextIndexSql(TEXT_INDEX_TABLE, ['concept', 'lang', 'kind']);

// the designations that are names: what a text filter searches
const SEARCH_KINDS = ['title', 'indexTerm', 'inclusion', 'fullySpecifiedName'];

// rows read at a time
const PAGE = 10000;

/**
 * Whether a designation_text (its CREATE statement, from sqlite_master) is the current one
 * @param {string|null} sql
 */
function isCurrentTextIndex(sql) {
  return isTextIndexSql(sql);
}

/**
 * (Re)build designation_text from designation
 *
 * @param {Object} db - a better-sqlite3 Database, not in a transaction
 * @param {function(string)} [log]
 * @returns {number} the names indexed
 */
function buildTextIndex(db, log = () => {}) {
  let count = 0;
  const build = db.transaction(() => {
    db.exec(`DROP TABLE IF EXISTS ${TEXT_INDEX_TABLE}`);
    db.exec(CREATE_TEXT_INDEX);
    const insert = db.prepare(`INSERT INTO ${TEXT_INDEX_TABLE} (concept, lang, kind, words, stems) VALUES (?, ?, ?, ?, ?)`);
    // a page at a time: better-sqlite3 can't write while a query is being iterated
    const page = db.prepare(`SELECT rowid AS k, concept, lang, kind, value FROM designation
                             WHERE rowid > ? AND kind IN (${SEARCH_KINDS.map(k => `'${k}'`).join(', ')}) AND value IS NOT NULL AND value != ''
                             ORDER BY rowid LIMIT ${PAGE}`);
    for (let last = -1; ;) {
      const rows = page.all(last);
      if (rows.length === 0) {
        break;
      }
      for (const r of rows) {
        const c = indexColumns(r.value, r.lang);
        if (c.words) {
          insert.run(r.concept, r.lang, r.kind, c.words, c.stems);
          count++;
          if (count % 100000 === 0) {
            log(`  ${count.toLocaleString()} names`);
          }
        }
      }
      last = rows[rows.length - 1].k;
    }
    db.exec(`INSERT INTO ${TEXT_INDEX_TABLE} (${TEXT_INDEX_TABLE}) VALUES ('optimize')`);
  });
  log('Indexing the names');
  build();
  return count;
}

module.exports = { TEXT_INDEX_TABLE, CREATE_TEXT_INDEX, SEARCH_KINDS, isCurrentTextIndex, buildTextIndex };
