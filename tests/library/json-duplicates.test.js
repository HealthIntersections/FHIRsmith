//
// Copyright 2026, Health Intersections Pty Ltd (http://www.healthintersections.com.au)
//
// Licensed under BSD-3: https://opensource.org/license/bsd-3-clause
//

// Duplicate properties in a JSON body as OperationOutcome issues, like the Java validator's (with the message for refusing them)

const { duplicateIssues, duplicatesOutcome, MESSAGE_ID } = require('../../library/json-duplicates');

const PATIENT = `{
  "resourceType" : "Patient",
  "id" : "pat-good",
  "active" : false,
  "active" : true
}`;

describe('json-duplicates', () => {
  test('none', () => {
    expect(duplicateIssues('{"a":{"b":1},"c":{"b":2}}')).toEqual([]);
    expect(duplicatesOutcome('{"a":1}')).toBeNull();
  });

  test('the message, with where it is', () => {
    const [issue] = duplicateIssues(PATIENT, { resourceType: 'Patient' });
    expect(issue.severity).toBe('error');
    expect(issue.code).toBe('invalid');
    expect(MESSAGE_ID).toBe('DUPLICATE_JSON_PROPERTY_REJECTED');
    expect(issue.details.text).toBe("The JSON property 'active' is a duplicate, so the content can't be accepted");
    expect(issue.expression).toEqual(['Patient']);
    const ext = Object.fromEntries(issue.extension.map(e => [e.url.split('/').pop(), e.valueInteger ?? e.valueString]));
    expect(ext).toEqual({ 'operationoutcome-issue-line': 5, 'operationoutcome-issue-col': 3, 'operationoutcome-message-id': MESSAGE_ID });
  });

  test('nested, and without a resourceType', () => {
    const text = '{"entry":[{},{"resource":{"a":1,"b":{"x":1,"x":2},"a":3}}]}';
    const issues = duplicateIssues(text, { resourceType: 'Bundle' });
    expect(issues.map(i => i.expression[0])).toEqual(['Bundle.entry[1].resource.b', 'Bundle.entry[1].resource']);
    expect(duplicateIssues('{"a":1,"a":2}')[0].expression).toEqual(['$this']);
  });

  test('in the request\'s language, English when there is no translation', () => {
    const text = (lang) => duplicateIssues(PATIENT, { acceptLanguage: lang })[0].details.text;
    expect(text('de')).toBe("Die JSON-Eigenschaft 'active' ist ein Duplikat, daher kann der Inhalt nicht akzeptiert werden");
    expect(text('nl-BE, en;q=0.5')).toBe("De JSON property 'active' is een duplicaat, dus de inhoud kan niet worden geaccepteerd");
    expect(text('fr')).toBe("The JSON property 'active' is a duplicate, so the content can't be accepted");
    expect(text('%%%')).toBe("The JSON property 'active' is a duplicate, so the content can't be accepted");
  });
});
