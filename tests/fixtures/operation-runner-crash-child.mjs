import fs from 'node:fs';
import path from 'node:path';
import { createOperationRunner } from '../../lib/operation-runner.js';
import { createApplicationRuntime } from '../../lib/application-runtime.js';
import { imageFlowFixture } from './image-flow-fixture.mjs';

const [dataRoot, checkpoint, runId, requestKey, readyFile] = process.argv.slice(2);
let paused = false;
function pause() {
  if (paused) return;
  paused = true; fs.writeFileSync(readyFile, JSON.stringify({ pid: process.pid, checkpoint }) + '\n', { flag: 'wx', mode: 0o600 });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
const atomicLink = fs.linkSync.bind(fs), atomicRename = fs.renameSync.bind(fs);
function afterPublish(target) {
  const name = String(target);
  if (checkpoint === 'runner-intent' && name.endsWith('runner/.iris-runtime-writer-v0.owner.json')) pause();
  if (checkpoint === 'runner-release' && name.includes('runner/.iris-runtime-writer-v0.released-')) pause();
  if (!name.endsWith('.json') || !fs.existsSync(name)) return;
  const value = JSON.parse(fs.readFileSync(name, 'utf8'));
  if (name.includes('/operations/')) {
    if (checkpoint === 'accepted' && value.state === 'queued' || checkpoint === 'started' && value.state === 'running'
        || checkpoint === 'finished' && value.state === 'succeeded') pause();
  }
  if (name.includes('/task-store/v0/tasks/')) {
    if (checkpoint === 'attempt' && value.attempts?.length && value.acceptance === 'not_attempted') pause();
    if (checkpoint === 'remote-accepted' && value.acceptance === 'accepted' && value.remoteTaskId) pause();
    if (checkpoint === 'delivered' && value.deliveryState === 'ready') pause();
  }
}
fs.linkSync = (...args) => { const result = atomicLink(...args); afterPublish(args[1]); return result; };
fs.renameSync = (...args) => { const result = atomicRename(...args); afterPublish(args[1]); return result; };
const fixture = imageFlowFixture(dataRoot, { mode: checkpoint === 'remote-accepted' ? 'async' : 'sync',
  afterSend: checkpoint === 'sent' ? () => pause() : undefined });
const runner = createOperationRunner({ dataRoot, ...fixture });
await runner.start();
if (checkpoint === 'runner-release') { await runner.dispose(); throw new Error('checkpoint missed'); }
const app = createApplicationRuntime({ dataRoot });
const flow = await app.execute('flow.inspect', { run_id: runId }); await app.dispose();
await runner.submit({ key: requestKey, runId, expectedRunRevision: flow.run.revision });
await runner.idle(); await runner.dispose();
throw new Error('checkpoint missed: ' + checkpoint + ' in ' + path.basename(dataRoot));
