/**
 * Renders the syndication store as an Atom feed for one tx endpoint, following the
 * Terminology Syndication Feed IG (NCTS ASF profile), with RFC 5005 archived feeds for
 * paging:
 *
 *   {endpoint}/syndication            the current document - the newest entries, fewer
 *                                     than a page of them - linked to the newest archive
 *   {endpoint}/syndication/archive/n  archive n (1 = oldest), exactly PAGE_SIZE entries,
 *                                     linked to archive n-1. Entries are never changed or
 *                                     removed, so an archive never changes once it exists
 *   {endpoint}/syndication/files/x    a resource file copied into the store
 *
 * The IG's query-string filters are not supported.
 */

const crypto = require('crypto');
const { VersionUtilities } = require('../../library/version-utilities');

const PAGE_SIZE = 30;
const ATOM_NS = 'http://www.w3.org/2005/Atom';
const NCTS_NS = 'http://ns.electronichealth.net.au/ncts/syndication/asf/extensions/1.0.0';
const FH_NS = 'http://purl.org/syndication/history/1.0';
const ASF_PROFILE = 'http://ns.electronichealth.net.au/ncts/syndication/asf/profile/1.0.0';

/**
 * Escape for XML and HTML. Characters XML 1.0 does not allow at all (C0 controls other than
 * tab/newline/return, unpaired surrogates, U+FFFE/U+FFFF) are dropped: they come from package
 * and resource metadata, and one of them would make the document unparseable - for good, in
 * the case of an archive, which never changes.
 */
function esc(s) {
  return String(s ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** major.minor for an endpoint's FHIR version */
function feedFhirVersion(fhirVersion) {
  return VersionUtilities.getMajMin(String(fhirVersion));
}

/**
 * The feed id for an endpoint: stable for as long as the store exists, whatever host name
 * the feed is read through (RFC 4287 4.2.6). The archive documents share it (RFC 5005).
 */
function feedId(storeId, endpointPath) {
  const h = crypto.createHash('sha1').update(storeId + '|' + endpointPath).digest('hex');
  return `urn:uuid:${h.substring(0, 8)}-${h.substring(8, 12)}-5${h.substring(13, 16)}-` +
    `${((parseInt(h.substring(16, 18), 16) & 0x3f) | 0x80).toString(16)}${h.substring(18, 20)}-${h.substring(20, 32)}`;
}

/**
 * Which entries go in which document.
 * @param {Object[]} entries - the endpoint's entries, oldest first
 * @param {number|null} page - archive number, or null for the current document
 * @returns {{archives: number, entries: Object[]}|null} null if there is no such archive
 */
function selectPage(entries, page) {
  const archives = Math.floor(entries.length / PAGE_SIZE);
  if (page == null) {
    return { archives, entries: entries.slice(archives * PAGE_SIZE) };
  }
  if (!Number.isInteger(page) || page < 1 || page > archives) {
    return null;
  }
  return { archives, entries: entries.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) };
}

function linkHref(entry, base) {
  return entry.link.href || `${base}/syndication/files/${entry.link.file}`;
}

function isFhirCategory(entry) {
  return entry.category.term.startsWith('FHIR_');
}

function renderEntry(entry, base, fhirVersion) {
  const lines = [];
  lines.push('  <entry>');
  lines.push(`    <id>${esc(entry.id)}</id>`);
  lines.push(`    <title>${esc(entry.title)}</title>`);
  lines.push(`    <updated>${esc(entry.inducted)}</updated>`);
  lines.push(`    <published>${esc(entry.inducted)}</published>`);
  if (entry.summary) {
    lines.push(`    <summary>${esc(entry.summary)}</summary>`);
  }
  if (entry.rights) {
    lines.push(`    <rights>${esc(entry.rights)}</rights>`);
  }
  const c = entry.category;
  lines.push(`    <category scheme="${esc(c.scheme)}" term="${esc(c.term)}"${c.label ? ` label="${esc(c.label)}"` : ''}/>`);
  const l = entry.link;
  lines.push(`    <link rel="alternate" href="${esc(linkHref(entry, base))}" type="${esc(l.type)}" length="${l.length}" ncts:sha256Hash="${esc(l.sha256)}"/>`);
  lines.push(`    <ncts:contentItemIdentifier>${esc(entry.identifier)}</ncts:contentItemIdentifier>`);
  lines.push(`    <ncts:contentItemVersion>${esc(entry.version)}</ncts:contentItemVersion>`);
  if (isFhirCategory(entry)) {
    lines.push(`    <ncts:fhirVersion>${esc(entry.fhirVersion || fhirVersion)}</ncts:fhirVersion>`);
  }
  lines.push('  </entry>');
  return lines.join('\n');
}

/**
 * @param {Object} params
 * @param {SyndicationStore} params.store
 * @param {string} params.endpointPath - e.g. /tx/r4
 * @param {string} params.fhirVersion - the endpoint's FHIR version
 * @param {string} params.base - absolute url of the endpoint, e.g. https://tx.fhir.org/tx/r4
 * @param {number|null} params.page - archive number, or null for the current document
 * @param {string} [params.title] - server title
 * @param {string} [params.serverVersion]
 * @returns {string|null} the Atom document, or null if there is no such archive
 */
function renderAtom(params) {
  const fhirVersion = feedFhirVersion(params.fhirVersion);
  const all = params.store.entriesFor(fhirVersion);
  const sel = selectPage(all, params.page);
  if (!sel) {
    return null;
  }
  const feedUrl = `${params.base}/syndication`;
  const archiveUrl = (n) => `${feedUrl}/archive/${n}`;
  const self = params.page == null ? feedUrl : archiveUrl(params.page);
  // the newest entry in this document; an empty one dates from when the store was started
  const updated = sel.entries.length > 0 ? sel.entries[sel.entries.length - 1].inducted : params.store.created;

  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push(`<feed xmlns="${ATOM_NS}" xmlns:ncts="${NCTS_NS}" xmlns:fh="${FH_NS}">`);
  out.push(`  <id>${esc(feedId(params.store.id, params.endpointPath))}</id>`);
  out.push(`  <title>${esc((params.title || 'FHIRsmith') + ' Syndication Feed (FHIR ' + fhirVersion + ')')}</title>`);
  out.push(`  <subtitle>Content loaded by the terminology server at ${esc(params.base)}</subtitle>`);
  out.push(`  <updated>${esc(updated)}</updated>`);
  out.push(`  <generator uri="https://github.com/HealthIntersections/FHIRsmith"${params.serverVersion ? ` version="${esc(params.serverVersion)}"` : ''}>FHIRsmith</generator>`);
  out.push(`  <link rel="self" type="application/atom+xml" href="${esc(self)}"/>`);
  out.push(`  <link rel="current" type="application/atom+xml" href="${esc(feedUrl)}"/>`);
  if (params.page == null) {
    if (sel.archives > 0) {
      out.push(`  <link rel="prev-archive" type="application/atom+xml" href="${esc(archiveUrl(sel.archives))}"/>`);
    }
  } else {
    out.push('  <fh:archive/>');
    if (params.page > 1) {
      out.push(`  <link rel="prev-archive" type="application/atom+xml" href="${esc(archiveUrl(params.page - 1))}"/>`);
    }
    // no next-archive: it would change the newest archive when the next one is made, and an
    // archive never changes (RFC 5005 makes it optional; consumers walk back from current)
  }
  out.push(`  <ncts:atomSyndicationFormatProfile>${ASF_PROFILE}</ncts:atomSyndicationFormatProfile>`);
  // newest first; consumers go by <updated>, not order
  for (const entry of [...sel.entries].reverse()) {
    out.push(renderEntry(entry, params.base, fhirVersion));
  }
  out.push('</feed>');
  return out.join('\n') + '\n';
}

/**
 * The same document, for people: a table of entries with links to the other documents.
 * Takes the same parameters as renderAtom; returns HTML content (no page), or null.
 */
function renderHtml(params) {
  const fhirVersion = feedFhirVersion(params.fhirVersion);
  const all = params.store.entriesFor(fhirVersion);
  const sel = selectPage(all, params.page);
  if (!sel) {
    return null;
  }
  const feedUrl = `${params.base}/syndication`;
  const atomUrl = params.page == null ? feedUrl : `${feedUrl}/archive/${params.page}`;
  const h = [];
  h.push('<p>The content this server has loaded, as a <a href="https://build.fhir.org/ig/FHIR/fhir-syndication-ig/en/">Terminology Syndication Feed</a>. ');
  h.push(`Subscribe to <a href="${esc(atomUrl)}?_format=atom">${esc(feedUrl)}</a> in a feed reader or syndication client. `);
  h.push(`${all.length} ${all.length === 1 ? 'entry' : 'entries'} in all.</p>`);

  const nav = [];
  if (params.page == null) {
    if (sel.archives > 0) {
      nav.push(`<a href="${esc(feedUrl)}/archive/${sel.archives}">Older</a>`);
    }
  } else {
    if (params.page > 1) {
      nav.push(`<a href="${esc(feedUrl)}/archive/${params.page - 1}">Older</a>`);
    }
    nav.push(params.page < sel.archives
      ? `<a href="${esc(feedUrl)}/archive/${params.page + 1}">Newer</a>`
      : `<a href="${esc(feedUrl)}">Newer</a>`);
    nav.push(`<a href="${esc(feedUrl)}">Newest</a>`);
  }
  const navHtml = nav.length > 0 ? `<p>${nav.join(' | ')}</p>` : '';
  h.push(navHtml);

  if (sel.entries.length === 0) {
    h.push('<p><i>No entries</i></p>');
  } else {
    h.push('<table class="grid">');
    h.push('<tr><th>Title</th><th>Type</th><th>Version</th><th>Added</th><th>Download</th></tr>');
    for (const e of [...sel.entries].reverse()) {
      h.push('<tr>');
      h.push(`<td>${esc(e.title)}${e.summary ? `<br/><span style="color: grey">${esc(e.summary)}</span>` : ''}${e.rights ? `<br/><i>${esc(e.rights)}</i>` : ''}</td>`);
      h.push(`<td>${esc(e.category.term)}${isFhirCategory(e) ? ` (R${esc((e.fhirVersion || fhirVersion).split('.')[0])})` : ''}</td>`);
      h.push(`<td><code>${esc(e.version)}</code></td>`);
      h.push(`<td>${esc(e.inducted.substring(0, 10))}</td>`);
      h.push(`<td><a href="${esc(linkHref(e, params.base))}">${esc(e.link.length.toLocaleString())} bytes</a><br/><span style="font-size: 0.8em; color: grey">sha256: ${esc(e.link.sha256)}</span></td>`);
      h.push('</tr>');
    }
    h.push('</table>');
  }
  h.push(navHtml);
  return h.join('\n');
}

module.exports = { renderAtom, renderHtml, selectPage, feedId, feedFhirVersion, esc, PAGE_SIZE };
