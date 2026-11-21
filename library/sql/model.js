//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * The data model shared by the SQL on FHIR runner and its storages: columns, the cells of a row,
 * and the values in them. A port of Column, Cell, Value and ColumnKind from org.hl7.fhir.core
 * (org.hl7.fhir.r5.utils.sql).
 */

const { FP_Type, FP_Date, FP_DateTime, FP_Instant, FP_Time, FP_Quantity, ResourceNode } = require('fhirpath/src/types.js');

/**
 * The storage family of a column or value. A storage decides how to hold a value by its kind;
 * the FHIR type is kept too, for storages that care about the difference between (say) a date
 * and an instant.
 */
const ColumnKind = Object.freeze({
  Null: 'null',
  DateTime: 'dateTime',
  Boolean: 'boolean',
  Integer: 'integer',
  Decimal: 'decimal',
  String: 'string',
  Time: 'time',
  Binary: 'binary',
  Complex: 'complex'
});

const SYSTEM_TYPES = {
  String: 'string',
  Boolean: 'boolean',
  Integer: 'integer',
  Decimal: 'decimal',
  Date: 'date',
  DateTime: 'dateTime',
  Time: 'time',
  Quantity: 'Quantity'
};

/**
 * Reduces a type name (FHIR.code, System.String, a declared column type) to a bare FHIR type name.
 */
function typeName(type) {
  if (!type) {
    return type;
  }
  if (type.startsWith('System.')) {
    const n = type.substring(7);
    return SYSTEM_TYPES[n] || n;
  }
  if (type.startsWith('FHIR.')) {
    return type.substring(5);
  }
  if (type.startsWith('http://hl7.org/fhir/StructureDefinition/')) {
    type = type.substring(40);
  }
  const hash = type.indexOf('#');
  return hash < 0 ? type : type.substring(hash + 1);
}

/**
 * The storage kind for a FHIR type (the Java runner's simpleType + kindForType).
 */
function kindForType(type) {
  switch (typeName(type)) {
    case 'null':
      return ColumnKind.Null;
    case 'date':
    case 'dateTime':
    case 'instant':
      return ColumnKind.DateTime;
    case 'boolean':
      return ColumnKind.Boolean;
    case 'integer':
    case 'integer64':
    case 'positiveInt':
    case 'unsignedInt':
      return ColumnKind.Integer;
    case 'decimal':
      return ColumnKind.Decimal;
    case 'string':
    case 'code':
    case 'id':
    case 'oid':
    case 'uri':
    case 'url':
    case 'uuid':
    case 'canonical':
    case 'markdown':
    case 'sid':
      return ColumnKind.String;
    case 'time':
      return ColumnKind.Time;
    case 'base64Binary':
      return ColumnKind.Binary;
    default:
      return ColumnKind.Complex;
  }
}

class Column {
  /**
   * @param {string} name - the column name (a valid SQL name, unique in the view ignoring case)
   * @param {boolean} collection - whether the column may hold more than one value
   * @param {string|null} type - the declared FHIR type, or null when the view did not declare one
   */
  constructor(name, collection, type) {
    this.name = name;
    this.collection = !!collection;
    this.type = type || null;
    // With no declared type there is no kind: the runner does not infer types from paths (the
    // FHIR validator does that), so each value carries its own kind instead.
    this.kind = type ? kindForType(type) : null;
    this.description = null;
    this.tags = [];
  }

  /**
   * Describes the first difference that stops this column and another being the same column of a
   * unionAll, or returns null when they match. Types are compared only when both are declared.
   */
  diff(other) {
    if (this.name !== other.name) {
      return `Names differ: '${this.name}' vs '${other.name}'`;
    }
    if (this.type && other.type && typeName(this.type) !== typeName(other.type)) {
      return `Types differ: '${this.type}' vs '${other.type}'`;
    }
    if (this.collection !== other.collection) {
      return `Collection status differs: '${this.collection}' vs '${other.collection}'`;
    }
    return null;
  }
}

/**
 * One value in a cell. value is the JavaScript form: a string (for strings, codes, dates, times,
 * binaries), a number, a boolean, or an object for a complex type.
 */
class Value {
  constructor(kind, type, value) {
    this.kind = kind;
    this.type = type;
    this.value = value;
  }
}

class Cell {
  constructor(column) {
    this.column = column;
    this.values = [];
  }

  copy() {
    const cell = new Cell(this.column);
    cell.values.push(...this.values); // values are not changed once made
    return cell;
  }
}

/**
 * Converts one item of a FHIRPath result (evaluated with resolveInternalTypes: false) to a Value,
 * or returns null when there is no value (a primitive that has only extensions).
 */
function toValue(item) {
  if (item === null || item === undefined) {
    return null;
  }
  if (item instanceof ResourceNode) {
    const type = typeName(fhirTypeOf(item));
    const data = item.data;
    if (data === null || data === undefined) {
      return null;
    }
    const kind = kindForType(type);
    if (kind === ColumnKind.Complex) {
      return new Value(kind, type, data);
    }
    if (data instanceof FP_Type) {
      return toValue(data);
    }
    return new Value(kind, type, data);
  }
  if (item instanceof FP_Instant) {
    return new Value(ColumnKind.DateTime, 'instant', item.toString());
  }
  if (item instanceof FP_Date) {
    return new Value(ColumnKind.DateTime, 'date', item.toString());
  }
  if (item instanceof FP_DateTime) {
    return new Value(ColumnKind.DateTime, 'dateTime', item.toString());
  }
  if (item instanceof FP_Time) {
    return new Value(ColumnKind.Time, 'time', item.toString());
  }
  if (item instanceof FP_Quantity) {
    const q = { value: Number(item.value.toString()) };
    if (item.unit) {
      q.unit = item.unit.replace(/^'|'$/g, '');
    }
    return new Value(ColumnKind.Complex, 'Quantity', q);
  }
  if (item instanceof FP_Type && typeof item.toNumber === 'function') {
    // FP_Decimal_Native / FP_Decimal_Precise
    return new Value(ColumnKind.Decimal, 'decimal', item.toNumber());
  }
  switch (typeof item) {
    case 'string':
      return new Value(ColumnKind.String, 'string', item);
    case 'boolean':
      return new Value(ColumnKind.Boolean, 'boolean', item);
    case 'number':
      return Number.isInteger(item)
        ? new Value(ColumnKind.Integer, 'integer', item)
        : new Value(ColumnKind.Decimal, 'decimal', item);
    case 'bigint':
      return new Value(ColumnKind.Integer, 'integer64', item);
    case 'object':
      return new Value(ColumnKind.Complex, item.resourceType || 'Element', item);
    default:
      return new Value(ColumnKind.String, 'string', String(item));
  }
}

function fhirTypeOf(node) {
  if (node.fhirNodeDataType) {
    return node.fhirNodeDataType;
  }
  const ti = node.getTypeInfo();
  return ti ? (ti.namespace ? ti.namespace + '.' + ti.name : ti.name) : null;
}

/**
 * Checks a value can go in a column of the declared kind, and converts it where the Java runner
 * does (an integer into a decimal column, any primitive into a string column). Columns with no
 * declared type take the value as it is.
 */
function valueForColumn(column, value) {
  if (!column.kind || column.kind === ColumnKind.Null) {
    return value;
  }
  const fail = () => {
    throw new Error(`Attempt to add a type ${value.type} to a ${column.kind} column for column ${column.name}`);
  };
  switch (column.kind) {
    case ColumnKind.Complex:
      if (value.kind !== ColumnKind.Complex) {
        throw new Error(`Attempt to add a primitive type ${value.type} to a complex column for column ${column.name}`);
      }
      return value;
    case ColumnKind.String:
      if (value.kind === ColumnKind.Complex) {
        throw new Error(`Attempt to add a complex type ${value.type} to a string column for column ${column.name}`);
      }
      return value.kind === ColumnKind.String ? value : new Value(ColumnKind.String, value.type, String(value.value));
    case ColumnKind.Boolean:
      return value.kind === ColumnKind.Boolean ? value : fail();
    case ColumnKind.Integer:
      if (value.kind === ColumnKind.Integer) {
        return value;
      }
      if (value.kind === ColumnKind.Decimal && Number.isInteger(value.value)) {
        return new Value(ColumnKind.Integer, value.type, value.value);
      }
      return fail();
    case ColumnKind.Decimal:
      return value.kind === ColumnKind.Decimal || value.kind === ColumnKind.Integer
        ? new Value(ColumnKind.Decimal, value.type, value.value) : fail();
    case ColumnKind.DateTime:
      return value.kind === ColumnKind.DateTime ? value : fail();
    case ColumnKind.Time:
      return value.kind === ColumnKind.Time ? value : fail();
    case ColumnKind.Binary:
      return value.kind === ColumnKind.String || value.kind === ColumnKind.Binary
        ? new Value(ColumnKind.Binary, 'base64Binary', value.value) : fail();
    default:
      return value;
  }
}

module.exports = { ColumnKind, Column, Cell, Value, toValue, valueForColumn, kindForType, typeName };
