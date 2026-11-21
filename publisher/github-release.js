// Tagging an IG source repository and publishing a GitHub release for it, at the end of a
// successful publication run.
//
// Authentication is a GitHub App rather than a personal access token. The reason is scope: the
// publisher only ever publishes from the HL7 and FHIR organisations, and an App installed on
// exactly those two - with Contents: Read and write, which covers both tags and releases - can be
// revoked, audited and attributed on its own. A fine-grained PAT cannot span two organisations
// (each is limited to a single resource owner), and a classic PAT would act as whoever minted it.
//
// The GitHub CLI is deliberately not used. gh cannot authenticate as an App - it only accepts
// access tokens - so an installation token has to be minted here regardless, and once that code
// exists the three remaining REST calls are less machinery than requiring gh to be installed and
// kept current on the server. Nothing in this file needs the database, which also keeps it
// testable without sqlite3.

const crypto = require('crypto');
const fs = require('fs');
const axios = require('axios');

const API_ROOT = 'https://api.github.com';
const API_VERSION = '2022-11-28';

// GitHub rejects an App JWT whose exp is more than 10 minutes out, measured against ITS clock, so
// a token minted right on the 10 minute mark fails whenever this server's clock runs slow. Backdate
// iat by a minute against skew the other way, and take 8 minutes rather than the full 10 - the
// token is spent within seconds of being minted, so the headroom costs nothing.
const JWT_BACKDATE_SECONDS = 60;
const JWT_LIFETIME_SECONDS = 480;

function isConfigured(cfg) {
  return !!(cfg && cfg['app-id'] && cfg['private-key'] && cfg.installations);
}

// task.github_org carries whatever case the requester typed, and GitHub org names are not
// case-sensitive, so the config's spelling should not have to match it.
function installationIdFor(cfg, org) {
  const map = (cfg && cfg.installations) || {};
  const wanted = String(org || '').toLowerCase();
  const key = Object.keys(map).find((k) => k.toLowerCase() === wanted);
  return key ? map[key] : null;
}

function base64url(input) {
  return Buffer.from(input).toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
}

function appJwt(appId, privateKeyPem, nowSeconds) {
  const now = nowSeconds || Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iat: now - JWT_BACKDATE_SECONDS,
    exp: now + JWT_LIFETIME_SECONDS,
    iss: String(appId)
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(header + '.' + payload);
  signer.end();
  return header + '.' + payload + '.' + base64url(signer.sign(privateKeyPem));
}

function apiHeaders(authorization) {
  return {
    'Authorization': authorization,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': 'FHIRsmith-publisher'
  };
}

async function installationToken(cfg, org, http) {
  const installationId = installationIdFor(cfg, org);
  if (!installationId) {
    throw new Error('No GitHub App installation is configured for the organisation ' + org);
  }
  const pem = fs.readFileSync(cfg['private-key'], 'utf8');
  const jwt = appJwt(cfg['app-id'], pem);
  const res = await http.post(
      API_ROOT + '/app/installations/' + installationId + '/access_tokens',
      {},
      { headers: apiHeaders('Bearer ' + jwt) });
  if (!res.data || !res.data.token) {
    throw new Error('GitHub returned no installation token for organisation ' + org);
  }
  return res.data.token;
}

// Create the tag if it is not already there. A re-publication of the same version finds it
// present: the tag is left alone (it is a public ref others may have resolved), but if it points
// somewhere other than what was just published, say so - a release attached to a commit that is
// not the published one is exactly the sort of thing nobody notices for a year.
async function ensureTag(repoUrl, tag, sha, headers, http, log) {
  const existing = await http.get(repoUrl + '/git/ref/' + encodeURIComponent('tags/' + tag),
      { headers, validateStatus: (s) => s === 200 || s === 404 });
  if (existing.status === 200) {
    const existingSha = existing.data && existing.data.object && existing.data.object.sha;
    if (existingSha && existingSha !== sha) {
      log('warn', 'Tag ' + tag + ' already exists and points at ' + existingSha.substring(0, 8) +
          ', not the commit just published (' + sha.substring(0, 8) + '). Leaving the tag as it is.');
    } else {
      log('info', 'Tag ' + tag + ' already exists and is correct - leaving it alone');
    }
    return false;
  }
  await http.post(repoUrl + '/git/refs', { ref: 'refs/tags/' + tag, sha: sha }, { headers });
  log('info', 'Created tag ' + tag + ' at ' + sha.substring(0, 8));
  return true;
}

// A re-publication should end up with the current build's zip attached, so an existing release for
// this tag is removed and rebuilt. The tag itself survives that - deleting a release does not
// delete its ref.
async function replaceExistingRelease(repoUrl, tag, headers, http, log) {
  const existing = await http.get(repoUrl + '/releases/tags/' + encodeURIComponent(tag),
      { headers, validateStatus: (s) => s === 200 || s === 404 });
  if (existing.status !== 200) {
    return false;
  }
  await http.delete(repoUrl + '/releases/' + existing.data.id, { headers });
  log('info', 'Removed the previous release for ' + tag + ' so it can be replaced');
  return true;
}

async function uploadAsset(uploadUrlTemplate, assetName, zipPath, headers, http) {
  // upload_url comes back as an RFC 6570 template, e.g. https://…/assets{?name,label}
  const base = uploadUrlTemplate.replace(/\{[^}]*\}$/, '');
  const url = base + '?name=' + encodeURIComponent(assetName);
  const body = fs.readFileSync(zipPath);
  const res = await http.post(url, body, {
    headers: Object.assign({}, headers, {
      'Content-Type': 'application/zip',
      'Content-Length': body.length
    }),
    maxBodyLength: Infinity,
    maxContentLength: Infinity
  });
  return res.data;
}

/**
 * Tag the source repository and publish a release carrying the source zip.
 *
 * Resolves with a summary; throws on failure. Callers are expected to treat a failure as a
 * warning: by the time this runs the IG itself is already published.
 */
async function publishRelease(opts) {
  const {
    config, org, repo, tag, sha, releaseName, body, zipPath, assetName
  } = opts;
  const http = opts.http || axios;
  const log = opts.log || function () {};

  if (!isConfigured(config)) {
    throw new Error('GitHub App is not configured');
  }
  if (!fs.existsSync(zipPath)) {
    throw new Error('Source zip not found at ' + zipPath);
  }

  const token = await installationToken(config, org, http);
  const headers = apiHeaders('Bearer ' + token);
  const repoUrl = API_ROOT + '/repos/' + org + '/' + repo;

  const tagCreated = await ensureTag(repoUrl, tag, sha, headers, http, log);
  const releaseReplaced = await replaceExistingRelease(repoUrl, tag, headers, http, log);

  const created = await http.post(repoUrl + '/releases', {
    tag_name: tag,
    name: releaseName,
    body: body || '',
    draft: false,
    prerelease: false
  }, { headers });

  await uploadAsset(created.data.upload_url, assetName, zipPath, headers, http);

  log('info', (releaseReplaced ? 'Replaced' : 'Created') + ' release ' + tag + ' on ' + org + '/' +
      repo + ' with ' + assetName + ' attached: ' + created.data.html_url);

  return {
    tagCreated: tagCreated,
    releaseReplaced: releaseReplaced,
    url: created.data.html_url
  };
}

module.exports = {
  isConfigured,
  installationIdFor,
  appJwt,
  installationToken,
  publishRelease
};
