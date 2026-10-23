const fs = require('fs');
const TestUtils = require('./utils/test-utils');
const folders = require('../library/folder-setup');

// Global test setup
beforeAll(() => {
  // Set NODE_ENV to test
  process.env.NODE_ENV = 'test';

  global.console = require('console');

  // Suppress console.log during tests (optional)
  if (process.env.SUPPRESS_LOGS === 'true') {
    console.log = jest.fn();
    console.error = jest.fn();
    console.warn = jest.fn();
  }
});

const testDirs = [
  folders.ensureFolder('terminology-cache/vsac')
];

for (const dir of testDirs) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

afterAll(async () => {
  // Clean up any test files or connections
  await new Promise(resolve => setTimeout(resolve, 100));
});

// supertest's request(app) starts the app on a random port with app.listen(0) - on every
// address, which is :: where there is IPv6 - and then connects to 127.0.0.1:port. On macOS
// another process can be listening on 127.0.0.1 at that same port (a specific address and the
// wildcard can share a port), and the specific binding gets the connection: now and then a
// request hangs, or fails with "Parse Error: Expected HTTP/". So connect to the loopback
// address of the family the server actually listens on: [::1] for ::, else 127.0.0.1.
// (Listening on 127.0.0.1 instead isn't possible here: with a host, listen() is asynchronous,
// and supertest needs the port at once.)
{
  const Test = require('supertest/lib/test.js');
  const { Server: TlsServer } = require('tls');
  Test.prototype.serverAddress = function (app, path) {
    if (!app.address()) {
      this._server = app.listen(0);
    }
    const { address, port } = app.address();
    const host = address === '::' ? '[::1]' : '127.0.0.1';
    const protocol = app instanceof TlsServer ? 'https' : 'http';
    return `${protocol}://${host}:${port}${path}`;
  };
}

// Increase timeout for integration tests
jest.setTimeout(30000);

// Mock external dependencies that we don't want to actually call during tests
jest.mock('node-cron', () => ({
  schedule: jest.fn(() => ({ stop: jest.fn() }))
}));

// Global test utilities
global.TEST_TIMEOUT = 120000;
global.TestUtils = {
  createTempDir: () => {
    const tmp = require('tmp');
    return tmp.dirSync({ unsafeCleanup: true });
  },

  createTempFile: (content = '') => {
    const tmp = require('tmp');
    const tmpFile = tmp.fileSync();
    if (content) {
      fs.writeFileSync(tmpFile.name, content);
    }
    return tmpFile;
  },

  delay: (ms) => new Promise(resolve => setTimeout(resolve, ms)),

  // Helper to wait for a condition
  waitFor: async (condition, timeout = 5000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await condition()) {
        return true;
      }
      await TestUtils.delay(50);
    }
    throw new Error(`Condition not met within ${timeout}ms`);
  }
};
