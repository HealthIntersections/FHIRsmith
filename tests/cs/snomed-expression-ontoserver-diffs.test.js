/**
 * Expressions found in published FHIR packages where Ontoserver's validation
 * disagreed with ours (October 2026). Each test pins Ontoserver's verdict; see the
 * notes on each for why, and for where our validation stood when they were added.
 *
 * These need the real international edition (the test distribution doesn't have
 * these concepts), so they are skipped when sct_intl_20250201.cache isn't present.
 */

const path = require('path');
const fs = require('fs');
const { SnomedFileReader } = require('../../tx/sct/structures');
const { SnomedServices } = require('../../tx/cs/cs-snomed');
const { SnomedExpressionParser } = require('../../tx/sct/expressions');
const folders = require('../../library/folder-setup');

const cachePath = folders.ensureFilePath('sct_intl_20250201.cache');
const describeIfCache = fs.existsSync(cachePath) ? describe : describe.skip;

if (!fs.existsSync(cachePath)) {
  // eslint-disable-next-line no-console
  console.warn('sct_intl_20250201.cache not present - Ontoserver expression comparison tests skipped');
}

describeIfCache('expressions where Ontoserver disagreed with us', () => {
  let services;

  beforeAll(async () => {
    const data = await new SnomedFileReader(cachePath).loadSnomedData();
    services = new SnomedServices(data).expressionServices;
  }, 300000);

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

  describe('attributes that are not in the concept model', () => {
    // None of these attributes has a domain rule in the MRCM attribute domain
    // reference set (for any content type), so the concept model doesn't allow them
    // on anything. |With|, |Permanence| and |Interpretation| aren't even concept
    // model attributes - they are linkage concepts under 246061005 |Attribute| -
    // and |Has definitional manifestation| is a concept model attribute with no rule.
    // Ontoserver rejects all of them; until Oct 2026 we accepted all of them, because
    // an attribute with no rule was not checked at all.

    test('|Has definitional manifestation| on a finding', () => {
      expect(messageOf('698595002:363705008=125149003')).toMatch(/does not define any domain for the attribute 363705008/);
    });

    test('|Permanence| on a finding', () => {
      expect(messageOf('249943000:260868000=6934004')).toMatch(/260868000/); // not a concept model attribute
    });

    test('|With| on a person', () => {
      expect(messageOf('116154003:20401003=(404684003)')).toMatch(/20401003/);
    });

    test('|Interpretation| (not |Has interpretation|) on a finding - difficulty', () => {
      expect(messageOf('365031000:280452008=371157007')).toMatch(/280452008/);
    });

    test('|Interpretation| (not |Has interpretation|) on a finding - unable', () => {
      expect(messageOf('365031000:280452008=371151008')).toMatch(/280452008/);
    });
  });

  describe('a grouped attribute used ungrouped in a nested expression', () => {
    // 47429007 |Associated with| is a grouped attribute in the MRCM, and here it is
    // used ungrouped inside the nested value of |Associated finding|. Ontoserver
    // accepts this (as does Snowstorm: ungrouped attributes that the MRCM says are
    // grouped are self-grouped when the expression is transformed to its normal
    // form). Until Oct 2026 we rejected it, insisting on {47429007 = ...}; now the
    // attribute is self-grouped (see selfGroupRefinements).
    test('413350009 context with a nested finding refined by |Associated with|', () => {
      const e = new SnomedExpressionParser().parse('413350009:{246090004=(404684003:47429007=63653004),408729009=261665006,408732007=410604004,408731000=410512000}');
      expect(() => services.checkExpression(e)).not.toThrow();
      const nested = e.refinementGroups[0].refinements[0].value;
      expect(nested.refinements).toHaveLength(0);
      expect(nested.refinementGroups).toHaveLength(1);
    });
  });
});
