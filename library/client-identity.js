// library/client-identity.js
//
// Which client a request comes from, from its User-Agent: the FHIR validator, the IG Publisher
// (or another tool built on org.hl7.fhir.core), or something else - and, for the FHIR tools,
// whether they say what version they are.
//
// The FHIR tools (org.hl7.fhir.core) name themselves as:
//   fhir/validator/{version} fhir-core/{version}   the validator
//   fhir/publisher fhir-core/{version}             the IG Publisher (its own version may follow fhir/publisher/)
//   fhir/{something}                               other builds: fhir/main-build is the FHIR specification's
//   hapi-fhir-tooling-client                       core's default, before the tools said who they were
// fhir-core/{version} is the library's version (VersionUtil.toolingUserAgent, core 7.0.7 on);
// "fhir-core/(unknown)" is a build from source, which doesn't know its version. Before that, only
// the validator said its version (fhir/validator/{version}, which is the library's version too).
// The User-Agent is what the client says: nothing here can tell a client that lies. This is for
// telling old versions of the tools to upgrade (or log in), not for security.

const TOOL_RE = /^fhir\/([A-Za-z][A-Za-z0-9._-]*)(?:\/(\S+))?$/;
const CORE_RE = /^fhir-core\/(\S+)$/;
const VERSION_RE = /^\d+(\.\d+){0,2}([-+][0-9A-Za-z.-]+)?$/;
const CORE_DEFAULT = 'hapi-fhir-tooling-client';

/**
 * @param {string|undefined} userAgent
 * @returns {{fhirTool: boolean, tool: string|null, version: string|null}} fhirTool: one of the FHIR
 *   tools; tool: validator, publisher, the name after fhir/, or 'fhir-core' (the library's default
 *   name); version: the library version it says it is, or null when it doesn't say
 */
function identifyClient(userAgent) {
  const result = { fhirTool: false, tool: null, version: null };
  if (typeof userAgent !== 'string') {
    return result;
  }
  let toolVersion = null;
  for (const token of userAgent.trim().split(/\s+/).slice(0, 10)) {
    let m = TOOL_RE.exec(token);
    if (m && !result.tool) {
      result.fhirTool = true;
      result.tool = m[1].toLowerCase();
      toolVersion = m[2] && VERSION_RE.test(m[2]) ? m[2] : null;
      continue;
    }
    m = CORE_RE.exec(token);
    if (m) {
      result.fhirTool = true;
      result.tool = result.tool || 'fhir-core';
      if (VERSION_RE.test(m[1])) {
        result.version = m[1];
      }
      continue;
    }
    if (token === CORE_DEFAULT) {
      result.fhirTool = true;
      result.tool = result.tool || 'fhir-core';
    }
  }
  // the validator's own version is the library's; the publisher's (fhir/publisher/{version}) isn't
  if (!result.version && result.tool === 'validator' && toolVersion) {
    result.version = toolVersion;
  }
  return result;
}

/** -1, 0 or 1: a against b, by their numbers (major.minor.patch; a label such as -SNAPSHOT is ignored) */
function compareVersions(a, b) {
  const parts = v => String(v).split(/[-+]/)[0].split('.').map(n => parseInt(n, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) {
      return d < 0 ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Is this an old version of a FHIR tool, by the rule configured (auth.loginForOldTools)?
 * @param {{fhirTool: boolean, version: string|null}} client - identifyClient's answer
 * @param {true|string} rule - true: one that doesn't say its version; a version: that, or older than it
 */
function isOldTool(client, rule) {
  if (!client.fhirTool || !rule) {
    return false;
  }
  if (!client.version) {
    return true;
  }
  return typeof rule === 'string' && compareVersions(client.version, rule) < 0;
}

module.exports = { identifyClient, isOldTool, compareVersions };
