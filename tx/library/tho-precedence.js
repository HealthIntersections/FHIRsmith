//
// THO precedence for value sets and concept maps (see Provider.applyTHOPrecedence).
//
// Where hl7.terminology provides a resource with the same url as one in the FHIR core
// package, THO's copy is the one used - versions were reset when content moved to THO, so
// version order can't decide. But the core copy is still what a reference that names its
// version (url|5.0.0) means, so it stays available to that reference, and only to it.
//

const { VersionUtilities } = require('../../library/version-utilities');

/**
 * Whether a package provider should keep a map key for a resource that THO also provides.
 * Only the keys that name a version are kept - url|version, and url|major.minor for a
 * semver version - and only where THO doesn't provide that version itself. The bare url
 * (the default for a reference with no version) and the resource's id are not kept.
 *
 * @param {string} key - the map key
 * @param {{url: string, version: string}} resource - the core package's resource
 * @param {Set<string>} thoVersions - the versions of the url that hl7.terminology provides
 * @returns {boolean}
 */
function keepForPinnedReference(key, resource, thoVersions) {
  const version = resource.version;
  if (!version) {
    return false;
  }
  if (key === resource.url + '|' + version) {
    return !thoVersions.has(version);
  }
  if (VersionUtilities.isSemVer(version)) {
    const mm = VersionUtilities.getMajMin(version);
    if (mm && key === resource.url + '|' + mm) {
      return ![...thoVersions].some(v => v && VersionUtilities.isSemVer(v) && VersionUtilities.getMajMin(v) === mm);
    }
  }
  return false;
}

/**
 * url -> the versions hl7.terminology provides, for the urls of the core package's resources
 * (the input to keepPinnedOnly). Each THO provider is asked about each url the way a reference
 * asks it (fetchValueSet / fetchConceptMap): with no version, which gives the version it
 * provides by default, and - when it has the url - with the core resource's version, which
 * gives the version it provides for a reference that names that one (the same version, or one
 * with the same major.minor), if any. That is all keepForPinnedReference needs to know. A url
 * no THO provider has is left out.
 *
 * @param {Iterable<Object>} coreResources - the core package's value sets or concept maps (repeats are harmless)
 * @param {Object[]} thoProviders - the value set (or concept map) providers of hl7.terminology packages
 * @param {function(Object, string, string=): Promise<Object|null>} fetch - (provider, url, version) => its resource, or null
 * @returns {Promise<Map<string, Set<string>>>}
 */
async function thoVersionsOf(coreResources, thoProviders, fetch) {
  const result = new Map();
  if (thoProviders.length === 0) {
    return result;
  }
  const versions = new Map(); // url -> the core package's versions of it
  for (const r of coreResources) {
    if (r && r.url) {
      if (!versions.has(r.url)) {
        versions.set(r.url, new Set());
      }
      if (r.version) {
        versions.get(r.url).add(r.version);
      }
    }
  }
  const add = (url, r) => {
    if (!result.has(url)) {
      result.set(url, new Set());
    }
    if (r.version) {
      result.get(url).add(r.version);
    }
  };
  for (const [url, coreVersions] of versions) {
    for (const p of thoProviders) {
      const r = await fetch(p, url);
      if (r) {
        add(url, r);
        for (const v of coreVersions) {
          const pinned = await fetch(p, url, v);
          if (pinned && pinned.url === url) {
            add(url, pinned);
          }
        }
      }
    }
  }
  return result;
}

module.exports = { keepForPinnedReference, thoVersionsOf };
