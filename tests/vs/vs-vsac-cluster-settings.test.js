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
  const follower = ({ exists = true } = {}) => {
    const provider = new VSACValueSetProvider({ apiKey: 'test', cluster: 'follower' }, {});
    let generation = 1;
    provider.database.getGeneration = async () => generation;
    provider.database.exists = async () => exists;
    return { provider, bump: () => { generation++; } };
  };

  test('the generation moving clears the recently used value sets and recounts', async () => {
    const { provider, bump } = follower();
    const recent = { clear: jest.fn() };
    provider._recentValueSets = () => recent;
    provider._recount = jest.fn(async () => {});
    await provider._followDatabase();
    expect(provider.loadedGeneration).toBe(1);
    bump();
    provider.generationCheckedAt = 0;
    await provider.catchUp();
    expect(recent.clear).toHaveBeenCalledTimes(2);
    expect(provider._recount).toHaveBeenCalledTimes(2);
    expect(provider.loadedGeneration).toBe(2);
    // nothing moved: nothing done
    provider.generationCheckedAt = 0;
    await provider.catchUp();
    expect(provider._recount).toHaveBeenCalledTimes(2);
  });

  test('before the master has made the database, nothing is read (which would create it)', async () => {
    const { provider } = follower({ exists: false });
    await provider.initialize();
    const read = jest.spyOn(provider.database, 'listAllValueSets');
    expect(await provider.fetchValueSet('http://cts.nlm.nih.gov/fhir/ValueSet/x', '')).toBeNull();
    expect(await provider.fetchValueSetById('x')).toBeNull();
    expect(await provider.listAllValueSets()).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    expect(provider.loadedGeneration).toBeNull();
  });
});
