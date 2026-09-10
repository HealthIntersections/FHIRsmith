# Changelog

All notable changes to the Health Intersections Node Server will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

## [v0.11.0] - 2026-mm-dd

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
