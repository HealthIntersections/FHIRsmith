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
 * With cfg.mode 'rows' it is the profile's own page instead: the rows are the page's tables,
 * and one at a time is added or edited, in a dialog, and saved by itself.
 */
(function () {
  'use strict';
  var cfg = window.IPS_PROFILE;
  var root = document.getElementById('ips-profile-editor');
  var LOINC = cfg.sectionSystem;
  var dirty = false;
  var saving = false;
  // what to draw again when a row's fields change shape: the whole editor, or the row being edited
  var redraw = function () { draw(); };

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
  // a FHIRPath string's escapes: \' \" \` \\ \/ \f \n \r \t and \uXXXX
  function unquote(s) {
    return s.replace(/\\(u[0-9a-fA-F]{4}|.)/g, function (m, c) {
      return c.length === 5 ? String.fromCharCode(parseInt(c.substring(1), 16)) : ({ n: '\n', r: '\r', t: '\t', f: '\f' }[c] || c);
    });
  }
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
      var was = r.entSystem;
      var wasVs = was === VS;
      r.entSystem = select.value === '*' ? url.value.trim() : select.value;
      if (!select.value) { r.entCode = ''; r.entCard = ''; r.entVs = ''; }
      changed();
      // the code (or value set) input comes and goes with the choice
      if (!was || wasVs !== (r.entSystem === VS) || !select.value || select.value === '*') { redraw(); } else { onChange(); }
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
      if (wasVs !== (r.resSystem === VS)) { redraw(); } else { onChange(); }
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

  // ---- the profile's page: a rule at a time, added or edited in a dialog ----

  // what must be true of the resources a rule is about: the rest of the rule, by kind
  var NAME_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)?$/;
  var RULE_KINDS = [
    ['present', 'Must be present somewhere'],
    ['subject', 'Patient must match the Document'],
    ['element', 'Must have an element'],
    ['conforms', 'Conform to a profile'],
    ['category', 'Has a category'],
    ['other', 'Something else (FHIRPath)']
  ];
  function allOf(body) { return new RegExp('^\\.\\s*(?:' + body + '|all\\s*\\(\\s*' + body + '\\s*\\))$'); }
  var CONFORMS_RE = allOf('conformsTo\\s*\\(\\s*' + STR + '\\s*\\)');
  var CATEGORY_RE = allOf('category\\s*\\.\\s*hasCoding\\s*\\(\\s*' + STR + '\\s*,\\s*' + STR + '\\s*(?:,\\s*' + STR + '\\s*)?\\)');

  /** the rule's kind, and its fields, from the rest of a rule about resources */
  function ruleFields(r) {
    var rest = (r.resRest || '').trim();
    var m;
    r.ruleKind = 'other';
    r.ruleOther = rest;
    r.ruleUrl = ''; r.ruleSystem = cfg.categorySystem || ''; r.ruleCode = ''; r.ruleVersion = ''; r.rulePath = ''; r.ruleDisplay = '';
    r.ruleAll = true;
    if (/^\.\s*exists\s*\(\s*\)$/.test(rest)) {
      r.ruleKind = 'present';
    } else if (/^\.\s*all\s*\(\s*sameSubject\s*\(\s*\)\s*\)$/.test(rest)) {
      r.ruleKind = 'subject';
    } else if ((m = CONFORMS_RE.exec(rest))) {
      r.ruleKind = 'conforms';
      r.ruleAll = m[1] === undefined;
      r.ruleUrl = unquote(m[1] !== undefined ? m[1] : m[2]);
    } else if ((m = CATEGORY_RE.exec(rest))) {
      r.ruleKind = 'category';
      r.ruleAll = m[1] === undefined;
      var g = m[1] !== undefined ? [m[1], m[2], m[3]] : [m[4], m[5], m[6]];
      r.ruleSystem = unquote(g[0]); r.ruleCode = unquote(g[1]); r.ruleVersion = g[2] !== undefined ? unquote(g[2]) : '';
    } else if ((m = /^\.\s*([A-Za-z][A-Za-z0-9_]*(?:\s*\.\s*[A-Za-z][A-Za-z0-9_]*)?)\s*\.\s*exists\s*\(\s*\)$/.exec(rest))) {
      r.ruleKind = 'element';
      r.rulePath = m[1].replace(/\s+/g, '');
    }
  }
  /** the rest of a rule about resources, from its kind and fields, or null with what is wrong */
  function ruleRest(r) {
    var each = function (body) { return r.ruleAll ? '.all(' + body + ')' : '.' + body; };
    switch (r.ruleKind) {
      case 'present': return { rest: '.exists()', problems: [] };
      case 'subject': return { rest: '.all(sameSubject())', problems: [] };
      case 'element': return NAME_RE.test(r.rulePath.trim()) ? { rest: '.' + r.rulePath.trim() + '.exists()', problems: [] } : { rest: null, problems: ['rulePath'] };
      case 'conforms': return CANONICAL_RE.test(r.ruleUrl.trim()) ? { rest: each('conformsTo(' + quote(r.ruleUrl.trim()) + ')'), problems: [] } : { rest: null, problems: ['ruleUrl'] };
      case 'category': {
        var problems = [];
        if (!r.ruleSystem.trim()) { problems.push('ruleSystem'); }
        if (!r.ruleCode.trim()) { problems.push('ruleCode'); }
        if (problems.length) { return { rest: null, problems: problems }; }
        return { rest: each('category.hasCoding(' + quote(r.ruleSystem.trim()) + ', ' + quote(r.ruleCode.trim()) + (r.ruleVersion.trim() ? ', ' + quote(r.ruleVersion.trim()) : '') + ')'), problems: [] };
      }
      default: {
        var rest = (r.ruleOther || '').trim();
        return rest && rest !== '.' ? { rest: rest.charAt(0) === '.' ? rest : '.' + rest, problems: [] } : { rest: null, problems: ['ruleOther'] };
      }
    }
  }
  /** the expression of a row in the dialog, or null with what is wrong */
  function dialogExpression(r) {
    if (r.mode !== 'resource') { return rowExpression(r); }
    var t = ruleRest(r);
    r.resRest = t.rest || '';
    var e = resourceExpression(r);
    return { expression: t.rest ? e.expression : null, problems: t.problems.concat(e.problems.filter(function (p) { return p !== 'resRest'; })) };
  }

  function rowsMode() {
    var MODE = { section: 'section', resource: 'resource', other: 'text' };
    var TITLES = { section: 'a required section or entry', resource: 'a rule about resources', text: 'a rule' };
    var byKey = {};
    (cfg.profile.constraints || []).forEach(function (c) { byKey[c.key] = c; });
    var dialog = el('dialog', { class: 'ips-pf-dialog', 'aria-labelledby': 'ips-pf-dialog-title' });
    document.body.appendChild(dialog);
    var editing = null;

    function showIn(box, problems, kind) {
      box.innerHTML = '';
      if (!problems.length) { return; }
      var alert = el('div', { class: 'alert alert-' + (kind || 'danger'), style: 'margin: 0' });
      if (problems.length === 1) { alert.textContent = problems[0]; } else {
        alert.appendChild(el('ul', { style: 'margin: 0' }, problems.map(function (p) { return el('li', { text: p }); })));
      }
      box.appendChild(alert);
    }
    // a labelled part of the dialog: a label, what goes in it, and a hint
    function field(label, controls, hint) {
      return el('div', { class: 'ips-pf-field' }, [el('label', { class: 'ips-pf-label', text: label })].concat(controls).concat(hint ? [el('div', { class: 'ips-pf-hint', text: hint })] : []));
    }
    function howMany(r, fieldName, update, fields) {
      var input = cardInput(r, fieldName, update);
      fields[fieldName] = input;
      return el('div', { class: 'ips-pf-pair ips-pf-how' }, [el('span', { text: 'How many' }), input,
        el('span', { class: 'ips-pf-hint', text: 'blank: at least one; or min..max - 1..1, 0..1, 1..*' })]);
    }
    // a code system for the category: one of the named ones, or another by URL
    function categorySystem(r, update) {
      var cell = el('div', { class: 'ips-pf-pair' });
      var select = el('select', { class: 'form-control ips-ed-input' });
      cfg.systems.forEach(function (s) { select.appendChild(el('option', { value: s.url, text: s.name })); });
      (cfg.categorySystems || []).forEach(function (s) { select.appendChild(el('option', { value: s.url, text: s.name })); });
      select.appendChild(el('option', { value: '*', text: 'Another system...' }));
      var known = Array.prototype.some.call(select.options, function (o) { return o.value === r.ruleSystem; });
      select.value = known ? r.ruleSystem : '*';
      var url = el('input', { type: 'text', class: 'form-control ips-ed-input', placeholder: 'code system URL' });
      url.value = known ? '' : r.ruleSystem;
      url.hidden = known;
      url.addEventListener('input', function () { r.ruleSystem = url.value.trim(); changed(); update(); });
      select.addEventListener('change', function () {
        url.hidden = select.value !== '*';
        r.ruleSystem = select.value === '*' ? url.value.trim() : select.value;
        changed();
        update();
      });
      cell.appendChild(select);
      cell.appendChild(url);
      cell.url = url;
      return cell;
    }

    /** the dialog's contents, (re)drawn for the row being edited */
    function drawDialog() {
      var e = editing;
      var r = e.r;
      dialog.innerHTML = '';
      var fields = {};
      var exprLine = el('div', { class: 'ips-pf-expr' });
      var update = function () {
        var t = dialogExpression(r);
        exprLine.textContent = r.mode === 'text' ? '' : (t.expression || '(incomplete - the fields in red)');
        Object.keys(fields).forEach(function (k) { fields[k].classList.toggle('ips-pf-bad', t.problems.indexOf(k) >= 0); });
      };
      var body = el('div', { class: 'ips-pf-dialog-body' });
      var human = el('textarea', { class: 'form-control', rows: 2, placeholder: 'e.g. A problem list, with the patient\'s hypertension' });
      human.value = r.human;
      human.addEventListener('input', function () { r.human = human.value; changed(); });
      body.appendChild(field('Expectation', [human], 'What is expected, as people will read it.'));

      if (r.mode === 'section') {
        body.appendChild(field('Section', [sectionCell(r, update), howMany(r, 'secCard', update, fields)]));
        var ent = entryCell(r, update);
        if (ent.code) { fields.entCode = ent.code.input; }
        if (ent.vs) { fields.entVs = ent.vs.input; }
        body.appendChild(field('Entries', [ent].concat(r.entSystem ? [howMany(r, 'entCard', update, fields)] : []),
          'Optionally, entries the section must have: with a code in a code system, or a code in a value set.'));
      } else if (r.mode === 'resource') {
        var type = typeCell(r, update);
        var system = systemCell(r, update);
        var byVs = r.resSystem === VS;
        var code = byVs ? vsInput(r, 'resVs', 'resVsTitle', update) : codeInput(r, 'resCode', 'resDisplay', function () { return r.resSystem; }, update);
        fields.resType = type.other;
        fields.resSystem = system.url;
        fields[byVs ? 'resVs' : 'resCode'] = code.input;
        body.appendChild(field('Resources', [type], 'The type of resource, or any.'));
        body.appendChild(field('With a code', [system, code], 'Anywhere in the document, whatever section they are in.'));
        var kind = el('select', { class: 'form-control ips-ed-input' });
        RULE_KINDS.forEach(function (k) { kind.appendChild(el('option', { value: k[0], text: k[1] })); });
        kind.value = r.ruleKind;
        kind.addEventListener('change', function () { r.ruleKind = kind.value; changed(); drawDialog(); });
        var more = [];
        if (r.ruleKind === 'element') {
          var path = el('input', { type: 'text', class: 'form-control ips-ed-input', placeholder: 'e.g. onset, or code.text' });
          path.value = r.rulePath;
          path.addEventListener('input', function () { r.rulePath = path.value; changed(); update(); });
          fields.rulePath = path;
          more.push(field('Element', [path], 'An element of the resources, or an element of one of their elements (one dot, no deeper).'));
        } else if (r.ruleKind === 'conforms') {
          var url = el('input', { type: 'text', class: 'form-control ips-ed-input', placeholder: 'the profile\'s canonical URL' });
          url.value = r.ruleUrl;
          url.addEventListener('input', function () { r.ruleUrl = url.value; changed(); update(); });
          fields.ruleUrl = url;
          more.push(field('Profile', [url], 'Each of the resources must conform to it. It can be one of the clinical profiles, or a profile the validator has loaded.'));
        } else if (r.ruleKind === 'category') {
          var csys = categorySystem(r, update);
          var ccode = codeInput(r, 'ruleCode', 'ruleDisplay', function () { return r.ruleSystem; }, update);
          var version = el('input', { type: 'text', class: 'form-control ips-ed-input', placeholder: 'version (optional)' });
          version.value = r.ruleVersion;
          version.addEventListener('input', function () { r.ruleVersion = version.value; changed(); update(); });
          fields.ruleSystem = csys.url;
          fields.ruleCode = ccode.input;
          more.push(field('Category', [csys, ccode, version], 'Each of the resources must have a category with this code.'));
        } else if (r.ruleKind === 'other') {
          var other = el('textarea', { class: 'form-control ips-ed-input', rows: 3, placeholder: '.count() = 1', style: 'font-family: monospace' });
          other.value = r.ruleOther;
          other.addEventListener('input', function () { r.ruleOther = other.value; changed(); update(); });
          fields.ruleOther = other;
          more.push(field('FHIRPath', [other], 'FHIRPath on the resources found, starting with a dot.'));
        }
        body.appendChild(field('What must be true', [kind].concat(more)));
      } else {
        var text = el('textarea', { class: 'form-control ips-ed-input', rows: 5, placeholder: 'A FHIRPath expression on the document (the Bundle), true when it meets the expectation', style: 'font-family: monospace' });
        text.value = r.expression;
        text.addEventListener('input', function () { r.expression = text.value; changed(); });
        body.appendChild(field('FHIRPath', [text], 'Evaluated on the document (the Bundle): the rule is met when it is true.'));
      }
      if (r.mode !== 'text') { body.appendChild(field('As FHIRPath', [exprLine])); }
      body.appendChild(e.msg);

      var save = el('button', { type: 'button', class: 'btn btn-primary', text: 'Save', onclick: function () { saveRow(); } });
      var cancel = el('button', { type: 'button', class: 'btn btn-default', text: 'Cancel', onclick: function () { stop(false); } });
      e.save = save;
      dialog.appendChild(el('div', { class: 'ips-pf-dialog-head' }, [
        el('h4', { id: 'ips-pf-dialog-title', text: (r.key ? 'Edit ' : 'Add ') + TITLES[r.mode] }),
        el('button', { type: 'button', class: 'ips-pf-dialog-x', 'aria-label': 'Close', text: '×', onclick: function () { stop(false); } })
      ]));
      dialog.appendChild(body);
      dialog.appendChild(el('div', { class: 'ips-pf-dialog-foot' }, [cancel, ' ', save]));
      update();
      if (!e.focused) { e.focused = true; human.focus(); }
    }

    function start(r) {
      if (editing) { return; }
      if (r.mode === 'resource') { ruleFields(r); }
      editing = { r: r, msg: el('div', { class: 'ips-pf-messages' }) };
      dirty = false;
      drawDialog();
      dialog.showModal();
    }
    // close the dialog: when there are changes, only if the user says so (unless saved)
    function stop(saved) {
      if (!editing) { return; }
      if (!saved && dirty && !window.confirm('Discard your changes to this rule?')) { return; }
      editing = null;
      dirty = false;
      dialog.close();
    }
    dialog.addEventListener('cancel', function (ev) { ev.preventDefault(); stop(false); });

    function saveRow() {
      var e = editing;
      if (!e || saving) { return; }
      var t = dialogExpression(e.r);
      if (!t.expression && e.r.mode !== 'text') { showIn(e.msg, ['The rule is incomplete (the fields in red)']); return; }
      saving = true;
      e.save.disabled = true;
      showIn(e.msg, ['Saving...'], 'info');
      var url = cfg.urls.constraint + (e.r.key ? '/' + encodeURIComponent(e.r.key) : '');
      fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ human: e.r.human, expression: t.expression || '', _csrf: cfg.csrf }) })
        .then(function (res) {
          return res.json().then(function (j) { return { ok: res.ok, j: j }; }, function () { return { ok: false, j: { problems: ['The server answered ' + res.status + (res.status === 403 ? ' (has your session expired? reload the page)' : '')] } }; });
        })
        .then(function (a) {
          saving = false;
          if (a.ok) { stop(true); location.reload(); return; }
          e.save.disabled = false;
          showIn(e.msg, a.j.problems || ['The rule was not saved']);
        })
        .catch(function (x) { saving = false; e.save.disabled = false; showIn(e.msg, ['The rule was not saved: ' + x.message]); });
    }

    redraw = drawDialog;
    Array.prototype.forEach.call(document.querySelectorAll('.ips-pf-edit'), function (b) {
      b.addEventListener('click', function () {
        var c = byKey[b.closest('tr').getAttribute('data-key')];
        if (c) { start(rowFrom(c)); }
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('.ips-pf-add'), function (b) {
      b.addEventListener('click', function () {
        var r = rowFrom({});
        r.mode = MODE[b.getAttribute('data-part')];
        start(r);
      });
    });
  }

  window.addEventListener('beforeunload', function (e) { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
  if (cfg.mode === 'rows') { rowsMode(); } else { draw(); }
})();
