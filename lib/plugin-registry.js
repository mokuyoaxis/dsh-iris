import { z } from 'zod';
import { createProviderRegistry } from './provider-extensions.js';
import { definePlugin, assertPluginCompatibility, checkedPluginDependency, pluginDependency, qualifiedPluginId,
  pluginFields, pluginJson, pluginFail, comparePluginVersions, PLUGIN_KINDS } from './plugin-contract.js';
import { registerPluginOperations } from './plugin-operations.js';

const unavailable = () => pluginFail('IRIS_PLUGIN_CLOSED', '插件注册实例正在关闭或已关闭');

/** Manifest validation precedes every activation. Core owns call reservations and cleanup. */
export async function createPluginRegistry({ plugins, coreVersion }) {
  if (!Array.isArray(plugins)) pluginFail('IRIS_PLUGIN_INVALID', 'plugins 须为明确的插件数组');
  comparePluginVersions(coreVersion, coreVersion);
  const definitions = plugins.map(definePlugin), entries = new Map(), contributionIds = new Set(), operations = new Map(), cleanups = [], active = new Set();
  for (const definition of definitions) {
    const { manifest } = definition; assertPluginCompatibility(manifest, coreVersion);
    if (entries.has(manifest.id)) pluginFail('IRIS_PLUGIN_INVALID', '插件 ID 重复：' + manifest.id);
    entries.set(manifest.id, definition);
    for (const kind of PLUGIN_KINDS) for (const contribution of manifest.contributions[kind]) {
      const key = kind + ':' + qualifiedPluginId(manifest.id, contribution.id);
      if (contributionIds.has(key)) pluginFail('IRIS_PLUGIN_INVALID', '贡献完整 ID 重复：' + key);
      contributionIds.add(key);
    }
    for (const operation of manifest.contributions.operations) {
      let schema;
      try { schema = z.fromJSONSchema(operation.inputSchema); }
      catch (cause) { throw Object.assign(new Error('插件输入 Schema 无法编译：' + manifest.id + '.' + operation.id, { cause }), { code: 'IRIS_PLUGIN_INVALID' }); }
      operations.set(qualifiedPluginId(manifest.id, operation.id), { manifest, descriptor: operation, schema });
    }
  }
  let state = 'loading', providers, disposal, cleanupFailed = false;

  function dispose() {
    if (!disposal) {
      state = 'closing';
      const providerDisposal = providers?.dispose();
      void providerDisposal?.catch(() => {}); // Awaited below after operation reservations drain.
      disposal = (async () => {
        await Promise.allSettled([...active]);
        const errors = [];
        try { await providerDisposal; } catch (error) { errors.push(error); }
        for (const cleanup of [...cleanups].reverse()) {
          try { await cleanup(); } catch (error) { errors.push(error); }
        }
        operations.clear(); state = 'closed'; cleanupFailed = errors.length > 0;
        if (errors.length) throw new AggregateError(errors, '插件释放失败');
      })();
    }
    return disposal;
  }

  try {
    const factories = [];
    for (const { manifest, activate } of definitions) {
      let activating = true;
      const context = Object.freeze({ coreVersion, plugin: Object.freeze({ id: manifest.id, version: manifest.version }),
        onDispose(cleanup) {
          if (!activating || typeof cleanup !== 'function') pluginFail('IRIS_PLUGIN_LIFECYCLE', '资源释放须在 activate 完成前注册');
          cleanups.push(cleanup);
        } });
      let implementation;
      try { implementation = await activate(context); } finally { activating = false; }
      if (!pluginFields(implementation, ['providers', 'operations'], [])) pluginFail('IRIS_PLUGIN_INVALID', 'activate 须返回 Provider/业务实现映射；资源通过 onDispose 释放');
      for (const kind of ['providers', 'operations']) {
        const handlers = implementation[kind] === undefined ? {} : implementation[kind];
        if (!pluginFields(handlers, manifest.contributions[kind].map(item => item.id))) pluginFail('IRIS_PLUGIN_INVALID', '实现必须与声明的 ' + kind + ' 一一对应');
        if (kind === 'operations') for (const descriptor of manifest.contributions.operations) {
          if (typeof handlers[descriptor.id] !== 'function') pluginFail('IRIS_PLUGIN_INVALID', '业务操作必须为函数');
          operations.get(qualifiedPluginId(manifest.id, descriptor.id)).handler = handlers[descriptor.id];
        }
        else if (manifest.contributions.providers.length) factories.push(() => ({ contractVersion: 0, id: manifest.id, version: manifest.version,
          protocols: manifest.contributions.providers.map(descriptor => {
            const handler = handlers[descriptor.id];
            if (!pluginFields(handler, ['normalizeEndpoint', 'createAdapter', 'supportsModel', 'supportsImageEdit'], ['normalizeEndpoint', 'createAdapter'])) {
              pluginFail('IRIS_PLUGIN_INVALID', 'Provider 实现字段无效');
            }
            return { ...handler, id: qualifiedPluginId(manifest.id, descriptor.id), label: descriptor.title,
              capabilities: descriptor.capabilities, configuration: descriptor.configuration,
              dependency: pluginDependency(manifest, 'providers', descriptor.id) };
          }) }));
      }
    }
    providers = await createProviderRegistry({ extensions: factories });
    state = 'active';
  } catch (error) {
    try { await dispose(); } catch (cleanup) { throw new AggregateError([error, cleanup], '插件激活与释放均失败'); }
    throw error;
  }

  function dependency(kind, id) {
    const manifest = definitions.map(item => item.manifest).find(item => item.contributions[kind]?.some(value => qualifiedPluginId(item.id, value.id) === id));
    if (!manifest) pluginFail('IRIS_PLUGIN_CONTRIBUTION_MISSING', '所需插件贡献未加载');
    return pluginDependency(manifest, kind, manifest.contributions[kind].find(item => qualifiedPluginId(manifest.id, item.id) === id).id);
  }
  function assertDependency(value) {
    const expected = checkedPluginDependency(value), current = dependency(expected.kind, expected.contributionId);
    if (Object.keys(expected).some(key => expected[key] !== current[key])) pluginFail('IRIS_PLUGIN_DEPENDENCY_MISMATCH', '原任务依赖的插件或贡献版本不一致；请恢复准确版本，不会重新提交');
    return current;
  }
  const registry = Object.freeze({
    providers,
    snapshot: () => ({ contractVersion: 0, coreVersion, state, activeCalls: active.size, cleanupFailed,
      plugins: definitions.map(({ manifest }) => pluginJson(manifest)),
      contributions: Object.fromEntries(PLUGIN_KINDS.map(kind => [kind, definitions.flatMap(({ manifest }) => manifest.contributions[kind]
        .map(entry => ({ ...pluginJson(entry), id: qualifiedPluginId(manifest.id, entry.id), dependency: pluginJson(pluginDependency(manifest, kind, entry.id)) })))])) }),
    dependency, assertDependency, dispose
  });
  registerPluginOperations(registry, { operations, active, requireActive: () => { if (state !== 'active') unavailable(); } });
  return registry;
}
