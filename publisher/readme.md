# Publisher - publishing FHIR implementation guides

The `publisher` module runs IG publications for the websites it is set up for: a user asks for
a publication of an IG (a GitHub repository, branch, package id and version), the module builds
it with the IG Publisher, and once an approver has looked at the draft, it publishes it into the
website's web folder and pushes it.

This module exists to run the publication service at healthintersections.com.au/publisher; it
isn't designed for anyone else to run, though nothing stops you. It needs Java, git, SUSHI (npm)
and a checkout of each website's web folder on the server, and push access to them.

## How a publication runs

1. **Request**: a logged-in user who may publish to the website creates a task: the website,
   the GitHub org, repository and branch, and the package id and version it should produce.
   The task is `queued`.
2. **Draft build** (`building`): the module clones the repository into a task folder under
   `workspaceRoot`, downloads the latest IG Publisher, updates SUSHI, runs the IG Publisher,
   and checks that the package id and version are the ones asked for. Then the task is
   `waiting for approval`, with its output, history and QA report on the task's pages.
3. **Approval**: a user who may approve for the website approves it (or deletes it).
4. **Publication** (`publishing`): the module clones the supporting repositories (the history
   and web templates, and the IG registry), pulls the web folder, runs the IG Publisher in
   go-publish mode, checks the result is a publication build, moves files too big for GitHub
   out of the web folder (`large-file-archive`), commits and pushes the web folder, then the
   IG registry. With a `github-app`, it then tags the IG source repository and makes a GitHub
   release with a zip of the source - a failure there is only a warning.

A task that fails can be retried. Only one task runs at a time.

## Configuration

In `config.json`, under `modules`:

```json
"publisher": {
  "enabled": true,
  "database": "publisher.db",
  "sessionSecret": "a-long-random-string",
  "adminPassword": "a-good-password",
  "workspaceRoot": "workspaces"
}
```

| Setting | Default | Description |
|---|---|---|
| `enabled` | false | Run the module, at `/publisher` |
| `database` | - | The SQLite database (users, websites, permissions, tasks). A relative path is in the data directory's `publisher` folder |
| `sessionSecret` | random | Signs the login session cookie. Set it: without it, a random one is made at startup (with a warning), and logins don't survive a restart |
| `adminPassword` | random | The password of the administrator, `admin` (see [Administration](#administration)) |
| `cookieSecure` | true | The session cookie is only sent over https. Set `false` only to run over plain http. Behind a TLS proxy, the proxy must set `X-Forwarded-Proto`, or logins seem to do nothing |
| `workspaceRoot` | - | Where task folders (`task-{id}`) are made. A relative path is in the data directory's `publisher` folder |
| `igPublisherTimeoutMinutes` | 60 | An IG Publisher run that takes longer is stopped, and the task fails |
| `pollInterval` | 5000 | How often (ms) the module looks for a task to run |
| `loginAttemptsPerWindow` | 20 | Failed logins allowed per IP address per 15 minutes |
| `taskActionsPerMinute` | 30 | Task actions (create, approve, delete, retry) per IP address per minute |
| `taskReadsPerMinute` | 300 | Reads of task output, history and QA pages per IP address per minute |
| `large-file-archive` | none | Where files over GitHub's 100 MB limit are moved from the web folder, for websites whose publish setup says they are on GitHub. A relative path is in the data directory's `publisher` folder. Without it they are left in place, and the push fails |
| `ig-registry-url` | `git@github.com:FHIR/ig-registry.git` | Where the IG registry is cloned from and pushed to. Set it to an ssh_config Host alias to push with a repository deploy key |
| `github-app` | none | `app-id`, `private-key` (a .pem file) and `installations` (GitHub org -> installation id) for the GitHub App that tags source repositories and makes releases. Without it, that step is skipped |

`config-template.json` has the same settings, with more on each.

## Administration

The administrator's login is `admin`, and its password is `adminPassword` from the config,
set at every start - so to change it, change the config and restart. Without `adminPassword`,
the first start gives the administrator a random password (a UUID) and logs it; set
`adminPassword` to choose your own. There is no page to change a password.

Administrators manage (at `/publisher/admin/...`):

- **Websites**: each has a name, its local web folder (a git checkout), the history and web
  templates, and a server update script.
- **Users**, and what each may do for each website: publish (create tasks) and approve.
