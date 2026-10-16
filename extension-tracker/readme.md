# FHIRsmith Extension Tracker Module

Tracks extensions, profiles, and extension usage across FHIR Implementation Guides. IGs submit data via POST, and the module provides browsable views of the collected data.

## Configuration

```json
"ext-tracker": {
  "enabled": true,
  "database": "/var/fhir/data/extension-tracker.db",
  "url": "/ext-tracker"
}
```

- **database**: path to the SQLite database file (auto-created if missing)
- **url** (optional): URL base to mount at (defaults to `/ext-tracker`)
- **token** (optional): the token a submission must carry, as `Authorization: Bearer <token>`. The IG Publisher sends `9D1C23C0-3915-4542-882E-2BCC55645DF8`. It is in the publisher's source, so it is not a secret, but it keeps out submissions that aren't from the publisher. Without it, submissions need no token

## POST — Submit IG Data

POST JSON to the module root. Required fields: `package`, `version`, `fhirVersion`. Optional: `jurisdiction`, `extensions`, `profiles`, `usage`.

A submission must look like what the IG Publisher sends, or it is refused (400): no other properties; `package`, `version`, `fhirVersion` and `jurisdiction` are codes; extension, profile and usage keys are URLs; `profiles` is keyed by resource type; usage locations are element paths; titles are text of at most 1024 characters; and no more than 20000 items in all.

```
POST /ext-tracker
Content-Type: application/json

{
  "package": "hl7.fhir.uv.tx-ecosystem",
  "version": "1.9.1",
  "fhirVersion": "5.0.0",
  "jurisdiction": "001",
  "extensions": [
    { "url": "http://example.org/ext", "title": "My Extension", "types": ["string"] }
  ],
  "profiles": {
    "Patient": [
      { "url": "http://example.org/profile", "title": "My Profile" }
    ]
  },
  "usage": {
    "http://example.org/ext": ["Patient", "Patient.name"]
  }
}
```

Submitting a new version for an existing package replaces the old data entirely — only the latest submission per package is kept.

Duplicate types in extensions are automatically deduplicated.

## GET — Browse Data

- `/ext-tracker` — Summary dashboard with package list
- `/ext-tracker/extensions` — All extensions, filterable by `?package=`
- `/ext-tracker/profiles` — All profiles, filterable by `?resource=` and `?package=`
- `/ext-tracker/usage` — Extension usage, filterable by `?url=` and `?location=`
- `/ext-tracker/package/:name` — Detail page for a specific package

## Dependencies

Requires `better-sqlite3` (`npm install better-sqlite3`).

## Database

The SQLite database is auto-created on first run with five tables: `packages`, `extensions`, `extension_types`, `profiles`, and `usages`. Foreign keys cascade deletes, so removing a package cleans up all related data.
