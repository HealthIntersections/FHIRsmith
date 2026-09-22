/**
 * The $lookup link a code in an expansion points at.
 *
 * It lives on the provider because the provider is what knows the endpoint path, and it
 * is deliberately not resolveCode: resolveCode answers "where does this code live" and
 * lands on a code system page or the publisher's own browser, which is the right answer
 * in prose and the wrong one in a list of codes somebody is trying to read.
 */

const { Provider } = require('../../tx/provider');

// Only the path is needed, and building a real Provider means building a library.
const provider = Object.create(Provider.prototype);
provider.path = '/tx/r4';

describe('lookupLink', () => {
  test('carries system, version and code', () => {
    expect(provider.lookupLink('http://loinc.org', '2.78', '1234-5'))
      .toBe('/tx/r4/CodeSystem/$lookup?system=http%3A%2F%2Floinc.org&version=2.78&code=1234-5');
  });

  test('leaves the version out when there is none, so the server picks', () => {
    expect(provider.lookupLink('http://loinc.org', null, '1234-5'))
      .toBe('/tx/r4/CodeSystem/$lookup?system=http%3A%2F%2Floinc.org&code=1234-5');
  });

  test('splits a version carried on the system', () => {
    expect(provider.lookupLink('http://loinc.org|2.78', null, '1234-5')).toContain('&version=2.78');
  });

  test('escapes a code that is not url safe - a post-coordinated expression is not', () => {
    expect(provider.lookupLink('http://snomed.info/sct', null, '83152002:405815000=122456005'))
      .toContain('code=83152002%3A405815000%3D122456005');
  });

  test('builds nothing without a system or a code', () => {
    expect(provider.lookupLink(null, null, '1234-5')).toBeNull();
    expect(provider.lookupLink('http://loinc.org', null, null)).toBeNull();
  });
});
