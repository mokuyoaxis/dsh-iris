// Experimental v0 public plugin author/embedding boundary. No automatic discovery or installation.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPluginRegistry } from './plugin-registry.js';
import { createApplicationRuntime } from './application-runtime.js';
import { definePlugin, pluginFail, pluginFields } from './plugin-contract.js';
import { createCoreCapabilityCatalog } from './core-capability-catalog.js';
import { pinPluginWebAssets, registerPluginWebAssets } from './plugin-web-assets.js';
import { createLocalReadApi } from './local-api.js';

export { createCoreCapabilityCatalog } from './core-capability-catalog.js';

export { definePlugin, PluginContractError, PLUGIN_CONTRACT_VERSION, PLUGIN_KINDS, PLUGIN_CORE_COMMANDS,
  checkedPluginDependency, comparePluginVersions } from './plugin-contract.js';
export { defineProviderAdapter, normalizeMediaEndpoint } from './provider-extensions.js';

export function createCorePluginRegistry({ plugins = [], coreVersion } = {}) {
  coreVersion ??= JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  return createPluginRegistry({ plugins, coreVersion });
}

/** Importing a module executes trusted code. Compatibility gates activate, not module evaluation. */
export async function loadCorePluginRegistry({ entries = [], coreVersion } = {}) {
  if (!Array.isArray(entries)) pluginFail('IRIS_PLUGIN_INVALID', '入口须为明确文件列表');
  const plugins = [], assets = new Map();
  for (const entry of entries) {
    if (typeof entry !== 'string' || !path.isAbsolute(entry) || !/\.m?js$/.test(entry) || !fs.statSync(entry).isFile()) pluginFail('IRIS_PLUGIN_INVALID', '插件入口须为 JS/MJS 文件绝对路径');
    const file = fs.realpathSync(entry), definition = definePlugin((await import(pathToFileURL(file).href)).default);
    for (const [id, files] of pinPluginWebAssets(definition, file)) assets.set(id, files);
    plugins.push(definition);
  }
  const registry = await createCorePluginRegistry({ plugins, coreVersion });
  registerPluginWebAssets(registry, assets);
  return registry;
}

/** Trusted Core assembly. Grants are captured once; individual calls cannot enlarge them. */
export function createCorePluginHost({ dataRoot, registry, allowedOperations = [] } = {}) {
  const selection = createCoreCapabilityCatalog({ registry }).selectOperations(allowedOperations);
  const grants = Object.freeze(selection.map(item => item.id)), application = createApplicationRuntime({ dataRoot });
  return Object.freeze({
    call: (id, input, { dependency, signal } = {}) => application.executePluginOperation(registry, id, input,
      { allowedOperations: grants, dependency, signal }),
    snapshot: () => application.snapshot(),
    dispose: () => application.dispose()
  });
}

/** Public, bounded Panel assembly. Media remains read-only; Provider editing is an explicit owner gate. */
export function createCorePluginWorkbench(options) {
  if (!pluginFields(options, ['dataRoot', 'registry', 'panelContributions', 'panelManifestPath', 'providerConfigPath', 'allowProviderManagement', 'allowedOperations', 'connectionStore', 'allowMcp', 'workbenchAuth'], ['dataRoot'])) {
    pluginFail('IRIS_PLUGIN_WEB_INVALID', '工作台只接受明确的数据根、注册器、Panel 选择及供应商管理设置');
  }
  const { dataRoot, registry: pluginRegistry, panelContributions, panelManifestPath, providerConfigPath, allowProviderManagement = false, allowedOperations, connectionStore, allowMcp = false, workbenchAuth } = options;
  return createLocalReadApi({ dataRoot, serveWorkbench: true, pluginRegistry, panelContributions, panelManifestPath, providerConfigPath, allowProviderManagement,
    allowedOperations, connectionStore, allowConnectionManagement: connectionStore !== undefined, allowMcp, workbenchAuth });
}
