/**
 * The caches page across the cluster (library/cluster-caches.js): the process a request reaches
 * asks the launcher, the launcher asks every process that is ready, and hands their answers back
 */
const { EventEmitter } = require('events');
const { connectCaches, CacheFanout, ASK, RUN, DONE, ALL } = require('../../library/cluster-caches');
const { buildCachesPage } = require('../../tx/tx-caches');

// a child process's IPC channel, both ends: what the child sends reaches the launcher's
// handler, and what the launcher sends reaches the child
function pair(onLauncher) {
  const child = new EventEmitter(); // the process's `process`
  const handle = new EventEmitter(); // the launcher's ChildProcess
  child.connected = true;
  handle.connected = true;
  child.send = (m) => setImmediate(() => onLauncher(m));
  handle.send = (m) => setImmediate(() => child.emit('message', m));
  return { child, handle };
}

function cluster(locals, { readyMask = null, timeoutMs = 1000 } = {}) {
  const procs = [];
  const fanout = new CacheFanout(procs, { timeoutMs });
  const sides = locals.map((local, i) => {
    const proc = { code: i === 0 ? 'm0' : `tx${i}`, name: i === 0 ? 'master' : `worker tx${i}`, role: i === 0 ? 'master' : 'tx-worker',
      ready: readyMask ? readyMask[i] : true };
    const { child, handle } = pair(m => {
      if (m.type === ASK) {
        fanout.ask(proc, m);
      } else if (m.type === DONE) {
        fanout.done(proc, m);
      }
    });
    proc.child = handle;
    procs.push(proc);
    return connectCaches(local, child, { cluster: true, timeoutMs });
  });
  return { procs, sides };
}

const report = (n) => async (action) => ({ process: `p${n}`, action, report: [{ kind: 'cache', name: 'Expansion cache', scope: '/r4', entries: n, clearable: true }],
  cleared: action === 'report' ? null : [{ name: 'Expansion cache', scope: '/r4', kind: 'cache', entries: n }], memory: { rss: 1, heapUsed: 1, heapTotal: 1, external: 1, before: action === 'report' ? null : 2 } });

describe('cluster caches', () => {
  test('every process that is ready answers, whichever process asked; the master first', async () => {
    const { sides } = cluster([report(1), report(2), report(3)]);
    const answer = await sides[2].ask('report');
    expect(answer.cluster).toBe(true);
    expect(answer.results.map(r => [r.code, r.result.process])).toEqual([['m0', 'p1'], ['tx1', 'p2'], ['tx2', 'p3']]);
  });

  test('an action runs in every process', async () => {
    const seen = [];
    const local = (n) => async (action) => { seen.push([n, action]); return report(n)(action); };
    const { sides } = cluster([local(1), local(2)]);
    const answer = await sides[0].ask('unload-all');
    expect(seen.sort()).toEqual([[1, 'unload-all'], [2, 'unload-all']]);
    expect(answer.results.every(r => r.result.cleared.length === 1)).toBe(true);
  });

  test('a process that is not ready is reported as not running; one that does not answer, as not answering', async () => {
    const never = () => new Promise(() => {});
    const { sides } = cluster([report(1), never, report(3)], { readyMask: [true, true, false], timeoutMs: 100 });
    const answer = await sides[0].ask('report');
    expect(answer.results.map(r => [r.code, r.error || r.result.process])).toEqual([['m0', 'p1'], ['tx1', 'no answer in 0 s'], ['tx2', 'not running']]);
  });

  test('a process that fails says why', async () => {
    const { sides } = cluster([report(1), async () => { throw new Error('broken'); }]);
    const answer = await sides[0].ask('report');
    expect(answer.results[1].error).toBe('broken');
  });

  test('without the launcher: this process only', async () => {
    const side = connectCaches(report(7), { send: undefined }, { cluster: true });
    const answer = await side.ask('report');
    expect(answer.cluster).toBe(false);
    expect(answer.results.map(r => r.result.process)).toEqual(['p7']);
    // nor with a channel that has no launcher behind it (no role: a jest worker's IPC)
    const notCluster = connectCaches(report(8), { send: () => { throw new Error('should not be used'); }, on: () => {} }, { cluster: false });
    expect((await notCluster.ask('report')).results[0].result.process).toBe('p8');
  });

  test('a launcher that never answers: this process only, said so', async () => {
    const channel = new EventEmitter();
    channel.send = () => {};
    const side = connectCaches(report(5), channel, { cluster: true, timeoutMs: 50, marginMs: 50 });
    const answer = await side.ask('report');
    expect(answer.cluster).toBe(false);
    expect(answer.note).toMatch(/launcher did not answer/);
    side.disconnect();
  });

  test('a RUN message is answered on the channel; an unknown action is ignored', async () => {
    const channel = new EventEmitter();
    const sent = [];
    channel.send = (m) => sent.push(m);
    connectCaches(report(4), channel, { cluster: true });
    channel.emit('message', { type: RUN, id: 'x', action: 'drop-tables' });
    channel.emit('message', { type: RUN, id: 'y', action: 'report' });
    await new Promise(r => setImmediate(r));
    expect(sent).toEqual([{ type: DONE, id: 'y', result: expect.objectContaining({ process: 'p4' }) }]);
    expect(ALL).toBe('fhirsmith:caches-all');
  });

  test('the page: a column for each process, and the total', async () => {
    const { sides } = cluster([report(1), report(2)]);
    const html = buildCachesPage({ answer: await sides[0].ask('report'), message: null, passwordConfigured: true });
    expect(html).toContain('in each of its 2 processes');
    expect(html).toMatch(/<th>m0<\/th><th>tx1<\/th><th>Total<\/th>/);
    expect(html).toMatch(/Expansion cache<\/td><td>\/r4<\/td><td style="text-align: right">1<\/td><td style="text-align: right">2<\/td><td style="text-align: right"><strong>3<\/strong>/);
    expect(html).toContain('Every process empties its caches');
  });
});
