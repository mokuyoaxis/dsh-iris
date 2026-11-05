import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createApplicationRuntime } from '../lib/application-runtime.js';
import { readCoreArtifactBytes } from '../lib/core-artifacts.js';
import { createMediaClient } from '../lib/web/media-client.js';
import { RECOVERY_STORAGE_KEY } from '../lib/web/recovery.js';
import { VIDEO_MODEL, VIDEO_MP4, videoFlowFixture } from './fixtures/video-flow-fixture.mjs';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-video-recovery'), apps = [], rename = fs.renameSync;
const dataRoot = path.join(root, 'core'), fixture = videoFlowFixture(), uuid = () => crypto.randomUUID();
try {
  const app = createApplicationRuntime({ dataRoot, ...fixture }); apps.push(app);
  await app.execute('flow.init', {}); await app.execute('execution.init', { video: true });
  const intent = await app.execute('creation.video', { key: uuid(), value: { modelRef: VIDEO_MODEL, prompt: 'Keep the original video' } });
  await app.execute('flow.continue', { run_id: intent.flow.run.id });
  let intercepted = false;
  fs.renameSync = (from, to) => {
    if (String(to).includes(path.sep + path.join('artifact-store', 'v0', 'records') + path.sep) && String(to).endsWith('.json')) {
      intercepted = true; throw Object.assign(new Error('controlled publication failure'), { code: 'EIO' });
    }
    return rename(from, to);
  };
  const failed = await app.execute('flow.continue', { run_id: intent.flow.run.id }); fs.renameSync = rename;
  assert.equal(intercepted, true); assert.equal(failed.status, 'delivery_failed'); assert.equal(failed.task.outcome, 'succeeded');
  await app.dispose();
  const reopened = createApplicationRuntime({ dataRoot }); apps.push(reopened);
  const restored = await reopened.execute('flow.continue', { run_id: failed.run.id });
  assert.equal(restored.status, 'ready'); assert.equal(restored.task.id, failed.task.id); assert.equal(restored.task.attempts.length, 1);
  assert.deepEqual(readCoreArtifactBytes(dataRoot, restored.run.output.artifactId).bytes, VIDEO_MP4);
  assert.equal(fixture.calls.submit.length, 1); assert.equal(fixture.calls.poll.length, 1);
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const session = { contractVersion: 0, rootId: uuid(), operations: ['videos.create', 'creation.lookup'] };
  let key, writes = 0, fail = true;
  const http = {
    async createVideo(value, options) {
      writes++; key ??= options.key; assert.equal(options.key, key); assert.equal(value.duration, 1.5);
      if (fail) throw Error('lost video creation response');
      return { contractVersion: 0, flow: { contractVersion: 0, id: restored.run.id, recipe: 'video-generate/v0', revision: 1, source: null, selection: null } };
    },
    async lookupCreation(kind, requestKey) {
      assert.equal(kind, 'video-create'); assert.equal(requestKey, key);
      return { contractVersion: 0, kind, state: 'prepared', result: { runId: restored.run.id } };
    }
  };
  const origin = 'http://127.0.0.1:3182', first = createMediaClient({ client: http, session, origin, getStorage: () => storage });
  const input = { modelRef: VIDEO_MODEL, prompt: 'PRIVATE_VIDEO_PROMPT', duration: 1.5 };
  await assert.rejects(first.createVideo(input), /lost video creation response/);
  assert(!storage.getItem(RECOVERY_STORAGE_KEY).includes('PRIVATE_VIDEO_PROMPT')); first.close();
  const second = createMediaClient({ client: http, session, origin, getStorage: () => storage });
  assert.equal((await second.recover())[0].status, 'prepared'); assert.equal(writes, 1);
  assert.throws(() => second.createVideo(input), { code: 'IRIS_WEB_RECOVERY_REQUIRED' });
  for (const duration of ['2', NaN, Infinity, 0, 61]) assert.throws(() => second.retry(key, { ...input, duration }));
  fail = false; await second.retry(key, input); assert.equal(writes, 2); assert.equal(second.snapshot().actions.length, 0);
  assert.equal(storage.getItem(RECOVERY_STORAGE_KEY), null); second.close();
  console.log('video recovery: cached original result repairs after restart without provider; private Web identity journal and explicit same-Key replay OK');
} finally { fs.renameSync = rename; for (const app of apps.reverse()) await app.dispose(); }
