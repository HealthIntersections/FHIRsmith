# FHIRsmith Folder Module

Serves static files from one or more directories, with optional authenticated upload via PUT.

## Configuration

Add a `folder` entry under `modules` in your config, following the standard FHIRsmith module pattern:

```json
"folder": {
"enabled": true,
"folders": [
{ "name": "packages", "folder": "/var/fhir/packages", "url": "/packages" },
{ "name": "igs", "folder": "/var/fhir/igs", "url": "/igs", "enabled": false }
]
}
```

The top-level `enabled` controls whether the module loads at all. Each folder entry also supports its own `enabled: false` to disable individual folders without removing them from the config.

- **name**: display name (used in status and logging)
- **folder**: absolute path to the directory to serve
- **url**: URL path to mount at
- **enabled** (optional): set to `false` to skip this entry

Directories that don't exist at startup are skipped with a warning. Zero folders is valid.

## GET — File Serving

Any GET request under the configured URL serves files directly. If the path is a directory, it returns an HTML listing showing subdirectories first, then files with sizes.

## PUT — Authenticated Upload

PUT writes a file to the path specified in the URL. The parent directory is created automatically if it doesn't exist.

Every PUT needs an API token of one of the server's users ([library/auth](../library/auth/README.md)): HTTP Basic, with the token as the password (`curl -u {login}:{token} -T file.zip {url}`), or `Authorization: Bearer {token}`. The user may upload if they have the folder "upload" role for the folder (or every folder), given on the server's users pages, or are named in a `.users.json` (see below). A bad token is answered after a delay.

Special case: uploading `main.zip` or `master.zip` automatically creates a copy named `default.zip` in the same directory.

## .users.json

A `.users.json` placed anywhere in the served directory tree lets the users it names upload there and below - for access to part of a folder. It is a list of logins (the server's users):

```json
["grahame", "ci-bot"]
```

When a PUT comes in from a user without the role, the module walks up from the target directory to the folder root looking for `.users.json` files; one that names the user grants access. If none does, the request is rejected with 403. `.users.json` files are never served by GET.

The old form - an object of usernames and passwords - is no longer used (it is logged as such): replace it with a list of logins, give the users API tokens, and delete the passwords.

## Dependencies

No additional npm dependencies required.
