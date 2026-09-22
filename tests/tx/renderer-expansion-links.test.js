/**
 * The code in a row of an expansion links to $lookup on that code.
 *
 * The expansion is a list of codes; what a reader wants from a row is to find out what
 * that code actually is, and $lookup is the operation that answers it. resolveCode - what
 * the cell used to use - answers a different question, "where does this code live", and
 * lands on a code system page or the publisher's own browser.
 *
 * The version is the part with something to get wrong. An expansion.contains only carries
 * a version when the expansion had to distinguish one, so most rows have none, and a link
 * without a version resolves against whichever version the server prefers - which for a
 * SNOMED edition picked by hand on the ECL page is exactly the wrong one. It is read from
 * the expansion's used-codesystem parameters, or from the compose when the definition
 * came back with it.
 */

const { Renderer } = require('../../tx/library/renderer');
const { OperationContext } = require('../../tx/operation-context');
const { TestUtilities } = require('../test-utilities');

const SCT = 'http://snomed.info/sct';
const INTL = SCT + '/900000000000207008/version/20250201';

let opContext;

beforeAll(async () => {
  opContext = new OperationContext('en', await TestUtilities.loadTranslations(await TestUtilities.loadLanguageDefinitions()));
});

// The real implementation lives on the provider; this mirrors its signature so the test
// is about what the renderer asks for, not how the url is spelled.
function recordingResolver(calls) {
  return {
    // used by the "depends on" block, which a used-codesystem parameter brings with it
    resolveURL: async () => null,
    lookupLink: (system, version, code) => {
      calls.push({ system, version, code });
      return '/tx/r4/CodeSystem/$lookup?system=' + encodeURIComponent(system)
        + (version ? '&version=' + encodeURIComponent(version) : '') + '&code=' + encodeURIComponent(code);
    }
  };
}

function valueSet(expansion, compose) {
  return { resourceType: 'ValueSet', url: 'http://example.org/vs', status: 'active', compose, expansion };
}

async function render(vs) {
  const calls = [];
  const html = await new Renderer(opContext, recordingResolver(calls)).renderVSExpansion(vs, false);
  return { html, calls };
}

describe('codes in an expansion', () => {
  test('link to $lookup, with the code as the text', async () => {
    const { html } = await render(valueSet({
      contains: [{ system: SCT, code: '40541001', display: 'Acute pulmonary oedema' }]
    }));
    expect(html).toContain('href="/tx/r4/CodeSystem/$lookup?system=http%3A%2F%2Fsnomed.info%2Fsct&amp;code=40541001"');
    expect(html).toContain('40541001');
  });

  test('take the version from the expansion when the row does not carry one', async () => {
    const { calls } = await render(valueSet({
      parameter: [{ name: 'used-codesystem', valueUri: SCT + '|' + INTL }],
      contains: [{ system: SCT, code: '40541001' }]
    }));
    expect(calls).toEqual([{ system: SCT, version: INTL, code: '40541001' }]);
  });

  test('take it from the compose when the definition came back too', async () => {
    const { calls } = await render(valueSet(
      { contains: [{ system: SCT, code: '40541001' }] },
      { include: [{ system: SCT, version: INTL }] }
    ));
    expect(calls[0].version).toBe(INTL);
  });

  test('prefer the version on the row itself', async () => {
    const { calls } = await render(valueSet({
      parameter: [{ name: 'used-codesystem', valueUri: SCT + '|' + INTL }],
      contains: [{ system: SCT, version: 'http://snomed.info/sct/32506021000036107', code: '40541001' }]
    }));
    expect(calls[0].version).toBe('http://snomed.info/sct/32506021000036107');
  });

  test('link every row, including nested ones', async () => {
    const { calls } = await render(valueSet({
      contains: [{ system: SCT, code: 'a', contains: [{ system: SCT, code: 'b' }] }]
    }));
    expect(calls.map((c) => c.code)).toEqual(['a', 'b']);
  });

  test('are plain text when there is no resolver to build a link', async () => {
    const html = await new Renderer(opContext, null).renderVSExpansion(
      valueSet({ contains: [{ system: SCT, code: '40541001' }] }), false);
    expect(html).not.toContain('<a ');
    expect(html).toContain('40541001');
  });
});
