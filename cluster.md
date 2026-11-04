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
* [With nginx](#with-nginx)
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
| `$closure` (the closure tables) | yes | no: routed to the master |
| Syndication feed (the store) | yes | no: routed to the master |
| VSAC sync, and the resync form on `/info/vsac` | yes | no: reads what the master wrote |
| Package crawler, XIG download, registry crawl, daily report, npm audit | yes | no (those modules don't run) |
| Statistics database, uptime history | yes | no: in memory only |
| `$cache-control` caches | its own, in memory | its own, in memory |
| Expansion cache, CodeSystem list refresh | its own | its own |
| Log file | `logs/server-<date>.log` | the same file (lines interleave) |

The master loads the terminologies like any tx server: `$closure` needs subsumption.

**VSAC.** The master syncs, and when a sync has written its value sets it adds one to a
generation counter in the VSAC database. A worker remembers the generation its value set list
was loaded at. When a request uses the VSAC value sets, the worker reads the counter (one read
by key, at most once a second) and reloads the list in the background if it has moved, so a
sync reaches every worker about a second after it finishes. The database is in WAL mode with a
5 second busy timeout, so a worker's reload doesn't make the master's writes fail.

**Nothing else is shared.** The workers run no module but tx, so they never read what the
package crawler, the XIG download or the registry crawl write. Each process keeps the caches
of a `folder:` or `file:` library source in its own folder
(`terminology-cache/folder-source-<code>-<hash>`), because each load wipes and rebuilds them.

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

## The launcher (cluster.js)

`node cluster.js` reads `config.json` from the data directory and:

* starts the master and waits until it answers `/health`. On a new data directory the master
  builds the package caches and creates the VSAC database; processes starting together would
  corrupt them, so the workers start only when the master is ready
* listens on the configured port, and starts the workers
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

## With nginx

nginx can be the front door instead: start the processes yourself (master first, workers once
it answers `/health`), and use the configuration in
[nginx.md](nginx.md#a-master-and-tx-workers-on-one-machine), which applies the same rules.

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

* **Caches are per process.** A `$cache-control` cache lives in the process that issued it; a
  restarted process loses its caches, and clients start new ones, as after any restart.
* **Statistics are per process.** `/` and `/dashboard` show the master. The workers' request
  counts are not in the statistics database.
* **Everything the master runs is a single point.** While the master restarts, `$closure`, the
  non-tx modules and the dashboard answer 503 through the launcher; tx requests carry on.
