/**
 * A JSON response is serialised once. The res.json wrapper in tx.js builds the JSON string (to
 * check it and log its size), and sends that string; it used to call Express's res.json(data)
 * after that, which serialised the whole resource a second time.
 */
const express = require('express');
const request = require('supertest');
const { getTestApp, shutdownTestApp } = require('./setup');

describe('JSON responses', () => {
  let app;
  beforeAll(async () => { app = await getTestApp(); }, 60000);
  afterAll(async () => { await shutdownTestApp(); });

  test('are sent from the string already built, with the same body and headers', async () => {
    const expressJson = jest.spyOn(express.response, 'json');
    try {
      const res = await request(app)
        .get('/tx/r5/CodeSystem/$lookup?system=http://hl7.org/fhir/administrative-gender&code=male')
        .set('Accept', 'application/fhir+json');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/fhir+json; charset=utf-8');
      expect(res.body.resourceType).toBe('Parameters');
      expect(res.text).toBe(JSON.stringify(res.body)); // compact, as res.json gave it
      // the wrapper replaces res.json on the response; Express's own is no longer called
      expect(expressJson).not.toHaveBeenCalled();
    } finally {
      expressJson.mockRestore();
    }
  });
});
