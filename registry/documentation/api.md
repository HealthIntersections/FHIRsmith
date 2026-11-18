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

There are two operations from the ecosystem IG, and one extension, all `GET`:

| Endpoint | |
|---|---|
| `/tx-reg/` | **Discovery** - the server endpoints in the ecosystem |
| `/tx-reg/resolve` | **Resolution** - which endpoints to use for a code system or value set |
| `/tx-reg/choose-server` | **Server choice** - which one server to use for a request involving several code systems (JSON only; [below](#server-choice-get-tx-regchoose-server)) |

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

## Server choice: `GET /tx-reg/choose-server`

Not in the ecosystem IG. A request often involves several code systems - a value set that
includes LOINC and a national code system, a CodeableConcept with codings from three - and
resolution answers for one at a time. The HL7 Java tooling combines the answers into a choice
of one server (`TerminologyClientManager.chooseServer` in org.hl7.fhir.core); this makes the
same choice here for clients that aren't Java. It doesn't replace the Java code, which still
does its own choosing.

| Parameter | |
|---|---|
| `fhirVersion` | Required, as for resolve |
| `system` | A code system the request involves, `url` or `url\|version`. Repeat it for each (`system=a&system=b`) - the one parameter that isn't first-value-only |
| `default` | Required. The client's default terminology server: the fallback, and the server for the code systems tx.fhir.org handles specially |
| `valueSet` | The value set the request is about, `url` or `url\|version`, if there is one |
| `language` | As for resolve, but only for language sensitive requests (an expansion where the display language matters, a validation that checks a display, a lookup that returns designations) |
| `usage` | As for resolve |

```json
{
  "server": "https://tx.ontoserver.csiro.au/fhir",
  "log": [
    "https://healthterminologies.gov.au/fhir/CodeSystem/x: authoritative [https://tx.ontoserver.csiro.au/fhir], candidates []",
    "http://terminology.hl7.org/CodeSystem/v2-0203: authoritative [http://tx.fhir.org/r4], candidates [https://tx.ontoserver.csiro.au/fhir]",
    "Found partially authoritative server https://tx.ontoserver.csiro.au/fhir"
  ]
}
```

`log` is for people: what resolution says about each code system, then the rule that decided.

### What the client does first

What the Java tooling works out before it chooses, a client must too:

* The code systems: from the codings, and from the value set's includes and excludes,
  following imported value sets. The imports are often only in the client's own context (the
  IG being built), so the registry can't follow them. If the client can't follow one, it
  should use its default server without asking.
* Versions: those fixed by the expansion parameters (`system-version`,
  `force-system-version`) applied to the systems.
* Language: for an expansion, the `displayLanguage` of the expansion parameters if no other.

### How the choice is made

In order:

1. A server authoritative for all the code systems.
2. A server authoritative for one, and authoritative or a candidate for each of the others.
3. Several code systems including SNOMED CT: the choice for SNOMED CT alone. Otherwise, if a
   code system is one tx.fhir.org handles specially (LOINC, UCUM, RxNorm, CVX, NDC, CPT,
   BCP-13/47, ISO 3166/4217 ...): the default.
4. A server that is a candidate for all of them, and has a usable copy of each - its
   TerminologyCapabilities says `complete` or `fragment`, or gives no content mode. Not
   checked for a code system tx.fhir.org is also a candidate for.
5. The server authoritative for the most of them (the first, on a tie).
6. The server the value set comes from (by resolving `valueSet`), else the default.

In 2 and 4, a code system that no server hosts doesn't count against a server.

Where this differs from the Java tooling: step 4 uses the content mode the registry scanned
instead of searching the server, and trusts a server that didn't say; the special handling in
step 3 sends to `default` rather than to whichever of tx.fhir.org / tx-dev the client has used;
ties go to the first rather than to hash order. Step 3 is tx.fhir.org specific, and applies to
any ecosystem for now.


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
