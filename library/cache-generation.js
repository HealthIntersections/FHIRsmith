const crypto = require('crypto');

// 128 random bits in 22 FHIR id characters. Unlike base64url, this uses '.'
// instead of '_'. Two tokens plus an issuer prefix fit within FHIR's 64 chars.
function newCacheGeneration() {
  return crypto.randomBytes(16).toString('base64url').replace(/_/g, '.');
}

module.exports = { newCacheGeneration };
