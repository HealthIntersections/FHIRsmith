// A server process with the VSAC value set provider, for tests/tx/vsac-generation.test.js.
// Its "VSAC" is a list of value sets the test sends: the provider's real refresh runs
// against it (_fetchBundle answers from the list), so a sync writes the database and
// bumps its generation exactly as a real one does.
//   FHIRSMITH_DATA_DIR=<dir> node vsac-child.js
const path = require('path');
const folders = require('../../library/folder-setup');
const backgroundJobs = require('../../library/background-jobs');
backgroundJobs.configure({ enabled: true, path: path.join(folders.dataDir(), 'background-jobs.lock') });
const { VSACValueSetProvider } = require('../../tx/vs/vs-vsac');

const stats = { addTask() {}, task() {}, taskDone() {}, taskError() {} };
const provider = new VSACValueSetProvider({ apiKey: 'test' }, stats);
provider.log = { error() {} };
let upstream = [];
provider._scanLastUpdated = async () => 0;
provider._fetchBundle = async (url) => {
  const m = /[?&]url=([^&]+)/.exec(url);
  const list = m ? upstream.filter(vs => vs.url === decodeURIComponent(m[1])) : upstream;
  return { resourceType: 'Bundle', total: list.length, entry: list.map(resource => ({ resource })), link: [] };
};
// count the generation reads, to show the check is throttled
let generationReads = 0;
const getGeneration = provider.database.getGeneration.bind(provider.database);
provider.database.getGeneration = async () => {
  generationReads++;
  return getGeneration();
};
// what the provider does when the generation has moved: reload its value set list (or,
// where the value sets are read from the database per request, recount them)
let reloads = 0;
const reloadName = typeof provider._reloadMap === 'function' ? '_reloadMap' : '_recount';
const reload = provider[reloadName].bind(provider);
provider[reloadName] = async () => {
  reloads++;
  return reload();
};
const origLog = console.log;
console.log = () => {};

process.on('message', async (msg) => {
  try {
    let result;
    switch (msg.op) {
      case 'init':
        await provider.initialize();
        result = { leader: backgroundJobs.isLeader() };
        break;
      case 'sync':
        upstream = msg.valueSets;
        await provider.refreshValueSets();
        result = await provider.database.getGeneration();
        break;
      case 'resync':
        upstream = msg.valueSets;
        await provider.resyncValueSet(msg.url);
        result = await provider.database.getGeneration();
        break;
      case 'fetch': {
        const vs = await provider.fetchValueSet(msg.url, msg.version || '');
        result = vs ? vs.version : null;
        break;
      }
      case 'catchUpNow':
        provider.generationCheckedAt = 0;
        await provider.catchUp(true);
        result = provider.loadedGeneration;
        break;
      case 'counts':
        result = { generationReads, reloads, loaded: provider.loadedGeneration };
        break;
    }
    process.send({ seq: msg.seq, result });
  } catch (e) {
    origLog(e);
    process.send({ seq: msg.seq, error: e.message });
  }
});
process.send({ ready: true });
