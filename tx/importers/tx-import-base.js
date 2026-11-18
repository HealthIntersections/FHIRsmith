const inquirer = require('inquirer');
const chalk = require('chalk');
const cliProgress = require('cli-progress');
const fs = require('fs');
const path = require('path');
const { getConfigManager } = require('./tx-import-settings');
const terminal = require('./terminal');

/**
 * Base class for terminology import modules
 * All terminology importers should extend this class
 */
class BaseTerminologyModule {
  constructor() {
    this.progressBar = null;
    this.configManager = getConfigManager();
  }

  // Abstract methods - must be implemented by subclasses
  getName() {
    throw new Error('getName() must be implemented by subclass');
  }

  getDescription() {
    throw new Error('getDescription() must be implemented by subclass');
  }

  // eslint-disable-next-line no-unused-vars
  registerCommands(terminologyCommand, globalOptions) {
    throw new Error('registerCommands() must be implemented by subclass');
  }

  // Optional methods - can be overridden by subclasses
  getSupportedFormats() {
    return ['txt', 'csv', 'tsv'];
  }

  getEstimatedDuration() {
    return 'varies';
  }

  getDefaultConfig() {
    return {
      verbose: true,
      overwrite: false,
      createIndexes: true
    };
  }

  // Common utility methods available to all modules
  async gatherCommonConfig(options = {}) {
    const terminology = this.getName();

    // Get intelligent defaults based on previous usage
    const smartDefaults = this.configManager.generateDefaults(terminology);
    const recentSources = this.configManager.getRecentSources(terminology, 3);

    const questions = [];

    // Source file/directory
    if (!options.source) {
      // If we have recent sources, offer them as choices
      if (recentSources.length > 0) {
        questions.push({
          type: 'list',
          name: 'sourceChoice',
          message: `Select source for ${terminology}:`,
          choices: [
            ...recentSources.map(src => ({
              name: `${src} ${src === smartDefaults.source ? '(last used)' : ''}`.trim(),
              value: src
            })),
            { name: 'Enter new path...', value: 'NEW_PATH' }
          ]
        });

        // Follow up question for new path
        questions.push({
          type: 'input',
          name: 'newSource',
          message: `Enter new source path for ${terminology}:`,
          when: (answers) => answers.sourceChoice === 'NEW_PATH',
          validate: (input) => {
            if (!input) return 'Source is required';
            if (!fs.existsSync(input)) return 'Source path does not exist';
            return true;
          },
          filter: (input) => path.resolve(input)
        });
      } else {
        // No recent sources, just ask for input directly
        questions.push({
          type: 'input',
          name: 'source',
          message: `Source file/directory for ${terminology}:`,
          default: smartDefaults.source,
          validate: (input) => {
            if (!input) return 'Source is required';
            if (!fs.existsSync(input)) return 'Source path does not exist';
            return true;
          },
          filter: (input) => path.resolve(input)
        });
      }
    }

    // Destination database
    if (!options.dest) {
      questions.push({
        type: 'input',
        name: 'dest',
        message: 'Destination database path:',
        default: smartDefaults.dest || `./data/${terminology}.db`,
        validate: (input) => {
          if (!input) return 'Destination path is required';
          const dir = path.dirname(input);
          if (!fs.existsSync(dir)) {
            return `Directory does not exist: ${dir}`;
          }
          return true;
        },
        filter: (input) => path.resolve(input)
      });
    }

    // Overwrite confirmation
    questions.push({
      type: 'confirm',
      name: 'overwrite',
      message: 'Overwrite existing database if it exists?',
      default: smartDefaults.overwrite !== undefined ? smartDefaults.overwrite : false,
      when: (answers) => {
        const destPath = options.dest || answers.dest;
        return fs.existsSync(destPath);
      }
    });

    questions.push({
      type: 'confirm',
      name: 'verbose',
      message: 'Show verbose progress output?',
      default: smartDefaults.verbose !== undefined ? smartDefaults.verbose : true
    });

    const answers = await inquirer.prompt(questions);

    // Handle source selection logic
    let finalSource = options.source;
    if (!finalSource) {
      if (answers.sourceChoice === 'NEW_PATH') {
        finalSource = answers.newSource;
      } else if (answers.sourceChoice) {
        finalSource = answers.sourceChoice;
      } else {
        finalSource = answers.source;
      }
    }

    const finalConfig = {
      ...this.getDefaultConfig(),
      ...smartDefaults,
      ...options,
      ...answers,
      source: finalSource
    };

    return finalConfig;
  }

  async confirmImport(config) {
    terminal.log(chalk.cyan(`\n📋 ${this.getName()} Import Configuration:`));
    terminal.log(`  Source: ${chalk.white(config.source)}`);
    terminal.log(`  Destination: ${chalk.white(config.dest)}`);
    terminal.log(`  Version: ${chalk.white(config.version || 'Not specified')}`);
    terminal.log(`  Overwrite: ${chalk.white(config.overwrite ? 'Yes' : 'No')}`);

    if (config.estimatedDuration) {
      terminal.log(`  Estimated Duration: ${chalk.white(config.estimatedDuration)}`);
    }

    const { confirmed } = await inquirer.prompt({
      type: 'confirm',
      name: 'confirmed',
      message: 'Proceed with import?',
      default: true
    });

    return confirmed;
  }

  createProgressBar(format = null) {
    const defaultFormat = chalk.cyan('Progress') + ' |{bar}| {percentage}% | {value}/{total} | ETA: {eta}s';

    this.progressBar = new cliProgress.SingleBar({
      format: format || defaultFormat,
      barCompleteChar: '█',
      barIncompleteChar: '░',
      hideCursor: true
    });

    return this.progressBar;
  }

  updateProgress(current, total = null) {
    if (this.progressBar) {
      if (total !== null) {
        this.progressBar.start(total, current);
      } else {
        this.progressBar.update(current);
      }
    }
  }

  stopProgress() {
    if (this.progressBar) {
      this.progressBar.stop();
      this.progressBar = null;
    }
  }

  logInfo(message) {
    terminal.log(chalk.blue('ℹ'), message);
  }

  logSuccess(message) {
    terminal.log(chalk.green('✓'), message);
  }

  logWarning(message) {
    terminal.log(chalk.yellow('⚠'), message);
  }

  logError(message) {
    terminal.log(chalk.red('✗'), message);
  }

  async validatePrerequisites(config) {
    // Base validation - can be extended by subclasses
    const checks = [
      {
        name: 'Source exists',
        check: () => fs.existsSync(config.source)
      },
      {
        name: 'Destination directory writable',
        check: () => {
          const dir = path.dirname(config.dest);
          return fs.existsSync(dir);
        }
      }
    ];

    let allPassed = true;

    for (const { name, check } of checks) {
      try {
        const passed = await check();
        if (passed) {
          this.logSuccess(name);
        } else {
          this.logError(name);
          allPassed = false;
        }
      } catch (error) {
        this.logError(`${name}: ${error.message}`);
        allPassed = false;
      }
    }

    return allPassed;
  }

  // Helper method for batch processing with progress updates
  async processBatch(items, batchSize, processor, progressMessage = 'Processing') {
    const total = items.length;
    let processed = 0;

    this.createProgressBar(
      chalk.cyan(progressMessage) + ' |{bar}| {percentage}% | {value}/{total} items'
    );
    this.updateProgress(0, total);

    for (let i = 0; i < total; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      await processor(batch);
      processed += batch.length;
      this.updateProgress(processed);
    }

    this.stopProgress();
    return processed;
  }

  // Abstract method for actual import logic
  // eslint-disable-next-line no-unused-vars
  async executeImport(config) {
    throw new Error('executeImport() must be implemented by subclass');
  }

  // Common import workflow
  async runImport(config) {
    try {
      terminal.log(chalk.blue.bold(`🏥 Starting ${this.getName()} Import...\n`));

      // Pre-flight checks
      this.logInfo('Running pre-flight checks...');
      const prerequisitesPassed = await this.validatePrerequisites(config);

      if (!prerequisitesPassed) {
        throw new Error('Pre-flight checks failed');
      }

      // Execute the import
      await this.executeImport(config);

      // Remember successful configuration for future use
      this.rememberSuccessfulConfig(config);

      this.logSuccess(`${this.getName()} import completed successfully!`);

    } catch (error) {
      this.stopProgress(); // Ensure progress bar is cleaned up
      this.logError(`${this.getName()} import failed: ${error.message}`);
      if (config.verbose) {
        terminal.error(error.stack);
      }
      process.exit(1);
    }
  }

  // Remember successful configuration
  rememberSuccessfulConfig(config) {
    try {
      const terminology = this.getName();

      // Remember the source path in recent sources
      if (config.source) {
        this.configManager.rememberSource(terminology, config.source);
      }

      // Remember the full configuration
      this.configManager.rememberConfig(terminology, config);

      this.logInfo('Configuration saved for future use');
    } catch (error) {
      // Don't fail the import if we can't save config
      this.logWarning(`Could not save configuration: ${error.message}`);
    }
  }
}

module.exports = { BaseTerminologyModule };