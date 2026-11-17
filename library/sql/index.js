//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * SQL on FHIR: runs ViewDefinitions over FHIR resources into JSON, SQLite or CSV.
 *
 *   const { Runner, MemoryProvider, JsonStorage } = require('./library/sql');
 *   const runner = new Runner({
 *     model: require('fhirpath/fhir-context/r4'),
 *     provider: new MemoryProvider().addBundle(ipsDocument),
 *     storage: new JsonStorage()
 *   });
 *   await runner.execute(viewDefinition);
 *   runner.storage.rows  // [{...}, ...]
 *
 * See runner.js for the provider interface and storage-json.js for the storage interface.
 */

const { Runner } = require('./runner');
const { prepareView, ViewDefinitionError } = require('./view-definition');
const { MemoryProvider } = require('./memory-provider');
const { JsonStorage } = require('./storage-json');
const { SqliteStorage } = require('./storage-sqlite');
const { CsvStorage } = require('./storage-csv');
const { defaultResourceKey } = require('./keys');
const { Column, Cell, Value, ColumnKind } = require('./model');

module.exports = {
  Runner,
  prepareView,
  ViewDefinitionError,
  MemoryProvider,
  JsonStorage,
  SqliteStorage,
  CsvStorage,
  defaultResourceKey,
  Column,
  Cell,
  Value,
  ColumnKind
};
