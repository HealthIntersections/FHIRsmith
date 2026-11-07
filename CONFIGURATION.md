# FHIRsmith Configuration

The server is configured by `config.json` in the data directory (see
[Data Directory](README.md#data-directory)), plus a few environment variables.
`config-template.json` is a starting point: it has every section, with comments.

The top level of `config.json` has the server-wide settings described here, and a
`modules` section with an entry for each module (see [Modules](#modules)).

## Server

Create a `config.json` file in your data directory (use `config-template.json` as a starting point):

```json
{
  "hostName" : "[descriptive name for the server]",
  "server": {
    "port": 3000,
    "cors": {
      "origin": "*",
      "credentials": true
    }
  },
  "modules": {
    // per modules...
  }
}
```

| Option | Default | Description |
|---|---|---|
| `server.maxBodyMB` | `50` | Largest request body accepted, in MB. A body is read whole into memory before it is parsed, so this bounds what one request can take. A bigger body gets a 413: an OperationOutcome (too-costly) on a tx endpoint, and the module's own handling elsewhere. The largest IG Publisher request seen on build.fhir.org was 1.39 MB, so 50 leaves plenty of room. The ips module reads its own bodies, with its own limit |

Behind nginx, nginx's `client_max_body_size` is checked first. If it is lower than `maxBodyMB`, nginx refuses a bigger body with its own 413 HTML page before FHIRsmith sees it, so set it at or above `maxBodyMB` to get FHIRsmith's OperationOutcome; if it is higher, `maxBodyMB` applies. Requests of over 100 MB have been seen, caused by client-side issues: choose `maxBodyMB` (default 50) and the nginx limit with that in mind. See [nginx.md](nginx.md).

## Logging

Add a `logging` section to `config.json` to control log behaviour. All fields are optional and have sensible defaults:

```json
{
  "logging": {
    "level": "info",
    "console": true,
    "consoleErrors": false,
    "maxFiles": 14,
    "maxSize": "50m",
    "flushInterval": 2000,
    "flushSize": 200
  }
}
```

| Option | Default | Description |
|---|---|---|
| `level` | `"info"` | Minimum level to log: `error`, `warn`, `info`, `debug`, or `verbose` |
| `console` | `true` | Write log lines to stdout/stderr. Disable when running as a systemd service where console output goes to the journal and is redundant |
| `consoleErrors` | `false` | Whether `error` and `warn` levels appear on the console. When `false`, errors and warnings are written to the log file only |
| `maxFiles` | `14` | Number of daily log files to retain before old ones are deleted |
| `maxSize` | `0` (unlimited) | Maximum size per log file before rotation. Accepts human-readable strings: `"20m"`, `"1g"`, or a raw byte count |
| `flushInterval` | `2000` | Milliseconds between buffered writes to disk. Increase to reduce I/O under heavy load |
| `flushSize` | `200` | Number of buffered log lines that trigger an immediate flush regardless of the timer |

Log files are written to the `logs/` subdirectory of the data directory as `server-YYYY-MM-DD.log`. A `server.log` symlink always points to the current day's file, so `tail -f data/logs/server.log` tracks the active log without needing to know the date.

## Email and the Daily Report

The server can email a short markdown report on itself once a day. It needs two things in
`config.json`: an SMTP server to send through, and someone to send to:

```json
{
  "email": {
    "host": "smtp.example.org",
    "port": 587,
    "user": "fhirsmith",
    "password": "...",
    "from": "FHIRsmith <fhirsmith@example.org>"
  },
  "dailyReport": {
    "to": ["ops@example.org"]
  }
}
```

`user`/`password` are optional (an open relay); `secure` defaults to true for port 465 and
to STARTTLS otherwise. Without an `email` block nothing is emailed, and without
`dailyReport.to` there's no report (`dailyReport.enabled: false` turns it off explicitly).

The report, titled "`{hostName}` daily report", goes out at midnight (the server's local
time), or as soon as the server is up again if it was down at midnight. It has a paragraph
on the server's stability since the last report - how much of the time it was up, restarts,
the longest outage, and any upgrade (from the run history in the statistics database, so
`stats.enabled: false` leaves the uptime unknown); a paragraph from each running module that
has something to report (by default, none do); and a paragraph on the system - version,
Node.js and OS, how long this run has been up, the log files and the free disk space they're
drawing on, plus anything the npm audit check has found (packages with known vulnerabilities and
what to do about them, or a newer FHIRsmith release). If any background task's last run failed, a
final section lists them. When the last report was sent is kept in `daily-report.json` in the data
directory.

A module takes part by implementing `dailyReport({since, now})`, returning its paragraph as
markdown (or a promise of it); an empty return means it has nothing to say that day. The
request counts a module quotes come from `stats.countsSince(since, now)`, the per-operation
counts in the statistics database for the period. The modules that report:

| Module | Reports |
|---|---|
| Terminology server | how many of each operation were performed, over all its endpoints |
| Terminology server registry | client requests answered by the API, servers registered, and any server that answered none of the registry's scans in the period |
| Packages | packages served (tarball downloads) and new package versions found by the crawler |
| XIG | pages served, and whether the database could be accessed (and whether the last download failed) |
| Testing | pages served, test reports received, and the number held |
| SMART Health Links | QR codes created (SMART Health Links and Verifiable Health Links), link accesses, and the documents stored to serve them |
| IPS | pages served, IPS documents received, and the number stored |
| Publisher | publication runs started, and how many finished successfully |

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `FHIRSMITH_DATA_DIR` | Path to the data directory | `./data` |
| `PORT` | Server port (overrides config) | from config.json |
| `NODE_ENV` | Node environment. Express and other libraries check it (in development mode, Express's error pages include stack traces). If it isn't set the server sets it to `production`, or to `development` when run with `npm run dev` | `production` |

## Modules

Each module has its own entry under `modules`, documented with the module:

| Module | Configuration |
|---|---|
| `tx` - terminology server | [tx/README.md](tx/README.md#configuration) |
| `registry` - terminology server registry | [registry/documentation/configuration.md](registry/documentation/configuration.md) |
| `packages` - package server | [packages/readme.md](packages/readme.md) |
| `shl` - SMART Health Links | [shl/readme.md](shl/readme.md) |
| `ips` - IPS documents | [ips/readme.md](ips/readme.md) |
| `testing` - test reports | [testing/readme.md](testing/readme.md) |
| `folder` | [folder/readme.md](folder/readme.md) |
| `npmprojector` | [npmprojector/readme.md](npmprojector/readme.md) |
| `token` | [token/security_guide.md](token/security_guide.md) |
| `xig`, `vcl`, `publisher` | see `config-template.json` |
