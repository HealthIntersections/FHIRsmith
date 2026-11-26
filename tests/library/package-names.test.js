// Packages with two files of the same name, or a name with a .. segment (library/package-names.js):
// refused wherever FHIRsmith unpacks a package, and reported (not refused) by the npm registry check

const fs = require('fs');
const os = require('os');
const path = require('path');
const { entryNameKey, EntryNames, pathProblem } = require('../../library/package-names');
const { PackageManager } = require('../../library/package-manager');
const { readPackageJson, CHECKS } = require('../../packages/npm-check');
const PackageCrawler = require('../../packages/package-crawler');
const PackageWatcher = require('../../npmprojector/watcher');
const { tgz } = require('../packages/npm-registry-checks');

const pj = JSON.stringify({ name: 'ex.names', version: '1.0.0' });
const other = JSON.stringify({ name: 'ex.other', version: '9.9.9' });
const exact = () => tgz([['package/package.json', pj], ['package/package.json', other]]);
const variant = () => tgz([['package/package.json', pj], ['./package/Package.JSON', other]]);
const fine = () => tgz([['package/package.json', pj], ['package/a.json', '{}'], ['package/b.json', '{}']]);

describe('duplicate names in a package', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'package-names-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('names are compared after normalisation, ignoring case', () => {
    expect(entryNameKey('./package//Examples/X.json')).toBe('package/examples/x.json');
    expect(entryNameKey('package\\examples\\x.json')).toBe('package/examples/x.json');
    expect(entryNameKey('/package/./package.json')).toBe('package/package.json');
    expect(entryNameKey('package/Kýnigstein.json')).toBe(entryNameKey('package/Kýnigstein.json'));
    const names = new EntryNames();
    expect(names.add('package/a.json')).toBeNull();
    expect(names.add('package/b.json')).toBeNull();
    expect(names.add('package/a.json')).toBe('the package has more than one file named package/a.json');
    expect(names.add('package/A.json')).toBe('the package has files named package/a.json and package/A.json, which are the same file to some systems');
    expect(names.duplicates).toHaveLength(2);
  });

  test('two examples of the same name are fine', async () => {
    const names = new EntryNames();
    expect(names.add('package/examples/Example-observation-bmi.json')).toBeNull();
    expect(names.add('package/examples/Example-observation-bmi.json')).toBeNull();
    expect(names.add('package/example/x.json')).toBeNull();
    expect(names.add('./package//example/x.json')).toBeNull();
    // but not names that differ in case
    expect(names.add('package/Example/X.json')).toBe('the package has files named package/example/x.json and package/Example/X.json, which are the same file to some systems');
    expect(names.add('package/examples/sub/x.json')).toBeNull();
    expect(names.add('package/examples/sub/x.json')).toBeNull();
    // but not in a folder that only starts with the name of one
    expect(names.add('package/examples2/x.json')).toBeNull();
    expect(names.add('package/examples2/x.json')).toBe('the package has more than one file named package/examples2/x.json');
    expect(names.duplicates).toHaveLength(2);

    // each reader takes them
    const examples = () => tgz([['package/package.json', pj], ['package/examples/a.json', '{"id":"1"}'], ['package/examples/a.json', '{"id":"2"}']]);
    const c = Object.create(PackageCrawler.prototype);
    c.config = {};
    await c.unpackPackage(examples());
    const pm = new PackageManager(['http://127.0.0.1:1'], tmp);
    expect(await pm.extractToCache('ex.names', '1.0.0', examples())).toBe('ex.names#1.0.0');
    const file = path.join(tmp, 'p.tgz');
    const watcher = new PackageWatcher(file, { log: { info() {}, warn() {}, error() {} } });
    watcher.extractDir = path.join(tmp, 'x');
    fs.writeFileSync(file, examples());
    watcher.extractTgz();
    // the npm registry check still reports them: a package being published can't have them
    expect((await readPackageJson(examples())).duplicates).toEqual(['the package has more than one file named package/examples/a.json']);
    const strict = new EntryNames({ strict: true });
    expect(strict.add('package/examples/a.json')).toBeNull();
    expect(strict.add('package/examples/a.json')).toBe('the package has more than one file named package/examples/a.json');
  });

  test('the crawler refuses them', async () => {
    const c = Object.create(PackageCrawler.prototype);
    c.config = {};
    await expect(c.unpackPackage(exact())).rejects.toThrow(/more than one file named package\/package.json/);
    await expect(c.unpackPackage(variant())).rejects.toThrow(/same file to some systems/);
    expect((await c.unpackPackage(fine())).fileNames).toEqual(['package.json', 'a.json', 'b.json']);
  });

  test('the package manager refuses them, and leaves nothing in the cache', async () => {
    const pm = new PackageManager(['http://127.0.0.1:1'], tmp);
    await expect(pm.extractToCache('ex.names', '1.0.0', exact())).rejects.toThrow(/more than one file named package\/package.json/);
    await expect(pm.extractToCache('ex.names', '1.0.0', variant())).rejects.toThrow(/same file to some systems/);
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(fs.readdirSync(tmp)).toEqual([]);
    expect(await pm.extractToCache('ex.names', '1.0.0', fine())).toBe('ex.names#1.0.0');
  });

  test('the npm projector refuses them', () => {
    const file = path.join(tmp, 'p.tgz');
    const watcher = new PackageWatcher(file, { log: { info() {}, warn() {}, error() {} } });
    watcher.extractDir = path.join(tmp, 'x');
    fs.writeFileSync(file, variant());
    expect(() => watcher.extractTgz()).toThrow(/same file to some systems/);
    expect(fs.existsSync(watcher.extractDir)).toBe(false);
    fs.writeFileSync(file, fine());
    watcher.extractTgz();
    expect(fs.readFileSync(path.join(watcher.extractDir, 'package', 'package.json'), 'utf8')).toBe(pj);
  });

  test('the npm registry check reports them as a problem, and reads the first package.json', async () => {
    const found = await readPackageJson(exact());
    expect(found.data.toString('utf8')).toBe(pj);
    expect(found.duplicates).toEqual(['the package has more than one file named package/package.json']);
    expect((await readPackageJson(fine())).duplicates).toEqual([]);

    const check = CHECKS.find(x => x.title.startsWith('has no two files of the same name'));
    const context = (packageJson) => ({
      response: () => ({ packageJson }),
      fail: (m) => {
        throw new Error(m);
      }
    });
    expect(() => check.run(context(found))).toThrow(/more than one file named package\/package.json/);
    const ok = await readPackageJson(fine());
    expect(() => check.run(context(ok))).not.toThrow();
  });

  describe('names with a .. segment', () => {
    const outside = () => tgz([['package/package.json', pj], ['package/../evil.json', '{}']]);
    const backslash = () => tgz([['package/package.json', pj], ['package\\..\\evil.json', '{}']]);

    test('are found, with / or \\ separators; .. elsewhere in a name is fine', () => {
      expect(pathProblem('package/../evil.json')).toBe('the package has a file named package/../evil.json, which goes outside its folder (..)');
      expect(pathProblem('package\\..\\evil.json')).toMatch(/goes outside/);
      expect(pathProblem('../package.json')).toMatch(/goes outside/);
      expect(pathProblem('package/Patient-a..b.json')).toBeNull();
      expect(pathProblem('package/...')).toBeNull();
    });

    test('the crawler refuses them', async () => {
      const c = Object.create(PackageCrawler.prototype);
      c.config = {};
      await expect(c.unpackPackage(outside())).rejects.toThrow(/package\/..\/evil.json, which goes outside its folder/);
      await expect(c.unpackPackage(backslash())).rejects.toThrow(/goes outside its folder/);
    });

    test('the package manager refuses them, and leaves nothing in the cache', async () => {
      const pm = new PackageManager(['http://127.0.0.1:1'], tmp);
      await expect(pm.extractToCache('ex.names', '1.0.0', outside())).rejects.toThrow(/goes outside its folder/);
      await expect(pm.extractToCache('ex.names', '1.0.0', backslash())).rejects.toThrow(/goes outside its folder/);
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(fs.readdirSync(tmp)).toEqual([]);
    });

    test('the npm projector refuses them', () => {
      const file = path.join(tmp, 'p.tgz');
      const watcher = new PackageWatcher(file, { log: { info() {}, warn() {}, error() {} } });
      watcher.extractDir = path.join(tmp, 'x');
      fs.writeFileSync(file, outside());
      expect(() => watcher.extractTgz()).toThrow(/goes outside its folder/);
      expect(fs.existsSync(watcher.extractDir)).toBe(false);
    });

    test('the npm registry check reports them as a problem', async () => {
      const found = await readPackageJson(outside());
      expect(found.data.toString('utf8')).toBe(pj);
      expect(found.outside).toEqual(['the package has a file named package/../evil.json, which goes outside its folder (..)']);
      const check = CHECKS.find(x => x.title.startsWith('has no file whose name goes outside'));
      const context = (packageJson) => ({
        response: () => ({ packageJson }),
        fail: (m) => {
          throw new Error(m);
        }
      });
      expect(() => check.run(context(found))).toThrow(/goes outside its folder/);
      const ok = await readPackageJson(fine());
      expect(ok.outside).toEqual([]);
      expect(() => check.run(context(ok))).not.toThrow();
    });
  });
});
