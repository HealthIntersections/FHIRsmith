'use strict';
// The providers' limits. Nothing in the server configuration sets them: these are the values
// every sqlite-v2 provider runs with (a test may change one for its run).
//
//   maxScanRows       planner estimate of fact rows a request may read (text/regex scans,
//                     relation images, per-candidate probes); beyond it the request is
//                     too-costly before any work is done. 5,000,000.
//
// Response sizes are upstream's (expand.js limitCount): a provider-selected page is added
// through the same includeCode as every other code. Totals come from set cardinalities and
// pages are by position (cs-api processSelection). The providers keep one cache, of built
// supplement layers (supplementLayerCacheMB); otherwise every request plans and evaluates, reading
// stored sets from SQLite (SQLite's page cache and the OS page cache under mmap).
//
//   supplementLayerCacheMB  memory for built supplement layers kept between requests (layers.js
//                     LayerCache, one per process): their SQLite pages, about 120 bytes per
//                     concept with one designation, 360 with five. 64: about 530k such
//                     concepts, two layers the size of all of LOINC (257k) or hundreds of the IG
//                     corpus's (99% have 1,001 concepts or fewer). Least recently used layers are
//                     dropped to stay under it; a layer bigger than the whole bound is built per
//                     request and not kept. 0 = keep none.
//   sqliteCacheKB     SQLite page cache per connection. 2,048 (2 MiB): reads use mmap.
//   mmapMB            SQLite mmap window per file. 2047: the whole file (SQLite maps no more
//                     than the file, and at most 2 GiB). File-backed: the pages are the OS page cache,
//                     shared by every process that reads the file, and reclaimable. A smaller window
//                     sends reads beyond it through pread() into the 2 MiB page cache, which a
//                     SNOMED CT file (700+ MiB) misses on most requests.

const settings = { maxScanRows: 5000000, supplementLayerCacheMB: 64, sqliteCacheKB: 2048, mmapMB: 2047 };

class TooCostly extends Error {
  constructor(message) {
    super(message);
    this.tooCostly = true;
  }
}

module.exports = { settings, TooCostly };
