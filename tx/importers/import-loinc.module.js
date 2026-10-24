const { BaseTerminologyModule } = require('./tx-import-base');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const readline = require('readline');
const { csvRecords } = require('./csv-records');
const chalk = require('chalk');

class LoincModule extends BaseTerminologyModule {
  constructor() {
    super();
  }

  getName() {
    return 'loinc';
  }

  getDescription() {
    return 'Logical Observation Identifiers Names and Codes (LOINC) from Regenstrief Institute';
  }

  getSupportedFormats() {
    return ['csv', 'directory'];
  }

  getDefaultConfig() {
    return {
      verbose: true,
      overwrite: false,
      createIndexes: true,
      mainOnly: false,
      dest: './data/loinc.db'
    };
  }

  getEstimatedDuration() {
    return '45-120 minutes (depending on language variants)';
  }

  registerCommands(terminologyCommand, globalOptions) {
    // Import command
    terminologyCommand
      .command('import')
      .description('Import LOINC data from source directory')
      .option('-s, --source <directory>', 'Source directory containing LOINC files')
      .option('-d, --dest <file>', 'Destination SQLite database')
      .option('-v, --version <version>', 'LOINC version identifier')
      .option('-y, --yes', 'Skip confirmations')
      .option('--no-indexes', 'Skip index creation for faster import')
      .option('--main-only', 'Import only main codes (skip language variants)')
      .action(async (options) => {
        await this.handleImportCommand({...globalOptions, ...options});
      });

    // Validate command
    terminologyCommand
      .command('validate')
      .description('Validate LOINC source directory structure')
      .option('-s, --source <directory>', 'Source directory to validate')
      .action(async (options) => {
        await this.handleValidateCommand({...globalOptions, ...options});
      });

    // Status command
    terminologyCommand
      .command('status')
      .description('Show status of LOINC database')
      .option('-d, --dest <file>', 'Database file to check')
      .action(async (options) => {
        await this.handleStatusCommand({...globalOptions, ...options});
      });
  }

  async handleImportCommand(options) {
    try {
      // Gather configuration with remembered values
      const config = await this.gatherCommonConfig(options);

      // LOINC-specific configuration
      config.createIndexes = !options.noIndexes;
      config.mainOnly = options.mainOnly || false;
      config.estimatedDuration = this.getEstimatedDuration();

      if (!options.version) {
        const inquirer = require('inquirer');
        const { version } = await inquirer.prompt({
          type: 'input',
          name: 'version',
          message: 'LOINC version identifier:',
          default: config.version
        });
        config.version = version;
      }

      // Show confirmation unless --yes is specified
      if (!options.yes) {
        const confirmed = await this.confirmImport(config);
        if (!confirmed) {
          this.logInfo('Import cancelled');
          return;
        }
      }

      // Save configuration immediately after confirmation
      this.rememberSuccessfulConfig(config);

      // Run the import
      await this.runImportWithoutConfigSaving(config);
    } catch (error) {
      this.logError(`Import command failed: ${error.message}`);
      if (options.verbose) {
        console.error(error.stack);
      }
      throw error;
    }
  }

  async confirmImport(config) {
    const inquirer = require('inquirer');
    const chalk = require('chalk');

    console.log(chalk.cyan(`\n📋 ${this.getName()} Import Configuration:`));
    console.log(`  Source: ${chalk.white(config.source)}`);
    console.log(`  Destination: ${chalk.white(config.dest)}`);
    console.log(`  Version: ${chalk.white(config.version)}`);
    console.log(`  Main Only: ${chalk.white(config.mainOnly ? 'Yes' : 'No')}`);
    console.log(`  Create Indexes: ${chalk.white(config.createIndexes ? 'Yes' : 'No')}`);
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

  async runImportWithoutConfigSaving(config) {
    try {
      console.log(chalk.blue.bold(`🏥 Starting ${this.getName()} Import...\n`));

      // Pre-flight checks
      this.logInfo('Running pre-flight checks...');
      const prerequisitesPassed = await this.validatePrerequisites(config);

      if (!prerequisitesPassed) {
        throw new Error('Pre-flight checks failed');
      }

      // Execute the import
      await this.executeImport(config);

      this.logSuccess(`${this.getName()} import completed successfully!`);

    } catch (error) {
      this.stopProgress();
      this.logError(`${this.getName()} import failed: ${error.message}`);
      if (config.verbose) {
        console.error(error.stack);
      }
      process.exit(1);
    }
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

    this.logInfo(`Validating LOINC directory: ${options.source}`);

    try {
      const stats = await this.validateLoincDirectory(options.source);

      this.logSuccess('Directory validation passed');
      console.log(`  Main codes file: ${stats.mainCodesFound ? 'Found' : 'Missing'}`);
      console.log(`  Parts file: ${stats.partsFound ? 'Found' : 'Missing'}`);
      console.log(`  Language variants: ${stats.languageVariants.length} found`);
      console.log(`  Estimated main codes: ${stats.estimatedCodes.toLocaleString()}`);

      if (stats.warnings.length > 0) {
        this.logWarning('Validation warnings:');
        stats.warnings.forEach(warning => console.log(`    ${warning}`));
      }

    } catch (error) {
      this.logError(`Validation failed: ${error.message}`);
    }
  }

  async handleStatusCommand(options) {
    const dbPath = options.dest || './data/loinc.db';

    if (!fs.existsSync(dbPath)) {
      this.logError(`Database not found: ${dbPath}`);
      return;
    }

    this.logInfo(`Checking LOINC database: ${dbPath}`);

    try {
      const stats = await this.getDatabaseStats(dbPath);

      this.logSuccess('Database status:');
      console.log(`  Version: ${stats.version}`);
      console.log(`  Total Codes: ${stats.codeCount.toLocaleString()}`);
      console.log(`  Main LOINC Codes: ${stats.mainCodeCount.toLocaleString()}`);
      console.log(`  Parts: ${stats.partCount.toLocaleString()}`);
      console.log(`  Answer Lists: ${stats.answerListCount.toLocaleString()}`);
      console.log(`  Languages: ${stats.languageCount.toLocaleString()}`);
      console.log(`  Relationships: ${stats.relationshipCount.toLocaleString()}`);
      console.log(`  Database Size: ${stats.sizeGB.toFixed(2)} GB`);
      console.log(`  Last Modified: ${stats.lastModified}`);

    } catch (error) {
      this.logError(`Status check failed: ${error.message}`);
    }
  }

  async validatePrerequisites(config) {
    const baseValid = await super.validatePrerequisites(config);

    try {
      this.logInfo('Validating LOINC directory structure...');
      await this.validateLoincDirectory(config.source);
      this.logSuccess('LOINC directory structure valid');
    } catch (error) {
      this.logError(`LOINC directory validation failed: ${error.message}`);
      return false;
    }

    return baseValid;
  }

  async executeImport(config) {
    this.logInfo('Starting LOINC data migration...');

    const enhancedMigrator = new LoincDataMigratorWithProgress(
      this,
      config.verbose
    );

    await enhancedMigrator.migrate(
      config.source,
      config.dest,
      config.version,
      {
        verbose: config.verbose,
        mainOnly: config.mainOnly
      }
    );

    if (config.createIndexes) {
      this.logInfo('Creating database indexes...');
      await this.createIndexes(config.dest);
      this.logSuccess('Indexes created');
    }
  }

  async validateLoincDirectory(sourceDir) {
    if (!fs.existsSync(sourceDir)) {
      throw new Error(`Source directory not found: ${sourceDir}`);
    }

    // The accessory files are required, not optional. Without them the import silently
    // succeeds and the server then answers questions wrongly rather than saying it cannot:
    // no ComponentHierarchyBySystem means an empty closure and $subsumes replying
    // 'not-subsumed' to everything, which is indistinguishable from a real answer.
    const requiredFiles = [
      'LoincTable/Loinc.csv',
      'AccessoryFiles/PartFile/Part.csv',
      'AccessoryFiles/ConsumerName/ConsumerName.csv',
      'AccessoryFiles/AnswerFile/AnswerList.csv',
      'AccessoryFiles/PartFile/LoincPartLink_Primary.csv',
      'AccessoryFiles/AnswerFile/LoincAnswerListLink.csv',
      'AccessoryFiles/ComponentHierarchyBySystem/ComponentHierarchyBySystem.csv'
    ];

    // Translations are a different case: a main-only import is a legitimate thing to want,
    // and their absence costs designations, not correctness
    const optionalFiles = [
      'AccessoryFiles/LinguisticVariants/LinguisticVariants.csv',
      // the external code mappings: their absence costs maps to other code systems, nothing else
      'AccessoryFiles/PartFile/PartRelatedCodeMapping.csv',
      'AccessoryFiles/LoincIeeeMedicalDeviceCodeMappingTable/LoincIeeeMedicalDeviceCodeMappingTable.csv'
    ];

    const warnings = [];
    let mainCodesFound = false;
    let partsFound = false;
    let estimatedCodes = 0;

    // Check required files
    for (const file of requiredFiles) {
      const filePath = path.join(sourceDir, file);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Required file missing: ${file}`);
      }

      if (file.includes('Loinc.csv')) {
        mainCodesFound = true;
        estimatedCodes = await this.countLines(filePath) - 1;
      } else if (file.includes('Part.csv')) {
        partsFound = true;
      }
    }

    // Check optional files
    for (const file of optionalFiles) {
      const filePath = path.join(sourceDir, file);
      if (!fs.existsSync(filePath)) {
        warnings.push(`Optional file missing: ${file}`);
      }
    }

    // Check for language variants
    const languageVariants = [];
    const linguisticVariantsDir = path.join(sourceDir, 'AccessoryFiles/LinguisticVariants');
    if (fs.existsSync(linguisticVariantsDir)) {
      const files = fs.readdirSync(linguisticVariantsDir);
      for (const file of files) {
        if (file.includes('LinguisticVariant.csv') && !file.startsWith('LinguisticVariants.csv')) {
          languageVariants.push(file);
        }
      }
    }

    return {
      mainCodesFound,
      partsFound,
      estimatedCodes,
      languageVariants,
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

  async getDatabaseStats(dbPath) {
    const sqlite3 = require('sqlite3').verbose();
    const db = new sqlite3.Database(dbPath);

    return new Promise((resolve, reject) => {
      const stats = {};

      db.get('SELECT Value FROM Config WHERE ConfigKey = 2', (err, row) => {
        if (err) return reject(err);
        stats.version = row ? row.Value : 'Unknown';

        const queries = [
          { name: 'codeCount', sql: 'SELECT COUNT(*) as count FROM Codes' },
          { name: 'mainCodeCount', sql: 'SELECT COUNT(*) as count FROM Codes WHERE Type = 1' },
          { name: 'partCount', sql: 'SELECT COUNT(*) as count FROM Codes WHERE Type = 2' },
          { name: 'answerListCount', sql: 'SELECT COUNT(*) as count FROM Codes WHERE Type = 3' },
          { name: 'languageCount', sql: 'SELECT COUNT(*) as count FROM Languages' },
          { name: 'relationshipCount', sql: 'SELECT COUNT(*) as count FROM Relationships' }
        ];

        let completed = 0;

        queries.forEach(query => {
          db.get(query.sql, (err, row) => {
            if (err) return reject(err);
            stats[query.name] = row.count;
            completed++;

            if (completed === queries.length) {
              const fileStat = fs.statSync(dbPath);
              stats.sizeGB = fileStat.size / (1024 * 1024 * 1024);
              stats.lastModified = fileStat.mtime.toISOString();

              db.close();
              resolve(stats);
            }
          });
        });
      });
    });
  }

  async createIndexes(dbPath) {
    const sqlite3 = require('sqlite3').verbose();
    const db = new sqlite3.Database(dbPath);

    const indexes = [
      // Codes table indexes
      'CREATE INDEX IF NOT EXISTS idx_codes_code ON Codes(Code)',
      'CREATE INDEX IF NOT EXISTS idx_codes_type ON Codes(Type)',
      'CREATE INDEX IF NOT EXISTS idx_codes_status ON Codes(StatusKey)',
      'CREATE INDEX IF NOT EXISTS idx_codes_type_status ON Codes(Type, StatusKey)',

      // Relationships table indexes
      'CREATE INDEX IF NOT EXISTS idx_relationships_source ON Relationships(RelationshipTypeKey, SourceKey)',
      'CREATE INDEX IF NOT EXISTS idx_relationships_target ON Relationships(RelationshipTypeKey, TargetKey)',
      'CREATE INDEX IF NOT EXISTS idx_relationships_source_type ON Relationships(SourceKey, RelationshipTypeKey)',

      // Properties table indexes
      'CREATE INDEX IF NOT EXISTS idx_properties_code ON Properties(PropertyTypeKey, CodeKey)',
      'CREATE INDEX IF NOT EXISTS idx_properties_code2 ON Properties(CodeKey, PropertyTypeKey)',
      'CREATE INDEX IF NOT EXISTS idx_properties_valuekey ON Properties(PropertyValueKey)',

      // PropertyValues table indexes - for value lookups in filters
      'CREATE INDEX IF NOT EXISTS idx_propertyvalues_value ON PropertyValues(Value COLLATE NOCASE)',

      // Descriptions table indexes
      'CREATE INDEX IF NOT EXISTS idx_descriptions_code ON Descriptions(CodeKey, LanguageKey)',
      'CREATE INDEX IF NOT EXISTS idx_descriptions_type ON Descriptions(DescriptionTypeKey)',
      'CREATE INDEX IF NOT EXISTS idx_descriptions_code_type ON Descriptions(CodeKey, DescriptionTypeKey)',

      // External mapping indexes
      'CREATE INDEX IF NOT EXISTS idx_externalcodes_code ON ExternalCodes(System, Code)',
      'CREATE INDEX IF NOT EXISTS idx_externalmappings_code ON ExternalMappings(CodeKey)',
      'CREATE INDEX IF NOT EXISTS idx_externalmappings_target ON ExternalMappings(ExternalCodeKey)',

      // Closure table indexes
      'CREATE INDEX IF NOT EXISTS idx_closure_ancestor ON Closure(AncestorKey)',
      'CREATE INDEX IF NOT EXISTS idx_closure_descendent ON Closure(DescendentKey)'
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

// Enhanced migrator with progress reporting
class LoincDataMigratorWithProgress {
  constructor(moduleInstance, verbose = true) {
    this.module = moduleInstance;
    this.verbose = verbose;
    this.totalProgress = 0;
    this.currentOperation = 'Starting';
  }

  async migrate(sourceDir, destFile, version, options) {
    // Estimate total work
    this.totalProgress = await this.estimateWorkload(sourceDir, options);

    this.module.logInfo(`Processing LOINC data (${this.totalProgress.toLocaleString()} estimated records)...`);

    // Create progress bar with operation display
    const progressFormat = '{operation} |{bar}| {percentage}% | {value}/{total} | ETA: {eta}s';
    this.module.createProgressBar(progressFormat);

    // Start the progress bar
    this.module.progressBar.start(this.totalProgress, 0, {
      operation: chalk.cyan('Starting'.padEnd(20).substring(0, 20))
    });

    // Create migrator with progress callback that properly updates both progress and operation
    const migratorWithProgress = new LoincDataMigrator((currentProgress, operation) => {
      if (operation) {
        this.currentOperation = operation;
      }

      if (this.module.progressBar) {
        this.module.progressBar.update(currentProgress, {
          operation: chalk.cyan(this.currentOperation.padEnd(20).substring(0, 20))
        });
      }
    });

    try {
      await migratorWithProgress.migrate(sourceDir, destFile, version, options);
    } finally {
      this.module.stopProgress();
    }
  }

  async estimateWorkload(sourceDir, options) {
    let totalLines = 0;
    const files = [
      'LoincTable/Loinc.csv',
      'AccessoryFiles/PartFile/Part.csv'
    ];

    const optionalFiles = [
      'AccessoryFiles/ConsumerName/ConsumerName.csv',
      'AccessoryFiles/AnswerFile/AnswerList.csv',
      'AccessoryFiles/PartFile/LoincPartLink_Primary.csv',
      'AccessoryFiles/AnswerFile/LoincAnswerListLink.csv',
      'AccessoryFiles/ComponentHierarchyBySystem/ComponentHierarchyBySystem.csv',
      'AccessoryFiles/PartFile/PartRelatedCodeMapping.csv',
      'AccessoryFiles/LoincIeeeMedicalDeviceCodeMappingTable/LoincIeeeMedicalDeviceCodeMappingTable.csv'
    ];

    // Count main files
    for (const file of [...files, ...optionalFiles]) {
      const filePath = path.join(sourceDir, file);
      if (fs.existsSync(filePath)) {
        totalLines += await this.countLines(filePath);
      }
    }

    // Count language variant files if not main-only
    if (!options.mainOnly) {
      const linguisticVariantsDir = path.join(sourceDir, 'AccessoryFiles/LinguisticVariants');
      if (fs.existsSync(linguisticVariantsDir)) {
        const files = fs.readdirSync(linguisticVariantsDir);
        for (const file of files) {
          if (file.includes('LinguisticVariant.csv') && !file.startsWith('LinguisticVariants.csv')) {
            const filePath = path.join(linguisticVariantsDir, file);
            totalLines += await this.countLines(filePath);
          }
        }
      }
    }

    return Math.max(totalLines - 20, 1);
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
}

class LoincDataMigrator {
  constructor(progressCallback = null) {
    this.progressCallback = progressCallback;
    this.currentProgress = 0;
    this.stepCount = 16;
    this.currentOperation = 'Initializing';
  }

  updateProgress(amount = 1, operation = null) {
    this.currentProgress += amount;
    if (operation) {
      this.currentOperation = operation;
    }
    if (this.progressCallback) {
      this.progressCallback(this.currentProgress, this.currentOperation);
    }
  }

  async migrate(sourceDir, destFile, version = 'unknown', options = {}) {
    if (options.verbose) console.log('Starting LOINC data migration...');

    const destDir = path.dirname(destFile);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    if (fs.existsSync(destFile)) {
      fs.unlinkSync(destFile);
    }

    const db = new sqlite3.Database(destFile);

    try {
      // Initialize tracking variables
      this.codeKey = 0;
      this.relKey = 0;
      this.descKey = 0;
      this.propKey = 0;
      this.propValueKey = 0;
      this.langKey = 1;

      this.codes = new Map();
      this.codeList = [];
      this.statii = new Map();
      this.langs = new Map();
      this.rels = new Map();
      this.dTypes = new Map();
      this.props = new Map();
      this.propValues = new Map();
      this.partNames = new Map();
      this.extCodeKey = 0;
      this.extCodes = new Map(); // system|version|code -> ExternalCodeKey
      this.extMapKey = 0;
      this.extMaps = new Set(); // codeKey|ExternalCodeKey

      // Create tables and initial data
      await this.createTables(db, version, options.verbose);

      // Discover language variants first
      const languageVariants = await this.discoverLanguageVariants(sourceDir);
      if (!options.mainOnly) {
        this.stepCount = 12 + languageVariants.length;
      }

      // Process all data with proper operation names
      this.updateProgress(0, 'Language Variants');
      await this.processLanguageVariants(db, sourceDir, 2, options);

      this.updateProgress(0, 'Parts');
      await this.processParts(db, sourceDir, 3, options);

      this.updateProgress(0, 'Main Codes');
      await this.processCodes(db, sourceDir, 4, options);

      this.updateProgress(0, 'Consumer Names');
      await this.processConsumerNames(db, sourceDir, 5, options);

      this.updateProgress(0, 'Answer Lists');
      await this.processLists(db, sourceDir, 6, options);

      this.updateProgress(0, 'Part Links');
      await this.processPartLinks(db, sourceDir, 7, options);

      this.updateProgress(0, 'List Links');
      await this.processListLinks(db, sourceDir, 8, options);

      this.updateProgress(0, 'External Mappings');
      await this.processPartMappings(db, sourceDir, 9, options);
      await this.processIeeeMappings(db, sourceDir, 9, options);

      this.updateProgress(0, 'Hierarchy');
      await this.processHierarchy(db, sourceDir, 9, options);

      this.updateProgress(0, 'Property Values');
      await this.processPropertyValues(db, 10, options);

      this.updateProgress(0, 'Closure Table');
      await this.storeClosureTable(db, 11, options);

      // Process individual language variants
      if (!options.mainOnly) {
        for (let i = 0; i < languageVariants.length; i++) {
          this.updateProgress(0, `Lang: ${languageVariants[i]}`);
          await this.processLanguage(db, sourceDir, 12 + i, languageVariants[i], options);
        }
      }

      if (options.verbose) console.log('LOINC data migration completed successfully');
    } finally {
      await this.closeDatabase(db, options.verbose);
    }
  }

  async createTables(db, version, verbose = true) {
    if (verbose) console.log('Creating database tables...');

    const tableSQL = [
      `CREATE TABLE Config (
                               ConfigKey INTEGER NOT NULL PRIMARY KEY,
                               Value TEXT NOT NULL
       )`,
      `CREATE TABLE Types (
                              TypeKey INTEGER NOT NULL PRIMARY KEY,
                              Code TEXT NOT NULL
       )`,
      `CREATE TABLE Languages (
                                  LanguageKey INTEGER NOT NULL PRIMARY KEY,
                                  Code TEXT NOT NULL,
                                  Description TEXT NOT NULL
       )`,
      `CREATE TABLE StatusCodes (
                                    StatusKey INTEGER NOT NULL PRIMARY KEY,
                                    Description TEXT NOT NULL
       )`,
      `CREATE TABLE RelationshipTypes (
                                          RelationshipTypeKey INTEGER NOT NULL PRIMARY KEY,
                                          Description TEXT NOT NULL
       )`,
      `CREATE TABLE DescriptionTypes (
                                         DescriptionTypeKey INTEGER NOT NULL PRIMARY KEY,
                                         Description TEXT NOT NULL
       )`,
      `CREATE TABLE PropertyTypes (
                                      PropertyTypeKey INTEGER NOT NULL PRIMARY KEY,
                                      Description TEXT NOT NULL
       )`,
      `CREATE TABLE Codes (
                              CodeKey INTEGER NOT NULL PRIMARY KEY,
                              Code TEXT NOT NULL,
                              Type INTEGER NOT NULL,
                              RelationshipKey INTEGER NULL,
                              StatusKey INTEGER NOT NULL,
                              Description TEXT NOT NULL
       )`,
      `CREATE TABLE Relationships (
                                      RelationshipKey INTEGER NOT NULL PRIMARY KEY,
                                      RelationshipTypeKey INTEGER NOT NULL,
                                      SourceKey INTEGER NOT NULL,
                                      TargetKey INTEGER NOT NULL,
                                      StatusKey INTEGER NOT NULL
       )`,
      `CREATE TABLE PropertyValues (
                                       PropertyValueKey INTEGER NOT NULL PRIMARY KEY,
                                       Value TEXT NOT NULL
       )`,
      `CREATE TABLE Properties (
                                   PropertyKey INTEGER NOT NULL PRIMARY KEY,
                                   PropertyTypeKey INTEGER NOT NULL,
                                   CodeKey INTEGER NOT NULL,
                                   PropertyValueKey INTEGER NOT NULL
       )`,
      `CREATE TABLE Descriptions (
                                     DescriptionKey INTEGER NOT NULL PRIMARY KEY,
                                     CodeKey INTEGER NOT NULL,
                                     LanguageKey INTEGER NOT NULL,
                                     DescriptionTypeKey INTEGER NOT NULL,
                                     Value TEXT NOT NULL
       )`,
      // Codes in other code systems that LOINC codes map to (one row per system|version|code)
      `CREATE TABLE ExternalCodes (
                                     ExternalCodeKey INTEGER NOT NULL PRIMARY KEY,
                                     System TEXT NOT NULL,
                                     Version TEXT NULL,
                                     Code TEXT NOT NULL,
                                     Display TEXT NULL
       )`,
      // LOINC code (Codes.CodeKey) -> ExternalCodes, with a ConceptMap equivalence (R4 codes)
      `CREATE TABLE ExternalMappings (
                                        ExternalMappingKey INTEGER NOT NULL PRIMARY KEY,
                                        CodeKey INTEGER NOT NULL,
                                        ExternalCodeKey INTEGER NOT NULL,
                                        Equivalence TEXT NOT NULL
       )`,
      `CREATE TABLE Closure (
                                AncestorKey INTEGER NOT NULL,
                                DescendentKey INTEGER NOT NULL,
                                PRIMARY KEY (AncestorKey, DescendentKey)
       )`,
      `CREATE VIRTUAL TABLE TextIndex USING fts5(
        codekey UNINDEXED,
        type UNINDEXED, 
        lang UNINDEXED,
        text
      )`
    ];

    return new Promise((resolve, reject) => {
      db.serialize(() => {
        tableSQL.forEach(sql => {
          db.run(sql, (err) => {
            if (err) return reject(err);
          });
        });

        this.insertInitialData(db, version);
        if (verbose) console.log('Database tables created');
        resolve();
      });
    });
  }

  insertInitialData(db, version) {
    // Config
    db.run('INSERT INTO Config (ConfigKey, Value) VALUES (1, "c3c89b66-5930-4aa2-8962-124561a5f8c1")');
    db.run('INSERT INTO Config (ConfigKey, Value) VALUES (2, ?)', [version]);

    // Types
    db.run('INSERT INTO Types (TypeKey, Code) VALUES (1, "Code")');
    db.run('INSERT INTO Types (TypeKey, Code) VALUES (2, "Part")');
    db.run('INSERT INTO Types (TypeKey, Code) VALUES (3, "AnswerList")');
    db.run('INSERT INTO Types (TypeKey, Code) VALUES (4, "Answer")');

    // Status codes
    const statusCodes = [
      [0, 'NotStated'], [1, 'ACTIVE'], [2, 'DEPRECATED'], [3, 'TRIAL'],
      [4, 'DISCOURAGED'], [5, 'EXAMPLE'], [6, 'PREFERRED'], [7, 'Primary'],
      [8, 'DocumentOntology'], [9, 'Radiology'], [10, 'NORMATIVE']
    ];
    statusCodes.forEach(([key, desc]) => {
      db.run('INSERT INTO StatusCodes (StatusKey, Description) VALUES (?, ?)', [key, desc]);
      this.statii.set(desc, key);
    });

    // Relationship types
    const relationshipTypes = [
      [0, 'N/A'], [1, 'adjustment'], [2, 'challenge'], [3, 'CLASS'], [4, 'COMPONENT'],
      [5, 'count'], [6, 'analyte-divisor'], [7, 'document-kind'], [8, 'document-role'],
      [9, 'document-setting'], [10, 'document-subject-matter-domain'], [11, 'document-type-of-service'],
      [12, 'analyte-gene'], [13, 'METHOD_TYP'], [14, 'PROPERTY'], [15, 'rad-anatomic-location-imaging-focus'],
      [16, 'rad-guidance-for-action'], [17, 'rad-guidance-for-approach'], [18, 'rad-guidance-for-object'],
      [19, 'rad-guidance-for-presence'], [20, 'rad-maneuver-maneuver-type'], [21, 'rad-modality-modality-subtype'],
      [22, 'rad-modality-modality-type'], [23, 'rad-pharmaceutical-route'], [24, 'rad-pharmaceutical-substance-given'],
      [25, 'rad-reason-for-exam'], [26, 'rad-subject'], [27, 'rad-timing'], [28, 'rad-view-aggregation'],
      [29, 'rad-view-view-type'], [30, 'SCALE_TYP'], [31, 'analyte-suffix'], [32, 'super-system'],
      [33, 'SYSTEM'], [34, 'TIME_ASPCT'], [35, 'time-modifier'], [36, 'rad-anatomic-location-laterality'],
      [37, 'rad-anatomic-location-laterality-presence'], [38, 'rad-anatomic-location-region-imaged'],
      [39, 'AnswerList'], [40, 'Answer'], [41, 'answers-for'], [42, 'parent'], [43, 'child']
    ];
    relationshipTypes.forEach(([key, desc]) => {
      db.run('INSERT INTO RelationshipTypes (RelationshipTypeKey, Description) VALUES (?, ?)', [key, desc]);
      this.rels.set(desc, key);
    });

    // Description types
    const descriptionTypes = [
      [1, 'LONG_COMMON_NAME'], [2, 'SHORTNAME'], [3, 'ConsumerName'],
      [4, 'RELATEDNAMES2'], [5, 'DisplayName'], [6, 'LinguisticVariantDisplayName']
    ];
    descriptionTypes.forEach(([key, desc]) => {
      db.run('INSERT INTO DescriptionTypes (DescriptionTypeKey, Description) VALUES (?, ?)', [key, desc]);
      this.dTypes.set(desc, key);
    });

    // Property types
    const propertyTypes = [
      [1, 'CLASSTYPE'], [2, 'ORDER_OBS'], [3, 'EXAMPLE_UNITS'], [4, 'EXAMPLE_UCUM_UNITS'],
      [5, 'PanelType'], [6, 'AskAtOrderEntry'], [7, 'UNITSREQUIRED'], [9, 'Copyright'],
      [10, 'ValidHL7AttachmentRequest']
    ];
    propertyTypes.forEach(([key, desc]) => {
      db.run('INSERT INTO PropertyTypes (PropertyTypeKey, Description) VALUES (?, ?)', [key, desc]);
      this.props.set(desc, key);
    });

    // Languages (English US is default)
    db.run('INSERT INTO Languages (LanguageKey, Code, Description) VALUES (1, "en-US", "English (United States)")');
    this.langs.set('en-US', 1);
  }

  async discoverLanguageVariants(sourceDir) {
    const languageVariants = [];
    const linguisticVariantsDir = path.join(sourceDir, 'AccessoryFiles/LinguisticVariants');

    if (fs.existsSync(linguisticVariantsDir)) {
      const files = fs.readdirSync(linguisticVariantsDir);
      for (const file of files) {
        if (file.includes('LinguisticVariant.csv') && !file.startsWith('LinguisticVariants.csv')) {
          const match = file.match(/^([a-z]{2}[A-Z]{2})/);
          if (match) {
            const langCode = match[1].substring(0, 2) + '-' + match[1].substring(2);
            languageVariants.push(langCode);
          }
        }
      }
    }
    return languageVariants;
  }

  async processLanguageVariants(db, sourceDir, step, options) {
    if (options.verbose) console.log('Processing Language Variants...');

    const filePath = path.join(sourceDir, 'AccessoryFiles/LinguisticVariants/LinguisticVariants.csv');
    if (!fs.existsSync(filePath)) {
      if (options.verbose) console.warn(`Language variants file not found: ${filePath}`);
      return;
    }

    const rl = csvRecords(filePath);

    let lineCount = 0;
    for await (const line of rl) {
      lineCount++;
      if (lineCount === 1) continue;

      const items = csvSplit(line, 4);
      if (items.length < 4) continue;

      const key = parseInt(items[0]);
      const langCode = items[1] + '-' + items[2];
      const description = items[3];

      db.run('INSERT INTO Languages (LanguageKey, Code, Description) VALUES (?, ?, ?)',
        [key, langCode, description]);
      this.langs.set(langCode, key);

      if (key > this.langKey) this.langKey = key;
    }
  }

  async processParts(db, sourceDir, step, options) {
    if (options.verbose) console.log('Processing Parts...');

    const filePath = path.join(sourceDir, 'AccessoryFiles/PartFile/Part.csv');
    const rl = csvRecords(filePath);

    let lineCount = 0;
    let processedCount = 0;

    for await (const line of rl) {
      lineCount++;
      if (lineCount === 1) continue;

      const items = csvSplit(line, 5);
      if (items.length < 5) continue;

      await this.processPartItem(db, items);
      processedCount++;

      if (processedCount % 100 === 0) {
        this.updateProgress(100);
      }
    }

    const remaining = processedCount % 100;
    if (remaining > 0) {
      this.updateProgress(remaining);
    }

    if (options.verbose) console.log(`  Processed ${processedCount} parts`);
  }

  async processPartItem(db, items) {
    this.codeKey++;
    const codeKey = this.codeKey;
    const code = items[0];
    const type = 2;
    const relKey = this.rels.get(adjustPropName(items[1]));
    const description = items[2];
    const statusKey = this.statii.get(items[4]) || 0;

    db.run('INSERT INTO Codes (CodeKey, Code, Type, RelationshipKey, StatusKey, Description) VALUES (?, ?, ?, ?, ?, ?)',
      [codeKey, code, type, relKey, statusKey, description]);

    const codeInfo = { key: codeKey, children: new Set() };
    this.codes.set(code, codeInfo);
    this.codeList.push(codeInfo);
    this.partNames.set(items[1] + '.' + items[2], items[0]);

    this.addDescription(db, codeKey, 1, this.dTypes.get('DisplayName'), items[3]);
  }

  async processCodes(db, sourceDir, step, options) {
    if (options.verbose) console.log('Processing Main Codes...');

    const filePath = path.join(sourceDir, 'LoincTable/Loinc.csv');
    const rl = csvRecords(filePath);

    let lineCount = 0;
    let processedCount = 0;

    for await (const line of rl) {
      lineCount++;
      if (lineCount === 1) continue;

      const items = csvSplit(line, 39);
      if (items.length < 39) continue;

      await this.processCodeItem(db, items);
      processedCount++;

      if (processedCount % 100 === 0) {
        this.updateProgress(100);
      }
    }

    const remaining = processedCount % 100;
    if (remaining > 0) {
      this.updateProgress(remaining);
    }

    if (options.verbose) console.log(`  Processed ${processedCount} main codes`);
  }

  async processCodeItem(db, items) {
    this.codeKey++;
    const codeKey = this.codeKey;
    const code = removeQuotes(items[0]);
    const type = 1;
    const description = removeQuotes(items[25]);
    const statusKey = this.statii.get(items[11]) || 1;

    db.run('INSERT INTO Codes (CodeKey, Code, Type, RelationshipKey, StatusKey, Description) VALUES (?, ?, ?, ?, ?, ?)',
      [codeKey, code, type, null, statusKey, description]);

    const codeInfo = { key: codeKey, children: new Set() };
    this.codes.set(code, codeInfo);
    this.codeList.push(codeInfo);

    // Add CLASS relationship
    const clsCode = this.partNames.get('CLASS.' + items[7]);
    if (clsCode && this.codes.has(clsCode)) {
      this.addRelationship(db, codeKey, this.codes.get(clsCode).key, this.rels.get('CLASS'));
    }

    // Add properties
    this.addProperty(db, codeKey, this.props.get('CLASSTYPE'), descClassType(items[13]));
    this.addProperty(db, codeKey, this.props.get('ORDER_OBS'), items[21]);
    this.addProperty(db, codeKey, this.props.get('EXAMPLE_UNITS'), items[24]);
    this.addProperty(db, codeKey, this.props.get('EXAMPLE_UCUM_UNITS'), items[26]);
    this.addProperty(db, codeKey, this.props.get('PanelType'), items[34]);
    this.addProperty(db, codeKey, this.props.get('AskAtOrderEntry'), items[35]);
    this.addProperty(db, codeKey, this.props.get('UNITSREQUIRED'), items[18]);
    this.addProperty(db, codeKey, this.props.get('Copyright'), items[23]);
    this.addProperty(db, codeKey, this.props.get('ValidHL7AttachmentRequest'), items[38]);

    // Add descriptions
    this.addDescription(db, codeKey, 1, this.dTypes.get('LONG_COMMON_NAME'), description);
    this.addDescription(db, codeKey, 1, this.dTypes.get('ConsumerName'), items[12]);
    this.addDescription(db, codeKey, 1, this.dTypes.get('RELATEDNAMES2'), items[19]);
    this.addDescription(db, codeKey, 1, this.dTypes.get('SHORTNAME'), items[20]);
    this.addDescription(db, codeKey, 1, this.dTypes.get('DisplayName'), items[39]);
  }

  async processConsumerNames(db, sourceDir, step, options) {
    const filePath = path.join(sourceDir, 'AccessoryFiles/ConsumerName/ConsumerName.csv');
    if (!fs.existsSync(filePath)) {
      if (options.verbose) console.warn(`Consumer names file not found: ${filePath}`);
      return;
    }

    if (options.verbose) console.log('Processing Consumer Names...');

    const rl = csvRecords(filePath);

    let lineCount = 0;
    let processedCount = 0;
    for await (const line of rl) {
      lineCount++;
      if (lineCount === 1) continue;

      const items = csvSplit(line, 2);
      if (items.length < 2 || !this.codes.has(items[0])) continue;

      this.addDescription(db, this.codes.get(items[0]).key, 1,
        this.dTypes.get('ConsumerName'), items[1]);
      processedCount++;

      if (processedCount % 100 === 0) {
        this.updateProgress(100);
      }
    }

    const remaining = processedCount % 100;
    if (remaining > 0) {
      this.updateProgress(remaining);
    }
  }

  async processLists(db, sourceDir, step, options) {
    const filePath = path.join(sourceDir, 'AccessoryFiles/AnswerFile/AnswerList.csv');
    if (!fs.existsSync(filePath)) {
      if (options.verbose) console.warn(`Answer lists file not found: ${filePath}`);
      return;
    }

    if (options.verbose) console.log('Processing Answer Lists...');

    const rl = csvRecords(filePath);

    let lineCount = 0;
    let processedCount = 0;
    let currentList = '';

    for await (const line of rl) {
      lineCount++;
      if (lineCount === 1) continue;

      const items = csvSplit(line, 15);
      if (items.length < 11) continue;

      await this.processListItem(db, items, currentList);
      currentList = items[0];
      processedCount++;

      if (processedCount % 100 === 0) {
        this.updateProgress(100);
      }
    }

    const remaining = processedCount % 100;
    if (remaining > 0) {
      this.updateProgress(remaining);
    }
  }

  async processListItem(db, items, currentList) {
    const listCode = removeQuotes(items[0]);
    let listCodeKey;

    if (listCode !== currentList) {
      this.codeKey++;
      listCodeKey = this.codeKey;
      const description = removeQuotes(items[1]);

      db.run('INSERT INTO Codes (CodeKey, Code, Type, RelationshipKey, StatusKey, Description) VALUES (?, ?, ?, ?, ?, ?)',
        [listCodeKey, listCode, 3, null, 0, description]);

      this.codes.set(listCode, { key: listCodeKey, children: new Set() });
    } else {
      listCodeKey = this.codes.get(listCode).key;
    }

    const answerCode = removeQuotes(items[6]);
    let answerCodeKey;

    if (this.codes.has(answerCode)) {
      answerCodeKey = this.codes.get(answerCode).key;
    } else {
      this.codeKey++;
      answerCodeKey = this.codeKey;
      const description = removeQuotes(items[10]);

      db.run('INSERT INTO Codes (CodeKey, Code, Type, RelationshipKey, StatusKey, Description) VALUES (?, ?, ?, ?, ?, ?)',
        [answerCodeKey, answerCode, 4, null, 0, description]);

      this.codes.set(answerCode, { key: answerCodeKey, children: new Set() });
    }

    this.addRelationship(db, listCodeKey, answerCodeKey, this.rels.get('Answer'));
    this.addRelationship(db, answerCodeKey, listCodeKey, this.rels.get('AnswerList'));

    // ExtCodeId (11), ExtCodeDisplayName (12), ExtCodeSystem (13), ExtCodeSystemVersion (14).
    // The file carries no equivalence for these; an answer and its external code are the same thing
    if (items[11] && items[13]) {
      this.addExternalMapping(db, answerCodeKey, items[13], items[14], items[11], items[12], 'equivalent');
    }
  }

  async processPartMappings(db, sourceDir, step, options) {
    const filePath = path.join(sourceDir, 'AccessoryFiles/PartFile/PartRelatedCodeMapping.csv');
    if (!fs.existsSync(filePath)) {
      if (options.verbose) console.warn(`Part mapping file not found: ${filePath}`);
      return;
    }

    if (options.verbose) console.log('Processing Part Mappings...');

    const rl = csvRecords(filePath);

    // PartNumber, PartName, PartTypeName, ExtCodeId, ExtCodeDisplayName, ExtCodeSystem,
    // Equivalence, ContentOrigin, ExtCodeSystemVersion, ExtCodeSystemCopyrightNotice
    let lineCount = 0;
    let processedCount = 0;
    for await (const line of rl) {
      lineCount++;
      if (lineCount === 1) continue;

      const items = csvSplit(line, 10);
      const partCode = items[0];
      const system = items[5];
      // RadLex mappings are not simple code-to-code maps; not handled yet
      if (!items[3] || !system || system === 'http://www.radlex.org' || !this.codes.has(partCode)) continue;

      this.addExternalMapping(db, this.codes.get(partCode).key, system, items[8], items[3], items[4], items[6] || 'equivalent');
      processedCount++;

      if (processedCount % 100 === 0) {
        this.updateProgress(100);
      }
    }

    const remaining = processedCount % 100;
    if (remaining > 0) {
      this.updateProgress(remaining);
    }
  }

  async processIeeeMappings(db, sourceDir, step, options) {
    const filePath = path.join(sourceDir, 'AccessoryFiles/LoincIeeeMedicalDeviceCodeMappingTable/LoincIeeeMedicalDeviceCodeMappingTable.csv');
    if (!fs.existsSync(filePath)) {
      if (options.verbose) console.warn(`IEEE mapping file not found: ${filePath}`);
      return;
    }

    if (options.verbose) console.log('Processing IEEE Mappings...');

    const rl = csvRecords(filePath);

    // LOINC_NUM, LOINC_LONG_COMMON_NAME, IEEE_CF_CODE10, IEEE_REFID, EQUIVALENCE
    // The code is the CF_CODE10 (as used in FHIR, e.g. 150456); the REFID is its display.
    let lineCount = 0;
    let processedCount = 0;
    for await (const line of rl) {
      lineCount++;
      if (lineCount === 1) continue;

      const items = csvSplit(line, 5);
      const loincCode = items[0];
      if (!items[2] || !this.codes.has(loincCode)) continue;

      this.addExternalMapping(db, this.codes.get(loincCode).key, 'urn:iso:std:iso:11073:10101', null,
        items[2], items[3], ieeeEquivalence(items[4]));
      processedCount++;

      if (processedCount % 100 === 0) {
        this.updateProgress(100);
      }
    }

    const remaining = processedCount % 100;
    if (remaining > 0) {
      this.updateProgress(remaining);
    }
  }

  addExternalMapping(db, codeKey, system, version, code, display, equivalence) {
    system = normaliseExternalSystem(system);
    version = version || null;
    const targetId = system + '|' + (version || '') + '|' + code;
    let extKey = this.extCodes.get(targetId);
    if (!extKey) {
      this.extCodeKey++;
      extKey = this.extCodeKey;
      this.extCodes.set(targetId, extKey);
      db.run('INSERT INTO ExternalCodes (ExternalCodeKey, System, Version, Code, Display) VALUES (?, ?, ?, ?, ?)',
        [extKey, system, version, code, display || null]);
    }

    // the same answer appears once per answer list it's in
    const mapId = codeKey + '|' + extKey;
    if (this.extMaps.has(mapId)) return;
    this.extMaps.add(mapId);
    this.extMapKey++;
    db.run('INSERT INTO ExternalMappings (ExternalMappingKey, CodeKey, ExternalCodeKey, Equivalence) VALUES (?, ?, ?, ?)',
      [this.extMapKey, codeKey, extKey, equivalence]);
  }

  async processPartLinks(db, sourceDir, step, options) {
    const filePath = path.join(sourceDir, 'AccessoryFiles/PartFile/LoincPartLink_Primary.csv');
    if (!fs.existsSync(filePath)) {
      if (options.verbose) console.warn(`Part links file not found: ${filePath}`);
      return;
    }

    if (options.verbose) console.log('Processing Part Links...');

    const rl = csvRecords(filePath);

    let lineCount = 0;
    let processedCount = 0;
    for await (const line of rl) {
      lineCount++;
      if (lineCount === 1) continue;

      const items = csvSplit(line, 7);
      if (items.length < 7) continue;

      const sourceCode = items[0];
      const targetCode = items[2];
      const relType = adjustPropName(items[5]);
      const status = items[6];

      if (this.codes.has(sourceCode) && this.codes.has(targetCode)) {
        this.addRelationship(db,
          this.codes.get(sourceCode).key,
          this.codes.get(targetCode).key,
          this.rels.get(relType),
          this.statii.get(status) || 0
        );
      }
      processedCount++;

      if (processedCount % 100 === 0) {
        this.updateProgress(100);
      }
    }

    const remaining = processedCount % 100;
    if (remaining > 0) {
      this.updateProgress(remaining);
    }
  }

  async processListLinks(db, sourceDir, step, options) {
    const filePath = path.join(sourceDir, 'AccessoryFiles/AnswerFile/LoincAnswerListLink.csv');
    if (!fs.existsSync(filePath)) {
      if (options.verbose) console.warn(`List links file not found: ${filePath}`);
      return;
    }

    if (options.verbose) console.log('Processing List Links...');

    const rl = csvRecords(filePath);

    let lineCount = 0;
    let processedCount = 0;
    for await (const line of rl) {
      lineCount++;
      if (lineCount === 1) continue;

      const items = csvSplit(line, 5);
      if (items.length < 5) continue;

      const sourceCode = items[0];
      const targetCode = items[2];
      const status = items[4];

      if (this.codes.has(sourceCode) && this.codes.has(targetCode)) {
        const statusKey = this.statii.get(status) || 0;
        this.addRelationship(db,
          this.codes.get(sourceCode).key,
          this.codes.get(targetCode).key,
          this.rels.get('AnswerList'),
          statusKey
        );
        this.addRelationship(db,
          this.codes.get(targetCode).key,
          this.codes.get(sourceCode).key,
          this.rels.get('answers-for'),
          statusKey
        );
      }
      processedCount++;

      if (processedCount % 100 === 0) {
        this.updateProgress(100);
      }
    }

    const remaining = processedCount % 100;
    if (remaining > 0) {
      this.updateProgress(remaining);
    }
  }

  async processHierarchy(db, sourceDir, step, options) {
    const filePath = path.join(sourceDir, 'AccessoryFiles/ComponentHierarchyBySystem/ComponentHierarchyBySystem.csv');
    if (!fs.existsSync(filePath)) {
      // Validation should have caught this already; if we get here, fail rather than build a
      // cache with an empty closure that answers subsumption questions with a confident no
      throw new Error(`Required file missing: ${filePath}`);
    }

    if (options.verbose) console.log('Processing Hierarchy...');

    const rl = csvRecords(filePath);

    let lineCount = 0;
    let processedCount = 0;
    for await (const line of rl) {
      lineCount++;
      if (lineCount === 1) continue;

      const items = csvSplit(line, 12);
      if (items.length < 5) continue;

      await this.processHierarchyItem(db, items);
      processedCount++;

      if (processedCount % 100 === 0) {
        this.updateProgress(100);
      }
    }

    const remaining = processedCount % 100;
    if (remaining > 0) {
      this.updateProgress(remaining);
    }
  }

  async processHierarchyItem(db, items) {
    const pathCode = items[3];
    const parentPath = items[2];
    const description = items[4].trim();

    if (!this.codes.has(pathCode)) {
      this.codeKey++;
      const codeKey = this.codeKey;

      db.run('INSERT INTO Codes (CodeKey, Code, Type, RelationshipKey, StatusKey, Description) VALUES (?, ?, ?, ?, ?, ?)',
        [codeKey, pathCode, 2, 0, 0, description]);

      const codeInfo = { key: codeKey, children: new Set() };
      this.codes.set(pathCode, codeInfo);
      this.codeList.push(codeInfo);
    }

    if (!parentPath) {
      db.run('INSERT INTO Config (ConfigKey, Value) VALUES (3, ?)', [pathCode]);
    } else if (this.codes.has(parentPath)) {
      const childKey = this.codes.get(pathCode).key;
      const parentKey = this.codes.get(parentPath).key;

      this.addRelationship(db, childKey, parentKey, this.rels.get('parent'));
      this.addRelationship(db, parentKey, childKey, this.rels.get('child'));

      const pathParts = items[0].split('.');
      for (const ancestorCode of pathParts) {
        if (this.codes.has(ancestorCode)) {
          const ancestorInfo = this.codes.get(ancestorCode);
          ancestorInfo.children.add(childKey);
        }
      }
    }
  }

  async processPropertyValues(db, step, options) {
    if (options.verbose) console.log('Processing Property Values...');

    for (const [value, key] of this.propValues) {
      db.run('INSERT INTO PropertyValues (PropertyValueKey, Value) VALUES (?, ?)', [key, value]);
    }
  }

  async storeClosureTable(db, step, options) {
    if (options.verbose) console.log('Storing Closure Table...');

    let count = 0;
    for (const codeInfo of this.codeList) {
      count++;

      if (codeInfo.children.size > 0) {
        for (const descendentKey of codeInfo.children) {
          db.run('INSERT INTO Closure (AncestorKey, DescendentKey) VALUES (?, ?)',
            [codeInfo.key, descendentKey]);
        }
      }

      if (count % 100 === 0) {
        this.updateProgress(100);
      }
    }

    const remaining = count % 100;
    if (remaining > 0) {
      this.updateProgress(remaining);
    }
  }

  async processLanguage(db, sourceDir, step, langCode, options) {
    if (options.verbose) console.log(`Processing Language ${langCode}...`);

    const langKey = this.langs.get(langCode);
    if (!langKey) return;

    const baseCode = langCode.replace('-', '');
    const fileName = `${baseCode}${langKey}LinguisticVariant.csv`;
    const filePath = path.join(sourceDir, 'AccessoryFiles/LinguisticVariants', fileName);

    if (!fs.existsSync(filePath)) {
      if (options.verbose) console.warn(`Language file not found: ${filePath}`);
      return;
    }

    const rl = csvRecords(filePath);

    let lineCount = 0;
    let processedCount = 0;
    for await (const line of rl) {
      lineCount++;
      if (lineCount === 1) continue;

      const items = csvSplit(line, 12);
      if (items.length < 12 || !this.codes.has(items[0])) continue;

      const codeKey = this.codes.get(items[0]).key;

      this.addDescription(db, codeKey, langKey, this.dTypes.get('LONG_COMMON_NAME'), items[9]);
      this.addDescription(db, codeKey, langKey, this.dTypes.get('RELATEDNAMES2'), items[10]);
      this.addDescription(db, codeKey, langKey, this.dTypes.get('SHORTNAME'), items[8]);
      this.addDescription(db, codeKey, langKey, this.dTypes.get('LinguisticVariantDisplayName'), items[11]);

      processedCount++;

      if (processedCount % 100 === 0) {
        this.updateProgress(100);
      }
    }

    const remaining = processedCount % 100;
    if (remaining > 0) {
      this.updateProgress(remaining);
    }
  }

  addDescription(db, codeKey, languageKey, descriptionType, value) {
    if (!value) return;

    this.descKey++;
    db.run('INSERT INTO Descriptions (DescriptionKey, CodeKey, LanguageKey, DescriptionTypeKey, Value) VALUES (?, ?, ?, ?, ?)',
      [this.descKey, codeKey, languageKey, descriptionType, value]);

    db.run('INSERT INTO TextIndex (codekey, type, lang, text) VALUES (?, ?, ?, ?)',
      [codeKey, descriptionType, languageKey, value]);
  }

  addProperty(db, codeKey, propertyType, value) {
    if (!value || !propertyType) return;

    this.propKey++;
    const propertyValueKey = this.getPropertyValueKey(value);

    db.run('INSERT INTO Properties (PropertyKey, PropertyTypeKey, CodeKey, PropertyValueKey) VALUES (?, ?, ?, ?)',
      [this.propKey, propertyType, codeKey, propertyValueKey]);
  }

  addRelationship(db, sourceKey, targetKey, relationshipType, statusKey = 0) {
    if (!relationshipType) return;

    this.relKey++;
    db.run('INSERT INTO Relationships (RelationshipKey, RelationshipTypeKey, SourceKey, TargetKey, StatusKey) VALUES (?, ?, ?, ?, ?)',
      [this.relKey, relationshipType, sourceKey, targetKey, statusKey]);
  }

  getPropertyValueKey(value) {
    if (this.propValues.has(value)) {
      return this.propValues.get(value);
    }

    this.propValueKey++;
    this.propValues.set(value, this.propValueKey);
    return this.propValueKey;
  }

  async closeDatabase(db, verbose = true) {
    return new Promise((resolve) => {
      db.close((err) => {
        if (err && verbose) {
          console.error('Error closing database:', err);
        }
        resolve();
      });
    });
  }
}

// Property name mappings from Pascal code
const KNOWN_PROPERTY_NAMES = [
  'AskAtOrderEntry', 'AssociatedObservations', 'CHANGE_REASON_PUBLIC', 'CHNG_TYPE', 'CLASS', 'CLASSTYPE', 'COMMON_ORDER_RANK', 'COMMON_TEST_RANK', 'COMPONENT', 'CONSUMER_NAME',
  'DefinitionDescription', 'DisplayName', 'EXAMPLE_UCUM_UNITS', 'EXAMPLE_UNITS', 'EXMPL_ANSWERS', 'EXTERNAL_COPYRIGHT_LINK', 'EXTERNAL_COPYRIGHT_NOTICE', 'FORMULA',
  'HL7_ATTACHMENT_STRUCTURE', 'HL7_FIELD_SUBFIELD_ID', 'LONG_COMMON_NAME', 'MAP_TO', 'METHOD_TYP', 'ORDER_OBS', 'PROPERTY', 'PanelType', 'RELATEDNAMES2', 'SCALE_TYP',
  'SHORTNAME', 'STATUS', 'STATUS_REASON', 'STATUS_TEXT', 'SURVEY_QUEST_SRC', 'SURVEY_QUEST_TEXT', 'SYSTEM', 'TIME_ASPCT', 'UNITSREQUIRED', 'ValidHL7AttachmentRequest',
  'VersionFirstReleased', 'VersionLastChanged', 'adjustment', 'analyte', 'analyte-core', 'analyte-divisor', 'analyte-divisor-suffix', 'analyte-gene', 'analyte-numerator',
  'analyte-suffix', 'answer-list', 'answers-for', 'category', 'challenge', 'child', 'count', 'document-kind', 'document-role', 'document-setting', 'document-subject-matter-domain',
  'document-type-of-service', 'parent', 'rad-anatomic-location-imaging-focus', 'rad-anatomic-location-laterality', 'rad-anatomic-location-laterality-presence', 'rad-anatomic-location-region-imaged',
  'rad-guidance-for-action', 'rad-guidance-for-approach', 'rad-guidance-for-object', 'rad-guidance-for-presence', 'rad-maneuver-maneuver-type', 'rad-modality-modality-subtype',
  'rad-modality-modality-type', 'rad-pharmaceutical-route', 'rad-pharmaceutical-substance-given', 'rad-reason-for-exam', 'rad-subject', 'rad-timing', 'rad-view-aggregation',
  'rad-view-view-type', 'search', 'super-system', 'system-core', 'time-core', 'time-modifier',
  'Answer', 'AnswerList'
];

function adjustPropName(s) {
  if (KNOWN_PROPERTY_NAMES.includes(s)) {
    return s;
  }

  const mappings = {
    'ADJUSTMENT': 'adjustment',
    'CHALLENGE': 'challenge',
    'COUNT': 'count',
    'DIVISORS': 'analyte-divisor',
    'Document.Kind': 'document-kind',
    'Document.Role': 'document-role',
    'Document.Setting': 'document-setting',
    'Document.SubjectMatterDomain': 'document-subject-matter-domain',
    'Document.TypeOfService': 'document-type-of-service',
    'GENE': 'analyte-gene',
    'METHOD': 'METHOD_TYP',
    'Rad.Anatomic Location.Imaging Focus': 'rad-anatomic-location-imaging-focus',
    'Rad.Anatomic Location.Laterality': 'rad-anatomic-location-laterality',
    'Rad.Anatomic Location.Laterality.Presence': 'rad-anatomic-location-laterality-presence',
    'Rad.Anatomic Location.Region Imaged': 'rad-anatomic-location-region-imaged',
    'Rad.Guidance for.Action': 'rad-guidance-for-action',
    'Rad.Guidance for.Approach': 'rad-guidance-for-approach',
    'Rad.Guidance for.Object': 'rad-guidance-for-object',
    'Rad.Guidance for.Presence': 'rad-guidance-for-presence',
    'Rad.Maneuver.Maneuver Type': 'rad-maneuver-maneuver-type',
    'Rad.Modality.Modality Subtype': 'rad-modality-modality-subtype',
    'Rad.Modality.Modality Type': 'rad-modality-modality-type',
    'Rad.Pharmaceutical.Route': 'rad-pharmaceutical-route',
    'Rad.Pharmaceutical.Substance Given': 'rad-pharmaceutical-substance-given',
    'Rad.Reason for Exam': 'rad-reason-for-exam',
    'Rad.Subject': 'rad-subject',
    'Rad.Timing': 'rad-timing',
    'Rad.View.Aggregation': 'rad-view-aggregation',
    'Rad.View.View Type': 'rad-view-view-type',
    'SCALE': 'SCALE_TYP',
    'SUFFIX': 'analyte-suffix',
    'SUPER SYSTEM': 'super-system',
    'TIME': 'TIME_ASPCT',
    'TIME MODIFIER': 'time-modifier'
  };

  if (mappings[s]) {
    return mappings[s];
  }

  throw new Error(`Unknown Property Name: ${s}`);
}

// LOINC names some code systems with something other than their FHIR URI. The others not yet
// known ('CMS LCDS', 'Unicode') are left as LOINC has them
const EXTERNAL_SYSTEM_URIS = {
  'CMS/HCPCS': 'http://www.cms.gov/Medicare/Coding/HCPCSReleaseCodeSets',
  'https://www.cdc.gov/phin': 'urn:oid:2.16.840.1.113883.6.238' // CDC Race & Ethnicity
};

function normaliseExternalSystem(system) {
  return EXTERNAL_SYSTEM_URIS[system] || system;
}

// The IEEE table states equivalence from the LOINC side ('broader' = the LOINC code is broader,
// e.g. Glucose in Serum or Plasma -> MDC_CONC_GLU_VENOUS_PLASMA). ConceptMap equivalence is stated
// from the target side, so broader/narrower swap to narrower/wider.
function ieeeEquivalence(s) {
  switch (s) {
    case 'broader': return 'narrower';
    case 'narrower': return 'wider';
    case '': return 'equivalent';
    default: return s;
  }
}

function descClassType(s) {
  const types = {
    '1': 'Laboratory class',
    '2': 'Clinical class',
    '3': 'Claims attachment',
    '4': 'Surveys'
  };
  return types[s] || s;
}

// CSV parsing utility
function csvSplit(line, expectedCount) {
  const result = new Array(expectedCount).fill('');
  let inQuoted = false;
  let currentField = 0;
  let fieldStart = 0;
  let i = 0;

  while (i < line.length && currentField < expectedCount) {
    const ch = line[i];

    if (!inQuoted && ch === ',') {
      if (currentField < expectedCount) {
        result[currentField] = line.substring(fieldStart, i).replace(/^"|"$/g, '').replace(/""/g, '"');
        currentField++;
        fieldStart = i + 1;
      }
    } else if (ch === '"') {
      if (inQuoted && i + 1 < line.length && line[i + 1] === '"') {
        i++;
      } else {
        inQuoted = !inQuoted;
      }
    }
    i++;
  }

  if (currentField < expectedCount) {
    result[currentField] = line.substring(fieldStart).replace(/^"|"$/g, '').replace(/""/g, '"');
  }

  return result;
}

function removeQuotes(str) {
  if (!str) return '';
  return str.replace(/^"|"$/g, '');
}

module.exports = {
  LoincModule,
  LoincDataMigrator,
  normaliseExternalSystem
};