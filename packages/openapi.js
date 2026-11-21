//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// The package server's OpenAPI description. openapi.yaml is the source of truth; see the
// comment at its top.

const path = require('path');
const { createOpenApiDoc } = require('../library/openapi-doc');

module.exports = createOpenApiDoc(path.join(__dirname, 'openapi.yaml'), '/packages');
