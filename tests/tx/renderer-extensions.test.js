const { Renderer } = require('../../tx/library/renderer');
const { OperationContext } = require('../../tx/operation-context');
const { Languages } = require('../../library/languages');
const { TestUtilities } = require('../test-utilities');

/**
 * Narrative-rendering coverage for the FHIR extensions the renderer surfaces.
 *
 * CodeSystem concept table: designations (by use+language), concept comments,
 * definition translations, the codesystem-replacedby extension and concept
 * standards-status reason in the deprecated cell, the property ValueSet column
 * (codesystem-property-valueset), display-hint driven property selection with
 * no-link, and codesystem-use-markdown definitions.
 *
 * ValueSet: expansion unclosed/too-costly warnings, expansion designations,
 * and the resource-level standards-status metadata row.
 *
 * A stub link resolver is used so links (replaced-by, property value set) can
 * be asserted; it prefixes resolved targets with "LINK:" so they are easy to
 * spot in the HTML.
 */

const SD = 'http://hl7.org/fhir/StructureDefinition/';

const linkResolver = {
  resolveURL: async (ctx, url) => ({ description: url, link: 'LINK:' + url }),
  resolveCode: async (ctx, system, version, code) => ({ display: code, link: 'LINK:' + system + '#' + code }),
};

let renderer;

beforeAll(async () => {
  const langDefs = await TestUtilities.loadLanguageDefinitions();
  const i18n = await TestUtilities.loadTranslations(langDefs);
  const opContext = new OperationContext(Languages.fromAcceptLanguage('en-US', langDefs), i18n);
  renderer = new Renderer(opContext, linkResolver);
});

// --- CodeSystem concept-table extensions -------------------------------------

describe('CodeSystem concept table - designations, comments, translations, deprecation', () => {
  const cs = {
    resourceType: 'CodeSystem', id: 'cs1', url: 'http://example.org/cs1',
    status: 'active', content: 'complete',
    property: [{ code: 'foo', type: 'string' }],
    concept: [
      {
        code: 'A', display: 'Alpha', definition: 'the first letter',
        _definition: { extension: [{ url: SD + 'translation', extension: [{ url: 'lang', valueCode: 'de' }, { url: 'content', valueString: 'der erste Buchstabe' }] }] },
        designation: [{ language: 'nl', use: { system: 'http://terminology.hl7.org/CodeSystem/designation-usage', code: 'display', display: 'Display' }, value: 'alfa' }],
        extension: [{ url: SD + 'codesystem-concept-comments', valueString: 'a note about A' }],
        property: [{ code: 'foo', valueString: 'bar' }],
      },
      {
        code: 'B', display: 'Beta', definition: 'the second letter',
        property: [{ code: 'status', valueCode: 'deprecated' }],
        extension: [{ url: SD + 'codesystem-replacedby', valueCoding: { system: 'http://example.org/cs1', code: 'A', display: 'Alpha' } }],
      },
      {
        code: 'D', display: 'Delta', definition: 'the fourth letter',
        property: [{ code: 'status', valueCode: 'deprecated' }],
        extension: [{ url: SD + 'structuredefinition-standards-status', valueCode: 'deprecated', extension: [{ url: SD + 'structuredefinition-standards-status-reason', valueMarkdown: 'no longer needed' }] }],
      },
    ],
  };

  let html;
  beforeAll(async () => { html = await renderer.renderCodeSystem(cs); });

  test('renders a designation column headed by use + language', () => {
    expect(html).toContain('Display (nl)');
  });

  test('renders the designation value in its column', () => {
    expect(html).toContain('alfa');
  });

  test('renders a Comments column with the concept comment', () => {
    expect(html).toContain('Comments');
    expect(html).toContain('a note about A');
  });

  test('renders the base definition and a definition translation below it', () => {
    expect(html).toContain('the first letter');
    expect(html).toContain('(de)');
    expect(html).toContain('der erste Buchstabe');
  });

  test('renders the codesystem-replacedby extension as a linked replacement', () => {
    expect(html).toContain('replaced by');
    expect(html).toContain('LINK:http://example.org/cs1#A');
    expect(html).toContain('Alpha');
  });

  test('renders the concept-level standards-status reason for a deprecated concept', () => {
    expect(html).toContain('no longer needed');
  });

  test('styles deprecated concept rows', () => {
    expect(html).toContain('background-color: #ffeeee');
  });
});

describe('CodeSystem property table - codesystem-property-valueset', () => {
  const cs = {
    resourceType: 'CodeSystem', id: 'csvs', url: 'http://example.org/csvs',
    status: 'active', content: 'complete',
    property: [
      { code: 'foo', type: 'code', extension: [{ url: SD + 'codesystem-property-valueset', valueCanonical: 'http://example.org/vs/foo' }] },
    ],
    concept: [{ code: 'X', display: 'Ex', property: [{ code: 'foo', valueCode: 'y' }] }],
  };

  test('adds a Value Set column linking the bound value set', async () => {
    const html = await renderer.renderCodeSystem(cs);
    expect(html).toContain('Value Set');
    expect(html).toContain('LINK:http://example.org/vs/foo');
  });
});

describe('CodeSystem concept table - structuredefinition-display-hint property selection', () => {
  const cs = {
    resourceType: 'CodeSystem', id: 'cshint', url: 'http://example.org/cshint',
    status: 'active', content: 'complete',
    property: [
      { code: 'p1', type: 'string' },
      { code: 'p2', type: 'string', extension: [{ url: SD + 'structuredefinition-display-hint', valueString: 'no-link' }] },
      { code: 'p3', type: 'string', extension: [{ url: SD + 'structuredefinition-display-hint', valueString: 'display' }] },
    ],
    concept: [{
      code: 'X', display: 'Ex', property: [
        { code: 'p1', valueString: 'excluded-p1-value' },
        { code: 'p2', valueString: 'http://link.me/nolink' },
        { code: 'p3', valueString: 'http://link.me/display' },
      ],
    }],
  };

  let html;
  beforeAll(async () => { html = await renderer.renderCodeSystem(cs); });

  test('drops un-hinted properties from the concept table', () => {
    expect(html).not.toContain('excluded-p1-value');
  });

  test('renders a no-link property value as plain text', () => {
    expect(html).toContain('http://link.me/nolink');
    expect(html).not.toContain('<a href="http://link.me/nolink"');
  });

  test('renders a display (linkable) property value as a hyperlink', () => {
    expect(html).toContain('<a href="http://link.me/display"');
  });
});

describe('CodeSystem concept table - codesystem-use-markdown definitions', () => {
  const cs = {
    resourceType: 'CodeSystem', id: 'csmd', url: 'http://example.org/csmd',
    status: 'active', content: 'complete',
    extension: [{ url: SD + 'codesystem-use-markdown', valueBoolean: true }],
    concept: [{ code: 'A', display: 'Alpha', definition: 'see [the docs](http://x.org) for detail' }],
  };

  test('renders markdown definitions as HTML', async () => {
    const html = await renderer.renderCodeSystem(cs);
    expect(html).toContain('<a href="http://x.org">the docs</a>');
  });
});

// --- ValueSet expansion extensions -------------------------------------------

describe('ValueSet expansion - unclosed / too-costly warnings', () => {
  test('renders the unclosed warning with its reason', async () => {
    const vs = {
      resourceType: 'ValueSet', id: 'vsu', url: 'http://example.org/vsu', status: 'active',
      expansion: {
        extension: [
          { url: SD + 'valueset-unclosed', valueBoolean: true },
          { url: SD + 'valueset-unclosed-reason', valueString: 'the grammar has infinite members' },
        ],
        contains: [{ system: 'http://example.org/cs', code: 'a', display: 'A' }],
      },
    };
    const html = await renderer.renderValueSet(vs);
    expect(html).toContain('This expansion is not closed');
    expect(html).toContain('the grammar has infinite members');
  });

  test('renders the too-costly warning', async () => {
    const vs = {
      resourceType: 'ValueSet', id: 'vst', url: 'http://example.org/vst', status: 'active',
      expansion: {
        extension: [{ url: SD + 'valueset-toocostly', valueBoolean: true }],
        contains: [{ system: 'http://example.org/cs', code: 'a', display: 'A' }],
      },
    };
    const html = await renderer.renderValueSet(vs);
    expect(html).toContain('a complete expansion was too costly to produce.');
  });
});

describe('ValueSet expansion - designations', () => {
  test('renders a designation column and value in the expansion table', async () => {
    const vs = {
      resourceType: 'ValueSet', id: 'vsd', url: 'http://example.org/vsd', status: 'active',
      expansion: {
        contains: [{
          system: 'http://example.org/cs', code: 'a', display: 'A',
          designation: [{ language: 'nl', use: { system: 'http://terminology.hl7.org/CodeSystem/designation-usage', code: 'display', display: 'Display' }, value: 'alfa' }],
        }],
      },
    };
    const html = await renderer.renderValueSet(vs);
    expect(html).toContain('Display (nl)');
    expect(html).toContain('alfa');
  });
});

describe('Resource metadata - structuredefinition-standards-status row', () => {
  test('renders a Standards Status row from the resource-level extension', async () => {
    const vs = {
      resourceType: 'ValueSet', id: 'vsss', url: 'http://example.org/vsss', status: 'active',
      extension: [{ url: SD + 'structuredefinition-standards-status', valueCode: 'trial-use' }],
    };
    const html = await renderer.renderValueSet(vs);
    expect(html).toContain('Standards Status');
    expect(html).toContain('trial-use');
  });
});
