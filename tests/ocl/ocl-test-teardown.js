const fs = require('fs/promises');

afterAll(async () => {
  const dir = process.env.OCL_CACHE_DIR;
  delete process.env.OCL_CACHE_DIR;
  if (dir) {
    try { await fs.rm(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
});
