//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * Loading a package's resources into the endpoint: requested from the administration page
 * (rest/admin.js) or by initialSettings.loadPackages when the database is made, queued in
 * PackageLoads, and run by the queue runner (queue/runner.js: the jobs process, or the master
 * without one), one at a time, in the background.
 *
 * Each resource goes to its Type/id. Where there's a different resource at that id already,
 * it gets a new id (as if POSTed), and the references to it in the package's other resources
 * are changed to match: every 'reference' element that is Type/old-id (or Type/old-id/_history/n)
 * becomes Type/new-id. A resource the same as the one already there (apart from its meta) is
 * left alone, so loading a package again changes nothing. A resource with no id gets one.
 *
 * Loading is administrative: the endpoint isn't expected to be in use, so the ids are worked
 * out at the start. References aren't checked (a package refers to others), and a resource
 * that can't be stored is reported without stopping the rest.
 *
 * @module rest/packages
 */

const fs = require('fs');
const path = require('path');
const fhirJson = require('../library/fhir-json');
const { ID_RE } = require('./store');

const QUEUED = 0;
const RUNNING = 1;
const DONE = 2;
const FAILED = 3;
const STATUS_NAMES = ['queued', 'loading', 'loaded', 'failed'];

// resources stored in one transaction
const BATCH = 50;
// the most renamed resources and errors kept in a load's report
const REPORT_MAX = 500;

class PackageLoader {
  /**
   * @param {Object} ep - the Endpoint
   */
  constructor(ep) {
    this.ep = ep;
    this.running = null;
  }

  /**
   * A package to load: 'id', 'id#version', or { package, version, examples }.
   * @returns {{package: string, version: string|null, examples: boolean}}
   */
  static parse(spec) {
    let p;
    if (typeof spec === 'string') {
      const [id, version] = spec.trim().split('#');
      p = { package: id, version: version || null, examples: false };
    } else if (spec && typeof spec === 'object') {
      p = { package: String(spec.package || spec.id || '').trim(), version: spec.version ? String(spec.version).trim() : null, examples: !!spec.examples };
    } else {
      throw new Error(`'${spec}' is not a package (id, id#version, or {package, version, examples})`);
    }
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(p.package) || p.package.length > 128) {
      throw new Error(`'${p.package}' is not a package id`);
    }
    if (p.version && (p.version.length > 64 || /\s/.test(p.version))) {
      throw new Error(`'${p.version}' is not a package version`);
    }
    return p;
  }

  /**
   * Queue a package to load.
   * @param {Object} q - in a write transaction
   * @param {Object} p - from parse()
   * @param {string|null} by - who asked
   */
  static async queue(q, p, by) {
    await q.run('INSERT INTO PackageLoads (Package, Version, Examples, Status, Requested, RequestedBy) VALUES (?, ?, ?, ?, ?, ?)',
      [p.package, p.version, p.examples ? 1 : 0, QUEUED, Date.now(), by ? String(by).substring(0, 128) : null]);
  }

  /** When the queue runner starts: a load that was running when it stopped didn't finish */
  async recover() {
    await this.ep.db.write(q => q.run('UPDATE PackageLoads SET Status = ?, Finished = ?, Message = ? WHERE Status = ?',
      [FAILED, Date.now(), 'The server stopped while it was loading (loading it again is safe: what was loaded already is left alone)', RUNNING]));
  }

  /**
   * The queue runner's job: run the next queued load, if none is running.
   * @returns {Promise<boolean>} whether one was run
   */
  async runQueued() {
    if (this.running) {
      return false;
    }
    const row = await this.ep.db.read(q => q.get(`SELECT LoadKey, Package, Version, Examples FROM PackageLoads WHERE Status = ${QUEUED} ORDER BY LoadKey LIMIT 1`));
    if (!row) {
      return false;
    }
    this.running = this.run(row).finally(() => {
      this.running = null;
    });
    await this.running;
    return true;
  }

  async run(row) {
    const ep = this.ep;
    const key = Number(row.LoadKey);
    const started = Date.now();
    await ep.db.write(q => q.run('UPDATE PackageLoads SET Status = ?, Started = ? WHERE LoadKey = ?', [RUNNING, started, key]));
    const label = row.Package + (row.Version ? '#' + row.Version : '');
    ep.log.info(`Rest ${ep.path}: loading the package ${label}`);
    let report;
    try {
      report = await this.load(key, { package: row.Package, version: row.Version, examples: !!Number(row.Examples) });
    } catch (e) {
      ep.log.warn(`Rest ${ep.path}: loading the package ${label} failed: ${e.message}`);
      await ep.db.write(q => q.run('UPDATE PackageLoads SET Status = ?, Finished = ?, Message = ? WHERE LoadKey = ?',
        [FAILED, Date.now(), String(e.message).substring(0, 2000), key]));
      return;
    }
    const c = report.counts;
    const summary = `${c.created} created, ${c.renamed} given new ids, ${c.unchanged} unchanged, ${c.skipped} skipped, ${c.failed} failed`;
    ep.log.info(`Rest ${ep.path}: loaded the package ${report.package}#${report.version}: ${summary} (${Date.now() - started}ms)`);
    await ep.db.write(q => q.run('UPDATE PackageLoads SET Status = ?, Finished = ?, Version = ?, Message = ?, Report = ? WHERE LoadKey = ?',
      [DONE, Date.now(), report.version, summary, JSON.stringify(report), key]));
  }

  /**
   * Load a package.
   * @param {number|null} key - the PackageLoads row, for progress (null: none)
   * @param {Object} p - from parse()
   * @returns {Promise<Object>} the report
   */
  async load(key, p) {
    const ep = this.ep;
    const folder = await this.fetch(p);
    const manifest = readJson(path.join(folder, 'package.json'));
    const version = manifest && manifest.version ? String(manifest.version) : p.version;
    this.checkFhirVersion(p.package, manifest);

    // the files: the package's own folder, and its examples if asked for
    const files = jsonFiles(folder);
    if (p.examples) {
      files.push(...jsonFiles(path.join(folder, 'example')));
    }

    const report = { package: p.package, version, examples: p.examples,
      counts: { created: 0, renamed: 0, unchanged: 0, skipped: 0, failed: 0 }, skippedTypes: {}, renamed: [], errors: [] };
    const fail = (file, message) => {
      report.counts.failed++;
      if (report.errors.length < REPORT_MAX) {
        report.errors.push({ file: path.relative(folder, file), message });
      }
    };

    // 1. what each resource is, and what is there already
    const plan = [];
    const seen = new Set();
    for (const file of files) {
      const r = readJson(file);
      if (!r || typeof r.resourceType !== 'string') {
        continue;
      }
      const type = r.resourceType;
      if (!ep.typeKeys.has(type) || !ep.typeSupported(type)) {
        report.counts.skipped++;
        report.skippedTypes[type] = (report.skippedTypes[type] || 0) + 1;
        continue;
      }
      if (r.id !== undefined && (typeof r.id !== 'string' || !ID_RE.test(r.id))) {
        fail(file, `'${r.id}' is not a valid id`);
        continue;
      }
      if (r.id && seen.has(type + '/' + r.id)) {
        fail(file, `${type}/${r.id} is in the package more than once`);
        continue;
      }
      if (r.id) {
        seen.add(type + '/' + r.id);
      }
      plan.push({ file, type, id: r.id || null });
    }
    await this.progress(key, 0, plan.length);

    // what each one does: stored at its id, the same as what's there (left alone), or given
    // a new id. A resource is compared with its references to the renamed changed, and each
    // rename can change what others compare with, so it goes round until nothing changes.
    // Renamed in an earlier load of the package, and the same as what was stored then: that
    // one is used again
    const prior = await this.priorRenames(p.package);
    const renames = new Map();
    const PENDING = '~new';
    for (const item of plan) {
      // a resource with no id is known by its file
      item.key = item.id ? item.type + '/' + item.id : item.type + '/~' + path.relative(folder, item.file);
      if (prior.has(item.key)) {
        item.prior = prior.get(item.key);
        renames.set(item.key, item.prior);
      }
    }
    const decide = async (q, item) => {
      const pkg = readJson(item.file);
      rewriteReferences(pkg, renames, PENDING);
      if (item.prior) {
        const c = await ep.store.current(q, item.type, item.prior);
        if (c && !c.deleted && sameContent(c.resource, { ...pkg, id: item.prior })) {
          return { action: 'unchanged', to: item.prior };
        }
      }
      if (!item.id) {
        return { action: 'new', to: null };
      }
      const cur = await ep.store.current(q, item.type, item.id);
      if (!cur || cur.deleted) {
        return { action: 'put', to: undefined };
      }
      if (sameContent(cur.resource, pkg)) {
        return { action: 'unchanged', to: undefined };
      }
      return { action: 'rename', to: null };
    };
    let changed = true;
    for (let round = 0; changed && round < 20; round++) {
      changed = false;
      await ep.db.read(async (q) => {
        for (const item of plan) {
          const d = await decide(q, item);
          item.action = d.action;
          const was = renames.has(item.key) ? renames.get(item.key) : undefined;
          if (d.to !== was) {
            if (d.to === undefined) {
              renames.delete(item.key);
            } else {
              renames.set(item.key, d.to);
            }
            changed = true;
          }
        }
      });
    }
    // new ids, as a POST would get them
    const needIds = plan.filter(i => i.action === 'rename' || i.action === 'new');
    for (let i = 0; i < needIds.length; i += 200) {
      await ep.db.write(async (q) => {
        for (const item of needIds.slice(i, i + 200)) {
          item.reservation = await ep.store.reserve(q, item.type, null);
          renames.set(item.key, item.reservation.id);
        }
      });
    }

    // 2. store them, with references to the renamed changed to match
    const userId = 'package:' + p.package;
    const store = async (q, item) => {
      const resource = readJson(item.file);
      rewriteReferences(resource, renames);
      if (item.reservation) {
        delete resource.id;
      }
      await ep.store.put(q, { type: item.type, id: item.reservation ? null : item.id, resource, ifMatch: null, createOnUpdate: true,
        userId, deferChecks: true, reservation: item.reservation || null });
    };
    const toStore = plan.filter(i => i.action !== 'unchanged');
    report.counts.unchanged = plan.length - toStore.length;
    let done = report.counts.unchanged;
    for (let i = 0; i < toStore.length; i += BATCH) {
      const batch = toStore.slice(i, i + BATCH);
      try {
        await ep.db.write(async (q) => {
          for (const item of batch) {
            await store(q, item);
          }
        });
        batch.forEach(item => {
          item.stored = true;
        });
      } catch (e) {
        // one at a time, to find the one(s) that can't be stored
        for (const item of batch) {
          try {
            await ep.db.write(q => store(q, item));
            item.stored = true;
          } catch (e2) {
            fail(item.file, e2.message);
          }
        }
      }
      done += batch.length;
      await this.progress(key, done, plan.length);
    }
    for (const item of toStore.filter(x => x.stored)) {
      if (item.action === 'rename') {
        report.counts.renamed++;
        if (report.renamed.length < REPORT_MAX) {
          report.renamed.push({ from: `${item.type}/${item.id}`, to: `${item.type}/${item.reservation.id}` });
        }
      } else {
        report.counts.created++;
      }
    }
    // all the renames in force (for loading the package again), in full
    report.renames = [...renames.entries()].filter(([, to]) => to);
    // the ids reserved for resources that couldn't be stored
    const unused = needIds.filter(x => !x.stored).map(x => x.reservation.resourceKey);
    for (let i = 0; i < unused.length; i += 500) {
      const c = unused.slice(i, i + 500);
      await ep.db.write(q => q.run(`DELETE FROM Ids WHERE ResourceKey IN (${c.map(() => '?').join(', ')}) AND MostRecent IS NULL`, c));
    }
    return report;
  }

  /** Type/id -> the id it was stored as, in earlier loads of the package */
  async priorRenames(pkg) {
    const out = new Map();
    const rows = await this.ep.db.read(q => q.all('SELECT Report FROM PackageLoads WHERE Package = ? AND Status = ? AND Report IS NOT NULL ORDER BY LoadKey', [pkg, DONE]));
    for (const r of rows) {
      try {
        for (const [from, to] of JSON.parse(r.Report).renames || []) {
          out.set(from, to);
        }
      } catch (e) {
        // a report that can't be read: nothing from it
      }
    }
    return out;
  }

  async fetch(p) {
    const pm = this.ep.options.packageManager;
    if (!pm) {
      throw new Error('This server has no package manager to fetch packages with');
    }
    const name = await pm.fetch(p.package, p.version || undefined);
    const folder = path.isAbsolute(name) ? name : path.join(pm.cacheFolder, name);
    const pkg = fs.existsSync(path.join(folder, 'package')) ? path.join(folder, 'package') : folder;
    if (!fs.existsSync(path.join(pkg, 'package.json'))) {
      throw new Error(`The package ${p.package}${p.version ? '#' + p.version : ''} has no package.json`);
    }
    return pkg;
  }

  /** A package for another version of FHIR isn't loaded */
  checkFhirVersion(id, manifest) {
    const mine = majorMinor(this.ep.settings.fhirVersion);
    const theirs = manifest && Array.isArray(manifest.fhirVersions) ? manifest.fhirVersions : [];
    if (theirs.length && !theirs.some(v => majorMinor(v) === mine)) {
      throw new Error(`The package ${id} is for FHIR ${theirs.join(', ')}, and this endpoint is FHIR ${this.ep.settings.fhirVersion}`);
    }
  }

  async progress(key, done, total) {
    if (key) {
      await this.ep.db.write(q => q.run('UPDATE PackageLoads SET Message = ? WHERE LoadKey = ?', [`${done} of ${total} resources`, key]));
    }
  }
}

/**
 * Change the references to renamed resources: every 'reference' element anywhere in the
 * resource that is Type/old-id, or Type/old-id/_history/n, becomes Type/new-id.
 * @param {Object} node
 * @param {Map<string, string|null>} renames - Type/old-id -> new-id (null: not known yet)
 * @param {string|null} [pending] - what a rename not known yet becomes (comparing)
 */
function rewriteReferences(node, renames, pending = null) {
  if (!renames.size || node === null || typeof node !== 'object') {
    return;
  }
  if (Array.isArray(node)) {
    node.forEach(n => rewriteReferences(n, renames, pending));
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === 'reference' && typeof v === 'string') {
      const parts = v.split('/');
      if ((parts.length === 2 || (parts.length === 4 && parts[2] === '_history'))) {
        const k2 = parts[0] + '/' + parts[1];
        // (a rename whose new id isn't known yet, when comparing: pending)
        const to = renames.has(k2) ? renames.get(k2) || pending : null;
        if (to) {
          node[k] = parts[0] + '/' + to;
        }
      }
    } else if (v && typeof v === 'object') {
      rewriteReferences(v, renames, pending);
    }
  }
}

/** Whether two resources are the same, apart from their meta */
function sameContent(a, b) {
  if (!a || !b) {
    return false;
  }
  const strip = (r) => {
    const x = { ...r };
    delete x.meta;
    return x;
  };
  return canonicalJson(strip(a)) === canonicalJson(strip(b));
}

function canonicalJson(v) {
  if (Array.isArray(v)) {
    return '[' + v.map(canonicalJson).join(',') + ']';
  }
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

function jsonFiles(folder) {
  if (!fs.existsSync(folder)) {
    return [];
  }
  return fs.readdirSync(folder)
    .filter(f => f.endsWith('.json') && !f.startsWith('.') && f !== 'package.json')
    .sort()
    .map(f => path.join(folder, f))
    .filter(f => fs.statSync(f).isFile());
}

function readJson(file) {
  try {
    return fhirJson.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}

function majorMinor(v) {
  return String(v || '').split('.').slice(0, 2).join('.');
}

module.exports = { PackageLoader, rewriteReferences, sameContent, QUEUED, RUNNING, DONE, FAILED, STATUS_NAMES };
