# Securing the registry

By default the registry is open, as HL7's ecosystem registry is: anyone can call the API. A
registry run for a narrower community - an enterprise, a national programme, a vendor's
customers - can be closed with `modules.registry.security`, in any combination of three ways:

| Method | Who it suits |
|---|---|
| `apiToken` | A handful of clients you configure yourself: one token, every client sends it |
| `users` | Clients you want to tell apart - issue, expire and revoke tokens one by one, see who is calling |
| `oidc` | An enterprise with an identity provider: it decides who may call, and issues the tokens |

The methods combine: a registry can accept its enterprise's JWTs *and* have a few locally
managed users for clients that can't do OAuth. The users are mostly software - a validator
in a build pipeline, a server resolving terminology - not people, and the design follows
from that.

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

(The message says `The token is not valid for this registry` when one was sent.) An open
registry ignores any token sent to it.

## How a client sends a token

As an HTTP bearer token, or in an `Api-Key` header (`X-API-Key` is accepted too):

```http
GET /tx-reg/resolve?fhirVersion=R4&url=http://loinc.org
Authorization: Bearer txr_k3Jd9...

GET /tx-reg/resolve?fhirVersion=R4&url=http://loinc.org
Api-Key: txr_k3Jd9...
```

The HL7 Java tooling (validator, IG publisher, and everything that uses
`TerminologyClientManager`) sends either for a server listed in its `fhir-settings.json`, so a
secured registry needs no change to the tools, only a settings entry:

```json
{ "servers": [
  { "url": "https://ecosystem.example.org/tx-reg",
    "authenticationType": "token", "token": "txr_k3Jd9..." }
] }
```

(`"authenticationType": "apikey", "apikey": "..."` sends the `Api-Key` header instead.) Note
that the tooling can *send* a token but not *obtain* one, so a Java client of an OIDC-secured
registry needs a long-lived token - from a local user, or an OIDC client credential arranged
outside the tool.

## Method 1: a single API token

```json
"security": { "apiToken": "a long random string" }
```

Every client sends the same token. Compared in constant time; nothing is stored. Rotating it
means changing the configuration and every client at once, which is why this suits only a few
clients you control.

## Method 2: users with their own tokens

```json
"security": {
  "users": {
    "database": "registry-auth.db",
    "adminUsername": "admin",
    "adminPassword": "...",
    "sessionSecret": "a long random string",
    "cookieSecure": true,
    "loginAttemptsPerWindow": 20
  }
}
```

Users are kept in a SQLite database (`database`: a file in the data folder's `databases`
directory, an absolute path, or `:memory:`). The administrator's login comes from the
configuration, as in the other FHIRsmith modules; without `adminPassword` nobody can create
users. `sessionSecret` keeps logins valid across restarts; `cookieSecure` (default true) marks
the login cookie `Secure`, which needs HTTPS and a proxy that passes `X-Forwarded-Proto`
([configuration.md](configuration.md#behind-a-proxy)). Logins are rate limited to
`loginAttemptsPerWindow` per 15 minutes per address.

**Administering users.** The administrator logs in at `/tx-reg/login` and manages users at
`/tx-reg/admin/users`: create a user (a login, a name, optional notes and password, and
whether it is an administrator), then on the user's page edit it, enable or disable it, set or
remove its password, issue and revoke tokens, or delete it. A user flagged **administrator**
can do all of this too, and edit [documents](documents.md); the configured administrator is
the root that cannot be locked out. The users list shows each user's active tokens, request count and last
use; an "other clients" table shows requests made with the API token and by OIDC clients.

**Tokens.** A token is `txr_` followed by 256 random bits (base64url, 47 characters). It is
shown once, on the page after it is issued, and only its SHA-256 hash is stored - a stolen
database yields no tokens, and the hash (rather than bcrypt) is right because the token is
already high-entropy and is checked on every API call. A token can carry a label and an
expiry (in days); it stops working when it expires, when it is revoked, or when its user is
disabled. Each token's requests are counted, in memory, and written to the database once a
minute. The first 12 characters are kept in clear as the token's name on the pages.

**Self service.** A user with a password can log in and manage its own tokens at
`/tx-reg/account`: see them and their usage, issue new ones, revoke old ones, and change the
password. To rotate a token without an outage: issue the new one, move the client to it,
revoke the old one. A user without a password cannot log in at all; its tokens still work.
The password is only for the pages - it is never accepted on the API.

**Web security.** The pages use the same protections as the other FHIRsmith modules: a
`SameSite=Lax`, `HttpOnly` session cookie; a CSRF token on every form; cross-site form posts
refused by `Origin`; bcrypt for passwords, with the same comparison time whether or not the
username exists; the session regenerated at login; every value from the database escaped on
output. Logins, user changes and token issue/revocation are logged.

## Method 3: OpenID Connect

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
`client_id`, `appid` or `sub` claim, and shown in the "other clients" table on the users page
when `users` is also configured. The registry keeps no record of OIDC clients beyond that.

**Which check a token gets.** A token of three dot-separated parts is treated as a JWT and
verified against the provider when `oidc` is configured; anything else is compared with
`apiToken`, then looked up among the users' tokens. So the three methods never confuse one
another's tokens.

This needs the `jose` package (a dependency of FHIRsmith); a registry configured for OIDC
without it refuses to start, with a message saying so.

## What is not done, and could be

* **Trusted proxy headers.** An enterprise that fronts the registry with its own gateway
  (mTLS, SSO, API keys it already issues) could pass the caller's identity in a header the
  registry trusts from that proxy only. Not implemented; the gateway can simply hold the
  registry's API token today.
* **Single sign-on for the pages.** The administrator and users log in with passwords. The
  OIDC provider could authenticate people to the pages too.
* **Token introspection, LDAP, SCIM.** Considered and set aside until a deployment needs one.
  Introspection (RFC 7662) suits opaque enterprise tokens at the cost of a call per request;
  LDAP is a human-login technology; SCIM would synchronise the enterprise's users into method
  2 but still leave the tokens to be issued here.
