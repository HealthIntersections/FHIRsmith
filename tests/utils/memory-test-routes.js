// Preloaded (node --require) into the cluster-mode memory test servers. Adds routes, in
// front of the app, that use memory the way a heavy operation does:
//   /__mem/leak?mb=N           keep N MB (until the process ends)
//   /__mem/heavy?mb=N&hold=ms  allocate up to N MB, 10 MB at a time, asking the memory guard
//                              after each step what deadCheck asks it (overAbortThreshold):
//                              422 if it says abort; else hold the memory for hold ms, free it, 200
//   /__mem/fill?mb=N&hold=ms   the same, without asking: holds N MB for hold ms
//   /__mem/check               what overAbortThreshold says in this worker now
//   /__mem/whoami              nothing (which worker answered)
// Every response carries X-Served-By: <pid>.
const http = require('http');
const path = require('path');
const memoryGuard = require(path.join(__dirname, '..', '..', 'library', 'memory-guard'));

const kept = [];
// Buffers are freed by a full GC; an operation's memory (JS objects) goes with the next
// GC its own allocation brings on. Freeing here collects at once, as that would
const collect = () => {
  const gc = memoryGuard.getGc();
  if (gc) {
    gc();
  }
};
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const MB = 1024 * 1024;

function reply(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'X-Served-By': String(process.pid) });
  res.end(JSON.stringify({ pid: process.pid, rss: process.memoryUsage.rss(), ...body }));
}

async function handle(req, res) {
  const u = new URL(req.url, 'http://x');
  const mb = Number(u.searchParams.get('mb')) || 0;
  const hold = Number(u.searchParams.get('hold')) || 0;
  switch (u.pathname) {
    case '/__mem/leak':
      for (let i = 0; i < mb; i += 10) {
        kept.push(Buffer.alloc(10 * MB, 1));
      }
      return reply(res, 200, { kept: kept.length * 10 });
    case '/__mem/heavy':
    case '/__mem/fill': {
      const ask = u.pathname === '/__mem/heavy';
      let held = [];
      for (let i = 0; i < mb; i += 10) {
        held.push(Buffer.alloc(10 * MB, 1));
        await sleep(30);
        const over = ask ? memoryGuard.overAbortThreshold('memory-test') : 0;
        if (over) {
          held = null;
          collect();
          return reply(res, 422, { aborted: true, atMb: i + 10, group: over });
        }
      }
      await sleep(hold);
      held = null;
      collect();
      return reply(res, 200, { aborted: false });
    }
    case '/__mem/whoami':
      return reply(res, 200, {});
    case '/__mem/check':
      return reply(res, 200, { aborts: memoryGuard.overAbortThreshold('memory-probe') > 0 });
    default:
      return reply(res, 404, {});
  }
}

const emit = http.Server.prototype.emit;
http.Server.prototype.emit = function (event, req, res, ...rest) {
  if (event === 'request' && req.url.startsWith('/__mem/')) {
    void handle(req, res);
    return true;
  }
  if (event === 'request') {
    const writeHead = res.writeHead;
    res.writeHead = function (...args) {
      if (!this.headersSent) {
        this.setHeader('X-Served-By', String(process.pid));
      }
      return writeHead.apply(this, args);
    };
  }
  return emit.call(this, event, req, res, ...rest);
};
