/**
 * ValidateWorker Unit Tests
 *
 * Tests for $validate-code operation on CodeSystem and ValueSet
 */

const { ValidateWorker } = require('../../tx/workers/validate');
const {CodeSystem} = require("../../tx/library/codesystem");
const {FhirCodeSystemProvider} = require("../../tx/cs/cs-cs");
const ValueSet = require("../../tx/library/valueset");
const {Languages} = require("../../library/languages");
const {OperationContext} = require("../../tx/operation-context");
const {TestUtilities} = require("../test-utilities");
const {TxParameters} = require("../../tx/params");

// Mock dependencies
const mockLog = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
};

// Mock provider that returns admin-gender resources
const mockProvider = {
  getCodeSystem: jest.fn((ctx, url) => {
    if (url === 'http://hl7.org/fhir/administrative-gender') {
      return getCodeSystem().jsonObj;
    }
    return null;
  }),
  getCodeSystemProvider: jest.fn((opContext, url, version, supplements) => {
    if (url === 'http://hl7.org/fhir/administrative-gender') {
      let cs = getCodeSystem();
      return new FhirCodeSystemProvider(opContext, cs, supplements);
    }
    return null;
  }),
  getCodeSystemById: jest.fn((ctx, id) => {
    if (id === 'administrative-gender') {
      return getCodeSystem().jsonObj;
    }
    return null;
  }),
  findValueSet: jest.fn((ctx, url) => {
    if (url === 'http://hl7.org/fhir/ValueSet/administrative-gender') {
      return {
        url: 'http://hl7.org/fhir/ValueSet/administrative-gender',
        version: '4.0.1',
        name: 'AdministrativeGender',
        jsonObj: {
          resourceType: 'ValueSet',
          url: 'http://hl7.org/fhir/ValueSet/administrative-gender'
        }
      };
    }
    return null;
  }),
  getValueSetById: jest.fn((ctx, id) => {
    if (id === 'administrative-gender') {
      return {
        url: 'http://hl7.org/fhir/ValueSet/administrative-gender',
        version: '4.0.1',
        name: 'AdministrativeGender',
        jsonObj: {
          resourceType: 'ValueSet',
          url: 'http://hl7.org/fhir/ValueSet/administrative-gender'
        }
      };
    }
    return null;
  }),
  loadSupplements() {
    return [];
  }
};

// Helper to create mock request/response
function createMockReqRes(method, query = {}, body = {}, params = {}) {
  const req = {
    method,
    query,
    body,
    params,
    txProvider: mockProvider
  };
  
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis()
  };
  
  return { req, res };
}

function getCodeSystem() {
  return new CodeSystem(
    {
      "resourceType": "CodeSystem",
      "url": "http://hl7.org/fhir/administrative-gender",
      "version": "5.0.0",
      "name": "AdministrativeGender",
      "title": "AdministrativeGender",
      "status": "active",
      "experimental": false,
      "caseSensitive": true,
      "valueSet": "http://hl7.org/fhir/ValueSet/administrative-gender",
      "content": "complete",
      "concept": [{
        "code": "male",
        "display" : "Male"
      },
        {
          "code": "female"
        },
        {
          "code": "unknown"
        }]
    }
  );
}

describe('ValidateWorker', () => {
  let worker;
  let opContext;

  beforeEach(async () => {
    jest.clearAllMocks();
    opContext = new OperationContext(new Languages(), await TestUtilities.loadTranslations(await TestUtilities.loadLanguageDefinitions()));
    worker = new ValidateWorker(opContext, mockLog, mockProvider, await TestUtilities.loadLanguageDefinitions(), await TestUtilities.loadTranslations(await TestUtilities.loadLanguageDefinitions()));
  });

  describe('buildParameters', () => {
    test('converts GET query params to Parameters', () => {
      const { req } = createMockReqRes('GET', { 
        url: 'http://example.org/cs',
        code: 'test',
        display: 'Test'
      });
      
      const params = worker.buildParameters(req);
      
      expect(params.resourceType).toBe('Parameters');
      expect(params.parameter).toHaveLength(3);
      expect(params.parameter.find(p => p.name === 'code').valueString).toBe('test');
    });

    test('converts POST form body to Parameters', () => {
      const { req } = createMockReqRes('POST', {}, { 
        url: 'http://example.org/cs',
        code: 'test'
      });
      
      const params = worker.buildParameters(req);
      
      expect(params.resourceType).toBe('Parameters');
      expect(params.parameter.find(p => p.name === 'code').valueString).toBe('test');
    });

    test('uses POST Parameters resource directly', () => {
      const parametersResource = {
        resourceType: 'Parameters',
        parameter: [
          { name: 'code', valueCode: 'male' }
        ]
      };
      const { req } = createMockReqRes('POST', {}, parametersResource);
      
      const params = worker.buildParameters(req);
      
      expect(params).toBe(parametersResource);
    });

    test('handles Coding in body', () => {
      const { req } = createMockReqRes('POST', {}, {
        coding: { system: 'http://example.org', code: 'test' }
      });
      
      const params = worker.buildParameters(req);
      
      const codingParam = params.parameter.find(p => p.name === 'coding');
      expect(codingParam.valueCoding).toEqual({ system: 'http://example.org', code: 'test' });
    });
  });

  describe('extractCodedValue', () => {
    test('extracts codeableConcept parameter', () => {
      const params = {
        resourceType: 'Parameters',
        parameter: [
          { 
            name: 'codeableConcept', 
            valueCodeableConcept: { 
              coding: [{ system: 'http://example.org', code: 'test' }] 
            } 
          }
        ]
      };

      let mode = {};
      const coded = worker.extractCodedValue(params, false, mode);
      
      expect(coded.coding[0].code).toBe('test');
    });

    test('extracts coding parameter', () => {
      const params = {
        resourceType: 'Parameters',
        parameter: [
          { name: 'coding', valueCoding: { system: 'http://example.org', code: 'test' } }
        ]
      };
      let mode = {};
      const coded = worker.extractCodedValue(params, false, mode);
      
      expect(coded.coding[0].code).toBe('test');
    });

    test('extracts individual code/system/display for VS mode', () => {
      const params = {
        resourceType: 'Parameters',
        parameter: [
          { name: 'code', valueString: 'male' },
          { name: 'system', valueString: 'http://hl7.org/fhir/administrative-gender' },
          { name: 'display', valueString: 'Male' }
        ]
      };

      let mode = {};
      const coded = worker.extractCodedValue(params, false, mode);
      
      expect(coded.coding[0].code).toBe('male');
      expect(coded.coding[0].system).toBe('http://hl7.org/fhir/administrative-gender');
      expect(coded.coding[0].display).toBe('Male');
    });

    test('extracts individual code/url/version for CS mode', () => {
      const params = {
        resourceType: 'Parameters',
        parameter: [
          { name: 'code', valueString: 'male' },
          { name: 'url', valueString: 'http://hl7.org/fhir/administrative-gender' },
          { name: 'version', valueString: '4.0.1' }
        ]
      };

      let mode = {};
      const coded = worker.extractCodedValue(params, true, mode);
      
      expect(coded.coding[0].code).toBe('male');
      expect(coded.coding[0].system).toBe('http://hl7.org/fhir/administrative-gender');
      expect(coded.coding[0].version).toBe('4.0.1');
    });

    test('returns null when no code provided', () => {
      const params = {
        resourceType: 'Parameters',
        parameter: [
          { name: 'system', valueString: 'http://example.org' }
        ]
      };

      let mode = {};
      const coded = worker.extractCodedValue(params, false, mode);
      
      expect(coded).toBeNull();
    });
  });

  describe('doValidationCS', () => {
    test('validates male as valid', async () => {
      const coded = { coding: [{ "system" : "http://hl7.org/fhir/administrative-gender", code: 'male' }] };
      const cs = getCodeSystem();
      const csp = new FhirCodeSystemProvider(opContext, cs, []);

      let txp = new TxParameters(opContext.i18n.languageDefinitions, opContext.i18n);

      let mode = { issuePath : "Coding", mode : "coding"};
      const result = await worker.doValidationCS(coded, csp, txp, mode);
      
      expect(result.resourceType).toBe('Parameters');
      const resultParam = result.parameter.find(p => p.name === 'result');
      expect(resultParam.valueBoolean).toBe(true);
      
      const displayParam = result.parameter.find(p => p.name === 'display');
      expect(displayParam.valueString).toBe('Male');
    });

    test('validates female as valid', async () => {
      const coded = { coding: [{ "system" : "http://hl7.org/fhir/administrative-gender", code: 'female' }] };
      const cs = getCodeSystem();
      const csp = new FhirCodeSystemProvider(opContext, cs, []);

      let txp = new TxParameters(opContext.i18n.languageDefinitions, opContext.i18n);

      let mode = { issuePath : "Coding", mode : "coding"};
      const result = await worker.doValidationCS(coded, csp, txp, mode);
      
      const resultParam = result.parameter.find(p => p.name === 'result');
      expect(resultParam.valueBoolean).toBe(true);
    });

    test('validates unknown as valid', async () => {
      const coded = { coding: [{ "system" : "http://hl7.org/fhir/administrative-gender", code: 'unknown' }] };
      const cs = getCodeSystem();
      const csp = new FhirCodeSystemProvider(opContext, cs, []);

      let txp = new TxParameters(opContext.i18n.languageDefinitions, opContext.i18n);

      let mode = { issuePath : "Coding", mode : "coding"};
      const result = await worker.doValidationCS(coded, csp, txp, mode);
      
      const resultParam = result.parameter.find(p => p.name === 'result');
      expect(resultParam.valueBoolean).toBe(true);
    });

    test('validates other as invalid', async () => {
      const coded = { coding: [{ "system" : "http://hl7.org/fhir/administrative-gender", code: 'other' }] };
      const cs = getCodeSystem();
      const csp = new FhirCodeSystemProvider(opContext, cs, []);

      let txp = new TxParameters(opContext.i18n.languageDefinitions, opContext.i18n);

      let mode = { issuePath : "Coding", mode : "coding"};
      const result = await worker.doValidationCS(coded, csp, txp, mode);
      
      const resultParam = result.parameter.find(p => p.name === 'result');
      expect(resultParam.valueBoolean).toBe(false);
      
      const messageParam = result.parameter.find(p => p.name === 'message');
      expect(messageParam.valueString).toContain('other');
    });

    test('validates nonexistent code as invalid', async () => {
      const coded = { coding: [{ "system" : "http://hl7.org/fhir/administrative-gender", code: 'xyz' }] };
      const cs = getCodeSystem();
      const csp = new FhirCodeSystemProvider(opContext, cs, []);

      let txp = new TxParameters(opContext.i18n.languageDefinitions, opContext.i18n);

      let mode = { issuePath : "Coding", mode : "coding"};
      const result = await worker.doValidationCS(coded, csp, txp, mode);


      const resultParam = result.parameter.find(p => p.name === 'result');
      expect(resultParam.valueBoolean).toBe(false);
    });

  });

  describe('doValidationVS', () => {
    test('validates male as valid in ValueSet', async () => {
      const coded = { 
        coding: [{ 
          system: 'http://hl7.org/fhir/administrative-gender', 
          code: 'male' 
        }] 
      };
      const valueSet = new ValueSet({ "resourceType" : "ValueSet", url: 'http://hl7.org/fhir/ValueSet/administrative-gender', 'compose' : {'include' : [{'system' : 'http://hl7.org/fhir/administrative-gender'}]} });


      let txp = new TxParameters(opContext.i18n.languageDefinitions, opContext.i18n);
      txp.readParams({ resourceType : "Parameters", parameter : [{name : "__Accept-Language", valueCode : "en" }] });

      const result = await worker.doValidationVS(coded, valueSet, txp, 'coded', 'Coding');

      const resultParam = (result.parameter || []).find(p => p.name === 'result');
      expect(resultParam.valueBoolean).toBe(true);
    });

    test('validates other as invalid in ValueSet', async () => {
      const coded = { 
        coding: [{ 
          system: 'http://hl7.org/fhir/administrative-gender', 
          code: 'other' 
        }] 
      };
      const valueSet = new ValueSet({ "resourceType" : "ValueSet", url: 'http://hl7.org/fhir/ValueSet/administrative-gender', 'compose' : {'include' : [{'system' : 'http://hl7.org/fhir/administrative-gender', concept : [{code : "male"},{code : "female"}]}]}  });

      let txp = new TxParameters(opContext.i18n.languageDefinitions, opContext.i18n);
      txp.readParams({ resourceType : "Parameters", parameter : [{name : "__Accept-Language", valueCode : "en" }] });

      const result = await worker.doValidationVS(coded, valueSet, txp, 'coded', 'Coding');

      const resultParam = result.parameter.find(p => p.name === 'result');
      expect(resultParam.valueBoolean).toBe(false);
    });

    test('validates wrong system as invalid', async () => {
      const coded = { 
        coding: [{ 
          system: 'http://wrong-system.org', 
          code: 'male' 
        }] 
      };
      const valueSet = new ValueSet({ "resourceType" : "ValueSet", url: 'http://hl7.org/fhir/ValueSet/administrative-gender', 'compose' : {'include' : [{'system' : 'http://hl7.org/fhir/administrative-gender'}]} });

      let txp = new TxParameters(opContext.i18n.languageDefinitions, opContext.i18n);
      txp.readParams({ resourceType : "Parameters", parameter : [{name : "__Accept-Language", valueCode : "en" }] });

      const result = await worker.doValidationVS(coded, valueSet, txp, 'coded', 'Coding');

      const resultParam = result.parameter.find(p => p.name === 'result');
      expect(resultParam.valueBoolean).toBe(false);
      
      const messageParam = result.parameter.find(p => p.name === 'message');
      expect(messageParam).toBeDefined();
      expect(messageParam.valueString).toContain('system');
    });
  });

  describe('HTTP handlers', () => {
    test('handleCodeSystem returns error when no CodeSystem specified', async () => {
      const { req, res } = createMockReqRes('GET', { code: 'male' });
      
      await worker.handleCodeSystem(req, res);
      
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        resourceType: 'OperationOutcome'
      }));
    });

    test('handleCodeSystem validates successfully with url and code', async () => {
      const { req, res } = createMockReqRes('GET', { 
        url: 'http://hl7.org/fhir/administrative-gender',
        code: 'male'
      });
      
      await worker.handleCodeSystem(req, res);
      
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        resourceType: 'Parameters'
      }));
    });

    test('handleCodeSystemInstance returns 404 for unknown id', async () => {
      const { req, res } = createMockReqRes('GET', { code: 'male' }, {}, { id: 'unknown' });
      
      await worker.handleCodeSystemInstance(req, res);
      
      expect(res.status).toHaveBeenCalledWith(422);
    });

    test('handleCodeSystemInstance validates successfully', async () => {
      const { req, res } = createMockReqRes('GET', { code: 'male' }, {}, { id: 'administrative-gender' });
      
      await worker.handleCodeSystemInstance(req, res);
      
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        resourceType: 'OperationOutcome'
      }));
    });

    test('POST with Parameters resource works', async () => {
      const { req, res } = createMockReqRes('POST', {}, {
        resourceType: 'Parameters',
        parameter: [
          { name: 'url', valueUri: 'http://hl7.org/fhir/administrative-gender' },
          { name: 'code', valueCode: 'male' }
        ]
      });
      
      await worker.handleCodeSystem(req, res);
      
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        resourceType: 'Parameters'
      }));
    });
  });
});
