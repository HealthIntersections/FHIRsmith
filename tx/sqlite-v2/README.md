# sqlite-v2: terminology files

The `sqlite-v2` providers (`tx/sqlite-v2/`) serve SNOMED CT, LOINC and RxNorm from one SQLite file per
code system version. The importers in `tx/importers/` write those files; the format is
`tx/importers/sqlite-v2/schema.sql`. A file says what it is in `meta` `format` = `tx-terminology/1`
and `PRAGMA user_version = 1`.

## The model

A file holds one code system version as **nodes**, a **catalog** and **statements**.

- **Nodes.** Concepts have ids 1..N, active ones first. Items (terms, descriptions, atoms,
  definitions) hang under a concept and have ids above N. Both share one id space, so a statement
  can be about either, and a set of concepts is a dense bitmap.
- **Statements** come in four shapes. The shape follows from the structure of the fact, not from the
  terminology:

  | shape | table | read | examples |
  |---|---|---|---|
  | subject -> node | `link` | by subject; by target through `ix_in` | SNOMED CT relationships, LOINC parts and answer lists (ordered), RxNorm RELA, ancestor pairs |
  | subject -> value | `literal` | by subject; sets in `ix_set` | concrete values, TTY, STATUS, effectiveTime |
  | value -> subject | `identifier` | by value; by subject through `ix_by_subject` (rows with `by_subject = 1`) | SNOMED CT alternate identifiers, ICD-11 short codes, NDC 11-digit forms, RxNorm atom relationships (optional) |
  | n-ary row about a subject | `record` | by relation, then subject | every SNOMED CT reference set, language reference sets included |

  Two-column facts are `link` or `literal`; anything with more columns, or several rows per pair, is
  a `record`. A property can have both links and literals (shape `both`: SNOMED CT attributes that
  have relationship rows and concrete values).
- **The catalog** (`property`) has one row per property, reference set, identifier scheme and
  relation. It says where the rows are and what may search them (shape, subject and target kinds,
  `filterable`, `refinable`, `wildcard`, `subsumption`, `closure_from`, `inverse_of`, unions through
  `property_member`, `ordered`, `by_target`, `by_subject`, a record's field schema). Readers never probe tables to
  find out.
- **Facts and indexes.** Fact tables hold what the release says. The `ix_*` tables are derived and
  can be dropped and rebuilt from the facts (`indexes.js`; `verify-indexes.js` checks a file). A few
  index rows need terminology logic (SNOMED CT normal forms, the SNOMED CT walk, LOINC's key order):
  the importer writes those and lists them in `meta` `derived-by-importer`. Two derived columns sit
  in fact tables, named as such: `concept.display` and `item.rank`.
- **Statistics.** A file carries `sqlite_stat1` and no `sqlite_stat4`: the builder runs `ANALYZE` and
  then drops `sqlite_stat4` (`analyze()` in `builder.js`; `vacuumFile()` drops it too). With stat4
  SQLite re-plans a `col = ?` statement on every bind (better-sqlite3 on RxNorm: `item WHERE
  concept_id = ?` 12.1 -> 8.0 us, an `ix_set` point read 16.1 -> 7.5 us without stat4); the benchmark
  requests of the four editions give the same answers at the same speed with stat1 alone. Readers
  never run `ANALYZE` or `PRAGMA optimize`.
- **Behaviour settings.** Where every server reading the file would present the system the same
  way, the file says how (`meta` `behaviour.*`, `property.filter_ops`, `property.report`, below).
  Facts about one server stay in that server.

## Tables

Fact tables:

| table | holds |
|---|---|
| `code_system` | the served system (`served = 1`; other rows only for sources that contribute items): uri, version, name, title, description, release date, content, case sensitivity, hierarchy meaning, default language, `compositional` (codes may be expressions: no expansion is closed), counts, `resource` (a CodeSystem resource without concepts, where there is one) |
| `meta` | release facts with no column (`displayContexts`, `moduleDependencies`, `languages`, `edition`, `titles`), the format, provenance (`provenance.*`: importer, sources with sha256, timings), facts about indexes (`ix.<table>.<name>`), behaviour settings (`behaviour.*`) |
| `concept` | id, code, active, display (derived) |
| `item` | id (> N), concept, kind (0 term, 1 definition), external id (description SCTID, RXAUI: INTEGER when a canonical decimal integer, else TEXT), language, use, text, active, preferred (the source's own flag), rank (derived display order). A definition is a designation too only when it has a use. An inactive item is still a designation of its concept: RxNorm stores an archived concept's RXNATOMARCHIVE atoms with `active = 0`, and they are that concept's designations |
| `item_use` | the uses (SNOMED CT description types, LOINC name kinds, RxNorm TTYs) |
| `property`, `property_member` | the catalog; a union property's members |
| `link` | subject, property, role group, target, active, seq (source order) |
| `literal` | subject, property, role group, value, active |
| `identifier` | property (the scheme), value (INTEGER when a canonical decimal integer, else TEXT; compared as text), subject, `resolves`: 0 not a code; 1 an alias, accepted as a code and answered with the subject's own code (ICD-11 short codes); 2 a code in its own right, answered as written (NDC 11-digit forms). A concept code always wins over an identifier with the same value. A probe for codes that are identifiers says `resolves > 0` as well as `value = ?`: only then does SQLite use the partial index `identifier_code` (the readers' probes do); without it the probe scans every identifier row. The catalog's `by_subject` says which properties' rows are also read by subject (`ix_by_subject`) |
| `record` | relation, subject, seq (order within the relation), target (the field the schema marks `target`, when it is a node), active, fields (JSON array of the other fields in schema order; in a field typed `c` or `n` a JSON number is a node id of this file and a JSON string a code that is not in it) |
| `value_label` | displays of literal values (LOINC CLASSTYPE 1 = Laboratory class) |
| `mapping` | maps to other systems (LOINC part and answer maps, IEEE device codes); `relationship` holds FHIR R4 ConceptMap equivalence codes (`equivalent`, `wider`, `narrower`, `relatedto`, ...), as main's providers report them |
| `resource` | resources the release defines that cannot be derived from its facts (none of the three systems has one; value sets that follow from stored records are not stored) |
| `node_extra` | FHIR extensions of a node, for round trip (none of the three systems has one) |

Index tables (rebuildable):

| table | holds |
|---|---|
| `ix_set` | Roaring bitmaps of concept ids by (kind, property, value, value kind): 1 all, 2 active, 3 leaf, 4 descendants of a concept, 5 property = value (only for properties a filter can name: `filterable = 1`, or a member of a filterable union), 6 has property (every property; for an inverse row, the targets of what it reverses), 7 record members (rows about items count for their concept) |
| `ix_in` | links by target, for the properties with `by_target = 1` (SNOMED CT children in release order, ECL reverse attributes) |
| `ix_by_subject` | identifier rows by subject (subject, property, value), for the properties with `by_subject = 1`: SNOMED CT alternate identifiers, aliases. The builder sets `by_subject = 1` on every identifier property unless the importer says otherwise; RxNorm's atom relationships (`AUI:*`, read only by value) are `by_subject = 0`. Every other identifier read goes by the primary key (property, value, subject) or `identifier_code` |
| `ix_order` | per-concept arrays in 1,024-entry blocks: `rank`, `ids` (the system order), `walk` (the whole system in the built-in walk order; `ix.ix_order.walk.reached` in meta), `active` (walk restricted to active concepts, stored only where they are not a prefix of walk: LOINC), `hier_start` / `hier` (LOINC parent and child entries in main's order, where the parent links' seq does not give it) |
| `ix_key` | text keys of nodes (SNOMED CT normal forms) |
| `ix_word` | the text-filter word index per language: word, stem, concept bitmap; the row with word `''` and stem `''` holds per-concept word counts (Uint16 by concept id) |
| `ix_text_display`, `ix_text_item` | FTS5 trigram indexes over displays and item texts (regex prefilter) |

## Behaviour settings

`meta` keys `behaviour.<key>`, JSON values. A key that is absent has its default. A reader refuses a
file with a key or value it does not know (the importers check the same at build).

| key | values | default | written by |
|---|---|---|---|
| `grammar` | `"snomed"`, `"icd11"`, `null` | `null` (plain codes) | SNOMED CT: `"snomed"` (expressions, ECL; the SNOMED CT provider). ICD-11 MMS and ICF files: `"icd11"` (postcoordinated expressions, bound over the `postcoordinationAxis` and `postcoordinationRoot` records) |
| `expansionOrder` | `"ids"`, `"stored"`, `"stored-self-first"` | `"ids"` | SNOMED CT `"stored-self-first"`; LOINC, RxNorm `"stored"`; NDC files `"stored"` (every selection, filtered or not, in `ix_order` `rank`) |
| `lookupName` | `"name"`, `"title"` | `"name"` | LOINC `"title"` |
| `description` | `"name"`, `"title"` | `"title"` | LOINC `"name"` |
| `versionAlgorithm` | a string, `null` | `null` | LOINC `"natural"`, RxNorm `"date"` |
| `designationUses` | `"keep"`, `"drop"` | `"keep"` | RxNorm `"drop"` |
| `distinctDesignationTexts` | `true`, `false` | `false` | RxNorm `true` (each atom text once, as cs-rxnorm.js) |
| `lookupSkipsMixedLinks` | `true`, `false` | `false` | SNOMED CT `true`: a `both` attribute's links are not read where no property is named (main keeps one value kind per attribute) |
| `aliasProperty` | a property code, `null` | `null` | ICD-11 MMS and ICF files `"classificationCode"`: $validate-code of a code written in its canonical form also returns its alias (an identifier with `resolves = 1`) as an output parameter of this name |
| `aliasExtension` | a URL, `null` | `null` | ICD-11 files: a Coding extension that restates the alias form of its code; $validate-code checks it against the code's alias (an error where the file has no `aliasProperty`, or the code is not in canonical form, has no alias, or the value is not its alias) |
| `preferredForLanguage` | `true`, `false` | `false` | ICD-11 and NDC files `true`: a designation whose item has `preferred = 1` and no use is reported with the use `preferredForLanguage` (`http://terminology.hl7.org/CodeSystem/hl7TermMaintInfra`) in its own language; other designations keep their stored use |
| `aliasLiterals` | an object, property code -> value | `{}` | NDC files `{"code-type": "11-digit", "synonym": "{code}"}`: a concept read through an identifier code (`resolves` 1 or 2) reports these literal values instead of its stored values of those properties; `{code}` is the concept's own code |
| `filters` | a list, `null` | `null` (every property with `filterable = 1`, with its `filter_ops`, and the server's built-in filters) | NDC files: the only filters the system understands, as FHIR CodeSystem.filter: `{"code", "operator": [...], "values": [...]}`; `values` (optional) lists the only values a filter accepts (each item of an `in` list). Any other filter, operator or value is FILTER_NOT_UNDERSTOOD. `code` names a catalog property, or `inactive` (FHIR's concept status: `= true` the inactive concepts, `= false` the active ones) |

Release facts in `meta` that a reader also presents: `titles` (JSON object, language -> the system's
title in that language; ICD-11 files). With `lookupName` = `"title"`, $lookup reports the title in the
first requested language that has one (by primary subtag), else `code_system.title`.

Per property: `filter_ops` (JSON list of the operators a filter on it accepts; RxNorm TTY, STY, SAB
and the relationships: `=`, `in`) and `report` (`named`: $lookup returns it only when asked for;
`always`: also on expansions; NULL: the server's rule; none of the three systems sets it; ICD-11 files
set `named` on `child`, `browserUrl` and `residual`, and `always` on `classificationCode` in MMS and ICF;
NDC files `named` on `kind`).

## How each terminology maps

| source | becomes |
|---|---|
| SNOMED CT concept | `concept`; module and definition status as links `moduleId` / `definitionStatusId`, effectiveTime as a literal (filterable, not refinable: ECL concept filters and the FHIR `moduleId` filter name them) |
| SNOMED CT description, text definition | `item` (external id = SCTID, use = type); the display from the edition's display refsets, then any preferred synonym, the FSN, the first description |
| SNOMED CT relationship (inferred, active and inactive), concrete value | `link` (group, seq = row order) / `literal`; one property may have both (`both`) |
| SNOMED CT language refset | `record` (role `language`, target = acceptability); `item.rank` derived with `meta` `displayContexts` |
| SNOMED CT other refsets (on concepts or on descriptions) | `record` with the field schema (effectiveTime, moduleId, the refset's own columns); members in `ix_set` kind 7 |
| SNOMED CT alternate identifier | `identifier` (`resolves = 0`) |
| SNOMED CT `child` | catalog row `inverse_of` is-a |
| LOINC terms, parts, answer lists, answers, hierarchy-only nodes | `concept`; designations as items |
| LOINC part links, CLASS, parent, Answer (ordered, seq = SequenceNumber), answers-for | `link` |
| LOINC PATH_TO_ROOT | `link` under `ancestor`, the hierarchy's `closure_from` |
| LOINC `child`, `AnswerList` | catalog rows `inverse_of` parent and of the union of Answer and answers-for |
| LOINC properties, STATUS, CLASSTYPE labels | `literal`, `value_label` |
| LOINC key order and walk | `ix_order` (derived-by-importer) |
| RxNorm RXCUI with an RxNorm atom (and archived ones) | `concept`; its RxNorm atoms as items (external id = RXAUI, use = TTY); an archived concept (only in RXNATOMARCHIVE) is inactive and its archive atoms are items with `active = 0`, still its designations |
| RxNorm TTY, SAB, SUPPRESS, STY | `literal` on the concept |
| RxNorm RXNREL concept rows | `link` under the RELA; a REL is the union of its RELAs (`RELA@REL` where a RELA occurs under two RELs; `@REL` for rows with none) |
| RxNorm RXNREL atom rows (option `atomRelationships`) | `identifier` value RXAUI1 -> the concept of RXAUI2, one per row under its pair `AUI:<REL>:<RELA>`; `AUI:<REL>` and `AUI:<RELA>` are unions of the pairs; `by_subject = 0` (read by value only) |
| ICD-11, NDC (files built by other readers of this format) | short codes `identifier resolves = 1`, 11-digit NDC forms `resolves = 2` (a form shared by two packages: `resolves = 0` on the package that loses); post-coordination axes as relation `postcoordinationAxis` (seq = axis order; fields axis, axisCode, required, allowMultiple, valueSet) and their roots as relation `postcoordinationRoot` (target = root; field axisSeq); scale value sets derived from those records, not stored; definitions as kind 1 items without a use; the Foundation entity of an MMS or ICF concept as a `mapping` row |

## How filters and ECL find their rows

A filter name resolves to one catalog row (base file, then supplements in order). The row picks the path:

| catalog field | what the compiler does | read |
|---|---|---|
| `shape = 'link'` | `=` / `in`: the property = value set of each value's concept; `exists`: has property; `regex`: the targets' displays | `ix_set` 5 / 6 |
| `shape = 'literal'` (+ `fhir_type`, `value_label`) | the stored values that match (no case; labels to values; search prefixes on numbers and dates) | `ix_set` 5 keys |
| `shape = 'both'` | a code of the file: the link set; else (and `#n`, quoted) the literal sets | `ix_set` 5 by value kind |
| `shape = 'union'` | the union of the members' sets | `ix_set` per member |
| `inverse_of` | the reversed properties from the value's concepts; `exists` one set | `link` by subject; `ix_set` 6 |
| `closure_from`, `subsumption` | hierarchy filters and ECL `<`, `<<`, `>`, `>>`, `<!`, `>!` | `ix_set` 3-6; `link`; `ix_in` |
| `ordered` | a list's members in seq (LOINC answer lists) | `link` by subject |
| `role = 'language'` | display ranking, `{{ D dialect }}`, acceptability | `record` |
| `shape = 'record'` | `^ R`, `concept in R`; `{{ M field op v }}` over the stored rows (node fields compared as node ids) | `ix_set` 7; `record` |
| `shape = 'identifier'` | `mapped:<scheme> exists`, alternate identifiers, codes that are identifiers (`resolves > 0`) | `identifier` by property and value; `identifier_code`; `ix_by_subject` (`by_subject`) |
| `refinable`, `wildcard` | ECL attribute names; `*` | the attribute's sets and links |

What stays in each system's adapter (`dialects.js`, `snomed.js`, `provider.js`) is value grammar and
upstream naming: LOINC's filter names (`answers-for`, `LIST`, `copyright`, `ancestor`,
`STATUS = NotStated`) and its answer-list order; RxNorm's `CUI:` / `AUI:` prefixes and the live
domain (concepts with a SUPPRESS literal); SNOMED CT SCTID grammar, concept filter operators, ECL
description type and dialect aliases, history profiles, the English dialect display rules; each
system's text-search names and ranking; the $lookup property lists and order.

## Importers

```
node tx/importers/tx-import.js snomed-v2 import -s <RF2 release dir> -d sct-intl-20260701.db -e 900000000000207008 --snomed-version 20260701
node tx/importers/tx-import.js snomed-v2-from-cache import -s sct_uk_20261021.cache -d sct-uk-20261021.db
node tx/importers/tx-import.js snomed-v2-from-cache inspect <file.cache ...>
node tx/importers/tx-import.js loinc-v2 import -s <LOINC release dir> -d loinc-2.83.db -v 2.83
node tx/importers/tx-import.js loinc-v2-classic import -s loinc-2.77-a.db -d loinc-2.77.db
node tx/importers/tx-import.js rxnorm-v2 import -s <RxNorm rrf dir> -d rxnorm-03022026.db -v 03022026 [--atom-relationships]
```

`snomed-v2-from-cache` and `loinc-v2-classic` reverse-load the files main's providers use, for
releases that are not at hand. Every importer stages into `<dest>.stage` beside the destination,
then numbers the concepts, writes the fact tables in key order, builds the indexes, and VACUUMs.
`tx/importers/sqlite-v2/diff.js A.db B.db` compares two files by codes (the reverse loaders are
checked against release builds with it); `verify-indexes.js <copy>` drops and rebuilds every index
table and compares.

A file of the earlier sqlite-v2 schema (user_version 5) is refused at start-up with a message to
re-import it; there is no in-place upgrade.

## Known differences from main

| case | main | sqlite-v2 |
|---|---|---|
| an unknown SNOMED CT concept in a `concept is-not-a` filter | 500 `exception` | 400 `invalid` |
| RxNorm `REL` / `RELA = AUI:<rxaui>` | follows RXNREL's atom-level rows of every source | default build: 422 FILTER_NOT_UNDERSTOOD; a file built with `--atom-relationships` answers as main |
| SNOMED CT `<attribute> = <number>` on a concrete attribute (`1142139005 = 1`) | 500 "Invalid concept ID: 1" | the concepts with that concrete value (`#1` too) |
| SNOMED CT ECL `{{ D id = <description id> }}` | the concepts of those descriptions | the same |
| SNOMED CT reference set whose members are descriptions (`^ R`, `concept in R`) | not compared on these editions | the concepts of the member descriptions |
| the opioid imported-value-set `$expand` (mix line 1685) | 422 too-costly, at its 20 s limit | 200 in 0.1 s |
| an AU refset in ECL; code `0` in the US edition; a code with its term attached; RxNorm PSN display in a VSAC value set sent as a tx-resource | `invalid`; a second issue; no `normalized-code`; rejected | `not-supported`; one issue; `normalized-code`; accepted |
| LOINC extension edition, concept 760691010000106: two synonyms both preferred, no display-refset entry | one synonym | the other |
| SNOMED CT `filter=0` with `count=0` | 20,184 on the test cache (each concept once per identifier length its range covers) | 2,227 (each concept once) |
| SNOMED CT `concept in A,B` | in list order | by concept id |
| SNOMED CT `concept generalizes X` | in its ancestor walk's order | by concept id |
| SNOMED CT `expressions = true/false` as the only filter | no codes | every concept |
| SNOMED CT `116680003 = X` (is-a as an attribute filter) | 1 code on the test cache | none |
