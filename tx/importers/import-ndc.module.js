const { BaseTerminologyModule } = require('./tx-import-base');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const readline = require('readline');
const zlib = require('zlib');
const terminal = require('./terminal');

/*
 * NDC source data
 * ---------------
 *
 * Whether an NDC is on the market today has nothing to do with whether it is a valid code: it was
 * valid when the record that carries it was made. So the import builds the most complete list it
 * can, from every FDA download it is given:
 *
 *   product.txt / package.txt                        current listings (ndctext.zip, ndc.zip; ndcxls.zip holds the same, as .xls)
 *   Products_excluded.txt / Packages_excluded.txt    listings that have left the directory (ndc_excluded.zip)
 *   products_all.txt / packages_all.txt              current + excluded, decided by NDC_EXCLUDE_FLAG
 *   unfinished_product.txt / unfinished_package.txt  unfinished drugs (ndc_unfinished.zip)
 *   unfinished_products_excluded.txt / ...packages... unfinished drugs that have left (ndc_unfinished_excluded.zip)
 *   compounders_ndc_directory.txt                    503B outsourcing facility products (product and package on one row)
 *
 * The .xls files FDA publishes are tab-delimited text, the same as the .txt files.
 *
 * The source directory is searched (recursively) for these files, loose or inside .zip files, and
 * each copy is a snapshot, dated:
 *  - a zip named like the Wayback Machine downloads (20160609215020-ndctext.zip) by its name
 *  - a loose file by the name of its folder, if that is a date (2025-07-11/product.txt)
 *  - otherwise by the file's modification time
 * Folders whose names start with '.' or '_' are skipped. Anything else (the pre-2009 directory
 * files, the openFDA json, the NHRIC labeler list) isn't recognised, and is ignored.
 *
 * Snapshots are processed newest first, and the first time a code is seen is the one that counts:
 * an older sighting of a code that's already been loaded is ignored. Within a day, listings come
 * before excluded files. So each code carries the most recent information FDA published for it,
 * and LastSeen is the date of the newest snapshot that has it.
 *
 * A code is active if it is listed (not excluded, NDC_EXCLUDE_FLAG blank, N or Y) in the newest
 * snapshot of its kind (finished, unfinished, compounded). Everything else is inactive.
 *
 * Codes that aren't a real NDC (placeholders like 62175-XXX-37, GS1 numbers, letters in the
 * package segment) are counted and left out.
 */

const NDC_FILE_KINDS = [
  { re: /^unfinished_products?_excluded\.(txt|xls)$/i, family: 'unfinished', part: 'product', excluded: true },
  { re: /^unfinished_packages?_excluded\.(txt|xls)$/i, family: 'unfinished', part: 'package', excluded: true },
  { re: /^unfinished_products?\.(txt|xls)$/i, family: 'unfinished', part: 'product', excluded: false },
  { re: /^unfinished_packages?\.(txt|xls)$/i, family: 'unfinished', part: 'package', excluded: false },
  { re: /^products_excluded\.(txt|xls)$/i, family: 'finished', part: 'product', excluded: true },
  { re: /^packages_excluded\.(txt|xls)$/i, family: 'finished', part: 'package', excluded: true },
  { re: /^products_all\.(txt|xls)$/i, family: 'finished', part: 'product', excluded: false },
  { re: /^packages_all\.(txt|xls)$/i, family: 'finished', part: 'package', excluded: false },
  { re: /^product\.(txt|xls)$/i, family: 'finished', part: 'product', excluded: false },
  { re: /^package\.(txt|xls)$/i, family: 'finished', part: 'package', excluded: false },
  { re: /^compounders_ndc_directory\.(txt|xls)$/i, family: 'compounded', part: 'combined', excluded: false }
];

const NDC_FAMILY_ORDER = { finished: 0, unfinished: 1, compounded: 2 };

// the openFDA bulk download
const NDC_JSON_FILE = /^drug-ndc-\d+-of-\d+\.json$/i;

// the three NDC configurations: 4-4-2, 5-3-2, 5-4-1
const NDC_PRODUCT_CODE = /^(\d{4}-\d{4}|\d{5}-\d{3}|\d{5}-\d{4})$/;
const NDC_PACKAGE_CODE = /^(\d{4}-\d{4}-\d{2}|\d{5}-\d{3}-\d{2}|\d{5}-\d{4}-\d)$/;

function classifyNdcFile(name) {
  const base = path.basename(name);
  const kind = NDC_FILE_KINDS.find(k => k.re.test(base));
  if (!kind) {
    return null;
  }
  return { family: kind.family, part: kind.part, excluded: kind.excluded, isText: /\.txt$/i.test(base) };
}

// a name that starts with a date - 20160609215020-ndctext.zip, 2025-07-11, 20251202 - gives
// {date: 'YYYY-MM-DD', stamp: 'YYYYMMDDhhmmss'}
function ndcDateFromName(name) {
  const m = /^((?:19|20)\d{2})-?(\d{2})-?(\d{2})(?:[-_ T]?(\d{2})(\d{2})(\d{2}))?/.exec(path.basename(name));
  if (!m) {
    return null;
  }
  const month = parseInt(m[2]);
  const day = parseInt(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  return {
    date: `${m[1]}-${m[2]}-${m[3]}`,
    stamp: `${m[1]}${m[2]}${m[3]}${m[4] || '00'}${m[5] || '00'}${m[6] || '00'}`
  };
}

function ndcDateFromTime(ms) {
  const iso = new Date(ms).toISOString(); // 2026-11-17T06:06:28.000Z
  return {
    date: iso.substring(0, 10),
    stamp: iso.substring(0, 19).replace(/[-T:]/g, '')
  };
}

/**
 * Just enough of a zip reader for the FDA downloads: the central directory, and stored or
 * deflated entries (no zip64 - the downloads are all well under 4GB)
 */
class NdcZipArchive {
  constructor(file) {
    this.file = file;
    this.entries = this.#readDirectory();
  }

  #readDirectory() {
    const fd = fs.openSync(this.file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const tailLength = Math.min(size, 65557);
      const tail = Buffer.alloc(tailLength);
      fs.readSync(fd, tail, 0, tailLength, size - tailLength);
      let eocd = -1;
      for (let i = tailLength - 22; i >= 0; i--) {
        if (tail.readUInt32LE(i) === 0x06054b50) {
          eocd = i;
          break;
        }
      }
      if (eocd < 0) {
        throw new Error(`Not a zip file: ${this.file}`);
      }
      const count = tail.readUInt16LE(eocd + 10);
      const directorySize = tail.readUInt32LE(eocd + 12);
      const directoryOffset = tail.readUInt32LE(eocd + 16);
      const directory = Buffer.alloc(directorySize);
      fs.readSync(fd, directory, 0, directorySize, directoryOffset);

      const entries = [];
      let p = 0;
      for (let i = 0; i < count; i++) {
        if (directory.readUInt32LE(p) !== 0x02014b50) {
          throw new Error(`Corrupt zip directory in ${this.file}`);
        }
        const nameLength = directory.readUInt16LE(p + 28);
        const extraLength = directory.readUInt16LE(p + 30);
        const commentLength = directory.readUInt16LE(p + 32);
        entries.push({
          name: directory.toString('utf8', p + 46, p + 46 + nameLength),
          method: directory.readUInt16LE(p + 10),
          compressedSize: directory.readUInt32LE(p + 20),
          size: directory.readUInt32LE(p + 24),
          offset: directory.readUInt32LE(p + 42)
        });
        p += 46 + nameLength + extraLength + commentLength;
      }
      return entries;
    } finally {
      fs.closeSync(fd);
    }
  }

  read(entry) {
    const fd = fs.openSync(this.file, 'r');
    try {
      const header = Buffer.alloc(30);
      fs.readSync(fd, header, 0, 30, entry.offset);
      if (header.readUInt32LE(0) !== 0x04034b50) {
        throw new Error(`Corrupt zip entry ${entry.name} in ${this.file}`);
      }
      const start = entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
      const data = Buffer.alloc(entry.compressedSize);
      fs.readSync(fd, data, 0, entry.compressedSize, start);
      if (entry.method === 0) {
        return data;
      } else if (entry.method === 8) {
        return zlib.inflateRawSync(data);
      } else {
        throw new Error(`Unsupported compression method ${entry.method} for ${entry.name} in ${this.file}`);
      }
    } finally {
      fs.closeSync(fd);
    }
  }
}

// one tab-delimited file, loose or in a zip
class NdcFileReader {
  constructor(description, size, openLines, text) {
    this.description = description;
    this.size = size;
    this.openLines = openLines;
    this.text = text; // the whole file, as a string
  }

  static forFile(file) {
    return new NdcFileReader(file, fs.statSync(file).size, async function* () {
      const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
      for await (const line of rl) {
        yield line;
      }
    }, () => fs.readFileSync(file, 'utf8'));
  }

  static forZipEntry(zip, entry) {
    return new NdcFileReader(`${zip.file}!${entry.name}`, entry.size, async function* () {
      const text = zip.read(entry).toString('utf8');
      let start = 0;
      while (start < text.length) {
        let end = text.indexOf('\n', start);
        if (end < 0) {
          end = text.length;
        }
        yield text.substring(start, end > start && text[end - 1] === '\r' ? end - 1 : end);
        start = end + 1;
      }
    }, () => zip.read(entry).toString('utf8'));
  }

  // rows as objects keyed by upper case column name
  async* rows() {
    let header = null;
    for await (const line of this.openLines()) {
      if (!header) {
        header = line.split('\t').map(h => h.trim().toUpperCase());
        continue;
      }
      if (!line.trim()) {
        continue;
      }
      const cols = line.split('\t');
      const row = {};
      header.forEach((h, i) => {
        row[h] = i < cols.length ? cols[i].trim() : '';
      });
      yield row;
    }
  }

  async header() {
    for await (const line of this.openLines()) {
      return line.split('\t').map(h => h.trim().toUpperCase());
    }
    return [];
  }
}

/**
 * Find every NDC snapshot under sourceDir. Returns groups - one per (snapshot, family, excluded) -
 * newest first:
 *   { date, stamp, origin, family, excluded, product, package, combined }
 * where product/package/combined are NdcFileReaders (or null)
 */
function findNdcSources(sourceDir) {
  return scanNdcDirectory(sourceDir).groups;
}

/**
 * The openFDA NDC json downloads (drug-ndc-0001-of-0001.json, loose or in a zip) under sourceDir,
 * newest first: { date, origin, reader }. A loose file is dated by its meta.last_updated
 */
function findNdcJsonSources(sourceDir) {
  return scanNdcDirectory(sourceDir).json;
}

function scanNdcDirectory(sourceDir) {
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Source directory not found: ${sourceDir}`);
  }
  const groups = new Map();
  const json = [];
  const isJson = (name) => NDC_JSON_FILE.test(path.basename(name));

  const addFile = (origin, dating, kind, reader) => {
    const key = `${origin}|${kind.family}|${kind.excluded}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        date: dating.date, stamp: dating.stamp, origin, family: kind.family, excluded: kind.excluded,
        product: null, package: null, combined: null, textParts: new Set()
      };
      groups.set(key, group);
    } else if (dating.stamp > group.stamp) {
      // loose files dated by modification time: the group is as new as its newest file
      group.date = dating.date;
      group.stamp = dating.stamp;
    }
    // a zip may have both foo.txt and foo.xls; they are the same, and .txt is preferred
    if (!group[kind.part] || (kind.isText && !group.textParts.has(kind.part))) {
      group[kind.part] = reader;
      if (kind.isText) {
        group.textParts.add(kind.part);
      }
    }
  };

  const walk = (dir) => {
    const folderDate = ndcDateFromName(dir);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || entry.name.startsWith('_')) {
        continue;
      }
      const full = path.join(dir, entry.name);
      const stat = fs.statSync(full); // follows links
      if (stat.isDirectory()) {
        walk(full);
      } else if (/\.zip$/i.test(entry.name)) {
        const dating = ndcDateFromName(entry.name) || folderDate || ndcDateFromTime(stat.mtimeMs);
        const zip = new NdcZipArchive(full);
        for (const zipEntry of zip.entries) {
          const kind = classifyNdcFile(zipEntry.name);
          if (kind) {
            addFile(full, dating, kind, NdcFileReader.forZipEntry(zip, zipEntry));
          } else if (isJson(zipEntry.name)) {
            json.push({ date: dating.date, origin: `${full}!${zipEntry.name}`, reader: NdcFileReader.forZipEntry(zip, zipEntry) });
          }
        }
      } else if (isJson(entry.name)) {
        const dating = ndcJsonLastUpdated(full) || folderDate || ndcDateFromTime(stat.mtimeMs);
        json.push({ date: dating.date, origin: full, reader: NdcFileReader.forFile(full) });
      } else {
        const kind = classifyNdcFile(entry.name);
        if (kind) {
          const dating = folderDate || ndcDateFromTime(stat.mtimeMs);
          addFile(dir, dating, kind, NdcFileReader.forFile(full));
        }
      }
    }
  };
  walk(sourceDir);

  const list = [...groups.values()].filter(g => g.product || g.combined);
  for (const g of list) {
    delete g.textParts;
  }
  // newest first; on the same day, listings before excluded files
  list.sort((a, b) => {
    if (a.date !== b.date) {
      return a.date < b.date ? 1 : -1;
    }
    if (a.excluded !== b.excluded) {
      return a.excluded ? 1 : -1;
    }
    if (a.stamp !== b.stamp) {
      return a.stamp < b.stamp ? 1 : -1;
    }
    if (a.family !== b.family) {
      return NDC_FAMILY_ORDER[a.family] - NDC_FAMILY_ORDER[b.family];
    }
    return a.origin.localeCompare(b.origin);
  });
  json.sort((a, b) => a.date === b.date ? a.origin.localeCompare(b.origin) : (a.date < b.date ? 1 : -1));
  return { groups: list, json };
}

// the date in an openFDA download's meta (near the start of the file)
function ndcJsonLastUpdated(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(4096);
    const length = fs.readSync(fd, head, 0, head.length, 0);
    const m = /"last_updated"\s*:\s*"(\d{4})-(\d{2})-(\d{2})"/.exec(head.toString('utf8', 0, length));
    return m ? { date: `${m[1]}-${m[2]}-${m[3]}`, stamp: `${m[1]}${m[2]}${m[3]}000000` } : null;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The objects in the "results" array of an openFDA download, one at a time - the files are a
 * quarter of a gigabyte, and parsed whole they take far more memory than that
 */
function* ndcJsonResults(text) {
  const key = text.indexOf('"results"');
  if (key < 0) {
    return;
  }
  let i = text.indexOf('[', key) + 1;
  while (i > 0 && i < text.length) {
    // to the next object, or the end of the array
    while (i < text.length && text[i] !== '{' && text[i] !== ']') {
      i++;
    }
    if (i >= text.length || text[i] === ']') {
      return;
    }
    const start = i;
    let depth = 0;
    let inString = false;
    for (; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (c === '\\') {
          i++;
        } else if (c === '"') {
          inString = false;
        }
      } else if (c === '"') {
        inString = true;
      } else if (c === '{') {
        depth++;
      } else if (c === '}') {
        depth--;
        if (depth === 0) {
          break;
        }
      }
    }
    i++;
    yield JSON.parse(text.substring(start, i));
  }
}

function describeNdcGroup(group) {
  const parts = ['product', 'package', 'combined'].filter(p => group[p]).join('+');
  return `${group.date} ${group.family}${group.excluded ? ' (excluded)' : ''} [${parts}] ${group.origin}`;
}

class NdcModule extends BaseTerminologyModule {
  getName() {
    return 'ndc';
  }

  getDescription() {
    return 'National Drug Code (NDC) Directory from FDA';
  }

  getSupportedFormats() {
    return ['txt', 'tsv', 'zip', 'directory'];
  }

  getEstimatedDuration() {
    return '30-90 minutes (depending on number of snapshots)';
  }

  registerCommands(terminologyCommand, globalOptions) {
    // Import command
    terminologyCommand
      .command('import')
      .description('Import NDC data from all the FDA snapshots in a directory (loose files and/or zips)')
      .option('-s, --source <directory>', 'Source directory containing NDC downloads (searched recursively)')
      .option('-d, --dest <file>', 'Destination SQLite database')
      .option('-v, --version <version>', 'Data version identifier')
      .option('-y, --yes', 'Skip confirmations')
      .option('--no-indexes', 'Skip index creation for faster import')
      .option('--products-only', 'Import only products (skip packages)')
      .action(async (options) => {
        await this.handleImportCommand({...globalOptions, ...options});
      });

    // Validate command
    terminologyCommand
      .command('validate')
      .description('Validate NDC source directory structure')
      .option('-s, --source <directory>', 'Source directory to validate')
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
      .description('List the NDC snapshots found in a source directory, in the order they will be imported')
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

  async askForSource(options, message) {
    if (!options.source) {
      const answers = await require('inquirer').prompt({
        type: 'input',
        name: 'source',
        message,
        validate: (input) => input && fs.existsSync(input) ? true : 'Directory does not exist'
      });
      options.source = answers.source;
    }
  }

  async handleValidateCommand(options) {
    await this.askForSource(options, 'Source directory to validate:');
    this.logInfo(`Validating NDC directory: ${options.source}`);

    try {
      const stats = await this.validateNdcDirectory(options.source);

      this.logSuccess('Directory validation passed');
      terminal.log(`  Snapshots found: ${stats.groups.length}`);
      terminal.log(`  Newest: ${stats.newest}`);
      terminal.log(`  Oldest: ${stats.oldest}`);

      if (stats.warnings.length > 0) {
        this.logWarning('Validation warnings:');
        stats.warnings.forEach(warning => terminal.log(`    ${warning}`));
      }

    } catch (error) {
      this.logError(`Validation failed: ${error.message}`);
    }
  }

  async handleVersionsCommand(options) {
    await this.askForSource(options, 'Source directory to scan:');

    try {
      const groups = findNdcSources(options.source);

      this.logSuccess(`Found ${groups.length} NDC snapshots (in import order, newest first):`);
      groups.forEach((group, index) => {
        terminal.log(`  ${index + 1}. ${describeNdcGroup(group)}`);
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
      const stats = await this.validateNdcDirectory(config.source);
      this.logSuccess(`NDC directory structure valid (${stats.groups.length} snapshots, ${stats.oldest} to ${stats.newest})`);
      stats.warnings.forEach(warning => this.logWarning(warning));
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

    const stats = await enhancedMigrator.migrate(
      config.source,
      config.dest,
      config.version,
      {
        verbose: config.verbose,
        productsOnly: config.productsOnly
      }
    );

    this.logSuccess(`Imported ${stats.products.toLocaleString()} products (${stats.activeProducts.toLocaleString()} active) and ` +
      `${stats.packages.toLocaleString()} packages (${stats.activePackages.toLocaleString()} active) from ${stats.groups} snapshots`);
    if (stats.invalidProducts || stats.invalidPackages) {
      this.logWarning(`Ignored ${stats.invalidProducts} product codes and ${stats.invalidPackages} package codes that are not valid NDCs`);
    }
    if (stats.jsonProducts || stats.jsonUnknownProducts) {
      this.logInfo(`openFDA properties for ${stats.jsonProducts.toLocaleString()} products` +
        (stats.jsonUnknownProducts ? ` (${stats.jsonUnknownProducts} json entries for products not in any snapshot were ignored)` : ''));
    }
    if (stats.productsFromPackages) {
      this.logInfo(`${stats.productsFromPackages} products are only known from their packages (FDA never published the product)`);
    }

    if (config.createIndexes) {
      this.logInfo('Creating database indexes...');
      await this.createIndexes(config.dest);
      this.logSuccess('Indexes created');
    }
  }

  async validateNdcDirectory(sourceDir) {
    const groups = findNdcSources(sourceDir);

    if (groups.length === 0) {
      throw new Error('No NDC files (product.txt, Products_excluded.txt, ndctext.zip etc) found');
    }

    const warnings = [];
    const required = {
      product: ['PRODUCTNDC'],
      package: ['PRODUCTNDC', 'NDCPACKAGECODE'],
      combined: ['NDCPACKAGECODE']
    };
    for (const group of groups) {
      if (!group.combined && !group.package) {
        warnings.push(`No package file for ${describeNdcGroup(group)}`);
      }
      // reading a header out of a zip means inflating the whole entry, so only the loose files are checked here
      for (const part of ['product', 'package', 'combined']) {
        const reader = group[part];
        if (reader && !reader.description.includes('!')) {
          const header = await reader.header();
          const missing = required[part].filter(f => !header.includes(f));
          if (missing.length > 0) {
            throw new Error(`${reader.description} is missing ${missing.join(', ')}`);
          }
        }
      }
    }

    return {
      groups,
      newest: groups[0].date,
      oldest: groups[groups.length - 1].date,
      warnings
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
      'CREATE INDEX IF NOT EXISTS idx_ndcpackages_active ON NDCPackages(Active)',
      'CREATE INDEX IF NOT EXISTS idx_ndcproperties_key ON NDCProperties(IsPackage, NDCKey)'
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
    this.batchSize = 5000;
  }

  /**
   * Build destFile from every snapshot found under sourceDir (see the notes at the top of this file).
   * Returns counts of what was loaded and what was left out. The version recorded is the date of the
   * newest snapshot, not the version parameter
   */
  // eslint-disable-next-line no-unused-vars
  async migrate(sourceDir, destFile = 'unknown', version = null, options = {}) {
    if (options.verbose) terminal.log('Starting NDC data migration...');

    const groups = findNdcSources(sourceDir);
    if (groups.length === 0) {
      throw new Error(`No NDC source files found in ${sourceDir}`);
    }

    // a code is active if it's listed in the newest snapshot of its family
    this.latestListing = {};
    for (const group of groups) {
      if (!group.excluded && (!this.latestListing[group.family] || group.date > this.latestListing[group.family])) {
        this.latestListing[group.family] = group.date;
      }
    }

    // Ensure destination directory exists
    const destDir = path.dirname(destFile);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }

    // Remove existing database file if it exists
    if (fs.existsSync(destFile)) {
      fs.unlinkSync(destFile);
    }

    const db = new sqlite3.Database(destFile);

    // lookups are shared by all the snapshots. Key 1 is 'no value'
    this.typesMap = new Map([['', 1]]);
    this.orgsMap = new Map([['', 1]]);
    this.doseFormsMap = new Map([['', 1]]);
    this.routesMap = new Map([['', 1]]);

    this.productKeys = new Map(); // product code -> NDCKey
    this.packageKeys = new Map(); // package code -> NDCKey
    // distinct codes left out (the same ones turn up in snapshot after snapshot)
    this.invalidCodes = new Set();
    this.invalidPackageCodes = new Set();
    this.stats = {
      groups: groups.length, products: 0, packages: 0, activeProducts: 0, activePackages: 0,
      invalidProducts: 0, invalidPackages: 0, productsFromPackages: 0,
      jsonProducts: 0, jsonUnknownProducts: 0, properties: 0
    };
    this.productRows = [];
    this.packageRows = [];
    this.productUpdates = [];
    this.stubProducts = new Map(); // product code -> row, for products only known from a package
    this.propertyRows = [];
    this.jsonDone = new Set(); // products that have their openfda properties

    try {
      await this.#createTables(db, options.verbose);
      await this.#prepare(db);

      for (const group of groups) {
        const before = { products: this.stats.products, packages: this.stats.packages };
        await this.#processGroup(group, options);
        await this.#flush(db);
        if (options.verbose) {
          terminal.log(`${describeNdcGroup(group)}: ${this.stats.products - before.products} new products, ${this.stats.packages - before.packages} new packages`);
        }
      }

      // then what the openFDA downloads add to the products
      for (const source of findNdcJsonSources(sourceDir)) {
        const before = this.stats.jsonProducts;
        this.#processJson(source);
        await this.#flush(db);
        if (options.verbose) {
          terminal.log(`${source.date} openFDA json ${source.origin}: properties for ${this.stats.jsonProducts - before} products`);
        }
      }

      await this.#finalize();

      // The newest snapshot is the version
      await this.#recordVersion(db, groups[0].date);

      await this.#createLookupTables(db, options.verbose);

      if (options.verbose) terminal.log('NDC data migration completed successfully');
    } finally {
      await this.#closeDatabase(db, options.verbose);
    }
    return this.stats;
  }

  updateProgress(amount = 1) {
    this.currentProgress += amount;
    if (this.progressCallback) {
      this.progressCallback(this.currentProgress);
    }
  }

  async #processGroup(group, options) {
    if (group.combined) {
      for await (const row of this.#rows(group.combined)) {
        // the 2022 layout has no PRODUCTNDC; the product code is the front of the package code
        const packageCode = row.NDCPACKAGECODE || '';
        const productCode = row.PRODUCTNDC || packageCode.split('-').slice(0, 2).join('-');
        this.#addProduct(group, productCode, row);
        if (!options.productsOnly) {
          this.#addPackage(group, packageCode, productCode, row);
        }
      }
      return;
    }
    for await (const row of this.#rows(group.product)) {
      this.#addProduct(group, row.PRODUCTNDC, row);
    }
    if (group.package && !options.productsOnly) {
      for await (const row of this.#rows(group.package)) {
        this.#addPackage(group, row.NDCPACKAGECODE, row.PRODUCTNDC, row);
      }
    }
  }

  async* #rows(reader) {
    let chunk = 0;
    for await (const row of reader.rows()) {
      yield row;
      if (++chunk === 1000) {
        this.updateProgress(chunk);
        chunk = 0;
      }
    }
    this.updateProgress(chunk);
  }

  #isActive(group, row) {
    const flag = (row.NDC_EXCLUDE_FLAG || '').toUpperCase();
    return !group.excluded && (flag === '' || flag === 'N' || flag === 'Y') && group.date === this.latestListing[group.family];
  }

  #addProduct(group, code, row, stub = false) {
    code = (code || '').trim();
    const existing = this.productKeys.get(code);
    if (existing) {
      // already have newer information about this product - unless all it had was a code
      if (!stub && this.stubProducts.has(code)) {
        const stubRow = this.stubProducts.get(code);
        this.stubProducts.delete(code);
        // the details come from this product row; when it was last seen, and its status, stay as they were
        this.productUpdates.push(this.#productRow(stubRow[0], code, group, row, stubRow[2], stubRow[3]));
        this.#addProductProperties(existing, row);
        this.stats.productsFromPackages--;
      }
      return;
    }
    if (!NDC_PRODUCT_CODE.test(code)) {
      this.invalidCodes.add(code);
      this.stats.invalidProducts = this.invalidCodes.size;
      return;
    }
    const key = this.productKeys.size + 1;
    this.productKeys.set(code, key);
    const active = this.#isActive(group, row) ? 1 : 0;
    this.stats.products++;
    this.stats.activeProducts += active;
    const productRow = this.#productRow(key, code, group, row, group.date, active);
    this.productRows.push(productRow);
    if (!stub) {
      this.#addProductProperties(key, row);
    }
    if (stub) {
      this.stubProducts.set(code, productRow);
      this.stats.productsFromPackages++;
    }
  }

  #productRow(key, code, group, row, lastSeen, active) {
    const generics = row.NONPROPRIETARYNAME || row.ACTIVE_INGREDIENTS || row.SUBSTANCENAME || '';
    const typeName = row.PRODUCTTYPENAME || (group.family === 'compounded' ? 'HUMAN COMPOUNDED DRUG' : '');
    return [
      key,
      code,
      lastSeen,
      active,
      this.#lookupId(this.typesMap, typeName),
      // unfinished drugs have no proprietary name
      (row.PROPRIETARYNAME || generics).substring(0, 255),
      (row.PROPRIETARYNAMESUFFIX || '').substring(0, 180),
      this.#lookupId(this.doseFormsMap, row.DOSAGEFORMNAME),
      this.#lookupId(this.routesMap, row.ROUTENAME),
      this.#parseDate(row.STARTMARKETINGDATE),
      this.#parseDate(this.#fixEndDate(row.ENDMARKETINGDATE || '')),
      row.MARKETINGCATEGORYNAME || '',
      this.#lookupId(this.orgsMap, row.LABELERNAME),
      generics
    ];
  }

  #addPackage(group, code, productCode, row) {
    code = (code || '').trim();
    if (this.packageKeys.has(code)) {
      return; // already have newer information about this package
    }
    if (!NDC_PACKAGE_CODE.test(code)) {
      this.invalidPackageCodes.add(code);
      this.stats.invalidPackages = this.invalidPackageCodes.size;
      return;
    }
    // the product is the front of the package code (FDA's PRODUCTNDC column agrees, when it is valid)
    const ownProduct = code.substring(0, code.lastIndexOf('-'));
    let productKey = this.productKeys.get(ownProduct) || this.productKeys.get((productCode || '').trim());
    if (!productKey) {
      // FDA published the package but never the product (it happens, mostly in the excluded files).
      // The package is still a real code, so it gets a product with nothing but its code
      this.#addProduct(group, ownProduct, { NDC_EXCLUDE_FLAG: row.NDC_EXCLUDE_FLAG }, true);
      productKey = this.productKeys.get(ownProduct);
      if (!productKey) {
        return;
      }
    }
    const key = this.packageKeys.size + 1;
    this.packageKeys.set(code, key);
    const active = this.#isActive(group, row) ? 1 : 0;
    this.stats.packages++;
    this.stats.activePackages += active;
    this.packageRows.push([
      key,
      productKey,
      code,
      this.#genCode11(code),
      group.date,
      active,
      (row.PACKAGEDESCRIPTION || '').substring(0, 255)
    ]);
    this.#addProperty(key, 1, 'marketing_start_date', this.#parseDate(row.STARTMARKETINGDATE));
    this.#addProperty(key, 1, 'marketing_end_date', this.#parseDate(this.#fixEndDate(row.ENDMARKETINGDATE || '')));
    this.#addProperty(key, 1, 'sample', row.SAMPLE_PACKAGE);
    this.#addProperty(key, 1, 'ndc_exclude_flag', row.NDC_EXCLUDE_FLAG);
  }

  /*
   * Properties, named as openFDA names them. These come from the FDA text files, so every product
   * has them (as at the newest snapshot it is in)
   */
  #addProductProperties(key, row) {
    // PRODUCTID is PRODUCTNDC_SPLID
    const productId = row.PRODUCTID || '';
    if (productId.includes('_')) {
      this.#addProperty(key, 0, 'spl_id', productId.substring(productId.indexOf('_') + 1));
    }
    this.#addProperty(key, 0, 'application_number', row.APPLICATIONNUMBER);
    // SUBSTANCENAME, ACTIVE_NUMERATOR_STRENGTH and ACTIVE_INGRED_UNIT are ; separated lists, in step
    const names = (row.SUBSTANCENAME || '').split(';').map(v => v.trim());
    const strengths = (row.ACTIVE_NUMERATOR_STRENGTH || '').split(';').map(v => v.trim());
    const units = (row.ACTIVE_INGRED_UNIT || '').split(';').map(v => v.trim());
    names.forEach((name, i) => {
      if (name) {
        this.#addProperty(key, 0, 'active_ingredient', [name, strengths[i], units[i]].filter(v => v).join(' '));
      }
    });
    // classes look like "GLP-1 Receptor Agonist [EPC], Glucagon-like Peptide-1 (GLP-1) Agonists [MoA]"
    for (const pharmClass of (row.PHARM_CLASSES || '').split(/(?<=\]),\s*/)) {
      this.#addProperty(key, 0, 'pharm_class', pharmClass);
    }
    this.#addProperty(key, 0, 'dea_schedule', row.DEASCHEDULE);
    this.#addProperty(key, 0, 'listing_expiration_date', row.LISTING_RECORD_CERTIFIED_THROUGH);
    this.#addProperty(key, 0, 'ndc_exclude_flag', row.NDC_EXCLUDE_FLAG);
  }

  #addProperty(key, isPackage, name, value) {
    value = value == null ? '' : String(value).trim();
    if (value) {
      this.propertyRows.push([key, isPackage, name, value]);
      this.stats.properties++;
    }
  }

  /*
   * What only the openFDA download has: the openfda section, its links to other code systems. A
   * product takes these from the newest download it's in. The rest of the json is the same as the
   * text files (finished = product.txt, unfinished = unfinished_product.txt), which are already read
   */
  #processJson(source) {
    const fields = ['rxcui', 'spl_set_id', 'unii', 'nui', 'upc', 'manufacturer_name', 'is_original_packager',
      'pharm_class_epc', 'pharm_class_moa', 'pharm_class_cs', 'pharm_class_pe'];
    for (const result of ndcJsonResults(source.reader.text())) {
      const code = (result.product_ndc || '').trim();
      const key = this.productKeys.get(code);
      if (!key) {
        this.stats.jsonUnknownProducts++;
        continue;
      }
      if (this.jsonDone.has(code)) {
        continue; // a newer download already gave this product its properties
      }
      this.jsonDone.add(code);
      this.stats.jsonProducts++;
      const openfda = result.openfda || {};
      for (const field of fields) {
        const values = Array.isArray(openfda[field]) ? openfda[field] : (openfda[field] == null ? [] : [openfda[field]]);
        for (const value of new Set(values.map(v => String(v)))) {
          this.#addProperty(key, 0, field, value);
        }
      }
    }
  }

  #lookupId(map, value) {
    value = (value || '').trim();
    let id = map.get(value);
    if (!id) {
      id = map.size + 1;
      map.set(value, id);
    }
    return id;
  }

  #run(db, sql, params = []) {
    return new Promise((resolve, reject) => {
      db.run(sql, params, (err) => err ? reject(err) : resolve());
    });
  }

  async #prepare(db) {
    this.insertProduct = db.prepare(`
      INSERT INTO NDCProducts
      (NDCKey, Code, LastSeen, Active, Type, TradeName, Suffix, DoseForm, Route, StartDate, EndDate, Category, Company, Generics)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.updateProduct = db.prepare(`
      INSERT OR REPLACE INTO NDCProducts
      (NDCKey, Code, LastSeen, Active, Type, TradeName, Suffix, DoseForm, Route, StartDate, EndDate, Category, Company, Generics)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.insertProperty = db.prepare('INSERT INTO NDCProperties (NDCKey, IsPackage, Name, Value) VALUES (?, ?, ?, ?)');
    this.insertPackage = db.prepare(`
      INSERT INTO NDCPackages
      (NDCKey, ProductKey, Code, Code11, LastSeen, Active, Description)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
  }

  async #flush(db) {
    const products = this.productRows;
    const packages = this.packageRows;
    const updates = this.productUpdates;
    const properties = this.propertyRows;
    this.propertyRows = [];
    this.productRows = [];
    this.packageRows = [];
    this.productUpdates = [];
    for (let i = 0; i < Math.max(products.length, packages.length); i += this.batchSize) {
      await this.#run(db, 'BEGIN TRANSACTION');
      const pending = [];
      for (const row of products.slice(i, i + this.batchSize)) {
        pending.push(new Promise((resolve, reject) => this.insertProduct.run(row, (err) => err ? reject(err) : resolve())));
      }
      for (const row of packages.slice(i, i + this.batchSize)) {
        pending.push(new Promise((resolve, reject) => this.insertPackage.run(row, (err) => err ? reject(err) : resolve())));
      }
      await Promise.all(pending);
      await this.#run(db, 'COMMIT');
    }
    // stub products filled in from an older product row (after the inserts, which may include the stub)
    if (updates.length > 0) {
      await this.#run(db, 'BEGIN TRANSACTION');
      await Promise.all(updates.map(row => new Promise((resolve, reject) => this.updateProduct.run(row, (err) => err ? reject(err) : resolve()))));
      await this.#run(db, 'COMMIT');
    }
    for (let i = 0; i < properties.length; i += this.batchSize) {
      await this.#run(db, 'BEGIN TRANSACTION');
      await Promise.all(properties.slice(i, i + this.batchSize).map(row =>
        new Promise((resolve, reject) => this.insertProperty.run(row, (err) => err ? reject(err) : resolve()))));
      await this.#run(db, 'COMMIT');
    }
  }

  async #finalize() {
    await new Promise((resolve) => this.insertProduct.finalize(resolve));
    await new Promise((resolve) => this.insertPackage.finalize(resolve));
    await new Promise((resolve) => this.updateProduct.finalize(resolve));
    await new Promise((resolve) => this.insertProperty.finalize(resolve));
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

      // properties of products (IsPackage = 0) and packages (IsPackage = 1), named as openFDA names them
      `CREATE TABLE NDCProperties (
        NDCKey INTEGER NOT NULL,
        IsPackage INTEGER NOT NULL,
        Name TEXT(40) NOT NULL,
        Value TEXT NOT NULL
      )`,

      `CREATE TABLE NDCVersion (
        Version TEXT(50) NOT NULL
      )`
    ];

    for (const sql of tableSQL) {
      await this.#run(db, sql);
    }
    if (verbose) terminal.log('Database tables created');
  }

  #parseDate(dateStr) {
    if (!dateStr) return null;

    // Fix known date issues
    let fixed = this.#fixDate(dateStr.trim());

    // MM/DD/YYYY
    if (fixed.includes('/')) {
      const parts = fixed.split('/');
      if (parts.length === 3) {
        return `${parts[2]}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}`;
      }
    }

    // DD-MON-YY, as in the unfinished package files: 04-DEC-09
    const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{2})$/.exec(fixed);
    if (m) {
      const month = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'].indexOf(m[2].toUpperCase()) + 1;
      if (month > 0) {
        const year = parseInt(m[3]) < 50 ? `20${m[3]}` : `19${m[3]}`;
        return `${year}${String(month).padStart(2, '0')}${m[1].padStart(2, '0')}`;
      }
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
    const parts = code.split('-');
    return parts[0].padStart(5, '0') + parts[1].padStart(4, '0') + parts[2].padStart(2, '0');
  }

  // the version is the date as YYYYMMDD, the way HL7 refers to an NDC distribution
  async #recordVersion(db, date) {
    await this.#run(db, 'INSERT INTO NDCVersion (Version) VALUES (?)', [date.replace(/-/g, '')]);
  }

  async #createLookupTables(db, verbose = true) {
    if (verbose) terminal.log('Creating lookup tables...');

    const lookups = [
      { table: 'NDCProductTypes', map: this.typesMap },
      { table: 'NDCOrganizations', map: this.orgsMap },
      { table: 'NDCDoseForms', map: this.doseFormsMap },
      { table: 'NDCRoutes', map: this.routesMap }
    ];

    // One transaction for all of them: otherwise each row commits (and waits on a disk sync) on its own
    await this.#run(db, 'BEGIN TRANSACTION');
    for (const lookup of lookups) {
      for (const [name, id] of lookup.map) {
        await this.#run(db, `INSERT INTO ${lookup.table} (NDCKey, Name) VALUES (?, ?)`, [id, name.substring(0, 500)]);
      }
    }
    await this.#run(db, 'COMMIT');
    if (verbose) terminal.log('Lookup tables created');
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
  }

  async migrate(sourceDir, destFile, version, options) {
    const groups = findNdcSources(sourceDir);
    // progress is counted in rows; estimate them from the file sizes (roughly 150 bytes a row)
    let bytes = 0;
    for (const group of groups) {
      for (const part of ['product', 'package', 'combined']) {
        if (group[part] && !(part === 'package' && options.productsOnly)) {
          bytes += group[part].size;
        }
      }
    }
    const estimate = Math.max(Math.round(bytes / 150), 1);

    this.module.logInfo(`Processing ${groups.length} NDC snapshots (${groups[groups.length - 1].date} to ${groups[0].date}, ~${estimate.toLocaleString()} rows)...`);
    this.module.createProgressBar();
    this.module.updateProgress(0, estimate);

    const migratorWithProgress = new NdcDataMigrator((currentProgress) => {
      this.module.updateProgress(Math.min(currentProgress, estimate));
    });

    try {
      return await migratorWithProgress.migrate(sourceDir, destFile, version, options);
    } finally {
      this.module.stopProgress();
    }
  }
}

module.exports = {
  NdcModule,
  NdcDataMigrator,
  findNdcSources,
  findNdcJsonSources
};
