const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PublisherModule = require('../../publisher/publisher');

const MB = 1024 * 1024;

// sparse files, so a 330MB fixture costs no disk and no time
function makeFile(file, mb) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'w');
  fs.ftruncateSync(fd, mb * MB);
  fs.closeSync(fd);
}

describe('publisher large file archiving', () => {
  let tmp;
  let gitRoot;   // the repository - what gets pushed
  let webRoot;   // the website inside it - where publish-setup.json lives
  let archive;
  let mod;

  // mirrors the real fhir-org layout: git root /web/git/fhir-org, website source/guides under it
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fhirsmith-large-'));
    gitRoot = path.join(tmp, 'repo');
    webRoot = path.join(gitRoot, 'source/guides');
    archive = path.join(tmp, 'archive');
    fs.mkdirSync(webRoot, { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: gitRoot });

    mod = new PublisherModule({ addTask: () => {}, countRequest: () => {} });
    mod.config = { 'large-file-archive': archive };
    mod.warnings = [];
    mod.logger = { warn: (m) => mod.warnings.push(m), info: () => {} };
    mod.messages = [];
    mod.logTaskMessage = async (taskId, level, message) => {
      mod.messages.push({ level, message });
    };
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function publishSetup(github) {
    const setup = { url: 'http://fhir.org', website: { url: 'http://fhir.org', server: 'apache' } };
    if (github !== undefined) {
      setup.website.github = github;
    }
    fs.writeFileSync(path.join(webRoot, 'publish-setup.json'), JSON.stringify(setup, null, 2));
  }

  const website = () => ({ git_root: gitRoot, local_folder: webRoot });

  test('moves an oversized file out of the web folder and logs it', async () => {
    publishSetup(true);
    const big = path.join(webRoot, 'cdc/opioid-cds/fhir.cdc.opioid-cds-2022.1.0.zip');
    const ok = path.join(webRoot, 'cdc/opioid-cds/full-ig.zip');
    makeFile(big, 143);
    makeFile(ok, 65);

    await mod.archiveLargeFiles({ id: 1 }, website());

    expect(fs.existsSync(big)).toBe(false);
    expect(fs.existsSync(path.join(archive, 'fhir.cdc.opioid-cds-2022.1.0.zip'))).toBe(true);
    expect(fs.existsSync(ok)).toBe(true);
    expect(mod.messages).toHaveLength(1);
    expect(mod.messages[0].level).toBe('warn');
    expect(mod.messages[0].message).toContain('fhir.cdc.opioid-cds-2022.1.0.zip');
    expect(mod.messages[0].message).toContain('143 MB');
  });

  test('leaves a website that is not on GitHub alone', async () => {
    publishSetup(false);
    const big = path.join(webRoot, 'big.zip');
    makeFile(big, 143);

    await mod.archiveLargeFiles({ id: 1 }, website());

    expect(fs.existsSync(big)).toBe(true);
    expect(mod.messages).toHaveLength(0);
  });

  test('leaves a website alone when publish-setup.json says nothing about GitHub', async () => {
    publishSetup(undefined);
    const big = path.join(webRoot, 'big.zip');
    makeFile(big, 143);

    await mod.archiveLargeFiles({ id: 1 }, website());

    expect(fs.existsSync(big)).toBe(true);
    expect(mod.messages).toHaveLength(0);
  });

  test('leaves files alone, and warns, when publish-setup.json cannot be read', async () => {
    const big = path.join(webRoot, 'big.zip');
    makeFile(big, 143);

    await mod.archiveLargeFiles({ id: 1 }, website());

    expect(fs.existsSync(big)).toBe(true);
    expect(mod.messages).toHaveLength(0);
    expect(mod.warnings.join(' ')).toContain('publish-setup.json');
  });

  test('never touches anything inside .git', async () => {
    publishSetup(true);
    const pack = path.join(gitRoot, '.git/objects/pack/pack-abc.pack');
    makeFile(pack, 330);

    await mod.archiveLargeFiles({ id: 1 }, website());

    expect(fs.existsSync(pack)).toBe(true);
    expect(mod.messages).toHaveLength(0);
  });

  test('leaves gitignored files where they are', async () => {
    publishSetup(true);
    const ignored = path.join(gitRoot, 'scratch/enormous.bin');
    makeFile(ignored, 200);
    fs.writeFileSync(path.join(gitRoot, '.gitignore'), 'scratch/\n');

    await mod.archiveLargeFiles({ id: 1 }, website());

    expect(fs.existsSync(ignored)).toBe(true);
    expect(mod.messages).toHaveLength(0);
  });

  test('does nothing when large-file-archive is not configured', async () => {
    publishSetup(true);
    const big = path.join(webRoot, 'big.zip');
    makeFile(big, 143);
    mod.config = {};

    await mod.archiveLargeFiles({ id: 1 }, website());

    expect(fs.existsSync(big)).toBe(true);
    expect(mod.messages).toHaveLength(0);
  });

  test('does not overwrite an archive file of the same name', async () => {
    publishSetup(true);
    fs.mkdirSync(archive, { recursive: true });
    fs.writeFileSync(path.join(archive, 'big.zip'), 'the archive from a previous run');
    makeFile(path.join(webRoot, 'big.zip'), 143);

    await mod.archiveLargeFiles({ id: 1 }, website());

    expect(fs.readFileSync(path.join(archive, 'big.zip'), 'utf8')).toBe('the archive from a previous run');
    expect(fs.statSync(path.join(archive, 'big-2.zip')).size).toBe(143 * MB);
  });

  test('falls back to the website folder when no git root is set', async () => {
    publishSetup(true);
    makeFile(path.join(webRoot, 'big.zip'), 143);

    await mod.archiveLargeFiles({ id: 1 }, { local_folder: webRoot });

    expect(fs.existsSync(path.join(archive, 'big.zip'))).toBe(true);
  });
});
