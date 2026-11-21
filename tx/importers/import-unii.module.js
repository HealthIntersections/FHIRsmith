const { BaseTerminologyModule } = require('./tx-import-base');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const path = require("path");
const readline = require("readline");
const terminal = require('./terminal');

class UniiModule extends BaseTerminologyModule {
  getName() {
    return 'unii';
  }

  getDescription() {
    return 'Unique Ingredient Identifier (UNII) from FDA';
  }

  getSupportedFormats() {
    return ['txt', 'tsv'];
  }

  getEstimatedDuration() {
    return '15-45 minutes (depending on file size)';
  }

  registerCommands(terminologyCommand, globalOptions) {
    // Import command
    terminologyCommand
      .command('import')
      .description('Import UNII data from tab-delimited file')
      .option('-s, --source <file>', 'Source tab-delimited file')
      .option('-d, --dest <file>', 'Destination SQLite database')
      .option('-v, --version <version>', 'Data version identifier')
      .option('-y, --yes', 'Skip confirmations')
      .option('--no-indexes', 'Skip index creation for faster import')
      .action(async (options) => {
        await this.handleImportCommand({...globalOptions, ...options});
      });

    // Validate command
    terminologyCommand
      .command('validate')
      .description('Validate UNII source file format')
      .option('-s, --source <file>', 'Source file to validate')
      .option('--sample <lines>', 'Number of lines to sample for validation', '100')
      .action(async (options) => {
        await this.handleValidateCommand({...globalOptions, ...options});
      });

    // Status command
    terminologyCommand
      .command('status')
      .description('Show status of UNII database')
      .option('-d, --dest <file>', 'Database file to check')
      .action(async (options) => {
        await this.handleStatusCommand({...globalOptions, ...options});
      });
  }

  async handleImportCommand(options) {
    // Gather configuration
    const config = await this.gatherCommonConfig(options);
    
    // UNII-specific configuration
    if (!config.createIndexes && options.noIndexes) {
      config.createIndexes = false;
    }

    // Show confirmation unless --yes is specified
    if (!options.yes) {
      const confirmed = await this.confirmImport(config);
      if (!confirmed) {
        this.logInfo('Import cancelled');
        return;
      }
    }

    // Run the import
    await this.runImport(config);
  }

  async confirmImport(config) {
    const inquirer = require('inquirer');
    const chalk = require('chalk');

    terminal.log(chalk.cyan(`\n📋 ${this.getName()} Import Configuration:`));
    terminal.log(`  Source: ${chalk.white(config.source)}`);
    terminal.log(`  Destination: ${chalk.white(config.dest)}`);
    terminal.log(`  Version: ${chalk.white(config.version)}`);
    terminal.log(`  Create Indexes: ${chalk.white(config.createIndexes ? 'Yes' : 'No')}`);
    terminal.log(`  Overwrite: ${chalk.white(config.overwrite ? 'Yes' : 'No')}`);
    terminal.log(`  Verbose: ${chalk.white(config.verbose ? 'Yes' : 'No')}`);

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

  async handleValidateCommand(options) {
    if (!options.source) {
      const answers = await require('inquirer').prompt({
        type: 'input',
        name: 'source',
        message: 'Source file to validate:',
        validate: (input) => input && fs.existsSync(input) ? true : 'File does not exist'
      });
      options.source = answers.source;
    }

    this.logInfo(`Validating UNII file: ${options.source}`);
    
    try {
      const stats = await this.validateUniiFile(options.source, parseInt(options.sample));
      
      this.logSuccess('File validation passed');
      terminal.log(`  Lines: ${stats.totalLines}`);
      terminal.log(`  Estimated UNII codes: ${stats.estimatedCodes}`);
      terminal.log(`  Estimated descriptions: ${stats.estimatedDescriptions}`);
      terminal.log(`  Sample data format: ${stats.formatValid ? 'Valid' : 'Invalid'}`);
      
      if (stats.warnings.length > 0) {
        this.logWarning('Validation warnings:');
        stats.warnings.forEach(warning => terminal.log(`    ${warning}`));
      }
      
    } catch (error) {
      this.logError(`Validation failed: ${error.message}`);
    }
  }

  async handleStatusCommand(options) {
    const dbPath = options.dest || './data/unii.db';
    
    if (!fs.existsSync(dbPath)) {
      this.logError(`Database not found: ${dbPath}`);
      return;
    }

    this.logInfo(`Checking UNII database: ${dbPath}`);
    
    try {
      const stats = await this.getDatabaseStats(dbPath);
      
      this.logSuccess('Database status:');
      terminal.log(`  Version: ${stats.version}`);
      terminal.log(`  UNII Codes: ${stats.uniiCount.toLocaleString()}`);
      terminal.log(`  Descriptions: ${stats.descCount.toLocaleString()}`);
      terminal.log(`  Database Size: ${stats.sizeGB.toFixed(2)} GB`);
      terminal.log(`  Last Modified: ${stats.lastModified}`);
      
    } catch (error) {
      this.logError(`Status check failed: ${error.message}`);
    }
  }

  async validatePrerequisites(config) {
    const baseValid = await super.validatePrerequisites(config);
    
    // UNII-specific validation
    try {
      this.logInfo('Validating UNII file format...');
      await this.validateUniiFile(config.source, 10);
      this.logSuccess('UNII file format valid');
    } catch (error) {
      this.logError(`UNII file validation failed: ${error.message}`);
      return false;
    }

    return baseValid;
  }

  async executeImport(config) {
    this.logInfo('Starting UNII data migration...');
    
    const migrator = new UniiDataMigrator();
    
    // Create enhanced migrator with progress reporting
    const enhancedMigrator = new UniiDataMigratorWithProgress(
      migrator, 
      this,
      config.verbose
    );
    
    await enhancedMigrator.migrate(
      config.source,
      config.dest,
      config.version,
      config.verbose
    );

    if (config.createIndexes) {
      this.logInfo('Creating database indexes...');
      await this.createIndexes(config.dest);
      this.logSuccess('Indexes created');
    }
  }

  async validateUniiFile(filePath, sampleLines = 100) {
    const readline = require('readline');
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    let lineCount = 0;
    let sampleCount = 0;
    let estimatedCodes = new Set();
    let estimatedDescriptions = 0;
    const warnings = [];
    let formatValid = true;

    for await (const line of rl) {
      lineCount++;
      
      if (sampleCount < sampleLines) {
        // Validate format: should be tab-delimited with at least 3 columns
        const cols = line.split('\t');
        
        if (lineCount === 1) {
          // Skip header if it looks like one
          if (cols[0].toLowerCase().includes('display') || 
              cols[0].toLowerCase().includes('name')) {
            continue;
          }
        }

        if (cols.length < 3) {
          warnings.push(`Line ${lineCount}: Expected at least 3 columns, found ${cols.length}`);
          if (sampleCount < 5) formatValid = false; // Only fail on early errors
        } else {
          const code = cols[2];
          if (code && code.length === 10) {
            estimatedCodes.add(code);
          }
          estimatedDescriptions++;
        }
        
        sampleCount++;
      }
    }

    return {
      totalLines: lineCount,
      estimatedCodes: estimatedCodes.size,
      estimatedDescriptions,
      formatValid,
      warnings
    };
  }

  async getDatabaseStats(dbPath) {
    const sqlite3 = require('sqlite3').verbose();
    const db = new sqlite3.Database(dbPath);

    return new Promise((resolve, reject) => {
      const stats = {};
      
      // Get version
      db.get('SELECT Version FROM UniiVersion LIMIT 1', (err, row) => {
        if (err) return reject(err);
        stats.version = row ? row.Version : 'Unknown';
        
        // Get counts
        db.get('SELECT COUNT(*) as count FROM Unii', (err, row) => {
          if (err) return reject(err);
          stats.uniiCount = row.count;
          
          db.get('SELECT COUNT(*) as count FROM UniiDesc', (err, row) => {
            if (err) return reject(err);
            stats.descCount = row.count;
            
            // Get file stats
            const fileStat = fs.statSync(dbPath);
            stats.sizeGB = fileStat.size / (1024 * 1024 * 1024);
            stats.lastModified = fileStat.mtime.toISOString();
            
            db.close();
            resolve(stats);
          });
        });
      });
    });
  }

  async createIndexes(dbPath) {
    const sqlite3 = require('sqlite3').verbose();
    const db = new sqlite3.Database(dbPath);

    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_unii_code ON Unii(Code)',
      'CREATE INDEX IF NOT EXISTS idx_uniidesc_uniikey ON UniiDesc(UniiKey)',
      'CREATE INDEX IF NOT EXISTS idx_uniidesc_type ON UniiDesc(Type)'
    ];

    return new Promise((resolve, reject) => {
      db.serialize(() => {
        indexes.forEach(sql => {
          db.run(sql, (err) => {
            if (err) terminal.warn(`Index creation warning: ${err.message}`);
          });
        });
      });
      
      db.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

class UniiDataMigrator {
  /**
   * Migrates UNII data from tab-delimited source file to SQLite database
   * @param {string} sourceFile - Path to tab-delimited source file
   * @param {string} destFile - Path to destination SQLite database file
   * @param {string} version - Version string to store in database
   * @param {boolean} verbose - Whether to log progress messages
   * @returns {Promise<void>}
   */
  async migrate(sourceFile, destFile, version = 'unknown', verbose = true) {
    if (verbose) terminal.log('Starting UNII data migration...');

    // Ensure destination directory exists
    const destDir = path.dirname(destFile);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    // Remove existing database file if it exists
    if (fs.existsSync(destFile)) {
      fs.unlinkSync(destFile);
    }

    // Create new SQLite database
    const db = new sqlite3.Database(destFile);

    try {
      // Create tables
      await this.#createTables(db, version, verbose);

      // Process source file
      await this.#processSourceFile(db, sourceFile, verbose);

      if (verbose) terminal.log('UNII data migration completed successfully');
    } finally {
      await this.#closeDatabase(db, verbose);
    }
  }

  /**
   * Creates the required database tables
   * @private
   */
  async #createTables(db, version, verbose = true) {
    if (verbose) terminal.log('Creating database tables...');

    return new Promise((resolve, reject) => {
      db.serialize(() => {
        // Create Unii table
        db.run(`
            CREATE TABLE Unii (
                                  UniiKey INTEGER NOT NULL PRIMARY KEY,
                                  Code TEXT(20) NOT NULL,
                                  Display TEXT(255) NULL
            )
        `, (err) => {
          if (err) return reject(err);
        });

        // Create UniiDesc table
        db.run(`
            CREATE TABLE UniiDesc (
                                      UniiDescKey INTEGER NOT NULL PRIMARY KEY,
                                      UniiKey INTEGER NOT NULL,
                                      Type TEXT(20) NOT NULL,
                                      Display TEXT(255) NULL
            )
        `, (err) => {
          if (err) return reject(err);
        });

        // Create UniiVersion table
        db.run(`
            CREATE TABLE UniiVersion (
                                         Version TEXT(20) NOT NULL
            )
        `, (err) => {
          if (err) return reject(err);
        });

        // Insert version
        db.run('INSERT INTO UniiVersion (Version) VALUES (?)', [version], (err) => {
          if (err) return reject(err);
          if (verbose) terminal.log('Database tables created');
          resolve();
        });
      });
    });
  }

  /**
   * Processes the tab-delimited source file
   * @private
   */
  async #processSourceFile(db, sourceFile, verbose = true) {
    if (verbose) terminal.log('Processing source file:', sourceFile);

    if (!fs.existsSync(sourceFile)) {
      throw new Error(`Source file not found: ${sourceFile}`);
    }

    // Read all lines first using streaming (for memory efficiency)
    const lines = [];
    const fileStream = fs.createReadStream(sourceFile);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });

    await new Promise((resolve, reject) => {
      rl.on('line', (line) => {
        lines.push(line);
      });
      rl.on('close', resolve);
      rl.on('error', reject);
    });

    if (lines.length === 0) {
      throw new Error('Source file is empty');
    }

    if (verbose) terminal.log(`Read ${lines.length} lines, processing...`);

    // Track processed codes and auto-increment keys
    const codeMap = new Map(); // code -> UniiKey
    let lastUniiKey = 0;
    let lastUniiDescKey = 0;
    let processedLines = 0;

    const BATCH_SIZE = 1000;

    // Process batches sequentially
    for (let batchStart = 1; batchStart < lines.length; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, lines.length);

      await new Promise((resolve, reject) => {
        const insertUnii = db.prepare('INSERT INTO Unii (UniiKey, Code, Display) VALUES (?, ?, ?)');
        const insertUniiDesc = db.prepare('INSERT INTO UniiDesc (UniiDescKey, UniiKey, Type, Display) VALUES (?, ?, ?, ?)');

        db.serialize(() => {
          db.run('BEGIN TRANSACTION');

          for (let i = batchStart; i < batchEnd; i++) {
            const line = lines[i].trim();
            if (!line) continue; // Skip empty lines

            const cols = line.split('\t');

            // Need at least 3 columns (Display, Type, Code)
            if (cols.length < 3) {
              if (verbose) terminal.warn(`Skipping line ${i + 1}: insufficient columns`);
              continue;
            }

            const display = cols[0] || '';
            const type = cols[1] || '';
            const code = cols[2] || '';

            if (!code) {
              if (verbose) terminal.warn(`Skipping line ${i + 1}: empty UNII code`);
              continue;
            }

            // Get or create UniiKey for this code
            let uniiKey = codeMap.get(code);
            if (!uniiKey) {
              lastUniiKey++;
              uniiKey = lastUniiKey;
              insertUnii.run(uniiKey, code, cols[3]);
              codeMap.set(code, uniiKey);
            }

            lastUniiDescKey++;
            insertUniiDesc.run(lastUniiDescKey, uniiKey, type, display);

            processedLines++;
          }

          db.run('COMMIT', (err) => {
            if (err) return reject(err);

            insertUnii.finalize((err) => {
              if (err) return reject(err);
              insertUniiDesc.finalize((err) => {
                if (err) return reject(err);
                resolve();
              });
            });
          });
        });
      });

      if (processedLines % 10000 === 0) {
        terminal.log(`Processed ${processedLines} lines...`);
      }
    }

    if (verbose) {
      terminal.log(`Processing completed. Total lines processed: ${processedLines}`);
      terminal.log(`Unique UNII codes: ${codeMap.size}`);
      terminal.log(`Total descriptions: ${lastUniiDescKey}`);
    }
  }

  /**
   * Closes the database connection
   * @private
   */
  async #closeDatabase(db, verbose = true) {
    return new Promise((resolve) => {
      db.close((err) => {
        if (err && verbose) {
          terminal.error('Error closing database:', err);
        }
        resolve();
      });
    });
  }
}

// Enhanced migrator with progress reporting
class UniiDataMigratorWithProgress {
  constructor(migrator, moduleInstance, verbose = true) {
    this.migrator = migrator;
    this.module = moduleInstance;
    this.verbose = verbose;
  }

  async migrate(sourceFile, destFile, version, verbose) {
    // Count total lines for progress bar
    const totalLines = await this.countLines(sourceFile);
    
    this.module.logInfo(`Processing ${totalLines.toLocaleString()} lines...`);
    this.module.createProgressBar();
    this.module.updateProgress(0, totalLines);

    // Enhance the original migrator to report progress
    const originalMigrator = this.migrator;
    let processedLines = 0;
    
    // Override the progress reporting in the original migrator
    const originalLog = terminal.log;
    terminal.log = (...args) => {
      const message = args.join(' ');
      if (message.includes('Processed') && message.includes('lines')) {
        const match = message.match(/Processed (\d+) lines/);
        if (match) {
          processedLines = parseInt(match[1]);
          this.module.updateProgress(processedLines);
        }
      }
      if (verbose) originalLog(...args);
    };

    try {
      await originalMigrator.migrate(sourceFile, destFile, version, verbose);
    } finally {
      terminal.log = originalLog;
      this.module.stopProgress();
    }
  }

  async countLines(filePath) {
    return new Promise((resolve, reject) => {
      let lineCount = 0;
      const rl = require('readline').createInterface({
        input: fs.createReadStream(filePath),
        crlfDelay: Infinity
      });

      rl.on('line', () => lineCount++);
      rl.on('close', () => resolve(lineCount));
      rl.on('error', reject);
    });
  }
}


module.exports = {
  UniiModule,
  UniiDataMigrator
};
