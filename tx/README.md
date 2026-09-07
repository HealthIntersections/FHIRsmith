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
      "internalLimit" : 10000,
      "externalLimit" : 1000,
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
| `expansionCacheSize`            | integer | No       | Maximum number of expanded ValueSets to cache. Default: 1000                                            |
| `expansionCacheMemoryThreshold` | integer | No       | Heap memory usage in MB that triggers evicting oldest half of expansion cache. 0 = disabled. Default: 0 |
| `librarySource`                 | string  | Yes      | Path to the YAML file that defines the terminology sources to load                                      |
| `publishLibrarySource`          | boolean | No       | Publish that YAML file at `/{path}/library`. Default: false                                             |
| `internalLimit`                 | integer | No       | Largest number of codes in internal expansions                                                          |
| `externalLimit`                 | integer | No       | Largest number of codes the server will return in an expansion                                          |
| `endpoints`                     | array   | Yes      | List of endpoint configurations (at least one required)                                                 |

### Endpoint Configuration

Each endpoint in the `endpoints` array has:

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `path` | string | Yes | The URL path where this endpoint will be mounted (e.g., `/tx/r4`) |
| `fhirVersion` | number | Yes | FHIR version: `3` (STU3), `4` (R4), `5` (R5), or `6` (R6) |
| `context` | string | No | Optional context string passed to the Library when creating Providers |

**Note:** Endpoint paths must be unique. The module will throw an error if duplicate paths are configured or if a path conflicts with another module.

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
type[!]:details
```

- **type**: The source type (see Source Types below)
- **!** (optional): Append to type to mark this source as the default for its code system. When multiple versions of the same code system are loaded, the default is used when no version is specified.
- **details**: Type-specific configuration (filename, package name, or internal provider name)

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
  - npm:hl7.terminology
  - npm:hl7.fhir.us.core
  - npm:us.nlm.vsac
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
