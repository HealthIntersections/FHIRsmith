# Running several FHIRsmith processes on one port (cluster mode)

One Node.js process runs JavaScript on one CPU core. A terminology server under load from
several IG Publisher builds at once can use more than that. Cluster mode runs several
copies of the server on one machine, all on the same port, and Node hands each incoming
connection to the next copy. Clients see one server.

```bash
npm run start:cluster          # same as: node cluster.js
```

This is an alternative to [running several instances behind nginx](nginx.md#routing-to-multiple-servers),
where each instance has its own port and nginx routes cached requests back to the instance
that holds the cache. In cluster mode there is nothing to route: the cache is shared.

* [Settings](#settings)
* [What is shared, and what is per worker](#what-is-shared-and-what-is-per-worker)
* [The shared resource cache](#the-shared-resource-cache)
* [Background jobs](#background-jobs)
* [What cannot run in cluster mode](#what-cannot-run-in-cluster-mode)
* [Starting, stopping, restarting](#starting-stopping-restarting)

## Settings

In `config.json`:

```json
{
  "server": {
    "port": 3000,
    "cluster": { "workers": 4 },
    "memory": { "limit": 4294967296 }
  },
  "modules": {
    "tx": {
      "enabled": true,
      "resourceCache": {
        "store": "sqlite",
        "maxBytes": 2147483648
      }
    }
  }
}
```

| Setting | Default | Meaning |
|---|---|---|
| `server.cluster.workers` | 2 | How many server processes. The `FHIRSMITH_WORKERS` environment variable overrides it. |
| `modules.tx.resourceCache.store` | `memory` | Where the `$cache-control` client caches are kept. Cluster mode needs `sqlite`. |
| `modules.tx.resourceCache.path` | `<data>/resource-cache.db` | The SQLite file. Relative paths are under the data directory. |
| `modules.tx.resourceCache.maxBytes` | none | A cap on the total size of the cached client resources (bytes of JSON). See [the size cap](#the-size-cap). |
| `modules.tx.resourceCache.touchIntervalSeconds` | 30 | How often, at most, a cache's "last used" time is written. |
| `server.backgroundJobs.lock` | off (on in cluster mode) | Turn the background-jobs lock on for separately started processes that share a data directory. |
| `server.backgroundJobs.lockFile` | `<data>/background-jobs.lock` | The lock file. |
| `server.memory.limit` | the cgroup limit, else the machine's RAM | The memory limit the memory guard works against, in bytes. Set it **per worker**: see below. |

**Both SQLite files must be on a local disk.** Never put the data directory, the resource
cache or the lock file on a network filesystem (NFS, SMB/CIFS, or a container volume backed
by one). SQLite's file locking is not reliable there, and a lock that fails corrupts the
file and lets two processes run the same background job.

**Memory.** Every worker is a whole server: it loads the library and keeps its own
expansion cache, so N workers use roughly N times the memory of one. The memory guard
(`server.memory`) reads the limit of the cgroup the server runs in, which in cluster mode is
shared by all the workers, while it measures only its own process. Set `server.memory.limit`
to the share each worker should stay under (for example the systemd `MemoryMax` divided by
the number of workers, less some headroom), or the guard will not act until the whole
group is close to its limit.

## What is shared, and what is per worker

| | Shared by all workers | Per worker |
|---|---|---|
| `$cache-control` client caches | yes (SQLite file) | |
| Background jobs (VSAC refresh, crawlers, downloads, daily report) | run by one worker, chosen by the lock | |
| Terminology content, packages, indexes | yes (the same files in the data directory) | each worker opens them |
| Expansion cache | | yes |
| Statistics and the dashboard | | yes: each page shows the worker that served it |
| Request counts in the statistics database | each worker writes its own counts to the shared database | the "total" columns are each worker's own |
| Memory guard | | yes |

Statistics and the dashboard stay per worker. Reloading the dashboard can show a different
worker each time; the uptime, request counts and task list on it are that worker's. The
daily report is sent by the worker that runs the background jobs; the request counts in it
come from the statistics database, which all the workers write to.

## The shared resource cache

With `"store": "sqlite"`, the `$cache-control` client caches live in one SQLite file that
every worker uses, so a cache started on one worker can be used, extended, checked and ended
from any other. It behaves like the memory store, with these differences:

* **Caches survive a restart.** A client can carry on with its cache-id after the server
  restarts. (With the memory store a restart loses every cache.)
* **"Last used" is written at most every 30 seconds per cache**, not on every request, so
  that steady use of a cache costs reads, not writes. A cache can therefore look up to 30
  seconds more idle than it is, and expire up to 30 seconds early against a 30 minute
  timeout. `$cache-control?mode=check` always resets the idle clock.
* **A request only loads the resources it uses.** Each request reads the list of what the
  cache holds (type, URL, version) and builds a resource only when it uses it. Nothing about
  a cache's contents is kept in memory between requests, so no worker can work from an
  out-of-date copy.
* **If a write fails**, for example because the disk is full or another process held the
  write lock for more than 5 seconds, it is tried once more; if that fails too, the request
  gets HTTP 503 with `Retry-After`. Resources a client sent are never silently dropped.

The idle timeout is `modules.tx.cacheTimeout` (minutes) as before. Any worker may run the
idle sweep; running it twice does nothing the second time. Caches that are dropped are
remembered (the last 1,000 per endpoint), so a later request carrying one of their ids is
told what happened to it: closed by the client, expired, cleared, or evicted.

### The size cap

`maxBytes` caps the total size of the client resources held (as JSON). When a write takes
the total over the cap, whole caches are dropped, least recently used first, until it is
under. The cache being written is never dropped by its own write. A client whose cache was
dropped gets `cache-id-unknown` with a message saying it was dropped to make room. The cap
covers the whole file (every endpoint). It also works with the memory store, where it covers
each endpoint separately.

For scale: in the IG Publisher traffic recorded from build.fhir.org (2,817 cache sessions,
1,866 of which uploaded resources), a typical session held 11 resources and 118 KB; 1 in
10 held over 1.2 MB; the largest held 284 resources and 3.5 MB.

## Background jobs

Some work happens on a timer rather than for a request, and writes files or databases that
all the workers share. In cluster mode exactly one worker does it: whichever holds the lock
in `<data>/background-jobs.lock`. The holder renews the lock every minute. If it stops
renewing it (it crashed or hung), another worker takes it over after 3 minutes; if it shuts
down normally, it gives the lock up at once. Each job checks the lock each time its timer
fires, so the jobs move with the lock.

| Job | In cluster mode |
|---|---|
| VSAC refresh (`tx`) | the lock holder refreshes; the other workers reload the value set list from the database at the same interval |
| Package crawler (`packages`), start-up crawl and schedule | lock holder only |
| XIG database download (`xig`), first download and nightly | lock holder only; the other workers notice the new file (checked every minute) and reopen it |
| Registry crawl (`registry`) | the lock holder crawls and saves; the other workers load what it saved |
| Publisher task queue (`publisher`) | lock holder only (but see [below](#what-cannot-run-in-cluster-mode)) |
| IPS document queue (`ips`) | lock holder only; it re-queues documents left half-processed when it starts running the queue |
| SHL cleanup (`shl`), TestReport retention (`testing`), `$closure` table pruning (`tx`), expired login sessions | lock holder only |
| npm audit, daily report | lock holder only |
| `$cache-control` idle sweep (`tx`) | every worker (it is safe to run more than once) |
| Expansion cache memory check, CodeSystem list refresh (`tx`) | every worker, for its own memory |
| Statistics sampling, log flushing, registry usage counts | every worker, for its own counts |

The lock can also be used without cluster mode, for separately started processes that share
a data directory: set `"server": {"backgroundJobs": {"lock": true}}` in each.

## What cannot run in cluster mode

`cluster.js` refuses to start more than one worker when the configuration has a part that
keeps state in one process's memory:

* `modules.tx.resourceCache.store` other than `sqlite`: cache-ids would only work on the
  worker that issued them.
* `modules.tx.closure.enabled`: `$closure` serialises the read-compute-write of each closure
  table with a lock in memory, so two workers could interleave updates to the same table.
* `modules.publisher`, `modules.ips`, `modules.testing`: their logins are kept in memory, so
  a user logged in on one worker is logged out when the next request reaches another.

Run those in a separate single-process server (behind the same nginx, on another path or
host), or use one worker.

## Starting, stopping, restarting

The workers start **one after another**: each starts when the one before it is listening.
The first start of FHIRsmith on a data directory builds index databases next to the npm
packages, and several processes building them at once corrupt them. Startup therefore takes
N times as long as for one process.

A worker that exits is started again (one at a time). One that keeps failing to start is
retried with a growing delay, up to a minute between tries.

`SIGTERM` or `SIGINT` to the main process stops all the workers (each shuts down as the
single server does) and then exits; a worker that has not stopped after 30 seconds is
killed. Under systemd:

```ini
[Service]
WorkingDirectory=/opt/fhirsmith
Environment=FHIRSMITH_DATA_DIR=/var/lib/fhirsmith
ExecStart=/usr/bin/node cluster.js
KillMode=mixed
MemoryMax=16G
```
