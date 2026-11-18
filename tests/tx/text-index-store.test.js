/**
 * The text index store (tx/library/text-index-store.js): the text indexes of the code systems and
 * supplements loaded at startup, in SQLite, kept from one run to the next. Searched as NameIndex is,
 * with the same answers
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { TextIndexStore, StoredNameIndex } = require('../../tx/library/text-index-store');
const { NameIndex, TextQuery } = require('../../tx/library/text-match');
const { SupplementTextIndex } = require('../../tx/library/supplement-text-index');
const { SearchFilterText } = require('../../tx/library/designations');

const CONCEPTS = [
  { code: 'AP', display: 'Acute appendicitis', designation: [{ language: 'de', value: 'Akute Blinddarmentzündung' }] },
  { code: 'AA', display: 'Applied action' },
  { code: 'run-1', display: 'Running water', designation: [{ language: 'en-GB', value: 'Runs of water' }] },
  { code: 'Calc', display: 'Calcium in serum or plasma' },
  { code: 'x', display: 'Café crème', designation: [{ language: 'fr', value: 'Café crème' }] }
];

function codeSystem(concepts, language = null) {
  return { jsonObj: { content: 'complete', ...(language ? { language } : {}) }, url: 'http://example.org/cs', version: '1', getAllConcepts: () => concepts };
}

function item(cs, lang = 'en') {
  return { object: cs, kind: 'cs', url: cs.url, version: cs.version, lang, size: cs.getAllConcepts().length,
    fill: sink => TextIndexStore.fillCodeSystem(cs.getAllConcepts(), lang, sink) };
}

async function memoryIndex(concepts, lang = 'en') {
  const index = new NameIndex();
  TextIndexStore.fillCodeSystem(concepts, lang, index);
  return await index.build();
}

describe('TextIndexStore', () => {
  let dir;
  let file;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'text-index-store-'));
    file = path.join(dir, 'sub', 'text-indexes.db');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test.each([
    ['acute app', 'en'], ['ap', 'en'], ['appendicitis', 'en'], ['run', 'en'], ['running', 'en-GB'], ['runs water', 'en'],
    ['calcium plasma', 'en'], ['cafe', 'en'], ['café', 'fr'], ['blinddarm', 'de'], ['akut', 'de'], ['nothing', 'en'], ['', 'en'],
    ['calc', 'en'], ['RUN-', 'en']
  ])('"%s" in %s: the same names and codes as the in-memory index', async (text, lang) => {
    const cs = codeSystem(CONCEPTS);
    const store = new TextIndexStore(file).open();
    try {
      await store.prepare([item(cs)]);
      const stored = TextIndexStore.indexFor(cs);
      expect(stored).toBeInstanceOf(StoredNameIndex);
      expect(stored.size).toBe(CONCEPTS.length);
      const memory = await memoryIndex(CONCEPTS);
      const query = new TextQuery(text);
      expect([...stored.searchNames(query, lang).entries()]).toEqual([...memory.searchNames(query, lang).entries()]);
      expect(stored.searchCodes(query)).toEqual(memory.searchCodes(query));
      expect([...stored.languages()].sort()).toEqual([...memory.languages()].sort());
    } finally {
      store.close();
    }
  });

  test('a later run uses the index an earlier one built; one nothing uses is deleted when the server has started', async () => {
    const cs = codeSystem(CONCEPTS);
    const other = codeSystem(CONCEPTS.slice(0, 2));
    let store = new TextIndexStore(file).open();
    let result = await store.prepare([item(cs), item(other)]);
    expect(result).toEqual({ kept: 0, built: 2, objects: 2 });
    expect(store.finish()).toBe(0);
    store.close();

    // the same content, in new objects (a restart): kept; the other is no longer loaded
    const again = codeSystem(CONCEPTS.map(c => ({ ...c })));
    store = new TextIndexStore(file).open();
    result = await store.prepare([item(again)]);
    expect(result).toEqual({ kept: 1, built: 0, objects: 1 });
    expect(store.finish()).toBe(1);
    expect(store.summary().indexes).toBe(1);
    expect(TextIndexStore.indexFor(again).searchCodes(new TextQuery('ap'))).toEqual([0]);
    store.close();

    // changed content under the same url and version: a new index
    const changed = codeSystem([...CONCEPTS, { code: 'new', display: 'Something new' }]);
    store = new TextIndexStore(file).open();
    result = await store.prepare([item(changed)]);
    expect(result).toEqual({ kept: 0, built: 1, objects: 1 });
    expect(store.finish()).toBe(1);
    expect([...TextIndexStore.indexFor(changed).searchNames(new TextQuery('something'), 'en').keys()]).toEqual([5]);
    // what the dropped indexes had is gone from the names table
    expect(store.db.prepare('SELECT count(*) AS n FROM names').get().n)
      .toBe(store.db.prepare('SELECT sum(names) AS n FROM indexes').get().n);
    store.close();
  });

  test('objects with the same content share one index', async () => {
    const a = codeSystem(CONCEPTS);
    const b = codeSystem(CONCEPTS.map(c => ({ ...c })));
    const store = new TextIndexStore(file).open();
    try {
      const result = await store.prepare([item(a), item(b)]);
      expect(result).toEqual({ kept: 0, built: 1, objects: 2 });
      expect(TextIndexStore.indexFor(a)).toBe(TextIndexStore.indexFor(b));
    } finally {
      store.close();
    }
  });

  test('read only (a tx-worker): uses what is there, builds nothing, deletes nothing', async () => {
    const cs = codeSystem(CONCEPTS);
    let store = new TextIndexStore(file).open();
    await store.prepare([item(cs)]);
    store.close();
    const known = codeSystem(CONCEPTS.map(c => ({ ...c })));
    const unknown = codeSystem(CONCEPTS.slice(1));
    store = new TextIndexStore(file, { readOnly: true }).open();
    try {
      const result = await store.prepare([item(known), item(unknown)]);
      expect(result).toEqual({ kept: 1, built: 0, objects: 1 });
      expect(TextIndexStore.indexFor(unknown)).toBeNull();
      expect(store.finish()).toBe(0);
    } finally {
      store.close();
    }
  });

  test('an index another process deleted is not used: the caller indexes in memory', async () => {
    const cs = codeSystem(CONCEPTS);
    const store = new TextIndexStore(file).open();
    const other = new TextIndexStore(file).open();
    try {
      await store.prepare([item(cs)]);
      expect(TextIndexStore.indexFor(cs)).toBeInstanceOf(StoredNameIndex);
      other.run = store.run + 1;
      expect(other.finish()).toBe(1);
      expect(TextIndexStore.indexFor(cs)).toBeNull();
    } finally {
      other.close();
      store.close();
    }
  });

  test('read only, with no store: it does not open', () => {
    expect(() => new TextIndexStore(file, { readOnly: true }).open()).toThrow();
  });

  test('a build cut short is deleted when the store is next opened', async () => {
    let store = new TextIndexStore(file).open();
    await store.prepare([item(codeSystem(CONCEPTS))]);
    store.db.prepare('UPDATE indexes SET complete = 0').run();
    store.close();
    store = new TextIndexStore(file).open();
    try {
      expect(store.summary().indexes).toBe(0);
      expect(store.db.prepare('SELECT count(*) AS n FROM names').get().n).toBe(0);
      expect(store.db.prepare('SELECT count(*) AS n FROM codes').get().n).toBe(0);
    } finally {
      store.close();
    }
  });

  test('a supplement with an index in the store is searched from it, with the same answers', async () => {
    const concepts = [
      { code: '2000-8', display: 'Kaltsiy qon zardobida', designation: [{ language: 'en', value: 'Calcium [Moles/volume] in Serum or Plasma' }] },
      { code: '2823-3', display: 'Kaliy qon zardobida' }
    ];
    const supp = { jsonObj: { language: 'uz', content: 'supplement' }, getAllConcepts: () => concepts };
    const plain = { jsonObj: { language: 'uz', content: 'supplement' }, getAllConcepts: () => concepts };
    const store = new TextIndexStore(file).open();
    try {
      await store.prepare([{ object: supp, kind: 'supplement', lang: SupplementTextIndex.indexLanguage(supp, 'en'),
        size: SupplementTextIndex.sizeOf(supp), fill: sink => SupplementTextIndex.fill(supp, 'en', sink) }]);
      const index = SupplementTextIndex.of(supp, 'en');
      expect(index.stored).toBeInstanceOf(StoredNameIndex);
      expect(SupplementTextIndex.of(plain, 'en').stored).toBeNull();
      for (const [text, lang] of [['kaltsiy', 'uz'], ['calcium serum', 'en'], ['qon', 'uz'], ['calcium', 'uz']]) {
        const filter = new SearchFilterText(text);
        expect([...(await index.searchTexts(filter, lang)).entries()])
          .toEqual([...(await SupplementTextIndex.of(plain, 'en').searchTexts(filter, lang)).entries()]);
      }
      expect([...index.languages()].sort()).toEqual(['en', 'uz']);
      // a code system whose language is not English asks for another index: the stored one isn't it
      const noLang = { jsonObj: { content: 'supplement' }, getAllConcepts: () => concepts };
      await store.prepare([{ object: noLang, kind: 'supplement', lang: SupplementTextIndex.indexLanguage(noLang, 'en'),
        size: SupplementTextIndex.sizeOf(noLang), fill: sink => SupplementTextIndex.fill(noLang, 'en', sink) }]);
      expect(SupplementTextIndex.of(noLang, 'en').stored).toBeInstanceOf(StoredNameIndex);
      expect(SupplementTextIndex.of(noLang, 'de').stored).toBeNull();
    } finally {
      store.close();
    }
  });
});
