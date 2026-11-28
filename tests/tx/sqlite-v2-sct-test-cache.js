'use strict';

// The SNOMED CT test edition as main's importer makes it from the RF2 subset in tx/data/snomed, with
// the settings tests/cs/cs-snomed.test.js imports it with: a suite that needs main's .cache builds
// it in its own run, rather than reading the copy committed as tx/data/snomed-testing.cache.

const path = require('path');
const { SnomedImporter } = require('../../tx/importers/import-sct.module');

const SRC = path.resolve(__dirname, '../../tx/data/snomed');

/**
 * @param {string} dest - the .cache to write
 * @returns {Promise<string>} dest
 */
async function importSnomedTestCache(dest) {
  const quiet = jest.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await new SnomedImporter({ source: SRC, dest, edition: '31000003106', version: '20250909',
      uri: 'http://snomed.info/sct/31000003106/version/20250909', language: 'en-US',
      license: path.join(SRC, 'license.txt'), verbose: false, overwrite: true, createIndexes: true }).run();
  } finally {
    quiet.mockRestore();
  }
  return dest;
}

module.exports = { importSnomedTestCache };
