/**
 * The library gives every provider an id space: the prefix the library YAML gives for its
 * source (folder:some/where=mine), or an autonumbered one that doesn't clash with any given
 * prefix - and every resource is served with its id in that space.
 */
const { Library } = require('../../tx/library');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');

describe('Library id prefixes', () => {
  let tmpDir;
  let yamlPath;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lib-prefix-test-'));
    yamlPath = path.join(tmpDir, 'library.yml');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function createLibrary() {
    const log = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
    const stats = { addStat: jest.fn() };
    return new Library(yamlPath, undefined, log, stats);
  }

  // a folder source holding a CodeSystem, a ValueSet and a ConceptMap, all with the same id
  async function folder(name) {
    const dir = path.join(tmpDir, name);
    await fs.mkdir(dir);
    const url = `http://example.org/${name}`;
    await fs.writeFile(path.join(dir, 'cs.json'), JSON.stringify({
      resourceType: 'CodeSystem', id: 'thing', url: `${url}/CodeSystem/thing`, version: '1.0.0',
      status: 'active', content: 'complete', concept: [{ code: 'a' }]
    }));
    await fs.writeFile(path.join(dir, 'vs.json'), JSON.stringify({
      resourceType: 'ValueSet', id: 'thing', url: `${url}/ValueSet/thing`, version: '1.0.0',
      status: 'active', compose: { include: [{ system: `${url}/CodeSystem/thing` }] }
    }));
    await fs.writeFile(path.join(dir, 'cm.json'), JSON.stringify({
      resourceType: 'ConceptMap', id: 'thing', url: `${url}/ConceptMap/thing`, version: '1.0.0',
      status: 'active', group: [{ source: `${url}/CodeSystem/thing`, target: `${url}/CodeSystem/thing`,
        element: [{ code: 'a', target: [{ code: 'a', relationship: 'equivalent' }] }] }]
    }));
    return dir;
  }

  async function writeYaml(sources) {
    await fs.writeFile(yamlPath, [
      'base:',
      '  url: https://storage.googleapis.com/tx-fhir-org',
      'sources:',
      ...sources.map(s => `  - ${s}`)
    ].join('\n'));
  }

  test('given prefixes are used, the rest are numbered around them, and every id is prefixed', async () => {
    const a = await folder('a');
    const b = await folder('b');
    const c = await folder('c');
    await writeYaml([`folder:${a}`, `folder:${b}=mine`, `folder:${c}=1`]);

    const library = createLibrary();
    await library.load();

    // a is autonumbered, and skips 1 because c has it
    expect(library.codeSystemProviders.map(p => p.spaceId)).toEqual(['2', 'mine', '1']);
    expect(library.valueSetProviders.map(p => p.spaceId)).toEqual(['2', 'mine', '1']);
    expect(library.conceptMapProviders.map(p => p.spaceId)).toEqual(['2', 'mine', '1']);

    const csIds = library.codeSystemProviders.map(p => p.codeSystems[0].id);
    expect(csIds).toEqual(['2-thing', 'mine-thing', '1-thing']);

    const mine = library.valueSetProviders[1];
    const vs = await mine.fetchValueSetById('mine-thing');
    expect(vs).not.toBeNull();
    expect(vs.jsonObj.id).toBe('mine-thing');
    expect(await mine.fetchValueSetById('thing')).toBeNull();

    const cmp = library.conceptMapProviders[1];
    const cm = await cmp.fetchConceptMapById('mine-thing');
    expect(cm).not.toBeNull();
    expect(cm.jsonObj.id).toBe('mine-thing');
    expect(await cmp.fetchConceptMapById('thing')).toBeNull();
  }, 30000);

  test('a prefix given twice is an error', async () => {
    const a = await folder('a');
    const b = await folder('b');
    await writeYaml([`folder:${a}=same`, `folder:${b}=same`]);
    await expect(createLibrary().load()).rejects.toThrow(/'same' is given for both/);
  });

  test('a prefix that is not a valid id start, or is reserved, is an error', async () => {
    const a = await folder('a');
    for (const prefix of ['a-b', 'core', 'x', '']) {
      await writeYaml([`folder:${a}=${prefix}`]);
      await expect(createLibrary().load()).rejects.toThrow(/Invalid source/);
    }
  });
});
