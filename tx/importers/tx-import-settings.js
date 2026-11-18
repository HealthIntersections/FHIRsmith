const fs = require('fs');
const path = require('path');
const os = require('os');
const terminal = require('./terminal');

/**
 * Manages persistent configuration for terminology import tools
 * Remembers previous inputs and uses them as defaults
 */
class ConfigManager {
  constructor() {
    this.configDir = path.join(os.homedir(), '.tx-import');
    this.configFile = path.join(this.configDir, 'config.json');
    this.historyFile = path.join(this.configDir, 'history.json');
    this.config = {};
    this.history = {};

    this.ensureConfigDir();
    this.loadConfig();
    this.loadHistory();
  }

  ensureConfigDir() {
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true });
    }
  }

  loadConfig() {
    try {
      if (fs.existsSync(this.configFile)) {
        this.config = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
      }
    } catch (error) {
      terminal.warn(`Warning: Could not load config: ${error.message}`);
      this.config = {};
    }
  }

  loadHistory() {
    try {
      if (fs.existsSync(this.historyFile)) {
        this.history = JSON.parse(fs.readFileSync(this.historyFile, 'utf8'));
      }
    } catch (error) {
      terminal.warn(`Warning: Could not load history: ${error.message}`);
      this.history = {};
    }
  }

  saveConfig() {
    try {
      fs.writeFileSync(this.configFile, JSON.stringify(this.config, null, 2));
    } catch (error) {
      terminal.warn(`Warning: Could not save config: ${error.message}`);
    }
  }

  saveHistory() {
    try {
      fs.writeFileSync(this.historyFile, JSON.stringify(this.history, null, 2));
    } catch (error) {
      terminal.warn(`Warning: Could not save history: ${error.message}`);
    }
  }

  /**
   * Get previous value for a specific terminology and field
   * @param {string} terminology - e.g., 'unii', 'loinc'
   * @param {string} field - e.g., 'source', 'dest', 'version'
   * @returns {string|null} Previous value or null if not found
   */
  getPreviousValue(terminology, field) {
    return this.history[terminology]?.[field] || null;
  }

  /**
   * Get all previous values for a terminology
   * @param {string} terminology
   * @returns {object} Object with all previous values
   */
  getPreviousConfig(terminology) {
    return this.history[terminology] || {};
  }

  /**
   * Remember a successful configuration
   * @param {string} terminology
   * @param {object} config
   */
  rememberConfig(terminology, config) {
    if (!this.history[terminology]) {
      this.history[terminology] = {};
    }

    // Store important fields
    const fieldsToRemember = ['source', 'dest', 'version', 'languages', 'overwrite', 'verbose'];

    fieldsToRemember.forEach(field => {
      if (config[field] !== undefined) {
        this.history[terminology][field] = config[field];
      }
    });

    // Store timestamp of last use
    this.history[terminology].lastUsed = new Date().toISOString();

    this.saveHistory();
  }

  /**
   * Get recent source directories for a terminology
   * @param {string} terminology
   * @param {number} limit
   * @returns {string[]} Array of recent source paths
   */
  getRecentSources(terminology, limit = 5) {
    const termHistory = this.history[terminology];
    if (!termHistory || !termHistory.recentSources) {
      return [];
    }

    return termHistory.recentSources.slice(0, limit);
  }

  /**
   * Remember a source path
   * @param {string} terminology
   * @param {string} sourcePath
   */
  rememberSource(terminology, sourcePath) {
    if (!this.history[terminology]) {
      this.history[terminology] = {};
    }

    if (!this.history[terminology].recentSources) {
      this.history[terminology].recentSources = [];
    }

    const sources = this.history[terminology].recentSources;

    // Remove if already exists
    const index = sources.indexOf(sourcePath);
    if (index > -1) {
      sources.splice(index, 1);
    }

    // Add to front
    sources.unshift(sourcePath);

    // Keep only last 10
    this.history[terminology].recentSources = sources.slice(0, 10);

    this.saveHistory();
  }

  /**
   * Clear history for a specific terminology
   * @param {string} terminology
   */
  clearHistory(terminology) {
    if (this.history[terminology]) {
      delete this.history[terminology];
      this.saveHistory();
    }
  }

  /**
   * Clear all history
   */
  clearAllHistory() {
    this.history = {};
    this.saveHistory();
  }

  /**
   * Get global preferences
   * @param {string} key
   * @param {any} defaultValue
   * @returns {any}
   */
  getPreference(key, defaultValue = null) {
    return this.config[key] !== undefined ? this.config[key] : defaultValue;
  }

  /**
   * Set global preference
   * @param {string} key
   * @param {any} value
   */
  setPreference(key, value) {
    this.config[key] = value;
    this.saveConfig();
  }

  /**
   * Generate intelligent defaults based on previous usage
   * @param {string} terminology
   * @returns {object} Suggested defaults
   */
  generateDefaults(terminology) {
    const previous = this.getPreviousConfig(terminology);
    const defaults = {};

    // Default source - use most recent
    if (previous.source) {
      defaults.source = previous.source;
    }

    // Default destination - increment version or use pattern
    if (previous.dest) {
      defaults.dest = this.suggestNextDestination(previous.dest, terminology);
    } else {
      defaults.dest = `./data/${terminology}.db`;
    }

    // Default version - increment or use date pattern
    if (previous.version) {
      defaults.version = this.suggestNextVersion(previous.version, terminology);
    } else {
      const date = new Date().toISOString().split('T')[0];
      defaults.version = `${terminology.toUpperCase()}-${date}`;
    }

    // Inherit boolean preferences
    if (previous.verbose !== undefined) defaults.verbose = previous.verbose;
    if (previous.overwrite !== undefined) defaults.overwrite = previous.overwrite;
    if (previous.languages !== undefined) defaults.languages = previous.languages;

    return defaults;
  }

  suggestNextDestination(previousDest) {
    // If previous dest was versioned, suggest incrementing
    const versionMatch = previousDest.match(/-v(\d+)\.db$/);
    if (versionMatch) {
      const nextVersion = parseInt(versionMatch[1]) + 1;
      return previousDest.replace(/-v\d+\.db$/, `-v${nextVersion}.db`);
    }

    // If it had a date, suggest today's date
    const dateMatch = previousDest.match(/-(\d{4}-\d{2}-\d{2})\.db$/);
    if (dateMatch) {
      const today = new Date().toISOString().split('T')[0];
      return previousDest.replace(/-\d{4}-\d{2}-\d{2}\.db$/, `-${today}.db`);
    }

    // Otherwise, just return the same path
    return previousDest;
  }

  suggestNextVersion(previousVersion) {
    // If version has a date, suggest today's date
    const dateMatch = previousVersion.match(/-(\d{4}-\d{2}-\d{2})$/);
    if (dateMatch) {
      const today = new Date().toISOString().split('T')[0];
      return previousVersion.replace(/-\d{4}-\d{2}-\d{2}$/, `-${today}`);
    }

    // If version has a number, increment it
    const numberMatch = previousVersion.match(/-(\d+)$/);
    if (numberMatch) {
      const nextNumber = parseInt(numberMatch[1]) + 1;
      return previousVersion.replace(/-\d+$/, `-${nextNumber}`);
    }

    // Otherwise, add today's date
    const today = new Date().toISOString().split('T')[0];
    return `${previousVersion}-${today}`;
  }

  /**
   * Export configuration for backup
   * @returns {object} Complete configuration
   */
  exportConfig() {
    return {
      config: this.config,
      history: this.history,
      exportDate: new Date().toISOString()
    };
  }

  /**
   * Import configuration from backup
   * @param {object} data
   */
  importConfig(data) {
    if (data.config) {
      this.config = { ...this.config, ...data.config };
      this.saveConfig();
    }

    if (data.history) {
      this.history = { ...this.history, ...data.history };
      this.saveHistory();
    }
  }
}

// Singleton instance
let configManagerInstance = null;

function getConfigManager() {
  if (!configManagerInstance) {
    configManagerInstance = new ConfigManager();
  }
  return configManagerInstance;
}

module.exports = { ConfigManager, getConfigManager };