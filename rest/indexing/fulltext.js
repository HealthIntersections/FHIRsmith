//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * Full-text search: _text (the narrative) and _content (the whole resource).
 *
 * Each resource has a row in TextIndex with two columns: Narrative, the text of text.div with
 * the markup taken out, and Content, every string in the resource (the narrative's text
 * included, base64 data left out). Both are normalised as string search values are (accents
 * and case folded), so the engines' own folding doesn't matter, and both are written in the
 * resource's write transaction, as the other index rows are.
 *
 *   SQLite  an FTS5 table (rowid = ResourceKey), searched with MATCH
 *   MySQL   an InnoDB table with a FULLTEXT index on each column, searched with
 *           MATCH ... AGAINST in boolean mode
 *
 * The search value is never handed to the engine as it is: it is parsed (words, "phrases",
 * AND, OR, NOT or a leading -, brackets) and written out again in each engine's syntax, with
 * only letters and digits inside the terms. A word matches as a prefix (chalm finds Chalmers);
 * a phrase matches as it is.
 *
 * @module rest/indexing/fulltext
 */

const { badRequest } = require('../library/errors');
const { normalise } = require('./values');

// the most text kept for a resource's column (characters)
const MAX_TEXT = 1000000;
// the longest search value, and the most terms in it
const MAX_QUERY = 1000;
const MAX_TERMS = 32;

// ---- the text ----

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ' };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,8});/g, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.substring(2), 16) : parseInt(e.substring(1), 10);
      return n > 0 && n <= 0x10FFFF ? String.fromCodePoint(n) : ' ';
    }
    return ENTITIES[e.toLowerCase()] || ' ';
  });
}

/**
 * The words of a narrative: the markup taken out (by a scan, not a pattern that could
 * backtrack on a long run of '<'), entities decoded.
 * @param {string} div
 * @returns {string}
 */
function narrativeText(div) {
  if (typeof div !== 'string' || !div) {
    return '';
  }
  let out = '';
  let i = 0;
  for (;;) {
    const lt = div.indexOf('<', i);
    if (lt < 0) {
      out += div.substring(i);
      break;
    }
    out += div.substring(i, lt) + ' ';
    const gt = div.indexOf('>', lt);
    if (gt < 0) {
      break;
    }
    i = gt + 1;
  }
  return decodeEntities(out).replace(/\s+/g, ' ').trim();
}

/**
 * Every string in a resource (and the narrative's text), but not base64 data, not the
 * narrative's markup, and not the names of the elements.
 * @param {Object} resource
 * @returns {string}
 */
function contentText(resource) {
  const parts = [];
  let size = 0;
  const walk = (v, key) => {
    if (size > MAX_TEXT) {
      return;
    }
    if (typeof v === 'string') {
      if (key === 'div') {
        v = narrativeText(v);
      } else if (key === 'data' || key === 'resourceType') {
        return;
      }
      parts.push(v);
      size += v.length + 1;
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      if (key !== 'versionId') {
        parts.push(String(v));
        size += 8;
      }
    } else if (Array.isArray(v)) {
      for (const x of v) {
        walk(x, key);
      }
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (k !== 'meta') {
          walk(x, k);
        }
      }
    }
  };
  walk(resource, null);
  return parts.join(' ');
}

/** Text as it is stored and searched: normalised, as string search values are */
function folded(text) {
  return normalise(text).substring(0, MAX_TEXT);
}

// ---- the search value ----

/**
 * The words in a piece of text, as the index splits it (letters and digits).
 * @param {string} text
 * @returns {string[]}
 */
function words(text) {
  return folded(text).split(/[^\p{L}\p{N}]+/u).filter(w => w);
}

function lex(value) {
  const tokens = [];
  let i = 0;
  while (i < value.length) {
    const c = value[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === '(' || c === ')') {
      tokens.push({ t: c });
      i++;
    } else if (c === '"') {
      const close = value.indexOf('"', i + 1);
      if (close < 0) {
        throw badRequest('_text/_content: a quoted phrase is not closed');
      }
      tokens.push({ t: 'phrase', v: value.substring(i + 1, close) });
      i = close + 1;
    } else if (c === '-' && i + 1 < value.length && !/\s/.test(value[i + 1])) {
      tokens.push({ t: 'NOT' });
      i++;
    } else {
      let j = i;
      while (j < value.length && !/[\s()"]/.test(value[j])) {
        j++;
      }
      const w = value.substring(i, j);
      if (w === 'AND' || w === 'OR' || w === 'NOT') {
        tokens.push({ t: w });
      } else {
        tokens.push({ t: 'word', v: w });
      }
      i = j;
    }
  }
  return tokens;
}

/**
 * Parse a _text or _content value into a tree:
 *   { op: 'or', items } { op: 'and', items } { op: 'not', item } { op: 'term', words, prefix }
 * Terms next to each other are AND'd; OR binds more loosely than AND; NOT (or -) applies to the
 * term or bracket after it.
 * @param {string} value
 */
function parseQuery(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw badRequest('_text/_content needs some words to search for');
  }
  if (value.length > MAX_QUERY) {
    throw badRequest(`_text/_content is limited to ${MAX_QUERY} characters`);
  }
  const tokens = lex(value);
  let pos = 0;
  let terms = 0;
  const peek = () => tokens[pos];
  const orExpr = (depth) => {
    if (depth > 10) {
      throw badRequest('_text/_content: brackets nested too deeply');
    }
    const items = [andExpr(depth)];
    while (peek() && peek().t === 'OR') {
      pos++;
      items.push(andExpr(depth));
    }
    return items.length === 1 ? items[0] : { op: 'or', items };
  };
  const andExpr = (depth) => {
    const items = [unary(depth)];
    while (peek() && peek().t !== 'OR' && peek().t !== ')') {
      if (peek().t === 'AND') {
        pos++;
      }
      items.push(unary(depth));
    }
    return items.length === 1 ? items[0] : { op: 'and', items };
  };
  const unary = (depth) => {
    const tok = tokens[pos++];
    if (!tok) {
      throw badRequest('_text/_content: the expression is incomplete');
    }
    if (tok.t === 'NOT') {
      return { op: 'not', item: unary(depth) };
    }
    if (tok.t === '(') {
      const e = orExpr(depth + 1);
      if (!peek() || peek().t !== ')') {
        throw badRequest('_text/_content: a bracket is not closed');
      }
      pos++;
      return e;
    }
    if (tok.t === 'word' || tok.t === 'phrase') {
      const w = words(tok.v);
      if (!w.length) {
        throw badRequest(`_text/_content: '${tok.v}' has no letters or digits to search for`);
      }
      if (++terms > MAX_TERMS) {
        throw badRequest(`_text/_content is limited to ${MAX_TERMS} words and phrases`);
      }
      // one word is a prefix; a phrase, or a word the index splits (a@b.org), is matched as it is
      return { op: 'term', words: w, prefix: tok.t === 'word' && w.length === 1 };
    }
    throw badRequest(`_text/_content: unexpected '${tok.t}'`);
  };
  const tree = orExpr(0);
  if (pos < tokens.length) {
    throw badRequest(`_text/_content: unexpected '${tokens[pos].t === 'word' ? tokens[pos].v : tokens[pos].t}'`);
  }
  checkPositive(tree);
  return tree;
}

/** Every branch must find something: NOT on its own (or everything negated) can't be searched */
function checkPositive(node) {
  const positive = (n) => {
    switch (n.op) {
      case 'term': return true;
      case 'not': return false;
      case 'and': return n.items.some(positive);
      case 'or': return n.items.every(positive);
    }
    return false;
  };
  if (!positive(node)) {
    throw badRequest('_text/_content: each part of the search needs a word that isn\'t negated');
  }
}

// ---- each engine's syntax ----

/** FTS5: "w"* for a word, "w1 w2" for a phrase; AND, OR, NOT as binary operators */
function fts5(node) {
  switch (node.op) {
    case 'term':
      return node.prefix ? `"${node.words[0]}"*` : `"${node.words.join(' ')}"`;
    case 'or':
      return '(' + node.items.map(fts5).join(' OR ') + ')';
    case 'and': {
      const pos = node.items.filter(n => n.op !== 'not').map(fts5);
      const neg = node.items.filter(n => n.op === 'not').map(n => fts5(n.item));
      let s = '(' + pos.join(' AND ') + ')';
      if (neg.length) {
        s += ' NOT (' + neg.join(' OR ') + ')';
      }
      return '(' + s + ')';
    }
    case 'not':
      // only inside an and (checkPositive): a not on its own never reaches here
      throw badRequest('_text/_content: NOT needs something to be NOT of');
  }
  return '';
}

/**
 * MySQL boolean mode: +word* required, -word excluded, "phrase"; an OR is a bracket of
 * optional parts, of which one must match.
 */
function mysqlBoolean(node, required = true) {
  const sign = required ? '+' : '';
  switch (node.op) {
    case 'term':
      return sign + (node.prefix ? `${node.words[0]}*` : `"${node.words.join(' ')}"`);
    case 'or':
      return `${sign}(${node.items.map(n => mysqlBoolean(n, false)).join(' ')})`;
    case 'and': {
      const parts = node.items.map(n => n.op === 'not' ? '-' + mysqlBoolean(n.item, false).replace(/^\+/, '') : mysqlBoolean(n, true));
      return `${sign}(${parts.join(' ')})`;
    }
    case 'not':
      throw badRequest('_text/_content: NOT needs something to be NOT of');
  }
  return '';
}

/**
 * The SQL condition on a resource key for a full-text search.
 * @param {string} dialect - 'sqlite' or 'mysql'
 * @param {string} key - the resource key expression
 * @param {'Narrative'|'Content'} column
 * @param {Object} tree - from parseQuery
 */
function condition(dialect, key, column, tree) {
  if (column !== 'Narrative' && column !== 'Content') {
    throw new Error(`Unknown full-text column ${column}`);
  }
  if (dialect === 'sqlite') {
    return { sql: `${key} IN (SELECT rowid FROM TextIndex WHERE TextIndex MATCH ?)`, args: [`${column} : (${fts5(tree)})`] };
  }
  return { sql: `${key} IN (SELECT ResourceKey FROM TextIndex WHERE MATCH(${column}) AGAINST (? IN BOOLEAN MODE))`, args: [mysqlBoolean(tree, true)] };
}

// ---- storage ----

/** The statements that make the TextIndex table */
function ddl(dialect) {
  if (dialect === 'sqlite') {
    // the text is already folded: the tokenizer only splits it
    return ['CREATE VIRTUAL TABLE TextIndex USING fts5(Narrative, Content, tokenize = \'unicode61 remove_diacritics 0\')'];
  }
  return ['CREATE TABLE TextIndex (ResourceKey BIGINT NOT NULL PRIMARY KEY, Narrative MEDIUMTEXT, Content MEDIUMTEXT, ' +
    'FULLTEXT KEY FT_TextIndex_Narrative (Narrative), FULLTEXT KEY FT_TextIndex_Content (Content)) ' +
    'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin'];
}

/** Take a resource's text out of the index */
async function remove(q, resourceKey) {
  if (q.dialect.name === 'sqlite') {
    await q.run('DELETE FROM TextIndex WHERE rowid = ?', [resourceKey]);
  } else {
    await q.run('DELETE FROM TextIndex WHERE ResourceKey = ?', [resourceKey]);
  }
}

/** Index a resource's text (replacing what was there) */
async function write(q, resourceKey, resource) {
  await remove(q, resourceKey);
  const narrative = folded(narrativeText(resource && resource.text && resource.text.div));
  const content = folded(contentText(resource));
  if (!narrative && !content) {
    return;
  }
  if (q.dialect.name === 'sqlite') {
    await q.run('INSERT INTO TextIndex (rowid, Narrative, Content) VALUES (?, ?, ?)', [resourceKey, narrative, content]);
  } else {
    await q.run('INSERT INTO TextIndex (ResourceKey, Narrative, Content) VALUES (?, ?, ?)', [resourceKey, narrative, content]);
  }
}

module.exports = { narrativeText, contentText, words, parseQuery, fts5, mysqlBoolean, condition, ddl, write, remove, MAX_TERMS, MAX_QUERY };
