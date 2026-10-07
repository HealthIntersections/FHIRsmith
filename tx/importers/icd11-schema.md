# ICD-11 import: database schema

Built by `tx/importers/import-icd11.js`. One database holds all three WHO code systems.

```bash
node tx/importers/import-icd11.js \
  --native https://id.who.int \
  --fhir   https://.../fhir \
  --dest   data/icd11-2026-01.db
```

Useful options: `--systems mms,icf,foundation`, `--languages all` (or `en,fr`),
`--release 2026-01`, `--concurrency 16`, `--fhir-sample 500`, `--overwrite`.

The crawl is resumable. Re-running against an existing database skips concepts already
recorded for a language, so it can be interrupted, or topped up later with
`--languages es` without refetching structure.

## Where the content comes from

The native API is the only endpoint that can enumerate the classification: GET the
linearization root for its top-level children, then `?include=descendant` on each child
for its entire subtree. That is 1 + n calls instead of one per concept, and it is what
makes a complete copy provable rather than hopeful. Each concept is then fetched
individually (with `?include=diagnosticCriteria`, which costs nothing extra) once per
language.

The FHIR endpoint contributes only its TerminologyCapabilities and a random sample of
`$lookup` responses, kept in `fhir_sample` so a provider's output can be diffed against
WHO's own server.

## Design rule

Anything with structural consequence is a column or a row: hierarchy, codes, class kinds,
selectability, postcoordination axes and their permitted values, cross references. Free
text lives in `designation`. The untouched native JSON for each concept is kept in
`concept.blob` so nothing is lost, but no query needs to open it.

## Tables

| table | what it holds |
|---|---|
| `meta` | key/value: release, languages, endpoints, tool version, request count |
| `system` | one row per code system — `mms`, `icf`, `foundation` — with its canonical url, release and `is_tree` |
| `concept` | one row per entity |
| `concept_parent` | parent/child edges, `seq` preserving the API's order |
| `concept_closure` | transitive closure including the reflexive row, so is-a never needs recursion |
| `designation` | all text, per language and kind |
| `concept_reference` | exclusions and the other non-hierarchical pointers |
| `pc_scale` | the postcoordination axes declared on a stem |
| `pc_scale_entity` | the roots of each axis; permitted values are these plus their descendants |
| `fhir_sample` | sampled `$lookup` responses |
| `crawl_lang` | resumability bookkeeping |
| `problem` | anything that failed, kept rather than discarded |

### concept

`uri` is the unversioned canonical form (`http://id.who.int/icd/release/11/mms/257068234`),
which is what the FHIR API accepts as a `code`. `entity_id` is the tail — `257068234`, or
`1363559646/other` for a residual. `code` is the short code, NULL where the entity has none.

`selectable` is 1 when the concept has a short code and `class_kind = 'category'`. Blocks
and windows have an empty code in the API and are stored as NULL; they are groupers, not
codes you may use. `residual` is `other`, `unspecified` or NULL.

`lft`/`rgt` are nested-set intervals, populated only where the hierarchy is genuinely a
tree — MMS and ICF. The Foundation is a DAG (around 9% of its entities have more than one
parent) so its intervals stay NULL and `concept_closure` is the only correct route there.
`depth` is the shortest distance from a root.

### Two ways to ask for descendants

Nested set, for MMS and ICF — a single range scan:

```sql
SELECT d.code, d.entity_id
  FROM concept a JOIN concept d ON d.system = a.system
 WHERE a.code = '1A00' AND d.lft > a.lft AND d.rgt < a.rgt;
```

Closure, correct for every system including the Foundation:

```sql
SELECT d.code FROM concept_closure cl
  JOIN concept a ON a.id = cl.ancestor
  JOIN concept d ON d.id = cl.descendant
 WHERE a.code = '1A00' AND cl.depth > 0;
```

`is-a` including self is the same query with `cl.depth >= 0`. Subsumption between two
concepts is a single primary-key probe on `concept_closure`.

### Postcoordination

`pc_scale` carries one row per axis on a stem: the axis URI, its short name, whether it is
required, `allow_multiple` (`AllowAlways` / `NotAllowed` / `AllowedExceptFromSameBlock`),
and the FHIR ValueSet canonical for that axis. `pc_scale_entity` holds the is-a roots of
the axis, so the permitted values are those roots plus their descendants.

Validating `d5409.qp3` — is `qp3` allowed on the `performance` axis of `d5409`? — needs no
JSON at all:

```sql
SELECT v.code
  FROM pc_scale ps
  JOIN concept s          ON s.id = ps.concept
  JOIN pc_scale_entity e  ON e.scale = ps.id
  JOIN concept_closure cl ON cl.ancestor = e.target
  JOIN concept v          ON v.id = cl.descendant
 WHERE s.code = 'd5409' AND ps.axis_name = 'performance';
```

The same shape answers the questions a provider has to answer: which axes exist on a stem,
which are required, whether a second value on one axis is legal, and whether a given
extension code belongs to a given axis.

### designation

`kind` is one of `title`, `definition`, `longDefinition`, `fullySpecifiedName`,
`codingNote`, `diagnosticCriteria`, `indexTerm`, `inclusion`. The display for a concept is
its `title` in the requested language:

```sql
SELECT value FROM designation
 WHERE concept = ? AND kind = 'title' AND lang = ?;
```

Index terms and inclusions are the search surface — they are what the ICD Browser matches
on — and they are held as ordinary rows so a `$expand` filter can be a LIKE or an FTS
query rather than a scan through JSON.

### concept_reference

`kind` is `exclusion`, `foundationChildElsewhere`, `relatedMaternal` or `relatedPerinatal`.
`target` is resolved to a concept id where the target is in the same system; `target_uri`
and `foundation_uri` are always kept so an unresolved reference is still visible. Labels
are language-tagged, so this table has one row per reference per language.

## Notes for the provider

- Both URI forms work as a `code` against the WHO FHIR server: versioned
  (`.../release/11/2026-01/mms/{id}`) and unversioned (`.../release/11/mms/{id}`). The
  database stores the unversioned form. Bare numeric ids are rejected by WHO, which is a
  live question in the community — see the Geneva straw poll.
- The MMS and ICF linearizations are trees; the Foundation is not. Any code that assumes a
  single parent must check `system.is_tree` first.
- A concept can have an entity id and no short code. Those are `selectable = 0` and should
  not appear as selectable in an expansion.
- Chapters are the roots: 28 in MMS (01–26, V, X), 2 each in ICF and the Foundation. They
  report no parent, which is why the FHIR API alone cannot enumerate the code system.
- `system.version` is the release the crawl ran against. Nothing in the schema is
  release-aware beyond that, so a new release means a new database.

---

# Exporting FHIR CodeSystem resources

`tx/importers/export-icd11-codesystem.js` writes CodeSystem resources out of the database.

```bash
node tx/importers/export-icd11-codesystem.js \
  --src data/icd11-2026-01.db --out out/ --gzip
```

Nine files for the 2026-01 release, plus the schema vocabulary:

| file | concepts | raw | gzipped |
|---|---:|---:|---:|
| CodeSystem-icd11-mms-2026-01.json | 37,211 | 43.5 MB | 3.9 MB |
| CodeSystem-icd11-mms-2026-01-es.json | 37,211 | 28.5 MB | 2.5 MB |
| CodeSystem-icd11-mms-2026-01-fr.json | 37,211 | 24.8 MB | 2.4 MB |
| CodeSystem-icd11-icf-2026-01.json | 1,665 | 1.6 MB | 0.1 MB |
| CodeSystem-icd11-icf-2026-01-{es,fr}.json | 1,665 | 0.7 MB each | 0.1 MB each |
| CodeSystem-icd11-foundation-2026-01.json | 71,565 | 46.1 MB | 5.1 MB |
| CodeSystem-icd11-foundation-2026-01-{es,fr}.json | 71,565 | ~18.7 MB each | ~3.1 MB each |
| CodeSystem-icd11-schema.json | 12 | 3 KB | — |

184 MB raw, 21 MB gzipped, produced in about 7 seconds. Everything is streamed, so no
resource is ever held in memory and `JSON.stringify` only ever sees one concept at a time.

## Shape

**Hierarchy.** MMS and ICF are emitted nested (`concept.concept`), which is natural for a
tree and avoids repeating parent codes; the Foundation is a DAG so it is emitted flat with
`parent` and `child` properties. `--hierarchy flat` forces flat everywhere.

**Languages.** A base CodeSystem in the first language, plus one CodeSystem supplement
(`content = supplement`, `supplements = <url>|<version>`) per additional language. This
keeps the base file usable on its own and matches WHO treating translations as separately
governed. `--languages en,fr` picks a subset.

**Codes.** `--code-form` decides what goes in `concept.code`, because the community has not:

| form | `concept.code` | notes |
|---|---|---|
| `hybrid` (default) | short code where there is one, entity uri otherwise | what the WHO FHIR server does today |
| `short` | the short code | drops the 1,519 MMS concepts that have none |
| `uri` | the unversioned entity uri, always | uniform, always present |
| `id` | the bare entity id, always | Geneva straw poll option 4, which won 7-1 |

Whichever is chosen, the others are still available as `entityId`, `uri` and `shortCode`
properties, so nothing is lost and the four can be generated and compared.

**Declarations.** The exported resources declare `filter` (concept is-a/descendent-of,
classKind, notSelectable), thirteen `property` definitions, `count`, `hierarchyMeaning`,
`compositional`, `versionNeeded`, and a `CodeSystem.valueSet` naming an all-codes value
set — all of which WHO's own CodeSystem resource omits.

## Two things worth knowing

`CodeSystem.property.type` is bound to a required value set that does **not** include
`uri`, and `concept.property.value[x]` has no `valueUri` choice — the allowed types are
code, Coding, string, integer, boolean, dateTime, decimal. Uri-valued properties are
therefore declared and emitted as strings. This is the same mistake the WHO server makes
on `ValueSet.expansion.contains.property.value[x]`, where it returns `valueUri` and no
conformant client can parse the expansion at all.

`classKind` is emitted as a `Coding`, not a `code`. `CodeSystem.property` gives no way to
say which code system a code-typed property draws its values from, so a validator assumes
the code system being defined — and `category` is not a code in ICD-11. A Coding names
`http://id.who.int/icd/schema` outright, which is why the exporter also writes
`CodeSystem-icd11-schema.json` defining the designation-use codes and class kinds.

## Validation

Validated with the HL7 validator at R5. **0 errors** on the nested ICF resource, the flat
ICF resource, an ICF supplement, and an MMS extract of 1,094 concepts covering blocks,
windows, residuals and postcoordination. The full 43 MB MMS and 46 MB Foundation files were
not validated end to end — the validator did not finish them in the memory available — but
they come off the same code paths.

The remaining warnings are all one thing: `designation.use` codes are not in
`http://hl7.org/fhir/ValueSet/designation-use`. That binding is extensible and ICD's index
terms have no standard equivalent, so this is expected rather than a defect.

## Postcoordination ValueSets

`--value-sets` (on by default) also writes one ValueSet per postcoordination axis per stem
— 25,354 of them for 2026-01, across 46 distinct axes.

They are **compose-only**. Pre-expanding the set would be 14.6 million expansion rows, with
1,743 axes carrying over a thousand members each, so membership is expressed the way WHO
expresses it: one `concept is-a` include per scale root. Resolving them needs the
CodeSystem, which is the point of shipping both together.

Filter values follow `--code-form`, so they are consistent with the CodeSystem in the same
package — 113,785 come out as short codes and 45,145 as entity uris, the latter being scale
roots that are groupers with no short code. (WHO's own value sets mix the two forms
arbitrarily.)

The axis rules have nowhere to live in a ValueSet, so four extensions carry them:

| extension | type | what it says |
|---|---|---|
| `.../schema/postcoordinationAxis` | uri | which axis this value set enumerates |
| `.../schema/stem` | uri | the concept the axis belongs to |
| `.../schema/requiredPostcoordination` | boolean | whether WHO marks the axis required |
| `.../schema/allowMultipleValues` | code | AllowAlways \| NotAllowed \| AllowedExceptFromSameBlock |

An undefined extension is an **error** to the validator, not a warning, so the exporter also
writes a StructureDefinition for each of the four. Without them the package will not load.

ValueSet ids are `icd11-{system}-{entityId}-{axis}`. FHIR caps ids at 64 characters; 35 of
them exceed that and keep a deterministic 7-character hash of the full name instead of being
blindly truncated, so two long axis names on one stem cannot collide. The exporter asserts
uniqueness as it goes.

## FHIR package

`--package` assembles everything into a FHIR NPM package — `package/` with one file per
resource, a `package.json` and a `.index.json` — and tars it with a small built-in ustar
writer, so no external `tar` is needed.

```bash
node tx/importers/export-icd11-codesystem.js \
  --src data/icd11-2026-01.db --out out/ --package
```

`who.icd11-2026.1.0.tgz`: 25,368 resources — 10 CodeSystems, 25,354 ValueSets, 4
StructureDefinitions — **23.0 MB**, built in 22 seconds. English only it is 11.7 MB.
`--package-id` and `--package-version` override the defaults; the version is derived from
the release (`2026-01` becomes `2026.1.0`) since package versions must be semver.

Verified by pointing the validator at the `.tgz` as an `-ig` and validating a ValueSet
against it: it loads and resolves. 12 ICF ValueSets validate at 0 errors, 0 warnings.
