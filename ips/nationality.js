//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * The nationality step - the first processing step: which nation an IPS document is from,
 * as far as the document itself says. Few national IGs give a way to tell, so this is a
 * short list of signs, to grow as more are found:
 *
 *   US  the Bundle claims the US Patient Summary profile (Bundle-us-pcs), or a US Core
 *       extension is used anywhere in the document
 *   AU  the Bundle claims the AU Patient Summary profile (au-ps-bundle)
 *
 * The result is { jurisdiction, reasons: [{ jurisdiction, text }] }: jurisdiction is the
 * nation's ISO 3166 two-letter code, or null when it is unknown - nothing points to a nation,
 * or the signs point to more than one (then the reasons say which).
 *
 * @module ips/nationality
 */

const US_CORE_EXTENSIONS = 'http://hl7.org/fhir/us/core/StructureDefinition/';
// how many extension urls a reason names
const MAX_NAMED = 3;

/** The profiles a resource claims (meta.profile), without their versions. */
function profilesOf(resource) {
  const p = resource?.meta?.profile;
  return Array.isArray(p) ? p.filter(x => typeof x === 'string').map(x => x.split('|')[0]) : [];
}

/** Every extension url in the document, at any depth, each once. */
function extensionUrls(node, found = new Set()) {
  if (Array.isArray(node)) {
    for (const n of node) {
      extensionUrls(n, found);
    }
  } else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if ((k === 'extension' || k === 'modifierExtension') && Array.isArray(v)) {
        for (const e of v) {
          if (e && typeof e.url === 'string') {
            found.add(e.url);
          }
        }
      }
      extensionUrls(v, found);
    }
  }
  return found;
}

/** A Bundle profile that says which nation a document is from. */
function profileRule(jurisdiction, url, name) {
  return (bundle) => (profilesOf(bundle).includes(url) ? `the Bundle claims the ${name} profile (${url})` : null);
}

const RULES = [
  { jurisdiction: 'US', test: profileRule('US', 'http://hl7.org/fhir/us/pcs/StructureDefinition/Bundle-us-pcs', 'US Patient Summary') },
  {
    jurisdiction: 'US',
    test: (bundle, urls) => {
      const core = [...urls].filter(u => u.startsWith(US_CORE_EXTENSIONS)).sort();
      if (core.length === 0) {
        return null;
      }
      const named = core.slice(0, MAX_NAMED).map(u => u.substring(US_CORE_EXTENSIONS.length)).join(', ');
      return `US Core extension${core.length === 1 ? ' is' : 's are'} used (${named}${core.length > MAX_NAMED ? ` and ${core.length - MAX_NAMED} more` : ''})`;
    }
  },
  { jurisdiction: 'AU', test: profileRule('AU', 'http://hl7.org.au/fhir/ps/StructureDefinition/au-ps-bundle', 'AU Patient Summary') }
];

/**
 * Which nation a document is from.
 * @param {Object} bundle
 * @returns {{jurisdiction: string|null, reasons: Array<{jurisdiction: string, text: string}>}}
 */
function determineNationality(bundle) {
  const urls = extensionUrls(bundle);
  const reasons = [];
  for (const rule of RULES) {
    const text = rule.test(bundle, urls);
    if (text) {
      reasons.push({ jurisdiction: rule.jurisdiction, text });
    }
  }
  const nations = [...new Set(reasons.map(r => r.jurisdiction))];
  return { jurisdiction: nations.length === 1 ? nations[0] : null, reasons };
}

/** What the result says, in a sentence. */
function nationalityText(result) {
  if (!result) {
    return null;
  }
  const reasons = Array.isArray(result.reasons) ? result.reasons : [];
  if (result.jurisdiction) {
    return `From ${result.jurisdiction}: ${reasons.map(r => r.text).join('; ')}`;
  }
  if (reasons.length > 0) {
    const nations = [...new Set(reasons.map(r => r.jurisdiction))];
    return `Nationality unknown: the document has signs of more than one nation (${nations.map(n => `${n}: ${reasons.filter(r => r.jurisdiction === n).map(r => r.text).join('; ')}`).join(' - ')})`;
  }
  return 'Nationality unknown: nothing in the document says which nation it is from (only US and Australian documents can be recognised so far)';
}

const nationalityStep = {
  name: 'nationality',
  async run(row, project, module) {
    const started = Date.now();
    const result = determineNationality(row.bundle);
    module.store.saveResult(row.id, 'nationality', { ms: Date.now() - started, ...result });
    module.store.setNationality(row.id, result.jurisdiction);
    return `nationality: ${result.jurisdiction || 'unknown'}`;
  }
};

module.exports = { determineNationality, nationalityText, nationalityStep, RULES };
