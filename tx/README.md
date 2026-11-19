# ![🔥](../static/FHIRsmith64.png) TX Module - FHIR Terminology Server

The TX module provides FHIR terminology services for CodeSystem, ValueSet, and ConceptMap resources. It supports multiple endpoints at different FHIR versions, all backed by a shared terminology library. It is the reference terminology server for the FHIR community and the FHIR terminology ecosystem.

## Todo

* Improve batch support 

## Overview

Unlike other modules in this server that mount at a single path (e.g., `/shl`, `/packages`), the TX module registers multiple endpoints directly at the root level. Each endpoint is configured with its own path, FHIR version, and optional context string.

When a request arrives at an endpoint, the module:
1. Creates a Provider instance from the shared Library using the configured FHIR version and context
2. Passes the Provider to the appropriate worker to handle the operation
3. Returns the FHIR-compliant response

## Configuration

Add the `tx` section to your `config.json`:

```json
{
  "modules": {
    "tx": {
      "enabled": true,
      "librarySource": "/path/to/library.yml",
      "publishLibrarySource": false,
      "cacheTimeout": 30,
      "internalLimit" : 100000,
      "externalLimit" : 10000,
      "expansionCacheSize": 1000,
      "expansionCacheMemoryThreshold": 0,
      "endpoints": [
        {
          "path": "/tx/r5",
          "fhirVersion": "5.0",
          "context": null
        },
        {
          "path": "/tx/r4",
          "fhirVersion": "4.0",
          "context": null
        },
        {
          "path": "/tx/r3",
          "fhirVersion": "3.0",
          "context": null
        },
        {
          "path": "/tx/r4/demo",
          "fhirVersion": "4.0",
          "context": "demo"
        }
      ]
    }
  }
}
```

### Configuration Options

| Option                          | Type    | Required | Description                                                                                             |
|---------------------------------|---------|----------|---------------------------------------------------------------------------------------------------------|
| `enabled`                       | boolean | Yes      | Whether the module is enabled                                                                           |
| `cacheTimeout`                  | integer | No       | How many minutes to keep client side caches (for cache-id parameter). Default: 30                       |
| `cacheMaxConcepts`              | integer | No       | Concepts one client side cache (cache-id) may hold. Default: 250000, about 10x the largest IG Publisher session measured on build.fhir.org (24,048). A request that would take a cache over it is not performed: the server drops the cache and answers 404, an OperationOutcome with one issue coded `tx-issue-type#cache-id-unknown` (message id `CACHE_ID_DISCARDED_TOO_BIG`, saying the cache grew too large), as for any cache that is gone. The client starts a new cache and sends the request again; later requests with the old id get the same 404 `cache-id-unknown`, saying why it was dropped (`CACHE_ID_DISCARDED`). A request whose own resources hold more than this, so that no cache could take them, is refused instead (422 too-costly) and the cache is kept, as is a new cache too big to start. 0 = no limit |
| `cacheMaxTotalConcepts`         | integer | No       | Concepts all the client side caches of an endpoint may hold between them (about 250 bytes of heap each). Default: 1000000, 4 full caches, about 40x the largest session measured (24,048). The least recently used caches are dropped to stay under it; a request with a dropped cache-id gets a 404 `cache-id-unknown`, saying it was dropped to make room. 0 = no limit |
| `usageTrackerMaxCodes`          | integer | No       | Distinct codes the usage tracker (`usage-count` expansion property) keeps, when it is on (it is off for now: nothing uses the counts yet, and `usage-count` is 0). Default: 1000000, 2x the about 500,000 codes the value sets of a full library list. Codes beyond it aren't counted (no error); codes already tracked still are. 0 = no limit |
| `usageTrackerMaxCodeLength`     | integer | No       | Longest code, in characters, the usage tracker keeps. Default: 100, 2.5x the longest code those value sets list (40). Longer codes aren't counted (no error). 0 = no limit |
| `filterMemoMaxConcepts`         | integer | No       | Concepts the filter results remembered on package value sets may hold between them (one result for each filter, for each code system version, and language for a SNOMED CT display regex, it was resolved against: the ECL, or the concepts a full scan found). The least recently used are dropped to stay under it; one bigger than it isn't kept. About 8 bytes a concept. Default: 10000000 (about 80 MB). 0 = no limit. On the value sets a client cache holds, the results count as concepts the cache holds (`cacheMaxConcepts`, `cacheMaxTotalConcepts`), and go with it |
| `languageTagCacheSize`          | integer | No       | Parsed language tags kept (least recently used dropped). Default: 1000; an 8 KB private use tag takes about 46 KB parsed, so at most about 46 MB. Clients see nothing but a re-parse. 0 = no limit (unique tags in requests then grow the heap forever) |
| `expansionCacheSize`            | integer | No       | Maximum number of expanded ValueSets to cache. Default: 1000                                            |
| `expansionCacheMemoryThreshold` | integer | No       | Heap memory usage in MB that triggers evicting oldest half of expansion cache. 0 = disabled. Default: 0 |
| `expansionCacheMaxCodes`        | integer | No       | Most codes the expansion caches of all the endpoints hold between them; the least recently used expansions are dropped to stay under it. Default: a quarter of the heap limit at 1 KB a code (about 1 million codes with a 4 GB heap) |
| (`adminPassword`)               |         |          | No longer used: the server's administrators, logged in ([library/auth](../library/auth/README.md)), empty the caches on the caches page (`/{path}/caches`) |
| `xmlCacheMB`                    | integer | No       | Most XML and JSON, in MB, kept per process for large resources (a CodeSystem's concepts, an expansion's contains), so a resource asked for again isn't serialised again. An array is kept when it took at least 50 ms to serialise, the second time it does; the least recently used are dropped to stay under this, and all of it while the memory guard is refusing requests. The budget counts characters: XML with text outside Latin-1 (Chinese or Arabic displays, say) takes two bytes a character, so in the worst case the cache uses twice this. 0: none. Default: 256 |
| `loincConnections`              | integer | No       | How many connections to the LOINC database the requests share. A connection runs one query at a time, so there are several; a connection is given one query at a time, and the others wait for the first that is free. 0: each request opens a connection of its own and closes it at the end, as it used to (if the shared ones can't be opened, that is what happens too). In a cluster, each process has its own. Default: 4 |
| `librarySource`                 | string  | Yes      | Path to the YAML file that defines the terminology sources to load                                      |
| `publishLibrarySource`          | boolean | No       | Publish that YAML file at `/{path}/library`. Default: false                                             |
| `pruneTerminologyCache`        | boolean | No       | Once the library and every endpoint's core packages have loaded, delete what in `terminology-cache` wasn't used: the `.db` and `.cache` files (the downloaded databases and SNOMED CT caches of sources no longer in the library, and the fallback of an `a\|b` source whose first file is there), with their SQLite side files; and the package folders (`id#version`: packages no longer in the library, older versions of ones that are, the core packages of FHIR versions no endpoint has, and what failed downloads left), with the value set and concept map caches in them. Other files and folders (`vsac`, `ocl`, `syndication`, `folder-source-*`) are left alone, and so is anything changed in the last day (it may be being copied in for a library that doesn't name it yet). In a cluster, only the master deletes. Default: false: everything run from the same data directory (a development server and the tests, say) shares `terminology-cache`, and what one doesn't use another may |
| `internalLimit`                 | integer | No       | Most codes in the expansion of a value set that an `$expand` imports (`compose.include.valueSet`). Default: 100000. Over it, the `$expand` fails with 422 too-costly. Also the most the `x-too-costly-threshold` header can ask for. Other internal expansions (in `$validate-code`, for one) use 10000 and don't read the setting |
| `externalLimit`                 | integer | No       | Most codes an `$expand` returns. Default: 10000 (or `internalLimit`, if that is less). Over it, an expansion asked for without `count` fails with 422 too-costly (`VALUESET_TOO_COSTLY`, "... has too many codes to produce (>10000)"); a `count` bigger than it is cut down to it. A request can change it with the `x-too-costly-threshold` header (see below): the tx-ecosystem tests that depend on a limit set it |
| `walkLimit`                     | integer | No       | How far a paged `$expand` (`count` and `offset`) may walk to reach its page: the most `offset + count`. Default: 10 x `internalLimit` (1000000). Only the page is built - the codes before it are passed keeping just their keys - so a page can lie well past `externalLimit`, which still caps `count`. Over it, the `$expand` fails with 422 too-costly (`VALUESET_TOO_COSTLY_PAGE`, "... can't be paged to offset ... with count ...: the server walks at most 1000000 codes to reach a page"); a value set that ends before the offset is an empty page, not a refusal. The walk is also bounded by `operationTimeLimit`. Any page, the first too, builds only its own codes; the codes after it are counted by key for the total, which is reported only when the whole expansion is within `externalLimit`, as for an unpaged one. Not for a request with a text filter: there, `offset + count` must still be within `externalLimit` |
| `errorsForInvalidCodes`         | boolean | No       | What `$expand` does with a code that an include lists (`compose.include.concept`) that isn't in its code system. `false` (the default): the code is left out of the expansion, and the expansion says so - an `expansion-issue` extension referring to a contained OperationOutcome with a warning (`VALUESET_EXPANSION_INCLUDE_UNKNOWN_CODE`) for each such code. `true`: the value set can't be expanded - 422, `VALUESET_EXPANSION_INCLUDE_UNKNOWN_CODE_ERROR`. The same goes for an include filter that selects by concept (`is-a`, `descendent-of`, `child-of`, `descendent-leaf`, `generalizes`, `=` on `concept` or `code`, and `in` when any code of its list isn't there) on a code that isn't there: the include adds no codes, with a warning (`VALUESET_EXPANSION_FILTER_UNKNOWN_CODE`), or the expansion fails (`..._ERROR`). A code missing from a fragment or example code system is only ever a warning. Applies to value sets an `$expand` imports too; the internal expansions of other operations (`$validate-code`) are not affected |
| `operationTimeLimit`            | integer | No       | Seconds of compute one operation may use (sub-operations share it). Default: 20. Time spent waiting - for the event loop, or in a queue before the operation starts - doesn't count. Over it, the operation fails with 422 too-costly ("Operation exceeded time limit of 20 seconds at ..."). The default sits under common client timeouts (okhttp gives up after 10-30 s): with a limit at or over the client's, the client hangs up first and never sees the OperationOutcome |
| `slowRequestSeconds`            | number  | No       | A request that takes at least this long (seconds) gets a second log line, a warning, saying what it asked: the method and url, the `Accept-Language`, and the body's parameters (a Coding as `system\|version#code 'display'`, a resource as its type, url and size, and a value set its include and exclude filters, an ECL constraint say), up to 4000 characters - enough to repeat it. Default: 30. 0: no such line |
| `ecosystem`                     | object  | No       | Answering for code systems that aren't held here by asking other servers in the terminology ecosystem - see [Ecosystem Resolution](#ecosystem-resolution) below. Default: not used |
| `endpoints`                     | array   | Yes      | List of endpoint configurations (at least one required)                                                 |
| `vsacCfg`                       | object  | No       | Settings for the VSAC value set provider; required if the library loads VSAC (see below)              |

### Ecosystem Resolution

When a code system (or a version of one) isn't held here, the server can ask the terminology
ecosystem registry which server has it, and ask that server (`cs/cs-virtual.js`). Only
`$validate-code` against a value set is supported this way, and slowly: a `$lookup` per code, and a
`$validate-code` per filter.

```json
"ecosystem" : {
  "use": true,
  "excludedServers": [ "tx.fhir.org" ],
  "excludedPatterns": [ "http://hl7.org/*", "http://terminology.hl7.org/*" ],
  "apiKeys": { "hl7-ca" : "xx" },
  "oauth" : {
    "nzhts": {
      "tokenEndpoint" : "https://authenticate.nzhts.digital.health.nz/auth/realms/nzhts/protocol/openid-connect/token",
      "clientId" : "hl7",
      "clientSecret" : "xx"
    }
  }
}
```

| Setting | Type | Description |
|---------|------|-------------|
| `use` | boolean | Turns it on. Default: false |
| `registry` | string | The ecosystem registry. Default: `https://ecosystem.hl7.org/tx-reg` |
| `excludedServers` | array | Servers never used, each a host (`tx.fhir.org`) or an address that the server's address starts with. tx.fhir.org (and tx-dev.fhir.org, which serves the same content) sets this to `["tx.fhir.org"]`: the registry names tx.fhir.org for what `tx.fhir.org.yml` loads, so that's this server, logically, whatever its address is, and asking it again can only give the answer this server already gave |
| `excludedPatterns` | array | Code systems never looked for in the ecosystem, as the registry writes them: `*` matches anything, and a pattern is matched against the url, and the url\|version. These aren't even asked about, so they cost nothing: a server that knows the registry will name itself (or a server in `excludedServers`) for them should list them |
| `apiKeys` | object | Server code (as in the registry) -> API key, sent as `Api-Key`. As for the registry module |
| `oauth` | object | Server code -> `{ tokenEndpoint, clientId, clientSecret, scope }`: an OAuth2 client_credentials grant, the token sent as `Authorization: Bearer`. As for the registry module |
| `timeout` | number | How long, in seconds, a request to the registry or another server may take, all of it (above 0, at most 300). Default: 30. A server registered as `http://` gets at most 10 s of it to answer on `https://` first. A server that doesn't answer its TerminologyCapabilities at all isn't asked anything else (until it's tried again, in five minutes): so a server that's down costs one timeout, once, and the operations that needed it say so (an issue `ECOSYSTEM_SERVER_UNAVAILABLE` next to the code system not being found), rather than only that the code system or version isn't known |
| `allowPrivateAddresses` | boolean | Lets requests go to private, loopback and other non-public addresses. Default: false - the registry, the servers it names, and the OAuth token endpoints must all be at public addresses, because the addresses come from the registry, which may not be the public one (as for the registry module's setting of the same name). For a local registry or test servers |

A server is used if it's open, or if there are credentials for it. The server must also say, in its
TerminologyCapabilities, that it has the code system and version asked for (or, for a version that
is a url, a release of it - a SNOMED CT edition asked for without a release date). With no version
asked for, it's the server's only version, or the one it marks `isDefault`. Requests sent on to
another server carry the header `X-FHIRsmith-Ecosystem-Forwarded`, and a request that arrives with
it is never resolved through the ecosystem again.

What the registry says, and what each server says it has, is kept for an hour, and then refreshed
in the background: a request never waits for a refresh, only the first request for something does
(if a refresh fails, the old answer is used, and the refresh tried again in five minutes). The
other servers' answers to `$lookup` and `$validate-code` are kept for an hour too (the most recent
10,000), so the same question is only asked once. Requests that had to ask another server are
counted, and graphed, separately on the home page (External requests).

Only a code system that is a URI (`http://...`, `urn:oid:...`) is looked for: `1`, `LOINC` or a
url with a version glued on aren't sent to the registry. A server registered as `http://` is asked
over `https://` first, and over `http://` only if it doesn't answer on `https://` at all (no
connection, a TLS failure, or no answer within 10 seconds); which one works is remembered for an
hour. Redirects are followed (up to 5), every address under the same SSRF rules; a request that
carries credentials is only followed to the same host.

### VSAC Configuration

`vsacCfg` configures the VSAC provider (a `vsac` source in the library). The value sets are
synced from VSAC into a SQLite database in the terminology cache folder, and read from it when
they are asked for; only the recently used ones are kept parsed in memory.

| Option                 | Type    | Required | Description                                                                                       |
|------------------------|---------|----------|---------------------------------------------------------------------------------------------------|
| `apiKey`               | string  | Yes      | UMLS API key for VSAC                                                                             |
| `baseUrl`              | string  | No       | VSAC FHIR server. Default: `https://cts.nlm.nih.gov/fhir`                                         |
| `refreshIntervalHours` | number  | No       | Hours between syncs. A failed sync is retried after 1, 5, then every 30 minutes. Default: 24      |
| `timeoutMs`            | integer | No       | Timeout for requests to VSAC, in milliseconds. Default: 120000                                    |
| `resync`               | boolean | No       | Unless false, the /info page offers the server's administrators (logged in) a form to resync one value set now. (`resyncPassword` is no longer used) |
| `valueSetCacheMB`      | number  | No       | Size of the recently used value sets kept parsed, measured by their stored JSON; 0 keeps none. Default: 64 |

`valueSetCacheMB` is measured in stored JSON, not memory: parsed value sets take several
times as much heap as their JSON (so expect a few hundred MB of heap at the default), and in
cluster mode every worker keeps its own.

`externalLimit`, `internalLimit` and `walkLimit` are checked at startup: each, when set, must be a whole number above 0, and `externalLimit` <= `internalLimit` <= `walkLimit`; anything else stops the server with an error saying which. The limits in use are logged at startup. Every client gets the same limits: the tx-ecosystem test runner (User-Agent `Tools/Java`) used to be held to the old defaults (3000 and 10000) whatever the configuration; now the tests that depend on a limit ask for it with the header.

The `x-too-costly-threshold` request header sets the `externalLimit` for that request, for any client. It is there so test cases can ask for a lower limit: it can't be more than the `internalLimit` (a bigger value is cut down to it), and a value that isn't a positive whole number is ignored, so there is always a limit.

The largest request body the server accepts is a server setting, `server.maxBodyMB` (see the main README); a tx endpoint answers a bigger one with a 413 OperationOutcome (too-costly).

### Endpoint Configuration

Each endpoint in the `endpoints` array has:

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `path` | string | Yes | The URL path where this endpoint will be mounted (e.g., `/tx/r4`) |
| `fhirVersion` | number | Yes | FHIR version: `3` (STU3), `4` (R4), `5` (R5), or `6` (R6) |
| `context` | string | No | Optional context string passed to the Library when creating Providers |

**Note:** Endpoint paths must be unique. The module will throw an error if duplicate paths are configured or if a path conflicts with another module.

### Fixed limits

These are constants in the code, not settings; they are listed so their effects can be recognised.

| Limit | Value | What it bounds |
|---|---|---|
| Memory per code, for the default of `expansionCacheMaxCodes` | 1 KB | only the derived default (`operation-context.js`) |
| Share of the heap, for the default of `expansionCacheMaxCodes` | 0.25 | a quarter of the V8 heap limit, per process |
| Shortest expansion that is cached | 250 ms | expansions that took less are not kept in the expansion cache |
| Longest compute before yielding the event loop | 10 ms | how long one operation can hold up the others (`operation-context.js`, `YIELD_INTERVAL`) |
| ECL nesting depth | 100 | bracketed expressions and refinements; deeper is a parse error |
| ECL sub-expressions | 500 | focus concepts, refinement values, ... (a long `A OR B OR ...` reaches it first); more is a parse error |
| Resource self-nesting depth | 100 | `CodeSystem.concept` and `ValueSet.expansion.contains` (SNOMED CT is about 30 deep); deeper is a 400 |
| XML element depth | 1000 | a deeper XML body is an error |
| LOINC SQLite `cache_size` | 10000 pages (about 40 MB) | page cache, per database connection |
| LOINC SQLite `mmap_size` | 256 MB | memory-mapped reads, per database connection; file-backed pages, shared between connections |
| Forced GC back-off | 60 s at most | while the memory guard is refusing requests, the wait between forced GCs doubles up to this (server wide, `library/memory-guard.js`) |

## Supported Operations

Each endpoint provides the following FHIR terminology operations:

### CodeSystem Operations

| Operation | Endpoints | Methods |
|-----------|-----------|---------|
| Read | `GET /{path}/CodeSystem/{id}` | GET |
| Search | `GET /{path}/CodeSystem?{params}` | GET, POST |
| $lookup | `GET/POST /{path}/CodeSystem/$lookup` | GET, POST |
| $lookup (instance) | `GET/POST /{path}/CodeSystem/{id}/$lookup` | GET, POST |
| $validate-code | `GET/POST /{path}/CodeSystem/$validate-code` | GET, POST |
| $validate-code (instance) | `GET/POST /{path}/CodeSystem/{id}/$validate-code` | GET, POST |
| $subsumes | `GET/POST /{path}/CodeSystem/$subsumes` | GET, POST |
| $subsumes (instance) | `GET/POST /{path}/CodeSystem/{id}/$subsumes` | GET, POST |

### ValueSet Operations

| Operation | Endpoints | Methods |
|-----------|-----------|---------|
| Read | `GET /{path}/ValueSet/{id}` | GET |
| Search | `GET /{path}/ValueSet?{params}` | GET, POST |
| $expand | `GET/POST /{path}/ValueSet/$expand` | GET, POST |
| $expand (instance) | `GET/POST /{path}/ValueSet/{id}/$expand` | GET, POST |
| $validate-code | `GET/POST /{path}/ValueSet/$validate-code` | GET, POST |
| $validate-code (instance) | `GET/POST /{path}/ValueSet/{id}/$validate-code` | GET, POST |

### ConceptMap Operations

| Operation | Endpoints | Methods |
|-----------|-----------|---------|
| Read | `GET /{path}/ConceptMap/{id}` | GET |
| Search | `GET /{path}/ConceptMap?{params}` | GET, POST |
| $translate | `GET/POST /{path}/ConceptMap/$translate` | GET, POST |
| $translate (instance) | `GET/POST /{path}/ConceptMap/{id}/$translate` | GET, POST |
| $closure | `GET/POST /{path}/ConceptMap/$closure` | GET, POST |

### Metadata

Each endpoint also provides:
- `GET /{path}/metadata` - Returns a CapabilityStatement describing the endpoint's capabilities
- `GET /{path}/` - Returns basic endpoint information
- `GET /{path}/library` - Returns the library source YAML, if `publishLibrarySource` is set
- `GET /{path}/caches` - The caches page (see below)

### The caches page

`/{path}/caches` lists every cache the tx module keeps (`tx/tx-caches.js`),
with how many entries each holds, more about what it holds, and its limit, and the process's memory
(RSS, the JS heap, and what is outside it). There are three kinds:

* **Endpoint and process caches**: the expansion caches, the XML of large arrays, the recently read
  VSAC value sets, the filter results on package value sets (see below), the LOINC filter lookups,
  what the ecosystem registry and servers said, parsed language tags, compiled regular expressions.
  The usage tracker is listed, but not emptied
* **Kept with loaded content**, built as it is used: the SNOMED CT history and MRCM range indexes, the text indexes built in memory. The text index store is
  listed, but not emptied: it is on disk, and built as the server starts
* **Client caches**: the `$cache-control` cache-ids (a shared cache, `sharedCache`, is listed, but not
  emptied: it is on disk, and the other processes' too)

For the server's administrators, logged in, the page can empty all but the client caches, or all of them, client caches
too - back to what the server held when it had started. Everything is built again as it is needed;
emptying the client caches makes every client start its cache again (they are told the cache-id is
unknown). A full garbage collection and `malloc_trim` follow, and the page shows RSS before and after.

Under the cluster launcher the page is server wide: it shows every process (a column for each, and
the total, then each process in full), and empties the caches of every process (see
[cluster.md](../cluster.md#the-caches-page)). Without it (one process, or roles behind nginx), only
the process the request reached.

When memory is short, the memory guard empties the endpoint and process caches before it forces a
GC, and the client caches only at a later look, if that wasn't enough.

### Publishing the library source

`publishLibrarySource` lets users see what the server actually loads. It is off by default,
because the library YAML names every database, cache and package the server runs, and not
every deployment wants that public. Turn it on and each endpoint serves the file at
`/{path}/library`, and a **Library** item appears in the tx navigation bar.

There is one URL, content negotiated the same way the rest of the module negotiates:

| Request | Response |
|---------|----------|
| `Accept: text/html` (i.e. a browser) | the file, syntax highlighted, in the tx page template |
| anything else | the file itself, as `application/yaml` |
| `?_format=html` / `?_format=yaml` | forces either representation |

The file is read from disk per request, so editing it is reflected immediately - note that
this means the published file can be ahead of what the running server actually loaded, if it
has been edited since startup.

### Syndication feed

`syndication.enabled` publishes the content the library loads as a
[Terminology Syndication Feed](https://build.fhir.org/ig/FHIR/fhir-syndication-ig/en/)
(Atom, NCTS ASF profile), so that Ontoserver, other FHIRsmith servers and people can follow
what the server loads. It is off by default.

```json
"syndication": { "enabled": true }
```

**The store.** As the library loads its sources, each one is recorded in the syndication store,
`<data>/terminology-cache/syndication` (`syndication.json` plus `files/`). The store is defined
from the moment syndication is turned on: content loaded before then is not back-filled, but
since induction happens as content loads, everything the server loads after that is recorded
the first time the store sees it, with the time it was recorded. The store only grows -
entries are never changed or removed, there are no retract entries, and a later update to
the same content is a new entry (so `contentItemVersion` is not unique - a deliberate departure
from the IG). One store serves all the endpoints.

| Source | Entry | Link | Category |
|--------|-------|------|----------|
| `npm:` / `url:` packages, and each endpoint's core package | the package | `https://npm.fhir.org/web/{id}-{version}.tgz` (a `url:` source: its url) | `FHIR_Package` |
| `file:` / `folder:` | each resource that has a version | a copy in the store | `FHIR_CodeSystem` / `FHIR_ValueSet` / `FHIR_ConceptMap` |
| `snomed`, `loinc`, `rxnorm`, `ndc`, `unii`, `omop`, `icd11`, `cpt` (fragment only) | the file | `base.url` + file name | `SNOMED_CACHE`, `LOINC_DB` ... in `http://healthintersections.com.au/syndication/fhirsmith/1.0.0` |

Not syndicated: `internal:` sources (including VSAC), OCL, `#current`/build packages, resources
without a version, the full CPT database, and binaries that are not published at `base.url`
(checked with a HEAD request - a binary that is only local is a development build). Binary
entries carry `<rights>`. Every link carries `ncts:sha256Hash`: a package is downloaded once to
hash it, then discarded. Only the core packages are FHIR version specific; everything else
appears in every endpoint's feed, with that endpoint's `ncts:fhirVersion`.

Induction runs in the background, one item at a time, so it never holds up startup; a failure
is logged and tried again the next time the content loads.

**The feed** uses RFC 5005 archived feeds, 30 entries a page:

| URL | Content |
|-----|---------|
| `/{path}/syndication` | the newest entries (fewer than 30), linked to the newest archive |
| `/{path}/syndication/archive/{n}` | archive *n* (1 = oldest), linked back to *n*-1 - never changes once it exists |
| `/{path}/syndication/files/{name}` | a resource file copied into the store |

The links in the feed are built from the server's `hostName` (top level of config.json) as
`https://{hostName}{path}`, never from the request's Host header; only archives built that way
are served as cacheable forever. Without a `hostName` the links follow the request, and
archives are `no-cache`.

A browser (`Accept: text/html`) gets the feed as a page; `?_format=atom` forces Atom. The IG's
query-string filters are not supported. A **Syndication** item appears in the tx navigation bar.

## OpenAPI description

Each R5 endpoint is described by an OpenAPI 3.1 spec (the R4 and R3 endpoints work the same
way, with that version's resources, and aren't described separately):

| URL | |
|---|---|
| `/{path}/openapi` | Browsable reference (HTML, in the tx page template), with a "try it" form for each GET operation |
| `/{path}/openapi.json` | The spec as JSON |
| `/{path}/openapi.yaml` | The spec as YAML |

`servers` is the endpoint. Every response from an R5 endpoint carries a
`Link: </{path}/openapi.json>; rel="service-desc", </{path}/openapi>; rel="service-doc"` header
(RFC 8631), the tx pages carry the matching `<link>` element and an **API** item in the
navigation bar, and the server home page links to it. The HTML pages (`/`, `/op.html`, `/ecl`,
`/problems.html`, `/info`, `/library`) aren't described.

The spec is in three parts, merged when it's served ([openapi.js](openapi.js)):

* [openapi.yaml](openapi.yaml) - the overview, `/metadata`, `/$versions`, and the shared
  components, written by hand
* [openapi-operations.js](openapi-operations.js) - the terminology operations, as data: their
  in and out parameters, with types, cardinalities and descriptions. openapi.js makes the paths
  from them (type and instance level; GET with the primitive parameters in the query, POST with
  a Parameters resource or a form) and a table of the parameters for each. The parameters
  TxParameters reads for most operations (tx-resource, cache-id, the version rules,
  displayLanguage, ...) are listed once, in the overview. The read and search paths are made
  there too, from the search worker's parameters
* [openapi-schemas.json](openapi-schemas.json) - the FHIR R5 schemas, generated from the
  StructureDefinitions by `library/fhir-openapi-schema.js`, as configured in
  [openapi-schemas.config.js](openapi-schemas.config.js)

The schemas are documentation: they describe what the server handles and returns, but the
server doesn't reject content outside them. They describe:

* CodeSystem, ValueSet, ConceptMap, OperationOutcome, Parameters, Bundle, CapabilityStatement
  and TerminologyCapabilities, closed, with the `_x` siblings of primitive elements and
  `modifierExtension` wherever FHIR allows them
* contained resources only in a ValueSet, and only ValueSets
* extension and parameter values: the primitive types (not `base64Binary`), `Coding` and
  `CodeableConcept`
* resources in a Bundle or a Parameters: CodeSystem, ValueSet, ConceptMap, OperationOutcome -
  and Parameters, in a Parameters, for `$batch-validate-code` and `profile`. Never a Bundle
* OperationOutcome issues with `details.text`, and (except for information) a tx-issue-type
  coding

After changing the operations, `openapi.js` picks them up. After changing the schema config,
regenerate (this needs `hl7.fhir.r5.core#5.0.0` in the terminology cache):

    node utilities/generate-openapi-schemas.js tx

`tests/tx/openapi.test.js` fails if a route isn't described (or excluded, with a reason), if a
worker or TxParameters reads a parameter that isn't described - or a described one isn't read
anywhere - or if the generated schemas are out of date. It also validates what the server
actually returns (metadata, read and search, `$expand`, `$validate-code`, `$lookup`,
`$subsumes`, `$batch-validate-code`, `$versions`, `$cache-control`, an error) against the
schemas, using ajv. So a new parameter needs adding to openapi-operations.js.

## Loading SNOMED CT

By default each SNOMED CT cache file is read into the server process, at about its file size
(0.6–1.2 GB an edition). A file can instead be memory-mapped read-only:

- the edition loads in milliseconds;
- only the pages that requests touch become resident, as page cache that the kernel can drop
  and read again;
- every server process on the machine that maps the same file shares those pages.

The first request to touch a part of a mapped edition waits for the disk, unless that edition
is *prewarmed*: mapped, then read through once in the background at startup, so its pages are
already in the page cache when requests arrive. Startup doesn't wait for it.

This is set per server, in the tx module's `snomed` block in `config.json`:

```json
"tx": {
  "snomed": {
    "load": "mmap",
    "prewarm": ["http://snomed.info/sct/900000000000207008/version/20250201",
                "sct_us_20250901b.cache"],
    "read": []
  }
}
```

- **`load`** is `"read"` (the default) or `"mmap"`, for every edition not named below.
- **`prewarm`** lists editions to prewarm (map, then read through once in the background at
  startup), even when `load` is `"read"`.
- **`read`** lists editions to read into the process even when `load` is `"mmap"`.
- An entry is any of:
  - a cache file name (`sct_us_20250901b.cache`)
  - an edition version URI (`http://snomed.info/sct/731000124108/version/20250901`)
  - an edition URI (`http://snomed.info/sct/731000124108`), which covers every loaded version
    of that edition
- `read` wins over `prewarm`.
- Entries that match no loaded edition are warned about at startup.
- With no `snomed` block, everything is read, as before.

Mapping uses the optional `koffi` dependency. Where it is not available (Windows, 32-bit
platforms, or koffi not installed), a mapped edition is read instead, with a warning in the
server log. The log says, for each edition that was to be mapped, whether it really was. When
any edition is mapped, the memory guard leaves file-backed pages out of the memory it measures
(Linux).

## Library Configuration

The library - the source to load - is configured using a YAML file.

### YAML Structure

```yaml
base:
  url: https://example.com/terminology-files

sources:
  - internal:lang
  - ucum:tx/data/ucum-essence.xml
  - snomed!:sct_intl_20250201.cache
  - npm:hl7.terminology
```

### Base Configuration

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `url` | string | Yes | Base URL for downloading external terminology files. Files specified in sources (for types that require downloads) will be fetched from this URL if not already cached locally. |

The idea here is that the configuration file is probably in a git repo somewhere, but lots of the content it points to isn't and can't or
shouldn't be - too big. Note that that files in the list below are considered to never change once they are created.

### Source Format

Each source entry follows the format:

```
type[!]:details[=prefix]
```

- **type**: The source type (see Source Types below)
- **!** (optional): Append to type to mark this source as the default for its code system. When multiple versions of the same code system are loaded, the default is used when no version is specified.
- **details**: Type-specific configuration (filename, package name, or internal provider name)
- **prefix** (optional): The id prefix for the resources the source provides - see [Resource Ids](#resource-ids). Everything after the last `=` in the entry is the prefix, so a `url` source whose url contains a `=` must give one.

### Resource Ids

Every CodeSystem, ValueSet and ConceptMap is served with an id in the id space of the source it came from: the source's prefix, `-`, and the id the resource has in the source. With

```yaml
- npm:hl7.terminology=tho
```

THO's v3-ActCode code system is `CodeSystem/tho-v3-ActCode`. No resource is served on the id it has in its source - different sources can use the same ids (hl7.terminology and the FHIR core packages both have a CodeSystem `v3-MaritalStatus`), so an unprefixed id can't say which one is meant, and it finds nothing.

- A prefix may contain letters, digits and `.` (no `-`), up to 32 characters, and each prefix may only be given once
- If a source isn't given a prefix, it gets a number. Numbers depend on the order of the sources (and on which sources provide which kinds of resource), so they change when the YAML changes. Give every source that provides resources a prefix if its ids should stay the same - i.e. on any server where people link to resources by id
- `core` is the FHIR core package each endpoint loads for its FHIR version (`CodeSystem/core-administrative-gender`), and `x` is the code systems the server implements natively (`CodeSystem/x-...`); neither can be given as a prefix
- Sources that only provide code systems natively (`internal`, `snomed`, `loinc` etc.) don't serve resources by id, so a prefix does nothing for them

#### hl7.terminology and the FHIR core packages

Much of the content of the FHIR core packages has moved to terminology.hl7.org (`hl7.terminology`), and its versions were reset when it moved (`coverage-selfpay` is 4.0.1 in `hl7.fhir.r4.core`, and 1.0.1 in `hl7.terminology`), so version order can't decide between the two. Where `hl7.terminology` provides a code system, value set or concept map with the same url as the endpoint's core package, THO's is always the one a reference with no version gets. The core package's versions are still available to a reference that names them (`http://hl7.org/fhir/concept-property-type|5.0.0`), unless THO provides that same version itself. Core value sets and concept maps that THO also provides are not read by id, found by search, or used for `$translate` unless asked for by version.

### Source Types

#### `internal` - Built-in Code Systems

Built-in code system providers that are compiled into the server. These don't require external files.

```yaml
- internal:lang      # IETF BCP-47 language codes
- internal:country   # ISO 3166 country codes
- internal:currency  # ISO 4217 currency codes
- internal:areacode  # Telephone area codes
- internal:mimetypes # MIME types
- internal:usstates  # US state codes
- internal:hgvs      # HGVS (Human Genome Variation Society) nomenclature
```

**Note:** The `!` default marker is not supported for internal providers.

#### `ucum` - UCUM (Unified Code for Units of Measure)

Loads UCUM from a local XML file (ucum-essence format).

```yaml
- ucum:tx/data/ucum-essence.xml
```

The path is relative to the server's base directory. The UCUM essence XML file can be obtained from https://ucum.org.

#### `loinc` - LOINC (Logical Observation Identifiers Names and Codes)

Loads LOINC from a SQLite database file.

```yaml
- loinc:loinc-2.81-b.db
```

The filename is downloaded from the base URL if not cached. Database files must be in the server's proprietary format.
The file is built by importing LOINC (see [documentation](importers/readme.md))

A text filter (`$expand` with `filter`) searches the database's text index: every name of a code in
the search language - in English, the display and the other English names; never the RELATEDNAMES2
keywords - by the rules every code system's text search follows (see [Text filters](#text-filters)).
A database whose index is older (FHIRsmith 1.0.2 and earlier, or an early 1.0.3) is searched as
before, for the whole filter text in the display, and the server says so once at startup; bring it
up to date, while no server has it open, with `tx-import loinc upgrade-text-index -d <file>` (no new
import needed).

#### `rxnorm` - RxNorm

Loads RxNorm drug terminology from a SQLite database file.

```yaml
- rxnorm:rxnorm_02032025-a.db
```

The file is built by importing RxNorm (see [documentation](importers/readme.md))

#### `ndc` - NDC (National Drug Code)

Loads NDC codes from a SQLite database file.

```yaml
- ndc:ndc-20211101.db
```

#### `unii` - UNII (Unique Ingredient Identifier)

Loads FDA UNII codes from a SQLite database file.

```yaml
- unii:unii_20240622.db
```
The file is built by importing UNII (see [documentation](importers/readme.md))

#### `snomed` - SNOMED CT

Loads SNOMED CT from a cache file. Multiple editions and versions can be loaded simultaneously.
The cache files are made by the SNOMED CT importer (see [documentation](importers/readme.md)), and
must be in the format of this version's importer (cache format 21): the server refuses to start
with a cache in any other format, which has to be imported again.

```yaml
- snomed!:sct_intl_20250201.cache  # International edition (default)
- snomed:sct_intl_20240201.cache   # Older international edition
- snomed:sct_us_20250901.cache     # US edition
- snomed:sct_au_20230731.cache     # Australian edition
- snomed:sct_uk_20230412.cache     # UK edition
```

Common edition identifiers:
- `intl` - International
- `us` - United States
- `au` - Australia
- `uk` - United Kingdom
- `se` - Sweden
- `be` - Belgium
- `ch` - Switzerland
- `dk` - Denmark
- `nl` - Netherlands
- `ips` - IPS (International Patient Summary) Free Set

The file is built by importing SNOMED CT (see [documentation](importers/readme.md))

How the cache files are loaded is a deployment choice, so it is set in `config.json` (the
tx module's `snomed` block), not here - see [Loading SNOMED CT](#loading-snomed-ct).


#### `cpt` - CPT (Current Procedural Terminology)

Loads CPT codes from a SQLite database file.

```yaml
- cpt:cpt-2023-fragment-0.1.db
```

**Note:** CPT is copyrighted by the American Medical Association. Ensure you have appropriate licensing.

The file is built by importing CPT (see [documentation](importers/readme.md))

#### `omop` - OMOP Vocabularies

Loads OMOP (Observational Medical Outcomes Partnership) vocabulary mappings from a SQLite database file.

```yaml
- omop:omop_v20250227.db
```
The file is built by importing OMOP (see [documentation](importers/readme.md))

#### `icd11` - ICD-11

Loads ICD-11 from a SQLite database built by importing from the WHO ICD-API.

```yaml
- icd11:icd11-2026-01.db
```

One database holds three code systems - the MMS and ICF linearizations and the Foundation -
so a single source line registers a provider for each one it finds:

| system | url |
|---|---|
| MMS | `http://id.who.int/icd/release/11/mms` |
| ICF | `http://id.who.int/icd/release/11/icf` |
| Foundation | `http://id.who.int/icd/entity` |

The file is built by importing ICD-11 (see [documentation](importers/icd11-schema.md)). Note
that only the WHO native API can enumerate the classification; the FHIR endpoint cannot, which
is why the importer reads from the native one.

#### `npm` - FHIR NPM Packages

Loads CodeSystem, ValueSet, and ConceptMap resources from FHIR NPM packages. Packages are fetched from the FHIR package registry (packages2.fhir.org).

```yaml
- npm:hl7.terminology           # HL7 Terminology (THO)
- npm:fhir.tx.support.r4        # TX support package
- npm:ihe.formatcode.fhir       # IHE format codes
- npm:fhir.dicom                # DICOM terminology
- npm:hl7.fhir.us.core          # US Core profiles
- npm:us.nlm.vsac               # VSAC value sets
- npm:us.cdc.phinvads           # CDC PHIN VADS
- npm:hl7.fhir.uv.sdc           # Structured Data Capture
```

You can specify a version using the `#` syntax:

```yaml
- npm:hl7.terminology#5.0.0
- npm:hl7.fhir.us.core#6.1.0
```

If no version is specified, the latest released version is fetched.

#### `url` - FHIR Packages from Direct URLs

Loads a FHIR package directly from a tarball URL instead of the FHIR package registry. Useful for packages hosted on CI build servers, branches, or other locations.

Use `url/cs` to load only CodeSystem resources from the package (same as `npm/cs`).

```yaml
# Load a package from a CI build server
- url:https://example.com/my-package/package.tgz

# Load a code-systems-only package from a URL
- url/cs:https://example.com/my-codesystems/package.tgz
```

The URL must point to a `.tgz` file in standard FHIR NPM package format. Downloaded packages are cached locally by URL.

### Default Marker (`!`)

When multiple versions of the same code system are loaded, append `!` to mark one as the default:

```yaml
- snomed!:sct_intl_20250201.cache  # This is the default SNOMED CT
- snomed:sct_intl_20240201.cache   # Also available, but not default
```

When a terminology operation doesn't specify a version, the default version is used. Only one source per code system should be marked as default.

### File Caching

Files specified in sources (except `internal` and `ucum`) are:
1. First checked in the local cache folder (`terminology-cache`)
2. Downloaded from the `base.url` if not present
3. Cached locally for future use

NPM packages are handled separately through the FHIR package registry.

### Example Configuration

Here's a complete example for a production terminology server:

```yaml
base:
  url: https://storage.googleapis.com/tx-fhir-org

sources:
  # Built-in code systems
  - internal:lang
  - internal:country
  - internal:currency
  - internal:mimetypes
  
  # Units of measure
  - ucum:tx/data/ucum-essence.xml
  
  # Clinical terminologies
  - loinc:loinc-2.81-b.db
  - rxnorm:rxnorm_02032025-a.db
  - snomed!:sct_intl_20250201.cache
  - snomed:sct_us_20250901.cache
  
  # FHIR packages
  - npm:hl7.terminology=tho
  - npm:hl7.fhir.us.core=us
  - npm:us.nlm.vsac=vsac
```

Also see tx.fhir.org.yml for the production configuration for tx.fhir.org

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         Library                              │
│  (Loaded once at startup from YAML)                         │
│  - Code System Factories                                    │
│  - Code System Providers                                    │
│  - Value Set Providers                                      │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ cloneWithFhirVersion(version, context)
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                         Provider                             │
│  (Created per-request with FHIR version context)            │
└─────────────────────────────────────────────────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          ▼                   ▼                   ▼
    ┌──────────┐        ┌──────────┐        ┌──────────┐
    │  /tx/r5  │        │  /tx/r4  │        │  /tx/r3  │
    │ FHIR R5  │        │ FHIR R4  │        │ FHIR R3  │
    └──────────┘        └──────────┘        └──────────┘
```

## Workers

The module uses worker classes to handle specific operations:

| Worker | Operations |
|--------|------------|
| `read.js` | Resource read operations |
| `search.js` | Resource search operations |
| `lookup.js` | CodeSystem $lookup |
| `subsumes.js` | CodeSystem $subsumes |
| `validate.js` | CodeSystem and ValueSet $validate-code |
| `expand.js` | ValueSet $expand |
| `translate.js` | ConceptMap $translate |
| `closure.js` | ConceptMap $closure |

## Error Handling

All errors are returned as FHIR OperationOutcome resources:

```json
{
  "resourceType": "OperationOutcome",
  "issue": [{
    "severity": "error",
    "code": "not-found",
    "diagnostics": "CodeSystem/example not found"
  }]
}
```

## Notes

- Write operations (PUT, POST, DELETE, PATCH) on resources are not supported and return 405 Method Not Allowed
- The Library is loaded once at startup; changes to the YAML source require a server restart
- Each endpoint has it's own Provider instance

## Text filters

A text filter (`$expand` with `filter`) matches by the same rules in every code system - SNOMED CT,
LOINC, RxNorm, ICD-11, code systems from packages, and the supplements in use
(`tx/library/text-match.js`):

* **Names.** A code matches when one of its names in the search language (its display, or one
  designation: the words can't be spread over two) has every word of the filter, in any order, each
  as the start of one of its words or with the same stem. A code also matches when it starts with the
  filter as given - a straight left match, without regard to case, but not split into words, stemmed
  or folded: people search by code too.
* **Words.** Text is folded - lower case, and accents dropped from Latin, Greek and Cyrillic letters
  (in other scripts marks are part of the spelling, and are kept) - and its words are the runs of
  Unicode letters, marks and digits. Numbers are words.
* **Stems.** Each word is stemmed with the best stemmer there is for the language of its text: English,
  French, German, Spanish, Italian, Portuguese, Dutch, Swedish, Norwegian, Russian, Ukrainian, Persian
  and Indonesian. A language without one isn't stemmed.
* **The filter.** Its first 100 characters, at most 10 words, each once. The stop words a, an, and, as,
  at, by, for, from, in, into, of, on, or, the, to are left out, unless that leaves nothing. A single
  letter or digit only matches that word: `hepatitis b` doesn't find hepatitis C.
* **Order.** The best matches come first: the code itself, then a code that starts with the filter;
  a name that is the filter; then the filter's words in its order - starting the name, then together
  later in it, then with other words between (the name's stop words don't count) - and last, all
  there in another order. Between these, the shorter name first. `ac ap` lists Acute appendicitis
  before Applied action.
* **The language** is the first the request names (`displayLanguage`, else `Accept-Language`) that the
  code system or a supplement in use has text in, else the code system's own, compared at the primary
  language subtag.

The code systems held in a database (LOINC, RxNorm, ICD-11) answer from a text index in it that holds
each name's words and stems, made by FHIRsmith, so SQLite only looks them up; the importers build it,
and each has a way to build it in an existing database without importing again (see
[the importers](importers/readme.md)).

The code systems and supplements defined as resources that the server loads as it starts (from
packages and folders) answer from the **text index store**, a SQLite database of the same kind in
`terminology-cache/text-indexes/text-indexes.db` (`tx/library/text-index-store.js`). The server
waits for it as it starts: each index is keyed on a hash of what it indexes, so one built in an
earlier run for the same content is used as it is, and only new or changed content is indexed (the
first start with a big library takes a while; the log says how long, and how many were built). When
the server has started, the indexes nothing loaded any more are deleted. In a cluster the master
builds them, and the tx-workers use what it built. Code systems and supplements that come later (in a
request, `tx-resource`) are indexed in memory the first time they are searched, as is anything the
store doesn't have (if it can't be opened, everything is).


## Languages

The server's messages - the text of the issues in an OperationOutcome, and the messages
`$validate-code` and `$expand` return - and the phrases the HTML pages use when they render
resources are translated (`translations/Messages_*.properties` and
`translations/rendering-phrases_*.properties`): Arabic, Chinese, Dutch, French, German, Japanese,
Portuguese, Russian, Spanish, Tagalog and Uzbek. A message is in the first language of the
request's `Accept-Language` that has it - the language as given (`fr-CA`), then its primary
subtag (`fr`) - and otherwise in English, so a message no translation has yet is in English too.
The message id (`message-id` extension) and the issue codes don't change with the language.

`displayLanguage` is a different thing: it chooses the displays of the codes, not the language of
the messages.

To add a language, add a `Messages_xx.properties` and a `rendering-phrases_xx.properties` (`xx`
the language code, with `_` for `-`: `Messages_pt_BR.properties` is `pt-BR`) beside the others.
The English files list every message; a translation can have only some of them. org.hl7.fhir.core's
`Messages.properties` (in org.hl7.fhir.utilities) is the master: a message id added to FHIRsmith's
has to be added there too.
