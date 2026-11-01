'use strict';

/**
 * Read-only memory mapping of SNOMED CT cache files (snomedLoad: mmap).
 *
 * Node has no mmap of its own, so this calls the C library's mmap() through koffi (an FFI
 * module that ships prebuilt binaries for Linux glibc and musl, macOS and the BSDs, so
 * nothing is compiled at install time). The mapping is never unmapped: a loaded edition
 * stays loaded for the life of the process.
 *
 * mapFile() returns null where mapping is not available (Windows, koffi missing, mmap
 * failing), and the caller then reads the file into memory as before.
 */

const fs = require('fs');

const PROT_READ = 1;
const MAP_PRIVATE = 2;          // same value on Linux, macOS and the BSDs
const MAP_FAILED = 0xFFFFFFFFFFFFFFFFn;

let libcMmap;                   // undefined: not tried yet; null: not available

function getMmap() {
  if (libcMmap === undefined) {
    libcMmap = null;
    if (process.platform !== 'win32' && process.arch.endsWith('64')) {
      try {
        const koffi = require('koffi');
        const mmap = koffi.load(null).func('void *mmap(void *addr, size_t len, int prot, int flags, int fd, int64_t off)');
        libcMmap = { koffi, mmap };
      } catch (e) {
        console.warn(`SNOMED CT: memory mapping is not available here (${e.message}); reading cache files into memory`);
      }
    }
  }
  return libcMmap;
}

/**
 * @param {string} filePath
 * @returns {Buffer|null} a read-only Buffer over the whole file, or null
 */
function mapFile(filePath) {
  const lib = getMmap();
  if (!lib) return null;
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return null;
    const ptr = lib.mmap(null, size, PROT_READ, MAP_PRIVATE, fd, 0);
    if (ptr === null || lib.koffi.address(ptr) === MAP_FAILED) {
      console.warn(`SNOMED CT: could not map ${filePath} (errno ${lib.koffi.errno()}); reading it into memory`);
      return null;
    }
    return Buffer.from(lib.koffi.view(ptr, size));
  } finally {
    fs.closeSync(fd);   // the mapping keeps its own reference to the file
  }
}

module.exports = { mapFile };
