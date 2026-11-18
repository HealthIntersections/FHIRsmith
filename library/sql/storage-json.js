//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * Keeps the rows of a view in memory as JSON objects (one per row, keyed by column name).
 *
 * This is also the reference for the storage interface the runner uses:
 *
 *   needsName                               - true if the view must have a name (a table name, say)
 *   createStore(name, columns) -> store     - called once per view run, with the view's columns in order
 *   addRow(store, cells)                    - one call per row; cells are in column order, each with
 *                                             .column and .values (empty when null). May be async.
 *   finish(store, ok)                       - called once at the end, ok false if the run failed. May be async.
 *   getKeyForSourceResource(resource, root) - the key getResourceKey() returns for a resource
 *   getKeyForTargetResource(resource, root) - the key getReferenceKey() returns for a reference's
 *                                             target. Must match the first for the same resource.
 *
 * root is the resource being processed. The keys default to defaultResourceKey (keys.js); pass
 * keyFor: (resource, root) => key to use keys of your own.
 */

const { ColumnKind } = require('./model');
const { defaultResourceKey } = require('./keys');

class JsonStorage {
  constructor(options = {}) {
    this.keyFor = options.keyFor || defaultResourceKey;
    this.needsName = false;
    this.name = null;
    this.rows = [];
  }

  createStore(name, columns) {
    this.name = name;
    this.columns = columns;
    this.rows = [];
    return { name, columns };
  }

  addRow(store, cells) {
    const row = {};
    for (const cell of cells) {
      if (cell.column.collection || cell.values.length > 1) {
        row[cell.column.name] = cell.values.map(jsonValue);
      } else if (cell.values.length === 0) {
        row[cell.column.name] = null;
      } else {
        row[cell.column.name] = jsonValue(cell.values[0]);
      }
    }
    this.rows.push(row);
  }

  finish() {
  }

  getKeyForSourceResource(resource, root) {
    return this.keyFor(resource, root);
  }

  getKeyForTargetResource(resource, root) {
    return this.keyFor(resource, root);
  }
}

/**
 * The JSON form of a value: numbers and booleans as such, complex types as objects, everything
 * else (strings, codes, dates, times, binaries) as strings.
 */
function jsonValue(value) {
  if (value === null || value === undefined) {
    return null;
  }
  switch (value.kind) {
    case ColumnKind.Integer:
      return typeof value.value === 'bigint' ? Number(value.value) : value.value;
    case ColumnKind.Decimal:
    case ColumnKind.Boolean:
      return value.value;
    case ColumnKind.Complex:
      return value.value;
    default:
      return value.value === null || value.value === undefined ? null : String(value.value);
  }
}

module.exports = { JsonStorage, jsonValue };
