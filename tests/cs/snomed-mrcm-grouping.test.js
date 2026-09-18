/**
 * MRCM grouping: an attribute the concept model marks as grouped may not be written
 * outside a relationship group.
 *
 * The MRCM attribute domain reference set carries a `grouped` flag per rule, and it had
 * been parsed into the rule set and then never read - so `40468003:363698007=10200004`
 * passed validation even though `363698007 |Finding site|` is a grouped attribute and
 * the expression is not classifiable. A SNOMED maintainer reviewing our postcoordinated
 * $subsumes test cases caught it.
 *
 * The other half of the rule matters as much as the first: `272741003 |Laterality|` is
 * ungrouped in the MRCM, so writing it outside a group is correct. These tests pin both
 * directions, so a future change that simply rejects every brace-less refinement fails
 * here rather than in the field.
 *
 * The concept ids come from the test SNOMED distribution (xsct 31000003106), and the
 * grouped flags were read out of its MRCM refset directly: |Finding site| and
 * |Associated morphology| carry grouped = 1, |Laterality| carries grouped = 0.
 */

const path = require('path');
const fs = require('fs');
const { SnomedFileReader } = require('../../tx/sct/structures');
const { SnomedServices } = require('../../tx/cs/cs-snomed');
const { SnomedExpressionParser } = require('../../tx/sct/expressions');

const cacheFolder = path.resolve(__dirname, '../../data/terminology-cache');
const cachePath = ['sct_test_20250909.cache', 'sct_test_20250909b.cache']
  .map(name => path.join(cacheFolder, name))
  .find(file => fs.existsSync(file));
const describeIfCache = cachePath ? describe : describe.skip;

if (!cachePath) {
  // eslint-disable-next-line no-console
  console.warn('sct_test_20250909.cache not present - MRCM grouping tests skipped');
}

describeIfCache('MRCM attribute grouping', () => {
  let services;

  beforeAll(async () => {
    const data = await new SnomedFileReader(cachePath).loadSnomedData();
    services = new SnomedServices(data).expressionServices;
  }, 120000);

  /** Validate exactly as locate() does - parser with no concept list, then checkExpression. */
  function check(expression) {
    services.checkExpression(new SnomedExpressionParser().parse(expression));
  }

  describe('attributes the MRCM marks as grouped', () => {
    test('rejects an ungrouped |Finding site|', () => {
      expect(() => check('40468003:363698007=10200004'))
        .toThrow(/requires the attribute 363698007 \|Finding site\| to be in a relationship group/);
    });

    test('accepts the same refinement inside a group', () => {
      expect(() => check('40468003:{363698007=10200004}')).not.toThrow();
    });

    test('rejects an ungrouped |Associated morphology| too, so the rule is not hard-coded to one attribute', () => {
      expect(() => check('64572001:116676008=57977008'))
        .toThrow(/requires the attribute 116676008 \|Associated morphology\| to be in a relationship group/);
    });

    test('accepts several grouped attributes together', () => {
      expect(() => check('64572001:{363698007=10200004,116676008=57977008}')).not.toThrow();
    });

    test('rejects a mixed expression where only one refinement escaped the braces', () => {
      expect(() => check('64572001:{363698007=10200004},116676008=57977008'))
        .toThrow(/to be in a relationship group/);
    });

    test('names the attribute and shows the corrected form, so the caller can act on it', () => {
      let message = '';
      try {
        check('40468003:363698007=10200004');
      } catch (e) {
        message = e.message;
      }
      expect(message).toContain('363698007 |Finding site|');
      expect(message).toContain('{363698007 |Finding site| = ...}');
    });
  });

  describe('attributes the MRCM marks as ungrouped', () => {
    test('accepts |Laterality| outside a group, because the concept model says it is ungrouped', () => {
      expect(() => check('39607008:272741003=24028007')).not.toThrow();
    });

    test('accepts a lateralised body structure nested inside a grouped |Finding site|', () => {
      expect(() => check('64572001:{363698007=(39607008:272741003=24028007)}')).not.toThrow();
    });
  });

  describe('expressions with no refinements are unaffected', () => {
    test.each([
      ['a plain concept', '40468003'],
      ['a conjunction', '40468003+3738000']
    ])('%s', (_label, expression) => {
      expect(() => check(expression)).not.toThrow();
    });
  });
});
