/**
 * node-sqlite3 runs its callbacks from native code. An exception thrown inside
 * one leaves the promise waiting on it unsettled (the request hangs), and N-API
 * keeps it pending: the process aborts (napi_throw FATAL) when the statement is
 * finalized, at the latest on exit. So any callback that does more than call
 * resolve/reject is wrapped, and what it throws rejects the enclosing promise.
 *
 *   db.all(sql, params, guarded(reject, (err, rows) => { ... }));
 *
 * `this` is passed through, for run() callbacks that read this.lastID. What it throws
 * is also logged, because after resolve() the reject does nothing.
 */
function guarded(reject, callback) {
  return function (...args) {
    try {
      return callback.apply(this, args);
    } catch (e) {
      require('../../library/logger').getInstance().child({ module: 'tx' }).warn(`sqlite callback threw: ${e.message}`);
      reject(e);
    }
  };
}

module.exports = { guarded };
