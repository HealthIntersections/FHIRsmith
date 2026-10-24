const { BaseTerminologyModule } = require('./tx-import-base');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { csvRecords } = require('./csv-records');
const chalk = require('chalk');

class LoincSubsetModule extends BaseTerminologyModule {
  constructor() {
    super();
  }

  getName() {
    return 'loinc-subset';
  }

  getDescription() {
    return 'Create a subset of LOINC data for testing purposes';
  }

  getSupportedFormats() {
    return ['directory', 'txt'];
  }

  getDefaultConfig() {
    return {
      verbose: true,
      overwrite: false,
      dest: './loinc-subset',
      expandPartLinks: true
    };
  }

  getEstimatedDuration() {
    return '5-15 minutes (depending on subset size)';
  }

  registerCommands(terminologyCommand, globalOptions) {
    // Subset command
    terminologyCommand
      .command('subset')
      .description('Create a LOINC subset from a list of codes')
      .option('-s, --source <directory>', 'Source LOINC directory')
      .option('-d, --dest <directory>', 'Destination directory for subset')
      .option('-c, --codes <file>', 'Text file with LOINC codes (one per line)')
      .option('-y, --yes', 'Skip confirmations')
      .action(async (options) => {
        await this.handleSubsetCommand({...globalOptions, ...options});
      });

    // Validate command
    terminologyCommand
      .command('validate')
      .description('Validate subset inputs')
      .option('-s, --source <directory>', 'Source LOINC directory to validate')
      .option('-c, --codes <file>', 'Codes file to validate')
      .action(async (options) => {
        await this.handleValidateCommand({...globalOptions, ...options});
      });
  }

  async handleSubsetCommand(options) {
    try {
      // Gather configuration
      const config = await this.gatherSubsetConfig(options);

      // Add estimated duration to config for confirmation display
      config.estimatedDuration = this.getEstimatedDuration();

      // Show confirmation unless --yes is specified
      if (!options.yes) {
        const confirmed = await this.confirmSubset(config);
        if (!confirmed) {
          this.logInfo('Subset operation cancelled');
          return;
        }
      }

      // Save configuration immediately after confirmation
      this.rememberSuccessfulConfig(config);

      // Run the subset operation
      await this.runSubset(config);
    } catch (error) {
      this.logError(`Subset operation failed: ${error.message}`);
      if (options.verbose) {
        console.error(error.stack);
      }
      throw error;
    }
  }

  async gatherSubsetConfig(options) {
    const terminology = this.getName();

    // Get intelligent defaults based on previous usage
    const smartDefaults = this.configManager.generateDefaults(terminology);
    const recentSources = this.configManager.getRecentSources(terminology, 3);

    const questions = [];

    // Source directory
    if (!options.source) {
      const sourceQuestion = {
        type: 'input',
        name: 'source',
        message: 'Source LOINC directory:',
        validate: (input) => {
          if (!input) return 'Source directory is required';
          if (!fs.existsSync(input)) return 'Source directory does not exist';
          return true;
        },
        filter: (input) => path.resolve(input)
      };

      // Add default if we have a previous source
      if (smartDefaults.source) {
        sourceQuestion.default = smartDefaults.source;
      }

      // If we have recent sources, offer them as choices
      if (recentSources.length > 0) {
        sourceQuestion.type = 'list';
        sourceQuestion.choices = [
          ...recentSources.map(src => ({
            name: `${src} ${src === smartDefaults.source ? '(last used)' : ''}`.trim(),
            value: src
          })),
          { name: 'Enter new path...', value: 'NEW_PATH' }
        ];
        sourceQuestion.message = 'Select source LOINC directory:';
      }

      questions.push(sourceQuestion);

      // Follow up question for new path - only add if we're using the list approach
      if (recentSources.length > 0) {
        questions.push({
          type: 'input',
          name: 'source',
          message: 'Enter new source path:',
          when: (answers) => answers.source === 'NEW_PATH',
          validate: (input) => {
            if (!input) return 'Source directory is required';
            if (!fs.existsSync(input)) return 'Source directory does not exist';
            return true;
          },
          filter: (input) => path.resolve(input)
        });
      }
    }

    // Destination directory
    if (!options.dest) {
      questions.push({
        type: 'input',
        name: 'dest',
        message: 'Destination directory:',
        default: smartDefaults.dest || './loinc-subset',
        validate: (input) => {
          if (!input) return 'Destination directory is required';
          return true;
        },
        filter: (input) => path.resolve(input)
      });
    }

    // Codes file
    if (!options.codes) {
      questions.push({
        type: 'input',
        name: 'codes',
        message: 'Codes file (one code per line):',
        default: smartDefaults.codes,
        validate: (input) => {
          if (!input) return 'Codes file is required';
          if (!fs.existsSync(input)) return 'Codes file does not exist';
          return true;
        },
        filter: (input) => path.resolve(input)
      });
    }

    // Overwrite confirmation
    questions.push({
      type: 'confirm',
      name: 'overwrite',
      message: 'Overwrite destination directory if it exists?',
      default: smartDefaults.overwrite !== undefined ? smartDefaults.overwrite : false,
      when: (answers) => {
        const destPath = options.dest || answers.dest;
        return fs.existsSync(destPath);
      }
    });

    questions.push({
      type: 'confirm',
      name: 'expandPartLinks',
      message: 'Expand codes based on PartLink relationships?',
      default: smartDefaults.expandPartLinks !== undefined ? smartDefaults.expandPartLinks : true
    });

    questions.push({
      type: 'confirm',
      name: 'verbose',
      message: 'Show verbose output?',
      default: smartDefaults.verbose !== undefined ? smartDefaults.verbose : true
    });

    const answers = await require('inquirer').prompt(questions);

    const finalConfig = {
      ...this.getDefaultConfig(),
      ...smartDefaults,
      ...options,
      ...answers
    };

    return finalConfig;
  }

  async confirmSubset(config) {
    console.log(chalk.cyan(`\n📋 LOINC Subset Configuration:`));
    console.log(`  Source: ${chalk.white(config.source)}`);
    console.log(`  Destination: ${chalk.white(config.dest)}`);
    console.log(`  Codes File: ${chalk.white(config.codes)}`);
    console.log(`  Expand PartLinks: ${chalk.white(config.expandPartLinks ? 'Yes' : 'No')}`);
    console.log(`  Overwrite: ${chalk.white(config.overwrite ? 'Yes' : 'No')}`);

    if (config.estimatedDuration) {
      console.log(`  Estimated Duration: ${chalk.white(config.estimatedDuration)}`);
    }

    const { confirmed } = await require('inquirer').prompt({
      type: 'confirm',
      name: 'confirmed',
      message: 'Proceed with subset creation?',
      default: true
    });

    return confirmed;
  }

  async runSubset(config) {
    try {
      console.log(chalk.blue.bold(`🔬 Starting LOINC Subset Creation...\n`));

      if (config.verbose) {
        console.log('Debug - Final config values:');
        console.log(`  Source: ${config.source}`);
        console.log(`  Dest: ${config.dest}`);
        console.log(`  Codes: ${config.codes}`);
        console.log('');
      }

      // Pre-flight checks
      this.logInfo('Running pre-flight checks...');
      const prerequisitesPassed = await this.validateSubsetPrerequisites(config);

      if (!prerequisitesPassed) {
        throw new Error('Pre-flight checks failed');
      }

      // Execute the subset creation
      await this.executeSubset(config);

      this.logSuccess('LOINC subset created successfully!');

    } catch (error) {
      this.stopProgress();
      this.logError(`LOINC subset creation failed: ${error.message}`);
      if (config.verbose) {
        console.error(error.stack);
      }
      throw error;
    }
  }

  async handleValidateCommand(options) {
    if (!options.source || !options.codes) {
      const answers = await require('inquirer').prompt([
        {
          type: 'input',
          name: 'source',
          message: 'Source LOINC directory:',
          when: !options.source,
          validate: (input) => input && fs.existsSync(input) ? true : 'Directory does not exist'
        },
        {
          type: 'input',
          name: 'codes',
          message: 'Codes file:',
          when: !options.codes,
          validate: (input) => input && fs.existsSync(input) ? true : 'File does not exist'
        }
      ]);
      Object.assign(options, answers);
    }

    this.logInfo('Validating subset inputs...');

    try {
      const stats = await this.validateSubsetInputs(options.source, options.codes);

      this.logSuccess('Validation passed');
      console.log(`  Source files found: ${stats.filesFound.length}`);
      console.log(`  Codes in list: ${stats.codeCount.toLocaleString()}`);
      console.log(`  Unique codes: ${stats.uniqueCodes.toLocaleString()}`);

      if (stats.warnings.length > 0) {
        this.logWarning('Validation warnings:');
        stats.warnings.forEach(warning => console.log(`    ${warning}`));
      }

    } catch (error) {
      this.logError(`Validation failed: ${error.message}`);
    }
  }

  async validateSubsetPrerequisites(config) {
    const checks = [
      {
        name: 'Source directory exists',
        check: () => {
          const exists = fs.existsSync(config.source);
          if (!exists && config.verbose) {
            console.log(`    Source path being checked: ${config.source}`);
          }
          return exists;
        }
      },
      {
        name: 'Codes file exists',
        check: () => {
          const exists = fs.existsSync(config.codes);
          if (!exists && config.verbose) {
            console.log(`    Codes path being checked: ${config.codes}`);
          }
          return exists;
        }
      },
      {
        name: 'Source contains LOINC files',
        check: async () => {
          const requiredFiles = [
            'LoincTable/Loinc.csv',
            'AccessoryFiles/PartFile/Part.csv'
          ];

          const results = requiredFiles.map(file => {
            const fullPath = path.join(config.source, file);
            const exists = fs.existsSync(fullPath);
            if (!exists && config.verbose) {
              console.log(`    Missing required file: ${fullPath}`);
            }
            return exists;
          });

          return results.every(result => result);
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

  async executeSubset(config) {
    this.logInfo('Loading target codes...');

    // Load the initial target codes
    const initialTargetCodes = await this.loadTargetCodes(config.codes);
    this.logInfo(`Loaded ${initialTargetCodes.size.toLocaleString()} initial target codes`);

    if (config.verbose) {
      const sampleCodes = Array.from(initialTargetCodes).slice(0, 20);
      console.log(`First 20 codes from file: ${sampleCodes.join(', ')}`);

      // Validate some codes exist in the main LOINC file
      this.logInfo('Validating codes exist in LOINC...');
      const validationResults = await this.validateCodesExist(config.source, initialTargetCodes);
      console.log(`Found ${validationResults.found} of ${validationResults.checked} codes in LOINC main table`);
      if (validationResults.notFound.length > 0) {
        console.log(`Sample missing codes: ${validationResults.notFound.slice(0, 5).join(', ')}`);
      }
    }

    let finalTargetCodes = initialTargetCodes;

    // Expand target codes based on PartLink relationships if requested
    if (config.expandPartLinks) {
      this.logInfo('Expanding target codes based on PartLink relationships...');
      finalTargetCodes = await this.expandCodesFromPartLinks(config.source, initialTargetCodes, config.verbose);

      const addedCodes = finalTargetCodes.size - initialTargetCodes.size;
      this.logInfo(`Added ${addedCodes.toLocaleString()} related codes from PartLink relationships`);

      if (config.verbose && addedCodes > 0) {
        const newCodes = Array.from(finalTargetCodes).filter(code => !initialTargetCodes.has(code));
        const sampleNewCodes = newCodes.slice(0, 10);
        console.log(`Sample newly added codes: ${sampleNewCodes.join(', ')}`);
      }
    } else {
      this.logInfo('Skipping PartLink expansion (disabled)');
    }

    this.logInfo(`Final target codes: ${finalTargetCodes.size.toLocaleString()}`);

    // Export final codes to file for inspection
    if (config.verbose) {
      const codesOutputPath = path.join(process.cwd(), 'final-target-codes.txt');
      this.logInfo(`Exporting final code set to: ${codesOutputPath}`);
      await this.exportCodesToFile(finalTargetCodes, codesOutputPath);
    }

    // Create subset processor
    const processor = new LoincSubsetProcessor(this, config.verbose);

    await processor.createSubset(
      config.source,
      config.dest,
      finalTargetCodes,
      {
        verbose: config.verbose,
        overwrite: config.overwrite,
        originalCodes: initialTargetCodes  // Pass original codes for PartLink filtering
      }
    );
  }

  async expandCodesFromPartLinks(sourceDir, initialCodes, verbose = false) {
    const partLinkPath = path.join(sourceDir, 'AccessoryFiles/PartFile/LoincPartLink_Primary.csv');

    if (!fs.existsSync(partLinkPath)) {
      if (verbose) {
        console.log(`    PartLink file not found: ${partLinkPath}`);
      }
      return new Set(initialCodes);
    }

    const expandedCodes = new Set(initialCodes);

    if (verbose) {
      console.log(`    Processing PartLink relationships (single pass)...`);
      console.log(`    Original codes count: ${initialCodes.size}`);
    }

    const rl = readline.createInterface({
      input: fs.createReadStream(partLinkPath),
      crlfDelay: Infinity
    });

    let lineNum = 0;
    let addedCodes = 0;
    let matchedLines = 0;

    for await (const line of rl) {
      lineNum++;

      // Skip header
      if (lineNum === 1) continue;

      const items = this.csvSplit(line, 7);
      if (items.length < 3) continue;

      const firstCode = this.removeQuotes(items[0]);  // First cell
      const thirdCode = this.removeQuotes(items[2]);  // Third cell

      // If either code is in our INITIAL target set, add both codes
      const firstInOriginal = initialCodes.has(firstCode);
      const thirdInOriginal = initialCodes.has(thirdCode);

      if (firstInOriginal || thirdInOriginal) {
        matchedLines++;
        const sizeBefore = expandedCodes.size;
        expandedCodes.add(firstCode);
        expandedCodes.add(thirdCode);
        const sizeAfter = expandedCodes.size;
        addedCodes += (sizeAfter - sizeBefore);

        if (verbose && matchedLines <= 10) {
          console.log(`    Match ${matchedLines}: "${firstCode}" (${firstInOriginal ? 'in original' : 'new'}) <-> "${thirdCode}" (${thirdInOriginal ? 'in original' : 'new'})`);
        }
      }
    }

    if (verbose) {
      console.log(`    Single pass completed: ${matchedLines} matching relationships found`);
      console.log(`    Added ${addedCodes} new codes`);
      console.log(`    Final expanded codes count: ${expandedCodes.size}`);

      // Show what percentage this represents
      const expansionRatio = expandedCodes.size / initialCodes.size;
      console.log(`    Expansion ratio: ${expansionRatio.toFixed(1)}x original size`);
    }

    return expandedCodes;
  }

  // Helper method for CSV parsing (moved from processor for reuse)
  csvSplit(line, expectedCount) {
    const result = new Array(expectedCount).fill('');
    let inQuoted = false;
    let currentField = 0;
    let fieldStart = 0;
    let i = 0;

    while (i < line.length && currentField < expectedCount) {
      const ch = line[i];

      if (!inQuoted && ch === ',') {
        if (currentField < expectedCount) {
          result[currentField] = line.substring(fieldStart, i);
          currentField++;
          fieldStart = i + 1;
        }
      } else if (ch === '"') {
        if (inQuoted && i + 1 < line.length && line[i + 1] === '"') {
          i++; // Skip escaped quote
        } else {
          inQuoted = !inQuoted;
        }
      }
      i++;
    }

    // Handle last field
    if (currentField < expectedCount) {
      result[currentField] = line.substring(fieldStart);
    }

    return result;
  }

  // Helper method for removing quotes (moved from processor for reuse)
  removeQuotes(str) {
    if (!str) return '';
    return str.replace(/^"|"$/g, '');
  }

  async exportCodesToFile(codeSet, filePath) {
    const sortedCodes = Array.from(codeSet).sort();
    const content = sortedCodes.join('\n') + '\n';

    fs.writeFileSync(filePath, content, 'utf8');
    this.logInfo(`Exported ${sortedCodes.length.toLocaleString()} codes to ${filePath}`);
  }

  async validateCodesExist(sourceDir, targetCodes) {
    const loincMainPath = path.join(sourceDir, 'LoincTable/Loinc.csv');

    if (!fs.existsSync(loincMainPath)) {
      return { found: 0, checked: 0, notFound: [] };
    }

    const foundCodes = new Set();

    const rl = readline.createInterface({
      input: fs.createReadStream(loincMainPath),
      crlfDelay: Infinity
    });

    let lineNum = 0;
    for await (const line of rl) {
      lineNum++;

      // Skip header
      if (lineNum === 1) continue;

      const items = this.csvSplit(line, 39);
      if (items.length < 1) continue;

      const code = this.removeQuotes(items[0]);
      if (targetCodes.has(code)) {
        foundCodes.add(code);
      }
    }

    const checked = Math.min(targetCodes.size, 100); // Only check first 100 for performance
    const notFound = Array.from(targetCodes).slice(0, 100).filter(code => !foundCodes.has(code));

    return {
      found: foundCodes.size,
      checked: checked,
      notFound: notFound
    };
  }

  async loadTargetCodes(codesFile) {
    const codes = new Set();

    const rl = readline.createInterface({
      input: fs.createReadStream(codesFile),
      crlfDelay: Infinity
    });

    for await (const line of rl) {
      const code = line.trim();
      if (code && !code.startsWith('#')) { // Allow comments with #
        codes.add(code);
      }
    }

    return codes;
  }

  async validateSubsetInputs(sourceDir, codesFile) {
    const stats = {
      filesFound: [],
      codeCount: 0,
      uniqueCodes: 0,
      warnings: []
    };

    // Check for LOINC files
    const loincFiles = [
      'LoincTable/Loinc.csv',
      'AccessoryFiles/PartFile/Part.csv',
      'AccessoryFiles/ConsumerName/ConsumerName.csv',
      'AccessoryFiles/AnswerFile/AnswerList.csv',
      'AccessoryFiles/PartFile/LoincPartLink_Primary.csv',
      'AccessoryFiles/AnswerFile/LoincAnswerListLink.csv',
      'AccessoryFiles/ComponentHierarchyBySystem/ComponentHierarchyBySystem.csv',
      'AccessoryFiles/LinguisticVariants/LinguisticVariants.csv'
    ];

    for (const file of loincFiles) {
      const filePath = path.join(sourceDir, file);
      if (fs.existsSync(filePath)) {
        stats.filesFound.push(file);
      } else {
        stats.warnings.push(`File not found: ${file}`);
      }
    }

    // Validate codes file
    const codes = await this.loadTargetCodes(codesFile);
    stats.codeCount = codes.size;
    stats.uniqueCodes = codes.size;

    return stats;
  }
}

class LoincSubsetProcessor {
  constructor(moduleInstance, verbose = true) {
    this.module = moduleInstance;
    this.verbose = verbose;
    this.targetCodes = null;
    this.processedFiles = 0;
    this.totalFiles = 0;
  }

  // Add this method to LoincSubsetProcessor
  cleanLine(line) {
    // Remove trailing commas and whitespace
    return line.replace(/,+\s*$/, '');
  }

  async createSubset(sourceDir, destDir, targetCodes, options) {
    this.targetCodes = targetCodes;
    this.originalCodes = options.originalCodes || targetCodes;  // Fallback to targetCodes if not provided

    // Create destination directory structure
    await this.createDirectoryStructure(destDir, options.overwrite);

    // Define files to process with their handlers
    const filesToProcess = [
      {
        source: 'LoincTable/Loinc.csv',
        dest: 'LoincTable/Loinc.csv',
        handler: 'processMainCodes'
      },
      {
        source: 'AccessoryFiles/PartFile/Part.csv',
        dest: 'AccessoryFiles/PartFile/Part.csv',
        handler: 'processParts'
      },
      {
        source: 'AccessoryFiles/ConsumerName/ConsumerName.csv',
        dest: 'AccessoryFiles/ConsumerName/ConsumerName.csv',
        handler: 'processConsumerNames'
      },
      {
        source: 'AccessoryFiles/AnswerFile/AnswerList.csv',
        dest: 'AccessoryFiles/AnswerFile/AnswerList.csv',
        handler: 'processAnswerLists'
      },
      {
        source: 'AccessoryFiles/PartFile/LoincPartLink_Primary.csv',
        dest: 'AccessoryFiles/PartFile/LoincPartLink_Primary.csv',
        handler: 'processPartLinks'
      },
      {
        source: 'AccessoryFiles/AnswerFile/LoincAnswerListLink.csv',
        dest: 'AccessoryFiles/AnswerFile/LoincAnswerListLink.csv',
        handler: 'processAnswerListLinks'
      },
      {
        source: 'AccessoryFiles/ComponentHierarchyBySystem/ComponentHierarchyBySystem.csv',
        dest: 'AccessoryFiles/ComponentHierarchyBySystem/ComponentHierarchyBySystem.csv',
        handler: 'processHierarchy'
      },
      {
        source: 'AccessoryFiles/PartFile/PartRelatedCodeMapping.csv',
        dest: 'AccessoryFiles/PartFile/PartRelatedCodeMapping.csv',
        handler: 'processFirstColumnCodes'
      },
      {
        source: 'AccessoryFiles/LoincIeeeMedicalDeviceCodeMappingTable/LoincIeeeMedicalDeviceCodeMappingTable.csv',
        dest: 'AccessoryFiles/LoincIeeeMedicalDeviceCodeMappingTable/LoincIeeeMedicalDeviceCodeMappingTable.csv',
        handler: 'processFirstColumnCodes'
      },
      {
        source: 'AccessoryFiles/LinguisticVariants/LinguisticVariants.csv',
        dest: 'AccessoryFiles/LinguisticVariants/LinguisticVariants.csv',
        handler: 'processLanguageVariants'
      }
    ];

    // Count existing files
    this.totalFiles = filesToProcess.filter(file =>
      fs.existsSync(path.join(sourceDir, file.source))
    ).length;

    // Add language variant files
    const languageVariantFiles = await this.findLanguageVariantFiles(sourceDir);
    this.totalFiles += languageVariantFiles.length;

    this.module.logInfo(`Processing ${this.totalFiles} files...`);
    this.module.createProgressBar();
    this.module.updateProgress(0, this.totalFiles);

    // Process main files
    for (const file of filesToProcess) {
      const sourcePath = path.join(sourceDir, file.source);
      const destPath = path.join(destDir, file.dest);

      if (fs.existsSync(sourcePath)) {
        if (this.verbose) {
          this.module.logInfo(`Processing ${file.source}...`);
        }

        await this[file.handler](sourcePath, destPath);
        this.processedFiles++;
        this.module.updateProgress(this.processedFiles);
      }
    }

    // Process language variant files
    for (const langFile of languageVariantFiles) {
      const sourcePath = path.join(sourceDir, langFile);
      const destPath = path.join(destDir, langFile);

      if (this.verbose) {
        this.module.logInfo(`Processing ${langFile}...`);
      }

      await this.processLanguageVariantFile(sourcePath, destPath);
      this.processedFiles++;
      this.module.updateProgress(this.processedFiles);
    }

    this.module.stopProgress();
  }

  async createDirectoryStructure(destDir, overwrite) {
    if (fs.existsSync(destDir)) {
      if (overwrite) {
        fs.rmSync(destDir, { recursive: true, force: true });
      } else {
        throw new Error(`Destination directory already exists: ${destDir}`);
      }
    }

    // Create directory structure
    const dirs = [
      destDir,
      path.join(destDir, 'LoincTable'),
      path.join(destDir, 'AccessoryFiles'),
      path.join(destDir, 'AccessoryFiles/PartFile'),
      path.join(destDir, 'AccessoryFiles/ConsumerName'),
      path.join(destDir, 'AccessoryFiles/AnswerFile'),
      path.join(destDir, 'AccessoryFiles/ComponentHierarchyBySystem'),
      path.join(destDir, 'AccessoryFiles/LinguisticVariants'),
      path.join(destDir, 'AccessoryFiles/LoincIeeeMedicalDeviceCodeMappingTable')
    ];

    for (const dir of dirs) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  async findLanguageVariantFiles(sourceDir) {
    const languageVariantFiles = [];
    const linguisticVariantsDir = path.join(sourceDir, 'AccessoryFiles/LinguisticVariants');

    if (fs.existsSync(linguisticVariantsDir)) {
      const files = fs.readdirSync(linguisticVariantsDir);
      for (const file of files) {
        if (file.includes('LinguisticVariant.csv') && !file.startsWith('LinguisticVariants.csv')) {
          languageVariantFiles.push(`AccessoryFiles/LinguisticVariants/${file}`);
        }
      }
    }

    return languageVariantFiles;
  }

  async processMainCodes(sourcePath, destPath) {
    await this.processFileWithFilter(sourcePath, destPath, (line, lineNum) => {
      if (lineNum === 1) return true; // Keep header

      const items = this.csvSplit(line, 39);
      if (items.length < 1) return false;

      const code = this.removeQuotes(items[0]);
      return this.targetCodes.has(code);
    });
  }

  async processParts(sourcePath, destPath) {
    if (this.verbose) {
      console.log(`    Processing parts file: ${sourcePath}`);
      console.log(`    Target codes size: ${this.targetCodes.size}`);

      // Show first few target codes for comparison
      const sampleCodes = Array.from(this.targetCodes).slice(0, 5);
      console.log(`    Sample target codes: ${sampleCodes.join(', ')}`);
    }

    await this.processFileWithFilter(sourcePath, destPath, (line, lineNum) => {
      if (lineNum === 1) return true; // Keep header

      const items = this.csvSplit(line, 5);
      if (items.length < 1) return false;

      const code = this.removeQuotes(items[0]);
      const hasCode = this.targetCodes.has(code);

      // Debug first few lines
      if (this.verbose && lineNum <= 5) {
        console.log(`    Line ${lineNum}: raw="${items[0]}", clean="${code}", match=${hasCode}`);
      }

      return hasCode;
    });
  }

  async processConsumerNames(sourcePath, destPath) {
    if (this.verbose) {
      console.log(`    Processing consumer names file: ${sourcePath}`);
      console.log(`    Target codes size: ${this.targetCodes.size}`);

      // Show first few target codes for comparison
      const sampleCodes = Array.from(this.targetCodes).slice(0, 5);
      console.log(`    Sample target codes: ${sampleCodes.join(', ')}`);
    }

    await this.processFileWithFilter(sourcePath, destPath, (line, lineNum) => {
      if (lineNum === 1) return true; // Keep header

      const items = this.csvSplit(line, 2);
      if (items.length < 1) return false;

      const code = this.removeQuotes(items[0]);
      const hasCode = this.targetCodes.has(code);

      // Debug first few lines
      if (this.verbose && lineNum <= 5) {
        console.log(`    Line ${lineNum}: raw="${items[0]}", clean="${code}", match=${hasCode}`);
      }

      return hasCode;
    });
  }

  // keep the rows whose first column (the LOINC code or part) is in the subset
  async processFirstColumnCodes(sourcePath, destPath) {
    await this.processFileWithFilter(sourcePath, destPath, (line, lineNum) => {
      if (lineNum === 1) return true; // Keep header

      const items = this.csvSplit(line, 1);
      return this.targetCodes.has(this.removeQuotes(items[0]));
    });
  }

  async processAnswerLists(sourcePath, destPath) {
    await this.processFileWithFilter(sourcePath, destPath, (line, lineNum) => {
      if (lineNum === 1) return true; // Keep header

      const items = this.csvSplit(line, 11);
      if (items.length < 7) return false;

      const listCode = this.removeQuotes(items[0]);
      const answerCode = this.removeQuotes(items[6]);

      return this.targetCodes.has(listCode) || this.targetCodes.has(answerCode);
    });
  }

  async processPartLinks(sourcePath, destPath) {
    if (this.verbose) {
      console.log(`    Processing part links file: ${sourcePath}`);
      console.log(`    Target codes size: ${this.targetCodes.size}`);
      console.log(`    Original codes size: ${this.originalCodes.size}`);
      console.log(`    Using ORIGINAL codes for PartLink filtering to prevent expansion explosion`);
    }

    let debugCount = 0;
    await this.processFileWithFilter(sourcePath, destPath, (line, lineNum) => {
      if (lineNum === 1) return true; // Keep header

      const items = this.csvSplit(line, 7);
      if (items.length < 3) return false;

      const sourceCode = this.removeQuotes(items[0]); // First cell
      const targetCode = this.removeQuotes(items[2]); // Third cell

      // Use ORIGINAL codes for filtering, not expanded codes
      const hasSource = this.originalCodes.has(sourceCode);
      const hasTarget = this.originalCodes.has(targetCode);
      const shouldInclude = hasSource || hasTarget;

      // Debug first few included lines
      if (this.verbose && shouldInclude && debugCount < 10) {
        debugCount++;
        console.log(`    Include ${debugCount}: "${sourceCode}" (${hasSource ? 'original' : 'no'}) <-> "${targetCode}" (${hasTarget ? 'original' : 'no'})`);
      }

      return shouldInclude;
    });
  }

  async processAnswerListLinks(sourcePath, destPath) {
    await this.processFileWithFilter(sourcePath, destPath, (line, lineNum) => {
      if (lineNum === 1) return true; // Keep header

      const items = this.csvSplit(line, 7); // Increased expected count to handle 6th column
      if (items.length < 6) return false;

      const firstCode = this.removeQuotes(items[0]);  // First cell
      const thirdCode = this.removeQuotes(items[2]);  // Third cell
      const sixthCode = this.removeQuotes(items[5]);  // Sixth cell (index 5)

      const res = this.targetCodes.has(firstCode) && (
        this.targetCodes.has(thirdCode) && (!sixthCode || this.targetCodes.has(sixthCode)));
      return res;
    });
  }

  async processHierarchy(sourcePath, destPath) {
    await this.processFileWithFilter(sourcePath, destPath, (line, lineNum) => {
      if (lineNum === 1) return true; // Keep header

      const items = this.csvSplit(line, 12);
      if (items.length < 5) return false;

      const childCode = this.removeQuotes(items[2]); // Third cell (column 3)
      const relatedCode = this.removeQuotes(items[3]); // Fourth cell (column 4)

      if (!childCode) {
        return true;
      }
      // Check if this row should be included based on columns 3 and 4
      if (this.targetCodes.has(childCode) && this.targetCodes.has(relatedCode)) {
        // Modify the hierarchical path in column 1 (first cell)
        const originalPath = this.removeQuotes(items[0]);
        const pathCodes = originalPath.split('.');
        const filteredCodes = pathCodes.filter(code => this.targetCodes.has(code));
        const newPath = filteredCodes.join('.');

        // Rebuild the line with modified path
        const modifiedItems = [...items];
        modifiedItems[0] = `"${newPath}"`;
        return { include: true, modifiedLine: modifiedItems.join(',') };
      }

      return false;
    });
  }

  async processLanguageVariants(sourcePath, destPath) {
    await this.processFileWithFilter(sourcePath, destPath, (line, lineNum) => {
      if (lineNum === 1) return true; // Keep header

      // For the main LinguisticVariants.csv, include all language definitions
      // since we can't know which languages we'll need until we process individual files
      return true;
    });
  }

  async processLanguageVariantFile(sourcePath, destPath) {
    await this.processFileWithFilter(sourcePath, destPath, (line, lineNum) => {
      if (lineNum === 1) return true; // Keep header

      const items = this.csvSplit(line, 12);
      if (items.length < 1) return false;

      // First column contains the LOINC code
      const code = this.removeQuotes(items[0]);
      return this.targetCodes.has(code);
    });
  }

  async processFileWithFilter(sourcePath, destPath, filterFunction) {
    if (!fs.existsSync(sourcePath)) {
      return;
    }

    const writeStream = fs.createWriteStream(destPath);

    // records, not lines: a quoted field can hold a line break
    const rl = csvRecords(sourcePath);

    let lineNum = 0;
    let includedLines = 0;

    for await (const line of rl) {
      lineNum++;

      const result = filterFunction(line, lineNum);

      if (result === true) {
        const cleanedLine = this.cleanLine(line);
        writeStream.write(cleanedLine + '\n');
        includedLines++;
      } else if (result && result.include) {
        const cleanedLine = this.cleanLine(result.modifiedLine);
        writeStream.write(cleanedLine + '\n');
        includedLines++;
      }
    }

    writeStream.end();

    if (this.verbose && lineNum > 1) {
      console.log(`    Included ${includedLines - 1} of ${lineNum - 1} data rows`);
    }
  }

  csvSplit(line, expectedCount) {
    const result = new Array(expectedCount).fill('');
    let inQuoted = false;
    let currentField = 0;
    let fieldStart = 0;
    let i = 0;

    while (i < line.length && currentField < expectedCount) {
      const ch = line[i];

      if (!inQuoted && ch === ',') {
        if (currentField < expectedCount) {
          result[currentField] = line.substring(fieldStart, i);
          currentField++;
          fieldStart = i + 1;
        }
      } else if (ch === '"') {
        if (inQuoted && i + 1 < line.length && line[i + 1] === '"') {
          i++; // Skip escaped quote
        } else {
          inQuoted = !inQuoted;
        }
      }
      i++;
    }

    // Handle last field
    if (currentField < expectedCount) {
      result[currentField] = line.substring(fieldStart);
    }

    return result;
  }

  removeQuotes(str) {
    if (!str) return '';
    return str.replace(/^"|"$/g, '');
  }
}

module.exports = {
  LoincSubsetModule
};