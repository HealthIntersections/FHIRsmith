# Changelog

All notable changes to Health Intersections FHIRsmith will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.18.2] - 2026-10-29

### Added

- IPS: national profiles - the profile on Bundle that a national IG defines for an IPS document: its jurisdiction (an ISO 3166 country code, or a UN M49 region), the IG's package id and version, and the profile's url. They are shared across all projects at `/ips/national-profiles`, where everyone can see them and only the administrator adds, edits and deletes them (also as JSON). A new processing step, after validation, validates each document against each national profile - loading the IG's package into the validator, once - and keeps the outcome and whether the document passed (no errors). The document's new National Profiles view lists them, and shows each one's validation as the Validation view does
- IPS: `modules.ips.validator.jar` - a validator jar of the module's own (a local build of org.hl7.fhir.core, say), used as it is, never downloaded or updated. Don't put such a jar at `bin/validator_cli.jar`: the wrapper takes that jar's version from the `.version` file it wrote when it downloaded the release, so a different jar there is started as if it were that release, and is replaced by the next one
- Registry: `GET /tx-reg/choose-server` - given the code systems a request involves and the client's default server, which one server to send it to, and a log of why. The same choice the Java tooling makes, for clients that aren't Java
- SNOMED CT ECL: member filters (`^ refset {{ M ... }}`) - `effectiveTime` (with a time value or set), `active`, `moduleId` (any sub expression) and the reference set's own fields (`targetComponentId = << X`, `mapTarget = "..."`, `mapGroup >= #2`, ...), comma-separated and repeatable. A member filter anywhere other than directly after a memberOf constraint is a syntax error (`INVALID_ECL`)
- SNOMED CT ECL: concept filters (`{{ C ... }}`) - `active`, `definitionStatus` (primitive/defined), `definitionStatusId`, `moduleId` (a concept, a bracketed concept list or any sub expression) and `effectiveTime`
- SNOMED CT ECL: description filters (`{{ D ... }}`) - `term` (match and `wild:` search terms, single or a set), `language`, `typeId` and `type` (syn/fsn/def), `dialectId` and `dialect` (en-us, en-gb and the other aliases in the ECL specification) with acceptability sets, `moduleId`, `effectiveTime`, `active` and `id`. The filters in one block apply to the same description; only active descriptions are considered unless `active` is given
- SNOMED CT ECL: history supplements (`{{ + HISTORY }}`, `HISTORY-MIN` / `-MOD` / `-MAX`, `HISTORY (*)`, `HISTORY (refset expression)`) - the inactive concepts that the selected historical association reference sets associate with the result are added to it
- SNOMED CT ECL: `AND` and `OR` between refinements - between attributes (`: A = x AND B = y`, `: A = x OR B = y`, with brackets for nesting), within an attribute group (`{ A = x OR B = y }`) and between groups (`{ ... } OR { ... }`). Mixing AND and OR without brackets is rejected, as it is for compound expressions. Previously only `,` (conjunction) was accepted
- SNOMED CT ECL: concrete values in refinements (`= #500`, `>= #1.5`, `!= #-1`, `= "text"`, `= true`). The importer now reads `sct2_RelationshipConcreteValues_*` into a new cache section (cache version 19, after 18's alternate identifiers); editions imported before this report a concrete-value refinement as unsupported. The test edition cache is now `sct_test_20250909e.cache`
- SNOMED CT ECL: `!=` in refinements (`: A != X` - at least one A whose value is not in X; `[0..0] A != X` - every A is in X), reversed attributes (`: R A = X` - the concepts that are the value of A on a concept in X), and `,` as a conjunction between expressions as well as between refinements
- SNOMED CT ECL: comments (`/* ... */`), top and bottom of set (`!!> (...)`, `!!< (...)`), and attribute names that are expressions rather than a single concept (`: << 762705008 = ...`, `: (A OR B) = ...`, `: ^ refset = ...`, `: * = ...`, and the same after `.` in dotted expressions)
- SNOMED CT ECL: alternate identifiers (`LOINC#14394-1`, `"LOINC#14394-1"`): the scheme alias names an identifier scheme (LOINC = 30051010000102 |LOINC code ID|, as imported from the LOINC Extension) and the code resolves to the concept(s) carrying it, which then take hierarchy operators like any set. An unknown scheme, or a code that no concept carries, is `INVALID_ECL`, as an unknown concept is
- SNOMED CT ECL: reference set field selection on member-of (`^ [targetComponentId] refset`) is parsed, and reported as `UNSUPPORTED_ECL` (the selected fields, and many of the referenced components, are descriptions) rather than as a syntax error

### Changed

- IPS: a clinical profile's page is the same for everyone. The required sections and entries are a table of Expectation, Section and Entry (`Code is system|code`, or `Code is in` a value set, with `[m..n]` when the cardinality isn't 1..1). The rules about resources are a table of Expectation, Resource Set (`Conditions where Code is ...`) and Rule, in words for `.exists()`, `.x.exists()` and `.x.y.exists()`, `.all(sameSubject())`, `.conformsTo(url)` and `.category.hasCoding(system, code)`. The administrator adds, edits and deletes the rules on that page one at a time, in a dialog, each saved by itself; the full editor is still there as Edit all
- IPS: `fhir-validator-wrapper` 1.6.1 (was 1.5.0) - it sends `/loadIG` the package in the request body (1.5.0 sent it in the query, which the validator ignored, so no national profile's package loaded), and starts validator 7.0.4 and later with `-txTests`, which the tx tests need
- Terminology server: code systems, value sets and concept maps that both hl7.terminology and an endpoint's FHIR core package provide. THO's is still always the default for the url, but the core versions are no longer dropped: a reference that names a core version (`url|5.0.0`) gets it, where THO doesn't have that version. Previously they weren't available at all, so a reference to one failed - including THO's own value sets that pin a core version (`ValueSet/concept-property-type` 6.0.1 includes `concept-property-type` 5.0.0) - and `valueSetVersion=5.0.0` found nothing
- Registry: the "Register your own server" and "Documentation" links on the main page come from the master registration file (`registration` and `ecosystem-documentation`), so each ecosystem has its own, and a link the file doesn't give is left out. They were hard-coded to the HL7 ecosystem's
- Tx tests: the `loinc` mode (the LOINC suite) is run

### Fixed

- VSAC: the cache folder `terminology-cache/vsac` is created if it doesn't exist. Only its parent was being created (the folder name was passed as if it were a file name), so on a fresh install the VSAC database could not be created (`SQLITE_CANTOPEN`) and every VSAC value set failed
- CodeSystem resources: the `notSelectable` property is recognised as the tx-ecosystem requirements say - by the `concept-properties#notSelectable` uri, whatever local code the code system gives it, and by the code `notSelectable` only where the code system doesn't declare that code with a different uri. A code system that used `notSelectable` for a property of its own had its concepts marked `abstract` in expansions and treated as not selectable (`notSelectable-unprop-all`, `notSelectable-unprop-true`). A filter on that code is still a filter on the code system's own property
- LOINC: `$lookup` returns `CLASS` as a string, the class name (e.g. `CHEM`), with the Part code for the class as `partCode`; it returned the Part code as a code
- SNOMED CT ECL: a hierarchy operator on a bracketed expression was silently dropped - `< (A OR B)` returned A and B themselves rather than their descendants. It now applies to every member of the set, as do operators on `*` and on `^ refset`, which were previously rejected as unsupported
- SNOMED CT ECL: `^` on a reference set whose members are descriptions (a language reference set) returned an empty expansion. It is now reported as `UNSUPPORTED_ECL` when the reference set is named, and skipped when it merely falls inside a computed operand such as `^ *`
- SNOMED CT ECL: an attribute name with no comparison (`: 363698007` with nothing after it) was accepted by the parser and failed later as unsupported; it is a syntax error
- SNOMED CT ECL: an evaluation error is now `UNSUPPORTED_ECL` unless it is about a concept that does not exist (`INVALID_ECL`). It was classified by matching the error text, which filed `= true` as a syntax error. A concept id that is not 6-18 digits is rejected by the parser
- IPS: the pages link the module's browser scripts with their version (`?v=`), so a browser picks up a changed script as soon as the server is restarted with it, instead of using its cached copy for up to an hour

### Tx Conformance Statement

FHIRsmith v0.18.2 passed all 4565 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed+mimetypes+icd-11+icf+closure+loinc, tests v1.10.1-snapshot, runner v7.0.3)

## [0.18.1] - 2026-10-25


### Added

- ICF (`http://hl7.org/fhir/sid/icf`): qualified codes now cover environmental factors (`e`) - a barrier after `.`, or a facilitator after `+` in place of the `.` (no `+9`), on the new `q5` (barrier) and `q6` (facilitator) scales. As a whole: A category may be followed by `.` and one qualifier digit per position, the positions depending on the component: extent for body functions (`b`); extent, nature and localization for body structures (`s`); performance, capacity, and optionally capacity with assistance and performance without assistance for activities and participation (`d`); one for environmental factors (`e`), a barrier after `.` or a facilitator after `+` in place of the `.`. Each digit is checked against its scale in the code system (`q1`-`q6`, added to the ICF code systems in fhir.tx.support with a `kind` property). A qualified code gets a generated display (8, not specified, is left out of it; `d` qualifiers are labelled `performance`, `capacity`, ...), its qualifiers as properties in `$lookup` (`extent`, `nature`, `localization`, `performance`, `capacity`, `capacity-with-assistance`, `performance-without-assistance`, `barrier`, `facilitator`), and sits under its category for subsumption and `is-a` filters. Value sets can control qualifiers with an `exists` `true`/`false` filter on any of those properties (8 counts as absent) and `qualified` `=` `false`. ICF is now marked as not closed. The behaviour is in `tx/cs/cs-icf.js`, a subclass of the CodeSystem provider that `FhirCodeSystemProvider.create()` picks by url - the way to give any code system loaded from a package behaviour of its own
- SNOMED CT alternate identifiers (`sct2_Identifier`, e.g. the LOINC Extension's LOINC codes): the importer reads them into the cache (cache format 18, written only when there are identifiers, so other caches stay 17). `$lookup` returns them as Coding properties named for the scheme (`loinc` = `http://loinc.org#...`), by default and when asked for. `$expand`: the filter `mapped:<scheme>` `exists` `true`/`false` (e.g. `mapped:30051010000102`) for concepts that do or don't have one. `$translate`: each module with identifiers defines an implicit map `<edition>/version/<date>?fhir_cm=<module>` (e.g. `?fhir_cm=11010000107`), `equivalent` in both directions, nominated by url or found from the systems (`targetSystem` `http://loinc.org` from a SNOMED CT coding, or `http://snomed.info/sct|<edition>` from a LOINC one)
- SNOMED CT test edition: a subset of the LOINC Extension (LOINC ontology, module `11010000107`) - twelve LOINC-coded concepts with their LOINC identifiers (`sct2_Identifier`), plus the module and identifier scheme concepts - generated from the LOINC Extension release by `utilities/make-sct-loinc-subset.js`. The test cache is now `sct_test_20250909d.cache` (2280 concepts)
- LOINC importer: mappings from LOINC codes, parts and answers to other code systems, in two new tables - `ExternalCodes` (system, version, code, display; one row per target) and `ExternalMappings` (LOINC code to target, with an equivalence). Read from `PartFile/PartRelatedCodeMapping.csv` (the file's own equivalence; the RadLex rows are left out for now), `LoincIeeeMedicalDeviceCodeMappingTable` (MDC, `urn:iso:std:iso:11073:10101`, the CF_CODE10 as the code and the REFID as display; IEEE's `broader`/`narrower` are from the LOINC side, so they become `narrower`/`wider`) and the `ExtCode*` columns of `AnswerList.csv` (`equivalent`; LOINC's `CMS/HCPCS` and `https://www.cdc.gov/phin` systems become `http://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets` and `urn:oid:2.16.840.1.113883.6.238`). Both mapping files are optional. LOINC caches need rebuilding to get them; nothing uses them yet
- LOINC: the mappings to other code systems are used. `$lookup` returns them as Coding properties named for the map (`sct`, `chebi`, `mdc`, `race`...), with the equivalence as a subproperty, by default and when asked for. `$translate`: each target system has an implicit map `http://loinc.org/cm/<name>` - `loinc`, `ncbi` (PubChem), `sct`, `hcpcs`, `gene-names`, `rxnorm`, `chebi`, `ncbi-clinvar`, `ncbi-gene`, `ncbi-taxo`, `mdc`, `race` - that works in both directions (LOINC to the system, and the system to LOINC), found from the target system or nominated by url. Found from the systems, a map is only offered for a code it has a mapping for, so translations that a SNOMED CT edition answers (the LOINC Extension) are unchanged. Targets in other systems (`CMS LCDS`, `Unicode`) are not used yet. Code system providers' `findImplicitConceptMaps` now also gets the code being translated
- `$closure`: `dispose` - a request with `name` and `dispose` = `true` says the client has finished with the closure table, and the server deletes it (not in the specification; disposing of a table that doesn't exist is fine - it may already have been pruned). It can't be combined with concepts, a version, `reset` or configuration (`CLOSURE_DISPOSE_NOT_ALONE`, 400). Documented in the OpenAPI

### Changed

- Global language packs: the `codesystem-supplement-type` code is now `global-lang-pack` (`lang-pack` is still accepted)
- `$lookup` on SNOMED CT: when the request names properties, only those are returned - effectiveTime, module, parent, child and the defining relationships are no longer added regardless
- Daily report: the title is now "{server} daily report for {date} covering the last {24 hours | n days}", and the summary is one line per item - `Versions:` (FHIRsmith and Node), `Uptime:` (this run, and the percentage over all recorded runs), `Space:` (the log files and the disk) and `Audit:`
- Tx test generator (`tx/tests/testcases-generator.js`): disabled suites and tests are left out, and `version` gates (including negated ones, `!4.0`) and `modes` lists are read as the Java runner reads them, so tests gated `!4.0` now run at R5. The rules are in `tx/tests/test-case-gates.js`

### Fixed

- Implicit ConceptMaps nominated by url are looked for in every version of a code system, not just the first loaded (a SNOMED CT edition's maps are named by its edition URI)
- LOINC importer (and subsetter): CSV files are read by record, not by line, so a quoted field with a line break in it is one record. LOINC 2.83's `ComponentHierarchyBySystem.csv` has one (the text of `LP409416-7`), and the import failed with `UNIQUE constraint failed: Config.ConfigKey` - the second half of the record looked like a second root
- `$expand`: a supplement that only supplied the chosen display or a designation - a global language pack, typically - was never reported as a `used-supplement`. Designations from a supplement carry it as `.supplement`, but the reporting looked for `.source`, which is never set
- `CodeSystem/$validate-code` with `useSupplement`: the supplement was always reported as missing (`VALUESET_SUPPLEMENT_MISSING`, 422), even when it was passed in `tx-resource`, because the supplements were only checked off while preparing a value set, and validating against a code system doesn't prepare one
- `$lookup` on a CodeSystem resource: a property asked for by its own code (`property=prop`) was not returned - only `property=property`, `*` or no `property` parameter returned the code system's properties. A property the server doesn't know is still ignored

### Tx Conformance Statement

FHIRsmith v0.18.1 passed all 4337 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed+mimetypes+icd-11+icf+closure, tests v1.10.0, runner v7.0.3)

## [0.18.0] - 2026-10-23

A big release: a new IPS module (prototype), a secured and documented registry with uptime reporting, a syndication feed for the terminology server, a daily email report, ICF qualified codes, SNOMED CT edition to edition translation and much more ECL, and the ICD-11 representation agreed at the October 2026 test-case review meetings. Plus the outcome of security reviews of the registry, IPS and token modules. The README now says what state each module is in.

Note: We are heading towards a 1.0.0 release.

- **Upgrading** - check these before deploying:
  - ICD-11 (MMS and ICF): the code is now the bare entity id, not the short code (see Changed). Clients that send or store short codes still work, but get `CODE_NOT_IN_NORMAL_FORM`; full entity URIs as codes are no longer accepted
  - Token: the JSON API key moves from the URL path to a header (see Security)
  - LOINC: `exists` filters now mean what they say, so value sets that relied on the old behaviour expand differently (see Fixed)
  - VSAC: the default base URL is now https; a configured http `baseUrl` is logged as a warning
  - The SNOMED CT test edition cache is now `sct_test_20250909c` (extension concepts added in module TEST1000003) and needs rebuilding for the tx tests

### Security

- Page templates (`library/html-server.js`, every module): placeholders are now substituted in one pass, so a `[%...%]` in a page's content (a submitted IPS narrative, say) stays as it is. Before, `[%context-link%]`, `[%about%]` and the like inside content were replaced with their raw HTML, which inside an attribute let a stranger's narrative become a live element (stored XSS)
- IPS: the generated narrative escapes dosage timing values (`frequency`, `period` and their maxima) that a document puts where numbers belong, and generated narrative is checked for active content before it is stored or shown
- IPS: a project's stored AI key is dropped when the provider or base URL changes, so it can't be sent to a host other than the one it was given for. The terminology check no longer sends a coding's display to `$validate-code`: answers are cached by code, so one document with a wrong display could decide the answer for every document after it. Delete confirmations are an escaped attribute, not inline script with a name in it. `setPath`/`getPath` refuse paths that would reach a prototype. Document submissions are read by the module itself (the server's body parsers leave `/ips` alone): the submission token is checked before the body is read, and the body is read no bigger than `maxSize`
- Registry: markdown documents are rendered without raw HTML (commonmark's safe mode), and a past version of a document keeps the visibility it had then, so a version from when it was private stays private after the document is made public. `/resolve` no longer answers a page request with JSON when the page fails to render. JWTs without `exp` are refused. Changing or removing a user's password ends the user's other sessions. The failed-authentication limit checks the token first, so a valid token is never held back
- VSAC: the default base URL is now `https://cts.nlm.nih.gov/fhir`. It was http, and VSAC only redirects to https after the request (which carries the API key) has been sent. A configured `baseUrl` that is http is logged as a warning
- VSAC: a search bundle's `next` link is only followed on the VSAC server (the same host, under `baseUrl`), and always over `baseUrl`'s scheme, so a link can't send the API key elsewhere or over http
- Token: the JSON API takes the API key in a header - `Authorization: Bearer {key}` or `X-API-Key: {key}` - instead of the URL path (`/token/api/validate`, `/token/api/usage`, `/token/api/stats`), so keys don't end up in access logs. The usage statistics no longer include the IP address of the last request, and the key list's delete button no longer puts the key's name into an inline script
- Narrative check (`library/narrative-check.js`): the regex that stripped CSS comments from a `style` attribute was quadratic in the attribute's length - a few hundred KB of `/* ` held the event loop for seconds, and a resource with such a narrative could be sent to any module that checks narratives. Comments are now stripped in one pass
- IPS: narratives are shown as parsed, never as the string submitted, so an unterminated tag at the end of one narrative can't swallow the start of the next on the page and turn its text into attributes of a live element (the active-content check parses each narrative on its own, so it didn't see this). Reference resolution within a document is indexed rather than scanned (a document with tens of thousands of entries took a minute of CPU per page view); index rows per search parameter, sort keys per search, the JSON a search page carries, the terminology-server questions per document and the remembered answers are all bounded; an in-process terminology request has a timeout; error responses and the public document pages no longer carry internal detail (the reason a document's processing failed is shown to its project's managers); the submission form no longer gives every visitor a session; an unknown login takes as long as a known one; verdicts in a submitted document's own extensions are never shown as analysis

### Added

- Terminology server: a syndication feed (`modules.tx.syndication.enabled`, off by default) - the content the library loads, published at `{endpoint}/syndication` as a [Terminology Syndication Feed](https://build.fhir.org/ig/FHIR/fhir-syndication-ig/en/) (Atom, NCTS ASF profile) for Ontoserver, other FHIRsmith servers and people. As the library loads, each source is recorded in a store in `terminology-cache/syndication`, from the time syndication is turned on: npm, url and core packages (linked at npm.fhir.org, `FHIR_Package`), the versioned resources in file and folder sources (copied into the store), and the binaries (SNOMED caches, LOINC databases etc, linked at `base.url`, in a FHIRsmith category scheme, with `<rights>`) that are published there - not internal sources, OCL, `#current` packages or the full CPT database. Every link has a SHA-256. The store only grows: no retracts, and a later update to the same content is a new entry (so `contentItemVersion` is not unique, deliberately). The feed is paged as RFC 5005 archived feeds of 30 entries; a browser gets it as a page, and the tx pages have a Syndication nav item and feed autodiscovery link
- Registry: the software page shows one row per server rather than one per endpoint - the endpoints of a server (its FHIR versions) that run the same software and version are collapsed under their common base URL, with the FHIR versions listed and any unreachable endpoint named. Endpoints running different software keep their own rows
- Registry: the API can be secured (`modules.registry.security`), in any combination of three ways: a single `apiToken` every client sends; `users` the administrator manages on `/tx-reg/admin/users`, each with their own tokens (256 random bits, stored as a SHA-256 hash, shown once, labelled, optionally expiring, revocable; usage counted per token) and optionally a password to manage their own tokens on `/tx-reg/account`; and `oidc`, JWTs from an OpenID Connect provider verified against its published keys for issuer, audience, expiry and a required scope or role. Only the JSON API is closed - the HTML pages, the OpenAPI description and the login page stay open - and a request without a valid token gets 401 with `WWW-Authenticate: Bearer`. Failed authentications are limited per address (`security.failedAuthPerWindow`, default 60 in 15 minutes, then 429; successful requests aren't counted). Tokens are sent as `Authorization: Bearer {token}` or `Api-Key: {token}`, the headers the HL7 Java tooling already sends for a server in fhir-settings.json. Without `security` the registry is open, as before. New dependency: `jose`
- Registry: documents (`/tx-reg/docs`, when `security.users` is configured) - markdown or JSON documents the registry stores and serves, each with a name (its address), a type, whether it is public, and when and by whom it was last edited. Public documents are readable by anyone, the others by any logged in user (a browser session, never an API token); administrators create, edit, rename and delete them in a plain text editor. A browser gets the document rendered (markdown as written, raw HTML included - the authors are the administrators; JSON pretty-printed), anything else the raw file with its media type. Every change is logged with the full content, and the history page shows each past version
- Registry: users can be administrators (a flag the administrator sets): an administrator user manages users and documents as the configured administrator does, and keeps its own account page
- Registry: uptime. Each scan records whether every endpoint answered (`[data]/registry/registry-uptime.json`, kept for `uptimeRetentionDays`, default 90), and the software page reports each server's uptime over the last `uptimeWindowDays` (default 30) as the share of its endpoint probes that answered. Scans the registry itself missed count against no one
- IPS module (`/ips`): collections ("projects") of International Patient Summary documents, each with its own FHIR endpoint (`POST`/`GET {project}/Bundle`, `Bundle/{id}`, `metadata`) and web pages - a filterable list, the document's assembled narrative, and a submission form. The administrator (login in the configuration) creates projects and users and assigns managers; managers set a project's submission token and delete documents. Searches support Bundle's parameters and chain to the Composition's and Patient's (`composition.date`, `composition.patient.name`, ...), indexed with fhirpath.js. A document's page has narrative, terminology (every CodeableConcept, with code systems linked to the configured terminology server or, for SNOMED CT, LOINC etc., to their browsers), validation and JSON views. Received documents are queued for a background processing pipeline, of which six steps exist: translation of every CodeableConcept that fails the terminology check, by `ConceptMap/$translate` into the element's value set, the matches added as codings (in the analysed copy) with an extension saying which server, concept map and relationship they came from; generation of the document's narrative with an IPS presenter (the Composition's header and patient, then the sections in the IPS order, each a table of its entries with the columns that suit the resource type and the nested parts as bullets beneath, coded values looked up on the terminology server when they have no display), written into the analysed copy; validation with the FHIR validator (as the shl module runs it) against the IPS Bundle profile, the outcome kept with the document; a terminology check of every CodeableConcept for international exchange: against the module's own value sets for its element (`ips/valuesets/`, on SNOMED CT International, LOINC, EDQM routes and HL7 codes), falling back to any SNOMED CT International, LOINC or HL7 code, by `$validate-code` on the configured terminology server, the verdicts written as extensions into a second, analysed copy of the document and shown in the terminology view; a check against each clinical profile (whether the document conforms, and the constraints it doesn't meet, shown in a Clinical Profiles view); and, when a project turns it on, an AI assessment of the document's consistency, completeness and terminology by an OpenAI-compatible or Anthropic service (the project's own account, its key encrypted at rest, or the server's default; capped per project per day). A document can be shared as a QR code - a SMART Health Link, or a Verifiable Health Link signed as the GDHCN does it - through the shl module (`modules.ips.shl`). An editor (`/ips/{code}/compose`) composes a document in the browser - the patient and header, then each IPS section as entries with code lookups, a narrative, or a reason it is empty - and submits it to the project or hands it back; an existing document can be opened in it. Two FHIRPath functions for IPS documents, `section(system, code [, min, max])` and `entry(system, code [, min, max])`, find sections (nested too) and their resolved entries by code, within cardinality bounds, and `resources(system, code [, type])` finds the document's resources with a code, with `entryIn()` and `resourcesIn()` doing the same by value set, asking the terminology server as they go, with each answer cached (`ips/fhirpath-ips.js`, `ips/membership.js`). Clinical profiles (`/ips/StructureDefinition`), across all projects: what a kind of clinical document is expected to contain, as a profile on Bundle (the document) whose root element's constraints are the expectations - edited in three parts: required sections and entries (a section that must be there, or a section with entries with a code, or a code in a value set) and rules about resources (`Bundle.resources(system, code, type)` and the rest of the rule), each as a table with code lookups, and other rules as FHIRPath; the administrator makes, edits, downloads and uploads them (an upload gets a new id and url, and anything more than such a profile is rejected), and everyone can see them. See `ips/readme.md`
- Daily report: a markdown report on the server, emailed at midnight (local time) - or as soon as the server is up again if it was down then - to `dailyReport.to`, titled "{hostName} daily report". A paragraph on the server's stability since the last report (uptime, restarts, the longest outage, any upgrade - from the run history in the statistics database, which now records each run's version), a paragraph from each running module that has one (a module implements `dailyReport({since, now})` to take part; by default none do), a paragraph on the system (version, Node.js and OS, how long this run has been up, the log files and the free disk space, and anything the npm audit found - vulnerable packages and the upgrade advice, or a newer release), and, when any background task's last run failed, a list of them. Nothing is sent without the new top-level `email` block (SMTP: `host`, `port`, `user`, `password`, `from`), which is the server's outbound email for anything else that needs it (`library/mailer.js`). New dependency: `nodemailer`. The terminology server, registry, packages, xig, testing, shl, ips and publisher modules each report (see the README for what); the counts come from the statistics database, which now answers per-operation counts over a period (`stats.countsSince`)
- Home page and dashboard: the uptime box now also reports the server's overall uptime - `Uptime: 38m 16s (99.3% overall)` - the proportion of the time since the first recorded run that the server has been running. Each run is recorded in the statistics database (`server_runs` in `stats.db`) with a heartbeat every minute, so a crash loses at most a minute. Not shown when statistics are turned off
- `library/fhir-search-values.js`: the date range, prefix and comma-splitting parts of FHIR search, moved out of the testing module for sharing
- `library/package-manager.js`: a cached package folder with no `package/package.json` (a download that failed after the folder was made) is fetched again instead of being used
- `$translate`: SNOMED CT edition to edition translation with no map - from an edition to one it depends on (per the module dependency reference set), using the implicit map `<edition>/version/<date>?fhir_cm=edition/<target module>` (the url agreed with the SNOMED committee), found from `targetSystem` or nominated by url. A concept in the target edition's modules is its own translation; an inactive concept translates through its historical associations; a fully defined extension concept translates to its normal form (or the target concept with that normal form), when that uses only target edition content; anything else translates to its proximal target-edition ancestors as `source-is-narrower-than-target`, unless those are only top-level hierarchies, which is reported as the reason there is no translation. The source concept in a match carries its version, as given
- `$translate`: when the target code a map directs to is not in its code system's normal form, the match has a `normalized-concept`. A source code that has a normal form is looked up both as given and in its normal form (a map entry written in the normal form matches any code with that normal form; the map's own entries are not normalised). A target in a code system the server doesn't know gets a `note` saying it was not validated, and a target code that is not valid gives an `error`
- `$lookup`: a warning when the `displayLanguage` asked for has no display for the code, and the display is in the default language (`LOOKUP_DISPLAY_LANGUAGE_FALLBACK`)
- ICD-11: the `classificationCode` extension (provisional url `http://id.who.int/icd/schema/extension/classificationCode`) on a Coding carries the short code for an entity id, saving a lookup. When present it is checked in `$validate-code` (CodeSystem and ValueSet): a wrong value, or the extension on a code with no short code, on a short code, or on a system other than MMS, is an error
- ICD-11 `$lookup`: postcoordination is reported as one `postcoordination` property per axis (subproperties `axis` and `value` Codings, a `/` member's value with its own nested postcoordination), replacing the WHO `postcoordinationScale` shape. With the new parameter `post-coordination-metadata=true` every declared axis is listed with `required`, `allowMultipleValues` and its value set; otherwise only the valued axes. `source` (the Foundation entity) is a Coding, and asking for `source.details` adds what a `$lookup` on it would return, designations included. A single-valued axis with several values gets a message in `$validate-code`
- SNOMED CT: `tx/sct/documentation.md` - what the server supports for SNOMED CT: editions, ECL, expressions and the MRCM, implicit concept maps and translation
- `utilities/make-sct-test-extension.js`: builds the extension concepts (module TEST1000003) in the SNOMED CT test edition used by the tx tests - one of each shape (fully defined ungrouped, fully defined role-grouped, equivalent to an International concept, primitive), plus inactive ones with and without historical associations
- README: each module's status - in production; in production but still under development; under development / prototyping; or on the back-burner

### Changed

- SNOMED CT expressions: validation now follows the MRCM the way Ontoserver does (from a comparison over every post-coordinated expression in the published FHIR packages). An attribute must be a concept model attribute (a descendant of 410662002) - linkage concepts such as 20401003 |With| and 280452008 |Interpretation| were allowed before - and an attribute the MRCM attribute domain reference set says nothing about (|Has definitional manifestation|, |Subject of information|, ...) is rejected rather than left unchecked. An attribute the MRCM marks as grouped that is written ungrouped (`40468003:363698007=10200004`) is now accepted and put in a relationship group of its own (the "self-grouped attribute" transformation from Close To User Form to Classifiable Form), as Ontoserver and Snowstorm do; it was rejected. The grouped form is what is rendered and used for the normal form
- ICD-11 (MMS and ICF): following the October 2026 test-case review meetings, the code is the bare entity id (`257068234`; the full uri is the system url + `/` + the id), and that is the normal form. The short code (`1A00`) is still accepted, with `CODE_NOT_IN_NORMAL_FORM` and the normalized code; the full uri is no longer accepted as a code. The short code is reported as `classificationCode`: a `$lookup` property (the old `code` property; the old `id` property is now `code`), a property on every `$expand` contains entry, and a `$validate-code` output when the request used the id. Parent, child, stem and postcoordination value references are all entity ids, and postcoordinated expressions are written without spaces. The Foundation is unchanged
- `$lookup`: `name` is the code system's title, translated where possible, falling back to `CodeSystem.name` (a new `lookupName()` on code system providers, so other operations are unaffected). SNOMED CT gives the edition (`SNOMED CT International Edition`), LOINC, UCUM and OMOP their titles; OMOP's `name()` is now `OMOP_Concepts`
- `$lookup`: a code that is not selectable always returns `abstract` (true) and the `notSelectable` property (true), whatever properties were asked for; a selectable code returns neither unless asked (as agreed for the tx-ecosystem tests)
- Dependencies: new `jose`, `nodemailer` and `qrcode-generator`; `fhir-validator-wrapper` 1.4.0 to 1.5.0
- tx.fhir.org configuration: the Swiss and Danish SNOMED CT editions are no longer loaded, and `hl7.fhir.uv.ips` is

### Fixed

- IPS: two runs of the processing queue could overlap at start-up while the terminology server was being looked for, and a run could start before it had answered; the queue now claims itself before it waits, and any answer but a CapabilityStatement (a 5xx while the tx module loads, say) counts as "not there yet". Requeueing a document while it is being processed is refused (it lost the requeue and the results), and a pipeline only finishes a document that is still being processed. A clinical profile rule over a value set the terminology server couldn't answer for is "could not be checked" whatever it evaluates to, and a profile deleted while a document is checked is passed over. The migration of profiles from Composition to Bundle rewrites every `Composition.` in a rule, not just a leading one. FHIRPath string escapes (`\uXXXX`, `\f`, ...) are read in the profile editor's shapes. A display lookup the server couldn't answer isn't cached. The editor refuses two fields for one `value[x]`, reads each `value[x]` field back from its own type, and keeps paragraphs on a round trip. A huge `_offset` is a 400, not a 500
- Registry: sessions are kept in the auth database (logins survive a restart), and pages a visitor only reads start no session. Documents up to the 2 MB limit can be saved (the form parser stopped at 64 KB). An endpoint missing from one crawl (a sub-registry that failed to fetch, a crawl cut short at shutdown) keeps its uptime history; history only ages out, and a scan cut short isn't recorded as a failure. Usage counts survive a failed write. The main pages' navigation shows who is logged in
- Server: SIGTERM (systemd, docker stop) shuts the server down as SIGINT does, so modules save what they hold
- ValueSet `$validate-code`: an include with more than one filter only checked the first. The other filters' checks return a message when the code fails them, and a message was taken as a pass
- LOINC: the `exists` filter ignored its value. On a relationship property (`METHOD_TYP`, `COMPONENT`, `document-kind`, ...) the value was looked up as a code or display, so `exists true` and `exists false` both returned every code with the relationship (because a code displayed as "True" and one as "False" exist), and on a property (`CLASSTYPE`, `ORDER_OBS`, ...) `exists false` meant `exists true`. `true` now returns the codes that have the property, `false` every other code in the code system - Parts, AnswerLists and Answers included, so add `CLASSTYPE exists true` to restrict to LOINC terms (e.g. LOINC terms with no method: `METHOD_TYP exists false` + `CLASSTYPE exists true`). Any other value is not supported
- Packages: a package download or page request was counted twice in the statistics (once by the validation step, once by the handler), and tarball downloads were not told from requests for a version's JSON document; downloads are now counted as `download`, version documents as `version`, each once
- SNOMED CT expressions: the MRCM content type taken as "postcoordinated" was 723594008, which is *all precoordinated content* (postcoordinated is 723595009). So the body-structure part-of attributes (|Regional part of| etc., precoordinated only) were allowed in expressions, |Has ingredient| (postcoordinated only) was not checked, and for the attributes with a precoordinated-specific range that range was used in place of the general one

- SHL: every access to a live link (`/shl/access/{uuid}`) hung without a response - the access-logging callback was a plain `function`, so `this.db` was undefined in it and the request was never answered (since 0.3.0). A `GET` on a link is now the U flag (direct file) access the SMART Health Links spec defines: a link with one file returns it as a JWE (`application/jose`), and `recipient` is read from the query and logged (it was always `anonymous`); a link with more than one file, or a VHL, still gets the manifest / VHL bundle. The manifest now has `status` (`finalized`), file `location`s are always https (they followed `req.secure`, so http behind a proxy without trust proxy), and `embedded` is the JWE itself (it was the base64 of it, as stored)
- IPS: a VHL share no longer puts the U flag in its link payload - a VHL's link answers with the VHL bundle, not the file

### Tx Conformance Statement

FHIRsmith v0.18.0 passed all 3860 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed+mimetypes+icd-11+icf+closure, tests v1.9.6, runner v7.0.3)

## [0.17.0] - 2026-10-17

An extensive security review, which hardened many things, but no actual securty notifications needed. Plus improvemnts to text search in terminology filters

### Security

- HTML pages (all modules using the shared page template): content containing `` $` `` or `$'` - which HTML escaping leaves alone - made the template insert a copy of part of itself into the page, garbling it. No way to inject script through it was found, but the page is now built without that substitution
- Packages: a tarball whose package.json version was not entirely semver (e.g. `1.0.0/../../x`) was accepted, and its mirror file written outside the mirror folder. The version must now be whole semver, and the mirror file must be in the mirror folder
- Rendered resources: links to `javascript:`, `data:` or `vbscript:` URLs taken from resource content are neutralised
- tx: values from loaded packages are escaped (and URL-encoded in links) on the problems page, the resource tabs, and the operations form's list of value sets
- tx: CodeSystems, ValueSets and ConceptMaps whose narrative (or a contained resource's) has active content - script, event handler attributes, `javascript:` URLs, frames, objects, forms, svg and the like - are not loaded, and a warning says what was found. The Original Narrative tab also refuses such a narrative. The check is in `library/narrative-check.js` for other uses. The package value set and concept map caches are renamed so that they are rebuilt and re-checked once
- xig: the database is downloaded over https (it was http, so it could theoretically have been replaced in transit, and its narratives are shown as they are), and a redirect off https is refused
- Extension tracker: the profiles page put the resource types from submissions into a script without escaping, so anyone could submit data that ran script on that page. They are now escaped
- Extension tracker: submissions must carry the token the IG Publisher sends (`token` in the ext-tracker config; without it, no token is needed), and must look like what the IG Publisher sends - the expected properties only, codes, URLs, resource types and element paths where those belong, and limited sizes. Anything else is refused, and the refusal logged
- Registry: server and registry URLs from registry lists (which other people host) were put into links without escaping, so a listed URL could add script to the registry's pages; and links were made from any URL, including `javascript:`. Links are now escaped, and made only from http(s) URLs
- Registry: the crawler limits each server's response to `maxResponseMB` (default 100) once unzipped, so a server can't exhaust the registry's memory
- xig: POST /xig/update, which re-downloads the database (about 3 GB), needed no authentication. It now needs the `updateToken` from the xig config in an `x-update-token` header (or the form now on /xig/stats, which starts an update and returns straight away), and is disabled when no updateToken is configured
- xig: a search parameter given more than once, or a very long one, is handled (the first is used, and each is capped at 200 characters) instead of failing the page
- OCL: the configured token can see the private repos of its account, and what it finds is served to anyone through the terminology server. Sources and collections are now served only when they are public (`public_access` View or Edit), whether they are found by discovery or by `$resolveReference`; anything that can't be confirmed public is left out. The token's account should still be one that can see only public repos
- OCL: a repo path returned by OCL is only used if it is a relative path on the OCL server, so a request carrying the token can't be sent to another host
- Packages: the crawler limits what a package can cost it: the download (`maxDownloadMB`, default 250), the total unzipped (`maxUnpackedMB`, 4096), the files it reads (`maxFileMB`, 50) and the number of files (`maxFiles`, 250000), all in the packages `crawler` config. Packages are now unpacked as a stream, keeping only package.json, .index.json, ig.ini and one .json file at a time, so a decompression bomb can't exhaust memory

### Added

- `TerminologyCapabilities.expansion.textFilter` describes how text filters match
- OCL: with a `token=` on the `ocl:` source line, canonical URLs are resolved through OCL's `$resolveReference` (ConceptMap source systems, ValueSet collections and their compose sources), rather than by searching the listings. Without a token nothing changes
- OCL: a source's latest released version is served as its default version, as OCL itself does; HEAD is still available as version `HEAD` (needs the token)
- README: what to do after upgrading Node.js (`npm rebuild`, or reinstall)

### Changed

- Text filters on code systems loaded from files and packages ignore case, and accents on Latin, Greek and Cyrillic letters (`colera` finds `Cólera`), and a search of several words matches when each word starts a word of the display or of one designation, in any order (`diabetes tipo 2` finds `Diabetes mellitus tipo 2`). These matches rank below matches of the whole text, shorter displays first.
- `$expand` with a text filter returns the best matches first on code systems loaded from files and packages, and on OCL code systems, as it already did on SNOMED CT
- OCL: sources and collections are discovered from the global `/sources/` and `/collections/` listings (falling back to each organisation's), and only organisation-owned ones are served - repos owned by a user are not
- OCL: a source's mappings are fetched from `{source}/mappings/` instead of walking every concept

### Fixed

- LOINC: text filter matches came in reverse description order (Z to A) when the expansion asked for them sorted. They now come in description order either way
- LOINC: an `is-a` filter left out the concept itself, so it gave the same codes as `descendent-of`. It now includes the concept, as FHIR defines `is-a`
- OCL: `$translate` never returned anything from OCL concept maps. The maps declared OCL repo paths as their source and target scopes, which aren't value sets, so every translation failed with not-found; and `NARROWER-THAN` / `BROADER-THAN` mappings had relationship codes that aren't FHIR codes. The scopes are gone, the map types become `source-is-narrower-than-target` / `source-is-broader-than-target` (and `NOT-SAME-AS` becomes `not-related-to`), and `Q-AND-A` and `CONCEPT-SET` mappings, which aren't translations, are left out
- tx: a package value set or concept map cache whose build was cut short (the server stopped part way through) was used as it was, missing whatever hadn't been written. A cache is now marked complete when it's built, and one without the mark is rebuilt - so existing caches are rebuilt once, on the first start of this version

### Tx Conformance Statement

FHIRsmith v0.17.0 passed all 3630 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed+mimetypes+icd-11+closure, tests v1.9.6, runner v7.0.2)

## [0.16.1] - 2026-10-16

### Added

- The dashboard always says which FHIRsmith release the server runs, and whether a newer one is available (looked up once a day with the npm audit check; before, the latest release was only looked up, and only mentioned, when the audit found something)
- README: how to follow releases (GitHub release emails, the releases Atom feed, and the dashboard)

### Fixed

- Packages: SUSHI (and anything else using fhir-package-loader) couldn't download packages from this server: `GET /packages/{id}/{version}` returned the version's JSON document instead of the tarball (since 0.16.0). The rule was "JSON when Accept includes `application/json`", but fhir-package-loader downloads with axios's default `Accept: application/json, text/plain, */*`, and plenty of other HTTP clients send JSON alongside `*/*` by default without wanting it. The version document is now returned only when the request prefers JSON: a JSON type ranked above any `*/*`, `application/*` or tarball type by q-value (`application/json` alone, or `application/json, */*;q=0.1`). Everything else gets the tarball, and `FHIR-Package-Download` still forces it
- A POST with no Content-Type now says so (it gave "Unsupported Media Type: " with nothing after it)
- A form post whose Content-Type has a charset (`application/x-www-form-urlencoded; charset=UTF-8`) was refused as an unsupported media type
- Links in published IGs to a resource by the id it had in its source (`ValueSet/2.16.840.1.113762.1.4.1`, from before ids were prefixed, as in `ValueSet/vsac-2.16.840.1.113762.1.4.1`) work again in a browser: a read of an id nothing has redirects to the one resource that had that id in its source, or lists them when there are several. Other requests still get a 404

### Tx Conformance Statement

FHIRsmith v0.16.1 passed all 3630 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed+mimetypes+icd-11+closure, tests v1.9.6, runner v7.0.2)

## [0.16.0] - 2026-10-15

### Security
- 
- Token: the login session store is now FHIRsmith's own (`library/sqlite-session-store.js`), in place of connect-sqlite3. connect-sqlite3 depends on sqlite3 5, which brought node-gyp 8, tar 6 and @tootallnate/once into every npm install of FHIRsmith (12 advisories, one critical). The `overrides` in package.json kept them out of a clone + `npm ci` (and so out of the Docker image and the repo's own `npm audit`), but npm ignores overrides when installing the published package, so `npm install -g fhirsmith` still got them. Sessions are kept in the same `sessions` table of the token database, in the same layout, so existing logins carry over
- Dependencies: fhirpath 5 (its ucum-lhc no longer brings csv-parse 4) and node-cron 4 (no longer depends on uuid), for the same reason: the csv-parse and uuid overrides didn't reach npm installs. The csv-parse override is gone
- Dependencies: natural 8 (uuid 13). Its stemmers are unchanged - every stemmer we use gives the same stem as natural 6 on ~1.6M words (RxNorm, LOINC's translations, and English, French, Spanish, Italian and Portuguese word lists), so existing SNOMED caches and RxNorm databases don't need rebuilding. FHIRsmith now loads only `natural/lib/natural/stemmers`: the package index also loads natural's storage backends, which run dotenv (reading any `.env` in the working directory into the environment, and in natural 8 printing a banner to stdout)
- Development: jest 30 and jest-junit 17, and `npm run dev` uses Node's own `node --watch` in place of nodemon. With these, `npm audit` is clean for the dev tooling too (jest 29 and nodemon brought braces, and jest's coverage tooling sprintf-js, neither of which has a fixed version). The package.json overrides are down to one, js-yaml 4 for @istanbuljs/load-nyc-config, which only affects the dev install; the rest were no longer doing anything
- The PR pipeline fails on high/critical advisories anywhere in the dependency tree, on moderate ones in what ships, and audits a fresh install of the packed package (installed the way users install it, so the repo's overrides don't apply)

### Changed

- The npm audit self-check looks up the latest FHIRsmith release, and only tells the administrator to upgrade when there is a newer release to upgrade to; a server already on the latest release says so instead

### Tx Conformance Statement

FHIRsmith v0.16.0 passed all 3630 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed+mimetypes+icd-11+closure, tests v1.9.6, runner v7.0.1)

## [0.15.1] - 2026-10-15

### Security

- Packages: the SSRF guard on the crawler's outbound requests could be bypassed with an IP address in the URL (`http://127.0.0.1/`, `http://169.254.169.254/`, `http://[::1]/`), because Node makes no DNS lookup for an IP address and the guard only ran there. IP addresses are now checked too

### Added

- Packages: `/packages/npm-check` checks any registry against the npm registry protocol, the way npm clients use it (search by name, package document, version document, tarball), and reports each check with the reason for any failure. In a browser it is a form; otherwise it returns the report as JSON. The checks also run once a day against registry.npmjs.org, and the page says if any fail there. Requests are limited in time and size, may not go to non-public addresses other than loopback (so a server can check itself), and are rate limited per client. `npmCheck` in the packages config sets the limits; `"enabled": false` turns it off
- Packages: npm-protocol test suites that run the same checks against registry.npmjs.org (the control: if npm changes its behaviour, this is where it shows), and against the packages module with known content
- Packages: the package document has npm's `time` (each version's publication date, plus `created` and `modified`)
- Packages: `latest` can be used in place of a version (`/packages/{id}/latest`)
- Packages: `packages/dedupe-versions.js`, a one-off repair for an existing database: removes duplicate id#version rows, rewrites mirror files that don't match the database, and adds the unique index. It needs nothing but Node 24; see Repairing an older database in packages/readme.md

### Changed

- Packages: `GET /packages/{id}/{version}` returns npm's version document (JSON) when the request's `Accept` asks for `application/json` (or `application/vnd.npm.install-v1+json`), and the tarball otherwise. On the npm registry this URL is always the version document, and npm clients and tools that treat this server as an npm registry (including the HL7 Java tools, when they are configured with a server of npm type) ask for it with `Accept: application/json` and then download from `dist.tarball`. But FHIR clients have always downloaded the tarball from this URL - the Java tools without sending an `Accept` header at all, browsers and curl with ones that don't ask for JSON - so the tarball stays the default, and only a request that explicitly asks for JSON gets the document. The risk is a client that downloads the tarball from here while asking for JSON (typically a generic HTTP wrapper that sets `Accept: application/json` on every request). For those, and as a guarantee for the Java tools, a request with a `FHIR-Package-Download` header (any value; the Java PackageClient sends `tarball`) always gets the tarball, whatever its `Accept`. The response carries `Vary: Accept, FHIR-Package-Download` so caches keep the two apart
- Packages: `/packages/-/v1/search` puts the package whose id is the whole search text first, as npm does. `/packages/catalog` is unchanged
- Packages: each id#version is stored once. Simplifier republishes packages that other feeds publish directly, so its copy is a secondary echo: a version already held is not fetched from Simplifier, and a version held only from Simplifier is replaced when it arrives directly from its publisher's feed. A second direct copy from a different GUID is logged as an error and ignored. The database enforces this with a unique index on (Id, Version); on an existing database the server logs a warning until `dedupe-versions.js` has been run
- Packages: package downloads keep the bytes the server sent: a `.tgz` labelled `Content-Encoding: gzip` is no longer unzipped by the HTTP client

### Fixed

- Packages: the tarball served for some versions didn't match the shasum in the package document (46 of 6961 versions on packages2.fhir.org), so npm clients would reject them. Two causes: the same id#version stored twice from different feeds (the document showed one copy's hash, the mirror held the other), and a tarball that failed validation (e.g. a draft flagged `notForPublication`) overwriting the mirror file before it was rejected. The mirror file is now written only after the package has been validated and stored
- Packages: packages from feeds that label `.tgz` files `Content-Encoding: x-gzip` (e.g. doc.mednet.swiss) failed with "incorrect header check"
- Packages: the search, catalog and updates log lines showed `[object Object]` instead of the query
- Packages: the crawler log showed `??` for an item skipped because another feed had it in the same crawl

### Tx Conformance Statement

FHIRsmith v0.15.1 passed all 3630 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed+mimetypes+icd-11+closure, tests v1.9.6, runner v7.0.1)

## [0.15.0] - 2026-10-08

### Added

- Library YAML: a source can give the id prefix for the resources it loads (`npm:hl7.terminology=tho`), so their ids stay the same when sources are added, removed or reordered. Sources without one are numbered, as before. See Resource Ids in tx/README.md
- `CapabilityStatement.software.releaseDate` (and the TerminologyCapabilities equivalent) is the date the running version was released, taken from its heading in CHANGELOG.md, which is now included in the Docker image. A snapshot reports the time the server started
- Registry: the crawler records each server's `software.releaseDate`. The Software page uses it to date software other than FHIRsmith, and FHIRsmith releases (including development builds) that the release list doesn't know about yet

### Changed

- **Breaking - resource ids:** every CodeSystem, ValueSet and ConceptMap is served with an id in the id space of its source - `prefix-id`, e.g. `CodeSystem/tho-v3-ActCode` - and the FHIR core package each endpoint loads uses `core` (`CodeSystem/core-administrative-gender`). An unprefixed id is not found by read or by any `[type]/[id]/$operation`. Library CodeSystems used to keep the ids they had in their packages (ValueSets and ConceptMaps were already numbered), and so could clash with the endpoint's core CodeSystems
- THO overrides the FHIR core packages the same way the Java validator does: where hl7.terminology has a url, the core package's CodeSystems, ValueSets and ConceptMaps with that url are not loaded at all. Older core versions used to stay available by `url|version`, so the server reported versions the validator doesn't know (e.g. v3-MaritalStatus `2018-08-12`). The exception is the R4 v2 tables 0006, 0360 and 0391, which R4 core has in two versions each with the version in the url: those versions stay available, and THO's is the default
- `software.releaseDate` is no longer the time of the request

### Fixed

- Search: two CodeSystems with the same id from different packages (e.g. v3-MaritalStatus from hl7.fhir.r4.core and hl7.terminology) linked to the same resource, and a read of that id always returned the core one
- On the R4 endpoint, a ValueSet asked for without a version (e.g. `http://terminology.hl7.org/ValueSet/v3-MaritalStatus`) was the core package's copy rather than hl7.terminology's

### Tx Conformance Statement

FHIRsmith v0.15.0 passed all 3585 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed+mimetypes+icd-11+closure, tests v1.9.6, runner v7.0.0)

## [0.14.2] - 2026-10-06

### Security

- Dependency updates for published advisories, including axios (several high severity), brace-expansion (denial of service), and http-cache-semantics and @tootallnate/once (removed with the old sqlite3 build chain)

### Added

- OpenAPI descriptions for the package server (/packages), the terminology registry (/tx-reg), the TestReport module (/testing) and the R5 terminology endpoints: each serves `openapi.json`, `openapi.yaml` and an HTML reference at `openapi` (JSON for non-browser clients), linked from the module's pages and advertised in an RFC 8631 `Link` header on every response. The FHIR resource schemas are generated from the FHIR definitions, constrained to what each module accepts
- npm audit self-check: once a day the server checks its installed packages (and FHIRsmith itself) against the npm advisory database - report only, nothing is changed. Findings show as a banner on the home page, in full on the dashboard, and in the log. `npmAudit.enabled` = false turns it off (e.g. for servers with no internet access)
- Registry: new Software page (/tx-reg/software) listing each registered server's software and version, and for FHIRsmith servers, the release date, its age, and how many releases behind it is. The crawler now records `CapabilityStatement.software.version`

### Changed

- Terminology server: contained resources are supported only for ValueSets that contain ValueSets (which `compose.include.valueSet` can import by `#id`). Any other contained resource is rejected (CONTAINED_RESOURCE_NOT_SUPPORTED) wherever the resource comes from; when loading a package, the offending resource is skipped rather than stopping the load
- $validate-code: the `inactive` and `status` output parameters describe the code being returned. In a CodeableConcept where a different coding is inactive, that coding still gets its warning, but the parameters are not set for the returned code
- Registry discovery API follows the tx ecosystem IG: rows carry `fhirVersion` and the IG's security flags (`open`, `token`, ...) alongside the existing security string; candidate lists are only given when `url` is supplied; R-codes (R4, R4B, R5, ...) map to their release versions; and the resolve fallback that returned servers authoritative for a code system but not hosting it has been removed
- The TerminologyCapabilities statement no longer lists expansion parameters the server doesn't act on (`limitedExpansion`, `_incomplete`, `incomplete-ok` and others); `limitedExpansion`/`incomplete-ok` are no longer read, and no longer part of the expansion cache key (they never had any effect)
- TestReport module: a TestReport with contained resources is refused
- Packages and registry page footers say when the crawler last updated the data ("last updated 35 minutes ago"), or "not yet updated" before the first crawl - they used to show a raw `[%crawler-date%]` placeholder
- Packages crawler log: the start time is shown relative ("35 minutes ago") and the duration in seconds; the end time is dropped
- Dependencies: sqlite3 6 (connect-sqlite3 now uses the same sqlite3, which drops the old node-gyp/make-fetch-happen chain), and updates for axios, brace-expansion, moment, ip-address, csv-parse and uuid. The PR build now fails only on high/critical advisories in what ships (`npm audit --omit=dev`)

### Fixed

- $expand: RxNorm expansions that asked for a concept's children failed with `SQLITE_MISUSE`; an over-limit expansion of the whole of RxNorm is now refused before it is built
- $expand: a value set with neither a compose nor an expansion gets a clear error (VALUESET_NO_COMPOSE)
- $validate-code: in a CodeableConcept, the inactive warning names the coding that is actually inactive (it used to name the first coding), and a later active coding no longer hides the warning from an earlier inactive one
- Packages: `/status`, `/stats` and `/search` hung instead of answering (the `/:id` route swallowed them)
- Packages: dependency searches accept `id#version` and `id|version` (as sent by the Java PackageClient) as well as `id@version`; npm search (`/-/v1/search`) honours `text`, `size` and `from`, and accepts the other npm and PackageClient parameters
- XIG: the version shown on the pages

### Tx Conformance Statement

FHIRsmith passed all 3585 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed+mimetypes+icd-11+closure, tests v1.9.6, runner v6.10.4)

## [0.14.1] - 2026-09-29

### Added

- TestReport module: user administration - the administrator (`adminPassword`) manages users at /testing/admin/users, with rights to edit named links and/or delete reports
- TestReport module: named links - test script and participant URLs shown by name, maintained at /testing/admin/links
- TestReport module: the report list shows the test engine, client and server, the number of tests and the run length; a report page shows setup, each test with its operations and assertions, and teardown
- Test reports from the FHIRsmith build name the test modes they ran with

### Changed

- Security: the publisher and testing web pages require a CSRF token on every form post (lusca), a SameSite=Lax session cookie, and a same-origin `Origin` on posts; the session id is regenerated on login
- Security: the publisher rate limits task actions (create, approve, delete, retry) and task output reads, as well as logins
- `server.trustProxy` now defaults to trusting only loopback, link-local and private-network proxies (was `true`, which let anyone reaching the port directly set their own client address and get round the rate limits). See nginx.md - a proxy elsewhere needs to be configured, and the proxy must pass on `Host` or `X-Forwarded-Host`, or form posts are refused
- $expand: the `displayLanguage` expansion parameter is written without spaces (`en,*;q=0`, not `en, *; q=0`)
- $translate: `result` is only true if at least one match is a translation - a `not-related-to` (R4: `disjoint`/`unmatched`) or `noMap` match is still returned, but `result` is false
- SNOMED CT edition names are held in one table (tx/sct/editions.js), used by the provider and the unknown code messages

### Fixed

- $validate-code: when the code is not in the value set, it is looked up in the code system version the value set selects (`compose.include.version`), not the server's default version - so the version and display reported come from the right edition
- $validate-code: the unknown code message named the SNOMED CT test edition as "unknown"; it is now "Test Edition"
- Registry: the SNOMED CT test edition (`http://snomed.info/xsct/31000003106`) is labelled, rather than shown as `??`

### Tx Conformance Statement

FHIRsmith passed all 3585 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed+mimetypes+icd-11+closure, tests v1.9.6, runner v6.10.4)

## [0.14.0] - 2026-09-27

### Added

- New Module: TestReport repository 
- Initial Implementation of $closure
- add support for caching across multiple servers
- better support for web invocation of operations 
- add ECL control panel

### Changed

- improve home page graphs and cache information
- better memory management - prevent an operation running the server out of memory 
- $validate-code: inferSystem is only applied to the code parameter, per its definition - it is ignored for coding and codeableConcept
- $validate-code: a Coding with neither a system nor a code is reported as one problem, not two (Coding_has_no_system_or_code__cannot_validate)
- $subsumes: a missing system (codeA/codeB with no system parameter, or a codingA/codingB with no system) is now 400 with issue code invalid and tx-issue-type invalid-data (was 404/422 not-found), with message id SUBSUMPTION_NO_SYSTEM (shared with the Java terminology service); mismatched codingA/codingB systems use SUBSUMPTION_SYSTEM_MISMATCH
- SNOMED expressions: a refined or conjoined attribute value must be bracketed, per the compositional grammar (405813007=(85562004:272741003=24028007)); the unbracketed form is now rejected, and the renderer emits the brackets (it used to produce expressions other parsers reject)

### Fixed

- Fix processing of sourceScope during $translate operation
- Fix broken links in HTML references (#256)
- Fix bug in concept map conversion 
- Fix issue processing MRCM rules (#287)
- Fix message about depending on a draft resource (add source info)

### Tx Conformance Statement

FHIRsmith passed all 3516 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed+mimetypes+icd-11+closure, tests v1.9.5

## [v0.13.4] - 2026-09-17

### Changed 

- Clean up TxCaps expansion parameter list

### Fixed 

- Fix performance issue with snomed text search
- clean up release process to avoid version mismatch, and to clean out old dockers

### Tx Conformance Statement

FHIRsmith passed all 3507 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed+mimetypes+icd-11, tests v1.9.4, runner v6.10.4)

## [v0.13.3] - 2026-09-10

### Fixed

- Fix SNOMED CT display selection on national editions. `_displayRefsetOrder()` knew a display
  language reference set for only six editions (International, US, UK and the test edition);
  every other edition fell through to "the first description marked Preferred in any language
  reference set", which on a multi-language edition means whichever description happened to be
  stored first. The Belgian edition (11000172109) marks a Preferred synonym in Belgian French
  (21000172104) and Belgian Dutch (31000172101) as well as in English, so a request that named
  no `displayLanguage` got French for one concept, Dutch for the next and English for a third.
  Editions not in the table now default to US then GB English, and the $lookup designation
  order ranks the edition's display reference set ahead of "preferred anywhere", so the choice
  no longer depends on import order. An edition with no English language reference set at all
  still falls back to its own preferred synonym. This changes one tx-ecosystem expectation:
  `bugs/sct-display-2` recorded "Counselling" for 409063005 on the International edition, which
  is the GB English preferred term picked only because it is stored before the US one - the same
  concept already expanded as "Counseling". The expectation is now "Counseling".
- Fix the language tag on the display designation in $expand. It was hard-coded to `en-US`
  while its value came from the edition display, so on a multi-language edition a French or
  Dutch term was published as English - which put it in an implementation guide's English
  display column and made the real French designation read as a duplicate of it.

### Tx Conformance Statement

FHIRsmith passed all 3507 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed+mimetypes+icd-11, tests v1.9.5-SNAPSHOT, runner v6.10.4

## [v0.13.2] - 2026-09-05

### Added

- Add support for publishLibrarySource
- 
### Fixed

- Fix error in Snomed CT and ICD-11 where normal form difference and case difference being conflated 
- Fix error in mime-type subsumption analysis 
- adjust mime type validation to not be case sensitive

### Tx Conformance Statement

FHIRsmith passed all 3507 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed+mimetypes+icd-11, tests v1.9.5-SNAPSHOT, runner v6.10.4)

## [v0.13.1] - 2026-09-05

### Fixed 

- Error in ICD-11 provider that made the version page not show 

### Tx Conformance Statement

FHIRsmith passed all 3489 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed+mimetypes+icd-11, tests v1.9.4, runner v6.10.4)

## [v0.13.0] - 2026-09-04

### Added

- ICD-11 support, in three parts. `tx/importers/import-icd11.js` builds a SQLite database from
  the WHO ICD-API - 110,441 concepts across MMS, ICF and the Foundation for the 2026-01 release,
  in every language the API advertises. The native API is the content source because it is the
  only one that can enumerate the classification: the FHIR endpoint exposes no all-codes value
  set, accepts no client-supplied value sets, and its 28 top-level entities report no parent, so
  nothing there tells a client what the roots are. `tx/importers/export-icd11-codesystem.js`
  writes the content back out as FHIR CodeSystems, language supplements and the 25,354
  postcoordination scale ValueSets, optionally as a FHIR NPM package. `tx/cs/cs-icd11.js` is the
  provider; it is a skeleton at this point - metadata, code location, displays and definitions
  work, while designations, properties, extendLookup, filters, iteration, subsumption and
  postcoordinated expressions are still to come. The `icd-11` suite from the tx-ecosystem IG is
  the specification for the rest of it. Postcoordinated expressions now work:
  `tx/cs/icd11-expressions.js` parses the short-code, entity-uri and ICF dotted forms,
  binds each value to the axis it belongs on, and renders the expression back. The binding
  rule is that an axis not yet carrying a value is preferred over one that is, and required
  axes come before WHO's declaration order - which is what keeps the two values of
  1D01.0Y/1G41/1G40 on the two axes a coder meant them for instead of coalescing them onto
  the first, and what stops a repeated value being silently dropped. `&` asserts that what
  follows is a value on an axis of the stem, so a value on none of them is an error that
  names the axes; `/` asserts only cluster membership, so a member that fits an unfilled
  axis is taken as a value and one that does not starts a new stem. The provider also now
  answers `concept is-a` / `descendent-of` filters and text search, iterates children and
  roots, tests subsumption, and builds the 25,354 postcoordination scale value sets on
  demand from the database rather than shipping them

### Changed

- The tx test runner now names its own output folder (`fhirsmith`) and labels each pass (`r4`,
  `r5`, `r5-cached`), so the three passes stop writing over each other's expected/actual files.
  It also passes its mode set to the validator, which was previously falling back to its own
  default - one that does not include `icd-11`, so every icd-11 test came back "n/a" and was
  counted as a failure. Needs validator 6.10.5 and validator-wrapper 1.4
- The R5 -> R4 cross-version conversion dropped `ValueSet.compose.property` - the element a
  client uses to say which properties it wants back in an expansion. R4 and R3 have nowhere to
  put it, so it now travels as
  `http://hl7.org/fhir/5.0/StructureDefinition/extension-ValueSet.compose.property` (the same
  extension the Java convertors use) and is read back on the way up, with the extension removed
  so it does not show up twice. Before this, an R4 client that asked for properties got an
  expansion without them
- Every OperationOutcome the server emits now carries `details.text` and a tx-issue-type
  coding in `details.coding`. `diagnostics` is stripped outright by the test harness, so
  anything a client needs had to stop living *only* there -- it is still sent, and is still
  the right place for server-specific detail: the four (in fact nine) private
  `operationOutcome()` helpers that built `{severity, code, diagnostics}` by hand now all
  delegate to `buildOperationOutcome()` in `tx/library/operation-outcome.js`, and
  `Issue.asIssue()` falls back to a tx-issue-type derived from the FHIR issue type when an
  Issue does not name one, so the guarantee holds without revisiting all ~170 Issue
  construction sites. An informational issue that is not about a code or a value set -- the
  server banner -- gets text but no coding, since it is not a tx issue

### Fixed

- The exclude branch of `$expand` called `searchFilter(filter, prep, true)` -- the first two
  arguments the wrong way round, so a provider that implements a text search would have been
  handed the filter where it expected its own filter context. The other three call sites,
  and the declared signature, are `(filterContext, filter, sort)`
- `$lookup` reported a code that is not in the code system as `not-found`; the code system
  was found, so it is `invalid-code`, which is what the other 62 unknown-code expectations
  in the tx-ecosystem suite assert
- `$lookup`'s two top-level catch blocks put `Issue.issueCode` -- a tx-issue-type -- into
  `OperationOutcome.issue.code`, which takes a FHIR issue type. Two conventions were in use:
  an `Issue` carries the FHIR issue type in `cause` and the tx-issue-type in `issueCode`,
  while a plain Error tagged by its thrower carries the FHIR issue type in `issueCode` and
  the tx-issue-type in `txIssueType`. Every catch block now goes through
  `outcomeFromError()`, which is the one place that knows about both

### Tx Conformance Statement

FHIRsmith passed all 3489 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed+mimetypes+icd-11, tests v1.9.4, runner v6.10.4)

## [v0.12.0] - 2026-08-27

### Added

- `$cache-control?mode=check`: ask the server whether a cache-id is still alive. The check is
  also a keepalive - it resets the cache's idle clock - because a client whose own local cache is
  absorbing the work is invisible to the server, and its cache would otherwise time out mid-job.
  An unknown id answers 200 with `valid` = false (not 404), so a client can tell "the server says
  my cache is gone" from "I could not reach the server"; a live cache also reports `sealed`,
  `resource-count`, `idle` and the server's idle timeout, so a client can work out how often to
  check instead of guessing
- Cache tombstones: the server now records why a cache-id it issued stopped existing - closed by
  the client, expired after N minutes idle, or cleared with everything else - and says which in
  the error, with the timings. New `CACHE_ID_CLOSED`, `CACHE_ID_EXPIRED` and `CACHE_ID_CLEARED`
  messages; `CACHE_ID_UNKNOWN` now means "never issued here", and says that a cache-id is only
  valid on the server instance and endpoint that issued it (#279)
- SNOMED CT: MRCM validation of postcoordinated expressions - attribute domain (including the
  lateralizable body structure rule), range (evaluated as ECL, or as a concrete-value range such
  as `dec(>#0..)`), cardinality and grouping. A constraint that cannot be resolved leaves the
  value unchecked rather than rejecting it. The MRCM and lateralizable reference sets are now
  included in the test SNOMED distribution
- `$translate`: R4 parameter names are accepted as aliases for the R5 ones (`source`/`target` for
  the scopes, `targetsystem`, `targetcode`), and R4's `reverse` parameter now does literally what
  it says - swaps the source and target sides once the parameters are read - while remaining an
  error in R5+, which names the target concept directly instead
- `$translate`: reverse translation by naming the target concept (`targetCode`, `targetCoding`,
  `targetCodeableConcept`), with the source system saying which system the answers come from
- `$translate`: `ConceptMap.group.element.comment` is read from R6 resources and from the
  cross-version extension on R5 ones, so a preadopted R5 map and a native R6 map behave the same
- `$translate`: `originMap` names where a chain of maps started, with every other map consulted
  along the way reported as a `used-conceptmap`; `group.unmapped` is applied per group, so a
  mapping in one group no longer suppresses another group's fallback
- Persistent usage statistics: request counts per module, endpoint and operation are written to a
  SQLite database every `intervalMinutes`, with both the interval count and the all-time total, so
  they survive restarts and upgrades. New optional `stats` config block (#255)
- Support for `ValueSet.compose.property` (R6): a value set can name the properties to return in
  its own expansion, rather than leaving it to the request
- Publisher: input validation for GitHub owner and repository, git branch, package id and version -
  enforced on the server, with matching patterns on the form so the browser objects first
- Publisher: `large-file-archive` config setting - files the IG Publisher leaves in the web output
  that are too big for GitHub (>100MB) are moved aside for GitHub-hosted websites, instead of
  leaving the push to fail

### Changed

- `tx/params.js`: parameter names are now interpreted in exactly one place (`seeParameter`), used
  by both the request `Parameters` resource and the `valueset-expansion-parameter` extension. A
  parameter from the request always wins over one embedded in a ValueSet's expansion parameters;
  accumulating parameters (version rules, designations, properties, supplements) still add
- An inactive display is now governed by `lenient-display-validation` like every other display
  check - a warning (and `result` = true) when lenient, an error when not - rather than always
  being a warning. The display is a designation of the concept, just not a current one
- tx.fhir.org now loads `fhir.tx.support` rather than `fhir.tx.support.r4`

### Fixed

- The XML parser could be made to loop forever, which on a single-threaded server means the
  process stops answering anything at all - not just the request that carried the input. Several
  scans used `indexOf` without checking for -1 and assigned the result to the cursor, sending it
  backwards; `<ValueSet><x bare></x></ValueSet>` was enough, as was any `<!DOCTYPE` or an
  unterminated comment. The parser has been rewritten to be total: every delimiter search fails
  loudly, every loop asserts that it consumed input, nesting past 1000 elements is an error rather
  than a stack overflow, and a document type declaration is refused outright (FHIR XML has no DTD,
  and accepting one is how a parser ends up expanding entities on someone else's behalf).
  Malformed documents now produce a positioned parse error
- SNOMED CT: normalising an expression discarded a primitive concept's defining attributes, so
  real subsumption answers were lost. A primitive's definition is necessary but not sufficient, so
  the concept itself must not be replaced by it - but its attributes are still entailed:
  `4846001 |Anicteric viral hepatitis|` is primitive and carries an inferred
  `363698007 |Finding site| = 10200004 |Liver structure|`, so `64572001:{363698007=10200004}`
  really does subsume it, and the server said not-subsumed. The attributes are now added
  alongside the concept, which keeps the other direction sound - the primitive stays in the focus
  as an atom nothing else can match, so its conditions never become sufficient and nothing is
  reported equivalent to it. Read from the concept's relationships at query time rather than from
  the stored normal form, so existing caches need no rebuild
- IETF language codes (`urn:ietf:bcp:47`) are validated properly. Four things were wrong, all
  visible only through the code system: the registry writes private-use allocations as ranges
  (`QM..QZ`, `Qaaa..Qabx`, `qaa..qtz`, `XA..XZ`) and those were stored as literal keys nobody
  could ever look up, so every code inside them read as unregistered while singly-allocated `AA`
  worked; the 26 grandfathered tags were skipped at load, so registered tags like `i-klingon`
  were rejected; a variant was never checked against the registry at all, so `en-abcdef` parsed
  happily; and the registry's `Prefix` field - its only statement about which subtags may go
  together - was ignored, so `en-cmn` passed even though `cmn` may only follow `zh`. Tags are
  also matched case-insensitively now, per BCP 47 §2.1.1, so `en-us` is accepted as a way of
  writing `en-US`. The stricter checks are options on the parser, applied by the code system;
  Accept-Language parsing is deliberately left as it was. Redundant registry entries such as
  `zh-Hans` still decompose into language plus script rather than being matched whole
- Language codes gained `=` filters on `language`, `script` and `region`, and three of the
  combinations can now be expanded. The BCP 47 grammar is unbounded, so an expansion is only
  possible where fixing part of a tag leaves a finite list of registry entries to vary: a fixed
  language gives every region plus the bare language (344 codes), a fixed region gives every
  language with it (8787, so too-costly unless paged), and language and region together give
  every script plus the tag with none (275). Anything else - a script on its own, a language with
  a script, an `exists` filter - answers 422 rather than pretending, and `filterMore` throws
  rather than returning false so a mistake cannot surface as an empty expansion that reads like
  "there are none". Every one of these is marked unclosed, since a variant, extension or
  private-use subtag can always be added. A filter value that is not a registered subtag of the
  right kind is refused when the filter is built, rather than silently selecting nothing
- `$subsumes` works for language codes, where it used to answer `not-subsumed` for everything
  behind a comment reading "No subsumption in language codes". A tag is a set of named
  components rather than an ordered path, so one tag subsumes another when it states a subset of
  what the other states and the languages match: `en` subsumes `en-US`, `zh` subsumes
  `zh-Hans-CN`, `de` subsumes `de-1901`. `en-US` subsumes `en-Latn-US` too, even though the added
  script sits between the two subtags `en-US` names - that is RFC 4647's extended filtering
  rather than basic filtering, and it is what keeps the relation transitive. Comparison is
  case-insensitive, and a grandfathered tag relates only to itself, having no components to
  compare. Suppress-Script is deliberately not consulted, so `en` subsumes `en-Latn` rather than
  being equivalent to it
- A language code written in the wrong case now comes back with a `normalized-code` and an
  information issue saying so, the way any other case-insensitive code system already behaved -
  `en-us` validates, and the server answers with `en-US`. BCP 47 recommends lower case for the
  language, Titlecase for the script and UPPER CASE for the region; the whole mechanism was
  already in the validator, waiting on the code system to report the canonical spelling of a code
  rather than echoing what the caller wrote
- Validating a language code now says which subtag is wrong and why - "the extLanguage 'cmn' in
  the code 'en-cmn' may only be used with 'zh'" - instead of only "unknown code". The mechanism
  for this already existed in the validator; the language provider had been discarding the reason
- `$subsumes` can now report that it cannot determine the relationship, as a 422 carrying
  `cannot-determine` from the tx-issue-type code system (FHIR-58748). There is no outcome code
  meaning "unknown", so a server that cannot decide has no honest answer to give and must report
  an error; answering `not-subsumed` asserts something it has not established. The condition is
  real in more than one code system, so the error is raised through one shared helper
  (`cannotDetermineSubsumption`)
- Media types: subsumption is only decided on parameters the server understands - `charset`,
  `format`, `delsp` and `version`. Reasoning that a parameter narrows the type, and that two of
  its values exclude one another, are properties of that parameter's definition, and neither can
  be asserted for one the server has never seen: `text/plain` vs `text/plain; foo=bar` might be
  subsumption or might be the same thing. Where an unknown parameter is what the two codes differ
  in, the answer is now cannot-determine. A parameter carried identically by both codes cannot
  affect the relationship and is ignored, so it does not trigger a decline, and a type or subtype
  mismatch stays decidable whatever parameters are present. `boundary` and `profile` are
  deliberately excluded from the understood list: a differing boundary does not narrow anything
  (two multipart bodies with different boundaries are the same media type) and profile values can
  be hierarchical, so neither can be judged by comparing values

- SNOMED CT: `$subsumes` no longer answers `not-subsumed` when it has not established it. Comparing
  normal forms is sound when it succeeds and not when it fails: SNOMED's OWL axiom reference set
  carries general concept inclusions and property chains whose entailments are baked into the
  distributed inferred relationships for precoordinated concepts, but a postcoordinated expression
  is one the classifier never saw, so they are not available for it. Where either code is an
  expression and no relationship follows structurally, the server now returns a 422 rather than
  claiming there is none - the claim would be the one that wrongly drops a code out of a cohort,
  and `$subsumes` has no outcome code meaning "unknown". Two plain concepts are unaffected: there
  the transitive closure comes from the classifier's own output and all four outcomes are sound

- SNOMED CT: the MRCM `grouped` flag was parsed into the attribute domain rules and then never
  read, so an attribute the concept model requires to be in a relationship group could be written
  outside one and pass validation - `40468003:363698007=10200004` was accepted even though
  `363698007 |Finding site|` is grouped and the expression is not classifiable. It is now
  enforced, for expressions wherever they appear ($validate-code, $lookup and $subsumes all
  validate through the same path), and the message names the attribute and shows the corrected
  form. Attributes the MRCM marks as ungrouped, such as `272741003 |Laterality|`, are unaffected:
  the flag is read from the concept model rather than every brace-less refinement being rejected.
  SNOMED's postcoordination guide treats the ungrouped form as Close To User Form and defines a
  transformation to the classifiable form; that transformation is not implemented, so the
  expression is rejected rather than silently repaired
- Publisher: with no `sessionSecret` configured, the session middleware fell back to a constant
  written into the source. In an open-source project that is a published signing key - anyone
  could mint themselves an admin session on any deployment that had missed the setting, and
  nothing about the server would look wrong. The fallback is now a random secret plus a warning,
  which fails safe: logins simply do not survive a restart. Session cookies are also marked
  `Secure` by default now (set `modules.publisher.cookieSecure` false to run over plain HTTP),
  and `POST /login` is rate limited - it is the one unauthenticated route that runs bcrypt, and
  bcrypt holds a libuv threadpool thread for ~100ms, so unlimited attempts stall the server's
  file I/O as well as inviting guessing
- Publisher: twenty more values reached the task, history and admin pages unescaped -
  `npm_package_id`, `version`, `status`, `user_name`, `website_name`, `local_folder`,
  `failure_reason`, the task log messages, and the user and website names on the admin pages.
  Most are constrained elsewhere, but `failure_reason` and the log messages carry build output
  from the IG being published, which is not. The earlier fix covered `github_org`, `github_repo`
  and `git_branch` only; output escaping is the boundary that has to be complete to be worth
  anything
- The static file handler for `server.webBase` built its filename with `path.join(webBase, req.path)`
  and no containment check, so a literal `..` in the request path walked straight out of the
  directory: `GET /../../etc/passwd` read any file the server user could read. (The encoded forms
  never worked - Express does not decode `req.path` - and a proxy in front normalises `..` away,
  which is why this survived.) Paths are now resolved and required to stay inside the configured
  directory, in `library/path-safety.js` so the rule is testable and reusable; a request that
  escapes falls through to the next handler instead of being served
- `POST /packages/crawl` triggered a full registry crawl for anyone who asked. It now requires a
  shared secret, `modules.packages.crawlToken`, in an `x-crawl-token` header, compared in constant
  time. With no token configured the endpoint is disabled rather than open: an administrative
  trigger that silently defaults to unauthenticated is how a deployment ends up exposed with
  nothing about it looking wrong. The scheduled crawler is unaffected

- `CodeSystem.concept` and `ValueSet.expansion.contains` nest without limit in FHIR, and both are
  walked recursively in a dozen places - the expansion map, the concept counts, the renderer, the
  expander's index, the R5-to-R4 converter. A resource of a couple of hundred KB could nest deeply
  enough to exhaust the JS stack, and hardening those walkers one at a time would not have been
  enough anyway: `JSON.stringify` itself, which we do not control, overflows at a nesting depth of
  about 1800 on node 22, so a deep enough resource could not be serialised even if every walker
  were iterative. Nesting is now bounded once, at construction, at 100 levels - far past SNOMED
  CT's ~30 or LOINC's ~10, and well clear of anything that breaks - which makes every walker safe
  by construction, including ones not yet written. The bounding walk is iterative and doubles as
  the concept count, so the tree is still traversed only once, and an over-nested resource comes
  back as a 400 rather than a 500

- Publisher: the task output page wrote `github_org`, `github_repo` and `git_branch` into the HTML
  without escaping. The first two are constrained to letters, digits and punctuation, but a branch
  name was only checked against git's own rules, which say nothing about markup - so a branch
  called `<script>...</script>` was stored XSS on a page that needs no login to read. The fields
  are escaped now, and a branch name carrying `< > " ' &` is refused at the boundary as well

- `$expand`: `status` was lost from imported property declarations, and a concept carrying the
  same property more than once had the repeats collapsed to a single value
- Expansion properties are de-duplicated when they arrive from more than one place (the request,
  an expansion parameter extension, `compose.property`) - a repeat emitted the property twice and
  changed the cache key
- `no-cache=true` never busted the cache: the parameter wrote `uid`, which nothing read, instead of
  the field the cache key hashes
- Boolean parameters passed as strings (as they always are on a GET) are now accepted, which
  revives five parameters that were dead on GET requests
- `$subsumes`: an unknown `codeA`/`codeB` returned a bare OperationOutcome - no
  `operationoutcome-message-id` extension and no `tx-issue-type#invalid-code` detail code - so
  clients could not tell what kind of failure it was. It now reports the same issue that
  `$validate-code` does for an unknown code
- SNOMED CT import did not record definition status, so every concept looked fully defined. A
  normal form was then generated for concepts that have no definition to expand, and the result
  was stored unparseable - which made `$subsumes` fail with a 500 for any post-coordinated
  expression. **Caches built by the affected importer have to be rebuilt**
- SNOMED CT `isPrimitive` tested bit 0 of the concept flags, which is part of the status, instead
  of the primitive bit
- A concept's own stored normal form was run through the MRCM postcoordination checks when it was
  read back. Those rules are about expressions a client sends, not about precoordinated content,
  and they rejected the normal form of any concept defined with a precoordinated-only attribute
- The expression parser did not resolve attribute names to concept references, so refinements were
  compared by reference in one direction and by code in the other. Subsumption between two refined
  expressions could come out true one way and false the other
- Subsumption checked each refinement group against only the first group whose attribute names
  lined up. Where several groups share attribute names, the answer depended on the order the
  groups happened to be in after normalisation
- `$subsumes` reported an unexpected error in `diagnostics`, which the test runner strips from
  every issue it compares, so a failing test showed nothing but `severity`/`code`. The message now
  goes in `details.text` (the same helper elsewhere in the server has the same problem)
- `$subsumes` ignored a front-loaded cache on a GET: it only looked for `tx-resource` and the
  cache-id when the request had a Parameters body, so a client that put its code systems in a
  server-side cache and sent the id in `X-Cache-Id` got "could not be found" for every one of
  them
- `$subsumes` reported an unknown code against `codeA`/`codeB` in `expression` even when the code
  came in as `codingA`/`codingB`

### Changed

- `$subsumes` on UCUM now answers `equivalent` for two different codes that mean the same unit -
  `1/min` and `min-1`, `N` and `kg.m/s2`, `mg{total}` and `mg`. UCUM still has no hierarchy, so
  nothing ever subsumes anything; this compares the canonical *form* (which carries the conversion
  factor), not the canonical units, so `m` and `cm` remain distinct rather than collapsing onto
  their shared canonical unit
- `$subsumes` on LOINC is implemented against the multiaxial hierarchy. The importer already
  builds a full transitive closure from `PATH_TO_ROOT` in ComponentHierarchyBySystem - the same
  table the `is-a` / `descendent-of` filters use - so subsumption and expansion now agree.
  Relationships run Part-to-Part and Part-to-code, so two LOINC codes still never subsume each
  other
- Mime types support a `base` filter, taking either `type` or `type/subtype`, which selects the
  codes consistent with it - parameters on the code are ignored, so `text/plain; charset=utf-8`
  matches a base of `text` and of `text/plain`. Media types cannot be enumerated, so the filter
  validates a code rather than expanding; a value carrying parameters, a wildcard, or anything
  that is not a type or type/subtype is rejected
- A `registered = true` mime type filter can be expanded: the IANA registry is a finite list, so
  the expander walks it, and the expansion is marked `valueset-unclosed` because every registered
  type also has unboundedly many parameterised forms that belong to the value set. A second filter
  in the same include still narrows it, so `registered = true` + `base = text/plain` expands to
  one code
- Everything else that cannot be enumerated - the whole code system, a `base` filter on its own,
  `registered = false` - answers 422 `not-supported` with `CODESYSTEM_NOT_ENUMERABLE`, the same as
  HGVS, instead of the 500 exception a filter used to raise. Expanding every registered media type
  at once is a couple of thousand codes, so without a `count` it answers `too-costly` like any
  other oversized expansion
- Mime types support a `registered` filter (`true`/`false`), testing whether a media type is in
  the IANA registry. The provider downloads
  https://www.iana.org/assignments/media-types/media-types.xml into the terminology cache at
  startup and keeps only the names; a failed download falls back to the cached copy, and if there
  is no copy at all, using the filter reports that rather than answering. The download is written
  to a temporary file and only replaces the cached copy once it has parsed, so a truncated
  transfer cannot leave behind a registry that looks valid but is short
- `$subsumes` on mime types understands parameters. A parameter narrows the media type, so
  `text/plain` subsumes `text/plain; charset=utf-8`, and two spellings of the same type are
  equivalent - type, subtype and parameter names are matched case-insensitively, as are charset
  values, and quoted values are unquoted. Type and subtype themselves still have no hierarchy,
  so a structured syntax suffix does not make `application/fhir+xml` a kind of `application/xml`
- **Breaking (LOINC import):** the accessory files are now required, not optional. An import
  missing ComponentHierarchyBySystem previously succeeded and produced a cache with an empty
  closure, so the server answered `not-subsumed` to everything with no way to tell that apart
  from a real answer; the same argument applies to the part links and answer lists. Only the
  linguistic variants stay optional, since a main-only import is a reasonable thing to want and
  their absence costs designations rather than correctness

- The mime type tests are their own test mode (`mimetypes`) rather than part of `general`, and
  FHIRsmith's test run declares it. fhir-core gains it in all four places the mode set is
  declared: the runner default (`TxTestHTTPHandler`) and the local and external terminology
  service test runs, which will be red until tx-dev implements the filters

### Removed

- `POST /packages/update-package`, along with `forceUpdatePackage` and
  `deleteVersionsByIdVersion`. Its authentication was conditional on `updateToken`, which was set
  in no configuration file and not even mentioned in the template, so in practice the endpoint let
  anyone hand the server a URL to fetch and store - server-side request forgery against anything
  the host can reach, and a write into the package registry. It existed to push out a corrected
  package after a bad publish; that is rare enough to do by hand

### Tx Conformance Statement

FHIRsmith passed all 2822 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.3, runner v6.10.3)

## [v0.11.2] - 2026-08-12

### Fixed

- Update snomed test content

### Fixed

- Fix snomed designation handling for languages
- Fix for SSRF protection in the validator- 

### Tx Conformance Statement

FHIRsmith passed all 2729 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.3, runner v6.10.1)

## [v0.11.1] - 2026-07-30

### Added

- Cooperative yielding for long terminology operations: after every 25ms of continuous compute the
  operation yields the event loop (`checkAndYield`), so a heavy $expand can no longer stall every
  other request on the server. Operations whose client has disconnected are aborted at their next
  yield point instead of computing a response nobody will read
- The operation time limit is now configurable (`operationTimeLimit`, seconds) and defaults to 20s
  (below common client timeouts, so clients see the too-costly OperationOutcome rather than a
  socket timeout), and is measured against compute time consumed rather than wall-clock, so
  concurrent operations time-sharing the event loop don't abort each other
- The Node Blocking chart on the status page now shows the worst single event-loop stall per
  window as well as the mean

### Fixed

- fix whole-code-system SNOMED CT expansions blocking the server for 30 seconds and then failing:
  the hierarchy walk read a non-existent `.code` property, so every concept was treated as a
  duplicate of the first and no expansion size guard could ever stop the walk. This is what caused
  the rash of client timeouts on tx.fhir.org after the 0.11.0 upgrade
- the hierarchy walk now visits each concept once rather than once per path to it (SNOMED CT is a
  poly-hierarchy: the old walk made ~15.8M visits for ~520k concepts)
- restore the up-front too-costly refusal for expansions that cannot fit the expansion limit (the
  totalCount size guard was silently dead - method read as a property); expansions with a
  count/offset window inside the limit still succeed as partial, unclosed expansions
- re-enable the CPT 1000-code expansion cap (same method-read-as-property bug)
- fix parameter misalignment in the no-details expansion path (19 arguments passed to a
  20-parameter function)

### Tx Conformance Statement

FHIRsmith passed all 2729 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.2, runner v6.9.12)

## [v0.11.0] - 2026-07-30

### Added

- Upgrade the tx registry module to support exclusions and languages
- Add support for sealed caches 

### Changed

- rework caching
- Remember filter analysis on cached value sets 
- Improved Rendering for CodeSystem and ValueSets
- Update ECL & tests given ECL functionality confirmations
- Update snomed subset from test IG
- improved error when multiple cache-id headers passed to the server
- fix slow crawling for FHIRsmith servers by the tx registry
- make tx search page size default to 1000 for json/xml and leave it at 20 for html
- rework batch processing for caches

### Fixed

- Report the FIRST matching coding, not the last, and only one message about status
- rework how expansions on complex codesystems are handled
- better handling of expansions on grammar based systems
- (SNOMED CT) consistent use of designations
- give preferredForLanguage a display in expansions
- fix various ECL processing bugs
- fix precedence order problem loading THO content after core content
- fix links in metadata statements 
- fix unhandled promises 
- fix handling of properties in R4 expansions
- fix bug validating codes from erroneously coded R4 v2 tables
 
### Tx Conformance Statement

FHIRsmith passed all 2729 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.2, runner v6.9.12

## [v0.10.1] - 2026-06-27

### Fixed

- Terminology: the version-less value set lookup now resolves to the latest version when several versions of the same value set are present (e.g. VSAC date versions), instead of an arbitrary one determined by database row order
- Rendering: fixed value set links in `renderLinkComma` (read the resolver's `description`/`link` fields and fall back to the raw URI)

### Tx Conformance Statement

FHIRsmith passed all 2503 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.1, runner v6.9.11)

## [v0.10.0] - 2026-06-27

### Added

- Publisher: track the IG Publisher version used for each task, and show it on the tasks list and task detail pages
- Packages: new `POST /packages/update-package` endpoint to force-refresh specific packages in the registry, bypassing the feed crawler's de-duplication (used to push out a corrected package after a bad publish)
- Publisher: automatically update SUSHI to the latest release before each draft build and publication run, installed into a FHIRsmith-owned prefix so it needs no root privileges

### Changed

- Rebuilt how caching works (see the tools IG for documentation)
- Renamed the compare worker/operation

### Fixed

- Publisher: the publication run now verifies that the package about to be published is a real publication build (not a draft) before committing it to the web tree, so a failed publication build can no longer silently ship a `notForPublication` draft package
- Packages: the crawler now rejects any package flagged `notForPublication` at ingest, instead of only checking the feed entry
- Registry: better handling of versions on manual queries against the external registry
- Fixed handling of the cache-control header
- Corrections to generated test cases

### Security

- SSRF protection: outbound fetches in the packages and registry crawlers now reject any host that resolves to a non-public address (private, loopback, link-local including cloud-metadata, CGNAT, unique-local, etc.). Enforced at connection time, so it also covers redirect targets and DNS rebinding, and prevents leaking registry API keys to a redirected host
- Path-injection hardening: local-file feed reads in the packages crawler are confined to explicitly-allowed directories; the `update-package` endpoint only accepts http(s) URLs
- Dependency updates (npm audit)

### Tx Conformance Statement

FHIRsmith passed all 2503 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.1, runner v6.9.11)

## [v0.9.7] - 2026-06-12

### Added

- Support for tx modele to load resources directly 
- Missing overwork protection processing ECL

### Fixed

- Fix bug validating secondary displays across languages
- Fix CORS issue (double headers)
- Fix czech code in snomed import
- Many minor validation fixes
- ECL processing bugs
- Publishing: better logging, and fix timeout & restart error

### Tx Conformance Statement

FHIRsmith passed all 2503 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.1, runner v6.9.10)

## [v0.9.6] - 2026-05-21

### Added

- increase timeout when publishing IGs (for US Core)

### Fixed

- Replace re2-wasm with re2js in library/regex-utilities.js to eliminate the underlying WASM-heap leak
- Fix async problem loading OMOP
- Fix memory leaks
- Don't leak database connections

### Tx Conformance Statement

FHIRsmith passed all 1649 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.1, runner v6.9.7)

## [v0.9.5] - 2026-05-16

### Fixed

- Workaround for memory leak in re2-wasm library that reduces it's severity
- Replace re2-wasm with re2js in library/regex-utilities.js to eliminate the underlying WASM-heap leak

### Tx Conformance Statement

FHIRsmith passed all 1649 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.1, runner v6.9.7)

## [v0.9.4] - 2026-05-01

### Added

- Draft MCP specification from Ontoserver

### Changed

- Update Danish SNOMED CT Extension to 2026-03-31 version.

### Fixed

- fix problem with version specific code system resolution
- fix hgvs handling of error response
- update NPM dependencies

### Tx Conformance Statement

FHIRsmith passed all 1649 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.1, runner v6.9.7)

## [v0.9.3] - 2026-04-10

### Added

- Add support for handling contained value sets
- Add beta support for ECL

### Changed

- Bump vsac fetch to 1000 and improve history presentation

### Fixed

- Fix count on empty value set

### Tx Conformance Statement

FHIRsmith passed all 1651 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.1, runner v6.9.6)

## [v0.9.2] - 2026-04-14

### Fixed

- Improve VSAC logging
- Fix SCT import to handle SCT DK

### Tx Conformance Statement

FHIRsmith passed all 1578 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.1, runner v6.9.6)

## [v0.9.1] - 2026-04-10

### Added

- TX: Add support for child-of filters

### Changed

- TX: increase vsac timeout

### Fixed

- Tidy up dashboard
- TX: fix bug listing versions when validating
- Fix support for child-of in R4/R3

### Tx Conformance Statement

FHIRsmith passed all 1578 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.1, runner v6.9.5)

## [v0.9.0] - 2026-04-09

### Added

- TX: VSAC upgrade to pick up more changes
- TX: add definition of $related operation to CapabilityStatement

### Changed

- TX: Deal with regex Denial of Service Issue
- TX: improve fragment handling in extensions per TI decision 
- TX: Reduce snomed loaded versions - have already moved to affiliate managed servers
- TX: fix bug handling excluded concepts using a filter
- improve dashboard template
 
### Fixed

- Update dependencies for security fixes
- TX: fix error in SNOMED translate for implicit concept maps
- TX: Fix OCL cache invalidation and case-insensitive concept lookups
- Publisher: fix handling of web templates folder
- Publisher: fix webtemplates table headings

### Tx Conformance Statement

FHIRsmith passed all 1578 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.1, runner v6.9.5)

## [v0.8.6] - 2026-04-06

### Added

- TX: Full support for $related operation
- Add sponsor message to footer on all pages

### Changed

- TX: Improve $expand efficiency slightly
- Rework logging for efficiency and configurability
- TX: Try to make the server more resistant to running out of memory and dying
- Improve memory reporting on dashboard and home pages
- improve metadata display for resources

### Fixed

- Fix up tx test version to be correct in capabilities statement
- Fix security warning

### Tx Conformance Statement

FHIRsmith passed all 1497 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.1, runner v6.9.4)

## [v0.8.5] - 2026-04-02

### Added

- Add support for webSource extension
- Add support for SCT filter in (codes)

### Changed

- Upgrade LOINC to 2.82
- Improve resource rendering -copy button + link

### Fixed

- Add missing code systems from search

### Tx Conformance Statement

FHIRsmith passed all 1497 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.1, runner v6.9.4)

## [v0.8.4] - 2026-04-01

### Added

- add .npmrc to defend against supply chain attacks

### Changed

- Rework extension handling to make sure uzbek loinc works - load supplements from store

### Fixed

- tx/expand: fix for bug where filter array is present but empty
- tx/SCT: support filters generalizes and child-of
- tx/SCT: fix bug evaluating property filters
- Fix version conversion issues

### Tx Conformance Statement

FHIRsmith passed all 1497 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.1, runner v6.9.4)

## [v0.8.3] - 2026-03-31

### Changed

- More dashboard improvements
- Packages: Allow javascript in the pubpack
- Publisher: Show username on publisher page
- Publisher: Allow non-admin users to delete non-approved tasks

### Fixed

- Publisher: fix task logging
- SHL: path fixes

### Tx Conformance Statement

FHIRsmith passed all 1497 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.1, runner v6.9.4)

## [v0.8.2] - 2026-03-29

### Added

- Support for implicit snomed concept maps

### Changed

- Reverse the [interpretation of RxNorm [rel] and [rela] value sets](https://chat.fhir.org/#narrow/channel/179202-terminology/topic/Inverted.20query.20for.20RELA.20in.20using.20RxNorm.20page/with/582270767)
- Improve modifier extension message
- 
### Fixed

- fix missing files from npm package
- Add missing styles to dashboard
- $translate fixes: don't return duplicate matches, handle R4/R5 issues properly, fix missed comments and products
- fix handling force-value-set version parameter

### Tx Conformance Statement

FHIRsmith passed all 1498 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.1, runner v6.9.4

## [v0.8.0] - 2026-03-27

### Added

- XIG: add JSON and CSV downloads
- TX: Add snomed filter support for inactive, moduleId, and properties

### Changed

- Improve Dashboard Presentation
- Make docker image platform compatible with apple silicon (arm)
- TX: update rxnorm version for tx.fhir.org
- TX: Improve VSAC information page

### Fixed

- XIG: fix valueset source filter
- TX: Fix bug in language processing looking up country codes
- TX: Fix up terminology search for LOINC and generally 
- TX: fix rxnorm property support and search performance
- Publisher: fix status display when building draft IG

### Tx Conformance Statement

FHIRsmith passed all 1498 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.1, runner v6.9.4)

## [v0.7.6] - 2026-03-25

### Added

- Dashboard endpoint (see dashboard.html)
- Initial cs-api documentation

### Changed

- Update package crawler to support archived feed entries

### Fixed

- OCL improvements:
   - Improve multilingual support and caching for non-OCL expansions
   - cache compose instead of pre-built expansions
- Fix ConceptMap rendering
- Ongoing on work on publishing module
- Tidy up tx-reg to prevent hanging

### Tx Conformance Statement

FHIRsmith passed all 1464 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.1, runner v6.9.3)

## [v0.7.5] - 2026-03-19

### Changed

- Support ignoring code systems when loading, and ban urn:iso:std:iso:3166#20210120 for tx.fhir.org

### Fixed

- Fix handling of user defined codes for country codes
- Fix version bug when loading supplements
- FHIRsmith passed all 1460 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.1-SNAPSHOT, runner v6.9.0)

### Tx Conformance Statement

FHIRsmith passed all 1452 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.1-SNAPSHOT, runner v6.9.0)

## [v0.7.4] - 2026-03-19

### Changed

- XIG: show using resource package explicitly
- TX: Check conformance statement production at start up

### Fixed
- TX: Load URI provider on tx.fhir.org
- TX: fix error getting SCT version for html format

### Tx Conformance Statement

FHIRsmith passed all 1452 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.1-SNAPSHOT, runner v6.9.0)

## [v0.7.3] - 2026-03-19

### Changed

- Show total memory on home page
- OCL improvements
- Publisher: Allow editing websites
- Publisher: separate out target folder and git folder
- Publisher: use trusted git repo for ig_registry
- Extend XIG for phinvads analysis

### Fixed
- Don't exempt tx/data from npm project
- SNOMED CT fix: align getLanguageCode with mapLanguageCode byte mapping

### Tx Conformance Statement

FHIRsmith passed all 1452 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.1-SNAPSHOT, runner v6.9.0)

## [v0.7.2] - 2026-03-16

### Added
- Folders module to support kindling 
- Extension Tracker to support IG Usage Stats

### Changed
- Return valueset-unclosed as valueString instead of valueBoolean

### Fixed
- Imported include excludes were ignored
- expansion.total inconsistent fixed
- $expand filter for SNOMED
- high-severity npm audit vulnerabilities (flatted, liquidjs, minimatch, underscore, fast-xml-parser)
- Showing hostname in all circumstances
- OCL issue: robust hash-based cold cache loading for ValueSet expansions. Ensure cacheKey and fingerprint are used for reliable retrieval and integrity.

### Tx Conformance Statement

FHIRsmith passed all 1452 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.1-SNAPSHOT, runner v6.8.2)

## [v0.7.1] - 2026-03-14

### Added
- Add web interface for ConceptMap

### Changed
- Change status out parameter on $validate-code from string -> code

### Fixed
- Fix handling of markdown in release process
- OCL cache fixes
-
### Tx Conformance Statement

FHIRsmith passed all 1452 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.1-SNAPSHOT, runner v6.8.2)

## [v0.7.0] - 2026-03-13

### Added
- Add support for serving for OCL TX content (h/t Italo Macêdo from the OCL team)
- Add default configurations (wip)

### Changed
- Make web-crawlers more robust after tx.fhir.org crash
- Don't accept NPM packages that have .js code or install scripts

### Fixed 
- Fix many bugs in expansion and validation for value sets that include two different versions of the same code system
- Fix CodeSystem search on system parameter to reduce user confusion
- Fix CodeSystem search such that default search is without any specified source
- Fix headers sent multiple times error

### Tx Conformance Statement

FHIRsmith passed all 1452 HL7 terminology service tests (modes tx.fhir.org+omop+general+snomed, tests v1.9.1-SNAPSHOT, runner v6.8.2)

## [v0.6.0] - 2026-03-06

### Added
- Add support to packages server for scoped packages
- Add support for exclusions and content tracking in tx-registry
- Add support for serving a host

### Changed
- fix error in SCT expression validation
- fix null error in search
- fix search for code systems with uppercase letters in their name
- rework html interface for CodeSystem and ValueSet
- further work on publisehr

### Tx Conformance Statement

FHIRsmith passed all 1382 HL7 terminology service tests (modes tx.fhir.org,omop,general,snomed, tests v1.9.0, runner v6.8.2)

## [v0.5.6] - 2026-02-26

### Changed
- Added content to TerminologyCapabilities.codeSystem
- fix LOINC list filter handling
- Improve Diagnostic Logging
- Add icd-9-cm parser

### Tx Conformance Statement

FHIRsmith 0.5.5 passed all 1382 HL7 terminology service tests (modes tx.fhir.org,omop,general,snomed, tests v1.9.0, runner v6.8.1)

## [v0.5.5] - 2026-02-26

### Changed
- Fix loading problem for multiple versions of the same code system
- Fix url matching in search to be precise

### Tx Conformance Statement

FHIRsmith 0.5.5 passed all 1382 HL7 terminology service tests (modes tx.fhir.org,omop,general,snomed, tests v1.9.0, runner v6.8.1)

## [v0.5.4] - 2026-02-25

This version requires that you delete all package content from the terminology-cache directly
by hand before running this version.

### Changed
- Improved Problem page
- Ignore system version in VSAC value sets
- Improve value set search
- better handling of code systems without a content property

### Tx Conformance Statement

FHIRsmith 0.5.4 passed all 1382 HL7 terminology service tests (modes tx.fhir.org,omop,general,snomed, tests v1.9.0, runner v6.8.1)

## [v0.5.3] - 2026-02-24

### Added
- Page listing logical problems in terminology definitions

### Changed
- Fixed many bugs identified by usage

### Tx Conformance Statement

FHIRsmith 0.5.1 passed all 1382 HL7 terminology service tests (modes tx.fhir.org,omop,general,snomed, tests v1.9.0, runner v6.8.1)

## [v0.5.1] - 2026-02-20

### Added
- Improved logging of startup conditions and failure

### Changed
- Fixed bad cron scheduled processing in XIG module

### Tx Conformance Statement

FHIRsmith 0.5.1 passed all 1288 HL7 terminology service tests (modes tx.fhir.org,omop,general,snomed, tests v1.9.1-SNAPSHOT, runner v6.8.0)

## [v0.5.2] - 2026-02-20

### Changed
- Fixed bad count reference in XIG

### Tx Conformance Statement

FHIRsmith 0.5.2 passed all 1288 HL7 terminology service tests (modes tx.fhir.org,omop,general,snomed, tests v1.9.1-SNAPSHOT, runner v6.8.0)

## [v0.5.0] - 2026-02-19

### Added
- Prototype Implementation of $related operation

### Changed
- A great deal of QA work preparing the server to run tx.fhir.org, which led to 100s of fixes

### Tx Conformance Statement

FHIRsmith passed all 1288 HL7 terminology service tests (modes tx.fhir.org,omop,general,snomed, tests v1.9.1-SNAPSHOT, runner v6.8.0)

## [v0.4.2] - 2026-02-05
### Changed
- Even More testing the release process; some tidy up to testing data

## [v0.4.1] - 2026-02-05
### Changed
- More testing the release process; some tidy up to testing data

## [v0.4.0] - 2026-02-05
### Changed
- Just testing the release process; some tidy up to testing data

## [v0.3.0] - 2026-02-05
### Added
- Add first draft of publishing engine

### Changed
- Move all runtime files to a data directory, where an environment variable says. Existing configurations MUST change
- Finish porting the terminology server
- Lots of QA related changes, and consistency.

## [v0.2.0] - 2026-01-13
### Added
- port tx.fhir.org to FHIRsmith, and pass all the tests

### Changed
- rework logging, testing, etc infrastructure

## [v0.1.1] - 2025-08-21
### Added
- set up ci and release workflows with Docker
- Add tx-reg implementation

### Changed

- rework logging from scratch 

## [v0.1.0] - 2025-08-20

First Documented Release 

### Added
- SHL Module: Support services for SHL and VHL implementations
- VCL Module: Support services for ValueSet Compose Language 
- XIG Module: The Cross-IG Resource server 
- Packages Modules: The server for packages2.fhir.org/packages 
- Testing Infrastructure
