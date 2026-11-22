//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * A document as a ZIP or a PDF, made on the server - for the API ($document), where the web
 * page makes them in the browser (doc-actions.js download). The same content: the ZIP holds
 * the document as {name}.json; the PDF has the title, the patient, the date and each section's
 * narrative (doc-actions.js defaultHtml), with the document attached as {name}.json.
 *
 * The PDF is laid out as text with pdf-lib's standard fonts, not rendered from the HTML: tables
 * become rows of cells, images are left out, and characters the standard fonts don't have
 * (outside Windows-1252) show as '?'.
 */

const zlib = require('zlib');
const parse5 = require('parse5');
const { PDFDocument, StandardFonts, rgb } = require('./vendor/pdf-lib.min.js');

// ---- ZIP --------------------------------------------------------------------------------------

/**
 * A ZIP file of the given files (deflated; names in UTF-8).
 * @param {Array<{name: string, data: Buffer|string}>} files
 * @param {Date} [when] - the files' modification time
 * @returns {Buffer}
 */
function zip(files, when = new Date()) {
  const dosTime = (when.getHours() << 11) | (when.getMinutes() << 5) | Math.floor(when.getSeconds() / 2);
  const dosDate = ((Math.max(when.getFullYear(), 1980) - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const packed = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, packed);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

// ---- PDF --------------------------------------------------------------------------------------

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const str = (x) => (typeof x === 'string' ? x : '');

// as doc-actions.js resolve
function resolve(bundle, ref) {
  const r = ref && typeof ref.reference === 'string' ? ref.reference : null;
  if (!r) {
    return null;
  }
  for (const e of bundle.entry || []) {
    const res = e?.resource;
    if (res && (e.fullUrl === r || `${res.resourceType}/${res.id}` === r || (e.fullUrl && e.fullUrl.slice(-r.length - 1) === '/' + r))) {
      return res;
    }
  }
  return null;
}

function nameOf(p) {
  const n = p && Array.isArray(p.name) ? p.name[0] : null;
  if (!n) {
    return '';
  }
  return n.text || `${(n.given || []).join(' ')} ${n.family || ''}`.trim();
}

const BLOCKS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'pre', 'blockquote', 'dl', 'dt', 'dd', 'hr', 'caption']);
const SKIP = new Set(['script', 'style', 'img', 'head', 'title']);

/**
 * A narrative (XHTML) as lines of text: blocks are lines, list items are bulleted, a table row
 * is its cells joined with ' | ', headings are bold.
 * @returns {Array<{text: string, bold: boolean}>}
 */
function narrativeLines(div) {
  const lines = [];
  let current = '';
  let bold = false;
  const flush = () => {
    const t = current.replace(/\s+/g, ' ').trim();
    if (t) {
      lines.push({ text: t, bold });
    }
    current = '';
    bold = false;
  };
  const walk = (node) => {
    const tag = node.tagName;
    if (tag && SKIP.has(tag)) {
      return;
    }
    if (node.nodeName === '#text') {
      current += node.value;
      return;
    }
    if (tag === 'br') {
      flush();
      return;
    }
    if (tag === 'tr') {
      flush();
      const cells = (node.childNodes || []).filter(c => c.tagName === 'td' || c.tagName === 'th');
      const text = cells.map(c => {
        const inner = narrativeLines(parse5.serializeOuter(c)).map(l => l.text).join(' ');
        return inner;
      }).join(' | ');
      lines.push({ text: text.replace(/\s+/g, ' ').trim(), bold: cells.length > 0 && cells.every(c => c.tagName === 'th') });
      return;
    }
    const block = tag && BLOCKS.has(tag);
    if (block) {
      flush();
    }
    if (tag === 'li') {
      current = '• ';
    }
    if (/^h[1-6]$/.test(tag || '')) {
      bold = true;
    }
    for (const c of node.childNodes || []) {
      walk(c);
    }
    if (block) {
      flush();
    }
  };
  for (const c of parse5.parseFragment(str(div)).childNodes) {
    walk(c);
  }
  flush();
  return lines.filter(l => l.text);
}

/** What the PDF says, as doc-actions.js defaultHtml has it. @returns {Array<{text, kind}>} kind: h1, h2, p, i */
function pdfContent(bundle) {
  const comp = bundle?.entry?.[0]?.resource;
  if (!isObject(comp)) {
    return [{ text: 'Patient Summary', kind: 'h1' }];
  }
  const out = [{ text: comp.title || 'Patient Summary', kind: 'h1' }];
  const patient = resolve(bundle, comp.subject);
  if (patient) {
    out.push({ text: nameOf(patient) + (patient.birthDate ? `, born ${patient.birthDate}` : '') + (patient.gender ? `, ${patient.gender}` : ''), kind: 'b' });
  }
  if (comp.date) {
    out.push({ text: `Date: ${comp.date}`, kind: 'p' });
  }
  for (const s of comp.section || []) {
    if (!isObject(s)) {
      continue;
    }
    out.push({ text: s.title || s.code?.text || 'Section', kind: 'h2' });
    if (s.text && s.text.div) {
      for (const l of narrativeLines(s.text.div)) {
        out.push({ text: l.text, kind: l.bold ? 'b' : 'p' });
      }
    } else if (s.emptyReason) {
      out.push({ text: s.emptyReason.coding?.[0]?.display || s.emptyReason.text || 'Empty', kind: 'i' });
    }
  }
  return out;
}

/**
 * The document as a PDF (A4), with the document attached as {name}.json.
 * @param {Object} bundle - the document
 * @param {string} json - the document as text (what is attached)
 * @param {string} name - the attachment's name, without .json
 * @returns {Promise<Buffer>}
 */
async function pdf(bundle, json, name) {
  const doc = await PDFDocument.create();
  const fonts = {
    p: await doc.embedFont(StandardFonts.Helvetica),
    b: await doc.embedFont(StandardFonts.HelveticaBold),
    i: await doc.embedFont(StandardFonts.HelveticaOblique)
  };
  const SIZES = { h1: 18, h2: 13, b: 10, p: 10, i: 10 };
  const FONT = { h1: 'b', h2: 'b', b: 'b', p: 'p', i: 'i' };
  // what the standard fonts can show (Windows-1252): anything else is '?'
  const known = new Set(fonts.p.getCharacterSet());
  const clean = (t) => Array.from(t.normalize('NFC').replace(/[\t\r\n]/g, ' ')).map(ch => (known.has(ch.codePointAt(0)) ? ch : '?')).join('');
  const W = 595.28;
  const H = 841.89;
  const M = 40;
  let page = doc.addPage([W, H]);
  let y = H - M;
  const newPage = () => {
    page = doc.addPage([W, H]);
    y = H - M;
  };
  // split a line into lines that fit the width (a word too long is broken)
  const wrap = (text, font, size) => {
    const width = W - 2 * M;
    const out = [];
    let line = '';
    for (const word of text.split(' ')) {
      const tryLine = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(tryLine, size) <= width) {
        line = tryLine;
        continue;
      }
      if (line) {
        out.push(line);
      }
      let w = word;
      while (font.widthOfTextAtSize(w, size) > width) {
        let n = w.length - 1;
        while (n > 1 && font.widthOfTextAtSize(w.substring(0, n), size) > width) {
          n--;
        }
        out.push(w.substring(0, n));
        w = w.substring(n);
      }
      line = w;
    }
    if (line) {
      out.push(line);
    }
    return out;
  };
  for (const item of pdfContent(bundle)) {
    const size = SIZES[item.kind];
    const font = fonts[FONT[item.kind]];
    if (item.kind === 'h2') {
      y -= 8;
    }
    for (const line of wrap(clean(item.text), font, size)) {
      if (y - size < M) {
        newPage();
      }
      y -= size * 1.3;
      page.drawText(line, { x: M, y, size, font, color: rgb(0, 0, 0) });
    }
    y -= item.kind === 'h1' ? 8 : 3;
  }
  const title = pdfContent(bundle)[0].text;
  doc.setTitle(title);
  doc.setProducer('FHIRsmith');
  await doc.attach(Buffer.from(json, 'utf8'), `${name}.json`, { mimeType: 'application/fhir+json', description: 'IPS Document' });
  // without object streams: plainer, and what is attached can be seen in the file
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

module.exports = { zip, pdf, pdfContent, narrativeLines };
