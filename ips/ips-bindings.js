//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * The value sets the IPS prefers, read from the IPS package itself.
 *
 * The IPS Composition profile says, for each section, which profiles its entries must
 * conform to (the entry slices of each section slice: the Problems section's entries are
 * Condition-uv-ips, the Vital Signs section's are the base specification's vitalsigns,
 * and so on). Each of those profiles binds some of its CodeableConcept elements to value
 * sets, or fixes them with a pattern. This loads the IPS package (through the shared
 * PackageManager, so it is cached with the terminology packages), reads the section map
 * and every profile's constraints, and answers, for a CodeableConcept at some element in
 * some section's entry, which value sets (or patterns) the IPS wants it in.
 *
 * What counts: a binding to one of the IPS's own value sets at any strength; a binding to
 * any other value set at preferred or stronger (never example); and a pattern or fixed
 * CodeableConcept, taken as a value set of one. A profile the IPS package refers to but
 * doesn't contain (vitalsigns) is read from the core package the IPS depends on.
 *
 * When an entry's section has no slice in the Composition profile, every profile of the
 * resource's type in the IPS package is a candidate instead.
 *
 * The value sets themselves (and the ones they include) are kept too, so that they can be
 * sent to the terminology server with $validate-code rather than relying on the server
 * knowing the IPS.
 *
 * @module ips/ips-bindings
 */

const path = require('path');
const { PackageManager, PackageContentLoader } = require('../library/package-manager');

const DEFAULT_PACKAGE = 'hl7.fhir.uv.ips#1.1.0';
const PACKAGE_SERVERS = ['https://packages2.fhir.org/packages'];
const COMPOSITION_PROFILE = 'http://hl7.org/fhir/uv/ips/StructureDefinition/Composition-uv-ips';
// binding strengths that count when the value set is not one of the IPS's own
const STRONG_ENOUGH = new Set(['required', 'extensible', 'preferred']);

function unversioned(url) {
  return typeof url === 'string' && url.includes('|') ? url.substring(0, url.indexOf('|')) : url;
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

class IpsBindings {
  /**
   * @param {string} [pkg] - id#version of the IPS package
   * @param {Object} [options]
   * @param {string} [options.cacheFolder] - where packages are cached
   * @param {Object} [options.packageManager] - a PackageManager to use (tests)
   */
  constructor(pkg = DEFAULT_PACKAGE, options = {}) {
    const hash = pkg.indexOf('#');
    if (hash < 0) {
      throw new Error(`The IPS package must be given as id#version, not '${pkg}'`);
    }
    this.packageId = pkg.substring(0, hash);
    this.packageVersion = pkg.substring(hash + 1);
    this.cacheFolder = options.cacheFolder || path.join(__dirname, '..', 'data', 'terminology-cache');
    this.packageManager = options.packageManager || new PackageManager(PACKAGE_SERVERS, this.cacheFolder);
    // profile url -> { type, bindings: Map<element path, candidates[]> }
    this.profiles = new Map();
    // section code (system|code) -> profile urls the section's entries conform to
    this.sections = new Map();
    // canonical (unversioned) -> ValueSet resource (the IPS's, and any read from the core package)
    this.valueSets = new Map();
    this.ipsValueSets = new Set();
    // canonical (unversioned) -> CodeSystem resource: the IPS's own code systems (absent-unknown)
    this.codeSystems = new Map();
    this.core = null;
    this.loaded = false;
  }

  /** Fetch the package and read its value sets, its profiles, and the Composition's section map. */
  async load() {
    const loader = await this.loadPackage(this.packageId, this.packageVersion);
    for (const entry of await loader.getResourcesByType('ValueSet')) {
      const vs = await loader.loadFile(entry);
      if (typeof vs.url === 'string') {
        this.valueSets.set(unversioned(vs.url), vs);
        this.ipsValueSets.add(unversioned(vs.url));
      }
    }
    for (const entry of await loader.getResourcesByType('CodeSystem')) {
      const cs = await loader.loadFile(entry);
      if (typeof cs.url === 'string') {
        this.codeSystems.set(unversioned(cs.url), cs);
      }
    }
    let composition = null;
    for (const entry of await loader.getResourcesByType('StructureDefinition')) {
      const sd = await loader.loadFile(entry);
      this.addProfile(sd);
      if (sd.url === COMPOSITION_PROFILE) {
        composition = sd;
      }
    }
    // the core package the IPS depends on, for the profiles it refers to but doesn't contain
    const deps = loader.package?.dependencies || {};
    const coreId = Object.keys(deps).find(id => /^hl7\.fhir\.r\d+[a-z]?\.core$/.test(id));
    if (coreId) {
      try {
        this.core = await this.loadPackage(coreId, deps[coreId]);
      } catch (e) {
        this.coreError = `${coreId}#${deps[coreId]}: ${e.message}`;
      }
    }
    if (composition) {
      await this.readSections(composition);
    }
    this.loaded = true;
    return this;
  }

  async loadPackage(id, version) {
    // fetch() answers with the folder's name within the cache
    const folder = await this.packageManager.fetch(id, version);
    const loader = new PackageContentLoader(path.isAbsolute(folder) ? folder : path.join(this.cacheFolder, folder));
    await loader.initialize();
    return loader;
  }

  /**
   * Take the constraints from one profile: for each CodeableConcept element, the value
   * sets it is bound to (the IPS's own at any strength, others at preferred or stronger)
   * and any pattern or fixed value, as candidates. From the snapshot where there is one,
   * else the differential.
   */
  addProfile(sd) {
    if (!sd || sd.kind !== 'resource' || sd.derivation !== 'constraint' || typeof sd.type !== 'string' || typeof sd.url !== 'string') {
      return;
    }
    const bindings = new Map();
    for (const e of sd.snapshot?.element || sd.differential?.element || []) {
      if (typeof e?.path !== 'string') {
        continue;
      }
      const types = Array.isArray(e.type) ? e.type.map(t => t.code) : [];
      if (!types.includes('CodeableConcept')) {
        continue;
      }
      const candidates = [];
      const vs = e.binding?.valueSet;
      if (typeof vs === 'string') {
        const url = unversioned(vs);
        if (this.ipsValueSets.has(url) || STRONG_ENOUGH.has(e.binding.strength)) {
          candidates.push({ valueSet: url, strength: e.binding.strength || null, profile: sd.url });
        }
      }
      const fixed = e.patternCodeableConcept || e.fixedCodeableConcept;
      const codings = (Array.isArray(fixed?.coding) ? fixed.coding : []).filter(c => isObject(c) && typeof c.code === 'string');
      if (codings.length > 0) {
        candidates.push({ pattern: codings.map(c => ({ system: c.system, code: c.code })), profile: sd.url });
      }
      if (candidates.length > 0) {
        if (!bindings.has(e.path)) {
          bindings.set(e.path, []);
        }
        const list = bindings.get(e.path);
        for (const c of candidates) {
          if (!list.some(x => x.valueSet && x.valueSet === c.valueSet) && !(c.pattern && list.some(x => x.pattern))) {
            list.push(c);
          }
        }
      }
    }
    this.profiles.set(sd.url, { type: sd.type, base: unversioned(sd.baseDefinition) || null, bindings });
  }

  /** A profile and every profile derived from it (Observation-results-uv-ips: the lab, pathology and radiology ones). */
  withDerived(urls) {
    const out = new Set(urls);
    let grew = true;
    while (grew) {
      grew = false;
      for (const [url, p] of this.profiles) {
        if (p.base && out.has(p.base) && !out.has(url)) {
          out.add(url);
          grew = true;
        }
      }
    }
    return [...out];
  }

  /**
   * The Composition profile's section slices: each section's code, and the profiles its
   * entry slices name. Profiles not in the IPS package are read from the core package.
   */
  async readSections(composition) {
    const elements = composition.snapshot?.element || composition.differential?.element || [];
    const codes = new Map(); // slice name -> section code key
    const profiles = new Map(); // slice name -> Set of profile urls
    for (const e of elements) {
      const id = typeof e?.id === 'string' ? e.id : '';
      let m = /^Composition\.section:([^.:]+)\.code$/.exec(id);
      if (m) {
        for (const c of e.patternCodeableConcept?.coding || e.fixedCodeableConcept?.coding || []) {
          if (isObject(c) && typeof c.code === 'string') {
            codes.set(m[1], `${c.system || ''}|${c.code}`);
          }
        }
        continue;
      }
      m = /^Composition\.section:([^.:]+)\.entry:[^.]+$/.exec(id);
      if (m) {
        if (!profiles.has(m[1])) {
          profiles.set(m[1], new Set());
        }
        for (const t of Array.isArray(e.type) ? e.type : []) {
          for (const p of Array.isArray(t?.targetProfile) ? t.targetProfile : []) {
            profiles.get(m[1]).add(unversioned(p));
          }
        }
      }
    }
    for (const [slice, key] of codes) {
      const urls = [...(profiles.get(slice) || [])];
      for (const url of urls) {
        if (!this.profiles.has(url)) {
          await this.loadExternalProfile(url);
        }
      }
      this.sections.set(key, urls.filter(u => this.profiles.has(u)));
    }
  }

  /** A profile the IPS refers to but doesn't contain: from the core package, if it has it. */
  async loadExternalProfile(url) {
    if (!this.core) {
      return;
    }
    try {
      const sd = await this.core.loadByReference({ url });
      if (sd) {
        this.addProfile(sd);
      }
    } catch {
      // not there: the section's entries are checked against whatever else applies
    }
  }

  /**
   * The value sets, and patterns, the IPS wants a CodeableConcept to be in.
   *
   * @param {string} element - the element's path without indices, as terminology.js reports
   *   it: Condition.code, MedicationStatement.medicationCodeableConcept, Observation.component.code
   * @param {{sectionCode?: string}} [context] - sectionCode as 'system|code' (or just the
   *   code) of the section the entry is in; without one, or for a section the IPS doesn't
   *   know, every IPS profile of the resource's type applies
   * @returns {Array<{valueSet?: string, strength?: string, pattern?: Array, profile: string}>}
   */
  bindingsFor(element, context = {}) {
    const dot = element.indexOf('.');
    if (dot < 0) {
      return [];
    }
    const type = element.substring(0, dot);
    let urls = null;
    if (context.sectionCode) {
      urls = this.sections.get(context.sectionCode) || this.sections.get('http://loinc.org|' + context.sectionCode) || null;
      if (urls) {
        urls = this.withDerived(urls).filter(u => this.profiles.get(u).type === type);
        if (urls.length === 0) {
          urls = null;
        }
      }
    }
    if (!urls) {
      urls = [...this.profiles.keys()].filter(u => this.profiles.get(u).type === type && u.startsWith('http://hl7.org/fhir/uv/ips/'));
    }
    const out = [];
    for (const url of urls) {
      const bindings = this.profiles.get(url).bindings;
      let list = bindings.get(element);
      if (!list && element.endsWith('CodeableConcept')) {
        // a choice: medicationCodeableConcept is medication[x] in the profile
        list = bindings.get(element.substring(0, element.length - 'CodeableConcept'.length) + '[x]');
      }
      for (const c of list || []) {
        if (c.valueSet ? !out.some(x => x.valueSet === c.valueSet) : !out.some(x => x.pattern && JSON.stringify(x.pattern) === JSON.stringify(c.pattern))) {
          out.push(c);
        }
      }
    }
    return out;
  }

  /** The ValueSet resource for a canonical, if the IPS package (or, once fetched, the core package) has it. */
  valueSet(url) {
    return this.valueSets.get(unversioned(url)) || null;
  }

  /**
   * Fetch a value set from the core package into the table, if it is there. The check
   * calls this before validating against a value set it doesn't have.
   */
  async fetchValueSet(url) {
    const u = unversioned(url);
    if (this.valueSets.has(u) || !this.core) {
      return this.valueSets.get(u) || null;
    }
    try {
      const vs = await this.core.loadByReference({ url: u });
      if (vs && vs.resourceType === 'ValueSet') {
        this.valueSets.set(u, vs);
        return vs;
      }
    } catch {
      // not there
    }
    return null;
  }

  /**
   * The other IPS resources a value set depends on, transitively: the value sets it
   * includes or excludes, and the IPS's own code systems they draw on - what a terminology
   * server needs (as tx-resource parameters) to evaluate it.
   */
  referencedValueSets(url) {
    const out = [];
    const seen = new Set([unversioned(url)]);
    const visit = (vs) => {
      const compose = vs?.compose || {};
      for (const inc of [].concat(compose.include || [], compose.exclude || [])) {
        for (const ref of Array.isArray(inc?.valueSet) ? inc.valueSet : []) {
          const u = unversioned(ref);
          if (!seen.has(u)) {
            seen.add(u);
            const other = this.valueSets.get(u);
            if (other) {
              out.push(other);
              visit(other);
            }
          }
        }
        const sys = unversioned(inc?.system);
        if (typeof sys === 'string' && !seen.has(sys) && this.codeSystems.has(sys)) {
          seen.add(sys);
          out.push(this.codeSystems.get(sys));
        }
      }
    };
    visit(this.valueSets.get(unversioned(url)));
    return out;
  }

  /** How many candidates across all profiles, for the log. */
  count() {
    let n = 0;
    for (const p of this.profiles.values()) {
      for (const list of p.bindings.values()) {
        n += list.length;
      }
    }
    return n;
  }
}

module.exports = { IpsBindings, DEFAULT_PACKAGE, COMPOSITION_PROFILE };
