/**
 * MRCM attribute domains: an attribute with more than one domain rule may be used
 * in ANY of its domains (issue #287).
 *
 * `42752001 |Due to|` has two mandatory rules in the MRCM attribute domain refset,
 * one for `404684003 |Clinical finding|` and one for `272379006 |Event|`. The check
 * used to AND them, so |Due to| was rejected on a finding for not being an event and
 * on an event for not being a finding. Cardinality had the same fault: the tightest
 * maximum across every rule applied, rather than the maximum for the domain the
 * focus concept is actually in.
 *
 * Optional rules are different: the only one internationally narrows |Laterality|
 * from |Anatomical structure| to the lateralizable body structure refset, and that
 * restriction still has to hold. These tests pin both halves.
 *
 * The concept ids come from the test SNOMED distribution (xsct 31000003106).
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
  console.warn('sct_test_20250909 cache not present - MRCM domain tests skipped');
}

describeIfCache('MRCM attribute domains', () => {
  let services;

  beforeAll(async () => {
    const data = await new SnomedFileReader(cachePath).loadSnomedData();
    services = new SnomedServices(data).expressionServices;
  }, 120000);

  /** Validate exactly as locate() does - parser with no concept list, then checkExpression. */
  function check(expression) {
    services.checkExpression(new SnomedExpressionParser().parse(expression));
  }

  function messageOf(expression) {
    try {
      check(expression);
    } catch (e) {
      return e.message;
    }
    return '';
  }

  describe('an attribute with several mandatory domains is valid in any of them', () => {
    test('|Due to| on a clinical finding', () => {
      expect(() => check('197270009:{42752001=789750003}')).not.toThrow();
    });

    test('|Due to| on an event', () => {
      expect(() => check('789750003:{42752001=197270009}')).not.toThrow();
    });

    test('|Due to| on a procedure is outside every domain, and the message names them all', () => {
      const message = messageOf('367430006:{42752001=789750003}');
      expect(message).toContain('does not allow the attribute 42752001');
      expect(message).toMatch(/in the domain 404684003 [^,]*, or in the domain 272379006/);
    });
  });

  describe('an optional rule still narrows the mandatory one', () => {
    test('|Laterality| on a lateralizable body structure', () => {
      expect(() => check('85562004:272741003=24028007')).not.toThrow();
    });

    test('|Laterality| on a body structure that is not lateralizable', () => {
      const message = messageOf('10200004:272741003=24028007');
      expect(message).toContain('only valid for concepts in 723264001');
      expect(message).not.toContain('in the domain 91723000');
    });

    test('|Laterality| on a disorder breaks both the domain and the restriction', () => {
      const message = messageOf('197270009:272741003=24028007');
      expect(message).toContain('in the domain 91723000');
      expect(message).toContain('for concepts in 723264001');
    });
  });

  describe('cardinality comes from the domain the focus concept is in', () => {
    // The international MRCM's differing limits (|Procedure device|, |Using device|,
    // |Property|) have no usable values in the test edition, so give |Due to| a
    // tighter in-group limit on events only, and put it back afterwards.
    let rules;
    let saved;

    beforeAll(() => {
      rules = services.mrcmAttributeDomains().get(services.conceptIndexOf(42752001n));
      saved = rules.map(rule => ({ ...rule }));
      const eventIndex = services.conceptIndexOf(272379006n);
      for (const rule of rules) {
        rule.maxInGroup = rule.domain === eventIndex ? 1 : Infinity;
      }
    });

    afterAll(() => {
      rules.forEach((rule, i) => Object.assign(rule, saved[i]));
    });

    test('a finding gets the finding limit', () => {
      expect(() => check('197270009:{42752001=789750003,42752001=773760007}')).not.toThrow();
    });

    test('an event gets the event limit', () => {
      expect(messageOf('789750003:{42752001=197270009,42752001=773760007}'))
        .toMatch(/at most 1 time\(s\) in one relationship group/);
    });
  });
});
