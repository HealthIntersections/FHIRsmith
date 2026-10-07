/**
 * What the RxNorm text search actually asks the database for.
 *
 * Every token of a search is ANDed, and the tokens are matched against RXNSTEMS - but the
 * importer only stems words longer than two characters that start with a letter, so that
 * table holds nothing beginning with a digit. A token it cannot hold therefore took the
 * whole search to nothing: "acetaminophen" found 4496 codes in the March 2026 release and
 * "acetaminophen 500" found none, which is not what anyone expects from adding a dose.
 * Those tokens are now matched against STR instead.
 *
 * That leaves gaps in the numbering. searchFilter numbers a filter by its position among
 * the tokens; executeFilters renumbers the stem filters by their position among the joins,
 * which is no longer the same number. The alias, the placeholder and the parameter key all
 * carry it, and they have to move together - renaming the key alone leaves the query
 * asking for a parameter that was never bound, which sqlite answers by binding null and
 * matching nothing.
 *
 * These tests read the SQL rather than run it: no database is needed to see whether the
 * query is coherent, and the cases that matter are ones the small test extract may not
 * have data for.
 */

const { RxNormServices } = require('../../tx/cs/cs-rxnorm');
const { OperationContext } = require('../../tx/operation-context');
const { SearchFilterText } = require('../../tx/library/designations');
const { TestUtilities } = require('../test-utilities');

let provider;

beforeAll(async () => {
  const i18n = await TestUtilities.loadTranslations(await TestUtilities.loadLanguageDefinitions());
  const opContext = new OperationContext('en', i18n);
  // No database: searchFilter and executeFilters only build SQL.
  provider = new RxNormServices(opContext, [], null, { version: 'test', rels: [], reltypes: [], totalCodeCount: 0 });
});

async function queryFor(text) {
  const prep = await provider.getPrepContext(true);
  await provider.searchFilter(prep, new SearchFilterText(text), false);
  const set = await provider.executeFilters(prep);
  expect(set).toHaveLength(1);
  return set[0];
}

/** Every $parameter the query names must have been bound. */
function boundNames(filter) {
  const used = new Set((filter.sql.match(/\$\w+/g) || []).map((p) => p.substring(1)));
  const missing = [...used].filter((n) => !Object.prototype.hasOwnProperty.call(filter.params, n));
  return { used, missing };
}

describe('RxNorm text search', () => {
  test('a word is matched against the stem table', async () => {
    const q = await queryFor('acetaminophen');
    expect(q.sql).toContain('rxnstems as s0');
    expect(q.sql).toContain('s0.stem LIKE $stem0');
    expect(q.params.stem0).toBe('acetaminophen%');
    expect(boundNames(q).missing).toEqual([]);
  });

  test('a number is matched against the text, and joins nothing', async () => {
    const q = await queryFor('500');
    expect(q.sql).not.toContain('rxnstems');
    expect(q.sql).toContain('STR LIKE $text0');
    expect(q.params.text0).toBe('%500%');
    expect(boundNames(q).missing).toEqual([]);
  });

  test('a mixed search keeps both, and binds every parameter it names', async () => {
    const q = await queryFor('acetaminophen 500');
    expect(q.sql).toContain('rxnstems as s0');
    expect(q.sql).toContain('STR LIKE');
    expect(Object.values(q.params)).toContain('acetaminophen%');
    expect(Object.values(q.params)).toContain('%500%');
    expect(boundNames(q).missing).toEqual([]);
  });

  // The regression: 'mg' is too short to be stemmed into the table, so it sits between
  // two stem filters and the second one has to be renumbered from s3 to s1.
  test('renumbers alias, placeholder and key together when a token sits between stems', async () => {
    const q = await queryFor('acetaminophen 500 mg oral');
    expect(q.sql).toContain('rxnstems as s0');
    expect(q.sql).toContain('rxnstems as s1');
    expect(q.sql).not.toContain('rxnstems as s2');
    expect(q.sql).toContain('s1.stem LIKE $stem1');
    expect(q.sql).not.toMatch(/\$stem[2-9]/);
    expect(boundNames(q).missing).toEqual([]);
    // both words stemmed, both short tokens matched as text
    expect(Object.values(q.params).sort())
      .toEqual(['%500%', '%mg%', 'RXNORM', 'acetaminophen%', 'oral%'].sort());
  });

  test('the search term is matched as a prefix of the stem, so partial words work', async () => {
    const q = await queryFor('acetam');
    expect(q.params.stem0).toBe('acetam%');
  });
});
