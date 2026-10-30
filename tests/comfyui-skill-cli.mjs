// Execute the documented CLI path and supported mixed chain with controlled providers only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { COMFY_WORKFLOW, comfyProtocolFixture } from './fixtures/comfyui-protocol-fixture.mjs';
import { FLOW_RESULT } from './fixtures/image-flow-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-comfyui-skill-cli');
const dataRoot = path.join(root, 'core'), config = path.join(root, 'providers.json'), file = path.join(root, 'input.json');
const fixture = await comfyProtocolFixture(), apiCalls = [], commands = [];
const api = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  apiCalls.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks)) });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + FLOW_RESULT.toString('base64') } }] } }] }));
});
const write = value => fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
const cli = async args => {
  const { stdout } = await promisify(execFile)(process.execPath, [path.resolve('bin/dsh-iris.js'), ...args], {
    timeout: 30000, env: { ...process.env, NODE_OPTIONS: '', IRIS_IMPORT_WORKBENCH_CONFIG: '' } });
  commands.push(args); return JSON.parse(stdout);
};
const rootFlags = ['--data-root', dataRoot], configFlags = ['--provider-config', config];
try {
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(config, JSON.stringify({ providers: [
    { id: 'comfy', name: 'Controlled ComfyUI', baseUrl: fixture.baseUrl, auth: 'none', mediaProtocol: 'comfyui', models: [{ id: 'portrait', capabilities: ['image-gen'], comfyWorkflow: COMFY_WORKFLOW }] },
    { id: 'api', name: 'Controlled API', baseUrl: 'http://127.0.0.1:' + api.address().port + '/v1', auth: 'none', mediaProtocol: 'openai-chat-images', models: [{ id: 'edit', capabilities: ['image-gen'] }] }
  ], assignments: { 'image-gen': { mode: 'auto', models: [] } } }), { mode: 0o600 });
  const listed = await cli(['models', 'list', ...configFlags]);
  const selected = listed.models.find(model => model.comfyWorkflow), apiModel = listed.models.find(model => !model.comfyWorkflow);
  assert.equal(selected.ref, 'comfy::portrait'); assert.equal(apiModel.ref, 'api::edit');
  assert.equal(selected.comfyWorkflow.parameters.find(parameter => parameter.id === 'seed').type, 'integer');
  assert.equal(fixture.graphs.length, 0); assert.equal(apiCalls.length, 0); assert(!fs.existsSync(dataRoot));
  const values = { lora: 'portrait.safetensors', model_weight: 0.7, clip_weight: 0.4, seed: 42 };
  const checked = await cli(['models', 'workflow-check', selected.ref, ...configFlags, '--input', JSON.stringify({ workflow_parameters: values })]);
  assert(checked.ok); assert(checked.parameters.find(parameter => parameter.id === 'lora').availableChoices.includes(values.lora));
  assert.equal(fixture.graphs.length, 0); assert(!fs.existsSync(dataRoot));
  write({ model_ref: selected.ref, prompt: 'An iris flower', n: 1, workflow_parameters: values });
  const queued = await cli(['run', 'image', ...rootFlags, ...configFlags, '--input-file', file]);
  assert.equal(queued.task.acceptance, 'accepted'); assert.equal(queued.task.artifactIds.length, 0); assert.equal(fixture.graphs.length, 1); assert.equal(apiCalls.length, 0);
  assert.equal(fixture.graphs[0]['10'].inputs.strength_model, 0.7); assert.equal(fixture.graphs[0]['10'].inputs.strength_clip, 0.4); assert.equal(fixture.graphs[0]['3'].inputs.seed, 42);
  fixture.phase = 'done';
  const observed = await cli(['task', 'observe', queued.task.id, ...rootFlags, ...configFlags]);
  assert.equal(observed.task.id, queued.task.id); assert.equal(observed.task.deliveryState, 'ready'); assert.equal(fixture.graphs.length, 1);
  const artifactId = observed.task.artifactIds[0];
  write({ model_ref: apiModel.ref, source_artifact_id: artifactId, prompt: 'Keep the flower and make the background blue', n: 1 });
  const edited = await cli(['run', 'image', ...rootFlags, ...configFlags, '--input-file', file]);
  assert.equal(edited.task.deliveryState, 'ready'); assert.equal(edited.task.sourceArtifactId, artifactId); assert.notEqual(edited.task.id, queued.task.id);
  assert.equal(apiCalls.length, 1); assert(JSON.stringify(apiCalls[0].body).includes(FLOW_RESULT.toString('base64')));
  assert(!JSON.stringify(apiCalls[0].body).includes('workflow_parameters')); assert.equal(fixture.graphs.length, 1);
  const output = path.join(root, 'final.png');
  await cli(['artifact', 'export', edited.task.artifactIds[0], ...rootFlags, '--output', output]);
  assert.deepEqual(fs.readFileSync(output), FLOW_RESULT); assert.equal(apiCalls.length, 1);
  fixture.mode = 'post-lost';
  write({ model_ref: selected.ref, prompt: 'Another explicitly requested image', n: 1, workflow_parameters: values });
  const uncertain = await cli(['run', 'image', ...rootFlags, ...configFlags, '--input-file', file]);
  assert.equal(uncertain.task.acceptance, 'unknown'); assert.equal(fixture.graphs.length, 2); assert.equal(apiCalls.length, 1, 'explicit workflow never falls through to the API pool');
  const known = await cli(['task', 'inspect', uncertain.task.id, ...rootFlags]);
  assert.equal(known.task.id, uncertain.task.id); assert.equal(known.task.acceptance, 'unknown'); assert.equal(fixture.graphs.length, 2);
  console.log('PASS ' + commands.length + ' actual CLI commands: catalog parameters, read-only check, one ComfyUI submit/observe, same-root API edit/bytes, and unknown acceptance without cross-backend fallback');
} finally { api.closeAllConnections(); await new Promise(resolve => api.close(resolve)); await fixture.close(); }
