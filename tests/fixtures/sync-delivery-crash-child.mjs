import fs from 'node:fs';
import path from 'node:path';
import { createCoreRuntime } from '../../lib/core-runtime.js';
import { createProviderTaskRunner } from '../../lib/provider-task-runner.js';
import { defineProviderAdapter } from '../../lib/provider-adapter.js';
import { providerErrorRecord } from '../../lib/provider-contract.js';
import { FAKE_PNG } from './fake-lifecycle-provider.mjs';

const runtime = createCoreRuntime({ dataRoot: process.argv[2], mode: 'writer' });
runtime.start();
const rename = fs.renameSync;
fs.renameSync = (source, target) => {
  if (String(target).includes(path.join('task-store/v0/tasks'))
      && JSON.parse(fs.readFileSync(source, 'utf8')).deliveryState === 'pending') {
    fs.writeSync(1, 'CHECKPOINT completion-after-cache\n');
    process.kill(process.pid, 'SIGKILL');
  }
  return rename(source, target);
};
const adapter = defineProviderAdapter({ id: 'crash-sync', protocol: 'fixture', capabilities: ['image'],
  operations: {
    async submit() { return { kind: 'completed', artifacts: [{ kind: 'inline-base64', data: FAKE_PNG.toString('base64') }] }; },
    mapError: providerErrorRecord
  }, unsupported: { discover: 'fixture', poll: 'sync', cancel: 'fixture', download: 'cached inline bytes' }
});
await createProviderTaskRunner(runtime).submit({ capability: 'image', candidates: [{ adapter, model: 'crash-sync::image' }] });
throw new Error('fixture failed to reach interruption checkpoint');
