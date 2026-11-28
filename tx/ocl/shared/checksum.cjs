/**
 * OCL source checksums, as the discovery snapshot carries them, are the source's own checksum
 * (the "base"), with `|default=<version>` appended when the source defaults to a released
 * version (cs-ocl.cjs, #augmentSnapshotWithDefaultVersions). Whether that suffix is there
 * depends on the default version being resolved in that discovery run: when the request for the
 * source's versions fails or times out, the same content comes with the bare base checksum.
 *
 * Cache decisions about the *content* (is the cold cache still that of the source? is a value
 * set's cached compose still that of the code systems it draws on?) use sameChecksum: the same
 * base, and the suffix either missing from one of the two (a discovery run that couldn't resolve
 * the default version must not throw away caches whose content hasn't changed) or the same in
 * both. Two different suffixes are a new default release, and that is a change.
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

/** The |default=<version> suffix of a checksum, or null when it has none */
function defaultSuffix(checksum) {
  if (checksum == null) {
    return null;
  }
  const text = String(checksum);
  const i = text.indexOf(DEFAULT_SUFFIX);
  return i < 0 ? null : text.substring(i);
}

/**
 * Whether two checksums of a source describe the same content: the same base, and either one
 * has no |default= suffix (its default version wasn't resolved in that run) or both have the
 * same one. abc|default=1.0 and abc|default=2.0 differ: the source has a new default release
 */
function sameChecksum(a, b) {
  if (baseChecksum(a) !== baseChecksum(b)) {
    return false;
  }
  const sa = defaultSuffix(a);
  const sb = defaultSuffix(b);
  return sa == null || sb == null || sa === sb;
}

/**
 * Whether two dependency-checksum maps ({ "system|version": checksum }) describe the same
 * content: the same keys, and the same checksum for each, as sameChecksum compares them
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
    if (!sameChecksum(a[aKeys[i]], b[bKeys[i]])) {
      return false;
    }
  }
  return true;
}

/**
 * A collection URL as a path on the OCL server: the same whether discovery got it absolute
 * from the API (https://host/orgs/X/collections/Y/concepts) or built it from the collection's
 * owner and id (/orgs/X/collections/Y/concepts/)
 */
function collectionPath(url) {
  if (url == null) {
    return null;
  }
  let text = String(url).trim().replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '');
  text = text.replace(/\/+$/, '');
  return text || null;
}

/**
 * Whether two value set metadata signatures (vs-ocl.cjs, #valueSetMetadataSignature: a JSON
 * object as text) describe the same collection. The concepts and expansion URLs are compared
 * as paths: their form depends on where discovery got the collection from, not on its content
 */
function sameCollectionSignature(current, cached) {
  if (current === cached) {
    return true;
  }
  let a;
  let b;
  try {
    a = JSON.parse(current);
    b = JSON.parse(cached);
  } catch (e) {
    return false;
  }
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }
  for (const key of ['url', 'version', 'lastUpdated', 'collectionId', 'preferredSource']) {
    if ((a[key] ?? null) !== (b[key] ?? null)) {
      return false;
    }
  }
  for (const key of ['conceptsUrl', 'expansionUrl']) {
    if (collectionPath(a[key]) !== collectionPath(b[key])) {
      return false;
    }
  }
  return true;
}

module.exports = { baseChecksum, defaultSuffix, sameChecksum, sameDependencyChecksums, collectionPath, sameCollectionSignature, DEFAULT_SUFFIX };
