import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { WRITER_INTENT_FILE } from '../../lib/core-writer-lease.js';
import { inspectCoreWriterLease } from '../../lib/core-runtime.js';
import { readAllOperations } from '../../lib/operation-store.js';

// A real independent writer acquires the lease between durable acceptance and dispatch.
// Only this test process pauses at that handoff; product errors/responses are not mocked.
export async function createRootBusyFixture(dataRoot) {
  const root = fs.realpathSync(dataRoot);
  const directory = fs.mkdtempSync(path.join(path.dirname(root), 'root-holder-'));
  const child = spawn(process.execPath, [fileURLToPath(new URL('./root-busy-writer-child.mjs', import.meta.url)), root, directory],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', closed = false, unarm = () => {};
  child.stdout.on('data', value => { output += value; });
  child.stderr.on('data', value => { output += value; });
  const exit = new Promise(resolve => child.once('close', (code, signal) => { closed = true; resolve({ code, signal }); }));
  async function waitFor(check) {
    const deadline = performance.now() + 10000;
    while (!check()) {
      if (closed || performance.now() >= deadline) throw new Error('root-busy child checkpoint: ' + output);
      await delay(10);
    }
  }
  async function release() {
    unarm();
    if (!closed) fs.writeFileSync(path.join(directory, 'release'), '', { mode: 0o600 });
    try { await waitFor(() => closed); }
    catch (error) { child.kill('SIGKILL'); await exit; throw error; }
    assert.deepEqual(await exit, { code: 0, signal: null }, output);
  }
  try { await waitFor(() => fs.existsSync(path.join(directory, 'prepared'))); }
  catch (error) { await release(); throw error; }
  return {
    pid: child.pid,
    arm() {
      const unlink = fs.unlinkSync;
      unarm = () => { fs.unlinkSync = unlink; };
      fs.unlinkSync = (file, ...args) => {
        const value = unlink(file, ...args);
        if (path.resolve(String(file)) === path.join(root, WRITER_INTENT_FILE)
            && readAllOperations(root).some(record => record.state === 'queued')) {
          unarm();
          fs.writeFileSync(path.join(directory, 'acquire'), '', { mode: 0o600 });
          const deadline = performance.now() + 10000, sleeper = new Int32Array(new SharedArrayBuffer(4));
          while (!fs.existsSync(path.join(directory, 'held.json'))) {
            if (performance.now() >= deadline) throw new Error('independent root writer did not acquire');
            Atomics.wait(sleeper, 0, 0, 10);
          }
          const held = JSON.parse(fs.readFileSync(path.join(directory, 'held.json'), 'utf8'));
          assert.equal(held.error, undefined, held.error);
          assert.equal(inspectCoreWriterLease(root).pid, child.pid);
        }
        return value;
      };
    },
    release
  };
}
