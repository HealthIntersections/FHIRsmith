# FHIRsmith Configuration

The server is configured by `config.json` in the data directory (see
[Data Directory](README.md#data-directory)), plus a few environment variables.
`config-template.json` is a starting point: it has every section, with comments, and every
module turned off - set `"enabled": true` on the ones you run. `config.json` is JSON, except that
it may have comments: `//` to the end of the line, and `/* ... */`.

Upgrading? See [Upgrading to 1.0.0](#upgrading-to-100).

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

### Memory

`server.memory` sets the memory guard: fractions of the memory limit (the cgroup limit, such
as `MemoryMax` on the systemd unit, or else the machine's RAM), measured against process RSS;
with a role, against the whole cgroup's private memory (see [cluster.md](cluster.md#memory)).

| Option | Default | Description |
|---|---|---|
| `server.memory.rejectFraction` | `0.85` | Above this, new requests get 503 + `Retry-After` |
| `server.memory.abortFraction` | `0.92` | Above this, running operations are aborted with 422 too-costly |
| `server.memory.trimAllocator` | `false`; `true` with a role | Whether the server returns the C allocator's free memory (`malloc_trim`, Linux) while refusing, and, with a role, once after loading. Without a role it is off unless set `true`; with one, `false` is for diagnosis. See [cluster.md](cluster.md#memory) |

### Cluster

To use more than one CPU core for terminology on one machine, a master and several tx
workers share the data directory and `config.json` (started by `node cluster.js`, or by hand
with `--role`). Their settings are in `server.cluster`, documented with the arrangement in
[cluster.md](cluster.md): the launcher's (`workers`, `maxOutstanding`, `queueSeconds`,
`recycleSeconds`, the fast lane, ...) under
[The launcher](cluster.md#the-launcher-clusterjs), and what the processes share
(`sharedCache`, `cacheAffinity`, `sharedCacheMaxMB`, `sharedClosure`) under
[Options](cluster.md#options). With no role, `server.cluster` is ignored.
The status panel's snapshot of every process (`statusSeconds`) is under
[Status](cluster.md#status).

### Statistics

`stats` sets the request counters and the graphs on `/` and `/dashboard`.

| Option | Default | Description |
|---|---|---|
| `stats.enabled` | `true` | `false`: the counters are kept in memory only |
| `stats.database` | `stats.db` | The counters' SQLite file, under the data folder's `databases` directory |
| `stats.intervalMinutes` | `10` | How often the counters are written to the database; also the graphs' sample interval, unless `sampleSeconds` is set (a server with no role, as before) |
| `stats.sampleSeconds` | `intervalMinutes`; with a role, 60 at most | How often the graphs take a sample. With a role (cluster.md), at most a minute unless set, so the graphs of a short session can be read. The graphs show 24 hours; under the launcher at most 1,440 samples a process, so with less than a minute they show less. The counters are still written every `intervalMinutes` |

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
`stats.enabled: false` leaves the uptime unknown); under the launcher (`cluster.js`), a
paragraph on the cluster - processes that exited or were recycled, how long they were
unavailable, and the requests the launcher refused or abandoned itself (see
[cluster.md](cluster.md#the-daily-report)); a paragraph from each running module that
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
| `FHIRSMITH_ROLE` | `master` or `tx-worker`, as `--role` (see [cluster.md](cluster.md#roles)). Not set: an ordinary single server | none |
| `FHIRSMITH_INSTANCE_CODE` | This process's cache-id prefix, as `--instance-code` (see [cluster.md](cluster.md#roles)) | a master: `modules.tx.instanceCode`, and with none it stops with an error; a worker: none, and it stops with an error. The launcher gives `m0`, `tx1`, ... |
| `FHIRSMITH_WORKERS` | How many tx-workers `node cluster.js` starts, as `--workers` (`server.cluster.workers`) | from the CPUs and memory |
| `FHIRSMITH_CACHE_WAIT_MS` | How long a tx-worker waits for the master to build a cache it reads (see [cluster.md](cluster.md#what-runs-where)) | `300000` (5 minutes) |
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
| `xig` | [xig/readme.md](xig/readme.md) |
| `vcl` | [vcl/readme.md](vcl/readme.md) |
| `publisher` | [publisher/readme.md](publisher/readme.md) |

## Upgrading to 1.0.0

1.0.0 is a big upgrade from 0.17 and 0.18. Most servers won't need to change any settings, but
every operator should check these. Each item says who it affects; the [CHANGELOG](CHANGELOG.md)
has the detail.

### Every server

- **Node.js 24** or later (`engines` in package.json). After upgrading Node, `npm ci` (there
  are new dependencies) - or `npm rebuild` for the native ones.
- **Start command**: `npm start` is now `node --expose-gc server.js`. A service that runs
  `node server.js` still works (the memory guard sets the flag itself), but add `--expose-gc`.
- **Memory guard** (new, on by default): above 85% of the memory limit (the cgroup's - systemd
  `MemoryMax` - or else the machine's RAM) new requests get 503, and above 92% running
  operations are aborted (422). If your memory limit is tight, check `server.memory` ([Memory](#memory)).
- **Request size**: `server.maxBodyMB` (default 50) is now a setting. nginx's
  `client_max_body_size` must be at least as big, or clients get nginx's HTML 413 rather than an
  OperationOutcome.
- **`config.json` may have comments** (`//` and `/* */`), and `config-template.json` now has
  every module turned off.
- **New, optional**: `email` and `dailyReport.to` ([the daily report](#email-and-the-daily-report) -
  nothing is sent without both), `npmAudit` (a periodic `npm audit` of the server; set
  `"enabled": false` on a server with no internet access), `accessibility.checkPanel`,
  `stats.sampleSeconds`.
- **Cluster mode** (`node cluster.js`, [cluster.md](cluster.md)) is new and opt-in: `server.js`
  runs as before.

### tx (terminology server)

- **Expansion limits**: the defaults are now `externalLimit` 10000 (was 3000) and `internalLimit`
  100000 (was 10000), and there's a new `walkLimit` (default 10 x `internalLimit`) for paging.
  The three are checked at startup: one that isn't a whole number above 0, or
  external <= internal <= walk not holding, **stops the server**. If you set any of them, check
  them. Bigger expansions now succeed, so a busy server may use more memory.
- **`Tools/Java` is no longer special**: the IG Publisher and the tx-ecosystem test runner get
  the configured limits like any client (they used to be held to 3000/10000).
- **Memory caps** with defaults (see the `Limits:` line in the startup log): `cacheMaxConcepts`,
  `cacheMaxTotalConcepts`, `expansionCacheMaxCodes`, `usageTrackerMaxCodes`,
  `usageTrackerMaxCodeLength`, `languageTagCacheSize`. A client may now get `cache-id-unknown`
  (or 422) for a `$cache-control` cache that grew too big.
- **`pruneTerminologyCache`** (new, default false): delete the databases, caches and packages
  in `terminology-cache` that the library no longer uses. Turn it on for a server that has the
  data directory to itself.
- **`instanceCode`** is checked at startup, and a cluster master needs one.
- **VSAC** (`vsacCfg`): the default `baseUrl` is https (an http one is logged as a warning);
  value sets are read from the database when asked for, with a cache sized by `valueSetCacheMB`
  (default 64); a value set version VSAC doesn't have is now not found.
- **Language packs**: a `lang-pack` or `extension-codes` supplement is used without being
  referenced only when it is marked `codesystem-supplement-global` = `true`. The
  `global-lang-pack` code is gone. If you load language packs, check they are marked.
- **Behaviour, with no setting**: `regex` filters match the whole value (LOINC regex value sets
  may select fewer codes); ICD-11 codes are entity ids; a resource that both THO and a core
  package provide is available in both versions.
- **Rebuilds** (optional, for the new features): SNOMED CT caches for alternate identifiers and
  concrete values, and any built in a time zone ahead of UTC (their effectiveTimes are a day
  early); the LOINC database for its mappings. The package value set and concept map caches
  rebuild themselves once, so the first start is slower.

### Other modules

- **registry**: `maxResponseMB` (default 100) limits what the crawler reads from a server.
- **packages**: the crawler refuses packages over its new limits (`maxDownloadMB` 250,
  `maxUnpackedMB` 4096, `maxFileMB` 50, `maxFiles` 250000); raise them only if a real package
  is refused.
- **xig**: `POST /xig/update` only works when `updateToken` is set.
- **ext-tracker**: set `token` (the IG Publisher's) so only the publisher can submit.
- **token**: the JSON API takes the API key in a header (`Authorization: Bearer` or
  `X-API-Key`), not the URL - clients must change.
- **publisher**: the administrator's password is now `adminPassword` in the config (set at
  every start). Without it, an administrator that still has the old fixed default password
  (`admin123`) gets a random one at startup, which is logged - set `adminPassword`, or look in
  the log.
- **ips**: to use a validator jar of your own, set `validator.jar`, rather than replacing
  `bin/validator_cli.jar`.

There are no manual data migrations: the databases that changed migrate themselves at startup.

