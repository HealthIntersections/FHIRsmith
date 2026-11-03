// Preloaded (node --require) into cluster-mode test servers: every response says which
// process served it, in X-Served-By.
const http = require('http');
const writeHead = http.ServerResponse.prototype.writeHead;
http.ServerResponse.prototype.writeHead = function (...args) {
  if (!this.headersSent) {
    this.setHeader('X-Served-By', String(process.pid));
  }
  return writeHead.apply(this, args);
};
