'use strict';
/**
 * T-01：apiKey 改为可选认证（审计 C-1）。
 *
 * 目的：让 ComfyUI / Ollama / 本地 TTS 这类**无鉴权的本地端点**能够配置使用。
 * 兼容性铁律：无 `auth` 字段时一律视为 'bearer'（要求 key）——现有用户行为完全不变。
 *
 * 运行：node tests/provider-auth-none.mjs
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-auth-none-'));
function cleanup() { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* ignore */ } }
process.on('exit', cleanup);

const home = path.join(root, 'home');
fs.mkdirSync(path.join(home, 'iris'), { recursive: true });
process.env.DSH_HOME = home;
process.env.IRIS_CONFIG = path.join(home, 'iris', 'config.json');

const config = await import('../lib/config.js');
const { imageCandidatesFromCatalog } = await import('../lib/provider-catalog.js');

/* ---------- 1. auth:'none' 且无 apiKey 的本地 provider 可进候选链 ---------- */
const saved = config.upsert({
  id: 'comfy', name: 'ComfyUI', enabled: true,
  auth: 'none',
  baseUrl: 'http://127.0.0.1:8188',
  models: [{ id: 'sd-xl', capabilities: ['image-gen'] }]
});
const realId = typeof saved === 'string' ? saved : saved.id;

{
  const list = config.providers();
  assert.ok(list.some((p) => p.id === realId),
    'auth:none 且无 apiKey 的本地 provider 必须进入候选链（否则本地部署配不进来）');
}

/* ---------- 2. modelHealth 不得对 auth:none 误报 unconfigured ---------- */
{
  const h = config.modelHealth(realId, 'sd-xl', 'image-gen');
  assert.notEqual(h.status, 'unconfigured',
    'auth:none 的 provider 不得被判为 unconfigured（它没有凭据需求）：' + JSON.stringify(h));
}

/* ---------- 3. CLI 候选链包含本地 provider ---------- */
{
  const catalog = { providers: config.allProviders(), assignments: {} };
  const cands = imageCandidatesFromCatalog(catalog, '');
  assert.ok(cands.some((c) => c.provider.id === realId),
    'CLI 候选链必须包含 auth:none 的本地 provider');
}

// RECOVERY 2026-09-23: lines above are an exact 55-line session read.
// The original suffix is unavailable. The following cases are reconstructed
// from the T-01 authentication contract and must not be counted as recovered bytes.

/* ---------- 4. Default bearer compatibility ---------- */
const model = [{ id: 'fixture-image', capabilities: ['image-gen'] }];
const noAuth = config.upsert({
  id: 'missing-default', name: 'default bearer without key', enabled: true,
  baseUrl: 'http://127.0.0.1:8188', models: model
});
const bearer = config.upsert({
  id: 'missing-bearer', name: 'explicit bearer without key', enabled: true,
  auth: 'bearer', baseUrl: 'http://127.0.0.1:8188', models: model
});
const keyed = config.upsert({
  id: 'keyed-bearer', name: 'bearer with key', enabled: true,
  apiKey: 'fixture-key', baseUrl: 'http://127.0.0.1:8188', models: model
});
const configured = config.providers().map((provider) => provider.id);
assert.ok(!configured.includes(noAuth.id) && !configured.includes(bearer.id),
  '缺省与显式 bearer 都必须继续要求 API Key');
assert.ok(configured.includes(keyed.id), '提供 API Key 的旧配置必须继续可用');
const candidateIds = imageCandidatesFromCatalog({
  providers: config.allProviders(), assignments: {}
}, '').map((candidate) => candidate.provider.id);
assert.ok(!candidateIds.includes(noAuth.id) && !candidateIds.includes(bearer.id)
  && candidateIds.includes(keyed.id), 'CLI 候选链必须保持 bearer 兼容门');

/* ---------- 5. No key means no Authorization header ---------- */
const { openAiGenerateImage } = await import('../lib/adapters.js');
const originalFetch = global.fetch;
const observed = [];
global.fetch = async (_url, init) => {
  observed.push(init.headers);
  return Response.json({ data: [{ b64_json: 'YWJj' }] });
};
try {
  await openAiGenerateImage({ key: '', baseUrl: 'http://127.0.0.1:8188/v1', model: 'fixture-image', prompt: 'fixture' });
  await openAiGenerateImage({ key: 'fixture-key', baseUrl: 'http://127.0.0.1:8188/v1', model: 'fixture-image', prompt: 'fixture' });
} finally {
  global.fetch = originalFetch;
}
assert.equal(observed.length, 2, 'header fixture 必须覆盖无 key 与有 key');
assert.equal(Object.hasOwn(observed[0], 'Authorization'), false,
  '无认证模式不得发送 Authorization 或 Bearer undefined');
assert.equal(observed[1].Authorization, 'Bearer fixture-key',
  'bearer 模式仍须发送原有认证头');

console.log('auth:none candidate, bearer compatibility and HTTP header tests passed');
