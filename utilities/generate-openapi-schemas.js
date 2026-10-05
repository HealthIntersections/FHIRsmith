#!/usr/bin/env node
//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// Generates a module's FHIR component schemas for its OpenAPI description, from the
// StructureDefinitions in a FHIR package (see library/fhir-openapi-schema.js).
//
//   node utilities/generate-openapi-schemas.js <module> [-package <dir>]
//
// reads <module>/openapi-schemas.config.js and writes <module>/openapi-schemas.json. The
// package is found in the server's terminology cache unless -package names the unpacked
// package directory.

const fs = require('fs');
const path = require('path');
const { generateSchemas } = require('../library/fhir-openapi-schema');

function packageDir(id) {
  const folders = require('../library/folder-setup');
  return folders.filePath('terminology-cache', id, 'package');
}

function main(args) {
  const module = args[0];
  if (!module) {
    console.error('usage: generate-openapi-schemas.js <module> [-package <dir>]');
    process.exit(2);
  }
  const moduleDir = path.join(__dirname, '..', module);
  const config = require(path.join(moduleDir, 'openapi-schemas.config.js'));
  const i = args.indexOf('-package');
  const dir = i >= 0 ? args[i + 1] : packageDir(config.package);
  if (!fs.existsSync(dir)) {
    console.error(`The package ${config.package} isn't at ${dir}. Load it into the terminology cache, or use -package <dir>`);
    process.exit(1);
  }
  const out = path.join(moduleDir, 'openapi-schemas.json');
  fs.writeFileSync(out, JSON.stringify(generateSchemas(config, dir), null, 2) + '\n');
  console.log(`Wrote ${out}`);
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { packageDir };
