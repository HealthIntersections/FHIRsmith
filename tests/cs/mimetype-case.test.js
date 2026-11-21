/**
 * Media type case folding.
 *
 * RFC 2045 section 5.1: "The type, subtype, and parameter names are not case sensitive. ...
 * Parameter values are normally case sensitive, but sometimes are interpreted in a
 * case-insensitive fashion, depending on the intended use."
 *
 * So the fold is asymmetric, and both halves matter. Type, subtype and every parameter NAME
 * fold, always. A parameter VALUE folds only where its own definition says so - charset
 * (RFC 2046 section 4.1.2, "the values of the charset parameter are NOT case sensitive") and
 * format and delsp (RFC 3676 section 4, "Neither the parameter names nor values are case
 * sensitive"). Everything else keeps its case, because a boundary or a profile URI can
 * genuinely differ by case and folding them would equate two things that are not the same.
 *
 * Two consequences are tested here. First, validation has to hand back the folded form as
 * the normalized-code, so a client that sent 'TEXT/Plain' is told what the code actually is.
 * The folding touches case and nothing else - not spacing, not quoting, not parameter order -
 * so the difference is always reportable as a case difference rather than a normal-form one.
 * Second, subsumption has to see through case: two spellings of one media type are
 * equivalent, and a case difference in a value that does NOT fold is a real difference.
 */

const { OperationContext } = require('../../tx/operation-context');
const { MimeTypeServicesFactory, MimeTypeConcept } = require('../../tx/cs/cs-mimetypes');
const { TestUtilities } = require('../test-utilities');

describe('media type case folding', () => {
  let provider;

  beforeEach(async () => {
    const opContext = new OperationContext('en', await TestUtilities.loadTranslations());
    provider = new MimeTypeServicesFactory(opContext.i18n).build(opContext, []);
  });

  describe('validating a case variant returns the folded form', () => {
    test.each([
      ['the type', 'TEXT/plain', 'text/plain'],
      ['the subtype', 'text/PLAIN', 'text/plain'],
      ['both', 'TEXT/PLAIN', 'text/plain'],
      ['a parameter name', 'text/plain; CharSet=utf-8', 'text/plain; charset=utf-8'],
      ['a charset value', 'text/plain; charset=UTF-8', 'text/plain; charset=utf-8'],
      ['all of it', 'Text/Plain; CharSet=UTF-8', 'text/plain; charset=utf-8'],
      ['a format value', 'text/plain; Format=Flowed', 'text/plain; format=flowed'],
      ['a delsp value', 'text/plain; DelSp=Yes', 'text/plain; delsp=yes'],
      ['several at once', 'TEXT/PLAIN; Format=FIXED; DelSp=No', 'text/plain; delsp=no; format=fixed'],
      ['a subtype with a suffix', 'Application/FHIR+JSON', 'application/fhir+json']
    ])('%s', async (_label, submitted, expected) => {
      const located = await provider.locate(submitted);
      expect(located.context).toBeTruthy();
      expect(await provider.code(submitted)).toBe(expected);
    });

    test('a code already in the folded form comes back unchanged', async () => {
      // the validator only reports a difference when there is one, so this is what keeps
      // an ordinary request quiet
      for (const code of ['text/plain', 'text/plain; charset=utf-8', 'application/json']) {
        expect(await provider.code(code)).toBe(code);
      }
    });

    test('the display follows the code', async () => {
      expect(await provider.display('TEXT/Plain; CharSet=UTF-8')).toBe('text/plain; charset=utf-8');
    });
  });

  describe('what is deliberately not folded', () => {
    test.each([
      ['a boundary value, which is case sensitive',
        'multipart/form-data; BOUNDARY=AbC123', 'multipart/form-data; boundary=AbC123'],
      ['a profile value, which may be a case-sensitive URI',
        'application/fhir+json; Profile=http://Example.org/X', 'application/fhir+json; profile=http://Example.org/X'],
      ['a version value, since no general definition says it folds',
        'Text/Plain; Version=1.0A', 'text/plain; version=1.0A'],
      ['an unknown parameter value', 'TEXT/Plain; Foo=BaR', 'text/plain; foo=BaR']
    ])('%s', async (_label, submitted, expected) => {
      expect(await provider.code(submitted)).toBe(expected);
    });

    test('quoting survives, because removing it needs to know the value has no tspecials', () => {
      expect(new MimeTypeConcept('TEXT/PLAIN; charset="UTF-8"').normalized).toBe('text/plain; charset="utf-8"');
    });

    test('an invalid code is returned as it came, not mangled', () => {
      expect(new MimeTypeConcept('NotAMimeType').normalized).toBe('NotAMimeType');
    });
  });

  describe('the rest of the canonical form', () => {
    // parameter order is not significant, so two spellings of one media type have to reduce
    // to one string - otherwise there is no normal form, only a lower-cased one
    test('parameters are sorted by name', () => {
      expect(new MimeTypeConcept('TEXT/PLAIN; Format=Flowed; CharSet=UTF-8').normalized)
        .toBe('text/plain; charset=utf-8; format=flowed');
    });

    test('the two orderings of one media type agree', () => {
      expect(new MimeTypeConcept('text/plain; charset=utf-8; format=flowed').normalized)
        .toBe(new MimeTypeConcept('text/plain; format=flowed; charset=utf-8').normalized);
    });

    test.each([
      ['no space after the semicolon', 'text/plain;charset=UTF-8', 'text/plain; charset=utf-8'],
      ['too much space', 'text/plain;   charset=UTF-8  ', 'text/plain; charset=utf-8'],
      ['space around the type', '  text/plain  ', 'text/plain'],
      ['a trailing semicolon', 'text/plain;', 'text/plain']
    ])('spacing is canonicalised: %s', (_label, submitted, expected) => {
      expect(new MimeTypeConcept(submitted).normalized).toBe(expected);
    });

    test('a segment that is not name=value is carried through untouched', () => {
      // the parser ignores it, but the canonical form must not claim the code said less than
      // it did. Its case is left alone: only parameter NAMES fold, and there is nothing here
      // to say this is one
      expect(new MimeTypeConcept('TEXT/PLAIN; Broken').normalized).toBe('text/plain; Broken');
    });

    test('reordering is a normal-form difference, not a case difference', () => {
      // which is what the validator reports it as - the two strings differ in more than case
      const submitted = 'text/plain; format=flowed; charset=utf-8';
      const normalized = new MimeTypeConcept(submitted).normalized;
      expect(normalized).not.toBe(submitted);
      expect(normalized.toLowerCase()).not.toBe(submitted.toLowerCase());
    });

    test('a pure case variant is still only a case difference', () => {
      // the common case stays quiet-ish: same spacing, same order, so only the case moved
      for (const code of ['TEXT/PLAIN', 'Text/Plain; CharSet=UTF-8', 'text/plain; Format=Flowed']) {
        expect(new MimeTypeConcept(code).normalized.toLowerCase()).toBe(code.toLowerCase());
      }
    });
  });

  describe('subsumption sees through case', () => {
    async function outcome(a, b) {
      try {
        return await provider.subsumesTest(a, b);
      } catch (e) {
        return { cannotDetermine: true, message: e.message };
      }
    }

    test.each([
      ['the type', 'TEXT/plain', 'text/plain'],
      ['the subtype', 'text/PLAIN', 'text/plain'],
      ['a parameter name', 'text/plain; CHARSET=utf-8', 'text/plain; charset=utf-8'],
      ['a charset value', 'text/plain; charset=UTF-8', 'text/plain; charset=utf-8'],
      ['a format value', 'text/plain; format=FLOWED', 'text/plain; format=flowed'],
      ['a delsp value', 'text/plain; delsp=YES', 'text/plain; delsp=yes'],
      ['everything at once', 'TEXT/PLAIN; CharSet=UTF-8; Format=Flowed', 'text/plain; charset=utf-8; format=flowed'],
      ['the name of a parameter the server does not understand',
        'application/fhir+json; PROFILE=http://example.org/X', 'application/fhir+json; profile=http://example.org/X']
    ])('a difference of case in %s is not a difference', async (_label, a, b) => {
      expect(await outcome(a, b)).toBe('equivalent');
    });

    test('a folded value still narrows when it is actually added', async () => {
      // on a type where charset has no default - text/plain's does, see
      // mimetype-defaults.test.js
      expect(await outcome('APPLICATION/XML', 'application/xml; CharSet=UTF-8')).toBe('subsumes');
      expect(await outcome('application/xml; CharSet=UTF-8', 'APPLICATION/XML')).toBe('subsumed-by');
    });

    test('a folded value with genuinely different values is still not subsumed', async () => {
      expect(await outcome('text/plain; charset=UTF-8', 'TEXT/PLAIN; CharSet=UTF-16')).toBe('not-subsumed');
      expect(await outcome('text/plain; Format=FIXED', 'text/plain; format=Flowed')).toBe('not-subsumed');
    });

    test('a case difference in a value that does NOT fold is a real difference', async () => {
      // the names fold, so the parameter lines up on both sides; the values do not, so the
      // codes differ in boundary, which the server cannot reason about
      const r = await outcome('multipart/form-data; BOUNDARY=abc', 'multipart/form-data; boundary=ABC');
      expect(r.cannotDetermine).toBe(true);
      expect(r.message).toContain("'boundary'");
    });

    test('different types are still different however they are spelt', async () => {
      expect(await outcome('TEXT/PLAIN', 'Application/JSON')).toBe('not-subsumed');
    });
  });
});
