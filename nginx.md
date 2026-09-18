# Running FHIRsmith behind nginx

FHIRsmith has no built-in TLS, rate limiting or access control. In production it always runs
behind a reverse proxy, which handles those things. This page covers nginx, which is what the
public servers (tx.fhir.org, packages.fhir.org and so on) use.

* [General configuration](#general-configuration) - what nginx should hand across to the server
* [Rate limiting](#rate-limiting) - approaches that suit terminology traffic
* [Routing to multiple servers](#routing-to-multiple-servers) - running more than one instance behind a single front door
* [Managing closure](#managing-closure) - where `$closure` requests go

## General configuration

### Headers to pass to the server

FHIRsmith runs Express with `trust proxy` enabled (`server.trustProxy` in config.json,
default `true`). That means it takes the client address, scheme and host from the
`X-Forwarded-*` headers, so nginx has to set them:

| Header | nginx value | What FHIRsmith uses it for |
|---|---|---|
| `Host` | `$host` | The base URL in the CapabilityStatement, TerminologyCapabilities and other self-references. It is taken from the host the client asked for |
| `X-Forwarded-Proto` | `$scheme` | The scheme of those same base URLs, and the `Secure` session cookie used by the publisher and token modules. If this header is missing, an HTTPS server advertises `http://` URLs and publisher login fails silently: you are sent back to the login page, still logged out |
| `X-Forwarded-For` | `$proxy_add_x_forwarded_for` | The client IP address in audit and security logs (`req.ip`). If this header is missing, every request is logged as coming from `127.0.0.1` |
| `X-Request-Id` | `$request_id` | Optional. FHIRsmith echoes it back on the response, so a client's report can be matched to a line in the nginx log (add `$request_id` to your `log_format`) |

`X-Real-IP` is harmless but FHIRsmith does not read it. Only `X-Forwarded-For` reaches `req.ip`.
FHIRsmith does not read client-certificate headers either.

`proxy_set_header` directives are **not** inherited into a location that sets any of its
own. So put the common set in a file and include it in every proxied location:

```nginx
# /etc/nginx/fhirsmith-proxy.conf
proxy_http_version 1.1;
proxy_set_header Connection        "";       # allow upstream keepalive
proxy_set_header Host              $host;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
proxy_set_header X-Request-Id      $request_id;
```

The other headers FHIRsmith relies on pass through without any configuration. Don't strip
them:

* `Accept` and `Content-Type` - format negotiation (JSON/XML, FHIR versions)
* `Accept-Language` - the display language and the language of error messages
* `X-Cache-Id` - the terminology cache protocol (see [Routing to multiple servers](#routing-to-multiple-servers))

### Trusting the proxy

With `trustProxy: true`, anyone who can reach the FHIRsmith port directly can forge
`X-Forwarded-For`. FHIRsmith listens on all interfaces, so firewall the port so that only
nginx can reach it. You can also set `server.trustProxy` to `"loopback"`, or to the proxy's
address; any value that Express's `trust proxy` setting accepts will work. If you run
FHIRsmith without a proxy, set it to `false`.

### Upstream connections

Declare the server as an `upstream` with `keepalive`, and `proxy_pass` to the upstream name.
Pointing `proxy_pass` straight at `127.0.0.1:3000` skips the upstream block, so its keepalive
setting never takes effect. Keepalive also needs the `proxy_http_version 1.1` and empty
`Connection` header from the include above.

```nginx
upstream fhirsmith {
    server 127.0.0.1:3000;
    keepalive 32;
}
```

### Sizes and timeouts

* **Body size.** FHIRsmith accepts request bodies up to 50 MB. Set `client_max_body_size`
  to match: if nginx allows more, oversized requests get past nginx and then fail with an
  unhelpful error from the server.
* **Timeouts.** Some terminology operations are slow, particularly large SNOMED CT
  expansions and batch validations. The public servers use 600s for
  `proxy_read_timeout`/`proxy_send_timeout`. If you set a shorter timeout, nginx returns
  504 while the server is still working, and the client sees a failure for a request that
  would have succeeded.
* **Compression.** FHIRsmith does not compress responses, and FHIR JSON compresses very
  well. nginx only gzips `text/html` unless told otherwise:

  ```nginx
  gzip on;
  gzip_types application/fhir+json application/fhir+xml application/json application/xml text/css application/javascript;
  gzip_min_length 1024;
  ```

### Things to leave to FHIRsmith

* **CORS** is handled by the server (`server.cors`). Don't add `Access-Control-*` headers
  in nginx as well: browsers reject responses that carry duplicate CORS headers.
* **HTTP to HTTPS redirects.** FHIR clients are often configured with `http://` endpoints,
  and many HTTP clients turn a redirected POST into a GET. Serve the API on both ports, or
  redirect GETs only. Don't return a blanket `301`.

### A minimal server block

```nginx
server {
    listen 443 ssl;
    server_name tx.example.org;

    ssl_certificate     /etc/letsencrypt/live/tx.example.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/tx.example.org/privkey.pem;

    client_max_body_size 50M;
    proxy_read_timeout 600;
    proxy_send_timeout 600;
    server_tokens off;

    location /.well-known { root /var/www/html; }   # certbot

    location / {
        include fhirsmith-proxy.conf;
        proxy_pass http://fhirsmith;
    }
}
```

## Rate limiting

nginx offers two kinds of limit, and they suit different traffic:

* **`limit_conn`** caps the number of requests *in flight* at once for a key.
* **`limit_req`** caps the *rate* at which requests arrive, using a leaky bucket.

Terminology traffic varies enormously in cost. A `$validate-code` against a small value set
takes milliseconds; a SNOMED CT `$expand` can hold a connection for minutes. `limit_conn`
matches that well: it limits how much of the server a client is using, not how often it
asks. It is the primary control on tx.fhir.org.

### Concurrent connections

```nginx
http {
    limit_conn_zone $binary_remote_addr zone=perip:10m;
    limit_conn_zone $server_name        zone=perserver:10m;
    limit_conn_status    429;    # not the default 503 - see below
    limit_conn_log_level warn;
    error_log /var/log/nginx/error.log warn;  # rejections are invisible at 'crit'

    server {
        limit_conn perip     50;
        limit_conn perserver 400;
        ...
    }
}
```

Sizing:

* **Per IP needs headroom.** One IG Publisher build legitimately sends many terminology
  requests in parallel, and several users can share an IP behind a NAT or a CI provider.
  On tx.fhir.org, limits in the 5-40 range tripped on ordinary builds.
* **Per server is shared by everyone**, so it has to be well above any single client's
  burst. It is a guard against overload, not a fairness mechanism.
* **Return 429, not 503.** Clients can back off and retry on 429, and it shows up in their
  logs as something other than an outage.

### Request rate

`limit_req` works best for cheap, easily abused traffic: crawlers walking the HTML pages,
or scripts polling one URL. Use `burst` to absorb normal spikes. `nodelay` serves the burst
immediately instead of spacing it out:

```nginx
limit_req_zone $binary_remote_addr zone=browse:10m rate=10r/s;
limit_req_status 429;

location / {
    limit_req zone=browse burst=50 nodelay;
    ...
}
```

A rate limit tight enough to stop a crawler will also catch a busy build. If you use one,
key it narrowly (by location or user agent), or give it a generous burst.

### Exempting known clients

nginx doesn't count a request whose limit key is empty. Use `geo` and `map` to give
trusted clients an empty key:

```nginx
geo $limit_exempt {
    default        0;
    10.0.0.0/8     1;     # internal build infrastructure
    203.0.113.7    1;
}
map $limit_exempt $limit_key {
    0  $binary_remote_addr;
    1  "";
}
limit_conn_zone $limit_key zone=perip:10m;
```

### Blocking abusive clients

* **IP addresses:** `deny` lines, kept in an included file so the list can be edited
  without touching the main config.
* **User agents:** classify with a `map`, then reject in the location with `return 444`.
  444 is nginx's code for closing the connection without sending a response. Keep the
  patterns narrow. A bare `bot` also matches legitimate tools that have "bot" in their
  name.

  ```nginx
  map $http_user_agent $blocked_agent {
      default 0;
      ~*(Bytespider|facebookexternalhit) 1;
  }
  # in the location:
  if ($blocked_agent) { return 444; }
  ```

* **Bandwidth:** for large downloads, such as packages, `limit_rate` caps bytes per second
  per connection. `limit_rate_after` lets the first part of a download through at full
  speed.

### Notes

* Limits apply per nginx instance. The zone is shared by that instance's worker processes,
  but two front doors keep separate counts.
* If nginx itself sits behind a CDN or another load balancer, `$binary_remote_addr` is that
  proxy's address. Use the `real_ip` module (`set_real_ip_from` and `real_ip_header`) to
  recover the client address before limiting.

## Routing to multiple servers

Most terminology operations keep no state between requests, so a pool of identical
FHIRsmith instances could share traffic in any order. The exception is the **terminology
cache** (`$cache-control`). A client starts a cache on one server, loads resources into it,
and then refers to it by id in the `X-Cache-Id` header on later requests. The cache exists
only in the memory of the instance that created it. If another instance receives the
request, it answers `cache-id-unknown` (HTTP 404).

That rules out DNS round-robin. Clients re-resolve the name and reconnect during a session,
so a long build drifts from one server to another. You need a single front door that routes
each cached request back to the instance that owns the cache.

### Instance codes

Give each instance a short code in its config.json:

```json
"modules": {
  "tx": {
    "instanceCode": "tx1",
    ...
  }
}
```

The server prefixes every cache-id it issues with its code and a dot, e.g.
`tx1.4f0c2d1e-…`. Codes must be unique within the pool, and 1-16 letters and digits.
A client never has to understand the prefix: to the client, the cache-id stays an opaque
string.

nginx can then route without holding any state:

* A request **without** `X-Cache-Id` can go to any instance. That includes
  `$cache-control?mode=start`: whichever instance answers issues an id carrying its own
  code.
* A request **with** `X-Cache-Id` goes to the instance named by the prefix.

```nginx
# Keep this list explicit. Don't pass a captured prefix straight into proxy_pass:
# a client could send any prefix, and nginx would try to resolve it as a host name.
map $http_x_cache_id $tx_backend {
    default     tx_pool;
    ~^tx1\.     tx_tx1;
    ~^tx2\.     tx_tx2;
}

upstream tx_pool {
    least_conn;                  # request cost varies widely; balance by load, not turns
    server 10.0.0.11:3000;
    server 10.0.0.12:3000;
    keepalive 32;
}

# One upstream per instance. The backup is not there to serve the cache (it can't).
# It is there so that when the owner is down, the client gets FHIRsmith's coded
# cache-id-unknown error instead of an nginx 502, and can start a new cache.
upstream tx_tx1 {
    server 10.0.0.11:3000;
    server 10.0.0.12:3000 backup;
    keepalive 16;
}
upstream tx_tx2 {
    server 10.0.0.12:3000;
    server 10.0.0.11:3000 backup;
    keepalive 16;
}

server {
    ...
    location / {
        include fhirsmith-proxy.conf;
        proxy_pass http://$tx_backend;
    }
}
```

Notes:

* When `proxy_pass` contains a variable, nginx first looks the value up among the
  `upstream` names defined in the config. That is why the map returns upstream names and
  not addresses.
* An id with an unknown prefix falls through to the pool. The server that receives it
  answers `cache-id-unknown`, and its message names the instance that issued the id, so
  a routing mistake is recognisable as one. The same happens when a request falls through
  to a `backup` server because its owner is down.
* Routing only works on the **header**. The older `cache-id` request parameter sits in the
  request body, where nginx can't see it. Current clients (fhir-core) send the header.
* A restarted instance loses its caches. Clients recover by starting a new one, just as
  they do after a cache expires.

### What must be the same on every instance

Clients can land on any instance, so every instance needs the same `library.yml`, the same
terminology data (the same SNOMED CT, LOINC and other editions) and the same tx
configuration. Otherwise answers depend on which instance served the request. The following
are kept per instance, which is fine:

* expansion caches (each instance warms its own)
* usage statistics (each instance reports its own share)

Only the terminology module should run in the pool. Modules that keep their own state
(`publisher`, `packages`, `shl`, `token`) belong on a single instance, with their own
location or server name routed to it.

## Managing closure

`$closure` stores state on the server between client sessions. (It is defined on ConceptMap,
but it is a system-level operation: the URL is `[base]/$closure`.) A client creates
a named closure table, adds concepts to it over days or months, and asks for the changes
since the version it last saw. The table lives in the database of the instance that holds
it.

**Route every `$closure` request to one designated instance.**

```nginx
upstream tx_closure {
    server 10.0.0.11:3000;
    keepalive 8;
}

server {
    ...
    # A regex location takes precedence over the plain "location /" prefix.
    # nginx matches locations against the decoded URI, so %24closure is caught as well.
    location ~ /\$closure$ {
        include fhirsmith-proxy.conf;
        proxy_set_header X-Cache-Id "";     # see below
        proxy_pass http://tx_closure;
    }

    location / {
        include fhirsmith-proxy.conf;
        proxy_pass http://$tx_backend;
    }
}
```

`$closure` traffic is light, so a single instance is not a bottleneck.

### Why this doesn't conflict with cache routing

It might look as if a `$closure` request could carry an `X-Cache-Id` that belongs to a
different instance. That doesn't cause a problem, because closure can't depend on the
cache.

A closure table has to mean the same thing on every call, across sessions that may be
months apart. Its content can therefore come only from the terminology the server itself
holds. It can never depend on resources a client supplied in a cache: those disappear when
the cache ends, and the table would silently change meaning. So `$closure` ignores
`X-Cache-Id`. Clearing the header in nginx, as above, is a second safeguard: an empty
`proxy_set_header` value stops nginx sending the header at all.

### Operating the closure instance

* **Back up** its database. It is the only state in the pool that clients can't rebuild
  from their side.
* **Don't configure a `backup` server** for `tx_closure`. A backup instance would see none
  of the existing tables, and would start new, diverging ones for any name it was asked
  about. An outage is better than that: clients see a failure and retry later.
* **Moving the designated instance** means moving its closure database with it, then
  changing the upstream.
