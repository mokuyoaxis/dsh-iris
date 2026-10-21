import fs from 'node:fs';
import path from 'node:path';
import { createApplicationRuntime } from '../../lib/application-runtime.js';
import { readFlowRun } from '../../lib/flow-store.js';
import { imageFlowFixture } from './image-flow-fixture.mjs';

const [stage, suppliedRoot, runId] = process.argv.slice(2);
const root = fs.realpathSync.native(suppliedRoot);
const run = readFlowRun(root, runId);
const runFile = path.join(root, 'flow-store/v0/runs', run.id + '.json');
const taskFile = path.join(root, 'task-store/v0/tasks', run.edit.taskId + '.json');
function crash(hit) {
  if (!hit) return;
  fs.writeSync(1, 'CHECKPOINT ' + stage + '\n');
  process.kill(process.pid, 'SIGKILL');
}
for (const method of ['linkSync', 'renameSync']) {
  const original = fs[method];
  fs[method] = (...args) => {
    const result = original(...args), destination = String(args[1]);
    let task, saved;
    if (destination === taskFile) task = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
    if (destination === runFile) saved = JSON.parse(fs.readFileSync(runFile, 'utf8'));
    const object = path.dirname(destination) === path.join(root, 'artifact-store/v0/objects');
    const manifest = path.dirname(destination) === path.join(root, 'artifact-store/v0/manifests');
    const record = path.dirname(destination) === path.join(root, 'artifact-store/v0/records');
    const comparison = destination.includes(run.compare.artifactId);
    crash((stage === 'task-created' && method === 'linkSync' && destination === taskFile)
      || (stage === 'intent-claimed' && saved?.edit.claimed && !saved.output)
      || (stage === 'attempt-written' && task?.phase === 'submitting' && task.attempts.length === 1)
      || (stage === 'async-accepted' && task?.phase === 'accepted')
      || (['result-cached', 'async-cache'].includes(stage) && destination === path.join(root, 'delivery-cache/v0', run.edit.taskId, 'result.json'))
      || (stage === 'artifact-object' && object && !comparison)
      || (stage === 'artifact-manifest' && manifest && !comparison)
      || (stage === 'task-delivered' && task?.deliveryState === 'ready')
      || (stage === 'run-output' && saved?.output && !saved.comparison)
      || (stage === 'compare-object' && object && comparison)
      || (stage === 'compare-committed' && record && comparison)
      || (stage === 'run-comparison' && saved?.comparison));
    return result;
  };
}
const fixture = imageFlowFixture(root, { mode: stage.startsWith('async-') ? 'async' : 'sync',
  afterSend: () => crash(stage === 'request-sent') });
const app = createApplicationRuntime({ dataRoot: root, ...fixture });
await app.execute('flow.continue', { run_id: runId });
if (stage.startsWith('async-')) await app.execute('flow.continue', { run_id: runId });
await app.dispose();
throw new Error('Flow crash checkpoint was not reached: ' + stage);
