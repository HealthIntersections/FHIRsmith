/**
 * The language of a SNOMED CT description is stored in the cache as one byte. This is the
 * one table of what each byte means, for the importer (which writes them), the server
 * (which reads them) and the expression services.
 *
 * Bytes 1-9 are the languages earlier importers knew - FHIRsmith's before cache format 20,
 * and the original (Pascal) server's - and they keep their meanings. The rest of ISO 639-1,
 * the codes RF2 description files use, follows from 10 in alphabetical order. Never reorder
 * or remove an entry: caches on disk hold these numbers. A code ISO adds later goes on the
 * end.
 *
 * Before format 20 an importer recorded any other language as 1 (English): in those caches
 * Norwegian, Finnish, Estonian, Korean... descriptions are labelled English.
 */

const FIRST = ['en', 'fr', 'nl', 'es', 'sv', 'da', 'de', 'it', 'cs'];

const ISO_639_1 = [
  'aa', 'ab', 'ae', 'af', 'ak', 'am', 'an', 'ar', 'as', 'av', 'ay', 'az',
  'ba', 'be', 'bg', 'bh', 'bi', 'bm', 'bn', 'bo', 'br', 'bs',
  'ca', 'ce', 'ch', 'co', 'cr', 'cs', 'cu', 'cv', 'cy',
  'da', 'de', 'dv', 'dz',
  'ee', 'el', 'en', 'eo', 'es', 'et', 'eu',
  'fa', 'ff', 'fi', 'fj', 'fo', 'fr', 'fy',
  'ga', 'gd', 'gl', 'gn', 'gu', 'gv',
  'ha', 'he', 'hi', 'ho', 'hr', 'ht', 'hu', 'hy', 'hz',
  'ia', 'id', 'ie', 'ig', 'ii', 'ik', 'io', 'is', 'it', 'iu',
  'ja', 'jv',
  'ka', 'kg', 'ki', 'kj', 'kk', 'kl', 'km', 'kn', 'ko', 'kr', 'ks', 'ku', 'kv', 'kw', 'ky',
  'la', 'lb', 'lg', 'li', 'ln', 'lo', 'lt', 'lu', 'lv',
  'mg', 'mh', 'mi', 'mk', 'ml', 'mn', 'mr', 'ms', 'mt', 'my',
  'na', 'nb', 'nd', 'ne', 'ng', 'nl', 'nn', 'no', 'nr', 'nv', 'ny',
  'oc', 'oj', 'om', 'or', 'os',
  'pa', 'pi', 'pl', 'ps', 'pt',
  'qu',
  'rm', 'rn', 'ro', 'ru', 'rw',
  'sa', 'sc', 'sd', 'se', 'sg', 'si', 'sk', 'sl', 'sm', 'sn', 'so', 'sq', 'sr', 'ss', 'st', 'su', 'sv', 'sw',
  'ta', 'te', 'tg', 'th', 'ti', 'tk', 'tl', 'tn', 'to', 'tr', 'ts', 'tt', 'tw', 'ty',
  'ug', 'uk', 'ur', 'uz',
  've', 'vi', 'vo',
  'wa', 'wo',
  'xh',
  'yi', 'yo',
  'za', 'zh', 'zu'
];

/** language byte -> ISO 639-1 code */
const LANGUAGE_CODES = {};
/** ISO 639-1 code -> language byte */
const LANGUAGE_BYTES = {};

[...FIRST, ...ISO_639_1.filter(c => !FIRST.includes(c))].forEach((code, i) => {
  LANGUAGE_CODES[i + 1] = code;
  LANGUAGE_BYTES[code] = i + 1;
});

/**
 * The byte for a language code - an RF2 languageCode ("en", "no"), or a BCP 47 tag, whose
 * region and the rest are ignored ("en-US", "de-CH")
 * @param {string} code
 * @returns {number|null} null if the language is not an ISO 639-1 code
 */
function languageByte(code) {
  const lang = String(code || '').split('-')[0].toLowerCase();
  return LANGUAGE_BYTES[lang] || null;
}

/**
 * @param {number} byte
 * @returns {string|null} the ISO 639-1 code, or null if the byte is not a language
 */
function languageCode(byte) {
  return LANGUAGE_CODES[byte] || null;
}

// Norwegian: RF2 uses "no"; a request may name either written form
const ALSO = { nb: 'no', nn: 'no', no: 'nb' };

/**
 * Bytes to try, in order, for a language a request names: the language itself, and
 * for Norwegian the other code it may be stored under
 * @param {string} code
 * @returns {number[]}
 */
function languageBytesFor(code) {
  const lang = String(code || '').split('-')[0].toLowerCase();
  const result = [];
  if (LANGUAGE_BYTES[lang]) {
    result.push(LANGUAGE_BYTES[lang]);
  }
  if (ALSO[lang] && LANGUAGE_BYTES[ALSO[lang]]) {
    result.push(LANGUAGE_BYTES[ALSO[lang]]);
  }
  return result;
}

module.exports = { LANGUAGE_CODES, LANGUAGE_BYTES, languageByte, languageCode, languageBytesFor };
