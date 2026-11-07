/**
 * The largest request body the server's body parsers accept, from server.maxBodyMB
 * (megabytes; default 50). A body is read whole into memory before it is parsed, so this
 * bounds the memory one request can take. A body over it gets a 413 - an OperationOutcome
 * on a tx endpoint (see TXModule.setupEndpoint).
 */

const DEFAULT_MAX_BODY_MB = 50;

/**
 * @param {Object} serverConfig - the "server" section of config.json
 * @returns {number} the limit in bytes
 */
function maxBodyBytes(serverConfig) {
  let mb = Number(serverConfig?.maxBodyMB ?? DEFAULT_MAX_BODY_MB);
  if (!Number.isFinite(mb) || mb <= 0) {
    mb = DEFAULT_MAX_BODY_MB; // not a usable number: the default, not no limit
  }
  return Math.round(mb * 1024 * 1024);
}

module.exports = { maxBodyBytes, DEFAULT_MAX_BODY_MB };
