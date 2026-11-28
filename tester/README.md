# Tester module

Runs the FHIRsmith RESTful API tests against a FHIR server: anyone logged in gives a server's
address (its base, where `[base]/metadata` is) and, if it needs one, a bearer token, and the
tests run against it in the background. Everyone can see every run's results. It runs at
`/tester` when `modules.tester.enabled` is true.

It also runs the npm registry protocol checks against a package registry (`/tester?kind=npm`;
see [npm registries](#npm-registries) below), and the HL7 terminology service tests against a
terminology server (`/tester?kind=tx`; see [terminology servers](#terminology-servers)): the
same queue, pages and reports.

The same tests run in jest against this server's own rest endpoint
(`tests/tester/suite.test.js`), so the server is held to what it tests others for.

## Configuration

```json
"tester": {
  "enabled": true,
  "database": "tester.db",
  "allowPrivateAddresses": false,
  "keepDays": 183,
  "detailDays": 30,
  "reportServer": "https://npm.fhir.org/testing",
  "reportTokenEnv": "FHIRSMITH_TESTING_TOKEN",
  "npm": { "enabled": true, "requestTimeout": 30000, "maxDownloadMB": 50 }
}
```

| Setting | Default | |
|---|---|---|
| `database` | `tester.db` | The runs and their results, in the databases folder (or an absolute path) |
| `allowPrivateAddresses` | false | Servers on private addresses too (localhost, 10.x, 192.168.x...): only on a server that isn't public. Otherwise, as for every request this server makes to an address someone gave it (library/ssrf-guard.js), only public addresses: checked when the run is asked for, and again on every connection, so redirects and DNS changes can't get round it |
| `keepDays` | 183 | Runs are deleted this many days (about 6 months) after they finish |
| `detailDays` | 30 | A run's step details (each test's requests and responses, and the resources it made) are cleared this many days after it finishes; the run and its results stay until `keepDays` |
| `reportServer` | none | Where each completed run's TestReport is sent (`POST [reportServer]/TestReport`): a FHIRsmith /testing module ([testing/readme.md](../testing/readme.md)), or anything else that takes TestReports. Without it, reports are only kept here |
| `reportTokenEnv` / `reportTokenFile` | none | The API token for the report server: the name of an environment variable that holds it, or a file (relative to the data folder) that holds it. Never the token itself in config.json |
| `reportTokenHeader` | `Authorization` | The header the token goes in (`Bearer {token}` in Authorization) |
| `packageServers` | packages2.fhir.org, packages.fhir.org | Where the core packages come from, for the XML model of the version tested (kept in the terminology cache) |
| `npm.enabled` | true | The npm registry checks |
| `npm.requestTimeout` | 30000 | Milliseconds for each request an npm run makes |
| `npm.maxDownloadMB` | 50 | The largest response an npm run reads (so, the tarball) |
| `npm.control` | `registry.npmjs.org`, `fhirpath` 3.15.0 | The registry, package and version the npm checks are verified against daily; `false` turns that off |
| `tx.enabled` | true | The terminology tests: off anyway when there's no Java to run the FHIR validator in |
| `tx.jar` | the data folder's `bin/validator_cli.jar`, downloaded and kept up to date | A validator of your own (used as it is) |
| `tx.port` | 8083 | The validator's port (on 127.0.0.1; the IPS and SHL modules' validators have their own) |
| `tx.idleMinutes` | 15 | The validator is stopped when no terminology run has wanted it for this long |
| `tx.limitMinutes` | 30 | The most a terminology run takes |
| `tx.testsVersion` | `current` | The build of the tests (`hl7.fhir.uv.tx-ecosystem`) |

## Running the tests

The home page has the form (for someone logged in) and the runs, newest first. A run:

- **Waits its turn**: one run happens at a time. Each person can have one run waiting or under
  way; asking for another is refused until it's over. The run's page shows its place in the
  queue, then its progress, and refreshes itself until it's over.
- **Reads the CapabilityStatement** (`GET [base]/metadata`). Only R4 (4.0.x) and R5 (5.0.x)
  servers are tested, and only those that do JSON; XML is tested too when the
  CapabilityStatement lists it. A server with no CapabilityStatement, or another version, ends
  the run, saying why.
- **Runs each test**, unless the CapabilityStatement doesn't say the server supports what the
  test needs (an interaction on a type, a search parameter, an operation, a format, a
  conditional interaction, a patch format...): then the test isn't run, and its outcome says
  why. Each request has 30 seconds; the run has 15 minutes, after which the rest aren't run.
- **Cleans up**: everything the run made is deleted, newest first, and expunged when the server
  lists `$expunge` (`expungeDeletedResources`, `expungePreviousVersions`). Anything that couldn't
  be deleted is listed on the run's page.
- **Reports**: the run as a TestReport, on the run's page (`[base]/runs/{id}/report`), and sent
  to `reportServer` if there is one (a completed run only; the page says whether it was sent).

Who asked for a run, or an administrator, can cancel it: a waiting run at once; a run under
way stops after the request it is making, and then cleans up.

### The token

The bearer token is sent with every request of the run (`Authorization: Bearer {token}`). It is
kept in the database only while the run is waiting or under way, and set to nothing as the run
ends, however it ends (and for a run under way when the server stopped, as the server starts
again). It is never shown: the requests the pages show have `Bearer (the run's token)`. The
database has secure_delete on, so a cleared token is overwritten, not left in the file.

**Everything else from a run is public.** The runs, their results, and each test's requests
and responses (bodies up to 64 KB) can be seen by anyone, logged in or not. The token isn't,
but what the server answered with it is: a run with a token reads what only the token lets
anyone read (the history of the whole server, searches, a patient's compartment), and that is
on the run's pages, for anyone to see, until the step details are cleared (`detailDays`). Test
a server that holds real data only if that is all right.

### Outcomes

| Outcome | |
|---|---|
| pass | The server did what the specification requires, and recommends |
| fail | The server didn't do what the specification requires (SHALL): the message says what, and the page shows the requests and responses |
| warning | It did what is required, but not what the specification recommends (SHOULD), or not the choice the specification names where it allows more than one (a version conflict: 409 is allowed, 412 is what Managing Resource Contention says) |
| skip | Not run: the CapabilityStatement doesn't say the server supports what the test needs (or the run was cancelled, or out of time) |
| error | The test couldn't be completed: no answer in time, a connection refused... |

Each test's name on the run's page links to the test's own page
(`[base]/runs/{id}/tests/{n}`): its outcome and why, the resources it made to test with (as the
server had them once made), and every request it made and the response, in order, the setup
ones marked as setup (bodies up to 64 KB each; the token never shown). These step details are
cleared `detailDays` (30) days after the run, and the run itself deleted after `keepDays` (183).

### What a server needn't support

Much of search is optional: modifiers (`:missing`, `:text`, `:of-type`, `:identifier`...), the
rarer prefixes (`ne`, `sa`, `eb`, `ap`), chaining, reverse chaining, `_include` variants,
sorting, `_type`. The CapabilityStatement can't say which of these a server does, but the
specification says a server SHALL refuse what it doesn't support. So for these:

- **refused** (400, 404, 405, 422 or 501): not supported. The test says so (with the server's
  reason), and is a skip if none of what it tests is supported
- **done**: it must be right; a wrong answer is a fail (or a warning, where the specification
  only recommends the behaviour, such as comparing UCUM units by their canonical form)
- **ignored**: if the answer is everything the test made, as if the parameter weren't there, it's
  a warning: the server seems to have ignored what it doesn't support, instead of refusing it

Absolute references to "this server" use the address the server says it has (its
CapabilityStatement's `implementation.url`), else the address tested.

## The server's data

The tests assume the server already has data, and that other clients may be using it (without
touching what the tests make). So:

- Everything a run makes has a tag with the run's id
  (`https://github.com/HealthIntersections/FHIRsmith/tester|{run id}`), and a tag and an
  identifier system of the test's own. A test's searches are limited to its own resources: by
  `_tag`, or, when the server doesn't list `_tag` for the type, by the identifier system. Where
  it can do neither, the test isn't run.
- Names searched for are made up for each test (`Tst` and ten random letters), and ids read for
  "not found" tests are random.
- Nothing a test does changes or depends on anything the run didn't make.

The client must be able to write: by its token, or because the server lets anyone.

## The tests

The tests are in [suite/](suite), in groups (the order they run):

| Group | What |
|---|---|
| Capabilities | the CapabilityStatement; in XML; `_format` |
| Create, read, update, delete | create (201, Location, ETag, the id in the body ignored), read, 404, vread, update (and version checks with If-Match, the id checks), update as create, delete (410 after, and again), `Prefer: return=`, If-None-Match and If-Modified-Since |
| Errors | unknown types, bad JSON, the wrong type, no resourceType, a required binding broken, an unsupported content type |
| History | of an instance (versions, newest first, request and response, a delete), of a type since a time |
| Search | string (starts with, case and accents, `:exact`, `:contains`), token (`system|code`, `|code`, `:not`), date (precision, prefixes), reference (by id, by Type/id), quantity, `_id`, `_lastUpdated`, OR and AND, nothing found, deleted, POST `_search`, paging, `_include`, `_revinclude`, `_has`, `_summary=count`, `_elements`, `_filter` (and, or, not, brackets, dates), the self link (followed, and without a parameter the server ignored), unknown parameters (lenient and strict) |
| Search: parameter types | string over name parts and addresses; token booleans, `system|`, `|code`, ContactPoints, `:text`, `:of-type`, `:missing`; dateTimes at each precision and in time zones; Periods (eq contains, gt/lt overlap); `ne`, `sa`, `eb`, `ap`; quantities (number alone, code alone, implicit precision, `ne`, UCUM units); composites; `:missing` on strings and dates; `:in` and `:not-in` (administrative-gender); uri `:below` and `:above`; token `:below` and `:above` (v3 ActCode's `_ActEncounterCode` > `IMP` > `ACUTE`, else FHIR's fhir-types, through the server's terminology: a server that finds only the code itself doesn't know the hierarchy, and that's a skip); `_text` and `_content` |
| Search: references and chaining | references stored relative, as an absolute URL to the server, version-specific, logical (an identifier: `:identifier`), and to another server, each searched in the forms that should find it (Type/id, id, `:Type`, absolute); chaining with one target type, several (with and without the type), with a modifier at the end, to a token, two levels, and through absolute and versioned references; `_has`, and `_has` in `_has`; `_include` with a target type, `:iterate` and `*`; `_revinclude` |
| Search: contained resources | not matches by default (a contained Patient isn't found by `Patient?family`); a chain is evaluated inside them (`subject:Patient.family`, `patient.family`); `_contained` (`true`, `both`) and `_containedType` (`container`: the containers, mode `match`; `contained`: the contained resources, fullUrl `[base]/[type]/[id]#[local id]`) |
| Search: results | `_sort` on several keys, descending, and `_lastUpdated`; `_summary=true` and `data`; entries' fullUrl and search.mode; `_total=accurate`; `[base]?_type` and `[base]?_tag`; a compartment (`Patient/[id]/Observation`, with parameters, and `Patient/[id]/*`) |
| Conditional interactions | create (none, one, two), update (one, none, two), delete (one, none, two: refused when single, both deleted when multiple), patch (R5's `conditionalPatch`, or in R4 its cross-version extension) |
| Patch | JSON Patch (and a test that fails, and If-Match), FHIRPath Patch in JSON and XML |
| Transactions and batches | urn:uuid references, rollback (an update with If-Match an old version), a PUT whose id isn't the URL's, update + delete + conditional create + read together, a batch's entries on their own, a Bundle that is neither |
| Operations | `$meta-add`, `$meta`, `$meta-delete`; Patient `$everything` |
| Observation operations | `$lastn` (the latest of each code, `max`, with a code, not another patient's), `$stats` (average, minimum, maximum and count of a patient's weights over a period, in their unit) |
| HTTP: headers, formats and ids | mime types (`application/fhir+json`, `application/json`, `fhirVersion`, `*/*`, an unknown type: 406, a body sent as `application/json`); a read with `_format`, `_pretty`, `_summary` and `_elements`; ids that aren't FHIR ids (read and update); `X-Provenance`; `Prefer: respond-async` on a search (202, Content-Location, polled to the answer) |
| XML | create, read, update, search, errors, XML that isn't well formed |
| Binary | content in, content out, and the Binary resource |

## npm registries

`/tester?kind=npm` has the form for a registry: its base address (what you would give
`npm --registry`), a package and version it has, and a bearer token if it needs one (sent only
to the registry's own origin, never to a tarball elsewhere). The run is queued, run, kept and
reported like any other: one at a time, one per person, the token gone at the end, the same
SSRF rules (`allowPrivateAddresses`), and a TestReport (named "FHIRsmith npm registry tests",
test script `https://github.com/HealthIntersections/FHIRsmith/tester/npm`) sent to
`reportServer`.

The checks ([npm/checks.js](npm/checks.js)) walk the path an npm client takes: search for the
package by name, read its package document (as npm asks for it, and in full), read the
version's document and `latest`, ask for a package and a version that don't exist, download the
tarball, and read the registry's signing keys. Every request is made first, then each check is
made against the responses: a group for each step, a test for each check (pass or fail: these
are what npm clients depend on), and the requests and responses each check was based on on its
page (a tarball's content isn't shown). Nothing is changed on the registry. A run has 5 minutes.

The checks must all pass against registry.npmjs.org: npm is the reference. The module runs them
against it once a day (`npm.control`), and the npm pages say if any fail there, since those
checks may then be out of date. `tests/packages/npm-registry*.test.js` run the same checks in
jest. `/packages/npm-check`, where they used to be, redirects here.

## Terminology servers

`/tester?kind=tx` has the form for a terminology server: its address (its base, where
`[base]/metadata` is: https only, unless `allowPrivateAddresses`) and the modes to run the tests
in, a checkbox each: general (ticked to start with), SNOMED CT, LOINC, ICD-11, ICF, OMOP, mime
types, `$closure`, and tx.fhir.org (where the specification leaves it open, behaving as
tx.fhir.org does). The browser keeps the modes chosen last (localStorage). There's no token:
the tests are run anonymously.

The tests are the tx-ecosystem IG's (`hl7.fhir.uv.tx-ecosystem#current`), as the jest run of
this server's own (`tx/tests/test-runner.js`), and the FHIR validator runs them: the module
starts one of its own (`tx.port`, with its terminology test endpoints) the first time a run
wants it, and stops it once it has been idle for `tx.idleMinutes`. A run opens a test session
on the server; the validator connects to it, and its FHIR version (from its metadata) decides,
with the modes, which tests are asked for (as tx/tests/test-case-gates.js decides them for the
jest run: a test's and its suite's modes and version gates; not `full-set` ones, or disabled
ones). Each test is a result, grouped by suite, with its page showing the request (from the
package), the expected response, and for a failure, what the server answered (the validator's
expected and actual files, which are then deleted). The run is in the same queue as the others,
with 30 minutes (`tx.limitMinutes`).

The validator makes the requests, so its own SSRF protection is what keeps a run to public
servers: on (https only; non-public addresses refused as it connects, redirects included)
unless `allowPrivateAddresses`. The address is checked here too, before the run is queued.

The report is a TestReport like the jest run's (`TxEcosystemTests`, the test-cases.json as its
test script, at the package's version), with the server, the validator, and the modes, sent to
`reportServer` with the others.

### Writing a test

A group is a module in `suite/` exporting `{ name, tests }`, listed in `suite/index.js`. A test is
`{ name, requires, run }`:

- `requires`: what the CapabilityStatement must say for the test to run - `interactions:
  [[type, code]]`, `system: [code]`, `search: [[type, name]]`, `operations: [[type, name]]`,
  `scope: [type]` (its searches can be limited to the test's resources), `format: 'xml'`, and
  `check: (cap) => why not, or null` for anything else (tester/capabilities.js).
- `run(ctx)`: does the test, with `ctx.client` (get, post, put, patch, delete: JSON by default,
  `{ format: 'xml' }` for XML), `ctx.cap`, `ctx.resource(type, fields)` (a resource of the
  test's: tagged, with an identifier), `ctx.create(resource)` (POST it as setup, check 201, read
  it back if need be, and note it for cleaning up; `ctx.createNow` when the create is what's
  tested), `ctx.setup(fn)` (other requests that are setup), `ctx.created(type, id)` (note
  something made another way), `ctx.search(type, params)` (limited to the test's resources; the
  matches' ids), `ctx.optional(type, params, expected, options)` (for what a server needn't
  support: above), `ctx.allPages`, `ctx.serverBase`, and the checks: `ctx.must(cond, message)`
  (fails the test), `ctx.should(cond, message)` (a warning), `ctx.status(res, codes, what)`,
  `ctx.body(res, type, what)`, `ctx.skip(why)`, `ctx.note(message)`.

Tests must only make resources of their own (ctx.resource) and only look at those, and must pass
against this server's rest endpoint (`npx jest tests/tester`), or be listed in that test as
expected not to, with why.
