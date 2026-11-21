// Historical reproducer for the re2-wasm WASM heap leak.
// regex-utilities.js now sits on top of re2js (a pure-JS RE2 port), so the
// underlying leak is gone. Kept as a stress test for the compile cache:
//
//   node test-scripts/repro-re2-wasm-leak.js            # same-pattern stress
//   node test-scripts/repro-re2-wasm-leak.js --unique   # unique-pattern stress
//
// Background (re2-wasm era): without the cache, same-pattern OOMed at ~2965
// iterations; with the cache, same-pattern ran indefinitely but unique-pattern
// still OOMed because every distinct pattern was a real compile and re2-wasm
// could not free its WASM heap. Under re2js both modes now run indefinitely
// (unique-pattern is bounded only by ordinary V8 heap growth from the cache).

const re = require('../library/regex-utilities');

const mode = process.argv.includes('--unique') ? 'unique' : 'same';
const basePattern =
  'CYTO|HL7\\.CYTOGEN|HL7\\.GENETICS|^PATH(\\..*)?|^MOLPATH(\\..*)?|NR STATS|H&P\\.HX\\.LAB|CHALSKIN|LABORDERS';

console.log(`mode: ${mode}-pattern`);

let i = 0;
try {
  for (;;) {
    const pattern = mode === 'unique' ? basePattern + `|UNIQUE${i}` : basePattern;
    re.compile(pattern);
    i++;
    if (i % 100 === 0) console.log(`iter ${i}`);
  }
} catch (e) {
  console.error(`OOMed at iteration ${i}: ${e.message}`);
  process.exit(1);
}
 