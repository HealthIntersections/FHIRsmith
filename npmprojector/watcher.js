//
// Package Watcher
// Watches a local directory or .tgz file and triggers reloads on changes
//

const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');
const os = require('os');
const tar = require('tar');

class PackageWatcher {
  constructor(packagePath, options = {}) {
    this.packagePath = packagePath;
    this.debounceMs = options.debounceMs || 500;
    this.onReload = options.onReload || (() => {});
    this.log = options.log || console;
    this.watcher = null;
    this.debounceTimer = null;
    this.extractDir = null;
    this.isTgz = false;
    
    // Folder options (paths relative to package root)
    this.resourceFolders = options.resourceFolders || null;  // null = load all
    this.searchParametersFolder = options.searchParametersFolder || null;  // folder within package
  }

  /**
   * Start watching the package directory or .tgz file
   */
  start() {
    this.log.info(`Watching package at: ${this.packagePath}`);

    // Check if this is a .tgz file
    this.isTgz = this.packagePath.endsWith('.tgz') || this.packagePath.endsWith('.tar.gz');

    if (this.isTgz) {
      // Create temp directory for extraction
      this.extractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'npmprojector-'));
      this.log.info(`Using temp directory: ${this.extractDir}`);
    }

    this.watcher = chokidar.watch(this.packagePath, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100
      }
    });

    this.watcher
      .on('add', filePath => this.handleChange('add', filePath))
      .on('change', filePath => this.handleChange('change', filePath))
      .on('unlink', filePath => this.handleChange('unlink', filePath))
      .on('error', error => this.log.error('Watcher error:', error));

    // Do initial load
    this.triggerReload();
  }

  /**
   * Handle a file change event
   */
  handleChange(event, filePath) {
    this.log.info(`File ${event}: ${filePath}`);

    // Debounce rapid changes
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.triggerReload();
    }, this.debounceMs);
  }

  /**
   * Load all data and trigger the reload callback
   */
  triggerReload() {
    this.log.info('Reloading package data...');

    try {
      // If .tgz, extract first
      if (this.isTgz) {
        this.extractTgz();
      }

      // Determine which directory to read from
      const readPath = this.getReadPath();
      this.log.info(`Reading from: ${readPath}`);

      const data = this.loadPackageDataFrom(readPath);
      this.onReload(data);
      this.log.info(`Reload complete: ${data.resources.length} resources, ${data.searchParameters.length} search parameters`);
    } catch (error) {
      this.log.error('Error loading package data:', error);
    }
  }

  /**
   * Extract .tgz file to temp directory
   */
  extractTgz() {
    // Clear existing extracted content
    if (fs.existsSync(this.extractDir)) {
      fs.rmSync(this.extractDir, { recursive: true, force: true });
    }
    fs.mkdirSync(this.extractDir, { recursive: true });

    // Extract synchronously
    tar.extract({
      file: this.packagePath,
      cwd: this.extractDir,
      sync: true
    });

    this.log.info(`Extracted .tgz to ${this.extractDir}`);
  }

  /**
   * Get the actual directory to read from
   */
  getReadPath() {
    if (this.isTgz) {
      // npm packages typically extract to a 'package' subdirectory
      const packageSubdir = path.join(this.extractDir, 'package');
      if (fs.existsSync(packageSubdir)) {
        return packageSubdir;
      }
      return this.extractDir;
    }
    return this.packagePath;
  }

  /**
   * Load all FHIR resources and search parameters from a directory
   */
  loadPackageDataFrom(dirPath) {
    const resources = [];
    const searchParameters = [];

    // Load search parameters from specified folder within package
    if (this.searchParametersFolder) {
      const spPath = path.join(dirPath, this.searchParametersFolder);
      if (fs.existsSync(spPath)) {
        const spFiles = this.findJsonFiles(spPath);
        this.log.info(`Loading search parameters from ${this.searchParametersFolder}: ${spFiles.length} files`);
        for (const filePath of spFiles) {
          this.loadSearchParamsFromFile(filePath, searchParameters);
        }
      } else {
        this.log.warn(`Search parameters folder not found: ${spPath}`);
      }
    }

    // Determine which folders to load resources from
    let foldersToLoad = [];
    if (this.resourceFolders && this.resourceFolders.length > 0) {
      // Load only from specified folders
      for (const folder of this.resourceFolders) {
        const folderPath = path.join(dirPath, folder);
        if (fs.existsSync(folderPath)) {
          foldersToLoad.push(folderPath);
        } else {
          this.log.warn(`Resource folder not found: ${folderPath}`);
        }
      }
    } else {
      // Load from entire package
      foldersToLoad = [dirPath];
    }

    // Load all JSON files from the designated folders
    let totalFiles = 0;
    for (const folder of foldersToLoad) {
      const jsonFiles = this.findJsonFiles(folder);
      totalFiles += jsonFiles.length;
      
      for (const filePath of jsonFiles) {
        // Skip if this is in the search parameters folder (already loaded)
        if (this.searchParametersFolder) {
          const spPath = path.join(dirPath, this.searchParametersFolder);
          if (filePath.startsWith(spPath)) {
            continue;
          }
        }

        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          const parsed = JSON.parse(content);

          // Handle Bundles
          if (parsed.resourceType === 'Bundle' && parsed.entry) {
            for (const entry of parsed.entry) {
              if (entry.resource) {
                this.categorizeResource(entry.resource, resources, searchParameters);
              }
            }
          } else if (parsed.resourceType) {
            this.categorizeResource(parsed, resources, searchParameters);
          }
        } catch (err) {
          // Skip files that can't be parsed as FHIR
        }
      }
    }
    
    this.log.info(`Found ${totalFiles} JSON files in ${foldersToLoad.length} folder(s)`);

    return { resources, searchParameters };
  }

  /**
   * Load search parameters from a specific path
   */
  loadSearchParametersFrom(searchParamPath) {
    const searchParameters = [];

    if (!fs.existsSync(searchParamPath)) {
      this.log.warn(`Search parameters path does not exist: ${searchParamPath}`);
      return searchParameters;
    }

    const stat = fs.statSync(searchParamPath);

    if (stat.isDirectory()) {
      const jsonFiles = this.findJsonFiles(searchParamPath);
      for (const filePath of jsonFiles) {
        this.loadSearchParamsFromFile(filePath, searchParameters);
      }
    } else if (stat.isFile()) {
      this.loadSearchParamsFromFile(searchParamPath, searchParameters);
    }

    return searchParameters;
  }

  /**
   * Load search parameters from a single file
   */
  loadSearchParamsFromFile(filePath, searchParameters) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(content);

      if (parsed.resourceType === 'Bundle' && parsed.entry) {
        for (const entry of parsed.entry) {
          if (entry.resource && entry.resource.resourceType === 'SearchParameter') {
            searchParameters.push(entry.resource);
          }
        }
      } else if (parsed.resourceType === 'SearchParameter') {
        searchParameters.push(parsed);
      }
    } catch (err) {
      this.log.warn(`Failed to parse search params from ${filePath}: ${err.message}`);
    }
  }

  /**
   * Categorize a resource as either a SearchParameter or a regular resource
   */
  categorizeResource(resource, resources, searchParameters) {
    if (resource.resourceType === 'SearchParameter') {
      searchParameters.push(resource);
    } else {
      resources.push(resource);
    }
  }

  /**
   * Recursively find all JSON files in a directory
   */
  findJsonFiles(dir) {
    const files = [];

    if (!fs.existsSync(dir)) {
      this.log.warn(`Directory does not exist: ${dir}`);
      return files;
    }

    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) {
      this.log.warn(`Path is not a directory: ${dir}`);
      return files;
    }

    const entries = fs.readdirSync(dir);

    for (const entry of entries) {
      // Skip hidden files and node_modules
      if (entry.startsWith('.') || entry === 'node_modules') {
        continue;
      }

      const fullPath = path.join(dir, entry);
      const entryStat = fs.statSync(fullPath);

      if (entryStat.isDirectory()) {
        files.push(...this.findJsonFiles(fullPath));
      } else if (entryStat.isFile() && path.extname(entry).toLowerCase() === '.json') {
        files.push(fullPath);
      }
    }

    return files;
  }

  /**
   * Stop watching
   */
  stop() {
    if (this.watcher) {
      this.watcher.close().catch((err) => this.log.error('Error closing watcher: ' + err.message));
      this.watcher = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    // Clean up temp directory
    if (this.extractDir && fs.existsSync(this.extractDir)) {
      try {
        fs.rmSync(this.extractDir, { recursive: true, force: true });
        this.log.info(`Cleaned up temp directory: ${this.extractDir}`);
      } catch (err) {
        this.log.warn(`Failed to clean up temp directory: ${err.message}`);
      }
    }
  }
}

module.exports = PackageWatcher;
