# Documents

A registry run for an ecosystem is a natural place to publish the ecosystem's own
documentation: its policies, the configuration its clients should use, the terms under which
servers are listed. The registry stores and serves such documents itself, so an administrator
can keep them next to the registry without a separate website.

Documents are available when `security.users` is configured ([security.md](security.md)):
they live in the same database as the users, and who may read and edit them is decided by the
same logins.

## What a document is

| | |
|---|---|
| **name** | Its address: `/tx-reg/docs/{name}`. Letters, digits, dots, hyphens and underscores, up to 100 characters, unique. Can be changed (the old address stops working). |
| **type** | `md` (Markdown) or `json`. |
| **public** | Whether anyone can read it. If not, only logged in users can. |
| **last edited** | When, and by whom. |
| **content** | The text, up to 2 MB. JSON must parse to be saved. |

## Who sees what

* A **public** document is readable by anyone: on the page, and as the raw file.
* A document that is **not public** is readable by anyone who is logged in - any user, not
  just administrators. This is for enterprise configuration and policy that should not be on
  the open web. A logged in session is required: an API token, the configured API token or an
  OIDC JWT does *not* give access to documents (they authenticate software to the API; the
  documents are for people). To a stranger such a document does not exist: a browser is sent
  to the login page, anything else gets 404, so names are not disclosed.
* **Administrators** - the configured one, and any user with the administrator flag - create,
  edit, rename and delete documents. An administrator user can also manage users.

## Reading

`GET /tx-reg/docs` lists the documents the reader may see. `GET /tx-reg/docs/{name}` returns
the document: in a browser (`Accept: text/html`), rendered in the registry's pages - Markdown
as HTML, JSON pretty-printed - with its metadata and links to its history and, for an
administrator, to edit it; otherwise the raw content, as `text/markdown` or
`application/json`, with `Last-Modified`, so a client such as `curl` or a script gets the
file itself:

```
curl https://ecosystem.example.org/tx-reg/docs/client-configuration
```

Markdown is rendered as written: raw HTML in a document passes through, since the authors are
the registry's administrators. Do not give the administrator flag to anyone you would not let
write HTML on your site.

## Editing

Editing is a text area with the four metadata fields above it - `/tx-reg/docs/new` to create,
`/tx-reg/docs/{name}/edit` to change, and a delete button on the edit page. There is no rich
editor: a document that needs one is written elsewhere and pasted in. Line endings are
normalised to `\n`.

## History

Every change - creation, edit, rename, deletion - is logged with who made it, when, and the
complete document as it then was. `/tx-reg/docs/{name}/history` lists the log (visible to
whoever may read the document), and each entry opens that version, rendered. Deleting a
document keeps its log, but the log is reached by the document's id, so it is no longer
browsable once the document is gone; it remains in the database (`document_log`) for the
administrator who needs it. A deleted name may be reused; the new document starts a new log.

## Storage

Two tables in the users' database (`databases/registry-auth.db`): `documents` (the current
state) and `document_log` (every version). Nothing is cached; a document is read on each
request.
