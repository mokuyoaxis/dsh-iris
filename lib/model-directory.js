import crypto from 'node:crypto';
import { isKnownCapability } from './capability.js';
import { providerApiKey, providerMediaBaseUrl, selectMediaProtocol, providerForImageModel, providerForMusicModel } from './provider-protocol.js';

export const MODEL_DIRECTORY_TTL_MS = 10 * 60 * 1000;
export const MODEL_DIRECTORY_RETRY_MS = 30 * 1000;

/** 配置是外部输入，目录只接受不含连接凭据的固定数据形状。 */
export function validateModelDirectory(value) {
  if (value === undefined) return;
  if (!value || value.version !== 1 || !/^[a-f0-9]{64}$/.test(value.binding)
      || (value.checkedAt !== undefined && !Number.isFinite(Date.parse(value.checkedAt)))
      || (value.checkedAt && !Array.isArray(value.models))
      || (value.models !== undefined && (!Array.isArray(value.models) || value.models.some(model =>
        !model || typeof model.id !== 'string' || !model.id.trim() || !Array.isArray(model.capabilities)
        || !model.capabilities.every(isKnownCapability))))
      || (value.added !== undefined && (!Array.isArray(value.added) || !value.added.every(id => typeof id === 'string')))) {
    throw new TypeError('模型目录快照结构无效');
  }
}

/** 摘要绑定实际连接，不保存或回传密钥。 */
export function modelDirectoryBinding(provider) {
  return crypto.createHash('sha256').update(JSON.stringify([
    provider.id, provider.type || '', provider.baseUrl || '', providerMediaBaseUrl(provider), selectMediaProtocol(provider).mediaProtocol,
    provider.auth || 'bearer', providerApiKey(provider)
  ])).digest('hex');
}

export function currentModelDirectory(provider, { allowUnresolvedConnections = false } = {}) {
  const directory = provider?.modelDirectory;
  if (!directory || directory.version !== 1) return null;
  if (directory.binding === modelDirectoryBinding(provider)) return directory;
  return allowUnresolvedConnections && provider.dshProvider && !provider.baseUrl ? directory : null;
}

export function modelAvailabilityBinding(provider, modelId, capability) {
  if (capability === 'image-gen') return modelDirectoryBinding(providerForImageModel(provider, modelId));
  if (capability === 'music-gen' && provider.models?.some(model => model?.id === modelId && model.musicProtocol)) {
    return modelDirectoryBinding(providerForMusicModel(provider, modelId));
  }
  return modelDirectoryBinding(provider);
}

export function modelDirectoryEntry(provider, modelId, options) {
  return currentModelDirectory(provider, options)?.models?.find(model => model.id === modelId) || null;
}

export function modelDirectoryStatus(provider, modelId) {
  const directory = currentModelDirectory(provider, { allowUnresolvedConnections: true });
  if (!directory?.checkedAt) return 'unknown';
  return directory.models.some(model => model.id === modelId) ? 'listed' : 'unlisted';
}

/** 普通请求路径404或参数400不代表模型不存在。兼容已有精确404记录。 */
export function isModelNotFound(result) {
  if (result?.stage === 'poll') return false;
  const status = Number(result?.httpStatus ?? result?.status);
  if (status !== 404) return false;
  const code = String(result?.providerCode || result?.code || '');
  const message = String(result?.note || result?.safeMessage || result?.message || '');
  return /^(?:NotFound\.Model|model_not_found|ModelNotFound)$/i.test(code)
    || /\bModel not exist\./i.test(message);
}

/** 当前可选性与历史成功分开；旧Task成功不能解除新提交已确认的阻断。 */
export function modelUnavailable(provider, modelId, capability, { allowUnresolvedConnections = false } = {}) {
  const observation = provider?.health?.observations?.find(item => item.modelId === modelId && item.capability === capability);
  const availability = observation?.availability;
  if (availability) {
    if (availability.binding !== modelAvailabilityBinding(provider, modelId, capability)
        && !(allowUnresolvedConnections && provider.dshProvider && !provider.baseUrl)) return null;
    return availability.state === 'blocked' ? availability : null;
  }
  const failure = [observation?.lastTransient, observation?.lastFailure].filter(isModelNotFound)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
  if (!failure) return null;
  if (observation.lastSuccess?.source === 'probe' && observation.lastSuccess.at >= failure.at) return null;
  return { ...failure, state: 'blocked' };
}

export function modelUnavailableReason() {
  return '当前连接已返回模型不存在，已暂停自动选用；请核对目录后单独实测恢复';
}

export function modelDirectorySummary(provider) {
  const directory = currentModelDirectory(provider, { allowUnresolvedConnections: true });
  if (!directory) return { status: 'unknown', note: '尚未同步当前连接的模型目录' };
  const models = directory.models || [];
  const configuredIds = Array.isArray(provider.models)
    ? provider.models.map(model => typeof model === 'string' ? model : model.id)
    : [...new Set(['imageModel', 'videoModel', 'ttsModel', 'musicModel', 'transcribeModel', 'visionModel']
      .map(field => provider[field]).filter(id => typeof id === 'string' && id.trim()).map(id => id.trim()))];
  const missing = directory.checkedAt ? configuredIds.filter(id => !models.some(model => model.id === id)) : [];
  const stale = Boolean(directory.lastError) || Date.now() - Date.parse(directory.checkedAt || '') >= MODEL_DIRECTORY_TTL_MS
    || Date.parse(directory.invalidatedAt || '') >= Date.parse(directory.checkedAt || '');
  return {
    status: directory.checkedAt ? stale ? 'stale' : 'current' : 'unknown',
    checkedAt: directory.checkedAt || null, modelCount: models.length,
    added: directory.added || [], missing,
    ...(directory.lastError ? { error: directory.lastError, failedAt: directory.failedAt } : {})
  };
}
