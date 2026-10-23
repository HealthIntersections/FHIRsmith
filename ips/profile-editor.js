//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/*
 * The clinical profile editor, in the browser (the administrator's). The page gives it
 * window.IPS_PROFILE: the profile (its title and constraints, each with the shape the server
 * found in its expression, or none), the IPS sections, the named code systems and resource
 * types, and the URLs it works with. The page is in three parts: required sections and entries
 * (Bundle.section(...)[.entry(...) or .entryIn(valueSet...)].exists(), a row of the first
 * table), rules about resources (Bundle.resources(...) or Bundle.resourcesIn(valueSet...), and
 * the rest: a row of the second - type, system, code or value set, the rest), and
 * other rules (FHIRPath). A row's expression is made from it. Saving posts the title and the
 * constraints (key, description, expression); the server checks them, and keeps the keys.
 */
(function () {
  'use strict';
  var cfg = window.IPS_PROFILE;
  var root = document.getElementById('ips-profile-editor');
  var LOINC = cfg.sectionSystem;
  var dirty = false;
  var saving = false;

  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'class') { e.className = attrs[k]; } else if (k === 'text') { e.textContent = attrs[k]; } else if (k.indexOf('on') === 0) { e.addEventListener(k.substring(2), attrs[k]); } else if (attrs[k] !== undefined && attrs[k] !== null && attrs[k] !== false) { e.setAttribute(k, attrs[k] === true ? '' : attrs[k]); }
    });
    (children || []).forEach(function (c) { if (c) { e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); } });
    return e;
  }
  function changed() { dirty = true; }

  // ---- the two shapes (as ips/profiles.js has them) ----

  var STR = "'((?:[^'\\\\]|\\\\.)*)'";
  var ARGS = '\\s*' + STR + '\\s*,\\s*' + STR + "\\s*(?:,\\s*(\\d{1,6})\\s*,\\s*(?:(\\d{1,6})|'\\*')\\s*)?";
  var CARD = "(?:,\\s*(\\d{1,6})\\s*,\\s*(?:(\\d{1,6})|'\\*')\\s*)?";
  var SHAPE_RE = new RegExp('^\\s*Bundle\\s*\\.\\s*section\\s*\\(' + ARGS + '\\)\\s*(?:\\.\\s*(?:entry\\s*\\(' + ARGS + '\\)|entryIn\\s*\\(\\s*' + STR + '\\s*' + CARD + '\\))\\s*)?\\.\\s*exists\\s*\\(\\s*\\)\\s*$');
  var CANONICAL_RE = /^[a-z][a-z0-9+.-]*:[^\s|]{1,250}(\|[^\s|]{1,64})?$/i;
  // the system chosen for an entry or resources when they are matched by value set, not code
  var VS = '#vs';
  function unquote(s) { return s.replace(/\\(.)/g, function (m, c) { return { n: '\n', r: '\r', t: '\t' }[c] || c; }); }
  function quote(s) { return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"; }
  function card(min, max, hasCard) { return { min: hasCard ? parseInt(min, 10) : null, max: hasCard ? (max === undefined ? '*' : parseInt(max, 10)) : null }; }
  function part(system, code, min, max, hasCard) {
    var c = card(min, max, hasCard);
    return { system: unquote(system), code: unquote(code), min: c.min, max: c.max };
  }
  function parseShape(expression) {
    var m = SHAPE_RE.exec(expression || '');
    if (!m) { return null; }
    var entry = null;
    if (m[5] !== undefined) { entry = part(m[5], m[6], m[7], m[8], m[7] !== undefined); } else if (m[9] !== undefined) {
      var c = card(m[10], m[11], m[10] !== undefined);
      entry = { valueSet: unquote(m[9]), min: c.min, max: c.max };
    }
    return { section: part(m[1], m[2], m[3], m[4], m[3] !== undefined), entry: entry };
  }
  function cardText(p) { return p.min === null || p.min === undefined ? '' : p.min + '..' + p.max; }
  function parseCard(text) {
    if (!text || !text.trim()) { return { min: null, max: null }; }
    var m = /^\s*(\d{1,6})\s*\.\.\s*(\d{1,6}|\*)\s*$/.exec(text);
    if (!m) { return null; }
    var min = parseInt(m[1], 10);
    var max = m[2] === '*' ? '*' : parseInt(m[2], 10);
    return max !== '*' && max < min ? null : { min: min, max: max };
  }
  function cardArgs(c) { return c.min !== null ? ', ' + c.min + ', ' + (c.max === '*' ? "'*'" : c.max) : ''; }
  function args(system, code, c) { return quote(system) + ', ' + quote(code) + cardArgs(c); }
  var TYPE = "\\s*(?:,\\s*'([A-Z][A-Za-z]{1,63})'\\s*)?";
  var REST = '\\s*(\\.\\s*\\S[\\s\\S]*?)\\s*$';
  var RSHAPE_RE = new RegExp('^\\s*Bundle\\s*\\.\\s*resources\\s*\\(\\s*' + STR + '\\s*,\\s*' + STR + TYPE + '\\)' + REST);
  var RSHAPE_IN_RE = new RegExp('^\\s*Bundle\\s*\\.\\s*resourcesIn\\s*\\(\\s*' + STR + TYPE + '\\)' + REST);
  function parseResourceShape(expression) {
    var m = RSHAPE_RE.exec(expression || '');
    if (m) { return { type: m[3] || null, system: unquote(m[1]), code: unquote(m[2]), rest: m[4] }; }
    m = RSHAPE_IN_RE.exec(expression || '');
    return m ? { type: m[2] || null, valueSet: unquote(m[1]), rest: m[3] } : null;
  }

  // ---- the rows: mode 'section' (the first table), 'resource' (the second) or 'text' ----

  function rowFrom(c) {
    var shape = c.shape || null;
    var rshape = c.rshape || null;
    var r = { key: c.key || null, human: c.human || '', expression: c.expression || '', mode: shape ? 'section' : (rshape ? 'resource' : 'text') };
    tableFields(r, shape || { section: { system: LOINC, code: '', min: null, max: null }, entry: null });
    resourceFields(r, rshape || { type: null, system: cfg.systems[0].url, code: '', rest: '.exists()' });
    return r;
  }
  function resourceFields(r, rshape) {
    var byVs = rshape.valueSet !== undefined;
    r.resType = rshape.type || '';
    r.resSystem = byVs ? VS : rshape.system;
    r.resCode = byVs ? '' : rshape.code;
    r.resDisplay = '';
    r.resVs = byVs ? rshape.valueSet : '';
    r.resVsTitle = '';
    r.resRest = rshape.rest;
  }
  /** The expression from the second table's row, or null with what is wrong. */
  function resourceExpression(r) {
    var problems = [];
    var rest = (r.resRest || '').trim();
    var byVs = r.resSystem === VS;
    if (r.resType && !/^[A-Z][A-Za-z]{1,63}$/.test(r.resType)) { problems.push('resType'); }
    if (byVs) {
      if (!CANONICAL_RE.test(r.resVs.trim())) { problems.push('resVs'); }
    } else {
      if (!r.resSystem.trim()) { problems.push('resSystem'); }
      if (!r.resCode.trim()) { problems.push('resCode'); }
    }
    if (!rest || rest === '.') { problems.push('resRest'); }
    if (problems.length) { return { expression: null, problems: problems }; }
    var type = r.resType ? ', ' + quote(r.resType) : '';
    var head = byVs ? 'Bundle.resourcesIn(' + quote(r.resVs.trim()) + type + ')' : 'Bundle.resources(' + quote(r.resSystem.trim()) + ', ' + quote(r.resCode.trim()) + type + ')';
    return { expression: head + (rest.charAt(0) === '.' ? rest : '.' + rest), problems: [] };
  }
  function rowExpression(r) {
    return r.mode === 'section' ? tableExpression(r) : (r.mode === 'resource' ? resourceExpression(r) : { expression: r.expression, problems: [] });
  }
  function tableFields(r, shape) {
    var e = shape.entry;
    r.secSystem = shape.section.system;
    r.secCode = shape.section.code;
    r.secCard = cardText(shape.section);
    r.secDisplay = '';
    r.entSystem = !e ? '' : (e.valueSet !== undefined ? VS : e.system);
    r.entCode = e && e.valueSet === undefined ? e.code : '';
    r.entVs = e && e.valueSet !== undefined ? e.valueSet : '';
    r.entVsTitle = '';
    r.entCard = e ? cardText(e) : '';
    r.entDisplay = '';
  }
  /** The row's expression, from its table, or null with what is wrong. */
  function tableExpression(r) {
    var problems = [];
    var sc = parseCard(r.secCard);
    var ec = parseCard(r.entCard);
    var byVs = r.entSystem === VS;
    if (!r.secSystem.trim()) { problems.push('secSystem'); }
    if (!r.secCode.trim()) { problems.push('secCode'); }
    if (!sc) { problems.push('secCard'); }
    if (r.entSystem.trim() || r.entCode.trim() || r.entCard.trim()) {
      if (byVs) {
        if (!CANONICAL_RE.test(r.entVs.trim())) { problems.push('entVs'); }
      } else {
        if (!r.entSystem.trim()) { problems.push('entSystem'); }
        if (!r.entCode.trim()) { problems.push('entCode'); }
      }
      if (!ec) { problems.push('entCard'); }
    }
    if (problems.length) { return { expression: null, problems: problems }; }
    var x = 'Bundle.section(' + args(r.secSystem.trim(), r.secCode.trim(), sc) + ')';
    if (byVs) { x += '.entryIn(' + quote(r.entVs.trim()) + cardArgs(ec) + ')'; } else if (r.entSystem.trim()) { x += '.entry(' + args(r.entSystem.trim(), r.entCode.trim(), ec) + ')'; }
    return { expression: x + '.exists()', problems: [] };
  }

  var state = { title: cfg.profile.title || '', rows: (cfg.profile.constraints || []).map(rowFrom) };

  // ---- a code, looked up in a system ----

  function codeInput(r, codeField, displayField, systemOf, onChange) {
    var wrap = el('div', { class: 'ips-ed-code' });
    var input = el('input', { type: 'text', class: 'form-control ips-ed-input', placeholder: cfg.urls.lookup ? 'code, or type to look one up' : 'code' });
    input.value = r[codeField];
    var display = el('div', { class: 'ips-pf-display', text: r[displayField] || '' });
    var list = el('div', { class: 'ips-ed-suggestions', hidden: true });
    var timer = null;
    var asked = 0;
    input.addEventListener('input', function () {
      r[codeField] = input.value.trim();
      r[displayField] = '';
      display.textContent = '';
      changed();
      onChange();
      var q = input.value.trim();
      clearTimeout(timer);
      var system = systemOf();
      if (q.length < 2 || !cfg.urls.lookup || !system) { list.hidden = true; return; }
      timer = setTimeout(function () {
        var mine = ++asked;
        fetch(cfg.urls.lookup + '?system=' + encodeURIComponent(system) + '&q=' + encodeURIComponent(q), { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
          .then(function (res) { return res.json(); })
          .then(function (j) {
            if (mine !== asked) { return; }
            list.innerHTML = '';
            var found = j && j.matches ? j.matches : [];
            found.forEach(function (c) {
              list.appendChild(el('div', { class: 'ips-ed-suggestion', onmousedown: function (e) {
                e.preventDefault();
                input.value = c.code;
                r[codeField] = c.code;
                r[displayField] = c.display || '';
                display.textContent = r[displayField];
                list.hidden = true;
                changed();
                onChange();
              } }, [c.display || c.code, ' ', el('small', { text: c.code })]));
            });
            if (!found.length) {
              list.appendChild(el('div', { class: 'ips-ed-suggestion ips-ed-suggestion-text', text: j && j.error ? j.error : 'Nothing found - "' + q + '" is taken as the code' }));
            }
            list.hidden = false;
          })
          .catch(function () { list.hidden = true; });
      }, 250);
    });
    input.addEventListener('blur', function () { setTimeout(function () { list.hidden = true; }, 150); });
    input.addEventListener('keydown', function (e) { if (e.key === 'Escape') { list.hidden = true; } });
    wrap.appendChild(input);
    wrap.appendChild(list);
    wrap.appendChild(display);
    wrap.input = input;
    return wrap;
  }

  // ---- a value set, found by title (this server's own, then the terminology server's), or a canonical typed in ----

  function vsInput(r, field, titleField, onChange) {
    var wrap = el('div', { class: 'ips-ed-code' });
    var input = el('input', { type: 'text', class: 'form-control ips-ed-input', placeholder: 'value set: search by title, or a canonical URL' });
    input.value = r[field];
    var title = el('div', { class: 'ips-pf-display' });
    var list = el('div', { class: 'ips-ed-suggestions', hidden: true });
    var timer = null;
    var asked = 0;
    function showTitle(text, warn) {
      title.textContent = text || '';
      title.style.color = warn ? '#b8860b' : '';
    }
    function lookup(query, then) {
      fetch(cfg.urls.lookupVs + '?' + query, { headers: { Accept: 'application/json' }, credentials: 'same-origin' })
        .then(function (res) { return res.json(); })
        .then(then)
        .catch(function () { then({ matches: [], error: 'The value sets could not be looked up' }); });
    }
    // what is there already: its title, or a warning that it can't be found
    function identify() {
      var url = r[field].trim();
      if (!url || !CANONICAL_RE.test(url)) { showTitle(''); return; }
      if (r[titleField]) { showTitle(r[titleField]); return; }
      var mine = ++asked;
      lookup('url=' + encodeURIComponent(url), function (j) {
        if (mine !== asked) { return; }
        var m = j && j.matches && j.matches[0];
        if (m) { r[titleField] = m.title; showTitle(m.title); } else { showTitle(j && j.error ? j.error : 'Not found on the terminology server: it must be known to it when documents are checked', true); }
      });
    }
    input.addEventListener('input', function () {
      r[field] = input.value.trim();
      r[titleField] = '';
      showTitle('');
      changed();
      onChange();
      var q = input.value.trim();
      clearTimeout(timer);
      if (q.length < 2) { list.hidden = true; return; }
      if (CANONICAL_RE.test(q)) {
        list.hidden = true;
        timer = setTimeout(identify, 400);
        return;
      }
      timer = setTimeout(function () {
        var mine = ++asked;
        lookup('q=' + encodeURIComponent(q), function (j) {
          if (mine !== asked) { return; }
          list.innerHTML = '';
          var found = j && j.matches ? j.matches : [];
          found.forEach(function (v) {
            list.appendChild(el('div', { class: 'ips-ed-suggestion', onmousedown: function (e) {
              e.preventDefault();
              input.value = v.url;
              r[field] = v.url;
              r[titleField] = v.title;
              showTitle(v.title);
              list.hidden = true;
              changed();
              onChange();
            } }, [v.title, v.own ? ' (this server\'s)' : '', el('br'), el('small', { text: v.url + (v.version ? ' (version ' + v.version + ')' : '') })]));
          });
          if (!found.length) {
            list.appendChild(el('div', { class: 'ips-ed-suggestion ips-ed-suggestion-text', text: j && j.error ? j.error : 'No value set has that in its title' }));
          }
          list.hidden = false;
        });
      }, 250);
    });
    input.addEventListener('blur', function () { setTimeout(function () { list.hidden = true; }, 150); });
    input.addEventListener('keydown', function (e) { if (e.key === 'Escape') { list.hidden = true; } });
    wrap.appendChild(input);
    wrap.appendChild(list);
    wrap.appendChild(title);
    wrap.input = input;
    identify();
    return wrap;
  }

  function cardInput(r, field, onChange) {
    var input = el('input', { type: 'text', class: 'form-control ips-ed-input', placeholder: 'any', title: 'blank for any number, or min..max (1..1, 1..*)' });
    input.value = r[field];
    input.addEventListener('input', function () { r[field] = input.value; changed(); onChange(); });
    return input;
  }

  // the section: one of the IPS sections, or any code in any system
  function sectionCell(r, onChange) {
    var cell = el('div');
    var select = el('select', { class: 'form-control ips-ed-input' });
    cfg.sections.forEach(function (s) { select.appendChild(el('option', { value: s.code, text: 'Section: ' + s.title })); });
    select.appendChild(el('option', { value: '', text: 'Another code...' }));
    var isIps = r.secSystem === LOINC && cfg.sections.some(function (s) { return s.code === r.secCode; });
    if (!r.secCode) { r.secSystem = LOINC; r.secCode = cfg.sections[0].code; isIps = true; }
    select.value = isIps ? r.secCode : '';
    var other = el('div');
    other.hidden = isIps;
    var system = el('input', { type: 'text', class: 'form-control ips-ed-input', placeholder: 'code system URL' });
    system.value = r.secSystem;
    system.addEventListener('input', function () { r.secSystem = system.value.trim(); changed(); onChange(); });
    var code = codeInput(r, 'secCode', 'secDisplay', function () { return r.secSystem; }, onChange);
    other.appendChild(el('div', { class: 'ips-pf-pair' }, [system]));
    other.appendChild(code);
    select.addEventListener('change', function () {
      if (select.value) {
        r.secSystem = LOINC;
        r.secCode = select.value;
        other.hidden = true;
      } else {
        other.hidden = false;
        system.value = r.secSystem;
        code.input.value = r.secCode;
      }
      changed();
      onChange();
    });
    cell.appendChild(select);
    cell.appendChild(other);
    return cell;
  }

  // the entry: no entry, entries in a value set, or a code in a named system or any other
  function entryCell(r, onChange) {
    var cell = el('div');
    var select = el('select', { class: 'form-control ips-ed-input' }, [el('option', { value: '', text: '(no entry)' }), el('option', { value: VS, text: 'In a value set...' })]);
    cfg.systems.forEach(function (s) { select.appendChild(el('option', { value: s.url, text: s.name })); });
    select.appendChild(el('option', { value: '*', text: 'Another system...' }));
    var named = r.entSystem === VS || cfg.systems.some(function (s) { return s.url === r.entSystem; });
    select.value = !r.entSystem ? '' : (named ? r.entSystem : '*');
    var url = el('input', { type: 'text', class: 'form-control ips-ed-input', placeholder: 'code system URL' });
    url.value = named ? '' : r.entSystem;
    url.hidden = select.value !== '*';
    url.addEventListener('input', function () { r.entSystem = url.value.trim(); changed(); onChange(); });
    select.addEventListener('change', function () {
      var wasVs = r.entSystem === VS;
      r.entSystem = select.value === '*' ? url.value.trim() : select.value;
      if (!select.value) { r.entCode = ''; r.entCard = ''; r.entVs = ''; }
      changed();
      if (wasVs !== (r.entSystem === VS) || !select.value || select.value === '*') { draw(); } else { onChange(); }
    });
    cell.appendChild(el('div', { class: 'ips-pf-pair' }, [select, url]));
    if (r.entSystem === VS) {
      cell.appendChild(cell.vs = vsInput(r, 'entVs', 'entVsTitle', onChange));
    } else if (r.entSystem || select.value === '*') {
      cell.appendChild(cell.code = codeInput(r, 'entCode', 'entDisplay', function () { return r.entSystem; }, onChange));
    }
    return cell;
  }

  // the second table: the resources' type, their code's system, the code
  function typeCell(r, onChange) {
    var cell = el('div');
    var select = el('select', { class: 'form-control ips-ed-input' }, [el('option', { value: '', text: '(any type)' })]);
    cfg.resourceTypes.forEach(function (t) { select.appendChild(el('option', { value: t, text: t })); });
    select.appendChild(el('option', { value: '*', text: 'Another type...' }));
    var listed = !r.resType || cfg.resourceTypes.indexOf(r.resType) >= 0;
    select.value = listed ? r.resType : '*';
    var other = el('input', { type: 'text', class: 'form-control ips-ed-input', placeholder: 'resource type, e.g. Encounter' });
    other.value = listed ? '' : r.resType;
    other.hidden = listed;
    other.addEventListener('input', function () { r.resType = other.value.trim(); changed(); onChange(); });
    select.addEventListener('change', function () {
      other.hidden = select.value !== '*';
      r.resType = select.value === '*' ? other.value.trim() : select.value;
      changed();
      onChange();
    });
    cell.appendChild(select);
    cell.appendChild(other);
    cell.other = other;
    return cell;
  }
  function systemCell(r, onChange) {
    var cell = el('div');
    var select = el('select', { class: 'form-control ips-ed-input' }, [el('option', { value: VS, text: 'In a value set...' })]);
    cfg.systems.forEach(function (s) { select.appendChild(el('option', { value: s.url, text: s.name })); });
    select.appendChild(el('option', { value: '*', text: 'Another system...' }));
    var named = r.resSystem === VS || cfg.systems.some(function (s) { return s.url === r.resSystem; });
    select.value = named ? r.resSystem : '*';
    var url = el('input', { type: 'text', class: 'form-control ips-ed-input', placeholder: 'code system URL' });
    url.value = named ? '' : r.resSystem;
    url.hidden = named;
    url.addEventListener('input', function () { r.resSystem = url.value.trim(); changed(); onChange(); });
    select.addEventListener('change', function () {
      var wasVs = r.resSystem === VS;
      url.hidden = select.value !== '*';
      r.resSystem = select.value === '*' ? url.value.trim() : select.value;
      changed();
      // the code column becomes a value set's, or a code's
      if (wasVs !== (r.resSystem === VS)) { draw(); } else { onChange(); }
    });
    cell.appendChild(select);
    cell.appendChild(url);
    cell.url = url;
    return cell;
  }

  function drawRow(r, n) {
    var box = el('div', { class: 'ips-pf-row' });
    var human = el('input', { type: 'text', class: 'form-control ips-ed-input', placeholder: 'What is expected (shown to people)' });
    human.value = r.human;
    human.addEventListener('input', function () { r.human = human.value; changed(); });
    var toggle = el('a', { href: '#', class: 'ips-small', text: r.mode === 'text' ? 'Edit as table' : 'Edit as FHIRPath' });
    toggle.addEventListener('click', function (e) {
      e.preventDefault();
      if (r.mode !== 'text') {
        var t = rowExpression(r);
        if (t.expression) { r.expression = t.expression; }
        r.mode = 'text';
      } else {
        var shape = parseShape(r.expression);
        var rshape = shape ? null : parseResourceShape(r.expression);
        if (!shape && !rshape) {
          window.alert('This rule is not one the tables can show: Bundle.section(...).exists(), Bundle.section(...).entry(...).exists() or .entryIn(...).exists(), or Bundle.resources(...) or Bundle.resourcesIn(...) and the rest of the rule');
          return;
        }
        if (shape) { tableFields(r, shape); r.mode = 'section'; } else { resourceFields(r, rshape); r.mode = 'resource'; }
      }
      changed();
      draw();
    });
    var remove = el('button', { type: 'button', class: 'btn btn-default ips-btn', style: 'font-size: 85%; padding: 1px 8px', text: 'Remove' });
    remove.addEventListener('click', function () { state.rows.splice(state.rows.indexOf(r), 1); changed(); draw(); });
    box.appendChild(el('div', { class: 'ips-pf-head' }, [el('b', { text: String(n) + '.' }), human, toggle, remove]));
    if (r.mode === 'text') {
      var text = el('textarea', { class: 'form-control ips-ed-input', rows: 2, placeholder: 'A FHIRPath expression on the document (the Bundle), true when it meets the expectation', style: 'font-family: monospace; width: 100%' });
      text.value = r.expression;
      text.addEventListener('input', function () { r.expression = text.value; changed(); });
      box.appendChild(text);
      return box;
    }
    var exprLine = el('div', { class: 'ips-pf-expr' });
    var fields = {};
    var update = function () {
      var t = rowExpression(r);
      exprLine.textContent = t.expression || '(incomplete)';
      Object.keys(fields).forEach(function (k) { fields[k].classList.toggle('ips-pf-bad', t.problems.indexOf(k) >= 0); });
    };
    var grid;
    if (r.mode === 'section') {
      var sec = sectionCell(r, update);
      var ent = entryCell(r, update);
      fields.secCard = cardInput(r, 'secCard', update);
      fields.entCard = cardInput(r, 'entCard', update);
      if (ent.code) { fields.entCode = ent.code.input; }
      if (ent.vs) { fields.entVs = ent.vs.input; }
      grid = el('table', { class: 'ips-pf-grid' }, [
        el('tr', {}, [el('th', { text: 'Section' }), el('th', { text: 'Cardinality' }), el('th', { text: 'Entries' }), el('th', { text: 'Cardinality' })]),
        el('tr', {}, [el('td', {}, [sec]), el('td', { class: 'ips-pf-card' }, [fields.secCard]), el('td', {}, [ent]), el('td', { class: 'ips-pf-card' }, [fields.entCard])])
      ]);
    } else {
      var type = typeCell(r, update);
      var system = systemCell(r, update);
      var byVs = r.resSystem === VS;
      var code = byVs ? vsInput(r, 'resVs', 'resVsTitle', update) : codeInput(r, 'resCode', 'resDisplay', function () { return r.resSystem; }, update);
      var rest = el('input', { type: 'text', class: 'form-control ips-ed-input', placeholder: '.exists()', style: 'font-family: monospace; width: 100%', title: 'The rest of the rule: FHIRPath on the resources found, starting with a dot' });
      rest.value = r.resRest;
      rest.addEventListener('input', function () { r.resRest = rest.value; changed(); update(); });
      fields.resType = type.other;
      fields.resSystem = system.url;
      fields[byVs ? 'resVs' : 'resCode'] = code.input;
      fields.resRest = rest;
      grid = el('table', { class: 'ips-pf-grid' }, [
        el('tr', {}, [el('th', { text: 'Type' }), el('th', { text: 'System' }), el('th', { text: byVs ? 'Value set' : 'Code' }), el('th', { text: 'Rule' })]),
        el('tr', {}, [el('td', { style: 'width: 16%' }, [type]), el('td', { style: 'width: 18%' }, [system]), el('td', { style: byVs ? 'width: 34%' : 'width: 22%' }, [code]), el('td', {}, [rest])])
      ]);
    }
    box.appendChild(grid);
    box.appendChild(exprLine);
    update();
    return box;
  }

  var ADD_LABELS = { section: 'Add a required section/entry', resource: 'Add a rule about resources', text: 'Add another rule' };
  var MODE_OF_PART = { section: 'section', resource: 'resource', other: 'text' };
  var messages = el('div');

  /** The rows as the page shows them: the parts in order. */
  function ordered() {
    var out = [];
    cfg.parts.forEach(function (p) { state.rows.forEach(function (r) { if (r.mode === MODE_OF_PART[p[0]]) { out.push(r); } }); });
    return out;
  }

  function draw() {
    root.innerHTML = '';
    var title = el('input', { type: 'text', class: 'form-control', placeholder: 'The profile\'s title, e.g. Cardiology referral', style: 'font-size: 110%; font-weight: bold' });
    title.value = state.title;
    title.addEventListener('input', function () { state.title = title.value; changed(); });
    root.appendChild(el('div', { class: 'ips-banner' }, [el('label', { class: 'ips-small', text: 'Title' }), title]));
    var n = 0;
    cfg.parts.forEach(function (p) {
      var mode = MODE_OF_PART[p[0]];
      root.appendChild(el('h4', { text: p[1] }));
      var these = state.rows.filter(function (r) { return r.mode === mode; });
      if (!these.length) { root.appendChild(el('p', { class: 'ips-small', text: 'None.' })); }
      these.forEach(function (r) { root.appendChild(drawRow(r, ++n)); });
      root.appendChild(el('div', { class: 'ips-actions-line' }, [el('button', { type: 'button', class: 'btn btn-default', text: ADD_LABELS[mode], onclick: function () {
        var r = rowFrom({});
        r.mode = mode;
        state.rows.push(r);
        changed();
        draw();
      } })]));
    });
    root.appendChild(messages);
    root.appendChild(el('div', { class: 'ips-actions-line' }, [
      el('button', { type: 'button', class: 'btn btn-primary', text: 'Save', onclick: save }), ' ',
      el('a', { class: 'btn btn-default', href: cfg.urls.back, text: 'Cancel' })
    ]));
  }

  function show(problems, kind) {
    messages.innerHTML = '';
    if (!problems.length) { return; }
    var box = el('div', { class: 'alert alert-' + (kind || 'danger') });
    if (problems.length === 1) { box.textContent = problems[0]; } else {
      box.appendChild(el('ul', { style: 'margin: 0' }, problems.map(function (p) { return el('li', { text: p }); })));
    }
    messages.appendChild(box);
  }

  function save() {
    if (saving) { return; }
    var problems = [];
    // in the page's order, so the numbers in the server's messages are the page's
    var constraints = ordered().map(function (r, i) {
      var t = rowExpression(r);
      if (!t.expression && r.mode !== 'text') { problems.push('Rule ' + (i + 1) + ' is incomplete (the fields in red)'); }
      return { key: r.key, human: r.human, expression: t.expression || '' };
    });
    if (!state.title.trim()) { problems.unshift('The profile needs a title'); }
    if (problems.length) { show(problems); return; }
    saving = true;
    show(['Saving...'], 'info');
    fetch(cfg.urls.save, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ title: state.title, constraints: constraints, _csrf: cfg.csrf }) })
      .then(function (res) {
        return res.json().then(function (j) { return { ok: res.ok, j: j }; }, function () { return { ok: false, j: { problems: ['The server answered ' + res.status + (res.status === 403 ? ' (has your session expired? reload the page)' : '')] } }; });
      })
      .then(function (a) {
        saving = false;
        if (a.ok) { dirty = false; location.href = a.j.url; return; }
        show(a.j.problems || ['The profile was not saved']);
      })
      .catch(function (e) { saving = false; show(['The profile was not saved: ' + e.message]); });
  }

  window.addEventListener('beforeunload', function (e) { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
  draw();
})();
