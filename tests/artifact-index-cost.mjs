import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createCoreArtifact, inspectCoreArtifact, inspectCoreArtifactStore, listCoreArtifacts,
  rebuildCoreArtifactIndex } from '../lib/core-artifacts.js';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-index-cost'), store = path.join(root, 'artifact-store/v0');
const make = bytes => createCoreArtifact(root, { bytes, mediaType: 'image/png', kind: 'fixture' });
const original = Array.from({ length: 12 }, (_, i) => make(Buffer.alloc(256 * 1024, i)));
const open = fs.openSync, read = fs.readSync, close = fs.closeSync, rename = fs.renameSync;
const descriptors = new Map(), reads = new Map();
fs.openSync = (file, ...args) => {
  const fd = open(file, ...args);
  if (String(file).startsWith(path.join(store, 'objects') + path.sep)) descriptors.set(fd, path.basename(file));
  return fd;
};
fs.readSync = (fd, ...args) => {
  const count = read(fd, ...args), name = descriptors.get(fd);
  if (name) reads.set(name, (reads.get(name) || 0) + count);
  return count;
};
fs.closeSync = fd => { descriptors.delete(fd); return close(fd); };
try {
  const latest = make(Buffer.alloc(2 * 1024 * 1024, 17));
  assert.equal(original.reduce((sum, artifact) => sum + (reads.get(artifact.id + '.png') || 0), 0), 0,
    'a new commit must not rehash historical media');
  assert.equal(reads.get(latest.id + '.png'), latest.size, 'hash the new object once');
  assert.equal(listCoreArtifacts(root).total, 13);
  console.log(JSON.stringify({ historicalObjects: original.length, historicalBytesReadOnCommit: 0, newObjectBytesRead: latest.size }));

  // Publishing the derived index fails after the authoritative record commits.
  let interrupt = true;
  fs.renameSync = (source, target) => {
    if (interrupt && target === path.join(store, 'index.json')) {
      interrupt = false; throw Object.assign(new Error('fixture index ENOSPC'), { code: 'ENOSPC' });
    }
    return rename(source, target);
  };
  const committed = make(Buffer.from('committed despite failed index'));
  assert.equal(inspectCoreArtifact(root, committed.id).id, committed.id);
  assert.throws(() => listCoreArtifacts(root), { code: 'IRIS_ARTIFACT_INDEX_INVALID' });
  assert.equal(inspectCoreArtifactStore(root).index, 'invalid');
  fs.renameSync = rename;
  assert.equal(rebuildCoreArtifactIndex(root).total, 14);
  assert.equal(listCoreArtifacts(root).total, 14);

  // A malformed historical record must not cause an automatic truncated index.
  const file = path.join(store, 'records', original[0].id + '.json'), saved = fs.readFileSync(file);
  const indexBefore = fs.readFileSync(path.join(store, 'index.json'));
  fs.writeFileSync(file, '{broken');
  const preserved = make(Buffer.from('new healthy object next to a bad record'));
  assert.equal(inspectCoreArtifact(root, preserved.id).id, preserved.id);
  assert.deepEqual(fs.readFileSync(path.join(store, 'index.json')), indexBefore);
  assert.throws(() => listCoreArtifacts(root), { code: 'IRIS_ARTIFACT_INDEX_INVALID' });
  fs.writeFileSync(file, saved);
  assert.equal(rebuildCoreArtifactIndex(root).total, 15);

  // Same-size corruption is still detected by reads and an explicit full rebuild.
  const object = path.join(store, 'objects', original[1].id + '.png'), bytes = fs.readFileSync(object);
  fs.writeFileSync(object, Buffer.alloc(bytes.length, 99));
  assert.throws(() => inspectCoreArtifact(root, original[1].id), { code: 'IRIS_ARTIFACT_DIGEST_MISMATCH' });
  assert.equal(rebuildCoreArtifactIndex(root).invalid, 1);
  fs.writeFileSync(object, bytes);
  rebuildCoreArtifactIndex(root);

  const child = spawnSync(process.execPath, ['tests/fixtures/artifact-index-crash-child.mjs', root],
    { encoding: 'utf8', timeout: 20000 });
  assert(child.stdout.includes('CHECKPOINT record-before-index'), child.stderr);
  if (process.platform === 'win32') assert.equal(child.status, 1);
  else assert.equal(child.signal, 'SIGKILL');
  assert.throws(() => listCoreArtifacts(root), { code: 'IRIS_ARTIFACT_INDEX_INVALID' });
  assert.equal(inspectCoreArtifactStore(root).index, 'invalid');
  assert.equal(rebuildCoreArtifactIndex(root).total, 16);
  assert.equal(listCoreArtifacts(root).total, 16);
  console.log('PASS artifact commit cost, failed/partial index, bad records, digest checks and real process interruption');
} finally { fs.openSync = open; fs.readSync = read; fs.closeSync = close; fs.renameSync = rename; }
