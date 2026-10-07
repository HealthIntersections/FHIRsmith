/**
 * Every code system provider has a display name.
 *
 * CodeSystemProvider.name() falls back to the versioned uri, which is not a name - it is
 * what $lookup reports as its name parameter, where every other code system answers
 * something like "LOINC". SnomedProvider was the only provider that never overrode it, so
 * a SNOMED lookup answered
 *
 *   http://snomed.info/sct|http://snomed.info/sct/731000124108/version/20230301
 *
 * and the two SNOMED lookup expectations in the tx-ecosystem suite had that baked into
 * them, which would have failed any server that answered properly.
 *
 * The sweep below is the point of this file: the fallback is silent, so the only way an
 * omission shows up is by asking every provider class whether it declares one.
 */

const fs = require('fs');
const path = require('path');

const CS_DIR = path.join(__dirname, '../../tx/cs');

/** Provider classes and whether each declares name() in its own body. */
function providerClasses() {
  const found = [];
  for (const file of fs.readdirSync(CS_DIR).filter((f) => f.startsWith('cs-') && f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(CS_DIR, file), 'utf8');
    const classes = [...src.matchAll(/^class (\w+) extends (\w+)/gm)];
    const names = [...src.matchAll(/^ {2}name\(\) *\{/gm)].map((m) => m.index);
    classes.forEach((m, i) => {
      const end = i + 1 < classes.length ? classes[i + 1].index : src.length;
      if (['CodeSystemProvider', 'BaseCSServices'].includes(m[2]) && m[1] !== 'BaseCSServices') {
        found.push({ file, cls: m[1], declares: names.some((n) => n > m.index && n < end) });
      }
    });
  }
  return found;
}

describe('code system providers', () => {
  test('there are providers to check - the scan itself still works', () => {
    const classes = providerClasses();
    expect(classes.length).toBeGreaterThan(10);
    expect(classes.map((c) => c.cls)).toContain('SnomedProvider');
  });

  test('every one declares its own name()', () => {
    const missing = providerClasses().filter((c) => !c.declares).map((c) => `${c.file}: ${c.cls}`);
    expect(missing).toEqual([]);
  });
});

describe('SnomedProvider.name', () => {
  const { SnomedProvider } = require('../../tx/cs/cs-snomed');
  const name = (description) => SnomedProvider.prototype.name.call({ sct: { getDescription: () => description } });

  test('is the edition, not the versioned uri', () => {
    expect(name('SNOMED CT US Edition')).toBe('SNOMED CT US Edition');
    expect(name('SNOMED CT US Edition')).not.toContain('http');
  });
});
