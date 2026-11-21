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
