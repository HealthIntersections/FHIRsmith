//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * The type model of a FHIR version, derived from its core package's StructureDefinitions:
 * what converting resources between JSON and XML needs (library/fhir-xml.js), and what
 * checking FHIRPath expressions' types needs (library/fhirpath).
 *
 * For each type (and each backbone element, by path), its elements in order, each with
 * whether it repeats, its type (or types: value[x]), whether it's an XML attribute (id on an
 * element, url on an extension, a primitive's value), where an element defined elsewhere is
 * (Questionnaire.item.item: contentReference), and: its minimum cardinality, the FHIRPath
 * System type of an element that has one (Element.id, a primitive's value), the profiles and
 * target profiles of its types (Reference(Patient)), and its binding.
 *
 * For each type: its kind (primitive, complex or resource), whether it's abstract, what it
 * specialises (Patient: DomainResource; code: string), its url, and for a primitive, the
 * System type of its value (and what JSON makes of it: a string, a number or a boolean): as
 * the definitions say, though systemTypeOf works it out from the primitive's chain.
 *
 * Profiles (derivation = constraint) and logical models are not in the model.
 *
 * The model is plain data, so it can be kept: loadModel keeps it in the cache folder, and the
 * rest module keeps it with its other derived definitions. MODEL_FORMAT changes when its shape
 * does.
 *
 * @module library/fhir-model
 */

const fs = require('fs');
const path = require('path');

// the shape of the models: a change makes the kept ones be derived again
const MODEL_FORMAT = 2;

const FHIR_TYPE_EXT = 'http://hl7.org/fhir/StructureDefinition/structuredefinition-fhir-type';
const SD_PREFIX = 'http://hl7.org/fhir/StructureDefinition/';
const SYSTEM_PREFIX = 'http://hl7.org/fhirpath/System.';

// element flags in the model
const ARRAY = 1;
const ATTR = 2;
const CHOICE = 4;

const NUMBER_TYPES = new Set(['integer', 'decimal', 'positiveInt', 'unsignedInt']);
// the FHIR types for the FHIRPath System types some elements are given (Element.id,
// Extension.url...), when the element doesn't say what FHIR type it is
const SYSTEM_TYPES = { String: 'string', Boolean: 'boolean', Integer: 'integer', Decimal: 'decimal', Date: 'date', DateTime: 'dateTime', Time: 'time' };

/**
 * The model, from the core package's StructureDefinitions.
 * @param {Object[]} sds - StructureDefinition resources
 * @returns {{primitives: Object, resources: string[], types: Object, info: Object}}
 *   primitives: type -> 'string', 'number', 'boolean' or 'xhtml'; resources: the resource
 *   types; types: type name or backbone path -> [[name, flags, [type codes], contentReference
 *   or null, details or absent]...], in order (details: { n: min, s: System type, p: {code:
 *   [profiles]}, t: {code: [target profiles]}, b: {strength, valueSet} }, each only when there
 *   is one); info: type -> { k: kind ('primitive' | 'complex' | 'resource'), b: base type, a:
 *   1 if abstract, u: url (if not the usual one), s: a primitive's System type }
 */
function deriveModel(sds) {
  const primitives = {};
  const resources = [];
  const types = {};
  const info = {};
  for (const sd of sds) {
    if (!sd || sd.kind === 'logical' || sd.derivation === 'constraint' || !sd.type || !sd.snapshot) {
      continue;
    }
    if (info[sd.type]) {
      // the first definition of a type wins (the core's)
      continue;
    }
    const elements = sd.snapshot.element || [];
    const ti = { k: sd.kind === 'primitive-type' ? 'primitive' : sd.kind === 'resource' ? 'resource' : 'complex' };
    const base = baseName(sd.baseDefinition);
    if (base) {
      ti.b = base;
    }
    if (sd.abstract) {
      ti.a = 1;
    }
    if (sd.url && sd.url !== SD_PREFIX + sd.type) {
      ti.u = sd.url;
    }
    info[sd.type] = ti;
    if (sd.kind === 'primitive-type') {
      primitives[sd.type] = sd.type === 'xhtml' ? 'xhtml' : sd.type === 'boolean' ? 'boolean' : NUMBER_TYPES.has(sd.type) ? 'number' : 'string';
      const value = elements.find(e => e.path === sd.type + '.value');
      const sys = value && systemType(value.type);
      if (sys) {
        ti.s = sys;
      }
      continue;
    }
    if (sd.kind === 'resource' && !resources.includes(sd.type)) {
      resources.push(sd.type);
    }
    const seen = new Set();
    for (const e of elements) {
      const p = String(e.path || '');
      const dot = p.lastIndexOf('.');
      if (dot < 0 || e.max === '0' || seen.has(p)) {
        continue;
      }
      seen.add(p);
      const parent = p.substring(0, dot);
      let name = p.substring(dot + 1);
      let flags = 0;
      if (name.endsWith('[x]')) {
        name = name.substring(0, name.length - 3);
        flags |= CHOICE;
      }
      if (e.max !== '1') {
        flags |= ARRAY;
      }
      if (Array.isArray(e.representation) && e.representation.includes('xmlAttr')) {
        flags |= ATTR;
      }
      const codes = [...new Set((e.type || []).map(typeCode).filter(x => x))];
      const ref = e.contentReference ? e.contentReference.substring(e.contentReference.indexOf('#') + 1) : null;
      const entry = [name, flags, codes, ref];
      const details = elementDetails(e);
      if (details) {
        entry.push(details);
      }
      (types[parent] = types[parent] || []).push(entry);
    }
  }
  return { primitives, resources: resources.sort(), types, info };
}

/** The type a base definition names (http://hl7.org/fhir/StructureDefinition/DomainResource: DomainResource) */
function baseName(url) {
  if (!url) {
    return null;
  }
  const s = String(url).split('|')[0];
  return s.substring(s.lastIndexOf('/') + 1) || null;
}

/** The FHIRPath System type of an element (String, for http://hl7.org/fhirpath/System.String), or null */
function systemType(types) {
  for (const t of types || []) {
    const code = String(t.code || '');
    if (code.startsWith(SYSTEM_PREFIX)) {
      return code.substring(SYSTEM_PREFIX.length);
    }
  }
  return null;
}

/** What an element says beyond its name, cardinality and type codes (null: nothing) */
function elementDetails(e) {
  const d = {};
  if (e.min > 0) {
    d.n = e.min;
  }
  const sys = systemType(e.type);
  if (sys) {
    d.s = sys;
  }
  for (const t of e.type || []) {
    const code = typeCode(t);
    if (!code) {
      continue;
    }
    if (Array.isArray(t.profile) && t.profile.length) {
      (d.p = d.p || {})[code] = [...t.profile];
    }
    if (Array.isArray(t.targetProfile) && t.targetProfile.length) {
      (d.t = d.t || {})[code] = [...t.targetProfile];
    }
  }
  if (e.binding && (e.binding.strength || e.binding.valueSet)) {
    d.b = {};
    if (e.binding.strength) {
      d.b.strength = e.binding.strength;
    }
    if (e.binding.valueSet) {
      d.b.valueSet = e.binding.valueSet;
    }
  }
  return Object.keys(d).length ? d : null;
}

/** An element type's code, as a FHIR type (the System types as the FHIR type they stand for) */
function typeCode(t) {
  const code = String(t.code || '');
  if (code.startsWith(SYSTEM_PREFIX)) {
    const ext = (t.extension || []).find(x => x.url === FHIR_TYPE_EXT);
    if (ext) {
      return ext.valueUrl || ext.valueUri || ext.valueString;
    }
    return SYSTEM_TYPES[code.substring(SYSTEM_PREFIX.length)] || 'string';
  }
  return code;
}

/**
 * A model ready to use: per type, its elements in order, by JSON property name and by name;
 * and the types themselves: their kind, and what they specialise.
 */
class FhirModel {
  /**
   * @param {Object} raw - from deriveModel
   */
  constructor(raw) {
    this.raw = raw;
    this.primitives = raw.primitives || {};
    this.resources = new Set(raw.resources || []);
    this.infos = raw.info || {};
    this.compiled = new Map();
    this.descendantCache = new Map();
  }

  /** @returns {boolean} whether the type (or backbone path) has elements in the model */
  has(key) {
    return !!this.raw.types[key];
  }

  /**
   * A type's elements: { list: [{name, array, attr, choice, types, ref, path, min, system,
   * profiles, targets, binding}], byJson: Map(json name -> {el, type}), byName: Map(name -> el) }
   * (profiles, targets: { type code: [urls] }; system: the FHIRPath System type, if it has one)
   */
  type(key) {
    let c = this.compiled.get(key);
    if (c) {
      return c;
    }
    const raw = this.raw.types[key];
    if (!raw) {
      return null;
    }
    const list = raw.map(([name, flags, types, ref, d]) => ({
      name, array: !!(flags & ARRAY), attr: !!(flags & ATTR), choice: !!(flags & CHOICE), types, ref, path: key + '.' + name,
      min: (d && d.n) || 0, system: (d && d.s) || null, profiles: (d && d.p) || null, targets: (d && d.t) || null,
      binding: (d && d.b) || null
    }));
    const byJson = new Map();
    const byName = new Map();
    for (const el of list) {
      // [JSON name, its type, what its values are], for each type it can be
      el.forms = (el.choice ? el.types : [el.types[0] || null]).map(t => {
        const json = el.choice ? el.name + t.charAt(0).toUpperCase() + t.substring(1) : el.name;
        return { json, ext: '_' + json, type: t };
      });
      for (const f of el.forms) {
        byJson.set(f.json, { el, type: f.type });
      }
      byName.set(el.name, el);
    }
    c = { list, byJson, byName };
    this.compiled.set(key, c);
    return c;
  }

  /**
   * An element of a type (or backbone path), by its name ('value' for value[x]), or null
   * @param {string} key
   * @param {string} name
   */
  element(key, name) {
    const t = this.type(key);
    return t ? t.byName.get(name) || null : null;
  }

  /**
   * What a value of an element is: { kind: 'primitive'|'xhtml'|'resource'|'complex', json, key }
   * (json: what JSON makes of a primitive; key: a complex value's type, or backbone path)
   */
  kindOf(el, type) {
    let kinds = el.kinds;
    if (!kinds) {
      kinds = el.kinds = new Map();
    }
    let k = kinds.get(type);
    if (!k) {
      k = this.kindOfUncached(el, type);
      kinds.set(type, k);
    }
    return k;
  }

  kindOfUncached(el, type) {
    if (el.ref) {
      return { kind: 'complex', key: el.ref };
    }
    if (this.raw.types[el.path]) {
      return { kind: 'complex', key: el.path };
    }
    const p = this.primitives[type];
    if (p === 'xhtml') {
      return { kind: 'xhtml' };
    }
    if (p) {
      return { kind: 'primitive', json: p };
    }
    if (type === 'Resource' || type === 'DomainResource' || this.resources.has(type)) {
      return { kind: 'resource' };
    }
    if (this.raw.types[type]) {
      return { kind: 'complex', key: type };
    }
    // a type the model doesn't have: an Element with no children of its own
    return { kind: 'complex', key: 'Element' };
  }

  // ---- the types ----

  /** The names of the types in the model (primitive, complex and resource) */
  typeNames() {
    return Object.keys(this.infos);
  }

  /**
   * What the model knows about a type, or null: { name, kind ('primitive' | 'complex' |
   * 'resource'), base (the type it specialises, or null), abstract, url, system (a primitive's
   * FHIRPath System type) }
   * @param {string} type
   */
  info(type) {
    const i = this.infos[type];
    if (!i) {
      return null;
    }
    return { name: type, kind: i.k, base: i.b || null, abstract: !!i.a, url: i.u || SD_PREFIX + type, system: this.systemTypeOf(type) };
  }

  /** The type a type specialises (Patient: DomainResource), or null */
  baseOf(type) {
    const i = this.infos[type];
    return i && i.b ? i.b : null;
  }

  /** Whether a type is (or specialises, at any depth) another: isA('code', 'string'), isA('Patient', 'Resource') */
  isA(type, ancestor) {
    for (let t = type, n = 0; t && n < 50; t = this.baseOf(t), n++) {
      if (t === ancestor) {
        return true;
      }
    }
    return false;
  }

  /** The type, and every type that specialises it, at any depth (Resource: every resource type) */
  descendants(type) {
    let d = this.descendantCache.get(type);
    if (!d) {
      d = Object.keys(this.infos).filter(t => this.isA(t, type));
      this.descendantCache.set(type, d);
    }
    return d;
  }

  isPrimitive(type) {
    return !!this.primitives[type];
  }

  isResource(type) {
    return this.resources.has(type);
  }

  isAbstract(type) {
    const i = this.infos[type];
    return !!(i && i.a);
  }

  /**
   * A primitive type's FHIRPath System type (code: String), or null. It's the System type of the
   * primitive it comes from (the first in its chain that doesn't specialise another primitive):
   * R4 says positiveInt's value is a System.String, but positiveInt is an integer
   */
  systemTypeOf(type) {
    let found = null;
    for (let t = type, n = 0; t && n < 50 && this.primitives[t]; t = this.baseOf(t), n++) {
      const i = this.infos[t];
      if (i && i.s) {
        found = i.s;
      }
    }
    return found;
  }

  /** The type a url names (http://hl7.org/fhir/StructureDefinition/Patient: Patient), or null */
  typeForUrl(url) {
    const u = String(url || '').split('|')[0];
    if (u.startsWith(SD_PREFIX) && this.infos[u.substring(SD_PREFIX.length)] && !this.infos[u.substring(SD_PREFIX.length)].u) {
      return u.substring(SD_PREFIX.length);
    }
    for (const [t, i] of Object.entries(this.infos)) {
      if (i.u === u) {
        return t;
      }
    }
    return null;
  }
}

/**
 * The model for a FHIR version, from the StructureDefinitions in its core package: kept in the
 * cache folder, and derived (from the package, fetched if need be) when it isn't there.
 * @param {Object} options
 * @param {string} options.corePackage - 'hl7.fhir.r4.core#4.0.1'
 * @param {Object} options.packageManager - library/package-manager.js (fetch, cacheFolder)
 * @param {string} options.cacheFolder - where to keep the model
 * @returns {Promise<FhirModel>}
 */
async function loadModel(options) {
  const [id, version] = options.corePackage.split('#');
  const file = path.join(options.cacheFolder, `fhir-model-${id}-${version}-v${MODEL_FORMAT}.json`);
  // the package is fetched every time, though the model is kept, so it counts as used (the tx
  // module's library deletes the packages it hasn't fetched)
  const name = await options.packageManager.fetch(id, version);
  if (fs.existsSync(file)) {
    try {
      return new FhirModel(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (e) {
      // a broken file: derive it again
    }
  }
  const folder = path.isAbsolute(name) ? name : path.join(options.packageManager.cacheFolder, name);
  const raw = { ...deriveModel(readStructureDefinitions(folder)), version };
  fs.mkdirSync(options.cacheFolder, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(raw));
  fs.renameSync(tmp, file);
  return new FhirModel(raw);
}

/** The StructureDefinitions in a package folder */
function readStructureDefinitions(folder) {
  const dir = fs.existsSync(path.join(folder, 'package')) ? path.join(folder, 'package') : folder;
  let files;
  const indexFile = path.join(dir, '.index.json');
  if (fs.existsSync(indexFile)) {
    files = (JSON.parse(fs.readFileSync(indexFile, 'utf8')).files || []).filter(f => f.resourceType === 'StructureDefinition').map(f => f.filename);
  } else {
    files = fs.readdirSync(dir).filter(f => f.startsWith('StructureDefinition-') && f.endsWith('.json'));
  }
  const out = [];
  for (const f of files) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    } catch (e) {
      // not readable: skipped
    }
  }
  return out;
}

module.exports = {
  deriveModel,
  FhirModel,
  loadModel,
  readStructureDefinitions,
  typeCode,
  MODEL_FORMAT,
  // the names the XML converter has always used
  deriveXmlModel: deriveModel,
  XmlModel: FhirModel,
  loadXmlModel: loadModel
};
