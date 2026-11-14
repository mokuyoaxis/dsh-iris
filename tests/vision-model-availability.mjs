import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { configuredImagePorts } from '../lib/configured-image-runtime.js';
import { loadProviderCatalog, visionCandidatesFromCatalog } from '../lib/provider-catalog.js';
import { modelUnavailable, modelDirectoryBinding } from '../lib/model-directory.js';
import { readCoreArtifactBytes } from '../lib/core-artifacts.js';
import { projectLocalApiFlow } from '../lib/local-api-projection.js';
import { createLocalReadApi } from '../lib/local-api.js';
import { createConnectionPair } from '../lib/core-connections.js';
import { httpMcpClient } from './fixtures/mcp-http-client.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-vision-model-availability');
const bytes = await sharp({ create: { width: 100, height: 250, channels: 3, background: 'white' } }).png().toBuffer();
const nativeFetch = globalThis.fetch, calls = [], partialCalls = new Map();
let app, api, session;
const missing = () => Response.json({ error: { code: 'model_not_found', message: 'Model not exist. PRIVATE_VISION_HEALTH_KEY' } }, { status: 404 });
globalThis.fetch = async (input, options) => {
  const url = new URL(input);
  if (session && url.origin === session.origin) return nativeFetch(input, options);
  assert.equal(url.origin, 'https://vision-health.invalid'); assert.equal(url.pathname, '/v1/chat/completions');
  assert.equal(options.method, 'POST');
  const body = JSON.parse(options.body); calls.push(body.model);
  if (body.model === 'missing') return missing();
  if (body.model === 'route-404') return Response.json({ error: { code: 'route_not_found', message: 'PRIVATE_ROUTE_FAILURE' } }, { status: 404 });
  if (body.model === 'bad-input') return Response.json({ error: { code: 'model_not_found', message: 'PRIVATE_INPUT_FAILURE' } }, { status: 400 });
  assert.equal(body.model, 'partial-missing');
  const count = (partialCalls.get(body.model) || 0) + 1; partialCalls.set(body.model, count);
  if (count > 1) return missing();
  return new Response('data: {"choices":[{"index":0,"delta":{"content":"保留已成功的第一块"},"finish_reason":null}]}\n\n'
    + 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
};
const mcpValue = value => { assert(!value.isError); return JSON.parse(value.content.find(part => part.type === 'text').text); };
try {
  for (const recipe of ['vision/v0', 'ocr/v0']) {
    const name = recipe.split('/')[0], dataRoot = path.join(root, name), file = path.join(root, name + '-providers.json');
    const provider = { id: name + '-health', enabled: true, type: 'openai', baseUrl: 'https://vision-health.invalid/v1', apiKey: 'PRIVATE_VISION_HEALTH_KEY',
      models: ['missing', 'route-404', 'bad-input', 'partial-missing', 'working'].map(id => ({ id, capabilities: ['vision'] })) };
    provider.modelDirectory = { version: 1, binding: modelDirectoryBinding(provider), checkedAt: new Date().toISOString(), models: provider.models };
    fs.writeFileSync(file, JSON.stringify({ providers: [provider], assignments: { vision: provider.models.map(model => provider.id + '::' + model.id) } }), { mode: 0o600 });
    const ports = configuredImagePorts(file), modelRef = id => provider.id + '::' + id;
    app = createApplicationRuntime({ dataRoot, ...ports });
    await app.execute('flow.init', {}); await app.execute('execution.init', { vision: true });
    const source = (await app.execute('artifact.import', { image_bytes: bytes })).artifact;
    const create = id => app.execute('creation.' + name, { key: crypto.randomUUID(), value: {
      sourceArtifactId: source.id, modelRef: modelRef(id), ...(name === 'vision' ? { question: '识别图片' } : { chunkHeight: 300, overlap: 0 })
    } });
    const saved = [];
    for (const id of ['missing', 'route-404', 'bad-input']) {
      const draft = await create(id), previous = calls.length;
      const facts = await app.execute('flow.continue', { run_id: draft.flow.run.id }); saved.push(facts);
      assert.deepEqual(calls.slice(previous), [id]);
      const error = facts.task.lastError, snapshot = loadProviderCatalog(file).providers[0];
      const missingModel = id === 'missing';
      assert.equal(error.providerCode, missingModel ? 'model_not_found' : id === 'bad-input' ? 'IRIS_MODEL_INPUT_INVALID' : 'IRIS_MODEL_REQUEST_FAILED');
      assert.equal(error.category, id === 'route-404' ? 'network' : 'invalid_request');
      assert.equal(error.httpStatus, id === 'bad-input' ? 400 : 404);
      assert.equal(facts.task.acceptance, id === 'route-404' ? 'unknown' : 'not_accepted');
      assert.equal(facts.run.output, undefined); assert.equal(facts.run.report, undefined);
      assert.equal(!!modelUnavailable(snapshot, id, 'vision'), missingModel);
      assert.equal(modelUnavailable(snapshot, 'working', 'vision'), null, 'Sibling models must remain eligible');
      assert.equal(ports.resolveVisionCandidates({ modelRef: modelRef('working') }).length, 1);
      if (missingModel) {
        assert.equal(modelUnavailable(snapshot, id, 'vision').reason, 'model_not_found');
        assert(snapshot.modelDirectory.invalidatedAt);
        assert.throws(() => visionCandidatesFromCatalog(loadProviderCatalog(file), modelRef(id)), { code: 'IRIS_PROVIDER_MODEL_UNAVAILABLE' });
        await assert.rejects(create(id), { code: 'IRIS_PROVIDER_MODEL_UNAVAILABLE' });
        assert.match(projectLocalApiFlow(facts).task.errorSummary.message, /所选模型.*不可用/);
      }
      const again = await app.execute('flow.continue', { run_id: facts.run.id });
      assert.equal(again.task.id, facts.task.id); assert.equal(calls.length, previous + 1, 'Original Task lookup never retries');
      assert(!JSON.stringify(facts).includes('PRIVATE_'), 'Provider text and keys stay outside saved failure facts');
    }
    if (name === 'ocr') {
      const draft = await app.execute('creation.ocr', { key: crypto.randomUUID(), value: {
        sourceArtifactId: source.id, modelRef: modelRef('partial-missing'), chunkHeight: 100, overlap: 0
      } });
      const previous = calls.length, partial = await app.execute('flow.continue', { run_id: draft.flow.run.id }); saved.push(partial);
      assert.deepEqual(calls.slice(previous), ['partial-missing', 'partial-missing'], 'Known missing model must not be invoked for remaining chunks');
      assert.equal(partial.status, 'needs_attention'); assert.equal(partial.task.outcome, 'succeeded');
      const report = JSON.parse(readCoreArtifactBytes(dataRoot, partial.run.report.artifactId).bytes);
      assert.equal(report.status, 'partial'); assert.equal(report.invocations, 2); assert.equal(report.successfulChunks, 1);
      assert.deepEqual(report.chunks.map(chunk => [chunk.y, chunk.height]), [[0, 100], [100, 100], [200, 50]]);
      assert.equal(report.chunks[1].errors[0].status, 404); assert.equal(report.chunks[2].errors[0].invocation, 'not_invoked');
      assert(readCoreArtifactBytes(dataRoot, partial.run.output.artifactId).bytes.includes(Buffer.from('保留已成功的第一块')));
      assert(modelUnavailable(loadProviderCatalog(file).providers[0], 'partial-missing', 'vision'), 'Partial OCR must persist definitive model failure');
    }
    assert.deepEqual(readCoreArtifactBytes(dataRoot, source.id).bytes, bytes);
    const count = calls.length;
    await app.dispose(); app = createApplicationRuntime({ dataRoot, ...ports });
    for (const facts of saved) {
      const reread = await app.execute('flow.continue', { run_id: facts.run.id });
      assert.equal(reread.task.id, facts.task.id); assert.equal(reread.run.output?.artifactId, facts.run.output?.artifactId);
    }
    assert.equal(calls.length, count); await app.dispose(); app = undefined;
    const pair = createConnectionPair({ dataRoot, directory: path.join(root, name + '-connection'), origin: 'http://127.0.0.1:1', harnessKind: 'generic',
      label: 'vision model health read', scopes: ['read'], capabilities: ['vision', 'ocr'] });
    api = createLocalReadApi({ dataRoot, connectionsFile: pair.serverFile, allowMcp: true }); session = await api.start();
    const connection = JSON.parse(fs.readFileSync(pair.clientFile)), remote = httpMcpClient(session.origin, connection.accessToken);
    await remote.initialize();
    for (const facts of saved) {
      const view = mcpValue(await remote.call('iris_core_run', { runId: facts.run.id }));
      assert.equal(view.task.id, facts.task.id); assert.equal(view.task.attemptCount, 1);
      if (facts.task.lastError) {
        assert.deepEqual(view.task.errorSummary, projectLocalApiFlow(facts).task.errorSummary);
        assert.deepEqual(Object.keys(view.task.errorSummary).sort(), ['category', 'httpStatus', 'message', 'stage']);
      }
      assert(!JSON.stringify(view).includes('PRIVATE_'));
    }
    assert.equal(calls.length, count, 'Read-only MCP performs no model requests');
    await api.dispose(); api = undefined; session = undefined;
  }
  assert.equal(calls.length, 8); // Six single-chunk failures plus two partial-OCR calls, all controlled.
  console.log('PASS Core vision/OCR exact model-not-found persistence, generic404/non404 isolation, partial OCR admission, UUID restart and safe MCP summaries; zero real provider requests');
} finally { await api?.dispose(); await app?.dispose(); globalThis.fetch = nativeFetch; }
