#!/usr/bin/env node
//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// The published FHIR specification has a page per resource for its JSON schema
// (e.g. testreport.schema.json.html), but not the schema itself as a file, so links to
// testreport.schema.json fail. This walks a tree of published specifications and, for each
// X.schema.json.html, takes the content of its <pre> element and writes it as X.schema.json
// beside it.
//
//   node utilities/extract-schema-json.js <dir> [<dir> ...] [--dry-run] [--force] [--verbose]
//
//   --dry-run  report what would be written, but write nothing
//   --force    overwrite an existing X.schema.json whose content differs (by default it's
//              left alone and reported)
//   --verbose  list every file written or skipped
//   --no-recurse  only look in the named directories themselves, not below them
//
// It can be stopped and run again: files already written are reported as up to date.
//
// A page is skipped (and reported) if it doesn't have exactly one <pre>, or if the content
// isn't valid JSON. Symbolic links are not followed. Exit status is 1 if anything was
// skipped for a problem, so it can be run in a script.

const fs = require('fs');
const path = require('path');

const SUFFIX = '.schema.json.html';

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ' };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.substring(2), 16) : parseInt(e.substring(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    const v = NAMED_ENTITIES[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

/**
 * The text with the markup removed. Repeated until nothing changes, so that removing one tag
 * can't leave another behind (<a<b>>).
 */
function stripTags(html) {
  let text = html;
  let previous;
  do {
    previous = text;
    text = text.replace(/<[^<>]*>/g, '');
  } while (text !== previous);
  return text;
}

/**
 * The schema in a page: the text of its one <pre> element, with any markup removed and
 * entities decoded.
 *
 * @param {string} html
 * @returns {{json?: string, problem?: string}}
 */
function extractSchema(html) {
  const pres = [...html.matchAll(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi)];
  if (pres.length !== 1) {
    return { problem: pres.length === 0 ? 'no <pre> element' : `${pres.length} <pre> elements` };
  }
  // entities are decoded after the markup is gone: a decoded < is the schema's own text
  const text = decodeEntities(stripTags(pres[0][1])).trim() + '\n';
  try {
    JSON.parse(text);
  } catch (e) {
    return { problem: 'the <pre> content is not valid JSON: ' + e.message };
  }
  return { json: text };
}

async function* walk(dir, recurse = true) {
  let handle;
  try {
    handle = await fs.promises.opendir(dir);
  } catch (e) {
    console.error(`Cannot read ${dir}: ${e.message}`);
    return;
  }
  for await (const entry of handle) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recurse) {
        yield* walk(p);
      }
    } else if (entry.isFile() && entry.name.endsWith(SUFFIX)) {
      yield p;
    }
  }
}

async function run(roots, options = {}) {
  const counts = { pages: 0, written: 0, unchanged: 0, different: 0, problems: 0 };
  const log = (msg) => options.verbose && console.log(msg);
  for (const root of roots) {
    for await (const page of walk(root, !options.noRecurse)) {
      counts.pages++;
      const target = page.slice(0, -'.html'.length);
      const { json, problem } = extractSchema(await fs.promises.readFile(page, 'utf8'));
      if (problem) {
        counts.problems++;
        console.warn(`${page}: ${problem}`);
        continue;
      }
      let existing = null;
      try {
        existing = await fs.promises.readFile(target, 'utf8');
      } catch (e) {
        // not there yet
      }
      if (existing === json) {
        counts.unchanged++;
        continue;
      }
      if (existing !== null && !options.force) {
        counts.different++;
        console.warn(`${target}: exists with different content - left alone (--force to overwrite)`);
        continue;
      }
      if (!options.dryRun) {
        await fs.promises.writeFile(target, json);
      }
      counts.written++;
      log(`${options.dryRun ? 'would write' : 'wrote'} ${target}`);
    }
  }
  return counts;
}

async function main(args) {
  const options = {
    dryRun: args.includes('--dry-run'),
    force: args.includes('--force'),
    verbose: args.includes('--verbose'),
    noRecurse: args.includes('--no-recurse')
  };
  const roots = args.filter(a => !a.startsWith('--'));
  if (roots.length === 0) {
    console.error('usage: extract-schema-json.js <dir> [<dir> ...] [--dry-run] [--force] [--verbose] [--no-recurse]');
    process.exit(2);
  }
  const start = Date.now();
  const c = await run(roots, options);
  console.log(`${c.pages} schema pages: ${c.written} ${options.dryRun ? 'to write' : 'written'}, ` +
    `${c.unchanged} already up to date, ${c.different} existing and different (left alone), ` +
    `${c.problems} with problems (${((Date.now() - start) / 1000).toFixed(1)}s)`);
  process.exit(c.problems > 0 ? 1 : 0);
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { extractSchema, decodeEntities, run };
