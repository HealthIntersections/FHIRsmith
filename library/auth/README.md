# Users and logins (`library/auth`)

FHIRsmith has one login system for the whole server. Every module asks it who a request is,
and what they may do. There are no module logins or users, and no passwords in the
configuration.

- **People** log in at `/auth/login`, with GitHub, with Google, or with a password.
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
| `administrators` | none | The server's administrators: email addresses, `github:{name}` (or `github:#{id}`) for GitHub accounts, and `google:{email}` (or `google:#{id}`) for Google accounts. See below |
| `publicUrl` | `https://{hostName}` (`http://` when `cookieSecure` is false) | Where the links in emails point, and the GitHub and Google callbacks. With neither this nor `hostName`, no password links are made: never from the address a request names, which anyone can forge |
| `github` | none | `{ "clientId", "clientSecret" }` of a GitHub OAuth app, for logging in with GitHub ([setting it up](#github)). Optional `callbackUrl` |
| `google` | none | `{ "clientId", "clientSecret" }` of a Google OAuth client, for logging in with Google ([setting it up](#google)). Optional `callbackUrl` |
| `cookieSecure` | `true` | The login cookie only travels over HTTPS. Behind a TLS proxy, the proxy must send `X-Forwarded-Proto` ([nginx.md](../../nginx.md)). `false` only to run over plain http |
| `afterLogout` | `/` | Where *Logout* goes: a path on this server, e.g. `/ips` when something else is at the root of the site |
| `sessionHours` | 24 | How long a login lasts |
| `linkMinutes` | 60 | How long a password link works |
| `loginAttemptsPerWindow` | 20 | Failed logins (and password link requests, and password changes) per IP address per 15 minutes |
| `requestsPerMinute` | 1000 | Requests a minute from one IP address that bring a login (the session cookie) or an API token, to the routes that look up who is asking (429 after that). Anonymous requests aren't counted, and the terminology API isn't behind it |

Email (the top-level `email` block, [CONFIGURATION.md](../../CONFIGURATION.md#email-and-the-daily-report)) is how
password links are sent. Without it the administrator is shown each link, to pass on.

## Setting up logging in with GitHub or Google

The login page offers *Log in with GitHub* and *Log in with Google* first, for whichever are
set up, and below them the username and password form, for accounts the administrator has made.
Each needs an app (GitHub) or client (Google) registered for the server, which gives it an id and
a secret for `config.json`.

### GitHub

Logging in with GitHub needs a GitHub **OAuth app** (not a "GitHub App") for the server. Each
server needs its own, because an OAuth app has one callback URL.

1. **Make the app.** On GitHub go to *Settings → Developer settings → OAuth Apps → New OAuth
   App*. That's your own account's settings, or an organization's (*Organization settings →
   Developer settings*) if the app should belong to the organization. Fill in:
   - *Application name*: what users see on GitHub's "Authorize" page, e.g. `FHIRsmith (tx.example.org)`
   - *Homepage URL*: the server, e.g. `https://tx.example.org`
   - *Authorization callback URL*: the server's public URL followed by `/auth/github/callback`,
     e.g. `https://tx.example.org/auth/github/callback`. This is OAuth's *redirect URI*, and
     GitHub's documentation and error messages call it that too (`redirect_uri`). Register
     exactly what the server sends (step 3). GitHub accepts a redirect URI on the same scheme,
     host and port whose path is the callback's or a subdirectory of it, but an exact match
     leaves nothing to get wrong
   - leave *Enable Device Flow* off
2. **Get the credentials.** On the app's page, copy the *Client ID*, then *Generate a new
   client secret* and copy that too. GitHub shows the secret only once.
3. **Configure the server.** Add them to the `auth` block of `config.json`:

   ```json
   "auth": {
     "sessionSecret": "...",
     "publicUrl": "https://tx.example.org",
     "github": { "clientId": "Ov23li...", "clientSecret": "..." },
     "administrators": ["github:your-github-name"]
   }
   ```

   The server sends `{publicUrl}/auth/github/callback` as the callback. Without `publicUrl` it
   uses `https://{hostName}` (`http://` when `cookieSecure` is false), and without `hostName`
   it uses the address the request came in on. Set `publicUrl` whenever the server is behind a
   proxy, so that the callback is the public address. If the callback has to be something else,
   set `github.callbackUrl` to the full URL; it must still end up at `/auth/github/callback` on
   this server.
4. **Restart the server, and try it.** The login page now has *Log in with GitHub*. The first
   time, GitHub asks the user to authorize the app. It asks for `read:user` and `user:email`:
   who they are, and their verified primary email address, nothing else. Then they come back
   logged in.

### Google

Logging in with Google needs an **OAuth client** in a Google Cloud project. Each server needs its
own client (one project can hold several).

1. **Pick a project.** In the [Google Cloud console](https://console.cloud.google.com/), choose a
   project or make one (*Select a project → New project*), e.g. `FHIRsmith`.
2. **Describe the app.** Open *APIs & Services → OAuth consent screen* (the console may call it
   *Google Auth Platform*). The first time, it asks for:
   - *App name* and *User support email*: what users see on Google's "Sign in" page
   - *Audience*: **External**, so anyone with a Google account can log in. (*Internal* is only
     for an organization's own Google Workspace users)
   - a contact email

   Under *Data access* (or *Scopes*) nothing needs adding: the server asks only for `openid`,
   `email` and `profile`, which Google doesn't review. Under *Audience*, choose **Publish app**
   to put it *In production*. While it is *Testing*, only the *Test users* listed there can log
   in.
3. **Make the client.** Open *Clients* (or *Credentials → Create credentials → OAuth client ID*),
   and *Create client*:
   - *Application type*: **Web application**
   - *Name*: anything, e.g. `tx.example.org`
   - *Authorized redirect URIs*: add the server's public URL followed by `/auth/google/callback`,
     e.g. `https://tx.example.org/auth/google/callback`. Google needs it exactly as the server
     sends it (step 4) - scheme, host, path, no trailing slash
   - *Authorized JavaScript origins*: leave empty
4. **Get the credentials, and configure the server.** Copy the *Client ID*
   (`....apps.googleusercontent.com`) and the *Client secret*. Copy the secret when it is shown:
   Google may not show it again (make a new one if it's lost). Add them to the `auth` block:

   ```json
   "auth": {
     "publicUrl": "https://tx.example.org",
     "google": { "clientId": "1234-abc.apps.googleusercontent.com", "clientSecret": "GOCSPX-..." },
     "administrators": ["google:you@gmail.com"]
   }
   ```

   The callback the server sends is `{publicUrl}/auth/google/callback`, worked out as for
   GitHub; `google.callbackUrl` overrides it.
5. **Restart the server, and try it.** The login page now has *Log in with Google*. Google asks
   the user to choose an account, and the first time, to agree to share their name, email address
   and profile picture with the app (the server doesn't use the picture). Then they come back
   logged in.

Google must say the account's email address is verified, or the login is refused.

### What happens next

- **Someone with no account here** gets one, with no roles, so they can't do anything until an
  administrator gives them a role. The new account's login is their GitHub name, or the part of
  their Google address before the `@`, with `-2` (and so on) added if it's taken. Its email is
  their verified GitHub or Google address, unless another account here already has that
  address: accounts are never matched or merged by email. (So an administrator named by email
  in `administrators` who logs in with Google gets a second account: link Google to the first
  instead, below, or name them `google:{email}`.)
- **An existing account** can add GitHub or Google on its account page (*Link GitHub account*,
  *Link Google account*), and then log in any of those ways. An account can't unlink the only
  way it has to log in.
- **The account is tied to GitHub's user id or Google's account id** (`sub`), not a name or an
  address, so it survives a rename on GitHub or a new address at Google.
- **Administrators:** `github:{name}` or `google:{email}` in `administrators` makes that GitHub
  or Google user an administrator from their first login with it.

### More than one server, and your own machine

Each server needs its own GitHub app and its own Google client (or the client's redirect URIs can
list each server). For development, both accept an `http://localhost:{port}/auth/{github|google}/callback`
callback; set `"cookieSecure": false` and `"publicUrl": "http://localhost:{port}"` to go with it.

The server makes outgoing HTTPS requests during a login - to `github.com` and `api.github.com`,
or to `oauth2.googleapis.com` and `openidconnect.googleapis.com` - so a firewall must allow them.

### If it goes wrong

| What you see | Why |
|---|---|
| No *Log in with GitHub* button | `github.clientId` or `github.clientSecret` is missing, or the server hasn't been restarted |
| GitHub says *The redirect_uri is not associated with this application* | The callback the server sent isn't the app's *Authorization callback URL*: check `publicUrl` (and `http` vs `https`) |
| *GitHub did not give an access token: incorrect_client_credentials* | The client secret is wrong, or has been regenerated |
| *GitHub did not give an access token: bad_verification_code* | The code was used already or expired: the user went back, or took too long. Try again |
| *The GitHub login did not start here, or took too long* | The session cookie didn't come back: over plain http with `cookieSecure` true, or a proxy not sending `X-Forwarded-Proto` ([nginx.md](../../nginx.md)) |
| *GitHub login was cancelled* | The user chose *Cancel* on GitHub's Authorize page |
| No *Log in with Google* button | `google.clientId` or `google.clientSecret` is missing, or the server hasn't been restarted |
| Google says *Error 400: redirect_uri_mismatch* | The callback the server sent isn't one of the client's *Authorized redirect URIs*: Google shows the one it was sent; check `publicUrl` |
| Google says *Access blocked: ... has not completed the Google verification process* or *403 access_denied* | The app is still *Testing*, and the user isn't a test user: publish it (step 2) |
| *Google did not give an access token: ...* (`invalid_client`) | The client id or secret is wrong, or the secret has been replaced |
| *Google did not give an access token: ...* (`invalid_grant`) | The code was used already or expired: try again |
| *Google did not give a verified email address for the account* | Google says the account's address isn't verified |
| *The Google login did not start here, or took too long* | As for GitHub: the session cookie didn't come back |
| Logged in, but can't do anything | The account has no roles yet: an administrator gives them on `/auth/admin/users` |

Failed logins are logged (`Auth: GitHub login failed from ...`, `Auth: Google login failed from ...`) with the reason.

## The administrators

`auth.administrators` lists who administers the server:

- an **email address**: an account is made for it when the server starts, if there isn't one, with
  no password. Set the password with *Forgotten your password?* on the login page (the link is
  emailed), or on the server, with `node server.js --password-link {email}` (below). Its login
  is the part of the address before the `@` (with `-2` added if that's taken); it logs in with
  that, or with the address
- **`github:{name}`**: the GitHub account of that name is an administrator once it has logged
  in with GitHub
- **`google:{email}`**: the Google account with that address is an administrator once it has
  logged in with Google
- **`github:#{id}`**, **`google:#{id}`**: the account with that GitHub user id, or Google
  account id (`sub`)

A `github:{name}` or `google:{email}` entry is tied to the first account it matches: the
provider's id for it is recorded (in the auth database, `admin_pins`), and from then on the entry
matches that id, not the name. So an administrator who renames their GitHub account (or gets a new
address at Google) stays one, and whoever takes the old name or address later does not become
one. To hand an entry to a different account, take it out of the configuration and restart (that
forgets the tie), then put it back.

A bare login is not accepted: anyone could make an account by that name with GitHub or Google first.

Administrators named here can't be demoted, disabled or deleted on the users pages: take them
out of the configuration. Others are made administrators on the users page (*Administrator*).

### `node server.js --password-link {login or email}`

Prints a link that sets the account's password (for `linkMinutes`), and exits. Whoever can run
it on the server is the operator: it is how the first password is set without email, or how an
administrator who can't log in gets back in. It reads `config.json` as the server does
(`auth.database`, `auth.publicUrl` or `hostName`).

## Accounts

Logging in comes back to the page it started from: the *Login* link at the right of every page's
top menu, and the login page a protected page sends you to, carry the page with them, through a
wrong password, *Log in with GitHub* or *Google*, and a forgotten password's emailed link.

- **Made by the administrator** (`/auth/admin/users`): a login (letters, digits and `. _ + -`;
  not an `@`, so that a login is never taken for another account's email address), a name and an email. With an
  email, the user is sent a link to set their password (or the administrator is shown it). An
  account with no email is for software: it is given roles and API tokens, and never logs in
- **Made by logging in with GitHub or Google**: anyone with a GitHub or Google account can. The
  account has no roles: it can't do anything until the administrator gives it some. Its email
  is the verified one GitHub or Google gives, unless another account here already has it -
  accounts are never matched or merged by email address
- **Linking GitHub or Google**: a logged in user can link their GitHub or Google account (on
  their account page, `/auth/account`), and then log in any of those ways

The right-most item of the top menu on every page, in every module, is the account: *Login*,
or the name of the user logged in, linked to their own page (`/auth/account`). That page says
who they are and what they can do - each of their roles, linked to its module, with what it lets
them do; for an administrator, the users pages and the modules' administration pages - and has
*Logout*. There they change their name and password, link GitHub or Google, issue and revoke API tokens,
and *Log out everywhere*. Only the administrator changes an account's email: an email address
in `administrators` makes the account an administrator. Changing it ends the account's sessions,
and any password link sent to the old address stops working.

API tokens go on working when the password changes and after *Log out everywhere*: they are
revoked one by one, on the account page. Disabling the account stops them all.

### Passwords

- at least 15 characters (and at most 72 bytes - bcrypt reads no further). There are no other
  rules: a password manager is the best way
- set only from a link: the administrator never chooses or sees a password
- stored as bcrypt hashes (cost 12)
- a forgotten password: *Forgotten your password?* asks for a login or email, and says the same
  whether or not there is such an account. The emailed link remembers the page logging in started
  from, and setting the password comes back to it, logged in
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
| ips | submitter (Submit documents) | a project | submitting documents to a project that takes them from approved users |
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
starts with a paragraph on them: the logins in the period (with a password, with GitHub, with Google), the
failed logins altogether, how many were for names that aren't accounts, and how many for each
account that exists (a wrong password, or a disabled account). A GitHub or Google login that was
cancelled or abandoned isn't a failed login. Then the user accounts (how many are disabled, how many are new)
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
- rate limiting: a router whose routes look up who is asking starts with
  `router.use(rateLimit(auth.credentialLimits()))` (express-rate-limit), or each such route
  has the limiter first, where the router has heavy anonymous traffic. It counts only the
  requests that bring a login or a token. It is in each module's own router, not just once
  for the server, so that code scanning (CodeQL `js/missing-rate-limiting`) sees it
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

A request whose `Origin` names another site is nobody, whatever cookie it brings: the browser
attaches the login cookie to requests that scripts on the same *site* make (`build.fhir.org` and
`tx.fhir.org` are both `fhir.org`), and `SameSite=Lax` doesn't stop those. So an API that takes a
login as well as a token can't be driven by another site's script, and `server.cors` must not set
`credentials` (`--check` warns). Pages that need someone logged in, and every `/auth` page, can't
be put in another site's frame (`X-Frame-Options`, `frame-ancestors`).

## Upgrading

The modules' own logins, users and passwords are gone, and users start again: no users are
carried over. The old settings are warnings in the log and in `node server.js --check`, and can be
taken out:

| Was | Now |
|---|---|
| `modules.token` | removed: logging in with GitHub or Google, and API tokens, are the server's (Facebook logins are not) |
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
