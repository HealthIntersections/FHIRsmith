'use strict';
/**
 * A tracer for the sqlite-v2 tests that only counts: the interface the providers and the engine
 * call when a request carries one (OperationContext.tracer: stats, span, spanAsync, open, close,
 * annotate). stats.statements is the number of SQLite statements run, stats.rows the rows read.
 */
function countingTracer() {
  return {
    stats: { statements: 0, rows: 0, setsLoaded: 0, setBytes: 0, setLoadUs: 0 },
    span: (label, kind, system, fn) => fn(),
    spanAsync: async (label, kind, system, fn) => fn(),
    open: () => null,
    close: () => {},
    annotate: () => {}
  };
}

module.exports = { countingTracer };
