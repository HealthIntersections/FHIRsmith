const path = require('path');
const fs = require('fs');

class FolderSetup {
  constructor() {
    this._dataDir = null;
    this._initialized = false;
  }

  init(dataDir = null) {
    if (this._initialized) {
      return this;
    }

    const configured = dataDir || process.env.FHIRSMITH_DATA_DIR || path.join(__dirname, '..', 'data');
    if (typeof configured !== 'string') {
      throw new Error('Invalid data directory: expected a path, got ' + typeof configured);
    }
    // Absolute from here on: these paths are handed to child processes that run with a different
    // working directory (the IG Publisher, git, sushi), and the IG Publisher refuses relative paths.
    // A relative FHIRSMITH_DATA_DIR is taken relative to the directory the server was started in.
    this._dataDir = path.resolve(configured);
    fs.mkdirSync(this._dataDir, { recursive: true });
    this._initialized = true;

    return this;
  }

  dataDir() {
    if (!this._initialized) {
      this.init();
    }
    return this._dataDir;
  }

  subDir(name) {
    const dir = path.join(this.dataDir(), name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  filePath(...relativePath) {
    return path.join(this.dataDir(), ...relativePath);
  }

  ensureFilePath(...relativePath) {
    const filePath = path.join(this.dataDir(), ...relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    return filePath;
  }

  ensureFolder(...relativePath) {
    const dirPath = path.join(this.dataDir(), ...relativePath);
    fs.mkdirSync(dirPath, { recursive: true });
    return dirPath;
  }

  logsDir() {
    return this.subDir('logs');
  }

  cacheDir() {
    return this.subDir('cache');
  }

  databasesDir() {
    return this.subDir('databases');
  }
}

module.exports = new FolderSetup();