# Users and logins (`library/auth`)

FHIRsmith has one login system for the whole server. Every module asks it who a request is,
and what they may do. There are no module logins or users, and no passwords in the
configuration.

- **People** log in at `/auth/login`, with a password or with GitHub.
- **Software** sends an **API token** (`Authorization: Bearer fhs_...`). A token belongs to a
  user, and can do what that user's roles allow.
- **Roles**: *administrator* is server wide, and passes every check. Modules have their own
  roles (the manager of an IPS project, who may queue a publication for a website...), some of
  them for one thing (a project, a website). The administrator gives them on the users pages.

## Configuration

The top-level `auth` block of `config.json` (all optional; see `config-template.json`):

| Setting | Default | |
|---|---|---|
| `database` | `auth.db` | The users, roles, tokens, password links and sessions, in the databases folder (or an absolute path). Under the cluster launcher every process uses it |
| `sessionSecret` | random | Signs the login cookie. **Set it**: without it logins don't survive a restart, and under the launcher a login on one process isn't one on the others |
| `administrators` | none | The server's administrators: email addresses, and `github:{name}` for GitHub accounts. See below |
| `publicUrl` | `https://{hostName}` (`http://` when `cookieSecure` is false) | Where the links in emails point, and the GitHub callback |
| `github` | none | `{ "clientId", "clientSecret" }` of a GitHub OAuth app, for logging in with GitHub. Optional `callbackUrl` |
| `cookieSecure` | `true` | The login cookie only travels over HTTPS. Behind a TLS proxy, the proxy must send `X-Forwarded-Proto` ([nginx.md](../../nginx.md)). `false` only to run over plain http |
| `sessionHours` | 24 | How long a login lasts |
| `linkMinutes` | 60 | How long a password link works |
| `loginAttemptsPerWindow` | 20 | Failed logins (and password link requests, and password changes) per IP address per 15 minutes |

Email (the top-level `email` block, [CONFIGURATION.md](../../CONFIGURATION.md#email-and-the-daily-report)) is how
password links are sent. Without it the administrator is shown each link, to pass on.

## The administrators

`auth.administrators` lists who administers the server:

- an **email address**: an account is made for it when the server starts, if there isn't one, with
  no password. Set the password with *Forgotten your password?* on the login page (the link is
  emailed), or on the server, with `node server.js --password-link {email}` (below)
- **`github:{name}`**: the GitHub account of that name is an administrator once it has logged
  in with GitHub. The account is tied to GitHub's numeric user id, never the name: a GitHub user can be renamed, and the old name taken by someone else

A bare login is not accepted: anyone could make an account by that name with GitHub first.

Administrators named here can't be demoted, disabled or deleted on the users pages: take them
out of the configuration. Others are made administrators on the users page (*Administrator*).

### `node server.js --password-link {login or email}`

Prints a link that sets the account's password (for `linkMinutes`), and exits. Whoever can run
it on the server is the operator: it is how the first password is set without email, or how an
administrator who can't log in gets back in. It reads `config.json` as the server does
(`auth.database`, `auth.publicUrl` or `hostName`).

## Accounts

- **Made by the administrator** (`/auth/admin/users`): a login, a name and an email. With an
  email, the user is sent a link to set their password (or the administrator is shown it). An
  account with no email is for software: it is given roles and API tokens, and never logs in
- **Made by logging in with GitHub**: anyone with a GitHub account can. The account has no
  roles: it can't do anything until the administrator gives it some. Its email is GitHub's
  verified primary one, unless another account here already has it - accounts are never
  matched or merged by email address
- **Linking GitHub**: a user logged in with a password can link their GitHub account (on their
  account page, `/auth/account`), and then log in either way

The right-most item of the top menu on every page, in every module, is the account: *Login*,
or the name of the user logged in, linked to their own page (`/auth/account`). That page says
who they are and what they can do - each of their roles, linked to its module, with what it lets
them do; for an administrator, the users pages and the modules' administration pages - and has
*Logout*. There they change their name and password, link GitHub, issue and revoke API tokens,
and *Log out everywhere*. Only the administrator changes an account's email: an email address
in `administrators` makes the account an administrator.

### Passwords

- at least 15 characters (and at most 72 bytes - bcrypt reads no further). There are no other
  rules: a password manager is the best way
- set only from a link: the administrator never chooses or sees a password
- stored as bcrypt hashes (cost 12)
- a forgotten password: *Forgotten your password?* asks for a login or email, and says the same
  whether or not there is such an account
- a link works once, for `linkMinutes`; asking for another stops the last one working
- changing a password, or the administrator disabling the account, ends the account's sessions everywhere

## API tokens

`fhs_` and 43 characters (256 random bits). A user makes their own on their account page; the
administrator makes them for software accounts on the user's page. A token is shown once, when
it is made: it is stored as a SHA-256 hash. Tokens can be given an expiry, and are revoked on the
same pages. The pages show how many times each has been used, and when last.

A token is sent as:

- `Authorization: Bearer {token}` (preferred)
- `Api-Key: {token}` or `X-API-Key: {token}`
- `Authorization: Basic` with the token as the password (`curl -u {login}:{token}`), for
  clients that can only do Basic

## Roles

| Module | Role | For | What it allows |
|---|---|---|---|
| (server) | administrator | | everything, on every module |
| ips | manager | a project | the project's settings and submission token; deleting and reprocessing its documents |
| ips | project-admin (IPS Project Admin) | | can be made a manager of projects: the IPS projects page offers only these users |
| publisher | queue | a website | queuing publications |
| publisher | approve | a website | approving publications |
| testing | submit | | posting TestReports, when `modules.testing.requireToken` is set |
| testing | edit-links | | the named links |
| testing | delete-reports | | deleting reports |
| registry | member | | the API, when it is secured (`security.required`); the documents that aren't public |
| packages | crawl | | `POST /packages/crawl` |
| shl | create | | `POST /shl/create` |
| folder | upload | a folder | uploading into it (`PUT`) |

A role for one thing (a project, a website, a folder) can also be given for every one of them.
The users page shows the roles of the modules that are running; a role of a module that isn't is
kept as it is. The IPS projects page also says who manages each project.

Only administrators can do anything that used to need a password in the configuration: empty the
tx caches (`/{path}/caches`), resync a VSAC value set (the VSAC info page), manage IPS projects,
clinical and national profiles and reports, publisher websites, and the users themselves.

## The daily report

When there are any accounts, the daily report ([CONFIGURATION.md](../../CONFIGURATION.md#email-and-the-daily-report))
starts with a paragraph on them: the logins in the period (with a password, with GitHub), the
failed logins for accounts that exist (a wrong password, or a disabled account - a name that
isn't an account isn't counted), the user accounts (how many are disabled, how many are new)
and the sessions logged in now. Logins and failed logins are kept in the auth database
(`login_events`) for 90 days.

## For modules

```js
const auth = require('../library/auth');

// the module's roles, for the users pages and the account page (which links a role to the module)
auth.defineRoles('mymodule', [
  { role: 'edit', label: 'Edit things', description: 'change the things',
    scope: { label: 'Project', values: () => [{ value: '1', label: 'abc' }] } }
], { title: 'My module', path: '/mymodule' });
// a page only administrators have: listed on their account page
auth.addAdminPage('mymodule', { label: 'Settings', path: '/mymodule/admin', description: 'what the module does' });

// pages: the session, and the CSRF token for someone logged in
router.get('/page', ...auth.web, handler);
// a form post
router.post('/thing', auth.sameOrigin, auth.session, auth.form, auth.csrf,
  auth.requirePage((user, req) => user.has('mymodule', 'edit', req.params.project)), handler);
// an API: a token (or session) with the role; 401/403 JSON otherwise
router.post('/api', auth.requireApi(p => p.has('mymodule', 'edit')), handler);
```

- `auth.currentUser(req)`: the logged-in user (session only), or null. `auth.principal(req)`
  (a promise): the session's user, else the token's, else this server itself, else null
- a principal has `id`, `login`, `name`, `isAdmin`, `has(module, role, scope?)` (an administrator
  has every role; no scope: any scope will do) and `scopes(module, role)`
- `auth.loginUrl(req)`: the login page, coming back to this one
- the top menu: a module's page template ends its top menu with
  `<span style="float: right">[%account%]</span>` (first in the menu's `div`, so it floats to the
  right on the same line), and html-server fills it with *Login* or the user's name. The module
  does nothing else: `auth.pages`, which server.js puts before every module, loads the session
  when the browser sent the cookie, and remembers the request the page is being made for
- `auth.users()`, `auth.holders()`, `auth.setHolders()`, `auth.grant()`, `auth.revoke()`: for a
  module's own pages (the IPS projects page sets a project's managers)
- `auth.internalHeaders()`: headers that make an in-process request (dispatched to another module of this server) this server itself, an administrator

The session cookie (`fhirsmith.sid`) is for the whole site (path `/`), `HttpOnly`, `SameSite=Lax`,
and `Secure` unless `cookieSecure` is false. Every form carries a CSRF token, and every form post
must come from this site (its `Origin`) - the same three layers as before.

## Upgrading

The modules' own logins, users and passwords are gone, and users start again: no users are
carried over. The old settings are warnings in the log and in `node server.js --check`, and can be
taken out:

| Was | Now |
|---|---|
| `modules.token` | removed: logging in with GitHub and API tokens are the server's (Google and Facebook logins are not) |
| `modules.ips.adminUsername`, `adminPassword`, `cookieSecure`, `loginAttemptsPerWindow` | `auth`. Give project managers the ips manager role (the projects page) |
| `modules.ips.sessionSecret` | still used, only to read the AI keys projects stored: copy it to `modules.ips.aiKeySecret` |
| `modules.ips.shl.password` | nothing, for this server's own shl module; for another server's, `modules.ips.shl.token` (an API token there) |
| `modules.publisher.adminPassword`, `sessionSecret`, `cookieSecure`, `loginAttemptsPerWindow` | `auth`. Who may queue and approve for each website: the publisher roles |
| `modules.testing.adminPassword`, `sessionSecret`, `cookieSecure` | `auth`, and the testing roles |
| `modules.testing.token` | `requireToken: true`, and an API token of a user with the testing submit role. While `token` is set, posting stays closed |
| `modules.testing.adminToken` | an API token of a user with the testing delete-reports role |
| `modules.registry.security.users` | `auth`; `security.required: true`. The registry's documents stay where they were |
| `modules.registry.security.apiToken` | `security.required: true`, and an API token of a user with the registry member role. While `apiToken` or `users` is set, the API stays closed |
| `modules.packages.crawlToken` | an API token of a user with the packages crawl role, in `Authorization: Bearer` or `x-crawl-token` |
| `modules.shl.password` | an API token of a user with the shl create role. A `password` sent in the body is ignored |
| `modules.tx.adminPassword` | the server's administrators, logged in, empty the caches |
| `modules.tx.vsacCfg.resyncPassword` | the server's administrators, logged in, resync a value set (`resync: false` turns it off) |
| a folder's `.users.json` of logins and passwords | the folder upload role, or a `.users.json` that is a list of logins. Uploads send an API token as the password (`curl -u {login}:{token}`) |

Not changed: `modules.ext-tracker.token` (the IG Publisher's, and no secret), each IPS project's
submission token, OIDC on the registry, and the credentials the server itself uses elsewhere
(`email.password`, VSAC's `apiKey`, the AI keys, the registry crawler's `apiKeys` and `oauth`).
