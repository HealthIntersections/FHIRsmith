//
// Bundle XML Serialization
//

const { FhirXmlBase } = require('./xml-base');

/**
 * XML support for FHIR Bundle resources
 */
class BundleXML extends FhirXmlBase {

  /**
   * Element order for Bundle (FHIR requires specific order)
   */
  static _elementOrder = [
    'id', 'meta', 'implicitRules', 'language',
    'identifier', 'type', 'timestamp', 'total',
    'link', 'entry', 'signature', 'issues'
  ];

  /**
   * Element order for Bundle.entry
   */
  static _entryElementOrder = [
    'link', 'fullUrl', 'resource', 'search', 'request', 'response'
  ];

  /**
   * Element order for Bundle.link
   */
  static _linkElementOrder = [
    'relation', 'url'
  ];

  /**
   * Element order for Bundle.entry.search
   */
  static _searchElementOrder = [
    'mode', 'score'
  ];

  /**
   * Convert Bundle JSON to XML string
   * @param {Object} json - Bundle as JSON
   * @param {number} fhirVersion - FHIR version (3, 4, or 5)
   * @returns {string} XML string
   */
  static toXml(json, fhirVersion) {
    let content = '';
    const indent = '  ';

    // Render simple elements first
    for (const key of this._elementOrder) {
      if (json[key] === undefined) continue;

      if (key === 'link') {
        // Handle link array
        for (const link of json.link || []) {
          content += `${indent}<link>\n`;
          content += this.renderElementsInOrder(link, 2, this._linkElementOrder);
          content += `${indent}</link>\n`;
        }
      } else if (key === 'entry') {
        // Handle entry array with nested resources
        for (const entry of json.entry || []) {
          content += `${indent}<entry>\n`;

          // fullUrl
          if (entry.fullUrl) {
            content += `${indent}${indent}<fullUrl value="${this.escapeXml(entry.fullUrl)}"/>\n`;
          }

          // resource - needs special handling to embed full resource
          if (entry.resource) {
            content += `${indent}${indent}<resource>\n`;
            content += this.renderResource(entry.resource, 3, fhirVersion);
            content += `${indent}${indent}</resource>\n`;
          }

          // search
          if (entry.search) {
            content += `${indent}${indent}<search>\n`;
            if (entry.search.mode) {
              content += `${indent}${indent}${indent}<mode value="${this.escapeXml(entry.search.mode)}"/>\n`;
            }
            if (entry.search.score !== undefined) {
              content += `${indent}${indent}${indent}<score value="${entry.search.score}"/>\n`;
            }
            content += `${indent}${indent}</search>\n`;
          }

          content += `${indent}</entry>\n`;
        }
      } else if (key === 'total') {
        content += `${indent}<total value="${json.total}"/>\n`;
      } else if (key === 'type') {
        content += `${indent}<type value="${this.escapeXml(json.type)}"/>\n`;
      } else if (key === 'timestamp') {
        content += `${indent}<timestamp value="${this.escapeXml(json.timestamp)}"/>\n`;
      } else if (key === 'id') {
        content += `${indent}<id value="${this.escapeXml(json.id)}"/>\n`;
      } else if (key === 'meta') {
        content += this.renderMeta(json.meta, 1);
      } else {
        // Generic element handling
        content += this.renderElement(key, json[key], 1);
      }
    }

    return this.wrapInRootElement('Bundle', content);
  }

  /**
   * Render a nested resource as XML
   */
  static renderResource(resource, indentLevel, _fhirVersion) {
    void _fhirVersion; // reserved for future version-specific rendering

    const indent = '  '.repeat(indentLevel);
    const resourceType = resource.resourceType;
    this.checkElementName(resourceType);

    // For known resource types, delegate to their specific converters
    // For unknown types, render generically
    let innerContent = '';

    // Get element order based on resource type
    const elementOrder = this.getElementOrderForResource(resourceType);

    innerContent = this.renderElementsInOrder(resource, indentLevel + 1, elementOrder);

    return `${indent}<${resourceType} xmlns="http://hl7.org/fhir">\n${innerContent}${indent}</${resourceType}>\n`;
  }

  /**
   * Get element order for a resource type
   */
  static getElementOrderForResource(resourceType) {
    // Common elements that most resources have
    const commonElements = [
      'id', 'meta', 'implicitRules', 'language', 'text', 'contained',
      'extension', 'modifierExtension'
    ];

    switch (resourceType) {
      case 'CodeSystem':
        return [
          ...commonElements,
          'url', 'identifier', 'version', 'versionAlgorithmString', 'versionAlgorithmCoding',
          'name', 'title', 'status', 'experimental', 'date', 'publisher',
          'contact', 'description', 'useContext', 'jurisdiction', 'purpose', 'copyright',
          'copyrightLabel', 'approvalDate', 'lastReviewDate',
          'caseSensitive', 'valueSet', 'hierarchyMeaning', 'compositional',
          'versionNeeded', 'content', 'supplements', 'count', 'filter', 'property', 'concept'
        ];
      case 'ValueSet':
        return [
          ...commonElements,
          'url', 'identifier', 'version', 'versionAlgorithmString', 'versionAlgorithmCoding',
          'name', 'title', 'status', 'experimental', 'date', 'publisher',
          'contact', 'description', 'useContext', 'jurisdiction', 'purpose', 'copyright',
          'copyrightLabel', 'approvalDate', 'lastReviewDate', 'effectivePeriod',
          'immutable', 'compose', 'expansion'
        ];
      case 'ConceptMap':
        return [
          ...commonElements,
          'url', 'identifier', 'version', 'name', 'title', 'status', 'experimental',
          'date', 'publisher', 'contact', 'description', 'useContext', 'jurisdiction',
          'purpose', 'copyright', 'sourceUri', 'sourceCanonical', 'targetUri', 'targetCanonical',
          'group'
        ];
      default:
        // Return common elements plus all other keys from the resource
        return commonElements;
    }
  }

  /**
   * Render meta element
   */
  static renderMeta(meta, indentLevel) {
    if (!meta) return '';
    const indent = '  '.repeat(indentLevel);
    let content = `${indent}<meta>\n`;

    if (meta.versionId) {
      content += `${indent}  <versionId value="${this.escapeXml(meta.versionId)}"/>\n`;
    }
    if (meta.lastUpdated) {
      content += `${indent}  <lastUpdated value="${this.escapeXml(meta.lastUpdated)}"/>\n`;
    }
    if (meta.source) {
      content += `${indent}  <source value="${this.escapeXml(meta.source)}"/>\n`;
    }
    for (const profile of meta.profile || []) {
      content += `${indent}  <profile value="${this.escapeXml(profile)}"/>\n`;
    }
    for (const security of meta.security || []) {
      content += this.renderCoding(security, indentLevel + 1, 'security');
    }
    for (const tag of meta.tag || []) {
      content += this.renderCoding(tag, indentLevel + 1, 'tag');
    }

    content += `${indent}</meta>\n`;
    return content;
  }

  /**
   * Render a Coding element
   */
  static renderCoding(coding, indentLevel, elementName) {
    const indent = '  '.repeat(indentLevel);
    let content = `${indent}<${elementName}>\n`;

    if (coding.system) {
      content += `${indent}  <system value="${this.escapeXml(coding.system)}"/>\n`;
    }
    if (coding.version) {
      content += `${indent}  <version value="${this.escapeXml(coding.version)}"/>\n`;
    }
    if (coding.code) {
      content += `${indent}  <code value="${this.escapeXml(coding.code)}"/>\n`;
    }
    if (coding.display) {
      content += `${indent}  <display value="${this.escapeXml(coding.display)}"/>\n`;
    }
    if (coding.userSelected !== undefined) {
      content += `${indent}  <userSelected value="${coding.userSelected}"/>\n`;
    }

    content += `${indent}</${elementName}>\n`;
    return content;
  }
}

module.exports = { BundleXML };