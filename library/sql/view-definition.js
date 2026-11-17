//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * Prepares a ViewDefinition for the runner: checks its structure, compiles its FHIRPath
 * expressions, turns its constants into FHIRPath values and works out its columns.
 *
 * This is the structural part of core's Validator (org.hl7.fhir.r5.utils.sql.Validator) and no
 * more. The Java validator also type-checks every path against the FHIR definitions; that is not
 * done here - use the FHIR validator for it. So a column's type is the declared one, or none, and
 * mistakes that only type analysis finds show up (if at all) when the view runs.
 *
 * A view that cannot run throws a ViewDefinitionError listing every problem found.
 */

const fhirpath = require('fhirpath');
const { FP_Date, FP_DateTime, FP_Instant, FP_Time, FP_Decimal_Native } = require('fhirpath/src/types.js');
const { Column } = require('./model');

const SQL_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

const VIEW_PROPERTIES = ['resourceType', 'resourceDefinition', 'id', 'meta', 'implicitRules', 'language', 'text',
  'contained', 'extension', 'modifierExtension', 'url', 'identifier', 'version', 'versionAlgorithmString',
  'versionAlgorithmCoding', 'name', 'title', 'status', 'experimental', 'date', 'publisher', 'contact', 'description',
  'useContext', 'jurisdiction', 'purpose', 'copyright', 'copyrightLabel', 'approvalDate', 'lastReviewDate',
  'effectivePeriod', 'topic', 'author', 'editor', 'reviewer', 'endorser', 'relatedArtifact', 'resource', 'profile',
  'fhirVersion', 'constant', 'select', 'where'];
const SELECT_PROPERTIES = ['id', 'extension', 'modifierExtension', 'column', 'select', 'forEach', 'forEachOrNull', 'repeat', 'unionAll'];
const COLUMN_PROPERTIES = ['id', 'extension', 'modifierExtension', 'path', 'name', 'description', 'collection', 'type', 'tag'];
const WHERE_PROPERTIES = ['id', 'extension', 'modifierExtension', 'path', 'description'];

// The JSON type each constant value[x] must have, and how it becomes a FHIRPath value.
// FHIRPath date/time types need a context object; only getDecimal is ever used from it.
const FP_CONTEXT = { getDecimal: FP_Decimal_Native.getDecimal };
const CONSTANT_TYPES = {
  valueBase64Binary: ['string', v => v],
  valueBoolean: ['boolean', v => v],
  valueCanonical: ['string', v => v],
  valueCode: ['string', v => v],
  valueDate: ['string', v => checkedTime(FP_Date, v, 'date')],
  valueDateTime: ['string', v => checkedTime(FP_DateTime, v, 'dateTime')],
  valueDecimal: ['number', v => v],
  valueId: ['string', v => v],
  valueInstant: ['string', v => checkedTime(FP_Instant, v, 'instant')],
  valueInteger: ['number', v => checkedInteger(v)],
  valueInteger64: ['number', v => checkedInteger(v)],
  valueOid: ['string', v => v],
  valueString: ['string', v => v],
  valuePositiveInt: ['number', v => checkedInteger(v)],
  valueTime: ['string', v => checkedTime(FP_Time, v, 'time')],
  valueUnsignedInt: ['number', v => checkedInteger(v)],
  valueUri: ['string', v => v],
  valueUrl: ['string', v => v],
  valueUuid: ['string', v => v]
};

function checkedTime(cls, v, type) {
  const t = cls.checkString(FP_CONTEXT, v);
  if (!t) {
    throw new Error(`'${v}' is not a valid ${type}`);
  }
  return t;
}

function checkedInteger(v) {
  if (!Number.isInteger(v)) {
    throw new Error(`${v} is not an integer`);
  }
  return v;
}

class ViewDefinitionError extends Error {
  constructor(issues) {
    super('View Definition is not valid: ' + issues.map(i => `${i.path}: ${i.message}`).join('; '));
    this.name = 'ViewDefinitionError';
    this.issues = issues;
  }
}

/**
 * The prepared form of a ViewDefinition. Expressions are compiled once, here.
 */
class PreparedView {
  constructor(source) {
    this.source = source;
    this.name = null;
    this.resourceName = null;
    this.constants = {}; // name -> FHIRPath value, passed to every evaluation as environment variables
    this.where = []; // { path, fn }
    this.selects = []; // PreparedSelect
    this.columns = []; // the view's columns, in output order
  }
}

class PreparedSelect {
  constructor(source) {
    this.source = source;
    this.forEach = null; // compiled expression
    this.forEachOrNull = null;
    this.repeat = null; // [compiled expression]
    this.columns = []; // { column: Column, fn }
    this.selects = [];
    this.unionAll = []; // PreparedSelect
    this.allColumns = []; // every column under this select, in output order
  }
}

/**
 * @param {Object} viewDefinition - the ViewDefinition, as JSON
 * @param {Object} options
 * @param {Object} options.model - the fhirpath.js model (e.g. require('fhirpath/fhir-context/r4'))
 * @param {Object} [options.fhirpathOptions] - options for fhirpath.compile (userInvocationTable, async...)
 * @param {boolean} [options.needsName] - whether the storage needs the view to have a name
 * @param {string} [options.path] - the path of the view, for messages
 * @returns {PreparedView}
 */
function prepareView(viewDefinition, options) {
  const preparer = new Preparer(options);
  const view = preparer.prepare(viewDefinition, options.path || 'ViewDefinition');
  if (preparer.issues.length > 0) {
    throw new ViewDefinitionError(preparer.issues);
  }
  return view;
}

class Preparer {
  constructor(options) {
    this.model = options.model;
    this.fhirpathOptions = options.fhirpathOptions || {};
    this.needsName = !!options.needsName;
    this.issues = [];
  }

  error(path, message) {
    this.issues.push({ path, message });
  }

  compile(path, expression) {
    try {
      return fhirpath.compile(expression, this.model, { ...this.fhirpathOptions, resolveInternalTypes: false });
    } catch (e) {
      this.error(path, `Invalid FHIRPath expression '${expression}': ${e.message}`);
      return null;
    }
  }

  checkProperties(obj, path, names) {
    for (const key of Object.keys(obj)) {
      if (!names.includes(key)) {
        this.error(path + '.' + key, 'Unknown JSON property ' + key);
      }
    }
  }

  /** Returns the array at obj[name] when it is an array of objects; reports it and returns null otherwise. */
  objects(obj, path, name) {
    const a = obj[name];
    if (a === undefined) {
      return [];
    }
    if (!Array.isArray(a)) {
      this.error(path + '.' + name, name + ' must be an array');
      return null;
    }
    let ok = true;
    a.forEach((e, i) => {
      if (!isObject(e)) {
        this.error(`${path}.${name}[${i}]`, `${name}[${i}] must be an object`);
        ok = false;
      }
    });
    return ok ? a : null;
  }

  prepare(vd, path) {
    const view = new PreparedView(vd);
    if (!isObject(vd)) {
      this.error(path, 'The ViewDefinition must be a JSON object');
      return view;
    }
    this.checkProperties(vd, path, VIEW_PROPERTIES);

    if (vd.name === undefined) {
      if (this.needsName) {
        this.error(path, 'No name provided');
      }
    } else if (typeof vd.name !== 'string') {
      this.error(path + '.name', 'name must be a string');
    } else if (!SQL_NAME.test(vd.name)) {
      this.error(path + '.name', `The name '${vd.name}' is not valid`);
    } else {
      view.name = vd.name;
    }

    if (vd.resource === undefined) {
      this.error(path, 'No resource specified');
      return view;
    }
    if (typeof vd.resource !== 'string') {
      this.error(path + '.resource', 'resource must be a string');
      return view;
    }
    if (!this.isResourceType(vd.resource)) {
      this.error(path + '.resource', `The resource '${vd.resource}' is not a valid resource type`);
      return view;
    }
    view.resourceName = vd.resource;

    const constants = this.objects(vd, path, 'constant');
    (constants || []).forEach((c, i) => this.prepareConstant(view, `${path}.constant[${i}]`, c));

    const wheres = this.objects(vd, path, 'where');
    (wheres || []).forEach((w, i) => {
      const wpath = `${path}.where[${i}]`;
      this.checkProperties(w, wpath, WHERE_PROPERTIES);
      if (w.path === undefined) {
        this.error(wpath, 'No path provided');
      } else if (typeof w.path !== 'string') {
        this.error(wpath + '.path', 'path must be a string');
      } else {
        const fn = this.compile(wpath + '.path', w.path);
        if (fn) {
          view.where.push({ path: w.path, fn });
        }
      }
    });

    const selects = this.objects(vd, path, 'select');
    if (selects) {
      if (selects.length === 0) {
        this.error(path, 'No select statements found');
      }
      selects.forEach((s, i) => {
        const ps = this.prepareSelect(`${path}.select[${i}]`, s);
        view.selects.push(ps);
        view.columns.push(...ps.allColumns);
      });
      this.checkColumnNamesUnique(path, view.columns);
    }
    return view;
  }

  isResourceType(name) {
    const t2p = this.model && this.model.type2Parent;
    if (!t2p) {
      return /^[A-Z][A-Za-z]+$/.test(name);
    }
    // a resource type is one whose ancestry reaches Resource
    let t = name;
    for (let i = 0; i < 10 && t; i++) {
      if (t === 'Resource') {
        return true;
      }
      t = t2p[t];
    }
    return false;
  }

  prepareConstant(view, path, constant) {
    this.checkProperties(constant, path, ['id', 'extension', 'modifierExtension', 'name', ...Object.keys(CONSTANT_TYPES)]);
    let name = null;
    if (constant.name === undefined) {
      this.error(path, 'No name provided');
    } else if (typeof constant.name !== 'string') {
      this.error(path, 'Name must be a string');
    } else if (!SQL_NAME.test(constant.name)) {
      this.error(path + '.name', `The name '${constant.name}' is not valid`);
    } else {
      name = constant.name;
    }
    const props = Object.keys(constant).filter(k => k.startsWith('value'));
    if (props.length === 0) {
      this.error(path, 'No value found');
      return;
    }
    if (props.length > 1) {
      this.error(path, 'Only one value is allowed');
      return;
    }
    const prop = props[0];
    const def = CONSTANT_TYPES[prop];
    if (!def) {
      return; // already reported as an unknown property
    }
    const v = constant[prop];
    if (typeof v !== def[0]) {
      this.error(`${path}.${prop}`, `${prop} must be a ${def[0]}`);
      return;
    }
    try {
      const value = def[1](v);
      if (name) {
        view.constants[name] = value;
      }
    } catch (e) {
      this.error(`${path}.${prop}`, `Invalid value for ${prop}: ${e.message}`);
    }
  }

  prepareSelect(path, select) {
    const ps = new PreparedSelect(select);
    this.checkProperties(select, path, SELECT_PROPERTIES);

    const iterators = ['forEach', 'forEachOrNull', 'repeat'].filter(n => select[n] !== undefined);
    if (iterators.length > 1) {
      this.error(path, 'Only one of forEach, forEachOrNull, or repeat may be specified on a select');
    }
    if (select.forEach !== undefined) {
      ps.forEach = this.prepareIterator(path + '.forEach', select.forEach, 'forEach');
    } else if (select.forEachOrNull !== undefined) {
      ps.forEachOrNull = this.prepareIterator(path + '.forEachOrNull', select.forEachOrNull, 'forEachOrNull');
    } else if (select.repeat !== undefined) {
      ps.repeat = this.prepareRepeat(path + '.repeat', select.repeat);
    }

    if (select.column !== undefined) {
      if (!Array.isArray(select.column)) {
        this.error(path + '.column', 'column is not an array');
      } else {
        select.column.forEach((c, i) => {
          const cpath = `${path}.column[${i}]`;
          if (!isObject(c)) {
            this.error(cpath, `column[${i}] is not an object`);
          } else {
            const pc = this.prepareColumn(cpath, c);
            if (pc) {
              ps.columns.push(pc);
              ps.allColumns.push(pc.column);
            }
          }
        });
      }
    }

    const subs = this.objects(select, path, 'select');
    (subs || []).forEach((s, i) => {
      const sub = this.prepareSelect(`${path}.select[${i}]`, s);
      ps.selects.push(sub);
      ps.allColumns.push(...sub.allColumns);
    });

    if (select.unionAll !== undefined) {
      ps.allColumns.push(...this.prepareUnion(path + '.unionAll', select.unionAll, ps));
    }

    if (ps.allColumns.length === 0 && this.issues.length === 0) {
      this.error(path, 'The select has no columns or selects');
    } else {
      this.checkColumnNamesUnique(path, ps.allColumns);
    }
    return ps;
  }

  prepareIterator(path, expression, name) {
    if (typeof expression !== 'string') {
      this.error(path, name + ' is not a string');
      return null;
    }
    return this.compile(path, expression);
  }

  prepareRepeat(path, repeat) {
    if (!Array.isArray(repeat) || repeat.length === 0) {
      this.error(path, 'repeat must be a non-empty array of strings');
      return null;
    }
    const result = [];
    repeat.forEach((e, i) => {
      if (typeof e !== 'string') {
        this.error(`${path}[${i}]`, `repeat[${i}] is not a string`);
      } else {
        const fn = this.compile(`${path}[${i}]`, e);
        if (fn) {
          result.push(fn);
        }
      }
    });
    return result;
  }

  /** Returns the columns the union contributes: the first branch's, once the others are checked against them. */
  prepareUnion(path, unionAll, ps) {
    if (!Array.isArray(unionAll)) {
      this.error(path, 'unionAll is not an array');
      return [];
    }
    const branchColumns = [];
    unionAll.forEach((u, i) => {
      if (!isObject(u)) {
        this.error(`${path}[${i}]`, `unionAll[${i}] is not an object`);
      } else {
        const branch = this.prepareSelect(`${path}[${i}]`, u);
        ps.unionAll.push(branch);
        branchColumns.push({ index: i, columns: branch.allColumns });
      }
    });
    if (branchColumns.length === 0) {
      return [];
    }
    const first = branchColumns[0].columns;
    for (const b of branchColumns.slice(1)) {
      const diff = columnDiffs(first, b.columns);
      if (diff) {
        this.error(`${path}[${b.index}]`, `unionAll[${b.index}] column definitions do not match: ${diff}`);
      }
    }
    return first;
  }

  prepareColumn(path, column) {
    this.checkProperties(column, path, COLUMN_PROPERTIES);
    if (column.path === undefined) {
      this.error(path, 'no path found');
      return null;
    }
    if (typeof column.path !== 'string') {
      this.error(path + '.path', 'path is not a string');
      return null;
    }
    const fn = this.compile(path + '.path', column.path);
    if (column.name === undefined) {
      this.error(path, 'A column name is required');
      return null;
    }
    if (typeof column.name !== 'string') {
      this.error(path + '.name', 'name must be a string');
      return null;
    }
    if (!SQL_NAME.test(column.name)) {
      this.error(path + '.name', `The name '${column.name}' is not valid`);
      return null;
    }
    if (column.collection !== undefined && typeof column.collection !== 'boolean') {
      this.error(path + '.collection', 'collection is not a boolean');
    }
    if (column.type !== undefined && typeof column.type !== 'string') {
      this.error(path + '.type', 'type must be a string');
    }
    const col = new Column(column.name, column.collection === true, typeof column.type === 'string' ? column.type : null);
    if (typeof column.description === 'string') {
      col.description = column.description;
    }
    if (Array.isArray(column.tag)) {
      col.tags = column.tag.filter(t => isObject(t) && typeof t.name === 'string')
        .map(t => ({ name: t.name, value: t.value }));
    }
    return fn ? { column: col, fn, path: column.path } : null;
  }

  /**
   * Column names must be unique ignoring case: SQL identifiers are case-insensitive on most
   * targets, and cells are merged by name ignoring case.
   */
  checkColumnNamesUnique(path, columns) {
    const names = new Map();
    for (const col of columns) {
      const key = col.name.toLowerCase();
      const existing = names.get(key);
      if (existing === undefined) {
        names.set(key, col);
      } else if (existing !== col && !col.duplicateReported) {
        col.duplicateReported = true;
        const note = existing.name === col.name ? '' : ` (matches '${existing.name}' ignoring case)`;
        this.error(path, `Duplicate Column Name '${col.name}'${note}`);
      }
    }
  }
}

function columnDiffs(list1, list2) {
  if (list1.length !== list2.length) {
    return `Column counts differ: ${list1.length} vs ${list2.length}`;
  }
  for (let i = 0; i < list1.length; i++) {
    const diff = list1[i].diff(list2[i]);
    if (diff) {
      return `${diff} at #${i}`;
    }
  }
  return null;
}

function isObject(o) {
  return o !== null && typeof o === 'object' && !Array.isArray(o);
}

module.exports = { prepareView, ViewDefinitionError, PreparedView, PreparedSelect };
