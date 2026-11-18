/**
 * Provider.findValueSet hands each value-set provider the request's OperationContext
 * (AbstractValueSetProvider.fetchValueSet(url, version, opContext)), so a provider can share work
 * between the lookups of one request. Providers that take two arguments are unaffected.
 */
const { Provider } = require('../../tx/provider');
const { AbstractValueSetProvider } = require('../../tx/vs/vs-api');

class RecordingProvider extends AbstractValueSetProvider {
  constructor(answer) {
    super();
    this.answer = answer;
    this.calls = [];
  }
  async fetchValueSet(url, version, opContext) {
    this.calls.push({ url, version, opContext });
    return this.answer;
  }
}

class TwoArgProvider extends AbstractValueSetProvider {
  async fetchValueSet(url, version) {
    return url === 'http://example.org/vs' && version == null ? { url } : null;
  }
}

function provider(valueSetProviders) {
  const p = Object.create(Provider.prototype);
  p.valueSetProviders = valueSetProviders;
  p.findKnownValueSet = async () => null;
  return p;
}

const opContext = { deadCheck: jest.fn() };

describe('findValueSet passes the request to fetchValueSet', () => {
  test('each provider asked gets the OperationContext', async () => {
    const miss = new RecordingProvider(null);
    const hit = new RecordingProvider({ url: 'http://example.org/vs' });
    const vs = await provider([miss, hit]).findValueSet(opContext, 'http://example.org/vs', '1.0');
    expect(vs).toEqual({ url: 'http://example.org/vs' });
    expect(miss.calls).toEqual([{ url: 'http://example.org/vs', version: '1.0', opContext }]);
    expect(hit.calls).toEqual([{ url: 'http://example.org/vs', version: '1.0', opContext }]);
  });

  test('no request: the provider gets null', async () => {
    const p = new RecordingProvider(null);
    await provider([p]).findValueSet(null, 'http://example.org/vs', null);
    expect(p.calls[0].opContext).toBeNull();
  });

  test('a provider that takes (url, version) answers as before', async () => {
    expect(await provider([new TwoArgProvider()]).findValueSet(opContext, 'http://example.org/vs', null)).toEqual({ url: 'http://example.org/vs' });
  });
});
