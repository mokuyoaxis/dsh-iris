import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listCoreTasks } from '../lib/core-tasks.js';
import { flowSha256 } from '../lib/flow-store.js';
import { FLOW_SOURCE, FLOW_RESULT } from './fixtures/image-flow-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-flow-cli');
const dataRoot = path.join(root, 'core'), configFile = path.join(root, 'providers.json');
const cliFile = fileURLToPath(new URL('../bin/dsh-iris.js', import.meta.url));
const children = new Set();
const calls = [];
let mode = 'image', runId;
const server = http.createServer(async (request, response) => {
  try {
    assert.equal(request.url, '/v1/chat/completions');
    assert.equal(request.headers.authorization, 'Bearer fixture-flow-secret');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    assert.equal(body.model, 'edit');
    assert.equal(flowSha256(Buffer.from(body.messages[0].content[1].image_url.url.split(',')[1], 'base64')), flowSha256(FLOW_SOURCE));
    const run = JSON.parse(fs.readFileSync(path.join(dataRoot, 'flow-store/v0/runs', runId + '.json'), 'utf8'));
    const task = listCoreTasks(dataRoot).tasks.find(task => task.id === run.edit.taskId);
    assert.equal(run.edit.claimed, true); assert.equal(task.phase, 'submitting'); assert.equal(task.attempts.length, 1);
    calls.push({ taskId: task.id, runId: run.id, prompt: body.messages[0].content[0].text });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: mode === 'image'
      ? '![edited](data:image/png;base64,' + FLOW_RESULT.toString('base64') + ')' : 'No image returned.' } }] }));
  } catch (error) {
    response.writeHead(500, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: error.message } }));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const config = { providers: [{ id: 'account', baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', apiKey: 'fixture-flow-secret',
  mediaProtocol: 'openai-images', models: [{ id: 'edit', capabilities: ['image-gen'], imageProtocol: 'openai-chat-images' }] }],
assignments: { 'image-gen': ['account::edit'] } };
fs.writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
const configBytes = fs.readFileSync(configFile);
let commands = 0;
async function cli(args, expected = 0) {
  commands++;
  const child = spawn(process.execPath, [cliFile, ...args, '--data-root', dataRoot], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 45000);
  try {
    const [status, signal] = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signaled) => resolve([code, signaled])); });
    assert.equal(signal, null, args.join(' ') + ': ' + stderr);
    assert.equal(status, expected, args.join(' ') + ': ' + stderr);
    return expected ? { stdout, stderr } : JSON.parse(stdout);
  } finally { clearTimeout(timer); children.delete(child); }
}
try {
  await cli(['flow', 'init']);
  const sourceFile = path.join(root, 'source.png'); fs.writeFileSync(sourceFile, FLOW_SOURCE);
  const imported = await cli(['artifact', 'import', '--input', JSON.stringify({ image_path: sourceFile })]);
  const created = await cli(['flow', 'create', '--provider-config', configFile, '--input', JSON.stringify({
    prompt: 'Turn this rectangle green', model_ref: 'account::edit', source_artifact_id: imported.artifact.id })]);
  runId = created.run.id;
  assert.equal(created.task, null); assert.equal(calls.length, 0);
  assert.equal((await cli(['flow', 'list'])).total, 1);
  assert.equal((await cli(['flow', 'inspect', runId])).status, 'not_started');
  const continued = await cli(['flow', 'continue', runId, '--provider-config', configFile]);
  assert.equal(continued.status, 'awaiting_selection'); assert.equal(continued.metrics.diffPixels, 48 * 32);
  assert.equal(calls.length, 1); assert.equal(calls[0].taskId, created.run.edit.taskId);
  assert.equal((await cli(['flow', 'continue', runId, '--provider-config', path.join(root, 'missing.json')])).task.id, created.run.edit.taskId);
  await cli(['flow', 'select', runId, '--input', JSON.stringify({ artifact_id: continued.run.output.artifactId })]);
  const target = path.join(root, 'selected.png');
  await cli(['flow', 'export', runId, '--output', target]);
  assert.equal(flowSha256(fs.readFileSync(target)), flowSha256(FLOW_RESULT));
  assert((await cli(['flow', 'export', runId, '--output', target], 1)).stderr.includes('IRIS_ARTIFACT_EXPORT_EXISTS'));
  const blocked = JSON.parse((await cli(['core', 'delete', '--input', JSON.stringify({ task_ids: [continued.task.id],
    artifact_ids: [imported.artifact.id, continued.run.output.artifactId, continued.run.comparison.artifactId] })], 1)).stdout);
  assert.equal(blocked.allowed, false); assert(blocked.blockers.some(item => item.reason === 'flow_task_reference'));
  assert((await cli(['core', 'delete', '--input', JSON.stringify({ artifact_ids: [continued.run.output.artifactId] }), '--confirm-delete'], 1)).stderr.includes('BLOCKED'));

  const drift = await cli(['flow', 'create', '--provider-config', configFile, '--input', JSON.stringify({
    prompt: 'Pending green edit', model_ref: 'account::edit', source_artifact_id: imported.artifact.id })]);
  config.providers[0].baseUrl += '/changed'; fs.writeFileSync(configFile, JSON.stringify(config));
  assert((await cli(['flow', 'continue', drift.run.id, '--provider-config', configFile], 1)).stderr.includes('IRIS_FLOW_PROVIDER_CHANGED'));
  assert.equal(calls.length, 1); fs.writeFileSync(configFile, configBytes);
  const uncertain = await cli(['flow', 'create', '--provider-config', configFile, '--input', JSON.stringify({
    prompt: 'Uncertain response edit', model_ref: 'account::edit', source_artifact_id: imported.artifact.id })]);
  runId = uncertain.run.id; mode = 'text';
  assert.equal((await cli(['flow', 'continue', runId, '--provider-config', configFile])).status, 'needs_attention');
  assert.equal((await cli(['flow', 'continue', runId])).status, 'needs_attention');
  assert.equal(calls.length, 2);
  assert.deepEqual(fs.readFileSync(configFile), configBytes);
  assert.deepEqual(fs.readFileSync(sourceFile), FLOW_SOURCE);
  const runs = fs.readdirSync(path.join(dataRoot, 'flow-store/v0/runs')).map(name => fs.readFileSync(path.join(dataRoot, 'flow-store/v0/runs', name), 'utf8')).join('\n');
  for (const forbidden of ['fixture-flow-secret', configFile, dataRoot, '127.0.0.1']) assert(!runs.includes(forbidden));
  console.log('PASS Image Flow CLI：' + commands + ' 个独立进程，真实 localhost HTTP 写前 Task/Attempt、零提交 create/读取、稳定继续/比较/导出、配置漂移、引用保护、未知零重提');
} finally {
  for (const child of children) child.kill('SIGKILL');
  await new Promise(resolve => server.close(resolve));
}
