#!/usr/bin/env bash
#
# Release FHIRsmith: ./release.sh 0.17.0
#
# Checks that the release is ready, submits the tx test report to the /testing server, then
# tags the release and pushes the tag (which starts .github/workflows/release.yml).
# Stops at the first problem, before anything is tagged.
#
# The test report: run the tx tests first (npx jest tests/tx/test-cases.test.js). If the
# /testing server needs a token, set FHIRSMITH_TESTING_TOKEN.

set -euo pipefail

fail() {
  echo "gr.sh: $*" >&2
  exit 1
}

[ $# -eq 1 ] || fail "usage: ./gr.sh <version>, e.g. ./gr.sh 0.17.0"
VERSION="${1#v}"
TAG="v$VERSION"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "'$1' is not a release version (X.Y.Z)"

cd "$(dirname "$0")"

# --- git: on main, nothing uncommitted, and exactly what is on GitHub -------------------
[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || fail "not on main"
[ -z "$(git status --porcelain --untracked-files=no)" ] || fail "there are uncommitted changes"
git fetch --quiet origin main --tags
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] \
  || fail "main is not the same as origin/main - push (or pull) first, so the tag is on a commit GitHub has"
! git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || fail "tag $TAG already exists"

# --- versions: what release.yml's verify-version job checks ----------------------------
check_version() {
  local what="$1" found="$2"
  [ "$found" = "$VERSION" ] || fail "$what is '$found', not $VERSION (npm version --no-git-tag-version $VERSION && npm install --package-lock-only)"
}
check_version "package.json version" "$(node -p "require('./package.json').version")"
check_version "package-lock.json version" "$(node -p "require('./package-lock.json').version")"
check_version 'package-lock.json packages[""]' "$(node -p "require('./package-lock.json').packages[''].version")"

# --- CHANGELOG: a dated section for this version, with the conformance statement in -----
HEADING=$(grep -E "^## \[v?${VERSION//./\\.}\]" CHANGELOG.md || true)
[ -n "$HEADING" ] || fail "CHANGELOG.md has no section for $VERSION"
[[ "$HEADING" =~ [0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || fail "the CHANGELOG.md section for $VERSION has no date: $HEADING"
SECTION=$(sed -n "/^## \[v\{0,1\}${VERSION//./\\.}\]/,/^## \[/p" CHANGELOG.md | sed '$d')
! grep -qx '(paste)' <<<"$SECTION" || fail "the Tx Conformance Statement for $VERSION hasn't been pasted into CHANGELOG.md"

# --- the test report: this version, passed, and run on what is being released ----------
REPORT=test-cases-report.json
[ -f "$REPORT" ] || fail "no $REPORT - run the tx tests first (npx jest tests/tx/test-cases.test.js)"
# the last commit that changed what the tests run - not the notes, nor the version bump
CODE_COMMITTED=$(git log -1 --format=%cI -- . ':(exclude)*.md' ':(exclude)release.sh' ':(exclude)package.json' ':(exclude)package-lock.json')
node - "$REPORT" "$VERSION" "$CODE_COMMITTED" <<'NODE' || exit 1
const [file, version, committed] = process.argv.slice(2);
const report = JSON.parse(require('fs').readFileSync(file, 'utf8'));
const fhirsmith = (report.participant || []).find(p => p.uri === 'https://github.com/HealthIntersections/FHIRsmith');
const problems = [];
if (!fhirsmith || fhirsmith.version !== version) {
  problems.push(`it is from FHIRsmith ${fhirsmith ? fhirsmith.version : '(unknown)'}, not ${version}`);
}
if (report.result !== 'pass') {
  problems.push(`its result is '${report.result}', not 'pass'`);
}
if (!report.issued || new Date(report.issued) < new Date(committed)) {
  problems.push(`it was run (${report.issued}) before the last change to the code (${committed})`);
}
if (problems.length > 0) {
  console.error(`gr.sh: ${file} can't be submitted for ${version}: ${problems.join('; ')} - run the tx tests again`);
  process.exit(1);
}
NODE

# --- submit the report, then tag ---------------------------------------------------------
node utilities/submit-test-report.js -file "$REPORT" || fail "the test report was not accepted, so $TAG has not been tagged"

git tag -a "$TAG" -m "FHIRsmith $VERSION"
git push origin "$TAG"
echo "Tagged and pushed $TAG - the release workflow is now running"
