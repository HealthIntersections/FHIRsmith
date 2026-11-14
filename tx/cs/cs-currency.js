const { CodeSystemProvider, FilterExecutionContext, CodeSystemFactoryProvider} = require('./cs-api');
const assert = require('assert');
const { CodeSystem } = require("../library/codesystem");
const { Issue } = require('../library/operation-outcome');

class CurrencyConcept {
  constructor(code, display, decimals, symbol) {
    this.code = code;
    this.display = display;
    this.decimals = decimals;
    this.symbol = symbol;
  }
}

class CurrencyConceptFilter {
  constructor() {
    this.list = [];
    this.cursor = -1;
  }
}

class Iso4217Services extends CodeSystemProvider {
  constructor(opContext, supplements, codes, codeMap) {
    super(opContext, supplements);
    this.codes = codes || [];
    this.codeMap = codeMap || new Map();
  }

  // Metadata methods
  system() {
    return 'urn:iso:std:iso:4217';
  }

  version() {
    return null; // No version specified
  }

  description() {
    return 'Currencies';
  }

  name() {
    return 'Currencies';
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
      return ctxt.display.trim();
    }
    let disp = this._displayFromSupplements(ctxt.code);
    if (disp) {
      return disp;
    }
    return ctxt.display ? ctxt.display.trim() : '';
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
        throw new Error(ctxt.message ? ctxt.message : `Currency Code '${code}' not found`);
      } else {
        return ctxt.context;
      }
    }
    if (code instanceof CurrencyConcept) {
      return code;
    }
    throw new Error("Unknown Type at #ensureContext: " + (typeof code));
  }

  // Lookup methods
  async locate(code) {
    
    assert(!code || typeof code === 'string', 'code must be string');
    if (!code) return { context: null, message: 'Empty code' };

    const concept = this.codeMap.get(code);
    if (concept) {
      return { context: concept, message: null };
    }
    return { context: null, message: undefined };
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

    return prop === 'decimals' && op === 'equals';
  }

  async filter(filterContext, forIteration, prop, op, value) {
    
    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    assert(prop != null && typeof prop === 'string', 'prop must be a non-null string');
    assert(op != null && typeof op === 'string', 'op must be a non-null string');
    assert(value != null && typeof value === 'string', 'value must be a non-null string');

    if (prop === 'decimals' && op === 'equals') {
      const result = new CurrencyConceptFilter();

      for (const concept of this.codes) {
        if (concept.decimals.toString() === value) {
          result.list.push(concept);
        }
      }
      filterContext.filters.push(result);
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
    assert(set && set instanceof CurrencyConceptFilter, 'set must be a CurrencyConceptFilter');
    return set.list.length;
  }

  async filtersNotClosed(filterContext) {
    
    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    return false; // Finite set
  }

  async filterMore(filterContext, set) {
    
    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    assert(set && set instanceof CurrencyConceptFilter, 'set must be a CurrencyConceptFilter');
    set.cursor++;
    return set.cursor < set.list.length;
  }

  async filterConcept(filterContext, set) {
    
    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    assert(set && set instanceof CurrencyConceptFilter, 'set must be a CurrencyConceptFilter');
    if (set.cursor >= 0 && set.cursor < set.list.length) {
      return set.list[set.cursor];
    }
    return null;
  }

  async filterLocate(filterContext, set, code) {
    
    assert(filterContext && filterContext instanceof FilterExecutionContext, 'filterContext must be a FilterExecutionContext');
    assert(set && set instanceof CurrencyConceptFilter, 'set must be a CurrencyConceptFilter');
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
    assert(set && set instanceof CurrencyConceptFilter, 'set must be a CurrencyConceptFilter');
    const ctxt = await this.#ensureContext(concept);
    return set.list.includes(ctxt);
  }


  // Subsumption
  async subsumesTest(codeA, codeB) {
    await this.#ensureContext(codeA);
    await this.#ensureContext(codeB);
    return 'not-subsumed'; // No subsumption relationships
  }

  async locateIsA(code, parent) {
    await this.#ensureContext(code);
    await this.#ensureContext(parent);
    return { context: null, message: 'Subsumption not supported for ISO 4217' };
  }


  versionAlgorithm() {
    return null;
  }
}

class Iso4217FactoryProvider extends CodeSystemFactoryProvider {
  constructor(i18n) {
    super(i18n);
    this.uses = 0;
    this.codes = null;
    this.codeMap = null;
  }

  defaultVersion() {
    return null; // No versioning for ISO 4217
  }

  // Metadata methods
  system() {
    return 'urn:iso:std:iso:4217';
  }

  version() {
    return null; // No version specified
  }

  build(opContext, supplements) {
    this.uses++;
    return new Iso4217Services(opContext, supplements, this.codes, this.codeMap);
  }

  useCount() {
    return this.uses;
  }

  // eslint-disable-next-line no-unused-vars
  async buildKnownValueSet(url, version) {
    return null;
  }

  recordUse() {
    this.uses++;
  }

  async load() {
    this.codes = [];
    this.codeMap = new Map();

    // Currency data: [code, decimals, symbol, display]
    const data = [
      ['AED', 2, 'DH', 'United Arab Emirates dirham'],
      ['AFN', 2, '؋', 'Afghan afghani'],
      ['ALL', 2, 'Lek', 'Albanian lek'],
      ['AMD', 2, '', 'Armenian dram'],
      ['ANG', 2, 'ƒ', 'Netherlands Antillean guilder'],
      ['AOA', 2, 'Kz', 'Angolan kwanza'],
      ['ARS', 2, '$', 'Argentine peso'],
      ['AUD', 2, '$', 'Australian dollar'],
      ['AWG', 2, 'ƒ', 'Aruban florin'],
      ['AZN', 2, '₼', 'Azerbaijani manat'],
      ['BAM', 2, 'KM', 'Bosnia and Herzegovina convertible mark'],
      ['BBD', 2, '$', 'Barbados dollar'],
      ['BDT', 2, '', 'Bangladeshi taka'],
      ['BGN', 2, 'лв', 'Bulgarian lev'],
      ['BHD', 3, '', 'Bahraini dinar'],
      ['BIF', 0, '', 'Burundian franc'],
      ['BMD', 2, '', 'Bermudian dollar'],
      ['BND', 2, '$', 'Brunei dollar'],
      ['BOB', 2, '', 'Boliviano'],
      ['BOV', 2, '', 'Bolivian Mvdol (funds code)'],
      ['BRL', 2, 'R$', 'Brazilian real'],
      ['BSD', 2, '', 'Bahamian dollar'],
      ['BTN', 2, '', 'Bhutanese ngultrum'],
      ['BWP', 2, '', 'Botswana pula'],
      ['BYN', 2, '', 'Belarusian ruble'],
      ['BZD', 2, '', 'Belize dollar'],
      ['CAD', 2, '$', 'Canadian dollar'],
      ['CDF', 2, '', 'Congolese franc'],
      ['CHE', 2, '', 'WIR Euro (complementary currency)'],
      ['CHF', 2, 'CHF', 'Swiss franc'],
      ['CHW', 2, '', 'WIR Franc (complementary currency)'],
      ['CLF', 4, '', 'Unidad de Fomento (funds code)'],
      ['CLP', 0, '$', 'Chilean peso'],
      ['CNY', 2, '¥', 'Renminbi (Chinese) yuan'],
      ['COP', 2, '$', 'Colombian peso'],
      ['COU', 2, '', 'Unidad de Valor Real (UVR) (funds code)'],
      ['CRC', 2, '₡', 'Costa Rican colon'],
      ['CUC', 2, '', 'Cuban convertible peso'],
      ['CUP', 2, '₱', 'Cuban peso'],
      ['CVE', 0, '', 'Cape Verde escudo'],
      ['CZK', 2, 'Kč', 'Czech koruna'],
      ['DJF', 0, '', 'Djiboutian franc'],
      ['DKK', 2, 'kr', 'Danish krone'],
      ['DOP', 2, 'RD$', 'Dominican peso'],
      ['DZD', 2, '', 'Algerian dinar'],
      ['EGP', 2, '£', 'Egyptian pound'],
      ['ERN', 2, '', 'Eritrean nakfa'],
      ['ETB', 2, '', 'Ethiopian birr'],
      ['EUR', 2, '€', 'Euro'],
      ['FJD', 2, '$', 'Fiji dollar'],
      ['FKP', 2, '£', 'Falkland Islands pound'],
      ['GBP', 2, '£', 'Pound sterling'],
      ['GEL', 2, '', 'Georgian lari'],
      ['GGP', 2, '£', 'Guernsey Pound'],
      ['GHS', 2, '¢', 'Ghanaian cedi'],
      ['GIP', 2, '£', 'Gibraltar pound'],
      ['GMD', 2, '', 'Gambian dalasi'],
      ['GNF', 0, '', 'Guinean franc'],
      ['GTQ', 2, 'Q', 'Guatemalan quetzal'],
      ['GYD', 2, '$', 'Guyanese dollar'],
      ['HKD', 2, '$', 'Hong Kong dollar'],
      ['HNL', 2, 'L', 'Honduran lempira'],
      ['HRK', 2, 'kn', 'Croatian kuna'],
      ['HTG', 2, '', 'Haitian gourde'],
      ['HUF', 2, 'Ft', 'Hungarian forint'],
      ['IDR', 2, 'Rp', 'Indonesian rupiah'],
      ['ILS', 2, '₪', 'Israeli new shekel'],
      ['IMP', 2, '£', 'Isle of Man Pound'],
      ['INR', 2, '', 'Indian rupee'],
      ['IQD', 3, '', 'Iraqi dinar'],
      ['IRR', 2, '﷼', 'Iranian rial'],
      ['ISK', 0, 'kr', 'Icelandic króna'],
      ['JEP', 2, '£', 'Jersey Pound'],
      ['JMD', 2, 'J$', 'Jamaican dollar'],
      ['JOD', 3, '', 'Jordanian dinar'],
      ['JPY', 0, '¥', 'Japanese yen'],
      ['KES', 2, '', 'Kenyan shilling'],
      ['KGS', 2, 'лв', 'Kyrgyzstani som'],
      ['KHR', 2, '៛', 'Cambodian riel'],
      ['KMF', 0, '', 'Comoro franc'],
      ['KPW', 2, '₩', 'North Korean won'],
      ['KRW', 0, '₩', 'South Korean won'],
      ['KWD', 3, '', 'Kuwaiti dinar'],
      ['KYD', 2, '$', 'Cayman Islands dollar'],
      ['KZT', 2, 'лв', 'Kazakhstani tenge'],
      ['LAK', 2, '₭', 'Lao kip'],
      ['LBP', 2, '£', 'Lebanese pound'],
      ['LKR', 2, '₨', 'Sri Lankan rupee'],
      ['LRD', 2, '$', 'Liberian dollar'],
      ['LSL', 2, '', 'Lesotho loti'],
      ['LYD', 3, '', 'Libyan dinar'],
      ['MAD', 2, '', 'Moroccan dirham'],
      ['MDL', 2, '', 'Moldovan leu'],
      ['MGA', 1, '', 'Malagasy ariary'],
      ['MKD', 2, 'ден', 'Macedonian denar'],
      ['MMK', 2, '', 'Myanmar kyat'],
      ['MNT', 2, '₮', 'Mongolian tögrög'],
      ['MOP', 2, '', 'Macanese pataca'],
      ['MRU', 1, '', 'Mauritanian ouguiya'],
      ['MUR', 2, '₨', 'Mauritian rupee'],
      ['MVR', 2, '', 'Maldivian rufiyaa'],
      ['MWK', 2, '', 'Malawian kwacha'],
      ['MXN', 2, '$', 'Mexican peso'],
      ['MXV', 2, '', 'Mexican Unidad de Inversion (UDI) (funds code)'],
      ['MYR', 2, 'RM', 'Malaysian ringgit'],
      ['MZN', 2, 'MT', 'Mozambican metical'],
      ['NAD', 2, '$', 'Namibian dollar'],
      ['NGN', 2, '₦', 'Nigerian naira'],
      ['NIO', 2, 'C$', 'Nicaraguan córdoba'],
      ['NOK', 2, 'kr', 'Norwegian krone'],
      ['NPR', 2, '₨', 'Nepalese rupee'],
      ['NZD', 2, '$', 'New Zealand dollar'],
      ['OMR', 3, '﷼', 'Omani rial'],
      ['PAB', 2, 'B/.', 'Panamanian balboa'],
      ['PEN', 2, 'S/.', 'Peruvian Sol'],
      ['PGK', 2, '', 'Papua New Guinean kina'],
      ['PHP', 2, '₱', 'Philippine piso'],
      ['PKR', 2, '₨', 'Pakistani rupee'],
      ['PLN', 2, 'zł', 'Polish złoty'],
      ['PYG', 0, 'Gs', 'Paraguayan guaraní'],
      ['QAR', 2, '﷼', 'Qatari riyal'],
      ['RON', 2, 'lei', 'Romanian leu'],
      ['RSD', 2, 'Дин.', 'Serbian dinar'],
      ['RUB', 2, '₽', 'Russian ruble'],
      ['RWF', 0, '', 'Rwandan franc'],
      ['SAR', 2, '﷼', 'Saudi riyal'],
      ['SBD', 2, '$', 'Solomon Islands dollar'],
      ['SCR', 2, '₨', 'Seychelles rupee'],
      ['SDG', 2, '', 'Sudanese pound'],
      ['SEK', 2, 'kr', 'Swedish krona/kronor'],
      ['SGD', 2, '$', 'Singapore dollar'],
      ['SHP', 2, '£', 'Saint Helena pound'],
      ['SLL', 2, '', 'Sierra Leonean leone'],
      ['SOS', 2, 'S', 'Somali shilling'],
      ['SRD', 2, '$', 'Surinamese dollar'],
      ['SSP', 2, '', 'South Sudanese pound'],
      ['STN', 2, '', 'São Tomé and Príncipe dobra'],
      ['SVC', 2, '$', 'Salvadoran colón'],
      ['SYP', 2, '£', 'Syrian pound'],
      ['SZL', 2, '', 'Swazi lilangeni'],
      ['THB', 2, '฿', 'Thai baht'],
      ['TJS', 2, '', 'Tajikistani somoni'],
      ['TMT', 2, '', 'Turkmenistan manat'],
      ['TND', 3, '', 'Tunisian dinar'],
      ['TOP', 2, '', 'Tongan paʻanga'],
      ['TRY', 2, '', 'Turkish lira'],
      ['TTD', 2, 'TT$', 'Trinidad and Tobago dollar'],
      ['TVD', 2, '$', 'Tuvalu Dollar'],
      ['TWD', 2, 'NT$', 'New Taiwan dollar'],
      ['TZS', 2, '', 'Tanzanian shilling'],
      ['UAH', 2, '₴', 'Ukrainian hryvnia'],
      ['UGX', 0, '', 'Ugandan shilling'],
      ['USD', 2, '$', 'United States dollar'],
      ['USN', 2, '', 'United States dollar (next day) (funds code)'],
      ['UYI', 0, '$U', 'Uruguay Peso en Unidades Indexadas (URUIURUI) (funds code)'],
      ['UYU', 2, '', 'Uruguayan peso'],
      ['UZS', 2, 'лв', 'Uzbekistan som'],
      ['VEF', 2, 'Bs', 'Venezuelan bolívar'],
      ['VND', 0, '₫', 'Vietnamese đồng'],
      ['VUV', 0, '', 'Vanuatu vatu'],
      ['WST', 2, '', 'Samoan tala'],
      ['XAF', 0, '', 'CFA franc BEAC'],
      ['XAG', -1, '', 'Silver (one troy ounce)'],
      ['XAU', -1, '', 'Gold (one troy ounce)'],
      ['XBA', -1, '', 'European Composite Unit (EURCO) (bond market unit)'],
      ['XBB', -1, '', 'European Monetary Unit (E.M.U.-6) (bond market unit)'],
      ['XBC', -1, '', 'European Unit of Account 9 (E.U.A.-9) (bond market unit)'],
      ['XBD', -1, '', 'European Unit of Account 17 (E.U.A.-17) (bond market unit)'],
      ['XCD', 2, '$', 'East Caribbean dollar'],
      ['XDR', -1, '', 'Special drawing rights'],
      ['XOF', 0, '', 'CFA franc BCEAO'],
      ['XPD', -1, '', 'Palladium (one troy ounce)'],
      ['XPF', 0, '', 'CFP franc (franc Pacifique)'],
      ['XPT', -1, '', 'Platinum (one troy ounce)'],
      ['XSU', -1, '', 'SUCRE'],
      ['XTS', -1, '', 'Code reserved for testing purposes'],
      ['XUA', -1, '', 'ADB Unit of Account'],
      ['XXX', -1, '', 'No currency'],
      ['YER', 2, '﷼', 'Yemeni rial'],
      ['ZAR', 2, 'R', 'South African rand'],
      ['ZMW', 2, '', 'Zambian kwacha'],
      ['ZWL', 2, 'Z$', 'Zimbabwean dollar A/10']
    ];

    // Load concepts into arrays and map
    for (const [code, decimals, symbol, display] of data) {
      const concept = new CurrencyConcept(code, display, decimals, symbol);
      this.codes.push(concept);
      this.codeMap.set(code, concept);
    }
  }
  name() {
    return 'Currencies';
  }

  id() {
    return "currencies";
  }

}

module.exports = {
  Iso4217Services,
  Iso4217FactoryProvider,
  CurrencyConcept,
  CurrencyConceptFilter
};