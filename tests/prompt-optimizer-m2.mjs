import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { useTempDshHome } from './test-env.js';
useTempDshHome('iris-prompt-m2');
const { optimizePrompt } = await import('../lib/prompt-optimizer.js');
const config = await import('../lib/prompt-optimizer-config.js');
const { createDshHostAdapter } = await import('../lib/dsh-host-adapter.js');

let generated = 0;
let metadata;
let resolve = async () => metadata;
let request;
const llm = {
  resolveModelInfo: (...args) => resolve(...args),
  async *stream(value) {
    generated++; request = value;
    yield { type: 'text-delta', index: 0, text: '保持原意的完整正文' };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
};
const host = createDshHostAdapter({ get: name => name === 'llm' ? llm : undefined });
const input = { text: '原稿', route: { provider: 'p', model: 'm', reasoningEffort: 'high' } };
for (const effort of ['high', 'inherit']) {
  config.importPromptOptimizerConfig({ generation: { reasoningEffort: effort } });
  await assert.rejects(optimizePrompt(host, input), e => e.code === 'IRIS_MODEL_UNSUPPORTED');
  assert.equal(generated, 0, '未知元数据不透传显式/继承 effort');
}
config.importPromptOptimizerConfig({ generation: { reasoningEffort: 'inherit' } });
metadata = { reasoning: { efforts: [{ id: 'high' }] } };
await optimizePrompt(host, input);
assert.equal(request.reasoningEffort, 'high');
config.resetPromptOptimizerConfig();
metadata = undefined;
await optimizePrompt(host, input);
assert.equal(request.reasoningEffort, undefined, '未知能力默认不关闭也不继承');

const canceled = new AbortController(); canceled.abort();
const before = generated;
resolve = async () => { throw new Error('must not resolve'); };
await assert.rejects(optimizePrompt(host, input, { signal: canceled.signal }), e => e.code === 'IRIS_MODEL_ABORTED');
assert.equal(generated, before);
resolve = async (_p, _m, signal) => { assert(signal); return new Promise(() => {}); };
config.importPromptOptimizerConfig({ generation: { timeoutMs: 1000 } });
const start = performance.now();
await assert.rejects(optimizePrompt(host, input), e => e.code === 'IRIS_MODEL_TIMEOUT');
assert(performance.now() - start < 3000);
assert.equal(generated, before);

// 损坏配置的隔离是旧加载器副作用；只组装路径不触发加载器，也无需 Host 模型。
const file = config.promptOptimizerConfigFile();
fs.writeFileSync(file, '{broken');
config.resetPromptOptimizerConfigCache();
const original = fs.readFileSync(file);
const filesBefore = fs.readdirSync(path.dirname(file));
const absent = new Proxy({}, { get() { throw new Error('must not read Host'); } });
const local = await optimizePrompt(absent, { text: '  原稿  ', mode: 'assemble', rules: [
  { id: 'end', label: '结尾', kind: 'output', position: 'suffix', text: '禁止水印' }
] });
assert.equal(local.optimized, '  原稿  \n\n禁止水印');
assert.equal(local.route, null); assert.equal(local.configSource, 'not-loaded');
assert.deepEqual(fs.readFileSync(file), original);
assert.deepEqual(fs.readdirSync(path.dirname(file)), filesBefore, '无配置迁移、隔离或 Task/Artifact 文件写入');
assert.equal(generated, before);
console.log('ALL OK —— M2 DSH 入口：reasoning 显式/继承未知拒绝、元数据总预算、只组装零 Host/配置/Task 写入通过');
