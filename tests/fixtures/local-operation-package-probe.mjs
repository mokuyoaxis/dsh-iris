// Copy outside the repository. Instantiate only the installed package; no external services.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const [cli, dataRoot, imageFile] = process.argv.slice(2), installed = path.dirname(path.dirname(cli));
const { createApplicationRuntime } = await import(pathToFileURL(path.join(installed, 'lib/application-runtime.js')));
let commands = 0;
function run(args) {
  commands++;
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 20000,
    env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', IRIS_IMPORT_WORKBENCH_CONFIG: '' } });
  assert(!result.error, result.error?.message); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const tree = () => Object.fromEntries(fs.readdirSync(dataRoot, { recursive: true }).map(name => {
  const file = path.join(dataRoot, name), stat = fs.lstatSync(file);
  return [name, stat.isFile() ? sha(fs.readFileSync(file)) : stat.isDirectory() ? 'directory' : fs.readlinkSync(file)];
}));
run(['flow', 'init', '--data-root', dataRoot]);
const init = run(['execution', 'init', '--data-root', dataRoot]); assert.equal(init.root.schemaVersion, 1); assert.equal(init.executionEnabled, false);
const app = createApplicationRuntime({ dataRoot, resolveImageCandidates: ({ modelRef }) => {
  assert.equal(modelRef, 'operation::edit');
  return [{ adapter: { id: 'operation', protocol: 'openai-chat-images' }, model: modelRef,
    providerBinding: 'sha256:' + 'a'.repeat(64), selectionReason: 'explicit' }];
} });
let input, accepted;
try {
  const source = (await app.execute('creation.image', { key: crypto.randomUUID(), bytes: fs.readFileSync(imageFile), mediaType: 'image/png' })).artifact;
  const created = await app.execute('creation.flow', { key: crypto.randomUUID(), value: { sourceArtifactId: source.id,
    modelRef: 'operation::edit', prompt: 'Package operation fixture, no generation' } });
  input = { key: crypto.randomUUID(), runId: created.flow.run.id, expectedRunRevision: created.flow.run.revision, ownerInstanceId: crypto.randomUUID() };
  accepted = await app.execute('operation.accept', input);
  const before = tree();
  assert.equal((await app.execute('operation.accept', { ...input, ownerInstanceId: crypto.randomUUID() })).operation.id, accepted.operation.id);
  assert.deepEqual(tree(), before);
  const listed = run(['operation', 'list', '--data-root', dataRoot]); assert.equal(listed.total, 1);
  const inspected = run(['operation', 'inspect', accepted.operation.id, '--data-root', dataRoot]);
  assert.equal(inspected.operation.state, 'queued');
  for (const privateField of ['ownerInstanceId', 'rootId', 'binding', 'inputDigest']) assert(!JSON.stringify(inspected).includes(privateField));
  assert.deepEqual(tree(), before);
} finally { await app.dispose(); }
const restarted = createApplicationRuntime({ dataRoot });
try {
  const before = tree(), replay = await restarted.execute('operation.accept', input);
  assert(replay.idempotentReplay); assert.equal(replay.operation.id, accepted.operation.id);
  assert.deepEqual(tree(), before);
  assert(!fs.existsSync(path.join(dataRoot, 'task-store/v0/tasks')));
  assert(!fs.existsSync(path.join(dataRoot, '.iris-runtime-writer-v0')));
  console.log(JSON.stringify({ cliCommands: commands, explicitV1: true, executionEnabled: false, stableIdentity: true,
    restartReplay: true, noTaskCreated: true, noProviderAdapterCalled: true, inspectIsPrivateProjection: true,
    readersAndReplayZeroWrites: true, lstatSnapshots: true }));
} finally { await restarted.dispose(); }
