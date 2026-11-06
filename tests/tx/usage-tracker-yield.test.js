// The ConceptUsageTracker's startup scan reads every value set, about a second of work on a full
// source list; it used to run without a break, so requests arriving just after startup waited
// for all of it. It now gives the event loop a turn every few milliseconds.

const ConceptUsageTracker = require('../../tx/usage-tracker');

function busy(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* compute */ }
}

function libraryOf(count) {
  const vs = (i) => ({ jsonObj: { compose: { include: [{ system: 'http://example.org/cs', concept: [{ code: 'c' + (i % 7) }] }] } } });
  return {
    valueSetProviders: [{
      listAllValueSets: async () => Array.from({ length: count }, (_, i) => 'http://example.org/vs/' + i),
      fetchValueSet: async (url) => { busy(1); return vs(Number(url.split('/').pop())); }
    }]
  };
}

describe('ConceptUsageTracker scan', () => {
  test('other work runs during the scan, and the counts are unchanged', async () => {
    const tracker = new ConceptUsageTracker();
    let ranDuringScan = 0;
    let scanning = true;
    const tick = () => { if (scanning) { ranDuringScan++; setImmediate(tick); } };
    setImmediate(tick);
    const count = await tracker.scanValueSets(libraryOf(100));
    scanning = false;
    expect(count).toBe(100);
    expect(ranDuringScan).toBeGreaterThan(3);
    const usages = tracker.usages('http://example.org/cs');
    expect(usages.get('c0').count).toBe(15);
    expect(usages.get('c6').count).toBe(14);
  });
});
