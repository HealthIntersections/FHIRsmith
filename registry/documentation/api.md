# Registry API

The normative description of the coordination server API is the
[ecosystem page](https://build.fhir.org/ig/HL7/fhir-tx-ecosystem-ig/ecosystem.html) of the
terminology ecosystem IG. This page describes what this registry implements, including where
it extends the IG. The machine-readable description is the OpenAPI 3.1 document, which is the
contract:

| URL | |
|---|---|
| `/tx-reg/openapi` | Browsable reference (HTML), with a "try it" form for each operation; the JSON for other clients |
| `/tx-reg/openapi.json` | The description as JSON |
| `/tx-reg/openapi.yaml` | The description as YAML - the source file, [openapi.yaml](../openapi.yaml) |

Every response carries `Link: </tx-reg/openapi.json>; rel="service-desc"` (RFC 8631), and the
HTML pages the matching `<link>` element.

There are two operations, both `GET`:

| Endpoint | |
|---|---|
| `/tx-reg/` | **Discovery** - the server endpoints in the ecosystem |
| `/tx-reg/resolve` | **Resolution** - which endpoints to use for a code system or value set |

Both answer JSON, or an HTML page when the request's `Accept` header contains `text/html`.
`/tx-reg/resolve` in a browser without parameters is a form for trying it. Parameters are read
leniently: unknown parameters are ignored, and a repeated parameter takes its first value
(existing ecosystem clients depend on this).

When the registry is secured ([security.md](security.md)) the JSON forms of both require a
token, sent as `Authorization: Bearer {token}` or `Api-Key: {token}`; without one they answer
`401` with `WWW-Authenticate: Bearer realm="tx-reg"`. The HTML pages and the OpenAPI
description are always open.

## Discovery: `GET /tx-reg/`

Lists the endpoints in the ecosystem, one entry per server per FHIR version.

| Parameter | |
|---|---|
| `registry` | Only endpoints from this registry (its code in the master file) |
| `server` | Only endpoints of this server (its code in its registry) |
| `fhirVersion` | Only endpoints for this FHIR version: `R4`, `R4B`, `R5` ... or `4.0.1`, `4.0` |
| `url` | Only endpoints that host this code system (`url` or `url\|version`), the authoritative ones first |
| `authoritativeOnly` | With `url`: only endpoints authoritative for it |
| `language` | With `url`: prefer endpoints with a language specific claim for it |

```json
{
  "last-update": "2026-10-21T22:30:11.412Z",
  "master-url": "https://fhir.github.io/ig-registry/tx-servers.json",
  "results": [
    {
      "server-name": "tx.fhir.org", "server-code": "tx.fhir.org",
      "registry-name": "HL7 Terminology Services", "registry-code": "hl7",
      "registry-url": "https://raw.githubusercontent.com/FHIR/ig-registry/master/hl7-tx-servers.json",
      "url": "http://tx.fhir.org/r4", "fhirVersion": "4.0.1",
      "error": null, "last-success": 184233, "systems": 2311,
      "authoritative": ["http://hl7.org/fhir/*", "http://terminology.hl7.org/*"],
      "authoritative-valuesets": ["http://hl7.org/fhir/ValueSet/*"],
      "security": "open", "open": true
    }
  ]
}
```

`error` is what went wrong the last time the endpoint was scanned (null if it worked), and
`last-success` is how many milliseconds ago it was last scanned successfully. Without `url`,
`authoritative` and `authoritative-valuesets` are the server's claim masks as registered, and
there are no candidate lists - listing everything every server hosts would be enormous. With
`url`, an entry has `candidate: [url]` when the endpoint hosts the code system without
claiming authority for it, and with `language` too, `languages` gives the tag of the claim the
endpoint matched on.

## Resolution: `GET /tx-reg/resolve`

Returns the endpoints to use for one code system or value set at one FHIR version: those
authoritative for it, then the other candidates that host it. Choosing between several is the
client's business (the Java tooling takes the first).

| Parameter | |
|---|---|
| `fhirVersion` | Required. `R4`, `R4B`, `R5` ... or `4.0.1`, `4.0` |
| `url` | The code system, `url` or `url\|version`. One of `url` and `valueSet` is required |
| `version` | A version for `url`, instead of `url\|version` (an extension to the IG; ignored if `url` has one) |
| `valueSet` | The value set, `url` or `url\|version` |
| `authoritativeOnly` | Only authoritative endpoints, no candidates |
| `language` | The language the client needs (BCP-47) |
| `usage` | What the client is doing - `publication`, `validation`, `code-generation` - for servers that restrict their use |

```json
{
  "formatVersion": "1",
  "registry-url": "https://fhir.github.io/ig-registry/tx-servers.json",
  "authoritative": [
    { "server-name": "tx.fhir.org", "url": "http://tx.fhir.org/r4", "fhirVersion": "4.0.1",
      "security": "open", "open": true }
  ],
  "candidates": [
    { "server-name": "HL7 Europe Terminology Server", "url": "http://tx.hl7europe.eu/r4",
      "fhirVersion": "4.0.1", "content": "complete", "security": "open", "open": true }
  ]
}
```

`access_info`, when present, is the server's own (markdown) note on how to get access.
`content` on a candidate is the content mode the server reports for the code system
(`complete`, `fragment` ...), if it reports one. `authoritative` and `candidates` are omitted
when empty, so an empty object means nobody hosts it.

### How resolution decides

* An endpoint is only ever returned for content it actually hosts, as learned by scanning:
  code systems from its TerminologyCapabilities, value sets from its ValueSet search. A claim
  without the content gets nothing.
* Code system versions: a SNOMED CT edition (`http://snomed.info/sct|http://snomed.info/sct/{edition}`)
  is hosted by any endpoint that hosts a version of that edition; a dated SNOMED CT version
  must match exactly. For every other code system, an endpoint that hosts the code system is
  taken to host all its versions - servers rarely declare versions fully, and the server will
  say if it hasn't got one.
* Endpoints whose server claims authority for the URL (a mask in `authoritative`, or
  `authoritative-valuesets`) are listed as `authoritative`; the others that host it as
  `candidates`. An endpoint is never in both.
* `language`: servers with a language specific claim (`languages` in the registration)
  matching the request come first among the authoritative, the most specific tag first
  (`de-CH` before `de`); a server with a claim for the code system but not the language is
  still authoritative, after them; candidates are marked `language-support: unknown`. Value
  set resolution has no language dimension.
* `usage`: a server whose registration has a `usage` list is only returned when the request's
  `usage` is in it. A request without `usage` gets only servers without the restriction.
* `exclusions`: content a server's registration excludes is hidden from that server
  entirely - it is neither authoritative nor a candidate for it.
* The `url` of a FHIR-defined code system or value set may be given with or without the
  `|version`; the FHIR version itself is taken from `fhirVersion`.

### Differences from the ecosystem IG

* Discovery without `url` returns claim masks, not candidate lists (above).
* Entries carry the IG's security flags (`open`, `token`, `oauth` ...) and also a `security`
  string (`open` or `api-key`), kept for existing clients. Both record how the *registry*
  reaches the server: an endpoint is `api-key`/`token` when the registry is configured with a
  key for it, and `open` otherwise. They say nothing about how the client will be let in.
* Resolve takes `version` as an alternative to `url|version`.
* Resolve omits `authoritative` and `candidates` when they are empty.

## Operational pages

These are HTML, not part of the API, and never secured:

| URL | |
|---|---|
| `/tx-reg/software` | What each server runs, how old it is, and its uptime ([internals.md](internals.md#the-software-page)) |
| `/tx-reg/log` | The scanner's log |
| `/tx-reg/login`, `/tx-reg/account`, `/tx-reg/admin/users` | Login and user administration, when users are configured ([security.md](security.md)) |

## Keeping the description honest

[openapi.yaml](../openapi.yaml) is written by hand. `tests/registry/openapi.test.js` fails if
the router has a route the description doesn't (unless the test's `EXCLUDED` table names it as
operational), if the description has a route the router hasn't, or if the documented query
parameters differ from `DISCOVERY_PARAMS` and `RESOLVE_PARAMS` in `registry.js`. Change the
description with the code.
