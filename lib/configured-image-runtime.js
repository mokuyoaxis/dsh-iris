// Shared CLI/service assembly. Configuration is read only during explicit commands.
import path from 'node:path';
import { loadProviderCatalog, imageCandidatesFromCatalog, ttsCandidatesFromCatalog, transcribeCandidatesFromCatalog, videoCandidatesFromCatalog, visionCandidatesFromCatalog, providerForTaskFromCatalog, providerTaskBinding, visionTaskBinding } from './provider-catalog.js';
import { createVisionProviderAdapter } from './vision-provider-adapter.js';
import { createConfiguredProviderAdapter } from './provider-adapters.js';
import { recordCatalogAvailability, recordCatalogRateLimit } from './provider-config-service.js';
import { parseModelRef } from './models.js';
import { supportsImageEdit } from './provider-protocol.js';
import { compileComfyWorkflow } from './comfyui-workflow.js';
import { providerNetworkRequirement, sameNetworkRequirement, networkPolicyError } from './network-policy.js';

export function createTrackedProviderAdapter(provider, providerConfigPath, task, registry, { network, modelRef, capability, deferCooling = false } = {}) {
  if (task && !sameNetworkRequirement(task.networkRequirement, providerNetworkRequirement(provider))) {
    throw networkPolicyError('IRIS_NETWORK_REQUIREMENT_MISMATCH', '原 Task 的网络要求与当前供应商目录不一致；不会隐式转换或解除');
  }
  const create = task?.capability === 'vision' || capability === 'vision' ? createVisionProviderAdapter : createConfiguredProviderAdapter;
  return create(provider, {
    registry,
    ...(network !== undefined ? { network } : {}),
    modelId: parseModelRef(task?.modelRef || modelRef)?.modelId,
    deferCooling,
    onModelAvailability: event => recordCatalogAvailability(providerConfigPath, event),
    onRateLimit: event => recordCatalogRateLimit(providerConfigPath, event)
  });
}

export function configuredImagePorts(providerConfigPath, registry, { resolveProviderNetwork, deferCooling = false } = {}) {
  if (typeof providerConfigPath !== 'string' || !path.isAbsolute(providerConfigPath)) throw new TypeError('Provider 配置须为显式绝对路径');
  if (resolveProviderNetwork !== undefined && typeof resolveProviderNetwork !== 'function') throw new TypeError('resolveProviderNetwork 必须是函数');
  const adapterFor = (provider, task, modelRef, capability) => createTrackedProviderAdapter(provider, providerConfigPath, task, registry, {
    modelRef, capability, deferCooling,
    network: resolveProviderNetwork?.({ providerId: provider.id, modelRef: modelRef || task?.modelRef, taskId: task?.id,
      ...(providerNetworkRequirement(provider) ? { networkRequirement: providerNetworkRequirement(provider) } : {}) })
  });
  return Object.freeze({
    resolveVisionCandidates({ modelRef, signal }) {
      signal?.throwIfAborted();
      return visionCandidatesFromCatalog(loadProviderCatalog(providerConfigPath), modelRef, registry, { deferCooling }).map(route => ({
        adapter: adapterFor(route.provider, undefined, route.modelRef, 'vision'), model: route.modelRef,
        providerBinding: visionTaskBinding(route.provider, route.model), selectionReason: 'explicit'
      }));
    },
    resolveVideoCandidates({ modelRef, signal }) {
      signal?.throwIfAborted();
      return videoCandidatesFromCatalog(loadProviderCatalog(providerConfigPath), modelRef, registry, { deferCooling }).map(route => ({
        adapter: adapterFor(route.provider, undefined, route.modelRef), model: route.modelRef,
        providerBinding: providerTaskBinding(route.provider, registry), selectionReason: 'explicit'
      }));
    },
    resolveAudioCandidates({ capability, modelRef, signal }) {
      signal?.throwIfAborted();
      if (!['tts', 'transcribe'].includes(capability)) throw new TypeError('未知音频能力');
      const select = capability === 'tts' ? ttsCandidatesFromCatalog : transcribeCandidatesFromCatalog;
      return select(loadProviderCatalog(providerConfigPath), modelRef, registry, { deferCooling }).map(route => ({
        adapter: adapterFor(route.provider, undefined, route.modelRef), model: route.modelRef,
        providerBinding: providerTaskBinding(route.provider, registry), selectionReason: 'explicit'
      }));
    },
    resolveImageCandidates({ modelRef, signal, input }) {
      signal?.throwIfAborted();
      return imageCandidatesFromCatalog(loadProviderCatalog(providerConfigPath), modelRef, registry, { deferCooling }).map(route => {
        if (input?.workflow_parameters !== undefined) {
          if (route.provider.mediaProtocol !== 'comfyui') throw Object.assign(new TypeError('工作流参数仅用于 ComfyUI 模板'), { code: 'IRIS_COMFYUI_PARAMETERS_INVALID' });
          compileComfyWorkflow(route.provider.comfyWorkflow, input);
        }
        return {
          adapter: adapterFor(route.provider, undefined, route.modelRef), model: route.modelRef,
          supportsImageEdit: supportsImageEdit(route.provider.mediaProtocol, route.model, registry),
          providerBinding: providerTaskBinding(route.provider, registry), selectionReason: 'explicit'
        };
      });
    },
    resolveTaskAdapter(task, { signal } = {}) {
      signal?.throwIfAborted();
      return adapterFor(providerForTaskFromCatalog(loadProviderCatalog(providerConfigPath), task, registry), task);
    }
  });
}
