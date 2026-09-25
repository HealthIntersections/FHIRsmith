# Testing module

Receives FHIR TestReports - from TxTester, and from any other tool that produces them - and
makes them available through a FHIR API and a set of web pages. It runs at `/testing` when
`modules.testing.enabled` is true.

## Submitting reports

    POST /testing/TestReport
    Content-Type: application/fhir+json
    Authorization: Bearer <token>        (only if a token is configured)

R4 and R5 TestReports are treated the same. A report is accepted if it is JSON, has
`resourceType: TestReport`, and has `name`, `status`, `result`, `tester`, `issued` (a valid
dateTime) and at least one `participant` with a `uri`. `score`, if present, must be a number.
Nothing else is checked.

The server gives the report a new id (any id sent is ignored), sets `meta.lastUpdated` to the
time it was received, and drops `meta.versionId`: reports can't be changed once received, so
there are no versions. Sending the same report twice stores it twice.

Responses follow the spec: `201 Created` with a `Location` header, and the stored report,
or nothing (`Prefer: return=minimal`), or an OperationOutcome (`Prefer: return=OperationOutcome`).
Errors are OperationOutcomes: 400 (not JSON, or not an acceptable TestReport), 401 (token),
413 (too big), 415 (not JSON), 429 (rate limit).

The submitter's IP address is recorded, for tracing abuse. It is never returned by the API or
shown on any page.

FHIRsmith's own tx test run writes its results as `test-cases-report.json` in the
FHIRsmith root; `node utilities/submit-test-report.js [-server url] [-token token]` sends it
to a /testing server (by default https://testing.fhir.org/testing).

## Reading and searching

    GET /testing/TestReport/{id}
    GET /testing/TestReport?{params}
    GET /testing/metadata

Both return HTML to a browser (an `Accept` that includes `text/html`); `_format=json` or
`_format=html` overrides that.

None of the search parameters are formally defined yet, and the CapabilityStatement lists them
without definitions. What they do:

| Parameter | Type | Searches | Notes |
|---|---|---|---|
| `_id` | token | id | |
| `name` | string | name | starts with, case-insensitive; `:exact`, `:contains`, `:missing` |
| `tester` | string | tester | as for name |
| `status` | token | status | `:not`, `:missing` |
| `result` | token | result | `:not`, `:missing` |
| `testscript` | uri | testScript (R5 canonical, or R4 `reference`) | `:below` (starts with), `:missing` |
| `participant` | uri | any participant.uri | `:below` |
| `score` | number | score | prefixes; implicit precision for eq (`90` means 89.5 to 90.5); `:missing` |
| `issued` | date | issued | prefixes; dates are ranges, so `issued=2026-09` is all of September |
| `_lastUpdated` | date | when the report was received | prefixes |

Commas OR values, repeated parameters AND. `_sort` takes any of these except `_id`, comma
separated, `-` for descending; the default is newest received first. `_count` defaults to 50
and is capped at 500; paging is by `_offset`, with first/previous/next/last links. `total` is
always returned, and `_summary=count` returns only that.

Unknown parameters are ignored, with a warning OperationOutcome in the Bundle, unless the
request has `Prefer: handling=strict`, in which case they're a 400. Values that can't be
understood (a bad date or number) are always a 400.

## Web pages

* `/testing` - the list of reports, with filters (these map onto the search parameters above),
  sortable columns and paging
* `/testing/summary` - a grid of test script x participant, with the latest report (by issued
  date) in each cell and a link to all the runs. `?by=tester` makes the columns testers.
* `/testing/TestReport/{id}` - the report: header, participants, setup / tests / teardown with
  each action's result and message, anything else in the report as JSON, and the raw JSON.

Everything in a report comes from whoever sent it, so all of it is escaped, and only http(s)
URLs become links. The narrative (`text.div`) is never rendered as HTML - it appears only as
text in the raw JSON.

## Deleting

    DELETE /testing/TestReport/{id}
    Authorization: Bearer <adminToken>

Only when `adminToken` is configured; without it, nothing can be deleted through the API.

## Configuration

```json
"testing": {
  "enabled": true,
  "database": "testing.db",
  "token": "secret",
  "tokenHeader": "Authorization",
  "adminToken": "another-secret",
  "maxSize": 512000,
  "rateLimit": { "windowMinutes": 1, "max": 60 },
  "retentionDays": 365
}
```

* `database` - relative paths are under the data folder's `databases` directory
* `token` - if set, every POST must carry it in `tokenHeader` (a `Bearer ` prefix is optional).
  If not set, anyone can submit.
* `tokenHeader` - defaults to `Authorization`. `adminToken` uses the same header.
* `maxSize` - bytes; default 500 KB. Note that the server's body parsers accept up to 50 MB
  before this module sees the request; a `Content-Length` over the limit is refused before
  the body is looked at.
* `rateLimit` - POSTs per IP address per window; `max: 0` turns it off. Default 60 a minute.
* `retentionDays` - if set, reports received longer ago than this are deleted, at startup and
  daily. Default: keep everything.
