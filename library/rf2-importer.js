/**
 * RF2 Importer - Programmatic wrapper for SNOMED CT RF2 to cache conversion
 *
 * This module provides a simple API to convert RF2 zip files to .cache format
 * suitable for use by the terminology server.
 */

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const os = require('os');
const { createHash } = require('crypto');
const AdmZip = require('adm-zip');

class Rf2Importer {
  constructor(options = {}) {
    this.log = options.log || console;
    this.tempDir = options.tempDir || os.tmpdir();
    this.keepTemp = options.keepTemp || false;
  }

  /**
   * Import an RF2 zip file and produce a .cache file
   *
   * @param {string} zipPath - Path to the RF2 zip file
   * @param {string} outputPath - Path for the output .cache file
   * @param {object} options - Import options
   * @returns {Promise<{outputPath: string, edition: string, version: string, uri: string}>}
   */
  async importZip(zipPath, outputPath, options = {}) {
    if (!fs.existsSync(zipPath)) {
      throw new Error(`RF2 zip file not found: ${zipPath}`);
    }

    // Create temp directory for extraction
    const tempExtractDir = path.join(this.tempDir, `rf2-extract-${Date.now()}`);
    await fsp.mkdir(tempExtractDir, { recursive: true });

    try {
      // Extract the zip
      this.log.info(`Extracting RF2 zip: ${zipPath}`);
      await this.#extractZip(zipPath, tempExtractDir);

      // Find the RF2 root directory (may be nested)
      const rf2Root = await this.#findRf2Root(tempExtractDir);
      if (!rf2Root) {
        throw new Error('Could not find RF2 content in zip (no Terminology folder found)');
      }
      this.log.info(`RF2 root: ${rf2Root}`);

      // Auto-detect edition and version
      const detected = await this.#detectEditionAndVersion(rf2Root);
      this.log.info(`Detected edition: ${detected.editionName} (${detected.edition})`);
      this.log.info(`Detected version: ${detected.version}`);

      // Build the version URI
      const edition = options.edition || detected.edition;
      const version = options.version || detected.version;
      const uri = options.uri || `http://snomed.info/sct/${edition}/version/${version}`;

      // Ensure output directory exists
      await fsp.mkdir(path.dirname(outputPath), { recursive: true });

      // Run the importer
      this.log.info(`Importing to: ${outputPath}`);
      await this.#runImport({
        source: rf2Root,
        dest: outputPath,
        edition,
        version,
        uri,
        verbose: options.verbose || false
      });

      return {
        outputPath,
        edition,
        version,
        uri,
        editionName: detected.editionName
      };
    } finally {
      // Cleanup temp directory
      if (!this.keepTemp) {
        await this.#rmdir(tempExtractDir);
      }
    }
  }

  async #extractZip(zipPath, destDir) {
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(destDir, true);
  }

  async #findRf2Root(dir) {
    // Look for Terminology directory which indicates RF2 content
    const entries = await fsp.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const fullPath = path.join(dir, entry.name);

        // Check if this directory has Terminology
        if (entry.name === 'Terminology' || entry.name === 'Snapshot') {
          return dir;
        }

        // Check if this directory contains Terminology (go one level down)
        const subEntries = await fsp.readdir(fullPath, { withFileTypes: true });
        for (const sub of subEntries) {
          if (sub.isDirectory() && (sub.name === 'Terminology' || sub.name === 'Snapshot')) {
            return fullPath;
          }
        }

        // Recurse into subdirectories (RF2 zips often have nested structure)
        const found = await this.#findRf2Root(fullPath);
        if (found) return found;
      }
    }

    return null;
  }

  async #detectEditionAndVersion(sourceDir) {
    // Import the SnomedModule to use its detection logic
    const { SnomedModule } = require('../tx/importers/import-sct.module');

    const snomedModule = new SnomedModule();
    // Use a mock config for detection
    snomedModule.config = { verbose: false };

    const detected = await snomedModule.detectEditionAndVersion(sourceDir);

    return {
      edition: detected.edition || '900000000000207008',
      version: detected.version || this.#generateVersionFromDate(),
      editionName: detected.editionName || 'Unknown Edition'
    };
  }

  #generateVersionFromDate() {
    const now = new Date();
    return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  }

  async #runImport(config) {
    // Import the importer classes
    const importerModule = require('../tx/importers/import-sct.module');

    // Create a minimal progress reporter
    const progressReporter = {
      createTaskProgressBar: (name) => ({
        start: () => {},
        update: () => {},
        stop: () => {}
      }),
      completeTask: (name, current, total) => {
        this.log.info(`  ${name}: ${current.toLocaleString()} items`);
      },
      stopCurrentProgress: () => {}
    };

    // Create and run the importer
    const importer = new importerModule.SnomedImporter(config, progressReporter);
    await importer.run();
  }

  async #rmdir(dir) {
    try {
      await fsp.rm(dir, { recursive: true, force: true });
    } catch (err) {
      this.log.warn(`Failed to cleanup temp directory: ${dir}`);
    }
  }

  /**
   * Generate a cache filename from edition and version
   */
  static generateCacheFilename(edition, version) {
    return `sct_${edition}_${version}.cache`;
  }
}

module.exports = { Rf2Importer };
