// The VSAC provider follows a search bundle's next link only on the VSAC server: every request
// carries the API key, so a next link must not be able to send it somewhere else

const { VSACValueSetProvider } = require('../../tx/vs/vs-vsac');

function provider(baseUrl = 'https://cts.nlm.nih.gov/fhir') {
  const p = Object.create(VSACValueSetProvider.prototype);
  p.baseUrl = baseUrl;
  return p;
}

const bundle = (url) => ({ resourceType: 'Bundle', link: [{ relation: 'self', url: 'x' }, { relation: 'next', url }] });

describe('VSAC next links', () => {
  let warn;
  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  test('a next link on the VSAC server becomes a path under baseUrl, whatever its scheme', () => {
    for (const url of ['https://cts.nlm.nih.gov/fhir/ValueSet?_count=100&_offset=100', 'http://cts.nlm.nih.gov/fhir/ValueSet?_count=100&_offset=100']) {
      expect(provider()._getNextUrl(bundle(url))).toBe('/ValueSet?_count=100&_offset=100');
    }
    expect(warn).not.toHaveBeenCalled();
  });

  test('a relative next link is taken against baseUrl', () => {
    expect(provider()._getNextUrl(bundle('ValueSet?page=2'))).toBe('/ValueSet?page=2');
    expect(provider()._getNextUrl(bundle('/fhir/ValueSet?page=2'))).toBe('/ValueSet?page=2');
  });

  test('a next link anywhere else is not followed', () => {
    for (const url of ['https://elsewhere.example.org/fhir/ValueSet?page=2', 'https://cts.nlm.nih.gov.example.org/fhir/ValueSet', 'https://cts.nlm.nih.gov/other/ValueSet', '//elsewhere.example.org/fhir/ValueSet']) {
      expect(provider()._getNextUrl(bundle(url))).toBeNull();
    }
    expect(warn).toHaveBeenCalledTimes(4);
  });

  test('no next link is the end', () => {
    expect(provider()._getNextUrl({ resourceType: 'Bundle', link: [{ relation: 'self', url: 'x' }] })).toBeNull();
    expect(provider()._getNextUrl({ resourceType: 'Bundle' })).toBeNull();
  });
});
