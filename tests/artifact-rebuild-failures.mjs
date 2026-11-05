import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createCoreArtifact, inspectCoreArtifact, listCoreArtifacts, rebuildCoreArtifactIndex, refreshCoreArtifactInventory } from '../lib/core-artifacts.js';
import { FAKE_PNG } from './fixtures/fake-lifecycle-provider.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-index-recovery-failures');
const rename = fs.renameSync;
for (const operation of ['rebuild', 'refresh']) {
  const dataRoot = path.join(root, operation), store = path.join(dataRoot, 'artifact-store/v0');
  createCoreArtifact(dataRoot, { bytes: FAKE_PNG, mediaType: 'image/png', kind: 'fixture' });
  const indexFile = path.join(store, 'index.json'), oldIndex = fs.readFileSync(indexFile);
  let recoveredId;
  if (operation === 'rebuild') {
    recoveredId = 'artifact_' + 'b'.repeat(24);
    fs.writeFileSync(path.join(store, 'objects', recoveredId + '.png'), FAKE_PNG);
  } else {
    recoveredId = createCoreArtifact(dataRoot, { bytes: FAKE_PNG, mediaType: 'image/png', kind: 'fixture' }).id;
    fs.writeFileSync(indexFile, oldIndex); // isolated crash fixture: a committed record with the old derived index.
  }
  const refresh = operation === 'rebuild' ? rebuildCoreArtifactIndex : refreshCoreArtifactInventory;
  fs.renameSync = (from, to) => {
    if (to === indexFile) throw Object.assign(new Error('isolated index full'), { code: 'ENOSPC' });
    return rename(from, to);
  };
  try { assert.throws(() => refresh(dataRoot), { code: 'ENOSPC' }); }
  finally { fs.renameSync = rename; }
  assert.equal(inspectCoreArtifact(dataRoot, recoveredId).id, recoveredId);
  assert.deepEqual(fs.readFileSync(indexFile), oldIndex);
  assert(fs.existsSync(path.join(store, 'index.dirty')));
  assert.throws(() => listCoreArtifacts(dataRoot), { code: 'IRIS_ARTIFACT_INDEX_INVALID' });
  assert.equal(refresh(dataRoot).total, 2);
  assert.equal(listCoreArtifacts(dataRoot).total, 2);
  assert.equal(fs.existsSync(path.join(store, 'index.dirty')), false);
}
console.log('PASS rebuild/refresh ENOSPC: durable records stay readable, stale index rejected, explicit successful retry clears dirty state');
