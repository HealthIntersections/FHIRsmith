# ![🔥](static/FHIRsmith64.png) FHIRsmith - FHIR Server toolkit

This server provides a set of server-side services that are useful for the FHIR Community. The set of are two kinds of services:

## Modules useful to anyone in the community

* (Coming) R4/R6 interconverter
* [terminology](tx/README.md) server (as running on [tx.fhir.org](http://tx.fhir.org/r4))
* [SHL Server](shl/readme.md) - SHL/VHL support services (running on [healthintersections.com.au](http://www.healthintersections.com.au), supporting the ICVP demo and and the Patient Document Generator)

## Services useful the community as a whole

* [TX Registry](registry/readme.md) - **Terminology System Registry** as [described by the terminology ecosystem specification](https://build.fhir.org/ig/HL7/fhir-tx-ecosystem-ig) (as running at http://tx.fhir.org/tx-reg)
* [Package server](packages/readme.md) - **NPM-style FHIR package registry** with search, versioning, and downloads, consistent with the FHIR NPM Specification (as running at http://packages2.fhir.org/packages)
* [XIG server](xig/readme.md) -  **Comprehensive FHIR IG analytics** with resource breakdowns by version, authority, and realm (as running at http://packages2.fhir.org/packages)
* [Publisher](publisher/readme.md) - FHIR publishing services (as running at [healthintersections.com.au](http://www.healthintersections.com.au/publisher))
* [VCL](vcl/readme.md) - **Parse VCL expressions** into FHIR ValueSet resources (as running at http://fhir.org/vcl)
* (Coming) Token services

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
in-build support for SSL, rate limiting etc.

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
- Node.js 16+
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

### Start the Server

```bash
# Development mode
npm run dev

# Production mode
npm start
```

The server will be available at `http://localhost:{port}` using the port specified in the config.
In the production servers listed above, the server always sits behind an NGINX server which manages
SSL, security, rate limiting etc.

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
- **npm package** published to npmjs.org as `fhirsmith` *(if you add this)*

Release images carry OCI labels, so an image says which release it is without
having to trust the tag it was pulled under:

```bash
docker inspect --format '{{json .Config.Labels}}' ghcr.io/healthintersections/fhirsmith:latest
```

`org.opencontainers.image.version` is the release, `.revision` the commit it was
built from, and `.source` is what links the package to this repository on GHCR.

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

4. Tag and push the release:
```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
```

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