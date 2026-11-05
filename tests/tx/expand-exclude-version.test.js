/**
 * S11: include one version of a code system, exclude another whole version
 * (e.g. US Edition minus International). The excluded version's codes used to
 * be listed with iteratorAll(), which hierarchical providers (SNOMED CT, LOINC,
 * ...) refuse ("Must override") - so the expansion failed with a 500. Now the
 * excluded version is asked about each included code instead (locate()).
 */

const { ValueSetExpander } = require('../../tx/workers/expand');

const SYSTEM = 'http://example.org/cs';

// a provider that can locate codes but can't list them
function fakeProvider(version, codes) {
  return {
    system: () => SYSTEM,
    version: () => version,
    iteratorAll: async () => { throw new Error('Must override'); },
    locate: async (code) => codes.includes(code) ? { context: { code }, message: null } : { context: null, message: undefined }
  };
}

function makeExpander(excludedCs) {
  const worker = {
    internalLimit: 1000,
    externalLimit: 1000,
    checkAndYield: async () => {},
    findCodeSystem: async () => excludedCs,
    checkSupplements: () => {},
    opContext: { log: () => {} }
  };
  const exp = new ValueSetExpander(worker, { versionsMatch: true });
  exp.checkResourceCanonicalStatus = () => {};
  exp.excludeSpecialCase = true;
  return exp;
}

describe('Exclude a whole other version of the included code system', () => {
  test('does not list the excluded version, and excludes the codes it knows', async () => {
    const v1 = fakeProvider('1', ['a', 'b']);
    const exp = makeExpander(v1);
    const expansion = {};
    await exp.excludeCodes({ system: SYSTEM, version: '1' }, 'ValueSet.compose.exclude[0]', { url: 'http://example.org/vs', vurl: 'http://example.org/vs' }, null, expansion, false, false);

    expect(await exp.isExcluded(SYSTEM, '2', 'a')).toBe(true);
    expect(await exp.isExcluded(SYSTEM, '2', 'b')).toBe(true);
    expect(await exp.isExcluded(SYSTEM, '2', 'c')).toBe(false);
    expect(await exp.isExcluded('http://example.org/other', '2', 'a')).toBe(false);
    expect(expansion.parameter.find(p => p.name === 'used-codesystem').valueUri).toBe(SYSTEM + '|1');
  });

  test('a provider that fails to locate a code does not exclude it', async () => {
    const v1 = fakeProvider('1', []);
    v1.locate = async () => { throw new Error('boom'); };
    const exp = makeExpander(v1);
    await exp.excludeCodes({ system: SYSTEM, version: '1' }, 'x', { url: 'u', vurl: 'u' }, null, {}, false, false);
    expect(await exp.isExcluded(SYSTEM, '2', 'a')).toBe(false);
  });

  test('outside the special case, a whole-system exclude still excludes by system', async () => {
    const v1 = fakeProvider('1', []);
    const exp = makeExpander(v1);
    exp.excludeSpecialCase = false;
    exp.params = { versionsMatch: false };
    await exp.excludeCodes({ system: SYSTEM }, 'x', { url: 'u', vurl: 'u' }, null, {}, false, false);
    expect(await exp.isExcluded(SYSTEM, '1', 'anything')).toBe(true);
  });

  test('a system + value set exclude walks the value set, not the code system', async () => {
    const cs = fakeProvider('1', ['a', 'b', 'c']);
    cs.isNotClosed = () => false;
    cs.listSupplements = () => [];
    const exp = makeExpander(cs);
    exp.excludeSpecialCase = false;
    exp.params = { versionsMatch: false };
    exp.doingVersion = false;
    exp.worker.pinValueSet = u => u;
    exp.worker.findValueSet = async () => ({ isContained: true });
    exp.worker.makeVurl = () => null;
    exp.worker.deadCheck = () => {};
    exp.expandValueSet = async () => ({ expansion: { contains: [
      { system: SYSTEM, code: 'a' }, { system: SYSTEM, code: 'z' }, { system: 'http://example.org/other', code: 'b' }] } });
    await exp.excludeCodes({ system: SYSTEM, valueSet: ['http://example.org/vs2'] }, 'x', { url: 'u', vurl: 'u' }, null, {}, false, false);
    expect(await exp.isExcluded(SYSTEM, '1', 'a')).toBe(true);
    expect(await exp.isExcluded(SYSTEM, '1', 'b')).toBe(false); // in the value set, but another system
    expect(await exp.isExcluded(SYSTEM, '1', 'c')).toBe(false); // in the code system, not the value set
    expect(await exp.isExcluded(SYSTEM, '1', 'z')).toBe(false); // in the value set, not the code system
  });
});
