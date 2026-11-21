# Securing the registry

By default the registry is open, as HL7's ecosystem registry is: anyone can call the API. A
registry run for a narrower community - an enterprise, a national programme, a vendor's
customers - can be closed with `modules.registry.security`, in two ways, alone or together:

| Method | Who it suits |
|---|---|
| `required: true` | Clients you want to tell apart: users of the server with the registry **member** role, each with their own API tokens - issue, expire and revoke them one by one, see who is calling |
| `oidc` | An enterprise with an identity provider: it decides who may call, and issues the tokens |

They combine: a registry can accept its enterprise's JWTs *and* have a few members for
clients that can't do OAuth. The members are mostly software - a validator in a build
pipeline, a server resolving terminology - not people.

Users, logins, roles and API tokens are the server's, for every module
([library/auth](../../library/auth/README.md)): the registry has no users or passwords of its
own. (Before, it had: `security.apiToken`, one token every client sent, and `security.users`,
users with their own tokens. Neither is used any more; while either is still in the
configuration, the API stays closed.)

## What is closed

Only the JSON API: `GET /tx-reg/` and `GET /tx-reg/resolve` when they answer JSON. The HTML
pages (home, resolve form, software, log), the OpenAPI description and the login page stay
open, so a client - or the person configuring one - can always find out how to authenticate.
A request without a valid token gets:

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer realm="tx-reg"
Content-Type: application/json

{ "error": "unauthorized",
  "message": "This registry requires a token: send it as Authorization: Bearer {token} or Api-Key: {token}",
  "documentation": "/tx-reg/openapi" }
```

(The message says `The token is not valid for this registry` when one was sent.) A valid
token of a user who is not a member gets `403 Forbidden`. An open registry ignores any token
sent to it.

Failed authentications are limited per address. After `failedAuthPerWindow` requests
answered 401 in 15 minutes (default 60), the address's requests with a token that isn't
valid get `429 Too Many Requests` for the rest of the window. The token is checked first, so a
request with a valid token always goes through, even from an address over the limit. One
client behind a NAT retrying a bad token doesn't lock out the others. Only 401s count. This
stops anyone guessing tokens. JWTs without an `exp` claim are refused. General request volume is still the proxy's
business (nginx). `0` turns the limit off. It applies to the JSON API only; the pages
aren't guarded, so they aren't limited.

## How a client sends a token

As an HTTP bearer token, or in an `Api-Key` header (`X-API-Key` is accepted too):

```http
GET /tx-reg/resolve?fhirVersion=R4&url=http://loinc.org
Authorization: Bearer fhs_k3Jd9...

GET /tx-reg/resolve?fhirVersion=R4&url=http://loinc.org
Api-Key: fhs_k3Jd9...
```

The HL7 Java tooling (validator, IG publisher, and everything that uses
`TerminologyClientManager`) sends either for a server listed in its `fhir-settings.json`, so a
secured registry needs no change to the tools, only a settings entry:

```json
{ "servers": [
  { "url": "https://ecosystem.example.org/tx-reg",
    "authenticationType": "token", "token": "fhs_k3Jd9..." }
] }
```

(`"authenticationType": "apikey", "apikey": "..."` sends the `Api-Key` header instead.) Note
that the tooling can *send* a token but not *obtain* one, so a Java client of an OIDC-secured
registry needs a long-lived token - a member's API token, or an OIDC client credential arranged
outside the tool.

## Members and their tokens

```json
"security": { "required": true }
```

Every API call must come from a member: a user of the server with the registry **member**
role. Software sends one of its API tokens; a person logged in with a browser can call it too.
The server's administrators make the users, give them the role, and issue their tokens
(`/auth/admin/users`); a user who logs in can issue and revoke their own (`/auth/account`). To
rotate a token without an outage: issue the new one, move the client to it, revoke the old
one. See [library/auth](../../library/auth/README.md) for tokens (stored as SHA-256 hashes,
shown once, with an optional expiry), passwords and logins.

The registry counts the requests each member makes, in memory, written to its database once a
minute (`security.database`, default `registry-auth.db` in the data folder's `databases`
directory, which also holds the [documents](documents.md)). The administrators see them on
`/tx-reg/usage`, with the OIDC clients'.

Members also read the [documents](documents.md) that aren't public.

## OpenID Connect

```json
"security": {
  "oidc": {
    "issuer": "https://login.microsoftonline.com/{tenant}/v2.0",
    "audience": "api://ecosystem.example.org",
    "requiredScope": "registry.read",
    "jwksUri": "https://login.microsoftonline.com/{tenant}/discovery/v2.0/keys",
    "algorithms": ["RS256"]
  }
}
```

The enterprise's identity provider (Entra ID, Okta, Keycloak, Ping, Auth0 - anything that
implements OpenID Connect) issues JWTs; the registry verifies them and lets the bearer in. The
enterprise therefore decides who may use the registry, with its own onboarding and
offboarding, and no secret is ever shared with the registry.

A software client registers an application with the provider and obtains a token with the
OAuth 2.0 client credentials grant, then sends it as `Authorization: Bearer`. (A person's
token from the usual browser login flow works the same way, if it has the right audience.)

**What is checked.** The signature, against the issuer's published keys; `iss` equal to
`issuer`; `aud` containing `audience` (a string, or a list of acceptable values); `exp` and
`nbf`, with 60 seconds' tolerance; and, if `requiredScope` is set, that value among the
token's scopes - the space-separated `scp` or `scope` claim, or the `roles` list (Entra ID puts
application permissions in `roles`). Any failure is a 401, and the reason is logged.

**Keys.** With `jwksUri`, keys are fetched from there. Without it, the registry reads
`{issuer}/.well-known/openid-configuration` on the first request and uses its `jwks_uri`;
if that fails the request is refused and discovery is retried on the next. Keys are cached
and refreshed when an unknown key id appears (at most every 30 seconds). Both URLs must be
https. `algorithms` restricts the accepted signing algorithms; the default is the asymmetric
set (RSA, RSA-PSS, ECDSA, EdDSA) - symmetric HMAC algorithms are never accepted, since a shared
secret would defeat the point.

**Identifying the client.** Requests are counted per client, by the token's `azp`,
`client_id`, `appid` or `sub` claim, and shown on the usage page (`/tx-reg/usage`). The
registry keeps no record of OIDC clients beyond that. A valid JWT is a member: the provider
decides who may call.

**Which check a token gets.** A token of three dot-separated parts is treated as a JWT and
verified against the provider when `oidc` is configured; anything else is looked up among the
server's API tokens. So the two never confuse one another's tokens.

This needs the `jose` package (a dependency of FHIRsmith); a registry configured for OIDC
without it refuses to start, with a message saying so.

## What is not done, and could be

* **Trusted proxy headers.** An enterprise that fronts the registry with its own gateway
  (mTLS, SSO, API keys it already issues) could pass the caller's identity in a header the
  registry trusts from that proxy only. Not implemented; the gateway can simply hold a
  member's API token today.
* **Single sign-on for the pages.** People log in with a password or GitHub. The
  OIDC provider could authenticate people to the pages too.
* **Token introspection, LDAP, SCIM.** Considered and set aside until a deployment needs one.
  Introspection (RFC 7662) suits opaque enterprise tokens at the cost of a call per request;
  LDAP is a human-login technology; SCIM would synchronise the enterprise's users into the
  server's users but still leave the tokens to be issued here.
