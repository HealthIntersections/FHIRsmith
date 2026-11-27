'use strict';

/**
 * Duplicate file names in a package (.tgz).
 *
 * A package with two files of the same name is refused by everything that reads one (the
 * npm registry check reports it instead). Readers don't agree which copy wins - FHIRsmith's
 * crawler and Java's NpmPackage keep the last, a reader that stops at the first one it wants
 * keeps the first - so a package with two package.json files could be one package to one
 * reader and another package to another.
 *
 * "The same name" is after normalisation, so that names that are different strings but the
 * same file to some reader or file system count as duplicates too: \ is /, runs of / are one,
 * . segments and leading / are dropped (./package/x and package//x are package/x), Unicode is
 * NFC (macOS file systems don't tell NFC and NFD apart), and case is ignored (macOS and Windows
 * file systems don't tell Package.json from package.json). org.hl7.fhir.core's NpmPackage
 * (entryNameKey) normalises the same way.
 *
 * Two files in the example folders (package/examples, package/example, and folders in them) of
 * exactly the same name - case and all - are let off: which of them a reader ends up with doesn't
 * matter, and published packages have them (de.basisprofil.r4#0.9.13 has two
 * package/examples/Example-observation-bmi.json). Names there that differ in case are still
 * refused: unpacked onto a file system that ignores case, they're one file. org.hl7.fhir.core's
 * NpmPackage (checkDuplicateName) does the same. The npm registry check is strict: a package
 * being published can't have any duplicates, examples or not.
 */

const EXAMPLE_FOLDERS = ['examples', 'example'];

/**
 * The name a file in a package is compared by
 * @param {string} name - the name in the tarball
 * @returns {string}
 */
function entryNameKey(name) {
  return normalisedName(name).toLowerCase();
}

/** entryNameKey, but keeping the case */
function normalisedName(name) {
  return String(name).normalize('NFC')
    .replace(/\\/g, '/')
    .split('/').filter(s => s !== '' && s !== '.').join('/');
}

/**
 * A name with a .. segment (with / or \ as the separator) names a file outside the package, or
 * outside the folder it claims to be in, once unpacked. Everything that reads a package refuses one
 * (the npm registry check reports it instead), as org.hl7.fhir.core's NpmPackage does
 * @param {string} name - an entry in the tarball (a file or a directory)
 * @returns {string|null} a message, if the name has a .. segment
 */
function pathProblem(name) {
  return String(name).split(/[\\/]/).includes('..') ? `the package has a file named ${name}, which goes outside its folder (..)` : null;
}

/**
 * The files of one package, as it is read, noting any name that duplicates an earlier one
 */
class EntryNames {
  /**
   * @param {{strict?: boolean}} [options] - strict: two examples of exactly the same name are
   *   duplicates too (the npm registry check: a package being published can't have them)
   */
  constructor(options = {}) {
    this.strict = !!options.strict;
    this.seen = new Map();
    this.duplicates = [];
  }

  /**
   * @param {string} name - a file in the package (not a directory)
   * @returns {string|null} a message, if the name is a duplicate of one seen before (unless strict,
   *   never for a second example of exactly the same name)
   */
  add(name) {
    const key = entryNameKey(name);
    const earlier = this.seen.get(key);
    if (earlier === undefined) {
      this.seen.set(key, name);
      return null;
    }
    if (!this.strict && EXAMPLE_FOLDERS.some(f => key.startsWith(`package/${f}/`)) && normalisedName(earlier) === normalisedName(name)) {
      return null;
    }
    const message = earlier === name ? `the package has more than one file named ${name}`
      : `the package has files named ${earlier} and ${name}, which are the same file to some systems`;
    this.duplicates.push(message);
    return message;
  }
}

module.exports = { entryNameKey, EntryNames, pathProblem };
