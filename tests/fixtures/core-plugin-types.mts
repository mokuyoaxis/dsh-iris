import {
  definePlugin, defineProviderAdapter, PluginContractError, createCorePluginRegistry, createCorePluginHost, createCoreCapabilityCatalog, createCorePluginWorkbench,
  type PluginDependency, type PluginKind, type PluginPageModule, type PluginRendererModule, type PluginSettingsModule, type PluginPanelSelection, type JsonValue
} from '@mokuyoaxis/dsh-iris/plugins';
import contactSheet from '@mokuyoaxis/dsh-iris/contact-sheet';

const plugin = definePlugin({
  manifest: { contractVersion: 0, id: 'example.types', version: '1.0.0', compatibility: { min: '0.3.0-alpha.1', maxExclusive: '0.4.0' }, contributions: {
    operations: [{ id: 'list', version: '1.0.0', title: 'List', mode: 'reader', commands: ['artifact.list'],
      inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['image', 'audio'] } }, additionalProperties: false } }]
  } },
  activate({ onDispose, plugin: identity }) {
    onDispose(async () => { void identity.version; });
    return { operations: { list: async (_input, { core, dependency, signal }) => {
      signal.throwIfAborted(); await core.execute('artifact.list', {});
      return { version: dependency.pluginVersion };
    } } };
  }
});

export async function authorExample(dataRoot: string) {
  const registry = await createCorePluginRegistry({ plugins: [plugin] });
  const catalog = createCoreCapabilityCatalog({ registry });
  const selected = catalog.selectOperations(['example.types.list']);
  const exact: PluginDependency = selected[0].dependency;
  void exact;
  const options = catalog.snapshot({ audioEnabled: true });
  // @ts-expect-error Discovery is immutable and cannot grant another tool.
  options.controlTools.push('example.types.list');
  // @ts-expect-error Unmounted page module paths are not exposed in the public catalog.
  void options.contributions.pages[0].entry;
  const host = createCorePluginHost({ dataRoot, registry, allowedOperations: ['example.types.list'] });
  try {
    const dependency: PluginDependency = registry.dependency('operations', 'example.types.list');
    const result: JsonValue = (await host.call('example.types.list', {}, { dependency })).value;
    return result;
  } finally { await host.dispose(); await registry.dispose(); }
}
const adapter = defineProviderAdapter({ id: 'configured-provider', protocol: 'example.types.images', capabilities: ['image'],
  operations: { submit: async () => ({ kind: 'accepted', remoteTaskId: 'remote' }), mapError: error => error },
  unsupported: { discover: 'example', poll: 'example', cancel: 'example', download: 'example' } });
const reason: string | undefined = adapter.unsupported.poll?.reason;
void reason;
new PluginContractError('IRIS_PLUGIN_INVALID', 'Example');

export const page: PluginPageModule<HTMLElement> = { mount({ container, signal }) {
  signal.throwIfAborted(); const label = document.createElement('p'); label.textContent = 'Example'; container.append(label);
  return () => label.remove();
} };
export const renderer: PluginRendererModule<HTMLElement> = { mount({ container, artifact }) {
  container.textContent = artifact.id;
} };
export const settings: PluginSettingsModule<HTMLElement> = { async mount({ container, api, session, theme, signal }) {
  const current = theme.current(); container.dataset.theme = current.mode;
  const off = theme.subscribe(value => { container.dataset.theme = value.mode; });
  signal.throwIfAborted(); void session.operations;
  if (api.providers) await api.providers.read();
  if (api.pluginOperations) {
    await api.pluginOperations.catalog({ limit: '20' });
    await api.pluginOperations.lookup('a-stable-request-uuid');
    // @ts-expect-error Durable execution requires the exact dependency and input, never only a contribution name.
    await api.pluginOperations.execute({ operationId: 'community.contact-sheet.create', key: 'a-stable-request-uuid' });
  }
  // @ts-expect-error The shared login context has no credential field.
  void session.accessToken;
  // @ts-expect-error Arbitrary plugin operations have no remote Web execution endpoint.
  void api.callOperation;
  return off;
} };
const panelSelection: PluginPanelSelection = { settings: ['example.types.form'], pages: [] };
void panelSelection;
const workbench = createCorePluginWorkbench({ dataRoot: '/explicit/existing-core', panelContributions: panelSelection });
const mediaReadOnly: true = workbench.snapshot().readOnly;
void mediaReadOnly;
void contactSheet.manifest.contributions.operations?.[0].artifactInputs;
createCorePluginWorkbench({ dataRoot: '/explicit/existing-execution-core', allowedOperations: [], connectionStore: '/explicit/connection-store', allowMcp: true });
// @ts-expect-error Built-in media execution remains separate from explicitly selected plugin business.
createCorePluginWorkbench({ dataRoot: '/explicit/existing-core', allowExecution: true });

// @ts-expect-error Unknown contribution kinds cannot enter the authored contract.
const unknownKind: PluginKind = 'harness-login';
void unknownKind;
// @ts-expect-error Adapter capabilities are immutable after registration.
adapter.capabilities.push('video');
