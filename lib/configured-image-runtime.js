// Shared CLI/service assembly. Configuration is read only during explicit commands.
import path from 'node:path';
import { loadProviderCatalog, imageCandidatesFromCatalog, ttsCandidatesFromCatalog, transcribeCandidatesFromCatalog, providerForTaskFromCatalog, providerTaskBinding } from './provider-catalog.js';
import { createConfiguredProviderAdapter } from './provider-adapters.js';
import { recordCatalogAvailability, recordCatalogRateLimit } from './provider-config-service.js';
import { parseModelRef } from './models.js';
import { supportsImageEdit } from './provider-protocol.js';
import { compileComfyWorkflow } from './comfyui-workflow.js';

export function createTrackedProviderAdapter(provider, providerConfigPath, task, registry) {
  return createConfiguredProviderAdapter(provider, {
    registry,
    modelId: parseModelRef(task?.modelRef)?.modelId,
    onModelAvailability: event => recordCatalogAvailability(providerConfigPath, event),
    onRateLimit: event => recordCatalogRateLimit(providerConfigPath, event)
  });
}

export function configuredImagePorts(providerConfigPath, registry) {
  if (typeof providerConfigPath !== 'string' || !path.isAbsolute(providerConfigPath)) throw new TypeError('Provider 配置须为显式绝对路径');
  return Object.freeze({
    resolveAudioCandidates({ capability, modelRef, signal }) {
      signal?.throwIfAborted();
      if (!['tts', 'transcribe'].includes(capability)) throw new TypeError('未知音频能力');
      const select = capability === 'tts' ? ttsCandidatesFromCatalog : transcribeCandidatesFromCatalog;
      return select(loadProviderCatalog(providerConfigPath), modelRef, registry).map(route => ({
        adapter: createTrackedProviderAdapter(route.provider, providerConfigPath, undefined, registry), model: route.modelRef,
        providerBinding: providerTaskBinding(route.provider, registry), selectionReason: 'explicit'
      }));
    },
    resolveImageCandidates({ modelRef, signal, input }) {
      signal?.throwIfAborted();
      return imageCandidatesFromCatalog(loadProviderCatalog(providerConfigPath), modelRef, registry).map(route => {
        if (input?.workflow_parameters !== undefined) {
          if (route.provider.mediaProtocol !== 'comfyui') throw Object.assign(new TypeError('工作流参数仅用于 ComfyUI 模板'), { code: 'IRIS_COMFYUI_PARAMETERS_INVALID' });
          compileComfyWorkflow(route.provider.comfyWorkflow, input);
        }
        return {
          adapter: createTrackedProviderAdapter(route.provider, providerConfigPath, undefined, registry), model: route.modelRef,
          supportsImageEdit: supportsImageEdit(route.provider.mediaProtocol, route.model, registry),
          providerBinding: providerTaskBinding(route.provider, registry), selectionReason: 'explicit'
        };
      });
    },
    resolveTaskAdapter(task, { signal } = {}) {
      signal?.throwIfAborted();
      return createTrackedProviderAdapter(providerForTaskFromCatalog(loadProviderCatalog(providerConfigPath), task, registry), providerConfigPath, task, registry);
    }
  });
}
