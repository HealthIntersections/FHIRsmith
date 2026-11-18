/*
 * Copyright (c) 2025+, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
 * Licensed under Creative Commons Public Domain (CC0)
 *
 * Tiny i18n runtime for the Patient Document Generator.
 *
 * Usage in markup:
 *   <span data-i18n="aboutMe.name.label">Consumer Name</span>
 *       -> replaces textContent with the looked-up message
 *
 *   <input data-i18n-attr="placeholder:aboutMe.name.placeholder" />
 *       -> sets the named attribute(s). Multiple attrs: "placeholder:k1;value:k2"
 *
 *   <span data-i18n-html="notes.welcome">...</span>
 *       -> replaces innerHTML (use sparingly; only when the message contains markup)
 *
 * Behaviour:
 *   - Detects language from navigator.languages, falls back to 'en'.
 *   - Fetches assets/i18n/<lang>.json. On failure falls back to en.json.
 *   - Original markup is the authoritative English fallback if a key is missing,
 *     so the page degrades gracefully if a translation is incomplete or the
 *     runtime fails to load.
 *
 * To add a language: drop a new JSON file at assets/i18n/<code>.json and add
 * the code to SUPPORTED below.
 */
(function () {
  'use strict';

  var SUPPORTED = ['en', 'tl'];
  // Map related BCP47 codes onto an existing catalog (e.g. Filipino -> Tagalog).
  var ALIAS = { fil: 'tl' };
  var FALLBACK = 'en';

  function resolveCode(code) {
    if (SUPPORTED.indexOf(code) !== -1) return code;
    if (ALIAS[code] && SUPPORTED.indexOf(ALIAS[code]) !== -1) return ALIAS[code];
    return null;
  }

  function pickLanguage() {
    var candidates = navigator.languages || [navigator.language || FALLBACK];
    for (var i = 0; i < candidates.length; i++) {
      if (!candidates[i]) continue;
      var code = candidates[i].toLowerCase().split('-')[0];
      var resolved = resolveCode(code);
      if (resolved) return resolved;
    }
    return FALLBACK;
  }

  function lookup(messages, key) {
    if (!messages || !key) return undefined;
    var parts = key.split('.');
    var cur = messages;
    for (var i = 0; i < parts.length; i++) {
      if (cur && typeof cur === 'object' && parts[i] in cur) {
        cur = cur[parts[i]];
      } else {
        return undefined;
      }
    }
    return cur;
  }

  function applyTo(root, messages) {
    if (!root || !messages) return;

    var textNodes = root.querySelectorAll('[data-i18n]');
    for (var i = 0; i < textNodes.length; i++) {
      var el = textNodes[i];
      var v = lookup(messages, el.getAttribute('data-i18n'));
      if (typeof v === 'string') el.textContent = v;
    }

    var htmlNodes = root.querySelectorAll('[data-i18n-html]');
    for (var j = 0; j < htmlNodes.length; j++) {
      var hel = htmlNodes[j];
      var hv = lookup(messages, hel.getAttribute('data-i18n-html'));
      if (typeof hv === 'string') hel.innerHTML = hv;
    }

    var attrNodes = root.querySelectorAll('[data-i18n-attr]');
    for (var k = 0; k < attrNodes.length; k++) {
      var ael = attrNodes[k];
      var spec = ael.getAttribute('data-i18n-attr');
      if (!spec) continue;
      var pairs = spec.split(';');
      for (var p = 0; p < pairs.length; p++) {
        var pair = pairs[p].trim();
        if (!pair) continue;
        var sep = pair.indexOf(':');
        if (sep === -1) continue;
        var attr = pair.slice(0, sep).trim();
        var key = pair.slice(sep + 1).trim();
        var av = lookup(messages, key);
        if (typeof av === 'string') ael.setAttribute(attr, av);
      }
    }
  }

  function loadMessages(lang) {
    return fetch((window.PATIENT_EDITOR ? window.PATIENT_EDITOR.assets + '/' : 'assets/') + 'i18n/' + lang + '.json', { cache: 'no-cache' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .catch(function (err) {
        if (lang !== FALLBACK) {
          return loadMessages(FALLBACK);
        }
        // Last-ditch: leave English markup in place and warn.
        if (typeof console !== 'undefined') {
          console.warn('i18n: could not load messages, leaving page text unchanged', err);
        }
        return null;
      });
  }

  // Public surface — lets other scripts translate dynamically-added markup
  // (e.g. rows created by addAllergy/addIssue) once they opt in.
  window.i18n = {
    lang: null,
    messages: null,
    t: function (key, fallback) {
      var v = lookup(this.messages, key);
      return typeof v === 'string' ? v : (fallback != null ? fallback : key);
    },
    apply: function (root) { applyTo(root || document, this.messages || {}); }
  };

  function init() {
    var lang = pickLanguage();
    loadMessages(lang).then(function (messages) {
      if (!messages) return;
      window.i18n.lang = lang;
      window.i18n.messages = messages;
      document.documentElement.lang = (messages.__lang || lang);
      applyTo(document, messages);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
