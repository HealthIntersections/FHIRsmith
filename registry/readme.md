# Terminology Server Registry

The coordination server of a terminology server ecosystem, as described by the
[terminology ecosystem IG](https://build.fhir.org/ig/HL7/fhir-tx-ecosystem-ig/ecosystem.html).
It regularly scans the servers listed in the ecosystem's master registration file, and tells
clients which terminology server to use for a code system or value set. It runs at
http://tx.fhir.org/tx-reg for the HL7 ecosystem.

Its main client is the HL7 Java tooling (`TerminologyClientManager` in org.hl7.fhir.r5),
which calls `/resolve` to route each terminology operation to the right server.

## API

The public API is described by an OpenAPI 3.1 spec:

| URL | |
|---|---|
| `/tx-reg/openapi` | Browsable reference (HTML), with a "try it" form for each GET operation |
| `/tx-reg/openapi.json` | The spec as JSON |
| `/tx-reg/openapi.yaml` | The spec as YAML (the source file, [openapi.yaml](openapi.yaml)) |

Every response carries a `Link: </tx-reg/openapi.json>; rel="service-desc"` header
(RFC 8631), and the HTML pages carry the matching `<link>` element.

| Endpoint | Purpose |
|---|---|
| `GET /tx-reg/` | **Discovery**: the server endpoints in the ecosystem. Filters: `registry`, `server`, `fhirVersion`, `url`, `authoritativeOnly`, `language` |
| `GET /tx-reg/resolve` | **Resolution**: which endpoints to use for a code system (`url`) or value set (`valueSet`) at a `fhirVersion`. Also `authoritativeOnly`, `language`, `usage`, `version` |

Both return an HTML page instead of JSON when the request's `Accept` header contains
`text/html`. `/tx-reg/resolve` without parameters is a form for trying it out.
`/tx-reg/log` (the crawler log) is operational, and not in the spec.

Parameters are read leniently: unknown parameters are ignored, and a repeated parameter
takes its first value.

### How resolution decides

* An endpoint is only returned for content it actually hosts, as reported by its
  TerminologyCapabilities (code systems) and ValueSet search (value sets).
* A SNOMED CT edition (`http://snomed.info/sct|http://snomed.info/sct/{edition}`) is hosted
  by any endpoint that hosts a version of that edition. Otherwise SNOMED CT versions match
  exactly; for other code systems, a server that hosts the code system hosts all its
  versions.
* Endpoints whose server claims authority (the `authoritative` masks in its registration)
  are listed as `authoritative`; the others as `candidates`.
* With `language`, servers with a matching language specific claim (`languages` in the
  registration) come first, most specific tag first; candidates are marked
  `language-support: unknown`.
* A server with a `usage` list is only returned when the request's `usage` is in it.
* A server's `exclusions` hide the matching content from it entirely.
* FHIR versions can be given as release codes (`R4`, `R4B`, `R5`, `R6` ...) or numbers
  (`4.0.1`, `4.0`).

### Differences from the ecosystem IG

* Discovery: without `url`, a row's `authoritative`/`authoritative-valuesets` are the
  server's claim masks, and there are no candidate lists. With `url`, `candidate` is
  `[url]` when the endpoint hosts it without claiming authority.
* Entries carry the IG's security flags (`open`, `token`...) and also a `security` string
  (`open` or `api-key`). Note that this records how the *registry* reaches the server: an
  endpoint is `api-key` when the registry is configured with a key for it (`apiKeys`), and
  `open` otherwise.
* Resolve takes a `version` parameter, as an alternative to `url|version`.
* Resolve omits `authoritative` and `candidates` when they are empty.

### Keeping the spec honest

[openapi.yaml](openapi.yaml) is maintained by hand. `tests/registry/openapi.test.js` fails
if a route is added without being described (or listed in the test's `EXCLUDED` table), if
the spec describes a route the router doesn't have, or if the documented query parameters
differ from `DISCOVERY_PARAMS` and `RESOLVE_PARAMS` in `registry.js`. So when you change a
route or a parameter, change `openapi.yaml` with it.

## Configuration

In the server config, under `modules.registry`:

```json
"registry": {
  "enabled": true,
  "masterUrl": "https://fhir.github.io/ig-registry/tx-servers.json",
  "crawlInterval": 30,
  "timeout": 30000,
  "userAgent": "YourServer/1.0",
  "apiKeys": {}
}
```

| Setting | |
|---|---|
| `masterUrl` | The ecosystem's master registration file. Defaults to the HL7 one. |
| `crawlInterval` | Minutes between scans. 0 or absent: no scanning. |
| `timeout` | Per-request timeout for scanning, in milliseconds. |
| `userAgent` | The User-Agent the scanner sends. |
| `apiKeys` | API keys for servers that need one, by server code. |

## Scanning

Each scan reads the master registration file, each registry it lists, and then, for each
server endpoint:

* `/metadata` (the CapabilityStatement, for the software name and version)
* `/metadata?mode=terminology` (the TerminologyCapabilities, for the code systems and
  versions it hosts)
* `/ValueSet?_elements=url,version` (the value sets it hosts)

An endpoint that fails keeps the content found by its last successful scan, and reports the
error. The scanner refuses to fetch from private or loopback addresses (SSRF protection).

The results are saved to `[data]/registry/registry-data.json` after each scan, and loaded at
startup, so the registry can answer immediately after a restart.

## Code

| File | |
|---|---|
| `registry.js` | The module: routes, HTML pages, scan scheduling |
| `api.js` | Discovery and resolution |
| `crawler.js` | Scanning |
| `model.js` | The data model, and mask and version matching |
| `openapi.yaml`, `openapi.js` | The API description |

Tests are in `tests/registry`.
