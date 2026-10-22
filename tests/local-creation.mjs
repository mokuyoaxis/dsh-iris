import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { createCoreRuntime, inspectCoreWriterLease } from '../lib/core-runtime.js';
import { WRITER_LEASE_DIR } from '../lib/core-writer-lease.js';
import { listCoreArtifacts } from '../lib/core-artifacts.js';
import { inspectCreationRoot, listCreationRequests, publishCreationRequest, creationRequestId, creationInputDigest } from '../lib/creation-request-store.js';
import { planCoreDeletion, planCoreCleanup, quarantineCoreFiles, restoreCoreTransaction } from '../lib/core-maintenance.js';
import { listCoreTasks } from '../lib/core-tasks.js';
import { readFlowRun } from '../lib/flow-store.js';
import { FLOW_MODEL, FLOW_SOURCE, imageFlowFixture, readFlowEvents } from './fixtures/image-flow-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-local-creation');
const dataRoot = path.join(root, 'core'), fixture = imageFlowFixture(dataRoot), apps = [];
const app = createApplicationRuntime({ dataRoot, ...fixture }); apps.push(app);
const key = () => crypto.randomUUID();
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function tree(directory) {
  return Object.fromEntries(fs.readdirSync(directory, { recursive: true, withFileTypes: true }).filter(item => item.isFile())
    .map(item => { const file = path.join(item.parentPath, item.name); return [path.relative(directory, file), sha(fs.readFileSync(file))]; }));
}
async function writer(action, directory = dataRoot) {
  const runtime = createCoreRuntime({ dataRoot: directory });
  try { runtime.start(); return await runtime.run('execute', ({ dataRoot }) => action(dataRoot)); }
  finally { await runtime.dispose(); }
}

try {
  await app.execute('flow.init', {});
  assert.equal(inspectCreationRoot(dataRoot, { allowAbsent: true }), null);
  const initialized = await app.execute('creation.init', {}), marker = initialized.root;
  assert.deepEqual((await app.execute('creation.init', {})).root, marker);
  const uploadKey = key(), uploadInput = { key: uploadKey, bytes: FLOW_SOURCE, mediaType: 'image/png' };
  const first = await app.execute('creation.image', uploadInput);
  assert.equal(first.idempotentReplay, false);
  const beforeReplay = tree(dataRoot);
  assert.deepEqual((await app.execute('creation.image', uploadInput)).artifact, first.artifact);
  assert.deepEqual(tree(dataRoot), beforeReplay, 'successful replay never rewrites business or request records');
  assert.equal(listCoreArtifacts(dataRoot).total, 1);
  assert.equal(listCreationRequests(dataRoot).length, 1);
  assert.equal(listCreationRequests(dataRoot)[0].state, 'succeeded');
  assert(!JSON.stringify(listCreationRequests(dataRoot)).includes(uploadKey), 'raw Key is not persisted');
  await assert.rejects(app.execute('creation.image', { ...uploadInput, bytes: Buffer.from('invalid') }), { code: 'IRIS_IMAGE_IMPORT_INVALID' });
  const otherImage = Buffer.from(FLOW_SOURCE); // Same valid format, changed bytes remain a different request fingerprint.
  const withTrailingByte = Buffer.concat([otherImage, Buffer.from([0])]);
  await assert.rejects(app.execute('creation.image', { ...uploadInput, bytes: withTrailingByte }), { code: 'IRIS_CREATION_KEY_CONFLICT' });
  await assert.rejects(app.execute('creation.image', { ...uploadInput, key: 'INVALID' }), { code: 'IRIS_CREATION_KEY_INVALID' });
  const invalidKey = key();
  await assert.rejects(app.execute('creation.image', { ...uploadInput, key: invalidKey, mediaType: 'image/jpeg' }), { code: 'IRIS_CREATION_MEDIA_MISMATCH' });
  assert.equal(listCreationRequests(dataRoot).length, 1);

  const createKey = key(), value = { sourceArtifactId: first.artifact.id, modelRef: FLOW_MODEL, prompt: '  Same creation  ' };
  const created = await app.execute('creation.flow', { key: createKey, value });
  assert.equal(created.flow.status, 'not_started'); assert.equal(created.flow.task, null);
  const concurrent = await Promise.all(Array.from({ length: 3 }, () => app.execute('creation.flow', {
    key: createKey, value: { prompt: 'Same creation', modelRef: FLOW_MODEL, sourceArtifactId: first.artifact.id }
  })));
  assert(concurrent.every(item => item.idempotentReplay && item.flow.run.id === created.flow.run.id));
  assert.equal(listCoreTasks(dataRoot).total, 0); assert.deepEqual(readFlowEvents(dataRoot), []);
  await assert.rejects(app.execute('creation.flow', { key: createKey, value: { ...value, prompt: 'Different request' } }), { code: 'IRIS_CREATION_KEY_CONFLICT' });
  const count = listCreationRequests(dataRoot).length;
  await assert.rejects(app.execute('creation.flow', { key: key(), value: { ...value, path: '/private/path' } }), { code: 'IRIS_CREATION_INPUT_INVALID' });
  await assert.rejects(app.execute('creation.flow', { key: key(), value: { ...value, modelRef: 'absent::model' } }));
  assert.equal(listCreationRequests(dataRoot).length, count, 'invalid inputs never publish an intent');

  const noProvider = createApplicationRuntime({ dataRoot }); apps.push(noProvider);
  assert.equal((await noProvider.execute('creation.flow', { key: createKey, value })).flow.run.id, created.flow.run.id,
    'same Key returns the original intent without current Provider resolution');
  const progressed = await app.execute('flow.continue', { run_id: created.flow.run.id });
  await app.execute('flow.select', { run_id: created.flow.run.id, artifact_id: progressed.run.output.artifactId });
  const advanced = readFlowRun(dataRoot, created.flow.run.id), advancedTree = tree(dataRoot), events = readFlowEvents(dataRoot);
  const replayAdvanced = await noProvider.execute('creation.flow', { key: createKey, value });
  assert.equal(replayAdvanced.flow.status, 'selected'); assert.deepEqual(replayAdvanced.flow.run, advanced);
  assert.deepEqual(tree(dataRoot), advancedTree); assert.deepEqual(readFlowEvents(dataRoot), events);
  assert.equal((await writer(root => planCoreDeletion(root, { artifact_ids: [first.artifact.id] }))).allowed, false);

  // A completed, unused upload can be explicitly quarantined; replay never resurrects it.
  const disposableKey = key(), disposable = await app.execute('creation.image', { ...uploadInput, key: disposableKey });
  const deleted = await writer(root => quarantineCoreFiles(root, planCoreDeletion(root, { artifact_ids: [disposable.artifact.id] })));
  const afterDeletion = tree(dataRoot);
  await assert.rejects(app.execute('creation.image', { ...uploadInput, key: disposableKey }), { code: 'IRIS_CREATION_RESULT_UNAVAILABLE' });
  assert.deepEqual(tree(dataRoot), afterDeletion);
  await writer(root => restoreCoreTransaction(root, deleted.transactionId));
  assert.equal((await app.execute('creation.image', { ...uploadInput, key: disposableKey })).artifact.id, disposable.artifact.id);

  // A prepared request protects an uncommitted object even before the manifest exists.
  const preparedKey = key(), id = creationRequestId(marker, 'image-import', preparedKey);
  const intent = { artifactId: 'artifact_' + crypto.randomBytes(12).toString('hex'), mediaType: 'image/png',
    size: FLOW_SOURCE.length, sha256: sha(FLOW_SOURCE), metadata: { width: 48, height: 32 }, createdAt: new Date().toISOString() };
  await writer(root => publishCreationRequest(root, { schemaVersion: 0, id, rootId: marker.rootId,
    kind: 'image-import', inputDigest: creationInputDigest('image-import', intent), createdAt: intent.createdAt, intent, state: 'prepared' }));
  const object = path.join(dataRoot, 'artifact-store/v0/objects', intent.artifactId + '.png');
  fs.writeFileSync(object, FLOW_SOURCE, { mode: 0o600 }); const old = new Date(Date.now() - 7200000); fs.utimesSync(object, old, old);
  assert(!(await writer(root => planCoreCleanup(root))).candidates.some(item => item.path.endsWith(intent.artifactId + '.png')));
  const recovered = await app.execute('creation.image', { ...uploadInput, key: preparedKey });
  assert(recovered.idempotentReplay); assert.equal(recovered.artifact.id, intent.artifactId);

  const afterIntentKey = key(), afterIntentAbort = new AbortController();
  await assert.rejects(app.execute('creation.image', { ...uploadInput, key: afterIntentKey }, {
    signal: afterIntentAbort.signal, onPrepared: () => afterIntentAbort.abort()
  }), { name: 'AbortError' });
  const held = listCreationRequests(dataRoot).find(record => record.id === creationRequestId(marker, 'image-import', afterIntentKey));
  assert.equal(held.state, 'prepared'); assert.equal(inspectCoreWriterLease(dataRoot).status, 'absent');
  assert.equal((await app.execute('creation.image', { ...uploadInput, key: afterIntentKey })).artifact.id, held.intent.artifactId);

  const independentRoot = path.join(root, 'independent'), independent = createApplicationRuntime({ dataRoot: independentRoot }); apps.push(independent);
  await independent.execute('flow.init', {}); const otherMarker = (await independent.execute('creation.init', {})).root;
  const separate = await independent.execute('creation.image', uploadInput);
  assert.notEqual(otherMarker.rootId, marker.rootId); assert.notEqual(separate.artifact.id, first.artifact.id);
  assert.equal(separate.idempotentReplay, false, 'the same Key is isolated by physical data root');

  // Queued cancellation publishes nothing; a later request is unaffected.
  let entered, release;
  const gate = new Promise(resolve => { release = resolve; }), reached = new Promise(resolve => { entered = resolve; });
  const queuedApp = createApplicationRuntime({ dataRoot, resolveImageCandidates: async request => {
    entered(); await gate; return fixture.resolveImageCandidates(request);
  } }); apps.push(queuedApp);
  const blocked = queuedApp.execute('creation.flow', { key: key(), value }); await reached;
  const canceledKey = key(), controller = new AbortController();
  const canceled = queuedApp.execute('creation.image', { ...uploadInput, key: canceledKey }, { signal: controller.signal });
  controller.abort(); await assert.rejects(canceled, { name: 'AbortError' }); release(); await blocked;
  assert(!listCreationRequests(dataRoot).some(record => record.id === creationRequestId(marker, 'image-import', canceledKey)));
  assert.equal(inspectCoreWriterLease(dataRoot).status, 'absent');

  // Used/partial roots are never silently converted; readers keep their prior behavior.
  const usedRoot = path.join(root, 'used'), used = createApplicationRuntime({ dataRoot: usedRoot }); apps.push(used);
  await used.execute('flow.init', {}); await used.execute('artifact.import', { image_bytes: FLOW_SOURCE });
  const usedBefore = tree(usedRoot);
  await assert.rejects(used.execute('creation.init', {}), { code: 'IRIS_CREATION_ROOT_NOT_EMPTY' }); assert.deepEqual(tree(usedRoot), usedBefore);
  const rootFile = path.join(dataRoot, 'creation-requests/v0/root.json'), savedMarker = fs.readFileSync(rootFile);
  fs.writeFileSync(rootFile, JSON.stringify({ ...marker, schemaVersion: 999 }));
  await assert.rejects(app.execute('artifact.import', { image_bytes: FLOW_SOURCE }), { code: 'IRIS_CREATION_STORE_INVALID' });
  assert.equal(inspectCoreWriterLease(dataRoot).status, 'absent');
  assert.equal((await app.execute('flow.inspect', { run_id: created.flow.run.id })).status, 'selected');
  fs.writeFileSync(rootFile, savedMarker);
  const requestFile = path.join(dataRoot, 'creation-requests/v0/requests', id + '.json'), savedRequest = fs.readFileSync(requestFile);
  fs.writeFileSync(requestFile, 'BROKEN_PRIVATE_REQUEST');
  await assert.rejects(app.execute('artifact.import', { image_bytes: FLOW_SOURCE }), { code: 'IRIS_CREATION_STORE_INVALID' });
  assert.throws(() => planCoreCleanup(dataRoot), { code: 'IRIS_CREATION_STORE_INVALID' });
  fs.writeFileSync(requestFile, savedRequest);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(rootFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(requestFile)).mode & 0o777, 0o700);
  }
  // A rejected store plus failed lease release must not look like a healthy application.
  const failedRoot = path.join(root, 'failed-start-release'), guarded = createApplicationRuntime({ dataRoot: failedRoot });
  await guarded.execute('flow.init', {}); await guarded.execute('creation.init', {});
  fs.writeFileSync(path.join(failedRoot, 'creation-requests/v0/root.json'), 'BROKEN_FIXTURE');
  const rename = fs.renameSync;
  const leaseDirectory = path.join(fs.realpathSync.native(failedRoot), WRITER_LEASE_DIR);
  let failedReleases = 0;
  fs.renameSync = function (source, target) {
    if (source === leaseDirectory) {
      failedReleases++;
      throw Object.assign(new Error('fixture lease release denied'), { code: 'EACCES' });
    }
    return rename.call(this, source, target);
  };
  try {
    const failed = guarded.execute('artifact.import', { image_bytes: FLOW_SOURCE });
    const queued = guarded.execute('artifact.import', { image_bytes: FLOW_SOURCE });
    await Promise.all([assert.rejects(failed, { code: 'IRIS_CORE_LEASE_INVALID' }),
      assert.rejects(queued, { code: 'IRIS_APP_CLOSED' })]);
    assert.equal(guarded.snapshot().state, 'closing'); assert(guarded.snapshot().cleanupFailed);
    const disposal = guarded.dispose(); assert.equal(guarded.dispose(), disposal);
    await assert.rejects(disposal, { code: 'IRIS_CORE_LEASE_INVALID' });
    assert.equal(failedReleases, 1, 'failed cleanup is retained, not retried silently');
    assert.equal(inspectCoreWriterLease(failedRoot).status, 'present');
    assert.equal(listCoreArtifacts(failedRoot).total, 0);
  } finally {
    fs.renameSync = rename;
    await guarded.dispose().catch(() => {}); // Dedicated fixture cleanup owns the retained test evidence.
  }
  console.log('local creation: durable identities, config-independent replay, advanced Flow preservation, explicit deletion, prepared references, cancellation and writer compatibility OK');
} finally { for (const instance of apps) await instance.dispose(); }
