// A separate process using a $closure database, for tests/tx/closure-multiprocess.test.js:
// what two cluster-mode workers do to one closure table at the same time.
//   node closure-child.js <dir> <crossProcess: 1|0>
const path = require('path');
const dir = process.argv[2];
const clusterState = require('../../library/cluster-state');
clusterState._configure({ file: path.join(dir, 'cluster-state.db'), shared: true });
const { ClosureStore } = require('../../tx/closure/closure-store');

const store = new ClosureStore({ database: path.join(dir, 'closure.db') }, null, { crossProcess: process.argv[3] === '1' });
store.open();

process.on('message', async (msg) => {
  try {
    let result;
    if (msg.op === 'create') {
      result = store.createTable(msg.name, [], msg.max) !== null;
    } else if (msg.op === 'adds') {
      // the read-compute-write of a $closure call: read the table, yield, write the next version
      for (let i = 0; i < msg.times; i++) {
        await store.withLock(msg.name, async () => {
          const table = store.getTable(msg.name);
          await new Promise(resolve => setTimeout(resolve, msg.ms));
          store.recordAdd(table, [{ key: 'k', system: 'http://example.org', code: `${process.pid}-${i}` }], []);
        }, { timeoutMs: 30000 });
      }
      result = true;
    } else if (msg.op === 'version') {
      const t = store.getTable(msg.name);
      result = { version: t.version, concepts: store.conceptCount(t.id) };
    }
    process.send({ seq: msg.seq, result });
  } catch (e) {
    process.send({ seq: msg.seq, error: e.message });
  }
});
process.send({ ready: true });
