// Explicit startup selection, separate from plugin installation and connection grants.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCorePluginRegistry } from './plugins.js';
import { createCoreCapabilityCatalog } from './core-capability-catalog.js';
import { createPluginPanelAssembly } from './plugin-web-assets.js';
import { pluginFields } from './plugin-contract.js';

const builtins = new Map([['builtin:contact-sheet', fileURLToPath(new URL('../plugins/contact-sheet/index.mjs', import.meta.url))]]);
export const builtinLaunchPlugins = () => [...builtins.keys()];

function invalid(message, file, field) {
  const error = Object.assign(new Error(message), { code: 'IRIS_PLUGIN_LAUNCH_INVALID' });
  error.diagnostic = { code: error.code, stage: 'plugin-config', message, ...(file ? { file } : {}), ...(field ? { field } : {}) };
  throw error;
}
function contextualize(error, file, stage) {
  if (!(error instanceof Error)) error = new Error(String(error));
  error.diagnostic ??= { code: error.code || 'IRIS_PLUGIN_LAUNCH_FAILED', stage, message: error.message, file };
  return error;
}

export function readPluginLaunchConfiguration(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) invalid('plugin-config 必须是明确的 JSON 文件绝对路径', undefined, 'plugin-config');
  let input, fd;
  try {
    fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 65536) invalid('插件启动配置须为不超过 64 KiB 的普通 JSON 文件', file);
    const buffer = Buffer.alloc(65537); let size = 0, count;
    while (size < buffer.length && (count = fs.readSync(fd, buffer, size, buffer.length - size, null))) size += count;
    if (size > 65536) invalid('插件启动配置超过 64 KiB', file);
    try { input = JSON.parse(buffer.subarray(0, size).toString('utf8')); }
    catch (_) { invalid('插件启动配置不是有效 JSON', file); }
  } catch (error) { throw contextualize(error, file, 'plugin-config'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  if (!pluginFields(input, ['schemaVersion', 'entries', 'operations', 'panel'], ['schemaVersion', 'entries']) || input.schemaVersion !== 0) {
    invalid('插件启动配置须使用 schemaVersion:0，仅接受 entries、可选 operations/panel；不接受凭据或服务开关', file);
  }
  if (!Array.isArray(input.entries) || input.entries.some(entry => typeof entry !== 'string') || new Set(input.entries).size !== input.entries.length) {
    invalid('entries 须为不重复的内置引用或 JS/MJS 绝对路径列表', file, 'entries');
  }
  const entries = input.entries.map((entry, index) => {
    if (builtins.has(entry)) return builtins.get(entry);
    if (!path.isAbsolute(entry) || !/\.m?js$/.test(entry)) invalid('入口须为已知 builtin: 引用或明确的 JS/MJS 绝对路径', file, 'entries[' + index + ']');
    return entry;
  });
  if (input.operations !== undefined && (!Array.isArray(input.operations) || input.operations.some(id => typeof id !== 'string')
      || new Set(input.operations).size !== input.operations.length)) invalid('operations 须为不重复的完整业务 ID 列表；空数组仅接管历史', file, 'operations');
  // Reuse the same Panel validator as the server after the real registry is loaded.
  if (input.panel !== undefined && !pluginFields(input.panel, ['pages', 'settings', 'renderers'], [])) invalid('panel 只接受 pages/settings/renderers 的明确列表', file, 'panel');
  for (const [kind, values] of Object.entries(input.panel || {})) {
    if (!Array.isArray(values) || values.some(id => typeof id !== 'string') || new Set(values).size !== values.length) {
      invalid('panel 的每一项须为不重复的贡献 ID 列表', file, 'panel.' + kind);
    }
  }
  return { entries, ...(input.operations !== undefined ? { operations: input.operations } : {}), ...(input.panel !== undefined ? { panel: input.panel } : {}) };
}

/** Imports/activate execute trusted code; inspect is not a sandbox or a media health test. */
export async function loadPluginLaunch(file, { serveWorkbench = true, panelManifestPath } = {}) {
  const config = readPluginLaunchConfiguration(file);
  if (config.panel !== undefined && (!serveWorkbench || panelManifestPath !== undefined)) {
    invalid('panel 组合仅用于默认 web 工作台；不能用于 api serve 或与 --panel 整套替换同时选择', file, 'panel');
  }
  let registry;
  try {
    // Resolve before importing anything, including duplicate aliases to the same file.
    const entries = config.entries.map(entry => fs.realpathSync(entry));
    if (new Set(entries).size !== entries.length) invalid('entries 不能重复引用同一实际文件', file, 'entries');
    registry = await loadCorePluginRegistry({ entries });
    const catalog = createCoreCapabilityCatalog({ registry });
    if (config.operations !== undefined) catalog.selectOperations(config.operations);
    if (config.panel !== undefined) createPluginPanelAssembly(registry, config.panel);
    const facts = catalog.snapshot({ allowedOperations: config.operations ?? [], panelContributions: config.panel });
    const summary = { contractVersion: 0, plugins: facts.plugins, contributions: facts.contributions,
      pluginExecution: config.operations !== undefined,
      selection: { operations: config.operations ?? null, panel: config.panel ?? null } };
    return { registry, allowedOperations: config.operations, panelContributions: config.panel, summary, dispose: () => registry.dispose() };
  } catch (error) {
    try { await registry?.dispose(); }
    catch (cleanup) { throw contextualize(Object.assign(new AggregateError([error, cleanup], '插件启动校验与释放均失败'), { code: 'IRIS_PLUGIN_LAUNCH_CLEANUP_FAILED' }), file, 'plugin-cleanup'); }
    throw contextualize(error, file, 'plugin-load');
  }
}
