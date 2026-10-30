import fs from 'node:fs';
import path from 'node:path';
import { freezePluginValue, pluginFail, pluginFields } from './plugin-contract.js';

const WEB_KINDS = ['pages', 'settings', 'renderers'];
const resources = new WeakMap();
const invalid = message => pluginFail('IRIS_PLUGIN_WEB_INVALID', message);

/** Only explicitly declared entry/styles. Never serve a plugin directory or evaluate browser JS. */
export function pinPluginWebAssets(definition, file) {
  const root = path.dirname(file), entries = new Map();
  let total = 0;
  for (const kind of WEB_KINDS) for (const item of definition.manifest.contributions[kind]) {
    const assets = new Map();
    for (const relative of [item.entry, ...(item.styles || [])]) {
      const target = fs.realpathSync(path.join(root, relative)), rel = path.relative(root, target), stat = fs.statSync(target);
      if (!rel || rel.startsWith('..' + path.sep) || path.isAbsolute(rel) || !stat.isFile()) {
        pluginFail('IRIS_PLUGIN_INVALID', 'Web 入口必须位于插件目录内');
      }
      if (stat.size > 8 * 1024 * 1024 || (total += stat.size) > 16 * 1024 * 1024) invalid('插件 Web 资源超过 8 MiB 单文件 / 16 MiB 总量限制');
      assets.set(relative, { bytes: fs.readFileSync(target), mediaType: relative.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8' });
    }
    entries.set(kind + ':' + definition.manifest.id + '.' + item.id, assets);
  }
  return entries;
}

export function registerPluginWebAssets(registry, entries) { resources.set(registry, entries); }

/** A Core service opts in to exact contribution IDs. Installing a plugin never opts in. */
export function createPluginPanelAssembly(registry, selection = {}) {
  if (!pluginFields(selection, WEB_KINDS, [])) invalid('Panel 组合选择须为 pages/settings/renderers 的明确 ID 列表');
  const source = registry?.snapshot(), pinned = resources.get(registry), routes = new Map(), manifest = { contractVersion: 0 }, selected = {};
  if (source && source.state !== 'active') pluginFail('IRIS_PLUGIN_CLOSED', '插件注册实例正在关闭或已关闭');
  for (const kind of WEB_KINDS) {
    const ids = selection[kind] ?? [];
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) invalid('Panel 选择须为不重复的完整贡献 ID');
    selected[kind] = [...ids];
    manifest[kind] = ids.map(id => {
      const item = source?.contributions[kind].find(value => value.id === id);
      if (!item) pluginFail('IRIS_PLUGIN_CONTRIBUTION_MISSING', 'Panel 贡献未加载：' + kind + ':' + id);
      const assets = pinned?.get(kind + ':' + id);
      if (!assets) pluginFail('IRIS_PLUGIN_WEB_ASSET_MISSING', 'Panel 贡献须经显式文件入口加载并固定资源：' + id);
      const base = '/plugin-assets/' + item.dependency.pluginId + '/' + item.dependency.pluginVersion + '/' + kind + '/' + id + '/';
      for (const [name, asset] of assets) routes.set(base + name, asset);
      return { id, title: item.title, dependency: item.dependency, entry: base + item.entry,
        styles: (item.styles || []).map(name => base + name), ...(kind === 'renderers' ? { mediaTypes: item.mediaTypes } : {}) };
    });
  }
  const active = () => !registry || registry.snapshot().state === 'active';
  freezePluginValue(manifest); freezePluginValue(selected);
  return Object.freeze({ selection: selected, manifest,
    has: route => active() && routes.has(route), read: async route => active() ? routes.get(route) || null : null });
}
