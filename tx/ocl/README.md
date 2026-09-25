# OCL Integration in FHIRsmith

## Overview
The `tx/ocl` module integrates [Open Concept Lab (OCL)](https://openconceptlab.org/) as a terminology source inside FHIRsmith.

It provides adapters/providers for:

- `CodeSystem` from OCL Sources
- `ValueSet` from OCL Collections
- `ConceptMap` from OCL Mappings

In FHIRsmith terms, these providers are loaded by `tx/library.js` when a source entry starts with `ocl:`. OCL metadata is discovered from OCL APIs, and heavy content (concept lists/expansions) is loaded lazily and warmed in background jobs.

## Architecture
### Main modules
- `cs-ocl.js`
  - `OCLCodeSystemProvider`: discovers OCL sources and publishes CodeSystem metadata.
  - `OCLSourceCodeSystemFactory`: creates runtime CodeSystem providers with shared caches, cold-cache hydration, and background full-load jobs.
  - `OCLSourceCodeSystemProvider`: runtime concept lookup/filter/search behavior for one source.
- `vs-ocl.js`
  - `OCLValueSetProvider`: discovers OCL collections, resolves compose includes, serves ValueSet metadata, and builds cached expansions in background.
- `cm-ocl.js`
  - `OCLConceptMapProvider`: resolves OCL mappings for fetch/search/translation candidate discovery.

### Supporting modules under `tx/ocl`
- `http/client.js`: Axios client creation, base URL normalization, token auth header (`Token` or `Bearer`).
- `http/pagination.js`: OCL pagination helper (`results/items/data`, `next`, page mode fallback).
- `cache/cache-paths.js`: cold-cache directories and canonical URL to file path mapping.
- `cache/cache-utils.js`: cache directory creation, file age detection, friendly age formatting.
- `fingerprint/fingerprint.js`: deterministic SHA-256 fingerprints for CodeSystem concepts and ValueSet expansions.
- `jobs/background-queue.js`: singleton keyed queue, size-priority ordering, max concurrency = 2, heartbeat logging every 30s.
- `mappers/concept-mapper.js`: maps OCL concept payloads to internal concept context shape.
- `model/concept-filter-context.js`: ranked filter result set used by CodeSystem filters.
- `shared/constants.js`: defaults and constants (`PAGE_SIZE`, cache freshness window, etc.).
- `shared/patches.js`:
  - patches search worker so `CodeSystem?url=...&code=...` on OCL resources only returns matching concept subtree.
  - patches `TxParameters.hashSource()` to include `filter` for expansion cache key differentiation.

## Runtime flow
### Metadata discovery
CodeSystems (`cs-ocl.js`):
- prefer one paginated crawl of the global `/sources/` listing (filtered to
  organization-owned entries)
- fallback: discover orgs via `/orgs/`, then `/orgs/{org}/sources/` per org

ValueSets (`vs-ocl.js`):
- prefer one paginated crawl of the global `/collections/` listing (filtered to
  organization-owned entries)
- fallback: discover orgs via `/orgs/`, then `/orgs/{org}/collections/` per org

### Visibility policy (org-only)
An artifact is expected to live in an **organization** to be visible through the
terminology service. User-owned repos (`/users/{user}/...`) are experimental by
convention and are excluded from both discovery and `$resolveReference` results
(a canonical resolving to a user-owned repo is treated as unresolved).

### Canonical resolution via `$resolveReference`
With a `token=` configured on the `ocl:` source line, the providers resolve
"which repo holds this canonical URL?" through OCL's
[`$resolveReference`](https://docs.openconceptlab.org/en/latest/oclapi/apireference/resolveReference.html)
(global namespace) instead of iterating listings and matching `canonical_url`
client-side. Used for ConceptMap source-system search, ValueSet lookup by
canonical, and batched resolution of a collection's compose source canonicals.

Without a token nothing changes: `$resolveReference` is authenticated on every
instance probed (while the listing endpoints are public), so the resolver is
constructed disabled and every caller keeps its previous search path. It also
disables itself for the process on `404`/`401`/`403`.

### CodeSystem default versions (release vs HEAD)
OCL's own resolution treats a source's **latest release** as its default version
(HEAD only when nothing is released), but discovery listings only ever report
HEAD. With a token, discovery batch-resolves every canonical through
`$resolveReference` and registers **both** versions: the release becomes what a
versionless request gets (matching OCL), and HEAD stays reachable via an
explicit `version=HEAD`. Only canonicals that are new or changed are re-resolved
on refresh, so a steady-state cycle costs no extra requests. Without a token,
discovery stays HEAD-only as before.

ConceptMaps (`cm-ocl.js`):
- fetch by id via `/mappings/{id}/`
- search via `/mappings/` or `/orgs/{org}/mappings/`

### Lazy loading
- CodeSystem concepts are not fully loaded at metadata discovery time.
- ValueSet expansions are not built inline by default.
- Missing concept/page/expansion data triggers background warm-up scheduling.

### Cold cache (disk)
- Base folder: `data/terminology-cache/ocl`
- CodeSystems: `data/terminology-cache/ocl/codesystems`
- ValueSets: `data/terminology-cache/ocl/valuesets`

On startup/initialization:
- CodeSystem factory hydrates concept cache from cold cache file if present.
- ValueSet provider loads cached expansions from cold cache files.

Corrupt cache handling:
- JSON parse/read errors are logged and skipped; provider continues without crashing.

### Hot cache (memory)
- CodeSystems: shared in-memory concept/page caches per factory.
- ValueSets: in-memory expansion cache keyed by ValueSet + params hash.
- ConceptMaps: in-memory map keyed by URL/version/id.

### Background warm-up jobs
Queue behavior (`OCLBackgroundJobQueue`):
- singleton job key (skip duplicate key)
- max concurrency = `2`
- ordering by `jobSize` (smaller concept count first)
- heartbeat log every `30s`
- progress supports `{ processed, total }` and `%`

CodeSystem warm-up:
- skipped when cold-cache file age is `<= 1 hour`
- enqueued when stale/no cold cache
- loads all concept pages
- computes fingerprint from full concept content
- if fingerprint changed, replaces cold cache file

ValueSet warm-up:
- skipped when freshest cold cache age (file mtime or cached timestamp) is `<= 1 hour`
- enqueued when stale/no cold cache
- builds expansion by paging collection concepts
- computes expansion fingerprint
- if fingerprint changed, replaces cold cache file

### Fingerprint/checksum strategy
- OCL source checksum is treated as informational only in `cs-ocl.js` comments.
- Cache replacement decisions use custom fingerprints from concept/expansion content.
- ValueSet cache validity also checks metadata signature and dependency checksums from referenced CodeSystems.

### ValueSet expansion filtering
`vs-ocl.js` supports filtered concept retrieval through `valueSet.oclFetchConcepts(...)`:
- local baseline filtering (code/display/definition text contains)
- `SearchFilterText` token behavior
- remote query hint (`q`) generated from normalized filter tokens
- dedicated smaller page size for filtered calls (`FILTERED_CONCEPT_PAGE_SIZE`)

### `/CodeSystem?url=...&code=...` behavior for OCL
`shared/patches.js` patches search worker to apply concept subtree filtering only for OCL-marked CodeSystems (extension URL `http://fhir.org/FHIRsmith/StructureDefinition/ocl-codesystem`).

## Configuration
## Activation in FHIRsmith
OCL is activated by adding an OCL source line in the TX library YAML (for example `data/library.yml`):

```yaml
sources:
  - ocl:https://oclapi2.ips.hsl.org.br
```

`tx/library.js` loads this via `loadOcl()`.

### Source syntax
`tx/library.js` parses:

```text
ocl:<baseUrl>|org=<orgId>|token=<tokenOrAlias>|timeout=<ms>
```

Parsed keys:
- `baseUrl` (required)
- `org` (optional)
- `token` (optional)
- `timeout` (optional positive number)

Examples:

```yaml
sources:
  - ocl:https://api.openconceptlab.org
  - ocl:https://ocl.example.org|org=my-org
  - ocl:https://ocl.example.org|org=my-org|token=my-ocl-token|timeout=45000
```

### Config value aliasing
`Library.resolveOclConfigValue()` can resolve symbolic values from top-level YAML `ocl:` object loaded into `this.oclConfig`.

Example pattern:

```yaml
ocl:
  ocl-base: https://ocl.example.org
  ocl-token: Token abc123

sources:
  - ocl:ocl-base|org=my-org|token=ocl-token
```

### Credentials and URLs
- Base URL is required (OCL API root).
- Token is optional, sent as `Authorization`:
  - `Token <value>` if no prefix is provided
  - preserved if already `Token ...` or `Bearer ...`

### Enable/disable integration
- Enable by including at least one `ocl:` source entry in TX library YAML.
- Disable by removing/commenting those `ocl:` entries.
- `modules.tx.enabled` must be true in server config to expose TX endpoints.

## Cache behavior details
### Startup hydration
- CodeSystem cold cache is loaded when factory is created (`OCLSourceCodeSystemFactory` constructor path).
- ValueSet cold cache is loaded during `OCLValueSetProvider.initialize()`.

### 1-hour freshness rule
- Fresh threshold constant: `COLD_CACHE_FRESHNESS_MS = 60 * 60 * 1000`.
- If cold cache age is `<= 1 hour`, warm-up scheduling is skipped.

### Hot cache replacing cold cache
- On successful background refresh, new fingerprint is compared to previous cold-cache fingerprint.
- If changed, cold cache is overwritten with the refreshed in-memory state.

## Operational notes
### Logs to expect
Prefixes:
- `[OCL]` for CodeSystem/queue/general OCL flow
- `[OCL-ValueSet]` for ValueSet flow

Typical events:
- fetched org/source/collection counts
- cold cache loaded/saved
- warm-up skipped/enqueued/started/completed
- fingerprint unchanged/changed
- queue status + heartbeat snapshots

### Troubleshooting hints
- If nothing loads, verify OCL base URL and org visibility.
- If cache never warms, check cold-cache timestamps and 1-hour rule.
- If searches by `code` behave unexpectedly, confirm OCL marker extension is present on CodeSystem resources.
- For ValueSet filter behavior, verify `filter` is included in request path through `TxParameters.hashSource` patch and that filter text normalizes as expected.

### Known limitations (from current implementation)
- OCL checksums are not relied on for cache invalidation.
- Some source/collection discovery paths depend on OCL endpoint support and can fallback.
- Missing endpoints returning `404` in some concept fetch paths are treated as empty content for graceful degradation.

## Developer notes
### Where to extend
- Add/adjust OCL HTTP behavior: `tx/ocl/http/*`
- Add cache policy/path behavior: `tx/ocl/cache/*`
- Add queue policy: `tx/ocl/jobs/background-queue.js`
- Add mapping logic from OCL payloads: `tx/ocl/mappers/*`
- Add fingerprint strategy: `tx/ocl/fingerprint/*`
- Add provider-specific behavior:
  - CodeSystem: `tx/ocl/cs-ocl.js`
  - ValueSet: `tx/ocl/vs-ocl.js`
  - ConceptMap: `tx/ocl/cm-ocl.js`

### Ownership by concern
- HTTP access: `http/client.js`, `http/pagination.js`
- Disk cold cache and pathing: `cache/cache-paths.js`, `cache/cache-utils.js`
- Background jobs and scheduling policy: `jobs/background-queue.js`
- Fingerprints/checksums: `fingerprint/fingerprint.js` and provider compare logic
- Worker/runtime patches: `shared/patches.js`

### Test strategy for future changes
- Keep provider tests deterministic by mocking OCL HTTP responses and cold-cache files.
- Validate stale/fresh transitions with file mtime control.
- Validate queue behavior with isolated static state reset between tests.
- Track coverage with:

```bash
npm test -- --runInBand tests/ocl --coverage --collectCoverageFrom="tx/ocl/**/*.js"
```
