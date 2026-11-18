/**
 * The providers an operation opens (sqlite connections) are closed when it ends - including
 * those opened through a copy, and one whose build finished only after the
 * client went, when closeProviders() had already run and nothing would run it again. A batch
 * entry (copy({ ownProviders: true })) has its own list, closed when the entry is done.
 */
const { OperationContext } = require('../../tx/operation-context');
const { Languages } = require('../../library/languages');

const context = () => new OperationContext(new Languages());
const provider = () => ({ close: jest.fn().mockResolvedValue() });
const turn = () => new Promise(resolve => setImmediate(resolve));

test('a provider opened through a copy is closed with the operation', async () => {
  const parent = context(), child = parent.copy();
  const p = provider();
  child.registerProvider(p);
  await parent.closeProviders();
  expect(p.close).toHaveBeenCalledTimes(1);
  await parent.closeProviders();
  expect(p.close).toHaveBeenCalledTimes(1);
});

test('a provider registered after closeProviders() is closed at once, through the parent or a copy', async () => {
  const parent = context(), child = parent.copy();
  await parent.closeProviders();
  const late = provider(), later = provider();
  child.registerProvider(late);
  parent.registerProvider(later);
  await turn();
  expect(late.close).toHaveBeenCalledTimes(1);
  expect(later.close).toHaveBeenCalledTimes(1);
});

test('one provider failing to close does not stop the others', async () => {
  const ctx = context();
  const broken = { close: jest.fn().mockRejectedValue(new Error('close failed')) }, good = provider();
  ctx.registerProvider(broken);
  ctx.registerProvider(good);
  await expect(ctx.closeProviders()).resolves.toBeUndefined();
  expect(good.close).toHaveBeenCalledTimes(1);
});

test('a batch entry\'s own list: closed with the entry, and a late one at once', async () => {
  const parent = context(), entry = parent.copy({ ownProviders: true });
  const p = provider(), late = provider();
  entry.registerProvider(p);
  await parent.closeProviders();
  expect(p.close).not.toHaveBeenCalled();
  await entry.closeProviders();
  expect(p.close).toHaveBeenCalledTimes(1);
  entry.registerProvider(late);
  await turn();
  expect(late.close).toHaveBeenCalledTimes(1);
});
