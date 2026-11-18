//
// Writing a text index (text-match.js) with sqlite3: many rows to an INSERT
//

// rows to a statement: 5 columns x 400 rows is well inside SQLite's limit of parameters
const ROWS_PER_INSERT = 400;

/**
 * Insert rows into a table, many to a statement (one statement a row spends most of an index
 * build on the round trips)
 *
 * @param {Object} db - a sqlite3 Database
 * @param {string} table
 * @param {string[]} columns
 * @param {Array<Array>} rows - each the values of the columns, in order
 * @returns {Promise<void>}
 */
async function insertRows(db, table, columns, rows) {
  const one = '(' + columns.map(() => '?').join(', ') + ')';
  for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
    const chunk = rows.slice(i, i + ROWS_PER_INSERT);
    const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${chunk.map(() => one).join(', ')}`;
    await new Promise((resolve, reject) => db.run(sql, chunk.flat(), (err) => err ? reject(err) : resolve()));
  }
}

module.exports = { insertRows };
