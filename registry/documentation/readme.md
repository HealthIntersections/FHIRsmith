# Terminology Server Registry

The registry (`/tx-reg`) is the *coordination server* of a terminology server ecosystem: a
set of FHIR terminology servers, run by different organisations, that together serve the
code systems and value sets an implementer community needs. Each server hosts some of the
content and may be *authoritative* for some of it; the registry knows who hosts what, and
tells clients which server to ask for a given code system or value set. HL7's ecosystem
registry runs at https://tx.fhir.org/tx-reg (moving to https://ecosystem.hl7.org).

| Page | |
|---|---|
| this page | What the registry does, and the specifications it implements |
| [configuration.md](configuration.md) | `modules.registry` settings |
| [api.md](api.md) | The API: discovery, resolution, and how resolution decides |
| [security.md](security.md) | Closing the API: API token, users and tokens, OpenID Connect |
| [documents.md](documents.md) | Documents the registry stores and serves: ecosystem policy and configuration |
| [internals.md](internals.md) | Scanning, storage, the pages, the code and the tests |

## The specifications

**The terminology ecosystem IG.** The ecosystem, its registration files and the coordination
server's API are specified by HL7's
[FHIR Terminology Ecosystem IG](https://build.fhir.org/ig/HL7/fhir-tx-ecosystem-ig/), on its
[ecosystem page](https://build.fhir.org/ig/HL7/fhir-tx-ecosystem-ig/ecosystem.html). That page
is normative for what the registry answers; where this implementation extends or departs from
it, [api.md](api.md) says so.

**The registration files.** The ecosystem is declared by a *master registration file* that
lists *registries*, each of which lists *servers*, each of which lists its endpoints (one per
FHIR version) and its claims. The format is documented on the IG's ecosystem page; HL7's own
ecosystem (its locations, and how to register a server in it) is documented in the ig-registry
repository's [tx-registry-doco.md](https://github.com/FHIR/ig-registry/blob/master/tx-registry-doco.md).
HL7's master file is https://fhir.github.io/ig-registry/tx-servers.json, and its registries
are the per-affiliate `*-tx-servers.json` files in the same repository (HL7 International,
HL7 Australia, HL7 Europe, and so on). A server's registration carries:

* `authoritative` and `authoritative-valuesets`: URL masks (with `*` wildcards) of the code
  systems and value sets the server is the authority for;
* `languages`: language specific authority claims, BCP-47 tag to code system masks;
* `usage`: if present, the only purposes the server may be used for (the HL7 Java tools say
  `publication`, `validation` or `code-generation`);
* `exclusions`: code system and value set masks the server hosts but withholds from the
  ecosystem;
* `fhirVersions`: the endpoints, each a FHIR version and a URL.

**What the registry reads from the servers.** Claims are what a server says about itself; what
it actually hosts, the registry learns by scanning each endpoint with standard FHIR:

* [`GET [base]/metadata`](https://hl7.org/fhir/http.html#capabilities), the
  [CapabilityStatement](https://hl7.org/fhir/capabilitystatement.html), for
  `software.name`, `software.version` and `software.releaseDate` (the software page);
* `GET [base]/metadata?mode=terminology`, the
  [TerminologyCapabilities](https://hl7.org/fhir/terminologycapabilities.html), for the code
  systems and versions the endpoint hosts (`codeSystem[].uri`, `codeSystem[].version[].code`);
* `GET [base]/ValueSet?_elements=url,version`, a [search](https://hl7.org/fhir/search.html)
  for the value sets it hosts.

Content a server hosts is what makes it a *candidate* for that content; a claim makes it
*authoritative*. A server is never returned for content it does not host, whatever it claims.

**FHIR versions.** Endpoints are scanned as R3, R4 (including R4B) or R5 by the major version
in their registration, and requests may name a version as a release code (`R4`, `R5`) or a
number (`4.0.1`, `4.0`).

**SNOMED CT.** SNOMED CT versions are edition URIs,
`http://snomed.info/sct/{edition}/version/{date}`
([SNOMED CT URI standard](https://confluence.ihtsdotools.org/display/DOCURI)). The registry
treats a request for an edition (`http://snomed.info/sct|http://snomed.info/sct/32506021000036107`)
as satisfied by any endpoint hosting any version of that edition; a request for a dated
version must match exactly.

**The API description.** The API is described by an [OpenAPI 3.1](https://spec.openapis.org/oas/v3.1.0)
document at `/tx-reg/openapi.json` (and `.yaml`), with a browsable reference at
`/tx-reg/openapi`. Every response advertises it with a
`Link: </tx-reg/openapi.json>; rel="service-desc"` header
([RFC 8631](https://www.rfc-editor.org/rfc/rfc8631)).

**Security.** When the API is closed, clients present a token as an HTTP bearer token
([RFC 6750](https://www.rfc-editor.org/rfc/rfc6750)) or an `Api-Key` header. Enterprise
clients can present a JWT ([RFC 7519](https://www.rfc-editor.org/rfc/rfc7519)) from an
[OpenID Connect](https://openid.net/specs/openid-connect-core-1_0.html) provider, which the
registry verifies against the provider's keys
([OpenID Connect Discovery](https://openid.net/specs/openid-connect-discovery-1_0.html),
[JWK, RFC 7517](https://www.rfc-editor.org/rfc/rfc7517)), typically obtained with the OAuth 2.0
client credentials grant ([RFC 6749 §4.4](https://www.rfc-editor.org/rfc/rfc6749#section-4.4)).
See [security.md](security.md).

## Who uses it

The main client is the HL7 Java tooling: `TerminologyClientManager` in `org.hl7.fhir.r5`
(used by the validator, the IG publisher and everything built on them) calls `/resolve` for
each code system or value set it meets, remembers the answer per code system and language, and
routes each terminology operation to the server the registry named. Other clients - the
registry's own pages, scripts, other servers - use the same two endpoints.

## Running one

A registry is a FHIRsmith server with the `registry` module enabled; nothing else is needed
([configuration.md](configuration.md)). Pointing `masterUrl` at your own master registration
file makes a registry for your own ecosystem - a national or enterprise set of servers - with
the same API, and [security.md](security.md) closes it to your own clients.
