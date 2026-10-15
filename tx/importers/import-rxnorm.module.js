const { BaseTerminologyModule } = require('./tx-import-base');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const readline = require('readline');
const chalk = require('chalk');

class RxNormModule extends BaseTerminologyModule {
  constructor() {
    super();
  }

  getName() {
    return 'rxnorm';
  }

  getDescription() {
    return 'RxNorm prescribable drug nomenclature from the National Library of Medicine';
  }

  getSupportedFormats() {
    return ['rrf', 'directory'];
  }

  getDefaultConfig() {
    return {
      ...super.getDefaultConfig(),
      createIndexes: true,
      createStems: true,
      dest: './data/rxnorm.db'
    };
  }

  getEstimatedDuration() {
    return '15-45 minutes (depending on stem generation)';
  }

  registerCommands(terminologyCommand, globalOptions) {
    // Import command
    terminologyCommand
      .command('import')
      .description('Import RxNorm data from source directory')
      .option('-s, --source <directory>', 'Source directory containing RRF files')
      .option('-d, --dest <file>', 'Destination SQLite database')
      .option('-v, --version <version>', 'RxNorm version identifier')
      .option('-y, --yes', 'Skip confirmations')
      .option('--no-indexes', 'Skip index creation for faster import')
      .option('--no-stems', 'Skip stem generation for faster import')
      .action(async (options) => {
        await this.handleImportCommand({...globalOptions, ...options});
      });

    // Validate command
    terminologyCommand
      .command('validate')
      .description('Validate RxNorm source directory structure')
      .option('-s, --source <directory>', 'Source directory to validate')
      .action(async (options) => {
        await this.handleValidateCommand({...globalOptions, ...options});
      });

    // Status command
    terminologyCommand
      .command('status')
      .description('Show status of RxNorm database')
      .option('-d, --dest <file>', 'Database file to check')
      .action(async (options) => {
        await this.handleStatusCommand({...globalOptions, ...options});
      });
  }

  async handleImportCommand(options) {
    try {
      // Gather configuration with remembered values
      const config = await this.gatherCommonConfig(options);

      // RxNorm-specific configuration
      config.createIndexes = !options.noIndexes;
      config.createStems = !options.noStems;
      config.estimatedDuration = this.getEstimatedDuration();

      // Auto-detect version from path if not provided
      if (!config.version) {
        config.version = this.detectVersionFromPath(config.source);
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
    } catch (error) {
      this.logError(`Import command failed: ${error.message}`);
      if (options.verbose) {
        console.error(error.stack);
      }
      throw error;
    }
  }

  detectVersionFromPath(sourcePath) {
    // Try to extract version from path like "RxNorm_full_08042025"
    const pathMatch = sourcePath.match(/RxNorm_full_(\d{8})/);
    if (pathMatch) {
      const dateStr = pathMatch[1];
      // Convert MMDDYYYY to YYYY-MM-DD format
      const month = dateStr.substring(0, 2);
      const day = dateStr.substring(2, 4);
      const year = dateStr.substring(4, 8);
      return `RXNORM-${year}-${month}-${day}`;
    }
    return 'RXNORM-UNKNOWN';
  }

  async confirmImport(config) {
    const inquirer = require('inquirer');

    console.log(chalk.cyan(`\n📋 ${this.getName()} Import Configuration:`));
    console.log(`  Source: ${chalk.white(config.source)}`);
    console.log(`  Destination: ${chalk.white(config.dest)}`);
    console.log(`  Version: ${chalk.white(config.version || 'Auto-detect')}`);
    console.log(`  Create Indexes: ${chalk.white(config.createIndexes ? 'Yes' : 'No')}`);
    console.log(`  Create Stems: ${chalk.white(config.createStems ? 'Yes' : 'No')}`);
    console.log(`  Overwrite: ${chalk.white(config.overwrite ? 'Yes' : 'No')}`);
    console.log(`  Verbose: ${chalk.white(config.verbose ? 'Yes' : 'No')}`);

    if (config.estimatedDuration) {
      console.log(`  Estimated Duration: ${chalk.white(config.estimatedDuration)}`);
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
        message: 'Source directory to validate:',
        validate: (input) => input && fs.existsSync(input) ? true : 'Directory does not exist'
      });
      options.source = answers.source;
    }

    this.logInfo(`Validating RxNorm directory: ${options.source}`);

    try {
      const stats = await this.validateRxNormDirectory(options.source);

      this.logSuccess('Directory validation passed');
      console.log(`  Required files found: ${stats.requiredFiles.length}/3`);
      console.log(`  Optional files found: ${stats.optionalFiles.length}/3`);
      console.log(`  Estimated concepts: ${stats.estimatedConcepts.toLocaleString()}`);
      console.log(`  Estimated relationships: ${stats.estimatedRelationships.toLocaleString()}`);

      if (stats.warnings.length > 0) {
        this.logWarning('Validation warnings:');
        stats.warnings.forEach(warning => console.log(`    ${warning}`));
      }

    } catch (error) {
      this.logError(`Validation failed: ${error.message}`);
    }
  }

  async handleStatusCommand(options) {
    const dbPath = options.dest || './data/rxnorm.db';

    if (!fs.existsSync(dbPath)) {
      this.logError(`Database not found: ${dbPath}`);
      return;
    }

    this.logInfo(`Checking RxNorm database: ${dbPath}`);

    try {
      const stats = await this.getDatabaseStats(dbPath);

      this.logSuccess('Database status:');
      console.log(`  Version: ${stats.version}`);
      console.log(`  RXNCONSO Records: ${stats.rxnconsoCount.toLocaleString()}`);
      console.log(`  RXNREL Records: ${stats.rxnrelCount.toLocaleString()}`);
      console.log(`  RXNSTY Records: ${stats.rxnstyCount.toLocaleString()}`);
      console.log(`  Stem Records: ${stats.stemCount.toLocaleString()}`);
      console.log(`  Database Size: ${stats.sizeGB.toFixed(2)} GB`);
      console.log(`  Last Modified: ${stats.lastModified}`);

    } catch (error) {
      this.logError(`Status check failed: ${error.message}`);
    }
  }

  async validatePrerequisites(config) {
    const baseValid = await super.validatePrerequisites(config);

    try {
      this.logInfo('Validating RxNorm directory structure...');
      await this.validateRxNormDirectory(config.source);
      this.logSuccess('RxNorm directory structure valid');
    } catch (error) {
      this.logError(`RxNorm directory validation failed: ${error.message}`);
      return false;
    }

    return baseValid;
  }

  async executeImport(config) {
    this.logInfo('Starting RxNorm data import...');

    const importer = new RxNormImporter(
      config.source,
      config.dest,
      config.version,
      {
        verbose: config.verbose,
        createStems: config.createStems,
        progressCallback: (current, operation) => {
          if (operation && this.progressBar) {
            // Update operation display
            this.progressBar.update(current, {
              operation: chalk.cyan(operation.padEnd(20).substring(0, 20))
            });
          } else if (this.progressBar) {
            this.progressBar.update(current);
          }
        }
      }
    );

    // Estimate total work for progress bar
    const totalWork = await this.estimateWorkload(config.source);

    const progressFormat = '{operation} |{bar}| {percentage}% | {value}/{total} | ETA: {eta}s';
    this.createProgressBar(progressFormat);
    this.progressBar.start(totalWork, 0, {
      operation: chalk.cyan('Starting'.padEnd(20).substring(0, 20))
    });

    try {
      await importer.import();
    } finally {
      this.stopProgress();
    }

    if (config.createIndexes) {
      this.logInfo('Creating database indexes...');
      await this.createIndexes(config.dest);
      this.logSuccess('Indexes created');
    }
  }

  async validateRxNormDirectory(sourceDir) {
    if (!fs.existsSync(sourceDir)) {
      throw new Error(`Source directory not found: ${sourceDir}`);
    }

    const requiredFiles = [
      'RXNCONSO.RRF',
      'RXNREL.RRF',
      'RXNSTY.RRF'
    ];

    const optionalFiles = [
      'RXNSAB.RRF',
      'RXNATOMARCHIVE.RRF',
      'RXNCUI.RRF'
    ];

    const warnings = [];
    let requiredFound = [];
    let optionalFound = [];
    let estimatedConcepts = 0;
    let estimatedRelationships = 0;

    // Check required files
    for (const file of requiredFiles) {
      const filePath = path.join(sourceDir, file);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Required file missing: ${file}`);
      }
      requiredFound.push(file);

      // Estimate record counts
      if (file === 'RXNCONSO.RRF') {
        estimatedConcepts = await this.countLines(filePath) - 1;
      } else if (file === 'RXNREL.RRF') {
        estimatedRelationships = await this.countLines(filePath) - 1;
      }
    }

    // Check optional files
    for (const file of optionalFiles) {
      const filePath = path.join(sourceDir, file);
      if (!fs.existsSync(filePath)) {
        warnings.push(`Optional file missing: ${file}`);
      } else {
        optionalFound.push(file);
      }
    }

    return {
      requiredFiles: requiredFound,
      optionalFiles: optionalFound,
      estimatedConcepts,
      estimatedRelationships,
      warnings
    };
  }

  async countLines(filePath) {
    return new Promise((resolve, reject) => {
      let lineCount = 0;
      const rl = readline.createInterface({
        input: fs.createReadStream(filePath),
        crlfDelay: Infinity
      });

      rl.on('line', () => lineCount++);
      rl.on('close', () => resolve(lineCount));
      rl.on('error', reject);
    });
  }

  async estimateWorkload(sourceDir) {
    let totalWork = 0;
    const files = ['RXNCONSO.RRF', 'RXNREL.RRF', 'RXNSTY.RRF', 'RXNSAB.RRF', 'RXNATOMARCHIVE.RRF', 'RXNCUI.RRF'];

    for (const file of files) {
      const filePath = path.join(sourceDir, file);
      if (fs.existsSync(filePath)) {
        const lines = await this.countLines(filePath);
        totalWork += Math.max(lines - 1, 0);
      }
    }

    // Add estimated work for stem generation (roughly equal to concept count)
    const conceptsPath = path.join(sourceDir, 'RXNCONSO.RRF');
    if (fs.existsSync(conceptsPath)) {
      const concepts = await this.countLines(conceptsPath) - 1;
      totalWork += concepts; // Stem generation work
    }

    return Math.max(totalWork, 1);
  }

  async getDatabaseStats(dbPath) {
    const db = new sqlite3.Database(dbPath);

    return new Promise((resolve, reject) => {
      const stats = {};

      // Try to get version from a version table or derive from path
      db.get('SELECT name FROM sqlite_master WHERE type="table" AND name="RXNVer"', (err, row) => {
        if (row) {
          db.get('SELECT version FROM RXNVer LIMIT 1', (err, versionRow) => {
            stats.version = versionRow ? versionRow.version : 'Unknown';
            this.getTableCounts(db, stats, resolve, reject);
          });
        } else {
          // Derive version from path or set as unknown
          const pathVersion = path.basename(dbPath, '.db').match(/\d+$/);
          stats.version = pathVersion ? pathVersion[0] : 'Unknown';
          this.getTableCounts(db, stats, resolve, reject);
        }
      });
    });
  }

  getTableCounts(db, stats, resolve) {
    const queries = [
      { name: 'rxnconsoCount', sql: 'SELECT COUNT(*) as count FROM RXNCONSO' },
      { name: 'rxnrelCount', sql: 'SELECT COUNT(*) as count FROM RXNREL' },
      { name: 'rxnstyCount', sql: 'SELECT COUNT(*) as count FROM RXNSTY' },
      { name: 'stemCount', sql: 'SELECT COUNT(*) as count FROM RXNSTEMS' }
    ];

    let completed = 0;

    queries.forEach(query => {
      db.get(query.sql, (err, row) => {
        if (err) {
          stats[query.name] = 0;
        } else {
          stats[query.name] = row ? row.count : 0;
        }
        completed++;

        if (completed === queries.length) {
          const fileStat = fs.statSync(this.dbPath || './data/rxnorm.db');
          stats.sizeGB = fileStat.size / (1024 * 1024 * 1024);
          stats.lastModified = fileStat.mtime.toISOString();

          db.close();
          resolve(stats);
        }
      });
    });
  }

  async createIndexes(dbPath) {
    const db = new sqlite3.Database(dbPath);

    const indexes = [
      'CREATE INDEX IF NOT EXISTS X_RXNCONSO_1 ON RXNCONSO(RXCUI)',
      'CREATE INDEX IF NOT EXISTS X_RXNCONSO_2 ON RXNCONSO(SAB, TTY)',
      'CREATE INDEX IF NOT EXISTS X_RXNCONSO_3 ON RXNCONSO(CODE, SAB, TTY)',
      'CREATE INDEX IF NOT EXISTS X_RXNCONSO_4 ON RXNCONSO(TTY, SAB)',
      'CREATE INDEX IF NOT EXISTS X_RXNCONSO_6 ON RXNCONSO(RXAUI)',
      'CREATE INDEX IF NOT EXISTS idx_rxnconso_sab_tty_rxcui ON RXNCONSO(SAB, TTY, RXCUI)',
      'CREATE INDEX IF NOT EXISTS X_RXNREL_2 ON RXNREL(REL, RXAUI1)',
      'CREATE INDEX IF NOT EXISTS X_RXNREL_3 ON RXNREL(REL, RXCUI1)',
      'CREATE INDEX IF NOT EXISTS X_RXNREL_4 ON RXNREL(RELA, RXAUI2)',
      'CREATE INDEX IF NOT EXISTS X_RXNREL_5 ON RXNREL(RELA, RXCUI2)',
      'CREATE INDEX IF NOT EXISTS idx_rxnrel_rel ON RXNREL(REL)',
      'CREATE INDEX IF NOT EXISTS idx_rxnrel_rela ON RXNREL(RELA)',
      'CREATE INDEX IF NOT EXISTS X_RXNSTY_2 ON RXNSTY(TUI)',
      'CREATE INDEX IF NOT EXISTS idx_rxnstems_stem_cui ON RXNSTEMS(stem, CUI)',
      'CREATE INDEX IF NOT EXISTS idx_rxnstems_cui_stem ON RXNSTEMS(CUI, stem)'
    ];

    return new Promise((resolve, reject) => {
      db.serialize(() => {
        indexes.forEach(sql => {
          db.run(sql, (err) => {
            if (err) console.warn(`Index creation warning: ${err.message}`);
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

// RxNorm data importer
class RxNormImporter {
  constructor(sourceDir, destFile, version, options = {}) {
    this.sourceDir = sourceDir;
    this.destFile = destFile;
    this.version = version;
    this.options = {
      verbose: true,
      createStems: true,
      progressCallback: null,
      ...options
    };
    this.currentProgress = 0;
  }

  updateProgress(amount = 1, operation = null) {
    this.currentProgress += amount;
    if (this.options.progressCallback) {
      this.options.progressCallback(this.currentProgress, operation);
    }
  }

  async import() {
    if (this.options.verbose) console.log('Starting RxNorm import...');

    // Ensure destination directory exists
    const destDir = path.dirname(this.destFile);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    // Remove existing database
    if (fs.existsSync(this.destFile)) {
      fs.unlinkSync(this.destFile);
    }

    const db = new sqlite3.Database(this.destFile);

    try {
      await this.checkFiles();
      await this.createTables(db);
      await this.loadRXNSAB(db);
      await this.loadRXNATOMARCHIVE(db);
      await this.loadRXNCUI(db);
      await this.loadRXNCONSO(db);
      await this.loadRXNREL(db);
      await this.loadRXNSTY(db);

      if (this.options.createStems) {
        await this.makeStems(db);
      }

      if (this.options.verbose) console.log('RxNorm import completed successfully');
    } finally {
      await this.closeDatabase(db);
    }
  }

  async checkFiles() {
    this.updateProgress(0, 'Checking Files');

    const requiredFiles = ['RXNCONSO.RRF', 'RXNREL.RRF', 'RXNSTY.RRF'];

    for (const file of requiredFiles) {
      const filePath = path.join(this.sourceDir, file);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Required file not found: ${file}`);
      }
    }
  }

  async createTables(db) {
    this.updateProgress(0, 'Creating Tables');

    const tableSQL = [
      // Drop existing tables
      'DROP TABLE IF EXISTS RXNCONSO',
      'DROP TABLE IF EXISTS RXNREL',
      'DROP TABLE IF EXISTS RXNSTY',
      'DROP TABLE IF EXISTS RXNSTEMS',
      'DROP TABLE IF EXISTS RXNATOMARCHIVE',
      'DROP TABLE IF EXISTS RXNCUI',
      'DROP TABLE IF EXISTS RXNSAB',

      // Create RXNCONSO table
      `CREATE TABLE RXNCONSO (
                                 RXCUI varchar(8) NOT NULL,
                                 RXAUI varchar(8) NOT NULL,
                                 SAB varchar(20) NOT NULL,
                                 TTY varchar(20) NOT NULL,
                                 CODE varchar(50) NOT NULL,
                                 STR varchar(3000) NOT NULL,
                                 SUPPRESS varchar(1)
       )`,

      // Create RXNREL table
      `CREATE TABLE RXNREL (
                               RXCUI1 varchar(8),
                               RXAUI1 varchar(8),
                               REL varchar(4),
                               RXCUI2 varchar(8),
                               RXAUI2 varchar(8),
                               RELA varchar(100),
                               SAB varchar(20) NOT NULL
       )`,

      // Create RXNSTY table
      `CREATE TABLE RXNSTY (
                               RXCUI varchar(8) NOT NULL,
                               TUI varchar(4)
       )`,

      // Create RXNATOMARCHIVE table
      `CREATE TABLE RXNATOMARCHIVE (
                                       RXAUI varchar(8) NOT NULL PRIMARY KEY,
                                       AUI varchar(10),
                                       STR varchar(4000) NOT NULL,
                                       ARCHIVE_TIMESTAMP varchar(280) NOT NULL,
                                       CREATED_TIMESTAMP varchar(280) NOT NULL,
                                       UPDATED_TIMESTAMP varchar(280) NOT NULL,
                                       CODE varchar(50),
                                       IS_BRAND varchar(1),
                                       LAT varchar(3),
                                       LAST_RELEASED varchar(30),
                                       SAUI varchar(50),
                                       VSAB varchar(40),
                                       RXCUI varchar(8),
                                       SAB varchar(20),
                                       TTY varchar(20),
                                       MERGED_TO_RXCUI varchar(8)
       )`,

      // Create RXNSTEMS table
      `CREATE TABLE RXNSTEMS (
                                 stem CHAR(20) NOT NULL,
                                 CUI VARCHAR(8) NOT NULL,
                                 PRIMARY KEY (stem, CUI)
       )`,

      // Create RXNSAB table
      `CREATE TABLE RXNSAB (
                               VCUI varchar(8),
                               RCUI varchar(8),
                               VSAB varchar(40),
                               RSAB varchar(20) NOT NULL,
                               SON varchar(3000),
                               SF varchar(20),
                               SVER varchar(20),
                               VSTART varchar(10),
                               VEND varchar(10),
                               IMETA varchar(10),
                               RMETA varchar(10),
                               SLC varchar(1000),
                               SCC varchar(1000),
                               SRL integer,
                               TFR integer,
                               CFR integer,
                               CXTY varchar(50),
                               TTYL varchar(300),
                               ATNL varchar(1000),
                               LAT varchar(3),
                               CENC varchar(20),
                               CURVER varchar(1),
                               SABIN varchar(1),
                               SSN varchar(3000),
                               SCIT varchar(4000),
                               PRIMARY KEY (VCUI)
       )`,

      // Create RXNCUI table
      `CREATE TABLE RXNCUI (
                               cui1 VARCHAR(8),
                               ver_start VARCHAR(40),
                               ver_end VARCHAR(40),
                               cardinality VARCHAR(8),
                               cui2 VARCHAR(8),
                               PRIMARY KEY (cui1)
       )`
    ];

    return new Promise((resolve) => {
      db.serialize(() => {
        tableSQL.forEach(sql => {
          db.run(sql, (err) => {
            if (err && this.options.verbose) {
              console.warn(`Table creation warning: ${err.message}`);
            }
          });
        });

        if (this.options.verbose) console.log('Database tables created');
        resolve();
      });
    });
  }

  async loadRXNCONSO(db) {
    await this.loadRRFFile(db, 'RXNCONSO.RRF',
      'INSERT INTO RXNCONSO (RXCUI, RXAUI, SAB, TTY, CODE, STR, SUPPRESS) VALUES (?, ?, ?, ?, ?, ?, ?)',
      (items) => [items[0], items[7], items[11], items[12], items[13], items[14], items[16]]
    );
  }

  async loadRXNSAB(db) {
    const filePath = path.join(this.sourceDir, 'RXNSAB.RRF');
    if (!fs.existsSync(filePath)) return;

    await this.loadRRFFile(db, 'RXNSAB.RRF',
      `INSERT OR IGNORE INTO RXNSAB (VCUI, RCUI, VSAB, RSAB, SON, SF, SVER, VSTART, VEND, IMETA, RMETA, SLC, SCC, SRL, TFR, CFR, CXTY, TTYL, ATNL, LAT, CENC, CURVER, SABIN, SSN, SCIT) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      (items) => items.slice(0, 25)
    );
  }

  async loadRXNCUI(db) {
    const filePath = path.join(this.sourceDir, 'RXNCUI.RRF');
    if (!fs.existsSync(filePath)) return;

    await this.loadRRFFile(db, 'RXNCUI.RRF',
      'INSERT OR IGNORE INTO RXNCUI (cui1, ver_start, ver_end, cardinality, cui2) VALUES (?, ?, ?, ?, ?)',
      (items) => items.slice(0, 5)
    );
  }

  async loadRXNATOMARCHIVE(db) {
    const filePath = path.join(this.sourceDir, 'RXNATOMARCHIVE.RRF');
    if (!fs.existsSync(filePath)) return;

    await this.loadRRFFile(db, 'RXNATOMARCHIVE.RRF',
      `INSERT OR IGNORE INTO RXNATOMARCHIVE (RXAUI, AUI, STR, ARCHIVE_TIMESTAMP, CREATED_TIMESTAMP, UPDATED_TIMESTAMP, CODE, IS_BRAND, LAT, LAST_RELEASED, SAUI, VSAB, RXCUI, SAB, TTY, MERGED_TO_RXCUI) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      (items) => items.slice(0, 16)
    );
  }

  async loadRXNREL(db) {
    await this.loadRRFFile(db, 'RXNREL.RRF',
      'INSERT INTO RXNREL (RXCUI1, RXAUI1, REL, RXCUI2, RXAUI2, RELA, SAB) VALUES (?, ?, ?, ?, ?, ?, ?)',
      (items) => [items[0], items[1], items[3], items[4], items[5], items[7], items[10]]
    );
  }

  async loadRXNSTY(db) {
    await this.loadRRFFile(db, 'RXNSTY.RRF',
      'INSERT INTO RXNSTY (RXCUI, TUI) VALUES (?, ?)',
      (items) => [items[0], items[1]]
    );
  }

  async loadRRFFile(db, fileName, insertSQL, extractValues) {
    const filePath = path.join(this.sourceDir, fileName);
    if (!fs.existsSync(filePath)) {
      if (this.options.verbose) console.warn(`File not found: ${fileName}`);
      return;
    }

    this.updateProgress(0, `Loading ${fileName}`);

    const rl = readline.createInterface({
      input: fs.createReadStream(filePath),
      crlfDelay: Infinity
    });

    return new Promise((resolve, reject) => {
      db.serialize(() => {
        db.run('BEGIN TRANSACTION');

        const stmt = db.prepare(insertSQL);
        let lineCount = 0;
        let processedCount = 0;
        let errorCount = 0;

        rl.on('line', (line) => {
          lineCount++;

          const items = line.split('|');
          if (items.length === 0) return;

          try {
            const values = extractValues(items);
            stmt.run(values, (err) => {
              if (err && err.code !== 'SQLITE_CONSTRAINT') {
                errorCount++;
                if (this.options.verbose && errorCount <= 10) {
                  console.warn(`Error processing line ${lineCount} in ${fileName}: ${err.message}`);
                }
              }
            });
            processedCount++;

            if (processedCount % 1000 === 0) {
              this.updateProgress(1000);
            }
          } catch (error) {
            errorCount++;
            if (this.options.verbose && errorCount <= 10) {
              console.warn(`Error processing line ${lineCount} in ${fileName}: ${error.message}`);
            }
          }
        });

        rl.on('close', () => {
          stmt.finalize();
          db.run('COMMIT', (err) => {
            if (err) reject(err);
            else {
              // Update progress for remaining records
              const remaining = processedCount % 1000;
              if (remaining > 0) {
                this.updateProgress(remaining);
              }

              if (this.options.verbose) {
                console.log(`  Loaded ${processedCount} records from ${fileName}${errorCount > 0 ? ` (${errorCount} errors)` : ''}`);
              }
              resolve();
            }
          });
        });

        rl.on('error', reject);
      });
    });
  }

  async makeStems(db) {
    this.updateProgress(0, 'Generating Stems');

    if (this.options.verbose) console.log('Generating word stems...');

    // Simple English stemmer implementation
    var natural = require('natural/lib/natural/stemmers'); // just the stemmers: the package index also loads its storage backends, and dotenv with them
    const stems = new Map();

    // Get all RXNORM concepts
    return new Promise((resolve, reject) => {
      db.all("SELECT RXCUI, STR FROM RXNCONSO WHERE SAB = 'RXNORM'", (err, rows) => {
        if (err) return reject(err);

        // Process each concept and generate stems
        rows.forEach(row => {
          const words = this.extractWords(row.STR);
          words.forEach(word => {
            const stem = natural.PorterStemmer.stem(word.toLowerCase());
            if (stem.length > 0 && stem.length <= 20) {
              if (!stems.has(stem)) {
                stems.set(stem, new Set());
              }
              stems.get(stem).add(row.RXCUI);
            }
          });
        });

        // Insert stems into database
        db.serialize(() => {
          db.run('BEGIN TRANSACTION');
          const stmt = db.prepare('INSERT OR IGNORE INTO RXNSTEMS (stem, CUI) VALUES (?, ?)');

          let totalInserts = 0;
          let processedStems = 0;

          for (const [stem, cuis] of stems) {
            for (const cui of cuis) {
              stmt.run([stem, cui]);
              totalInserts++;

              if (totalInserts % 1000 === 0) {
                this.updateProgress(1000);
              }
            }
            processedStems++;
          }

          stmt.finalize();
          db.run('COMMIT', (err) => {
            if (err) reject(err);
            else {
              // Update progress for remaining inserts
              const remaining = totalInserts % 1000;
              if (remaining > 0) {
                this.updateProgress(remaining);
              }

              if (this.options.verbose) {
                console.log(`  Generated ${totalInserts} stem entries from ${processedStems} unique stems`);
              }
              resolve();
            }
          });
        });
      });
    });
  }

  extractWords(text) {
    // Extract words from text, removing punctuation and numbers
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word.length > 2 && !/^\d+$/.test(word))
      .filter(word => word.match(/^[a-z]/));
  }

  async closeDatabase(db) {
    return new Promise((resolve) => {
      db.close((err) => {
        if (err && this.options.verbose) {
          console.error('Error closing database:', err);
        }
        resolve();
      });
    });
  }
}


module.exports = {
  RxNormModule,
  RxNormImporter
};