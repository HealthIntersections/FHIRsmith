//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * Maintenance: an endpoint's database wiped, and made again as config.json sets it up for a
 * new database (initialSettings, with its loadPackages, and types). While it happens, every
 * request to the endpoint is answered 503, 'under maintenance' (but the reset page itself:
 * rest/admin.js).
 *
 * What is happening is a row in the Maintenance table (database/schema.js), which a reset
 * doesn't drop, so every process sees it while the rest of the database is gone. Each process
 * looks at it at most every CHECK_MS. The process that runs the jobs (queue/runner.js) does
 * the work, as a task of its own (the other tasks do nothing while it goes):
 *
 *   requested   asked for (the reset page). Then:
 *   wiping      waiting GRACE_MS for the requests that started before to finish, and for the
 *               background work running now; then every table but Maintenance is dropped, the
 *               schema made again, and the database set up as a new one (the master's work
 *               when an endpoint starts on a new database: Endpoint.setup), which queues
 *               initialSettings.loadPackages
 *   loading     the packages being loaded, one after another; when they are all done (loaded
 *               or failed: the Packages page says which), the row is deleted, and maintenance
 *               is over
 *   failed      the reset itself went wrong (Message says how): the endpoint stays under
 *               maintenance until it is tried again, or ended, from the reset page
 *
 * A jobs process that stops part way carries on when it starts again, from where the row says:
 * wiping starts the wipe again. Every process notices a reset by the database's new epoch
 * (Config: 'epoch', made with the database), and reloads everything it keeps (settings,
 * definitions, the keys it has cached) before it does anything else with the database.
 *
 * @module rest/maintenance
 */

const { MAINTENANCE_TABLE, dropTables, migrate } = require('./database/schema');

const CHECK_MS = 500;
// how long the requests that started before the reset have to finish
const GRACE_MS = 3000;
const STATES = ['requested', 'wiping', 'loading', 'failed'];

class Maintenance {
  /**
   * @param {Object} ep - the Endpoint
   * @param {Object} [options]
   * @param {number} [options.graceMs] - how long running requests are given (tests: less)
   */
  constructor(ep, options = {}) {
    this.ep = ep;
    this.graceMs = options.graceMs === undefined ? GRACE_MS : options.graceMs;
    this.checkedAt = 0;
    this.row = null;
  }

  /**
   * The maintenance under way, or null: { state, started, startedBy, updated, message }, as
   * last read (at most CHECK_MS ago, unless fresh)
   * @param {boolean} [fresh] - read it now
   */
  async current(fresh) {
    const now = Date.now();
    if (fresh || now - this.checkedAt >= CHECK_MS) {
      this.checkedAt = now;
      this.row = await this.ep.db.read(q => read(q));
    }
    return this.row;
  }

  /** Whether the endpoint is under maintenance (as last read) */
  async active() {
    return !!(await this.current());
  }

  /**
   * Ask for a reset (the reset page): refused if one is under way, unless it failed (try again)
   * @param {string|null} by
   */
  async request(by) {
    const done = await this.ep.db.write(async (q) => {
      const row = await read(q);
      if (row && row.state !== 'failed') {
        return false;
      }
      const now = Date.now();
      if (row) {
        await q.run('UPDATE Maintenance SET State = ?, Started = ?, StartedBy = ?, Updated = ?, Message = ? WHERE Id = 1',
          ['requested', now, by, now, 'Waiting for the background jobs to start the reset']);
      } else {
        await q.run('INSERT INTO Maintenance (Id, State, Started, StartedBy, Updated, Message) VALUES (1, ?, ?, ?, ?, ?)',
          ['requested', now, by, now, 'Waiting for the background jobs to start the reset']);
      }
      return true;
    });
    this.checkedAt = 0;
    if (done) {
      this.ep.log.warn(`Rest ${this.ep.path}: a reset of the database was asked for${by ? ' by ' + by : ''}: the endpoint is under maintenance`);
    }
    return done;
  }

  /**
   * End maintenance that failed (the reset page), leaving the database as it is
   * @param {string|null} by
   */
  async end(by) {
    const done = await this.ep.db.write(async (q) => {
      const row = await read(q);
      if (!row || row.state !== 'failed') {
        return false;
      }
      await q.run('DELETE FROM Maintenance WHERE Id = 1');
      return true;
    });
    this.checkedAt = 0;
    if (done) {
      this.ep.log.warn(`Rest ${this.ep.path}: maintenance ended${by ? ' by ' + by : ''}, after the reset failed: the database is as the reset left it`);
    }
    return done;
  }

  async update(state, message) {
    await this.ep.db.write(q => q.run('UPDATE Maintenance SET State = ?, Updated = ?, Message = ? WHERE Id = 1', [state, Date.now(), message]));
    this.checkedAt = 0;
  }

  /**
   * The jobs process's task: do what the row says is next
   * @param {function(): Promise<void>} idle - waits for the queue runner's other tasks to finish
   */
  async run(idle) {
    const row = await this.current(true);
    if (!row) {
      return;
    }
    if (row.state === 'requested' || row.state === 'wiping') {
      await this.wipe(idle);
    } else if (row.state === 'loading') {
      await this.load();
    }
  }

  async wipe(idle) {
    const ep = this.ep;
    try {
      await this.update('wiping', 'Waiting for the requests and background work under way to finish');
      await new Promise(resolve => setTimeout(resolve, this.graceMs));
      await idle();
      await this.update('wiping', 'Dropping the tables');
      const dropped = await dropTables(ep.db, [MAINTENANCE_TABLE.name]);
      if (ep.db.vacuum) {
        // (SQLite) the space the tables took, back to the file system
        try {
          await ep.db.vacuum();
        } catch (e) {
          ep.log.warn(`Rest ${ep.path}: VACUUM after the reset failed (the file keeps its size): ${e.message}`);
        }
      }
      ep.log.warn(`Rest ${ep.path}: reset: ${dropped} tables dropped; making the database again`);
      await migrate(ep.db, (m) => ep.log.info(`Rest ${ep.path}: ${m}`));
      // set up as a new database: settings, types, search parameters, the packages to load
      await ep.setup({ fresh: true });
      const queued = await ep.db.read(q => q.get('SELECT COUNT(*) AS N FROM PackageLoads'));
      const n = Number(queued.N);
      await this.update('loading', n ? `Loading ${n} package${n === 1 ? '' : 's'}` : 'Finishing');
      ep.log.info(`Rest ${ep.path}: reset: the database is made again; ${n} package(s) to load`);
    } catch (e) {
      ep.log.error(`Rest ${ep.path}: the reset failed: ${e.stack || e.message}`);
      try {
        await this.update('failed', `The reset failed: ${e.message}`);
      } catch (e2) {
        ep.log.error(`Rest ${ep.path}: recording that the reset failed failed too: ${e2.message}`);
      }
    }
  }

  async load() {
    const ep = this.ep;
    if (!ep.ready) {
      // a jobs process that started while the database was being made again
      await ep.setup({});
    }
    const counts = await ep.db.read(q => q.all('SELECT Status, COUNT(*) AS N FROM PackageLoads GROUP BY Status'));
    const by = new Map(counts.map(c => [Number(c.Status), Number(c.N)]));
    const waiting = (by.get(0) || 0) + (by.get(1) || 0);
    if (waiting) {
      const total = [...by.values()].reduce((a, b) => a + b, 0);
      await this.update('loading', `Loading packages: ${total - waiting} of ${total} done`);
      await ep.packages.runQueued();
      return;
    }
    await ep.db.write(q => q.run('DELETE FROM Maintenance WHERE Id = 1'));
    this.checkedAt = 0;
    ep.log.warn(`Rest ${ep.path}: reset finished: ${by.get(2) || 0} package(s) loaded, ${by.get(3) || 0} failed; the endpoint is no longer under maintenance`);
  }
}

/** The row, or null */
async function read(q) {
  const r = await q.get('SELECT State, Started, StartedBy, Updated, Message FROM Maintenance WHERE Id = 1');
  if (!r) {
    return null;
  }
  return { state: STATES.includes(r.State) ? r.State : 'failed', started: Number(r.Started), startedBy: r.StartedBy || null,
    updated: r.Updated ? Number(r.Updated) : null, message: r.Message || '' };
}

module.exports = { Maintenance, CHECK_MS, GRACE_MS };
