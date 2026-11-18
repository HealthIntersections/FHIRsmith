const { parseRole, applyRole, bindAddress, connectAddress } = require('../../library/role');

const baseConfig = () => ({
  server: { port: 3000, memory: { rejectFraction: 0.8 } },
  stats: { intervalMinutes: 5 },
  modules: {
    tx: { enabled: true, instanceCode: 'm0', vsacCfg: { apiKey: 'k' }, closure: { enabled: true } },
    packages: { enabled: true },
    xig: { enabled: true },
    registry: { enabled: false }
  }
});

describe('parseRole', () => {
  test('no flags and no environment: no role', () => {
    expect(parseRole([], {})).toBeNull();
    // other arguments and an instance code in the environment don't make a role
    expect(parseRole(['--inspect', 'foo'], { FHIRSMITH_INSTANCE_CODE: 'tx1', PORT: '4000' })).toBeNull();
  });

  test('flags, in either form', () => {
    expect(parseRole(['--role=tx-worker', '--instance-code=tx1', '--port=20001'], {}))
      .toEqual({ role: 'tx-worker', instanceCode: 'tx1', port: 20001 });
    expect(parseRole(['--role', 'master', '--port', '20000'], {}))
      .toEqual({ role: 'master', instanceCode: null, port: 20000 });
  });

  test('the environment, with the flags winning', () => {
    expect(parseRole([], { FHIRSMITH_ROLE: 'tx-worker', FHIRSMITH_INSTANCE_CODE: 'tx2' }))
      .toEqual({ role: 'tx-worker', instanceCode: 'tx2', port: null });
    expect(parseRole(['--role=master', '--instance-code=a'], { FHIRSMITH_ROLE: 'tx-worker', FHIRSMITH_INSTANCE_CODE: 'b' }))
      .toEqual({ role: 'master', instanceCode: 'a', port: null });
  });

  test('mistakes are refused', () => {
    expect(() => parseRole(['--role=worker'], {})).toThrow(/Unknown role/);
    expect(() => parseRole(['--role=master', '--port=x'], {})).toThrow(/not a port/);
    expect(() => parseRole(['--port=3001'], {})).toThrow(/only used with --role/);
    expect(() => parseRole(['--instance-code=tx1'], {})).toThrow(/only used with --role/);
  });
});

describe('applyRole', () => {
  test('without a role, server.js never calls it: the configuration is untouched', () => {
    // what server.js does: applyRole only when parseRole returns a role
    const config = baseConfig();
    const before = JSON.stringify(config);
    const role = parseRole([], {});
    if (role) {
      applyRole(config, role);
    }
    expect(JSON.stringify(config)).toBe(before);
  });

  test('master: every module, the VSAC sync, the group memory measure', () => {
    const config = applyRole(baseConfig(), { role: 'master', instanceCode: null });
    expect(config.modules.tx.instanceCode).toBe('m0');
    expect(config.modules.tx.clusterRole).toBe('master');
    expect(config.modules.tx.vsacCfg).toEqual({ apiKey: 'k', cluster: 'leader' });
    expect(config.modules.packages.enabled).toBe(true);
    expect(config.modules.xig.enabled).toBe(true);
    expect(config.stats.enabled).toBeUndefined();
    expect(config.server.memory).toEqual({ rejectFraction: 0.8, group: true, trimAllocator: true });
  });

  test('tx-worker: the tx module only, no background jobs, its own instance code', () => {
    const config = applyRole(baseConfig(), { role: 'tx-worker', instanceCode: 'tx1' });
    expect(config.modules.tx.enabled).toBe(true);
    expect(config.modules.tx.instanceCode).toBe('tx1');
    expect(config.modules.tx.clusterRole).toBe('tx-worker');
    expect(config.modules.tx.vsacCfg.cluster).toBe('follower');
    expect(config.modules.packages.enabled).toBe(false);
    expect(config.modules.xig.enabled).toBe(false);
    expect(config.modules.registry.enabled).toBe(false);
    expect(config.stats).toEqual({ intervalMinutes: 5, sampleSeconds: 60, enabled: false });
    expect(config.npmAudit.enabled).toBe(false);
    expect(config.dailyReport.enabled).toBe(false);
  });

  test('with a role the graphs sample at most every minute, unless stats.sampleSeconds says otherwise', () => {
    const sample = stats => applyRole({ ...baseConfig(), stats }, { role: 'master', instanceCode: 'm0' }).stats.sampleSeconds;
    expect(sample(undefined)).toBe(60);
    expect(sample({ intervalMinutes: 5 })).toBe(60);
    expect(sample({ intervalMinutes: 0.5 })).toBe(30);
    expect(sample({ sampleSeconds: 300 })).toBe(300);
  });

  test('server.cluster.sharedCache reaches tx (with a role), and nothing is set when it is off', () => {
    const off = applyRole(baseConfig(), { role: 'tx-worker', instanceCode: 'tx1' });
    expect(off.modules.tx.sharedCache).toBeUndefined();
    expect(off.modules.tx.sharedCacheMaxBytes).toBeUndefined();
    const on = baseConfig();
    on.server.cluster = { sharedCache: true, sharedCacheMaxMB: 2 };
    applyRole(on, { role: 'master', instanceCode: null });
    expect(on.modules.tx.sharedCache).toBe(true);
    expect(on.modules.tx.sharedCacheMaxBytes).toBe(2 * 1024 * 1024);
    // not given (or null): 256 MB; 0: no cap
    const cap = (mb) => {
      const c = baseConfig();
      c.server.cluster = mb === undefined ? { sharedCache: true } : { sharedCache: true, sharedCacheMaxMB: mb };
      return applyRole(c, { role: 'master', instanceCode: null }).modules.tx.sharedCacheMaxBytes;
    };
    expect([cap(undefined), cap(null), cap(0)]).toEqual([256 * 1024 * 1024, 256 * 1024 * 1024, 0]);
    const bad = baseConfig();
    bad.server.cluster = { sharedCache: 'yes' };
    expect(() => applyRole(bad, { role: 'master', instanceCode: null })).toThrow(/true or false/);
    const badCap = baseConfig();
    badCap.server.cluster = { sharedCache: true, sharedCacheMaxMB: -1 };
    expect(() => applyRole(badCap, { role: 'master', instanceCode: null })).toThrow(/megabytes/);
  });

  test('server.cluster.sharedClosure reaches tx (with a role)', () => {
    const off = applyRole(baseConfig(), { role: 'tx-worker', instanceCode: 'tx1' });
    expect(off.modules.tx.sharedClosure).toBeUndefined();
    const on = baseConfig();
    on.server.cluster = { sharedClosure: true };
    applyRole(on, { role: 'tx-worker', instanceCode: 'tx1' });
    expect(on.modules.tx.sharedClosure).toBe(true);
    expect(on.modules.tx.sharedCache).toBeUndefined();
    const bad = baseConfig();
    bad.server.cluster = { sharedClosure: 1 };
    expect(() => applyRole(bad, { role: 'master', instanceCode: null })).toThrow(/true or false/);
  });

  test('a worker needs its own instance code, and tx must be enabled', () => {
    expect(() => applyRole(baseConfig(), { role: 'tx-worker', instanceCode: null })).toThrow(/its own instance code/);
    const noCode = baseConfig();
    delete noCode.modules.tx.instanceCode;
    expect(() => applyRole(noCode, { role: 'master', instanceCode: null })).toThrow(/needs an instance code/);
    const noTx = baseConfig();
    noTx.modules.tx.enabled = false;
    expect(() => applyRole(noTx, { role: 'master', instanceCode: 'm0' })).toThrow(/tx module enabled/);
  });

  test('instance codes must keep every cache-id a FHIR id (1-16 letters and digits)', () => {
    for (const bad of ['a'.repeat(17), 'tx.1', 'tx-1', 'tx 1']) {
      expect(() => applyRole(baseConfig(), { role: 'tx-worker', instanceCode: bad })).toThrow(/1-16 letters and digits/);
    }
    const longMaster = baseConfig();
    longMaster.modules.tx.instanceCode = 'm'.repeat(17);
    expect(() => applyRole(longMaster, { role: 'master', instanceCode: null })).toThrow(/1-16 letters and digits/);
    expect(applyRole(baseConfig(), { role: 'tx-worker', instanceCode: 'a'.repeat(16) }).modules.tx.instanceCode).toHaveLength(16);
  });

  test('with a role, trimAllocator is on unless the config says false', () => {
    const trim = (value) => {
      const c = baseConfig();
      if (value !== undefined) {
        c.server.memory.trimAllocator = value;
      }
      return applyRole(c, { role: 'tx-worker', instanceCode: 'tx1' }).server.memory;
    };
    expect(trim(undefined)).toEqual({ rejectFraction: 0.8, group: true, trimAllocator: true });
    expect([trim(null).trimAllocator, trim(false).trimAllocator, trim(true).trimAllocator]).toEqual([true, false, true]);
  });

  test('with a role, a process listens on loopback unless server.cluster.bindAddress says otherwise', () => {
    expect(bindAddress(baseConfig())).toBe('127.0.0.1');
    const config = (bind) => ({ ...baseConfig(), server: { cluster: { bindAddress: bind } } });
    expect(bindAddress(config(null))).toBe('127.0.0.1');
    expect(bindAddress(config('0.0.0.0'))).toBe('0.0.0.0');
    expect(bindAddress(config('10.0.0.11'))).toBe('10.0.0.11');
    // the launcher reaches every interface on loopback, a specific address at itself
    expect(['0.0.0.0', '::', '127.0.0.1', '10.0.0.11'].map(connectAddress)).toEqual(['127.0.0.1', '::1', '127.0.0.1', '10.0.0.11']);
    for (const bad of ['', 3001, true]) {
      expect(() => applyRole(config(bad), { role: 'master', instanceCode: null })).toThrow(/bindAddress must be an address/);
    }
    expect(() => applyRole(config('0.0.0.0'), { role: 'master', instanceCode: null })).not.toThrow();
  });
});
