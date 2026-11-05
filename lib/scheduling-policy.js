// Explicit startup policy; never discovers files or rewrites existing configuration.
import fs from 'node:fs';
import path from 'node:path';

export function schedulingError(code, message) {
  return Object.assign(new Error(message), { code, stage: 'prepare', category: 'rate_limit', acceptance: 'not_accepted' });
}
const invalid = message => { throw schedulingError('IRIS_SCHEDULER_CONFIG_INVALID', message); };
function fields(value, names, where) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(name => !names.includes(name))) invalid(`${where} 包含无效字段`);
}
function integer(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(`${name} 需要 ${min}–${max} 的整数`);
  return value;
}
function identity(value, where) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) invalid(`${where} 无效`);
  return value;
}
function limits(value, defaults = {}) {
  return Object.fromEntries([
    ['httpConcurrency', 1, 4], ['requestsPerSecond', 1, 1000], ['remoteLimit', 1, 1000]
  ].flatMap(([key, min, max]) => value[key] === undefined && defaults[key] === undefined ? []
    : [[key, integer(value[key] === undefined ? defaults[key] : value[key], min, max, key)]]));
}
export function checkedSchedulingPolicy(input) {
  fields(input, ['schemaVersion', 'httpConcurrency', 'requestsPerSecond', 'remoteLimit', 'queueLimit', 'queueTimeoutMs', 'providers'], '调度策略');
  if (input.schemaVersion !== 1) invalid('仅支持 scheduler schemaVersion=1；不会忽略或迁移其他版本');
  const providers = input.providers === undefined ? [] : input.providers;
  if (!Array.isArray(providers) || providers.length > 128) invalid('providers 需要至多 128 项的数组');
  const seen = new Set();
  return Object.freeze({ schemaVersion: 1, ...limits(input, { httpConcurrency: 4, requestsPerSecond: 2, remoteLimit: 8 }),
    queueLimit: integer(input.queueLimit === undefined ? 32 : input.queueLimit, 8, 128, 'queueLimit'),
    queueTimeoutMs: integer(input.queueTimeoutMs === undefined ? 30000 : input.queueTimeoutMs, 1, 300000, 'queueTimeoutMs'),
    providers: Object.freeze(providers.map(provider => {
      fields(provider, ['providerId', 'httpConcurrency', 'requestsPerSecond', 'remoteLimit', 'models'], '供应商策略');
      const providerId = identity(provider.providerId, 'providerId');
      if (seen.has(providerId)) invalid('providerId 重复'); seen.add(providerId);
      const models = provider.models === undefined ? [] : provider.models, ids = new Set();
      if (!Array.isArray(models) || models.length > 256) invalid('models 需要至多 256 项的数组');
      return Object.freeze({ providerId, ...limits(provider), models: Object.freeze(models.map(model => {
        fields(model, ['modelId', 'httpConcurrency', 'requestsPerSecond', 'remoteLimit'], '模型策略');
        const modelId = identity(model.modelId, 'modelId');
        if (ids.has(modelId)) invalid('modelId 重复'); ids.add(modelId);
        return Object.freeze({ modelId, ...limits(model) });
      })) });
    })) });
}
export function readSchedulingPolicy(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) invalid('scheduler-config 需要明确的绝对路径');
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 262144) invalid('scheduler-config 必须是 ≤256 KiB 的普通文件');
    if (process.platform !== 'win32' && (stat.mode & 0o077)) invalid('scheduler-config 请限制为仅当前用户可读写');
    const bytes = fs.readFileSync(fd);
    if (bytes.length > 262144) invalid('scheduler-config 过大');
    let value;
    try { value = JSON.parse(bytes.toString('utf8')); } catch { invalid('scheduler-config 不是有效 JSON'); }
    return checkedSchedulingPolicy(value);
  } catch (error) {
    if (error.code === 'IRIS_SCHEDULER_CONFIG_INVALID') throw error;
    throw schedulingError('IRIS_SCHEDULER_CONFIG_IO', '无法读取 scheduler-config；请检查路径、权限和文件状态，不会退回无调度模式');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}
