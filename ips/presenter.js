//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * The IPS presenter: generates a narrative for an IPS document, as xhtml.
 *
 * It follows the FHIR rules for presenting a document - the Composition's header (subject,
 * author, date, ...) and then its sections - with the sections in the IPS order
 * (terminology.js: SECTION_ORDER), not the order they appear in. Each section gets its title
 * (its own, else the IPS's default for its code); a section with entries is a table of its
 * resources, one row each, with the columns that suit the resource type (roughly the IPS
 * profile's must-support elements - COLUMNS below), leaving out any column no resource has
 * a value for; nested parts of a resource (reactions, components, dosages, notes...) are
 * bullet points in a follow-up row under the resource. A section with no entries shows its
 * own narrative, else its emptyReason, else "Nothing found to render". The patient and the
 * other people and organisations are summarised the way the Java renderers do.
 *
 * Coded values show their text, else the first coding's display, else any coding's display,
 * else what the terminology server's $lookup says for a coding (the step passes a lookup
 * function; it caches and bounds the questions), else '--'.
 *
 * The output is plain xhtml - tables with class names, no styles or scripts - and every
 * value from the document is escaped.
 *
 * @module ips/presenter
 */

const escape = require('escape-html');
const parse5 = require('parse5');
const { compositionOf, resolveInBundle } = require('./search');
const { SECTION_ORDER, sectionRank } = require('./terminology');

const XHTML = 'http://www.w3.org/1999/xhtml';
const NONE = '--';

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function str(v) {
  return typeof v === 'string' ? v : (typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');
}

function list(v) {
  return Array.isArray(v) ? v.filter(x => x !== null && x !== undefined) : (v === null || v === undefined ? [] : [v]);
}

/** The value[x] (or onset[x], ...) of an object: its key and value, or null. */
function choice(obj, prefix) {
  if (!isObject(obj)) {
    return null;
  }
  for (const k of Object.keys(obj)) {
    if (k.startsWith(prefix) && k.length > prefix.length && /^[A-Z]/.test(k[prefix.length]) && !k.startsWith('_')) {
      return { type: k.substring(prefix.length), value: obj[k] };
    }
  }
  return null;
}

// ---- datatypes ------------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A date as dd-mmm yy, a dateTime as dd-mmm yy hh:nn (tz); a partial date as far as it goes. */
function dateText(d) {
  const s = str(d);
  // 2026-03-01T09:30:00+10:00 -> 01-Mar 26 09:30 (+10:00)
  const m = /^(\d{4})(?:-(\d\d)(?:-(\d\d))?)?(?:T(\d\d:\d\d)(?::\d\d(?:\.\d+)?)?(Z|[+-]\d\d:\d\d)?)?$/.exec(s);
  if (!m) {
    return escape(s);
  }
  const yy = m[1].substring(2);
  const mon = m[2] ? MONTHS[parseInt(m[2], 10) - 1] || m[2] : '';
  let out = !m[2] ? m[1] : (m[3] ? `${m[3]}-${mon} ${yy}` : `${mon} ${yy}`);
  if (m[4]) {
    out += ' ' + m[4] + (m[5] ? ` (${m[5] === 'Z' ? 'UTC' : m[5]})` : '');
  }
  return escape(out);
}

function periodText(p) {
  if (!isObject(p)) {
    return '';
  }
  const a = str(p.start);
  const b = str(p.end);
  if (a && b) {
    return `${dateText(a)} - ${dateText(b)}`;
  }
  if (a) {
    return `from ${dateText(a)}`;
  }
  if (b) {
    return `until ${dateText(b)}`;
  }
  return '';
}

function quantityText(q) {
  if (!isObject(q)) {
    return '';
  }
  const unit = str(q.unit) || str(q.code);
  const v = q.value === undefined || q.value === null ? '' : String(q.value);
  return escape([str(q.comparator) + v, unit].filter(Boolean).join(' '));
}

function rangeText(r) {
  if (!isObject(r)) {
    return '';
  }
  const lo = quantityText(r.low);
  const hi = quantityText(r.high);
  if (lo && hi) {
    return `${lo} - ${hi}`;
  }
  return lo ? `&gt;= ${lo}` : (hi ? `&lt;= ${hi}` : '');
}

function ratioText(r) {
  if (!isObject(r)) {
    return '';
  }
  return [quantityText(r.numerator), quantityText(r.denominator)].filter(Boolean).join(' / ');
}

function humanNameText(n) {
  if (!isObject(n)) {
    return '';
  }
  if (str(n.text)) {
    return escape(n.text);
  }
  const parts = [...list(n.prefix).map(str), ...list(n.given).map(str), str(n.family), ...list(n.suffix).map(str)].filter(Boolean);
  return escape(parts.join(' '));
}

function addressText(a) {
  if (!isObject(a)) {
    return '';
  }
  if (str(a.text)) {
    return escape(a.text);
  }
  const parts = [...list(a.line).map(str), str(a.city), str(a.district), str(a.state), str(a.postalCode), str(a.country)].filter(Boolean);
  return escape(parts.join(', '));
}

function contactPointText(t) {
  if (!isObject(t)) {
    return '';
  }
  const v = str(t.value);
  if (!v) {
    return '';
  }
  const sys = str(t.system);
  const use = str(t.use);
  return escape((sys ? `${sys}: ` : '') + v + (use ? ` (${use})` : ''));
}

function identifierText(i) {
  if (!isObject(i)) {
    return '';
  }
  const v = str(i.value);
  if (!v) {
    return '';
  }
  const type = str(i.type?.text) || str(list(i.type?.coding)[0]?.display) || str(list(i.type?.coding)[0]?.code);
  const sys = str(i.system);
  const label = type || (sys ? sys.replace(/^(urn:oid:|urn:uuid:|https?:\/\/)/, '') : '');
  return escape(label ? `${label}: ${v}` : v);
}

function annotationText(a) {
  if (!isObject(a)) {
    return '';
  }
  const t = str(a.text);
  if (!t) {
    return '';
  }
  const who = str(a.authorString) || '';
  const when = str(a.time);
  return escape(t) + (who || when ? ` <i>(${[escape(who), when ? dateText(when) : ''].filter(Boolean).join(', ')})</i>` : '');
}

function attachmentText(a) {
  if (!isObject(a)) {
    return '';
  }
  return escape(str(a.title) || str(a.url) || (str(a.contentType) ? `${a.contentType} attachment` : 'attachment'));
}

/** The resource a reference points at, in the document, or null. */
function resolve(bundle, ref) {
  if (!isObject(ref)) {
    return null;
  }
  return resolveInBundle(bundle, ref.reference) || null;
}

// ---- the presenter ----------------------------------------------------------------------------

class Presenter {
  /**
   * @param {Object} [options]
   * @param {Function} [options.lookup] - async (coding) -> display string or null: asks the
   *   terminology server (the step provides it, with its cache and budget)
   */
  constructor(options = {}) {
    this.lookup = typeof options.lookup === 'function' ? options.lookup : null;
    this.bundle = null;
  }

  /**
   * Render a document.
   * @param {Object} bundle - an IPS document Bundle
   * @returns {Promise<{html: string, header: string, sections: Array<{section: Object, title: string, html: string}>}>}
   *   html: the whole narrative (a div in the xhtml namespace); header: the Composition's
   *   own narrative (a div); sections: each section rendered (a div each), in the IPS order
   */
  async render(bundle) {
    this.bundle = bundle;
    const composition = compositionOf(bundle);
    if (!composition) {
      const html = `<div xmlns="${XHTML}"><p><i>The document has no Composition</i></p></div>`;
      return { html, header: html, sections: [] };
    }
    const title = `<h1>${escape(str(composition.title) || 'International Patient Summary')}</h1>`;
    const headerInner = await this.renderHeader(composition);
    const sections = [];
    const ordered = list(composition.section).filter(isObject).map((s, i) => ({ s, i, rank: sectionRank(s) }));
    ordered.sort((a, b) => (a.rank < 0 ? 999 : a.rank) - (b.rank < 0 ? 999 : b.rank) || a.i - b.i);
    for (const { s } of ordered) {
      await this.renderSection(s, 2, sections);
    }
    // the whole document carries the title; the Composition's own narrative doesn't (the
    // page it is shown on has it)
    let html = `<div xmlns="${XHTML}">` + title + headerInner;
    for (const sec of sections) {
      html += `<h${sec.level}>${escape(sec.title)}</h${sec.level}>` + sec.inner;
    }
    html += '</div>';
    return { html, header: `<div xmlns="${XHTML}">${headerInner}</div>`, sections: sections.map(s => ({ section: s.section, title: s.title, level: s.level, html: `<div xmlns="${XHTML}">${s.inner}</div>` })) };
  }

  // ---- the header ----

  /** The Composition's own narrative: the patient, and the document's facts (the inside of the div). */
  async renderHeader(composition) {
    const b = this.bundle;
    let h = '';
    const patient = resolve(b, composition.subject);
    if (patient && patient.resourceType === 'Patient') {
      h += await this.renderPatient(patient);
    } else if (isObject(composition.subject)) {
      h += `<p>Subject: ${this.referenceText(composition.subject)}</p>`;
    }
    const rows = [];
    const add = (label, value) => {
      if (value && value !== NONE) {
        rows.push(`<tr><td><b>${label}</b></td><td>${value}</td></tr>`);
      }
    };
    add('Date', dateText(composition.date));
    add('Status', escape(str(composition.status)));
    add('Type', await this.codeableText(composition.type));
    add('Author', list(composition.author).map(r => this.referenceText(r)).filter(Boolean).join('; '));
    add('Attester', list(composition.attester).filter(isObject).map(a => [escape(str(a.mode)), this.referenceText(a.party), a.time ? dateText(a.time) : ''].filter(Boolean).join(' ')).join('; '));
    add('Custodian', this.referenceText(composition.custodian));
    add('Encounter', this.referenceText(composition.encounter));
    const events = [];
    for (const e of list(composition.event).filter(isObject)) {
      const codes = [];
      for (const c of list(e.code)) {
        codes.push(await this.codeableText(c));
      }
      events.push([codes.filter(x => x !== NONE).join(', '), periodText(e.period)].filter(Boolean).join(' '));
    }
    add('Event', events.filter(Boolean).join('; '));
    add('Confidentiality', escape(str(composition.confidentiality)));
    if (rows.length > 0) {
      h += `<table class="ips-facts">${rows.join('')}</table>`;
    }
    return h;
  }

  /** The patient, as the Java PatientRenderer does: a summary line, then the details. */
  async renderPatient(p) {
    const names = list(p.name).filter(isObject);
    const official = names.find(n => n.use === 'official') || names.find(n => !n.use) || names[0];
    const line = [];
    line.push(official ? `<b>${humanNameText(official)}</b>` : '<b>(no name)</b>');
    if (str(p.gender)) {
      line.push(escape(p.gender));
    }
    if (str(p.birthDate)) {
      line.push(`DoB: ${dateText(p.birthDate)}`);
    }
    const ids = list(p.identifier).map(identifierText).filter(Boolean);
    if (ids.length > 0) {
      line.push(`( ${ids.join(', ')} )`);
    }
    if (p.deceasedBoolean === true || str(p.deceasedDateTime)) {
      line.push(`<i>deceased${str(p.deceasedDateTime) ? ' ' + dateText(p.deceasedDateTime) : ''}</i>`);
    }
    let h = `<p class="ips-patient">${line.join(', ')}</p>`;
    const rows = [];
    const add = (label, value) => {
      if (value) {
        rows.push(`<tr><td><b>${label}</b></td><td>${value}</td></tr>`);
      }
    };
    if (p.active === false) {
      add('Active', 'No');
    }
    const others = names.filter(n => n !== official).map(n => humanNameText(n) + (str(n.use) ? ` (${escape(n.use)})` : '')).filter(Boolean);
    add('Other names', others.join('; '));
    add('Contact details', list(p.telecom).map(contactPointText).filter(Boolean).join('; '));
    add('Address', list(p.address).map(a => addressText(a) + (str(a.use) ? ` (${escape(a.use)})` : '')).filter(Boolean).join('; '));
    add('Marital status', p.maritalStatus ? await this.codeableText(p.maritalStatus) : '');
    const langs = [];
    for (const c of list(p.communication).filter(isObject)) {
      const l = await this.codeableText(c.language);
      if (l !== NONE) {
        langs.push(l + (c.preferred === true ? ' (preferred)' : ''));
      }
    }
    add('Language', langs.join(', '));
    add('Managing organization', this.referenceText(p.managingOrganization));
    add('General practitioner', list(p.generalPractitioner).map(r => this.referenceText(r)).filter(Boolean).join('; '));
    const contacts = [];
    for (const c of list(p.contact).filter(isObject)) {
      const rel = [];
      for (const r of list(c.relationship)) {
        rel.push(await this.codeableText(r));
      }
      contacts.push([humanNameText(c.name), rel.filter(x => x !== NONE).join('/') ? `(${rel.filter(x => x !== NONE).join('/')})` : '', list(c.telecom).map(contactPointText).filter(Boolean).join(', ')].filter(Boolean).join(' '));
    }
    add('Contacts', contacts.filter(Boolean).join('; '));
    if (rows.length > 0) {
      h += `<table class="ips-facts">${rows.join('')}</table>`;
    }
    return h;
  }

  // ---- sections ----

  async renderSection(section, level, out) {
    const rank = sectionRank(section);
    const title = str(section.title).trim() || (rank >= 0 ? SECTION_ORDER[rank][1] : '') || str(section.code?.text) || str(list(section.code?.coding)[0]?.display) || 'Section';
    const resources = [];
    const seen = new Set();
    const missing = [];
    for (const e of list(section.entry).filter(isObject)) {
      const r = resolve(this.bundle, e);
      if (r && !seen.has(r)) {
        seen.add(r);
        resources.push(r);
      } else if (!r) {
        missing.push(str(e.display) || str(e.reference) || '(no reference)');
      }
    }
    let h = '';
    if (resources.length > 0) {
      h += await this.renderTable(resources);
    } else if (missing.length === 0) {
      const div = str(section.text?.div);
      if (div) {
        // the submitter's narrative, passed through: say so
        h += '<p class="ips-as-submitted"><i>Narrative as submitted</i></p>' + innerOf(div);
      } else if (isObject(section.emptyReason)) {
        h += `<p><i>${await this.codeableText(section.emptyReason)}</i></p>`;
      } else {
        h += '<p><i>Nothing found to render</i></p>';
      }
    }
    if (missing.length > 0) {
      h += `<p><i>Not in the document: ${missing.map(escape).join(', ')}</i></p>`;
    }
    out.push({ section, title, level, inner: h });
    for (const sub of list(section.section).filter(isObject)) {
      await this.renderSection(sub, Math.min(level + 1, 6), out);
    }
  }

  /**
   * A table of resources: the columns of the first resource's type (the others of that
   * type share them; a mixed section gets the generic columns), less the columns no row
   * fills; follow-up rows for the nested parts.
   */
  async renderTable(resources) {
    const types = new Set(resources.map(r => r.resourceType));
    const def = types.size === 1 && COLUMNS[resources[0].resourceType] ? COLUMNS[resources[0].resourceType] : GENERIC;
    const rows = [];
    for (const r of resources) {
      const cells = [];
      for (const col of def.columns) {
        cells.push(await col.value(r, this));
      }
      const follow = [];
      for (const f of def.follow || []) {
        const items = (await f.items(r, this)).filter(Boolean);
        if (items.length > 0) {
          follow.push({ label: f.label, items });
        }
      }
      rows.push({ cells, follow });
    }
    const keep = def.columns.map((c, i) => rows.some(r => r.cells[i] && r.cells[i] !== NONE));
    const cols = def.columns.filter((c, i) => keep[i]);
    let h = '<table class="ips-section"><thead><tr>' + cols.map(c => `<th>${escape(c.label)}</th>`).join('') + '</tr></thead><tbody>';
    for (const row of rows) {
      h += '<tr>' + row.cells.filter((c, i) => keep[i]).map(c => `<td>${c || NONE}</td>`).join('') + '</tr>';
      for (const f of row.follow) {
        h += `<tr class="ips-follow"><td></td><td colspan="${Math.max(1, cols.length - 1)}"><b>${escape(f.label)}</b><ul>${f.items.map(i => `<li>${i}</li>`).join('')}</ul></td></tr>`;
      }
    }
    return h + '</tbody></table>';
  }

  // ---- values ----

  /**
   * A CodeableConcept's text: its text, else the first coding's display, else any coding's
   * display, else a display the terminology server knows for a coding, else '--'.
   */
  async codeableText(cc) {
    if (!isObject(cc)) {
      return NONE;
    }
    if (str(cc.text)) {
      return escape(cc.text);
    }
    const codings = list(cc.coding).filter(isObject);
    for (const c of codings) {
      if (str(c.display)) {
        return escape(c.display);
      }
    }
    if (this.lookup) {
      for (const c of codings) {
        if (str(c.system) && str(c.code)) {
          const d = await this.lookup(c);
          if (str(d)) {
            return escape(d);
          }
        }
      }
    }
    for (const c of codings) {
      if (str(c.code)) {
        return escape(c.code);
      }
    }
    return NONE;
  }

  async codeablesText(ccs) {
    const out = [];
    for (const cc of list(ccs)) {
      const t = await this.codeableText(cc);
      if (t !== NONE) {
        out.push(t);
      }
    }
    return out.join(', ');
  }

  /** A Reference: what the resource it points at is called, else the reference's display, else the reference. */
  referenceText(ref) {
    if (!isObject(ref)) {
      return '';
    }
    const r = resolve(this.bundle, ref);
    if (r) {
      const d = describeResource(r);
      if (d) {
        return d;
      }
    }
    return escape(str(ref.display) || str(ref.reference) || (isObject(ref.identifier) ? identifierText(ref.identifier) : ''));
  }

  /**
   * A reference followed: an Observation as "code: value", anything else as referenceText.
   * For reasons and evidence, where the observation is the point.
   */
  async referencedText(ref) {
    const r = resolve(this.bundle, ref);
    if (r && r.resourceType === 'Observation') {
      return await this.observationSummary(r);
    }
    return this.referenceText(ref);
  }

  /** An Observation in a line: code: value (interpretation). */
  async observationSummary(obs) {
    const value = await this.observationValue(obs);
    const interp = await this.codeablesText(obs.interpretation);
    return `${await this.codeableText(obs.code)}${value ? `: ${value}` : ''}${interp ? ` (${interp})` : ''}`;
  }

  /**
   * An Observation's value: value[x], else a blood pressure from its systolic and diastolic
   * components (120/80 mmHg), else its dataAbsentReason, else ''.
   */
  async observationValue(obs) {
    const v = await this.valueText(obs, 'value');
    if (v) {
      return v;
    }
    const bp = bloodPressure(obs);
    if (bp) {
      return bp;
    }
    return isObject(obs.dataAbsentReason) ? `<i>${await this.codeableText(obs.dataAbsentReason)}</i>` : '';
  }

  /** A choice value (value[x], onset[x], effective[x], ...) rendered by their type. */
  async valueText(obj, prefix) {
    const c = choice(obj, prefix);
    if (!c) {
      return '';
    }
    const v = c.value;
    switch (c.type) {
      case 'Quantity': case 'Age': case 'Duration': case 'Count': case 'Distance': case 'SimpleQuantity': return quantityText(v);
      case 'CodeableConcept': return await this.codeableText(v);
      case 'String': case 'Integer': case 'Decimal': case 'Boolean': case 'Uri': case 'Code': case 'Time': return escape(str(v));
      case 'DateTime': case 'Date': case 'Instant': return dateText(v);
      case 'Period': return periodText(v);
      case 'Range': return rangeText(v);
      case 'Ratio': return ratioText(v);
      case 'SampledData': return '(sampled data)';
      case 'Attachment': return attachmentText(v);
      case 'Reference': return this.referenceText(v);
      case 'Timing': return await this.timingText(v);
      case 'Annotation': return annotationText(v);
      case 'Identifier': return identifierText(v);
      case 'HumanName': return humanNameText(v);
      default: return isObject(v) ? '' : escape(str(v));
    }
  }

  async timingText(t) {
    if (!isObject(t)) {
      return '';
    }
    if (isObject(t.code)) {
      const c = await this.codeableText(t.code);
      if (c !== NONE) {
        return c;
      }
    }
    const r = t.repeat;
    if (!isObject(r)) {
      return list(t.event).map(dateText).join(', ');
    }
    const parts = [];
    if (r.frequency || r.period) {
      // numbers in FHIR, but this is a document as submitted: whatever is there is text
      const n = (v) => escape(String(v));
      parts.push(`${n(r.frequency || 1)}${r.frequencyMax ? '-' + n(r.frequencyMax) : ''} time${(r.frequencyMax || r.frequency || 1) === 1 ? '' : 's'} per ${n(r.period || 1)}${r.periodMax ? '-' + n(r.periodMax) : ''} ${escape(str(r.periodUnit))}`.trim());
    }
    if (r.duration) {
      parts.push(`for ${escape(String(r.duration))} ${escape(str(r.durationUnit))}`);
    }
    if (list(r.when).length > 0) {
      parts.push(list(r.when).map(w => escape(str(w))).join(', '));
    }
    if (list(r.dayOfWeek).length > 0) {
      parts.push(list(r.dayOfWeek).map(w => escape(str(w))).join(', '));
    }
    const bounds = await this.valueText(r, 'bounds');
    if (bounds) {
      parts.push(bounds);
    }
    return parts.join(' ');
  }

  async dosageText(d) {
    if (!isObject(d)) {
      return '';
    }
    if (str(d.text)) {
      return escape(d.text);
    }
    const parts = [];
    for (const dr of list(d.doseAndRate).filter(isObject)) {
      const dose = await this.valueText(dr, 'dose');
      const rate = await this.valueText(dr, 'rate');
      if (dose) {
        parts.push(dose);
      }
      if (rate) {
        parts.push(`at ${rate}`);
      }
    }
    const route = await this.codeableText(d.route);
    if (route !== NONE) {
      parts.push(route);
    }
    const timing = await this.timingText(d.timing);
    if (timing) {
      parts.push(timing);
    }
    const asNeeded = choice(d, 'asNeeded');
    if (asNeeded) {
      parts.push(asNeeded.type === 'Boolean' ? (asNeeded.value ? 'as needed' : '') : `as needed for ${await this.codeableText(asNeeded.value)}`);
    }
    const site = await this.codeableText(d.site);
    if (site !== NONE) {
      parts.push(`(${site})`);
    }
    if (str(d.patientInstruction)) {
      parts.push(`- ${escape(d.patientInstruction)}`);
    }
    return parts.filter(Boolean).join(' ');
  }

  /** medication[x]: the Medication resource's code, or the concept. */
  async medicationText(r) {
    const c = choice(r, 'medication');
    if (!c) {
      return NONE;
    }
    if (c.type === 'Reference') {
      const med = resolve(this.bundle, c.value);
      if (med && med.resourceType === 'Medication') {
        return await this.codeableText(med.code);
      }
      return this.referenceText(c.value) || NONE;
    }
    return await this.codeableText(c.value);
  }

  async notes(r) {
    return list(r.note).map(annotationText).filter(Boolean);
  }
}

const SYSTOLIC = '8480-6';
const DIASTOLIC = '8462-4';

function componentWithLoinc(obs, code) {
  return list(obs.component).filter(isObject).find(c => list(c.code?.coding).some(x => isObject(x) && x.system === 'http://loinc.org' && x.code === code)) || null;
}

/** 120/80 mmHg from an Observation's systolic and diastolic components, or ''. */
function bloodPressure(obs) {
  const sys = componentWithLoinc(obs, SYSTOLIC);
  const dia = componentWithLoinc(obs, DIASTOLIC);
  if (!sys || !dia || !isObject(sys.valueQuantity) || !isObject(dia.valueQuantity)) {
    return '';
  }
  const unit = str(sys.valueQuantity.unit) || str(sys.valueQuantity.code) || str(dia.valueQuantity.unit) || str(dia.valueQuantity.code);
  const n = (q) => (q.value === undefined || q.value === null ? '?' : String(q.value));
  return escape(`${n(sys.valueQuantity)}/${n(dia.valueQuantity)}${unit ? ' ' + unit : ''}`);
}

/** The inside of a narrative div, as parsed (never the string itself). */
function innerOf(div) {
  const frag = parse5.parseFragment(str(div));
  // the parsed fragment is <div ...>inner</div>; take the inner
  const root = frag.childNodes.find(n => n.nodeName === 'div') || null;
  return root ? parse5.serialize(root) : parse5.serialize(frag);
}

function codeText(cc) {
  if (!isObject(cc)) {
    return '';
  }
  const codings = list(cc.coding).filter(isObject);
  return escape(str(cc.text) || str(codings.find(c => str(c.display))?.display) || str(codings[0]?.code) || '');
}

/** What to call a resource when it is referred to: a person's name, a medication's code, ... */
function describeResource(r) {
  if (!isObject(r)) {
    return '';
  }
  switch (r.resourceType) {
    case 'Patient': case 'Practitioner': case 'RelatedPerson': case 'Person': {
      const n = list(r.name).filter(isObject);
      const official = n.find(x => x.use === 'official') || n[0];
      return humanNameText(official);
    }
    case 'PractitionerRole': {
      const who = r.practitioner?.display ? escape(r.practitioner.display) : '';
      const org = r.organization?.display ? escape(r.organization.display) : '';
      return [who, org].filter(Boolean).join(', ') || list(r.code).map(c => str(c?.text) || str(list(c?.coding)[0]?.display)).filter(Boolean).map(escape).join(', ');
    }
    case 'Organization': case 'Location': case 'Device': {
      const name = str(r.name) || str(list(r.deviceName)[0]?.name);
      return escape(name || str(r.type?.text) || str(list(r.type?.coding)[0]?.display) || '');
    }
    case 'Encounter': return escape(str(r.class?.display) || str(list(r.type)[0]?.text) || '');
    case 'Immunization': return codeText(r.vaccineCode);
    default:
      // a Medication, Condition, Observation, Procedure, AllergyIntolerance...: its code
      return codeText(r.code) || (str(r.title) ? escape(r.title) : '');
  }
}

// ---- the columns, by resource type ----------------------------------------------------------
//
// column: { label, value: async (resource, presenter) -> html string ('' or '--' for none) }
// follow: { label, items: async (resource, presenter) -> html strings, one per bullet }

const col = (label, value) => ({ label, value });
async function referenceRangeText(rr, p) {
  const type = await p.codeableText(rr.type);
  return [str(rr.text) ? escape(rr.text) : rangeText(rr), type !== NONE ? `(${type})` : ''].filter(Boolean).join(' ');
}
const codeable = (label, field) => col(label, (r, p) => p.codeableText(r[field]));
const codeables = (label, field) => col(label, (r, p) => p.codeablesText(r[field]));
const plain = (label, field) => col(label, (r) => escape(str(r[field])));
const date = (label, field) => col(label, (r) => dateText(r[field]));
const which = (label, prefix) => col(label, (r, p) => p.valueText(r, prefix));
const ref = (label, field) => col(label, (r, p) => list(r[field]).map(x => p.referenceText(x)).filter(Boolean).join('; '));
const notesFollow = { label: 'Notes', items: (r, p) => p.notes(r) };
// clinical and verification status together: Active / Confirmed (whichever are there)
const statusCol = col('Status', async (r, p) => [await p.codeableText(r.clinicalStatus), await p.codeableText(r.verificationStatus)].filter(x => x !== NONE).join(' / '));
const reasonCol = col('Reason', async (r, p) => {
  const refs = [];
  for (const x of list(r.reasonReference)) {
    refs.push(await p.referencedText(x));
  }
  return [await p.codeablesText(r.reasonCode), ...refs].filter(Boolean).join(', ');
});
const unique = (items) => [...new Set(items)];

const COLUMNS = {
  AllergyIntolerance: {
    columns: [
      codeable('Allergy / intolerance', 'code'), plain('Type', 'type'), col('Category', (r) => list(r.category).map(c => escape(str(c))).join(', ')),
      plain('Criticality', 'criticality'), statusCol, which('Onset', 'onset'), date('Recorded', 'recordedDate')
    ],
    follow: [
      { label: 'Reactions', items: async (r, p) => {
        const out = [];
        for (const x of list(r.reaction).filter(isObject)) {
          const parts = [await p.codeablesText(x.manifestation)];
          const sub = await p.codeableText(x.substance);
          if (sub !== NONE) {
            parts.push(`to ${sub}`);
          }
          if (str(x.severity)) {
            parts.push(`(${escape(x.severity)})`);
          }
          if (str(x.onset)) {
            parts.push(dateText(x.onset));
          }
          if (str(x.description)) {
            parts.push(`- ${escape(x.description)}`);
          }
          out.push(parts.filter(Boolean).join(' '));
        }
        return out;
      } },
      notesFollow
    ]
  },
  Condition: {
    columns: [
      codeable('Problem', 'code'), codeables('Category', 'category'), codeable('Severity', 'severity'), statusCol,
      which('Onset', 'onset'), which('Abatement', 'abatement'), date('Recorded', 'recordedDate'), ref('Asserter', 'asserter')
    ],
    follow: [
      { label: 'Body sites', items: async (r, p) => { const t = await p.codeablesText(r.bodySite); return t ? [t] : []; } },
      { label: 'Stage', items: async (r, p) => { const out = []; for (const s of list(r.stage).filter(isObject)) { const t = await p.codeableText(s.summary); if (t !== NONE) { out.push(t); } } return out; } },
      { label: 'Evidence', items: async (r, p) => {
        const out = [];
        for (const e of list(r.evidence).filter(isObject)) {
          const details = [];
          for (const x of list(e.detail)) {
            details.push(await p.referencedText(x));
          }
          const t = [await p.codeablesText(e.code), details.filter(Boolean).join(', ')].filter(Boolean).join(': ');
          if (t) {
            out.push(t);
          }
        }
        return unique(out);
      } },
      notesFollow
    ]
  },
  MedicationStatement: {
    columns: [
      col('Medication', (r, p) => p.medicationText(r)), plain('Status', 'status'), reasonCol, which('Effective', 'effective'), date('Asserted', 'dateAsserted'),
      col('Dosage', async (r, p) => { const d = list(r.dosage).filter(isObject); return d.length === 1 ? await p.dosageText(d[0]) : ''; }), ref('Source', 'informationSource')
    ],
    follow: [
      { label: 'Dosage', items: async (r, p) => { const d = list(r.dosage).filter(isObject); if (d.length < 2) { return []; } const out = []; for (const x of d) { out.push(await p.dosageText(x)); } return out; } },
      notesFollow
    ]
  },
  MedicationRequest: {
    columns: [
      col('Medication', (r, p) => p.medicationText(r)), plain('Status', 'status'), plain('Intent', 'intent'), reasonCol, date('Authored', 'authoredOn'),
      col('Dosage', async (r, p) => { const d = list(r.dosageInstruction).filter(isObject); return d.length === 1 ? await p.dosageText(d[0]) : ''; }), ref('Requester', 'requester')
    ],
    follow: [
      { label: 'Dosage instructions', items: async (r, p) => { const d = list(r.dosageInstruction).filter(isObject); if (d.length < 2) { return []; } const out = []; for (const x of d) { out.push(await p.dosageText(x)); } return out; } },
      notesFollow
    ]
  },
  Medication: {
    columns: [codeable('Medication', 'code'), codeable('Form', 'form'), plain('Status', 'status'), col('Lot', (r) => escape(str(r.batch?.lotNumber))), col('Expiry', (r) => dateText(r.batch?.expirationDate))],
    follow: [
      { label: 'Ingredients', items: async (r, p) => {
        const out = [];
        for (const i of list(r.ingredient).filter(isObject)) {
          const item = await p.valueText(i, 'item');
          out.push([item, ratioText(i.strength)].filter(Boolean).join(' '));
        }
        return out.filter(Boolean);
      } }
    ]
  },
  Immunization: {
    columns: [
      codeable('Vaccine', 'vaccineCode'), plain('Status', 'status'), which('Date', 'occurrence'),
      col('Target disease', async (r, p) => { const out = []; for (const pa of list(r.protocolApplied).filter(isObject)) { const t = await p.codeablesText(pa.targetDisease); if (t) { out.push(t); } } return out.join(', '); }),
      col('Dose', (r) => list(r.protocolApplied).filter(isObject).map(pa => { const c = choice(pa, 'doseNumber'); return c ? escape(str(c.value)) : ''; }).filter(Boolean).join(', ')),
      codeable('Route', 'route'), codeable('Site', 'site'), plain('Lot', 'lotNumber'), ref('Manufacturer', 'manufacturer'),
      col('Performer', (r, p) => list(r.performer).filter(isObject).map(x => p.referenceText(x.actor)).filter(Boolean).join('; ')),
      codeable('Status reason', 'statusReason')
    ],
    follow: [
      { label: 'Reactions', items: (r, p) => list(r.reaction).filter(isObject).map(x => [x.date ? dateText(x.date) : '', p.referenceText(x.detail), x.reported ? '(reported)' : ''].filter(Boolean).join(' ')).filter(Boolean) },
      notesFollow
    ]
  },
  Procedure: {
    columns: [
      codeable('Procedure', 'code'), plain('Status', 'status'), which('Performed', 'performed'), codeables('Body site', 'bodySite'), reasonCol, codeable('Outcome', 'outcome'),
      col('Performer', (r, p) => list(r.performer).filter(isObject).map(x => p.referenceText(x.actor)).filter(Boolean).join('; ')), codeable('Status reason', 'statusReason')
    ],
    follow: [
      { label: 'Complications', items: async (r, p) => { const t = await p.codeablesText(r.complication); return t ? [t] : []; } },
      { label: 'Follow up', items: async (r, p) => { const t = await p.codeablesText(r.followUp); return t ? [t] : []; } },
      notesFollow
    ]
  },
  Observation: {
    columns: [
      codeable('Observation', 'code'),
      col('Value', (r, p) => p.observationValue(r)),
      codeables('Interpretation', 'interpretation'),
      col('Reference range', async (r, p) => { const rr = list(r.referenceRange).filter(isObject); return rr.length === 1 ? await referenceRangeText(rr[0], p) : ''; }),
      col('Date', async (r, p) => (await p.valueText(r, 'effective')) || dateText(r.issued)), plain('Status', 'status'), codeables('Category', 'category'), ref('Performer', 'performer'),
      codeable('Body site', 'bodySite'), codeable('Method', 'method'), ref('Specimen', 'specimen'), ref('Device', 'device')
    ],
    follow: [
      { label: 'Components', items: async (r, p) => {
        const out = [];
        const shownAsValue = bloodPressure(r) && !choice(r, 'value') ? [componentWithLoinc(r, SYSTOLIC), componentWithLoinc(r, DIASTOLIC)] : [];
        for (const c of list(r.component).filter(isObject)) {
          if (shownAsValue.includes(c)) {
            continue;
          }
          const value = (await p.valueText(c, 'value')) || (isObject(c.dataAbsentReason) ? `<i>${await p.codeableText(c.dataAbsentReason)}</i>` : NONE);
          const interp = await p.codeablesText(c.interpretation);
          out.push(`${await p.codeableText(c.code)}: ${value}${interp ? ` (${interp})` : ''}`);
        }
        return out;
      } },
      { label: 'Reference ranges', items: async (r, p) => {
        const rrs = list(r.referenceRange).filter(isObject);
        if (rrs.length < 2) {
          return [];
        }
        const out = [];
        for (const rr of rrs) {
          out.push(await referenceRangeText(rr, p));
        }
        return out.filter(Boolean);
      } },
      { label: 'Members', items: async (r, p) => { const out = []; for (const x of list(r.hasMember)) { out.push(await p.referencedText(x)); } return unique(out.filter(Boolean)); } },
      notesFollow
    ]
  },
  DiagnosticReport: {
    columns: [
      codeable('Report', 'code'), plain('Status', 'status'), codeables('Category', 'category'), which('Date', 'effective'), date('Issued', 'issued'), ref('Performer', 'performer'),
      col('Conclusion', (r) => escape(str(r.conclusion)))
    ],
    follow: [
      { label: 'Results', items: async (r, p) => {
        const out = [];
        for (const x of list(r.result)) {
          out.push(await p.referencedText(x));
        }
        return unique(out.filter(Boolean));
      } },
      { label: 'Conclusion codes', items: async (r, p) => { const t = await p.codeablesText(r.conclusionCode); return t ? [t] : []; } },
      { label: 'Imaging', items: (r, p) => list(r.imagingStudy).map(x => p.referenceText(x)).filter(Boolean) }
    ]
  },
  DeviceUseStatement: {
    columns: [
      col('Device', (r, p) => { const d = resolve(p.bundle, r.device); return d ? describeResource(d) || p.referenceText(r.device) : p.referenceText(r.device); }),
      plain('Status', 'status'), which('Period', 'timing'), codeable('Body site', 'bodySite'), codeables('Reason', 'reasonCode'), date('Recorded', 'recordedOn'), ref('Source', 'source')
    ],
    follow: [notesFollow]
  },
  Device: {
    columns: [
      col('Device', (r) => escape(str(list(r.deviceName)[0]?.name))), codeable('Type', 'type'), plain('Manufacturer', 'manufacturer'), plain('Model', 'modelNumber'), plain('Serial', 'serialNumber'),
      plain('Status', 'status'), date('Expiry', 'expirationDate'), col('UDI', (r) => escape(str(list(r.udiCarrier)[0]?.deviceIdentifier)))
    ],
    follow: [notesFollow]
  },
  Flag: {
    columns: [codeable('Flag', 'code'), plain('Status', 'status'), codeables('Category', 'category'), col('Period', (r) => periodText(r.period)), ref('Author', 'author')]
  },
  Consent: {
    columns: [codeable('Scope', 'scope'), codeables('Category', 'category'), plain('Status', 'status'), date('Date', 'dateTime'), col('Provision', (r) => escape(str(r.provision?.type))), ref('Performer', 'performer')]
  },
  CarePlan: {
    columns: [plain('Title', 'title'), plain('Status', 'status'), plain('Intent', 'intent'), codeables('Category', 'category'), col('Period', (r) => periodText(r.period)), plain('Description', 'description'), ref('Author', 'author')],
    follow: [
      { label: 'Activities', items: async (r, p) => {
        const out = [];
        for (const a of list(r.activity).filter(isObject)) {
          if (isObject(a.detail)) {
            const t = [await p.codeableText(a.detail.code), str(a.detail.description) ? escape(a.detail.description) : '', str(a.detail.status) ? `(${escape(a.detail.status)})` : ''].filter(x => x && x !== NONE).join(' ');
            out.push(t || NONE);
          } else if (isObject(a.reference)) {
            out.push(p.referenceText(a.reference));
          }
        }
        return out.filter(Boolean);
      } },
      notesFollow
    ]
  },
  ClinicalImpression: {
    columns: [plain('Status', 'status'), codeable('Code', 'code'), date('Date', 'date'), which('Effective', 'effective'), plain('Summary', 'summary'), plain('Description', 'description'), ref('Assessor', 'assessor')],
    follow: [
      { label: 'Findings', items: async (r, p) => { const out = []; for (const f of list(r.finding).filter(isObject)) { out.push([await p.valueText(f, 'item'), str(f.basis) ? escape(f.basis) : ''].filter(Boolean).join(' - ')); } return out.filter(Boolean); } },
      { label: 'Problems', items: (r, p) => list(r.problem).map(x => p.referenceText(x)).filter(Boolean) },
      notesFollow
    ]
  }
};

// anything else: category, name, type, code, value - if they have them
const GENERIC = {
  columns: [
    col('Resource', (r) => escape(`${str(r.resourceType)}${str(r.id) ? '/' + r.id : ''}`)),
    codeables('Category', 'category'),
    col('Name', (r) => Array.isArray(r.name) ? list(r.name).map(n => isObject(n) ? humanNameText(n) : escape(str(n))).filter(Boolean).join('; ') : (isObject(r.name) ? humanNameText(r.name) : escape(str(r.name)))),
    col('Type', (r, p) => Array.isArray(r.type) ? p.codeablesText(r.type) : (isObject(r.type) ? p.codeableText(r.type) : escape(str(r.type)))),
    col('Code', (r, p) => isObject(r.code) ? p.codeableText(r.code) : escape(str(r.code))),
    which('Value', 'value'),
    plain('Status', 'status')
  ],
  follow: [notesFollow]
};

module.exports = {
  Presenter, COLUMNS, GENERIC, describeResource, NONE,
  dateText, periodText, quantityText, rangeText, humanNameText, addressText, identifierText, contactPointText, annotationText
};
