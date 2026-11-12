'use strict';

/**
 * A short description of what a request asked, for the log line of a slow request (see
 * TXModule, modules.tx.slowRequestSeconds): enough to repeat the request, without the bulk.
 * A Parameters body gives each parameter as name=value - a Coding as system|version#code
 * 'display', a resource as its type, url|version and size - and any other body its type and
 * url. Never longer than maxLength.
 */

const MAX_LENGTH = 4000;

function codingText(c) {
  if (!c || typeof c !== 'object') {
    return '?';
  }
  let s = (c.system || '') + (c.version ? '|' + c.version : '') + '#' + (c.code ?? '');
  if (c.display) {
    s += " '" + c.display + "'";
  }
  return s;
}

function resourceText(r) {
  if (!r || typeof r !== 'object') {
    return '?';
  }
  let s = r.resourceType || 'resource';
  if (r.url) {
    s += ' ' + r.url + (r.version ? '|' + r.version : '');
  } else if (r.id) {
    s += '/' + r.id;
  }
  if (r.resourceType === 'CodeSystem' && Array.isArray(r.concept)) {
    s += ` (${r.concept.length} concepts)`;
  } else if (r.resourceType === 'ValueSet' && r.compose) {
    const inc = (r.compose.include || []).length;
    const exc = (r.compose.exclude || []).length;
    s += ` (${inc} include${inc === 1 ? '' : 's'}${exc ? `, ${exc} exclude${exc === 1 ? '' : 's'}` : ''})`;
  } else if (r.resourceType === 'Parameters' && Array.isArray(r.parameter)) {
    s += ` (${r.parameter.length} parameters)`;
  }
  return s;
}

function valueText(p) {
  if (p.resource) {
    return resourceText(p.resource);
  }
  if (p.valueCoding) {
    return codingText(p.valueCoding);
  }
  if (p.valueCodeableConcept) {
    const cc = p.valueCodeableConcept;
    const codings = (cc.coding || []).map(codingText);
    if (cc.text) {
      codings.push("text '" + cc.text + "'");
    }
    return '[' + codings.join(', ') + ']';
  }
  if (Array.isArray(p.part)) {
    return '(' + p.part.map(partText).join(', ') + ')';
  }
  for (const [k, v] of Object.entries(p)) {
    if (k.startsWith('value') && (typeof v !== 'object' || v === null)) {
      return String(v);
    }
  }
  for (const [k, v] of Object.entries(p)) {
    if (k.startsWith('value')) {
      return k.substring(5) + ' ' + JSON.stringify(v);
    }
  }
  return '';
}

function partText(p) {
  return (p && p.name) + '=' + valueText(p || {});
}

/**
 * @param {Object|string|Buffer|undefined} body - the request body, as parsed
 * @param {number} [maxLength]
 * @returns {string} '' for no body
 */
function summariseBody(body, maxLength = MAX_LENGTH) {
  if (body === undefined || body === null || body === '') {
    return '';
  }
  let s;
  if (Buffer.isBuffer(body) || typeof body === 'string') {
    s = `(${Buffer.byteLength(body)} bytes, not parsed)`;
  } else if (typeof body !== 'object') {
    s = String(body);
  } else if (body.resourceType === 'Parameters' && Array.isArray(body.parameter)) {
    s = body.parameter.map(partText).join('; ');
  } else if (body.resourceType) {
    s = resourceText(body);
  } else {
    const keys = Object.keys(body);
    if (keys.length === 0) {
      return '';
    }
    s = keys.map(k => k + '=' + (typeof body[k] === 'object' ? JSON.stringify(body[k]) : body[k])).join('; ');
  }
  return s.length > maxLength ? s.substring(0, maxLength) + '... (' + s.length + ' characters)' : s;
}

module.exports = { summariseBody };
