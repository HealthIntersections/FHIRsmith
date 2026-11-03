/**
 * TX Module Test Setup
 * 
 * Provides a configured Express app with TX module for integration testing.
 * Uses automatic R5 core package loading.
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const TXModule = require('../../tx/tx');

let app = null;
let txModule = null;
let initialized = false;

/**
 * Get or create the test Express app with TX module
 * @returns {Promise<express.Application>}
 */
async function getTestApp() {
  if (initialized && app) {
    return app;
  }

  app = express();
  // Mirror production: CORS is applied once at the app level.
  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  txModule = new TXModule();

  // Configure TX module - empty library, cloneWithFhirVersion will load R5 core
  const config = {
    librarySource: path.join(__dirname, 'fixtures', 'test-library.yaml'),
    endpoints: [
      {
        path: '/tx/r5',
        fhirVersion: '5.0',
        context: null
      }
    ]
  };

  // FHIRSMITH_TEST_RESOURCE_CACHE=sqlite runs the same tests against the shared
  // SQLite resource cache (cluster mode's store) instead of the memory one
  if (process.env.FHIRSMITH_TEST_RESOURCE_CACHE === 'sqlite') {
    const os = require('os');
    const fs = require('fs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tx-resource-cache-'));
    config.resourceCache = { store: 'sqlite', path: path.join(dir, 'resource-cache.db') };
  }

  await txModule.initialize(config, app);
  initialized = true;

  return app;
}

/**
 * Get the TX module instance
 * @returns {TXModule}
 */
function getTxModule() {
  return txModule;
}

/**
 * Get the provider for direct access in tests
 * @returns {Provider}
 */
function getProvider() {
  if (!txModule || txModule.endpoints.length === 0) {
    return null;
  }
  // The provider is attached to requests, but we can access it via the library
  return txModule.library;
}

/**
 * Shutdown the TX module (call in afterAll)
 */
async function shutdownTestApp() {
  if (txModule) {
    await txModule.shutdown();
  }
  app = null;
  txModule = null;
  initialized = false;
}

module.exports = {
  getTestApp,
  getTxModule,
  getProvider,
  shutdownTestApp
};
