const fs = require('fs/promises');
const fsSync = require('fs');
const Logger = require('../../../library/logger');
const oclLog = Logger.getInstance().child({ module: 'ocl' });

async function ensureCacheDirectories(...dirs) {
  for (const dir of dirs) {
    if (!dir) {
      continue;
    }

    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (error) {
      oclLog.error(`Failed to create cache directory: ${dir} ${error.message}`);
    }
  }
}

function getColdCacheAgeMs(cacheFilePath) {
  try {
    const stats = fsSync.statSync(cacheFilePath);
    if (!stats || !Number.isFinite(stats.mtimeMs)) {
      return null;
    }

    return Math.max(0, Date.now() - stats.mtimeMs);
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      oclLog.error(`Failed to inspect cold cache file ${cacheFilePath}: ${error.message}`);
    }
    return null;
  }
}

function formatCacheAgeMinutes(ageMs) {
  const minutes = Math.max(1, Math.round(ageMs / 60000));
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

async function atomicWriteFile(filePath, data) {
  const tmpPath = filePath + '.tmp.' + process.pid;
  await fs.writeFile(tmpPath, data, 'utf-8');
  await fs.rename(tmpPath, filePath);
}

function getColdCacheMtimeMs(cacheFilePath) {
  try {
    const stats = fsSync.statSync(cacheFilePath);
    if (!stats || !Number.isFinite(stats.mtimeMs)) {
      return null;
    }
    return stats.mtimeMs;
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      oclLog.error(`Failed to stat cold cache file ${cacheFilePath}: ${error.message}`);
    }
    return null;
  }
}

module.exports = {
  ensureCacheDirectories,
  getColdCacheAgeMs,
  formatCacheAgeMinutes,
  atomicWriteFile,
  getColdCacheMtimeMs
};
