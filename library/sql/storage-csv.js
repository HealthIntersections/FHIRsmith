//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * Writes the rows of a view as CSV (RFC 4180): a header row of column names, then a line per
 * row. Nulls are empty fields, booleans true/false, and collection and complex values JSON text.
 *
 * By default the text is collected and available as .text once the run finishes; pass
 * write: (chunk) => ... to send it somewhere else as it is produced (a stream, say).
 *
 * See storage-json.js for the storage interface.
 */

const { ColumnKind } = require('./model');
const { defaultResourceKey } = require('./keys');
const { jsonValue } = require('./storage-json');

class CsvStorage {
  /**
   * @param {Object} [options]
   * @param {function} [options.write] - receives the CSV text in pieces
   * @param {string} [options.eol='\r\n'] - the line ending
   * @param {function} [options.keyFor] - (resource, root) => key, for getResourceKey()/getReferenceKey()
   */
  constructor(options = {}) {
    this.keyFor = options.keyFor || defaultResourceKey;
    this.eol = options.eol || '\r\n';
    this.needsName = false;
    this.text = '';
    this.write = options.write || (chunk => {
      this.text += chunk;
    });
  }

  createStore(name, columns) {
    this.text = '';
    this.write(columns.map(c => csvField(c.name)).join(',') + this.eol);
    return { name, columns };
  }

  addRow(store, cells) {
    this.write(cells.map(cell => csvField(csvValue(cell))).join(',') + this.eol);
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

function csvValue(cell) {
  if (cell.values.length === 0) {
    return '';
  }
  if (cell.column.collection || cell.values.length > 1) {
    return JSON.stringify(cell.values.map(jsonValue));
  }
  const v = cell.values[0];
  return v.kind === ColumnKind.Complex ? JSON.stringify(v.value) : String(v.value);
}

function csvField(s) {
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

module.exports = { CsvStorage };
