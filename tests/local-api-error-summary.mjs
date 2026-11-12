import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { projectLocalApiFlow } from '../lib/local-api-projection.js';
import { ProviderContractError } from '../lib/provider-contract.js';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { createConnectionPair } from '../lib/core-connections.js';
import { FLOW_MODEL, FLOW_SOURCE, imageFlowFixture } from './fixtures/image-flow-fixture.mjs';
import { httpMcpClient } from './fixtures/mcp-http-client.mjs';
import { useTempDshHome } from './test-env.js';

const facts = {
  contractVersion: 0, status: 'needs_attention',
  run: { id: 'run_' + '1'.repeat(24), recipe: 'image-generate/v0', revision: 2,
    createdAt: '2026-11-11T00:00:00.000Z', updatedAt: '2026-11-11T00:00:01.000Z',
    input: { prompt: 'controlled diagnostic', model_ref: 'fixture::image' } },
  task: { id: 'task_' + '2'.repeat(24), acceptance: 'not_accepted', outcome: 'failed', deliveryState: 'none', attempts: [{}],
    lastError: { stage: 'submit', category: 'rate_limit', acceptance: 'not_accepted', retryable: true, httpStatus: 429,
      safeMessage: 'PRIVATE_REASON Bearer private-token https://private.invalid/?signature=private-signature /private/data',
      providerCode: 'PRIVATE_PROVIDER_CODE', stack: 'PRIVATE_STACK', raw: 'PRIVATE_RESPONSE' } }
};
const original = JSON.stringify(facts), projected = projectLocalApiFlow(facts);
assert.equal(projected.task.errorSummary?.category, 'rate_limit');
assert.equal(projected.task.errorSummary.stage, 'submit');
assert.equal(projected.task.errorSummary.httpStatus, 429);
assert.match(projected.task.errorSummary.message, /限流/);
assert.deepEqual(Object.keys(projected.task.errorSummary).sort(), ['category', 'httpStatus', 'message', 'stage']);
for (const secret of ['PRIVATE_', 'private-token', 'private.invalid', 'private-signature', '/private/data', 'safeMessage', 'providerCode', 'retryable']) {
  assert(!JSON.stringify(projected).includes(secret), secret);
}
assert.equal(JSON.stringify(facts), original, 'Public summaries never rewrite saved Task errors');
const absent = structuredClone(facts); delete absent.task.lastError;
assert(!Object.hasOwn(projectLocalApiFlow(absent).task, 'errorSummary'));
assert.equal(projectLocalApiFlow({ ...facts, task: null }).task, null);
const malformed = structuredClone(facts);
malformed.task.acceptance = 'unknown';
malformed.task.lastError = { category: 'PRIVATE_CATEGORY', stage: '/private/stage', httpStatus: '429?token=private-token', safeMessage: 'PRIVATE_REASON' };
const conservative = projectLocalApiFlow(malformed).task;
assert.equal(conservative.acceptance, 'unknown');
assert.equal(conservative.errorSummary.category, 'unknown');
assert(!Object.hasOwn(conservative.errorSummary, 'stage'));
assert(!Object.hasOwn(conservative.errorSummary, 'httpStatus'));
assert(!JSON.stringify(conservative).includes('PRIVATE_'));

const { root } = useTempDshHome('iris-error-summary');
const dataRoot = path.join(root, 'core');
const fixture = imageFlowFixture(dataRoot, { afterSend() {
  throw new ProviderContractError('PRIVATE_REASON Bearer private-token', {
    stage: 'submit', category: 'rate_limit', acceptance: 'not_accepted', httpStatus: 429,
    providerCode: 'PRIVATE_PROVIDER_CODE', retryable: true
  });
} });
const app = createApplicationRuntime({ dataRoot, ...fixture });
let api;
try {
  await app.execute('flow.init', {}); await app.execute('execution.init', {});
  const artifact = (await app.execute('artifact.import', { image_bytes: FLOW_SOURCE })).artifact;
  const created = await app.execute('flow.create', { source_artifact_id: artifact.id, model_ref: FLOW_MODEL, prompt: 'controlled failure' });
  const failed = await app.execute('flow.continue', { run_id: created.run.id });
  assert.equal(failed.task.acceptance, 'not_accepted');
  assert(failed.task.lastError.safeMessage.includes('PRIVATE_REASON'), 'Core retains its own diagnostic record');
  const taskFile = path.join(dataRoot, 'task-store/v0/tasks', failed.task.id + '.json');
  const before = fs.readFileSync(taskFile);
  const pair = createConnectionPair({ dataRoot, directory: path.join(root, 'pair'), origin: 'http://127.0.0.1:1',
    label: 'Read saved diagnostic', scopes: ['read'] });
  api = createLocalReadApi({ dataRoot, allowMcp: true, connectionsFile: pair.serverFile });
  const started = await api.start();
  const response = await fetch(started.origin + '/api/v0/runs/' + created.run.id, { headers: { Authorization: 'Bearer ' + started.accessToken } });
  assert.equal(response.status, 200);
  const httpView = await response.json();
  const clientToken = JSON.parse(fs.readFileSync(pair.clientFile)).accessToken;
  const client = httpMcpClient(started.origin, clientToken);
  await client.initialize();
  const result = await client.call('iris_core_run', { runId: created.run.id });
  assert(!result.isError, 'Reading a failed Task is a successful tool query');
  const mcpView = JSON.parse(result.content.find(item => item.type === 'text').text);
  assert.deepEqual(mcpView, httpView);
  assert.equal(mcpView.task.errorSummary.httpStatus, 429);
  assert.equal(mcpView.task.errorSummary.category, 'rate_limit');
  assert.equal(mcpView.task.id, failed.task.id);
  assert(!JSON.stringify(mcpView).includes('PRIVATE_'));
  assert.deepEqual(fs.readFileSync(taskFile), before);
  assert.equal(fixture.calls.submit.length, 1, 'HTTP/MCP status queries never resubmit media');
  console.log('PASS safe saved Task error summaries, strict public fields, private diagnostics, unchanged records and read-only HTTP/MCP propagation');
} finally {
  await api?.dispose(); await app.dispose();
}
