//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * What a queued job keeps: its request, its result, and (bulk export, later) its output
 * files, by job and name. Behind this interface so that where they go can change (a folder,
 * S3) without changing the jobs; for now they go in the endpoint's database (JobFiles), in
 * pieces, so that no one value is bigger than MySQL's max_allowed_packet, and every process,
 * on any machine, can read them.
 *
 *   put(jobKey, name, data)   store (replacing what was there)
 *   get(jobKey, name)         a Buffer, or null
 *   remove(jobKey)            everything the job kept
 *
 * @module rest/queue/files
 */

// a piece: well inside MySQL's default max_allowed_packet (64 MB), and SQLite's limits
const PIECE = 1024 * 1024;

class DatabaseJobFiles {
  /**
   * @param {Object} db - the endpoint's database
   */
  constructor(db) {
    this.db = db;
  }

  /**
   * @param {number} jobKey
   * @param {string} name
   * @param {Buffer|string} data
   */
  async put(jobKey, name, data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    await this.db.write(async (q) => {
      await q.run('DELETE FROM JobFiles WHERE JobKey = ? AND Name = ?', [jobKey, name]);
      for (let seq = 0, at = 0; at < buf.length || seq === 0; seq++, at += PIECE) {
        await q.run('INSERT INTO JobFiles (JobKey, Name, Seq, Data) VALUES (?, ?, ?, ?)', [jobKey, name, seq, buf.subarray(at, at + PIECE)]);
      }
    });
  }

  /**
   * @param {number} jobKey
   * @param {string} name
   * @returns {Promise<Buffer|null>}
   */
  async get(jobKey, name) {
    const rows = await this.db.read(q => q.all('SELECT Data FROM JobFiles WHERE JobKey = ? AND Name = ? ORDER BY Seq', [jobKey, name]));
    if (!rows.length) {
      return null;
    }
    return Buffer.concat(rows.map(r => (Buffer.isBuffer(r.Data) ? r.Data : Buffer.from(r.Data || []))));
  }

  /** @param {number} jobKey */
  async remove(jobKey) {
    await this.db.write(q => q.run('DELETE FROM JobFiles WHERE JobKey = ?', [jobKey]));
  }
}

module.exports = { DatabaseJobFiles, PIECE };
