//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * Checks FHIR narrative (and any other XHTML that will be shown in a page) for active
 * content: anything that can run script, submit or navigate on its own, load another
 * document, or restyle the page around it.
 *
 * FHIR's rule is that narrative "SHALL contain only the basic HTML formatting elements ...,
 * <a> elements (either name or href), images and internally contained style attributes",
 * and "SHALL NOT contain a head, a body element, external stylesheet references, deprecated
 * elements, scripts, forms, base/link/xlink, frames, iframes, objects or event related
 * attributes". This checks the active-content part of that, not the whole rule.
 *
 * The XHTML is parsed the way a browser parses it when it is inserted into a page (parse5
 * implements the HTML parsing algorithm), so entity-encoded, mixed-case or malformed markup
 * is checked as the browser would see it, not as it is written.
 */

const parse5 = require('parse5');

// Elements that run script, load or embed another document, submit data, or change how
// the page around them is read. svg and math are here because FHIR narrative has no
// inline graphics (images are <img>), and both can carry script.
const ACTIVE_ELEMENTS = new Set([
  'script', 'style', 'link', 'meta', 'base',
  'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'portal', 'template',
  'form', 'input', 'button', 'select', 'textarea', 'isindex', 'keygen',
  'svg', 'math', 'head', 'body', 'html'
]);

// Attributes that hold a URL
const URL_ATTRIBUTES = new Set([
  'href', 'src', 'action', 'formaction', 'xlink:href', 'background', 'poster', 'srcset',
  'data', 'codebase', 'cite', 'longdesc', 'usemap', 'dynsrc', 'lowsrc', 'ping', 'manifest'
]);

// Attributes that are active whatever their value
const ACTIVE_ATTRIBUTES = new Set(['srcdoc', 'http-equiv', 'formaction']);

// CSS in a style attribute that runs script or binds behaviour (old IE and Gecko)
const ACTIVE_CSS = /expression\(|javascript:|vbscript:|-moz-binding|behavior:|@import/;

// The scheme of a URL, as a browser reads it: leading spaces and control characters
// are ignored, and so are tabs and newlines anywhere
function urlScheme(url) {
  // eslint-disable-next-line no-control-regex -- control characters are what browsers strip
  const cleaned = String(url).replace(/^[\x00-\x20]+/, '').replace(/[\t\n\r]/g, '');
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(cleaned);
  return m ? { scheme: m[1].toLowerCase(), rest: cleaned.substring(m[0].length) } : null;
}

// Every URL in an attribute value (srcset has several)
function urlsIn(name, value) {
  if (name === 'srcset') {
    return String(value).split(',').map(s => s.trim().split(/\s+/)[0]).filter(Boolean);
  }
  return [value];
}

// CSS with comments removed and escapes decoded, so \65 xpression( is seen as expression(
function normaliseCss(css) {
  return String(css)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_, hex) => {
      const cp = parseInt(hex, 16);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    })
    .replace(/\\(.)/g, '$1')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function describe(node) {
  return `<${node.tagName}>`;
}

function checkAttribute(node, attr, problems) {
  const name = (attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name).toLowerCase();
  const value = attr.value || '';
  if (name.startsWith('on')) {
    problems.push(`an event handler attribute (${name}) on ${describe(node)}`);
    return;
  }
  if (ACTIVE_ATTRIBUTES.has(name)) {
    problems.push(`a ${name} attribute on ${describe(node)}`);
    return;
  }
  if (name === 'style') {
    if (ACTIVE_CSS.test(normaliseCss(value))) {
      problems.push(`script or behaviour in the style attribute of ${describe(node)}`);
    }
    return;
  }
  if (URL_ATTRIBUTES.has(name)) {
    for (const url of urlsIn(name, value)) {
      const s = urlScheme(url);
      if (!s) {
        continue;
      }
      if (s.scheme === 'javascript' || s.scheme === 'vbscript' || s.scheme === 'livescript') {
        problems.push(`a ${s.scheme}: URL in the ${name} of ${describe(node)}`);
      } else if (s.scheme === 'data') {
        // an inline image is fine: an image can't run script
        const isImage = node.tagName === 'img' && (name === 'src' || name === 'srcset')
          && /^image\//i.test(s.rest.trim());
        if (!isImage) {
          problems.push(`a data: URL in the ${name} of ${describe(node)}`);
        }
      }
    }
  }
}

function walk(node, problems) {
  if (node.tagName) {
    if (ACTIVE_ELEMENTS.has(node.tagName.toLowerCase())) {
      problems.push(`a ${describe(node)} element`);
    }
    for (const attr of node.attrs || []) {
      checkAttribute(node, attr, problems);
    }
  }
  // a <template>'s content is a separate fragment
  for (const child of [...(node.childNodes || []), ...(node.content ? [node.content] : [])]) {
    walk(child, problems);
  }
}

/**
 * Checks XHTML for active content.
 *
 * @param {string} xhtml - e.g. a narrative's text.div
 * @returns {string|null} what was found (the first few things, if several), or null if
 *   there is no active content
 */
function checkNarrative(xhtml) {
  if (xhtml == null || xhtml === '') {
    return null;
  }
  if (typeof xhtml !== 'string') {
    return 'the narrative is not a string';
  }
  const problems = [];
  walk(parse5.parseFragment(xhtml), problems);
  if (problems.length === 0) {
    return null;
  }
  const shown = [...new Set(problems)];
  const more = shown.length > 3 ? ` (and ${shown.length - 3} more)` : '';
  return `active content in the narrative: ${shown.slice(0, 3).join('; ')}${more}`;
}

/**
 * Checks every narrative in a resource: its own, its contained resources', and those of
 * the resources in a Bundle's entries.
 *
 * @param {object} resource - the resource as JSON
 * @returns {string|null} what was found, with where, or null
 */
function checkResourceNarratives(resource) {
  const check = (res, where) => {
    if (!res || typeof res !== 'object') {
      return null;
    }
    const found = checkNarrative(res.text?.div);
    if (found) {
      return `${where}: ${found}`;
    }
    for (const [i, c] of (Array.isArray(res.contained) ? res.contained : []).entries()) {
      const r = check(c, `${where}.contained[${i}]${c?.id ? ` (#${c.id})` : ''}`);
      if (r) {
        return r;
      }
    }
    for (const [i, e] of (Array.isArray(res.entry) ? res.entry : []).entries()) {
      const r = check(e?.resource, `${where}.entry[${i}]`);
      if (r) {
        return r;
      }
    }
    return null;
  };
  return check(resource, resource?.resourceType ? `${resource.resourceType}${resource.id ? '/' + resource.id : ''}` : 'resource');
}

/**
 * As checkResourceNarratives, but throws.
 *
 * @param {object} resource
 * @param {string} [context] - for the message, e.g. the package it came from
 */
function assertNoActiveContent(resource, context) {
  const found = checkResourceNarratives(resource);
  if (found) {
    throw new Error(context ? `${context}: ${found}` : found);
  }
}

module.exports = { checkNarrative, checkResourceNarratives, assertNoActiveContent };
