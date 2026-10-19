# SNOMED CT support in FHIRsmith: known limitations

This file records what the SNOMED CT code system provider (`tx/cs/cs-snomed.js`,
`tx/sct/*`) does not do, so that nobody has to rediscover it from the code. It is
organised by area: ECL, post-coordinated expressions, and everything else. Where
a limitation is a deliberate decision rather than unfinished work, it says so.

The import pipeline (`tx/importers/import-sct.module.js`) reads the RF2 snapshot
concept, description (including text definitions, which share the description
file layout), inferred relationship, and reference set files. It does not read
stated relationships, the OWL axiom reference sets, or the concrete value
relationship file; several of the limitations below follow from that.

## ECL

The parser (`tx/sct/ecl.js`) accepts the ECL 2.2 grammar with the exceptions
listed under "Not parsed". The evaluator (`SnomedServices.filterECL` and the
`_eval*` methods in `cs-snomed.js`) evaluates the subset listed under
"Evaluated"; anything the parser accepts but the evaluator does not implement
is reported as `UNSUPPORTED_ECL`, and a syntax error or an unknown concept as
`INVALID_ECL`. Both are OperationOutcomes with tx-issue-type `vs-invalid`.

Note that `ECLValidator.evaluate*` in `ecl.js` is an older, weaker evaluator
that the server does not use. `filterECL` is the one that matters.

### Evaluated

- All eight hierarchy operators (`<`, `<<`, `<!`, `<<!`, `>`, `>>`, `>!`, `>>!`)
  on a concept reference, on `*`, on `^ refset` and on a bracketed expression
  (applied to every member of the set), and top/bottom of set (`!!> (...)`,
  `!!< (...)`).
- `*` (every concept, active and inactive - `activeOnly` is the expansion's job).
- `^` member-of on a concept or any bracketed expression, with
  `{{ M ... }}` member filters on `effectiveTime`, `active`, `moduleId` and the
  reference set's own fields (concept, integer and string typed from the RF2
  file name). Since inactive member rows are dropped at import, `active = false`
  never matches.
- `AND` / `OR` / `MINUS` (and `,`), with the ECL 6.4 rule that conjunction and
  disjunction cannot be mixed without brackets.
- Refinements: `=` against an expression value; attribute names that are a
  concept, `*`, or any sub expression (`<< 762705008 = ...`); attribute sets
  joined by `AND`, `OR` or `,`, with brackets; attribute groups, including
  `AND`/`OR` inside and between groups; attribute and group cardinality,
  including `[0..0]`. Cardinality counts occurrences per role group, per the
  SNOMED Computable Languages Group ruling (see `_countAttributeMatches`).
- Dotted expressions (`< X . 363698007`, `. << 363698007`, `. (A OR B)`).
- `{{ C ... }}` concept filters on `active`, `definitionStatus`,
  `definitionStatusId`, `moduleId` and `effectiveTime`.
- `{{ D ... }}` description filters on `term` (match semantics: each word of
  the search term starts a word of the description, case-insensitively; and
  `wild:` whole-term patterns), `language`, `typeId` / `type` (syn, fsn, def),
  `dialectId` / `dialect` with acceptability sets (`(prefer)`, `(accept)` or
  acceptability concept ids; the `dialect` aliases known are en-us, en-gb,
  en-au, en-ca, en-nz, en-ie, fr-ca, fr-be, nl-be, nl-nl, es-es, sv-se, da-dk),
  `moduleId`, `effectiveTime`, `active` and `id`. The filters in one block
  must be satisfied by a single description; separate blocks may be satisfied
  by different descriptions. Only active descriptions are considered unless
  the block has an `active` filter.
- Comments (`/* ... */`), terms (`|...|`, not checked against descriptions).

### Parsed but reported as unsupported

- Reverse attributes (`R 363698007 = ...`).
- `!=` against an expression value in a refinement.
- Concrete values in refinements - numeric (`= #5`, `>= #1.5`), string
  (`= "x"`, `= match:"x"`), boolean (`= true`). The importer does not read
  `sct2_RelationshipConcreteValues_*`, so no concrete values are in the cache
  to compare against. Supporting them means extending the importer and the
  relationship record, and rebuilding every cache.
- Alternate identifiers (`"ICD10#A01.1"`, `SCTID#123`). No alternate
  identifier reference sets are loaded.
- History supplements (`{{ + HISTORY-MIN / MOD / MAX }}`). The association
  reference sets they draw on are loaded, so this is implementable.

### Not parsed

- `wild:` search terms are rejected in member filters (accepted in refinement
  string values, which are then unsupported anyway).
- A concept id must be 6-18 digits; anything else is a syntax error (this is
  what makes `<< abc` invalid rather than unsupported).

### Other ECL notes

- Description filter term matching walks the descriptions of every concept in
  the result set rather than using the text index, so `* {{ D term = "x" }}`
  on a full edition scans every description. It yields to the event loop via
  the operation's dead-check but is not fast.
- A `dialect` alias the server does not know is reported as unsupported, not
  invalid; the alias table is `ECL_DIALECT_ALIASES` in `cs-snomed.js`.

- Term checking: a wrong term after a concept id (`10200004 |Lever structure|`)
  is accepted silently. The tx-ecosystem test `expand-ecl-term-mismatch` expects
  this.
- `^` on a concept that is not a reference set yields an empty result rather
  than an error (Snowstorm's behaviour; agreed in the tx-ecosystem suite).
- The ECL result for a value set filter is cached per (value set, code system
  version), so the first expansion of a large constraint is slow and later ones
  are not.

## Post-coordinated expressions

Expressions are parsed by `SnomedExpressionParser` (`tx/sct/expressions.js`)
in SNOMED Compositional Grammar, including `===` / `<<<` definition status
markers, nested (bracketed) attribute values, concrete values and terms.
They are normalised, checked against the MRCM, and compared structurally.

### Validation

`checkExpression` rejects an expression whose refinements break the concept
model (`$validate-code` then answers `result = false`): the attribute must be
allowed on the focus concept's domain (MRCM attribute domain reference set
`723561005`), the value must satisfy the attribute's range (`723562003`,
whether that is ECL or a concrete range such as `dec(>#0..)`), the attribute
and in-group cardinality maximums apply, and an attribute the MRCM marks as
grouped must be in a role group. Known limits:

- Minimum cardinality is not enforced (it constrains a concept's own
  definition, not a refinement of it). The converse of the grouping rule
  (grouped = 0 means must not be grouped) is enforced only through the
  in-group cardinality `0..0`.
- Attributes with no MRCM rule in the loaded edition are not checked at all.
  Internationally that is `704347000 |Observes|`, `131195008 |Subject of
  information|` and `363705008 |Has definitional manifestation|`, and
  `762951001 |Has ingredient|`, whose only domain row is scoped to new
  precoordinated content (an MRCM inconsistency, not something to work around).
- An edition with no MRCM reference sets (e.g. the committed jest test cache)
  gets no concept model checking at all; the checks go inert.
- The ungrouped "Close To User Form" is rejected rather than transformed to the
  classifiable form. None of the seven Level 1 transformations in SNOMED's
  postcoordination guide (refining an existing attribute, adding a self-grouped
  attribute, adding severity, lateralising findings and procedures, adding
  context to findings and procedures) is implemented.
- Negative concrete values (`#-5`) fail to parse ("Expected character } but
  found -"). SCG permits them.
- Laterality on a non-lateralisable body structure is caught only when the
  edition carries reference set `723264001`; the tx-ecosystem test edition
  does not, so the IG suite cannot assert it.

### Subsumption

`$subsumes` on expressions works by comparing normal forms: each side is
expanded through its fully defined concepts (primitives keep their atom and
contribute their defining attributes), then matched structurally, trying every
role group pairing.

- Positive answers (`subsumes`, `subsumed-by`, `equivalent`) are sound.
  A negative answer is not provable this way: SNOMED's OWL axiom reference set
  carries general concept inclusions and property chains whose entailments are
  baked into the distributed inferred relationships for precoordinated concepts,
  but an expression is something the classifier never saw. So when no
  relationship is found and either side is an expression, the server returns an
  OperationOutcome (HTTP 422, issue code `not-supported`, tx-issue-type
  `cannot-determine`) rather than `not-subsumed`. Between two plain concepts all
  four outcomes are sound (the transitive closure is the classifier's own
  output).
- There is no reasoner. Removing the decline above would need an OWL
  classifier over the axiom reference set (which is not imported).
- Normalisation depth is capped at 50 and throws rather than truncating,
  because a truncated normal form is unsound in both directions.
- `subsumesTest` does not re-validate its inputs; `$subsumes` runs `locate()`
  (and so `checkExpression`) on both codes first.

### Lookup and display

- `$lookup` on an expression returns the rendered expression and its
  components; the normal form, parents and children properties are returned
  for single-concept expressions only.
- The display of an expression is the server's own rendering (no spaces,
  `:{...}`), and every concept in it is given its preferred term.

## Everything else

### Data not imported

- Stated relationships and the OWL axiom reference sets. Everything is driven
  by the distributed inferred relationships; there is no classification.
- Concrete value relationships (see ECL above).
- Alternate identifier reference sets.
- Inactive reference set member rows (only active rows are stored).
- Module ids and definition status on concepts are recorded by the current
  importer; caches built before mid-2026 have neither (every concept looks
  fully defined, module is 0). The jest cache `tx/data/snomed-testing.cache`
  is one of those.

### Language and display

- Description languages are mapped to a small fixed set at import
  (`mapLanguageCode`); an unknown language is recorded as English. Norwegian
  or Finnish descriptions, say, would be labelled `en`.
- `SnomedExpressionServices.codeForLanguage` has a stale language map that
  disagrees with the importer; only the term is read from it today.
- With no `displayLanguage`, every edition defaults to US then GB English
  preferred synonyms. A concept whose only English description is its FSN
  gets its national-language preferred synonym instead.
- `sharedData.defaultLanguage` is hard-coded to 1 at import and
  `getDisplayName` ignores the language argument it is passed.

### Filters and implicit resources

- ValueSet filters supported on `compose.include.filter`: `concept` (`is-a`,
  `descendent-of`, `in`), `inactive =`, `moduleId =`, `constraint =` (ECL),
  `expressions =`, and `<attributeId> = <conceptId>`. Other operators on these
  properties, and other properties, are rejected.
- Implicit value sets: `?fhir_vs`, `?fhir_vs=refset`, `?fhir_vs=refset/<id>`
  and `?fhir_vs=isa/<id>`, with optional edition and version segments.
  `?fhir_vs=ecl/<expression>` is not recognised; use a `constraint` filter.
- Implicit concept maps (`?fhir_cm=<id>`): only the four historical association
  reference sets (POSSIBLY EQUIVALENT TO, REPLACED BY, SAME AS, ALTERNATIVE).
  Simple and extended map reference sets (ICD-10, ICD-O, ...) are loaded but
  are not exposed as implicit concept maps, and reverse translation is not
  supported.
- `$closure` works through `subsumesTest`, so adding a post-coordinated
  expression to a closure table hits the `cannot-determine` rule above whenever
  it is unrelated to an existing entry.

### Text search

- The `filter` parameter on `$expand` uses an in-memory word index built the
  first time an edition is searched (`tx/sct/text-index.js`): every token of
  every active description, matched by prefix and by Porter stem. The stemmer
  is English, so in other languages only prefix matching helps. Inactive
  descriptions are not indexed.

### Known data quality traps

- The three copies of the tx-ecosystem SNOMED test edition
  (`data/terminology-cache/sct_test_*.cache`, `tx/data/snomed-testing.cache`,
  `data/snomed-testing.cache`) drift. The committed jest cache is older than
  the RF2 subset in `tx/data/snomed` and lacks module ids, definition status
  and some concepts; rebuilding it changes test expectations.
- `tx.fhir.org` (the Java server) and FHIRsmith disagree on a few expected
  results in the tx-ecosystem suite (display selection, MRCM); the suite
  records FHIRsmith's reading where Grahame has decided it.
