const { BaseTerminologyModule } = require('./tx-import-base');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const readline = require('readline');
const terminal = require('./terminal');

class NdcModule extends BaseTerminologyModule {
  getName() {
    return 'ndc';
  }

  getDescription() {
    return 'National Drug Code (NDC) Directory from FDA';
  }

  getSupportedFormats() {
    return ['txt', 'tsv', 'directory'];
  }

  getEstimatedDuration() {
    return '30-90 minutes (depending on number of versions)';
  }

  registerCommands(terminologyCommand, globalOptions) {
    // Import command
    terminologyCommand
      .command('import')
      .description('Import NDC data from multiple version snapshots')
      .option('-s, --source <directory>', 'Source directory containing version subdirectories')
      .option('-d, --dest <file>', 'Destination SQLite database')
      .option('-v, --version <version>', 'Data version identifier')
      .option('-y, --yes', 'Skip confirmations')
      .option('--no-indexes', 'Skip index creation for faster import')
      .option('--products-only', 'Import only products (skip packages)')
      .option('--packages-only', 'Import only packages (requires existing products)')
      .action(async (options) => {
        await this.handleImportCommand({...globalOptions, ...options});
      });

    // Validate command
    terminologyCommand
      .command('validate')
      .description('Validate NDC source directory structure')
      .option('-s, --source <directory>', 'Source directory to validate')
      .option('--sample <lines>', 'Number of lines to sample per file', '100')
      .action(async (options) => {
        await this.handleValidateCommand({...globalOptions, ...options});
      });

    // Status command
    terminologyCommand
      .command('status')
      .description('Show status of NDC database')
      .option('-d, --dest <file>', 'Database file to check')
      .action(async (options) => {
        await this.handleStatusCommand({...globalOptions, ...options});
      });

    // List versions command
    terminologyCommand
      .command('versions')
      .description('List available NDC versions in source directory')
      .option('-s, --source <directory>', 'Source directory to scan')
      .action(async (options) => {
        await this.handleVersionsCommand({...globalOptions, ...options});
      });
  }

  async handleImportCommand(options) {
    // Gather configuration
    const config = await this.gatherCommonConfig(options);

    // NDC-specific configuration
    if (options.noIndexes) {
      config.createIndexes = false;
    }
    config.productsOnly = options.productsOnly || false;
    config.packagesOnly = options.packagesOnly || false;

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
    terminal.log(`  Products Only: ${chalk.white(config.productsOnly ? 'Yes' : 'No')}`);
    terminal.log(`  Packages Only: ${chalk.white(config.packagesOnly ? 'Yes' : 'No')}`);
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
        message: 'Source directory to validate:',
        validate: (input) => input && fs.existsSync(input) ? true : 'Directory does not exist'
      });
      options.source = answers.source;
    }

    this.logInfo(`Validating NDC directory: ${options.source}`);

    try {
      const stats = await this.validateNdcDirectory(options.source, parseInt(options.sample));

      this.logSuccess('Directory validation passed');
      terminal.log(`  Versions found: ${stats.versions.length}`);
      terminal.log(`  Total products estimated: ${stats.totalProducts.toLocaleString()}`);
      terminal.log(`  Total packages estimated: ${stats.totalPackages.toLocaleString()}`);
      terminal.log(`  Versions: ${stats.versions.join(', ')}`);

      if (stats.warnings.length > 0) {
        this.logWarning('Validation warnings:');
        stats.warnings.forEach(warning => terminal.log(`    ${warning}`));
      }

    } catch (error) {
      this.logError(`Validation failed: ${error.message}`);
    }
  }

  async handleVersionsCommand(options) {
    if (!options.source) {
      const answers = await require('inquirer').prompt({
        type: 'input',
        name: 'source',
        message: 'Source directory to scan:',
        validate: (input) => input && fs.existsSync(input) ? true : 'Directory does not exist'
      });
      options.source = answers.source;
    }

    try {
      const versions = await this.findVersions(options.source);

      this.logSuccess(`Found ${versions.length} NDC versions:`);
      versions.forEach((version, index) => {
        terminal.log(`  ${index + 1}. ${version}`);
      });

    } catch (error) {
      this.logError(`Failed to scan versions: ${error.message}`);
    }
  }

  async handleStatusCommand(options) {
    const dbPath = options.dest || './data/ndc.db';

    if (!fs.existsSync(dbPath)) {
      this.logError(`Database not found: ${dbPath}`);
      return;
    }

    this.logInfo(`Checking NDC database: ${dbPath}`);

    try {
      const stats = await this.getDatabaseStats(dbPath);

      this.logSuccess('Database status:');
      terminal.log(`  Versions: ${stats.versions.join(', ')}`);
      terminal.log(`  Products: ${stats.productCount.toLocaleString()}`);
      terminal.log(`  Packages: ${stats.packageCount.toLocaleString()}`);
      terminal.log(`  Organizations: ${stats.orgCount.toLocaleString()}`);
      terminal.log(`  Product Types: ${stats.typeCount.toLocaleString()}`);
      terminal.log(`  Database Size: ${stats.sizeGB.toFixed(2)} GB`);
      terminal.log(`  Last Modified: ${stats.lastModified}`);

    } catch (error) {
      this.logError(`Status check failed: ${error.message}`);
    }
  }

  async validatePrerequisites(config) {
    const baseValid = await super.validatePrerequisites(config);

    // NDC-specific validation
    try {
      this.logInfo('Validating NDC directory structure...');
      await this.validateNdcDirectory(config.source, 10);
      this.logSuccess('NDC directory structure valid');
    } catch (error) {
      this.logError(`NDC directory validation failed: ${error.message}`);
      return false;
    }

    return baseValid;
  }

  async executeImport(config) {
    this.logInfo('Starting NDC data migration...');

    // Create enhanced migrator with progress reporting
    const enhancedMigrator = new NdcDataMigratorWithProgress(
      this,
      config.verbose
    );

    await enhancedMigrator.migrate(
      config.source,
      config.dest,
      config.version,
      {
        verbose: config.verbose,
        productsOnly: config.productsOnly,
        packagesOnly: config.packagesOnly
      }
    );

    if (config.createIndexes) {
      this.logInfo('Creating database indexes...');
      await this.createIndexes(config.dest);
      this.logSuccess('Indexes created');
    }
  }

  async findVersions(sourceDir) {
    if (!fs.existsSync(sourceDir)) {
      throw new Error(`Source directory not found: ${sourceDir}`);
    }

    const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
    const versions = entries
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort();

    return versions;
  }

  async validateNdcDirectory(sourceDir, sampleLines = 100) {
    const versions = await this.findVersions(sourceDir);

    if (versions.length === 0) {
      throw new Error('No version subdirectories found');
    }

    let totalProducts = 0;
    let totalPackages = 0;
    const warnings = [];

    for (const version of versions) {
      const versionDir = path.join(sourceDir, version);
      const productFile = path.join(versionDir, 'product.txt');
      const packageFile = path.join(versionDir, 'package.txt');

      if (!fs.existsSync(productFile)) {
        warnings.push(`Missing product.txt in version ${version}`);
        continue;
      }

      if (!fs.existsSync(packageFile)) {
        warnings.push(`Missing package.txt in version ${version}`);
      }

      // Sample product file
      try {
        const productStats = await this.validateNdcFile(productFile, sampleLines, 'product');
        totalProducts += productStats.estimatedRecords;
      } catch (error) {
        warnings.push(`Product file validation failed for ${version}: ${error.message}`);
      }

      // Sample package file if it exists
      if (fs.existsSync(packageFile)) {
        try {
          const packageStats = await this.validateNdcFile(packageFile, sampleLines, 'package');
          totalPackages += packageStats.estimatedRecords;
        } catch (error) {
          warnings.push(`Package file validation failed for ${version}: ${error.message}`);
        }
      }
    }

    return {
      versions,
      totalProducts,
      totalPackages,
      warnings
    };
  }

  async validateNdcFile(filePath, sampleLines, fileType) {
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath),
      crlfDelay: Infinity
    });

    let lineCount = 0;
    let sampleCount = 0;
    let headerFound = false;
    let estimatedRecords = 0;

    const requiredFields = fileType === 'product'
      ? ['PRODUCTNDC', 'PRODUCTTYPENAME', 'PROPRIETARYNAME']
      : ['PRODUCTNDC', 'NDCPACKAGECODE', 'PACKAGEDESCRIPTION'];

    for await (const line of rl) {
      lineCount++;

      if (lineCount === 1) {
        // Check header
        const header = line.split('\t');
        const hasRequiredFields = requiredFields.every(field =>
          header.some(h => h.toUpperCase().includes(field))
        );

        if (hasRequiredFields) {
          headerFound = true;
        } else {
          throw new Error(`Missing required fields in ${fileType} file header`);
        }
        continue;
      }

      if (sampleCount < sampleLines) {
        const cols = line.split('\t');
        if (cols.length < 3) {
          throw new Error(`Insufficient columns at line ${lineCount}`);
        }
        sampleCount++;
      }

      estimatedRecords++;
    }

    if (!headerFound) {
      throw new Error(`No valid header found in ${fileType} file`);
    }

    return {
      totalLines: lineCount,
      estimatedRecords,
      formatValid: true
    };
  }

  async getDatabaseStats(dbPath) {
    const sqlite3 = require('sqlite3').verbose();
    const db = new sqlite3.Database(dbPath);

    return new Promise((resolve, reject) => {
      const stats = {};

      // Get versions
      db.all('SELECT Version FROM NDCVersion', (err, rows) => {
        if (err) return reject(err);
        stats.versions = rows.map(row => row.Version);

        // Get counts
        const queries = [
          { name: 'productCount', sql: 'SELECT COUNT(*) as count FROM NDCProducts' },
          { name: 'packageCount', sql: 'SELECT COUNT(*) as count FROM NDCPackages' },
          { name: 'orgCount', sql: 'SELECT COUNT(*) as count FROM NDCOrganizations' },
          { name: 'typeCount', sql: 'SELECT COUNT(*) as count FROM NDCProductTypes' }
        ];

        let completed = 0;

        queries.forEach(query => {
          db.get(query.sql, (err, row) => {
            if (err) return reject(err);
            stats[query.name] = row.count;
            completed++;

            if (completed === queries.length) {
              // Get file stats
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
      'CREATE INDEX IF NOT EXISTS idx_ndcproducts_code ON NDCProducts(Code)',
      'CREATE INDEX IF NOT EXISTS idx_ndcproducts_active ON NDCProducts(Active)',
      'CREATE INDEX IF NOT EXISTS idx_ndcproducts_type ON NDCProducts(Type)',
      'CREATE INDEX IF NOT EXISTS idx_ndcproducts_company ON NDCProducts(Company)',
      'CREATE INDEX IF NOT EXISTS idx_ndcpackages_code ON NDCPackages(Code)',
      'CREATE INDEX IF NOT EXISTS idx_ndcpackages_code11 ON NDCPackages(Code11)',
      'CREATE INDEX IF NOT EXISTS idx_ndcpackages_productkey ON NDCPackages(ProductKey)',
      'CREATE INDEX IF NOT EXISTS idx_ndcpackages_active ON NDCPackages(Active)'
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

class NdcDataMigrator {
  constructor(progressCallback = null) {
    this.progressCallback = progressCallback;
    this.currentProgress = 0;
  }

  async migrate(sourceDir, destFile = 'unknown', options = {}) {
    if (options.verbose) terminal.log('Starting NDC data migration...');

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
      await this.#createTables(db, options.verbose);

      // Find and process all versions
      const versions = await this.#findVersions(sourceDir);

      if (options.verbose) {
        terminal.log(`Found ${versions.length} versions: ${versions.join(', ')}`);
      }

      // Process each version
      for (const versionName of versions) {
        if (options.verbose) terminal.log(`Processing version: ${versionName}`);

        await this.#processVersion(db, sourceDir, versionName, options);
      }

      // Record only the latest version (matches Pascal behavior)
      if (this.latestVersion) {
        await this.#recordVersion(db, this.latestVersion);
      }

      // Create lookup tables
      await this.#createLookupTables(db, options.verbose);

      if (options.verbose) terminal.log('NDC data migration completed successfully');
    } finally {
      await this.#closeDatabase(db, options.verbose);
    }
  }

  updateProgress(amount = 1) {
    this.currentProgress += amount;
    if (this.progressCallback) {
      this.progressCallback(this.currentProgress);
    }
  }

  async #findVersions(sourceDir) {
    const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort();
  }

  async #createTables(db, verbose = true) {
    if (verbose) terminal.log('Creating database tables...');

    const tableSQL = [
      `CREATE TABLE NDCProducts (
        NDCKey INTEGER NOT NULL PRIMARY KEY,
        Code TEXT(11) NOT NULL,
        LastSeen TEXT(20) NULL,
        Active INTEGER NOT NULL,
        Type INTEGER NOT NULL,
        TradeName TEXT(255) NOT NULL,
        Suffix TEXT(180) NOT NULL,
        DoseForm INTEGER NOT NULL,
        Route INTEGER NOT NULL,
        StartDate TEXT(20) NULL,
        EndDate TEXT(20) NULL,
        Category TEXT(40) NOT NULL,
        Company INTEGER NOT NULL,
        Generics TEXT NULL
      )`,

      `CREATE TABLE NDCPackages (
        NDCKey INTEGER NOT NULL PRIMARY KEY,
        ProductKey INTEGER NOT NULL,
        Code TEXT(12) NOT NULL,
        Code11 TEXT(11) NOT NULL,
        LastSeen TEXT(20) NULL,
        Active INTEGER NOT NULL,
        Description TEXT(255) NOT NULL
      )`,

      `CREATE TABLE NDCProductTypes (
        NDCKey INTEGER NOT NULL PRIMARY KEY,
        Name TEXT(255) NOT NULL
      )`,

      `CREATE TABLE NDCOrganizations (
        NDCKey INTEGER NOT NULL PRIMARY KEY,
        Name TEXT(500) NOT NULL
      )`,

      `CREATE TABLE NDCDoseForms (
        NDCKey INTEGER NOT NULL PRIMARY KEY,
        Name TEXT(255) NOT NULL
      )`,

      `CREATE TABLE NDCRoutes (
        NDCKey INTEGER NOT NULL PRIMARY KEY,
        Name TEXT(255) NOT NULL
      )`,

      `CREATE TABLE NDCVersion (
        Version TEXT(50) NOT NULL
      )`
    ];

    return new Promise((resolve, reject) => {
      db.serialize(() => {
        tableSQL.forEach(sql => {
          db.run(sql, (err) => {
            if (err) return reject(err);
          });
        });

        if (verbose) terminal.log('Database tables created');
        resolve();
      });
    });
  }

  async #processVersion(db, sourceDir, versionName, options) {
    const versionDir = path.join(sourceDir, versionName);

    if (!options.packagesOnly) {
      await this.#processProducts(db, versionDir, versionName, options);
    }

    if (!options.productsOnly) {
      await this.#processPackages(db, versionDir, versionName, options);
    }

    // Store this as the latest version (will be the last one processed)
    this.latestVersion = versionName;
  }

  async #processProducts(db, versionDir, versionName, options) {
    const productFile = path.join(versionDir, 'product.txt');

    if (!fs.existsSync(productFile)) {
      if (options.verbose) terminal.warn(`Product file not found: ${productFile}`);
      return;
    }

    if (options.verbose) terminal.log(`Processing products from ${versionName}...`);

    const rl = readline.createInterface({
      input: fs.createReadStream(productFile),
      crlfDelay: Infinity
    });

    let header = null;
    let lineCount = 0;
    let processedCount = 0;
    const batchSize = 1000;
    let batch = [];

    // Lookup maps for normalization
    const typesMap = new Map();
    const orgsMap = new Map();
    const doseFormsMap = new Map();
    const routesMap = new Map();
    const codesMap = new Map();

    const insertProduct = db.prepare(`
      INSERT OR REPLACE INTO NDCProducts 
      (NDCKey, Code, LastSeen, Active, Type, TradeName, Suffix, DoseForm, Route, StartDate, EndDate, Category, Company, Generics)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for await (const line of rl) {
      lineCount++;

      if (lineCount === 1) {
        header = line.split('\t');
        continue;
      }

      const cols = line.split('\t');
      if (cols.length < 10) continue;

      const product = this.#parseProductLine(header, cols, versionName);
      if (!product) continue;

      // Get or create lookup IDs
      product.typeId = this.#getOrCreateLookupId(typesMap, product.productTypeName);
      product.orgId = this.#getOrCreateLookupId(orgsMap, product.labelerName);
      product.doseFormId = this.#getOrCreateLookupId(doseFormsMap, product.dosageFormName);
      product.routeId = this.#getOrCreateLookupId(routesMap, product.routeName);

      // Generate unique key
      let productKey = codesMap.get(product.code);
      if (!productKey) {
        productKey = codesMap.size + 1;
        codesMap.set(product.code, productKey);
      }

      batch.push({
        key: productKey,
        ...product
      });

      if (batch.length >= batchSize) {
        await this._processBatch(db, insertProduct, batch);
        processedCount += batch.length;
        this.updateProgress(batch.length);
        batch = [];

        if (processedCount % 10000 === 0 && options.verbose) {
          terminal.log(`  Processed ${processedCount} products...`);
        }
      }
    }

    // Process remaining batch
    if (batch.length > 0) {
      await this._processBatch(db, insertProduct, batch);
      processedCount += batch.length;
      this.updateProgress(batch.length);
    }

    insertProduct.finalize();

    // Store lookup maps for later use
    this.typesMap = typesMap;
    this.orgsMap = orgsMap;
    this.doseFormsMap = doseFormsMap;
    this.routesMap = routesMap;
    this.codesMap = codesMap;

    if (options.verbose) {
      terminal.log(`  Completed products: ${processedCount} records`);
    }
  }

  async #processPackages(db, versionDir, versionName, options) {
    const packageFile = path.join(versionDir, 'package.txt');

    if (!fs.existsSync(packageFile)) {
      if (options.verbose) terminal.warn(`Package file not found: ${packageFile}`);
      return;
    }

    if (options.verbose) terminal.log(`Processing packages from ${versionName}...`);

    const rl = readline.createInterface({
      input: fs.createReadStream(packageFile),
      crlfDelay: Infinity
    });

    let header = null;
    let lineCount = 0;
    let processedCount = 0;
    const batchSize = 1000;
    let batch = [];

    const packageCodesMap = new Map();

    const insertPackage = db.prepare(`
      INSERT OR REPLACE INTO NDCPackages 
      (NDCKey, ProductKey, Code, Code11, LastSeen, Active, Description)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for await (const line of rl) {
      lineCount++;

      if (lineCount === 1) {
        header = line.split('\t');
        continue;
      }

      const cols = line.split('\t');
      if (cols.length < 4) continue;

      const packageData = this.#parsePackageLine(header, cols, versionName);
      if (!packageData) continue;

      // Get product key
      const productKey = this.codesMap?.get(packageData.productCode);
      if (!productKey) {
        continue; // Skip packages without corresponding products
      }

      // Generate unique package key
      let packageKey = packageCodesMap.get(packageData.code);
      if (!packageKey) {
        packageKey = packageCodesMap.size + 1;
        packageCodesMap.set(packageData.code, packageKey);
      }

      batch.push({
        key: packageKey,
        productKey,
        ...packageData
      });

      if (batch.length >= batchSize) {
        await this._processBatch(db, insertPackage, batch, 'package');
        processedCount += batch.length;
        this.updateProgress(batch.length);
        batch = [];

        if (processedCount % 10000 === 0 && options.verbose) {
          terminal.log(`  Processed ${processedCount} packages...`);
        }
      }
    }

    // Process remaining batch
    if (batch.length > 0) {
      await this._processBatch(db, insertPackage, batch, 'package');
      processedCount += batch.length;
      this.updateProgress(batch.length);
    }

    insertPackage.finalize();

    if (options.verbose) {
      terminal.log(`  Completed packages: ${processedCount} records`);
    }
  }

  #parseProductLine(header, cols, versionName) {
    const getField = (fieldName) => {
      const index = header.findIndex(h => h.toUpperCase().includes(fieldName.toUpperCase()));
      return index >= 0 && index < cols.length ? cols[index].trim() : '';
    };

    const code = getField('PRODUCTNDC');
    if (!code || code.length > 11) return null;

    const excludeFlag = getField('NDC_EXCLUDE_FLAG');
    let active;
    if (excludeFlag) {
      // If field exists and has data, active when flag is 'Y' or 'N'
      // Other values like 'E', 'U', 'I' mark as inactive
      active = (excludeFlag === 'Y' || excludeFlag === 'N') ? 1 : 0;
    } else {
      // If field doesn't exist or is empty, default to active
      active = 1;
    }

    return {
      code,
      active,
      productTypeName: getField('PRODUCTTYPENAME') || '',
      proprietaryName: getField('PROPRIETARYNAME') || '',
      proprietaryNameSuffix: getField('PROPRIETARYNAMESUFFIX') || '',
      nonProprietaryName: getField('NONPROPRIETARYNAME') || '',
      dosageFormName: getField('DOSAGEFORMNAME') || '',
      routeName: getField('ROUTENAME') || '',
      startMarketingDate: this.#parseDate(getField('STARTMARKETINGDATE')),
      endMarketingDate: this.#parseDate(this.#fixEndDate(getField('ENDMARKETINGDATE'))),
      marketingCategoryName: getField('MARKETINGCATEGORYNAME') || '',
      labelerName: getField('LABELERNAME') || '',
      lastSeen: versionName
    };
  }

  #parsePackageLine(header, cols, versionName) {
    const getField = (fieldName) => {
      const index = header.findIndex(h => h.toUpperCase().includes(fieldName.toUpperCase()));
      return index >= 0 && index < cols.length ? cols[index].trim() : '';
    };

    const code = getField('NDCPACKAGECODE');
    const productCode = getField('PRODUCTNDC');

    if (!code || !productCode || code.length > 12) return null;

    const excludeFlag = getField('NDC_EXCLUDE_FLAG');
    let active;
    if (excludeFlag) {
      // If field exists and has data, active when flag is 'Y' or 'N'
      // Other values like 'E', 'U', 'I' mark as inactive
      active = (excludeFlag === 'Y' || excludeFlag === 'N') ? 1 : 0;
    } else {
      // If field doesn't exist or is empty, default to active
      active = 1;
    }

    return {
      code,
      productCode,
      code11: this.#genCode11(code),
      active,
      description: getField('PACKAGEDESCRIPTION') || '',
      lastSeen: versionName
    };
  }

  #getOrCreateLookupId(map, value) {
    if (!value) return 1; // Default/unknown entry

    if (map.has(value)) {
      return map.get(value);
    }

    const id = map.size + 1;
    map.set(value, id);
    return id;
  }

  #parseDate(dateStr) {
    if (!dateStr) return null;

    // Fix known date issues
    let fixed = this.#fixDate(dateStr);

    // Try different formats
    if (fixed.includes('/')) {
      const parts = fixed.split('/');
      if (parts.length === 3) {
        // MM/DD/YYYY
        return `${parts[2]}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}`;
      }
    }

    if (fixed.includes('-')) {
      return fixed; // Assume already in ISO format
    }

    return fixed;
  }

  #fixDate(date) {
    if (date.startsWith('2388')) {
      return '2018' + date.substring(4);
    } else if (date.startsWith('3030')) {
      return '2020' + date.substring(4);
    }
    return date;
  }

  #fixEndDate(date) {
    if (date.startsWith('3031')) {
      return '2031' + date.substring(4);
    }
    return this.#fixDate(date);
  }

  #genCode11(code) {
    if (!code) return '';

    const parts = code.split('-');
    if (parts.length === 3) {
      return parts[0].padStart(5, '0') +
        parts[1].padStart(4, '0') +
        parts[2].padStart(2, '0');
    }

    return code.replace(/-/g, '').padStart(11, '0');
  }

  async _processBatch(db, statement, batch, type = 'product') {
    return new Promise((resolve, reject) => {
      db.serialize(() => {
        db.run('BEGIN TRANSACTION');

        batch.forEach(item => {
          if (type === 'product') {
            statement.run(
              item.key,
              item.code,
              item.lastSeen,
              item.active,
              item.typeId,
              item.proprietaryName.substring(0, 255),
              item.proprietaryNameSuffix.substring(0, 180),
              item.doseFormId,
              item.routeId,
              item.startMarketingDate,
              item.endMarketingDate,
              item.marketingCategoryName.substring(0, 40),
              item.orgId,
              item.nonProprietaryName
            );
          } else {
            statement.run(
              item.key,
              item.productKey,
              item.code,
              item.code11,
              item.lastSeen,
              item.active,
              item.description.substring(0, 255)
            );
          }
        });

        db.run('COMMIT', (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    });
  }

  async #recordVersion(db, versionName) {
    return new Promise((resolve, reject) => {
      db.run('INSERT INTO NDCVersion (Version) VALUES (?)', [versionName], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async #createLookupTables(db, verbose = true) {
    if (verbose) terminal.log('Creating lookup tables...');

    const lookups = [
      { table: 'NDCProductTypes', map: this.typesMap },
      { table: 'NDCOrganizations', map: this.orgsMap },
      { table: 'NDCDoseForms', map: this.doseFormsMap },
      { table: 'NDCRoutes', map: this.routesMap }
    ];

    // One transaction for all of them: otherwise each row commits (and waits on a disk sync)
    // on its own, and there are thousands of organisations. A row that fails is warned about
    // and skipped, as before: in SQLite a failed INSERT doesn't end the transaction
    return new Promise((resolve, reject) => {
      db.serialize(() => {
        db.run('BEGIN TRANSACTION');
        lookups.forEach(lookup => {
          if (lookup.map) {
            for (const [name, id] of lookup.map) {
              db.run(
                `INSERT INTO ${lookup.table} (NDCKey, Name) VALUES (?, ?)`,
                [id, name.substring(0, 500)],
                (err) => {
                  if (err && verbose) {
                    terminal.warn(`Warning inserting into ${lookup.table}: ${err.message}`);
                  }
                }
              );
            }
          }
        });

        // resolves once the rows are in, not when they have only been queued
        db.run('COMMIT', (err) => {
          if (err) {
            reject(err);
          } else {
            if (verbose) terminal.log('Lookup tables created');
            resolve();
          }
        });
      });
    });
  }

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
class NdcDataMigratorWithProgress {
  constructor(moduleInstance, verbose = true) {
    this.module = moduleInstance;
    this.verbose = verbose;
    this.totalProgress = 0;
  }

  async migrate(sourceDir, destFile, version, options) {
    // Estimate total work by counting lines in all files
    const versions = await this.countVersions(sourceDir);
    this.totalProgress = await this.estimateWorkload(sourceDir, versions);

    this.module.logInfo(`Processing ${versions.length} NDC versions (${this.totalProgress.toLocaleString()} estimated records)...`);
    this.module.createProgressBar();
    this.module.updateProgress(0, this.totalProgress);

    // Create migrator with progress callback
    const migratorWithProgress = new NdcDataMigrator((currentProgress) => {
      this.module.updateProgress(currentProgress);
    });

    try {
      await migratorWithProgress.migrate(sourceDir, destFile, version, options);
    } finally {
      this.module.stopProgress();
    }
  }

  async countVersions(sourceDir) {
    const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
  }

  async estimateWorkload(sourceDir, versions) {
    let totalLines = 0;

    for (const version of versions) {
      const versionDir = path.join(sourceDir, version);
      const productFile = path.join(versionDir, 'product.txt');
      const packageFile = path.join(versionDir, 'package.txt');

      if (fs.existsSync(productFile)) {
        totalLines += await this.countLines(productFile);
      }

      if (fs.existsSync(packageFile)) {
        totalLines += await this.countLines(packageFile);
      }
    }

    return Math.max(totalLines - versions.length * 2, 1); // Subtract headers
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
  NdcModule,
  NdcDataMigrator
};