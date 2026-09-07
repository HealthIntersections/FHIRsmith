/**
 * Media type subsumption, and where it cannot be determined.
 *
 * A parameter narrows a media type - everything true of `application/xml` is true of
 * `application/xml; charset=utf-8` - so within one type/subtype the code with fewer
 * parameters subsumes the one that adds to them. That reasoning needs two things of a
 * parameter, though: that adding it narrows at all, and that two of its values exclude
 * one another. Both are properties of the specific parameter's definition, so neither
 * can be asserted for a parameter the server has never heard of.
 *
 * It also needs the parameter to have no DEFAULT, which is why the narrowing cases here are
 * written on application/xml and text/vcard rather than the obvious text/plain: all three of
 * text/plain's parameters default, so its bare form is not the general case. That is a whole
 * subject of its own - see mimetype-defaults.test.js.
 *
 * FHIR-58748: a server that cannot decide must say so rather than answer. $subsumes has
 * no outcome code meaning "unknown", so it comes back as an error carrying the
 * cannot-determine issue type.
 *
 * The case that matters most here is the last one in the first block: an unknown
 * parameter carried IDENTICALLY by both codes cannot affect the answer, so it must not
 * trigger a decline. Without it, an implementation that declines the moment it sees
 * anything unfamiliar would pass every other test in this file.
 */

const { OperationContext } = require('../../tx/operation-context');
const { MimeTypeServicesFactory } = require('../../tx/cs/cs-mimetypes');
const { TestUtilities } = require('../test-utilities');

describe('media type subsumption', () => {
  let provider;

  beforeEach(async () => {
    const opContext = new OperationContext('en', await TestUtilities.loadTranslations());
    provider = new MimeTypeServicesFactory(opContext.i18n).build(opContext, []);
  });

  async function outcome(a, b) {
    try {
      return await provider.subsumesTest(a, b);
    } catch (e) {
      return { cannotDetermine: true, txIssueType: e.txIssueType, statusCode: e.statusCode, message: e.message };
    }
  }

  describe('answers it can prove', () => {
    test.each([
      ['identical', 'text/plain', 'text/plain', 'equivalent'],
      ['case differences only', 'Text/Plain; CharSet=UTF-8', 'text/plain; charset=utf-8', 'equivalent'],
      ['an understood parameter added', 'application/xml', 'application/xml; charset=utf-8', 'subsumes'],
      ['the same, reversed', 'application/xml; charset=utf-8', 'application/xml', 'subsumed-by'],
      // text/vcard has a real version parameter (RFC 6350 s10.1) with no default, alongside a
      // charset that does default - so this exercises both mechanisms in one code
      ['two understood parameters', 'text/vcard; charset=utf-8', 'text/vcard; charset=utf-8; version=4.0', 'subsumes'],
      ['understood parameters with different values', 'text/plain; charset=utf-8', 'text/plain; charset=utf-16', 'not-subsumed'],
      ['disjoint understood parameters', 'text/plain; charset=utf-8', 'text/plain; format=flowed', 'not-subsumed'],
      ['different subtypes', 'text/plain', 'text/html', 'not-subsumed'],
      ['different types', 'text/plain', 'application/json', 'not-subsumed'],
      ['a structured syntax suffix is a separate registration', 'application/xml', 'application/fhir+xml', 'not-subsumed'],
      ['an unknown parameter identical on both sides cannot decide anything',
        'application/xml; foo=bar', 'application/xml; charset=utf-8; foo=bar', 'subsumes']
    ])('%s', async (_label, a, b, expected) => {
      expect(await outcome(a, b)).toBe(expected);
    });

    test('a type mismatch is decidable even with an unknown parameter present', async () => {
      // No parameter can make one media type a kind of another, so not knowing this one
      // does not stop the server answering.
      expect(await outcome('text/plain; foo=bar', 'application/json; foo=bar')).toBe('not-subsumed');
    });
  });

  describe('answers it cannot prove', () => {
    test.each([
      ['an unknown parameter added', 'text/plain', 'text/plain; foo=bar'],
      ['an unknown parameter with different values', 'text/plain; foo=bar', 'text/plain; foo=baz'],
      ['an unknown parameter against an understood one', 'text/plain; charset=utf-8', 'text/plain; foo=bar'],
      ['boundary, which does not narrow at all', 'multipart/form-data; boundary=X', 'multipart/form-data; boundary=Y'],
      ['profile, whose values may be hierarchical', 'application/fhir+json; profile=A', 'application/fhir+json; profile=B']
    ])('%s', async (_label, a, b) => {
      const r = await outcome(a, b);
      expect(r.cannotDetermine).toBe(true);
      expect(r.txIssueType).toBe('cannot-determine');
      expect(r.statusCode).toBe(422);
    });

    test('the message names the parameter that could not be judged', async () => {
      const r = await outcome('text/plain', 'text/plain; foo=bar');
      expect(r.message).toContain("'foo'");
      expect(r.message).toContain('text/plain; foo=bar');
    });

    test('several unknown parameters are all named', async () => {
      const r = await outcome('text/plain', 'text/plain; foo=bar; baz=qux');
      expect(r.message).toContain("'foo'");
      expect(r.message).toContain("'baz'");
      expect(r.message).toMatch(/parameters /);
    });
  });
});
