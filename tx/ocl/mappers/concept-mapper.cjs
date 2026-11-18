function toConceptContext(concept) {
  if (!concept || typeof concept !== 'object') {
    return null;
  }

  const code = concept.code || concept.id || null;
  if (!code) {
    return null;
  }

  const ctx = {
    code,
    display: concept.display_name || concept.display || concept.name || null,
    definition: concept.description || concept.definition || null,
    retired: concept.retired === true,
      designation: extractDesignations(concept)
  };

  const extras = concept.extras;
  if (extras && typeof extras === 'object' && !Array.isArray(extras)
      && Object.keys(extras).length > 0) {
    ctx.extras = extras;
  }

  return ctx;
}

function extractDesignations(concept) {
  const result = [];
  const seen = new Set();
  const seenValues = new Set();

  const add = (language, value) => {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) {
      return;
    }

    const lang = typeof language === 'string' ? language.trim() : '';

    // Skip empty-language entries whose value already appears under any language
    if (!lang && seenValues.has(text)) {
      return;
    }

    const key = `${lang}|${text}`;
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    seenValues.add(text);
    result.push({ language: lang, value: text });
  };

  if (Array.isArray(concept.names)) {
    for (const entry of concept.names) {
      if (!entry || typeof entry !== 'object') {
        continue;
      }
      // Prioriza locale como language
      const lang = entry.locale;
      const value = entry.name;
      add(lang, value);
    }
  }

  if (concept.display_name || concept.display || concept.name) {
    add(concept.locale || concept.default_locale || concept.language || '', concept.display_name || concept.display || concept.name);
  }

  if (concept.locale_display_names && typeof concept.locale_display_names === 'object') {
    for (const [lang, value] of Object.entries(concept.locale_display_names)) {
      add(lang, value);
    }
  }

  return result;
}

module.exports = {
  toConceptContext,
  extractDesignations
};
