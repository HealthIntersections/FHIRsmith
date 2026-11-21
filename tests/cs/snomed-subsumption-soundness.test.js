/**
 * Two soundness properties of postcoordinated $subsumes.
 *
 * 1. A PRIMITIVE concept's defining attributes are necessary conditions, so they must
 *    count when deciding whether something subsumes it - even though the concept itself
 *    may not be substituted for its definition. normaliseExpression used to drop them,
 *    which lost real answers: `64572001:{363698007=10200004}` genuinely does subsume
 *    `4846001 |Anicteric viral hepatitis|`, and the server said not-subsumed.
 *
 * 2. Structural comparison of normal forms is sound when it SUCCEEDS and not when it
 *    fails. SNOMED's OWL axiom refset carries GCIs and property chains whose entailments
 *    are baked into the distributed inferred relationships for precoordinated concepts;
 *    a postcoordinated expression is one the classifier never saw, so they are not
 *    available for it. A structural miss therefore proves nothing, and the server must
 *    decline rather than answer not-subsumed - which is the answer that wrongly drops a
 *    code out of a cohort.
 *
 * Both sides being plain concepts is a different case: there the transitive closure is
 * precomputed from the classifier's own output, so all four outcomes are sound.
 */

const path = require('path');
const fs = require('fs');
const { SnomedFileReader } = require('../../tx/sct/structures');
const { SnomedServices } = require('../../tx/cs/cs-snomed');
const { SnomedExpressionParser, SnomedServicesRenderOption } = require('../../tx/sct/expressions');

const cachePath = path.resolve(__dirname, '../../data/terminology-cache/sct_test_20250909.cache');
const haveCache = fs.existsSync(cachePath);
const describeIfCache = haveCache ? describe : describe.skip;

if (!haveCache) {
  // eslint-disable-next-line no-console
  console.warn('sct_test_20250909.cache not present - subsumption soundness tests skipped');
}

describeIfCache('postcoordinated subsumption soundness', () => {
  let services;
  let concepts;

  beforeAll(async () => {
    const data = await new SnomedFileReader(cachePath).loadSnomedData();
    const svc = new SnomedServices(data);
    services = svc.expressionServices;
    concepts = svc.concepts;
  }, 120000);

  function parse(code) {
    return new SnomedExpressionParser(concepts).parse(code);
  }
  function subsumes(a, b) {
    return services.expressionSubsumes(parse(a), parse(b));
  }
  function refOf(id) {
    const found = concepts.findConcept(id);
    expect(found.found).toBe(true);
    return found.index;
  }

  describe('a primitive concept keeps its entailed attributes', () => {
    // Guards the premise of the tests below: if the test distribution ever changes so
    // that this concept is fully defined, these tests would pass for the wrong reason.
    test('4846001 |Anicteric viral hepatitis| is primitive and carries a finding site', () => {
      expect(services.isPrimitive(refOf('4846001'))).toBe(true);
      const rels = services.getDefiningRelationships(refOf('4846001'));
      const attributes = rels.map(i => {
        const rel = services.relationships.getRelationship(i);
        return String(services.getConceptId(rel.relType)) + '=' + String(services.getConceptId(rel.target));
      });
      expect(attributes).toContain('363698007=10200004');
    });

    test('an expression on those attributes subsumes it', () => {
      expect(subsumes('64572001:{363698007=10200004}', '4846001')).toBe(true);
    });

    test('but the primitive does not subsume the expression, so they are not equivalent', () => {
      // This is the half that keeps the addition sound: the concept stays in the focus
      // as an atom nothing else can match, so its conditions never become sufficient.
      expect(subsumes('4846001', '64572001:{363698007=10200004}')).toBe(false);
    });

    test('a fully defined concept still behaves as before', () => {
      expect(subsumes('64572001:{363698007=10200004}', '19943007')).toBe(true);
    });

    test('the stored normal form of a primitive is still just the concept', () => {
      // The fix is at query time on purpose - createDefinedExpression stops at a
      // primitive too, so the cached normal forms say nothing useful here, and reading
      // the relationships instead means existing caches keep working.
      const nf = services.renderExpression(
        services.createNormalForm(refOf('4846001')), SnomedServicesRenderOption.Minimal);
      expect(nf).toBe('4846001');
    });
  });

  describe('structural comparison is sound in the positive direction only', () => {
    test.each([
      ['unrelated attribute values', '64572001:{363698007=10200004}', '64572001:{363698007=39607008}'],
      ['each side says something the other does not', '64572001:{116676008=57977008}', '64572001:{363698007=10200004}']
    ])('%s: neither direction is provable', (_label, a, b) => {
      expect(subsumes(a, b)).toBe(false);
      expect(subsumes(b, a)).toBe(false);
      // The caller must turn this pair of falses into a declined answer, not into
      // not-subsumed - see subsumesTest in cs-snomed.js.
    });
  });
});
