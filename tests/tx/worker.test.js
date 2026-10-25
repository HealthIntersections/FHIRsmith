const { TerminologyWorker, TerminologySetupError } = require('../../tx/workers/worker');
const { OperationContext } = require('../../tx/operation-context');
const {CodeSystem} = require("../../tx/library/codesystem");
const ValueSet = require("../../tx/library/valueset");
const {TestUtilities} = require("../test-utilities");

// Mock classes for testing
class MockProvider {
  // eslint-disable-next-line no-unused-vars
  async getCodeSystemProvider(url, version, params, nullOk) {
    return null; // Override in specific tests
  }

  // eslint-disable-next-line no-unused-vars
  async listCodeSystemVersions(url) {
    return []; // Override in specific tests
  }

  loadSupplements() {
    return [];
  }
}

class MockLanguageDefinitions {
  constructor() {
    this.languages = new Map();
  }
}

class MockI18nSupport {
  // eslint-disable-next-line no-unused-vars
  formatMessage(languages, messageId, parameters = []) {
    return messageId;
  }
}

class MockLogger {

}

// Concrete test implementation of TerminologyWorker
class TestTerminologyWorker extends TerminologyWorker {
  constructor(opContext, logger, provider, languages, i18n) {
    super(opContext, logger, provider, languages, i18n);
    this._vsHandle = null;
  }

  opName() {
    return 'test-operation';
  }

  vsHandle() {
    return this._vsHandle;
  }

  setVsHandle(vs) {
    this._vsHandle = vs;
  }

  async createCodeSystemProvider(codeSystem) {
    return {
      systemUri: codeSystem.url,
      version: codeSystem.version,
      name: () => codeSystem.name
    };
  }
}

describe('TerminologyWorker', () => {
  let mockOpContext;
  let mockProvider;
  let mockLanguages;
  let mockI18n;
  let worker;
  let mockLogger;

  beforeEach(async () => {
    mockOpContext = new OperationContext('en-US', await TestUtilities.loadTranslations(),'test-123');
    mockProvider = new MockProvider();
    mockLanguages = new MockLanguageDefinitions();
    mockI18n = new MockI18nSupport();
    mockLogger = new MockLogger();

    worker = new TestTerminologyWorker(
      mockOpContext,
      mockLogger,
      mockProvider,
      mockLanguages,
      mockI18n
    );
  });

  describe('constructor', () => {
    test('should initialize all properties', () => {
      expect(worker.opContext).toBe(mockOpContext);
      expect(worker.provider).toBe(mockProvider);
      expect(worker.additionalResources).toEqual([]);
      expect(worker.languages).toBe(mockLanguages);
      expect(worker.i18n).toBe(mockI18n);
      expect(worker.noCacheThisOne).toBe(false);
      expect(worker.params).toBe(null);
    });
  });

  describe('opName', () => {
    test('should return test operation name', () => {
      expect(worker.opName()).toBe('test-operation');
    });
  });

  describe('deadCheck', () => {
    test('should call opContext.deadCheck', () => {
      const spy = jest.spyOn(mockOpContext, 'deadCheck').mockImplementation(() => {});

      worker.deadCheck('test-location');

      expect(spy).toHaveBeenCalledWith('test-location');
    });

    test('should use default location if not provided', () => {
      const spy = jest.spyOn(mockOpContext, 'deadCheck').mockImplementation(() => {});

      worker.deadCheck();

      expect(spy).toHaveBeenCalledWith('unknown');
    });
  });

  describe('findInAdditionalResources', () => {
    test('should return null when no additional resources', () => {
      const result = worker.findInAdditionalResources('http://test.com', '', 'CodeSystem');
      expect(result).toBeNull();
    });

    test('should find resource by URL', () => {
      const mockCodeSystem = new CodeSystem({
        resourceType: 'CodeSystem',
        url: 'http://test.com',
        version: '1.0.0',
        name: 'TestCS',
        status: 'active'
      });

      worker.additionalResources = [mockCodeSystem];

      const result = worker.findInAdditionalResources('http://test.com', '', 'CodeSystem');
      expect(result).toBe(mockCodeSystem);
    });

    test('should find resource by URL and version', () => {
      const mockCodeSystem1 = new CodeSystem({
        resourceType: 'CodeSystem',
        url: 'http://test.com',
        version: '1.0.0',
        name: 'TestCS',
        status: 'active'
      });

      const mockCodeSystem2 = new CodeSystem({
        resourceType: 'CodeSystem',
        url: 'http://test.com',
        version: '2.0.0',
        name: 'TestCS',
        status: 'active'
      });

      worker.additionalResources = [mockCodeSystem1, mockCodeSystem2];

      const result = worker.findInAdditionalResources('http://test.com', '1.0.0', 'CodeSystem');
      expect(result).toBe(mockCodeSystem1);
    });

    test('should return latest version when no version specified', () => {
      const mockCodeSystem1 = new CodeSystem({
        resourceType: 'CodeSystem',
        url: 'http://test.com',
        version: '1.0.0',
        name: 'TestCS',
        status: 'active'
      });

      const mockCodeSystem2 = new CodeSystem({
        resourceType: 'CodeSystem',
        url: 'http://test.com',
        version: '2.0.0',
        name: 'TestCS',
        status: 'active'
      });

      worker.additionalResources = [mockCodeSystem1, mockCodeSystem2];

      const result = worker.findInAdditionalResources('http://test.com', '', 'CodeSystem');
      expect(result).toBe(mockCodeSystem2);
    });

    test('should throw error for wrong resource type', () => {
      const mockValueSet = new ValueSet({
        resourceType: 'ValueSet',
        url: 'http://test.com',
        version: '1.0.0',
        name: 'TestVS',
        status: 'active'
      });

      worker.additionalResources = [mockValueSet];

      expect(() => {
        worker.findInAdditionalResources('http://test.com', '', 'CodeSystem', true);
      }).toThrow('Attempt to reference http://test.com as a CodeSystem when it\'s a ValueSet');
    });

    test('should return null for wrong resource type when error=false', () => {
      const mockValueSet = new ValueSet({
        resourceType: 'ValueSet',
        url: 'http://test.com',
        version: '1.0.0',
        name: 'TestVS',
        status: 'active'
      });

      worker.additionalResources = [mockValueSet];

      const result = worker.findInAdditionalResources('http://test.com', '', 'CodeSystem', false);
      expect(result).toBeNull();
    });
  });

  describe('loadSupplements', () => {
    test('should return empty array when no additional resources', () => {
      const supplements = worker.loadSupplements('http://test.com');
      expect(supplements).toEqual([]);
    });

    test('should find supplements by exact URL match', () => {
      const mainCS = new CodeSystem({
        resourceType: 'CodeSystem',
        url: 'http://main.com',
        version: '1.0.0',
        name: 'MainCS',
        status: 'active'
      });

      const supplementCS = new CodeSystem({
        resourceType: 'CodeSystem',
        url: 'http://supplement.com',
        version: '1.0.0',
        name: 'SupplementCS',
        status: 'active',
        supplements: 'http://main.com',
        extension : [{url: 'http://hl7.org/fhir/StructureDefinition/codesystem-supplement-type', valueCode: "global-lang-pack"}]
      });

      worker.additionalResources = [mainCS, supplementCS];

      const supplements = worker.loadSupplements('http://main.com');
      expect(supplements).toEqual([supplementCS]);
    });

    test('should find supplements by URL with version prefix', () => {
      const supplementCS = new CodeSystem({
        resourceType: 'CodeSystem',
        url: 'http://supplement.com',
        version: '1.0.0',
        name: 'SupplementCS',
        status: 'active',
        supplements: 'http://main.com|1.0.0',
        extension : [{url: 'http://hl7.org/fhir/StructureDefinition/codesystem-supplement-type', valueCode: "lang-pack"}]
      });

      worker.additionalResources = [supplementCS];

      const supplements = worker.loadSupplements('http://main.com');
      expect(supplements).toEqual([supplementCS]);
    });

    test('should ignore non-CodeSystem resources', () => {
      const valueSet = new ValueSet({
        resourceType: 'ValueSet',
        url: 'http://vs.com',
        version: '1.0.0',
        name: 'TestVS',
        status: 'active'
      });

      worker.additionalResources = [valueSet];

      const supplements = worker.loadSupplements('http://main.com');
      expect(supplements).toEqual([]);
    });
  });

  describe('listVersions', () => {
    test('should collect versions from additional resources', async () => {
      const cs1 = new CodeSystem({
        resourceType: 'CodeSystem',
        url: 'http://test.com',
        version: '1.0.0',
        name: 'TestCS',
        status: 'active'
      });

      const cs2 = new CodeSystem({
        resourceType: 'CodeSystem',
        url: 'http://test.com',
        version: '2.0.0',
        name: 'TestCS',
        status: 'active'
      });

      worker.additionalResources = [cs1, cs2];

      // Mock provider to return additional versions
      mockProvider.listCodeSystemVersions = jest.fn().mockResolvedValue(['3.0.0']);

      const versions = await worker.listVersions('http://test.com');
      expect(versions).toEqual(['1.0.0', '2.0.0', '3.0.0']);
    });

    test('should handle empty additional resources', async () => {
      mockProvider.listCodeSystemVersions = jest.fn().mockResolvedValue(['1.0.0']);

      const versions = await worker.listVersions('http://test.com');
      expect(versions).toEqual(['1.0.0']);
    });
  });

  describe('renderCoded static method', () => {
    test('should render system only', () => {
      const result = worker.displayCoded('http://test.com');
      expect(result).toBe('http://test.com');
    });

    test('should render system with version', () => {
      const result = worker.displayCoded('http://test.com', '1.0.0');
      expect(result).toBe('http://test.com|1.0.0');
    });

    test('should render system, version, and code', () => {
      const result = worker.displayCoded('http://test.com', '1.0.0', 'CODE123');
      expect(result).toBe('http://test.com|1.0.0#CODE123');
    });

    test('should render full coding with display', () => {
      const result = worker.displayCoded('http://test.com', '1.0.0', 'CODE123', 'Test Display');
      expect(result).toBe('http://test.com|1.0.0#CODE123 ("Test Display")');
    });

    test('should render coding object', () => {
      const coding = {
        system: 'http://test.com',
        version: '1.0.0',
        code: 'CODE123',
        display: 'Test Display'
      };

      const result = worker.displayCoded(coding);
      expect(result).toBe('http://test.com|1.0.0#CODE123 ("Test Display")');
    });
  });
});

describe('CodeSystem', () => {
  test('should provide metadata properties', () => {
    const cs = new CodeSystem({
      resourceType: 'CodeSystem',
      url: 'http://test.com',
      version: '1.0.0',
      name: 'TestCS',
      status: 'active'
    });

    expect(cs.url).toBe('http://test.com');
    expect(cs.version).toBe('1.0.0');
    expect(cs.name).toBe('TestCS');
    expect(cs.status).toBe('active');
    expect(cs.resourceType).toBe('CodeSystem');
    expect(cs.versionedUrl).toBe('http://test.com|1.0.0');
    expect(cs.fhirType).toBe('CodeSystem');
  });
});

describe('ValueSet', () => {
  test('should provide metadata properties', () => {
    const vs = new ValueSet({
      resourceType: 'ValueSet',
      url: 'http://test.com',
      version: '1.0.0',
      name: 'TestVS',
      status: 'active'
    });

    expect(vs.url).toBe('http://test.com');
    expect(vs.version).toBe('1.0.0');
    expect(vs.name).toBe('TestVS');
    expect(vs.status).toBe('active');
    expect(vs.resourceType).toBe('ValueSet');
    expect(vs.versionedUrl).toBe('http://test.com|1.0.0');
    expect(vs.fhirType).toBe('ValueSet');
  });
});

describe('Error classes', () => {
  test('TerminologySetupError should be instance of Error', () => {
    const error = new TerminologySetupError('Test message');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('TerminologySetupError');
    expect(error.message).toBe('Test message');
  });
});