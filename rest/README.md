# The rest module

Database-backed FHIR RESTful servers inside FHIRsmith. Each endpoint has its own FHIR version,
definitions, data and users' roles, and keeps its state in SQLite or MySQL. Processes cache
very little: any process can serve any request, so the module runs under the cluster like the
tx module.

The design is in the design document (*FHIRsmith REST module: design*); this file is how to
run it.

## What it does

- JSON only (XML gets 415 or 406)
- read, vread, create, update, patch (JSON Patch), delete, history, search, capabilities,
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
- `$meta`, `$meta-add`, `$meta-delete`, and `Patient/[id]/$everything`
- AuditEvents for writes (and, if set, reads and failures), stored on the endpoint
- a subscription queue (`SubscriptionQueue`), filled by every write; nothing delivers it yet
- users and roles from the server's logins (library/auth)

What search supports, parameter by parameter, is in [search.md](search.md).

Not yet: XML, subscription delivery, validation on write, SMART on FHIR, asynchronous
operations, `$lastn`, FHIRPath Patch, admin pages (other than value sets for searching).

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
| `txServer` | | The terminology server for `:in`, `:not-in` and the closure: a path on this server (the tx module's endpoint, in process) or a URL. |
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

| `Types.Settings` | Default | |
|---|---|---|
| `versionAware` | false | Updates and patches need `If-Match`. |
| `interactions` | all | The interactions allowed: `read`, `vread`, `update`, `patch`, `delete`, `history-instance`, `history-type`, `create`, `search-type`. |
| `conditionalCreate`, `conditionalUpdate`, `conditionalDelete` | true | |

`Types.Supported` 0 takes a type off the endpoint.

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

For the manage role there is one administration page, linked from the endpoint's page and the
user's account page: `[base]/_admin/valuesets`, the value sets registered for searching. A
value set too big to expand, or not closed, can't be searched with `:in` (the search says so,
and points here); registered, with a version chosen from those the terminology server has, it is
searched by membership instead, worked out in the background (search.md says how).

## Access

Users, logins and API tokens are the server's ([library/auth](../library/auth/README.md)). The
module's roles, given per endpoint (or for all) on the users page:

| Role | Allows |
|---|---|
| read | read, vread, search, history, capabilities, `$meta`, `$everything` |
| write | create, update, patch, delete, batch, transaction, `$meta-add`, `$meta-delete` (and read) |
| manage | (and read and write) the endpoint's settings, when there are pages for them |

Administrators have them all. Software sends an API token (`Authorization: Bearer fhs_...`).

## Clustering

Under the cluster (cluster.md), the master migrates the schema and runs the jobs: deleting
expired searches, the closure, and reindexing when definitions change. Workers serve the
endpoints when `server.cluster.workerModules` includes `"rest"`: everything is in the
database, so any process can serve any request, including the next page of a search another
ran. With SQLite every process must be on one machine, and writes take turns through one lock;
MySQL scales writes, and its workers can be on several machines.

## Tests

`npm test -- tests/rest` runs the module's tests on SQLite, and on MySQL when
`FHIRSMITH_TEST_MYSQL` says where (`host:port/database:user`, with the password in
`FHIRSMITH_TEST_MYSQL_PASSWORD`); without it the MySQL half is skipped, with a notice. The
database is emptied first: use one for testing only.
