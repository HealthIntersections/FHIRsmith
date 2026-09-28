/**
 * The SNOMED CT editions FHIRsmith knows by name - the one table, used for the provider's
 * description and name (cs-snomed.js) and for the edition named in unknown-code messages
 * (SCTVersion in workers/worker.js). Keyed by the edition's module id, as it appears in a
 * version URI: http://snomed.info/sct/[module]/version/[date]
 *
 * name - human readable edition name
 * code - short code used in the provider name ("SCT US")
 *
 * (The importer and the registry keep their own tables: those carry import settings and
 * registry codes, not display names.)
 */
const EDITIONS = {
  '900000000000207008': { name: 'International Edition', code: 'Intl' },
  // The terminology-ecosystem test distribution, published under xsct - see the
  // tx-ecosystem IG, which requires a server claiming the snomed mode to load it.
  '31000003106': { name: 'Test Edition', code: 'Test' },
  '449081005': { name: 'International Spanish Edition', code: 'es' },
  '11000221109': { name: 'Argentinian Edition', code: 'AR-es' },
  '32506021000036107': { name: 'Australian Edition (with drug extension)', code: 'AU+' },
  '11000234105': { name: 'Austrian Edition', code: 'AT' },
  '11000172109': { name: 'Belgian Edition', code: 'BE' },
  '20621000087109': { name: 'Canadian English Edition', code: 'CA-en' },
  '20611000087101': { name: 'Canadian Canadian French Edition', code: 'CA-fr' },
  '554471000005108': { name: 'Danish Edition', code: 'DK' },
  '11000279109': { name: 'Czech Edition', code: 'CZ' },
  '11000181102': { name: 'Estonian Edition', code: 'ET' },
  '11000229106': { name: 'Finnish Edition', code: 'FI' },
  '11000274103': { name: 'German Edition', code: 'DE' },
  '1121000189102': { name: 'Indian Edition', code: 'IN' },
  '827022005': { name: 'IPS Terminology', code: 'IPS' },
  '11000220105': { name: 'Irish Edition', code: 'IE' },
  '11000146104': { name: 'Netherlands Edition', code: 'NL' },
  '21000210109': { name: 'New Zealand Edition', code: 'NZ' },
  '51000202101': { name: 'Norwegian Edition', code: 'NO' },
  '11000267109': { name: 'Republic of Korea Edition (South Korea)', code: 'KR' },
  '900000001000122104': { name: 'Spanish National Edition', code: 'ES-es' },
  '45991000052106': { name: 'Swedish Edition', code: 'SE' },
  '2011000195101': { name: 'Swiss Edition', code: 'CH' },
  '83821000000107': { name: 'UK Edition', code: 'UK' },
  '999000021000000109': { name: 'UK Clinical Edition', code: 'UK-Clinical' },
  '5631000179106': { name: 'Uruguay Edition', code: 'UY' },
  '731000124108': { name: 'US Edition', code: 'US' },
  '21000325107': { name: 'Chilean Edition', code: 'CL' },
  '5991000124107': { name: 'US Edition (with ICD-10-CM maps)', code: 'US+' }
};

/**
 * @param {string} edition - edition module id
 * @returns {string|null} the edition's name, or null if it isn't a known edition
 */
function editionName(edition) {
  const e = EDITIONS[edition];
  return e ? e.name : null;
}

/**
 * @param {string} edition - edition module id
 * @returns {string|null} the edition's short code, or null if it isn't a known edition
 */
function editionCode(edition) {
  const e = EDITIONS[edition];
  return e ? e.code : null;
}

module.exports = {
  EDITIONS,
  editionName,
  editionCode
};
