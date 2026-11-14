const path = require('path');

const CACHE_BASE_DIR = process.env.OCL_CACHE_DIR || path.join(process.cwd(), 'data', 'terminology-cache', 'ocl');
const CACHE_CS_DIR = path.join(CACHE_BASE_DIR, 'codesystems');
const CACHE_VS_DIR = path.join(CACHE_BASE_DIR, 'valuesets');
const DISCOVERY_SNAPSHOT_PATH = path.join(CACHE_BASE_DIR, 'discovery-snapshot.json');
const VS_DISCOVERY_SNAPSHOT_PATH = path.join(CACHE_BASE_DIR, 'vs-discovery-snapshot.json');

function sanitizeFilename(text) {
  if (!text || typeof text !== 'string') {
    return 'unknown';
  }
  return text
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .substring(0, 200);
}

function getCacheFilePath(baseDir, canonicalUrl, version = null, paramsKey = null) {
  const crypto = require('crypto');
  const base = `${canonicalUrl}|${version || ''}|${paramsKey || 'default'}`;
  const hash = crypto.createHash('sha256').update(base).digest('hex');
  const filename = `${hash}.json`;
  return path.join(baseDir, filename);
}

module.exports = {
  CACHE_BASE_DIR,
  CACHE_CS_DIR,
  CACHE_VS_DIR,
  DISCOVERY_SNAPSHOT_PATH,
  VS_DISCOVERY_SNAPSHOT_PATH,
  sanitizeFilename,
  getCacheFilePath
};
