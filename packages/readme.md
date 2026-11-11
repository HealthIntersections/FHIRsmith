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
| `GET /packages/{id}/{version}` | Download a package tarball; or, when the request's `Accept` prefers JSON (ranks it above `*/*`), npm's document for that version. A `FHIR-Package-Download` header always gets the tarball (the HL7 Java tools send it) |
| `GET /packages/updates` | Versions published since a date |
| `GET /packages/broken` | Package versions whose dependencies this registry doesn't hold |
| `GET /packages/-/npm/v1/keys` | The key this registry signs package versions with (see [Signatures](#signatures)) |
| `GET /packages/-/fhir/v1/signatures/{name}@{version}` | The publisher's signature of a version, as the crawler fetched it (see [Publishers' signatures](#publishers-signatures)) |
| `GET /packages/npm-check` | Check any registry against the npm registry protocol (a form, in a browser) |
| `GET /packages/feed-check` | Check a package feed the way the crawler reads it, storing nothing (a form, in a browser); the report is at `/packages/feed-check/{run}` |

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
| `crawler.signatures` | Publishers' package signatures: `ignore`, `check` (the default) or `require`. See [Publishers' signatures](#publishers-signatures). |
| `masterUrl` | The list of feeds to crawl. Defaults to `https://fhir.github.io/ig-registry/package-feeds.json`. |
| `localFeedDirs` | Optional. Directories feeds may be read from as local files (for testing). |
| `allowPrivateAddresses` | Optional, for testing only. Lets the crawler and `/npm-check` fetch from private and loopback addresses, which they otherwise refuse (SSRF protection). |
| `npmSigning.enabled` | Sign package versions (see [Signatures](#signatures)). On unless set to `false`. |
| `npmSigning.keyFile` | The signing key, an EC P-256 private key in PEM. A relative path is resolved against the database's folder. Default `npm-signing-key.pem`; made (readable only by the server's user) if it isn't there. |
| `feedCheck.enabled` | `/packages/feed-check`. On unless set to `false`. |
| `feedCheck.maxItems` | Items checked per run; the rest of the feed isn't read. Default 50. |
| `feedCheck.maxTotalMB` | Downloaded per run; items after that are listed but their packages aren't fetched. Default 500. |
| `feedCheck.keepMinutes` | How long a run's report is kept. Default 60. |
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

## Signatures

The server signs every package version it holds, the way the npm registry does, so
`npm audit signatures` can check packages installed from it. A signature says that this
registry served this tarball: it is the registry's statement, not the publisher's, so
it's made for every version, wherever it was crawled from. Each version in a package
document has `dist.integrity` (the sha512 of the tarball) and `dist.signatures`, the
ECDSA P-256 signature of `{id}@{version}:{integrity}`; `/packages/-/npm/v1/keys` lists
the public key.

* The key is in `npmSigning.keyFile`, next to the database unless set otherwise. If
  there's no key there, one is made at startup. It is no better protected than the
  database and the configuration: anyone who can change those can change what is
  served anyway.
* A version is signed when it's stored. Versions stored before this (or signed with a
  different key) are signed in the background at startup, a row at a time. Until every
  version is signed, `/-/npm/v1/keys` is a 404, as if the server didn't sign: npm reports
  an unsigned version from a registry with keys as an error. `/packages/status` shows the
  progress (`npmSigning`). If some are left, it tries again after the next crawl.
* To change the key, replace the file and restart: everything is signed again with the
  new key, and the keys endpoint is a 404 until that's done.
* With `npmSigning.enabled` false, versions still get `dist.integrity`, but there are no
  signatures and no keys.

The signatures and integrity are in the `PackageDist` table, not in `PackageVersions`:
reading a column stored after the tarball means reading the tarball.

## Checking a feed

`/packages/feed-check` takes a feed's URL and reads it the way the crawler does, without storing
anything: no packages, signatures or visited pages go into the database, and nothing is written
to the mirror. For each item it reports the package (downloaded, unpacked with the crawler's
limits and checked as the crawler checks it before storing: id, semver version, canonical, no
install scripts, no JavaScript unless it's a template, not notForPublication), whether the
registry's `package-restrictions` allow it from this feed, its signature (`confirmed`,
`rejected`, `absent`, or `not checked` when the feed isn't in `package-feeds.json` or lists no
keys), and whether this registry already holds the version, and if so whether it is the same
bytes. A feed-level problem (it can't be fetched, isn't RSS, or the server rate limits) is
reported instead. Next pages are followed up to `feedCheck.maxItems` items.

The signing keys can be given with the check, as JSON: the feed's `signing` block as it would be
in `package-feeds.json` (or the feed's whole entry). Signatures are then checked against those
keys instead of the registry's, so a publisher can test a feed and its keys before they are
registered.

A check runs in the background: the form redirects to `/packages/feed-check/{run}`, which reloads
every few seconds until the check is done. Every request goes through the crawler's SSRF guard,
and only http(s) URLs are fetched, so a feed can't make the server read local files. Only one
check runs at a time, across all users; a request while one is running gets a 503.

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

### Publishers' signatures

A publisher can sign its packages: the IG Publisher does, when its `fhir-settings.json` has a
`packageSigningKey` (see `org.hl7.fhir.utilities.npm.NpmPackageSigner` in core). Each signed
package has a partner file, `{package}.tgz.sigstore.json`, and the feed item links it in a
`fhir:signature` element. The file is a Sigstore bundle: an ECDSA P-256 signature of a statement
naming the package (`pkg:npm/{id}@{version}`) and the sha512 of the `.tgz`.

Which keys may sign a feed's packages is in the master list, `package-feeds.json`, on the feed:

```json
"signing": {
  "required": false,
  "keys": [{ "keyid": "SHA256:...", "key": "{base64 public key}", "expires": null }]
}
```

`crawler.signatures` says what the crawler does with them, for feeds that list keys:

* `ignore`: nothing.
* `check` (the default): each package's signature is fetched and checked. One that fails, or
  can't be fetched, is logged (in the server log and `/packages/log`), and the package is stored
  anyway, unless the feed has `"required": true`, when it is refused.
* `require`: as `check`, but an unsigned package, or one whose signature fails, is refused,
  and feeds that list no keys (Simplifier, for one) aren't read at all - the crawl log says so.

With `ignore` or `check`, feeds that list no keys are read as before, and their packages aren't
checked. A key that had expired when a
package was published doesn't count. A package that was stored before it was signed (or before
the server checked) has its signature checked against the bytes it holds, once, the next time
the crawler sees it in a feed; it is never refused, since it is already held, but a failure is
logged and recorded.

The signature file is kept in the `PackageSignatures` table as it was when it was checked, valid
or not, with the outcome, the key that signed it and when it was checked. The HTML lists of
packages (search, a package's versions, updates) show each version's signature as `confirmed`,
`rejected` or `absent` (unsigned, or not checked); hover for the key, or the reason.

In the package document, each version with a signature has `dist.fhir-signature`: `url` (the
signature file, served at `/packages/-/fhir/v1/signatures/{name}@{version}` exactly as it was
fetched), `status` (`confirmed` or `rejected`) and, when confirmed, the `keyid`. A client can
check the signature itself, against the keys in `package-feeds.json`.

It is deliberately not `dist.attestations`. npm (`npm audit signatures`) verifies attestations
as Sigstore attestations: it wants the signing key listed among the registry's own keys
(`/-/npm/v1/keys`), and a transparency log (Rekor) entry in the bundle. Publishers' bundles have
no log entry, and listing a publisher's key with the registry's would let that publisher forge
the registry's signatures, since npm accepts a registry signature from any listed key. So every
signed package would fail `npm audit signatures`.

## Storage

Everything is in the SQLite database. `PackageVersions` holds each version's
metadata and the tarball itself. `PackageDist` holds each version's `dist.integrity`
and npm signature. `PackageSignatures` holds the publisher's signature of each version, as
the crawler checked it. `Packages` holds one row per package id, with its
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
