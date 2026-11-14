const { CodeSystemProvider, FilterExecutionContext } = require('../../tx/cs/cs-api');
const assert = require('assert');
const { CodeSystem } = require("../library/codesystem");
const {CodeSystemFactoryProvider} = require("./cs-api");
const regexUtilities = require("../../library/regex-utilities");
const { Issue } = require('../library/operation-outcome');

class CountryCodeConcept {
  constructor(userDefined, code, display, french) {
    this.userDefined = userDefined;
    this.code = code;
    this.display = display;
    this.french = french;
  }
}

class CountryCodeConceptFilter {
  constructor() {
    this.list = [];
    this.cursor = -1;
  }
}

class CountryCodeServices extends CodeSystemProvider {
  constructor(opContext, supplements, codes, codeMap) {
    super(opContext, supplements);
    this.codes = codes || [];
    this.codeMap = codeMap || new Map();
  }

  // Metadata methods
  system() {
    return 'urn:iso:std:iso:3166';
  }

  version() {
    return '2018';
  }

  description() {
    return 'ISO Country Codes';
  }

  name() {
    return 'Country Codes';
  }

  totalCount() {
    return this.codes.length;
  }

  hasParents() {
    return false; // No hierarchical relationships
  }

  hasAnyDisplays(languages) {
    const langs = this._ensureLanguages(languages);
    if (this._hasAnySupplementDisplays(langs)) {
      return true;
    }
    return super.hasAnyDisplays(langs);
  }

  // Core concept methods
  async code(code) {
    
    const ctxt = await this.#ensureContext(code);
    return ctxt ? ctxt.code : null;
  }

  async display(code) {
    
    const ctxt = await this.#ensureContext(code);
    if (!ctxt) {
      return null;
    }
    // a user-assigned code's display is a placeholder ('User-assigned'): an extension-codes
    // supplement's display for it comes first
    if (ctxt.userDefined) {
      const ext = this._extensionCodeDisplay(ctxt.code);
      if (ext) {
        return ext;
      }
    }
    if (ctxt.display && this.opContext.langs.isEnglishOrNothing()) {
      return ctxt.display;
    }
    let disp = this._displayFromSupplements(ctxt.code);
    if (disp) {
      return disp;
    }
    if (ctxt.french && this.opContext.langs.includesLanguage('fr')) {
      return ctxt.french;
    }
    return ctxt.display;
  }

  async definition(code) {
    
    await this.#ensureContext(code);
    return null; // No definitions provided
  }

  async isAbstract(code) {
    
    await this.#ensureContext(code);
    return false; // No abstract concepts
  }

  async isInactive(code) {
    
    await this.#ensureContext(code);
    return false; // No inactive concepts
  }

  async isDeprecated(code) {
    
    await this.#ensureContext(code);
    return false; // No deprecated concepts
  }


  async designations(code, displays) {
    
    const ctxt = await this.#ensureContext(code);
    if (ctxt != null) {
      displays.userDefined = ctxt.userDefined;
      // when an extension-codes supplement gives a user-assigned code a display, the placeholder
      // ('User-assigned') isn't one of its displays
      if (!(ctxt.userDefined && this._extensionCodeDisplay(ctxt.code))) {
        displays.addDesignation( true, 'active', 'en', CodeSystem.makeUseForDisplay(), ctxt.display);
      }
      if (ctxt.french) {
        displays.addDesignation(true, 'active', 'fr', CodeSystem.makeUseForDisplay(), ctxt.french);
      }
      this._listSupplementDesignations(ctxt.code, displays, ctxt.userDefined);
    }
  }

  async #ensureContext(code) {
    if (!code) {
      return code;
    }
    if (typeof code === 'string') {
      const ctxt = await this.locate(code);
      if (!ctxt.context) {
        throw new Error(ctxt.message);
      } else {
        return ctxt.context;
      }
    }
    if (code instanceof CountryCodeConcept) {
      return code;
    }
    throw new Error("Unknown Type at #ensureContext: "+ (typeof code));
  }

  // Lookup methods
  async locate(code) {
    
    assert(!code || typeof code === 'string', 'code must be string');
    if (!code) return { context: null, message: 'Empty code' };

    const concept = this.codeMap.get(code);
    if (concept) {
      return { context: concept, message: null };
    }
    return { context: null, message: undefined};
  }

  // Iterator methods
  async iterator(code) {
    
    const ctxt = await this.#ensureContext(code);
    if (!ctxt) {
      return { index: 0, total: this.totalCount() };
    }
    return null; // No child iteration
  }

  async nextContext(iteratorContext) {
    
    assert(iteratorContext, 'iteratorContext must be provided');
    if (iteratorContext && iteratorContext.index < iteratorContext.total) {
      const concept = this.codes[iteratorContext.index];
      iteratorContext.index++;
      return concept;
    }
    return null;
  }

  // Filtering methods
  async doesFilter(prop, op, value) {
    assert(prop != null && typeof prop === 'string', 'prop must be a non-null string');
    assert(op != null && typeof op === 'string', 'op must be a non-null string');
    assert(value != null && typeof value === 'string', 'value must be a non-null string');


    
    return prop === 'code' && op === 'regex';
  }


  async filter(filterContext, forIteration, prop, op, value) {
    
    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    assert(prop != null && typeof prop === 'string', 'prop must be a non-null string');
    assert(op != null && typeof op === 'string', 'op must be a non-null string');
    assert(value != null && typeof value === 'string', 'value must be a non-null string');

    if (prop === 'code' && op === 'regex') {
      const result = new CountryCodeConceptFilter();

      try {
        // anchored to the whole code
        const regex = regexUtilities.compile('^(?:' + value + ')$'); // the whole value: a|b is ^(?:a|b)$, not ^a|b$

        for (const concept of this.codes) {
          if (regex.test(concept.code)) {
            result.list.push(concept);
          }
        }

        filterContext.filters.push(result);
      } catch (error) {
        throw new Error(`Invalid regex pattern: ${value}`);
      }
    } else {
      throw new Issue('error', 'not-supported', null, 'FILTER_NOT_UNDERSTOOD',
        this.opContext.i18n.translate('FILTER_NOT_UNDERSTOOD', this.opContext.langs, [prop, op, value]), 'vs-invalid', 422);
    }
  }

  async executeFilters(filterContext) {
    
    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    return filterContext.filters;
  }

  async filterSize(filterContext, set) {
    
    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    assert(set && set instanceof CountryCodeConceptFilter, 'set must be a CountryCodeConceptFilter');
    return set.list.length;
  }

  async filtersNotClosed(filterContext) {
    
    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    return false; // Finite set
  }

  async filterMore(filterContext, set) {
    
    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    assert(set && set instanceof CountryCodeConceptFilter, 'set must be a CountryCodeConceptFilter');
    set.cursor++;
    return set.cursor < set.list.length;
  }

  async filterConcept(filterContext, set) {
    
    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    assert(set && set instanceof CountryCodeConceptFilter, 'set must be a CountryCodeConceptFilter');
    if (set.cursor >= 0 && set.cursor < set.list.length) {
      return set.list[set.cursor];
    }
    return null;
  }

  async filterLocate(filterContext, set, code) {
    
    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    assert(set && set instanceof CountryCodeConceptFilter, 'set must be a CountryCodeConceptFilter');
    assert(typeof code === 'string', 'code must be non-null string');

    // For country codes, we can just use the main lookup since the filter
    // doesn't change which codes are available, just which ones match
    const concept = this.codeMap.get(code);
    if (concept && set.list.includes(concept)) {
      return concept;
    }
    return null;
  }

  async filterCheck(filterContext, set, concept) {
    
    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    assert(set && set instanceof CountryCodeConceptFilter, 'set must be a CountryCodeConceptFilter');
    const ctxt = await this.#ensureContext(concept);
    return set.list.includes(ctxt);
  }

  // Subsumption
  async subsumesTest(codeA, codeB) {
    await this.#ensureContext(codeA);
    await this.#ensureContext(codeB);
    return 'not-subsumed'; // No subsumption relationships
  }

  versionAlgorithm() {
    return 'date';
  }
}

class CountryCodeFactoryProvider extends CodeSystemFactoryProvider {
  constructor(i18n) {
    super(i18n);
    this.uses = 0;
  }

  defaultVersion() {
    return '2018';
  }

  // Metadata methods
  system() {
    return 'urn:iso:std:iso:3166';
  }

  version() {
    return '2018';
  }

  build(opContext, supplements) {
    this.uses++;
    return new CountryCodeServices(opContext, supplements, this.codes, this.codeMap);
  }

  useCount() {
    return this.uses;
  }

  recordUse() {
    this.uses++;
  }

  // Load the hardcoded country code data
  async load() {
    this.codes = [];
    this.codeMap = new Map();

    const data = [
      // ISO 3166-1 alpha-2 codes
      [false, 'AD', 'Andorra', 'Andorre (l\')'],
      [false, 'AE', 'United Arab Emirates', 'Émirats arabes unis (les)'],
      [false, 'AF', 'Afghanistan', 'Afghanistan (l\')'],
      [false, 'AG', 'Antigua and Barbuda', 'Antigua-et-Barbuda'],
      [false, 'AI', 'Anguilla', 'Anguilla'],
      [false, 'AL', 'Albania', 'Albanie (l\')'],
      [false, 'AM', 'Armenia', 'Arménie (l\')'],
      [false, 'AO', 'Angola', 'Angola (l\')'],
      [false, 'AQ', 'Antarctica', 'Antarctique (l\')'],
      [false, 'AR', 'Argentina', 'Argentine (l\')'],
      [false, 'AS', 'American Samoa', 'Samoa américaines (les)'],
      [false, 'AT', 'Austria', 'Autriche (l\')'],
      [false, 'AU', 'Australia', 'Australie (l\')'],
      [false, 'AW', 'Aruba', 'Aruba'],
      [false, 'AX', 'Åland Islands', 'Åland(les Îles)'],
      [false, 'AZ', 'Azerbaijan', 'Azerbaïdjan (l\')'],
      [false, 'BA', 'Bosnia and Herzegovina', 'Bosnie-Herzégovine (la)'],
      [false, 'BB', 'Barbados', 'Barbade (la)'],
      [false, 'BD', 'Bangladesh', 'Bangladesh (le)'],
      [false, 'BE', 'Belgium', 'Belgique (la)'],
      [false, 'BF', 'Burkina Faso', 'Burkina Faso (le)'],
      [false, 'BG', 'Bulgaria', 'Bulgarie (la)'],
      [false, 'BH', 'Bahrain', 'Bahreïn'],
      [false, 'BI', 'Burundi', 'Burundi (le)'],
      [false, 'BJ', 'Benin', 'Bénin (le)'],
      [false, 'BL', 'Saint Barthélemy', 'Saint-Barthélemy'],
      [false, 'BM', 'Bermuda', 'Bermudes (les)'],
      [false, 'BN', 'Brunei Darussalam', 'Brunéi Darussalam (le)'],
      [false, 'BO', 'Bolivia, Plurinational State of', 'Bolivie (État plurinational de)'],
      [false, 'BQ', 'Bonaire, Sint Eustatius and Saba', 'Bonaire, Saint-Eustache et Saba'],
      [false, 'BR', 'Brazil', 'Brésil (le)'],
      [false, 'BS', 'Bahamas', 'Bahamas (les)'],
      [false, 'BT', 'Bhutan', 'Bhoutan (le)'],
      [false, 'BV', 'Bouvet Island', 'Bouvet (l\'Île)'],
      [false, 'BW', 'Botswana', 'Botswana (le)'],
      [false, 'BY', 'Belarus', 'Bélarus (le)'],
      [false, 'BZ', 'Belize', 'Belize (le)'],
      [false, 'CA', 'Canada', 'Canada (le)'],
      [false, 'CC', 'Cocos (Keeling) Islands', 'Cocos (les Îles)/ Keeling (les Îles)'],
      [false, 'CD', 'Congo, the Democratic Republic of the', 'Congo (la République démocratique du)'],
      [false, 'CF', 'Central African Republic', 'République centrafricaine (la)'],
      [false, 'CG', 'Congo', 'Congo (le)'],
      [false, 'CH', 'Switzerland', 'Suisse (la)'],
      [false, 'CI', 'Côte d\'Ivoire', 'Côte d\'Ivoire (la)'],
      [false, 'CK', 'Cook Islands', 'Cook (les Îles)'],
      [false, 'CL', 'Chile', 'Chili (le)'],
      [false, 'CM', 'Cameroon', 'Cameroun (le)'],
      [false, 'CN', 'China', 'Chine (la)'],
      [false, 'CO', 'Colombia', 'Colombie (la)'],
      [false, 'CR', 'Costa Rica', 'Costa Rica (le)'],
      [false, 'CU', 'Cuba', 'Cuba'],
      [false, 'CV', 'Cabo Verde', 'Cabo Verde'],
      [false, 'CW', 'Curaçao', 'Curaçao'],
      [false, 'CX', 'Christmas Island', 'Christmas (l\'Île)'],
      [false, 'CY', 'Cyprus', 'Chypre'],
      [false, 'CZ', 'Czechia', 'Tchéquie (la)'],
      [false, 'DE', 'Germany', 'Allemagne (l\')'],
      [false, 'DJ', 'Djibouti', 'Djibouti'],
      [false, 'DK', 'Denmark', 'Danemark (le)'],
      [false, 'DM', 'Dominica', 'Dominique (la)'],
      [false, 'DO', 'Dominican Republic', 'dominicaine (la République)'],
      [false, 'DZ', 'Algeria', 'Algérie (l\')'],
      [false, 'EC', 'Ecuador', 'Équateur (l\')'],
      [false, 'EE', 'Estonia', 'Estonie (l\')'],
      [false, 'EG', 'Egypt', 'Égypte (l\')'],
      [false, 'EH', 'Western Sahara', 'Sahara occidental (le)*'],
      [false, 'ER', 'Eritrea', 'Érythrée (l\')'],
      [false, 'ES', 'Spain', 'Espagne (l\')'],
      [false, 'ET', 'Ethiopia', 'Éthiopie (l\')'],
      [false, 'FI', 'Finland', 'Finlande (la)'],
      [false, 'FJ', 'Fiji', 'Fidji (les)'],
      [false, 'FK', 'Falkland Islands (Malvinas)', 'Falkland (les Îles)/Malouines (les Îles)'],
      [false, 'FM', 'Micronesia, Federated States of', 'Micronésie (États fédérés de)'],
      [false, 'FO', 'Faroe Islands', 'Féroé (les Îles)'],
      [false, 'FR', 'France', 'France (la)'],
      [false, 'GA', 'Gabon', 'Gabon (le)'],
      [false, 'GB', 'United Kingdom of Great Britain and Northern Ireland', 'Royaume-Uni de Grande-Bretagne et d\'Irlande du Nord (le)'],
      [false, 'GD', 'Grenada', 'Grenade (la)'],
      [false, 'GE', 'Georgia', 'Géorgie (la)'],
      [false, 'GF', 'French Guiana', 'Guyane française (la )'],
      [false, 'GG', 'Guernsey', 'Guernesey'],
      [false, 'GH', 'Ghana', 'Ghana (le)'],
      [false, 'GI', 'Gibraltar', 'Gibraltar'],
      [false, 'GL', 'Greenland', 'Groenland (le)'],
      [false, 'GM', 'Gambia', 'Gambie (la)'],
      [false, 'GN', 'Guinea', 'Guinée (la)'],
      [false, 'GP', 'Guadeloupe', 'Guadeloupe (la)'],
      [false, 'GQ', 'Equatorial Guinea', 'Guinée équatoriale (la)'],
      [false, 'GR', 'Greece', 'Grèce (la)'],
      [false, 'GS', 'South Georgia and the South Sandwich Islands', 'Géorgie du Sud-et-les Îles Sandwich du Sud (la)'],
      [false, 'GT', 'Guatemala', 'Guatemala (le)'],
      [false, 'GU', 'Guam', 'Guam'],
      [false, 'GW', 'Guinea-Bissau', 'Guinée-Bissau (la)'],
      [false, 'GY', 'Guyana', 'Guyana (le)'],
      [false, 'HK', 'Hong Kong', 'Hong Kong'],
      [false, 'HM', 'Heard Island and McDonald Islands', 'Heard-et-Îles MacDonald (l\'Île)'],
      [false, 'HN', 'Honduras', 'Honduras (le)'],
      [false, 'HR', 'Croatia', 'Croatie (la)'],
      [false, 'HT', 'Haiti', 'Haïti'],
      [false, 'HU', 'Hungary', 'Hongrie (la)'],
      [false, 'ID', 'Indonesia', 'Indonésie (l\')'],
      [false, 'IE', 'Ireland', 'Irlande (l\')'],
      [false, 'IL', 'Israel', 'Israël'],
      [false, 'IM', 'Isle of Man', 'Île de Man'],
      [false, 'IN', 'India', 'Inde (l\')'],
      [false, 'IO', 'British Indian Ocean Territory', 'Indien (le Territoire britannique de l\'océan)'],
      [false, 'IQ', 'Iraq', 'Iraq (l\')'],
      [false, 'IR', 'Iran, Islamic Republic of', 'Iran (République Islamique d\')'],
      [false, 'IS', 'Iceland', 'Islande (l\')'],
      [false, 'IT', 'Italy', 'Italie (l\')'],
      [false, 'JE', 'Jersey', 'Jersey'],
      [false, 'JM', 'Jamaica', 'Jamaïque (la)'],
      [false, 'JO', 'Jordan', 'Jordanie (la)'],
      [false, 'JP', 'Japan', 'Japon (le)'],
      [false, 'KE', 'Kenya', 'Kenya (le)'],
      [false, 'KG', 'Kyrgyzstan', 'Kirghizistan (le)'],
      [false, 'KH', 'Cambodia', 'Cambodge (le)'],
      [false, 'KI', 'Kiribati', 'Kiribati'],
      [false, 'KM', 'Comoros', 'Comores (les)'],
      [false, 'KN', 'Saint Kitts and Nevis', 'Saint-Kitts-et-Nevis'],
      [false, 'KP', 'Korea, Democratic People\'s Republic of', 'Corée (la République populaire démocratique de)'],
      [false, 'KR', 'Korea, Republic of', 'Corée (la République de)'],
      [false, 'KW', 'Kuwait', 'Koweït (le)'],
      [false, 'KY', 'Cayman Islands', 'Caïmans (les Îles)'],
      [false, 'KZ', 'Kazakhstan', 'Kazakhstan (le)'],
      [false, 'LA', 'Lao People\'s Democratic Republic', 'Lao (la République démocratique populaire)'],
      [false, 'LB', 'Lebanon', 'Liban (le)'],
      [false, 'LC', 'Saint Lucia', 'Sainte-Lucie'],
      [false, 'LI', 'Liechtenstein', 'Liechtenstein (le)'],
      [false, 'LK', 'Sri Lanka', 'Sri Lanka'],
      [false, 'LR', 'Liberia', 'Libéria (le)'],
      [false, 'LS', 'Lesotho', 'Lesotho (le)'],
      [false, 'LT', 'Lithuania', 'Lituanie (la)'],
      [false, 'LU', 'Luxembourg', 'Luxembourg (le)'],
      [false, 'LV', 'Latvia', 'Lettonie (la)'],
      [false, 'LY', 'Libya', 'Libye (la)'],
      [false, 'MA', 'Morocco', 'Maroc (le)'],
      [false, 'MC', 'Monaco', 'Monaco'],
      [false, 'MD', 'Moldova, Republic of', 'Moldova (la République de)'],
      [false, 'ME', 'Montenegro', 'Monténégro (le)'],
      [false, 'MF', 'Saint Martin (French part)', 'Saint-Martin (partie française)'],
      [false, 'MG', 'Madagascar', 'Madagascar'],
      [false, 'MH', 'Marshall Islands', 'Marshall (les Îles)'],
      [false, 'MK', 'Macedonia, the former Yugoslav Republic of', 'Macédoine du Nord (la)'],
      [false, 'ML', 'Mali', 'Mali (le)'],
      [false, 'MM', 'Myanmar', 'Myanmar (le)'],
      [false, 'MN', 'Mongolia', 'Mongolie (la)'],
      [false, 'MO', 'Macao', 'Macao'],
      [false, 'MP', 'Northern Mariana Islands', 'Mariannes du Nord (les Îles)'],
      [false, 'MQ', 'Martinique', 'Martinique (la)'],
      [false, 'MR', 'Mauritania', 'Mauritanie (la)'],
      [false, 'MS', 'Montserrat', 'Montserrat'],
      [false, 'MT', 'Malta', 'Malte'],
      [false, 'MU', 'Mauritius', 'Maurice'],
      [false, 'MV', 'Maldives', 'Maldives (les)'],
      [false, 'MW', 'Malawi', 'Malawi (le)'],
      [false, 'MX', 'Mexico', 'Mexique (le)'],
      [false, 'MY', 'Malaysia', 'Malaisie (la)'],
      [false, 'MZ', 'Mozambique', 'Mozambique (le)'],
      [false, 'NA', 'Namibia', 'Namibie (la)'],
      [false, 'NC', 'New Caledonia', 'Nouvelle-Calédonie (la)'],
      [false, 'NE', 'Niger', 'Niger (le)'],
      [false, 'NF', 'Norfolk Island', 'Norfolk (l\'Île)'],
      [false, 'NG', 'Nigeria', 'Nigéria (le)'],
      [false, 'NI', 'Nicaragua', 'Nicaragua (le)'],
      [false, 'NL', 'Netherlands', 'Pays-Bas (les)'],
      [false, 'NO', 'Norway', 'Norvège (la)'],
      [false, 'NP', 'Nepal', 'Népal (le)'],
      [false, 'NR', 'Nauru', 'Nauru'],
      [false, 'NU', 'Niue', 'Niue'],
      [false, 'NZ', 'New Zealand', 'Nouvelle-Zélande (la)'],
      [false, 'OM', 'Oman', 'Oman'],
      [false, 'PA', 'Panama', 'Panama (le)'],
      [false, 'PE', 'Peru', 'Pérou (le)'],
      [false, 'PF', 'French Polynesia', 'Polynésie française (la)'],
      [false, 'PG', 'Papua New Guinea', 'Papouasie-Nouvelle-Guinée (la)'],
      [false, 'PH', 'Philippines', 'Philippines (les)'],
      [false, 'PK', 'Pakistan', 'Pakistan (le)'],
      [false, 'PL', 'Poland', 'Pologne (la)'],
      [false, 'PM', 'Saint Pierre and Miquelon', 'Saint-Pierre-et-Miquelon'],
      [false, 'PN', 'Pitcairn', 'Pitcairn'],
      [false, 'PR', 'Puerto Rico', 'Porto Rico'],
      [false, 'PS', 'Palestine, State of', 'Palestine, État de'],
      [false, 'PT', 'Portugal', 'Portugal (le)'],
      [false, 'PW', 'Palau', 'Palaos (les)'],
      [false, 'PY', 'Paraguay', 'Paraguay (le)'],
      [false, 'QA', 'Qatar', 'Qatar (le)'],
      [false, 'RE', 'Réunion', 'Réunion (La)'],
      [false, 'RO', 'Romania', 'Roumanie (la)'],
      [false, 'RS', 'Serbia', 'Serbie (la)'],
      [false, 'RU', 'Russian Federation', 'Russie (la Fédération de)'],
      [false, 'RW', 'Rwanda', 'Rwanda (le)'],
      [false, 'SA', 'Saudi Arabia', 'Arabie saoudite (l\')'],
      [false, 'SB', 'Solomon Islands', 'Salomon (les Îles)'],
      [false, 'SC', 'Seychelles', 'Seychelles (les)'],
      [false, 'SD', 'Sudan', 'Soudan (le)'],
      [false, 'SE', 'Sweden', 'Suède (la)'],
      [false, 'SG', 'Singapore', 'Singapour'],
      [false, 'SH', 'Saint Helena, Ascension and Tristan da Cunha', 'Sainte-Hélène, Ascension et Tristan da Cunha'],
      [false, 'SI', 'Slovenia', 'Slovénie (la)'],
      [false, 'SJ', 'Svalbard and Jan Mayen', 'Svalbard et l\'Île Jan Mayen (le)'],
      [false, 'SK', 'Slovakia', 'Slovaquie (la)'],
      [false, 'SL', 'Sierra Leone', 'Sierra Leone (la)'],
      [false, 'SM', 'San Marino', 'Saint-Marin'],
      [false, 'SN', 'Senegal', 'Sénégal (le)'],
      [false, 'SO', 'Somalia', 'Somalie (la)'],
      [false, 'SR', 'Suriname', 'Suriname (le)'],
      [false, 'SS', 'South Sudan', 'Soudan du Sud (le)'],
      [false, 'ST', 'Sao Tome and Principe', 'Sao Tomé-et-Principe'],
      [false, 'SV', 'El Salvador', 'El Salvador'],
      [false, 'SX', 'Sint Maarten (Dutch part)', 'Saint-Martin (partie néerlandaise)'],
      [false, 'SY', 'Syrian Arab Republic', 'République arabe syrienne (la)'],
      [false, 'SZ', 'Swaziland', 'Eswatini (l\')'],
      [false, 'TC', 'Turks and Caicos Islands', 'Turks-et-Caïcos (les Îles)'],
      [false, 'TD', 'Chad', 'Tchad (le)'],
      [false, 'TF', 'French Southern Territories', 'Terres australes françaises (les)'],
      [false, 'TG', 'Togo', 'Togo (le)'],
      [false, 'TH', 'Thailand', 'Thaïlande (la)'],
      [false, 'TJ', 'Tajikistan', 'Tadjikistan (le)'],
      [false, 'TK', 'Tokelau', 'Tokelau (les)'],
      [false, 'TL', 'Timor-Leste', 'Timor-Leste (le)'],
      [false, 'TM', 'Turkmenistan', 'Turkménistan (le)'],
      [false, 'TN', 'Tunisia', 'Tunisie (la)'],
      [false, 'TO', 'Tonga', 'Tonga (les)'],
      [false, 'TR', 'Turkey', 'Turquie (la)'],
      [false, 'TT', 'Trinidad and Tobago', 'Trinité-et-Tobago (la)'],
      [false, 'TV', 'Tuvalu', 'Tuvalu (les)'],
      [false, 'TW', 'Taiwan, Province of China', 'Taïwan (Province de Chine)'],
      [false, 'TZ', 'Tanzania, United Republic of', 'Tanzanie (la République-Unie de)'],
      [false, 'UA', 'Ukraine', 'Ukraine (l\')'],
      [false, 'UG', 'Uganda', 'Ouganda (l\')'],
      [false, 'UM', 'United States Minor Outlying Islands', 'Îles mineures éloignées des États-Unis (les)'],
      [false, 'US', 'United States of America', 'États-Unis d\'Amérique (les)'],
      [false, 'UY', 'Uruguay', 'Uruguay (l\')'],
      [false, 'UZ', 'Uzbekistan', 'Ouzbékistan (l\')'],
      [false, 'VA', 'Holy See', 'Saint-Siège (le)'],
      [false, 'VC', 'Saint Vincent and the Grenadines', 'Saint-Vincent-et-les Grenadines'],
      [false, 'VE', 'Venezuela, Bolivarian Republic of', 'Venezuela (République bolivarienne du)'],
      [false, 'VG', 'Virgin Islands, British', 'Vierges britanniques (les Îles)'],
      [false, 'VI', 'Virgin Islands, U.S.', 'Vierges des États-Unis (les Îles)'],
      [false, 'VN', 'Viet Nam', 'Viet Nam (le)'],
      [false, 'VU', 'Vanuatu', 'Vanuatu (le)'],
      [false, 'WF', 'Wallis and Futuna', 'Wallis-et-Futuna'],
      [false, 'WS', 'Samoa', 'Samoa (le)'],
      [false, 'YE', 'Yemen', 'Yémen (le)'],
      [false, 'YT', 'Mayotte', 'Mayotte'],
      [false, 'ZA', 'South Africa', 'Afrique du Sud (l\')'],
      [false, 'ZM', 'Zambia', 'Zambie (la)'],
      [false, 'ZW', 'Zimbabwe', 'Zimbabwe (le)'],
      [true, 'AA', 'User-assigned'],
      [true, 'QM', 'User-assigned'],
      [true, 'QN', 'User-assigned'],
      [true, 'QO', 'User-assigned'],
      [true, 'QP', 'User-assigned'],
      [true, 'QQ', 'User-assigned'],
      [true, 'QR', 'User-assigned'],
      [true, 'QS', 'User-assigned'],
      [true, 'QT', 'User-assigned'],
      [true, 'QU', 'User-assigned'],
      [true, 'QV', 'User-assigned'],
      [true, 'QW', 'User-assigned'],
      [true, 'QX', 'User-assigned'],
      [true, 'QY', 'User-assigned'],
      [true, 'QZ', 'User-assigned'],
      [true, 'XA', 'User-assigned'],
      [true, 'XB', 'User-assigned'],
      [true, 'XC', 'User-assigned'],
      [true, 'XD', 'User-assigned'],
      [true, 'XE', 'User-assigned'],
      [true, 'XF', 'User-assigned'],
      [true, 'XG', 'User-assigned'],
      [true, 'XH', 'User-assigned'],
      [true, 'XI', 'User-assigned'],
      [true, 'XJ', 'User-assigned'],
      [true, 'XK', 'Kosovo'],
      [true, 'XL', 'User-assigned'],
      [true, 'XM', 'User-assigned'],
      [true, 'XN', 'User-assigned'],
      [true, 'XO', 'User-assigned'],
      [true, 'XP', 'User-assigned'],
      [true, 'XQ', 'User-assigned'],
      [true, 'XR', 'User-assigned'],
      [true, 'XS', 'User-assigned'],
      [true, 'XT', 'User-assigned'],
      [true, 'XU', 'User-assigned'],
      [true, 'XV', 'User-assigned'],
      [true, 'XW', 'User-assigned'],
      [false, 'XX', 'Unknown'],
      [true, 'XY', 'User-assigned'],
      [false, 'XZ', 'International Waters'],
      [false, 'ZZ', 'Unknown or Invalid Territory'],

      // ISO 3166-1 alpha-3 codes
      [false, 'ABW', 'Aruba', 'Aruba'],
      [false, 'AFG', 'Afghanistan', 'Afghanistan (l\')'],
      [false, 'AGO', 'Angola', 'Angola (l\')'],
      [false, 'AIA', 'Anguilla', 'Anguilla'],
      [false, 'ALA', 'Åland Islands', 'Åland(les Îles)'],
      [false, 'ALB', 'Albania', 'Albanie (l\')'],
      [false, 'AND', 'Andorra', 'Andorre (l\')'],
      [false, 'ARE', 'United Arab Emirates', 'Émirats arabes unis (les)'],
      [false, 'ARG', 'Argentina', 'Argentine (l\')'],
      [false, 'ARM', 'Armenia', 'Arménie (l\')'],
      [false, 'ASM', 'American Samoa', 'Samoa américaines (les)'],
      [false, 'ATA', 'Antarctica', 'Antarctique (l\')'],
      [false, 'ATF', 'French Southern Territories', 'Terres australes françaises (les)'],
      [false, 'ATG', 'Antigua and Barbuda', 'Antigua-et-Barbuda'],
      [false, 'AUS', 'Australia', 'Australie (l\')'],
      [false, 'AUT', 'Austria', 'Autriche (l\')'],
      [false, 'AZE', 'Azerbaijan', 'Azerbaïdjan (l\')'],
      [false, 'BDI', 'Burundi', 'Burundi (le)'],
      [false, 'BEL', 'Belgium', 'Belgique (la)'],
      [false, 'BEN', 'Benin', 'Bénin (le)'],
      [false, 'BES', 'Bonaire, Sint Eustatius and Saba', 'Bonaire, Saint-Eustache et Saba'],
      [false, 'BFA', 'Burkina Faso', 'Burkina Faso (le)'],
      [false, 'BGD', 'Bangladesh', 'Bangladesh (le)'],
      [false, 'BGR', 'Bulgaria', 'Bulgarie (la)'],
      [false, 'BHR', 'Bahrain', 'Bahreïn'],
      [false, 'BHS', 'Bahamas', 'Bahamas (les)'],
      [false, 'BIH', 'Bosnia and Herzegovina', 'Bosnie-Herzégovine (la)'],
      [false, 'BLM', 'Saint Barthélemy', 'Saint-Barthélemy'],
      [false, 'BLR', 'Belarus', 'Bélarus (le)'],
      [false, 'BLZ', 'Belize', 'Belize (le)'],
      [false, 'BMU', 'Bermuda', 'Bermudes (les)'],
      [false, 'BOL', 'Bolivia, Plurinational State of', 'Bolivie (État plurinational de)'],
      [false, 'BRA', 'Brazil', 'Brésil (le)'],
      [false, 'BRB', 'Barbados', 'Barbade (la)'],
      [false, 'BRN', 'Brunei Darussalam', 'Brunéi Darussalam (le)'],
      [false, 'BTN', 'Bhutan', 'Bhoutan (le)'],
      [false, 'BVT', 'Bouvet Island', 'Bouvet (l\'Île)'],
      [false, 'BWA', 'Botswana', 'Botswana (le)'],
      [false, 'CAF', 'Central African Republic', 'République centrafricaine (la)'],
      [false, 'CAN', 'Canada', 'Canada (le)'],
      [false, 'CCK', 'Cocos (Keeling) Islands', 'Cocos (les Îles)/ Keeling (les Îles)'],
      [false, 'CHE', 'Switzerland', 'Suisse (la)'],
      [false, 'CHL', 'Chile', 'Chili (le)'],
      [false, 'CHN', 'China', 'Chine (la)'],
      [false, 'CIV', 'Côte d\'Ivoire', 'Côte d\'Ivoire (la)'],
      [false, 'CMR', 'Cameroon', 'Cameroun (le)'],
      [false, 'COD', 'Congo, the Democratic Republic of the', 'Congo (la République démocratique du)'],
      [false, 'COG', 'Congo', 'Congo (le)'],
      [false, 'COK', 'Cook Islands', 'Cook (les Îles)'],
      [false, 'COL', 'Colombia', 'Colombie (la)'],
      [false, 'COM', 'Comoros', 'Comores (les)'],
      [false, 'CPV', 'Cabo Verde', 'Cabo Verde'],
      [false, 'CRI', 'Costa Rica', 'Costa Rica (le)'],
      [false, 'CUB', 'Cuba', 'Cuba'],
      [false, 'CUW', 'Curaçao', 'Curaçao'],
      [false, 'CXR', 'Christmas Island', 'Christmas (l\'Île)'],
      [false, 'CYM', 'Cayman Islands', 'Caïmans (les Îles)'],
      [false, 'CYP', 'Cyprus', 'Chypre'],
      [false, 'CZE', 'Czechia', 'Tchéquie (la)'],
      [false, 'DEU', 'Germany', 'Allemagne (l\')'],
      [false, 'DJI', 'Djibouti', 'Djibouti'],
      [false, 'DMA', 'Dominica', 'Dominique (la)'],
      [false, 'DNK', 'Denmark', 'Danemark (le)'],
      [false, 'DOM', 'Dominican Republic', 'dominicaine (la République)'],
      [false, 'DZA', 'Algeria', 'Algérie (l\')'],
      [false, 'ECU', 'Ecuador', 'Équateur (l\')'],
      [false, 'EGY', 'Egypt', 'Égypte (l\')'],
      [false, 'ERI', 'Eritrea', 'Érythrée (l\')'],
      [false, 'ESH', 'Western Sahara', 'Sahara occidental (le)*'],
      [false, 'ESP', 'Spain', 'Espagne (l\')'],
      [false, 'EST', 'Estonia', 'Estonie (l\')'],
      [false, 'ETH', 'Ethiopia', 'Éthiopie (l\')'],
      [false, 'FIN', 'Finland', 'Finlande (la)'],
      [false, 'FJI', 'Fiji', 'Fidji (les)'],
      [false, 'FLK', 'Falkland Islands (Malvinas)', 'Falkland (les Îles)/Malouines (les Îles)'],
      [false, 'FRA', 'France', 'France (la)'],
      [false, 'FRO', 'Faroe Islands', 'Féroé (les Îles)'],
      [false, 'FSM', 'Micronesia, Federated States of', 'Micronésie (États fédérés de)'],
      [false, 'GAB', 'Gabon', 'Gabon (le)'],
      [false, 'GBR', 'United Kingdom', 'Royaume-Uni de Grande-Bretagne et d\'Irlande du Nord (le)'],
      [false, 'GEO', 'Georgia', 'Géorgie (la)'],
      [false, 'GGY', 'Guernsey', 'Guernesey'],
      [false, 'GHA', 'Ghana', 'Ghana (le)'],
      [false, 'GIB', 'Gibraltar', 'Gibraltar'],
      [false, 'GIN', 'Guinea', 'Guinée (la)'],
      [false, 'GLP', 'Guadeloupe', 'Guadeloupe (la)'],
      [false, 'GMB', 'Gambia', 'Gambie (la)'],
      [false, 'GNB', 'Guinea-Bissau', 'Guinée-Bissau (la)'],
      [false, 'GNQ', 'Equatorial Guinea', 'Guinée équatoriale (la)'],
      [false, 'GRC', 'Greece', 'Grèce (la)'],
      [false, 'GRD', 'Grenada', 'Grenade (la)'],
      [false, 'GRL', 'Greenland', 'Groenland (le)'],
      [false, 'GTM', 'Guatemala', 'Guatemala (le)'],
      [false, 'GUF', 'French Guiana', 'Guyane française (la )'],
      [false, 'GUM', 'Guam', 'Guam'],
      [false, 'GUY', 'Guyana', 'Guyana (le)'],
      [false, 'HKG', 'Hong Kong', 'Hong Kong'],
      [false, 'HMD', 'Heard Island and McDonald Islands', 'Heard-et-Îles MacDonald (l\'Île)'],
      [false, 'HND', 'Honduras', 'Honduras (le)'],
      [false, 'HRV', 'Croatia', 'Croatie (la)'],
      [false, 'HTI', 'Haiti', 'Haïti'],
      [false, 'HUN', 'Hungary', 'Hongrie (la)'],
      [false, 'IDN', 'Indonesia', 'Indonésie (l\')'],
      [false, 'IMN', 'Isle of Man', 'Île de Man'],
      [false, 'IND', 'India', 'Inde (l\')'],
      [false, 'IOT', 'British Indian Ocean Territory', 'Indien (le Territoire britannique de l\'océan)'],
      [false, 'IRL', 'Ireland', 'Irlande (l\')'],
      [false, 'IRN', 'Iran, Islamic Republic of', 'Iran (République Islamique d\')'],
      [false, 'IRQ', 'Iraq', 'Iraq (l\')'],
      [false, 'ISL', 'Iceland', 'Islande (l\')'],
      [false, 'ISR', 'Israel', 'Israël'],
      [false, 'ITA', 'Italy', 'Italie (l\')'],
      [false, 'JAM', 'Jamaica', 'Jamaïque (la)'],
      [false, 'JEY', 'Jersey', 'Jersey'],
      [false, 'JOR', 'Jordan', 'Jordanie (la)'],
      [false, 'JPN', 'Japan', 'Japon (le)'],
      [false, 'KAZ', 'Kazakhstan', 'Kazakhstan (le)'],
      [false, 'KEN', 'Kenya', 'Kenya (le)'],
      [false, 'KGZ', 'Kyrgyzstan', 'Kirghizistan (le)'],
      [false, 'KHM', 'Cambodia', 'Cambodge (le)'],
      [false, 'KIR', 'Kiribati', 'Kiribati'],
      [false, 'KNA', 'Saint Kitts and Nevis', 'Saint-Kitts-et-Nevis'],
      [false, 'KOR', 'Korea, Republic of', 'Corée (la République de)'],
      [false, 'KWT', 'Kuwait', 'Koweït (le)'],
      [false, 'LAO', 'Lao People\'s Democratic Republic', 'Lao (la République démocratique populaire)'],
      [false, 'LBN', 'Lebanon', 'Liban (le)'],
      [false, 'LBR', 'Liberia', 'Libéria (le)'],
      [false, 'LBY', 'Libya', 'Libye (la)'],
      [false, 'LCA', 'Saint Lucia', 'Sainte-Lucie'],
      [false, 'LIE', 'Liechtenstein', 'Liechtenstein (le)'],
      [false, 'LKA', 'Sri Lanka', 'Sri Lanka'],
      [false, 'LSO', 'Lesotho', 'Lesotho (le)'],
      [false, 'LTU', 'Lithuania', 'Lituanie (la)'],
      [false, 'LUX', 'Luxembourg', 'Luxembourg (le)'],
      [false, 'LVA', 'Latvia', 'Lettonie (la)'],
      [false, 'MAC', 'Macao', 'Macao'],
      [false, 'MAF', 'Saint Martin (French part)', 'Saint-Martin (partie française)'],
      [false, 'MAR', 'Morocco', 'Maroc (le)'],
      [false, 'MCO', 'Monaco', 'Monaco'],
      [false, 'MDA', 'Moldova, Republic of', 'Moldova (la République de)'],
      [false, 'MDG', 'Madagascar', 'Madagascar'],
      [false, 'MDV', 'Maldives', 'Maldives (les)'],
      [false, 'MEX', 'Mexico', 'Mexique (le)'],
      [false, 'MHL', 'Marshall Islands', 'Marshall (les Îles)'],
      [false, 'MKD', 'Macedonia, the former Yugoslav Republic of', 'Macédoine du Nord (la)'],
      [false, 'MLI', 'Mali', 'Mali (le)'],
      [false, 'MLT', 'Malta', 'Malte'],
      [false, 'MMR', 'Myanmar', 'Myanmar (le)'],
      [false, 'MNE', 'Montenegro', 'Monténégro (le)'],
      [false, 'MNG', 'Mongolia', 'Mongolie (la)'],
      [false, 'MNP', 'Northern Mariana Islands', 'Mariannes du Nord (les Îles)'],
      [false, 'MOZ', 'Mozambique', 'Mozambique (le)'],
      [false, 'MRT', 'Mauritania', 'Mauritanie (la)'],
      [false, 'MSR', 'Montserrat', 'Montserrat'],
      [false, 'MTQ', 'Martinique', 'Martinique (la)'],
      [false, 'MUS', 'Mauritius', 'Maurice'],
      [false, 'MWI', 'Malawi', 'Malawi (le)'],
      [false, 'MYS', 'Malaysia', 'Malaisie (la)'],
      [false, 'MYT', 'Mayotte', 'Mayotte'],
      [false, 'NAM', 'Namibia', 'Namibie (la)'],
      [false, 'NCL', 'New Caledonia', 'Nouvelle-Calédonie (la)'],
      [false, 'NER', 'Niger', 'Niger (le)'],
      [false, 'NFK', 'Norfolk Island', 'Norfolk (l\'Île)'],
      [false, 'NGA', 'Nigeria', 'Nigéria (le)'],
      [false, 'NIC', 'Nicaragua', 'Nicaragua (le)'],
      [false, 'NIU', 'Niue', 'Niue'],
      [false, 'NLD', 'Netherlands', 'Pays-Bas (les)'],
      [false, 'NOR', 'Norway', 'Norvège (la)'],
      [false, 'NPL', 'Nepal', 'Népal (le)'],
      [false, 'NRU', 'Nauru', 'Nauru'],
      [false, 'NZL', 'New Zealand', 'Nouvelle-Zélande (la)'],
      [false, 'OMN', 'Oman', 'Oman'],
      [false, 'PAK', 'Pakistan', 'Pakistan (le)'],
      [false, 'PAN', 'Panama', 'Panama (le)'],
      [false, 'PCN', 'Pitcairn', 'Pitcairn'],
      [false, 'PER', 'Peru', 'Pérou (le)'],
      [false, 'PHL', 'Philippines', 'Philippines (les)'],
      [false, 'PLW', 'Palau', 'Palaos (les)'],
      [false, 'PNG', 'Papua New Guinea', 'Papouasie-Nouvelle-Guinée (la)'],
      [false, 'POL', 'Poland', 'Pologne (la)'],
      [false, 'PRI', 'Puerto Rico', 'Porto Rico'],
      [false, 'PRK', 'Korea, Democratic People\'s Republic of', 'Corée (la République populaire démocratique de)'],
      [false, 'PRT', 'Portugal', 'Portugal (le)'],
      [false, 'PRY', 'Paraguay', 'Paraguay (le)'],
      [false, 'PSE', 'Palestine, State of', 'Palestine, État de'],
      [false, 'PYF', 'French Polynesia', 'Polynésie française (la)'],
      [false, 'QAT', 'Qatar', 'Qatar (le)'],
      [false, 'REU', 'Réunion', 'Réunion (La)'],
      [false, 'ROU', 'Romania', 'Roumanie (la)'],
      [false, 'RUS', 'Russian Federation', 'Russie (la Fédération de)'],
      [false, 'RWA', 'Rwanda', 'Rwanda (le)'],
      [false, 'SAU', 'Saudi Arabia', 'Arabie saoudite (l\')'],
      [false, 'SDN', 'Sudan', 'Soudan (le)'],
      [false, 'SEN', 'Senegal', 'Sénégal (le)'],
      [false, 'SGP', 'Singapore', 'Singapour'],
      [false, 'SGS', 'South Georgia and the South Sandwich Islands', 'Géorgie du Sud-et-les Îles Sandwich du Sud (la)'],
      [false, 'SHN', 'Saint Helena, Ascension and Tristan da Cunha', 'Sainte-Hélène, Ascension et Tristan da Cunha'],
      [false, 'SJM', 'Svalbard and Jan Mayen', 'Svalbard et l\'Île Jan Mayen (le)'],
      [false, 'SLB', 'Solomon Islands', 'Salomon (les Îles)'],
      [false, 'SLE', 'Sierra Leone', 'Sierra Leone (la)'],
      [false, 'SLV', 'El Salvador', 'El Salvador'],
      [false, 'SMR', 'San Marino', 'Saint-Marin'],
      [false, 'SOM', 'Somalia', 'Somalie (la)'],
      [false, 'SPM', 'Saint Pierre and Miquelon', 'Saint-Pierre-et-Miquelon'],
      [false, 'SRB', 'Serbia', 'Serbie (la)'],
      [false, 'SSD', 'South Sudan', 'Soudan du Sud (le)'],
      [false, 'STP', 'Sao Tome and Principe', 'Sao Tomé-et-Principe'],
      [false, 'SUR', 'Suriname', 'Suriname (le)'],
      [false, 'SVK', 'Slovakia', 'Slovaquie (la)'],
      [false, 'SVN', 'Slovenia', 'Slovénie (la)'],
      [false, 'SWE', 'Sweden', 'Suède (la)'],
      [false, 'SWZ', 'Swaziland', 'Eswatini (l\')'],
      [false, 'SXM', 'Sint Maarten (Dutch part)', 'Saint-Martin (partie néerlandaise)'],
      [false, 'SYC', 'Seychelles', 'Seychelles (les)'],
      [false, 'SYR', 'Syrian Arab Republic', 'République arabe syrienne (la)'],
      [false, 'TCA', 'Turks and Caicos Islands', 'Turks-et-Caïcos (les Îles)'],
      [false, 'TCD', 'Chad', 'Tchad (le)'],
      [false, 'TGO', 'Togo', 'Togo (le)'],
      [false, 'THA', 'Thailand', 'Thaïlande (la)'],
      [false, 'TJK', 'Tajikistan', 'Tadjikistan (le)'],
      [false, 'TKL', 'Tokelau', 'Tokelau (les)'],
      [false, 'TKM', 'Turkmenistan', 'Turkménistan (le)'],
      [false, 'TLS', 'Timor-Leste', 'Timor-Leste (le)'],
      [false, 'TON', 'Tonga', 'Tonga (les)'],
      [false, 'TTO', 'Trinidad and Tobago', 'Trinité-et-Tobago (la)'],
      [false, 'TUN', 'Tunisia', 'Tunisie (la)'],
      [false, 'TUR', 'Turkey', 'Turquie (la)'],
      [false, 'TUV', 'Tuvalu', 'Tuvalu (les)'],
      [false, 'TWN', 'Taiwan, Province of China', 'Taïwan (Province de Chine)'],
      [false, 'TZA', 'Tanzania, United Republic of', 'Tanzanie (la République-Unie de)'],
      [false, 'UGA', 'Uganda', 'Ouganda (l\')'],
      [false, 'UKR', 'Ukraine', 'Ukraine (l\')'],
      [false, 'UMI', 'United States Minor Outlying Islands', 'Îles mineures éloignées des États-Unis (les)'],
      [false, 'URY', 'Uruguay', 'Uruguay (l\')'],
      [false, 'USA', 'United States of America', 'États-Unis d\'Amérique (les)'],
      [false, 'UZB', 'Uzbekistan', 'Ouzbékistan (l\')'],
      [false, 'VAT', 'Holy See', 'Saint-Siège (le)'],
      [false, 'VCT', 'Saint Vincent and the Grenadines', 'Saint-Vincent-et-les Grenadines'],
      [false, 'VEN', 'Venezuela, Bolivarian Republic of', 'Venezuela (République bolivarienne du)'],
      [false, 'VGB', 'Virgin Islands, British', 'Vierges britanniques (les Îles)'],
      [false, 'VIR', 'Virgin Islands, U.S.', 'Vierges des États-Unis (les Îles)'],
      [false, 'VNM', 'Viet Nam', 'Viet Nam (le)'],
      [false, 'VUT', 'Vanuatu', 'Vanuatu (le)'],
      [false, 'WLF', 'Wallis and Futuna', 'Wallis-et-Futuna'],
      [false, 'WSM', 'Samoa', 'Samoa (le)'],
      [false, 'YEM', 'Yemen', 'Yémen (le)'],
      [false, 'ZAF', 'South Africa', 'Afrique du Sud (l\')'],
      [false, 'ZMB', 'Zambia', 'Zambie (la)'],
      [false, 'ZWE', 'Zimbabwe', 'Zimbabwe (le)'],

      // ISO 3166-1 numeric codes
      [false, '004', 'Afghanistan', 'Afghanistan (l\')'],
      [false, '008', 'Albania', 'Albanie (l\')'],
      [false, '010', 'Antarctica', 'Antarctique (l\')'],
      [false, '012', 'Algeria', 'Algérie (l\')'],
      [false, '016', 'American Samoa', 'Samoa américaines (les)'],
      [false, '020', 'Andorra', 'Andorre (l\')'],
      [false, '024', 'Angola', 'Angola (l\')'],
      [false, '028', 'Antigua and Barbuda', 'Antigua-et-Barbuda'],
      [false, '031', 'Azerbaijan', 'Azerbaïdjan (l\')'],
      [false, '032', 'Argentina', 'Argentine (l\')'],
      [false, '036', 'Australia', 'Australie (l\')'],
      [false, '040', 'Austria', 'Autriche (l\')'],
      [false, '044', 'Bahamas', 'Bahamas (les)'],
      [false, '048', 'Bahrain', 'Bahreïn'],
      [false, '050', 'Bangladesh', 'Bangladesh (le)'],
      [false, '051', 'Armenia', 'Arménie (l\')'],
      [false, '052', 'Barbados', 'Barbade (la)'],
      [false, '056', 'Belgium', 'Belgique (la)'],
      [false, '060', 'Bermuda', 'Bermudes (les)'],
      [false, '064', 'Bhutan', 'Bhoutan (le)'],
      [false, '068', 'Bolivia, Plurinational State of', 'Bolivie (État plurinational de)'],
      [false, '070', 'Bosnia and Herzegovina', 'Bosnie-Herzégovine (la)'],
      [false, '072', 'Botswana', 'Botswana (le)'],
      [false, '074', 'Bouvet Island', 'Bouvet (l\'Île)'],
      [false, '076', 'Brazil', 'Brésil (le)'],
      [false, '084', 'Belize', 'Belize (le)'],
      [false, '086', 'British Indian Ocean Territory', 'Indien (le Territoire britannique de l\'océan)'],
      [false, '090', 'Solomon Islands', 'Salomon (les Îles)'],
      [false, '092', 'Virgin Islands, British', 'Vierges britanniques (les Îles)'],
      [false, '096', 'Brunei Darussalam', 'Brunéi Darussalam (le)'],
      [false, '100', 'Bulgaria', 'Bulgarie (la)'],
      [false, '104', 'Myanmar', 'Myanmar (le)'],
      [false, '108', 'Burundi', 'Burundi (le)'],
      [false, '112', 'Belarus', 'Bélarus (le)'],
      [false, '116', 'Cambodia', 'Cambodge (le)'],
      [false, '120', 'Cameroon', 'Cameroun (le)'],
      [false, '124', 'Canada', 'Canada (le)'],
      [false, '132', 'Cabo Verde', 'Cabo Verde'],
      [false, '136', 'Cayman Islands', 'Caïmans (les Îles)'],
      [false, '140', 'Central African Republic', 'République centrafricaine (la)'],
      [false, '144', 'Sri Lanka', 'Sri Lanka'],
      [false, '148', 'Chad', 'Tchad (le)'],
      [false, '152', 'Chile', 'Chili (le)'],
      [false, '156', 'China', 'Chine (la)'],
      [false, '158', 'Taiwan, Province of China', 'Taïwan (Province de Chine)'],
      [false, '162', 'Christmas Island', 'Christmas (l\'Île)'],
      [false, '166', 'Cocos (Keeling) Islands', 'Cocos (les Îles)/ Keeling (les Îles)'],
      [false, '170', 'Colombia', 'Colombie (la)'],
      [false, '174', 'Comoros', 'Comores (les)'],
      [false, '175', 'Mayotte', 'Mayotte'],
      [false, '178', 'Congo', 'Congo (le)'],
      [false, '180', 'Congo, the Democratic Republic of the', 'Congo (la République démocratique du)'],
      [false, '184', 'Cook Islands', 'Cook (les Îles)'],
      [false, '188', 'Costa Rica', 'Costa Rica (le)'],
      [false, '191', 'Croatia', 'Croatie (la)'],
      [false, '192', 'Cuba', 'Cuba'],
      [false, '196', 'Cyprus', 'Chypre'],
      [false, '203', 'Czechia', 'Tchéquie (la)'],
      [false, '204', 'Benin', 'Bénin (le)'],
      [false, '208', 'Denmark', 'Danemark (le)'],
      [false, '212', 'Dominica', 'Dominique (la)'],
      [false, '214', 'Dominican Republic', 'dominicaine (la République)'],
      [false, '218', 'Ecuador', 'Équateur (l\')'],
      [false, '222', 'El Salvador', 'El Salvador'],
      [false, '226', 'Equatorial Guinea', 'Guinée équatoriale (la)'],
      [false, '231', 'Ethiopia', 'Éthiopie (l\')'],
      [false, '232', 'Eritrea', 'Érythrée (l\')'],
      [false, '233', 'Estonia', 'Estonie (l\')'],
      [false, '234', 'Faroe Islands', 'Féroé (les Îles)'],
      [false, '238', 'Falkland Islands (Malvinas)', 'Falkland (les Îles)/Malouines (les Îles)'],
      [false, '239', 'South Georgia and the South Sandwich Islands', 'Géorgie du Sud-et-les Îles Sandwich du Sud (la)'],
      [false, '242', 'Fiji', 'Fidji (les)'],
      [false, '246', 'Finland', 'Finlande (la)'],
      [false, '248', 'Åland Islands', 'Åland(les Îles)'],
      [false, '250', 'France', 'France (la)'],
      [false, '254', 'French Guiana', 'Guyane française (la )'],
      [false, '258', 'French Polynesia', 'Polynésie française (la)'],
      [false, '260', 'French Southern Territories', 'Terres australes françaises (les)'],
      [false, '262', 'Djibouti', 'Djibouti'],
      [false, '266', 'Gabon', 'Gabon (le)'],
      [false, '268', 'Georgia', 'Géorgie (la)'],
      [false, '270', 'Gambia', 'Gambie (la)'],
      [false, '275', 'Palestine, State of', 'Palestine, État de'],
      [false, '276', 'Germany', 'Allemagne (l\')'],
      [false, '288', 'Ghana', 'Ghana (le)'],
      [false, '292', 'Gibraltar', 'Gibraltar'],
      [false, '296', 'Kiribati', 'Kiribati'],
      [false, '300', 'Greece', 'Grèce (la)'],
      [false, '304', 'Greenland', 'Groenland (le)'],
      [false, '308', 'Grenada', 'Grenade (la)'],
      [false, '312', 'Guadeloupe', 'Guadeloupe (la)'],
      [false, '316', 'Guam', 'Guam'],
      [false, '320', 'Guatemala', 'Guatemala (le)'],
      [false, '324', 'Guinea', 'Guinée (la)'],
      [false, '328', 'Guyana', 'Guyana (le)'],
      [false, '332', 'Haiti', 'Haïti'],
      [false, '334', 'Heard Island and McDonald Islands', 'Heard-et-Îles MacDonald (l\'Île)'],
      [false, '336', 'Holy See', 'Saint-Siège (le)'],
      [false, '340', 'Honduras', 'Honduras (le)'],
      [false, '344', 'Hong Kong', 'Hong Kong'],
      [false, '348', 'Hungary', 'Hongrie (la)'],
      [false, '352', 'Iceland', 'Islande (l\')'],
      [false, '356', 'India', 'Inde (l\')'],
      [false, '360', 'Indonesia', 'Indonésie (l\')'],
      [false, '364', 'Iran, Islamic Republic of', 'Iran (République Islamique d\')'],
      [false, '368', 'Iraq', 'Iraq (l\')'],
      [false, '372', 'Ireland', 'Irlande (l\')'],
      [false, '376', 'Israel', 'Israël'],
      [false, '380', 'Italy', 'Italie (l\')'],
      [false, '384', 'Côte d\'Ivoire', 'Côte d\'Ivoire (la)'],
      [false, '388', 'Jamaica', 'Jamaïque (la)'],
      [false, '392', 'Japan', 'Japon (le)'],
      [false, '398', 'Kazakhstan', 'Kazakhstan (le)'],
      [false, '400', 'Jordan', 'Jordanie (la)'],
      [false, '404', 'Kenya', 'Kenya (le)'],
      [false, '408', 'Korea, Democratic People\'s Republic of', 'Corée (la République populaire démocratique de)'],
      [false, '410', 'Korea, Republic of', 'Corée (la République de)'],
      [false, '414', 'Kuwait', 'Koweït (le)'],
      [false, '417', 'Kyrgyzstan', 'Kirghizistan (le)'],
      [false, '418', 'Lao People\'s Democratic Republic', 'Lao (la République démocratique populaire)'],
      [false, '422', 'Lebanon', 'Liban (le)'],
      [false, '426', 'Lesotho', 'Lesotho (le)'],
      [false, '428', 'Latvia', 'Lettonie (la)'],
      [false, '430', 'Liberia', 'Libéria (le)'],
      [false, '434', 'Libya', 'Libye (la)'],
      [false, '438', 'Liechtenstein', 'Liechtenstein (le)'],
      [false, '440', 'Lithuania', 'Lituanie (la)'],
      [false, '442', 'Luxembourg', 'Luxembourg (le)'],
      [false, '446', 'Macao', 'Macao'],
      [false, '450', 'Madagascar', 'Madagascar'],
      [false, '454', 'Malawi', 'Malawi (le)'],
      [false, '458', 'Malaysia', 'Malaisie (la)'],
      [false, '462', 'Maldives', 'Maldives (les)'],
      [false, '466', 'Mali', 'Mali (le)'],
      [false, '470', 'Malta', 'Malte'],
      [false, '474', 'Martinique', 'Martinique (la)'],
      [false, '478', 'Mauritania', 'Mauritanie (la)'],
      [false, '480', 'Mauritius', 'Maurice'],
      [false, '484', 'Mexico', 'Mexique (le)'],
      [false, '492', 'Monaco', 'Monaco'],
      [false, '496', 'Mongolia', 'Mongolie (la)'],
      [false, '498', 'Moldova, Republic of', 'Moldova (la République de)'],
      [false, '499', 'Montenegro', 'Monténégro (le)'],
      [false, '500', 'Montserrat', 'Montserrat'],
      [false, '504', 'Morocco', 'Maroc (le)'],
      [false, '508', 'Mozambique', 'Mozambique (le)'],
      [false, '512', 'Oman', 'Oman'],
      [false, '516', 'Namibia', 'Namibie (la)'],
      [false, '520', 'Nauru', 'Nauru'],
      [false, '524', 'Nepal', 'Népal (le)'],
      [false, '528', 'Netherlands', 'Pays-Bas (les)'],
      [false, '531', 'Curaçao', 'Curaçao'],
      [false, '533', 'Aruba', 'Aruba'],
      [false, '534', 'Sint Maarten (Dutch part)', 'Saint-Martin (partie néerlandaise)'],
      [false, '535', 'Bonaire, Sint Eustatius and Saba', 'Bonaire, Saint-Eustache et Saba'],
      [false, '540', 'New Caledonia', 'Nouvelle-Calédonie (la)'],
      [false, '548', 'Vanuatu', 'Vanuatu (le)'],
      [false, '554', 'New Zealand', 'Nouvelle-Zélande (la)'],
      [false, '558', 'Nicaragua', 'Nicaragua (le)'],
      [false, '562', 'Niger', 'Niger (le)'],
      [false, '566', 'Nigeria', 'Nigéria (le)'],
      [false, '570', 'Niue', 'Niue'],
      [false, '574', 'Norfolk Island', 'Norfolk (l\'Île)'],
      [false, '578', 'Norway', 'Norvège (la)'],
      [false, '580', 'Northern Mariana Islands', 'Mariannes du Nord (les Îles)'],
      [false, '581', 'United States Minor Outlying Islands', 'Îles mineures éloignées des États-Unis (les)'],
      [false, '583', 'Micronesia, Federated States of', 'Micronésie (États fédérés de)'],
      [false, '584', 'Marshall Islands', 'Marshall (les Îles)'],
      [false, '585', 'Palau', 'Palaos (les)'],
      [false, '586', 'Pakistan', 'Pakistan (le)'],
      [false, '591', 'Panama', 'Panama (le)'],
      [false, '598', 'Papua New Guinea', 'Papouasie-Nouvelle-Guinée (la)'],
      [false, '600', 'Paraguay', 'Paraguay (le)'],
      [false, '604', 'Peru', 'Pérou (le)'],
      [false, '608', 'Philippines', 'Philippines (les)'],
      [false, '612', 'Pitcairn', 'Pitcairn'],
      [false, '616', 'Poland', 'Pologne (la)'],
      [false, '620', 'Portugal', 'Portugal (le)'],
      [false, '624', 'Guinea-Bissau', 'Guinée-Bissau (la)'],
      [false, '626', 'Timor-Leste', 'Timor-Leste (le)'],
      [false, '630', 'Puerto Rico', 'Porto Rico'],
      [false, '634', 'Qatar', 'Qatar (le)'],
      [false, '638', 'Réunion', 'Réunion (La)'],
      [false, '642', 'Romania', 'Roumanie (la)'],
      [false, '643', 'Russian Federation', 'Russie (la Fédération de)'],
      [false, '646', 'Rwanda', 'Rwanda (le)'],
      [false, '652', 'Saint Barthélemy', 'Saint-Barthélemy'],
      [false, '654', 'Saint Helena, Ascension and Tristan da Cunha', 'Sainte-Hélène, Ascension et Tristan da Cunha'],
      [false, '659', 'Saint Kitts and Nevis', 'Saint-Kitts-et-Nevis'],
      [false, '660', 'Anguilla', 'Anguilla'],
      [false, '662', 'Saint Lucia', 'Sainte-Lucie'],
      [false, '663', 'Saint Martin (French part)', 'Saint-Martin (partie française)'],
      [false, '666', 'Saint Pierre and Miquelon', 'Saint-Pierre-et-Miquelon'],
      [false, '670', 'Saint Vincent and the Grenadines', 'Saint-Vincent-et-les Grenadines'],
      [false, '674', 'San Marino', 'Saint-Marin'],
      [false, '678', 'Sao Tome and Principe', 'Sao Tomé-et-Principe'],
      [false, '682', 'Saudi Arabia', 'Arabie saoudite (l\')'],
      [false, '686', 'Senegal', 'Sénégal (le)'],
      [false, '688', 'Serbia', 'Serbie (la)'],
      [false, '690', 'Seychelles', 'Seychelles (les)'],
      [false, '694', 'Sierra Leone', 'Sierra Leone (la)'],
      [false, '702', 'Singapore', 'Singapour'],
      [false, '703', 'Slovakia', 'Slovaquie (la)'],
      [false, '704', 'Viet Nam', 'Viet Nam (le)'],
      [false, '705', 'Slovenia', 'Slovénie (la)'],
      [false, '706', 'Somalia', 'Somalie (la)'],
      [false, '710', 'South Africa', 'Afrique du Sud (l\')'],
      [false, '716', 'Zimbabwe', 'Zimbabwe (le)'],
      [false, '724', 'Spain', 'Espagne (l\')'],
      [false, '728', 'South Sudan', 'Soudan du Sud (le)'],
      [false, '729', 'Sudan', 'Soudan (le)'],
      [false, '732', 'Western Sahara', 'Sahara occidental (le)*'],
      [false, '740', 'Suriname', 'Suriname (le)'],
      [false, '744', 'Svalbard and Jan Mayen', 'Svalbard et l\'Île Jan Mayen (le)'],
      [false, '748', 'Swaziland', 'Eswatini (l\')'],
      [false, '752', 'Sweden', 'Suède (la)'],
      [false, '756', 'Switzerland', 'Suisse (la)'],
      [false, '760', 'Syrian Arab Republic', 'République arabe syrienne (la)'],
      [false, '762', 'Tajikistan', 'Tadjikistan (le)'],
      [false, '764', 'Thailand', 'Thaïlande (la)'],
      [false, '768', 'Togo', 'Togo (le)'],
      [false, '772', 'Tokelau', 'Tokelau (les)'],
      [false, '776', 'Tonga', 'Tonga (les)'],
      [false, '780', 'Trinidad and Tobago', 'Trinité-et-Tobago (la)'],
      [false, '784', 'United Arab Emirates', 'Émirats arabes unis (les)'],
      [false, '788', 'Tunisia', 'Tunisie (la)'],
      [false, '792', 'Turkey', 'Turquie (la)'],
      [false, '795', 'Turkmenistan', 'Turkménistan (le)'],
      [false, '796', 'Turks and Caicos Islands', 'Turks-et-Caïcos (les Îles)'],
      [false, '798', 'Tuvalu', 'Tuvalu (les)'],
      [false, '800', 'Uganda', 'Ouganda (l\')'],
      [false, '804', 'Ukraine', 'Ukraine (l\')'],
      [false, '807', 'Macedonia, the former Yugoslav Republic of', 'Macédoine du Nord (la)'],
      [false, '818', 'Egypt', 'Égypte (l\')'],
      [false, '826', 'United Kingdom', 'Royaume-Uni de Grande-Bretagne et d\'Irlande du Nord (le)'],
      [false, '831', 'Guernsey', 'Guernesey'],
      [false, '832', 'Jersey', 'Jersey'],
      [false, '833', 'Isle of Man', 'Île de Man'],
      [false, '834', 'Tanzania, United Republic of', 'Tanzanie (la République-Unie de)'],
      [false, '840', 'United States of America', 'États-Unis d\'Amérique (les)'],
      [false, '850', 'Virgin Islands, U.S.', 'Vierges des États-Unis (les Îles)'],
      [false, '854', 'Burkina Faso', 'Burkina Faso (le)'],
      [false, '858', 'Uruguay', 'Uruguay (l\')'],
      [false, '860', 'Uzbekistan', 'Ouzbékistan (l\')'],
      [false, '862', 'Venezuela, Bolivarian Republic of', 'Venezuela (République bolivarienne du)'],
      [false, '876', 'Wallis and Futuna', 'Wallis-et-Futuna'],
      [false, '882', 'Samoa', 'Samoa (le)'],
      [false, '887', 'Yemen', 'Yémen (le)'],
      [false, '894', 'Zambia', 'Zambie (la)'],
    ];

    for (const [userDefined, code, display, french] of data) {
      const concept = new CountryCodeConcept(userDefined, code, display, french || null);
      this.codes.push(concept);
      this.codeMap.set(code, concept);
    }
  }
  // eslint-disable-next-line no-unused-vars
  async buildKnownValueSet(url, version) {
    return null;
  }
  name() {
    return 'Country Codes';
  }

  id() {
    return "countries";
  }
}

module.exports = {
  CountryCodeServices,
  CountryCodeFactoryProvider,
  CountryCodeConcept,
  CountryCodeConceptFilter
};