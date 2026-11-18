#!/usr/bin/env node
//
// tx-stress.js - FHIR Terminology Server Stress Test Client
//
// Usage:
//   node tx-stress.js <server-url> [options]
//
// Examples:
//   node tx-stress.js http://localhost:3000/tx
//   node tx-stress.js http://localhost:3000/tx --threads 10 --duration 60
//   node tx-stress.js http://localhost:3000/tx --threads 5 --duration 30 --mode search
//   node tx-stress.js http://localhost:3000/tx --threads 20 --duration 120 --mode random --verbose
//

const SEARCH_TERMS = [
  'body', 'status', 'gender', 'type', 'code', 'category', 'event',
  'condition', 'procedure', 'medication', 'observation', 'allergy',
  'diagnosis', 'encounter', 'clinical', 'admin', 'result', 'finding',
  'disorder', 'substance', 'unit', 'country', 'language', 'ethnic',
  'marital', 'contact', 'address', 'identifier', 'security', 'action',
  'request', 'response', 'priority', 'severity', 'risk', 'method'
];

// ── CLI parsing ──────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
FHIR Terminology Server Stress Test

Usage: node tx-stress.js <server-url> [options]

Options:
  --threads <n>     Number of concurrent workers (default: 10)
  --duration <s>    Test duration in seconds (default: 60)
  --mode <mode>     ValueSet discovery mode (default: both)
                      browse  - paginate through all ValueSets
                      search  - search with random terms
                      both    - alternate between modes
  --pick <n>        How many ValueSets to pick per cycle (default: 20)
  --from <n>        Pick from first N search results (default: 100)
  --verbose         Show per-request latencies
  --delay <ms>      Delay between requests per worker in ms (default: 0)
  --help, -h        Show this help

Examples:
  node tx-stress.js http://localhost:3000/tx
  node tx-stress.js http://localhost:3000/tx --threads 20 --duration 120 --verbose
  node tx-stress.js http://localhost:3000/tx --threads 5 --mode search --duration 30
`);
    process.exit(0);
  }

  const config = {
    serverUrl: args[0].replace(/\/+$/, ''),
    threads: 10,
    duration: 60,
    mode: 'both',
    pick: 20,
    from: 100,
    verbose: false,
    delay: 0
  };

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case '--threads':   config.threads  = parseInt(args[++i]); break;
      case '--duration':  config.duration = parseInt(args[++i]); break;
      case '--mode':      config.mode     = args[++i];           break;
      case '--pick':      config.pick     = parseInt(args[++i]); break;
      case '--from':      config.from     = parseInt(args[++i]); break;
      case '--verbose':   config.verbose  = true;                break;
      case '--delay':     config.delay    = parseInt(args[++i]); break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        process.exit(1);
    }
  }

  if (!['browse', 'search', 'both'].includes(config.mode)) {
    console.error(`Invalid mode: ${config.mode}. Use browse, search, or both.`);
    process.exit(1);
  }

  return config;
}

// ── Stats collection ─────────────────────────────────────────────────

class StatsCollector {
  constructor() {
    this.requests = [];       // { worker, phase, url, status, latencyMs, error, timestamp }
    this.cycles = 0;
    this.errors = 0;
    this.startTime = null;
    this.endTime = null;
  }

  record(entry) {
    this.requests.push(entry);
    if (entry.error) this.errors++;
  }

  completeCycle() {
    this.cycles++;
  }

  summarize() {
    const duration = (this.endTime - this.startTime) / 1000;
    const phases = {};

    for (const req of this.requests) {
      if (!phases[req.phase]) {
        phases[req.phase] = { count: 0, errors: 0, latencies: [] };
      }
      const p = phases[req.phase];
      p.count++;
      if (req.error) p.errors++;
      if (req.latencyMs !== null) p.latencies.push(req.latencyMs);
    }

    console.log('\n' + '═'.repeat(72));
    console.log('  STRESS TEST RESULTS');
    console.log('═'.repeat(72));
    console.log(`  Duration:          ${duration.toFixed(1)}s`);
    console.log(`  Workers:           ${this.workerCount}`);
    console.log(`  Complete cycles:   ${this.cycles}`);
    console.log(`  Total requests:    ${this.requests.length}`);
    console.log(`  Total errors:      ${this.errors}`);
    console.log(`  Requests/sec:      ${(this.requests.length / duration).toFixed(1)}`);
    console.log(`  Cycles/sec:        ${(this.cycles / duration).toFixed(2)}`);

    console.log('\n  Per-phase breakdown:');
    console.log('  ' + '-'.repeat(70));
    console.log(`  ${'Phase'.padEnd(16)} ${'Count'.padStart(7)} ${'Errors'.padStart(7)} ${'Avg ms'.padStart(8)} ${'p50 ms'.padStart(8)} ${'p95 ms'.padStart(8)} ${'p99 ms'.padStart(8)} ${'Max ms'.padStart(8)}`);
    console.log('  ' + '-'.repeat(70));

    for (const [phase, data] of Object.entries(phases)) {
      const sorted = data.latencies.slice().sort((a, b) => a - b);
      const avg = sorted.length ? (sorted.reduce((a, b) => a + b, 0) / sorted.length) : 0;
      const p50 = percentile(sorted, 50);
      const p95 = percentile(sorted, 95);
      const p99 = percentile(sorted, 99);
      const max = sorted.length ? sorted[sorted.length - 1] : 0;

      console.log(`  ${phase.padEnd(16)} ${String(data.count).padStart(7)} ${String(data.errors).padStart(7)} ${avg.toFixed(0).padStart(8)} ${p50.toFixed(0).padStart(8)} ${p95.toFixed(0).padStart(8)} ${p99.toFixed(0).padStart(8)} ${max.toFixed(0).padStart(8)}`);
    }

    // Overall latency
    const allLatencies = this.requests.filter(r => r.latencyMs !== null).map(r => r.latencyMs).sort((a, b) => a - b);
    if (allLatencies.length > 0) {
      const avg = allLatencies.reduce((a, b) => a + b, 0) / allLatencies.length;
      console.log('  ' + '-'.repeat(70));
      console.log(`  ${'OVERALL'.padEnd(16)} ${String(this.requests.length).padStart(7)} ${String(this.errors).padStart(7)} ${avg.toFixed(0).padStart(8)} ${percentile(allLatencies, 50).toFixed(0).padStart(8)} ${percentile(allLatencies, 95).toFixed(0).padStart(8)} ${percentile(allLatencies, 99).toFixed(0).padStart(8)} ${allLatencies[allLatencies.length - 1].toFixed(0).padStart(8)}`);
    }

    console.log('═'.repeat(72));

    // Error summary
    const errorTypes = {};
    for (const req of this.requests) {
      if (req.error) {
        const key = `${req.phase}: ${req.error}`;
        errorTypes[key] = (errorTypes[key] || 0) + 1;
      }
    }
    if (Object.keys(errorTypes).length > 0) {
      console.log('\n  Error summary:');
      for (const [msg, count] of Object.entries(errorTypes).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${count}x  ${msg}`);
      }
    }
  }
}

function percentile(sorted, pct) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((pct / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ── HTTP helpers ─────────────────────────────────────────────────────

async function fhirGet(url, stats, worker, phase, verbose) {
  const start = performance.now();
  let status = null;
  let error = null;
  let body = null;

  try {
    const resp = await fetch(url, {
      headers: { 'Accept': 'application/fhir+json' },
      signal: AbortSignal.timeout(30000)
    });
    status = resp.status;

    if (!resp.ok) {
      error = `HTTP ${resp.status}`;
      return null;
    }

    body = await resp.json();
    return body;

  } catch (err) {
    error = err.name === 'TimeoutError' ? 'Timeout (30s)' : err.message;
    return null;

  } finally {
    const latencyMs = performance.now() - start;
    const entry = {
      worker,
      phase,
      url: shortenUrl(url),
      status,
      latencyMs,
      error,
      timestamp: new Date()
    };
    stats.record(entry);

    if (verbose) {
      const icon = error ? '✗' : '✓';
      const statusStr = status ? `${status}` : '---';
      console.log(`  [W${String(worker).padStart(2)}] ${icon} ${phase.padEnd(14)} ${latencyMs.toFixed(0).padStart(6)}ms  ${statusStr}  ${shortenUrl(url)}`);
    }
  }
}

function shortenUrl(url) {
  // Trim to last meaningful path segments for readable logging
  try {
    const u = new URL(url);
    const path = u.pathname + u.search;
    return path.length > 90 ? path.substring(0, 87) + '...' : path;
  } catch {
    return url.length > 90 ? url.substring(0, 87) + '...' : url;
  }
}

// ── FHIR operations ──────────────────────────────────────────────────

async function searchValueSets(config, stats, worker, mode) {
  const baseUrl = config.serverUrl;
  const allEntries = [];
  const pageSize = 50;

  if (mode === 'search') {
    // Search with a random term
    const term = SEARCH_TERMS[Math.floor(Math.random() * SEARCH_TERMS.length)];
    const url = `${baseUrl}/ValueSet?name:contains=${encodeURIComponent(term)}&_count=${pageSize}`;
    const bundle = await fhirGet(url, stats, worker, 'vs-search', config.verbose);
    if (bundle && bundle.entry) {
      allEntries.push(...bundle.entry);
    }
    // Get a second page if we need more results and there is one
    if (allEntries.length < config.from && bundle && bundle.link) {
      const nextLink = bundle.link.find(l => l.relation === 'next');
      if (nextLink) {
        const bundle2 = await fhirGet(nextLink.url, stats, worker, 'vs-search', config.verbose);
        if (bundle2 && bundle2.entry) {
          allEntries.push(...bundle2.entry);
        }
      }
    }
  } else {
    // Browse mode - paginate through ValueSets
    const offset = Math.floor(Math.random() * 200) * pageSize;
    const url = `${baseUrl}/ValueSet?_count=${pageSize}&_offset=${offset}`;
    const bundle = await fhirGet(url, stats, worker, 'vs-browse', config.verbose);
    if (bundle && bundle.entry) {
      allEntries.push(...bundle.entry);
    }
    // Get a second page
    if (allEntries.length < config.from && bundle && bundle.link) {
      const nextLink = bundle.link.find(l => l.relation === 'next');
      if (nextLink) {
        const bundle2 = await fhirGet(nextLink.url, stats, worker, 'vs-browse', config.verbose);
        if (bundle2 && bundle2.entry) {
          allEntries.push(...bundle2.entry);
        }
      }
    }
  }

  return allEntries;
}

function pickRandom(arr, n) {
  const copy = arr.slice(0, Math.min(arr.length, 200)); // cap working set
  const result = [];
  for (let i = 0; i < n && copy.length > 0; i++) {
    const idx = Math.floor(Math.random() * copy.length);
    result.push(copy.splice(idx, 1)[0]);
  }
  return result;
}

async function expandValueSet(config, stats, worker, vsUrl) {
  const url = `${config.serverUrl}/ValueSet/$expand?url=${encodeURIComponent(vsUrl)}&count=20`;
  const result = await fhirGet(url, stats, worker, 'vs-expand', config.verbose);
  return result;
}

async function validateCode(config, stats, worker, system, code, vsUrl) {
  const params = new URLSearchParams();
  params.set('system', system);
  params.set('code', code);
  if (vsUrl) params.set('url', vsUrl);

  const url = `${config.serverUrl}/ValueSet/$validate-code?${params.toString()}`;
  const result = await fhirGet(url, stats, worker, 'validate-code', config.verbose);
  return result;
}

// ── Worker cycle ─────────────────────────────────────────────────────

async function runWorkerCycle(config, stats, worker, deadline) {
  // 1. Decide mode for this cycle
  let mode;
  if (config.mode === 'both') {
    mode = Math.random() < 0.5 ? 'browse' : 'search';
  } else {
    mode = config.mode;
  }

  // 2. Search for ValueSets
  const entries = await searchValueSets(config, stats, worker, mode);
  if (Date.now() >= deadline) return;

  if (!entries || entries.length === 0) {
    return; // nothing to work with this cycle
  }

  // 3. Pick a random subset
  const picked = pickRandom(entries, config.pick);

  // 4. Expand each and validate a code from each expansion
  for (const entry of picked) {
    if (Date.now() >= deadline) return;

    const vs = entry.resource;
    if (!vs || !vs.url) continue;

    // Expand
    const expansion = await expandValueSet(config, stats, worker, vs.url);
    if (Date.now() >= deadline) return;

    if (config.delay > 0) await sleep(config.delay);

    // Find a code in the expansion to validate
    const contains = expansion?.expansion?.contains;
    if (contains && contains.length > 0) {
      const pick = contains[Math.floor(Math.random() * contains.length)];
      if (pick.system && pick.code) {
        await validateCode(config, stats, worker, pick.system, pick.code, vs.url);
      }
    }

    if (config.delay > 0) await sleep(config.delay);
  }

  stats.completeCycle();
}

async function runWorker(config, stats, worker, deadline) {
  while (Date.now() < deadline) {
    try {
      await runWorkerCycle(config, stats, worker, deadline);
    } catch (err) {
      // Shouldn't happen since fhirGet catches errors, but just in case
      stats.record({
        worker,
        phase: 'cycle-error',
        url: '',
        status: null,
        latencyMs: null,
        error: err.message,
        timestamp: new Date()
      });
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Connectivity check ───────────────────────────────────────────────

async function checkServer(config) {
  console.log(`\nChecking server at ${config.serverUrl} ...`);

  try {
    const resp = await fetch(`${config.serverUrl}/metadata`, {
      headers: { 'Accept': 'application/fhir+json' },
      signal: AbortSignal.timeout(10000)
    });

    if (!resp.ok) {
      console.error(`Server returned HTTP ${resp.status}. Aborting.`);
      process.exit(1);
    }

    const cs = await resp.json();
    const sw = cs.software ? `${cs.software.name || '?'} ${cs.software.version || ''}` : 'unknown';
    const fhirVer = cs.fhirVersion || '?';
    console.log(`  Server: ${sw} (FHIR ${fhirVer})`);
    console.log(`  Status: OK\n`);
    return cs;

  } catch (err) {
    console.error(`Cannot reach server: ${err.message}`);
    process.exit(1);
  }
}

// ── Live progress ────────────────────────────────────────────────────

function startProgressReporter(stats, config, deadline) {
  const interval = setInterval(() => {
    const elapsed = (Date.now() - stats.startTime) / 1000;
    const remaining = Math.max(0, (deadline - Date.now()) / 1000);
    const rps = stats.requests.length / elapsed;
    process.stdout.write(
      `\r  ⏱ ${elapsed.toFixed(0)}s elapsed | ${remaining.toFixed(0)}s remaining | ` +
      `${stats.requests.length} reqs (${rps.toFixed(1)}/s) | ` +
      `${stats.cycles} cycles | ${stats.errors} errors   `
    );
  }, 1000);

  return () => {
    clearInterval(interval);
    process.stdout.write('\r' + ' '.repeat(100) + '\r');
  };
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const config = parseArgs();

  console.log('╔' + '═'.repeat(70) + '╗');
  console.log('║  FHIR Terminology Server Stress Test' + ' '.repeat(33) + '║');
  console.log('╚' + '═'.repeat(70) + '╝');
  console.log(`  Server:    ${config.serverUrl}`);
  console.log(`  Workers:   ${config.threads}`);
  console.log(`  Duration:  ${config.duration}s`);
  console.log(`  Mode:      ${config.mode}`);
  console.log(`  Pick:      ${config.pick} of first ${config.from}`);
  if (config.delay > 0) console.log(`  Delay:     ${config.delay}ms between requests`);

  await checkServer(config);

  const stats = new StatsCollector();
  stats.workerCount = config.threads;
  stats.startTime = Date.now();
  const deadline = stats.startTime + (config.duration * 1000);

  console.log(`Starting ${config.threads} workers for ${config.duration}s...\n`);

  const stopProgress = config.verbose ? () => {} : startProgressReporter(stats, config, deadline);

  // Launch all workers concurrently
  const workers = [];
  for (let i = 1; i <= config.threads; i++) {
    workers.push(runWorker(config, stats, i, deadline));
  }

  await Promise.all(workers);

  stats.endTime = Date.now();
  stopProgress();
  stats.summarize();
}

main().catch(err => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});