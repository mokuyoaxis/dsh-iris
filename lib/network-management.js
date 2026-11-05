// Owner-only composition over the existing resource store. No implicit enrollment.
import fs from 'node:fs';
import { readNetworkConfig, executeNetworkConfigCommand } from './network-config-service.js';
import { networkFields, projectNetworkConfig } from './network-config.js';
import { loadProviderCatalog } from './provider-catalog.js';
import { projectProviderSettings } from './provider-settings.js';
import { settingsRevision } from './provider-config-service.js';
import { providerNetworkRequirement, networkPolicyError } from './network-policy.js';

export const NETWORK_MANAGEMENT_ACTIONS = Object.freeze(['init', 'nodes/add', 'nodes/set', 'nodes/remove',
  'pools/add', 'pools/set', 'pools/remove', 'bindings/set', 'bindings/remove']);

export function networkManagementSettings({ networkConfigPath, providerConfigPath, registry }) {
  let saved;
  try { fs.lstatSync(networkConfigPath); saved = readNetworkConfig(networkConfigPath); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const catalog = providerConfigPath ? loadProviderCatalog(providerConfigPath) : undefined;
  const requirement = providerNetworkRequirement(catalog);
  const revision = catalog ? settingsRevision(catalog) : null;
  const state = !catalog ? 'absent' : !requirement ? 'legacy' : !saved ? 'missing_network'
    : saved.config.schemaVersion !== 2 || saved.config.configId !== requirement.configId ? 'mismatch' : 'ready';
  const network = saved ? projectNetworkConfig(saved.config, saved.revision) : null;
  const settings = catalog ? projectProviderSettings(catalog, revision, registry) : undefined;
  const providers = (settings?.providers || []).map(provider => {
    const binding = state === 'ready' && saved.config.bindings.find(item => item.catalogId === requirement.catalogId && item.providerId === provider.id);
    const pool = binding && network.pools.find(item => item.id === binding.poolId);
    return { id: provider.id, name: provider.name, enabled: provider.enabled,
      route: { state: ['mismatch', 'missing_network'].includes(state) ? 'blocked' : !binding ? 'inherit' : pool.status === 'configured' ? 'pool' : 'blocked',
        ...(pool ? { poolId: pool.id, poolLabel: pool.label, poolStatus: pool.status, mode: pool.mode } : {}),
        ...(state === 'legacy' ? { legacy: true } : {}) } };
  });
  return { contractVersion: 0, storage: saved ? 'ready' : 'missing', network,
    catalog: { state, revision, ...(requirement ? { configId: requirement.configId, catalogId: requirement.catalogId } : {}) }, providers };
}

export function manageNetworkResources(options, action, input, { signal } = {}) {
  if (!NETWORK_MANAGEMENT_ACTIONS.includes(action)) throw new TypeError('未知网络管理操作');
  let command = action === 'init' ? 'routing.init' : action.replace('/', '.');
  if (action === 'bindings/set') {
    networkFields(input, ['expectedRevision', 'expectedProviderRevision', 'providerId', 'poolId'],
      ['expectedRevision', 'expectedProviderRevision', 'providerId', 'poolId']);
    const settings = networkManagementSettings(options);
    if (settings.catalog.state !== 'ready') throw networkPolicyError('IRIS_NETWORK_CATALOG_REQUIRED', '绑定需要匹配的v2网络文件和供应商目录；请先按指引另存启用，不自动迁移');
    if (input.expectedProviderRevision !== settings.catalog.revision) throw networkPolicyError('IRIS_NETWORK_PROVIDER_CHANGED', '供应商目录已变化，请重新读取后核对绑定');
    if (!settings.providers.some(provider => provider.id === input.providerId)) throw networkPolicyError('IRIS_NETWORK_PROVIDER_NOT_FOUND', '所选供应商不在当前目录');
    input = { expectedRevision: input.expectedRevision, catalogId: settings.catalog.catalogId, providerId: input.providerId, poolId: input.poolId };
  }
  const changed = executeNetworkConfigCommand(options.networkConfigPath, command, input, { signal });
  return { contractVersion: 0, changed: changed.created === true || changed.changed === true,
    settings: networkManagementSettings(options) };
}
