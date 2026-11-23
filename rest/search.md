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
| `_has` | `_has:Type:reference:parameter=value`, nested up to 3 levels |
| chains | `subject.name=x`, `subject:Patient.name=x`, up to 3 links |
| `_filter` | operators `eq` `ne` `co` `sw` `ew` `gt` `lt` `ge` `le` `ap` `sa` `eb` `pr` `po` `ss` `sb` `in` `ni` `re`; `and`, `or`, `not`, brackets; chains through reference parameters. `sw` on a uri is `:below`; `ss` and `sb` on a token are `:below` and `:above` |

Compartment searches (`Patient/123/Observation`, `Patient/123/*`) are supported too.

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
- `_text`, `_content`, `_query`, `_contained`, `_containedType`
- filters on path elements in `_filter` (`name[...]`)
