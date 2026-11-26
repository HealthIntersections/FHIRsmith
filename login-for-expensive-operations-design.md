# Login for expensive operations — design (Nov 2026)

tx.fhir.org and npm.fhir.org stay open to anyone, but a few operations that cost the server a lot need a login: a session in a browser, or an API token for software. The aim is to stop web crawlers running expensive, event-loop-blocking work without getting in the way of people or the FHIR tools.

**Status:** design, not built. Off unless the server's setting turns it on (see *Configuration*), so other FHIRsmith installs are unaffected.

## Why

- **npm.fhir.org, 24 Nov 2026:** a crawler on about 78,000 rotating addresses, with ordinary browser user agents, fetched 90,567 XIG list pages in 25 minutes, working through combinations of filters and offsets. In the two days around it, 770,335 list requests covered 236,786 different filters. Garbage-collection pauses of 5–7 s followed. Rate limits per address can't stop a crawler that uses each address once or twice. robots.txt is ignored. But a crawler can't log in.
- **tx.fhir.org:** the same pattern (ValueSet HTML pages from 3,324 addresses in a day, `$lookup` pages from 6,356), cheap today but the same exposure: `_showAll`, deep search paging and large HTML expansions are each one request away. XML is the most expensive way to answer (tx.fhir.org's heavy lane exists for it).
- **Client caches:** the size limit (`cacheMaxConcepts`, 250,000) is right for anonymous clients but too small for some IG builds. Taiwan builds reach about 317,000 concepts, have their cache dropped every run, and upload 60+ MB again. A logged-in client can be given more, because the server knows who it is.

## The rule, in one place

| Where | Needs a login | Stays open |
|---|---|---|
| **tx API** (FHIR REST: `/r4/...`, `/r5/...`) | Any request answered in **XML**, or sending XML | Everything in JSON, with no new limits |
| **tx API: client caches** | — | Anyone can start a cache. A logged-in client gets a bigger one (`cacheMaxConceptsLoggedIn`) |
| **tx web UI** (HTML pages) | A search page past the first; `_showAll`; an expansion showing rows past 1,000 (`count` > 1000, or `offset` + `count` > 1000) | Every resource page, the first page of every search, expansions up to 1,000 rows |
| **XIG** (npm.fhir.org) | Any **filtered** list past its first page (any of `ver`, `auth`, `realm`, `type`, `rt`, `text`, `pkg`, `onlyUsed` with `offset` > 0), in HTML, JSON or CSV | Resource pages, the sitemap, the first page of every list, the unfiltered list's paging (`/xig?offset=N`, which robots.txt allows) |
| **Package API** (npm registry, package downloads, feeds) | Nothing | Everything, as now |

"Logged in" means `library/auth` finds a principal for the request: a session cookie (browser) or an API token (`Authorization: Bearer fhs_...`, or `Api-Key` / `X-API-Key`). Any account will do: no role is needed. Anyone can get an account with GitHub or Google.

## How it looks to users

The user experience matters as much as the limit. Someone who meets the limit should understand at once why, and what to do. A crawler should get a clear "no" it can't follow.

### People in a browser

- **The links say so before you click.** For someone not logged in, the links that would cross the line are drawn as *Log in to see more* (with a small lock), linking to the login page with a return address: the *Next* link past page one of a search or a filtered XIG list, *Show all* on a code system or value set, the next page past 1,000 rows of an expansion. The first page is exactly as today.
- **After logging in you come back** to the page you asked for (`/auth/login?return=...`, the return address checked as a path on this server, as `library/auth` already does).
- **A direct request for a gated page** (a bookmarked link, a crawler) gets **401** with a short HTML page: what was asked for, why it needs a login ("this page costs the server a lot to make, and crawlers were making it thousands of times a minute"), a *Log in* button (GitHub, Google), and a link back to the first page. Not a redirect: a 401 tells crawlers plainly to stop, and the page is marked `noindex`.
- **A single page explains the policy:** `/auth/why-login`, linked from every refusal and the login page. What needs a login, what doesn't, that any GitHub or Google account will do, that the account is used for nothing else, and how to get an API token for software.
- **The top menu** already has *Login* at the right-hand side of every page (the single-login UI rule), so the way in is always visible.

### Software (the tx API)

- **XML without a login** gets **401** with an `OperationOutcome` in **XML** (the client asked for XML and may not read JSON; a small XML OperationOutcome is cheap to make). One issue, code `login` (FHIR's issue type for "the client needs to authenticate"), with text saying that XML needs an API token, how to get one (`/auth/why-login`), and that the same request in JSON needs none. The response has `WWW-Authenticate: Bearer`.
- **JSON** is unaffected. The IG Publisher and the validator use JSON, so nothing changes for them unless they want a bigger cache.
- **A cache too big for an anonymous client:** the existing answers stay (`CACHE_ID_DISCARDED_TOO_BIG` 404, `CACHE_REQUEST_TOO_BIG` 422), and their text adds, for an anonymous client only, that a client with an API token may hold up to `cacheMaxConceptsLoggedIn` concepts, and where to get one.
- **Getting a token:** log in on the server, open your account page, *API tokens → New token*, copy it (shown once). The account page says what a token is good for on this server.
- **Using a token from the FHIR tools:** the Java tools (IG Publisher, validator) already read server credentials from `fhir-settings.json`:

  ```json
  "servers": [
    { "url": "https://tx.fhir.org", "type": "fhir", "authenticationType": "token", "token": "fhs_..." }
  ]
  ```

  `authenticationType` may also be `apikey` (sent as an `Api-Key` header, which FHIRsmith accepts). To check before rollout: that the terminology client (not only package downloads) sends these credentials to tx.fhir.org, and that a CI build can supply the token from a secret (an environment variable in `fhir-settings.json`, or a command-line option).

### Crawlers

They get the first page of everything (so search engines still index the content, and the XIG sitemap leads them to every resource page), and a 401 for the rest. Nothing to work around: there's no rate to stay under, no user agent to fake.

## Configuration

One setting turns it on, in the `auth` block, so it means the same in every module:

| Setting | Default | |
|---|---|---|
| `auth.loginForExpensive` | `false` | Turn the rules above on. Off: the server behaves as now |
| `auth.anonymousMaxRows` | `1000` | The most rows of an expansion (HTML) someone not logged in sees |

And in the tx module, beside the existing cache limits:

| Setting | Default | |
|---|---|---|
| `cacheMaxConceptsLoggedIn` | `cacheMaxConcepts` (no difference) | Concepts one client cache may hold when the client started it with a login. tx.fhir.org: 500,000 or so |
| `cacheMaxTotalConcepts` | 1,000,000 | Unchanged in meaning (all of an endpoint's caches together); tx.fhir.org will want it raised with the above |

What needs a login (XML, search past page one, `_showAll`, XIG past page one) is fixed by the code, not configurable: fewer knobs, one documented behaviour. `--check` validates the settings. Under the cluster launcher every process reads the same `auth.db`, and `auth.sessionSecret` must be set (it already must, for logins to work across processes).

## Implementation sketch

- **`library/auth`**
  - `auth.loggedIn(req)`: the principal or null, cached per request (`PRINCIPALS` already does this). Token lookups cached in memory for a short time, so a busy API client doesn't hit `auth.db` per request.
  - `auth.requireLoginFor(req, res, { what, format })`: sends the standard refusal (HTML 401 page, OperationOutcome in XML or JSON, or `{error, message}` JSON) and counts it. One function so every module refuses the same way.
  - `auth.loginLink(req, label)`: the *Log in to see more* link with a return address, for page builders.
  - The `/auth/why-login` page.
- **tx**
  - In the request pipeline, after format negotiation and before the body is parsed: an XML request (XML `Content-Type`, or XML asked for by `_format` or `Accept`) with no principal is refused at once. Refusing before parsing matters: a large XML body is the most expensive thing to parse. The principal is looked up only for these requests and for cache starts, not for every JSON request.
  - `$cache-control` start: the cache records whether it was started with a login and gets its limit then (a cache's limit doesn't change if the client later sends no token).
  - Web UI: search paging links, `_showAll`, expansion paging (`tx-html.js`, the renderer) use `loginLink` for anonymous users; the handlers refuse the gated parameters when they come anyway.
- **XIG:** the list route refuses a filtered list with `offset` > 0 for anonymous users (HTML, JSON and CSV); `buildPager` draws *Log in to see more* in place of *Next*.
- **Reporting:** the daily report's auth section adds refusals by kind (XML, search paging, show-all, expansion rows, XIG paging, cache limit) and how many distinct addresses they came from; API token use per day.
- **Documentation:** `/auth/why-login` (users), `library/auth/README.md` (the setting and the rule table), `tx/README.md` (XML, caches, `cacheMaxConceptsLoggedIn`), `xig/readme.md`, CHANGELOG.

## Rollout

1. Build with the setting off; ship.
2. Announce on chat.fhir.org (#tooling, #terminology) with the `/auth/why-login` page and the `fhir-settings.json` snippet, before turning it on.
3. Turn it on for npm.fhir.org first (only the XIG is affected), then tx.fhir.org.
4. Watch the refusal counts in the daily report for a week: a jump in XML refusals from tool user agents means someone's build depends on XML and needs telling.
5. Raise `cacheMaxConceptsLoggedIn` on tx.fhir.org, and tell the builds whose caches are dropped (the Taiwan builds) how to get a token.

## Open questions

- **HTML on the tx API.** The design reads "XML/html requires a token" as: HTML is the web UI, governed by the web UI rules (first pages open). If every HTML response from the tx endpoints should need a login, the web UI rules collapse into that one, and crawlers get nothing past the home page.
- **`$expand` over 1,000 rows in JSON.** Written here for the web UI only. If it applied to the JSON API, anonymous IG Publisher builds would break: they ask for `count=1000` and page on through larger expansions.
- **Package web UI** (the HTML package browse and search pages, not the API): is "any search past the first page" meant to cover them too? Written here as yes for searches, no for the API.
- **The unfiltered XIG list** (`/xig?offset=N`): left open here, because robots.txt allows it and the sitemap now covers what it leads to. It could be gated too.
