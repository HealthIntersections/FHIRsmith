# The rest module

Database-backed FHIR RESTful servers inside FHIRsmith. Each endpoint has its own FHIR version,
definitions, data and users' roles, and keeps its state in SQLite or MySQL. Processes cache
very little: any process can serve any request, so the module runs under the cluster like the
tx module.

The design is in the design document (*FHIRsmith REST module: design*); this file is how to
run it.

## What it does

- JSON and XML (see Formats)
- read, vread, create, update, patch (JSON Patch and FHIRPath Patch), delete, history, search, capabilities,
  batch and transaction, with conditional create, update, patch and delete
- search: every parameter type and the usual modifiers and prefixes, chains and `_has` (3
  levels), composites, `_filter`, `_list`, `_sort`, `_include` and `_revinclude` (with
  `:iterate`), `_summary`, `_elements`, `_total`, and paging through stored results
- `:below` and `:above` on tokens through a closure table, kept up to date with the endpoint's
  terminology server's `$closure`; `:in` and `:not-in` through its `$expand`
- full-text search: `_text` (the narrative) and `_content` (the whole resource)
- contained resources indexed with their own search parameters, so chains reach into them
  and `_contained` / `_containedType` search them; a reference to a contained resource that
  isn't there is a 422
- `$meta`, `$meta-add`, `$meta-delete`, `Patient/[id]/$everything`, and `Observation/$lastn`
  and `Observation/$stats` (see Observations)
- `$expunge`, to remove history for good (see Expunge)
- AuditEvents for writes (and, if set, reads and failures), stored on the endpoint
- the `X-Provenance` header (see Provenance)
- async requests (`Prefer: respond-async`; see Async requests)
- a subscription queue (`SubscriptionQueue`), filled by every write; nothing delivers it yet
- users and roles from the server's logins (library/auth)

What search supports, parameter by parameter, is in [search.md](search.md), and what isn't
supported yet in [status.md](status.md).

## Configuration

config.json says only where each endpoint is and which database it uses:

```json
"rest": {
  "enabled": true,
  "endpoints": [
    { "path": "/fhir/r4", "fhirVersion": "4.0.1",
      "database": { "type": "sqlite", "file": "rest/fhir-r4.db" },
      "initialSettings": { "name": "R4 test server", "anonymous": "read" } },
    { "path": "/fhir/r5", "fhirVersion": "5.0.0",
      "database": { "type": "mysql", "host": "localhost", "database": "fhir_r5",
                    "user": "fhirsmith", "passwordEnv": "FHIR_R5_DB_PASSWORD" } }
  ]
}
```

| Setting | |
|---|---|
| `path` | Where the endpoint is on this server. |
| `fhirVersion` | The FHIR version (3.0, 4.0, 4.3 or 5.0). Fixed when the database is made; a different one later is an error. |
| `database` | `{ "type": "sqlite", "file" }` (relative to the databases folder), or `{ "type": "mysql", "host", "port", "database", "user", "passwordEnv" or "passwordFile", "connections" }`. Never a password in config.json: `passwordEnv` names an environment variable, `passwordFile` a file only the server can read. Two endpoints can't share a database. |
| `baseUrl` | The endpoint's public URL, if it isn't `https://{hostName}{path}`: references to it are local references. |
| `initialSettings` | Settings (below) written into a new database. A setting already in the database is never changed from here: the log warns at start-up when the two differ. |
| `initialSettings.loadPackages` | Packages to load into a new database (see Loading packages): `"id#version"`, `"id"` (the latest), or `{ "package", "version", "examples": true }`. Only when the database is made: never again after. |
| `types` | Per-type settings (below) for types not in the database yet. |
| `modules.rest.packageServers` | The package servers definitions are fetched from (packages2.fhir.org, then packages.fhir.org). |

The database's tables are made, and later brought up to date, when the server starts (on the
master, under a lock). A MySQL database must exist, with a user that can create tables in it,
`utf8mb4`.

## Settings

Everything else about an endpoint is in its own database: the `Config` table (`Name`, `Value`)
and, per resource type, `Types.Settings` (JSON). There are no admin pages yet: change them in
the database, and bump the `generation` row in `Config` (every process reloads within a second
when it changes).

| `Config` | Default | |
|---|---|---|
| `name`, `description` | | For the CapabilityStatement. |
| `packages` | `[]` | IG packages (`id#version`, JSON list) whose search parameters and compartments are loaded, after the core package. |
| `idStrategy` | `key` | Server-assigned ids: `key` (the resource's database key: short) or `uuid`. |
| `createOnUpdate` | true | PUT to a new id creates. |
| `checkReferences` | true | A write whose references to this endpoint don't resolve gets 422. |
| `txServer` | | The terminology server for `:in`, `:not-in` and the closure, and the one the endpoint's terminology requests are passed on to (see Terminology): a path on this server (the tx module's endpoint, in process) or a URL. |
| `maxValueSetExpansion` | 10000 | The most codes a value set can have to be searched (`:in`, `:not-in`) by expanding it. Bigger ones, and ones that aren't closed, can be registered for searching (see Web pages). |
| `audit` | `writes` | AuditEvents: `off`, `writes`, or `all` (reads and failures too). |
| `defaultCount`, `maxCount` | 50, 500 | Page sizes. |
| `searchMaxResults` | 20000 | The most results a search keeps for paging. |
| `searchKeepMinutes` | 30 | How long stored results are kept. |
| `timeZone` | the server's | For dates without a zone (an IANA name). |
| `compress` | true | Resources are stored gzipped. |
| `transactionMaxEntries` | 1000 | The biggest transaction. |
| `anonymous` | `none` | `read`: anyone can read (a public server); `write`: anyone can read and write (a sandbox). |
| `customSearchParameters` | false | SearchParameter resources stored on the endpoint are used too. |
| `conditionalDeleteMax` | 1 | The most resources a conditional delete deletes. |
| `asyncRequests` | true | Requests with `Prefer: respond-async` are queued (see Async requests); false: the preference is ignored. |
| `asyncKeepHours` | 24 | How long an async request's result is kept. |
| `asyncMaxPerUser` | 5 | The most async requests one user can have queued or running at once (429 past it). 0: no limit. |

| `Types.Settings` | Default | |
|---|---|---|
| `versionAware` | false | Updates and patches need `If-Match`. |
| `interactions` | all | The interactions allowed: `read`, `vread`, `update`, `patch`, `delete`, `history-instance`, `history-type`, `create`, `search-type`. |
| `conditionalCreate`, `conditionalUpdate`, `conditionalDelete` | true | |

`Types.Supported` 0 takes a type off the endpoint.

## Terminology

The endpoint passes its terminology requests on to its terminology server (`txServer`;
rest/operations/terminology.js): `metadata?mode=terminology` (TerminologyCapabilities),
`CodeSystem/$lookup`, `$validate-code` and `$subsumes`, `ValueSet/$expand`, `$validate-code`
and `$batch-validate-code`, `ConceptMap/$translate`, and `$closure`. The answer is the
terminology server's (its status, and its resource), in the format asked of the endpoint; its
CapabilityStatement lists them. On an instance (`ValueSet/[id]/$expand`), the endpoint's
resource is named to the terminology server by its url and version, so that server has to know
the endpoint's resources. Without a `txServer` they aren't supported (501).

The tx module can publish an endpoint's CodeSystems, ValueSets and ConceptMaps: a source
`rest:<endpoint path>` (e.g. `rest:/r4`) in its library (tx/README.md, Source types), read from
the endpoint's database. With the endpoint's `txServer` set to that tx endpoint, the endpoint's
own value sets work for `:in` and `:not-in`, its own code systems for `:below` and `:above`, and
the operations above work on them.

**What that publishes.** Hooked up to a terminology server this way, every CodeSystem, ValueSet
and ConceptMap in the endpoint is as public as the terminology server itself: anyone who can use
the terminology server can read them and use them there, whatever the endpoint's own access
rules (`anonymous`, roles) say.

**When changes show.** The terminology server picks up changes on its own schedule: a new or
changed code system within a minute, a value set or concept map within a few seconds of the next
request that uses one. So a search, or an operation, straight after a write can still see the
previous content.

## Transactions

A transaction is all or nothing: every entry is written in one database transaction, and any
failure leaves the database as it was, with the failing entry's OperationOutcome (naming the
entry). Before anything is written:

- every write entry is given the one resource it changes. A POST gets a new id; a conditional
  create, update, patch or delete is searched once, here. **A resource may be changed by only
  one entry**: two that change the same one (directly, or through what a conditional resolves
  to) fail the transaction, with 400. So do two conditional creates with the same criteria
- conditional references (`Patient?identifier=x`) are searched: exactly one match, else 412
- every write entry's fullUrl (a `urn:uuid:`, or an absolute URL) is mapped to its resource,
  and references to it are rewritten wherever they are the whole value of an element, and in
  narratives in `<a href>` and `<img src>` only, matching exactly or up to a `#`. A
  `urn:uuid:` or `urn:oid:` reference left over points at nothing: 400
- references with the `resolve-as-version-specific` extension get the version the transaction
  writes (the extension is removed)

Then the entries run: deletes, creates, updates and patches, reads (which see the writes).
Reference checks wait until every entry is written: a reference to a resource that won't exist
(or that the transaction deletes, or to a version that doesn't exist) fails with 422. The
response has an entry for each entry, in the request's order.

Posting a Bundle needs only read: each entry is checked for what it does. In a batch, each
entry runs on its own, and an entry can't refer to another by its fullUrl.

The tests (`tests/rest/transaction-rules.test.js`, `tests/rest/transaction-fuzz.test.js`)
check each rule, and also run random transactions against a model of these rules
(`FHIRSMITH_FUZZ_ROUNDS`, `FHIRSMITH_FUZZ_SEED` to repeat a run).

## Provenance

A create, update or patch (or a conditional one), a batch or a transaction can carry a
Provenance resource, in JSON, in the `X-Provenance` header. The server stores it with its
targets filled in: version-specific references to what the write made.

- a create, update or patch: one Provenance, for the version written. A conditional create
  that finds the resource already there writes nothing, so it gets no Provenance
- a transaction: one Provenance, with a target for each resource it creates, updates or
  patches (not those it deletes or reads)
- a batch: one Provenance for each entry that creates, updates or patches

The Provenance is written in the write's own database transaction, as the write's AuditEvent
is: there is one exactly when the write is kept, and if the Provenance can't be stored (a
reference in it to something that doesn't exist, say) the write fails too. The header's own
target and signature are dropped (a signature can't be right once the targets change), as
are its id and version; `recorded` is the time of the write if the header has none. The
Provenance is a write of its own, so it gets an AuditEvent too. A header that isn't valid
JSON, isn't a Provenance, has a property twice in an object, or comes on a request that
doesn't write, is refused (400), as is the header on an endpoint that doesn't support
Provenance. Headers are limited in size (Node's default for all of a request's headers is
16 KB: `--max-http-header-size`); for anything bigger, send the Provenance in a transaction
with the resource instead.

## Async requests

A search, history, batch, transaction or operation with `Prefer: respond-async` (or
`_async=true`, as the Pascal server took) is queued, and answered `202 Accepted` with a
`Content-Location`: `[base]/_async/{uuid}` (rest/queue/async.js). Anything else asked for that
way gets a 400. `GET` that URL:

- `202` while it is queued or running, with `X-Progress` (`queued`, `queued (3 ahead)`,
  `running`) and `Retry-After`
- `200` once it is done: a `batch-response` Bundle whose `entry[0]` is the request's own
  response (`response.status`, `location`, `etag`, and the resource or `outcome`). A request
  that failed, a transaction with a bad entry say, is still a `200` here, with the failure in
  `entry[0].response`. It's in the format the kickoff asked for (`Accept` or `_format`, and
  `_pretty`)
- `500` if the job itself failed (its user is no longer there, the process running it stopped)
- `404` for a job that is unknown, someone else's, cancelled, or more than `asyncKeepHours`
  (24) old

`DELETE` it to cancel (202): a queued job is dropped; a running batch or transaction stops at
its next entry (a transaction rolls back, so nothing is written); a search or operation that is
running finishes, and its result is thrown away.

A job is its user's: only they can see or cancel it (an anonymous one, anyone with its URL; the
id is a random UUID). It runs as that user, looked up again when it starts, with their access
checked again then. A user can have `asyncMaxPerUser` (5) queued or running at once. Bulk data
(`_outputFormat`, `$export`) is not supported yet (501); it will build on this.

The jobs are run by the queue runner (rest/queue/runner.js) in the process that runs the
endpoint's background jobs: one at a time, in order. The request and the result are kept in the
endpoint's database (`AsyncJobs`, and `JobFiles`, in pieces of 1 MB: rest/queue/files.js, behind
an interface that a folder or S3 could take over). The runner keeps a heartbeat on the job it is
running; a job whose runner has stopped for a minute is marked failed, not run again, since it
may have done some of its work. Results past `asyncKeepHours`, and their jobs, are removed.

The status page (`/`, under More: Rest background jobs) shows the queue: how many are queued and
running, how long the oldest has waited, and for those started in the last hour how long they
waited to be started and how long they took; with every queue runner task's runs, timings and
last error (cluster.md, Status).

## Expunge

Nothing else ever removes history: `$expunge` is the one way to (rest/operations/expunge.js),
as HAPI has it. It needs the endpoint's manage role, is a `POST`, and answers a Parameters
with `count`, the versions it removed.

- `[base]/[type]/[id]/_history/[vid]/$expunge`: that version (no body). Not the current one
  (409): delete the resource, then expunge it
- `[base]/[type]/[id]/$expunge`, `[base]/[type]/$expunge`, `[base]/$expunge`, with a
  Parameters body: `expungePreviousVersions` (the versions before each current one),
  `expungeDeletedResources` (deleted resources, every version: gone as if never made, and the id
  can be used again), `expungeEverything` (`[base]/$expunge` only: every resource), and
  `limit` (at most this many versions; a resource goes whole or not at all). One of the first
  three must be true.

Version numbers aren't reused: after versions 1-3 with 2 expunged, the next is 4. A reference
to a resource that was expunged is left as a reference to something that isn't there (it is
keyed again if the resource is made again). The AuditEvents that recorded what was removed stay,
and the expunge is itself audited. It runs in batches, each its own transaction, so it can be
asked for asynchronously (`Prefer: respond-async`) when there's a lot.

## Patch

A PATCH's body is a JSON Patch (`application/json-patch+json`: an array of operations), or a
FHIRPath Patch (a `Parameters` resource, as JSON or XML; in a batch or transaction, the
entry's resource). A patch that can't be applied, or that changes the resource's type or id, is
a 422; a body that is neither is a 400.

FHIRPath Patch (rest/library/fhirpath-patch.js) applies `add`, `insert`, `delete`, `replace`
and `move`, as the specification says: each path must find one element (for `insert` and
`move`, the whole of one list; `insert` can find an empty list by the element that would hold
it), except that `delete` does nothing when there's nothing there; `add` appends to a list, and
won't overwrite an element that doesn't repeat. A value's type must be one the element can
have (a narrative's `div` is a `valueString`); for a choice element the type picks the JSON
name, so `replace` can change it. Elements left empty by a delete are taken out. What an
element is comes from the same model as XML (the core StructureDefinitions). `resolve()` can
only find the resource's own contained resources. Making a patch (a diff of two versions) isn't
supported.

It passes the shared test cases, fhir-test-cases `r4/patch` and `r5/patch`
(`tests/rest/fhirpath-patch.test.js`). The tests find fhir-test-cases through
`tests/helpers/fhir-test-cases.js`: a clone named by `FHIR_TEST_CASES`, a `test-cases` clone
beside FHIRsmith, or the files downloaded from GitHub into `test-cache/` (delete
`test-cache/fhir-test-cases` to get them again).

## Observations

Each Observation with an `effective[x]` and a code also has its values kept
(rest/indexing/observations.js), as the old Pascal server did: a row for the observation, and
one for each component, with its code (grouped: observations whose codes have the same
codings, or for a code with only text, the same text, are in one group), subject, status, the
time to sort by (the `effective[x]`, a period's end), and a `valueQuantity` in its own unit
and, for UCUM, in the canonical form. They are written and taken out with the other index
rows. An Observation without an `effective[x]` isn't found by either operation.

`Observation/$lastn` is an Observation search that returns, of what matches, the most recent
`max` (default 1) in each code group, the groups one after the other. It needs the patient or
subject, and a category or a parameter on the code (`code`, `combo-code`, ...); `_include`,
`_count` and the rest work as for a search, and statuses aren't filtered unless asked for.

`Observation/$stats` (GET, or POST with a Parameters) works out statistics for a subject's
observations of a code (`code` with `system`, or `coding`, each with its own results), from
their `valueQuantity`, over `duration` hours or a `period` (or everything). The code's
observations count, and so do the components with that code; when its observations have
components or members (`hasMember`), as panels do, each of their codes gets statistics too.
Entered in error is left out. The values are in their own unit when they all have the same
one, else in the canonical UCUM unit; when that can't be done either, only the counts are
given. The statistics (all of the observation-statistics codes) are described in
rest/operations/observations.js; `include` adds the source observations, the most recent first,
at most `limit`.

UCUM is the terminology server's own UCUM service (tx/library), for these and for searching
quantities (a temperature in Cel or [degF] is in kelvin in canonical form).

## Binary

A Binary is also its content (rest/binary.js). A `POST` to `[base]/Binary`, or a `PUT` to
`[base]/Binary/[id]`, whose `Content-Type` isn't a FHIR format is stored as a Binary with that
`contentType` and the bytes as its `data`; `X-Security-Context` is its `securityContext`. A read
or vread gives the bytes back with that `Content-Type`, unless the request asks for a FHIR
format (`_format`, or a JSON or XML type first in `Accept`) and the Binary's content isn't one:
then it is the Binary resource. A browser gets the content too, not a page. Searches, history
and Bundles always have the resource.

What counts as a FHIR format is what the Pascal server took: the JSON and XML types, and any
type with `json` or `xml` in its name (`application/vnd.x+json`, `image/svg+xml`). A body of
such a type is read as a FHIR resource, the Binary resource itself, so content that is JSON or
XML is written as a Binary resource with the content base64 in `data`. Such a Binary is read
back as its content whatever the `Accept`, as the Pascal server read every Binary. (The Pascal
server also took `text/plain`, `text/html`, Turtle and NDJSON as formats, and couldn't store
them as content: here they are content.)

The content is sent with `X-Content-Type-Options: nosniff` and `Content-Security-Policy:
sandbox`, so HTML or SVG anyone uploaded doesn't run as one of this server's pages, with the
reader's login. `?download=true` sends it as an attachment. It's read and written whole, up to
the server's body limit.

## Formats

JSON and XML, in and out. A response is XML when `_format` asks for it (`xml`,
`application/fhir+xml`...), or when the first type in `Accept` (by q, then order) that is JSON
or XML is XML; `text/html` and wildcards count as JSON, which is the default. A body is read as
XML when its `Content-Type` is `application/fhir+xml`, `application/xml` or `text/xml`. Errors
come back in the format asked for. `_pretty=true` indents either.

Decimals keep their precision (library/fhir-json.js): `1.0`, `2.50` and `1E+3`, in JSON or
XML, are stored and returned as they were given, through create, update, patch (what a patch
adds too) and transactions, though the values are numbers for searching. A value a patch
changes is written the usual way.

A JSON body with a property more than once in the same object is refused (400), whether or
not resources are validated: parsers keep only one of them, so what was meant can't be known.
The OperationOutcome has an issue for each, like the Java validator's (message id
`DUPLICATE_JSON_PROPERTY_REJECTED`, also in core, in the request's Accept-Language), with the line and column of
the name and the path of the object it is in (`library/json-duplicates.js`, shared with the tx
and ips modules).

Resources are stored as JSON, and converted (library/fhir-xml.js, shared with the tx module)
by a model of the FHIR version's types derived from the core package's StructureDefinitions,
kept with the endpoint's other derived definitions: for each element, its order, whether it
repeats, its type or types, and whether it's an attribute. Every resource in the R4 and R5 core packages converts to XML and
back unchanged (tests/rest/xml.test.js). A large response is written in pieces, giving the
event loop back every 25 ms, and stops if the client goes away; the response is checked before
any of it is sent, so an error is still an error.

- XML coming in with a DOCTYPE is refused (so no entities can be defined), as is any entity
  that isn't one of XML's own, or an element or attribute the definitions don't have.
- A stored resource with something the definitions don't have (the server doesn't validate
  JSON) can't be written as XML: asking for it as XML is an error that says what (500), and
  JSON still works.
- In the narrative, an XML reader turns line ends (`\r\n`, `\r`) into `\n`, so those can
  change on the way in from XML.

## Web pages

A browser that opens an endpoint's URLs (`Accept: text/html`, or `?_format=html`) gets pages
over the same API, with the same access checks:

- the endpoint (`[base]`): what it is, the resource types with how many of each, and the
  CapabilityStatement
- a type (`[base]/Patient`): how many there are, and a search form built from its search
  parameters
- search results, history and `$everything`, as tables that link to each resource
- a resource: what identifies it (id, version, identifiers, name, status, subject...), its
  narrative (unless it carries active content), and its JSON

`?_format=json` gets the JSON in a browser. These pages only read: every change goes through the
API.

For the manage role there are two administration pages, linked from the endpoint's page and
the user's account page:

- `[base]/_admin/packages`: loading packages (below).
- `[base]/_admin/valuesets`: the value sets registered for searching. A value set too big to
  expand, or not closed, can't be searched with `:in` (the search says so, and points here);
  registered, with a version chosen from those the terminology server has, it is searched by
  membership instead, worked out in the background (search.md says how).

## Loading packages

A package's resources can be loaded into the endpoint: those listed in
`initialSettings.loadPackages` when the database is made, and any asked for on the packages
page (package id, version or the latest, and whether to include its `example` folder). They are
queued, and the jobs process (or the master, without one) loads them one at a time, in the
background; the page shows each load's progress, then a report: what was created, given new ids, left unchanged, skipped and failed.
A load that was running when the server stopped is marked as failed; loading it again is safe.
Packages are fetched like the definitions' (`packageServers`), and one for another FHIR
version is refused.

Each resource in the package's folder (and `example`, if asked for) is stored at its Type/id:

- Nothing there (or a deleted resource): it is stored there.
- The same resource there (apart from its meta): it is left alone.
- A different resource there: it is given a new id, as if POSTed, and every `reference` in the
  package's resources that is Type/old-id (or Type/old-id/_history/n) is changed to Type/new-id.
  A resource that refers to one given a new id is compared with the reference changed, so it may
  be given a new id too.
- No id: it is given one.

Loading a package again changes nothing: a resource given a new id (or one with no id) in an
earlier load of the package, and the same as what was stored then, is left alone. Types the
endpoint doesn't have are skipped. References aren't checked (a package refers to others), and a
resource that can't be stored is reported, without stopping the rest.

Loading is administrative: the ids are worked out when it starts, on the assumption that the
endpoint isn't being changed at the same time.

## Access

Users, logins and API tokens are the server's ([library/auth](../library/auth/README.md)). The
module's roles, given per endpoint (or for all) on the users page:

| Role | Allows |
|---|---|
| read | read, vread, search, history, capabilities, `$meta`, `$everything` |
| write | create, update, patch, delete, batch, transaction, `$meta-add`, `$meta-delete` (and read) |
| manage | (and read and write) the endpoint's settings, when there are pages for them, and `$expunge` |

Administrators have them all. Software sends an API token (`Authorization: Bearer fhs_...`).

## Clustering

Under the cluster (cluster.md), the master migrates the schema, and the jobs process
(`--role=jobs`, which the launcher starts) runs the background jobs and the queues
(rest/queue/runner.js): deleting expired searches, the closure, package loads, value set
membership, reindexing when definitions change, and async requests. It serves no requests, so
the work doesn't slow the processes that do. With `server.cluster.jobsProcess` false the master
runs them instead; without the cluster the one process does everything. The jobs process
doesn't run the tx module: a `txServer` that is a path on this server is reached through the
launcher's port. Workers serve the endpoints when `server.cluster.workerModules` includes
`"rest"`: everything is in the database, so any process can serve any request, including the
next page of a search another ran, or an async request another queued. With SQLite every process must be on one machine, and writes take turns through one lock;
MySQL scales writes, and its workers can be on several machines.

## Tests

`npm test -- tests/rest` runs the module's tests on SQLite, and on MySQL when
`FHIRSMITH_TEST_MYSQL` says where (`host:port/database:user`, with the password in
`FHIRSMITH_TEST_MYSQL_PASSWORD`); without it the MySQL half is skipped, with a notice. The
database is emptied first: use one for testing only.
