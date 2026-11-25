/**
 * OCL source checksums, as the discovery snapshot carries them, are the source's own checksum
 * (the "base"), with `|default=<version>` appended when the source defaults to a released
 * version (cs-ocl.cjs, #augmentSnapshotWithDefaultVersions). Whether that suffix is there
 * depends on the default version being resolved in that discovery run: when the request for the
 * source's versions fails or times out, the same content comes with the bare base checksum.
 *
 * Cache decisions about the *content* (is the cold cache still that of the source? is a value
 * set's cached compose still that of the code systems it draws on?) compare the base, so that
 * a discovery run that couldn't resolve the default version doesn't throw away caches whose
 * content hasn't changed.
 */

const DEFAULT_SUFFIX = '|default=';

function baseChecksum(checksum) {
  if (checksum == null) {
    return null;
  }
  const text = String(checksum);
  const i = text.indexOf(DEFAULT_SUFFIX);
  return i < 0 ? text : text.substring(0, i);
}

/**
 * Whether two dependency-checksum maps ({ "system|version": checksum }) describe the same
 * content: the same keys, and the same base checksum for each
 */
function sameDependencyChecksums(current, cached) {
  const a = current || {};
  const b = cached || {};
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  for (let i = 0; i < aKeys.length; i++) {
    if (aKeys[i] !== bKeys[i]) {
      return false;
    }
    if (baseChecksum(a[aKeys[i]]) !== baseChecksum(b[bKeys[i]])) {
      return false;
    }
  }
  return true;
}

module.exports = { baseChecksum, sameDependencyChecksums, DEFAULT_SUFFIX };
