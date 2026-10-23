const profiles = require('../../ips/profiles');

const L = 'http://loinc.org';
const S = 'http://snomed.info/sct';
const sec = `Bundle.section('${L}', '11450-4', 1, '*').exists()`;
const ent = `Bundle.section('${L}', '10160-0').entry('${S}', '774421004', 1, 1).exists()`;

describe('the two shapes', () => {
  test('are found, and made again the same', () => {
    expect(profiles.parseShape(sec)).toEqual({ section: { system: L, code: '11450-4', min: 1, max: '*' }, entry: null });
    expect(profiles.parseShape(ent)).toEqual({ section: { system: L, code: '10160-0', min: null, max: null }, entry: { system: S, code: '774421004', min: 1, max: 1 } });
    for (const x of [sec, ent]) {
      expect(profiles.shapeExpression(profiles.parseShape(x))).toBe(x);
    }
    // spacing doesn't matter; quotes in strings are escaped both ways
    expect(profiles.parseShape(" Bundle . section ( 'a' ,'b',0,2 ) . exists ( ) ")).toEqual({ section: { system: 'a', code: 'b', min: 0, max: 2 }, entry: null });
    // FHIRPath's escapes, as FHIRPath reads them
    expect(profiles.parseShape("Bundle.section('x', 'A\\u0042\\f\\`\\/').exists()").section.code).toBe('AB\f`/');
    const odd = { section: { system: "it's", code: 'a\\b', min: null, max: null }, entry: null };
    expect(profiles.parseShape(profiles.shapeExpression(odd))).toEqual(odd);
  });

  test('anything else is not one', () => {
    for (const x of [`Composition.section('${L}', '11450-4').exists()`, 'Bundle.section.exists()', `Bundle.section('${L}', '1').count() = 1`, `Bundle.section('${L}', '1', 1).exists()`,
      `Bundle.section('${L}', '1', 2, 1).exists()`, `Bundle.section('', '1').exists()`, `Bundle.section('${L}', '1').entry('${S}', '2').entry('${S}', '3').exists()`,
      `Patient.section('${L}', '1').exists()`, null, 42]) {
      expect(profiles.parseShape(x)).toBeNull();
    }
  });

  test('rules about resources', () => {
    const r = `Bundle.resources('${S}', '38341003', 'Condition').all(clinicalStatus.coding.code = 'active')`;
    expect(profiles.parseResourceShape(r)).toEqual({ type: 'Condition', system: S, code: '38341003', rest: ".all(clinicalStatus.coding.code = 'active')" });
    expect(profiles.resourceShapeExpression(profiles.parseResourceShape(r))).toBe(r);
    expect(profiles.parseResourceShape(`Bundle.resources('${S}', '1').count() = 2`)).toEqual({ type: null, system: S, code: '1', rest: '.count() = 2' });
    // the rest can run over lines
    expect(profiles.parseResourceShape(`Bundle.resources('${S}', '1')\n  .exists()`).rest).toBe('.exists()');
    expect(profiles.resourceShapeExpression({ type: null, system: 'a', code: 'b', rest: 'exists()' })).toBe("Bundle.resources('a', 'b').exists()");
    for (const x of [`Bundle.resources('${S}', '1')`, `Bundle.resources('${S}', '1').`, `Bundle.resources('${S}', '1', 'not a type').exists()`, `Bundle.resources('${S}').exists()`,
      `Bundle.resources('', '1').exists()`, `Composition.resources('${S}', '1').exists()`, `Bundle.resources('${S}', '1') or true`]) {
      expect(profiles.parseResourceShape(x)).toBeNull();
    }
    expect(profiles.kindOf(sec)).toBe('section');
    expect(profiles.kindOf(ent)).toBe('section');
    expect(profiles.kindOf(r)).toBe('resource');
    expect(profiles.kindOf('Bundle.entry.count() > 2')).toBe('other');
  });

  test('entries and resources by value set', () => {
    const V = 'http://hl7.org/fhir/uv/ips/ValueSet/problems-uv-ips';
    const a = `Bundle.section('${L}', '11450-4', 1, '*').entryIn('${V}', 1, '*').exists()`;
    expect(profiles.parseShape(a)).toEqual({ section: { system: L, code: '11450-4', min: 1, max: '*' }, entry: { valueSet: V, min: 1, max: '*' } });
    expect(profiles.shapeExpression(profiles.parseShape(a))).toBe(a);
    expect(profiles.parseShape(`Bundle.section('${L}', '11450-4').entryIn('${V}|1.1.0').exists()`).entry).toEqual({ valueSet: `${V}|1.1.0`, min: null, max: null });
    const b = `Bundle.resourcesIn('${V}', 'Condition').all(clinicalStatus.coding.code = 'active')`;
    expect(profiles.parseResourceShape(b)).toEqual({ type: 'Condition', valueSet: V, rest: ".all(clinicalStatus.coding.code = 'active')" });
    expect(profiles.resourceShapeExpression(profiles.parseResourceShape(b))).toBe(b);
    expect(profiles.kindOf(a)).toBe('section');
    expect(profiles.kindOf(b)).toBe('resource');
    for (const x of [`Bundle.section('${L}', '1').entryIn('not a url').exists()`, `Bundle.section('${L}', '1').entryIn('${V}', 1).exists()`, "Bundle.resourcesIn('nope').exists()", `Bundle.resourcesIn('${V}')`]) {
      expect(profiles.kindOf(x)).toBe('other');
    }
    expect(profiles.expressionProblem(a)).toBeNull();
    expect(profiles.expressionProblem(b)).toBeNull();
    expect(profiles.expressionProblem("Bundle.resourcesIn('nope').exists()")).toMatch(/must be a canonical URL/);
    // descriptions, with a title when one is known
    const titleOf = (url) => (url === V ? 'IPS Problems' : null);
    expect(profiles.describePart(profiles.parseShape(a).entry, false, titleOf)).toEqual({ what: 'IPS Problems', code: V, card: '1..*', valueSet: true });
    expect(profiles.describePart(profiles.parseShape(a).entry, false)).toEqual({ what: V, code: null, card: '1..*', valueSet: true });
    expect(profiles.describeResource(profiles.parseResourceShape(b), titleOf)).toMatchObject({ type: 'Condition', valueSet: V, title: 'IPS Problems' });
  });

  test('cardinalities', () => {
    expect(profiles.parseCard('')).toEqual({ min: null, max: null });
    expect(profiles.parseCard(' 1..* ')).toEqual({ min: 1, max: '*' });
    expect(profiles.parseCard('0..3')).toEqual({ min: 0, max: 3 });
    for (const t of ['1', '2..1', '1..', 'a..b', '-1..2']) {
      expect(profiles.parseCard(t)).toBeNull();
    }
    expect(profiles.cardText({ min: null, max: null })).toBe('');
    expect(profiles.cardText({ min: 1, max: '*' })).toBe('1..*');
  });
});

describe('checking and building', () => {
  test('expressions must parse and run', () => {
    expect(profiles.expressionProblem(sec)).toBeNull();
    expect(profiles.expressionProblem('Bundle.entry.count() > 2')).toBeNull();
    expect(profiles.expressionProblem('')).toBe('has no FHIRPath expression');
    expect(profiles.expressionProblem('Bundle.section(')).toMatch(/can't be used/);
    expect(profiles.expressionProblem('Bundle.nonsense()')).toMatch(/Not implemented: nonsense/);
    expect(profiles.expressionProblem('x'.repeat(3000))).toMatch(/longer than/);
    expect(profiles.expressionProblem(`Bundle.resources('${S}', '1', 'Condition').exists()`)).toBeNull();
    // fhirpath.js only warns about the wrong number of arguments: that is caught
    expect(profiles.expressionProblem(`Bundle.resources('${S}').exists()`)).toMatch(/resources\(\) has the wrong number of arguments \(1\)/);
    expect(profiles.expressionProblem(`Bundle.section('${L}', '1', 1).exists()`)).toMatch(/section\(\) has the wrong number of arguments \(3\)/);
    expect(profiles.expressionProblem(`Bundle.resources('${S}', '1', 'not a type').exists()`)).toMatch(/type must be a resource type/);
  });

  test('names come from titles', () => {
    expect(profiles.nameFromTitle('Cardiology referral (v2)')).toBe('CardiologyReferralV2');
    expect(profiles.nameFromTitle('2nd opinion')).toBe('Profile2ndOpinion');
    expect(profiles.nameFromTitle('Résumé médical')).toBe('ResumeMedical');
  });

  test('input is checked, and keys kept or given', () => {
    const first = profiles.checkInput({ title: ' Referral ', constraints: [{ human: 'Problems', expression: sec }, { human: 'Meds', expression: ent }] });
    expect(first.problems).toEqual([]);
    expect(first.title).toBe('Referral');
    expect(first.constraints.map(c => c.key)).toEqual(['cp-1', 'cp-2']);
    const sd = profiles.build({ id: 'abcdef012345', url: 'http://x/ips/StructureDefinition/profile-abcdef012345', title: first.title, constraints: first.constraints, date: '2026-10-22' });
    expect(sd).toMatchObject({ resourceType: 'StructureDefinition', id: 'profile-abcdef012345', name: 'Referral', title: 'Referral', type: 'Bundle', derivation: 'constraint', baseDefinition: profiles.BUNDLE });
    expect(sd.differential.element).toEqual([{ id: 'Bundle', path: 'Bundle', constraint: [
      { key: 'cp-1', severity: 'error', human: 'Problems', expression: sec, source: sd.url },
      { key: 'cp-2', severity: 'error', human: 'Meds', expression: ent, source: sd.url }] }]);
    // an edit: cp-2 kept, cp-1 dropped, a new one is cp-3 (keys are never reused), an unknown key is replaced
    const second = profiles.checkInput({ title: 'Referral', constraints: [{ key: 'cp-2', human: 'Meds', expression: ent }, { human: 'New', expression: sec }, { key: 'cp-99', human: 'x', expression: sec }] }, sd);
    expect(second.constraints.map(c => c.key)).toEqual(['cp-2', 'cp-3', 'cp-4']);
    // a key twice: the second gets a new one
    expect(profiles.checkInput({ title: 'T', constraints: [{ key: 'cp-1', human: 'a', expression: sec }, { key: 'cp-1', human: 'b', expression: sec }] }, sd).constraints.map(c => c.key)).toEqual(['cp-1', 'cp-3']);
    const bad = profiles.checkInput({ title: '', constraints: [{ human: '', expression: 'Composition.(' }, 'x'] });
    expect(bad.problems).toEqual(['The profile needs a title', 'Constraint 1 has no description', expect.stringMatching(/^Constraint 1 has a FHIRPath expression that can't be used/), 'Constraint 2 is not an object']);
  });
});

describe('uploads', () => {
  const made = () => profiles.build({ id: 'abcdef012345', url: 'http://x/sd', title: 'Referral', constraints: [{ key: 'cp-7', human: 'Problems', expression: sec }] });

  test('what the server makes comes back in, without its keys', () => {
    expect(profiles.fromUpload(made())).toEqual({ input: { title: 'Referral', constraints: [{ human: 'Problems', expression: sec }] }, problems: [] });
    // the name is used when there is no title
    const sd = made();
    delete sd.title;
    expect(profiles.fromUpload(sd).input.title).toBe('Referral');
  });

  test('anything more is rejected', () => {
    const cases = [
      [sd => { sd.snapshot = { element: [] }; }, /more than a clinical profile can hold: snapshot/],
      [sd => { sd.type = 'Patient'; }, /must be a profile on Bundle/],
      [sd => { sd.baseDefinition = 'http://hl7.org/fhir/uv/ips/StructureDefinition/Composition-uv-ips'; }, /must be a profile on Bundle/],
      [sd => { sd.differential.element.push({ path: 'Bundle.entry' }); }, /just one element, the root/],
      [sd => { sd.differential.element[0].path = 'Bundle.entry'; }, /just one element, the root/],
      [sd => { sd.differential.element[0].min = 1; }, /root element has more than constraints: min/],
      [sd => { sd.differential.element[0].constraint[0].xpath = 'x'; }, /more than a key, description and expression: xpath/],
      [sd => { sd.differential.element[0].constraint[0].severity = 'warning'; }, /is not an error/],
      [sd => { delete sd.differential; }, /just one element, the root/]
    ];
    for (const [change, message] of cases) {
      const sd = made();
      change(sd);
      expect(profiles.fromUpload(sd).problems.join('; ')).toMatch(message);
    }
    expect(profiles.fromUpload({ resourceType: 'ValueSet' }).problems).toEqual(['That is not a StructureDefinition']);
    expect(profiles.fromUpload('nonsense').problems).toEqual(['That is not a StructureDefinition']);
  });
});

describe('profiles that were on Composition', () => {
  const old = () => ({
    resourceType: 'StructureDefinition', id: 'profile-abcdef012345', url: 'http://x/ips/StructureDefinition/profile-abcdef012345', name: 'Referral', title: 'Referral',
    status: 'active', date: '2026-10-22T00:00:00Z', fhirVersion: '4.0.1', kind: 'resource', abstract: false, type: 'Composition',
    baseDefinition: 'http://hl7.org/fhir/StructureDefinition/Composition', derivation: 'constraint',
    differential: { element: [{ id: 'Composition', path: 'Composition', constraint: [
      { key: 'cp-1', severity: 'error', human: 'Problems', expression: `Composition.section('${L}', '11450-4', 1, '*').exists()` },
      { key: 'cp-3', severity: 'error', human: 'Sections', expression: 'Composition.section.count() >= 3' },
      { key: 'cp-4', severity: 'error', human: 'Hypertension', expression: `Bundle.resources('${S}', '38341003').exists()` }] }] }
  });

  test('are moved onto Bundle, keeping their id, url and keys', () => {
    const sd = profiles.migrate(old());
    expect(sd).toMatchObject({ id: 'profile-abcdef012345', url: 'http://x/ips/StructureDefinition/profile-abcdef012345', type: 'Bundle', baseDefinition: profiles.BUNDLE, date: '2026-10-22T00:00:00Z' });
    expect(sd.differential.element[0].constraint.map(c => [c.key, c.expression])).toEqual([
      ['cp-1', `Bundle.section('${L}', '11450-4', 1, '*').exists()`],
      ['cp-3', 'Bundle.entry.resource.ofType(Composition).section.count() >= 3'],
      ['cp-4', `Bundle.resources('${S}', '38341003').exists()`]]);
    expect(profiles.migrate(sd)).toBeNull();
  });

  test('every Composition in an expression is moved, and nothing in a string', () => {
    const moved = (expression) => profiles.migrate({ ...old(), differential: { element: [{ id: 'Composition', path: 'Composition', constraint: [{ key: 'cp-1', severity: 'error', human: 'h', expression }] }] } })
      .differential.element[0].constraint[0].expression;
    expect(moved(`Composition.section('${L}', '11450-4').exists() and Composition.date.exists()`)).toBe(`Bundle.section('${L}', '11450-4').exists() and Bundle.entry.resource.ofType(Composition).date.exists()`);
    expect(moved("Composition.title = 'Composition.x'")).toBe("Bundle.entry.resource.ofType(Composition).title = 'Composition.x'");
    expect(moved(`(Composition.section('${L}', '1').exists()) or Composition . status = 'final'`)).toBe(`(Bundle.section('${L}', '1').exists()) or Bundle.entry.resource.ofType(Composition).status = 'final'`);
    for (const same of ['entry.resource.ofType(Composition).exists()', 'MyComposition.x', 'x.Composition.y', "Bundle.resources('a', 'b').exists()"]) {
      expect(moved(same)).toBe(same);
    }
  });

  test('can still be uploaded, and are moved the same way', () => {
    const up = profiles.fromUpload(old());
    expect(up.problems).toEqual([]);
    expect(up.input.constraints.map(c => c.expression)).toEqual([`Bundle.section('${L}', '11450-4', 1, '*').exists()`, 'Bundle.entry.resource.ofType(Composition).section.count() >= 3', `Bundle.resources('${S}', '38341003').exists()`]);
  });
});

describe('the rules mean what they say on a document', () => {
  const { evaluate } = require('../../ips/fhirpath-ips');
  const doc = { resourceType: 'Bundle', type: 'document', entry: [
    { fullUrl: 'urn:uuid:c', resource: { resourceType: 'Composition', section: [{ code: { coding: [{ system: L, code: '11450-4' }] }, entry: [{ reference: 'urn:uuid:p' }] }] } },
    { fullUrl: 'urn:uuid:p', resource: { resourceType: 'Condition', code: { coding: [{ system: S, code: '38341003' }] } } }] };
  test.each([
    [`Bundle.section('${L}', '11450-4', 1, 1).exists()`, true],
    [`Bundle.section('${L}', '11450-4').entry('${S}', '38341003', 1, '*').exists()`, true],
    [`Bundle.section('${L}', '10160-0').exists()`, false],
    [`Bundle.resources('${S}', '38341003', 'Condition').exists()`, true],
    ['Bundle.entry.resource.ofType(Composition).section.count() >= 1', true]
  ])('%s', (expression, expected) => {
    expect(evaluate(doc, expression)).toEqual([expected]);
  });
});
