/**
 * The Special CodeSystems table on an endpoint's home page.
 *
 * These are the code systems the server implements natively - SNOMED, LOINC, UCUM and the
 * rest - rather than loading as resources, so they have no id in the resource space and
 * the table used to be four columns of dead text. They are readable though: read.js
 * serves a factory under its id with an "x-" prefix, which is the same id search.js puts
 * on the placeholder CodeSystem it synthesises. So the name links there.
 *
 * Not every factory has one. CodeSystemFactoryProvider.id() throws unless it is
 * overridden, and SNOMED's returns null when its version is not one of the recognised
 * edition URIs - a link built from either would be a 404, so the name stays as text.
 */

const { TxHtmlRenderer } = require('../../tx/tx-html');

function link(factory) {
  return new TxHtmlRenderer(null, null, null, null, '/tx/r4').factoryLink(factory);
}

const factory = (name, id) => ({ name: () => name, id: () => id });

describe('Special CodeSystems', () => {
  test('links the name to the code system page, under the endpoint', () => {
    expect(link(factory('LOINC 2.78', 'loinc2.78')))
      .toBe('<a href="/tx/r4/CodeSystem/x-loinc2.78">LOINC 2.78</a>');
  });

  test('escapes the id into the url - some are built from a version string', () => {
    expect(link(factory('RxNorm', 'RxNorm-11 Aug 2025')))
      .toContain('href="/tx/r4/CodeSystem/x-RxNorm-11%20Aug%202025"');
  });

  test('leaves the name as text when the factory has no id', () => {
    expect(link(factory('SNOMED CT', null))).toBe('SNOMED CT');
  });

  test('leaves the name as text when id() throws, rather than failing the page', () => {
    expect(link({ name: () => 'Unnamed', id: () => { throw new Error('Must override'); } }))
      .toBe('Unnamed');
  });

  test('escapes the name either way', () => {
    expect(link(factory('a & b <c>', 'ab'))).toContain('a &amp; b &lt;c&gt;');
    expect(link(factory('a & b <c>', null))).toBe('a &amp; b &lt;c&gt;');
  });
});
