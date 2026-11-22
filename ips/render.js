//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * HTML for the /ips module: the list of projects, a project's filterable list of
 * documents, the submission form, the views of a document, and the administration
 * pages (login, projects, users, a project's settings).
 *
 * Everything in a document came from a stranger, so every value goes through escape().
 * The one exception is the narrative view, which shows the document's own XHTML
 * (Composition.text.div and the sections' text.div): that is the point of the view, and
 * it is safe to show because every narrative in a document is checked for active content
 * (library/narrative-check) before the document is accepted.
 *
 * @module ips/render
 */

const escape = require('escape-html');
const parse5 = require('parse5');
const { checkNarrative } = require('../library/narrative-check');
const { tokenConfigured } = require('../library/request-token');
const { STATUSES } = require('./search');
const profiles = require('./profiles');
const { terminologyOf, systemName, describeVersion, linkForSystem, linkForCode, isExternalSystem } = require('./terminology');
const { issueSummary, checkOf, translationOf } = require('./pipeline');
const { jurisdiction } = require('./jurisdictions');
const { summaryOf, STEP_TIMINGS_SAMPLE } = require('./store');
const { SNOMED_LINKABLE_EDITIONS, editionName } = require('../tx/sct/editions');
const { nationalityText } = require('./nationality');
const { markdownHtml, PATIENT_COMMENT_MAX } = require('./patient-comments');

// the nations there is a flag for (static/assets/images/flags/{code}.svg); any other is the globe
const FLAGS = new Set(['US', 'AU']);

/** The nation a document is from, as a flag (a black and white globe when it isn't known, or has no flag). */
function nationalityFlag(result) {
  const code = result?.jurisdiction || null;
  const title = result ? nationalityText(result) : 'The jurisdiction has not been determined yet';
  const src = code && FLAGS.has(code) ? `/assets/images/flags/${code.toLowerCase()}.svg` : '/assets/images/flags/unknown.svg';
  const alt = code ? (jurisdiction(code)?.display || code) : 'Jurisdiction unknown';
  return `<img class="ips-flag" src="${src}" alt="${escape(alt)}" title="${escape(title)}"/>`;
}
const { dateText } = require('./presenter');
const { structureTree, flatten } = require('./structure');
const scripts = require('./scripts');
const assets = require('./assets');
const { LOINC } = require('./editor-schema');

const STATUS_COLOURS = {
  submitted: '#6c757d',
  processing: '#0d6efd',
  processed: '#1e7e34',
  error: '#c82333'
};

const STYLE = `
<style>
  .ips-badge { display: inline-block; padding: 1px 6px; border-radius: 3px; color: white; font-size: 85%; white-space: nowrap; }
  .ips-table { font-size: 90%; }
  .ips-table td, .ips-table th { vertical-align: top; }
  .ips-entry:target { background: #fff3cd; outline: 2px solid #ffc107; }
  details.ips-sql { display: inline-block; margin-left: 8px; font-size: 80%; font-weight: normal; }
  details.ips-sql summary { cursor: pointer; color: #0056b3; }
  .ips-json { white-space: pre-wrap; word-break: break-all; font-size: 85%; background: #f8f9fa; padding: 8px; border: 1px solid #dee2e6; font-family: monospace; }
  .ips-userbar { float: right; font-size: 85%; background: #eef3f8; border: 1px solid #c5d3e0; border-radius: 4px; padding: 3px 10px; margin: 0 0 8px 12px; }
  .ips-banner { background: #ede7f6; border: 1px solid #d1c4e9; border-radius: 4px; padding: 10px 14px; margin-bottom: 10px; }
  .ips-banner-flagged { display: flex; align-items: center; gap: 14px; }
  .ips-flag { height: 40px; width: auto; max-width: 80px; border: 1px solid #d1c4e9; flex: none; }
  .ips-banner .ips-patient { font-size: 120%; }
  .ips-banner .ips-project-name { font-size: 130%; }
  .ips-actions-line { margin-bottom: 10px; }
  .ips-actions-line .btn { font-size: 90%; padding: 3px 12px; }
  .ips-search { background: #fffde7; border: 1px solid #fff59d; border-radius: 4px; padding: 8px 10px; }
  .ips-docs h4 { margin-top: 0; }
  .ips-api td:first-child { white-space: nowrap; }
  .ips-banner .ips-facts { font-size: 90%; color: #444; margin-top: 4px; }
  .ips-banner .ips-facts a { margin-left: 4px; }
  .ips-steps { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; margin-bottom: 10px; font-size: 90%; }
  .ips-pipeline { display: flex; flex-wrap: wrap; row-gap: 4px; align-items: stretch; }
  .ips-step { display: inline-flex; align-items: center; gap: 5px; padding: 3px 14px 3px 20px; margin-right: -8px; color: white; white-space: nowrap; cursor: default;
    clip-path: polygon(0 0, calc(100% - 10px) 0, 100% 50%, calc(100% - 10px) 100%, 0 100%, 10px 50%); }
  .ips-step:first-child { padding-left: 12px; border-radius: 3px 0 0 3px; clip-path: polygon(0 0, calc(100% - 10px) 0, 100% 50%, calc(100% - 10px) 100%, 0 100%); }
  a.ips-step { cursor: pointer; color: white; text-decoration: none; }
  a.ips-step:hover, a.ips-step:focus { color: white; text-decoration: none; filter: brightness(1.15); }
  .ips-step-received { background: #5e35b1; }
  .ips-step-done { background: #1e7e34; }
  .ips-step-failed { background: #c82333; }
  .ips-step-running { background: #0d6efd; }
  .ips-step-waiting { background: #6c757d; }
  .ips-step-running .ips-step-icon { display: inline-block; animation: ips-spin 2s linear infinite; }
  @keyframes ips-spin { to { transform: rotate(360deg); } }
  .ips-switch { display: inline-flex; margin-bottom: 10px; font-size: 90%; }
  .ips-switch a { padding: 3px 12px; border: 1px solid #ced4da; color: #444; text-decoration: none; }
  .ips-switch a + a { border-left: none; }
  .ips-switch a:first-child { border-radius: 3px 0 0 3px; }
  .ips-switch a:last-child { border-radius: 0 3px 3px 0; }
  .ips-switch a.active { background: #5e35b1; border-color: #5e35b1; color: white; }
  .ips-doc-actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 10px; }
  .ips-doc-banner { display: flex; flex-wrap: wrap; gap: 6px 24px; align-items: center; background: #f5f5f5; border: 1px solid #ddd; border-radius: 4px; padding: 6px 12px; margin-bottom: 10px; }
  .ips-doc-banner-group { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .ips-doc-banner-label { font-weight: bold; margin-right: 4px; }
  .ips-doc-banner .btn { font-size: 90%; padding: 2px 10px; }
  .ips-doc-banner a.btn { text-decoration: none; }
  .ips-doc-banner-message { flex-basis: 100%; font-size: 90%; }
  .ips-doc-banner .ips-sign { flex-basis: 100%; }
  .ips-sign-choice { font-weight: normal; margin: 0 0 0 6px; }
  .ips-sign-off { color: #777; }
  .ips-doc-banner-message:empty { display: none; }
  .ips-doc-actions .btn { font-size: 90%; padding: 2px 10px; }
  .ips-nav.nav-tabs { margin-bottom: 14px; }
  .ips-nav.nav-tabs > li > a { padding: 6px 9px; }
  .ips-patient-comment { border: 1px solid #dee2e6; border-radius: 4px; padding: 8px 12px; margin-bottom: 6px; background-color: #fcfcf4; }
  .ips-explain { margin-top: 18px; padding-top: 8px; border-top: 1px solid #dee2e6; }
  .ips-filter { display: flex; flex-wrap: wrap; gap: 4px 6px; align-items: center; font-size: 85%; }
  .ips-filter input, .ips-filter select { font-size: 100%; padding: 1px 4px; height: auto; }
  .ips-filter input[type=text] { width: 10em; }
  .ips-filter input[type=date] { width: 9.5em; }
  .ips-filter .ips-btn { font-size: 100%; padding: 1px 10px; line-height: 1.5; }
  .ips-date { white-space: nowrap; }
  .ips-narrative { border: 1px solid #dee2e6; padding: 12px; background: #fff; }
  .ips-narrative h3 { font-size: 130%; margin-top: 8px; }
  .ips-narrative h4 { font-size: 110%; margin-top: 18px; border-bottom: 1px solid #eee; }
  .ips-narrative h5 { font-size: 100%; margin-top: 12px; }
  .ips-narrative table { border-collapse: collapse; margin-bottom: 8px; }
  .ips-narrative td, .ips-narrative th { border: 1px solid #ddd; padding: 2px 6px; font-size: 90%; }
  .ips-meta { font-size: 85%; color: #555; margin-bottom: 10px; }
  .ips-form label { display: block; font-weight: bold; margin-top: 10px; }
  .ips-form textarea { width: 100%; height: 20em; font-family: monospace; font-size: 85%; }
  .ips-form input[type=text], .ips-form input[type=password] { width: 100%; max-width: 480px; }
  .ips-small { font-size: 85%; color: #555; }
  .ips-term th.ips-section { background: #e9ecef; font-size: 105%; }
  .ips-term th.ips-resource { background: #f8f9fa; font-weight: normal; font-style: italic; }
  .ips-term ul { margin: 0; padding-left: 1.2em; }
  .ips-term code { font-size: 95%; }
  .ips-copy { font-size: 85%; padding: 0 6px; }
  .ips-grade { font-size: 110%; padding: 2px 10px; }
  .ips-ed-panel { background: #f8f9fa; border: 1px solid #dee2e6; border-radius: 4px; padding: 8px 14px; margin-bottom: 12px; }
  .ips-ed-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 6px 14px; }
  .ips-ed-field label { display: block; font-size: 85%; margin: 4px 0 2px; color: #444; }
  .ips-ed-input { font-size: 90%; padding: 3px 6px; height: auto; }
  .ips-ed-hint { color: #6c757d; }
  .ips-ed-quantity { display: flex; gap: 4px; } .ips-ed-qty { width: 8em; } .ips-ed-unit { width: 7em; }
  .ips-ed-code { position: relative; }
  .ips-ed-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 3px; }
  .ips-ed-chip { display: inline-block; background: #e9ecef; border-radius: 12px; padding: 1px 8px; font-size: 85%; }
  .ips-ed-chip-coded { background: #d1e7dd; }
  .ips-ed-chip-x { margin-left: 3px; color: #666; text-decoration: none; }
  .ips-ed-suggestions { position: absolute; z-index: 20; background: #fff; border: 1px solid #ccc; box-shadow: 0 2px 8px rgba(0,0,0,0.2); max-height: 260px; overflow: auto; width: 100%; }
  .ips-ed-suggestion { padding: 4px 8px; cursor: pointer; font-size: 90%; }
  .ips-ed-suggestion:hover { background: #f0f4ff; }
  .ips-ed-suggestion small { color: #888; } .ips-ed-suggestion-text { color: #555; border-top: 1px solid #eee; }
  .ips-pf-row { border: 1px solid #dee2e6; border-radius: 4px; padding: 8px 10px; margin-bottom: 8px; background: #fcfcfd; }
  .ips-pf-row .ips-pf-head { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; }
  .ips-pf-row .ips-pf-head input { flex: 1; }
  .ips-pf-grid { width: 100%; font-size: 90%; }
  .ips-pf-grid th { font-weight: normal; color: #666; font-size: 90%; padding: 0 4px; }
  .ips-pf-grid td { vertical-align: top; padding: 2px 4px; }
  .ips-pf-grid td.ips-pf-card { width: 7em; }
  .ips-pf-grid .ips-ed-input { width: 100%; box-sizing: border-box; }
  .ips-pf-pair { display: flex; gap: 4px; }
  .ips-pf-pair select { max-width: 13em; }
  .ips-pf-display { font-size: 85%; color: #555; margin-top: 2px; min-height: 1em; }
  .ips-pf-expr { font-family: monospace; font-size: 85%; color: #666; margin-top: 4px; word-break: break-all; }
  .ips-pf-bad { border-color: #c82333 !important; }
  .ips-pf-rule { width: 100%; table-layout: fixed; }
  .ips-pf-rule td { vertical-align: top; overflow-wrap: anywhere; }
  .ips-pf-rule .ips-pf-actions { width: 7em; white-space: nowrap; text-align: right; }
  .ips-pf-rule td.ips-pf-actions { padding-top: 1px; padding-bottom: 1px; }
  .ips-pf-part-head { display: flex; align-items: baseline; gap: 12px; margin-top: 18px; }
  .ips-pf-part-head h4 { margin: 0 0 6px; }
  .ips-pf-part-head .ips-pf-add { font-size: 80%; padding: 0 8px; line-height: 1.6; }
  .ips-pf-rule .ips-pf-actions .btn { font-size: 75%; padding: 0 5px; line-height: 1.5; border-radius: 3px; vertical-align: baseline; }
  .ips-pf-how { align-items: center; gap: 8px; margin-top: 6px; } .ips-pf-how input { width: 7em; flex: none; } .ips-pf-how .ips-pf-hint { margin: 0; }
  .ips-pf-dialog { width: min(760px, 95vw); max-height: 90vh; padding: 0; border: 1px solid #bbb; border-radius: 6px; box-shadow: 0 8px 30px rgba(0,0,0,0.3); }
  .ips-pf-dialog::backdrop { background: rgba(0,0,0,0.35); }
  .ips-pf-dialog-head { display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; border-bottom: 1px solid #dee2e6; background: #f8f9fa; }
  .ips-pf-dialog-head h4 { margin: 0; }
  .ips-pf-dialog-x { border: none; background: none; font-size: 22px; line-height: 1; cursor: pointer; color: #666; }
  .ips-pf-dialog-body { padding: 12px 16px; overflow: visible; }
  .ips-pf-dialog-foot { padding: 10px 16px; border-top: 1px solid #dee2e6; text-align: right; }
  .ips-pf-field { margin-bottom: 14px; }
  .ips-pf-field > .ips-pf-label { display: block; font-weight: bold; margin-bottom: 4px; }
  .ips-pf-field .ips-ed-input, .ips-pf-field textarea { width: 100%; box-sizing: border-box; }
  .ips-pf-field > * + * { margin-top: 4px; }
  .ips-pf-field .ips-pf-pair .ips-ed-input { width: auto; flex: 1; }
  .ips-pf-field .ips-pf-how .ips-ed-input { width: 7em; flex: none; }
  .ips-pf-hint { font-size: 85%; color: #6c757d; }
  .ips-pf-rule .ips-pf-card-text { white-space: nowrap; }
  .ips-ed-section { border: 1px solid #dee2e6; border-radius: 4px; margin-bottom: 8px; }
  .ips-ed-section-required { border-color: #b8c4e8; }
  .ips-ed-section-head { padding: 8px 12px; cursor: pointer; background: #f1f3f5; user-select: none; }
  .ips-ed-section-required .ips-ed-section-head { background: #e8edf8; }
  .ips-ed-caret { display: inline-block; width: 1em; color: #666; }
  .ips-ed-section-body { padding: 8px 12px; }
  .ips-ed-section-body[hidden] { display: none; }
  .ips-ed-modes { margin-bottom: 8px; font-size: 90%; } .ips-ed-mode { margin-right: 16px; font-weight: normal; }
  .ips-ed-row { border: 1px solid #e3e6ea; border-radius: 4px; padding: 6px 10px; margin-bottom: 8px; background: #fff; }
  .ips-ed-row-head { display: flex; justify-content: space-between; align-items: center; }
  .ips-ed-remove { padding: 0; font-size: 85%; }
  .ips-ed-sub { margin: 6px 0 0 12px; padding-left: 10px; border-left: 3px solid #e3e6ea; }
  .ips-ed-sub-head { font-size: 85%; font-weight: bold; color: #444; margin-bottom: 2px; }
  .ips-ed-sub-row { display: flex; gap: 10px; align-items: flex-start; margin-bottom: 4px; } .ips-ed-sub-row .ips-ed-grid { flex: 1; }
  .ips-ed-actions { margin-top: 16px; padding-top: 10px; border-top: 1px solid #dee2e6; }
  .ips-ed-messages ul { margin-bottom: 0; }
  .ips-share-overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.55); z-index: 1050; display: flex; align-items: center; justify-content: center; }
  .ips-share-overlay[hidden] { display: none; }
  .ips-share-panel { background: #fff; border-radius: 6px; padding: 18px 22px; max-width: 560px; width: 92%; max-height: 92vh; overflow: auto; box-shadow: 0 6px 24px rgba(0, 0, 0, 0.4); position: relative; }
  .ips-share-panel .ips-share-close { position: absolute; top: 8px; right: 12px; font-size: 24px; }
  .ips-share-code { text-align: center; margin: 10px 0; }
  .ips-share-code svg { width: 320px; max-width: 100%; height: auto; }
  .ips-share-text { width: 100%; font-family: monospace; font-size: 80%; }
  .ips-issues td.ips-path { max-width: 28em; overflow: hidden; }
  .ips-issues td.ips-path code { white-space: normal; word-break: keep-all; overflow-wrap: normal; }
  .ips-oo { margin-top: 10px; }
  .ips-oo summary { list-style: none; display: inline-block; }
  .ips-oo summary::-webkit-details-marker { display: none; }
  .ips-oo pre { margin-top: 8px; }
  .ips-generated table.ips-section, .ips-generated table.ips-facts { border-collapse: collapse; margin-bottom: 10px; font-size: 90%; }
  .ips-generated table.ips-section th, .ips-generated table.ips-section td, .ips-generated table.ips-facts td { border: 1px solid #dee2e6; padding: 3px 6px; vertical-align: top; }
  .ips-generated table.ips-section th { background: #f8f9fa; }
  .ips-generated tr.ips-follow td { background: #fcfcfc; }
  .ips-generated tr.ips-follow ul { margin: 0; padding-left: 18px; }
  .ips-generated .ips-as-submitted { font-size: 85%; color: #6c757d; margin-bottom: 4px; }
  .ips-generated h1 { font-size: 150%; } .ips-generated h2 { font-size: 125%; margin-top: 16px; } .ips-generated h3 { font-size: 110%; }
  .ips-translated { font-size: 80%; color: #fff; background: #6f42c1; border-radius: 3px; padding: 0 5px; cursor: help; }
  .ips-check { font-size: 130%; font-weight: bold; cursor: help; }
  .ips-check-in { color: #1e7e34; }
  .ips-check-international { color: #a35200; }
  .ips-check-not-in { color: #c82333; }
  .ips-check-unknown { color: #6c757d; }
  .ips-inline { display: inline; }
  .ips-tree-tools { margin-bottom: 8px; font-size: 90%; }
  .ips-an { font-size: 90%; }
  .ips-an > tbody > tr.ips-an-node > td { border-top: 2px solid #dee2e6; background: #f8f9fa; }
  .ips-an > tbody > tr.ips-an-findings > td { border-top: none; padding: 2px 8px 8px 30px; }
  .ips-an td.ips-an-path { word-break: break-all; }
  .ips-an td.ips-an-path img { vertical-align: -3px; }
  .ips-an tr.ips-tt-seen > td { background-color: #EFEFEF; }
  .ips-an ul { margin: 0; padding-left: 18px; }
  .ips-an-modifier { color: #800000; font-weight: bold; }
  .ips-an-status { color: #000080; font-weight: bold; }
  .ips-an-subject { color: #006400; font-weight: bold; }
  .ips-an-attention { color: #b34700; font-weight: bold; }
  .ips-an-ok { color: #1e7e34; }
  .ips-an-narrative { color: #3a4d5e; }
  .ips-an-negation { color: #3a4d5e; }
  .ips-an-error { color: #c00000; font-weight: bold; }
  .ips-tree-tools .btn { font-size: 90%; padding: 2px 10px; }
  .ips-tt { font-size: 90%; width: auto; min-width: 60%; }
  .ips-tt > thead > tr > th { background: #f0f0f0; font-weight: bold; white-space: nowrap; }
  .ips-tt > tbody > tr > td { border-top: none; padding: 0 10px 0 4px; line-height: 24px; vertical-align: top; }
  .ips-tt > tbody > tr > td.ips-tt-path { position: relative; white-space: nowrap; padding-right: 16px; }
  .ips-tt td.ips-tt-path img { vertical-align: -3px; position: relative; z-index: 1; background: white; }
  .ips-tt tr.ips-tt-parent:not(.ips-tt-closed) > td.ips-tt-path::after { content: ''; position: absolute; left: var(--ips-tt-down, 8px); top: 18px; bottom: 0; border-left: 1px solid #adb5bd; }
  .ips-tt-toggle { position: absolute; top: 7px; width: 11px; height: 11px; padding: 0; z-index: 2; border: 1px solid #868e96; background: white; font-size: 9px; line-height: 9px; color: #495057; cursor: pointer; }
  .ips-tt-toggle::before { content: '\\2212'; }
  .ips-tt tr.ips-tt-closed .ips-tt-toggle::before { content: '+'; }
  .ips-tt tr.ips-tt-seen > td { background-color: #EFEFEF; }
  .ips-tt tr.ips-tt-missing > td:last-child { color: #c82333; }
  .ips-tt .ips-tt-when { color: #3a4d5e; margin-left: 6px; }
</style>
<script>
  // a form with data-confirm asks first: the message is an attribute (escaped as one), never script
  if (!window.ipsConfirm) {
    window.ipsConfirm = true;
    document.addEventListener('submit', function (e) {
      var f = e.target;
      if (f && f.getAttribute && f.getAttribute('data-confirm') !== null && !window.confirm(f.getAttribute('data-confirm'))) {
        e.preventDefault();
      }
    });
  }
</script>`;

function text(v) {
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return String(v);
  }
  return '';
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function badge(status) {
  const s = text(status);
  if (!s) {
    return '';
  }
  return `<span class="ips-badge" style="background-color: ${STATUS_COLOURS[s] || '#495057'}">${escape(s)}</span>`;
}

/** Just the date part of a FHIR date/dateTime/instant, as sent. */
function dateOnly(v) {
  const s = text(v);
  const m = /^\d{4}(-\d{2}(-\d{2})?)?/.exec(s);
  return m ? m[0] : s;
}

/** Build a query string from a plain object, dropping empty values. */
function qs(params) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    for (const x of (Array.isArray(v) ? v : [v])) {
      if (typeof x === 'string' && x !== '') {
        u.append(k, x);
      }
    }
  }
  const s = u.toString();
  return s ? '?' + s : '';
}

function field(query, name) {
  const v = query[name];
  return typeof v === 'string' ? v : (Array.isArray(v) && typeof v[0] === 'string' ? v[0] : '');
}

/** The hidden field every POST form carries: the CSRF token (lusca checks it). */
function csrfField(token) {
  return token ? `<input type="hidden" name="_csrf" value="${escape(token)}"/>` : '';
}

function alert(message, kind = 'warning') {
  return message ? `<div class="alert alert-${kind}">${escape(message)}</div>` : '';
}

/**
 * The administrators' links at the top of every page. Who is logged in (or Login) is the
 * right-most item of the top menu, as on every module's pages ([%account%], library/auth)
 * @param {{base: string, user?: Object}} ctx
 */
function userBar(ctx) {
  const u = ctx.user;
  if (!u || !u.isAdmin) {
    return '';
  }
  const base = escape(ctx.base);
  const parts = [
    `<a href="${base}/admin/projects">Projects</a>`,
    `<a href="${base}/StructureDefinition">Clinical profiles</a>`,
    `<a href="${base}/national-profiles">National profiles</a>`,
    `<a href="${base}/reports">Reports</a>`
  ];
  return `<div class="ips-userbar">${parts.join(' &nbsp;|&nbsp; ')}</div>`;
}

function projectUrl(ctx, project) {
  return `${escape(ctx.base)}/${encodeURIComponent(project.code)}`;
}

function crumbs(ctx, project, extra) {
  let h = `<p class="ips-small"><a href="${escape(ctx.base)}">IPS projects</a>`;
  if (project) {
    h += ` &raquo; <a href="${projectUrl(ctx, project)}">${escape(project.name)}</a>`;
  }
  if (extra) {
    h += ` &raquo; ${escape(extra)}`;
  }
  return h + '</p>';
}

// ---- the root: projects ----------------------------------------------------------------

/**
 * The list of projects.
 * @param {Array} projects - from store.projects()
 * @param {{base: string, user?: Object, csrf?: string}} ctx
 */
function renderHome(projects, ctx) {
  let h = STYLE + userBar(ctx);
  h += '<p>Each project is a collection of International Patient Summary documents. Users can:</p> ' +
       '<ul> ' +
       '  <li>Upload their own documents through the web or the FHIR API, create a document directly, or through QR Codes (see below)</li> ' +
       `  <li>Once uploaded, each document is check for validity against international IPS and other <a href="${escape(ctx.base)}/national-profiles">jurisdictional IPS variants</a></li> ` +
       '  <li>Terminology is converted to international suitable versions where possible, and the document is assessed for international suitability</li> ' +
       `  <li>The document is checked against clinical criteria for different conditions (<a href="${escape(ctx.base)}/StructureDefinition">Clinical profiles</a>)</li> ` +
       '  <li>An AI Agent checks the document for coherence</li> ' +
       '  <li>The original or internationalised document can be downloaded directly, or via the FHIR API or turned into a QR code</li> ' +
       '  <li>Documents can be signed, and signatures are checked, and patients can comment on the document</li> ' +
       '</ul>' +
       `<p>Each project produce <a href="${escape(ctx.base)}/reports">Reports</a> (tables of data drawn from the documents). ` +
       `In addition, the <a href="${escape(ctx.base)}/view">SHL viewer</a> opens SMART Health Links and Verifiable Health Links that carry IPS documents. ` +
       `To make an IPS document - to download, share as a QR code, or submit to a project - <a href="${escape(ctx.base)}/compose">compose a document</a>.</p>`;
  if (projects.length === 0) {
    h += '<p>There are no projects yet' + (ctx.user?.isAdmin ? `: <a href="${escape(ctx.base)}/admin/projects">create one</a>` : '') + '.</p>';
  } else {
    h += '<table class="table table-sm table-striped ips-table"><tr><th>Project</th><th>Code</th><th>Description</th><th>Documents</th></tr>';
    for (const p of projects) {
      h += `<tr><td><a href="${projectUrl(ctx, p)}">${escape(p.name)}</a></td><td><code>${escape(p.code)}</code></td>` +
        `<td>${escape(p.description || '')}</td><td>${p.documents}</td></tr>`;
    }
    h += '</table>';
  }
  if (ctx.viewerUrl) {
    h += viewerInstructions(ctx);
  }
  return h;
}

/**
 * For the home page: how another system makes this server the viewer for the SHLs and VHLs
 * it generates.
 */
function viewerInstructions(ctx) {
  const v = escape(ctx.viewerUrl);
  const base = escape(ctx.base);
  return '<div class="ips-explain"><h3>Using this server as the viewer for your SMART Health Links</h3>' +
    `<p>This server has an <a href="${base}/view">SHL viewer</a>. A system that generates SMART Health Links (SHL) or Verifiable Health Links (VHL) ` +
    'for IPS documents can name it as the viewer, so that whoever opens the link sees the document here - and, if they want, adds it to one of the projects. ' +
    'It is meant for testing: each step it takes is shown on the page, so it is also a way to see what your SHL server does, and where it goes wrong.</p>' +
    '<h4>SHL</h4>' +
    `<p>Put the viewer's address in front of the shlink, as the SHL specification describes: the link (and the QR code) is <code>${v}shlink:/{payload}</code>, ` +
    'where <code>{payload}</code> is the base64url-encoded JSON payload (<code>url</code>, <code>key</code>, and optionally <code>exp</code>, <code>flag</code>, <code>label</code>, <code>v</code>). ' +
    'The part after the <code>#</code> is never sent to this server by the browser: the page reads it and passes it on. For example:</p>' +
    `<pre class="ips-json">${v}shlink:/eyJ1cmwiOiJodHRwczovL3NobC5leGFtcGxlLm9yZy9hY2Nlc3MvMTIzIiwia2V5IjoiLi4uIiwiZmxhZyI6IlUiLCJsYWJlbCI6Ikphbidz...</pre>` +
    '<ul>' +
    '<li>Your SHL server must be reachable from this server over https, at a public address. It does not need to allow cross-origin requests: the viewer works on the server, not in the browser (the log says whether it does, for viewers that run in the browser)</li>' +
    '<li>Flag <code>U</code>: the viewer gets the file with <code>GET {url}?recipient=...</code> and expects the JWE back. Otherwise it posts <code>{ "recipient": ..., "passcode": ... }</code> to <code>{url}</code> ' +
    'and reads the manifest\'s files - <code>embedded</code>, or fetched from <code>location</code></li>' +
    '<li>Flag <code>P</code>: the viewer asks the user for the passcode, and says when your server refuses it (with the attempts left, if your server gives <code>remainingAttempts</code>)</li>' +
    '<li>The files must be JWEs (<code>alg: dir</code>, <code>enc: A256GCM</code>; <code>zip: DEF</code> is fine) of <code>application/fhir+json</code> content. ' +
    'SMART Health Cards and SMART API access are not supported here</li>' +
    '<li>A document can be added to a project only if it is an IPS: a <code>document</code> Bundle whose Composition.type is LOINC <code>60591-5</code>. Other documents can be looked at</li>' +
    '</ul>' +
    '<h4>VHL</h4>' +
    '<p>A VHL\'s QR code carries <code>HC1:...</code>, not an address, so it cannot name a viewer: whoever has the QR code scans it with an app that knows what to do with it. ' +
    `To open one here, paste the <code>HC1:...</code> text into the <a href="${base}/view">viewer</a>, or link to <code>${v}HC1:...</code> with the <code>HC1:...</code> text percent-encoded ` +
    '(base45 uses the space, <code>%</code>, <code>+</code> and other characters that are not safe in an address as they are). ' +
    'The viewer decodes it, checks the signature, and opens the SHL it carries as above. The signature is checked only when this server has the issuer\'s certificate, ' +
    'published through the GDHCN trust network: ask the server\'s administrator to add it (otherwise the log says it could not be checked).</p>' +
    '<p class="ips-small">This is a public test service: the link - its key included - what your server sends back, and the document are shown on the viewer\'s page and kept for a while. ' +
    'Don\'t use it for real patients\' documents.</p></div>';
}

/**
 * The administrator's projects page: create, edit, delete, and who manages each.
 * @param {Array} projects - from IpsModule.projectsWithManagers()
 * @param {Array} users - the users who can be made managers: the IPS Project Admins
 */
function renderProjects(projects, users, ctx, message) {
  const base = escape(ctx.base);
  let h = STYLE + userBar(ctx) + crumbs(ctx, null, 'Projects') + alert(message);
  h += '<p>A project\'s managers can be any of the users with the <b>IPS Project Admin</b> role, which the server\'s administrator gives on ' +
    '<a href="/auth/admin/users">the users page</a>. A project\'s code is its address: <code>' + base + '/{code}</code>. ' +
    'Codes are 2-32 lower case letters, digits and hyphens, and can\'t be changed once a project exists.</p>';
  const box = (form, u, on, note = '') => `<label class="ips-inline" style="margin-right: 8px; font-weight: normal"><input form="${form}" type="checkbox" name="manager" value="${u.id}"${on ? ' checked' : ''}/> ` +
    `${escape(u.login)}${note}</label>`;
  const managerBoxes = (p, form) => {
    const current = p ? p.managers : [];
    // a manager who is no longer an IPS Project Admin is shown until taken off
    const others = current.filter(m => !users.some(u => u.id === m.id))
      .map(m => box(form, m, true, ' <span class="ips-small">(not an IPS Project Admin)</span>'));
    const boxes = users.map(u => box(form, u, current.some(m => m.id === u.id))).concat(others);
    return boxes.join('') || '<span class="ips-small">(no users have the IPS Project Admin role)</span>';
  };
  h += '<table class="table table-sm ips-table"><tr><th>Code</th><th>Name</th><th>Description</th><th>Managers</th><th>Documents</th><th></th></tr>';
  for (const p of projects) {
    const form = `project-${p.id}`;
    const action = `${base}/admin/projects/${p.id}`;
    h += `<tr><td><a href="${projectUrl(ctx, p)}"><code>${escape(p.code)}</code></a></td>` +
      `<td><input form="${form}" type="text" name="name" required class="form-control" style="font-size: 85%" value="${escape(p.name)}"/></td>` +
      `<td><input form="${form}" type="text" name="description" class="form-control" style="font-size: 85%" value="${escape(p.description || '')}"/></td>` +
      `<td>${managerBoxes(p, form)}</td><td>${p.documents}</td>` +
      `<td style="white-space: nowrap"><form id="${form}" method="post" action="${action}" class="ips-inline">${csrfField(ctx.csrf)}` +
      '<button type="submit" class="btn btn-primary ips-btn" style="font-size: 85%; padding: 1px 10px">Save</button></form> ' +
      `<form method="post" action="${action}/delete" class="ips-inline" data-confirm="${escape(`Delete project ${p.code} and its ${p.documents} documents?`)}">${csrfField(ctx.csrf)}` +
      '<button type="submit" class="btn btn-default ips-btn" style="font-size: 85%; padding: 1px 10px">Delete</button></form></td></tr>';
  }
  h += `<tr><td><input form="project-new" type="text" name="code" required class="form-control" style="font-size: 85%" placeholder="code" pattern="[a-z0-9][a-z0-9-]{1,31}"/></td>` +
    '<td><input form="project-new" type="text" name="name" required class="form-control" style="font-size: 85%" placeholder="Name"/></td>' +
    '<td><input form="project-new" type="text" name="description" class="form-control" style="font-size: 85%" placeholder="Description"/></td>' +
    `<td>${managerBoxes(null, 'project-new')}</td><td></td>` +
    `<td><form id="project-new" method="post" action="${base}/admin/projects">${csrfField(ctx.csrf)}` +
    '<button type="submit" class="btn btn-primary ips-btn" style="font-size: 85%; padding: 1px 10px">Create</button></form></td></tr>';
  return h + '</table>';
}

// ---- a project -------------------------------------------------------------------------

function input(query, name, label, type = 'text', placeholder = label) {
  return `<input type="${type}" id="f-${escape(name)}" name="${escape(name)}" placeholder="${escape(placeholder)}" ` +
    `title="${escape(label)}" aria-label="${escape(label)}" value="${escape(field(query, name))}"/>`;
}

function select(query, name, values, label, anyLabel) {
  const cur = field(query, name);
  let h = `<select id="f-${escape(name)}" name="${escape(name)}" title="${escape(label)}"><option value="">${escape(anyLabel || label + ': any')}</option>`;
  for (const v of values) {
    h += `<option value="${escape(v)}"${v === cur ? ' selected' : ''}>${escape(v)}</option>`;
  }
  return h + '</select>';
}

/** The links under a project's title. */
function projectNav(project, ctx) {
  const purl = projectUrl(ctx, project);
  let h = `<div class="ips-actions-line"><a class="btn btn-primary" href="${purl}/submit">Submit a document</a> <a class="btn btn-default" href="${purl}/compose">Compose a document</a> <a class="btn btn-default" href="${purl}/Patient">Patients</a> <a class="btn btn-default" href="${purl}/reports">Reports</a>`;
  if (ctx.canManage) {
    h += ` <a class="btn btn-default" href="${purl}/settings">Settings</a>`;
  }
  return h + '</div>';
}

/** What submitting on the API needs, for the documentation: '' when anyone can */
function submitNote(project) {
  const token = tokenConfigured(project.token);
  const users = project.submit_users === 'any' ? 'a user' : project.submit_users === 'approved' ? 'an approved user' : '';
  if (token && users) {
    return ` (this project requires its token, or ${users}'s API token: <code>Authorization: Bearer {token}</code>)`;
  }
  if (users) {
    return ` (this project requires ${users}'s API token, made on their account page: <code>Authorization: Bearer {token}</code>)`;
  }
  return token ? ' (this project requires a token: <code>Authorization: Bearer {token}</code>)' : '';
}

/** The documentation at the foot of a project's page: how to reach it as a FHIR endpoint. */
function projectDocs(project, ctx) {
  const purl = projectUrl(ctx, project);
  return '<div class="ips-explain ips-docs"><h3>Documentation</h3>' +
    `<p>This project is a FHIR endpoint: <code>${purl}</code> (<a href="${purl}/metadata">CapabilityStatement</a>). ` +
    'Documents are IPS Bundles (<code>type: document</code>, a Composition first, with the Patient it refers to) in JSON.</p>' +
    '<table class="table table-sm ips-table ips-api"><tr><th>Request</th><th></th></tr>' +
    `<tr><td><code>POST ${purl}/Bundle</code></td><td>submit a document${submitNote(project)}; the response is the stored document, with its id</td></tr>` +
    `<tr><td><code>GET ${purl}/Bundle/{id}</code></td><td>read a document - JSON for a FHIR client, this web page for a browser (<code>?_format=json</code> forces JSON, <code>?download=1</code> downloads it)</td></tr>` +
    `<tr><td><code>GET ${purl}/Bundle/{id}/$document?...</code></td><td>the document as the source view gives it for download or sharing: parameters <code>source</code> (original | modified), ` +
    '<code>user-sign</code> (as the owner of the API token in <code>Authorization: Bearer</code>), <code>system-sign</code>, <code>patient-notes</code>, <code>regenerate-narrative</code> (true | false); ' +
    'by <code>Accept</code> (or <code>_format</code>) the JSON, <code>application/zip</code>, <code>application/pdf</code>, or the QR code (a PNG) of an SHL (<code>application/smart-health-link</code>) or VHL (<code>application/verified-health-link</code>) - ' +
    '<a href="https://github.com/HealthIntersections/FHIRsmith/blob/main/ips/OperationDefinition-ips-document.json">OperationDefinition</a></td></tr>' +
    `<tr><td><code>GET ${purl}/Bundle?...</code></td><td>search: Bundle's search parameters (<code>_id</code>, <code>identifier</code>, <code>_lastUpdated</code>, <code>composition</code>), chained to the Composition and Patient as ` +
    '<code>composition.date</code>, <code>composition.title</code>, <code>composition.patient.name</code>, <code>composition.patient.gender</code>, <code>composition.patient.birthdate</code>, <code>composition.patient.identifier</code>, ...; ' +
    'with <code>_sort</code>, <code>_count</code>, <code>_offset</code>, <code>_summary=count</code>, and <code>processing-status</code> for where a document is in the pipeline (the CapabilityStatement lists them all)</td></tr>' +
    `<tr><td><code>GET ${purl}/metadata</code></td><td>the CapabilityStatement</td></tr></table>` +
    '<p class="ips-small">The filters above are the same searches, as the page sends them. See the ' +
    '<a href="https://github.com/HealthIntersections/FHIRsmith/blob/main/ips/readme.md">IPS module documentation</a> for the processing pipeline and the document views.</p></div>';
}

/**
 * A project's page: the filter form and the list of documents.
 *
 * @param {Object} project
 * @param {Object} query - the page's own query (form fields included)
 * @param {{total: number, rows: Object[]}} results
 * @param {Object} search - the parsed search (for count/offset/sort)
 * @param {{base: string, user?: Object, csrf?: string, canManage?: boolean}} ctx
 */
function renderProject(project, query, results, search, ctx, problems) {
  const purl = projectUrl(ctx, project);
  let h = STYLE + userBar(ctx) + crumbs(ctx);
  h += `<div class="ips-banner"><div class="ips-project-name"><b>${escape(project.name)}</b></div>`;
  if (project.description) {
    h += `<div class="ips-facts">${escape(project.description)}</div>`;
  }
  h += '</div>';
  h += projectNav(project, ctx);
  if (problems && problems.length > 0) {
    h += '<div class="alert alert-warning">' + problems.map(escape).join('<br/>') + '</div>';
  }

  h += `<form method="get" action="${purl}" class="ips-filter ips-search mb-3">`;
  h += input(query, 'name', 'Patient name (any part)', 'text', 'Patient name');
  h += select(query, 'gender', ['male', 'female', 'other', 'unknown'], 'Gender');
  h += input(query, 'date', 'Document date', 'date');
  h += input(query, 'identifier', 'Document id or patient identifier', 'text', 'Identifier');
  h += select(query, 'status', STATUSES, 'Status');
  h += select(query, '_count', ['20', '50', '100', '200', '500'], 'Page size', 'Page: 50');
  if (field(query, '_sort')) {
    h += `<input type="hidden" name="_sort" value="${escape(field(query, '_sort'))}"/>`;
  }
  h += '<button type="submit" class="btn btn-primary ips-btn">Filter</button>' +
    `<a class="btn btn-default ips-btn" href="${purl}">Clear</a></form>`;

  const from = results.total === 0 ? 0 : search.offset + 1;
  const to = search.offset + results.rows.length;
  h += `<p>${from}-${to} of ${results.total} document${results.total === 1 ? '' : 's'}</p>`;

  // [sort parameter, heading]; null parameter = not sortable
  const columns = [
    ['_id', 'Id'], ['composition.patient.name', 'Patient'], ['composition.patient.gender', 'Gender'],
    ['composition.patient.birthdate', 'Born'], ['composition.date', 'Date'], ['composition.title', 'Title'],
    ['processing-status', 'Status'], ['_lastUpdated', 'Received'], [null, 'Jurisdiction']
  ];
  if (ctx.canManage) {
    columns.push([null, '']);
  }
  const curSort = field(query, '_sort');
  h += '<table class="table table-sm table-striped ips-table"><tr>';
  for (const [param, label] of columns) {
    if (!param) {
      h += `<th>${escape(label)}</th>`;
      continue;
    }
    let next = param;
    let arrow = '';
    if (curSort === param) {
      next = '-' + param;
      arrow = ' ▲';
    } else if (curSort === '-' + param) {
      arrow = ' ▼';
    }
    h += `<th><a href="${escape(qs({ ...query, _sort: next, _offset: '' }) || '?')}">${escape(label)}</a>${arrow}</th>`;
  }
  h += '</tr>';
  for (const r of results.rows) {
    const durl = `${purl}/Bundle/${r.id}`;
    h += `<tr><td><a href="${durl}">${r.id}</a></td>` +
      `<td><a href="${durl}">${escape(r.patient_name || '(no name)')}</a></td>` +
      `<td>${escape(r.patient_gender || '')}</td>` +
      `<td class="ips-date">${escape(r.patient_birth || '')}</td>` +
      `<td class="ips-date" title="${escape(r.comp_date || '')}">${escape(dateOnly(r.comp_date))}</td>` +
      `<td>${escape(r.comp_title || '')}</td>` +
      `<td title="${escape(ctx.canManage ? r.status_message || '' : '')}">${badge(r.status)}</td>` +
      `<td class="ips-date" title="${escape(r.received)}">${escape(dateOnly(r.received))}</td>` +
      `<td title="${escape(r.nationality ? (jurisdiction(r.nationality)?.display || r.nationality) : 'Not known')}">${escape(r.nationality || '??')}</td>`;
    if (ctx.canManage) {
      h += `<td><form method="post" action="${durl}/delete" class="ips-inline" data-confirm="${escape(`Delete document ${r.id}?`)}">${csrfField(ctx.csrf)}` +
        '<button type="submit" class="btn btn-link" style="padding: 0; font-size: 85%">delete</button></form></td>';
    }
    h += '</tr>';
  }
  h += '</table>';

  const links = [];
  if (search.offset > 0) {
    links.push(`<a href="${escape(qs({ ...query, _offset: '' }) || '?')}">First</a>`);
    links.push(`<a href="${escape(qs({ ...query, _offset: String(Math.max(0, search.offset - search.count)) }))}">Previous</a>`);
  }
  if (search.count > 0 && search.offset + search.count < results.total) {
    links.push(`<a href="${escape(qs({ ...query, _offset: String(search.offset + search.count) }))}">Next</a>`);
    const last = Math.floor((results.total - 1) / search.count) * search.count;
    links.push(`<a href="${escape(qs({ ...query, _offset: String(last) }))}">Last</a>`);
  }
  if (links.length > 0) {
    h += `<p>${links.join(' &nbsp;|&nbsp; ')}</p>`;
  }
  h += projectDocs(project, ctx);
  return h;
}

/**
 * The form for submitting a document by hand: paste the JSON, or pick a file (which the
 * page reads into the text area - there is no upload).
 */
function renderSubmit(project, ctx, options = {}) {
  const purl = projectUrl(ctx, project);
  let h = STYLE + userBar(ctx) + crumbs(ctx, project, 'Submit') + alert(options.error, 'danger');
  h += '<p>Paste an IPS document (a FHIR R4 <code>Bundle</code> of type <code>document</code>, as JSON, whose first entry is the ' +
    'Composition), or choose a file. Once received, the document is queued for processing.</p>';
  h += '<div class="alert alert-warning">Everyone can see the documents in a project. Don\'t submit real patients\' documents.</div>';
  if (options.aiEnabled) {
    h += '<div class="alert alert-info">Documents submitted to this project are sent to an external AI service for assessment, as part of their processing.</div>';
  }
  if (options.blocked) {
    // users only, and this one can't: say why, and (logged out) how
    h += `<div class="alert alert-warning">${escape(options.blocked)}${options.login && options.loginUrl ? ` - <a href="${escape(options.loginUrl)}">log in</a>` : ''}.</div>`;
    return h;
  }
  h += `<form method="post" action="${purl}/submit" class="ips-form">${csrfField(ctx.csrf)}`;
  if (options.asUser && ctx.user) {
    h += `<div class="ips-small">You are submitting as <b>${escape(ctx.user.name)}</b>.</div>`;
  }
  if (options.needsToken) {
    h += '<label for="token">Submission token</label><input type="password" id="token" name="token" required autocomplete="off"/>' +
      '<div class="ips-small">This project requires a token to submit documents; ask its managers.' +
      (options.login && options.loginUrl ? ` Or <a href="${escape(options.loginUrl)}">log in</a>: it takes documents from users too.` : '') + '</div>';
  }
  h += '<label for="file">File</label><input type="file" id="file" accept=".json,application/json,application/fhir+json"/>';
  h += `<label for="bundle">Document</label><textarea id="bundle" name="bundle" required>${escape(options.bundle || '')}</textarea>`;
  h += '<p style="margin-top: 10px"><button type="submit" class="btn btn-primary">Submit</button></p></form>';
  h += `<script>
document.getElementById('file').addEventListener('change', function () {
  var f = this.files && this.files[0];
  if (!f) { return; }
  var r = new FileReader();
  r.onload = function () { document.getElementById('bundle').value = r.result; };
  r.readAsText(f);
});
</script>`;
  return h;
}

/** A project's settings, for its managers: the submission token. */
function renderSettings(project, ctx, message, options = {}) {
  const purl = projectUrl(ctx, project);
  let h = STYLE + userBar(ctx) + crumbs(ctx, project, 'Settings') + alert(message, message && /must|cannot|not a URL|Unknown|no model|no API key/.test(message) ? 'danger' : 'success');
  const users = project.submit_users === 'any' || project.submit_users === 'approved' ? project.submit_users : '';
  h += '<h3>Who may submit</h3>';
  h += '<p>A project with no submission token and no users takes documents from anyone. Otherwise it takes them from whoever has its token, ' +
    'and from the users chosen below: either will do.</p>';
  h += '<h4>Submission token</h4>';
  h += '<p>When a token is set, a document can be submitted with it: in the <code>token</code> field of the ' +
    `submission form, or in the <code>Authorization</code> header of a <code>POST ${purl}/Bundle</code> ` +
    `(<code>Authorization: Bearer &lt;token&gt;</code>).${users ? '' : ' Clear it and anyone can submit.'}</p>`;
  h += `<p>Current token: ${project.token ? `<code>${escape(project.token)}</code>` : `<i>none${users ? '' : ' - submissions are open'}</i>`}</p>`;
  h += `<form method="post" action="${purl}/settings" class="ips-form" style="max-width: 480px">${csrfField(ctx.csrf)}` +
    '<label for="token">New token</label><input type="text" id="token" name="token" autocomplete="off" placeholder="leave blank to clear"/>' +
    '<p style="margin-top: 10px"><button type="submit" class="btn btn-primary">Save</button> ' +
    '<button type="submit" name="generate" value="1" class="btn btn-default">Generate a random token</button></p></form>';
  h += '<h4>Users</h4>';
  h += '<p>Users submit as themselves: on these pages logged in, and on the API with their own API token (<code>Authorization: Bearer fhs_...</code>, ' +
    'made on their account page). The document records who submitted it.</p>';
  h += `<form method="post" action="${purl}/settings" class="ips-form" style="max-width: 560px">${csrfField(ctx.csrf)}<input type="hidden" name="form" value="users"/>` +
    [['', 'No users (only the token, or anyone if there is none)'], ['any', 'Any logged in user'],
      ['approved', 'Approved users: those the server\'s administrator gives the IPS "Submit documents" role for this project (and the project\'s managers)']]
      .map(([v, label]) => `<label style="font-weight: normal; display: block"><input type="radio" name="users" value="${v}"${users === v ? ' checked' : ''}/> ${escape(label)}</label>`).join('') +
    '<p style="margin-top: 10px"><button type="submit" class="btn btn-primary">Save</button></p></form>';
  if (users === 'approved') {
    const approved = options.approved || [];
    h += approved.length === 0
      ? '<p><i>No users have been approved yet.</i></p>'
      : '<p>Approved: ' + approved.map(u => `${escape(u.name || u.login)} (<code>${escape(u.login)}</code>)`).join(', ') + '</p>';
    h += '<p class="ips-small">The server\'s administrator approves users on <a href="/auth/admin/users">the users page</a> (the user\'s page, <i>Submit documents</i> for this project).</p>';
  }
  h += aiSettingsHtml(project, ctx, options);
  h += '<h3>Managers</h3>';
  const managers = project.managers || [];
  h += managers.length === 0
    ? '<p><i>No users manage this project</i> (the administrator does).</p>'
    : '<p>' + managers.map(m => `${escape(m.name)} (<code>${escape(m.login)}</code>)`).join(', ') + '</p>';
  return h;
}

/** The AI assessment part of the settings page. */
function aiSettingsHtml(project, ctx, options) {
  const purl = projectUrl(ctx, project);
  const ai = options.ai || {};
  const { PROVIDERS } = require('./ai-client');
  let h = '<h3>AI assessment</h3>';
  h += '<p>When it is on, every document is sent, after the other processing, to an AI service to be graded for consistency and for its terminology ' +
    '(the document as JSON, with the narrative as the sender wrote it or with none). This sends the document to a third party: turn it on only for a project whose documents may go there. ' +
    (options.serverDefault ? `This server has a default account (${escape(options.serverModel || '')}), which a project without its own uses. ` : 'This server has no default account: a project needs its own. ') +
    `Each project may make ${escape(String(options.dailyCap))} assessments a day unless its cap says otherwise.</p>`;
  if (options.usage) {
    const u = options.usage;
    const row = (label, x) => `<tr><td>${label}</td><td>${tokens(x.calls)}</td><td>${tokens(x.input)}</td><td>${tokens(x.output)}</td>` +
      `<td>${x.costed > 0 ? escape(usd(x.cost)) + (x.costed < x.calls ? ` <small>(${tokens(x.calls - x.costed)} call${x.calls - x.costed === 1 ? '' : 's'} with no known cost)</small>` : '') : (x.calls > 0 ? '<small>not known</small>' : '')}</td></tr>`;
    h += '<table class="table table-sm ips-table" style="max-width: 640px"><tr><th>Usage</th><th>Assessments</th><th>Tokens in</th><th>Tokens out</th><th>Cost</th></tr>' +
      row('Today', u.day) + row('Last 30 days', u.month) + row('All time', u.all) + '</table>' +
      '<p class="ips-small">Cost is what the service reports (OpenRouter does), else from the price list in the server\'s configuration (<code>modules.ips.ai.prices</code>, USD per million tokens by model), else not known.</p>';
  }
  h += `<p>Currently: <b>${ai.enabled ? 'on' : 'off'}</b>` + (ai.keyEnc ? `, with the project's own account (${escape(PROVIDERS[ai.provider]?.name || ai.provider || '')}, model <code>${escape(ai.model || '')}</code>)` : (options.serverDefault ? ', using the server\'s default account' : ', with no account')) + '</p>';
  h += `<form method="post" action="${purl}/settings" class="ips-form" style="max-width: 560px">${csrfField(ctx.csrf)}<input type="hidden" name="form" value="ai"/>`;
  h += `<label><input type="checkbox" name="enabled" value="1"${ai.enabled ? ' checked' : ''}/> Assess documents with an AI service</label>`;
  h += '<label for="ai-provider">Provider</label><select id="ai-provider" name="provider">' +
    Object.entries(PROVIDERS).map(([k, v]) => `<option value="${k}"${(ai.provider || 'openai') === k ? ' selected' : ''}>${escape(v.name)}</option>`).join('') + '</select>';
  h += `<label for="ai-baseUrl">Base URL</label><input type="text" id="ai-baseUrl" name="baseUrl" value="${escape(ai.baseUrl || '')}" placeholder="leave blank for the provider's own"/>` +
    '<div class="ips-small">An OpenAI-compatible service (OpenRouter, LiteLLM, Groq, Ollama, ...) is its base URL, up to and including the version (e.g. https://openrouter.ai/api/v1)</div>';
  h += `<label for="ai-model">Model</label><input type="text" id="ai-model" name="model" value="${escape(ai.model || '')}"/>`;
  if (options.canKeep) {
    h += `<label for="ai-apiKey">API key</label><input type="password" id="ai-apiKey" name="apiKey" autocomplete="off" placeholder="${ai.keyEnc ? 'leave blank to keep the current key' : 'leave blank to use the server\'s default account'}"/>`;
    if (ai.keyEnc) {
      h += '<label><input type="checkbox" name="clearKey" value="1"/> Forget the project\'s key (use the server\'s default account)</label>';
    }
  } else {
    h += '<div class="ips-small">This server cannot keep a key for the project (no aiKeySecret is configured): the server\'s default account is used.</div>';
  }
  const narrative = typeof ai.sendNarrative === 'boolean' ? (ai.sendNarrative ? 'send' : 'strip') : 'default';
  h += '<label for="ai-narrative">Narrative</label><select id="ai-narrative" name="narrative">' +
    `<option value="default"${narrative === 'default' ? ' selected' : ''}>As the server does (${options.serverNarrative ? 'sent, as submitted' : 'not sent'})</option>` +
    `<option value="send"${narrative === 'send' ? ' selected' : ''}>Sent, as submitted - the model also reports what the narrative says that the data does not back up</option>` +
    `<option value="strip"${narrative === 'strip' ? ' selected' : ''}>Not sent - the structured data only (smaller, cheaper)</option></select>`;
  h += `<label for="ai-dailyCap">Daily cap</label><input type="text" id="ai-dailyCap" name="dailyCap" value="${Number.isInteger(ai.dailyCap) ? ai.dailyCap : ''}" placeholder="${escape(String(options.dailyCap))}" style="width: 8em"/>`;
  h += '<p style="margin-top: 10px"><button type="submit" class="btn btn-primary">Save</button></p></form>';
  return h;
}

// ---- a document ------------------------------------------------------------------------

/**
 * The narrative of a resource, if there is one and it is clean, as the browser will see it.
 *
 * The check (at submission, and again here) parses each narrative on its own. What is sent
 * is the parsed tree serialised again - never the string as written - because an
 * unterminated tag at the end of one narrative, which the parser drops, would otherwise
 * swallow the start of the next one on the page and could turn its text into attributes of
 * a live element. Serialising closes what was left open, and each narrative is wrapped in
 * its own div.
 */
function narrativeOf(res, level) {
  const div = res?.text?.div;
  if (typeof div !== 'string' || div.trim() === '') {
    return null;
  }
  if (checkNarrative(div)) {
    return '<p class="ips-small"><i>(narrative not shown: it contains active content)</i></p>';
  }
  return `<div class="ips-narrative-text">${parse5.serialize(seatHeadings(parse5.parseFragment(div), level))}</div>`;
}

/**
 * Sit a narrative's headings at the depth the page shows it at: shift them all by the same
 * amount, so that the narrative's top heading is at `level` and its structure is kept.
 * Narrative arrives with whatever heading levels its author (or the presenter) chose, and
 * none of them know that the page is titled with an h2 - an h1 or h2 in a narrative breaks
 * the page's heading structure (WCAG 1.3.1). Levels that would go past h6 stay at h6.
 *
 * @param {Object} fragment - a parse5 fragment, changed in place
 * @param {number} level - the level the narrative's top heading should be at
 * @returns {Object} the fragment
 */
function seatHeadings(fragment, level) {
  const headings = [];
  const walk = (node) => {
    for (const c of node.childNodes || []) {
      if (/^h[1-6]$/.test(c.nodeName)) {
        headings.push(c);
      }
      walk(c);
    }
  };
  walk(fragment);
  if (headings.length === 0) {
    return fragment;
  }
  const shift = level - Math.min(...headings.map(h => Number(h.nodeName[1])));
  for (const h of headings) {
    const name = `h${Math.max(1, Math.min(6, Number(h.nodeName[1]) + shift))}`;
    h.nodeName = name;
    h.tagName = name;
  }
  return fragment;
}

// The page's title is the template's h2; within the narrative view the document title is an
// h3, its sections h4, their sections h5, and so on (down to h6)
function sectionsHtml(sections, level) {
  let h = '';
  for (const s of Array.isArray(sections) ? sections : []) {
    if (!isObject(s)) {
      continue;
    }
    const tag = `h${Math.min(level, 6)}`;
    h += `<${tag}>${escape(text(s.title) || text(s.code?.text) || '')}</${tag}>`;
    const n = narrativeOf(s, Math.min(level + 1, 6));
    if (n) {
      h += n;
    } else if (!s.section) {
      h += '<p class="ips-small"><i>(no narrative)</i></p>';
    }
    h += sectionsHtml(s.section, level + 1);
  }
  return h;
}

/**
 * The document's assembled narrative: the Composition's own, then each section's, with
 * the section titles.
 */
function assembledNarrative(bundle) {
  const comp = Array.isArray(bundle?.entry) ? bundle.entry[0]?.resource : null;
  if (!isObject(comp) || comp.resourceType !== 'Composition') {
    return '<p><i>The document has no Composition.</i></p>';
  }
  let h = '<div class="ips-narrative">';
  if (text(comp.title)) {
    h += `<h3>${escape(comp.title)}</h3>`;
  }
  h += narrativeOf(comp, 4) || '';
  h += sectionsHtml(comp.section, 4);
  return h + '</div>';
}

// ---- the structure view ----

/** A node's details: what it is, when, and a note (contained, shown at...). */
function nodeDetails(node) {
  return [node.what, node.when ? `<span class="ips-tt-when">${node.when}</span>` : '', node.note ? `<i>(${escape(node.note)})</i>` : '']
    .filter(Boolean).join(' ');
}

/**
 * The logical structure of a document (structure.js), as a tree table like the FHIR
 * specification's. Columns: the path (where the reference is), the type, the id, and what
 * the resource is and when. A reference that doesn't resolve in the document is shown as
 * external; a resource expanded elsewhere is shown again, greyed, saying where, and doesn't expand.
 */
function renderStructure(bundle) {
  const top = structureTree(bundle);
  if (!top) {
    return '<p><i>The document has no Composition.</i></p>';
  }

  // the rows: the lines are drawn as the cell's background, so they carry on through rows
  // that wrap; each level is UNIT px in, and the line to a node's children runs down from
  // the middle of its icon
  const UNIT = 20;
  const LINE = '#adb5bd';
  let rows = '';
  let next = 0;
  function walk(node, depth, parentId, lines, last, hidden) {
    const id = next++;
    const bg = [];
    lines.forEach((on, k) => {
      if (on) {
        bg.push([UNIT * k + 10, 0, '1px', '100%']);
      }
    });
    if (depth > 0) {
      const x = UNIT * (depth - 1) + 10;
      bg.push([x, 0, '1px', last ? '12px' : '100%']);
      bg.push([x, 12, `${UNIT - 8}px`, '1px']);
    }
    const lineStyle = bg.length === 0 ? '' :
      `background-image: ${bg.map(() => `linear-gradient(${LINE}, ${LINE})`).join(', ')}; ` +
      `background-position: ${bg.map(b => `${b[0]}px ${b[1]}px`).join(', ')}; ` +
      `background-size: ${bg.map(b => `${b[2]} ${b[3]}`).join(', ')}; background-repeat: no-repeat; `;
    const style = ` style="${lineStyle}padding-left: ${UNIT * depth + 2}px; --ips-tt-down: ${UNIT * depth + 10}px"`;
    const kids = node.children.length > 0;
    const closed = kids && !node.open;
    const cls = [node.kind === 'missing' ? 'ips-tt-missing' : node.kind === 'seen' ? 'ips-tt-seen' : '', kids ? 'ips-tt-parent' : '', closed ? 'ips-tt-closed' : ''].filter(Boolean).join(' ');
    const toggle = kids && depth > 0 ?
      `<button type="button" class="ips-tt-toggle" style="left: ${UNIT * (depth - 1) + 5}px" aria-label="Show or hide what ${escape(node.path)} refers to"></button>` : '';
    const idCell = node.id ? escape(node.id) : (node.kind === 'missing' ? `<code>${escape(node.ref)}</code>` : '');
    const idTitle = node.ref ? ` title="${escape(`Reference: ${node.ref}`)}"` : '';
    const details = nodeDetails(node);
    rows += `<tr data-tt-id="${id}"` + (parentId === null ? '' : ` data-tt-parent="${parentId}"`) + (cls ? ` class="${cls}"` : '') + (hidden ? ' hidden' : '') + '>' +
      `<td class="ips-tt-path"${style}>${toggle}<img src="/assets/images/icon_${node.icon}.png" alt="" width="16" height="16"/> ${escape(node.path)}</td>` +
      `<td>${escape(node.type)}</td><td${idTitle}>${idCell}</td><td>${details}</td></tr>`;
    node.children.forEach((c, i) => {
      const lastChild = i === node.children.length - 1;
      walk(c, depth + 1, id, depth === 0 ? [] : [...lines, !last], lastChild, hidden || closed);
    });
  }
  walk(top, 0, null, [], true, false);

  let h = '<div class="ips-tree-tools"><button type="button" class="btn btn-default ips-tt-all" data-open="1">Expand all</button> ' +
    '<button type="button" class="btn btn-default ips-tt-all" data-open="">Collapse all</button></div>';
  h += '<noscript><style>.ips-tt tr[hidden] { display: table-row; } .ips-tt-toggle, .ips-tree-tools { display: none; }</style></noscript>';
  h += '<table class="table table-condensed ips-tt"><thead><tr><th>Path</th><th>Type</th><th>Id</th><th>Details</th></tr></thead><tbody>' + rows + '</tbody></table>';
  h += `<script>
(function () {
  var rows = Array.prototype.slice.call(document.querySelectorAll('.ips-tt tbody tr'));
  var byId = {};
  rows.forEach(function (r) { byId[r.getAttribute('data-tt-id')] = r; });
  // a row shows when its parent shows and is open (rows come parents first)
  function refresh() {
    rows.forEach(function (r) {
      var p = byId[r.getAttribute('data-tt-parent')];
      r.hidden = !!p && (p.hidden || p.classList.contains('ips-tt-closed'));
    });
  }
  document.querySelectorAll('.ips-tt-toggle').forEach(function (b) {
    b.addEventListener('click', function () { b.closest('tr').classList.toggle('ips-tt-closed'); refresh(); });
  });
  document.querySelectorAll('.ips-tt-all').forEach(function (b) {
    b.addEventListener('click', function () {
      var open = !!b.getAttribute('data-open');
      rows.forEach(function (r) { if (r.getAttribute('data-tt-parent') !== null && r.classList.contains('ips-tt-parent')) { r.classList.toggle('ips-tt-closed', !open); } });
      refresh();
    });
  });
})();
</script>`;
  return h;
}

// ---- the analysis view ----

/** One finding, as a list item. */
function findingHtml(f) {
  if (f.url) {
    const what = f.kind === 'modifier' ? 'Modifier extension' : 'Extension';
    // known or not; the definition is on hover
    const def = f.found ? [text(f.title), text(f.description)].filter(Boolean).join(': ') || 'The definition says nothing about it' : '';
    const known = f.found ? `<span class="ips-an-known" title="${escape(def)}">known</span>` : '<i>not known</i>';
    return `<li class="ips-an-${escape(f.kind)}">${what} <code>${escape(f.url)}</code> on <code>${escape(f.path)}</code>: ${known}</li>`;
  }
  return `<li class="ips-an-${escape(f.kind)}">${escape(f.text)}</li>`;
}

/**
 * Whether the analysis found nothing to say about a node: All OK, and nothing else but the
 * narrative - which doesn't matter for a resource, but a section without narrative is a problem -
 * and the Composition's negation (unless there's more than one approach: that's attention).
 */
function analysisOk(findings, isSection) {
  if (!Array.isArray(findings) || findings.length === 0) {
    return false;
  }
  // nothing that needs looking at: All OK, how negation is done, narrative (but a section
  // needs some), and extensions the validator knows - an unknown or modifier extension is a problem
  return findings.every(f => f && (f.kind === 'ok' || f.kind === 'negation' || (f.kind === 'extension' && f.found) ||
    (f.kind === 'narrative' && !(isSection && f.text === 'No narrative'))));
}

/**
 * The analysis view: the document's structure (structure.js) as a flat table - each node's
 * row as in the structure view, with its full path - and under each resource and section a
 * row with what the analysis step found (analysis.js).
 */
function renderAnalysis(row, options = {}) {
  const sigs = renderSignatures(row);
  const r = row.results?.analysis;
  if (!r || (r.result.status && r.result.status !== 'done') || !isObject(r.result.items)) {
    return sigs + noResultNote(row, 'analysis', 'There is no analysis of this document', options);
  }
  return sigs + renderAnalysisTable(row, r);
}

const SIGNATURE_LABELS = { error: 'Error', warning: 'Warning', information: 'Information' };

/**
 * What the signatures step found (pipeline.js, signatures.js), for the top of the analysis
 * view: each outcome with its severity (as a word, and coloured), the key it is about, and
 * what it says. Nothing for a document processed before the step existed, or not yet
 */
function renderSignatures(row) {
  const r = row.results?.signatures;
  if (!r || (r.result.status && r.result.status !== 'done') || !Array.isArray(r.result.outcomes)) {
    return '';
  }
  // a key id links to the key store's page for it, when there is one
  const keysListed = require('../library/keystore').initialized;
  const items = r.result.outcomes.map(o => {
    const sev = SIGNATURE_LABELS[o.status] ? o.status : 'error';
    return `<li><span class="ips-badge" style="background-color: ${SEVERITY_COLOURS[sev]}">${SIGNATURE_LABELS[sev]}</span> ` +
      (o.keyId ? (keysListed ? `<a href="/keys/key/${encodeURIComponent(o.keyId)}"><code>${escape(o.keyId)}</code></a>: ` : `<code>${escape(o.keyId)}</code>: `) : '') +
      `${escape(o.description)}</li>`;
  }).join('');
  return `<div class="ips-signatures"><h4>Signatures</h4><ul class="ips-signature-outcomes">${items || '<li><i>The signature check said nothing</i></li>'}</ul></div>`;
}

/** The analysis table (renderAnalysis), from the analysis step's result */
function renderAnalysisTable(row, r) {
  const top = structureTree(row.bundle);
  if (!top) {
    return '<p><i>The document has no Composition.</i></p>';
  }
  const items = r.result.items;
  let rows = '';
  let total = 0;
  let quiet = 0;
  const nationality = row.results?.nationality?.result || null;
  let nationShown = false;
  for (const [node] of flatten(top)) {
    // a reference to something not in the document has no rows: there's nothing to analyse
    if (node.kind === 'missing') {
      continue;
    }
    const cls = node.kind === 'seen' ? ' ips-tt-seen' : '';
    const idCell = node.id ? escape(node.id) : '';
    const idTitle = node.ref ? ` title="${escape(`Reference: ${node.ref}`)}"` : '';
    // nothing to say (or analysed elsewhere): hidden by "Only show problems"
    const ok = node.kind === 'seen' || analysisOk(items[node.key], String(node.key || '').startsWith('s:'));
    const okAttr = ok ? ' data-ok="1"' : '';
    total++;
    if (ok) {
      quiet++;
    }
    rows += `<tr class="ips-an-node${cls}"${okAttr}><td class="ips-an-path"><img src="/assets/images/icon_${node.icon}.png" alt="" width="16" height="16"/> ${escape(node.fullPath)}</td>` +
      `<td>${escape(node.type)}</td><td${idTitle}>${idCell}</td><td>${nodeDetails(node)}</td></tr>`;
    let body;
    if (node.kind === 'seen') {
      body = `<i>Analysed at ${escape(node.shownAt)}</i>`;
    } else if (Array.isArray(items[node.key])) {
      // the Composition's first bullet: which nation the document is from, and why
      const nation = node.type === 'Composition' && !nationShown && nationality ? `<li class="ips-an-nation">${escape(nationalityText(nationality))}</li>` : '';
      if (node.type === 'Composition') {
        nationShown = true;
      }
      body = `<ul>${nation}${items[node.key].map(findingHtml).join('')}</ul>`;
    } else {
      body = '<i>Not analysed</i>';
    }
    rows += `<tr class="ips-an-findings${cls}"${okAttr}><td colspan="4">${body}</td></tr>`;
  }
  let h = `<p class="ips-small">Analysed ${escape(r.made)}` + (typeof r.result.ms === 'number' ? ` in ${escape(String(r.result.ms))} ms` : '') + '</p>';
  // the choice is remembered in the browser (localStorage); without script, everything shows
  h += '<style>.ips-an.ips-an-problems tr[data-ok] { display: none; }</style>';
  h += '<div class="ips-filter mb-2 ips-an-filter" hidden><label><input type="checkbox" id="ips-an-problems"/> Only show problems</label> ' +
    `<span class="ips-small ips-an-count" hidden>Showing ${total - quiet} of ${total}</span></div>`;
  h += '<table class="table table-condensed ips-an"><thead><tr><th>Path</th><th>Type</th><th>Id</th><th>Details</th></tr></thead><tbody>' + rows + '</tbody></table>';
  h += '<div class="ips-explain"><p class="ips-small">What the analysis step found in each resource of the document as submitted, in the order of the structure view, and in the Composition section by section (the Composition\'s first bullet is which jurisdiction the document is from, and why - the jurisdiction step): ' +
    'extensions (with their definitions, from the validator, where it knows them; textLink is left out), <span class="ips-an-modifier">modifier extensions and implicitRules</span>, ' +
    '<span class="ips-an-status">records that are inactive, entered in error, of unknown status, or missing a status they should have</span>, ' +
    '<span class="ips-an-subject">a subject that is not the document\'s, or a focus</span>, ' +
    '<span class="ips-an-attention">dates in the future where none is expected (not period ends, expiry or due dates, schedules, nor appointments, requests and plans that are not over, or events still to come), values given as an extension instead (a data-absent-reason, say), a Patient\'s links, a Composition that is not final, and a document that uses more than one approach to negation</span>, ' +
    'a section\'s emptyReason or an author other than its container\'s, whether there is narrative, and - on the Composition - how the document says there is nothing to report (negation): with a section\'s emptyReason (the IPS pattern), with entries whose code says so, like No known allergy (the US Core pattern), or not at all; and <span class="ips-an-error">SNOMED CT codes that do not say which edition they are from, when the jurisdiction of the document is unknown (the International Edition is assumed)</span>. A resource with nothing else to say is All OK. References to resources that are not in the document are left out. ' +
    'An extension is known when the validator has its definition (hover over "known" to see it). Only show problems hides what is All OK, or has nothing more to say than known extensions - an unknown extension, or a modifier extension, is a problem; and, for a resource, whether it has narrative doesn\'t matter, but a section without narrative is a problem.</p></div>';
  h += `<script>
(function () {
  var KEY = 'fhirsmith.ips.analysis.problemsOnly';
  var box = document.getElementById('ips-an-problems');
  var table = document.querySelector('.ips-an');
  var count = document.querySelector('.ips-an-count');
  if (!box || !table) { return; }
  box.closest('.ips-an-filter').hidden = false;
  function apply() {
    table.classList.toggle('ips-an-problems', box.checked);
    count.hidden = !box.checked;
  }
  try { box.checked = window.localStorage.getItem(KEY) === '1'; } catch (e) { /* no storage: unchecked */ }
  apply();
  box.addEventListener('change', function () {
    try { window.localStorage.setItem(KEY, box.checked ? '1' : '0'); } catch (e) { /* not remembered */ }
    apply();
  });
})();
</script>`;
  return h;
}

// ---- the terminology view ----

/** Text, as a link when there is somewhere to go. */
function linked(label, href, title) {
  const t = title ? ` title="${escape(title)}"` : '';
  return href ? `<a href="${escape(href)}"${t}>${label}</a>` : `<span${t}>${label}</span>`;
}

/**
 * The contents of a CodeableConcept: its text, and each coding as system, code, display,
 * arranged as the Java DataRenderer does: the system by name with the version described
 * after it in brackets - for SNOMED CT, the edition and release ("SNOMED CT [US rel. Mar
 * 2024]"), with the edition's full name on hover - and the URL on hover. The external code
 * systems (SNOMED CT, LOINC, RxNorm, ...) link to their own browsers, name and code; any
 * other system links to the code system on the terminology server.
 *
 * @param {Object} cc
 * @param {Function|null} codeSystemLink - system URL -> href on the tx server, or null for no server
 */
function conceptHtml(cc, codeSystemLink) {
  const items = [];
  if (text(cc.text)) {
    items.push(`<li>Text: ${escape(cc.text)}</li>`);
  }
  for (const c of Array.isArray(cc.coding) ? cc.coding : []) {
    if (!isObject(c)) {
      continue;
    }
    const parts = [codingHtml(c, codeSystemLink)];
    // a coding the translate step added (in the analysed copy)
    const tr = translationOf(c);
    if (tr) {
      const detail = [`translated by ${tr.server || 'the terminology server'}`, tr.conceptMap ? `with ${tr.conceptMap}` : '', tr.relationship ? `(${tr.relationship})` : ''].filter(Boolean).join(' ');
      parts.push(`<span class="ips-translated" title="${escape(detail)}">translated${tr.relationship ? `, ${escape(tr.relationship)}` : ''}</span>`);
    }
    items.push(`<li>${parts.join(' ')}</li>`);
  }
  if (items.length === 0) {
    return '<i>(empty)</i>';
  }
  return `<ul>${items.join('')}</ul>`;
}

/**
 * A coding, as the terminology view shows one: the code system by name (the URL on hover; an
 * external system links to its own browser, any other to the code system on the terminology
 * server), the version if there is one, the code (linked, for an external system), the display.
 *
 * @param {Object} c - {system, version, code, display}
 * @param {Function|null} codeSystemLink - system URL -> href on the tx server, or null for no server
 */
function codingHtml(c, codeSystemLink) {
  const sys = systemName(c.system);
  const parts = [];
  const external = isExternalSystem(c.system);
  if (sys) {
    const href = external ? linkForSystem(c.system) : (codeSystemLink ? codeSystemLink(c.system) : null);
    let h = linked(escape(sys), href, text(c.system));
    if (text(c.version)) {
      const v = describeVersion(c.version);
      h += ` <small>[${linked(escape(v.text), null, v.title ? `${v.title} (${c.version})` : c.version)}]</small>`;
    }
    parts.push(h);
  } else if (text(c.system)) {
    parts.push(escape(c.system));
  }
  const codeHref = external ? linkForCode(c.system, c.version, c.code) : null;
  parts.push(`<code>${linked(escape(text(c.code)), codeHref, null)}</code>`);
  if (text(c.display)) {
    parts.push(`"${escape(c.display)}"`);
  }
  return parts.join(' ');
}

/**
 * The analysis of a concept: the terminology check's verdict from the analysed copy - a
 * green tick (a coding is in an IPS value set), a red cross (none is), or an orange question
 * mark (the server could not say) - with the detail on hover; nothing for an element the
 * IPS doesn't bind, or a document not yet analysed.
 */
function analysisHtml(concept, analysed) {
  // verdicts come from the analysed copy only: the master is the submitter's, extensions
  // and all
  const check = analysed ? checkOf(concept) : null;
  if (!check) {
    return '';
  }
  const symbol = { in: '&#10003;', international: '&#9888;', 'not-in': '&#10007;', unknown: '?' }[check.result];
  const name = (url) => url.substring(url.lastIndexOf('/') + 1);
  const title = [check.message, check.valueSet ? `Value set: ${check.valueSet}` : '', check.system ? `Code system: ${check.system}` : ''].filter(Boolean).join('\n');
  return `<span class="ips-check ips-check-${check.result}" title="${escape(title)}">${symbol}</span>` +
    (check.valueSet ? ` <span class="ips-small">${escape(name(check.valueSet))}</span>` : check.system ? ` <span class="ips-small">${escape(name(check.system))}</span>` : '');
}

function conceptRowFor(c, codeSystemLink, analysed) {
  return `<tr><td><code>${escape(c.path)}</code></td><td>${conceptHtml(c.concept, codeSystemLink)}</td><td>${analysisHtml(c.concept, analysed)}</td>` +
    `<td><button type="button" class="btn btn-default ips-copy" data-json="${escape(JSON.stringify(c.concept))}">Copy</button></td></tr>`;
}

/**
 * The terminology view: every CodeableConcept in the document, by section and resource.
 * @param {Object} bundle
 * @param {{codeSystemLink?: Function|null}} [ctx]
 */
function renderTerminology(bundle, ctx = {}) {
  const t = terminologyOf(bundle);
  const link = ctx.codeSystemLink || null;
  const conceptRow = (c) => conceptRowFor(c, link, !!ctx.analysed);
  // "problems only": just the concepts whose check found something wrong (not in a value
  // set, or undeterminable); the rest, and the section and resource headings left with
  // nothing under them, are hidden
  const problemsOnly = !!ctx.problemsOnly && !!ctx.analysed;
  const isProblem = (c) => {
    const check = checkOf(c.concept);
    return !!check && check.result !== 'in';
  };
  const shown = (concepts) => (problemsOnly ? concepts.filter(isProblem) : concepts);
  let total = t.composition.length;
  let kept = shown(t.composition).length;
  for (const s of t.sections) {
    for (const e of s.entries) {
      total += e.concepts.length;
      kept += shown(e.concepts).length;
    }
  }
  // the explanation goes at the bottom of the page; the filter stays at the top
  const explanation = '<p class="ips-small">Every CodeableConcept in the document: the Composition\'s own, then each section\'s entries, ' +
    'sections in the IPS order. Section codes, categories, and the clinical and verification status of conditions and allergies are left out. ' +
    'Analysis: whether any coding is in the value set this server holds the element to for international exchange - ' +
    '<span class="ips-check ips-check-in">&#10003;</span> yes (or, for an element with no value set of its own, the coding is international anyway); ' +
    '<span class="ips-check ips-check-international">&#9888;</span> no, but a coding is international (SNOMED CT International, LOINC, or an HL7 terminology); ' +
    '<span class="ips-check ips-check-not-in">&#10007;</span> no coding is; ' +
    '<span class="ips-check ips-check-unknown">?</span> the terminology server could not say' +
    (ctx.analysed ? '' : '; blank until the document has been processed') + '. The value set, or the code system, is named beside the mark, in full on hover. ' +
    'A coding marked <span class="ips-translated">translated</span> was added by this server, translating the concept into the value set; the server, concept map and relationship are on hover.</p>';
  let h = '';
  if (ctx.analysed) {
    h += `<form method="get" action="${escape(ctx.docUrl || '')}" class="ips-filter mb-2"><input type="hidden" name="view" value="terminology"/>` +
      `<label><input type="checkbox" name="problems" value="1"${problemsOnly ? ' checked' : ''} onchange="this.form.submit()"/> Only concepts with a problem</label>` +
      '<noscript><button type="submit" class="btn btn-default ips-btn">Apply</button></noscript>' +
      (problemsOnly ? `<span class="ips-small">Showing ${kept} of ${total} concepts</span>` : '') + '</form>';
  }
  h += '<table class="table table-sm table-bordered ips-table ips-term"><tr><th style="width: 30%">Element</th><th>Contents</th><th style="width: 25%">Analysis</th><th></th></tr>';
  const compositionRows = shown(t.composition);
  if (!problemsOnly || compositionRows.length > 0) {
    h += '<tr><th colspan="4" class="ips-section">Composition</th></tr>';
    h += t.composition.length === 0 ? '<tr><td colspan="4"><i>No CodeableConcepts</i></td></tr>' : compositionRows.map(conceptRow).join('');
  }
  for (const s of t.sections) {
    const entries = problemsOnly ? s.entries.filter(e => shown(e.concepts).length > 0) : s.entries;
    if (problemsOnly && entries.length === 0) {
      continue;
    }
    h += `<tr><th colspan="4" class="ips-section">${escape(s.title)}${s.known ? '' : ' <small>(not an IPS section)</small>'}</th></tr>`;
    if (s.entries.length === 0) {
      h += '<tr><td colspan="4"><i>No entries</i></td></tr>';
    }
    for (const e of entries) {
      h += `<tr><th colspan="4" class="ips-resource">${escape(e.label)}${e.resolved ? '' : ' - <b>not found in the document</b>'}</th></tr>`;
      if (e.resolved && e.concepts.length === 0) {
        h += '<tr><td colspan="4"><i>No CodeableConcepts</i></td></tr>';
      }
      h += shown(e.concepts).map(conceptRow).join('');
    }
  }
  if (problemsOnly && kept === 0) {
    h += '<tr><td colspan="4"><i>No problems: every checked concept is in a value set the IPS prefers.</i></td></tr>';
  }
  h += '</table>';
  h += `<div class="ips-explain">${explanation}</div>`;
  h += `<script>
document.querySelectorAll('.ips-copy').forEach(function (b) {
  b.addEventListener('click', function () {
    var json = JSON.stringify(JSON.parse(b.getAttribute('data-json')), null, 2);
    var done = function () { var t = b.textContent; b.textContent = 'Copied'; setTimeout(function () { b.textContent = t; }, 1200); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(json).then(done, function () { window.prompt('Copy the JSON:', json); });
    } else {
      window.prompt('Copy the JSON:', json);
    }
  });
});
</script>`;
  return h;
}

// ---- the validation view ----

// badge colours carry white text: each is at least 4.5:1 against it (WCAG 1.4.3)
const SEVERITY_COLOURS = { fatal: '#c82333', error: '#c82333', warning: '#8a6100', information: '#117a8b' };

/** Where an issue is: its expression (FHIRPath), else its location. */
function issueWhere(i) {
  const e = Array.isArray(i.expression) ? i.expression.filter(x => typeof x === 'string') : [];
  if (e.length > 0) {
    return e;
  }
  return Array.isArray(i.location) ? i.location.filter(x => typeof x === 'string') : [];
}

/** The validator's message for an issue: details.text, else diagnostics. */
function issueMessage(i) {
  return text(i.details?.text) || text(i.diagnostics) || '';
}

// the minimum severity the validation view shows, and how it is said
const LEVELS = [
  ['information', 'Everything'],
  ['warning', 'Warnings and errors'],
  ['error', 'Errors only']
];
const SEVERITY_RANK = { fatal: 3, error: 2, warning: 1, information: 0 };

/**
 * Why a step has no result to show: the document is still queued, or this step failed (its
 * reason, for managers), or an earlier step failed so it never ran, or it was never run.
 */
function noResultNote(row, step, what, options = {}) {
  if (row.status === 'submitted' || row.status === 'processing') {
    return `<p><i>${what} - the document is ${escape(row.status === 'processing' ? 'being processed' : 'waiting in the queue')}.</i></p>`;
  }
  const r = row.results?.[step]?.result;
  if (r?.status === 'failed') {
    return `<p><i>The ${escape(step)} step failed${options.canManage && r.message ? `: ${escape(r.message)}` : ' (the reason is shown to the project\'s managers)'}.</i></p>`;
  }
  if (r?.status === 'waiting') {
    return `<p><i>The ${escape(step)} step did not run: an earlier step failed${options.canManage && row.status_message ? ` (${escape(row.status_message)})` : ''}.</i></p>`;
  }
  return `<p><i>${what}${row.status === 'error' ? ' - processing failed' + (options.canManage && row.status_message ? `: ${escape(row.status_message)}` : '') : ''}.</i></p>`;
}

// a clinical profile's outcome on the page: [label, colour]
const PROFILE_OUTCOMES = {
  conforms: ['Conforms', '#1e7e34'],
  fails: ['Does not conform', '#c82333'],
  unknown: ['Could not be fully checked', '#8a6100']
};

/**
 * The profiles step's result: for each clinical profile, whether the document conforms,
 * and the descriptions of the constraints it doesn't meet.
 */
function renderProfileChecks(row, options = {}) {
  const r = row.results?.profiles?.result;
  if (!r || (r.status && r.status !== 'done') || !Array.isArray(r.profiles)) {
    return noResultNote(row, 'profiles', 'The document has not been checked against the clinical profiles', options);
  }
  const base = escape(options.base || '');
  let h = '';
  if (!r.profiles.length) {
    return `<p>There were no <a href="${base}/StructureDefinition">clinical profiles</a> to check the document against when it was processed.</p>`;
  }
  h += '<table class="table table-sm ips-table"><tr><th>Clinical profile</th><th>Outcome</th><th>Constraints not met</th></tr>';
  for (const p of r.profiles) {
    const [label, colour] = PROFILE_OUTCOMES[p.outcome] || [p.outcome, '#6c757d'];
    const failed = (p.failed || []).map(f => {
      const why = f.reason === 'unresolved' ? ' <span class="ips-small">(could not be checked: a value set the terminology server could not answer for' +
        (options.canManage && f.message ? ` - ${escape(f.message)}` : '') + ')</span>'
        : (f.reason === 'error' ? ` <span class="ips-small">(could not be evaluated${options.canManage && f.message ? `: ${escape(f.message)}` : ''})</span>` : '');
      return `<li>${escape(f.human)}${why}</li>`;
    }).join('');
    h += `<tr><td><a href="${base}/StructureDefinition/${escape(p.id)}">${escape(p.title)}</a></td>` +
      `<td><span class="ips-badge" style="background: ${colour}">${escape(label)}</span></td>` +
      `<td>${failed ? `<ul style="margin: 0; padding-left: 18px">${failed}</ul>` : '<span class="ips-small">(none)</span>'}</td></tr>`;
  }
  h += '</table>';
  h += `<p class="ips-small">Checked against the clinical profiles as they were when the document was processed (${r.profiles.length} profile${r.profiles.length === 1 ? '' : 's'}` +
    (r.questions ? `, ${r.questions} value set question${r.questions === 1 ? '' : 's'} to the terminology server` : '') +
    `, ${escape(String(r.ms))} ms); reprocess the document to check it against them as they are now.</p>`;
  return h;
}

// what the translate step's outcomes mean on the page: [label, colour]
const TRANSLATION_OUTCOMES = {
  translated: ['Translated', '#1e7e34'],
  'no-translation': ['No translation', '#c82333'],
  failed: ['Failed', '#c82333'],
  'not-needed': ['Not needed', '#6c757d'],
  'not-checked': ['Not checked', '#a35200'],
  'no-codings': ['No codings', '#6c757d']
};

/** A coding, briefly: system|code "display". */
function briefCoding(c) {
  // the version too (for SNOMED CT, the edition): the same code in two editions is two codings
  const v = describeVersion(c.version);
  const ver = v.text ? ` <small title="${escape(v.title ? `${v.title} (${c.version})` : c.version)}">[${escape(v.text)}]</small>` : '';
  return `<code>${escape(`${systemName(c.system) || c.system || ''}|${c.code}`)}</code>${ver}` + (typeof c.display === 'string' && c.display ? ` "${escape(c.display)}"` : '');
}

/**
 * The translation view: what the translate step did with each CodeableConcept - left it
 * (already in its value set, or the check could not say), translated it (the codings that
 * came back, with their concept maps and relationships), or found no translation.
 * @param {Object} row - from store.read(), with .results.translate or not
 */
function renderTranslation(row, options = {}) {
  const r = row.results?.translate;
  if (!r || (r.result.status && r.result.status !== 'done') || !Array.isArray(r.result.entries)) {
    return noResultNote(row, 'translate', 'There is no translation record for this document', options);
  }
  const v = r.result;
  const counts = v.counts || {};
  let h = `<p class="ips-small">Translated ${escape(r.made)}` + (v.server ? ` with ${escape(String(v.server))}` : '') +
    (typeof v.ms === 'number' ? ` in ${escape(String(v.ms))} ms` : '') + '</p>';
  h += `<p><b>${escape(`${counts.translated || 0} of ${counts.tried || 0} concepts translated (${counts.codings || 0} codings added)`)}` +
    (counts.failed ? escape(`, ${counts.failed} failed`) : '') + '</b></p>';
  if (v.defaultEdition && v.defaultEdition.edition) {
    const d = v.defaultEdition;
    h += `<p class="ips-small">SNOMED CT codes with no version were translated as codes of the ${editionHtml(d.edition)} - the SNOMED CT edition of the national profile ` +
      `<code>${escape(`${d.packageId}#${d.version}`)}</code>, for ${escape(d.jurisdiction)}, the jurisdiction the document is from.</p>`;
  }
  h += '<table class="table table-sm table-striped ips-table"><tr><th>Element</th><th>Codings</th><th>Value set</th><th>Outcome</th><th>Detail</th></tr>';
  for (const e of v.entries) {
    const [label, colour] = TRANSLATION_OUTCOMES[e.outcome] || [e.outcome || '?', '#6c757d'];
    const codings = (Array.isArray(e.codings) ? e.codings : []).map(c => `<li>${briefCoding(c)}</li>`);
    if (e.text) {
      codings.unshift(`<li>Text: ${escape(e.text)}</li>`);
    }
    let detail = e.message ? escape(e.message) : '';
    if (Array.isArray(e.added) && e.added.length > 0) {
      detail += '<ul>' + e.added.map(m => `<li>${briefCoding(m.coding)}` + (m.relationship ? ` <i>${escape(m.relationship)}</i>` : '') +
        (m.conceptMap ? ` from <code>${escape(m.conceptMap)}</code>` : '') + (m.present ? ' (already in the concept)' : '') + '</li>').join('') + '</ul>';
    }
    h += `<tr><td><code>${escape(e.path || '')}</code></td><td>${codings.length ? `<ul>${codings.join('')}</ul>` : '<i>(empty)</i>'}</td>` +
      `<td><span title="${escape(e.target || '')}">${escape(e.target ? e.target.substring(e.target.lastIndexOf('/') + 1) : '')}</span>${e.ownValueSet ? '' : ' <small>(fallback)</small>'}</td>` +
      `<td><span class="ips-badge" style="background-color: ${colour}">${escape(label)}</span></td><td>${detail}</td></tr>`;
  }
  h += '</table>';
  h += '<div class="ips-explain"><p class="ips-small">What the translate step did with each CodeableConcept, before validation: a concept already in the value set this server holds its element to ' +
    '(or, with no value set of its own, already international) needs no translation; one the terminology server could not check is left alone; the rest are sent to the server to translate into the value set ' +
    '(<code>ConceptMap/$translate</code>), and the codings that come back are added to the concept in the analysed copy, with the concept map and relationship the server gave for each.</p></div>';
  return h;
}

/**
 * The generated narrative view: what the narrative step made of the document.
 * @param {Object} row - from store.read(), with .results.narrative or not
 */
function renderGenerated(row, options = {}) {
  const r = row.results?.narrative;
  if (!r || (r.result.status && r.result.status !== 'done') || typeof r.result.html !== 'string') {
    return noResultNote(row, 'narrative', 'There is no generated narrative for this document', options);
  }
  const v = r.result;
  let h = `<p class="ips-small">Generated ${escape(r.made)}` + (typeof v.ms === 'number' ? ` in ${escape(String(v.ms))} ms` : '') +
    (v.lookups ? `, with ${escape(String(v.lookups))} display lookup${v.lookups === 1 ? '' : 's'}` : '') + '</p>';
  // our own output, but checked and parsed and re-serialised like any narrative, never the string itself
  if (checkNarrative(v.html)) {
    return h + '<p><i>The generated narrative is not shown: it failed the active content check.</i></p>';
  }
  // the presenter's narrative is a document of its own (h1 title, h2 sections): seated under the page's h2
  h += `<div class="ips-narrative ips-generated">${parse5.serialize(seatHeadings(parse5.parseFragment(v.html), 3))}</div>`;
  h += '<div class="ips-explain"><p class="ips-small">The narrative this server generates for the document (the IPS presenter): the Composition\'s header and the patient, ' +
    'then the sections in the IPS order, each a table of its entries with the columns that suit the resource type (the ones no entry fills are left out) and the nested parts as bullets beneath. ' +
    'Coded values show their text, else a display, else what the terminology server knows, else --. It is also written into the analysed copy as the Composition\'s and the sections\' narrative, which is what the validator sees.</p></div>';
  return h;
}

const tokens = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : '?');
const usd = (n) => (n < 0.01 && n > 0 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);

const AI_SEVERITY_COLOURS = { high: '#c82333', medium: '#8a6100', low: '#117a8b' };
const GRADE_COLOURS = { A: '#1e7e34', B: '#4e7d0e', C: '#8a6100', D: '#a35200', F: '#c82333' };

/**
 * The AI assessment view: the grade, the summary, and the findings.
 * @param {Object} row - from store.read(), with .results.ai or not
 */
function renderAi(row, options = {}) {
  const r = row.results?.ai;
  if (!r || (r.result.status && r.result.status !== 'done')) {
    return noResultNote(row, 'ai', 'There is no AI assessment for this document', options);
  }
  const v = r.result;
  if (v.skipped) {
    return `<p><i>The document was not assessed: ${escape(v.skipped)}.</i></p>`;
  }
  let h = `<p class="ips-small">Assessed ${escape(r.made)} by ${escape(String(v.model || ''))} (${escape(String(v.provider || ''))}, the ${escape(String(v.account || ''))}'s account)` +
    (v.withNarrative ? ', with the narrative as submitted' : ', without the narrative') +
    (typeof v.ms === 'number' ? ` in ${escape(String(v.ms))} ms` : '') +
    (v.usage && (v.usage.input !== null || v.usage.output !== null) ? `; ${escape(tokens(v.usage.input))} tokens in, ${escape(tokens(v.usage.output))} out` : '') +
    (typeof v.cost === 'number' ? ` (${escape(usd(v.cost))})` : '') +
    (v.truncated ? '; <b>the answer was cut off at the token limit</b>' : '') +
    (typeof v.bytesSent === 'number' ? `; ${escape(v.bytesSent.toLocaleString('en-US'))} bytes sent` : '') +
    (v.attachmentsRemoved ? `, with ${escape(String(v.attachmentsRemoved))} attachment${v.attachmentsRemoved === 1 ? '' : 's'} replaced by a placeholder` : '') + '</p>';
  const a = v.assessment;
  if (!a) {
    h += '<p><b>The model did not answer with the expected JSON.</b>' +
      (v.truncated ? ` Its answer was cut off at the limit of ${escape(tokens(v.maxTokens))} tokens - raise <code>modules.ips.ai.maxTokens</code>.` : '') + ' Its answer:</p>';
    h += `<pre class="ips-json">${escape(String(v.raw || ''))}</pre>`;
    return h;
  }
  h += `<p><span class="ips-badge ips-grade" style="background-color: ${GRADE_COLOURS[a.grade] || '#6c757d'}">Grade ${escape(a.grade || '?')}</span> ${escape(a.summary || '')}</p>`;
  const sev = (x) => `<span class="ips-badge" style="background-color: ${AI_SEVERITY_COLOURS[x] || '#6c757d'}">${escape(x)}</span>`;
  h += '<h3>Consistency and integrity</h3>';
  if (a.consistency.length === 0) {
    h += '<p><i>No findings</i></p>';
  } else {
    h += '<table class="table table-sm table-striped ips-table"><tr><th>Severity</th><th>Finding</th><th>Where</th></tr>' +
      a.consistency.map(x => `<tr><td>${sev(x.severity)}</td><td>${escape(x.finding)}</td><td>${escape(x.where || '')}</td></tr>`).join('') + '</table>';
  }
  h += '<h4>Missing</h4>';
  h += a.missing.length === 0 ? '<p><i>Nothing noted as missing</i></p>' : `<ul>${a.missing.map(x => `<li>${escape(x)}</li>`).join('')}</ul>`;
  h += '<h4>Terminology</h4>';
  if (a.terminology.length === 0) {
    h += '<p><i>No findings</i></p>';
  } else {
    h += '<table class="table table-sm table-striped ips-table"><tr><th>Severity</th><th>Finding</th><th>Codes</th></tr>' +
      a.terminology.map(x => `<tr><td>${sev(x.severity)}</td><td>${escape(x.finding)}</td><td>${x.codes.map(c => `<code>${escape(c)}</code>`).join('<br/>')}</td></tr>`).join('') + '</table>';
  }
  h += showHide("the model's answer", `<pre class="ips-json">${escape(String(v.raw || ''))}</pre>`);
  h += '<div class="ips-explain"><p class="ips-small">An AI service\'s assessment of the document (the analysed copy, with the narrative as submitted or without any, as the project\'s settings say): its consistency and integrity as a whole - do its details agree with each other and the overall picture, and is anything missing; with the narrative, what it says that the data does not back up - ' +
    'and its terminology - are the codes consistent with each other and with their text. The grade runs A (consistent and complete) to F (not usable). It is the model\'s opinion, to be read as such.</p></div>';
  return h;
}


/**
 * The Patient Comments view: the one comment the patient makes on the document - the accuracy or
 * appropriateness of its content (typically a diagnosis in the problems section). Everyone sees it;
 * anyone logged in can write it.
 * @param {Object} row - from store.read(), with .comment (store.patientComment) or not
 * @param {{base: string, user?: Object, csrf?: string, docUrl: string, here?: string, saved?: boolean}} ctx
 */
function renderPatientComments(row, ctx) {
  const c = row.comment;
  let h = '<p class="ips-small">This is a section for any comments the patient wishes to make about the accuracy or appropriateness of the content in the document.</p>';
  if (ctx.saved) {
    h += '<div class="alert alert-success">The comment has been saved.</div>';
  }
  if (c) {
    h += `<div class="ips-patient-comment">${markdownHtml(c.markdown)}</div>`;
    h += `<p class="ips-small">Last changed ${escape(c.updated)}${c.by ? ` by ${escape(c.by)}` : ''}</p>`;
  } else {
    h += '<p><i>The patient has made no comments on this document.</i></p>';
  }
  if (!ctx.user) {
    h += `<p class="ips-small"><a href="${escape(`/auth/login?return=${encodeURIComponent(ctx.here || ctx.docUrl)}`)}">Log in</a> to write the patient's comment.</p>`;
  } else {
    h += `<h3>${c ? 'Edit the comment' : 'Write a comment'}</h3>`;
    h += `<form method="post" action="${escape(ctx.docUrl)}/comment">${csrfField(ctx.csrf)}`;
    h += '<div class="ips-switch" role="tablist"><a href="#" class="active" id="pc-write" role="tab" aria-controls="pc-text">Write</a>' +
      '<a href="#" id="pc-preview" role="tab" aria-controls="pc-shown">Preview</a></div>';
    h += '<label for="pc-text" class="ips-small">The comment, in <a href="https://commonmark.org/help/">markdown</a> - pure markdown: no HTML is allowed. Saving it replaces the comment there was; saving it empty removes it.</label>' +
      `<textarea id="pc-text" name="comment" class="form-control" rows="12" maxlength="${PATIENT_COMMENT_MAX}">${escape(c ? c.markdown : '')}</textarea>` +
      '<div id="pc-shown" class="ips-patient-comment" style="display: none; min-height: 8em" aria-live="polite"></div>';
    h += '<div style="margin-top: 6px"><button type="submit" class="btn btn-primary">Save</button></div></form>';
    h += `<script src="${escape(assets.src(ctx.base, 'vendor/commonmark.min.js'))}"></script>`;
    h += `<script>
(function () {
  var text = document.getElementById('pc-text'), shown = document.getElementById('pc-shown');
  var write = document.getElementById('pc-write'), preview = document.getElementById('pc-preview');
  function show(previewing) {
    if (previewing) {
      var cm = window.commonmark;
      if (!cm) {
        shown.innerHTML = '<p><i>(the preview could not be made)</i></p>';
      } else {
        var doc = new cm.Parser().parse(text.value), w = doc.walker(), ev, html = false;
        while ((ev = w.next())) {
          if (ev.entering && (ev.node.type === 'html_block' || ev.node.type === 'html_inline')) { html = true; }
        }
        shown.innerHTML = (html ? '<div class="alert alert-danger">The comment has HTML in it: only pure markdown is allowed, so it cannot be saved like this.</div>' : '') +
          new cm.HtmlRenderer({ safe: true }).render(doc);
      }
    }
    text.style.display = previewing ? 'none' : '';
    shown.style.display = previewing ? '' : 'none';
    write.className = previewing ? '' : 'active';
    preview.className = previewing ? 'active' : '';
  }
  write.addEventListener('click', function (e) { e.preventDefault(); show(false); });
  preview.addEventListener('click', function (e) { e.preventDefault(); show(true); });
})();
</script>`;
  }
  h += '<div class="ips-explain"><p class="ips-small">The patient\'s own comments on the document - where they take issue with its content, such as a diagnosis in the problems section ' +
    '(these are notoriously unreliable). The patient may be right or wrong: the comment is what they say, not a correction. ' +
    'There is one comment per document, written in markdown; it is kept apart from the document, which is not changed, and processing the document again leaves it alone. ' +
    'Everyone can see it; anyone logged in can change it.</p></div>';
  return h;
}

/**
 * The validation view: what the validator made of the document.
 * @param {Object} row - from store.read(), with .results.validation (from store.readResult) or not
 * @param {{level?: string, docUrl?: string}} [options] - level: the least severity shown
 *   (information, the default, shows everything); docUrl: the page's address, for the form
 */
function renderValidation(row, options = {}) {
  const r = row.results?.validation;
  // a step that has only been marked waiting, running or failed has made nothing yet
  if (!r || (r.result.status && r.result.status !== 'done')) {
    return noResultNote(row, 'validation', 'There is no validation result for this document', options);
  }
  return validationOutcome(r.made, r.result, { ...options, hidden: { view: 'validation' } });
}

/**
 * What the validator made of the document, once: when, with what, the issue counts, the
 * issues (as filtered by options.level) and the OperationOutcome. The validation view and
 * each national profile's page show it.
 * @param {string} made - when the validation was done
 * @param {{counts?: Object, outcome?: Object, profiles?: string[], validatorVersion?: string, ms?: number}} v
 * @param {{level?: string, defaultLevel?: string, docUrl?: string, hidden?: Object}} options - hidden: the
 *   fields the level form keeps (the view, and which national profile); defaultLevel: the level when
 *   none is asked for ('information' - everything - unless given)
 */
function validationOutcome(made, v, options = {}) {
  const counts = v.counts || {};
  let h = `<p class="ips-small">Validated ${escape(made)}` +
    (v.validatorVersion ? ` with validator ${escape(String(v.validatorVersion))}` : '') +
    (Array.isArray(v.profiles) && v.profiles.length ? ` against ${v.profiles.map(p => `<code>${escape(p)}</code>`).join(', ')}` : '') +
    (typeof v.ms === 'number' ? ` in ${escape(String(v.ms))} ms` : '') + '</p>';
  h += `<p><b>${escape(issueSummary(counts))}</b></p>`;
  const all = Array.isArray(v.outcome?.issue) ? v.outcome.issue.filter(isObject) : [];
  if (all.length === 0) {
    return h;
  }
  // as asked for; else the view's own default (everything, unless it says otherwise)
  const level = LEVELS.some(([l]) => l === options.level) ? options.level : (options.defaultLevel || 'information');
  const min = SEVERITY_RANK[level];
  const issues = all.filter(i => (SEVERITY_RANK[text(i.severity)] ?? 3) >= min);
  // the minimum level: a form that submits itself on change (and has a button without script)
  const hidden = Object.entries(options.hidden || { view: 'validation' }).map(([k, val]) => `<input type="hidden" name="${escape(k)}" value="${escape(String(val))}"/>`).join('');
  h += `<form method="get" action="${escape(options.docUrl || '')}" class="ips-filter mb-2">${hidden}` +
    '<label for="f-level">Show</label> <select id="f-level" name="level" onchange="this.form.submit()">' +
    LEVELS.map(([l, label]) => `<option value="${l}"${l === level ? ' selected' : ''}>${escape(label)}</option>`).join('') +
    '</select><noscript><button type="submit" class="btn btn-default ips-btn">Apply</button></noscript>';
  if (issues.length < all.length) {
    const which = level === 'error' ? 'errors and above' : 'warnings and above';
    h += `<span class="ips-small">Showing ${issues.length} of ${all.length} issues (${which})</span>`;
  }
  h += '</form>';
  // the severity is the colour of the code (its name on hover); paths break at their dots,
  // slashes and hyphens (only), so that the message keeps its room
  h += '<table class="table table-sm table-striped ips-table ips-issues"><tr><th>Code</th><th>Location</th><th>Message</th></tr>';
  for (const i of issues) {
    const sev = text(i.severity);
    h += `<tr><td><span class="ips-badge" style="background-color: ${SEVERITY_COLOURS[sev] || '#495057'}" title="${escape(sev)}">${escape(text(i.code) || sev)}</span></td>` +
      `<td class="ips-path">${issueWhere(i).map(w => `<code>${escape(w).replace(/([./-])/g, '$1<wbr/>')}</code>`).join('<br/>')}</td>` +
      `<td>${escape(issueMessage(i))}</td></tr>`;
  }
  h += '</table>';
  // the raw OperationOutcome, behind a button
  h += showHide('the OperationOutcome', `<pre class="ips-json">${escape(JSON.stringify(v.outcome, null, 2))}</pre>`);
  return h;
}

/**
 * Content behind a Show / Hide button: a <details> whose summary is styled as the button.
 * The summary itself is the control - a <button> inside it would be a control nested in a
 * control, which assistive technology can't make sense of (WCAG 4.1.2) - and it works from
 * the keyboard and without scripts. The script only changes its label to Hide when it's open.
 * @param {string} what - what is shown ('the OperationOutcome'), plain text
 * @param {string} body - the content, HTML
 */
function showHide(what, body) {
  return `<details class="ips-oo" data-what="${escape(what)}"><summary class="btn btn-default ips-btn">Show ${escape(what)}</summary>${body}</details>` +
    `<script>
document.querySelectorAll('details.ips-oo:not([data-bound])').forEach(function (d) {
  d.setAttribute('data-bound', 'true');
  d.addEventListener('toggle', function () { d.querySelector('summary').textContent = (d.open ? 'Hide ' : 'Show ') + d.getAttribute('data-what'); });
});
</script>`;
}

// a national profile's outcome on the page: [label, colour]
const NATIONAL_OUTCOMES = {
  pass: ['Passed', '#1e7e34'],
  fail: ['Failed', '#c82333'],
  unknown: ['Not checked', '#8a6100']
};

/**
 * The national profiles step's result: the list of national profiles, and whether the
 * document passed each (no errors); with options.np (an index into the list), that
 * profile's validation, shown as the validation view shows the base validation.
 * @param {Object} row - from store.read(), with .results.national or not
 * @param {{np?: string, level?: string, docUrl?: string, base?: string, canManage?: boolean}} [options]
 */
function renderNational(row, options = {}) {
  const r = row.results?.national;
  if (!r || (r.result.status && r.result.status !== 'done') || !Array.isArray(r.result.profiles)) {
    return noResultNote(row, 'national', 'The document has not been validated against the national profiles', options);
  }
  const v = r.result;
  const base = escape(options.base || '');
  const docUrl = escape(options.docUrl || '');
  if (v.profiles.length === 0) {
    return `<p>There were no <a href="${base}/national-profiles">national profiles</a> to validate the document against when it was processed.</p>`;
  }
  const outcome = (p) => NATIONAL_OUTCOMES[p.pass === true ? 'pass' : p.pass === false ? 'fail' : 'unknown'];
  const index = typeof options.np === 'string' && /^\d{1,4}$/.test(options.np) ? parseInt(options.np, 10) : -1;
  const p = index >= 0 ? v.profiles[index] : null;
  if (p) {
    const [label, colour] = outcome(p);
    let h = `<p class="ips-small"><a href="${docUrl}?view=national">National profiles</a> &raquo; ${escape(`${p.packageId}#${p.version}`)}</p>`;
    h += `<p>${jurisdictionHtml(p.jurisdiction)}: <code>${escape(p.url)}</code> (${escape(`${p.packageId}#${p.version}`)}): <span class="ips-badge" style="background: ${colour}">${escape(label)}</span></p>`;
    if (p.pass === null || p.pass === undefined) {
      return h + `<p><i>The document could not be validated against this profile${options.canManage && p.error ? `: ${escape(p.error)}` : ' (the reason is shown to the project\'s managers)'}.</i></p>`;
    }
    return h + validationOutcome(r.made, { counts: p.counts, outcome: p.outcome, profiles: [p.url], validatorVersion: v.validatorVersion, ms: p.ms },
      // a national profile's issues are mostly about the national IG's own rules: errors only, unless asked
      { ...options, defaultLevel: 'error', hidden: { view: 'national', np: String(index) } });
  }
  let h = '<table class="table table-sm ips-table"><tr><th>Jurisdiction</th><th>Package</th><th>Outcome</th><th>Issues</th></tr>';
  v.profiles.forEach((np, i) => {
    const [label, colour] = outcome(np);
    const issues = np.pass === null || np.pass === undefined ? '<span class="ips-small">(not validated)</span>' : escape(issueSummary(np.counts || {}));
    h += `<tr><td>${jurisdictionHtml(np.jurisdiction)}</td><td><a href="${docUrl}?view=national&amp;np=${i}"><code>${escape(`${np.packageId}#${np.version}`)}</code></a></td>` +
      `<td><span class="ips-badge" style="background: ${colour}">${escape(label)}</span></td><td>${issues}</td></tr>`;
  });
  h += '</table>';
  h += `<p class="ips-small">Validated ${escape(r.made)} against the <a href="${base}/national-profiles">national profiles</a> as they were when the document was processed ` +
    `(${v.profiles.length} profile${v.profiles.length === 1 ? '' : 's'}, ${escape(String(v.ms))} ms); a document passes a profile when the validator reports no errors. ` +
    'Reprocess the document to validate it against them as they are now.</p>';
  return h;
}

/** The editor page: a container the script fills, and what it needs. */
/** JSON for a page's script block: </script> and the like must not end the block. */
function scriptJson(v) {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** Where the editors are: the project's, or the module's (no project). */
function composeBase(ctx, project) {
  return project ? `${projectUrl(ctx, project)}/compose` : `${escape(ctx.base)}/compose`;
}

/** What a page with an editor says about what happens to what's entered. */
function composeNotes(project, options) {
  return 'What you enter stays in this browser until you submit, download or share the document. ' +
    'Submitting, downloading and sharing become available once what you have entered makes a minimal IPS ' +
    '(a patient with a name, an author, and the allergies, problems and medications sections, each with entries or saying why it is empty). ' +
    (project ? `Submitting adds the document to ${escape(project.name)}, where everyone can see it` : 'Submitting adds the document to the project you choose, where everyone can see it') +
    (options.aiEnabled ? ', and sends it to an external AI service for assessment' : '') + '; ' +
    'sharing as a QR code stores it, encrypted, on this server for the days you choose. Don\'t use it for real patients\' documents.';
}

/** The document creators to choose from (for a project, or none). */
function renderComposeChoice(project, ctx, options) {
  const base = composeBase(ctx, project);
  let h = STYLE + userBar(ctx) + crumbs(ctx, project, 'Compose');
  h += '<h3>Compose a document</h3>';
  h += '<p>Choose how to make the International Patient Summary. Each way ends with the same choices: ' +
    (project ? `submit it to ${escape(project.name)}, ` : 'submit it to a project, ') +
    'download it (as JSON, a ZIP, or a PDF with the document attached), or share it as a QR code (a SMART Health Link, or a WHO/GDHCN QR code).</p>';
  h += '<table class="table ips-table" style="max-width: 60em">';
  for (const e of options.editors) {
    h += `<tr><td style="white-space: nowrap"><a class="btn btn-primary" href="${base}/${e.key}">${escape(e.name)}</a></td><td>${escape(e.description)}</td></tr>`;
  }
  h += '</table>';
  if (project) {
    h += `<p class="ips-small">Or <a href="${projectUrl(ctx, project)}/submit">submit a document</a> you already have.</p>`;
  }
  return h;
}

/** The general IPS editor, for a project or none. */
function renderCompose(project, ctx, options) {
  const base = composeBase(ctx, project);
  const title = options.from ? `Edit document ${options.from}` : 'General IPS editor';
  let h = STYLE + userBar(ctx) + crumbs(ctx, project, title);
  h += `<h3>${title}</h3>`;
  h += '<p>Build an International Patient Summary here: the patient, the document\'s author, and the sections. ' +
    (options.from ? 'The form holds what it can of the original document; submitting makes a new document in the project. ' : '') +
    (options.canLookup ? 'Coded fields look codes up on the terminology server as you type (in the value sets this server holds the element to); ' : 'This server has no terminology server to look codes up on (modules.ips.txServer), so coded fields take text only; ') +
    'anything can also be entered as plain text. ' + composeNotes(project, options) + '</p>';
  h += '<noscript><div class="alert alert-warning">The editor needs scripts' + (project ? `; without them, use the <a href="${projectUrl(ctx, project)}/submit">submission form</a>` : '') + '.</div></noscript>';
  h += '<div id="ips-editor"></div>';
  const cfg = {
    project: project ? project.code : '', schema: options.schema, model: options.model, testPatients: options.testPatients || [],
    urls: { build: `${ctx.base}/compose/build`, model: `${ctx.base}/compose/model`, lookup: options.canLookup ? `${ctx.base}/compose/lookup` : null, back: project ? `${ctx.base}/${encodeURIComponent(project.code)}` : base },
    actions: options.actions
  };
  h += `<script>window.IPS_EDITOR = ${scriptJson(cfg)};</script>`;
  h += `<script src="${escape(scripts.src(ctx.base, 'doc-actions.js'))}"></script>`;
  h += `<script src="${escape(scripts.src(ctx.base, 'editor.js'))}"></script>`;
  return h;
}

/**
 * The patient IPS editor: the form (patient-editor/page.html) and its scripts, which build
 * the document in the browser; the document actions (doc-actions.js) take it from there.
 */
function renderPatientEditor(project, ctx, options) {
  const a = (key) => escape(assets.src(ctx.base, key));
  let h = STYLE + userBar(ctx) + crumbs(ctx, project, 'Patient IPS editor');
  h += '<h3>Patient IPS editor</h3>';
  h += `<p class="ips-small">${composeNotes(project, options)}</p>`;
  h += '<noscript><div class="alert alert-warning">The editor needs scripts.</div></noscript>';
  const cfg = {
    assets: `${ctx.base}/assets/patient-editor`,
    actions: options.actions
  };
  h += `<script>window.PATIENT_EDITOR = ${scriptJson(cfg)};</script>`;
  for (const lib of ['vendor/commonmark.min.js']) {
    h += `<script src="${a(lib)}"></script>`;
  }
  h += `<script src="${escape(scripts.src(ctx.base, 'doc-actions.js'))}"></script>`;
  for (const js of ['i18n.js', 'html.js', 'ips-coverage.js', 'ips.js', 'ips-parser.js', 'passport.js', 'people.js', 'events.js']) {
    h += `<script src="${a(`patient-editor/js/${js}`)}"></script>`;
  }
  const page = options.page.split('{{viewer}}').join(escape(`${ctx.base}/view`)).split('{{assets}}').join(escape(cfg.assets));
  h += '<div class="patient-editor">' + page + '</div>';
  return h;
}

// ---- patients --------------------------------------------------------------------------

// how a document's patient was matched (patients.js), in words
const MATCH_WORDS = { identifier: 'matched by identifier', demographics: 'matched by name and birth date', new: 'a patient not seen before', none: 'the document has no Patient' };

/** A patient's identifiers, as text. */
function identifiersText(resource) {
  return (Array.isArray(resource.identifier) ? resource.identifier : []).filter(i => i && i.value)
    .map(i => `${i.value}${i.system ? ` (${i.system})` : ''}`);
}

/** The project's patients, with a search form. */
function renderPatients(project, found, query, ctx) {
  const purl = projectUrl(ctx, project);
  let h = STYLE + userBar(ctx) + crumbs(ctx, project, 'Patients');
  h += '<h3>Patients</h3>';
  h += '<p>Each document\'s patient is matched to a patient already seen in the project - the same identifier (system and value), or the same name and birth date, ' +
    'unless the birth date or gender says otherwise - or is a new one. A patient\'s record is what all their documents say, the latest first. ' +
    `It is a reasonable guess, not a master patient index. FHIR: <code>${purl}/Patient</code> (read and search), and <code>Patient/[id]/$summary</code> for the latest document.</p>`;
  const v = (k) => escape(typeof query[k] === 'string' ? query[k] : '');
  h += `<form method="get" action="${purl}/Patient" class="form-inline ips-filter mb-2">` +
    `<input class="form-control" name="name" placeholder="Name" value="${v('name')}" aria-label="Name"/> ` +
    `<input class="form-control" name="birthdate" placeholder="Birth date (YYYY-MM-DD)" value="${v('birthdate')}" aria-label="Birth date"/> ` +
    `<input class="form-control" name="identifier" placeholder="Identifier (system|value)" value="${v('identifier')}" aria-label="Identifier"/> ` +
    '<button type="submit" class="btn btn-default">Search</button></form>';
  if (found.problems.length > 0) {
    h += `<div class="alert alert-warning">${found.problems.map(escape).join('<br/>')}</div>`;
  }
  if (found.all.length === 0) {
    return h + '<p><i>No patients.</i></p>';
  }
  h += `<p class="ips-small">${found.all.length} patient${found.all.length === 1 ? '' : 's'}${found.all.length > found.patients.length ? `, showing ${found.offset + 1}-${found.offset + found.patients.length}` : ''}</p>`;
  h += '<table class="table table-sm table-striped ips-table"><tr><th>Id</th><th>Name</th><th>Gender</th><th>Born</th><th>Identifiers</th><th>Documents</th><th>Last document</th></tr>';
  for (const p of found.patients) {
    h += `<tr><td><a href="${purl}/Patient/${p.id}">${p.id}</a></td><td><a href="${purl}/Patient/${p.id}">${escape(p.name || '(no name)')}</a></td>` +
      `<td>${escape(p.gender || '')}</td><td>${escape(p.birth_date || '')}</td><td>${identifiersText(p.resource).map(escape).join('<br/>')}</td>` +
      `<td>${p.documents}</td><td>${escape(new Date(p.updated_ms).toISOString().substring(0, 16).replace('T', ' '))}</td></tr>`;
  }
  h += '</table>';
  if (found.offset + found.count < found.all.length) {
    const u = new URLSearchParams();
    for (const [k, val] of Object.entries(query)) {
      if (k !== '_offset' && typeof val === 'string') {
        u.append(k, val);
      }
    }
    u.append('_offset', String(found.offset + found.count));
    h += `<p><a href="${purl}/Patient?${escape(u.toString())}">More</a></p>`;
  }
  return h;
}

/** A patient: what their documents say about them, and the documents. */
function renderPatient(project, p, docs, ctx) {
  const purl = projectUrl(ctx, project);
  const r = p.resource;
  const url = `${purl}/Patient/${p.id}`;
  let h = STYLE + userBar(ctx) + crumbs(ctx, project, `Patient ${p.id}`);
  h += '<div class="ips-banner"><div>';
  h += `<div class="ips-patient"><b>${escape(p.name || '(no name)')}</b>` + (p.gender ? `, ${escape(p.gender)}` : '') + (p.birth_date ? `, born ${escape(p.birth_date)}` : '') + '</div>';
  h += `<div class="ips-facts">Patient #${p.id} &nbsp;|&nbsp; <a href="${url}?_format=json">FHIR JSON</a>` +
    (docs.length ? ` &nbsp;|&nbsp; <a href="${url}/$summary">Latest document ($summary)</a>` : '') + '</div>';
  h += '</div></div>';
  const rows = [];
  const add = (label, values) => {
    if (values.length) {
      rows.push(`<tr><th>${label}</th><td>${values.map(escape).join('<br/>')}</td></tr>`);
    }
  };
  add('Identifiers', identifiersText(r));
  add('Names', (Array.isArray(r.name) ? r.name : []).map(n => n && (n.text || [...(n.given || []), n.family].filter(Boolean).join(' '))).filter(Boolean));
  add('Telecom', (Array.isArray(r.telecom) ? r.telecom : []).filter(t => t && t.value).map(t => `${t.system ? t.system + ': ' : ''}${t.value}`));
  add('Address', (Array.isArray(r.address) ? r.address : []).map(a => a && (a.text || [...(a.line || []), a.city, a.state, a.postalCode, a.country].filter(Boolean).join(', '))).filter(Boolean));
  add('Language', (Array.isArray(r.communication) ? r.communication : []).map(c => c && c.language && (c.language.text || c.language.coding?.[0]?.display || c.language.coding?.[0]?.code)).filter(Boolean));
  if (rows.length) {
    h += `<table class="table table-sm ips-table" style="max-width: 60em">${rows.join('')}</table>`;
  }
  h += '<h4>Documents</h4>';
  h += '<table class="table table-sm table-striped ips-table"><tr><th>Document</th><th>Received</th><th>Title</th><th>Date</th><th>Matched</th></tr>';
  for (const d of docs) {
    h += `<tr><td><a href="${purl}/Bundle/${d.id}">${d.id}</a></td><td>${escape(d.received)}</td><td>${escape(d.comp_title || '')}</td><td>${escape(d.comp_date || '')}</td>` +
      `<td>${escape(d.match ? (MATCH_WORDS[d.match.method] || d.match.method) : '')}${d.match && d.match.method === 'new' && d.match.detail !== 'Not seen before' ? `<br/><span class="ips-small">${escape(d.match.detail)}</span>` : ''}</td></tr>`;
  }
  return h + '</table>';
}

// ---- national profiles -----------------------------------------------------------------

/** A national profile's jurisdiction, for the page: its code, and the country's or region's name. */
function jurisdictionHtml(code) {
  if (!code) {
    return '<span class="ips-small">(not given)</span>';
  }
  const j = jurisdiction(code);
  return `<code>${escape(code)}</code>` + (j ? ` ${escape(j.display)}` : '');
}

/** A SNOMED CT edition by name, with its module id on hover; '' for none. */
function editionHtml(edition) {
  if (!edition) {
    return '';
  }
  return `<span title="${escape(`http://snomed.info/sct/${edition}`)}">${escape(editionName(edition) || edition)}</span>`;
}

/** The SNOMED CT edition select for a national profile: none, or one of the editions. */
function editionSelect(form, edition) {
  let h = `<select form="${form}" name="snomedEdition" class="form-control" style="font-size: 85%; width: 14em" title="The SNOMED CT edition the IG takes for granted, if any">` +
    `<option value=""${edition ? '' : ' selected'}>(none)</option>`;
  for (const ed of SNOMED_LINKABLE_EDITIONS) {
    h += `<option value="${escape(ed)}"${ed === edition ? ' selected' : ''}>${escape(editionName(ed) || ed)}</option>`;
  }
  return h + '</select>';
}

/**
 * The national profiles: for each, the national IG's package (id and version), the url of
 * its profile on Bundle, and the SNOMED CT edition it takes for granted (if any). Everyone sees the list; the administrator adds, edits and deletes.
 * @param {Array} list - from store.nationalProfiles()
 */
function renderNationalProfiles(list, ctx, message) {
  const base = escape(ctx.base);
  const isAdmin = !!ctx.user?.isAdmin;
  let h = STYLE + userBar(ctx) + `<p class="ips-small"><a href="${base}">IPS projects</a> &raquo; National profiles</p>` + alert(message);
  h += '<div class="ips-banner"><b class="ips-project-name">National profiles</b></div>';
  h += '<p>A national profile is the profile a national implementation guide defines for an IPS document: the country or region it is for, the IG\'s package (its id and version), ' +
    'the canonical URL of its profile on Bundle, and the SNOMED CT edition the IG takes for granted (if it uses SNOMED CT). They apply across all projects.' + (isAdmin ? '' : ' Only the administrator can change them.') + '</p>';
  if (list.length === 0) {
    h += '<p>There are no national profiles yet.</p>';
  }
  if (!isAdmin) {
    if (list.length === 0) {
      return h;
    }
    h += '<table class="table table-sm table-striped ips-table"><tr><th>Jurisdiction</th><th>Package</th><th>Version</th><th>Profile on Bundle</th><th>SNOMED CT Edition</th></tr>';
    for (const np of list) {
      h += `<tr><td>${jurisdictionHtml(np.jurisdiction)}</td><td><code>${escape(np.packageId)}</code></td><td>${escape(np.version)}</td><td><code>${escape(np.url)}</code></td><td>${editionHtml(np.snomedEdition)}</td></tr>`;
    }
    return h + '</table>';
  }
  const fields = (form, np) =>
    `<td><input form="${form}" type="text" name="jurisdiction" required class="form-control" style="font-size: 85%; width: 6em" placeholder="AU, or 150" ` +
    `title="A country's ISO 3166 two-letter code, or a region's UN M49 three-digit code" value="${escape(np ? (np.jurisdiction || '') : '')}"/>` +
    (np && np.jurisdiction && jurisdiction(np.jurisdiction) ? `<span class="ips-small">${escape(jurisdiction(np.jurisdiction).display)}</span>` : '') + '</td>' +
    `<td><input form="${form}" type="text" name="packageId" required class="form-control" style="font-size: 85%; width: 15em" placeholder="e.g. hl7.fhir.au.ips" value="${escape(np ? np.packageId : '')}"/></td>` +
    `<td><input form="${form}" type="text" name="version" required class="form-control" style="font-size: 85%; width: 8em" placeholder="version" value="${escape(np ? np.version : '')}"/></td>` +
    `<td><input form="${form}" type="url" name="url" required class="form-control" style="font-size: 85%; width: 100%; min-width: 30em" placeholder="url of the profile on Bundle" value="${escape(np ? np.url : '')}"/></td>` +
    `<td>${editionSelect(form, np ? np.snomedEdition : null)}</td>`;
  // the package id and version are short; the url takes the rest of the row
  h += '<table class="table table-sm ips-table"><tr><th>Jurisdiction</th><th>Package</th><th>Version</th><th style="width: 100%">Profile on Bundle</th><th>SNOMED CT Edition</th><th></th></tr>';
  for (const np of list) {
    const form = `np-${np.id}`;
    const action = `${base}/national-profiles/${np.id}`;
    h += '<tr>' + fields(form, np) +
      `<td style="white-space: nowrap"><form id="${form}" method="post" action="${action}" class="ips-inline">${csrfField(ctx.csrf)}` +
      '<button type="submit" class="btn btn-primary ips-btn" style="font-size: 85%; padding: 1px 10px">Save</button></form> ' +
      `<form method="post" action="${action}/delete" class="ips-inline" data-confirm="${escape(`Delete the national profile for ${np.packageId}#${np.version}?`)}">${csrfField(ctx.csrf)}` +
      '<button type="submit" class="btn btn-default ips-btn" style="font-size: 85%; padding: 1px 10px">Delete</button></form></td></tr>';
  }
  h += '<tr>' + fields('np-new', null) +
    `<td><form id="np-new" method="post" action="${base}/national-profiles">${csrfField(ctx.csrf)}` +
    '<button type="submit" class="btn btn-primary ips-btn" style="font-size: 85%; padding: 1px 10px">Add</button></form></td></tr>';
  return h + '</table>';
}

// ---- clinical profiles -----------------------------------------------------------------

function profileCrumbs(ctx, extra) {
  let h = `<p class="ips-small"><a href="${escape(ctx.base)}">IPS projects</a> &raquo; <a href="${escape(ctx.base)}/StructureDefinition">Clinical profiles</a>`;
  return h + (extra ? ` &raquo; ${escape(extra)}` : '') + '</p>';
}

/** The list of clinical profiles; the administrator can make, and upload, new ones. */
function renderProfiles(list, ctx) {
  const base = escape(ctx.base);
  let h = STYLE + userBar(ctx) + `<p class="ips-small"><a href="${base}">IPS projects</a> &raquo; Clinical profiles</p>`;
  h += '<div class="ips-banner"><b class="ips-project-name">Clinical profiles</b></div>';
  if (ctx.user?.isAdmin) {
    h += '<div class="ips-actions-line">' +
      `<a class="btn btn-primary" href="${base}/StructureDefinition/new">New profile</a> ` +
      '<label class="btn btn-default" style="margin: 0">Upload a profile (JSON)<input type="file" id="ips-pf-upload" accept=".json,application/json,application/fhir+json" hidden/></label>' +
      '<span id="ips-pf-upload-msg" class="ips-small" style="margin-left: 8px"></span></div>';
  }
  h += '<p>A clinical profile says what a kind of clinical document is expected to contain: a profile on Bundle (the document), with a constraint for each expectation - ' +
    'usually that a section is there, or that a section has entries with a code. They apply across all projects.' +
    (ctx.user?.isAdmin ? '' : ' Only the administrator can change them.') + '</p>';
  if (list.length === 0) {
    h += '<p>There are no clinical profiles yet.</p>';
  } else {
    h += '<table class="table table-sm table-striped ips-table"><tr><th>Profile</th><th>Constraints</th><th>Updated</th><th></th></tr>';
    for (const p of list) {
      const url = `${base}/StructureDefinition/profile-${escape(p.id)}`;
      h += `<tr><td><a href="${url}">${escape(p.title)}</a></td><td>${p.constraints}</td><td>${escape(dateOnly(new Date(p.updated_ms).toISOString()))}</td>` +
        `<td><a href="${url}?download=1">Download JSON</a></td></tr>`;
    }
    h += '</table>';
  }
  h += `<p class="ips-small">As FHIR: <code>GET ${base}/StructureDefinition</code> (a searchset of the StructureDefinitions), <code>GET ${base}/StructureDefinition/{id}</code>.</p>`;
  if (ctx.user?.isAdmin) {
    h += `<script>(function () {
  var input = document.getElementById('ips-pf-upload');
  var msg = document.getElementById('ips-pf-upload-msg');
  input.addEventListener('change', function () {
    var f = input.files && input.files[0];
    if (!f) { return; }
    msg.textContent = 'Uploading ' + f.name + '...';
    f.text().then(function (t) {
      var sd;
      try { sd = JSON.parse(t); } catch (e) { msg.textContent = f.name + ' is not JSON'; return; }
      return fetch(${JSON.stringify(ctx.base + '/StructureDefinition')}, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ upload: sd, _csrf: ${JSON.stringify(ctx.csrf || '').replace(/</g, '\\u003c')} }) })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }, function () { return { ok: false, j: { problems: ['The server answered ' + r.status] } }; }); })
        .then(function (a) { if (a.ok) { location.href = a.j.url; } else { msg.textContent = 'Not uploaded: ' + (a.j.problems || []).join('; '); } });
    }).finally(function () { input.value = ''; });
  });
})();</script>`;
  }
  return h;
}

// the parts of a profile, as the view and the editor show them
const PROFILE_PARTS = [['section', 'Required sections and entries'], ['resource', 'Rules about resources'], ['other', 'Other rules']];

// the code systems for the categories of the resources in an IPS, for a rule's category
const CATEGORY_SYSTEMS = [
  { url: 'http://terminology.hl7.org/CodeSystem/condition-category', name: 'Condition category' },
  { url: 'http://terminology.hl7.org/CodeSystem/observation-category', name: 'Observation category' },
  { url: 'http://terminology.hl7.org/CodeSystem/medicationrequest-category', name: 'MedicationRequest category' }
];

/** A cardinality, for the profile's page: " [m..n]", unless it is unstated or 1..1. */
function cardSuffix(p) {
  return p.min === null || p.min === undefined || (p.min === 1 && p.max === 1) ? '' : ` [${p.min}..${p.max}]`;
}

/** The name of a code system, when it has one we know, or its URL. */
function profileSystemName(url) {
  const sys = profiles.SYSTEMS.find(s => s.url === url);
  return sys ? sys.name : (systemName(url) || url);
}

/** The Section and Entry columns of a required section/entry row. */
function sectionColumns(shape, titleOf) {
  const s = shape.section;
  const named = s.system === LOINC ? profiles.IPS_SECTIONS.find(x => x.code === s.code) : null;
  const section = (named
    ? `${escape(named.title)} <span class="ips-small">(${escape(`${profileSystemName(s.system)}|${s.code}`)})</span>`
    : escape(`${profileSystemName(s.system)}|${s.code}`)) + escape(cardSuffix(s));
  const e = shape.entry;
  let entry = '';
  if (e && e.valueSet !== undefined) {
    const title = typeof titleOf === 'function' ? titleOf(e.valueSet) : null;
    entry = `Code is in <b>${escape(title || e.valueSet)}</b>` + (title ? ` <span class="ips-small">(${escape(e.valueSet)})</span>` : '') + escape(cardSuffix(e));
  } else if (e) {
    entry = `Code is <b>${escape(`${profileSystemName(e.system)}|${e.code}`)}</b>` + escape(cardSuffix(e));
  }
  return [section, entry];
}

/** The resources a rule is about, as a plural: MedicationAdministrations, or Any resource. */
function resourceTypePlural(type) {
  if (!type) {
    return 'Any resource';
  }
  return /[^aeiou]y$/.test(type) ? `${type.slice(0, -1)}ies` : `${type}s`;
}

// the tails of a rule about resources that are said in words: each of the patterns, as it
// is, or (where a resource at a time is what is meant) inside .all(...)
const STR_ARG = "\\s*'((?:[^'\\\\]|\\\\.)*)'\\s*";
const NAME = '[A-Za-z][A-Za-z0-9_]*';
const allOf = (body) => new RegExp(`^\\.\\s*(?:${body}|all\\s*\\(\\s*${body}\\s*\\))$`);
const TAILS = [
  [/^\.\s*exists\s*\(\s*\)$/, () => 'Must be present somewhere'],
  [/^\.\s*all\s*\(\s*sameSubject\s*\(\s*\)\s*\)$/, () => 'Patient must match the Document'],
  [allOf(`conformsTo\\s*\\(${STR_ARG}\\)`), (m, ctx) => {
    const url = unescapeArg(m[1] !== undefined ? m[1] : m[2]);
    const title = typeof ctx.profileTitle === 'function' ? ctx.profileTitle(url) : null;
    return `Conform to <b>${escape(title || url)}</b>` + (title ? ` <span class="ips-small">(${escape(url)})</span>` : '');
  }],
  [allOf(`category\\s*\\.\\s*hasCoding\\s*\\(${STR_ARG},${STR_ARG}(?:,${STR_ARG})?\\)`), (m) => {
    const [system, code, version] = (m[1] !== undefined ? [m[1], m[2], m[3]] : [m[4], m[5], m[6]]).map(x => x === undefined ? undefined : unescapeArg(x));
    return `Has category <b>${escape(`${profileSystemName(system)}|${code}`)}</b>` + (version !== undefined ? ` <span class="ips-small">(version ${escape(version)})</span>` : '');
  }],
  // an element, or an element's element (no deeper): Must have an x, Must have an x.y
  [new RegExp(`^\\.\\s*(${NAME})\\s*(?:\\.\\s*(${NAME})\\s*)?\\.\\s*exists\\s*\\(\\s*\\)$`), (m) => {
    const path = m[2] ? `${m[1]}.${m[2]}` : m[1];
    return `Must have ${/^[aeiou]/i.test(path) ? 'an' : 'a'} <code>${escape(path)}</code>`;
  }]
];

/** A FHIRPath string's content, unescaped. */
function unescapeArg(s) {
  return s.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (x, c) => c.length === 5 ? String.fromCharCode(parseInt(c.substring(1), 16)) : ({ n: '\n', r: '\r', t: '\t', f: '\f' }[c] || c));
}

/** The Resource Set and Rule columns of a rule about resources. */
function resourceColumns(rshape, ctx) {
  const titleOf = ctx.valueSetTitle;
  let which;
  if (rshape.valueSet !== undefined) {
    const title = typeof titleOf === 'function' ? titleOf(rshape.valueSet) : null;
    which = `Code is in <b>${escape(title || rshape.valueSet)}</b>` + (title ? ` <span class="ips-small">(${escape(rshape.valueSet)})</span>` : '');
  } else {
    which = `Code is <b>${escape(`${profileSystemName(rshape.system)}|${rshape.code}`)}</b>`;
  }
  const set = `${escape(resourceTypePlural(rshape.type))} where ${which}`;
  const rest = rshape.rest.trim();
  for (const [re, words] of TAILS) {
    const m = re.exec(rest);
    if (m) {
      return [set, words(m, ctx)];
    }
  }
  return [set, `<code>${escape(rest)}</code>`];
}

/**
 * A clinical profile: the same page for everyone. The administrator also gets add, edit and
 * delete on each row (a row at a time, the script edits it in place), and the full editor.
 */
function renderProfile(sd, ctx, editor = null) {
  const base = escape(ctx.base);
  const url = `${base}/StructureDefinition/${escape(sd.id)}`;
  const admin = !!(editor && ctx.user?.isAdmin);
  let h = STYLE + userBar(ctx) + profileCrumbs(ctx, sd.title);
  h += `<div class="ips-banner"><b class="ips-project-name">${escape(sd.title)}</b>` +
    `<div class="ips-facts">Clinical profile on Bundle &nbsp;&middot;&nbsp; <code>${escape(sd.url)}</code> &nbsp;&middot;&nbsp; updated ${escape(dateOnly(sd.date))}</div></div>`;
  h += '<div class="ips-actions-line">' +
    `<a class="btn btn-default" href="${url}?download=1">Download JSON</a>` +
    (admin ? ` <a class="btn btn-default" href="${url}/edit">Edit all</a> ` +
      `<form method="post" action="${url}/delete" class="ips-inline" data-confirm="${escape(`Delete the clinical profile ${sd.title}?`)}">${csrfField(ctx.csrf)}` +
      '<button type="submit" class="btn btn-default">Delete profile</button></form>' : '') + '</div>';
  const constraints = (sd.differential?.element?.[0]?.constraint || []).filter(c => c && typeof c === 'object');
  // the actions on a row, for the administrator
  const actions = (c) => !admin ? '' : '<td class="ips-pf-actions">' +
    '<button type="button" class="btn btn-default ips-btn ips-pf-edit">Edit</button> ' +
    `<form method="post" action="${url}/constraint/${escape(c.key || '')}/delete" class="ips-inline" data-confirm="${escape(`Delete the rule '${c.human || c.key}'?`)}">${csrfField(ctx.csrf)}` +
    '<button type="submit" class="btn btn-default ips-btn">Delete</button></form></td>';
  const rowAttrs = (c) => (admin ? ` data-key="${escape(c.key || '')}"` : '') + ` title="${escape(c.expression || '')}"`;
  const actionsHead = admin ? '<th class="ips-pf-actions"></th>' : '';
  const ADD = { section: 'Add a required section/entry', resource: 'Add a rule about resources', other: 'Add another rule' };
  for (const [kind, heading] of PROFILE_PARTS) {
    const these = constraints.filter(c => profiles.kindOf(c.expression || '') === kind);
    if (!these.length && !admin) {
      continue;
    }
    // the heading, and for the administrator the part's Add button, to its right
    h += `<div class="ips-pf-part-head"><h4>${escape(heading)}</h4>` +
      (admin ? `<button type="button" class="btn btn-default ips-pf-add" data-part="${kind}">${escape(ADD[kind])}</button>` : '') + '</div>';
    if (kind === 'section') {
      h += `<table class="table table-sm ips-table ips-pf-rule" data-part="${kind}"><tr><th style="width: 40%">Expectation</th><th>Section</th><th>Entry</th>${actionsHead}</tr>`;
      for (const c of these) {
        const [section, entry] = sectionColumns(profiles.parseShape(c.expression || ''), ctx.valueSetTitle);
        h += `<tr${rowAttrs(c)}><td>${escape(c.human || '')}</td><td>${section}</td><td>${entry}</td>${actions(c)}</tr>`;
      }
    } else if (kind === 'resource') {
      h += `<table class="table table-sm ips-table ips-pf-rule" data-part="${kind}"><tr><th style="width: 40%">Expectation</th><th>Resource Set</th><th>Rule</th>${actionsHead}</tr>`;
      for (const c of these) {
        const [set, rule] = resourceColumns(profiles.parseResourceShape(c.expression || ''), ctx);
        h += `<tr${rowAttrs(c)}><td>${escape(c.human || '')}</td><td>${set}</td><td>${rule}</td>${actions(c)}</tr>`;
      }
    } else {
      h += `<table class="table table-sm ips-table ips-pf-rule" data-part="${kind}"><tr><th style="width: 35%">Expectation</th><th>Rule</th>${actionsHead}</tr>`;
      for (const c of these) {
        h += `<tr${rowAttrs(c)}><td>${escape(c.human || '')}</td><td><code>${escape(c.expression || '')}</code></td>${actions(c)}</tr>`;
      }
    }
    h += '</table>';
  }
  if (constraints.length === 0 && !admin) {
    h += '<p>This profile has no constraints yet.</p>';
  }
  h += '<p class="ips-small">Each rule is checked against the document (the Bundle). <code>section(system, code, min, max)</code> finds the sections of the document\'s Composition ' +
    '(nested ones too) with that code, when there are min..max of them; <code>entry(system, code, min, max)</code> finds a section\'s entries with that code ' +
    '(their <code>code</code>, <code>medicationCodeableConcept</code> or <code>vaccineCode</code>), when there are min..max of them; ' +
    '<code>resources(system, code, type)</code> finds the resources in the document with that code (of that type, when one is given); ' +
    '<code>entryIn(valueSet, min, max)</code> and <code>resourcesIn(valueSet, type)</code> are the same with a code in a value set, asked of the terminology server. ' +
    'A cardinality <code>[m..n]</code> after a section or an entry is how many there may be; with none, there must be at least one.</p>';
  if (admin) {
    const cfg = {
      mode: 'rows', profile: { id: sd.id, title: sd.title, constraints: editor.constraints },
      sections: editor.sections, systems: editor.systems, resourceTypes: editor.resourceTypes, sectionSystem: editor.sectionSystem, csrf: ctx.csrf || '',
      parts: PROFILE_PARTS,
      urls: {
        constraint: `${ctx.base}/StructureDefinition/${sd.id}/constraint`,
        lookup: editor.canLookup ? `${ctx.base}/lookup` : null,
        lookupVs: `${ctx.base}/lookup-vs`
      },
      // the code systems offered for a resource's category, first the default
      categorySystem: CATEGORY_SYSTEMS[0].url,
      categorySystems: CATEGORY_SYSTEMS
    };
    h += '<div id="ips-profile-editor"></div>';
    h += `<script>window.IPS_PROFILE = ${JSON.stringify(cfg).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')};</script>`;
    h += `<script src="${escape(scripts.src(ctx.base, 'profile-editor.js'))}"></script>`;
  }
  return h;
}

/** The profile editor (the administrator's): the page carries the profile, the script edits it. */
function renderProfileEditor(sd, ctx, options) {
  const base = ctx.base;
  let h = STYLE + userBar(ctx) + profileCrumbs(ctx, sd ? sd.title : 'New profile');
  h += `<h3>${sd ? 'Edit clinical profile' : 'New clinical profile'}</h3>`;
  h += '<p>The title, and the expectations: each a description, and a rule. A rule that a section is there, or that a section has entries with a code, ' +
    'is a row of the table - the section (one of the IPS sections, or any code), how many there may be, and optionally the code of the entries and how many - ' +
    'where a cardinality is blank for any number, or <code>min..max</code> (<code>1..1</code>, <code>1..*</code>). A rule about the resources in the document with a code ' +
    '(<code>Bundle.resources(system, code, type)...</code>) is a row of the second table: the type (or any), the code, and the rest of the rule, as FHIRPath on those resources ' +
    '(<code>.exists()</code>, <code>.count() = 1</code>, <code>.all(clinicalStatus.coding.code = \'active\')</code>). Entries and resources can be matched by a value set instead of a code: ' +
    'choose <i>In a value set...</i> as the system, and search for one by title, or paste its canonical. Any other rule is a FHIRPath expression on the document (the Bundle).' +
    (options.canLookup ? '' : ' (There is no terminology server, so codes can\'t be looked up.)') + '</p>';
  h += '<noscript><div class="alert alert-warning">The editor needs scripts.</div></noscript>';
  h += '<div id="ips-profile-editor"></div>';
  const cfg = {
    profile: options.profile, sections: options.sections, systems: options.systems, resourceTypes: options.resourceTypes, sectionSystem: options.sectionSystem, csrf: ctx.csrf || '',
    parts: PROFILE_PARTS,
    urls: {
      save: sd ? `${base}/StructureDefinition/${sd.id}` : `${base}/StructureDefinition`,
      lookup: options.canLookup ? `${base}/lookup` : null,
      lookupVs: `${base}/lookup-vs`,
      back: sd ? `${base}/StructureDefinition/${sd.id}` : `${base}/StructureDefinition`
    }
  };
  h += `<script>window.IPS_PROFILE = ${JSON.stringify(cfg).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')};</script>`;
  h += `<script src="${escape(scripts.src(base, 'profile-editor.js'))}"></script>`;
  return h;
}

// ---- the SHL viewer --------------------------------------------------------------------------

const TRACE_LEVELS = {
  info: ['', ''],
  ok: ['ips-tr-ok', '&#10003;'],
  warning: ['ips-tr-warning', '&#9888;'],
  error: ['ips-tr-error', '&#10007;']
};

const VIEWER_STYLE = `<style>
  .ips-trace td { vertical-align: top; }
  .ips-trace .ips-tr-ms { white-space: nowrap; color: #6c757d; text-align: right; font-size: 85%; }
  .ips-trace .ips-tr-ok { color: #2e7d32; }
  .ips-trace .ips-tr-warning { color: #b26a00; }
  .ips-trace .ips-tr-error { color: #c62828; font-weight: bold; }
  .ips-trace details summary { cursor: pointer; font-size: 85%; color: #5e35b1; }
  .ips-trace pre { max-height: 400px; overflow: auto; margin: 4px 0 0 0; }
  .ips-view-doc { border: 1px solid #d1c4e9; border-radius: 4px; padding: 10px 14px; margin-bottom: 14px; }
  .ips-view-add { background: #fffde7; border: 1px solid #fff59d; border-radius: 4px; padding: 8px 12px; margin: 8px 0; }
  .ips-view-add select, .ips-view-add input[type=password] { margin: 0 6px; }
</style>`;

/**
 * The viewer's first page: with script, it takes the link from the address (after the #)
 * and posts it at once; without, or with no link there, the link can be pasted in.
 */
function renderViewerStart(ctx, message) {
  const base = escape(ctx.base);
  let h = STYLE + VIEWER_STYLE + userBar(ctx) + crumbs(ctx, null, 'SHL viewer');
  h += '<div class="ips-banner"><b class="ips-project-name">SMART Health Link viewer</b></div>';
  if (message) {
    h += `<div class="alert alert-danger">${escape(message)}</div>`;
  }
  h += '<p>A viewer for SMART Health Links (SHL) and Verifiable Health Links (VHL) that carry International Patient Summary documents. ' +
    'It retrieves the document, showing every step it takes - to help with debugging SHL servers - shows the document\'s narrative, ' +
    'and offers to add the document to one of this server\'s projects.</p>';
  h += `<div class="alert alert-warning">This is a public test service. The link - its key included - the requests and responses, and the document itself are ` +
    `kept on this server for ${escape(String(ctx.keepMinutes))} minutes, and shown to anyone who has the page's address. Don't use it for real patients' documents.</div>`;
  h += `<form method="post" action="${base}/view" id="ips-viewer-form">` +
    '<label for="ips-viewer-link">The link</label> <span class="ips-small">(a viewer URL with <code>#shlink:/...</code>, the <code>shlink:/...</code> itself, or a VHL\'s <code>HC1:...</code>)</span>' +
    '<textarea id="ips-viewer-link" name="link" rows="4" style="width: 100%; font-family: monospace; font-size: 85%" required></textarea>' +
    '<p><label for="ips-viewer-passcode">Passcode</label> <input type="password" id="ips-viewer-passcode" name="passcode" autocomplete="off"/> ' +
    '<span class="ips-small">(only for a link that needs one - flag P; you will be asked if it does)</span></p>' +
    '<button type="submit" class="btn btn-primary">Open</button> <span class="ips-small ips-viewer-opening" hidden>Opening the link...</span></form>';
  h += `<div class="ips-explain"><p class="ips-small">To make this the viewer for an SHL, put <code>${escape(ctx.viewerUrl)}</code> in front of the <code>shlink:/...</code>. ` +
    'The link is opened on the server, not in the browser: the SHL server does not need to allow cross-origin requests (the log says whether it does). ' +
    'Only FHIR JSON files are supported (not SMART Health Cards), and only an IPS document - a document Bundle whose Composition type is LOINC 60591-5 - can be added to a project. ' +
    'A VHL\'s signature is checked when this server has the issuer\'s certificate.</p></div>';
  h += `<script>
(function () {
  var hash = window.location.hash ? window.location.hash.substring(1) : '';
  try { hash = decodeURIComponent(hash); } catch (e) { /* as it is */ }
  if (hash.indexOf('shlink:/') < 0 && !/^HC1:/i.test(hash)) { return; }
  var form = document.getElementById('ips-viewer-form');
  form.querySelector('textarea').value = hash;
  // the key is in the address: take it out of the browser's history
  try { window.history.replaceState(null, '', window.location.pathname); } catch (e) { /* no matter */ }
  form.querySelector('.ips-viewer-opening').hidden = false;
  form.submit();
})();
</script>`;
  return h;
}

/** The viewer's log, as a table: when, what, and the detail (behind a disclosure). */
function traceHtml(entries) {
  let h = '<table class="table table-condensed ips-trace"><thead><tr><th>ms</th><th></th><th>Step</th></tr></thead><tbody>';
  for (const e of entries || []) {
    const [cls, icon] = TRACE_LEVELS[e.level] || TRACE_LEVELS.info;
    h += `<tr class="${cls}"><td class="ips-tr-ms">${escape(String(e.ms))}</td><td>${icon}</td><td>${escape(e.text)}` +
      (e.detail ? `<details><summary>details</summary><pre class="ips-json">${escape(e.detail)}</pre></details>` : '') + '</td></tr>';
  }
  return h + '</tbody></table>';
}

/** Flags, in words. */
function flagWords(flag) {
  const f = typeof flag === 'string' ? flag : '';
  return [f.includes('L') ? 'long term' : null, f.includes('P') ? 'passcode' : null, f.includes('U') ? 'direct file' : null].filter(Boolean).join(', ') || 'none';
}

/**
 * What the viewer retrieved: the link's facts, a passcode form if it needs one, each document
 * (who, adding it to a project, its narrative as submitted), then the log of what was done.
 * @param {Object} view - store.readView()
 * @param {Object} ctx - with projects [{code, name, needsToken, ai}], duplicates (per document,
 *   the documents already here with the same identifier), keepMinutes
 */
function renderView(view, ctx, message) {
  const base = escape(ctx.base);
  const r = view.result;
  const vurl = `${base}/view/${escape(view.token)}`;
  let h = STYLE + VIEWER_STYLE + userBar(ctx) + crumbs(ctx, null, 'SHL viewer');
  const p = r.payload || {};
  h += '<div class="ips-banner"><div class="ips-project-name"><b>' + escape(typeof p.label === 'string' && p.label ? p.label : 'SMART Health Link') + '</b></div>';
  h += '<div class="ips-facts">' + (r.vhl ? 'A Verifiable Health Link' + (r.vhl.issuer !== null && r.vhl.issuer !== undefined ? `, issued by ${escape(String(r.vhl.issuer))}` : '') +
    (r.vhl.verified === true ? `, <b>signature good</b> (${escape(r.vhl.verifiedBy || '')})` : r.vhl.verified === false ? ', <b style="color: #c62828">signature NOT good</b>' : ', signature not checked') + ' &nbsp;|&nbsp; ' : '') +
    (p.url ? `${escape(p.url)} &nbsp;|&nbsp; flags: ${escape(flagWords(p.flag))}` : '') +
    (typeof p.exp === 'number' ? ` &nbsp;|&nbsp; expires ${escape(new Date(p.exp * 1000).toISOString())}` : '') +
    ` &nbsp;|&nbsp; opened ${escape(view.created)}; this page is kept until ${escape(view.expires)}</div></div>`;
  if (message) {
    h += `<div class="alert alert-danger">${escape(message)}</div>`;
  }
  if (r.state === 'needs-passcode') {
    if (r.message) {
      h += `<div class="alert alert-danger">${escape(r.message)}</div>`;
    }
    h += `<form method="post" action="${vurl}" class="ips-view-add"><label for="ips-view-passcode">This link needs a passcode</label>` +
      '<input type="password" id="ips-view-passcode" name="passcode" required autocomplete="off"/> <button type="submit" class="btn btn-primary">Open</button>' +
      '<div class="ips-small">The SHL server may allow only a few wrong passcodes before it disables the link.</div></form>';
  } else if (r.state === 'failed') {
    h += `<div class="alert alert-danger">The document could not be retrieved: ${escape(r.message || 'see the log below')}</div>`;
  }
  const docs = Array.isArray(r.documents) ? r.documents : [];
  docs.forEach((d, i) => {
    const s = summaryOf(d.bundle);
    h += '<div class="ips-view-doc">';
    h += `<div class="ips-patient"><b>${escape(s.patient_name || '(no name)')}</b>` + (s.patient_gender ? `, ${escape(s.patient_gender)}` : '') +
      (s.patient_birth ? `, born ${escape(s.patient_birth)}` : '') + '</div>';
    h += '<div class="ips-facts">' + (s.comp_title ? `${escape(s.comp_title)} &nbsp;|&nbsp; ` : '') + (s.comp_date ? `Document date ${escape(s.comp_date)} &nbsp;|&nbsp; ` : '') +
      `${(d.bundle.entry || []).length} entries` + (docs.length > 1 ? ` &nbsp;|&nbsp; document ${i + 1} of ${docs.length}` : '') + '</div>';
    for (const a of (r.added || []).filter(x => x.doc === i)) {
      h += `<div class="alert alert-success">Added to <a href="${base}/${encodeURIComponent(a.project)}">${escape(a.name)}</a> as ` +
        `<a href="${base}/${encodeURIComponent(a.project)}/Bundle/${a.id}">document ${a.id}</a>.</div>`;
    }
    if (d.ips) {
      const dups = (ctx.duplicates || [])[i] || [];
      if (dups.length > 0) {
        h += '<div class="alert alert-warning">This document (the same Bundle.identifier) is already here: ' +
          dups.map(x => `<a href="${base}/${encodeURIComponent(x.project_code)}/Bundle/${x.id}">${escape(x.project_name)}, document ${x.id}</a>`).join('; ') + '.</div>';
      }
      const projects = ctx.projects || [];
      if (projects.length === 0) {
        h += '<p class="ips-small"><i>There are no projects to add the document to.</i></p>';
      } else {
        h += `<form method="post" action="${vurl}/add" class="ips-view-add">${csrfField(ctx.csrf)}<input type="hidden" name="doc" value="${i}"/>` +
          `<label for="ips-view-project-${i}">Add it to a project</label><select id="ips-view-project-${i}" name="project" required><option value="">(choose)</option>` +
          projects.map(x => `<option value="${escape(x.code)}">${escape(x.name)}${x.label ? ' ' + escape(x.label) : ''}${x.ai ? ' (AI assessment)' : ''}</option>`).join('') + '</select>' +
          `<label for="ips-view-token-${i}">Submission token</label><input type="password" id="ips-view-token-${i}" name="token" autocomplete="off" placeholder="if the project needs one"/>` +
          '<button type="submit" class="btn btn-default">Add</button>' +
          '<div class="ips-small"><b>Adding the document to a project makes it visible to everyone</b>: anyone can list, search and read a project\'s documents. ' +
          'It is processed like any other document (validated, translated and checked) - and, in a project marked AI assessment, sent to an external AI service.</div></form>';
      }
    } else {
      h += '<p class="ips-small"><i>This is not an IPS document (its Composition type is not LOINC 60591-5), so it can\'t be added to a project.</i></p>';
    }
    h += assembledNarrative(d.bundle);
    h += '</div>';
  });
  h += '<h3>What the viewer did</h3>';
  h += traceHtml(r.trace?.entries);
  h += '<div class="ips-explain"><p class="ips-small">Each step the viewer took to retrieve the document: the link decoded, each request and what came back (headers and body - open the details), ' +
    'the key, the decryption, and what the content is. The narrative is the document\'s own, as submitted. ' +
    `<a href="${base}/view">Open another link</a>.</p></div>`;
  return h;
}

// ---- the processing queue ----------------------------------------------------------------

/** A step's average time: "850 ms", "4.2 s", "1 min 12 s". */
function stepTimeText(ms) {
  if (ms < 1000) {
    return `${Math.round(ms)} ms`;
  }
  return ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : durationText(ms);
}

/** Time per KB: "0.42 ms/KB", "35 ms/KB". */
function perKbText(v) {
  if (v === null || v === undefined) {
    return '--';
  }
  return `${v < 10 ? v.toFixed(2) : Math.round(v).toLocaleString('en-US')} ms/KB`;
}

/** "12 s", "3 min 4 s" */
function durationText(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  return sec < 60 ? `${sec} s` : `${Math.floor(sec / 60)} min ${sec % 60} s`;
}

/**
 * The processing queue (one for the whole module): the document being processed and the
 * step it is up to, then the documents waiting, in the order they will be processed.
 * @param {{processing: Array, waiting: Array, waitingTotal: number}} q - store.queue(), with
 *   the processing rows' results, step, startedMs and stepStartedMs filled in
 * @param {{state: string, text: string}} state - whether the queue is being worked through
 * @param {Object} ctx - with steps (the step names, in order) and now (ms)
 */
function renderQueue(q, state, ctx) {
  const base = escape(ctx.base);
  const docUrl = (r) => `${base}/${encodeURIComponent(r.project_code)}/Bundle/${r.id}`;
  const docLink = (r) => `<a href="${base}/${encodeURIComponent(r.project_code)}">${escape(r.project_name)}</a> &raquo; <a href="${docUrl(r)}">Document ${r.id}</a>`;
  let h = STYLE + userBar(ctx) + crumbs(ctx, null, 'Processing queue');
  h += '<div class="ips-banner"><b class="ips-project-name">Processing queue</b></div>';
  h += `<p class="ips-queue-state ips-queue-${escape(state.state)}">${escape(state.text)}.</p>`;

  h += '<h3>Now processing</h3>';
  if (q.processing.length === 0) {
    h += '<p><i>No document is being processed.</i></p>';
  }
  for (const r of q.processing) {
    h += '<div class="ips-queue-current">';
    h += `<p>${docLink(r)}: <b>${escape(r.patient_name || '(no name)')}</b>` + (r.comp_title ? ` - ${escape(r.comp_title)}` : '') +
      ` <span class="ips-small">(received ${escape(r.received)}, ${r.size.toLocaleString('en-US')} bytes)</span></p>`;
    h += '<div class="ips-steps">' + stepsHtml({ ...r, status: 'processing' }, { steps: ctx.steps, canManage: false }, docUrl(r)) + '</div>';
    const label = r.step ? (STEP_LABELS[r.step] || [r.step])[0] : null;
    h += '<p>' + (label ? `Up to: <b>${escape(label)}</b>` + (r.stepStartedMs ? ` (for ${escape(durationText(ctx.now - r.stepStartedMs))})` : '') : 'Starting') +
      (r.startedMs ? `; processing for ${escape(durationText(ctx.now - r.startedMs))}` : '') + '</p>';
    h += '</div>';
  }

  h += `<h3>Waiting${q.waitingTotal ? ` (${q.waitingTotal})` : ''}</h3>`;
  if (q.waiting.length === 0) {
    h += '<p><i>Nothing is waiting to be processed.</i></p>';
  } else {
    h += '<table class="table table-condensed ips-table"><thead><tr><th>#</th><th>Document</th><th>Patient</th><th>Title</th><th>Received</th><th>Size</th></tr></thead><tbody>';
    q.waiting.forEach((r, i) => {
      h += `<tr><td>${i + 1}</td><td>${docLink(r)}</td><td>${escape(r.patient_name || '(no name)')}</td><td>${escape(r.comp_title || '')}</td>` +
        `<td class="ips-date">${escape(r.received)}</td><td>${r.size.toLocaleString('en-US')}</td></tr>`;
    });
    h += '</tbody></table>';
    if (q.waitingTotal > q.waiting.length) {
      h += `<p class="ips-small">and ${q.waitingTotal - q.waiting.length} more.</p>`;
    }
  }

  // how long each step takes, built up as documents are processed
  h += '<h3>How long the steps take</h3>';
  const timings = ctx.timings || {};
  h += '<table class="table table-condensed ips-table ips-step-times"><thead><tr><th>Step</th><th>Average</th><th>Per KB of document</th><th>Runs averaged</th><th>Last run</th></tr></thead><tbody>';
  for (const step of ctx.steps || []) {
    const t = timings[step];
    const label = (STEP_LABELS[step] || [step])[0];
    h += t
      ? `<tr><td>${escape(label)}</td><td>${escape(stepTimeText(t.avgMs))}</td><td>${escape(perKbText(t.msPerKb))}</td><td>${t.runs}</td><td class="ips-date">${escape(t.last)}</td></tr>`
      : `<tr><td>${escape(label)}</td><td colspan="4"><i>not measured yet</i></td></tr>`;
  }
  h += '</tbody></table>';
  h += `<p class="ips-small">Over each step's most recent ${STEP_TIMINGS_SAMPLE} runs. Only runs where the step did its work count: not one that failed, nor one that was skipped ` +
    '(an AI assessment that is turned off, say). Per KB is all the time over all the KB of document (as stored), so big documents count for what they are.</p>';

  // refreshing: on unless turned off (the choice is remembered in the browser); without script, a link
  h += '<p class="ips-small"><a href="">Refresh</a> <label class="ips-queue-auto" hidden><input type="checkbox" id="ips-queue-auto"/> Refresh every 5 seconds</label></p>';
  h += '<div class="ips-explain"><p class="ips-small">There is one processing queue for all the projects: documents are processed one at a time, oldest first, ' +
    'each through every step of the pipeline in turn (the line of steps shows where the document being processed is up to; each step links to the view of its work). ' +
    'A document goes back in the queue when a manager asks for it to be processed again.</p></div>';
  h += `<script>
(function () {
  var KEY = 'fhirsmith.ips.queue.autoRefresh';
  var box = document.getElementById('ips-queue-auto');
  if (!box) { return; }
  box.closest('.ips-queue-auto').hidden = false;
  var timer = null;
  function apply() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (box.checked) { timer = setTimeout(function () { window.location.reload(); }, 5000); }
  }
  try { box.checked = window.localStorage.getItem(KEY) !== '0'; } catch (e) { box.checked = true; }
  apply();
  box.addEventListener('change', function () {
    try { window.localStorage.setItem(KEY, box.checked ? '1' : '0'); } catch (e) { /* not remembered */ }
    apply();
  });
})();
</script>`;
  return h;
}

/**
 * The source of the document: the original (as submitted), or the modified copy (the analysed
 * copy - what the processing ended up with: translations added, the generated narrative, the
 * terminology check's extensions), with the buttons that share whichever is shown.
 */
function renderSource(row, durl, ctx) {
  const modified = ctx.source === 'modified';
  let h = '<div class="ips-switch">' +
    `<a href="${durl}?view=source"${modified ? '' : ' class="active"'} title="The document as it was submitted">Original</a>` +
    `<a href="${durl}?view=source&amp;source=modified"${modified ? ' class="active"' : ''} title="The document as the processing left it: with the translations, the generated narrative and the terminology check">Modified</a></div>`;
  const doc = modified ? row.analysed : row.bundle;
  if (!doc) {
    return h + '<p><i>There is no modified copy of this document: it has not been processed yet.</i></p>';
  }
  h += documentBanner(durl, modified, { ...ctx, hasComment: !!row.comment });
  h += '<p class="ips-small">The same downloads and shares can be had from the API, with the ' +
    '<a href="https://github.com/HealthIntersections/FHIRsmith/blob/main/ips/OperationDefinition-ips-document.json"><code>$document</code></a> operation: ' +
    `<code>${escape(durl)}/$document</code>.</p>`;
  h += `<pre class="ips-json">${sourceJsonHtml(doc)}</pre>`;
  h += '<div class="ips-explain"><p class="ips-small">Original is the document as it was submitted. Modified is what the processing ended up with: ' +
    'codings added to CodeableConcepts by translation (marked with an extension saying where they came from), the narrative generated by this server, ' +
    'and an extension on each CodeableConcept recording the terminology check. The original is never changed. Either can be downloaded (as JSON, a ZIP, or a PDF with the document attached), or shared, as a SMART Health Link or a Verifiable Health Link.</p></div>';
  return h;
}

/**
 * The Sign choices on the source view's banner (ctx.signing, from ips.js signingState): the
 * user (enabled for a logged in user with a key pair of a type signatures.js signs with) and
 * the system (enabled when it has one). Each disabled choice says why. Shown only when scripts
 * run: the downloads and shares send the choices from the page
 */
function signChoices(ctx) {
  const s = ctx.signing;
  if (!s) {
    return '';
  }
  const words = (s.types || []).join(' or ');
  const choice = (name, label, keyId, why) => `<label class="ips-sign-choice${keyId ? '' : ' ips-sign-off'}">` +
    `<input type="checkbox" name="${name}"${keyId ? ` data-key="${escape(keyId)}"` : ' disabled'}/> ${label}</label>` +
    (keyId ? '' : ` <span class="ips-small">(${why})</span>`);
  let h = '<div class="ips-doc-banner-group ips-sign" hidden><span class="ips-doc-banner-label">Sign document</span>';
  if (s.user) {
    h += choice('sign-user', escape(s.user.name), s.user.keyId, `you have no ${escape(words)} key pair: <a href="/keys/mine">make one</a>`) +
      (s.user.keyId ? ' <span class="ips-small">(the signature names you: your name and email)</span>' : '');
  } else {
    h += choice('sign-user', 'You', null, `<a href="${escape(`/auth/login?return=${encodeURIComponent(ctx.here || '/')}`)}">log in</a> to sign as yourself`);
  }
  h += ' ' + choice('sign-system', 'System', s.system.keyId, `the system has no ${escape(words)} key pair`);
  return h + '</div>';
}

/**
 * The banner over the source view: what can be done with whichever copy is shown (the original,
 * or the modified copy) - sign it (signChoices), download it (JSON, a ZIP, or a PDF with the
 * document attached), and share it as a QR code (when sharing is set up). JSON is a link, and
 * sharing forms, so they work without scripts; the ZIP and the PDF are made in the browser
 * (doc-actions.js), so their buttons show only when scripts run, as signing does. With a Sign
 * choice ticked, each download and share is of a signed copy, made by the server when asked
 * ({durl}/signed, and the share forms' signUser and signSystem); it isn't kept. When the document
 * has patient comments, "Include Patient Comments" adds them to each download and share the same
 * way (comments), after any signing; "Regenerate narrative" (narrative) has the server generate the
 * narrative first, as the narrative step does
 */
function documentBanner(durl, modified, ctx) {
  const which = modified ? 'modified' : 'original';
  const what = modified ? 'the modified copy of this document' : 'this document';
  const jsonUrl = `${durl}?download=1${modified ? '&amp;source=modified' : ''}`;
  const fileName = `ips-${ctx.projectCode || 'document'}-${ctx.docId}${modified ? '-modified' : ''}`;
  const vendor = {
    jspdf: assets.src(ctx.base, 'vendor/jspdf.umd.min.js'), html2canvas: assets.src(ctx.base, 'vendor/html2canvas.min.js'),
    pdflib: assets.src(ctx.base, 'vendor/pdf-lib.min.js'), zip: assets.src(ctx.base, 'vendor/zip.min.js')
  };
  let h = `<div class="ips-doc-banner" data-json="${escape(`${durl}?_format=json${modified ? '&source=modified' : ''}`)}" data-name="${escape(fileName)}" data-vendor="${escape(JSON.stringify(vendor))}"` +
    ` data-signed="${escape(`${durl}/signed`)}" data-source="${which}" data-csrf="${escape(ctx.csrf || '')}">`;
  h += signChoices(ctx);
  // the narrative regenerated, as the narrative view's Generated shows it (before any signing)
  h += '<div class="ips-doc-banner-group ips-narrative-choice" hidden><label class="ips-sign-choice">' +
    '<input type="checkbox" name="regenerate-narrative"/> Regenerate narrative</label>' +
    ' <span class="ips-small">(as the Narrative tab\'s Generated shows it, before signing)</span></div>';
  // the patient's comments, when there are some: added to each copy after it is signed (not signed)
  if (ctx.hasComment) {
    h += '<div class="ips-doc-banner-group ips-comments-choice" hidden><label class="ips-sign-choice">' +
      '<input type="checkbox" name="include-comments"/> Include Patient Comments</label>' +
      ' <span class="ips-small">(as the first section, added after signing: they are not signed)</span></div>';
  }
  h += '<div class="ips-doc-banner-group"><span class="ips-doc-banner-label">Download</span>' +
    `<a class="btn btn-default ips-download-json" href="${jsonUrl}" title="${escape(`${what} (FHIR JSON)`)}">JSON</a>` +
    `<button type="button" class="btn btn-default ips-download" data-kind="zip" title="${escape(`${what}, in a ZIP file`)}" hidden>ZIP</button>` +
    `<button type="button" class="btn btn-default ips-download" data-kind="pdf" title="${escape(`${what} as a PDF, with the document attached to it`)}" hidden>PDF</button></div>`;
  if (ctx.canShare) {
    // sharing as a QR code: a form each (they work without scripts); with scripts, the
    // page asks for JSON and shows the code in a panel over the page
    const form = (kind, title, label) => `<form method="post" action="${durl}/share" class="ips-inline ips-share-form">` + csrfField(ctx.csrf) +
      `<input type="hidden" name="source" value="${which}"/><input type="hidden" name="kind" value="${kind}"/>` +
      '<input type="hidden" name="signUser" value=""/><input type="hidden" name="signSystem" value=""/><input type="hidden" name="comments" value=""/><input type="hidden" name="narrative" value=""/>' +
      `<button type="submit" class="btn btn-default" title="${escape(title)}">${label}</button></form>`;
    h += '<div class="ips-doc-banner-group"><span class="ips-doc-banner-label">Share</span>' +
      form('shl', `A SMART Health Link to ${what}, as a QR code`, 'SHL') +
      form('vhl', `A Verifiable Health Link (GDHCN) to ${what}, as a QR code`, 'VHL') + '</div>';
  }
  h += '<div class="ips-doc-banner-message" role="status"></div></div>';
  if (ctx.canShare) {
    h += sharePanelScript();
  }
  h += `<script src="${escape(scripts.src(ctx.base, 'doc-actions.js'))}"></script>` + `<script>
(function () {
  var banner = document.querySelector('.ips-doc-banner');
  if (!banner || !window.IpsDocActions) { return; }
  var message = banner.querySelector('.ips-doc-banner-message');
  var vendor = JSON.parse(banner.getAttribute('data-vendor'));
  var sign = banner.querySelector('.ips-sign');
  var signUser = banner.querySelector('[name=sign-user]');
  var signSystem = banner.querySelector('[name=sign-system]');
  var comments = banner.querySelector('[name=include-comments]');
  var narrative = banner.querySelector('[name=regenerate-narrative]');
  if (sign) { sign.hidden = false; }
  if (narrative) { banner.querySelector('.ips-narrative-choice').hidden = false; }
  if (comments) { banner.querySelector('.ips-comments-choice').hidden = false; }
  function signing() {
    return { user: !!(signUser && signUser.checked), system: !!(signSystem && signSystem.checked), comments: !!(comments && comments.checked), narrative: !!(narrative && narrative.checked) };
  }
  // the share forms send the choices too
  function syncShares() {
    var s = signing();
    banner.querySelectorAll('.ips-share-form').forEach(function (f) {
      f.querySelector('[name=signUser]').value = s.user ? '1' : '';
      f.querySelector('[name=signSystem]').value = s.system ? '1' : '';
      f.querySelector('[name=comments]').value = s.comments ? '1' : '';
      f.querySelector('[name=narrative]').value = s.narrative ? '1' : '';
    });
  }
  [signUser, signSystem, comments, narrative].forEach(function (c) { if (c) { c.addEventListener('change', syncShares); } });
  syncShares();
  // the document as JSON text: as stored, or a copy the server makes now (signed, with the patient's comments)
  function documentJson() {
    var s = signing();
    var req = s.user || s.system || s.comments || s.narrative
      ? fetch(banner.getAttribute('data-signed'), { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/fhir+json', 'X-CSRF-Token': banner.getAttribute('data-csrf') },
        body: JSON.stringify({ source: banner.getAttribute('data-source'), user: s.user, system: s.system, comments: s.comments, narrative: s.narrative }) })
      : fetch(banner.getAttribute('data-json'), { headers: { Accept: 'application/fhir+json' }, credentials: 'same-origin' });
    return req.then(function (r) {
      return r.text().then(function (t) {
        if (!r.ok) { var m = 'HTTP ' + r.status; try { m = JSON.parse(t).error || m; } catch (e) { /* not JSON */ } throw new Error(m); }
        return t;
      });
    });
  }
  function fileName() {
    var s = signing();
    return banner.getAttribute('data-name') + (s.user || s.system ? '-signed' : '');
  }
  function run(kind, button) {
    var label = kind.toUpperCase();
    if (button) { button.disabled = true; }
    var s = signing();
    message.textContent = (s.narrative ? 'Generating the narrative, and making the ' : s.user || s.system ? 'Signing, and making the ' : 'Making the ') + label + '...';
    documentJson()
      .then(function (json) {
        return window.IpsDocActions.download(kind, { json: json, bundle: JSON.parse(json), name: fileName(), vendor: vendor });
      })
      .then(function () { message.textContent = ''; })
      .catch(function (e) { message.textContent = 'The ' + label + ' could not be made: ' + e.message; })
      .finally(function () { if (button) { button.disabled = false; } });
  }
  // JSON is a link (it works without scripts); signed, it is made here
  var jsonLink = banner.querySelector('.ips-download-json');
  if (jsonLink) {
    jsonLink.addEventListener('click', function (e) {
      var s = signing();
      if (s.user || s.system || s.comments || s.narrative) {
        e.preventDefault();
        run('json', null);
      }
    });
  }
  banner.querySelectorAll('.ips-download').forEach(function (b) {
    b.hidden = false;
    b.addEventListener('click', function () { run(b.getAttribute('data-kind'), b); });
  });
})();
</script>`;
  return h;
}

/**
 * The anchor for a document entry in the source view: the resource's type/id, or the entry's
 * fullUrl when the resource has no id - the resource part of the key a report gives it
 * (reports.js keyFor), so a report row can link to its resource.
 */
function entryAnchor(entry) {
  const r = isObject(entry) && isObject(entry.resource) ? entry.resource : null;
  if (r && text(r.resourceType) && text(r.id)) {
    return `${r.resourceType}/${r.id}`;
  }
  return isObject(entry) && text(entry.fullUrl) ? entry.fullUrl : null;
}

/**
 * A Bundle as pretty-printed JSON, each entry wrapped in a span with the entry's anchor as its
 * id (highlighted when it is the page's target).
 */
function sourceJsonHtml(doc) {
  if (!isObject(doc) || !Array.isArray(doc.entry) || doc.entry.length === 0) {
    return escape(JSON.stringify(doc, null, 2));
  }
  // each entry's place is held by a marker string, replaced by the entry - indented to fit - in its span
  const markers = doc.entry.map((e, i) => `\u0000entry${i}\u0000`);
  const json = escape(JSON.stringify({ ...doc, entry: markers }, null, 2));
  // (escape() has made the marker's quotes &quot;)
  return json.replace(/^( *)(?:"|&quot;)\\u0000entry(\d+)\\u0000(?:"|&quot;)(,?)$/gm, (m, indent, n, comma) => {
    const entry = doc.entry[Number(n)];
    const body = escape(JSON.stringify(entry, null, 2)).split('\n').map((l, i) => (i === 0 ? l : indent + l)).join('\n');
    const anchor = entryAnchor(entry);
    return indent + (anchor ? `<span class="ips-entry" id="${escape(anchor)}">${body}</span>` : body) + comma;
  });
}

/** The QR code and its links, as the share page and the panel show them. */
function shareHtml(out) {
  const kind = out.kind === 'vhl' ? 'VHL' : 'SHL';
  let h = `<div class="ips-share-code">${out.qr}</div>`;
  h += `<p class="ips-small">${kind === 'VHL' ? 'A Verifiable Health Link, signed as the GDHCN does it: the code carries the signed link' : 'A SMART Health Link: the code opens the document in a viewer'}; ` +
    `the document is encrypted on the SHL server until ${escape(dateText(out.expires))}. Scan it, or copy what it carries:</p>`;
  h += `<p><textarea class="ips-share-text" readonly rows="3">${escape(out.text)}</textarea></p>`;
  h += `<p class="ips-small">Manifest: <a href="${escape(out.link)}">${escape(out.link)}</a></p>`;
  return h;
}

/** The page a share lands on when the browser has no scripts. */
function renderShare(project, row, out, ctx) {
  const durl = `${projectUrl(ctx, project)}/Bundle/${row.id}`;
  let h = STYLE + userBar(ctx) + crumbs(ctx, project, `Document ${row.id}`);
  h += `<h3>Document ${row.id}${out.source === 'modified' ? ' (modified)' : ''} as ${out.kind === 'vhl' ? 'a VHL' : 'an SHL'}</h3>`;
  h += shareHtml(out);
  h += `<p><a href="${durl}">Back to the document</a></p>`;
  return h;
}

/** The panel over the page that shows a share, and the script that asks for one. */
function sharePanelScript() {
  return '<div id="ips-share" class="ips-share-overlay" hidden><div class="ips-share-panel"><button type="button" class="close ips-share-close" aria-label="Close">&times;</button><div class="ips-share-body"></div></div></div>' +
    `<script>
(function () {
  var overlay = document.getElementById('ips-share');
  var body = overlay.querySelector('.ips-share-body');
  var escapeHtml = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var close = function () { overlay.hidden = true; body.innerHTML = ''; };
  overlay.querySelector('.ips-share-close').addEventListener('click', close);
  overlay.addEventListener('click', function (e) { if (e.target === overlay) { close(); } });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !overlay.hidden) { close(); } });
  var fmt = function (d) { var m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']; var x = new Date(d); return isNaN(x) ? d : ('0' + x.getDate()).slice(-2) + '-' + m[x.getMonth()] + ' ' + String(x.getFullYear()).slice(-2); };
  document.querySelectorAll('.ips-share-form').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var kind = form.querySelector('[name=kind]').value;
      var fields = new URLSearchParams(new FormData(form)).toString();
      var button = form.querySelector('button');
      button.disabled = true;
      body.innerHTML = '<p><i>Preparing the ' + kind.toUpperCase() + '...</i></p>';
      overlay.hidden = false;
      fetch(form.action, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' }, body: fields, credentials: 'same-origin' })
        .then(function (r) { return r.json().then(function (j) { if (!r.ok) { throw new Error(j.error || ('HTTP ' + r.status)); } return j; }); })
        .then(function (out) {
          var name = out.kind === 'vhl' ? 'VHL' : 'SHL';
          body.innerHTML = '<h3>' + name + '</h3><div class="ips-share-code">' + out.qr + '</div>' +
            '<p class="ips-small">' + (name === 'VHL' ? 'A Verifiable Health Link, signed as the GDHCN does it: the code carries the signed link' : 'A SMART Health Link: the code opens the document in a viewer') +
            '; the document is encrypted on the SHL server until ' + escapeHtml(fmt(out.expires)) + '. Scan it, or copy what it carries:</p>' +
            '<p><textarea class="ips-share-text" readonly rows="3">' + escapeHtml(out.text) + '</textarea> <button type="button" class="btn btn-default ips-btn ips-share-copy">Copy</button></p>' +
            '<p class="ips-small">Manifest: <a href="' + escapeHtml(out.link) + '">' + escapeHtml(out.link) + '</a></p>';
          var copy = body.querySelector('.ips-share-copy');
          copy.addEventListener('click', function () {
            var t = body.querySelector('.ips-share-text');
            var done = function () { copy.textContent = 'Copied'; setTimeout(function () { copy.textContent = 'Copy'; }, 1200); };
            if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(t.value).then(done, function () { t.select(); }); } else { t.select(); }
          });
        })
        .catch(function (err) { body.innerHTML = '<p class="text-danger">Could not share the document: ' + escapeHtml(err.message) + '</p>'; })
        .finally(function () { button.disabled = false; });
    });
  });
})();
</script>`;
}

// the views of a document, as tabs
const VIEWS = [
  ['narrative', 'Narrative'],
  ['structure', 'Structure'],
  ['analysis', 'Analysis'],
  ['translation', 'Translation'],
  ['terminology', 'Terminology'],
  ['validation', 'Validation'],
  ['national', 'Jurisdictions'],
  ['profiles', 'Clinical Profiles'],
  ['ai', 'AI Check'],
  ['comments', 'Patient Comments'],
  ['source', 'Source']
];

// views that were tabs once, so old links still land: generated is now the narrative
// tab's switch, json is now source
const VIEW_ALIASES = {
  generated: { view: 'narrative', narrative: 'generated' },
  json: { view: 'source' }
};

/**
 * The view a request asks for (?view=, and ?narrative= for the narrative tab's switch):
 * the default when it names none we know.
 * @returns {{view: string, narrative: string, source: string}} narrative is 'provided' or 'generated'; source is 'original' or 'modified'
 */
function viewOf(query = {}) {
  const v = typeof query.view === 'string' ? query.view : '';
  const alias = VIEW_ALIASES[v];
  const view = alias ? alias.view : VIEWS.some(([k]) => k === v) ? v : VIEWS[0][0];
  const narrative = alias?.narrative || (query.narrative === 'generated' ? 'generated' : 'provided');
  const source = query.source === 'modified' ? 'modified' : 'original';
  return { view, narrative, source };
}

/**
 * A document.
 * @param {Object} project
 * @param {Object} row - from store.read(): the columns and .bundle
 * @param {string} view - one of VIEWS
 * @param {{base: string, user?: Object, csrf?: string, canManage?: boolean}} ctx
 */
// the processing steps, as the page shows them: [state, symbol, label]
const STEP_STATES = {
  done: ['done', '&#10003;', 'done'],
  failed: ['failed', '&#10007;', 'failed'],
  running: ['running', '&#9881;', 'running'],
  waiting: ['waiting', '&#9790;', 'waiting']
};

/**
 * Where each processing step is with the document - from the step results, read against
 * the document's own status: a document still in the queue has every step waiting, a
 * document that finished with no result rows (processed before steps were recorded) has
 * every step done.
 */
function stepState(row, step) {
  const r = row.results?.[step]?.result;
  if (r && STEP_STATES[r.status]) {
    return { state: r.status, message: r.message || null };
  }
  if (row.status === 'processed') {
    return { state: 'done', message: null };
  }
  return { state: 'waiting', message: null };
}

// each step as the pipeline shows it, and the view that shows its work (as a query)
const STEP_LABELS = {
  signatures: ['Signatures', 'view=analysis'],
  nationality: ['Jurisdiction', 'view=analysis'],
  analysis: ['Analysis', 'view=analysis'],
  translate: ['Translate', 'view=translation'],
  narrative: ['Narrative', 'view=narrative&narrative=generated'],
  validation: ['Validation', 'view=validation'],
  national: ['Jurisdictions', 'view=national'],
  terminology: ['Terminology', 'view=terminology'],
  profiles: ['Clinical Profiles', 'view=profiles'],
  ai: ['AI Check', 'view=ai'],
  reports: ['Reports', null]
};

/**
 * The processing pipeline as one connected line: the document's receipt, then each step
 * in the order they run, each coloured by where it is and linked to the view of its work.
 */
function stepsHtml(row, ctx, durl) {
  let h = `<span class="ips-step ips-step-received" title="${escape(`received ${row.received} (${row.source})`)}">Received</span>`;
  for (const step of ctx.steps || []) {
    const { state, message } = stepState(row, step);
    const [, symbol, word] = STEP_STATES[state];
    // a failure's reason can name the inside of the server: for managers
    const detail = message && (state !== 'failed' || ctx.canManage) ? `: ${message}` : '';
    const [label, query] = STEP_LABELS[step] || [step, null];
    const attrs = `class="ips-step ips-step-${state}" title="${escape(`${label.toLowerCase()} - ${word}${detail}`)}"`;
    const inner = `<span class="ips-step-icon">${symbol}</span> ${escape(label)}`;
    h += query && durl ? `<a ${attrs} href="${escape(`${durl}?${query}`)}">${inner}</a>` : `<span ${attrs}>${inner}</span>`;
  }
  return `<div class="ips-pipeline">${h}</div>`;
}

function renderDocument(project, row, view, ctx) {
  const purl = projectUrl(ctx, project);
  const durl = `${purl}/Bundle/${row.id}`;
  let h = STYLE + userBar(ctx) + crumbs(ctx, project, `Document ${row.id}`);

  // the banner: where from (a flag), who and what
  h += '<div class="ips-banner ips-banner-flagged">' + nationalityFlag(row.results?.nationality?.result) + '<div>';
  h += `<div class="ips-patient"><b>${escape(row.patient_name || '(no name)')}</b>` +
    (row.patient_gender ? `, ${escape(row.patient_gender)}` : '') +
    (row.patient_birth ? `, born ${escape(row.patient_birth)}` : '') + '</div>';
  h += '<div class="ips-facts">' +
    (row.comp_date ? `Document date ${escape(row.comp_date)} &nbsp;|&nbsp; ` : '') +
    `Received ${escape(row.received)} (${escape(row.source)})${row.submitted_by ? ` from ${escape(row.submitted_by)}` : ''} &nbsp;|&nbsp; ${row.size.toLocaleString()} bytes` +
    ` &nbsp;|&nbsp; <a href="${durl}?_format=json">FHIR JSON</a></div>`;
  if (row.patient_id) {
    h += `<div class="ips-facts">Patient <a href="${purl}/Patient/${row.patient_id}">#${row.patient_id}</a>` +
      (row.match ? `: ${escape(MATCH_WORDS[row.match.method] || row.match.method)}${row.match.method === 'new' && row.match.detail !== 'Not seen before' ? ` - ${escape(row.match.detail.replace(/^Not seen before \((.*)\)$/, '$1'))}` : ''}` : '') + '</div>';
  }
  h += '</div></div>';

  // the steps, then (on a line of their own) what can be done
  h += '<div class="ips-steps">' + stepsHtml(row, ctx, durl) + '</div>';
  {
    h += '<div class="ips-doc-actions">';
    // a form like the others, so it looks like them
    h += `<form method="get" action="${purl}/compose/general" class="ips-inline"><input type="hidden" name="from" value="${row.id}"/><button type="submit" class="btn btn-default" title="Open this document in the editor; submitting makes a new document">Edit</button></form>`;
    if (ctx.canManage) {
      h += `<form method="post" action="${durl}/requeue" class="ips-inline">${csrfField(ctx.csrf)}<button type="submit" class="btn btn-default">Process again</button></form>` +
        `<form method="post" action="${durl}/delete" class="ips-inline" data-confirm="${escape(`Delete document ${row.id}?`)}">${csrfField(ctx.csrf)}<button type="submit" class="btn btn-danger">Delete</button></form>`;
    }
    h += '</div>';
  }
  // the views, as tabs
  h += '<ul class="nav nav-tabs ips-nav">' + VIEWS.map(([v, label]) =>
    `<li${v === view ? ' class="active"' : ''}><a href="${durl}?view=${v}">${label}</a></li>`).join('') + '</ul>';

  if (view === 'structure') {
    h += renderStructure(row.bundle);
  } else if (view === 'analysis') {
    h += renderAnalysis(row, { canManage: ctx.canManage });
  } else if (view === 'source') {
    h += renderSource(row, durl, { ...ctx, projectCode: project.code, docId: row.id });
  } else if (view === 'terminology') {
    // the analysed copy carries the checks; the concepts are the same
    h += renderTerminology(row.analysed || row.bundle, { ...ctx, analysed: !!row.analysed, docUrl: durl });
  } else if (view === 'translation') {
    h += renderTranslation(row, { canManage: ctx.canManage });
  } else if (view === 'profiles') {
    h += renderProfileChecks(row, { base: ctx.base, canManage: ctx.canManage });
  } else if (view === 'ai') {
    h += renderAi(row, { canManage: ctx.canManage });
  } else if (view === 'comments') {
    h += renderPatientComments(row, { ...ctx, docUrl: durl });
  } else if (view === 'validation') {
    h += renderValidation(row, { level: ctx.level, docUrl: durl, canManage: ctx.canManage });
  } else if (view === 'national') {
    h += renderNational(row, { np: ctx.np, level: ctx.level, docUrl: durl, base: ctx.base, canManage: ctx.canManage });
  } else {
    // the narrative: as provided in the document, or as this server generates it
    const generated = ctx.narrative === 'generated';
    h += '<div class="ips-switch">' +
      `<a href="${durl}?view=narrative"${generated ? '' : ' class="active"'} title="The narrative in the document as it was submitted">Provided</a>` +
      `<a href="${durl}?view=narrative&amp;narrative=generated"${generated ? ' class="active"' : ''} title="The narrative this server generates for the document">Generated</a></div>`;
    h += generated ? renderGenerated(row, { canManage: ctx.canManage }) : assembledNarrative(row.bundle);
  }
  return h;
}

// ---- reports -------------------------------------------------------------------------------

function reportCrumbs(ctx, extra) {
  let h = `<p class="ips-small"><a href="${escape(ctx.base)}">IPS projects</a> &raquo; <a href="${escape(ctx.base)}/reports">Reports</a>`;
  return h + (extra ? ` &raquo; ${escape(extra)}` : '') + '</p>';
}

/** Where a report's table is up to, in words. */
function reportStateText(build) {
  if (!build) {
    return '';
  }
  const docs = (n) => `${n} document${n === 1 ? '' : 's'}`;
  let t;
  if (build.state === 'ready') {
    t = `Ready (${docs(build.docs)})`;
  } else if (build.state === 'building') {
    t = `Being built: ${build.docs} of ${docs(build.total)} done`;
  } else {
    t = 'Waiting to be built';
  }
  if (build.state !== 'ready' && build.live) {
    t += ' - the previous table is shown meanwhile';
  }
  if (build.errors) {
    t += `; the view failed on ${docs(build.errors)}`;
  }
  return t;
}

const REPORT_EXPLANATION = 'A report is a table of data drawn from every document in a project by a SQL on FHIR ' +
  '<a href="https://sql-on-fhir.org/ig/StructureDefinition-ViewDefinition.html">ViewDefinition</a>, run over the documents as submitted, ' +
  'the documents as processed, or their validation outcomes, and SQL statements that summarise the table. The administrator defines the reports; ' +
  'each project shows them for its own documents.';

/** The list of reports (the administrator can add them). */
function renderReports(list, ctx, sources) {
  const base = escape(ctx.base);
  let h = STYLE + userBar(ctx) + `<p class="ips-small"><a href="${base}">IPS projects</a> &raquo; Reports</p>`;
  h += '<div class="ips-banner"><b class="ips-project-name">Reports</b></div>';
  h += `<p>${REPORT_EXPLANATION}${ctx.user?.isAdmin ? '' : ' Only the administrator can change them.'}</p>`;
  if (ctx.user?.isAdmin) {
    h += `<div class="ips-actions-line"><a class="btn btn-primary" href="${base}/reports/new">Add a report</a></div>`;
  }
  if (list.length === 0) {
    return h + '<p>There are no reports yet.</p>';
  }
  h += '<table class="table table-sm table-striped ips-table"><tr><th>Report</th><th>Table</th><th>Runs over</th><th>Statements</th><th>Table state</th></tr>';
  for (const r of list) {
    h += `<tr><td><a href="${base}/reports/${encodeURIComponent(r.id)}">${escape(r.title)}</a>` +
      (r.description ? `<br/><span class="ips-small">${escape(r.description)}</span>` : '') + '</td>' +
      `<td><code>${escape(r.id)}</code></td><td>${escape(sources[r.source] || r.source)}</td><td>${r.statements.length}</td>` +
      `<td>${escape(reportStateText(r.build))}</td></tr>`;
  }
  return h + '</table>';
}

/** A report's definition: everyone can see it; the administrator can edit, download and delete it. */
function renderReportDefinition(report, ctx, sources) {
  const base = escape(ctx.base);
  const rurl = `${base}/reports/${encodeURIComponent(report.id)}`;
  let h = STYLE + userBar(ctx) + reportCrumbs(ctx, report.title);
  h += `<div class="ips-banner"><div class="ips-project-name"><b>${escape(report.title)}</b></div>` +
    (report.description ? `<div class="ips-facts">${escape(report.description)}</div>` : '') + '</div>';
  h += '<div class="ips-actions-line">';
  if (ctx.user?.isAdmin) {
    h += `<a class="btn btn-primary" href="${rurl}/edit">Edit</a> ` +
      `<form method="post" action="${rurl}/delete" class="ips-inline" data-confirm="${escape(`Delete the report '${report.title}' and its table?`)}">${csrfField(ctx.csrf)}` +
      '<button type="submit" class="btn btn-default">Delete</button></form> ';
  }
  h += `<a class="btn btn-default" href="${rurl}?download=1">Download</a></div>`;
  h += '<table class="table table-sm ips-table">' +
    `<tr><td>Table</td><td><code>${escape(report.id)}</code></td></tr>` +
    `<tr><td>Runs over</td><td>${escape(sources[report.source] || report.source)}</td></tr>` +
    `<tr><td>Table state</td><td>${escape(reportStateText(report.build))}</td></tr></table>`;
  h += '<p class="ips-small">Each project shows this report for its own documents, under its Reports.</p>';
  h += '<h3>SQL statements</h3>';
  if (report.statements.length === 0) {
    h += '<p>None: the report is its table.</p>';
  }
  for (const s of report.statements) {
    h += `<h4>${escape(s.name)}</h4><pre class="ips-json">${escape(s.sql)}</pre>`;
  }
  h += '<h3>ViewDefinition</h3>' + `<pre class="ips-json">${escape(JSON.stringify(report.view, null, 2))}</pre>`;
  return h;
}

/**
 * The administrator's form for a report. form is what was posted (when it is being shown again
 * with its problems), else it is filled from the report.
 */
function renderReportEditor(report, form, issues, ctx, sources) {
  const base = escape(ctx.base);
  const f = form || (report ? {
    title: report.title, description: report.description || '', source: report.source,
    view: JSON.stringify(report.view, null, 2), statements: report.statements
  } : { title: '', description: '', source: 'uploaded', view: '', statements: [] });
  const action = report ? `${base}/reports/${encodeURIComponent(report.id)}` : `${base}/reports`;
  let h = STYLE + userBar(ctx) + reportCrumbs(ctx, report ? `Edit ${report.title}` : 'New report');
  h += `<div class="ips-banner"><b class="ips-project-name">${report ? `Edit report: ${escape(report.title)}` : 'New report'}</b></div>`;
  if (issues && issues.length > 0) {
    h += '<div class="alert alert-danger"><b>The report can\'t be saved:</b><ul>' + issues.map(i => `<li>${escape(i)}</li>`).join('') + '</ul></div>';
  }
  h += `<form method="post" action="${action}">${csrfField(ctx.csrf)}`;
  h += '<div class="mb-2"><label for="r-title"><b>Title</b></label>' +
    `<input id="r-title" name="title" type="text" class="form-control" required value="${escape(f.title)}"/></div>`;
  h += '<div class="mb-2"><label for="r-description"><b>Description</b></label>' +
    `<textarea id="r-description" name="description" class="form-control" rows="2">${escape(f.description)}</textarea></div>`;
  h += '<div class="mb-2"><label for="r-source"><b>Runs over</b></label> <select id="r-source" name="source">' +
    Object.entries(sources).map(([k, v]) => `<option value="${escape(k)}"${k === f.source ? ' selected' : ''}>${escape(v)}</option>`).join('') + '</select></div>';
  h += '<div class="mb-2"><label for="r-view"><b>ViewDefinition</b> (JSON)</label>' +
    '<p class="ips-small">An R4 ViewDefinition (SQL on FHIR). Its name names the report\'s table' + (report ? ', and can\'t be changed' : '') +
    '. Every column needs a type. Over the documents, it is a view of Bundle - the document - that walks to what it wants ' +
    '(<code>"forEach": "entry.resource.ofType(Condition)"</code>, say), with references resolved inside the document; over the validation outcomes, it is a view of OperationOutcome. ' +
    'getResourceKey() and getReferenceKey() keys are the document id, then the resource\'s. The FHIR validator checks the view (with the SQL on FHIR IG) before it is saved. ' +
    'When the view or what it runs over changes, the table is rebuilt from every document, in the background.</p>' +
    `<textarea id="r-view" name="view" class="form-control ips-json" rows="24" spellcheck="false" style="font-family: monospace; font-size: 85%">${escape(f.view)}</textarea></div>`;
  h += '<h4>SQL statements</h4><p class="ips-small">Each is a SELECT, shown with its output on the report. A statement sees each report\'s table under its name, ' +
    'with the view\'s columns, <code>_document</code> (the document\'s id) and <code>_project</code> - holding only the rows of the project the report is being looked at in. ' +
    'Collection and complex columns hold JSON (SQLite\'s <code>json_each()</code> can unpack them). Leave a statement\'s name and SQL empty to remove it.</p>' +
    '<p class="ips-small">How tables are shown: a <code>resource_key</code> column (from <code>getResourceKey()</code>) links to the resource in its document\'s source; ' +
    '<code>X_system</code> + <code>X_code</code> (+ <code>X_display</code>) columns are shown as one column <code>X</code>, the coding as the terminology view shows it.</p>';
  const statements = [...(f.statements || []), { name: '', sql: '' }, { name: '', sql: '' }];
  statements.forEach((s, i) => {
    h += '<div class="mb-2 ips-statement">' +
      `<input name="stmt_name" type="text" class="form-control" placeholder="Statement ${i + 1}: its name" aria-label="Statement ${i + 1} name" value="${escape(s.name || '')}" style="margin-bottom: 2px"/>` +
      `<textarea name="stmt_sql" class="form-control" rows="4" spellcheck="false" placeholder="SELECT ..." aria-label="Statement ${i + 1} SQL" style="font-family: monospace; font-size: 85%">${escape(s.sql || '')}</textarea></div>`;
  });
  h += '<button type="submit" class="btn btn-primary">Save</button> ' +
    `<a class="btn btn-default" href="${report ? `${base}/reports/${encodeURIComponent(report.id)}` : `${base}/reports`}">Cancel</a></form>`;
  return h;
}

/** A project's reports. */
function renderProjectReports(project, list, ctx, sources) {
  const purl = projectUrl(ctx, project);
  let h = STYLE + userBar(ctx) + crumbs(ctx, project, 'Reports');
  h += `<div class="ips-banner"><div class="ips-project-name"><b>${escape(project.name)}</b>: Reports</div></div>`;
  h += projectNav(project, ctx);
  h += `<p>${REPORT_EXPLANATION} <a href="${escape(ctx.base)}/reports">All the reports</a>.</p>`;
  if (list.length === 0) {
    return h + '<p>There are no reports yet.</p>';
  }
  h += '<table class="table table-sm table-striped ips-table"><tr><th>Report</th><th>Runs over</th><th>Table state</th></tr>';
  for (const r of list) {
    h += `<tr><td><a href="${purl}/reports/${encodeURIComponent(r.id)}">${escape(r.title)}</a>` +
      (r.description ? `<br/><span class="ips-small">${escape(r.description)}</span>` : '') + '</td>' +
      `<td>${escape(sources[r.source] || r.source)}</td><td>${escape(reportStateText(r.build))}</td></tr>`;
  }
  return h + '</table>';
}

function reportCell(v) {
  if (v === null || v === undefined) {
    return '<td class="ips-null"></td>';
  }
  return `<td>${escape(String(v))}</td>`;
}

/**
 * Where a resource in a document is shown, for a report's resource_key: the document's source
 * (original or modified, as the report runs over), at the resource's anchor; for the
 * validation outcomes, the validation view.
 */
function resourceLink(purl, key, source) {
  const m = /^(\d+)\/(.+)$/.exec(String(key));
  if (!m) {
    return escape(String(key));
  }
  const durl = `${purl}/Bundle/${m[1]}`;
  const href = source === 'outcomes' ? `${durl}?view=validation`
    : `${durl}?view=source${source === 'transformed' ? '&amp;source=modified' : ''}#${encodeURIComponent(m[2]).replace(/%2F/g, '/')}`;
  return `<a href="${href}">${escape(`#${m[1]} ${m[2]}`)}</a>`;
}

/**
 * How a report table is presented, from its column names (conventions the administrator can
 * write views to):
 *   resource_key            - a link to the resource in its document (resourceLink); the
 *                             _document column, which it already says, isn't shown
 *   _document               - otherwise, a link to the document
 *   X_system + X_code       - one column X, the coding as the terminology view shows one
 *     (+ X_display)           (codingHtml), with its display when there is an X_display
 *   ViewRowKey, _project    - not shown
 * @returns {Array<{title: string, cell: function(row): string}>}
 */
function reportColumns(columns, purl, source, codeSystemLink) {
  const index = new Map(columns.map((c, i) => [c, i]));
  const used = new Set(['ViewRowKey', '_project']);
  if (index.has('resource_key')) {
    used.add('_document');
  }
  const out = [];
  for (const c of columns) {
    if (used.has(c)) {
      continue;
    }
    const pair = /^(.+)_system$/.exec(c);
    if (pair && index.has(`${pair[1]}_code`)) {
      const x = pair[1];
      const [si, ci, di] = [index.get(c), index.get(`${x}_code`), index.get(`${x}_display`)];
      used.add(`${x}_code`);
      if (di !== undefined) {
        used.add(`${x}_display`);
      }
      out.push({
        title: x,
        cell: (row) => (row[si] === null && row[ci] === null ? '<td class="ips-null"></td>'
          : `<td>${codingHtml({ system: row[si], code: row[ci], display: di === undefined ? null : row[di] }, codeSystemLink)}</td>`)
      });
      continue;
    }
    if (/^.+_code$/.test(c) && index.has(c.replace(/_code$/, '_system'))) {
      continue; // shown with its _system
    }
    const i = index.get(c);
    if (c === 'resource_key') {
      out.push({ title: 'resource', cell: (row) => (row[i] === null ? '<td class="ips-null"></td>' : `<td>${resourceLink(purl, row[i], source)}</td>`) });
    } else if (c === '_document') {
      out.push({ title: 'document', cell: (row) => (Number.isInteger(row[i]) ? `<td><a href="${purl}/Bundle/${row[i]}">${row[i]}</a></td>` : reportCell(row[i])) });
    } else {
      out.push({ title: c, cell: (row) => reportCell(row[i]) });
    }
  }
  return out;
}

/** A statement's output, or the table's rows, as a table (reportColumns says how). */
function reportTable(result, purl, source, codeSystemLink) {
  if (result.error) {
    return alert(result.error, 'danger');
  }
  if (result.rows.length === 0) {
    return '<p class="ips-small">No rows.</p>';
  }
  const cols = reportColumns(result.columns, purl, source, codeSystemLink);
  let h = '<div style="overflow-x: auto"><table class="table table-sm table-striped ips-table ips-report"><tr>' +
    cols.map(c => `<th>${escape(c.title)}</th>`).join('') + '</tr>';
  for (const row of result.rows) {
    h += '<tr>' + cols.map(c => c.cell(row)).join('') + '</tr>';
  }
  return h + '</table></div>';
}

/**
 * A report for a project: each statement (name, SQL, output), then the table itself (its first
 * rows), and the documents the view failed on.
 */
function renderProjectReport(project, report, out, problem, errors, ctx, maxRows) {
  const purl = projectUrl(ctx, project);
  const rurl = `${purl}/reports/${encodeURIComponent(report.id)}`;
  let h = STYLE + userBar(ctx) + crumbs(ctx, project, null).replace(/<\/p>$/, '') +
    ` &raquo; <a href="${purl}/reports">Reports</a> &raquo; ${escape(report.title)}</p>`;
  h += `<div class="ips-banner"><div class="ips-project-name"><b>${escape(report.title)}</b></div>` +
    (report.description ? `<div class="ips-facts">${escape(report.description)}</div>` : '') + '</div>';
  h += projectNav(project, ctx);
  if (report.build && report.build.state !== 'ready') {
    h += alert(reportStateText(report.build), 'info');
  }
  h += alert(problem, 'danger');
  if (!out) {
    return h;
  }
  const link = ctx.codeSystemLink || null;
  for (const s of out.statements) {
    // the SQL is behind its own link: the output is what matters here
    const sql = (report.statements.find(x => x.name === s.name) || {}).sql || '';
    h += `<h3>${escape(s.name)} <details class="ips-sql"><summary>source</summary><pre class="ips-json">${escape(sql)}</pre></details></h3>`;
    h += reportTable(s, purl, report.source, link);
    if (s.more) {
      h += `<p class="ips-small">Only the first ${maxRows} rows are shown.</p>`;
    }
  }
  h += `<h3>The table: <code>${escape(report.id)}</code></h3>`;
  if (!out.raw) {
    h += '<p>The table has not been built yet.</p>';
  } else if (out.raw.error) {
    h += alert(out.raw.error, 'danger');
  } else {
    const shown = out.raw.rows.length;
    h += `<p class="ips-small">${shown < out.raw.total ? `The first ${shown} of ${out.raw.total} rows` : `${out.raw.total} row${out.raw.total === 1 ? '' : 's'}`} ` +
      `(<a href="${rurl}/csv">download them all as CSV</a>). <a href="${escape(ctx.base)}/reports/${encodeURIComponent(report.id)}">The report's definition</a>.</p>`;
    h += reportTable(out.raw, purl, report.source, link);
  }
  if (errors && errors.length > 0) {
    h += '<h3>Documents the view failed on</h3><table class="table table-sm ips-table"><tr><th>Document</th><th>Why</th></tr>' +
      errors.map(e => `<tr><td><a href="${purl}/Bundle/${e.doc_id}">${e.doc_id}</a></td><td>${escape(e.message)}</td></tr>`).join('') + '</table>';
  }
  return h;
}

module.exports = {
  analysisOk,
  renderHome, renderProjects, renderProject, renderSubmit, renderSettings, renderDocument,
  assembledNarrative, renderStructure, renderAnalysis, renderTerminology, renderTranslation, renderGenerated, renderAi, renderPatientComments, PATIENT_COMMENT_MAX, renderValidation, renderNational, renderShare, renderCompose, renderComposeChoice, renderPatientEditor, renderPatients, renderPatient, renderProfileChecks,
  renderProfiles, renderProfile, renderProfileEditor, renderNationalProfiles, renderReports, renderReportDefinition, renderReportEditor, renderProjectReports, renderProjectReport, renderQueue, renderViewerStart, renderView, VIEWS, viewOf
};
