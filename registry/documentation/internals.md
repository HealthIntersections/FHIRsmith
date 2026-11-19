# Registry internals

How the module works, for anyone changing it. The user-facing behaviour is in
[api.md](api.md) and [security.md](security.md).

## Code

| File | |
|---|---|
| `registry.js` | `RegistryModule`: initialisation, routes, the HTML pages, scan scheduling, saving and loading state |
| `api.js` | `RegistryAPI`: discovery and resolution over the scanned data, and the JSON-to-HTML rendering of their results |
| `crawler.js` | `RegistryCrawler`: scanning the ecosystem |
| `model.js` | The data model (`ServerRegistries` → `ServerRegistry` → `ServerInformation` → `ServerVersionInformation`), its JSON form, and `ServerRegistryUtilities` - mask matching and version matching |
| `uptime.js` | `UptimeHistory`: per-endpoint scan outcomes, and the uptime calculation |
| `fhirsmith-releases.js` | FHIRsmith's release list (GitHub, falling back to `CHANGELOG.md`), for dating servers on the software page |
| `auth.js`, `auth-store.js` | `RegistryAuth` (API guard over the server's users and tokens, OIDC verification, the usage page) and `AuthStore` (usage and documents in SQLite) |
| `documents.js` | `RegistryDocuments`: the document pages, raw serving, editing and history ([documents.md](documents.md)) |
| `openapi.yaml`, `openapi.js` | The API description, and the module that serves it |
| `registry-template.html` | The page template (`[%title%]`, `[%content%]`, `[%registry-links%]` for the documents and usage links, `[%account%]` for the user's name or Login, and the footer placeholders html-server fills) |

`test-runner.js` is a leftover and does not run.

`server.js` creates the module when `modules.registry.enabled` is set, calls
`initialize(config)` and mounts `router` at `/tx-reg`. Nothing else in FHIRsmith depends on it.

## Scanning

`RegistryCrawler.crawl()` runs every `crawlInterval` minutes (first 5 seconds after start),
and never concurrently with itself. A scan builds a fresh `ServerRegistries` from scratch:

1. fetch the master registration file (`formatVersion` must be `"1"`); its optional
   `registration` and `ecosystem-documentation` URLs are the "Register your own server" and
   "Documentation" links on the home page (each is omitted if the file doesn't give it), since
   they depend on the ecosystem;
2. for each registry it lists (except one marked `"disabled": true`, which is skipped with an
   info log entry), fetch the registry file and build a `ServerRegistry`;
3. for each server (again, except a disabled one), a `ServerInformation` with its claims
   (`authoritative`, `authoritative-valuesets`, `languages`, `usage`, `exclusions`), and for each of its
   `fhirVersions` a `ServerVersionInformation` - the *endpoint*;
4. for each endpoint, by the major FHIR version in its registration: `/metadata` (software name,
   version and release date), `/metadata?mode=terminology` (code systems and versions, sorted
   and de-duplicated), `/ValueSet?_elements=url,version` (value set URLs, following `next`
   links). R3 is handled separately from R4/R5 because it has no TerminologyCapabilities
   resource: its `?mode=terminology` answer is a Parameters-shaped structure.

If the whole scan fails (the master file can't be read) the previous data is kept and the
outcome recorded. If an endpoint fails, the error is recorded on it, `lastSuccess` is left
from the previous scan, and the software fields are carried forward from the previous data
(`carryForwardSoftware`), so the software page does not lose track of a server that is down.
The endpoint's code systems and value sets are *not* carried forward: a down server resolves
nothing until it is back - but see `ServerVersionInformation.update()`, which is how a
loaded-from-disk record is merged if that path is ever used.

Every fetch goes through `fetchJson`, which adds a cache-busting `_ts`, sends the configured
`User-Agent` and the server's `Api-Key` if there is one, limits the decompressed response to
`maxResponseMB`, and resolves host names through `ssrfLookup`: an address that is not a public
unicast address (loopback, private, link-local including the cloud metadata address, CGNAT,
multicast ...) is refused, before and after DNS, so a hostile registration file cannot make the
registry probe its own network. `allowPrivateAddresses` turns that off for local testing.

Each endpoint probe also records its outcome in `UptimeHistory` with the scan's start time, and
after a successful scan the history is trimmed to the endpoints that still exist.

## State

Two JSON files in the data folder's `registry` directory, written after every scan and read
at startup:

* `registry-data.json` - `ServerRegistries.toJSON()`: the ecosystem as last scanned, with
  `"version": "1"`. Loading it is what lets a restarted registry answer at once.
* `registry-uptime.json` - `UptimeHistory.toJSON()`: `{ version: "1", endpoints: { url:
  [[timeMs, 1|0], ...] } }`, kept to `uptimeRetentionDays`.

Usage and documents live in `databases/registry-auth.db` (better-sqlite3, WAL; the `users`
and `tokens` tables of a database from before the server's login system are left as they
are, unused). Users, roles and API tokens are the server's (`library/auth`). Request
counts are accumulated in memory and flushed once a minute and at shutdown, so a busy registry
is not writing SQLite on every API call.

A scan builds a new tree and swaps it in whole (`RegistryModule.updateData()` is where a
lock would go if one were ever needed; in Node's single thread the swap is atomic), so a
request sees either the old ecosystem or the new, never a mixture.

## Resolution

`RegistryAPI.resolveCodeSystem()` and `resolveValueSet()` walk every endpoint of every server
in every registry and keep those that (a) match the FHIR version
(`ServerRegistryUtilities.versionMatches`, which accepts release codes and numbers), (b) are
not excluded for the URL, (c) pass the `usage` test, and (d) actually host the URL
(`hasMatchingCodeSystem`, with the SNOMED CT edition rule, or a value set lookup). Those whose
server matches an authority claim (`ServerInformation.matchAuthCS`, which scores language
specific claims so the most specific tag sorts first) go in `authoritative`; the rest in
`candidates`, unless `authoritativeOnly`. Masks are matched by `ServerRegistryUtilities`, with
`*` as the wildcard; actual content is matched without wildcards.

`discover()` is the same walk without the hosting test (or with it, when `url` is given),
producing one row per endpoint.

## The pages

All pages go through `RegistryModule.renderPage()`, which applies the template via
`library/html-server` and fills `[%registry-links%]` with the documents link (and usage, for an
administrator) from `RegistryAuth.navLinks()`; html-server fills `[%account%]`, as on every page. Content that came from registration files or scanned servers -
names, URLs, errors, software names - is other people's input, and is escaped on output; URLs
are only linked when they are http(s) (`safeHref`). `tests/registry/registry-hostile-content.test.js`
feeds script-laden registration data through every page to keep it that way.

### The software page

`buildSoftwareContent()` groups each server's endpoints by software name and version
(`softwareRows`), so a server's R3/R4/R5 endpoints are one row under their common base URL
(`commonBaseUrl`: the shared prefix of the endpoint URLs, backed up to a path boundary) unless
they run different software. For FHIRsmith servers, `FhirsmithReleases.describe()` dates the
version against the release list and says how many releases behind it is; other software is
dated by the `software.releaseDate` it reports, as the UTC day (servers running the same
release report it in different time zones). Uptime per row is `UptimeHistory.uptime()` over
all the row's endpoints: the share of probes in the window that succeeded.

### Login and administration

Logins, users and tokens are the server's (`library/auth`): `/tx-reg/login`, `/tx-reg/account`
and `/tx-reg/admin/users` redirect to its pages. The session, CSRF (`lusca`) and the same-origin
check (`library/same-origin`) are the server's middleware, written out on every route rather
than composed, so that static analysis can see the CSRF middleware on each cookie-using route.
The session comes before the API guard (`apiGuard()`), a separate middleware on `/`,
`/resolve` and `/choose-server`, applied only when the request does not accept HTML: a member
logged in with a browser can call the API too.

## Security notes for maintainers

* The registry fetches URLs it does not control. Keep every outbound request on `fetchJson`
  (SSRF guard, size limit, timeout). The OIDC fetches (`fetch` for discovery, `jose` for keys)
  go only to administrator-configured https URLs.
* Everything rendered from scanned data or the database is escaped; `safeHref` for links.
* API tokens and passwords are `library/auth`'s: tokens by SHA-256 lookup, passwords with
  bcrypt (see its README).

## Tests

`tests/registry`, run with `npx jest tests/registry`:

| File | |
|---|---|
| `registry.test.js`, `registry-resolve.test.js` | Discovery and resolution against `test-data.json` |
| `registry-language.test.js`, `registry-exclusions.test.js` | Language specific claims; exclusions |
| `registry-disabled.test.js` | Disabled registries and servers are not read or scanned |
| `registry-software.test.js` | Release dating, the collapsed software rows, uptime history |
| `registry-auth.test.js` | Members and their tokens, the old settings keeping the API closed, the failed-auth limit, and OIDC end to end (supertest), including an OIDC provider stood up in the test with a generated key pair |
| `registry-documents.test.js` | Documents: visibility (members), editing, history, validation |
| `registry-hostile-content.test.js` | Script injection through registration data, on every page |
| `registry-footer.test.js` | The "last updated" footer |
| `openapi.test.js` | The OpenAPI description agrees with the router and the parameter lists |

`test-data.json` is a saved `registry-data.json` for a small fictional ecosystem; tests load it
into a crawler with `loadData()` rather than scanning anything.
