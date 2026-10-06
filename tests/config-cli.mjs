import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { executeConfigCommand } from '../lib/provider-config-service.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-config-cli-'));
const file = path.join(root, 'providers.json');
const state = path.join(root, 'state.json');
fs.writeFileSync(state, JSON.stringify({ submit: 0, poll: 0, download: 0, tasks: {} }));
const env = { ...process.env, DSH_HOME: path.join(root, 'unused-dsh'), IRIS_ASYNC_FIXTURE_STATE: state };
const cli = (args, { input, status = 0 } = {}) => {
  const result = spawnSync(process.execPath, ['--import', new URL('./fixtures/headless-config-fetch.mjs', import.meta.url).href, 'bin/dsh-iris.js', ...args, '--provider-config', file], { encoding: 'utf8', env, input, timeout: 30000 });
  assert.equal(result.status, status, result.stderr);
  assert(!result.stdout.includes('fixture-private-secret'), '凭据不能出现在输出中');
  return result.status === 0 || result.stdout.trim() ? JSON.parse(result.stdout) : result;
};
try {
  cli(['config', 'init']);
  const seed = JSON.parse(fs.readFileSync(file)); seed.other = { preserve: 'unknown-field' };
  fs.writeFileSync(file, JSON.stringify(seed));
  const providerFile = path.join(root, 'provider-input.json');
  fs.writeFileSync(providerFile, JSON.stringify({ id: 'test', type: 'openai', apiKey: 'fixture-private-secret', baseUrl: 'https://configured.invalid/v1', models: [] }), { mode: 0o600 });
  const added = cli(['providers', 'add', '--input-file', providerFile]);
  assert.deepEqual(JSON.parse(fs.readFileSync(added.backupPath)), seed);
  cli(['models', 'add', 'test::qwen-vl-plus', '--input', '-',], { input: '{"capabilities":["vision"]}' });
  cli(['assignments', 'set', '--input', '{"capability":"vision","model_refs":["test::qwen-vl-plus"]}']);
  assert.deepEqual(cli(['assignments', 'list']).assignments.vision.model_refs, ['test::qwen-vl-plus']);
  assert.equal(cli(['models', 'list']).models.length, 1);
  const before = fs.readFileSync(file);
  assert.equal(cli(['models', 'discover', 'test']).changed, false);
  assert.deepEqual(fs.readFileSync(file), before);
  cli(['models', 'discover', 'test', '--apply', 'true']);
  assert.equal(cli(['models', 'list']).models.length, 2);
  assert.equal(cli(['models', 'test', 'test::qwen-vl-plus', '--capability', 'vision']).passed, true);
  const show = cli(['config', 'show']);
  assert.equal(show.models.find(model => model.id === 'qwen-vl-plus').verified.vision.ok, true);
  cli(['models', 'caps', 'test::qwen-vl-plus', '--input', '{"capabilities":[]}']);
  assert.equal(JSON.parse(fs.readFileSync(file)).assignments.vision, undefined);
  cli(['models', 'remove', 'test::gpt-image-1']);
  assert.equal(cli(['config', 'check']).valid, true);
  const changed = JSON.parse(fs.readFileSync(file)); changed.providers[0].models.push({ id: 'qwen-vl-plus', capabilities: ['vision'] });
  // 使用不重复的已有条目恢复能力。
  changed.providers[0].models = changed.providers[0].models.filter((entry, index, all) => all.findIndex(value => value.id === entry.id) === index);
  changed.providers[0].models.find(entry => entry.id === 'qwen-vl-plus').capabilities = ['vision'];
  fs.writeFileSync(file, JSON.stringify(changed));
  await assert.rejects(executeConfigCommand(file, 'models.test', { model_ref: 'test::qwen-vl-plus', capability: 'vision' }, { probe: async () => {
    const concurrent = JSON.parse(fs.readFileSync(file)); concurrent.concurrent = true; fs.writeFileSync(file, JSON.stringify(concurrent)); return { ok: true };
  } }), { code: 'IRIS_CONFIG_CHANGED' });
  assert.equal(JSON.parse(fs.readFileSync(file)).concurrent, true);
  const unrelated = JSON.parse(fs.readFileSync(file)); unrelated.assignments.tts = 'unknown-provider::old-model';
  fs.writeFileSync(file, JSON.stringify(unrelated));
  cli(['providers', 'remove', 'test']);
  assert.equal(JSON.parse(fs.readFileSync(file)).assignments.tts, 'unknown-provider::old-model', '不修剪与当前删除无关的旧失效分配');
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).other, seed.other);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o077, 0);
  assert.equal(fs.existsSync(path.join(root, 'unused-dsh')), false);
  console.log('PASS 配置 CLI：账号/模型/能力/分配、发现预览与合并、实测、脱敏、私有备份、未知字段保留、并发写保护、文件/stdin 输入');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
