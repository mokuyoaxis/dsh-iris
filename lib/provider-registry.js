import { defineProviderAdapter } from './provider-adapter.js';
import { unsupportedProtocolError, providerApiKey } from './provider-protocol.js';
import { checkedPluginDependency, assertPluginDependencyMatches } from './plugin-contract.js';

export const PROVIDER_EXTENSION_CONTRACT_VERSION = 0;
const ID = /^[a-z][a-z0-9._-]{0,79}$/;
const CAPS = Object.freeze({ 'image-gen': 'image', 'video-gen': 'video', tts: 'tts', 'music-gen': 'music', transcribe: 'transcribe' });
const invalid = message => Object.assign(new TypeError(message), { code: 'IRIS_PROVIDER_EXTENSION_INVALID' });
const closed = () => Object.assign(new Error('Provider 扩展实例已关闭或正在关闭'), {
  code: 'IRIS_PROVIDER_EXTENSION_CLOSED', stage: 'validate', category: 'invalid_request', acceptance: 'not_accepted' });

function checkedProtocol(value) {
  if (!value || typeof value.id !== 'string' || !ID.test(value.id) || typeof value.label !== 'string' || !value.label.trim() || value.label.length > 100
      || !Array.isArray(value.capabilities) || !value.capabilities.length
      || value.capabilities.some(cap => !Object.hasOwn(CAPS, cap)) || new Set(value.capabilities).size !== value.capabilities.length
      || typeof value.createAdapter !== 'function' || typeof value.normalizeEndpoint !== 'function'
      || (value.supportsModel !== undefined && typeof value.supportsModel !== 'function')
      || (value.supportsImageEdit !== undefined && typeof value.supportsImageEdit !== 'function')) throw invalid('Provider 协议描述无效');
  if (value.configuration !== undefined && !Array.isArray(value.configuration)) throw invalid('配置字段描述必须是数组');
  const keys = new Set();
  const configuration = (value.configuration || []).map(field => {
    if (!field || !['baseUrl', 'mediaBaseUrl', 'apiKey'].includes(field.key) || keys.has(field.key)
        || typeof field.label !== 'string' || !field.label.trim() || field.label.length > 100
        || field.type !== (field.key === 'apiKey' ? 'secret' : 'url')
        || (field.required !== undefined && typeof field.required !== 'boolean')
        || (field.advanced !== undefined && typeof field.advanced !== 'boolean')) throw invalid('Provider 配置字段描述无效');
    keys.add(field.key);
    return Object.freeze({ key: field.key, label: field.label, type: field.type,
      ...(field.required !== undefined ? { required: field.required } : {}), ...(field.advanced !== undefined ? { advanced: field.advanced } : {}) });
  });
  const dependency = value.dependency === undefined ? undefined : checkedPluginDependency(value.dependency);
  if (dependency && (dependency.kind !== 'providers' || dependency.contributionId !== value.id)) throw invalid('Provider 与插件贡献依赖不一致');
  return Object.freeze({ id: value.id, label: value.label, capabilities: Object.freeze([...value.capabilities]),
    configuration: Object.freeze(configuration), normalizeEndpoint: value.normalizeEndpoint,
    ...(dependency ? { dependency } : {}),
    ...(value.supportsModel ? { supportsModel: value.supportsModel } : {}),
    ...(value.supportsImageEdit ? { supportsImageEdit: value.supportsImageEdit } : {}), createAdapter: value.createAdapter });
}

/** One registry owns its factory instances, active calls and serial asynchronous cleanup. */
export async function createExtensionRegistry(factories) {
  const protocols = new Map(), extensions = [], active = new Set();
  let state = 'loading', disposal, cleanupFailed = false;

  function dispose() {
    if (!disposal) {
      state = 'closing';
      disposal = (async () => {
        await Promise.allSettled([...active]);
        const errors = [];
        for (const extension of [...extensions].reverse()) {
          try { await extension.dispose?.(); } catch (error) { errors.push(error); }
        }
        protocols.clear(); state = 'closed'; cleanupFailed = errors.length > 0;
        if (errors.length) throw new AggregateError(errors, 'Provider 扩展释放失败');
      })();
    }
    return disposal;
  }

  try {
    for (const factory of factories) {
      if (typeof factory !== 'function') throw invalid('扩展入口必须是创建独立实例的工厂函数');
      const extension = await factory();
      if (extension && typeof extension.dispose === 'function') extensions.push({ dispose: () => extension.dispose() });
      if (!extension || extension.contractVersion !== PROVIDER_EXTENSION_CONTRACT_VERSION || typeof extension.id !== 'string' || !ID.test(extension.id)
          || typeof extension.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(extension.version)
          || !Array.isArray(extension.protocols) || !extension.protocols.length
          || (extension.dispose !== undefined && typeof extension.dispose !== 'function')) throw invalid('扩展身份、版本或协议集合无效');
      if (extensions.some(item => item.id === extension.id)) throw invalid('扩展 ID 重复：' + extension.id);
      const owned = extension.protocols.map(checkedProtocol);
      for (const protocol of owned) {
        if (protocol.dependency && (protocol.dependency.pluginId !== extension.id || protocol.dependency.pluginVersion !== extension.version)) throw invalid('Provider 依赖不属于当前扩展版本');
        if (protocols.has(protocol.id)) throw invalid('Provider 协议重复：' + protocol.id);
        protocols.set(protocol.id, protocol);
      }
      if (typeof extension.dispose === 'function') Object.assign(extensions[extensions.length - 1], { id: extension.id, version: extension.version });
      else extensions.push({ id: extension.id, version: extension.version });
    }
    state = 'active';
  } catch (error) {
    try { await dispose(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Provider 扩展装配与释放均失败'); }
    throw error;
  }

  const wrap = action => async (...args) => {
    if (state !== 'active') throw closed();
    const call = Promise.resolve().then(() => action(...args));
    active.add(call);
    try { return await call; } finally { active.delete(call); }
  };

  return Object.freeze({
    descriptor: id => state === 'active' ? protocols.get(id) : undefined,
    snapshot: () => ({ contractVersion: PROVIDER_EXTENSION_CONTRACT_VERSION, state, activeCalls: active.size, cleanupFailed,
      extensions: extensions.filter(item => item.id).map(({ id, version }) => ({ id, version })),
      protocols: [...protocols.values()].map(({ id, label, capabilities, configuration, dependency }) => ({ id, label,
        capabilities: [...capabilities], configuration: configuration.map(field => ({ ...field })),
        ...(dependency ? { dependency: { ...dependency } } : {}) })) }),
    createAdapter(id, provider, options) {
      if (state !== 'active') throw closed();
      const descriptor = protocols.get(id);
      if (!descriptor) throw unsupportedProtocolError(id);
      const value = descriptor.createAdapter({ ...provider, apiKey: providerApiKey(provider) }, options);
      if (!value || typeof value.then === 'function') throw invalid('createAdapter 必须同步返回 Adapter');
      if (value.pluginDependency !== undefined) assertPluginDependencyMatches(descriptor.dependency, value.pluginDependency);
      const adapter = defineProviderAdapter({ ...value,
        ...(descriptor.dependency ? { pluginDependency: descriptor.dependency } : {}),
        unsupported: Object.fromEntries(Object.entries(value.unsupported || {}).map(([name, reason]) => [name, reason?.reason ?? reason])) });
      if (adapter.id !== provider.id || adapter.protocol !== id || adapter.capabilities.some(cap =>
        !descriptor.capabilities.some(known => CAPS[known] === cap))) throw invalid('Adapter 身份或能力与注册协议不一致');
      return Object.freeze({ ...adapter, operations: Object.freeze(Object.fromEntries(Object.entries(adapter.operations)
        .map(([name, action]) => [name, name === 'mapError' ? action : wrap(action)]))),
      ...(adapter.prepareInput ? { prepareInput: wrap(adapter.prepareInput) } : {}) });
    },
    dispose
  });
}
