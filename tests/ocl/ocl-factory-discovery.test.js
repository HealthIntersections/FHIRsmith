'use strict';

const { OCLCodeSystemProvider, OCLSourceCodeSystemFactory } = require('../../tx/ocl/cs-ocl');
const { Provider } = require('../../tx/provider');
const { TestUtilities } = require('../test-utilities');

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeHttpClient() {
  return { get: jest.fn().mockRejectedValue(new Error('not mocked')) };
}

function makeFactoryMeta(overrides = {}) {
  const canonicalUrl = overrides.canonicalUrl ?? 'https://example.org/fhir/CodeSystem/TestSource';
  return {
    canonicalUrl,
    version: 'HEAD',
    id: 'TestSource',
    shortCode: 'TestSource',
    owner: 'TestOrg',
    name: 'TestSource',
    description: null,
    conceptsUrl: '/orgs/TestOrg/sources/TestSource/concepts/',
    checksum: 'abc123',
    codeSystem: {
      jsonObj: { content: 'not-present', url: canonicalUrl }
    },
    ...overrides
  };
}

/** Create a minimal Provider-like instance ready for updateCodeSystemList calls */
function makeProvider(extraFactories = new Map(), mockChanges = {}) {
  const provider = new Provider();
  provider.codeSystemFactories = new Map(extraFactories);
  provider.codeSystems = new Map();
  provider.codeSystemProviders = [{
    getCodeSystemChanges: jest.fn().mockResolvedValue({
      added: [],
      changed: [],
      deleted: [],
      ...mockChanges
    })
  }];
  provider.fhirVersion = '4.0.0';
  provider.context = null;
  return provider;
}

// ─── test setup / teardown ────────────────────────────────────────────────────

let i18n;

beforeAll(async () => {
  i18n = await TestUtilities.loadTranslations();
});

afterEach(() => {
  // Limpa o mapa estático de factories para isolar os testes
  OCLSourceCodeSystemFactory.factoriesByKey.clear();
  jest.restoreAllMocks();
});

// ─── OCLSourceCodeSystemFactory.createForDiscoveredSource ────────────────────

describe('OCLSourceCodeSystemFactory.createForDiscoveredSource', () => {
  it('retorna null antes de qualquer factory ser construída (sem #sharedI18n)', () => {
    // Módulo isolado garante que #sharedI18n começa como null
    let resultado;
    jest.isolateModules(() => {
      const { OCLSourceCodeSystemFactory: Fresh } = require('../../tx/ocl/cs-ocl');
      resultado = Fresh.createForDiscoveredSource(makeHttpClient(), makeFactoryMeta());
    });
    expect(resultado).toBeNull();
  });

  it('retorna uma instância de OCLSourceCodeSystemFactory após #sharedI18n ser inicializado', () => {
    // Primeira construção inicializa #sharedI18n
    new OCLSourceCodeSystemFactory(i18n, makeHttpClient(), makeFactoryMeta({ canonicalUrl: 'https://example.org/CodeSystem/Init' }));

    const meta = makeFactoryMeta({ canonicalUrl: 'https://example.org/CodeSystem/Discovered' });
    const factory = OCLSourceCodeSystemFactory.createForDiscoveredSource(makeHttpClient(), meta);

    expect(factory).not.toBeNull();
    expect(factory).toBeInstanceOf(OCLSourceCodeSystemFactory);
  });

  it('factory criada tem o system URL correto do meta', () => {
    new OCLSourceCodeSystemFactory(i18n, makeHttpClient(), makeFactoryMeta({ canonicalUrl: 'https://example.org/CodeSystem/Init2' }));

    const canonicalUrl = 'https://mangara.hsl.org.br/fhir/CodeSystem/LocationColposcopia';
    const factory = OCLSourceCodeSystemFactory.createForDiscoveredSource(
      makeHttpClient(),
      makeFactoryMeta({ canonicalUrl })
    );

    expect(factory.system()).toBe(canonicalUrl);
  });

  it('factory criada tem a versão correta do meta', () => {
    new OCLSourceCodeSystemFactory(i18n, makeHttpClient(), makeFactoryMeta({ canonicalUrl: 'https://example.org/CodeSystem/Init3' }));

    const factory = OCLSourceCodeSystemFactory.createForDiscoveredSource(
      makeHttpClient(),
      makeFactoryMeta({ canonicalUrl: 'https://example.org/CodeSystem/VersionTest', version: '2.0.0' })
    );

    expect(factory.version()).toBe('2.0.0');
  });
});

// ─── Auto-registro em factoriesByKey ─────────────────────────────────────────

describe('OCLSourceCodeSystemFactory - auto-registro em factoriesByKey', () => {
  it('nova factory via construtor registra-se automaticamente em factoriesByKey', () => {
    const canonicalUrl = 'https://example.org/CodeSystem/AutoReg';
    expect(OCLSourceCodeSystemFactory.hasFactory(canonicalUrl)).toBe(false);

    new OCLSourceCodeSystemFactory(i18n, makeHttpClient(), makeFactoryMeta({ canonicalUrl }));

    expect(OCLSourceCodeSystemFactory.hasFactory(canonicalUrl)).toBe(true);
  });

  it('factory criada via createForDiscoveredSource também se registra em factoriesByKey', () => {
    new OCLSourceCodeSystemFactory(i18n, makeHttpClient(), makeFactoryMeta({ canonicalUrl: 'https://example.org/CodeSystem/InitDisc' }));

    const canonicalUrl = 'https://example.org/CodeSystem/DiscoveryReg';
    expect(OCLSourceCodeSystemFactory.hasFactory(canonicalUrl)).toBe(false);

    OCLSourceCodeSystemFactory.createForDiscoveredSource(makeHttpClient(), makeFactoryMeta({ canonicalUrl }));

    expect(OCLSourceCodeSystemFactory.hasFactory(canonicalUrl)).toBe(true);
  });

  it('não cria duplicatas no factoriesByKey quando a mesma URL é usada', () => {
    new OCLSourceCodeSystemFactory(i18n, makeHttpClient(), makeFactoryMeta({ canonicalUrl: 'https://example.org/CodeSystem/InitDup' }));

    const canonicalUrl = 'https://example.org/CodeSystem/Duplicate';
    OCLSourceCodeSystemFactory.createForDiscoveredSource(makeHttpClient(), makeFactoryMeta({ canonicalUrl }));

    const beforeSize = OCLSourceCodeSystemFactory.factoriesByKey.size;

    // Segunda chamada com mesma URL - já existe
    OCLSourceCodeSystemFactory.createForDiscoveredSource(makeHttpClient(), makeFactoryMeta({ canonicalUrl }));

    expect(OCLSourceCodeSystemFactory.factoriesByKey.size).toBe(beforeSize);
  });
});

// ─── patchProviderForOCLFactorySync via updateCodeSystemList ─────────────────

describe('patchProviderForOCLFactorySync — sincronização de factories', () => {
  it('factory recém-adicionada em factoriesByKey é sincronizada para provider.codeSystemFactories', async () => {
    new OCLSourceCodeSystemFactory(i18n, makeHttpClient(), makeFactoryMeta({ canonicalUrl: 'https://example.org/CodeSystem/InitSync' }));

    const canonicalUrl = 'https://example.org/CodeSystem/NewInRefresh';
    OCLSourceCodeSystemFactory.createForDiscoveredSource(makeHttpClient(), makeFactoryMeta({ canonicalUrl }));

    const provider = makeProvider();
    expect(provider.codeSystemFactories.has(canonicalUrl)).toBe(false);

    await provider.updateCodeSystemList();

    expect(provider.codeSystemFactories.has(canonicalUrl)).toBe(true);
  });

  it('factory já registrada em codeSystemFactories não é re-adicionada', async () => {
    const initFactory = new OCLSourceCodeSystemFactory(i18n, makeHttpClient(), makeFactoryMeta({ canonicalUrl: 'https://example.org/CodeSystem/InitNoRe' }));

    const canonicalUrl = 'https://example.org/CodeSystem/AlreadyThere';
    const factory = OCLSourceCodeSystemFactory.createForDiscoveredSource(
      makeHttpClient(),
      makeFactoryMeta({ canonicalUrl })
    );

    // Pre-register all factories that exist in factoriesByKey so none are "new"
    const initUrl = 'https://example.org/CodeSystem/InitNoRe';
    const provider = makeProvider(new Map([
      [initUrl, initFactory],
      [`${initUrl}|HEAD`, initFactory],
      [canonicalUrl, factory],
      [`${canonicalUrl}|HEAD`, factory]
    ]));

    const sizeBefore = provider.codeSystemFactories.size;
    await provider.updateCodeSystemList();

    expect(provider.codeSystemFactories.size).toBe(sizeBefore);
  });

  it('múltiplas factories novas são todas sincronizadas', async () => {
    new OCLSourceCodeSystemFactory(i18n, makeHttpClient(), makeFactoryMeta({ canonicalUrl: 'https://example.org/CodeSystem/InitMulti' }));

    const urls = [
      'https://example.org/CodeSystem/Multi1',
      'https://example.org/CodeSystem/Multi2',
      'https://example.org/CodeSystem/Multi3'
    ];

    for (const canonicalUrl of urls) {
      OCLSourceCodeSystemFactory.createForDiscoveredSource(makeHttpClient(), makeFactoryMeta({ canonicalUrl }));
    }

    const provider = makeProvider();
    await provider.updateCodeSystemList();

    for (const canonicalUrl of urls) {
      expect(provider.codeSystemFactories.has(canonicalUrl)).toBe(true);
    }
  });

  it('updateCodeSystemList sem factories OCL novas não altera codeSystemFactories', async () => {
    // Nenhuma factory no factoriesByKey
    const provider = makeProvider();
    const sizeBefore = provider.codeSystemFactories.size;

    await provider.updateCodeSystemList();

    expect(provider.codeSystemFactories.size).toBe(sizeBefore);
  });
});

// ─── Ciclo de refresh do OCLCodeSystemProvider ────────────────────────────────

describe('OCLCodeSystemProvider — criação de factory no ciclo de refresh', () => {
  it('chama createForDiscoveredSource para source novo em changes.added', async () => {
    // Garante #sharedI18n inicializado
    new OCLSourceCodeSystemFactory(i18n, makeHttpClient(), makeFactoryMeta({ canonicalUrl: 'https://example.org/CodeSystem/InitRef' }));

    const spy = jest.spyOn(OCLSourceCodeSystemFactory, 'createForDiscoveredSource');

    const canonicalUrl = 'https://mangara.hsl.org.br/fhir/CodeSystem/NewSource';
    const mockSource = {
      id: 'NewSource',
      short_code: 'NewSource',
      owner: 'HSL',
      owner_type: 'Organization',
      public_access: 'View',
      url: '/orgs/HSL/sources/NewSource/',
      concepts_url: '/orgs/HSL/sources/NewSource/concepts/',
      canonical_url: canonicalUrl,
      version: 'HEAD',
      checksums: { standard: 'c1', smart: 'c2' },
      updated_at: '2026-05-19T00:00:00Z'
    };

    const oclProvider = new OCLCodeSystemProvider({ baseUrl: 'https://oclapi2.example.org', org: 'HSL' });
    oclProvider.httpClient = {
      get: jest.fn().mockImplementation((url) => {
        // /orgs/ → lista de organizações
        if (/\/orgs\/$/.test(url)) {
          return Promise.resolve({ data: [{ id: 'HSL', url: '/orgs/HSL/', type: 'Organization' }] });
        }
        // /orgs/HSL/ → detalhes da org (não usado na descoberta de sources)
        if (/\/orgs\/HSL\/$/.test(url) && !url.includes('/sources')) {
          return Promise.resolve({ data: { id: 'HSL' } });
        }
        // sources da org
        if (url.includes('/sources/') && !url.includes('/concepts/')) {
          return Promise.resolve({ data: { results: [mockSource], num_found: 1, num_returned: 1 } });
        }
        return Promise.resolve({ data: [] });
      })
    };

    // Inicializa (sem sources na snapshot inicial — simula state vazio)
    await oclProvider.initialize();

    // Remove o source da snapshot para que o próximo refresh o detecte como novo
    oclProvider._sourceStateByCanonical.clear();
    oclProvider._codeSystemsByCanonical.clear();

    // Dispara o refresh e aguarda conclusão
    oclProvider.getCodeSystemChanges('4.0.0', null);
    await new Promise(resolve => setTimeout(resolve, 200));

    // Verifica que createForDiscoveredSource foi chamado para o novo source
    const callArgs = spy.mock.calls.find(([, meta]) => meta?.canonicalUrl === canonicalUrl);
    expect(callArgs).toBeTruthy();
  });

  it('não chama createForDiscoveredSource para source já existente com factory', async () => {
    new OCLSourceCodeSystemFactory(i18n, makeHttpClient(), makeFactoryMeta({ canonicalUrl: 'https://example.org/CodeSystem/InitExist' }));

    const canonicalUrl = 'https://example.org/CodeSystem/ExistingSource';
    // Pre-cria factory para este source
    OCLSourceCodeSystemFactory.createForDiscoveredSource(makeHttpClient(), makeFactoryMeta({ canonicalUrl }));

    const spy = jest.spyOn(OCLSourceCodeSystemFactory, 'createForDiscoveredSource');

    const mockSource = {
      id: 'ExistingSource',
      short_code: 'ExistingSource',
      owner: 'TestOrg',
      public_access: 'View',
      url: '/orgs/TestOrg/sources/ExistingSource/',
      canonical_url: canonicalUrl,
      version: 'HEAD',
      checksums: { standard: 'x', smart: 'y' },
      updated_at: '2026-05-19T00:00:00Z'
    };

    const oclProvider = new OCLCodeSystemProvider({ baseUrl: 'https://oclapi2.example.org', org: 'TestOrg' });
    oclProvider.httpClient = {
      get: jest.fn().mockImplementation((url) => {
        if (/\/orgs\/$/.test(url)) {
          return Promise.resolve({ data: [{ id: 'TestOrg', url: '/orgs/TestOrg/', type: 'Organization' }] });
        }
        if (url.includes('/sources/')) {
          return Promise.resolve({ data: { results: [mockSource], num_found: 1, num_returned: 1 } });
        }
        return Promise.resolve({ data: [] });
      })
    };

    await oclProvider.initialize();
    // Esvazia snapshot para forçar novo refresh
    oclProvider._sourceStateByCanonical.clear();

    oclProvider.getCodeSystemChanges('4.0.0', null);
    await new Promise(resolve => setTimeout(resolve, 200));

    // createForDiscoveredSource não deve ter sido chamado para URL que já tem factory
    const callForExisting = spy.mock.calls.find(([, meta]) => meta?.canonicalUrl === canonicalUrl);
    expect(callForExisting).toBeUndefined();
  });
});
