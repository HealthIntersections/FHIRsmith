//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/*
 * The IPS editor, in the browser. The page gives it window.IPS_EDITOR: the schema
 * (ips/editor-schema.js, as JSON), a model to start from (empty, or an existing document's),
 * and the URLs it works with. The model is the editor's state: the form is drawn from it, the
 * inputs write into it, and it is kept in localStorage so a reload doesn't lose it. As it
 * changes, the server builds the document from it (ips/composer.js) and says whether it is a
 * minimal IPS yet; the document actions (doc-actions.js) offer to submit, download or share
 * it once it is. A document file, or a test patient, can be loaded into the editor.
 *
 * Started with a clinical profile (cfg.guidance: profiles.js editorGuidance), the profile's
 * section rules narrow each section's choices - a section it has rules for can't be left out,
 * hasData() (or an entry rule) rules out narrative, an entry rule rules out empty, isKnown()
 * leaves nil known as the only reason to be empty - and its guided input is shown at the head of
 * each section: a list of guides, each one's questions in order with their inputs, which can be
 * dismissed. What is answered, and what is dismissed, is kept in the model (model.guidance).
 */
(function () {
  'use strict';
  var cfg = window.IPS_EDITOR;
  var schema = cfg.schema;
  var root = document.getElementById('ips-editor');
  var draftKey = 'ips-editor:' + (cfg.project || '-');
  var model = cfg.model || loadDraft() || emptyModel();
  var open = {};
  var dirty = false;
  var guidance = cfg.guidance || null;
  var LOINC = 'http://loinc.org';

  function emptyModel() {
    var m = { patient: {}, document: {}, sections: {} };
    schema.sections.forEach(function (s) { m.sections[s.key] = { mode: s.required ? 'data' : 'omit', rows: s.required ? [{}] : [] }; });
    return m;
  }
  function loadDraft() {
    try { var d = localStorage.getItem(draftKey); return d ? JSON.parse(d) : null; } catch (e) { return null; }
  }
  function saveDraft() {
    dirty = true;
    try { localStorage.setItem(draftKey, JSON.stringify(model)); } catch (e) { /* no storage: the page still works */ }
    rebuild();
  }
  function clearDraft() {
    try { localStorage.removeItem(draftKey); } catch (e) { /* nothing to do */ }
  }
  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'class') { e.className = attrs[k]; } else if (k === 'text') { e.textContent = attrs[k]; } else if (k.indexOf('on') === 0) { e.addEventListener(k.substring(2), attrs[k]); } else if (attrs[k] !== undefined && attrs[k] !== null && attrs[k] !== false) { e.setAttribute(k, attrs[k] === true ? '' : attrs[k]); }
    });
    (children || []).forEach(function (c) { if (c) { e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); } });
    return e;
  }
  function section(key) { return model.sections[key] || (model.sections[key] = { mode: 'omit', rows: [] }); }

  // ---- inputs ----

  function textInput(obj, name, field, extra) {
    var input = el(field.type === 'textarea' ? 'textarea' : 'input', Object.assign({ class: 'form-control ips-ed-input', placeholder: field.placeholder || (field.type === 'date' ? 'YYYY-MM-DD' : ''), rows: field.type === 'textarea' ? 3 : undefined }, extra || {}));
    if (field.type !== 'textarea') { input.type = 'text'; }
    input.value = obj[name] || '';
    input.addEventListener('input', function () { obj[name] = input.value; saveDraft(); });
    return input;
  }
  function selectInput(obj, name, field) {
    var select = el('select', { class: 'form-control ips-ed-input' }, [el('option', { value: '', text: '' })]);
    field.options.forEach(function (o) { select.appendChild(el('option', { value: o.code, text: o.label || o.display })); });
    if (field.list) {
      select.multiple = true;
      select.size = Math.min(4, field.options.length);
      var current = Array.isArray(obj[name]) ? obj[name] : (obj[name] ? [obj[name]] : []);
      Array.prototype.forEach.call(select.options, function (o) { o.selected = current.indexOf(o.value) >= 0; });
      select.addEventListener('change', function () { obj[name] = Array.prototype.filter.call(select.options, function (o) { return o.selected && o.value; }).map(function (o) { return o.value; }); saveDraft(); });
    } else {
      if (obj[name] === undefined && field.default) { obj[name] = field.default; }
      select.value = obj[name] || '';
      select.addEventListener('change', function () { obj[name] = select.value; saveDraft(); });
    }
    return select;
  }
  function quantityInput(obj, name) {
    var q = obj[name] || (obj[name] = {});
    var value = el('input', { type: 'text', class: 'form-control ips-ed-input ips-ed-qty', placeholder: 'value' });
    value.value = q.value === undefined || q.value === null ? '' : q.value;
    value.addEventListener('input', function () { q.value = value.value; saveDraft(); });
    var unit = el('input', { type: 'text', class: 'form-control ips-ed-input ips-ed-unit', placeholder: 'unit' });
    unit.value = q.unit || '';
    unit.addEventListener('input', function () { q.unit = unit.value; saveDraft(); });
    return el('span', { class: 'ips-ed-quantity' }, [value, ' ', unit]);
  }
  var lookupTimer = null;
  function codeInput(obj, name, field) {
    // one coding, or a list of them (shown as chips, with an input to add more)
    var wrap = el('div', { class: 'ips-ed-code' });
    var chips = el('div', { class: 'ips-ed-chips' });
    var input = el('input', { type: 'text', class: 'form-control ips-ed-input', placeholder: field.list ? 'type to look up, or enter text' : 'type to look up, or enter text', autocomplete: 'off' });
    var list = el('div', { class: 'ips-ed-suggestions', hidden: true });
    var single = !field.list;
    function current() { return single ? (obj[name] || null) : (Array.isArray(obj[name]) ? obj[name] : (obj[name] = [])); }
    function label(c) { return c.display || c.text || c.code || ''; }
    function drawChips() {
      chips.innerHTML = '';
      var items = single ? (current() ? [current()] : []) : current();
      items.forEach(function (c, i) {
        var chip = el('span', { class: 'ips-ed-chip' + (c.code ? ' ips-ed-chip-coded' : ''), title: c.code ? c.system + '|' + c.code : 'text only' }, [label(c), ' ', el('a', { href: '#', class: 'ips-ed-chip-x', onclick: function (e) { e.preventDefault(); if (single) { obj[name] = null; } else { current().splice(i, 1); } saveDraft(); drawChips(); input.hidden = false; input.focus(); } }, ['×'])]);
        chips.appendChild(chip);
      });
      input.hidden = single && !!current();
    }
    function choose(c) {
      if (single) { obj[name] = c; } else { current().push(c); }
      input.value = '';
      list.hidden = true;
      saveDraft();
      drawChips();
    }
    function commitText() {
      var t = input.value.trim();
      if (t) { choose({ text: t }); }
    }
    input.addEventListener('input', function () {
      var q = input.value.trim();
      clearTimeout(lookupTimer);
      if (q.length < 2 || !cfg.urls.lookup) { list.hidden = true; return; }
      lookupTimer = setTimeout(function () {
        fetch(cfg.urls.lookup + '?vs=' + encodeURIComponent(field.valueSet) + '&q=' + encodeURIComponent(q), { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            list.innerHTML = '';
            var found = j && j.matches ? j.matches : [];
            found.forEach(function (c) {
              list.appendChild(el('div', { class: 'ips-ed-suggestion', onmousedown: function (e) { e.preventDefault(); choose({ system: c.system, code: c.code, display: c.display }); } }, [c.display || c.code, ' ', el('small', { text: c.code })]));
            });
            list.appendChild(el('div', { class: 'ips-ed-suggestion ips-ed-suggestion-text', onmousedown: function (e) { e.preventDefault(); commitText(); } }, [found.length ? 'Use "' + q + '" as text' : (j && j.error ? j.error + ' - use "' + q + '" as text' : 'Nothing found - use "' + q + '" as text')]));
            list.hidden = false;
          })
          .catch(function () { list.hidden = true; });
      }, 250);
    });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); commitText(); } if (e.key === 'Escape') { list.hidden = true; } });
    input.addEventListener('blur', function () { setTimeout(function () { list.hidden = true; if (input.value.trim()) { commitText(); } }, 150); });
    wrap.appendChild(chips);
    wrap.appendChild(input);
    wrap.appendChild(list);
    drawChips();
    return wrap;
  }
  function fieldInput(obj, field) {
    switch (field.type) {
      case 'select': return selectInput(obj, field.name, field);
      case 'quantity': return quantityInput(obj, field.name);
      case 'code': return codeInput(obj, field.name, field);
      default: return textInput(obj, field.name, field);
    }
  }
  function fieldRow(obj, field) {
    return el('div', { class: 'ips-ed-field' + (field.required ? ' ips-ed-required' : '') }, [
      el('label', { text: field.label + (field.required ? ' *' : '') }),
      fieldInput(obj, field),
      field.hint ? el('div', { class: 'ips-small ips-ed-hint', text: field.hint }) : null
    ]);
  }

  // ---- a clinical profile's guidance ----

  function guidanceState() { return model.guidance || (model.guidance = { dismissed: {}, answers: {} }); }
  /** What the profile's section rules ask of a section: {checks, needsEntries, rules}, or null. */
  function sectionRules(system, code) { return guidance && guidance.sections[system + '|' + code] || null; }
  function sectionGuides(system, code) {
    return guidance ? guidance.guides.filter(function (g) { return g.section.system === system && g.section.code === code; }) : [];
  }
  /** The choices a section's rules don't allow: mode -> why. */
  function modesOff(rules) {
    var off = {};
    if (!rules) { return off; }
    off.omit = 'The clinical profile needs this section';
    if (rules.needsEntries) {
      off.narrative = off.empty = 'The clinical profile needs entries in this section';
    } else if (rules.checks.indexOf('hasData') >= 0) {
      off.narrative = 'The clinical profile needs this section to have entries, or say why it is empty';
    }
    return off;
  }
  function codingKey(c) { return c.system + '|' + c.code; }
  /** A question's input, at the end of its text: the answer is kept in the model by linkId. */
  function guideInput(q) {
    var answers = guidanceState().answers;
    var cls = 'form-control ips-ed-input ips-ed-g-input';
    var keep = function (v) { answers[q.linkId] = v; saveDraft(); };
    var select = function (options, value) {
      var sel = el('select', { class: cls, 'aria-label': q.text }, [el('option', { value: '', text: '' })]);
      options.forEach(function (o) { sel.appendChild(el('option', { value: o[0], text: o[1] })); });
      sel.value = value || '';
      sel.addEventListener('change', function () { keep(sel.value); });
      return sel;
    };
    if (q.type === 'boolean') {
      return select([['yes', 'Yes'], ['no', 'No']], answers[q.linkId]);
    }
    if (q.type === 'choice') {
      return select(q.answers.map(function (a) { return [codingKey(a), a.display || a.code]; }), answers[q.linkId]);
    }
    if (q.type === 'date') {
      var d = el('input', { type: 'text', class: cls, placeholder: 'YYYY-MM-DD', size: 10, 'aria-label': q.text });
      d.value = answers[q.linkId] || '';
      d.addEventListener('input', function () { keep(d.value); });
      return d;
    }
    // a quantity: the value, and its unit (one of the guide's units, or any)
    var qv = answers[q.linkId] && typeof answers[q.linkId] === 'object' ? answers[q.linkId] : (answers[q.linkId] = {});
    var value = el('input', { type: 'text', class: cls + ' ips-ed-g-qty', placeholder: 'value', 'aria-label': q.text });
    value.value = qv.value || '';
    value.addEventListener('input', function () { qv.value = value.value; saveDraft(); });
    var unit;
    if (q.units.length) {
      unit = el('select', { class: cls, 'aria-label': q.text + ' (unit)' });
      q.units.forEach(function (u) { unit.appendChild(el('option', { value: codingKey(u), text: u.display || u.code })); });
      if (!qv.unit) { qv.unit = codingKey(q.units[0]); }
      unit.value = qv.unit;
      unit.addEventListener('change', function () { qv.unit = unit.value; saveDraft(); });
    } else {
      unit = el('input', { type: 'text', class: cls + ' ips-ed-g-qty', placeholder: 'unit', 'aria-label': q.text + ' (unit)' });
      unit.value = qv.unit || '';
      unit.addEventListener('input', function () { qv.unit = unit.value; saveDraft(); });
    }
    return el('span', {}, [value, unit]);
  }
  /**
   * A section's guides, as a list: each one dismiss first, then its questions in order with their
   * inputs at the end of their text, then Apply (when there is anything to answer). Dismissed, a
   * guide is greyed out and cut to one line.
   */
  function guideList(guides) {
    var st = guidanceState();
    return el('ul', { class: 'ips-ed-guides' }, guides.map(function (g) {
      var dismissed = !!st.dismissed[g.key];
      var toggle = el('a', { href: '#', class: 'ips-ed-guide-dismiss', onclick: function (e) {
        e.preventDefault();
        if (dismissed) { delete st.dismissed[g.key]; } else { st.dismissed[g.key] = true; }
        saveDraft();
        draw();
      } }, [dismissed ? 'show' : 'dismiss']);
      if (dismissed) {
        var all = g.questions.map(function (q) { return q.text; }).join(' ');
        return el('li', { class: 'ips-ed-guide ips-ed-guide-dismissed', title: all }, [toggle, ' ', all]);
      }
      var parts = [toggle, ' '];
      var asks = false;
      g.questions.forEach(function (q) {
        parts.push(el('span', { class: 'ips-ed-g-text', text: q.text }));
        if (q.type !== 'display') {
          asks = true;
          parts.push(' ', guideInput(q));
        }
        parts.push(' ');
      });
      if (asks) {
        parts.push(el('button', { type: 'button', class: 'btn btn-default btn-xs ips-ed-guide-apply', disabled: true, title: 'Applying the answers is still to come' }, ['Apply']));
      }
      return el('li', { class: 'ips-ed-guide' }, parts);
    }));
  }
  /** Guides for sections this editor doesn't have (the Patient Story, or another code), under their section's title. */
  function otherGuides() {
    if (!guidance) { return null; }
    var known = {};
    schema.sections.forEach(function (d) { known[LOINC + '|' + d.code] = true; });
    var others = guidance.guides.filter(function (g) { return !known[g.section.system + '|' + g.section.code]; });
    if (!others.length) { return null; }
    var box = el('div', { class: 'ips-ed-other-guides' });
    var seen = [];
    others.forEach(function (g) {
      var k = g.section.system + '|' + g.section.code;
      if (seen.indexOf(k) >= 0) { return; }
      seen.push(k);
      box.appendChild(el('div', { class: 'ips-small' }, [el('b', { text: g.sectionTitle }), ' (a section this editor doesn\'t have)']));
      box.appendChild(guideList(others.filter(function (x) { return x.section.system + '|' + x.section.code === k; })));
    });
    return box;
  }

  // ---- the parts of the page ----

  function headerPanel() {
    var p = model.patient || (model.patient = {});
    var d = model.document || (model.document = {});
    return el('div', { class: 'ips-ed-panel ips-ed-header' }, [
      el('h3', { text: 'Patient' }),
      el('div', { class: 'ips-ed-grid' }, schema.header.patient.map(function (f) { return fieldRow(p, f); })),
      el('h3', { text: 'Document' }),
      el('div', { class: 'ips-ed-grid' }, schema.header.document.map(function (f) { return fieldRow(d, f); }))
    ]);
  }
  function rowPanel(def, s, row, index) {
    var panel = el('div', { class: 'ips-ed-row' });
    panel.appendChild(el('div', { class: 'ips-ed-row-head' }, [
      el('b', { text: def.label + ' ' + (index + 1) }),
      el('button', { type: 'button', class: 'btn btn-link ips-ed-remove', onclick: function () { s.rows.splice(index, 1); saveDraft(); draw(); } }, ['remove'])
    ]));
    panel.appendChild(el('div', { class: 'ips-ed-grid' }, def.fields.map(function (f) { return fieldRow(row, f); })));
    (def.subs || []).forEach(function (sub) {
      var items = row[sub.name] || (row[sub.name] = []);
      var subPanel = el('div', { class: 'ips-ed-sub' }, [el('div', { class: 'ips-ed-sub-head', text: sub.label })]);
      items.forEach(function (item, j) {
        subPanel.appendChild(el('div', { class: 'ips-ed-sub-row' }, [
          el('div', { class: 'ips-ed-grid' }, sub.fields.map(function (f) { return fieldRow(item, f); })),
          el('button', { type: 'button', class: 'btn btn-link ips-ed-remove', onclick: function () { items.splice(j, 1); saveDraft(); draw(); } }, ['remove'])
        ]));
      });
      subPanel.appendChild(el('button', { type: 'button', class: 'btn btn-default btn-xs', onclick: function () { items.push({}); saveDraft(); draw(); } }, ['Add ' + sub.label.toLowerCase().replace(/s$/, '')]));
      panel.appendChild(subPanel);
    });
    return panel;
  }
  function sectionPanel(def) {
    var s = section(def.key);
    if (!s.mode) { s.mode = def.required ? 'data' : 'omit'; }
    var rules = sectionRules(LOINC, def.code);
    var guides = sectionGuides(LOINC, def.code);
    var off = modesOff(rules);
    var isOpen = open[def.key] !== undefined ? open[def.key] : (def.required || s.mode !== 'omit' || !!rules || guides.length > 0);
    var summary = s.mode === 'data' ? ((s.rows || []).length + ' ' + (s.rows && s.rows.length === 1 ? 'entry' : 'entries')) : s.mode === 'narrative' ? 'narrative' : s.mode === 'empty' ? 'empty' + (s.emptyReason ? ' - ' + (schema.emptyReasons.filter(function (r) { return r.code === s.emptyReason; })[0] || {}).display : '') : 'not included';
    var head = el('div', { class: 'ips-ed-section-head', onclick: function () { open[def.key] = !isOpen; draw(); } }, [
      el('span', { class: 'ips-ed-caret', text: isOpen ? '▾' : '▸' }), ' ',
      el('b', { text: def.title }), def.required ? el('span', { class: 'ips-small', text: ' (required)' }) : (rules ? el('span', { class: 'ips-small', text: ' (required by the profile)' }) : null),
      el('span', { class: 'ips-ed-summary ips-small', text: ' - ' + summary })
    ]);
    var body = el('div', { class: 'ips-ed-section-body', hidden: !isOpen });
    var modes = [['data', 'Entries'], ['narrative', 'Narrative'], ['empty', 'Empty, because']];
    if (!def.required) { modes.push(['omit', 'Not included']); }
    var modeBar = el('div', { class: 'ips-ed-modes' }, modes.map(function (m) {
      var id = 'mode-' + def.key + '-' + m[0];
      var radio = el('input', { type: 'radio', name: 'mode-' + def.key, id: id, value: m[0] });
      radio.checked = s.mode === m[0];
      // a choice the profile doesn't allow: shown (it may be what the document has), but not to be chosen
      radio.disabled = !!off[m[0]];
      radio.addEventListener('change', function () { s.mode = m[0]; if (m[0] === 'data' && !(s.rows || []).length) { s.rows = [{}]; } saveDraft(); draw(); });
      return el('label', { for: id, class: 'ips-ed-mode' + (off[m[0]] ? ' ips-ed-mode-off' : ''), title: off[m[0]] || null }, [radio, ' ' + m[1]]);
    }));
    body.appendChild(modeBar);
    if (guides.length) { body.appendChild(guideList(guides)); }
    if (s.mode === 'data') {
      var rows = s.rows || (s.rows = []);
      rows.forEach(function (row, i) { body.appendChild(rowPanel(def, s, row, i)); });
      body.appendChild(el('button', { type: 'button', class: 'btn btn-default btn-sm', onclick: function () { rows.push({}); saveDraft(); draw(); } }, ['Add ' + def.label.toLowerCase()]));
      if (s.partial) { body.appendChild(el('p', { class: 'ips-small text-warning', text: 'Some of this section\'s entries in the original document are of a kind this editor cannot hold; they are not here.' })); }
    } else if (s.mode === 'narrative') {
      var ta = el('textarea', { class: 'form-control ips-ed-input', rows: 6, placeholder: 'What this section would say; a blank line starts a new paragraph' });
      ta.value = s.narrative || '';
      ta.addEventListener('input', function () { s.narrative = ta.value; saveDraft(); });
      body.appendChild(ta);
    } else if (s.mode === 'empty') {
      var sel = el('select', { class: 'form-control ips-ed-input', style: 'max-width: 20em' }, [el('option', { value: '', text: '' })]);
      var nilOnly = rules && rules.checks.indexOf('isKnown') >= 0;
      schema.emptyReasons.forEach(function (r) {
        sel.appendChild(el('option', { value: r.code, text: r.display, disabled: nilOnly && r.code !== 'nilknown' }));
      });
      if (nilOnly) { sel.title = 'The clinical profile needs it known: nil known is the only reason it can be empty'; }
      sel.value = s.emptyReason || '';
      sel.addEventListener('change', function () { s.emptyReason = sel.value; saveDraft(); });
      body.appendChild(sel);
    }
    return el('div', { class: 'ips-ed-section' + (def.required ? ' ips-ed-section-required' : '') }, [head, body]);
  }
  // ---- the document: built on the server as the model changes ----

  var docActions = null;
  var buildTimer = null;
  var building = 0;
  function rebuild() {
    if (!docActions) { return; }
    if (buildTimer) { clearTimeout(buildTimer); }
    buildTimer = setTimeout(function () {
      var mine = ++building;
      fetch(cfg.urls.build, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ model: model }), credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (j) { if (mine === building) { docActions.setBundle(j.bundle || null, j.problems || (j.error ? [j.error] : [])); } })
        .catch(function (e) { if (mine === building) { docActions.setBundle(null, [e.message]); } });
    }, 700);
  }

  // ---- loading a document: a file, or a test patient ----

  var loadMessages = el('div', {});
  function loadBundle(bundle, what) {
    loadMessages.innerHTML = '<p><i>Loading ' + escapeHtml(what) + '...</i></p>';
    return fetch(cfg.urls.model, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ bundle: bundle }), credentials: 'same-origin' })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) { var e = new Error(j.error || ('HTTP ' + r.status)); e.problems = j.problems; throw e; } return j; }); })
      .then(function (j) {
        model = j.model;
        open = {};
        saveDraft();
        draw();
        loadMessages.innerHTML = '<p class="text-success">Loaded ' + escapeHtml(what) + '. Anything in it the editor cannot hold is not here.</p>';
      })
      .catch(function (e) {
        loadMessages.innerHTML = '<div class="alert alert-danger"><b>Could not load ' + escapeHtml(what) + ':</b> ' + escapeHtml(e.message) +
          (e.problems && e.problems.length ? '<ul>' + e.problems.map(function (p) { return '<li>' + escapeHtml(p) + '</li>'; }).join('') + '</ul>' : '') + '</div>';
      });
  }
  function loadPanel() {
    var file = el('input', { type: 'file', accept: '.json,application/json,application/fhir+json', style: 'display: none' });
    file.addEventListener('change', function () {
      var f = file.files[0];
      if (!f) { return; }
      f.text().then(function (text) {
        var b;
        try { b = JSON.parse(text); } catch (e) { loadMessages.innerHTML = '<div class="alert alert-danger">' + escapeHtml(f.name) + ' is not JSON: ' + escapeHtml(e.message) + '</div>'; return; }
        return loadBundle(b, f.name);
      }).catch(function (e) { loadMessages.innerHTML = '<div class="alert alert-danger">' + escapeHtml(e.message) + '</div>'; });
      file.value = '';
    });
    var parts = [file, el('button', { type: 'button', class: 'btn btn-default btn-sm', onclick: function () { if (!dirty || window.confirm('Replace what is entered with the document?')) { file.click(); } } }, ['Load an IPS document...'])];
    if ((cfg.testPatients || []).length) {
      parts.push(' Test patients: ');
      cfg.testPatients.forEach(function (tp) {
        parts.push(el('button', { type: 'button', class: 'btn btn-default btn-sm', onclick: function () {
          if (dirty && !window.confirm('Replace what is entered with the test patient?')) { return; }
          fetch(tp.url).then(function (r) { return r.json(); }).then(function (b) { return loadBundle(b, 'the test patient (' + tp.name + ')'); })
            .catch(function (e) { loadMessages.innerHTML = '<div class="alert alert-danger">' + escapeHtml(e.message) + '</div>'; });
        } }, [tp.name]), ' ');
      });
    }
    return el('div', { class: 'ips-ed-load' }, [el('p', {}, parts), loadMessages]);
  }

  function actions() {
    var holder = el('div', {});
    docActions = window.IpsDocActions.create(holder, cfg.actions, { onSubmitted: function () { clearDraft(); dirty = false; } });
    var again = el('p', {}, [el('button', { type: 'button', class: 'btn btn-link', onclick: function () { if (window.confirm('Clear everything entered?')) { model = emptyModel(); open = {}; clearDraft(); dirty = false; draw(); rebuild(); } } }, ['Start again'])]);
    return el('div', {}, [holder, again]);
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function draw() {
    var scroll = window.scrollY;
    root.innerHTML = '';
    root.appendChild(loadPanel());
    root.appendChild(headerPanel());
    root.appendChild(el('h3', { text: 'Sections' }));
    root.appendChild(el('p', { class: 'ips-small', text: 'The sections in the IPS order; the three the IPS requires are open. For each, enter its entries, write its narrative, or say why it is empty.' }));
    var others = otherGuides();
    if (others) { root.appendChild(others); }
    schema.sections.forEach(function (def) { root.appendChild(sectionPanel(def)); });
    root.appendChild(actionsPanel || (actionsPanel = actions()));
    window.scrollTo(0, scroll);
  }
  var actionsPanel = null;
  window.addEventListener('beforeunload', function (e) { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
  draw();
  rebuild();
})();
