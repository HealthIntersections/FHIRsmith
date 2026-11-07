/**
 * node-sqlite3 runs its callbacks from native code. An exception thrown inside
 * one leaves whatever was waiting on it unsettled (a promise never settles, a
 * request never gets a response), and N-API keeps it pending: the process aborts
 * (napi_throw FATAL) when the statement is finalized, at the latest on exit. So
 * callbacks are wrapped, and what one throws goes to onError instead:
 *
 *   db.all(sql, params, guarded(reject, (err, rows) => { ... }));    // in a promise
 *   db.get(sql, params, guarded(next, (err, row) => { ... }));       // in a route handler
 *   db.run(sql, guarded(null, err => { ... }));                      // nothing waits: log only
 *
 * `this` is passed through, for run() callbacks that read this.lastID / this.changes.
 * What it throws is also logged, because after resolve() a reject does nothing.
 *
 * (better-sqlite3, used by ips, testing, registry and extension-tracker, is synchronous:
 * its exceptions are ordinary ones, and need none of this.)
 *
 * @param {function(Error)|null} onError - reject, next, failRequest(res), or null
 * @param {Function} callback
 */
function guarded(onError, callback) {
  return function (...args) {
    try {
      return callback.apply(this, args);
    } catch (e) {
      require('./logger').getInstance().child({ module: 'sqlite' }).warn(`sqlite callback threw: ${e.message}`);
      if (typeof onError === 'function') {
        onError(e);
      }
    }
  };
}

/**
 * For a route helper that has the response but no next: answer 500, if nothing has been
 * sent yet (what Express does with an error passed to next).
 * @param {Object} res
 * @returns {function(Error)}
 */
function failRequest(res) {
  return () => {
    if (!res.headersSent) {
      res.status(500).send('Internal Server Error');
    }
  };
}

/**
 * A string for the inside of a '...' literal in SQLite: each ' doubled (SQLite has no backslash
 * escapes, so that is all a literal needs). Prefer a ? parameter wherever the SQL allows one.
 * @param {string} str
 * @returns {string} '' for a missing value
 */
function sqlEscapeString(str) {
  if (!str) return '';
  return str.replace(/'/g, "''");
}

module.exports = { guarded, failRequest, sqlEscapeString };
