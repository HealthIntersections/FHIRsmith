/**
 * The OCL value set provider is initialized as the library loads (Library.loadOcl, mode 'npm'),
 * not on the first request: on tx.gointerop.com (2026-11-25) each cluster process took 1 to 3
 * minutes to initialize it on demand, and the requests for OCL value sets that came meanwhile
 * went to OCL themselves and timed out. A failure at startup isn't fatal.
 */
const { Library } = require('../../tx/library');
const { OCLValueSetProvider } = require('../../tx/ocl/vs-ocl');

function bareLibrary() {
  const lib = Object.create(Library.prototype);
  lib.oclProviderSets = new Map();
  lib.oclConfig = {};
  lib.oclCluster = null;
  lib.externalSources = [];
  lib.codeSystemProviders = [];
  lib.valueSetProviders = [];
  lib.conceptMapProviders = [];
  lib.log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return lib;
}

describe('OCL value sets loaded at startup', () => {
  let initialize;

  afterEach(() => {
    if (initialize) {
      initialize.mockRestore();
    }
  });

  it('initializes the value set provider when the library registers it, once', async () => {
    initialize = jest.spyOn(OCLValueSetProvider.prototype, 'initialize').mockResolvedValue(undefined);
    const lib = bareLibrary();

    await lib.loadOcl('https://ocl-startup.example.org', false, 'npm');
    await lib.loadOcl('https://ocl-startup.example.org', false, 'npm');

    expect(initialize).toHaveBeenCalledTimes(1);
    expect(lib.valueSetProviders.length).toBe(1);
    expect(lib.log.info).toHaveBeenCalledWith(expect.stringMatching(/^OCL value sets loaded at startup in /));
  });

  it('carries on (and tries again next time) when it fails', async () => {
    initialize = jest.spyOn(OCLValueSetProvider.prototype, 'initialize')
      .mockRejectedValueOnce(new Error('timeout of 30000ms exceeded'))
      .mockResolvedValue(undefined);
    const lib = bareLibrary();

    await expect(lib.loadOcl('https://ocl-startup.example.org', false, 'npm')).resolves.toBeUndefined();
    expect(lib.log.warn).toHaveBeenCalledWith(expect.stringMatching(/not loaded at startup.*timeout of 30000ms exceeded/));
    expect(lib.valueSetProviders.length).toBe(1);

    await lib.loadOcl('https://ocl-startup.example.org', false, 'npm');
    expect(initialize).toHaveBeenCalledTimes(2);
  });

  it('does not initialize value sets when only code systems are loaded', async () => {
    initialize = jest.spyOn(OCLValueSetProvider.prototype, 'initialize').mockResolvedValue(undefined);
    const lib = bareLibrary();

    await lib.loadOcl('https://ocl-startup.example.org', false, 'fetch');
    expect(initialize).not.toHaveBeenCalled();
  });
});
