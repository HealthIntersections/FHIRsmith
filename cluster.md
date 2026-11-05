# A master and terminology workers on one machine

One Node.js process runs JavaScript on one CPU core. A terminology server under load from
several IG Publisher builds at once can use more. FHIRsmith can run as one **master** and
several **tx-workers** on the same machine and data directory, with a front door that sends
each request to the right process:

```bash
node cluster.js                 # the master, 2 workers, and a proxy on the configured port
```

or with nginx in front of separately started processes ([below](#with-nginx)).

`node server.js` with no `--role` is unchanged: one process, every module, as before.

* [Roles](#roles)
* [What runs where](#what-runs-where)
* [Routing](#routing)
* [The launcher (cluster.js)](#the-launcher-clusterjs)
* [Graphs](#graphs)
* [With nginx](#with-nginx)
* [Options](#options)
* [Memory](#memory)
* [Limits of this arrangement](#limits-of-this-arrangement)

## Roles

```bash
node server.js --role=master    --instance-code=m0  --port=3001
node server.js --role=tx-worker --instance-code=tx1 --port=3002
node server.js --role=tx-worker --instance-code=tx2 --port=3003
```

| Flag | Environment | Config | Meaning |
|---|---|---|---|
| `--role` | `FHIRSMITH_ROLE` | | `master` or `tx-worker`. None: an ordinary single server. |
| `--instance-code` | `FHIRSMITH_INSTANCE_CODE` | `modules.tx.instanceCode` (master only) | Prefixed onto every cache-id the process issues (see [nginx.md](nginx.md#instance-codes)). Each process needs its own, 1-16 letters and digits. A worker must be given one, since the config's is shared with the master. |
| `--port` | `PORT` | `server.port` | The port the process listens on. |

All the processes use the same data directory and the same `config.json`. The role decides
which parts of the configuration each one acts on.

## What runs where

| | master | tx-worker |
|---|---|---|
| tx module (`/r4`, `/r5` and the other endpoints) | yes (may also serve tx requests) | yes |
| Every other module (packages, xig, registry, publisher, token, shl, ips, ...) | yes | no |
| `$closure` (the closure tables) | yes | no: routed to the master (yes, with [`sharedClosure`](#options)) |
| Syndication feed (the store) | yes | no: routed to the master |
| VSAC sync, and the resync form on `/info/vsac` | yes | no: reads what the master wrote |
| Package crawler, XIG download, registry crawl, daily report, npm audit | yes | no (those modules don't run) |
| IANA media types registry (`terminology-cache/media-types.xml`), downloaded at each load | yes | no: reads the master's copy (none: a warning, and no `registered` filter) |
| Statistics database, uptime history | yes | no: in memory only |
| `$cache-control` caches | its own, in memory (shared, with [`sharedCache`](#options)) | its own, in memory (shared, with [`sharedCache`](#options)) |
| Expansion cache, CodeSystem list refresh | its own | its own |
| Log file | `logs/server-<date>.log` | the same file (lines interleave) |

The master loads the terminologies like any tx server: `$closure` needs subsumption.

**VSAC.** The master syncs, and when a sync has written its value sets it adds one to a
generation counter in the VSAC database. A worker remembers the generation its value set list
was loaded at. When a request uses the VSAC value sets, the worker reads the counter (one read
by key, at most once a second) and reloads the list in the background if it has moved, so a
sync reaches every worker about a second after it finishes. The database is in WAL mode with a
5 second busy timeout, so a worker's reload doesn't make the master's writes fail.

**The package caches are the master's.** The value set and concept map caches in each
package folder (`.valuesets-2.db`, `.conceptmaps-2.db`) are built, rebuilt and migrated only
by the master; it has finished every one before it answers `/health`. A worker opens them
read-only, and never creates, rebuilds or migrates one: if one is missing, incomplete or still
needs a migration (a worker started on its own, before the master), the worker waits for the
master to finish it, and after 5 minutes (`FHIRSMITH_CACHE_WAIT_MS`) stops with an error that
says so. Starting the master first is what makes the wait unnecessary, not what keeps the
workers from writing.

The same goes for the caches of a `folder:` or `file:` library source
(`terminology-cache/folder-source-master-<hash>`, one folder for every process). Each time the
master loads the library it rebuilds them in a temporary sibling folder and renames it into
place, so a running worker never finds one half built; a worker reads the new one when it next
starts. Only the master removes the folders of sources no longer loaded.

**Nothing else is shared.** The workers run no module but tx, so they never read what the
package crawler, the XIG download or the registry crawl write.

## Routing

Whatever the front door, the rules are the same:

1. `$closure` (in any endpoint, e.g. `/r4/$closure`), the syndication feed
   (`/r4/syndication...`) and the source info pages (`/r4/info/...`) go to the **master**.
2. Every path outside the tx endpoints (`/`, `/packages`, `/xig`, `/dashboard`, `/health`, ...)
   goes to the **master**.
3. A tx request with an `X-Cache-Id` goes to the process whose code prefixes the id
   (`tx2.4f0c...` to `tx2`). If that process is down, or the prefix is unknown, it goes to any
   tx process, which answers `cache-id-unknown`; the client starts a new cache.
4. Any other tx request goes to the tx process with the fewest requests outstanding: the
   workers, and the master too unless it is set not to serve tx.

The [options](#options) change rules 1 and 3: with `sharedClosure`, `$closure` goes by rule 4;
with `sharedCache`, so does a request with a cache-id (unless `cacheAffinity` is on).

## The launcher (cluster.js)

`node cluster.js` reads `config.json` from the data directory and:

* starts the master and waits until it answers `/health`. On a new data directory the master
  builds the package caches and creates the VSAC database
* listens on the configured port, and starts the workers one after another, each once the one
  before answers `/health`
* proxies each request by the rules above, over keep-alive connections to each process. It
  adds the client address to `X-Forwarded-For`, so the servers' logs and rate limits see the
  real client (its own address is a loopback one, which `server.trustProxy` trusts by default)
* starts again a process that exits. One that keeps failing waits longer each time: 1 s,
  2 s, 4 s ... up to a minute
* on `SIGTERM` or `SIGINT`: stops taking connections, closes idle keep-alive connections,
  waits for the requests in progress (up to `drainSeconds`), then sends each process
  `SIGTERM` (each shuts down as a single server does; `SIGKILL` after 30 seconds), and exits

```json
"server": {
  "port": 3000,
  "cluster": { "workers": 4, "masterServesTx": true, "internalPort": 3001, "drainSeconds": 30 }
}
```

| Setting | Flag | Default | Meaning |
|---|---|---|---|
| `server.port` | `--port`, `PORT` | 3000 | The port clients use. |
| `server.cluster.workers` | `--workers`, `FHIRSMITH_WORKERS` | 2 | How many tx-workers. |
| `server.cluster.masterServesTx` | `--master-serves-tx=false` | true | Whether the master also takes ordinary tx requests. |
| `server.cluster.internalPort` | `--internal-port` | port + 1 | The master's port; worker *n* gets this + *n*. Firewall them. |
| `server.cluster.drainSeconds` | | 30 | How long the requests in progress get on shutdown. |
| `modules.tx.instanceCode` | | `m0` | The master's instance code. The workers are `tx1`, `tx2`, ... |

Under systemd, the launcher and its processes are one unit and one cgroup:

```ini
[Service]
WorkingDirectory=/opt/fhirsmith
Environment=FHIRSMITH_DATA_DIR=/var/lib/fhirsmith
ExecStart=/usr/bin/node cluster.js
KillMode=mixed
MemoryMax=16G
```

## Graphs

With the launcher, `/` and `/dashboard` show the master and every worker as labeled
series on the existing charts. Color, marker and line pattern distinguish the processes,
with one compact legend; styles repeat after five processes, while hover labels continue
to identify each series. The dashboard still has three charts and fits the existing
`utilities/dashboard.html` monitor layout. Home has six charts. These are each process's
existing measurements; request rates and turnaround averages are not added together.
With `sharedCache`, every process samples the same shared client-cache counts, so those
lines can overlap.

Samples keep their actual timestamps. A restarting process leaves a gap and retains its
earlier history; a skipped sampling interval also leaves a gap. The legend reports
starting, restarting, unavailable or no recent sample when applicable. History lives in
the launcher for up to 24 hours, capped at 1,440 points per process (including gaps), so
short custom statistics intervals can cover less than 24 hours. A launcher restart clears
the graph history. Memory is the change in heap use since each process started, not its
absolute heap size. The uptime and request totals above the graphs remain the master's.

A standalone server, or roles started separately behind nginx, shows only its own graph
data. Combining process histories requires the launcher's IPC connection; no separate
metrics service or HTTP polling is used.

## With nginx

nginx can be the front door instead: start the processes yourself (master first, workers once
it answers `/health`), and use the configuration in
[nginx.md](nginx.md#a-master-and-tx-workers-on-one-machine), which applies the same rules.

## Options

Two options in `server.cluster` change what the processes share. Both are off by default, and
both only apply with a role: `node server.js` with no role ignores them.

```json
"server": {
  "cluster": { "workers": 4, "sharedCache": true, "sharedClosure": true }
}
```

| Setting | Default | Meaning |
|---|---|---|
| `server.cluster.sharedCache` | false | The `$cache-control` caches go in one SQLite file, `databases/resource-cache.db`, that every process reads and writes. |
| `server.cluster.cacheAffinity` | false | With `sharedCache`: still send a request with a cache-id to the process that issued it, while it is up. |
| `server.cluster.sharedCacheMaxMB` | 0 (none) | With `sharedCache`: the most the file holds. Past it, the caches least recently used are dropped whole. |
| `server.cluster.sharedClosure` | false | Every tx process answers `$closure`, on the one closure database. |
| `modules.tx.closure.writeRetries` | 10 | With `sharedClosure`: how many times an add is worked out again when another process changed the table first. |

### Shared cache

Without it, a cache lives in the memory of the process that issued it, and the routing has to
send every request that uses it there. A restarted process has lost its caches, and its
clients get `cache-id-unknown` and start new ones. The load a client brings stays on one
process.

With it, any process can answer any cache-id, and caches survive a restart of any process (or
of all of them). The launcher sends a request with a cache-id to the least-loaded tx process,
like any other. The cost is a read of the file on each use of a cache: a request reads the
list of what the cache holds, and only loads the resources it uses. Writes are short
transactions in WAL mode, so readers don't wait for them. `last_used` is written at most every
30 seconds per cache. The idle sweep (`modules.tx.cacheTimeout`) runs in every process, and
running it twice does no harm. An unknown cache-id gets a message that doesn't offer a restart
or a routing mistake as the reason, since neither can be the cause.

If another request replaces a resource after its index was read but before its content is
loaded, the request returns `409` (`CACHE_ID_CHANGED_DURING_REQUEST`). Retry the whole
request to read the new contents together. This prevents using new content under an old
expansion-cache key; unchanged resources and additions of unrelated resources still work.

`cacheAffinity: true` keeps the prefix routing on top. The expansion cache is still per
process, so a client that stays on one process finds its expansions there; without affinity,
each process does the first expansion again. The file must be on a local disk.

### Shared closure

Without it, the master answers every `$closure` request, and its per-table lock keeps the
calls on one table in order.

With it, any tx process answers `$closure`, against the same `databases/closure.db`, and the
launcher sends `$closure` to the least-loaded tx process. Within a process the per-table lock
still queues the calls on a table. Across processes the writes are **checked, not locked**. A
call works out its add against the table as it read it (its version *n*). It writes in one
`BEGIN IMMEDIATE` transaction that first checks the table is still at version *n*, and was
not reset meanwhile. If it isn't, nothing is written: the call reads the table again and works
the add out again, with the code lookups and subsumption tests it already did remembered. It
waits a few milliseconds, with jitter, between tries. After `writeRetries` tries it answers
`429` (`CLOSURE_TABLE_BUSY`), as a full queue does. Creating a table checks for one of the
same name, and for the table limit, in the same transaction as the insert. A resync reports
only entries up to the version it read. The master alone drops stale tables
(`retentionDays`).

Shared table IDs are never reused after reset or disposal, including across restarts; an
existing database is upgraded in place. An add that races a reset retries internally with
the new configuration and fresh lookup state. A resync interrupted by reset returns `409`
(`CLOSURE_TABLE_CHANGED`); retry against the new table, whose version starts at zero. If the
table was disposed without being recreated, the existing unknown-table `404` applies.

This spreads the subsumption work of `$closure` over the processes. When many processes add
to the same table at once, some adds are worked out more than once.

### What changes, by combination

| `sharedCache` | `sharedClosure` | A request with a cache-id goes to | `$closure` goes to | A restarted process |
|---|---|---|---|---|
| off | off | the process that issued it (if it is down: any, which answers `cache-id-unknown`) | the master | has lost its caches |
| on | off | the least-loaded tx process (the issuer, with `cacheAffinity`) | the master | still has every cache |
| off | on | the process that issued it | the least-loaded tx process | has lost its caches |
| on | on | the least-loaded tx process (the issuer, with `cacheAffinity`) | the least-loaded tx process | still has every cache |

The syndication feed, the `/info` pages and everything outside the tx endpoints go to the
master in every combination. For nginx, see
[nginx.md](nginx.md#with-the-shared-cache).

## Memory

With a role, the memory guard measures the whole cgroup, since the kernel's limit is on all the
processes in it together: the cgroup's private memory (`memory.stat` `anon`; cgroup v1
`total_rss`). The page cache (the terminology and SQLite files) isn't counted: the kernel drops
it when it needs the room.

* Above `server.memory.rejectFraction` (85%) of the limit, **every** process refuses new
  requests with 503 and `Retry-After`.
* Above `abortFraction` (92%), only the process with the **largest RSS** in the cgroup aborts
  its operations (422 too-costly). It is the one most likely to hold what took the group over,
  and aborting there frees the most; the others carry on.

This needs the limit on the processes' own cgroup: `MemoryMax` on the unit that runs
`cluster.js`, or a container limit. If the limit is only on an enclosing slice, or there is
none, each process measures its own RSS against the limit, as a single server does. If you
start the processes as separate systemd units, give each its own `MemoryMax`: each then guards
its own.

Each process is a whole terminology server: it loads the library, so N workers and a master
use roughly N+1 times the memory of one server. Size the limit for that.

## Limits of this arrangement

* **Caches are per process** (unless [`sharedCache`](#options) is on). A `$cache-control`
  cache lives in the process that issued it; a restarted process loses its caches, and
  clients start new ones, as after any restart.
* **Statistics are per process.** `/` and `/dashboard` show the master. The workers' request
  counts are not in the statistics database.
* **Everything the master runs is a single point.** While the master restarts, `$closure`
  (unless [`sharedClosure`](#options) is on), the non-tx modules and the dashboard answer 503
  through the launcher; tx requests carry on.
