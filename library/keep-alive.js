// Keep-alive timeouts for the HTTP server behind a reverse proxy.
//
// nginx keeps idle upstream connections open for 60 s (keepalive_timeout in an upstream block),
// while Node closes an idle one after 5 s. When nginx reuses a connection at the moment Node
// closes it, the request fails with a reset, and nginx does not retry a POST: the client gets a
// 502. Node must therefore keep idle connections open longer than the proxy does, and
// headersTimeout must be longer still, or Node applies it to the idle connection first.

const KEEP_ALIVE_TIMEOUT_MS = 65000;
const HEADERS_TIMEOUT_MS = 66000;

function applyKeepAliveTimeouts(server) {
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  return server;
}

module.exports = { applyKeepAliveTimeouts, KEEP_ALIVE_TIMEOUT_MS, HEADERS_TIMEOUT_MS };
