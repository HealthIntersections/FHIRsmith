//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * Runs SQL on FHIR ViewDefinitions (https://sql-on-fhir.org) over FHIR resources, producing rows
 * in a storage (JSON, SQLite, CSV, or one of your own). A port of the Runner in org.hl7.fhir.core
 * (org.hl7.fhir.r5.utils.sql.Runner), built on fhirpath.js.
 *
 * The runner is given:
 *   - a model: the fhirpath.js model for the FHIR version of the resources
 *     (require('fhirpath/fhir-context/r4'), .../r5...)
 *   - a provider: where the resources come from, and how references are resolved
 *       fetch(resourceType) -> array | iterable | async iterable (or a promise of one)
 *       resolveReference(rootResource, reference, resourceType) -> resource | null (or a promise,
 *         when the runner is async). rootResource is the resource being processed, so contained
 *         (#id) and Bundle-local references can be resolved.
 *   - a storage: where the rows go (see storage-json.js for the interface)
 *
 * Then either run a view as a batch:
 *     await runner.execute(viewDefinition)
 * or trickle resources through it:
 *     const wc = runner.prepare(viewDefinition);
 *     for (...) await runner.processResource(wc, resource);
 *     await runner.finish(wc);
 *
 * Resources are plain FHIR JSON. The ViewDefinition is checked for structure, not types (see
 * view-definition.js). Every evaluation is awaited, so FHIRPath functions that answer
 * asynchronously (the IPS module's value set functions, say) can be used by passing them in
 * userInvocationTable with async: true.
 */

const { ResourceNode, FP_DateTime, FP_Date, FP_Instant } = require('fhirpath/src/types.js');
const fhirpathMath = require('fhirpath/src/math.js');
const { prepareView } = require('./view-definition');
const { Cell, toValue, valueForColumn } = require('./model');

class Runner {
  /**
   * @param {Object} options
   * @param {Object} options.model - the fhirpath.js model
   * @param {Object} options.provider - see above
   * @param {Object} options.storage - see storage-json.js
   * @param {Object} [options.userInvocationTable] - more FHIRPath functions, as for fhirpath.js
   * @param {boolean|string} [options.async] - passed to fhirpath.js: true when any function may answer with a promise
   * @param {number} [options.maxRepeatDepth=100] - how deep a repeat may go (guards against cyclical repeat paths such as $this)
   * @param {number} [options.maxRepeatNodes=100000] - how many nodes a repeat may collect (guards against paths such as descendants())
   * @param {function} [options.observer] - called with (resource, total, cursor) as each resource is processed
   */
  constructor(options) {
    if (!options || !options.model) {
      throw new Error('No model provided');
    }
    this.model = options.model;
    this.provider = options.provider || null;
    this.storage = options.storage || null;
    this.extraFunctions = options.userInvocationTable || {};
    this.async = options.async || false;
    this.observer = options.observer || null;
    this.setMaxRepeatDepth(options.maxRepeatDepth || 100);
    this.setMaxRepeatNodes(options.maxRepeatNodes || 100000);

    // Per-evaluation state. The FHIRPath functions below receive the environment variables of
    // the evaluation that calls them (this.vars); each ExecutionContext makes its own, and this
    // maps them back to it.
    this.contexts = new WeakMap();
    // getReferenceKey() keys, per reference and type specifier: the same Reference can be asked
    // for getReferenceKey(), getReferenceKey(Patient) and getReferenceKey(Observation) in one
    // view, and those need not resolve to the same target - or to a target at all.
    this.referenceKeys = new WeakMap();
    this.resourceKeys = new WeakMap();
    this.resCount = 0;
  }

  setMaxRepeatDepth(value) {
    if (!(value >= 1)) {
      throw new Error('maxRepeatDepth must be at least 1');
    }
    this.maxRepeatDepth = value;
  }

  setMaxRepeatNodes(value) {
    if (!(value >= 1)) {
      throw new Error('maxRepeatNodes must be at least 1');
    }
    this.maxRepeatNodes = value;
  }

  fhirpathOptions() {
    const runner = this;
    const table = { ...this.extraFunctions };
    table.getResourceKey = {
      fn: function (inputs) {
        return runner.executeResourceKey(runner.contexts.get(this.vars), inputs);
      },
      arity: { 0: [] },
      internalStructures: true
    };
    table.getReferenceKey = {
      fn: function (inputs, type) {
        return runner.executeReferenceKey(runner.contexts.get(this.vars), inputs, type);
      },
      arity: { 0: [], 1: ['TypeSpecifier'] },
      internalStructures: true
    };
    table.lowBoundary = boundaryFunction('lowBoundary', '+14:00');
    table.highBoundary = boundaryFunction('highBoundary', '-12:00');
    const options = { userInvocationTable: table };
    if (this.async) {
      options.async = this.async;
    }
    return options;
  }

  /**
   * Checks and compiles a view and creates its store. Throws a ViewDefinitionError if the view
   * cannot run.
   * @returns {Object} the work context, for processResource and finish
   */
  prepare(viewDefinition, path) {
    if (!this.storage) {
      throw new Error('No storage provided');
    }
    if (!viewDefinition) {
      throw new Error('No viewDefinition provided');
    }
    const view = prepareView(viewDefinition, {
      model: this.model,
      fhirpathOptions: this.fhirpathOptions(),
      needsName: !!this.storage.needsName,
      path: path || 'ViewDefinition'
    });
    const store = this.storage.createStore(view.name, view.columns);
    return { view, store };
  }

  /**
   * Runs a view over everything the provider has of its resource type.
   */
  async execute(viewDefinition, path) {
    if (!this.provider) {
      throw new Error('No provider provided');
    }
    const wc = this.prepare(viewDefinition, path);
    let ok = false;
    try {
      const data = await this.provider.fetch(wc.view.resourceName);
      const total = Array.isArray(data) ? data.length : -1;
      let i = 0;
      for await (const resource of data) {
        if (this.observer) {
          this.observer(resource, total, i);
        }
        await this.processRows(wc, resource);
        i++;
      }
      ok = true;
    } finally {
      await this.finish(wc, ok);
    }
  }

  /**
   * Trickle mode: processes one resource. A resource of another type than the view's produces no rows.
   */
  async processResource(wc, resource) {
    if (this.observer) {
      this.observer(resource, -1, this.resCount);
    }
    await this.processRows(wc, resource);
    this.resCount++;
    if (wc.store && typeof wc.store.flush === 'function') {
      await wc.store.flush();
    }
  }

  /**
   * @param {Object} wc - the work context from prepare
   * @param {boolean} [ok=true] - false when the run failed, so a storage can discard what it has
   */
  async finish(wc, ok = true) {
    await this.storage.finish(wc.store, ok);
  }

  async processRows(wc, resource) {
    const view = wc.view;
    // Spec, "Process a Resource" step 1: a resource of another type emits nothing. Batch mode
    // fetches by type, but trickle mode hands over whatever the caller has.
    if (!resource || resource.resourceType !== view.resourceName) {
      return;
    }
    // The resource is row 0 of its own scope: %rowIndex is 0 until a select starts iterating.
    const ctx = this.newContext(view, resource, 0);
    for (const w of view.where) {
      if (!this.asBoolean(w, await this.evaluate(ctx, resource, w.fn))) {
        return;
      }
    }
    let rows = [new Map()];
    for (const select of view.selects) {
      rows = await this.executeSelect(ctx, select, resource, rows);
    }
    for (const row of rows) {
      await this.storage.addRow(wc.store, view.columns.map(c => row.get(c.name.toLowerCase()) || new Cell(c)));
    }
  }

  asBoolean(where, result) {
    if (result.length === 0) {
      return false;
    }
    if (result.length > 1 || typeof result[0] !== 'boolean') {
      const v = toValue(result[0]);
      if (result.length === 1 && v && v.kind === 'boolean') {
        return v.value;
      }
      throw new Error(`A where path must return a boolean, but the expression ${where.path} returned ${describe(result)}`);
    }
    return result[0];
  }

  newContext(view, root, rowIndex) {
    const vars = { ...view.constants, rowIndex };
    const ctx = { view, root, rowIndex, vars };
    this.contexts.set(vars, ctx);
    return ctx;
  }

  withRowIndex(ctx, rowIndex) {
    return this.newContext(ctx.view, ctx.root, rowIndex);
  }

  async evaluate(ctx, focus, fn) {
    // focus is a resource, a node from an earlier evaluation, or null for the synthetic row of an
    // empty forEachOrNull - which still evaluates, so %rowIndex resolves and paths give nothing
    const result = await fn(focus === null ? [] : focus, ctx.vars);
    return Array.isArray(result) ? result : [result];
  }

  /**
   * Rows are Maps of lower-case column name -> Cell. Returns the rows after this select.
   */
  async executeSelect(ctx, select, focusBase, rows) {
    let focus;
    // An iterating select opens a new %rowIndex scope, numbering the elements it produces. A
    // select without one leaves the enclosing scope in place.
    let iterates = true;
    if (select.forEach) {
      focus = await this.evaluate(ctx, focusBase, select.forEach);
    } else if (select.forEachOrNull) {
      focus = await this.evaluate(ctx, focusBase, select.forEachOrNull);
      // One synthetic null row when the collection is empty, so %rowIndex still resolves to 0 and
      // other paths give null cells
      if (focus.length === 0) {
        focus = [null];
      }
    } else if (select.repeat) {
      // the index runs over the flattened traversal, not over each level of it
      focus = await this.executeRepeat(ctx, select, focusBase);
    } else {
      iterates = false;
      focus = [focusBase];
    }

    const result = [];
    let idx = 0;
    for (const f of focus) {
      const fctx = iterates ? this.withRowIndex(ctx, idx) : ctx;
      let rowsToAdd = rows.map(cloneRow);

      for (const column of select.columns) {
        await this.executeColumn(fctx, column, f, rowsToAdd);
      }

      if (f !== null) {
        for (const sub of select.selects) {
          rowsToAdd = await this.executeSelect(fctx, sub, f, rowsToAdd);
        }
        rowsToAdd = await this.executeUnionAll(fctx, select.unionAll, f, rowsToAdd);
      } else {
        // The synthetic null row of an empty forEachOrNull does not descend into nested selects or
        // unions: they would clear the pending rows and add nothing back, swallowing the null row.
        // Instead every column declared under this select gets a null cell.
        for (const row of rowsToAdd) {
          for (const c of select.allColumns) {
            const key = c.name.toLowerCase();
            if (!row.has(key)) {
              row.set(key, new Cell(c));
            }
          }
        }
      }
      result.push(...rowsToAdd);
      idx++;
    }
    return result;
  }

  async executeUnionAll(ctx, unionList, focus, rows) {
    if (unionList.length === 0) {
      return rows;
    }
    const result = [];
    for (const union of unionList) {
      result.push(...await this.executeSelect(ctx, union, focus, rows));
    }
    return result;
  }

  /**
   * Collects the nodes matched by the repeat directive, depth-first. The root node is not
   * included; a node reached by more than one path is added once per path, as in the spec
   * algorithm and the reference implementation. Recursion is bounded so that a cyclical path such
   * as $this, or a path whose output grows exponentially with depth such as descendants(), fails
   * rather than running away.
   */
  async executeRepeat(ctx, select, focus) {
    const result = [];
    if (select.repeat && focus !== null) {
      await this.expandRepeat(ctx, focus, select.repeat, result, 0);
    }
    return result;
  }

  async expandRepeat(ctx, b, fns, result, depth) {
    if (depth >= this.maxRepeatDepth) {
      throw new Error(`ViewDefinition repeat reached the maximum nesting depth of ${this.maxRepeatDepth}; ` +
        'the repeat expressions are likely cyclical (for example, a path that matches its own result)');
    }
    for (const fn of fns) {
      for (const child of await this.evaluate(ctx, b, fn)) {
        if (result.length >= this.maxRepeatNodes) {
          throw new Error(`ViewDefinition repeat produced more than ${this.maxRepeatNodes} nodes; ` +
            'constrain the repeat expressions or raise the configured limit');
        }
        result.push(child);
        await this.expandRepeat(ctx, child, fns, result, depth + 1);
      }
    }
  }

  async executeColumn(ctx, pc, focus, rows) {
    const values = [];
    for (const item of await this.evaluate(ctx, focus, pc.fn)) {
      const v = toValue(item);
      if (v) {
        values.push(valueForColumn(pc.column, v));
      }
    }
    const key = pc.column.name.toLowerCase();
    for (const row of rows) {
      let cell = row.get(key);
      if (!cell) {
        cell = new Cell(pc.column);
        row.set(key, cell);
      }
      if (values.length > 0) {
        if (values.length + cell.values.length > 1 && !cell.column.collection) {
          throw new Error(`The column ${cell.column.name} is not allowed multiple values, but at least one row has multiple values`);
        }
        cell.values.push(...values);
      }
    }
  }

  // --- getResourceKey() and getReferenceKey() ----------------------------------------------

  executeResourceKey(ctx, inputs) {
    const result = [];
    for (const node of inputs) {
      const res = dataOf(node);
      if (res && typeof res === 'object') {
        let key = this.resourceKeys.get(res);
        if (key === undefined) {
          key = this.storage.getKeyForSourceResource(res, ctx ? ctx.root : null);
          if (key === null || key === undefined) {
            throw new Error(`Unidentified resource: ${res.resourceType}/${res.id}`);
          }
          this.resourceKeys.set(res, key);
        }
        result.push(key);
      }
    }
    return result;
  }

  executeReferenceKey(ctx, inputs, type) {
    let rt = type ? (type.name || String(type)) : null;
    if (rt && rt.startsWith('FHIR.')) {
      rt = rt.substring(5);
    }
    const root = ctx ? ctx.root : null;
    const keys = [];
    let pending = false;
    for (const node of inputs) {
      const data = dataOf(node);
      let ref;
      let cacheOn = null;
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        ref = typeof data.reference === 'string' ? data.reference : null;
        cacheOn = data;
      } else if (typeof data === 'string') {
        ref = data;
      } else {
        throw new Error('Unable to generate a reference key based on a ' + describe([node]));
      }
      if (!ref) {
        continue;
      }
      const slot = rt || '';
      const cache = cacheOn ? this.referenceKeys.get(cacheOn) : null;
      if (cache && cache.has(slot)) {
        const k = cache.get(slot);
        if (k !== null) {
          keys.push(k);
        }
        continue;
      }
      const target = this.provider ? this.provider.resolveReference(root, ref, rt) : null;
      const finish = (t) => {
        const k = t ? this.storage.getKeyForTargetResource(t, root) : null;
        if (t && (k === null || k === undefined)) {
          throw new Error(`Unidentified resource: ${t.resourceType}/${t.id}`);
        }
        if (cacheOn) {
          let c = this.referenceKeys.get(cacheOn);
          if (!c) {
            c = new Map();
            this.referenceKeys.set(cacheOn, c);
          }
          c.set(slot, k);
        }
        return k;
      };
      if (target && typeof target.then === 'function') {
        pending = true;
        keys.push(target.then(finish));
      } else {
        const k = finish(target);
        if (k !== null) {
          keys.push(k);
        }
      }
    }
    if (pending) {
      return Promise.all(keys).then(list => list.filter(k => k !== null && k !== undefined));
    }
    return keys;
  }
}

/**
 * lowBoundary() and highBoundary(), as fhirpath.js does them, except that the boundary of a
 * dateTime with no timezone gets the widest offset (+14:00 for the low boundary, -12:00 for the
 * high one), as the shared SQL on FHIR tests and the Java runner have it. fhirpath.js leaves the
 * offset off.
 */
function boundaryFunction(name, offset) {
  return {
    fn: function (inputs, precision) {
      const result = fhirpathMath[name].call(this, inputs, precision);
      const values = Array.isArray(result) ? result : [result];
      return values.map(v => {
        if (v instanceof FP_DateTime && !(v instanceof FP_Date) && !(v instanceof FP_Instant)) {
          const s = v.toString();
          if (s.includes('T') && !/(Z|[+-]\d\d:\d\d)$/.test(s)) {
            return new FP_DateTime(this, s + offset);
          }
        }
        return v;
      });
    },
    arity: { 0: [], 1: ['Integer'] },
    internalStructures: true
  };
}

function dataOf(node) {
  return node instanceof ResourceNode ? node.data : node;
}

function cloneRow(row) {
  const r = new Map();
  for (const [k, cell] of row) {
    r.set(k, cell.copy());
  }
  return r;
}

function describe(result) {
  return result.map(r => {
    const v = toValue(r);
    return v ? `${v.type} ${typeof v.value === 'object' ? JSON.stringify(v.value) : v.value}` : String(r);
  }).join(', ') || 'nothing';
}

module.exports = { Runner };
