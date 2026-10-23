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

A document is at most `maxSize` bytes. The module reads request bodies itself: the server's body parsers leave `/ips` alone, the submission token is checked before a document is read, and a document is read no bigger than `maxSize`. When it is indexed, at most 200 values are kept per
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

A browser (or `_format=html`) gets pages: `/ips/{code}` is the project's page - its name
and description in a banner, "Submit a document" (and, for managers, "Settings") buttons,
the filterable list (patient name, gender, document date, document id or patient identifier,
processing status; the FHIR parameters below work there too), and at the foot a
documentation section with the endpoint's URL, the CapabilityStatement link and a table of
the requests it answers - and `/ips/{code}/Bundle/{id}` shows the document.
The document page's header names the patient, the document's date, when and how it was
received and its size, with links to the FHIR JSON and to download it (`?download=1`, sent
as an attachment named `ips-{code}-{id}.json`). Below it, each processing step is shown
with where it is (tick: done, cross: failed, gear: running, moon: waiting - the step's note,
or for managers the reason it failed, on hover), and managers get "Process again" and
"Delete" buttons. The views of a document are tabs, chosen with `?view=`: `narrative` (the
default - the Composition's narrative followed by each section's, with the section titles),
`translation` (what the translate step did with each concept, below), `generated` (the
narrative this server generates, below), `validation` (below), `terminology`, `ai` (the AI assessment, below) and `json`
(pretty-printed, monospaced).
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
message of the step that failed. Each step's own state (`waiting`, `running`, `done` or
`failed`, with its note or error) is kept in its result row as it goes, which is what the
document page's step line shows; processing again clears every step's result first. The pipeline, in order, will be: **translate** CodeableConcepts
to the international terminologies; generate the **narrative**; **validate** the document;
measure its quality with PIQI; check it against the **clinical profiles**; **assess** it with AI. Translation, the narrative,
validation, the **terminology check**, the clinical profiles check and the AI assessment exist so far (PIQI does not). A step keeps what it finds in one of two places: as a result stored against the
document in `document_results` (one row per step - the validation outcome), or in the
**analysed copy** - a second copy of the document (`documents.analysed_json`) that the steps
adorn with extensions, so that the master document is never changed. The analysed copy is
rebuilt from the master on every run, so a document can always be processed again.
Anything left `processing` when the server stopped is queued again at startup. Managers can
queue a document again from its page, though not while it is being processed.

### Translation

The first step. Every CodeableConcept the terminology view lists is checked as the
terminology check (below) checks it; one that fails - no coding in the element's value set,
or, for an element with no value set of its own, no international coding - is sent to the
terminology server to translate: `ConceptMap/$translate` with `sourceCodeableConcept` (the
concept as submitted) and `targetScope` (the element's value set, or the fallback), the
value set and what it draws on as `tx-resource`. The server chooses the concept maps. Every
match that comes back (whatever its relationship) is added to the concept in the analysed
copy as a Coding, unless the concept already has that system and code, with an extension
saying where it came from:
`http://healthintersections.com.au/fhirsmith/StructureDefinition/ips-translation`, with
`server` (the terminology server, as configured), `conceptMap` (the match's `originMap`, when
the server names one) and `relationship` (the match's, R4's `equivalence` accepted too). The
terminology view marks such a coding "translated", with the detail on hover. A concept the
server could not say anything about (unknown) is not translated; a translation the server
fails on is logged and the step goes on. Translations are cached as the check's answers are,
and counted against the same per-document limit. The step's note says how many concepts
were tried and translated, and its result (`document_results`, step `translate`) records
what happened to every concept - not needed (already in its value set), not checked (the
server could not say), translated (the codings that came back, with their concept maps and
relationships, and which were already present), no translation, or failed - which the
document's `translation` view shows as a table.

### Narrative

The second step: the IPS presenter (`ips/presenter.js`) generates the document's narrative
from the analysed copy (so the translations are in it), as xhtml. It follows the FHIR rules
for presenting a document - the Composition's title, its subject, and its facts (date,
status, type, authors, attesters, custodian, encounter, event, confidentiality), then the
sections - with the patient summarised the way the Java PatientRenderer does (name, gender,
date of birth and identifiers on one line, then other names, contact details, address,
marital status, language, managing organization, general practitioner and contacts) and the
other people and organizations named by their names. The sections come in the IPS order
(`SECTION_ORDER` in terminology.js), sections the IPS doesn't know after them in document
order, nested sections after their parent with a smaller heading. Each section is titled
with its own title, else the IPS's default for its code. A section with entries is a table
of its resources, one row each (a resource referenced twice appears once), with the columns
that suit the resource type (`COLUMNS` in presenter.js: roughly the IPS profile's
must-support elements - AllergyIntolerance, Condition, MedicationStatement, MedicationRequest,
Medication, Immunization, Procedure, Observation, DiagnosticReport, DeviceUseStatement,
Device, Flag, Consent, CarePlan and ClinicalImpression have their own; anything else, or a
section of mixed types, gets the generic ones: resource, category, name, type, code, value,
status); a column no resource in the section has a value for is left out, and a resource's
nested parts (reactions, body sites, dosages, components, reference ranges, notes...) are
bullet points in a follow-up row beneath it. A section with no entries shows its own
narrative (parsed, not copied, and headed "Narrative as submitted"), else its emptyReason,
else "Nothing found to render".
References to a Medication show the medication's code; a reason or evidence that is a
reference is followed, an Observation shown as "code: value"; medication[x] and the other
choice elements are rendered by their type. A condition's or allergy's clinical and
verification statuses share one Status column ("Active / Confirmed"). An Observation's
single reference range is a column (several go beneath), and a blood pressure with systolic
and diastolic components is shown as one value (120/80 mmHg). Dates are dd-mmm yy, date
times dd-mmm yy hh:nn (tz), partial dates as far as they go. A coded value shows its text, else the first coding's
display, else any coding's display, else what the terminology server's `CodeSystem/$lookup`
says for a coding (cached, and at most 500 questions per document), else the code, else
`--`. The output is plain xhtml (tables with class names, no styles or scripts), every
value escaped.

The narrative is kept as the step's result (the whole document, and each section) and
written into the analysed copy as the Composition's `text` and each section's `text`
(status `generated`), which is what the validator then sees. The document's `generated`
view shows it.

### Validation

`modules.ips.validator` configures a FHIR validator service, exactly as the SHL module's
does (`fhir-validator-wrapper`: the validator CLI jar in the data folder's `bin` directory,
run as a service on its own `port`, with `txServer` - tx.fhir.org, by default - and the IPS
package loaded). It starts in the background when the module does, and the queue waits for
it. Each document - its analysed copy, so the translations are seen (the validator will
remark on the translation extension until it is given its definition) - is validated against the IPS Bundle profile
(`http://hl7.org/fhir/uv/ips/StructureDefinition/Bundle-uv-ips`; set `profiles` to validate
against something else) with the validator's IPS code checks on (`checkIpsCodes`), and the
OperationOutcome is stored with the document and shown on
its `validation` view: the counts, each issue's severity, code, location and message, and
the raw OperationOutcome. Without a configured, running validator the step fails, and the
document's status is `error`.

### Terminology check

After validation, every CodeableConcept the terminology view lists is checked for its
suitability for international exchange, against this module's own value sets - not the IPS
profiles' bindings. The value sets are FHIR ValueSets in `ips/valuesets/`
(`ValueSet-ips-*.json`, canonical `http://healthintersections.com.au/fhirsmith/ValueSet/ips-*`),
and `elements.json` there says which one each element is held to, by path
(`Condition.code` → `ips-condition-code`, `MedicationStatement.medicationCodeableConcept`,
`MedicationRequest.medicationCodeableConcept` and `Medication.code` → `ips-medication`,
`Observation.code` and `DiagnosticReport.code` → `ips-observation-code` (any LOINC code),
...). They are built on SNOMED CT International (every SNOMED CT include is pinned to the
International edition, `http://snomed.info/sct/900000000000207008`), LOINC, EDQM routes and
a few HL7 codes; `ips-codeable-concepts.md` lists every CodeableConcept element the IPS
profiles have, with their bindings, as the review the value sets came from. The folder also
carries the IPS's absent/unknown ValueSet and CodeSystem, which the vaccine and fallback
value sets draw on; they go with each question as `tx-resource`, so the server need not
know the IPS. The value sets are read at startup (`ips/ips-valuesets.js`); a folder that
doesn't hold together (an element mapped to a value set that isn't there, an include of
one that isn't) is logged and the step fails.

Elements not in `elements.json` have no value set of their own. For every element there is
a fallback: a coding is international anyway if it is in `ips-international-codes` (any
SNOMED CT International or LOINC code, or an IPS absent/unknown code), or if its system is
an HL7 terminology (`http://terminology.hl7.org/...` or `http://hl7.org/fhir/...`, but not
the `http://hl7.org/fhir/sid/` URLs that name other people's terminologies) and the code
exists in it (`CodeSystem/$validate-code`). The fallback is coded logic, not a value set,
for the HL7 case.

For each concept the terminology server is asked, with `ValueSet/$validate-code`, whether
any of its codings is in the element's value set (the value set itself and what it draws on
go with the request); failing that, whether any coding passes the fallback. The verdict is
written onto the concept in the analysed copy as an extension
(`http://healthintersections.com.au/fhirsmith/StructureDefinition/ips-valueset-check`:
`result` in | international | not-in | unknown, the `valueSet` it is held to or that
accepted it, the `system` for an HL7 code, the matching `coding`, a `message`), and the
terminology view's Analysis column shows it: a green tick when a coding is in the element's
value set (or, for an element with no value set of its own, when a coding is international),
an orange warning sign when no coding is in the element's value set but one is international,
a red cross when no coding is anywhere (a concept with no codings is a cross too), and a grey
question mark when the server could not say true or false. Answers are cached across
documents. A resubmitted analysed copy has its old verdicts stripped before it is checked
again.

### Clinical profiles

The profiles step runs after the terminology check and before the AI assessment. It checks the document against every [clinical profile](#clinical-profiles). Each constraint is evaluated on the analysed copy of the document, so translated codings count. A constraint is met when its expression evaluates to `true`, and only `true`. For each profile, the step records one of three outcomes, along with the descriptions of the constraints the document doesn't meet:

- **conforms:** every constraint is met.
- **does not conform:** at least one constraint plainly fails.
- **could not be fully checked:** the only failures are constraints that couldn't be decided. Either the expression couldn't be evaluated, or it uses a value set the terminology server couldn't answer for.

Value set membership (`entryIn()`, `resourcesIn()`) is asked of the terminology server through one membership session for the whole document, so a question is asked once however many profiles use it. Definite answers are kept across documents. A constraint is given 60 seconds.

The **Clinical Profiles** view lists each profile, linked to it, with its outcome and the constraints the document doesn't meet. A constraint that couldn't be decided is marked as such, and its reason is shown to the project's managers. The document is checked against the profiles as they were when it was processed; reprocess it to check against them as they are now.

### AI assessment

The last step, and off unless a project's managers turn it on (Settings → AI assessment),
because it sends the document to a third party and costs money: the analysed copy of the
document, as JSON, goes to an AI service with a prompt
(`AI_SYSTEM_PROMPT` in pipeline.js) asking for two assessments - the document as a whole,
for consistency and integrity (do its details agree with each other and the overall
picture; is anything missing) and its terminology (are the codes consistent with each other
and their text; are any wrong, contradictory or misplaced) - answered as JSON: a grade A-F,
a summary, consistency findings (severity, finding, where), what is missing, and terminology
findings (severity, finding, the codes). Whether the narrative goes is the project's choice
(its setting, else the server's `sendNarrative`, else not): without it the document is
smaller and cheaper; with it, the narratives are the ones the sender wrote (from the master -
the analysed copy's were generated by the narrative step), and the prompt asks for a third
assessment, what the narrative says that the structured data does not back up, and the
reverse. The submission page says so when it is on.

The service is an account - provider, base URL, model, API key - of one of two shapes
(`ips/ai-client.js`): `openai`, the chat-completions API that OpenAI, OpenRouter, LiteLLM,
Groq, Ollama, Azure and others speak (so a routing service is just a base URL), or
`anthropic`, the Messages API. A project may keep its own account (its managers enter it on
the settings page; the key is encrypted at rest with AES-256-GCM under `modules.ips.aiKeySecret`,
else the `sessionSecret`, so a copy of the database is not a copy of the account); a
project with none uses the server's default, `modules.ips.ai`; with neither, the step is
skipped. Each project may make `dailyCap` assessments in a rolling day (its own setting,
else the server's, else 50; the calls are counted in `ai_calls`), and a document bigger
than `maxBytes` (300000) is not sent; both are skips with a note, not failures. A service
that fails is a failure (the document's status is `error`), and still counts against the
cap. The result (model, token counts, cost, bytes sent, the tidied assessment and the
model's raw answer) is the step's result; the `ai` view shows the grade, the summary, the
findings as tables, and the raw answer behind a button. What each call used - model, tokens
in and out, cost - is kept in `ai_calls`, and the settings page totals it for the project
(today, the last 30 days, all time). The cost is what the service reports (OpenRouter's
`usage.cost`), else worked out from a price list - USD per million tokens by model name or
a prefix of it: Anthropic's current models are built in (`DEFAULT_PRICES` in ai-client.js,
and they will go stale), and `modules.ips.ai.prices` (`"gpt-4o": { "input": 2.5, "output": 10 }`)
adds to or overrides them - else not known, and the totals say how many calls had no known
cost. The answer is the model's opinion, and the page
says so.

## The editor

`/ips/{code}/compose` is an editor for composing a document in the browser ("Compose a
document" on the project's page; "Edit" on a document's page opens the editor with what
the form can hold of that document, and submitting makes a new document). The page is the
patient and the document's header (title, author - a practitioner or an organization -
custodian, date), then a panel per IPS section in the IPS order; the three the IPS requires
(problems, allergies, medications) are open, the rest collapsed. Each section is filled one
of three ways: entries - rows of the fields the presenter renders for that resource type,
coded fields looking codes up as you type; a narrative written by hand (paragraphs at
blank lines); or a reason it is empty (the `list-empty-reason` codes). Optional sections
can also be left out. What the form holds is declared in `ips/editor-schema.js` (the
fields, their types, the value set each coded field is bound to, where each lands in the
resource) and drives the form (`ips/editor.js`, served at `/ips/editor.js`), the building
of the document (`ips/composer.js`: the Bundle, the Composition with its sections, the
Patient, the author, each row's resource - a blood pressure as components, a device as a
Device and a DeviceUseStatement - and the narrative, generated by the presenter for the
data sections) and the reading of a document back into the form.

Lookups go to `/ips/{code}/lookup?vs={value set id}&q={text}`, which runs
`ValueSet/$expand` with a filter on the terminology server against one of the module's
own value sets (`ips/valuesets/`), returning up to 20 codes (rate-limited on their own:
`rateLimit.lookupMax`, 600 a minute). Anything can also be entered as text. The browser
keeps the model in localStorage until it is submitted. Submitting (`POST /ips/{code}/compose`,
JSON `{ action: 'submit' | 'download', model, token }`) builds the document, checks it as
a submission is checked (the project's token applies), and stores it like any other
(source `editor`), or hands it back as a file without storing it; the problems with a model
come back as a list for the page to show.

## Clinical profiles

A clinical profile says what a kind of clinical document is expected to contain. It is a StructureDefinition: a profile on Bundle (the document) with one element, the root, whose constraints are the expectations. Each constraint has a description and a FHIRPath expression on the document. Profiles are shared across all projects (`/ips/StructureDefinition`). Everyone can see them; only the administrator creates, edits, uploads and deletes them.

The administrator edits only the title and the constraints. The server sets everything else:

- the id: `profile-` plus a random private id;
- the url: `[base]/ips/StructureDefinition/profile-{id}`, fixed when the profile is made;
- the name, derived from the title (`Cardiology referral` → `CardiologyReferral`);
- each constraint's key (`cp-1`, `cp-2`...). A key is kept for as long as its constraint is, and never reused;
- severity `error`, status `active` and the date.

Most expectations take one of two shapes, using the module's own [FHIRPath functions](#fhirpath-functions):

```
Bundle.section(system, code [, min, max]).exists()
Bundle.section(system, code [, min, max]).entry(system, code [, min, max]).exists()
```

Rules about the resources in the document, whatever section they are in, take a third shape:

```
Bundle.resources(system, code [, type]).{the rest of the rule}
```

Entries and resources can be matched by value set instead of by one code: `Bundle.section(...).entryIn(valueSet [, min, max]).exists()`, and `Bundle.resourcesIn(valueSet [, type])...`. Sections are always matched by code. An example rule: `Bundle.resources('http://snomed.info/sct', '38341003', 'Condition').all(clinicalStatus.coding.code = 'active')`.

The editor (`/ips/StructureDefinition/new`, or Edit on a profile) is in three parts, and so is the page that shows a profile:

- **Required sections and entries:** the first two shapes, each a row of a table with four columns (the section, its cardinality, the entry code and its cardinality).
- **Rules about resources:** the third shape, each a row of a table with four columns (the type, which is optional, the system, the code, and the rest of the rule as FHIRPath starting with a dot).
- **Other rules:** any other FHIRPath.

A rule moves between the parts when it is switched between table and FHIRPath, and it lands in the part whose shape it fits. A section is one of the IPS sections, or any code in any system. An entry or resource code is a code in a named code system (SNOMED CT, LOINC, ICD-10...) or in any other given by URL, and it is looked up on the terminology server (`GET /ips/lookup?system=&q=`, for the administrator only). Choosing "In a value set..." as the system matches entries or resources by value set instead. The code box becomes a value set search (`GET /ips/lookup-vs?q=`, for the administrator only): this module's own value sets that match the title come first, then the terminology server's (a `ValueSet?title=` search). A suggestion shows its title, with its URL underneath. A canonical can also be typed or pasted in, with `|version` to pin a version. When the editor opens, it looks up the title of each value set by URL (`?url=`). If the terminology server doesn't know a value set, it says so as a warning, not an error: the value set has to be known when documents are checked, not when the profile is saved. A cardinality is blank (no bounds) or `min..max`, where max may be `*`. Before a profile is saved, every expression is parsed and run once against an empty document. That catches unknown functions and wrong numbers of arguments as well as syntax errors.

A profile can be downloaded as JSON (`?download=1`), and a downloaded profile can be uploaded again as a new profile, with a new id, url and keys. An upload must be no more than a profile like this: a profile on Bundle with no snapshot, and one differential element (the root) carrying constraints that have only a key, an `error` severity, a description, an expression and a source. Anything more is rejected, with the reasons. A profile downloaded when clinical profiles were on Composition is accepted and moved onto Bundle, as profiles already stored are when the server starts: `Composition.section(...)` becomes `Bundle.section(...)`, and any other `Composition.x` becomes `Bundle.entry.resource.ofType(Composition).x`.

As FHIR: `GET /ips/StructureDefinition` is a searchset of them all, and `GET /ips/StructureDefinition/{id}` is one of them.

## FHIRPath functions

`ips/fhirpath-ips.js` adds two functions to fhirpath.js, for expressions on IPS documents:

- `section(system, code [, min, max])`: the input is documents (Bundles) or Compositions. On a document it moves into the document's Composition by itself, which is why a clinical profile's rules, evaluated on the document, can say `Bundle.section(...)`. For each input, it returns the Composition's sections, nested ones included, whose `code` has a coding with that system and code.
- `resources(system, code [, type])`: the input is documents, or anything in one (a Composition, say). It returns every resource in the document whose `code`, `medicationCodeableConcept` or `vaccineCode` has a coding with that system and code, and that is of the given type when a type is given.
- `entryIn(valueSet [, min, max])` and `resourcesIn(valueSet [, type])`: as `entry()` and `resources()`, but they match a code in a value set (a canonical, with or without `|version`) rather than one given code. A resource is in when any coding of its code is. These two ask a terminology server, so the evaluation must be asynchronous (`evaluateAsync`), with a `membership` function in the options. A `MembershipSession` (`ips/membership.js`, made by the module's `membershipSession()`) provides one: it asks `ValueSet/$validate-code` with the CodeableConcept, only for what a rule actually reaches. Within a session, each question is asked once, and there's a budget of 500 per document. Definite answers are also kept in the module's cache, so the next document doesn't ask again. When the server can't answer (it doesn't know the value set, say), the answer is "not a member" for that run, and the session's `unresolved()` lists the value set and the server's message, so a rule that failed for that reason can be told apart from one that plainly failed. The module's own value sets (`ips/valuesets/`) are sent with the question, so any server can answer for them; any other value set must be one the server knows.
- `entry(system, code [, min, max])`: the input is sections, usually from `section()`. For each one, it returns its resolved entries whose `code`, `medicationCodeableConcept` or `vaccineCode` has a coding with that system and code. `medicationReference` is not followed.

`min` and `max` are optional (both or neither), and `max` may be `'*'`. The bounds apply to each input item: when the number found is outside them, that item adds nothing. That isn't an error. References are resolved in the Bundle the section is in, or failing that the Bundle the expression was evaluated on:

- absolute `fullUrl`s (`urn:uuid:`, `http…`) match as they are;
- a relative `Type/id` is resolved against the base of the Composition's `fullUrl`, or matched by type and id when there's no usable base;
- `#id` is a resource contained in the Composition.

Anything still unresolved goes to the caller's `resolve(reference, composition)`, if there is one.

```js
const { evaluate, ipsFunctions } = require('./fhirpath-ips');
evaluate(bundle, "section('http://loinc.org', '11450-4', 1, 1).entry('http://snomed.info/sct', '38341003', 1, '*').exists()");
// or, with fhirpath.js directly:
fhirpath.evaluate(bundle, expr, null, r4Model, { userInvocationTable: ipsFunctions({ resolve }) });
```

## Sharing as SHL / VHL

With `modules.ips.shl` configured, a document's page has "Share as SHL" and "Share as VHL"
buttons (for anyone who can see the document). Each makes a QR code in a panel over the
page, to scan or copy, with what the code carries in a box beside a Copy button, and the
link to the manifest; without scripts, the same lands on its own page. The steps are the
ones the healthintersections.com.au passport page takes, here on the server (`ips/share.js`):
an entry is created on the SHL server (`POST {shl}/create`, with the server's password and
the number of days the copy lives), the document (the master, as submitted) is encrypted
as a JWE (`dir` / `A256GCM`, a random key) and uploaded (`POST {shl}/upload`), and the
shlink payload - the manifest link, the key, flag `U`, a label naming the patient - is
base64url-encoded. An SHL's code carries `{viewer}#shlink:/{payload}`; a VHL's carries
`HC1:` and the SHL server's signature of `shlink://{payload}` (`POST {shl}/sign`: a
COSE_Sign1 of the GDHCN payload, deflated and base45). The SHL server is this server's own
shl module (`"server": "/shl"`, dispatched in-process, the password taken from
`modules.shl.password` unless given) or another FHIRsmith's (an https URL and its password).
Shares are rate-limited as submissions are, and a document whose JWE is over 2MB is not
shared this way. The QR codes are made with `qrcode-generator`, error correction L.

### Validation view

The view shows everything by default; its "Show" selector (`?level=warning` or
`?level=error`) hides the lesser issues - the summary line still counts them all.
`fhir-validator-wrapper` 1.5.0 or later is needed: earlier versions sent the profiles in a
form the validator service refuses.
