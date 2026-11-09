# XIG - the Cross-IG resource browser

The `xig` module serves the FHIR Cross-IG index: every conformance resource (profiles, value
sets, code systems, extensions, ...) in every published implementation guide package, with a
page for each and a searchable list.

The content is a SQLite database built elsewhere, by the IG statistics process, and published
at `https://fhir.org/guides/stats/xig.db`. This module downloads it and serves it read-only. It
doesn't build or change it.

This module exists to run fhir.org's own service; it isn't designed for anyone else to run,
though nothing stops you.

## Configuration

In `config.json`, under `modules`:

```json
"xig": {
  "enabled": true,
  "autoUpdate": true,
  "updateToken": "a-long-random-string"
}
```

| Setting | Default | Description |
|---|---|---|
| `enabled` | false | Run the module, at `/xig` |
| `autoUpdate` | true | Download the database again every night at 02:00 (server time). `false` keeps whatever is there |
| `updateToken` | none | A shared secret for `POST /xig/update`, which downloads the database now. Send it in the `x-update-token` header (or from the form on `/xig/stats`). Without it, that endpoint is turned off. The nightly update doesn't need it |

The database is kept at `xig/xig.db` in the data directory. If it isn't there at startup, it is
downloaded a few seconds after the server starts; until then the pages say there's no
database. A download replaces the database only once it is complete.

The database's HTML fragments are shown as they are, so the download URL is fixed to fhir.org
(over https) and isn't a setting.

## Endpoints

| Path | What |
|---|---|
| `GET /xig` | The resource list, filtered by FHIR version (`ver`), authority (`auth`), realm (`realm`), resource type (`rt`), type (`type`), package (`pkg`), text (`text`) and `onlyUsed`; paged by `offset` |
| `GET /xig/resource/{package}/{type}/{id}` | One resource |
| `GET /xig/{package}/{type}/{id}` | The same, by a shorter path |
| `GET /xig/stats` | Statistics: the database, its updates, and requests |
| `GET /xig/status` | The database's status, as JSON |
| `GET /xig/cache` | Cache statistics, as JSON |
| `POST /xig/update` | Download the database now (needs `updateToken`) |

The list and resource pages can be asked for as JSON or CSV as well as HTML (`_fmt=json` or `_fmt=csv`, or an `Accept`
header).
