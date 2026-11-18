#!/usr/bin/env node
// utilities/audit-check.js
// `npm audit` with an allowlist, for CI. npm audit has no way to accept a particular
// advisory, so when one has no fixed release yet (or can't reach anything an attacker
// controls) the only choices are a failing build or turning the check off. This runs
// `npm audit --json`, drops the advisories listed in audit-allowlist.json, and fails on
// anything else at or above the audit level.
//
// Usage: node utilities/audit-check.js [--omit=dev] [--audit-level=high] [--allowlist=<file>]
// Runs in the current directory (so it can audit a fresh install elsewhere); the allowlist
// defaults to the one at the repository root.
//
// Allowlist entries: { "id": "GHSA-...", "reason": "...", "until": "YYYY-MM-DD" }. An entry
// past its date no longer applies, so it can't quietly outlive the reason for it.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const LEVELS = ['info', 'low', 'moderate', 'high', 'critical'];

function parseArgs(argv) {
  const args = { omitDev: false, level: 'low', allowlist: path.join(__dirname, '..', 'audit-allowlist.json') };
  for (const a of argv) {
    if (a === '--omit=dev') {
      args.omitDev = true;
    } else if (a.startsWith('--audit-level=')) {
      args.level = a.substring('--audit-level='.length);
    } else if (a.startsWith('--allowlist=')) {
      args.allowlist = path.resolve(a.substring('--allowlist='.length));
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (!LEVELS.includes(args.level)) {
    throw new Error(`Unknown audit level: ${args.level}`);
  }
  return args;
}

/** The GHSA id from an advisory URL (https://github.com/advisories/GHSA-xxxx-xxxx-xxxx), or null */
function ghsaId(url) {
  const m = /(GHSA(?:-[0-9a-z]{4}){3})/i.exec(url || '');
  return m ? 'GHSA' + m[1].substring(4).toLowerCase() : null;
}

/**
 * The advisories in an `npm audit --json` report (version 2). Only the `via` entries that
 * are objects are advisories; string entries just name the dependency a package is
 * vulnerable through, which the advisory itself already covers.
 */
function advisories(report) {
  const found = new Map();
  for (const vuln of Object.values(report.vulnerabilities || {})) {
    for (const via of vuln.via || []) {
      if (via && typeof via === 'object') {
        const id = ghsaId(via.url) || String(via.source);
        if (!found.has(id)) {
          found.set(id, { id, name: via.name, severity: via.severity, title: via.title, url: via.url, range: via.range });
        }
      }
    }
  }
  return [...found.values()];
}

/** Split the advisories into those that fail the check and those the allowlist accepts */
function check(found, allowlist, level, today = new Date().toISOString().substring(0, 10)) {
  const min = LEVELS.indexOf(level);
  const entries = (allowlist && allowlist.advisories) || [];
  const active = new Map();
  const expired = [];
  for (const e of entries) {
    const id = String(e.id || '').toUpperCase();
    if (e.until && e.until < today) {
      expired.push(e);
    } else if (id) {
      active.set(id, e);
    }
  }
  const failures = [];
  const accepted = [];
  for (const a of found) {
    if (LEVELS.indexOf(a.severity) < min) {
      continue;
    }
    if (active.has(a.id.toUpperCase())) {
      accepted.push(a);
    } else {
      failures.push(a);
    }
  }
  const seen = new Set(found.map(a => a.id.toUpperCase()));
  const unused = [...active.values()].filter(e => !seen.has(String(e.id).toUpperCase()));
  return { failures, accepted, expired, unused };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const allowlist = fs.existsSync(args.allowlist) ? JSON.parse(fs.readFileSync(args.allowlist, 'utf8')) : { advisories: [] };
  const npmArgs = ['audit', '--json'];
  if (args.omitDev) {
    npmArgs.push('--omit=dev');
  }
  let out;
  try {
    out = execFileSync('npm', npmArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    // npm audit exits non-zero when it finds anything; the report is still on stdout
    out = e.stdout;
    if (!out) {
      throw e;
    }
  }
  const report = JSON.parse(out);
  if (report.error) {
    throw new Error(`npm audit failed: ${report.error.summary || JSON.stringify(report.error)}`);
  }
  const result = check(advisories(report), allowlist, args.level);
  for (const a of result.accepted) {
    console.log(`accepted (audit-allowlist.json): ${a.id} ${a.name} ${a.range} (${a.severity}) - ${a.title}`);
  }
  for (const e of result.expired) {
    console.log(`::warning::audit-allowlist.json entry ${e.id} expired on ${e.until}: it no longer applies - look at it again`);
  }
  for (const e of result.unused) {
    console.log(`::warning::audit-allowlist.json entry ${e.id} matches nothing any more: remove it`);
  }
  for (const a of result.failures) {
    console.log(`::error::${a.id} ${a.name} ${a.range} (${a.severity}) - ${a.title} ${a.url || ''}`);
  }
  console.log(`${result.failures.length} advisor${result.failures.length === 1 ? 'y' : 'ies'} at ${args.level} or above` +
    (result.accepted.length ? `, ${result.accepted.length} accepted by the allowlist` : ''));
  process.exitCode = result.failures.length ? 1 : 0;
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.log(`::error::${e.message}`);
    process.exitCode = 2;
  }
}

module.exports = { ghsaId, advisories, check };
