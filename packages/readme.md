# Package Server

A registry of FHIR NPM packages. It crawls the package feeds listed in the FHIR IG
registry, stores every package version it finds, and serves them using the npm
registry protocol, with FHIR-specific search on top (by canonical URL, FHIR version
and dependency). It is the server behind packages2.fhir.org.

Its main clients are the HL7 Java tools (`org.hl7.fhir.utilities.npm.PackageClient`,
used by the IG Publisher and validator). Package documents, tarball URLs and search
results follow npm's formats, so npm clients can point `--registry` at
`<server>/packages`.

## API

The public API is described by an OpenAPI 3.1 spec:

| URL | |
|---|---|
| `/packages/openapi` | Browsable reference (HTML), with a "try it" form for each GET operation |
| `/packages/openapi.json` | The spec as JSON |
| `/packages/openapi.yaml` | The spec as YAML (the source file, [openapi.yaml](openapi.yaml)) |

Every response from the package server carries a
`Link: </packages/openapi.json>; rel="service-desc"` header (RFC 8631), and the
HTML pages carry the matching `<link>` element.

In summary:

| Endpoint | Purpose |
|---|---|
| `GET /packages/catalog` | Search packages: `name`, `canonical`, `pkgcanonical`, `fhirversion`, `dependency`, `dependson`, `sort` |
| `GET /packages/-/v1/search` | npm search API: `text`, `size`, `from`, plus the `/catalog` parameters |
| `GET /packages/{id}` | npm package document: all versions, dependencies, tarball URLs |
| `GET /packages/{id}/{version}` | Download a package tarball; or, when the request's `Accept` asks for JSON, npm's document for that version. A `FHIR-Package-Download` header always gets the tarball (the HL7 Java tools send it) |
| `GET /packages/updates` | Versions published since a date |
| `GET /packages/broken` | Package versions whose dependencies this registry doesn't hold |
| `GET /packages/npm-check` | Check any registry against the npm registry protocol (a form, in a browser) |

Most endpoints return an HTML page instead of JSON when the request's `Accept`
header contains `text/html`. The JSON is the contract; the HTML is for people.

Query parameters are validated strictly. An unknown parameter, a repeated parameter,
or a value that's too long or badly formed is a 400, not silently ignored.

Not in the spec, deliberately:

* Operational pages: `/packages/stats`, `/packages/log` (the last crawler run),
  `/packages/status`.
* `POST /packages/crawl`, which runs a full crawl on demand. It requires the
  `x-crawl-token` header to match the `crawlToken` setting, and is disabled when no
  token is configured.

### Keeping the spec honest

[openapi.yaml](openapi.yaml) is maintained by hand. `tests/packages/openapi.test.js`
fails if:

* a route is added to the router without being described in the spec, or listed in
  the test's `EXCLUDED` table with a reason;
* the spec describes a route the router doesn't have;
* a query or path parameter's name, length limit, pattern or default differs from the
  validation rules in `packages.js` (`SEARCH_PARAMS`, `V1_SEARCH_PARAMS`,
  `UPDATES_PARAMS`, `BROKEN_PARAMS`, `PATH_PARAMS`).

So when you change a route or a parameter rule, change `openapi.yaml` with it.
`tests/packages/search.test.js` covers the search behaviour itself against an
in-memory database.

## Configuration

In the server config, under `modules.packages`:

```json
"packages": {
  "enabled": true,
  "database": "packages.db",
  "mirrorPath": "/absolute/path/to/mirror",
  "crawlToken": "a-long-random-secret",
  "crawler": {
    "enabled": true,
    "schedule": "0 * * * *"
  }
}
```

| Setting | |
|---|---|
| `database` | The SQLite database. A relative path is resolved against the data directory's `packages` folder. Created on first run. |
| `mirrorPath` | Directory where the crawler saves a copy of each tarball, as `{id}-{version}.tgz`. A scoped id `@scope/name` is saved as `$scope$name`. |
| `bucketPath` | Optional. If set, downloads redirect to `{bucketPath}/{file}` and tarball URLs point there, instead of being served from the database. The file names are the mirror's, so the bucket is expected to be a copy of the mirror. |
| `baseUrl` | Optional. The public base URL used when building package URLs. Defaults to the request's host. |
| `crawlToken` | Shared secret for `POST /packages/crawl`. Omit it to disable that endpoint; the scheduled crawler is unaffected. |
| `crawler.enabled` | Run the crawler at startup and on the schedule. |
| `crawler.schedule` | Cron expression for crawls. |
| `masterUrl` | The list of feeds to crawl. Defaults to `https://fhir.github.io/ig-registry/package-feeds.json`. |
| `localFeedDirs` | Optional. Directories feeds may be read from as local files (for testing). |
| `allowPrivateAddresses` | Optional, for testing only. Lets the crawler and `/npm-check` fetch from private and loopback addresses, which they otherwise refuse (SSRF protection). |
| `npmCheck.enabled` | `/packages/npm-check`. On unless set to `false`. |
| `npmCheck.maxConcurrentRuns` | Runs at once, across all users; more get a 503. Default 2. |
| `npmCheck.runsPerWindow` | Runs per client address per 10 minutes; more get a 429. Default 10. |
| `npmCheck.requestTimeout` | Milliseconds allowed for each request a run makes. Default 30000. |
| `npmCheck.maxDownloadMB` | Largest response a run will read (so, the tarball). Default 50. |
| `npmCheck.control` | The registry, package and version the checks are verified against daily; default `registry.npmjs.org`, `fhirpath` 3.15.0. `false` turns that off. |

## Checking npm compatibility

This server aims to be an npm registry, carrying FHIR fields as well. `npm-check.js`
holds checks of the npm registry protocol, written from the way npm clients use it:
search by name, the package document, one version's document, and the tarball. They
are used three ways:

* `/packages/npm-check` runs them against any registry and shows a report. Its requests
  go through the crawler's SSRF guard, with a timeout and a size cap, and runs are rate
  limited. Unlike the crawler, it may use loopback addresses (`localhost`, `127.0.0.1`,
  `::1`), so it can check this server itself; other non-public addresses are refused.
* `tests/packages/npm-registry.test.js` runs them against registry.npmjs.org, which must
  pass every check: if npm changes its behaviour, that test is how we find out. Set
  `NPM_REGISTRY_TARGETS` to run them against other registries too.
* `tests/packages/npm-registry-local.test.js` runs them against this module, started
  locally with known packages.

`/packages/npm-check` also runs them against registry.npmjs.org once a day, and says on
the page if any fail there.

## Crawling

Each crawl reads the master feed list, then each RSS feed in it (Simplifier last).
For each item, it downloads the package, checks the id, version and canonical, and
stores it.

* The master list's `package-restrictions` say which feeds may publish which package
  ids. A package from a feed that isn't allowed to publish it is skipped.
* Items marked `notForPublication` are skipped.
* Feeds can be paginated (RFC 5005 `rel="next"`). The first page is read on every
  crawl; older pages are read once and remembered in the `FeedPages` table.
* A feed that rate-limits (HTTP 429) is abandoned for that crawl and retried next
  time.
* Each id#version is stored once. Simplifier re-publishes packages that other feeds
  publish directly, so its copy is a secondary echo: a version we already hold is
  never fetched from Simplifier, and a version we only hold from Simplifier is
  replaced when it arrives directly. A second direct copy of a version we already
  hold, from a different GUID, is logged as an error and ignored. This is checked
  against the feed's title before downloading, and against the tarball's own
  package.json before storing. The database enforces it with a unique index on
  `(Id, Version)`.
* The mirror copy of a tarball is written only after the package has passed
  validation and been stored.

`/packages/log` shows what the last crawl did, feed by feed and item by item.

## Storage

Everything is in the SQLite database. `PackageVersions` holds each version's
metadata and the tarball itself. `Packages` holds one row per package id, with its
current version and download count. `PackageDependencies` (stored as `id@version`),
`PackageFHIRVersions` and `PackageURLs` (the canonical URLs of the resources in each
version) support search.

### Repairing an older database

Databases built before each id#version was stored once can hold duplicate rows, and
mirror files that don't match the stored hash. `dedupe-versions.js` repairs both:

```
node packages/dedupe-versions.js -db <packages.db> -mirror <mirror folder>          # report only
node packages/dedupe-versions.js -db <packages.db> -mirror <mirror folder> -apply
```

It keeps one row per id#version by the crawler's rule (direct beats Simplifier,
otherwise the first stored), lists any id#version with two different direct copies
for manual cleanup, creates the unique index once no duplicates remain, and rewrites
any mirror file whose content doesn't match its row's hash, from the database. Back up
the database first. Until the index exists, the server logs a warning at startup.
