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

  /** Validate, and return the (possibly transformed) expression. */
  function checked(expression) {
    const e = new SnomedExpressionParser().parse(expression);
    services.checkExpression(e);
    return e;
  }

  describe('attributes the MRCM marks as grouped are self-grouped when written ungrouped', () => {
    // Close To User Form -> Classifiable Form ("Adding a Self-grouped Attribute"),
    // as Ontoserver and Snowstorm do. Until Oct 2026 the ungrouped spelling was rejected.
    test('accepts an ungrouped |Finding site|, and moves it into a group of its own', () => {
      const e = checked('40468003:363698007=10200004');
      expect(e.refinements).toHaveLength(0);
      expect(e.refinementGroups).toHaveLength(1);
      expect(e.refinementGroups[0].refinements).toHaveLength(1);
      expect(e.refinementGroups[0].refinements[0].name.code).toBe('363698007');
    });

    test('accepts the same refinement inside a group, unchanged', () => {
      const e = checked('40468003:{363698007=10200004}');
      expect(e.refinements).toHaveLength(0);
      expect(e.refinementGroups).toHaveLength(1);
    });

    test('self-groups an ungrouped |Associated morphology| too, so the rule is not hard-coded to one attribute', () => {
      const e = checked('64572001:116676008=57977008');
      expect(e.refinements).toHaveLength(0);
      expect(e.refinementGroups).toHaveLength(1);
    });

    test('accepts several grouped attributes together', () => {
      expect(() => check('64572001:{363698007=10200004,116676008=57977008}')).not.toThrow();
    });

    test('a mixed expression where one refinement escaped the braces gets a second group, not a merged one', () => {
      const e = checked('64572001:{363698007=10200004},116676008=57977008');
      expect(e.refinements).toHaveLength(0);
      expect(e.refinementGroups).toHaveLength(2);
      expect(e.refinementGroups[1].refinements[0].name.code).toBe('116676008');
    });

    test('the self-grouped form renders with braces', () => {
      const e = checked('40468003:363698007=10200004');
      expect(services.renderExpression(e)).toContain('{');
    });
  });

  describe('attributes the MRCM marks as ungrouped', () => {
    test('leaves |Laterality| outside a group, because the concept model says it is ungrouped', () => {
      const e = checked('39607008:272741003=24028007');
      expect(e.refinements).toHaveLength(1);
      expect(e.refinementGroups).toHaveLength(0);
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
