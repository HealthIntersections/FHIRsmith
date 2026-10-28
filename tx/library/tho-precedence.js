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

module.exports = { keepForPinnedReference };
