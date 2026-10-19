import { allProviders } from './config.js';
import { hasProviderConfigScope, withProviderConfigScope } from './provider-config-scope.js';
import { DshProviderSourceError } from './dsh-provider-source.js';

export function normalizeDshProvider(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || typeof value.provider !== 'string' || !value.provider.trim()
      || typeof value.settingsNs !== 'string' || !value.settingsNs.trim()
      || Object.keys(value).some(key => !['provider', 'settingsNs'].includes(key))) {
    throw Object.assign(new Error('DSH 连接引用需要 provider 和 settingsNs'), { code: 'IRIS_CONFIG_INPUT_INVALID' });
  }
  return { provider: value.provider.trim(), settingsNs: value.settingsNs.trim() };
}

/** Existing request handlers see resolved copies; the persistent store stays raw. */
export async function withDshProviderConfig(host, callback, { signal, fresh = false } = {}) {
  if (!fresh && hasProviderConfigScope()) return callback();
  const providers = allProviders();
  if (!providers.some(provider => provider.dshProvider)) return callback();
  const resolved = await Promise.all(providers.map(async provider => {
    if (!provider.dshProvider || provider.enabled === false) return provider;
    try {
      if (typeof host?.ports?.providerConnections?.resolve !== 'function') {
        throw new DshProviderSourceError('当前宿主无法解析 DSH 连接，请检查原连接或改用手动供应商');
      }
      const value = await host.ports.providerConnections.resolve(provider.dshProvider, { signal });
      return { ...provider, baseUrl: value.baseUrl, apiKey: value.apiKey };
    } catch (error) {
      if (!(error instanceof DshProviderSourceError)) throw error;
      return { ...provider, enabled: false, connectionError: error.message };
    }
  }));
  signal?.throwIfAborted();
  return withProviderConfigScope(resolved, callback);
}
