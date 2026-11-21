/**
 * Return the C allocator's free memory to the OS: glibc malloc_trim(0), through the optional
 * koffi FFI dependency that the SNOMED mapping uses (tx/sct/mmap.js).
 *
 * Why: SQLite connections (one per code system provider, and an operation can open thousands)
 * are allocated by the C library's malloc in libuv's threads, in its per-thread arenas. When
 * they close, glibc keeps the freed memory in those arenas, resident, and gives back only a
 * free stretch at the very top of each. After a 20,000-entry LOINC $batch-validate-code was
 * aborted, a worker held 4.7 GB of such free memory: no GC can touch it, so the memory guard
 * stayed shut. malloc_trim(0) releases the free pages inside the arenas as well (it took that
 * worker from 8.0 GB to 3.9 GB in half a second). It frees nothing that is in use.
 *
 * Linux with glibc only. Elsewhere (macOS, Windows, musl without malloc_trim), or without
 * koffi, it does nothing and returns null.
 *
 * @module library/native-memory
 */
let trim; // undefined: not tried yet; null: not available

function load() {
  if (trim === undefined) {
    trim = null;
    if (process.platform === 'linux') {
      try {
        trim = require('koffi').load(null).func('int malloc_trim(size_t pad)');
      } catch {
        // no koffi, or no malloc_trim in this C library
      }
    }
  }
  return trim;
}

/** @returns {boolean} whether trimNativeMemory() can do anything here */
function canTrimNativeMemory() {
  return !!load();
}

/** @returns {boolean|null} whether memory was released, or null if this can't be done here */
function trimNativeMemory() {
  if (!load()) {
    return null;
  }
  try {
    return trim(0) !== 0;
  } catch {
    trim = null;
    return null;
  }
}

module.exports = { trimNativeMemory, canTrimNativeMemory };
