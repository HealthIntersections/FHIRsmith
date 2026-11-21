// A separate process using the shared SQLite resource cache, driven over IPC by
// tests/tx/resource-cache-multiprocess.test.js. Each message names a method of the
// cache and its arguments; the reply is the result (or the error).
const { SqliteResourceCache } = require('../../tx/resource-cache-sqlite');
const { CodeSystem } = require('../../tx/library/codesystem');

const cache = new SqliteResourceCache(null, { path: process.argv[2], scope: '/r4', maxBytes: Number(process.argv[3] || 0) });

process.on('message', (msg) => {
  try {
    let result;
    switch (msg.op) {
      case 'start': {
        const id = cache.newCacheId();
        cache.set(id, (msg.resources || []).map(r => new CodeSystem(r, 'R4')), !!msg.sealed);
        result = id;
        break;
      }
      case 'add':
        cache.add(msg.id, msg.resources.map(r => new CodeSystem(r, 'R4')));
        result = true;
        break;
      case 'get':
        result = cache.get(msg.id).map(r => ({ cls: r.constructor.name, url: r.url, version: r.version, fhirVersion: r.fhirVersion, concepts: r.conceptCount() }));
        break;
      case 'has':
        result = cache.has(msg.id);
        break;
      case 'end':
        cache.clear(msg.id);
        result = true;
        break;
      case 'describe':
        result = cache.describeMissing(msg.id);
        break;
      case 'setLastUsed':
        cache.db.prepare('UPDATE sessions SET last_used = ? WHERE cache_id = ?').run(msg.when, msg.id);
        result = true;
        break;
      case 'prune':
        cache.prune(msg.maxAge);
        result = true;
        break;
      default:
        throw new Error('unknown op ' + msg.op);
    }
    process.send({ seq: msg.seq, result });
  } catch (e) {
    process.send({ seq: msg.seq, error: e.message });
  }
});
process.send({ ready: process.pid });
