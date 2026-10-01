import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { testProcessArgs } from './test-process.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const testFile = path.join(root, 'tests', 'core-artifact-manifest.mjs');

async function probe(trace) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, testProcessArgs(testFile), {
      cwd: root, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, IRIS_TEST_TRACE_RESOURCES: trace ? '1' : '', IRIS_IMPORT_WORKBENCH_CONFIG: '' }
    });
    let output = '';
    let timedOut = false;
    let spawnError;
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', chunk => { output += chunk; process.stdout.write(chunk); });
    }
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 10000);
    child.once('error', error => { spawnError = error.message; });
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ trace, status, signal, timedOut, spawnError,
        assertionsPassed: output.includes('ALL OK'),
        fixtureCleanupComplete: output.includes('fixture cleanup complete') });
    });
  });
}

console.log(`Test hook isolation: Node ${process.versions.node}, ${process.platform}`);
const plain = await probe(false);
const traced = await probe(true);
console.log(JSON.stringify({ plain, traced }, null, 2));
// Only the actual default test mode is an acceptance gate. The traced mode is
// an explicitly labelled diagnostic comparison; its timeout is never a pass.
if (plain.status !== 0 || plain.signal || plain.timedOut || !plain.assertionsPassed
    || !plain.fixtureCleanupComplete || traced.spawnError) process.exitCode = 1;
