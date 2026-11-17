'use strict';

// display regex: required-literal extraction (trigram prefilter) and ".*" affix stripping must not
// change which strings match.

const regexUtilities = require('../../library/regex-utilities');
const { requiredLiterals, ftsQuery, stripAnyAffixes } = require('../../tx/sqlite-v2/engine/regex-literals');

const PATTERNS = ['tumour|neoplasm', '(tumour|tumor) of liver', '\\d+ mg tablet', 'heart.attack', 'colou?r', 'abc+de', '[Tt]umour', '.*[Tt]umou?r.*', '.*e.*', '^Fracture of.*femur.*', '^Diabetes.*', '(?i)heart attack', 'foo\\.bar+x',
  'ab{0,2}cde', 'x(abc)?yzw', '[abc]defg', 'a|bcd', '.*\\(disorder\\)$', '^Malignant neoplasm of .*', 'q.*', '.*', 'x\\.*', 'colou?r .*red'];
const STRINGS = ['Tumour of liver', 'tumor', 'Benign tumour', 'Fracture of neck of femur', 'Fracture of femur', 'fracture of femur',
  'Diabetes mellitus', 'Type 2 diabetes', 'Heart attack', 'HEART ATTACK', 'foo.barrx', 'foo.barx', 'foobarx', 'acde', 'abbcde', 'xyzw',
  'xabcyzw', 'adefg', 'bcd', 'a', 'Asthma (disorder)', 'Malignant neoplasm of lung', 'q', '', 'x...', 'colour  red', 'color red', 'e', 'tumor of liver', 'neoplasm', '25 mg tablet', 'mg tablet', 'heart-attack', 'abccde', 'abde', 'Tumour'];

describe('sqlite-v2 display regex: prefilter literals', () => {
  test('every match contains every required literal (case-insensitively)', () => {
    for (const p of PATTERNS) {
      const re = regexUtilities.compile(p);
      const lits = requiredLiterals(p);
      for (const s of STRINGS) {
        if (re.test(s)) for (const l of lits) expect([p, s, s.toLowerCase().includes(l.toLowerCase())]).toEqual([p, s, true]);
      }
    }
  });

  test('extraction: alternation, classes, escapes, anchors, groups, quantifiers', () => {
    const cases = [
      // alternation at the top level: nothing is required by every branch
      ['tumour|neoplasm', []], ['^a.*|b', []], ['(?:abc|abd)ef', []],
      // alternation inside a group: the group is skipped, the rest still counts
      ['(tumour|tumor) of liver', [' of liver']],
      // classes break a literal and are never part of one
      ['[Tt]umour', ['umour']], ['fe[mM]ur', []], ['[^a]bcde', ['bcde']], ['x[]a]yzw', ['yzw']], ['[a\\]]bcd', ['bcd']],
      // escapes: escaped punctuation is a literal; class escapes break
      ['\\(disorder\\)', ['(disorder)']], ['a\\.b\\.c', ['a.b.c']], ['\\d+ mg tablet', [' mg tablet']], ['foo\\sbar', ['foo', 'bar']],
      // anchors and the dot break, and are dropped
      ['^Diabetes$', ['Diabetes']], ['^Frac.ure', ['Frac', 'ure']], ['heart.attack', ['heart', 'attack']],
      // optional atoms are dropped; + keeps one occurrence
      ['colou?r', ['colo']], ['ab*cde', ['cde']], ['abc+de', ['abc']], ['x{0,3}abcd', ['abcd']], ['ab{2}cd', []], ['abc{1,}xyz', ['abc', 'xyz']],
      // (?i) and other groups are skipped
      ['(?i)heart attack', ['heart attack']], ['(abc)?def', ['def']],
      // no literal of 3 characters: no prefilter
      ['.*e.*', []], ['ab', []], ['a.b.c', []], ['[0-9]+', []], ['', []], ['.*', []],
    ];
    for (const [p, want] of cases) expect([p, requiredLiterals(p)]).toEqual([p, want]);
  });

  test('examples', () => {
    expect(requiredLiterals('.*[Tt]umou?r.*')).toEqual(['umo']);
    expect(requiredLiterals('^Fracture of.*femur.*')).toEqual(['Fracture of', 'femur']);
    expect(requiredLiterals('.*e.*')).toEqual([]);
    expect(requiredLiterals('a|bcd')).toEqual([]);
    expect(ftsQuery(['say "hi"', 'abc'])).toBe('"say ""hi""" AND "abc"');
  });

  test('stripping ".*" affixes does not change the find-anywhere result', () => {
    for (const p of PATTERNS) {
      const a = regexUtilities.compile(p);
      const b = regexUtilities.compile(stripAnyAffixes(p));
      for (const s of STRINGS) expect([p, s, b.test(s)]).toEqual([p, s, a.test(s)]);
    }
    expect(stripAnyAffixes('.*e.*')).toBe('e');
    expect(stripAnyAffixes('x\\.*')).toBe('x\\.*');
    expect(stripAnyAffixes('a|.*b')).toBe('a|.*b');
  });
});

describe('sqlite-v2 display regex (generic code system): prefilter on and off give the same expansion, whole term', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { V2Builder } = require('../../tx/importers/sqlite-v2/builder');
  const { V2Store } = require('../../tx/sqlite-v2/store');
  const { Engine } = require('../../tx/sqlite-v2/engine/engine');
  const { Compiler } = require('../../tx/sqlite-v2/engine/compile');
  const { dialectFor } = require('../../tx/sqlite-v2/dialects');
  const SCT = 'http://example.org/cs'; // not SNOMED CT: the display regex tests concept.display
  let dir;
  let S;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(process.env.SQLITE_V2_TEST_TMP || os.tmpdir(), 'sqlite-v2-regex-'));
    const b = new V2Builder(path.join(dir, 'sct.db'), { overwrite: true, importer: 'test' });
    b.setCodeSystem({ uri: SCT, version: '1' });
    const isa = b.property({ code: 'parent', fhirType: 'code', valueKind: 'concept', isHierarchy: true });
    const root = b.concept('138875005', { active: true, display: 'SNOMED CT Concept' });
    const extra = ['Tumour of skin', 'Benign tumor of skin', 'TUMOUR', 'Fracture of shaft of femur', 'Closed fracture of femur',
      'Fracture of femur (disorder)', 'Diabetes mellitus type 2', 'Pre-diabetes', 'Heart attack', 'heart  attack', 'Herzinfarkt',
      'Ödem der Leber', 'oedema', 'Paracetamol 500 mg tablet', 'mg tablet', '10 mg/ml', 'a.b.c', 'abc', 'colour', 'color', 'tumour|x'];
    const displays = [...new Set([...STRINGS, ...extra])].filter((d) => d !== '');
    displays.forEach((d, i) => b.link(b.concept(String(1000000 + i * 10 + 1), { active: true, display: d }), isa, root));
    b.finish();
    S = new V2Store(path.join(dir, 'sct.db'));
  });
  afterAll(() => { S.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const run = (re, strip) => {
    const c = new Compiler({ store: S, dialect: dialectFor(SCT) });
    const sel = c.selection([{ system: SCT, filter: [{ property: 'display', op: 'regex', value: re }] }], [], false);
    const walk = (n) => { if (n && typeof n === 'object') { if (n.t === 'text' && strip) delete n.lits; Object.values(n).forEach(walk); } };
    walk(sel);
    const r = new Engine(S).run(sel, { offset: 0, count: -1 });
    return r.page(0, -1);
  };

  test('identical results (and the same as RE2 on every display)', () => {
    expect(S.hasFts).toBe(true);
    const all = S.stmt('SELECT concept_id, display FROM concept').all();
    for (const p of [...PATTERNS, '[Tt]umou?r', 'Fracture of.*femur', '(?i)HEART ATTACK', '\\d+ mg', 'Ödem', '(?i)ödem', 'tumour\\|x']) {
      const on = run(p, false);
      const off = run(p, true);
      const re = regexUtilities.compile('^(?:' + p + ')$'); // whole term
      const truth = all.filter((r) => re.test(r.display)).map((r) => r.concept_id).sort((a, b) => a - b);
      expect([p, on]).toEqual([p, off]);
      expect([p, [...on].sort((a, b) => a - b)]).toEqual([p, truth]);
    }
  });
});


describe('sqlite-v2 display regex on the SNOMED CT test edition (tx/data/snomed RF2)', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { importSnomedV2 } = require('../../tx/importers/import-sct-v2.module');
  const { V2Store } = require('../../tx/sqlite-v2/store');
  const { Engine } = require('../../tx/sqlite-v2/engine/engine');
  const { Compiler } = require('../../tx/sqlite-v2/engine/compile');
  const { dialectFor } = require('../../tx/sqlite-v2/dialects');
  const SCT = 'http://snomed.info/sct';
  const SRC = path.resolve(__dirname, '../../tx/data/snomed');
  let dir;
  let S;

  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  // the fixture is split by module; the RF2 importer reads one file per kind
  function mergeSnapshot(src, dst) {
    const groups = new Map();
    for (const f of walk(src)) {
      if (!f.endsWith('.txt')) continue;
      const rel = path.relative(src, f);
      const key = path.join(path.dirname(rel), path.basename(rel).replace(/_(INT|TEST1000003|LO1010000)_/, '_MERGED_'));
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(f);
    }
    for (const [k, files] of groups) {
      const out = path.join(dst, k);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, files.flatMap((f, i) => fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).slice(i ? 1 : 0)).join('\n') + '\n');
    }
  }

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(process.env.SQLITE_V2_TEST_TMP || os.tmpdir(), 'sqlite-v2-regex-test-edition-'));
    mergeSnapshot(SRC, path.join(dir, 'Snapshot'));
    await importSnomedV2({ source: path.join(dir, 'Snapshot'), dest: path.join(dir, 'test.db'), edition: '31000003106', version: '20250909', overwrite: true, log: () => {} });
    S = new V2Store(path.join(dir, 'test.db'));
  }, 120000);
  afterAll(() => { if (S) S.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  test('prefilter on = off = RE2 over every active FSN/synonym in the language, whole term', () => {
    const FSN = '900000000000003001';
    const SYN = '900000000000013009';
    const uses = new Set([...S.uses].filter(([, u]) => u && (u.code === FSN || u.code === SYN)).map(([id]) => id));
    const all = S.stmt('SELECT concept_id, term AS display, language, use_id, active FROM designation').all()
      .filter((r) => r.active && uses.has(r.use_id) && String(r.language).toLowerCase().split('-')[0] === 'en');
    expect(all.length).toBeGreaterThan(1000);
    const pats = ['.*[Tt]umou?r.*', '^Fracture of.*femur.*', '^Diabetes.*', '.*e.*', '(?i)LIVER', 'syndrome$', '.*\\(disorder\\)$',
      '.*of (left|right) .*', '.*hepat.*|.*renal.*', '[A-Z][a-z]+ [a-z]+ of', '\\d+', 'ure.*ure', '(?i)hepatorenal syndrome', 'Liver structure'];
    let prefiltered = 0;
    for (const p of pats) {
      const c = new Compiler({ store: S, dialect: dialectFor(SCT) });
      const mk = () => c.selection([{ system: SCT, filter: [{ property: 'display', op: 'regex', value: p }] }], [], false);
      const selOn = mk();
      const selOff = mk();
      const strip = (n) => { if (n && typeof n === 'object') { if (n.t === 'text' || n.t === 'desigRegex') delete n.lits; Object.values(n).forEach(strip); } };
      strip(selOff);
      if (JSON.stringify(selOn).includes('"lits"')) prefiltered++;
      const on = new Engine(S).run(selOn, { offset: 0, count: -1 }).page(0, -1);
      const off = new Engine(S).run(selOff, { offset: 0, count: -1 }).page(0, -1);
      const re = regexUtilities.compile('^(?:' + p + ')$');
      const truth = [...new Set(all.filter((r) => re.test(r.display)).map((r) => r.concept_id))].sort((a, b) => a - b);
      expect([p, on]).toEqual([p, off]);
      expect([p, [...on].sort((a, b) => a - b)]).toEqual([p, truth]);
    }
    expect(prefiltered).toBeGreaterThanOrEqual(8);
  });
});
