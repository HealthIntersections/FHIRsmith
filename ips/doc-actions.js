//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/*
 * What every document creator (the general and patient IPS editors) offers once it has a
 * document: submit it to a project, download it as JSON, a ZIP or a PDF (with the document
 * attached), or share it as a QR code - an SMART Health Link, or a WHO (GDHCN) QR code (a
 * Verifiable Health Link). The choices are there only when the server says the document is a
 * minimal IPS (/compose/check, or the problems the general editor's build returns).
 *
 *   var actions = IpsDocActions.create(element, config, {
 *     html: function (bundle) { ... },        // optional: the HTML for the PDF
 *     attachments: function () { ... },      // optional: [{name, file, description}] for the PDF and ZIP
 *     onSubmitted: function () { ... }        // optional: before going to the submitted document
 *   });
 *   actions.setBundle(bundle);               // checks it with the server
 *   actions.setBundle(bundle, problems);     // the caller already knows what's wrong ([] for nothing)
 *   actions.clear();                         // no document (yet)
 *
 * config is what the page was given (ips.js actionsConfig): the project (or the projects to
 * choose from), whether sharing is configured, and the URLs.
 */
(function () {
  'use strict';

  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'class') { e.className = attrs[k]; } else if (k === 'text') { e.textContent = attrs[k]; } else if (k.indexOf('on') === 0) { e.addEventListener(k.substring(2), attrs[k]); } else if (attrs[k] !== undefined && attrs[k] !== null && attrs[k] !== false) { e.setAttribute(k, attrs[k] === true ? '' : attrs[k]); }
    });
    (children || []).forEach(function (c) { if (c) { e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); } });
    return e;
  }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function problemList(title, problems) {
    return el('div', { class: 'alert alert-warning', style: 'margin: 6px 0' }, [el('b', { text: title }), el('ul', {}, problems.map(function (p) { return el('li', { text: p }); }))]);
  }
  function save(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = el('a', { href: url, download: name });
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function postJson(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' })
      .then(function (r) {
        return r.json().catch(function () { return { error: 'HTTP ' + r.status }; }).then(function (j) {
          if (!r.ok) {
            var e = new Error(j.error || ('HTTP ' + r.status));
            e.problems = j.problems || [];
            throw e;
          }
          return j;
        });
      });
  }

  // the libraries for the downloads, loaded when first needed
  var loading = {};
  function loadScript(url) {
    if (!loading[url]) {
      loading[url] = new Promise(function (resolve, reject) {
        var s = el('script', { src: url });
        s.onload = resolve;
        s.onerror = function () { reject(new Error('Could not load ' + url)); };
        document.head.appendChild(s);
      });
    }
    return loading[url];
  }

  // ---- the document as HTML, for the PDF, when the editor doesn't give its own ----

  var DROP = { SCRIPT: 1, STYLE: 1, IFRAME: 1, OBJECT: 1, EMBED: 1, LINK: 1, META: 1, FORM: 1, INPUT: 1, BUTTON: 1, TEXTAREA: 1, SELECT: 1 };
  function clean(node) {
    Array.prototype.slice.call(node.childNodes).forEach(function (c) {
      if (c.nodeType === 1) {
        if (DROP[c.tagName.toUpperCase()]) { node.removeChild(c); return; }
        Array.prototype.slice.call(c.attributes).forEach(function (a) {
          var n = a.name.toLowerCase();
          if (n.indexOf('on') === 0 || ((n === 'href' || n === 'src') && !/^(https?:|data:image\/|#)/i.test(a.value))) { c.removeAttribute(a.name); }
        });
        clean(c);
      } else if (c.nodeType !== 3) {
        node.removeChild(c);
      }
    });
    return node;
  }
  function narrative(div) {
    if (typeof div !== 'string' || !div) { return ''; }
    var doc = new DOMParser().parseFromString('<body>' + div + '</body>', 'text/html');
    return clean(doc.body).innerHTML;
  }
  function resolve(bundle, ref) {
    if (!ref || typeof ref.reference !== 'string') { return null; }
    var r = ref.reference;
    var found = null;
    (bundle.entry || []).forEach(function (e) {
      if (!found && e && e.resource && (e.fullUrl === r || (e.resource.resourceType + '/' + e.resource.id) === r || (e.fullUrl && e.fullUrl.slice(-r.length - 1) === '/' + r))) { found = e.resource; }
    });
    return found;
  }
  function nameOf(p) {
    var n = p && Array.isArray(p.name) ? p.name[0] : null;
    if (!n) { return ''; }
    return n.text || ((n.given || []).join(' ') + ' ' + (n.family || '')).trim();
  }
  function defaultHtml(bundle) {
    var comp = bundle.entry[0].resource;
    var patient = resolve(bundle, comp.subject);
    var h = '<h1>' + escapeHtml(comp.title || 'Patient Summary') + '</h1>';
    if (patient) {
      h += '<p><b>' + escapeHtml(nameOf(patient)) + '</b>' + (patient.birthDate ? ', born ' + escapeHtml(patient.birthDate) : '') + (patient.gender ? ', ' + escapeHtml(patient.gender) : '') + '</p>';
    }
    h += '<p>' + (comp.date ? 'Date: ' + escapeHtml(comp.date) : '') + '</p>';
    (comp.section || []).forEach(function (s) {
      h += '<h2>' + escapeHtml(s.title || (s.code && s.code.text) || 'Section') + '</h2>';
      h += s.text && s.text.div ? narrative(s.text.div) : (s.emptyReason ? '<p><i>' + escapeHtml((s.emptyReason.coding && s.emptyReason.coding[0] && s.emptyReason.coding[0].display) || s.emptyReason.text || 'Empty') + '</i></p>' : '');
    });
    return h;
  }

  // ---- the actions ----

  function create(container, cfg, hooks) {
    hooks = hooks || {};
    var bundle = null;
    var ready = false;
    var checking = 0;
    var status = el('div', { class: 'ips-small' });
    var messages = el('div', {});
    var qr = el('div', {});
    var buttons = [];
    function button(label, cls, onclick, title) {
      var b = el('button', { type: 'button', class: 'btn ' + cls, onclick: onclick, title: title, disabled: true }, [label]);
      buttons.push(b);
      return b;
    }
    function enable(on) {
      buttons.forEach(function (b) { b.disabled = !on; });
    }
    function json() { return JSON.stringify(bundle, null, 2); }
    function failed(what, e) {
      messages.innerHTML = '';
      messages.appendChild(e.problems && e.problems.length ? problemList(what + ': ' + e.message, e.problems) : el('div', { class: 'alert alert-danger', text: what + ': ' + e.message }));
    }
    function attachments() {
      try { return (hooks.attachments && hooks.attachments()) || []; } catch (e) { return []; }
    }

    // submit
    var submitPart = el('span', {});
    var projectSelect = null;
    var tokenInput = el('input', { type: 'password', class: 'form-control', style: 'display: inline-block; width: 12em', placeholder: 'Submission token', autocomplete: 'off', 'aria-label': 'Submission token' });
    function needsToken() {
      if (cfg.project) { return cfg.project.needsToken; }
      var p = (cfg.projects || []).filter(function (x) { return projectSelect && x.code === projectSelect.value; })[0];
      return !!(p && p.needsToken);
    }
    function showToken() { tokenInput.style.display = needsToken() ? 'inline-block' : 'none'; }
    function submit() {
      var project = cfg.project ? cfg.project.code : (projectSelect ? projectSelect.value : '');
      if (!project) { failed('Not submitted', new Error('Choose the project to submit the document to')); return; }
      messages.innerHTML = '<p><i>Submitting...</i></p>';
      postJson(cfg.urls.submit, { project: project, token: tokenInput.value, bundle: bundle, editor: cfg.editor })
        .then(function (j) {
          if (hooks.onSubmitted) { hooks.onSubmitted(j); }
          messages.innerHTML = '<p class="text-success">Submitted as document ' + escapeHtml(String(j.id)) + '. Opening it...</p>';
          window.location.href = j.url;
        })
        .catch(function (e) { failed('Not submitted', e); });
    }
    if (cfg.project) {
      submitPart.appendChild(button('Submit to ' + cfg.project.name, 'btn-primary', submit, 'Add the document to ' + cfg.project.name + ', where everyone can see it'));
    } else if ((cfg.projects || []).length) {
      projectSelect = el('select', { class: 'form-control', style: 'display: inline-block; width: auto', 'aria-label': 'Project', onchange: showToken },
        [el('option', { value: '', text: '(choose a project)' })].concat(cfg.projects.map(function (p) { return el('option', { value: p.code, text: p.name }); })));
      submitPart.appendChild(button('Submit to', 'btn-primary', submit, 'Add the document to the project, where everyone can see it'));
      submitPart.appendChild(document.createTextNode(' '));
      submitPart.appendChild(projectSelect);
    }
    if (cfg.project || (cfg.projects || []).length) {
      submitPart.appendChild(document.createTextNode(' '));
      submitPart.appendChild(tokenInput);
      showToken();
    }

    // downloads
    function downloadJson() { save(new Blob([json()], { type: 'application/fhir+json' }), 'patient-ips.json'); }
    function downloadZip() {
      messages.innerHTML = '<p><i>Making the ZIP...</i></p>';
      loadScript(cfg.urls.vendor.zip).then(function () {
        window.zip.configure({ useWebWorkers: false });
        var writer = new window.zip.ZipWriter(new window.zip.BlobWriter('application/zip'));
        var adds = [writer.add('patient-ips.json', new window.zip.TextReader(json()))];
        attachments().forEach(function (a) { adds.push(writer.add(a.name, new window.zip.BlobReader(a.file))); });
        return Promise.all(adds).then(function () { return writer.close(); });
      }).then(function (blob) {
        save(blob, 'patient-document.zip');
        messages.innerHTML = '';
      }).catch(function (e) { failed('The ZIP could not be made', e); });
    }
    function downloadPdf() {
      messages.innerHTML = '<p><i>Making the PDF...</i></p>';
      var holder = el('div', { style: 'position: absolute; left: -10000px; top: 0; width: 675px; background: white; color: black; font-family: sans-serif; font-size: 12px' });
      holder.innerHTML = hooks.html ? hooks.html(bundle) : defaultHtml(bundle);
      document.body.appendChild(holder);
      Promise.all([loadScript(cfg.urls.vendor.jspdf), loadScript(cfg.urls.vendor.html2canvas), loadScript(cfg.urls.vendor.pdflib)]).then(function () {
        return new Promise(function (resolve, reject) {
          var doc = new window.jspdf.jsPDF('p', 'pt', 'a4');
          try {
            doc.html(holder, { callback: resolve, margin: [20, 20, 20, 20], autoPaging: 'text', x: 0, y: 0, width: 555, windowWidth: 675 });
          } catch (e) { reject(e); }
        });
      }).then(function (doc) {
        return window.PDFLib.PDFDocument.load(doc.output('arraybuffer'));
      }).then(function (pdf) {
        var adds = [pdf.attach(new TextEncoder().encode(json()), 'patient-ips.json', { mimeType: 'application/fhir+json', description: 'IPS Document' })];
        attachments().forEach(function (a) {
          adds.push(a.file.arrayBuffer().then(function (bytes) { return pdf.attach(bytes, a.name, { mimeType: a.file.type || 'application/octet-stream', description: a.description || a.name }); }));
        });
        return Promise.all(adds).then(function () { return pdf.save(); });
      }).then(function (bytes) {
        save(new Blob([bytes], { type: 'application/pdf' }), 'patient-document.pdf');
        messages.innerHTML = '';
      }).catch(function (e) { failed('The PDF could not be made', e); })
        .finally(function () { document.body.removeChild(holder); });
    }

    // sharing
    var days = el('input', { type: 'number', min: 1, max: 365, value: String(cfg.shareDays || 5), class: 'form-control', style: 'display: inline-block; width: 5em', 'aria-label': 'Days the document is available' });
    function share(kind) {
      messages.innerHTML = '<p><i>Sharing...</i></p>';
      postJson(cfg.urls.share, { kind: kind, days: days.value, bundle: bundle })
        .then(function (out) {
          messages.innerHTML = '';
          qr.innerHTML = '';
          var label = kind === 'vhl' ? 'WHO (GDHCN) QR code - a Verifiable Health Link' : 'QR code - a SMART Health Link';
          var pic = el('div', { style: 'max-width: 320px' });
          pic.innerHTML = out.qr; // an SVG this server made
          qr.appendChild(el('div', { class: 'ips-explain' }, [
            el('p', {}, [el('b', { text: label }), document.createTextNode(' (available until ' + out.expires.substring(0, 10) + ')')]),
            pic,
            kind === 'shl' ? el('p', { class: 'ips-small' }, ['Link: ', el('a', { href: out.text, target: '_blank', rel: 'noopener', text: out.text.length > 90 ? out.text.substring(0, 90) + '...' : out.text })]) : el('p', { class: 'ips-small', style: 'word-break: break-all', text: out.text.length > 90 ? out.text.substring(0, 90) + '...' : out.text })
          ]));
        })
        .catch(function (e) { failed('Not shared', e); });
    }

    var rows = [];
    if (submitPart.childNodes.length) { rows.push(el('p', {}, [submitPart])); }
    rows.push(el('p', {}, ['Download as ',
      button('JSON', 'btn-default btn-sm', downloadJson, 'The document (FHIR JSON)'), ' | ',
      button('ZIP', 'btn-default btn-sm', downloadZip, 'The document, and anything attached, in a ZIP file'), ' | ',
      button('PDF', 'btn-default btn-sm', downloadPdf, 'The document as a PDF, with the document (and anything attached) attached to it')]));
    if (cfg.canShare) {
      rows.push(el('p', {}, ['Get ',
        button('QR Code', 'btn-default btn-sm', function () { share('shl'); }, 'A SMART Health Link to the document' + (cfg.urls.viewer ? ', which opens in this server\'s viewer' : '')), ' | ',
        button('WHO QR Code', 'btn-default btn-sm', function () { share('vhl'); }, 'A WHO (GDHCN) QR code: a Verifiable Health Link to the document'),
        ' available for ', days, ' days',
        el('br'), el('span', { class: 'ips-small', text: 'Sharing stores the document on this server, encrypted with a key that is only in the QR code.' })]));
    }
    var root = el('div', { class: 'ips-ed-actions' }, [el('h4', { text: 'The document' }), status].concat(rows).concat([messages, qr]));
    container.appendChild(root);

    function show(problems) {
      ready = problems.length === 0;
      enable(ready);
      status.innerHTML = '';
      if (ready) {
        status.appendChild(el('p', { class: 'text-success', text: 'This is a minimal IPS: it can be submitted, downloaded and shared.' }));
      } else {
        status.appendChild(problemList('Not ready yet - before it can be submitted, downloaded or shared:', problems));
      }
    }
    var api = {
      setBundle: function (b, problems) {
        bundle = b;
        qr.innerHTML = '';
        messages.innerHTML = '';
        if (!b) { show(problems && problems.length ? problems : ['There is no document yet']); return; }
        if (problems) { show(problems); return; }
        var mine = ++checking;
        enable(false);
        status.innerHTML = '<p class="ips-small"><i>Checking the document...</i></p>';
        postJson(cfg.urls.check, { bundle: b }).then(function (j) {
          if (mine === checking) { show(j.problems || []); }
        }).catch(function (e) {
          if (mine === checking) { show(e.problems && e.problems.length ? e.problems : [e.message]); }
        });
      },
      clear: function () { bundle = null; enable(false); status.innerHTML = ''; messages.innerHTML = ''; qr.innerHTML = ''; },
      bundle: function () { return bundle; },
      ready: function () { return ready; }
    };
    api.clear();
    return api;
  }

  window.IpsDocActions = { create: create, defaultHtml: defaultHtml };
})();
