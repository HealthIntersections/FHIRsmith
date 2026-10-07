/**
 * The memory limit the kernel will actually enforce on this process.
 *
 * Reading `/sys/fs/cgroup/memory.max` only works inside a container with its own
 * cgroup namespace, where the process's cgroup is mounted as the root. Under plain
 * systemd (how tx.fhir.org runs) the whole host hierarchy is visible, the root cgroup
 * has no memory.max at all, and the limit lives at e.g.
 * `/sys/fs/cgroup/system.slice/fhirsmith.service/memory.max`. So: find our cgroup in
 * /proc/self/cgroup, then walk from it up to the root, taking the smallest limit -
 * a MemoryMax on the enclosing slice binds just as hard as one on the unit.
 *
 * Handles cgroup v2 (unified) and v1 (memory controller). Anything unreadable or
 * unlimited is ignored; if nothing is found the result is 0.
 *
 * @module library/cgroup-memory
 */

const fs = require('fs');
const path = require('path');

// cgroup v1 reports "unlimited" as a page-rounded LONG_MAX; anything this big is no limit.
const V1_UNLIMITED = 2 ** 60;

function readLimitFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8').trim();
  } catch {
    return 0;
  }
  if (raw === '' || raw === 'max') {
    return 0;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n >= V1_UNLIMITED) {
    return 0;
  }
  return n;
}

/**
 * Walk from cgroupPath up to '/', returning the smallest limit found under mountDir.
 */
function smallestLimit(mountDir, cgroupPath, fileName) {
  let limit = 0;
  let source = null;
  let p = path.posix.normalize(cgroupPath || '/');
  for (;;) {
    const file = path.join(mountDir, p, fileName);
    const n = readLimitFile(file);
    if (n > 0 && (limit === 0 || n < limit)) {
      limit = n;
      source = file;
    }
    if (p === '/' || p === '.' || p === '') {
      break;
    }
    p = path.posix.dirname(p);
  }
  return { limit, source };
}

/**
 * @param {Object} [opts] - For tests: alternative locations of the proc file and cgroup mount.
 * @param {string} [opts.procFile='/proc/self/cgroup']
 * @param {string} [opts.cgroupRoot='/sys/fs/cgroup']
 * @returns {{limit: number, source: string|null}} limit in bytes (0 = none found), and the
 *   file it came from.
 */
function readCgroupMemoryLimit(opts = {}) {
  const procFile = opts.procFile || '/proc/self/cgroup';
  const cgroupRoot = opts.cgroupRoot || '/sys/fs/cgroup';

  let lines = [];
  try {
    lines = fs.readFileSync(procFile, 'utf8').split('\n').filter(l => l.trim() !== '');
  } catch {
    // not Linux, or /proc not mounted - fall through to the namespaced-root guess
  }

  // v2: "0::/system.slice/fhirsmith.service"
  const v2 = lines.find(l => l.startsWith('0::'));
  if (v2) {
    const result = smallestLimit(cgroupRoot, v2.substring(3), 'memory.max');
    if (result.limit > 0) {
      return result;
    }
  }

  // v1: "4:memory:/system.slice/fhirsmith.service"
  for (const l of lines) {
    const parts = l.split(':');
    if (parts.length >= 3 && parts[1].split(',').includes('memory')) {
      const result = smallestLimit(path.join(cgroupRoot, 'memory'), parts.slice(2).join(':'), 'memory.limit_in_bytes');
      if (result.limit > 0) {
        return result;
      }
    }
  }

  // No /proc/self/cgroup: a namespaced container still has its own limit at the root.
  if (lines.length === 0) {
    const file = path.join(cgroupRoot, 'memory.max');
    const n = readLimitFile(file);
    if (n > 0) {
      return { limit: n, source: file };
    }
  }

  return { limit: 0, source: null };
}

module.exports = { readCgroupMemoryLimit };
