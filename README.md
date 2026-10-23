# ![🔥](static/FHIRsmith64.png) FHIRsmith - FHIR Server toolkit

This server provides a set of server-side services that are useful for the FHIR Community. Each is a module, turned on and configured in `config.json`. The modules are at different stages, and stability varies between them: a module in production can still be changing in places (and the terminology server's behaviour follows decisions about its content - ICD-11, SNOMED CT - as they are made).

## In production

* [Terminology server](tx/README.md) (`tx`) - the reference terminology server for the FHIR community and the terminology ecosystem (as running on [tx.fhir.org](http://tx.fhir.org/r4))
* [TX Registry](registry/documentation/readme.md) (`registry`) - **Terminology System Registry** as [described by the terminology ecosystem specification](https://build.fhir.org/ig/HL7/fhir-tx-ecosystem-ig) (as running at http://tx.fhir.org/tx-reg, moving to https://ecosystem.hl7.org). Its API is described by an OpenAPI 3.1 spec at `/tx-reg/openapi.json` (and `.yaml`), with a browsable reference at `/tx-reg/openapi`
* [Package server](packages/readme.md) (`packages`) - **NPM-style FHIR package registry** with search, versioning, and downloads, consistent with the FHIR NPM Specification (as running at http://packages2.fhir.org/packages). Its API is described by an OpenAPI 3.1 spec at `/packages/openapi.json` (and `.yaml`), with a browsable reference at `/packages/openapi`
* Publisher (`publisher`) - FHIR publishing services (as running at [healthintersections.com.au](http://www.healthintersections.com.au/publisher))
* XIG server (`xig`) - **Comprehensive FHIR IG analytics** with resource breakdowns by version, authority, and realm (as running at http://packages2.fhir.org/packages)
* [SHL Server](shl/readme.md) (`shl`) - SHL/VHL support services (running on [healthintersections.com.au](http://www.healthintersections.com.au), supporting the ICVP demo and the Patient Document Generator)

## In production, but still under development

* [Extension tracker](extension-tracker/readme.md) (`ext-tracker`) - tracks extensions, profiles and extension usage across FHIR Implementation Guides, from data the IG Publisher submits
* [Folder](folder/readme.md) (`folder`) - serves static files from one or more directories, with optional authenticated upload
* [Testing](testing/readme.md) (`testing`) - **TestReport repository**: receives FHIR TestReports from TxTester and other test tools, with a FHIR API and web pages (as running at https://npm.fhir.org/testing). Its API is described by an OpenAPI 3.1 spec at `/testing/openapi.json` (and `.yaml`), with a browsable reference at `/testing/openapi`
* VCL (`vcl`) - **Parse VCL expressions** into FHIR ValueSet resources (as running at http://fhir.org/vcl)

## Under development, prototyping

* [IPS](ips/readme.md) (`ips`) - collections of International Patient Summary documents, each with its own FHIR endpoint, processing (validation, terminology checks, translation, narrative, clinical profiles) and web pages

## On the back-burner

These are not being actively developed at present.

* [NpmProjector](npmprojector/readme.md) (`npmprojector`) - watches a local npm package directory and serves its FHIR resources with FHIRPath-based search
* Token (`token`) - API key services

## Planned

* R4/R6 interconverter

## Summary Statement

* Maintainers: Grahame Grieve, Italo Macêdo, Josh Mandel, Jose Costa Teixeira
* Issues / Discussion: Use github issues
* License: BSD-3
* Contribution Policy: Make PRs. PRs have to pass all the tests
* Security Information: See [security.md](security.md)

## Build Status
![CI Build](https://github.com/HealthIntersections/fhirsmith/actions/workflows/ci.yml/badge.svg)
[![Release](https://img.shields.io/github/v/release/HealthIntersections/fhirsmith?include_prereleases)](https://github.com/HealthIntersections/fhirsmith/releases)
[![Docker](https://img.shields.io/badge/docker-ghcr.io-blue)](https://github.com/HealthIntersections/fhirsmith/pkgs/container/fhirsmith)

Note: In production, this server always runs behind an nginx reverse proxy, so there's no
in-build support for SSL, rate limiting etc. See [nginx.md](nginx.md) for how to configure it.

## Quick Start

There are 4 executable programs:
* the server (`node server`)
* the terminology importer (`node --max-old-space-size=8192 tx/importers/tx-import XXX`) - see [Doco](tx/importers/readme.md)
* the test cases (`npm test`)
* the test cases generater (`node tx/tests/testcases-generator.js`)

Unless you're developing, you only need the first two

FHIRsmith is open source - see below, and you're welcome to use it for any kind of use. Note,
though, that if you support FHIRsmith commercially as part of a managed service or product, you
are required to be a Commercial Partner of HL7 - see (link to be provided).

### Quick Start

* Install FHIRSmith (using docker, or an NPM release, or just get the code by git)
* Figure out the data directory
* Provide a configuration to tell the server what to run (see documentation below, or use a [prebuilt configuration]/configurations/readme.md)
* Run the server

For further details of these steps, read on

### Data Directory

The server separates code from runtime data. All databases, caches, logs, and downloaded
files are stored in a single data directory. The location is determined by:

1. The `FHIRSMITH_DATA_DIR` environment variable (if set)
2. Otherwise, defaults to `./data` relative to the working directory (development set up)

The data directory contains (depending on which modules are in use):
* `config.json` — server and module configuration
* `logs/` — server and nginx log files
* `terminology-cache/` — downloaded terminology packages and FHIR packages
* `packages/` — package server database
* `xig/` — XIG database
* `shl/` — SHL databases and certificates
* `registry/` — registry crawler data
* `publisher/` — publisher database and build workspace
* `token/` — token database

During development with a cloned repository, the data directory defaults to `[root]/data`
(the test cases require this setup). When deployed via Docker or npm, the data directory
is provided by the host — see Deployment below.

### Prerequisites
- Node.js 24+
- NPM or Yarn
- Java 17+ (for FHIR validator, also for the test cases)

### Installation

These instructions are for Development. For deployment, see below.

```bash
# Clone the repository
git clone https://github.com/HealthIntersections/FHIRsmith
cd FHIRsmith

# Install dependencies
npm install

# Create required directories
mkdir -p data data/logs

# Copy example configuration
cp config.example.json data/config.json

# Edit configuration as needed
nano data/config.json
```

Each Module has it's own entry in the config, as described by the module

### Basic Configuration

Create a `config.json` file in your data directory (use `config-template.json` as a starting point):

```json
{
  "hostName" : "[descriptive name for the server]",
  "server": {
    "port": 3000,
    "cors": {
      "origin": "*",
      "credentials": true
    }
  },
  "modules": {
    // per modules...
  }
}
```

### Logging Configuration

Add a `logging` section to `config.json` to control log behaviour. All fields are optional and have sensible defaults:

```json
{
  "logging": {
    "level": "info",
    "console": true,
    "consoleErrors": false,
    "maxFiles": 14,
    "maxSize": "50m",
    "flushInterval": 2000,
    "flushSize": 200
  }
}
```

| Option | Default | Description |
|---|---|---|
| `level` | `"info"` | Minimum level to log: `error`, `warn`, `info`, `debug`, or `verbose` |
| `console` | `true` | Write log lines to stdout/stderr. Disable when running as a systemd service where console output goes to the journal and is redundant |
| `consoleErrors` | `false` | Whether `error` and `warn` levels appear on the console. When `false`, errors and warnings are written to the log file only |
| `maxFiles` | `14` | Number of daily log files to retain before old ones are deleted |
| `maxSize` | `0` (unlimited) | Maximum size per log file before rotation. Accepts human-readable strings: `"20m"`, `"1g"`, or a raw byte count |
| `flushInterval` | `2000` | Milliseconds between buffered writes to disk. Increase to reduce I/O under heavy load |
| `flushSize` | `200` | Number of buffered log lines that trigger an immediate flush regardless of the timer |

Log files are written to the `logs/` subdirectory of the data directory as `server-YYYY-MM-DD.log`. A `server.log` symlink always points to the current day's file, so `tail -f data/logs/server.log` tracks the active log without needing to know the date.

### Email and the Daily Report

The server can email a short markdown report on itself once a day. It needs two things in
`config.json`: an SMTP server to send through, and someone to send to:

```json
{
  "email": {
    "host": "smtp.example.org",
    "port": 587,
    "user": "fhirsmith",
    "password": "...",
    "from": "FHIRsmith <fhirsmith@example.org>"
  },
  "dailyReport": {
    "to": ["ops@example.org"]
  }
}
```

`user`/`password` are optional (an open relay); `secure` defaults to true for port 465 and
to STARTTLS otherwise. Without an `email` block nothing is emailed, and without
`dailyReport.to` there's no report (`dailyReport.enabled: false` turns it off explicitly).

The report, titled "`{hostName}` daily report", goes out at midnight (the server's local
time), or as soon as the server is up again if it was down at midnight. It has a paragraph
on the server's stability since the last report - how much of the time it was up, restarts,
the longest outage, and any upgrade (from the run history in the statistics database, so
`stats.enabled: false` leaves the uptime unknown); a paragraph from each running module that
has something to report (by default, none do); and a paragraph on the system - version,
Node.js and OS, how long this run has been up, the log files and the free disk space they're
drawing on, plus anything the npm audit check has found (packages with known vulnerabilities and
what to do about them, or a newer FHIRsmith release). If any background task's last run failed, a
final section lists them. When the last report was sent is kept in `daily-report.json` in the data
directory.

A module takes part by implementing `dailyReport({since, now})`, returning its paragraph as
markdown (or a promise of it); an empty return means it has nothing to say that day. The
request counts a module quotes come from `stats.countsSince(since, now)`, the per-operation
counts in the statistics database for the period. The modules that report:

| Module | Reports |
|---|---|
| Terminology server | how many of each operation were performed, over all its endpoints |
| Terminology server registry | client requests answered by the API, servers registered, and any server that answered none of the registry's scans in the period |
| Packages | packages served (tarball downloads) and new package versions found by the crawler |
| XIG | pages served, and whether the database could be accessed (and whether the last download failed) |
| Testing | pages served, test reports received, and the number held |
| SMART Health Links | QR codes created (SMART Health Links and Verifiable Health Links), link accesses, and the documents stored to serve them |
| IPS | pages served, IPS documents received, and the number stored |
| Publisher | publication runs started, and how many finished successfully |

### Start the Server

```bash
# Development mode
npm run dev

# Production mode
npm start
```

The server will be available at `http://localhost:{port}` using the port specified in the config.
In the production servers listed above, the server always sits behind an NGINX server which manages
SSL, security, rate limiting etc. See [nginx.md](nginx.md) for configuration advice, including
running several servers behind one front door.

## Testing

```bash
npm test
```

## Deployment

There are three deployment options: npm global install, Docker, or clone-and-run. All three
use the `FHIRSMITH_DATA_DIR` environment variable to locate the data directory.

### npm Global Install

```bash
# Install globally
npm install -g fhirsmith

# Create a data directory
mkdir -p /var/lib/fhirsmith
cp node_modules/fhirsmith/config-template.json /var/lib/fhirsmith/config.json
# Edit config.json as needed

# Set the data directory and run
export FHIRSMITH_DATA_DIR=/var/lib/fhirsmith
fhirsmith
```

Or run it inline:

```bash
FHIRSMITH_DATA_DIR=/var/lib/fhirsmith fhirsmith
```

### Changing the Node.js version

Some of FHIRsmith's dependencies (the SQLite drivers) are native modules, built for the
version of Node.js that installed them. After upgrading Node.js, rebuild them - `npm rebuild`
in the FHIRsmith folder, or `npm rebuild -g fhirsmith` for a global install - or reinstall
FHIRsmith. Otherwise the server stops at startup with "compiled against a different Node.js
version". (With nvm, each Node.js version has its own global packages, so install FHIRsmith
again under the new version.) Docker images aren't affected.

### Docker Installation

The server is available as a Docker image. Mount a host directory as the data directory:

```bash
# Pull the latest image
docker pull ghcr.io/healthintersections/fhirsmith:latest

# Create and populate data directory on host
mkdir -p /path/to/data
cp config-template.json /path/to/data/config.json
# Edit config.json as needed

# Run with data directory mounted
docker run -d --name fhirsmith \
  -p 3000:3000 \
  -e FHIRSMITH_DATA_DIR=/app/data \
  -v /path/to/data:/app/data \
  ghcr.io/healthintersections/fhirsmith:latest
```

Available tags:
- `latest`: Latest stable release
- `vX.Y.Z`: Specific version (e.g., `v1.0.0`)
- `cibuild`: Latest build from the main branch

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `FHIRSMITH_DATA_DIR` | Path to the data directory | `./data` |
| `PORT` | Server port (overrides config) | from config.json |
| `NODE_ENV` | Node environment | `production` |

### Windows Installation

You can install as a windows service using [windows-install.js](utilities/windows-install.js). You might need to
hack that.

## Releases

This project follows [Semantic Versioning](https://semver.org/) and uses a [CHANGELOG.md](CHANGELOG.md) file to track changes.

### What's in a Release

Each GitHub Release includes:
- **Release notes** extracted from CHANGELOG.md
- **Source code** archives (zip and tar.gz)
- **Docker images** pushed to GitHub Container Registry:
    - `ghcr.io/healthintersections/fhirsmith:latest`
    - `ghcr.io/healthintersections/fhirsmith:vX.Y.Z`
    - `ghcr.io/healthintersections/fhirsmith:X.Y.Z`
- **npm package** published to npmjs.org as [`fhirsmith`](https://www.npmjs.com/package/fhirsmith)

Release images carry OCI labels, so an image says which release it is without
having to trust the tag it was pulled under:

```bash
docker inspect --format '{{json .Config.Labels}}' ghcr.io/healthintersections/fhirsmith:latest
```

`org.opencontainers.image.version` is the release, `.revision` the commit it was
built from, and `.source` is what links the package to this repository on GHCR.

### Tracking Releases

Server administrators should follow releases: a server is only as safe as the
release it runs.

- **Email**: on the [GitHub repository](https://github.com/HealthIntersections/FHIRsmith),
  choose **Watch → Custom → Releases**. Each release is emailed with its notes (needs a GitHub account)
- **Atom feed**: `https://github.com/HealthIntersections/FHIRsmith/releases.atom` - each
  entry carries the release notes, for a feed reader or a Slack/Teams feed integration
- **The server itself**: once a day the server looks up the latest release on npm, and the
  dashboard says whether a newer one is available (this is part of the npm audit check, so
  `npmAudit.enabled = false` turns it off too)

### CI Images

Every push to main also publishes `:cibuild` and `:cibuild-<sha>` to the same
package. These are **not releases** - they are whatever was last merged. The
Docker Build workflow prunes all but the ten most recent afterwards, so they do
not bury the current release on the package page. To prune by hand (or to run
the one-off backfill of images published before that job existed), run the
**GHCR Cleanup** workflow from the Actions tab with `dry_run` on first, read the
log, then run it again with `dry_run` off.

### Creating a Release

GitHub Actions will automatically:
- Run tests
- Create a GitHub Release with notes from CHANGELOG.md
- Build and publish Docker images with appropriate tags

**Prerequisites:**
- All tests passing on main branch
- CHANGELOG.md updated with changes

**Steps:**
1. Update `CHANGELOG.md` with your changes under a new version section:
```markdown
   ## [vX.Y.Z] - YYYY-MM-DD
### Added
- New feature description
### Changed
- Change description
### Fixed
- Bug fix description
### Tx Conformance Statement
     {copy content from text-cases-summary.txt}
```
2. Update `package.json` & `package-lock.json` to the release version:

```bash
   npm version --no-git-tag-version X.Y.Z
   npm install --package-lock-only
```

   This matters more than it looks. The server reports its version from
   `package.json` (`server.js`, `tx/tx.js`) - not from the `APP_VERSION` build
   arg - so a package.json left on the previous number ships a Docker image that
   calls itself by the wrong release for good. The **Verify Version** job fails
   the release if `package.json` or `package-lock.json` disagrees with the tag.

3. Commit your changes:
```bash
   git commit -m "Prepare release vX.Y.Z"
   git push origin main:XXXXXX
```

or do it via a PR

4. Run the tx tests (`npx jest tests/tx/test-cases.test.js`), then tag and push the release:
```bash
   ./release.sh X.Y.Z
```

   `gr.sh` checks that the release is ready - on `main` and pushed, the three versions in
   `package.json` and `package-lock.json` match, `CHANGELOG.md` has a dated section with the
   conformance statement, and `test-cases-report.json` passed, is from this version and is
   newer than the last code change - then submits the report to
   [npm.fhir.org](https://npm.fhir.org/testing) (set `FHIRSMITH_TESTING_TOKEN` if it needs a
   token), and only if that is accepted, tags `vX.Y.Z` and pushes the tag.

   The tx test run writes `test-cases-report.json` next to `test-cases-summary.txt` (both
   are ignored by git). The report records the version in `package.json` when the tests
   ran, so run the tx tests after step 2. To submit a report on its own (to a different
   /testing server, say): `node utilities/submit-test-report.js [-server {url}] [-token {token}]`.

5. Monitor the release:
    - Check [GitHub Actions](https://github.com/HealthIntersections/fhirsmith/actions) for the Release workflow
    - Verify the [GitHub Release](https://github.com/HealthIntersections/fhirsmith/releases) was created
    - Confirm Docker images are available at [GHCR](https://github.com/HealthIntersections/fhirsmith/pkgs/container/fhirsmith)

6. Update `package.json` to have the next release version -SNAPSHOT

**If a release fails:**
- Delete the tag: `git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z`
- Fix the issue
- Re-tag and push

### Creating a Release

## License

[BSD-3](https://opensource.org/license/bsd-3-clause)

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## Support

- **Issues:** [GitHub Issues](repository-url/issues)
- **Documentation:** [Wiki](repository-url/wiki)
- **FHIR Community:** [chat.fhir.org](https://chat.fhir.org)