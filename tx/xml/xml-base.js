//
// FHIR XML Base Class
// Common functionality for all FHIR resource XML serialization/deserialization
//

const { performance } = require('perf_hooks');

// indentation strings, by level (renderers ask for one per element)
const INDENTS = Array.from({ length: 32 }, (_, i) => '  '.repeat(i));
const NO_KEYS = [];
const URL_ONLY = ['url'];
// anything escapeXml has to change, or refuse
// eslint-disable-next-line no-control-regex
const NEEDS_ESCAPE = /[&<>"'\u0000-\u0008\u000B\u000C\u000E-\u001F]/;
const ESCAPED_CHARS = /[&<>"']/g;
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
// serialising for toXmlAsync: the arrays of objects set aside by the synchronous pass,
// to be rendered by the asynchronous one (null: not deferring). The synchronous pass
// can't be interleaved with another, so one slot for all of them is enough
let deferred = null;
// marks where a deferred array goes in the text. NUL can't appear anywhere else:
// escapeXml refuses it in content
// eslint-disable-next-line no-control-regex
const DEFERRED_MARK = /\u0000(\d+)\u0000/;
// how long serialising runs before it lets the event loop handle other requests
const YIELD_MS = 25;
// the XML of large arrays, kept for next time (see xml-fragment-cache.js); null: none
let fragmentCache = null;

/**
 * Base class for FHIR XML serialization/deserialization
 * Contains shared methods for converting between FHIR JSON and XML formats
 */
class FhirXmlBase {

  /**
   * FHIR elements that should always be arrays in JSON
   * These are elements that are arrays at the TOP LEVEL of resources or in unambiguous contexts
   * @type {Set<string>}
   */
  static _arrayElements = new Set([
    // Common resource / DomainResource elements
    'contained',
    // Note: 'identifier' is context-dependent - see _isArrayElement
    // (0..1 on ConceptMap in R4, 0..* on most other resources and ConceptMap in R5)
    'contact',
    'useContext',
    'jurisdiction',
    'extension',
    'modifierExtension',

    // Meta elements
    // Note: Meta.profile, Meta.security, Meta.tag are all context-dependent
    // (array in meta, but singular elsewhere) - handled in _isArrayElement

    // CodeSystem elements
    'concept',          // CodeSystem.concept 0..* (recursive)
    'filter',           // CodeSystem.filter 0..* (also ValueSet.compose.include.filter)
    'operator',         // CodeSystem.filter.operator 0..*
    'designation',      // concept.designation 0..*

    // ValueSet elements
    'include',          // ValueSet.compose.include 0..*
    'exclude',          // ValueSet.compose.exclude 0..*
    'contains',         // ValueSet.expansion.contains 0..* (recursive)
    'parameter',        // ValueSet.expansion.parameter 0..*, Parameters.parameter 0..*
    'valueSet',         // ValueSet.compose.include.valueSet 0..*

    // ConceptMap elements
    'group',            // ConceptMap.group 0..*
    'element',          // ConceptMap.group.element 0..*
    // Note: 'target' is context-dependent - see _isArrayElement
    // (array in ConceptMap.group.element.target, but single uri in ConceptMap.group.target R4)
    'dependsOn',        // ConceptMap.group.element.target.dependsOn 0..*
    'product',          // ConceptMap.group.element.target.product 0..*
    'additionalAttribute', // R5 ConceptMap.additionalAttribute 0..*

    // OperationOutcome elements
    'issue',            // OperationOutcome.issue 0..*
    'location',         // OperationOutcome.issue.location 0..*
    'expression',       // OperationOutcome.issue.expression 0..*

    // Parameters elements
    'part',             // Parameters.parameter.part 0..*

    // Common data type elements
    'coding',           // CodeableConcept.coding 0..*
    'telecom',          // ContactDetail.telecom, ContactPoint uses
    // Note: 'address' is NOT in this set - it is 0..1 in endpoint.address
    // and none of our terminology resources use Address arrays directly
    'given',            // HumanName.given 0..*
    'prefix',           // HumanName.prefix 0..*
    'suffix',           // HumanName.suffix 0..*
    'line',             // Address.line 0..*
    'link',             // Bundle.link 0..*
    'entry',            // Bundle.entry 0..*

    // NamingSystem elements
    'uniqueId',         // NamingSystem.uniqueId 0..*

    // CapabilityStatement elements
    'instantiates',     // CS.instantiates 0..*
    'imports',          // CS.imports 0..* (R4+)
    'format',           // CS.format 1..*
    'patchFormat',      // CS.patchFormat 0..*
    'acceptLanguage',   // CS.acceptLanguage 0..* (R5)
    'implementationGuide', // CS.implementationGuide 0..*
    'rest',             // CS.rest 0..*
    'resource',         // CS.rest.resource 0..*
    'interaction',      // CS.rest.resource.interaction 0..*, CS.rest.interaction 0..*
    'searchInclude',    // CS.rest.resource.searchInclude 0..*
    'searchRevInclude', // CS.rest.resource.searchRevInclude 0..*
    'searchParam',      // CS.rest.resource.searchParam 0..*
    'operation',        // CS.rest.resource.operation 0..*, CS.rest.operation 0..*
    'supportedProfile', // CS.rest.resource.supportedProfile 0..* (R4+)
    'compartment',      // CS.rest.compartment 0..*
    'messaging',        // CS.messaging 0..*
    'endpoint',         // CS.messaging.endpoint 0..*
    'supportedMessage', // CS.messaging.supportedMessage 0..*
    'document',         // CS.document 0..*
    'service',          // CS.rest.security.service 0..*

    // TerminologyCapabilities elements
    'codeSystem',       // TC.codeSystem 0..*
  ]);

  /**
   * Elements that are arrays only in certain parent contexts.
   * These need special handling because the same element name has different
   * cardinality depending on where it appears.
   * @type {Set<string>}
   */
  static _contextDependentArrayElements = new Set([
    'property',   // Array in CodeSystem.property and concept.property, but single in filter
    'profile',    // Array in Meta.profile, but single in CS.rest.resource.profile, CS.document.profile
    'address',    // Array in Patient.address etc, but single in CS.messaging.endpoint.address
    'target',     // Array in ConceptMap.group.element.target, but single uri in ConceptMap.group.target (R4)
    'identifier', // Array on most resources, but 0..1 on ConceptMap in R4 (version-dependent)
    'version',    // Array in TC.codeSystem.version, but single everywhere else
    'language',   // Array in TC.codeSystem.version.language, but single on Resource.language
    'security',   // Array in Meta.security, but single in CS.rest.security
    'tag',        // Array in Meta.tag (handled specially in renderMeta, but needed for generic parsing)
  ]);

  /**
   * Element names that represent boolean types in FHIR.
   * These are converted from XML string "true"/"false" to JSON boolean.
   * @type {Set<string>}
   */
  static _booleanElements = new Set([
    // value[x] boolean
    'valueBoolean',

    // Common resource elements
    'experimental',

    // CodeSystem elements
    'caseSensitive',
    'compositional',
    'versionNeeded',
    'inactive',       // concept.property.valueBoolean (context: concept inactive)

    // CodeSystem concept elements
    'notSelectable',  // concept extension (deprecated but still in use)
    'abstract',       // expansion.contains.abstract

    // ValueSet elements
    'immutable',      // ValueSet.immutable

    // NamingSystem elements
    'preferred',      // NamingSystem.uniqueId.preferred

    // CapabilityStatement elements
    'cors',           // CS.rest.security.cors
    'readHistory',    // CS.rest.resource.readHistory
    'updateCreate',   // CS.rest.resource.updateCreate
    'conditionalCreate',   // CS.rest.resource.conditionalCreate
    'conditionalUpdate',   // CS.rest.resource.conditionalUpdate
    'conditionalPatch',
    'multipleOr',     // CS.rest.resource.searchParam (R5)
    'multipleAnd',    // CS.rest.resource.searchParam (R5)

    // ValueSet expansion contains
    // 'abstract' already listed above
    // 'inactive' already listed above

    // Generic backbone elements
    'userSelected',   // Coding.userSelected
  ]);

  /**
   * Element names that represent integer types in FHIR.
   * These are converted from XML string to JSON number (parseInt).
   * @type {Set<string>}
   */
  static _integerElements = new Set([
    // value[x] integer types
    'valueInteger',
    'valueUnsignedInt',
    'valuePositiveInt',

    // Common elements
    'count',          // CodeSystem.count
    'offset',         // ValueSet.expansion.offset
    'total',          // ValueSet.expansion.total, Bundle.total

    // CapabilityStatement elements
    'reliableCache',  // CS.messaging.reliableCache
  ]);

  /**
   * Element names that represent decimal types in FHIR.
   * These are converted from XML string to JSON number (parseFloat).
   * @type {Set<string>}
   */
  static _decimalElements = new Set([
    'valueDecimal',
    'score',          // Bundle.entry.search.score
  ]);

  /**
   * Parent element contexts where 'value' is a decimal (Quantity-like types).
   * In FHIR, Quantity.value, Money.value etc. are decimal, but most other
   * uses of 'value' (Identifier.value, ContactPoint.value, etc.) are strings.
   * @type {Set<string>}
   */
  static _quantityContexts = new Set([
    'valueQuantity',
    'valueMoney',
    'quantity',       // generic Quantity backbone
    'amount',         // Money amount contexts
    'Quantity',
    'Money',
    'Duration',
    'Age',
    'Distance',
    'Count',
    'SimpleQuantity',
  ]);

  // ==================== XML PARSING (XML -> JSON) ====================

  /**
   * Convert a manually parsed XML element to FHIR JSON format
   * @param {Object} element - Element with {name, attributes, children}
   * @param {string} resourceType - The FHIR resource type
   * @param {number} [fhirVersion] - FHIR version (3, 4, or 5) for version-dependent handling
   * @returns {Object} FHIR JSON object
   */
  static convertElementToFhirJson(element, resourceType, fhirVersion) {
    const result = { resourceType };

    for (const child of element.children) {
      const key = child.name;
      const { value, primitiveExt } = this._convertChildElementWithExt(child, resourceType, fhirVersion);

      // Handle the value
      if (value !== null) {
        if (this._isArrayElement(key, resourceType, fhirVersion)) {
          if (!result[key]) {
            result[key] = [];
          }
          result[key].push(value);
        } else {
          result[key] = value;
        }
      }

      // Handle primitive extension (e.g., _value with extension)
      if (primitiveExt !== null) {
        const extKey = '_' + key;
        result[extKey] = primitiveExt;
      }
    }

    return result;
  }

  /**
   * Check if an element should be an array based on its name and parent context
   * @param {string} elementName - The element name
   * @param {string} parentContext - The parent element name or context
   * @param {number} [fhirVersion] - FHIR version (3, 4, or 5) for version-dependent handling
   * @returns {boolean}
   */
  static _isArrayElement(elementName, parentContext, fhirVersion) {
    // These are always arrays regardless of context
    if (this._arrayElements.has(elementName)) {
      return true;
    }

    // Context-dependent array elements:

    // 'property' is an array in CodeSystem.property, CodeSystem.concept.property,
    // ConceptMap.property (R5), but NOT in filter.property (which is a single code)
    if (elementName === 'property') {
      return parentContext !== 'filter';
    }

    // 'target' is 0..* in ConceptMap.group.element.target (backbone array)
    // but 0..1 in ConceptMap.group.target (R4 uri) and ConceptMap.group.target (R5 uri)
    if (elementName === 'target') {
      return parentContext === 'element';
    }

    // 'identifier' is 0..* on most resources but 0..1 on ConceptMap in R4 and R3
    if (elementName === 'identifier') {
      if (parentContext === 'ConceptMap') {
        return fhirVersion >= 5;
      }
      return true; // 0..* on all other resource types
    }

    // 'version' is 0..* in TerminologyCapabilities.codeSystem.version
    // but 0..1 everywhere else (CodeSystem.version, ValueSet.version, etc.)
    if (elementName === 'version') {
      return parentContext === 'codeSystem';
    }

    // 'language' is 0..* in TerminologyCapabilities.codeSystem.version.language
    // but 0..1 on Resource.language
    if (elementName === 'language') {
      return parentContext === 'version';
    }

    // 'profile' is 0..* in Meta.profile
    // but 0..1 in CapabilityStatement.rest.resource.profile, CS.document.profile
    if (elementName === 'profile') {
      return parentContext === 'meta';
    }

    // 'security' is 0..* in Meta.security (Coding)
    // but 0..1 in CapabilityStatement.rest.security (BackboneElement)
    if (elementName === 'security') {
      return parentContext === 'meta';
    }

    // 'tag' is 0..* in Meta.tag (Coding)
    if (elementName === 'tag') {
      return parentContext === 'meta';
    }

    return false;
  }

  /**
   * Converts a child element to appropriate JSON value, also handling primitive extensions
   * @param {Object} child - Child element with {name, attributes, children}
   * @param {string} parentContext - Parent element name for context-dependent array handling
   * @param {number} [fhirVersion] - FHIR version for version-dependent handling
   * @returns {{value: *, primitiveExt: Object|null}} Converted value and primitive extension if any
   * @private
   */
  // eslint-disable-next-line no-unused-vars
  static _convertChildElementWithExt(child, parentContext = '', fhirVersion) {
    const hasValue = child.attributes.value !== undefined;
    const hasChildren = child.children.length > 0;
    const isExtensionElement = child.name === 'extension' || child.name === 'modifierExtension';

    // Extension elements are NEVER primitive extensions - they are always complex elements
    // Only primitive FHIR elements (like string, code, uri, etc.) can have primitive extensions
    if (!isExtensionElement) {
      // Check if children are only extensions (for primitive extension detection)
      const extensionChildren = child.children.filter(
        c => c.name === 'extension' || c.name === 'modifierExtension'
      );
      const nonExtensionChildren = child.children.filter(
        c => c.name !== 'extension' && c.name !== 'modifierExtension'
      );
      const hasOnlyExtensions = hasChildren && nonExtensionChildren.length === 0;

      // Case 1: Simple primitive with value, no children
      if (hasValue && !hasChildren) {
        return { value: this._convertPrimitiveValue(child.name, child.attributes.value, parentContext), primitiveExt: null };
      }

      // Case 2: Primitive with extension but no value - this is a primitive extension only
      // This ONLY applies when there are NO non-extension children
      if (!hasValue && hasOnlyExtensions) {
        const ext = this._buildExtensionObject(extensionChildren);
        return { value: null, primitiveExt: ext };
      }

      // Case 3: Primitive with both value and extensions (no other children)
      // This ONLY applies when there are NO non-extension children
      if (hasValue && hasOnlyExtensions) {
        const ext = this._buildExtensionObject(extensionChildren);
        return { value: this._convertPrimitiveValue(child.name, child.attributes.value, parentContext), primitiveExt: ext };
      }
    }

    // Case 4: Complex element - process normally (includes extensions as regular children)
    const obj = {};
    const currentContext = child.name; // Use current element name as context for children

    // Copy non-value attributes (like url for extensions)
    for (const [attrName, attrValue] of Object.entries(child.attributes)) {
      if (attrName !== 'value' && attrName !== 'xmlns') {
        obj[attrName] = attrValue;
      }
    }

    // Process ALL children (including extensions as normal array elements)
    for (const grandchild of child.children) {
      const key = grandchild.name;
      const { value, primitiveExt } = this._convertChildElementWithExt(grandchild, currentContext, fhirVersion);

      // Handle the value
      if (value !== null) {
        if (this._isArrayElement(key, currentContext, fhirVersion)) {
          if (!obj[key]) {
            obj[key] = [];
          }
          obj[key].push(value);
        } else if (obj[key] !== undefined) {
          // Convert to array if we see the same key twice
          if (!Array.isArray(obj[key])) {
            obj[key] = [obj[key]];
          }
          obj[key].push(value);
        } else {
          obj[key] = value;
        }
      }

      // Handle primitive extension
      if (primitiveExt !== null) {
        const extKey = '_' + key;
        obj[extKey] = primitiveExt;
      }
    }

    return { value: Object.keys(obj).length > 0 ? obj : null, primitiveExt: null };
  }

  /**
   * Build an extension object from extension children
   * @param {Array} extensionChildren - Array of extension child elements
   * @returns {Object} Extension object with extension/modifierExtension arrays
   * @private
   */
  static _buildExtensionObject(extensionChildren) {
    const ext = {};
    for (const extChild of extensionChildren) {
      const key = extChild.name;
      const { value } = this._convertChildElementWithExt(extChild);
      if (!ext[key]) {
        ext[key] = [];
      }
      ext[key].push(value);
    }
    return ext;
  }

  /**
   * Convert a primitive value to the appropriate JavaScript type
   * @param {string} elementName - The element name
   * @param {string} value - The string value from XML
   * @param {string} [parentContext] - Parent element name for context-dependent typing
   * @returns {*} Converted value
   * @private
   */
  static _convertPrimitiveValue(elementName, value, parentContext) {
    if (this._booleanElements.has(elementName)) {
      return value === 'true';
    }
    if (this._integerElements.has(elementName)) {
      return parseInt(value, 10);
    }
    if (this._decimalElements.has(elementName)) {
      return parseFloat(value);
    }
    // 'value' is a decimal inside Quantity-like types (valueQuantity, valueMoney, Quantity, etc.)
    if (elementName === 'value' && this._quantityContexts.has(parentContext)) {
      return parseFloat(value);
    }
    // Everything else stays as string
    return value;
  }

  /**
   * Simple child element conversion (without tracking primitive extensions)
   * @param {Object} child - Child element with {name, attributes, children}
   * @param {string} parentContext - Parent context for array handling
   * @param {number} [fhirVersion] - FHIR version for version-dependent handling
   * @returns {*} Converted value
   */
  static convertChildElement(child, parentContext = '', fhirVersion) {
    return this._convertChildElementWithExt(child, parentContext, fhirVersion).value;
  }

  // ==================== XML GENERATION (JSON -> XML) ====================

  /**
   * Get the FHIR namespace
   * @returns {string}
   */
  static getNamespace() {
    return 'http://hl7.org/fhir';
  }

  /**
   * Get indentation string
   * @param {number} level - Indentation level
   * @returns {string}
   */
  static indent(level) {
    return INDENTS[level] ?? '  '.repeat(level);
  }

  /**
   * Escape special characters for XML
   *
   * XML 1.0 cannot represent the C0 control characters at all - not literally,
   * and not as numeric character references either - so a value carrying one
   * cannot be serialised as XML by any means. Tab, line feed and carriage
   * return are the three exceptions; DEL (U+007F) is legal in XML 1.0 and is
   * left alone.
   *
   * Rather than emit a document no conformant parser will read, this rejects
   * the value. Anything reaching here with a control character in it came from
   * outside (a remote API, an imported file) and should have been caught at
   * the boundary.
   *
   * Nearly every value has nothing to escape, so one scan decides that and the
   * value goes out as it is (a large CodeSystem has millions of them).
   *
   * @param {*} value - Value to escape
   * @returns {string}
   * @throws {Error} if the value contains a character XML cannot carry
   */
  static escapeXml(value) {
    if (value === null || value === undefined) return '';
    const str = String(value);
    if (!NEEDS_ESCAPE.test(str)) {
      return str;
    }
    // eslint-disable-next-line no-control-regex
    const illegal = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.exec(str);
    if (illegal) {
      const code = illegal[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0');
      throw new Error(`Cannot serialise this content as XML: it contains U+${code} at offset ${illegal.index}, a control character XML does not allow`);
    }
    return str.replace(ESCAPED_CHARS, c => ESCAPES[c]);
  }

  /**
   * Unescape XML entities
   * @param {string} str - String to unescape
   * @returns {string}
   */
  static unescapeXml(str) {
    return str
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'");
  }

  // The renderers below write their pieces into one array (out), joined once at the
  // end, rather than each returning a string for its caller to append: for a large
  // resource (the full ICD-10-CM CodeSystem is 64 MB of XML) the intermediate strings
  // were most of the work, and most of the garbage collection, of serialising it. The
  // render* methods keep their string-returning signatures for the classes that use them.

  /**
   * Render an element to XML
   * @param {string} name - Element name
   * @param {*} value - Element value
   * @param {number} level - Indentation level
   * @returns {string} XML string
   */
  static renderElement(name, value, level) {
    const out = [];
    this._emitElement(out, name, value, level);
    return out.join('');
  }

  /**
   * Render an object's properties to XML
   * @param {Object} obj - Object to render
   * @param {number} level - Indentation level
   * @param {Array<string>} skipKeys - Keys to skip
   * @returns {string} XML string
   */
  static renderObject(obj, level, skipKeys = []) {
    const out = [];
    this._emitObject(out, obj, level, skipKeys);
    return out.join('');
  }

  /**
   * Render elements in a specific order
   * @param {Object} obj - Object to render
   * @param {number} level - Indentation level
   * @param {Array<string>} elementOrder - Ordered list of element names
   * @returns {string} XML string
   */
  static renderElementsInOrder(obj, level, elementOrder) {
    const out = [];

    // Process elements in order
    for (const key of elementOrder) {
      if (Object.hasOwn(obj, key) && key !== 'resourceType') {
        this._emitElement(out, key, obj[key], level);
      }
    }

    // Process any remaining elements not in the order list
    for (const key of Object.keys(obj)) {
      if (!elementOrder.includes(key) && key !== 'resourceType' && !key.startsWith('_')) {
        this._emitElement(out, key, obj[key], level);
      }
    }

    return out.join('');
  }

  /**
   * renderElement, into out
   * @private
   */
  static _emitElement(out, name, value, level) {
    if (value === null || value === undefined) {
      return;
    }

    if (Array.isArray(value)) {
      if (deferred && value.length > 0 && typeof value[0] === 'object' && value[0] !== null) {
        out.push('\u0000' + deferred.length + '\u0000');
        deferred.push({ name, value, level });
        return;
      }
      for (const item of value) {
        this._emitElement(out, name, item, level);
      }
    } else if (typeof value === 'object') {
      const ind = this.indent(level);
      // Special handling for extension - url is an attribute
      if (name === 'extension' || name === 'modifierExtension') {
        out.push(ind, '<', name, value.url ? ` url="${this.escapeXml(value.url)}"` : '', '>\n');
        this._emitObject(out, value, level + 1, URL_ONLY);
      } else {
        out.push(ind, '<', name, '>\n');
        this._emitObject(out, value, level + 1, NO_KEYS);
      }
      out.push(ind, '</', name, '>\n');
    } else if (typeof value === 'boolean' || typeof value === 'number') {
      out.push(this.indent(level), '<', name, ' value="', String(value), '"/>\n');
    } else {
      out.push(this.indent(level), '<', name, ' value="', this.escapeXml(value), '"/>\n');
    }
  }

  /**
   * renderObject, into out
   * @private
   */
  static _emitObject(out, obj, level, skipKeys) {
    for (const key in obj) {
      if (!Object.hasOwn(obj, key)) {
        continue;
      }
      // Skip primitive extension keys (handled separately)
      if (key.charCodeAt(0) === 95 /* _ */) {
        continue;
      }
      if (skipKeys.length > 0 && skipKeys.includes(key)) {
        continue;
      }
      this._emitElement(out, key, obj[key], level);
    }
  }

  /**
   * Serialise without holding the event loop for the whole of a large resource.
   *
   * The XML for the full ICD-10-CM CodeSystem is 64 MB; serialising it in one go held
   * tx.fhir.org's event loop for seconds. This runs toXml (render) with every array of
   * objects - concepts, expansion contains, bundle entries, and so on - set aside, then
   * renders those an item at a time, letting other work run every YIELD_MS. The result
   * is the same text toXml produces.
   *
   * @param {Function} render - produces the XML synchronously, e.g. () => CodeSystemXML.toXml(json)
   * @returns {Promise<string>} XML string
   */
  static async toXmlAsync(render) {
    let text;
    let jobs;
    deferred = [];
    try {
      text = render();
    } finally {
      jobs = deferred;
      deferred = null;
    }
    if (jobs.length === 0) {
      return text;
    }
    const parts = text.split(DEFERRED_MARK);
    const out = [];
    // out is joined into chunks as it goes (at each yield), so the end isn't one join of millions
    // of pieces. busy: the time spent serialising, not counting the time given to other work
    const clock = { last: performance.now(), chunks: [], busy: 0 };
    const busyNow = () => clock.busy + (performance.now() - clock.last);
    const cache = fragmentCache;
    // split leaves the text between the marks at the even positions, and the job numbers at the odd ones
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 0) {
        out.push(parts[i]);
        continue;
      }
      const job = jobs[Number(parts[i])];
      const key = job.name + '|' + job.level;
      const kept = cache ? cache.get(job.value, key) : null;
      if (kept !== null) {
        out.push(kept);
        continue;
      }
      // this array's text in chunks of its own, in case it's worth keeping
      clock.chunks.push(out.join(''));
      out.length = 0;
      const first = clock.chunks.length;
      const started = busyNow();
      await this._emitArrayAsync(out, job.name, job.value, job.level, clock);
      if (cache && cache.wants(job.value, key, busyNow() - started)) {
        clock.chunks.push(out.join(''));
        out.length = 0;
        const text = clock.chunks.splice(first).join('');
        clock.chunks.push(text);
        cache.put(job.value, key, text);
      }
    }
    clock.chunks.push(out.join(''));
    return clock.chunks.join('');
  }

  /**
   * The cache toXmlAsync keeps the XML of large arrays in (null: none)
   * @param {XmlFragmentCache|null} cache
   */
  static setFragmentCache(cache) {
    fragmentCache = cache;
  }

  static get fragmentCache() {
    return fragmentCache;
  }

  /**
   * Render with nothing set aside for toXmlAsync, for a caller that does more with the
   * text than include it in the output (ParametersXML re-indents embedded resources)
   * @param {Function} render - produces the text synchronously
   * @returns {*} what render returns
   */
  static withoutDeferral(render) {
    const saved = deferred;
    deferred = null;
    try {
      return render();
    } finally {
      deferred = saved;
    }
  }

  /**
   * _emitElement for an array, an item at a time, yielding as it goes. Arrays of
   * objects inside an item (a concept's child concepts) are done the same way, so
   * one item with a large subtree doesn't hold the loop either.
   * @private
   */
  static async _emitArrayAsync(out, name, array, level, clock) {
    for (const item of array) {
      if (Array.isArray(item)) {
        await this._emitArrayAsync(out, name, item, level, clock);
      } else if (item !== null && typeof item === 'object') {
        const ind = this.indent(level);
        let skipKeys = NO_KEYS;
        if (name === 'extension' || name === 'modifierExtension') {
          out.push(ind, '<', name, item.url ? ` url="${this.escapeXml(item.url)}"` : '', '>\n');
          skipKeys = URL_ONLY;
        } else {
          out.push(ind, '<', name, '>\n');
        }
        // as _emitObject
        for (const key in item) {
          if (!Object.hasOwn(item, key) || key.charCodeAt(0) === 95 /* _ */ || (skipKeys.length > 0 && skipKeys.includes(key))) {
            continue;
          }
          const value = item[key];
          if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object' && value[0] !== null) {
            await this._emitArrayAsync(out, key, value, level + 1, clock);
          } else {
            this._emitElement(out, key, value, level + 1);
          }
        }
        out.push(ind, '</', name, '>\n');
      } else {
        this._emitElement(out, name, item, level);
      }
      const now = performance.now();
      if (now - clock.last >= YIELD_MS) {
        clock.chunks.push(out.join(''));
        out.length = 0;
        clock.busy += now - clock.last;
        await new Promise(resolve => setImmediate(resolve));
        clock.last = performance.now();
      }
    }
  }

  /**
   * Generate XML declaration and root element wrapper
   * @param {string} resourceType - FHIR resource type
   * @param {string} content - Inner XML content
   * @returns {string} Complete XML document
   */
  static wrapInRootElement(resourceType, content) {
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += `<${resourceType} xmlns="${this.getNamespace()}">\n`;
    xml += content;
    xml += `</${resourceType}>`;
    return xml;
  }

  // ==================== XML STRING PARSING ====================

  /**
   * Manual XML parser - parses XML string to element tree
   */
  static parseXmlString(xml) {
    const parser = new FhirXmlParser(xml);
    return parser.parse();
  }
}

/**
 * Simple XML parser for FHIR resources
 * Parses XML string into {name, attributes, children} structure
 */
/**
 * A deliberately small XML reader for FHIR resources. It is not a general XML processor: FHIR
 * XML has no DTDs, no entities beyond the five predefined ones, and carries its values in
 * attributes, so the grammar it needs is tiny.
 *
 * What it does have to be is total. Every input either produces a tree or throws - it must never
 * loop, and it must never run away with memory or stack. This matters more than it looks: the
 * server accepts application/fhir+xml on every endpoint, parsing is synchronous, and node is
 * single threaded, so a parser that fails to terminate does not hang one request, it stops the
 * process answering anything at all. The cooperative deadCheck cannot help - it needs an await
 * point, and there isn't one inside a parse.
 *
 * Two rules keep that promise, and both are enforced rather than assumed:
 *
 *  - no scan may fail silently. Every search for a delimiter goes through #seek(), which throws
 *    if the delimiter is absent. The bug this replaces was an indexOf() returning -1 whose result
 *    was assigned to the cursor, sending it back to zero and restarting the parse forever.
 *  - every loop must consume input. Each iteration asserts the cursor moved forward, so a future
 *    edit that forgets to advance it fails loudly on the first malformed document instead of
 *    spinning.
 */

// FHIR resources nest a couple of dozen deep; narrative markup can go further. This is well
// clear of anything real and well under the call stack, so deep input is a clean error rather
// than a RangeError from the recursion in _parseElement.
const MAX_ELEMENT_DEPTH = 1000;

class FhirXmlParser {
  /**
   * @param {string} xml - the document to read
   */
  constructor(xml) {
    if (typeof xml !== 'string') {
      throw new Error('XML input must be a string');
    }
    this.xml = xml;
    this.pos = 0;
    this.depth = 0;
  }

  /**
   * @returns {{name: string, attributes: Object, children: Array}} the root element
   */
  parse() {
    this.#parseProlog();
    const root = this.#parseElement();
    return root;
  }

  // ========== scanning primitives ==========

  /**
   * Throw with the position, which is what makes a malformed document diagnosable
   * @param {string} message
   */
  #fail(message) {
    throw new Error(`${message} at position ${this.pos}`);
  }

  /**
   * indexOf that cannot return -1. Every delimiter search goes through here
   * @param {string} needle
   * @param {string} what - what we were looking for, for the error message
   * @returns {number}
   */
  #seek(needle, what) {
    const at = this.xml.indexOf(needle, this.pos);
    if (at === -1) {
      this.#fail(`Unterminated ${what}: no '${needle}' found`);
    }
    return at;
  }

  /**
   * Move the cursor, checking it actually moved forward. Called at the end of every loop body
   * @param {number} was - the cursor before the iteration
   */
  #mustHaveAdvanced(was) {
    if (this.pos <= was) {
      // not reachable by any input we know of - it means a code path forgot to consume
      this.#fail('Internal error: the XML parser stopped making progress');
    }
  }

  #atEnd() {
    return this.pos >= this.xml.length;
  }

  #skipWhitespace() {
    while (this.pos < this.xml.length && /\s/.test(this.xml[this.pos])) {
      this.pos++;
    }
  }

  #startsWith(text) {
    return this.xml.startsWith(text, this.pos);
  }

  // ========== document structure ==========

  /**
   * The XML declaration, and any comments or processing instructions before the root element.
   * A DOCTYPE is refused outright: FHIR XML has no DTD, and accepting one is how a parser ends
   * up doing entity expansion on someone else's behalf.
   */
  #parseProlog() {
    this.#skipWhitespace();
    if (this.#startsWith('<?xml')) {
      this.pos = this.#seek('?>', 'XML declaration') + 2;
    }
    for (;;) {
      const was = this.pos;
      this.#skipWhitespace();
      if (this.#startsWith('<!--')) {
        this.#skipComment();
      } else if (this.#startsWith('<!DOCTYPE') || this.#startsWith('<!')) {
        this.#fail('Document type declarations are not allowed in FHIR XML');
      } else if (this.#startsWith('<?')) {
        this.pos = this.#seek('?>', 'processing instruction') + 2;
      } else {
        return;
      }
      this.#mustHaveAdvanced(was);
    }
  }

  #skipComment() {
    this.pos = this.#seek('-->', 'comment') + 3;
  }

  /**
   * One element and everything inside it.
   * @returns {{name: string, attributes: Object, children: Array}}
   */
  #parseElement() {
    if (++this.depth > MAX_ELEMENT_DEPTH) {
      this.depth--;
      this.#fail(`XML is nested more than ${MAX_ELEMENT_DEPTH} elements deep`);
    }
    try {
      return this.#parseElementInner();
    } finally {
      this.depth--;
    }
  }

  #parseElementInner() {
    this.#skipWhitespace();
    if (this.#atEnd() || this.xml[this.pos] !== '<') {
      this.#fail("Expected '<'");
    }
    this.pos++;

    const name = this.#parseName('element name');
    const attributes = this.#parseAttributes(name);

    if (this.#startsWith('/>')) {
      this.pos += 2;
      return { name, attributes, children: [] };
    }
    if (this.#atEnd() || this.xml[this.pos] !== '>') {
      this.#fail(`Expected '>' or '/>' to close the start tag of <${name}>`);
    }
    this.pos++;

    return { name, attributes, children: this.#parseChildren(name) };
  }

  /**
   * An element or attribute name: everything up to whitespace, '/', '>' or '='.
   * @param {string} what - for the error message
   * @returns {string}
   */
  #parseName(what) {
    const from = this.pos;
    while (this.pos < this.xml.length && !/[\s/>=]/.test(this.xml[this.pos])) {
      this.pos++;
    }
    if (this.pos === from) {
      this.#fail(`Expected an ${what}`);
    }
    return this.xml.substring(from, this.pos);
  }

  /**
   * @param {string} elementName - for error messages
   * @returns {Object} name to value
   */
  #parseAttributes(elementName) {
    const attributes = {};
    for (;;) {
      const was = this.pos;
      this.#skipWhitespace();
      if (this.#atEnd()) {
        this.#fail(`Unterminated start tag <${elementName}>`);
      }
      if (this.xml[this.pos] === '>' || this.#startsWith('/>')) {
        return attributes;
      }
      if (this.xml[this.pos] === '/') {
        this.#fail(`Expected '/>' in the start tag of <${elementName}>`);
      }

      const name = this.#parseName('attribute name');
      this.#skipWhitespace();
      if (this.#atEnd() || this.xml[this.pos] !== '=') {
        this.#fail(`Expected '=' after the attribute '${name}' of <${elementName}>`);
      }
      this.pos++;
      attributes[name] = this.#parseAttributeValue(name, elementName);

      this.#mustHaveAdvanced(was);
    }
  }

  /**
   * A quoted attribute value. XML has no unquoted form, and accepting one is what let a stray
   * character send the cursor somewhere arbitrary
   * @param {string} name
   * @param {string} elementName
   * @returns {string}
   */
  #parseAttributeValue(name, elementName) {
    this.#skipWhitespace();
    const quote = this.xml[this.pos];
    if (quote !== '"' && quote !== "'") {
      this.#fail(`The value of the attribute '${name}' of <${elementName}> must be quoted`);
    }
    this.pos++;
    const end = this.#seek(quote, `value of the attribute '${name}' of <${elementName}>`);
    const value = FhirXmlBase.unescapeXml(this.xml.substring(this.pos, end));
    this.pos = end + 1;
    return value;
  }

  /**
   * Everything between a start tag and its matching end tag. Text is skipped: FHIR carries its
   * values in attributes, and this parser has never returned character data.
   * @param {string} elementName
   * @returns {Array} the child elements
   */
  #parseChildren(elementName) {
    const children = [];
    for (;;) {
      const was = this.pos;
      this.#skipWhitespace();
      if (this.#atEnd()) {
        this.#fail(`Unclosed element <${elementName}>: expected </${elementName}>`);
      }

      if (this.#startsWith('</')) {
        this.pos += 2;
        const closing = this.#parseName('element name');
        if (closing !== elementName) {
          this.#fail(`Expected </${elementName}> but found </${closing}>`);
        }
        this.#skipWhitespace();
        if (this.#atEnd() || this.xml[this.pos] !== '>') {
          this.#fail(`Expected '>' to close </${closing}>`);
        }
        this.pos++;
        return children;
      }

      if (this.xml[this.pos] === '<') {
        if (this.#startsWith('<!--')) {
          this.#skipComment();
        } else if (this.#startsWith('<![CDATA[')) {
          this.pos = this.#seek(']]>', 'CDATA section') + 3;
        } else if (this.#startsWith('<!')) {
          this.#fail('Declarations are not allowed inside a FHIR XML element');
        } else if (this.#startsWith('<?')) {
          this.pos = this.#seek('?>', 'processing instruction') + 2;
        } else {
          children.push(this.#parseElement());
        }
      } else {
        // character data - skipped, but it still has to be consumed
        this.pos = this.#seek('<', `content of <${elementName}>`);
      }

      this.#mustHaveAdvanced(was);
    }
  }
}

module.exports = { FhirXmlBase, FhirXmlParser };