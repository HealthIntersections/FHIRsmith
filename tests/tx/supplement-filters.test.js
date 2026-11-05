// Filters on properties that a supplement defines (catalog X2): evaluated from the supplement,
// whatever the code system
const { SupplementPropertyFilter, splitFilters } = require('../../tx/workers/supplement-filters');

const supplement = {
  url: 'http://example.org/supp',
  jsonObj: {
    property: [{ code: 'group', type: 'code' }],
    concept: [
      { code: 'a', property: [{ code: 'group', valueCode: 'red' }] },
      { code: 'b', property: [{ code: 'group', valueCode: 'blue' }, { code: 'group', valueCode: 'red' }] },
      { code: 'c', property: [{ code: 'other', valueString: 'x' }], concept: [
        { code: 'c1', property: [{ code: 'group', valueCoding: { system: 'http://x', code: 'green' } }] }
      ] }
    ]
  }
};

const f = (op, value) => new SupplementPropertyFilter('group', op, value, [supplement]);

describe('SupplementPropertyFilter', () => {
  test('= matches any of a code\'s values, including nested concepts and Codings', () => {
    expect(f('=', 'red').codes()).toEqual(['a', 'b']);
    expect(f('=', 'green').codes()).toEqual(['c1']);
    expect(f('=', 'red').matches('c')).toBe(false);
  });

  test('in, regex and exists', () => {
    expect(f('in', 'blue,green').codes()).toEqual(['b', 'c1']);
    expect(f('regex', 'r.*').codes()).toEqual(['a', 'b']);
    expect(f('exists', 'true').codes()).toEqual(['a', 'b', 'c1']);
  });

  test('not-in and exists = false select codes the supplement says nothing about, so cannot drive', () => {
    expect(f('not-in', 'red').enumerable).toBe(false);
    expect(f('not-in', 'red').matches('zzz')).toBe(true);
    expect(f('not-in', 'red').matches('b')).toBe(false);
    expect(f('exists', 'false').enumerable).toBe(false);
    expect(f('exists', 'false').matches('c')).toBe(true);
  });

  test('splitFilters: the code system\'s own filters stay with it, even on a property a supplement also defines', async () => {
    const cs = { supplements: [supplement], doesFilter: async (prop) => prop === 'concept' };
    const split = await splitFilters(cs, [
      { property: 'concept', op: 'is-a', value: 'x' },
      { property: 'group', op: '=', value: 'red' },
      { property: 'unknown', op: '=', value: 'y' }
    ]);
    expect(split.base.map(fc => fc.property)).toEqual(['concept', 'unknown']);
    expect(split.supplement.map(sf => sf.toString())).toEqual(['group = red']);

    const owns = { supplements: [supplement], doesFilter: async () => true };
    expect((await splitFilters(owns, [{ property: 'group', op: '=', value: 'red' }])).supplement).toEqual([]);
  });
});
