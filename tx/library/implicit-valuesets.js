/**
 * Choosing which version of a code system an implicit value set URL is drawn from, when
 * several versions are loaded (SNOMED CT editions, typically). A factory that can say what
 * form an implicit value set URL takes implements implicitValueSetForm(url), returning
 * {form: 'generic'|'edition'|'version'} or null:
 *
 *   generic  (http://snomed.info/sct?fhir_vs...)  - the version the request asks for
 *            (system-version and the like, through systemVersionFor) where a loaded version
 *            matches it, else the default version: the one registered under the bare system
 *   edition  (http://snomed.info/sct/<edition>?fhir_vs...) - the latest version of that
 *            edition the server has
 *   version  (.../version/<date>?fhir_vs...) - that version; only it matches
 *
 * @param {Iterable<object>} factories - the registered code system factories (duplicates are ignored)
 * @param {function(string): object} defaultFor - the default factory for a system url
 * @param {string} url - the value set url
 * @param {function(string): (string|null)} [systemVersionFor] - the version the request asks for, for a system
 * @returns {object|null} the factory to build the value set, or null if none recognises the url
 */
function chooseImplicitValueSetFactory(factories, defaultFor, url, systemVersionFor = null) {
  const matches = [];
  const seen = new Set();
  for (const csp of factories) {
    if (seen.has(csp) || typeof csp.implicitValueSetForm !== 'function') {
      continue;
    }
    seen.add(csp);
    const form = csp.implicitValueSetForm(url);
    if (form) {
      matches.push({ csp, form: form.form });
    }
  }
  if (matches.length === 0) {
    return null;
  }
  if (matches.every(m => m.form === 'generic')) {
    const requested = systemVersionFor ? systemVersionFor(matches[0].csp.system()) : null;
    if (requested) {
      // an edition (with or without its version) or a full version uri; the latest that matches
      const asked = matches.filter(m => versionMatches(m.csp, requested));
      if (asked.length > 0) {
        asked.sort((a, b) => (b.csp.version() || '').localeCompare(a.csp.version() || ''));
        return asked[0].csp;
      }
    }
    const preferred = defaultFor(matches[0].csp.system());
    return matches.some(m => m.csp === preferred) ? preferred : matches[0].csp;
  }
  // edition or version form: the latest version that matches. Version URIs of one edition
  // differ only in their date, so they order as strings.
  const specific = matches.filter(m => m.form !== 'generic');
  specific.sort((a, b) => (b.csp.version() || '').localeCompare(a.csp.version() || ''));
  return specific[0].csp;
}

// Whether a factory's version is the one asked for: the same version, or a version of the
// edition asked for (SNOMED CT: http://snomed.info/sct/<edition> covers .../version/<date>)
function versionMatches(csp, requested) {
  if (typeof csp.isMyEdition === 'function') {
    return csp.isMyEdition(requested);
  }
  const mine = csp.version() || '';
  return mine === requested || mine.startsWith(requested + '/version/');
}

module.exports = { chooseImplicitValueSetFactory };
