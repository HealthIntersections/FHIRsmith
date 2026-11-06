const { Provider } = require('../../tx/provider');
const TranslateWorker = require('../../tx/workers/translate');

/**
 * $translate with targetScope, for the targets a code system makes itself (an edition to
 * edition translation): which source editions are asked, and how the targets are held to the
 * scope when they name a release the server doesn't have.
 */
describe('$translate: the source version picks one release', () => {
  const SCT = 'http://snomed.info/sct';
  const US = 'http://snomed.info/sct/731000124108';
  // three releases of the US edition, as a server holding them has them registered
  function factory(version) {
    return {
      version,
      asked: 0,
      system: () => SCT,
      async findImplicitConceptMaps(maps, source, sourceVersion) {
        this.asked++;
        if (sourceVersion && version.startsWith(sourceVersion)) {
          maps.push({ url: `${version}?fhir_cm=edition/900000000000207008` });
        }
      }
    };
  }

  test('an edition URI with no date is the release it resolves to, not every release of the edition', async () => {
    const releases = [factory(`${US}/version/20250301`), factory(`${US}/version/20250901`), factory(`${US}/version/20240901`)];
    const provider = Object.create(Provider.prototype);
    provider.conceptMapProviders = [];
    provider.codeSystemFactories = new Map();
    for (const f of releases) {
      provider.codeSystemFactories.set(`${SCT}|${f.version}`, f);
    }
    // the edition URI resolves to one of them (the library registers each release's partial version; the one it ends up with is the one)
    provider.codeSystemFactories.set(`${SCT}|${US}`, releases[1]);
    const maps = [];
    await provider.findConceptMapForTranslation(null, maps, SCT, US, null, null, `${SCT}|http://snomed.info/sct/900000000000207008`, '763875007');
    expect(maps.map(m => m.url)).toEqual([`${US}/version/20250901?fhir_cm=edition/900000000000207008`]);
    expect(releases.map(f => f.asked)).toEqual([0, 1, 0]);
  });
});

describe('$translate: holding a code system\'s own targets to the target scope', () => {
  const SCT = 'http://snomed.info/sct';
  const INTL = 'http://snomed.info/sct/900000000000207008';
  const VS = 'http://example.org/fhir/ValueSet/allergy';
  function worker(held, members) {
    const w = Object.create(TranslateWorker.prototype);
    w.asked = [];
    w.resolveCode = async (system, version) => ({ known: held.includes(version) });
    w.codeInScope = async (canonical, coding) => {
      w.asked.push(`${coding.version}#${coding.code}`);
      return members.includes(coding.code);
    };
    return w;
  }
  const match = (code, version) => ({ name: 'match', part: [{ name: 'concept', valueCoding: { system: SCT, version, code } }] });

  test('a release the server doesn\'t have is checked as a code of its edition, and noted', async () => {
    const w = worker([INTL], ['763875007']);
    const result = [match('763875007', `${INTL}/version/20250801`)];
    await w.holdToTargetScope(result, VS, {});
    expect(w.asked).toEqual([`${INTL}#763875007`]);
    expect(result).toHaveLength(1);
    expect(result[0].part[1]).toEqual({ name: 'note', valueString: `Checked against the target scope '${VS}' as a code of '${INTL}': '${INTL}/version/20250801' is not available on this server` });
  });

  test('when the server doesn\'t have the edition either, the target is kept, unchecked', async () => {
    const w = worker([], []);
    const result = [match('763875007', `${INTL}/version/20250801`)];
    await w.holdToTargetScope(result, VS, {});
    expect(w.asked).toEqual([]);
    expect(result).toHaveLength(1);
    expect(result[0].part[1].valueString).toMatch(/could not be checked against the target scope/);
  });

  test('a target that is not in the scope is dropped, and named once however many maps gave it', async () => {
    const v = `${INTL}/version/20250801`;
    const w = worker([v], []);
    const result = [match('1', v), match('1', v), match('1', v), { name: 'result', valueBoolean: true }];
    await w.holdToTargetScope(result, VS, {});
    expect(result.filter(p => p.name === 'match')).toHaveLength(0);
    expect(result.find(p => p.name === 'message').valueString).toBe(`A translation was left out because it is not in the target scope '${VS}': ${SCT}#1`);
  });
});
