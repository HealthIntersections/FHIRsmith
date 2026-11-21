/**
 * Subsumption over a hierarchy stated in properties rather than in nesting.
 *
 * The subsumption tests in cs-cs.test.js all run against cs-simple.json, where the
 * hierarchy is the nesting: code2a sits inside code2. That is only one of the two ways
 * FHIR lets a CodeSystem say what its hierarchy is. The other is a flat concept list
 * where each concept names its parent in a property, and it is the one the real world
 * mostly uses -- every terminology.hl7.org code system is generated that way, with a
 * property called `subsumedBy`.
 *
 * Two things about that are easy to get wrong, and neither is exercised by a nested
 * code system:
 *
 *  - the property is not called `parent`. What makes it a hierarchy is its declared
 *    uri, http://hl7.org/fhir/concept-properties#parent; the code is whatever the
 *    author chose. A server that keys off the code alone sees an ordinary attribute
 *    and reports no hierarchy at all.
 *  - a concept can repeat the property, so it can have several parents. Nesting
 *    cannot state that -- a concept appears in exactly one place in a nested list --
 *    so multiple parents only ever arrive this way.
 */

const { CodeSystem } = require('../../tx/library/codesystem');
const { FhirCodeSystemProvider } = require('../../tx/cs/cs-cs');
const { OperationContext } = require('../../tx/operation-context');
const { TestUtilities } = require('../test-utilities');

const SYSTEM = 'http://hl7.org/fhir/test/CodeSystem/prop-hierarchy';
const PARENT_URI = 'http://hl7.org/fhir/concept-properties#parent';
const CHILD_URI = 'http://hl7.org/fhir/concept-properties#child';

/**
 * A flat code system whose hierarchy is entirely in properties.
 *
 *   root
 *     mid            via `subsumedBy` (declared with the #parent uri)
 *       leaf
 *   other
 *   shared           has both root and other as parents
 */
function propertyCodeSystem(propCode, propUri) {
  const concept = (code, parents) => ({
    code,
    display: code,
    property: parents.map(p => ({ code: propCode, valueCode: p }))
  });
  return {
    resourceType: 'CodeSystem',
    url: SYSTEM,
    version: '1.0.0',
    name: 'PropHierarchy',
    status: 'active',
    content: 'complete',
    caseSensitive: true,
    hierarchyMeaning: 'is-a',
    property: [propUri ? { code: propCode, uri: propUri, type: 'code' } : { code: propCode, type: 'code' }],
    concept: [
      concept('root', []),
      concept('mid', ['root']),
      concept('leaf', ['mid']),
      concept('other', []),
      concept('shared', ['root', 'other'])
    ]
  };
}

describe('subsumption over a property-stated hierarchy', () => {
  let opContext;

  beforeEach(async () => {
    opContext = new OperationContext('en-US',
      await TestUtilities.loadTranslations(await TestUtilities.loadLanguageDefinitions()));
  });

  const providerFor = (json) => new FhirCodeSystemProvider(opContext, new CodeSystem(json), []);

  describe('a property named `subsumedBy`, declared with the #parent uri', () => {
    let provider;

    beforeEach(() => {
      provider = providerFor(propertyCodeSystem('subsumedBy', PARENT_URI));
    });

    test('the code system reports a hierarchy even though nothing is nested', () => {
      expect(provider.hasParents()).toBe(true);
    });

    test('a parent named in a property subsumes the concept that names it', async () => {
      expect(await provider.subsumesTest('root', 'mid')).toBe('subsumes');
      expect(await provider.subsumesTest('mid', 'root')).toBe('subsumed-by');
    });

    test('subsumption follows the whole chain, not just the named parent', async () => {
      expect(await provider.subsumesTest('root', 'leaf')).toBe('subsumes');
      expect(await provider.subsumesTest('leaf', 'root')).toBe('subsumed-by');
    });

    test('a code is equivalent to itself', async () => {
      expect(await provider.subsumesTest('mid', 'mid')).toBe('equivalent');
    });

    test('unrelated codes are not subsumed either way', async () => {
      expect(await provider.subsumesTest('mid', 'other')).toBe('not-subsumed');
      expect(await provider.subsumesTest('other', 'leaf')).toBe('not-subsumed');
    });

    test('both parents of a multiply-parented concept subsume it', async () => {
      // this is the case nesting cannot state at all
      expect(await provider.subsumesTest('root', 'shared')).toBe('subsumes');
      expect(await provider.subsumesTest('other', 'shared')).toBe('subsumes');
      expect(await provider.subsumesTest('shared', 'root')).toBe('subsumed-by');
    });

    test('two parents of the same concept are not thereby related to each other', async () => {
      expect(await provider.subsumesTest('root', 'other')).toBe('not-subsumed');
      expect(await provider.subsumesTest('other', 'root')).toBe('not-subsumed');
    });

    test('an unknown code is an error, not a not-subsumed', async () => {
      await expect(provider.subsumesTest('root', 'nonexistent')).rejects.toThrow(/nonexistent/);
      await expect(provider.subsumesTest('nonexistent', 'root')).rejects.toThrow(/nonexistent/);
    });
  });

  describe('the uri is what makes it a hierarchy, not the property code', () => {
    test('the same property without the uri is just an attribute', async () => {
      // Identical concepts, identical property values -- the only difference is that the
      // property declaration carries no uri. There is then nothing in the resource that
      // says `subsumedBy` means parent, so there is no hierarchy to walk.
      const provider = providerFor(propertyCodeSystem('subsumedBy', null));
      expect(provider.hasParents()).toBe(false);
      expect(await provider.subsumesTest('root', 'leaf')).toBe('not-subsumed');
    });

    test('a property literally called `parent` needs no uri', async () => {
      const provider = providerFor(propertyCodeSystem('parent', null));
      expect(provider.hasParents()).toBe(true);
      expect(await provider.subsumesTest('root', 'leaf')).toBe('subsumes');
    });

    test('any code carrying the #parent uri works, whatever it is called', async () => {
      const provider = providerFor(propertyCodeSystem('isNarrowerThan', PARENT_URI));
      expect(await provider.subsumesTest('root', 'leaf')).toBe('subsumes');
    });
  });

  describe('the hierarchy stated downwards, with #child', () => {
    // The mirror form: a parent lists its children rather than a child naming its parent.
    const downwards = {
      resourceType: 'CodeSystem',
      url: SYSTEM,
      version: '1.0.0',
      name: 'ChildHierarchy',
      status: 'active',
      content: 'complete',
      caseSensitive: true,
      hierarchyMeaning: 'is-a',
      property: [{ code: 'contains', uri: CHILD_URI, type: 'code' }],
      concept: [
        { code: 'root', display: 'root', property: [{ code: 'contains', valueCode: 'mid' }] },
        { code: 'mid', display: 'mid', property: [{ code: 'contains', valueCode: 'leaf' }] },
        { code: 'leaf', display: 'leaf' },
        { code: 'other', display: 'other' }
      ]
    };

    test('a child property subsumes the same way round', async () => {
      const provider = providerFor(downwards);
      expect(await provider.subsumesTest('root', 'mid')).toBe('subsumes');
      expect(await provider.subsumesTest('root', 'leaf')).toBe('subsumes');
      expect(await provider.subsumesTest('leaf', 'root')).toBe('subsumed-by');
      expect(await provider.subsumesTest('root', 'other')).toBe('not-subsumed');
    });
  });

  describe('nesting and properties in the same code system', () => {
    // Nothing stops an author from using both, and a concept nested under one code can
    // name a second parent in a property -- which is how a mostly-nested code system
    // gets the one cross-link it needs.
    const mixed = {
      resourceType: 'CodeSystem',
      url: SYSTEM,
      version: '1.0.0',
      name: 'MixedHierarchy',
      status: 'active',
      content: 'complete',
      caseSensitive: true,
      hierarchyMeaning: 'is-a',
      property: [{ code: 'subsumedBy', uri: PARENT_URI, type: 'code' }],
      concept: [
        {
          code: 'root', display: 'root',
          concept: [{
            code: 'mid', display: 'mid',
            concept: [{
              code: 'leaf', display: 'leaf',
              property: [{ code: 'subsumedBy', valueCode: 'other' }]
            }]
          }]
        },
        { code: 'other', display: 'other' }
      ]
    };

    test('both routes to a concept count', async () => {
      const provider = providerFor(mixed);
      expect(await provider.subsumesTest('root', 'leaf')).toBe('subsumes');   // by nesting
      expect(await provider.subsumesTest('other', 'leaf')).toBe('subsumes');  // by property
      expect(await provider.subsumesTest('root', 'other')).toBe('not-subsumed');
    });
  });


  /**
   * Runs one hierarchy filter and returns the codes it selects, sorted.
   */
  async function filterCodes(json, op, value) {
    const provider = providerFor(json);
    const ctxt = await provider.getPrepContext(false);
    await provider.filter(ctxt, true, 'concept', op, value);
    const sets = await provider.executeFilters(ctxt);
    const out = [];
    sets[0].cursor = -1;
    while (await provider.filterMore(ctxt, sets[0])) {
      out.push((await provider.filterConcept(ctxt, sets[0])).code);
    }
    return out.sort();
  }

  describe('is-a / descendent-of / is-not-a over the same property hierarchy', () => {
    // A value set built on these operators is the other place the hierarchy has to be
    // read, and it goes through getDescendants rather than getAncestors - the opposite
    // direction, and a separate walk.
    const withUri = () => propertyCodeSystem('subsumedBy', PARENT_URI);

    test('is-a takes the named code and everything under it', async () => {
      expect(await filterCodes(withUri(), 'is-a', 'root')).toEqual(['leaf', 'mid', 'root', 'shared']);
    });

    test('descendent-of takes the same set without the named code', async () => {
      // the single difference between the two operators
      expect(await filterCodes(withUri(), 'descendent-of', 'root')).toEqual(['leaf', 'mid', 'shared']);
    });

    test('is-not-a is the exact complement of is-a, not of descendent-of', async () => {
      // the named code is excluded too, so this and the is-a above partition the system
      expect(await filterCodes(withUri(), 'is-not-a', 'root')).toEqual(['other']);
      expect(await filterCodes(withUri(), 'is-not-a', 'leaf')).toEqual(['mid', 'other', 'root', 'shared']);
    });

    test('descendent-leaf takes the descendants that have no children', async () => {
      expect(await filterCodes(withUri(), 'descendent-leaf', 'root')).toEqual(['leaf', 'shared']);
      expect(await filterCodes(withUri(), 'descendent-leaf', 'leaf')).toEqual([]);
    });

    test('child-of takes only the direct children', async () => {
      expect(await filterCodes(withUri(), 'child-of', 'root')).toEqual(['mid', 'shared']);
    });

    test('a multiply-parented concept is reached from either parent', async () => {
      // shared is under root by its first property and under other by its second
      expect(await filterCodes(withUri(), 'is-a', 'other')).toEqual(['other', 'shared']);
    });

    test('a leaf selects just itself', async () => {
      expect(await filterCodes(withUri(), 'is-a', 'leaf')).toEqual(['leaf']);
    });

    test('without the uri the filter is accepted and quietly selects nothing else', async () => {
      // This is the failure mode worth knowing about: the value set is well formed, the
      // server does not reject it, and is-a expands to a single code because there is no
      // hierarchy to descend. Nothing anywhere says the value set did not mean that.
      const noUri = propertyCodeSystem('subsumedBy', null);
      expect(await filterCodes(noUri, 'is-a', 'root')).toEqual(['root']);
      expect(await filterCodes(noUri, 'is-not-a', 'root')).toEqual(['leaf', 'mid', 'other', 'shared']);
    });
  });

  describe('a cycle in the properties', () => {
    // Nothing in the resource format stops an author writing a loop, and a naive walk up
    // the parents would spin forever. It has to terminate, whatever it then answers.
    const cyclic = {
      resourceType: 'CodeSystem',
      url: SYSTEM,
      version: '1.0.0',
      name: 'CyclicHierarchy',
      status: 'active',
      content: 'complete',
      caseSensitive: true,
      property: [{ code: 'subsumedBy', uri: PARENT_URI, type: 'code' }],
      concept: [
        { code: 'a', display: 'a', property: [{ code: 'subsumedBy', valueCode: 'b' }] },
        { code: 'b', display: 'b', property: [{ code: 'subsumedBy', valueCode: 'a' }] },
        { code: 'c', display: 'c' }
      ]
    };

    test('terminates rather than looping', async () => {
      const provider = providerFor(cyclic);
      expect(await provider.subsumesTest('a', 'b')).toBe('subsumes');
      expect(await provider.subsumesTest('a', 'c')).toBe('not-subsumed');
    });

    test('the descendant walk terminates too', async () => {
      // getAncestors and getDescendants are separate walks; both have to hold their own
      // visited set, or a value set filtered on a looping code system never expands
      expect(await filterCodes(cyclic, 'is-a', 'a')).toEqual(['a', 'b']);
      expect(await filterCodes(cyclic, 'is-not-a', 'a')).toEqual(['c']);
    });
  });
});
