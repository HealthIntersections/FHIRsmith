/**
 * Cache-id parameter extraction tests
 *
 * Regression guard for the bug where the cache-id protocol was silently disabled
 * because getParameterValue() did not understand the `valueId` element. fhir-core
 * sends cache-id as an IdType, i.e. {"name":"cache-id","valueId":"..."}, so if
 * getParameterValue() omits valueId it returns null, cacheId becomes null, and the
 * server never caches or resolves anything by reference -- every by-reference
 * validation then fails with "value set ... could not be found".
 *
 * These are pure unit tests against the parameter helpers on TerminologyWorker;
 * they do not need a running server.
 */

const { TerminologyWorker } = require('../../tx/workers/worker');
const { OperationContext } = require('../../tx/operation-context');
const { TestUtilities } = require('../test-utilities');

class MockProvider {
  loadSupplements() { return []; }
}

class TestWorker extends TerminologyWorker {
  opName() { return 'test'; }
  vsHandle() { return null; }
}

describe('cache-id parameter extraction', () => {
  let worker;

  beforeEach(async () => {
    const opContext = new OperationContext('en-US', await TestUtilities.loadTranslations(), 'test-123');
    worker = new TestWorker(opContext, { info: () => {} }, new MockProvider(), {}, { });
  });

  describe('getParameterValue - primitive value[x] types', () => {
    // The one that actually broke production: cache-id arrives as valueId.
    test('reads valueId (the real cache-id wire format from fhir-core)', () => {
      const param = { name: 'cache-id', valueId: '25180033-f4f5-41e8-8880-6f5252da0dd2' };
      expect(worker.getParameterValue(param)).toBe('25180033-f4f5-41e8-8880-6f5252da0dd2');
    });

    test.each([
      ['valueString', 'hello'],
      ['valueCode', 'active'],
      ['valueId', 'abc-123'],
      ['valueUri', 'http://example.org/x'],
      ['valueCanonical', 'http://example.org/x|1.0.0'],
      ['valueUrl', 'http://example.org/x'],
      ['valueBoolean', true],
      ['valueInteger', 42],
      ['valueDecimal', 3.14],
      ['valueDateTime', '2026-01-01T00:00:00Z'],
    ])('reads %s', (type, value) => {
      expect(worker.getParameterValue({ name: 'p', [type]: value })).toBe(value);
    });

    test('reads valueBoolean=false (must not be treated as missing)', () => {
      expect(worker.getParameterValue({ name: 'p', valueBoolean: false })).toBe(false);
    });

    test('reads resource over value[x] when both present', () => {
      const res = { resourceType: 'ValueSet', url: 'http://x' };
      expect(worker.getParameterValue({ name: 'p', resource: res })).toBe(res);
    });

    test('returns null for a parameter with no value', () => {
      expect(worker.getParameterValue({ name: 'p' })).toBeNull();
    });

    test('returns null for null/undefined param', () => {
      expect(worker.getParameterValue(null)).toBeNull();
      expect(worker.getParameterValue(undefined)).toBeNull();
    });
  });

  describe('findParameter + getParameterValue together (the cache-id read path)', () => {
    function params(...parameter) {
      return { resourceType: 'Parameters', parameter };
    }

    test('cache-id as valueId is found and read (the regression)', () => {
      const p = params(
        { name: 'code', valueCode: 'application/pdf' },
        { name: 'cache-id', valueId: 'cid-1' }
      );
      const found = worker.findParameter(p, 'cache-id');
      expect(found).not.toBeNull();
      expect(worker.getParameterValue(found)).toBe('cid-1');
    });

    test('cache-id as valueString is also found and read', () => {
      const p = params({ name: 'cache-id', valueString: 'cid-2' });
      expect(worker.getParameterValue(worker.findParameter(p, 'cache-id'))).toBe('cid-2');
    });

    test('missing cache-id yields null (no false cache-id)', () => {
      const p = params({ name: 'code', valueCode: 'x' });
      const found = worker.findParameter(p, 'cache-id');
      expect(found).toBeNull();
    });
  });
});
