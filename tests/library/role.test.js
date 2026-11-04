const { parseRole, applyRole } = require('../../library/role');

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
    expect(config.server.memory).toEqual({ rejectFraction: 0.8, group: true });
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
    expect(config.stats).toEqual({ intervalMinutes: 5, enabled: false });
    expect(config.npmAudit.enabled).toBe(false);
    expect(config.dailyReport.enabled).toBe(false);
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
});
