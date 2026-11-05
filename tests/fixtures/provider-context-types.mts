import { definePlugin, defineProviderAdapter, ProviderContractError, normalizeMediaEndpoint, PROVIDER_FACTORY_CONTEXT_VERSION,
  type ProviderFactoryContext, type ProviderConnection, type ProviderOperations, type ProviderErrorRecord } from '@mokuyoaxis/dsh-iris/plugins';

const one: 1 = PROVIDER_FACTORY_CONTEXT_VERSION;
void one;
function adapter(provider: Readonly<ProviderConnection>, context: Readonly<ProviderFactoryContext>) {
  const operations: ProviderOperations = {
    async discover({ signal }) {
      const response = await context.network.fetch(normalizeMediaEndpoint(String(provider.baseUrl)) + '/models', { signal });
      await response.json(); return { models: [{ id: 'fixture', capabilities: ['image-gen'] }] };
    },
    async submit({ model, input, signal }) {
      void input.prompt;
      await context.network.fetch('https://fixture.invalid/' + model, { signal });
      return { kind: 'accepted', remoteTaskId: 'original-id' };
    },
    mapError(error, defaults) {
      return error instanceof ProviderContractError ? error : new ProviderContractError('Transport failed', defaults);
    }
  };
  // @ts-expect-error A factory cannot close Core-owned networking.
  context.network.dispose();
  // @ts-expect-error Network policy/route evidence remains owned by Core.
  context.network.run(() => undefined);
  // @ts-expect-error No registry control port is handed to a Provider factory.
  void context.registry;
  // @ts-expect-error No arbitrary process-environment reader is handed to a Provider factory.
  void context.readCredential;
  // @ts-expect-error Connection values are borrowed and readonly.
  provider.apiKey = 'replacement';
  return defineProviderAdapter({ id: provider.id, protocol: 'example.types.images', capabilities: ['image'], operations,
    unsupported: { poll: 'example', cancel: 'example', download: 'example' } });
}
definePlugin({ manifest: { contractVersion: 0, id: 'example.types', version: '1.0.0', compatibility: { min: '0.3.0-alpha.1', maxExclusive: '0.4.0' },
  contributions: { providers: [{ id: 'images', version: '1.0.0', title: 'Example', capabilities: ['image-gen'] }] } },
  activate: () => ({ providers: { images: { normalizeEndpoint: normalizeMediaEndpoint, createAdapter: adapter } } }) });
const error = new ProviderContractError('Rejected', { stage: 'prepare', category: 'invalid_request', acceptance: 'not_accepted' });
const record: ProviderErrorRecord = error.toJSON(); void record;
// @ts-expect-error Submission must state the remote identity or a definite completed/acceptance outcome.
const bad: ProviderOperations['submit'] = async () => ({ kind: 'accepted' });
void bad;
