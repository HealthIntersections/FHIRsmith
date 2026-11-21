// library/keystore: the server's key store - see keystore.js, and README.md for how modules use it.
// A singleton: server.js initializes it (keystore.initialize(config.keystore, ...)) after the
// login system (library/auth), when config.keystore.enabled is true.

const { KeyStore, KeyStoreError, SYSTEM, SIGNING_PREFERENCE } = require('./keystore');
const { KEY_TYPES, ALGS, KeyError } = require('./keys');

const keystore = new KeyStore();
keystore.KeyStore = KeyStore;
keystore.KeyStoreError = KeyStoreError;
keystore.KeyError = KeyError;
keystore.SYSTEM = SYSTEM;
keystore.KEY_TYPES = KEY_TYPES;
keystore.ALGS = ALGS;
keystore.SIGNING_PREFERENCE = SIGNING_PREFERENCE;

module.exports = keystore;
