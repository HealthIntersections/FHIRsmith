const { BaseTerminologyModule } = require('./tx-import-base');
const fs = require('fs');
const inquirer = require('inquirer');
const path = require('path');
const readline = require('readline');
const chalk = require('chalk');
const natural = require('natural/lib/natural/stemmers'); // just the stemmers: the package index also loads its storage backends, and dotenv with them

const {
  SnomedStrings, SnomedWords, SnomedStems, SnomedReferences,
  SnomedDescriptions, SnomedDescriptionIndex, SnomedConceptList,
  SnomedRelationshipList, SnomedReferenceSetMembers, SnomedReferenceSetIndex
} = require('../sct/structures');
const {SnomedExpressionServices} = require("../sct/expressions");

// definitionStatusId values from the RF2 concept file
const SNOMED_DEFINITION_STATUS_PRIMITIVE = 900000000000074008n;

class SnomedModule extends BaseTerminologyModule {

  constructor() {
    super();
  }

  getName() {
    return 'snomed';
  }

  getDescription() {
    return 'SNOMED Clinical Terms (SNOMED CT) from IHTSDO';
  }

  getSupportedFormats() {
    return ['rf2', 'directory'];
  }

  getDefaultConfig() {
    return {
      verbose: true,
      overwrite: false,
      createIndexes: true,
      language: 'en-US',
      dest: './data/snomed.cache'
    };
  }

  getEstimatedDuration() {
    return '2-6 hours (depending on edition size)';
  }

  registerCommands(terminologyCommand, globalOptions) {
    // Import command
    terminologyCommand
        .command('import')
        .description('Import SNOMED CT data from RF2 source directory')
        .option('-s, --source <directory>', 'Source directory containing RF2 files')
        .option('-b, --base <directory>', 'Base edition directory (for extensions)')
        .option('-d, --dest <file>', 'Destination cache file')
        .option('-e, --edition <code>', 'Edition code (e.g., 900000000000207008 for International)')
        .option('-v, --version <version>', 'Version in YYYYMMDD format (e.g., 20250801)')
        .option('-u, --uri <uri>', 'Version URI (overrides edition/version if provided)')
        .option('-l, --language <code>', 'Default language code (overrides edition default if provided)')
        .option('-y, --yes', 'Skip confirmations')
        .action(async (options) => {
          await this.handleImportCommand({...globalOptions, ...options});
        });

    // Validate command
    terminologyCommand
        .command('validate')
        .description('Validate SNOMED CT RF2 directory structure')
        .option('-s, --source <directory>', 'Source directory to validate')
        .action(async (options) => {
          await this.handleValidateCommand({...globalOptions, ...options});
        });

    // Status command
    terminologyCommand
        .command('status')
        .description('Show status of SNOMED CT cache')
        .option('-d, --dest <file>', 'Cache file to check')
        .action(async (options) => {
          await this.handleStatusCommand({...globalOptions, ...options});
        });
  }

  async handleImportCommand(options) {
    try {
      // Gather configuration
      const config = await this.gatherSnomedConfig(options);

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
    console.log(chalk.cyan(`\n📋 ${this.getName()} Import Configuration:`));
    console.log(`  Source: ${chalk.white(config.source)}`);
    console.log(`  Destination: ${chalk.white(config.dest)}`);

    if (config.edition) {
      const editions = {
        "900000000000207008": "International",
        "731000124108": "US Edition",
        "32506021000036107": "Australian Edition",
        // ... other editions
      };
      const editionName = editions[config.edition] || `Edition ${config.edition}`;
      console.log(`  Edition: ${chalk.white(editionName)} (${config.edition})`);
    }

    if (config.version) {
      console.log(`  Version: ${chalk.white(config.version)}`);
    }

    if (config.uri) {
      console.log(`  Version URI: ${chalk.white(config.uri)}`);
    }

    if (config.language) {
      console.log(`  Language: ${chalk.white(config.language)}`);
    }

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

  /**
   * Auto-detect edition and version from RF2 files
   * Reads concept files to extract moduleId and effectiveTime
   * Prefers non-International modules since national editions contain International content
   */
  async detectEditionAndVersion(sourceDir) {
    const detected = {
      edition: null,
      version: null,
      editionName: null
    };

    // Known editions mapping
    const editions = {
      "900000000000207008": "International",
      "731000124108": "US Edition",
      "32506021000036107": "Australian Edition",
      "449081005": "Spanish Edition (International)",
      "11000279109": "Czech Edition",
      "554471000005108": "Danish Edition",
      "11000146104": "Dutch Edition",
      "45991000052106": "Swedish Edition",
      "83821000000107": "UK Edition",
      "11000172109": "Belgian Edition",
      "11000221109": "Argentinian Edition",
      "11000234105": "Austrian Edition",
      "20621000087109": "Canadian Edition (English)",
      "20611000087101": "Canadian Edition (French)",
      "11000181102": "Estonian Edition",
      "11000229106": "Finnish Edition",
      "11000274103": "German Edition",
      "1121000189102": "Indian Edition",
      "11000220105": "Irish Edition",
      "21000210109": "New Zealand Edition",
      "51000202101": "Norwegian Edition",
      "11000267109": "Korean Edition",
      "900000001000122104": "Spanish Edition (Spain)",
      "2011000195101": "Swiss Edition",
      "999000021000000109": "UK Clinical Edition",
      "5631000179106": "Uruguayan Edition",
      "21000325107": "Chilean Edition",
      "5991000124107": "US Edition + ICD10CM"
    };

    // Filename patterns for edition codes (2-letter country codes in filenames)
    const filenameEditionCodes = {
      'INT': '900000000000207008',
      'US': '731000124108',
      'AU': '32506021000036107',
      'UK': '83821000000107',
      'BE': '11000172109',
      'NL': '11000146104',
      'SE': '45991000052106',
      'DK': '554471000005108',
      'NO': '51000202101',
      'FI': '11000229106',
      'DE': '11000274103',
      'AT': '11000234105',
      'CH': '2011000195101',
      'ES': '900000001000122104',
      'AR': '11000221109',
      'CL': '21000325107',
      'UY': '5631000179106',
      'NZ': '21000210109',
      'IE': '11000220105',
      'EE': '11000181102',
      'CZ': '11000279109',
      'KR': '11000267109',
      'IN': '1121000189102'
    };

    const INTERNATIONAL_MODULE = "900000000000207008";

    try {
      const files = this.discoverRF2Files(sourceDir);

      if (files.concepts.length > 0) {
        const conceptFile = files.concepts[0];
        const fileName = path.basename(conceptFile);

        // Try to extract edition and version from filename
        // Patterns: sct2_Concept_Snapshot_BE1000172_20260215.txt
        //           sct2_Concept_Snapshot_INT_20250201.txt
        //           sct2_Concept_Snapshot-BE_20260215.txt
        //           sct2_Concept_Snapshot-en-BE_20260215.txt

        // First, extract the version (8-digit date) - it's always at the end before .txt
        const versionMatch = fileName.match(/_(\d{8})\.txt$/i);
        if (versionMatch) {
          detected.version = versionMatch[1];
        }

        // Then extract the edition code (2-3 letters after Snapshot)
        const editionMatch = fileName.match(/Snapshot[_-](?:en-)?([A-Z]{2,3})/i);
        if (editionMatch) {
          const editionCode = editionMatch[1].toUpperCase();

          // Look up edition from the 2-3 letter code
          if (filenameEditionCodes[editionCode]) {
            detected.edition = filenameEditionCodes[editionCode];
            detected.editionName = editions[detected.edition];
          }
        }

        // If we didn't detect edition from filename, scan the file for non-International modules
        if (!detected.edition) {
          const moduleIds = new Map(); // moduleId -> count
          let latestEffectiveTime = null;

          const rl = readline.createInterface({
            input: fs.createReadStream(conceptFile),
            crlfDelay: Infinity
          });

          let lineCount = 0;
          const MAX_LINES_TO_SCAN = 50000; // Scan enough lines to find edition-specific content

          for await (const line of rl) {
            lineCount++;
            if (lineCount === 1) continue; // Skip header

            const parts = line.split('\t');
            if (parts.length >= 4) {
              const effectiveTime = parts[1];
              const moduleId = parts[3];

              // Track the latest effectiveTime for version
              if (effectiveTime && /^\d{8}$/.test(effectiveTime)) {
                if (!latestEffectiveTime || effectiveTime > latestEffectiveTime) {
                  latestEffectiveTime = effectiveTime;
                }
              }

              // Count module occurrences
              if (moduleId) {
                moduleIds.set(moduleId, (moduleIds.get(moduleId) || 0) + 1);
              }
            }

            if (lineCount >= MAX_LINES_TO_SCAN) break;
          }

          rl.close();

          // Use latest effectiveTime as version if not already detected
          if (!detected.version && latestEffectiveTime) {
            detected.version = latestEffectiveTime;
          }

          // Find the best edition - prefer non-International modules
          let bestModule = null;
          let bestCount = 0;

          for (const [moduleId, count] of moduleIds) {
            // Skip International module if we have other known editions
            if (moduleId === INTERNATIONAL_MODULE) {
              continue;
            }

            // Prefer known editions with highest count
            if (editions[moduleId] && count > bestCount) {
              bestModule = moduleId;
              bestCount = count;
            }
          }

          // If no non-International module found, fall back to International
          if (!bestModule && moduleIds.has(INTERNATIONAL_MODULE)) {
            bestModule = INTERNATIONAL_MODULE;
          }

          if (bestModule) {
            detected.edition = bestModule;
            detected.editionName = editions[bestModule] || `Unknown Edition (${bestModule})`;
          }
        }

        // If we still don't have version, read first few lines
        if (!detected.version) {
          const fd = fs.openSync(conceptFile, 'r');
          try {
            const buffer = Buffer.alloc(2000);
            const bytesRead = fs.readSync(fd, buffer, 0, 2000, 0);
            const content = buffer.toString('utf8', 0, bytesRead);
            const lines = content.split('\n');

            if (lines.length >= 2) {
              const parts = lines[1].split('\t');
              if (parts.length >= 2 && /^\d{8}$/.test(parts[1])) {
                detected.version = parts[1];
              }
            }
          } finally {
            fs.closeSync(fd);
          }
        }
      }
    } catch (error) {
      // Silent fail - auto-detection is best-effort
      if (this.config?.verbose) {
        console.log(`Auto-detection warning: ${error.message}`);
      }
    }

    return detected;
  }

  /**
   * Check if the source directory contains International content
   * (i.e., concepts with the International module ID)
   * If true, this is a combined/complete release that doesn't need a separate base
   */
  async checkForInternationalContent(sourceDir) {
    const INTERNATIONAL_MODULE = "900000000000207008";

    try {
      const files = this.discoverRF2Files(sourceDir);
      if (files.concepts.length === 0) return false;

      const conceptFile = files.concepts[0];
      const rl = readline.createInterface({
        input: fs.createReadStream(conceptFile),
        crlfDelay: Infinity
      });

      let lineCount = 0;
      let hasInternational = false;

      for await (const line of rl) {
        lineCount++;
        if (lineCount === 1) continue; // Skip header

        const parts = line.split('\t');
        if (parts.length >= 4 && parts[3] === INTERNATIONAL_MODULE) {
          hasInternational = true;
          break;
        }

        // Only check first 100 lines - International concepts are always at the start
        if (lineCount > 100) break;
      }

      rl.close();
      return hasInternational;
    } catch (error) {
      return false;
    }
  }

  async gatherSnomedConfig(options) {
    const baseConfig = await this.gatherCommonConfig(options);

    // Try to auto-detect edition and version from RF2 files
    let autoDetected = { edition: null, version: null, editionName: null };
    if (baseConfig.source && !options.edition && !options.version && !options.uri) {
      this.logInfo('Auto-detecting edition and version from RF2 files...');
      autoDetected = await this.detectEditionAndVersion(baseConfig.source);

      if (autoDetected.edition && autoDetected.version) {
        this.logSuccess(`Detected: ${autoDetected.editionName} version ${autoDetected.version}`);
      } else if (autoDetected.version) {
        this.logInfo(`Detected version: ${autoDetected.version}`);
      }
    }

    const editions = {
      "900000000000207008": { name: "International", needsBase: false, lang: "en-US" },
      "731000124108": { name: "US Edition", needsBase: false, lang: "en-US" },
      "32506021000036107": { name: "Australian Edition", needsBase: true, lang: "en-AU" },
      "449081005": { name: "Spanish Edition (International)", needsBase: true, lang: "es" },
      "11000279109": { name: "Czech Edition", needsBase: false, lang: "cs-CZ" },
      "554471000005108": { name: "Danish Edition", needsBase: true, lang: "da-DK" },
      "11000146104": { name: "Dutch Edition", needsBase: true, lang: "nl-NL" },
      "45991000052106": { name: "Swedish Edition", needsBase: true, lang: "sv-SE" },
      "83821000000107": { name: "UK Edition", needsBase: true, lang: "en-GB" },
      "11000172109": { name: "Belgian Edition", needsBase: true, lang: "fr-BE" },
      "11000221109": { name: "Argentinian Edition", needsBase: true, lang: "es-AR" },
      "11000234105": { name: "Austrian Edition", needsBase: true, lang: "de-AT" },
      "20621000087109": { name: "Canadian Edition (English)", needsBase: true, lang: "en-CA" },
      "20611000087101": { name: "Canadian Edition (French)", needsBase: true, lang: "fr-CA" },
      "11000181102": { name: "Estonian Edition", needsBase: true, lang: "et-EE" },
      "11000229106": { name: "Finnish Edition", needsBase: true, lang: "fi-FI" },
      "11000274103": { name: "German Edition", needsBase: true, lang: "de-DE" },
      "1121000189102": { name: "Indian Edition", needsBase: true, lang: "en-IN" },
      "11000220105": { name: "Irish Edition", needsBase: true, lang: "en-IE" },
      "21000210109": { name: "New Zealand Edition", needsBase: true, lang: "en-NZ" },
      "51000202101": { name: "Norwegian Edition", needsBase: true, lang: "no-NO" },
      "11000267109": { name: "Korean Edition", needsBase: true, lang: "ko-KR" },
      "900000001000122104": { name: "Spanish Edition (Spain)", needsBase: true, lang: "es-ES" },
      "2011000195101": { name: "Swiss Edition", needsBase: true, lang: "de-CH" },
      "999000021000000109": { name: "UK Clinical Edition", needsBase: true, lang: "en-GB" },
      "5631000179106": { name: "Uruguayan Edition", needsBase: true, lang: "es-UY" },
      "21000325107": { name: "Chilean Edition", needsBase: false, lang: "es-CL" },
      "5991000124107": { name: "US Edition + ICD10CM", needsBase: true, lang: "en-US" }
    };

    const questions = [];
    const inquirer = require('inquirer');

    // Edition selection (if not provided via options and no URI override)
    if (!options.edition && !options.uri) {
      // If we auto-detected the edition, use confirm instead of list
      if (autoDetected.edition) {
        questions.push({
          type: 'confirm',
          name: 'useDetectedEdition',
          message: `Use detected edition: ${autoDetected.editionName} (${autoDetected.edition})?`,
          default: true
        });

        questions.push({
          type: 'list',
          name: 'edition',
          message: 'Select SNOMED CT Edition:',
          choices: Object.entries(editions).map(([id, info]) => ({
            name: info.name,
            value: id
          })),
          default: autoDetected.edition,
          when: (answers) => !answers.useDetectedEdition
        });
      } else {
        const editionChoices = Object.entries(editions).map(([id, info]) => ({
          name: info.name,
          value: id
        }));

        questions.push({
          type: 'list',
          name: 'edition',
          message: 'Select SNOMED CT Edition:',
          choices: editionChoices,
          default: '900000000000207008' // International edition
        });
      }
    }

    // Version in YYYYMMDD format (if not provided and no URI override)
    if (!options.version && !options.uri) {
      // If we auto-detected the version, use confirm instead of input
      if (autoDetected.version) {
        questions.push({
          type: 'confirm',
          name: 'useDetectedVersion',
          message: `Use detected version: ${autoDetected.version}?`,
          default: true
        });

        questions.push({
          type: 'input',
          name: 'version',
          message: 'Version (YYYYMMDD format, e.g., 20250801):',
          default: autoDetected.version,
          when: (answers) => !answers.useDetectedVersion,
          validate: (input) => {
            if (!input) return 'Version is required';
            if (!/^\d{8}$/.test(input)) return 'Version must be in YYYYMMDD format (8 digits)';

            const year = parseInt(input.substring(0, 4));
            const month = parseInt(input.substring(4, 6));
            const day = parseInt(input.substring(6, 8));

            if (year < 1900 || year > 2100) return 'Invalid year';
            if (month < 1 || month > 12) return 'Invalid month';
            if (day < 1 || day > 31) return 'Invalid day';

            return true;
          }
        });
      } else {
        questions.push({
          type: 'input',
          name: 'version',
          message: 'Version (YYYYMMDD format, e.g., 20250801):',
          validate: (input) => {
            if (!input) return 'Version is required';
            if (!/^\d{8}$/.test(input)) return 'Version must be in YYYYMMDD format (8 digits)';

            // Basic date validation
            const year = parseInt(input.substring(0, 4));
            const month = parseInt(input.substring(4, 6));
            const day = parseInt(input.substring(6, 8));

            if (year < 1900 || year > 2100) return 'Invalid year';
            if (month < 1 || month > 12) return 'Invalid month';
            if (day < 1 || day > 31) return 'Invalid day';

            return true;
          }
        });
      }
    }

    // Get answers for edition and version first
    const primaryAnswers = await inquirer.prompt(questions);

    // Determine the selected edition and version (use auto-detected if confirmed)
    let selectedEdition = options.edition || primaryAnswers.edition;
    let selectedVersion = options.version || primaryAnswers.version;

    // If user confirmed auto-detected values, use them
    if (primaryAnswers.useDetectedEdition !== false && autoDetected.edition && !selectedEdition) {
      selectedEdition = autoDetected.edition;
    }
    if (primaryAnswers.useDetectedVersion !== false && autoDetected.version && !selectedVersion) {
      selectedVersion = autoDetected.version;
    }

    let editionInfo = null;
    let needsBase = false;
    let autoLanguage = 'en-US';
    let autoUri = options.uri;

    // If we have edition/version (not using URI override), determine settings
    if (selectedEdition && selectedVersion && !options.uri) {
      editionInfo = editions[selectedEdition];
      if (!editionInfo) {
        throw new Error(`Unknown edition: ${selectedEdition}`);
      }
      needsBase = editionInfo.needsBase;
      autoLanguage = editionInfo.lang;
      autoUri = `http://snomed.info/sct/${selectedEdition}/version/${selectedVersion}`;
    } else if (options.uri) {
      // Try to extract edition from URI to determine if base is needed
      const uriMatch = options.uri.match(/sct\/(\d+)\/version/);
      if (uriMatch) {
        const extractedEdition = uriMatch[1];
        editionInfo = editions[extractedEdition];
        if (editionInfo) {
          needsBase = editionInfo.needsBase;
          autoLanguage = editionInfo.lang;
        }
      }
    }

    // Additional questions based on edition requirements
    const additionalQuestions = [];

    // Check if base is actually needed - modern releases often include International content
    // If we detected International module in the source, it's a combined release
    let actuallyNeedsBase = needsBase && !options.base;
    if (actuallyNeedsBase && baseConfig.source) {
      // Check if source already contains International content
      const hasInternational = await this.checkForInternationalContent(baseConfig.source);
      if (hasInternational) {
        actuallyNeedsBase = false;
        this.logInfo('Source contains International content - no base edition needed');
      }
    }

    // Base directory for extensions (only if edition needs base and not already provided)
    if (actuallyNeedsBase) {
      additionalQuestions.push({
        type: 'input',
        name: 'base',
        message: 'Base edition directory (required for this edition):',
        validate: (input) => {
          if (!input) return 'Base edition directory is required for this edition';
          if (!fs.existsSync(input)) return 'Directory does not exist';
          return true;
        }
      });
    }

    // Manual URI input if neither edition/version nor URI was provided
    if (!autoUri && !options.uri) {
      additionalQuestions.push({
        type: 'input',
        name: 'uri',
        message: 'Version URI (e.g., http://snomed.info/sct/900000000000207008/version/20240301):',
        validate: (input) => {
          if (!input) return 'Version URI is required';
          if (!input.includes('snomed.info/sct')) return 'Invalid SNOMED CT URI format';
          return true;
        }
      });
    }

    const additionalAnswers = additionalQuestions.length > 0 ?
        await inquirer.prompt(additionalQuestions) : {};

    // Build the final configuration
    const config = {
      ...baseConfig,
      ...options,
      ...primaryAnswers,
      ...additionalAnswers,
      edition: selectedEdition,
      version: selectedVersion,
      language: options.language || autoLanguage, // Allow language override
      uri: options.uri || autoUri || additionalAnswers.uri,
      estimatedDuration: this.getEstimatedDuration()
    };

    // Validate that we have all required fields
    if (!config.uri) {
      throw new Error('Version URI could not be determined');
    }

    return config;
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

  async executeImport(config) {
    this.logInfo('Starting SNOMED CT data migration...');

    const importer = new SnomedImporterWithProgress(this, config.verbose);

    await importer.import(config);
  }

  async validatePrerequisites(config) {
    const baseValid = await super.validatePrerequisites(config);

    try {
      this.logInfo('Validating SNOMED CT RF2 directory structure...');
      await this.validateSnomedDirectory(config.source);
      this.logSuccess('SNOMED CT directory structure valid');
    } catch (error) {
      this.logError(`SNOMED CT directory validation failed: ${error.message}`);
      return false;
    }

    return baseValid;
  }

  async validateSnomedDirectory(sourceDir) {
    if (!fs.existsSync(sourceDir)) {
      throw new Error(`Source directory not found: ${sourceDir}`);
    }

    const files = this.discoverRF2Files(sourceDir);

    if (files.concepts.length === 0) {
      throw new Error('No concept files found');
    }

    if (files.descriptions.length === 0) {
      throw new Error('No description files found');
    }

    if (files.relationships.length === 0) {
      throw new Error('No relationship files found');
    }

    return {
      conceptFiles: files.concepts.length,
      descriptionFiles: files.descriptions.length,
      relationshipFiles: files.relationships.length,
      refsetDirectories: files.refsetDirectories.length
    };
  }

  discoverRF2Files(dir) {
    const files = {
      concepts: [],
      descriptions: [],
      relationships: [],
      refsetDirectories: []
    };

    this._scanDirectory(dir, files);
    return files;
  }

  _scanDirectory(dir, files) {
    if (!fs.existsSync(dir)) return;

    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name === 'Refset' || entry.name === 'Reference Sets') {
          files.refsetDirectories.push(fullPath);
        } else if (!entry.name.startsWith('.')) {
          this._scanDirectory(fullPath, files);
        }
      } else if (entry.isFile() && entry.name.endsWith('.txt')) {
        this._classifyRF2File(fullPath, files);
      }
    }
  }

  _classifyRF2File(filePath, files) {
    try {
      const firstLine = this._readFirstLine(filePath);

      if (firstLine.startsWith('id\teffectiveTime\tactive\tmoduleId\tdefinitionStatusId')) {
        files.concepts.push(filePath);
      } else if (firstLine.startsWith('id\teffectiveTime\tactive\tmoduleId\tconceptId\tlanguageCode\ttypeId\tterm\tcaseSignificanceId')) {
        files.descriptions.push(filePath);
      } else if (firstLine.startsWith('id\teffectiveTime\tactive\tmoduleId\tsourceId\tdestinationId\trelationshipGroup\ttypeId\tcharacteristicTypeId\tmodifierId') &&
          !filePath.includes('StatedRelationship')) {
        files.relationships.push(filePath);
      }
    } catch (error) {
      // Ignore files we can't read
    }
  }

  _readFirstLine(filePath) {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(1000);
      const bytesRead = fs.readSync(fd, buffer, 0, 1000, 0);
      const content = buffer.toString('utf8', 0, bytesRead);
      const newlineIndex = content.indexOf('\n');
      return newlineIndex >= 0 ? content.substring(0, newlineIndex) : content;
    } finally {
      fs.closeSync(fd);
    }
  }

  async handleValidateCommand(options) {
    if (!options.source) {
      const inquirer = require('inquirer');
      const answers = await inquirer.prompt({
        type: 'input',
        name: 'source',
        message: 'Source directory to validate:',
        validate: (input) => input && fs.existsSync(input) ? true : 'Directory does not exist'
      });
      options.source = answers.source;
    }

    this.logInfo(`Validating SNOMED CT directory: ${options.source}`);

    try {
      const stats = await this.validateSnomedDirectory(options.source);

      this.logSuccess('Directory validation passed');
      console.log(`  Concept files: ${stats.conceptFiles}`);
      console.log(`  Description files: ${stats.descriptionFiles}`);
      console.log(`  Relationship files: ${stats.relationshipFiles}`);
      console.log(`  Refset directories: ${stats.refsetDirectories}`);

    } catch (error) {
      this.logError(`Validation failed: ${error.message}`);
    }
  }

  async handleStatusCommand(options) {
    const cachePath = options.dest || './data/snomed.cache';

    if (!fs.existsSync(cachePath)) {
      this.logError(`Cache file not found: ${cachePath}`);
      return;
    }

    this.logInfo(`Checking SNOMED CT cache: ${cachePath}`);

    try {
      // Load and analyze the cache file
      const { SnomedFileReader } = require('./cs-snomed-structures');
      const reader = new SnomedFileReader(cachePath);
      const data = await reader.loadSnomedData();

      this.logSuccess('Cache file status:');
      console.log(`  Cache Version: ${data.cacheVersion}`);
      console.log(`  Version URI: ${data.versionUri}`);
      console.log(`  Version Date: ${data.versionDate}`);
      console.log(`  Edition: ${data.edition}`);
      console.log(`  SNOMED Version: ${data.version}`);

      // Create structure instances to get counts
      const concepts = new SnomedConceptList(data.concept);
      const descriptions = new SnomedDescriptions(data.desc);
      const relationships = new SnomedRelationshipList(data.rel);

      console.log(`  Concepts: ${concepts.count().toLocaleString()}`);
      console.log(`  Descriptions: ${descriptions.count().toLocaleString()}`);
      console.log(`  Relationships: ${relationships.count().toLocaleString()}`);
      console.log(`  Active Roots: ${data.activeRoots.length}`);
      console.log(`  Inactive Roots: ${data.inactiveRoots.length}`);

      const fileStat = fs.statSync(cachePath);
      console.log(`  File Size: ${(fileStat.size / (1024 * 1024 * 1024)).toFixed(2)} GB`);
      console.log(`  Last Modified: ${fileStat.mtime.toISOString()}`);

    } catch (error) {
      this.logError(`Status check failed: ${error.message}`);
    }
  }
}

// Enhanced SnomedImporterWithProgress class with timing functionality

class SnomedImporterWithProgress {
  constructor(moduleInstance, verbose = true) {
    this.module = moduleInstance;
    this.verbose = verbose;
    this.currentProgressBar = null;
    this.taskStartTimes = new Map();
  }

  createTaskProgressBar(taskName) {
    if (this.currentProgressBar) {
      this.currentProgressBar.stop();
    }

    // Record start time for this task
    this.taskStartTimes.set(taskName, Date.now());

    const progressFormat = `${taskName.padEnd(22)} |{bar}| {percentage}% | {value}/{total} | ETA: {eta}s`;
    this.currentProgressBar = this.module.createProgressBar(progressFormat);
    this.currentProgressBar.taskName = taskName;

    return this.currentProgressBar;
  }

  completeTask(taskName, current, total) {
    const startTime = this.taskStartTimes.get(taskName);
    if (startTime && this.currentProgressBar) {
      const elapsedMs = Date.now() - startTime;
      const elapsedSec = (elapsedMs / 1000).toFixed(1);

      // Stop the progress bar
      this.currentProgressBar.stop();

      // Build completion message
      let message = `✓ ${taskName} completed: ${current.toLocaleString()}`;

      if (total && total !== current) {
        message += ` of ${total.toLocaleString()}`;
        // Optional warning if counts don't match
        if (current < total * 0.95) { // More than 5% difference
          message += ` (WARNING: Expected ${total.toLocaleString()})`;
        }
      }

      // Add timing info
      message += ` items in ${elapsedSec}sec`;

      // Add rate if meaningful
      if (elapsedMs > 1000 && current > 0) {
        const rate = Math.round(current / (elapsedMs / 1000));
        message += ` (${rate.toLocaleString()} items/sec)`;
      }

      console.log(message);

      // Clean up
      this.taskStartTimes.delete(taskName);
      this.currentProgressBar = null;
    }
  }

  stopCurrentProgress() {
    if (this.currentProgressBar) {
      this.currentProgressBar.stop();
      this.currentProgressBar = null;
    }
  }

  async import(config) {
    try {
      const importer = new SnomedImporter(config, this);
      await importer.run();
    } finally {
      this.stopCurrentProgress();
    }
  }
}

const IS_A_MAGIC = BigInt('116680003');
// const RF2_MAGIC_FSN = BigInt('900000000000003001');
const RF2_MAGIC_RELN_DEFINING = BigInt('900000000000011006');
const RF2_MAGIC_RELN_STATED = BigInt('900000000000010007');
const RF2_MAGIC_RELN_INFERRED = BigInt('900000000000006009');

// Reference Set field types (matching Pascal)
const FIELD_TYPE_CONCEPT = 99;  // 'c'
const FIELD_TYPE_INTEGER = 105; // 'i'
const FIELD_TYPE_STRING = 115;  // 's'

// Reference Set class to track reference sets during processing
class RefSet {
  constructor(id) {
    this.id = id;
    this.title = '';
    this.filename = '';
    this.index = 0;
    this.isLangRefset = false;
    this.noStoreIds = false;
    this.langs = 0;
    this.members = [];
    this.membersByRef = 0;
    this.membersByName = 0;
    this.fieldTypes = 0;
    this.fieldNames = 0;

    // Fast lookup index
    this.memberLookup = new Map(); // componentRef -> member.values
  }

  addMember(member) {
    this.members.push(member);
    // Build lookup index as we add members
    this.memberLookup.set(member.ref, member.values || 0);
  }

  // Fast O(1) lookup method
  getMemberValues(componentRef) {
    return this.memberLookup.get(componentRef) || null;
  }

  // Check if component is a member (O(1))
  hasMember(componentRef) {
    return this.memberLookup.has(componentRef);
  }
}

// Reference Set Member structure
class RefSetMember {
  constructor() {
    this.id = null; // GUID buffer or null
    this.kind = 0; // 0=concept, 1=description, 2=relationship, 3=other
    this.ref = 0; // Reference to the component
    this.module = 0; // Module concept index
    this.date = 0; // SNOMED date
    this.values = 0; // Index to additional field values
  }
}

class ConceptTracker {
  constructor() {
    this.activeParents = [];
    this.inactiveParents = [];
    this.inbounds = [];
    this.outbounds = [];
    this.descriptions = [];
  }

  addActiveParent(index) {
    this.activeParents.push(index);
  }

  addInactiveParent(index) {
    this.inactiveParents.push(index);
  }

  addInbound(index) {
    this.inbounds.push(index);
  }

  addOutbound(index) {
    this.outbounds.push(index);
  }

  addDescription(index) {
    this.descriptions.push(index);
  }
}


// Main SNOMED CT importer class
class SnomedImporter {
  static LANGUAGE_STEMMERS = {
    'en': natural.PorterStemmer,        // English
    'en-US': natural.PorterStemmer,     // English (US)
    'en-GB': natural.PorterStemmer,     // English (GB)
    'fr': natural.PorterStemmerFr,      // French
    'es': natural.PorterStemmerEs,      // Spanish
    'it': natural.PorterStemmerIt,      // Italian
    'pt': natural.PorterStemmerPt,      // Portuguese
    'nl': natural.PorterStemmerNl,      // Dutch
    'no': natural.PorterStemmerNo,      // Norwegian
    'ru': natural.PorterStemmerRu,      // Russian
    'sv': natural.PorterStemmer,        // Swedish (fallback to English)
    'da': natural.PorterStemmer,        // Danish (fallback to English)
    'de': natural.PorterStemmer         // German (fallback to English)
  };

  // Word flags (matching Pascal constants)
  static FLAG_WORD_DEP = 1;    // Word appears in active descriptions
  static FLAG_WORD_FSN = 2;    // Word appears in FSN (Fully Specified Name)

  constructor(config, progressReporter = null) {
    this.config = config;
    this.progressReporter = progressReporter;

    // Initialize data structures
    this.strings = new SnomedStrings();
    this.words = new SnomedWords();
    this.stems = new SnomedStems();
    this.refs = new SnomedReferences();
    this.descriptions = new SnomedDescriptions();
    this.descriptionIndex = new SnomedDescriptionIndex();
    this.concepts = new SnomedConceptList();
    this.relationships = new SnomedRelationshipList();
    this.refsetMembers = new SnomedReferenceSetMembers();
    this.refsetIndex = new SnomedReferenceSetIndex();

    // Working data
    this.conceptMap = new Map(); // UInt64 -> concept data
    this.conceptList = [];
    this.stringCache = new Map();
    this.relationshipMap = new Map();
    this.conceptTrackers = new Map(); // conceptIndex -> ConceptTracker
    this.refSets = new Map();
    this.refSetTypes = new Map();
    this.processedRefSetCount = 0;

    this.isAIndex = null;
    this.isTesting = false;

    // File lists
    this.files = null;
    this.building = true; // Set to true during import
    this.depthProcessedCount = 0; // Track depth processing for progress
  }

  async run() {
    try {

      // Discover files
      this.files = this.discoverFiles();

      // Initialize builders
      this.strings.startBuild();
      this.refs.startBuild();
      this.descriptions.startBuild();
      this.concepts.startBuild();
      this.relationships.startBuild();
      this.refsetIndex.startBuild();
      this.refsetMembers.startBuild();

      // Step 1: Read concepts
      await this.readConcepts();

      // Step 2: Sort concepts
      this.sortConcepts();

      // Step 3: Build concept cache
      this.buildConceptCache();

      // Step 4: Read descriptions
      await this.readDescriptions();

      // Step 5: Sort descriptions
      this.sortDescriptions();

      // Step 6: Build description cache
      this.buildDescriptionCache();

      // Step 7-9: Process words and stems
      this.processWords();

      // Step 10: Read relationships
      await this.readRelationships();

      // Step 10a: Read alternate identifiers (e.g. the LOINC codes of the LOINC Extension)
      await this.readIdentifiers();

      // Step 11: Link concepts
      this.linkConcepts();

      // Step 13-15: Reference sets
      await this.processRefsets();

      // Step 12: Build closure
      this.buildClosure();

      // Step 16: Set depths
      this.setDepths();

      // Step 17: Normal forms
      this.buildNormalForms();

      // Step 18: Save
      await this.saveCache();

    } catch (error) {
      console.error('DEBUG: Import failed with error:', error);
      throw new Error(`Import failed: ${error.message}`);
    }
  }

  discoverFiles() {
    const files = {
      concepts: [],
      descriptions: [],
      relationships: [],
      identifiers: [],
      refsetDirectories: []
    };

    // For extensions: load base edition files first so that all International
    // Edition concepts, descriptions, and relationships are present before the
    // extension content is layered on top.
    if (this.config.base) {
      if (this.config.verbose) {
        console.log(`Loading base edition from: ${this.config.base}`);
      }
      this._scanDirectory(this.config.base, files);
    }

    // Then load the extension (or standalone edition) source files.
    // For extensions these come second so that extension rows can override
    // base rows where the same component has been updated.
    this._scanDirectory(this.config.source, files);
    return files;
  }

  _scanDirectory(dir, files) {
    if (!fs.existsSync(dir)) {
      return;
    }

    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name === 'Refset' || entry.name === 'Reference Sets') {
          files.refsetDirectories.push(fullPath);
        } else if (!entry.name.startsWith('.')) {
          this._scanDirectory(fullPath, files);
        }
      } else if (entry.isFile() && entry.name.endsWith('.txt')) {
        this._classifyRF2File(fullPath, files);
      }
    }
  }

  _classifyRF2File(filePath, files) {
    try {
      const firstLine = this._readFirstLine(filePath);

      if (firstLine.startsWith('id\teffectiveTime\tactive\tmoduleId\tdefinitionStatusId')) {
        files.concepts.push(filePath);
      } else if (firstLine.startsWith('id\teffectiveTime\tactive\tmoduleId\tconceptId\tlanguageCode\ttypeId\tterm\tcaseSignificanceId')) {
        files.descriptions.push(filePath);
      } else if (firstLine.startsWith('id\teffectiveTime\tactive\tmoduleId\tsourceId\tdestinationId\trelationshipGroup\ttypeId\tcharacteristicTypeId\tmodifierId') &&
          !filePath.includes('StatedRelationship')) {
        files.relationships.push(filePath);
      } else if (files.identifiers && firstLine.startsWith('alternateIdentifier\teffectiveTime\tactive\tmoduleId\tidentifierSchemeId\treferencedComponentId')) {
        files.identifiers.push(filePath);
      }
    } catch (error) {
      console.log(`DEBUG: Error reading file ${filePath}: ${error.message}`);
    }
  }

  _readFirstLine(filePath) {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(1000);
      const bytesRead = fs.readSync(fd, buffer, 0, 1000, 0);
      const content = buffer.toString('utf8', 0, bytesRead);
      const newlineIndex = content.indexOf('\n');
      return newlineIndex >= 0 ? content.substring(0, newlineIndex) : content;
    } finally {
      fs.closeSync(fd);
    }
  }

  addString(str) {
    if (!this.stringCache.has(str)) {
      const offset = this.strings.addString(str);
      this.stringCache.set(str, offset);
      return offset;
    }
    return this.stringCache.get(str);
  }

  async readConcepts() {
    // First, estimate total lines for progress bar
    let totalLines = 0;
    for (const file of this.files.concepts) {
      try {
        const lineCount = await this.countLines(file);
        totalLines += Math.max(0, lineCount - 1); // Subtract 1 for header
      } catch (error) {
        // Use rough estimate if we can't count
        totalLines += 100000;
      }
    }

    // Create progress bar for this task
    const progressBar = this.progressReporter?.createTaskProgressBar('Reading Concepts');
    progressBar?.start(totalLines, 0);

    this.conceptList = [];
    let processedLines = 0;

    // When loading base + extension, track list indices for fast replacement
    const conceptIdToListIndex = this.config.base ? new Map() : null;

    for (let i = 0; i < this.files.concepts.length; i++) {
      const file = this.files.concepts[i];
      const rl = readline.createInterface({
        input: fs.createReadStream(file),
        crlfDelay: Infinity
      });

      let lineCount = 0;
      for await (const line of rl) {
        lineCount++;
        if (lineCount === 1) continue; // Skip header

        // Parse RF2 concept line: id, effectiveTime, active, moduleId, definitionStatusId
        const parts = line.split('\t');
        if (parts.length >= 5) {
          const concept = {
            id: BigInt(parts[0]),
            effectiveTime: parts[1],
            active: parts[2] === '1',
            moduleId: BigInt(parts[3]),
            definitionStatusId: BigInt(parts[4]),
            index: 0 // Will be set later
          };

          if (this.conceptMap.has(concept.id)) {
            // When loading base + extension, the same concept may appear in both.
            // The extension snapshot row takes precedence (it is loaded second).
            // If there is no base directory this is a genuine duplicate in a single
            // snapshot and we should still raise an error.
            if (!this.config.base) {
              throw new Error(`Duplicate Concept Id at line ${lineCount}: ${concept.id} - check you are processing the snapshot not the full edition`);
            }
            // Replace the base edition row with the extension row
            const idx = conceptIdToListIndex.get(concept.id);
            if (idx !== undefined) {
              this.conceptList[idx] = concept;
            }
            this.conceptMap.set(concept.id, concept);
          } else {
            if (conceptIdToListIndex) {
              conceptIdToListIndex.set(concept.id, this.conceptList.length);
            }
            this.conceptList.push(concept);
            this.conceptMap.set(concept.id, concept);
          }
        }

        this.isTesting = this.conceptMap.has(BigInt(31000003106));

        processedLines++;
        if (processedLines % 1000 === 0) {
          progressBar?.update(processedLines);
        }
      }
    }

    // Use completeTask instead of manual update
    if (this.progressReporter) {
      this.progressReporter.completeTask('Reading Concepts', processedLines, totalLines);
    }
  }

  sortConcepts() {
    this.conceptList.sort((a, b) => {
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    });
  }

  buildConceptCache() {
    const progressBar = this.progressReporter?.createTaskProgressBar('Building Concepts');
    progressBar?.start(this.conceptList.length, 0);

    for (let i = 0; i < this.conceptList.length; i++) {
      const concept = this.conceptList[i];
      // Bits 0-3 are the status (MASK_CONCEPT_STATUS); bit 4 (MASK_CONCEPT_PRIMITIVE) says the
      // concept is primitive. Without the primitive bit every concept looks fully defined, and
      // normal form generation then runs for concepts that have no definition to expand.
      let flags = concept.active ? 0 : 1;
      if (concept.definitionStatusId === SNOMED_DEFINITION_STATUS_PRIMITIVE) {
        flags |= SnomedConceptList.MASK_CONCEPT_PRIMITIVE;
      }
      const effectiveTime = this.convertDateToSnomedDate(concept.effectiveTime);

      concept.index = this.concepts.addConcept(concept.id, effectiveTime, flags);
      concept.stems = []; // Initialize stems array

      if (i % 1000 === 0) {
        progressBar?.update(i);
      }
    }

    this.concepts.doneBuild();

    if (this.progressReporter) {
      this.progressReporter.completeTask('Building Concepts', this.conceptList.length, this.conceptList.length);
    }
  }

  async readDescriptions() {
    // Estimate total lines
    let totalLines = 0;
    for (const file of this.files.descriptions) {
      try {
        const lineCount = await this.countLines(file);
        totalLines += Math.max(0, lineCount - 1);
      } catch (error) {
        totalLines += 100000;
      }
    }

    const progressBar = this.progressReporter?.createTaskProgressBar('Reading Descriptions');
    progressBar?.start(totalLines, 0);

    const descriptionList = [];
    let processedLines = 0;

    // Build a lookup from description id -> index in descriptionList so that
    // extension rows can replace base rows for the same description.
    if (this.config.base) {
      this._descriptionIdSet = new Map();
    }

    for (const file of this.files.descriptions) {
      const rl = readline.createInterface({
        input: fs.createReadStream(file),
        crlfDelay: Infinity
      });

      let lineCount = 0;
      for await (const line of rl) {
        lineCount++;
        if (lineCount === 1) continue;

        const parts = line.split('\t');
        if (parts.length >= 9) {
          const desc = {
            id: BigInt(parts[0]),
            effectiveTime: parts[1],
            active: parts[2] === '1',
            moduleId: BigInt(parts[3]),
            conceptId: BigInt(parts[4]),
            languageCode: parts[5],
            typeId: BigInt(parts[6]),
            term: parts[7],
            caseSignificanceId: BigInt(parts[8])
          };

          // When loading base + extension, the same description may appear in
          // both.  The extension row (loaded second) takes precedence.
          if (this.config.base && this._descriptionIdSet) {
            const existingIdx = this._descriptionIdSet.get(desc.id);
            if (existingIdx !== undefined) {
              descriptionList[existingIdx] = desc;
            } else {
              this._descriptionIdSet.set(desc.id, descriptionList.length);
              descriptionList.push(desc);
            }
          } else {
            descriptionList.push(desc);
          }
        }

        processedLines++;
        if (processedLines % 1000 === 0) {
          progressBar?.update(processedLines);
        }
      }
    }

    this.descriptionList = descriptionList;

    if (this.progressReporter) {
      this.progressReporter.completeTask('Reading Descriptions', processedLines, totalLines);
    }
  }

  sortDescriptions() {
    // Sort by ID for indexing
    this.descriptionList.sort((a, b) => {
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    });
  }

  buildDescriptionCache() {
    const progressBar = this.progressReporter?.createTaskProgressBar('Building Descriptions');
    progressBar?.start(this.descriptionList.length, 0);

    const indexEntries = [];

    for (let i = 0; i < this.descriptionList.length; i++) {
      const desc = this.descriptionList[i];
      const concept = this.conceptMap.get(desc.conceptId);

      if (concept) {
        const termOffset = this.addString(desc.term);
        const effectiveTime = this.convertDateToSnomedDate(desc.effectiveTime);
        const lang = this.mapLanguageCode(desc.languageCode);
        const kind = this.conceptMap.get(desc.typeId);
        const module = this.conceptMap.get(desc.moduleId);
        const caps = this.conceptMap.get(desc.caseSignificanceId);

        const descOffset = this.descriptions.addDescription(
            termOffset, desc.id, effectiveTime, concept.index,
            module.index, kind.index, caps.index, desc.active, lang
        );

        // Track description on concept
        const conceptTracker = this.getOrCreateConceptTracker(concept.index);
        conceptTracker.addDescription(descOffset);

        indexEntries.push({ id: desc.id, offset: descOffset });
      }

      if (i % 1000 === 0) {
        progressBar?.update(i);
      }
    }

    this.descriptions.doneBuild();

    // Build description index
    this.descriptionIndex.startBuild();
    indexEntries.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    for (const entry of indexEntries) {
      this.descriptionIndex.addDescription(entry.id, entry.offset);
    }
    this.descriptionIndex.doneBuild();

    if (this.progressReporter) {
      this.progressReporter.completeTask('Building Descriptions', this.descriptionList.length, this.descriptionList.length);
    }
  }

  // Convert YYYYMMDD format to 16-bit SNOMED date (days since December 30, 1899)
  convertDateToSnomedDate(dateStr) {
    if (!dateStr || dateStr.length !== 8) {
      return 0;
    }

    const year = parseInt(dateStr.substring(0, 4));
    const month = parseInt(dateStr.substring(4, 6));
    const day = parseInt(dateStr.substring(6, 8));

    // Create target date
    const targetDate = new Date(year, month - 1, day);

    // Pascal TDateTime epoch: December 30, 1899
    const pascalEpoch = new Date(1899, 11, 30); // Month is 0-based in JS

    // Calculate days difference
    const daysDiff = Math.floor((targetDate - pascalEpoch) / (1000 * 60 * 60 * 24));

    // Ensure it fits in 16 bits (0-65535) and is positive
    if (daysDiff < 0 || daysDiff > 65535) {
      throw new Error(`Date ${dateStr} converts to ${daysDiff}, which is out of 16-bit range`);
    }

    return daysDiff;
  }

  mapLanguageCode(code) {
    // Map language codes to bytes - simplified
    const langMap = {
      'en': 1,
      'en-US': 1,
      'en-GB': 1,
      'fr': 2,
      'nl': 3,
      'es': 4,
      'sv': 5,
      'da': 6,
      'de': 7,
      'it': 8,
      'cs': 9
    };
    return langMap[code] || 1;
  }

  processWords() {
    const progressBar = this.progressReporter?.createTaskProgressBar('Processing Words');
    progressBar?.start(this.descriptionList.length, 0);

    // Maps to track words and stems
    const wordMap = new Map(); // word -> {flags, stem, conceptSet}
    const stemMap = new Map(); // stem -> Set of concept list positions (not concept.index!)

    // Create a map from concept.index to conceptList position for fast lookup
    const conceptIndexToPosition = new Map();
    for (let i = 0; i < this.conceptList.length; i++) {
      conceptIndexToPosition.set(this.conceptList[i].index, i);
    }

    // Process each description to extract words
    for (let i = 0; i < this.descriptionList.length; i++) {
      const desc = this.descriptionList[i];
      const concept = this.conceptMap.get(desc.conceptId);

      if (concept) {
        const isActive = desc.active;
        const isFSN = desc.typeId === BigInt('900000000000003001'); // RF2_MAGIC_FSN

        // Use concept list position instead of concept.index
        const conceptPosition = conceptIndexToPosition.get(concept.index);
        if (conceptPosition !== undefined) {
          this.extractWords(desc.term, desc.languageCode, conceptPosition, isActive, isFSN, wordMap, stemMap);
        }
      }

      if (i % 1000 === 0) {
        progressBar?.update(i);
      }
    }

    if (this.progressReporter) {
      this.progressReporter.completeTask('Processing Words', this.descriptionList.length, this.descriptionList.length);
    }

    // Build words index
    const wordsProgressBar = this.progressReporter?.createTaskProgressBar('Building Words Index');
    wordsProgressBar?.start(wordMap.size, 0);

    this.words.startBuild();
    let wordIndex = 0;

    for (const [word, wordData] of wordMap) {
      // Reverse the DEP flag like Pascal does (xor with FLAG_WORD_DEP)
      const flags = wordData.flags ^ SnomedImporter.FLAG_WORD_DEP;
      this.words.addWord(this.addString(word), flags);

      if (wordIndex % 1000 === 0) {
        wordsProgressBar?.update(wordIndex);
      }
      wordIndex++;
    }

    this.words.doneBuild();

    if (this.progressReporter) {
      this.progressReporter.completeTask('Building Words Index', wordMap.size, wordMap.size);
    }

    // Build stems index
    const stemsProgressBar = this.progressReporter?.createTaskProgressBar('Building Stems Index');
    stemsProgressBar?.start(stemMap.size, 0);

    this.stems.startBuild();
    let stemIndex = 0;

    for (const [stem, conceptPositionSet] of stemMap) {
      // Convert concept positions to concept indices for the final index
      const conceptIndices = Array.from(conceptPositionSet).map(pos => this.conceptList[pos].index);
      const stemStringIndex = this.addString(stem);
      const conceptRefsIndex = this.refs.addReferences(conceptIndices);

      this.stems.addStem(stemStringIndex, conceptRefsIndex);

      // Add stem references back to concepts - NOW USING DIRECT ARRAY ACCESS!
      for (const conceptPosition of conceptPositionSet) {
        const conceptObj = this.conceptList[conceptPosition]; // O(1) lookup!
        if (!conceptObj.stems) {
          conceptObj.stems = [];
        }
        conceptObj.stems.push(stemStringIndex);
      }

      if (stemIndex % 1000 === 0) {
        stemsProgressBar?.update(stemIndex);
      }
      stemIndex++;
    }

    this.stems.doneBuild();

    if (this.progressReporter) {
      this.progressReporter.completeTask('Building Stems Index', stemMap.size, stemMap.size);
    }

    // Mark stems on concepts
    const markingStemsBar = this.progressReporter?.createTaskProgressBar('Marking Stems');
    markingStemsBar?.start(this.conceptList.length, 0);

    for (let i = 0; i < this.conceptList.length; i++) {
      const concept = this.conceptList[i];

      if (concept.stems && concept.stems.length > 0) {
        // Sort stems and add to concept
        concept.stems.sort((a, b) => a - b);
        const stemsRefsIndex = this.refs.addReferences(concept.stems);
        this.concepts.setStems(concept.index, stemsRefsIndex);
      }

      if (i % 1000 === 0) {
        markingStemsBar?.update(i);
      }
    }

    if (this.progressReporter) {
      this.progressReporter.completeTask('Marking Stems', this.conceptList.length, this.conceptList.length);
    }
  }

  // Add this new method to extract words from description text:
  extractWords(text, languageCode, conceptPosition, isActive, isFSN, wordMap, stemMap) {
    // Get appropriate stemmer for language
    const stemmer = SnomedImporter.LANGUAGE_STEMMERS[languageCode] || natural.PorterStemmer;

    // Split text on punctuation and whitespace (matching Pascal logic)
    const separators = /[,\s:.!@#$%^&*(){}[\]|\\;"<>?/~`\-_+=]+/;
    const words = text.split(separators);

    for (let word of words) {
      word = word.trim().toLowerCase();

      // Filter words (matching Pascal conditions)
      if (!word || this.isInteger(word) || word.length <= 2) {
        continue;
      }

      // Get or create word entry
      let wordData = wordMap.get(word);
      if (!wordData) {
        const stem = stemmer.stem(word);
        wordData = {
          flags: 0,
          stem: stem,
          conceptSet: new Set()
        };
        wordMap.set(word, wordData);
      }

      // Update word flags
      if (isFSN) {
        wordData.flags |= SnomedImporter.FLAG_WORD_FSN;
      }
      if (isActive) {
        wordData.flags |= SnomedImporter.FLAG_WORD_DEP; // Will be reversed later like Pascal
      }

      // Add concept position to stem mapping (not concept.index!)
      let stemConceptSet = stemMap.get(wordData.stem);
      if (!stemConceptSet) {
        stemConceptSet = new Set();
        stemMap.set(wordData.stem, stemConceptSet);
      }
      stemConceptSet.add(conceptPosition);
    }
  }

  // Helper method to check if string is an integer
  isInteger(str) {
    return /^\d+$/.test(str);
  }

  /**
   * Read the alternate identifier files (sct2_Identifier). Each active row gives a
   * concept a code in another scheme - the LOINC Extension, for instance, gives each
   * of its concepts its LOINC code (scheme 30051010000102 |LOINC code identifier|).
   * Kept as [scheme, module, code, conceptId] for the concepts in this edition; where
   * a row appears more than once (Full files, or base + extension) the latest wins.
   */
  async readIdentifiers() {
    const rows = new Map(); // scheme|code|concept -> {effectiveTime, active, row}
    for (const file of this.files.identifiers || []) {
      const rl = readline.createInterface({
        input: fs.createReadStream(file),
        crlfDelay: Infinity
      });
      let lineCount = 0;
      for await (const line of rl) {
        lineCount++;
        if (lineCount === 1 || !line) continue;
        const parts = line.split('\t');
        if (parts.length < 6) continue;
        const [code, effectiveTime, active, moduleId, schemeId, conceptId] = parts.map(p => p.trim());
        const key = schemeId + '|' + code + '|' + conceptId;
        const prior = rows.get(key);
        if (!prior || prior.effectiveTime <= effectiveTime) {
          rows.set(key, { effectiveTime, active: active === '1', row: [schemeId, moduleId, code, conceptId] });
        }
      }
    }
    this.identifiers = [];
    let missing = 0;
    for (const r of rows.values()) {
      if (!r.active) continue;
      let known = false;
      try {
        known = this.conceptMap.has(BigInt(r.row[3]));
      } catch {
        known = false;
      }
      if (known) {
        this.identifiers.push(r.row);
      } else {
        missing++;
      }
    }
    this.identifiers.sort((a, b) => (a.join('|') < b.join('|') ? -1 : 1));
    if (this.identifiers.length > 0 || missing > 0) {
      console.log(`Alternate identifiers: ${this.identifiers.length}${missing ? ` (${missing} for concepts not in this edition, ignored)` : ''}`);
    }
  }

  async readRelationships() {
    // Estimate total lines
    let totalLines = 0;
    for (const file of this.files.relationships) {
      try {
        const lineCount = await this.countLines(file);
        totalLines += Math.max(0, lineCount - 1);
      } catch (error) {
        totalLines += 100000;
      }
    }

    const progressBar = this.progressReporter?.createTaskProgressBar('Reading Relationships');
    progressBar?.start(totalLines, 0);

    let processedLines = 0;

    // Find the is-a concept index
    const isAConcept = this.conceptMap.get(IS_A_MAGIC);
    if (!isAConcept) {
      throw new Error('Is-a concept not found (116680003)');
    }
    this.isAIndex = isAConcept.index;

    // Pass 1: collect all relationship rows, deduplicating so that extension
    // rows (loaded second) override base rows with the same relationship id.
    const relationshipRows = [];
    const relationshipIdMap = this.config.base ? new Map() : null; // id -> index in relationshipRows

    for (const file of this.files.relationships) {
      const rl = readline.createInterface({
        input: fs.createReadStream(file),
        crlfDelay: Infinity
      });

      let lineCount = 0;
      for await (const line of rl) {
        lineCount++;
        if (lineCount === 1) continue;

        const parts = line.split('\t');
        if (parts.length >= 10) {
          const rel = {
            id: BigInt(parts[0]),
            effectiveTime: parts[1],
            active: parts[2] === '1',
            moduleId: BigInt(parts[3]),
            sourceId: BigInt(parts[4]),
            destinationId: BigInt(parts[5]),
            relationshipGroup: parseInt(parts[6]),
            typeId: BigInt(parts[7]),
            characteristicTypeId: BigInt(parts[8]),
            modifierId: BigInt(parts[9])
          };

          if (relationshipIdMap) {
            const existingIdx = relationshipIdMap.get(rel.id);
            if (existingIdx !== undefined) {
              relationshipRows[existingIdx] = rel;
            } else {
              relationshipIdMap.set(rel.id, relationshipRows.length);
              relationshipRows.push(rel);
            }
          } else {
            relationshipRows.push(rel);
          }
        }

        processedLines++;
        if (processedLines % 1000 === 0) {
          progressBar?.update(processedLines);
        }
      }
    }

    if (this.progressReporter) {
      this.progressReporter.completeTask('Reading Relationships', processedLines, totalLines);
    }

    // Pass 2: process the deduplicated relationship rows into the binary
    // structures and concept trackers.
    const buildProgressBar = this.progressReporter?.createTaskProgressBar('Building Relationships');
    buildProgressBar?.start(relationshipRows.length, 0);

    for (let i = 0; i < relationshipRows.length; i++) {
      const rel = relationshipRows[i];

      const source = this.conceptMap.get(rel.sourceId);
      const destination = this.conceptMap.get(rel.destinationId);
      const type = this.conceptMap.get(rel.typeId);

      if (source && destination && type) {
        const effectiveTime = this.convertDateToSnomedDate(rel.effectiveTime);

        // Check if this is a defining relationship
        const defining = rel.characteristicTypeId === RF2_MAGIC_RELN_DEFINING ||
            rel.characteristicTypeId === RF2_MAGIC_RELN_STATED ||
            rel.characteristicTypeId === RF2_MAGIC_RELN_INFERRED;

        const relationshipIndex = this.relationships.addRelationship(
            rel.id, source.index, destination.index, type.index,
            0, 0, 0, effectiveTime, rel.active, defining, rel.relationshipGroup
        );

        // Track parent/child relationships for is-a relationships
        if (type.index === this.isAIndex && defining) {
          const sourceTracker = this.getOrCreateConceptTracker(source.index);
          if (rel.active) {
            sourceTracker.addActiveParent(destination.index);
          } else {
            sourceTracker.addInactiveParent(destination.index);
          }
        }

        // Track inbound/outbound relationships
        const sourceTracker = this.getOrCreateConceptTracker(source.index);
        const destTracker = this.getOrCreateConceptTracker(destination.index);

        sourceTracker.addOutbound(relationshipIndex);
        destTracker.addInbound(relationshipIndex);
      }

      if (i % 1000 === 0) {
        buildProgressBar?.update(i);
      }
    }

    this.relationships.doneBuild();

    if (this.progressReporter) {
      this.progressReporter.completeTask('Building Relationships', relationshipRows.length, relationshipRows.length);
    }
  }

  getOrCreateConceptTracker(conceptIndex) {
    if (!this.conceptTrackers.has(conceptIndex)) {
      this.conceptTrackers.set(conceptIndex, new ConceptTracker());
    }
    return this.conceptTrackers.get(conceptIndex);
  }

  linkConcepts() {
    const progressBar = this.progressReporter?.createTaskProgressBar('Cross-Link Concepts');
    progressBar?.start(this.conceptList.length, 0);

    const activeRoots = [];
    const inactiveRoots = [];

    for (let i = 0; i < this.conceptList.length; i++) {
      const concept = this.conceptList[i];
      const tracker = this.conceptTrackers.get(concept.index);

      // Verify concept exists in concept list
      const foundConcept = this.concepts.findConcept(concept.id);
      if (!foundConcept.found) {
        throw new Error(`Import error: concept ${concept.id} not found`);
      }
      if (foundConcept.index !== concept.index) {
        throw new Error(`Import error: concept ${concept.id} index mismatch (${foundConcept.index} vs ${concept.index})`);
      }

      if (tracker) {
        // Set parents if concept has any
        if (tracker.activeParents.length > 0 || tracker.inactiveParents.length > 0) {
          const activeParentsRef = tracker.activeParents.length > 0 ?
              this.refs.addReferences(tracker.activeParents) : 0;
          const inactiveParentsRef = tracker.inactiveParents.length > 0 ?
              this.refs.addReferences(tracker.inactiveParents) : 0;

          this.concepts.setParents(concept.index, activeParentsRef, inactiveParentsRef);
        } else {
          // Concept has no parents - it's a root
          if (concept.active) {
            activeRoots.push(concept.id);
          } else {
            inactiveRoots.push(concept.id);
          }
        }

        // Set descriptions
        if (tracker.descriptions.length > 0) {
          const descriptionsRef = this.refs.addReferences(tracker.descriptions);
          this.concepts.setDescriptions(concept.index, descriptionsRef);
        }

        // Set inbound relationships (sorted)
        if (tracker.inbounds.length > 0) {
          const sortedInbounds = this.sortRelationshipArray(tracker.inbounds);
          const inboundsRef = this.refs.addReferences(sortedInbounds);
          this.concepts.setInbounds(concept.index, inboundsRef);
        }

        // Set outbound relationships (sorted)
        if (tracker.outbounds.length > 0) {
          const sortedOutbounds = this.sortRelationshipArray(tracker.outbounds);
          const outboundsRef = this.refs.addReferences(sortedOutbounds);
          this.concepts.setOutbounds(concept.index, outboundsRef);
        }
      } else {
        // Concept has no relationships - likely a root
        if (concept.active) {
          activeRoots.push(concept.id);
        } else {
          inactiveRoots.push(concept.id);
        }
      }

      if (i % 1000 === 0) {
        progressBar?.update(i);
      }
    }

    if (activeRoots.length === 0) {
      throw new Error('No active root concepts found');
    }

    this.activeRoots = activeRoots;
    this.inactiveRoots = inactiveRoots;

    if (this.progressReporter) {
      this.progressReporter.completeTask('Cross-Link Concepts', this.conceptList.length, this.conceptList.length);
    }
  }

  // Sort relationship array (simplified version for now)
  sortRelationshipArray(relationshipArray) {
    // Create a copy and sort by relationship index
    const sorted = [...relationshipArray];
    sorted.sort((a, b) => a - b);
    return sorted;
  }

  buildClosure() {
    const progressBar = this.progressReporter?.createTaskProgressBar('Building Closure');
    progressBar?.start(this.conceptList.length, 0);

    let totalProcessedClosureCount = 0;

    for (let i = 0; i < this.conceptList.length; i++) {
      const concept = this.conceptList[i];
      this.buildConceptClosure(concept.index);
      totalProcessedClosureCount++;

      if (totalProcessedClosureCount % 1000 === 0) {
        progressBar?.update(totalProcessedClosureCount);
      }
    }

    if (this.progressReporter) {
      this.progressReporter.completeTask('Building Closure', this.conceptList.length, this.conceptList.length);
    }
  }

  // Build closure for a single concept
  buildConceptClosure(conceptIndex) {
    const MAGIC_NO_CHILDREN = 0xFFFFFFFF;
    const MAGIC_IN_PROGRESS = 0xFFFFFFFE; // One less than MAGIC_NO_CHILDREN

    // Check if already processed
    const existingClosure = this.concepts.getAllDesc(conceptIndex);
    if (existingClosure === MAGIC_IN_PROGRESS) {
      throw new Error(`Circular relationship detected at concept ${conceptIndex}`);
    }
    if (existingClosure !== 0) {
      return; // Already processed
    }

    // Mark as in progress
    this.concepts.setAllDesc(conceptIndex, MAGIC_IN_PROGRESS);

    // Get children (concepts that have this concept as parent)
    const children = this.listChildren(conceptIndex);

    if (children.length === 0) {
      // Leaf concept - no descendants
      this.concepts.setAllDesc(conceptIndex, MAGIC_NO_CHILDREN);
      return;
    }

    // Recursively build closure for all children
    const allDescendants = new Set();

    for (const childIndex of children) {
      // Build closure for child first
      this.buildConceptClosure(childIndex);

      // Add child itself
      allDescendants.add(childIndex);

      // Add child's descendants
      const childClosure = this.concepts.getAllDesc(childIndex);
      if (childClosure !== 0 && childClosure !== MAGIC_NO_CHILDREN) {
        const childDescendants = this.refs.getReferences(childClosure);
        if (childDescendants) {
          for (const descendant of childDescendants) {
            allDescendants.add(descendant);
          }
        }
      }
    }

    // Convert to sorted array
    const descendantsArray = Array.from(allDescendants).sort((a, b) => a - b);

    // Store closure
    const closureRef = this.refs.addReferences(descendantsArray);
    this.concepts.setAllDesc(conceptIndex, closureRef);
  }

  // Get direct children of a concept (concepts that have this as an active parent)
  getConceptChildren(conceptIndex) {
    const children = [];

    // Get inbound relationships for this concept
    const inboundsRef = this.concepts.getInbounds(conceptIndex);
    if (inboundsRef !== 0) {
      const inbounds = this.refs.getReferences(inboundsRef);
      if (inbounds) {
        for (const relIndex of inbounds) {
          const rel = this.relationships.getRelationship(relIndex);

          // Check if this is an active is-a relationship where this concept is the target
          if (rel.relType === this.isAIndex && rel.active && rel.defining) {
            children.push(rel.source);
          }
        }
      }
    }

    return children;
  }

  // Set concept depths starting from roots (matches Pascal SetDepths)
  setDepths() {
    const progressBar = this.progressReporter?.createTaskProgressBar('Setting Depths');
    // We'll process all concepts, not just roots, since recursion touches many concepts
    progressBar?.start(this.conceptList.length, 0);

    this.depthProcessedCount = 0;

    // Process each active root concept
    for (const rootId of this.activeRoots) {
      const foundConcept = this.concepts.findConcept(rootId);
      if (foundConcept.found) {
        this.setDepth(foundConcept.index, 0);
      }
    }

    if (this.progressReporter) {
      this.progressReporter.completeTask('Setting Depths', this.depthProcessedCount, this.conceptList.length);
    }
  }

  // Recursively set depth for a concept and its children (matches Pascal SetDepth)
  setDepth(conceptIndex, depth) {
    const currentDepth = this.concepts.getDepth(conceptIndex);

    // Only update if this is the first time we've reached this concept (depth = 0)
    // or we've found a shorter path (current depth > new depth)
    if (currentDepth === 0 || currentDepth > depth) {
      this.concepts.setDepth(conceptIndex, depth);

      if (depth >= 255) {
        throw new Error('Concept hierarchy too deep');
      }

      // Count this concept as processed
      this.depthProcessedCount++;
      if (this.depthProcessedCount % 10000 === 0) {
        // Update progress less frequently during recursion to avoid spam
        if (this.progressReporter && this.progressReporter.currentProgressBar) {
          this.progressReporter.currentProgressBar.update(this.depthProcessedCount);
        }
      }

      // Increment depth for children
      const nextDepth = depth + 1;

      // Get children and recursively set their depths
      const children = this.listChildren(conceptIndex);
      for (const childIndex of children) {
        this.setDepth(childIndex, nextDepth);
      }
    }
  }

  // List children of a concept (matches Pascal ListChildren)
  listChildren(conceptIndex) {
    const children = [];

    // Get inbound relationships for this concept
    const inboundsRef = this.concepts.getInbounds(conceptIndex);
    if (inboundsRef !== 0) {
      const inbounds = this.refs.getReferences(inboundsRef);
      if (inbounds) {
        for (const relIndex of inbounds) {
          const rel = this.relationships.getRelationship(relIndex);

          // Check if this is an active is-a relationship where this concept is the target
          if (rel.relType === this.isAIndex && rel.active && rel.defining) {
            children.push(rel.source);
          }
        }
      }
    }

    return children;
  }

  async processRefsets() {
    if (this.files.refsetDirectories.length === 0) {
      console.log('No reference set directories found');
      this.refsetIndex.doneBuild();
      this.refsetMembers.doneBuild();
      return;
    }

    // First, discover all reference set files
    const refSetFiles = this.discoverRefSetFiles();

    if (refSetFiles.length === 0) {
      this.refsetIndex.doneBuild();
      this.refsetMembers.doneBuild();
      return;
    }

    const progressBar = this.progressReporter?.createTaskProgressBar('Processing RefSets');
    progressBar?.start(refSetFiles.length, 0);

    // Process each reference set file
    for (let i = 0; i < refSetFiles.length; i++) {
      const file = refSetFiles[i];
      await this.loadReferenceSet(file);

      this.processedRefSetCount++;
      progressBar?.update(this.processedRefSetCount);
    }

    // Complete strings building so we can READ strings with getEntry()
    this.strings.doneBuild();

    // Sort and index reference sets (this calls getEntry() so needs doneBuild() first)
    await this.sortAndIndexRefSets();

    // Reopen strings so we can add reference set titles
    this.strings.reopen();

    // Add reference sets to index (this needs strings builder to be active)
    await this.addRefSetsToIndex();

    // Index reference sets by concept
    await this.indexRefSetsByConcept();

    this.refsetIndex.doneBuild();
    this.refsetMembers.doneBuild();

    // Complete the task with timing
    if (this.progressReporter) {
      this.progressReporter.completeTask('Processing RefSets', refSetFiles.length, refSetFiles.length);
    }
  }

  async addRefSetsToIndex() {
    const refSetsArray = Array.from(this.refSets.values());

    // Add reference sets to index
    // NOTE: This calls addString() so it must happen AFTER strings.reopen()
    for (const refSet of refSetsArray) {
      this.refsetIndex.addReferenceSet(
          this.addString(refSet.title),    // This needs strings builder to be active
          refSet.filename,
          refSet.index,
          refSet.membersByRef,
          refSet.membersByName,
          refSet.fieldTypes,
          refSet.fieldNames,
          refSet.langs
      );
    }
  }

  // Discover all reference set files
  discoverRefSetFiles() {
    const refSetFiles = [];

    for (const refSetDir of this.files.refsetDirectories) {
      this.scanRefSetDirectory(refSetDir, refSetFiles);
    }

    return refSetFiles;
  }

  // Recursively scan reference set directories
  scanRefSetDirectory(dir, files) {
    if (!fs.existsSync(dir)) return;

    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.')) {
          this.scanRefSetDirectory(fullPath, files);
        }
      } else if (entry.isFile() && entry.name.endsWith('.txt')) {
        // Determine if this is a language reference set
        const isLangRefset = dir.toLowerCase().includes('language');

        files.push({
          path: fullPath,
          isLangRefset: isLangRefset
        });
      }
    }
  }

  // Load a single reference set file
  async loadReferenceSet(fileInfo) {
    const { path: filePath, isLangRefset } = fileInfo;

    try {
      // Parse filename to extract reference set info
      const fileName = path.basename(filePath);
      const parts = fileName.split('_');

      if (parts.length < 3) {
        console.log(`Skipping file with unexpected name format: ${fileName}`);
        return;
      }

      const refSetName = parts[1] || 'Unknown';
      const displayName = parts[2] || refSetName;

      // Determine field types from filename
      const fieldTypes = this.parseFieldTypesFromFilename(refSetName);

      const rl = readline.createInterface({
        input: fs.createReadStream(filePath),
        crlfDelay: Infinity
      });

      let lineNumber = 0;
      let headers = [];
      let refSet = null;
      let currentRefSetId = null;

      for await (const line of rl) {
        lineNumber++;

        if (lineNumber === 1) {
          // Parse headers
          headers = line.split('\t').map(h => h.trim());

          // Skip if this looks like a mapping reference set
          if (line.toLowerCase().includes('map')) {
            return;
          }
          continue;
        }

        const fields = line.split('\t');
        if (fields.length < 6) {
          console.log(`Skipping line ${lineNumber} with insufficient fields: ${fields.length}`);
          continue; // Minimum fields required
        }

        // Parse basic fields (standard across all reference sets)
        const id = fields[0];
        const effectiveTime = fields[1];
        const active = fields[2] === '1';
        const moduleId = fields[3];
        const refSetId = fields[4];
        const referencedComponentId = fields[5];

        if (!active) continue; // Only process active members

        // Get or create reference set (only create once per file)
        if (!refSet || currentRefSetId !== refSetId) {
          currentRefSetId = refSetId;
          refSet = this.getOrCreateRefSet(refSetId, displayName, isLangRefset);
          // Compute relative path — the file may live under the base directory
          // rather than the extension source directory.
          let relPath = path.relative(this.config.source, filePath);
          if (this.config.base && relPath.startsWith('..')) {
            relPath = path.relative(this.config.base, filePath);
          }
          refSet.filename = this.addString(relPath);
          refSet.fieldTypes = this.getOrCreateFieldTypes(fieldTypes);
          refSet.fieldNames = this.getOrCreateFieldNames(headers.slice(6), fieldTypes); // Additional fields beyond standard 6
        }

        // Create reference set member
        const member = new RefSetMember();

        // Parse GUID
        try {
          member.id = this.parseGUID(id);
        } catch (error) {
          console.log(`Invalid GUID in ${fileName}: ${id}`);
          continue;
        }

        // Find module concept
        const moduleConcept = this.conceptMap.get(BigInt(moduleId));
        if (!moduleConcept) {
          console.log(`Module concept not found: ${moduleId}`);
          continue;
        }
        member.module = moduleConcept.index;

        // Parse effective time
        member.date = this.convertDateToSnomedDate(effectiveTime);

        // Determine component type and reference
        const componentId = BigInt(referencedComponentId);

        // Try to find as concept first
        const concept = this.conceptMap.get(componentId);
        if (concept) {
          member.kind = 0; // Concept
          member.ref = concept.index;
        } else {
          // Try to find as description
          const descResult = this.descriptionIndex.findDescription(componentId);
          if (descResult.found) {
            member.kind = 1; // Description
            member.ref = descResult.index;
            refSet.noStoreIds = true; // Description reference sets don't store IDs

            // For language reference sets, track languages
            if (isLangRefset) {
              const lang = this.getLanguageForDescription(descResult.index);
              refSet.langs |= (1 << lang);
            }
          } else {
            // Try to find as relationship (simplified - would need relationship ID lookup)
            member.kind = 3; // Other/unknown
            member.ref = 0;
            console.log(`Component not found: ${referencedComponentId}`);
            continue;
          }
        }

        // Process additional fields based on field types
        if (fieldTypes.length > 0 && fields.length > 6) {
          const additionalFields = fields.slice(6);
          member.values = this.processAdditionalFields(additionalFields, fieldTypes);
        }

        refSet.addMember(member);
      }

      // Set reference set concept index
      if (refSet && refSet.index === 0 && currentRefSetId) {
        const refSetConcept = this.conceptMap.get(BigInt(currentRefSetId));
        if (refSetConcept) {
          refSet.index = refSetConcept.index;
        }
      }

    } catch (error) {
      console.error(`Error processing reference set ${filePath}:`, error);
    }
  }

  // Parse field types from filename (like "ciRefset" -> ['c', 'i'])
  parseFieldTypesFromFilename(refSetName) {
    if (!refSetName.endsWith('Refset') || refSetName === 'Refset') {
      return [];
    }

    const typeStr = refSetName.substring(0, refSetName.length - 6); // Remove "Refset"
    const types = [];

    for (const char of typeStr) {
      if (char === 'c' || char === 'i' || char === 's') {
        types.push(char.charCodeAt(0)); // Convert to ASCII code
      }
    }

    return types;
  }

  // Get or create reference set
  getOrCreateRefSet(refSetId, displayName, isLangRefset) {
    if (!this.refSets.has(refSetId)) {
      const refSet = new RefSet(refSetId);
      refSet.title = displayName;
      refSet.isLangRefset = isLangRefset;
      // Set the reference set's defining-concept index at creation time, using
      // this refset's own id. Doing it here (rather than once after the member
      // loop) is essential when a single RF2 file contains members for more than
      // one reference set (e.g. the association file carries both 734139008 and
      // 900000000000526001) — otherwise only the last refset in the file gets a
      // valid index and the others collapse to index 0.
      const refSetConcept = this.conceptMap.get(BigInt(refSetId));
      if (refSetConcept) {
        refSet.index = refSetConcept.index;
      }
      this.refSets.set(refSetId, refSet);
    }
    return this.refSets.get(refSetId);
  }

  // Get or create field types index
  getOrCreateFieldTypes(fieldTypes) {
    if (fieldTypes.length === 0) return 0;

    const signature = fieldTypes.join(',');
    if (!this.refSetTypes.has(signature)) {
      const typeIndex = this.refs.addReferences(fieldTypes);
      this.refSetTypes.set(signature, typeIndex);
      return typeIndex;
    }
    return this.refSetTypes.get(signature);
  }

  // Get or create field names index
  getOrCreateFieldNames(headers, fieldTypes) {
    if (headers.length === 0 || fieldTypes.length === 0) return 0;

    const nameIndices = headers.slice(0, fieldTypes.length).map(name => this.addString(name));
    return this.refs.addReferences(nameIndices);
  }

  // Process additional fields based on their types
  processAdditionalFields(fields, fieldTypes) {
    const values = [];

    for (let i = 0; i < Math.min(fields.length, fieldTypes.length); i++) {
      const field = fields[i];
      const fieldType = fieldTypes[i];

      let value, type;

      switch (fieldType) {
        case FIELD_TYPE_CONCEPT: { // 'c'
          const conceptId = field ? BigInt(field) : BigInt(0);
          const concept = this.conceptMap.get(conceptId);
          if (concept) {
            value = concept.index;
            type = 1; // Concept
          } else {
            // Try description
            const descResult = this.descriptionIndex.findDescription(conceptId);
            if (descResult.found) {
              value = descResult.index;
              type = 2; // Description
            } else {
              console.log(`Referenced component not found: ${field}`);
              value = 0;
              type = 1;
            }
          }
          break;
        }
        case FIELD_TYPE_INTEGER: // 'i'
          value = parseInt(field) || 0;
          type = 4; // Integer
          break;

        case FIELD_TYPE_STRING: // 's'
          value = this.addString(field || '');
          type = 5; // String
          break;

        default:
          value = 0;
          type = 1;
      }

      values.push(value, type);
    }

    return values.length > 0 ? this.refs.addReferences(values) : 0;
  }

  // Parse GUID string to 16-byte buffer
  parseGUID(guidString) {
    // Remove hyphens and braces
    const cleanGuid = guidString.replace(/[-{}]/g, '');
    if (cleanGuid.length !== 32) {
      throw new Error('Invalid GUID format');
    }
    return Buffer.from(cleanGuid, 'hex');
  }

  // Get language for description (placeholder - would need actual implementation)
  getLanguageForDescription(descIndex) {
    // This would need to look up the actual description language
    // For now, return default language
    var d = this.descriptions.getDescription(descIndex);
    return d.lang;
  }

  // Sort and index reference sets
  async sortAndIndexRefSets() {
    const refSetsArray = Array.from(this.refSets.values());

    // Sort reference sets by concept index
    refSetsArray.sort((a, b) => a.index - b.index);

    for (let i = 0; i < refSetsArray.length; i++) {
      const refSet = refSetsArray[i];

      // Sort members by name (requires looking up descriptions via getEntry())
      const membersByName = [...refSet.members];
      this.sortMembersByName(membersByName);
      refSet.membersByName = this.refsetMembers.addMembers(false, membersByName);

      // Sort members by reference
      const membersByRef = [...refSet.members];
      membersByRef.sort((a, b) => a.ref - b.ref);
      refSet.membersByRef = this.refsetMembers.addMembers(!refSet.noStoreIds, membersByRef);
    }
  }

  // Sort reference set members by name (description text)
  sortMembersByName(members) {
    members.sort((a, b) => {
      const nameA = this.getMemberDisplayName(a);
      const nameB = this.getMemberDisplayName(b);
      return nameA.localeCompare(nameB);
    });
  }

  // Get display name for a reference set member
  getMemberDisplayName(member) {
    try {
      if (member.kind === 1) {
        // Description - get the term directly
        const desc = this.descriptions.getDescription(member.ref);
        return this.strings.getEntry(desc.iDesc);
      } else if (member.kind === 0) {
        // Concept - find FSN description
        const descriptionsRef = this.concepts.getDescriptions(member.ref);
        if (descriptionsRef !== 0) {
          const descriptions = this.refs.getReferences(descriptionsRef);

          // Look for FSN first
          for (const descRef of descriptions) {
            const desc = this.descriptions.getDescription(descRef);
            if (desc.active && desc.kind === this.fsnIndex) {
              return this.strings.getEntry(desc.iDesc);
            }
          }

          // Fall back to any active description
          for (const descRef of descriptions) {
            const desc = this.descriptions.getDescription(descRef);
            if (desc.active) {
              return this.strings.getEntry(desc.iDesc);
            }
          }
        }
        return `Concept ${member.ref}`;
      } else {
        return `Component ${member.ref}`;
      }
    } catch (error) {
      return `Unknown ${member.ref}`;
    }
  }

  // Index reference sets by concept for quick lookup
  async indexRefSetsByConcept() {
    const totalItems = this.conceptList.length + this.descriptions.count();
    const progressBar = this.progressReporter?.createTaskProgressBar('Indexing RefSets');
    progressBar?.start(totalItems, 0);

    let processed = 0;

    // Pre-build array of reference sets for faster iteration
    const refSetsArray = Array.from(this.refSets.values());

    // Index concepts - optimized version
    for (const concept of this.conceptList) {
      // Store the concept's module (resolved to its concept index) so that
      // $lookup can report the 'module' property. Modules whose concept is not
      // part of the subset are skipped (moduleId stays 0 / property omitted).
      const moduleConcept = this.conceptMap.get(concept.moduleId);
      if (moduleConcept && moduleConcept.index != null) {
        this.concepts.setModuleId(concept.index, moduleConcept.index);
      }

      const refSetRefs = [];
      const refSetValues = [];

      // Check each reference set for this concept (now O(1) per refset!)
      for (const refSet of refSetsArray) {
        if (refSet.hasMember(concept.index)) {
          refSetRefs.push(refSet.index);
          refSetValues.push(refSet.getMemberValues(concept.index));
        }
      }

      if (refSetRefs.length > 0) {
        const refsIndex = this.refs.addReferences(refSetRefs);
        this.concepts.setRefsets(concept.index, refsIndex);
      }

      processed++;
      if (processed % 1000 === 0) {
        progressBar?.update(processed);
      }
    }

    // Index descriptions - optimized version
    for (let i = 0; i < this.descriptions.count(); i++) {
      const descIndex = i * 40; // DESC_SIZE = 40
      const refSetRefs = [];
      const refSetValues = [];

      // Check each reference set for this description (now O(1) per refset!)
      for (const refSet of refSetsArray) {
        if (refSet.hasMember(descIndex)) {
          refSetRefs.push(refSet.index);
          refSetValues.push(refSet.getMemberValues(descIndex));
        }
      }

      if (refSetRefs.length > 0) {
        const refsIndex = this.refs.addReferences(refSetRefs);
        const valuesIndex = this.refs.addReferences(refSetValues);
        this.descriptions.setRefsets(descIndex, refsIndex, valuesIndex);
      }

      processed++;
      if (processed % 1000 === 0) {
        progressBar?.update(processed);
      }
    }

    if (this.progressReporter) {
      this.progressReporter.completeTask('Indexing RefSets', processed, totalItems);
    }
  }

  // Find if a component is a member of a reference set
  findMemberInRefSet(refSet, componentRef) {
    return refSet.getMemberValues(componentRef);
  }

  buildNormalForms() {
    const progressBar = this.progressReporter?.createTaskProgressBar('Building Normal Forms');
    progressBar?.start(this.conceptList.length, 0);

    // First complete strings building so we can read from strings
    this.strings.doneBuild();

    // Create the expression services - we need all structures to be ready
    const snomedStructures = {
      strings: this.strings,
      words: this.words,
      stems: this.stems,
      refs: this.refs,
      descriptions: this.descriptions,
      descriptionIndex: this.descriptionIndex,
      concepts: this.concepts,
      relationships: this.relationships,
      refSetMembers: this.refsetMembers,
      refSetIndex: this.refsetIndex
    };

    const services = new SnomedExpressionServices(
        snomedStructures,
        this.isAIndex
    );

    // Set building flag to true so services will generate normal forms dynamically
    services.building = true;

    // Now reopen strings so we can add normal form strings
    this.strings.reopen();

    let processedCount = 0;
    let normalFormsAdded = 0;

    for (const concept of this.conceptList) {
      try {
        // Create expression with just this concept
        const { SnomedExpression, SnomedConcept } = require('../sct/expressions');
        const exp = new SnomedExpression();
        const snomedConcept = new SnomedConcept(concept.index);
        snomedConcept.code = concept.id.toString();
        exp.concepts.push(snomedConcept);

        // Normalize the expression
        const normalizedExp = services.normaliseExpression(exp);

        // Render with minimal formatting
        const { SnomedServicesRenderOption } = require('../sct/expressions');
        const rendered = services.renderExpression(normalizedExp, SnomedServicesRenderOption.Minimal);

        // If the rendered form is different from just the concept ID, store it
        const conceptIdStr = concept.id.toString();
        if (rendered !== conceptIdStr) {
          const normalFormStringIndex = this.addString(rendered);
          this.concepts.setNormalForm(concept.index, normalFormStringIndex);
          normalFormsAdded++;
        }
        // If rendered === conceptIdStr, normal form remains 0 (default)

      } catch (error) {
        // Log the error but continue processing other concepts
        if (this.config.verbose) {
          console.warn(`Warning: Could not build normal form for concept ${concept.id}: ${error.message}`);
        }
      }

      processedCount++;
      if (processedCount % 1000 === 0) {
        progressBar?.update(processedCount);
      }
    }

    if (this.progressReporter) {
      this.progressReporter.completeTask('Building Normal Forms', processedCount, this.conceptList.length);
    }

    if (this.config.verbose) {
      console.log(`Normal forms: ${normalFormsAdded} concepts have non-trivial normal forms`);
    }
  }

  async saveCache() {
    const progressBar = this.progressReporter?.createTaskProgressBar('Saving Cache');
    progressBar?.start(100, 0);

    this.refs.doneBuild();
    this.strings.doneBuild();

    progressBar?.update(25);

    // Write the binary cache file using our writer
    const writer = new SnomedCacheWriter(this.config.dest);

    progressBar?.update(50);

    const identifiers = this.identifiers || [];
    await writer.writeCache({
      // 18 = 17 plus the alternate identifiers. Only used when there are some, so that
      // caches without them stay readable by servers that only know 17
      version: identifiers.length > 0 ? '18' : '17',
      identifiers: identifiers,
      versionUri: this.isTesting ? this.config.uri.replace("/sct/", "/xsct/") : this.config.uri,
      versionDate: this.extractDateFromUri(this.config.uri),

      strings: this.strings.master,
      refs: this.refs.master,
      desc: this.descriptions.master,
      words: this.words.master,
      stems: this.stems.master,
      concept: this.concepts.master,
      rel: this.relationships.master,
      refSetIndex: this.refsetIndex.master,
      refSetMembers: this.refsetMembers.master,
      descRef: this.descriptionIndex.master,

      isAIndex: this.isAIndex, // Simplified
      inactiveRoots: this.inactiveRoots || [],
      activeRoots: this.activeRoots || [],
      defaultLanguage: 1
    });

    if (this.progressReporter) {
      this.progressReporter.completeTask('Saving Cache', 100, 100);
    }
  }

  extractDateFromUri(uri) {
    // Extract date from URI like http://snomed.info/sct/900000000000207008/version/20240301
    const match = uri.match(/version\/(\d{8})/);
    return match ? match[1] : new Date().toISOString().slice(0, 10).replace(/-/g, '');
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

// Cache file writer that matches Pascal TWriter format
class SnomedCacheWriter {
  constructor(filePath) {
    this.filePath = filePath;
  }

  async writeCache(data) {
    const buffers = [];

    // Write version string
    buffers.push(this.writeString(data.version));

    // Write version URI and date
    buffers.push(this.writeString(data.versionUri));
    buffers.push(this.writeString(data.versionDate));

    // Write byte arrays
    buffers.push(this.writeBytes(data.strings));
    buffers.push(this.writeBytes(data.refs));
    buffers.push(this.writeBytes(data.desc));
    buffers.push(this.writeBytes(data.words));
    buffers.push(this.writeBytes(data.stems));
    buffers.push(this.writeBytes(data.concept));
    buffers.push(this.writeBytes(data.rel));
    buffers.push(this.writeBytes(data.refSetIndex));
    buffers.push(this.writeBytes(data.refSetMembers));
    buffers.push(this.writeBytes(data.descRef));

    // Write integers and arrays
    buffers.push(this.writeInteger(data.isAIndex));
    buffers.push(this.writeInteger(data.inactiveRoots.length));
    for (const root of data.inactiveRoots) {
      buffers.push(this.writeUInt64(root));
    }
    buffers.push(this.writeInteger(data.activeRoots.length));
    for (const root of data.activeRoots) {
      buffers.push(this.writeUInt64(root));
    }
    buffers.push(this.writeInteger(data.defaultLanguage));

    if (data.version === '18') {
      // alternate identifiers, as JSON: [[scheme, module, code, conceptId], ...]
      buffers.push(this.writeBytes(Buffer.from(JSON.stringify(data.identifiers || []), 'utf8')));
    }

    // Write to file
    const finalBuffer = Buffer.concat(buffers);
    await fs.promises.writeFile(this.filePath, finalBuffer);
  }

  writeString(str) {
    const utf8Bytes = Buffer.from(str, 'utf8');
    const length = utf8Bytes.length;

    if (length <= 255) {
      // Short string: type 6 (vaString) + 1-byte length + string bytes
      const buffer = Buffer.allocUnsafe(1 + 1 + length);
      buffer.writeUInt8(6, 0); // vaString type
      buffer.writeUInt8(length, 1); // 1-byte length
      utf8Bytes.copy(buffer, 2);
      return buffer;
    } else {
      // Long string: type 12 (vaLString) + 4-byte length + string bytes
      const buffer = Buffer.allocUnsafe(1 + 4 + length);
      buffer.writeUInt8(6, 0); // vaLString type
      buffer.writeUInt32LE(length, 1); // 4-byte length
      utf8Bytes.copy(buffer, 5);
      return buffer;
    }
  }

  writeInteger(value) {
    // Type 4 = 4-byte integer
    const buffer = Buffer.allocUnsafe(5);
    buffer.writeUInt8(4, 0); // Type byte
    buffer.writeInt32LE(value, 1);
    return buffer;
  }

  writeBytes(byteArray) {
    const lengthBuffer = this.writeInteger(byteArray.length);
    return Buffer.concat([lengthBuffer, byteArray]);
  }

  // 19
  writeUInt64(value) {
    const buffer = Buffer.allocUnsafe(8);
    buffer.writeBigUInt64LE(BigInt(value), 0);
    return buffer;
  }
}

module.exports = {
  SnomedModule,
  SnomedImporter,
  SnomedCacheWriter
};