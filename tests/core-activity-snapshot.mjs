import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createCoreRuntime } from '../lib/core-runtime.js';
import { createDshRuntime } from '../lib/dsh-core-adapter.js';
import { createCoreTask, beginCoreAttempt, recordCoreAttemptResult, finalizeCoreNoAcceptance,
  activateCoreWatch, recoverCoreTask, requestCoreCancel, recordCoreCancelResult } from '../lib/core-tasks.js';
import { applyCoreAttentionAction } from '../lib/core-attention.js';
import { useTempDshHome } from './test-env.js';

const { root } = useTempDshHome('iris-core-activity'), dataRoot = path.join(root, 'core');
const core = createDshRuntime({ dataRoot });
assert.deepEqual((await core.coreSnapshotForDsh()).activity, { running: 0, paused: 0, attention: 0, truncated: false, recent: [] });
const writer = createCoreRuntime({ dataRoot, mode: 'writer' }); writer.start();
let running, paused, failed, hidden, acknowledged, canceled;
await writer.run('execute', () => {
  const create = () => createCoreTask(dataRoot, { capability: 'image' }).id;
  const accepted = id => {
    const attempt = beginCoreAttempt(dataRoot, id, { providerId: 'fixture', model: 'fixture::image' });
    recordCoreAttemptResult(dataRoot, id, { ...attempt, acceptance: 'accepted', resultKind: 'accepted', remoteTaskId: 'private-remote-' + id });
  };
  const failure = id => {
    const attempt = beginCoreAttempt(dataRoot, id, { providerId: 'fixture', model: 'fixture::image' });
    recordCoreAttemptResult(dataRoot, id, { ...attempt, acceptance: 'not_accepted', resultKind: 'not_accepted' });
    finalizeCoreNoAcceptance(dataRoot, id, 'synthetic rejection');
  };
  running = create(); paused = create(); accepted(paused); activateCoreWatch(dataRoot, paused); recoverCoreTask(dataRoot, paused);
  failed = create(); failure(failed); hidden = create(); acknowledged = create(); failure(acknowledged);
  canceled = create(); accepted(canceled); requestCoreCancel(dataRoot, canceled); recordCoreCancelResult(dataRoot, canceled, { kind: 'canceled' });
});
await writer.dispose();
applyCoreAttentionAction(hidden, 'hide'); applyCoreAttentionAction(acknowledged, 'acknowledge');
const directory = path.join(dataRoot, 'task-store/v0/tasks');
const bytes = () => fs.readdirSync(directory).sort().map(name => fs.readFileSync(path.join(directory, name), 'utf8')).join('\n');
const before = bytes(), fetch = globalThis.fetch;
globalThis.fetch = () => { throw Error('a progress read must not call a provider'); };
try {
  const snapshot = await core.coreSnapshotForDsh({ limit: 1 });
  assert.equal(snapshot.userTasks.length, 1);
  assert.deepEqual({ ...snapshot.activity, recent: [] }, { running: 1, paused: 1, attention: 1, truncated: false, recent: [] });
  assert.deepEqual(new Set(snapshot.activity.recent.map(row => row.id)), new Set([running, paused]));
  assert(!JSON.stringify(snapshot.activity).includes('private-remote-')); assert(!JSON.stringify(snapshot.activity).includes(root));
  assert.equal(bytes(), before, 'activity is derived without changing task facts');
  applyCoreAttentionAction(running, 'hide'); applyCoreAttentionAction(failed, 'acknowledge');
  const next = await core.coreSnapshotForDsh({ limit: 1 });
  assert.equal(next.activity.running, 0); assert.equal(next.activity.paused, 1); assert.equal(next.activity.attention, 0);
  assert.equal(bytes(), before);
  console.log('PASS Core activity is independent of recent-page size and legacy tasks, respects hidden/acknowledged/canceled facts, and reads without writes/network');
} finally { globalThis.fetch = fetch; await core.dispose(); }
