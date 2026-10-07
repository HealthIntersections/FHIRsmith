const fs = require('fs');
const path = require('path');
const { CodeSystemFactoryProvider } = require('../../tx/cs/cs-api');

/**
 * The home page (TxHtmlRenderer.buildHomePage) and the code system links in
 * provider.js call name(), id(), system() and version() on every registered
 * factory. The base class throws "Must override" for those, so a factory that
 * forgets one takes the whole page out with a 500 -- and nothing else in the
 * test suite touches it, which is how ICD-11 shipped without name() or id().
 *
 * This checks the contract statically: no data files, no server, just the
 * prototype chain of every factory class exported from tx/cs.
 */

const CS_DIR = path.join(__dirname, '..', '..', 'tx', 'cs');

const factories = [];
for (const file of fs.readdirSync(CS_DIR).filter(f => f.endsWith('.js'))) {
  const mod = require(path.join(CS_DIR, file));
  for (const [exported, value] of Object.entries(mod)) {
    if (typeof value === 'function' && value.prototype instanceof CodeSystemFactoryProvider) {
      factories.push([`${file} / ${exported}`, value]);
    }
  }
}

/** Does cls (or a class between it and the base) define its own `method`? */
function overrides(cls, method) {
  for (let p = cls.prototype; p && p !== CodeSystemFactoryProvider.prototype; p = Object.getPrototypeOf(p)) {
    if (Object.prototype.hasOwnProperty.call(p, method)) {
      return true;
    }
  }
  return false;
}

describe('CodeSystemFactoryProvider subclasses implement the abstract methods', () => {
  test('there are factories to check', () => {
    expect(factories.length).toBeGreaterThan(10);
  });

  test.each(factories)('%s', (_label, cls) => {
    for (const method of ['system', 'version', 'defaultVersion', 'name', 'id', 'build']) {
      expect({ method, overridden: overrides(cls, method) })
        .toEqual({ method, overridden: true });
    }
  });
});
