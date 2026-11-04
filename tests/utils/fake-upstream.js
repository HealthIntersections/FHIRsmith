// A stand-in for a server process, for tests/server/cluster-launcher.test.js:
//   node fake-upstream.js <code> <port>
// /health answers 200; anything else answers {code, url, xff, proto} as JSON, after
// ?delay=<ms>. On SIGTERM it finishes the requests it has, then exits.
const http = require('http');
const [code, port] = process.argv.slice(2);
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.end('ok');
    return;
  }
  const delay = Number(new URL(req.url, 'http://x').searchParams.get('delay')) || 0;
  setTimeout(() => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ code, url: req.url, xff: req.headers['x-forwarded-for'], proto: req.headers['x-forwarded-proto'] }));
  }, delay);
});
server.listen(Number(port));
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
  server.closeIdleConnections();
});
