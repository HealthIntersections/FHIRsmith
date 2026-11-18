const express = require('express');
const fs = require('fs');
const path = require('path');
const USERS_FILE = '.users.json';
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
const SAFE_NAME = /^[a-zA-Z0-9._-]+$/;
const AUTH_FAIL_DELAY_MS = 5000;
const folderLog = require('../library/logger').getInstance().child({ module: 'folder' });

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

class FolderModule {
  constructor(stats) {
    this.folders = [];
    this.stats = stats;
  }

  initialize(config, app) {
    this.folders = [];

    const folderConfigs = config.folders || [];
    for (const fc of folderConfigs) {
      if (fc.enabled === false) {
        continue;
      }
      if (!fc.folder || !fc.url || !fc.name) {
        folderLog.warn(`config entry missing required fields (name, folder, url) - skipping`);
        continue;
      }
      const rootDir = path.resolve(fc.folder);
      if (!fs.existsSync(rootDir)) {
        folderLog.warn(`path ${rootDir} does not exist - skipping "${fc.name}"`);
        continue;
      }

      const urlBase = fc.url.startsWith('/') ? fc.url : '/' + fc.url;
      const router = express.Router();

      // GET - serve files and directory listings
      router.get(urlBase + '/{*subpath}', (req, res) => {
        this.handleGet(req, res, rootDir, urlBase);
      });
      router.get(urlBase, (req, res) => {
        this.handleGet(req, res, rootDir, urlBase);
      });

      // PUT - upload with basic auth (express.raw captures body before any global JSON parser)
      router.put(urlBase + '/{*subpath}', express.raw({ type: '*/*', limit: MAX_UPLOAD_BYTES }), (req, res) => {
        this.handlePut(req, res, rootDir, urlBase);
      });

      app.use('/', router);
      this.folders.push({ name: fc.name, folder: rootDir, url: urlBase });
      folderLog.info(`serving "${fc.name}" from ${rootDir} at ${urlBase}`);
    }

    if (this.folders.length === 0) {
      folderLog.warn('no folders configured');
    }
  }

  handleGet(req, res, rootDir, urlBase) {
    this.stats.countRequest('search', 0);
    const subPath = req.path.substring(urlBase.length) || '/';
    const safePath = path.normalize(subPath);
    if (safePath.includes('..')) {
      return res.status(403).send('Forbidden');
    }

    const fullPath = path.join(rootDir, safePath);

    // never serve .users.json
    if (path.basename(fullPath) === '.users.json') {
      return res.status(403).send('Forbidden');
    }

    if (!fs.existsSync(fullPath)) {
      return res.status(404).send('Not found');
    }

    const stat = fs.statSync(fullPath);
    if (stat.isFile()) {
      return res.sendFile(fullPath);
    }

    if (stat.isDirectory()) {
      return this.sendDirectoryListing(res, fullPath, req.path);
    }

    return res.status(404).send('Not found');
  }

  sendDirectoryListing(res, dirPath, requestPath) {
    const start = Date.now();
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const urlPath = requestPath.endsWith('/') ? requestPath : requestPath + '/';

    // separate dirs and files, exclude .users.json
    const dirs = entries.filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
    const files = entries.filter(e => e.isFile() && e.name !== '.users.json').sort((a, b) => a.name.localeCompare(b.name));

    const safeRequestPath = escapeHtml(requestPath);
    let html = `<html><head><title>Index of ${safeRequestPath}</title></head><body>`;
    html += `<h1>Index of ${safeRequestPath}</h1><pre>`;

    // parent directory link (if not at mount root)
    if (requestPath.split('/').filter(Boolean).length > 1) {
      html += `<a href="${urlPath}..">../</a>\n`;
    }

    for (const dir of dirs) {
      const safeDirName = escapeHtml(dir.name);
      html += `<a href="${urlPath}${encodeURIComponent(dir.name)}/">${safeDirName}/</a>\n`;
    }

    for (const file of files) {
      const stat = fs.statSync(path.join(dirPath, file.name));
      const size = this.formatSize(stat.size);
      const safeFileName = escapeHtml(file.name);
      html += `<a href="${urlPath}${encodeURIComponent(file.name)}">${safeFileName}</a>${' '.repeat(Math.max(1, 60 - file.name.length))}${size}\n`;
    }

    html += '</pre></body></html>';
    this.stats.countRequest('folder', Date.now() - start);
    res.type('html').send(html);
  }

  formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  }

  handlePut(req, res, rootDir, urlBase) {
    this.stats.countRequest('submit', 0);
    const subPath = req.path.substring(urlBase.length);
    const safePath = path.normalize(subPath);
    if (safePath.includes('..')) {
      return res.status(403).send('Forbidden');
    }

    const fullPath = path.join(rootDir, safePath);

    // must be a file path, not a directory
    if (safePath === '/' || safePath === '') {
      return res.status(400).send('Cannot PUT to directory root');
    }

    // validate every path segment: alphanumeric, dots, dashes, underscores only
    // split on both / and \ since path.normalize uses \ on Windows
    const segments = safePath.split(/[/\\]/).filter(Boolean);
    for (const seg of segments) {
      if (!SAFE_NAME.test(seg)) {
        return res.status(400).send('Invalid path: names may only contain letters, numbers, dots, dashes and underscores');
      }
    }

    // only allow .zip files
    const filename = path.basename(fullPath);
    if (!filename.toLowerCase().endsWith('.zip')) {
      return res.status(400).send('Only .zip files may be uploaded');
    }

    // check content-length before reading body
    const contentLength = parseInt(req.headers['content-length'], 10);
    if (contentLength > MAX_UPLOAD_BYTES) {
      return res.status(413).send(`File too large (limit ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)`);
    }

    // authenticate
    const credentials = this.parseBasicAuth(req);
    if (!credentials) {
      res.set('WWW-Authenticate', 'Basic realm="Folder Upload"');
      return res.status(401).send('Authentication required');
    }

    if (!this.checkUser(rootDir, path.dirname(fullPath), credentials.username, credentials.password)) {
      // deliberate delay to slow down brute-force attempts
      return setTimeout(() => {
        res.set('WWW-Authenticate', 'Basic realm="Folder Upload"');
        res.status(403).send('Access denied');
      }, AUTH_FAIL_DELAY_MS);
    }

    this.getBody(req).then(body => {
      // double-check actual body size
      if (body.length > MAX_UPLOAD_BYTES) {
        return res.status(413).send(`File too large (limit ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)`);
      }

      // ensure parent directory exists
      const parentDir = path.dirname(fullPath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }

      // write the file
      fs.writeFileSync(fullPath, body);

      // if it's main.zip or master.zip, also save as default.zip
      const basename = path.basename(fullPath).toLowerCase();
      if (basename === 'main.zip' || basename === 'master.zip') {
        const defaultPath = path.join(parentDir, 'default.zip');
        fs.copyFileSync(fullPath, defaultPath);
      }

      return res.status(200).send('OK');
    }).catch(err => {
      folderLog.error(`PUT failed for ${fullPath}: ${err.message}`);
      return res.status(500).send('Upload failed');
    });
  }

  // get request body as a Buffer, whether or not global middleware already parsed it
  getBody(req) {
    // if global middleware already parsed it, use that
    if (Buffer.isBuffer(req.body)) {
      return Promise.resolve(req.body);
    }
    if (req.body && typeof req.body === 'object') {
      return Promise.resolve(Buffer.from(JSON.stringify(req.body)));
    }
    if (req.body) {
      return Promise.resolve(Buffer.from(req.body));
    }
    // no middleware parsed it — read from stream
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  parseBasicAuth(req) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Basic ')) {
      return null;
    }
    const decoded = Buffer.from(header.substring(6), 'base64').toString('utf-8');
    const colon = decoded.indexOf(':');
    if (colon < 0) {
      return null;
    }
    return {
      username: decoded.substring(0, colon),
      password: decoded.substring(colon + 1)
    };
  }

  // walk up from the target directory to rootDir looking for .users.json
  checkUser(rootDir, dir, username, password) {
    let current = path.resolve(dir);
    const root = path.resolve(rootDir);

    for (;;) {
      const usersPath = path.join(current, USERS_FILE);
      if (fs.existsSync(usersPath)) {
        try {
          const users = JSON.parse(fs.readFileSync(usersPath, 'utf-8'));
          if (users[username] && users[username] === password) {
            return true;
          }
        } catch (e) {
          // malformed json, keep walking up
        }
      }

      if (current === root) {
        break;
      }

      const parent = path.dirname(current);
      if (parent === current) {
        break;  // filesystem root - stop
      }
      current = parent;
    }

    return false;
  }

  shutdown() {
    // nothing to clean up
  }

  getStatus() {
    return {
      folders: this.folders.map(f => ({
        name: f.name,
        folder: f.folder,
        url: f.url
      }))
    };
  }
}

module.exports = FolderModule;