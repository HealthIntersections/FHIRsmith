/**
 * cluster.js SIGKILLed: the master and worker it started see their IPC channel close and shut
 * down, freeing their ports, so a new launcher's processes start on them.
 */
const { startCluster, isUp, pidOn, sleep } = require('../utils/cluster-harness');

const FRONT = 20200;
const VSAC = 20209;

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('the launcher killed', () => {
  let cluster;

  afterAll(async () => {
    if (cluster) {
      await cluster.stop();
    }
  });

  test('its processes exit and free their ports; a new launcher starts on them', async () => {
    cluster = await startCluster({ front: FRONT, vsac: VSAC, workers: 1 });
    const ports = [cluster.master, ...cluster.workers];
    const pids = ports.map(pidOn);
    expect(pids.every(Boolean)).toBe(true);

    cluster.launcher.kill('SIGKILL');
    await cluster.exited;
    const t0 = Date.now();
    while ((pids.some(alive) || (await Promise.all(ports.map(isUp))).some(Boolean)) && Date.now() - t0 < 10000) {
      await sleep(100);
    }
    expect(pids.filter(alive)).toEqual([]);
    for (const port of ports) {
      expect(await isUp(port)).toBe(false);
    }

    // the next launcher's processes take the ports, none crash-looping on EADDRINUSE
    await cluster.restart();
    const again = ports.map(pidOn);
    expect(again.every(Boolean)).toBe(true);
    expect(again.some(pid => pids.includes(pid))).toBe(false);
  }, 400000);
});
