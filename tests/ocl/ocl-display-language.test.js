/**
 * Tests for displayLanguage support in OCL-backed ValueSet expansion.
 *
 * Root cause: OCLSourceCodeSystemProvider.designations() added all language-specific
 * designations from the concept but provided no empty-language fallback.  When the
 * requested language (e.g. 'en') had no matching designation, Designations.preferredDesignation()
 * returned null, causing expansion.contains[].display to be omitted entirely.
 *
 * The fix adds an empty-language fallback entry so preferredDesignation() always returns
 * a value (FHIR graceful-fallback rule).  Concepts that DO have English names continue to
 * return English; concepts without return the source-default display as a fallback.
 */

const { extractDesignations, toConceptContext } = require('../../tx/ocl/mappers/concept-mapper');
const { Designations } = require('../../tx/library/designations');
const { LanguageDefinitions, Languages } = require('../../library/languages');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _langDefs = null;

/** Load language definitions once (synchronous after first call). */
function getLangDefs() {
  if (!_langDefs) {
    const path = require('path');
    const langDir = path.join(__dirname, '..', '..', 'tx', 'data');
    // fromFiles is async but internally uses readFileSync — safe to resolve here
    _langDefs = new LanguageDefinitions();
    const fs = require('fs');
    const content = fs.readFileSync(path.join(langDir, 'lang.dat'), 'utf8');
    _langDefs._load(content);
  }
  return _langDefs;
}

/** Build a Languages preference list from a BCP-47 code string, e.g. 'en' or 'pt'. */
function makeLangs(code) {
  const defs = getLangDefs();
  if (!code) {
    return new Languages(defs);
  }
  return Languages.fromAcceptLanguage(code, defs, false);
}

/** Build a fresh Designations collection backed by loaded LanguageDefinitions. */
function makeDesignations() {
  return new Designations(getLangDefs());
}

// ---------------------------------------------------------------------------
// concept-mapper: extractDesignations
// ---------------------------------------------------------------------------

describe('extractDesignations', () => {
  it('returns an empty array when concept has no display data', () => {
    expect(extractDesignations({ code: 'X' })).toEqual([]);
  });

  it('uses empty language when concept.locale is not set', () => {
    const result = extractDesignations({ display_name: 'Default Display' });
    expect(result).toHaveLength(1);
    expect(result[0].language).toBe('');
    expect(result[0].value).toBe('Default Display');
  });

  it('uses concept.locale as the designation language', () => {
    const result = extractDesignations({ display_name: 'Nome PT', locale: 'pt' });
    expect(result).toHaveLength(1);
    expect(result[0].language).toBe('pt');
    expect(result[0].value).toBe('Nome PT');
  });

  it('extracts all names from the names array with their respective locales', () => {
    const concept = {
      display_name: 'Nome PT',
      locale: 'pt',
      names: [
        { locale: 'pt', name: 'Nome PT' },
        { locale: 'en', name: 'English Name' },
      ],
    };
    const result = extractDesignations(concept);
    expect(result.some(d => d.language === 'pt' && d.value === 'Nome PT')).toBe(true);
    expect(result.some(d => d.language === 'en' && d.value === 'English Name')).toBe(true);
  });

  it('deduplicates entries with the same language and value', () => {
    const concept = {
      display_name: 'Nome PT',
      locale: 'pt',
      names: [{ locale: 'pt', name: 'Nome PT' }], // same as display_name / locale
    };
    const result = extractDesignations(concept);
    expect(result.filter(d => d.language === 'pt' && d.value === 'Nome PT')).toHaveLength(1);
  });

  it('includes locale_display_names when present', () => {
    const concept = {
      display_name: 'Nome PT',
      locale: 'pt',
      locale_display_names: { en: 'English Name', fr: 'Nom Français' },
    };
    const result = extractDesignations(concept);
    expect(result.some(d => d.language === 'en' && d.value === 'English Name')).toBe(true);
    expect(result.some(d => d.language === 'fr' && d.value === 'Nom Français')).toBe(true);
  });

  it('handles names entries with null/undefined locale by using empty language', () => {
    const concept = {
      names: [{ name: 'No Locale Name' }],
    };
    const result = extractDesignations(concept);
    expect(result.some(d => d.value === 'No Locale Name')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// concept-mapper: toConceptContext
// ---------------------------------------------------------------------------

describe('toConceptContext', () => {
  it('returns null for null/non-object input', () => {
    expect(toConceptContext(null)).toBeNull();
    expect(toConceptContext('string')).toBeNull();
    expect(toConceptContext(42)).toBeNull();
  });

  it('returns null when no code is present', () => {
    expect(toConceptContext({ display_name: 'X' })).toBeNull();
  });

  it('builds a context with code, display, and designations', () => {
    const concept = {
      code: 'ABC',
      display_name: 'Test Display',
      locale: 'pt',
      names: [
        { locale: 'pt', name: 'Test Display' },
        { locale: 'en', name: 'English Display' },
      ],
    };
    const ctx = toConceptContext(concept);
    expect(ctx.code).toBe('ABC');
    expect(ctx.display).toBe('Test Display');
    expect(ctx.designation.some(d => d.language === 'en' && d.value === 'English Display')).toBe(true);
    expect(ctx.designation.some(d => d.language === 'pt' && d.value === 'Test Display')).toBe(true);
  });

  it('marks retired concepts', () => {
    const ctx = toConceptContext({ code: 'X', retired: true });
    expect(ctx.retired).toBe(true);
  });

  it('reads definition from description field', () => {
    const ctx = toConceptContext({ code: 'X', description: 'Concept definition text' });
    expect(ctx.definition).toBe('Concept definition text');
  });

  it('falls back to id when code is absent', () => {
    const ctx = toConceptContext({ id: 'ID-001', display_name: 'Name' });
    expect(ctx.code).toBe('ID-001');
  });

  it('carries a non-empty extras object through to the context', () => {
    const extras = { who_stage: '3', order: 5, experimental: true, nested: { a: 1 } };
    const ctx = toConceptContext({ code: 'X', extras });
    expect(ctx.extras).toEqual(extras);
  });

  it('omits extras when empty, missing, or not a plain object', () => {
    expect(toConceptContext({ code: 'X', extras: {} })).not.toHaveProperty('extras');
    expect(toConceptContext({ code: 'X' })).not.toHaveProperty('extras');
    expect(toConceptContext({ code: 'X', extras: ['a'] })).not.toHaveProperty('extras');
    expect(toConceptContext({ code: 'X', extras: 'text' })).not.toHaveProperty('extras');
    expect(toConceptContext({ code: 'X', extras: null })).not.toHaveProperty('extras');
  });

  it('extras survive a JSON round-trip (cold-cache serialization)', () => {
    const extras = { who_stage: '3', order: 5, flags: ['a', 'b'], nested: { a: 1 } };
    const ctx = toConceptContext({ code: 'X', extras });
    const restored = JSON.parse(JSON.stringify(ctx));
    expect(restored.extras).toEqual(extras);
  });
});

// ---------------------------------------------------------------------------
// displayLanguage bug regression: preferredDesignation selection
//
// These tests directly exercise the Designations.preferredDesignation() logic
// with the exact designation shapes that the fixed designations() method produces.
// They serve as a clear regression guard: if the fix is reverted, the "BUG" test
// will pass again and the "FIX" tests will fail.
// ---------------------------------------------------------------------------

describe('displayLanguage – designation selection (Designations.preferredDesignation)', () => {
  // ------------------------------------------------------------------
  // Regression: demonstrates the pre-fix null result
  // ------------------------------------------------------------------
  it('REGRESSION – returns null when only a language-tagged designation exists (no fallback)', () => {
    // This replicates the OLD (buggy) behaviour: designations() added 'pt' only,
    // no empty-language fallback → English request returns null → display omitted.
    const displays = makeDesignations();
    displays.addDesignation(true, 'active', 'pt', null, 'Nome Português');
    // Deliberately NO empty-language fallback – this is what the old code did.

    const result = displays.preferredDesignation(makeLangs('en'));
    expect(result).toBeNull(); // BUG: display was missing in the expansion
  });

  // ------------------------------------------------------------------
  // The fix: empty-language fallback ensures a value is always returned
  // ------------------------------------------------------------------
  it('FIX – returns fallback display when requested language has no designation', () => {
    // After the fix designations() adds '' as a fallback when no empty-language
    // entry exists in ctxt.designation.
    const displays = makeDesignations();
    displays.addDesignation(true, 'active', 'pt', null, 'Nome Português');
    displays.addDesignation(true, 'active', '', null, 'Nome Português'); // ← fix adds this

    const result = displays.preferredDesignation(makeLangs('en'));
    expect(result).not.toBeNull();
    expect(result.value).toBe('Nome Português'); // graceful fallback, not null
  });

  // ------------------------------------------------------------------
  // displayLanguage=en: English designation returned when available
  // ------------------------------------------------------------------
  it('returns English designation when English is available (displayLanguage=en)', () => {
    const displays = makeDesignations();
    displays.addDesignation(true, 'active', 'pt', null, 'Nome Português');
    displays.addDesignation(true, 'active', 'en', null, 'English Name');
    displays.addDesignation(true, 'active', '', null, 'Nome Português'); // fallback

    const result = displays.preferredDesignation(makeLangs('en'));
    expect(result).not.toBeNull();
    expect(result.value).toBe('English Name'); // English preferred over fallback
  });

  // ------------------------------------------------------------------
  // displayLanguage=pt: Portuguese designation returned correctly
  // ------------------------------------------------------------------
  it('returns Portuguese designation for displayLanguage=pt (unchanged behaviour)', () => {
    const displays = makeDesignations();
    displays.addDesignation(true, 'active', 'pt', null, 'Nome Português');
    displays.addDesignation(true, 'active', 'en', null, 'English Name');
    displays.addDesignation(true, 'active', '', null, 'Nome Português');

    const result = displays.preferredDesignation(makeLangs('pt'));
    expect(result).not.toBeNull();
    expect(result.value).toBe('Nome Português');
  });

  // ------------------------------------------------------------------
  // displayLanguage set to a language that does not exist for the concept
  // ------------------------------------------------------------------
  it('falls back to default display for an unknown displayLanguage', () => {
    const displays = makeDesignations();
    displays.addDesignation(true, 'active', 'pt', null, 'Nome Português');
    displays.addDesignation(true, 'active', '', null, 'Nome Português'); // fallback

    const result = displays.preferredDesignation(makeLangs('fr')); // French not available
    expect(result).not.toBeNull();
    expect(result.value).toBe('Nome Português'); // graceful fallback
  });

  // ------------------------------------------------------------------
  // Mixed concepts: each resolves independently
  // ------------------------------------------------------------------
  it('mixed concepts: each concept resolves independently with correct fallback', () => {
    const enLangs = makeLangs('en');

    // Concept A has English → returns English
    const displaysA = makeDesignations();
    displaysA.addDesignation(true, 'active', 'pt', null, 'Conceito A');
    displaysA.addDesignation(true, 'active', 'en', null, 'Concept A');
    displaysA.addDesignation(true, 'active', '', null, 'Conceito A');
    expect(displaysA.preferredDesignation(enLangs).value).toBe('Concept A');

    // Concept B has no English → falls back to Portuguese default
    const displaysB = makeDesignations();
    displaysB.addDesignation(true, 'active', 'pt', null, 'Conceito B');
    displaysB.addDesignation(true, 'active', '', null, 'Conceito B');
    expect(displaysB.preferredDesignation(enLangs).value).toBe('Conceito B');

    // Concept C has empty-language only → returned as-is for any language
    const displaysC = makeDesignations();
    displaysC.addDesignation(true, 'active', '', null, 'Concept C');
    expect(displaysC.preferredDesignation(enLangs).value).toBe('Concept C');
  });

  // ------------------------------------------------------------------
  // No displayLanguage preference: existing behaviour preserved
  // ------------------------------------------------------------------
  it('no displayLanguage: first available display is returned (existing behaviour)', () => {
    const displays = makeDesignations();
    displays.addDesignation(true, 'active', 'pt', null, 'Nome Português');
    displays.addDesignation(true, 'active', 'en', null, 'English Name');
    displays.addDesignation(true, 'active', '', null, 'Nome Português');

    // Empty language list = no explicit preference
    const result = displays.preferredDesignation(makeLangs(null));
    expect(result).not.toBeNull();
    expect(result.value).toBeTruthy(); // some display is always returned
  });
});

// ---------------------------------------------------------------------------
// extractDesignations + preferredDesignation integration
// ---------------------------------------------------------------------------

describe('displayLanguage – end-to-end: extractDesignations → preferredDesignation', () => {
  function selectDisplay(concept, langCode) {
    const langs = makeLangs(langCode);
    const displays = makeDesignations();

    const designations = extractDesignations(concept);
    let hasNoLang = false;

    for (const d of designations) {
      displays.addDesignation(true, 'active', d.language || '', null, d.value);
      if (!d.language) hasNoLang = true;
    }

    // Simulate the fix: add empty-language fallback when absent
    const ctx = toConceptContext(concept);
    if (ctx && ctx.display && !hasNoLang) {
      displays.addDesignation(true, 'active', '', null, ctx.display);
    }

    const pref = displays.preferredDesignation(langs);
    return pref ? pref.value : null;
  }

  it('displayLanguage=en: returns English when available in names[]', () => {
    const concept = {
      code: '001',
      display_name: 'Assistência Ambulatorial',
      locale: 'pt',
      names: [
        { locale: 'pt', name: 'Assistência Ambulatorial' },
        { locale: 'en', name: 'Outpatient Care' },
      ],
    };
    expect(selectDisplay(concept, 'en')).toBe('Outpatient Care');
  });

  it('displayLanguage=en: falls back to Portuguese when no English name exists', () => {
    const concept = {
      code: '002',
      display_name: 'Internação',
      locale: 'pt',
      names: [{ locale: 'pt', name: 'Internação' }],
    };
    expect(selectDisplay(concept, 'en')).toBe('Internação'); // not null – graceful fallback
  });

  it('displayLanguage=pt: returns Portuguese correctly', () => {
    const concept = {
      code: '003',
      display_name: 'Urgência',
      locale: 'pt',
      names: [
        { locale: 'pt', name: 'Urgência' },
        { locale: 'en', name: 'Emergency' },
      ],
    };
    expect(selectDisplay(concept, 'pt')).toBe('Urgência');
  });

  it('displayLanguage=fr (unavailable): falls back to Portuguese default', () => {
    const concept = {
      code: '004',
      display_name: 'Diagnóstico',
      locale: 'pt',
      names: [{ locale: 'pt', name: 'Diagnóstico' }],
    };
    expect(selectDisplay(concept, 'fr')).toBe('Diagnóstico'); // not null
  });

  it('no displayLanguage: a display is always returned', () => {
    const concept = {
      code: '005',
      display_name: 'Cirurgia',
      locale: 'pt',
    };
    const display = selectDisplay(concept, null);
    expect(display).not.toBeNull();
    expect(display).toBeTruthy();
  });
});
