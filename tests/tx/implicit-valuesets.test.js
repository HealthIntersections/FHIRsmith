// Which loaded version an implicit value set url is drawn from (S10): the generic form from
// the default version, the edition form from the latest version of that edition, the version
// form from that version - whatever order the versions were registered in.
const { chooseImplicitValueSetFactory } = require('../../tx/library/implicit-valuesets');

// A stand-in for a SNOMED CT factory: recognises the three forms for its edition and version
function edition(editionId, date) {
  const version = `http://snomed.info/sct/${editionId}/version/${date}`;
  return {
    label: `${editionId}/${date}`,
    system: () => 'http://snomed.info/sct',
    version: () => version,
    implicitValueSetForm(url) {
      const q = url.indexOf('?fhir_vs');
      if (q === -1) return null;
      const base = url.substring(0, q);
      if (base === 'http://snomed.info/sct') return { form: 'generic' };
      if (base === `http://snomed.info/sct/${editionId}`) return { form: 'edition' };
      if (base === version) return { form: 'version' };
      return null;
    }
  };
}

describe('choosing the version for an implicit value set', () => {
  const intl = edition('900000000000207008', '20260701');
  const us2023 = edition('731000124108', '20230301');
  const us2025 = edition('731000124108', '20250901');
  const us2024 = edition('731000124108', '20240301');
  const other = { system: () => 'http://loinc.org', version: () => '2.83' }; // no implicitValueSetForm

  // registered out of date order, and each factory under more than one key, as the library does
  const registered = [us2024, us2025, other, intl, us2023, us2024, intl];
  const choose = (url, defaultFactory = intl) => chooseImplicitValueSetFactory(registered, () => defaultFactory, url);

  test('the generic form comes from the default version', () => {
    expect(choose('http://snomed.info/sct?fhir_vs=isa/73211009')).toBe(intl);
    expect(choose('http://snomed.info/sct?fhir_vs', us2023)).toBe(us2023);
  });

  test('the edition form comes from the latest version of that edition', () => {
    expect(choose('http://snomed.info/sct/731000124108?fhir_vs=isa/73211009')).toBe(us2025);
    expect(choose('http://snomed.info/sct/900000000000207008?fhir_vs')).toBe(intl);
  });

  test('the version form comes from that version only', () => {
    expect(choose('http://snomed.info/sct/731000124108/version/20230301?fhir_vs=isa/73211009')).toBe(us2023);
    expect(choose('http://snomed.info/sct/731000124108/version/20240301?fhir_vs')).toBe(us2024);
  });

  test('the generic form follows the version the request asks for (system-version and the like)', () => {
    const asked = (v) => () => v;
    const url = 'http://snomed.info/sct?fhir_vs=isa/73211009';
    expect(chooseImplicitValueSetFactory(registered, () => intl, url, asked('http://snomed.info/sct/731000124108/version/20240301'))).toBe(us2024);
    // an edition with no version: the latest version of it
    expect(chooseImplicitValueSetFactory(registered, () => intl, url, asked('http://snomed.info/sct/731000124108'))).toBe(us2025);
    // a version that is not loaded: the default, and building the value set reports what is missing
    expect(chooseImplicitValueSetFactory(registered, () => intl, url, asked('http://snomed.info/sct/83821000000107'))).toBe(intl);
    expect(chooseImplicitValueSetFactory(registered, () => intl, url, asked(null))).toBe(intl);
  });

  test('the requested version does not override an edition or version named in the url', () => {
    const askedIntl = () => 'http://snomed.info/sct/900000000000207008';
    expect(chooseImplicitValueSetFactory(registered, () => intl, 'http://snomed.info/sct/731000124108?fhir_vs', askedIntl)).toBe(us2025);
    expect(chooseImplicitValueSetFactory(registered, () => intl, 'http://snomed.info/sct/731000124108/version/20230301?fhir_vs', askedIntl)).toBe(us2023);
  });

  test('an edition or version that is not loaded, or a url that is not an implicit value set, chooses nothing', () => {
    expect(choose('http://snomed.info/sct/83821000000107?fhir_vs')).toBeNull();
    expect(choose('http://snomed.info/sct/731000124108/version/20990101?fhir_vs')).toBeNull();
    expect(choose('http://hl7.org/fhir/ValueSet/example')).toBeNull();
  });
});

describe('TxParameters.requestedSystemVersion', () => {
  const { TxParameters } = require('../../tx/params');
  const { TestUtilities } = require('../test-utilities');
  let langDefs;
  let i18n;
  beforeAll(async () => {
    langDefs = await TestUtilities.loadLanguageDefinitions();
    i18n = await TestUtilities.loadTranslations(langDefs);
  });
  const params = () => new TxParameters(langDefs, i18n, false);
  const SCT = 'http://snomed.info/sct';

  test('force-system-version wins over system-version, which wins over check-system-version', () => {
    const p = params();
    p.seeVersionRule(SCT + '|http://snomed.info/sct/731000124108', false, 'check');
    expect(p.requestedSystemVersion(SCT)).toBe('http://snomed.info/sct/731000124108');
    p.seeVersionRule(SCT + '|http://snomed.info/sct/900000000000207008', false, 'default');
    expect(p.requestedSystemVersion(SCT)).toBe('http://snomed.info/sct/900000000000207008');
    p.seeVersionRule(SCT + '|http://snomed.info/sct/83821000000107', false, 'override');
    expect(p.requestedSystemVersion(SCT)).toBe('http://snomed.info/sct/83821000000107');
  });

  test('none asked for, another system, or a value set version rule: null', () => {
    const p = params();
    expect(p.requestedSystemVersion(SCT)).toBeNull();
    p.seeVersionRule('http://loinc.org|2.83', false, 'default');
    p.seeVersionRule(SCT + '|20250901', true, 'default'); // default-valueset-version
    expect(p.requestedSystemVersion(SCT)).toBeNull();
  });
});
