//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * The patient's comments on a document (the Patient Comments tab): pure markdown, and the
 * patient notes section (LOINC 51855-5) they go into when a copy of the document is downloaded
 * or shared with "Include Patient Comments".
 *
 * The order matters (ips.js preparedCopy): any patient notes section already in the document is
 * removed before signing; the comments' section is added after signing, so it is not signed.
 */

const commonmark = require('commonmark');

const LOINC = 'http://loinc.org';
const PATIENT_NOTES = '51855-5';
const PATIENT_NOTES_TITLE = 'Patient\'s Comments';
// the most a patient comment can hold (characters)
const PATIENT_COMMENT_MAX = 30000;

/** CommonMark as HTML, with raw HTML left out and unsafe links dropped. */
function markdownHtml(md) {
  return new commonmark.HtmlRenderer({ safe: true }).render(new commonmark.Parser().parse(md || ''));
}

/**
 * The HTML in some markdown: pure markdown only, no HTML at all (autolinks like <https://...> are markdown).
 * @returns {string[]} each piece of HTML found (empty: none)
 */
function markdownHtmlParts(md) {
  const walker = new commonmark.Parser().parse(md || '').walker();
  const found = [];
  let e;
  while ((e = walker.next())) {
    if (e.entering && (e.node.type === 'html_block' || e.node.type === 'html_inline')) {
      found.push(e.node.literal.trim());
    }
  }
  return found;
}

const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/** The document's Composition (its first entry), or null. */
function compositionOf(bundle) {
  const r = Array.isArray(bundle?.entry) ? bundle.entry[0]?.resource : null;
  return isObject(r) && r.resourceType === 'Composition' ? r : null;
}

function isPatientNotes(section) {
  return isObject(section) && Array.isArray(section.code?.coding) &&
    section.code.coding.some(c => isObject(c) && c.system === LOINC && c.code === PATIENT_NOTES);
}

/** Drop patient notes sections (at any depth) from a list of sections. @returns {Array} */
function withoutNotes(sections) {
  return sections.filter(s => !isPatientNotes(s)).map(s => (isObject(s) && Array.isArray(s.section) ? { ...s, section: withoutNotes(s.section) } : s));
}

/**
 * The document without any patient notes section (LOINC 51855-5) in its Composition.
 * @param {Object} bundle - not changed
 * @returns {Object} a copy
 */
function removePatientNotes(bundle) {
  const doc = structuredClone(bundle);
  const comp = compositionOf(doc);
  if (comp && Array.isArray(comp.section)) {
    comp.section = withoutNotes(comp.section);
    if (comp.section.length === 0) {
      delete comp.section;
    }
  }
  return doc;
}

/** The reference to the document's patient: the Composition's subject, else the Patient entry's fullUrl. */
function patientReference(bundle, comp) {
  if (typeof comp.subject?.reference === 'string') {
    return comp.subject.reference;
  }
  const e = bundle.entry.find(x => x?.resource?.resourceType === 'Patient' && typeof x.fullUrl === 'string');
  return e ? e.fullUrl : null;
}

/**
 * The document with the patient's comments as its first section: the patient notes code, the
 * title, the patient as author, and the comments as narrative (status additional) - nothing else.
 * @param {Object} bundle - not changed
 * @param {string} markdown - the comment (pure markdown)
 * @returns {Object} a copy
 */
function addPatientComments(bundle, markdown) {
  const doc = structuredClone(bundle);
  const comp = compositionOf(doc);
  if (!comp) {
    throw new Error('The document has no Composition to add the patient\'s comments to');
  }
  const section = {
    title: PATIENT_NOTES_TITLE,
    code: { coding: [{ system: LOINC, code: PATIENT_NOTES }] }
  };
  const patient = patientReference(doc, comp);
  if (patient) {
    section.author = [{ reference: patient }];
  }
  section.text = { status: 'additional', div: `<div xmlns="http://www.w3.org/1999/xhtml">${markdownHtml(markdown).trim()}</div>` };
  comp.section = [section, ...(Array.isArray(comp.section) ? comp.section : [])];
  return doc;
}

// ---- reading them back from a document --------------------------------------------------------

let turndown = null;

/** The HTML to markdown converter (turndown), set up for pure markdown: made when first needed */
function converter() {
  if (!turndown) {
    const TurndownService = require('turndown');
    const t = new TurndownService({ headingStyle: 'atx', bulletListMarker: '-', codeBlockStyle: 'fenced', emDelimiter: '*' });
    // text that looks like HTML is text: '<' is escaped, so the markdown has no HTML in it
    t.escape = (text) => TurndownService.prototype.escape.call(t, text).replace(/</g, '\\<');
    // no images (a narrative's are usually data: URIs); a table row is its cells, ' | ' between
    t.remove(['script', 'style']);
    t.addRule('image', { filter: 'img', replacement: () => '' });
    t.addRule('cell', { filter: ['td', 'th'], replacement: (content, node) => (node.previousElementSibling ? ' | ' : '') + content.replace(/\s+/g, ' ').trim() });
    t.addRule('row', { filter: 'tr', replacement: (content) => `\n\n${content}\n\n` });
    turndown = t;
  }
  return turndown;
}

/** A narrative (XHTML) as pure markdown: the best turndown can do, with anything HTML left escaped. */
function htmlToMarkdown(div) {
  let md = converter().turndown(typeof div === 'string' ? div : '').replace(/\n{3,}/g, '\n\n').trim();
  // belt and braces: whatever still reads as HTML is escaped
  if (markdownHtmlParts(md).length > 0) {
    md = md.replace(/</g, '\\<');
  }
  return md;
}

/** The patient notes sections (LOINC 51855-5) in a document's Composition, at any depth, in order. */
function patientNotesSections(bundle) {
  const out = [];
  const walk = (sections) => {
    for (const s of Array.isArray(sections) ? sections : []) {
      if (isPatientNotes(s)) {
        out.push(s);
      } else if (isObject(s)) {
        walk(s.section);
      }
    }
  };
  walk(compositionOf(bundle)?.section);
  return out;
}

/**
 * What a document's patient notes sections say, as markdown (their narratives, one after the
 * other), or null when it has none or they say nothing.
 */
function patientNotesMarkdown(bundle) {
  const parts = patientNotesSections(bundle).map(s => htmlToMarkdown(s.text?.div)).filter(Boolean);
  return parts.length > 0 ? parts.join('\n\n') : null;
}

module.exports = { PATIENT_NOTES, PATIENT_NOTES_TITLE, PATIENT_COMMENT_MAX, markdownHtml, markdownHtmlParts, removePatientNotes, addPatientComments, htmlToMarkdown, patientNotesMarkdown };
