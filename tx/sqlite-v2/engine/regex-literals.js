'use strict';

// Literal substrings that every match of an RE2 pattern must contain (codesearch-style, kept
// deliberately simple and conservative). A substring of 3 or more characters can narrow the
// candidates through the FTS5 trigram index on displays (search_display) before RE2 runs on them.
//
// The extractor is sound when it returns literals: any string the pattern matches contains each of
// them. When it is unsure (alternation at the top level, unusual syntax) it returns []. Case: the
// trigram index is case-insensitive, so the candidate set is a superset either way.

const BREAK_ESCAPES = new Set('dDwWsSbBpPQEAzZ'.split(''));

/** @returns {string[]} required literals of at least `min` characters (possibly none) */
function requiredLiterals(pattern, min = 3) {
  const s = String(pattern);
  const runs = [];
  let cur = '';
  const brk = () => { if (cur.length) runs.push(cur); cur = ''; };
  let i = 0;
  let depth = 0;
  // a top-level alternation: no literal is required by every branch (as far as we know)
  for (let k = 0, d = 0, inClass = false; k < s.length; k++) {
    const c = s[k];
    if (c === '\\') { k++; continue; }
    if (inClass) { if (c === ']') inClass = false; continue; }
    if (c === '[') { inClass = true; if (s[k + 1] === '^') k++; if (s[k + 1] === ']') k++; continue; }
    if (c === '(') d++;
    else if (c === ')') d--;
    else if (c === '|' && d === 0) return [];
  }
  const quant = (k) => {
    // a quantifier at k: returns { optional, end } or null
    const c = s[k];
    if (c === '?' || c === '*') return { optional: true, end: k + 1 + (s[k + 1] === '?' ? 1 : 0) };
    if (c === '+') return { optional: false, end: k + 1 + (s[k + 1] === '?' ? 1 : 0) };
    if (c === '{') {
      const m = /^\{(\d*)(,\d*)?\}\??/.exec(s.slice(k));
      if (m) return { optional: !m[1] || Number(m[1]) === 0, end: k + m[0].length };
    }
    return null;
  };
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      const n = s[i + 1];
      if (n == null || BREAK_ESCAPES.has(n) || /[0-9xu]/.test(n)) {
        // a class escape (\d, \w, \p{…}, …): not a literal, nor is its quantifier
        brk();
        i += 2;
        if ((n === 'p' || n === 'P' || n === 'x') && s[i] === '{') { const e = s.indexOf('}', i); i = e < 0 ? s.length : e + 1; }
        const q = quant(i);
        if (q) i = q.end;
        continue;
      }
      // an escaped literal (\. \( \\ ...)
      const q = quant(i + 2);
      if (q) { if (!q.optional) cur += n; brk(); i = q.end; continue; }
      cur += n;
      i += 2;
      continue;
    }
    if (c === '[') {
      // a character class: not a literal
      brk();
      let k = i + 1;
      if (s[k] === '^') k++;
      if (s[k] === ']') k++;
      while (k < s.length && s[k] !== ']') { if (s[k] === '\\') k++; k++; }
      i = k + 1;
      const q = quant(i);
      if (q) i = q.end;
      continue;
    }
    if (c === '(') {
      // a group (or flags): skip it whole
      brk();
      depth = 0;
      let k = i;
      for (; k < s.length; k++) {
        if (s[k] === '\\') { k++; continue; }
        if (s[k] === '[') { k++; if (s[k] === '^') k++; if (s[k] === ']') k++; while (k < s.length && s[k] !== ']') { if (s[k] === '\\') k++; k++; } continue; }
        if (s[k] === '(') depth++;
        else if (s[k] === ')') { depth--; if (depth === 0) break; }
      }
      i = k + 1;
      const q = quant(i);
      if (q) i = q.end;
      continue;
    }
    if (c === '.' || c === '^' || c === '$') {
      brk();
      i++;
      const q = quant(i);
      if (q) i = q.end;
      continue;
    }
    if (c === '|' || c === ')') return []; // not expected at the top level (checked above)
    const q = quant(i + 1);
    if (q) {
      if (!q.optional) cur += c;
      brk();
      i = q.end;
      continue;
    }
    cur += c;
    i++;
  }
  brk();
  return [...new Set(runs.filter((r) => [...r].length >= min))];
}

/**
 * The same test with a leading and trailing unanchored ".*" removed. Matching is "find anywhere"
 * and ".*" can match the empty string, so find(".*X.*") = find("X"); RE2JS then skips scanning
 * every prefix. Kept unchanged when there is a top-level alternation or the affix is escaped or
 * quantified.
 */
function stripAnyAffixes(pattern) {
  let s = String(pattern);
  if (hasTopLevelAlternation(s)) return s;
  while (s.startsWith('.*') && !/^\.\*[?*+{]/.test(s)) s = s.slice(2);
  while (s.endsWith('.*') && !s.endsWith('\\.*') && !endsEscaped(s, s.length - 2) && s.length > 2) s = s.slice(0, -2);
  return s.length ? s : String(pattern);
}

function endsEscaped(s, pos) {
  let n = 0;
  for (let k = pos - 1; k >= 0 && s[k] === '\\'; k--) n++;
  return n % 2 === 1;
}

function hasTopLevelAlternation(s) {
  for (let k = 0, d = 0, inClass = false; k < s.length; k++) {
    const c = s[k];
    if (c === '\\') { k++; continue; }
    if (inClass) { if (c === ']') inClass = false; continue; }
    if (c === '[') { inClass = true; if (s[k + 1] === '^') k++; if (s[k + 1] === ']') k++; continue; }
    if (c === '(') d++;
    else if (c === ')') d--;
    else if (c === '|' && d === 0) return true;
  }
  return false;
}

/** an FTS5 query requiring every literal (each a quoted phrase), or null */
function ftsQuery(literals) {
  if (!literals || !literals.length) return null;
  return literals.map((l) => '"' + l.replace(/"/g, '""') + '"').join(' AND ');
}

module.exports = { requiredLiterals, ftsQuery, stripAnyAffixes };
