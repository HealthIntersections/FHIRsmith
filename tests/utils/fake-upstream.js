// A stand-in for a server process, for tests/server/cluster-launcher.test.js:
//   node fake-upstream.js <code> <port> [keepAliveTimeout ms] [hang]
// /health answers 200; anything else answers {code, url, xff, proto} as JSON, after
// ?delay=<ms>, with ?status=<code> (503 with Retry-After). With `hang` (a wedged process),
// nothing but /health is ever answered. On SIGTERM it finishes the requests it has, then exits.
const http = require('http');
const [code, port, keepAlive, hang] = process.argv.slice(2);
let metrics = null;
const startedAt = Date.now();
process.on('message', message => {
  if (message.type === 'fhirsmith:metrics') metrics = message;
});
const samples = setInterval(() => {
  if (process.connected) process.send({ type:'fhirsmith:metric', startedAt, intervalMs:100,
    point:{ time:Date.now(), mem:1, rpm:code === 'm0' ? 1 : 2, tat:3, block:4, blockMax:5, clientConcepts:6 } }, () => {});
}, 100);
samples.unref();
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.end('ok');
    return;
  }
  if (req.url === '/r4/connections') {
    res.end(JSON.stringify({ code, connections }));
    return;
  }
  if (req.url === '/metrics') {
    res.end(JSON.stringify({ metrics }));
    return;
  }
  if (hang === 'hang') {
    return;
  }
  const query = new URL(req.url, 'http://x').searchParams;
  const delay = Number(query.get('delay')) || 0;
  setTimeout(() => {
    res.statusCode = Number(query.get('status')) || 200;
    if (res.statusCode === 503) {
      res.setHeader('Retry-After', '2');
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ code, url: req.url, xff: req.headers['x-forwarded-for'], proto: req.headers['x-forwarded-proto'] }));
  }, delay);
});
if (keepAlive) {
  server.keepAliveTimeout = Number(keepAlive);
}
// the connections it accepted, for the test of idle keep-alive connections
let connections = 0;
server.on('connection', () => { connections++; });
server.listen(Number(port));
process.on('SIGTERM', () => {
  clearInterval(samples);
  server.close(() => process.exit(0));
  server.closeIdleConnections();
});
