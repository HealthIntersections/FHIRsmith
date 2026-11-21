/**
 * Reads config.json, which may have comments: // to the end of the line, and /* ... *\/ blocks,
 * anywhere JSON allows white space. Otherwise it is plain JSON (no trailing commas, no single
 * quotes).
 *
 * The comments are replaced by spaces (keeping their line breaks), so a JSON syntax error is
 * reported at the line and column it has in the file.
 */
const fs = require('fs');

/**
 * The JSON text with its comments blanked out. Text in strings is left alone, so a URL like
 * "http://example.org" is not a comment
 * @param {string} text
 * @returns {string}
 */
function stripComments(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      // a string: copy it as is, up to the closing quote that isn't escaped
      let j = i + 1;
      while (j < n && text[j] !== '"') {
        if (text[j] === '\\') {
          j++;
        }
        j++;
      }
      out += text.substring(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      let j = i;
      while (j < n && text[j] !== '\n' && text[j] !== '\r') {
        j++;
      }
      out += ' '.repeat(j - i);
      i = j;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) {
        throw new Error(`unterminated /* comment at ${position(text, i)}`);
      }
      out += text.substring(i, end + 2).replace(/[^\r\n]/g, ' ');
      i = end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** "line L, column C" (1-based) of an offset in the text */
function position(text, offset) {
  const before = text.substring(0, offset);
  const line = before.split('\n').length;
  const column = offset - before.lastIndexOf('\n');
  return `line ${line}, column ${column}`;
}

/**
 * Parse config.json text (JSON with comments)
 * @param {string} text
 * @returns {Object}
 * @throws {Error} with the line and column of a syntax error
 */
function parseConfig(text) {
  if (text.charCodeAt(0) === 0xFEFF) {
    text = text.substring(1); // a byte order mark, as some Windows editors write
  }
  const json = stripComments(text);
  try {
    return JSON.parse(json);
  } catch (e) {
    // V8 says "... at position N" (sometimes with "(line L column C)"): give the line and column
    const m = /at position (\d+)/.exec(e.message);
    if (m && !/line \d+/.test(e.message)) {
      throw new Error(`${e.message} (${position(json, Number(m[1]))})`);
    }
    throw e;
  }
}

/**
 * Read and parse a config file (JSON with comments)
 * @param {string} filePath
 * @returns {Object}
 */
function readConfig(filePath) {
  return parseConfig(fs.readFileSync(filePath, 'utf8'));
}

module.exports = { readConfig, parseConfig, stripComments };
