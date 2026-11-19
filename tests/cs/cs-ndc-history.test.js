const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const folders = require('../../library/folder-setup');
const { NdcDataMigrator, findNdcSources, findNdcJsonSources } = require('../../tx/importers/import-ndc.module');
const { NdcServicesFactory, ndcVersionName } = require('../../tx/cs/cs-ndc');
const { OperationContext } = require('../../tx/operation-context');
const { TestUtilities } = require('../test-utilities');

/*
 * The NDC importer working through a history of FDA downloads (tests/data/ndc-history):
 *
 *   2026-01-15/                         product/package (1111-2222 listed) + Products/Packages_excluded
 *                                       (1111-2222 older and excluded, 22222-333 retired, a package with
 *                                       no product row, a placeholder code). And a re-issued code:
 *                                       66666-777-01 (listed) and 66666-0777-1 (excluded) are both 66666077701
 *   wayback/20251214212736-ndc_unfinished.zip   unfinished 55555-6666
 *   20250301120000-ndctext.zip          an older listing: 22222-333 (older details), 44444-555 (only here),
 *                                       33333-4444 (the product of the package above), a junk code
 *   drug-ndc-0001-of-0001.json          openFDA download (2026-01-16): openfda properties for 1111-2222
 *                                       and 44444-555, and an unknown product
 *   wayback/20250601000000-drug-ndc-0001-of-0001.json.zip   an older one: 1111-2222 (older, ignored), 22222-333
 *   _ignored/                           skipped
 */
describe('NDC import from a history of snapshots', () => {
  const sourceDir = path.resolve(__dirname, '../data/ndc-history');
  const dbPath = folders.ensureFilePath('ndc-history-testing.db');
  let stats;
  let db;

  const all = (sql, params = []) => new Promise((resolve, reject) =>
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));

  const product = async (code) => (await all('SELECT p.*, t.Name as TypeName FROM NDCProducts p JOIN NDCProductTypes t ON t.NDCKey = p.Type WHERE p.Code = ?', [code]))[0];
  const pkg = async (code) => (await all('SELECT * FROM NDCPackages WHERE Code = ?', [code]))[0];
  const props = async (code, name) => {
    const p = await product(code);
    return (await all('SELECT Value FROM NDCProperties WHERE IsPackage = 0 AND NDCKey = ? AND Name = ? ORDER BY Value', [p.NDCKey, name])).map(r => r.Value);
  };
  const packageProps = async (code) => {
    const k = await pkg(code);
    const rows = await all('SELECT Name, Value FROM NDCProperties WHERE IsPackage = 1 AND NDCKey = ? ORDER BY Name', [k.NDCKey]);
    return Object.fromEntries(rows.map(r => [r.Name, r.Value]));
  };

  beforeAll(async () => {
    stats = await new NdcDataMigrator().migrate(sourceDir, dbPath, null, { verbose: false });
    db = new sqlite3.Database(dbPath);
  });

  afterAll(async () => {
    await new Promise((resolve) => db.close(resolve));
  });

  test('finds the snapshots, newest first, listings before excluded files', () => {
    const groups = findNdcSources(sourceDir);
    expect(groups.map(g => `${g.date} ${g.family}${g.excluded ? ' excluded' : ''}`)).toEqual([
      '2026-01-15 finished',
      '2026-01-15 finished excluded',
      '2025-12-14 unfinished',
      '2025-03-01 finished'
    ]);
    expect(groups.some(g => g.origin.includes('_ignored'))).toBe(false);
    // the zip has product.txt and product.xls: the .txt one is used
    expect(groups[3].product.description).toMatch(/!product\.txt$/);
  });

  test('records the newest snapshot as the version', async () => {
    expect(await all('SELECT Version FROM NDCVersion')).toEqual([{ Version: '20260115' }]);
  });

  test('reports the version as YYYYMMDD, including from databases that have YYYY-MM-DD', () => {
    expect(ndcVersionName('2026-11-17')).toBe('20261117');
    expect(ndcVersionName('20261117')).toBe('20261117');
    expect(ndcVersionName('unknown')).toBe('unknown');
  });

  test('a listed code is active, with its current details', async () => {
    const p = await product('1111-2222');
    expect(p.TradeName).toBe('CurrentName');
    expect(p.Active).toBe(1);
    expect(p.LastSeen).toBe('2026-01-15');
    const k = await pkg('1111-2222-01');
    expect(k.Description).toBe('10 TABLET in 1 BOTTLE (1111-2222-01)');
    expect(k.Active).toBe(1);
  });

  test('a newer excluded entry wins over older listings', async () => {
    const p = await product('22222-333');
    expect(p.TradeName).toBe('RetiredNewest');
    expect(p.Active).toBe(0);
    expect((await pkg('22222-333-44')).Description).toBe('30 CAPSULE in 1 BOTTLE (22222-333-44)');
  });

  test('a code only in an old snapshot is kept, inactive, with when it was last seen', async () => {
    const p = await product('44444-555');
    expect(p.TradeName).toBe('OnlyInOld');
    expect(p.Active).toBe(0);
    expect(p.LastSeen).toBe('2025-03-01');
    const k = await pkg('44444-555-66');
    expect(k.Active).toBe(0);
    expect(k.Code11).toBe('44444055566');
  });

  test('a package with no product row gets its product from an older snapshot', async () => {
    const p = await product('33333-4444');
    expect(p.TradeName).toBe('FilledIn');
    expect(p.Active).toBe(0);
    expect(p.LastSeen).toBe('2026-01-15');
    expect(await pkg('33333-4444-5')).toBeDefined();
    expect(stats.productsFromPackages).toBe(0);
  });

  test('unfinished drugs: active in the newest unfinished snapshot, named by their generic name', async () => {
    const p = await product('55555-6666');
    expect(p.Active).toBe(1);
    expect(p.TradeName).toBe('something bulk');
    expect(p.TypeName).toBe('BULK INGREDIENT');
    expect((await pkg('55555-6666-7')).Active).toBe(1);
  });

  test('codes that are not NDCs are left out', async () => {
    expect(await product('0019-N068')).toBeUndefined();
    expect(await pkg('62175-XXX-37')).toBeUndefined();
    expect(stats.invalidProducts).toBe(1);
    expect(stats.invalidPackages).toBe(1);
  });

  test('every code appears once', async () => {
    expect(stats.products).toBe(7);
    expect(stats.packages).toBe(7);
    expect(await all('SELECT Code FROM NDCPackages GROUP BY Code HAVING COUNT(*) > 1')).toEqual([]);
    expect(await all('SELECT Code FROM NDCProducts GROUP BY Code HAVING COUNT(*) > 1')).toEqual([]);
  });

  test('finds the openFDA downloads, newest first, dated by their meta', () => {
    expect(findNdcJsonSources(sourceDir).map(j => j.date)).toEqual(['2026-01-16', '2025-06-01']);
  });

  test('properties from the text files, for every product', async () => {
    expect(await props('1111-2222', 'application_number')).toEqual(['NDA1']);
    expect(await props('1111-2222', 'active_ingredient')).toEqual(['THING 1 mg']);
    expect(await props('1111-2222', 'spl_id')).toEqual(['a']);
    expect(await props('1111-2222', 'ndc_exclude_flag')).toEqual(['N']);
    // retired products have them too
    expect(await props('22222-333', 'ndc_exclude_flag')).toEqual(['D']);
    expect(await props('44444-555', 'application_number')).toEqual(['ANDA3']);
    expect(await packageProps('1111-2222-01')).toEqual({
      marketing_start_date: '20200101', ndc_exclude_flag: 'N', sample: 'N'
    });
  });

  test('openfda properties come from the newest download that has the product', async () => {
    expect(await props('1111-2222', 'rxcui')).toEqual(['111', '112']);
    expect(await props('1111-2222', 'spl_set_id')).toEqual(['set-1111']);
    expect(await props('1111-2222', 'is_original_packager')).toEqual(['true']);
    expect(await props('44444-555', 'rxcui')).toEqual(['444']);
    expect(await props('22222-333', 'rxcui')).toEqual(['222']);
    expect(stats.jsonProducts).toBe(3);
    expect(stats.jsonUnknownProducts).toBe(1);
  });

  describe('$lookup', () => {
    let provider;

    beforeAll(async () => {
      const opContext = new OperationContext('en', await TestUtilities.loadTranslations());
      const factory = new NdcServicesFactory(opContext.i18n, dbPath);
      await factory.load();
      provider = await factory.build(opContext, []);
    });

    afterAll(() => {
      provider.close();
    });

    test('the provider reports the version as YYYYMMDD', () => {
      expect(provider.version()).toBe('20260115');
    });

    const lookup = async (code, props = []) => {
      const params = [];
      await provider.extendLookup(code, props, params);
      const result = {};
      for (const p of params.filter(p => p.name === 'property')) {
        const name = p.part.find(x => x.name === 'code').valueCode;
        (result[name] = result[name] || []).push(p.part.find(x => x.name === 'value').valueString);
      }
      return result;
    };

    test('a product has its properties from the FDA files and openFDA', async () => {
      const props = await lookup('1111-2222');
      expect(props.application_number).toEqual(['NDA1']);
      expect(props.rxcui).toEqual(['111', '112']);
      expect(props.ndc_exclude_flag).toEqual(['N']);
    });

    test('a package has its own properties and its product\'s; where both have one, the package\'s', async () => {
      const props = await lookup('22222-333-44');
      expect(props.marketing_start_date).toEqual(['20100101']);
      expect(props.marketing_end_date).toEqual(['20140101']);
      expect(props.rxcui).toEqual(['222']);
      expect(props.application_number).toEqual(['ANDA2']);
      expect(props.ndc_exclude_flag).toEqual(['D']);
    });

    test('the 11 digit code gets the same properties (but its own code-type and synonym)', async () => {
      const eleven = await lookup('22222033344');
      const ten = await lookup('22222-333-44');
      expect(eleven['code-type']).toEqual(['11-digit']);
      expect(eleven.synonym).toEqual(['22222-333-44']);
      for (const props of [eleven, ten]) {
        delete props['code-type'];
        delete props.synonym;
      }
      expect(eleven).toEqual(ten);
    });

    test('only the properties asked for, when some are', async () => {
      expect(await lookup('1111-2222', ['rxcui', 'trade-name'])).toEqual({ rxcui: ['111', '112'], 'trade-name': ['CurrentName'] });
    });

    test('no empty properties (a product with no route or dose form)', async () => {
      const props = await lookup('33333-4444-5');
      for (const values of Object.values(props)) {
        expect(values.every(v => v !== '')).toBe(true);
      }
    });

    test('an 11 digit code that two packages share is the active one\'s', async () => {
      const located = await provider.locate('66666077701');
      expect(located.context.isPackage).toBe(true);
      expect((await lookup('66666077701')).synonym).toEqual(['66666-777-01']);
    });

    test('so the active package has the 11 digit code as a synonym, and the other doesn\'t', async () => {
      expect((await lookup('66666-777-01')).synonym).toEqual(['66666077701']);
      const loser = await lookup('66666-0777-1');
      expect(loser.synonym).toBeUndefined();
      expect(loser['code-type']).toEqual(['10-digit']);
    });
  });

  describe('filters', () => {
    let provider;

    beforeAll(async () => {
      const opContext = new OperationContext('en', await TestUtilities.loadTranslations());
      const factory = new NdcServicesFactory(opContext.i18n, dbPath);
      await factory.load();
      provider = await factory.build(opContext, []);
    });

    afterAll(() => {
      provider.close();
    });

    // the codes an include with these filters has, in order: the first filter's, checked against the rest
    const select = async (...filters) => {
      const prep = await provider.getPrepContext(true);
      for (const [prop, op, value] of filters) {
        await provider.filter(prep, true, prop, op, value);
      }
      const sets = await provider.executeFilters(prep);
      const codes = [];
      while (await provider.filterMore(prep, sets[0])) {
        const c = await provider.filterConcept(prep, sets[0]);
        let ok = true;
        for (const s of sets.slice(1)) {
          ok = ok && await provider.filterCheck(prep, s, c);
        }
        if (ok) {
          codes.push(c.code);
        }
      }
      return codes;
    };

    const inFilter = async (code, prop, op, value) => {
      const prep = await provider.getPrepContext(false);
      const set = await provider.filter(prep, false, prop, op, value);
      const located = await provider.filterLocate(prep, set, code);
      return located !== null && typeof located === 'object';
    };

    test('says which filters it does', async () => {
      expect(await provider.doesFilter('inactive', '=', 'true')).toBe(true);
      expect(await provider.doesFilter('inactive', '=', 'false')).toBe(true);
      expect(await provider.doesFilter('inactive', '=', 'yes')).toBe(false);
      expect(await provider.doesFilter('kind', '=', 'product')).toBe(true);
      expect(await provider.doesFilter('kind', '=', 'package')).toBe(true);
      expect(await provider.doesFilter('kind', '=', 'property')).toBe(false);
      expect(await provider.doesFilter('category', '=', 'NDA')).toBe(true);
      expect(await provider.doesFilter('category', 'in', 'NDA,ANDA')).toBe(true);
      expect(await provider.doesFilter('category', 'regex', 'N.*')).toBe(false);
      expect(await provider.doesFilter('trade-name', '=', 'x')).toBe(false);
    });

    test('a filter it does not do is an error', async () => {
      const prep = await provider.getPrepContext(true);
      await expect(provider.filter(prep, true, 'kind', '=', 'property')).rejects.toThrow();
    });

    test('inactive: products, then packages, in import order', async () => {
      expect(await select(['inactive', '=', 'true'])).toEqual([
        '22222-333', '66666-0777', '33333-4444', '44444-555',
        '22222-333-44', '33333-4444-5', '66666-0777-1', '44444-555-66'
      ]);
      expect(await select(['inactive', '=', 'false'])).toEqual([
        '1111-2222', '66666-777', '55555-6666',
        '1111-2222-01', '66666-777-01', '55555-6666-7'
      ]);
    });

    test('kind', async () => {
      expect(await select(['kind', '=', 'product'])).toEqual(['1111-2222', '66666-777', '22222-333', '66666-0777', '33333-4444', '55555-6666', '44444-555']);
      expect(await select(['kind', '=', 'package'])).toEqual(['1111-2222-01', '66666-777-01', '22222-333-44', '33333-4444-5', '66666-0777-1', '55555-6666-7', '44444-555-66']);
    });

    test('category: a package has its product\'s; the value must match exactly', async () => {
      expect(await select(['category', '=', 'ANDA'])).toEqual(['22222-333', '44444-555', '22222-333-44', '44444-555-66']);
      expect(await select(['category', 'in', 'NDA, BULK INGREDIENT'])).toEqual(['1111-2222', '55555-6666', '1111-2222-01', '55555-6666-7']);
      expect(await select(['category', '=', 'BULK'])).toEqual([]);
      expect(await select(['category', '=', 'nda'])).toEqual([]);
    });

    test('filters together', async () => {
      expect(await select(['kind', '=', 'package'], ['category', '=', 'OTC'], ['inactive', '=', 'false'])).toEqual(['66666-777-01']);
    });

    test('code-type 11-digit lists a shared 11 digit code once', async () => {
      expect(await select(['code-type', '=', '11-digit'])).toEqual(['01111222201', '66666077701', '22222033344', '33333444405', '55555666607', '44444055566']);
    });

    test('whether a code is in a filter, by its 10 or 11 digit code', async () => {
      expect(await inFilter('1111-2222-01', 'kind', '=', 'package')).toBe(true);
      expect(await inFilter('01111222201', 'kind', '=', 'package')).toBe(true);
      expect(await inFilter('1111-2222', 'kind', '=', 'package')).toBe(false);
      expect(await inFilter('1111-2222', 'kind', '=', 'product')).toBe(true);
      expect(await inFilter('22222033344', 'inactive', '=', 'true')).toBe(true);
      expect(await inFilter('22222-333-44', 'inactive', '=', 'false')).toBe(false);
      expect(await inFilter('22222-333-44', 'category', 'in', 'NDA,ANDA')).toBe(true);
      // the shared 11 digit code is the active package
      expect(await inFilter('66666077701', 'inactive', '=', 'false')).toBe(true);
      expect(await inFilter('9999-9999-99', 'kind', '=', 'package')).toBe(false);
    });

    test('the size of a filter', async () => {
      const prep = await provider.getPrepContext(true);
      const set = await provider.filter(prep, true, 'inactive', '=', 'true');
      expect(await provider.filterSize(prep, set)).toBe(8);
    });
  });
});
