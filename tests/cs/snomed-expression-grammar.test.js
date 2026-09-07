/**
 * Compositional grammar: the comma before an attribute group is optional.
 *
 * The SCG ABNF is
 *   refinement   = (attributeSet / attributeGroup) *( ws ["," ws] attributeGroup )
 *   attributeSet = attribute *(ws "," ws attribute)
 * so a comma is REQUIRED between the ungrouped attributes of the attribute set, but is
 * OPTIONAL before each attribute group. The parser used one comma-separated loop for
 * both and so required it everywhere.
 *
 * That was not merely strict, it was self-contradictory: renderExpression(Minimal) put no
 * separator between the last ungrouped attribute and the first '{', so the server handed
 * back a `normalized-code` in $validate-code that it then rejected if you sent it straight
 * back. `249943000:260868000=6934004{363698007=72098002}` - the normal form of a perfectly
 * ordinary finding - failed to parse at all.
 *
 * Both halves are fixed: the parser takes either spelling, and the renderer now emits the
 * comma, so the normal form is the explicit one. The round-trip suite at the bottom pins
 * the invariant rather than the one string: anything the renderer emits must re-parse, and
 * re-render identically.
 *
 * The parser has always also accepted ungrouped attributes AFTER a group, which the ABNF
 * does not allow. That leniency is deliberately preserved - it is pinned below so that a
 * future tightening is a decision someone makes, not a side effect.
 */

const path = require('path');
const fs = require('fs');
const { SnomedExpressionParser, SnomedServicesRenderOption } = require('../../tx/sct/expressions');
const { SnomedFileReader } = require('../../tx/sct/structures');
const { SnomedServices } = require('../../tx/cs/cs-snomed');

/** Parse with no concept list, so these tests need no SNOMED distribution loaded. */
function parse(expression) {
  return new SnomedExpressionParser().parse(expression);
}

function shape(expression) {
  const e = parse(expression);
  return { ungrouped: e.refinements.length, groups: e.refinementGroups.map(g => g.refinements.length) };
}

describe('SCG refinement syntax', () => {

  describe('the comma before an attribute group is optional', () => {
    test.each([
      ['with a comma', '249943000:260868000=6934004,{363698007=72098002}'],
      ['without a comma', '249943000:260868000=6934004{363698007=72098002}'],
      ['with whitespace and no comma', '249943000 : 260868000 = 6934004 { 363698007 = 72098002 }'],
      ['with terms and no comma',
        '249943000|Weakness of distal arms and legs|:260868000|Permanence|=6934004|Permanent|' +
        '{363698007|Finding site|=72098002|Entire left upper arm|}']
    ])('%s', (_name, expression) => {
      expect(() => parse(expression)).not.toThrow();
      expect(shape(expression)).toEqual({ ungrouped: 1, groups: [1] });
    });

    test('both spellings produce the same parse', () => {
      expect(shape('249943000:260868000=6934004,{363698007=72098002}'))
        .toEqual(shape('249943000:260868000=6934004{363698007=72098002}'));
    });

    test('and it is optional between two groups as well', () => {
      expect(shape('249943000:{363698007=72098002}{260868000=6934004}'))
        .toEqual({ ungrouped: 0, groups: [1, 1] });
      expect(shape('249943000:{363698007=72098002},{260868000=6934004}'))
        .toEqual({ ungrouped: 0, groups: [1, 1] });
    });
  });

  describe('the comma between ungrouped attributes is still required', () => {
    test('two ungrouped attributes separated by a comma', () => {
      expect(shape('249943000:260868000=6934004,363698007=72098002'))
        .toEqual({ ungrouped: 2, groups: [] });
    });

    test('two ungrouped attributes with no comma is not two attributes', () => {
      // 6934004363698007 runs together into one concept id, so this must not silently
      // parse as a pair - whatever it does, it does not produce two refinements.
      let parsed = null;
      try {
        parsed = shape('249943000:260868000=6934004 363698007=72098002');
      } catch (e) {
        parsed = null;
      }
      expect(parsed).not.toEqual({ ungrouped: 2, groups: [] });
    });
  });

  describe('malformed refinements are still rejected', () => {
    test.each([
      ['a trailing comma', '249943000:260868000=6934004,'],
      ['a colon with nothing after it', '249943000:'],
      ['an empty group', '249943000:{}'],
      ['a leading comma', '249943000:,{363698007=72098002}'],
      ['an unclosed group', '249943000:{363698007=72098002'],
      ['an attribute with no value', '249943000:260868000=']
    ])('rejects %s', (_name, expression) => {
      expect(() => parse(expression)).toThrow();
    });
  });

  describe('nested and multi-focus expressions are unaffected', () => {
    test('a nested sub-expression in an attribute value', () => {
      expect(() => parse('27658006:411116001=385049006{127489000=372687004,111115=(111115:111115=#500)}'))
        .not.toThrow();
    });

    test('a focus concept conjunction', () => {
      expect(shape('421720008+7946007:{363698007=72098002}')).toEqual({ ungrouped: 0, groups: [1] });
    });

    test('a definition status prefix', () => {
      expect(() => parse('===249943000:260868000=6934004{363698007=72098002}')).not.toThrow();
    });
  });

  describe('leniency the parser has always had, pinned so it is not lost by accident', () => {
    test('ungrouped attributes after a group, which the ABNF does not permit', () => {
      expect(shape('249943000:{363698007=72098002},260868000=6934004'))
        .toEqual({ ungrouped: 1, groups: [1] });
    });
  });
});

// The renderer needs a loaded distribution. tx/data/snomed-testing.cache is in git; the
// full international cache is the fallback for a working tree that has one.
const committedCachePath = path.resolve(__dirname, '../../tx/data/snomed-testing.cache');
const haveCache = fs.existsSync(committedCachePath);
const describeIfCache = haveCache ? describe : describe.skip;

if (!haveCache) {
  // eslint-disable-next-line no-console
  console.warn('tx/data/snomed-testing.cache not present - expression round-trip tests skipped');
}

describeIfCache('rendered expressions re-parse', () => {
  let services;

  beforeAll(async () => {
    const data = await new SnomedFileReader(committedCachePath).loadSnomedData();
    services = new SnomedServices(data).expressionServices;
  }, 120000);

  // Concept ids from the test distribution: 272741003 |Laterality| is ungrouped in the
  // MRCM, 116676008 |Associated morphology| and 363698007 |Finding site| are grouped, so
  // these are the shapes that actually mix an attribute set with a group.
  const expressions = [
    '40468003:{363698007=10200004}',
    '64572001:272741003=24028007,{116676008=57977008}',
    '64572001:272741003=24028007{116676008=57977008}'
  ];

  test.each(expressions)('%s round-trips through the minimal renderer', (expression) => {
    const rendered = services.renderExpression(
      services.parseExpression(expression), SnomedServicesRenderOption.Minimal);

    // This is the bug: the server handed this string back as `normalized-code` and then
    // refused to parse it.
    expect(() => services.parseExpression(rendered)).not.toThrow();

    const again = services.renderExpression(
      services.parseExpression(rendered), SnomedServicesRenderOption.Minimal);
    expect(again).toBe(rendered);
  });

  test('the two spellings normalise to one form, and it is the one with the comma', () => {
    const render = (e) => services.renderExpression(
      services.parseExpression(e), SnomedServicesRenderOption.Minimal);
    const withComma = '64572001:272741003=24028007,{116676008=57977008}';
    const without = '64572001:272741003=24028007{116676008=57977008}';
    expect(render(without)).toBe(render(withComma));
    expect(render(without)).toBe(withComma);
  });

  test('a group-only expression gains no leading comma', () => {
    expect(services.renderExpression(
      services.parseExpression('40468003:{363698007=10200004}'), SnomedServicesRenderOption.Minimal))
      .toBe('40468003:{363698007=10200004}');
  });
});
