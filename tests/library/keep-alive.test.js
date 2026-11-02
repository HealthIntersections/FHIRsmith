// Idle connections must outlive the reverse proxy's (nginx: 60 s), or nginx reuses a connection
// Node is closing and a POST on it fails with a 502. Node's default is 5 s.

const http = require('http');
const net = require('net');
const { applyKeepAliveTimeouts, KEEP_ALIVE_TIMEOUT_MS, HEADERS_TIMEOUT_MS } = require('../../library/keep-alive');

describe('keep-alive timeouts', () => {
  test('idle connections stay open longer than nginx keeps them, and headersTimeout is longer still', () => {
    const server = applyKeepAliveTimeouts(http.createServer());
    expect(server.keepAliveTimeout).toBe(KEEP_ALIVE_TIMEOUT_MS);
    expect(server.keepAliveTimeout).toBeGreaterThan(60000);
    expect(server.headersTimeout).toBe(HEADERS_TIMEOUT_MS);
    expect(server.headersTimeout).toBeGreaterThan(server.keepAliveTimeout);
  });

  test('a connection idle for longer than Node\'s 5 s default can still be reused', async () => {
    const server = applyKeepAliveTimeouts(http.createServer((req, res) => res.end('ok')));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const socket = net.connect(server.address().port, '127.0.0.1');
    let closed = false;
    socket.on('close', () => { closed = true; });
    const send = () => new Promise((resolve, reject) => {
      socket.once('data', d => resolve(d.toString()));
      socket.once('error', reject);
      socket.once('close', () => reject(new Error('connection closed')));
      socket.write('GET / HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n');
    });
    try {
      expect(await send()).toMatch(/^HTTP\/1.1 200/);
      await new Promise(resolve => setTimeout(resolve, 6000));
      expect(closed).toBe(false);
      expect(await send()).toMatch(/^HTTP\/1.1 200/);
    } finally {
      socket.destroy();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  }, 15000);
});
