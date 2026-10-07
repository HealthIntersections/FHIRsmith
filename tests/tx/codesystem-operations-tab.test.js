/**
 * The Operations tab on a CodeSystem, and the two forms on it that expand something.
 *
 * The tab used to be called "LookUp / Subsumes", which named its contents rather than what
 * it is, and had to be renamed every time an operation was added to it. It is now
 * "Operations", and it carries a text search and a filter builder as well.
 *
 * Neither of those submits to an operation on the code system, because there is no such
 * operation: both are expansion of a value set that composes the code system. So both
 * build that value set in the browser - anonymous, uuid url, a single include - and post
 * it to ValueSet/$expand. They differ in where the user's input goes: a text search puts
 * nothing on the include and sends the text as the filter parameter on the request, while
 * the filter builder puts the rows on the include, in one filter array so they are ANDed.
 * The two halves that have to agree are pinned here: the forms must carry the system and
 * version of the code system being viewed, and $expand must accept both value sets and
 * answer a browser in HTML.
 *
 * The property input on the filter builder is a free text input with a datalist, not a
 * select: a code system can define filters this server has never heard of, and the user
 * must still be able to type them. The datalist is a set of suggestions - the names the
 * base specification defines, the ones known for that particular code system, and whatever
 * the resource declares.
 */

const request = require('supertest');
const { getTestApp, shutdownTestApp } = require('./setup');

const OPS_TAB = '/tx/r5/CodeSystem/administrative-gender?_format=html/ops';

// ValueSet.compose.include.filter.op in R5. All of them are offered: which ones a given
// code system actually supports is the server's business at expansion time, not the form's.
const FILTER_OPS = ['=', 'is-a', 'descendent-of', 'is-not-a', 'regex', 'in', 'not-in',
  'generalizes', 'child-of', 'descendent-leaf', 'exists'];

let app;
let html;

beforeAll(async () => {
  app = await getTestApp();
  const response = await request(app).get(OPS_TAB).set('Accept', 'text/html');
  expect(response.status).toBe(200);
  html = response.text;
}, 60000);

afterAll(async () => {
  await shutdownTestApp();
});

describe('CodeSystem Operations tab', () => {
  test('the tab is called Operations', () => {
    expect(html).toContain('>Operations</a>');
    expect(html).not.toContain('LookUp / Subsumes');
  });

  test('the text search comes first, and posts to $expand', () => {
    expect(html.indexOf('Text Search')).toBeLessThan(html.indexOf('<strong>Lookup</strong>'));
    const form = html.substring(html.indexOf('Text Search'));
    expect(form).toContain('/tx/r5/ValueSet/$expand?_format=html');
    expect(form).toContain('data-system="http://hl7.org/fhir/administrative-gender"');
    expect(form.substring(0, form.indexOf('</form>'))).toContain('name="filter"');
  });

  test('lookup and subsumes are still there', () => {
    expect(html).toContain('action="$lookup"');
    expect(html).toContain('action="$subsumes"');
  });

  test('the filter form posts to $expand and carries the code system it was opened on', () => {
    expect(html).toContain('/tx/r5/ValueSet/$expand?_format=html');
    expect(html).toContain('data-system="http://hl7.org/fhir/administrative-gender"');
    expect(html).toMatch(/data-version="[^"]+"/);
  });

  test('every R5 filter operation is offered', () => {
    const select = html.substring(html.indexOf('<select name="op">'));
    for (const op of FILTER_OPS) {
      expect(select).toContain(`<option value="${op}">`);
    }
  });

  test('the property input suggests the base filter names, and can still be typed into', () => {
    const datalist = html.substring(html.indexOf('<datalist'), html.indexOf('</datalist>'));
    for (const name of ['code', 'designation', 'concept', 'status', 'inactive', 'regex']) {
      expect(datalist).toContain(`<option value="${name}">`);
    }
    expect(html).toMatch(/<input type="text" name="property" list="[^"]+"/);
  });
});

describe('the value set the filter form builds', () => {
  // What the browser posts: no url to look up, no id, just the composed value set. If this
  // stops being accepted, the forms silently stop working.
  test('is expanded, and answered in HTML for a browser', async () => {
    const response = await request(app)
      .post('/tx/r5/ValueSet/$expand?_format=html')
      .set('Content-Type', 'application/json')
      .set('Accept', 'text/html')
      .send({
        resourceType: 'ValueSet',
        url: 'urn:uuid:1fd1f0f2-5e2d-4a1c-8b23-9b5ba4f4f5cb',
        status: 'active',
        compose: {
          include: [{
            system: 'http://hl7.org/fhir/administrative-gender',
            filter: [{ property: 'concept', op: 'is-a', value: 'female' }]
          }]
        }
      });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.text).toContain('<html');
  });

  // The text search: the whole code system on the include, the text on the request. The
  // filter parameter has to survive on the query string, because the body is taken up by
  // the value set.
  test('searches the text when the whole code system is composed and filter is on the query', async () => {
    const response = await request(app)
      .post('/tx/r5/ValueSet/$expand?filter=female')
      .set('Content-Type', 'application/json')
      .set('Accept', 'application/json')
      .send({
        resourceType: 'ValueSet',
        url: 'urn:uuid:8b0e2a54-4f6f-4e0a-9d2c-6d9e0c6d8f21',
        status: 'active',
        compose: { include: [{ system: 'http://hl7.org/fhir/administrative-gender' }] }
      });

    expect(response.status).toBe(200);
    expect((response.body.expansion.contains || []).map((c) => c.code)).toEqual(['female']);
  });
});
