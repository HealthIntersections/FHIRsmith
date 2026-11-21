//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// The testing module's OpenAPI description: openapi.yaml (the paths, written by hand) plus
// openapi-schemas.json (the FHIR resource schemas, generated from the R5 StructureDefinitions
// by utilities/generate-openapi-schemas.js - see openapi-schemas.config.js).

const path = require('path');
const { createOpenApiDoc } = require('../library/openapi-doc');

module.exports = createOpenApiDoc(path.join(__dirname, 'openapi.yaml'), '/testing',
  { schemasPath: path.join(__dirname, 'openapi-schemas.json') });
