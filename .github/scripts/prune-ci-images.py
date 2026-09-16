#!/usr/bin/env python3
"""
Prune old CI container image versions from the GHCR package.

Every push to main publishes ghcr.io/<repo>:cibuild and :cibuild-<sha>. Those
accumulate forever and crowd the "Recent tagged image versions" list on the
package page, so a visitor sees a 40-hex CI tag as the newest thing rather than
the current release. This deletes the older ones.

What it will delete:
  - package versions whose tags ALL start with PREFIX (default "cibuild-"),
    beyond the KEEP most recent;
  - the untagged child manifests (per-arch images, attestations) belonging to
    those versions, but only when no version we are keeping also references them.

What it will never delete:
  - anything carrying a tag outside PREFIX (so releases, "latest" and the
    moving "cibuild" tag are safe even if they share a digest with a CI build);
  - untagged versions it cannot positively attribute to a deleted parent.

Environment:
  GH_TOKEN       required; GITHUB_TOKEN with packages:write, or a PAT with
                 delete:packages if the repo-scoped token is refused.
  GITHUB_REPOSITORY  owner/repo, e.g. HealthIntersections/fhirsmith (set by Actions).
  PACKAGE        package name; defaults to the repo name.
  PREFIX         tag prefix identifying CI builds (default "cibuild-").
  KEEP           how many CI versions to retain (default 10).
  DRY_RUN        "true" to report without deleting (default "true").
"""

import json
import os
import sys
import urllib.error
import urllib.request

API = "https://api.github.com"
REGISTRY = "https://ghcr.io"

MANIFEST_ACCEPT = ", ".join([
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
])


def env(name, default=None, required=False):
    value = os.environ.get(name) or default
    if required and not value:
        sys.exit(f"error: {name} is not set")
    return value


TOKEN = env("GH_TOKEN", required=True)
REPOSITORY = env("GITHUB_REPOSITORY", required=True)
OWNER, REPO = REPOSITORY.split("/", 1)
PACKAGE = env("PACKAGE", REPO)
PREFIX = env("PREFIX", "cibuild-")
KEEP = int(env("KEEP", "10"))
DRY_RUN = env("DRY_RUN", "true").lower() != "false"
REPO_LC = REPOSITORY.lower()


def api(path, method="GET"):
    """One GitHub API call. Returns (status, parsed body or None)."""
    request = urllib.request.Request(f"{API}{path}", method=method)
    request.add_header("Authorization", f"Bearer {TOKEN}")
    request.add_header("Accept", "application/vnd.github+json")
    request.add_header("X-GitHub-Api-Version", "2022-11-28")
    try:
        with urllib.request.urlopen(request) as response:
            body = response.read()
            return response.status, (json.loads(body) if body else None)
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode("utf-8", "replace")


def list_versions():
    """All container versions for the package, newest first.

    The package may hang off an organisation or a user account; try the
    organisation route first and fall back rather than guessing from the name.
    """
    for scope in ("orgs", "users"):
        base = f"/{scope}/{OWNER}/packages/container/{PACKAGE}/versions"
        status, body = api(f"{base}?per_page=1")
        if status == 404:
            continue
        if status == 403:
            sys.exit(
                f"error: {status} listing {base}.\n"
                "The token cannot read this package. GITHUB_TOKEN only works when the\n"
                "package is scoped to this repository and the workflow grants\n"
                "`packages: write`; otherwise supply a PAT with `read:packages` and\n"
                "`delete:packages` as GH_TOKEN."
            )
        if status != 200:
            sys.exit(f"error: {status} listing {base}: {body}")

        versions, page = [], 1
        while True:
            status, body = api(f"{base}?per_page=100&page={page}")
            if status != 200:
                sys.exit(f"error: {status} listing {base} page {page}: {body}")
            if not body:
                break
            versions.extend(body)
            page += 1
        return versions

    sys.exit(f"error: no container package named '{PACKAGE}' under '{OWNER}'")


def registry_token():
    url = f"{REGISTRY}/token?scope=repository:{REPO_LC}:pull&service=ghcr.io"
    with urllib.request.urlopen(url) as response:
        return json.load(response)["token"]


def children(digest, token):
    """Child manifest digests of a multi-arch index, or [] for a plain manifest."""
    request = urllib.request.Request(f"{REGISTRY}/v2/{REPO_LC}/manifests/{digest}")
    request.add_header("Authorization", f"Bearer {token}")
    request.add_header("Accept", MANIFEST_ACCEPT)
    try:
        with urllib.request.urlopen(request) as response:
            manifest = json.load(response)
    except urllib.error.HTTPError as error:
        print(f"  warning: cannot read manifest {digest[:19]}: {error.code}")
        return []
    return [entry["digest"] for entry in manifest.get("manifests", [])]


def tags_of(version):
    return version.get("metadata", {}).get("container", {}).get("tags", []) or []


def main():
    versions = list_versions()
    by_digest = {version["name"]: version for version in versions}
    print(f"{len(versions)} version(s) in {OWNER}/{PACKAGE}")

    # A version is a CI build only if every tag on it is a CI tag. A digest that
    # also carries a release tag is somebody's release image and stays.
    ci = [v for v in versions if tags_of(v) and all(t.startswith(PREFIX) for t in tags_of(v))]
    ci.sort(key=lambda v: v["updated_at"], reverse=True)

    keep, doomed = ci[:KEEP], ci[KEEP:]
    print(f"{len(ci)} tagged '{PREFIX}*' version(s): keeping {len(keep)}, deleting {len(doomed)}")
    if not doomed:
        return

    token = registry_token()

    # Children of everything that survives, so a shared layer-set is never orphaned.
    doomed_digests = {v["name"] for v in doomed}
    protected = set()
    for version in versions:
        if version["name"] in doomed_digests:
            continue
        protected.update(children(version["name"], token))

    targets = []
    for version in doomed:
        targets.append((version["id"], version["name"], ",".join(tags_of(version))))
        for child in children(version["name"], token):
            if child in protected:
                continue
            orphan = by_digest.get(child)
            if orphan and not tags_of(orphan):
                targets.append((orphan["id"], child, "(untagged child)"))

    failures = 0
    for version_id, digest, label in targets:
        if DRY_RUN:
            print(f"  would delete {digest[:19]} {label}")
            continue
        for scope in ("orgs", "users"):
            path = f"/{scope}/{OWNER}/packages/container/{PACKAGE}/versions/{version_id}"
            status, body = api(path, method="DELETE")
            if status == 404 and scope == "orgs":
                continue
            if status in (202, 204):
                print(f"  deleted {digest[:19]} {label}")
            else:
                print(f"  FAILED {digest[:19]} {label}: {status} {body}")
                failures += 1
            break

    if DRY_RUN:
        print(f"\ndry run: {len(targets)} version(s) would be deleted. Set DRY_RUN=false to apply.")
    elif failures:
        sys.exit(f"{failures} deletion(s) failed")


if __name__ == "__main__":
    main()
