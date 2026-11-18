//
// The tx module's caches: the text index store, the cache registry, and the caches page
//
// - prepareTextIndexes: the text indexes of the code systems and supplements loaded as the
//   server starts, kept in SQLite between runs (library/text-index-store.js)
// - registerCaches: every cache the module keeps, in a CacheRegistry, and the memory guard
//   told how to empty them (the client caches last)
// - buildCachesPage: the /caches page - what each cache holds, and (with
//   modules.tx.adminPassword) emptying them
//

const path = require('path');
const escape = require('escape-html');
const { CacheRegistry } = require('./cache-registry');
const { TextIndexStore } = require('./library/text-index-store');
const { SupplementTextIndex } = require('./library/supplement-text-index');
const { libraryFilterMemos } = require('./library/filter-memo');
const { hasMemoryTextIndex, dropMemoryTextIndex } = require('./cs/cs-cs');
const { ResourceCache } = require('./operation-context');
const regexUtilities = require('../library/regex-utilities');
const memoryGuard = require('../library/memory-guard');

const TEXT_INDEX_FILE = path.join('text-indexes', 'text-indexes.db');

/**
 * Each CodeSystem resource the endpoints hold (each object once)
 * @param {Object[]} endpoints - TXModule.endpoints
 * @returns {Object[]}
 */
function loadedCodeSystems(endpoints) {
  const seen = new Set();
  for (const endpoint of endpoints) {
    const map = endpoint.provider && endpoint.provider.codeSystems;
    if (!map) {
      continue;
    }
    for (const cs of map.values()) {
      if (cs && cs.jsonObj && typeof cs.getAllConcepts === 'function') {
        seen.add(cs);
      }
    }
  }
  return [...seen];
}

/**
 * Each value set provider (each once): the library's and the endpoints'
 */
function valueSetProviders(library, endpoints) {
  const seen = new Set(library && library.valueSetProviders ? library.valueSetProviders : []);
  for (const endpoint of endpoints) {
    for (const vsp of (endpoint.provider && endpoint.provider.valueSetProviders) || []) {
      seen.add(vsp);
    }
  }
  return [...seen];
}

/**
 * Each code system factory (each once)
 */
function factories(library, endpoints) {
  const seen = new Set(library && library.codeSystemFactories ? library.codeSystemFactories.values() : []);
  for (const endpoint of endpoints) {
    for (const f of (endpoint.provider && endpoint.provider.codeSystemFactories && endpoint.provider.codeSystemFactories.values()) || []) {
      seen.add(f);
    }
  }
  return [...seen];
}

/**
 * Open the text index store and find or build the index of every code system and supplement the
 * endpoints loaded; then (unless read only) delete the indexes nothing uses any more. If the
 * store can't be opened, the indexes are built in memory as they are needed, as before
 * @param {Object} tx - the TXModule
 * @returns {Promise<TextIndexStore|null>}
 */
async function prepareTextIndexes(tx) {
  const file = path.join(tx.library.cacheFolder, TEXT_INDEX_FILE);
  const readOnly = tx.config.clusterRole === 'tx-worker';
  let store;
  try {
    store = new TextIndexStore(file, { readOnly, log: tx.log }).open();
  } catch (e) {
    tx.log.warn(`Text indexes are built in memory as they are needed: unable to open ${file}: ${e.message}`);
    return null;
  }
  const items = [];
  for (const cs of loadedCodeSystems(tx.endpoints)) {
    if (cs.jsonObj.content === 'supplement') {
      items.push({
        object: cs, kind: 'supplement', url: cs.url, version: cs.version,
        lang: SupplementTextIndex.indexLanguage(cs, 'en'), size: SupplementTextIndex.sizeOf(cs),
        fill: sink => SupplementTextIndex.fill(cs, 'en', sink)
      });
    } else {
      const csLang = cs.langCode()?.toString() || 'en';
      items.push({
        object: cs, kind: 'cs', url: cs.url, version: cs.version, lang: csLang, size: cs.getAllConcepts().length,
        fill: sink => TextIndexStore.fillCodeSystem(cs.getAllConcepts(), csLang, sink)
      });
    }
  }
  const start = Date.now();
  tx.log.info(`Text indexes: looking for ${items.length} code systems and supplements in ${file}${readOnly ? ' (read only)' : ''}`);
  try {
    const result = await store.prepare(items);
    const dropped = store.finish();
    const s = store.summary();
    tx.log.info(`Text indexes ready in ${((Date.now() - start) / 1000).toFixed(1)} s: ${result.objects} code systems and supplements use ` +
      `${result.kept + result.built} indexes (${result.kept} from earlier runs, ${result.built} built now; ${dropped} no longer used deleted); ` +
      `${s.indexes} indexes, ${s.names} names, ${(s.bytes / 1024 / 1024).toFixed(1)} MB`);
  } catch (e) {
    tx.log.error(`Text indexes: ${e.message} - those not ready are built in memory as they are needed`);
  }
  return store;
}

/**
 * Register every cache the module keeps, and tell the memory guard how to empty those of the
 * endpoints and the process (the client caches last)
 * @param {Object} tx - the TXModule
 * @returns {CacheRegistry}
 */
function registerCaches(tx) {
  const registry = new CacheRegistry();
  const endpoints = tx.endpoints;
  const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

  // ---- the endpoints' caches
  let budgetShown = false;
  for (const e of endpoints) {
    const ec = e.expansionCache;
    const showBudget = !budgetShown;
    budgetShown = true;
    registry.add({
      name: 'Expansion cache', scope: e.path, kind: 'cache',
      count: () => ec.cache.size,
      detail: () => `${ec.codeCount()} codes` + (showBudget ? `; all endpoints together: ${ec.budget.total} of ${ec.budget.maxCodes} codes` : ''),
      limit: `${ec.maxSize} entries; a budget of codes shared by every endpoint (expansionCacheSize, expansionCacheMaxCodes)`,
      clear: () => { ec.clearAll(); return null; }
    });
    const rc = e.resourceCache;
    const shared = rc.constructor !== ResourceCache;
    registry.add({
      name: shared ? 'Client caches (cache-ids, shared, on disk)' : 'Client caches (cache-ids)', scope: e.path, kind: 'client',
      count: () => rc.size(),
      detail: () => `${rc.conceptCount()} concepts` + (shared ? '; in a SQLite file the processes share: not this process\'s memory' : ''),
      limit: `${rc.maxConceptsPerCache} concepts a cache, ${rc.maxTotalConcepts} in all; idle ones dropped after ${tx.config.cacheTimeout || 30} min`,
      // the shared cache is the other processes' too, and isn't held in memory
      clear: shared ? null : () => { rc.clearAll(); return null; }
    });
  }

  // ---- the process's caches
  const xml = require('./xml/xml-base').FhirXmlBase.fragmentCache;
  if (xml) {
    registry.add({
      name: 'XML (and JSON) of large arrays', scope: 'process', kind: 'cache',
      count: () => xml.size,
      detail: () => `${mb(xml.bytes)} of text`,
      limit: `${mb(xml.budgetBytes)} (xmlCacheMB)`,
      clear: () => xml.clear()
    });
  }
  for (const vsp of valueSetProviders(tx.library, endpoints)) {
    if (typeof vsp._recentValueSets === 'function') {
      const label = typeof vsp.sourcePackage === 'function' ? vsp.sourcePackage() : 'VSAC';
      registry.add({
        name: `Recently read value sets (${label})`, scope: 'process', kind: 'cache',
        count: () => (vsp._recent ? vsp._recent.size : 0),
        detail: () => (vsp._recent ? `${mb(vsp._recent.bytes)} of stored JSON (parsed, they take several times that)` : null),
        limit: `${vsp.valueSetCacheMB} MB of stored JSON (valueSetCacheMB)`,
        clear: () => {
          if (vsp._recent) {
            vsp._recent.clear();
          }
          return null;
        }
      });
    }
  }
  const loincShared = new Set();
  for (const f of factories(tx.library, endpoints)) {
    const lookups = f._sharedData && f._sharedData.filterLookups;
    if (lookups && typeof lookups.clear === 'function' && !loincShared.has(lookups)) {
      loincShared.add(lookups);
      registry.add({
        name: `LOINC filter lookups (${f._sharedData._version || f.dbPath || 'LOINC'})`, scope: 'process', kind: 'cache',
        count: () => lookups.entries.size,
        detail: () => `${lookups.keyCount} keys`,
        limit: `${lookups.maxEntries} lookups, ${lookups.maxKeys} keys`,
        clear: () => { lookups.clear(); return null; }
      });
    }
  }
  if (tx.ecosystemResolver) {
    const er = tx.ecosystemResolver;
    registry.add({
      name: 'What the ecosystem registry and servers said', scope: 'process', kind: 'cache',
      count: () => er.cacheCount(),
      limit: '1000 entries in each of its 6 caches, for an hour',
      clear: () => { er.clearCaches(); return null; }
    });
  }
  if (tx.languages && tx.languages.parsed instanceof Map) {
    const langs = tx.languages;
    registry.add({
      name: 'Parsed language tags', scope: 'process', kind: 'cache',
      count: () => langs.parsed.size,
      limit: `${langs.maxParsed} (languageTagCacheSize)`,
      clear: () => { langs.parsed.clear(); return null; }
    });
  }
  registry.add({
    name: 'Compiled regular expressions', scope: 'process', kind: 'cache',
    count: () => regexUtilities._cache.size,
    limit: '1000',
    clear: () => { regexUtilities._cache.clear(); return null; }
  });
  if (tx.usageTracker) {
    const ut = tx.usageTracker;
    registry.add({
      name: 'Usage tracker (the usage-count expansion property)', scope: 'process', kind: 'cache',
      count: () => ut.codes,
      detail: () => (ut.enabled ? `${ut.map.size} code systems; counted from the value sets at startup, then from valid $validate-code codings - kept`
        : 'off: nothing uses the counts yet (usage-count is 0)'),
      limit: `${ut.maxCodes} codes`
    });
  }

  // ---- built as it is used, and kept with what was loaded as the server started
  registry.add({
    name: 'Filter results on package value sets', scope: 'process', kind: 'cache',
    count: () => libraryFilterMemos.size,
    detail: () => `${libraryFilterMemos.total} concepts: one result for each filter, for each code system version (and, for SNOMED CT display regexes, language) it was resolved against`,
    limit: `${libraryFilterMemos.maxConcepts} concepts (filterMemoMaxConcepts); on client value sets, they count against the client cache`,
    clear: () => { libraryFilterMemos.clear(); return null; }
  });
  const editions = [];
  for (const f of factories(tx.library, endpoints)) {
    if (f.snomedServices && typeof f.snomedServices.cacheCounts === 'function' && !editions.includes(f.snomedServices)) {
      editions.push(f.snomedServices);
    }
  }
  if (editions.length > 0) {
    const total = () => editions.reduce((t, s) => {
      const c = s.cacheCounts();
      t.historyIndexes += c.historyIndexes;
      t.mrcmRanges += c.mrcmRanges;
      return t;
    }, { historyIndexes: 0, mrcmRanges: 0 });
    registry.add({
      name: 'SNOMED CT indexes built as they are used', scope: 'process', kind: 'content',
      count: () => {
        const t = total();
        return t.historyIndexes + t.mrcmRanges;
      },
      detail: () => {
        const t = total();
        return `${editions.length} editions: ${t.historyIndexes} history indexes, ${t.mrcmRanges} MRCM range constraints`;
      },
      limit: 'the editions',
      clear: () => {
        for (const s of editions) {
          s.clearCaches();
        }
        return null;
      }
    });
  }
  registry.add({
    name: 'Text indexes in memory (code systems)', scope: 'process', kind: 'content',
    count: () => loadedCodeSystems(endpoints).filter(cs => hasMemoryTextIndex(cs)).length,
    detail: () => 'those not in the text index store',
    limit: 'the code systems loaded',
    clear: () => {
      for (const cs of loadedCodeSystems(endpoints)) {
        dropMemoryTextIndex(cs);
      }
      return null;
    }
  });
  registry.add({
    name: 'Text indexes in memory (supplements)', scope: 'process', kind: 'content',
    count: () => SupplementTextIndex.memoryCount(loadedCodeSystems(endpoints)),
    detail: () => 'those not in the text index store',
    limit: 'the supplements loaded',
    clear: () => {
      SupplementTextIndex.clearMemory(loadedCodeSystems(endpoints));
      return null;
    }
  });
  if (tx.textIndexStore) {
    const store = tx.textIndexStore;
    registry.add({
      name: 'Text index store (SQLite, kept between runs)', scope: 'process', kind: 'content',
      count: () => store.summary().indexes,
      detail: () => {
        const s = store.summary();
        return `${s.names} names, ${mb(s.bytes)} on disk (built at startup${store.readOnly ? ' by the master' : ''}: not memory, and not emptied)`;
      },
      limit: 'the code systems and supplements loaded at startup'
    });
  }

  // the memory guard empties the caches of the endpoints and the process, the client caches last
  for (const c of registry.caches) {
    if (!c.clear || c.kind === 'content') {
      continue;
    }
    memoryGuard.addReliever(`${c.name} (${c.scope})`, () => {
      if (c.count() === 0) {
        return 0;
      }
      const freed = c.clear();
      return typeof freed === 'number' && freed > 0 ? freed : null;
    }, { last: c.kind === 'client' });
  }
  return registry;
}

const KIND_NAMES = {
  cache: 'Endpoint and process caches',
  content: 'Kept with loaded content',
  client: 'Client caches'
};

const gb = (b) => (b == null ? '-' : (b / 1024 / 1024 / 1024).toFixed(2) + ' GB');
const num = (v) => (v == null ? '-' : Number(v).toLocaleString('en-US'));

/**
 * One process's caches, in full: each cache with its entries, detail and limit
 */
function processTables(report) {
  let html = '';
  for (const kind of ['cache', 'content', 'client']) {
    const rows = report.filter(r => r.kind === kind);
    if (rows.length === 0) {
      continue;
    }
    html += `<h4>${escape(KIND_NAMES[kind])}</h4>\n`;
    html += '<table class="grid"><tr><th>Cache</th><th>Scope</th><th>Entries</th><th>Detail</th><th>Limit</th></tr>\n';
    for (const r of rows) {
      html += `<tr><td>${escape(r.name)}${r.clearable ? '' : ' <i>(not emptied)</i>'}</td><td>${escape(r.scope)}</td>` +
        `<td style="text-align: right">${num(r.entries)}</td><td>${escape(r.detail || '')}</td><td>${escape(r.limit || '')}</td></tr>\n`;
    }
    html += '</table>\n';
  }
  return html;
}

/**
 * The content of the caches page
 * @param {Object} opts
 * @param {Object} opts.answer - library/cluster-caches.js ask(): {cluster, note, results: [{code, name, role,
 *   result: TXModule.localCaches(), or error}]}
 * @param {string|null} opts.message - the outcome of an action, in words (or null)
 * @param {boolean} opts.passwordConfigured - whether modules.tx.adminPassword is set
 * @returns {string} HTML
 */
function buildCachesPage({ answer, message, passwordConfigured }) {
  const procs = answer.results;
  const label = (p) => (p.result ? p.result.process : `${p.name || p.code}`);
  const several = procs.length > 1;
  let html = '<h2>Caches</h2>\n';
  html += `<p>What the terminology server keeps as it is used, ${answer.cluster ? `in each of its ${procs.length} processes` : 'in this process'}.` +
    (answer.note ? ` ${escape(answer.note)}.` : '') + '</p>\n';
  if (message) {
    html += `<p><strong>${escape(message)}</strong></p>\n`;
  }

  // the processes, and their memory
  const acted = procs.some(p => p.result && p.result.memory.before != null);
  html += '<table class="grid"><tr><th>Process</th><th>RSS</th>' + (acted ? '<th>RSS before</th><th>Emptied (entries)</th>' : '') +
    '<th>JS heap used</th><th>JS heap</th><th>Outside the heap</th></tr>\n';
  for (const p of procs) {
    if (!p.result) {
      html += `<tr><td>${escape(label(p))}</td><td colspan="${acted ? 6 : 4}">${escape(p.error || 'no answer')}</td></tr>\n`;
      continue;
    }
    const m = p.result.memory;
    const emptied = p.result.cleared ? p.result.cleared.reduce((t, c) => t + (c.entries || 0), 0) : null;
    html += `<tr><td>${escape(label(p))}</td><td>${gb(m.rss)}</td>` + (acted ? `<td>${gb(m.before)}</td><td style="text-align: right">${num(emptied)}</td>` : '') +
      `<td>${gb(m.heapUsed)}</td><td>${gb(m.heapTotal)}</td><td>${gb(m.external)}</td></tr>\n`;
  }
  html += '</table>\n';

  // each cache, with its entries in each process (and the total)
  const answered = procs.filter(p => p.result);
  if (several && answered.length > 0) {
    const rows = new Map(); // kind|name|scope -> {kind, name, scope, clearable, counts: Map(process index -> entries)}
    answered.forEach((p, i) => {
      for (const r of p.result.report) {
        const key = `${r.kind}|${r.name}|${r.scope}`;
        if (!rows.has(key)) {
          rows.set(key, { kind: r.kind, name: r.name, scope: r.scope, clearable: r.clearable, counts: new Map() });
        }
        rows.get(key).counts.set(i, r.entries);
      }
    });
    for (const kind of ['cache', 'content', 'client']) {
      const list = [...rows.values()].filter(r => r.kind === kind);
      if (list.length === 0) {
        continue;
      }
      html += `<h3>${escape(KIND_NAMES[kind])}</h3>\n`;
      html += '<table class="grid"><tr><th>Cache</th><th>Scope</th>' +
        answered.map(p => `<th>${escape(p.code || label(p))}</th>`).join('') + '<th>Total</th></tr>\n';
      for (const r of list) {
        let total = 0;
        const cells = answered.map((p, i) => {
          const v = r.counts.get(i);
          total += v || 0;
          return `<td style="text-align: right">${num(v)}</td>`;
        }).join('');
        html += `<tr><td>${escape(r.name)}${r.clearable ? '' : ' <i>(not emptied)</i>'}</td><td>${escape(r.scope)}</td>${cells}` +
          `<td style="text-align: right"><strong>${num(total)}</strong></td></tr>\n`;
      }
      html += '</table>\n';
    }
    html += '<h3>Each process</h3>\n';
    for (const p of answered) {
      html += `<details><summary>${escape(label(p))}</summary>\n${processTables(p.result.report)}</details>\n`;
    }
  } else if (answered.length === 1) {
    html += processTables(answered[0].result.report);
  }

  html += '<h3>Empty the caches</h3>\n';
  if (!passwordConfigured) {
    html += '<p>Emptying the caches needs a password, and none is configured (modules.tx.adminPassword).</p>\n';
  } else {
    html += '<p>Everything emptied is built again as it is needed: the server is slower for a while. ' +
      'Emptying the client caches as well makes every client start its cache again. ' +
      (answer.cluster ? 'Every process empties its caches. ' : '') +
      'A full garbage collection follows, so RSS shows what was let go.</p>\n' +
      '<form method="POST">\n' +
      '<label>Password: <input type="password" name="password" autocomplete="off"></label>\n' +
      '<button type="submit" name="action" value="unload">Empty all but the client caches</button>\n' +
      '<button type="submit" name="action" value="unload-all">Empty all the caches, client caches too</button>\n' +
      '</form>\n';
  }
  return html;
}

module.exports = { prepareTextIndexes, registerCaches, buildCachesPage, loadedCodeSystems, TEXT_INDEX_FILE };
