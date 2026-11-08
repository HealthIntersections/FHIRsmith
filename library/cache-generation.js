const crypto = require('crypto');

// A random token for the shared resource cache (tx/resource-cache-sqlite.js): 22 FHIR id
// characters from [A-Za-z0-9-], about 131 random bits. There is no '.' in it, so a cache-id
// "<code>.<generation>.<random>" splits on '.' into exactly its parts, and the code in front
// (what a proxy routes on) can't run into a token. With a 16-character code the id is 62
// characters, inside FHIR's 64.
const TOKEN = /^[A-Za-z0-9-]{22}$/;

function newCacheGeneration() {
  // base64url of 17 bytes, cut to 22 characters; '_' (not an id character) becomes '-'
  return crypto.randomBytes(17).toString('base64url').slice(0, 22).replace(/_/g, '-');
}

module.exports = { newCacheGeneration, TOKEN };
