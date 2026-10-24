import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { FLOW_MODEL, FLOW_SOURCE, imageFlowFixture, readFlowEvents } from './fixtures/image-flow-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-operation-cli');
const cli = fileURLToPath(new URL('../bin/dsh-iris.js', import.meta.url));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function tree(root) { return Object.fromEntries(fs.readdirSync(root, { recursive: true }).map(name => {
  const file = path.join(root, name), stat = fs.lstatSync(file); return [name, stat.isFile() ? sha(fs.readFileSync(file)) : stat.isDirectory() ? 'directory' : fs.readlinkSync(file)];
})); }
function run(args, status = 0) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 20000,
    env: { ...process.env, IRIS_IMPORT_WORKBENCH_CONFIG: '', DSH_HOME: path.join(root, 'unused-dsh') } });
  assert(!result.error, result.error?.message); assert.equal(result.status, status, result.stderr);
  return status === 0 ? JSON.parse(result.stdout) : result.stderr;
}
const dataRoot = path.join(root, 'core'), flags = ['--data-root', dataRoot];
run(['flow', 'init', ...flags]);
const initialized = run(['execution', 'init', ...flags]); assert.equal(initialized.root.schemaVersion, 1); assert.equal(initialized.executionEnabled, false);
assert.deepEqual(run(['execution', 'init', ...flags]), initialized);
assert.equal(run(['operation', 'list', ...flags]).total, 0);
const fixture = imageFlowFixture(dataRoot), app = createApplicationRuntime({ dataRoot, ...fixture });
try {
  const source = (await app.execute('artifact.import', { image_bytes: FLOW_SOURCE })).artifact;
  const facts = await app.execute('flow.create', { source_artifact_id: source.id, model_ref: FLOW_MODEL, prompt: 'CLI storage test' });
  const input = { key: crypto.randomUUID(), runId: facts.run.id, expectedRunRevision: 1, ownerInstanceId: crypto.randomUUID() };
  const first = (await app.execute('operation.accept', input)).operation, before = tree(dataRoot);
  const inspected = run(['operation', 'inspect', first.id, ...flags]); assert.equal(inspected.operation.id, first.id); assert.equal(inspected.operation.state, 'queued');
  const listed = run(['operation', 'list', ...flags, '--run-id', facts.run.id, '--limit', '1']); assert.equal(listed.total, 1); assert.equal(listed.operations[0].id, first.id);
  for (const field of ['ownerInstanceId', 'rootId', 'inputDigest', 'binding']) assert(!JSON.stringify(inspected).includes(field));
  assert(!JSON.stringify(inspected).includes(input.key));
  assert.equal((await app.execute('operation.accept', input)).operation.id, first.id);
  run(['operation', 'inspect', 'invalid', ...flags], 1);
  run(['operation', 'inspect', ...flags], 2);
  run(['operation', 'list', ...flags, '--limit', '31'], 2);
  run(['operation', 'list', ...flags, '--provider-config', 'unused'], 2);
  run(['operation', 'accept', ...flags], 2);
  run(['execution', 'serve', ...flags], 2);
  assert.deepEqual(tree(dataRoot), before); assert.deepEqual(readFlowEvents(dataRoot), []);
  const missing = path.join(root, 'missing');
  run(['execution', 'init', '--data-root', missing], 2); assert(!fs.existsSync(missing));
  run(['execution', 'init', '--data-root', 'relative'], 2);
  const old = path.join(root, 'v0'); run(['flow', 'init', '--data-root', old]); run(['api', 'init', '--data-root', old]);
  const oldBefore = tree(old);
  assert.match(run(['execution', 'init', '--data-root', old], 1), /IRIS_CREATION_ROOT_VERSION_CONFLICT/);
  run(['operation', 'list', '--data-root', old], 1); assert.deepEqual(tree(old), oldBefore);
  assert(!fs.existsSync(path.join(root, 'unused-dsh')));
  console.log('Operation CLI: explicit v1 init, real-process readers, durable identity, no execution surface, arguments and v0/no-root protection OK');
} finally { await app.dispose(); }
