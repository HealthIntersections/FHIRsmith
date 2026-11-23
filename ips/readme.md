# IPS module

Collections of International Patient Summary documents, called projects, each with its own
FHIR endpoint and web pages. It runs at `/ips` when `modules.ips.enabled` is true.

## Configuration

```json
"ips": {
  "enabled": true,
  "database": "ips/ips-content.db",
  "maxSize": 10485760,
  "rateLimit": { "windowMinutes": 1, "max": 60 },
  "processing": { "enabled": true, "intervalSeconds": 5 },
  "txServer": "/tx/r4"
}
```

Everything is in one SQLite database; a relative path resolves under the data folder's
`databases` directory. Users and logins are the server's ([library/auth](../library/auth/README.md)):
the module has no logins or passwords of its own. `maxSize` is the
biggest document accepted, in bytes; `rateLimit` is submissions per IP address (`max: 0`
turns it off). `txServer` is the terminology server the module uses - for links from the
terminology view to code systems, and for the analysis of documents: either an http(s) URL
of an external server, or a path on this server (`/tx/r4`) when the tx module is enabled,
in which case requests are dispatched to it in-process (`ips/tx-client.js`), with no
network. Without it there are no links and no analysis.

## Projects, the administrator, and managers

`/ips` lists the projects. The server's administrators (logged in at `/auth/login`), at
`/ips/admin/projects`, create and delete projects, and say which of the server's users manage
which projects (the ips "manager" role for the project, which is also on the user's page,
`/auth/admin/users`). The projects page offers as managers only the users with the
**IPS Project Admin** role (`ips project-admin`), which the administrator gives on the user's
page; a manager who loses the role is shown, and stays a manager, until taken off. The administrators also look after the
[clinical profiles](#clinical-profiles) and the [national profiles](#national-profiles),
which apply across all projects. A project has a code - 2-32 lower case letters,
digits and hyphens, fixed once it exists - and lives at `/ips/{code}`. Deleting a project
deletes its documents.

A project's managers (and the administrator) can:

- say who may submit, at `/ips/{code}/settings` (*Who may submit*): a submission token, users,
  both, or neither (anyone). With both, either will do:
  - **the token**: a document is submitted with it in the `token` field of the submission form,
    or as `Authorization: Bearer <token>` on a `POST`. Managers can read the token back, so it
    is stored as it is, not hashed
  - **users**: *any logged in user*, or *approved users* - those the server's administrator
    gives the ips *Submit documents* role for the project (`ips submitter`, on the user's page;
    the project's managers count as approved). On the pages a user logs in; on the API they
    send their own API token (`Authorization: Bearer fhs_...`, made on their account page) -
    never a session cookie. The document records who submitted it ("from {name} ({login})")
- delete documents, and put a document back in the processing queue

Logins are the server's: its session cookie, an Origin check and a CSRF token on every form post - except
the submission form, which anyone may post (with the project's token, if it has one), so it
carries no CSRF token and starts no session; the Origin check still applies. A logged in user's
submissions (the form, the editors, adding a document from the viewer) carry the CSRF token,
since they ride on the session.

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
    Authorization: Bearer <token>        (the project's token, or a user's API token, if the project needs one)

or paste the JSON (or pick a file) at `/ips/{code}/submit`. The server gives the document its
id - a serial number, one series across all projects - sets `meta.lastUpdated` to the time it
was received, and drops `meta.versionId`: documents can't be changed once received.
Responses follow the spec: `201 Created` with a `Location` header, and the stored document,
or nothing (`Prefer: return=minimal`), or an OperationOutcome (`Prefer: return=OperationOutcome`).
Errors are OperationOutcomes: 400, 401 (no token or user, or a wrong one), 403 (a user who isn't approved), 413 (too big), 415 (not JSON), 429 (rate
limit). The submitter's IP address is recorded, for tracing abuse, and never returned.

    GET /ips/{code}/Bundle/{id}          the document (JSON), or a view of it for a browser
    GET /ips/{code}/Bundle?{params}      search
    GET /ips/{code}/metadata             CapabilityStatement

`$document` gives the API what the source view's banner gives a browser
([OperationDefinition](OperationDefinition-ips-document.json), referred to from the
CapabilityStatement):

    GET /ips/{code}/Bundle/{id}/$document?source=modified&system-sign=true&patient-notes=true
    POST /ips/{code}/Bundle/{id}/$document    (a Parameters resource)

Parameters: `source` (`original`, the default, or `modified`), `format-type` (below), and the
booleans `user-sign` (as the owner of the API token in `Authorization: Bearer` - 401 without one,
409 if they have no key pair to sign with), `system-sign`, `patient-notes` (the patient's
comments; nothing added, and no error, when there are none) and `regenerate-narrative`. The copy
is made as the web page makes it: any patient notes section (LOINC 51855-5) removed, the
narrative regenerated, signed, then the patient's comments added as the first section (not
signed). What comes back is chosen by `format-type` when it is given - `json`, `pdf`, `zip`,
`shl` or `vhl` - whatever `Accept` says; otherwise by `Accept` (or `_format`, which takes the same
mime types): `application/fhir+json` or `application/json` (the default), `application/zip`,
`application/pdf`, or `image/png` (a VHL's QR code; `format-type=shl` for an SHL's); anything
else is 406. The ZIP and the PDF are made on the server (`ips/export.js`): the PDF is the same
content as the browser's - the title, the patient, the date and each section's narrative, with
the document attached - laid out as text in the standard PDF fonts (tables as rows of cells, no
images; characters outside Windows-1252 show as `?`). An SHL or VHL answer is the QR code as a
PNG (`image/png`), with the link it carries in `X-Health-Link`, the manifest in
`X-Health-Link-Manifest` and the expiry in `X-Health-Link-Expires`. `$document` shares the
rate limit of sharing and of the web page's signed downloads.

A browser (or `_format=html`) gets pages: `/ips/{code}` is the project's page - its name
and description in a banner, "Submit a document" (and, for managers, "Settings") buttons,
the filterable list (patient name, gender, document date, document id or patient identifier,
processing status; the FHIR parameters below work there too), and at the foot a
documentation section with the endpoint's URL, the CapabilityStatement link and a table of
the requests it answers - and `/ips/{code}/Bundle/{id}` shows the document.
The document page's header names the patient, the document's date, when and how it was
received and its size, with a link to the FHIR JSON. The source view has a banner of what
can be done with the copy it shows (the original, or the modified copy): download it - as JSON
(`?download=1`, sent as an attachment named `ips-{code}-{id}.json`; `&source=modified` for the
modified copy, `ips-{code}-{id}-modified.json`), a ZIP, or a PDF with the document attached (both
made in the browser, by `doc-actions.js`, as the editors make them) - and share it as an SHL or
a VHL, when sharing is set up. Below the header, the processing pipeline is shown
as one connected line: Received, then each step in the order it runs, coloured by where it
is (tick: done, cross: failed, gear: running, moon: waiting - the step's note, or for
managers the reason it failed, on hover); each step links to the view that shows its work.
Managers get "Process again" and "Delete" buttons. The views of a document are tabs, chosen
with `?view=`: `narrative` (the default; a switch, `&narrative=generated`, chooses between
the narrative as provided - the Composition's narrative followed by each section's, with
the section titles - and the narrative this server generates, below), `structure` (the
document's logical structure, below), `analysis` (what the analysis step found, below), `translation` (what
the translate step did with each concept, below), `terminology`, `validation` (below),
`national` (below), `profiles` (the clinical profile checks), `ai` (the AI assessment,
below) and `source` (the JSON, pretty-printed, monospaced). The old view names `generated`
and `json` still work. The actions (Edit, the Share buttons, and for managers Process again
and Delete) are on a line of their own below the pipeline.
`structure` shows the document as a tree table, in the style of the FHIR specification's
structure tables: columns Path, Type, Id and Details, with the tree drawn in the Path column
(each node expands and collapses; Expand all and Collapse all buttons; without scripts
every row shows). It starts at the Composition: first what the Composition refers to other
than its sections (subject, author, custodian, attesters, ...), then the sections, nested,
each with what it refers to (its entries, author, focus). Each reference's path is where it
is (`entry[0]`, `attester[0].party`), and the reference as given is on hover over the Id;
each resource expands into the references it makes, and so on (sections start open,
resources closed). A reference resolves as in a Bundle - by fullUrl, absolute or relative
to the referring entry's - and `#id` is a resource contained in the referring resource (or
in the resource that contains it). One that doesn't resolve is shown as external (not in
document). A resource is expanded once, at the shallowest place it is referred to (so one
the Composition refers to directly expands there, not inside the subject that also refers to
it); everywhere else it is shown again, greyed, saying where it is expanded, but doesn't
expand a second time. Details says what the resource is - a name (a person's, an organization's),
else its code (`code`, the medication - following `medicationReference` -, `vaccineCode`,
`type`...), with an Observation's value - and when: the first of the clinical dates (onset,
occurrence, performed, effective, ...), falling back to the record's own (`recorded`,
`issued`, `date`, `meta.lastUpdated`). Icons, from `static/assets/images`: the document,
sections, people (Patient, Practitioner, PractitionerRole, RelatedPerson), organizations,
medications (Medication and the Medication* resources), other clinical resources, Provenance
and AuditEvent, references outside the document, and anything else.
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
document page's step line shows; processing again clears every step's result first. The pipeline, in order, will be: check the document's **signatures**; determine the document's **jurisdiction**; **analyse** each resource; **translate** CodeableConcepts
to the international terminologies; generate the **narrative**; **validate** the document; validate it against the
**national profiles**; measure its quality with PIQI; check it against the **clinical profiles**; **assess** it with AI; and run it into the [**reports**](#reports). Translation, the narrative,
validation, the analysis, the national profiles, the **terminology check**, the clinical profiles check and the AI assessment exist so far (PIQI does not). A step keeps what it finds in one of two places: as a result stored against the
document in `document_results` (one row per step - the validation outcome), or in the
**analysed copy** - a second copy of the document (`documents.analysed_json`) that the steps
adorn with extensions, so that the master document is never changed. The analysed copy is
rebuilt from the master on every run, so a document can always be processed again.
Anything left `processing` when the server stopped is queued again at startup.

There is one queue for the whole module, and its page is `/ips/queue` (linked from the top
menu; JSON for a client that doesn't ask for HTML): whether processing is running, idle,
waiting (for the validator or the terminology server) or turned off; the document being
processed, with the line of steps and the step it is up to (and for how long); and the
documents waiting, in the order they will be taken; and how long each step takes - its
average time, and its time per KB of document (all the time over all the KB, so big documents
count for what they are) - over its most recent 100 runs. A step's time is recorded (in
`step_timings`, the most recent 1000 of each step kept) only when it did its work: not when it
failed, nor when it was skipped (its result says `skipped`). The page refreshes itself every 5
seconds unless that is turned off (remembered in the browser). Managers can
queue a document again from its page, though not while it is being processed.

### Signatures

The first step (`ips/pipeline.js`, `signatures`) checks the document's signatures, with `verify()` in
`ips/signatures.js` - whose header is the contract for it: the document (a copy of it as stored), a KeyProvider,
and when the server received the document; it returns a list of outcomes, each a status (`error`, `warning`,
`information`), the key id it is about (or none), and a description. The KeyProvider (`ips/signature-keys.js`)
finds keys by id (`getKeyById`) or by the public key a signature carries (`getKeyByPublicKey`, so a key in a
signature's certificate is still checked against the key store, where it may have been revoked), in the server's
key store ([library/keystore](../library/keystore/README.md)); with the key store off, it knows no keys. The
outcomes are kept as the step's result and shown at the top of the analysis view.

Signing is `sign()` in the same file. The source view's banner has Sign choices above the downloads and shares:
the logged in user (enabled when they have a key pair, in the key store, of one of the types
`signatures.signingKeyTypes` lists) and the system (enabled when it has one). With either ticked, the JSON, ZIP and
PDF downloads and the SHL and VHL shares are of a signed copy of whichever copy is shown, made by the server when
asked (`POST {document}/signed`, `{source, user, system}`; the share forms' `signUser` and `signSystem`) and not
kept: the server loads the private keys from the key store (each load is logged there) and gives `sign()` the
document and a signer for each - the public key (as the KeyProvider gives it), the private key, and the key's
permalink (`/keys/key/{id}`). Signing as yourself needs a login (and, as every logged in post, the CSRF token);
the system signs for anyone, but no more often than `signing.systemSeconds` (10) apart for any one address. The
choices need scripts, and a public URL for the keys' links (`auth.publicUrl`, or `hostName` - never the request's
Host, which anyone can set): without one, there is no signing. What the signatures say: the system's, only that the
document hasn't been changed since it left this server - nothing about where it came from, or whether it is right;
the user's, that they asked for it to be signed, and it names them (`sign()` gets their name, login and email).
`verify()` makes no network requests (it gets keys from the KeyProvider, or the signature itself), and has 60
seconds; `sign()` has 30. `sign()` is not written yet: it gives the document back as it was. They don't go into the document's
status line, and a check that fails is an error outcome, not a failed step. `verify()` itself is not written yet: it
says so, as an information outcome.

Patient notes: `verify()` gets the document without any patient notes section (LOINC 51855-5),
since a copy downloaded or shared with the patient's comments has them added there after
signing. And a patient notes section the document arrives with becomes its patient comment (the
Patient Comments tab), its narrative converted to markdown with
[turndown](https://github.com/mixmark-io/turndown) (`ips/patient-comments.js`): pure markdown -
text that looks like HTML is escaped, a table row becomes its cells with ` | ` between, images are
dropped - and at most 30000 characters. Only when the document has no comment yet: one written
on the tab isn't overwritten by processing again.

### Jurisdiction

The second step (`ips/nationality.js` - the code still calls it nationality) works out which jurisdiction the document is
from, as far as the document says. Jurisdiction rather than nation, because there are IPS specifications at smaller
(Canadian provinces) and bigger (the EU) levels than a nation. Few national IGs give a way to tell, so this is a short list of signs, to grow as more are found:

- **US**: the Bundle claims the US Patient Summary profile (`http://hl7.org/fhir/us/pcs/StructureDefinition/Bundle-us-pcs`),
  or a US Core extension (`http://hl7.org/fhir/us/core/StructureDefinition/...`) is used anywhere in the document;
- **AU**: the Bundle claims the AU Patient Summary profile (`http://hl7.org.au/fhir/ps/StructureDefinition/au-ps-bundle`).

The jurisdiction is its ISO 3166 two-letter code, or unknown when nothing points to one, or the signs point to more
than one. It is kept as the step's result (with the reasons) and in `documents.nationality`, for the list: the
project page has a Jurisdiction column (the code, or `??`), the document page shows the jurisdiction's flag to the left of the
banner (a black and white globe when it isn't known, or there is no flag for it yet -
`static/assets/images/flags/{code}.svg`), and the first bullet on the Composition in the analysis view says what was
decided, and why.

### Analysis

The analysis step (`ips/analysis.js`), over the document as submitted. It walks the same tree
as the structure view (`ips/structure.js`) and, for each resource there (once, where it is
first met; contained resources too) and for the Composition section by section (the
Composition itself without its sections), keeps a list of findings, by the node's key
(`e{n}` for entry n, `e{n}#id` for a contained resource, `s:{path}` for a section):

- every extension, at any depth (a primitive's extensions are at the primitive's path; an
  extension's own parts are not listed), with its definition when the module can find one
  - the validator is asked (fhir-validator-wrapper's `lookupCanonical()`, the service's
  `/canonical`, which answers from the validator's context; with `autoLoadPackages`, on by
  default, the validator finds, downloads and loads the package that defines an extension it
  doesn't have, as it does while validating), and the answers are cached - or a note that it
  couldn't be found;
  modifier extensions likewise, in maroon; `textLink` extensions are left out;
- `implicitRules`, in maroon;
- in navy: `active` = false; a status of `entered-in-error` (and a Condition's or
  AllergyIntolerance's `verificationStatus` of entered-in-error); a status of `unknown`; or no
  status where the resource requires one (`lifecycleStatus` for a Goal);
- in dark green: a `subject` (or `patient`) that isn't the document's - not the same
  resource in the document, nor the same reference, nor the same identifier - and any `focus`;
- dates in the future, where one isn't expected. Only elements the (R4) type model says are
  dates (date, dateTime, instant) are looked at - so not an identifier or a note that looks
  like a date - and not inside extensions. Some dates are about the future by their nature and
  are never mentioned: the end of a period (a name's, address's or identifier's validity, a
  prescription's), expiry dates, due dates, and schedules (Timing). Some resources may have
  future dates: Appointment, AppointmentResponse, ImmunizationRecommendation, Schedule and
  Slot always; requests and plans (ServiceRequest, MedicationRequest, DeviceRequest,
  NutritionOrder, CommunicationRequest, SupplyRequest, VisionPrescription, CarePlan, Task, and
  a Goal by its lifecycleStatus) until they are over (completed, revoked, cancelled,
  entered-in-error, stopped, failed or rejected); and events still to come - a Procedure in
  preparation, a planned Encounter, an intended MedicationStatement or DeviceUseStatement. A
  date with no time zone is in the future only if it is everywhere;
- a Patient's `link`s; a Composition whose status isn't `final`;
- for a section: its `emptyReason`, and an author other than that of what contains it (the
  Composition, or the containing section - which may have inherited its own);
- whether there is narrative.

With nothing but the narrative to say, a resource is "All OK". The `analysis` view shows the
structure as a flat table - each node's row as in the structure view but with its full path
(`Composition.section[0].entry[0].resolve().subject`) - with a row under each that lists the
findings; a resource already shown is "Analysed above", and a reference to a resource not
in the document has no rows at all.

### Translation

The second step. Every CodeableConcept the terminology view lists is checked as the
terminology check (below) checks it; one that fails - no coding in the element's value set,
or, for an element with no value set of its own, no international coding - is sent to the
terminology server to translate: `ConceptMap/$translate` with `sourceCodeableConcept` (the
concept as submitted) and `targetScope` (the element's value set, or the fallback), the
value set and what it draws on as `tx-resource`. A SNOMED CT coding with no version is sent as a code of
the edition of the document's jurisdiction: when the [jurisdiction](#jurisdiction) step found one, and a national profile
for that jurisdiction names a SNOMED CT edition, the coding goes with `version` = `http://snomed.info/sct/{edition}`
(the document is not changed, and the translation view says which edition was used). Which edition a code is
from decides which maps apply - a national edition's own concepts translate to the International Edition. The
terminology check does not do this: it takes the codes as they are, so a SNOMED CT code with no version passes if
it is fine as it is, and one whose version names another edition does not. The server chooses the concept maps. Every
match that comes back (whatever its relationship) is added to the concept in the analysed
copy as a Coding, unless the concept already has that coding - the same system and code, and the same version
when both give one (SNOMED CT versions compared by edition: the same code in the International Edition is a
different coding from the one in a national edition, and is what the translation is for) - with an extension
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
package loaded). `jar` names a validator jar of its own instead - a validator built locally from
org.hl7.fhir.core, say: absolute, or relative to the data folder (`bin/local/validator_cli.jar`) - which
is used as it is, never downloaded or updated (the wrapper reads its version from the jar, so it
is only given the options it knows). Keep such a jar out of `bin/validator_cli.jar`: the wrapper
keeps that one up to date, so a different jar in its place is replaced by the next release. `autoLoadPackages` (default true) starts the validator with `-autoLoadPackages`, so
the analysis step's extension lookups can load the package that defines an extension (validator
7.0.5 and `fhir-validator-wrapper` 1.7.0 or later; older ones just don't look further). It starts in the background when the module does, and the queue waits for
it. Each document - its analysed copy, so the translations are seen (the validator will
remark on the translation extension until it is given its definition) - is validated against the IPS Bundle profile
(`http://hl7.org/fhir/uv/ips/StructureDefinition/Bundle-uv-ips`; set `profiles` to validate
against something else) - validator 7.0.4 dropped its IPS code checks, so `checkIpsCodes` is no longer
sent (the validator refuses it) - and the OperationOutcome is stored with the document and shown on
its `validation` view: the counts, each issue's severity, code, location and message, and
the raw OperationOutcome. Without a configured, running validator the step fails, and the
document's status is `error`.

### National profile validation

The national step runs after validation. It validates the document (the analysed copy, as validation does) against each
[national profile](#national-profiles) in turn: the national IG's package is loaded into the validator (once - a package
that has loaded, or has failed to, is remembered until the national profiles are changed), then the document is
validated against the IG's profile on Bundle. The national profiles' packages are also loaded when the validator
starts (and when the national profiles are changed), before any document is processed, so that the analysis step -
which runs first - finds the extensions they define; an extension that couldn't be found is looked up again once a
package has loaded. For each profile the result keeps
the OperationOutcome, its counts, and whether the document passed - it passes when the validator reports no errors (or
fatal issues). A profile whose package can't be loaded, or that the validator can't validate against, is kept with the
reason and counts as not checked; it doesn't stop the pipeline. With no national profiles there is nothing to do, and no
validator is needed; with some, the step fails, as validation does, without a configured, running validator.

The document's **Jurisdictional Profiles** view lists the profiles as they were when the document was processed, with the
outcome (passed, failed, or not checked) and the issue counts for each; a profile's page shows its validation as the
validation view shows the base validation (`?view=national&np={n}`). The packages loaded for national profiles stay
loaded in the validator alongside its own (`packages`), so two national IGs that define the same things differently can
affect each other.

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
reverse. The submission page says so when it is on. Attachments - Attachment and Binary
`data` (not SampledData's), `valueBase64Binary`, and `data:` URIs in the narrative - are
replaced with the placeholder `[attachment removed]` before the document is sent (most of a
large document is usually its attachments), and the prompt tells the model to ignore them;
how many were replaced is kept with the result, and shown on the view.

The service is an account - provider, base URL, model, API key - of one of two shapes
(`ips/ai-client.js`): `openai`, the chat-completions API that OpenAI, OpenRouter, LiteLLM,
Groq, Ollama, Azure and others speak (so a routing service is just a base URL), or
`anthropic`, the Messages API. A project may keep its own account (its managers enter it on
the settings page; the key is encrypted at rest with AES-256-GCM under `modules.ips.aiKeySecret`,
else the module's old `sessionSecret` if it is still in the configuration, so a copy of the database is not a copy of the account); a
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

### Reports

The last step (`reports`): the document's rows are deleted from every [report](#reports) table, and the document is run
through every report's ViewDefinition again - the document as submitted, as processed (the analysed copy, as this run
left it), or its validation outcome, as each report says. The rows go into each report's table when it is built for the
report's current definition, and into a table being rebuilt when the rebuild has already got past the document (it will
reach the others itself). A view that fails on the document (a column given more values than it allows, say) leaves no
rows from the document in that table; the failure is recorded against the report and shown with it in the project -
the report is what needs fixing - and the step's note says which reports failed. With no reports, the step is skipped.

## Patients

Each project has a Patient endpoint, `{project}/Patient`, for reading and searching the
patients of the documents it has received, and IPS `$summary` for a patient's latest document.
It supports development work: the matching is a reasonable guess, not a master patient index.

When a document arrives, its Patient is matched to one the project has seen before
(`ips/patients.js`):

1. the same identifier (system and value) - unless the birth date or the gender says it is
   someone else;
2. otherwise the same name and the same full birth date, the gender not conflicting. Names are
   compared as sets of words (two or more), without regard to case, accents, punctuation, order or
   titles, so a name that is only text matches the same name in parts;
3. otherwise it is a patient not seen before (and when an identifier or name matched someone with
   a different birth date or gender, the document says so).

The document's page says which patient it went to and how. A patient's resource has this
server's id (documents can all call their Patient `example`) and is cumulative: the latest
document's Patient, with what earlier documents said that it doesn't - identifiers, names,
telecoms, addresses, languages, contacts, and any element it leaves out. References that only
mean something inside a document (generalPractitioner, managingOrganization, link) are left
out. Deleting a document makes its patient again from the rest, and removes the patient when
there are none. Documents stored before there was matching are matched when the server starts.
Patients can't be split or merged by hand (yet).

- `GET {project}/Patient` - a searchset (or a page with a search form): `_id`, `identifier`
  (`system|value`, or a value), `name`, `family`, `given` (each word starts a word of the name,
  without regard to case or accents; a name that is only text is searched by `family` and
  `given` too), `birthdate` (a date, or a year or year and month), `gender`, `_count` (50, at
  most 200) and `_offset`
- `GET {project}/Patient/{id}` - the patient's resource (or a page with their documents)
- `GET {project}/Patient/{id}/$summary`, `GET {project}/Patient/$summary?identifier=system|value` -
  the patient's most recently received document: the modified copy (what the processing made of
  it; the original until it has been processed), or the original if `modules.ips.summarySource`
  is `"original"`. An identifier that more than one patient has is an error (422)

## Composing a document

"Compose a document" (`/ips/{code}/compose` from a project's page, or `/ips/compose` from
the top menu and the home page, for no project) lists the document creators - the ways to
make an IPS in the browser: the **general IPS editor** (`.../compose/general`) and the
**patient IPS editor** (`.../compose/patient`). Each ends with the same choices, the
document actions (`ips/doc-actions.js`, served at `/ips/doc-actions.js`):

- **Submit** to the project (from a project), or to the project the user picks (from no
  project) - with the project's token if it has one. It is stored like any other document
  (source `editor` or `patient-editor`). `POST /ips/compose/submit`, JSON `{ project, token, bundle, editor }`
- **Download** as JSON, as a ZIP (the document, and anything attached), or as a PDF (the
  document's narrative, with the document and anything attached attached to it), all made
  in the browser
- **QR Code** - a SMART Health Link, which opens in this server's SHL viewer
  (`{host}/ips/view#shlink:/...`) unless `modules.ips.shl.viewer` says otherwise - or
  **WHO QR Code** - a Verifiable Health Link, signed by the shl module; available for the
  days the user chooses (5 by default). The document is not stored in a project. `POST /ips/compose/share`,
  JSON `{ bundle, kind: 'shl' | 'vhl', days }`. Only when sharing is configured (`modules.ips.shl`)

The choices are available only when the server says the document is a minimal IPS
(`POST /ips/compose/check`, JSON `{ bundle }`, answers `{ problems: [...] }`; `ips/minimal.js`):
it passes the submission checks (a document Bundle, the Composition first, its subject a
Patient in the bundle, no active content in the narratives), its Composition has the IPS
type (LOINC 60591-5), a title, a date and an author, the patient has a name, and the
allergies (48765-2), problems (11450-4) and medications (10160-0) sections are there, each
with entries or an emptyReason. Until then the page lists what is missing. These calls, like
the submission form, start no session and carry no CSRF token; they must come from this
server's pages (same origin). The checking, building and loading calls share the lookups'
rate limit; sharing and submitting, the submissions'.

`/ips/{code}/compose?from={id}` (the old address of the editor) now goes to the general
editor.

### The general IPS editor

`/ips/{code}/compose/general` (or `/ips/compose/general`) is an editor for composing a
document in the browser ("Edit" on a document's page opens it with what the form can hold
of that document, and submitting makes a new document). The page is the
patient and the document's header (title, author - a practitioner or an organization -
custodian, date), then a panel per IPS section in the IPS order; the three the IPS requires
(problems, allergies, medications) are open, the rest collapsed. Each section is filled one
of three ways: entries - rows of the fields the presenter renders for that resource type,
coded fields looking codes up as you type; a narrative written by hand (paragraphs at
blank lines); or a reason it is empty (the `list-empty-reason` codes). Optional sections
can also be left out. (A required section with only a narrative doesn't make a minimal IPS.)
What the form holds is declared in `ips/editor-schema.js` (the
fields, their types, the value set each coded field is bound to, where each lands in the
resource) and drives the form (`ips/editor.js`, served at `/ips/editor.js`), the building
of the document (`ips/composer.js`: the Bundle, the Composition with its sections, the
Patient, the author, each row's resource - a blood pressure as components, a device as a
Device and a DeviceUseStatement - and the narrative, generated by the presenter for the
data sections) and the reading of a document back into the form.

As the form changes, the server builds the document (`POST /ips/compose/build`, JSON
`{ model }`, answers `{ bundle, problems }`: the problems with the model, then what stops it
being a minimal IPS), and the document actions take it from there. A document can be loaded
into the form - a file, or one of five test patients (`POST /ips/compose/model`, JSON
`{ bundle }`, answers `{ model }`). The test patients are the patient editor's five people as
their GP would summarise them - clinical rather than personal, with made-up detail to round
out the picture, functional status in ICF (qualified codes, ICF 2017), and the story as the
GP's summary and plan (Plan of Care). They are editor models, built into documents by the
editor's own composer: `node ips/general-editor/make-test-patients.js` writes them to
`ips/general-editor/test-patients/`. Their codes and displays were checked on tx.fhir.org.

Lookups go to `/ips/compose/lookup?vs={value set id}&q={text}` (or `/ips/{code}/lookup`), which runs
`ValueSet/$expand` with a filter on the terminology server against one of the module's
own value sets (`ips/valuesets/`), returning up to 20 codes (rate-limited on their own:
`rateLimit.lookupMax`, 600 a minute). Anything can also be entered as text. The browser
keeps the model in localStorage until it is submitted. The older way to submit
(`POST /ips/{code}/compose`, JSON `{ action: 'submit' | 'download', model, token }`) still
builds the document, checks it as a submission is checked, and stores it, or hands it back
as a file.

### The patient IPS editor

`/ips/{code}/compose/patient` (or `/ips/compose/patient`) is the form that was the Patient
Document Generator on healthintersections.com.au (`passport.html`, which now goes here): a
form for patients to fill in about themselves - about me, my story and goals, medical history,
care planning, care needs, body parts, reproductive health - that the browser turns into an
IPS document. Like the general editor, it has the upload (which reads an IPS document back
into the form) and the five test patients at the top, and makes the document as the form
changes - there is no Generate button - so the document actions always show what is still
missing. It is translated (English and Tagalog, in its own files). Its files are in
`ips/patient-editor/` - the form (`page.html`), its scripts, translations, images and test
patients - and the libraries it uses (commonmark, and for the downloads jsPDF,
html2canvas, pdf-lib and zip.js) are in `ips/vendor/`; the module serves them itself
(`/ips/assets/...`, read once at startup and served from memory, `ips/assets.js`), not from
CDNs. Its code lookups still go to tx.fhir.org and Ontoserver from the browser. Its old
"Open Link" for SMART Health Links is now the SHL viewer, and its QR codes are made on the
server (the shl module's password is no longer in the page). The test patients in
`ips/patient-editor/test-patients/` were generated by the form's own test-patient buttons.

## Clinical profiles

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
reverse. The submission page says so when it is on. Attachments - Attachment and Binary
`data` (not SampledData's), `valueBase64Binary`, and `data:` URIs in the narrative - are
replaced with the placeholder `[attachment removed]` before the document is sent (most of a
large document is usually its attachments), and the prompt tells the model to ignore them;
how many were replaced is kept with the result, and shown on the view.

The service is an account - provider, base URL, model, API key - of one of two shapes
(`ips/ai-client.js`): `openai`, the chat-completions API that OpenAI, OpenRouter, LiteLLM,
Groq, Ollama, Azure and others speak (so a routing service is just a base URL), or
`anthropic`, the Messages API. A project may keep its own account (its managers enter it on
the settings page; the key is encrypted at rest with AES-256-GCM under `modules.ips.aiKeySecret`,
else the module's old `sessionSecret` if it is still in the configuration, so a copy of the database is not a copy of the account); a
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

The administrator edits only the title, the constraints and the guided input (below). The server sets everything else:

- the id: `profile-` plus a random private id;
- the url: `[base]/ips/StructureDefinition/profile-{id}`, fixed when the profile is made;
- the name, derived from the title (`Cardiology referral` → `CardiologyReferral`);
- each constraint's key (`cp-1`, `cp-2`...). A key is kept for as long as its constraint is, and never reused;
- severity `error`, status `active` and the date.

Most expectations take one of two shapes, using the module's own [FHIRPath functions](#fhirpath-functions):

```
Bundle.section(system, code).exists()
Bundle.section(system, code).isKnown()
Bundle.section(system, code).where(isKnown() and sameSubject()).exists()
Bundle.section(system, code)[.where(checks)].entry(system, code [, min, max]).exists()
```

The section has no bounds (more than one of the same section is a corner case IPS documents
don't have: a `section()` with bounds is an other rule). What it must be is up to three checks,
in this order: `isKnown()` (must be asked/known), `hasData()` (must have supporting entries)
and `sameSubject()` (about the same Patient). One check on its own is the rule; more than one,
or any with an entry part, go in a `where()`. `isKnown()`: the section has no emptyReason, or a
nil known one (`list-empty-reason#nilknown`) - any other emptyReason is not known. `hasData()`:
the section has an emptyReason, or else entries. `sameSubject()` on a section: it has no focus,
or its focus is the Composition's subject. On no section they give nothing (so the rule fails),
and on anything that isn't a section, false. They are the Java `DocumentFunctions`' (the
validator's) as well as `ips/fhirpath-ips.js`'s.

Rules about the resources in the document, whatever section they are in, take a third shape:

```
Bundle.resources(system, code [, type]).{the rest of the rule}
```

Entries and resources can be matched by value set instead of by one code: `Bundle.section(...).entryIn(valueSet [, min, max]).exists()`, and `Bundle.resourcesIn(valueSet [, type])...`. Sections are always matched by code. An example rule: `Bundle.resources('http://snomed.info/sct', '38341003', 'Condition').all(clinicalStatus.coding.code = 'active')`.

A new profile is made on the list page (`/ips/StructureDefinition`) from just a title (`POST /ips/StructureDefinition` with `{title}`), and its rules and guided input are added on its own page, which is in four parts:

- **Required sections and entries:** the first shape, each a row of a table: the section, with its checks as three checkboxes in a row (must be asked/known, must have supporting entries, about the same Patient), the entry code and its cardinality.
- **Rules about resources:** the third shape, each a row of a table with four columns (the type, which is optional, the system, the code, and the rest of the rule as FHIRPath starting with a dot).
- **Other rules:** any other FHIRPath.
- **Guided input:** below.

The page that shows a profile is the same for everyone. Its first part is a table of three columns: the **Expectation** (the description), the **Section** (an IPS section by its title, or `system|code`) and the **Entry** (`Code is system|code`, or `Code is in` a value set, by its title, or its URL when the title isn't known). A code system is shown by name when it is a known one. A section's checks follow it, in words (must be asked/known, must have supporting entries, about the same Patient). A cardinality, `[m..n]`, follows an entry unless it is `1..1` or not given (none means at least one). The second part is also a table of three columns: the **Expectation**, the **Resource Set** (the type, as `MedicationAdministrations where` or `Any resource where`, then the code as in the Entry column) and the **Rule**, which is the rest of the expression in words where it is one of these: `.exists()` is "Must be present somewhere"; `.all(sameSubject())` is "Patient must match the Document"; `.x.exists()` and `.x.y.exists()` are "Must have an x" and "Must have an x.y" (no deeper); `.conformsTo(url)` (or `.all(conformsTo(url))`) is "Conform to" the profile, named by its title when it is one of the clinical profiles or by its jurisdiction and package when it is a national profile; and `.category.hasCoding(system, code [, version])` (or inside `.all()`) is "Has category system|code". Any other rest is shown as FHIRPath, and so are the other rules. On the same page the administrator edits the rules one at a time: each row has Edit and Delete, and each part has an Add button. Add and Edit open a dialog for the one rule - the expectation, then the parts of the rule, each with what it means (for a rule about resources, what must be true of them is a choice: present somewhere, the patient matches the document's, an element, conformance to a profile, a category, or other FHIRPath), and the FHIRPath it makes - and Save stores that one rule by itself (`POST /ips/StructureDefinition/{id}/constraint` to add, `.../constraint/{key}` to change, `.../constraint/{key}/delete` to delete). An edited rule keeps its key. Rename changes the title (`POST .../title`; the name follows it). There is no full editor any more: an old link to one (`.../edit`) lands on the profile's page.

A rule moves between the parts when it is switched between table and FHIRPath, and it lands in the part whose shape it fits. A section is one of the IPS sections, or any code in any system. An entry or resource code is a code in a named code system (SNOMED CT, LOINC, ICD-10...) or in any other given by URL, and it is looked up on the terminology server (`GET /ips/lookup?system=&q=`, for the administrator only). Choosing "In a value set..." as the system matches entries or resources by value set instead. The code box becomes a value set search (`GET /ips/lookup-vs?q=`, for the administrator only): this module's own value sets that match the title come first, then the terminology server's (a `ValueSet?title=` search). A suggestion shows its title, with its URL underneath. A canonical can also be typed or pasted in, with `|version` to pin a version. When the editor opens, it looks up the title of each value set by URL (`?url=`). If the terminology server doesn't know a value set, it says so as a warning, not an error: the value set has to be known when documents are checked, not when the profile is saved. A cardinality is blank (no bounds) or `min..max`, where max may be `*`. Before a profile is saved, every expression is parsed and run once against an empty document. That catches unknown functions and wrong numbers of arguments as well as syntax errors.

A profile can be downloaded as JSON (`?download=1`), and a downloaded profile can be uploaded again as a new profile, with a new id, url and keys. An upload must be no more than a profile like this: a profile on Bundle with no snapshot, and one differential element (the root) carrying constraints that have only a key, an `error` severity, a description, an expression and a source - and guided input, as below. Anything more is rejected, with the reasons. A profile downloaded when clinical profiles were on Composition is accepted and moved onto Bundle, as profiles already stored are when the server starts: `Composition.section(...)` becomes `Bundle.section(...)`, and any other `Composition.x` becomes `Bundle.entry.resource.ofType(Composition).x`.

As FHIR: `GET /ips/StructureDefinition` is a searchset of them all, and `GET /ips/StructureDefinition/{id}` is one of them.

### Guided input

Guided input is questions for the people filling a document in, about a section. When a profile
has any, it contains a Questionnaire (`#Q`), and has an extension
`http://www.healthintersections.com.au/fhir/StructureDefinition/input-guide` for each guide, in
order, with these sub-extensions:

- `questionnaire` (canonical, 1..1): `#Q`;
- `question` (id, 1..*): the linkIds of its questions in the Questionnaire, in order. The server
  makes them (`q` and 8 random hex digits, so one is never used again), keeps a question's linkId
  for as long as the question is kept, and takes a question's item out of the Questionnaire when
  the question goes (and the Questionnaire, when the last guide goes). People never see them;
- `section` (Coding, 1..1): the section the questions are about - one of the IPS sections, or any
  code, as `system|code`, so sections other than the IPS ones can be guided too;
- `resource` (code, 0..1): what the answers make - `Condition:problem`, `Condition:diagnosis`,
  `Observation:vitals`, `MedicationStatement` or `AllergyIntolerance` (the class after the colon
  changes how it is used);
- `code` (Coding, 0..1): the resource's code - only with a resource.

A question has text, a type - `display`, `boolean`, `quantity`, `date` or `choice` - and
optionally a definition: a path in a resource (`Condition.onset[x]`), kept in the
Questionnaire as `http://hl7.org/fhir/StructureDefinition/Condition#Condition.onset[x]`. A
choice has its answers (Codings, as `answerOption`); a quantity may name its units (Codings,
UCUM by default, as `questionnaire-unitOption` extensions).

The page shows the guided input as a table - Section, Questions (each with its type), Resource,
Code - grouped by section: the IPS sections in the IPS order, then other sections as they first
appear; in a section, the guides' own order. The administrator adds, edits and deletes a guide at
a time, and moves it up or down within its section (`POST .../guide` to add, `.../guide/{n}` to
change, `.../guide/{n}/delete`, `.../guide/{n}/move` with `direction` up or down - n is the
guide's place among the extensions). The dialog has the section (the same chooser as the rules),
the questions (added, deleted and moved up and down; answers and units with the code system and
code lookup), the resource, and its code. Saving a profile's rules or title leaves its guided
input as it is. An upload keeps its guided input, with new linkIds; anything more than this - an
extension other than input-guide, a contained resource other than `#Q`, more in the
Questionnaire or its items than the above, or a guide naming a question the Questionnaire
doesn't have - is refused.

## National profiles

A national profile is the profile a national implementation guide defines for an IPS document. Each has five parts:
the jurisdiction it is for, the IG's package id (e.g. `hl7.fhir.au.ips`), the package version, the canonical URL
of the IG's profile on Bundle, and - optionally, since not every IG uses SNOMED CT - the SNOMED CT edition the IG takes for granted. National profiles are shared across all projects (`/ips/national-profiles`). Everyone can see them; only the
administrator adds, edits and deletes them. There is at most one for a package id and version. Every document is
validated against each of them by the [national profiles step](#national-profile-validation).

The jurisdiction is a code from `http://hl7.org/fhir/ValueSet/jurisdiction`: a country, by its ISO 3166 two-letter
code (`AU`; lower case is accepted, and stored in upper case), or a region, by its UN M49 three-digit code (`150` for
Europe, `053` for Australia and New Zealand). The pages show the country's or region's name with it, from the code
lists the terminology module holds (`tx/cs/cs-country.js`, `tx/cs/cs-areacode.js`); ISO's user-assigned and 'unknown' codes
(`XK`, `XX`, `ZZ`...) and countries' M49 numeric codes aren't accepted. National profiles made before the jurisdiction was asked
for show it as not given, until they are saved with one. The package id must be a FHIR package id (lower case letters, digits, `-` and `_`, in two or more parts separated by
dots), the version a package version (`1.0.0`, `1.1.0-ballot`), and the profile an http or https URL. `GET
/ips/national-profiles` with `Accept: application/json` returns them as `[{jurisdiction, packageId, version, url, snomedEdition}]`
(`snomedEdition` only when there is one).

The SNOMED CT edition is chosen from a list - the editions in `SNOMED_LINKABLE_EDITIONS` (`tx/sct/editions.js`, the
editions snomed.info can link to), by name - and kept as the edition's module id (`900000000000207008` for the
International Edition, `32506021000036107` for the Australian), the id in its edition URI `http://snomed.info/sct/{id}`.

## Reports

A report is a table of data drawn from every document by a [SQL on FHIR](https://sql-on-fhir.org) ViewDefinition, and
zero or more SQL statements that summarise it. The administrator defines them (`/ips/reports`; everyone can see the
definitions, and download them as JSON); each project shows them for its own documents (`/ips/{code}/reports`): each
statement's name, SQL and output (the first 1000 rows), then the table's own rows (the first 1000, and how many there
are), a CSV download of all the project's rows (up to 100000), and the documents the view failed on.

A report has a title, a description, what it runs over, the ViewDefinition and its statements:

- **Runs over** - *the documents as submitted*, *the documents as processed* (the analysed copy: translations,
  generated narrative), or *the validation outcomes*. Over the documents, the view is of Bundle - the document - and
  walks to what it wants (`"forEach": "entry.resource.ofType(Condition)"`), with references resolved inside the
  document (`library/sql/memory-provider.js`: `urn:uuid:` and RESTful fullUrls, then type and id). Over the validation
  outcomes, the view is of OperationOutcome, and sees the validation step's outcome for each document. National profile
  outcomes are not included.
- **The ViewDefinition** - R4 (the documents are R4: `fhirVersion` is set to `4.0.1` when it isn't given, and must
  include it when it is). Its name names the report and its table, so it can't be changed once the report is made, and must
  be unique. Every column needs a type. It is checked first for what the runner needs (`library/sql`), then by the FHIR
  validator, with the SQL on FHIR IG loaded (`modules.ips.reports.package`, `org.sql-on-fhir.ig#2.0.0` by default),
  against the IG's ViewDefinition logical model; its errors stop the report being saved. `getResourceKey()` and
  `getReferenceKey()` give the document's id, then the resource's key (`1234/Patient/p1`; a resource with no id is
  known by its entry's fullUrl), since the same `Patient/p1` turns up in many documents.
- **The statements** - each a named SELECT (only statements that read are accepted: each is prepared against every
  report's table when it is saved). A statement sees each report's table by name, holding only the rows of the project
  it is being looked at in: each table has the view's columns and `_document` (the document id) and `_project`, and the
  statement runs with a TEMP VIEW of each table's project rows in front of the table. Collection and complex columns
  hold JSON (SQLite's `json_each()` unpacks them).

How a project shows a report: each statement by its name, with its output - the SQL is behind a "source" link
beside the name - then the table. Tables (a statement's output, or the report's own) are presented by their column
names, so views and statements can be written to these conventions:

- `resource_key` (a `getResourceKey()` column) - a link to the resource in its document: the document's Source tab
  (Original, or Modified for a report over the processed documents) at the resource's entry, which is highlighted;
  for a report over the validation outcomes, the document's Validation tab. The `_document` column, which the key
  already says, isn't shown. The Source tab has an anchor on every entry: the resource's type/id, or the entry's
  fullUrl when the resource has no id - the key without its document id.
- `_document` (when there is no `resource_key`) - a link to the document.
- `X_system` and `X_code` - one column, `X`, showing the coding as the terminology view does: the code system by
  name (the URL on hover, linked to its browser or to the code system on the terminology server), then the code;
  with `X_display` too when there is one. Empty when both are null.
- `ViewRowKey` and `_project` aren't shown.

The CSV download has the columns as they are.

The tables are in a SQLite database of their own (`modules.ips.reports.database`, by default `ips-reports.db` beside the
IPS database), so that rebuilding one, or a statement gone wrong, can't touch anything else. Each has a `ViewRowKey`,
`_project`, `_document`, then the view's columns, typed as library/sql's SQLite storage types them. When a report is
added, or its view or what it runs over changes, its table is rebuilt in the background: the processing queue, after
the documents waiting, builds a new table (`_build_{name}`) from every document the pipeline has finished with, a few at
a time (`buildBudgetMs`, 2000 ms a turn), then swaps it in for the old one - which is shown meanwhile, with a note.
Changing only the title, description or statements rebuilds nothing. Where a build is up to is kept (`_builds`), so it
carries on after a restart; a report whose table isn't built for its definition when the server starts (the reports
database was deleted, say) is built again, and tables of reports that no longer exist are dropped. Deleting a document
or a project deletes its rows; deleting a report drops its table.

The statements run in a child process, on a read-only connection, killed after `queryTimeoutSeconds` (10): better-sqlite3
runs a statement synchronously to the end and can't interrupt it, and a worker thread can't be stopped inside one, so a
runaway statement would otherwise hold the server.

## FHIRPath functions

`ips/fhirpath-ips.js` adds these functions to fhirpath.js, for expressions on IPS documents (the Java `DocumentFunctions` in org.hl7.fhir.core, which the validator runs, has the same):

- `section(system, code [, min, max])`: the input is documents (Bundles) or Compositions. On a document it moves into the document's Composition by itself, which is why a clinical profile's rules, evaluated on the document, can say `Bundle.section(...)`. For each input, it returns the Composition's sections, nested ones included, whose `code` has a coding with that system and code.
- `resources(system, code [, type])`: the input is documents, or anything in one (a Composition, say). It returns every resource in the document whose `code`, `medicationCodeableConcept` or `vaccineCode` has a coding with that system and code, and that is of the given type when a type is given.
- `entryIn(valueSet [, min, max])` and `resourcesIn(valueSet [, type])`: as `entry()` and `resources()`, but they match a code in a value set (a canonical, with or without `|version`) rather than one given code. A resource is in when any coding of its code is. These two ask a terminology server, so the evaluation must be asynchronous (`evaluateAsync`), with a `membership` function in the options. A `MembershipSession` (`ips/membership.js`, made by the module's `membershipSession()`) provides one: it asks `ValueSet/$validate-code` with the CodeableConcept, only for what a rule actually reaches. Within a session, each question is asked once, and there's a budget of 500 per document. Definite answers are also kept in the module's cache, so the next document doesn't ask again. When the server can't answer (it doesn't know the value set, say), the answer is "not a member" for that run, and the session's `unresolved()` lists the value set and the server's message, so a rule that failed for that reason can be told apart from one that plainly failed. The module's own value sets (`ips/valuesets/`) are sent with the question, so any server can answer for them; any other value set must be one the server knows.
- `entry(system, code [, min, max])`: the input is sections, usually from `section()`. For each one, it returns its resolved entries whose `code`, `medicationCodeableConcept` or `vaccineCode` has a coding with that system and code. `medicationReference` is not followed.
- `isKnown()` and `hasData()`: the input is sections. `isKnown()` is true when each has no `emptyReason`, or a nil known one (`list-empty-reason#nilknown`); `hasData()` when each has an `emptyReason`, or else entries. Empty on no input; false for anything that isn't a section of a Composition.
- `sameSubject([other])`: on a section, true when it has no `focus`, else whether the focus is the subject of `other` (or, without it, of the section's Composition); on a resource, whether its `subject` (or `patient`) is `other`'s (or, without it, the document's Composition's). References are the same when their reference strings are, else when their identifiers' system and value are. Empty when the input or `other` isn't one item, or a subject is missing.

`min` and `max` are optional (both or neither), and `max` may be `'*'`. Without them, `section()` is `1..1` - a document with two of the same section has none, for a rule - and `entry()` and `entryIn()` are `0..*` (no bounds), as in the Java `DocumentFunctions`. The bounds apply to each input item: when the number found is outside them, that item adds nothing. That isn't an error. References are resolved in the Bundle the section is in, or failing that the Bundle the expression was evaluated on:

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

With `modules.ips.shl` configured, a document's Source view has "Share as SHL" and "Share as VHL"
buttons (for anyone who can see the document), under its switch between the Original document
(the master, as submitted) and the Modified one (the analysed copy - what the processing ended up
with), sharing whichever is shown (`source` = `original` or `modified` in the post; the modified
one can't be shared until the document has been processed). Each makes a QR code in a panel over the
page, to scan or copy, with what the code carries in a box beside a Copy button, and the
link to the manifest; without scripts, the same lands on its own page. The steps are the
ones the healthintersections.com.au passport page takes, here on the server (`ips/share.js`):
an entry is created on the SHL server (`POST {shl}/create`, as this server itself or with an API
token, and the number of days the copy lives), the document (the original or the modified one) is encrypted
as a JWE (`dir` / `A256GCM`, a random key) and uploaded (`POST {shl}/upload`), and the
shlink payload - the manifest link, the key, flag `U`, a label naming the patient - is
base64url-encoded. An SHL's code carries `{viewer}#shlink:/{payload}`; a VHL's carries
`HC1:` and the SHL server's signature of `shlink://{payload}` (`POST {shl}/sign`: a
COSE_Sign1 of the GDHCN payload, deflated and base45). The SHL server is this server's own
shl module (`"server": "/shl"`, dispatched in-process, as this server itself) or another
FHIRsmith's (an https URL, and `token`: an API token of a user there with the shl "create" role).
A URL that is this server's own shl module - the host of `hostName` or `auth.publicUrl`, and
`/shl` - is treated as `"/shl"`: no token. Anyone who can see a document can share it; the
server makes the link as itself, so they don't need to log in.
Shares are rate-limited as submissions are, and a document whose JWE is over 2MB is not
shared this way. The QR codes are made with `qrcode-generator`, error correction L.

The QR code of an SHL opens this server's own viewer (`{server}/ips/view#shlink:/...`, below)
unless `modules.ips.shl.viewer` names another.

## The SHL viewer

`/ips/view` is a viewer for SMART Health Links and Verifiable Health Links that carry IPS
documents (`ips/viewer.js`): other systems can name it as the viewer in their SHLs
(`{server}/ips/view#shlink:/...`), and a link - a viewer URL, a bare `shlink:/...`, or a VHL's
`HC1:...` - can be pasted into it. The part after the `#` never reaches the server, so the
page's script reads it and posts it (and takes it out of the browser's history); the server
retrieves the document, keeps what happened under a random token for `keepMinutes` (60, in
`shl_views`), and redirects to `/ips/view/{token}`. Everything is done on the server, so an SHL
server that doesn't allow cross-origin requests still works (the log says it doesn't).

The point is as much debugging other people's SHL servers as viewing documents, so the page
shows each step the viewer took, with the detail behind a disclosure: the payload decoded and
checked (url, key - shown, this is a public test service - exp, flags, label, v); for a VHL,
base45, inflate, the COSE_Sign1 headers, the CWT claims, and the signature; each request - the
U-flag `GET {url}?recipient=...`, or the manifest `POST {url}` with `recipient` (and `passcode`)
- with what was sent and what came back (status, headers, body), redirects followed one at a
time; each file, embedded or fetched from its location; the JWE header, the decryption (`dir` /
`A256GCM`, `zip: DEF` too) and the decrypted content; and what the content is. The server's own
log gets one line per link.

- A link with the P flag asks for the passcode (it can also be given with the link), and says
  when the SHL server refuses it, with the attempts left when the server says.
- A manifest may be an SHL manifest (`files`, each `embedded` or `location`) or, as a VHL server
  gives it, a FHIR Bundle of DocumentReferences (`content.attachment.url`; a bare `content.url`,
  which isn't FHIR - this server's shl module gave it before 1.0.3 - is used with a warning).
- Only `application/fhir+json` files are read: SMART Health Cards and SMART API access are logged
  as not supported.
- A VHL's signature (ES256) is checked against the certificates in `modules.ips.viewer.trust`
  (`[{ kid, name, certFile | certificate }]`, PEM - a certificate or a public key), and this
  server's own shl module's certificate (unless `trustOwnShl` is false). A VHL from anyone else
  is checked only if their certificate - published through the GDHCN trust network - is
  configured; otherwise the log says it could not be checked. No secret is needed.
- Requests go only to public addresses, over https, unless `allowPrivateAddresses` is true (for
  testing a local SHL server; http is allowed then too); each has a deadline (`timeout`, 30 s)
  and a size limit (`maxMB`, 10).

Each document is shown with its narrative as submitted (as the Narrative view shows it). An
IPS document - a document Bundle whose Composition.type is LOINC 60591-5 - can be added to a
project, by the rules of the submission form (the project's token, the size limit, the same
checks, the same rate limit), with source `shl`; the form says plainly that this makes it
visible to everyone, and warns when a document with the same Bundle.identifier is already in
the module. Other documents can be looked at, but not added.

### Validation view

The view shows everything by default; its "Show" selector (`?level=warning` or
`?level=error`) hides the lesser issues - the summary line still counts them all. A national profile's
validation (the `national` view, one profile) shows errors only by default (`?level=information` for everything).
`fhir-validator-wrapper` 1.5.0 or later is needed: earlier versions sent the profiles in a
form the validator service refuses.
