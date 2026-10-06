import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createCoreRuntime } from '../lib/core-runtime.js';
import { createCoreArtifact } from '../lib/core-artifacts.js';
import { createCoreTask, beginCoreAttempt, recordCoreAttemptResult, finalizeCoreNoAcceptance } from '../lib/core-tasks.js';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-query-batch-')), dataRoot = path.join(root, 'core');
const runtime = createCoreRuntime({ dataRoot, mode: 'writer' }); runtime.start();
const ids = await runtime.run('execute', ({ dataRoot }) => {
  const image = createCoreArtifact(dataRoot, { bytes: Buffer.from('fixture-image'), mediaType: 'image/png', kind: 'image-fixture' });
  const text = createCoreArtifact(dataRoot, { bytes: Buffer.from('fixture text'), mediaType: 'text/plain', kind: 'transcript' });
  const task = createCoreTask(dataRoot, { capability: 'video' });
  const attempt = beginCoreAttempt(dataRoot, task.id, { providerId: 'fixture', model: 'fixture::video' });
  recordCoreAttemptResult(dataRoot, task.id, { id: attempt.id, providerId: 'fixture', model: 'fixture::video', resultKind: 'not_accepted', acceptance: 'not_accepted',
    error: { stage: 'submit', category: 'invalid_request', acceptance: 'not_accepted', retryable: false, safeMessage: '明确未受理' } });
  finalizeCoreNoAcceptance(dataRoot, task.id, '明确未受理');
  createCoreTask(dataRoot, { capability: 'image' });
  return { artifacts: [image, text], task: task.id };
});
await runtime.dispose();
const cli = (args, { input, status = 0 } = {}) => {
  const result = spawnSync(process.execPath, ['bin/dsh-iris.js', ...args, '--data-root', dataRoot], { encoding: 'utf8', input, timeout: 10000 });
  assert.equal(result.status, status, result.stderr); return result.stdout ? JSON.parse(result.stdout) : null;
};
try {
  assert.equal(cli(['task', 'list', '--capability', 'video']).total, 1);
  assert.equal(cli(['task', 'list', '--status', 'failed']).tasks[0].id, ids.task);
  assert.equal(cli(['task', 'list', '--offset', '1', '--limit', '1']).tasks.length, 1);
  assert.equal(cli(['artifact', 'list', '--kind', 'transcript']).artifacts[0].id, ids.artifacts[1].id);
  assert.equal(cli(['artifact', 'list', '--media-type', 'image/png', '--offset', '1']).total, 1);
  assert.equal(cli(['artifact', 'list', '--media-type', 'image/png', '--offset', '1']).artifacts.length, 0);
  cli(['task', 'list', '--limit', '201'], { status: 1 });
  const input = JSON.stringify({ artifact_ids: ids.artifacts.map(value => value.id) });
  assert.equal(cli(['artifact', 'inspect-many', '--input', '-'], { input }).results.length, 2);
  const missing = 'artifact_' + '0'.repeat(24);
  const mixed = cli(['artifact', 'inspect-many', '--input', JSON.stringify({ artifact_ids: [ids.artifacts[0].id, missing] })], { status: 1 });
  assert(mixed.results[0].artifact && mixed.results[1].error);
  const directory = path.join(root, 'exports'); fs.mkdirSync(directory);
  cli(['artifact', 'export-many', '--input', JSON.stringify({ artifact_ids: [ids.artifacts[0].id, missing] }), '--output', directory], { status: 1 });
  assert.equal(fs.readdirSync(directory).length, 0, '预检失败必须零导出');
  const inputFile = path.join(root, 'batch.json'); fs.writeFileSync(inputFile, input);
  const batch = cli(['artifact', 'export-many', '--input-file', inputFile, '--output', directory]);
  assert.equal(batch.results.filter(value => value.exported).length, 2);
  assert.equal(fs.readFileSync(path.join(directory, ids.artifacts[1].id + '.txt'), 'utf8'), 'fixture text');
  cli(['artifact', 'export-many', '--input', input, '--output', directory], { status: 1 });
  console.log('PASS 查询/批量 CLI：过滤后的分页/总数、混合查询错误、预检零导出、显式 ID 批量导出、无覆盖、文件/stdin');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
