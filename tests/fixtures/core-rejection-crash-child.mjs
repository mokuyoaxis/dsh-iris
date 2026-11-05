import fs from 'node:fs';
import path from 'node:path';
import { createCoreRuntime } from '../../lib/core-runtime.js';
import { createProviderTaskRunner } from '../../lib/provider-task-runner.js';
import { createFakeLifecycleProvider } from './fake-lifecycle-provider.mjs';

const dataRoot = process.argv[2], eventsFile = process.argv[3];
const runtime = createCoreRuntime({ dataRoot, mode: 'writer' });
runtime.start();
const rename = fs.renameSync;
fs.renameSync = (source, target) => {
  if (path.dirname(String(target)) === path.join(dataRoot, 'task-store/v0/tasks')) {
    const next = JSON.parse(fs.readFileSync(source, 'utf8'));
    if (next.acceptance === 'not_accepted' && next.outcome === 'failed') {
      fs.writeSync(1, 'CHECKPOINT rejected-before-finalize\n');
      process.kill(process.pid, 'SIGKILL');
    }
  }
  return rename(source, target);
};
const rejection = { kind: 'not_accepted', error: { safeMessage: 'fixture authorization rejected',
  category: 'authentication', stage: 'submit', acceptance: 'not_accepted', httpStatus: 401 } };
const fake = createFakeLifecycleProvider({ id: 'rejection-fixture', submitSteps: [() => {
  fs.appendFileSync(eventsFile, 'submit\n');
  return rejection;
}] });
await createProviderTaskRunner(runtime).submit({ capability: 'image',
  candidates: [{ adapter: fake.adapter, model: 'rejection-fixture::image-v0' }],
  providerInput: { prompt: 'isolated rejection fixture' } });
throw new Error('fixture did not reach rejection persistence checkpoint');
