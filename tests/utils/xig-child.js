// A server process with the XIG module's database, for tests/xig/xig-follow.test.js.
//   FHIRSMITH_DATA_DIR=<dir> node xig-child.js
const path = require('path');
const folders = require('../../library/folder-setup');
require('../../library/background-jobs').configure({ enabled: true, path: path.join(folders.dataDir(), 'background-jobs.lock') });
require('../../library/html-server').useLog({ info() {}, warn() {}, error() {}, debug() {} });
const xig = require('../../xig/xig');

process.on('message', async (msg) => {
  try {
    let result;
    switch (msg.op) {
      case 'open':
        await xig._initializeDatabase();
        result = xig._openedInode();
        break;
      case 'use':
        // what a request does on its way in
        xig._followDatabaseFile();
        result = xig._openedInode();
        break;
      case 'inode':
        result = xig._openedInode();
        break;
      case 'update':
        await xig.updateXigDatabase();
        result = true;
        break;
    }
    process.send({ seq: msg.seq, result });
  } catch (e) {
    process.send({ seq: msg.seq, error: e.message });
  }
});
process.send({ ready: true });
