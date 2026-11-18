//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/*
 * The files the patient IPS editor needs in the browser - its own scripts, translations and
 * images (ips/patient-editor), and the libraries it uses (ips/vendor: commonmark, jsPDF,
 * html2canvas, pdf-lib, zip.js) - served by the module itself rather than from CDNs. (jQuery
 * and jQuery UI are the ones the page template already loads.)
 * Like scripts.js, they are read once at startup and served from memory: a request can only
 * name a file in the list, so it never reaches the file system.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const AREAS = {
  'patient-editor': path.join(__dirname, 'patient-editor'),
  vendor: path.join(__dirname, 'vendor'),
  // the general editor's test patients (made by general-editor/make-test-patients.js)
  'test-patients': path.join(__dirname, 'general-editor', 'test-patients')
};
const TYPES = {
  '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png',
  '.gif': 'image/gif', '.css': 'text/css', '.svg': 'image/svg+xml'
};

let FILES = null;

function walk(area, dir, rel, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const name = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      walk(area, full, name, out);
    } else if (entry.isFile() && TYPES[path.extname(entry.name)]) {
      const body = fs.readFileSync(full);
      const hash = crypto.createHash('sha256').update(body).digest('base64url');
      out.set(`${area}/${name}`, { body, type: TYPES[path.extname(entry.name)], etag: `"${hash.substring(0, 27)}"`, version: hash.substring(0, 12) });
    }
  }
}

function files() {
  if (!FILES) {
    FILES = new Map();
    for (const [area, dir] of Object.entries(AREAS)) {
      if (fs.existsSync(dir)) {
        walk(area, dir, '', FILES);
      }
    }
  }
  return FILES;
}

/** The route handler for {base}/assets/*: the file, or 404. */
function handler(req, res) {
  const key = Array.isArray(req.params.file) ? req.params.file.join('/') : String(req.params.file || '');
  const f = files().get(key);
  if (!f) {
    return res.status(404).type('text/plain').send('Not found');
  }
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('ETag', f.etag);
  if (req.get('If-None-Match') === f.etag) {
    return res.status(304).end();
  }
  res.type(f.type).send(f.body);
}

/** A file's URL, for a page: base/assets/key?v=version (not escaped). */
function src(base, key) {
  const f = files().get(key);
  if (!f) {
    throw new Error(`No asset ${key}`);
  }
  return `${base}/assets/${key}?v=${f.version}`;
}

/** The text of a file in the module's folders (the patient editor's page). */
function text(area, name) {
  return fs.readFileSync(path.join(AREAS[area], name), 'utf8');
}

/**
 * The general editor's test patients (general-editor/test-patients/*.json): name (from the
 * file name: 2-new-mother.json is "New mother") and URL.
 */
function testPatients(base) {
  const out = [];
  for (const key of files().keys()) {
    const m = /^test-patients\/([a-z0-9-]+)\.json$/.exec(key);
    if (m) {
      const words = m[1].replace(/^\d+-/, '').replace(/-/g, ' ');
      out.push({ key: m[1], name: words.charAt(0).toUpperCase() + words.substring(1), url: src(base, key) });
    }
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

module.exports = { handler, src, text, files, testPatients };
