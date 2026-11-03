/**
 * Which client resource cache store an endpoint gets: what is configured, except that
 * in cluster mode (cluster.js sets FHIRSMITH_CLUSTER_SIZE for its workers) the memory
 * store, which only works in one process, becomes the shared SQLite one.
 */
const TXModule = require('../../tx/tx');

const settings = (resourceCache) => TXModule.prototype.resourceCacheSettings.call({ config: { resourceCache } });

describe('resource cache settings', () => {
  const saved = process.env.FHIRSMITH_CLUSTER_SIZE;
  afterEach(() => {
    if (saved === undefined) {
      delete process.env.FHIRSMITH_CLUSTER_SIZE;
    } else {
      process.env.FHIRSMITH_CLUSTER_SIZE = saved;
    }
  });

  test('one process: memory unless sqlite is asked for', () => {
    delete process.env.FHIRSMITH_CLUSTER_SIZE;
    expect(settings(undefined)).toMatchObject({ store: 'memory', path: null, switched: false });
    expect(settings({ store: 'memory' })).toMatchObject({ store: 'memory', switched: false });
    expect(settings({ store: 'sqlite' })).toMatchObject({ store: 'sqlite', switched: false });
  });

  test('a cluster of one worker is one process', () => {
    process.env.FHIRSMITH_CLUSTER_SIZE = '1';
    expect(settings({ store: 'memory' })).toMatchObject({ store: 'memory', switched: false });
  });

  test('cluster mode: the memory store (asked for, or by default) becomes sqlite', () => {
    process.env.FHIRSMITH_CLUSTER_SIZE = '3';
    const s = settings({ store: 'memory' });
    expect(s).toMatchObject({ store: 'sqlite', switched: true });
    expect(s.path).toMatch(/resource-cache\.db$/);
    expect(settings(undefined)).toMatchObject({ store: 'sqlite', switched: true });
    expect(settings({ store: 'sqlite' })).toMatchObject({ store: 'sqlite', switched: false });
    expect(() => settings({ store: 'redis' })).toThrow(/not valid/);
  });
});
