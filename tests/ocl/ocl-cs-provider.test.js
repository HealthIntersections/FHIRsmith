const { OCLCodeSystemProvider, OCLSourceCodeSystemProvider } = require('../../tx/ocl/cs-ocl');
const { OperationContext } = require('../../tx/operation-context');
const { Languages } = require('../../library/languages');

describe('OCLCodeSystemProvider', () => {
  it('should instantiate with default config', () => {
    const provider = new OCLCodeSystemProvider();
    expect(provider).toBeTruthy();
  });

  it('should assign ids', () => {
    const provider = new OCLCodeSystemProvider();
    const cs = { id: 'src', jsonObj: { id: 'src' } };
    provider._idToCodeSystem.set('src', cs);
    provider.assignIds('ocl');
    expect(cs.id).toBe('ocl-src');
    expect(cs.jsonObj.id).toBe('ocl-src');
    expect(provider._idToCodeSystem.get('ocl-src')).toBe(cs);
  });

  // Adicione mais testes para métodos públicos e fluxos de erro
});

describe('OCLSourceCodeSystemProvider', () => {
  function makeProvider() {
    const opContext = new OperationContext(Languages.fromAcceptLanguage('en'));
    const meta = { canonicalUrl: 'http://example.org/ocl/CodeSystem/test', version: '1.0' };
    return new OCLSourceCodeSystemProvider(opContext, null, null, meta);
  }

  // Pass a plain context object (with .code) so #ensureContext short-circuits
  // without hitting locate()/HTTP.
  function makeContext(extras) {
    const ctx = { code: 'C-1', display: 'Concept One', definition: null, retired: false, designation: [] };
    if (extras !== undefined) {
      ctx.extras = extras;
    }
    return ctx;
  }

  describe('extendLookup', () => {
    it('emits one property parameter per extras entry with correct value[x] types', async () => {
      const provider = makeProvider();
      const params = [];
      const ctx = makeContext({
        who_stage: '3',
        order: 5,
        weight: 2.5,
        experimental: true,
        nested: { a: 1 },
        list: ['x', 'y'],
        empty: null
      });

      await provider.extendLookup(ctx, [], params);

      const byCode = {};
      for (const p of params) {
        expect(p.name).toBe('property');
        const codePart = p.part.find(x => x.name === 'code');
        const valuePart = p.part.find(x => x.name === 'value');
        byCode[codePart.valueCode] = valuePart;
      }

      expect(byCode.who_stage).toEqual({ name: 'value', valueString: '3' });
      expect(byCode.order).toEqual({ name: 'value', valueInteger: 5 });
      expect(byCode.weight).toEqual({ name: 'value', valueDecimal: 2.5 });
      expect(byCode.experimental).toEqual({ name: 'value', valueBoolean: true });
      expect(byCode.nested).toEqual({ name: 'value', valueString: '{"a":1}' });
      expect(byCode.list).toEqual({ name: 'value', valueString: '["x","y"]' });
      expect(byCode.empty).toBeUndefined();
      expect(params.length).toBe(6);
    });

    it('includes all extras when props is empty or contains *', async () => {
      const provider = makeProvider();
      const ctx = makeContext({ a: '1', b: '2' });

      const allParams = [];
      await provider.extendLookup(ctx, [], allParams);
      expect(allParams.length).toBe(2);

      const starParams = [];
      await provider.extendLookup(ctx, ['*'], starParams);
      expect(starParams.length).toBe(2);
    });

    it('filters extras by requested property names (case-insensitive)', async () => {
      const provider = makeProvider();
      const ctx = makeContext({ who_stage: '3', order: 5 });

      const params = [];
      await provider.extendLookup(ctx, ['WHO_STAGE'], params);
      expect(params.length).toBe(1);
      expect(params[0].part.find(x => x.name === 'code').valueCode).toBe('who_stage');

      const none = [];
      await provider.extendLookup(ctx, ['other'], none);
      expect(none.length).toBe(0);
    });

    it('leaves params untouched when the concept has no extras', async () => {
      const provider = makeProvider();
      const params = [];
      await provider.extendLookup(makeContext(), [], params);
      expect(params).toEqual([]);
    });
  });
});
