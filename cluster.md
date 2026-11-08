# A master and terminology workers on one machine

By default, FHIRsmith runs as simple server, where one Node.js process runs JavaScript on one CPU core.
A terminology server under load from many clients can use more than one CPU core. To support such usage,
FHIRsmith can run as one **master** and several **tx-workers** on the same machine and data directory, with
a front door that sends  each request to the right process:

```bash
node cluster.js                 # the master, workers by CPU, and a proxy on the configured port
```

with nginx in front of it, or with nginx in front of separately started processes
([below](#with-nginx)). Either way, nginx is the front door: the launcher is not built to face
clients itself.

The cluster runs behind a reverse proxy to manage security etc. Note that the reverse proxy can 
also be used to manage a virtual cluster of servers, but under such an arrangement, the servers 
are not tighly connected the way they are when FHIRsmith is run as a single cluster; we do not 
recommend mixing these two approaches together.

Also note that if you run `node server.js` directly, the cluster settings are ignored, and you get 
a normal single process server. 

## How the Cluster works

If you are looking to configure a cluster, see [below](#Configuration). You don't need to concern yourself with roles etc;
this section just explains how the cluster works.

`node server.js` with no `--role` is unchanged: one process, every module, as before. One
difference: `--port` or `--instance-code` without `--role` now stops it with an error, where
before they were ignored.

* [Roles](#roles)
* [What runs where](#what-runs-where)
* [Routing](#routing)
* [The launcher (cluster.js)](#the-launcher-clusterjs)
* [Graphs](#graphs)
  * [Request counts](#request-counts)
* [With nginx](#with-nginx)
* [Options](#options)
* [Memory](#memory)
* [How many workers](#how-many-workers)
* [Limits of this arrangement](#limits-of-this-arrangement)

The settings this uses are under `server.cluster` and `server.memory` in `config.json`;
[CONFIGURATION.md](CONFIGURATION.md#cluster) lists them with the rest of the server's
configuration and links back to the tables here.

## Roles

```bash
node --expose-gc server.js --role=master    --instance-code=m0  --port=3001
node --expose-gc server.js --role=tx-worker --instance-code=tx1 --port=3002
node --expose-gc server.js --role=tx-worker --instance-code=tx2 --port=3003
```

(`--expose-gc` lets the memory guard force a GC; the launcher adds it.)

| Flag | Environment | Config | Meaning |
|---|---|---|---|
| `--role` | `FHIRSMITH_ROLE` | | `master` or `tx-worker`. None: an ordinary single server. |
| `--instance-code` | `FHIRSMITH_INSTANCE_CODE` | `modules.tx.instanceCode` (master only) | Prefixed onto every cache-id the process issues (see [nginx.md](nginx.md#instance-codes)). Each process needs its own, 1-16 letters and digits. A worker must be given one, since the config's is shared with the master. Started by hand, a process without one stops with an error: a master with none here nor in `modules.tx.instanceCode`, or any worker. The launcher gives them `m0` (or `modules.tx.instanceCode`), `tx1`, `tx2`, ... |
| `--port` | `PORT` | `server.port` | The port the process listens on. |

All the processes use the same data directory and the same `config.json`. The role decides
which parts of the configuration each one acts on.

With a role, a process listens on `127.0.0.1` only, so only a front door on the same host
(the launcher, or nginx) reaches it. `server.cluster.bindAddress` changes that: `"0.0.0.0"`
(or `"::"`) for every interface, or one address, for an nginx on another machine. Each
process logs the address as it starts. With no role, a server listens on every interface,
as before.

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

**The VSAC, LOINC and RxNorm databases are the master's too.** The master sets them up as it
loads: the VSAC schema and content hashes, LOINC's journal mode, and the LOINC and RxNorm
indexes. A worker opens them read-only and writes nothing, so they can be on read-only storage
for the workers. The NDC, UNII, CPT and OMOP databases need no setup, and a worker opens them
read-only as well. A worker started before the master uses LOINC and RxNorm as they are
(without an index the master hasn't made yet, lookups are slower), and has no VSAC value sets
until the master has made and migrated that database.

**Nothing else is shared.** The workers run no module but tx, so they never read what the
package crawler, the XIG download or the registry crawl write.

## Routing

Whatever the front door, the rules are the same:

1. `$closure` (in any endpoint, e.g. `/r4/$closure`), the syndication feed
   (`/r4/syndication...`) and the source info pages (`/r4/info/...`) go to the **master**.
2. Every path outside the tx endpoints (`/`, `/packages`, `/xig`, `/dashboard`, `/health`, ...)
   goes to the **master**.
3. A tx request with an `X-Cache-Id` goes to the process whose code prefixes the id
   (`tx2.mhp4x2k9.4f0c...` to `tx2`). If that process is down (restarting), its caches are gone, and the
   launcher answers at once with `404` and `cache-id-unknown`, "lost to a server restart"
   (with `sharedCache`, any tx process takes it instead). If the prefix is unknown, it goes to
   any tx process, which answers `cache-id-unknown`. Either way the client starts a new cache.
4. Any other tx request goes to the tx process with the fewest requests outstanding: the
   workers, and the master too unless it is set not to serve tx.

The [options](#options) change rules 1 and 3: with `sharedClosure`, `$closure` goes by rule 4;
with `sharedCache`, so does a request with a cache-id (unless `cacheAffinity` is on).

## Nginx note about clusters

**Always run the launcher behind nginx, on the same host, with request buffering on**
(`proxy_request_buffering on`, nginx's default), as one upstream:

```nginx
upstream fhirsmith { server 127.0.0.1:3000; keepalive 32; }
# in the server block, for every location:
#   include fhirsmith-proxy.conf;   (nginx.md: the X-Forwarded-* headers)
#   proxy_pass http://fhirsmith;
```

With buffering on, nginx reads each request body whole and sends it on with a
`Content-Length`. The launcher passes a chunked body on chunked, but it has none of nginx's
limits on what clients send. The same host, because the launcher believes `X-Forwarded-Proto`
only from a loopback address: from any other it sets it to `http`, so behind an HTTPS nginx on
another machine the servers would advertise `http://` URLs, and the publisher's `Secure` login
cookie would be lost (see [nginx.md](nginx.md#headers-to-pass-to-the-server)).

## The launcher (cluster.js)

`node cluster.js` reads `config.json` from the data directory and:

* starts the master and waits until it is ready: each process the launcher starts says so on
  its IPC channel as it begins to listen, so neither a process still shutting down on the same
  port nor the memory guard (which may refuse `/health`) can mislead it. On a new data
  directory the master builds the package caches and creates the VSAC database
* listens on the configured port, and starts the workers one after another, each once the one
  before is ready
* proxies each request by the rules above, over keep-alive connections to each process. It
  adds the client address to `X-Forwarded-For`, so the servers' logs and rate limits see the
  real client (its own address is a loopback one, which `server.trustProxy` trusts by default)
* sends each process at most `maxOutstanding` tx requests at once (16); the rest wait in the
  launcher, oldest first, and one that has waited `queueSeconds` (1) is refused with 503 and
  `Retry-After`. Without this, a surge queues inside the processes, where everything waits
  behind everything else: a 4 ms `$lookup` waited 16 s in a 3x surge, and the first 503s came
  after 29 s. A request with a cache-id waits for the process that issued it, which no other
  can stand in for, so it waits longer: `ownerQueueSeconds` (30). So does any request routed
  by its cache-id's prefix (rule 3): one whose prefix no process has (any tx process may take
  it, but it waits as long), and, with `sharedCache` and `cacheAffinity`, one whose issuer is
  full. The master's own pages and paths (the dashboard, the syndication feed, `$closure`
  unless `sharedClosure` sends it to the tx processes, where it waits like any tx request,
  ...) and CORS preflights (`OPTIONS`) neither wait nor count against `maxOutstanding`, so a long page on the master leaves its tx slots free; while
  stopping nothing waits. These refusals are the launcher's, logged at most once a minute; they
  are not in the graphs' refusals
* gives cheap requests a fast lane. A process has `maxOutstanding` + `fastLaneExtra` (16 + 4)
  slots. Cheap requests may use any of them, and when a slot frees they get it first. Other
  requests use up to `maxOutstanding`, or more (up to `maxOutstanding` + `fastLaneExtra`)
  while fewer than `normalMinSlots` of them are running on the process. While they wait, the
  lane leaves them enough slots to have `normalMinSlots` (4) running on each process, so heavy work goes on during a flood of
  cheap requests. Without the lane, a 4 ms `$lookup` waits in line behind the surge (3 s, then
  503), and after it, for the line to drain. The launcher
  doesn't read bodies, so the rule is by method and path: a `GET` (or `HEAD`) of `metadata`,
  `$lookup`, `$subsumes` or `$validate-code`, whose parameters are all in the URL, so it carries
  no inline value set. A `POST` of `$lookup`, `$subsumes` or `$validate-code` takes the lane
  only with a `Content-Length` of at most `fastLaneMaxBytes` (1 KB: one coding, no inline value
  set or code system). Reads (`/CodeSystem/{id}`: a large code system is costly to render),
  searches and `$expand` never do. A request in the lane that turns out to be costly (a
  `GET $validate-code` against a value set that must be expanded) costs at most `fastLaneExtra`
  more requests at once on a process
* sends no new requests to a process that answered 503 (its memory guard is refusing) for
  `cooldownSeconds` (2), unless every process is refusing. Otherwise the refusing process,
  quick to answer and so the least busy, would draw the waiting requests
* answers `504` for a process that hasn't begun its response `upstreamTimeoutSeconds` (60)
  after the request was sent to it (a stuck event loop, a hung native call), aborts that
  request, which frees its slot, and logs a warning naming the process. After 3 in a row from
  one process, it gets no new requests for `cooldownSeconds`, as after a 503, while another
  can take them. It is not restarted for this. A response that has begun is not timed: a
  long stream goes on
* frees a tx request's slot when the process's response has ended, not when the client has
  read it: the launcher reads a tx response from the process as fast as it comes (the process
  held it whole in memory already) and holds what the client hasn't taken yet. Any other
  response (a package download can be large) is passed on only as fast as the client takes
  it. Either way, a client that takes none of what is waiting for it for `writeTimeoutSeconds`
  (60) has its connection closed, and the launcher logs it (at most once a minute, with a
  count). Without this, about 20 clients asking for large responses and never reading them
  would hold every slot of a process, and every tx request would get 503
* logs its limits (`maxOutstanding`, the three waits, `upstreamTimeoutSeconds`, `writeTimeoutSeconds`, the fast lane's two, `memoryHeadroomGB`,
  `normalMinSlots`, `drainSeconds`, `trimAllocator`, `recycleSeconds`) as it starts, in one line
* starts again a process that exits. One that keeps failing waits longer each time: 1 s,
  2 s, 4 s ... up to a minute. A process that exits before it is ready, or within a minute of
  being ready, counts as failing; one that ran longer is restarted after 1 s. If the master
  exits `maxStartFailures` (6) times in a row without ever having been ready, the launcher
  logs an `ERROR` and exits 1, so the service manager sees the failure
* restarts a tx-worker whose memory has stayed over the memory guard's refusal threshold for
  `recycleSeconds` (30) with no request at work on it (see [Memory](#memory)). It sends it no
  new requests, lets those it has finish (up to `drainSeconds`), stops it as on shutdown and
  starts it again at once
* starts each process with its own Node flags (`node --max-old-space-size=... cluster.js`
  passes them on, with `--expose-gc` added), except a debugger's (`--inspect...`) and a
  watcher's (`--watch...`), which are the launcher's own
* on `SIGTERM` or `SIGINT`: stops taking connections, closes idle keep-alive connections,
  waits for the requests in progress (up to `drainSeconds`), then sends each process
  `SIGTERM` (each shuts down as a single server does; `SIGKILL` after 30 seconds), and exits
* if the launcher itself dies (even by `SIGKILL`), each process it started sees its IPC channel
  close and shuts down, so none is left holding its port against the next launcher. A
  process started by hand has no channel, and this doesn't apply to it

## Configuration

```json
"server": {
  "port": 3000,
  "cluster": { "workers": 4, "masterServesTx": true, "internalPort": 3001, "drainSeconds": 30 }
}
```

| Setting | Flag | Default | Meaning |
|---|---|---|---|
| `server.port` | `--port`, `PORT` | 3000 | The port clients use. |
| `server.cluster.workers` | `--workers`, `FHIRSMITH_WORKERS` | from the CPUs, or fewer if memory is short | How many tx-workers. Not given: by the engine's rule from the physical cores and vCPUs (see [How many workers](#how-many-workers)), then lowered to as many as fit under the memory guard's refusal threshold with `memoryHeadroomGB` to spare once loaded (at least 1; see [Memory](#memory)). Given: that many, always, with a warning if they don't fit. A whole number (anything else stops the launcher with an error); 0: the master alone. |
| `server.cluster.cores` | | detected | The physical cores the rule uses, instead of the detected ones: for a machine whose topology the launcher can't see or reports wrongly. |
| `server.cluster.workerRule` | | the engine's | The rule by name (`classic`, or one an engine adds). |
| `server.cluster.memoryHeadroomGB` | | 2 | Memory to leave free under the refusal threshold once every process is loaded and idle. 2: about what one heavy operation uses (a large SNOMED `$expand`, a big `$batch-validate-code`); with less, the first one shuts the gate for everyone. |
| `server.cluster.masterServesTx` | `--master-serves-tx=false` | true | Whether the master also takes ordinary tx requests. |
| `server.cluster.internalPort` | `--internal-port` | port + 1 | The master's port; worker *n* gets this + *n*. A range that includes `server.port` stops the launcher with an error. |
| `server.cluster.bindAddress` | | `127.0.0.1` | The address the master and the workers listen on (see [Roles](#roles)), and the launcher reaches them at (loopback for `"0.0.0.0"` or `"::"`). Not the launcher's own port, which is `server.port` on every interface. |
| `server.cluster.drainSeconds` | | 30 | How long the requests in progress get to finish when the launcher stops, and on a tx-worker before a memory recycle stops it; a request still running then is cut short. 30: half again the operation limit (`modules.tx.operationTimeLimit`, 20 s), so an operation in progress finishes or reaches its limit. 0: no wait. |
| `server.cluster.maxOutstanding` | | 16 | Tx requests sent to one process at once; the rest wait in the launcher. The master's own paths and CORS preflights don't count. 16: a process is one event loop whose operations take turns every 25 ms, so a cheap request waits a turn behind each heavy one, and 16 keeps that under half a second. More cores don't change it. 0: no limit (nothing waits). |
| `server.cluster.queueSeconds` | | 1 | Seconds a tx request may wait for a process with room. 1: a client is better told the server is busy than left to its own timeout, and when a surge ends, the line it left drains within this long (with 3, the line took 3 s to clear and the requests just after the surge waited behind it: a `$lookup` took 1.4 s for 5 s; with 1, under 10 ms after 2 s, at the same goodput). When hit, the client gets 503, `Retry-After: 5` and `Connection: close`. 0: that 503 comes at once. |
| `server.cluster.ownerQueueSeconds` | | 30 | The same, for a request with a cache-id, which only the process that issued the id can take. 30: the request has nowhere else to go, so it waits about as long as a client's own timeout. 0: 503 at once. |
| `server.cluster.cooldownSeconds` | | 2 | Seconds a process that answered 503 (its memory guard refusing) gets no new requests while another can take them. 2: the guard re-measures only when a request arrives, so a longer pause holds its recovery back. Clients see nothing; their requests go to another process. 0: no pause. |
| `server.cluster.upstreamTimeoutSeconds` | | 60 | Seconds from sending a request to a process until its response begins, after which the client gets 504 (an OperationOutcome naming the process) and the request is aborted. 60: an operation stops at its limit (`modules.tx.operationTimeLimit`, 20 s), but that limit counts the operation's own compute, not the turns it waits while the others on its event loop run (up to `maxOutstanding` of them), so a heavy operation in a busy process takes longer than 20 s by the clock. Three times the limit leaves room for that; a process silent for longer is taken to be wedged (a stuck event loop, a hung native call), not working. The time a request waits in the launcher's queue is not counted. Raise it with the operation limit. 0: no timeout. |
| `server.cluster.writeTimeoutSeconds` | | 60 | Seconds a client may take none of the response waiting for it in the launcher before its connection is closed (the client sees the response cut short). It bounds how long a client that doesn't read holds the launcher's memory (a tx response) or a process's request (any other). 60: a client that reads takes some within milliseconds, so this is about a thousand times what a reading client needs; it is nginx's own `send_timeout`, and behind nginx with buffering on (the default), nginx takes the response at once and this never fires. 0: no timeout. |
| `server.cluster.maxStartFailures` | | 6 | Times in a row the master may exit without ever having been ready before the launcher gives up and exits 1. Without it, a master that can't start left a launcher that ran but never listened, which systemd counts as up. 6: the waits between starts (1, 2, 4, 8, 16 s) put the sixth start 31 s after the first failure, past the 30 s an old process still shutting down may hold the port for. Once the master has been ready, it is started again however often it exits, as a worker always is. Clients see no difference: nothing listens either way. Logged with the master's first start. 0: never give up. |
| `server.cluster.recycleSeconds` | | 30 | Seconds a tx-worker may stay over the memory guard's refusal threshold with no request at work before the launcher restarts it. 30: long enough for the guard's own recovery (a forced GC and `malloc_trim` at once and again 5 s later, `malloc_trim` alone up to once a second) to have its effect, short next to a client's retries; meanwhile every request to the server is refused. The restart costs the worker's caches (see [Limits](#limits-of-this-arrangement)) and the about 15 s it takes to start; the others serve meanwhile, and the gate opens once the old process has exited. 0: never. |
| `server.cluster.fastLaneExtra` | | 4 | How many more than `maxOutstanding` a process may have when the request is in the fast lane (above). 4: room for the cheap requests of a surge without letting a lane request that turns out to be costly crowd a process. 0: no fast lane. |
| `server.cluster.normalMinSlots` | | 4 | While other requests wait, the fast lane leaves each process enough slots for this many of them to run, so heavy work keeps going during a flood of cheap requests. 4: in a 3x surge on 4 CPUs (1 master + 2 workers) the heavy requests answered were the same with 4, 8 or no minimum (about 7,100-7,400 in 30 s), but each heavy request running slows the cheap ones on its event loop: the `$lookup` probe took 88 ms (median) with 4, 150-210 ms with 8. With the lane held to 4 slots of its own, the surge was served at 457/s, not about 1,200/s, and the probe took 1.1 s. 0: no minimum. At most `maxOutstanding`. |
| `server.cluster.fastLaneMaxBytes` | | 1024 | The largest `Content-Length` with which a `POST` `$lookup`, `$subsumes` or `$validate-code` takes the fast lane. 1024: a single coding with its parameters is about 450 bytes; an inline value set or code system is larger. Half of a validator's calls are such `POST CodeSystem/$validate-code`s, and with them in the lane a 3x surge on 4 CPUs was served at twice the rate (1210/s vs 608/s, with the same CPU) and they took 24 ms instead of 1 s; the other requests did no worse. 0: a `POST` never does. |
| `server.memory.trimAllocator` | | true with a role; false without | Whether a process calls `malloc_trim` (Linux with glibc, and the optional `koffi` dependency): with a role, once after loading the library (it gives back 0.6-0.7 GB a process), and while the memory guard is refusing (see [Memory](#memory)). true: the C allocator keeps freed memory resident, and no GC touches it. false with a role: for diagnosis. Without a role it is off unless set true. Each process's memory line at start says whether it is on. |
| `modules.tx.instanceCode` | | `m0` under the launcher | The master's instance code. The workers are `tx1`, `tx2`, ... The `m0` default is the launcher's: a master started by hand needs this, `--instance-code` or `FHIRSMITH_INSTANCE_CODE` (see [Roles](#roles)). |

Under systemd, the launcher and its processes are one unit and one cgroup:

```ini
[Service]
WorkingDirectory=/opt/fhirsmith
Environment=FHIRSMITH_DATA_DIR=/var/lib/fhirsmith
ExecStart=/usr/bin/node cluster.js
KillMode=mixed
MemoryMax=16G
TimeoutStopSec=2min
```

A stop can take `drainSeconds` (30), then up to 30 s for the workers to shut down, 5 s for
their last request counts, and up to 30 s for the master: 95 s at the most, usually a few
seconds. So give the service manager longer than that before it kills everything. systemd's
default `TimeoutStopSec` is 90 s. Docker's default stop timeout is 10 s, shorter than the drain
alone, after which it kills the launcher and every process with it, mid-request; set
`stop_grace_period: 2m` (Compose) or `docker stop -t 120`, and run the launcher as the
container's main process (`CMD ["node", "cluster.js"]` in place of the image's `server.js`,
not under a shell) so it gets the `SIGTERM`.

## Graphs

With the launcher, `/` and `/dashboard` show the master and every worker as lines on the
existing metric panels, with one legend above them. Colour (by lightness), line pattern and
marker each tell the processes apart; up to eight are drawn, and past eight the legend says
how many are left out. With more than one process, Requests per Minute adds a thick dark
Total line: every process's rate summed per sampling interval. The other panels have no
total, since summed heap or turnaround means nothing.
With `sharedCache`, every process samples the same shared client-cache counts, so those
lines can overlap.

The memory guard counts its 503 refusals before body parsing. Grey hatching on all
charts marks sampling intervals containing those refusals; it does not mean the guard
was closed continuously throughout an interval. The note above the charts counts
refusals in the displayed samples, and hovering a process point shows that sample's
count. Request-rate lines and turnaround averages continue to describe admitted work.
Client timeouts, unsent load-generator arrivals and proxy errors are not guard refusals.

Samples keep their actual timestamps. A restarting process leaves a gap and retains its
earlier history; a skipped sampling interval also leaves a gap. The legend reports
starting, restarting, unavailable or no recent sample when applicable. History lives in
the launcher for up to 24 hours, capped at 1,440 points per process (including gaps), so
short custom statistics intervals can cover less than 24 hours. A launcher restart clears
the graph history. Memory is the change in heap use since each process started, not its
absolute heap size. In the table above the graphs, Request Count and Avg Requests/min are
every process's (see [Request counts](#request-counts)); uptime, memory and the rest are the
master's.

### Request counts

A tx-worker has no statistics database and sends no daily report. Under the launcher, each
worker sends the requests it counted to the master every minute, and once more when it stops
(the launcher stops the workers before the master). The master adds them to its own counts,
so its statistics database (`databases/stats.db`) and the daily report count every process,
each request once. The counting has these limits:

* **A worker that crashes loses up to a minute of its counts**: those it hadn't sent yet. (A
  worker that is stopped sends them as it stops.)
* **A master that crashes loses the counts it hasn't written yet**, its own and the workers'
  it has merged, as a single server loses its own today.
* **Counts can land in the next day's report.** A worker's requests reach the database with
  the master's next write, up to a minute or so after they were served, so a request just
  before midnight can be counted in the next day.
* **Workers started by hand behind nginx have no IPC channel**, so their requests never reach
  the master's `stats.db` or daily report (see [Limits](#limits-of-this-arrangement)).

The master's `/` and `/dashboard` show the same total: Request Count (with the master's and
the workers' parts) and Avg Requests/min count every process, the workers' up to a minute
behind. A worker's own page shows only its own.

A standalone server, or roles started separately behind nginx, shows only its own graph
data. Combining process histories requires the launcher's IPC connection; no separate
metrics service or HTTP polling is used.

### The daily report

The daily report (see [CONFIGURATION.md](CONFIGURATION.md#email-and-the-daily-report)) is the
master's. Its stability paragraph is about the master's own runs. Only the launcher knows what
happened to the workers, and what it answered itself, so it sends the master what it saw, the
same way it passes on the workers' request counts, and the master keeps it in `stats.db`
(table `cluster_events`). The report has a **Cluster** paragraph after the stability one:

* when the launcher started (a launcher restart restarts every process);
* for each process that exited or was recycled: how many times and how (the exit code or
  signal, or why it was recycled), how long it was unavailable in all (from its exit, or the
  start of its recycle, until it was ready again), and the requests that were lost to it (504:
  no response in `upstreamTimeoutSeconds`; 502: it didn't answer; a cache-id that came while
  it was restarting);
* the requests the launcher refused itself (503: no process free in `queueSeconds`, no process
  ready, or stopping), and the connections it closed because the client took none of a
  response in `writeTimeoutSeconds`.

Events go to the master as they happen, and what was counted every minute; while the master is
down they wait in the launcher (up to 5,000 events, the oldest dropped first) and go when it
is ready again. So:

* **a process still unavailable at midnight** has that time in the next day's report, when it
  is ready again;
* **what the launcher saw is lost if the launcher stops while the master is down**, including
  when it gives up starting the master (`maxStartFailures`). That shows as an outage in the
  stability paragraph;
* **without the launcher** (roles behind nginx), there is no Cluster paragraph.

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
| `server.cluster.sharedCacheMaxMB` | 256 | With `sharedCache`: the most client resources (their JSON, in MB) the file holds, every endpoint's caches together. Past it, the caches least recently used are dropped whole, and a request with a dropped cache-id gets `404` `cache-id-unknown` (`CACHE_ID_EVICTED_SIZE`, which names the cap), so the client starts a new cache. 256: the largest IG Publisher cache session in a corpus of 2,817 from builds against tx.fhir.org held 3.5 MB of resources (p99 2.8 MB, median 55 KB), so this is about 70 times the largest; `cacheMaxTotalConcepts` gives one endpoint about 40 times the largest session's concepts, and this is that room for two busy endpoints. The file on disk is larger than what it holds (indexes, and the pages SQLite keeps for reuse). Each process logs the cap as it starts. 0: no cap. |
| `server.cluster.sharedClosure` | false | Every tx process answers `$closure`, on the one closure database. |
| `modules.tx.closure.writeRetries` | 10 | With `sharedClosure`: how many times an add is worked out again when another process changed the table first. |

### Shared cache

Without it, a cache lives in the memory of the process that issued it, and the routing has to
send every request that uses it there. A restarted process has lost its caches, and its
clients get `cache-id-unknown` and start new ones. The load a client brings stays on one
process. Its cache-ids are `<code>.<start>.<uuid>`, where `<start>` is when the process
started (base 36), so a restarted process tells an id it issued before the restart ("lost to
a server restart") from one it never issued.

With it, any process can answer any cache-id. **Caches are not carried over a server
restart**: a client can't be sure a cache is intact across operations it tried while the
server was down, and the server can't either. So **whenever the master starts** (a master
restarted by the launcher, a new launcher run, or a master started by hand behind nginx),
every live cache becomes a tombstone, and a request that uses one gets `cache-id-unknown`
with "lost to a server restart"; the client starts a new cache. A tx-worker that restarts
while the master carries on keeps every cache. Workers that survive a master restart issue
new caches in its new generation. An id that was never issued is reported as never issued.

The launcher sends a request with a cache-id to the least-loaded tx process,
like any other. The cost is a read of the file on each use of a cache: a request reads the
list of what the cache holds, and only loads the resources it uses. Writes are short
transactions in WAL mode, so readers don't wait for them. `last_used` is written at most every
30 seconds per cache. The idle sweep (`modules.tx.cacheTimeout`) runs in every process, and
running it twice does no harm. Cache-ids are `<code>.<generation>.<random>`: two 22-character
tokens with no `.` in them, 62 characters with a 16-character code, inside a FHIR id's 64.
Clients should treat them as opaque. Writes check the generation inside their transaction, so
a request in progress across a master start cannot recreate an old cache, and a new cache is
given its id inside the transaction that creates it. A lazy read that comes after a master
start also gets `404` and `cache-id-unknown`.

If another request replaces a resource after its index was read but before its content is
loaded, the request returns `409` (`CACHE_ID_CHANGED_DURING_REQUEST`, tx-issue-type
`cannot-determine`). If the cache ends meanwhile (closed, expired, dropped), it returns `404`
`cache-id-unknown` (`CACHE_ID_GONE_DURING_REQUEST`), and the client starts a new cache. After
a `409`, retry the whole request to read the new contents together. This prevents using new content under an old
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
waits a few milliseconds, with jitter, between tries. After the first try and `writeRetries`
retries (`writeRetries` + 1 tries in all) it answers
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

| `sharedCache` | `sharedClosure` | A request with a cache-id goes to | `$closure` goes to | After a worker restart | After the master starts |
|---|---|---|---|---|---|
| off | off | the process that issued it (if it is down, the launcher answers `cache-id-unknown`, lost to a restart) | the master | its caches are lost | its caches are lost |
| on | off | the least-loaded tx process (the issuer, with `cacheAffinity`) | the master | every cache is kept | every cache is lost |
| off | on | the process that issued it | the least-loaded tx process | its caches are lost | its caches are lost |
| on | on | the least-loaded tx process (the issuer, with `cacheAffinity`) | the least-loaded tx process | every cache is kept | every cache is lost |

The syndication feed, the `/info` pages and everything outside the tx endpoints go to the
master in every combination. For nginx, see
[nginx.md](nginx.md#with-the-shared-cache). Under the launcher, a lost cache is reported as
"lost to a server restart" in every combination. Behind nginx.md's configuration, without the
shared cache, that is so only once the restarted process answers: while a worker is down its
cache-ids go to its `backup` worker, which answers `cache-id-unknown` saying the id is another
instance's (`CACHE_ID_OTHER_INSTANCE`), and while the master is down nginx answers its
cache-ids (`m0.`) with a `502`, since `fs_master` has no backup. Either way the client starts a
new cache. Closure tables are kept across restarts, as on a single server.

## Memory

With a role, the memory guard measures the whole cgroup, not the process's RSS, since the kernel's limit is on all the
processes in it together: the cgroup's private memory (`memory.stat` `anon`; cgroup v1
`total_rss`). The page cache (the terminology and SQLite files) isn't counted: the kernel drops
it when it needs the room.

* Above `server.memory.rejectFraction` (85%) of the limit, **every** process refuses new
  requests with 503 and `Retry-After`.
* Above `abortFraction` (92%), **every** process aborts the operations it has running (422
  too-costly); a process with none running carries on. Not only the largest: a process's size
  doesn't say whether it is busy, and a large idle master would otherwise leave a worker's
  runaway `$expand` to the kernel's OOM killer, which would likely kill the master.

While refusing, each process looks for memory to get back, at once and then every 5 s (backing
off to a minute while it gets back little): a forced GC, unless its JS heap is too small for
one to help, then, on Linux with glibc and the optional `koffi` dependency, `malloc_trim`.
Between those looks, before it refuses a request, it calls `malloc_trim` alone, at most once a
second and without backing off, and measures again: what a burst used is freed when the burst
ends but stays resident, and without this a quiet server could sit just over the line until
the next look, a minute away. (With nothing to give back, a trim takes well under a
millisecond.) The trim matters: an operation that opens thousands of SQLite connections (a 20,000-entry LOINC
`$batch-validate-code`, which opens one per entry) leaves gigabytes that the C library's
allocator keeps resident after the connections close, and no GC touches them. After such a
batch was aborted, a worker held 8.0 GB, 4.7 GB of it free in malloc's arenas; `malloc_trim`
took it to 3.9 GB in half a second, and without it the server refused everything until it was
restarted. Setting `MALLOC_ARENA_MAX=2` in the environment was tried instead and did not give
the memory back (the worker was still refusing 90 s after the abort); `malloc_trim` did (back
in 6 s), so the trim is a call through `koffi`, not an environment setting.
This is on with a role (`server.memory.trimAllocator`, true unless set false, for diagnosis).
With no role it is off unless set true, so a single server only forces the GC, as before: the
trim is synchronous native code, not yet run on a single server's 20 GB process. Where it is
not available (macOS, Windows, musl, no `koffi`), only the GC runs. With a role, each process
also trims once after loading the library, before it takes requests: the load leaves 0.6-0.7
GB free but resident, and N+1 processes share the one limit.

If a tx-worker stays over the refusal threshold anyway, for `server.cluster.recycleSeconds`
(30) with no request at work on it, the launcher restarts it: whatever it holds, nothing
running will free it. With the cgroup measured, only a worker that has grown, since it was
ready, by more than the cgroup is over the threshold is restarted (a smaller one would come
back at the same size, and the gate would stay shut); the largest first, one at a time. Without,
a worker over the threshold on its own, and again only if it has grown since it was ready by
more than it is over: one already over when it became ready would come back over, and be
restarted every 45 s or so for good. The launcher logs a `WARNING` for such a worker, once,
and leaves it. The launcher reads each worker's `RssAnon` from `/proc`,
so this is Linux only. The master is never restarted for this: it holds what only it has. The
launcher logs each restart and why, and its limits line says whether this is on.

This needs the limit on the processes' own cgroup: `MemoryMax` on the unit that runs
`cluster.js`, or a container limit. If the limit is only on an enclosing slice, or there is
none, each process measures its own RSS against the limit, as a single server does. If you
start the processes as separate systemd units, give each its own `MemoryMax`: each then guards
its own.

Each process is a whole terminology server: it loads the library, so N workers and a master
use roughly N+1 times the memory of one server (about 2.8 to 3.8 GB each with the full library).
Size the limit for that. The guard counts them all against the one limit, so N+1 idle processes
sitting at the refusal threshold refuse every request. In a test with a 16 GiB limit and
`rejectFraction` set to 0.75 (a test setting; the default is 0.85), so a threshold of 12 GB,
1 master and 3 workers idle at 12.05 GB refused everything for minutes after a burst, while a
single server on the same data stayed near 3.5 GB and never refused. With the defaults on a
32 GB limit the threshold is 27.2 GB (refusing) and 29.4 GB (aborting). So the launcher
checks: once the master is loaded, it takes the master's memory as each worker's, and if
`server.cluster.workers` is not given, it starts only as many workers as fit under the
threshold with `memoryHeadroomGB` (2) to spare, at least one. If it is given, they all start, with
a `WARNING` line. If even one worker doesn't fit, that is a `WARNING` too, with the numbers. Once every worker is ready it logs what they all use idle, with a `WARNING` if
less than the headroom is left.

## How many workers

With `server.cluster.workers` not given, the launcher derives it from the CPUs and logs the
inputs and the decision in one line as the master is loaded:

```
workers 4: 4 physical cores (8 vCPU, SMT 2), quota none, memory fits 11 → classic rule min(4, round(0.6×8))
```

* **vCPU**: `os.availableParallelism()`, the CPUs this process may run on.
* **physical cores**: the distinct cores among those CPUs, from
  `/sys/devices/system/cpu/cpuN/topology/core_cpus_list` (`thread_siblings_list` on older
  kernels). Where that can't be read (macOS, Windows, some hypervisors), the vCPUs.
  `server.cluster.cores` overrides it.
* **quota**: a cgroup v2 `cpu.max` on the launcher's cgroup or one enclosing it caps the cores
  at `ceil(quota)`.

| Engine | Rule | 4 vCPU, 4 cores | 8 vCPU, 4 cores (SMT) | 8 vCPU, 8 cores | 16 vCPU, 8 cores (SMT) |
|---|---|---|---|---|---|
| classic | `min(cores, round(0.6 × vCPU))` | 2 | 4 | 5 | 8 |

Then at least 1, then lowered if the processes won't fit in memory (above). The master serves tx
too, so there is one more tx process than workers. Physical cores, not vCPUs: a second
hyperthread adds little to a process that is CPU-bound, and more processes than that only take
turns on the same cores while each holds its own copy of the library in memory.

What it rests on (classic engine; surge goodput in req/s, the same load generator and library;
`w3` = 3 workers):

| Machine | Measured | Rule |
|---|---|---|
| local, 4 vCPU = 4 cores | w2 1,678; w3 1,539 (cheap probe 918 ms, timeouts) | 2 |
| local, 8 vCPU = 4 cores SMT | w3 1,592; w4 1,630; w5 1,615 | 4 |
| GCP n2-standard-8, 8 vCPU = 4 cores SMT | about 1,550, flat from w3 to w6 | 4 |
| GCP n2-standard-16, 1 thread per core: 8 vCPU = 8 cores | about 2,430, flat from w4 to w6 | 5 |

The classic engine is flat past its rule's number: a process uses about 1.4-1.9 cores under load
(its libuv pool), so more add memory, not throughput. An engine whose processes use the CPU
differently adds its own rule (`registerWorkerRule` in `library/worker-count.js`). Machines of
16 cores and more were not measured: the rule there is extrapolation, and `server.cluster.workers`
is the way to choose.

## Limits of this arrangement

* **Caches are per process** (unless [`sharedCache`](#options) is on). A `$cache-control`
  cache lives in the process that issued it; a restarted process loses its caches, and
  clients start new ones, as after any restart. That includes a tx-worker the launcher restarts
  because it stayed over the memory guard's refusal threshold (`recycleSeconds`): its
  `$cache-control` caches, its expansion cache and the code systems it had loaded are gone,
  and its first requests after the restart are slower.
* **Without the launcher, statistics are per process.** The workers' graphs and request
  counts reach the master over the launcher's IPC channels. With processes started by hand
  behind nginx there are none: `/` and `/dashboard` on the master show only the master, and
  the workers' requests are not in its statistics database or daily report. (Running
  `cluster.js` behind nginx, as one upstream, keeps both.)
* **Everything the master runs is a single point.** While the master restarts, `$closure`
  (unless [`sharedClosure`](#options) is on), the non-tx modules and the dashboard answer 503
  through the launcher; tx requests carry on.
