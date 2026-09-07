/**
 * SNOMED CT Expression Library
 * Converted from Pascal ftx_sct_expressions.pas
 *
 * Copyright (c) 2011+, HL7 and Health Intersections Pty Ltd
 * Licensed under BSD-3-Clause
 */

const { SnomedConceptList } = require('./structures');

const MAX_TERM_LENGTH = 1024;
// How deep concept-definition expansion may go while building a long normal form.
// Attribute values are themselves expanded, so a chain of definitions can descend a
// long way; in real data it is a handful of levels.
const MAX_NORMALISATION_DEPTH = 50;

const NO_REFERENCE = 0xFFFFFFFF;

// MRCM (machine readable concept model) reference sets and metadata concepts.
// The range constraints in 723562003 are ECL, so they are only checked when an
// evaluator has been injected (SnomedServices does this - see eclConstraintMatcher).
const MRCM_ATTRIBUTE_DOMAIN_REFSET = 723561005n;
const MRCM_ATTRIBUTE_RANGE_REFSET = 723562003n;
// contentTypeId values that apply when validating a postcoordinated expression.
// 723593002 (precoordinated only) and 723595009 (new precoordinated only) are
// rules about authoring precoordinated concepts and do not constrain expressions.
const MRCM_CONTENT_TYPE_ALL = 723596005n;
const MRCM_CONTENT_TYPE_POSTCOORDINATED = 723594008n;

// Expression status enumeration
const SnomedExpressionStatus = {
  Unknown: 0,
  Equivalent: 1,
  SubsumedBy: 2
};

/**
 * Base class for all SNOMED expression elements
 */
class SnomedExpressionBase {
  constructor() {
    this.start = 0;
    this.stop = 0;
  }
}

/**
 * Represents a SNOMED concept with optional code, description, literal, or decimal value
 */
class SnomedConcept extends SnomedExpressionBase {
  constructor(reference = NO_REFERENCE) {
    super();
    this.reference = reference;
    this.code = '';
    this.description = '';
    this.literal = '';
    this.decimal = '';
  }

  /**
   * Check if this concept matches another concept
   */
  matches(other) {
    if (!other) return false;

    if (this.reference !== NO_REFERENCE) {
      return this.reference === other.reference;
    } else if (this.code) {
      return this.code === other.code;
    } else if (this.decimal) {
      return this.decimal === other.decimal;
    } else if (this.literal) {
      return this.literal === other.literal;
    }

    return false;
  }

  /**
   * Get a string description of this concept
   */
  describe() {
    if (this.code) {
      return this.code;
    } else if (this.decimal) {
      return '#' + this.decimal;
    } else if (this.literal) {
      return '"' + this.literal + '"';
    }
    return '';
  }

  /**
   * Compare two concepts for sorting
   */
  compare(other) {
    if (this.code) {
      return this.code.localeCompare(other.code);
    } else if (this.decimal) {
      return this.decimal.localeCompare(other.decimal);
    } else {
      return this.literal.localeCompare(other.literal);
    }
  }

  /**
   * Create a canonical copy of this concept
   */
  canonical() {
    const result = new SnomedConcept();
    result.copyFrom(this);
    return result;
  }

  /**
   * Copy properties from another concept
   */
  copyFrom(other) {
    this.reference = other.reference;
    this.code = other.code;
    this.description = other.description;
    this.literal = other.literal;
    this.decimal = other.decimal;
  }
}

/**
 * Represents a refinement (attribute-value pair) in a SNOMED expression
 */
class SnomedRefinement extends SnomedExpressionBase {
  constructor() {
    super();
    this.name = null;  // SnomedConcept
    this.value = null; // SnomedExpression
  }

  /**
   * Set the name (attribute) of this refinement
   */
  setName(name) {
    this.name = name;
  }

  /**
   * Set the value of this refinement
   */
  setValue(value) {
    this.value = value;
  }

  /**
   * Check if this refinement matches another
   */
  matches(other) {
    if (!other) return false;
    if (!this.name.matches(other.name)) return false;
    return this.value.matches(other.value) === '';
  }

  /**
   * Get a string description of this refinement
   */
  describe() {
    return this.name.describe() + '=' + this.value.describe();
  }

  /**
   * Compare two refinements for sorting
   */
  compare(other) {
    return this.name.compare(other.name);
  }

  /**
   * Create a canonical copy of this refinement
   */
  canonical() {
    const result = new SnomedRefinement();
    result.name = this.name.canonical();
    result.value = this.value.canonical();
    return result;
  }
}

/**
 * Represents a group of refinements in a SNOMED expression
 */
class SnomedRefinementGroup extends SnomedExpressionBase {
  constructor() {
    super();
    this.refinements = []; // Array of SnomedRefinement
  }

  /**
   * Check if this group matches another group
   */
  matches(other) {
    if (!other) return false;

    // Check all refinements in this group exist in other
    for (const refinement of this.refinements) {
      if (!other.hasRefinement(refinement)) {
        return false;
      }
    }

    // Check all refinements in other group exist in this
    for (const refinement of other.refinements) {
      if (!this.hasRefinement(refinement)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Check if this group contains a specific refinement
   */
  hasRefinement(refinement) {
    return this.refinements.some(test => test.matches(refinement));
  }

  /**
   * Get a string description of this refinement group
   */
  describe() {
    return this.refinements.map(r => r.describe()).join(',');
  }

  /**
   * Compare two refinement groups for sorting
   */
  compare(other) {
    if (this.refinements.length === 0 || other.refinements.length === 0) {
      return this.refinements.length - other.refinements.length;
    }
    return this.refinements[0].compare(other.refinements[0]);
  }

  /**
   * Create a canonical copy of this refinement group
   */
  canonical() {
    const result = new SnomedRefinementGroup();
    for (const refinement of this.refinements) {
      result.refinements.push(refinement.canonical());
    }
    return result;
  }
}

/**
 * Main SNOMED expression class containing concepts, refinements, and refinement groups
 */
class SnomedExpression extends SnomedExpressionBase {
  constructor() {
    super();
    this.status = SnomedExpressionStatus.Unknown;
    this.concepts = []; // Array of SnomedConcept
    this.refinements = []; // Array of SnomedRefinement
    this.refinementGroups = []; // Array of SnomedRefinementGroup
  }

  /**
   * Check if expression has refinements
   */
  hasRefinements() {
    return this.refinements.length > 0;
  }

  /**
   * Check if expression has refinement groups
   */
  hasRefinementGroups() {
    return this.refinementGroups.length > 0;
  }

  /**
   * Check if this is a simple expression (single concept, no refinements)
   */
  isSimple() {
    return (this.concepts.length === 1) &&
      !this.hasRefinements() &&
      !this.hasRefinementGroups();
  }

  /**
   * Check if this is a complex expression
   */
  isComplex() {
    return !this.isSimple();
  }

  /**
   * Check if expression contains a specific concept
   */
  hasConcept(concept) {
    if (typeof concept === 'number') {
      return this.concepts.some(test => test.reference === concept);
    } else {
      return this.concepts.some(test => test.matches(concept));
    }
  }

  /**
   * Check if expression contains a specific refinement
   */
  hasRefinement(refinement) {
    return this.refinements.some(test => test.matches(refinement));
  }

  /**
   * Check if expression contains a specific refinement group
   */
  hasRefinementGroup(refinementGroup) {
    return this.refinementGroups.some(test => test.matches(refinementGroup));
  }

  /**
   * Check if this expression matches another expression
   * Returns empty string if match, error message if not
   */
  matches(other) {
    if (!other) return 'other is nil';

    // Check concepts
    for (const concept of this.concepts) {
      if (!other.hasConcept(concept)) {
        return 'concept ' + concept.describe() + ' not found in first expression';
      }
    }
    for (const concept of other.concepts) {
      if (!this.hasConcept(concept)) {
        return 'concept ' + concept.describe() + ' not found in second expression';
      }
    }

    // Check refinements
    for (const refinement of this.refinements) {
      if (!other.hasRefinement(refinement)) {
        return 'refinement ' + refinement.describe() + ' not found in first expression';
      }
    }
    for (const refinement of other.refinements) {
      if (!this.hasRefinement(refinement)) {
        return 'refinement ' + refinement.describe() + ' not found in second expression';
      }
    }

    // Check refinement groups
    for (const group of this.refinementGroups) {
      if (!other.hasRefinementGroup(group)) {
        return 'refinement group ' + group.describe() + ' not found in first expression';
      }
    }
    for (const group of other.refinementGroups) {
      if (!this.hasRefinementGroup(group)) {
        return 'refinement group ' + group.describe() + ' not found in second expression';
      }
    }

    return '';
  }

  /**
   * Get a string description of this expression
   */
  describe() {
    const parts = [];

    // Status prefix
    switch (this.status) {
      case SnomedExpressionStatus.Equivalent:
        parts.push('===');
        break;
      case SnomedExpressionStatus.SubsumedBy:
        parts.push('<<<');
        break;
    }

    // Concepts
    parts.push(...this.concepts.map(c => c.describe()));

    // Refinements
    parts.push(...this.refinements.map(r => r.describe()));

    // Refinement groups
    parts.push(...this.refinementGroups.map(g => g.describe()));

    return parts.join(',');
  }

  /**
   * Create a canonical form of this expression (sorted and normalized)
   */
  canonical() {
    const result = new SnomedExpression();
    result.status = this.status;

    // Copy and sort concepts
    for (const concept of this.concepts) {
      result.concepts.push(concept.canonical());
    }

    // Convert refinements and groups to canonical form
    if (this.hasRefinementGroups() || this.hasRefinements()) {
      // Copy refinement groups
      for (const group of this.refinementGroups) {
        if (group.refinements.length > 0) {
          result.refinementGroups.push(group.canonical());
        }
      }

      // Convert individual refinements to single-refinement groups
      for (const refinement of this.refinements) {
        const group = new SnomedRefinementGroup();
        group.refinements.push(refinement.canonical());
        result.refinementGroups.push(group);
      }
    }

    // Sort everything
    result.concepts.sort((a, b) => a.compare(b));

    if (result.hasRefinementGroups()) {
      for (const group of result.refinementGroups) {
        group.refinements.sort((a, b) => a.compare(b));
      }
      result.refinementGroups.sort((a, b) => a.compare(b));
    }

    return result;
  }

  /**
   * Merge another expression into this one
   */
  merge(exp) {
    if (exp) {
      this.concepts.push(...exp.concepts);
      this.refinements.push(...exp.refinements);
      this.refinementGroups.push(...exp.refinementGroups);
    }
  }
}

/**
 * Parser for SNOMED CT expression strings
 */
class SnomedExpressionParser {
  /**
   * @param {SnomedConceptList} conceptList - list of all snomed concepts
   */
  constructor(conceptList) {
    this.source = '';
    this.cursor = 0;
    this.conceptList = conceptList;
  }

  /**
   * Parse a SNOMED expression string
   */
  parse(source) {
    this.source = source;
    this.cursor = 0;

    const result = new SnomedExpression();
    result.start = this.cursor;

    this.ws();

    // Check for status prefix
    if (this.peek() === '=') {
      result.status = SnomedExpressionStatus.Equivalent;
      this.prefix('=');
    } else if (this.peek() === '<') {
      result.status = SnomedExpressionStatus.SubsumedBy;
      this.prefix('<');
    }

    // Parse main expression
    result.concepts.push(this.concept());
    while (this.gchar('+')) {
      result.concepts.push(this.concept());
    }

    if (this.gchar(':')) {
      this.ws();
      this.refinements(result);
    }

    result.stop = this.cursor;

    this.rule(this.peek() === '\0', 'Found content ("' + this.peekDisp() + '") after end of expression');

    return result;
  }

  /**
   * Parse a concept
   */
  concept() {
    const result = new SnomedConcept();
    result.start = this.cursor;

    this.ws();

    if (this.peek() === '#') {
      result.decimal = this.decimal();
    } else if (this.peek() === '"') {
      result.literal = this.stringConstant();
    } else {
      result.code = this.conceptId();
      if (this.conceptList) {
        const found = this.conceptList.findConcept(result.code)
        this.rule(found.found, 'Concept "' + result.code + '" not valid');
        result.reference = found.index;
      } else {
        result.reference = 0;
      }
    }

    this.ws();

    if (this.gchar('|')) {
      this.ws();
      result.description = this.term().trim();
      this.ws();
      this.fixed('|');
      this.ws();
    }

    result.stop = this.cursor;
    return result;
  }

  /**
   * Parse refinements for an expression
   *
   * The compositional grammar ABNF is
   *   refinement   = (attributeSet / attributeGroup) *( ws ["," ws] attributeGroup )
   *   attributeSet = attribute *(ws "," ws attribute)
   * so a comma is required between the ungrouped attributes of the attribute set, but is
   * OPTIONAL before an attribute group. Requiring it everywhere rejected the minimal
   * rendering this parser's own renderer produces (e.g. 249943000:260868000=6934004{...}).
   *
   * We stay liberal in what we accept: a group may also be followed by further ungrouped
   * attributes, which the ABNF does not allow but which this parser has always taken.
   */
  refinements(expr) {
    this.ws();

    let first = true;
    for (;;) {
      if (!first) {
        const mark = this.cursor;
        const comma = this.gchar(',');
        this.ws();
        if (this.peek() !== '{' && !comma) {
          // neither a separating comma nor a group: the refinements are finished
          this.cursor = mark;
          break;
        }
      }

      if (this.peek() === '{') {
        expr.refinementGroups.push(this.attributeGroup());
      } else {
        expr.refinements.push(this.attribute());
      }
      this.ws();
      first = false;
    }
  }

  /**
   * Parse an attribute group
   */
  attributeGroup() {
    const result = new SnomedRefinementGroup();

    this.fixed('{');
    this.ws();
    result.start = this.cursor;

    result.refinements.push(this.attribute());
    while (this.gchar(',')) {
      result.refinements.push(this.attribute());
    }

    result.stop = this.cursor;
    this.ws();
    this.fixed('}');
    this.ws();

    return result;
  }

  /**
   * Parse an attribute (refinement)
   */
  attribute() {
    const result = new SnomedRefinement();
    result.start = this.cursor;

    result.name = this.attributeName();
    this.fixed('=');
    result.value = this.attributeValue();
    this.ws();

    result.stop = this.cursor;
    return result;
  }

  /**
   * Parse an attribute name
   */
  attributeName() {
    const result = new SnomedConcept();
    result.start = this.cursor;

    this.ws();
    result.code = this.conceptId();
    // Resolve the attribute name the same way concept() resolves a focus concept. Without this
    // the name keeps NO_REFERENCE, and SnomedConcept.matches() then compares by reference on one
    // side and by code on the other, which makes refinement matching (and so subsumption between
    // two refined expressions) asymmetric.
    if (this.conceptList) {
      const found = this.conceptList.findConcept(result.code);
      this.rule(found.found, 'Concept "' + result.code + '" not valid');
      result.reference = found.index;
    }
    this.ws();

    if (this.gchar('|')) {
      this.ws();
      result.description = this.term();
      this.ws();
      this.fixed('|');
      this.ws();
    }

    result.stop = this.cursor;
    return result;
  }

  /**
   * Parse an attribute value
   */
  attributeValue() {
    this.ws();

    if (this.gchar('(')) {
      const result = this.expression();
      this.fixed(')');
      return result;
    } else {
      return this.expression();
    }
  }

  /**
   * Parse a sub-expression
   */
  expression() {
    const result = new SnomedExpression();
    result.start = this.cursor;

    this.ws();
    result.concepts.push(this.concept());

    while (this.gchar('+')) {
      result.concepts.push(this.concept());
    }

    if (this.gchar(':')) {
      this.ws();
      this.refinements(result);
    }

    result.stop = this.cursor;
    return result;
  }

  /**
   * Parse a concept ID (sequence of digits)
   */
  conceptId() {
    let result = '';

    while (this.isDigit(this.peek())) {
      result += this.next();
    }

    this.rule(result.length > 0, 'Concept not found (next char = "' + this.peekDisp() + '", in "' + this.source + '")');
    return result;
  }

  /**
   * Parse a decimal number
   */
  decimal() {
    let result = '';
    this.fixed('#');

    while (this.isDigit(this.peek()) || this.peek() === '.') {
      result += this.next();
    }

    return result;
  }

  /**
   * Parse a term (text between | characters)
   */
  term() {
    let result = '';

    while (this.peek() !== '|') {
      result += this.next();
    }

    return result;
  }

  /**
   * Parse a string constant
   */
  stringConstant() {
    let result = '';
    this.fixed('"');

    while (this.peek() !== '"' && this.peek() !== '\0') {
      if (result.length > MAX_TERM_LENGTH) {
        throw new Error('Constant too long (>' + MAX_TERM_LENGTH + ' chars) at character ' + this.cursor);
      }
      result += this.next();
    }

    if (this.peek() === '\0') {
      throw new Error('Unterminated Constant at character ' + this.cursor);
    }

    this.fixed('"');
    return result;
  }

  /**
   * Skip whitespace
   */
  ws() {
    while (this.isWhitespace(this.peek())) {
      this.next();
    }
  }

  /**
   * Try to consume a specific character
   */
  gchar(c) {
    const result = this.peek() === c;
    if (result) {
      this.next();
    }
    return result;
  }

  /**
   * Require a specific character
   */
  fixed(c) {
    const success = this.gchar(c);
    this.rule(success, 'Expected character "' + c + '" but found ' + this.peek());
    this.ws();
  }

  /**
   * Require a three-character prefix
   */
  prefix(c) {
    this.fixed(c);
    this.fixed(c);
    this.fixed(c);
    this.ws();
  }

  /**
   * Get the next character and advance cursor
   */
  next() {
    const result = this.peek();
    this.cursor++;
    return result;
  }

  /**
   * Peek at the current character
   */
  peek() {
    if (this.cursor >= this.source.length) {
      return '\0';
    }
    return this.source[this.cursor];
  }

  /**
   * Get a display string for the current character
   */
  peekDisp() {
    if (this.cursor >= this.source.length) {
      return '[n/a: overrun]';
    }
    return this.source[this.cursor];
  }

  /**
   * Assert a rule and throw if it fails
   */
  rule(test, message) {
    if (!test) {
      throw new Error(message + ' at character ' + (this.cursor+1));
    }
  }

  /**
   * Check if character is a digit
   */
  isDigit(c) {
    return c >= '0' && c <= '9';
  }

  /**
   * Check if character is whitespace
   */
  isWhitespace(c) {
    return c === ' ' || c === '\t' || c === '\n' || c === '\r';
  }
}

// Render options for expressions
const SnomedServicesRenderOption = {
  Minimal: 0,
  AsIs: 1,
  FillMissing: 2,
  ReplaceAll: 3
};

// Refinement group match states
const SnomedRefinementGroupMatchState = {
  NoMatch: 0,
  Identical: 1,
  Subsumed: 2
};

/**
 * Represents a matching concept with optional unmatched refinement groups
 */
class MatchingConcept {
  constructor(code, unmatchedGroups = null) {
    this.code = code;
    this.unmatchedGroups = unmatchedGroups || [];
  }
}

/**
 * SNOMED CT Expression Services
 * Provides comprehensive expression processing capabilities
 */
class SnomedExpressionServices {
  constructor(snomedStructures, isAIndex) {
    this.strings = snomedStructures.strings;
    this.words = snomedStructures.words;
    this.stems = snomedStructures.stems;
    this.refs = snomedStructures.refs;
    this.descriptions = snomedStructures.descriptions;
    this.descriptionIndex = snomedStructures.descriptionIndex;
    this.concepts = snomedStructures.concepts;
    this.relationships = snomedStructures.relationships;
    this.refSetMembers = snomedStructures.refSetMembers;
    this.refSetIndex = snomedStructures.refSetIndex;

    this.isAIndex = isAIndex;
    this.defaultLanguage = 1; // Default to English
    this.building = false; // Set to true during import
    this.assumeClassified = true; // Optimization flag
  }

  /**
   * Condense an expression to find matching concepts
   */
  condenseExpression(exp) {
    const grps = [];

    // Add all refinement groups
    grps.push(...exp.refinementGroups);

    // Convert individual refinements to single-refinement groups
    for (const ref of exp.refinements) {
      const grp = new SnomedRefinementGroup();
      grp.refinements.push(ref);
      grps.push(grp);
    }

    const result = [];

    if (exp.concepts.length === 1) {
      if (grps.length === 0) {
        result.push(new MatchingConcept(exp.concepts[0].code));
      } else {
        this.findMatchingConcepts(result, exp.concepts[0].reference, grps);
      }
    }

    if (result.length === 0) {
      throw new Error(`No matches found for ${exp.describe()}`);
    }

    return result;
  }

  /**
   * Get defining relationships for a concept
   */
  getDefiningRelationships(conceptIndex) {
    const concept = this.concepts.getConcept(conceptIndex);
    const outboundIndex = concept.outbounds;

    if (outboundIndex === 0) {
      return [];
    }

    const result = [];
    const outbounds = this.refs.getReferences(outboundIndex);

    for (const relIndex of outbounds) {
      const rel = this.relationships.getRelationship(relIndex);

      // Only include active defining relationships that are not is-a
      if (rel.active && rel.defining && rel.relType !== this.isAIndex) {
        result.push(relIndex);
      }
    }

    return result;
  }

  /**
   * Check if groups match exactly
   */
  groupsMatch(a, b) {
    for (const refA of a.refinements) {
      let refB = null;

      // Find matching refinement by name
      for (const testRef of b.refinements) {
        if (refA.name.matches(testRef.name)) {
          refB = testRef;
          break;
        }
      }

      if (!refB) {
        return false;
      }

      // Check if values are equivalent
      if (!this.expressionsEquivalent(refA.value, refB.value)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Parse expression string
   */
  parseExpression(source) {
    const parser = new SnomedExpressionParser();
    const result = parser.parse(source);
    this.checkExpression(result);
    return result;
  }

  /**
   * Check if two expressions are equivalent
   */
  expressionsEquivalent(a, b) {
    const e1 = a.canonical();
    const e2 = b.canonical();

    const match = e1.matches(e2);
    return match === '';
  }

  /**
   * Create defined expression from concept
   */
  createDefinedExpression(reference, exp, ancestor = false) {
    if (this.isPrimitive(reference)) {
      if (!exp.hasConcept(reference)) {
        const concept = new SnomedConcept(reference);
        concept.code = this.getConceptId(reference);
        exp.concepts.push(concept);
      }
    } else {
      // Add parent concepts
      const parents = this.getConceptParents(reference);
      for (const parent of parents) {
        this.createDefinedExpression(parent, exp, true);
      }

      if (!ancestor || !this.assumeClassified) {
        const groups = new Map(); // Group number -> refinement group

        // Process defining relationships
        const definingRels = this.getDefiningRelationships(reference);
        for (const relIndex of definingRels) {
          const rel = this.relationships.getRelationship(relIndex);

          const ref = new SnomedRefinement();
          ref.name = new SnomedConcept(rel.relType);
          ref.name.code = this.getConceptId(rel.relType);

          ref.value = new SnomedExpression();
          const targetConcept = new SnomedConcept(rel.target);
          targetConcept.code = this.getConceptId(rel.target);
          ref.value.concepts.push(targetConcept);

          if (rel.group === 0) {
            // Ungrouped refinement
            if (!exp.hasRefinement(ref)) {
              exp.refinements.push(ref);
            }
          } else {
            // Grouped refinement
            const groupKey = rel.group.toString();
            if (!groups.has(groupKey)) {
              groups.set(groupKey, new SnomedRefinementGroup());
            }
            groups.get(groupKey).refinements.push(ref);
          }
        }

        // Add groups to expression
        for (const grp of groups.values()) {
          if (!exp.hasRefinementGroup(grp)) {
            exp.refinementGroups.push(grp);
          }
        }
      }
    }
  }

  /**
   * Create normal form for a concept
   */
  createNormalForm(reference) {
    if (this.building) {
      const exp = new SnomedExpression();
      this.createDefinedExpression(reference, exp, false);
      return this.normaliseExpression(exp);
    } else {
      // Read from stored normal form
      const normalFormIndex = this.concepts.getNormalForm(reference);
      let source;

      if (normalFormIndex === 0) {
        source = this.getConceptId(reference);
      } else {
        source = this.strings.getEntry(normalFormIndex);
      }

      const result = new SnomedExpressionParser().parse(source);
      // Resolve concept ids to references, but do NOT run checkExpression: the MRCM rules it
      // applies are the postcoordination ones, and this is a concept's own stored definition -
      // precoordinated content, authored under MRCM content types that do not apply here. Running
      // them rejects the normal form of any concept using an attribute that is precoordinated-only
      // (e.g. 246075003 |Causative agent| on a disorder), which broke subsumption for expressions.
      this.resolveExpressionReferences(result);
      return result;
    }
  }

  /**
   * Rationalize expression by merging concepts and refinements
   */
  rationaliseExpression(exp) {
    // Merge subsumable concepts
    let i = 0;
    while (i < exp.concepts.length) {
      const c1 = exp.concepts[i];
      let j = i + 1;

      while (j < exp.concepts.length) {
        const c2 = exp.concepts[j];

        if (c1.reference !== NO_REFERENCE && c2.reference !== NO_REFERENCE) {
          if (this.subsumes(c1.reference, c2.reference)) {
            c1.copyFrom(c2);
            exp.concepts.splice(j, 1);
          } else if (this.subsumes(c2.reference, c1.reference)) {
            exp.concepts.splice(j, 1);
          } else {
            j++;
          }
        } else {
          j++;
        }
      }
      i++;
    }

    // Merge refinements
    this.mergeRefinements(exp.refinements);
    for (const group of exp.refinementGroups) {
      this.mergeRefinements(group.refinements);
    }

    // Merge refinement groups
    i = 0;
    while (i < exp.refinementGroups.length) {
      const grp1 = exp.refinementGroups[i];
      let j = i + 1;

      while (j < exp.refinementGroups.length) {
        const grp2 = exp.refinementGroups[j];

        if (this.mergeGroups(grp1, grp2)) {
          exp.refinementGroups.splice(j, 1);
        } else {
          j++;
        }
      }
      i++;
    }
  }

  /**
   * Merge refinement groups if possible
   */
  mergeGroups(grp1, grp2) {
    // Find matching attribute names
    const matches = [];
    const targets = [];

    for (const ref1 of grp1.refinements) {
      for (const ref2 of grp2.refinements) {
        if (ref1.name.reference === ref2.name.reference) {
          matches.push(ref1.name.reference);
          break;
        }
      }
    }

    if (matches.length === 0) {
      return false;
    }

    // Check subsumption for each match
    let canMerge = true;
    for (const nameRef of matches) {
      const ref1 = this.getRefinementByName(nameRef, grp1.refinements);
      const ref2 = this.getRefinementByName(nameRef, grp2.refinements);

      if (!ref1 || !ref2) {
        canMerge = false;
        break;
      }

      if (this.expressionSubsumes(ref1.value, ref2.value)) {
        targets.push(true);
      } else if (this.expressionSubsumes(ref2.value, ref1.value)) {
        targets.push(false);
      } else {
        canMerge = false;
        break;
      }
    }

    if (canMerge) {
      // Perform the merge
      for (let i = 0; i < matches.length; i++) {
        const nameRef = matches[i];
        if (targets[i]) {
          const ref1 = this.getRefinementByName(nameRef, grp1.refinements);
          const ref2 = this.getRefinementByName(nameRef, grp2.refinements);
          ref1.value = ref2.value;
        }
      }

      // Add non-matching refinements from grp2 to grp1
      for (const ref2 of grp2.refinements) {
        if (!matches.includes(ref2.name.reference)) {
          grp1.refinements.push(ref2);
        }
      }
    }

    return canMerge;
  }

  /**
   * Get refinement by name reference
   */
  getRefinementByName(nameRef, refinements) {
    for (const ref of refinements) {
      if (ref.name.reference === nameRef) {
        return ref;
      }
    }
    return null;
  }

  /**
   * Merge refinements in a list
   */
  mergeRefinements(list) {
    let i = 0;
    while (i < list.length) {
      const ref1 = list[i];
      let j = i + 1;

      while (j < list.length) {
        const ref2 = list[j];

        if (ref1.name.matches(ref2.name)) {
          if (this.expressionSubsumes(ref1.value, ref2.value)) {
            ref1.value = ref2.value;
            list.splice(j, 1);
          } else if (this.expressionSubsumes(ref2.value, ref1.value)) {
            list.splice(j, 1);
          } else {
            j++;
          }
        } else {
          j++;
        }
      }
      i++;
    }
  }

  /**
   * Normalize expression to normal form
   */
  /**
   * Expand an expression to its long normal form, ready for structural comparison.
   *
   * A fully defined concept is replaced by its definition, because that definition is
   * both necessary and sufficient. A primitive concept is NOT replaced - its definition
   * is only necessary, and substituting it would make the expression look equivalent to
   * things it merely subsumes. But the primitive's defining attributes are still
   * entailed by it, so they are added alongside the concept rather than discarded:
   * `4846001 |Anicteric viral hepatitis|` is primitive and carries an inferred
   * `363698007 |Finding site| = 10200004 |Liver structure|`, so every instance of it
   * really is a disease with that finding site, and `64572001:{363698007=10200004}`
   * really does subsume it. Dropping those attributes - which is what this used to do -
   * lost that answer and reported not-subsumed, which is simply wrong.
   *
   * Keeping the concept itself in the focus is what stops the addition being unsound in
   * the other direction: the primitive stays as an atom that nothing else can match, so
   * an expression carrying the same attributes is never reported as equivalent to it.
   *
   * @param {SnomedExpression} exp
   * @param {number} [depth] - recursion guard, see MAX_NORMALISATION_DEPTH
   * @returns {SnomedExpression}
   */
  normaliseExpression(exp, depth = 0) {
    if (depth > MAX_NORMALISATION_DEPTH) {
      // Expanding attribute values can descend a long way, and truncating silently is
      // not safe in both directions: dropping conditions from the subsuming side makes
      // it demand less and so subsume more, which would be a false positive. Fail
      // instead, and let the caller report that it could not answer.
      throw new Error(`Could not normalise the expression: it nests more than ${MAX_NORMALISATION_DEPTH}`
        + ' levels deep once concept definitions are expanded');
    }
    const work = new SnomedExpression();

    // Process concepts
    for (const concept of exp.concepts) {
      if (concept.reference === NO_REFERENCE) {
        work.concepts.push(concept);
      } else if (this.isPrimitive(concept.reference)) {
        work.concepts.push(concept);
        this.addDefiningAttributes(concept.reference, work, depth);
      } else {
        const ex = this.createNormalForm(concept.reference);
        work.merge(ex);
      }
    }

    // Process refinements
    for (const refSrc of exp.refinements) {
      const refDst = new SnomedRefinement();
      work.refinements.push(refDst);
      refDst.name = refSrc.name;
      refDst.value = this.normaliseExpression(refSrc.value, depth + 1);
    }

    // Process refinement groups
    for (const grpSrc of exp.refinementGroups) {
      const grpDst = new SnomedRefinementGroup();
      work.refinementGroups.push(grpDst);

      for (const refSrc of grpSrc.refinements) {
        const refDst = new SnomedRefinement();
        grpDst.refinements.push(refDst);
        refDst.name = refSrc.name;
        refDst.value = this.normaliseExpression(refSrc.value, depth + 1);
      }
    }

    const work2 = work.canonical();
    this.rationaliseExpression(work2);
    return work2.canonical();
  }

  /**
   * Add a concept's own defining (non is-a) relationships to an expression, as grouped
   * and ungrouped refinements with their values normalised.
   *
   * Used for primitives, whose attributes are entailed but whose concept must stay in
   * the focus - see normaliseExpression. The stored normal form cannot be used for this:
   * it is built by createDefinedExpression, which stops at a primitive too, so the
   * cached normal form of a primitive is just the concept itself. Reading the
   * relationships here means existing caches keep working rather than needing a rebuild.
   *
   * @param {number} reference - the concept whose attributes to add
   * @param {SnomedExpression} work - expression to add them to
   * @param {number} depth - current normalisation depth
   */
  addDefiningAttributes(reference, work, depth) {
    const groups = new Map();

    for (const relIndex of this.getDefiningRelationships(reference)) {
      const rel = this.relationships.getRelationship(relIndex);

      const ref = new SnomedRefinement();
      ref.name = new SnomedConcept(rel.relType);
      ref.name.code = this.getConceptId(rel.relType);

      const value = new SnomedExpression();
      const target = new SnomedConcept(rel.target);
      target.code = this.getConceptId(rel.target);
      value.concepts.push(target);
      ref.value = this.normaliseExpression(value, depth + 1);

      if (rel.group === 0) {
        if (!work.hasRefinement(ref)) {
          work.refinements.push(ref);
        }
      } else {
        const key = rel.group.toString();
        if (!groups.has(key)) {
          groups.set(key, new SnomedRefinementGroup());
        }
        groups.get(key).refinements.push(ref);
      }
    }

    for (const grp of groups.values()) {
      if (!work.hasRefinementGroup(grp)) {
        work.refinementGroups.push(grp);
      }
    }
  }

  /**
   * Check if expression a subsumes expression b
   */
  expressionSubsumes(a, b) {
    if (a.isSimple() && b.isSimple()) {
      return this.subsumes(a.concepts[0].reference, b.concepts[0].reference);
    }

    const e1 = this.normaliseExpression(a);
    const e2 = this.normaliseExpression(b);

    // Check root concepts
    for (const c of e1.concepts) {
      let ok = false;
      for (const ct of e2.concepts) {
        if (this.subsumesConcept(c, ct)) {
          ok = true;
          break;
        }
      }
      if (!ok) {
        return false;
      }
    }

    // Check refinement groups. Every group in e1 has to be satisfied by SOME group in e2 - try
    // them all rather than only the first one whose attribute names line up. Two normalisations
    // of the same expression can put equivalent groups in a different order, and when several
    // groups share the same attribute names (e.g. two morphology/site groups on one disorder)
    // picking the first match and giving up made subsumption depend on that order.
    for (const r of e1.refinementGroups) {
      let ok = false;
      for (const rt of e2.refinementGroups) {
        if (this.subsumesGroup(r, rt)) {
          ok = true;
          break;
        }
      }
      if (!ok) {
        return false;
      }
    }

    return true;
  }

  /**
   * Check if concept a subsumes concept b
   */
  subsumesConcept(a, b) {
    if (a.matches(b)) {
      return true;
    }

    return (a.reference !== NO_REFERENCE) &&
      (b.reference !== NO_REFERENCE) &&
      this.subsumes(a.reference, b.reference);
  }

  /**
   * Check if group a subsumes group b
   */
  subsumesGroup(a, b) {
    for (const refA of a.refinements) {
      let refB = null;

      for (const testRef of b.refinements) {
        if (refA.name.matches(testRef.name)) {
          refB = testRef;
          break;
        }
      }

      if (!refB) {
        return false;
      }

      if (!this.expressionSubsumes(refA.value, refB.value)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Find matching group in expression
   */
  findMatchingGroup(r, exp) {
    for (const t of exp.refinementGroups) {
      let all = true;

      for (const refs of r.refinements) {
        let match = false;
        for (const reft of t.refinements) {
          if (refs.name.matches(reft.name)) {
            match = true;
            break;
          }
        }
        if (!match) {
          all = false;
          break;
        }
      }

      if (all) {
        return t;
      }
    }

    return null;
  }

  /**
   * Find concepts matching refinement patterns
   */
  findMatchingConcepts(list, reference, refinements) {
    const children = this.getConceptChildren(reference);

    for (const child of children) {
      const conceptId = this.getConceptId(child);
      const exp = new SnomedExpression();
      this.createDefinedExpression(child, exp, false);

      // Convert ungrouped refinements to groups
      for (const ref of exp.refinements) {
        const grp = new SnomedRefinementGroup();
        exp.refinementGroups.push(grp);
        grp.refinements.push(ref);
      }
      exp.refinements.length = 0;

      let allMatched = true;
      let oneUnMatched = false;
      const matchedGroups = [];

      for (const grp of exp.refinementGroups) {
        const state = this.checkGroupStateInRefinements(grp, refinements, matchedGroups);
        if (state === SnomedRefinementGroupMatchState.NoMatch) {
          oneUnMatched = true;
        } else if (state !== SnomedRefinementGroupMatchState.Identical) {
          allMatched = false;
        }
      }

      if (oneUnMatched) {
        // Neither this nor children will match
        continue;
      } else if (allMatched && matchedGroups.length > 0) {
        // Complete match
        list.push(new MatchingConcept(conceptId));
      } else {
        // Partial match - continue searching
        const nonMatchingGroups = this.listNonMatchingGroups(refinements, matchedGroups);
        if (nonMatchingGroups.length < refinements.length) {
          list.push(new MatchingConcept(conceptId, nonMatchingGroups));
        }
        this.findMatchingConcepts(list, child, nonMatchingGroups);
      }
    }
  }

  /**
   * Check group state in refinements
   */
  checkGroupStateInRefinements(grp, refinements, matchedGroups) {
    for (const g of refinements) {
      if (this.groupsMatch(grp, g)) {
        matchedGroups.push(g);
        return SnomedRefinementGroupMatchState.Identical;
      } else if (this.subsumesGroup(grp, g)) {
        return SnomedRefinementGroupMatchState.Subsumed;
      }
    }
    return SnomedRefinementGroupMatchState.NoMatch;
  }

  /**
   * List non-matching groups
   */
  listNonMatchingGroups(target, source) {
    const result = [];

    for (const g of target) {
      const r = this.findMatchingGroupInList(g, source);
      if (!r) {
        result.push(g);
      }
    }

    return result;
  }

  /**
   * Find matching group in list
   */
  findMatchingGroupInList(r, groups) {
    for (const t of groups) {
      let all = true;

      for (const refs of r.refinements) {
        let match = false;
        for (const reft of t.refinements) {
          if (refs.name.matches(reft.name)) {
            match = true;
            break;
          }
        }
        if (!match) {
          all = false;
          break;
        }
      }

      if (all) {
        return t;
      }
    }

    return null;
  }

  /**
   * Resolve every concept id in an expression to its internal reference, without applying any
   * of the concept model rules. Used for expressions the server generated itself (normal forms),
   * where the ids are known good and the MRCM postcoordination rules do not apply
   * @param {SnomedExpression} expression
   */
  resolveExpressionReferences(expression) {
    for (const concept of expression.concepts) {
      this.checkConcept(concept);
    }
    for (const refinement of expression.refinements) {
      this.checkConcept(refinement.name);
      this.resolveExpressionReferences(refinement.value);
    }
    for (const group of expression.refinementGroups) {
      for (const refinement of group.refinements) {
        this.checkConcept(refinement.name);
        this.resolveExpressionReferences(refinement.value);
      }
    }
  }

  /**
   * Validate expression structure and concept references
   */
  checkExpression(expression) {
    for (const concept of expression.concepts) {
      this.checkConcept(concept);
    }

    if (expression.hasRefinements()) {
      for (const refinement of expression.refinements) {
        this.checkRefinement(refinement);
        this.checkRefinementDomain(expression, refinement);
        this.checkRefinementRange(refinement);
        this.checkRefinementGrouped(refinement);
      }
    }

    if (expression.hasRefinementGroups()) {
      for (const group of expression.refinementGroups) {
        for (const refinement of group.refinements) {
          this.checkRefinement(refinement);
          this.checkRefinementDomain(expression, refinement);
          this.checkRefinementRange(refinement);
        }
      }
    }

    this.checkExpressionCardinality(expression);
  }

  /**
   * Check one refinement against the MRCM attribute domain reference set: the
   * focus concept the attribute is applied to must be in the attribute's domain.
   *
   * Every applicable rule must hold, mandatory or optional. Internationally
   * there is exactly one optional rule - Laterality in the lateralizable body
   * structure reference set - and it is the rule that stops laterality being
   * applied to a structure that cannot be lateralized, so it is enforced.
   *
   * Attributes with no rule in this edition's MRCM are not checked, and neither
   * is cardinality (checkExpressionCardinality), grouping (checkRefinementGrouped)
   * or the range constraint (checkRefinementRange, which needs ECL).
   *
   * @param {SnomedExpression} expression - the expression the refinement is on
   * @param {SnomedRefinement} refinement
   */
  checkRefinementDomain(expression, refinement) {
    const attribute = refinement.name ? refinement.name.reference : NO_REFERENCE;
    if (attribute === undefined || attribute === null || attribute === NO_REFERENCE) {
      return;
    }
    const rules = this.mrcmAttributeDomains().get(attribute);
    if (!rules || rules.length === 0) {
      // This edition's concept model says nothing about this attribute (3 active
      // attributes internationally have no domain rule and appear in no
      // postcoordination domain template), so there is nothing to check it against.
      return;
    }

    // The focus may be a conjunction of concepts; the expression is a subtype of
    // each of them, so the attribute is in domain if any focus concept is.
    const focus = [];
    for (const concept of expression.concepts) {
      if (concept.reference !== undefined && concept.reference !== null && concept.reference !== NO_REFERENCE) {
        focus.push(concept.reference);
      }
    }
    if (focus.length === 0) {
      return;
    }

    // Report every rule that failed, not just the first: a laterality on a
    // disorder breaks both the anatomical structure domain and the lateralizable
    // refset rule, and naming only one of them misleads.
    const failed = [];
    for (const rule of rules) {
      const ok = focus.some(f => rule.isRefset
        ? this.conceptInRefSet(rule.domain, f)
        : this.subsumes(rule.domain, f));
      if (!ok) {
        failed.push((rule.isRefset ? 'for concepts in ' : 'in the domain ') + this.describeConceptForMessage(rule.domain));
      }
    }
    if (failed.length > 0) {
      const attrDesc = this.describeConceptForMessage(attribute);
      const focusDesc = focus.map(f => this.describeConceptForMessage(f)).join(' + ');
      throw new Error(`The SNOMED CT concept model does not allow the attribute ${attrDesc} on ${focusDesc}`
        + ` (the attribute is only valid ${failed.join(', and ')})`);
    }
  }

  /**
   * Check that an attribute the MRCM marks as grouped is actually in a relationship
   * group. This is only ever called for refinements that are NOT in a group.
   *
   * The MRCM attribute domain reference set carries a `grouped` flag per rule, and it
   * is a real constraint rather than a stylistic preference: `363698007 |Finding site|`
   * is grouped, so `40468003:363698007=10200004` is not a valid expression even though
   * every part of it is - it has to be written `40468003:{363698007=10200004}`. The
   * distinction matters because a group is what ties an attribute to the others that
   * apply with it, and an expression that omits the braces has not said which.
   *
   * SNOMED's postcoordination guide calls the ungrouped form Close To User Form and
   * defines a transformation ("Adding a Self-grouped Attribute") that converts it to
   * the Classifiable Form. That transformation is not implemented here, so the
   * ungrouped form is rejected rather than silently repaired: telling the caller their
   * expression is not classifiable is honest, quietly guessing what they meant is not.
   *
   * As elsewhere in this check, an attribute with no rule in this edition's MRCM is
   * left alone, and where several rules apply the strictest wins.
   *
   * @param {SnomedRefinement} refinement - a refinement outside any group
   */
  checkRefinementGrouped(refinement) {
    const attribute = refinement.name ? refinement.name.reference : NO_REFERENCE;
    if (attribute === undefined || attribute === null || attribute === NO_REFERENCE) {
      return;
    }
    const rules = this.mrcmAttributeDomains().get(attribute);
    if (!rules || rules.length === 0) {
      return;
    }
    if (!rules.some(rule => rule.grouped)) {
      return;
    }
    const attrDesc = this.describeConceptForMessage(attribute);
    throw new Error(`The SNOMED CT concept model requires the attribute ${attrDesc} to be in a`
      + ` relationship group, so it cannot be used ungrouped (write it as {${attrDesc} = ...})`);
  }

  /**
   * The MRCM attribute domain reference set, indexed by attribute concept.
   * Built once per edition and cached; an edition with no MRCM yields an empty
   * map, which turns the domain check off rather than failing.
   *
   * @returns {Map<number, Array<{domain: number, isRefset: boolean, grouped: boolean, max: number, maxInGroup: number}>>}
   */
  mrcmAttributeDomains() {
    if (this._mrcmAttributeDomains) {
      return this._mrcmAttributeDomains;
    }
    const rules = new Map();
    this._mrcmAttributeDomains = rules;

    const refSet = this.findRefSetByConceptId(MRCM_ATTRIBUTE_DOMAIN_REFSET);
    if (!refSet) {
      return rules; // no MRCM in this edition
    }
    const contentAll = this.conceptIndexOf(MRCM_CONTENT_TYPE_ALL);
    const contentPost = this.conceptIndexOf(MRCM_CONTENT_TYPE_POSTCOORDINATED);

    // Every concept that defines a reference set, so a domain that is itself a
    // reference set (the lateralizable body structure refset) is tested by
    // membership rather than subsumption.
    const refSetConcepts = new Set();
    for (let i = 0; i < this.refSetIndex.count(); i++) {
      refSetConcepts.add(this.refSetIndex.getReferenceSet(i).definition);
    }

    const members = this.refSetMembers.getMembers(refSet.membersByRef) || [];
    for (const member of members) {
      if (member.kind !== 0) {
        continue; // concept members only
      }
      // Additional columns are stored as (value, type) pairs, in file order:
      // domainId, grouped, attributeCardinality, attributeInGroupCardinality,
      // ruleStrengthId, contentTypeId.
      const values = this.refs.getReferences(member.values);
      if (!values || values.length < 12) {
        continue;
      }
      const domain = values[0];
      const contentType = values[10];
      if (contentType !== contentAll && contentType !== contentPost) {
        continue; // a rule about authoring precoordinated concepts
      }
      // The importer stores 0 for a referenced component it could not resolve,
      // which would otherwise read as a domain of whichever concept sorts first.
      if (domain === 0) {
        continue;
      }
      let list = rules.get(member.ref);
      if (!list) {
        list = [];
        rules.set(member.ref, list);
      }
      list.push({
        domain: domain,
        isRefset: refSetConcepts.has(domain),
        // The grouped column is a plain 0/1 (type 4), not a reference into the string
        // table like the cardinalities beside it - reading it as one yields garbage.
        grouped: values[2] === 1,
        // Only the maximums are enforced. A minimum ("1..1") says a concept in
        // this domain must have the attribute in its own definition; it does not
        // say a refinement of that concept has to restate it.
        max: this.parseCardinalityMax(values[4]),          // attributeCardinality
        maxInGroup: this.parseCardinalityMax(values[6])    // attributeInGroupCardinality
      });
    }
    return rules;
  }

  /**
   * Check one refinement's value against the MRCM attribute range: the range is
   * an ECL constraint, so this only runs when an evaluator has been injected
   * (`eclConstraintMatcher`, set by SnomedServices, which owns the ECL engine).
   * A matcher that returns null - an unparseable or unsupported constraint, such
   * as the concrete-value ranges "dec(>#0..)" - leaves the value unchecked
   * rather than rejecting it.
   *
   * @param {SnomedRefinement} refinement
   */
  checkRefinementRange(refinement) {
    const attribute = refinement.name ? refinement.name.reference : NO_REFERENCE;
    if (attribute === undefined || attribute === null || attribute === NO_REFERENCE) {
      return;
    }
    const constraint = this.mrcmAttributeRanges().get(attribute);
    if (!constraint || !refinement.value) {
      return;
    }

    // A concrete value range (dec/int/str) is checked here; everything else is
    // ECL and needs the evaluator the provider injects.
    const concreteRange = this.parseConcreteRange(constraint);
    const value = this.concreteValueOf(refinement.value);
    let ok;
    if (concreteRange) {
      ok = this.concreteValueSatisfies(concreteRange, value);
    } else if (value !== null) {
      ok = false; // a concrete value where the model wants a concept
    } else if (!this.eclConstraintMatcher) {
      return;
    } else {
      try {
        ok = this.eclConstraintMatcher(constraint, refinement.value);
      } catch (error) {
        ok = null; // the evaluator could not decide; do not invent a violation
      }
    }
    // null = could not decide: a constraint naming concepts this edition does not carry.
    if (ok === false) {
      const concrete = this.concreteValueOf(refinement.value);
      const value = concrete !== null ? concrete.text : (refinement.value.concepts || [])
        .filter(c => c.reference !== undefined && c.reference !== null && c.reference !== NO_REFERENCE)
        .map(c => this.describeConceptForMessage(c.reference)).join(' + ');
      throw new Error(`The SNOMED CT concept model does not allow ${value || 'this value'}`
        + ` as the value of the attribute ${this.describeConceptForMessage(attribute)}`
        + ` (the value must satisfy "${constraint}")`);
    }
  }

  /**
   * Parse an MRCM concrete value range such as "dec(>#0..)", "int(#1..#10)" or
   * "str(...)". Returns null for anything that is not one - those are ECL.
   *
   * @param {string} constraint
   * @returns {{type: string, lowOp: string, low: number, highOp: string, high: number}|null}
   */
  parseConcreteRange(constraint) {
    const match = /^\s*(dec|int|str)\s*\((.*)\)\s*$/.exec(constraint || '');
    if (!match) {
      return null;
    }
    const range = { type: match[1], lowOp: null, low: null, highOp: null, high: null };
    if (range.type === 'str') {
      return range; // no ordering on strings; only the type is checked
    }
    const parts = /^\s*([<>]=?)?\s*#?(-?\d+(?:\.\d+)?)?\s*\.\.\s*([<>]=?)?\s*#?(-?\d+(?:\.\d+)?)?\s*$/.exec(match[2]);
    if (!parts) {
      return range; // bounds we do not understand: the type check still applies
    }
    if (parts[2] !== undefined) { range.lowOp = parts[1] || '>='; range.low = parseFloat(parts[2]); }
    if (parts[4] !== undefined) { range.highOp = parts[3] || '<='; range.high = parseFloat(parts[4]); }
    return range;
  }

  /**
   * The concrete value a refinement value carries, if it is one: SCG writes these
   * as #500 or "text" rather than as a concept.
   *
   * @param {SnomedExpression} expression - a refinement's value
   * @returns {{number: number|null, string: string|null, text: string}|null}
   */
  concreteValueOf(expression) {
    if (!expression || (expression.refinements || []).length > 0 || (expression.refinementGroups || []).length > 0) {
      return null;
    }
    const concepts = expression.concepts || [];
    if (concepts.length !== 1) {
      return null;
    }
    const concept = concepts[0];
    if (concept.decimal !== undefined && concept.decimal !== null && concept.decimal !== '') {
      return { number: parseFloat(concept.decimal), string: null, text: '#' + concept.decimal };
    }
    if (concept.literal !== undefined && concept.literal !== null && concept.literal !== '') {
      return { number: null, string: concept.literal, text: JSON.stringify(concept.literal) };
    }
    return null;
  }

  /**
   * @param {Object} range - from parseConcreteRange
   * @param {Object|null} value - from concreteValueOf
   * @returns {boolean}
   */
  concreteValueSatisfies(range, value) {
    if (value === null) {
      return false; // a concept where the model wants a concrete value
    }
    if (range.type === 'str') {
      return value.string !== null;
    }
    if (value.number === null || !isFinite(value.number)) {
      return false;
    }
    if (range.type === 'int' && !Number.isInteger(value.number)) {
      return false;
    }
    if (range.low !== null) {
      if (range.lowOp === '>' && !(value.number > range.low)) return false;
      if (range.lowOp === '>=' && !(value.number >= range.low)) return false;
    }
    if (range.high !== null) {
      if (range.highOp === '<' && !(value.number < range.high)) return false;
      if (range.highOp === '<=' && !(value.number <= range.high)) return false;
    }
    return true;
  }

  /**
   * The MRCM attribute range reference set, indexed by attribute concept, as the
   * rangeConstraint ECL string.
   *
   * Where an attribute has a range specifically for postcoordinated content
   * (contentTypeId 723594008) that one replaces the general "all content" range
   * rather than adding to it - 11 attributes internationally do this. After that
   * rule every attribute has exactly one applicable constraint, so there is no
   * question of ANDing or ORing them.
   *
   * @returns {Map<number, string>}
   */
  mrcmAttributeRanges() {
    if (this._mrcmAttributeRanges) {
      return this._mrcmAttributeRanges;
    }
    const ranges = new Map();
    this._mrcmAttributeRanges = ranges;

    const refSet = this.findRefSetByConceptId(MRCM_ATTRIBUTE_RANGE_REFSET);
    if (!refSet) {
      return ranges;
    }
    const contentAll = this.conceptIndexOf(MRCM_CONTENT_TYPE_ALL);
    const contentPost = this.conceptIndexOf(MRCM_CONTENT_TYPE_POSTCOORDINATED);
    const fromPostRow = new Set();

    const members = this.refSetMembers.getMembers(refSet.membersByRef) || [];
    for (const member of members) {
      if (member.kind !== 0) {
        continue;
      }
      // (value, type) pairs: rangeConstraint, attributeRule, ruleStrengthId, contentTypeId
      const values = this.refs.getReferences(member.values);
      if (!values || values.length < 8) {
        continue;
      }
      const contentType = values[6];
      if (contentType !== contentAll && contentType !== contentPost) {
        continue;
      }
      if (ranges.has(member.ref) && fromPostRow.has(member.ref) && contentType !== contentPost) {
        continue; // keep the postcoordination-specific range
      }
      let constraint;
      try {
        constraint = this.strings.getEntry(values[0]);
      } catch (error) {
        continue;
      }
      if (!constraint) {
        continue;
      }
      ranges.set(member.ref, constraint);
      if (contentType === contentPost) {
        fromPostRow.add(member.ref);
      }
    }
    return ranges;
  }

  /**
   * The upper bound from an MRCM cardinality string such as "0..1", "0..*" or
   * "0..0". Returns Infinity for "*", and Infinity for anything unparseable, so
   * a value we do not understand cannot invent a violation.
   *
   * @param {number} stringRef - offset of the cardinality string
   * @returns {number}
   */
  parseCardinalityMax(stringRef) {
    let text;
    try {
      text = this.strings.getEntry(stringRef);
    } catch (error) {
      return Infinity;
    }
    const match = /^\s*\d+\s*\.\.\s*(\d+|\*)\s*$/.exec(text || '');
    if (!match) {
      return Infinity;
    }
    return match[1] === '*' ? Infinity : parseInt(match[1], 10);
  }

  /**
   * Check the MRCM cardinality of the attributes used on one expression:
   * attributeCardinality caps how often an attribute may appear on the concept
   * at all, and attributeInGroupCardinality caps how often it may appear within
   * a single relationship group - a maximum of 0 there is how the MRCM says an
   * attribute is ungrouped (all 37 ungrouped attributes carry "0..0").
   *
   * Rules are ANDed, so where an attribute has several rules the tightest
   * maximum applies. Nested value expressions are checked separately, when
   * checkRefinement recurses into them.
   *
   * @param {SnomedExpression} expression
   */
  checkExpressionCardinality(expression) {
    const domains = this.mrcmAttributeDomains();
    if (domains.size === 0) {
      return;
    }

    const groups = expression.hasRefinementGroups() ? expression.refinementGroups : [];
    const ungrouped = expression.hasRefinements() ? expression.refinements : [];

    const total = new Map();     // attribute -> occurrences anywhere on this expression
    const count = (refinement, into) => {
      const attribute = refinement.name ? refinement.name.reference : NO_REFERENCE;
      if (attribute === undefined || attribute === null || attribute === NO_REFERENCE) {
        return;
      }
      into.set(attribute, (into.get(attribute) || 0) + 1);
      if (into !== total) {
        total.set(attribute, (total.get(attribute) || 0) + 1);
      }
    };

    for (const refinement of ungrouped) {
      count(refinement, total);
    }
    const perGroup = [];
    for (const group of groups) {
      const counts = new Map();
      for (const refinement of group.refinements) {
        count(refinement, counts);
      }
      perGroup.push(counts);
    }

    const limit = (attribute, field) => {
      const rules = domains.get(attribute);
      if (!rules || rules.length === 0) {
        return Infinity;
      }
      return rules.reduce((least, rule) => Math.min(least, rule[field]), Infinity);
    };

    for (const [attribute, used] of total) {
      const max = limit(attribute, 'max');
      if (used > max) {
        throw new Error(`The SNOMED CT concept model allows the attribute ${this.describeConceptForMessage(attribute)}`
          + ` at most ${max} time(s) on one concept, but it is used ${used} times`);
      }
    }
    for (const counts of perGroup) {
      for (const [attribute, used] of counts) {
        const max = limit(attribute, 'maxInGroup');
        if (used > max) {
          if (max === 0) {
            throw new Error(`The SNOMED CT concept model does not allow the attribute ${this.describeConceptForMessage(attribute)}`
              + ` to appear in a relationship group`);
          }
          throw new Error(`The SNOMED CT concept model allows the attribute ${this.describeConceptForMessage(attribute)}`
            + ` at most ${max} time(s) in one relationship group, but it is used ${used} times`);
        }
      }
    }
  }

  /**
   * Is this concept a member of this reference set? Uses the per-concept list of
   * reference sets, so it costs a handful of comparisons rather than a scan of
   * the reference set's members.
   */
  conceptInRefSet(refSetConcept, conceptIndex) {
    try {
      const concept = this.concepts.getConcept(conceptIndex);
      if (!concept.refsets) {
        return false;
      }
      const list = this.refs.getReferences(concept.refsets);
      return !!list && list.includes(refSetConcept);
    } catch (error) {
      return false;
    }
  }

  findRefSetByConceptId(conceptId) {
    const index = this.conceptIndexOf(conceptId);
    if (index === null) {
      return null;
    }
    for (let i = 0; i < this.refSetIndex.count(); i++) {
      const refSet = this.refSetIndex.getReferenceSet(i);
      if (refSet.definition === index) {
        return refSet;
      }
    }
    return null;
  }

  conceptIndexOf(conceptId) {
    const result = this.concepts.findConcept(conceptId);
    return result.found ? result.index : null;
  }

  /** "11204002 |Structure of porta hepatis|", falling back to the bare id */
  describeConceptForMessage(reference) {
    const id = this.getConceptId(reference);
    try {
      const displays = this.listDisplayNames(reference, 0);
      if (displays && displays.length > 0 && displays[0].term) {
        return `${id} |${displays[0].term}|`;
      }
    } catch (error) {
      // fall through to the bare id
    }
    return id;
  }

  /**
   * Validate concept reference
   */
  checkConcept(concept, limits) {
    if (concept.code) {
      const conceptId = BigInt(concept.code);
      const result = this.concepts.findConcept(conceptId);

      if (result.found) {
        concept.reference = result.index;
      } else if (concept.code !== '111115') { // Special case for some SNOMED extensions
        throw new Error(`Concept ${concept.code} not found`);
      }
    }
    if (limits && concept.reference) {
      // if a limit is specified, then the concept has to be a specialization of one of them.
      let ok = false;
      for (const limit of limits) {
        let parentRef = this.concepts.findConcept(limit);
        let descendentsRef = this.concepts.getAllDesc(parentRef.index);
        const descendants = this.refs.getReferences(descendentsRef);
        if (descendants && descendants.includes(concept.reference)) {
          ok = true;
          break;
        }
      }
      if (!ok) {
        if (limits.length == 1) {
          throw new Error(`Concept ${concept.code} is not valid in this context (must be a ${limits[0]})`);
        } else {
          throw new Error(`Concept ${concept.code} is not valid in this context (must be a descendent of one of ${limits})`);
        }
      }
    }

    // Validate description if provided
    if (concept.reference !== NO_REFERENCE && concept.description) {
      const displayNames = this.listDisplayNames(concept.reference, 0);
      const normalizedDescription = this.normalizeText(concept.description);

      let ok = false;

      // Check if matches preferred display (first in list)
      if (displayNames.length > 0 && displayNames[0].term) {
        ok = this.normalizeText(displayNames[0].term) === normalizedDescription;
      }

      // Check all designations if not already matched
      if (!ok) {
        for (const designation of displayNames) {
          if (this.normalizeText(designation.term) === normalizedDescription) {
            ok = true;
            break;
          }
        }
      }

      if (!ok) {
        const validTerms = displayNames.map(d => d.term).join('", "');
        throw new Error(`Term "${concept.description}" doesn't match a defined term at position ${concept.start} (valid terms would be from this list: "${validTerms}")`);
      }
    }
  }

  /**
   * List all display names for a concept
   * Equivalent to Pascal ListDisplayNames procedure
   */
  // Key concept indexes for preferred-term selection (US English is the global
  // default language reference set). Mirrors the logic in cs-snomed.js so both
  // display paths agree.
  _displayConstants() {
    if (this._dispConst) return this._dispConst;
    const idx = (id) => { const r = this.concepts.findConcept(id); return r.found ? r.index : -1; };
    this._dispConst = {
      usRefset: idx(900000000000509007n),
      preferred: idx(900000000000548007n),
      synonym: idx(900000000000013009n)
    };
    return this._dispConst;
  }

  _isPreferredSynonym(description) {
    const K = this._displayConstants();
    if (description.kind !== K.synonym) return false;
    if (!description.valueses) return false;
    const valueses = this.refs.getReferences(description.valueses);
    if (!valueses) return false;
    for (let i = 0; i < valueses.length; i++) {
      const vals = this.refs.getReferences(valueses[i]); // [acceptabilityIndex, type]
      if (vals && vals.length > 0 && vals[0] === K.preferred) return true;
    }
    return false;
  }

  listDisplayNames(conceptIndex, languageFilter = 0) {
    const designations = [];

    try {
      const concept = this.concepts.getConcept(conceptIndex);
      const descriptionsRef = concept.descriptions;

      if (descriptionsRef === 0) {
        return designations; // No descriptions available
      }

      const descriptionIndices = this.refs.getReferences(descriptionsRef);

      for (let i = 0; i < descriptionIndices.length; i++) {
        const descIndex = descriptionIndices[i];
        const description = this.descriptions.getDescription(descIndex);

        // Only include active descriptions
        if (description.active) {
          // Language filtering (simplified - could be enhanced)
          if (languageFilter === 0 || description.lang === languageFilter) {
            const term = this.strings.getEntry(description.iDesc).trim();

            designations.push({
              isPreferred: this._isPreferredSynonym(description), // preferred synonym in US English
              isActive: true,
              languageCode: this.codeForLanguage(description.lang),
              term: term,
              descriptionIndex: descIndex
            });
          }
        }
      }
    } catch (error) {
      // If we can't read the concept descriptions, return empty list
      this.log.warn(`Warning: Could not read descriptions for concept ${conceptIndex}: ${error.message}`);
    }

    return designations;
  }

  /**
   * Normalize text for comparison (equivalent to Pascal normalise function)
   */
  normalizeText(text) {
    if (!text) return '';

    let result = '';
    let wasWhitespace = false;

    for (const char of text) {
      if (this.isWhitespace(char)) {
        if (!wasWhitespace) {
          result += ' ';
          wasWhitespace = true;
        }
      } else {
        result += char.toLowerCase();
        wasWhitespace = false;
      }
    }

    return result.trim();
  }

  /**
   * Check if character is whitespace
   */
  isWhitespace(char) {
    return char === ' ' || char === '\t' || char === '\n' || char === '\r';
  }

  /**
   * Get language code from internal language index
   */
  codeForLanguage(langIndex) {
    // Simplified mapping - could be enhanced with proper language reference
    const languageMap = {
      1: 'en-US',
      2: 'en-GB',
      3: 'es',
      4: 'fr',
      5: 'de'
    };

    return languageMap[langIndex] || 'en-US';
  }

  /**
   * Validate refinement
   */
  checkRefinement(refinement) {
    this.checkConcept(refinement.name, ['410662002', '106237007']);
    this.checkExpression(refinement.value);
  }

  /**
   * Render expression as string
   */
  renderExpression(source, option = SnomedServicesRenderOption.AsIs) {
    const parts = [];
    this.renderExpressionParts(parts, source, option);
    return parts.join('');
  }

  /**
   * Helper methods that need to be implemented based on SNOMED structures
   */

  isPrimitive(reference) {
    // Check if concept is primitive based on concept flags
    // In SNOMED CT, primitive concepts are not fully defined by their relationships
    try {
      const concept = this.concepts.getConcept(reference);
      return (concept.flags & SnomedConceptList.MASK_CONCEPT_PRIMITIVE) !== 0;
    } catch (error) {
      // If we can't read the concept, assume it's primitive for safety
      this.log.warn(`Warning: Could not check primitive status for concept ${reference}: ${error.message}`);
      return true;
    }
  }

  getConceptId(reference) {
    // Get concept ID string from reference index
    try {
      const concept = this.concepts.getConcept(reference);
      return concept.identity.toString();
    } catch (error) {
      this.log.warn(`Warning: Could not get concept ID for reference ${reference}: ${error.message}`);
      return reference.toString(); // Fall back to using the reference itself
    }
  }

  getConceptParents(reference) {
    // Get active parent concepts (needs implementation)
    const concept = this.concepts.getConcept(reference);
    const parentsIndex = concept.parents;

    if (parentsIndex === 0) {
      return [];
    }

    return this.refs.getReferences(parentsIndex);
  }

  getConceptChildren(reference) {
    // Get child concepts (needs implementation based on inbound is-a relationships)
    const children = [];
    const concept = this.concepts.getConcept(reference);
    const inboundsIndex = concept.inbounds;

    if (inboundsIndex === 0) {
      return children;
    }

    const inbounds = this.refs.getReferences(inboundsIndex);

    for (const relIndex of inbounds) {
      const rel = this.relationships.getRelationship(relIndex);

      if (rel.active && rel.defining && rel.relType === this.isAIndex) {
        children.push(rel.source);
      }
    }

    return children;
  }

  subsumes(a, b) {
    // Check if concept a subsumes concept b using closure/descendants
    if (a === b) {
      return true;
    }

    try {
      // Get the closure (all descendants) for concept a
      // ?? const conceptA = this.concepts.getConcept(a);
      const closureRef = this.concepts.getAllDesc(a);

      if (closureRef === 0 || closureRef === 0xFFFFFFFF) {
        // No closure data or magic "no children" value
        return false;
      }

      // Get the array of descendant indices
      const descendants = this.refs.getReferences(closureRef);

      // Check if b is in the descendants of a
      return descendants.includes(b);
    } catch (error) {
      // If we can't read closure data, fall back to simple equality check
      this.log.warn(`Warning: Could not check subsumption for ${a} -> ${b}: ${error.message}`);
      return false;
    }
  }

  /**
   * Helper to render expression parts
   */
  renderExpressionParts(parts, expr, option) {
    // Render concepts
    for (let i = 0; i < expr.concepts.length; i++) {
      if (i > 0) parts.push('+');
      this.renderConcept(parts, expr.concepts[i], option);
    }

    // Render refinements and groups
    if (expr.hasRefinements() || expr.hasRefinementGroups()) {
      parts.push(':');

      // Ungrouped refinements
      if (expr.hasRefinements()) {
        for (let i = 0; i < expr.refinements.length; i++) {
          if (i > 0) parts.push(',');
          this.renderRefinement(parts, expr.refinements[i], option);
        }
      }

      // Grouped refinements. The comma between the attribute set and the first group is
      // optional in the grammar, but we emit it: it is what makes the boundary between the
      // ungrouped attributes and the first group legible, and it is the safer of the two
      // spellings to hand to a third-party parser.
      if (expr.hasRefinementGroups()) {
        for (let j = 0; j < expr.refinementGroups.length; j++) {
          if (j > 0 || expr.hasRefinements()) parts.push(',');
          parts.push('{');

          for (let i = 0; i < expr.refinementGroups[j].refinements.length; i++) {
            if (i > 0) parts.push(',');
            this.renderRefinement(parts, expr.refinementGroups[j].refinements[i], option);
          }

          parts.push('}');
        }
      }
    }
  }

  renderConcept(parts, expr, option) {
    if (expr.reference !== NO_REFERENCE && expr.code === '') {
      expr.code = this.getConceptId(expr.reference);
      parts.push(expr.code);
    } else {
      parts.push(expr.describe());
    }

    let description = '';
    switch (option) {
      case SnomedServicesRenderOption.Minimal:
        description = '';
        break;
      case SnomedServicesRenderOption.AsIs:
        description = expr.description;
        break;
      case SnomedServicesRenderOption.FillMissing:
        description = expr.description;
        if (description === '') {
          if (expr.reference !== NO_REFERENCE) {
            description = this.getDisplayName(expr.reference);
          } else if (expr.code) {
            description = this.getDisplayName(expr.code);
          }
        }
        break;
      case SnomedServicesRenderOption.ReplaceAll:
        if (expr.code) {
          description = this.getDisplayName(expr.code);
        }
        break;
    }

    if (description) {
      parts.push('|');
      parts.push(description);
      parts.push('|');
    }
  }

  renderRefinement(parts, expr, option) {
    this.renderConcept(parts, expr.name, option);
    parts.push('=');
    this.renderExpressionParts(parts, expr.value, option);
  }

  getDisplayName(conceptIdOrReference) {
    // Get display name for concept
    let conceptIndex;

    if (typeof conceptIdOrReference === 'string') {
      // It's a concept ID string, need to find the concept
      const conceptId = BigInt(conceptIdOrReference);
      const result = this.concepts.findConcept(conceptId);
      if (!result.found) {
        return '';
      }
      conceptIndex = result.index;
    } else {
      // It's already a concept index
      conceptIndex = conceptIdOrReference;
    }

    // Get the preferred display name (FSN or first active description)
    const displayNames = this.listDisplayNames(conceptIndex, this.defaultLanguage);

    if (displayNames.length > 0) {
      // Look for FSN first (if we can detect it), otherwise use first available
      for (const designation of displayNames) {
        if (designation.isPreferred) {
          return designation.term;
        }
      }
      // Fall back to first designation
      return displayNames[0].term;
    }

    return '';
  }
}

/**
 * Expression context for maintaining state during processing
 */
class SnomedExpressionContext {
  constructor(source, expression) {
    this.source = source || '';
    this.expression = expression;
  }

  static fromReference(reference) {
    const expression = new SnomedExpression();
    expression.concepts.push(new SnomedConcept(reference));
    return new SnomedExpressionContext('', expression);
  }

  static fromSource(source, reference) {
    const expression = new SnomedExpression();
    expression.concepts.push(new SnomedConcept(reference));
    return new SnomedExpressionContext(source, expression);
  }

  isComplex() {
    return this.expression.isComplex();
  }

  getReference() {
    return this.expression.concepts[0].reference;
  }

  setExpression(expression) {
    this.expression = expression;
  }
}

module.exports = {
  SnomedExpressionServices,
  SnomedExpressionContext,
  MatchingConcept,
  SnomedServicesRenderOption,
  SnomedRefinementGroupMatchState
};

// Also add this method to SnomedExpressionServices to help with debugging
class SnomedExpressionServicesExtended extends SnomedExpressionServices {
  constructor(snomedStructures, isAIndex) {
    super(snomedStructures, isAIndex);

    // Ensure building flag is accessible
    this.building = false;
  }

  /**
   * Enhanced getDefiningRelationships with better error handling
   */
  getDefiningRelationships(conceptIndex) {
    try {
      const concept = this.concepts.getConcept(conceptIndex);
      const outboundIndex = concept.outbounds;

      if (outboundIndex === 0) {
        return [];
      }

      const result = [];
      const outbounds = this.refs.getReferences(outboundIndex);

      if (!outbounds) {
        return [];
      }

      for (const relIndex of outbounds) {
        try {
          const rel = this.relationships.getRelationship(relIndex);

          // Only include active defining relationships that are not is-a
          if (rel.active && rel.defining && rel.relType !== this.isAIndex) {
            result.push(relIndex);
          }
        } catch (error) {
          // Skip problematic relationships
          if (this.building) {
            this.log.warn(`Warning: Could not read relationship ${relIndex}: ${error.message}`);
          }
        }
      }

      return result;
    } catch (error) {
      if (this.building) {
        this.log.warn(`Warning: Could not get defining relationships for concept ${conceptIndex}: ${error.message}`);
      }
      return [];
    }
  }

  /**
   * Enhanced getConceptParents with better error handling
   */
  getConceptParents(reference) {
    try {
      const concept = this.concepts.getConcept(reference);
      const parentsIndex = concept.parents;

      if (parentsIndex === 0) {
        return [];
      }

      const parents = this.refs.getReferences(parentsIndex);
      return parents || [];
    } catch (error) {
      if (this.building) {
        this.log.warn(`Warning: Could not get parents for concept ${reference}: ${error.message}`);
      }
      return [];
    }
  }

  /**
   * Enhanced isPrimitive check with fallback
   */
  isPrimitive(reference) {
    try {
      const concept = this.concepts.getConcept(reference);
      // definitionStatusId 900000000000074008 (primitive) is recorded at import time as
      // MASK_CONCEPT_PRIMITIVE in the concept flags byte
      return (concept.flags & SnomedConceptList.MASK_CONCEPT_PRIMITIVE) !== 0;
    } catch (error) {
      // If we can't read the concept, assume it's primitive for safety
      if (this.building) {
        this.log.warn(`Warning: Could not check primitive status for concept ${reference}, assuming primitive: ${error.message}`);
      }
      return true;
    }
  }

  /**
   * Enhanced createDefinedExpression with better error handling
   */
  createDefinedExpression(reference, exp, ancestor = false) {
    try {
      if (this.isPrimitive(reference)) {
        if (!exp.hasConcept(reference)) {
          const concept = new SnomedConcept(reference);
          concept.code = this.getConceptId(reference);
          exp.concepts.push(concept);
        }
        return;
      }

      // Add parent concepts
      const parents = this.getConceptParents(reference);
      for (const parent of parents) {
        this.createDefinedExpression(parent, exp, true);
      }

      if (!ancestor || !this.assumeClassified) {
        const groups = new Map(); // Group number -> refinement group

        // Process defining relationships
        const definingRels = this.getDefiningRelationships(reference);
        for (const relIndex of definingRels) {
          try {
            const rel = this.relationships.getRelationship(relIndex);

            const ref = new SnomedRefinement();
            ref.name = new SnomedConcept(rel.relType);
            ref.name.code = this.getConceptId(rel.relType);

            ref.value = new SnomedExpression();
            const targetConcept = new SnomedConcept(rel.target);
            targetConcept.code = this.getConceptId(rel.target);
            ref.value.concepts.push(targetConcept);

            if (rel.group === 0) {
              // Ungrouped refinement
              if (!exp.hasRefinement(ref)) {
                exp.refinements.push(ref);
              }
            } else {
              // Grouped refinement
              const groupKey = rel.group.toString();
              if (!groups.has(groupKey)) {
                groups.set(groupKey, new SnomedRefinementGroup());
              }
              groups.get(groupKey).refinements.push(ref);
            }
          } catch (error) {
            // Skip problematic relationships but continue
            if (this.building) {
              this.log.warn(`Warning: Could not process relationship ${relIndex}: ${error.message}`);
            }
          }
        }

        // Add groups to expression
        for (const grp of groups.values()) {
          if (!exp.hasRefinementGroup(grp)) {
            exp.refinementGroups.push(grp);
          }
        }
      }
    } catch (error) {
      if (this.building) {
        this.log.warn(`Warning: Could not create defined expression for concept ${reference}: ${error.message}`);
      }
      // Add as primitive concept as fallback
      if (!exp.hasConcept(reference)) {
        const concept = new SnomedConcept(reference);
        concept.code = this.getConceptId(reference);
        exp.concepts.push(concept);
      }
    }
  }
}


// Export classes and constants
module.exports = {
  // Expression status and constants
  SnomedExpressionStatus,
  MAX_TERM_LENGTH,
  NO_REFERENCE,

  // Core expression classes
  SnomedExpressionBase,
  SnomedConcept,
  SnomedRefinement,
  SnomedRefinementGroup,
  SnomedExpression,
  SnomedExpressionParser,

  // Services and context
  SnomedExpressionServices,
  SnomedExpressionContext,
  MatchingConcept,
  SnomedExpressionServicesExtended,

  // Enums and constants
  SnomedServicesRenderOption,
  SnomedRefinementGroupMatchState
};

