//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * What an endpoint indexes and searches by: the SearchParameters, CompartmentDefinitions
 * and resource types of its FHIR version, from the core package and any others it lists,
 * plus custom SearchParameters stored on the endpoint.
 *
 * Search parameter expressions are compiled once, with fhirpath.js and the model for the
 * endpoint's version. fhirpath.js's resolve() only runs asynchronously (it fetches); the
 * core search parameters only use it as `where(resolve() is X)`, which needs just the target's
 * type, so a resolve() is supplied that returns a stub of the right type: from the reference
 * (Patient/123, or the type in an absolute URL), from Reference.type, or the contained
 * resource itself for #id.
 *
 * Loading a core package's StructureDefinitions takes time, so what is derived from the
 * packages is kept in the cache folder, by package list (deriveDefinitions / cache).
 *
 * @module rest/indexing/definitions
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const fhirpath = require('fhirpath');
const { deriveXmlModel, XmlModel } = require('../xml');

// the parameters the search handles itself, not through the index tables
const SPECIAL_PARAMS = new Set(['_id', '_lastUpdated', '_tag', '_profile', '_security', '_text', '_content', '_list',
  '_has', '_type', '_query', '_filter', '_sort', '_count', '_include', '_revinclude', '_summary', '_elements',
  '_contained', '_containedType', '_total', '_format', '_pretty', '_offset', '_getpages']);

// the shape of what deriveDefinitions makes: a change makes the cached copies be derived again
const DERIVED_FORMAT = 4;

const INDEXED_TYPES = new Set(['string', 'token', 'date', 'number', 'quantity', 'reference', 'uri', 'composite']);

const CORE_PACKAGES = {
  '3.0': 'hl7.fhir.r3.core#3.0.2',
  '4.0': 'hl7.fhir.r4.core#4.0.1',
  '4.3': 'hl7.fhir.r4b.core#4.3.0',
  '5.0': 'hl7.fhir.r5.core#5.0.0'
};

/** The major.minor of a FHIR version ('4.0.1' -> '4.0') */
function majorMinor(v) {
  const m = /^(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? `${m[1]}.${m[2]}` : null;
}

function modelFor(fhirVersion) {
  const mm = majorMinor(fhirVersion);
  if (mm === '3.0') {
    return require('fhirpath/fhir-context/stu3');
  }
  if (mm === '4.0' || mm === '4.3') {
    return require('fhirpath/fhir-context/r4');
  }
  return require('fhirpath/fhir-context/r5');
}

function corePackage(fhirVersion) {
  const p = CORE_PACKAGES[majorMinor(fhirVersion)];
  if (!p) {
    throw new Error(`No core package known for FHIR version ${fhirVersion}`);
  }
  return p;
}

const TYPE_SEGMENT = /^[A-Z][A-Za-z]{0,63}$/;
const ID_SEGMENT = /^[A-Za-z0-9\-.]{1,64}$/;

/**
 * The resource type a reference string names ([base/]Type/id[/_history/vid]), or null. By its
 * last path segments, not a regular expression over the whole string: the string is from a
 * resource, and a pattern that can start anywhere is slow on a long one.
 * @param {string} ref
 */
function referenceType(ref) {
  if (typeof ref !== 'string' || !ref || ref.length > 4096) {
    return null;
  }
  const parts = ref.split('/');
  let n = parts.length;
  if (n >= 4 && parts[n - 2] === '_history' && ID_SEGMENT.test(parts[n - 1])) {
    n -= 2;
  }
  if (n >= 2 && TYPE_SEGMENT.test(parts[n - 2]) && ID_SEGMENT.test(parts[n - 1])) {
    return parts[n - 2];
  }
  return null;
}

/**
 * The fhirpath.js options for indexing: typed results, and resolve().
 * @param {Object} model
 */
function fhirpathOptions(model) {
  // fhirpath.js doesn't export ResourceNode, but every typed result is one
  const ResourceNode = fhirpath.evaluate({ resourceType: 'Patient' }, 'Patient', null, model, { resolveInternalTypes: false })[0].constructor;
  // internalStructures: fhirpath.js gives the function the ResourceNodes, not just their values,
  // so a '#id' reference can be followed up to the resource that holds it (without it, the
  // inputs are bare values, and a contained resource is never found)
  const resolve = {
    internalStructures: true,
    fn: function (inputs) {
      const out = [];
      for (const input of inputs) {
        const d = input instanceof ResourceNode ? input.data : input;
        let target = null;
        if (typeof d === 'string') {
          const t = referenceType(d);
          target = t ? { resourceType: t } : null;
        } else if (d && typeof d === 'object') {
          if (typeof d.reference === 'string' && d.reference.startsWith('#')) {
            // a contained resource: the resource itself; '#' alone is the container
            const root = rootOf(input);
            const id = d.reference.substring(1);
            if (!id) {
              target = (root && CONTAINERS.get(root)) || root;
            } else {
              target = (root && Array.isArray(root.contained) && root.contained.find(c => c && c.id === id)) || null;
            }
          } else {
            const t = d.type || referenceType(d.reference);
            target = t ? { resourceType: t } : null;
          }
        }
        if (target && target.resourceType) {
          out.push(ResourceNode.makeResNode(this, target, null, target.resourceType, null, target.resourceType));
        }
      }
      return out;
    }
  };
  // hasExtension(url), which fhirpath.js doesn't have (QuestionnaireResponse's item-subject)
  const hasExtension = {
    fn: function (inputs, url) {
      const want = Array.isArray(url) ? url[0] : url;
      return inputs.map(input => {
        const d = input instanceof ResourceNode ? input.data : input;
        return !!(d && typeof d === 'object' && Array.isArray(d.extension) && d.extension.some(e => e && e.url === want));
      });
    },
    arity: { 1: ['String'] }
  };
  return { ResourceNode, options: { resolveInternalTypes: false, userInvocationTable: { resolve, hasExtension } } };
}

/**
 * An expression as fhirpath.js evaluates it. The specification's search parameters use
 * "x as T" on paths that can repeat (Observation.component.value as Quantity), which
 * fhirpath.js refuses when there is more than one value: x.ofType(T) means the same there.
 * @param {string} expression
 */
function forEvaluation(expression) {
  return String(expression).replace(/([A-Za-z%][A-Za-z0-9_.]*)\s+as\s+([A-Za-z][A-Za-z0-9]*)/g, '$1.ofType($2)');
}

/**
 * Split an expression at its top-level | (outside brackets and strings).
 * @param {string} expression
 * @returns {string[]}
 */
function splitUnion(expression) {
  const out = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (let i = 0; i < expression.length; i++) {
    const c = expression[i];
    if (quote) {
      cur += c;
      if (c === '\\' && i + 1 < expression.length) {
        cur += expression[++i];
      } else if (c === quote) {
        quote = null;
      }
    } else if (c === '\'' || c === '`' || c === '"') {
      quote = c;
      cur += c;
    } else if (c === '(' || c === '[' || c === '{') {
      depth++;
      cur += c;
    } else if (c === ')' || c === ']' || c === '}') {
      depth--;
      cur += c;
    } else if (c === '|' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur.trim());
  return out.filter(x => x);
}

/**
 * A contained resource being indexed is evaluated as a copy that carries its container's
 * contained list (so its own '#id' references find its siblings); this maps that copy to its
 * container (so '#' alone finds the container).
 */
const CONTAINERS = new WeakMap();

function rootOf(node) {
  let n = node;
  while (n && n.parentResNode) {
    n = n.parentResNode;
  }
  return n ? n.data : null;
}

/**
 * Read the resources of the types wanted from a package folder.
 * @param {string} folder - the package's folder (the one holding package/)
 * @param {Set<string>} types - resourceType values to read
 */
function readPackage(folder, types) {
  const dir = fs.existsSync(path.join(folder, 'package')) ? path.join(folder, 'package') : folder;
  const out = [];
  let files;
  const indexFile = path.join(dir, '.index.json');
  if (fs.existsSync(indexFile)) {
    const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    files = (index.files || []).filter(f => types.has(f.resourceType)).map(f => f.filename);
  } else {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'package.json');
  }
  for (const f of files) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (r && types.has(r.resourceType)) {
        out.push(r);
      }
    } catch (e) {
      // not a resource: skip it
    }
  }
  return out;
}

/**
 * The definitions an endpoint needs, from its packages, in a plain form that can be cached:
 * { fhirVersion, resourceTypes, searchParameters, compartments, summary, mandatory, xml } (xml:
 * the model for converting resources to and from XML: ../xml.js).
 * @param {string[]} folders - package folders, core first
 * @param {string} fhirVersion
 */
function deriveDefinitions(folders, fhirVersion) {
  const resourceTypes = [];
  const searchParameters = [];
  const compartments = [];
  const summary = {};
  const mandatory = {};
  const structures = [];
  for (const folder of folders) {
    for (const r of readPackage(folder, new Set(['SearchParameter', 'CompartmentDefinition', 'StructureDefinition']))) {
      if (r.resourceType === 'SearchParameter') {
        searchParameters.push(slimSearchParameter(r));
      } else if (r.resourceType === 'CompartmentDefinition') {
        compartments.push({ code: r.code, url: r.url, resource: (r.resource || []).map(x => ({ code: x.code, param: x.param || [] })) });
      } else {
        structures.push(r);
      }
      if (r.resourceType === 'StructureDefinition' && r.kind === 'resource' && r.derivation !== 'constraint' && !r.abstract && r.type) {
        if (!resourceTypes.includes(r.type)) {
          resourceTypes.push(r.type);
        }
        const elements = (r.snapshot && r.snapshot.element) || [];
        summary[r.type] = [];
        mandatory[r.type] = [];
        for (const e of elements) {
          const parts = String(e.path || '').split('.');
          if (parts.length === 2) {
            const name = parts[1].replace('[x]', '');
            if (e.isSummary) {
              summary[r.type].push(name);
            }
            if (e.min > 0) {
              mandatory[r.type].push(name);
            }
          }
        }
      }
    }
  }
  return { fhirVersion, resourceTypes: resourceTypes.sort(), searchParameters, compartments, summary, mandatory, xml: deriveXmlModel(structures) };
}

function slimSearchParameter(r) {
  return {
    url: r.url, code: r.code, type: r.type, expression: r.expression || null, base: r.base || [],
    // for the search forms (web.js)
    description: r.description ? String(r.description).substring(0, 3000) : null,
    target: r.target || [], component: (r.component || []).map(c => ({ definition: c.definition, expression: c.expression }))
  };
}

/**
 * Get the definitions for packages, from the cache folder when they have been derived
 * before, else from the packages (fetched through the package manager).
 * @param {Object} options
 * @param {string} options.fhirVersion
 * @param {string[]} options.packages - 'id#version'
 * @param {Object} options.packageManager - library/package-manager PackageManager
 * @param {string} options.cacheFolder
 */
async function loadDerived(options) {
  const key = crypto.createHash('sha256').update(JSON.stringify([DERIVED_FORMAT, options.fhirVersion, options.packages])).digest('hex').substring(0, 16);
  const cacheFile = path.join(options.cacheFolder, `rest-definitions-${key}.json`);
  if (fs.existsSync(cacheFile)) {
    try {
      return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    } catch (e) {
      // a broken cache file: derive again
    }
  }
  const folders = [];
  for (const p of options.packages) {
    const [id, version] = p.split('#');
    const name = await options.packageManager.fetch(id, version);
    folders.push(path.isAbsolute(name) ? name : path.join(options.packageManager.cacheFolder, name));
  }
  const derived = deriveDefinitions(folders, options.fhirVersion);
  fs.mkdirSync(options.cacheFolder, { recursive: true });
  const tmp = cacheFile + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(derived));
  fs.renameSync(tmp, cacheFile);
  return derived;
}

// Bumped when what resolve() finds changes, so the parameters that use it are reindexed (2: it
// finds contained resources, '#id')
const RESOLVE_VERSION = 2;

function hashOf(sp) {
  const parts = [sp.type, [...(sp.base || [])].sort(), sp.expression, sp.component || [], [...(sp.target || [])].sort()];
  if (/resolve\s*\(/.test(JSON.stringify([sp.expression, sp.component || []]))) {
    parts.push(RESOLVE_VERSION);
  }
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').substring(0, 32);
}

/**
 * An endpoint's definitions, ready to use: search parameters by type and code with their
 * compiled expressions, compartments, resource types, summary and mandatory elements.
 */
class Definitions {
  /**
   * @param {Object} derived - from deriveDefinitions / loadDerived (or a test fixture)
   * @param {Object[]} [custom] - custom SearchParameter resources stored on the endpoint
   * @param {function(string, string)} [log] - (level, message)
   */
  constructor(derived, custom = [], log = () => {}) {
    this.fhirVersion = derived.fhirVersion;
    this.model = modelFor(derived.fhirVersion);
    const fp = fhirpathOptions(this.model);
    this.ResourceNode = fp.ResourceNode;
    this.fhirpathOptions = fp.options;
    this.resourceTypes = new Set(derived.resourceTypes);
    // converting to and from XML (null: definitions derived before XML was supported)
    this.xml = derived.xml ? new XmlModel(derived.xml) : null;
    this.summary = new Map(Object.entries(derived.summary || {}).map(([k, v]) => [k, new Set(v)]));
    this.mandatory = new Map(Object.entries(derived.mandatory || {}).map(([k, v]) => [k, new Set(v)]));
    this.byUrl = new Map();
    this.byType = new Map(); // type -> Map(code -> def)
    this.problems = [];
    this.compiled = new Map();
    for (const sp of [...derived.searchParameters, ...custom.map(slimSearchParameter)]) {
      this.add(sp, log);
    }
    // compartments: compType -> Map(resourceType -> [param codes])
    this.compartments = new Map();
    const chosen = new Map();
    for (const c of derived.compartments || []) {
      // a package can carry examples with the same code (R4 has one for Device): the
      // specification's own definition wins
      const canonical = c.url === `http://hl7.org/fhir/CompartmentDefinition/${String(c.code).toLowerCase()}`;
      const prior = chosen.get(c.code);
      if (!prior || (canonical && !prior.canonical)) {
        chosen.set(c.code, { canonical, c });
      }
    }
    for (const { c } of chosen.values()) {
      const m = new Map();
      for (const r of c.resource) {
        if (r.param && r.param.length) {
          m.set(r.code, r.param);
        }
      }
      this.compartments.set(c.code, m);
    }
  }

  add(sp, log) {
    if (!sp || !sp.url || !sp.code || !INDEXED_TYPES.has(sp.type) || SPECIAL_PARAMS.has(sp.code)) {
      return;
    }
    if (!sp.expression) {
      return;
    }
    if (/resolve\(\)/.test(sp.expression.replace(/\.where\(\s*resolve\(\)\s+is\s+[A-Za-z]+\s*\)/g, '').replace(/resolve\(\)\s+is\s+[A-Za-z]+/g, ''))) {
      const msg = `Search parameter ${sp.url} uses resolve() for more than the target's type, which can't be indexed: not used`;
      this.problems.push(msg);
      log('warn', msg);
      return;
    }
    const def = {
      url: sp.url, code: sp.code, type: sp.type, expression: sp.expression, base: sp.base || [], target: sp.target || [], description: sp.description || null,
      component: sp.component || [], hash: hashOf(sp), key: null, fn: null
    };
    try {
      // each branch of a top-level union on its own: fhirpath.js's union compares the values
      // (to drop duplicates), which fails on some (a Quantity with a comparator); the indexer
      // drops duplicate rows itself
      const parts = splitUnion(forEvaluation(sp.expression)).map(x => fhirpath.compile(x, this.model, this.fhirpathOptions));
      def.fn = parts.length === 1 ? parts[0] : (r, env) => parts.flatMap(f => f(r, env));
    } catch (e) {
      const msg = `Search parameter ${sp.url}: the expression doesn't compile (${e.message.split('\n')[0]}): not used`;
      this.problems.push(msg);
      log('warn', msg);
      return;
    }
    // a later definition (an IG's) replaces an earlier one (the core's) with the same url
    this.byUrl.set(def.url, def);
    for (const base of def.base) {
      if (!this.byType.has(base)) {
        this.byType.set(base, new Map());
      }
      this.byType.get(base).set(def.code, def);
    }
  }

  /**
   * The search parameters for a resource type (its own, and Resource's and DomainResource's).
   * @param {string} type
   * @returns {Map<string, Object>} code -> definition
   */
  forType(type) {
    const out = new Map();
    for (const base of ['Resource', 'DomainResource', type]) {
      const m = this.byType.get(base);
      if (m) {
        for (const [code, def] of m) {
          out.set(code, def);
        }
      }
    }
    return out;
  }

  /** A search parameter by type and code, or null */
  param(type, code) {
    return this.forType(type).get(code) || null;
  }

  /**
   * Evaluate an expression relative to a node (a composite's components).
   * @param {Object} node - a ResourceNode from an earlier evaluation
   * @param {string} expression
   */
  evaluateRelative(node, expression, resource) {
    const base = node.path || (node.getTypeInfo && node.getTypeInfo().name);
    const key = base + '|' + expression;
    let fn = this.compiled.get(key);
    if (!fn) {
      fn = fhirpath.compile({ base, expression: forEvaluation(expression) }, this.model, this.fhirpathOptions);
      this.compiled.set(key, fn);
    }
    // a component's expression can refer to the whole resource (%resource)
    return fn(node.data, resource ? { resource } : {});
  }

  /**
   * Give each definition its key from the SearchParams table. The master adds rows for new
   * definitions and marks changed ones for reindexing; a worker only reads.
   * @param {Object} db
   * @param {boolean} master
   * @param {boolean} hasResources - whether the endpoint has resources yet (if so, a new or
   *   changed definition needs a reindex)
   * @returns {Promise<{added: number, changed: number}>}
   */
  async sync(db, master, hasResources) {
    let added = 0;
    let changed = 0;
    if (master) {
      await db.write(async (q) => {
        const rows = await q.all('SELECT ParamKey, Url, Hash FROM SearchParams');
        const byUrl = new Map(rows.map(r => [r.Url, r]));
        for (const def of this.byUrl.values()) {
          const row = byUrl.get(def.url);
          if (!row) {
            await q.run('INSERT INTO SearchParams (Url, Code, Type, Bases, Expression, Hash, Reindex) VALUES (?, ?, ?, ?, ?, ?, ?)',
              [def.url, def.code, def.type, JSON.stringify(def.base), def.expression, def.hash, hasResources ? 1 : 0]);
            added++;
          } else if (row.Hash !== def.hash) {
            await q.run('UPDATE SearchParams SET Code = ?, Type = ?, Bases = ?, Expression = ?, Hash = ?, Reindex = 1 WHERE ParamKey = ?',
              [def.code, def.type, JSON.stringify(def.base), def.expression, def.hash, row.ParamKey]);
            changed++;
          }
        }
      });
    }
    const rows = await db.read(q => q.all('SELECT ParamKey, Url, Reindex FROM SearchParams'));
    const keys = new Map(rows.map(r => [r.Url, r]));
    this.reindexing = new Set();
    for (const def of this.byUrl.values()) {
      const row = keys.get(def.url);
      def.key = row ? Number(row.ParamKey) : null;
      if (row && row.Reindex) {
        this.reindexing.add(def.url);
      }
    }
    return { added, changed };
  }
}

module.exports = { CONTAINERS, forEvaluation, splitUnion, Definitions, deriveDefinitions, loadDerived, corePackage, majorMinor, referenceType, SPECIAL_PARAMS, modelFor, fhirpathOptions };
