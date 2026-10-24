import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createCoreRuntime, inspectCoreWriterLease } from '../lib/core-runtime.js';
import { readAllOperations, readOperation, operationId, inspectExecutionRoot, projectOperation } from '../lib/operation-store.js';
import { inspectCreationRoot, listCreationRequests } from '../lib/creation-request-store.js';
import { readFlowRun } from '../lib/flow-store.js';
import { listCoreTasks } from '../lib/core-tasks.js';
import { planCoreDeletion, planCoreCleanup, quarantineCoreFiles, restoreCoreTransaction } from '../lib/core-maintenance.js';
import { FLOW_MODEL, FLOW_SOURCE, imageFlowFixture, readFlowEvents } from './fixtures/image-flow-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-operation-store');
const apps = [], key = () => crypto.randomUUID(), sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function tree(directory) {
  return Object.fromEntries(fs.readdirSync(directory, { recursive: true }).map(name => {
    const file = path.join(directory, name), stat = fs.lstatSync(file);
    return [name.split(path.sep).join('/'), { mode: stat.mode & 0o777,
      ...(stat.isFile() ? { sha256: sha(fs.readFileSync(file)) } : stat.isDirectory() ? { directory: true } : { link: fs.readlinkSync(file) }) }];
  }));
}
async function setup(name, initialize = true) {
  const dataRoot = path.join(root, name), fixture = imageFlowFixture(dataRoot);
  const app = createApplicationRuntime({ dataRoot, ...fixture }); apps.push(app);
  await app.execute('flow.init', {});
  if (initialize) await app.execute('execution.init', {});
  const source = (await app.execute('artifact.import', { image_bytes: FLOW_SOURCE })).artifact;
  const create = () => app.execute('flow.create', { source_artifact_id: source.id, model_ref: FLOW_MODEL, prompt: 'PRIVATE_OPERATION_PROMPT; preserve the subject' });
  const facts = await create();
  return { dataRoot, app, source, facts, create, fixture };
}
async function writer(dataRoot, action) {
  const runtime = createCoreRuntime({ dataRoot });
  try { runtime.start(); return await runtime.run('execute', ({ dataRoot }) => action(dataRoot)); }
  finally { await runtime.dispose(); }
}
const acceptInput = (facts, requestKey = key()) => ({ key: requestKey, runId: facts.run.id, expectedRunRevision: facts.run.revision, ownerInstanceId: key() });

try {
  const v0Root = path.join(root, 'v0'), v0 = createApplicationRuntime({ dataRoot: v0Root }); apps.push(v0);
  await v0.execute('flow.init', {}); const oldMarker = (await v0.execute('creation.init', {})).root;
  const v0Before = tree(v0Root);
  await assert.rejects(v0.execute('execution.init', {}), { code: 'IRIS_CREATION_ROOT_VERSION_CONFLICT' });
  await assert.rejects(v0.execute('operation.list', {}), { code: 'IRIS_OPERATION_ROOT_REQUIRED' });
  assert.deepEqual(inspectCreationRoot(v0Root), oldMarker); assert.deepEqual(readAllOperations(v0Root), []);
  assert.deepEqual(tree(v0Root), v0Before, 'existing v0 roots are never migrated by a reader or init');
  const used = await setup('used', false), usedBefore = tree(used.dataRoot);
  await assert.rejects(used.app.execute('execution.init', {}), { code: 'IRIS_CREATION_ROOT_NOT_EMPTY' });
  assert.deepEqual(tree(used.dataRoot), usedBefore);

  const main = await setup('main'), marker = inspectExecutionRoot(main.dataRoot);
  assert.equal(marker.schemaVersion, 1); assert.equal(marker.kind, 'iris-execution-requests');
  const initializedAgain = await main.app.execute('execution.init', {});
  assert.deepEqual(initializedAgain.root, marker); assert.equal(initializedAgain.executionEnabled, false);
  const savedRoot = tree(main.dataRoot);
  await assert.rejects(main.app.execute('creation.init', {}), { code: 'IRIS_CREATION_ROOT_VERSION_CONFLICT' });
  assert.deepEqual(tree(main.dataRoot), savedRoot);
  const uploadKey = key(), upload = { key: uploadKey, bytes: FLOW_SOURCE, mediaType: 'image/png' };
  const imported = await main.app.execute('creation.image', upload);
  assert.equal((await main.app.execute('creation.image', upload)).artifact.id, imported.artifact.id);
  assert.equal(listCreationRequests(main.dataRoot).length, 1);
  assert.equal(fs.readdirSync(path.join(main.dataRoot, 'creation-requests')).join(), 'v1');

  const input = acceptInput(main.facts), coreBeforeAccept = tree(main.dataRoot), beforeEvents = readFlowEvents(main.dataRoot);
  const accepted = await main.app.execute('operation.accept', input), id = accepted.operation.id;
  assert.equal(accepted.idempotentReplay, false); assert.equal(accepted.operation.state, 'queued');
  assert.equal(id, operationId(marker, input.key)); assert.equal(listCoreTasks(main.dataRoot).total, 0);
  const afterAccept = tree(main.dataRoot);
  assert.deepEqual(Object.keys(afterAccept).filter(file => !Object.hasOwn(coreBeforeAccept, file)), ['creation-requests/v1/operations/' + id + '.json']);
  for (const [file, state] of Object.entries(coreBeforeAccept)) assert.deepEqual(afterAccept[file], state, file + ' changed on acceptance');
  const replays = await Promise.all(Array.from({ length: 3 }, () => main.app.execute('operation.accept', { ...input, ownerInstanceId: key() })));
  assert(replays.every(result => result.idempotentReplay && result.operation.id === id));
  assert.deepEqual(tree(main.dataRoot), afterAccept, 'a replay does not rewrite records or change ownership');
  const raw = readOperation(main.dataRoot, id), text = JSON.stringify(raw);
  assert.equal(raw.ownerInstanceId, input.ownerInstanceId);
  for (const secret of [input.key, 'PRIVATE_OPERATION_PROMPT', FLOW_MODEL, 'providerBinding']) assert(!text.includes(secret));
  for (const privateField of ['ownerInstanceId', 'rootId', 'binding', 'inputDigest']) assert(!JSON.stringify(projectOperation(raw)).includes(privateField));
  await assert.rejects(main.app.execute('operation.accept', { ...input, expectedRunRevision: 2 }), { code: 'IRIS_OPERATION_KEY_CONFLICT' });
  await assert.rejects(main.app.execute('operation.accept', { ...input, key: key() }), error => error.code === 'IRIS_OPERATION_RUN_BUSY' && error.operationId === id);
  await assert.rejects(main.app.execute('operation.accept', { ...input, key: 'bad' }), { code: 'IRIS_OPERATION_KEY_INVALID' });
  await assert.rejects(main.app.execute('operation.accept', { ...input, key: key(), command: 'generate' }), { code: 'IRIS_OPERATION_INPUT_INVALID' });
  await assert.rejects(main.app.execute('operation.accept', { ...input, key: key(), expectedRunRevision: 0 }), { code: 'IRIS_OPERATION_INPUT_INVALID' });
  assert.deepEqual(tree(main.dataRoot), afterAccept);

  const canceled = await main.app.execute('operation.transition', { id, expectedRevision: 1, state: 'canceled' });
  assert.equal(canceled.operation.cancelRequested, true); assert.equal(canceled.operation.result.taskId, null);
  assert.equal(listCoreTasks(main.dataRoot).total, 0, 'canceling the stored queue entry creates no Task');
  await assert.rejects(main.app.execute('operation.transition', { id, expectedRevision: 1, state: 'running' }), { code: 'IRIS_OPERATION_REVISION_CONFLICT' });
  await assert.rejects(main.app.execute('operation.transition', { id, expectedRevision: 2, state: 'running' }), { code: 'IRIS_OPERATION_TRANSITION_INVALID' });
  const terminalTree = tree(main.dataRoot);
  assert.equal((await main.app.execute('operation.accept', input)).operation.state, 'canceled');
  assert.deepEqual(tree(main.dataRoot), terminalTree);
  const plan = await writer(main.dataRoot, root => planCoreDeletion(root, { artifact_ids: [main.source.id] }));
  assert(plan.blockers.some(blocker => blocker.reason === 'operation_artifact_reference' && blocker.referencedBy === id));

  const secondInput = acceptInput(main.facts), second = (await main.app.execute('operation.accept', secondInput)).operation;
  const running = (await main.app.execute('operation.transition', { id: second.id, expectedRevision: 1, state: 'running' })).operation;
  await assert.rejects(main.app.execute('operation.transition', { id: second.id, expectedRevision: running.revision, state: 'succeeded' }), { code: 'IRIS_OPERATION_RESULT_INVALID' });
  const interruption = (await main.app.execute('operation.transition', { id: second.id, expectedRevision: 2, state: 'interrupted' })).operation;
  assert.equal(interruption.result.taskId, null);
  assert.deepEqual(readFlowEvents(main.dataRoot), beforeEvents, 'storage lifecycle never contacts a Provider');

  const thirdInput = acceptInput(main.facts), third = (await main.app.execute('operation.accept', thirdInput)).operation;
  const advanced = await main.app.execute('flow.continue', { run_id: main.facts.run.id });
  await assert.rejects(main.app.execute('operation.transition', { id: third.id, expectedRevision: 1, state: 'running' }), { code: 'IRIS_OPERATION_RUN_CHANGED' });
  const failed = await main.app.execute('operation.transition', { id: third.id, expectedRevision: 1, state: 'failed', failureCode: 'run_changed' });
  assert.equal(failed.operation.result.taskId, advanced.task.id);
  const completeInput = acceptInput({ run: readFlowRun(main.dataRoot, main.facts.run.id) });
  const finalOp = (await main.app.execute('operation.accept', completeInput)).operation;
  await main.app.execute('operation.transition', { id: finalOp.id, expectedRevision: 1, state: 'running' });
  const succeeded = (await main.app.execute('operation.transition', { id: finalOp.id, expectedRevision: 2, state: 'succeeded' })).operation;
  assert.equal(succeeded.result.taskId, advanced.task.id); assert.equal(succeeded.result.runRevision, advanced.run.revision);
  assert(succeeded.result.artifactIds.includes(advanced.run.output.artifactId));
  const taskPlan = await writer(main.dataRoot, root => planCoreDeletion(root, { task_ids: [advanced.task.id] }));
  assert(taskPlan.blockers.some(blocker => blocker.reason === 'operation_task_reference'));
  assert.equal((await main.app.execute('operation.accept', thirdInput)).operation.id, third.id, 'old Key replays even after Run progress');

  const beforeRead = tree(main.dataRoot), events = readFlowEvents(main.dataRoot);
  const page = await main.app.execute('operation.list', { limit: 2 }); assert.equal(page.total, 4); assert(page.nextCursor);
  const tail = await main.app.execute('operation.list', { limit: 2, cursor: page.nextCursor });
  assert.equal(tail.operations.length, 2); assert.equal(tail.nextCursor, null);
  assert.equal(new Set([...page.operations, ...tail.operations].map(record => record.id)).size, 4);
  assert.equal((await main.app.execute('operation.lookup', { key: input.key })).operation.id, id);
  assert.equal((await main.app.execute('operation.inspect', { id })).operation.state, 'canceled');
  await assert.rejects(main.app.execute('operation.inspect', { id: 'op_' + 'f'.repeat(64) }), { code: 'IRIS_OPERATION_NOT_FOUND' });
  await assert.rejects(main.app.execute('operation.list', { limit: 31 }), { code: 'IRIS_OPERATION_INPUT_INVALID' });
  assert.deepEqual(tree(main.dataRoot), beforeRead); assert.deepEqual(readFlowEvents(main.dataRoot), events);

  const unused = (await main.app.execute('artifact.import', { image_bytes: FLOW_SOURCE })).artifact;
  const quarantined = await writer(main.dataRoot, root => quarantineCoreFiles(root, planCoreDeletion(root, { artifact_ids: [unused.id] })));
  await writer(main.dataRoot, root => restoreCoreTransaction(root, quarantined.transactionId));
  assert.equal(readOperation(main.dataRoot, id).state, 'canceled');

  const capacity = await setup('capacity'), created = [capacity.facts];
  for (let index = 0; index < 8; index++) created.push(await capacity.create());
  for (const facts of created.slice(0, 8)) await capacity.app.execute('operation.accept', acceptInput(facts));
  const capacityBefore = tree(capacity.dataRoot);
  await assert.rejects(capacity.app.execute('operation.accept', acceptInput(created[8])), { code: 'IRIS_OPERATION_QUEUE_FULL' });
  assert.deepEqual(tree(capacity.dataRoot), capacityBefore); assert.equal(listCoreTasks(capacity.dataRoot).total, 0);
  const firstCapacity = readAllOperations(capacity.dataRoot)[0];
  await capacity.app.execute('operation.transition', { id: firstCapacity.id, expectedRevision: 1, state: 'canceled' });
  await capacity.app.execute('operation.accept', acceptInput(created[8]));
  const independent = await setup('independent'), cross = await independent.app.execute('operation.accept', { ...input, runId: independent.facts.run.id });
  assert.notEqual(cross.operation.id, id, 'same Key is isolated by physical root identity');

  // A running record remains an observation on restart, never automatic work or repair.
  const restart = await setup('restart'), pending = (await restart.app.execute('operation.accept', acceptInput(restart.facts))).operation;
  await restart.app.execute('operation.transition', { id: pending.id, expectedRevision: 1, state: 'running' });
  await restart.app.dispose();
  const restarted = createApplicationRuntime({ dataRoot: restart.dataRoot }); apps.push(restarted);
  const restartBefore = tree(restart.dataRoot);
  assert.equal((await restarted.execute('operation.inspect', { id: pending.id })).operation.state, 'running');
  assert.equal((await restarted.execute('operation.list', {})).total, 1);
  assert.deepEqual(tree(restart.dataRoot), restartBefore); assert.deepEqual(readFlowEvents(restart.dataRoot), []);

  const peer = createApplicationRuntime({ dataRoot: main.dataRoot }); apps.push(peer);
  const sharedInput = acceptInput({ run: readFlowRun(main.dataRoot, main.facts.run.id) }), beforeBusy = tree(main.dataRoot);
  const held = createCoreRuntime({ dataRoot: main.dataRoot }); held.start();
  try { await assert.rejects(peer.execute('operation.accept', sharedInput), { code: 'IRIS_CORE_DATA_ROOT_BUSY' }); }
  finally { await held.dispose(); }
  assert.deepEqual(tree(main.dataRoot), beforeBusy, 'a foreign writer prevents acceptance without consuming a Key');
  const released = await peer.execute('operation.accept', sharedInput); assert.equal(released.idempotentReplay, false);
  if (process.platform !== 'win32') {
    const alias = path.join(root, 'main-alias'); fs.symlinkSync(main.dataRoot, alias, 'dir');
    const aliasApp = createApplicationRuntime({ dataRoot: alias }); apps.push(aliasApp);
    assert.equal((await aliasApp.execute('operation.accept', sharedInput)).operation.id, released.operation.id,
      'a filesystem alias resolves to the original root identity and writer');
  }

  // Record/file/container corruption blocks every writer and maintenance preview; evidence is retained.
  const file = path.join(main.dataRoot, 'creation-requests/v1/operations', id + '.json'), saved = fs.readFileSync(file);
  for (const content of ['BROKEN_OPERATION', JSON.stringify({ ...readOperation(main.dataRoot, id), rootId: key() })]) {
    fs.writeFileSync(file, content);
    const corruptBefore = tree(main.dataRoot);
    await assert.rejects(main.app.execute('artifact.import', { image_bytes: FLOW_SOURCE }), { code: 'IRIS_OPERATION_STORE_INVALID' });
    assert.throws(() => planCoreCleanup(main.dataRoot), { code: 'IRIS_OPERATION_STORE_INVALID' });
    assert.deepEqual(tree(main.dataRoot), corruptBefore); assert.equal(inspectCoreWriterLease(main.dataRoot).status, 'absent');
    fs.writeFileSync(file, saved);
  }
  const runnerUnknown = path.join(main.dataRoot, 'creation-requests/v1/runner', 'foreign-owner'); fs.writeFileSync(runnerUnknown, 'unknown');
  await assert.rejects(main.app.execute('artifact.import', { image_bytes: FLOW_SOURCE }), { code: 'IRIS_CREATION_STORE_INVALID' });
  assert.equal(fs.readFileSync(runnerUnknown, 'utf8'), 'unknown');
  if (process.platform !== 'win32') { assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700); }
  console.log('Operation storage: explicit v1/v0 gate, atomic identity/replay, Run/capacity conflicts, CAS states, privacy, references, no automatic execution and corruption rejection OK');
} finally { for (const app of apps) await app.dispose(); }
