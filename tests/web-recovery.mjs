import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRecoveryJournal, RECOVERY_STORAGE_KEY, MAX_RECOVERY_ACTIONS } from '../lib/web/recovery.js';
import { createMediaClient } from '../lib/web/media-client.js';
import { createReadClient } from '../lib/web/transport.js';

const origin = 'http://127.0.0.1:3080', rootId = crypto.randomUUID();
const runId = 'run_' + 'a'.repeat(24), artifactId = 'artifact_' + 'b'.repeat(24), operationId = 'op_' + 'c'.repeat(64);
const storage = () => {
  const values = new Map();
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
};
const action = () => { const id = crypto.randomUUID(); return { id, kind: 'image-import', key: id }; };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

// Reload, root binding, strict privacy, bounded storage and explicit treatment of corruption.
const disk = storage(), journal = createRecoveryJournal({ origin, rootId, getStorage: () => disk });
assert.equal(disk.values.size, 0, 'construction does not write an empty table');
const first = action(); journal.add(first);
const reloaded = createRecoveryJournal({ origin, rootId, getStorage: () => disk });
assert.deepEqual(reloaded.snapshot().actions, [first]);
const detached = reloaded.snapshot(); detached.actions[0].kind = 'stop';
assert.deepEqual(reloaded.snapshot().actions, [first], 'returned snapshots cannot mutate pending identities');
for (const privateField of ['prompt', 'token', 'apiKey', 'file', 'providerConfig']) {
  assert.throws(() => journal.add({ ...action(), [privateField]: 'PRIVATE' }), TypeError);
}
for (let index = 1; index < MAX_RECOVERY_ACTIONS; index++) journal.add(action());
const full = disk.getItem(RECOVERY_STORAGE_KEY);
assert.throws(() => journal.add(action()), { code: 'IRIS_WEB_RECOVERY_FULL' });
assert.equal(disk.getItem(RECOVERY_STORAGE_KEY), full, 'overflow preserves every original unknown action');
journal.close(); assert.throws(() => journal.remove(first.id), { name: 'AbortError' });
disk.setItem('unrelated', 'retain');
const changed = createRecoveryJournal({ origin, rootId: crypto.randomUUID(), getStorage: () => disk });
assert.equal(changed.snapshot().notice, 'root_changed'); assert.deepEqual(changed.snapshot().actions, []);
assert.equal(disk.getItem('unrelated'), 'retain'); assert.equal(disk.getItem(RECOVERY_STORAGE_KEY), null);
for (const raw of ['{broken', JSON.stringify({ schemaVersion: 1 }), JSON.stringify({ schemaVersion: 0, origin, rootId,
  actions: [{ ...first, prompt: 'PRIVATE' }] }), 'x'.repeat(16385)]) {
  disk.setItem(RECOVERY_STORAGE_KEY, raw);
  const broken = createRecoveryJournal({ origin, rootId, getStorage: () => disk });
  assert.equal(broken.snapshot().blocked, true); assert.equal(broken.snapshot().notice, 'corrupt');
  assert.equal(disk.getItem(RECOVERY_STORAGE_KEY), raw);
  assert.throws(() => broken.add(action()), { code: 'IRIS_WEB_RECOVERY_CORRUPT' });
  broken.clear(); assert.equal(disk.getItem(RECOVERY_STORAGE_KEY), null); assert.equal(broken.snapshot().blocked, false);
}
const denied = createRecoveryJournal({ origin, rootId, getStorage: () => { throw new DOMException('denied', 'SecurityError'); } });
denied.add(first); assert.equal(denied.snapshot().mode, 'memory'); assert.equal(denied.snapshot().notice, 'storage_unavailable');
assert.deepEqual(denied.snapshot().actions, [first]);
const quota = storage(); quota.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); };
const limited = createRecoveryJournal({ origin, rootId, getStorage: () => quota }); limited.add(first);
assert.equal(limited.snapshot().mode, 'memory'); assert.deepEqual(limited.snapshot().actions, [first]);
const unbound = createRecoveryJournal({ origin, rootId: null, getStorage: () => disk }); unbound.add(first);
assert.equal(unbound.snapshot().mode, 'memory'); assert.equal(disk.getItem(RECOVERY_STORAGE_KEY), null);
disk.setItem(RECOVERY_STORAGE_KEY, JSON.stringify({ schemaVersion: 0, origin, rootId, actions: [first] }));
const otherOrigin = createRecoveryJournal({ origin: 'http://127.0.0.1:3180', rootId, getStorage: () => disk });
assert.equal(otherOrigin.snapshot().notice, 'root_changed'); assert.equal(disk.getItem(RECOVERY_STORAGE_KEY), null);

// Unknown responses, read-only recovery, explicit same-Key replay and stale response isolation.
const writes = [], reads = [], gate = deferred(), memory = storage();
let failUpload = true, lookupState = 'prepared';
const http = {
  async uploadImage(image, options) { writes.push({ image, ...options }); await gate.promise; if (failUpload) throw new TypeError('lost response');
    return { contractVersion: 0, artifact: { artifactId } }; },
  async lookupCreation(kind, key) { reads.push({ kind, key }); return { contractVersion: 0, kind, state: lookupState,
    result: lookupState === 'prepared' ? null : { artifactId } }; }
};
const session = { contractVersion: 0, rootId, operations: ['images.create', 'creation.lookup'] };
const media = createMediaClient({ client: http, session, origin, getStorage: () => memory });
assert.equal(writes.length, 0); assert.deepEqual(await media.recover(), []); assert.equal(writes.length, 0);
const image = new Blob(['fixture'], { type: 'image/png' }), upload = media.uploadImage(image);
assert.equal(media.uploadImage(image), upload, 'a repeated active click shares the exact request promise');
assert.throws(() => media.uploadImage(new Blob(['other'], { type: 'image/png' })), { code: 'IRIS_WEB_BUSY' });
gate.resolve(); await assert.rejects(upload, /lost response/);
const original = media.snapshot().actions[0]; assert.equal(writes.length, 1); assert.equal(original.key, writes[0].key);
assert.throws(() => media.uploadImage(image), { code: 'IRIS_WEB_RECOVERY_REQUIRED' });
const recovered = await media.recover(); assert.equal(recovered[0].status, 'prepared'); assert.equal(writes.length, 1);
assert.equal(reads[0].key, original.key); assert.deepEqual(media.snapshot().actions, [original]);
failUpload = false; await media.retry(original.id, image); assert.equal(writes.length, 2); assert.equal(writes[1].key, original.key);
assert.deepEqual(media.snapshot().actions, []); assert.equal(memory.getItem(RECOVERY_STORAGE_KEY), null);
media.close();
for (const status of [401, 404, 409, 503]) {
  const saved = storage(); const before = createRecoveryJournal({ origin, rootId, getStorage: () => saved }); before.add(first);
  const client = createMediaClient({ client: { lookupCreation: async () => { throw Object.assign(new Error('fixture'), { status }); } },
    session, origin, getStorage: () => saved });
  const result = await client.recover(); assert.equal(result[0].status, status === 404 ? 'not_found' : status === 409 ? 'conflict' : 'unavailable');
  assert.deepEqual(client.snapshot().actions, [first]); client.close();
}
const capDisk = storage(); createRecoveryJournal({ origin, rootId, getStorage: () => capDisk }).add(first);
const capClient = createMediaClient({ client: {}, session: { ...session, operations: [] }, origin, getStorage: () => capDisk });
assert.equal((await capClient.recover())[0].status, 'capability_unavailable'); assert.deepEqual(capClient.snapshot().actions, [first]); capClient.close();
const staleGate = deferred(), staleDisk = storage();
const stale = createMediaClient({ client: { uploadImage: () => staleGate.promise }, session, origin, getStorage: () => staleDisk });
const late = stale.uploadImage(image); await tick(); stale.close();
const next = createRecoveryJournal({ origin, rootId: crypto.randomUUID(), getStorage: () => staleDisk });
assert.equal(next.snapshot().notice, 'root_changed');
staleGate.resolve({ contractVersion: 0, artifact: { artifactId } }); await assert.rejects(late, { name: 'AbortError' });
assert.equal(staleDisk.getItem(RECOVERY_STORAGE_KEY), null, 'an old response cannot repopulate the new root journal');

// Real transport scheduling: two active reads, JSON before queued media, writes bypass reads.
const nativeFetch = globalThis.fetch, pending = [], started = [];
try {
  globalThis.fetch = async (pathname, options) => {
    const wait = deferred(); started.push({ pathname, options }); pending.push(wait);
    await wait.promise;
    return new Response(options.method === 'POST' ? '{"contractVersion":0}' : '{}', { headers: { 'Content-Type': 'application/json' } });
  };
  const client = createReadClient('x'.repeat(43));
  const a = client.get('/api/v0/one', { binary: true }), b = client.get('/api/v0/two', { binary: true });
  const c = client.get('/api/v0/three', { binary: true }), d = client.getOperation(operationId);
  assert.equal(started.length, 2);
  const stop = client.stopOperation(operationId); assert.equal(started.length, 3); assert.equal(started[2].options.method, 'POST');
  pending[2].resolve(); await stop;
  pending[0].resolve(); await a; await tick(); assert(started[3].pathname.endsWith(operationId), 'lightweight status precedes queued image');
  assert.equal(started.length, 4); pending[1].resolve(); await b; await tick();
  assert.equal(started[4].pathname, '/api/v0/three'); pending[3].resolve(); pending[4].resolve(); await Promise.all([c, d]);
  assert.equal(typeof client.post, 'undefined'); assert.equal(typeof client.execute, 'undefined');
  assert.throws(() => client.stopOperation('../outside'), TypeError);
  assert.throws(() => client.lookupCreation('other', crypto.randomUUID()), TypeError);
  assert.throws(() => client.createRun({}, { key: 'bad' }), TypeError);
  assert.throws(() => client.postManagement('/api/v0/runs', {}), TypeError);
  for (const item of started) { assert.equal(item.options.credentials, 'omit'); assert.equal(item.options.redirect, 'error');
    assert.equal(item.options.cache, 'no-store'); assert(!item.pathname.includes('x'.repeat(43))); }
  client.close(); await assert.rejects(client.stopOperation(operationId), { name: 'AbortError' });
  // Queued cancellation is delivered without dispatching the queued request.
  const abortClient = createReadClient('x'.repeat(43));
  const inFlight = [abortClient.get('/api/v0/a'), abortClient.get('/api/v0/b')];
  const queued = abortClient.get('/api/v0/c'); const rejected = assert.rejects(queued, { name: 'AbortError' });
  const count = started.length; abortClient.close(); await rejected;
  for (const wait of pending) wait.resolve(); await Promise.all(inFlight);
  assert.equal(started.length, count);
} finally { globalThis.fetch = nativeFetch; }
console.log('PASS Web recovery: bounded private tab storage, corruption/capacity/denial, root/origin binding, coalesced clicks, original-Key retry, stale isolation, capability/error retention and independent stop/priority reads');
