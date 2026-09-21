/**
 * The /ecl route, and the fragment format it is built on.
 *
 * _format=html/fragment returns the rendering with no page around it, so a page can run an
 * operation and put the result inside itself. The ECL panel is the reason it exists: the
 * expression stays where it was typed and each result lands underneath. An error uses the
 * same path - it comes back as the rendered OperationOutcome rather than as something the
 * caller has to recognise and handle - so the message appears next to the expression that
 * caused it.
 *
 * The test endpoint loads R5 core and no SNOMED, which is worth having: the panel has to
 * say so rather than offer an empty dropdown.
 */

const request = require('supertest');
const { getTestApp, shutdownTestApp } = require('./setup');

const BASE = '/tx/r5';

const TRANSIENT = 'http://healthintersections.com.au/fhirsmith/StructureDefinition/valueset-transient';

function valueSet(include) {
  return {
    resourceType: 'ValueSet',
    extension: [{ url: TRANSIENT, valueBoolean: true }],
    url: 'urn:uuid:3b1b7e22-3a1b-4a3e-9a6c-9f8f4a1d2c30',
    status: 'active',
    compose: { include: [include] }
  };
}

let app;

beforeAll(async () => {
  app = await getTestApp();
}, 60000);

afterAll(async () => {
  await shutdownTestApp();
});

describe('GET /ecl', () => {
  test('is a page, and is linked from the endpoint navigation', async () => {
    const response = await request(app).get(BASE + '/ecl').set('Accept', 'text/html');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.text).toContain('<html');
    expect(response.text).toContain(BASE + '/ecl');
  });

  test('says there is nothing to run against when no SNOMED edition is loaded', async () => {
    const response = await request(app).get(BASE + '/ecl').set('Accept', 'text/html');
    expect(response.text).toContain('no SNOMED CT editions loaded');
    expect(response.text).not.toContain('<select name="version"');
  });
});

describe('_format=html/fragment', () => {
  test('returns the rendering with no page around it', async () => {
    const response = await request(app)
      .post(BASE + '/ValueSet/$expand?_format=html/fragment&includeDefinition=true')
      .set('Content-Type', 'application/json')
      .set('Accept', 'text/html')
      .send(valueSet({ system: 'http://hl7.org/fhir/administrative-gender' }));

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.text).not.toContain('<html');
    expect(response.text).not.toContain('FHIRsmith');
    expect(response.text).toContain('female');
    // and none of the preamble - the page asking the question already shows all of it
    const shown = response.text.substring(0, response.text.indexOf('Show JSON Source'));
    expect(shown).not.toContain('built for this request alone');
    expect(shown).not.toContain('Expansion Properties');
  });

  test('brings an error back the same way, as the rendered outcome', async () => {
    const response = await request(app)
      .post(BASE + '/ValueSet/$expand?_format=html/fragment&includeDefinition=true')
      .set('Content-Type', 'application/json')
      .set('Accept', 'text/html')
      .send(valueSet({
        system: 'http://example.org/no-such-code-system',
        filter: [{ property: 'constraint', op: '=', value: '< 404684003' }]
      }));

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.text).not.toContain('<html');
    expect(response.text).toContain('alert-danger');
  });

  test('still wraps the page for a plain html request', async () => {
    const response = await request(app)
      .post(BASE + '/ValueSet/$expand?_format=html&includeDefinition=true')
      .set('Content-Type', 'application/json')
      .set('Accept', 'text/html')
      .send(valueSet({ system: 'http://hl7.org/fhir/administrative-gender' }));

    expect(response.status).toBe(200);
    expect(response.text).toContain('<html');
  });
});
