# Registry configuration

The registry is configured under `modules.registry` in the server's configuration file (see
[config-template.json](../../config-template.json) for the whole file). The minimum is
`"enabled": true`; everything else has a default.

```json
"registry": {
  "enabled": true,
  "masterUrl": "https://fhir.github.io/ig-registry/tx-servers.json",
  "crawlInterval": 30,
  "timeout": 30000,
  "userAgent": "YourServer/1.0",
  "apiKeys": {},
  "oauth": {},
  "maxResponseMB": 100,
  "maxRequestSeconds": 120,
  "uptimeWindowDays": 30,
  "uptimeRetentionDays": 90,
  "security": { }
}
```

## The ecosystem

| Setting | Default | |
|---|---|---|
| `masterUrl` | HL7's `tx-servers.json` | The ecosystem's master registration file ([readme.md](readme.md#the-specifications)). Point this at your own file to run a registry for your own ecosystem. |
| `apiKeys` | `{}` | API keys for servers the registry needs one to scan, by server code (as in the server's registration). Sent as an `Api-Key` header. An endpoint scanned with a key is reported as `security: api-key` in the API. |
| `oauth` | `{}` | OAuth2 client credentials for servers the registry needs a token to scan, by server code - see [below](#oauth). An endpoint scanned with a token is reported as `security: oauth` in the API. |

Credentials are only sent to the origin (scheme, host and port) of the server's registered
address. A `next` link that points somewhere else is still followed, but without them.

### OAuth

For a server that issues tokens by the OAuth2 `client_credentials` grant, the registry asks
the token endpoint for a token, sending its client id and secret in the form body
(`client_secret_post`), and sends the token as `Authorization: Bearer`. The token is reused
until it is about to expire (`expires_in`; 5 minutes if the endpoint doesn't say), and
replaced early if the server answers 401. A server with an `oauth` entry is not sent its
`apiKeys` entry.

```json
"oauth": {
  "nzhts": {
    "tokenEndpoint": "https://authenticate.nzhts.digital.health.nz/auth/realms/nzhts/protocol/openid-connect/token",
    "clientId": "hl7",
    "clientSecret": "...",
    "scope": ""
  }
}
```

| Property | |
|---|---|
| `tokenEndpoint` | The token endpoint. Must be `https:`. Redirects are not followed. |
| `clientId`, `clientSecret` | The client's credentials, from the server's operator. |
| `scope` | Optional. Sent if present and not empty. |

The field names are those of the HL7 Java tooling's `oauthClientCredentials` settings, so the
same values can be copied between the two.

## Scanning

| Setting | Default | |
|---|---|---|
| `crawlInterval` | none | Minutes between scans. 0 or absent: the registry never scans, and answers from the data it last saved - useful for a read-only replica or a test. |
| `timeout` | 30000 | How long the scanner waits for a server's response to start, in milliseconds. |
| `userAgent` | `FHIRRegistryServer/1.0` | The `User-Agent` the scanner sends. Server operators see this in their logs, so name your registry. |
| `maxResponseMB` | 100 | The most a scanned server's response may be once decompressed. The servers are other people's; a misbehaving one must not exhaust the registry's memory. |
| `maxRequestSeconds` | 120 | The longest a request may take, response included. `timeout` only covers the wait for the response to start, so a server that then sends its answer a byte at a time would otherwise hold the scan for as long as it liked. |
| `allowPrivateAddresses` | false | The scanner refuses to fetch from private, loopback and link-local addresses (SSRF protection - the URLs it follows come from registration files and servers it does not control). Set true only for a test registry whose servers are on localhost. |
| `releasesUrl` | GitHub's FHIRsmith releases API | Where the software page learns FHIRsmith's release dates. `""` turns the lookup off (the dates in the shipped `CHANGELOG.md` are used instead). |

## Uptime

| Setting | Default | |
|---|---|---|
| `uptimeWindowDays` | 30 | The period the software page reports each server's uptime over. |
| `uptimeRetentionDays` | 90 | How long per-endpoint scan outcomes are kept. |

## Security

`security` closes the JSON API. Absent, the registry is open. The block and its three methods
are described in [security.md](security.md); in brief:

```json
"security": {
  "apiToken": "one token every client sends",
  "failedAuthPerWindow": 60,
  "users": {
    "database": "registry-auth.db",
    "adminUsername": "admin",
    "adminPassword": "...",
    "sessionSecret": "...",
    "cookieSecure": true,
    "loginAttemptsPerWindow": 20
  },
  "oidc": {
    "issuer": "https://login.microsoftonline.com/{tenant}/v2.0",
    "audience": "api://ecosystem.hl7.org",
    "requiredScope": "registry.read",
    "jwksUri": "https://.../keys",
    "algorithms": ["RS256", "ES256"]
  }
}
```

## Files

The registry keeps its state in the server's data folder (`FHIRSMITH_DATA_DIR`, else `./data`):

| File | |
|---|---|
| `registry/registry-data.json` | The result of the last scan - what every endpoint hosts. Loaded at startup, so the registry answers immediately after a restart. |
| `registry/registry-uptime.json` | Per-endpoint scan outcomes, for the uptime figures. |
| `databases/registry-auth.db` | Users and tokens, when `security.users` is configured (`database` names it; an absolute path or `:memory:` also works). |

## Behind a proxy

The registry is normally behind nginx (or similar) terminating TLS. Two things matter:

* the proxy must pass `X-Forwarded-Proto`, and the server must trust it (`trustProxy` in the
  server configuration), or the login cookie - `Secure` by default - is never set and logins
  bounce straight back to the login page (`cookieSecure: false` is the escape for a registry
  that really is served over plain HTTP);
* the proxy must pass `Host` (or `X-Forwarded-Host`), or every form post is refused by the
  same-origin check.
