//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/*
 * Patient matching, for the project's Patient endpoint: when a document arrives, is its patient
 * one the project has seen before? A reasonable guess, not a master patient index:
 *
 *  1. the same identifier (system and value) - unless the birth date or the gender conflicts;
 *  2. otherwise the same name (two words or more, compared as a set of words, without regard to
 *     case, accents, punctuation or order - so a name that is only text matches a name in parts)
 *     and the same (full) birth date, the gender not conflicting;
 *  3. otherwise a patient not seen before.
 *
 * Each project patient has a cumulative Patient resource, with the module's own id: the latest
 * document's Patient, with what earlier ones said that it doesn't (identifiers, names, telecoms,
 * addresses, languages, contacts; and any element it leaves out). References that only mean
 * something inside a document (generalPractitioner, managingOrganization, link) are left out.
 */

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

// the words of a name that aren't the person's: titles
const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'prof', 'sir', 'dame', 'rev']);

/** A name's words: lower case, without accents or punctuation, without titles. */
function words(s) {
  return str(s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w && !TITLES.has(w));
}

/** A name's match key: its words, sorted; '' if it has fewer than two. */
function nameKey(ws) {
  const set = [...new Set(ws)].sort();
  return set.length >= 2 ? set.join(' ') : '';
}

/** What a Patient resource is matched on. */
function keysOf(patient) {
  const p = isObject(patient) ? patient : {};
  const identifiers = [];
  for (const id of Array.isArray(p.identifier) ? p.identifier : []) {
    if (isObject(id) && str(id.system) && str(id.value)) {
      identifiers.push(`${str(id.system)}|${str(id.value)}`);
    }
  }
  const names = new Set();
  for (const n of Array.isArray(p.name) ? p.name : []) {
    if (!isObject(n)) {
      continue;
    }
    const fromText = nameKey(words(n.text));
    if (fromText) {
      names.add(fromText);
    }
    const parts = nameKey([...(Array.isArray(n.given) ? n.given : []).flatMap(words), ...words(n.family)]);
    if (parts) {
      names.add(parts);
    }
  }
  const birthDate = /^\d{4}(-\d{2}(-\d{2})?)?$/.test(str(p.birthDate)) ? str(p.birthDate) : '';
  const gender = ['male', 'female', 'other'].includes(str(p.gender)) ? str(p.gender) : '';
  return { identifiers: [...new Set(identifiers)], names: [...names], birthDate, gender };
}

/** Whether two patients' birth dates or genders say they are different people (as far as both say). */
function conflict(a, b) {
  if (a.birthDate && b.birthDate) {
    const n = Math.min(a.birthDate.length, b.birthDate.length);
    if (a.birthDate.substring(0, n) !== b.birthDate.substring(0, n)) {
      return 'birth date';
    }
  }
  if (a.gender && b.gender && a.gender !== b.gender) {
    return 'gender';
  }
  return null;
}

const UNION = {
  identifier: (x) => isObject(x) && str(x.system) && str(x.value) ? `${str(x.system)}|${str(x.value)}` : JSON.stringify(x),
  name: (x) => JSON.stringify(x),
  telecom: (x) => isObject(x) ? `${str(x.system)}|${str(x.value)}` : JSON.stringify(x),
  address: (x) => JSON.stringify(x),
  communication: (x) => JSON.stringify(isObject(x) ? x.language : x),
  contact: (x) => JSON.stringify(x)
};
const LOCAL_REFERENCES = ['generalPractitioner', 'managingOrganization', 'link'];

/**
 * The cumulative Patient: the incoming one (it is the latest), with what the earlier
 * cumulative one had that it doesn't.
 * @param {Object|null} previous - the cumulative Patient so far
 * @param {Object} incoming - the Patient in the document just received
 * @param {number} id - the project patient's id
 * @param {string} lastUpdated
 */
function mergePatient(previous, incoming, id, lastUpdated) {
  const out = { resourceType: 'Patient', id: String(id), meta: { lastUpdated } };
  const src = isObject(incoming) ? JSON.parse(JSON.stringify(incoming)) : {};
  for (const [k, v] of Object.entries(src)) {
    if (!['resourceType', 'id', 'meta', 'text', ...LOCAL_REFERENCES].includes(k)) {
      out[k] = v;
    }
  }
  const prev = isObject(previous) ? previous : {};
  for (const [k, v] of Object.entries(prev)) {
    if (['resourceType', 'id', 'meta', 'text', ...LOCAL_REFERENCES].includes(k)) {
      continue;
    }
    if (UNION[k] && Array.isArray(v)) {
      const list = Array.isArray(out[k]) ? out[k] : [];
      const seen = new Set(list.map(UNION[k]));
      for (const item of v) {
        if (!seen.has(UNION[k](item))) {
          list.push(item);
          seen.add(UNION[k](item));
        }
      }
      out[k] = list;
    } else if (!(k in out)) {
      out[k] = v;
    }
  }
  return out;
}

/** A patient's name, for lists: the first name's text, or its given and family names. */
function displayName(patient) {
  for (const n of Array.isArray(patient?.name) ? patient.name : []) {
    if (isObject(n)) {
      if (str(n.text)) {
        return str(n.text);
      }
      const s = [...(Array.isArray(n.given) ? n.given.map(str) : []), str(n.family)].filter(Boolean).join(' ');
      if (s) {
        return s;
      }
    }
  }
  return '';
}

module.exports = { keysOf, conflict, mergePatient, displayName, words, nameKey };
