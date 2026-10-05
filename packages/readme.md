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
| `GET /packages/{id}/{version}` | Download a package tarball |
| `GET /packages/updates` | Versions published since a date |
| `GET /packages/broken` | Package versions whose dependencies this registry doesn't hold |

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
| `allowPrivateAddresses` | Optional, for testing only. Lets the crawler fetch from private and loopback addresses, which it otherwise refuses (SSRF protection). |

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

`/packages/log` shows what the last crawl did, feed by feed and item by item.

## Storage

Everything is in the SQLite database. `PackageVersions` holds each version's
metadata and the tarball itself. `Packages` holds one row per package id, with its
current version and download count. `PackageDependencies` (stored as `id@version`),
`PackageFHIRVersions` and `PackageURLs` (the canonical URLs of the resources in each
version) support search.
