const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocl-test-'));
process.env.OCL_CACHE_DIR = tmpDir;
