# CodeSystem Provider API

## Introduction

The CodeSystem Provider API defines the contract between the FHIR terminology server and the
individual code system implementations that back it. It consists of two abstract base classes:

- **`CodeSystemProvider`** — represents a live, per-request provider for a specific code system
  (bound to an `OperationContext`). One instance is created per request.
- **`CodeSystemFactoryProvider`** — a long-lived factory that the server holds in memory and
  uses to construct `CodeSystemProvider` instances on demand.

Implementors subclass `CodeSystemProvider` and override the methods marked *must override*.
The remaining methods have sensible defaults that can optionally be overridden to improve
fidelity or performance.

### OperationContext

Every `CodeSystemProvider` is constructed with an `OperationContext` that carries
per-request state: the requested languages (`opContext.langs`), a usage tracker, and other
request-scoped information. Providers must store and consult this context when making
language-sensitive decisions.

### Supplements

A provider may be constructed with an array of `CodeSystem` supplement resources. These are
FHIR CodeSystem resources with `content = supplement`, and they supply additional displays and
designations for codes that exist in the base code system. The base class provides helper
methods (`_displayFromSupplements`, `_listSupplementDesignations`, `_hasAnySupplementDisplays`)
that implementors can call from their `display()` and `designations()` overrides.

### Codes and Contexts

Many methods accept either a raw `string` code or a `CodeSystemProviderContext` — an opaque
handle returned by `locate()` and the iteration/filter machinery. Passing a context instead
of a string allows implementations to avoid redundant lookups; the pattern is to locate a
concept once, obtain a context, and then pass that context to subsequent property queries.

---

## Metadata

These methods describe the code system as a whole. All are synchronous.

### Required overrides

| Method | Returns | Description |
|---|---|---|
| `system()` | `string` | The canonical URI of the code system (e.g. `http://loinc.org`). |
| `version()` | `string` | The version of the code system. |
| `description()` | `string` | A human-readable description of the code system. |
| `totalCount()` | `integer` | The total number of concepts in the code system. |

### Provided (with defaults)

| Method | Default | Description |
|---|---|---|
| `name()` | `system()` + `\|` + `version()` | The versioned URI for the code system. Returns `system()` alone if there is no version. |
| `vurl()` | Same as `name()` | Alias for the versioned URI. |
| `defLang()` | `'en'` | The default language for displays in this code system. |
| `contentMode()` | `CodeSystemContentMode.Complete` | Whether the code system is complete, a fragment, etc. |
| `expandLimitation()` | `0` | A cap on expansion size (e.g. for CPT). `0` means no limit. |
| `sourcePackage()` | `null` | The NPM package that contributed this code system, if known. |
| `propertyDefinitions()` | `null` | The set of defined properties; override to expose them. |
| `isNotClosed()` | `false` | Return `true` for grammar-based systems (e.g. UCUM) that cannot be fully enumerated. |
| `openCodeSpaceReason()` | `null` | Why an expansion of all of the code system isn't closed although it lists every code the system defines - e.g. the system reserves code spaces for user-defined codes (`codesystem-reservedCodeSpace`). The expansion is marked unclosed with this as the reason. |
| `isCaseSensitive()` | `true` | Whether code comparisons are case-sensitive. |
| `hasParents()` | `false` | Whether the code system has a concept hierarchy. |
| `specialEnumeration()` | `null` | Override to nominate a substitute enumeration (used by UCUM). |
| `listFeatures()` | `null` | Return applicable server features. |
| `status()` | `{}` | Return status metadata: `{ status, standardsStatus, experimental }`. |
| `versionAlgorithm()` | `null` | The algorithm used for version comparison (e.g. `'semver'`, `'date'`). |
| `versionNeeded()` | `false` | Whether a version must be specified when using this code system. |
| `valueSet()` | `null` | The implicit value set URI for this code system, if any. |
| `versionIsMoreDetailed(check, actual)` | `false` | Return `true` if `actual` is a more specific version than `check` (used by SCT edition handling). |
| `hasSupplement(url)` | — | Returns `true` if the named supplement is in scope. |
| `listSupplements()` | — | Returns the versioned URIs of all supplements in scope. |
| `hasAnyDisplays(languages)` | — | Returns `true` if there are displays available in the requested languages. |

---

## Code Properties

These methods return information about an individual concept. Each accepts either a raw
`string` code or a `CodeSystemProviderContext` obtained from `locate()`.
All are `async`.

### Required overrides

| Method | Returns | Description |
|---|---|---|
| `code(code)` | `string` | Returns the canonical form of the code (may normalise case, whitespace, etc.). |
| `display(code)` | `string` | The best available display for the concept given the languages in `opContext.langs`. Should consult supplements via `_displayFromSupplements()`. |
| `definition(code)` | `string` | The definition for the concept, or `null`. |
| `designations(code, displays)` | — | Populates the `ConceptDesignations` object with all available designations across all languages. Should call `_listSupplementDesignations()` to include supplement designations. |

### Provided (with defaults)

| Method | Default | Description |
|---|---|---|
| `isAbstract(code)` | `false` | Whether the concept is abstract (cannot be used in instances). |
| `isInactive(code)` | `false` | Whether the concept is inactive. |
| `isDeprecated(code)` | `false` | Whether the concept is deprecated. |
| `getStatus(code)` | `null` | The status string for the concept. |
| `itemWeight(code)` | `null` | The assigned item weight (used in questionnaire scoring). |
| `parent(code)` | `null` | The parent concept, for hierarchical code systems. |
| `extensions(code)` | `null` | FHIR extensions on the concept, if any. |
| `properties(code)` | `[]` | The defined properties for the concept. |
| `incompleteValidationMessage(code)` | `null` | A message explaining why validation may be incomplete. No provider overrides this: SNOMED expressions are checked against the concept model, and the only things it cannot check are ones SNOMED itself publishes no rule for. |
| `sameConcept(a, b)` | `false` | Returns `true` if `a` and `b` refer to the same concept (e.g. different expression forms). |
| `isDisplay(designation)` | `false` | Called for designations not already marked with a standard display use code; return `true` to treat the designation as a display. |
| `subsumesTest(codeA, codeB)` | `'not-subsumed'` | Returns one of `equivalent`, `subsumes`, `subsumed-by`, or `not-subsumed`. |
| `extendLookup(ctxt, props, params)` | — | Called during `$lookup`; add any additional properties to `params`. |

---

## Iteration

Iteration allows the server to enumerate all concepts in a code system, for use in value set
expansion. The pattern is:

```js
const iter = await provider.iteratorAll();
let ctxt;
while ((ctxt = await provider.nextContext(iter)) !== null) {
  const c = await provider.code(ctxt);
  const d = await provider.display(ctxt);
  // ...
}
```

For hierarchical code systems, `iterator(code)` returns an iterator over the *children* of
the given concept. Pass `null` to iterate the root concepts. `iteratorAll()` iterates
everything regardless of hierarchy.

| Method | Returns | Description |
|---|---|---|
| `iterator(code)` | `CodeSystemIterator \| null` | Returns an iterator over the children of the given concept, or over the root concepts if `code` is `null`. Return `null` if iteration is not supported. |
| `iteratorAll()` | `CodeSystemIterator \| null` | Returns an iterator over all concepts. For flat code systems this delegates to `iterator(null)`; for hierarchical systems this must be overridden. |
| `nextContext(iterator)` | `CodeSystemProviderContext \| null` | Advances the iterator and returns the next concept, or `null` when exhausted. |

The default `iterator()` returns `null` (iteration not supported). The default `nextContext()`
returns `null`. Override both to support expansion.

---

## Filters

Filters are used when expanding value sets that use `include.filter` clauses. The filter
workflow has two phases:

**Phase 1 — preparation.** The server calls `getPrepContext(iterate)` to obtain a
`FilterExecutionContext`, then calls `filter()` once for each filter clause in the include.
After all filters have been registered, `executeFilters()` is called to obtain one or more
`FilterConceptSet` objects.

**Phase 2 — evaluation.** The server either iterates the result set
(`filterMore` / `filterConcept`) or checks membership (`filterLocate` / `filterCheck`).

```js
const ctx = await provider.getPrepContext(true);
await provider.filter(ctx, 'concept', 'is-a', 'some-code');
const sets = await provider.executeFilters(ctx);
const set = sets[0];
while (await provider.filterMore(ctx, set)) {
  const concept = await provider.filterConcept(ctx, set);
  // ...
}
await provider.filterFinish(ctx);
```

| Method | Default | Description |
|---|---|---|
| `doesFilter(prop, op, value)` | `false` | Return `true` if the given filter property/operator/value combination is supported. |
| `getPrepContext(iterate)` | Returns a `FilterExecutionContext` | Returns the shared context object that will be passed to all subsequent filter calls. |
| `filter(ctx, prop, op, value)` | *must override if filters supported* | Registers a single filter clause. |
| `searchFilter(ctx, text, sort)` | throws | Registers a free-text search filter. |
| `specialFilter(ctx, sort)` | throws if `specialEnumeration()` set | Registers a special enumeration filter (UCUM). |
| `executeFilters(ctx)` | *must override if filters supported* | Finalises filter setup and returns `FilterConceptSet[]` for iteration or membership testing. |
| `filterSize(ctx, set)` | *must override* | Returns the number of concepts in the filter set. |
| `filtersNotClosed(ctx)` | `false` | Return `true` if the filter set is open-ended (grammar-based system). |
| `filterMore(ctx, set)` | *must override* | Advances the iterator; returns `true` if there is a current concept. |
| `filterConcept(ctx, set)` | *must override* | Returns the current concept as a `CodeSystemProviderContext`. |
| `filterLocate(ctx, set, code)` | *must override* | Finds a specific code in the filter set. Returns a `CodeSystemProviderContext` if found, or an error string if not. |
| `filterCheck(ctx, set, concept)` | *must override* | Returns `true` if the concept is in the filter set, or an error string if not. |
| `filterFinish(ctx)` | no-op | Called when the filter session is complete; release any resources held. |

### Alternative: `handlesSelecting` / `processSelection`

For large code systems where a value set selects codes from only that system, the server can
hand the entire include/exclude list to the provider in one call rather than using the filter
workflow above.

Override `handlesSelecting()` to return `true` and then implement
`processSelection(params, includes, excludes, excludeInactive, offset, count)`.

- **When it is called.** `$expand` hands over a compose that selects from this code system
  alone (one system|version), imports no value sets, has no text filter and lists no concepts.
  Value sets that list concepts take the usual path (see `prefetchCodes` under Lookup).
- **Declining.** Return `null` for anything the provider doesn't support (an unknown filter,
  say). The compose then goes through the filter workflow above, as for any other provider.
- **Paging.** The provider applies `offset` (-1: none given, start at 0) and `count`
  (-1: none given, return all; 0: the total only). The sets it returns hold just that page,
  in expansion order.
- **Result.** `{ sets, total, notClosed }`: `sets` is a `FilterConceptSet[]` (in general one),
  iterated with `filterMore`/`filterConcept`; `total` is the size of the whole selection
  before paging, or -1 if the provider hasn't counted it (the expansion then has no total);
  `notClosed` marks an open-ended selection (a grammar-based code system).

The default `handlesSelecting()` returns `false`, so a provider that doesn't override it is
never asked.

---

## Lookup

Lookup supports the `$lookup` and `$validate-code` operations.

| Method | Description |
|---|---|
| `locate(code)` | Look up a code by string. Returns `{ context, message }`. If found, `context` is a `CodeSystemProviderContext` and `message` is `null`. If not found, `context` is `null` and `message` explains why. **Must override.** |
| `locateIsA(code)` | Look up a code within the scope of a parent concept. Required only if `hasParents()` returns `true`. |
| `extendLookup(ctxt, props, params)` | Called during `$lookup` to allow the provider to add extra properties to the response `Parameters`. The `props` array lists the property names requested by the client. |

The server calls `locate()` first to confirm the code exists, then uses the returned context
to call `display()`, `definition()`, `designations()`, `properties()`, `extensions()`, and
`extendLookup()` as needed to build the lookup response.

---

## Translations

Code systems that define implicit concept maps (for example, cross-version extension mappings)
can surface translations via the `$translate` operation.

These methods are on **`CodeSystemProvider`**:

| Method | Default | Description |
|---|---|---|
| `registerConceptMaps(list)` | no-op | Called at startup; the provider should add any implicit `ConceptMap` resources it owns to `list`. |
| `getTranslations(coding, target)` | `null` | Returns `CodeTranslation[]` mapping the given `coding` to the `target` system, or `null` if no translation is available. |

These methods are on **`CodeSystemFactoryProvider`**:

| Method | Default | Description |
|---|---|---|
| `findImplicitConceptMaps(conceptMaps, source, dest)` | `null` | Returns concept maps between `source` and `dest` that are implicitly defined by this code system. |
| `findImplicitConceptMap(url, version)` | `null` | Returns a single implicit concept map by URL and version. |

---

## Known Value Sets and Concept Maps

Code system providers may have built-in knowledge of value sets and concept maps that are
defined as part of the code system's specification (for example, the FHIR core code systems
ship with a number of defined value sets).

These methods are on **`CodeSystemFactoryProvider`**:

| Method | Default | Description |
|---|---|---|
| `buildKnownValueSet(url, version)` | `null` | If the factory knows of a value set at `url` (optionally at `version`), build and return it as a `ValueSet` resource. Return `null` if not known. |
| `registerSupplements()` | `[]` | Returns a list of `CodeSystem` supplement resources whose metadata is known to the factory. Content may be omitted; the server will call `fillOutSupplement()` if it needs the full content. |
| `fillOutSupplement(supplement)` | no-op | Called by the server when it needs the full content of a supplement that was registered with partial content. The factory should populate `supplement` in-place. |

---

## CodeSystemFactoryProvider

The factory is a long-lived singleton that the server registers at startup and holds in
memory for the lifetime of the server process. Its responsibilities are:

- Holding data loaded from disk or a database (call `load()` at startup).
- Creating per-request `CodeSystemProvider` instances via `build()`.
- Declaring implicit value sets, concept maps, and supplements.

### Required overrides

| Method | Description |
|---|---|
| `system()` | The canonical URI of the code system. |
| `name()` | A human-readable name including version information. |
| `version()` | The version of the code system data held by this factory. |
| `defaultVersion()` | The latest known version, used when no version is requested. |
| `id()` | A short identifier for this provider (used in logging and diagnostics). |
| `build(opContext, supplements)` | Construct and return a `CodeSystemProvider` bound to the given `OperationContext` and supplements. |

### Provided (with defaults)

| Method | Default | Description |
|---|---|---|
| `load()` | no-op | Called once at startup; load data from disk, database, or network here. |
| `nameBase()` | Delegates to `name()` | The name without version information. |
| `content()` | `'complete'` | The content mode of the code system (`complete`, `fragment`, etc.). |
| `getPartialVersion()` | Major.minor of `version()` if semver | A partial version string for flexible version matching. |
| `describeVersion(version)` | `'v' + version` | A display string for a version. |
| `useCount()` | — | The number of times `build()` has been called. |
| `recordUse()` | — | Increments the use count. |
| `iteratable()` | `false` | Return `true` if the code system supports iteration. |
| `codeLink(code)` | `undefined` | Return a URL linking to documentation for the given code, if available. |
| `close()` | no-op | Called at server shutdown; release database connections and other resources here. |