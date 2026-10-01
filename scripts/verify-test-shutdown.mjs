import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runTestProcess } from './test-process.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
// These tests have previously completed their assertions but hung on native
// shutdown. Repeat in fresh processes so a single green run cannot hide it.
const tests = [
  'image-routing.mjs', 'image-task-v2.mjs',
  'provider-discovery-merge.mjs', 'video-s2v-routing.mjs'
];
console.log(`Shutdown regression: Node ${process.versions.node}`);
for (let round = 1; round <= 5; round++) {
  for (const name of tests) {
    console.log(`\n▶ shutdown ${round}/5: ${name}`);
    const result = await runTestProcess(path.join(root, 'tests', name), {
      cwd: root, timeoutMs: 20000
    });
    if (result.error || result.signal || result.status !== 0) {
      console.error(`Shutdown regression failed: ${name}`, result.error?.message || result.signal || result.status);
      process.exit(result.status || 1);
    }
  }
}
console.log('Shutdown regression: all 20 processes exited naturally');
