'use strict';

/**
 * Read-only memory mapping of SNOMED CT cache files ("snomed": {"load": "mmap"} in config.json).
 *
 * Node has no mmap of its own, so this calls the C library's mmap() through koffi (an FFI
 * module that ships prebuilt binaries for Linux glibc and musl, macOS and the BSDs, so
 * nothing is compiled at install time). The mapping is never unmapped: a loaded edition
 * stays loaded for the life of the process.
 *
 * mapFile() returns null where mapping is not available (Windows, koffi missing, mmap
 * failing), and the caller then reads the file into memory as before. It says why through the
 * warn function it is given (the server log), or console.warn where there is none.
 */

const fs = require('fs');

const PROT_READ = 1;
const MAP_PRIVATE = 2;          // same value on Linux, macOS and the BSDs
const MAP_FAILED = 0xFFFFFFFFFFFFFFFFn;

let libcMmap;                   // undefined: not tried yet; null: not available
let unavailable = null;         // why libcMmap is null

function getMmap() {
  if (libcMmap === undefined) {
    libcMmap = null;
    if (process.platform === 'win32' || !process.arch.endsWith('64')) {
      unavailable = `not supported on ${process.platform}/${process.arch}`;
    } else {
      try {
        const koffi = require('koffi');
        const mmap = koffi.load(null).func('void *mmap(void *addr, size_t len, int prot, int flags, int fd, int64_t off)');
        libcMmap = { koffi, mmap };
      } catch (e) {
        unavailable = e.message;
      }
    }
  }
  return libcMmap;
}

/** True if mapFile() can map files on this platform (it may still fail for a given file). */
function mappingAvailable() {
  return getMmap() !== null;
}

/**
 * @param {string} filePath
 * @param {function(string)} [warn] - where to say why the file was not mapped
 * @returns {Buffer|null} a read-only Buffer over the whole file, or null
 */
function mapFile(filePath, warn = (msg) => console.warn(msg)) {
  const lib = getMmap();
  if (!lib) {
    warn(`SNOMED CT: memory mapping is not available here (${unavailable}); reading ${filePath} into memory`);
    return null;
  }
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return null;
    const ptr = lib.mmap(null, size, PROT_READ, MAP_PRIVATE, fd, 0);
    if (ptr === null || lib.koffi.address(ptr) === MAP_FAILED) {
      warn(`SNOMED CT: could not map ${filePath} (errno ${lib.koffi.errno()}); reading it into memory`);
      return null;
    }
    return Buffer.from(lib.koffi.view(ptr, size));
  } finally {
    fs.closeSync(fd);   // the mapping keeps its own reference to the file
  }
}

/**
 * Read a file through once, in the background, so its pages are in the page cache before
 * requests need them (madvise(MADV_WILLNEED) is only a hint, and on Linux it read almost
 * nothing of a mapped file). The reads go through one small buffer, so this costs no process
 * memory; the pages land in the page cache that every mapping of the file shares.
 *
 * @param {string} filePath
 * @returns {Promise<number>} milliseconds taken
 */
async function prewarmFile(filePath) {
  const start = Date.now();
  const buf = Buffer.allocUnsafe(4 * 1024 * 1024);
  const fh = await fs.promises.open(filePath, 'r');
  try {
    let pos = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (bytesRead === 0) break;
      pos += bytesRead;
    }
  } finally {
    await fh.close();
  }
  return Date.now() - start;
}

/**
 * For tests: replace the mmap binding ({koffi, mmap}, or null with a reason for "not
 * available"), or with no arguments go back to the real one.
 */
function _setMmapForTesting(lib, reason = 'disabled by a test') {
  libcMmap = arguments.length === 0 ? undefined : lib;
  unavailable = lib ? null : reason;
}

module.exports = { mapFile, prewarmFile, mappingAvailable, _setMmapForTesting };
