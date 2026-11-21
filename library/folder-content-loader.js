const fs = require('fs').promises;
const path = require('path');
const { PackageContentLoader } = require('./package-manager');

const TERMINOLOGY_TYPES = ['CodeSystem', 'ValueSet', 'ConceptMap'];

/**
 * A content loader that scans a folder for JSON FHIR terminology resources
 * (CodeSystem, ValueSet, ConceptMap). It synthesizes the package layout that
 * PackageContentLoader expects so the existing PackageValueSetProvider /
 * PackageConceptMapProvider machinery can be reused without modification.
 *
 * The user's source folder is treated as read-only. Any SQLite caches built
 * by the Package*Provider classes are written to the cacheFolder passed in,
 * not to the source folder.
 */
class FolderContentLoader extends PackageContentLoader {
  /**
   * @param {string} sourceFolder - Folder to scan for JSON resources
   * @param {string} cacheFolder - Folder where Package*Provider DBs may live
   */
  constructor(sourceFolder, cacheFolder) {
    super(cacheFolder);
    this.sourceFolder = sourceFolder;
    // Resources are read directly from the source folder rather than from
    // <packageFolder>/package as PackageContentLoader assumes.
    this.packageSubfolder = sourceFolder;
  }

  /**
   * The synthesized package name reported by id()/pid().
   * @returns {string}
   */
  _packageName() {
    return 'folder.' + path.basename(this.sourceFolder);
  }

  /**
   * Whether a file that can't be parsed, or that isn't a terminology resource,
   * should be quietly skipped. True for folder scans (the folder may hold all
   * sorts of things); false when a specific file was nominated.
   * @returns {boolean}
   */
  get _skipInvalidFiles() {
    return true;
  }

  /**
   * Check the source exists and is the right kind of thing.
   */
  async _validateSource() {
    try {
      const stat = await fs.stat(this.sourceFolder);
      if (!stat.isDirectory()) {
        throw new Error(`Folder source path is not a directory: ${this.sourceFolder}`);
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new Error(`Folder source path does not exist: ${this.sourceFolder}`);
      }
      throw err;
    }
  }

  /**
   * The file names (relative to sourceFolder) to consider.
   * @returns {Promise<Array<string>>}
   */
  async _candidateFiles() {
    const names = [];
    const entries = await fs.readdir(this.sourceFolder, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.toLowerCase().endsWith('.json')) continue;
      names.push(entry.name);
    }
    return names;
  }

  /**
   * Replaces the standard initialize: there is no package.json or .index.json
   * to read, so we synthesize an index from the JSON files in the source.
   */
  async initialize() {
    if (this.loaded) {
      return;
    }

    await this._validateSource();

    // Synthesize package metadata so id()/version()/pid() return something usable.
    this.package = {
      name: this._packageName(),
      version: '0.0.0',
      fhirVersions: ['5.0.0']
    };

    const files = [];
    for (const name of await this._candidateFiles()) {
      const fullPath = path.join(this.sourceFolder, name);
      let json;
      try {
        const content = await fs.readFile(fullPath, 'utf8');
        json = JSON.parse(content);
      } catch (e) {
        // Skip unreadable / non-JSON files rather than failing the whole load,
        // unless this exact file was the nominated source.
        if (this._skipInvalidFiles) continue;
        throw new Error(`Unable to read FHIR resource from ${fullPath}: ${e.message}`);
      }

      const rt = json && typeof json === 'object' ? json.resourceType : null;
      if (!TERMINOLOGY_TYPES.includes(rt)) {
        if (this._skipInvalidFiles) continue;
        throw new Error(`${fullPath} is not a CodeSystem, ValueSet or ConceptMap (resourceType = ${rt || 'none'})`);
      }

      files.push({
        filename: name,
        resourceType: rt,
        id: json.id,
        url: json.url,
        version: json.version
      });
    }

    this.index = { files, 'index-version': 2 };
    this.buildIndexes();
    this.loaded = true;
  }
}

/**
 * A content loader for a single nominated JSON file holding one CodeSystem,
 * ValueSet or ConceptMap. Everything else works exactly as for a folder source:
 * the file's own directory is the read-only content root, and the provider
 * caches live in the supplied cacheFolder.
 *
 * Unlike a folder scan, a bad file is an error rather than something to skip -
 * the config named this file explicitly, so failing silently would just hide
 * a typo.
 */
class FileContentLoader extends FolderContentLoader {
  /**
   * @param {string} filePath - The JSON file to load
   * @param {string} cacheFolder - Folder where Package*Provider DBs may live
   */
  constructor(filePath, cacheFolder) {
    super(path.dirname(filePath), cacheFolder);
    this.filePath = filePath;
    this.fileName = path.basename(filePath);
  }

  _packageName() {
    return 'file.' + this.fileName.replace(/\.json$/i, '');
  }

  get _skipInvalidFiles() {
    return false;
  }

  async _validateSource() {
    try {
      const stat = await fs.stat(this.filePath);
      if (!stat.isFile()) {
        throw new Error(`File source path is not a file: ${this.filePath}`);
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new Error(`File source path does not exist: ${this.filePath}`);
      }
      throw err;
    }
  }

  async _candidateFiles() {
    return [this.fileName];
  }
}

module.exports = { FolderContentLoader, FileContentLoader };
