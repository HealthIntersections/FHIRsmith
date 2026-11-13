const { CodeSystemProvider, FilterExecutionContext, CodeSystemFactoryProvider} = require('./cs-api');
const assert = require('assert');
const { CodeSystem } = require("../library/codesystem");
const { Issue } = require('../library/operation-outcome');

class AreaCodeConcept {
  constructor(code, display, abbrev, class_) {
    this.code = code;
    this.display = abbrev ? `${display} (${abbrev})` : display;
    this.class_ = class_;
  }
}

class AreaCodeConceptFilter {
  constructor() {
    this.list = [];
    this.cursor = -1;
  }
}

class AreaCodeServices extends CodeSystemProvider {
  constructor(opContext, supplements, codes, codeMap) {
    super(opContext, supplements);
    this.codes = codes || [];
    this.codeMap = codeMap || new Map();
  }

  // Metadata methods
  system() {
    return 'http://unstats.un.org/unsd/methods/m49/m49.htm';
  }

  version() {
    return null; // No version specified
  }

  description() {
    return 'International area/region Codes';
  }

  name() {
    return 'Region Codes';
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
    if (ctxt.display && this.opContext.langs.isEnglishOrNothing()) {
      return ctxt ? ctxt.display : '';
    }
    let disp = this._displayFromSupplements(ctxt.code);
    if (disp) {
      return disp;
    }
    return ctxt.display;
  }

  async definition(code) {
    await this.#ensureContext(code);
    return null; // No definitions provided in original
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
      displays.addDesignation(true, 'active', 'en', CodeSystem.makeUseForDisplay(), ctxt.display);
      this._listSupplementDesignations(ctxt.code, displays);
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
    if (code instanceof AreaCodeConcept) {
      return code;
    }
    throw "Unknown Type at #ensureContext: "+ (typeof code);
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

    return (prop === 'type' || prop === 'class') && op === '=';
  }

  async filter(filterContext, forIteration, prop, op, value) {
    
    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    assert(prop != null && typeof prop === 'string', 'prop must be a non-null string');
    assert(op != null && typeof op === 'string', 'op must be a non-null string');
    assert(value != null && typeof value === 'string', 'value must be a non-null string');

    if ((prop === 'type' || prop === 'class') && op === '=') {
      const result = new AreaCodeConceptFilter();

      for (const concept of this.codes) {
        if (concept.class_ === value) {
          result.list.push(concept);
        }
      }
      filterContext.filters.push(result);
    } else {
      throw new Issue('error', 'not-supported', null, 'FILTER_NOT_UNDERSTOOD',
        `The filter ${prop} ${op} = ${value} is not supported for ${this.system()}`, 'vs-invalid', 422);
    }
  }

  async executeFilters(filterContext) {
    
    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    return filterContext.filters;
  }

  async filterSize(filterContext, set) {
    
    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    assert(set && set instanceof AreaCodeConceptFilter, 'set must be a AreaCodeConceptFilter');
    return set.list.length;
  }

  async filtersNotClosed(filterContext) {
    
    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    return false; // Finite set
  }

  async filterMore(filterContext, set) {
    
    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    assert(set && set instanceof AreaCodeConceptFilter, 'set must be a AreaCodeConceptFilter');
    set.cursor++;
    return set.cursor < set.list.length;
  }

  async filterConcept(filterContext, set) {
    
    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    assert(set && set instanceof AreaCodeConceptFilter, 'set must be a AreaCodeConceptFilter');
    if (set.cursor >= 0 && set.cursor < set.list.length) {
      return set.list[set.cursor];
    }
    return null;
  }

  async filterLocate(filterContext, set, code) {
    
    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    assert(set && set instanceof AreaCodeConceptFilter, 'set must be a AreaCodeConceptFilter');
    assert(typeof code === 'string', 'code must be non-null string');

    for (const concept of set.list) {
      if (concept.code === code) {
        return concept;
      }
    }
    return null;
  }

  async filterCheck(filterContext, set, concept) {
    
    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    assert(set && set instanceof AreaCodeConceptFilter, 'set must be a AreaCodeConceptFilter');
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
    return null;
  }
}

class AreaCodeFactoryProvider extends CodeSystemFactoryProvider {
  constructor(i18n) {
    super(i18n);
    this.uses = 0;
    this.codes = null;
    this.codeMap = null;
  }

  defaultVersion() {
    return null; // No versioning for area codes
  }

  system() {
    return 'http://unstats.un.org/unsd/methods/m49/m49.htm';
  }

  version() {
    return null; // No version specified
  }

  build(opContext, supplements) {
    this.uses++;

    return new AreaCodeServices(opContext, supplements, this.codes, this.codeMap);
  }

  useCount() {
    return this.uses;
  }

  recordUse() {
    this.uses++;
  }

  // eslint-disable-next-line no-unused-vars
  async buildKnownValueSet(url, version) {
    return null;
  }

  async load() {
    this.codes = [];
    this.codeMap = new Map();

    const data = [
      // Countries
      ['004', 'Afghanistan', 'AFG', 'country'],
      ['248', 'Åland Islands', 'ALA', 'country'],
      ['008', 'Albania', 'ALB', 'country'],
      ['012', 'Algeria', 'DZA', 'country'],
      ['016', 'American Samoa', 'ASM', 'country'],
      ['020', 'Andorra', 'AND', 'country'],
      ['024', 'Angola', 'AGO', 'country'],
      ['660', 'Anguilla', 'AIA', 'country'],
      ['028', 'Antigua and Barbuda', 'ATG', 'country'],
      ['032', 'Argentina', 'ARG', 'country'],
      ['051', 'Armenia', 'ARM', 'country'],
      ['533', 'Aruba', 'ABW', 'country'],
      ['036', 'Australia', 'AUS', 'country'],
      ['040', 'Austria', 'AUT', 'country'],
      ['031', 'Azerbaijan', 'AZE', 'country'],
      ['044', 'Bahamas', 'BHS', 'country'],
      ['048', 'Bahrain', 'BHR', 'country'],
      ['050', 'Bangladesh', 'BGD', 'country'],
      ['052', 'Barbados', 'BRB', 'country'],
      ['112', 'Belarus', 'BLR', 'country'],
      ['056', 'Belgium', 'BEL', 'country'],
      ['084', 'Belize', 'BLZ', 'country'],
      ['204', 'Benin', 'BEN', 'country'],
      ['060', 'Bermuda', 'BMU', 'country'],
      ['064', 'Bhutan', 'BTN', 'country'],
      ['068', 'Bolivia (Plurinational State of)', 'BOL', 'country'],
      ['535', 'Bonaire, Sint Eustatius and Saba', 'BES', 'country'],
      ['070', 'Bosnia and Herzegovina', 'BIH', 'country'],
      ['072', 'Botswana', 'BWA', 'country'],
      ['076', 'Brazil', 'BRA', 'country'],
      ['092', 'British Virgin Islands', 'VGB', 'country'],
      ['096', 'Brunei Darussalam', 'BRN', 'country'],
      ['100', 'Bulgaria', 'BGR', 'country'],
      ['854', 'Burkina Faso', 'BFA', 'country'],
      ['108', 'Burundi', 'BDI', 'country'],
      ['132', 'Cabo Verde', 'CPV', 'country'],
      ['116', 'Cambodia', 'KHM', 'country'],
      ['120', 'Cameroon', 'CMR', 'country'],
      ['124', 'Canada', 'CAN', 'country'],
      ['136', 'Cayman Islands', 'CYM', 'country'],
      ['140', 'Central African Republic', 'CAF', 'country'],
      ['148', 'Chad', 'TCD', 'country'],
      ['830', 'Channel Islands', '', 'country'],
      ['152', 'Chile', 'CHL', 'country'],
      ['156', 'China', 'CHN', 'country'],
      ['344', 'China, Hong Kong Special Administrative Region', 'HKG', 'country'],
      ['446', 'China, Macao Special Administrative Region', 'MAC', 'country'],
      ['170', 'Colombia', 'COL', 'country'],
      ['174', 'Comoros', 'COM', 'country'],
      ['178', 'Congo', 'COG', 'country'],
      ['184', 'Cook Islands', 'COK', 'country'],
      ['188', 'Costa Rica', 'CRI', 'country'],
      ['384', 'Côte d\'Ivoire', 'CIV', 'country'],
      ['191', 'Croatia', 'HRV', 'country'],
      ['192', 'Cuba', 'CUB', 'country'],
      ['531', 'Curaçao', 'CUW', 'country'],
      ['196', 'Cyprus', 'CYP', 'country'],
      ['203', 'Czech Republic', 'CZE', 'country'],
      ['408', 'Democratic People\'s Republic of Korea', 'PRK', 'country'],
      ['180', 'Democratic Republic of the Congo', 'COD', 'country'],
      ['208', 'Denmark', 'DNK', 'country'],
      ['262', 'Djibouti', 'DJI', 'country'],
      ['212', 'Dominica', 'DMA', 'country'],
      ['214', 'Dominican Republic', 'DOM', 'country'],
      ['218', 'Ecuador', 'ECU', 'country'],
      ['818', 'Egypt', 'EGY', 'country'],
      ['222', 'El Salvador', 'SLV', 'country'],
      ['226', 'Equatorial Guinea', 'GNQ', 'country'],
      ['232', 'Eritrea', 'ERI', 'country'],
      ['233', 'Estonia', 'EST', 'country'],
      ['231', 'Ethiopia', 'ETH', 'country'],
      ['234', 'Faeroe Islands', 'FRO', 'country'],
      ['238', 'Falkland Islands (Malvinas)', 'FLK', 'country'],
      ['242', 'Fiji', 'FJI', 'country'],
      ['246', 'Finland', 'FIN', 'country'],
      ['250', 'France', 'FRA', 'country'],
      ['254', 'French Guiana', 'GUF', 'country'],
      ['258', 'French Polynesia', 'PYF', 'country'],
      ['266', 'Gabon', 'GAB', 'country'],
      ['270', 'Gambia', 'GMB', 'country'],
      ['268', 'Georgia', 'GEO', 'country'],
      ['276', 'Germany', 'DEU', 'country'],
      ['288', 'Ghana', 'GHA', 'country'],
      ['292', 'Gibraltar', 'GIB', 'country'],
      ['300', 'Greece', 'GRC', 'country'],
      ['304', 'Greenland', 'GRL', 'country'],
      ['308', 'Grenada', 'GRD', 'country'],
      ['312', 'Guadeloupe', 'GLP', 'country'],
      ['316', 'Guam', 'GUM', 'country'],
      ['320', 'Guatemala', 'GTM', 'country'],
      ['831', 'Guernsey', 'GGY', 'country'],
      ['324', 'Guinea', 'GIN', 'country'],
      ['624', 'Guinea-Bissau', 'GNB', 'country'],
      ['328', 'Guyana', 'GUY', 'country'],
      ['332', 'Haiti', 'HTI', 'country'],
      ['336', 'Holy See', 'VAT', 'country'],
      ['340', 'Honduras', 'HND', 'country'],
      ['348', 'Hungary', 'HUN', 'country'],
      ['352', 'Iceland', 'ISL', 'country'],
      ['356', 'India', 'IND', 'country'],
      ['360', 'Indonesia', 'IDN', 'country'],
      ['364', 'Iran (Islamic Republic of)', 'IRN', 'country'],
      ['368', 'Iraq', 'IRQ', 'country'],
      ['372', 'Ireland', 'IRL', 'country'],
      ['833', 'Isle of Man', 'IMN', 'country'],
      ['376', 'Israel', 'ISR', 'country'],
      ['380', 'Italy', 'ITA', 'country'],
      ['388', 'Jamaica', 'JAM', 'country'],
      ['392', 'Japan', 'JPN', 'country'],
      ['832', 'Jersey', 'JEY', 'country'],
      ['400', 'Jordan', 'JOR', 'country'],
      ['398', 'Kazakhstan', 'KAZ', 'country'],
      ['404', 'Kenya', 'KEN', 'country'],
      ['296', 'Kiribati', 'KIR', 'country'],
      ['414', 'Kuwait', 'KWT', 'country'],
      ['417', 'Kyrgyzstan', 'KGZ', 'country'],
      ['418', 'Lao People\'s Democratic Republic', 'LAO', 'country'],
      ['428', 'Latvia', 'LVA', 'country'],
      ['422', 'Lebanon', 'LBN', 'country'],
      ['426', 'Lesotho', 'LSO', 'country'],
      ['430', 'Liberia', 'LBR', 'country'],
      ['434', 'Libya', 'LBY', 'country'],
      ['438', 'Liechtenstein', 'LIE', 'country'],
      ['440', 'Lithuania', 'LTU', 'country'],
      ['442', 'Luxembourg', 'LUX', 'country'],
      ['450', 'Madagascar', 'MDG', 'country'],
      ['454', 'Malawi', 'MWI', 'country'],
      ['458', 'Malaysia', 'MYS', 'country'],
      ['462', 'Maldives', 'MDV', 'country'],
      ['466', 'Mali', 'MLI', 'country'],
      ['470', 'Malta', 'MLT', 'country'],
      ['584', 'Marshall Islands', 'MHL', 'country'],
      ['474', 'Martinique', 'MTQ', 'country'],
      ['478', 'Mauritania', 'MRT', 'country'],
      ['480', 'Mauritius', 'MUS', 'country'],
      ['175', 'Mayotte', 'MYT', 'country'],
      ['484', 'Mexico', 'MEX', 'country'],
      ['583', 'Micronesia (Federated States of)', 'FSM', 'country'],
      ['492', 'Monaco', 'MCO', 'country'],
      ['496', 'Mongolia', 'MNG', 'country'],
      ['499', 'Montenegro', 'MNE', 'country'],
      ['500', 'Montserrat', 'MSR', 'country'],
      ['504', 'Morocco', 'MAR', 'country'],
      ['508', 'Mozambique', 'MOZ', 'country'],
      ['104', 'Myanmar', 'MMR', 'country'],
      ['516', 'Namibia', 'NAM', 'country'],
      ['520', 'Nauru', 'NRU', 'country'],
      ['524', 'Nepal', 'NPL', 'country'],
      ['528', 'Netherlands', 'NLD', 'country'],
      ['540', 'New Caledonia', 'NCL', 'country'],
      ['554', 'New Zealand', 'NZL', 'country'],
      ['558', 'Nicaragua', 'NIC', 'country'],
      ['562', 'Niger', 'NER', 'country'],
      ['566', 'Nigeria', 'NGA', 'country'],
      ['570', 'Niue', 'NIU', 'country'],
      ['574', 'Norfolk Island', 'NFK', 'country'],
      ['580', 'Northern Mariana Islands', 'MNP', 'country'],
      ['578', 'Norway', 'NOR', 'country'],
      ['512', 'Oman', 'OMN', 'country'],
      ['586', 'Pakistan', 'PAK', 'country'],
      ['585', 'Palau', 'PLW', 'country'],
      ['591', 'Panama', 'PAN', 'country'],
      ['598', 'Papua New Guinea', 'PNG', 'country'],
      ['600', 'Paraguay', 'PRY', 'country'],
      ['604', 'Peru', 'PER', 'country'],
      ['608', 'Philippines', 'PHL', 'country'],
      ['612', 'Pitcairn', 'PCN', 'country'],
      ['616', 'Poland', 'POL', 'country'],
      ['620', 'Portugal', 'PRT', 'country'],
      ['630', 'Puerto Rico', 'PRI', 'country'],
      ['634', 'Qatar', 'QAT', 'country'],
      ['410', 'Republic of Korea', 'KOR', 'country'],
      ['498', 'Republic of Moldova', 'MDA', 'country'],
      ['638', 'Réunion', 'REU', 'country'],
      ['642', 'Romania', 'ROU', 'country'],
      ['643', 'Russian Federation', 'RUS', 'country'],
      ['646', 'Rwanda', 'RWA', 'country'],
      ['652', 'Saint Barthélemy', 'BLM', 'country'],
      ['654', 'Saint Helena', 'SHN', 'country'],
      ['659', 'Saint Kitts and Nevis', 'KNA', 'country'],
      ['662', 'Saint Lucia', 'LCA', 'country'],
      ['663', 'Saint Martin (French part)', 'MAF', 'country'],
      ['666', 'Saint Pierre and Miquelon', 'SPM', 'country'],
      ['670', 'Saint Vincent and the Grenadines', 'VCT', 'country'],
      ['882', 'Samoa', 'WSM', 'country'],
      ['674', 'San Marino', 'SMR', 'country'],
      ['678', 'Sao Tome and Principe', 'STP', 'country'],
      ['680', 'Sark', '', 'country'],
      ['682', 'Saudi Arabia', 'SAU', 'country'],
      ['686', 'Senegal', 'SEN', 'country'],
      ['688', 'Serbia', 'SRB', 'country'],
      ['690', 'Seychelles', 'SYC', 'country'],
      ['694', 'Sierra Leone', 'SLE', 'country'],
      ['702', 'Singapore', 'SGP', 'country'],
      ['534', 'Sint Maarten (Dutch part)', 'SXM', 'country'],
      ['703', 'Slovakia', 'SVK', 'country'],
      ['705', 'Slovenia', 'SVN', 'country'],
      ['090', 'Solomon Islands', 'SLB', 'country'],
      ['706', 'Somalia', 'SOM', 'country'],
      ['710', 'South Africa', 'ZAF', 'country'],
      ['728', 'South Sudan', 'SSD', 'country'],
      ['724', 'Spain', 'ESP', 'country'],
      ['144', 'Sri Lanka', 'LKA', 'country'],
      ['275', 'State of Palestine', 'PSE', 'country'],
      ['729', 'Sudan', 'SDN', 'country'],
      ['740', 'Suriname', 'SUR', 'country'],
      ['744', 'Svalbard and Jan Mayen Islands', 'SJM', 'country'],
      ['748', 'Swaziland', 'SWZ', 'country'],
      ['752', 'Sweden', 'SWE', 'country'],
      ['756', 'Switzerland', 'CHE', 'country'],
      ['760', 'Syrian Arab Republic', 'SYR', 'country'],
      ['762', 'Tajikistan', 'TJK', 'country'],
      ['764', 'Thailand', 'THA', 'country'],
      ['807', 'The former Yugoslav Republic of Macedonia', 'MKD', 'country'],
      ['626', 'Timor-Leste', 'TLS', 'country'],
      ['768', 'Togo', 'TGO', 'country'],
      ['772', 'Tokelau', 'TKL', 'country'],
      ['776', 'Tonga', 'TON', 'country'],
      ['780', 'Trinidad and Tobago', 'TTO', 'country'],
      ['788', 'Tunisia', 'TUN', 'country'],
      ['792', 'Turkey', 'TUR', 'country'],
      ['795', 'Turkmenistan', 'TKM', 'country'],
      ['796', 'Turks and Caicos Islands', 'TCA', 'country'],
      ['798', 'Tuvalu', 'TUV', 'country'],
      ['800', 'Uganda', 'UGA', 'country'],
      ['804', 'Ukraine', 'UKR', 'country'],
      ['784', 'United Arab Emirates', 'ARE', 'country'],
      ['826', 'United Kingdom of Great Britain and Northern Ireland', 'GBR', 'country'],
      ['834', 'United Republic of Tanzania', 'TZA', 'country'],
      ['840', 'United States of America', 'USA', 'country'],
      ['850', 'United States Virgin Islands', 'VIR', 'country'],
      ['858', 'Uruguay', 'URY', 'country'],
      ['860', 'Uzbekistan', 'UZB', 'country'],
      ['548', 'Vanuatu', 'VUT', 'country'],
      ['862', 'Venezuela (Bolivarian Republic of)', 'VEN', 'country'],
      ['704', 'Viet Nam', 'VNM', 'country'],
      ['876', 'Wallis and Futuna Islands', 'WLF', 'country'],
      ['732', 'Western Sahara', 'ESH', 'country'],
      ['887', 'Yemen', 'YEM', 'country'],
      ['894', 'Zambia', 'ZMB', 'country'],
      ['716', 'Zimbabwe', 'ZWE', 'country'],

      // Regions
      ['001', 'World', '', 'region'],
      ['002', 'Africa', '', 'region'],
      ['014', 'Eastern Africa', '', 'region'],
      ['017', 'Middle Africa', '', 'region'],
      ['015', 'Northern Africa', '', 'region'],
      ['018', 'Southern Africa', '', 'region'],
      ['011', 'Western Africa', '', 'region'],
      ['019', 'Americas', '', 'region'],
      ['419', 'Latin America and the Caribbean', '', 'region'],
      ['029', 'Caribbean', '', 'region'],
      ['013', 'Central America', '', 'region'],
      ['005', 'South America', '', 'region'],
      ['021', 'Northern America', '', 'region'],
      ['142', 'Asia', '', 'region'],
      ['143', 'Central Asia', '', 'region'],
      ['030', 'Eastern Asia', '', 'region'],
      ['034', 'Southern Asia', '', 'region'],
      ['035', 'South-Eastern Asia', '', 'region'],
      ['145', 'Western Asia', '', 'region'],
      ['150', 'Europe', '', 'region'],
      ['151', 'Eastern Europe', '', 'region'],
      ['154', 'Northern Europe', '', 'region'],
      ['039', 'Southern Europe', '', 'region'],
      ['155', 'Western Europe', '', 'region'],
      ['009', 'Oceania', '', 'region'],
      ['053', 'Australia and New Zealand', '', 'region'],
      ['054', 'Melanesia', '', 'region'],
      ['057', 'Micronesia', '', 'region'],
      ['061', 'Polynesia', '', 'region']
    ];

    // Load concepts into arrays and map
    for (const [code, display, abbrev, class_] of data) {
      const concept = new AreaCodeConcept(code, display, abbrev, class_);
      this.codes.push(concept);
      this.codeMap.set(code, concept);
    }
  }

  name() {
    return 'Region Codes';
  }

  id() {
    return "areas";
  }
}

module.exports = {
  AreaCodeServices,
  AreaCodeFactoryProvider,
  AreaCodeConcept,
  AreaCodeConceptFilter
};