const fs = require('fs');
const os = require('os');
const path = require('path');
const { Command } = require('commander');
const inquirer = require('inquirer');

jest.mock('../../tx/importers/tx-import-settings', () => ({
  getConfigManager: () => ({
    generateDefaults: () => ({}),
    getRecentSources: () => []
  })
}));

const { LoincDataMigrator } = require('../../tx/importers/import-loinc.module');
const { BaseTerminologyModule } = require('../../tx/importers/tx-import-base');
const { TerminologyImportCLI } = require('../../tx/importers/tx-import');

describe('LOINC language selection', () => {
  let source;

  beforeEach(() => {
    source = fs.mkdtempSync(path.join(os.tmpdir(), 'loinc-languages-'));
    const dir = path.join(source, 'AccessoryFiles/LinguisticVariants');
    fs.mkdirSync(dir, { recursive: true });
    for (const file of ['csCZ2LinguisticVariant.csv', 'frFR3LinguisticVariant.csv', 'frCA4LinguisticVariant.csv']) {
      fs.writeFileSync(path.join(dir, file), '');
    }
    fs.writeFileSync(path.join(dir, 'LinguisticVariants.csv'),
      'Key,Language,Country,Description\n2,cs,CZ,Czech\n3,fr,FR,French\n4,fr,CA,Canadian French\n');
  });

  afterEach(() => fs.rmSync(source, { recursive: true, force: true }));

  test('imports all variants by default', async () => {
    const m = new LoincDataMigrator();
    expect((await m.discoverLanguageVariants(source)).sort()).toEqual(['cs-CZ', 'fr-CA', 'fr-FR']);
  });

  test('selects all regions for a language, or a single regional variant', async () => {
    const m = new LoincDataMigrator();
    expect((await m.discoverLanguageVariants(source, ['fr'])).sort()).toEqual(['fr-CA', 'fr-FR']);
    expect(await m.discoverLanguageVariants(source, ['fr-FR'])).toEqual(['fr-FR']);
    expect(await m.discoverLanguageVariants(source, ['de'])).toEqual([]);
  });

  test('stores only selected language metadata while keeping the original keys', async () => {
    const m = new LoincDataMigrator();
    m.langs = new Map([['en-US', 1]]);
    m.langKey = 1;
    const db = { run: jest.fn() };
    await m.processLanguageVariants(db, source, 0, { languages: ['fr-FR'] });
    expect(db.run).toHaveBeenCalledTimes(1);
    expect(db.run.mock.calls[0][1]).toEqual([3, 'fr-FR', 'French']);
    expect([...m.langs.keys()]).toEqual(['en-US', 'fr-FR']);
  });
});

test('terminology --version reaches the import action', async () => {
  const cli = Object.create(TerminologyImportCLI.prototype);
  cli.program = new Command();
  cli.setupMainProgram();
  const action = jest.fn();
  cli.program.command('loinc').command('import')
    .option('-v, --version <version>')
    .action(action);
  await cli.program.parseAsync(['loinc', 'import', '--version', 'LOINC-2.78'], { from: 'user' });
  expect(action.mock.calls[0][0].version).toBe('LOINC-2.78');
  expect(cli.program.options.find(option => option.long === '--cli-version').short).toBe('-V');
});

test('--yes skips overwrite and verbosity prompts with explicit paths', async () => {
  const prompt = jest.spyOn(inquirer, 'prompt').mockImplementation(async questions => {
    expect(questions.some(q => q.name === 'verbose')).toBe(false);
    expect(questions.filter(q => !q.when || q.when({}))).toEqual([]);
    return {};
  });
  try {
    const module = new BaseTerminologyModule();
    module.getName = () => 'loinc';
    const config = await module.gatherCommonConfig({ source: __dirname, dest: __filename, yes: true });
    expect(config.source).toBe(__dirname);
    expect(config.overwrite).toBe(false);
  } finally {
    prompt.mockRestore();
  }
});
