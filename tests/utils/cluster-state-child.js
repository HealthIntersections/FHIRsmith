// A separate server process for tests/library/cluster-state.test.js: the testing
// module (logins, CSRF, a login rate limit) over a data directory it shares with
// other copies of itself, as cluster-mode workers do. Also runs leases on request.
//   node cluster-state-child.js <dir>
const path = require('path');
const fs = require('fs');
const express = require('express');

const dir = process.argv[2];
const clusterState = require('../../library/cluster-state');
clusterState._configure({ file: path.join(dir, 'cluster-state.db'), shared: true });

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };
require('../../library/html-server').useLog(quietLog);
const TestingModule = require('../../testing/testing');

(async () => {
  const stats = { countRequest() {}, addTask() {}, task() {}, taskDone() {}, taskError() {} };
  const mod = new TestingModule(stats, quietLog);
  await mod.initialize({
    database: path.join(dir, 'testing.db'), adminPassword: 'admin-secret', cookieSecure: false,
    rateLimit: { max: 0 }, loginAttemptsPerWindow: 5
  });
  const app = express();
  app.set('trust proxy', 'loopback');
  app.use('/testing', mod.router);
  const server = app.listen(0, '127.0.0.1', () => process.send({ ready: server.address().port }));

  process.on('message', async (msg) => {
    if (msg.op === 'lease') {
      // hold the lease for msg.ms, recording when it was held
      const log = path.join(dir, 'lease.log');
      for (let i = 0; i < msg.times; i++) {
        await clusterState.withLease('shared-thing', async () => {
          fs.appendFileSync(log, `${process.pid} in ${Date.now()}\n`);
          await new Promise(resolve => setTimeout(resolve, msg.ms));
          fs.appendFileSync(log, `${process.pid} out ${Date.now()}\n`);
        });
      }
      process.send({ seq: msg.seq, result: true });
    } else if (msg.op === 'secret') {
      process.send({ seq: msg.seq, result: clusterState.sessionSecret('testing') });
    }
  });
})().catch(e => {
  console.error(e);
  process.exit(1);
});
