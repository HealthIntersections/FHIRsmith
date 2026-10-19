# IPS module

Collections of International Patient Summary documents, called projects, each with its own
FHIR endpoint and web pages. It runs at `/ips` when `modules.ips.enabled` is true.

## Configuration

```json
"ips": {
  "enabled": true,
  "database": "ips/ips-content.db",
  "adminUsername": "admin",
  "adminPassword": "<secret>",
  "sessionSecret": "<random string>",
  "cookieSecure": true,
  "loginAttemptsPerWindow": 20,
  "maxSize": 10485760,
  "rateLimit": { "windowMinutes": 1, "max": 60 },
  "processing": { "enabled": true, "intervalSeconds": 5 },
  "txServer": "/tx/r4"
}
```

Everything is in one SQLite database; a relative path resolves under the data folder's
`databases` directory. The administrator's login is `adminUsername` (default `admin`) with
`adminPassword` - without a password there is no administrator, so nothing can be created.
`sessionSecret` signs the login cookie; `cookieSecure: false` is for local testing over
plain http (see the publisher's notes on nginx and `X-Forwarded-Proto`). `maxSize` is the
biggest document accepted, in bytes; `rateLimit` is submissions per IP address (`max: 0`
turns it off). `txServer` is the terminology server the module uses - for links from the
terminology view to code systems, and for the analysis of documents: either an http(s) URL
of an external server, or a path on this server (`/tx/r4`) when the tx module is enabled,
in which case requests are dispatched to it in-process (`ips/tx-client.js`), with no
network. Without it there are no links and no analysis.

## Projects, the administrator, and managers

`/ips` lists the projects. The administrator logs in at `/ips/login` and, at
`/ips/admin/projects` and `/ips/admin/users`, creates and deletes projects and users, and
says which users manage which projects. A project has a code - 2-32 lower case letters,
digits and hyphens, fixed once it exists - and lives at `/ips/{code}`. Deleting a project
deletes its documents.

A project's managers (and the administrator) can:

- set the project's submission token at `/ips/{code}/settings`. When one is set, a document
  can only be submitted with it: in the `token` field of the submission form, or as
  `Authorization: Bearer <token>` on a `POST`. Managers can read the token back, so it is
  stored as it is, not hashed
- delete documents, and put a document back in the processing queue

Logins work as the publisher's and the testing module's do: a session cookie
(`ips.sid`, SameSite=Lax, HTTPS-only unless `cookieSecure` is false), bcrypt password
hashes, a rate limited login, an Origin check and a CSRF token on every form post - except
the submission form, which anyone may post (with the project's token, if it has one), so it
carries no CSRF token and starts no session; the Origin check still applies.

## Limits

A document is at most `maxSize` bytes. When it is indexed, at most 200 values are kept per
search parameter; a search takes at most 5 sort keys, and a page of the FHIR search carries at
most 32MB of documents (the `next` link follows on from where the page stopped). The
terminology check asks the terminology server at most 2000 questions per document (the rest
are left unknown) and remembers 20000 answers. Narratives are shown as parsed, never as the
string submitted. Error responses carry no internal detail; the reason a document's
processing failed is shown only to the project's managers.

## Documents

A document is an R4 `Bundle` of type `document` whose first entry is a `Composition` whose
subject is a `Patient` in the bundle. Nothing else about its content is checked (that is for
processing, later), except that no narrative in it - any resource's `text.div`, or a
section's - may have active content (script, event handlers, `javascript:` URLs, frames,
forms and the like; see `library/narrative-check.js`), because the web site shows the
narratives as they are.

    POST /ips/{code}/Bundle
    Content-Type: application/fhir+json
    Authorization: Bearer <token>        (only if the project has one)

or paste the JSON (or pick a file) at `/ips/{code}/submit`. The server gives the document its
id - a serial number, one series across all projects - sets `meta.lastUpdated` to the time it
was received, and drops `meta.versionId`: documents can't be changed once received.
Responses follow the spec: `201 Created` with a `Location` header, and the stored document,
or nothing (`Prefer: return=minimal`), or an OperationOutcome (`Prefer: return=OperationOutcome`).
Errors are OperationOutcomes: 400, 401 (token), 413 (too big), 415 (not JSON), 429 (rate
limit). The submitter's IP address is recorded, for tracing abuse, and never returned.

    GET /ips/{code}/Bundle/{id}          the document (JSON), or a view of it for a browser
    GET /ips/{code}/Bundle?{params}      search
    GET /ips/{code}/metadata             CapabilityStatement

A browser (or `_format=html`) gets pages: `/ips/{code}` is the filterable list (patient name,
gender, document date, document id or patient identifier, processing status; the FHIR
parameters below work there too), and `/ips/{code}/Bundle/{id}` shows the document.
The views of a document are chosen with `?view=`: `narrative` (the default - the
Composition's narrative followed by each section's, with the section titles), `terminology`,
`validation` (below) and `json`.
`terminology` lists every CodeableConcept in the document (`ips/terminology.js`): the
Composition's own, then each section's entries in the IPS section order (Patient Story,
Problems, Allergies, Medications, ... Results; sections not in that list after, in document
order), found by walking each resource against the R4 type model. Section codes, every
`category`, `Composition.type`, `Composition.event.code`, and the clinical and verification
status of Conditions and AllergyIntolerances are left out (`IGNORED` in terminology.js). Codings are shown as the Java
DataRenderer shows them: the code system by name with the URL on hover, the version
described after it in brackets - for SNOMED CT the edition's short code and release
("US rel. Mar 2024", from `tx/sct/editions.js`, with the edition's full name on hover) - then
the code and display. The external terminologies (SNOMED CT, LOINC, RxNorm, NCI Thesaurus,
ISO 3166) link name and code to their own browsers (SNOMED CT to the edition's URI,
`http://snomed.info/sct/{edition}/id/{code}`, when the version names a known edition); any
other code system links to its page on the terminology server. More
views will come.

### Searching

A search is over Bundle; the Composition's and Patient's parameters are reached by chaining
through `composition` and then `patient` (or `subject`). The standard R4 parameters are
indexed (`ips/search-params.js` lists them, with their FHIRPath expressions):

    _id, _lastUpdated                         the server's id, and when it received the document
    processing-status                         submitted | processing | processed | error (this module's own)
    identifier, type, timestamp, composition  Bundle
    composition.date, composition.type, composition.title, composition.status, composition.author, ...
    composition.patient.name, composition.patient.birthdate, composition.patient.gender,
    composition.patient.identifier, composition.patient.address-city, ...

Strings match from the start, case-insensitively, with `:exact` and `:contains`; tokens are
`code` or `system|code` (`|code` for no system, `system|` for any code in the system), with
`:not`; dates take the usual prefixes (`ge2026`, `lt2026-03-01`) and compare as ranges;
references match as written, or by `Type/id` or `id` at the end of what was written;
`:missing` works everywhere. Comma separated values are ORed, repeated parameters ANDed.
`_sort` takes any of these (`-` for descending), `_count`/`_offset` page, `_summary=count`
gives the total alone. Unknown parameters are ignored, with a warning OperationOutcome in the
result - unless `Prefer: handling=strict`, when they are a 400.

Each document is indexed once, when it arrives: every parameter's expression is evaluated
with fhirpath.js against the Bundle, the Composition and the Patient, and the values go into
one index table (`ips_index`). Adding a parameter to `search-params.js` indexes new documents
only; the index for existing ones would need rebuilding.

## Processing

A received document's status is `submitted`. A background loop (every `intervalSeconds`)
takes submitted documents in turn, marks each `processing`, runs the pipeline's steps over
it (`ips/pipeline.js`), and marks it `processed` with the steps' notes, or `error` with the
message of the step that failed. The pipeline, in order, will be: translate CodeableConcepts
to the international terminologies; generate the narrative; **validate** the document;
measure its quality with PIQI; assess it with AI. Validation and the terminology check exist
so far. A step keeps what it finds in one of two places: as a result stored against the
document in `document_results` (one row per step - the validation outcome), or in the
**analysed copy** - a second copy of the document (`documents.analysed_json`) that the steps
adorn with extensions, so that the master document is never changed. The analysed copy is
rebuilt from the master on every run, so a document can always be processed again.
Anything left `processing` when the server stopped is queued again at startup. Managers can
queue a document again from its page.

### Validation

`modules.ips.validator` configures a FHIR validator service, exactly as the SHL module's
does (`fhir-validator-wrapper`: the validator CLI jar in the data folder's `bin` directory,
run as a service on its own `port`, with `txServer` - tx.fhir.org, by default - and the IPS
package loaded). It starts in the background when the module does, and the queue waits for
it. Each document is validated against the IPS Bundle profile
(`http://hl7.org/fhir/uv/ips/StructureDefinition/Bundle-uv-ips`; set `profiles` to validate
against something else) with the validator's IPS code checks on (`checkIpsCodes`), and the
OperationOutcome is stored with the document and shown on
its `validation` view: the counts, each issue's severity, code, location and message, and
the raw OperationOutcome. Without a configured, running validator the step fails, and the
document's status is `error`.

### Terminology check

After validation, every CodeableConcept the terminology view lists is checked against the
value sets the IPS wants it in. Those come from the IPS package itself
(`ips/ips-bindings.js`, `modules.ips.ipsPackage`, default the package the validator loads).
The IPS Composition profile's section slices say which profiles each section's entries
conform to (Problems → Condition-uv-ips, Results → Observation-results-uv-ips and the
laboratory, pathology and radiology profiles derived from it, Vital Signs → the base
specification's `vitalsigns`, read from the core package the IPS depends on); a concept in
an entry is checked against those profiles' constraints on its element (so
`MedicationStatement.medicationCodeableConcept` finds the `medication[x]` binding). What
counts as a candidate: a binding to one of the IPS's own value sets at any strength, a
binding to any other value set at preferred or stronger (never example), and a pattern or
fixed CodeableConcept, taken as a value set of one. An entry in a section the IPS doesn't
know, or whose profiles don't cover the resource type, is checked against every IPS profile
of that type.

For each concept the terminology server is asked, with `ValueSet/$validate-code`, whether
any of its codings is in any candidate value set; the value set itself, the IPS value sets it
includes and the IPS's own code systems they use go with the request, so the server need not
know the IPS (a core value set is read from the core package the same way). A fixed code is
answered without the server. The verdict is written
onto the concept in the analysed copy as an extension
(`http://healthintersections.com.au/fhirsmith/StructureDefinition/ips-valueset-check`:
`result` in | not-in | unknown, the `valueSet`(s), the matching `coding`, a `message`), and
the terminology view's Analysis column shows it: a green tick when a coding is in an IPS
value set, a red cross when none is (a concept with no codings is a cross too), an orange
question mark when the server could not say true or false, and nothing where the IPS has no
binding for the element. Answers are cached across documents. A resubmitted analysed copy
has its old verdicts stripped before it is checked again.

### Validation view

The view shows everything by default; its "Show" selector (`?level=warning` or
`?level=error`) hides the lesser issues - the summary line still counts them all.
`fhir-validator-wrapper` 1.5.0 or later is needed: earlier versions sent the profiles in a
form the validator service refuses.
