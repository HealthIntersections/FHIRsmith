//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * The value sets the terminology check holds IPS documents to - the module's own criteria
 * for international exchange, not the IPS profiles' bindings. They are FHIR ValueSets in
 * ips/valuesets/ (ValueSet-*.json), and elements.json there says which value set each
 * CodeableConcept element is checked against, by path (Condition.code,
 * MedicationStatement.medicationCodeableConcept, ...). Elements not listed have no value
 * set of their own, and only the fallback applies: any SNOMED CT International or LOINC
 * code (the fallback value set), or any code in an HL7 terminology (pipeline.js decides
 * that by the system's URL, and asks the terminology server whether the code exists).
 *
 * The folder also carries the resources the value sets refer to and a terminology server
 * might not have (the IPS absent/unknown codes): they go with each question as tx-resource.
 *
 * @module ips/ips-valuesets
 */

const fs = require('fs');
const path = require('path');

const FOLDER = path.join(__dirname, 'valuesets');

// an HL7 terminology: anything HL7 publishes - THO, and the code systems of the FHIR
// specification and its implementation guides. Not the http://hl7.org/fhir/sid/ URLs: those
// name other people's terminologies (ICD-10, CVX, NDC...), international or not
const HL7_SYSTEM_PREFIXES = ['http://terminology.hl7.org/', 'http://hl7.org/fhir/'];
const NOT_HL7_PREFIXES = ['http://hl7.org/fhir/sid/'];

function unversioned(url) {
  return typeof url === 'string' ? url.split('|')[0] : url;
}

/** Whether a code system URL is one of HL7's. */
function isHl7System(system) {
  return typeof system === 'string' && HL7_SYSTEM_PREFIXES.some(p => system.startsWith(p)) && !NOT_HL7_PREFIXES.some(p => system.startsWith(p));
}

class IpsValueSets {
  /** @param {string} [folder] - where the files are (tests) */
  constructor(folder = FOLDER) {
    this.folder = folder;
    // canonical -> ValueSet
    this.valueSets = new Map();
    // canonical -> CodeSystem
    this.codeSystems = new Map();
    // element path -> canonical
    this.elements = new Map();
    this.fallback = null;
    this.loaded = false;
  }

  /** Read the folder. Synchronous: the files are the module's own, and few. */
  load() {
    for (const name of fs.readdirSync(this.folder)) {
      if (!name.endsWith('.json') || name === 'elements.json') {
        continue;
      }
      const r = JSON.parse(fs.readFileSync(path.join(this.folder, name), 'utf8'));
      if (r.resourceType === 'ValueSet' && typeof r.url === 'string') {
        this.valueSets.set(unversioned(r.url), r);
      } else if (r.resourceType === 'CodeSystem' && typeof r.url === 'string') {
        this.codeSystems.set(unversioned(r.url), r);
      } else {
        throw new Error(`${name} is not a ValueSet or CodeSystem with a url`);
      }
    }
    const map = JSON.parse(fs.readFileSync(path.join(this.folder, 'elements.json'), 'utf8'));
    for (const [element, url] of Object.entries(map.elements || {})) {
      if (!this.valueSets.has(url)) {
        throw new Error(`elements.json: ${element} is checked against ${url}, which is not in ${this.folder}`);
      }
      this.elements.set(element, url);
    }
    if (typeof map.fallback !== 'string' || !this.valueSets.has(map.fallback)) {
      throw new Error('elements.json: the fallback value set is missing');
    }
    this.fallback = map.fallback;
    for (const vs of this.valueSets.values()) {
      for (const part of ['include', 'exclude']) {
        for (const inc of vs.compose?.[part] || []) {
          for (const v of inc.valueSet || []) {
            if (!this.valueSets.has(unversioned(v))) {
              throw new Error(`${vs.url} includes ${v}, which is not in ${this.folder}`);
            }
          }
        }
      }
    }
    this.loaded = true;
    return this;
  }

  /**
   * The value set an element is checked against, or null when it has none of its own.
   * @param {string} element - the path without indices, as terminology.js reports it
   */
  valueSetFor(element) {
    return this.elements.get(element) || null;
  }

  /** The ValueSet resource for a canonical, if it is one of ours. */
  valueSet(url) {
    return this.valueSets.get(unversioned(url)) || null;
  }

  /**
   * What goes with a question about a value set, besides the value set itself: the value
   * sets it includes (transitively), and the code systems of this folder that any of them
   * draw on.
   */
  referencedResources(url) {
    const out = [];
    const seen = new Set([unversioned(url)]);
    const queue = [unversioned(url)];
    const systems = new Set();
    while (queue.length > 0) {
      const vs = this.valueSets.get(queue.shift());
      for (const part of ['include', 'exclude']) {
        for (const inc of vs?.compose?.[part] || []) {
          if (typeof inc.system === 'string') {
            systems.add(unversioned(inc.system));
          }
          for (const v of inc.valueSet || []) {
            const u = unversioned(v);
            if (!seen.has(u)) {
              seen.add(u);
              queue.push(u);
              out.push(this.valueSets.get(u));
            }
          }
        }
      }
    }
    for (const s of systems) {
      if (this.codeSystems.has(s)) {
        out.push(this.codeSystems.get(s));
      }
    }
    return out;
  }

  /** The elements with a value set, and their value sets (for the documentation and tests). */
  table() {
    return [...this.elements.entries()].map(([element, url]) => ({ element, valueSet: url }));
  }
}

module.exports = { IpsValueSets, isHl7System, HL7_SYSTEM_PREFIXES, FOLDER };
