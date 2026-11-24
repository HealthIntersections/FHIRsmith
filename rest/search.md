# Search in the rest module

What an endpoint's search supports: the prefixes, the modifiers for each type of search
parameter, the common parameters, and what is not done yet. See [README.md](README.md) for the
module as a whole.

An unknown parameter or modifier is ignored, with a warning in the result Bundle (an
OperationOutcome entry, `search.mode` = `outcome`), and left out of the self link. With
`Prefer: handling=strict` it is refused with 400.

## Prefixes

On date, number and quantity parameters, and on `_lastUpdated`: `eq` `ne` `gt` `lt` `ge` `le`
`sa` `eb` `ap`.

- Dates are ranges: a date's precision is the range it covers (`2020` is the whole year), and
  a date without a time zone is in the endpoint's time zone (the `timeZone` setting; else the
  server's). Each prefix compares the search value's range with the resource's.
- `ne` with several values matches only when none of the resource's values is equal.
- `ap` on dates widens the range by 10% of the distance from now, at least a day; on numbers
  and quantities it is ±10% of the value, or the value's precision if that is wider.

## Modifiers, by type of search parameter

| Type | Supported | Values |
|---|---|---|
| string | (none): starts with; `:exact`; `:contains`; `:missing` | Accents and case are folded, except for `:exact`. `:text` is accepted, and behaves as the default |
| token | (none); `:not`; `:text`; `:code-text`; `:of-type`; `:below`; `:above`; `:in`; `:not-in`; `:missing` | `code`, `system\|code`, `\|code` (no system), `system\|`. `:text` and `:code-text` are both "starts with" on the display or text. `:of-type` is `system\|code\|value`. `:below` and `:above` use the closure table (kept up to date through the terminology server's `$closure`). `:in` and `:not-in` need the endpoint's `txServer`, and a value set of at most 10,000 codes |
| reference | (none); `:[type]` (e.g. `subject:Patient`); `:identifier`; `:missing` | A bare id, `Type/id`, `Type/id/_history/n`, an absolute URL (a local reference when it is this server's address), a canonical `url\|version` |
| date | prefixes; `:missing` | |
| number | prefixes; `:missing` | The value's precision is its range: `1.5` is [1.45, 1.55) |
| quantity | prefixes; `:missing` | `value`, `value\|system\|code`, `value\|\|code`. With a UCUM code, values are compared in canonical units, so `72\|http://unitsofmeasure.org\|kg` finds `72000 g` |
| uri | (none): exact; `:below`; `:above`; `:contains`; `:missing` | |
| composite | `:missing` | The components' values joined with `$`, matched within one repetition of the element (one component of an Observation, not two) |

Several values separated by commas are OR'd; a parameter repeated is AND'd.

## Common parameters

| Parameter | Supported |
|---|---|
| `_id` | `:not` |
| `_lastUpdated` | prefixes |
| `_tag`, `_security` | `:not`, `:missing` |
| `_profile` | `:below`, `:not`, `:missing` |
| `_list` | the id of a List on the endpoint |
| `_type` | on a search of the whole endpoint |
| `_text`, `_content` | full-text: see below |
| `_has` | `_has:Type:reference:parameter=value`, nested up to 3 levels |
| chains | `subject.name=x`, `subject:Patient.name=x`, up to 3 links |
| `_filter` | operators `eq` `ne` `co` `sw` `ew` `gt` `lt` `ge` `le` `ap` `sa` `eb` `pr` `po` `ss` `sb` `in` `ni` `re`; `and`, `or`, `not`, brackets; chains through reference parameters. `sw` on a uri is `:below`; `ss` and `sb` on a token are `:below` and `:above` |

Compartment searches (`Patient/123/Observation`, `Patient/123/*`) are supported too.

### Filters on a path step in `_filter`

A chain step can carry a filter in brackets: conditions the same target must meet, before the
path carries on.

```
performer[family eq Smith].active eq true
```

is an Observation with a performer who is both called Smith and active. Without the brackets,

```
performer.family eq Smith and performer.active eq true
```

each half is matched on its own, so an Observation whose performers are an inactive Smith and
an active Jones matches too. The two only differ when the reference can repeat (`performer`,
`participant`, `general-practitioner`...).

The filter in brackets is a whole `_filter` expression (`and`, `or`, `not`, its own chains and
brackets), about the reference's target types. Brackets go only on reference parameters, and
always with a parameter after them (`performer[...].active eq true`, not `performer[...] pr
true`). Chains, brackets included, are limited to 3 links.

## Full-text search: `_text` and `_content`

`_text` searches the narrative (the text of `text.div`, without the markup); `_content` searches
the whole resource: every string and number in it, the narrative's text included, but not the
names of the elements, the `meta`, or base64 `data`.

The value is words and phrases:

| | |
|---|---|
| `chest pain` | both words (terms next to each other are AND'd) |
| `chest AND pain` | the same |
| `pain OR ache` | either |
| `chest -child`, `chest NOT child` | chest, but not child |
| `"blood pressure"` | the phrase, as it is |
| `(pain OR ache) chest` | brackets group |

- A word matches as a prefix (`chalm` finds Chalmers); a phrase matches as it is. Accents and
  case are folded, as for string parameters (`muller` finds Müller).
- A word the index splits into several (`anna@example.org`) is matched as a phrase.
- Each part of the search needs a word that isn't negated (`-child` on its own can't be
  searched). At most 32 words and phrases, and 1,000 characters.
- `_text` and `_content` work on a chain (`Observation?subject._text=pressure`) and with
  `_type`, and take no modifiers.
- In `_filter`, `_text` and `_content` take `co` or `eq` (the same: the value is a search as
  above) and `ne`: `_text co "chest -child" and family eq smith`, `subject._content co anna`.
  A phrase inside the filter's string needs its quotes escaped: `_text co "\"blood pressure\""`.

The text is indexed with the resource, in its write transaction. A database made before
full-text search (schema version 1) gets the index when the server starts, and the master fills
it in the background; until it has, searches using `_text` or `_content` say so in the result's
OperationOutcome.

What differs between the engines:

- **MySQL ignores short words and stopwords.** Words shorter than `innodb_ft_min_token_size`
  (3 by default) aren't indexed, so they find nothing, and nor do words on MySQL's stopword
  list ("about", "the", ...). SQLite indexes every word.
- **Inside a transaction, MySQL doesn't see the transaction's own writes**: a `_text` search in
  a transaction's GET entry finds what was there before the transaction (MySQL updates a
  FULLTEXT index at commit). SQLite sees them.

## Contained resources

A contained resource that the resource refers to (`#id`) is indexed with its own type's
search parameters, so a chain reaches into it: `Patient?general-practitioner.name=smith`
finds a patient whose GP is contained, as well as one whose GP is a Practitioner of its own.
A contained resource's references are indexed too: `#id` finds a sibling, `#` the container,
and references to other resources are kept, so a chain can go on through them
(`Observation?subject:Patient.organization.name=acme`).

By default, searching a type (`Practitioner?name=smith`) doesn't find contained resources,
nor does `_has`, nor does `_include` bring them in: they come back in the resource that
contains them. `_contained` changes what a search finds:

| `_contained` | finds |
| --- | --- |
| `false` (the default) | resources of their own |
| `true` | contained resources only |
| `both` | either |

and `_containedType` what comes back for a contained resource that matches:

| `_containedType` | returns |
| --- | --- |
| `container` (the default) | the resource that contains it, once however many of its contained resources match, with mode `match`; `total` counts containers |
| `contained` | the contained resource itself, with the fullUrl `[base]/[container type]/[container id]#[local id]`; `total` counts contained resources |

For a contained resource, `_id` is its local id, and `_lastUpdated` its container's;
`_tag`, `_profile`, `_security`, `_list`, `_text` and `_content` don't find it. A compartment
search (`Patient/123/Observation?_contained=true`), and a user limited to compartments, go by
the container. Sorting and paging work as for anything else; `_include` and `_revinclude`
work from contained matches (`Practitioner?_contained=true&_containedType=contained&_revinclude=Patient:general-practitioner`
brings in the patients that contain them).

A contained resource that nothing refers to isn't indexed, so no search finds it, nor is one
past the first 100 in a resource.

A reference to a contained resource that isn't there (`#nobody`) makes the resource invalid:
422. (Resources that were stored before this was checked are indexed regardless, with the
reference going nowhere.)

## Results

| Parameter | |
|---|---|
| `_sort` | several keys, `-` for descending; by any search parameter but composites, `_id` and `_lastUpdated` |
| `_count` | page size: the endpoint's `defaultCount`, at most its `maxCount` |
| `_total` | `none`, `estimate`, `accurate`. Above `searchMaxResults` (20,000 by default) the total is only given when asked for as `accurate` |
| `_summary` | `true`, `text`, `data`, `count`, `false` |
| `_elements` | the elements to keep (with the mandatory ones) |
| `_include`, `_revinclude` | `Type:parameter`, `Type:parameter:target`, `Type:*`, `*`; `:iterate` (up to 3 rounds, at most 1,000 resources a page) |

A search that needs more than one page keeps its results (up to `searchMaxResults`) for
`searchKeepMinutes` (30 by default); the paging links are
`[base]?_getpages=[id]&_offset=[n]&_count=[n]`, which any process can serve, but only to the
user who ran the search.

## Not supported yet

- `:text-advanced`, and `:text` on references
- `:above` and `:below` on references (canonical version matching)
- `:not` on anything but tokens and `_id`, `_tag`, `_security`, `_profile`
- `:code-text` as it is defined (matching the code's display): it is treated as `:text`
- `_query`
- relevance ranking for `_text` and `_content`, and `:text-advanced`
