const {validateParameter, validateOptionalParameter} = require("./utilities");
const escape = require('escape-html');

// Attributes that take a URL, and the schemes that make a URL run script. Browsers ignore
// leading whitespace and control characters, and embedded tabs and newlines, in the scheme.
const URL_ATTRIBUTES = new Set(['href', 'src', 'action', 'formaction', 'xlink:href']);
// eslint-disable-next-line no-control-regex -- control characters are exactly what browsers skip
const UNSAFE_URL = /^[\s\x00-\x1f]*(j[\s]*a[\s]*v[\s]*a[\s]*s[\s]*c[\s]*r[\s]*i[\s]*p[\s]*t|v[\s]*b[\s]*s[\s]*c[\s]*r[\s]*i[\s]*p[\s]*t|d[\s]*a[\s]*t[\s]*a)[\s]*:/i;

const NodeType = {
  Document: 'Document',
  Element: 'Element',
  Text: 'Text',
  Comment: 'Comment',
  DocType: 'DocType',
  Instruction: 'Instruction'
};

class XhtmlNode {
  constructor(nodeType, name = null) {
    this.nodeType = nodeType;
    this.name = name;
    this.attributes = new Map();
    this.childNodes = [];
    this.content = null; // for text nodes
    this.inPara = false;
    this.inLink = false;
    this.pretty = true;
  }

  // Attribute methods
  setAttribute(name, value) {
    if (value != null) {
      if (URL_ATTRIBUTES.has(String(name).toLowerCase()) && UNSAFE_URL.test(String(value))) {
        value = '#'; // a link that runs script (javascript:, data:, vbscript:) - from resource content
      }
      this.attributes.set(name, value);
    }
    return this;
  }

  attribute(name, value) {
    return this.setAttribute(name, value);
  }

  attr(name, value) {
    return this.setAttribute(name, value);
  }

  getAttribute(name) {
    return this.attributes.get(name) || null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
    return this;
  }

  // Class helpers
  clss(className) {
    if (className) {
      const existing = this.attributes.get('class');
      if (existing) {
        this.attributes.set('class', existing + ' ' + className);
      } else {
        this.attributes.set('class', className);
      }
    }
    return this;
  }

  style(style) {
    if (style) {
      this.attributes.set('style', style);
    }
    return this;
  }

  id(id) {
    if (id) {
      this.attributes.set('id', id);
    }
    return this;
  }

  title(title) {
    if (title) {
      this.attributes.set('title', title);
    }
    return this;
  }

  // Child node management
  #makeTag(name) {
    const node = new XhtmlNode(NodeType.Element, name);
    if (this.inPara || name === 'p') {
      node.inPara = true;
    }
    if (this.inLink || name === 'a') {
      node.inLink = true;
    }
    const inlineElements = ['b', 'big', 'i', 'small', 'tt', 'abbr', 'acronym', 'cite', 'code',
      'dfn', 'em', 'kbd', 'strong', 'samp', 'var', 'a', 'bdo', 'br', 'img', 'map', 'object',
      'q', 'script', 'span', 'sub', 'sup', 'button', 'input', 'label', 'select', 'textarea'];
    if (inlineElements.includes(name)) {
      node.pretty = false;
    }
    return node;
  }

  addTag(nameOrIndex, name = null) {
    if (typeof nameOrIndex === 'number') {
      const node = this.#makeTag(name);
      this.childNodes.splice(nameOrIndex, 0, node);
      return node;
    } else {
      const node = this.#makeTag(nameOrIndex);
      this.childNodes.push(node);
      return node;
    }
  }

  addText(content) {
    if (content != null) {
      const node = new XhtmlNode(NodeType.Text);
      node.content = String(content);
      this.childNodes.push(node);
      return node;
    }
    return null;
  }

  addComment(content) {
    if (content != null) {
      const node = new XhtmlNode(NodeType.Comment);
      node.content = content;
      this.childNodes.push(node);
      return node;
    }
    return null;
  }

  addChildren(nodes) {
    if (nodes) {
      for (const node of nodes) {
        this.childNodes.push(node);
      }
    }
    return this;
  }

  addChild(node) {
    if (node) {
      this.childNodes.push(node);
    }
    return this;
  }

  clear() {
    this.childNodes = [];
    return this;
  }

  indexOf(node) {
    return this.childNodes.indexOf(node);
  }

  hasChildren() {
    return this.childNodes.length > 0;
  }

  getFirstElement() {
    for (const child of this.childNodes) {
      if (child.nodeType === NodeType.Element) {
        return child;
      }
    }
    return null;
  }

  // Text content helpers
  tx(content) {
    return this.addText(content);
  }

  txN(content) {
    this.addText(content);
    return this;
  }

  stx(content) {
    if (content) {
      this.addText(' ' + content);
    }
    return this;
  }

  // Fluent element creation methods
  h(level, id = null) {
    if (level < 1 || level > 6) {
      throw new Error('Illegal Header level ' + level);
    }
    const node = this.addTag('h' + level);
    if (id) {
      node.setAttribute('id', id);
    }
    return node;
  }

  h1() { return this.addTag('h1'); }
  h2() { return this.addTag('h2'); }
  h3() { return this.addTag('h3'); }
  h4() { return this.addTag('h4'); }
  h5() { return this.addTag('h5'); }
  h6() { return this.addTag('h6'); }

  div(style = null) {
    const node = this.addTag('div');
    if (style) {
      node.setAttribute('style', style);
    }
    return node;
  }

  span(style = null, title = null) {
    const node = this.addTag('span');
    if (style) {
      node.setAttribute('style', style);
    }
    if (title) {
      node.setAttribute('title', title);
    }
    return node;
  }

  spanClss(className) {
    const node = this.addTag('span');
    if (className) {
      node.setAttribute('class', className);
    }
    return node;
  }

  para() { return this.addTag('p'); }
  p() { return this.addTag('p'); }

  pre(clss = null) {
    const node = this.addTag('pre');
    if (clss) {
      node.setAttribute('class', clss);
    }
    return node;
  }

  blockquote() { return this.addTag('blockquote'); }

  // Lists
  ul() { return this.addTag('ul'); }
  ol() { return this.addTag('ol'); }
  li() { return this.addTag('li'); }

  // Tables
  table(clss = null, forPresentation = false) {
    const node = this.addTag('table');
    if (clss) {
      node.clss(clss);
    }
    if (forPresentation) {
      node.clss('presentation');
    }
    return node;
  }

  tr(afterRow = null) {
    if (afterRow) {
      const index = this.indexOf(afterRow);
      return this.addTag(index + 1, 'tr');
    }
    return this.addTag('tr');
  }

  th(index = null) {
    if (index !== null) {
      return this.addTag(index, 'th');
    }
    return this.addTag('th');
  }

  td(clss = null) {
    const node = this.addTag('td');
    if (clss) {
      node.setAttribute('class', clss);
    }
    return node;
  }

  thead() { return this.addTag('thead'); }
  tbody() { return this.addTag('tbody'); }
  tfoot() { return this.addTag('tfoot'); }

  // Inline elements
  b() { return this.addTag('b'); }
  i() { return this.addTag('i'); }
  em() { return this.addTag('em'); }
  strong() { return this.addTag('strong'); }
  small() { return this.addTag('small'); }
  sub() { return this.addTag('sub'); }
  sup() { return this.addTag('sup'); }

  code(text = null) {
    const node = this.addTag('code');
    if (text) {
      node.tx(text);
    }
    return node;
  }

  codeWithText(preText, text, postText) {
    this.tx(preText);
    const code = this.addTag('code');
    code.tx(text);
    this.tx(postText);
    return this;
  }

  // Line breaks
  br() {
    this.addTag('br');
    return this;
  }

  hr() {
    this.addTag('hr');
    return this;
  }

  // Links
  ah(href, title = null) {
    if (href == null) {
      return this.addTag('span');
    }
    const node = this.addTag('a').setAttribute('href', href);
    if (title) {
      node.setAttribute('title', title);
    }
    return node;
  }

  ahWithText(preText, href, title, text, postText) {
    this.tx(preText);
    const a = this.addTag('a').setAttribute('href', href);
    if (title) {
      a.setAttribute('title', title);
    }
    a.tx(text);
    this.tx(postText);
    return a;
  }

  ahOrCode(href, title = null) {
    if (href != null) {
      return this.ah(href, title);
    } else if (title != null) {
      return this.code().setAttribute('title', title);
    } else {
      return this.code();
    }
  }

  an(name, text = ' ') {
    const a = this.addTag('a').setAttribute('name', name);
    a.tx(text);
    return a;
  }

  // Images
  img(src, alt, title = null) {
    const node = this.addTag('img')
      .setAttribute('src', src)
      .setAttribute('alt', alt || '.');
    if (title) {
      node.setAttribute('title', title);
    }
    return node;
  }

  imgT(src, alt) {
    return this.img(src, alt, alt);
  }

  // Forms
  input(type, name, value = null) {
    const node = this.addTag('input')
      .setAttribute('type', type)
      .setAttribute('name', name);
    if (value != null) {
      node.setAttribute('value', value);
    }
    return node;
  }

  button(text) {
    const node = this.addTag('button');
    node.tx(text);
    return node;
  }

  select(name) {
    return this.addTag('select').setAttribute('name', name);
  }

  option(value, text, selected = false) {
    const node = this.addTag('option').setAttribute('value', value);
    node.tx(text);
    if (selected) {
      node.setAttribute('selected', 'selected');
    }
    return node;
  }

  textarea(name, rows = null, cols = null) {
    const node = this.addTag('textarea').setAttribute('name', name);
    if (rows != null) {
      node.setAttribute('rows', String(rows));
    }
    if (cols != null) {
      node.setAttribute('cols', String(cols));
    }
    return node;
  }

  label(forId) {
    return this.addTag('label').setAttribute('for', forId);
  }

  colspan(width) {
    return this.attr("colspan", String(width));
  }

  // Conditional
  iff(test) {
    if (test) {
      return this;
    } else {
      return new XhtmlNode(NodeType.Element, 'span'); // disconnected node
    }
  }

  // Separator helper
  sep(text) {
    if (this.hasChildren()) {
      this.addText(text);
    }
    return this;
  }

  // Rendering
  notPretty() {
    this.pretty = false;
    return this;
  }

  allText() {
    let result = '';
    for (const child of this.childNodes) {
      if (child.nodeType === NodeType.Text) {
        result += child.content || '';
      } else if (child.nodeType === NodeType.Element) {
        result += child.allText();
      }
    }
    return result;
  }

  startCommaList(lastWord) {
    validateParameter(lastWord, 'lastWord', String);
    if (this.lastWord) {
      throw new Error('Unclosed list');
    }
    this.lastWord = lastWord;
    this.commaItems = [];
    this.commaFirst = true;
  }

  commaItem(text, link) {
    validateParameter(text, 'text', String);
    validateOptionalParameter(link, 'link', String);

    if (!this.commaFirst) {
      this.commaItems.push(this.tx(", "));
    }
    this.commaFirst = false;
    if (link) {
      this.ah(link).tx(text);
    } else {
      this.tx(text);
    }
  }

  stopCommaList() {
    if (this.commaItems && this.commaItems.length > 0) {
      this.commaItems[this.commaItems.length-1].content = " "+this.lastWord+" ";
    }
    this.lastWord = undefined;
    this.commaItems = undefined;
  }

// Script execution methods

  startScript(name) {
    if (this.namedParams) {
      throw new Error(`Sequence Error - script is already open @ ${name}`);
    }
    this.namedParams = new Map();
    this.namedParamValues = new Map();
  }

  param(name) {
    if (!this.namedParams) {
      throw new Error('Sequence Error - script is not already open');
    }
    // Create a detached node that will be inserted when the script executes
    const node = new XhtmlNode(NodeType.Element, 'p');
    node.inPara = true;
    this.namedParams.set(name, node);
    return node;
  }

  paramValue(name, value) {
    if (!this.namedParamValues) {
      throw new Error('Sequence Error - script is not already open');
    }
    this.namedParamValues.set(name, String(value));
  }

  execScript(structure) {
    const scriptNodes = this.#parseFragment(`<div>${structure}</div>`);
    this.#parseNodes(scriptNodes, this.childNodes);
  }

  #parseNodes(source, dest) {
    for (const n of source) {
      if (n.name === 'param') {
        const paramName = n.getAttribute('name');
        const node = this.namedParams.get(paramName);
        if (node) {
          this.#parseNodes(node.childNodes, dest);
        }
      } else if (n.name === 'if') {
        const test = n.getAttribute('test');
        if (this.#passesTest(test)) {
          this.#parseNodes(n.childNodes, dest);
        }
      } else {
        dest.push(n);
      }
    }
  }

  #passesTest(test) {
    const parts = test.trim().split(/\s+/);
    if (parts.length !== 3) {
      return false;
    }

    const [paramName, operator, compareValue] = parts;

    if (!this.namedParamValues.has(paramName)) {
      return false;
    }

    const paramValue = this.namedParamValues.get(paramName);

    switch (operator) {
      case '=':
        return compareValue.toLowerCase() === paramValue.toLowerCase();
      case '!=':
        return compareValue.toLowerCase() !== paramValue.toLowerCase();
      case '<':
        return this.#isInteger(paramValue) && this.#isInteger(compareValue) &&
            parseInt(paramValue, 10) < parseInt(compareValue, 10);
      case '<=':
        return this.#isInteger(paramValue) && this.#isInteger(compareValue) &&
            parseInt(paramValue, 10) <= parseInt(compareValue, 10);
      case '>':
        return this.#isInteger(paramValue) && this.#isInteger(compareValue) &&
            parseInt(paramValue, 10) > parseInt(compareValue, 10);
      case '>=':
        return this.#isInteger(paramValue) && this.#isInteger(compareValue) &&
            parseInt(paramValue, 10) >= parseInt(compareValue, 10);
      default:
        return false;
    }
  }

  #isInteger(str) {
    return /^-?\d+$/.test(str);
  }

  #parseFragment(html) {
    const nodes = [];
    const stack = [{ children: nodes }];
    let current = stack[0];
    let i = 0;

    while (i < html.length) {
      if (html[i] === '<') {
        // Check for closing tag
        if (html[i + 1] === '/') {
          const endTag = html.indexOf('>', i);
          stack.pop();
          current = stack[stack.length - 1];
          i = endTag + 1;
          continue;
        }

        // Find tag end
        const tagEnd = html.indexOf('>', i);
        const tagContent = html.substring(i + 1, tagEnd);
        const selfClosing = tagContent.endsWith('/');
        const cleanContent = selfClosing ? tagContent.slice(0, -1).trim() : tagContent.trim();

        // Parse tag name and attributes
        const spaceIndex = cleanContent.indexOf(' ');
        const tagName = spaceIndex === -1 ? cleanContent : cleanContent.substring(0, spaceIndex);
        const attrString = spaceIndex === -1 ? '' : cleanContent.substring(spaceIndex + 1);

        const node = new XhtmlNode(NodeType.Element, tagName);

        // Parse attributes
        const attrRegex = /(\w+)=["']([^"']*)["']/g;
        let match;
        while ((match = attrRegex.exec(attrString)) !== null) {
          node.setAttribute(match[1], match[2]);
        }

        current.children.push(node);

        if (!selfClosing) {
          stack.push({ children: node.childNodes });
          current = stack[stack.length - 1];
        }

        i = tagEnd + 1;
      } else {
        // Text content
        const nextTag = html.indexOf('<', i);
        const textContent = nextTag === -1 ? html.substring(i) : html.substring(i, nextTag);

        if (textContent.trim()) {
          const textNode = new XhtmlNode(NodeType.Text);
          textNode.content = textContent;
          current.children.push(textNode);
        }

        i = nextTag === -1 ? html.length : nextTag;
      }
    }

    // Return children of the wrapper div
    return nodes.length > 0 && nodes[0].childNodes ? nodes[0].childNodes : nodes;
  }

  closeScript() {
    if (!this.namedParams) {
      throw new Error('Sequence Error - script is not already open');
    }
    this.namedParams = null;
    this.namedParamValues = null;
  }

  /**
   * Process markdown content and add it as HTML child nodes
   * @param {string} md - Markdown content to process
   * @returns {XhtmlNode} - this node for chaining
   */
  markdown(md) {
    if (!md) {
      return this;
    }

    const commonmark = require('commonmark');
    const reader = new commonmark.Parser();
    const writer = new commonmark.HtmlRenderer({ safe: true });

    const parsed = reader.parse(md);
    const html = writer.render(parsed);

    // Parse the HTML and add as children
    const nodes = this.#parseFragment(`<div>${html}</div>`);
    for (const node of nodes) {
      this.childNodes.push(node);
    }

    return this;
  }

  /**
   * Process markdown content and add it inline (strips block-level wrapper)
   * Useful when you want to add markdown content within a paragraph
   * @param {string} md - Markdown content to process
   * @returns {XhtmlNode} - this node for chaining
   */
  markdownInline(md) {
    if (!md) {
      return this;
    }

    const commonmark = require('commonmark');
    const reader = new commonmark.Parser();
    const writer = new commonmark.HtmlRenderer({ safe: true });

    const parsed = reader.parse(md);
    const html = writer.render(parsed);

    // Strip outer <p> tags if present for inline usage
    const trimmedHtml = html.trim().replace(/^<p>/, '').replace(/<\/p>\s*$/, '');

    // Parse the HTML and add as children
    const nodes = this.#parseFragment(`<span>${trimmedHtml}</span>`);
    for (const node of nodes) {
      // Add children of the wrapper span, not the span itself
      for (const child of node.childNodes) {
        this.childNodes.push(child);
      }
    }

    return this;
  }

  render(indent = 0, pretty = true) {
    const effectivePretty = pretty && this.pretty;
    const indentStr = effectivePretty ? '  '.repeat(indent) : '';
    const newline = effectivePretty ? '\n' : '';

    if (this.nodeType === NodeType.Text) {
      return escape(this.content || '');
    }

    if (this.nodeType === NodeType.Comment) {
      return `${indentStr}<!-- ${this.content || ''} -->${newline}`;
    }

    if (this.nodeType === NodeType.Element) {
      const voidElements = ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
        'link', 'meta', 'param', 'source', 'track', 'wbr'];
      const isVoid = voidElements.includes(this.name);

      let attrs = '';
      for (const [key, value] of this.attributes) {
        attrs += ` ${key}="${this.#escapeAttr(value)}"`;
      }

      if (isVoid) {
        return `${indentStr}<${this.name}${attrs}/>${newline}`;
      }

      if (this.childNodes.length === 0) {
        return `${indentStr}<${this.name}${attrs}></${this.name}>${newline}`;
      }

      // Check if all children are text/inline
      const allInline = this.childNodes.every(c =>
        c.nodeType === NodeType.Text || !c.pretty
      );

      if (allInline || !effectivePretty) {
        let content = '';
        for (const child of this.childNodes) {
          content += child.render(0, false);
        }
        return `${indentStr}<${this.name}${attrs}>${content}</${this.name}>${newline}`;
      } else {
        let content = '';
        for (const child of this.childNodes) {
          content += child.render(indent + 1, true);
        }
        return `${indentStr}<${this.name}${attrs}>${newline}${content}${indentStr}</${this.name}>${newline}`;
      }
    }

    return '';
  }

  #escapeAttr(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  toString() {
    return this.render(0, true);
  }

  toStringPretty() {
    return this.render(0, true);
  }

  toStringCompact() {
    return this.render(0, false);
  }
}

// Factory functions
function div(style = null) {
  const node = new XhtmlNode(NodeType.Element, 'div');
  node.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
  if (style) {
    node.setAttribute('style', style);
  }
  return node;
}

function element(name) {
  return new XhtmlNode(NodeType.Element, name);
}

function text(content) {
  const node = new XhtmlNode(NodeType.Text);
  node.content = content;
  return node;
}

function comment(content) {
  const node = new XhtmlNode(NodeType.Comment);
  node.content = content;
  return node;
}

module.exports = {
  XhtmlNode,
  NodeType,
  div,
  element,
  text,
  comment
};
