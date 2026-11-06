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

describe('a follower catching up with the master\'s sync', () => {
  const follower = (extra = {}) => {
    const provider = new VSACValueSetProvider({ apiKey: 'test', cluster: 'follower' }, {});
    let generation = 1;
    provider.database.getGeneration = async () => generation;
    provider.database.exists = async () => true;
    Object.assign(provider, extra);
    return { provider, bump: () => { generation++; } };
  };

  test('with the whole list in memory (main), the generation moving reloads it', async () => {
    // (_recount and _recentValueSets are #333's: absent here even once it is in)
    const { provider, bump } = follower({ _recount: undefined, _recentValueSets: undefined });
    provider._reloadMap = jest.fn(async () => {});
    await provider._followDatabase();
    expect(provider.loadedGeneration).toBe(1);
    expect(provider._reloadMap).toHaveBeenCalledTimes(1);
    bump();
    provider.generationCheckedAt = 0;
    await provider.catchUp();
    expect(provider._reloadMap).toHaveBeenCalledTimes(2);
    expect(provider.loadedGeneration).toBe(2);
    // nothing moved: nothing loaded
    provider.generationCheckedAt = 0;
    await provider.catchUp();
    expect(provider._reloadMap).toHaveBeenCalledTimes(2);
  });

  test('with value sets read on demand (#333), it clears the recently used ones and recounts', async () => {
    const recent = { clear: jest.fn() };
    const { provider, bump } = follower({
      _recentValueSets: () => recent,
      _recount: jest.fn(async () => {}),
      _reloadMap: jest.fn(async () => {})
    });
    await provider._followDatabase();
    bump();
    provider.generationCheckedAt = 0;
    await provider.catchUp();
    expect(recent.clear).toHaveBeenCalledTimes(2);
    expect(provider._recount).toHaveBeenCalledTimes(2);
    expect(provider._reloadMap).not.toHaveBeenCalled();
    expect(provider.loadedGeneration).toBe(2);
  });
});
