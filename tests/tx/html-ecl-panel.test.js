/**
 * The ECL panel at <endpoint>/ecl.
 *
 * An expression constraint is not an operation on anything, so the panel runs it the same
 * way the CodeSystem operations tab runs a filter: a value set composing SNOMED CT with a
 * constraint filter, posted to $expand and marked transient so the expansion is what gets
 * rendered. What is different is where the answer goes. ECL is written by trial and error,
 * so the result is fetched as a fragment and put under the inputs, leaving the expression
 * where it is - and an error arrives the same way, as the rendered OperationOutcome, next
 * to the expression that caused it.
 *
 * The edition list is the part with something to get wrong: the factory map holds the same
 * factory under several keys, and one of them is the bare system uri, which is how the
 * default edition is known.
 */

const { TxHtmlRenderer } = require('../../tx/tx-html');

const SCT = 'http://snomed.info/sct';

const edition = (version, label) => ({
  system: () => SCT,
  version: () => version,
  describeVersion: () => label
});

const INTL = edition(SCT + '/900000000000207008/version/20250201', 'International 02/01/2025');
const AU = edition(SCT + '/32506021000036107/version/20260430', 'Australian 04/30/2026');
const LOINC = { system: () => 'http://loinc.org', version: () => '2.78', describeVersion: () => 'LOINC' };

// Keyed as library.js keys it: bare system for the default, then system|version for each.
function provider(entries) {
  return { codeSystemFactories: new Map(entries) };
}

const html = () => new TxHtmlRenderer(null, null, null, null, '/tx/r4');

describe('the SNOMED edition list', () => {
  test('lists each edition once, however many keys it has', () => {
    const versions = html().snomedVersions(provider([
      [SCT, INTL],
      [SCT + '|' + INTL.version(), INTL],
      [SCT + '|900000000000207008', INTL],
      [SCT + '|' + AU.version(), AU]
    ]));
    expect(versions.map((v) => v.label)).toEqual(['International 02/01/2025', 'Australian 04/30/2026']);
  });

  test('puts the default first and marks it', () => {
    const versions = html().snomedVersions(provider([[SCT, AU], [SCT + '|x', INTL]]));
    expect(versions[0].label).toBe('Australian 04/30/2026');
    expect(versions[0].isDefault).toBe(true);
    expect(versions[1].isDefault).toBe(false);
  });

  test('ignores code systems that are not SNOMED', () => {
    const versions = html().snomedVersions(provider([[SCT, INTL], ['http://loinc.org', LOINC]]));
    expect(versions).toHaveLength(1);
  });

  test('is empty when no edition is loaded', () => {
    expect(html().snomedVersions(provider([['http://loinc.org', LOINC]]))).toEqual([]);
  });
});
