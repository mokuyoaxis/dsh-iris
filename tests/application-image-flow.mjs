import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { loadProviderCatalog, imageCandidatesFromCatalog, providerTaskBinding } from '../lib/provider-catalog.js';
import { createConfiguredProviderAdapter } from '../lib/provider-adapters.js';
import { inspectCoreWriterLease } from '../lib/core-runtime.js';
import { listCoreTasks } from '../lib/core-tasks.js';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-application-image-flow');
const apps = [];
const roots = {}, configFiles = {};
const sourceBytes = await sharp({ create: { width: 48, height: 32, channels: 3, background: '#ff0000' } }).png().toBuffer();
const resultBytes = await sharp({ create: { width: 48, height: 32, channels: 3, background: '#00ff00' } }).png().toBuffer();
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const configDigests = {};
for (const account of ['a', 'b']) {
  roots[account] = path.join(root, 'core-' + account);
  configFiles[account] = path.join(root, 'providers-' + account + '.json');
  fs.writeFileSync(configFiles[account], JSON.stringify({ providers: [{ id: account,
    baseUrl: 'https://' + account + '.fixture.invalid/v1', apiKey: 'fixture-account-' + account,
    mediaProtocol: 'openai-images', models: [{ id: 'edit', capabilities: ['image-gen'], imageProtocol: 'openai-chat-images' }]
  }], assignments: { 'image-gen': [account + '::edit'] } }), { mode: 0o600 });
  configDigests[account] = sha(fs.readFileSync(configFiles[account]));
}
function application(account, withResolver = true) {
  const value = createApplicationRuntime({ dataRoot: roots[account], ...(withResolver ? { resolveImageCandidates: ({ modelRef, signal }) => {
    signal.throwIfAborted();
    const catalog = loadProviderCatalog(configFiles[account]);
    return imageCandidatesFromCatalog(catalog, modelRef).map(route => ({ adapter: createConfiguredProviderAdapter(route.provider),
      model: route.modelRef, selectionReason: route.selectionReason, providerBinding: providerTaskBinding(route.provider) }));
  } } : {}) });
  apps.push(value); return value;
}
let mode = 'image';
const requests = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = new URL(String(input));
  const account = url.hostname.split('.')[0];
  assert(['a', 'b'].includes(account));
  assert.equal(url.pathname, '/v1/chat/completions');
  assert.equal(new Headers(options.headers).get('authorization'), 'Bearer fixture-account-' + account);
  const body = JSON.parse(options.body);
  assert.equal(body.model, 'edit'); assert.equal(body.stream, false);
  assert.equal(body.messages[0].content[0].text, 'Change the rectangle to green');
  assert.equal(sha(Buffer.from(body.messages[0].content[1].image_url.url.split(',')[1], 'base64')), sha(sourceBytes));
  const submitting = listCoreTasks(roots[account]).tasks.filter(task => task.phase === 'submitting');
  assert.equal(submitting.length, 1, 'Task and Attempt must be persisted before HTTP');
  assert.equal(submitting[0].attempts.length, 1);
  assert.equal(submitting[0].sourceArtifactId, sources[account]);
  requests.push({ account, model: body.model });
  return Response.json({ choices: [{ message: { content: mode === 'image'
    ? '![edited](data:image/png;base64,' + resultBytes.toString('base64') + ')' : 'Only text, no image.' } }] });
};
const sources = {};
try {
  const a = application('a'), b = application('b');
  for (const [account, value] of [['a', a], ['b', b]]) {
    sources[account] = (await value.execute('artifact.import', { image_bytes: sourceBytes })).artifact.id;
    assert.equal(inspectCoreWriterLease(roots[account]).status, 'absent');
  }
  assert.equal(requests.length, 0);
  const editInput = account => ({ prompt: 'Change the rectangle to green', model_ref: account + '::edit', source_artifact_id: sources[account], n: 1 });
  const [edited] = await Promise.all([a.generateImage(editInput('a')), b.generateImage(editInput('b'))]);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(request => request.account).sort(), ['a', 'b']);
  assert.equal(edited.task.deliveryState, 'ready');
  assert.equal(edited.task.attempts[0].selectionReason, 'explicit');
  const id = edited.task.artifactIds[0];
  const inspected = (await a.execute('artifact.inspect', { artifact_id: id })).artifact;
  assert.equal(inspected.digest.value, sha(resultBytes));
  assert.deepEqual(inspected.relations, [{ type: 'derived-from', artifactId: sources.a }]);
  const diff = await a.execute('media.diff', { image_a_artifact_id: sources.a, image_b_artifact_id: id });
  assert.equal(diff.metrics.diffPixels, 48 * 32);
  assert.deepEqual(diff.artifact.relations.map(edge => edge.artifactId).sort(), [sources.a, id].sort());
  const output = path.join(root, 'edited.png');
  await a.execute('artifact.export', { artifact_id: id, output_path: output });
  assert.equal(sha(fs.readFileSync(output)), sha(resultBytes));
  const originalOutput = path.join(root, 'original.png');
  await a.execute('artifact.export', { artifact_id: sources.a, output_path: originalOutput });
  assert.equal(sha(fs.readFileSync(originalOutput)), sha(sourceBytes));
  await assert.rejects(a.execute('artifact.export', { artifact_id: id, output_path: output }), { code: 'IRIS_ARTIFACT_EXPORT_EXISTS' });
  await assert.rejects(b.execute('artifact.inspect', { artifact_id: id }), { code: 'IRIS_ARTIFACT_NOT_FOUND' });
  await assert.rejects(a.generateImage({ ...editInput('a'), model_ref: 'a::missing' }), { code: 'IRIS_PROVIDER_MODEL_UNAVAILABLE' });
  assert.equal((await a.execute('task.list', {})).total, 1);
  assert.equal(requests.length, 2);

  mode = 'text';
  const unknown = await a.generateImage(editInput('a'));
  assert.equal(unknown.task.acceptance, 'unknown');
  assert.equal(unknown.task.attempts.length, 1);
  assert.equal(requests.length, 3, 'uncertain response must not be resubmitted');
  await a.dispose();
  const reopened = application('a', false);
  assert.equal((await reopened.execute('task.inspect', { task_id: edited.task.id })).task.id, edited.task.id);
  assert.equal((await reopened.execute('artifact.list', {})).total, 3);
  const again = path.join(root, 'edited-again.png');
  await reopened.execute('artifact.export', { artifact_id: id, output_path: again });
  assert.equal(sha(fs.readFileSync(again)), sha(resultBytes));
  await assert.rejects(reopened.generateImage(editInput('a')), { code: 'IRIS_APP_IMAGE_RESOLVER_MISSING' });
  assert.equal(requests.length, 3, 'read/export/reopen does not resolve a Provider or submit');
  for (const account of ['a', 'b']) {
    assert.equal(sha(fs.readFileSync(configFiles[account])), configDigests[account]);
    assert.equal(inspectCoreWriterLease(roots[account]).status, 'absent');
    const records = listCoreTasks(roots[account]).tasks.map(task => fs.readFileSync(path.join(roots[account], 'task-store/v0/tasks', task.id + '.json'), 'utf8')).join('\n');
    for (const forbidden of ['fixture-account-', '.fixture.invalid', 'Change the rectangle', roots[account]]) assert(!records.includes(forbidden));
  }
  console.log('PASS Application 图片切片：显式配置 A/B、导入/改图/来源关系、差异分析/原字节导出、未知零重提、重开零 Provider、配置与 Task 隐私边界');
} finally {
  await Promise.allSettled(apps.map(value => value.dispose()));
  globalThis.fetch = originalFetch;
}
