import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempDshHome } from './test-env.js';

useTempDshHome('iris-provider-health-store');
const config = await import('../lib/config.js');

const p1 = config.upsert({
  name: 'primary',
  type: 'openai',
  baseUrl: 'https://example.invalid/v1',
  apiKey: 'sk-primary-secret-value',
  enabled: true,
  mediaProtocol: 'openai-images',
  models: [{ id: 'gpt-image-1', capabilities: ['image-gen'] }]
});
let snapshot = config.providerHealthSnapshot();
assert.equal(snapshot.capabilities['image-gen'].status, 'configured');
assert.equal(snapshot.overall, 'configured');
assert.equal(snapshot.capabilities['video-gen'].status, 'unconfigured');

assert.equal(config.recordProviderHealth(p1.id, 'gpt-image-1', 'image-gen', {
  ok: true, source: 'task', note: '生成成功'
}), true);
snapshot = config.providerHealthSnapshot();
assert.equal(snapshot.capabilities['image-gen'].status, 'verified');
assert.equal(snapshot.overall, 'verified');
assert.equal(snapshot.capabilities['image-gen'].candidates[0].source, 'task');
const verifiedAt = snapshot.capabilities['image-gen'].candidates[0].observedAt;

config.recordProviderHealth(p1.id, 'gpt-image-1', 'image-gen', {
  ok: false, source: 'task', category: 'rate_limit', httpStatus: 429, note: 'quota'
});
snapshot = config.providerHealthSnapshot();
assert.equal(snapshot.capabilities['image-gen'].status, 'verified',
  '429 不覆盖近期成功');
assert.equal(snapshot.capabilities['image-gen'].candidates[0].observedAt, verifiedAt,
  '绿色时间必须保留最近成功时间，不能被较新的临时错误冒充');
assert.equal(snapshot.capabilities['image-gen'].candidates[0].source, 'task');

config.recordProviderHealth(p1.id, 'gpt-image-1', 'image-gen', {
  ok: false,
  source: 'probe',
  category: 'authentication',
  httpStatus: 401,
  note: 'bad sk-primary-secret-value'
});
snapshot = config.providerHealthSnapshot();
assert.equal(snapshot.capabilities['image-gen'].status, 'failed');
assert(!JSON.stringify(snapshot).includes('sk-primary-secret-value'), '健康快照不得泄露 Key');

const p2 = config.upsert({
  name: 'fallback',
  type: 'openai',
  baseUrl: 'https://fallback.invalid/v1',
  apiKey: 'sk-fallback-secret-value',
  enabled: true,
  mediaProtocol: 'openai-images',
  models: [{ id: 'gpt-image-2', capabilities: ['image-gen'] }]
});
snapshot = config.providerHealthSnapshot();
assert.equal(snapshot.capabilities['image-gen'].status, 'configured',
  '红色候选加未验证 fallback 应汇总为蓝色');

config.recordProviderHealth(p2.id, 'gpt-image-2', 'image-gen', {
  ok: true, source: 'probe', note: 'probe ok'
});
assert.equal(config.providerHealthSnapshot().capabilities['image-gen'].status, 'verified',
  'fallback 成功使功能汇总为绿色');

config.upsert({ id: p2.id, apiKey: 'sk-fallback-changed-value' });
snapshot = config.providerHealthSnapshot();
const fallback = snapshot.capabilities['image-gen'].candidates.find((item) => item.providerId === p2.id);
assert.equal(fallback.status, 'configured', 'Key 变化使旧验证失效');
config.upsert({ id: p2.id, enabled: false });
assert.equal(config.providerHealthSnapshot().capabilities['image-gen'].status, 'failed',
  '只剩明确认证失败候选时为暗红');

config.upsert({ id: p1.id, apiKey: '' });
assert.equal(config.providerHealthSnapshot().capabilities['image-gen'].status, 'unconfigured',
  '无 API 候选回到灰色');

// 汇总时间必须来自获胜状态，不能用更新的蓝色临时观察冒充绿色验证时间。
const p3 = config.upsert({
  name: 'winner', baseUrl: 'https://winner.invalid/v1', apiKey: 'winner-key', enabled: true,
  mediaProtocol: 'openai-images', models: [{ id: 'winner-image', capabilities: ['image-gen'] }]
});
const p4 = config.upsert({
  name: 'newer-transient', baseUrl: 'https://transient.invalid/v1', apiKey: 'transient-key', enabled: true,
  mediaProtocol: 'openai-images', models: [{ id: 'transient-image', capabilities: ['image-gen'] }]
});
const successAt = '2026-09-09T10:00:00.000Z';
config.recordProviderHealth(p3.id, 'winner-image', 'image-gen', { ok: true, source: 'task', at: successAt, note: '' });
config.recordProviderHealth(p4.id, 'transient-image', 'image-gen', {
  ok: false, source: 'task', at: '2026-09-09T11:00:00.000Z', category: 'rate_limit', httpStatus: 429, note: 'later transient'
});
snapshot = config.providerHealthSnapshot({ now: Date.parse('2026-09-09T12:00:00.000Z') });
assert.equal(snapshot.capabilities['image-gen'].status, 'verified');
assert.equal(snapshot.capabilities['image-gen'].observedAt, successAt,
  '绿色汇总时间只能取绿色候选的成功证据');
assert.equal(config.modelHealth(p3.id, 'winner-image', 'image-gen', { now: Date.parse('2026-09-09T12:00:00.000Z') }).note, undefined,
  '空成功说明不得伪造成供应商操作失败');

// 模型从有效池移除后应裁掉证据；重新添加必须回到待验证蓝色。
config.setProviderModels(p3.id, []);
config.setProviderModels(p3.id, [{ id: 'winner-image', capabilities: ['image-gen'] }]);
assert.equal(config.modelHealth(p3.id, 'winner-image', 'image-gen').status, 'configured',
  '模型移除再添加不得复活旧绿色证据');

const saved = JSON.parse(fs.readFileSync(path.join(process.env.DSH_HOME, 'iris', 'v1', 'providers.json'), 'utf8'));
const storedP1 = saved.providers.find((item) => item.id === p1.id);
assert(storedP1.health && storedP1.health.version === 1, '健康事实应持久化');
assert(!JSON.stringify(storedP1.health).includes('primary-secret'), '持久健康事实不得泄露 Key');

console.log('ALL OK —— Provider 健康持久化、失效、脱敏和 failover 汇总通过');
