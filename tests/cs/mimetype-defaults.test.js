/**
 * Media type parameters that carry a default value.
 *
 * The rule everywhere else in this code system is that a parameter narrows: everything true of
 * `text/plain` is true of `text/plain; charset=utf-8`, so the bare form subsumes the refined
 * one. That rule is unsound wherever the registration gives the parameter a DEFAULT, because
 * then the bare form is not the general case - it already carries a value. `text/plain` means
 * `text/plain; charset=us-ascii; format=fixed; delsp=no`, which makes it disjoint from
 * `text/plain; charset=utf-8` rather than its parent.
 *
 * There is no list of these. IANA's registry schema has no parameter element at all, and
 * `text/plain` - the type that needs it most - has no IANA registration template whatsoever.
 * Everything below is read out of the defining RFCs by hand:
 *
 *   text/plain charset  US-ASCII   RFC 2046 s4.1.2, kept by RFC 6657 s4
 *   text/plain format   Fixed      RFC 3676 s4
 *   text/plain delsp    No         RFC 3676 s4
 *   text/vcard charset  UTF-8      RFC 6350 s3.1
 *
 * Applying them is not a pure loss of answers. It turns some wrong `subsumes` into right
 * `equivalent` - `text/plain` and `text/plain; charset=us-ascii` are the same media type, and
 * we used to say one subsumed the other.
 *
 * The awkward part is RFC 6657 s3: "existing "text/*" registrations that fail to specify how
 * the charset is determined still default to US-ASCII." Silence in a text/* registration is
 * therefore not the absence of a default, and that set cannot be enumerated. So charset on an
 * unread text/* type is cannot-determine, and TEXT_TYPES_WITH_NO_CHARSET_DEFAULT is the escape
 * hatch for the ones we have actually read - text/markdown, which says so outright, and
 * text/html, which is a reading rather than a quote (see the comment on that set).
 */

const { OperationContext } = require('../../tx/operation-context');
const { MimeTypeServicesFactory } = require('../../tx/cs/cs-mimetypes');
const { TestUtilities } = require('../test-utilities');

describe('media type parameter defaults', () => {
  let provider;

  beforeEach(async () => {
    const opContext = new OperationContext('en', await TestUtilities.loadTranslations());
    provider = new MimeTypeServicesFactory(opContext.i18n).build(opContext, []);
  });

  async function outcome(a, b) {
    try {
      return await provider.subsumesTest(a, b);
    } catch (e) {
      return { cannotDetermine: true, txIssueType: e.txIssueType, message: e.message };
    }
  }

  describe('a parameter at its default is the bare form', () => {
    test.each([
      ['charset, RFC 2046 s4.1.2 / RFC 6657 s4', 'text/plain', 'text/plain; charset=us-ascii'],
      ['charset, the other way round', 'text/plain; charset=US-ASCII', 'text/plain'],
      ['format, RFC 3676 s4', 'text/plain', 'text/plain; format=fixed'],
      ['delsp, RFC 3676 s4', 'text/plain', 'text/plain; delsp=no'],
      ['all three at once', 'text/plain', 'text/plain; charset=us-ascii; format=fixed; delsp=no'],
      ['text/vcard charset, RFC 6350 s3.1', 'text/vcard', 'text/vcard; charset=utf-8']
    ])('%s', async (_label, a, b) => {
      expect(await outcome(a, b)).toBe('equivalent');
    });
  });

  describe('a parameter away from its default contradicts the bare form', () => {
    // this is the change: these used to come back subsumes / subsumed-by
    test.each([
      ['a different charset', 'text/plain', 'text/plain; charset=utf-8'],
      ['the same reversed', 'text/plain; charset=utf-8', 'text/plain'],
      ['format=flowed against the implied fixed', 'text/plain', 'text/plain; format=flowed'],
      ['delsp=yes against the implied no', 'text/plain', 'text/plain; delsp=yes'],
      ['a parameter added to one that already differs by default',
        'text/plain; charset=utf-8', 'text/plain; charset=utf-8; format=flowed']
    ])('%s', async (_label, a, b) => {
      expect(await outcome(a, b)).toBe('not-subsumed');
    });

    test('an unknown parameter shared by both no longer hides the charset default', async () => {
      // foo is identical on both sides so it decides nothing, but the implied us-ascii on the
      // left and the explicit utf-8 on the right do
      expect(await outcome('text/plain; foo=bar', 'text/plain; charset=utf-8; foo=bar'))
        .toBe('not-subsumed');
    });
  });

  describe('where there is no default, a parameter still narrows', () => {
    test.each([
      ['application/xml, RFC 7303 s3.2 tells consumers not to assume one',
        'application/xml', 'application/xml; charset=utf-8', 'subsumes'],
      ['the same reversed', 'application/xml; charset=utf-8', 'application/xml', 'subsumed-by'],
      ['text/markdown, RFC 7763 s2 says there is no default value',
        'text/markdown', 'text/markdown; charset=utf-8', 'subsumes'],
      ['the same reversed', 'text/markdown; charset=utf-8', 'text/markdown', 'subsumed-by'],
      ['text/html, whose charset overrides the in-band declaration rather than defaulting',
        'text/html', 'text/html; charset=utf-8', 'subsumes'],
      ['the same reversed', 'text/html; charset=utf-8', 'text/html', 'subsumed-by'],
      ['an unknown parameter shared by both still decides nothing',
        'application/xml; foo=bar', 'application/xml; charset=utf-8; foo=bar', 'subsumes']
    ])('%s', async (_label, a, b, expected) => {
      expect(await outcome(a, b)).toBe(expected);
    });
  });

  describe('RFC 6657 leaves unread text/* types undecidable on charset', () => {
    test.each([
      ['text/csv', 'text/csv', 'text/csv; charset=utf-8'],
      ['the other way round', 'text/csv; charset=utf-8', 'text/csv'],
      ['text/richtext, a legacy type with no IANA template at all',
        'text/richtext', 'text/richtext; charset=utf-8']
    ])('%s', async (_label, a, b) => {
      const r = await outcome(a, b);
      expect(r.cannotDetermine).toBe(true);
      expect(r.txIssueType).toBe('cannot-determine');
      expect(r.message).toContain('RFC 6657');
    });

    test('the message says what the ambiguity actually is', async () => {
      const r = await outcome('text/csv', 'text/csv; charset=utf-8');
      expect(r.message).toContain('text/csv');
      expect(r.message).toContain('US-ASCII');
    });

    test('two explicit charsets are decidable - the default never comes into it', async () => {
      // the residual rule only bites where one side is silent
      expect(await outcome('text/csv; charset=utf-8', 'text/csv; charset=utf-16'))
        .toBe('not-subsumed');
    });

    test('an identical charset on both sides is decidable too', async () => {
      expect(await outcome('text/csv; charset=utf-8', 'text/csv; charset=utf-8'))
        .toBe('equivalent');
    });

    test('it does not reach non-text types, where RFC 6657 does not apply', async () => {
      expect(await outcome('application/pdf', 'application/pdf; charset=utf-8')).toBe('subsumes');
    });

    test('a text/* type with no charset in play is unaffected', async () => {
      expect(await outcome('text/csv', 'text/csv')).toBe('equivalent');
      expect(await outcome('text/csv', 'text/plain')).toBe('not-subsumed');
    });
  });

  describe('the defaults do not disturb what was already decidable', () => {
    test.each([
      ['different subtypes', 'text/plain', 'text/html', 'not-subsumed'],
      ['different types', 'text/plain', 'application/json', 'not-subsumed'],
      ['a structured syntax suffix', 'application/xml', 'application/fhir+xml', 'not-subsumed'],
      ['identical codes', 'text/plain', 'text/plain', 'equivalent'],
      ['identical but for case', 'Text/Plain; CharSet=UTF-8', 'text/plain; charset=utf-8', 'equivalent'],
      ['two explicit charsets', 'text/plain; charset=utf-8', 'text/plain; charset=utf-16', 'not-subsumed'],
      ['disjoint parameters', 'text/plain; charset=utf-8', 'text/plain; format=flowed', 'not-subsumed']
    ])('%s', async (_label, a, b, expected) => {
      expect(await outcome(a, b)).toBe(expected);
    });

    test('an unknown parameter is still cannot-determine, and for its own reason', async () => {
      const r = await outcome('application/xml', 'application/xml; foo=bar');
      expect(r.cannotDetermine).toBe(true);
      expect(r.message).toContain("'foo'");
      expect(r.message).not.toContain('RFC 6657');
    });
  });
});
