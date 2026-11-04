const fs = require('fs');
const os = require('os');
const path = require('path');
const { VSACValueSetProvider } = require('../../tx/vs/vs-vsac');

describe('VSAC database settings follow the cluster role', () => {
  test.each(['leader', 'follower'])('%s opens a fresh database with WAL and a busy timeout', async cluster => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsac-role-'));
    const provider = new VSACValueSetProvider({ apiKey: 'test', cluster }, {});
    // No sync or external service: exercise the connection constructed by the provider,
    // using an empty database unique to this test. A previously WAL-enabled file could
    // otherwise hide a missing shared option in the constructor.
    provider.database.dbPath = path.join(dir, 'vsac.db');
    try {
      await provider.database.create();
      const db = await provider.database._getWriteConnection();
      const get = sql => new Promise((resolve, reject) => {
        db.get(sql, (error, row) => error ? reject(error) : resolve(row));
      });
      expect(await get('PRAGMA journal_mode')).toEqual({ journal_mode: 'wal' });
      expect(await get('PRAGMA busy_timeout')).toEqual({ timeout: 5000 });
      expect(provider.database.shared).toBe(true);
    } finally {
      await provider.database.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
