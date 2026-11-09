#!/usr/bin/env node

const { Command } = require('commander');
const chalk = require('chalk');
const fs = require('fs');
const path = require('path');
const { getConfigManager } = require('./tx-import-settings');
const terminal = require('./terminal');

class TerminologyImportCLI {
  constructor() {
    this.program = new Command();
    this.modules = new Map();
    this.setupMainProgram();
    this.discoverAndLoadModules();
  }

  setupMainProgram() {
    this.program
      .name('tx-import')
      .description('Medical terminology import tool')
      .version('1.0.0');

    // Add global options
    this.program
      .option('--verbose', 'enable verbose logging')
      .option('--config <file>', 'global config file')
      .option('--dry-run', 'validate without importing');

    // List available terminologies
    this.program
      .command('list')
      .description('List available terminology importers')
      .action(() => this.listTerminologies());

    // Configuration management
    this.program
      .command('config')
      .description('Manage configuration and history')
      .action(() => this.showConfigHelp());

    this.program
      .command('config:show')
      .description('Show saved configuration history')
      .option('-t, --terminology <name>', 'Show config for specific terminology')
      .action((options) => this.showConfig(options));

    this.program
      .command('config:clear')
      .description('Clear saved configuration history')
      .option('-t, --terminology <name>', 'Clear config for specific terminology')
      .option('-a, --all', 'Clear all configuration history')
      .action((options) => this.clearConfig(options));

    this.program
      .command('config:export')
      .description('Export configuration to file')
      .option('-o, --output <file>', 'Output file path', './tx-import-config.json')
      .action((options) => this.exportConfig(options));

    this.program
      .command('config:import')
      .description('Import configuration from file')
      .option('-i, --input <file>', 'Input file path')
      .action((options) => this.importConfig(options));

    // Help command
    this.program
      .command('help [command]')
      .description('Display help for command')
      .action((cmd) => this.showHelp(cmd));
  }

  discoverAndLoadModules() {
    terminal.log("Looking in " + __dirname);

    const moduleFiles = fs.readdirSync(__dirname)
      .filter(file => file.endsWith('.module.js') && !file.startsWith('_'))
      .map(file => path.join(__dirname, file));

    for (const moduleFile of moduleFiles) {
      try {
        const moduleExports = require(moduleFile);

        // Handle different export formats
        let ModuleClass;
        if (typeof moduleExports === 'function') {
          // Direct class export: module.exports = UniiModule
          ModuleClass = moduleExports;
        } else if (moduleExports.default) {
          // ES6 default export
          ModuleClass = moduleExports.default;
        } else {
          // Object export - find the module class
          // Look for a class that ends with 'Module'
          const moduleClassNames = Object.keys(moduleExports)
            .filter(key => key.endsWith('Module') && typeof moduleExports[key] === 'function');

          if (moduleClassNames.length > 0) {
            ModuleClass = moduleExports[moduleClassNames[0]];
          } else {
            throw new Error('No module class found in exports');
          }
        }

        const moduleInstance = new ModuleClass();

        if (this.isValidModule(moduleInstance)) {
          this.registerModule(moduleInstance);
        } else {
          terminal.warn(chalk.yellow(`Warning: Invalid module format in ${moduleFile}`));
        }
      } catch (error) {
        terminal.warn(chalk.yellow(`Warning: Failed to load module ${moduleFile}: ${error.message}`));
      }
    }
  }

  isValidModule(module) {
    return (
      typeof module.getName === 'function' &&
      typeof module.getDescription === 'function' &&
      typeof module.registerCommands === 'function'
    );
  }

  registerModule(module) {
    const name = module.getName();

    if (this.modules.has(name)) {
      terminal.warn(chalk.yellow(`Warning: Module ${name} already registered, skipping`));
      return;
    }

    this.modules.set(name, module);

    // Create command group for this terminology
    const terminologyCommand = this.program
      .command(name)
      .description(module.getDescription());

    // Let the module register its subcommands
    module.registerCommands(terminologyCommand, this.program.opts());

    terminal.log(chalk.green(`✓ Loaded ${name} module`));
  }

  listTerminologies() {
    terminal.log(chalk.blue.bold('🏥 Available Terminology Importers\\n'));

    if (this.modules.size === 0) {
      terminal.log(chalk.yellow('No terminology modules found.'));
      terminal.log(chalk.gray('Add modules to the ./modules/ directory.'));
      return;
    }

    for (const [name, module] of this.modules) {
      terminal.log(chalk.cyan(`${name}:`));
      terminal.log(`  ${module.getDescription()}`);

      if (module.getSupportedFormats) {
        const formats = module.getSupportedFormats();
        terminal.log(chalk.gray(`  Formats: ${formats.join(', ')}`));
      }

      if (module.getEstimatedDuration) {
        terminal.log(chalk.gray(`  Typical duration: ${module.getEstimatedDuration()}`));
      }

      terminal.log('');
    }

    terminal.log(chalk.gray('Use "tx-import <terminology> --help" for specific options'));
  }

  showHelp(commandName) {
    if (!commandName) {
      this.program.help();
      return;
    }

    if (this.modules.has(commandName)) {
      terminal.log(chalk.blue.bold(`Help for ${commandName}:\\n`));
      this.program.commands
        .find(cmd => cmd.name() === commandName)
        ?.help();
    } else {
      terminal.log(chalk.red(`Unknown command: ${commandName}`));
      this.listTerminologies();
    }
  }

  showConfigHelp() {
    terminal.log(chalk.blue.bold('📁 Configuration Management\\n'));
    terminal.log('Available configuration commands:');
    terminal.log('  tx-import config:show     Show saved configuration history');
    terminal.log('  tx-import config:clear    Clear saved configuration history');
    terminal.log('  tx-import config:export   Export configuration to file');
    terminal.log('  tx-import config:import   Import configuration from file');
    terminal.log('\\nExamples:');
    terminal.log('  tx-import config:show --terminology unii');
    terminal.log('  tx-import config:clear --terminology loinc');
    terminal.log('  tx-import config:export --output my-config.json');
  }

  showConfig(options) {
    const configManager = getConfigManager();

    if (options.terminology) {
      // Show config for specific terminology
      const config = configManager.getPreviousConfig(options.terminology);

      if (Object.keys(config).length === 0) {
        terminal.log(chalk.yellow(`No saved configuration found for ${options.terminology}`));
        return;
      }

      terminal.log(chalk.blue.bold(`📋 Saved Configuration for ${options.terminology}:\\n`));

      if (config.lastUsed) {
        terminal.log(`Last used: ${chalk.white(new Date(config.lastUsed).toLocaleString())}`);
      }

      Object.entries(config).forEach(([key, value]) => {
        if (key !== 'lastUsed' && key !== 'recentSources') {
          if (Array.isArray(value)) {
            terminal.log(`  ${key}: ${chalk.white(value.join(', '))}`);
          } else {
            terminal.log(`  ${key}: ${chalk.white(value)}`);
          }
        }
      });

      if (config.recentSources && config.recentSources.length > 0) {
        terminal.log(`\\n  Recent sources:`);
        config.recentSources.forEach((src, index) => {
          terminal.log(`    ${index + 1}. ${chalk.gray(src)}`);
        });
      }

    } else {
      // Show all configurations
      const allHistory = configManager.history;

      if (Object.keys(allHistory).length === 0) {
        terminal.log(chalk.yellow('No saved configurations found'));
        return;
      }

      terminal.log(chalk.blue.bold('📋 All Saved Configurations:\\n'));

      Object.entries(allHistory).forEach(([terminology, config]) => {
        terminal.log(chalk.cyan(`${terminology}:`));
        if (config.lastUsed) {
          terminal.log(`  Last used: ${chalk.white(new Date(config.lastUsed).toLocaleString())}`);
        }
        if (config.source) {
          terminal.log(`  Source: ${chalk.gray(config.source)}`);
        }
        if (config.version) {
          terminal.log(`  Version: ${chalk.gray(config.version)}`);
        }
        terminal.log('');
      });
    }
  }

  async clearConfig(options) {
    const configManager = getConfigManager();
    const inquirer = require('inquirer');

    if (options.all) {
      const { confirmed } = await inquirer.prompt({
        type: 'confirm',
        name: 'confirmed',
        message: 'Clear ALL saved configuration history?',
        default: false
      });

      if (confirmed) {
        configManager.clearAllHistory();
        terminal.log(chalk.green('✓ All configuration history cleared'));
      } else {
        terminal.log(chalk.yellow('Configuration clear cancelled'));
      }

    } else if (options.terminology) {
      const { confirmed } = await inquirer.prompt({
        type: 'confirm',
        name: 'confirmed',
        message: `Clear saved configuration for ${options.terminology}?`,
        default: false
      });

      if (confirmed) {
        configManager.clearHistory(options.terminology);
        terminal.log(chalk.green(`✓ Configuration history cleared for ${options.terminology}`));
      } else {
        terminal.log(chalk.yellow('Configuration clear cancelled'));
      }

    } else {
      terminal.log(chalk.red('Please specify --terminology <name> or --all'));
      terminal.log('Example: tx-import config:clear --terminology unii');
    }
  }

  exportConfig(options) {
    const configManager = getConfigManager();
    const data = configManager.exportConfig();

    try {
      fs.writeFileSync(options.output, JSON.stringify(data, null, 2));
      terminal.log(chalk.green(`✓ Configuration exported to ${options.output}`));
    } catch (error) {
      terminal.log(chalk.red(`✗ Export failed: ${error.message}`));
    }
  }

  async importConfig(options) {
    if (!options.input) {
      const inquirer = require('inquirer');
      const { input } = await inquirer.prompt({
        type: 'input',
        name: 'input',
        message: 'Configuration file to import:',
        validate: (input) => fs.existsSync(input) ? true : 'File does not exist'
      });
      options.input = input;
    }

    const configManager = getConfigManager();

    try {
      const data = JSON.parse(fs.readFileSync(options.input, 'utf8'));
      configManager.importConfig(data);
      terminal.log(chalk.green(`✓ Configuration imported from ${options.input}`));
    } catch (error) {
      terminal.log(chalk.red(`✗ Import failed: ${error.message}`));
    }
  }

  run() {
    // Show logo and loaded modules
    terminal.log(chalk.blue.bold('🏥 TX-Import - Medical Terminology Import Tool'));
    terminal.log(chalk.gray(`Loaded ${this.modules.size} terminology module(s)\\n`));

    this.program.parse();
  }
}

// CLI entry point
if (require.main === module) {
  const cli = new TerminologyImportCLI();
  cli.run();
}

module.exports = { TerminologyImportCLI };