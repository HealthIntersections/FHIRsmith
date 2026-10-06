// // Convert input to Languages instance if needed
// const langs = languages instanceof Languages ? languages :
//   Array.isArray(languages) ? Languages.fromAcceptLanguage(languages.join(',')) :
//     Languages.fromAcceptLanguage(languages || '');

// code instanceof CodeSystemProviderContext ? this.code


// const {Language} = require("./languages");
// if (designation.language) {
//   const designationLang = new Language(designation.language);
//   for (const requestedLang of langs) {
//     if (designationLang.matchesForDisplay(requestedLang)) {

const Utilities = {
  noString: (str) => !str || String(str).trim() === '',
  existsInList: (item, ...list) => list.includes(item),
  isInteger: (str) => {
    if (typeof str !== 'string' || str === '') return false;
    const num = parseInt(str, 10);
    return num.toString() === str && !isNaN(num);
  },
  parseIntOrDefault(value, defaultValue) {
    const num = parseInt(value, 10);
    return isNaN(num) ? defaultValue : num;
  },
  parseFloatOrDefault(value, defaultValue) {
    const num = parseFloat(value);
    return isNaN(num) ? defaultValue : num;


  },

  /**
   * Format the difference between two Date.now() timestamps for human reading
   * @param {number} start - earlier timestamp (from Date.now())
   * @param {number} end - later timestamp (from Date.now())
   * @returns {string} formatted duration
   */
  formatDuration(start, end) {
    let ms = Math.abs(end - start);

    if (ms < 1000) return `${ms}ms`;

    const days = Math.floor(ms / 86400000);
    ms %= 86400000;
    const hours = Math.floor(ms / 3600000);
    ms %= 3600000;
    const minutes = Math.floor(ms / 60000);
    ms %= 60000;
    const seconds = Math.floor(ms / 1000);
    ms %= 1000;

    const parts = [];
    if (days) parts.push(`${days}d`);
    if (hours) parts.push(`${hours}h`);
    if (minutes) parts.push(`${minutes}m`);
    if (seconds || ms) {
      parts.push(ms ? `${seconds}.${String(ms).padStart(3, '0')}s` : `${seconds}s`);
    }

    return parts.join(' ');
  },

  /**
   * How long ago a time was, for people: "35 minutes ago", "3 hours ago", "2 days ago"
   * @param {Date|string|number} time - the earlier time
   * @param {number} now - Date.now(), for testing
   * @returns {string}
   */
  describeAgo(time, now = Date.now()) {
    const secs = Math.max(0, Math.floor((now - new Date(time).getTime()) / 1000));
    const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'} ago`;
    if (secs < 60) {
      return 'just now';
    }
    if (secs < 3600) {
      return plural(Math.floor(secs / 60), 'minute');
    }
    if (secs < 172800) {
      return plural(Math.floor(secs / 3600), 'hour');
    }
    return plural(Math.floor(secs / 86400), 'day');
  }

};

function validateParameter(param, name, type) {
  if (param == null) {
    throw new Error(`${name} must be provided`);
  }

  const actualType = param.constructor?.name || typeof param;

  if (type === String) {
    if (typeof param !== 'string') {
      throw new Error(`${name} must be a string, but got ${actualType}`);
    }
  } else if (type === Number) {
    if (typeof param !== 'number' || isNaN(param)) {
      throw new Error(`${name} must be a number, but got ${actualType}`);
    }
  } else if (type === Boolean) {
    if (typeof param !== 'boolean') {
      throw new Error(`${name} must be a boolean, but got ${actualType}`);
    }
  } else {
    if (typeof param !== 'object') {
      throw new Error(`${name} must be a valid ${type.name}, but got ${actualType}`);
    }
    // Handle object types with instanceof
    if (!(param instanceof type)) {
      throw new Error(`${name} must be a valid ${type.name}, but got ${actualType}`);
    }
  }
}

function validateResource(param, name, type) {
  if (param == null) {
    throw new Error(`${name} must be provided`);
  }
  if (!(param instanceof Object)) {
    throw new Error(`${name} must be a Resource not a `);
  }
  if (param.resourceType != type) {
    throw new Error(`${name} must be a Resource of type ${type} not ${param.resourceType}`);
  }
}

function validateOptionalParameter(param, name, type) {
  if (param) {
    validateParameter(param, name, type);
  }
}

function validateArrayParameter(param, name, type, optional) {
  if (param == null) {
    if (optional) {
      return;
    } else {
      throw new Error(`${name} must be provided`);
    }
  }
  if (!Array.isArray(param)) {
    throw new Error(`${name} must be an array`);
  }
  for (let i = 0; i < param.length; i++) {
    validateParameter(param[i], name+`[${i}]`, type);
  }
}

function strToBool(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  return value === 'true' || value === true;
}

function getValuePrimitive(obj) {
  if (!obj) return null;

  const primitiveTypes = [
    'valueString', 'valueCode', 'valueUri', 'valueUrl', 'valueCanonical',
    'valueBoolean', 'valueInteger', 'valueDecimal', 'valueDate', 'valueDateTime',
    'valueTime', 'valueInstant', 'valueId', 'valueOid', 'valueUuid',
    'valueMarkdown', 'valueBase64Binary', 'valuePositiveInt', 'valueUnsignedInt', 'valueInteger64'
  ];

  for (const type of primitiveTypes) {
    if (obj[type] !== undefined) {
      return obj[type];
    }
  }
  return null;
}

function getValueDT(obj) {
  if (!obj) return null;

  const primitiveTypes = [
    'valueAddress', 'valueAge', 'valueAnnotation',
    'valueAttachment', 'valueCodeableConcept', 'valueCodeableReference', 'valueCoding', 'valueContactPoint', 'valueCount',
    'valueDistance', 'valueDuration', 'valueHumanName', 'valueIdentifier', 'valueMoney', 'valuePeriod', 'valueQuantity', 'valueRange',
    'valueRatio', 'valueRatioRange', 'valueReference', 'valueSampledData', 'valueSignature', 'valueTiming', 'valueContactDetail',
    'valueDataRequirement', 'valueExpression', 'valueParameterDefinition', 'valueRelatedArtifact', 'valueTriggerDefinition',
    'valueUsageContext', 'valueAvailability', 'valueExtendedContactDetail', 'valueVirtualServiceDetail', 'valueDosage', 'valueMeta'
  ];

  for (const type of primitiveTypes) {
    if (obj[type] !== undefined) {
      return obj[type];
    }
  }
  return null;
}



function getValueName(obj) {
  if (!obj) return null;

  const primitiveTypes = [
    'valueString', 'valueCode', 'valueUri', 'valueUrl', 'valueCanonical',
    'valueBoolean', 'valueInteger', 'valueDecimal', 'valueDate', 'valueDateTime',
    'valueTime', 'valueInstant', 'valueId', 'valueOid', 'valueUuid',
    'valueMarkdown', 'valueBase64Binary', 'valuePositiveInt', 'valueAddress', 'valueAge', 'valueAnnotation',
    'valueAttachment', 'valueCodeableConcept', 'valueCodeableReference', 'valueCoding', 'valueContactPoint', 'valueCount',
    'valueDistance', 'valueDuration', 'valueHumanName', 'valueIdentifier', 'valueMoney', 'valuePeriod', 'valueQuantity', 'valueRange',
    'valueRatio', 'valueRatioRange', 'valueReference', 'valueSampledData', 'valueSignature', 'valueTiming', 'valueContactDetail',
    'valueDataRequirement', 'valueExpression', 'valueParameterDefinition', 'valueRelatedArtifact', 'valueTriggerDefinition',
    'valueUsageContext', 'valueAvailability', 'valueExtendedContactDetail', 'valueVirtualServiceDetail', 'valueDosage', 'valueMeta'
  ];

  for (const type of primitiveTypes) {
    if (obj[type] !== undefined) {
      return type;
    }
  }
  return null;
}

function isAbsoluteUrl(s) {
  return s && (s.startsWith('urn:') || s.startsWith('http:') || s.startsWith('https:') || s.startsWith('ftp:'));
}

/**
 * This class takes two lists, and matches between the lists, producing three new lists:
 *   * items that are in both
 *   * items that only in left
 *   * items that are only in right
 *
 * You have to give it a match function that is called asynchronously
 *
 * examples of use:
 *
 * const matcher = new ArrayMatcher((l, r) =>
 *   this.filtersMatch(localstatus, cs, l, r)
 * );
 * await matcher.match(leftArray, rightArray);
 *
 * // Use the results
 * for (const { left, right } of matcher.matched) { ... }
 * for (const item of matcher.unmatchedLeft) { ... }
 * for (const item of matcher.unmatchedRight) { ... }
 *
 * // or
 * const matcher2 = new ArrayMatcher((l, r) =>
 *   this.compareProperties(system, version, l, r)
 * );
 * await matcher2.match(propsA, propsB);
 *
 */
class ArrayMatcher {
  constructor(matchFn) {
    this.matchFn = matchFn;
    this.matched = [];
    this.unmatchedLeft = [];
    this.unmatchedRight = [];
  }

  /**
   *
   * @param left an array of items (or null/undefined)
   * @param right an array of items (or null/undefined)
   * @returns {Promise<ArrayMatcher>}
   */
  async match(left, right) {
    if (!left) {
      left = [];
    }
    if (!right) {
      right = [];
    }

    this.matched = [];
    this.unmatchedRight = [...right];

    for (const l of left) {
      let idx = -1;
      for (let i = 0; i < this.unmatchedRight.length; i++) {
        if (await this.matchFn(l, this.unmatchedRight[i])) {
          idx = i;
          break;
        }
      }
      if (idx !== -1) {
        this.matched.push({ left: l, right: this.unmatchedRight[idx] });
        this.unmatchedRight.splice(idx, 1);
      } else {
        this.unmatchedLeft.push(l);
      }
    }

    return this;
  }
}

const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function formatDateMMDDYYYY(s) {
  const mm = parseInt(s.substring(0, 2), 10);
  const dd = s.substring(2, 4);
  const yyyy = s.substring(4, 8);
  return dd + '-' + months[mm - 1] + ' ' + yyyy;
}

module.exports = { Utilities, ArrayMatcher, validateParameter, validateOptionalParameter, validateArrayParameter, validateResource, strToBool, getValuePrimitive, getValueDT, getValueName, isAbsoluteUrl, formatDateMMDDYYYY };
