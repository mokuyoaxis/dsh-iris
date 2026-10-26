// Owner-only editing boundary. No I/O, secrets in projections, or implicit model authorization.
import { CAPABILITIES } from './capability.js';
import { providerModels, modelPool, functionPolicy, savedAssignmentRefs, resolvePoolModel } from './models.js';
import { BUILTIN_PROVIDER_PROTOCOLS, normalizeMediaEndpoint, normalizeImageProtocol, normalizeMusicProtocol, selectMediaProtocol, providerForModelBinding, isConfiguredProvider } from './provider-protocol.js';
import { clearModelCapabilityHealth, resetHealthOnCriticalChange } from './provider-health.js';
import { checkedComfyWorkflow, projectComfyWorkflow } from './comfyui-workflow.js';

const CAPS = Object.values(CAPABILITIES);
const fail = message => { throw Object.assign(new Error(message), { code: 'IRIS_CONFIG_INPUT_INVALID' }); };
function object(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) fail('设置包含不支持的字段');
}
function string(value, max, empty = false) {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value) || !empty && !value.trim()) fail('设置文本为空、过长或含控制字符');
  return value.trim();
}
function capabilities(value) {
  if (!Array.isArray(value) || value.some(cap => !CAPS.includes(cap)) || new Set(value).size !== value.length) fail('模型用途必须是已知能力的非重复数组');
  return [...value];
}
const protocols = registry => registry ? registry.snapshot().protocols : BUILTIN_PROVIDER_PROTOCOLS;

export function projectProviderSettings(catalog, revision, registry) {
  const pool = modelPool(catalog.providers, { includeHostVision: true });
  const result = { contractVersion: 0, source: 'explicit-provider-config', revision,
    protocols: protocols(registry).map(({ id, label, capabilities, configuration }) => ({ id, label, capabilities, configuration })),
    capabilities: CAPS,
    providers: catalog.providers.map(provider => ({ id: provider.id, name: provider.name || provider.id,
      baseUrl: provider.baseUrl || '', mediaBaseUrl: provider.mediaBaseUrl || '',
      enabled: provider.enabled !== false, auth: provider.auth === 'none' ? 'none' : 'bearer',
      hasCredential: Boolean(provider.apiKey), configured: isConfiguredProvider(provider),
      mediaProtocol: selectMediaProtocol(provider).mediaProtocol,
      models: providerModels(provider).map(model => ({ id: model.id, ref: model.ref, capabilities: model.capabilities,
        imageProtocol: model.imageProtocol || 'auto', musicProtocol: model.musicProtocol || '',
        ...(provider.models?.find(entry => entry?.id === model.id)?.comfyWorkflow ? {
          comfyWorkflow: projectComfyWorkflow(provider.models.find(entry => entry?.id === model.id).comfyWorkflow) } : {}),
        catalogStatus: model.catalogStatus || 'unknown', unavailableCapabilities: model.unavailableCapabilities || [],
        rateLimited: model.rateLimited === true,
        verified: Object.fromEntries(Object.entries(model.verified || {}).map(([cap, value]) => [cap, {
          ok: value.ok === true, at: value.at, category: value.category
        }])) })) })),
    assignments: Object.fromEntries(CAPS.map(cap => {
      const policy = functionPolicy(catalog.assignments?.[cap], cap);
      return [cap, { ...policy, models: savedAssignmentRefs(pool, cap, policy.models) }];
    })) };
  // A mistakenly pasted key in a display field must not become a key read-back route.
  const keys = catalog.providers.map(provider => provider.apiKey).filter(key => typeof key === 'string' && key);
  const scrub = value => typeof value === 'string' ? keys.reduce((s, key) => s.split(key).join('[redacted]'), value)
    : Array.isArray(value) ? value.map(scrub) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item)])) : value;
  return scrub(result);
}

export function applyProviderSettings(catalog, input, registry) {
  object(input, ['expectedRevision', 'provider', 'credential', 'assignments']);
  object(input.provider, ['id', 'name', 'baseUrl', 'mediaBaseUrl', 'mediaProtocol', 'enabled', 'auth', 'models']);
  object(input.credential, ['action', 'value']);
  const value = input.provider, id = string(value.id, 160);
  const matches = catalog.providers.filter(item => item.id === id);
  if (matches.length > 1) fail('供应商 ID 重复，请在本机核对');
  const previous = matches[0];
  const next = { ...previous, id, name: string(value.name, 80), baseUrl: string(value.baseUrl, 2048),
    mediaBaseUrl: string(value.mediaBaseUrl ?? '', 2048, true), mediaProtocol: string(value.mediaProtocol, 80),
    enabled: value.enabled, auth: value.auth };
  next.protocolInferred = false;
  if (typeof next.enabled !== 'boolean' || !['bearer', 'none'].includes(next.auth)) fail('供应商启用或认证方式无效');
  try { normalizeMediaEndpoint(next.baseUrl); if (next.mediaBaseUrl) normalizeMediaEndpoint(next.mediaBaseUrl); }
  catch (_) { fail('地址必须是无凭据、查询或片段的 HTTP(S) URL'); }
  if (!protocols(registry).some(item => item.id === next.mediaProtocol) && previous?.mediaProtocol !== next.mediaProtocol) fail('协议未注册，请先显式加载对应扩展');
  const credential = input.credential;
  if (!['keep', 'replace', 'clear'].includes(credential.action) || credential.action !== 'replace' && Object.hasOwn(credential, 'value')) fail('密钥操作必须是 keep、replace 或 clear');
  if (credential.action === 'replace') next.apiKey = string(credential.value, 8192);
  if (credential.action === 'clear') delete next.apiKey;
  if (!Array.isArray(value.models) || value.models.length > 256) fail('单次最多保存 256 个模型');
  const existing = providerModels(previous || {});
  const entries = Array.isArray(previous?.models) ? previous.models.map(model => typeof model === 'string' ? { id: model } : { ...model })
    : existing.map(({ id, capabilities }) => ({ id, capabilities }));
  const ids = new Set();
  for (const model of value.models) {
    object(model, ['id', 'capabilities', 'imageProtocol', 'musicProtocol', 'comfyWorkflow']);
    const modelId = string(model.id, 512);
    if (ids.has(modelId)) fail('模型 ID 重复');
    ids.add(modelId);
    const old = entries.find(entry => entry.id === modelId), oldView = existing.find(entry => entry.id === modelId);
    const updated = { ...old, id: modelId, capabilities: capabilities(model.capabilities) };
    if (model.comfyWorkflow !== undefined) updated.comfyWorkflow = checkedComfyWorkflow(model.comfyWorkflow);
    if (!oldView || JSON.stringify(oldView.capabilities) !== JSON.stringify(updated.capabilities)) updated.source = 'manual';
    if (model.imageProtocol !== undefined) {
      const protocol = model.imageProtocol === old?.imageProtocol ? model.imageProtocol : normalizeImageProtocol(model.imageProtocol, registry);
      if (protocol === 'auto') delete updated.imageProtocol; else updated.imageProtocol = protocol;
    }
    if (model.musicProtocol !== undefined) {
      if (model.musicProtocol === '') delete updated.musicProtocol;
      else updated.musicProtocol = model.musicProtocol === old?.musicProtocol ? model.musicProtocol : normalizeMusicProtocol(model.musicProtocol, registry);
    }
    if (old) entries[entries.indexOf(old)] = updated; else entries.push(updated);
  }
  next.models = entries; // Omitted existing records survive. The Web has no hard-delete operation.
  if (previous) {
    const previousConnection = { ...previous, auth: previous.auth === 'none' ? 'none' : 'bearer',
      mediaBaseUrl: previous.mediaBaseUrl || '', mediaProtocol: selectMediaProtocol(previous).mediaProtocol };
    resetHealthOnCriticalChange(previousConnection, next, next);
    for (const model of existing) {
      const updated = next.models.find(entry => entry.id === model.id);
      const connectionChanged = ['apiKey', 'baseUrl', 'mediaBaseUrl', 'auth', 'mediaProtocol'].some(key => previousConnection[key] !== next[key]);
      for (const cap of model.capabilities) if (connectionChanged || !updated.capabilities?.includes(cap)
        || cap === 'image-gen' && JSON.stringify(previous.models?.find(entry => entry?.id === model.id)?.comfyWorkflow) !== JSON.stringify(updated.comfyWorkflow)
        || cap === 'image-gen' && providerForModelBinding(previous, model.id, cap).mediaProtocol !== providerForModelBinding(next, model.id, cap).mediaProtocol
        || cap === 'music-gen' && previous.models?.find(entry => entry.id === model.id)?.musicProtocol !== updated.musicProtocol) {
        clearModelCapabilityHealth(next, model.id, cap);
      }
    }
    catalog.providers[catalog.providers.indexOf(previous)] = next;
  } else catalog.providers.push(next);
  if (input.assignments !== undefined) {
    object(input.assignments, CAPS);
    const pool = modelPool(catalog.providers, { includeHostVision: true });
    catalog.assignments ||= {};
    for (const [cap, assignment] of Object.entries(input.assignments)) {
      object(assignment, ['mode', 'models', 'hostVision']);
      let policy;
      try { policy = functionPolicy(assignment, cap); } catch (_) { fail('功能策略无效'); }
      if (!Object.hasOwn(assignment, 'mode') || new Set(policy.models).size !== policy.models.length || policy.models.length > 256) fail('功能策略或模型顺序无效');
      // Existing invalid refs may be retained for diagnosis, but never newly authorized.
      const oldRefs = savedAssignmentRefs(pool, cap, functionPolicy(catalog.assignments[cap], cap).models);
      for (const ref of policy.models) if (!resolvePoolModel(pool, ref, cap) && !oldRefs.includes(ref)) fail('用途引用了不存在或未标注该能力的模型');
      catalog.assignments[cap] = { mode: policy.mode, models: policy.models, ...(cap === 'vision' ? { hostVision: policy.hostVision } : {}) };
    }
  }
  return catalog;
}
