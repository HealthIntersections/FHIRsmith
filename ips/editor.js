//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/*
 * The IPS editor, in the browser. The page gives it window.IPS_EDITOR: the schema
 * (ips/editor-schema.js, as JSON), a model to start from (empty, or an existing document's),
 * and the URLs it works with. The model is the editor's state: the form is drawn from it, the
 * inputs write into it, and it is kept in localStorage so a reload doesn't lose it; submitting
 * posts it to the server, which builds the document (ips/composer.js).
 */
(function () {
  'use strict';
  var cfg = window.IPS_EDITOR;
  var schema = cfg.schema;
  var root = document.getElementById('ips-editor');
  var draftKey = 'ips-editor:' + cfg.project;
  var model = cfg.model || loadDraft() || emptyModel();
  var open = {};
  var dirty = false;

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
    field.options.forEach(function (o) { select.appendChild(el('option', { value: o.code, text: o.display })); });
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
    var isOpen = open[def.key] !== undefined ? open[def.key] : (def.required || s.mode !== 'omit');
    var summary = s.mode === 'data' ? ((s.rows || []).length + ' ' + (s.rows && s.rows.length === 1 ? 'entry' : 'entries')) : s.mode === 'narrative' ? 'narrative' : s.mode === 'empty' ? 'empty' + (s.emptyReason ? ' - ' + (schema.emptyReasons.filter(function (r) { return r.code === s.emptyReason; })[0] || {}).display : '') : 'not included';
    var head = el('div', { class: 'ips-ed-section-head', onclick: function () { open[def.key] = !isOpen; draw(); } }, [
      el('span', { class: 'ips-ed-caret', text: isOpen ? '▾' : '▸' }), ' ',
      el('b', { text: def.title }), def.required ? el('span', { class: 'ips-small', text: ' (required)' }) : null,
      el('span', { class: 'ips-ed-summary ips-small', text: ' - ' + summary })
    ]);
    var body = el('div', { class: 'ips-ed-section-body', hidden: !isOpen });
    var modes = [['data', 'Entries'], ['narrative', 'Narrative'], ['empty', 'Empty, because']];
    if (!def.required) { modes.push(['omit', 'Not included']); }
    var modeBar = el('div', { class: 'ips-ed-modes' }, modes.map(function (m) {
      var id = 'mode-' + def.key + '-' + m[0];
      var radio = el('input', { type: 'radio', name: 'mode-' + def.key, id: id, value: m[0] });
      radio.checked = s.mode === m[0];
      radio.addEventListener('change', function () { s.mode = m[0]; if (m[0] === 'data' && !(s.rows || []).length) { s.rows = [{}]; } saveDraft(); draw(); });
      return el('label', { for: id, class: 'ips-ed-mode' }, [radio, ' ' + m[1]]);
    }));
    body.appendChild(modeBar);
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
      schema.emptyReasons.forEach(function (r) { sel.appendChild(el('option', { value: r.code, text: r.display })); });
      sel.value = s.emptyReason || '';
      sel.addEventListener('change', function () { s.emptyReason = sel.value; saveDraft(); });
      body.appendChild(sel);
    }
    return el('div', { class: 'ips-ed-section' + (def.required ? ' ips-ed-section-required' : '') }, [head, body]);
  }
  function actions() {
    var messages = el('div', { class: 'ips-ed-messages' });
    var busy = false;
    function send(action) {
      if (busy) { return; }
      busy = true;
      messages.innerHTML = '<p><i>' + (action === 'download' ? 'Building the document...' : 'Submitting...') + '</i></p>';
      var body = { action: action, model: model };
      var tokenInput = root.querySelector('[name=token]');
      if (tokenInput) { body.token = tokenInput.value; }
      fetch(cfg.urls.compose, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: action === 'download' ? 'application/fhir+json' : 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' })
        .then(function (r) {
          if (action === 'download' && r.ok) {
            return r.blob().then(function (b) {
              var a = el('a', { href: URL.createObjectURL(b), download: 'ips.json' });
              document.body.appendChild(a); a.click(); document.body.removeChild(a);
              messages.innerHTML = '<p class="text-success">The document was built; it is downloading.</p>';
            });
          }
          return r.json().then(function (j) {
            if (!r.ok) {
              var problems = j.problems && j.problems.length ? j.problems : [j.error || ('HTTP ' + r.status)];
              messages.innerHTML = '<div class="alert alert-danger"><b>Not ' + (action === 'download' ? 'built' : 'submitted') + ':</b><ul>' + problems.map(function (p) { return '<li>' + escapeHtml(p) + '</li>'; }).join('') + '</ul></div>';
              return;
            }
            clearDraft();
            dirty = false;
            messages.innerHTML = '<p class="text-success">Submitted as document ' + escapeHtml(String(j.id)) + '. Opening it...</p>';
            window.location.href = j.url;
          });
        })
        .catch(function (e) { messages.innerHTML = '<div class="alert alert-danger">' + escapeHtml(e.message) + '</div>'; })
        .finally(function () { busy = false; });
    }
    var parts = [];
    if (cfg.needsToken) {
      parts.push(el('div', { class: 'ips-ed-field' }, [el('label', { text: 'Submission token *' }), el('input', { type: 'password', name: 'token', class: 'form-control ips-ed-input', autocomplete: 'off' })]));
    }
    parts.push(el('p', {}, [
      el('button', { type: 'button', class: 'btn btn-primary', onclick: function () { send('submit'); } }, ['Submit to ' + cfg.projectName]), ' ',
      el('button', { type: 'button', class: 'btn btn-default', onclick: function () { send('download'); } }, ['Download JSON']), ' ',
      el('button', { type: 'button', class: 'btn btn-link', onclick: function () { if (window.confirm('Clear everything entered?')) { model = emptyModel(); open = {}; clearDraft(); draw(); } } }, ['Start again'])
    ]));
    parts.push(messages);
    return el('div', { class: 'ips-ed-actions' }, parts);
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function draw() {
    var scroll = window.scrollY;
    root.innerHTML = '';
    root.appendChild(headerPanel());
    root.appendChild(el('h3', { text: 'Sections' }));
    root.appendChild(el('p', { class: 'ips-small', text: 'The sections in the IPS order; the three the IPS requires are open. For each, enter its entries, write its narrative, or say why it is empty.' }));
    schema.sections.forEach(function (def) { root.appendChild(sectionPanel(def)); });
    root.appendChild(actions());
    window.scrollTo(0, scroll);
  }
  window.addEventListener('beforeunload', function (e) { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
  draw();
})();
