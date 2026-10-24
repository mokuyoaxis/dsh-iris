// Shared CLI/service assembly. Configuration is read only during explicit commands.
import path from 'node:path';
import { loadProviderCatalog, imageCandidatesFromCatalog, providerForTaskFromCatalog, providerTaskBinding } from './provider-catalog.js';
import { createConfiguredProviderAdapter } from './provider-adapters.js';
import { recordCatalogAvailability, recordCatalogRateLimit } from './provider-config-service.js';
import { parseModelRef } from './models.js';

export function createTrackedProviderAdapter(provider, providerConfigPath, task) {
  return createConfiguredProviderAdapter(provider, {
    modelId: parseModelRef(task?.modelRef)?.modelId,
    onModelAvailability: event => recordCatalogAvailability(providerConfigPath, event),
    onRateLimit: event => recordCatalogRateLimit(providerConfigPath, event)
  });
}

export function configuredImagePorts(providerConfigPath) {
  if (typeof providerConfigPath !== 'string' || !path.isAbsolute(providerConfigPath)) throw new TypeError('Provider 配置须为显式绝对路径');
  return Object.freeze({
    resolveImageCandidates({ modelRef, signal }) {
      signal?.throwIfAborted();
      return imageCandidatesFromCatalog(loadProviderCatalog(providerConfigPath), modelRef).map(route => ({
        adapter: createTrackedProviderAdapter(route.provider, providerConfigPath), model: route.modelRef,
        providerBinding: providerTaskBinding(route.provider), selectionReason: 'explicit'
      }));
    },
    resolveTaskAdapter(task, { signal } = {}) {
      signal?.throwIfAborted();
      return createTrackedProviderAdapter(providerForTaskFromCatalog(loadProviderCatalog(providerConfigPath), task), providerConfigPath, task);
    }
  });
}
