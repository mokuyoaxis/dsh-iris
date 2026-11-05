import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createCoreRuntime } from '../lib/core-runtime.js';
import { createCoreArtifact, inspectCoreArtifact, listCoreArtifactMetadata } from '../lib/core-artifacts.js';
import { createDshRuntime } from '../lib/dsh-core-adapter.js';
import { workbenchArtifacts } from '../lib/workbench-artifacts.js';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-legacy-core-catalog'), dataRoot = path.join(root, 'core');
const writer = createCoreRuntime({ dataRoot, mode: 'writer' }); writer.start();
const bytes = Buffer.from('early Core bytes'), digest = crypto.createHash('sha256').update(bytes).digest('hex');
const current = await writer.run('execute', () => createCoreArtifact(dataRoot, { bytes, kind: 'generated-image', mediaType: 'image/png' }));
await writer.dispose();
const store = path.join(dataRoot, 'artifact-store/v0'), id = 'artifact_' + '1'.repeat(24), createdAt = '2026-09-12T00:00:00.000Z';
fs.writeFileSync(path.join(store, 'objects', id + '.png'), bytes);
fs.writeFileSync(path.join(store, 'records', id + '.json'), JSON.stringify({ schemaVersion: 0, id, kind: 'early-image',
  mediaType: 'image/png', object: id + '.png', size: bytes.length, createdAt, metadata: {} }));
const indexPath = path.join(store, 'index.json'), index = JSON.parse(fs.readFileSync(indexPath));
index.artifacts.push({ id, createdAt, size: bytes.length, mediaType: 'image/png', digest });
index.count = index.artifacts.length; index.inventoryDigest = crypto.createHash('sha256').update(JSON.stringify(index.artifacts)).digest('hex');
fs.writeFileSync(indexPath, JSON.stringify(index));
const recordPath = path.join(store, 'records', id + '.json'), original = fs.readFileSync(recordPath), indexBefore = fs.readFileSync(indexPath);
assert.equal(inspectCoreArtifact(dataRoot, id).digest.value, digest, 'the early record remains readable by ID');
const open = fs.openSync;
fs.openSync = function(file, ...args) {
  if (String(file).includes(path.join('v0', 'objects') + path.sep)) throw new Error('catalog must not hash media');
  return open.call(this, file, ...args);
};
const core = createDshRuntime({ dataRoot });
try {
  const metadata = listCoreArtifactMetadata(dataRoot);
  assert.equal(metadata.dropped, 0, 'readable early records are not corruption');
  assert.equal(metadata.legacySkipped, 1); assert.equal(metadata.artifacts.length, 1);
  const page = await workbenchArtifacts({ source: 'core' }, { core });
  assert.equal(page.droppedCore, 0); assert.equal(page.legacyCoreSkipped, 1); assert.equal(page.items[0].id, current.id);
  const snapshot = await core.coreSnapshotForDsh({ limit: 6 });
  assert.equal(snapshot.artifacts.total, 1); assert.equal(snapshot.artifacts.recent[0].id, current.id);
  assert.equal(snapshot.artifacts.legacySkipped, 1); assert.equal(snapshot.degraded, false);
  assert.deepEqual(fs.readFileSync(recordPath), original); assert.deepEqual(fs.readFileSync(indexPath), indexBefore);
  assert.equal(fs.existsSync(path.join(store, 'manifests', id + '.json')), false, 'listing never upgrades an early record');
  // An invalid early-shaped record is still corruption, not a compatibility notice.
  fs.writeFileSync(recordPath, JSON.stringify({ schemaVersion: 0, id, object: '../../foreign', metadata: {} }));
  const bad = listCoreArtifactMetadata(dataRoot); assert.equal(bad.dropped, 1); assert.equal(bad.legacySkipped, 0);
  const degraded = await core.coreSnapshotForDsh({ limit: 6 });
  assert.equal(degraded.artifacts.total, 1); assert.equal(degraded.artifacts.dropped, 1); assert.equal(degraded.degraded, true);
  assert.equal(degraded.artifacts.recent[0].id, current.id, 'one bad early record does not empty the snapshot');
  fs.writeFileSync(recordPath, original);
  fs.openSync = function(file, ...args) {
    if (String(file) === path.join(store, 'objects', id + '.png')) throw new Error('a new commit must not hash legacy media');
    return open.call(this, file, ...args);
  };
  const added = createCoreArtifact(dataRoot, { bytes: Buffer.from('new object'), mediaType: 'image/png', kind: 'fixture' });
  const refreshed = listCoreArtifactMetadata(dataRoot);
  assert.equal(refreshed.legacySkipped, 1); assert.equal(refreshed.artifacts.length, 2);
  assert(refreshed.artifacts.some(value => value.id === added.id));
  console.log('PASS early Core compatibility is distinct from corrupt records; ID access survives, catalog reads no media and performs no migration');
} finally { fs.openSync = open; await core.dispose(); }
