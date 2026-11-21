#!/usr/bin/env node
// utilities/next-snapshot.js
//
// After a release: start the next patch version. release.sh runs it once the tag is pushed;
// it can also be run by hand:  node utilities/next-snapshot.js 1.0.6
//
//  - package.json and package-lock.json (version, and packages[""].version) go to the next
//    patch snapshot: 1.0.6 -> 1.0.7-snapshot
//  - CHANGELOG.md gets an empty section for 1.0.7 (from changelog-template.md), above the
//    newest section. Its date stays 2026-mm-dd, so the release checks and library/changelog.js
//    don't take it for a release until it is dated
//
// It changes the files and commits nothing. Run again, it changes nothing that is already done.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function fail(message) {
  console.error(`next-snapshot: ${message}`);
  process.exit(1);
}

const released = String(process.argv[2] || '').replace(/^v/, '');
const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(released);
if (!m) {
  fail(`usage: node utilities/next-snapshot.js <released version>, e.g. 1.0.6 (got '${process.argv[2] || ''}')`);
}
const next = `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
const snapshot = `${next}-snapshot`;

// --- package.json, package-lock.json ------------------------------------------------------
function setVersion(file, apply) {
  const full = path.join(ROOT, file);
  const json = JSON.parse(fs.readFileSync(full, 'utf8'));
  apply(json);
  fs.writeFileSync(full, JSON.stringify(json, null, 2) + '\n'); // as npm writes them
}

const current = require(path.join(ROOT, 'package.json')).version;
if (current !== released && current !== snapshot) {
  fail(`package.json is at ${current}, not the released ${released} - not changing the version`);
}
setVersion('package.json', json => { json.version = snapshot; });
setVersion('package-lock.json', json => {
  json.version = snapshot;
  if (json.packages && json.packages['']) {
    json.packages[''].version = snapshot;
  }
});
console.log(`package.json, package-lock.json: ${current} -> ${snapshot}`);

// --- CHANGELOG.md ---------------------------------------------------------------------------
const changelogFile = path.join(ROOT, 'CHANGELOG.md');
const changelog = fs.readFileSync(changelogFile, 'utf8');
const escaped = next.replace(/\./g, '\\.');
if (new RegExp(`^## \\[v?${escaped}\\]`, 'm').test(changelog)) {
  console.log(`CHANGELOG.md: already has a section for ${next}`);
} else {
  const first = changelog.search(/^## \[/m);
  if (first < 0) {
    fail('CHANGELOG.md has no "## [" section to put the new one above');
  }
  const template = fs.readFileSync(path.join(ROOT, 'changelog-template.md'), 'utf8')
    .replace('[m.n.p]', `[${next}]`)
    .replace(/\s*$/, '\n\n');
  fs.writeFileSync(changelogFile, changelog.slice(0, first) + template + changelog.slice(first));
  console.log(`CHANGELOG.md: added a section for ${next}`);
}
