//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

/**
 * Jurisdictions, as http://hl7.org/fhir/ValueSet/jurisdiction has them: a country, by its
 * ISO 3166-1 two-letter code (urn:iso:std:iso:3166), or a region, by its UN M49 three-digit
 * code (http://unstats.un.org/unsd/methods/m49/m49.htm). The codes and names are the ones
 * the terminology module's providers hold (tx/cs/cs-country.js, tx/cs/cs-areacode.js).
 *
 * @module ips/jurisdictions
 */

const { CountryCodeFactoryProvider } = require('../tx/cs/cs-country');
const { AreaCodeFactoryProvider } = require('../tx/cs/cs-areacode');

const ISO_3166 = 'urn:iso:std:iso:3166';
const M49 = 'http://unstats.un.org/unsd/methods/m49/m49.htm';
// in the country list, but not countries
const UNKNOWN = new Set(['XX', 'ZZ']);

let tables = null;

/**
 * The providers' code lists, read once. Only their data is wanted, not code system
 * providers, so their load() runs on an object with no i18n (it only fills codes/codeMap).
 */
function load() {
  if (!tables) {
    const countries = Object.create(CountryCodeFactoryProvider.prototype);
    const areas = Object.create(AreaCodeFactoryProvider.prototype);
    // load() is async in form, but does its work synchronously
    countries.load();
    areas.load();
    tables = { countries: countries.codeMap, areas: areas.codeMap };
  }
  return tables;
}

/**
 * A jurisdiction by its code: two upper case letters (a country), or three digits (a
 * region - an M49 region, not a country's numeric code).
 * @param {string} code
 * @returns {{system: string, code: string, display: string}|null} null if it is neither
 */
function jurisdiction(code) {
  if (typeof code !== 'string') {
    return null;
  }
  const t = load();
  if (/^[A-Z]{2}$/.test(code)) {
    const c = t.countries.get(code);
    // not the user-assigned codes (XK, QM-QZ...), nor the 'unknown' ones (XX, ZZ): they aren't countries ISO 3166 names
    return c && !c.userDefined && !UNKNOWN.has(code) ? { system: ISO_3166, code, display: c.display } : null;
  }
  if (/^\d{3}$/.test(code)) {
    const a = t.areas.get(code);
    return a && a.class_ === 'region' ? { system: M49, code, display: a.display } : null;
  }
  return null;
}

module.exports = { jurisdiction, ISO_3166, M49 };
