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
* [Logins, rate limits, $closure tables](#logins-rate-limits-closure-tables)
* [Background jobs](#background-jobs)
* [Memory](#memory)
* [What stays per worker](#what-stays-per-worker)
* [Starting, stopping, restarting](#starting-stopping-restarting)

Every configuration runs in cluster mode: nothing a single server can do is refused.

## Settings

In `config.json`:

```json
{
  "server": {
    "port": 3000,
    "cluster": { "workers": 4 },
    "memory": { "recycleAfterSeconds": 60, "drainSeconds": 30 }
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
| `modules.tx.resourceCache.store` | `memory` | Where the `$cache-control` client caches are kept. Cluster mode always uses `sqlite`: with `memory` (or nothing) set, the workers use the SQLite store, and the log says so. |
| `modules.tx.resourceCache.path` | `<data>/resource-cache.db` | The SQLite file. Relative paths are under the data directory. |
| `modules.tx.resourceCache.maxBytes` | none | A cap on the total size of the cached client resources (bytes of JSON). See [the size cap](#the-size-cap). |
| `modules.tx.resourceCache.touchIntervalSeconds` | 30 | How often, at most, a cache's "last used" time is written. |
| `server.backgroundJobs.lock` | off (on in cluster mode) | Turn the background-jobs lock on for separately started processes that share a data directory. |
| `server.backgroundJobs.lockFile` | `<data>/background-jobs.lock` | The lock file. |
| `server.memory.limit` | the cgroup limit, else the machine's RAM | The memory limit, in bytes, of the **whole service** (all the workers together). See [Memory](#memory). |
| `server.memory.rejectFraction`, `abortFraction` | 0.85, 0.92 | Above these fractions of the limit, new requests are refused (503), and operations in the largest worker are aborted (422). |
| `server.memory.measure` | chosen | `cgroup` or `processes`: how the service's memory is measured. See [Memory](#memory). |
| `server.memory.recycleAfterSeconds` | 60 | How long the service may stay over the reject threshold before the largest worker is restarted. 0: never. |
| `server.memory.drainSeconds` | 30 | How long a worker being restarted has to finish its requests. |

**The SQLite files must be on a local disk.** Never put the data directory (the resource
cache, `cluster-state.db`, the lock file) on a network filesystem (NFS, SMB/CIFS, or a
container volume backed by one). SQLite's file locking is not reliable there, and a lock
that fails corrupts the file and lets two processes run the same background job.

## What is shared, and what is per worker

| | Shared by all workers | Per worker |
|---|---|---|
| `$cache-control` client caches | yes (`resource-cache.db`) | |
| Logins (publisher, IPS, testing, token, registry) | yes (`cluster-state.db`, or the module's own database) | |
| Session-signing secrets, when none is configured | yes (`cluster-state.db`) | |
| Rate limits (logins, task actions, submissions, lookups, npm checks) | yes: counted for all workers together | |
| `$closure` tables and their per-table lock | yes (`closure.db`; the lock is a lease in `cluster-state.db`) | |
| Background jobs (VSAC refresh, crawlers, downloads, daily report) | run by one worker, chosen by the lock; the others pick up what it wrote | |
| Terminology content, packages, indexes | yes (the same files in the data directory) | each worker opens them |
| Memory guard | yes: the limit and the measure are the whole service's | |
| Expansion cache | | yes |
| FHIR validators (SHL, IPS) | | yes: one each, see [below](#what-stays-per-worker) |
| Statistics and the dashboard | | yes: each page shows the worker that served it |
| Request counts in the statistics database | each worker writes its own counts to the shared database | the "total" columns are each worker's own |

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

## Logins, rate limits, $closure tables

State that a single server keeps in memory and that has to be the same on every worker is
in `<data>/cluster-state.db`, a SQLite file like the resource cache (WAL, a 5 second
`busy_timeout`, each change one `BEGIN IMMEDIATE` transaction):

* **Logins.** The publisher, IPS and testing modules keep their sessions there, one table
  each (the token and registry modules already kept theirs in their own databases). A user
  who logs in through one worker is logged in on all of them, and logging out on one logs out
  everywhere. Logins also survive a restart.
* **Session secrets.** A module with no `sessionSecret` configured signs its cookies with a
  random secret. In cluster mode the first worker to start makes it and stores it, and the
  others use the same one. Configuring `sessionSecret` is still better.
* **Rate limits.** Every limiter counts in one table, so a limit of 20 login attempts in 15
  minutes is 20 for the service, not 20 per worker.
* **Leases**: named locks across processes for work that waits on something. `$closure`
  serialises each call on a table (read the table, work out what's new, write it): within a
  worker by a queue, and across workers by a lease on the table, taken by the call at the head
  of the worker's queue, within the same `lockTimeout`. A lease is renewed while it is held,
  and lapses after 30 seconds if its process dies. `maxQueue` counts the calls waiting in each
  worker. `maxTables` is checked in the same transaction that creates a table, so two workers
  creating tables at once can't go over it together.

With one process none of this file is used, and logins and rate limits are in memory as
before.

## Background jobs

Some work happens on a timer rather than for a request, and writes files or databases that
all the workers share. In cluster mode exactly one worker does it: whichever holds the lock
in `<data>/background-jobs.lock`. The holder renews the lock every minute. If it stops
renewing it (it crashed or hung), another worker takes it over after 3 minutes; if it shuts
down normally, it gives the lock up at once. Each job checks the lock each time its timer
fires, so the jobs move with the lock.

| Job | In cluster mode |
|---|---|
| VSAC refresh (`tx`) | the lock holder refreshes; the other workers catch up by the database's generation (below) |
| Package crawler (`packages`), start-up crawl and schedule | lock holder only; it writes its status (running, runs, the log) to `packages/crawler-status.json`, which the other workers' status, log and stats pages read when it changes |
| XIG database download (`xig`), first download and nightly | lock holder only (an update asked of another worker runs there, under a lease, so two never download at once); the other workers notice the new file on their next request and reopen it |
| Registry crawl (`registry`) | the lock holder crawls and saves `registry-data.json` (written whole and renamed into place); the other workers load it on their next request after it changes |
| Publisher task queue (`publisher`) | lock holder only (but see [below](#what-cannot-run-in-cluster-mode)) |
| IPS document queue (`ips`) | lock holder only; it re-queues documents left half-processed when it starts running the queue |
| SHL cleanup (`shl`), TestReport retention (`testing`), `$closure` table pruning (`tx`), expired login sessions | lock holder only |
| npm audit, daily report | lock holder only |
| `$cache-control` idle sweep (`tx`) | every worker (it is safe to run more than once) |
| Expansion cache memory check, CodeSystem list refresh (`tx`) | every worker, for its own memory |
| Statistics sampling, log flushing, registry usage counts | every worker, for its own counts |

**How the other workers catch up.** A worker that doesn't run a job finds out what the job
wrote when a request needs it, not on a timer, and the check is cheap enough to make on use:

* **VSAC**: the VSAC database keeps a generation number. The worker that syncs adds one to it
  in the same transaction that records the end of the sync (and after an operator resyncs one
  value set). Each worker remembers the generation its value set list was loaded at. When a
  request uses the VSAC value sets, the worker reads the generation (one read by primary key,
  at most once a second) and reloads the list only if it has changed. The reload runs in the
  background, and the list is replaced in one step when it is ready; the request that noticed
  uses the list it has. A sync is therefore visible on every worker about a second after it
  finishes.
* **XIG, registry, package crawler**: the job replaces a file whole, so the file's identity
  (inode, size, modification time) is its version. A worker compares it with the version it
  read (one `stat`, at most once a second, when a request reaches that module) and reads the
  file again only when it differs.

The lock can also be used without cluster mode, for separately started processes that share
a data directory: set `"server": {"backgroundJobs": {"lock": true}}` in each. The shared
logins, rate limits and leases then apply to them too.

## Memory

Every worker is a whole server: it loads the library and keeps its own expansion cache, so N
workers use roughly N times the memory of one. They run in one cgroup (the systemd unit, the
container), and the kernel's limit applies to all of them together. So in cluster mode the
memory guard works on the **whole service**: its limit is the service's, its measure is the
service's, and the workers act on it together.

**The limit**: `server.memory.limit` if set (for the whole service), else the limit of the
cgroup the service runs in (`MemoryMax`, the container limit), else the machine's RAM.

**The measure**:

* **Linux, with a cgroup limit of the service's own** (`MemoryMax` on the unit or on a
  `systemd-run --scope`, a container's limit): the cgroup's private memory, `anon` in
  `memory.stat` (cgroup v1: `total_rss`). This is the memory the kernel can't take back. The
  page cache (the terminology databases, the SQLite files) is left out: the kernel drops it
  when it needs the room. Each worker reads it directly.
* **Anywhere else** (macOS, Windows, or Linux where the limit is only on an enclosing slice
  shared with other services, or there is none): every worker sends the primary its RSS every
  second; the primary adds them up (with its own) and sends each worker the total and the RSS
  of each worker. A worker's own part is brought up to date between reports.

`server.memory.measure` (`"cgroup"` or `"processes"`) forces one or the other. The start-up
log of the primary and of each worker says which is used.

**What happens**:

* Above `rejectFraction` (85%) of the limit, **every** worker refuses new requests with 503 and
  `Retry-After`, as a single server does when it is itself over.
* Above `abortFraction` (92%), operations are aborted (422 too-costly) **only in the largest
  worker** by RSS, or in a worker holding more than 1.5 times its share of the abort
  threshold (the threshold divided by the number of workers). The largest worker is the one
  most likely to hold the operation that took the service over, and aborting there frees the
  most; the operations in the other workers carry on. Without this, one heavy request in one
  worker would abort everyone's work. The 1.5 times share lets two heavy workers both abort in
  the same round. A worker that is spared logs that the service is over but it is not the
  largest.
* If the service stays above `rejectFraction` for `recycleAfterSeconds` (60), the primary
  **recycles the largest worker**: it stops taking new connections (the primary hands them to
  the other workers), closes its idle keep-alive connections and each busy one after its
  response, finishes the requests it has for up to `drainSeconds` (30), and exits; it is
  killed if it hasn't exited 10 seconds after that. cluster.js then starts it again. One
  worker is recycled at a time, never while another is starting, and while the service stays
  over, each further recycle waits twice as long as the last (up to 15 minutes), so a service
  whose workers are simply too big for the limit is not restarted in a loop.

Size the limit for the whole service: N workers' baseline (the library, the expansion
caches) plus what the requests need. With one process (`node server.js`, or one worker), the
guard measures that process's RSS against the limit, as it always has.

## What stays per worker

These keep state in each worker's memory, and are correct per worker:

* **Statistics and the dashboard**: each page shows the worker that served it (above).
* **The expansion cache**: each worker caches its own expansions.
* **FHIR validators** (the SHL module's and the IPS module's): each worker runs its own
  validator, because the validator service belongs to the process that started it. The first
  worker uses the configured port; the others take free ports, and each writes its own tx log
  (`<name>-<worker>.log`). The validator jar is downloaded or updated by one worker at a time.
  Each validator is a Java process in the service's cgroup: count N of them in the memory
  limit.
* **The npm projector** (`npmprojector`): each worker watches the package folder and reloads
  when it changes. `POST /_reload` reloads the worker that receives it; the others reload when
  their watchers see the change.
* **Packages loaded into the IPS validator** for national profiles, and the IPS module's
  extension lookups, are remembered per worker (each has its own validator).

## Starting, stopping, restarting

The workers start **one after another**: each starts when the one before it is listening.
The first start of FHIRsmith on a data directory builds index databases next to the npm
packages, and several processes building them at once corrupt them. Startup therefore takes
N times as long as for one process.

A worker that exits is started again (one at a time). One that keeps failing to start is
retried with a growing delay, up to a minute between tries. A worker recycled for memory is
started again at once (see [Memory](#memory)).

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
