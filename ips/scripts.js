//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/*
 * The module's browser scripts: its own files, read once and served from memory (so no
 * request reaches the file system), with an ETag. A page links a script with its version
 * (?v=, from the script's content), so a browser that has kept a copy picks up a changed
 * script as soon as the server serves it, not when its cached copy expires.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCRIPTS = new Map();

function load(name) {
  if (!SCRIPTS.has(name)) {
    const body = fs.readFileSync(path.join(__dirname, name), 'utf8');
    const hash = crypto.createHash('sha256').update(body).digest('base64url');
    SCRIPTS.set(name, { body, etag: `"${hash.substring(0, 27)}"`, version: hash.substring(0, 12) });
  }
  return SCRIPTS.get(name);
}

/** The route handler that serves the script. */
function handler(name) {
  const s = load(name);
  return (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('ETag', s.etag);
    if (req.get('If-None-Match') === s.etag) {
      return res.status(304).end();
    }
    res.type('application/javascript').send(s.body);
  };
}

/** The script's URL, for a page: base/name?v=version (not escaped). */
function src(base, name) {
  return `${base}/${name}?v=${load(name).version}`;
}

module.exports = { handler, src };
