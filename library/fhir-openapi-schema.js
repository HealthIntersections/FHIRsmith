//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * Generates OpenAPI 3.1 (JSON Schema 2020-12) component schemas for FHIR resources from
 * their StructureDefinitions.
 *
 * The published FHIR JSON schema doesn't work well in an OpenAPI description: every
 * resource reaches every other one (through contained resources and Bundle entries) and
 * every datatype (through extensions), so referencing one resource drags in the whole
 * specification. This generator produces only what the named resources actually use, and
 * cuts the recursion at two fixed boundaries:
 *
 *  - an element whose type is a resource (Bundle.entry.resource, and so on) is "any
 *    resource": an object with a resourceType, otherwise not described. A module can
 *    narrow it with an overlay (a search Bundle of TestReports, say)
 *  - an extension is described as an object with a url and a value[x], but the value isn't
 *    described further
 *
 * Elements can be prohibited outright (the testing module doesn't accept contained
 * resources), and an overlay can tighten the generated schemas to what an endpoint really
 * requires.
 *
 * A module can move the boundaries, when it knows what it handles:
 *  - `resources` names the resources an element of type Resource can hold, by path
 *    (Bundle.entry.resource: CodeSystem or ValueSet, say); they're generated too. An
 *    element whose type is a particular resource (Bundle.issues: OperationOutcome) is always
 *    that resource
 *  - `choiceTypes` restricts the types of a choice element, by path
 *    (Parameters.parameter.value[x]: the primitives, say)
 *  - `generateExtension` describes Extension fully, from its StructureDefinition, instead
 *    of as a boundary; usually with choiceTypes for Extension.value[x]
 *
 * What's generated:
 *  - one schema per resource and complex datatype, named for the type, and one per backbone
 *    element, named for its path (TestReport_Setup_Action); contentReference becomes a $ref
 *  - every object is closed (additionalProperties: false), as FHIR JSON is
 *  - a primitive element `x` gets its value (with the type's regex as a pattern, and the
 *    codes of a required binding as an enum where they can be worked out from the package)
 *    and its `_x` sibling for the element's id and extensions. In a repeating primitive,
 *    either array may have nulls where the other has an entry
 *  - choice elements (value[x]) are expanded to their concrete names (valueString ...)
 *  - required: elements with min >= 1, and resourceType
 *
 * @module library/fhir-openapi-schema
 */

const fs = require('fs');
const path = require('path');

const REGEX_EXT = 'http://hl7.org/fhir/StructureDefinition/regex';
const SYSTEM_STRING = 'http://hl7.org/fhirpath/System.String';

/** The boundary schemas; included where something reaches them. */
const BOUNDARY_SCHEMAS = {
  Extension: {
    type: 'object',
    description: 'An extension. The value (value[x]) can be any FHIR datatype, and is not described further here.',
    properties: {
      id: { type: 'string' },
      url: { type: 'string', description: 'The extension\'s definition' },
      extension: { type: 'array', items: { $ref: '#/components/schemas/Extension' } }
    },
    patternProperties: {
      '^_?value[A-Z][A-Za-z0-9]*$': { description: 'The value (value[x]), and its _value[x] sibling for a primitive' }
    },
    required: ['url'],
    additionalProperties: false
  },
  AnyResource: {
    type: 'object',
    description: 'A FHIR resource of any type. Not described further here.',
    properties: {
      resourceType: { type: 'string' }
    },
    required: ['resourceType'],
    additionalProperties: true
  }
};

function ref(name) {
  return { $ref: `#/components/schemas/${name}` };
}

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function schemaNameForPath(p) {
  return p.split('.').map(cap).join('_');
}

function extValue(type, url) {
  const e = (type.extension || []).find(x => x.url === url);
  return e ? (e.valueUrl || e.valueString || e.valueUri) : undefined;
}

/**
 * The StructureDefinitions, CodeSystems and ValueSets in an unpacked FHIR package.
 */
class FhirPackage {
  constructor(dir) {
    this.dir = dir;
    this.sds = new Map();
    this.byUrl = new Map();
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json') || !/^(StructureDefinition|CodeSystem|ValueSet)-/.test(f)) {
        continue;
      }
      const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (r.url) {
        this.byUrl.set(r.url, r);
      }
      if (r.resourceType === 'StructureDefinition' && r.derivation === 'specialization') {
        this.sds.set(r.type, r);
      }
    }
    const pj = path.join(dir, 'package.json');
    this.id = fs.existsSync(pj) ? (() => {
      const p = JSON.parse(fs.readFileSync(pj, 'utf8'));
      return `${p.name}#${p.version}`;
    })() : dir;
  }

  sd(type) {
    return this.sds.get(type);
  }

  /** The codes of a value set, if they can be worked out simply; otherwise null. */
  codes(vsUrl) {
    const vs = this.byUrl.get(vsUrl.split('|')[0]);
    if (!vs || !vs.compose || vs.compose.exclude || !Array.isArray(vs.compose.include)) {
      return null;
    }
    const codes = [];
    for (const inc of vs.compose.include) {
      if (inc.filter || inc.valueSet || !inc.system) {
        return null;
      }
      if (inc.concept) {
        codes.push(...inc.concept.map(c => c.code));
      } else {
        const cs = this.byUrl.get(inc.system);
        if (!cs || cs.content !== 'complete' || !cs.concept) {
          return null;
        }
        const walk = (list) => list.forEach(c => {
          codes.push(c.code);
          if (c.concept) {
            walk(c.concept);
          }
        });
        walk(cs.concept);
      }
    }
    return codes.length > 0 ? codes : null;
  }
}

class FhirSchemaGenerator {
  /**
   * @param {FhirPackage} pkg
   * @param {Object} [options]
   * @param {string[]} [options.prohibit] - elements that are left out: a name (e.g.
   *   'contained') leaves the element out of every resource and type, a path (e.g.
   *   'CodeSystem.contained') out of that one place. The schemas are closed, so they're
   *   then not allowed
   * @param {Object<string, string[]>} [options.resources] - path -> the resource types an
   *   element of type Resource may hold (otherwise it's AnyResource)
   * @param {Object<string, string[]>} [options.choiceTypes] - path of a choice element
   *   (e.g. 'Parameters.parameter.value[x]') -> the types allowed (otherwise all of them)
   * @param {boolean} [options.generateExtension] - describe Extension from its
   *   StructureDefinition rather than as a boundary
   */
  constructor(pkg, options = {}) {
    this.pkg = pkg;
    this.prohibit = new Set(options.prohibit || []);
    this.resources = options.resources || {};
    this.choiceTypes = options.choiceTypes || {};
    this.boundary = { ...BOUNDARY_SCHEMAS };
    if (options.generateExtension) {
      delete this.boundary.Extension;
    }
    this.schemas = {};
    this.queue = [];
    this.queued = new Set();
  }

  /**
   * @param {string[]} roots - the resources (and types) to describe
   * @returns {Object} name -> schema
   */
  generate(roots) {
    Object.assign(this.schemas, structuredClone(this.boundary));
    roots.forEach(r => this.enqueue(r));
    while (this.queue.length > 0) {
      this.generateType(this.queue.shift());
    }
    // a boundary nothing ended up at isn't needed
    const used = JSON.stringify(this.schemas);
    for (const name of Object.keys(this.boundary)) {
      if (!used.includes(`"#/components/schemas/${name}"`)) {
        delete this.schemas[name];
      }
    }
    // a stable order, so the generated file diffs cleanly
    const sorted = {};
    for (const k of Object.keys(this.schemas).sort()) {
      sorted[k] = this.schemas[k];
    }
    return sorted;
  }

  enqueue(type) {
    if (!this.queued.has(type) && !this.boundary[type]) {
      this.queued.add(type);
      this.queue.push(type);
    }
  }

  generateType(type) {
    const sd = this.pkg.sd(type);
    if (!sd) {
      throw new Error(`No StructureDefinition for ${type} in ${this.pkg.id}`);
    }
    if (sd.kind === 'primitive-type') {
      throw new Error(`${type} is a primitive type, and has no schema of its own`);
    }
    this.elements = sd.snapshot.element;
    this.buildObject(type, type, sd.kind === 'resource', sd.description);
  }

  children(p) {
    const prefix = p + '.';
    return this.elements.filter(e => e.path.startsWith(prefix) && !e.path.substring(prefix.length).includes('.'));
  }

  buildObject(schemaName, p, isResource, description) {
    const schema = { type: 'object' };
    if (description) {
      schema.description = description;
    }
    const properties = {};
    const required = [];
    if (isResource) {
      properties.resourceType = { const: p };
      required.push('resourceType');
    }
    for (const el of this.children(p)) {
      const name = el.path.substring(p.length + 1);
      if (el.max === '0' || this.prohibit.has(name) || this.prohibit.has(el.path)) {
        continue;
      }
      if (name.endsWith('[x]')) {
        const base = name.slice(0, -3);
        const allowed = this.choiceTypes[el.path];
        if (allowed) {
          const unknown = allowed.filter(t => !el.type.some(et => et.code === t));
          if (unknown.length > 0) {
            throw new Error(`${el.path} can't be ${unknown.join(', ')}`);
          }
        }
        for (const t of el.type.filter(t => !allowed || allowed.includes(t.code))) {
          this.addProperty(properties, base + cap(t.code), el, t);
        }
      } else {
        this.addProperty(properties, name, el, el.type ? el.type[0] : null);
        if (el.min >= 1) {
          required.push(name);
        }
      }
    }
    schema.properties = properties;
    if (required.length > 0) {
      schema.required = required;
    }
    schema.additionalProperties = false;
    this.schemas[schemaName] = schema;
  }

  addProperty(properties, name, el, type) {
    const many = el.max !== '1';
    const description = el.short;
    let value;
    let primitive = false;

    if (el.contentReference) {
      value = ref(schemaNameForPath(el.contentReference.replace(/^.*#/, '')));
    } else if (!type) {
      throw new Error(`${el.path} has no type`);
    } else if (type.code === SYSTEM_STRING) {
      // element ids, and the like
      value = { type: 'string' };
    } else if (type.code === 'BackboneElement' || (type.code === 'Element' && this.children(el.path).length > 0)) {
      const sn = schemaNameForPath(el.path);
      this.buildObject(sn, el.path, false, el.definition);
      value = ref(sn);
    } else if (type.code === 'Extension') {
      this.enqueue('Extension');
      value = ref('Extension');
    } else {
      const tsd = this.pkg.sd(type.code);
      if (!tsd) {
        throw new Error(`${el.path}: no StructureDefinition for type ${type.code}`);
      }
      if (type.code === 'Resource' || type.code === 'DomainResource') {
        const allowed = this.resources[el.path];
        if (allowed) {
          allowed.forEach(t => this.enqueue(t));
          value = allowed.length === 1 ? ref(allowed[0]) : { anyOf: allowed.map(ref) };
        } else {
          value = ref('AnyResource');
        }
      } else if (tsd.kind === 'resource') {
        this.enqueue(type.code);
        value = ref(type.code);
      } else if (tsd.kind === 'primitive-type') {
        primitive = true;
        value = this.primitive(tsd, el);
      } else {
        this.enqueue(type.code);
        value = ref(type.code);
      }
    }

    if (primitive) {
      // the value, and the _x sibling for its id and extensions
      if (many) {
        properties[name] = { type: 'array', description, items: { anyOf: [value, { type: 'null' }] } };
        properties['_' + name] = { type: 'array', items: { anyOf: [ref('Element'), { type: 'null' }] } };
      } else {
        properties[name] = { ...value, description };
        properties['_' + name] = ref('Element');
      }
      this.enqueue('Element');
    } else if (many) {
      properties[name] = { type: 'array', description, items: value };
    } else {
      properties[name] = { ...value, description };
    }
  }

  primitive(tsd, el) {
    const valueEl = tsd.snapshot.element.find(e => e.path === `${tsd.type}.value`);
    const vt = valueEl && valueEl.type ? valueEl.type[0] : {};
    // x-fhir-type records the FHIR type, which the JSON type doesn't say (dateTime, code, uri
    // are all strings); the reference page shows it instead of the regex
    const schema = { 'x-fhir-type': tsd.type };
    switch (tsd.type) {
      case 'boolean': schema.type = 'boolean'; break;
      case 'integer': schema.type = 'integer'; break;
      case 'positiveInt': schema.type = 'integer'; schema.minimum = 1; break;
      case 'unsignedInt': schema.type = 'integer'; schema.minimum = 0; break;
      case 'decimal': schema.type = 'number'; break;
      default: schema.type = 'string';
    }
    if (schema.type === 'string') {
      const regex = extValue(vt, REGEX_EXT);
      if (regex) {
        schema.pattern = regex.startsWith('^') ? regex : `^(${regex})$`;
      }
    }
    if (tsd.type === 'code' && el.binding && el.binding.strength === 'required' && el.binding.valueSet) {
      const codes = this.pkg.codes(el.binding.valueSet);
      if (codes) {
        schema.enum = codes;
        delete schema.pattern;
      }
    }
    return schema;
  }
}

/**
 * Applies an overlay to generated schemas: objects merge, `required` lists are unioned,
 * and anything else in the overlay replaces what was generated. A schema in the overlay
 * that wasn't generated is added as is.
 */
// keys that would reach an object's prototype rather than the object
function isUnsafeKey(k) {
  return k === '__proto__' || k === 'constructor' || k === 'prototype';
}

function applyOverlay(schemas, overlay) {
  const merge = (target, src) => {
    for (const [k, v] of Object.entries(src)) {
      if (isUnsafeKey(k)) {
        throw new Error(`An overlay can't set '${k}'`);
      }
      // only the target's own properties are merged into, never anything it inherits
      const own = Object.prototype.hasOwnProperty.call(target, k);
      if (k === 'required' && Array.isArray(target.required)) {
        target.required = [...new Set([...target.required, ...v])];
      } else if (own && v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k]) && !v.$replace) {
        merge(target[k], v);
      } else {
        const value = v && v.$replace ? { ...v } : v;
        if (value && value.$replace) {
          delete value.$replace;
        }
        target[k] = value;
      }
    }
  };
  for (const [name, s] of Object.entries(overlay || {})) {
    if (isUnsafeKey(name)) {
      throw new Error(`An overlay can't set '${name}'`);
    }
    if (Object.prototype.hasOwnProperty.call(schemas, name)) {
      merge(schemas[name], s);
    } else {
      schemas[name] = s;
    }
  }
  return schemas;
}

/**
 * Generates the schemas a module's config asks for.
 *
 * @param {Object} config - { package, roots, prohibit, resources, choiceTypes,
 *   generateExtension, overlay } (see FhirSchemaGenerator)
 * @param {string} packageDir - the unpacked package
 * @returns {{generatedFrom: string, schemas: Object}}
 */
function generateSchemas(config, packageDir) {
  const pkg = new FhirPackage(packageDir);
  const gen = new FhirSchemaGenerator(pkg, {
    prohibit: config.prohibit,
    resources: config.resources,
    choiceTypes: config.choiceTypes,
    generateExtension: config.generateExtension
  });
  const schemas = applyOverlay(gen.generate(config.roots), structuredClone(config.overlay || {}));
  return { generatedFrom: pkg.id, schemas };
}

module.exports = { FhirPackage, FhirSchemaGenerator, applyOverlay, generateSchemas, BOUNDARY_SCHEMAS };
