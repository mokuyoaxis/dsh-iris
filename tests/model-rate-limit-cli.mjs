import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { useTempDshHome } from './test-env.js';
const { root } = useTempDshHome('iris-model-rate-limit-cli');
const file = path.join(root, 'providers.json');
const dataRoot = path.join(root, 'core');
const imagePath = path.join(root, 'red.png');
const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ff0000' } }).png().toBuffer();
fs.writeFileSync(imagePath, png);
const requests = [];
let imageStatus = 429, visionStatus = 429;
let imageCode = 'Throttling.AllocationQuota', visionCode = 'Throttling.RateQuota';
const server = http.createServer(async (req, res) => {
  const buffers = []; for await (const data of req) buffers.push(data);
  const input = JSON.parse(Buffer.concat(buffers)); requests.push({ url: req.url, model: input.model });
  const status = input.model === 'qwen-image-3.0-pro' ? imageStatus : input.model === 'bad-vision' ? visionStatus : 200;
  if (status !== 200) { res.writeHead(status, { 'Content-Type': 'application/json', 'Retry-After': '120' });
    res.end(JSON.stringify({ error: { code: input.model === 'qwen-image-3.0-pro' ? imageCode : visionCode,
      message: status === 403 && imageCode === 'AllocationQuota.FreeTierOnly' ? 'Free quota exhausted.' : 'Allocated quota exceeded, please increase your quota limit.' } })); return; }
  if (req.url === '/v1/chat/completions') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"choices":[{"delta":{"content":"红色"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
  } else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] })); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
fs.writeFileSync(file, JSON.stringify({ version: 1, other: { preserved: true }, providers: [{ id: 'account', type: 'openai', auth: 'none',
  baseUrl: `http://127.0.0.1:${server.address().port}/v1`, mediaProtocol: 'openai-images', models: [
    { id: 'qwen-image-3.0-pro', capabilities: ['image-gen'] }, { id: 'fallback-image', capabilities: ['image-gen'] },
    { id: 'bad-vision', capabilities: ['vision'] }, { id: 'fallback-vision', capabilities: ['vision'] }
  ] }], assignments: {} }), { mode: 0o600 });
const run = promisify(execFile);
const cli = async (args, expected = 0) => {
  let output;
  try { output = await run(process.execPath, ['bin/dsh-iris.js', ...args, '--provider-config', file], {
    env: { ...process.env, DSH_HOME: path.join(root, 'unused-dsh') }, timeout: 30000
  }); assert.equal(expected, 0); }
  catch (error) { assert.equal(error.code, expected, error.stderr || error.message); output = error; }
  return output.stdout.trim() ? JSON.parse(output.stdout) : { error: output.stderr };
};
const image = ['run', 'image', '--data-root', dataRoot, '--input', '{"prompt":"fixture"}'];
const vision = ['vision', 'look', '--input', JSON.stringify({ image_path: imagePath })];
try {
  const first = await cli(image);
  assert.equal(first.task.outcome, 'succeeded');
  assert.deepEqual(requests.map(item => item.model), ['qwen-image-3.0-pro', 'fallback-image']);
  let models = (await cli(['models', 'list'])).models;
  assert.equal(models.find(item => item.id === 'qwen-image-3.0-pro').rateLimited, true);
  const limit = JSON.parse(fs.readFileSync(file)).providers[0].health.rateLimits[0];
  assert.equal(Date.parse(limit.until) - Date.parse(limit.at), 120000, 'CLI 媒体读取 Retry-After');
  await cli(image);
  assert.deepEqual(requests.map(item => item.model), ['qwen-image-3.0-pro', 'fallback-image', 'fallback-image'], '新 CLI 进程也跳过 429 模型');
  const rejected = await cli(['run', 'image', '--data-root', dataRoot, '--input', '{"prompt":"explicit","model_ref":"account::qwen-image-3.0-pro"}'], 1);
  assert(rejected.error.includes('IRIS_PROVIDER_MODEL_RATE_LIMITED')); assert.equal(requests.length, 3);
  const failed = await cli(['models', 'test', 'account::qwen-image-3.0-pro', '--capability', 'image-gen', '--data-root', dataRoot], 1);
  assert.equal(failed.passed, false); assert.equal(requests.length, 4);
  assert.equal(JSON.parse(fs.readFileSync(file)).providers[0].health.rateLimits.length, 1);
  imageStatus = 200;
  assert.equal((await cli(['models', 'test', 'account::qwen-image-3.0-pro', '--capability', 'image-gen', '--data-root', dataRoot])).passed, true);
  await cli(image); assert.equal(requests.at(-1).model, 'qwen-image-3.0-pro');
  assert.equal((await cli(['models', 'list'])).models.find(item => item.id === 'qwen-image-3.0-pro').rateLimited, undefined);

  const beforeVision = requests.length;
  await cli(vision); await cli(vision);
  assert.deepEqual(requests.slice(beforeVision).map(item => item.model), ['bad-vision', 'fallback-vision', 'fallback-vision']);
  await cli([...vision, '--model-ref', 'account::bad-vision'], 1);
  assert.equal(requests.length, beforeVision + 3);
  assert.equal((await cli(['models', 'test', 'account::bad-vision', '--capability', 'vision'], 1)).passed, false);
  visionStatus = 200;
  assert.equal((await cli(['models', 'test', 'account::bad-vision', '--capability', 'vision'])).passed, true);
  await cli(vision); assert.equal(requests.at(-1).model, 'bad-vision');
  imageStatus = 403; imageCode = 'AllocationQuota.FreeTierOnly';
  await cli(image);
  const quota = (await cli(['models', 'list'])).models.find(item => item.id === 'qwen-image-3.0-pro');
  assert.equal(quota.reason, 'free_quota'); assert.equal(quota.retryAt, undefined);
  const beforeQuota = requests.length;
  await cli(image); assert.equal(requests.length, beforeQuota + 1); assert.equal(requests.at(-1).model, 'fallback-image');
  assert.equal((await cli(['models', 'test', 'account::qwen-image-3.0-pro', '--capability', 'image-gen', '--data-root', dataRoot], 1)).passed, false);
  imageStatus = 200;
  await cli(['models', 'test', 'account::qwen-image-3.0-pro', '--capability', 'image-gen', '--data-root', dataRoot]);
  visionStatus = 429; visionCode = 'BudgetLimitExceeded';
  await cli(vision);
  assert.equal((await cli(['models', 'list'])).models.find(item => item.id === 'bad-vision').reason, 'budget', 'HTTP 视觉保留供应商预算码');
  visionStatus = 200;
  await cli(['models', 'test', 'account::bad-vision', '--capability', 'vision']);
  visionStatus = 429; visionCode = 'Throttling.AllocationQuota';
  await cli(vision);
  let stored = JSON.parse(fs.readFileSync(file));
  const cooling = stored.providers[0].health.rateLimits.find(item => item.modelId === 'bad-vision');
  assert.equal(Date.parse(cooling.until) - Date.parse(cooling.at), 120000, 'HTTP 视觉也读取 Retry-After');
  cooling.until = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(file, JSON.stringify(stored));
  const beforeExpiry = requests.length;
  assert.equal((await cli(['models', 'list'])).models.find(item => item.id === 'bad-vision').rateLimited, undefined);
  assert.equal(requests.length, beforeExpiry, '冷却到期查询不发起隐式验证');
  visionStatus = 200;
  await cli(vision); assert.equal(requests.at(-1).model, 'bad-vision', '到期自动恢复候选资格');
  await cli(['models', 'test', 'account::bad-vision', '--capability', 'vision']);
  const saved = JSON.parse(fs.readFileSync(file));
  assert.equal(saved.version, 1); assert.deepEqual(saved.other, { preserved: true });
  assert.equal(saved.providers[0].health.rateLimits, undefined);
  assert.equal(saved.providers[0].health.observations.find(item => item.modelId === 'bad-vision').lastSuccess.source, 'probe');
  assert.equal(fs.existsSync(path.join(root, 'unused-dsh')), false, 'CLI 不隐式访问 DSH 配置');
  assert(fs.readdirSync(root).some(name => name.includes('backup')), '首次停用沿用配置备份');
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o077, 0);
  console.log('PASS 实际 CLI：Retry-After/冷却到期零探测、403 免费额度/429 预算、跨进程跳过、实测恢复、原配置与备份');
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
