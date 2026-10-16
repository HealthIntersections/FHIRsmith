#!/usr/bin/env node
//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * One-off repair of a package server's database and mirror, for a database built before
 * the crawler stored each id#version only once.
 *
 *   node packages/utilities/dedupe-versions.js -db <packages.db> -mirror <mirror folder> [-apply] [-verbose] [-keep <GUID>]...
 *
 * Without -apply it reports what it would do and changes nothing. Back up the database
 * first. It is safe to run while the server is up, but best between crawler runs. It can be
 * run with sudo: rewritten mirror files keep the owner, group and mode of the files they replace.
 *
 * 1. Duplicate rows. For each id#version stored more than once, it keeps one row, using the
 *    crawler's rule: a direct copy beats a Simplifier copy (a secondary echo); otherwise the
 *    first stored wins. Two direct copies with different content are a conflict - only their
 *    Simplifier rows are removed, and they are listed for manual cleanup. Deleted rows'
 *    download counts are added to the kept row. To settle a conflict, run it again with
 *    -keep and the GUID (the URL it lists) of the copy to keep, once per conflict.
 * 2. The unique index on (Id, Version), once there are no duplicates left.
 * 3. The mirror. Every row's mirror file must be the bytes that row's Hash describes; a file
 *    that is missing or different is rewritten from the row's Content. Conflicts are skipped.
 *    The report separates the two: a different file is served with the wrong checksum; a
 *    missing one isn't served at all. -verbose lists every missing file.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// node:sqlite (built into Node 24) rather than an npm package, so this file runs on its own:
// copy it to the server and run it with node, no install needed
const { DatabaseSync } = require('node:sqlite');

const UNIQUE_INDEX = 'CREATE UNIQUE INDEX IF NOT EXISTS SK_PackageVersions_IdVersion ON PackageVersions (Id, Version)';

// These two must match PackageCrawler.isSimplifierGuid and PackageCrawler.fixPrefix
// (tests/packages/package-crawler-versions.test.js checks that they do)
function isSimplifier(guid) {
  return /^https?:\/\/packages\.simplifier\.net\//i.test(guid || '');
}

function fixPrefix(id) {
  return id && id.startsWith('@') && id.includes('/') ? id.replace('@', '$$').replace('/', '$') : id;
}

const mirrorName = (id, version) => `${fixPrefix(id)}-${version}.tgz`;

// When run with sudo, a rewritten file would otherwise belong to root. Give it the owner,
// group and mode of the file it replaces (or of the mirror folder, for a missing file).
function keepOwnership(file, like) {
  const st = fs.statSync(like);
  if (process.getuid && process.getuid() === 0) {
    fs.chownSync(file, st.uid, st.gid);
  }
  fs.chmodSync(file, st.isDirectory() ? st.mode & 0o666 : st.mode & 0o7777);
}
const sha1 = buf => crypto.createHash('sha1').update(buf).digest('hex');

// Which rows of one id#version to keep and delete. rows are in PackageVersionKey order;
// keepGuids are the copies chosen (-keep) to settle conflicts.
function plan(rows, keepGuids = new Set()) {
  const chosen = rows.filter(r => keepGuids.has(r.GUID));
  if (chosen.length === 1) {
    return { keep: chosen, conflict: false };
  }
  const direct = rows.filter(r => !isSimplifier(r.GUID));
  if (direct.length === 0) {
    return { keep: [rows[0]], conflict: false };
  }
  if (new Set(direct.map(r => r.Hash)).size === 1) {
    return { keep: [direct[0]], conflict: false };
  }
  return { keep: direct, conflict: true };
}

function dedupe({ dbPath, mirrorPath, apply = false, verbose = false, keep = [], log = console.log }) {
  const keepGuids = new Set(keep);
  if (!fs.existsSync(dbPath)) {
    throw new Error(`No database at ${dbPath}`); // DatabaseSync would create an empty one
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 10000');
  const report = { groups: 0, deleted: [], conflicts: [], indexCreated: false, mirror: { checked: 0, ok: 0, rewritten: [], badContent: [] } };

  try {
    // 1. duplicate rows
    const groups = db.prepare('SELECT Id, Version FROM PackageVersions GROUP BY Id, Version HAVING COUNT(*) > 1').all();
    const rowsOf = db.prepare(`SELECT PackageVersionKey, GUID, Hash, DownloadCount FROM PackageVersions
                               WHERE Id = ? AND Version = ? ORDER BY PackageVersionKey`);
    const changes = [];
    for (const g of groups) {
      const rows = rowsOf.all(g.Id, g.Version);
      const { keep, conflict } = plan(rows, keepGuids);
      const del = rows.filter(r => !keep.includes(r));
      if (conflict) {
        report.conflicts.push({ id: g.Id, version: g.Version, kept: keep.map(r => r.GUID) });
      }
      if (del.length > 0) {
        changes.push({ id: g.Id, version: g.Version, keep: keep[0], del });
        for (const r of del) {
          report.deleted.push({ id: g.Id, version: g.Version, guid: r.GUID, keptGuid: keep[0].GUID });
        }
      }
    }
    report.groups = groups.length;
    const used = new Set(changes.flatMap(c => [c.keep.GUID]));
    for (const g of keepGuids) {
      if (!used.has(g)) {
        log(`-keep ${g}: not a copy of any duplicated id#version, so ignored`);
      }
    }
    const toDelete = new Set(changes.flatMap(c => c.del.map(r => r.PackageVersionKey)));
    const conflicted = new Set(report.conflicts.map(c => `${c.id}#${c.version}`));

    if (apply && changes.length > 0) {
      const delRelated = ['PackageFHIRVersions', 'PackageDependencies', 'PackageURLs']
        .map(t => db.prepare(`DELETE FROM ${t} WHERE PackageVersionKey = ?`));
      const delRow = db.prepare('DELETE FROM PackageVersions WHERE PackageVersionKey = ?');
      const addCount = db.prepare('UPDATE PackageVersions SET DownloadCount = DownloadCount + ? WHERE PackageVersionKey = ?');
      const latest = db.prepare(`SELECT PackageVersionKey, Canonical FROM PackageVersions
                                 WHERE Id = ? AND Version != 'current' ORDER BY PubDate DESC, Version DESC LIMIT 1`);
      const setCurrent = db.prepare('UPDATE Packages SET CurrentVersion = ?, Canonical = ? WHERE Id = ?');
      db.exec('BEGIN IMMEDIATE');
      try {
        const ids = new Set();
        for (const c of changes) {
          for (const r of c.del) {
            delRelated.forEach(s => s.run(r.PackageVersionKey));
            delRow.run(r.PackageVersionKey);
            addCount.run(r.DownloadCount || 0, c.keep.PackageVersionKey);
          }
          ids.add(c.id);
        }
        for (const id of ids) {
          const l = latest.get(id);
          if (l) {
            setCurrent.run(l.PackageVersionKey, l.Canonical, id);
          }
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }
    log(`${report.groups} id#versions stored more than once; ${report.deleted.length} rows ${apply ? 'deleted' : 'to delete'}; ${report.conflicts.length} conflicts left for manual cleanup`);
    for (const c of report.conflicts) {
      log(`  conflict: ${c.id}#${c.version} has different direct copies: ${c.kept.join(', ')}`);
    }

    // 2. unique index
    const remaining = db.prepare('SELECT COUNT(*) AS n FROM (SELECT 1 FROM PackageVersions GROUP BY Id, Version HAVING COUNT(*) > 1)').get().n;
    if (apply && remaining === 0) {
      db.exec(UNIQUE_INDEX);
      report.indexCreated = true;
      log('unique index on (Id, Version) created');
    } else if (remaining > 0) {
      log(`unique index on (Id, Version) not created: ${apply ? remaining : report.groups} id#versions still duplicated`);
    }

    // 3. mirror
    if (mirrorPath) {
      const content = db.prepare('SELECT Content FROM PackageVersions WHERE PackageVersionKey = ?');
      for (const row of db.prepare('SELECT PackageVersionKey, Id, Version, Hash FROM PackageVersions ORDER BY Id, Version').iterate()) {
        if (toDelete.has(row.PackageVersionKey)) {
          continue; // a dry run, and -apply would delete this row
        }
        if (conflicted.has(`${row.Id}#${row.Version}`)) {
          continue; // two rows share the file; left for manual cleanup
        }
        report.mirror.checked++;
        const file = path.join(mirrorPath, mirrorName(row.Id, row.Version));
        const actual = fs.existsSync(file) ? sha1(fs.readFileSync(file)) : null;
        if (actual === row.Hash) {
          report.mirror.ok++;
          continue;
        }
        const buf = Buffer.from(content.get(row.PackageVersionKey).Content);
        if (sha1(buf) !== row.Hash) {
          report.mirror.badContent.push(`${row.Id}#${row.Version}`);
          continue;
        }
        report.mirror.rewritten.push({ id: row.Id, version: row.Version, was: actual || 'missing', hash: row.Hash });
        if (apply) {
          const tmp = `${file}.tmp-${process.pid}`;
          fs.writeFileSync(tmp, buf);
          keepOwnership(tmp, fs.existsSync(file) ? file : mirrorPath);
          fs.renameSync(tmp, file);
        }
      }
      const missing = report.mirror.rewritten.filter(r => r.was === 'missing');
      const different = report.mirror.rewritten.filter(r => r.was !== 'missing');
      const will = apply ? 'was written' : 'will be written';
      log(`mirror ${mirrorPath}: ${report.mirror.checked} database rows checked against their mirror file`);
      log(`  ${report.mirror.ok} files match the database`);
      log(`  ${missing.length} files are missing from the mirror: the package is in the database, so the file ${will} from it`);
      if (missing.length > report.mirror.checked / 2) {
        log('    (most of the mirror is missing: check that -mirror is the folder the server\'s mirrorPath setting names)');
      }
      for (const r of verbose ? missing : missing.slice(0, 5)) {
        log(`    ${r.id}#${r.version}`);
      }
      if (!verbose && missing.length > 5) {
        log(`    ... and ${missing.length - 5} more (-verbose lists them all)`);
      }
      log(`  ${different.length} files differ from the database - these are the ones served with the wrong checksum; each ${will} from the database`);
      for (const r of different) {
        log(`    ${r.id}#${r.version}: file sha1 ${r.was}, database ${r.hash}`);
      }
      if (report.mirror.badContent.length > 0) {
        log(`  ${report.mirror.badContent.length} database rows whose content doesn't match their own hash - not touched:`);
        for (const b of report.mirror.badContent) {
          log(`    ${b}`);
        }
      }
    }
  } finally {
    db.close();
  }
  return report;
}

function main(argv) {
  const arg = name => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dbPath = arg('-db');
  const mirrorPath = arg('-mirror');
  if (!dbPath) {
    console.error('usage: node packages/utilities/dedupe-versions.js -db <packages.db> [-mirror <mirror folder>] [-apply] [-verbose] [-keep <GUID>]...');
    return 1;
  }
  const apply = argv.includes('-apply');
  const keep = argv.flatMap((a, i) => a === '-keep' && argv[i + 1] ? [argv[i + 1]] : []);
  if (!apply) {
    console.log('Dry run: nothing will be changed (use -apply)');
  }
  try {
    dedupe({ dbPath, mirrorPath, apply, keep, verbose: argv.includes('-verbose') });
  } catch (e) {
    console.error(e.message);
    return 1;
  }
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { dedupe, plan, isSimplifier, fixPrefix };
