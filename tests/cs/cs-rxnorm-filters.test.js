/**
 * RxNorm filters, totals, status and $lookup properties (bug report R1-R5)
 *
 * Runs against the RxNorm subset in tx/data/rxnorm, imported once into a scratch database.
 * The expected numbers were counted from the RRF files directly, not from the provider.
 *
 *  R1 - filters in one include are ANDed (the SAB filter used to be dropped: its parameter
 *       shared a name with the SAB the whole query is about)
 *  R2 - results and totals are concepts, not atoms
 *  R3 - concept (or code) = / in
 *  R4 - relationship filters take in (the union), and only RxNorm's own relationships count
 *  R5 - $lookup returns TTY, STY, SAB, and the relationships when asked for
 *  and - a concept whose display atom is obsolete (SUPPRESS = O) is inactive
 */

const fs = require('fs');
const sqlite3 = require('sqlite3');
const path = require('path');
const { RxNormImporter } = require('../../tx/importers/import-rxnorm.module');
const { RxNormServicesFactory, RxNormConcept } = require('../../tx/cs/cs-rxnorm');
const { OperationContext } = require('../../tx/operation-context');
const { TestUtilities } = require('../test-utilities');
const folders = require('../../library/folder-setup');


describe('RxNorm filters, totals, status and lookup', () => {
  const sourceDir = path.resolve(__dirname, '../../tx/data/rxnorm');
  const dbPath = folders.ensureFilePath('rxnorm-filters-testing.db');
  let factory;
  let provider;

  beforeAll(async () => {
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
    }
    const importer = new RxNormImporter(sourceDir, dbPath, 'TEST-2025-08-24', { verbose: false, createStems: false, progressCallback: null });
    await importer.import();
    const opContext = new OperationContext('en', await TestUtilities.loadTranslations(await TestUtilities.loadLanguageDefinitions()));
    factory = new RxNormServicesFactory(opContext.i18n, dbPath);
    provider = await factory.build(opContext, []);
  });

  afterAll(() => {
    if (provider) {
      provider.close();
    }
  });

  // run the filters together, as one include does, and return the set
  async function filterSet(...filters) {
    const ctxt = await provider.getPrepContext(true);
    for (const [prop, op, value] of filters) {
      await provider.filter(ctxt, true, prop, op, value);
    }
    const sets = await provider.executeFilters(ctxt);
    return { ctxt, set: sets[0] };
  }

  async function codes(...filters) {
    const { ctxt, set } = await filterSet(...filters);
    const result = [];
    while (await provider.filterMore(ctxt, set)) {
      result.push((await provider.filterConcept(ctxt, set)).code);
    }
    return result;
  }

  async function size(...filters) {
    const { ctxt, set } = await filterSet(...filters);
    return provider.filterSize(ctxt, set);
  }

  describe('R1: filters in one include are ANDed', () => {
    test('STY and SAB together give their intersection', async () => {
      expect(await size(['STY', '=', 'T121'])).toBe(3123);
      expect(await size(['SAB', '=', 'USP'])).toBe(403);
      expect(await size(['STY', '=', 'T121'], ['SAB', '=', 'USP'])).toBe(169);
    });

    test('two filters of the same kind are both applied', async () => {
      // T121 and T109 together: concepts that have both semantic types
      const both = await codes(['STY', '=', 'T121'], ['STY', '=', 'T109']);
      const t121 = new Set(await codes(['STY', '=', 'T121']));
      const t109 = new Set(await codes(['STY', '=', 'T109']));
      expect(both.length).toBeLessThan(Math.min(t121.size, t109.size));
      expect(both.every(c => t121.has(c) && t109.has(c))).toBe(true);
    });

    test('a value with a quote in it is matched as written', async () => {
      expect(await size(['SAB', '=', "O'Brien"])).toBe(0);
    });
  });

  describe('R2: results and totals are concepts, not atoms', () => {
    test('STY = T200 counts each concept once (36,375 atoms)', async () => {
      const result = await codes(['STY', '=', 'T200']);
      expect(result.length).toBe(25295);
      expect(new Set(result).size).toBe(25295);
      expect(await size(['STY', '=', 'T200'])).toBe(25295);
    });

    test('TTY in SCD,PSN: a concept with both atoms is one result (8,456 atoms)', async () => {
      const result = await codes(['TTY', 'in', 'SCD,PSN']);
      expect(result.length).toBe(6069);
      expect(new Set(result).size).toBe(6069);
    });

    test('the code system total counts concepts', async () => {
      expect(await provider.totalCount()).toBe(28488);
      const iter = await provider.iterator(null);
      let n = 0;
      const seen = new Set();
      for (let c = await provider.nextContext(iter); c; c = await provider.nextContext(iter)) {
        n++;
        seen.add(c.code);
      }
      expect(n).toBe(28488);
      expect(seen.size).toBe(28488);
    });

    test('the display is the main atom, not a prescribable name or tall man synonym', async () => {
      // 197589 has SCD, PSN and TMSY atoms
      const { ctxt, set } = await filterSet(['TTY', 'in', 'PSN,TMSY']);
      const found = await provider.filterLocate(ctxt, set, '197589');
      expect(found).toBeInstanceOf(RxNormConcept);
      expect(found.display).toBe('diazepam 10 MG Oral Tablet');
      const located = await provider.locate('197589');
      expect(await provider.display(located.context)).toBe('diazepam 10 MG Oral Tablet');
      expect(located.context.others).toContain('diazePAM 10 MG Oral Tablet');
    });
  });

  describe('R3: concept in', () => {
    test('concept in lists the codes', async () => {
      expect((await codes(['concept', 'in', '197589, 161,8163'])).sort()).toEqual(['161', '197589', '8163']);
    });

    test('code is accepted the same as concept', async () => {
      expect(await provider.doesFilter('code', 'in', '161,8163')).toBe(true);
      expect((await codes(['code', 'in', '161,8163'])).sort()).toEqual(['161', '8163']);
      expect(await codes(['concept', '=', '161'])).toEqual(['161']);
    });

    test('an unknown code is just not there', async () => {
      expect(await codes(['concept', 'in', '161,999999999'])).toEqual(['161']);
    });
  });

  describe('R4: relationship in', () => {
    test('has_ingredient in two ingredients is the union of the two = filters', async () => {
      const acetaminophen = await codes(['has_ingredient', '=', 'CUI:161']);
      const phenylephrine = await codes(['has_ingredient', '=', 'CUI:8163']);
      expect(acetaminophen.length).toBe(962);
      expect(phenylephrine.length).toBe(983);
      const union = await codes(['has_ingredient', 'in', 'CUI:161,CUI:8163']);
      expect(union.length).toBe(1784);
      expect(new Set(union)).toEqual(new Set([...acetaminophen, ...phenylephrine]));
    });

    test('an AUI: value follows atom-level rows, from any source', async () => {
      // Atom-level RXNREL rows leave RXCUI1 and RXCUI2 empty, and most come from sources other
      // than RxNorm. The test data has none, so add one: MMSL's diazepam ingredient atom (101186,
      // concept 3322) is the ingredient of its diazepam 10 MG oral tablet atom (8241449, 197589)
      await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath);
        db.run(`INSERT INTO RXNREL (RXCUI1, RXAUI1, REL, RXCUI2, RXAUI2, RELA, SAB)
                VALUES ('', '101186', 'RO', '', '8241449', 'has_ingredient', 'MMSL')`,
          err => db.close(() => err ? reject(err) : resolve()));
      });
      expect(await codes(['has_ingredient', '=', 'AUI:101186'])).toEqual(['197589']);
      // and with CUI: values, which only use RxNorm's own concept-level rows
      const both = await codes(['has_ingredient', 'in', 'AUI:101186,CUI:161']);
      expect(both).toContain('197589');
      expect(both.length).toBe(963);
    });

    test('a relationship value must be CUI: or AUI:', async () => {
      expect(await provider.doesFilter('has_ingredient', 'in', 'CUI:161,CUI:8163')).toBe(true);
      expect(await provider.doesFilter('has_ingredient', 'in', 'CUI:161,8163')).toBe(false);
    });

    test('relationships combine with other filters', async () => {
      expect(await size(['has_ingredient', 'in', 'CUI:161,CUI:8163'], ['STY', '=', 'T121'])).toBe(0);
    });
  });

  describe('obsolete concepts are inactive', () => {
    test('SUPPRESS = O on the display atom', async () => {
      const obsolete = (await provider.locate('102152')).context;
      expect(await provider.isInactive(obsolete)).toBe(true);
      expect(await provider.getStatus(obsolete)).toBe('obsolete');
      const current = (await provider.locate('197589')).context;
      expect(await provider.isInactive(current)).toBe(false);
      expect(await provider.getStatus(current)).toBeNull();
    });

    test('concepts from a filter know their status', async () => {
      const { ctxt, set } = await filterSet(['concept', 'in', '102152,197589']);
      const status = {};
      while (await provider.filterMore(ctxt, set)) {
        const c = await provider.filterConcept(ctxt, set);
        status[c.code] = await provider.isInactive(c);
      }
      expect(status).toEqual({ '102152': true, '197589': false });
    });
  });

  describe('R5: $lookup properties', () => {
    const props = (params, name) => params.filter(p => p.name === 'property' && p.part[0].valueCode === name).map(p => p.part[1].valueCode);

    test('TTY, STY and SAB by default, not the relationships', async () => {
      const params = [];
      await provider.extendLookup('197589', [], params);
      expect(props(params, 'TTY')).toEqual(['PSN', 'SCD', 'TMSY']);
      expect(props(params, 'STY')).toEqual(['T200']);
      expect(props(params, 'SAB')).toEqual(['GS', 'MMSL', 'MMX', 'MTHSPL', 'NDDF', 'RXNORM', 'SNOMEDCT_US', 'VANDF']);
      expect(props(params, 'has_tradename')).toEqual([]);
    });

    test('* adds RxNorm\'s relationships, valued with the bare RXCUI', async () => {
      const params = [];
      await provider.extendLookup('197589', ['*'], params);
      expect(props(params, 'TTY')).toEqual(['PSN', 'SCD', 'TMSY']);
      expect(props(params, 'consists_of')).toEqual(['315796']);
      expect(props(params, 'has_dose_form')).toEqual(['317541']);
      expect(props(params, 'has_tradename')).toEqual(['104701', '200933', '200934', '200935', '200936']);
      expect(props(params, 'isa')).toEqual(['1155861', '1155862', '371786']);
    });

    test('named properties: only those', async () => {
      const params = [];
      await provider.extendLookup('197589', ['has_dose_form', 'STY'], params);
      expect(params.map(p => p.part[0].valueCode).sort()).toEqual(['STY', 'has_dose_form']);
    });

    test('a relationship property value finds the code again as a filter', async () => {
      // 197589 has_dose_form 317541 (as a lookup property) <=> has_dose_form = CUI:317541 (as a filter)
      expect(await codes(['has_dose_form', '=', 'CUI:317541'])).toContain('197589');
    });
  });
});
