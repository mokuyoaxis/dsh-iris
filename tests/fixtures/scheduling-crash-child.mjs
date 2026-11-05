import fs from 'node:fs';
import { createApplicationRuntime } from '../../lib/application-runtime.js';
import { createOperationRunner } from '../../lib/operation-runner.js';
import { createFakeLifecycleProvider } from './fake-lifecycle-provider.mjs';

const [dataRoot, ready, events, serialized] = process.argv.slice(2), flows = JSON.parse(serialized);
let sent = 0;
function submit(request, context) {
  fs.appendFileSync(events, JSON.stringify({ model: request.model, taskId: context.taskId, attemptId: context.attempt.id }) + '\n');
  if (++sent === 2) {
    fs.writeFileSync(ready, String(process.pid), { mode: 0o600, flag: 'wx' });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
  return new Promise(() => {});
}
const fake = createFakeLifecycleProvider({ id: 'p', submitSteps: [submit, submit] });
const ports = { resolveImageCandidates: ({ modelRef }) => [{ adapter: fake.adapter, model: modelRef, providerBinding: 'sha256:' + 'a'.repeat(64) }], resolveTaskAdapter: () => fake.adapter };
const app = createApplicationRuntime({ dataRoot, ...ports, scheduling: { schemaVersion: 1, requestsPerSecond: 100, remoteLimit: 4 } });
const runner = createOperationRunner({ dataRoot, application: app, ...ports });
await runner.start();
for (const flow of flows) await runner.submit(flow);
await runner.idle();
throw new Error('two concurrent crash checkpoint was missed');
