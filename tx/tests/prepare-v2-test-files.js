#!/usr/bin/env node
/**
 * Imports, afresh, the sqlite-v2 files tx/fixtures/test-cases-v2.yml names, from the files
 * tx/fixtures/test-cases.yml names for the same code systems: each `<type>-v2:<name>.v2.db` line of
 * the v2 library is built from the `<type>:<name>.<ext>` line of the standard one, which is
 * downloaded into the terminology cache first if it isn't there (as the standard run does).
 *
 *   LOINC        loinc-v2-classic      (tx/importers/import-loinc-v2-classic.module.js)
 *   SNOMED CT    snomed-v2-from-cache  (tx/importers/import-sct-v2-cache.module.js)
 *
 * A -v2 file already in the cache is replaced: every run tests files made by this run's importers.
 * Usage: node tx/tests/prepare-v2-test-files.js [--keep]   (--keep: reuse -v2 files already built)
 */
const fs = require('fs');
const path = require('path');
const yaml = require('yaml');
const { Library } = require('../library');
const { importLoincV2FromClassic } = require('../importers/import-loinc-v2-classic.module');
const { importSnomedV2FromCache } = require('../importers/import-sct-v2-cache.module');

const ROOT = path.join(__dirname, '..', '..');
const STANDARD = path.join(ROOT, 'tx', 'fixtures', 'test-cases.yml');
const V2 = path.join(ROOT, 'tx', 'fixtures', 'test-cases-v2.yml');

// source line `type[!]:details` -> { type, file }
function parse(line) {
  const m = /^([a-z0-9-]+)!?:(.*)$/.exec(line);
  return m ? { type: m[1], file: m[2] } : null;
}

const IMPORTERS = {
  'loinc-v2': { from: 'loinc', run: (source, dest) => importLoincV2FromClassic({ source, dest, overwrite: true, log: () => {} }) },
  'snomed-v2': { from: 'snomed', run: (source, dest) => importSnomedV2FromCache({ source, dest, overwrite: true, log: () => {} }) }
};

async function main() {
  const keep = process.argv.includes('--keep');
  const standard = yaml.parse(fs.readFileSync(STANDARD, 'utf8')).sources.map(parse).filter(Boolean);
  const v2 = yaml.parse(fs.readFileSync(V2, 'utf8')).sources.map(parse).filter((s) => s && IMPORTERS[s.type]);
  if (v2.length === 0) {
    throw new Error(`${path.basename(V2)} has no loinc-v2 or snomed-v2 line: nothing to import`);
  }
  const log = { info: () => {}, warn: (m) => console.warn(m), error: (m) => console.error(m), debug: () => {} };
  const library = new Library(STANDARD, undefined, log, { addStat: () => {} });
  library.baseUrl = yaml.parse(fs.readFileSync(STANDARD, 'utf8')).base.url;
  let imported = 0;
  for (const line of v2) {
    const imp = IMPORTERS[line.type];
    const stem = line.file.replace(/\.v2\.db$/, '');
    const src = standard.find((s) => s.type === imp.from && s.file.replace(/\.(db|cache)$/, '') === stem);
    if (!src) {
      throw new Error(`${line.type}:${line.file} in ${path.basename(V2)}: no ${imp.from}:${stem}.* line in ${path.basename(STANDARD)}`);
    }
    const dest = path.join(library.cacheFolder, line.file);
    if (keep && fs.existsSync(dest)) {
      console.log(`${line.file}: kept`);
      continue;
    }
    let t = Date.now();
    const source = await library.getOrDownloadFile(src.file);
    const fetched = Date.now() - t;
    t = Date.now();
    await imp.run(source, dest);
    console.log(`${line.file}: imported from ${src.file} in ${((Date.now() - t) / 1000).toFixed(1)} s` +
      (fetched > 1000 ? ` (download ${(fetched / 1000).toFixed(1)} s)` : '') +
      `, ${(fs.statSync(dest).size / 1048576).toFixed(0)} MiB`);
    imported++;
  }
  console.log(`${imported} of ${v2.length} sqlite-v2 files imported, ${v2.length - imported} kept`);
}

main().catch((e) => {
  console.error(e.stack || e.message);
  process.exit(1);
});
