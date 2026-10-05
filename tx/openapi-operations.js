//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// The terminology operations, as data, for the OpenAPI description (see openapi.js).
//
// Each operation is described once here, and openapi.js makes the paths from it: the type
// level and instance level forms, GET (query parameters) and POST (a Parameters resource, or
// a form), and the tables of in and out parameters in the description. The parameter lists
// are what the code reads - tests/tx/openapi.test.js checks them against the workers and
// TxParameters (params.js) - so add a parameter here when the code learns a new one.
//
// An operation with common: true also reads the COMMON parameters (listed once, in the
// overview).
//
// A parameter: { name, type, min, max, doc }. type is a FHIR type: a primitive can be sent
// in a query (GET, or a form), anything else only in a Parameters resource. max is '1' or
// '*'. parts, for an out parameter with parts, lists them the same way.

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });

const p = (name, type, max, doc, extra = {}) => ({ name, type, min: 0, max, doc, ...extra });

// Additional resources, and the cache they can be kept in. Every operation that resolves
// code systems or value sets reads these.
const RESOURCES = [
  p('tx-resource', 'Resource', '*', 'A CodeSystem, ValueSet or ConceptMap the operation may need (e.g. a value set that the value set being expanded imports), used instead of any the server has with the same url and version'),
  p('cache-id', 'id', '1', 'A cache of tx-resources started with $cache-control (mode=start). Sending it in the `X-Cache-Id` header instead is preferred')
];

// TxParameters (params.js): read by every operation that works with code systems and value sets
const VERSIONS = [
  p('system-version', 'canonical', '*', 'The version of a code system to use when the value set (or the request) doesn\'t say: `system|version`'),
  p('check-system-version', 'canonical', '*', 'The version of a code system that must be used: `system|version`. It\'s an error if anything else would be'),
  p('force-system-version', 'canonical', '*', 'The version of a code system to use, whatever the value set (or the request) says: `system|version`'),
  p('default-valueset-version', 'canonical', '*', 'The version of a value set to use when a reference to it doesn\'t say: `url|version`'),
  p('check-valueset-version', 'canonical', '*', 'The version of a value set that must be used: `url|version`'),
  p('force-valueset-version', 'canonical', '*', 'The version of a value set to use, whatever the reference to it says: `url|version`'),
  p('default-to-latest-version', 'boolean', '1', 'When no version is specified, use the latest the server has')
];

const GENERAL = [
  p('displayLanguage', 'code', '1', 'The language(s) for displays, in the form of an HTTP Accept-Language (which is used if this isn\'t present)'),
  p('useSupplement', 'canonical', '*', 'A code system supplement to use, which must then be used (`url` or `url|version`)'),
  p('profile', 'Parameters', '1', 'A Parameters resource holding more of these parameters (an expansion profile)'),
  p('no-cache', 'boolean', '1', 'Don\'t answer from a cached result'),
  p('diagnostics', 'boolean', '1', 'Add the server\'s working to the response (for debugging; the format can change at any time)')
];

const COMMON = [...RESOURCES, ...VERSIONS, ...GENERAL];

const EXPANSION = [
  p('filter', 'string', '1', 'Text to filter the codes by (matching display and designations; how is up to the code system)'),
  p('count', 'integer', '1', 'Paging: the number of codes to return'),
  p('offset', 'integer', '1', 'Paging: where to start (0 based)'),
  p('limit', 'integer', '1', 'Upper bound on the size of the expansion; the operation fails as too-costly beyond it'),
  p('activeOnly', 'boolean', '1', 'Leave out inactive codes'),
  p('excludeNested', 'boolean', '1', 'Return a flat list, not a hierarchy'),
  p('excludeNotForUI', 'boolean', '1', 'Leave out codes that aren\'t for choosing in a user interface (abstract codes)'),
  p('excludePostCoordinated', 'boolean', '1', 'Leave out post-coordinated codes'),
  p('includeDesignations', 'boolean', '1', 'Include the designations of each code'),
  p('designation', 'string', '*', 'A designation to include: `language`, or a `system|code` use'),
  p('includeDefinition', 'boolean', '1', 'Include the definition of each code'),
  p('property', 'string', '*', 'A property to include for each code'),
  p('sort', 'string', '1', '`code`, `display`, `design` or `prop:{name}`; prefix with - to reverse. Ignored for hierarchical expansions'),
  p('versionsMatch', 'boolean', '1', 'Treat a code as the same code in different versions of its code system')
];

const VALIDATION = [
  p('abstract', 'boolean', '1', 'Whether abstract codes are valid (default true)'),
  p('activeOnly', 'boolean', '1', 'Inactive codes are not valid'),
  p('lenient-display-validation', 'boolean', '1', 'A wrong display is a warning rather than an error'),
  p('valueset-membership-only', 'boolean', '1', 'Only check that the code is in the value set: not the display, status, and so on')
];

const VALIDATE_RESULT = [
  p('result', 'boolean', '1', 'Whether the code is valid', { min: 1 }),
  p('message', 'string', '1', 'The errors and warnings, as text'),
  p('display', 'string', '1', 'The display of the code'),
  p('code', 'code', '1', 'The code that was validated'),
  p('system', 'uri', '1', 'Its code system'),
  p('version', 'string', '1', 'The version of the code system'),
  p('codeableConcept', 'CodeableConcept', '1', 'The CodeableConcept that was validated'),
  p('inactive', 'boolean', '1', 'The code is inactive'),
  p('status', 'code', '1', 'The status of the code, when it\'s not active'),
  p('normalized-code', 'code', '1', 'The code as the code system has it, when it was validated case-insensitively'),
  p('issues', 'OperationOutcome', '1', 'The issues, with their locations and tx-issue-type codes'),
  p('x-unknown-system', 'canonical', '*', 'A code system (or version) the server doesn\'t have'),
  p('x-caused-by-unknown-system', 'canonical', '*', 'A code system (or version) the server doesn\'t have, which made the validation impossible')
];

const OPERATIONS = [
  {
    name: 'expand',
    common: true,
    resource: 'ValueSet',
    levels: ['type', 'instance'],
    summary: 'Expand a value set',
    description: 'Returns the codes in a value set, as ValueSet.expansion. The value set is ' +
      'named by url (and valueSetVersion), or sent as valueSet; at the instance level it\'s ' +
      'the value set with that id.\n\nA POST can also send the ValueSet itself as the body, ' +
      'with any other parameters in the query.',
    postBody: ['Parameters', 'ValueSet'],
    in: [
      p('url', 'uri', '1', 'The value set to expand (type level)'),
      p('valueSetVersion', 'string', '1', 'Its version'),
      p('valueSet', 'ValueSet', '1', 'The value set to expand, sent with the request'),
      ...EXPANSION
    ],
    returns: 'ValueSet',
    returnsDoc: 'The value set, with its expansion'
  },
  {
    name: 'validate-code',
    common: true,
    resource: 'ValueSet',
    levels: ['type', 'instance'],
    summary: 'Is a code in a value set?',
    description: 'Validates a code, Coding or CodeableConcept against a value set: whether it\'s ' +
      'in the value set, and whether it\'s valid in its code system (display, status, and so on).',
    in: [
      p('url', 'uri', '1', 'The value set (type level)'),
      p('valueSetVersion', 'string', '1', 'Its version'),
      p('valueSet', 'ValueSet', '1', 'The value set, sent with the request'),
      p('code', 'code', '1', 'The code to validate (with system)'),
      p('system', 'uri', '1', 'Its code system'),
      p('systemVersion', 'string', '1', 'The version of the code system'),
      p('display', 'string', '1', 'Its display, to check'),
      p('inferSystem', 'boolean', '1', 'Work out the system from the value set, if code has no system'),
      p('coding', 'Coding', '1', 'The Coding to validate'),
      p('codeableConcept', 'CodeableConcept', '1', 'The CodeableConcept to validate: valid if any of its codings is'),
      ...VALIDATION
    ],
    out: VALIDATE_RESULT
  },
  {
    name: 'validate-code',
    common: true,
    resource: 'CodeSystem',
    levels: ['type', 'instance'],
    summary: 'Is a code valid in a code system?',
    description: 'Validates a code, Coding or CodeableConcept against a code system.',
    in: [
      p('url', 'uri', '1', 'The code system (type level; system is accepted too)'),
      p('version', 'string', '1', 'Its version'),
      p('codeSystem', 'CodeSystem', '1', 'The code system, sent with the request'),
      p('code', 'code', '1', 'The code to validate'),
      p('system', 'uri', '1', 'The code system, if url isn\'t given'),
      p('display', 'string', '1', 'Its display, to check'),
      p('coding', 'Coding', '1', 'The Coding to validate'),
      p('codeableConcept', 'CodeableConcept', '1', 'The CodeableConcept to validate'),
      ...VALIDATION.filter(x => x.name !== 'valueset-membership-only')
    ],
    out: VALIDATE_RESULT
  },
  {
    name: 'batch-validate-code',
    resource: 'ValueSet',
    levels: ['type'],
    methods: ['post'],
    summary: 'Validate many codes against value sets',
    description: 'A batch of $validate-code requests: each `validation` is a Parameters resource ' +
      'with the parameters of one ValueSet $validate-code. url, valueSet, tx-resource and ' +
      'lenient-display-validation at the top level apply to every validation that doesn\'t ' +
      'have its own. Each result is a `validation` in the response, in the same order: the ' +
      'Parameters $validate-code returns, or an OperationOutcome.',
    postBody: ['Parameters'],
    in: [
      p('validation', 'Parameters', '*', 'The parameters of one $validate-code', { min: 1 }),
      p('url', 'uri', '1', 'The value set, for every validation'),
      p('valueSet', 'ValueSet', '1', 'The value set, for every validation'),
      p('lenient-display-validation', 'boolean', '1', 'For every validation'),
      p('tx-resource', 'Resource', '*', 'Resources for every validation')
    ],
    out: [p('validation', 'Parameters', '*', 'The result of each validation (or an OperationOutcome)')]
  },
  {
    name: 'batch-validate-code',
    resource: 'CodeSystem',
    levels: ['type'],
    methods: ['post'],
    summary: 'Validate many codes against code systems',
    description: 'A batch of CodeSystem $validate-code requests: each `validation` is a ' +
      'Parameters resource with the parameters of one. system, codeSystem, tx-resource and ' +
      'lenient-display-validation at the top level apply to every validation that doesn\'t ' +
      'have its own.',
    postBody: ['Parameters'],
    in: [
      p('validation', 'Parameters', '*', 'The parameters of one $validate-code', { min: 1 }),
      p('system', 'uri', '1', 'The code system, for every validation'),
      p('codeSystem', 'CodeSystem', '1', 'The code system, for every validation'),
      p('lenient-display-validation', 'boolean', '1', 'For every validation'),
      p('tx-resource', 'Resource', '*', 'Resources for every validation')
    ],
    out: [p('validation', 'Parameters', '*', 'The result of each validation (or an OperationOutcome)')]
  },
  {
    name: 'lookup',
    common: true,
    resource: 'CodeSystem',
    levels: ['type', 'instance'],
    summary: 'Look up a code',
    description: 'Returns the details of a code: its display, definition, designations and properties.',
    in: [
      p('code', 'code', '1', 'The code (with system)'),
      p('system', 'uri', '1', 'Its code system (type level)'),
      p('version', 'string', '1', 'The version of the code system'),
      p('coding', 'Coding', '1', 'The code, as a Coding'),
      p('property', 'code', '*', 'A property to return (by default, all of them)'),
    ],
    out: [
      p('name', 'string', '1', 'The name of the code system', { min: 1 }),
      p('system', 'uri', '1', 'The code system'),
      p('version', 'string', '1', 'Its version'),
      p('code', 'code', '1', 'The code'),
      p('display', 'string', '1', 'Its display', { min: 1 }),
      p('definition', 'string', '1', 'Its definition'),
      p('abstract', 'boolean', '1', 'Whether it\'s abstract (not for use)'),
      p('designation', '(parts)', '*', 'A designation', {
        parts: [
          p('language', 'code', '1', ''), p('use', 'Coding', '1', ''), p('value', 'string', '1', ''),
          p('source', 'Coding', '1', 'Where the designation comes from (e.g. a supplement)'),
          p('status', 'code', '1', '')
        ]
      }),
      p('property', '(parts)', '*', 'A property', {
        parts: [p('code', 'code', '1', ''), p('value', 'any', '1', ''), p('description', 'string', '1', '')]
      }),
      p('used-supplement', 'canonical', '*', 'A supplement that was used')
    ]
  },
  {
    name: 'subsumes',
    common: true,
    resource: 'CodeSystem',
    levels: ['type', 'instance'],
    summary: 'Does one code subsume another?',
    description: 'Tests the relationship between two codes in a code system.',
    in: [
      p('codeA', 'code', '1', 'The first code'),
      p('codeB', 'code', '1', 'The second code'),
      p('system', 'uri', '1', 'Their code system (type level)'),
      p('version', 'string', '1', 'Its version'),
      p('codingA', 'Coding', '1', 'The first code, as a Coding'),
      p('codingB', 'Coding', '1', 'The second code, as a Coding'),
    ],
    out: [
      p('outcome', 'code', '1', '`equivalent`, `subsumes`, `subsumed-by` or `not-subsumed`', { min: 1 })
    ]
  },
  {
    name: 'translate',
    common: true,
    resource: 'ConceptMap',
    levels: ['type', 'instance'],
    summary: 'Translate a code',
    description: 'Translates a code using a concept map: the one named by url (or the instance), ' +
      'or the ones the server has that map between the source and target. The R5 names are ' +
      'used here; the R4 names (code, coding, codeableConcept, system, version, source, target, ' +
      'targetsystem, reverse) are accepted too.',
    in: [
      p('url', 'uri', '1', 'The concept map (type level)'),
      p('conceptMapVersion', 'string', '1', 'Its version'),
      p('sourceCode', 'code', '1', 'The code to translate (with sourceSystem)'),
      p('sourceSystem', 'uri', '1', 'Its code system'),
      p('sourceVersion', 'string', '1', 'The version of the code system'),
      p('sourceCoding', 'Coding', '1', 'The code to translate, as a Coding'),
      p('sourceCodeableConcept', 'CodeableConcept', '1', 'The code to translate, as a CodeableConcept (its first coding)'),
      p('targetCode', 'code', '1', 'A target code to translate back from (with targetSystem)'),
      p('targetCoding', 'Coding', '1', 'A target code to translate back from, as a Coding'),
      p('targetCodeableConcept', 'CodeableConcept', '1', 'A target code to translate back from, as a CodeableConcept'),
      p('targetVersion', 'string', '1', 'The version of the target code system'),
      p('sourceScope', 'uri', '1', 'The value set the source is in'),
      p('targetScope', 'uri', '1', 'The value set to translate into'),
      p('targetSystem', 'uri', '1', 'The code system to translate into'),
    ],
    out: [
      p('result', 'boolean', '1', 'Whether there\'s a translation', { min: 1 }),
      p('message', 'string', '1', 'More about the result'),
      p('match', '(parts)', '*', 'A translation', {
        parts: [
          p('relationship', 'code', '1', 'How the target relates to the source'),
          p('concept', 'Coding', '1', 'The target'),
          p('product', '(parts)', '*', 'Another element of the product (element, concept)'),
          p('originMap', 'canonical', '1', 'The concept map'),
          p('sourceConcept', 'Coding', '1', 'What was translated (for a translation in reverse)')
        ]
      }),
      p('used-conceptmap', 'canonical', '*', 'A concept map that was used')
    ]
  },
  {
    name: 'compare',
    common: true,
    resource: 'ValueSet',
    levels: ['type', 'instance'],
    summary: 'Compare two value sets',
    description: 'Compares two value sets: by their definitions where that\'s enough, and ' +
      'otherwise by their expansions. At the instance level, the instance is `this`.',
    in: [
      p('thisUrl', 'uri', '1', 'The first value set'),
      p('thisValueSet', 'ValueSet', '1', 'The first value set, sent with the request'),
      p('otherUrl', 'uri', '1', 'The second value set'),
      p('otherValueSet', 'ValueSet', '1', 'The second value set, sent with the request'),
      p('valueSetVersion', 'string', '1', 'The version of a value set named by url'),
    ],
    out: [
      p('result', 'code', '1', '`same`, `superset`, `subset`, `overlapping`, `disjoint`, `empty` or `indeterminate`', { min: 1 }),
      p('message', 'string', '1', 'The result, as text'),
      p('missing-codes', 'string', '1', 'diagnostics: the codes in the first value set and not the second (comma separated)'),
      p('extra-codes', 'string', '1', 'diagnostics: the codes in the second value set and not the first (comma separated)'),
      p('common-codes', 'string', '1', 'diagnostics: the codes in both (comma separated)'),
      p('performed-expansion', 'boolean', '1', 'diagnostics: whether the value sets had to be expanded')
    ]
  },
  {
    name: 'closure',
    resource: null,
    levels: ['system'],
    methods: ['post'],
    summary: 'Maintain a closure table',
    description: 'Adds concepts to a named closure table, and returns the new relationships, as ' +
      'a ConceptMap. Only POST: the operation changes the table. Not every server keeps closure ' +
      'tables (501 if not).',
    in: [
      p('name', 'string', '1', 'The closure table', { min: 1 }),
      p('concept', 'Coding', '*', 'A concept to add'),
      p('version', 'string', '1', 'Return the changes since this version of the table, instead of adding concepts'),
      p('reset', 'boolean', '1', 'Start the table again')
    ],
    returns: 'ConceptMap',
    returnsDoc: 'The new relationships'
  },
  {
    name: 'cache-control',
    resource: null,
    levels: ['system'],
    summary: 'Manage a cache of resources',
    description: 'A client that sends the same tx-resources with many requests can keep them in ' +
      'a cache on the server instead. `mode=start` creates a cache (with the tx-resources sent ' +
      'with it) and returns its id; later requests send the id in the `X-Cache-Id` header. ' +
      '`mode=check` reports whether the cache is still there (and keeps it alive); `mode=end` ' +
      'releases it. Caches expire when they aren\'t used.',
    in: [
      p('mode', 'code', '1', '`start`, `check` or `end` (in the query, even for a POST)', { min: 1, inQuery: true }),
      p('sealed', 'boolean', '1', 'start: whether the cache holds only what\'s sent now (default false: it grows with the tx-resources later requests send)'),
      p('tx-resource', 'Resource', '*', 'start: resources to put in the cache')
    ],
    out: [
      p('cache-id', 'id', '1', 'start: the new cache\'s id; check: the cache checked'),
      p('sealed', 'boolean', '1', 'start, check: whether it\'s sealed'),
      p('valid', 'boolean', '1', 'check: whether the cache is still there'),
      p('outcome', 'OperationOutcome', '1', 'check: why it isn\'t (when valid is false)'),
      p('resource-count', 'unsignedInt', '1', 'check: how many resources it holds'),
      p('idle', 'unsignedInt', '1', 'check: how long it has been unused (seconds)'),
      p('timeout', 'unsignedInt', '1', 'check: how long it can be unused before it expires (seconds)')
    ]
  }
];

module.exports = { OPERATIONS, COMMON, RESOURCES, VERSIONS, GENERAL, EXPANSION, VALIDATION, ref };
